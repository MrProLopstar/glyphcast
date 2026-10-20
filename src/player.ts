import { audioType, decodeChunkMotion, GlyphcastError, interpolate, type DecodedChunk, indexLength, INDEX_TRAILER, readIndex, type IndexEntry, StreamReader, type Chunk, type StreamInfo } from './format.js';
import { autoLevels, ease, NEUTRAL, type Levels } from './levels.js';
import { captionAt, parseCaptions, type Cue } from './captions.js';
import { DEFAULT_GLYPHS, GlyphRenderer, type RenderMode } from './renderer.js';
import { OggTrack } from './track.js';
import { upscale2x } from './upscale.js';

/** How frames are drawn: grid, mode, glyphs, colors and effects. */
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
  /** `glyphs`, `braille` (2×4 dots per cell) or `halftone` (a dot sized by brightness). Default `braille`. */
  readonly mode?: RenderMode;
  /** Contours drawn with `- / | \` along their direction. Default false. */
  readonly edges?: boolean;
  /** Tube screen look: scanlines, vignette, glow. Default false. */
  readonly crt?: boolean;
  /** Cell background tinted by its color, 0 for pure black. Default 0.25. */
  readonly fill?: number;
  /** Edge-directed 2× upscaling before drawing: sharper contours from the same stream. Default true. */
  readonly sharp?: boolean;
  /** Frames between the stream's frames along block motion, for `.gcast` sources. Default true. */
  readonly smooth?: boolean;
}

/** Everything `GlyphPlayer` takes: the look plus playback options. */
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
      /** Another `.gcast` whose embedded sound plays when this one has none: grid variants share the main file's sound. */
      readonly sound?: string;
      /** Known duration in seconds for live streams whose header does not carry a frame count. */
      readonly duration?: number;
      /** Builds URLs that start at a given second, for server streams that cannot be seeked by downloading ahead. */
      readonly restart?: (seconds: number) => { readonly src: string; readonly audio?: string };
    };

