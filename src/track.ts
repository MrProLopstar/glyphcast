/**
 * Embedded Ogg Opus sound played the way video players play mp4 audio: only the part around the playback time is
 * fetched (with range requests), decoded in windows of a few seconds and scheduled on an AudioContext at the exact
 * moment the picture reaches it. Starting and seeking need one small download instead of the whole track.
 */

const WINDOW = 10;
const AHEAD = 18;

interface Window {
  readonly start: number;
  readonly buffer: AudioBuffer;
}

/** Offsets of Ogg page starts ("OggS") in a byte array. */
const pages = (bytes: Uint8Array): number[] => {
  const found: number[] = [];
  for (let at = 0; at + 27 <= bytes.length; at += 1) {
    if (bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53 && bytes[at + 4] === 0) found.push(at);
  }
  return found;
};

const pageLength = (bytes: Uint8Array, at: number): number => {
  const segments = bytes[at + 26] ?? 0;
  let body = 0;
  for (let index = 0; index < segments; index += 1) body += bytes[at + 27 + index] ?? 0;
  return 27 + segments + body;
};

/** Embedded Ogg Opus sound played window by window with Web Audio, so long tracks start and seek at once. */
export class OggTrack {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private head: Uint8Array | null = null;
  private preskip = 0;
  private windows = new Map<number, Promise<Window | null>>();
  private playing: AudioBufferSourceNode[] = [];
  private scheduledTo = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private session = 0;
  private level = 1;
  private silent = false;
  private rate = 1;
  /** False once the browser turned out not to decode Ogg Opus; the caller then falls back. */
  usable = true;

  constructor(
    private readonly read: (from: number, to: number) => Promise<Uint8Array>,
    private readonly from: number,
    private readonly to: number,
    private readonly duration: number,
    private readonly now: () => number,
  ) {}

  private async open(): Promise<boolean> {
    if (this.head) return true;
    const start = await this.read(this.from, Math.min(this.to, this.from + 65535));
    const found = pages(start);
    // the identification and comment pages that every decodable piece starts with
    const second = found[1];
    if (found[0] !== 0 || second === undefined) return false;
    const end = second + pageLength(start, second);
    this.head = start.subarray(0, end);
    const opus = new TextDecoder().decode(start.subarray(0, 64)).indexOf('OpusHead');
    this.preskip = opus >= 0 ? new DataView(start.buffer, start.byteOffset).getUint16(opus + 10, true) : 0;
    return true;
  }

  /** Decodes the window that holds second \`index * WINDOW\`. */
  private window(index: number): Promise<Window | null> {
    let found = this.windows.get(index);
    if (!found) {
      found = this.load(index * WINDOW).catch(() => null);
      this.windows.set(index, found);
      // ponytail: about a minute of decoded sound is kept; older windows are dropped
      for (const key of this.windows.keys()) if (Math.abs(key - index) > 4) this.windows.delete(key);
    }
    return found;
  }

  private async load(time: number): Promise<Window | null> {
    const perSecond = (this.to - this.from) / Math.max(this.duration, 0.001);
    // one request for the window, started together with the header read: the guess starts 3 s early, so the first
    // whole page almost always begins before `time`; a retry steps back only when it does not
    let guess = Math.max(this.from + 4096, Math.floor(this.from + time * perSecond - 3 * perSecond));
    const opened = this.open();
    const early = this.read(guess, Math.min(this.to, guess + Math.ceil(perSecond * (WINDOW + 4)) + 65536));
    if (!(await opened) || !this.head || !this.context) return null;
    let bytes: Uint8Array = new Uint8Array(0);
    let first = -1;
    let start = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const end = Math.min(this.to, guess + Math.ceil(perSecond * (WINDOW + 4)) + 65536);
      bytes = attempt === 0 ? await early : await this.read(guess, end);
      const found = pages(bytes).filter((at) => ((bytes[at + 5] ?? 0) & 1) === 0);
      first = found[0] ?? -1;
      if (first < 0) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const granule = Number(view.getBigInt64(first + 6, true));
      const packets = Array.from({ length: bytes[first + 26] ?? 0 }, (_, at) => bytes[first + 27 + at] ?? 0).filter((value) => value < 255).length;
      start = Math.max(0, (granule - this.preskip) / 48000 - packets * 0.02);
      if (start <= time + 0.05 || guess <= this.from + this.head.length) break;
      guess = Math.max(this.from + this.head.length, guess - Math.ceil((start - time + 2) * perSecond));
    }
    // keep whole pages only, up to the end of the window
    const all = pages(bytes).filter((at) => at >= first);
    let cut = first;
    for (const at of all) {
      const length = pageLength(bytes, at);
      if (at + length > bytes.length) break;
      cut = at + length;
    }
    const piece = new Uint8Array(this.head.length + cut - first);
    piece.set(this.head);
    piece.set(bytes.subarray(first, cut), this.head.length);
    const buffer = await this.context.decodeAudioData(piece.buffer);
    // the decoder drops the pre-skip at the start of every piece, so the buffer begins that much later
    return { start: start + this.preskip / 48000, buffer };
  }

  private ensureContext(): void {
    if (this.context) return;
    this.context = new AudioContext({ latencyHint: 'playback' });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.applyVolume();
  }

  /** Fetches and decodes the sound around `at` before playback starts, so pressing play is heard at once. */
  prepare(at: number): void {
    this.ensureContext();
    void this.window(Math.floor(at / WINDOW));
  }

  /** Starts the sound at playback time \`at\`, aligned with the clock the picture uses. */
  async play(at: number, rate = 1): Promise<void> {
    this.stop();
    this.rate = rate;
    const ticket = this.session;
    this.ensureContext();
    await this.context?.resume().catch(() => undefined);
    this.scheduledTo = at;
    const fill = async () => {
      while (ticket === this.session && this.scheduledTo < Math.min(this.duration, this.now() + AHEAD)) {
        const index = Math.floor(this.scheduledTo / WINDOW);
        const window = await this.window(index);
        if (ticket !== this.session) return;
        if (!window) {
          if (index === Math.floor(at / WINDOW)) this.usable = this.windows.size > 1 || this.usable;
          this.scheduledTo = (index + 1) * WINDOW;
          continue;
        }
        this.schedule(window, this.scheduledTo, (index + 1) * WINDOW);
        this.scheduledTo = (index + 1) * WINDOW;
      }
    };
    await fill();
    this.timer = setInterval(() => void fill(), 1000);
  }

  /** Plays the part of a decoded window from \`from\` to \`until\` (playback seconds) at the matching moment. */
  private schedule(window: Window, from: number, until: number): void {
    const context = this.context;
    if (!context || !this.gain) return;
    const lead = (from - this.now()) / this.rate;
    const offset = Math.max(0, from - window.start);
    const length = Math.min(window.buffer.duration - offset, until - from);
    if (length <= 0) return;
    const source = context.createBufferSource();
    source.buffer = window.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain);
    // a window that should already have started begins at once, a little further in
    const late = Math.max(0, -lead);
    source.start(context.currentTime + Math.max(0, lead), offset + late * this.rate, Math.max(0, length - late * this.rate));
    source.addEventListener('ended', () => (this.playing = this.playing.filter((item) => item !== source)));
    this.playing.push(source);
  }

  stop(): void {
    this.session += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // already ended
      }
    }
    this.playing = [];
  }

  set volume(value: number) {
    this.level = value;
    this.applyVolume();
  }

  set muted(value: boolean) {
    this.silent = value;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.silent ? 0 : this.level;
  }

  close(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
