import 'glyphcast/element';
import { useEffect, useLayoutEffect, useRef } from 'react';

type Attributes = Partial<Record<'src' | 'sources' | 'poster' | 'subtitles' | 'heading' | 'source' | 'mode' | 'cols' | 'autoplay' | 'muted' | 'fullsize', string>>;
// src and sources go last: setting them starts loading, which reads the poster and the rest
const NAMES = ['poster', 'subtitles', 'heading', 'source', 'mode', 'cols', 'autoplay', 'muted', 'fullsize', 'sources', 'src'] as const;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'glyph-player': React.HTMLAttributes<HTMLElement> & React.RefAttributes<HTMLElement>;
    }
  }
}

/**
 * The <glyph-player> element. Its settings are written as attributes by hand: React 19 would set them as
 * properties, which overwrites the element's own methods of the same names (poster, sources).
 */
export const Player = ({ onPlay, className, ...attributes }: Attributes & { onPlay?: () => void; className?: string }) => {
  const element = useRef<HTMLElement>(null);
  const all: Attributes = { mode: 'braille', cols: '160', ...attributes };
  const signature = JSON.stringify(all);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    for (const name of NAMES) {
      const value = all[name];
      if (value === undefined) node.removeAttribute(name);
      else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
  }, [signature]);
  useEffect(() => {
    const node = element.current;
    if (!node || !onPlay) return;
    const player = (node as HTMLElement & { player?: EventTarget }).player;
    player?.addEventListener('play', onPlay, { once: true });
    return () => player?.removeEventListener('play', onPlay);
  }, [onPlay, attributes.src]);
  return <glyph-player ref={element} className={className} />;
};

/**
 * A soft glow of the current picture behind the player, like YouTube's ambient mode: about once a second the
 * frame at the playback time is drawn into a tiny canvas that CSS blurs and spreads around the player.
 */
export const Ambient = ({ children }: { children: React.ReactNode }) => {
  const glow = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    type Picture = { pixels: Uint8ClampedArray; cols: number; rows: number };
    type Element = HTMLElement & { player?: { currentTime: number; preview: (seconds: number) => Promise<Picture | null> } };
    let alive = true;
    const paint = async () => {
      const element = box.current?.querySelector('glyph-player') as Element | null;
      const canvas = glow.current;
      const picture = await element?.player?.preview(element.player.currentTime).catch(() => null);
      if (!alive || !canvas || !picture) return;
      canvas.width = picture.cols;
      canvas.height = picture.rows;
      canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(picture.pixels), picture.cols, picture.rows), 0, 0);
      canvas.classList.add('lit');
    };
    const timer = setInterval(() => void paint(), 1000);
    void paint();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="ambient" ref={box}>
      <canvas ref={glow} aria-hidden="true" />
      {children}
    </div>
  );
};
