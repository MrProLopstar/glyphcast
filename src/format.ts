export const MAGIC = 0x54534347;
export const VERSION = 3;
export const HEADER_SIZE = 20;
const CHUNK_HEAD = 6;
const INDEX_FRAMES = 0xffff;
const INDEX_MAGIC = 0x58444947;
/** Bytes at the end of a file that point to its chunk index. */
export const INDEX_TRAILER = 8;

/** Where a chunk of frames starts in a file, for seeking with range requests. */
export interface IndexEntry {
  /** Byte offset of the chunk head from the start of the file. */
  readonly offset: number;
  readonly start: number;
  readonly frames: number;
}

export interface StreamInfo {
  readonly cols: number;
  readonly rows: number;
  readonly fps: number;
  readonly chunkFrames: number;
  /** Total frames, or 0 for a live stream of unknown length. */
  readonly frameCount: number;
  /** Brightness steps (of 63) a cell may drift before it is sent again. Higher means smaller streams. Default 3. */
  readonly threshold: number;
}

export interface EncodeOptions extends Omit<StreamInfo, 'frameCount' | 'threshold'> {
  /** Brightness steps (of 63) a cell may drift before it is sent again. Higher means smaller streams. Default 3. */
  readonly threshold?: number;
  /** Total frames if known in advance, written to the header. Default 0 (unknown). */
  readonly frameCount?: number;
}

export interface Chunk {
  /** Index of the first frame in the chunk. */
  readonly start: number;
  /** Frames in the chunk; 0 marks a piece of embedded audio, stored before the first frame. */
  readonly frames: number;
  /** Compressed payload, or raw audio bytes, without the 6-byte chunk head. */
  readonly data: Uint8Array;
}

export class GlyphcastError extends Error {
  override readonly name = 'GlyphcastError';
}

const BLOCK_W = 8;
const BLOCK_H = 4;
const VECTORS: readonly (readonly [number, number])[] = [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2], [-4, 0], [4, 0], [0, -4], [0, 4], [-6, 0], [6, 0]];
const RESIDUAL = 128;

