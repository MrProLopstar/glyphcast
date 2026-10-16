import { describe, expect, it } from 'vitest';
import { detailMasks, Encoder, readHeader, StreamReader, decodeChunkMotion } from '../src/format.js';
// @ts-expect-error plain JavaScript on purpose: it shares nothing with the library
import { decodeChunk } from './spec-decoder.mjs';

const picture = (cols: number, rows: number, frame: number): Uint8Array => {
  const pixels = new Uint8Array(cols * 2 * rows * 4 * 3);
  for (let y = 0; y < rows * 4; y += 1) {
    for (let x = 0; x < cols * 2; x += 1) {
      const at = (y * cols * 2 + x) * 3;
      const ring = Math.hypot(x - cols - frame, (y - rows * 2) * 0.6) % 9 < 3;
      const hash = Math.imul(((x + frame * 3) >> 3) * 73856093 ^ ((y + frame) >> 3) * 19349663, 2654435761) >>> 0;
      pixels[at] = ring ? 250 : hash & 255;
      pixels[at + 1] = ring ? 230 : (hash >> 8) & 127;
      pixels[at + 2] = ring ? 40 : (hash >> 16) & 255;
    }
  }
  return pixels;
};

describe('FORMAT.md', () => {
  for (const [cols, rows, options] of [
    [40, 17, { detail: true, shades: true }],
    [33, 9, { detail: true }],
    [27, 11, {}],
  ] as const) {
    it(`is enough to decode a ${cols}×${rows} stream ${JSON.stringify(options)} exactly like the library`, async () => {
      const encoder = new Encoder({ cols, rows, fps: 12, chunkFrames: 9, ...options });
      let bar: number | undefined;
      for (let frame = 0; frame < 20; frame += 1) {
        const found = detailMasks(picture(cols, rows, frame), cols, rows, 3, bar);
        bar = found.bar;
        if ('detail' in options) encoder.add(found.cells, found.masks, found.shades);
        else encoder.add(found.cells);
      }
      const bytes = await encoder.finish();
      const header = readHeader(bytes);
      for (const chunk of new StreamReader().push(bytes)) {
        if (!chunk.frames) continue;
        const library = await decodeChunkMotion(header, chunk.data);
        const mine = decodeChunk(header, chunk.data) as { rgb: Uint8ClampedArray; masks: Uint8Array; shades: Uint8Array | null }[];
        expect(mine.map((frame) => Array.from(frame.rgb))).toEqual(library.frames.map((frame) => Array.from(frame)));
        if (header.detail) expect(mine.map((frame) => Array.from(frame.masks))).toEqual(library.detail?.map((masks) => Array.from(masks)));
        if (header.shades) expect(mine.map((frame) => Array.from(frame.shades ?? []))).toEqual(library.shades?.map((shades) => Array.from(shades)));
      }
    });
  }
});
