/**
 * `<glyph-player>`: a complete video player as a custom element, with controls, settings, subtitles, quality
 * switching, picture-in-picture and fullscreen. Importing this module defines the element.
 *
 * ```html
 * <script type="module">import 'glyphcast/element';</script>
 * <glyph-player src="movie.gcast"></glyph-player>
 * ```
 *
 * @module
 */
import { GlyphPlayer, sourceFor, type LookOptions, type Source } from './player.js';
import { GLYPH_SETS, TINTS } from './looks.js';
import type { RenderMode } from './renderer.js';

const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
  back: 'M11.5 6.5V3L6 8l5.5 5V9.5a5.5 5.5 0 1 1-5.5 5.5H4a7.5 7.5 0 1 0 7.5-8.5z',
  forward: 'M12.5 6.5V3L18 8l-5.5 5V9.5A5.5 5.5 0 1 0 18 15h2a7.5 7.5 0 1 1-7.5-8.5z',
  volume: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zm11.5-1.8a5 5 0 0 1 0 8.6l-1-1.7a3 3 0 0 0 0-5.2zm2.2-3.2a8.6 8.6 0 0 1 0 15l-1-1.7a6.6 6.6 0 0 0 0-11.6z',
  muted: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zm11.3.2 1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  pip: 'M3 5h18v14H3zm2 2v10h14V7zm6 4h7v5h-7z',
  full: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  exit: 'M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z',
} as const;

const MODES: readonly (readonly [string, RenderMode])[] = [
  ['Символы', 'glyphs'],
  ['Брайль', 'braille'],
  ['Растр', 'halftone'],
];


const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const GRIDS = [80, 120, 160, 200, 240, 320];