interface Planes {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

interface Layout {
  readonly cols: number;
  readonly rows: number;
  readonly halfCols: number;
  readonly halfRows: number;
  readonly blocksX: number;
  readonly blocks: number;
}

const layout = (cols: number, rows: number): Layout => {
  const blocksX = Math.ceil(cols / BLOCK_W);
  return { cols, rows, halfCols: Math.ceil(cols / 2), halfRows: Math.ceil(rows / 2), blocksX, blocks: blocksX * Math.ceil(rows / BLOCK_H) };
};

const planes = (shape: Layout, gray = false): Planes => ({
  y: new Uint8Array(shape.cols * shape.rows).fill(gray ? 32 : 0),
  u: new Uint8Array(shape.halfCols * shape.halfRows).fill(gray ? 16 : 0),
  v: new Uint8Array(shape.halfCols * shape.halfRows).fill(gray ? 16 : 0),
});

const clampTo = (value: number, max: number): number => (value < 0 ? 0 : value >= max ? max - 1 : value);

const toPlanes = (pixels: Uint8Array | Uint8ClampedArray, stride: number, shape: Layout): Planes => {
  const out = planes(shape);
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

const toPixels = (frame: Planes, shape: Layout): Uint8ClampedArray => {
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

type Plane = 'y' | 'u' | 'v';

interface Steps {
  readonly tolerance: Readonly<Record<Plane, number>>;
  readonly size: Readonly<Record<Plane, number>>;
}

const steps = (threshold: number): Steps => {
  const chroma = Math.round(threshold / 3);
  return { tolerance: { y: threshold, u: chroma, v: chroma }, size: { y: threshold * 2 + 1, u: chroma * 2 + 1, v: chroma * 2 + 1 } };
};

const rebuild = (base: number, level: number, step: number, plane: Plane): number => Math.min(plane === 'y' ? 63 : 31, Math.max(0, base + level * step));

const scan = (target: Uint8Array, source: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number, tolerance: number, state: { cost: number; fits: boolean }, limit: number): boolean => {
  for (let row = y0; row < y1; row += 1) {
    const from = clampTo(row + dy, height) * width;
    const to = row * width;
    for (let col = x0; col < x1; col += 1) {
      const delta = Math.abs((target[to + col] ?? 0) - (source[from + clampTo(col + dx, width)] ?? 0));
      state.cost += delta;
      if (delta > tolerance) state.fits = false;
    }
    if (!state.fits && state.cost >= limit) return false;
  }
  return true;
};

const match = (shape: Layout, current: Planes, reference: Planes, block: number, dx: number, dy: number, tolerance: Readonly<Record<Plane, number>>, limit: number): number => {
  const bx = (block % shape.blocksX) * BLOCK_W;
  const by = Math.floor(block / shape.blocksX) * BLOCK_H;
  const state = { cost: 0, fits: true };
  const x1 = Math.min(bx + BLOCK_W, shape.cols);
  const y1 = Math.min(by + BLOCK_H, shape.rows);
  if (!scan(current.y, reference.y, shape.cols, shape.rows, bx, by, x1, y1, dx, dy, tolerance.y, state, limit)) return Infinity;
  const hx1 = Math.min((bx + BLOCK_W) >> 1, shape.halfCols);
  const hy1 = Math.min((by + BLOCK_H) >> 1, shape.halfRows);
  if (!scan(current.u, reference.u, shape.halfCols, shape.halfRows, bx >> 1, by >> 1, hx1, hy1, dx >> 1, dy >> 1, tolerance.u, state, limit)) return Infinity;
  if (!scan(current.v, reference.v, shape.halfCols, shape.halfRows, bx >> 1, by >> 1, hx1, hy1, dx >> 1, dy >> 1, tolerance.v, state, limit)) return Infinity;
  return state.fits ? -1 : state.cost;
};

const visit = (shape: Layout, block: number, each: (plane: 'y' | 'u' | 'v', index: number, reference: (dx: number, dy: number) => number) => void): void => {
  const bx = (block % shape.blocksX) * BLOCK_W;
  const by = Math.floor(block / shape.blocksX) * BLOCK_H;
  for (let row = by; row < Math.min(by + BLOCK_H, shape.rows); row += 1) {
    for (let col = bx; col < Math.min(bx + BLOCK_W, shape.cols); col += 1) {
      each('y', row * shape.cols + col, (dx, dy) => clampTo(row + dy, shape.rows) * shape.cols + clampTo(col + dx, shape.cols));
    }
  }
  for (const plane of ['u', 'v'] as const) {
    for (let row = by >> 1; row < Math.min((by + BLOCK_H) >> 1, shape.halfRows); row += 1) {
      for (let col = bx >> 1; col < Math.min((bx + BLOCK_W) >> 1, shape.halfCols); col += 1) {
        each(plane, row * shape.halfCols + col, (dx, dy) => clampTo(row + (dy >> 1), shape.halfRows) * shape.halfCols + clampTo(col + (dx >> 1), shape.halfCols));
      }
    }
  }
};

const pipe = async (data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> => {
  const output = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
};

export const deflate = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new CompressionStream('deflate-raw'));
export const inflate = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new DecompressionStream('deflate-raw'));

const validate = ({ cols, rows, fps, chunkFrames, threshold }: Omit<StreamInfo, 'frameCount'>): void => {
  if (!Number.isInteger(cols) || cols < 1 || cols > 4096) throw new GlyphcastError(`cols must be an integer from 1 to 4096, got ${cols}`);
  if (!Number.isInteger(rows) || rows < 1 || rows > 4096) throw new GlyphcastError(`rows must be an integer from 1 to 4096, got ${rows}`);
  if (!(fps > 0 && fps <= 240)) throw new GlyphcastError(`fps must be in (0, 240], got ${fps}`);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 31) throw new GlyphcastError(`threshold must be an integer from 0 to 31, got ${threshold}`);
  if (!Number.isInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 65535) throw new GlyphcastError(`chunkFrames must be an integer from 1 to 65535, got ${chunkFrames}`);
};

/** The 20-byte stream header. */
export const writeHeader = (info: StreamInfo): Uint8Array => {
  validate(info);
  const out = new Uint8Array(HEADER_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, VERSION);
  view.setUint8(5, info.threshold);
  view.setUint16(6, info.cols, true);
  view.setUint16(8, info.rows, true);
  view.setFloat32(10, info.fps, true);
  view.setUint16(14, info.chunkFrames, true);
  view.setUint32(16, info.frameCount, true);
  return out;
};

/** Reads the stream header. Throws `GlyphcastError` if the bytes are not a `.gcast` header. */
export const readHeader = (bytes: Uint8Array): StreamInfo => {
  if (bytes.length < HEADER_SIZE) throw new GlyphcastError('Not enough bytes for a .gcast header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new GlyphcastError('Not a .gcast stream');
  const version = view.getUint8(4);
  if (version !== VERSION) throw new GlyphcastError(`Unsupported .gcast version ${version}`);
  const info = {
    cols: view.getUint16(6, true),
    rows: view.getUint16(8, true),
    fps: view.getFloat32(10, true),
    chunkFrames: view.getUint16(14, true),
    frameCount: view.getUint32(16, true),
    threshold: view.getUint8(5),
  };
  validate(info);
  return info;
};

/** Frames a compressed chunk for the wire: 4-byte size, 2-byte frame count, payload. */
export const frameChunk = (chunk: Chunk): Uint8Array => {
  const out = new Uint8Array(CHUNK_HEAD + chunk.data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, chunk.data.length, true);
  view.setUint16(4, chunk.frames, true);
  out.set(chunk.data, CHUNK_HEAD);
  return out;
};

/**
 * Splits bytes as they arrive into the header and chunks. Works for whole files, progressive downloads and live
 * streams alike: feed it whatever came in, it returns the chunks completed so far.
 */
export class StreamReader {
  info: StreamInfo | null = null;
  private buffer = new Uint8Array(0);
  private length = 0;
  private frames = 0;

  /** Pass `info` and the first frame index to read from the middle of a file, after a range request. */
  constructor(info?: StreamInfo, start = 0) {
    this.info = info ?? null;
    this.frames = start;
  }

  push(bytes: Uint8Array): Chunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + bytes.length, 1 << 16));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
    let at = 0;
    if (!this.info) {
      if (this.length < HEADER_SIZE) return [];
      this.info = readHeader(this.buffer.subarray(0, HEADER_SIZE));
      at = HEADER_SIZE;
    }
    const chunks: Chunk[] = [];
    while (this.length - at >= CHUNK_HEAD) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at, CHUNK_HEAD);
      const size = view.getUint32(0, true);
      const frames = view.getUint16(4, true);
      if (this.length - at - CHUNK_HEAD < size) break;
      if (frames === INDEX_FRAMES) {
        at += CHUNK_HEAD + size;
        continue;
      }
      chunks.push({ start: this.frames, frames, data: this.buffer.slice(at + CHUNK_HEAD, at + CHUNK_HEAD + size) });
      this.frames += frames;
      at += CHUNK_HEAD + size;
    }
    this.buffer.copyWithin(0, at, this.length);
    this.length -= at;
    return chunks;
  }
}

