//! Reading .gcast files: the container (header, chunks, index) and frame chunks of format version 6, following
//! FORMAT.md. Older versions (3–5) are not read here; the npm package plays them.

pub struct Info {
    pub cols: usize,
    pub rows: usize,
    pub fps: f64,
    pub frames: usize,
    pub detail: bool,
    pub shades: bool,
}

pub struct Chunk {
    pub start: usize,
    pub data: std::ops::Range<usize>,
}

pub struct File {
    pub bytes: Vec<u8>,
    pub info: Info,
    pub chunks: Vec<Chunk>,
    /// The embedded audio file, pieces joined.
    pub audio: Vec<u8>,
}

fn u16le(b: &[u8], at: usize) -> usize {
    u16::from_le_bytes([b[at], b[at + 1]]) as usize
}
fn u32le(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize
}

pub fn open(bytes: Vec<u8>) -> Result<File, String> {
    if bytes.len() < 20 || u32le(&bytes, 0) != 0x5453_4347 {
        return Err("это не файл .gcast".into());
    }
    let version = bytes[4];
    if version != 6 {
        return Err(format!("формат {version}: этот плеер читает файлы glyphcast 1.0 (формат 6). Перекодируйте файл: glc encode"));
    }
    let flags = bytes[5];
    let info = Info {
        cols: u16le(&bytes, 6),
        rows: u16le(&bytes, 8),
        fps: f32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]) as f64,
        frames: u32le(&bytes, 16),
        detail: flags & 128 != 0,
        shades: flags & 128 != 0 && flags & 64 != 0,
    };
    if info.cols == 0 || info.rows == 0 || !(info.fps > 0.0) {
        return Err("повреждён заголовок".into());
    }
    let mut chunks = Vec::new();
    let mut audio = Vec::new();
    let mut at = 20;
    let mut frame = 0;
    while at + 6 <= bytes.len() {
        let size = u32le(&bytes, at);
        let kind = u16le(&bytes, at + 4);
        let data = at + 6..(at + 6 + size).min(bytes.len());
        at += 6 + size;
        match kind {
            0 => audio.extend_from_slice(&bytes[data]),
            1..=0xffef => {
                chunks.push(Chunk { start: frame, data });
                frame += kind;
            }
            _ => {}
        }
    }
    let info = Info { frames: frame, ..info };
    Ok(File { bytes, info, chunks, audio })
}

// ---- range decoder and contexts ----

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

struct Bits<'a> {
    data: &'a [u8],
    at: usize,
    range: u64,
    code: u64,
    fast: Vec<u16>,
    slow: Vec<u16>,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        let mut bits = Bits { data, at: 0, range: 0xffff_ffff, code: 0, fast: vec![16384; CONTEXTS], slow: vec![16384; CONTEXTS] };
        for _ in 0..4 {
            bits.code = bits.code * 256 + bits.next() as u64;
        }
        bits
    }
    fn next(&mut self) -> u8 {
        let byte = self.data.get(self.at).copied().unwrap_or(0);
        self.at += 1;
        byte
    }
    fn normalize(&mut self) {
        while self.range < 1 << 24 {
            self.range *= 256;
            self.code = self.code * 256 + self.next() as u64;
        }
    }
    fn bit(&mut self, c: usize) -> usize {
        let mut p = ((self.fast[c] as u32 + self.slow[c] as u32) >> 5) as u64;
        if p == 0 {
            p = 1;
        }
        let bound = (self.range >> 11) * p;
        let b = if self.code < bound {
            self.range = bound;
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            1
        };
        let (f, s) = (self.fast[c], self.slow[c]);
        self.fast[c] = if b == 1 { f - (f >> 4) } else { f + ((32768 - f) >> 4) };
        self.slow[c] = if b == 1 { s - (s >> 7) } else { s + ((32768 - s) >> 7) };
        self.normalize();
        b
    }
    fn direct(&mut self) -> usize {
        self.range >>= 1;
        let b = if self.code >= self.range {
            self.code -= self.range;
            1
        } else {
            0
        };
        self.normalize();
        b
    }
    fn golomb(&mut self) -> Result<i32, String> {
        let mut k = 0;
        while self.direct() == 1 {
            k += 1;
            if k > 24 {
                return Err("повреждённый фрагмент".into());
            }
        }
        let mut rest = 0i32;
        for _ in 0..k {
            rest = rest * 2 + self.direct() as i32;
        }
        Ok((1 << k) - 1 + rest)
    }
    fn unsigned(&mut self, g: usize) -> Result<i32, String> {
        for i in 0..16 {
            if self.bit(g + i) == 0 {
                return Ok(i as i32);
            }
        }
        Ok(16 + self.golomb()?)
    }
    fn signed(&mut self, g: usize) -> Result<i32, String> {
        if self.bit(g) == 0 {
            return Ok(0);
        }
        let negative = self.bit(g + 1) == 1;
        let size = self.unsigned(g + 2)? + 1;
        Ok(if negative { -size } else { size })
    }
}

