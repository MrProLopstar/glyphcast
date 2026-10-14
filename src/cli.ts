#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
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
    --shades              with --detail: also keep the color of the dark side of those cells, exact edges
                          between two strong colors; format version 4, 20-35% larger, needs glyphcast 0.25+
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
    Space pause   ←/→ 5 s   J/L 10 s   0-9 jump to 0%-90%   M render mode   G glyphs   S subtitles
    C colors   [ ] saturation   B background   Q quit; the status bar is clickable
  Sound plays through ffplay when it is installed.`,
  publish: `glyphcast publish <file.gcast | video.mp4> --title "Name" [options]

  Uploads to the gcast hub. Give it a video instead of a .gcast and it encodes one itself: 180 columns with
  details, sound and a poster, plus 120 and 240 columns for the quality menu (needs ffmpeg). Files over 95 MB go in parts; if the upload breaks, run the same
  command again and it continues from the last finished part.

  Options
    --title "Name"        title on the hub (required)
    --license own         own (default, reachable by link only), CC0, CC-BY, CC-BY-SA, CC-BY-NC,
                          public-domain; open licenses can be listed on the hub after review
    --image poster.jpg    poster
    --subtitles file.vtt  subtitles
    --variant file.gcast  the same video in another grid width, for the quality menu; repeatable
    --replace <id>        put a new file (for example a re-encode) into an existing video: same code, title,
                          views and votes; only with the hub key (GLYPHCAST_HUB_KEY)
    --source URL          link to the original (YouTube and so on), shown in the player

  GLYPHCAST_HUB_KEY gives admin rights (listing right away); without it uploads go to review.`,
  hub: `glyphcast hub [search]

  Opens the list of videos in the gcast hub: arrows choose, typing searches, Enter plays,
  Esc quits; the list comes back after each video. Outside a terminal it prints the list.`,
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
  // eslint-disable-next-line prefer-const
  let { positionals, values } = parseArgs({
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
      shades: { type: 'boolean' },
      poster: { type: 'boolean' },
      title: { type: 'string' },
      license: { type: 'string' },
      image: { type: 'string' },
      subtitles: { type: 'string' },
      source: { type: 'string' },
      variant: { type: 'string', multiple: true },
      replace: { type: 'string' },
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
  // eslint-disable-next-line prefer-const
  let [command, input] = positionals;
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
    if (!/\.gcast$/i.test(input)) {
      // a video goes in as is: encoded at 180 columns with details, sound and a poster, plus 120 and 240 columns
      // for the quality menu, all in a temporary folder that is removed afterwards
      const folder = mkdtempSync(join(tmpdir(), 'glyphcast-publish-'));
      process.once('exit', () => rmSync(folder, { recursive: true, force: true }));
      const main = join(folder, 'main.gcast');
      console.log(`${basename(input)}: encoding 180 columns with sound and a poster`);
      await encode(input, main, { cols: '180', detail: true, embed: true, poster: true, ...(values.start ? { start: values.start } : {}), ...(values.duration ? { duration: values.duration } : {}) });
      const variants: string[] = [];
      for (const cols of ['120', '240']) {
        const out = join(folder, `v${cols}.gcast`);
        console.log(`${basename(input)}: encoding ${cols} columns for the quality menu`);
        await encode(input, out, { cols, detail: true, ...(values.start ? { start: values.start } : {}), ...(values.duration ? { duration: values.duration } : {}) });
        variants.push(out);
      }
      values = { ...values, image: values.image ?? join(folder, 'main.jpg'), variant: [...(values.variant ?? []), ...variants] };
      input = main;
    }
    const auth: Record<string, string> = key ? { 'x-hub-key': key } : {};
    const { files } = await hub();
    const file = input as string;
    const license = values.license ?? 'own';
    const query = new URLSearchParams({ title: values.title ?? '', license, listed: license === 'own' ? '0' : '1' });
    if (values.source) query.set('source', values.source);
    const retry = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await run();
        } catch (error) {
          if (attempt >= 5 || (error instanceof Error && error.message.startsWith('The hub refused'))) throw error;
          console.log(`${what}: connection problem, retry ${attempt} of 4 in ${attempt * 5} s`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        }
      }
    };
    const call = (url: string, init: RequestInit = {}, what = basename(file)): Promise<Record<string, unknown>> =>
      retry(what, async () => {
        const response = await fetch(url, { method: 'POST', ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) return data;
        const message = `The hub refused ${what}: ${String(data['error'] ?? response.status)}`;
        throw response.status < 500 ? new Error(message) : new TypeError(message);
      });
    /** Sends a file straight to the Drive session the hub opened; a saved session continues where it stopped. */
    const deliver = async (path: string, extra: Record<string, string>): Promise<{ id: string; token: string }> => {
      const size = statSync(path).size;
      const saved = `${path}.upload.json`;
      let started: { id: string; token: string; upload: string; size: number } | null = null;
      try {
        const data = JSON.parse(readFileSync(saved, 'utf8')) as { id: string; token: string; upload: string; size: number };
        if (data.size === size) started = data;
      } catch {
        started = null;
      }
      let offset = 0;
      if (started) {
        const status = await fetch(started.upload, { method: 'PUT', headers: { 'content-range': `bytes */${size}` } }).catch(() => null);
        if (status && (status.ok || status.status === 308)) {
          offset = status.ok ? size : Number(/bytes=0-(\d+)/.exec(status.headers.get('range') ?? '')?.[1] ?? -1) + 1;
          console.log(`${basename(path)}: continuing an earlier upload from ${Math.round((offset / size) * 100)}%`);
        } else started = null;
      }
      if (!started) {
        const data = await call(`${files}/parts/start?${new URLSearchParams({ size: String(size), ...extra })}`, {}, basename(path));
        started = { id: String(data['id']), token: String(data['token'] ?? ''), upload: String(data['upload']), size };
        writeFileSync(saved, JSON.stringify(started));
      }
      const piece = 32 * 262144;
      const file = await open(path, 'r');
      let reported = -1;
      try {
        while (offset < size) {
          const length = Math.min(piece, size - offset);
          const bytes = new Uint8Array(length);
          await file.read(bytes, 0, length, offset);
          const from = offset;
          await retry(basename(path), async () => {
            const response = await fetch(started.upload, { method: 'PUT', body: bytes, headers: { 'content-range': `bytes ${from}-${from + length - 1}/${size}` } });
            if (response.status !== 308 && !response.ok) throw new TypeError(`Google Drive answered ${response.status}`);
          });
          offset += length;
          const share = Math.floor((offset / size) * 100);
          if (share !== reported && (share % 5 === 0 || offset === size)) {
            reported = share;
            console.log(`${basename(path)}: ${share}% uploaded`);
          }
        }
      } finally {
        await file.close();
      }
      return started;
    };
    const size = statSync(file).size;
    let entry: Record<string, unknown>;
    if (size <= 16 * 1048576 && !values.replace) entry = await call(`${files}/upload?${query}`, { body: readFileSync(file), headers: { 'content-type': 'application/octet-stream' } });
    else {
      // --replace <id> swaps the file of an existing video and keeps its code, title, views and votes
      const started = await deliver(file, values.replace ? { replace: values.replace } : {});
      if (started.token) auth['x-edit-token'] = started.token;
      entry = await call(`${files}/parts/${started.id}/finish?${query}`);
      rmSync(`${file}.upload.json`, { force: true });
    }
    if (entry['token']) auth['x-edit-token'] = String(entry['token']);
    const id = String(entry['id']);
    if (values.image) await call(`${files}/poster/${id}`, { body: readFileSync(values.image), headers: { 'content-type': 'image/jpeg' } }, basename(values.image));
    if (values.subtitles) await call(`${files}/subtitles/${id}`, { body: readFileSync(values.subtitles), headers: { 'content-type': 'text/vtt' } }, basename(values.subtitles));
    for (const extra of values.variant ?? []) {
      const started = await deliver(extra, { variant: id });
      const added = await call(`${files}/parts/${started.id}/finish`, {}, basename(extra));
      rmSync(`${extra}.upload.json`, { force: true });
      console.log(`${basename(extra)}: added as ${String(added['cols'])} columns`);
    }
    console.log(`${String(entry['title'])}: hub:${String(entry['listed'] ? entry['slug'] : id)}${entry['review'] ? ' (waits for review before the open list)' : ''}`);
    return;
  }
  if (command === 'hub') {
    const { videos } = await hub();
    const listed = videos.filter((video) => video.listed);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // an interactive list: arrows move, typing searches, Enter plays, the list comes back after the video
      let query = input ?? '';
      for (;;) {
        const chosen = await pickVideo(listed, query);
        if (!chosen) return;
        query = chosen.query;
        await playHub(chosen.video.id, values.ffmpeg);
      }
    }
    const text = (input ?? '').toLowerCase();
    const shown = listed.filter((video) => video.title.toLowerCase().includes(text));
    if (shown.length === 0) console.log(text ? `Nothing found for "${input}"` : 'The hub is empty');
    for (const video of shown) console.log(`${video.id}  ${clock(video.duration).padStart(8)}  ${video.title}`);
    if (shown.length > 0) console.log('\nglc play hub:<id>');
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
      await playHub(input.slice(4), values.ffmpeg);
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
  const base = (process.env['GLYPHCAST_HUB'] ?? 'https://glc-hub.1lop.ru').replace(/\/$/, '');
  const config = await fetch(`${base}/hub.json`);
  if (!config.ok) throw new Error(`The hub at ${base} does not answer`);
  const files = ((await config.json()) as { files: string }).files.replace(/\/$/, '');
  const videos = await fetch(`${files}/videos`);
  if (!videos.ok) throw new Error(`The hub at ${files} does not answer`);
  return { files, videos: (await videos.json()) as HubVideo[] };
};

/** Plays a hub video in the terminal, picking the grid that suits the window. */
const playHub = async (name: string, ffmpeg?: string): Promise<void> => {
  const { files, videos } = await hub();
  const video = videos.find((item) => item.slug === name || item.id === name);
  const id = video?.id ?? name;
  if (!/^[\w-]{11}$/.test(id)) throw new Error(`No video "${name}" in the hub; see glyphcast hub`);
  const subtitles = video?.subtitles ? await fetch(`${files}/v/${id}.vtt`).then((response) => (response.ok ? response.text() : undefined)).catch(() => undefined) : undefined;
  const width = process.stdout.columns || 120;
  const grids = [video?.cols ?? 0, ...(video?.variants ?? [])].filter((cols) => cols > 0).sort((a, b) => a - b);
  const pick = grids.filter((cols) => cols <= width * 1.5).at(-1) ?? grids[0];
  const file = video && pick && pick !== video.cols ? `${id}-${pick}` : id;
  await playInTerminal(`${files}/v/${file}.gcast`, { title: video?.title ?? `hub:${name}`, ...(subtitles ? { subtitles } : {}), ...(ffmpeg ? { ffmpeg } : {}) });
};

/** Columns a string takes in a terminal: CJK and emoji take two. */
const cells = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
const fit = (text: string, width: number): string => {
  let out = '';
  for (const char of text) {
    if (cells(out + char) > width - 1) return `${out}…`;
    out += char;
  }
  return out + ' '.repeat(Math.max(0, width - cells(out)));
};

/** The hub list as a menu: ↑/↓ move, typing filters, Backspace edits, Enter picks, Esc quits. */
const pickVideo = (videos: readonly HubVideo[], start: string): Promise<{ video: HubVideo; query: string } | null> =>
  new Promise((resolve) => {
    const output = process.stdout;
    const input = process.stdin;
    let query = start;
    let at = 0;
    let top = 0;
    const found = () => videos.filter((video) => video.title.toLowerCase().includes(query.toLowerCase()));
    const draw = () => {
      const list = found();
      const width = output.columns || 100;
      const height = Math.max(3, (output.rows || 30) - 4);
      at = Math.min(at, Math.max(0, list.length - 1));
      if (at < top) top = at;
      if (at >= top + height) top = at - height + 1;
      let screen = '\x1b[H\x1b[2J';
      screen += `\x1b[1m\x1b[38;2;240;160;75mgcast hub\x1b[0m   \x1b[2m↑↓ выбор · Enter смотреть · Esc выход · печатайте для поиска\x1b[0m\n`;
      screen += `\x1b[38;2;154;160;168mПоиск:\x1b[0m ${query}\x1b[7m \x1b[0m\n\n`;
      if (!list.length) screen += '\x1b[2mНичего не нашлось\x1b[0m\n';
      const titleWidth = Math.max(20, width - 14);
      list.slice(top, top + height).forEach((video, index) => {
        const line = ` ${fit(video.title, titleWidth)}${clock(video.duration).padStart(9)} `;
        screen += top + index === at ? `\x1b[48;2;240;160;75m\x1b[38;2;26;18;6m${line}\x1b[0m\n` : `${line}\n`;
      });
      output.write(screen);
    };
    const finish = (value: { video: HubVideo; query: string } | null) => {
      input.off('data', key);
      output.off('resize', draw);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve(value);
    };
    const key = (data: Buffer) => {
      const text = data.toString();
      const list = found();
      if (text === '\u0003' || text === '\u001b') return finish(null);
      if (text === '\r' || text === '\n') return list[at] ? finish({ video: list[at]!, query }) : undefined;
      if (text === '\u001b[A') at = Math.max(0, at - 1);
      else if (text === '\u001b[B') at = Math.min(list.length - 1, at + 1);
      else if (text === '\u001b[5~') at = Math.max(0, at - 10);
      else if (text === '\u001b[6~') at = Math.min(list.length - 1, at + 10);
      else if (text === '\u007f' || text === '\b') query = [...query].slice(0, -1).join('');
      else if (!text.startsWith('\u001b') && text >= ' ') {
        query += text;
        at = 0;
      }
      draw();
    };
    output.write('\x1b[?1049h\x1b[?25l');
    input.setRawMode(true);
    input.resume();
    input.on('data', key);
    output.on('resize', draw);
    draw();
  });

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const encode = async (input: string, out: string, values: { readonly cols?: string; readonly fps?: string; readonly chunk?: string; readonly threshold?: string; readonly embed?: boolean; readonly 'no-crop'?: boolean; readonly detail?: boolean; readonly shades?: boolean; readonly poster?: boolean; readonly audio?: string; readonly start?: string; readonly duration?: string }): Promise<void> => {
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
    ...(values.shades ? { shades: true } : {}),
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
  // fetch hides the network reason in cause
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  console.error(error instanceof Error ? `${error.message}${cause}` : error);
  process.exitCode = 1;
});
