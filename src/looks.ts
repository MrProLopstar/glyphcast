/** Glyph sets offered in the players' settings, from dark to bright. */
export const GLYPH_SETS: readonly (readonly [string, string])[] = [
  ['Классика', ' .:-=+*#%@'],
  ['Блоки', ' ░▒▓█'],
  ['Плотные', " .'`^,:;Il!i~+_-?][}{1)(|tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"],
  ['Точки', ' ·•●'],
  ['Двоичные', ' 01'],
  ['Матрица', ' ｰｨｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏ'],
];

/** Color modes offered in the players' settings: a name and a tint, or null for the frame colors. */
export const TINTS: readonly (readonly [string, string | null])[] = [
  ['Как в видео', null],
  ['Матрица', '#33ff66'],
  ['Ламповый', '#ffb35c'],
  ['Неон', '#5ce1ff'],
  ['Монохром', '#e8ecef'],
];