/**
 * Builds a `.gcast` stream frame by frame. Frames are RGB24 or RGBA pixels at the grid size. Cells are stored as
 * 6-bit brightness with color shared by 2×2 cells (like 4:2:0 video); the grid is cut into 8×4 blocks, and each
 * block either repeats the previous frame shifted by a motion vector or carries a residual against it. Every
 * `chunkFrames` frames form a compressed chunk that starts with a key frame, so playback can begin at any chunk.
 *
 * `onChunk` receives each finished chunk, ready for a file or an HTTP response; `finish()` also returns a whole file.
 */
export class Encoder {
  readonly info: StreamInfo;
  private readonly shape: Layout;
  private readonly steps: Steps;
  private state: Planes;
  private parts: Uint8Array[] = [];
  private inChunk = 0;
  private frames = 0;
  private chunkStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly finished: Uint8Array[] = [];
  private readonly lateAudio: Uint8Array[] = [];

  constructor(options: EncodeOptions, private readonly onChunk?: (bytes: Uint8Array) => void) {
    this.info = { cols: options.cols, rows: options.rows, fps: options.fps, chunkFrames: options.chunkFrames, frameCount: options.frameCount ?? 0, threshold: options.threshold ?? 3 };
    validate(this.info);
    this.shape = layout(options.cols, options.rows);
    this.steps = steps(this.info.threshold);
    this.state = planes(this.shape);
    this.emit(writeHeader(this.info));
  }

