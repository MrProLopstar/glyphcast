/** One subtitle: shown from `start` to `end` seconds. */
export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const seconds = (stamp: string): number => {
  const parts = stamp.trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

/** Parses WebVTT or SRT subtitles into cues sorted by start time. Markup tags are dropped. */
export const parseCaptions = (text: string): Cue[] => {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = (lines[timing] ?? '').split('-->');
    const start = seconds(from ?? '');
    const end = seconds((to ?? '').trim().split(/\s+/)[0] ?? '');
    const body = lines.slice(timing + 1).join('\n').replace(/<[^<>]*>/g, '').trim();
    if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
};

/** Text of the cues active at a time, joined by newlines, or null. */
export const captionAt = (cues: readonly Cue[], time: number): string | null => {
  const active = cues.filter((cue) => time >= cue.start && time < cue.end);
  return active.length > 0 ? active.map((cue) => cue.text).join('\n') : null;
};
