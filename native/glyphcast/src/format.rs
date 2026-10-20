//! The `.gcast` container: header, chunks (frames, sound, subtitles, index), reading as bytes arrive and writing a
//! finished or live stream. Port of `format.ts`.

use crate::codec::{self, clamped, ChunkEncoder, Options, Shape, Source};

pub const MAGIC: u32 = 0x5453_4347;
/// The only version this crate writes and reads; the npm package also reads the older 3–5.
pub const VERSION: u8 = 6;
pub const HEADER_SIZE: usize = 20;
const INDEX_FRAMES: u16 = 0xffff;
const SUBTITLE_FRAMES: u16 = 0xfffe;
const RESERVED_FRAMES: u16 = 0xfff0;
const INDEX_MAGIC: u32 = 0x5844_4947;

/// What the header says about a stream.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Info {
    pub cols: usize,
    pub rows: usize,
    pub fps: f64,
    /// Nominal frames per chunk.
    pub chunk_frames: usize,
    /// Total frames, 0 for a live stream.
    pub frames: usize,
    /// Default quantizer threshold (0–63).
    pub threshold: u8,
    /// Frames carry a 2×4 dot mask per cell.
    pub detail: bool,
    /// Patterned cells may carry the color of their dark dots.
    pub shades: bool,
}

#[derive(Debug)]
pub enum Error {
    NotGcast,
    /// A version this crate does not read (3–5 are read by the npm package).
    Version(u8),
    Damaged(&'static str),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::NotGcast => write!(f, "not a .gcast stream"),
            Error::Version(v) => write!(f, "format version {v}: this reads glyphcast 1.0 files (version 6); re-encode older ones"),
            Error::Damaged(what) => write!(f, "damaged .gcast: {what}"),
        }
    }
}
impl std::error::Error for Error {}

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

pub fn read_header(bytes: &[u8]) -> Result<Info, Error> {
    if bytes.len() < HEADER_SIZE || u32le(bytes, 0) != MAGIC {
        return Err(Error::NotGcast);
    }
    if bytes[4] != VERSION {
        return Err(Error::Version(bytes[4]));
    }
    let flags = bytes[5];
    let info = Info {
        cols: u16le(bytes, 6) as usize,
        rows: u16le(bytes, 8) as usize,
        fps: f32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]) as f64,
        chunk_frames: u16le(bytes, 14) as usize,
        frames: u32le(bytes, 16) as usize,
        threshold: flags & 63,
        detail: flags & 128 != 0,
        shades: flags & 128 != 0 && flags & 64 != 0,
    };
    if info.cols == 0 || info.rows == 0 || info.cols > 4096 || info.rows > 4096 || !(info.fps > 0.0 && info.fps <= 240.0) {
        return Err(Error::Damaged("header"));
    }
    Ok(info)
}

