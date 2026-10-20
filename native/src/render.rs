//! Frames to console cells, as `ansiFrame` in glyphcast's terminal.ts: braille, glyphs or half blocks, with levels,
//! saturation, tints and a tinted background; plus the frame filters around it (2× upscale, steadying, motion
//! interpolation).

pub type Rgb = [u8; 3];

pub const GLYPH_SETS: [(&str, &str); 6] = [
    ("classic", " .:-=+*#%@"),
    ("blocks", " ░▒▓█"),
    ("dense", " .'`^,:;Il!i~+_-?][}{1)(|tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"),
    ("dots", " ·•●"),
    ("binary", " 01"),
    ("katakana", " ｰｨｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏ"),
];
pub const TINTS: [(&str, Option<Rgb>); 5] = [("video colors", None), ("matrix", Some([0x33, 0xff, 0x66])), ("amber", Some([0xff, 0xb3, 0x5c])), ("neon", Some([0x5c, 0xe1, 0xff])), ("mono", Some([0xe8, 0xec, 0xef]))];
pub const TINTS_RU: [&str; 5] = ["как в видео", "матрица", "ламповый", "неон", "монохром"];
pub const MODES: [&str; 3] = ["braille", "glyphs", "half blocks"];
pub const MODES_RU: [&str; 3] = ["брайль", "символы", "полублоки"];
pub const FILLS: [f64; 3] = [0.25, 0.5, 0.0];
pub const BOOSTS: [f64; 5] = [1.3, 1.6, 2.0, 0.7, 1.0];

const BAYER: [f64; 8] = [0.0625, 0.5625, 0.8125, 0.3125, 0.9375, 0.4375, 0.1875, 0.6875];
const BRAILLE: [u32; 8] = [0, 1, 2, 6, 3, 4, 5, 7];
const SHADOWS: f64 = 0.72;

/// A store into a Uint8ClampedArray: clamped, rounded half to even.
pub fn clamped(x: f64) -> u8 {
    if !(x > 0.0) {
        0
    } else if x >= 255.0 {
        255
    } else {
        x.round_ties_even() as u8
    }
}

/// Like JavaScript's Math.round.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

