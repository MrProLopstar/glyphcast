# glyphcast

[![npm](https://img.shields.io/npm/v/glyphcast?color=f0a04b)](https://www.npmjs.com/package/glyphcast)
[![JSR](https://jsr.io/badges/@mrprolopstar/glyphcast)](https://jsr.io/@mrprolopstar/glyphcast)

[English version](README.md) · [Песочница](https://mrprolopstar.github.io/glyphcast/)

Видео цветными символами прямо в браузере. Любой `<video>`, камера или поток перерисовывается символами шейдером WebGL2, так что картинка в 180 колонок рисуется одним вызовом отрисовки при 60 fps. Сервер может присылать вместо видео сами символьные кадры: компактный поток `.gcast` или крошечное видео размером с сетку.

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

У видео остаются звук, управление и перемотка, а canvas просто показывает его кадры символами. Без зависимостей.

Без сборщика можно подключить с jsDelivr:

```html
<script type="module">
  import { GlyphVideo } from 'https://cdn.jsdelivr.net/npm/glyphcast@0/+esm';
</script>
```

## Опции

| Опция | По умолчанию | |
|---|---|---|
| `cols` | `160` | Ширина сетки; строки считаются по пропорциям видео и символа |
| `glyphs` | `' .:-=+*#%@'` | Символы от тёмного к светлому, подойдут любые, в том числе `░▒▓█` |
| `boost` | `1.3` | Насыщенность: `0` даёт оттенки серого, `2` яркие цвета |
| `autoLevels` | `true` | Подстраивает яркость и контраст под каждую сцену, плавно между склейками |
| `tint` | `null` | Один цвет для всех символов, например `'#33ff66'` |
| `glyphSize`, `font`, `background` | `16`, моноширинный, `#05070a` | Высота символа в пикселях, шрифт, фон |
| `fps` | `60` | Верхний предел перерисовок |

`player.configure({ boost, tint, autoLevels })` и `player.resize(cols)` меняют их на лету. Видео с другого домена должно отдаваться с CORS и `crossorigin="anonymous"`, иначе браузер не даст странице читать его пиксели.

## Символы вместо видео

При 180 колонках кадр состоит примерно из 11 тысяч цветных клеток, это намного меньше кадра видео. glyphcast умеет отправлять их двумя способами:

```sh
npx glyphcast encode movie.mp4 --cols 180 --audio movie.opus   # поток .gcast и звук
npx glyphcast micro movie.mp4 --cols 180                       # крошечное H.264 размером с сетку
```

Обоим нужен ffmpeg. Для ролика длиной 117 секунд:

| Что отправляется | Размер | Битрейт |
|---|---|---|
| Исходное видео, 1280×720 H.264 | 38,8 МБ | 2,66 Мбит/с |
| `.gcast`, 180×61 символов, только картинка | 3,6 МБ | 254 кбит/с |
| Микровидео, 180×60 H.264 со звуком AAC | 1,7 МБ | 117 кбит/с |

`.gcast` хранит 12-битные цвета в байтовых плоскостях, пропускает клетки, которые почти не изменились, и сжимает двухсекундные куски, каждый из которых начинается с опорного кадра. Поэтому воспроизведение начинается с первого куска и умеет перематывать. Ему не нужен видеодекодер, и на любом устройстве получаются одни и те же кадры. Микровидео ещё меньше, потому что видеокодеки предсказывают движение; его играют с `prescaled: true`:

```ts
import { GlyphStream, GlyphVideo } from 'glyphcast';

const stream = new GlyphStream(canvas, { audio: new Audio('movie.opus') });
await stream.load('movie.gcast');
stream.play();

new GlyphVideo(microVideo, canvas, { prescaled: true }).start();
```

`GlyphStream` идёт по часам звука, если он передан, иначе по своим. У него есть `play()`, `pause()`, `seek(seconds)`, `currentTime` и `duration`.

В Node модуль `glyphcast/node` даёт `encodeVideo`, `encodeMicroVideo` и `extractAudio`, а класс `Encoder` собирает поток из сырых кадров любого источника.

## Лицензия

MIT
