#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamReader } from './format.js';
import { encodeMicroVideo, encodeVideo, extractAudio, extractPoster } from './node.js';
import { serve } from './serve.js';
import { playInTerminal } from './terminal.js';

const USAGE = `glyphcast: video as glyphs

  glyphcast encode <video...> [--out file.gcast] [--cols 160] [--fps 24] [--threshold 3] [--embed | --audio file.m4a] [--poster] [--chunk 2]
      --embed puts Opus sound inside the .gcast, --audio writes it to a separate file,
      --poster saves a frame as <name>.jpg for the player; several videos are encoded one by one
  glyphcast micro <video> [--out file.mp4] [--cols 160] [--fps 24]
  glyphcast play <file.gcast | stream URL | video> [--cols width]
      plays in the terminal with 24-bit color glyphs
  glyphcast info <file.gcast>
  glyphcast serve [--port 8787] [--dir videos] [--no-youtube] [--yt-dlp path] [--ffmpeg path]
      live .gcast streams from YouTube links and videos in --dir, for <glyph-player>

encode and micro need ffmpeg and ffprobe, serve needs yt-dlp and ffmpeg.`;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      cols: { type: 'string' },
      fps: { type: 'string' },
      chunk: { type: 'string' },
      threshold: { type: 'string' },
      embed: { type: 'boolean' },
      poster: { type: 'boolean' },
      audio: { type: 'string' },
      port: { type: 'string' },
      dir: { type: 'string' },
      'no-youtube': { type: 'boolean' },
      'yt-dlp': { type: 'string' },
      ffmpeg: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, input] = positionals;
  const inputs = positionals.slice(1);
  if (command === 'serve') {
    const port = values.port ? Number(values.port) : 8787;
    await serve({ port, ...(values.dir ? { dir: values.dir } : {}), youtube: !values['no-youtube'], ...(values['yt-dlp'] ? { ytDlp: values['yt-dlp'] } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}), onRequest: (line) => console.log(line) });
    console.log(`glyphcast serve: http://127.0.0.1:${port}`);
    return;
  }
  if (values.help || !command || !input) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  if (command === 'play') {
    await playInTerminal(input, { ...(values.cols ? { cols: Number(values.cols) } : {}), ...(values.fps ? { fps: Number(values.fps) } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}) });
    return;
  }
  if (command === 'info') {
    const reader = new StreamReader();
    const chunks = reader.push(readFileSync(input));
    const info = reader.info;
    if (!info) throw new Error('Not a .gcast file');
    const frames = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
    const sound = chunks.filter((chunk) => chunk.frames === 0).reduce((sum, chunk) => sum + chunk.data.length, 0);
    console.log(`${info.cols}×${info.rows} glyphs, ${info.fps} fps, ${frames} frames (${(frames / info.fps).toFixed(1)} s), ${chunks.length} chunks, ${kb(statSync(input).size)}${sound ? `, audio ${kb(sound)} inside` : ''}`);
    return;
  }
  if (command === 'micro') {
    const out = values.out ?? `${basename(input, extname(input))}.glyphs.mp4`;
    const { cols, rows } = await encodeMicroVideo(input, out, { ...(values.cols ? { cols: Number(values.cols) } : {}), ...(values.fps ? { fps: Number(values.fps) } : {}) });
    console.log(`${out}: ${cols}×${rows}, ${kb(statSync(out).size)}; play it with GlyphVideo and prescaled: true`);
    return;
  }
  if (command !== 'encode') throw new Error(`Unknown command "${command}"`);
  if (values.out && inputs.length > 1) throw new Error('--out works with one video; several are saved next to the current folder by name');
  for (const video of inputs) await encode(video, values.out ?? `${basename(video, extname(video))}.gcast`, values);
};

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const encode = async (input: string, out: string, values: { readonly cols?: string; readonly fps?: string; readonly chunk?: string; readonly threshold?: string; readonly embed?: boolean; readonly poster?: boolean; readonly audio?: string }): Promise<void> => {
  const started = performance.now();
  const live = process.stdout.isTTY;
  const bytes = await encodeVideo(input, {
    onProgress: (done, total) => {
      if (!live || !total) return;
      const share = Math.min(1, done / total);
      const elapsed = (performance.now() - started) / 1000;
      process.stdout.write(`\r${basename(input)}: ${(share * 100).toFixed(1)}% (${clock(done)} / ${clock(total)}), ${(done / elapsed).toFixed(1)}× real time, about ${clock((elapsed / share) * (1 - share))} left   `);
    },
    ...(values.cols ? { cols: Number(values.cols) } : {}),
    ...(values.fps ? { fps: Number(values.fps) } : {}),
    ...(values.chunk ? { chunkSeconds: Number(values.chunk) } : {}),
    ...(values.threshold ? { threshold: Number(values.threshold) } : {}),
    ...(values.embed ? { embedAudio: true } : {}),
  });
  if (live) process.stdout.write('\r\x1b[K');
  writeFileSync(out, bytes);
  const reader = new StreamReader();
  reader.push(bytes);
  const header = reader.info;
  if (!header) throw new Error('Encoding produced no header');
  const seconds = header.frameCount / header.fps;
  console.log(`${out}: ${header.cols}×${header.rows}, ${header.frameCount} frames, ${kb(bytes.length)} (${((bytes.length * 8) / seconds / 1000).toFixed(0)} kbit/s) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  if (values.audio) {
    await extractAudio(input, values.audio);
    console.log(`${values.audio}: ${kb(statSync(values.audio).size)}`);
  }
  if (values.poster) {
    const image = out.replace(/\.gcast$/i, '') + '.jpg';
    await extractPoster(input, image);
    console.log(`${image}: ${kb(statSync(image).size)}, use it as poster="${basename(image)}"`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
