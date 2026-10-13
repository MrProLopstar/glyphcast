#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamReader } from './format.js';
import { encodeMicroVideo, encodeVideo, extractAudio, extractPoster } from './node.js';
import { serve } from './serve.js';
import { playInTerminal } from './terminal.js';

const USAGE = `glyphcast: video as glyphs

  glyphcast encode <video...> [--out file.gcast] [--cols 160] [--fps 24] [--threshold 3] [--embed | --audio file.m4a] [--poster] [--chunk 2]
      --embed puts Opus sound inside the .gcast, --audio writes it to a separate file,
      --poster saves a frame as <name>.jpg for the player; several videos are encoded one by one;
      black bars that stay black through the whole video are cut, --no-crop keeps them
  glyphcast micro <video> [--out file.mp4] [--cols 160] [--fps 24]
  glyphcast play <file.gcast | stream URL | video | hub:name | live:room> [--cols width] [--subtitles file.vtt]
      plays in the terminal; for .gcast: Space pause, ←/→ 5 s, J/L 10 s, 0-9 jump, M render mode, G glyphs,
      C colors, [ ] saturation, B background, Q quit; sound via ffplay
  glyphcast hub [search]
      lists open videos in the gcast hub; play them with glyphcast play hub:<name>
  glyphcast publish <file.gcast> --title "Name" [--license CC-BY] [--image poster.jpg] [--subtitles file.vtt]
      uploads to the gcast hub with the key from GLYPHCAST_HUB_KEY; licenses: CC0, CC-BY, CC-BY-SA,
      CC-BY-NC, public-domain list the video, own keeps it reachable by link only
  glyphcast info <file.gcast>
  glyphcast serve [--port 8787] [--host 127.0.0.1] [--dir videos] [--no-youtube] [--yt-dlp path] [--ffmpeg path]
      live .gcast streams from YouTube links and videos in --dir, for <glyph-player>

encode and micro need ffmpeg and ffprobe, serve needs yt-dlp and ffmpeg.`;

const number = (name: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} needs a positive number, got "${value}"`);
  return parsed;
};

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
      'no-crop': { type: 'boolean' },
      poster: { type: 'boolean' },
      title: { type: 'string' },
      license: { type: 'string' },
      image: { type: 'string' },
      subtitles: { type: 'string' },
      audio: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
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
    const port = values.port ? number('port', values.port) : 8787;
    const host = values.host ?? '127.0.0.1';
    await serve({ port, host, ...(values.dir ? { dir: values.dir } : {}), youtube: !values['no-youtube'], ...(values['yt-dlp'] ? { ytDlp: values['yt-dlp'] } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}), onRequest: (line) => console.log(line) });
    console.log(`glyphcast serve: http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    return;
  }
  if (command === 'publish') {
    const key = process.env['GLYPHCAST_HUB_KEY'];
    if (!input || !values.title || !key) throw new Error('Usage: GLYPHCAST_HUB_KEY=<key> glyphcast publish <file.gcast> --title "Name" [--license CC-BY] [--image poster.jpg]');
    const { files } = await hub();
    const license = values.license ?? 'own';
    const query = new URLSearchParams({ title: values.title, license, listed: license === 'own' ? '0' : '1' });
    const send = async (url: string, path: string, type: string): Promise<Record<string, unknown>> => {
      const response = await fetch(url, { method: 'POST', body: readFileSync(path), headers: { 'x-hub-key': key, 'content-type': type } });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(`The hub refused ${basename(path)}: ${String(data['error'] ?? response.status)}`);
      return data;
    };
    const size = statSync(input).size;
    let entry: Record<string, unknown>;
    if (size <= 95 * 1048576) entry = await send(`${files}/upload?${query}`, input, 'application/octet-stream');
    else {
      const call = async (url: string, body?: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown>> => {
        const response = await fetch(url, { method: 'POST', headers: { 'x-hub-key': key, 'content-type': 'application/octet-stream' }, ...(body ? { body } : {}) });
        const data = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new Error(`The hub refused ${basename(input)}: ${String(data['error'] ?? response.status)}`);
        return data;
      };
      const start = await call(`${files}/parts/start`);
      const id = String(start['id']);
      const part = Number(start['part']);
      const sizes: number[] = [];
      const file = await open(input, 'r');
      try {
        for (let offset = 0, index = 0; offset < size; offset += part, index += 1) {
          const bytes = new Uint8Array(Math.min(part, size - offset));
          await file.read(bytes, 0, bytes.length, offset);
          await call(`${files}/parts/${id}/${index}`, bytes);
          sizes.push(bytes.length);
          process.stdout.write(`\r${basename(input)}: ${Math.round(((offset + bytes.length) / size) * 100)}% uploaded   `);
        }
      } finally {
        await file.close();
      }
      process.stdout.write('\n');
      query.set('sizes', sizes.join(','));
      entry = await call(`${files}/parts/${id}/finish?${query}`);
    }
    if (values.image) await send(`${files}/poster/${String(entry['id'])}`, values.image, 'image/jpeg');
    if (values.subtitles) await send(`${files}/subtitles/${String(entry['id'])}`, values.subtitles, 'text/vtt');
    console.log(`${String(entry['title'])}: hub:${String(entry['listed'] ? entry['slug'] : entry['id'])}`);
    return;
  }
  if (command === 'hub') {
    const { files, videos } = await hub();
    const query = (input ?? '').toLowerCase();
    const shown = videos.filter((video) => video.listed && video.title.toLowerCase().includes(query));
    if (shown.length === 0) console.log(query ? `Nothing found for "${input}"` : 'The hub is empty');
    for (const video of shown) console.log(`hub:${video.slug.padEnd(32)} ${clock(video.duration).padStart(8)}  ${video.title}  [${video.license}]`);
    if (shown.length > 0) console.log(`
glyphcast play hub:<name>   files from ${files}`);
    return;
  }
  if (values.help || !command || !input) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  if (command === 'play') {
    if (input?.startsWith('live:')) {
      const { files } = await hub();
      await playInTerminal(`${files}/live/${encodeURIComponent(input.slice(5))}.gcast`, { title: input });
      return;
    }
    if (input?.startsWith('hub:')) {
      const name = input.slice(4);
      const { files, videos } = await hub();
      const video = videos.find((item) => item.slug === name || item.id === name);
      const id = video?.id ?? name;
      if (!/^[\w-]{11}$/.test(id)) throw new Error(`No video "${name}" in the hub; see glyphcast hub`);
      if (video) console.log(video.title);
      const subtitles = video?.subtitles ? await fetch(`${files}/v/${id}.vtt`).then((response) => (response.ok ? response.text() : undefined)).catch(() => undefined) : undefined;
      await playInTerminal(`${files}/v/${id}.gcast`, { title: video?.title ?? `hub:${name}`, ...(subtitles ? { subtitles } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}) });
      return;
    }
    await playInTerminal(input, { ...(values.subtitles ? { subtitles: readFileSync(values.subtitles, 'utf8') } : {}), ...(values.cols ? { cols: number('cols', values.cols) } : {}), ...(values.fps ? { fps: number('fps', values.fps) } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}) });
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
    const { cols, rows } = await encodeMicroVideo(input, out, { ...(values.cols ? { cols: number('cols', values.cols) } : {}), ...(values.fps ? { fps: number('fps', values.fps) } : {}) });
    console.log(`${out}: ${cols}×${rows}, ${kb(statSync(out).size)}; play it with GlyphVideo and prescaled: true`);
    return;
  }
  if (command !== 'encode') throw new Error(`Unknown command "${command}"`);
  if (values.out && inputs.length > 1) throw new Error('--out works with one video; several are saved next to the current folder by name');
  for (const video of inputs) await encode(video, values.out ?? `${basename(video, extname(video))}.gcast`, values);
};

