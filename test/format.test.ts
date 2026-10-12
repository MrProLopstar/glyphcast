import { describe, expect, it } from 'vitest';
import { audioType, decodeChunk, Encoder, GlyphcastError, INDEX_TRAILER, indexLength, readHeader, readIndex, StreamReader, type Chunk } from '../src/format.js';
import { captionAt, parseCaptions } from '../src/captions.js';
import { upscale2x } from '../src/upscale.js';
import { autoLevels, glyphIndex, luma, NEUTRAL } from '../src/levels.js';

const cols = 20;
const rows = 9;

const frame = (seed: number, shift = 0): Uint8Array => {
  const pixels = new Uint8Array(cols * rows * 3);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    const block = ((Math.floor(cell / cols) >> 1) * 7 + ((((cell % cols) + shift) % cols) >> 1)) * 13 + seed;
    pixels[cell * 3] = 40 + ((block * 37) % 180);
    pixels[cell * 3 + 1] = 40 + ((block * 53) % 180);
    pixels[cell * 3 + 2] = 40 + ((block * 71) % 180);
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
  it('round-trips frames within 6-bit brightness and 4:2:0 color precision', async () => {
    const encoder = new Encoder({ cols, rows, fps: 24, chunkFrames: 4, threshold: 0 });
    const source = Array.from({ length: 10 }, (_, index) => frame(index));
    source.forEach((pixels) => encoder.add(pixels));
    const bytes = await encoder.finish();
    const header = readHeader(bytes);
    expect(header).toMatchObject({ cols, rows, fps: 24, frameCount: 10, chunkFrames: 4, threshold: 0 });
    expect(split(bytes).map((chunk) => [chunk.start, chunk.frames])).toEqual([[0, 4], [4, 4], [8, 2]]);
    const frames = await decodeAll(bytes);
    expect(frames).toHaveLength(10);
    frames.forEach((decoded, index) => expect(close(decoded, source[index] ?? new Uint8Array(), 14)).toBe(true));
  });

  it('skips cells that barely change and keeps their previous color', async () => {
    const still = frame(1);
    const jitter = still.map((value) => Math.min(255, value + 2));
    const encoder = new Encoder({ cols, rows, fps: 30, chunkFrames: 30 });
    encoder.add(still);
    for (let index = 0; index < 29; index += 1) encoder.add(jitter);
    const bytes = await encoder.finish();
    const frames = await decodeAll(bytes);
    expect(close(frames[29] ?? new Uint8ClampedArray(), still, 24)).toBe(true);
    expect(bytes.length).toBeLessThan(400);
  });

  it('follows motion with block vectors instead of resending cells', async () => {
    const encode = async (shifts: number[]): Promise<Uint8Array> => {
      const encoder = new Encoder({ cols, rows, fps: 30, chunkFrames: 30, threshold: 0 });
      for (const shift of shifts) encoder.add(frame(0, shift));
      return encoder.finish();
    };
    const panning = await encode([0, 2, 4, 6, 8, 10]);
    const frames = await decodeAll(panning);
    expect(close(frames[5] ?? new Uint8ClampedArray(), frame(0, 10), 14)).toBe(true);
    const fresh = new Encoder({ cols, rows, fps: 30, chunkFrames: 30, threshold: 0 });
    for (let seed = 0; seed < 6; seed += 1) fresh.add(frame(seed * 5));
    expect(panning.length).toBeLessThan((await fresh.finish()).length * 0.7);
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
    expect(Math.abs((only?.[0] ?? 0) - 200)).toBeLessThanOrEqual(14);
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
    expect(glyphIndex(0.55, NEUTRAL, 10)).toBe(6);
    expect(glyphIndex(0.3, { brightness: 0.2, contrast: 1 }, 10)).toBe(6);
    expect(glyphIndex(0.1, NEUTRAL, 10)).toBe(1);
  });
});

