import { GlyphPlayer, sourceFor, type LookOptions, type Source } from './player.js';
import type { RenderMode } from './renderer.js';

const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
  back: 'M11.5 6.5V3L6 8l5.5 5V9.5a5.5 5.5 0 1 1-5.5 5.5H4a7.5 7.5 0 1 0 7.5-8.5z',
  forward: 'M12.5 6.5V3L18 8l-5.5 5V9.5A5.5 5.5 0 1 0 18 15h2a7.5 7.5 0 1 1-7.5-8.5z',
  volume: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zm11.5-1.8a5 5 0 0 1 0 8.6l-1-1.7a3 3 0 0 0 0-5.2zm2.2-3.2a8.6 8.6 0 0 1 0 15l-1-1.7a6.6 6.6 0 0 0 0-11.6z',
  muted: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zm11.3.2 1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 5-.1-3 2-1.6-2-3.5-2.4.9a8 8 0 0 0-2.6-1.5L14.9 2h-4l-.4 2.6a8 8 0 0 0-2.6 1.5l-2.4-.9-2 3.5 2 1.6a8 8 0 0 0 0 3l-2 1.6 2 3.5 2.4-.9a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8 8 0 0 0 2.6-1.5l2.4.9 2-3.5z',
  pip: 'M3 5h18v14H3zm2 2v10h14V7zm6 4h7v5h-7z',
  full: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  exit: 'M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z',
} as const;

const GLYPH_SETS: readonly (readonly [string, string])[] = [
  ['Классика', ' .:-=+*#%@'],
  ['Блоки', ' ░▒▓█'],
  ['Плотные', " .'`^,:;Il!i~+_-?][}{1)(|tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"],
  ['Точки', ' ·•●'],
  ['Двоичные', ' 01'],
  ['Матрица', ' ｰｨｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏ'],
];

const MODES: readonly (readonly [string, RenderMode])[] = [
  ['Символы', 'glyphs'],
  ['Брайль', 'braille'],
  ['Растр', 'halftone'],
];

const TINTS: readonly (readonly [string, string | null])[] = [
  ['Как в видео', null],
  ['Матрица', '#33ff66'],
  ['Ламповый', '#ffb35c'],
  ['Неон', '#5ce1ff'],
  ['Монохром', '#e8ecef'],
];

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const GRIDS = [80, 120, 160, 200, 240, 320];

