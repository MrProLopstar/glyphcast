import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Encoder, GlyphcastError } from './format.js';

export interface ServeOptions {
  /** Port to listen on. Default 8787. */
  readonly port?: number;
  /** Interface to bind. Default `127.0.0.1`, so only this computer can use the server. */
  readonly host?: string;
  /** Folder with videos and `.gcast` files to serve; `?file=name` streams a video from it. Optional. */
  readonly dir?: string;
  /** Allow YouTube links through yt-dlp. Default true. */
  readonly youtube?: boolean;
  /** Path to yt-dlp. Default `yt-dlp` from PATH. */
  readonly ytDlp?: string;
  /** Path to ffmpeg. Default `ffmpeg` from PATH. */
  readonly ffmpeg?: string;
  /** Called for every request, for logging. */
  readonly onRequest?: (line: string) => void;
}

export interface VideoInfo {
  readonly title: string;
  readonly duration: number;
  readonly thumbnail: string | null;
  readonly uploader: string | null;
}

const YOUTUBE = /^https:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//;
const TYPES: Readonly<Record<string, string>> = { '.gcast': 'application/octet-stream', '.mp4': 'video/mp4', '.webm': 'video/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };

const capture = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', (error) => fail(new GlyphcastError(`Cannot run ${command}: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? done(out) : fail(new GlyphcastError(err.trim().split('\n').at(-1) ?? `${command} exited with ${String(code)}`))));
  });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const bounded = (value: string | null, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * A small server for glyph streaming. It turns YouTube links (through yt-dlp) and videos from a folder into
 * live `.gcast` streams with a separate Opus audio stream, so the browser receives glyph frames instead of video,
 * and serves ready `.gcast` files with range requests.
 *
 * Endpoints: `/info?url=`, `/stream?url=|file=&cols=&fps=&start=`, `/audio?url=|file=&start=`,
 * `/files/<name>`, `/health`. Needs ffmpeg, and yt-dlp for YouTube.
 */
export const serve = (options: ServeOptions = {}): Promise<Server> => {
  const ytDlp = options.ytDlp ?? 'yt-dlp';
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const dir = options.dir ? resolve(options.dir) : null;
  const cache = new Map<string, { readonly at: number; readonly video: string; readonly audio: string; readonly info: VideoInfo }>();

  const inside = (name: string): string => {
    if (!dir) throw new GlyphcastError('No folder is served; start the server with --dir');
    const path = resolve(dir, name);
    if (path !== dir && !path.startsWith(dir + sep)) throw new GlyphcastError('The file is outside the served folder');
    return path;
  };

  const youtube = async (url: string): Promise<{ readonly video: string; readonly audio: string; readonly info: VideoInfo }> => {
    if (options.youtube === false) throw new GlyphcastError('YouTube is disabled on this server');
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit;
    const data = JSON.parse(await capture(ytDlp, ['-j', '--no-playlist', '--no-warnings', '-f', 'bv*[height<=480][vcodec!*=av01]+ba/b[height<=480]/b', url])) as {
      title?: string; duration?: number; thumbnail?: string; uploader?: string; url?: string; requested_formats?: { url: string }[];
    };
    const [video, audio] = data.requested_formats?.map((format) => format.url) ?? [data.url ?? '', data.url ?? ''];
    if (!video) throw new GlyphcastError('yt-dlp found no playable stream');
    const entry = {
      at: Date.now(),
      video,
      audio: audio ?? video,
      info: { title: data.title ?? '', duration: Number(data.duration ?? 0), thumbnail: data.thumbnail ?? null, uploader: data.uploader ?? null },
    };
    cache.set(url, entry);
    return entry;
  };

  const media = async (url: URL): Promise<{ readonly video: string; readonly audio: string; readonly info: VideoInfo }> => {
    const link = url.searchParams.get('url');
    if (link) {
      if (!YOUTUBE.test(link)) throw new GlyphcastError('Only YouTube links are accepted in ?url=');
      return youtube(link);
    }
    const file = url.searchParams.get('file');
    if (!file) throw new GlyphcastError('Pass ?url= with a YouTube link or ?file= with a video from the served folder');
    const path = inside(file);
    const probe = JSON.parse(await capture(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path])) as { format?: { duration?: string } };
    return { video: path, audio: path, info: { title: file, duration: Number(probe.format?.duration ?? 0), thumbnail: null, uploader: null } };
  };

  const stream = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const source = await media(url);
    const cols = Math.round(bounded(url.searchParams.get('cols'), 160, 16, 480));
    const fps = bounded(url.searchParams.get('fps'), 30, 1, 60);
    const start = bounded(url.searchParams.get('start'), 0, 0, 1e6);
    const rows = Math.max(1, Math.round(cols * (9 / 16) * 0.6));
    const aspect = await capture(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', source.video]).catch(() => '');
    const [width, height] = aspect.trim().split(',').map(Number);
    const gridRows = width && height ? Math.max(1, Math.round(cols * (height / width) * 0.6)) : rows;
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-glyphcast-duration': String(source.info.duration) });
    const encoder = new Encoder({ cols, rows: gridRows, fps, chunkFrames: Math.max(1, Math.round(fps)), frameCount: source.info.duration ? Math.max(0, Math.round((source.info.duration - start) * fps)) : 0 }, (bytes) => response.write(bytes));
    const frameSize = cols * gridRows * 3;
    let pending: Buffer = Buffer.alloc(0);
    const child = spawn(ffmpeg, ['-v', 'error', '-ss', String(start), '-i', source.video, '-an', '-vf', `fps=${fps},scale=${cols}:${gridRows}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    request.on('close', () => child.kill('SIGKILL'));
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        encoder.add(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
      }
    });
    child.on('close', () => {
      void encoder.finish().then(() => response.end());
    });
  };

  const audio = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const source = await media(url);
    const start = bounded(url.searchParams.get('start'), 0, 0, 1e6);
    response.writeHead(200, { 'content-type': 'audio/webm', 'cache-control': 'no-store' });
    const child = spawn(ffmpeg, ['-v', 'error', '-ss', String(start), '-i', source.audio, '-vn', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(response);
    request.on('close', () => child.kill('SIGKILL'));
  };

  const file = (request: IncomingMessage, response: ServerResponse, name: string): void => {
    const path = inside(decodeURIComponent(name));
    const size = statSync(path).size;
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(path).pipe(response);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-private-network', 'true');
    response.setHeader('access-control-expose-headers', 'x-glyphcast-duration, content-length');
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-headers', '*');
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    options.onRequest?.(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/health') return json(response, 200, { ok: true, youtube: options.youtube !== false, files: Boolean(dir) });
    if (url.pathname === '/info') return json(response, 200, (await media(url)).info);
    if (url.pathname === '/stream') return stream(request, response, url);
    if (url.pathname === '/audio') return audio(request, response, url);
    if (url.pathname.startsWith('/files/')) return file(request, response, url.pathname.slice('/files/'.length));
    json(response, 404, { error: 'Unknown endpoint' });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, error instanceof GlyphcastError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });
  return new Promise((done) => server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => done(server)));
};