describe('captions', () => {
  it('reads WebVTT and SRT cues and finds the active text', () => {
    const vtt = parseCaptions('WEBVTT\n\n00:01.000 --> 00:02.500 align:center\n<b>Hello</b>\nworld\n\n1:00:00.000 --> 1:00:01.000\nlate');
    expect(vtt).toEqual([{ start: 1, end: 2.5, text: 'Hello\nworld' }, { start: 3600, end: 3601, text: 'late' }]);
    const srt = parseCaptions('1\r\n00:00:03,200 --> 00:00:04,000\r\nПривет\r\n');
    expect(captionAt(srt, 3.5)).toBe('Привет');
    expect(captionAt(srt, 4)).toBeNull();
  });
});

describe('embedded audio', () => {
  it('stores audio before the frames and tells its type', async () => {
    const encoder = new Encoder({ cols, rows, fps: 10, chunkFrames: 2 });
    const sound = new Uint8Array(70000).fill(7);
    sound.set([0x4f, 0x67, 0x67, 0x53]);
    encoder.addAudio(sound);
    encoder.add(frame(0));
    const chunks = split(await encoder.finish());
    expect(chunks.map((chunk) => chunk.frames)).toEqual([0, 0, 1]);
    const late = new Encoder({ cols, rows, fps: 10, chunkFrames: 2 });
    late.add(frame(0));
    late.add(frame(1));
    late.addAudio(sound);
    const bytes = await late.finish();
    expect(split(bytes).map((chunk) => chunk.frames)).toEqual([0, 0, 2]);
    const length = indexLength(bytes.subarray(bytes.length - INDEX_TRAILER)) ?? 0;
    const [entry] = readIndex(bytes.subarray(bytes.length - length));
    expect(new StreamReader(readHeader(bytes), 0).push(bytes.subarray(entry?.offset ?? 0)).map((chunk) => chunk.frames)).toEqual([2]);
    expect(chunks.slice(0, 2).reduce((sum, chunk) => sum + chunk.data.length, 0)).toBe(70000);
    expect(audioType(chunks[0]?.data ?? new Uint8Array())).toBe('audio/ogg');
  });
});

describe('chunk index', () => {
  it('lets a reader start from any chunk found through the trailer', async () => {
    const encoder = new Encoder({ cols, rows, fps: 10, chunkFrames: 3 });
    for (let index = 0; index < 8; index += 1) encoder.add(frame(index));
    const bytes = await encoder.finish();
    const length = indexLength(bytes.subarray(bytes.length - INDEX_TRAILER));
    expect(length).toBeGreaterThan(0);
    const entries = readIndex(bytes.subarray(bytes.length - (length ?? 0)));
    expect(entries.map((entry) => [entry.start, entry.frames])).toEqual([[0, 3], [3, 3], [6, 2]]);
    expect(split(bytes).map((chunk) => chunk.frames)).toEqual([3, 3, 2]);
    const header = readHeader(bytes);
    const middle = new StreamReader(header, 3).push(bytes.subarray(entries[1]?.offset ?? 0));
    expect(middle.map((chunk) => [chunk.start, chunk.frames])).toEqual([[3, 3], [6, 2]]);
    const [whole] = split(bytes).slice(1);
    expect(await decodeChunk(header, middle[0]?.data ?? new Uint8Array())).toEqual(await decodeChunk(header, whole?.data ?? new Uint8Array()));
    expect(indexLength(new Uint8Array(8))).toBeNull();
  });
});

describe('upscale2x', () => {
  it('doubles the frame and keeps diagonal edges sharp', () => {
    const black = [0, 0, 0, 255];
    const white = [255, 255, 255, 255];
    const grid = [black, white, white, black, black, white, black, black, black].flat();
    const out = upscale2x(new Uint8Array(grid), 3, 3);
    expect(out.length).toBe(6 * 6 * 4);
    const at = (x: number, y: number): number => out[(y * 6 + x) * 4] ?? -1;
    expect(at(3, 2)).toBe(255);
    expect(at(2, 2)).toBe(0);
    expect(at(3, 3)).toBe(0);
    expect(at(1, 1)).toBe(0);
  });
});
