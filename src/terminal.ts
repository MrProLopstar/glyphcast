import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { decodeChunk, GlyphcastError, StreamReader, type Chunk } from './format.js';
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

const bytesOf = async function* (input: string): AsyncGenerator<Uint8Array> {
  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input);
    if (!response.ok || !response.body) throw new GlyphcastError(`Cannot load ${input}: HTTP ${response.status}`);
    const reader = response.body.getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) yield part.value;
    return;
  }
  yield* createReadStream(input) as AsyncIterable<Buffer>;
};

const playStream = async (input: string, options: TerminalOptions, output: NodeJS.WriteStream): Promise<void> => {
  const reader = new StreamReader();
  const chunks: Chunk[] = [];
  let done = false;
  const download = (async () => {
    for await (const bytes of bytesOf(input)) chunks.push(...reader.push(bytes));
    done = true;
  })();
  while (!reader.info || chunks.length === 0) {
    if (done) throw new GlyphcastError('The stream has no frames');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const info = reader.info;
  const view = screen(output);
  let levels = NEUTRAL;
  const decoded = { start: -1, frames: [] as Uint8ClampedArray[] };
  const started = performance.now();
  try {
    for (;;) {
      const index = Math.floor(((performance.now() - started) / 1000) * info.fps);
      const chunk = chunks.find((item) => index >= item.start && index < item.start + item.frames);
      if (!chunk) {
        if (done && index >= chunks.reduce((sum, item) => sum + item.frames, 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      if (decoded.start !== chunk.start) {
        decoded.frames = await decodeChunk(info, chunk.data);
        decoded.start = chunk.start;
      }
      const frame = decoded.frames[index - chunk.start];
      if (frame) {
        levels = ease(levels, autoLevels(frame));
        output.write(`\x1b[H${ansiFrame(frame, info.cols, info.rows, 4, levels, { ...options, width: view.width, height: view.height })}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, started + ((index + 1) * 1000) / info.fps - performance.now())));
    }
  } finally {
    view.close();
    await download.catch(() => undefined);
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
 * terminal with 24-bit color glyphs. Resolves when playback ends; Ctrl+C restores the screen.
 */
export const playInTerminal = (input: string, options: TerminalOptions = {}): Promise<void> => {
  const output = options.output ?? process.stdout;
  return /\.gcast(?:$|[?#])|\/stream\?/i.test(input) ? playStream(input, options, output) : playVideo(input, options, output);
};
