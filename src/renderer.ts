import { NEUTRAL, type Levels } from './levels.js';

export const DEFAULT_GLYPHS = ' .:-=+*#%@';
const EDGE_GLYPHS = '-/|\\';

/** How a cell is drawn: a glyph from the set, a 2×4 braille dot pattern, or a halftone dot sized by brightness. */
export type RenderMode = 'glyphs' | 'braille' | 'halftone';
const MODES: readonly RenderMode[] = ['glyphs', 'braille', 'halftone'];

export interface RendererOptions {
  /** Glyphs from dark to bright. Default `' .:-=+*#%@'`. */
  readonly glyphs?: string;
  /** Glyph height in device pixels. Default 16. */
  readonly glyphSize?: number;
  /** CSS font family for the glyphs. Default a monospace stack. */
  readonly font?: string;
  /** Background color, CSS hex. Default `#05070a`. */
  readonly background?: string;
}

export interface FrameStyle {
  readonly levels?: Levels;
  /** Saturation multiplier. 1 keeps colors, 0 is grayscale. Default 1.3. */
  readonly boost?: number;
  /** Paint every glyph in one color instead of the frame colors, CSS hex. */
  readonly tint?: string | null;
  /** Default `braille`. */
  readonly mode?: RenderMode;
  /** Draw contours with `- / | \` along their direction. Glyph mode only. Default false. */
  readonly edges?: boolean;
  /** Scanlines, vignette and glow of a tube screen. Default false. */
  readonly crt?: boolean;
  /** How much each cell's background takes its color, 0 for pure black. Softens contrast on large screens. Default 0.25. */
  readonly fill?: number;
  /** The pixels are this many times larger than the grid on each side, for example 2 after `upscale2x`. Default 1. */
  readonly detail?: number;
  /** Dot patterns from a detail stream, one byte per grid cell, drawn exactly in braille mode. */
  readonly masks?: Uint8Array | null;
  /** RGB of the dark dots of patterned cells (version 4 detail streams). */
  readonly shades?: Uint8Array | null;
}

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D cells;
uniform sampler2D atlas;
uniform sampler2D overlay;
uniform sampler2D patterns;
uniform float detailed;
uniform sampler2D shades;
uniform float shaded;
uniform vec2 grid;
uniform float glyphs;
uniform float brightness;
uniform float contrast;
uniform float boost;
uniform vec3 background;
uniform vec4 tint;
uniform int mode;
uniform float edges;
uniform float crt;
uniform float captions;
uniform float fill;
const vec3 WEIGHTS = vec3(0.299, 0.587, 0.114);
const float PI = 3.14159265;
const float SHADOWS = 0.72;
float leveled(float luma) {
  return pow(clamp((luma - 0.5) * contrast + 0.5 + brightness, 0.0, 1.0), SHADOWS);
}
float lumaAt(vec2 cell) {
  return dot(texture(cells, (clamp(cell, vec2(0.0), grid - 1.0) + 0.5) / grid).rgb, WEIGHTS);
}
vec3 paint(vec3 source, float level) {
  float luma = dot(source, WEIGHTS);
  vec3 vivid = clamp(mix(vec3(luma), source, boost) * (0.55 + level * 0.9), 0.0, 1.0);
  return mix(vivid, tint.rgb * (0.35 + level), tint.a);
}
float bayer(vec2 spot) {
  int index = int(spot.x) + int(spot.y) * 2;
  float[8] matrix = float[8](0.0625, 0.5625, 0.8125, 0.3125, 0.9375, 0.4375, 0.1875, 0.6875);
  return matrix[index];
}
void main() {
  vec2 at = uv;
  if (crt > 0.5) {
    vec2 centered = uv * 2.0 - 1.0;
    centered *= 1.0 + dot(centered.yx, centered.yx) * 0.07;
    at = centered * 0.5 + 0.5;
    if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) {
      color = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
  }
  vec2 position = at * grid;
  vec2 cell = floor(position);
  vec2 local = fract(position);
  vec3 source = texture(cells, (cell + 0.5) / grid).rgb;
  float level = leveled(dot(source, WEIGHTS));
  vec3 glyph = paint(source, level);
  float ink;
  vec3 under = glyph * 0.5;
  vec3 dark = source;
  if (mode == 1) {
    vec2 spot = floor(local * vec2(2.0, 4.0));
    vec3 near = texture(cells, (cell + (spot + 0.5) / vec2(2.0, 4.0)) / grid).rgb;
    float nearLevel = leveled(dot(near, WEIGHTS));
    float lit = step(bayer(spot) * 0.75, nearLevel);
    float pattern = detailed > 0.5 ? floor(texelFetch(patterns, ivec2(cell), 0).r * 255.0 + 0.5) : 0.0;
    if (pattern > 0.5) {
      lit = mod(floor(pattern / exp2(spot.y * 2.0 + spot.x)), 2.0);
      // the cell's color belongs to its bright dots; the gaps take the neighbors darker than it, averaged,
      // which is close to the real background: no grey box around letters and no black rim around moving shapes
      float own = dot(source, WEIGHTS);
      vec3 sum = vec3(0.0);
      float count = 0.0;
      for (int side = 0; side < 4; side += 1) {
        vec2 toward = side == 0 ? vec2(-1.0, 0.0) : side == 1 ? vec2(1.0, 0.0) : side == 2 ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
        vec3 beside = texture(cells, (cell + toward + 0.5) / grid).rgb;
        float weight = step(dot(beside, WEIGHTS), own - 0.04);
        sum += beside * weight;
        count += weight;
      }
      dark = count > 0.0 ? sum / count : source * 0.5;
      // version 4 files store the dark dots' color where this estimate would be wrong (zero elsewhere)
      if (shaded > 0.5) {
        vec3 stored = texelFetch(shades, ivec2(cell), 0).rgb;
        if (stored.r + stored.g + stored.b > 0.0) dark = stored;
      }
      under = paint(dark, leveled(dot(dark, WEIGHTS))) * 0.5;
    }
    vec2 inside = (fract(local * vec2(2.0, 4.0)) - 0.5) * vec2(1.2, 1.0);
    float shape = smoothstep(0.5, 0.36, length(inside));
    if (pattern > 0.5) {
      // every dot of a patterned cell is drawn: the bright ones in the cell's color, the others in the darker side's,
      // so an edge between a dark and a bright area keeps both and gets no black outline
      ink = shape;
      vec3 tone = lit > 0.5 ? source : dark;
      glyph = min(paint(tone, leveled(dot(tone, WEIGHTS))) * 1.3, vec3(1.0));
    } else {
      ink = lit * shape;
      glyph = min(paint(near, max(level, nearLevel)) * 1.3, vec3(1.0));
    }
  } else if (mode == 2) {
    float radius = sqrt(level) * 0.46;
    float distance = length((local - 0.5) * vec2(0.6, 1.0));
    ink = smoothstep(radius + 0.04, radius - 0.02, distance);
  } else {
    float index = min(glyphs - 1.0, floor(level * glyphs));
    if (edges > 0.5) {
      float gx = lumaAt(cell + vec2(1, -1)) + 2.0 * lumaAt(cell + vec2(1, 0)) + lumaAt(cell + vec2(1, 1)) - lumaAt(cell + vec2(-1, -1)) - 2.0 * lumaAt(cell + vec2(-1, 0)) - lumaAt(cell + vec2(-1, 1));
      float gy = lumaAt(cell + vec2(-1, 1)) + 2.0 * lumaAt(cell + vec2(0, 1)) + lumaAt(cell + vec2(1, 1)) - lumaAt(cell + vec2(-1, -1)) - 2.0 * lumaAt(cell + vec2(0, -1)) - lumaAt(cell + vec2(1, -1));
      vec2 gradient = vec2(gx / 0.6, gy) * contrast;
      if (length(gradient) > 0.9 && level > 0.12) {
        float angle = mod(atan(gx / 0.6, gy) + PI, PI);
        index = glyphs + mod(floor(angle / (PI / 4.0) + 0.5), 4.0);
      }
    }
    ink = texture(atlas, vec2((index + local.x) / (glyphs + 4.0), local.y)).r;
  }
  vec3 result = mix(mix(background, under, fill), glyph, ink);
  if (crt > 0.5) {
    result += paint(source, level) * 0.22;
    result *= 0.6 + 0.4 * abs(sin(position.y * PI * 2.0));
    vec2 center = at - 0.5;
    result *= 1.0 - dot(center, center) * 1.6;
  }
  if (captions > 0.5) {
    vec4 text = texture(overlay, at);
    result = mix(result, text.rgb, text.a);
  }
  color = vec4(result, 1.0);
}`;

const hex = (value: string): [number, number, number] => {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) throw new Error(`Expected a #rrggbb color, got ${value}`);
  const number = parseInt(match[1], 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
};

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Cannot create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile error');
  return shader;
};

