#!/usr/bin/env node
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamReader } from './format.js';
import { encodeMicroVideo, encodeVideo, extractAudio, extractPoster } from './node.js';
import { serve } from './serve.js';
import { playInTerminal } from './terminal.js';

const HELP: Record<string, string> = {
  encode: `glyphcast encode <video...> [options]   (short: glc encode)

  Turns a video into a .gcast file: a grid of colored cells that players draw as glyphs.
  Needs ffmpeg and ffprobe in PATH.

  Picture
    --cols 160            grid width in cells; height follows the video. Several values, like
                          --cols 120,180, write <name>-120.gcast and <name>-180.gcast for quality switching
    --fps 24              frames per second
    --detail              stores a 2x4 dot pattern for cells with sharp edges: readable titles and
                          thin lines in braille, about 15% larger
    --threshold 3         how much a cell may change before it is sent again; higher is smaller and blockier
    --no-crop             keep black bars (by default bars that stay black the whole video are cut)

  Sound and extras
    --embed               put the sound inside the .gcast (Opus 40 kbit/s)
    --audio file.m4a      write the sound to a separate file instead
    --poster              save a frame as <name>.jpg for the player

  Piece of the video
    --start 1:02          start here (seconds, m:ss or h:mm:ss)
    --duration 30         encode only this long; handy for trying settings on a minute of a film

  Output
    --out file.gcast      file name (one video, one --cols value); by default <name>.gcast here
    --chunk 2             seconds per chunk; each chunk is a seek point

  Examples
    glc encode movie.mp4 --cols 180 --detail --embed --poster
    glc encode movie.mp4 --start 1:00 --duration 20 --detail --out test.gcast
    glc encode movie.mp4 --cols 120,180 --embed`,
  play: `glyphcast play <source> [options]

  Plays in the terminal with 24-bit color. Sources:
    file.gcast            a local file (large files with an index are read chunk by chunk)
    https://…/file.gcast  a file on a server, loaded with range requests
    video.mp4             any video, converted on the fly with ffmpeg
    hub:name              a video from the gcast hub (see glc hub)
    live:room             a live stream from the hub

  Options
    --cols 160            grid width for videos converted on the fly
    --subtitles file.vtt  show subtitles
    --ffmpeg path         ffmpeg to use

  Keys
    Space pause   ←/→ 5 s   J/L 10 s   0-9 jump to 0%-90%   M render mode   G glyphs
    C colors   [ ] saturation   B background   Q quit; the status bar is clickable
  Sound plays through ffplay when it is installed.`,
  publish: `glyphcast publish <file.gcast> --title "Name" [options]

  Uploads to the gcast hub. Files over 95 MB go in parts; if the upload breaks, run the same
  command again and it continues from the last finished part.

  Options
    --title "Name"        title on the hub (required)
    --license own         own (default, reachable by link only), CC0, CC-BY, CC-BY-SA, CC-BY-NC,
                          public-domain; open licenses can be listed on the hub after review
    --image poster.jpg    poster
    --subtitles file.vtt  subtitles
    --variant file.gcast  the same video in another grid width, for the quality menu; repeatable

  GLYPHCAST_HUB_KEY gives admin rights (listing right away); without it uploads go to review.`,
  hub: `glyphcast hub [search]

  Lists open videos in the gcast hub. Play one with glc play hub:<name>.`,
  info: `glyphcast info <file.gcast>

  Grid size, frame rate, length, chunks and embedded sound of a file.`,
  micro: `glyphcast micro <video> [--out file.mp4] [--cols 160] [--fps 24]

  Writes a tiny H.264 video at the grid size, for GlyphVideo with prescaled: true.`,
  serve: `glyphcast serve [--port 8787] [--host 127.0.0.1] [--dir videos] [--no-youtube] [--yt-dlp path] [--ffmpeg path]

  Serves live .gcast streams from YouTube links and videos in --dir for <glyph-player>.
  Needs yt-dlp and ffmpeg.`,
};