const STYLE = `
:host { display: block; position: relative; --accent: #f0a04b; --ink: #f4f6f8; --panel: rgba(12, 15, 20, 0.86); color-scheme: dark; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.player { position: relative; container-type: inline-size; width: 100%; aspect-ratio: var(--ratio, 16 / 9); background: #000; border-radius: var(--radius, 12px); overflow: hidden; outline: none; user-select: none; color: var(--ink); }
:host(:fullscreen) .player, .player.pip, :host([fullsize]) .player, :host(.filled) .player { border-radius: 0; height: 100%; aspect-ratio: auto; }
:host(.filled) { position: fixed; inset: 0; z-index: 2147483647; background: #000; }
canvas, .poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.poster { pointer-events: none; transition: opacity 0.3s; }
.poster.gone { opacity: 0; }
button { all: unset; cursor: pointer; display: grid; place-items: center; border-radius: 8px; color: inherit; }
button:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
svg { width: 22px; height: 22px; fill: currentColor; }
.center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.big { pointer-events: auto; width: 76px; height: 76px; border-radius: 50%; background: var(--accent); color: #111; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); transition: transform 0.15s, opacity 0.2s; }
.big svg { width: 34px; height: 34px; margin-left: 4px; }
.big:hover { transform: scale(1.06); }
.playing .big { opacity: 0; pointer-events: none; transform: scale(0.8); }
.touch.playing:not(.idle) .big { opacity: 0.9; pointer-events: auto; transform: none; }
.spinner { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px; box-sizing: border-box; border-radius: 50%; border: 3px solid rgba(255,255,255,0.2); border-top-color: var(--accent); animation: spin 0.8s linear infinite; display: none; }
.waiting .spinner { display: block; }
.waiting .big { opacity: 0; pointer-events: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.message { position: absolute; inset: auto 16px 80px; padding: 10px 14px; border-radius: 10px; background: rgba(120, 20, 20, 0.85); display: none; }
.message.on { display: block; }
.controls { position: absolute; left: 0; right: 0; bottom: 0; padding: 36px 12px 10px; background: linear-gradient(transparent, rgba(0,0,0,0.78)); transition: opacity 0.25s, transform 0.25s; }
.idle .controls { opacity: 0; transform: translateY(8px); pointer-events: none; }
.idle { cursor: none; }
.progress { position: relative; height: 18px; cursor: pointer; display: flex; align-items: center; margin: 0 4px; touch-action: none; }
.track { position: relative; width: 100%; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.22); transform: scaleY(0.67); transition: transform 0.15s; }
.progress:hover .track { transform: scaleY(1); }
.buffer, .played { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; }
.buffer { background: rgba(255,255,255,0.35); }
.played { background: var(--accent); }
.knob { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px; border-radius: 50%; background: var(--ink); box-shadow: 0 1px 6px rgba(0,0,0,0.5); transform: scale(0); transition: transform 0.15s; }
.progress:hover .knob { transform: scale(1); }
.thumb { position: absolute; top: auto; bottom: calc(100% + 30px); width: 160px; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,0.6); transform: translateX(-50%); opacity: 0; pointer-events: none; image-rendering: auto; object-fit: fill; }
@media (hover: hover) { .progress:hover .thumb.ready, .progress:hover .tip { opacity: 1; } }
.progress.scrub .thumb.ready, .progress.scrub .tip { opacity: 1; }
.tip { position: absolute; bottom: 22px; padding: 3px 7px; border-radius: 6px; background: var(--panel); font: 12px ui-monospace, Consolas, monospace; transform: translateX(-50%); opacity: 0; pointer-events: none; }
.row { display: flex; align-items: center; gap: 2px; margin-top: 4px; }
.row button { width: 38px; height: 38px; }
.row button:hover { background: rgba(255,255,255,0.12); }
.time { font: 13px ui-monospace, Consolas, monospace; margin: 0 10px; white-space: nowrap; }
.spacer { flex: 1; }
.volume { display: flex; align-items: center; }
.volume input { width: 84px; margin-right: 6px; opacity: 0.75; transition: opacity 0.2s; accent-color: var(--accent); }
.volume:hover input, .volume input:focus { opacity: 1; }
.menu { position: absolute; z-index: 2; right: 12px; bottom: 64px; min-width: 240px; max-height: calc(100% - 80px); overflow: auto; padding: 8px; border-radius: 12px; background: var(--panel); backdrop-filter: blur(10px); box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; }
.menu.on { display: block; }
.menu .close { display: none; }
.menu h4 { margin: 8px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 6px 6px; }
.chips button { padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,0.08); font-size: 13px; }
.chips button[aria-pressed="true"] { background: var(--accent); color: #111; }
.line { display: flex; align-items: center; gap: 10px; padding: 4px 8px 8px; }
.line input[type="range"] { flex: 1; accent-color: var(--accent); }
.line output { font: 12px ui-monospace, Consolas, monospace; min-width: 32px; text-align: right; }
.toggle { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 8px; width: 100%; box-sizing: border-box; }
.toggle:hover { background: rgba(255,255,255,0.08); }
.switch { width: 34px; height: 20px; border-radius: 10px; background: rgba(255,255,255,0.25); position: relative; transition: background 0.2s; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
[aria-checked="true"] .switch { background: var(--accent); }
[aria-checked="true"] .switch::after { transform: translateX(14px); }
.badge { position: absolute; top: 12px; left: 12px; max-width: calc(100% - 140px); padding: 4px 10px; border-radius: 6px; background: var(--panel); font: 600 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; opacity: 0.9; transition: opacity 0.3s; display: flex; gap: 10px; align-items: baseline; }
.badge a { color: var(--accent); font-weight: 400; font-size: 12px; text-decoration: none; white-space: nowrap; }
.badge a:hover { text-decoration: underline; }
.idle .badge { opacity: 0; }
@container (max-width: 520px) {
  .back, .forward, .volume input { display: none; }
  .time { margin: 0 4px; font-size: 12px; }
  .big { width: 56px; height: 56px; }
  .big svg { width: 26px; height: 26px; margin-left: 3px; }
  .controls { padding: 24px 6px 4px; }
  .row { margin-top: 0; }
  .row button { width: 36px; height: 36px; }
  svg { width: 20px; height: 20px; }
  /* a small player has no room for a floating panel: the menu covers it, one scrolling row per setting */
  .menu { inset: 0; min-width: 0; max-height: none; border-radius: 0; padding: 4px 0 8px; background: rgba(12,12,14,0.94); overscroll-behavior: contain; }
  .menu h4 { margin: 6px 12px 3px; font-size: 10px; }
  .chips { flex-wrap: nowrap; overflow-x: auto; padding: 0 12px 4px; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chips button { flex: none; padding: 6px 12px; }
}
/* on a small player the menu is a sheet over the bottom of the screen, like on YouTube: big targets, the page dimmed behind */
.scrim { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,0.5); display: none; }
.scrim.on { display: block; }
.menu.sheet { position: fixed; inset: auto 0 0 0; z-index: 2147483647; min-width: 0; max-height: min(75vh, 560px); padding: 6px 0 calc(12px + env(safe-area-inset-bottom, 0px)); border-radius: 16px 16px 0 0; background: #17171b; color: var(--ink, #fff); overscroll-behavior: contain; font: 15px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.menu.sheet::before { content: ''; display: block; width: 40px; height: 4px; margin: 4px auto 6px; border-radius: 2px; background: rgba(255,255,255,0.3); }
.menu.sheet h4 { margin: 12px 16px 6px; font-size: 12px; }
.menu.sheet .chips { flex-wrap: wrap; overflow: visible; padding: 0 16px; gap: 8px; }
.menu.sheet .chips button { padding: 9px 16px; font-size: 15px; }
.menu.sheet .toggle { padding: 12px 16px; font-size: 15px; border-radius: 0; }
.menu.sheet .line { padding: 4px 16px 10px; }
.menu.sheet.on { display: flex; flex-direction: column; box-sizing: border-box; }
.menu.sheet > * { flex: none; }
.menu.sheet.side { inset: 0 0 0 auto; width: min(420px, 55vw); max-height: none; border-radius: 16px 0 0 16px; padding-top: 4px; }
.menu.sheet.side::before { display: none; }
.menu.sheet .close { display: block; order: 1; position: sticky; bottom: 0; box-sizing: border-box; width: calc(100% - 32px); margin: 16px 16px 0; text-align: center; box-shadow: 0 -12px 16px #17171b, 0 14px 0 14px #17171b; padding: 12px; border-radius: 12px; background: var(--accent); color: #111; font-weight: 600; font-size: 16px; }
`;

