# Changelog

## 0.3.5

- Controls keep updating in Document picture-in-picture

## 0.3.4

- Streams with audio pause the sound and show buffering when frames run out, instead of playing sound over a frozen picture
- An interrupted `play()` no longer shows an error
- `extractAudio` and `--audio` write AAC for `.m4a`, which plays on every phone; `.opus` stays Opus

## 0.3.3

- The settings menu sits above the controls, so its last switch can be clicked

## 0.3.2

- Tube screen look is visible at any size: scanlines follow the glyph rows, the screen bulges and the edges darken

## 0.3.1

- Streams are read at most 20 seconds ahead with low fetch priority, so audio starts at once on slow connections instead of after the whole file

## 0.3.0

- `.gcast` v3: 6-bit brightness with 4:2:0 color, 8×4 blocks with motion vectors and quantized residuals; about half the size of v2 at the same grid. v2 files need re-encoding
- Render modes: braille dots and halftone besides glyphs, contour glyphs `- / | \` along edges, a tube screen look, a katakana glyph set
- Subtitles: `subtitles` attribute and `setCaptions()` take WebVTT or SRT and draw them on the glyph grid, in sync after seeks
- `glyphcast play` and `playInTerminal()` play `.gcast` files, server streams and videos in the terminal with 24-bit color
- Default stream rate is 24 fps; `--threshold` and `?quality=` trade detail for size

## 0.2.0

- `<glyph-player>`: a complete player with controls, seek bar, volume, speed, settings menu, keyboard shortcuts, picture-in-picture and fullscreen
- `GlyphPlayer` engine with the media element API replaces `GlyphVideo` and `GlyphStream`; the look changes on the fly without reloading
- `.gcast` v2 is a streaming format with length-prefixed chunks; `StreamReader` parses it as bytes arrive
- `glyphcast serve`: live `.gcast` and Opus streams from YouTube links and local videos, seeking by restart, range requests for files

## 0.1.0

- `GlyphVideo` draws any video, camera or stream as colored glyphs with WebGL2, with auto levels, saturation, tint and custom glyph sets
- `.gcast` stream format, `GlyphStream` player with audio sync and seeking
- `glyphcast encode`, `glyphcast micro` and `glyphcast info` CLI, `glyphcast/node` encoders on top of ffmpeg
