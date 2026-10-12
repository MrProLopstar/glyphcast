import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NEUTRAL } from '../src/levels.js';
import { decodeChunk, encodeMicroVideo, encodeVideo, probe, readHeader, serve, StreamReader } from '../src/node.js';

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

describe('terminal', () => {
  it('draws a frame as colored glyphs and scales it to fit', async () => {
    const { ansiFrame } = await import('../src/terminal.js');
    const pixels = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255]);
    const text = ansiFrame(pixels, 2, 2, 3, NEUTRAL);
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
