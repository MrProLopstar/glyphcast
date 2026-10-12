# Changelog

## 0.5.3

- Terminal player: click the progress bar to seek, click the picture to pause; keys work in the Russian layout too
- Richer braille colors: dots take the color of what they cover, the cell background the color of the rest
- The picture keeps true proportions using the terminal cell size and is centered

## 0.5.2

- Terminal player has the browser defaults (braille, saturation 1.3, background fill 0.25, frame smoothing) and keys to change them: M render mode (braille, glyphs, half blocks), G glyph set, C colors, [ ] saturation, B background
- The picture fits the terminal and follows window resizes; terminals that allow it are asked to match the video proportions

## 0.5.1

- `glyphcast play` for `.gcast` has controls: Space pauses, ←/→ seek 5 s, J/L 10 s, 0–9 jump, Q quits, with a status bar; embedded sound plays through ffplay; indexed files are read from disk chunk by chunk, so feature films open at once

## 0.5.0

- Seeking past the loaded part: files end with a chunk index, and the player fetches the needed place with a range request
- `poster` attribute, `--poster` and `extractPoster()` save a frame for it
- `glyphcast/react` and `glyphcast/vue` wrappers with typed props and events, server rendering safe
- CLI encodes several videos in a row and shows progress with time left; `glyphcast serve` answers suffix ranges correctly
- `Encoder.addAudio()` also works after frames; `finish()` puts the sound first
- Brighter braille mode; the playground converter encodes in a Web Worker and shows the console command

## 0.4.1

- Softer picture on large screens: cell backgrounds take a dim version of their color (`fill`, slider in settings), small frame-to-frame jitter is smoothed out, glyphs are semibold

## 0.4.0

- Sound inside `.gcast`: `Encoder.addAudio()`, `--embed` and `embedAudio` store Opus before the frames; the player uses it as the clock
- Playground converter: turns a video into `.gcast` in the browser and shows the savings
- Encoder is about six times faster, live streams keep up at 24 fps
- Glyph size follows the displayed size, so laptops get crisp glyphs instead of shimmering downscaled ones
- Streams no longer stall before the first chunk when audio loads first; compact controls and page on phones

## 0.3.6

- Cleaner settings icon

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
