import { decompress } from 'fzstd';
import { decodeChunk6, Encoder6, toPixels, toPlanes } from './codec6.js';
/** First four bytes of every `.gcast` stream. */
export const MAGIC = 0x54534347;
/** The oldest format version players read. */
export const VERSION = 3;
/** Detail streams with a second (dark side) color per patterned cell, written with `shades: true`, use version 4. */
export const DETAIL_VERSION = 4;
/** Chunks compressed with zstd instead of deflate (about 10-16% smaller); dark-side colors are bit 6 of byte 5. */
export const ZSTD_VERSION = 5;
/**
 * The current format: frames coded with an adaptive range coder (see codec6.ts) instead of a general-purpose
 * compressor, motion in dots, dot-level mask contexts. Encoders write only this version; players read 3 to 6.
 */
export const CODEC_VERSION = 6;
/** Bytes in a stream header. */
export const HEADER_SIZE = 20;
const CHUNK_HEAD = 6;
const INDEX_FRAMES = 0xffff;
const SUBTITLE_FRAMES = 0xfffe;
const INDEX_MAGIC = 0x58444947;
/** Chunk frame counts from here up to the subtitle mark are reserved for extensions: readers skip such chunks. */
const RESERVED_FRAMES = 0xfff0;
/** Bytes at the end of a file that point to its chunk index. */
export const INDEX_TRAILER = 8;

/** Where a chunk of frames starts in a file, for seeking with range requests. */
export interface IndexEntry {
  /** Byte offset of the chunk head from the start of the file. */
  readonly offset: number;
  readonly start: number;
  readonly frames: number;
}

/** What a stream header says: grid, frame rate, chunking, frame count, quantizer and flags. */
export interface StreamInfo {
  readonly cols: number;
  readonly rows: number;
  readonly fps: number;
  readonly chunkFrames: number;
  /** Total frames, or 0 for a live stream of unknown length. */
  readonly frameCount: number;
  /** Brightness steps (of 63) a cell may drift before it is sent again. Higher means smaller streams. Default 3. */
  readonly threshold: number;
  /** Frames carry a 2×4 dot pattern per cell taken from the source, for sharp text and lines. */
  readonly detail?: boolean;
  /** Version 4 detail streams: each patterned cell also stores the color of its dark dots. */
  readonly shades?: boolean;
  /** Version 5: chunks are compressed with zstd. */
  readonly zstd?: boolean;
  /** Format version from the header; streams written by this library are always `CODEC_VERSION`. */
  readonly version?: number;
}

/** How `Encoder` builds a stream. */
export interface EncodeOptions extends Omit<StreamInfo, 'frameCount' | 'threshold' | 'zstd' | 'version'> {
  /** Brightness steps (of 63) a cell may drift before it is sent again. Higher means smaller streams. Default 3. */
  readonly threshold?: number;
  /** Total frames if known in advance, written to the header. Default 0 (unknown). */
  readonly frameCount?: number;
  /** With `detail`: also store the dark side color of patterned cells where players would guess it wrong. */
  readonly shades?: boolean;
  /** Search motion only around the neighbors' vectors: several times faster, a few percent larger. For live streams. */
  readonly fast?: boolean;
}

/** A piece of a stream as `StreamReader` returns it: frames, sound or subtitles. */
export interface Chunk {
  /** Index of the first frame in the chunk. */
  readonly start: number;
  /** Frames in the chunk; 0 marks a piece of embedded audio, stored before the first frame. */
  readonly frames: number;
  /** Compressed payload, or raw audio bytes, without the 6-byte chunk head. */
  readonly data: Uint8Array;
  /** The chunk holds embedded WebVTT subtitles instead of frames or audio. */
  readonly subtitles?: boolean;
}

/** Errors of malformed streams and wrong arguments. */
export class GlyphcastError extends Error {
  override readonly name = 'GlyphcastError';
}

const BLOCK_W = 8;
const BLOCK_H = 4;
const VECTORS: readonly (readonly [number, number])[] = [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2], [-4, 0], [4, 0], [0, -4], [0, 4], [-6, 0], [6, 0]];
const RESIDUAL = 128;
const UNIFORM = 64;

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

