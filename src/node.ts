import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encoder, GlyphcastError } from './format.js';

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
  /** Called as frames are encoded with the seconds done and the total, for progress output. */
  readonly onProgress?: (done: number, total: number) => void;
}

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
  const { width, height, duration } = await probe(input, options.ffprobe);
  const rows = Math.max(1, Math.round(cols * (height / width) * (options.glyphAspect ?? 0.6)));
  let frames = 0;
  const encoder = new Encoder({ cols, rows, fps, chunkFrames: Math.max(1, Math.round(fps * (options.chunkSeconds ?? 2))), ...(options.threshold === undefined ? {} : { threshold: options.threshold }) });
  if (options.embedAudio && (await hasAudio(input, options.ffprobe))) {
    const temp = mkdtempSync(join(tmpdir(), 'glyphcast-'));
    try {
      await extractAudio(input, join(temp, 'audio.opus'), options.ffmpeg ? { ffmpeg: options.ffmpeg } : {});
      encoder.addAudio(readFileSync(join(temp, 'audio.opus')));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const frameSize = cols * rows * 3;
  let pending: Buffer = Buffer.alloc(0);
  await run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-i', input, '-an', '-vf', `fps=${fps},scale=${cols}:${rows}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      encoder.add(pending.subarray(0, frameSize));
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
export const extractAudio = (input: string, output: string, options: { readonly bitrate?: string; readonly ffmpeg?: string } = {}): Promise<string> =>
  run(options.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', ...(/\.(m4a|aac|mp4)$/i.test(output) ? ['-c:a', 'aac', '-movflags', '+faststart'] : ['-c:a', 'libopus']), '-ac', '2', '-b:a', options.bitrate ?? '64k', output]);

export { decodeChunk, Encoder, GlyphcastError, readHeader, StreamReader } from './format.js';
export { serve, type ServeOptions, type VideoInfo } from './serve.js';
export { ansiFrame, playInTerminal, type TerminalOptions } from './terminal.js';
