import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NEUTRAL } from '../src/levels.js';
import { decodeChunk, detectBars, encodeMicroVideo, encodeVideo, probe, readHeader, serve, StreamReader } from '../src/node.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'glyphcast-'));
const clip = join(dir, 'clip.mp4');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(hasFfmpeg)('ffmpeg encoders', () => {
  it('encodes a clip into a playable stream', async () => {
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
    expect(await probe(clip)).toMatchObject({ width: 320, height: 180 });
    const bytes = await encodeVideo(clip, { cols: 64, fps: 10, chunkSeconds: 1 });
    const header = readHeader(bytes);
    expect(header).toMatchObject({ cols: 64, rows: 22, fps: 10, frameCount: 20, chunkFrames: 10 });
    const first = new StreamReader().push(bytes)[0];
    if (!first) throw new Error('no chunks');
    const frames = await decodeChunk(header, first.data);
    expect(frames).toHaveLength(10);
    expect(frames[0]?.some((value, index) => index % 4 !== 3 && value > 100)).toBe(true);
  });

  it('writes a micro video at grid size with square pixels', async () => {
    const out = join(dir, 'micro.mp4');
    expect(await encodeMicroVideo(clip, out, { cols: 64, audio: false })).toEqual({ cols: 64, rows: 22 });
    expect(await probe(out)).toMatchObject({ width: 64, height: 22 });
  });

  it('serves live streams, audio, info and files from a folder', async () => {
    const server = await serve({ port: 0, dir, youtube: false });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      expect(await (await fetch(`${base}/info?file=clip.mp4`)).json()).toMatchObject({ title: 'clip.mp4', duration: 2 });
      const reader = new StreamReader();
      const chunks = reader.push(new Uint8Array(await (await fetch(`${base}/stream?file=clip.mp4&cols=32&fps=10&start=1`)).arrayBuffer()));
      expect(reader.info).toMatchObject({ cols: 32, rows: 11, fps: 10, frameCount: 10 });
      expect(chunks.reduce((sum, chunk) => sum + chunk.frames, 0)).toBe(10);
      const range = await fetch(`${base}/files/clip.mp4`, { headers: { range: 'bytes=0-9' } });
      expect(range.status).toBe(206);
      expect((await range.arrayBuffer()).byteLength).toBe(10);
      expect((await fetch(`${base}/files/..%2Fsecret`)).status).toBe(400);
      expect((await fetch(`${base}/stream?url=https://youtu.be/x`)).status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe.runIf(hasFfmpeg)('black bars', () => {
  it('cuts bars that stay black through the whole video', async () => {
    const boxed = join(dir, 'boxed.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x136:r=25', '-t', '1', '-vf', 'pad=320:180:0:22:black', '-pix_fmt', 'yuv420p', boxed]);
    expect(await detectBars(boxed, 320, 180)).toMatchObject({ width: 320, height: 136, x: 0 });
    expect(readHeader(await encodeVideo(boxed, { cols: 64, fps: 5 })).rows).toBe(16);
  });
});

describe('terminal', () => {
  it('draws a frame as colored glyphs and scales it to fit', async () => {
    const { ansiFrame } = await import('../src/terminal.js');
    const pixels = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255]);
    const text = ansiFrame(pixels, 2, 2, 3, NEUTRAL, { cellRatio: 2 });
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.split('\n')).toEqual([' @', expect.stringMatching(/^..$/)]);
    expect(text).toContain('\x1b[38;2;');
    expect([...ansiFrame(pixels, 2, 2, 3, NEUTRAL, { width: 1, height: 1 }).replace(/\x1b\[[0-9;]*m/g, '')]).toHaveLength(1);
    const braille = ansiFrame(pixels, 2, 2, 3, NEUTRAL, { mode: 'braille', fill: 0.25 });
    expect(braille).toMatch(/[⠀-⣿]/);
    expect(braille).toContain('\x1b[48;2;');
    expect(ansiFrame(pixels, 2, 2, 3, NEUTRAL, { mode: 'blocks' }).replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^▀+(\n▀+)*$/);
  });
});

describe('serve without ffmpeg', () => {
  it('answers 404, 416 and HEAD for served files, and rejects a busy port', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'tiny.gcast'), new Uint8Array(100));
    const server = await serve({ port: 0, dir, youtube: false });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}/files/`;
    try {
      expect((await fetch(`${base}missing.gcast`)).status).toBe(404);
      expect((await fetch(`${base}..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
      const past = await fetch(`${base}tiny.gcast`, { headers: { range: 'bytes=500-' } });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe('bytes */100');
      const head = await fetch(`${base}tiny.gcast`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe('100');
      const tail = await fetch(`${base}tiny.gcast`, { headers: { range: 'bytes=-10' } });
      expect((await tail.arrayBuffer()).byteLength).toBe(10);
      await expect(serve({ port: address.port })).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
