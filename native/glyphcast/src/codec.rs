//! Frame coding of `.gcast` version 6, encoder and decoder in one: every syntax element goes through one adaptive
//! binary range coder with contexts, and both directions run the same code, so they reconstruct the same frames.
//! A line-by-line port of `codec6.ts`; FORMAT.md describes the bitstream.

use std::collections::HashSet;

pub const BLOCK_W: usize = 8;
pub const BLOCK_H: usize = 4;
const RANGE: i32 = 64;
const DISTORTION: f64 = 1.0;
const MASK_TOLERANCE: u32 = 6;
const COARSE: f64 = 2.0;

/// Like JavaScript's Math.round.
pub(crate) fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// A store into a Uint8ClampedArray: clamped, rounded half to even.
pub(crate) fn clamped(x: f64) -> u8 {
    if !(x > 0.0) {
        0
    } else if x >= 255.0 {
        255
    } else {
        x.round_ties_even() as u8
    }
}

/// Brightness per cell (0–63) and color per 2×2 cells (0–31).
#[derive(Clone)]
pub struct Planes {
    pub p: [Vec<u8>; 3],
}

#[derive(Clone, Copy)]
pub struct Shape {
    pub cols: usize,
    pub rows: usize,
    pub half_cols: usize,
    pub half_rows: usize,
    pub blocks_x: usize,
    pub blocks: usize,
}

impl Shape {
    pub fn new(cols: usize, rows: usize) -> Shape {
        let blocks_x = cols.div_ceil(BLOCK_W);
        Shape { cols, rows, half_cols: cols.div_ceil(2), half_rows: rows.div_ceil(2), blocks_x, blocks: blocks_x * rows.div_ceil(BLOCK_H) }
    }
}

pub fn empty_planes(shape: &Shape, gray: bool) -> Planes {
    let (y, c) = if gray { (32, 16) } else { (0, 0) };
    Planes { p: [vec![y; shape.cols * shape.rows], vec![c; shape.half_cols * shape.half_rows], vec![c; shape.half_cols * shape.half_rows]] }
}

fn steps_of(threshold: i32) -> [i32; 3] {
    let chroma = round(threshold as f64 / 3.0) as i32;
    [threshold * 2 + 1, chroma * 2 + 1, chroma * 2 + 1]
}

/// RGB cells (3 or 4 bytes each) to planes, as players and encoders of glyphcast compute them.
pub fn to_planes(pixels: &[u8], stride: usize, shape: &Shape) -> Planes {
    let mut out = empty_planes(shape, false);
    let halves = shape.half_cols * shape.half_rows;
    let (mut u, mut v) = (vec![0f32; halves], vec![0f32; halves]);
    let mut weight = vec![0u8; halves];
    for row in 0..shape.rows {
        for col in 0..shape.cols {
            let cell = row * shape.cols + col;
            let (r, g, b) = (pixels[cell * stride] as f64, pixels[cell * stride + 1] as f64, pixels[cell * stride + 2] as f64);
            out.p[0][cell] = round(((0.299 * r + 0.587 * g + 0.114 * b) * 63.0) / 255.0) as u8;
            let half = (row >> 1) * shape.half_cols + (col >> 1);
            u[half] = (u[half] as f64 + (-0.168736 * r - 0.331264 * g + 0.5 * b)) as f32;
            v[half] = (v[half] as f64 + (0.5 * r - 0.418688 * g - 0.081312 * b)) as f32;
            weight[half] = weight[half].wrapping_add(1);
        }
    }
    for half in 0..halves {
        let count = if weight[half] == 0 { 1.0 } else { weight[half] as f64 };
        out.p[1][half] = (round(u[half] as f64 / count / 8.2) + 16.0).clamp(0.0, 31.0) as u8;
        out.p[2][half] = (round(v[half] as f64 / count / 8.2) + 16.0).clamp(0.0, 31.0) as u8;
    }
    out
}

/// Planes to RGB cells.
pub fn to_pixels(frame: &Planes, shape: &Shape) -> Vec<[u8; 3]> {
    let mut out = vec![[0u8; 3]; shape.cols * shape.rows];
    for row in 0..shape.rows {
        for col in 0..shape.cols {
            let cell = row * shape.cols + col;
            let half = (row >> 1) * shape.half_cols + (col >> 1);
            let y = frame.p[0][cell] as f64 * 255.0 / 63.0;
            let u = (frame.p[1][half] as f64 - 16.0) * 8.2;
            let v = (frame.p[2][half] as f64 - 16.0) * 8.2;
            out[cell] = [clamped(y + 1.402 * v), clamped(y - 0.344136 * u - 0.714136 * v), clamped(y + 1.772 * u)];
        }
    }
    out
}

// ---- range coder ----

const TOP: u64 = 1 << 24;
const FAST: u32 = 4;
const SLOW: u32 = 7;

fn probability(probs: &[u16], index: usize) -> u64 {
    let p = ((probs[index * 2] as u32 + probs[index * 2 + 1] as u32) >> 5) as u64;
    if p == 0 { 1 } else { p }
}

