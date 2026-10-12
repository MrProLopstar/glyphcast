import { defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType } from 'vue';
import { attributesOf, PLAYER_EVENTS, type GlyphPlayerAttributes } from './attributes.js';
import type { GlyphPlayerElement } from './element.js';
import type { RenderMode } from './renderer.js';

export type { GlyphPlayerAttributes } from './attributes.js';

/**
 * `<GlyphPlayer>` for Vue 3: the `<glyph-player>` element with typed props and events (`ready`, `play`, `pause`,
 * `ended`, `timeupdate`, `error`). The element is loaded on mount, so it renders on the server too.
 *
 * ```vue
 * <GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" @ready="(player) => player.play()" />
 * ```
 */
export const GlyphPlayer = defineComponent({
  name: 'GlyphPlayer',
  props: {
    src: String,
    audio: String,
    poster: String,
    subtitles: String,
    youtube: String,
    file: String,
    server: String,
    cols: Number,
    glyphs: String,
    tint: String,
    boost: Number,
    fill: Number,
    autoLevels: { type: Boolean, default: undefined },
    mode: String as PropType<RenderMode>,
    edges: Boolean,
    crt: Boolean,
    autoPlay: Boolean,
    muted: Boolean,
    loop: Boolean,
  },
  emits: ['ready', ...PLAYER_EVENTS],
  setup(props, { emit, expose }) {
    const element = ref<GlyphPlayerElement | null>(null);
    const listeners: [string, EventListener][] = [];
    expose({ element });
    onMounted(async () => {
      await import('./element.js');
      const player = element.value?.player;
      if (!player) return;
      for (const type of PLAYER_EVENTS) {
        const listener: EventListener = (event) => emit(type, type === 'error' ? (event as CustomEvent<Error>).detail : player);
        player.addEventListener(type, listener);
        listeners.push([type, listener]);
      }
      emit('ready', player);
    });
    onBeforeUnmount(() => {
      const player = element.value?.player;
      for (const [type, listener] of listeners) player?.removeEventListener(type, listener);
    });
    return () => h('glyph-player', { ref: element, ...attributesOf(props as GlyphPlayerAttributes) });
  },
});
