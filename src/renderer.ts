import { NEUTRAL, type Levels } from './levels.js';

export const DEFAULT_GLYPHS = ' .:-=+*#%@';

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
uniform vec2 grid;
uniform float glyphs;
uniform float brightness;
uniform float contrast;
uniform float boost;
uniform vec3 background;
uniform vec4 tint;
void main() {
  vec2 position = uv * grid;
  vec2 cell = floor(position);
  vec2 local = fract(position);
  vec3 source = texelFetch(cells, ivec2(cell), 0).rgb;
  float luma = dot(source, vec3(0.299, 0.587, 0.114));
  float level = clamp((luma - 0.5) * contrast + 0.5 + brightness, 0.0, 1.0);
  float index = min(glyphs - 1.0, floor(level * glyphs));
  float ink = texture(atlas, vec2((index + local.x) / glyphs, local.y)).r;
  vec3 vivid = clamp(mix(vec3(luma), source, boost) * (0.55 + level * 0.9), 0.0, 1.0);
  vec3 glyph = mix(vivid, tint.rgb * (0.35 + level), tint.a);
  color = vec4(mix(background, glyph, ink), 1.0);
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
  readonly cellWidth: number;
  readonly cellHeight: number;
  private readonly gl: WebGL2RenderingContext;
  private readonly cellsTexture: WebGLTexture;
  private readonly uniforms: Readonly<Record<string, WebGLUniformLocation | null>>;
  private cols = 0;
  private rows = 0;

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
      ['cells', 'atlas', 'grid', 'glyphs', 'brightness', 'contrast', 'boost', 'background', 'tint'].map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    this.cellsTexture = this.texture(0);
    this.texture(1);
    gl.uniform1i(this.uniforms['cells'] ?? null, 0);
    gl.uniform1i(this.uniforms['atlas'] ?? null, 1);
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
    const font = this.font;
    const atlas = new OffscreenCanvas(this.cellWidth * list.length, this.cellHeight);
    const context = atlas.getContext('2d');
    if (!context) throw new Error('Cannot draw the glyph atlas');
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `${Math.round(this.cellHeight * 0.92)}px ${font}`;
    list.forEach((glyph, index) => context.fillText(glyph, (index + 0.5) * this.cellWidth, this.cellHeight * 0.54));
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.uniform1f(this.uniforms['glyphs'] ?? null, list.length);
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
    if (pixels.length !== cols * rows * 4) throw new Error(`Expected ${cols * rows * 4} bytes for a ${cols}×${rows} frame, got ${pixels.length}`);
    if (cols !== this.cols || rows !== this.rows) {
      const { width, height } = this.size(cols, rows);
      canvas.width = width;
      canvas.height = height;
      this.cols = cols;
      this.rows = rows;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    const levels = style.levels ?? NEUTRAL;
    gl.uniform2f(this.uniforms['grid'] ?? null, cols, rows);
    gl.uniform1f(this.uniforms['brightness'] ?? null, levels.brightness);
    gl.uniform1f(this.uniforms['contrast'] ?? null, levels.contrast);
    gl.uniform1f(this.uniforms['boost'] ?? null, style.boost ?? 1.3);
    const tint = style.tint ? [...hex(style.tint), 1] : [0, 0, 0, 0];
    gl.uniform4fv(this.uniforms['tint'] ?? null, tint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