const icon = (path: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

type DocumentPip = { requestWindow: (options: { width: number; height: number }) => Promise<Window> };

/**
 * `<glyph-player>`: a complete glyph video player with controls, settings, keyboard shortcuts, picture-in-picture
 * and fullscreen.
 *
 * ```html
 * <glyph-player src="movie.mp4" cols="160"></glyph-player>
 * <glyph-player src="movie.gcast" audio="movie.opus"></glyph-player>
 * <glyph-player youtube="https://youtu.be/…" server="http://127.0.0.1:8787"></glyph-player>
 * ```
 *
 * Attributes: `src`, `poster` (image shown until the first frame), `audio`, `youtube`, `file` (a video in the server folder), `server`, `subtitles` (WebVTT or SRT URL),
 * `cols`, `glyphs`, `tint`, `boost`, `autolevels`, `mode` (`glyphs`, `braille`, `halftone`), `edges`, `crt`, `autoplay`,
 * `muted`, `loop`, `sources` (JSON list of `{ cols, src }` qualities, picked by width), `fullsize` (fill the element's own size, for embeds). The `player` property gives the underlying `GlyphPlayer`.
 */
export class GlyphPlayerElement extends HTMLElement {
  static readonly observedAttributes = ['src', 'audio', 'youtube', 'file', 'server', 'poster', 'subtitles', 'cols', 'glyphs', 'tint', 'boost', 'autolevels', 'fill', 'mode', 'edges', 'crt', 'sharp', 'smooth', 'sources', 'heading', 'source'];

  readonly player: GlyphPlayer;
  private readonly root: ShadowRoot;
  private readonly frame: HTMLDivElement;
  private readonly $: (selector: string) => HTMLElement;
  private idleTimer: number | null = null;
  private seeking = false;
  private pipWindow: Window | null = null;
  private pipVideo: HTMLVideoElement | null = null;
  private loading = 0;
  private previewTicket = 0;
  private quality = 0;
  /** The grid follows the player's size and drops a step when playback keeps waiting for data. */
  private autoQuality = true;
  private stalls: number[] = [];

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${STYLE}</style>
<div class="player" tabindex="0">
  <canvas part="canvas"></canvas>
  <img class="poster gone" part="poster" alt="">
  <div class="badge" hidden></div>
  <div class="center"><button class="big" aria-label="Play">${icon(ICONS.play)}</button></div>
  <div class="spinner"></div>
  <div class="message" role="alert"></div>
  <div class="menu" role="menu"></div>
  <div class="controls" part="controls">
    <div class="progress" role="slider" aria-label="Seek" tabindex="-1"><div class="track"><div class="buffer"></div><div class="played"></div><div class="knob"></div></div><canvas class="thumb"></canvas><div class="tip">0:00</div></div>
    <div class="row">
      <button class="play" aria-label="Play">${icon(ICONS.play)}</button>
      <button class="back" aria-label="Back 10 seconds">${icon(ICONS.back)}</button>
      <button class="forward" aria-label="Forward 10 seconds">${icon(ICONS.forward)}</button>
      <div class="volume"><button class="mute" aria-label="Mute">${icon(ICONS.volume)}</button><input class="level" type="range" min="0" max="1" step="0.02" value="1" aria-label="Volume"></div>
      <span class="time">0:00 / 0:00</span>
      <span class="spacer"></span>
      <button class="settings" aria-label="Settings" aria-haspopup="menu">${icon(ICONS.settings)}</button>
      <button class="pip" aria-label="Picture in picture">${icon(ICONS.pip)}</button>
      <button class="full" aria-label="Fullscreen">${icon(ICONS.full)}</button>
    </div>
  </div>
</div>`;
    const frame = this.root.querySelector<HTMLDivElement>('.player');
    if (!frame) throw new Error('Missing .player');
    this.frame = frame;
    const find = (selector: string): HTMLElement => {
      const node = frame.querySelector<HTMLElement>(selector) ?? this.root.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`Missing ${selector}`);
      return node;
    };
    this.$ = find;
    this.player = new GlyphPlayer(find('canvas') as HTMLCanvasElement, this.look());
    this.wire();
    new ResizeObserver(() => this.fit()).observe(this.frame);
  }

  private look(): LookOptions {
    const tint = this.getAttribute('tint');
    return {
      ...(this.hasAttribute('cols') ? { cols: Number(this.getAttribute('cols')) } : {}),
      ...(this.getAttribute('glyphs') ? { glyphs: this.getAttribute('glyphs') ?? undefined } : {}),
      ...(tint !== null ? { tint: tint || null } : {}),
      ...(this.hasAttribute('boost') ? { boost: Number(this.getAttribute('boost')) } : {}),
      ...(this.hasAttribute('autolevels') ? { autoLevels: this.getAttribute('autolevels') !== 'false' } : {}),
      ...(this.hasAttribute('fill') ? { fill: Number(this.getAttribute('fill')) } : {}),
      ...(this.hasAttribute('mode') ? { mode: this.getAttribute('mode') as RenderMode } : {}),
      edges: this.flag('edges'),
      ...(this.hasAttribute('sharp') ? { sharp: this.getAttribute('sharp') !== 'false' } : {}),
      ...(this.hasAttribute('smooth') ? { smooth: this.getAttribute('smooth') !== 'false' } : {}),
      crt: this.flag('crt'),
    } as LookOptions;
  }

  private flag(name: string): boolean {
    return this.hasAttribute(name) && this.getAttribute(name) !== 'false';
  }

  private captions(): void {
    const url = this.getAttribute('subtitles');
    this.player.setCaptions(url ? new URL(url, document.baseURI) : null).catch((error: unknown) => this.message(error instanceof Error ? error.message : String(error)));
  }

  connectedCallback(): void {
    if (this.hasAttribute('muted')) this.player.muted = true;
    void this.reload();
    if (this.hasAttribute('subtitles')) this.captions();
  }

  disconnectedCallback(): void {
    this.player.destroy();
    this.silence?.pause();
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next || !this.isConnected) return;
    if (['src', 'audio', 'youtube', 'file', 'server', 'sources'].includes(name)) void this.reload();
    else if (name === 'subtitles') this.captions();
    else if (name === 'heading' || name === 'source') this.badge(null);
    else this.player.configure(this.look());
    this.renderMenu();
  }

  /** Loads a source programmatically: a URL, a file, a camera stream or a full `Source`. */
  async load(source: Source | string | Blob | MediaStream): Promise<void> {
    const resolved: Source = typeof source === 'string' ? sourceFor(source, this.getAttribute('audio') ?? undefined) : source instanceof Blob || source instanceof MediaStream ? { type: 'video', src: source } : source;
    const ticket = (this.loading += 1);
    this.message(null);
    this.frame.classList.add('waiting');
    this.poster(true);
    try {
      await this.player.load(resolved);
      if (ticket !== this.loading) return;
      // the poster stays until playback starts or the picture moves away from the start
      if (!this.getAttribute('poster')) this.poster(false);
      this.updateRatio();
      this.renderMenu();
      this.update();
      if (this.hasAttribute('autoplay')) await this.player.play().catch(() => undefined);
    } catch (error) {
      if (ticket === this.loading) this.message(error instanceof Error ? error.message : String(error));
    } finally {
      if (ticket === this.loading) this.frame.classList.remove('waiting');
    }
  }

  private async reload(): Promise<void> {
    const youtube = this.getAttribute('youtube');
    const file = this.getAttribute('file');
    if (youtube || file) {
      const server = (this.getAttribute('server') ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
      const cols = Number(this.getAttribute('cols') ?? 160);
      const what = youtube ? `url=${encodeURIComponent(youtube)}` : `file=${encodeURIComponent(file ?? '')}`;
      const query = (start: number): string => `${what}&cols=${cols}&start=${start.toFixed(2)}`;
      try {
        const info = (await (await fetch(`${server}/info?${what}`)).json()) as { title?: string; duration?: number; error?: string };
        if (info.error) throw new Error(info.error);
        this.badge(info.title ?? null);
        await this.load({ type: 'gcast', src: `${server}/stream?${query(0)}`, audio: `${server}/audio?${query(0)}`, duration: info.duration ?? 0, restart: (start) => ({ src: `${server}/stream?${query(start)}`, audio: `${server}/audio?${query(start)}` }) });
      } catch (error) {
        this.message(`Сервер ${server} не открыл видео: ${error instanceof Error ? error.message : String(error)}. Запустите npx glyphcast serve`);
      }
      return;
    }
    const sources = this.sources();
    this.badge(null);
    if (sources.length > 0) {
      this.quality = this.autoQuality || !this.quality ? this.fittingQuality() : this.quality;
      const chosen = sources.find((source) => source.cols === this.quality);
      if (chosen) await this.load(this.variant(chosen.src));
      return;
    }
    const src = this.getAttribute('src');
    if (src) await this.load(src);
  }

  /** Alternative files from the `sources` attribute, a JSON list of `{ cols, src }`, sorted from small to large. */
  private sources(): { readonly cols: number; readonly src: string }[] {
    try {
      const list = JSON.parse(this.getAttribute('sources') ?? '[]') as { cols: number; src: string }[];
      return list.filter((item) => item.cols > 0 && typeof item.src === 'string').sort((a, b) => a.cols - b.cols);
    } catch {
      return [];
    }
  }

  /** A grid variant plays the sound embedded in the main file (`src`) when it carries none of its own. */
  private variant(src: string): Source | string {
    const main = this.getAttribute('src');
    return main && main !== src && /\.gcast(?:$|[?#])/i.test(src) ? { type: 'gcast', src, sound: main } : src;
  }

  /** The largest grid whose cells stay at least 8 device pixels wide in this player. */
  private fittingQuality(): number {
    const sources = this.sources();
    const target = ((this.frame.clientWidth || 800) * devicePixelRatio) / 8;
    return (sources.filter((source) => source.cols <= target).at(-1) ?? sources[0])?.cols ?? 0;
  }

  /** Auto quality: on a resize (fullscreen, rotation) takes the fitting grid; after three stalls in a minute, a smaller one. */
  private adaptQuality(stalled: boolean): void {
    if (!this.autoQuality || this.sources().length < 2 || !this.quality) return;
    if (stalled) {
      const now = performance.now();
      this.stalls = [...this.stalls.filter((at) => now - at < 60000), now];
      if (this.stalls.length < 3) return;
      this.stalls = [];
      const smaller = this.sources().filter((source) => source.cols < this.quality).at(-1);
      if (smaller) void this.switchQuality(smaller.cols, true);
      return;
    }
    const fitting = this.fittingQuality();
    if (fitting !== this.quality && this.stalls.length === 0) void this.switchQuality(fitting, true);
  }

  private async switchQuality(cols: number, auto = false): Promise<void> {
    this.autoQuality = auto;
    const source = this.sources().find((item) => item.cols === cols);
    if (!source || cols === this.quality) return;
    const time = this.player.currentTime;
    const playing = !this.player.paused;
    this.quality = cols;
    await this.load(this.variant(source.src));
    await this.player.seek(time);
    if (playing) await this.player.play().catch(() => undefined);
  }

  private poster(show: boolean): void {
    const image = this.$('.poster') as HTMLImageElement;
    const url = this.getAttribute('poster');
    if (url && image.getAttribute('src') !== url) image.src = url;
    image.classList.toggle('gone', !show || !url);
  }

  private sessionAt = 0;
  private silence: HTMLAudioElement | null = null;

  /**
   * A quiet loop for pictures without sound: systems only show their media controls for pages that play audio,
   * so a silent track keeps the notification, the media keys and the lock screen working.
   */
  private hush(): void {
    const playing = !this.player.paused && !this.player.hasAudio;
    if (playing && !this.silence) {
      const rate = 8000;
      const wav = new DataView(new ArrayBuffer(44 + rate));
      const text = (at: number, value: string) => [...value].forEach((char, index) => wav.setUint8(at + index, char.charCodeAt(0)));
      text(0, 'RIFF');
      wav.setUint32(4, 36 + rate, true);
      text(8, 'WAVEfmt ');
      wav.setUint32(16, 16, true);
      wav.setUint16(20, 1, true);
      wav.setUint16(22, 1, true);
      wav.setUint32(24, rate, true);
      wav.setUint32(28, rate, true);
      wav.setUint16(32, 1, true);
      wav.setUint16(34, 8, true);
      text(36, 'data');
      wav.setUint32(40, rate, true);
      for (let at = 44; at < 44 + rate; at += 1) wav.setUint8(at, 128);
      this.silence = new Audio(URL.createObjectURL(new Blob([wav.buffer], { type: 'audio/wav' })));
      this.silence.loop = true;
    }
    if (!this.silence) return;
    if (playing) void this.silence.play().catch(() => undefined);
    else this.silence.pause();
  }

  /**
   * Tells the system about the playback: the title and poster in the Windows media flyout and the phone's
   * notification, and the play, pause, seek and track keys of keyboards, headsets and lock screens.
   * Systems show it while the page plays sound.
   */
  private mediaSession(position = false): void {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
    if (!session) return;
    const player = this.player;
    if (position) {
      // the position is reported a few times a second at most
      const now = performance.now();
      if (now - this.sessionAt < 1000) return;
      this.sessionAt = now;
    } else {
      const title = this.getAttribute('heading') ?? document.title;
      const poster = this.getAttribute('poster');
      session.metadata = new MediaMetadata({ title, artist: 'glyphcast', ...(poster ? { artwork: [{ src: new URL(poster, location.href).href, sizes: '960x540', type: 'image/jpeg' }] } : {}) });
      const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => void player.play().catch(() => undefined)],
        ['pause', () => player.pause()],
        ['stop', () => player.pause()],
        ['seekbackward', (details) => void player.seek(Math.max(0, player.currentTime - (details.seekOffset ?? 10)))],
        ['seekforward', (details) => void player.seek(Math.min(player.duration, player.currentTime + (details.seekOffset ?? 10)))],
        ['seekto', (details) => details.seekTime !== undefined && void player.seek(details.seekTime)],
      ];
      for (const [action, handler] of handlers) {
        try {
          session.setActionHandler(action, handler);
        } catch {
          // older browsers do not know every action
        }
      }
    }
    session.playbackState = player.paused ? 'paused' : 'playing';
    const duration = player.duration;
    if (Number.isFinite(duration) && duration > 0) {
      try {
        session.setPositionState({ duration, position: Math.min(duration, Math.max(0, player.currentTime)), playbackRate: player.playbackRate || 1 });
      } catch {
        // a position outside the duration while a stream grows
      }
    }
  }

  /** The title in the top left corner: a server video's own title, else the `heading` attribute, with a link to `source`. */
  private badge(text: string | null): void {
    const badge = this.$('.badge');
    const title = text ?? this.getAttribute('heading');
    const source = this.getAttribute('source');
    badge.hidden = !title && !source;
    badge.textContent = title ?? '';
    if (source && (source.startsWith('https://') || source.startsWith('http://'))) {
      const link = document.createElement('a');
      link.href = source;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'оригинал ↗';
      badge.append(link);
    }
  }

  private message(text: string | null): void {
    const box = this.$('.message');
    box.textContent = text ?? '';
    box.classList.toggle('on', Boolean(text));
  }

  private updateRatio(): void {
    const { cols, rows } = this.player.grid();
    this.frame.style.setProperty('--ratio', `${cols * 0.6} / ${rows}`);
    this.fit();
  }

  private fit(): void {
    if (this.frame.clientHeight > 0) this.player.fit(this.frame.clientHeight * devicePixelRatio);
    this.adaptQuality(false);
  }

  togglePlay(): void {
    if (this.player.paused) {
      void this.player.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) this.message(error instanceof Error ? error.message : String(error));
      });
    }
    else this.player.pause();
  }

  private skip(seconds: number): void {
    void this.player.seek(this.player.currentTime + seconds);
  }

  private wire(): void {
    const player = this.player;
    const on = (selector: string, handler: (event: Event) => void): void => this.$(selector).addEventListener('click', handler);
    on('.big', () => this.togglePlay());
    on('.play', () => this.togglePlay());
    on('.back', () => this.skip(-10));
    on('.forward', () => this.skip(10));
    on('.mute', () => (player.muted = !player.muted));
    on('.full', () => void this.toggleFullscreen());
    on('.pip', () => void this.togglePip());
    on('.settings', (event) => {
      event.stopPropagation();
      this.toggleMenu(!this.$('.menu').classList.contains('on'));
    });
    this.frame.addEventListener('pointerdown', (event) => this.frame.classList.toggle('touch', event.pointerType === 'touch'));
    this.$('canvas').addEventListener('click', () => {
      if (this.$('.menu').classList.contains('on')) this.toggleMenu(false);
      else if (!this.frame.classList.contains('touch')) this.togglePlay();
      else if (this.frame.classList.contains('idle') || this.player.paused) this.wake();
      else this.frame.classList.add('idle');
    });
    this.$('canvas').addEventListener('dblclick', () => void this.toggleFullscreen());
    const level = this.$('.level') as HTMLInputElement;
    level.addEventListener('input', () => {
      player.volume = Number(level.value);
      player.muted = player.volume === 0;
    });

    const progress = this.$('.progress');
    const share = (event: PointerEvent): number => {
      const box = progress.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    };
    progress.addEventListener('pointermove', (event) => {
      const tip = this.$('.tip');
      const value = share(event);
      tip.textContent = clock(value * player.duration);
      tip.style.left = `${value * 100}%`;
      this.thumbnail(value * player.duration, value);
      if (this.seeking) this.paintProgress(value);
    });
    progress.addEventListener('pointerdown', (event) => {
      this.seeking = true;
      progress.classList.add('scrub');
      progress.setPointerCapture(event.pointerId);
      this.paintProgress(share(event));
      progress.dispatchEvent(new PointerEvent('pointermove', event));
    });
    progress.addEventListener('pointerup', (event) => {
      this.seeking = false;
      progress.classList.remove('scrub');
      void player.seek(share(event) * player.duration);
    });
    progress.addEventListener('pointercancel', () => {
      this.seeking = false;
      progress.classList.remove('scrub');
      this.update();
    });

    for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'ratechange', 'ended', 'loadedmetadata']) player.addEventListener(type, () => this.update());
    player.addEventListener('waiting', () => {
      this.frame.classList.add('waiting');
      if (!player.paused && player.currentTime > 0.5) this.adaptQuality(true);
    });
    player.addEventListener('playing', () => this.frame.classList.remove('waiting'));
    player.addEventListener('play', () => this.poster(false));
    player.addEventListener('play', () => {
      this.hush();
      this.mediaSession();
    });
    player.addEventListener('pause', () => {
      this.hush();
      this.mediaSession();
    });
    player.addEventListener('timeupdate', () => {
      // the real sound may arrive later (a film's embedded track loads in the background) and replaces the silence
      if (this.silence && !this.silence.paused && this.player.hasAudio) this.hush();
      this.mediaSession(true);
    });
    player.addEventListener('timeupdate', () => player.currentTime > 0.05 && this.poster(false));
    player.addEventListener('error', (event) => this.message(String((event as CustomEvent<Error>).detail?.message ?? 'Playback error')));
    player.addEventListener('ended', () => {
      if (this.hasAttribute('loop')) void player.play();
    });

    this.frame.addEventListener('pointermove', () => this.wake());
    this.frame.addEventListener('pointerleave', () => this.sleep(600));
    this.frame.addEventListener('keydown', (event) => this.key(event));
    this.frame.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement).closest('.menu, .settings')) this.toggleMenu(false);
    });
    document.addEventListener('fullscreenchange', () => this.update());
  }

  private key(event: KeyboardEvent): void {
    const player = this.player;
    const actions: Record<string, () => void> = {
      ' ': () => this.togglePlay(),
      k: () => this.togglePlay(),
      ArrowLeft: () => this.skip(-5),
      ArrowRight: () => this.skip(5),
      j: () => this.skip(-10),
      l: () => this.skip(10),
      ArrowUp: () => (player.volume = player.volume + 0.1),
      ArrowDown: () => (player.volume = player.volume - 0.1),
      m: () => (player.muted = !player.muted),
      f: () => void this.toggleFullscreen(),
      p: () => void this.togglePip(),
      Escape: () => {
        if (this.classList.contains('filled')) void this.toggleFullscreen();
      },
    };
    const digit = /^[0-9]$/.test(event.key) ? () => void player.seek((Number(event.key) / 10) * player.duration) : undefined;
    const action = actions[event.key] ?? actions[event.key.toLowerCase()] ?? digit;
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    action();
    this.wake();
  }

  private wake(): void {
    this.frame.classList.remove('idle');
    this.sleep(2600);
  }

  private sleep(delay: number): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.player.paused && !this.$('.menu').classList.contains('on')) this.frame.classList.add('idle');
    }, delay);
  }

  private thumbnail(seconds: number, share: number): void {
    const canvas = this.$('.thumb') as HTMLCanvasElement;
    const box = this.$('.progress').getBoundingClientRect();
    canvas.style.left = `${Math.min(Math.max(share * box.width, 84), box.width - 84)}px`;
    const ticket = (this.previewTicket += 1);
    void this.player.preview(seconds).then((picture) => {
      if (ticket !== this.previewTicket) return;
      canvas.classList.toggle('ready', Boolean(picture));
      if (!picture) return;
      canvas.width = picture.cols;
      canvas.height = picture.rows;
      canvas.style.height = `${(160 * picture.rows) / (picture.cols * 0.6)}px`;
      canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(picture.pixels), picture.cols, picture.rows), 0, 0);
    }).catch(() => canvas.classList.remove('ready'));
  }

  private paintProgress(share: number): void {
    this.$('.played').style.width = `${share * 100}%`;
    this.$('.knob').style.left = `${share * 100}%`;
  }

  private update(): void {
    const player = this.player;
    const duration = player.duration;
    const paused = player.paused;
    this.frame.classList.toggle('playing', !paused);
    const playIcon = paused ? ICONS.play : ICONS.pause;
    this.$('.play').innerHTML = icon(playIcon);
    this.$('.play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
    this.$('.time').textContent = `${clock(player.currentTime)} / ${clock(duration)}`;
    if (!this.seeking && duration > 0) this.paintProgress(Math.min(1, player.currentTime / duration));
    this.$('.buffer').style.width = `${duration > 0 ? Math.min(100, (player.bufferedEnd / duration) * 100) : 0}%`;
    this.$('.mute').innerHTML = icon(player.muted || player.volume === 0 ? ICONS.muted : ICONS.volume);
    (this.$('.level') as HTMLInputElement).value = String(player.muted ? 0 : player.volume);
    this.$('.full').innerHTML = icon(document.fullscreenElement === this || this.classList.contains('filled') ? ICONS.exit : ICONS.full);
    this.$('.big').innerHTML = icon(paused ? ICONS.play : ICONS.pause);
    if (paused) this.frame.classList.remove('idle');
  }

  /** Opens the settings as a panel over the player, or on a small player as a sheet over the bottom of the screen. */
  private toggleMenu(open: boolean): void {
    const menu = this.$('.menu');
    let scrim = this.root.querySelector<HTMLElement>('.scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.addEventListener('click', () => this.toggleMenu(false));
      this.root.append(scrim);
    }
    // a phone held sideways (fullscreen video) gets a side panel over the full height instead
    const side = open && window.innerHeight <= 500 && matchMedia('(pointer: coarse)').matches;
    const sheet = side || (open && this.frame.clientWidth <= 520);
    // the player is a size container, which traps fixed elements, so the sheet lives outside it
    (sheet ? this.root : this.frame).append(menu);
    if (sheet) this.root.insertBefore(scrim, menu);
    menu.classList.toggle('sheet', sheet);
    menu.classList.toggle('side', side);
    menu.classList.toggle('on', open);
    scrim.classList.toggle('on', sheet);
    this.renderMenu();
  }

  private renderMenu(): void {
    const menu = this.$('.menu');
    if (!menu.classList.contains('on')) return;
    const player = this.player;
    const look = player.options;
    const chips = (title: string, items: readonly (readonly [string, unknown])[], current: unknown, pick: (value: unknown) => void): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<h4>${title}</h4><div class="chips"></div>`;
      const row = wrap.querySelector('.chips');
      for (const [label, value] of items) {
        const button = document.createElement('button');
        button.textContent = label;
        button.setAttribute('aria-pressed', String(value === current));
        button.addEventListener('click', () => {
          pick(value);
          this.renderMenu();
        });
        row?.append(button);
      }
      return wrap;
    };
    const parts: HTMLElement[] = [
      chips('Скорость', SPEEDS.map((speed) => [`${speed}×`, speed] as const), player.playbackRate, (value) => (player.playbackRate = Number(value))),
    ];
    const qualities = this.sources();
    if (qualities.length > 1) {
      const pick = (value: unknown): void => {
        if (Number(value)) void this.switchQuality(Number(value));
        else {
          this.autoQuality = true;
          this.adaptQuality(false);
        }
      };
      parts.push(chips('Качество', [[`Авто (${this.quality})`, 0] as const, ...qualities.map((source) => [`${source.cols} кол.`, source.cols] as const)], this.autoQuality ? 0 : this.quality, pick));
    }
    if (player.sourceType === 'video') {
      parts.push(chips('Сетка', GRIDS.map((cols) => [String(cols), cols] as const), look.cols, (value) => {
        player.configure({ cols: Number(value) });
        this.updateRatio();
      }));
    }
    parts.push(
      chips('Отрисовка', MODES, look.mode ?? 'braille', (value) => player.configure({ mode: value as RenderMode })),
      chips('Символы', GLYPH_SETS, look.glyphs, (value) => player.configure({ glyphs: String(value) })),
      chips('Цвет', TINTS, look.tint ?? null, (value) => player.configure({ tint: (value as string | null) ?? null })),
    );
    const range = (title: string, min: number, max: number, value: number, change: (next: number) => void): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<h4>${title}</h4><div class="line"><input type="range" min="${min}" max="${max}" step="0.05" value="${value}"><output>${value.toFixed(2)}</output></div>`;
      const slider = wrap.querySelector('input');
      slider?.addEventListener('input', () => {
        change(Number(slider.value));
        const output = wrap.querySelector('output');
        if (output) output.textContent = Number(slider.value).toFixed(2);
      });
      return wrap;
    };
    const boost = range('Насыщенность', 0, 2.5, look.boost ?? 1.3, (next) => player.configure({ boost: next }));
    const fill = range('Подсветка фона', 0, 1, look.fill ?? 0.25, (next) => player.configure({ fill: next }));
    const toggle = (label: string, on: boolean, change: (next: boolean) => void): HTMLElement => {
      const button = document.createElement('button');
      button.className = 'toggle';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(on));
      button.innerHTML = `<span>${label}</span><span class="switch"></span>`;
      button.addEventListener('click', () => {
        change(!on);
        this.renderMenu();
      });
      return button;
    };
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = 'Готово';
    close.addEventListener('click', () => this.toggleMenu(false));
    menu.replaceChildren(
      close,
      ...parts,
      boost,
      fill,
      toggle('Автояркость и контраст', look.autoLevels !== false, (next) => player.configure({ autoLevels: next })),
      toggle('Чёткость ×2', look.sharp !== false, (next) => player.configure({ sharp: next })),
      toggle('Плавность', look.smooth !== false, (next) => player.configure({ smooth: next })),
      toggle('Контуры', look.edges === true, (next) => player.configure({ edges: next })),
      toggle('Кинескоп', look.crt === true, (next) => player.configure({ crt: next })),
    );
  }

  /** Fullscreen through the browser where it allows elements, or the player filling the window where it does not (iPhone). */
  async toggleFullscreen(): Promise<void> {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
    if (this.classList.contains('filled')) {
      this.classList.remove('filled');
      orientation.unlock?.();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      const request = (this.requestFullscreen ?? (this as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen)?.bind(this);
      let native = false;
      if (request && document.fullscreenEnabled !== false) {
        try {
          await request();
          native = true;
        } catch {
          native = false;
        }
      }
      if (!native) this.classList.add('filled');
      await orientation.lock?.('landscape').catch(() => undefined);
    }
    this.update();
  }

  /** Picture-in-picture: the whole player with controls where Document PiP exists, the picture alone elsewhere. */
  async togglePip(): Promise<void> {
    if (this.pipWindow) {
      this.pipWindow.close();
      return;
    }
    if (this.pipVideo) {
      await document.exitPictureInPicture();
      return;
    }
    const documentPip = (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
    if (documentPip) {
      const box = this.frame.getBoundingClientRect();
      const pip = await documentPip.requestWindow({ width: Math.round(box.width), height: Math.round(box.height) });
      this.pipWindow = pip;
      const style = pip.document.createElement('style');
      style.textContent = `${STYLE.replaceAll(':host', 'body')} html, body { margin: 0; height: 100%; background: #000; }`;
      pip.document.head.append(style);
      this.frame.classList.add('pip');
      pip.document.body.append(this.frame);
      pip.addEventListener('pagehide', () => {
        this.frame.classList.remove('pip');
        this.root.append(this.frame);
        this.pipWindow = null;
      });
      return;
    }
    const canvas = this.$('canvas') as HTMLCanvasElement;
    if (!('requestPictureInPicture' in HTMLVideoElement.prototype) || !canvas.captureStream) {
      this.message('Картинка в картинке не поддерживается этим браузером');
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = canvas.captureStream(60);
    await video.play();
    this.pipVideo = video;
    video.addEventListener('leavepictureinpicture', () => {
      video.srcObject = null;
      this.pipVideo = null;
    });
    video.addEventListener('pause', () => this.player.pause());
    video.addEventListener('play', () => void this.player.play());
    await video.requestPictureInPicture();
  }
}

/** Registers `<glyph-player>` once. */
export const define = (name = 'glyph-player'): void => {
  if (!customElements.get(name)) customElements.define(name, class extends GlyphPlayerElement {});
};

define();