/** Picks the source type from a URL: `.gcast` files are streams, everything else is video. */
export const sourceFor = (src: string, audio?: string): Source =>
  /\.gcast(?:$|[?#])/i.test(src) ? { type: 'gcast', src, ...(audio ? { audio } : {}) } : { type: 'video', src };

const AHEAD = 20;

/** Dark-side colors of version 4 detail frames, keyed by the frame's masks. */
const shadesOf = new WeakMap<Uint8Array, Uint8Array>();

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

interface StreamState {
  readonly source: Extract<Source, { type: 'gcast' }>;
  readonly reader: StreamReader;
  readonly chunks: Chunk[];
  readonly decoded: Map<number, Promise<DecodedChunk>>;
  readonly abort: AbortController;
  /** Second at which this download starts (non-zero after a server restart). */
  readonly offset: number;
  readonly url: string;
  /** Cancels the running download; replaced when seeking jumps past loaded data. */
  segment: AbortController;
  /** Chunk positions from the file's index, for jumping with range requests. */
  index: IndexEntry[] | null;
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
  private lastFrame: { pixels: Uint8ClampedArray; cols: number; rows: number; masks?: Uint8Array | undefined } | null = null;
  private rate = 1;
  private ended = false;
  private mediaClock = false;
  private stalled = false;
  private track: OggTrack | null = null;
  private cues: readonly Cue[] = [];
  private readonly previews = new Map<number, { readonly pixels: Uint8ClampedArray; readonly cols: number; readonly rows: number }>();
  private previous: Uint8ClampedArray | null = null;
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
      mode: options.mode ?? 'braille',
      edges: options.edges ?? false,
      crt: options.crt ?? false,
      fill: options.fill ?? 0.25,
      sharp: options.sharp ?? true,
      smooth: options.smooth ?? true,
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
    // a download cut short on purpose (seeking, switching quality, unloading) is not an error
    if (error.name === 'AbortError') return;
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

  /**
   * Matches glyph size to the displayed height in device pixels, so the canvas maps onto screen pixels instead of
   * being scaled, which makes small glyphs shimmer.
   */
  fit(height: number): void {
    const size = Math.min(48, Math.max(6, Math.floor(height / this.grid().rows)));
    if (size === this.renderer.cellHeight) return;
    this.renderer.setGlyphSize(size);
    this.shownFrame = -1;
    this.redraw();
  }

  private redraw(): void {
    if (this.lastFrame && this.stream) this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
    else this.draw();
  }

  /** Grid of the current source. */
  grid(): { readonly cols: number; readonly rows: number } {
    if (this.stream?.reader.info) return { cols: this.stream.reader.info.cols, rows: this.stream.reader.info.rows };
    const video = this.media;
    if (this.source?.type === 'video' && this.source.prescaled && video.videoWidth > 0) return { cols: video.videoWidth, rows: video.videoHeight };
    const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
    return { cols: this.look.cols, rows: Math.max(1, Math.round(this.look.cols * aspect * 0.6)) };
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
    const state: StreamState = { source, reader: new StreamReader(), chunks: [], decoded: new Map(), abort: new AbortController(), offset, url: urls.src, segment: new AbortController(), index: null, done: false, clockStart: 0, clockAt: 0 };
    state.abort.signal.addEventListener('abort', () => state.segment.abort());
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
    if (!urls.audio && offset === 0 && !source.restart && !urls.src.startsWith('blob:') && (await this.openIndexed(state))) return;
    const response = await fetch(urls.src, { signal: state.segment.signal, priority: 'low' } as RequestInit);
    if (!response.ok || !response.body) throw new GlyphcastError(`Cannot load ${urls.src}: HTTP ${response.status}`);
    await new Promise<void>((resolve, reject) => {
      const sound: Uint8Array[] = [];
      this.download(state, response, state.reader, state.segment, (chunks) => {
        for (const chunk of chunks) {
          if (chunk.subtitles) {
            if (!this.cues.length) void this.setCaptions(new TextDecoder().decode(chunk.data));
          } else if (chunk.frames === 0) sound.push(chunk.data);
        }
        if (sound.length > 0 && state.chunks.length > 0 && !this.mediaClock) {
          this.media.src = URL.createObjectURL(new Blob(sound as BlobPart[], { type: audioType(sound[0] ?? new Uint8Array()) }));
          this.mediaClock = true;
        }
        if (state.reader.info && state.chunks.length > 0) resolve();
      }).then(() => {
        if (!state.reader.info) throw new GlyphcastError('The stream ended before its header');
        resolve();
      }).catch((error: unknown) => {
        if (state.abort.signal.aborted) return;
        reject(error);
        this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
      });
    });
    this.emit('loadedmetadata');
    this.emit('durationchange');
    this.draw();
    if (!state.done && !source.restart && !urls.src.startsWith('blob:')) void this.loadIndex(state);
    // a grid variant without sound: the main file's, once it is clear the stream itself has none
    if (source.sound && !urls.audio) {
      void (async () => {
        while (!state.done && !this.mediaClock && this.stream === state && state.chunks.length < 2) await new Promise((wait) => setTimeout(wait, 100));
        if (!this.mediaClock && this.stream === state) await this.borrowSound(state, source.sound ?? '');
      })();
    }
  }

  /**
   * Starts a file that has an index without reading it from the top: embedded sound sits before the picture, and a
   * film's sound can be tens of megabytes. The picture is fetched from its first chunk right away and plays on its
   * own clock; the sound region comes in the background and takes over the clock once it is complete.
   * Returns false when the file has no index or a small sound region, so the plain download is used.
   */
  private async openIndexed(state: StreamState): Promise<boolean> {
    try {
      const head = await fetch(state.url, { headers: { range: 'bytes=0-65535' }, signal: state.segment.signal });
      if (head.status !== 206) {
        await head.body?.cancel();
        return false;
      }
      const start = new Uint8Array(await head.arrayBuffer());
      await this.loadIndex(state);
      const entries = state.index;
      const first = entries?.[0];
      if (!entries || !first || first.offset < 2 * 1048576) return false;
      // a separate reader for the opening bytes, so a fallback to the plain download starts clean
      const probe = new StreamReader();
      const opening = probe.push(start);
      const info = probe.info;
      if (!info) return false;
      for (const chunk of opening) if (chunk.subtitles && !this.cues.length) void this.setCaptions(new TextDecoder().decode(chunk.data));
      // where the sound starts: after the header and an optional subtitles chunk
      const view = new DataView(start.buffer, start.byteOffset, start.byteLength);
      let soundStart = 20;
      if (start.length >= 26 && view.getUint16(24, true) === 0xfffe) soundStart += 6 + view.getUint32(20, true);
      const response = await fetch(state.url, { headers: { range: `bytes=${first.offset}-` }, signal: state.segment.signal, priority: 'high' } as RequestInit);
      if (response.status !== 206) {
        await response.body?.cancel();
        return false;
      }
      // from here on the stream is committed to this path
      state.reader.info = info;
      const segment = state.segment;
      await new Promise<void>((resolve, reject) => {
        this.download(state, response, new StreamReader(info, first.start), segment, () => state.chunks.length > 0 && resolve())
          .then(() => resolve())
          .catch((error: unknown) => {
            if (state.abort.signal.aborted) return;
            reject(error);
            this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
          });
      });
      this.emit('loadedmetadata');
      this.emit('durationchange');
      this.draw();
      if (first.offset - soundStart > 6) this.attachSound(state, state.url, start, soundStart, first.offset, info);
      else if (state.source.sound) void this.borrowSound(state, state.source.sound);
      return true;
    } catch (error) {
      if (state.abort.signal.aborted || state.reader.info) throw error;
      return false;
    }
  }

  /** Plays the embedded sound of another `.gcast`: finds its sound region from its first bytes and its index. */
  private async borrowSound(state: StreamState, url: string): Promise<void> {
    if (this.track || this.mediaClock) return;
    try {
      const head = await fetch(url, { headers: { range: 'bytes=0-65535' }, signal: state.abort.signal });
      if (head.status !== 206) return;
      const start = new Uint8Array(await head.arrayBuffer());
      const view = new DataView(start.buffer, start.byteOffset, start.byteLength);
      let soundStart = 20;
      if (start.length >= 26 && view.getUint16(24, true) === 0xfffe) soundStart += 6 + view.getUint32(20, true);
      const tail = await fetch(url, { headers: { range: `bytes=-${INDEX_TRAILER}` }, signal: state.abort.signal });
      const length = tail.status === 206 ? indexLength(new Uint8Array(await tail.arrayBuffer())) : null;
      if (!length) return;
      const index = await fetch(url, { headers: { range: `bytes=-${length}` }, signal: state.abort.signal });
      const first = index.status === 206 ? readIndex(new Uint8Array(await index.arrayBuffer()))[0] : undefined;
      const info = state.reader.info;
      if (!first || !info || this.stream !== state || first.offset - soundStart <= 6) return;
      this.attachSound(state, url, start, soundStart, first.offset, info);
    } catch {
      // without sound the picture keeps playing on its own clock
    }
  }

  /** Starts the embedded sound that lies in `url` between `soundStart` and the first picture chunk at `end`. */
  private attachSound(state: StreamState, url: string, start: Uint8Array, soundStart: number, end: number, info: StreamInfo): void {
      const view = new DataView(start.buffer, start.byteOffset, start.byteLength);
      // Ogg sound plays window by window from where the picture is; other sound types load whole as before
      const kind = start.length >= soundStart + 10 && start[soundStart + 6] === 0x4f && start[soundStart + 7] === 0x67 && start[soundStart + 8] === 0x67 && start[soundStart + 9] === 0x53;
      if (kind && typeof AudioContext !== 'undefined') {
        const piece = view.getUint32(soundStart, true);
        const region = end - soundStart;
        const count = Math.ceil(region / (piece + 6));
        const size = region - count * 6;
        // the sound is cut into pieces of `piece` bytes, each behind a 6-byte chunk head: map sound bytes to file bytes
        const at = (position: number): number => soundStart + Math.floor(position / piece) * (piece + 6) + 6 + (position % piece);
        const read = async (from: number, to: number): Promise<Uint8Array> => {
          const last = Math.min(size - 1, to);
          const response = await fetch(url, { headers: { range: `bytes=${at(from)}-${at(last)}` }, signal: state.abort.signal });
          if (response.status !== 206) throw new GlyphcastError(`Sound range: HTTP ${response.status}`);
          const raw = new Uint8Array(await response.arrayBuffer());
          const out = new Uint8Array(last - from + 1);
          for (let done = 0; done < out.length; ) {
            const take = Math.min(out.length - done, piece - ((from + done) % piece));
            const offset = at(from + done) - at(from);
            out.set(raw.subarray(offset, offset + take), done);
            done += take;
          }
          return out;
        };
        this.track = new OggTrack(read, 0, size, this.duration, () => this.currentTime);
        this.track.volume = this.media.volume;
        this.track.muted = this.media.muted;
        if (!this.paused) void this.track.play(this.currentTime, this.rate);
        else this.track.prepare(this.currentTime);
      } else void this.loadSound(state, url, soundStart, end - 1, info);
  }

  /** Downloads the embedded sound region and switches the clock to it at the current time. */
  private async loadSound(state: StreamState, url: string, from: number, to: number, info: StreamInfo): Promise<void> {
    try {
      const response = await fetch(url, { headers: { range: `bytes=${from}-${to}` }, signal: state.abort.signal });
      if (response.status !== 206) return;
      const reader = new StreamReader(info, 0);
      const pieces: Uint8Array[] = [];
      for (const chunk of reader.push(new Uint8Array(await response.arrayBuffer()))) if (chunk.frames === 0 && !chunk.subtitles) pieces.push(chunk.data);
      if (!pieces.length || this.stream !== state) return;
      const playing = !this.paused;
      this.media.src = URL.createObjectURL(new Blob(pieces as BlobPart[], { type: audioType(pieces[0] ?? new Uint8Array()) }));
      await new Promise((resolve) => this.media.addEventListener('loadedmetadata', resolve, { once: true }));
      if (this.stream !== state) return;
      this.media.currentTime = Math.max(0, this.currentTime - state.offset);
      this.mediaClock = true;
      if (playing || !this.paused) await this.media.play().catch(() => undefined);
    } catch {
      // without sound the picture keeps playing on its own clock
    }
  }

  private async download(state: StreamState, response: Response, reader: StreamReader, segment: AbortController, onChunks?: (chunks: Chunk[]) => void): Promise<void> {
    const body = response.body?.getReader();
    if (!body) return;
    for (;;) {
      while (!segment.signal.aborted && this.stream === state && this.bufferedEnd - this.currentTime > AHEAD) await new Promise((wait) => setTimeout(wait, 250));
      if (segment.signal.aborted) return;
      const { done, value } = await body.read();
      if (done) break;
      const chunks = reader.push(value);
      for (const chunk of chunks) if (chunk.frames > 0) this.store(state, chunk);
      onChunks?.(chunks);
      if (chunks.length > 0) this.emit('progress');
    }
    state.done = true;
    this.emit('progress');
    this.emit('durationchange');
  }

  private store(state: StreamState, chunk: Chunk): void {
    const chunks = state.chunks;
    let at = chunks.length;
    while (at > 0 && (chunks[at - 1]?.start ?? 0) > chunk.start) at -= 1;
    if (chunks[at - 1]?.start === chunk.start) return;
    chunks.splice(at, 0, chunk);
  }

  private async loadIndex(state: StreamState): Promise<void> {
    try {
      const tail = await fetch(state.url, { headers: { range: `bytes=-${INDEX_TRAILER}` }, signal: state.abort.signal });
      if (tail.status !== 206) {
        await tail.body?.cancel();
        return;
      }
      const length = indexLength(new Uint8Array(await tail.arrayBuffer()));
      if (!length) return;
      const chunk = await fetch(state.url, { headers: { range: `bytes=-${length}` }, signal: state.abort.signal });
      if (chunk.status === 206) state.index = readIndex(new Uint8Array(await chunk.arrayBuffer()));
    } catch {
      state.index = null;
    }
  }

  /**
   * A small picture of the stream at a time, for seek bar previews: the key frame of the chunk there, decoded from
   * memory or fetched with a range request when the file has an index. Null for videos and unreachable places.
   */
  async preview(seconds: number): Promise<{ readonly pixels: Uint8ClampedArray; readonly cols: number; readonly rows: number } | null> {
    const stream = this.stream;
    const info = stream?.reader.info;
    if (!stream || !info) return null;
    const frame = Math.max(0, Math.floor((seconds - stream.offset) * info.fps));
    const loaded = stream.chunks.find((chunk) => frame >= chunk.start && frame < chunk.start + chunk.frames);
    if (loaded) {
      const { frames } = await this.decode(stream, info, loaded);
      return frames[0] ? { pixels: frames[0], cols: info.cols, rows: info.rows } : null;
    }
    const entry = stream.index?.find((item) => frame >= item.start && frame < item.start + item.frames);
    if (!entry) return null;
    const cached = this.previews.get(entry.start);
    if (cached) return cached;
    const head = await fetch(stream.url, { headers: { range: `bytes=${entry.offset}-${entry.offset + 5}` } });
    if (head.status !== 206) return null;
    const size = new DataView(await head.arrayBuffer()).getUint32(0, true);
    const body = await fetch(stream.url, { headers: { range: `bytes=${entry.offset + 6}-${entry.offset + 5 + size}` } });
    if (body.status !== 206) return null;
    const { frames } = await decodeChunkMotion(info, new Uint8Array(await body.arrayBuffer()));
    if (!frames[0]) return null;
    const picture = { pixels: frames[0], cols: info.cols, rows: info.rows };
    this.previews.set(entry.start, picture);
    if (this.previews.size > 40) this.previews.delete(this.previews.keys().next().value ?? 0);
    return picture;
  }

  private async jump(state: StreamState, frame: number): Promise<void> {
    const entry = state.index?.find((item) => frame >= item.start && frame < item.start + item.frames);
    const info = state.reader.info;
    if (!entry || !info || state.chunks.some((chunk) => chunk.start === entry.start)) return;
    state.segment.abort();
    const segment = new AbortController();
    state.segment = segment;
    try {
      const response = await fetch(state.url, { headers: { range: `bytes=${entry.offset}-` }, signal: segment.signal, priority: 'low' } as RequestInit);
      if (response.status !== 206) {
        segment.abort();
        return;
      }
      await this.download(state, response, new StreamReader(info, entry.start), segment);
    } catch (error) {
      if (!segment.signal.aborted) this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
    }
  }

  private regionEnd(stream: StreamState): number {
    const info = stream.reader.info;
    if (!info) return 0;
    const frame = Math.max(0, Math.floor((this.currentTime - stream.offset) * info.fps));
    let at = stream.chunks.findIndex((chunk) => frame >= chunk.start && frame < chunk.start + chunk.frames);
    if (at < 0) return frame;
    let end = (stream.chunks[at]?.start ?? 0) + (stream.chunks[at]?.frames ?? 0);
    while (stream.chunks[at + 1]?.start === end) {
      at += 1;
      end += stream.chunks[at]?.frames ?? 0;
    }
    return end;
  }

  private reachesEnd(stream: StreamState): boolean {
    const total = stream.reader.info?.frameCount ?? 0;
    return total > 0 ? this.regionEnd(stream) >= total : stream.done;
  }

  private unload(): void {
    this.pauseLoop();
    this.track?.close();
    this.track = null;
    this.previews.clear();
    this.previous = null;
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
    if (stream) return stream.reader.info ? stream.offset + this.regionEnd(stream) / stream.reader.info.fps : stream.offset;
    const ranges = this.media.buffered;
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }

  get currentTime(): number {
    const stream = this.stream;
    if (!stream) return this.media.currentTime;
    if (this.hasAudio) return stream.offset + this.media.currentTime;
    return stream.clockAt + (this.loop !== null && !this.stalled ? ((performance.now() - stream.clockStart) / 1000) * this.rate : 0);
  }

  set currentTime(seconds: number) {
    void this.seek(seconds);
  }

  get volume(): number {
    return this.media.volume;
  }

  set volume(value: number) {
    this.media.volume = Math.min(1, Math.max(0, value));
    if (this.track) this.track.volume = this.media.volume;
  }

  get muted(): boolean {
    return this.media.muted;
  }

  set muted(value: boolean) {
    this.media.muted = value;
    if (this.track) this.track.muted = value;
  }

  get playbackRate(): number {
    return this.stream && !this.hasAudio ? this.rate : this.media.playbackRate;
  }

  set playbackRate(value: number) {
    if (this.stream && !this.hasAudio) {
      this.syncClock();
      this.rate = value;
      if (this.track && !this.paused) void this.track.play(this.currentTime, value);
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
    if (this.track) void this.track.play(this.currentTime, this.rate);
  }

  pause(): void {
    if (this.stream && !this.hasAudio) {
      if (this.loop === null) return;
      this.syncClock();
      this.track?.stop();
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
    if (info && !stream.source.restart) void this.jump(stream, Math.floor((time - stream.offset) * info.fps));
    stream.clockAt = time;
    stream.clockStart = performance.now();
    if (this.track && !this.paused && !this.stalled) void this.track.play(time, this.rate);
    else this.track?.prepare(time);
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
      if (stream) this.buffer(stream);
      if (stream?.reader.info && this.currentTime >= this.duration - 0.02 && this.reachesEnd(stream)) {
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
    const end = this.reachesEnd(stream);
    // a live broadcast never has seconds in reserve: it waits for the next chunk and goes on as soon as it arrives
    const live = !stream.reader.info?.frameCount && !stream.source.duration;
    const low = live ? 0.02 : 0.3;
    const enough = live ? 0.2 : 5;
    if (!this.stalled && !end && ahead < low) {
      // wait with a loader instead of running the clock past the downloaded frames
      stream.clockAt = this.currentTime;
      this.stalled = true;
      if (this.hasAudio) this.media.pause();
      this.track?.stop();
      this.emit('waiting');
    } else if (this.stalled && (end || ahead > enough)) {
      this.stalled = false;
      stream.clockStart = performance.now();
      if (this.hasAudio) void this.media.play().catch(() => undefined);
      if (this.track) void this.track.play(this.currentTime, this.rate);
      this.emit('playing');
    }
  }

  private pauseLoop(): void {
    if (this.loop !== null) cancelAnimationFrame(this.loop);
    this.loop = null;
  }

  private paint(pixels: Uint8ClampedArray, cols: number, rows: number, masks?: Uint8Array): void {
    this.lastFrame = { pixels, cols, rows, masks };
    pixels = this.steady(pixels);
    this.levels = this.look.autoLevels ? ease(this.levels, autoLevels(pixels)) : NEUTRAL;
    const caption = captionAt(this.cues, this.currentTime);
    if (caption !== this.caption) {
      this.caption = caption;
      this.renderer.setCaption(caption);
    }
    const sharp = this.look.sharp;
    this.renderer.draw(sharp ? upscale2x(pixels, cols, rows) : pixels, cols, rows, { detail: sharp ? 2 : 1, levels: this.levels, boost: this.look.boost, tint: this.look.tint, mode: this.look.mode, edges: this.look.edges, crt: this.look.crt, fill: this.look.fill, masks: masks ?? null, shades: (masks && shadesOf.get(masks)) ?? null });
  }

  private steady(pixels: Uint8ClampedArray): Uint8ClampedArray {
    const previous = this.previous;
    if (!previous || previous.length !== pixels.length) {
      this.previous = pixels.slice();
      return pixels;
    }
    const out = new Uint8ClampedArray(pixels.length);
    for (let index = 0; index < pixels.length; index += 1) {
      const before = previous[index] ?? 0;
      const delta = (pixels[index] ?? 0) - before;
      out[index] = delta > -24 && delta < 24 ? before + delta / 3 : before + delta;
    }
    this.previous = out;
    return out;
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
    const exact = Math.max(0, (this.currentTime - stream.offset) * info.fps);
    const index = Math.floor(exact);
    const between = this.look.smooth ? exact - index : 0;
    const position = stream.chunks.findIndex((chunk) => index >= chunk.start && index < chunk.start + chunk.frames);
    const chunk = stream.chunks[position];
    if (!chunk) {
      if (this.lastFrame) this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
      return;
    }
    const nextChunk = stream.chunks[position + 1];
    if (nextChunk) this.decode(stream, info, nextChunk);
    if (between > 0.05) {
      const following = index + 1 < chunk.start + chunk.frames ? chunk : nextChunk?.start === index + 1 ? nextChunk : null;
      if (following) {
        void Promise.all([this.decode(stream, info, chunk), this.decode(stream, info, following)]).then(([current, next]) => {
          if (this.stream !== stream) return;
          const from = current.frames[index - chunk.start];
          const to = next.frames[index + 1 - following.start];
          const motion = next.motion[index + 1 - following.start];
          if (!from || !to || !motion) return;
          this.shownFrame = -1;
          const masks = between < 0.5 ? current.detail?.[index - chunk.start] : next.detail?.[index + 1 - following.start];
          this.paint(interpolate(from, to, motion, info.cols, info.rows, between), info.cols, info.rows, masks);
        });
        return;
      }
    }
    if (index === this.shownFrame && this.lastFrame) {
      this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
      return;
    }
    void this.decode(stream, info, chunk).then(({ frames, detail }) => {
      if (this.stream !== stream) return;
      const frame = frames[index - chunk.start];
      if (!frame) return;
      this.shownFrame = index;
      this.paint(frame, info.cols, info.rows, detail?.[index - chunk.start]);
    });
  }

  private decode(stream: StreamState, info: StreamInfo, chunk: Chunk): Promise<DecodedChunk> {
    let pending = stream.decoded.get(chunk.start);
    if (!pending) {
      pending = decodeChunkMotion(info, chunk.data);
      // each frame's dark-side colors travel with its masks, so every place that paints masks gets them too
      void pending.then((decoded) => decoded.shades?.forEach((shades, at) => decoded.detail?.[at] && shadesOf.set(decoded.detail[at]!, shades))).catch(() => undefined);
      stream.decoded.set(chunk.start, pending);
      for (const key of stream.decoded.keys()) if (Math.abs(key - chunk.start) > info.chunkFrames * 3) stream.decoded.delete(key);
    }
    return pending;
  }
}
