/**
 * Frame coding of `.gcast` version 6. Every syntax element goes through one adaptive binary range coder with
 * contexts, so the stream needs no general-purpose compressor and players decode it with a few hundred lines.
 *
 * A frame is the grid of cells: brightness Y (0–63) per cell, color U and V (0–31) per 2×2 cells, and for detail
 * streams a 2×4 dot mask per cell. The grid is cut into blocks of 8×4 cells. A block is either predicted from the
 * previous frame shifted by a motion vector in dots (half a cell across, a quarter of a cell down, with colors
 * interpolated between cells and masks shifted dot by dot) or predicted inside the frame from its left and top
 * neighbors. What the prediction misses is sent as quantized residuals. Encoder and decoder share the code below,
 * so they reconstruct exactly the same frames.
 */

/** Cells across and down a block. */
export const BLOCK_W = 8;
/** Cells down a block. */
export const BLOCK_H = 4;
/** Motion vectors are limited to this many dots either way. */
const RANGE = 64;
/** Rough bits of a residual or vector difference by its size, for the encoder's choices. */
const RATES = Float32Array.from({ length: 64 }, (_, size) => (size === 0 ? 0.15 : 2.5 + 1.5 * Math.log2(1 + size)));
/** Weight of what stays wrong on screen against bits, in the encoder's choice of motion. */
const DISTORTION = 1;
/** Dot bits that may differ between a block's predicted and real masks before the masks are sent. */
const MASK_TOLERANCE = 6;
/** Estimated bits per cell above which the encoder also tries vectors on a coarse grid, not only the neighbors'. */
const COARSE = 2;

/** A frame as planes: brightness per cell (0–63), color per 2×2 cells (0–31). */
export interface Planes {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** Sizes derived from a grid: cells, half-resolution color planes and blocks. */
export interface Shape {
  readonly cols: number;
  readonly rows: number;
  readonly halfCols: number;
  readonly halfRows: number;
  readonly blocksX: number;
  readonly blocks: number;
}

/** The sizes of a `cols × rows` grid. */
export const shapeOf = (cols: number, rows: number): Shape => {
  const blocksX = Math.ceil(cols / BLOCK_W);
  return { cols, rows, halfCols: Math.ceil(cols / 2), halfRows: Math.ceil(rows / 2), blocksX, blocks: blocksX * Math.ceil(rows / BLOCK_H) };
};

/** Planes filled with black, or with mid gray when `gray`. */
export const emptyPlanes = (shape: Shape, gray = false): Planes => ({
  y: new Uint8Array(shape.cols * shape.rows).fill(gray ? 32 : 0),
  u: new Uint8Array(shape.halfCols * shape.halfRows).fill(gray ? 16 : 0),
  v: new Uint8Array(shape.halfCols * shape.halfRows).fill(gray ? 16 : 0),
});

/** Cells to planes: 6-bit brightness per cell, 5-bit color per 2×2 cells. */
export const toPlanes = (pixels: Uint8Array | Uint8ClampedArray, stride: number, shape: Shape): Planes => {
  const out = emptyPlanes(shape);
  const u = new Float32Array(out.u.length);
  const v = new Float32Array(out.v.length);
  const weight = new Uint8Array(out.u.length);
  for (let row = 0; row < shape.rows; row += 1) {
    for (let col = 0; col < shape.cols; col += 1) {
      const cell = row * shape.cols + col;
      const r = pixels[cell * stride] ?? 0;
      const g = pixels[cell * stride + 1] ?? 0;
      const b = pixels[cell * stride + 2] ?? 0;
      out.y[cell] = Math.round(((0.299 * r + 0.587 * g + 0.114 * b) * 63) / 255);
      const half = (row >> 1) * shape.halfCols + (col >> 1);
      u[half] = (u[half] ?? 0) + (-0.168736 * r - 0.331264 * g + 0.5 * b);
      v[half] = (v[half] ?? 0) + (0.5 * r - 0.418688 * g - 0.081312 * b);
      weight[half] = (weight[half] ?? 0) + 1;
    }
  }
  for (let half = 0; half < out.u.length; half += 1) {
    const count = weight[half] || 1;
    out.u[half] = Math.min(31, Math.max(0, Math.round((u[half] ?? 0) / count / 8.2) + 16));
    out.v[half] = Math.min(31, Math.max(0, Math.round((v[half] ?? 0) / count / 8.2) + 16));
  }
  return out;
};

/** Planes to RGBA cells. */
export const toPixels = (frame: Planes, shape: Shape): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(shape.cols * shape.rows * 4);
  for (let row = 0; row < shape.rows; row += 1) {
    for (let col = 0; col < shape.cols; col += 1) {
      const cell = row * shape.cols + col;
      const half = (row >> 1) * shape.halfCols + (col >> 1);
      const y = ((frame.y[cell] ?? 0) * 255) / 63;
      const u = ((frame.u[half] ?? 0) - 16) * 8.2;
      const v = ((frame.v[half] ?? 0) - 16) * 8.2;
      out[cell * 4] = y + 1.402 * v;
      out[cell * 4 + 1] = y - 0.344136 * u - 0.714136 * v;
      out[cell * 4 + 2] = y + 1.772 * u;
      out[cell * 4 + 3] = 255;
    }
  }
  return out;
};

/**
 * The color players give the dark dots of a patterned cell without a stored one: the average of the neighbor
 * cells (left, right, top, bottom) darker than it, or half its own color.
 */
