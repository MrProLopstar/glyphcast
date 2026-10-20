//! Writes every decoded frame's RGB, masks and dark sides to stdout, to compare decoders.
use glyphcast::format::{decode_chunk, Reader};
use std::io::Write;

fn main() {
    let mut reader = Reader::new();
    reader.push(&std::fs::read(std::env::args().nth(1).unwrap()).unwrap()).unwrap();
    let info = reader.info.unwrap();
    let mut out = std::io::stdout().lock();
    for chunk in &reader.chunks {
        for f in decode_chunk(&info, &chunk.data).unwrap() {
            for p in &f.rgb { out.write_all(p).unwrap(); }
            if info.detail { out.write_all(&f.masks).unwrap(); }
            if let Some(s) = &f.shades { for p in s { out.write_all(p).unwrap(); } }
        }
    }
}
