#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamReader } from './format.js';
import { encodeMicroVideo, encodeVideo, extractAudio } from './node.js';
import { serve } from './serve.js';

const USAGE = `glyphcast: video as glyphs

  glyphcast encode <video> [--out file.gcast] [--cols 160] [--fps 30] [--audio file.opus] [--chunk 2]
  glyphcast micro <video> [--out file.mp4] [--cols 160] [--fps 30]
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
  if (command === 'info') {
    const reader = new StreamReader();
    const chunks = reader.push(readFileSync(input));
    const info = reader.info;
    if (!info) throw new Error('Not a .gcast file');
    const frames = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
    console.log(`${info.cols}×${info.rows} glyphs, ${info.fps} fps, ${frames} frames (${(frames / info.fps).toFixed(1)} s), ${chunks.length} chunks, ${kb(statSync(input).size)}`);
    return;
  }
  if (command === 'micro') {
    const out = values.out ?? `${basename(input, extname(input))}.glyphs.mp4`;
    const { cols, rows } = await encodeMicroVideo(input, out, { ...(values.cols ? { cols: Number(values.cols) } : {}), ...(values.fps ? { fps: Number(values.fps) } : {}) });
    console.log(`${out}: ${cols}×${rows}, ${kb(statSync(out).size)}; play it with GlyphVideo and prescaled: true`);
    return;
  }
  if (command !== 'encode') throw new Error(`Unknown command "${command}"`);
  const out = values.out ?? `${basename(input, extname(input))}.gcast`;
  const started = performance.now();
  const bytes = await encodeVideo(input, {
    ...(values.cols ? { cols: Number(values.cols) } : {}),
    ...(values.fps ? { fps: Number(values.fps) } : {}),
    ...(values.chunk ? { chunkSeconds: Number(values.chunk) } : {}),
  });
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
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