const darkGuess = (rgb: Uint8ClampedArray, shape: Shape, cell: number): [number, number, number] => {
  const luma = (at: number): number => (rgb[at * 4] ?? 0) * 0.299 + (rgb[at * 4 + 1] ?? 0) * 0.587 + (rgb[at * 4 + 2] ?? 0) * 0.114;
  const x = cell % shape.cols;
  const y = (cell - x) / shape.cols;
  const own = luma(cell);
  const sum = [0, 0, 0];
  let count = 0;
  for (const near of [x > 0 ? cell - 1 : -1, x < shape.cols - 1 ? cell + 1 : -1, y > 0 ? cell - shape.cols : -1, y < shape.rows - 1 ? cell + shape.cols : -1]) {
    if (near < 0 || luma(near) >= own - 10) continue;
    for (let channel = 0; channel < 3; channel += 1) sum[channel] = (sum[channel] ?? 0) + (rgb[near * 4 + channel] ?? 0);
    count += 1;
  }
  return [0, 1, 2].map((channel) => (count ? Math.floor((sum[channel] ?? 0) / count) : (rgb[cell * 4 + channel] ?? 0) >> 1)) as [number, number, number];
};

/** Quantizer step per plane: residuals within the tolerance become zero. */
export const stepsOf = (threshold: number): { readonly y: number; readonly u: number; readonly v: number } => {
  const chroma = Math.round(threshold / 3);
  return { y: threshold * 2 + 1, u: chroma * 2 + 1, v: chroma * 2 + 1 };
};

// ---- range coder (the LZMA one: 11-bit probabilities, carry propagation through a cached byte) ----

const TOP = 2 ** 24;
// every context keeps two estimates, one quick to follow changes and one steady, and codes with their average
const FAST = 4;
const SLOW = 7;

/** Chance of a zero in 1/2048 (1 to 2047), from the context's two estimates kept in 1/32768. */
const probability = (probs: Uint16Array, index: number): number => ((probs[index * 2] ?? 16384) + (probs[index * 2 + 1] ?? 16384)) >> 5 || 1;

const adapt = (probs: Uint16Array, index: number, bit: number): void => {
  const fast = probs[index * 2] ?? 16384;
  const slow = probs[index * 2 + 1] ?? 16384;
  probs[index * 2] = bit ? fast - (fast >> FAST) : fast + ((32768 - fast) >> FAST);
  probs[index * 2 + 1] = bit ? slow - (slow >> SLOW) : slow + ((32768 - slow) >> SLOW);
};

class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private pending = 1;
  private out = new Uint8Array(1 << 16);
  private length = 0;

  bit(probs: Uint16Array, index: number, bit: number): void {
    const bound = (this.range >>> 11) * probability(probs, index);
    if (bit) {
      this.low += bound;
      this.range -= bound;
    } else this.range = bound;
    adapt(probs, index, bit);
    while (this.range < TOP) {
      this.range *= 256;
      this.shift();
    }
  }

  direct(bit: number): void {
    this.range = this.range >>> 1;
    if (bit) this.low += this.range;
    while (this.range < TOP) {
      this.range *= 256;
      this.shift();
    }
  }

  private push(byte: number): void {
    if (this.length === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.length] = byte;
    this.length += 1;
  }

  private shift(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let byte = this.cache;
      do {
        this.push((byte + carry) & 0xff);
        byte = 0xff;
      } while (--this.pending !== 0);
      this.cache = Math.floor(this.low / TOP) & 0xff;
    }
    this.pending += 1;
    this.low = (this.low % TOP) * 256;
  }

  /** The coded bytes. The first byte of such a stream is always zero, so it is left out. */
  finish(): Uint8Array {
    for (let i = 0; i < 5; i += 1) this.shift();
    return this.out.slice(1, this.length);
  }
}

class RangeDecoder {
  private code = 0;
  private range = 0xffffffff;
  private at = 0;

  constructor(private readonly data: Uint8Array) {
    for (let i = 0; i < 4; i += 1) this.code = this.code * 256 + this.next();
  }

  private next(): number {
    const byte = this.data[this.at] ?? 0;
    this.at += 1;
    // the encoder's flush leaves at most a few bytes off the end; far past it the data is damaged
    if (this.at > this.data.length + 8) throw new Error('Truncated .gcast chunk');
    return byte;
  }

  bit(probs: Uint16Array, index: number): number {
    const bound = (this.range >>> 11) * probability(probs, index);
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      bit = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      bit = 1;
    }
    adapt(probs, index, bit);
    while (this.range < TOP) {
      this.range *= 256;
      this.code = this.code * 256 + this.next();
    }
    return bit;
  }

  direct(): number {
    this.range = this.range >>> 1;
    let bit = 0;
    if (this.code >= this.range) {
      this.code -= this.range;
      bit = 1;
    }
    while (this.range < TOP) {
      this.range *= 256;
      this.code = this.code * 256 + this.next();
    }
    return bit;
  }
}

// ---- contexts ----