fn adapt(probs: &mut [u16], index: usize, bit: usize) {
    let (fast, slow) = (probs[index * 2], probs[index * 2 + 1]);
    probs[index * 2] = if bit == 1 { fast - (fast >> FAST) } else { fast + ((32768 - fast) >> FAST) };
    probs[index * 2 + 1] = if bit == 1 { slow - (slow >> SLOW) } else { slow + ((32768 - slow) >> SLOW) };
}

struct RangeEncoder {
    low: u64,
    range: u64,
    cache: u8,
    pending: u64,
    out: Vec<u8>,
}

impl RangeEncoder {
    fn new() -> Self {
        RangeEncoder { low: 0, range: 0xffff_ffff, cache: 0, pending: 1, out: Vec::new() }
    }
    fn bit(&mut self, probs: &mut [u16], index: usize, bit: usize) {
        let bound = (self.range >> 11) * probability(probs, index);
        if bit == 1 {
            self.low += bound;
            self.range -= bound;
        } else {
            self.range = bound;
        }
        adapt(probs, index, bit);
        while self.range < TOP {
            self.range *= 256;
            self.shift();
        }
    }
    fn direct(&mut self, bit: usize) {
        self.range >>= 1;
        if bit == 1 {
            self.low += self.range;
        }
        while self.range < TOP {
            self.range *= 256;
            self.shift();
        }
    }
    fn shift(&mut self) {
        if self.low < 0xff00_0000 || self.low >= 1 << 32 {
            let carry = (self.low >= 1 << 32) as u8;
            let mut byte = self.cache;
            loop {
                self.out.push(byte.wrapping_add(carry));
                byte = 0xff;
                self.pending -= 1;
                if self.pending == 0 {
                    break;
                }
            }
            self.cache = ((self.low >> 24) & 0xff) as u8;
        }
        self.pending += 1;
        self.low = (self.low & 0xff_ffff) << 8;
    }
    /// The coded bytes; the first byte of such a stream is always zero and is left out.
    fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift();
        }
        self.out.split_off(1)
    }
}

struct RangeDecoder<'a> {
    data: &'a [u8],
    at: usize,
    range: u64,
    code: u64,
}

impl<'a> RangeDecoder<'a> {
    fn new(data: &'a [u8]) -> Self {
        let mut d = RangeDecoder { data, at: 0, range: 0xffff_ffff, code: 0 };
        for _ in 0..4 {
            d.code = d.code * 256 + d.next() as u64;
        }
        d
    }
    fn next(&mut self) -> u8 {
        let byte = self.data.get(self.at).copied().unwrap_or(0);
        self.at += 1;
        byte
    }
    fn normalize(&mut self) {
        while self.range < TOP {
            self.range *= 256;
            self.code = self.code * 256 + self.next() as u64;
        }
    }
    fn bit(&mut self, probs: &mut [u16], index: usize) -> usize {
        let bound = (self.range >> 11) * probability(probs, index);
        let bit = if self.code < bound {
            self.range = bound;
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            1
        };
        adapt(probs, index, bit);
        self.normalize();
        bit
    }
    fn direct(&mut self) -> usize {
        self.range >>= 1;
        let bit = if self.code >= self.range {
            self.code -= self.range;
            1
        } else {
            0
        };
        self.normalize();
        bit
    }
}

// ---- contexts and numbers ----

const SIGNED: usize = 18;
const C_FRAME: usize = 0;
const C_INTRA: usize = 32;
const C_CBF: usize = 35;
const C_MV: usize = 41;
const C_RES: usize = 77;
const C_RES_INTRA: usize = 401;
const C_SKIP: usize = 941;
const C_PATTERN: usize = 944;
const C_DOT: usize = 952;
const C_DARK_FLAG: usize = 1976;
const C_DARK: usize = 1979;
const CONTEXTS: usize = 3515;

enum Coder<'a> {
    Encode(RangeEncoder),
    Decode(RangeDecoder<'a>),
}

struct Bits<'a> {
    coder: Coder<'a>,
    probs: Vec<u16>,
    /// Set by the decoder when the data cannot be right; decoding stops at the end of the frame.
    damaged: bool,
}

impl<'a> Bits<'a> {
    fn encoding(&self) -> bool {
        matches!(self.coder, Coder::Encode(_))
    }
    fn bit(&mut self, context: usize, value: usize) -> usize {
        match &mut self.coder {
            Coder::Encode(e) => {
                e.bit(&mut self.probs, context, value);
                value
            }
            Coder::Decode(d) => d.bit(&mut self.probs, context),
        }
    }
    fn direct(&mut self, value: usize) -> usize {
        match &mut self.coder {
            Coder::Encode(e) => {
                e.direct(value);
                value
            }
            Coder::Decode(d) => d.direct(),
        }
    }
    fn golomb(&mut self, value: i64) -> i64 {
        if self.encoding() {
            let (mut rest, mut k) = (value, 0);
            while rest >= 1 << k {
                self.direct(1);
                rest -= 1 << k;
                k += 1;
            }
            self.direct(0);
            for i in (0..k).rev() {
                self.direct(((rest >> i) & 1) as usize);
            }
            return value;
        }
        let mut k = 0;
        while self.direct(0) == 1 {
            k += 1;
            if k > 24 {
                self.damaged = true;
                return 0;
            }
        }
        let mut rest = 0i64;
        for _ in 0..k {
            rest = rest * 2 + self.direct(0) as i64;
        }
        (1 << k) - 1 + rest
    }
    fn unsigned(&mut self, group: usize, value: i64) -> i64 {
        for i in 0..16 {
            if self.bit(group + i, (value > i as i64) as usize) == 0 {
                return i as i64;
            }
        }
        16 + self.golomb(value - 16)
    }
    fn signed(&mut self, group: usize, value: i64) -> i64 {
        if self.bit(group, (value != 0) as usize) == 0 {
            return 0;
        }
        let negative = self.bit(group + 1, (value < 0) as usize);
        let size = self.unsigned(group + 2, value.abs() - 1) + 1;
        if negative == 1 { -size } else { size }
    }
}

