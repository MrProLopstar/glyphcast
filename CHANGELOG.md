# Changelog

## 0.2.0

- `<glyph-player>`: a complete player with controls, seek bar, volume, speed, settings menu, keyboard shortcuts, picture-in-picture and fullscreen
- `GlyphPlayer` engine with the media element API replaces `GlyphVideo` and `GlyphStream`; the look changes on the fly without reloading
- `.gcast` v2 is a streaming format with length-prefixed chunks; `StreamReader` parses it as bytes arrive
- `glyphcast serve`: live `.gcast` and Opus streams from YouTube links and local videos, seeking by restart, range requests for files

## 0.1.0

- `GlyphVideo` draws any video, camera or stream as colored glyphs with WebGL2, with auto levels, saturation, tint and custom glyph sets
- `.gcast` stream format, `GlyphStream` player with audio sync and seeking
- `glyphcast encode`, `glyphcast micro` and `glyphcast info` CLI, `glyphcast/node` encoders on top of ffmpeg