/** A signed value: zero flag, sign, then the magnitude in unary over 16 contexts with an Exp-Golomb tail. */
const SIGNED = 18;
const C_FRAME = 0; // 2 × 16: the frame's quantizer thresholds
const C_INTRA = C_FRAME + 32; // 3: left and top blocks intra
const C_CBF = C_INTRA + 3; // 2 × 3: intra or not, left and top blocks with residuals
const C_MV = C_CBF + 6; // 2 × SIGNED: x and y
const C_RES = C_MV + 2 * SIGNED; // motion-predicted: 3 planes × 3 (coded neighbors) × patterned cell × SIGNED
const C_RES_INTRA = C_RES + 18 * SIGNED; // intra: 3 planes × 5 activity classes × patterned cell × SIGNED
const C_SKIP = C_RES_INTRA + 30 * SIGNED; // 3: masks taken from the prediction, by neighbors
const C_PATTERN = C_SKIP + 3; // 8: predicted cell patterned, left and top cells patterned
const C_DOT = C_PATTERN + 8; // 1024: three predicted dots, six decoded neighbor dots, predicted cell patterned
const C_DARK_FLAG = C_DOT + 1024; // 3
const C_DARK = C_DARK_FLAG + 3; // 3 channels × 8 classes of the guessed color × 64-node bit tree
const CONTEXTS = C_DARK + 3 * 8 * 64;

interface Bits {
  readonly encoding: boolean;
  bit(context: number, value: number): number;
  direct(value: number): number;
}

class EncodeBits implements Bits {
  readonly encoding = true;
  readonly probs = new Uint16Array(CONTEXTS * 2).fill(16384);
  readonly coder = new RangeEncoder();
  bit(context: number, value: number): number {
    this.coder.bit(this.probs, context, value);
    return value;
  }
  direct(value: number): number {
    this.coder.direct(value);
    return value;
  }
}

class DecodeBits implements Bits {
  readonly encoding = false;
  readonly probs = new Uint16Array(CONTEXTS * 2).fill(16384);
  readonly coder: RangeDecoder;
  constructor(data: Uint8Array) {
    this.coder = new RangeDecoder(data);
  }
  bit(context: number): number {
    return this.coder.bit(this.probs, context);
  }
  direct(): number {
    return this.coder.direct();
  }
}

const golomb = (bits: Bits, value: number): number => {
  if (bits.encoding) {
    let rest = value;
    let k = 0;
    while (rest >= 2 ** k) {
      bits.direct(1);
      rest -= 2 ** k;
      k += 1;
    }
    bits.direct(0);
    for (let i = k - 1; i >= 0; i -= 1) bits.direct((rest >> i) & 1);
    return value;
  }
  let k = 0;
  while (bits.direct(0)) {
    k += 1;
    if (k > 24) throw new Error('Damaged .gcast chunk');
  }
  let rest = 0;
  for (let i = 0; i < k; i += 1) rest = rest * 2 + bits.direct(0);
  return 2 ** k - 1 + rest;
};

const unsigned = (bits: Bits, group: number, value: number): number => {
  for (let i = 0; i < 16; i += 1) if (!bits.bit(group + i, value > i ? 1 : 0)) return i;
  return 16 + golomb(bits, value - 16);
};

const signed = (bits: Bits, group: number, value: number): number => {
  if (!bits.bit(group, value !== 0 ? 1 : 0)) return 0;
  const negative = bits.bit(group + 1, value < 0 ? 1 : 0);
  const size = unsigned(bits, group + 2, Math.abs(value) - 1) + 1;
  return negative ? -size : size;
};

// ---- prediction ----

const clamp = (value: number, max: number): number => (value < 0 ? 0 : value >= max ? max - 1 : value);

/**
 * Brightness of every dot of a frame, as players draw it: the lit dots of a patterned cell carry the cell's value,
 * its dark dots the average of the darker neighbor cells (or half the cell's value), flat cells fill all eight.
 */
const dotLuma = (y: Uint8Array, masks: Uint8Array, shape: Shape): Uint8Array => {
  const { cols, rows } = shape;
  const width = cols * 2;
  const out = new Uint8Array(width * rows * 4);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    const value = y[cell] ?? 0;
    const mask = masks[cell] ?? 0;
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    let dark = value;
    if (mask) {
      let sum = 0;
      let count = 0;
      const take = (near: number): void => {
        const other = y[near] ?? 0;
        if (other >= value - 3) return;
        sum += other;
        count += 1;
      };
      if (cx > 0) take(cell - 1);
      if (cx < cols - 1) take(cell + 1);
      if (cy > 0) take(cell - cols);
      if (cy < rows - 1) take(cell + cols);
      dark = count ? Math.floor((sum + (count >> 1)) / count) : value >> 1;
    }
    for (let dot = 0; dot < 8; dot += 1) out[(cy * 4 + (dot >> 1)) * width + cx * 2 + (dot & 1)] = !mask || (mask >> dot) & 1 ? value : dark;
  }
  return out;
};

/**
 * Y of a cell predicted from the previous frame's dots shifted by (dx, dy): the average of the dots that the cell's
 * own mask lights, or of all eight for a flat cell — the way the encoder derives a cell's value from its dots.
 */
const lumaAt = (dots: Uint8Array, shape: Shape, x: number, y: number, dx: number, dy: number, mask: number): number => {
  const width = shape.cols * 2;
  const height = shape.rows * 4;
  let sum = 0;
  let count = 0;
  const left = x * 2 + dx;
  const top = y * 4 + dy;
  const inside = left >= 0 && left + 1 < width && top >= 0 && top + 3 < height;
  for (let dot = 0; dot < 8; dot += 1) {
    if (mask && !((mask >> dot) & 1)) continue;
    sum += (inside ? dots[(top + (dot >> 1)) * width + left + (dot & 1)] : dots[clamp(top + (dot >> 1), height) * width + clamp(left + (dot & 1), width)]) ?? 0;
    count += 1;
  }
  return Math.floor((sum + (count >> 1)) / count);
};

