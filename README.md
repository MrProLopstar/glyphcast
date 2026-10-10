# glyphcast

[![npm](https://img.shields.io/npm/v/glyphcast?color=f0a04b)](https://www.npmjs.com/package/glyphcast)
[![JSR](https://jsr.io/badges/@mrprolopstar/glyphcast)](https://jsr.io/@mrprolopstar/glyphcast)

[Русская версия](README.ru.md) · [Playground](https://mrprolopstar.github.io/glyphcast/)

Video as colored glyphs in the browser. Any `<video>`, camera or stream is redrawn as characters by a WebGL2 shader, so a 180-column picture is one draw call at 60 fps. A server can also send glyph frames instead of video: a compact `.gcast` stream or a tiny video at grid size.

```sh
npm install glyphcast
```

```ts
import { GlyphVideo } from 'glyphcast';

const video = document.querySelector('video')!;
const player = new GlyphVideo(video, document.querySelector('canvas')!, { cols: 160 });
player.start();
video.play();
```

The video keeps its sound, controls and seeking; the canvas just shows its frames as glyphs. No dependencies.

No bundler? Load it from jsDelivr:

```html
<script type="module">
  import { GlyphVideo } from 'https://cdn.jsdelivr.net/npm/glyphcast@0/+esm';
</script>
```

## Options

| Option | Default | |
|---|---|---|
| `cols` | `160` | Grid width; rows follow the video aspect ratio and glyph proportions |
| `glyphs` | `' .:-=+*#%@'` | Glyphs from dark to bright, any characters including `░▒▓█` |
| `boost` | `1.3` | Saturation: `0` is grayscale, `2` is vivid |
| `autoLevels` | `true` | Adjusts brightness and contrast to each scene, smoothly between cuts |
| `tint` | `null` | One color for every glyph, for example `'#33ff66'` |
| `glyphSize`, `font`, `background` | `16`, monospace, `#05070a` | Glyph height in pixels, font stack, background |
| `fps` | `60` | Upper limit for redraws |

`player.configure({ boost, tint, autoLevels })` and `player.resize(cols)` change them on the fly. Cross-origin videos need CORS and `crossorigin="anonymous"`, otherwise the browser does not let the page read their pixels.

## Sending glyphs instead of video

At 180 columns a frame is about 11 thousand colored cells, far less than a video frame. glyphcast offers two ways to ship that:

```sh
npx glyphcast encode movie.mp4 --cols 180 --audio movie.opus   # .gcast stream + audio
npx glyphcast micro movie.mp4 --cols 180                       # tiny H.264 at grid size
```

Both need ffmpeg. For a 117-second clip:

| What is sent | Size | Bitrate |
|---|---|---|
| Source video, 1280×720 H.264 | 38.8 MB | 2.66 Mbit/s |
| `.gcast`, 180×61 glyphs, video only | 3.6 MB | 254 kbit/s |
| Micro video, 180×60 H.264 with AAC audio | 1.7 MB | 117 kbit/s |

`.gcast` stores 12-bit colors in byte planes, skips cells that barely changed and compresses two-second chunks, each starting with a key frame, so playback starts with the first chunk and can seek. It needs no video decoder and gives the same frames on every device. The micro video is smaller still, because video codecs predict motion; play it with `prescaled: true`:

```ts
import { GlyphStream, GlyphVideo } from 'glyphcast';

const stream = new GlyphStream(canvas, { audio: new Audio('movie.opus') });
await stream.load('movie.gcast');
stream.play();

new GlyphVideo(microVideo, canvas, { prescaled: true }).start();
```

`GlyphStream` follows the audio clock when audio is given, otherwise its own. It has `play()`, `pause()`, `seek(seconds)`, `currentTime` and `duration`.

From Node, `glyphcast/node` exports `encodeVideo`, `encodeMicroVideo` and `extractAudio`, and the `Encoder` class builds streams from raw frames of any source.

## License

MIT
