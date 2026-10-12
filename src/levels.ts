export interface Levels {
  readonly brightness: number;
  readonly contrast: number;
}

export const NEUTRAL: Levels = { brightness: 0, contrast: 1 };

/** Gamma that lifts dark tones when choosing glyphs and their brightness, so shadows keep detail. */
export const SHADOWS = 0.72;

/** Rec. 601 luma of an RGB triple in 0–255, as 0–1. */
export const luma = (r: number, g: number, b: number): number => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Picks brightness and contrast that stretch a frame's luma to a comfortable range: the mean moves towards 0.5 and
 * the spread towards a standard deviation of 0.22. Dark scenes get lifted, flat ones get more contrast.
 */
export const autoLevels = (pixels: ArrayLike<number>, stride = 4): Levels => {
  let sum = 0;
  let squares = 0;
  const count = Math.floor(pixels.length / stride);
  if (count === 0) return NEUTRAL;
  for (let index = 0; index < pixels.length; index += stride) {
    const value = luma(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0);
    sum += value;
    squares += value * value;
  }
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(squares / count - mean * mean, 0));
  const contrast = Math.min(Math.max(0.22 / Math.max(deviation, 0.02), 0.8), 2.2);
  const brightness = Math.min(Math.max((0.5 - mean) * 0.6, -0.25), 0.35);
  return { brightness, contrast };
};

/** Moves `current` a step towards `target`, so levels do not jump between cuts. */
export const ease = (current: Levels, target: Levels, amount = 0.15): Levels => ({
  brightness: current.brightness + (target.brightness - current.brightness) * amount,
  contrast: current.contrast + (target.contrast - current.contrast) * amount,
});

/** Index of the glyph for a luma after levels, as the shader computes it. */
export const glyphIndex = (value: number, levels: Levels, glyphs: number): number => {
  const adjusted = Math.min(Math.max((value - 0.5) * levels.contrast + 0.5 + levels.brightness, 0), 1) ** SHADOWS;
  return Math.min(glyphs - 1, Math.floor(adjusted * glyphs));
};