/** U or V at a half-resolution cell shifted by (dx, dy) dots: a quarter of a cell across, an eighth down. */
const chromaAt = (plane: Uint8Array, shape: Shape, x: number, y: number, dx: number, dy: number): number => {
  const x0 = x + (dx >> 2);
  const y0 = y + (dy >> 3);
  const fx = dx & 3;
  const fy = dy & 7;
  const w = shape.halfCols;
  const h = shape.halfRows;
  const a = plane[clamp(y0, h) * w + clamp(x0, w)] ?? 0;
  if (!fx && !fy) return a;
  const b = plane[clamp(y0, h) * w + clamp(x0 + 1, w)] ?? 0;
  const c = plane[clamp(y0 + 1, h) * w + clamp(x0, w)] ?? 0;
  const d = plane[clamp(y0 + 1, h) * w + clamp(x0 + 1, w)] ?? 0;
  return ((a * (4 - fx) + b * fx) * (8 - fy) + (c * (4 - fx) + d * fx) * fy + 16) >> 5;
};

/** LOCO-I median predictor from the already reconstructed left, top and top-left values. */
const median = (plane: Uint8Array, width: number, x: number, y: number, middle: number): number => {
  const left = x > 0 ? (plane[y * width + x - 1] ?? 0) : -1;
  const top = y > 0 ? (plane[(y - 1) * width + x] ?? 0) : -1;
  if (left < 0 && top < 0) return middle;
  if (left < 0) return top;
  if (top < 0) return left;
  const corner = plane[(y - 1) * width + x - 1] ?? 0;
  if (corner >= Math.max(left, top)) return Math.min(left, top);
  if (corner <= Math.min(left, top)) return Math.max(left, top);
  return left + top - corner;
};

/** Mask of a cell taken from shifted reference masks, dot by dot. */
const shiftedMask = (masks: Uint8Array, shape: Shape, cx: number, cy: number, dx: number, dy: number): number => {
  if (!dx && !dy) return masks[cy * shape.cols + cx] ?? 0;
  let mask = 0;
  const width = shape.cols * 2;
  const height = shape.rows * 4;
  for (let dot = 0; dot < 8; dot += 1) {
    const x = clamp(cx * 2 + (dot & 1) + dx, width);
    const y = clamp(cy * 4 + (dot >> 1) + dy, height);
    if (((masks[(y >> 2) * shape.cols + (x >> 1)] ?? 0) >> ((y & 3) * 2 + (x & 1))) & 1) mask |= 1 << dot;
  }
  return mask;
};

const bitCount = (value: number): number => {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count += 1;
  return count;
};

// ---- frames ----

/** What the encoder knows about the frame it codes. */
export interface Source {
  readonly planes: Planes;
  readonly masks?: Uint8Array;
  /** Dark-side colors of patterned cells, RGB per cell. */
  readonly shades?: Uint8Array;
  /** Quantizer threshold for this frame's predicted blocks (0–63). Default: the stream's. */
  readonly threshold?: number;
  /** Quantizer threshold for intra blocks and key frames (0–63). Default 0: exact. */
  readonly intraThreshold?: number;
}

/** Decoded frame. `motion` is the vector of every block in cells, for drawing frames in between. */
export interface Frame {
  readonly planes: Planes;
  readonly masks: Uint8Array;
  readonly shades: Uint8Array | null;
  readonly motion: Int8Array;
}

interface Options {
  readonly cols: number;
  readonly rows: number;
  readonly threshold: number;
  readonly detail: boolean;
  readonly shades: boolean;
  /** Encoder only: try just the neighbors' vectors and one dot around the best, for live streams. */
  readonly fast?: boolean;
}

/**
 * Codes frames of one chunk. The first frame is a key frame; every chunk starts with fresh contexts, so a player
 * can start at any chunk.
 */
class ChunkCoder {
  readonly shape: Shape;
  private steps: { readonly y: number; readonly u: number; readonly v: number };
  private keySteps: { readonly y: number; readonly u: number; readonly v: number };
  private reference: Planes;
  private referenceMasks: Uint8Array;
  private referenceDots: Uint8Array;
  private readonly cellLists = new Map<number, ['y' | 'u' | 'v', number, number, number, number][]>();
  private previousVectors: Int16Array;
  private frames = 0;

  constructor(readonly options: Options, private readonly bits: Bits) {
    this.shape = shapeOf(options.cols, options.rows);
    this.steps = stepsOf(options.threshold);
    // key frames and intra blocks are exact: they are the base the next frames copy from, so an error there stays
    // on screen until the next key frame
    this.keySteps = { y: 1, u: 1, v: 1 };
    this.reference = emptyPlanes(this.shape, true);
    this.referenceMasks = new Uint8Array(this.shape.cols * this.shape.rows);
    this.referenceDots = new Uint8Array(this.shape.cols * this.shape.rows * 8).fill(32);
    this.previousVectors = new Int16Array(this.shape.blocks * 2);
  }

