use glyphcast::format::{decode_chunk, detail_masks, EncodeOptions, Encoder, Reader};

/// A moving pattern at the dot resolution of a cols × rows grid.
fn picture(cols: usize, rows: usize, frame: usize) -> Vec<u8> {
    let (w, h) = (cols * 2, rows * 4);
    let mut out = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let ring = (((x as f64 - cols as f64 - frame as f64).powi(2) + ((y as f64 - rows as f64 * 2.0) * 0.6).powi(2)).sqrt() % 9.0) < 3.0;
            let hash = (((x + frame * 3) >> 3) as u32).wrapping_mul(73856093) ^ (((y + frame) >> 3) as u32).wrapping_mul(19349663);
            let at = (y * w + x) * 3;
            out[at..at + 3].copy_from_slice(&if ring { [250, 230, 40] } else { [hash as u8, (hash >> 8) as u8 & 127, (hash >> 16) as u8] });
        }
    }
    out
}

fn encode(cols: usize, rows: usize, frames: usize, detail: bool, shades: bool) -> Vec<u8> {
    let mut encoder = Encoder::new(EncodeOptions { detail, shades, chunk_frames: 9, ..EncodeOptions::new(cols, rows, 12.0) });
    let mut bar = None;
    for frame in 0..frames {
        let found = detail_masks(&picture(cols, rows, frame), cols, rows, 3, bar);
        bar = Some(found.bar);
        encoder.add(&found.cells, detail.then_some(&found.masks[..]), Some(&found.shades)).unwrap();
    }
    encoder.finish()
}

#[test]
fn decodes_what_it_encodes() {
    for (cols, rows, detail, shades) in [(40, 17, true, true), (33, 9, true, false), (27, 11, false, false)] {
        let bytes = encode(cols, rows, 20, detail, shades);
        let mut reader = Reader::new();
        reader.push(&bytes).unwrap();
        let info = reader.info.unwrap();
        assert_eq!((info.cols, info.rows, info.frames, info.detail, info.shades), (cols, rows, 20, detail, shades));
        let decoded: usize = reader.chunks.iter().map(|c| decode_chunk(&info, &c.data).unwrap().len()).sum();
        assert_eq!(decoded, 20);
    }
}

#[test]
fn reads_files_of_the_npm_package() {
    let mut reader = Reader::new();
    reader.push(include_bytes!("plain.gcast")).unwrap();
    let info = reader.info.unwrap();
    let frames: usize = reader.chunks.iter().map(|c| decode_chunk(&info, &c.data).unwrap().len()).sum();
    assert_eq!(frames, info.frames);
}

#[test]
fn reads_bytes_as_they_arrive() {
    let bytes = encode(24, 10, 15, true, false);
    let mut reader = Reader::new();
    for piece in bytes.chunks(7) {
        reader.push(piece).unwrap();
    }
    assert_eq!(reader.chunks.iter().map(|c| c.frames).sum::<usize>(), 15);
}

#[test]
fn refuses_damage_without_panicking() {
    let bytes = encode(24, 10, 6, true, false);
    let mut reader = Reader::new();
    reader.push(&bytes).unwrap();
    let info = reader.info.unwrap();
    let mut data = reader.chunks[0].data.clone();
    for byte in data.iter_mut().skip(3) {
        *byte ^= 0x5a;
    }
    let _ = decode_chunk(&info, &data);
    assert!(decode_chunk(&info, &[]).is_err());
    assert!(Reader::new().push(b"not a gcast stream at all").is_err());
}
