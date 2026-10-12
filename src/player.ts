import { decodeChunk, GlyphcastError, StreamReader, type Chunk, type StreamInfo } from './format.js';
import { autoLevels, ease, NEUTRAL, type Levels } from './levels.js';
import { captionAt, parseCaptions, type Cue } from './captions.js';
import { DEFAULT_GLYPHS, GlyphRenderer, type RenderMode } from './renderer.js';

export interface LookOptions {
  /** Grid width in glyphs for video sources; `.gcast` streams carry their own grid. Default 160. */
  readonly cols?: number;
  /** Glyphs from dark to bright. Default `' .:-=+*#%@'`. */
  readonly glyphs?: string;
  /** Saturation multiplier: 0 is grayscale. Default 1.3. */
  readonly boost?: number;
  /** One color for every glyph, CSS hex, or null for the frame colors. */
  readonly tint?: string | null;
  /** Adjust brightness and contrast to each scene. Default true. */
  readonly autoLevels?: boolean;
  /** Background color, CSS hex. Default `#05070a`. */
  readonly background?: string;
  /** `glyphs`, `braille` (2×4 dots per cell) or `halftone` (a dot sized by brightness). Default `glyphs`. */
  readonly mode?: RenderMode;
  /** Contours drawn with `- / | \` along their direction. Default false. */
  readonly edges?: boolean;
  /** Tube screen look: scanlines, vignette, glow. Default false. */
  readonly crt?: boolean;
}

export interface PlayerOptions extends LookOptions {
  /** Glyph height in device pixels. Default 16. */
  readonly glyphSize?: number;
  /** CSS font stack for glyphs. */
  readonly font?: string;
}

/** Where frames come from. */
export type Source =
  | {
      readonly type: 'video';
      /** URL, file or camera stream. */
      readonly src: string | Blob | MediaStream;
      /** The video is already at grid size, one pixel per glyph. */
      readonly prescaled?: boolean;
    }
  | {
      readonly type: 'gcast';
      /** URL of a `.gcast` file or a live server stream. */
      readonly src: string;
      /** Audio that plays along and drives the clock. */
      readonly audio?: string;
      /** Known duration in seconds for live streams whose header does not carry a frame count. */
      readonly duration?: number;
      /** Builds URLs that start at a given second, for server streams that cannot be seeked by downloading ahead. */
      readonly restart?: (seconds: number) => { readonly src: string; readonly audio?: string };
    };

