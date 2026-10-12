const SIMILAR = 48;

/**
 * Doubles a frame with edge-directed scaling in the spirit of Scale2x: each cell becomes four, and a corner takes
 * a neighbour's color when two neighbours agree along an edge, so diagonals and contours come out sharp instead of
 * stepped or blurred. No detail is invented; edges are only placed where the frame already has them.
 */
export const upscale2x = (pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, stride = 4): Uint8ClampedArray => {
  const width = cols * 2;
  const out = new Uint8ClampedArray(width * rows * 2 * 4);
  const near = (a: number, b: number): boolean =>
    Math.abs((pixels[a] ?? 0) - (pixels[b] ?? 0)) + Math.abs((pixels[a + 1] ?? 0) - (pixels[b + 1] ?? 0)) + Math.abs((pixels[a + 2] ?? 0) - (pixels[b + 2] ?? 0)) < SIMILAR;
  const put = (x: number, y: number, from: number): void => {
    const at = (y * width + x) * 4;
    out[at] = pixels[from] ?? 0;
    out[at + 1] = pixels[from + 1] ?? 0;
    out[at + 2] = pixels[from + 2] ?? 0;
    out[at + 3] = 255;
  };
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const p = (y * cols + x) * stride;
      const a = (Math.max(0, y - 1) * cols + x) * stride;
      const d = (Math.min(rows - 1, y + 1) * cols + x) * stride;
      const c = (y * cols + Math.max(0, x - 1)) * stride;
      const b = (y * cols + Math.min(cols - 1, x + 1)) * stride;
      put(x * 2, y * 2, near(c, a) && !near(c, d) && !near(a, b) ? a : p);
      put(x * 2 + 1, y * 2, near(a, b) && !near(a, c) && !near(b, d) ? b : p);
      put(x * 2, y * 2 + 1, near(d, c) && !near(d, b) && !near(c, a) ? c : p);
      put(x * 2 + 1, y * 2 + 1, near(b, d) && !near(b, a) && !near(d, c) ? d : p);
    }
  }
  return out;
};
