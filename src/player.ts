import { decodeChunk, GlyphcastError, readHeader, type Header } from './format.js';
import { autoLevels, ease, NEUTRAL, type Levels } from './levels.js';
import { GlyphRenderer, type FrameStyle, type RendererOptions } from './renderer.js';

export interface PlaybackOptions extends RendererOptions {
  /** Adjust brightness and contrast to each scene. Default true. */
  readonly autoLevels?: boolean;
  /** Saturation multiplier. Default 1.3. */
  readonly boost?: number;
  /** Paint every glyph in one color, CSS hex. */
  readonly tint?: string | null;
}

export interface VideoOptions extends PlaybackOptions {
  /** Grid width in glyphs. Default 160. */
  readonly cols?: number;
  /** Upper limit for redraws per second. Default 60. */
  readonly fps?: number;
  /** The video is already at grid size, one pixel per glyph (see `encodeMicroVideo`). Default false. */
  readonly prescaled?: boolean;
}

type FrameCallbackVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number; cancelVideoFrameCallback?: (handle: number) => void };

abstract class Playback {
  protected readonly renderer: GlyphRenderer;
  protected levels: Levels = NEUTRAL;
  protected style: PlaybackOptions;

  constructor(canvas: HTMLCanvasElement, options: PlaybackOptions) {
    this.renderer = new GlyphRenderer(canvas, options);
    this.style = options;
  }

  /** Changes `autoLevels`, `boost` or `tint` on the fly. */
  configure(options: Pick<PlaybackOptions, 'autoLevels' | 'boost' | 'tint'>): void {
    this.style = { ...this.style, ...options };
  }

  protected paint(pixels: Uint8ClampedArray, cols: number, rows: number): void {
    this.levels = this.style.autoLevels === false ? NEUTRAL : ease(this.levels, autoLevels(pixels));
    const style: FrameStyle = { levels: this.levels, boost: this.style.boost ?? 1.3, tint: this.style.tint ?? null };
    this.renderer.draw(pixels, cols, rows, style);
  }
}

/**
 * Plays any `<video>` as glyphs: the video keeps its sound, controls and seeking, the canvas shows its frames
 * redrawn as colored characters. Cross-origin videos need CORS (`crossorigin="anonymous"`), otherwise the browser
 * does not let the page read their pixels.
 */
export class GlyphVideo extends Playback {
  private readonly sampler: OffscreenCanvasRenderingContext2D;
  private cols: number;
  private handle: number | null = null;
  private last = 0;

  constructor(readonly video: HTMLVideoElement, canvas: HTMLCanvasElement, private options: VideoOptions = {}) {
    super(canvas, options);
    this.cols = options.cols ?? 160;
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Cannot create a 2D context for sampling');
    this.sampler = context;
  }

  /** Grid size for the current video, keeping its aspect ratio with glyph proportions. */
  grid(): { readonly cols: number; readonly rows: number } {
    if (this.options.prescaled && this.video.videoWidth > 0) return { cols: this.video.videoWidth, rows: this.video.videoHeight };
    const aspect = this.video.videoWidth > 0 ? this.video.videoHeight / this.video.videoWidth : 9 / 16;
    return { cols: this.cols, rows: Math.max(1, Math.round(this.cols * aspect * (this.renderer.cellWidth / this.renderer.cellHeight))) };
  }

  /** Sets the grid width in glyphs. */
  resize(cols: number): void {
    this.cols = Math.max(8, Math.round(cols));
    this.options = { ...this.options, cols: this.cols };
    this.render();
  }

  /** Draws the current video frame once. */
  render(): void {
    if (this.video.readyState < 2) return;
    const { cols, rows } = this.grid();
    const canvas = this.sampler.canvas;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    this.sampler.drawImage(this.video, 0, 0, cols, rows);
    let pixels: Uint8ClampedArray;
    try {
      pixels = this.sampler.getImageData(0, 0, cols, rows).data;
    } catch {
      throw new GlyphcastError('The video is cross-origin without CORS, so its pixels cannot be read; serve it with CORS and set crossorigin="anonymous"');
    }
    this.paint(pixels, cols, rows);
  }

