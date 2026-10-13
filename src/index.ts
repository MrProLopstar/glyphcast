/**
 * # glyphcast
 *
 * Video as colored glyphs in the browser with WebGL2. `<glyph-player>` from `glyphcast/element` is a complete
 * player with controls; `GlyphPlayer` is the engine without UI. Both play videos, cameras and `.gcast` streams,
 * a compact stream of glyph frames that a server can send instead of video.
 *
 * ```ts
 * import { GlyphPlayer } from 'glyphcast';
 *
 * const player = new GlyphPlayer(document.querySelector('canvas')!, { cols: 160 });
 * await player.load('movie.mp4');
 * await player.play();
 * ```
 *
 * Encode streams with the CLI (`npx glyphcast encode video.mp4`) or `encodeVideo` from `glyphcast/node`.
 *
 * Документация на русском: https://github.com/MrProLopstar/glyphcast/blob/main/README.ru.md
 *
 * @module
 */
export { audioType, decodeChunk, decodeChunkMotion, detailMasks, interpolate, type DecodedChunk, Encoder, indexLength, INDEX_TRAILER, readIndex, type IndexEntry, frameChunk, GlyphcastError, readHeader, StreamReader, writeHeader, type Chunk, type EncodeOptions, type StreamInfo } from './format.js';
export { autoLevels, glyphIndex, luma, type Levels } from './levels.js';
export { captionAt, parseCaptions, type Cue } from './captions.js';
export { upscale2x } from './upscale.js';
export { DEFAULT_GLYPHS, GlyphRenderer, type FrameStyle, type RenderMode, type RendererOptions } from './renderer.js';
export { GlyphPlayer, sourceFor, type LookOptions, type PlayerOptions, type Source } from './player.js';
