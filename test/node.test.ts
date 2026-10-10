import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeChunk, encodeMicroVideo, encodeVideo, probe, readHeader } from '../src/node.js';

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
    const first = header.chunks[0];
    if (!first) throw new Error('no chunks');
    const frames = await decodeChunk(header, bytes.subarray(first.offset, first.offset + first.size));
    expect(frames).toHaveLength(10);
    expect(frames[0]?.some((value, index) => index % 4 !== 3 && value > 100)).toBe(true);
  });

  it('writes a micro video at grid size with square pixels', async () => {
    const out = join(dir, 'micro.mp4');
    expect(await encodeMicroVideo(clip, out, { cols: 64, audio: false })).toEqual({ cols: 64, rows: 22 });
    expect(await probe(out)).toMatchObject({ width: 64, height: 22 });
  });
});
