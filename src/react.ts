import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
import { attributesOf, PLAYER_EVENTS, type GlyphPlayerAttributes } from './attributes.js';
import type { GlyphPlayerElement } from './element.js';
import type { GlyphPlayer as Engine } from './player.js';

export type { GlyphPlayerAttributes } from './attributes.js';

/** Props of the React `<GlyphPlayer>`: the element's attributes plus event handlers. */
export interface GlyphPlayerProps extends GlyphPlayerAttributes {
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Called once the element is defined, with the engine for programmatic control. */
  readonly onReady?: (player: Engine) => void;
  readonly onPlay?: (player: Engine) => void;
  readonly onPause?: (player: Engine) => void;
  readonly onEnded?: (player: Engine) => void;
  readonly onTimeUpdate?: (player: Engine) => void;
  readonly onError?: (error: Error) => void;
}

const HANDLERS = { play: 'onPlay', pause: 'onPause', ended: 'onEnded', timeupdate: 'onTimeUpdate' } as const;

/**
 * `<GlyphPlayer>` for React: the `<glyph-player>` element with typed props. The element is loaded in an effect,
 * so the component renders on the server too. The ref points to the element; `element.player` is the engine.
 *
 * ```tsx
 * import { GlyphPlayer } from 'glyphcast/react';
 *
 * <GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" onReady={(player) => player.play()} />
 * ```
 */
export const GlyphPlayer = forwardRef<GlyphPlayerElement, GlyphPlayerProps>(function GlyphPlayer(props, ref) {
  const element = useRef<GlyphPlayerElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(ref, () => element.current as GlyphPlayerElement, []);

  useEffect(() => {
    let live = true;
    const listeners: [string, EventListener][] = [];
    void import('./element.js').then(() => {
      const node = element.current;
      if (!live || !node) return;
      const player = node.player;
      for (const type of PLAYER_EVENTS) {
        const listener: EventListener = (event) => {
          if (type === 'error') latest.current.onError?.((event as CustomEvent<Error>).detail);
          else latest.current[HANDLERS[type]]?.(player);
        };
        player.addEventListener(type, listener);
        listeners.push([type, listener]);
      }
      latest.current.onReady?.(player);
    });
    return () => {
      live = false;
      const player = element.current?.player;
      for (const [type, listener] of listeners) player?.removeEventListener(type, listener);
    };
  }, []);

  return createElement('glyph-player', { ref: element, class: props.className, style: props.style, ...attributesOf(props) });
});
