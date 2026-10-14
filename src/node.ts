import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detailMasks, Encoder, GlyphcastError } from './format.js';
import { constants, zstdCompress } from 'node:zlib';
import { promisify } from 'node:util';

// format version 5: zstd at level 19, about 10-16% smaller than deflate; players read it with a 10 KB decoder
const zstd19 = (data: Uint8Array): Promise<Uint8Array> => promisify(zstdCompress)(data, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });

export interface EncodeVideoOptions {
  /** Grid width in glyphs. Default 160. */
  readonly cols?: number;
  /** Frames per second in the stream. 15 looks deliberate and is a quarter smaller than 24. Default 24. */
  readonly fps?: number;
  /** Seconds per independently decodable chunk. Default 2. */
  readonly chunkSeconds?: number;
  /** Brightness steps (of 63) a cell may drift before it is resent. 2 is crisp, 4 is small. Default 3. */
  readonly threshold?: number;
  /** Glyph width divided by height, used to pick the row count. Default 0.6. */
  readonly glyphAspect?: number;
  /** Path to ffmpeg. Default `ffmpeg` from PATH. */
  readonly ffmpeg?: string;
  /** Path to ffprobe. Default `ffprobe` from PATH. */
  readonly ffprobe?: string;
  /** Embed the sound as Opus inside the stream (`encodeVideo` only). Default false. */
  readonly embedAudio?: boolean;
  /** Store a 2×4 dot pattern per cell from the source, so text and thin lines stay sharp in braille. Default false. */
  readonly detail?: boolean;
  /** With `detail`: also store the dark side color of patterned cells (format version 4, larger files). */
  readonly shades?: boolean;
  /** Embed the first text subtitle track of the video, if it has one. Default true. */
  readonly subtitles?: boolean;
  /** Cut black bars that stay black through the whole video. Default true. */
  readonly crop?: boolean;
  /** Called as frames are encoded with the seconds done and the total, for progress output. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Start of the piece to encode, in seconds. Default 0. */
  readonly start?: number;
  /** Length of the piece to encode, in seconds. Default to the end. */
  readonly duration?: number;
}

/** ffmpeg input arguments for a piece of the file: seek before the input, cut after it. */
const piece = (input: string, options: { readonly start?: number; readonly duration?: number }): string[] => [
  ...(options.start ? ['-ss', String(options.start)] : []),
  '-i',
  input,
  ...(options.duration ? ['-t', String(options.duration)] : []),
];

const run = (command: string, args: readonly string[], onData?: (chunk: Buffer) => void): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => (onData ? onData(chunk) : (text += chunk.toString())));
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    child.on('error', (error) => reject(new GlyphcastError(`Cannot run ${command}: ${error.message}. Install ffmpeg or pass its path`)));
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new GlyphcastError(`${command} exited with ${String(code)}: ${errors.trim().split('\n').slice(-3).join(' ')}`))));
  });

const hasAudio = async (input: string, ffprobe = 'ffprobe'): Promise<boolean> =>
  (await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input])).trim().length > 0;

/**
 * The area of a video that is not black bars in any key frame: bars are cut only where they stay black for the
 * whole video, so a film that switches between 4:3 and widescreen keeps its full width.
 */
export const detectBars = (input: string, width: number, height: number, ffmpeg = 'ffmpeg'): Promise<{ readonly width: number; readonly height: number; readonly x: number; readonly y: number }> =>
  new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-skip_frame', 'nokey', '-i', input, '-an', '-vf', 'cropdetect=limit=24:round=2:reset=1:skip=0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let left = width;
    let top = height;
    let right = 0;
    let bottom = 0;
    let found = false;
    let pending = '';
    child.stderr.on('data', (data: Buffer) => {
      pending += data.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(line);
        if (!match) continue;
        const [w, h, x, y] = match.slice(1).map(Number) as [number, number, number, number];
        if (w <= 0 || h <= 0) continue;
        found = true;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + w);
        bottom = Math.max(bottom, y + h);
      }
    });
    const full = { width, height, x: 0, y: 0 };
    child.on('error', () => resolve(full));
    child.on('close', () => {
      const area = { width: right - left, height: bottom - top, x: left, y: top };
      resolve(found && area.width > 0 && area.height > 0 && area.width * area.height < width * height * 0.97 ? area : full);
    });
  });

/** Width and height of the first video stream. */
export const probe = async (input: string, ffprobe = 'ffprobe'): Promise<{ readonly width: number; readonly height: number; readonly duration: number }> => {
  const output = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', input]);
  const data = JSON.parse(output) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
  const stream = data.streams?.[0];
  if (!stream?.width || !stream.height) throw new GlyphcastError(`${input} has no video stream`);
  return { width: stream.width, height: stream.height, duration: Number(data.format?.duration ?? 0) };
};

/**
 * Turns a video file into a `.gcast` stream with ffmpeg: frames are scaled to the glyph grid with area averaging,
 * delta-coded and compressed. Returns the bytes; write them anywhere.
 */