// ---- prediction ----

fn clamp(value: i64, max: usize) -> usize {
    value.clamp(0, max as i64 - 1) as usize
}

fn dot_luma(y: &[u8], masks: &[u8], shape: &Shape) -> Vec<u8> {
    let (cols, rows) = (shape.cols, shape.rows);
    let width = cols * 2;
    let mut out = vec![0u8; width * rows * 4];
    for cell in 0..cols * rows {
        let value = y[cell] as i32;
        let mask = masks[cell];
        let (cx, cy) = (cell % cols, cell / cols);
        let mut dark = value;
        if mask != 0 {
            let (mut sum, mut count) = (0, 0);
            let mut take = |near: usize| {
                let other = y[near] as i32;
                if other < value - 3 {
                    sum += other;
                    count += 1;
                }
            };
            if cx > 0 {
                take(cell - 1);
            }
            if cx + 1 < cols {
                take(cell + 1);
            }
            if cy > 0 {
                take(cell - cols);
            }
            if cy + 1 < rows {
                take(cell + cols);
            }
            dark = if count > 0 { (sum + (count >> 1)) / count } else { value >> 1 };
        }
        for d in 0..8 {
            out[(cy * 4 + (d >> 1)) * width + cx * 2 + (d & 1)] = if mask == 0 || (mask >> d) & 1 == 1 { value as u8 } else { dark as u8 };
        }
    }
    out
}

fn luma_at(dots: &[u8], shape: &Shape, x: usize, y: usize, dx: i32, dy: i32, mask: u8) -> i32 {
    let (width, height) = (shape.cols * 2, shape.rows * 4);
    let left = (x * 2) as i64 + dx as i64;
    let top = (y * 4) as i64 + dy as i64;
    let inside = left >= 0 && left + 1 < width as i64 && top >= 0 && top + 3 < height as i64;
    let (mut sum, mut count) = (0i32, 0i32);
    for d in 0..8i64 {
        if mask != 0 && (mask >> d) & 1 == 0 {
            continue;
        }
        let at = if inside { ((top + (d >> 1)) as usize) * width + (left + (d & 1)) as usize } else { clamp(top + (d >> 1), height) * width + clamp(left + (d & 1), width) };
        sum += dots[at] as i32;
        count += 1;
    }
    (sum + (count >> 1)).div_euclid(count)
}

fn chroma_at(plane: &[u8], shape: &Shape, x: usize, y: usize, dx: i32, dy: i32) -> i32 {
    let x0 = x as i64 + (dx >> 2) as i64;
    let y0 = y as i64 + (dy >> 3) as i64;
    let (fx, fy) = ((dx & 3) as i32, (dy & 7) as i32);
    let (w, h) = (shape.half_cols, shape.half_rows);
    let g = |xx: i64, yy: i64| plane[clamp(yy, h) * w + clamp(xx, w)] as i32;
    let a = g(x0, y0);
    if fx == 0 && fy == 0 {
        return a;
    }
    ((a * (4 - fx) + g(x0 + 1, y0) * fx) * (8 - fy) + (g(x0, y0 + 1) * (4 - fx) + g(x0 + 1, y0 + 1) * fx) * fy + 16) >> 5
}

fn median(plane: &[u8], width: usize, x: usize, y: usize, middle: i32) -> i32 {
    let left = if x > 0 { plane[y * width + x - 1] as i32 } else { -1 };
    let top = if y > 0 { plane[(y - 1) * width + x] as i32 } else { -1 };
    if left < 0 && top < 0 {
        return middle;
    }
    if left < 0 {
        return top;
    }
    if top < 0 {
        return left;
    }
    let corner = plane[(y - 1) * width + x - 1] as i32;
    if corner >= left.max(top) {
        left.min(top)
    } else if corner <= left.min(top) {
        left.max(top)
    } else {
        left + top - corner
    }
}

fn shifted_mask(masks: &[u8], shape: &Shape, cx: usize, cy: usize, dx: i32, dy: i32) -> u8 {
    if dx == 0 && dy == 0 {
        return masks[cy * shape.cols + cx];
    }
    let (width, height) = (shape.cols * 2, shape.rows * 4);
    let mut mask = 0u8;
    for d in 0..8usize {
        let x = clamp((cx * 2 + (d & 1)) as i64 + dx as i64, width);
        let y = clamp((cy * 4 + (d >> 1)) as i64 + dy as i64, height);
        if (masks[(y >> 2) * shape.cols + (x >> 1)] >> ((y & 3) * 2 + (x & 1))) & 1 == 1 {
            mask |= 1 << d;
        }
    }
    mask
}

