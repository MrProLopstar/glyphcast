export const MAGIC = 0x54534347;
export const VERSION = 1;
const HEADER_SIZE = 24;
const ENTRY_SIZE = 8;

export interface StreamInfo {
  readonly cols: number;
  readonly rows: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly chunkFrames: number;
}

export interface EncodeOptions extends Omit<StreamInfo, 'frameCount'> {
  /** Squared RGB distance below which a cell keeps its previous color. Higher means smaller streams. Default 500. */
  readonly threshold?: number;
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

/**
 * Builds a `.gcast` stream frame by frame. Frames are RGB24 or RGBA pixels at the grid size; colors are stored
 * as 12-bit RGB in two byte planes, cells that barely changed are skipped, and every `chunkFrames` frames form an independently compressed chunk
 * that starts with a key frame, so playback can seek to any chunk.
 */
export class Encoder {
  private readonly cells: number;
  private readonly threshold: number;
  private readonly previous: Int16Array;
  private readonly chunks: Promise<Uint8Array>[] = [];
  private parts: Uint8Array[] = [];
  private frames = 0;

  constructor(private readonly options: EncodeOptions) {
    validate(options);
    this.cells = options.cols * options.rows;
    this.threshold = options.threshold ?? 500;
    this.previous = new Int16Array(this.cells * 3);
  }

  /** Adds a frame of `cols × rows` pixels, 3 or 4 bytes per pixel. */
  add(pixels: Uint8Array | Uint8ClampedArray): void {
    const stride = pixels.length / this.cells;
    if (stride !== 3 && stride !== 4) throw new GlyphcastError(`A frame must have ${this.cells * 3} or ${this.cells * 4} bytes, got ${pixels.length}`);
    const key = this.frames % this.options.chunkFrames === 0;
    if (key && this.parts.length > 0) this.flush();
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
  }

  private flush(): void {
    const size = this.parts.reduce((sum, part) => sum + part.length, 0);
    const raw = new Uint8Array(size);
    let at = 0;
    for (const part of this.parts) {
      raw.set(part, at);
      at += part.length;
    }
    this.chunks.push(deflate(raw));
    this.parts = [];
  }

  /** Finishes the stream and returns the `.gcast` bytes. */
  async finish(): Promise<Uint8Array> {
    if (this.parts.length > 0) this.flush();
    const chunks = await Promise.all(this.chunks);
    const tableSize = chunks.length * ENTRY_SIZE;
    const total = HEADER_SIZE + tableSize + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint8(4, VERSION);
    view.setUint16(6, this.options.cols, true);
    view.setUint16(8, this.options.rows, true);
    view.setFloat32(10, this.options.fps, true);
    view.setUint32(14, this.frames, true);
    view.setUint16(18, this.options.chunkFrames, true);
    view.setUint32(20, chunks.length, true);
    let offset = HEADER_SIZE + tableSize;
    chunks.forEach((chunk, index) => {
      view.setUint32(HEADER_SIZE + index * ENTRY_SIZE, offset, true);
      view.setUint32(HEADER_SIZE + index * ENTRY_SIZE + 4, chunk.length, true);
      out.set(chunk, offset);
      offset += chunk.length;
    });
    return out;
  }
}

export interface Header extends StreamInfo {
  readonly chunks: readonly { readonly offset: number; readonly size: number }[];
  /** Bytes needed before chunk data starts. */
  readonly dataStart: number;
}

/** Reads the header and chunk table. Throws `GlyphcastError` if the bytes are not a complete `.gcast` header. */
export const readHeader = (bytes: Uint8Array): Header => {
  if (bytes.length < HEADER_SIZE) throw new GlyphcastError('Not enough bytes for a .gcast header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new GlyphcastError('Not a .gcast stream');
  const version = view.getUint8(4);
  if (version !== VERSION) throw new GlyphcastError(`Unsupported .gcast version ${version}`);
  const count = view.getUint32(20, true);
  const dataStart = HEADER_SIZE + count * ENTRY_SIZE;
  if (bytes.length < dataStart) throw new GlyphcastError('Not enough bytes for the chunk table');
  const info = {
    cols: view.getUint16(6, true),
    rows: view.getUint16(8, true),
    fps: view.getFloat32(10, true),
    frameCount: view.getUint32(14, true),
    chunkFrames: view.getUint16(18, true),
  };
  validate(info);
  const chunks = Array.from({ length: count }, (_, index) => ({
    offset: view.getUint32(HEADER_SIZE + index * ENTRY_SIZE, true),
    size: view.getUint32(HEADER_SIZE + index * ENTRY_SIZE + 4, true),
  }));
  return { ...info, chunks, dataStart };
};

/**
 * Decodes one compressed chunk into RGBA frames (`cols × rows × 4` bytes each), ready to upload as a texture.
 */
export const decodeChunk = async (info: StreamInfo, compressed: Uint8Array): Promise<Uint8ClampedArray[]> => {
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
