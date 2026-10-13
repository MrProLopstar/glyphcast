/**
 * Doubles a frame with edge-directed scaling: each cell becomes four. A corner whose two neighbours agree with each
 * other more than with the cell sits on an edge and takes their color, so diagonals and contours come out crisp;
 * elsewhere the corner is a smooth blend of the cell and its neighbours, so gradients stay soft. Similarity is
 * relative, which suits video, where neighbouring colors are rarely identical. No detail is invented.
 */
export const upscale2x = (pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, stride = 4): Uint8ClampedArray => {
  const width = cols * 2;
  const out = new Uint8ClampedArray(width * rows * 2 * 4);
  const distance = (a: number, b: number): number =>
    Math.abs((pixels[a] ?? 0) - (pixels[b] ?? 0)) * 2 + Math.abs((pixels[a + 1] ?? 0) - (pixels[b + 1] ?? 0)) * 3 + Math.abs((pixels[a + 2] ?? 0) - (pixels[b + 2] ?? 0));
  const at = (x: number, y: number): number => (Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))) * stride;
  const corner = (target: number, p: number, side: number, other: number, diagonal: number): void => {
    const across = distance(side, other);
    const edge = across * 2 < distance(side, p) && across * 2 < distance(other, p) && distance(side, p) > 60;
    for (let channel = 0; channel < 3; channel += 1) {
      const center = pixels[p + channel] ?? 0;
      const a = pixels[side + channel] ?? 0;
      const b = pixels[other + channel] ?? 0;
      out[target + channel] = edge ? center * 0.25 + (a + b) * 0.375 : (center * 9 + (a + b) * 3 + (pixels[diagonal + channel] ?? 0)) / 16;
    }
    out[target + 3] = 255;
  };
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const p = at(x, y);
      const up = at(x, y - 1);
      const down = at(x, y + 1);
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const top = (y * 2 * width + x * 2) * 4;
      const bottom = top + width * 4;
      corner(top, p, left, up, at(x - 1, y - 1));
      corner(top + 4, p, up, right, at(x + 1, y - 1));
      corner(bottom, p, down, left, at(x - 1, y + 1));
      corner(bottom + 4, p, right, down, at(x + 1, y + 1));
    }
  }
  return out;
};
