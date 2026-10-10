# glyphcast

[![npm](https://img.shields.io/npm/v/glyphcast?color=f0a04b)](https://www.npmjs.com/package/glyphcast)
[![JSR](https://jsr.io/badges/@mrprolopstar/glyphcast)](https://jsr.io/@mrprolopstar/glyphcast)

[Русская версия](README.ru.md) · [Playground](https://mrprolopstar.github.io/glyphcast/)

Video as colored glyphs. A complete player for the browser: controls, settings, keyboard shortcuts, picture-in-picture and fullscreen, with every frame redrawn as characters by a WebGL2 shader. A server can also send glyph frames instead of video, so the browser receives a compact `.gcast` stream rather than the footage itself.

```sh
npm install glyphcast
```

```html
<script type="module">import 'glyphcast/element';</script>

<glyph-player src="movie.mp4" cols="160"></glyph-player>
<glyph-player src="movie.gcast" audio="movie.opus"></glyph-player>
<glyph-player youtube="https://youtu.be/…" server="http://127.0.0.1:8787"></glyph-player>
```

No bundler? `import 'https://cdn.jsdelivr.net/npm/glyphcast@0/dist/element.js/+esm'`.

## The player

`<glyph-player>` plays videos, cameras, local files and `.gcast` streams. Inside: play and pause, ±10 seconds, a seek bar with buffered range and time tooltip, volume, speed, picture-in-picture (Document PiP with the whole player where available, the picture alone elsewhere), fullscreen and a settings menu for grid width, glyph set, color mode, saturation and auto levels. Controls hide while playing.

| Attribute | |
|---|---|
| `src` | Video URL or `.gcast` file |
| `audio` | Audio for a `.gcast` file |
| `youtube`, `file`, `server` | Stream through `glyphcast serve` (see below) |
| `cols` | Grid width in glyphs, default `160` |
| `glyphs` | Glyphs from dark to bright, default `' .:-=+*#%@'` |
| `tint` | One color for every glyph, for example `#33ff66` |
| `boost` | Saturation, default `1.3` |
| `autolevels` | `false` turns off per-scene brightness and contrast |
| `autoplay`, `muted`, `loop` | As on `<video>` |

Keys: Space or K play, ←/→ 5 s, J/L 10 s, ↑/↓ volume, M mute, F fullscreen, P picture-in-picture, 0–9 jump. Theme it with `--accent` and `--radius`; `element.load(fileOrStreamOrUrl)` and `element.player` give programmatic control.

Without UI, `GlyphPlayer` is the same engine with the media element API: `load`, `play`, `pause`, `seek`, `currentTime`, `duration`, `volume`, `muted`, `playbackRate`, `configure(look)` and the usual events.

## Glyphs instead of video

At 160 columns a frame is about nine thousand colored cells, far less than a video frame. `.gcast` stores them as 12-bit colors in byte planes, skips cells that barely changed and compresses one- or two-second chunks that each start with a key frame. The format streams: chunks are length-prefixed, so a player starts with the first one, and a server can produce them live.

```sh
npx glyphcast encode movie.mp4 --cols 180 --audio movie.opus   # file + audio
npx glyphcast serve --dir ./videos                              # live streams
npx glyphcast micro movie.mp4 --cols 180                        # tiny H.264 at grid size
```

`glyphcast serve` turns YouTube links (with yt-dlp) and videos from `--dir` into live `.gcast` streams with a separate Opus audio stream, seeks by restarting at the requested second, and serves ready files with range requests. It listens on `127.0.0.1` only. Browsers cannot read YouTube frames themselves, so this is what makes YouTube work.

For a 117-second clip:

| What is sent | Size | Bitrate |
|---|---|---|
| Source video, 1280×720 H.264 | 38.8 MB | 2.66 Mbit/s |
| `.gcast`, 180×61 glyphs, picture only | 3.6 MB | 254 kbit/s |
| Micro video, 180×60 H.264 with AAC audio | 1.7 MB | 117 kbit/s |

A micro video is smaller still, because video codecs predict motion; `.gcast` needs no video decoder, gives identical frames everywhere and can be generated or edited frame by frame. From Node, `glyphcast/node` exports `encodeVideo`, `encodeMicroVideo`, `extractAudio` and `serve`, and `Encoder` builds streams from raw frames of any source.

## License

MIT
