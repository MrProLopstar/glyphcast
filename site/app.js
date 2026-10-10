import { GlyphStream, GlyphVideo } from './lib/index.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const video = $('video');
const status = (text, error = false) => {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
};

let player = null;
let mode = null;
let fpsFrames = 0;
let fpsStart = performance.now();

const options = () => ({
  cols: Number($('cols').value),
  boost: Number($('boost').value),
  glyphs: $('glyphs').value,
  tint: $('tint').value || null,
  autoLevels: $('auto').checked,
  glyphSize: 16,
});

const format = (seconds) => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

const stop = () => {
  if (mode === 'video') player.stop();
  if (mode === 'stream') player.pause();
  video.pause();
  if (video.srcObject) {
    for (const track of video.srcObject.getTracks()) track.stop();
    video.srcObject = null;
  }
};

const fresh = () => {
  const replacement = canvas.cloneNode();
  canvas.replaceWith(replacement);
  return replacement;
};

let surface = canvas;

const startVideo = async (setup) => {
  stop();
  surface = fresh();
  setup();
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('Видео не открылось'));
  });
  player = new GlyphVideo(video, surface, options());
  mode = 'video';
  player.start();
  $('empty').hidden = true;
  await video.play().catch(() => undefined);
  const { cols, rows } = player.grid();
  status(`${cols}×${rows} символов · видео ${video.videoWidth}×${video.videoHeight}`);
};

$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await startVideo(() => {
      video.removeAttribute('crossorigin');
      video.src = URL.createObjectURL(file);
    });
  } catch (error) {
    status(error.message, true);
  }
});

$('camera').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    await startVideo(() => {
      video.srcObject = stream;
    });
  } catch (error) {
    status(`Камера недоступна: ${error.message}`, true);
  }
});

$('sample').addEventListener('click', async () => {
  stop();
  surface = fresh();
  player = new GlyphStream(surface, { ...options(), onProgress: (share) => status(`Загрузка ${(share * 100).toFixed(0)}%`) });
  mode = 'stream';
  $('empty').hidden = true;
  try {
    const loading = player.load('./sample.gcast');
    await loading;
    const header = player.header;
    const size = (await (await fetch('./sample.gcast', { method: 'HEAD' })).headers.get('content-length')) ?? '';
    status(`${header.cols}×${header.rows} символов · ${header.fps} fps · ${(Number(size) / 1024).toFixed(0)} КБ на ${player.duration.toFixed(0)} с`);
    await player.play();
  } catch (error) {
    status(error.message, true);
  }
});

const reconfigure = () => {
  $('cols-value').textContent = $('cols').value;
  $('boost-value').textContent = $('boost').value;
  if (!player) return;
  player.configure({ boost: Number($('boost').value), tint: $('tint').value || null, autoLevels: $('auto').checked });
  if (mode === 'video') player.resize(Number($('cols').value));
};

for (const id of ['cols', 'boost', 'tint', 'auto']) $(id).addEventListener('input', reconfigure);

$('glyphs').addEventListener('change', () => {
  if (mode === 'video') {
    player.stop();
    surface = fresh();
    player = new GlyphVideo(video, surface, options());
    player.start();
  } else if (mode === 'stream') {
    $('sample').click();
  }
});

$('play').addEventListener('click', () => {
  if (mode === 'video') (video.paused ? video.play() : video.pause());
  if (mode === 'stream') (player.paused ? player.play() : player.pause());
});

$('seek').addEventListener('input', () => {
  const share = Number($('seek').value) / 1000;
  if (mode === 'video' && Number.isFinite(video.duration)) video.currentTime = share * video.duration;
  if (mode === 'stream') player.seek(share * player.duration);
});

$('full').addEventListener('click', () => $('screen').requestFullscreen?.());

const loop = () => {
  if (mode) {
    const current = mode === 'video' ? video.currentTime : player.currentTime;
    const duration = mode === 'video' ? video.duration : player.duration;
    const paused = mode === 'video' ? video.paused : player.paused;
    $('time').textContent = `${format(current)} / ${format(duration)}`;
    $('play').textContent = paused ? '▶' : '❚❚';
    if (Number.isFinite(duration) && duration > 0 && document.activeElement !== $('seek')) $('seek').value = String(Math.round((current / duration) * 1000));
  }
  fpsFrames += 1;
  if (performance.now() - fpsStart > 1000) {
    fpsFrames = 0;
    fpsStart = performance.now();
  }
  requestAnimationFrame(loop);
};
loop();