/** Picks the source type from a URL: `.gcast` files are streams, everything else is video. */
export const sourceFor = (src: string, audio?: string): Source =>
  /\.gcast(?:$|[?#])/i.test(src) ? { type: 'gcast', src, ...(audio ? { audio } : {}) } : { type: 'video', src };

const AHEAD = 20;

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

interface StreamState {
  readonly source: Extract<Source, { type: 'gcast' }>;
  readonly reader: StreamReader;
  readonly chunks: Chunk[];
  readonly decoded: Map<number, Promise<Uint8ClampedArray[]>>;
  readonly abort: AbortController;
  /** Second at which this download starts (non-zero after a server restart). */
  readonly offset: number;
  done: boolean;
  clockStart: number;
  clockAt: number;
}

/**
 * A glyph player without UI: give it a canvas and a source, call `play()`. It plays videos, cameras and `.gcast`
 * streams with the same API as a media element (`play`, `pause`, `currentTime`, `duration`, `volume`, `muted`,
 * `playbackRate`) and the same events (`play`, `pause`, `timeupdate`, `durationchange`, `progress`, `ended`,
 * `waiting`, `playing`, `error`, `loadedmetadata`).
 */
export class GlyphPlayer extends EventTarget {
  readonly renderer: GlyphRenderer;
  /** The media element that holds video and audio. Hidden; the canvas shows the picture. */
  readonly media: HTMLVideoElement;
  private look: Required<Omit<LookOptions, 'tint'>> & { tint: string | null };
  private source: Source | null = null;
  private stream: StreamState | null = null;
  private levels: Levels = NEUTRAL;
  private readonly sampler: OffscreenCanvasRenderingContext2D;
  private loop: number | null = null;
  private shownFrame = -1;
  private lastFrame: { pixels: Uint8ClampedArray; cols: number; rows: number } | null = null;
  private rate = 1;
  private ended = false;
  private mediaClock = false;
  private stalled = false;
  private cues: readonly Cue[] = [];
  private caption: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement, options: PlayerOptions = {}) {
    super();
    this.look = {
      cols: options.cols ?? 160,
      glyphs: options.glyphs ?? DEFAULT_GLYPHS,
      boost: options.boost ?? 1.3,
      tint: options.tint ?? null,
      autoLevels: options.autoLevels ?? true,
      background: options.background ?? '#05070a',
      mode: options.mode ?? 'glyphs',
      edges: options.edges ?? false,
      crt: options.crt ?? false,
    };
    this.renderer = new GlyphRenderer(canvas, { glyphs: this.look.glyphs, background: this.look.background, ...(options.glyphSize ? { glyphSize: options.glyphSize } : {}), ...(options.font ? { font: options.font } : {}) });
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (!context) throw new GlyphcastError('Cannot create a 2D context for sampling');
    this.sampler = context;
    this.media = document.createElement('video');
    this.media.playsInline = true;
    this.media.preload = 'auto';
    for (const type of ['play', 'pause', 'volumechange', 'ratechange', 'waiting', 'playing', 'loadedmetadata', 'durationchange', 'progress']) {
      this.media.addEventListener(type, () => {
        if (this.stream && ['durationchange', 'loadedmetadata', 'progress'].includes(type)) return;
        this.emit(type);
      });
    }
    this.media.addEventListener('ended', () => {
      if (!this.stream) this.finish();
    });
    this.media.addEventListener('seeked', () => this.draw());
    this.media.addEventListener('loadeddata', () => this.draw());
    this.media.addEventListener('error', () => this.fail(new GlyphcastError(this.media.error?.message || 'The media cannot be played')));
  }

  private emit(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private fail(error: Error): void {
    this.emit('error', error);
  }

  /** Type of the loaded source, or null. */
  get sourceType(): Source['type'] | null {
    return this.source?.type ?? null;
  }

  /** Current look. */
  get options(): Readonly<LookOptions> {
    return this.look;
  }

  /** Changes the look on the fly: grid width, glyphs, colors, levels. */
  configure(options: LookOptions): void {
    const glyphs = options.glyphs !== undefined && options.glyphs !== this.look.glyphs;
    const background = options.background !== undefined && options.background !== this.look.background;
    this.look = { ...this.look, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
    if (glyphs) this.renderer.setGlyphs(this.look.glyphs);
    if (background) this.renderer.setBackground(this.look.background);
    this.shownFrame = -1;
    this.redraw();
  }

  /**
   * Shows subtitles drawn with glyphs over the picture: WebVTT or SRT text, a URL to fetch it from, or null to
   * hide them. Cues follow `currentTime`, so they stay in sync after seeks and server restarts.
   */
  async setCaptions(captions: string | URL | null): Promise<void> {
    if (captions === null) this.cues = [];
    else if (captions instanceof URL || !captions.includes('-->')) {
      const response = await fetch(captions);
      if (!response.ok) throw new GlyphcastError(`Cannot load subtitles: HTTP ${response.status}`);
      this.cues = parseCaptions(await response.text());
    } else this.cues = parseCaptions(captions);
    this.caption = null;
    this.renderer.setCaption(null);
    this.redraw();
  }

  private redraw(): void {
    if (this.lastFrame && this.stream) this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows);
    else this.draw();
  }

  /** Grid of the current source. */
  grid(): { readonly cols: number; readonly rows: number } {
    if (this.stream?.reader.info) return { cols: this.stream.reader.info.cols, rows: this.stream.reader.info.rows };
    const video = this.media;
    if (this.source?.type === 'video' && this.source.prescaled && video.videoWidth > 0) return { cols: video.videoWidth, rows: video.videoHeight };
    const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
    return { cols: this.look.cols, rows: Math.max(1, Math.round(this.look.cols * aspect * (this.renderer.cellWidth / this.renderer.cellHeight))) };
  }

  /** Loads a source and shows its first frame. Resolves once metadata is known. */
  async load(source: Source | string): Promise<void> {
    const next = typeof source === 'string' ? sourceFor(source) : source;
    this.unload();
    this.source = next;
    this.ended = false;
    if (next.type === 'video') {
      this.mediaClock = true;
      const video = this.media;
      if (next.src instanceof MediaStream) video.srcObject = next.src;
      else video.src = typeof next.src === 'string' ? next.src : URL.createObjectURL(next.src);
      if (typeof next.src === 'string' && !next.src.startsWith('blob:') && !next.src.startsWith('data:')) video.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new GlyphcastError(video.error?.message || 'The video cannot be loaded')), { once: true });
      });
      this.draw();
      return;
    }
    await this.openStream(next, 0);
  }

  private async openStream(source: Extract<Source, { type: 'gcast' }>, offset: number): Promise<void> {
    const urls = offset > 0 && source.restart ? source.restart(offset) : { src: source.src, ...(source.audio ? { audio: source.audio } : {}) };
    const state: StreamState = { source, reader: new StreamReader(), chunks: [], decoded: new Map(), abort: new AbortController(), offset, done: false, clockStart: 0, clockAt: 0 };
    this.stream = state;
    this.stalled = false;
    this.shownFrame = -1;
    this.mediaClock = Boolean(urls.audio);
    if (urls.audio) {
      this.media.src = urls.audio;
      this.media.crossOrigin = 'anonymous';
    } else {
      this.media.removeAttribute('src');
    }
    const response = await fetch(urls.src, { signal: state.abort.signal, priority: 'low' } as RequestInit);
    if (!response.ok || !response.body) throw new GlyphcastError(`Cannot load ${urls.src}: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const first = new Promise<void>((resolve, reject) => {
      const pump = async (): Promise<void> => {
        for (;;) {
          while (!state.abort.signal.aborted && this.stream === state && this.bufferedEnd - this.currentTime > AHEAD) await new Promise((wait) => setTimeout(wait, 250));
          const { done, value } = await reader.read();
          if (done) break;
          const chunks = state.reader.push(value);
          state.chunks.push(...chunks);
          if (state.reader.info && (chunks.length > 0 || state.chunks.length > 0)) resolve();
          if (chunks.length > 0) this.emit('progress');
        }
        state.done = true;
        if (!state.reader.info) throw new GlyphcastError('The stream ended before its header');
        resolve();
        this.emit('progress');
        this.emit('durationchange');
      };
      pump().catch((error: unknown) => {
        if (state.abort.signal.aborted) return;
        reject(error);
        this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
      });
    });
    await first;
    this.emit('loadedmetadata');
    this.emit('durationchange');
    this.draw();
  }

  private unload(): void {
    this.pauseLoop();
    this.stalled = false;
    this.mediaClock = false;
    if (this.stream) this.stream.abort.abort();
    this.stream = null;
    this.lastFrame = null;
    this.shownFrame = -1;
    const video = this.media;
    video.pause();
    if (video.srcObject instanceof MediaStream) for (const track of video.srcObject.getTracks()) track.stop();
    video.srcObject = null;
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.removeAttribute('crossorigin');
    video.load();
  }

  /** Stops playback and releases the source. */
  destroy(): void {
    this.unload();
    this.source = null;
  }

  /** True when the media element carries the clock: video sources and streams with audio. */
  get hasAudio(): boolean {
    return this.mediaClock;
  }

  get paused(): boolean {
    if (this.stream && !this.hasAudio) return this.loop === null;
    return this.media.paused && !this.stalled;
  }

  get duration(): number {
    const stream = this.stream;
    if (stream) {
      const info = stream.reader.info;
      if (stream.source.duration) return stream.source.duration;
      if (info?.frameCount) return info.frameCount / info.fps;
      const frames = stream.chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
      return info ? stream.offset + frames / info.fps : 0;
    }
    return this.media.duration || 0;
  }

  /** End of the downloaded part, in seconds. */
  get bufferedEnd(): number {
    const stream = this.stream;
    if (stream?.reader.info) return stream.offset + stream.chunks.reduce((sum, chunk) => sum + chunk.frames, 0) / stream.reader.info.fps;
    const ranges = this.media.buffered;
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }

  get currentTime(): number {
    const stream = this.stream;
    if (!stream) return this.media.currentTime;
    if (this.hasAudio) return stream.offset + this.media.currentTime;
    return stream.clockAt + (this.loop !== null ? ((performance.now() - stream.clockStart) / 1000) * this.rate : 0);
  }

  set currentTime(seconds: number) {
    void this.seek(seconds);
  }

  get volume(): number {
    return this.media.volume;
  }

  set volume(value: number) {
    this.media.volume = Math.min(1, Math.max(0, value));
  }

  get muted(): boolean {
    return this.media.muted;
  }

  set muted(value: boolean) {
    this.media.muted = value;
  }

  get playbackRate(): number {
    return this.stream && !this.hasAudio ? this.rate : this.media.playbackRate;
  }

  set playbackRate(value: number) {
    if (this.stream && !this.hasAudio) {
      this.syncClock();
      this.rate = value;
      this.emit('ratechange');
    } else {
      this.media.playbackRate = value;
    }
  }

  private syncClock(): void {
    const stream = this.stream;
    if (!stream) return;
    stream.clockAt = this.currentTime;
    stream.clockStart = performance.now();
  }

  async play(): Promise<void> {
    if (!this.source) return;
    if (this.ended) await this.seek(0);
    this.ended = false;
    if (this.hasAudio || !this.stream) await this.media.play();
    else {
      this.syncClock();
      this.emit('play');
      this.emit('playing');
    }
    this.startLoop();
  }

  pause(): void {
    if (this.stream && !this.hasAudio) {
      if (this.loop === null) return;
      this.syncClock();
      this.pauseLoop();
      this.emit('pause');
      return;
    }
    this.stalled = false;
    this.media.pause();
    this.pauseLoop();
    this.draw();
  }

  async seek(seconds: number): Promise<void> {
    const time = Math.max(0, Math.min(seconds, this.duration || seconds));
    const stream = this.stream;
    if (!stream) {
      this.media.currentTime = time;
      return;
    }
    const info = stream.reader.info;
    const loadedTo = this.bufferedEnd;
    if (stream.source.restart && (time < stream.offset || (time > loadedTo + 2 && !stream.done))) {
      const playing = !this.paused;
      this.pauseLoop();
      await this.openStream(stream.source, time);
      if (playing) await this.play();
      return;
    }
    if (this.hasAudio) this.media.currentTime = time - stream.offset;
    stream.clockAt = time;
    stream.clockStart = performance.now();
    this.shownFrame = -1;
    if (info) this.draw();
    this.emit('timeupdate');
  }

  private finish(): void {
    this.ended = true;
    this.pauseLoop();
    this.emit('ended');
    this.emit('pause');
  }

  private startLoop(): void {
    if (this.loop !== null) return;
    let lastUpdate = 0;
    const tick = (): void => {
      this.draw();
      const now = performance.now();
      if (now - lastUpdate > 250) {
        lastUpdate = now;
        this.emit('timeupdate');
      }
      const stream = this.stream;
      if (stream && this.hasAudio) this.buffer(stream);
      if (stream?.done && stream.reader.info && this.currentTime >= this.duration - 0.02) {
        if (this.hasAudio) this.media.pause();
        this.finish();
        return;
      }
      if (this.loop !== null) this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }

  private buffer(stream: StreamState): void {
    const ahead = this.bufferedEnd - this.currentTime;
    if (!this.stalled && !stream.done && ahead < 0.3) {
      this.stalled = true;
      this.media.pause();
      this.emit('waiting');
    } else if (this.stalled && (stream.done || ahead > 2)) {
      this.stalled = false;
      void this.media.play().catch(() => undefined);
      this.emit('playing');
    }
  }

  private pauseLoop(): void {
    if (this.loop !== null) cancelAnimationFrame(this.loop);
    this.loop = null;
  }

  private paint(pixels: Uint8ClampedArray, cols: number, rows: number): void {
    this.lastFrame = { pixels, cols, rows };
    this.levels = this.look.autoLevels ? ease(this.levels, autoLevels(pixels)) : NEUTRAL;
    const caption = captionAt(this.cues, this.currentTime);
    if (caption !== this.caption) {
      this.caption = caption;
      this.renderer.setCaption(caption);
    }
    this.renderer.draw(pixels, cols, rows, { levels: this.levels, boost: this.look.boost, tint: this.look.tint, mode: this.look.mode, edges: this.look.edges, crt: this.look.crt });
  }

  /** Draws the frame for the current time. */
  draw(): void {
    const stream = this.stream;
    if (stream) {
      this.drawStream(stream);
      return;
    }
    const video = this.media as FrameVideo;
    if (!this.source || video.readyState < 2 || video.videoWidth === 0) return;
    const { cols, rows } = this.grid();
    const canvas = this.sampler.canvas;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    this.sampler.drawImage(video, 0, 0, cols, rows);
    let pixels: Uint8ClampedArray;
    try {
      pixels = this.sampler.getImageData(0, 0, cols, rows).data;
    } catch {
      this.pauseLoop();
      this.fail(new GlyphcastError('The video is cross-origin without CORS, so its pixels cannot be read'));
      return;
    }
    this.paint(pixels, cols, rows);
  }

  private drawStream(stream: StreamState): void {
    const info = stream.reader.info;
    if (!info) return;
    const index = Math.max(0, Math.floor((this.currentTime - stream.offset) * info.fps));
    const position = stream.chunks.findIndex((chunk) => index >= chunk.start && index < chunk.start + chunk.frames);
    const chunk = stream.chunks[position];
    if (!chunk) {
      if (this.lastFrame) this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows);
      return;
    }
    const nextChunk = stream.chunks[position + 1];
    if (nextChunk) this.decode(stream, info, nextChunk);
    if (index === this.shownFrame && this.lastFrame) {
      this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows);
      return;
    }
    void this.decode(stream, info, chunk).then((frames) => {
      if (this.stream !== stream) return;
      const frame = frames[index - chunk.start];
      if (!frame) return;
      this.shownFrame = index;
      this.paint(frame, info.cols, info.rows);
    });
  }

  private decode(stream: StreamState, info: StreamInfo, chunk: Chunk): Promise<Uint8ClampedArray[]> {
    let pending = stream.decoded.get(chunk.start);
    if (!pending) {
      pending = decodeChunk(info, chunk.data);
      stream.decoded.set(chunk.start, pending);
      for (const key of stream.decoded.keys()) if (Math.abs(key - chunk.start) > info.chunkFrames * 3) stream.decoded.delete(key);
    }
    return pending;
  }
}
