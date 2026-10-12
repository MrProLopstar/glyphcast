# Changelog

## 0.11.0

- Terminal subtitles: `glyphcast play --subtitles file.vtt`, and hub videos with subtitles show them
- `glyphcast publish --subtitles` uploads WebVTT or SRT with a hub video
- `fullsize` attribute makes the player fill its element, for embeds

## 0.10.0

- Encoding cuts black bars that stay black through the whole video (checked on every key frame), so letterboxed films fill the grid while videos that switch formats keep their full frame; `--no-crop` and `crop: false` turn it off. `detectBars()` is exported

## 0.9.0

- Smooth playback: frames in between are drawn along the block motion already stored in `.gcast`, so a 24 fps stream plays at the display rate. On by default, `smooth="false"` or the menu turns it off; `V` toggles it in the terminal
- `decodeChunkMotion()` and `interpolate()` are exported

## 0.8.0

- Sharp ×2: frames are upscaled with edge-directed scaling before drawing, so contours and diagonals are crisp from the same stream. On by default, `sharp="false"` or the menu turns it off; `X` toggles it in the terminal
- `upscale2x()` is exported

## 0.7.0

- Shadows keep detail: a tone curve lifts dark areas when choosing glyphs and their brightness, in the browser and the terminal
- Flat areas cost less: a uniform block stores one value instead of every cell, about 5% smaller on films. Players before 0.7 cannot open files that use it

## 0.6.2

- `--embed` skips videos without a sound track instead of failing

## 0.6.1

- Embedded and extracted sound is mixed down to stereo, so 5.1 sources no longer fail with Opus

## 0.6.0

- `glyphcast publish` uploads a `.gcast` with its poster to the gcast hub
- The playground links to the hub and offers publishing after a conversion

## 0.5.8

- Terminal player survives dropped connections: range requests retry three times, a chunk that still fails is fetched again when needed

## 0.5.7

- Terminal player: an odd spare column goes to the left, balancing the scrollbar on the right

## 0.5.6

- Terminal player: arrow keys seek again

## 0.5.5

- Terminal player starts at once: embedded sound streams into ffplay instead of downloading first, seeking reads only the needed part
- Loading spinner while a file or hub video opens
- The picture and the status bar are centered together, stale edges are cleared

## 0.5.4

- `glyphcast hub [search]` lists the gcast hub, `glyphcast play hub:<name>` plays from it
- Remote `.gcast` files with an index are read by range requests, so long films start and seek at once
- Terminal player no longer lags after a long pause: it waits for the console and redraws the status only when it changes

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
