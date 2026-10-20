# glyphcast

[![npm](https://img.shields.io/npm/v/glyphcast?color=f0a04b)](https://www.npmjs.com/package/glyphcast)
[![JSR](https://jsr.io/badges/@mrprolopstar/glyphcast)](https://jsr.io/@mrprolopstar/glyphcast)
[![crates.io](https://img.shields.io/crates/v/glyphcast?color=f0a04b)](https://crates.io/crates/glyphcast)
[![glc.exe](https://img.shields.io/github/v/release/MrProLopstar/glyphcast?label=glc.exe&color=f0a04b)](https://github.com/MrProLopstar/glyphcast/releases/latest)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[Русская версия](README.ru.md) · [Playground](https://glc.1lop.ru/) · [Converter](https://gcast.1lop.ru/) · [Hub](https://glc-hub.1lop.ru/)

![One Piece opening in braille mode](https://glc.1lop.ru/preview.jpg)

<sub>One Piece opening in braille mode, 180 columns.</sub>

Video as colored glyphs. A complete player for the browser: controls, settings, subtitles, keyboard shortcuts, picture-in-picture and fullscreen, with every frame redrawn as characters by a WebGL2 shader. A server can also send glyph frames instead of video, so the browser receives a compact `.gcast` stream rather than the footage itself. The same stream plays in a terminal too. The `.gcast` format is frozen since 1.0 and described completely in [FORMAT.md](FORMAT.md).

```sh
npm install glyphcast          # or: npm i -g glyphcast, then glc …
```

```sh
glc encode movie.mp4 --detail --embed --poster   # video → .gcast with sound and a poster
glc play movie.gcast                             # in the terminal, with sound
glc play hub:<id>                                # a video from the hub
glc help encode                                  # every option with examples
```

```html
<script type="module">import 'glyphcast/element';</script>

<glyph-player src="movie.mp4" cols="160"></glyph-player>
<glyph-player src="movie.gcast" audio="movie.m4a" subtitles="movie.vtt"></glyph-player>
<glyph-player youtube="https://youtu.be/…" server="http://127.0.0.1:8787"></glyph-player>
```

No bundler? `import 'https://cdn.jsdelivr.net/npm/glyphcast@1/dist/element.js/+esm'`.

## Where it plays

| | | |
|---|---|---|
| 🌐 Browser | `<glyph-player>`, React, Vue | WebGL2, controls, subtitles, quality switching |
| 💻 Terminal | `glc play movie.gcast` | 24-bit color, sound through ffplay, the same keys |
| 🪟 Windows | [`glc.exe`](https://github.com/MrProLopstar/glyphcast/releases/latest) | native, under 1 MB, sound built in, no Node |
| 📡 Telnet | `glc telnet movie.gcast` | anyone watches with `telnet host 2323`, no install |
| 🦀 Rust | [`glyphcast` crate](native/glyphcast) | encoder and decoder, byte-identical to JS, no dependencies |

### glc.exe

A console player for Windows in one file under 1 MB: no Node, no ffmpeg, sound and the hub built in. Download it from [Releases](https://github.com/MrProLopstar/glyphcast/releases/latest), double-click for the hub menu or drop a `.gcast` on it:

```sh
glc.exe movie.gcast            # play a file
glc.exe hub:<id>               # a video from the hub
glc.exe --lang ru              # Russian interface
```

### Telnet

```sh
glc telnet movie.gcast --port 2323     # then, from any machine: telnet <host> 2323
```

Each connection gets its own player with seeking and modes. Telnet carries no sound, and the viewer needs a terminal with 24-bit color (Windows Terminal, iTerm2, most Linux terminals).

### Rust

```toml
[dependencies]
glyphcast = "1"
```

```rust
use glyphcast::format::{decode_chunk, Reader};

let mut reader = Reader::new();
reader.push(&std::fs::read("movie.gcast")?)?;
let info = reader.info.unwrap();
for chunk in &reader.chunks {
    for frame in decode_chunk(&info, &chunk.data)? {
        // frame.rgb: a color per cell, frame.masks: its 2×4 braille dots
    }
}
```

The crate writes byte-for-byte the same files as the JS encoder, about 3.5× faster. More in [native/glyphcast](native/glyphcast).

## The player

`<glyph-player>` plays videos, cameras, local files and `.gcast` streams. Inside: play and pause, ±10 seconds, a seek bar with buffered range and time tooltip, volume, speed, picture-in-picture (Document PiP with the whole player where available, the picture alone elsewhere), fullscreen and a settings menu for grid width, render mode (glyphs, braille dots or halftone), glyph set, color mode, saturation, auto levels, contours and a tube screen look. Contours draw cells on object edges as `- / | \` along the edge; the tube look adds scanlines, vignette and glow. Controls hide while playing.

| Attribute | |
|---|---|
| `src` | Video URL or `.gcast` file |
| `poster` | Image shown until the first frame |
| `audio` | Audio for a `.gcast` file |
| `youtube`, `file`, `server` | Stream through `glyphcast serve` (see below) |
| `subtitles` | WebVTT or SRT subtitles, drawn on the glyph grid |
| `cols` | Grid width in glyphs, default `160` |
| `glyphs` | Glyphs from dark to bright, default `' .:-=+*#%@'` |
| `tint` | One color for every glyph, for example `#33ff66` |
| `boost` | Saturation, default `1.3` |
| `autolevels` | `false` turns off per-scene brightness and contrast |
| `mode` | `braille` (default), `glyphs` or `halftone` |
| `heading`, `source` | Title in the top left corner and a link to the original |
| `sources` | JSON list of `{ cols, src }`: quality choices, picked by width |
| `edges`, `crt` | Contours and the tube screen look |
| `sharp` | `false` turns off sharp ×2 (edge-directed upscaling) |
| `smooth` | `false` turns off smoothing (in-between frames along block motion) |
| `fill` | Cell background tinted by its color, 0 to 1, default `0.25` |
| `autoplay`, `muted`, `loop` | As on `<video>` |

Keys: Space or K play, ←/→ 5 s, J/L 10 s, ↑/↓ volume, M mute, F fullscreen, P picture-in-picture, 0–9 jump. Theme it with `--accent` and `--radius`; `element.load(fileOrStreamOrUrl)` and `element.player` give programmatic control.

### React and Vue

```tsx
import { GlyphPlayer } from 'glyphcast/react';

<GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" onReady={(player) => player.play()} />
```

```vue
<script setup>
import { GlyphPlayer } from 'glyphcast/vue';
</script>

<template>
  <GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" @ended="next" />
</template>
```

Props match the attributes (`autoPlay`, `autoLevels` in camelCase), plus `play`, `pause`, `ended`, `timeupdate`, `error` events and `ready` with the engine. The element loads after mounting, so the wrappers work with server rendering.

Without UI, `GlyphPlayer` is the same engine with the media element API: `load`, `play`, `pause`, `seek`, `currentTime`, `duration`, `volume`, `muted`, `playbackRate`, `configure(look)`, `setCaptions(textOrUrl)` and the usual events.

## Glyphs instead of video

At 160 columns a frame is about nine thousand colored cells, far less than a video frame. `.gcast` stores 6-bit brightness per cell, one color per 2×2 cells (like 4:2:0 video) and, with `--detail`, the 2×4 dot pattern of cells with sharp edges. The grid is cut into 8×4 blocks: a block is predicted from the previous frame moved by a vector accurate to one dot, or from its neighbors in the same frame, and only what the prediction misses is sent. Everything goes through an adaptive range coder with contexts (dot patterns are coded dot by dot against their neighbors, like JBIG2), so the format needs no general-purpose compressor and the decoder is small. Chunks of about two seconds start with an exact key frame; new scenes start new chunks. [FORMAT.md](FORMAT.md) describes the format completely; it is frozen since 1.0, every later version plays it. Sound can be embedded in the `.gcast` itself: it comes before the frames, and the player extracts it and keeps time by it. The playground has a converter that makes a `.gcast` from your video right in the browser (encoding runs in a Web Worker), shows how much smaller it got and the matching console command. Convert whole films in the console: a browser cannot hold their sound in memory. A chunk index sits at the end of the file: the player reads it with a range request and, when seeking, fetches the right place at once instead of waiting for the whole file. The format streams: chunks are length-prefixed, so a player starts with the first one, and a server can produce them live.

```sh
npx glyphcast encode movie.mp4 --cols 180 --embed --poster    # one file with Opus sound inside, plus movie.jpg
npx glyphcast encode movie.mp4 --detail                       # 2×4 dot pattern from the source: sharp text in braille, about 50% larger
npx glyphcast encode *.mp4 --embed                            # several videos in a row, with progress and time left
npx glyphcast encode movie.mp4 --cols 180 --audio movie.m4a   # sound as a separate file
npx glyphcast hub                                               # videos in the gcast hub, watch: npx glyphcast play hub:name
npx glyphcast play movie.gcast                                  # in the terminal: Space pause, ←/→ seek, M mode, G glyphs, C colors, [ ] saturation, B background, Q quit
npx glyphcast serve --dir ./videos                              # live streams
npx glyphcast micro movie.mp4 --cols 180                        # tiny H.264 at grid size
```

`glyphcast serve` turns YouTube links (with yt-dlp) and videos from `--dir` into live `.gcast` streams with a separate Opus audio stream, seeks by restarting at the requested second, and serves ready files with range requests. It listens on `127.0.0.1` only. Browsers cannot read YouTube frames themselves, so this is what makes YouTube work. `glyphcast play` accepts such a stream URL as well, so YouTube plays right in the terminal.

One minute of a film, picture only, 24 fps:

| What is sent | Size | Bitrate |
|---|---|---|
| Source, 1280×544 H.264 | 4.20 MB | 587 kbit/s |
| `.gcast` 0.26 (format 5), 180 columns, `--detail` | 1.55 MB | 217 kbit/s |
| `.gcast` 1.0 (format 6), 180 columns, `--detail` | 0.98 MB | 137 kbit/s |
| `.gcast` 1.0, 180 columns | 0.52 MB | 73 kbit/s |
| `.gcast` 1.0, 120 columns, `--detail` | 0.50 MB | 69 kbit/s |
| Micro video, 180 columns H.264 | 0.29 MB | 41 kbit/s |

Format 6 files are 32–39% smaller than format 5 on films, cartoons and screen recordings, and closer to the source (SSIM of the dot picture up by 0.03–0.07). Stream size depends on the grid and motion, not on the source resolution. A micro video at the grid size is smaller still: video codecs spend decades of tuning on pixels. `.gcast` instead stores what is drawn — cells and their dot patterns — so it needs no video decoder, plays the same in a browser and in a text terminal, keeps thin lines and text as dots, and can be generated or edited frame by frame. From Node, `glyphcast/node` exports `encodeVideo`, `encodeMicroVideo`, `extractAudio` and `serve`, and `Encoder` builds streams from raw frames of any source.

## Hub

[gcast hub](https://glc-hub.1lop.ru/) stores videos as `.gcast` and plays them in the browser. The same videos play in a terminal:

```sh
npx glyphcast hub                  # list and search
npx glyphcast play hub:<name>      # watch with sound, pause and seeking
npx glyphcast login                # sign in with Google (in the browser), needed to upload
npx glyphcast publish movie.mp4 --title "Name"   # encode three grids with sound and upload
```

Uploads need a Google sign-in, on the site or with `glc login`; a new video opens by its link at once and reaches the open list after review. [Rules and privacy](https://glc-hub.1lop.ru/rules).

## License

Mozilla Public License 2.0 (see LICENSE and NOTICE): changes to glyphcast's own files stay open, your code around it can stay closed. Versions up to 0.20.13 were MIT, 0.21.0–0.21.3 Apache 2.0.