fn dark_guess(rgb: &[[u8; 3]], shape: &Shape, cell: usize) -> [u8; 3] {
    let luma = |at: usize| rgb[at][0] as f64 * 0.299 + rgb[at][1] as f64 * 0.587 + rgb[at][2] as f64 * 0.114;
    let (x, y) = (cell % shape.cols, cell / shape.cols);
    let own = luma(cell);
    let mut sum = [0u32; 3];
    let mut count = 0;
    let near = [(x > 0).then(|| cell - 1), (x + 1 < shape.cols).then(|| cell + 1), (y > 0).then(|| cell - shape.cols), (y + 1 < shape.rows).then(|| cell + shape.cols)];
    for n in near.into_iter().flatten() {
        if luma(n) >= own - 10.0 {
            continue;
        }
        for c in 0..3 {
            sum[c] += rgb[n][c] as u32;
        }
        count += 1;
    }
    [0, 1, 2].map(|c| if count > 0 { (sum[c] / count) as u8 } else { rgb[cell][c] >> 1 })
}

// ---- frames ----

/// What the encoder knows about a frame.
pub struct Source<'a> {
    pub planes: Planes,
    /// Dot masks, one byte per cell (detail streams).
    pub masks: Option<&'a [u8]>,
    /// Dark-side colors of patterned cells, RGB per cell (shades streams).
    pub shades: Option<&'a [u8]>,
    /// Quantizer threshold for predicted blocks (0–63); default the stream's.
    pub threshold: Option<i32>,
    /// Quantizer threshold for intra blocks and key frames (0–63); default 0, exact.
    pub intra_threshold: Option<i32>,
}

/// A decoded frame. `motion` is each block's vector in cells, for drawing frames in between.
pub struct Frame {
    pub planes: Planes,
    pub masks: Vec<u8>,
    /// RGB per cell, 0 where not stored (players guess those).
    pub shades: Option<Vec<u8>>,
    pub motion: Vec<i8>,
}

#[derive(Clone, Copy)]
pub struct Options {
    pub cols: usize,
    pub rows: usize,
    pub threshold: i32,
    pub detail: bool,
    pub shades: bool,
    /// Encoder only: try just the neighbors' vectors and one dot around the best, for live streams.
    pub fast: bool,
}

type CellList = Vec<(usize, usize, usize, usize, usize)>;

struct ChunkCoder<'a> {
    options: Options,
    shape: Shape,
    bits: Bits<'a>,
    steps: [i32; 3],
    key_steps: [i32; 3],
    reference: Planes,
    reference_masks: Vec<u8>,
    reference_dots: Vec<u8>,
    cell_lists: Vec<Option<std::rc::Rc<CellList>>>,
    previous_vectors: Vec<i32>,
    frames: usize,
}

fn rates() -> &'static [f32; 64] {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[f32; 64]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = [0f32; 64];
        for (size, slot) in t.iter_mut().enumerate() {
            *slot = if size == 0 { 0.15 } else { (2.5 + 1.5 * (1.0 + size as f64).log2()) as f32 };
        }
        t
    })
}

impl<'a> ChunkCoder<'a> {
    fn new(options: Options, bits: Bits<'a>) -> Self {
        let shape = Shape::new(options.cols, options.rows);
        ChunkCoder {
            options,
            shape,
            bits,
            steps: steps_of(options.threshold),
            key_steps: [1, 1, 1],
            reference: empty_planes(&shape, true),
            reference_masks: vec![0; shape.cols * shape.rows],
            reference_dots: vec![32; shape.cols * shape.rows * 8],
            cell_lists: vec![None; shape.blocks],
            previous_vectors: vec![0; shape.blocks * 2],
            frames: 0,
        }
    }

    /// Every Y, U and V position of a block in coding order: (plane, index, x, y, width).
    fn cells(&mut self, block: usize) -> std::rc::Rc<CellList> {
        if let Some(list) = &self.cell_lists[block] {
            return list.clone();
        }
        let s = self.shape;
        let (bx, by) = ((block % s.blocks_x) * BLOCK_W, (block / s.blocks_x) * BLOCK_H);
        let mut list = Vec::new();
        for y in by..(by + BLOCK_H).min(s.rows) {
            for x in bx..(bx + BLOCK_W).min(s.cols) {
                list.push((0, y * s.cols + x, x, y, s.cols));
            }
        }
        for plane in 1..3 {
            for y in (by >> 1)..((by + BLOCK_H) >> 1).min(s.half_rows) {
                for x in (bx >> 1)..((bx + BLOCK_W) >> 1).min(s.half_cols) {
                    list.push((plane, y * s.half_cols + x, x, y, s.half_cols));
                }
            }
        }
        let list = std::rc::Rc::new(list);
        self.cell_lists[block] = Some(list.clone());
        list
    }

    fn predict(&self, out: &Planes, masks: &[u8], cell: (usize, usize, usize, usize, usize), intra: bool, dx: i32, dy: i32) -> i32 {
        let (plane, index, x, y, width) = cell;
        if intra {
            return median(&out.p[plane], width, x, y, if plane == 0 { 32 } else { 16 });
        }
        if plane == 0 { luma_at(&self.reference_dots, &self.shape, x, y, dx, dy, masks[index]) } else { chroma_at(&self.reference.p[plane], &self.shape, x, y, dx, dy) }
    }

