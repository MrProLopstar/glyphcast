/**
 * # glyphcast
 *
 * Video as colored glyphs in the browser. `GlyphVideo` redraws any `<video>` as characters with WebGL2;
 * `GlyphStream` plays `.gcast` files, a compact stream of glyph frames that a server can send instead of video.
 *
 * ```ts
 * import { GlyphVideo } from 'glyphcast';
 *
 * const player = new GlyphVideo(document.querySelector('video')!, document.querySelector('canvas')!, { cols: 160 });
 * player.start();
 * ```
 *
 * Encode streams with the CLI (`npx glyphcast encode video.mp4`) or `encodeVideo` from `glyphcast/node`.
 *
 * Документация на русском: https://github.com/MrProLopstar/glyphcast/blob/main/README.ru.md
 *
 * @module
 */
export { Encoder, GlyphcastError, readHeader, decodeChunk, type EncodeOptions, type Header, type StreamInfo } from './format.js';
export { autoLevels, glyphIndex, luma, type Levels } from './levels.js';
export { DEFAULT_GLYPHS, GlyphRenderer, type FrameStyle, type RendererOptions } from './renderer.js';
export { GlyphStream, GlyphVideo, type PlaybackOptions, type StreamOptions, type VideoOptions } from './player.js';
