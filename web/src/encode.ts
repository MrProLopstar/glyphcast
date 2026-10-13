/** Converting a video file to .gcast in the browser: frames through a canvas into a worker, sound as Opus. */

const CRC = new Uint32Array(256).map((_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

const oggPage = (packets: Uint8Array[], granule: number, serial: number, sequence: number, flags: number): Uint8Array => {
  const lacing = packets.flatMap((packet) => [...Array<number>(Math.floor(packet.length / 255)).fill(255), packet.length % 255]);
  const body = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ (CRC[((crc >>> 24) ^ byte) & 255] ?? 0)) >>> 0;
  view.setUint32(22, crc, true);
  return page;
};

/** Opus in Ogg with WebCodecs, much faster than recording the sound while the video plays. */
const encodeOpus = async (file: File): Promise<Uint8Array> => {
  const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await file.arrayBuffer());
  const channels = Math.min(2, decoded.numberOfChannels);
  const packets: Uint8Array[] = [];
  let head: Uint8Array | null = null;
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
      const description = meta?.decoderConfig?.description;
      if (description && !head) head = new Uint8Array(description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer);
    },
    error: (error) => (failure = error),
  });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 40000 });
  const step = 48000;
  for (let start = 0; start < decoded.length; start += step) {
    if (failure) throw failure;
    const length = Math.min(step, decoded.length - start);
    const data = new Float32Array(length * channels);
    for (let channel = 0; channel < channels; channel += 1) data.set(decoded.getChannelData(channel).subarray(start, start + length), channel * length);
    encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: length, numberOfChannels: channels, timestamp: (start / 48000) * 1e6, data }));
    while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await encoder.flush();
  encoder.close();
  let opus: Uint8Array = head ?? new Uint8Array(19);
  if (!head) {
    opus.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
    new DataView(opus.buffer).setUint16(10, 312, true);
    new DataView(opus.buffer).setUint32(12, 48000, true);
  }
  const tags = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, 9, 0, 0, 0, ...new TextEncoder().encode('glyphcast'), 0, 0, 0, 0]);
  const preskip = new DataView(opus.buffer, opus.byteOffset).getUint16(10, true);
  const serial = 0x67637374;
  const pages = [oggPage([opus], 0, serial, 0, 2), oggPage([tags], 0, serial, 1, 0)];
  let granule = 0;
  for (let at = 0; at < packets.length; at += 50) {
    const group = packets.slice(at, at + 50);
    granule += group.length * 960;
    const last = at + 50 >= packets.length;
    pages.push(oggPage(group, last ? decoded.length + preskip : granule, serial, pages.length, last ? 4 : 0));
  }
  return new Uint8Array(await new Blob(pages as BlobPart[]).arrayBuffer());
};

export interface Converted {
  readonly bytes: Blob;
  readonly sound: number;
  readonly cols: number;
  readonly rows: number;
  readonly droppedSound: boolean;
}

export interface ConvertOptions {
  readonly cols: number;
  readonly fps: number;
  readonly sound: boolean;
  readonly detail: boolean;
}

export const convert = async (file: File, options: ConvertOptions, progress: (share: number) => void): Promise<Converted> => {
  const { cols, fps, detail } = options;
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.playsInline = true;
  video.muted = true;
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('браузер не может открыть это видео')), { once: true });
  });
  const rows = Math.max(1, Math.round(cols * (video.videoHeight / video.videoWidth) * 0.6));
  const width = detail ? cols * 2 : cols;
  const height = detail ? rows * 4 : rows;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('холст недоступен');
  const worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'start', options: { cols, rows, fps, chunkFrames: Math.round(fps * 2), detail } });
  const encoded = new Promise<Uint8Array>((resolve, reject) => {
    worker.addEventListener('message', ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.bytes)));
    worker.addEventListener('error', () => reject(new Error('кодировщик не запустился')));
  });
  encoded.catch(() => undefined);
  const large = file.size > 300 * 1048576 || video.duration > 1200;
  const sound = options.sound && !large && 'AudioEncoder' in window ? encodeOpus(file).catch(() => null) : null;
  let written = 0;
  const capture = (time: number) => {
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let repeat = 0;
    while ((written + repeat) / fps <= time) repeat += 1;
    if (repeat > 0) worker.postMessage({ type: 'frame', pixels: pixels.buffer, repeat }, [pixels.buffer]);
    written += repeat;
    progress(Math.min(1, time / video.duration));
  };
  // the picture runs four times faster than real time; frames are taken at the encoding rate
  video.playbackRate = 4;
  const finished = new Promise((resolve) => video.addEventListener('ended', resolve, { once: true }));
  const timer = setInterval(() => capture(video.currentTime), 1000 / fps / video.playbackRate / 2);
  await video.play();
  await finished;
  clearInterval(timer);
  capture(video.duration);
  URL.revokeObjectURL(video.src);
  const audio = (await sound) ?? new Uint8Array(0);
  const soundSize = audio.length;
  if (soundSize > 0) worker.postMessage({ type: 'audio', bytes: audio.buffer }, [audio.buffer]);
  worker.postMessage({ type: 'finish' });
  const stream = await encoded;
  worker.terminate();
  return { bytes: new Blob([stream as BlobPart]), sound: soundSize, cols, rows, droppedSound: options.sound && large };
};

export const megabytes = (bytes: number): string => `${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: bytes < 10485760 ? 2 : 1 })} МБ`;
