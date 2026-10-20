import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { decodeChunkMotion, GlyphcastError, interpolate, type DecodedChunk, HEADER_SIZE, INDEX_TRAILER, indexLength, readHeader, readIndex, StreamReader, type Chunk, type StreamInfo } from './format.js';
import { autoLevels, ease, luma, NEUTRAL, SHADOWS, type Levels } from './levels.js';
import { probe } from './node.js';
import { GLYPH_SETS, TINTS } from './looks.js';
import { captionAt, parseCaptions } from './captions.js';
import { DEFAULT_GLYPHS } from './renderer.js';
import { upscale2x } from './upscale.js';

/** Options of `playInTerminal`. */
export interface TerminalOptions {
  /** Glyphs from dark to bright. Default `' .:-=+*#%@'`. */
  readonly glyphs?: string;
  /** Saturation multiplier, as in the browser. Default 1.3. */
  readonly boost?: number;
  /** Default `braille`, as in the playground. */
  readonly mode?: TerminalMode;
  /** One color for every glyph, CSS hex. */
  readonly tint?: string | null;
  /** Cell background tinted by its color. Default 0.25, as in the browser. */
  readonly fill?: number;
  /** Grid width for video files. Default the terminal width. */
  readonly cols?: number;
  /** Frames per second for video files. Default 24. */
  readonly fps?: number;
  /** Where frames go. Default `process.stdout`. */
  readonly output?: NodeJS.WriteStream;
  /** Path to ffmpeg, for video files. */
  readonly ffmpeg?: string;
  /** Where keys come from. Default `process.stdin`. */
  readonly input?: NodeJS.ReadStream;
  /** Path to ffplay, which plays the sound embedded in a `.gcast`. Default `ffplay` from PATH; without it playback is silent, `''` turns sound off. */
  readonly ffplay?: string;
  /** Name shown while loading. Default the input. */
  readonly title?: string;
  /** WebVTT or SRT text, shown over the bottom of the picture. */
  readonly subtitles?: string;
}

const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/** How the terminal draws a cell: a glyph, a 2×4 braille pattern, or two half blocks with their own colors. */
export type TerminalMode = 'glyphs' | 'braille' | 'blocks';

/** Options of `ansiFrame`. */
export interface AnsiOptions {
  /** Glyphs from dark to bright. Default `' .:-=+*#%@'`. */
  readonly glyphs?: string;
  /** Saturation multiplier. Default 1.3. */
  readonly boost?: number;
  /** Terminal cells available; the picture is fitted into them, keeping its proportions. */
  readonly width?: number;
  readonly height?: number;
  /** Default `braille`. */
  readonly mode?: TerminalMode;
  /** One color for every glyph, CSS hex, or null for the frame colors. */
  readonly tint?: string | null;
  /** How much each cell's background takes its color, 0 for none. Default 0. */
  readonly fill?: number;
  /** Dot patterns of a detail stream on its own grid, drawn exactly in braille mode. */
  readonly detail?: { readonly masks: Uint8Array; readonly cols: number; readonly rows: number; readonly pixels?: Uint8ClampedArray; readonly shades?: Uint8Array } | undefined;
  /** Height of a terminal cell divided by its width. Default 2.25. */
  readonly cellRatio?: number;
}

const BAYER = [0.0625, 0.5625, 0.8125, 0.3125, 0.9375, 0.4375, 0.1875, 0.6875];
const BRAILLE = [0, 1, 2, 6, 3, 4, 5, 7];

const rgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Size of the picture in terminal cells for a grid fitted into `width × height`. Terminal cells are about twice as tall as wide. */
export const fitTerminal = (cols: number, rows: number, width: number, height: number, cellRatio = 2.25): { readonly width: number; readonly height: number } => {
  const ratio = (cols * 0.6 * cellRatio) / rows;
  const fitted = Math.max(1, Math.min(width, Math.floor(height * ratio)));
  return { width: fitted, height: Math.max(1, Math.min(height, Math.round(fitted / ratio))) };
};