  private emit(bytes: Uint8Array): void {
    this.finished.push(bytes);
    this.onChunk?.(bytes);
  }

  /**
   * Embeds an audio file (Ogg or WebM Opus, M4A, MP3) before the first frame. Players read it first and use it as
   * the clock, so a single `.gcast` carries picture and sound. Added after frames, it still goes first in the file
   * from `finish()`, but live `onChunk` output does not get it.
   */
  addAudio(bytes: Uint8Array): void {
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 65536) pieces.push(frameChunk({ start: 0, frames: 0, data: bytes.slice(at, at + 65536) }));
    if (this.frames > 0 || this.inChunk > 0) this.lateAudio.push(...pieces);
    else for (const piece of pieces) this.emit(piece);
  }

  /** Adds a frame of `cols × rows` pixels, 3 or 4 bytes per pixel. */
  add(pixels: Uint8Array | Uint8ClampedArray): void {
    const shape = this.shape;
    const cells = shape.cols * shape.rows;
    const stride = pixels.length / cells;
    if (stride !== 3 && stride !== 4) throw new GlyphcastError(`A frame must have ${cells * 3} or ${cells * 4} bytes, got ${pixels.length}`);
    const key = this.inChunk === 0;
    const current = toPlanes(pixels, stride, shape);
    const reference = key ? planes(shape, true) : this.state;
    const next = planes(shape);
    const modes = new Uint8Array(shape.blocks);
    const residuals = planes(shape);
    const counts = { y: 0, u: 0, v: 0 };
    const tolerance = this.steps.tolerance;
    for (let block = 0; block < shape.blocks; block += 1) {
      let chosen = -1;
      let best = 0;
      let bestCost = Infinity;
      for (let vector = 0; vector < (key ? 1 : VECTORS.length); vector += 1) {
        const [dx, dy] = VECTORS[vector] ?? [0, 0];
        const cost = match(shape, current, reference, block, dx, dy, tolerance, bestCost);
        if (cost < 0) {
          chosen = vector;
          break;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = vector;
        }
      }
      const vector = chosen >= 0 ? chosen : best;
      const [dx, dy] = VECTORS[vector] ?? [0, 0];
      modes[block] = chosen >= 0 ? vector : vector | RESIDUAL;
      visit(shape, block, (plane, index, at) => {
        const base = reference[plane][at(dx, dy)] ?? 0;
        if (chosen >= 0) {
          next[plane][index] = base;
          return;
        }
        const step = key ? 1 : this.steps.size[plane];
        const level = Math.round(((current[plane][index] ?? 0) - base) / step);
        residuals[plane][counts[plane]] = level & 255;
        counts[plane] += 1;
        next[plane][index] = rebuild(base, level, step, plane);
      });
    }
    this.state = next;
    this.parts.push(new Uint8Array([key ? 0 : 1]), modes, residuals.y.slice(0, counts.y), residuals.u.slice(0, counts.u), residuals.v.slice(0, counts.v));
    this.frames += 1;
    this.inChunk += 1;
    if (this.inChunk === this.info.chunkFrames) this.flush();
  }

  private flush(): void {
    if (this.inChunk === 0) return;
    const raw = new Uint8Array(this.parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of this.parts) {
      raw.set(part, at);
      at += part.length;
    }
    const chunk = { start: this.chunkStart, frames: this.inChunk };
    this.chunkStart += this.inChunk;
    this.parts = [];
    this.inChunk = 0;
    const compressed = deflate(raw);
    this.queue = this.queue.then(async () => this.emit(frameChunk({ ...chunk, data: await compressed })));
  }

  /** Waits for every chunk to be emitted. Call it to apply backpressure in long encodes. */
  drain(): Promise<void> {
    return this.queue;
  }

  /** Flushes the last chunk and returns the whole stream; the header carries the final frame count. */
  async finish(): Promise<Uint8Array> {
    this.flush();
    await this.queue;
    const header = writeHeader({ ...this.info, frameCount: this.frames });
    const body = [...this.lateAudio, ...this.finished.slice(1)];
    const entries: IndexEntry[] = [];
    let offset = HEADER_SIZE;
    let start = 0;
    for (const part of body) {
      const frames = (part[4] ?? 0) | ((part[5] ?? 0) << 8);
      if (frames > 0) {
        entries.push({ offset, start, frames });
        start += frames;
      }
      offset += part.length;
    }
    const parts = [header, ...body, writeIndex(entries)];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

const writeIndex = (entries: readonly IndexEntry[]): Uint8Array => {
  const data = new Uint8Array(entries.length * 16 + INDEX_TRAILER);
  const view = new DataView(data.buffer);
  entries.forEach((entry, at) => {
    view.setFloat64(at * 16, entry.offset, true);
    view.setUint32(at * 16 + 8, entry.start, true);
    view.setUint32(at * 16 + 12, entry.frames, true);
  });
  view.setUint32(data.length - 8, CHUNK_HEAD + data.length, true);
  view.setUint32(data.length - 4, INDEX_MAGIC, true);
  return frameChunk({ start: 0, frames: INDEX_FRAMES, data });
};

/** Length of the index chunk at the end of a file, read from its last 8 bytes, or null if the file has no index. */
export const indexLength = (trailer: Uint8Array): number | null => {
  if (trailer.length < INDEX_TRAILER) return null;
  const view = new DataView(trailer.buffer, trailer.byteOffset + trailer.length - INDEX_TRAILER, INDEX_TRAILER);
  return view.getUint32(4, true) === INDEX_MAGIC ? view.getUint32(0, true) : null;
};

/** Parses the index chunk from the end of a file: where every chunk of frames starts. */
export const readIndex = (chunk: Uint8Array): IndexEntry[] => {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const count = Math.floor((chunk.length - CHUNK_HEAD - INDEX_TRAILER) / 16);
  return Array.from({ length: count }, (_, at) => ({
    offset: view.getFloat64(CHUNK_HEAD + at * 16, true),
    start: view.getUint32(CHUNK_HEAD + at * 16 + 8, true),
    frames: view.getUint32(CHUNK_HEAD + at * 16 + 12, true),
  }));
};

/** MIME type of embedded audio bytes, from their signature. */
export const audioType = (bytes: Uint8Array): string => {
  const ascii = String.fromCharCode(...bytes.subarray(0, 12));
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (ascii.slice(4, 8) === 'ftyp') return 'audio/mp4';
  return 'audio/mpeg';
};

/** Decodes one chunk payload into RGBA frames (`cols × rows × 4` bytes each), ready to upload as a texture. */
export const decodeChunk = async (info: Pick<StreamInfo, 'cols' | 'rows' | 'threshold'>, compressed: Uint8Array): Promise<Uint8ClampedArray[]> => {
  const raw = await inflate(compressed);
  const shape = layout(info.cols, info.rows);
  const { size } = steps(info.threshold);
  const frames: Uint8ClampedArray[] = [];
  let state = planes(shape);
  let at = 0;
  while (at < raw.length) {
    const type = raw[at];
    if (type !== 0 && type !== 1) throw new GlyphcastError(`Unknown frame type ${String(type)}`);
    const reference = type === 0 ? planes(shape, true) : state;
    const modes = raw.subarray(at + 1, at + 1 + shape.blocks);
    at += 1 + shape.blocks;
    const counts = { y: 0, u: 0, v: 0 };
    modes.forEach((mode, block) => {
      if (mode & RESIDUAL) visit(shape, block, (plane) => (counts[plane] += 1));
    });
    const offsets = { y: at, u: at + counts.y, v: at + counts.y + counts.u };
    at += counts.y + counts.u + counts.v;
    if (modes.length < shape.blocks || at > raw.length) throw new GlyphcastError('Truncated frame');
    const next = planes(shape);
    modes.forEach((mode, block) => {
      const vector = VECTORS[mode & ~RESIDUAL];
      if (!vector) throw new GlyphcastError(`Unknown block mode ${String(mode)}`);
      const [dx, dy] = vector;
      visit(shape, block, (plane, index, ref) => {
        const base = reference[plane][ref(dx, dy)] ?? 0;
        if (mode & RESIDUAL) {
          next[plane][index] = rebuild(base, ((raw[offsets[plane]] ?? 0) << 24) >> 24, type === 0 ? 1 : size[plane], plane);
          offsets[plane] += 1;
        } else {
          next[plane][index] = base;
        }
      });
    });
    state = next;
    frames.push(toPixels(state, shape));
  }
  return frames;
};