pub fn luma(c: [f64; 3]) -> f64 {
    (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255.0
}

#[derive(Clone, Copy)]
pub struct Levels {
    pub brightness: f64,
    pub contrast: f64,
}
pub const NEUTRAL: Levels = Levels { brightness: 0.0, contrast: 1.0 };

pub fn auto_levels(pixels: &[Rgb]) -> Levels {
    if pixels.is_empty() {
        return NEUTRAL;
    }
    let (mut sum, mut squares) = (0.0, 0.0);
    for p in pixels {
        let v = luma([p[0] as f64, p[1] as f64, p[2] as f64]);
        sum += v;
        squares += v * v;
    }
    let mean = sum / pixels.len() as f64;
    let deviation = (squares / pixels.len() as f64 - mean * mean).max(0.0).sqrt();
    Levels { brightness: ((0.5 - mean) * 0.6).clamp(-0.25, 0.35), contrast: (0.22 / deviation.max(0.02)).clamp(0.8, 2.2) }
}

pub fn ease(current: Levels, target: Levels) -> Levels {
    Levels { brightness: current.brightness + (target.brightness - current.brightness) * 0.15, contrast: current.contrast + (target.contrast - current.contrast) * 0.15 }
}

/// Small changes are smoothed over frames, so film grain does not shimmer in the glyphs.
pub fn steady(previous: Option<&Vec<Rgb>>, pixels: &[Rgb]) -> Vec<Rgb> {
    match previous {
        Some(before) if before.len() == pixels.len() => before
            .iter()
            .zip(pixels)
            .map(|(b, p)| {
                [0, 1, 2].map(|c| {
                    let delta = p[c] as f64 - b[c] as f64;
                    clamped(if delta > -24.0 && delta < 24.0 { b[c] as f64 + delta / 3.0 } else { b[c] as f64 + delta })
                })
            })
            .collect(),
        _ => pixels.to_vec(),
    }
}

/// The frame halfway along each block's motion, as `interpolate` in format.ts.
pub fn interpolate(from: &[Rgb], to: &[Rgb], motion: &[i8], cols: usize, rows: usize, t: f64) -> Vec<Rgb> {
    let mut out: Vec<Rgb> = from.iter().zip(to).map(|(a, b)| [0, 1, 2].map(|c| clamped(a[c] as f64 + (b[c] as f64 - a[c] as f64) * t))).collect();
    let blocks_x = cols.div_ceil(8);
    for block in 0..motion.len() / 2 {
        let (dx, dy) = (motion[block * 2] as f64, motion[block * 2 + 1] as f64);
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        let (ox, oy) = (round(dx * (1.0 - t)) as i64, round(dy * (1.0 - t)) as i64);
        let (bx, by) = ((block % blocks_x) * 8, (block / blocks_x) * 4);
        for y in by..(by + 4).min(rows) {
            let ty = y as i64 + oy;
            if ty < 0 || ty >= rows as i64 {
                continue;
            }
            for x in bx..(bx + 8).min(cols) {
                let tx = x as i64 + ox;
                if tx < 0 || tx >= cols as i64 {
                    continue;
                }
                out[ty as usize * cols + tx as usize] = to[y * cols + x];
            }
        }
    }
    out
}

/// Edge-directed 2× scaling, as `upscale2x` in upscale.ts.
pub fn upscale2x(p: &[Rgb], cols: usize, rows: usize) -> Vec<Rgb> {
    let width = cols * 2;
    let mut out = vec![[0u8; 3]; width * rows * 2];
    let at = |x: i64, y: i64| -> usize { (y.clamp(0, rows as i64 - 1) as usize) * cols + x.clamp(0, cols as i64 - 1) as usize };
    let distance = |a: usize, b: usize| -> f64 { (p[a][0] as f64 - p[b][0] as f64).abs() * 2.0 + (p[a][1] as f64 - p[b][1] as f64).abs() * 3.0 + (p[a][2] as f64 - p[b][2] as f64).abs() };
    for y in 0..rows as i64 {
        for x in 0..cols as i64 {
            let c = at(x, y);
            let (up, down, left, right) = (at(x, y - 1), at(x, y + 1), at(x - 1, y), at(x + 1, y));
            let top = (y as usize * 2) * width + x as usize * 2;
            let corners = [(top, left, up, at(x - 1, y - 1)), (top + 1, up, right, at(x + 1, y - 1)), (top + width, down, left, at(x - 1, y + 1)), (top + width + 1, right, down, at(x + 1, y + 1))];
            for (target, side, other, diagonal) in corners {
                let across = distance(side, other);
                let edge = across * 2.0 < distance(side, c) && across * 2.0 < distance(other, c) && distance(side, c) > 60.0;
                out[target] = [0, 1, 2].map(|ch| {
                    let (center, a, b) = (p[c][ch] as f64, p[side][ch] as f64, p[other][ch] as f64);
                    clamped(if edge { center * 0.25 + (a + b) * 0.375 } else { (center * 9.0 + (a + b) * 3.0 + p[diagonal][ch] as f64) / 16.0 })
                });
            }
        }
    }
    out
}

/// Size of the picture in console cells for a grid fitted into `width × height`.
pub fn fit(cols: usize, rows: usize, width: usize, height: usize, cell_ratio: f64) -> (usize, usize) {
    let ratio = (cols as f64 * 0.6 * cell_ratio) / rows as f64;
    let fitted = (width as f64).min((height as f64 * ratio).floor()).max(1.0);
    (fitted as usize, round(fitted / ratio).clamp(1.0, height as f64) as usize)
}

#[derive(Clone, Copy, PartialEq)]
pub struct Cell {
    pub ch: char,
    pub fg: Rgb,
    pub bg: Option<Rgb>,
}

pub struct Look {
    pub mode: usize,
    pub glyphs: usize,
    pub tint: usize,
    pub boost: f64,
    pub fill: usize,
}

/// The patterns and colors of a detail stream on its own grid.
pub struct Detail<'a> {
    pub masks: &'a [u8],
    pub cols: usize,
    pub rows: usize,
    pub pixels: &'a [Rgb],
    pub shades: Option<&'a [Rgb]>,
}