  frame(source?: Source): Frame {
    const { shape, bits, options } = this;
    const key = this.frames === 0;
    this.frames += 1;
    // every frame names its own quantizers, so an encoder can trade quality for size frame by frame (rate control
    // for live streams); this one uses the stream's threshold for predicted blocks and exact intra blocks
    const threshold = unsigned(bits, C_FRAME, source?.threshold ?? options.threshold);
    const intraThreshold = unsigned(bits, C_FRAME + 16, source?.intraThreshold ?? 0);
    if (threshold > 63 || intraThreshold > 63) throw new Error('Damaged .gcast chunk: threshold out of range');
    this.steps = stepsOf(threshold);
    this.keySteps = stepsOf(intraThreshold);
    const ref = this.reference;
    const out = emptyPlanes(shape);
    const masks = new Uint8Array(shape.cols * shape.rows);
    const decoded = new Uint8Array(shape.cols * shape.rows);
    const shades = options.detail && options.shades ? new Uint8Array(shape.cols * shape.rows * 3) : null;
    const vectors = new Int16Array(shape.blocks * 2);
    const intraBlocks = new Uint8Array(shape.blocks);
    const codedBlocks = new Uint8Array(shape.blocks);
    const skipBlocks = new Uint8Array(shape.blocks);
    const nonzero = { y: new Uint8Array(out.y.length), u: new Uint8Array(out.u.length), v: new Uint8Array(out.v.length) };
    const motion = new Int8Array(shape.blocks * 2);

    for (let block = 0; block < shape.blocks; block += 1) {
      const bx = (block % shape.blocksX) * BLOCK_W;
      const by = Math.floor(block / shape.blocksX) * BLOCK_H;
      const hasLeft = bx > 0;
      const hasTop = by > 0;
      const left = block - 1;
      const top = block - shape.blocksX;
      const topRight = hasTop && bx + BLOCK_W < shape.cols ? top + 1 : -1;
      const cells = this.cells(bx, by);

      // motion vector predicted as the median of the left, top and top-right blocks
      const near = (index: number, axis: number): number => (index >= 0 ? (vectors[index * 2 + axis] ?? 0) : 0);
      const predicted = [0, 1].map((axis) => {
        const a = hasLeft ? near(left, axis) : 0;
        const b = hasTop ? near(top, axis) : a;
        const c = topRight >= 0 ? near(topRight, axis) : b;
        return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
      }) as [number, number];

      // encoder decisions
      let choice: { intra: boolean; dx: number; dy: number } = { intra: true, dx: 0, dy: 0 };
      if (bits.encoding && source && !key) choice = this.decide(source, ref, block, bx, by, predicted, hasLeft ? [near(left, 0), near(left, 1)] : null, hasTop ? [near(top, 0), near(top, 1)] : null);

      const intra = key ? 1 : bits.bit(C_INTRA + (hasLeft ? (intraBlocks[left] ?? 0) : 0) + (hasTop ? (intraBlocks[top] ?? 0) : 0), choice.intra ? 1 : 0);
      intraBlocks[block] = intra;
      let dx = 0;
      let dy = 0;
      if (!intra) {
        dx = predicted[0] + signed(bits, C_MV, choice.dx - predicted[0]);
        dy = predicted[1] + signed(bits, C_MV + SIGNED, choice.dy - predicted[1]);
        if (dx < -RANGE || dx >= RANGE || dy < -RANGE || dy >= RANGE) throw new Error('Damaged .gcast chunk: motion out of range');
      }
      vectors[block * 2] = dx;
      vectors[block * 2 + 1] = dy;
      motion[block * 2] = Math.round(dx / 2);
      motion[block * 2 + 1] = Math.round(dy / 4);

      // masks first: the colors' contexts know which cells carry a pattern
      if (options.detail) {
        // masks: predicted from the reference shifted by the block's vector, sent when they differ too much
        const predictedMasks = cells.filter((cell) => cell[0] === 'y').map(([, index, x, y]) => [index, x, y, key ? 0 : shiftedMask(this.referenceMasks, shape, x, y, dx, dy)] as const);
        let skip = 0;
        if (!key) {
          let differ = 0;
          if (bits.encoding && source?.masks) for (const [index, , , guess] of predictedMasks) differ += bitCount(guess ^ (source.masks[index] ?? 0));
          skip = bits.bit(C_SKIP + (hasLeft ? (skipBlocks[left] ?? 0) : 0) + (hasTop ? (skipBlocks[top] ?? 0) : 0), differ <= MASK_TOLERANCE ? 1 : 0);
        }
        skipBlocks[block] = skip;
        for (const [index, x, y, guess] of predictedMasks) {
          if (skip) masks[index] = guess;
          else masks[index] = this.mask(source?.masks?.[index] ?? 0, guess, masks, decoded, index, x, y, key ? null : [dx, dy]);
          decoded[index] = 1;
        }
      }
      // residuals: the encoder works them out against the same predictions the decoder makes
      const steps = intra ? this.keySteps : this.steps;
      const levels: number[] = [];
      if (bits.encoding && source) {
        this.reconstruct(out, ref, masks, cells, intra === 1, dx, dy, steps, null, source.planes, levels);
      }
      const any = levels.some((level) => level !== 0);
      const coded = bits.bit(C_CBF + intra * 3 + (hasLeft ? (codedBlocks[left] ?? 0) : 0) + (hasTop ? (codedBlocks[top] ?? 0) : 0), any ? 1 : 0);
      codedBlocks[block] = coded;
      // cell by cell: intra contexts read the cells reconstructed just before
      cells.forEach(([plane, index, x, y, width], at) => {
        let level = 0;
        const planeIndex = plane === 'y' ? 0 : plane === 'u' ? 1 : 2;
        if (coded) {
          let context: number;
          if (intra) {
            // how busy the picture is around the cell: flat areas have small residuals, edges large ones
            const values = out[plane];
            const leftValue = x > 0 ? (values[index - 1] ?? 0) : -1;
            const topValue = y > 0 ? (values[index - width] ?? 0) : -1;
            const corner = x > 0 && y > 0 ? (values[index - width - 1] ?? 0) : -1;
            const activity = leftValue < 0 || topValue < 0 ? 2 : Math.abs(leftValue - corner) + Math.abs(topValue - corner);
            const level$ = activity === 0 ? 0 : activity <= 2 ? 1 : activity <= 6 ? 2 : activity <= 14 ? 3 : 4;
            context = C_RES_INTRA + ((planeIndex * 5 + level$) * 2 + (plane === 'y' && masks[index] ? 1 : 0)) * SIGNED;
          } else {
            const map = nonzero[plane];
            const around = (x > 0 ? (map[index - 1] ?? 0) : 0) + (y > 0 ? (map[index - width] ?? 0) : 0);
            context = C_RES + ((planeIndex * 3 + around) * 2 + (plane === 'y' && masks[index] ? 1 : 0)) * SIGNED;
          }
          level = signed(bits, context, levels[at] ?? 0);
          if (level) nonzero[plane][index] = 1;
        }
        out[plane][index] = Math.min(plane === 'y' ? 63 : 31, Math.max(0, this.predict(out, ref, masks, plane, index, x, y, width, intra === 1, dx, dy) + level * steps[plane]));
      });

    }

    if (shades) this.darkSides(out, masks, shades, source);

    this.reference = out;
    this.referenceMasks = masks;
    this.referenceDots = dotLuma(out.y, masks, shape);
    this.previousVectors = vectors;
    return { planes: out, masks, shades, motion };
  }

