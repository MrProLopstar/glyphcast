import { createElement } from 'react';
import { renderToString as renderReact } from 'react-dom/server';
import { createSSRApp, h } from 'vue';
import { renderToString as renderVue } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { GlyphPlayer as ReactPlayer } from '../src/react.js';
import { GlyphPlayer as VuePlayer } from '../src/vue.js';

describe('framework wrappers', () => {
  it('render <glyph-player> with attributes on the server', async () => {
    const props = { src: '/a.gcast', poster: '/a.jpg', cols: 120, mode: 'braille', crt: true, edges: false, autoLevels: false } as const;
    const react = renderReact(createElement(ReactPlayer, { ...props, className: 'video' }));
    expect(react).toContain('<glyph-player');
    expect(react).toMatch(/src="\/a.gcast"/);
    expect(react).toMatch(/cols="120"/);
    expect(react).toMatch(/mode="braille"/);
    expect(react).toMatch(/crt=""/);
    expect(react).toMatch(/autolevels="false"/);
    expect(react).not.toContain('edges');
    const vue = await renderVue(createSSRApp({ render: () => h(VuePlayer, props) }));
    expect(vue).toContain('<glyph-player');
    expect(vue).toMatch(/poster="\/a.jpg"/);
    expect(vue).toMatch(/autolevels="false"/);
    expect(vue).not.toContain('edges');
  });
});