/** Raw-deflate decompression, for format versions 3 and 4. */
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
  view.setUint8(4, CODEC_VERSION);
  view.setUint8(5, info.threshold | (info.detail ? 128 : 0) | (info.detail && info.shades ? 64 : 0));
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
  if (version < VERSION || version > CODEC_VERSION) throw new GlyphcastError(`Unsupported .gcast version ${version}; update glyphcast`);
  const flags = view.getUint8(5);
  const info = {
    cols: view.getUint16(6, true),
    rows: view.getUint16(8, true),
    fps: view.getFloat32(10, true),
    chunkFrames: view.getUint16(14, true),
    frameCount: view.getUint32(16, true),
    threshold: flags & (version >= ZSTD_VERSION ? 63 : 127),
    detail: (flags & 128) !== 0,
    shades: (flags & 128) !== 0 && (version === DETAIL_VERSION || (version >= ZSTD_VERSION && (flags & 64) !== 0)),
    zstd: version === ZSTD_VERSION,
    version,
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
      if (frames === INDEX_FRAMES || (frames >= RESERVED_FRAMES && frames < SUBTITLE_FRAMES)) {
        at += CHUNK_HEAD + size;
        continue;
      }
      if (frames === SUBTITLE_FRAMES) {
        chunks.push({ start: this.frames, frames: 0, subtitles: true, data: this.buffer.slice(at + CHUNK_HEAD, at + CHUNK_HEAD + size) });
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
 * 6-bit brightness with color shared by 2×2 cells (like 4:2:0 video), coded as described in codec6.ts. Every
 * `chunkFrames` frames (fewer at a scene cut) form a chunk that starts with a key frame, so playback can begin at
 * any chunk.
 *
 * `onChunk` receives each finished chunk, ready for a file or an HTTP response; `finish()` also returns a whole file.
 */
/** True when the brightness changed so much on average that the picture is a different shot. */
const sceneCut = (now: ArrayLike<number>, before: ArrayLike<number>): boolean => {
  let change = 0;
  let level = 0;
  const step = Math.max(1, Math.floor(now.length / 4000));
  let count = 0;
  for (let at = 0; at < now.length; at += step) {
    change += Math.abs((now[at] ?? 0) - (before[at] ?? 0));
    level += now[at] ?? 0;
    count += 1;
  }
  return change / count > Math.max(6, (level / count) * 0.3);
};

/** Builds a `.gcast` stream (format 6) from frames; see the details below. */
export class Encoder {
  readonly info: StreamInfo;
  private readonly coder: Encoder6;
  private previous: Uint8Array | null = null;
  private inChunk = 0;
  private frames = 0;
  private readonly finished: Uint8Array[] = [];
  private readonly lateAudio: Uint8Array[] = [];
  private subtitles: Uint8Array | null = null;

  constructor(options: EncodeOptions, private readonly onChunk?: (bytes: Uint8Array) => void) {
    this.info = { cols: options.cols, rows: options.rows, fps: options.fps, chunkFrames: options.chunkFrames, frameCount: options.frameCount ?? 0, threshold: options.threshold ?? 3, detail: options.detail ?? false, shades: Boolean(options.detail && options.shades), version: CODEC_VERSION };
    validate(this.info);
    this.coder = new Encoder6({ cols: options.cols, rows: options.rows, threshold: this.info.threshold, detail: this.info.detail ?? false, shades: this.info.shades ?? false, fast: options.fast ?? false });
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

  /**
   * Adds a frame of `cols × rows` pixels, 3 or 4 bytes per pixel. Streams with `detail` also take one byte per cell:
   * bit `y * 2 + x` is set where the cell's 2×4 sub-pixel is brighter than the cell, see `detailMasks`; with
   * `shades`, also the RGB of each cell's dark dots.
   */
  add(pixels: Uint8Array | Uint8ClampedArray, masks?: Uint8Array, shades?: Uint8Array): void {
    const shape = layout(this.info.cols, this.info.rows);
    const cells = shape.cols * shape.rows;
    const stride = pixels.length / cells;
    if (stride !== 3 && stride !== 4) throw new GlyphcastError(`A frame must have ${cells * 3} or ${cells * 4} bytes, got ${pixels.length}`);
    if (this.info.detail && (!masks || masks.length !== cells)) throw new GlyphcastError(`A detail stream needs ${cells} pattern bytes per frame`);
    const current = toPlanes(pixels, stride, shape);
    // a new scene starts a new chunk: its first frame is a key frame instead of a pile of residuals, and seeking
    // lands on scene starts
    if (this.previous && this.inChunk >= Math.max(4, this.info.chunkFrames >> 2) && sceneCut(current.y, this.previous)) this.flush();
    const frame = this.coder.add({ planes: current, ...(masks ? { masks } : {}), ...(this.info.shades && shades ? { shades } : {}) });
    this.previous = frame.planes.y;
    this.frames += 1;
    this.inChunk += 1;
    if (this.inChunk === this.info.chunkFrames) this.flush();
  }

  /**
   * Embeds WebVTT or SRT subtitles. They go first in the file from `finish()`, before the sound, and players show them
   * on their own. Live `onChunk` output does not get them.
   */
  addSubtitles(text: string): void {
    this.subtitles = frameChunk({ start: 0, frames: SUBTITLE_FRAMES, data: new TextEncoder().encode(text) });
  }

  private flush(): void {
    if (this.inChunk === 0) return;
    this.emit(frameChunk({ start: this.frames - this.inChunk, frames: this.inChunk, data: this.coder.finish() }));
    this.inChunk = 0;
  }

  /** Kept for callers that waited for compression; chunks are now emitted as soon as they are full. */
  drain(): Promise<void> {
    return Promise.resolve();
  }

  /** Flushes the last chunk and returns the whole stream; the header carries the final frame count. */
  async finish(): Promise<Uint8Array> {
    this.flush();
    const header = writeHeader({ ...this.info, frameCount: this.frames });
    const body = [...(this.subtitles ? [this.subtitles] : []), ...this.lateAudio, ...this.finished.slice(1)];
    const entries: IndexEntry[] = [];
    let offset = HEADER_SIZE;
    let start = 0;
    for (const part of body) {
      const frames = (part[4] ?? 0) | ((part[5] ?? 0) << 8);
      if (frames > 0 && frames < SUBTITLE_FRAMES) {
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
export const decodeChunk = async (info: Pick<StreamInfo, 'cols' | 'rows' | 'threshold' | 'detail' | 'shades' | 'zstd' | 'version'>, compressed: Uint8Array): Promise<Uint8ClampedArray[]> => (await decodeChunkMotion(info, compressed)).frames;

/** Decoded frames with the motion of every 8×4 block (dx, dy in cells per block), for interpolating between frames. */
export interface DecodedChunk {
  readonly frames: Uint8ClampedArray[];
  readonly motion: Int8Array[];
  /** Dot patterns per cell for detail streams. */
  readonly detail?: Uint8Array[];
  /** RGB of the dark dots per cell, version 4 detail streams only. */
  readonly shades?: Uint8Array[];
}

/** Like `decodeChunk`, and also returns where each block of each frame came from in the previous one. */
export const decodeChunkMotion = async (info: Pick<StreamInfo, 'cols' | 'rows' | 'threshold' | 'detail' | 'shades' | 'zstd' | 'version'>, compressed: Uint8Array): Promise<DecodedChunk> => {
  if ((info.version ?? 0) >= CODEC_VERSION) {
    const shape = layout(info.cols, info.rows);
    let decoded;
    try {
      decoded = decodeChunk6({ cols: info.cols, rows: info.rows, threshold: info.threshold, detail: info.detail ?? false, shades: Boolean(info.detail && info.shades) }, compressed);
    } catch (error) {
      throw new GlyphcastError(error instanceof Error ? error.message : String(error));
    }
    const frames = decoded.map((frame) => toPixels(frame.planes, shape));
    const motion = decoded.map((frame) => frame.motion);
    if (!info.detail) return { frames, motion };
    const detail = decoded.map((frame) => frame.masks);
    return info.shades ? { frames, motion, detail, shades: decoded.map((frame) => frame.shades ?? new Uint8Array(info.cols * info.rows * 3)) } : { frames, motion, detail };
  }
  const raw = info.zstd ? decompress(compressed) : await inflate(compressed);
  const shape = layout(info.cols, info.rows);
  const { size } = steps(info.threshold);
  const frames: Uint8ClampedArray[] = [];
  const motion: Int8Array[] = [];
  const detail: Uint8Array[] = [];
  let patterns = new Uint8Array(info.cols * info.rows);
  const shades: Uint8Array[] = [];
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
      if (mode === UNIFORM) {
        counts.y += 1;
        counts.u += 1;
        counts.v += 1;
      } else if (mode & RESIDUAL) visit(shape, block, (plane) => (counts[plane] += 1));
    });
    const offsets = { y: at, u: at + counts.y, v: at + counts.y + counts.u };
    at += counts.y + counts.u + counts.v;
    if (modes.length < shape.blocks || at > raw.length) throw new GlyphcastError('Truncated frame');
    const next = planes(shape);
    const vectors = new Int8Array(shape.blocks * 2);
    modes.forEach((mode, block) => {
      if (mode !== UNIFORM && type === 1) {
        const [mx, my] = VECTORS[mode & ~RESIDUAL] ?? [0, 0];
        vectors[block * 2] = mx;
        vectors[block * 2 + 1] = my;
      }
      if (mode === UNIFORM) {
        const fill = { y: raw[offsets.y] ?? 0, u: raw[offsets.u] ?? 0, v: raw[offsets.v] ?? 0 };
        offsets.y += 1;
        offsets.u += 1;
        offsets.v += 1;
        visit(shape, block, (plane, index) => {
          next[plane][index] = fill[plane];
        });
        return;
      }
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
    motion.push(vectors);
    if (info.detail) {
      const flags = raw.subarray(at, at + Math.ceil(shape.blocks / 8));
      at += flags.length;
      const reference = type === 0 ? new Uint8Array(patterns.length) : patterns;
      const masks = new Uint8Array(patterns.length);
      for (let block = 0; block < shape.blocks; block += 1) {
        const explicit = ((flags[block >> 3] ?? 0) >> (block & 7)) & 1;
        const [dx, dy] = blockVector(modes[block] ?? 0);
        blockCells(shape, block, (index, x, y) => {
          if (explicit) {
            masks[index] = raw[at] ?? 0;
            at += 1;
          } else masks[index] = reference[clampTo(y + dy, shape.rows) * shape.cols + clampTo(x + dx, shape.cols)] ?? 0;
        });
      }
      if (at > raw.length) throw new GlyphcastError('Truncated frame');
      if (info.shades) {
        // zero means "not stored": players then guess from the neighbors as they do for older files
        const next = new Uint8Array(masks.length * 3);
        const darkFlags = raw.subarray(at, at + Math.ceil(shape.blocks / 8));
        at += darkFlags.length;
        for (let block = 0; block < shape.blocks; block += 1) {
          if (!(((darkFlags[block >> 3] ?? 0) >> (block & 7)) & 1)) continue;
          blockCells(shape, block, (index) => {
            if (!masks[index]) return;
            for (let channel = 0; channel < 3; channel += 1) next[index * 3 + channel] = ((raw[at + channel] ?? 0) << 2) | 2;
            at += 3;
          });
        }
        if (at > raw.length) throw new GlyphcastError('Truncated frame');
        shades.push(next);
      }
      patterns = masks;
      detail.push(masks);
    }
  }
  return info.detail ? { frames, motion, detail, ...(info.shades ? { shades } : {}) } : { frames, motion };
};

const blockCells = (shape: Layout, block: number, each: (index: number, x: number, y: number) => void): void => {
  const bx = (block % shape.blocksX) * BLOCK_W;
  const by = Math.floor(block / shape.blocksX) * BLOCK_H;
  for (let y = by; y < Math.min(by + BLOCK_H, shape.rows); y += 1) for (let x = bx; x < Math.min(bx + BLOCK_W, shape.cols); x += 1) each(y * shape.cols + x, x, y);
};

const blockVector = (mode: number): readonly [number, number] => (mode === UNIFORM ? [0, 0] : (VECTORS[mode & ~RESIDUAL] ?? [0, 0]));

/**
 * Dot patterns for a detail stream from a frame at twice the width and four times the height of the grid, RGB or
 * RGBA: one byte per cell, bit `y * 2 + x` set where that sub-pixel is clearly brighter than the cell's average. Such cells carry the color of their bright dots.
 * Flat cells get 0, so players fall back to their usual drawing there.
 */
export const detailMasks = (pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, stride = 3, previous?: number): { readonly cells: Uint8ClampedArray; readonly masks: Uint8Array; readonly shades: Uint8Array; readonly bar: number } => {
  const width = cols * 2;
  const count = cols * rows;
  const cells = new Uint8ClampedArray(count * 4);
  const masks = new Uint8Array(count);
  const shades = new Uint8Array(count * 3);
  const lumas = new Float32Array(count * 8);
  const spreads = new Float32Array(count);
  const offset = (cell: number, dot: number): number => ((Math.floor(cell / cols) * 4 + (dot >> 1)) * width + (cell % cols) * 2 + (dot & 1)) * stride;
  for (let cell = 0; cell < count; cell += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let low = 255;
    let high = 0;
    for (let dot = 0; dot < 8; dot += 1) {
      const at = offset(cell, dot);
      const pr = pixels[at] ?? 0;
      const pg = pixels[at + 1] ?? 0;
      const pb = pixels[at + 2] ?? 0;
      r += pr;
      g += pg;
      b += pb;
      const luma = pr * 0.299 + pg * 0.587 + pb * 0.114;
      lumas[cell * 8 + dot] = luma;
      low = Math.min(low, luma);
      high = Math.max(high, luma);
    }
    cells[cell * 4] = r / 8;
    cells[cell * 4 + 1] = g / 8;
    cells[cell * 4 + 2] = b / 8;
    cells[cell * 4 + 3] = 255;
    spreads[cell] = high - low;
  }
  // the bar follows the frame: a clean or dark frame keeps faint lines, film grain everywhere raises it so noise stays flat
  const median = Float32Array.from(spreads).sort()[count >> 1] ?? 0;
  const target = Math.min(96, Math.max(48, median * 2 + 48));
  // `previous` is the last frame's bar: following it slowly keeps patterns from blinking on and off in motion
  const bar = previous === undefined ? target : previous + (target - previous) * 0.15;
  for (let cell = 0; cell < count; cell += 1) {
    if ((spreads[cell] ?? 0) < bar) continue;
    let low = 255;
    let high = 0;
    for (let dot = 0; dot < 8; dot += 1) {
      low = Math.min(low, lumas[cell * 8 + dot] ?? 0);
      high = Math.max(high, lumas[cell * 8 + dot] ?? 0);
    }
    const middle = (high + low) / 2;
    let mask = 0;
    let lit = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let dr = 0;
    let dg = 0;
    let db = 0;
    for (let dot = 0; dot < 8; dot += 1) {
      if ((lumas[cell * 8 + dot] ?? 0) <= middle) {
        const at = offset(cell, dot);
        dr += pixels[at] ?? 0;
        dg += pixels[at + 1] ?? 0;
        db += pixels[at + 2] ?? 0;
        continue;
      }
      mask |= 1 << dot;
      lit += 1;
      const at = offset(cell, dot);
      r += pixels[at] ?? 0;
      g += pixels[at + 1] ?? 0;
      b += pixels[at + 2] ?? 0;
    }
    // a patterned cell is drawn as its lit dots, so it takes their color: thin bright lines stay bright
    cells[cell * 4] = r / lit;
    cells[cell * 4 + 1] = g / lit;
    cells[cell * 4 + 2] = b / lit;
    masks[cell] = mask;
    // the dark dots' own color, so players draw both sides of an edge as they are
    const dark = 8 - lit;
    shades[cell * 3] = dr / dark;
    shades[cell * 3 + 1] = dg / dark;
    shades[cell * 3 + 2] = db / dark;
  }
  return { cells, masks, shades, bar };
};

/**
 * A frame between two decoded frames at `t` from 0 to 1: colors are blended, and blocks that moved are drawn
 * part of the way along their motion vector, so playback looks smoother than the stream's frame rate.
 */
export const interpolate = (from: Uint8ClampedArray, to: Uint8ClampedArray, motion: Int8Array, cols: number, rows: number, t: number): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(to.length);
  for (let index = 0; index < out.length; index += 1) out[index] = (from[index] ?? 0) + ((to[index] ?? 0) - (from[index] ?? 0)) * t;
  const blocksX = Math.ceil(cols / BLOCK_W);
  for (let block = 0; block < motion.length / 2; block += 1) {
    const dx = motion[block * 2] ?? 0;
    const dy = motion[block * 2 + 1] ?? 0;
    if (dx === 0 && dy === 0) continue;
    const ox = Math.round(dx * (1 - t));
    const oy = Math.round(dy * (1 - t));
    const bx = (block % blocksX) * BLOCK_W;
    const by = Math.floor(block / blocksX) * BLOCK_H;
    for (let y = by; y < Math.min(by + BLOCK_H, rows); y += 1) {
      const ty = y + oy;
      if (ty < 0 || ty >= rows) continue;
      for (let x = bx; x < Math.min(bx + BLOCK_W, cols); x += 1) {
        const tx = x + ox;
        if (tx < 0 || tx >= cols) continue;
        const source = (y * cols + x) * 4;
        const target = (ty * cols + tx) * 4;
        out[target] = to[source] ?? 0;
        out[target + 1] = to[source + 1] ?? 0;
        out[target + 2] = to[source + 2] ?? 0;
      }
    }
  }
  return out;
};