  /**
   * Dark-side colors of patterned cells, after the whole frame: players guess them from the neighbors, so only
   * blocks where that guess is far off carry colors, coded in the context of the guess.
   */
  private darkSides(out: Planes, masks: Uint8Array, shades: Uint8Array, source?: Source): void {
    const { bits, shape } = this;
    const rgb = toPixels(out, shape);
    const flags = new Uint8Array(shape.blocks);
    for (let block = 0; block < shape.blocks; block += 1) {
      const bx = (block % shape.blocksX) * BLOCK_W;
      const by = Math.floor(block / shape.blocksX) * BLOCK_H;
      const patterned: number[] = [];
      for (let y = by; y < Math.min(by + BLOCK_H, shape.rows); y += 1) for (let x = bx; x < Math.min(bx + BLOCK_W, shape.cols); x += 1) if (masks[y * shape.cols + x]) patterned.push(y * shape.cols + x);
      if (!patterned.length) continue;
      const guesses = patterned.map((cell) => darkGuess(rgb, shape, cell));
      let wrong = 0;
      if (bits.encoding && source?.shades) {
        patterned.forEach((cell, at) => {
          for (let channel = 0; channel < 3; channel += 1) if (Math.abs((source.shades?.[cell * 3 + channel] ?? 0) - (guesses[at]?.[channel] ?? 0)) > 40) wrong = 1;
        });
      }
      const flag = bits.bit(C_DARK_FLAG + (bx > 0 ? (flags[block - 1] ?? 0) : 0) + (by > 0 ? (flags[block - shape.blocksX] ?? 0) : 0), wrong);
      flags[block] = flag;
      if (!flag) continue;
      patterned.forEach((cell, at) => {
        for (let channel = 0; channel < 3; channel += 1) {
          // six bits from the top, each in the context of the bits above it and of the guess's top three bits
          const guess = (guesses[at]?.[channel] ?? 0) >> 5;
          const value = bits.encoding ? (source?.shades?.[cell * 3 + channel] ?? 0) >> 2 : 0;
          let node = 1;
          for (let bit = 5; bit >= 0; bit -= 1) node = node * 2 + bits.bit(C_DARK + ((channel * 8 + guess) * 64) + node, (value >> bit) & 1);
          shades[cell * 3 + channel] = ((node - 64) << 2) | 2;
        }
      });
    }
  }

  /** Every Y, U and V position of a block, in coding order. */
  private cells(bx: number, by: number): ['y' | 'u' | 'v', number, number, number, number][] {
    const { shape } = this;
    const key = by * shape.cols + bx;
    const known = this.cellLists.get(key);
    if (known) return known;
    const list: ['y' | 'u' | 'v', number, number, number, number][] = [];
    for (let y = by; y < Math.min(by + BLOCK_H, shape.rows); y += 1) for (let x = bx; x < Math.min(bx + BLOCK_W, shape.cols); x += 1) list.push(['y', y * shape.cols + x, x, y, shape.cols]);
    for (const plane of ['u', 'v'] as const) {
      for (let y = by >> 1; y < Math.min((by + BLOCK_H) >> 1, shape.halfRows); y += 1) for (let x = bx >> 1; x < Math.min((bx + BLOCK_W) >> 1, shape.halfCols); x += 1) list.push([plane, y * shape.halfCols + x, x, y, shape.halfCols]);
    }
    this.cellLists.set(key, list);
    return list;
  }

