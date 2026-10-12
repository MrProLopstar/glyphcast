import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChunk, GlyphcastError, HEADER_SIZE, INDEX_TRAILER, indexLength, readHeader, readIndex, StreamReader, type Chunk, type StreamInfo } from './format.js';
import { autoLevels, ease, glyphIndex, luma, NEUTRAL, type Levels } from './levels.js';
import { probe } from './node.js';
import { DEFAULT_GLYPHS } from './renderer.js';

export interface TerminalOptions {
  /** Glyphs from dark to bright. Default `' .:-=+*#%@'`. */
  readonly glyphs?: string;
  /** Saturation multiplier, as in the browser. Default 1.3. */
  readonly boost?: number;
  /** Grid width for video files. Default the terminal width. */
  readonly cols?: number;
  /** Frames per second for video files. Default 24. */
  readonly fps?: number;
  /** Where frames go. Default `process.stdout`. */
  readonly output?: NodeJS.WriteStream;
  /** Path to ffmpeg, for video files. */
  readonly ffmpeg?: string;
  /** Path to ffplay, which plays the sound embedded in a `.gcast`. Default `ffplay` from PATH; without it playback is silent. */
  readonly ffplay?: string;
}

const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/** One frame as ANSI text: a glyph per cell in 24-bit color, scaled down to `width × height` cells if needed. */
export const ansiFrame = (pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, stride: number, levels: Levels, options: { readonly glyphs?: string; readonly boost?: number; readonly width?: number; readonly height?: number } = {}): string => {
  const glyphs = [...(options.glyphs ?? DEFAULT_GLYPHS)];
  const boost = options.boost ?? 1.3;
  const scale = Math.min(1, (options.width ?? cols) / cols, (options.height ?? rows) / rows);
  const width = Math.max(1, Math.floor(cols * scale));
  const height = Math.max(1, Math.floor(rows * scale));
  let out = '';
  let last = '';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (Math.floor(y / scale) * cols + Math.floor(x / scale)) * stride;
      const r = pixels[at] ?? 0;
      const g = pixels[at + 1] ?? 0;
      const b = pixels[at + 2] ?? 0;
      const value = luma(r, g, b);
      const index = glyphIndex(value, levels, glyphs.length);
      const lift = 0.55 + ((index + 0.5) / glyphs.length) * 0.9;
      const gray = value * 255;
      const color = `\x1b[38;2;${channel((gray + (r - gray) * boost) * lift)};${channel((gray + (g - gray) * boost) * lift)};${channel((gray + (b - gray) * boost) * lift)}m`;
      if (color !== last) out += color;
      last = color;
      out += glyphs[index] ?? ' ';
    }
    out += y < height - 1 ? '\x1b[0m\n' : '\x1b[0m';
    last = '';
  }
  return out;
};

const screen = (output: NodeJS.WriteStream): { readonly width: number; readonly height: number; readonly close: () => void } => {
  output.write('\x1b[?1049h\x1b[?25l');
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  process.once('exit', close);
  process.once('SIGINT', () => {
    close();
    process.exit(130);
  });
  return { width: output.columns || 120, height: Math.max(1, (output.rows || 40) - 1), close };
};

interface Piece {
  readonly start: number;
  readonly frames: number;
  readonly load: () => Promise<Uint8Array>;
}

interface Library {
  readonly info: StreamInfo;
  readonly pieces: Piece[];
  readonly sound: Uint8Array | null;
  readonly complete: () => boolean;
  readonly close: () => void;
}