    fn frame(&mut self, source: Option<&Source>) -> Frame {
        let shape = self.shape;
        let key = self.frames == 0;
        self.frames += 1;
        let threshold = self.bits.unsigned(C_FRAME, source.and_then(|s| s.threshold).unwrap_or(self.options.threshold) as i64);
        let intra_threshold = self.bits.unsigned(C_FRAME + 16, source.and_then(|s| s.intra_threshold).unwrap_or(0) as i64);
        if threshold > 63 || intra_threshold > 63 {
            self.bits.damaged = true;
        }
        self.steps = steps_of(threshold.min(63) as i32);
        self.key_steps = steps_of(intra_threshold.min(63) as i32);
        let cells_count = shape.cols * shape.rows;
        let mut out = empty_planes(&shape, false);
        let mut masks = vec![0u8; cells_count];
        let mut decoded = vec![false; cells_count];
        let mut shades = (self.options.detail && self.options.shades).then(|| vec![0u8; cells_count * 3]);
        let mut vectors = vec![0i32; shape.blocks * 2];
        let (mut intra_b, mut coded_b, mut skip_b) = (vec![0usize; shape.blocks], vec![0usize; shape.blocks], vec![0usize; shape.blocks]);
        let mut nonzero = [vec![0usize; out.p[0].len()], vec![0usize; out.p[1].len()], vec![0usize; out.p[2].len()]];
        let mut motion = vec![0i8; shape.blocks * 2];
        for block in 0..shape.blocks {
            if self.bits.damaged {
                break;
            }
            let (bx, by) = ((block % shape.blocks_x) * BLOCK_W, (block / shape.blocks_x) * BLOCK_H);
            let (has_left, has_top) = (bx > 0, by > 0);
            let top = block.wrapping_sub(shape.blocks_x);
            let top_right = has_top && bx + BLOCK_W < shape.cols;
            let cells = self.cells(block);
            let near = |vectors: &[i32], index: usize, axis: usize| vectors[index * 2 + axis];
            let mut predicted = [0i32; 2];
            for axis in 0..2 {
                let a = if has_left { near(&vectors, block - 1, axis) } else { 0 };
                let b = if has_top { near(&vectors, top, axis) } else { a };
                let c = if top_right { near(&vectors, top + 1, axis) } else { b };
                predicted[axis] = a.min(b).max(a.max(b).min(c));
            }
            let mut choice = (true, 0, 0);
            if self.bits.encoding() && !key {
                if let Some(s) = source {
                    let left = has_left.then(|| (near(&vectors, block - 1, 0), near(&vectors, block - 1, 1)));
                    let up = has_top.then(|| (near(&vectors, top, 0), near(&vectors, top, 1)));
                    choice = self.decide(s, block, bx, by, predicted, left, up);
                }
            }
            let intra = if key { 1 } else { self.bits.bit(C_INTRA + if has_left { intra_b[block - 1] } else { 0 } + if has_top { intra_b[top] } else { 0 }, choice.0 as usize) };
            intra_b[block] = intra;
            let (mut dx, mut dy) = (0i32, 0i32);
            if intra == 0 {
                dx = predicted[0] + self.bits.signed(C_MV, (choice.1 - predicted[0]) as i64) as i32;
                dy = predicted[1] + self.bits.signed(C_MV + SIGNED, (choice.2 - predicted[1]) as i64) as i32;
                if !(-RANGE..RANGE).contains(&dx) || !(-RANGE..RANGE).contains(&dy) {
                    self.bits.damaged = true;
                    break;
                }
            }
            vectors[block * 2] = dx;
            vectors[block * 2 + 1] = dy;
            motion[block * 2] = round(dx as f64 / 2.0) as i8;
            motion[block * 2 + 1] = round(dy as f64 / 4.0) as i8;

            if self.options.detail {
                let predicted_masks: Vec<(usize, usize, usize, u8)> = cells.iter().filter(|c| c.0 == 0).map(|&(_, index, x, y, _)| (index, x, y, if key { 0 } else { shifted_mask(&self.reference_masks, &shape, x, y, dx, dy) })).collect();
                let mut skip = 0;
                if !key {
                    let mut differ = 0;
                    if self.bits.encoding() {
                        if let Some(real) = source.and_then(|s| s.masks) {
                            for &(index, _, _, guess) in &predicted_masks {
                                differ += (guess ^ real[index]).count_ones();
                            }
                        }
                    }
                    skip = self.bits.bit(C_SKIP + if has_left { skip_b[block - 1] } else { 0 } + if has_top { skip_b[top] } else { 0 }, (differ <= MASK_TOLERANCE) as usize);
                }
                skip_b[block] = skip;
                for &(index, x, y, guess) in &predicted_masks {
                    masks[index] = if skip == 1 { guess } else { self.mask(source.and_then(|s| s.masks).map(|m| m[index]).unwrap_or(0), guess, &masks, &decoded, index, x, y, (!key).then_some((dx, dy))) };
                    decoded[index] = true;
                }
            }
            let steps = if intra == 1 { self.key_steps } else { self.steps };
            let mut levels: Vec<i64> = Vec::new();
            if self.bits.encoding() {
                if let Some(s) = source {
                    for &cell in cells.iter() {
                        let prediction = self.predict(&out, &masks, cell, intra == 1, dx, dy);
                        let (plane, index, ..) = cell;
                        let step = steps[plane];
                        let level = round((s.planes.p[plane][index] as i32 - prediction) as f64 / step as f64) as i64;
                        levels.push(level);
                        out.p[plane][index] = (prediction + level as i32 * step).clamp(0, if plane == 0 { 63 } else { 31 }) as u8;
                    }
                }
            }
            let any = levels.iter().any(|&l| l != 0);
            let coded = self.bits.bit(C_CBF + intra * 3 + if has_left { coded_b[block - 1] } else { 0 } + if has_top { coded_b[top] } else { 0 }, any as usize);
            coded_b[block] = coded;
            for (at, &cell) in cells.iter().enumerate() {
                let (plane, index, x, y, width) = cell;
                let mut level = 0i64;
                if coded == 1 {
                    let pattern = (plane == 0 && masks[index] != 0) as usize;
                    let context = if intra == 1 {
                        let values = &out.p[plane];
                        let left_v = if x > 0 { values[index - 1] as i32 } else { -1 };
                        let top_v = if y > 0 { values[index - width] as i32 } else { -1 };
                        let corner = if x > 0 && y > 0 { values[index - width - 1] as i32 } else { -1 };
                        let activity = if left_v < 0 || top_v < 0 { 2 } else { (left_v - corner).abs() + (top_v - corner).abs() };
                        let class = if activity == 0 { 0 } else if activity <= 2 { 1 } else if activity <= 6 { 2 } else if activity <= 14 { 3 } else { 4 };
                        C_RES_INTRA + ((plane * 5 + class) * 2 + pattern) * SIGNED
                    } else {
                        let map = &nonzero[plane];
                        let around = (if x > 0 { map[index - 1] } else { 0 }) + (if y > 0 { map[index - width] } else { 0 });
                        C_RES + ((plane * 3 + around) * 2 + pattern) * SIGNED
                    };
                    level = self.bits.signed(context, levels.get(at).copied().unwrap_or(0));
                    if level != 0 {
                        nonzero[plane][index] = 1;
                    }
                }
                let prediction = self.predict(&out, &masks, cell, intra == 1, dx, dy);
                out.p[plane][index] = (prediction as i64 + level * steps[plane] as i64).clamp(0, if plane == 0 { 63 } else { 31 }) as u8;
            }
        }
        if let Some(sh) = shades.as_mut() {
            self.dark_sides(&out, &masks, sh, source);
        }
        self.reference_dots = dot_luma(&out.p[0], &masks, &shape);
        self.reference = out.clone();
        self.reference_masks = masks.clone();
        self.previous_vectors = vectors;
        Frame { planes: out, masks, shades, motion }
    }