export const encodeVideo = async (input: string, options: EncodeVideoOptions = {}): Promise<Uint8Array> => {
  const cols = options.cols ?? 160;
  const fps = options.fps ?? 24;
  const probed = await probe(input, options.ffprobe);
  const duration = Math.max(0, Math.min(options.duration ?? Infinity, probed.duration - (options.start ?? 0)));
  const area = options.crop === false ? { width: probed.width, height: probed.height, x: 0, y: 0 } : await detectBars(input, probed.width, probed.height, options.ffmpeg);
  const { width, height } = area;
  const cropped = area.width !== probed.width || area.height !== probed.height ? `crop=${area.width}:${area.height}:${area.x}:${area.y},` : '';
  const rows = Math.max(1, Math.round(cols * (height / width) * (options.glyphAspect ?? 0.6)));
  let frames = 0;
  const encoder = new Encoder({ cols, rows, fps, chunkFrames: Math.max(1, Math.round(fps * (options.chunkSeconds ?? 2))), detail: options.detail ?? false, shades: options.shades ?? false, zstd: true, compress: zstd19, ...(options.threshold === undefined ? {} : { threshold: options.threshold }) });
  if (options.subtitles !== false) {
    const text = await run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', ...piece(input, options), '-map', '0:s:0', '-f', 'webvtt', 'pipe:1']).catch(() => '');
    if (text.includes('-->')) encoder.addSubtitles(text);
  }
  if (options.embedAudio && (await hasAudio(input, options.ffprobe))) {
    const temp = mkdtempSync(join(tmpdir(), 'glyphcast-'));
    try {
      await extractAudio(input, join(temp, 'audio.opus'), options);
      encoder.addAudio(readFileSync(join(temp, 'audio.opus')));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const detail = options.detail ?? false;
  const frameSize = cols * rows * 3 * (detail ? 8 : 1);
  const scale = detail ? `${cols * 2}:${rows * 4}` : `${cols}:${rows}`;
  let pending: Buffer = Buffer.alloc(0);
  let bar: number | undefined;
  await run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', ...piece(input, options), '-an', '-vf', `${cropped}fps=${fps},scale=${scale}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      if (detail) {
        const { cells, masks, shades, bar: next } = detailMasks(pending.subarray(0, frameSize), cols, rows, 3, bar);
        bar = next;
        encoder.add(cells, masks, shades);
      } else encoder.add(pending.subarray(0, frameSize));
      pending = pending.subarray(frameSize);
      frames += 1;
      if (frames % fps === 0) options.onProgress?.(frames / fps, duration);
    }
  });
  return encoder.finish();
};

/**
 * Writes a tiny H.264 video at the glyph grid size, for example 160×90 squeezed to 160×54. Video codecs compress
 * this better than any glyph format, so it is the cheapest way to ship footage for `GlyphVideo` with `prescaled: true`.
 * Audio is kept as AAC unless `audio: false`.
 */
export const encodeMicroVideo = async (input: string, output: string, options: EncodeVideoOptions & { readonly crf?: number; readonly audio?: boolean } = {}): Promise<{ readonly cols: number; readonly rows: number }> => {
  const cols = options.cols ?? 160;
  const { width, height } = await probe(input, options.ffprobe);
  const rows = Math.max(2, Math.round((cols * (height / width) * (options.glyphAspect ?? 0.6)) / 2) * 2);
  const even = cols % 2 === 0 ? cols : cols + 1;
  const audio = options.audio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '64k'];
  await run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', `fps=${options.fps ?? 24},scale=${even}:${rows}:flags=area,setsar=1`, '-c:v', 'libx264', '-crf', String(options.crf ?? 23), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...audio, output]);
  return { cols: even, rows };
};

/** Saves one frame as an image for the player's `poster`, by default from a tenth into the video. */
export const extractPoster = async (input: string, output: string, options: { readonly at?: number; readonly width?: number; readonly ffmpeg?: string; readonly ffprobe?: string } = {}): Promise<string> => {
  const at = options.at ?? (await probe(input, options.ffprobe)).duration * 0.1;
  return run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', `scale=${options.width ?? 960}:-2`, output]);
};

/** Extracts the audio track for a stream: AAC for `.m4a`, which every browser plays, or Opus for `.opus` and `.ogg`. */
export const extractAudio = (input: string, output: string, options: { readonly bitrate?: string; readonly ffmpeg?: string; readonly start?: number; readonly duration?: number } = {}): Promise<string> =>
  run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', ...piece(input, options), '-vn', ...(/\.(m4a|aac|mp4)$/i.test(output) ? ['-c:a', 'aac', '-movflags', '+faststart'] : ['-c:a', 'libopus']), '-ac', '2', '-b:a', options.bitrate ?? '40k', output]);

export { decodeChunk, Encoder, GlyphcastError, readHeader, StreamReader } from './format.js';
export { serve, type ServeOptions, type VideoInfo } from './serve.js';
export { ansiFrame, playInTerminal, type TerminalOptions } from './terminal.js';
