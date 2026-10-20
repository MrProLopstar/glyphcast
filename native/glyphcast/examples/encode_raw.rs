//! Encodes raw RGB frames: cargo run --example encode_raw -- frames.rgb out.gcast <cols> <rows> <fps> [detail] [shades]
//! Detail frames are (cols·2) × (rows·4) pixels, plain ones cols × rows.
use glyphcast::format::{detail_masks, EncodeOptions, Encoder};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let raw = std::fs::read(&args[1]).unwrap();
    let (cols, rows, fps): (usize, usize, f64) = (args[3].parse().unwrap(), args[4].parse().unwrap(), args[5].parse().unwrap());
    let detail = args.iter().any(|a| a == "detail");
    let shades = args.iter().any(|a| a == "shades");
    let mut encoder = Encoder::new(EncodeOptions { detail, shades, ..EncodeOptions::new(cols, rows, fps) });
    let size = if detail { cols * 2 * rows * 4 * 3 } else { cols * rows * 3 };
    let mut bar = None;
    for pixels in raw.chunks_exact(size) {
        if detail {
            let found = detail_masks(pixels, cols, rows, 3, bar);
            bar = Some(found.bar);
            encoder.add(&found.cells, Some(&found.masks), Some(&found.shades)).unwrap();
        } else {
            encoder.add(pixels, None, None).unwrap();
        }
    }
    std::fs::write(&args[2], encoder.finish()).unwrap();
}
