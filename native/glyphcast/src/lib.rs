//! # glyphcast
//!
//! Video as colored glyphs. A `.gcast` stream stores a grid of character cells — each with a color and a 2×4 dot
//! pattern (a braille character) — instead of pixels; players draw it with glyphs, braille or blocks, on a GPU or in
//! a text terminal. This crate reads and writes format version 6, the frozen format of glyphcast 1.0 described in
//! [FORMAT.md](https://github.com/MrProLopstar/glyphcast/blob/main/FORMAT.md), and turns frames into console cells.
//! It has no dependencies.
//!
//! ```no_run
//! use glyphcast::{format::{Reader, decode_chunk}, render};
//!
//! let mut reader = Reader::new();
//! reader.push(&std::fs::read("movie.gcast")?)?;
//! let info = reader.info.unwrap();
//! for chunk in &reader.chunks {
//!     for frame in decode_chunk(&info, &chunk.data)? {
//!         // frame.rgb: a color per cell; frame.masks: its dots
//!     }
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! Encoding takes frames at twice the grid width and four times its height for detail streams:
//!
//! ```no_run
//! use glyphcast::format::{detail_masks, EncodeOptions, Encoder};
//!
//! let (cols, rows) = (160, 54);
//! let mut encoder = Encoder::new(EncodeOptions { detail: true, ..EncodeOptions::new(cols, rows, 24.0) });
//! # let frames: Vec<Vec<u8>> = vec![];
//! let mut bar = None;
//! for pixels in frames { // RGB, (cols·2) × (rows·4)
//!     let found = detail_masks(&pixels, cols, rows, 3, bar);
//!     bar = Some(found.bar);
//!     encoder.add(&found.cells, Some(&found.masks), None)?;
//! }
//! std::fs::write("movie.gcast", encoder.finish())?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

pub mod codec;
pub mod format;
pub mod render;
