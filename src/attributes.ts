import type { RenderMode } from './renderer.js';

/** Props shared by the React and Vue wrappers; each becomes the `<glyph-player>` attribute of the same meaning. */
export interface GlyphPlayerAttributes {
  readonly src?: string;
  readonly audio?: string;
  readonly poster?: string;
  readonly subtitles?: string;
  readonly youtube?: string;
  readonly file?: string;
  readonly server?: string;
  readonly cols?: number;
  readonly glyphs?: string;
  readonly tint?: string;
  readonly boost?: number;
  readonly fill?: number;
  readonly autoLevels?: boolean;
  readonly mode?: RenderMode;
  readonly edges?: boolean;
  readonly crt?: boolean;
  readonly autoPlay?: boolean;
  readonly muted?: boolean;
  readonly loop?: boolean;
}

const NAMES: Readonly<Record<keyof GlyphPlayerAttributes, string>> = {
  src: 'src',
  audio: 'audio',
  poster: 'poster',
  subtitles: 'subtitles',
  youtube: 'youtube',
  file: 'file',
  server: 'server',
  cols: 'cols',
  glyphs: 'glyphs',
  tint: 'tint',
  boost: 'boost',
  fill: 'fill',
  autoLevels: 'autolevels',
  mode: 'mode',
  edges: 'edges',
  crt: 'crt',
  autoPlay: 'autoplay',
  muted: 'muted',
  loop: 'loop',
};

/** Events the React and Vue wrappers forward from `<glyph-player>`. */
export const PLAYER_EVENTS = ['play', 'pause', 'ended', 'timeupdate', 'error'] as const;

/** Turns wrapper props into the element's attributes (camelCase to lowercase, booleans to strings). */
export const attributesOf = (props: GlyphPlayerAttributes): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(NAMES) as [keyof GlyphPlayerAttributes, string][]) {
    const value = props[key];
    if (value === undefined || value === false) continue;
    out[name] = key === 'autoLevels' ? String(value) : value === true ? '' : String(value);
  }
  if (props.autoLevels === false) out['autolevels'] = 'false';
  return out;
};