    fn dark_sides(&mut self, out: &Planes, masks: &[u8], shades: &mut [u8], source: Option<&Source>) {
        let shape = self.shape;
        let rgb = to_pixels(out, &shape);
        let mut flags = vec![0usize; shape.blocks];
        for block in 0..shape.blocks {
            let (bx, by) = ((block % shape.blocks_x) * BLOCK_W, (block / shape.blocks_x) * BLOCK_H);
            let mut patterned = Vec::new();
            for y in by..(by + BLOCK_H).min(shape.rows) {
                for x in bx..(bx + BLOCK_W).min(shape.cols) {
                    if masks[y * shape.cols + x] != 0 {
                        patterned.push(y * shape.cols + x);
                    }
                }
            }
            if patterned.is_empty() {
                continue;
            }
            let guesses: Vec<[u8; 3]> = patterned.iter().map(|&c| dark_guess(&rgb, &shape, c)).collect();
            let mut wrong = 0;
            if self.bits.encoding() {
                if let Some(real) = source.and_then(|s| s.shades) {
                    for (at, &cell) in patterned.iter().enumerate() {
                        for ch in 0..3 {
                            if (real[cell * 3 + ch] as i32 - guesses[at][ch] as i32).abs() > 40 {
                                wrong = 1;
                            }
                        }
                    }
                }
            }
            let flag = self.bits.bit(C_DARK_FLAG + if bx > 0 { flags[block - 1] } else { 0 } + if by > 0 { flags[block - shape.blocks_x] } else { 0 }, wrong);
            flags[block] = flag;
            if flag == 0 {
                continue;
            }
            for (at, &cell) in patterned.iter().enumerate() {
                for ch in 0..3 {
                    let guess = (guesses[at][ch] >> 5) as usize;
                    let value = if self.bits.encoding() { source.and_then(|s| s.shades).map(|r| r[cell * 3 + ch] >> 2).unwrap_or(0) as usize } else { 0 };
                    let mut node = 1usize;
                    for bit in (0..6).rev() {
                        node = node * 2 + self.bits.bit(C_DARK + (ch * 8 + guess) * 64 + node, (value >> bit) & 1);
                    }
                    shades[cell * 3 + ch] = (((node - 64) << 2) | 2) as u8;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn mask(&mut self, value: u8, guess: u8, masks: &[u8], decoded: &[bool], cell: usize, cx: usize, cy: usize, vector: Option<(i32, i32)>) -> u8 {
        let shape = self.shape;
        let left_on = (cx > 0 && masks[cell - 1] != 0) as usize;
        let top_on = (cy > 0 && masks[cell - shape.cols] != 0) as usize;
        let guessed = (guess != 0) as usize;
        if self.bits.bit(C_PATTERN + guessed + left_on * 2 + top_on * 4, (value != 0) as usize) == 0 {
            return 0;
        }
        let (width, height) = (shape.cols * 2, shape.rows * 4);
        let mut mask = 0u8;
        for at in 0..8usize {
            let (x, y) = ((cx * 2 + (at & 1)) as i64, (cy * 4 + (at >> 1)) as i64);
            let dot = |x: i64, y: i64, mask: u8| -> usize {
                if x < 0 || y < 0 || x >= width as i64 {
                    return 0;
                }
                let (x, y) = (x as usize, y as usize);
                let index = (y >> 2) * shape.cols + (x >> 1);
                let bit = (y & 3) * 2 + (x & 1);
                if index == cell {
                    return if bit < at { ((mask >> bit) & 1) as usize } else { 0 };
                }
                if index < decoded.len() && decoded[index] { ((masks[index] >> bit) & 1) as usize } else { 0 }
            };
            let predicted = |x: i64, y: i64| -> usize {
                let Some((dx, dy)) = vector else { return 0 };
                let (px, py) = (clamp(x + dx as i64, width), clamp(y + dy as i64, height));
                ((self.reference_masks[(py >> 2) * shape.cols + (px >> 1)] >> ((py & 3) * 2 + (px & 1))) & 1) as usize
            };
            let context = predicted(x, y) | predicted(x + 1, y) << 1 | predicted(x, y + 1) << 2 | dot(x - 1, y, mask) << 3 | dot(x, y - 1, mask) << 4 | dot(x - 1, y - 1, mask) << 5 | dot(x + 1, y - 1, mask) << 6 | dot(x - 2, y, mask) << 7 | dot(x, y - 2, mask) << 8 | guessed << 9;
            mask |= (self.bits.bit(C_DOT + context, ((value >> at) & 1) as usize) as u8) << at;
        }
        mask
    }

    #[allow(clippy::too_many_arguments)]
    fn decide(&mut self, source: &Source, block: usize, bx: usize, by: usize, predicted: [i32; 2], left: Option<(i32, i32)>, up: Option<(i32, i32)>) -> (bool, i32, i32) {
        let shape = self.shape;
        let cells = self.cells(block);
        let rates = rates();
        let rate = |level: i64| rates[level.unsigned_abs().min(63) as usize] as f64;
        let vector_bits = |dx: i32, dy: i32| rate((dx - predicted[0]) as i64) + rate((dy - predicted[1]) as i64);
        let masks = source.masks;
        let (width, height) = (shape.cols * 2, shape.rows * 4);
        let steps = self.steps;
        let lumas: Vec<_> = cells.iter().filter(|c| c.0 == 0).copied().collect();
        let chromas: Vec<_> = cells.iter().filter(|c| c.0 != 0).copied().collect();
        let dots = &self.reference_dots;
        let reference = &self.reference;
        let reference_masks = &self.reference_masks;
        let detail = self.options.detail;
        let cost = |dx: i32, dy: i32, limit: f64| -> f64 {
            let mut total = vector_bits(dx, dy);
            let inside = (bx * 2) as i64 + dx as i64 >= 0 && ((bx + BLOCK_W) * 2) as i64 + dx as i64 <= width as i64 && (by * 4) as i64 + dy as i64 >= 0 && ((by + BLOCK_H) * 4) as i64 + dy as i64 <= height as i64;
            for &(_, index, x, y, _) in &lumas {
                let mask = masks.map(|m| m[index]).unwrap_or(0);
                let prediction = if inside {
                    let (mut sum, mut count) = (0i32, 0i32);
                    let base = ((y * 4) as i64 + dy as i64) as usize * width + ((x * 2) as i64 + dx as i64) as usize;
                    for d in 0..8usize {
                        if mask != 0 && (mask >> d) & 1 == 0 {
                            continue;
                        }
                        sum += dots[base + (d >> 1) * width + (d & 1)] as i32;
                        count += 1;
                    }
                    (sum + (count >> 1)).div_euclid(count)
                } else {
                    luma_at(dots, &shape, x, y, dx, dy, mask)
                };
                let miss = (source.planes.p[0][index] as i32 - prediction) as f64;
                let level = round(miss / steps[0] as f64);
                total += rate(level as i64) + DISTORTION * (miss - level * steps[0] as f64).abs();
                if total >= limit {
                    return total;
                }
            }
            for &(plane, index, x, y, _) in &chromas {
                let miss = (source.planes.p[plane][index] as i32 - chroma_at(&reference.p[plane], &shape, x, y, dx, dy)) as f64;
                let level = round(miss / steps[plane] as f64);
                total += rate(level as i64) + DISTORTION * (miss - level * steps[plane] as f64).abs();
                if total >= limit {
                    return total;
                }
            }
            if let (Some(m), true) = (masks, detail) {
                let differ: u32 = lumas.iter().map(|&(_, index, x, y, _)| (shifted_mask(reference_masks, &shape, x, y, dx, dy) ^ m[index]).count_ones()).sum();
                total += if differ <= MASK_TOLERANCE { 0.0 } else { differ as f64 * 1.2 };
            }
            total
        };
        let mut best = (0i32, 0i32, cost(0, 0, f64::INFINITY));
        let mut tried: HashSet<i32> = HashSet::from([(128) * 256 + 128]);
        let mut consider = |dx: i32, dy: i32, best: &mut (i32, i32, f64)| -> bool {
            if !(-RANGE..RANGE).contains(&dx) || !(-RANGE..RANGE).contains(&dy) {
                return false;
            }
            if !tried.insert((dx + 128) * 256 + dy + 128) {
                return false;
            }
            let found = cost(dx, dy, best.2);
            if found < best.2 {
                *best = (dx, dy, found);
                return true;
            }
            false
        };
        consider(predicted[0], predicted[1], &mut best);
        if let Some((x, y)) = left {
            consider(x, y, &mut best);
        }
        if let Some((x, y)) = up {
            consider(x, y, &mut best);
        }
        consider(self.previous_vectors[block * 2], self.previous_vectors[block * 2 + 1], &mut best);
        if self.options.fast {
            for (ox, oy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (bx, by) = (best.0, best.1);
                consider(bx + ox, by + oy, &mut best);
            }
        } else {
            if best.2 > cells.len() as f64 * COARSE {
                let mut dy = -16;
                while dy <= 16 {
                    let mut dx = -16;
                    while dx <= 16 {
                        consider(dx, dy, &mut best);
                        dx += 4;
                    }
                    dy += 4;
                }
            }
            for size in [4, 2, 1] {
                let mut moved = true;
                let mut round_ = 0;
                while moved && round_ < 8 {
                    let (dx, dy) = (best.0, best.1);
                    moved = consider(dx + size, dy, &mut best) || consider(dx - size, dy, &mut best) || consider(dx, dy + size, &mut best) || consider(dx, dy - size, &mut best);
                    round_ += 1;
                }
            }
        }
        // intra: the same estimate over median prediction from the source itself
        let mut intra = 1.5;
        for &(plane, index, x, y, w) in cells.iter() {
            let prediction = median(&source.planes.p[plane], w, x, y, if plane == 0 { 32 } else { 16 });
            intra += rate((source.planes.p[plane][index] as i32 - prediction) as i64);
        }
        if let (Some(m), true) = (masks, detail) {
            for &(plane, index, ..) in cells.iter() {
                if plane == 0 && m[index] != 0 {
                    intra += 4.0;
                }
            }
        }
        if intra < best.2 { (true, 0, 0) } else { (false, best.0, best.1) }
    }
}

/// Codes frames chunk by chunk: `add` codes a frame, `finish` returns the chunk's bytes and starts the next one.
pub struct ChunkEncoder {
    options: Options,
    coder: ChunkCoder<'static>,
    count: usize,
}

fn new_encoder(options: Options) -> ChunkCoder<'static> {
    ChunkCoder::new(options, Bits { coder: Coder::Encode(RangeEncoder::new()), probs: vec![16384; CONTEXTS * 2], damaged: false })
}

impl ChunkEncoder {
    pub fn new(options: Options) -> Self {
        ChunkEncoder { options, coder: new_encoder(options), count: 0 }
    }

    /// Codes a frame and returns it as players will decode it.
    pub fn add(&mut self, source: &Source) -> Frame {
        self.count += 1;
        self.coder.frame(Some(source))
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The chunk: its frame count as a LEB128 number, then the range-coded frames.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut rest = self.count;
        loop {
            out.push((rest % 128) as u8 | if rest >= 128 { 128 } else { 0 });
            if rest < 128 {
                break;
            }
            rest /= 128;
        }
        let coder = std::mem::replace(&mut self.coder, new_encoder(self.options));
        if let Coder::Encode(e) = coder.bits.coder {
            out.extend(e.finish());
        }
        self.count = 0;
        out
    }
}

/// Decodes the frames of one chunk.
pub fn decode_chunk(options: Options, data: &[u8]) -> Result<Vec<Frame>, &'static str> {
    let (mut frames, mut at, mut scale) = (0usize, 0usize, 1usize);
    loop {
        let byte = *data.get(at).ok_or("empty chunk")? as usize;
        at += 1;
        frames += (byte & 127) * scale;
        if byte < 128 {
            break;
        }
        scale *= 128;
        if scale > 1 << 21 {
            return Err("damaged chunk");
        }
    }
    if frames > 0xffff {
        return Err("damaged chunk");
    }
    let bits = Bits { coder: Coder::Decode(RangeDecoder::new(&data[at..])), probs: vec![16384; CONTEXTS * 2], damaged: false };
    let mut coder = ChunkCoder::new(options, bits);
    let mut out = Vec::with_capacity(frames);
    for _ in 0..frames {
        let frame = coder.frame(None);
        if coder.bits.damaged {
            return Err("damaged chunk");
        }
        out.push(frame);
    }
    Ok(out)
}