// ---- frames ----

/// A decoded frame: RGB of every cell, its dot mask and, where stored, the color of its dark dots (0 = guess).
pub struct Frame {
    pub rgb: Vec<[u8; 3]>,
    pub masks: Vec<u8>,
    pub shades: Option<Vec<[u8; 3]>>,
}

fn clamp(v: i32, m: i32) -> i32 {
    v.clamp(0, m - 1)
}

/// Like a store into a Uint8ClampedArray: clamped, rounded half to even.
fn clamped(x: f64) -> u8 {
    if !(x > 0.0) {
        0
    } else if x >= 255.0 {
        255
    } else {
        x.round_ties_even() as u8
    }
}

fn steps(t: i32) -> [i32; 3] {
    let c = ((t as f64) / 3.0).round() as i32;
    [2 * t + 1, 2 * c + 1, 2 * c + 1]
}

pub fn decode_chunk(info: &Info, data: &[u8]) -> Result<Vec<Frame>, String> {
    let (mut frames, mut at, mut scale) = (0usize, 0usize, 1usize);
    loop {
        let b = *data.get(at).ok_or("пустой фрагмент")? as usize;
        at += 1;
        frames += (b & 127) * scale;
        scale *= 128;
        if b < 128 {
            break;
        }
        if scale > 1 << 21 {
            return Err("повреждённый фрагмент".into());
        }
    }
    let mut bits = Bits::new(&data[at..]);
    let (cols, rows) = (info.cols as i32, info.rows as i32);
    let (hc, hr) = ((cols + 1) / 2, (rows + 1) / 2);
    let blocks_x = (cols + 7) / 8;
    let blocks = (blocks_x * ((rows + 3) / 4)) as usize;
    let (w, h) = (cols * 2, rows * 4);
    let cells = (cols * rows) as usize;
    let halves = (hc * hr) as usize;
    let mut reference = [vec![32u8; cells], vec![16u8; halves], vec![16u8; halves]];
    let mut ref_masks = vec![0u8; cells];
    let mut ref_dots = vec![32u8; (w * h) as usize];
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let key = f == 0;
        let motion_steps = steps(bits.unsigned(C_FRAME)?);
        let intra_steps = steps(bits.unsigned(C_FRAME + 16)?);
        let mut cur = [vec![0u8; cells], vec![0u8; halves], vec![0u8; halves]];
        let mut masks = vec![0u8; cells];
        let mut done = vec![false; cells];
        let mut vec_ = vec![0i32; blocks * 2];
        let (mut intra_b, mut coded_b, mut skip_b) = (vec![0usize; blocks], vec![0usize; blocks], vec![0usize; blocks]);
        let mut nz = [vec![0usize; cells], vec![0usize; halves], vec![0usize; halves]];
        for b in 0..blocks {
            let bi = b as i32;
            let (bx, by) = ((bi % blocks_x) * 8, (bi / blocks_x) * 4);
            let (has_l, has_t) = (bx > 0, by > 0);
            let intra = if key { 1 } else { bits.bit(C_INTRA + if has_l { intra_b[b - 1] } else { 0 } + if has_t { intra_b[b - blocks_x as usize] } else { 0 }) };
            intra_b[b] = intra;
            let (mut dx, mut dy) = (0, 0);
            if intra == 0 {
                let mut pred = [0; 2];
                for k in 0..2 {
                    let a = if has_l { vec_[(b - 1) * 2 + k] } else { 0 };
                    let bb = if has_t { vec_[(b - blocks_x as usize) * 2 + k] } else { a };
                    let c = if has_t && bx + 8 < cols { vec_[(b - blocks_x as usize + 1) * 2 + k] } else { bb };
                    pred[k] = a.min(bb).max(a.max(bb).min(c));
                }
                dx = pred[0] + bits.signed(C_MV)?;
                dy = pred[1] + bits.signed(C_MV + 18)?;
                if !(-64..64).contains(&dx) || !(-64..64).contains(&dy) {
                    return Err("повреждённый фрагмент".into());
                }
            }
            vec_[b * 2] = dx;
            vec_[b * 2 + 1] = dy;
            let mut ycells = Vec::with_capacity(32);
            for y in by..(by + 4).min(rows) {
                for x in bx..(bx + 8).min(cols) {
                    ycells.push((x, y));
                }
            }
            if info.detail {
                let ref_dot = |x: i32, y: i32| -> u8 {
                    let (x, y) = (clamp(x, w), clamp(y, h));
                    (ref_masks[((y >> 2) * cols + (x >> 1)) as usize] >> ((y & 3) * 2 + (x & 1))) & 1
                };
                let p = |x: i32, y: i32| -> usize { if key { 0 } else { ref_dot(x + dx, y + dy) as usize } };
                let skip = if key { 0 } else { bits.bit(C_SKIP + if has_l { skip_b[b - 1] } else { 0 } + if has_t { skip_b[b - blocks_x as usize] } else { 0 }) };
                skip_b[b] = skip;
                for &(cx, cy) in &ycells {
                    let cell = (cy * cols + cx) as usize;
                    let mut pm = 0u8;
                    for d in 0..8 {
                        pm |= (p(cx * 2 + (d & 1), cy * 4 + (d >> 1)) as u8) << d;
                    }
                    if skip == 1 {
                        masks[cell] = pm;
                    } else {
                        let guessed = (pm != 0) as usize;
                        let lp = (cx > 0 && masks[cell - 1] != 0) as usize;
                        let tp = (cy > 0 && masks[cell - cols as usize] != 0) as usize;
                        let mut m = 0u8;
                        if bits.bit(C_PATTERN + guessed + 2 * lp + 4 * tp) == 1 {
                            for d in 0..8i32 {
                                let (x, y) = (cx * 2 + (d & 1), cy * 4 + (d >> 1));
                                let dd = |x: i32, y: i32| -> usize {
                                    if x < 0 || y < 0 || x >= w {
                                        return 0;
                                    }
                                    let c2 = ((y >> 2) * cols + (x >> 1)) as usize;
                                    let bi = (y & 3) * 2 + (x & 1);
                                    if c2 == cell {
                                        return if bi < d { ((m >> bi) & 1) as usize } else { 0 };
                                    }
                                    if done[c2] { ((masks[c2] >> bi) & 1) as usize } else { 0 }
                                };
                                let ctx = p(x, y) | p(x + 1, y) << 1 | p(x, y + 1) << 2 | dd(x - 1, y) << 3 | dd(x, y - 1) << 4 | dd(x - 1, y - 1) << 5 | dd(x + 1, y - 1) << 6 | dd(x - 2, y) << 7 | dd(x, y - 2) << 8 | guessed << 9;
                                m |= (bits.bit(C_DOT + ctx) as u8) << d;
                            }
                        }
                        masks[cell] = m;
                    }
                    done[cell] = true;
                }
            }
            let coded = bits.bit(C_CBF + 3 * intra + if has_l { coded_b[b - 1] } else { 0 } + if has_t { coded_b[b - blocks_x as usize] } else { 0 });
            coded_b[b] = coded;
            let mut list: Vec<(usize, i32, i32, i32)> = ycells.iter().map(|&(x, y)| (0, x, y, cols)).collect();
            for pl in 1..3 {
                for y in (by >> 1)..((by + 4) >> 1).min(hr) {
                    for x in (bx >> 1)..((bx + 8) >> 1).min(hc) {
                        list.push((pl, x, y, hc));
                    }
                }
            }
            let st = if intra == 1 { intra_steps } else { motion_steps };
            for (pl, x, y, wd) in list {
                let i = (y * wd + x) as usize;
                let vals = &cur[pl];
                let a = if x > 0 { vals[i - 1] as i32 } else { -1 };
                let bb = if y > 0 { vals[i - wd as usize] as i32 } else { -1 };
                let c = if x > 0 && y > 0 { vals[i - wd as usize - 1] as i32 } else { -1 };
                let mut level = 0;
                if coded == 1 {
                    let pat = (pl == 0 && masks[i] != 0) as usize;
                    if intra == 1 {
                        let g = if a < 0 || bb < 0 { 2 } else { (a - c).abs() + (bb - c).abs() };
                        let cls = if g == 0 { 0 } else if g <= 2 { 1 } else if g <= 6 { 2 } else if g <= 14 { 3 } else { 4 };
                        level = bits.signed(C_RES_INTRA + ((pl * 5 + cls) * 2 + pat) * SIGNED)?;
                    } else {
                        let around = (if x > 0 { nz[pl][i - 1] } else { 0 }) + (if y > 0 { nz[pl][i - wd as usize] } else { 0 });
                        level = bits.signed(C_RES + ((pl * 3 + around) * 2 + pat) * SIGNED)?;
                    }
                    if level != 0 {
                        nz[pl][i] = 1;
                    }
                }
                let pred = if intra == 1 {
                    let middle = if pl == 0 { 32 } else { 16 };
                    if a < 0 && bb < 0 {
                        middle
                    } else if a < 0 {
                        bb
                    } else if bb < 0 {
                        a
                    } else if c >= a.max(bb) {
                        a.min(bb)
                    } else if c <= a.min(bb) {
                        a.max(bb)
                    } else {
                        a + bb - c
                    }
                } else if pl == 0 {
                    let m = if info.detail { masks[i] } else { 0 };
                    let (mut s, mut n) = (0i32, 0i32);
                    for d in 0..8 {
                        if m != 0 && (m >> d) & 1 == 0 {
                            continue;
                        }
                        s += ref_dots[(clamp(y * 4 + (d >> 1) + dy, h) * w + clamp(x * 2 + (d & 1) + dx, w)) as usize] as i32;
                        n += 1;
                    }
                    (s + (n >> 1)) / n
                } else {
                    let (x0, y0, fx, fy) = (x + (dx >> 2), y + (dy >> 3), dx & 3, dy & 7);
                    let r = &reference[pl];
                    let g = |xx: i32, yy: i32| r[(clamp(yy, hr) * hc + clamp(xx, hc)) as usize] as i32;
                    ((g(x0, y0) * (4 - fx) + g(x0 + 1, y0) * fx) * (8 - fy) + (g(x0, y0 + 1) * (4 - fx) + g(x0 + 1, y0 + 1) * fx) * fy + 16) >> 5
                };
                let max = if pl == 0 { 63 } else { 31 };
                cur[pl][i] = (pred + level * st[pl]).clamp(0, max) as u8;
            }
        }
        // RGB
        let mut rgb = vec![[0u8; 3]; cells];
        for y in 0..rows {
            for x in 0..cols {
                let i = (y * cols + x) as usize;
                let hi = ((y >> 1) * hc + (x >> 1)) as usize;
                let yy = cur[0][i] as f64 * 255.0 / 63.0;
                let u = (cur[1][hi] as f64 - 16.0) * 8.2;
                let v = (cur[2][hi] as f64 - 16.0) * 8.2;
                rgb[i] = [clamped(yy + 1.402 * v), clamped(yy - 0.344136 * u - 0.714136 * v), clamped(yy + 1.772 * u)];
            }
        }
        let mut shades = None;
        if info.shades {
            let mut sh = vec![[0u8; 3]; cells];
            let mut flags = vec![0usize; blocks];
            let lum = |i: usize| rgb[i][0] as f64 * 0.299 + rgb[i][1] as f64 * 0.587 + rgb[i][2] as f64 * 0.114;
            for b in 0..blocks {
                let bi = b as i32;
                let (bx, by) = ((bi % blocks_x) * 8, (bi / blocks_x) * 4);
                let mut pat = Vec::new();
                for y in by..(by + 4).min(rows) {
                    for x in bx..(bx + 8).min(cols) {
                        if masks[(y * cols + x) as usize] != 0 {
                            pat.push((y * cols + x) as usize);
                        }
                    }
                }
                if pat.is_empty() {
                    continue;
                }
                let flag = bits.bit(C_DARK_FLAG + if bx > 0 { flags[b - 1] } else { 0 } + if by > 0 { flags[b - blocks_x as usize] } else { 0 });
                flags[b] = flag;
                if flag == 0 {
                    continue;
                }
                for cell in pat {
                    let (x, y) = ((cell as i32) % cols, (cell as i32) / cols);
                    let own = lum(cell);
                    let mut near = Vec::new();
                    if x > 0 { near.push(cell - 1) }
                    if x < cols - 1 { near.push(cell + 1) }
                    if y > 0 { near.push(cell - cols as usize) }
                    if y < rows - 1 { near.push(cell + cols as usize) }
                    let dark: Vec<usize> = near.into_iter().filter(|&n| lum(n) < own - 10.0).collect();
                    for ch in 0..3 {
                        let full = if dark.is_empty() { (rgb[cell][ch] >> 1) as usize } else { dark.iter().map(|&n| rgb[n][ch] as usize).sum::<usize>() / dark.len() };
                        let guess = full >> 5;
                        let mut node = 1;
                        for _ in 0..6 {
                            node = node * 2 + bits.bit(C_DARK + (ch * 8 + guess) * 64 + node);
                        }
                        sh[cell][ch] = (((node - 64) << 2) | 2) as u8;
                    }
                }
            }
            shades = Some(sh);
        }
        // dot brightness for the next frame
        let mut dots = vec![0u8; (w * h) as usize];
        for cell in 0..cells {
            let (x, y) = ((cell as i32) % cols, (cell as i32) / cols);
            let v = cur[0][cell] as i32;
            let m = masks[cell];
            let mut dark = v;
            if m != 0 {
                let (mut s, mut n) = (0, 0);
                for (ok, nb) in [(x > 0, cell as i32 - 1), (x < cols - 1, cell as i32 + 1), (y > 0, cell as i32 - cols), (y < rows - 1, cell as i32 + cols)] {
                    if ok && (cur[0][nb as usize] as i32) < v - 3 {
                        s += cur[0][nb as usize] as i32;
                        n += 1;
                    }
                }
                dark = if n > 0 { (s + (n >> 1)) / n } else { v >> 1 };
            }
            for d in 0..8 {
                dots[((y * 4 + (d >> 1)) * w + x * 2 + (d & 1)) as usize] = if m == 0 || (m >> d) & 1 == 1 { v as u8 } else { dark as u8 };
            }
        }
        out.push(Frame { rgb, masks: masks.clone(), shades });
        reference = cur;
        ref_masks = masks;
        ref_dots = dots;
    }
    Ok(out)
}