const STYLE = `
:host { display: block; position: relative; --accent: #f0a04b; --ink: #f4f6f8; --panel: rgba(12, 15, 20, 0.86); color-scheme: dark; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.player { position: relative; width: 100%; aspect-ratio: var(--ratio, 16 / 9); background: #000; border-radius: var(--radius, 12px); overflow: hidden; outline: none; user-select: none; color: var(--ink); }
:host(:fullscreen) .player, .player.pip { border-radius: 0; height: 100%; aspect-ratio: auto; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
button { all: unset; cursor: pointer; display: grid; place-items: center; border-radius: 8px; color: inherit; }
button:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
svg { width: 22px; height: 22px; fill: currentColor; }
.center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.big { pointer-events: auto; width: 76px; height: 76px; border-radius: 50%; background: var(--accent); color: #111; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); transition: transform 0.15s, opacity 0.2s; }
.big svg { width: 34px; height: 34px; margin-left: 4px; }
.big:hover { transform: scale(1.06); }
.playing .big { opacity: 0; pointer-events: none; transform: scale(0.8); }
.spinner { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.2); border-top-color: var(--accent); animation: spin 0.8s linear infinite; display: none; }
.waiting .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
.message { position: absolute; inset: auto 16px 80px; padding: 10px 14px; border-radius: 10px; background: rgba(120, 20, 20, 0.85); display: none; }
.message.on { display: block; }
.controls { position: absolute; left: 0; right: 0; bottom: 0; padding: 36px 12px 10px; background: linear-gradient(transparent, rgba(0,0,0,0.78)); transition: opacity 0.25s, transform 0.25s; }
.idle .controls { opacity: 0; transform: translateY(8px); pointer-events: none; }
.idle { cursor: none; }
.progress { position: relative; height: 18px; cursor: pointer; display: flex; align-items: center; margin: 0 4px; }
.track { position: relative; width: 100%; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.22); transform: scaleY(0.67); transition: transform 0.15s; }
.progress:hover .track { transform: scaleY(1); }
.buffer, .played { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; }
.buffer { background: rgba(255,255,255,0.35); }
.played { background: var(--accent); }
.knob { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px; border-radius: 50%; background: var(--ink); box-shadow: 0 1px 6px rgba(0,0,0,0.5); transform: scale(0); transition: transform 0.15s; }
.progress:hover .knob { transform: scale(1); }
.tip { position: absolute; bottom: 22px; padding: 3px 7px; border-radius: 6px; background: var(--panel); font: 12px ui-monospace, Consolas, monospace; transform: translateX(-50%); opacity: 0; pointer-events: none; }
.progress:hover .tip { opacity: 1; }
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
.badge { position: absolute; top: 12px; left: 12px; padding: 3px 8px; border-radius: 6px; background: var(--panel); font: 11px ui-monospace, Consolas, monospace; opacity: 0.85; }
.idle .badge { opacity: 0; }
@media (max-width: 520px) { .back, .forward, .volume input { display: none; } .time { margin: 0 4px; font-size: 12px; } }
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
 * Attributes: `src`, `audio`, `youtube`, `file` (a video in the server folder), `server`, `subtitles` (WebVTT or SRT URL),
 * `cols`, `glyphs`, `tint`, `boost`, `autolevels`, `mode` (`glyphs`, `braille`, `halftone`), `edges`, `crt`, `autoplay`,
 * `muted`, `loop`. The `player` property gives the underlying `GlyphPlayer`.
 */
export class GlyphPlayerElement extends HTMLElement {
  static readonly observedAttributes = ['src', 'audio', 'youtube', 'file', 'server', 'subtitles', 'cols', 'glyphs', 'tint', 'boost', 'autolevels', 'mode', 'edges', 'crt'];

  readonly player: GlyphPlayer;
  private readonly root: ShadowRoot;
  private readonly frame: HTMLDivElement;
  private readonly $: (selector: string) => HTMLElement;
  private idleTimer: number | null = null;
  private seeking = false;
  private pipWindow: Window | null = null;
  private pipVideo: HTMLVideoElement | null = null;
  private loading = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${STYLE}</style>
<div class="player" tabindex="0">
  <canvas part="canvas"></canvas>
  <div class="badge" hidden></div>
  <div class="center"><button class="big" aria-label="Play">${icon(ICONS.play)}</button></div>
  <div class="spinner"></div>
  <div class="message" role="alert"></div>
  <div class="menu" role="menu"></div>
  <div class="controls" part="controls">
    <div class="progress" role="slider" aria-label="Seek" tabindex="-1"><div class="track"><div class="buffer"></div><div class="played"></div><div class="knob"></div></div><div class="tip">0:00</div></div>
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
      const node = frame.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`Missing ${selector}`);
      return node;
    };
    this.$ = find;
    this.player = new GlyphPlayer(find('canvas') as HTMLCanvasElement, this.look());
    this.wire();
  }

  private look(): LookOptions {
    const tint = this.getAttribute('tint');
    return {
      ...(this.hasAttribute('cols') ? { cols: Number(this.getAttribute('cols')) } : {}),
      ...(this.getAttribute('glyphs') ? { glyphs: this.getAttribute('glyphs') ?? undefined } : {}),
      ...(tint !== null ? { tint: tint || null } : {}),
      ...(this.hasAttribute('boost') ? { boost: Number(this.getAttribute('boost')) } : {}),
      ...(this.hasAttribute('autolevels') ? { autoLevels: this.getAttribute('autolevels') !== 'false' } : {}),
      ...(this.hasAttribute('mode') ? { mode: this.getAttribute('mode') as RenderMode } : {}),
      edges: this.flag('edges'),
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
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next || !this.isConnected) return;
    if (['src', 'audio', 'youtube', 'file', 'server'].includes(name)) void this.reload();
    else if (name === 'subtitles') this.captions();
    else this.player.configure(this.look());
    this.renderMenu();
  }

  /** Loads a source programmatically: a URL, a file, a camera stream or a full `Source`. */
  async load(source: Source | string | Blob | MediaStream): Promise<void> {
    const resolved: Source = typeof source === 'string' ? sourceFor(source, this.getAttribute('audio') ?? undefined) : source instanceof Blob || source instanceof MediaStream ? { type: 'video', src: source } : source;
    const ticket = (this.loading += 1);
    this.message(null);
    this.frame.classList.add('waiting');
    try {
      await this.player.load(resolved);
      if (ticket !== this.loading) return;
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
    const src = this.getAttribute('src');
    this.badge(null);
    if (src) await this.load(src);
  }

  private badge(text: string | null): void {
    const badge = this.$('.badge');
    badge.hidden = !text;
    badge.textContent = text ?? '';
  }

  private message(text: string | null): void {
    const box = this.$('.message');
    box.textContent = text ?? '';
    box.classList.toggle('on', Boolean(text));
  }

  private updateRatio(): void {
    const { cols, rows } = this.player.grid();
    const { width, height } = this.player.renderer.size(cols, rows);
    this.frame.style.setProperty('--ratio', `${width} / ${height}`);
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
      this.$('.menu').classList.toggle('on');
      this.renderMenu();
    });
    this.$('canvas').addEventListener('click', () => {
      if (this.$('.menu').classList.contains('on')) this.$('.menu').classList.remove('on');
      else this.togglePlay();
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
      if (this.seeking) this.paintProgress(value);
    });
    progress.addEventListener('pointerdown', (event) => {
      this.seeking = true;
      progress.setPointerCapture(event.pointerId);
      this.paintProgress(share(event));
    });
    progress.addEventListener('pointerup', (event) => {
      this.seeking = false;
      void player.seek(share(event) * player.duration);
    });

    for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'ratechange', 'ended', 'loadedmetadata']) player.addEventListener(type, () => this.update());
    player.addEventListener('waiting', () => this.frame.classList.add('waiting'));
    player.addEventListener('playing', () => this.frame.classList.remove('waiting'));
    player.addEventListener('error', (event) => this.message(String((event as CustomEvent<Error>).detail?.message ?? 'Playback error')));
    player.addEventListener('ended', () => {
      if (this.hasAttribute('loop')) void player.play();
    });

    this.frame.addEventListener('pointermove', () => this.wake());
    this.frame.addEventListener('pointerleave', () => this.sleep(600));
    this.frame.addEventListener('keydown', (event) => this.key(event));
    this.frame.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement).closest('.menu, .settings')) this.$('.menu').classList.remove('on');
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
    this.$('.full').innerHTML = icon(document.fullscreenElement === this ? ICONS.exit : ICONS.full);
    if (paused) this.frame.classList.remove('idle');
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
    if (player.sourceType === 'video') {
      parts.push(chips('Сетка', GRIDS.map((cols) => [String(cols), cols] as const), look.cols, (value) => {
        player.configure({ cols: Number(value) });
        this.updateRatio();
      }));
    }
    parts.push(
      chips('Отрисовка', MODES, look.mode ?? 'glyphs', (value) => player.configure({ mode: value as RenderMode })),
      chips('Символы', GLYPH_SETS, look.glyphs, (value) => player.configure({ glyphs: String(value) })),
      chips('Цвет', TINTS, look.tint ?? null, (value) => player.configure({ tint: (value as string | null) ?? null })),
    );
    const boost = document.createElement('div');
    boost.innerHTML = `<h4>Насыщенность</h4><div class="line"><input type="range" min="0" max="2.5" step="0.05" value="${look.boost ?? 1.3}"><output>${(look.boost ?? 1.3).toFixed(2)}</output></div>`;
    const slider = boost.querySelector('input');
    slider?.addEventListener('input', () => {
      player.configure({ boost: Number(slider.value) });
      const output = boost.querySelector('output');
      if (output) output.textContent = Number(slider.value).toFixed(2);
    });
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
    menu.replaceChildren(
      ...parts,
      boost,
      toggle('Автояркость и контраст', look.autoLevels !== false, (next) => player.configure({ autoLevels: next })),
      toggle('Контуры', look.edges === true, (next) => player.configure({ edges: next })),
      toggle('Кинескоп', look.crt === true, (next) => player.configure({ crt: next })),
    );
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.requestFullscreen?.();
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