const fromFile = async (path: string): Promise<Library> => {
  const file = await open(path, 'r');
  const size = (await file.stat()).size;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    const bytes = new Uint8Array(length);
    await file.read(bytes, 0, length, offset);
    return bytes;
  };
  const info = readHeader(await read(0, HEADER_SIZE));
  const length = indexLength(await read(Math.max(0, size - INDEX_TRAILER), Math.min(size, INDEX_TRAILER)));
  if (length) {
    const entries = readIndex(await read(size - length, length));
    const head = await read(HEADER_SIZE, (entries[0]?.offset ?? HEADER_SIZE) - HEADER_SIZE);
    const sound = new StreamReader(info).push(head).filter((chunk) => chunk.frames === 0);
    const pieces = entries.map((entry) => ({
      start: entry.start,
      frames: entry.frames,
      load: async () => {
        const top = await read(entry.offset, 4);
        const bytes = new DataView(top.buffer).getUint32(0, true);
        return read(entry.offset + 6, bytes);
      },
    }));
    return { info, pieces, sound: sound.length ? concat(sound.map((chunk) => chunk.data)) : null, complete: () => true, close: () => void file.close() };
  }
  await file.close();
  const reader = new StreamReader();
  const chunks = reader.push(new Uint8Array(await readFile(path)));
  return fromChunks(reader.info ?? info, chunks, () => true);
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const fromChunks = (info: StreamInfo, chunks: Chunk[], complete: () => boolean): Library => {
  const audio = chunks.filter((chunk) => chunk.frames === 0).map((chunk) => chunk.data);
  const pieces = chunks.filter((chunk) => chunk.frames > 0).map((chunk) => ({ start: chunk.start, frames: chunk.frames, load: () => Promise.resolve(chunk.data) }));
  return { info, pieces, sound: audio.length ? concat(audio) : null, complete, close: () => undefined };
};

const fromUrl = async (url: string): Promise<Library> => {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new GlyphcastError(`Cannot load ${url}: HTTP ${response.status}`);
  const body = response.body.getReader();
  const reader = new StreamReader();
  const chunks: Chunk[] = [];
  let done = false;
  while (!reader.info || !chunks.some((chunk) => chunk.frames > 0)) {
    const part = await body.read();
    if (part.done) throw new GlyphcastError('The stream has no frames');
    chunks.push(...reader.push(part.value));
  }
  const library = fromChunks(reader.info, chunks, () => done);
  void (async () => {
    for (let part = await body.read(); !part.done; part = await body.read()) {
      for (const chunk of reader.push(part.value)) if (chunk.frames > 0) library.pieces.push({ start: chunk.start, frames: chunk.frames, load: () => Promise.resolve(chunk.data) });
    }
    done = true;
  })();
  return library;
};

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const sounds = (library: Library, ffplay: string): { readonly start: (at: number) => void; readonly stop: () => void; readonly close: () => void } => {
  if (!library.sound) return { start: () => undefined, stop: () => undefined, close: () => undefined };
  const folder = mkdtempSync(join(tmpdir(), 'glyphcast-'));
  const file = join(folder, 'sound');
  writeFileSync(file, library.sound);
  let child: ChildProcess | null = null;
  let missing = false;
  const stop = (): void => {
    child?.kill();
    child = null;
  };
  process.once('exit', stop);
  return {
    start: (at) => {
      stop();
      if (missing) return;
      child = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', at.toFixed(2), file], { stdio: 'ignore' });
      child.on('error', () => (missing = true));
    },
    stop,
    close: () => {
      stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
};

const playStream = async (input: string, options: TerminalOptions, output: NodeJS.WriteStream): Promise<void> => {
  const library = /^https?:\/\//.test(input) ? await fromUrl(input) : await fromFile(input);
  const { info } = library;
  const total = (): number => (info.frameCount || library.pieces.reduce((sum, piece) => Math.max(sum, piece.start + piece.frames), 0)) / info.fps;
  const audio = sounds(library, options.ffplay ?? 'ffplay');
  const view = screen(output);
  const input$ = process.stdin;
  let base = 0;
  let startedAt = performance.now();
  let playing = true;
  let quit = false;
  let levels = NEUTRAL;
  const cache = new Map<number, Promise<Uint8ClampedArray[]>>();
  const now = (): number => Math.min(total(), playing ? base + (performance.now() - startedAt) / 1000 : base);
  const jump = (seconds: number): void => {
    base = Math.max(0, Math.min(total(), seconds));
    startedAt = performance.now();
    if (playing) audio.start(base);
  };
  const toggle = (): void => {
    if (playing) {
      base = now();
      playing = false;
      audio.stop();
    } else {
      playing = true;
      startedAt = performance.now();
      audio.start(base);
    }
  };
  const frames = (piece: Piece): Promise<Uint8ClampedArray[]> => {
    let pending = cache.get(piece.start);
    if (!pending) {
      pending = piece.load().then((data) => decodeChunk(info, data));
      cache.set(piece.start, pending);
      for (const key of cache.keys()) if (Math.abs(key - piece.start) > info.chunkFrames * 2) cache.delete(key);
    }
    return pending;
  };
  const keys = (data: Buffer): void => {
    const key = data.toString();
    if (key === 'q' || key === '\u0003' || key === '\u001b') quit = true;
    else if (key === ' ' || key === 'k') toggle();
    else if (key === '\u001b[D') jump(now() - 5);
    else if (key === '\u001b[C') jump(now() + 5);
    else if (key === 'j') jump(now() - 10);
    else if (key === 'l') jump(now() + 10);
    else if (/^[0-9]$/.test(key)) jump((Number(key) / 10) * total());
  };
  const interactive = Boolean(input$.isTTY);
  if (interactive) {
    input$.setRawMode(true);
    input$.resume();
    input$.on('data', keys);
  }
  audio.start(0);
  try {
    let shown = -1;
    while (!quit) {
      const time = now();
      const index = Math.min(Math.floor(time * info.fps), Math.max(0, Math.round(total() * info.fps) - 1));
      const piece = library.pieces.find((item) => index >= item.start && index < item.start + item.frames);
      if (piece && index !== shown) {
        const frame = (await frames(piece))[index - piece.start];
        const next = library.pieces.find((item) => item.start === piece.start + piece.frames);
        if (next) void frames(next);
        if (frame) {
          levels = ease(levels, autoLevels(frame));
          output.write(`\x1b[H${ansiFrame(frame, info.cols, info.rows, 4, levels, { ...options, width: view.width, height: view.height })}`);
          shown = index;
        }
      }
      const share = total() > 0 ? time / total() : 0;
      const bar = Math.max(10, view.width - 52);
      const filled = Math.round(share * bar);
      output.write(`\x1b[${view.height + 1};1H\x1b[0m\x1b[2K${playing ? '▶' : '❚❚'} ${clock(time)} / ${clock(total())} ${'█'.repeat(filled)}${'░'.repeat(bar - filled)}${interactive ? '  space ←→ j l 0-9 q' : ''}`);
      if (playing && time >= total() && library.complete()) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, 1000 / info.fps / 2)));
    }
  } finally {
    if (interactive) {
      input$.off('data', keys);
      input$.setRawMode(false);
      input$.pause();
    }
    audio.close();
    library.close();
    view.close();
  }
};

