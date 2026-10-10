import { describe, expect, it } from 'vitest';
import { decodeChunk, Encoder, GlyphcastError, readHeader, StreamReader, type Chunk } from '../src/format.js';
import { autoLevels, glyphIndex, luma, NEUTRAL } from '../src/levels.js';

const cols = 12;
const rows = 5;

const frame = (seed: number): Uint8Array => {
  const pixels = new Uint8Array(cols * rows * 3);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    pixels[cell * 3] = (cell * 37 + seed * 11) % 256;
    pixels[cell * 3 + 1] = (cell * 53 + seed * 7) % 256;
    pixels[cell * 3 + 2] = (cell * 71 + seed * 3) % 256;
  }
  return pixels;
};

const split = (bytes: Uint8Array): Chunk[] => new StreamReader().push(bytes);

const decodeAll = async (bytes: Uint8Array): Promise<Uint8ClampedArray[]> => {
  const header = readHeader(bytes);
  const frames: Uint8ClampedArray[] = [];
  for (const chunk of split(bytes)) frames.push(...(await decodeChunk(header, chunk.data)));
  return frames;
};

const close = (actual: Uint8ClampedArray, expected: Uint8Array, tolerance: number): boolean => {
  for (let cell = 0; cell < cols * rows; cell += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      if (Math.abs((actual[cell * 4 + channel] ?? 0) - (expected[cell * 3 + channel] ?? 0)) > tolerance) return false;
    }
    if (actual[cell * 4 + 3] !== 255) return false;
  }
  return true;
};

describe('.gcast format', () => {
  it('round-trips frames within 12-bit color precision', async () => {
    const encoder = new Encoder({ cols, rows, fps: 24, chunkFrames: 4, threshold: 0 });
    const source = Array.from({ length: 10 }, (_, index) => frame(index));
    source.forEach((pixels) => encoder.add(pixels));
    const bytes = await encoder.finish();
    const header = readHeader(bytes);
    expect(header).toMatchObject({ cols, rows, fps: 24, frameCount: 10, chunkFrames: 4 });
    expect(split(bytes).map((chunk) => [chunk.start, chunk.frames])).toEqual([[0, 4], [4, 4], [8, 2]]);
    const frames = await decodeAll(bytes);
    expect(frames).toHaveLength(10);
    frames.forEach((decoded, index) => expect(close(decoded, source[index] ?? new Uint8Array(), 15)).toBe(true));
  });

  it('skips cells that barely change and keeps their previous color', async () => {
    const still = frame(1);
    const jitter = still.map((value) => Math.min(255, value + 2));
    const encoder = new Encoder({ cols, rows, fps: 30, chunkFrames: 30 });
    encoder.add(still);
    for (let index = 0; index < 29; index += 1) encoder.add(jitter);
    const bytes = await encoder.finish();
    const frames = await decodeAll(bytes);
    expect(frames[29]).toEqual(frames[0]);
    expect(bytes.length).toBeLessThan(400);
  });

  it('accepts RGBA input and every chunk starts from a key frame', async () => {
    const rgba = new Uint8Array(cols * rows * 4).fill(200);
    const encoder = new Encoder({ cols, rows, fps: 10, chunkFrames: 2 });
    for (let index = 0; index < 5; index += 1) encoder.add(rgba);
    const bytes = await encoder.finish();
    const header = readHeader(bytes);
    const last = split(bytes)[2];
    if (!last) throw new Error('missing chunk');
    const [only] = await decodeChunk(header, last.data);
    expect(only?.[0]).toBe(204);
  });

  it('streams chunks as they are produced and reads them back from arbitrary slices', async () => {
    const live: Uint8Array[] = [];
    const encoder = new Encoder({ cols, rows, fps: 30, chunkFrames: 3 }, (bytes) => live.push(bytes));
    for (let index = 0; index < 7; index += 1) encoder.add(frame(index));
    await encoder.drain();
    expect(live.length).toBe(3);
    await encoder.finish();
    const joined = new Uint8Array(live.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of live) {
      joined.set(part, at);
      at += part.length;
    }
    expect(readHeader(joined).frameCount).toBe(0);
    const reader = new StreamReader();
    const got: Chunk[] = [];
    for (let offset = 0; offset < joined.length; offset += 7) got.push(...reader.push(joined.subarray(offset, offset + 7)));
    expect(got.map((chunk) => chunk.frames)).toEqual([3, 3, 1]);
  });

  it('rejects broken input', async () => {
    expect(() => new Encoder({ cols: 0, rows, fps: 30, chunkFrames: 1 })).toThrow(GlyphcastError);
    expect(() => new Encoder({ cols, rows, fps: 30, chunkFrames: 1 }).add(new Uint8Array(7))).toThrow(GlyphcastError);
    expect(() => readHeader(new Uint8Array(10))).toThrow(/Not enough bytes/);
    expect(() => readHeader(new Uint8Array(64))).toThrow(/Not a .gcast/);
    const bytes = await new Encoder({ cols, rows, fps: 30, chunkFrames: 5 }).finish();
    expect(readHeader(bytes).frameCount).toBe(0);
  });
});

describe('levels', () => {
  it('computes luma', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(1);
    expect(luma(0, 0, 0)).toBe(0);
  });

  it('lifts dark frames and stretches flat ones', () => {
    const dark = new Uint8Array(400).map((_, index) => (index % 4 === 3 ? 255 : 20 + (index % 7)));
    const levels = autoLevels(dark);
    expect(levels.brightness).toBeGreaterThan(0.1);
    expect(levels.contrast).toBeGreaterThan(1.5);
  });

  it('maps luma to glyphs across the whole ramp', () => {
    expect(glyphIndex(0, NEUTRAL, 10)).toBe(0);
    expect(glyphIndex(1, NEUTRAL, 10)).toBe(9);
    expect(glyphIndex(0.55, NEUTRAL, 10)).toBe(5);
    expect(glyphIndex(0.3, { brightness: 0.2, contrast: 1 }, 10)).toBe(5);
  });
});