  /**
   * Predicts a block and adds the residuals: `levels` decoded, or, when `target` is given, worked out from it
   * (written to `found`). Intra prediction reads cells reconstructed just before, so both runs give the same result.
   */
  private reconstruct(out: Planes, ref: Planes, masks: Uint8Array, cells: ['y' | 'u' | 'v', number, number, number, number][], intra: boolean, dx: number, dy: number, steps: { readonly y: number; readonly u: number; readonly v: number }, levels: number[] | null, target: Planes | null, found: number[] | null): void {
    for (let at = 0; at < cells.length; at += 1) {
      const [plane, index, x, y, width] = cells[at]!;
      const prediction = this.predict(out, ref, masks, plane, index, x, y, width, intra, dx, dy);
      const step = steps[plane];
      let level = levels?.[at] ?? 0;
      if (target) {
        level = Math.round(((target[plane][index] ?? 0) - prediction) / step);
        found?.push(level);
      }
      out[plane][index] = Math.min(plane === 'y' ? 63 : 31, Math.max(0, prediction + level * step));
    }
  }

  private predict(out: Planes, ref: Planes, masks: Uint8Array, plane: 'y' | 'u' | 'v', index: number, x: number, y: number, width: number, intra: boolean, dx: number, dy: number): number {
    if (intra) return median(out[plane], width, x, y, plane === 'y' ? 32 : 16);
    return plane === 'y' ? lumaAt(this.referenceDots, this.shape, x, y, dx, dy, masks[index] ?? 0) : chromaAt(ref[plane], this.shape, x, y, dx, dy);
  }

  /** Codes one cell's mask: whether it has a pattern, then its eight dots, each against its decoded neighbors. */
  private mask(value: number, guess: number, masks: Uint8Array, decoded: Uint8Array, cell: number, cx: number, cy: number, vector: readonly [number, number] | null): number {
    const { bits, shape } = this;
    const leftOn = cx > 0 && masks[cell - 1] ? 1 : 0;
    const topOn = cy > 0 && masks[cell - shape.cols] ? 1 : 0;
    const guessed = guess ? 1 : 0;
    if (!bits.bit(C_PATTERN + guessed + leftOn * 2 + topOn * 4, value ? 1 : 0)) return 0;
    const width = shape.cols * 2;
    const height = shape.rows * 4;
    const reference = this.referenceMasks;
    let mask = 0;
    // a dot of this frame, where it is decoded already, else 0
    const dot = (x: number, y: number, at: number): number => {
      if (x < 0 || y < 0 || x >= width) return 0;
      const index = (y >> 2) * shape.cols + (x >> 1);
      const bit = (y & 3) * 2 + (x & 1);
      if (index === cell) return bit < at ? (mask >> bit) & 1 : 0;
      return decoded[index] ? ((masks[index] ?? 0) >> bit) & 1 : 0;
    };
    // a dot of the previous frame shifted by the block's vector: known for the whole frame, ahead of decoding
    const predicted = (x: number, y: number): number => {
      if (!vector) return 0;
      const px = clamp(x + vector[0], width);
      const py = clamp(y + vector[1], height);
      return ((reference[(py >> 2) * shape.cols + (px >> 1)] ?? 0) >> ((py & 3) * 2 + (px & 1))) & 1;
    };
    for (let at = 0; at < 8; at += 1) {
      const x = cx * 2 + (at & 1);
      const y = cy * 4 + (at >> 1);
      const context = predicted(x, y) | (predicted(x + 1, y) << 1) | (predicted(x, y + 1) << 2) | (dot(x - 1, y, at) << 3) | (dot(x, y - 1, at) << 4) | (dot(x - 1, y - 1, at) << 5) | (dot(x + 1, y - 1, at) << 6) | (dot(x - 2, y, at) << 7) | (dot(x, y - 2, at) << 8) | (guessed << 9);
      mask |= bits.bit(C_DOT + context, (value >> at) & 1) << at;
    }
    return mask;
  }

