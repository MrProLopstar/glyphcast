import { detailMasks, Encoder } from 'glyphcast';

// encodes frames off the page; with detail on, each frame comes at twice the width and four times the height
let encoder: Encoder | null = null;
let detail = false;
let bar: number | undefined;
let cols = 0;
let rows = 0;

self.addEventListener('message', async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'start') {
      ({ cols, rows } = data.options);
      detail = Boolean(data.options.detail);
      encoder = new Encoder(data.options);
    } else if (data.type === 'frame' && encoder) {
      const pixels = new Uint8ClampedArray(data.pixels);
      for (let count = 0; count < data.repeat; count += 1) {
        if (detail) {
          const found = detailMasks(pixels, cols, rows, 4, bar);
          bar = found.bar;
          encoder.add(found.cells, found.masks, found.shades);
        } else encoder.add(pixels);
      }
    } else if (data.type === 'audio' && encoder) encoder.addAudio(new Uint8Array(data.bytes));
    else if (data.type === 'finish' && encoder) {
      const bytes = await encoder.finish();
      self.postMessage({ bytes }, { transfer: [bytes.buffer] });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