const playVideo = async (input: string, options: TerminalOptions, output: NodeJS.WriteStream): Promise<void> => {
  const view = screen(output);
  const cols = Math.min(options.cols ?? view.width, view.width);
  const { width, height } = await probe(input, options.ffmpeg?.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')).catch(() => ({ width: 16, height: 9 }));
  const rows = Math.min(view.height, Math.max(1, Math.round(cols * (height / width) * 0.5)));
  const frameSize = cols * rows * 3;
  let levels = NEUTRAL;
  let pending: Buffer = Buffer.alloc(0);
  const child = spawn(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-re', '-i', input, '-an', '-vf', `fps=${options.fps ?? 24},scale=${cols}:${rows}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (data: Buffer) => {
    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
    while (pending.length >= frameSize) {
      const frame = pending.subarray(0, frameSize);
      pending = pending.subarray(frameSize);
      levels = ease(levels, autoLevels(frame, 3));
      output.write(`\x1b[H${ansiFrame(frame, cols, rows, 3, levels, options)}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', (error) => reject(new GlyphcastError(`Cannot run ffmpeg: ${error.message}`)));
    child.on('close', () => resolve());
  }).finally(view.close);
};

/**
 * Plays a `.gcast` file, a `.gcast` URL (for example a `glyphcast serve` stream) or any video file in the
 * terminal with 24-bit color glyphs. For `.gcast` there are controls: Space pauses, ←/→ seek 5 s, J/L 10 s, 0–9 jump,
 * Q quits; embedded sound plays through ffplay. Large files with an index are read from disk chunk by chunk.
 */
export const playInTerminal = (input: string, options: TerminalOptions = {}): Promise<void> => {
  const output = options.output ?? process.stdout;
  return /\.gcast(?:$|[?#])|\/stream\?/i.test(input) ? playStream(input, options, output) : playVideo(input, options, output);
};
