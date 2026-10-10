export const MAGIC = 0x54534347;
export const VERSION = 2;
export const HEADER_SIZE = 20;
const CHUNK_HEAD = 6;

export interface StreamInfo {
  readonly cols: number;
  readonly rows: number;
  readonly fps: number;
  readonly chunkFrames: number;
  /** Total frames, or 0 for a live stream of unknown length. */
  readonly frameCount: number;
}

export interface EncodeOptions extends Omit<StreamInfo, 'frameCount'> {
  /** Squared RGB distance below which a cell keeps its previous color. Higher means smaller streams. Default 500. */
  readonly threshold?: number;
  /** Total frames if known in advance, written to the header. Default 0 (unknown). */
  readonly frameCount?: number;
}

export interface Chunk {
  /** Index of the first frame in the chunk. */
  readonly start: number;
  readonly frames: number;
  /** Compressed payload, without the 6-byte chunk head. */
  readonly data: Uint8Array;
}

export class GlyphcastError extends Error {
  override readonly name = 'GlyphcastError';
}

const pack = (r: number, g: number, b: number): number => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

const unpack = (high: number, low: number, target: Uint8ClampedArray, offset: number): void => {
  target[offset] = (high & 15) * 17;
  target[offset + 1] = (low >> 4) * 17;
  target[offset + 2] = (low & 15) * 17;
  target[offset + 3] = 255;
};

const pipe = async (data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> => {
  const output = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
};

export const deflate = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new CompressionStream('deflate-raw'));
export const inflate = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new DecompressionStream('deflate-raw'));

const validate = ({ cols, rows, fps, chunkFrames }: Omit<StreamInfo, 'frameCount'>): void => {
  if (!Number.isInteger(cols) || cols < 1 || cols > 4096) throw new GlyphcastError(`cols must be an integer from 1 to 4096, got ${cols}`);
  if (!Number.isInteger(rows) || rows < 1 || rows > 4096) throw new GlyphcastError(`rows must be an integer from 1 to 4096, got ${rows}`);
  if (!(fps > 0 && fps <= 240)) throw new GlyphcastError(`fps must be in (0, 240], got ${fps}`);
  if (!Number.isInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 65535) throw new GlyphcastError(`chunkFrames must be an integer from 1 to 65535, got ${chunkFrames}`);
};

/** The 20-byte stream header. */
export const writeHeader = (info: StreamInfo): Uint8Array => {
  validate(info);
  const out = new Uint8Array(HEADER_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, VERSION);
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
 * Builds a `.gcast` stream frame by frame. Frames are RGB24 or RGBA pixels at the grid size; colors are stored
 * as 12-bit RGB in two byte planes, cells that barely changed are skipped, and every `chunkFrames` frames form a
 * compressed chunk that starts with a key frame, so playback can begin or seek at any chunk.
 *
 * `onChunk` receives each finished chunk, ready for a file or an HTTP response; `finish()` also returns a whole file.
 */
export class Encoder {
  readonly info: StreamInfo;
  private readonly cells: number;
  private readonly threshold: number;
  private readonly previous: Int16Array;
  private parts: Uint8Array[] = [];
  private inChunk = 0;
  private frames = 0;
  private chunkStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly finished: Uint8Array[] = [];

  constructor(options: EncodeOptions, private readonly onChunk?: (bytes: Uint8Array) => void) {
    this.info = { cols: options.cols, rows: options.rows, fps: options.fps, chunkFrames: options.chunkFrames, frameCount: options.frameCount ?? 0 };
    validate(this.info);
    this.cells = options.cols * options.rows;
    this.threshold = options.threshold ?? 500;
    this.previous = new Int16Array(this.cells * 3);
    this.emit(writeHeader(this.info));
  }

  private emit(bytes: Uint8Array): void {
    this.finished.push(bytes);
    this.onChunk?.(bytes);
  }

  /** Adds a frame of `cols × rows` pixels, 3 or 4 bytes per pixel. */
  add(pixels: Uint8Array | Uint8ClampedArray): void {
    const stride = pixels.length / this.cells;
    if (stride !== 3 && stride !== 4) throw new GlyphcastError(`A frame must have ${this.cells * 3} or ${this.cells * 4} bytes, got ${pixels.length}`);
    const key = this.inChunk === 0;
    const high = new Uint8Array(this.cells);
    const low = new Uint8Array(this.cells);
    const changed = new Uint8Array(Math.ceil(this.cells / 8));
    let count = 0;
    for (let cell = 0; cell < this.cells; cell += 1) {
      const offset = cell * stride;
      const r = pixels[offset] ?? 0;
      const g = pixels[offset + 1] ?? 0;
      const b = pixels[offset + 2] ?? 0;
      const dr = r - (this.previous[cell * 3] ?? 0);
      const dg = g - (this.previous[cell * 3 + 1] ?? 0);
      const db = b - (this.previous[cell * 3 + 2] ?? 0);
      if (key || dr * dr + dg * dg + db * db > this.threshold) {
        this.previous[cell * 3] = r;
        this.previous[cell * 3 + 1] = g;
        this.previous[cell * 3 + 2] = b;
        const value = pack(r, g, b);
        high[count] = value >> 8;
        low[count] = value & 255;
        count += 1;
        changed[cell >> 3] = (changed[cell >> 3] ?? 0) | (1 << (cell & 7));
      }
    }
    this.parts.push(new Uint8Array([key ? 0 : 1]), key ? new Uint8Array(0) : changed, high.slice(0, count), low.slice(0, count));
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
    const parts = [header, ...this.finished.slice(1)];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Decodes one chunk payload into RGBA frames (`cols × rows × 4` bytes each), ready to upload as a texture. */
export const decodeChunk = async (info: Pick<StreamInfo, 'cols' | 'rows'>, compressed: Uint8Array): Promise<Uint8ClampedArray[]> => {
  const raw = await inflate(compressed);
  const cells = info.cols * info.rows;
  const maskSize = Math.ceil(cells / 8);
  const frames: Uint8ClampedArray[] = [];
  let current = new Uint8ClampedArray(cells * 4);
  let at = 0;
  while (at < raw.length) {
    const type = raw[at];
    at += 1;
    const frame = type === 0 ? new Uint8ClampedArray(cells * 4) : current.slice();
    let count = cells;
    let mask: Uint8Array | null = null;
    if (type === 1) {
      mask = raw.subarray(at, at + maskSize);
      at += maskSize;
      count = 0;
      for (const byte of mask) {
        let bits = byte;
        while (bits) {
          count += bits & 1;
          bits >>= 1;
        }
      }
    } else if (type !== 0) {
      throw new GlyphcastError(`Unknown frame type ${String(type)}`);
    }
    if (at + count * 2 > raw.length) throw new GlyphcastError('Truncated frame');
    const high = raw.subarray(at, at + count);
    const low = raw.subarray(at + count, at + count * 2);
    at += count * 2;
    let next = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      if (mask && !(((mask[cell >> 3] ?? 0) >> (cell & 7)) & 1)) continue;
      unpack(high[next] ?? 0, low[next] ?? 0, frame, cell * 4);
      next += 1;
    }
    frames.push(frame);
    current = frame;
  }
  return frames;
};