  /** Chooses between motion (searched around the neighbors' vectors) and intra prediction by estimated bits. */
  private decide(source: Source, ref: Planes, block: number, bx: number, by: number, predicted: readonly [number, number], left: readonly [number, number] | null, top: readonly [number, number] | null): { intra: boolean; dx: number; dy: number } {
    const { shape, steps } = this;
    const cells = this.cells(bx, by);
    const target = source.planes;
    const rate = (level: number): number => RATES[Math.min(63, Math.abs(level))] ?? 0;
    const vectorBits = (dx: number, dy: number): number => (RATES[Math.min(63, Math.abs(dx - predicted[0]))] ?? 0) + (RATES[Math.min(63, Math.abs(dy - predicted[1]))] ?? 0);
    const masks = source.masks;
    const dots = this.referenceDots;
    const width = shape.cols * 2;
    const height = shape.rows * 4;
    const lumas = cells.filter((cell) => cell[0] === 'y');
    const chromas = cells.filter((cell) => cell[0] !== 'y');
    const stepY = steps.y;
    // what the block costs with a vector: estimated bits, plus what stays wrong on screen (rate alone would push
    // every cell to the edge of the tolerance)
    const cost = (dx: number, dy: number, limit: number): number => {
      let total = vectorBits(dx, dy);
      const inside = bx * 2 + dx >= 0 && (bx + BLOCK_W) * 2 + dx <= width && by * 4 + dy >= 0 && (by + BLOCK_H) * 4 + dy <= height;
      for (const [, index, x, y] of lumas) {
        let prediction: number;
        if (inside) {
          const mask = masks?.[index] ?? 0;
          let sum = 0;
          let count = 0;
          const base = (y * 4 + dy) * width + x * 2 + dx;
          for (let dot = 0; dot < 8; dot += 1) {
            if (mask && !((mask >> dot) & 1)) continue;
            sum += dots[base + (dot >> 1) * width + (dot & 1)] ?? 0;
            count += 1;
          }
          prediction = Math.floor((sum + (count >> 1)) / count);
        } else prediction = lumaAt(dots, shape, x, y, dx, dy, masks?.[index] ?? 0);
        const miss = (target.y[index] ?? 0) - prediction;
        const level = Math.round(miss / stepY);
        total += rate(level) + DISTORTION * Math.abs(miss - level * stepY);
        if (total >= limit) return total;
      }
      for (const [plane, index, x, y] of chromas) {
        const miss = (target[plane][index] ?? 0) - chromaAt(ref[plane], shape, x, y, dx, dy);
        const level = Math.round(miss / steps[plane]);
        total += rate(level) + DISTORTION * Math.abs(miss - level * steps[plane]);
        if (total >= limit) return total;
      }
      if (masks && this.options.detail) {
        let differ = 0;
        for (const [, index, x, y] of lumas) differ += bitCount(shiftedMask(this.referenceMasks, shape, x, y, dx, dy) ^ (masks[index] ?? 0));
        total += differ <= MASK_TOLERANCE ? 0 : differ * 1.2;
      }
      return total;
    };
    const fits = (dx: number, dy: number): boolean => dx >= -RANGE && dx < RANGE && dy >= -RANGE && dy < RANGE;
    let best = { dx: 0, dy: 0, cost: cost(0, 0, Infinity) };
    const tried = new Set<number>([0]);
    const consider = (dx: number, dy: number): boolean => {
      if (!fits(dx, dy)) return false;
      const key = (dx + 128) * 256 + dy + 128;
      if (tried.has(key)) return false;
      tried.add(key);
      const found = cost(dx, dy, best.cost);
      if (found < best.cost) {
        best = { dx, dy, cost: found };
        return true;
      }
      return false;
    };
    consider(predicted[0], predicted[1]);
    if (left) consider(left[0], left[1]);
    if (top) consider(top[0], top[1]);
    consider(this.previousVectors[block * 2] ?? 0, this.previousVectors[block * 2 + 1] ?? 0);
    if (this.options.fast) {
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) consider(best.dx + ox, best.dy + oy);
      return this.intraOrMotion(source, cells, best);
    }
    // coarse steps of a cell when the neighbors do not explain the block, then refine dot by dot
    if (best.cost > cells.length * COARSE) for (let dy = -16; dy <= 16; dy += 4) for (let dx = -16; dx <= 16; dx += 4) consider(dx, dy);
    for (const size of [4, 2, 1]) {
      let moved = true;
      for (let round = 0; moved && round < 8; round += 1) {
        const { dx, dy } = best;
        moved = consider(dx + size, dy) || consider(dx - size, dy) || consider(dx, dy + size) || consider(dx, dy - size);
      }
    }
    return this.intraOrMotion(source, cells, best);
  }

  /** Intra prediction wins when the same estimate over the median predictor is lower than the best motion's. */
  private intraOrMotion(source: Source, cells: ['y' | 'u' | 'v', number, number, number, number][], best: { dx: number; dy: number; cost: number }): { intra: boolean; dx: number; dy: number } {
    const target = source.planes;
    const masks = source.masks;
    const rate = (level: number): number => RATES[Math.min(63, Math.abs(level))] ?? 0;
    let intra = 1.5;
    for (const [plane, index, x, y, width] of cells) {
      const prediction = median(target[plane], width, x, y, plane === 'y' ? 32 : 16);
      intra += rate((target[plane][index] ?? 0) - prediction);
    }
    if (masks && this.options.detail) for (const [plane, index] of cells) if (plane === 'y' && masks[index]) intra += 4;
    return intra < best.cost ? { intra: true, dx: 0, dy: 0 } : { intra: false, dx: best.dx, dy: best.dy };
  }
}

/** Encodes frames chunk by chunk: `add` codes a frame, `finish` returns the chunk's bytes and starts the next one. */
export class Encoder6 {
  private bits = new EncodeBits();
  private coder: ChunkCoder;
  private count = 0;

  constructor(private readonly options: Options) {
    this.coder = new ChunkCoder(options, this.bits);
  }

  /** Codes a frame and returns it as players will decode it. */
  add(source: Source): Frame {
    this.count += 1;
    return this.coder.frame(source);
  }

  /** The chunk: its frame count as a LEB128 number, then the range-coded frames. */
  finish(): Uint8Array {
    const head: number[] = [];
    for (let rest = this.count; ; rest = Math.floor(rest / 128)) {
      head.push((rest % 128) | (rest >= 128 ? 128 : 0));
      if (rest < 128) break;
    }
    const body = this.bits.coder.finish();
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    this.bits = new EncodeBits();
    this.coder = new ChunkCoder(this.options, this.bits);
    this.count = 0;
    return out;
  }
}

/** Decodes the frames of one chunk. */
export const decodeChunk6 = (options: Options, data: Uint8Array): Frame[] => {
  let frames = 0;
  let at = 0;
  for (let scale = 1; ; scale *= 128) {
    const byte = data[at];
    if (byte === undefined || scale > 2 ** 21) throw new Error('Damaged .gcast chunk');
    at += 1;
    frames += (byte & 127) * scale;
    if (byte < 128) break;
  }
  if (frames > 0xffff) throw new Error('Damaged .gcast chunk: too many frames');
  const coder = new ChunkCoder(options, new DecodeBits(data.subarray(at)));
  const out: Frame[] = [];
  for (let i = 0; i < frames; i += 1) out.push(coder.frame());
  return out;
};
