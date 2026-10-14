# Changelog

## 0.22.1

- Live broadcasts play smoothly: the player no longer waits for 5 s in reserve, which a live stream never has

## 0.22.0

- License changed to the Mozilla Public License 2.0: changes to glyphcast files stay open, code around it may stay closed

## 0.21.3

- Terminal: letters on colored backgrounds get no dark halo, the gaps around them are dimmed like their neighbors

## 0.21.2

- Videos without sound play a silent track, so system media controls work for them too

## 0.21.1

- The player tells the system about playback (Media Session): title and poster in the Windows media flyout and phone notifications, media keys, headsets and lock screens pause, play and seek
- Terminal: thin bright letters in patterned cells take their color from the frame itself, readable titles with sharp ×2 on

## 0.21.0

- License changed to Apache 2.0 (with a NOTICE file); versions up to 0.20.13 stay under MIT

## 0.20.13

- Terminal: the close button at the end of the status bar is no longer cut off

## 0.20.11

- Files with an index start at once: the picture is fetched from its first chunk and plays while the embedded sound loads in the background, then the sound joins at the current moment (a film used to show a black screen for a minute on a phone)

## 0.20.10

- The poster stays on screen until playback starts, not only while the file loads

## 0.20.9

- Seek bar thumbnails keep the picture proportions instead of a squeezed strip

## 0.20.8

- Terminal: dot patterns only for thin bright lines (up to 4 lit dots); other patterned cells are drawn as usual at their real brightness, no glaring edges

## 0.20.7

- Terminal: the dark side of patterned cells is dimmed like the dots around it, no bright solid blocks

## 0.20.6

- Terminal: after a seek, a pause or a wait for loading the picture holds still until the sound really starts, so they stay together

## 0.20.5

- Terminal: remote chunks load with one request each and six at a time, so a hub video keeps up instead of pausing for "loading…" every few seconds

## 0.20.4

- Braille is the default render mode everywhere: the player, the element, the renderer and the terminal

## 0.20.3

- Patterned cells draw all eight dots, the dark ones in the color of the darker side: no black outline around people against a bright background
- Terminal: sound restarts exactly where the picture is after a seek or a pause for loading, no jump 10 s back

## 0.20.2

- Terminal: the next 30 s of a remote video are fetched ahead; on a slow connection playback pauses with "loading…" instead of skipping
- The hub lives at glc-hub.1lop.ru, files at glc-api.1lop.ru

## 0.20.1

- Patterned cells are no longer brightened on top of their bright-dot color, so noise in dark scenes stays dark
- Gaps in patterned cells take the average of darker neighbors, no black rim around moving shapes
- The `--detail` threshold follows the scene slowly, patterns stop blinking in motion (re-encode to use it)
- `publish` sends files straight to the hub storage and continues an interrupted upload; `--source` adds a link to the original

## 0.20.0

- `heading` and `source` attributes: the title in the top left corner of the player with a link to the original
- Patterned (`--detail`) cells draw their gaps with the darkest neighbor, no grey box around letters
- `--detail` threshold follows each frame: faint lines survive in clean frames, film grain stays flat, files about 10% smaller
- CLI: `glc help <command>` with every option and examples, `--start` and `--duration` to encode a piece, progress lines every 30 s in logs and background jobs
- `publish` works without a key (uploads wait for review), retries broken parts and continues an interrupted upload

## 0.19.7

- Smaller files from `encode`: chunks are deflated at level 9 and embedded Opus defaults to 40 kbit/s (about 10% smaller overall)

## 0.19.6

- `--detail`: patterned cells take the color of their bright dots and fainter lines get patterns, so thin titles stay readable (re-encode to use it)

## 0.19.5

- On a slow connection the player waits with a loader when the downloaded part runs out, instead of skipping ahead; playback resumes with 5 s in reserve

## 0.19.4

- Terminal on Windows: pausing stops the sound, the whole ffplay process tree is closed

## 0.19.3

- Terminal: the status bar no longer scrolls the screen when it fills the last column

## 0.19.2

- Short command `glc`, the same as `glyphcast`

## 0.19.1

- Phones: dragging the seek bar no longer gets cancelled by page scrolling, the thumbnail and time sit above the bar and hide when the finger lifts

## 0.19.0

- Qualities: `encode --cols 120,180` writes one file per grid, `publish --variant` adds them to a hub video, the player picks one by its width (`sources` attribute) and the settings menu switches them, the terminal picks by its width
- The loading spinner sits exactly in the middle and hides the play button while it spins

## 0.18.1

- Phones: a tap shows or hides the controls instead of pausing, with a pause button in the middle; fullscreen fills the window where the browser cannot make an element fullscreen (iPhone) and tries landscape

## 0.18.0

- Seek bar thumbnails: hovering the bar shows the frame there, fetched by range request when that part is not loaded yet. `player.preview(seconds)` returns it

## 0.17.0

- Encoding embeds the first text subtitle track of the video (mkv, mp4); players in the browser and the terminal show it without a separate file. `Encoder.addSubtitles()` adds any WebVTT or SRT

## 0.16.0

- `--detail` stores a 2×4 dot pattern per cell taken from the source; braille draws it exactly, so on-screen text and thin lines stay readable. Files grow by about 20–40%. `detailMasks()` builds the patterns. Players before 0.16 refuse such files
- Terminal player: holding an arrow key no longer keeps seeking after release; sound restarts once seeking settles

## 0.15.1

- Terminal player: the play button shows the action, pause bars while playing and a play triangle when paused

## 0.15.0

- `glyphcast publish` uploads files over 95 MB in 90 MB parts, so the hub takes whole films; the hub serves the parts as one file with seeking

## 0.14.0

- Sharp ×2 is on again with a new upscaler made for video: neighbours are compared relative to the cell, so edges are found even when colors drift, and smooth areas are blended instead of repeated

## 0.13.1

- Sharp ×2 is off by default: on video it changes too little to be worth it; the menu, `sharp` and the terminal 2x button still turn it on

## 0.13.0

- Live streams: `glyphcast play live:<room>` watches a gcast hub broadcast in the terminal, and the player plays endless `.gcast` streams without leaving extra connections open

## 0.12.0

- Terminal player speaks English and its status bar is a row of buttons: click the mode, glyph set, colors, saturation, background, 2x, smooth or ✕ to change them, click the bar to seek; the bar spans the picture width
- `glyphcast serve` pauses ffmpeg while a client reads slowly, so a long film no longer piles up in server memory
- Served files answer 404 for missing names, 416 for ranges past the end, and HEAD requests; read errors close the response instead of crashing
- `serve()` rejects when the port is busy instead of hanging; old YouTube lookups are dropped from the cache
- `glyphcast serve --host` binds another interface; `--cols`, `--fps`, `--chunk`, `--port` refuse values that are not positive numbers

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