  /** Starts redrawing on every new video frame. */
  start(): void {
    if (this.handle !== null) return;
    const video = this.video as FrameCallbackVideo;
    const minGap = 1000 / (this.options.fps ?? 60);
    const tick = (): void => {
      const now = performance.now();
      if (now - this.last >= minGap - 1) {
        this.last = now;
        this.render();
      }
      this.handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    this.handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }

  /** Stops redrawing. */
  stop(): void {
    if (this.handle === null) return;
    const video = this.video as FrameCallbackVideo;
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
    this.handle = null;
  }
}

export interface StreamOptions extends PlaybackOptions {
  /** Audio to play along; its clock drives the frames. */
  readonly audio?: HTMLMediaElement | null;
  /** Called while the stream downloads, with the share of bytes received. */
  readonly onProgress?: (loaded: number) => void;
}

/**
 * Plays a `.gcast` stream: the server sends compact glyph frames instead of video, the browser draws them.
 * Playback starts as soon as the first chunk arrives and follows the audio clock when audio is given.
 */
export class GlyphStream extends Playback {
  header: Header | null = null;
  private bytes = new Uint8Array(0);
  private received = 0;
  private readonly decoded = new Map<number, Promise<Uint8ClampedArray[]>>();
  private frame: Uint8ClampedArray | null = null;
  private shown = -1;
  private handle: number | null = null;
  private clockStart = 0;
  private clockOffset = 0;
  private playing = false;

  constructor(canvas: HTMLCanvasElement, private readonly options: StreamOptions = {}) {
    super(canvas, options);
  }

  /** Duration in seconds, known once the header has arrived. */
  get duration(): number {
    return this.header ? this.header.frameCount / this.header.fps : 0;
  }

  /** Current position in seconds. */
  get currentTime(): number {
    const audio = this.options.audio;
    if (audio) return audio.currentTime;
    return this.playing ? this.clockOffset + (performance.now() - this.clockStart) / 1000 : this.clockOffset;
  }

  get paused(): boolean {
    return !this.playing;
  }

  /** Downloads a stream progressively; resolves when the whole file is in. */
  async load(source: string | URL | Uint8Array | ArrayBuffer): Promise<Header> {
    if (typeof source === 'string' || source instanceof URL) {
      const response = await fetch(source);
      if (!response.ok || !response.body) throw new GlyphcastError(`Cannot load ${String(source)}: HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.append(value);
        if (total > 0) this.options.onProgress?.(this.received / total);
      }
    } else {
      this.append(source instanceof Uint8Array ? source : new Uint8Array(source));
    }
    if (!this.header) throw new GlyphcastError('The stream ended before its header');
    this.options.onProgress?.(1);
    this.render();
    return this.header;
  }

  private append(chunk: Uint8Array): void {
    if (this.received + chunk.length > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.received + chunk.length, 1 << 16));
      grown.set(this.bytes.subarray(0, this.received));
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.received);
    this.received += chunk.length;
    if (!this.header) {
      try {
        this.header = readHeader(this.bytes.subarray(0, this.received));
      } catch (error) {
        if (!(error instanceof GlyphcastError) || !/Not enough bytes/.test(error.message)) throw error;
      }
    }
  }

  private chunk(index: number): Promise<Uint8ClampedArray[]> | null {
    const header = this.header;
    const entry = header?.chunks[index];
    if (!header || !entry || entry.offset + entry.size > this.received) return null;
    let pending = this.decoded.get(index);
    if (!pending) {
      pending = decodeChunk(header, this.bytes.slice(entry.offset, entry.offset + entry.size));
      this.decoded.set(index, pending);
      for (const key of this.decoded.keys()) if (Math.abs(key - index) > 2) this.decoded.delete(key);
    }
    return pending;
  }

  /** Draws the frame for the current time. */
  render(): void {
    const header = this.header;
    if (!header) return;
    const index = Math.min(header.frameCount - 1, Math.max(0, Math.floor(this.currentTime * header.fps)));
    const chunkIndex = Math.floor(index / header.chunkFrames);
    this.chunk(chunkIndex + 1);
    const pending = this.chunk(chunkIndex);
    if (index === this.shown || !pending) {
      if (this.frame) this.paint(this.frame, header.cols, header.rows);
      return;
    }
    void pending.then((frames) => {
      const frame = frames[index - chunkIndex * header.chunkFrames];
      if (!frame) return;
      this.frame = frame;
      this.shown = index;
      this.paint(frame, header.cols, header.rows);
    });
  }

  async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    this.clockStart = performance.now();
    if (this.options.audio) await this.options.audio.play();
    const tick = (): void => {
      this.render();
      if (!this.options.audio && this.currentTime >= this.duration) this.pause();
      if (this.playing) this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.clockOffset = this.currentTime;
    this.playing = false;
    this.options.audio?.pause();
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
  }

  /** Jumps to a time in seconds. */
  seek(seconds: number): void {
    const time = Math.min(Math.max(seconds, 0), this.duration);
    if (this.options.audio) this.options.audio.currentTime = time;
    this.clockOffset = time;
    this.clockStart = performance.now();
    this.render();
  }
}