interface HubVideo {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly license: string;
  readonly listed: boolean;
  readonly duration: number;
  readonly subtitles?: boolean;
}

const hub = async (): Promise<{ readonly files: string; readonly videos: HubVideo[] }> => {
  const base = (process.env['GLYPHCAST_HUB'] ?? 'https://mrprolopstar.github.io/gcast-hub').replace(/\/$/, '');
  const [config, videos] = await Promise.all([fetch(`${base}/hub.json`), fetch(`${base}/videos.json`)]);
  if (!config.ok || !videos.ok) throw new Error(`The hub at ${base} does not answer`);
  return { files: ((await config.json()) as { files: string }).files.replace(/\/$/, ''), videos: (await videos.json()) as HubVideo[] };
};

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const encode = async (input: string, out: string, values: { readonly cols?: string; readonly fps?: string; readonly chunk?: string; readonly threshold?: string; readonly embed?: boolean; readonly 'no-crop'?: boolean; readonly poster?: boolean; readonly audio?: string }): Promise<void> => {
  const started = performance.now();
  const live = process.stdout.isTTY;
  const bytes = await encodeVideo(input, {
    onProgress: (done, total) => {
      if (!live || !total) return;
      const share = Math.min(1, done / total);
      const elapsed = (performance.now() - started) / 1000;
      process.stdout.write(`\r${basename(input)}: ${(share * 100).toFixed(1)}% (${clock(done)} / ${clock(total)}), ${(done / elapsed).toFixed(1)}× real time, about ${clock((elapsed / share) * (1 - share))} left   `);
    },
    ...(values.cols ? { cols: number('cols', values.cols) } : {}),
    ...(values.fps ? { fps: number('fps', values.fps) } : {}),
    ...(values.chunk ? { chunkSeconds: number('chunk', values.chunk) } : {}),
    ...(values.threshold ? { threshold: Number(values.threshold) } : {}),
    ...(values.embed ? { embedAudio: true } : {}),
    ...(values['no-crop'] ? { crop: false } : {}),
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
