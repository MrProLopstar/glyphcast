import { Encoder } from './lib/format.js';

let encoder = null;

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'start') encoder = new Encoder(data.options);
    else if (data.type === 'frame') for (let count = 0; count < data.repeat; count += 1) encoder.add(new Uint8ClampedArray(data.pixels));
    else if (data.type === 'audio') encoder.addAudio(new Uint8Array(data.bytes));
    else if (data.type === 'finish') {
      const bytes = await encoder.finish();
      self.postMessage({ bytes }, [bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