const USAGE = `glyphcast: video as glyphs   (glc is the short name)

  glc encode <video...>        make a .gcast from a video
  glc play <source>            play in the terminal: file, URL, video, hub:name, live:room
  glc hub [search]             list videos in the gcast hub
  glc publish <file.gcast>     upload to the hub
  glc info <file.gcast>        describe a file
  glc micro <video>            tiny H.264 for GlyphVideo
  glc serve                    live streams for <glyph-player>

  glc help <command> or glc <command> --help shows every option with examples.`;

const number = (name: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} needs a positive number, got "${value}"`);
  return parsed;
};

/** Seconds from "90", "1:30" or "1:02:03". */
const timeArg = (name: string, value: string): number => {
  const parts = value.split(':').map(Number);
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) throw new Error(`--${name} needs seconds, m:ss or h:mm:ss, got "${value}"`);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
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
      detail: { type: 'boolean' },
      poster: { type: 'boolean' },
      title: { type: 'string' },
      license: { type: 'string' },
      image: { type: 'string' },
      subtitles: { type: 'string' },
      variant: { type: 'string', multiple: true },
      audio: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      dir: { type: 'string' },
      'no-youtube': { type: 'boolean' },
      'yt-dlp': { type: 'string' },
      ffmpeg: { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, input] = positionals;
  if (command === 'help' || (values.help && command)) {
    const topic = command === 'help' ? input : command;
    console.log((topic && HELP[topic]) ?? USAGE);
    return;
  }
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
    if (!input || !values.title) throw new Error(HELP['publish']);
    const auth: Record<string, string> = key ? { 'x-hub-key': key } : {};
    const { files } = await hub();
    const license = values.license ?? 'own';
    const query = new URLSearchParams({ title: values.title, license, listed: license === 'own' ? '0' : '1' });
    const send = async (url: string, path: string, type: string): Promise<Record<string, unknown>> => {
      const response = await fetch(url, { method: 'POST', body: readFileSync(path), headers: { ...auth, 'content-type': type } });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(`The hub refused ${basename(path)}: ${String(data['error'] ?? response.status)}`);
      return data;
    };
    const size = statSync(input).size;
    let entry: Record<string, unknown>;
    if (size <= 95 * 1048576) entry = await send(`${files}/upload?${query}`, input, 'application/octet-stream');
    else {
      const call = async (url: string, body?: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown>> => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            const response = await fetch(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, ...(body ? { body } : {}) });
            const data = (await response.json()) as Record<string, unknown>;
            if (response.ok) return data;
            if (response.status < 500 || attempt >= 5) throw new Error(`The hub refused ${basename(input)}: ${String(data['error'] ?? response.status)}`);
          } catch (error) {
            if (attempt >= 5 || (error instanceof Error && error.message.startsWith('The hub refused'))) throw error;
          }
          console.log(`${basename(input)}: connection problem, retry ${attempt} of 4 in ${attempt * 5} s`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        }
      };
      // progress lives next to the file, so running the same command again continues the upload
      const saved = `${input}.upload.json`;
      const previous = (() => {
        try {
          const data = JSON.parse(readFileSync(saved, 'utf8')) as { id: string; part: number; size: number; done: number[] };
          return data.size === size ? data : null;
        } catch {
          return null;
        }
      })();
      const started: { id: string; part: number; size: number; done: number[] } = previous ?? { ...(await call(`${files}/parts/start`).then((data) => ({ id: String(data['id']), part: Number(data['part']) }))), size, done: [] as number[] };
      if (previous) console.log(`${basename(input)}: continuing an earlier upload, ${previous.done.length} parts already there`);
      const { id, part } = started;
      const sizes: number[] = [];
      const file = await open(input, 'r');
      try {
        for (let offset = 0, index = 0; offset < size; offset += part, index += 1) {
          const length = Math.min(part, size - offset);
          sizes.push(length);
          if (!started.done.includes(index)) {
            const bytes = new Uint8Array(length);
            await file.read(bytes, 0, length, offset);
            await call(`${files}/parts/${id}/${index}`, bytes);
            started.done.push(index);
            writeFileSync(saved, JSON.stringify(started));
          }
          console.log(`${basename(input)}: ${Math.round(((offset + length) / size) * 100)}% uploaded`);
        }
      } finally {
        await file.close();
      }
      query.set('sizes', sizes.join(','));
      entry = await call(`${files}/parts/${id}/finish?${query}`);
      rmSync(saved, { force: true });
    }
    if (values.image) await send(`${files}/poster/${String(entry['id'])}`, values.image, 'image/jpeg');
    if (values.subtitles) await send(`${files}/subtitles/${String(entry['id'])}`, values.subtitles, 'text/vtt');
    for (const extra of values.variant ?? []) {
      const added = await send(`${files}/variant/${String(entry['id'])}`, extra, 'application/octet-stream');
      console.log(`${basename(extra)}: added as ${String(added['cols'])} columns`);
    }
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
    console.log(command && HELP[command] ? HELP[command] : USAGE);
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
      const width = process.stdout.columns || 120;
      const grids = [video?.cols ?? 0, ...(video?.variants ?? [])].filter((cols) => cols > 0).sort((a, b) => a - b);
      const pick = grids.filter((cols) => cols <= width * 1.5).at(-1) ?? grids[0];
      const file = video && pick && pick !== video.cols ? `${id}-${pick}` : id;
      await playInTerminal(`${files}/v/${file}.gcast`, { title: video?.title ?? `hub:${name}`, ...(subtitles ? { subtitles } : {}), ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}) });
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
    const sound = chunks.filter((chunk) => chunk.frames === 0 && !chunk.subtitles).reduce((sum, chunk) => sum + chunk.data.length, 0);
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
  const grids = (values.cols ?? '').split(',').filter(Boolean);
  if (grids.length > 1 && values.out) throw new Error('--out works with one --cols value; several grids are saved as <name>-<cols>.gcast');
  for (const video of inputs) {
    if (grids.length > 1) for (const cols of grids) await encode(video, `${basename(video, extname(video))}-${cols}.gcast`, { ...values, cols, poster: values.poster === true && cols === grids.at(-1) });
    else await encode(video, values.out ?? `${basename(video, extname(video))}.gcast`, values);
  }
};

interface HubVideo {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly license: string;
  readonly listed: boolean;
  readonly duration: number;
  readonly subtitles?: boolean;
  readonly cols?: number;
  readonly variants?: readonly number[];
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

const encode = async (input: string, out: string, values: { readonly cols?: string; readonly fps?: string; readonly chunk?: string; readonly threshold?: string; readonly embed?: boolean; readonly 'no-crop'?: boolean; readonly detail?: boolean; readonly poster?: boolean; readonly audio?: string; readonly start?: string; readonly duration?: string }): Promise<void> => {
  const started = performance.now();
  const live = process.stdout.isTTY;
  let reported = 0;
  const bytes = await encodeVideo(input, {
    onProgress: (done, total) => {
      if (!total) return;
      const share = Math.min(1, done / total);
      const elapsed = (performance.now() - started) / 1000;
      const line = `${basename(input)}: ${(share * 100).toFixed(1)}% (${clock(done)} / ${clock(total)}), ${(done / elapsed).toFixed(1)}× real time, about ${clock((elapsed / share) * (1 - share))} left`;
      if (live) process.stdout.write(`\r${line}   `);
      else if (elapsed - reported >= 30) {
        // logs and background jobs get a full line every 30 s instead of a redrawn one
        reported = elapsed;
        console.log(line);
      }
    },
    ...(values.cols ? { cols: number('cols', values.cols) } : {}),
    ...(values.fps ? { fps: number('fps', values.fps) } : {}),
    ...(values.chunk ? { chunkSeconds: number('chunk', values.chunk) } : {}),
    ...(values.threshold ? { threshold: Number(values.threshold) } : {}),
    ...(values.embed ? { embedAudio: true } : {}),
    ...(values['no-crop'] ? { crop: false } : {}),
    ...(values.detail ? { detail: true } : {}),
    ...(values.start ? { start: timeArg('start', values.start) } : {}),
    ...(values.duration ? { duration: timeArg('duration', values.duration) } : {}),
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