/// One frame as console cells, as `ansiFrame`.
pub fn frame(pixels: &[Rgb], cols: usize, rows: usize, levels: Levels, look: &Look, width: usize, height: usize, detail: Option<&Detail>) -> Vec<Cell> {
    let glyphs: Vec<char> = GLYPH_SETS[look.glyphs].1.chars().collect();
    let tint = TINTS[look.tint].1;
    let fill = FILLS[look.fill];
    let boost = look.boost;
    let sample = |x: f64, y: f64| -> [f64; 3] {
        let gx = (x * cols as f64 - 0.5).max(0.0).min(cols as f64 - 1.0);
        let gy = (y * rows as f64 - 0.5).max(0.0).min(rows as f64 - 1.0);
        let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(cols - 1), (y0 + 1).min(rows - 1));
        let (fx, fy) = (gx - x0 as f64, gy - y0 as f64);
        [0, 1, 2].map(|c| {
            let (a, b, d, e) = (pixels[y0 * cols + x0][c] as f64, pixels[y0 * cols + x1][c] as f64, pixels[y1 * cols + x0][c] as f64, pixels[y1 * cols + x1][c] as f64);
            (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (d * (1.0 - fx) + e * fx) * fy
        })
    };
    let level = |c: [f64; 3]| -> f64 { ((luma(c) - 0.5) * levels.contrast + 0.5 + levels.brightness).clamp(0.0, 1.0).powf(SHADOWS) };
    let paint = |c: [f64; 3], lit: f64| -> [f64; 3] {
        if let Some(t) = tint {
            return [0, 1, 2].map(|i| t[i] as f64 * (0.35 + lit));
        }
        let gray = luma(c) * 255.0;
        let lift = 0.55 + lit * 0.9;
        [0, 1, 2].map(|i| (gray + (c[i] - gray) * boost) * lift)
    };
    let to_rgb = |c: [f64; 3]| -> Rgb { c.map(|v| round(v).clamp(0.0, 255.0) as u8) };
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let (fx, fy) = (x as f64, y as f64);
            let (w, h) = (width as f64, height as f64);
            if look.mode == 2 {
                let top = sample((fx + 0.5) / w, (fy + 0.25) / h);
                let bottom = sample((fx + 0.5) / w, (fy + 0.75) / h);
                out.push(Cell { ch: '▀', fg: to_rgb(paint(top, level(top))), bg: Some(to_rgb(paint(bottom, level(bottom)))) });
                continue;
            }
            let center = sample((fx + 0.5) / w, (fy + 0.5) / h);
            let lit = level(center);
            let mut color = paint(center, lit);
            let mut back = color.map(|v| v * fill * 0.5);
            let ch;
            if look.mode == 0 {
                let mut bits = 0u32;
                let (mut on, mut off) = ([0.0f64; 4], [0.0f64; 4]);
                for dot in 0..8 {
                    let (dx, dy) = ((dot % 2) as f64, (dot / 2) as f64);
                    let spot = sample((fx + (dx + 0.5) / 2.0) / w, (fy + (dy + 0.5) / 4.0) / h);
                    let near = level(spot);
                    let target = if near > 0.18f64.max(BAYER[dot] * 0.75) {
                        bits |= 1 << BRAILLE[(dot % 2) * 4 + dot / 2];
                        &mut on
                    } else {
                        &mut off
                    };
                    for c in 0..3 {
                        target[c] += spot[c];
                    }
                    target[3] += 1.0;
                }
                let mean = |s: [f64; 4]| -> [f64; 3] { let n = if s[3] == 0.0 { 1.0 } else { s[3] }; [s[0] / n, s[1] / n, s[2] / n] };
                let lights = if on[3] > 0.0 { mean(on) } else { center };
                color = paint(lights, (level(lights) + 0.15).min(1.0)).map(|v| v * 1.15);
                let shade = if off[3] > 0.0 { mean(off) } else { center };
                back = paint(shade, level(shade)).map(|v| v * fill);
                if let Some(grid) = detail {
                    let cell = (((fy + 0.5) / h * grid.rows as f64).floor() as usize).min(grid.rows - 1) * grid.cols + (((fx + 0.5) / w * grid.cols as f64).floor() as usize).min(grid.cols - 1);
                    let pattern = grid.masks[cell];
                    let lit_dots = pattern.count_ones() as f64;
                    let (u, v) = (1.0 / grid.cols as f64, 1.0 / grid.rows as f64);
                    let dark_side = || -> [f64; 3] {
                        if let Some(stored) = grid.shades {
                            let s = stored[cell];
                            if s[0] as u32 + s[1] as u32 + s[2] as u32 > 0 {
                                return [s[0] as f64, s[1] as f64, s[2] as f64];
                            }
                        }
                        let (cx, cy) = ((fx + 0.5) / w, (fy + 0.5) / h);
                        let around = [sample(cx - u, cy), sample(cx + u, cy), sample(cx, cy - v), sample(cx, cy + v)];
                        let own = luma(center);
                        let darker: Vec<[f64; 3]> = around.into_iter().filter(|item| luma(*item) < own - 0.04).collect();
                        if darker.is_empty() {
                            return center.map(|v| v * 0.5);
                        }
                        [0, 1, 2].map(|c| darker.iter().map(|item| item[c]).sum::<f64>() / darker.len() as f64)
                    };
                    if pattern != 0 && lit_dots > 4.0 {
                        let dark = dark_side();
                        let whole = [0, 1, 2].map(|c| (center[c] * lit_dots + dark[c] * (8.0 - lit_dots)) / 8.0);
                        let ratio = luma(whole) / luma(center).max(0.01);
                        color = color.map(|v| v * ratio);
                        back = back.map(|v| v * ratio);
                    }
                    if pattern != 0 && lit_dots <= 4.0 {
                        bits = 0;
                        for dot in 0..8 {
                            if pattern >> dot & 1 == 1 {
                                bits |= 1 << BRAILLE[(dot & 1) * 4 + (dot >> 1)];
                            }
                        }
                        let own = grid.pixels[cell].map(|v| v as f64);
                        color = paint(own, (level(own) + 0.1).min(1.0)).map(|v| v * 1.15);
                        let dark = dark_side();
                        back = paint(dark, level(dark)).map(|v| v * fill);
                    }
                }
                ch = char::from_u32(0x2800 + bits).unwrap_or(' ');
            } else {
                ch = glyphs[((lit * glyphs.len() as f64).floor() as usize).min(glyphs.len() - 1)];
            }
            out.push(Cell { ch, fg: to_rgb(color), bg: if fill > 0.0 { Some(to_rgb(back)) } else { None } });
        }
    }
    out
}
