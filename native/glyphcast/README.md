# glyphcast

[![crates.io](https://img.shields.io/crates/v/glyphcast?color=f0a04b)](https://crates.io/crates/glyphcast) [![docs.rs](https://img.shields.io/docsrs/glyphcast)](https://docs.rs/glyphcast)

Video as colored glyphs, in Rust. A `.gcast` stream stores a grid of character cells — a color and a 2×4 dot pattern (a braille character) per cell — instead of pixels. Players draw it with glyphs, braille dots or half blocks, on a GPU or in a text terminal.

This crate reads and writes `.gcast` format 6, the frozen format of [glyphcast](https://github.com/MrProLopstar/glyphcast) 1.0 ([FORMAT.md](https://github.com/MrProLopstar/glyphcast/blob/main/FORMAT.md)), and turns frames into console cells. It is a port of the TypeScript library and writes byte-for-byte the same files. No dependencies.

```toml
[dependencies]
glyphcast = "1"
```

## Decode

```rust
use glyphcast::format::{decode_chunk, Reader};

let mut reader = Reader::new();
reader.push(&std::fs::read("movie.gcast")?)?; // or push bytes as a download arrives
let info = reader.info.unwrap();
for chunk in &reader.chunks {
    for frame in decode_chunk(&info, &chunk.data)? {
        // frame.rgb: a color per cell, frame.masks: its 2×4 dots (bit y·2+x), frame.motion: block motion
    }
}
// reader.audio: the embedded sound file (Ogg Opus), reader.subtitles: WebVTT
# Ok::<(), Box<dyn std::error::Error>>(())
```

## Encode

Frames come at twice the grid width and four times its height (one pixel per dot), RGB:

```rust
use glyphcast::format::{detail_masks, EncodeOptions, Encoder};

let (cols, rows) = (180, 61);
let mut encoder = Encoder::new(EncodeOptions { detail: true, ..EncodeOptions::new(cols, rows, 24.0) });
let mut bar = None;
# let frames: Vec<Vec<u8>> = vec![];
for pixels in frames {
    let found = detail_masks(&pixels, cols, rows, 3, bar);
    bar = Some(found.bar);
    encoder.add(&found.cells, Some(&found.masks), None)?;
}
// encoder.add_audio(&ogg_opus_bytes); encoder.add_subtitles(&vtt);
std::fs::write("movie.gcast", encoder.finish())?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

`Encoder::on_chunk` streams pieces as they are ready, for live video. `EncodeOptions::fast` searches motion several times faster for live encoding.

## Draw

`render::frame` turns a decoded frame into console cells (a character, a foreground and a background color) in braille, glyph or half-block mode, with the look options of the glyphcast terminal player; `render::upscale2x`, `render::interpolate` and `render::auto_levels` are the filters around it. [`glc.exe`](https://github.com/MrProLopstar/glyphcast/releases), a console player for Windows under 1 MB, is built on this crate.

## License

MPL-2.0
