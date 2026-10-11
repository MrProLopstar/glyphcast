# glyphcast

[![npm](https://img.shields.io/npm/v/glyphcast?color=f0a04b)](https://www.npmjs.com/package/glyphcast)
[![JSR](https://jsr.io/badges/@mrprolopstar/glyphcast)](https://jsr.io/@mrprolopstar/glyphcast)

[Русская версия](README.ru.md) · [Playground](https://mrprolopstar.github.io/glyphcast/)

Video as colored glyphs. A complete player for the browser: controls, settings, subtitles, keyboard shortcuts, picture-in-picture and fullscreen, with every frame redrawn as characters by a WebGL2 shader. A server can also send glyph frames instead of video, so the browser receives a compact `.gcast` stream rather than the footage itself. The same stream plays in a terminal too.

```sh
npm install glyphcast
```

```html
<script type="module">import 'glyphcast/element';</script>

<glyph-player src="movie.mp4" cols="160"></glyph-player>
<glyph-player src="movie.gcast" audio="movie.opus" subtitles="movie.vtt"></glyph-player>
<glyph-player youtube="https://youtu.be/…" server="http://127.0.0.1:8787"></glyph-player>
```

No bundler? `import 'https://cdn.jsdelivr.net/npm/glyphcast@0/dist/element.js/+esm'`.

## The player

`<glyph-player>` plays videos, cameras, local files and `.gcast` streams. Inside: play and pause, ±10 seconds, a seek bar with buffered range and time tooltip, volume, speed, picture-in-picture (Document PiP with the whole player where available, the picture alone elsewhere), fullscreen and a settings menu for grid width, render mode (glyphs, braille dots or halftone), glyph set, color mode, saturation, auto levels, contours and a tube screen look. Contours draw cells on object edges as `- / | \` along the edge; the tube look adds scanlines, vignette and glow. Controls hide while playing.

| Attribute | |
|---|---|
| `src` | Video URL or `.gcast` file |
| `audio` | Audio for a `.gcast` file |
| `youtube`, `file`, `server` | Stream through `glyphcast serve` (see below) |
| `subtitles` | WebVTT or SRT subtitles, drawn on the glyph grid |
| `cols` | Grid width in glyphs, default `160` |
| `glyphs` | Glyphs from dark to bright, default `' .:-=+*#%@'` |
| `tint` | One color for every glyph, for example `#33ff66` |
| `boost` | Saturation, default `1.3` |
| `autolevels` | `false` turns off per-scene brightness and contrast |
| `mode` | `glyphs`, `braille` or `halftone` |
| `edges`, `crt` | Contours and the tube screen look |
| `autoplay`, `muted`, `loop` | As on `<video>` |

Keys: Space or K play, ←/→ 5 s, J/L 10 s, ↑/↓ volume, M mute, F fullscreen, P picture-in-picture, 0–9 jump. Theme it with `--accent` and `--radius`; `element.load(fileOrStreamOrUrl)` and `element.player` give programmatic control.

Without UI, `GlyphPlayer` is the same engine with the media element API: `load`, `play`, `pause`, `seek`, `currentTime`, `duration`, `volume`, `muted`, `playbackRate`, `configure(look)`, `setCaptions(textOrUrl)` and the usual events.

## Glyphs instead of video

At 160 columns a frame is about nine thousand colored cells, far less than a video frame. `.gcast` stores 6-bit brightness per cell and one color per 2×2 cells, like 4:2:0 video. The grid is cut into 8×4 blocks: a block either repeats the previous frame shifted by a motion vector or carries a residual against it, quantized to the threshold. One- or two-second chunks are deflated and start with an exact key frame. The format streams: chunks are length-prefixed, so a player starts with the first one, and a server can produce them live.

```sh
npx glyphcast encode movie.mp4 --cols 180 --audio movie.opus   # file + audio
npx glyphcast play movie.gcast                                  # in the terminal
npx glyphcast serve --dir ./videos                              # live streams
npx glyphcast micro movie.mp4 --cols 180                        # tiny H.264 at grid size
```

`glyphcast serve` turns YouTube links (with yt-dlp) and videos from `--dir` into live `.gcast` streams with a separate Opus audio stream, seeks by restarting at the requested second, and serves ready files with range requests. It listens on `127.0.0.1` only. Browsers cannot read YouTube frames themselves, so this is what makes YouTube work. `glyphcast play` accepts such a stream URL as well, so YouTube plays right in the terminal.

One minute of a film, picture only:

| What is sent | Size | Bitrate |
|---|---|---|
| Source, 1280×544 H.264 (heavily compressed) | 4.9 MB | 650 kbit/s |
| `.gcast` v2 (0.2), 180 columns, 30 fps | 2.07 MB | 276 kbit/s |
| `.gcast` v3, 180 columns, 24 fps | 1.15 MB | 153 kbit/s |
| `.gcast` v3, 180 columns, 15 fps | 0.90 MB | 120 kbit/s |
| `.gcast` v3, 120 columns, 24 fps | 0.57 MB | 78 kbit/s |
| Micro video, 180 columns H.264 | 0.35 MB | 47 kbit/s |

Stream size depends on the grid and motion, not on the source resolution, so heavier sources save more. A micro video is smaller still, because video codecs have transforms and entropy coding that `.gcast` lacks; `.gcast` needs no video decoder, gives identical frames everywhere and can be generated or edited frame by frame. From Node, `glyphcast/node` exports `encodeVideo`, `encodeMicroVideo`, `extractAudio` and `serve`, and `Encoder` builds streams from raw frames of any source.

## License

MIT