/**
 * Draws a grid of colored cells as glyphs on a canvas with WebGL2. One texel per cell goes in, the shader picks
 * the glyph by brightness and paints it in the cell's color, so a 180-column frame is a single draw call.
 */
export class GlyphRenderer {
  glyphs: string;
  private readonly font: string;
  cellWidth: number;
  cellHeight: number;
  private readonly gl: WebGL2RenderingContext;
  private readonly cellsTexture: WebGLTexture;
  private readonly patternsTexture: WebGLTexture;
  private readonly shadesTexture: WebGLTexture;
  private readonly uniforms: Readonly<Record<string, WebGLUniformLocation | null>>;
  private cols = 0;
  private rows = 0;
  private caption: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, options: RendererOptions = {}) {
    this.glyphs = options.glyphs ?? DEFAULT_GLYPHS;
    if ([...this.glyphs].length < 2) throw new Error('At least two glyphs are needed');
    this.font = options.font ?? 'ui-monospace, "SFMono-Regular", Consolas, "DejaVu Sans Mono", monospace';
    const size = Math.round(options.glyphSize ?? 16);
    this.cellHeight = size;
    this.cellWidth = Math.max(2, Math.round(size * 0.6));
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link error');
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = Object.fromEntries(
      ['cells', 'atlas', 'overlay', 'grid', 'glyphs', 'brightness', 'contrast', 'boost', 'background', 'tint', 'mode', 'edges', 'crt', 'captions', 'fill', 'patterns', 'detailed', 'shades', 'shaded'].map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    this.cellsTexture = this.texture(0);
    this.texture(1);
    this.texture(2);
    this.patternsTexture = this.texture(3);
    this.shadesTexture = this.texture(4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(this.uniforms['cells'] ?? null, 0);
    gl.uniform1i(this.uniforms['atlas'] ?? null, 1);
    gl.uniform1i(this.uniforms['overlay'] ?? null, 2);
    gl.uniform1i(this.uniforms['patterns'] ?? null, 3);
    gl.uniform1i(this.uniforms['shades'] ?? null, 4);
    this.setGlyphs(this.glyphs);
    this.setBackground(options.background ?? '#05070a');
  }

  private texture(unit: number): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Switches the glyph set, from dark to bright. */
  setGlyphs(glyphs: string): void {
    const list = [...glyphs];
    if (list.length < 2) throw new Error('At least two glyphs are needed');
    this.glyphs = glyphs;
    const atlas = new OffscreenCanvas(this.cellWidth * (list.length + EDGE_GLYPHS.length), this.cellHeight);
    const context = atlas.getContext('2d');
    if (!context) throw new Error('Cannot draw the glyph atlas');
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${Math.round(this.cellHeight * 0.92)}px ${this.font}`;
    [...list, ...EDGE_GLYPHS].forEach((glyph, index) => context.fillText(glyph, (index + 0.5) * this.cellWidth, this.cellHeight * 0.54));
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.uniform1f(this.uniforms['glyphs'] ?? null, list.length);
  }

  /**
   * Shows text over the picture, drawn with the glyph font on the cell grid, or hides it with null. Used for
   * subtitles; lines are centered near the bottom.
   */
  setCaption(text: string | null): void {
    this.caption = text?.trim() || null;
    this.drawCaption();
  }

  private drawCaption(): void {
    const { gl } = this;
    gl.uniform1f(this.uniforms['captions'] ?? null, this.caption && this.cols ? 1 : 0);
    if (!this.caption || !this.cols) return;
    const scale = Math.max(1, Math.round(this.cols / 80));
    const lines = this.caption.split('\n');
    const height = this.rows * this.cellHeight;
    const layer = new OffscreenCanvas(this.cols * this.cellWidth, height);
    const context = layer.getContext('2d');
    if (!context) return;
    const lineHeight = this.cellHeight * scale;
    context.font = `${Math.round(lineHeight * 0.92)}px ${this.font}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    lines.forEach((line, index) => {
      const chars = [...line];
      const cells = chars.length * scale;
      const start = Math.max(0, Math.floor((this.cols - cells) / 2));
      const top = height - (lines.length - index + 1) * lineHeight;
      context.fillStyle = 'rgba(0, 0, 0, 0.78)';
      context.fillRect((start - scale) * this.cellWidth, top, (cells + scale * 2) * this.cellWidth, lineHeight);
      context.fillStyle = '#fff6c8';
      chars.forEach((char, at) => context.fillText(char, (start + (at + 0.5) * scale) * this.cellWidth, top + lineHeight * 0.54));
    });
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer);
  }

  /** Changes the glyph height in device pixels; the next frame is drawn at the new size. */
  setGlyphSize(size: number): void {
    const height = Math.max(4, Math.round(size));
    if (height === this.cellHeight) return;
    this.cellHeight = height;
    this.cellWidth = Math.max(2, Math.round(height * 0.6));
    this.setGlyphs(this.glyphs);
    this.cols = 0;
  }

  /** Sets the background color, CSS hex. */
  setBackground(color: string): void {
    this.gl.uniform3fv(this.uniforms['background'] ?? null, hex(color));
  }

  /** Canvas size in pixels for a grid, so each cell gets a full glyph. */
  size(cols: number, rows: number): { readonly width: number; readonly height: number } {
    return { width: cols * this.cellWidth, height: rows * this.cellHeight };
  }

  /** Draws one frame: `cols × rows` RGBA pixels, one per cell. */
  draw(pixels: Uint8Array | Uint8ClampedArray, cols: number, rows: number, style: FrameStyle = {}): void {
    const { gl, canvas } = this;
    const detail = style.detail ?? 1;
    if (pixels.length !== cols * rows * 4 * detail * detail) throw new Error(`Expected ${cols * rows * 4 * detail * detail} bytes for a ${cols}×${rows} frame at detail ${detail}, got ${pixels.length}`);
    if (cols !== this.cols || rows !== this.rows) {
      const { width, height } = this.size(cols, rows);
      canvas.width = width;
      canvas.height = height;
      this.cols = cols;
      this.rows = rows;
      this.drawCaption();
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const filter = detail > 1 ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols * detail, rows * detail, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    const levels = style.levels ?? NEUTRAL;
    gl.uniform2f(this.uniforms['grid'] ?? null, cols, rows);
    gl.uniform1f(this.uniforms['brightness'] ?? null, levels.brightness);
    gl.uniform1f(this.uniforms['contrast'] ?? null, levels.contrast);
    gl.uniform1f(this.uniforms['boost'] ?? null, style.boost ?? 1.3);
    gl.uniform4fv(this.uniforms['tint'] ?? null, style.tint ? [...hex(style.tint), 1] : [0, 0, 0, 0]);
    gl.uniform1i(this.uniforms['mode'] ?? null, Math.max(0, MODES.indexOf(style.mode ?? 'braille')));
    gl.uniform1f(this.uniforms['edges'] ?? null, style.edges ? 1 : 0);
    gl.uniform1f(this.uniforms['crt'] ?? null, style.crt ? 1 : 0);
    gl.uniform1f(this.uniforms['fill'] ?? null, style.fill ?? 0.25);
    const masks = style.masks && style.masks.length === cols * rows ? style.masks : null;
    gl.uniform1f(this.uniforms['detailed'] ?? null, masks ? 1 : 0);
    if (masks) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.patternsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, masks);
    }
    const shades = masks && style.shades && style.shades.length === cols * rows * 3 ? style.shades : null;
    gl.uniform1f(this.uniforms['shaded'] ?? null, shades ? 1 : 0);
    if (shades) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.shadesTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, cols, rows, 0, gl.RGB, gl.UNSIGNED_BYTE, shades);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
