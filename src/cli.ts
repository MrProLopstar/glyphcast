#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { readHeader } from './format.js';
import { encodeMicroVideo, encodeVideo, extractAudio } from './node.js';

const USAGE = `glyphcast: video as glyphs

  glyphcast encode <video> [--out file.gcast] [--cols 160] [--fps 30] [--audio file.opus] [--chunk 2]
  glyphcast micro <video> [--out file.mp4] [--cols 160] [--fps 30]
  glyphcast info <file.gcast>

encode needs ffmpeg and ffprobe in PATH.`;

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
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, input] = positionals;
  if (values.help || !command || !input) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  if (command === 'info') {
    const header = readHeader(readFileSync(input));
    console.log(`${header.cols}×${header.rows} glyphs, ${header.fps} fps, ${header.frameCount} frames (${(header.frameCount / header.fps).toFixed(1)} s), ${header.chunks.length} chunks, ${kb(statSync(input).size)}`);
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
  const header = readHeader(bytes);
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