/** One frame as ANSI text in 24-bit color, fitted into `width × height` terminal cells. */
export const ansiFrame = (pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, stride: number, levels: Levels, options: AnsiOptions = {}): string => {
  const glyphs = [...(options.glyphs ?? DEFAULT_GLYPHS)];
  const boost = options.boost ?? 1.3;
  const tint = options.tint ? rgb(options.tint) : null;
  const fill = options.fill ?? 0;
  const mode = options.mode ?? 'braille';
  const { width, height } = fitTerminal(cols, rows, options.width ?? cols, options.height ?? Math.round(rows / 1.2), options.cellRatio);
  const sample = (x: number, y: number): [number, number, number] => {
    const gx = Math.min(cols - 1, Math.max(0, x * cols - 0.5));
    const gy = Math.min(rows - 1, Math.max(0, y * rows - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c += 1) {
      const a = pixels[(y0 * cols + x0) * stride + c] ?? 0;
      const b = pixels[(y0 * cols + x1) * stride + c] ?? 0;
      const d = pixels[(y1 * cols + x0) * stride + c] ?? 0;
      const e = pixels[(y1 * cols + x1) * stride + c] ?? 0;
      out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
    return out;
  };
  const level = (color: readonly number[]): number => Math.min(1, Math.max(0, (luma(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0) - 0.5) * levels.contrast + 0.5 + levels.brightness)) ** SHADOWS;
  const paint = (color: readonly number[], lit: number): [number, number, number] => {
    if (tint) return [tint[0] * (0.35 + lit), tint[1] * (0.35 + lit), tint[2] * (0.35 + lit)];
    const gray = luma(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0) * 255;
    const lift = 0.55 + lit * 0.9;
    return [(gray + ((color[0] ?? 0) - gray) * boost) * lift, (gray + ((color[1] ?? 0) - gray) * boost) * lift, (gray + ((color[2] ?? 0) - gray) * boost) * lift];
  };
  const code = (kind: 38 | 48, color: readonly number[]): string => `\x1b[${kind};2;${channel(color[0] ?? 0)};${channel(color[1] ?? 0)};${channel(color[2] ?? 0)}m`;
  let out = '';
  for (let y = 0; y < height; y += 1) {
    let last = '';
    for (let x = 0; x < width; x += 1) {
      let style: string;
      let char: string;
      if (mode === 'blocks') {
        const top = sample((x + 0.5) / width, (y + 0.25) / height);
        const bottom = sample((x + 0.5) / width, (y + 0.75) / height);
        style = code(38, paint(top, level(top))) + code(48, paint(bottom, level(bottom)));
        char = '▀';
      } else {
        const center = sample((x + 0.5) / width, (y + 0.5) / height);
        const lit = level(center);
        let color = paint(center, lit);
        let back = color.map((value) => value * fill * 0.5);
        if (mode === 'braille') {
          let bits = 0;
          const on = [0, 0, 0, 0];
          const off = [0, 0, 0, 0];
          for (let dot = 0; dot < 8; dot += 1) {
            const dx = dot % 2;
            const dy = Math.floor(dot / 2);
            const spot = sample((x + (dx + 0.5) / 2) / width, (y + (dy + 0.5) / 4) / height);
            const near = level(spot);
            const target = near > Math.max(0.18, (BAYER[dot] ?? 0.5) * 0.75) ? on : off;
            if (target === on) bits |= 1 << (BRAILLE[dx * 4 + dy] ?? 0);
            target[0] = (target[0] ?? 0) + spot[0];
            target[1] = (target[1] ?? 0) + spot[1];
            target[2] = (target[2] ?? 0) + spot[2];
            target[3] = (target[3] ?? 0) + 1;
          }
          const mean = (sum: number[]): [number, number, number] => [(sum[0] ?? 0) / (sum[3] || 1), (sum[1] ?? 0) / (sum[3] || 1), (sum[2] ?? 0) / (sum[3] || 1)];
          const lights = on[3] ? mean(on) : center;
          color = paint(lights, Math.min(1, level(lights) + 0.15)).map((value) => value * 1.15) as [number, number, number];
          const shade = off[3] ? mean(off) : center;
          back = paint(shade, level(shade)).map((value) => value * fill);
          const grid = options.detail;
          const cell = grid ? Math.min(grid.rows - 1, Math.floor(((y + 0.5) / height) * grid.rows)) * grid.cols + Math.min(grid.cols - 1, Math.floor(((x + 0.5) / width) * grid.cols)) : 0;
          const pattern = grid ? (grid.masks[cell] ?? 0) : 0;
          // one color per cell here, so patterns are kept only for thin bright lines (up to 4 lit dots): wide bright halves
          // would light the whole cell and stand out from the sparse dots around them
          let lit$ = 0;
          for (let rest = pattern; rest; rest &= rest - 1) lit$ += 1;
          const u = 1 / (grid?.cols ?? width);
          const v = 1 / (grid?.rows ?? height);
          const darkSide = (): number[] => {
            // version 4 files carry the dark dots' color; older files estimate it from the neighbors
            const stored = grid?.shades ? [grid.shades[cell * 3] ?? 0, grid.shades[cell * 3 + 1] ?? 0, grid.shades[cell * 3 + 2] ?? 0] : null;
            if (stored && stored[0]! + stored[1]! + stored[2]! > 0) return stored;
            // the stored color is the bright dots'; the gaps are closest to the neighbors darker than it
            const cx = (x + 0.5) / width;
            const cy = (y + 0.5) / height;
            const around = [sample(cx - u, cy), sample(cx + u, cy), sample(cx, cy - v), sample(cx, cy + v)];
            const own = luma(center[0] ?? 0, center[1] ?? 0, center[2] ?? 0);
            const darker = around.filter((item) => luma(item[0] ?? 0, item[1] ?? 0, item[2] ?? 0) < own - 0.04);
            return darker.length ? [0, 1, 2].map((c) => darker.reduce((sum, item) => sum + (item[c] ?? 0), 0) / darker.length) : center.map((value) => value * 0.5);
          };
          if (pattern && lit$ > 4) {
            // drawn the usual way, but as bright as the whole cell really is, not as its bright dots
            const dark = darkSide();
            const whole = [0, 1, 2].map((c) => ((center[c] ?? 0) * lit$ + (dark[c] ?? 0) * (8 - lit$)) / 8);
            const ratio = luma(whole[0] ?? 0, whole[1] ?? 0, whole[2] ?? 0) / Math.max(0.01, luma(center[0] ?? 0, center[1] ?? 0, center[2] ?? 0));
            color = color.map((value) => value * ratio) as [number, number, number];
            back = back.map((value) => value * ratio);
          }
          if (pattern && lit$ <= 4) {
            bits = 0;
            for (let dot = 0; dot < 8; dot += 1) if ((pattern >> dot) & 1) bits |= 1 << (BRAILLE[(dot & 1) * 4 + (dot >> 1)] ?? 0);
            // the stored color of a patterned cell is its bright dots: take it from the frame itself, not from the
            // smoothed and upscaled picture, where thin bright letters blur into their dark surroundings
            const own = grid?.pixels ? [grid.pixels[cell * 4] ?? 0, grid.pixels[cell * 4 + 1] ?? 0, grid.pixels[cell * 4 + 2] ?? 0] : center;
            color = paint(own, Math.min(1, level(own) + 0.1)).map((value) => value * 1.15) as [number, number, number];
            const dark = darkSide();
            // the gaps are dimmed exactly like the backgrounds around them, so letters on a colored scene get no halo
            back = paint(dark, level(dark)).map((value) => value * fill);
          }
          char = String.fromCharCode(0x2800 + bits);
        } else {
          char = glyphs[Math.min(glyphs.length - 1, Math.floor(lit * glyphs.length))] ?? ' ';
        }
        style = code(38, color) + (fill > 0 ? code(48, back) : '');
      }
      if (style !== last) out += style;
      last = style;
      out += char;
    }
    out += y < height - 1 ? '\x1b[0m\n' : '\x1b[0m';
  }
  return out;
};

const screen = (output: NodeJS.WriteStream): { width: number; height: number; readonly close: () => void } => {
  output.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  const view = { width: output.columns || 120, height: Math.max(1, (output.rows || 40) - 1), close: () => undefined as void };
  const resize = (): void => {
    view.width = output.columns || view.width;
    view.height = Math.max(1, (output.rows || view.height + 1) - 1);
    output.write('\x1b[2J');
  };
  output.on('resize', resize);
  let closed = false;
  view.close = (): void => {
    if (closed) return;
    closed = true;
    output.off('resize', resize);
    output.write('\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l');
  };
  process.once('exit', view.close);
  process.once('SIGINT', () => {
    view.close();
    process.exit(130);
  });
  return view;
};

const steady = (previous: Uint8ClampedArray | null, pixels: Uint8ClampedArray): Uint8ClampedArray => {
  if (!previous || previous.length !== pixels.length) return pixels.slice();
  const out = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 1) {
    const before = previous[index] ?? 0;
    const delta = (pixels[index] ?? 0) - before;
    out[index] = delta > -24 && delta < 24 ? before + delta / 3 : before + delta;
  }
  return out;
};

const MODES: readonly TerminalMode[] = ['braille', 'glyphs', 'blocks'];

/** Words of the player's status bar; English unless GLYPHCAST_LANG=ru (glc --lang ru). */
const WORDS = {
  en: { modes: ['braille', 'glyphs', 'half blocks'], glyphs: ['classic', 'blocks', 'dense', 'dots', 'binary', 'katakana'], tints: ['video colors', 'matrix', 'amber', 'neon', 'mono'], sat: 'sat', bg: 'bg', sharp: '2x', smooth: 'smooth', subs: 'subs', loading: 'loading' },
  ru: { modes: ['брайль', 'символы', 'полублоки'], glyphs: ['классика', 'блоки', 'плотные', 'точки', 'двоичные', 'катакана'], tints: ['как в видео', 'матрица', 'ламповый', 'неон', 'монохром'], sat: 'насыщ.', bg: 'фон', sharp: 'чёткость', smooth: 'плавность', subs: 'субтитры', loading: 'загрузка' },
};
/** Words of the terminal player's status bar in the chosen language. */
export const words = (): (typeof WORDS)['en'] => (process.env['GLYPHCAST_LANG'] === 'ru' ? WORDS.ru : WORDS.en);
const BOOSTS = [1.3, 1.6, 2, 0.7, 1];

interface Segment {
  readonly text: string;
  readonly act?: () => void;
  readonly on?: boolean;
}

const button = (segment: Segment): string => `\x1b[48;2;34;39;46m${segment.on === false ? '\x1b[38;2;110;118;129m' : segment.on ? '\x1b[38;2;240;160;75m' : '\x1b[38;2;232;236;239m'} ${segment.text} \x1b[0m`;
const FILLS = [0.25, 0.5, 0];
const RUSSIAN: Readonly<Record<string, string>> = { ч: 'x', м: 'v', й: 'q', л: 'k', о: 'j', д: 'l', ь: 'm', п: 'g', с: 'c', х: '[', ъ: ']', и: 'b' };

interface Piece {
  readonly start: number;
  readonly frames: number;
  readonly load: () => Promise<Uint8Array>;
}

interface AudioSource {
  readonly size: number;
  readonly read: (position: number, length: number) => Promise<Uint8Array>;
}

interface Library {
  readonly info: StreamInfo;
  readonly pieces: Piece[];
  readonly audio: AudioSource | null;
  readonly subtitles?: string | undefined;
  readonly complete: () => boolean;
  readonly close: () => void;
}

const indexed = async (read: (offset: number, length: number) => Promise<Uint8Array>, size: number, close: () => void): Promise<Library | null> => {
  const info = readHeader(await read(0, HEADER_SIZE));
  const length = indexLength(await read(Math.max(0, size - INDEX_TRAILER), Math.min(size, INDEX_TRAILER)));
  if (!length) return null;
  const entries = readIndex(await read(size - length, length));
  let first = HEADER_SIZE;
  let subtitles: string | undefined;
  if ((entries[0]?.offset ?? HEADER_SIZE) - first > 6) {
    const head = await read(first, 6);
    const view = new DataView(head.buffer, head.byteOffset);
    if (view.getUint16(4, true) === 0xfffe) {
      const length = view.getUint32(0, true);
      subtitles = new TextDecoder().decode(await read(first + 6, length));
      first += 6 + length;
    }
  }
  const region = (entries[0]?.offset ?? HEADER_SIZE) - first;
  let audio: AudioSource | null = null;
  if (region > 6) {
    const top = await read(first, 6);
    const piece = new DataView(top.buffer, top.byteOffset).getUint32(0, true);
    const count = Math.ceil(region / (piece + 6));
    const total = region - count * 6;
    const at = (position: number): number => first + Math.floor(position / piece) * (piece + 6) + 6 + (position % piece);
    audio = {
      size: total,
      read: async (position, wanted) => {
        const length = Math.min(wanted, total - position);
        if (length <= 0) return new Uint8Array(0);
        const first = at(position);
        const raw = await read(first, at(position + length - 1) + 1 - first);
        const out = new Uint8Array(length);
        for (let done = 0; done < length; ) {
          const take = Math.min(length - done, piece - ((position + done) % piece));
          const from = at(position + done) - first;
          out.set(raw.subarray(from, from + take), done);
          done += take;
        }
        return out;
      },
    };
  }
  const pieces = entries.map((entry, at) => ({
    start: entry.start,
    frames: entry.frames,
    // one request per chunk: it ends where the next chunk (or the index) starts, the 6-byte head comes along
    load: async () => {
      const end = entries[at + 1]?.offset ?? size - length;
      const bytes = await read(entry.offset, end - entry.offset);
      const body = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
      return bytes.subarray(6, 6 + body);
    },
  }));
  return { info, pieces, audio, subtitles, complete: () => true, close };
};

const fromFile = async (path: string): Promise<Library> => {
  const file = await open(path, 'r');
  const size = (await file.stat()).size;
  const library = await indexed(
    async (offset, length) => {
      const bytes = new Uint8Array(length);
      await file.read(bytes, 0, length, offset);
      return bytes;
    },
    size,
    () => void file.close(),
  );
  if (library) return library;
  await file.close();
  const reader = new StreamReader();
  const chunks = reader.push(new Uint8Array(await readFile(path)));
  if (!reader.info) throw new GlyphcastError('Not a .gcast file');
  return fromChunks(reader.info, chunks, () => true);
};

const fromRanges = async (url: string): Promise<Library | null> => {
  const probe = await fetch(url, { headers: { range: `bytes=-${INDEX_TRAILER}` } });
  const size = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? 0);
  if (probe.status !== 206 || !size) {
    await probe.body?.cancel();
    return null;
  }
  await probe.arrayBuffer();
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    if (length <= 0) return new Uint8Array(0);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
        if (response.status !== 206) throw new GlyphcastError(`Cannot read ${url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  };
  return indexed(read, size, () => undefined);
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
  const parts = chunks.filter((chunk) => chunk.frames === 0 && !chunk.subtitles).map((chunk) => chunk.data);
  const sound = concat(parts);
  const pieces = chunks.filter((chunk) => chunk.frames > 0).map((chunk) => ({ start: chunk.start, frames: chunk.frames, load: () => Promise.resolve(chunk.data) }));
  const subtitles = chunks.find((chunk) => chunk.subtitles);
  return {
    info,
    pieces,
    audio: parts.length ? { size: sound.length, read: (position, length) => Promise.resolve(sound.subarray(position, position + length)) } : null,
    subtitles: subtitles ? new TextDecoder().decode(subtitles.data) : undefined,
    complete,
    close: () => undefined,
  };
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
  })().catch(() => (done = true));
  return library;
};

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const pages = (bytes: Uint8Array): number[] => {
  const found: number[] = [];
  for (let at = 0; at + 4 <= bytes.length; at += 1) if (bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53) found.push(at);
  return found;
};

const sounds = (audio: AudioSource | null, total: () => number, ffplay: string): { readonly start: (at: number) => Promise<number>; readonly stop: () => void; readonly close: () => void; readonly live: () => boolean } => {
  let child: ChildProcess | null = null;
  let session = 0;
  let missing = false;
  const stop = (): void => {
    session += 1;
    // ponytail: on Windows ffplay may sit behind a shim, so kill the whole tree or the sound keeps going
    if (child?.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    else child?.kill();
    child = null;
  };
  if (!audio) return { start: (at) => Promise.resolve(at), stop, close: stop, live: () => false };
  process.once('exit', stop);
  const intro = audio.read(0, Math.min(audio.size, 65536)).then((first) => {
    const found = pages(first);
    if (found[0] !== 0 || found.length < 3) return null;
    const head = first.subarray(0, found[2]);
    const opus = new TextDecoder().decode(head).indexOf('OpusHead');
    return { head, preskip: opus >= 0 ? new DataView(head.buffer, head.byteOffset).getUint16(opus + 10, true) : 0 };
  });
  const pump = async (current: number, process$: ChildProcess, from: number): Promise<void> => {
    const input = process$.stdin;
    if (!input) return;
    for (let at = from; at < audio.size && current === session; ) {
      const part = await audio.read(at, 262144);
      if (current !== session || part.length === 0) return;
      at += part.length;
      if (!input.write(part)) await new Promise((resolve) => input.once('drain', resolve));
    }
    if (current === session) input.end();
  };
  return {
    start: async (at) => {
      stop();
      const current = session;
      if (missing) return at;
      const ogg = await intro;
      let from = 0;
      let actual = at;
      if (ogg && at > 0.5) {
        // guess the byte position from the time; when the page found there starts after `at`, step back and look again
        let guess = Math.floor((at / Math.max(total(), 0.001)) * audio.size);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const window = await audio.read(guess, 65536);
          const page = pages(window)[0];
          if (page === undefined || page + 27 >= window.length) break;
          const view = new DataView(window.buffer, window.byteOffset);
          const granule = Number(view.getBigInt64(page + 6, true));
          const segments = window.subarray(page + 27, page + 27 + (window[page + 26] ?? 0));
          const packets = segments.filter((value) => value < 255).length;
          actual = Math.max(0, (granule - ogg.preskip) / 48000 - packets * 0.02);
          from = guess + page;
          if (actual <= at || guess === 0) break;
          guess = Math.max(0, guess - Math.ceil(((actual - at + 2) / Math.max(total(), 0.001)) * audio.size));
        }
      }
      if (current !== session) return actual;
      // the page found by guessing starts a bit before `at`; ffplay skips the difference, so sound and picture meet at `at`
      const skip = ogg ? Math.max(0, at - actual) : at;
      const ss = skip > 0.05 && (ogg || at > 0.5) ? ['-ss', skip.toFixed(2)] : [];
      actual = ogg && from > 0 ? at : actual;
      const started = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', ...ss, '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child = started;
      started.on('error', () => (missing = true));
      started.stdin.on('error', () => undefined);
      if (ogg && from > 0) started.stdin.write(ogg.head);
      void pump(current, started, from).catch(() => undefined);
      return actual;
    },
    stop,
    close: stop,
    live: () => child !== null && !missing,
  };
};

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const playStream = async (input: string, options: TerminalOptions, output: NodeJS.WriteStream): Promise<void> => {
  let turn = 0;
  const loading = output.isTTY ? setInterval(() => output.write(`\r\x1b[2K${SPINNER[(turn += 1) % SPINNER.length]} glyphcast: loading ${options.title ?? input}`), 80) : null;
  const library = await (/^https?:\/\//.test(input) ? fromRanges(input).then((found) => found ?? fromUrl(input)) : fromFile(input)).finally(() => {
    if (loading) clearInterval(loading);
    if (output.isTTY) output.write('\r\x1b[2K');
  });
  const { info } = library;
  const total = (): number => (info.frameCount || library.pieces.reduce((sum, piece) => Math.max(sum, piece.start + piece.frames), 0)) / info.fps;
  const audio = sounds(options.ffplay === '' ? null : library.audio, total, options.ffplay || 'ffplay');
  const view = screen(output);
  output.write(`\x1b[${Math.max(1, Math.floor(view.height / 2))};${Math.max(1, Math.floor(view.width / 2) - 6)}H${SPINNER[0]} ${words().loading}`);
  if (output.isTTY) {
    const fitted = fitTerminal(info.cols, info.rows, 1000, 1000);
    const scale = Math.min((output.columns || 120) / fitted.width, ((output.rows || 40) - 1) / fitted.height);
    output.write(`\x1b[8;${Math.round(fitted.height * scale) + 1};${Math.round(fitted.width * scale)}t`);
  }
  const look = {
    mode: Math.max(0, MODES.indexOf(options.mode ?? 'braille')),
    glyphs: Math.max(0, GLYPH_SETS.findIndex(([, set]) => set === (options.glyphs ?? DEFAULT_GLYPHS))),
    tint: Math.max(0, TINTS.findIndex(([, tint]) => tint === (options.tint ?? null))),
    boost: options.boost ?? 1.3,
    fill: Math.max(0, FILLS.indexOf(options.fill ?? 0.25)),
    sharp: true,
    smooth: true,
  };
  let previous: Uint8ClampedArray | null = null;
  let redraw = true;
  const captions = options.subtitles ?? library.subtitles;
  const cues = captions ? parseCaptions(captions) : [];
  let caption: string | null = null;
  // S turns subtitles on and off; they start on when the video has them
  let showSubtitles = true;
  const input$ = options.input ?? process.stdin;
  let base = 0;
  let startedAt = performance.now();
  let playing = true;
  let quit = false;
  let levels = NEUTRAL;
  const cache = new Map<number, Promise<DecodedChunk>>();
  let waiting = false;
  let syncing = 0;
  let starts = 0;
  const now = (): number => Math.min(total(), playing && !waiting && !syncing ? base + Math.max(0, performance.now() - startedAt) / 1000 : base);
  // the picture holds still until the sound has really started, then both run from the same moment
  const sound = (): void => {
    const wanted = now();
    base = wanted;
    const ticket = (starts += 1);
    syncing = ticket;
    void audio.start(wanted).then((actual) => {
      if (ticket !== starts) return;
      syncing = 0;
      if (!playing) return;
      base = actual;
      // ffplay needs a moment to open the sound device after it starts reading
      startedAt = performance.now() + (audio.live() ? 200 : 0);
    });
  };
  let settle: ReturnType<typeof setTimeout> | null = null;
  const jump = (seconds: number): void => {
    base = Math.max(0, Math.min(total(), seconds));
    startedAt = performance.now();
    audio.stop();
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      if (playing) sound();
    }, 250);
  };
  const toggle = (): void => {
    if (playing) {
      base = now();
      playing = false;
      audio.stop();
    } else {
      playing = true;
      startedAt = performance.now();
      sound();
    }
  };
  // compressed chunks for the next ~30 s are fetched ahead, so a slow connection pauses with "loading" instead of skipping
  const raw = new Map<number, Promise<Uint8Array>>();
  const arrived = new Set<number>();
  let inFlight = 0;
  const bytes = (piece: Piece): Promise<Uint8Array> => {
    let found = raw.get(piece.start);
    if (!found) {
      inFlight += 1;
      found = piece.load().finally(() => (inFlight -= 1));
      found.then(() => arrived.add(piece.start), () => {
        raw.delete(piece.start);
        arrived.delete(piece.start);
      });
      raw.set(piece.start, found);
    }
    return found;
  };
  const AHEAD = Math.max(4, Math.ceil(30 / Math.max(0.1, info.chunkFrames / info.fps)));
  const prefetch = (from: number): void => {
    const at = library.pieces.findIndex((item) => from >= item.start && from < item.start + item.frames);
    if (at < 0) return;
    for (let step = 0; step <= AHEAD && inFlight < 6; step += 1) {
      const piece = library.pieces[at + step];
      if (piece && !raw.has(piece.start)) void bytes(piece).catch(() => undefined);
    }
    const keep = new Set(library.pieces.slice(Math.max(0, at - 2), at + AHEAD + 2).map((item) => item.start));
    for (const key of raw.keys()) if (!keep.has(key)) {
      raw.delete(key);
      arrived.delete(key);
    }
  };
  /** True when the chunk at `from` and the two after it are downloaded (or the video ends sooner). */
  const buffered = (from: number): boolean => {
    const at = library.pieces.findIndex((item) => from >= item.start && from < item.start + item.frames);
    if (at < 0) return library.complete();
    return library.pieces.slice(at, at + 3).every((item) => arrived.has(item.start)) && (at + 3 <= library.pieces.length || library.complete() || arrived.has(library.pieces.at(-1)?.start ?? -1));
  };
  const frames = (piece: Piece): Promise<DecodedChunk> => {
    let pending = cache.get(piece.start);
    if (!pending) {
      pending = bytes(piece).then((data) => decodeChunkMotion(info, data));
      const key = piece.start;
      pending.catch(() => cache.delete(key));
      cache.set(piece.start, pending);
      for (const key of cache.keys()) if (Math.abs(key - piece.start) > info.chunkFrames * 2) cache.delete(key);
    }
    return pending;
  };
  let cellRatio = 2.25;
  let controls: { readonly from: number; readonly to: number; readonly act: (column: number) => void }[] = [];
  const keys = (data: Buffer): void => {
    const text = data.toString();
    const size = /\x1b\[6;(\d+);(\d+)t/.exec(text);
    if (size) {
      const ratio = Number(size[1]) / Number(size[2]);
      if (ratio > 1 && ratio < 4) cellRatio = ratio;
      output.write('\x1b[2J');
      redraw = true;
      return;
    }
    const click = /\x1b\[<(\d+);(\d+);(\d+)M/.exec(text);
    if (click) {
      const [, button, column, row] = click.map(Number);
      if (button !== 0) return;
      const hit = row === view.height + 1 && column !== undefined ? controls.find((control) => column >= control.from && column < control.to) : undefined;
      if (hit) hit.act(column ?? 0);
      else if (row !== undefined && row <= view.height) toggle();
      redraw = true;
      return;
    }
    if (text.startsWith('\x1b[<')) return;
    const arrow = /^\x1b[[O]([CD])$/.exec(text)?.[1];
    const key = arrow ? `\u001b[${arrow}` : (RUSSIAN[text.toLowerCase()] ?? text.toLowerCase());
    if (key === 'q' || key === '\u0003' || key === '\u001b') quit = true;
    else if (key === ' ' || key === 'k') toggle();
    else if (key === '\u001b[D') jump(now() - 5);
    else if (key === '\u001b[C') jump(now() + 5);
    else if (key === 'j') jump(now() - 10);
    else if (key === 'l') jump(now() + 10);
    else if (/^[0-9]$/.test(key)) jump((Number(key) / 10) * total());
    else if (key === 'm') look.mode = (look.mode + 1) % MODES.length;
    else if (key === 's' && cues.length) {
      showSubtitles = !showSubtitles;
      redraw = true;
    }
    else if (key === 'g') look.glyphs = (look.glyphs + 1) % GLYPH_SETS.length;
    else if (key === 'c') look.tint = (look.tint + 1) % TINTS.length;
    else if (key === '[') look.boost = Math.max(0, Math.round((look.boost - 0.1) * 10) / 10);
    else if (key === ']') look.boost = Math.min(2.5, Math.round((look.boost + 0.1) * 10) / 10);
    else if (key === 'b') look.fill = (look.fill + 1) % FILLS.length;
    else if (key === 'x') look.sharp = !look.sharp;
    else if (key === 'v') look.smooth = !look.smooth;
    redraw = true;
  };
  const interactive = Boolean(input$.isTTY);
  if (interactive) {
    input$.setRawMode(true);
    input$.resume();
    input$.on('data', keys);
    output.write('\x1b[?1000h\x1b[?1006h\x1b[16t');
  }
  sound();
  try {
    let shown = -1;
    let shownStatus = '';
    let shownLayout = '';
    let pictureLeft = 0;
    let pictureWidth = 0;
    let drawnWidth = view.width;
    let drawnHeight = view.height;
    while (!quit) {
      const time = now();
      const index = Math.min(Math.floor(time * info.fps), Math.max(0, Math.round(total() * info.fps) - 1));
      const half = look.smooth && time * info.fps - index >= 0.5 ? 1 : 0;
      const phase = index * 2 + half;
      const piece = library.pieces.find((item) => index >= item.start && index < item.start + item.frames);
      prefetch(index);
      if (playing && !waiting && piece && !arrived.has(piece.start)) {
        base = time;
        waiting = true;
        audio.stop();
        redraw = true;
      } else if (waiting && (!playing || buffered(index))) {
        waiting = false;
        startedAt = performance.now();
        if (playing) sound();
        redraw = true;
      }
      const line$ = showSubtitles ? (captionAt(cues, time)?.replace(/\s*\n\s*/g, ' ') ?? null) : null;
      if (line$ !== caption) {
        caption = line$;
        redraw = true;
      }
      if (piece && (phase !== shown || redraw)) {
        const decoded = await frames(piece).catch(() => null);
        const next = library.pieces.find((item) => item.start === piece.start + piece.frames);
        if (next) void frames(next).catch(() => undefined);
        let frame = decoded?.frames[index - piece.start];
        const masks = decoded?.detail?.[index - piece.start];
        const shades = decoded?.shades?.[index - piece.start];
        if (frame && half) {
          const following = index + 1 < piece.start + piece.frames ? decoded : next && cache.has(next.start) ? await frames(next).catch(() => null) : null;
          const at = index + 1 - (following === decoded ? piece.start : (next?.start ?? 0));
          const to = following?.frames[at];
          const motion = following?.motion[at];
          if (to && motion) frame = interpolate(frame, to, motion, info.cols, info.rows, 0.5);
        }
        if (frame) {
          if (phase !== shown) previous = steady(previous, frame);
          levels = ease(levels, autoLevels(previous ?? frame));
          const fitted = fitTerminal(info.cols, info.rows, view.width, view.height, cellRatio);
          const left = Math.ceil((view.width - fitted.width) / 2);
          const top = Math.floor((view.height - fitted.height) / 2);
          const layout = `${left},${top},${fitted.width},${fitted.height}`;
          if (layout !== shownLayout) {
            shownLayout = layout;
            output.write('\x1b[0m\x1b[2J');
            shownStatus = '';
          }
          pictureLeft = left;
          pictureWidth = fitted.width;
          const shown$ = previous ?? frame;
          const text = ansiFrame(look.sharp ? upscale2x(shown$, info.cols, info.rows) : shown$, info.cols * (look.sharp ? 2 : 1), info.rows * (look.sharp ? 2 : 1), 4, levels, {
            width: view.width,
            height: view.height,
            mode: MODES[look.mode] ?? 'braille',
            glyphs: GLYPH_SETS[look.glyphs]?.[1] ?? DEFAULT_GLYPHS,
            tint: TINTS[look.tint]?.[1] ?? null,
            boost: look.boost,
            fill: FILLS[look.fill] ?? 0,
            cellRatio,
            detail: masks ? { masks, cols: info.cols, rows: info.rows, pixels: shown$, ...(shades ? { shades } : {}) } : undefined,
          });
          if (!output.write(text.split('\n').map((line, row) => `\x1b[${top + row + 1};${left + 1}H${line}`).join(''))) await new Promise((resolve) => output.once('drain', resolve));
          if (caption) {
            const words = caption.slice(0, Math.max(10, fitted.width - 4));
            output.write(`\x1b[${top + fitted.height - 1};${left + 1 + Math.max(0, Math.floor((fitted.width - words.length - 2) / 2))}H\x1b[48;2;0;0;0m\x1b[38;2;255;246;200m ${words} \x1b[0m`);
          }
          shown = phase;
          redraw = false;
        }
      }
      const share = total() > 0 ? time / total() : 0;
      if (view.width !== drawnWidth || view.height !== drawnHeight) {
        drawnWidth = view.width;
        drawnHeight = view.height;
        redraw = true;
      }
      const span = pictureWidth >= 60 ? pictureWidth : view.width;
      const offset = pictureWidth >= 60 ? pictureLeft : 0;
      const pause: Segment = { text: playing ? '▌▌' : '▶ ', act: toggle };
      const time$ = ` ${clock(time)} / ${clock(total())}${waiting ? ` ${words().loading}…` : ''} `;
      const options$: Segment[] = [
        { text: words().modes[look.mode] ?? '', act: () => (look.mode = (look.mode + 1) % MODES.length) },
        { text: words().glyphs[look.glyphs] ?? '', act: () => (look.glyphs = (look.glyphs + 1) % GLYPH_SETS.length) },
        { text: words().tints[look.tint] ?? '', act: () => (look.tint = (look.tint + 1) % TINTS.length) },
        { text: `${words().sat} ${look.boost.toFixed(1)}`, act: () => (look.boost = BOOSTS[(BOOSTS.indexOf(look.boost) + 1) % BOOSTS.length] ?? 1.3) },
        { text: `${words().bg} ${FILLS[look.fill]}`, act: () => (look.fill = (look.fill + 1) % FILLS.length) },
        { text: words().sharp, on: look.sharp, act: () => (look.sharp = !look.sharp) },
        { text: words().smooth, on: look.smooth, act: () => (look.smooth = !look.smooth) },
        ...(cues.length ? [{ text: words().subs, on: showSubtitles, act: () => ((showSubtitles = !showSubtitles), (redraw = true)) }] : []),
        { text: '✕', act: () => (quit = true) },
      ];
      const widthOf = (segments: readonly Segment[]): number => segments.reduce((sum, segment) => sum + segment.text.length + 3, 0);
      while (options$.length > 1 && span - 3 - time$.length - widthOf(options$) < 10) options$.splice(options$.length - 2, 1);
      // two spare columns at the end: some terminals draw ✕ two cells wide and cut it at the edge
      const bar = Math.max(4, span - 3 - time$.length - widthOf(options$) - 3);
      const filled = Math.round(share * bar);
      const map: typeof controls = [];
      let column = offset + 1;
      const place = (width: number, act?: (at: number) => void): void => {
        if (act) map.push({ from: column, to: column + width, act });
        column += width;
      };
      let status = button(pause);
      place(pause.text.length + 2, () => toggle());
      status += time$;
      place(time$.length);
      const barFrom = column;
      status += `\x1b[38;2;240;160;75m${'━'.repeat(filled)}\x1b[38;2;60;66;76m${'━'.repeat(bar - filled)}\x1b[0m `;
      place(bar, (at) => jump(((at - barFrom + 0.5) / bar) * total()));
      place(1);
      for (const segment of options$) {
        status += `${button(segment)} `;
        place(segment.text.length + 2, segment.act);
        place(1);
      }
      controls = map;
      const line = status;
      if (line !== shownStatus || redraw) {
        shownStatus = line;
        if (!output.write(`\x1b[${view.height + 1};1H\x1b[0m\x1b[2K\x1b[${view.height + 1};${offset + 1}H${line}`)) await new Promise((resolve) => output.once('drain', resolve));
      }
      if (playing && time >= total() && library.complete()) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, 1000 / info.fps / 4)));
    }
  } finally {
    if (interactive) {
      input$.off('data', keys);
      output.write('\x1b[?1006l\x1b[?1000l');
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
  const rows = Math.max(1, Math.round(cols * (height / width) * 0.6));
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
      output.write(`\x1b[H${ansiFrame(frame, cols, rows, 3, levels, { mode: 'braille', fill: 0.25, ...options, width: view.width, height: view.height })}`);
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