pub fn write_header(info: &Info) -> [u8; HEADER_SIZE] {
    let mut out = [0u8; HEADER_SIZE];
    out[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    out[4] = VERSION;
    out[5] = info.threshold | if info.detail { 128 } else { 0 } | if info.detail && info.shades { 64 } else { 0 };
    out[6..8].copy_from_slice(&(info.cols as u16).to_le_bytes());
    out[8..10].copy_from_slice(&(info.rows as u16).to_le_bytes());
    out[10..14].copy_from_slice(&(info.fps as f32).to_le_bytes());
    out[14..16].copy_from_slice(&(info.chunk_frames as u16).to_le_bytes());
    out[16..20].copy_from_slice(&(info.frames as u32).to_le_bytes());
    out
}

fn frame_chunk(kind: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(6 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(data);
    out
}

// ---- reading ----

/// A chunk of frames, still compressed.
pub struct Chunk {
    /// Index of its first frame.
    pub start: usize,
    pub frames: usize,
    pub data: Vec<u8>,
}

/// A stream read as it arrives (a file, a download, a live stream): push bytes, take what is complete.
#[derive(Default)]
pub struct Reader {
    pub info: Option<Info>,
    pub chunks: Vec<Chunk>,
    /// The embedded audio file (Ogg Opus and others), complete once the first frame chunk has arrived.
    pub audio: Vec<u8>,
    pub subtitles: Option<String>,
    pending: Vec<u8>,
    frames: usize,
}

impl Reader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Frames in the stream: the header's count, or what has arrived of a live stream.
    pub fn total(&self) -> usize {
        self.info.map(|i| i.frames).unwrap_or(0).max(self.frames)
    }

    /// The sound comes before the first frame chunk, so it is complete once one has arrived.
    pub fn audio_ready(&self) -> bool {
        !self.chunks.is_empty()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.pending.extend_from_slice(bytes);
        let mut at = 0;
        if self.info.is_none() {
            if self.pending.len() < HEADER_SIZE {
                return Ok(());
            }
            self.info = Some(read_header(&self.pending[..HEADER_SIZE])?);
            at = HEADER_SIZE;
        }
        while self.pending.len() - at >= 6 {
            let size = u32le(&self.pending, at) as usize;
            let kind = u16le(&self.pending, at + 4);
            if self.pending.len() - at - 6 < size {
                break;
            }
            let data = &self.pending[at + 6..at + 6 + size];
            match kind {
                0 => self.audio.extend_from_slice(data),
                SUBTITLE_FRAMES => self.subtitles = Some(String::from_utf8_lossy(data).into_owned()),
                INDEX_FRAMES => {}
                k if k >= RESERVED_FRAMES => {}
                k => {
                    self.chunks.push(Chunk { start: self.frames, frames: k as usize, data: data.to_vec() });
                    self.frames += k as usize;
                }
            }
            at += 6 + size;
        }
        self.pending.drain(..at);
        Ok(())
    }
}

/// A frame ready to draw.
pub struct Frame {
    /// RGB per cell.
    pub rgb: Vec<[u8; 3]>,
    /// 2×4 dot mask per cell (bit y·2+x), all 0 without detail.
    pub masks: Vec<u8>,
    /// RGB of the dark dots of patterned cells, [0, 0, 0] where not stored.
    pub shades: Option<Vec<[u8; 3]>>,
    /// Each 8×4-cell block's motion in cells, for frames in between.
    pub motion: Vec<i8>,
}

/// Decodes one chunk of frames.
pub fn decode_chunk(info: &Info, data: &[u8]) -> Result<Vec<Frame>, Error> {
    let options = Options { cols: info.cols, rows: info.rows, threshold: info.threshold as i32, detail: info.detail, shades: info.shades, fast: false };
    let shape = Shape::new(info.cols, info.rows);
    let frames = codec::decode_chunk(options, data).map_err(Error::Damaged)?;
    Ok(frames
        .into_iter()
        .map(|f| Frame {
            rgb: codec::to_pixels(&f.planes, &shape),
            masks: f.masks,
            shades: f.shades.map(|s| s.chunks(3).map(|c| [c[0], c[1], c[2]]).collect()),
            motion: f.motion,
        })
        .collect())
}

// ---- writing ----

/// Dot patterns of a frame given at twice the width and four times the height of the grid (RGB or RGBA): the
/// cells' colors (the lit dots' color for patterned cells), their masks and their dark sides, and the threshold
/// used, to pass back as `previous` for the next frame.
pub struct Patterns {
    pub cells: Vec<u8>,
    pub masks: Vec<u8>,
    pub shades: Vec<u8>,
    pub bar: f64,
}

pub fn detail_masks(pixels: &[u8], cols: usize, rows: usize, stride: usize, previous: Option<f64>) -> Patterns {
    let width = cols * 2;
    let count = cols * rows;
    let mut cells = vec![0u8; count * 3];
    let mut masks = vec![0u8; count];
    let mut shades = vec![0u8; count * 3];
    let mut lumas = vec![0f32; count * 8];
    let mut spreads = vec![0f32; count];
    let offset = |cell: usize, dot: usize| ((cell / cols * 4 + (dot >> 1)) * width + (cell % cols) * 2 + (dot & 1)) * stride;
    for cell in 0..count {
        let (mut r, mut g, mut b) = (0f64, 0f64, 0f64);
        let (mut low, mut high) = (255f64, 0f64);
        for dot in 0..8 {
            let at = offset(cell, dot);
            let (pr, pg, pb) = (pixels[at] as f64, pixels[at + 1] as f64, pixels[at + 2] as f64);
            r += pr;
            g += pg;
            b += pb;
            let luma = pr * 0.299 + pg * 0.587 + pb * 0.114;
            lumas[cell * 8 + dot] = luma as f32;
            low = low.min(luma);
            high = high.max(luma);
        }
        cells[cell * 3] = clamped(r / 8.0);
        cells[cell * 3 + 1] = clamped(g / 8.0);
        cells[cell * 3 + 2] = clamped(b / 8.0);
        spreads[cell] = (high - low) as f32;
    }
    let mut sorted = spreads.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted.get(count >> 1).copied().unwrap_or(0.0) as f64;
    let target = (median * 2.0 + 48.0).max(48.0).min(96.0);
    let bar = match previous {
        Some(p) => p + (target - p) * 0.15,
        None => target,
    };
    for cell in 0..count {
        if (spreads[cell] as f64) < bar {
            continue;
        }
        let (mut low, mut high) = (255f64, 0f64);
        for dot in 0..8 {
            low = low.min(lumas[cell * 8 + dot] as f64);
            high = high.max(lumas[cell * 8 + dot] as f64);
        }
        let middle = (high + low) / 2.0;
        let (mut mask, mut lit) = (0u8, 0u32);
        let (mut r, mut g, mut b, mut dr, mut dg, mut db) = (0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
        for dot in 0..8 {
            let at = offset(cell, dot);
            if lumas[cell * 8 + dot] as f64 <= middle {
                dr += pixels[at] as u32;
                dg += pixels[at + 1] as u32;
                db += pixels[at + 2] as u32;
                continue;
            }
            mask |= 1 << dot;
            lit += 1;
            r += pixels[at] as u32;
            g += pixels[at + 1] as u32;
            b += pixels[at + 2] as u32;
        }
        cells[cell * 3] = clamped(r as f64 / lit as f64);
        cells[cell * 3 + 1] = clamped(g as f64 / lit as f64);
        cells[cell * 3 + 2] = clamped(b as f64 / lit as f64);
        masks[cell] = mask;
        let dark = 8 - lit;
        shades[cell * 3] = (dr / dark) as u8;
        shades[cell * 3 + 1] = (dg / dark) as u8;
        shades[cell * 3 + 2] = (db / dark) as u8;
    }
    Patterns { cells, masks, shades, bar }
}

/// How to encode.
#[derive(Clone, Copy)]
pub struct EncodeOptions {
    pub cols: usize,
    pub rows: usize,
    pub fps: f64,
    /// Frames per chunk (a seek point each); about two seconds is usual.
    pub chunk_frames: usize,
    /// How much a cell may drift before it is sent again (0–63); 3 by default.
    pub threshold: u8,
    pub detail: bool,
    pub shades: bool,
    /// Search motion only around the neighbors' vectors: several times faster, a little larger. For live streams.
    pub fast: bool,
}

impl EncodeOptions {
    pub fn new(cols: usize, rows: usize, fps: f64) -> Self {
        EncodeOptions { cols, rows, fps, chunk_frames: (fps * 2.0).round().max(1.0) as usize, threshold: 3, detail: false, shades: false, fast: false }
    }
}

fn scene_cut(now: &[u8], before: &[u8]) -> bool {
    let step = (now.len() / 4000).max(1);
    let (mut change, mut level, mut count) = (0f64, 0f64, 0f64);
    let mut at = 0;
    while at < now.len() {
        change += (now[at] as f64 - before[at] as f64).abs();
        level += now[at] as f64;
        count += 1.0;
        at += step;
    }
    change / count > 6f64.max(level / count * 0.3)
}

/// Builds a `.gcast` stream frame by frame. `on_chunk` gets every piece as it is ready (for live streams);
/// `finish` returns the whole file with sound and subtitles first and the index last.
pub struct Encoder {
    info: Info,
    shape: Shape,
    coder: ChunkEncoder,
    previous: Option<Vec<u8>>,
    in_chunk: usize,
    frames: usize,
    finished: Vec<Vec<u8>>,
    late_audio: Vec<Vec<u8>>,
    subtitles: Option<Vec<u8>>,
    on_chunk: Option<Box<dyn FnMut(&[u8]) + Send>>,
}

impl Encoder {
    pub fn new(options: EncodeOptions) -> Self {
        let info = Info { cols: options.cols, rows: options.rows, fps: options.fps, chunk_frames: options.chunk_frames.max(1), frames: 0, threshold: options.threshold.min(63), detail: options.detail, shades: options.detail && options.shades };
        let coder = ChunkEncoder::new(Options { cols: info.cols, rows: info.rows, threshold: info.threshold as i32, detail: info.detail, shades: info.shades, fast: options.fast });
        let mut encoder = Encoder { info, shape: Shape::new(info.cols, info.rows), coder, previous: None, in_chunk: 0, frames: 0, finished: Vec::new(), late_audio: Vec::new(), subtitles: None, on_chunk: None };
        encoder.emit(write_header(&info).to_vec());
        encoder
    }

    /// Calls `callback` with the header and then each chunk as it is ready, for streaming.
    pub fn on_chunk(mut self, callback: impl FnMut(&[u8]) + Send + 'static) -> Self {
        if let Some(header) = self.finished.first() {
            let mut callback = callback;
            callback(header);
            self.on_chunk = Some(Box::new(callback));
        }
        self
    }

    fn emit(&mut self, bytes: Vec<u8>) {
        if let Some(callback) = self.on_chunk.as_mut() {
            callback(&bytes);
        }
        self.finished.push(bytes);
    }

    /// Embeds an audio file (Ogg Opus is what players read windowed); it goes before the first frame.
    pub fn add_audio(&mut self, bytes: &[u8]) {
        let pieces: Vec<Vec<u8>> = bytes.chunks(65536).map(|piece| frame_chunk(0, piece)).collect();
        if self.frames > 0 || self.in_chunk > 0 {
            self.late_audio.extend(pieces);
        } else {
            for piece in pieces {
                self.emit(piece);
            }
        }
    }

    /// Embeds WebVTT or SRT subtitles; they go first in the file from `finish`.
    pub fn add_subtitles(&mut self, text: &str) {
        self.subtitles = Some(frame_chunk(SUBTITLE_FRAMES, text.as_bytes()));
    }

    /// Adds a frame of `cols × rows` cells, 3 or 4 bytes each. Detail streams also take one mask byte per cell, and
    /// shades streams the dark sides (RGB per cell) — see `detail_masks`.
    pub fn add(&mut self, pixels: &[u8], masks: Option<&[u8]>, shades: Option<&[u8]>) -> Result<(), Error> {
        let cells = self.shape.cols * self.shape.rows;
        let stride = pixels.len() / cells.max(1);
        if (stride != 3 && stride != 4) || pixels.len() != cells * stride {
            return Err(Error::Damaged("a frame must have 3 or 4 bytes per cell"));
        }
        if self.info.detail && masks.map(|m| m.len()) != Some(cells) {
            return Err(Error::Damaged("a detail stream needs one mask byte per cell"));
        }
        let planes = codec::to_planes(pixels, stride, &self.shape);
        if let Some(previous) = &self.previous {
            if self.in_chunk >= 4.max(self.info.chunk_frames >> 2) && scene_cut(&planes.p[0], previous) {
                self.flush();
            }
        }
        let source = Source { planes, masks, shades: if self.info.shades { shades } else { None }, threshold: None, intra_threshold: None };
        let frame = self.coder.add(&source);
        self.previous = Some(frame.planes.p[0].clone());
        self.frames += 1;
        self.in_chunk += 1;
        if self.in_chunk == self.info.chunk_frames {
            self.flush();
        }
        Ok(())
    }

    fn flush(&mut self) {
        if self.in_chunk == 0 {
            return;
        }
        let data = self.coder.finish();
        let chunk = frame_chunk(self.in_chunk as u16, &data);
        self.emit(chunk);
        self.in_chunk = 0;
    }

    /// The whole stream: header with the frame count, subtitles, sound, frames and the chunk index.
    pub fn finish(mut self) -> Vec<u8> {
        self.flush();
        let header = write_header(&Info { frames: self.frames, ..self.info });
        let mut body: Vec<&[u8]> = Vec::new();
        if let Some(s) = &self.subtitles {
            body.push(s);
        }
        body.extend(self.late_audio.iter().map(|v| v.as_slice()));
        body.extend(self.finished.iter().skip(1).map(|v| v.as_slice()));
        let mut index = Vec::new();
        let (mut offset, mut start) = (HEADER_SIZE as f64, 0u32);
        for part in &body {
            let frames = u16le(part, 4);
            if frames > 0 && frames < SUBTITLE_FRAMES {
                index.extend_from_slice(&offset.to_le_bytes());
                index.extend_from_slice(&start.to_le_bytes());
                index.extend_from_slice(&(frames as u32).to_le_bytes());
                start += frames as u32;
            }
            offset += part.len() as f64;
        }
        let length = 6 + index.len() + 8;
        index.extend_from_slice(&(length as u32).to_le_bytes());
        index.extend_from_slice(&INDEX_MAGIC.to_le_bytes());
        let mut out = header.to_vec();
        for part in body {
            out.extend_from_slice(part);
        }
        out.extend(frame_chunk(INDEX_FRAMES, &index));
        out
    }
}

