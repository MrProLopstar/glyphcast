import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Ambient, Player } from './Player';
import './site.css';

const FILES = 'https://gcast-hub.aniclap.workers.dev';
const HUB = 'https://glc-hub.1lop.ru';

interface HubVideo {
  readonly id: string;
  readonly title: string;
  readonly duration: number;
  readonly poster?: boolean;
}

type Loadable = HTMLElement & { load: (source: unknown) => Promise<void>; player: { play: () => Promise<void> } };

const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

const KEYS: [string[], string][] = [
  [['Пробел'], 'пауза'],
  [['←', '→'], '5 с'],
  [['J', 'L'], '10 с'],
  [['↑', '↓'], 'громкость'],
  [['M'], 'звук'],
  [['F'], 'весь экран'],
  [['P'], 'картинка в картинке'],
  [['0', '9'], 'переход'],
];

const Playground = () => {
  const [src, setSrc] = useState(`${FILES}/v/XcKVwaaFqAM.gcast`);
  const [poster, setPoster] = useState<string | undefined>(`${FILES}/v/XcKVwaaFqAM.jpg`);
  const [heading, setHeading] = useState('One Piece — Opening 1');
  const [youtube, setYoutube] = useState('');
  const [note, setNote] = useState('');
  const [samples, setSamples] = useState<HubVideo[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const element = (): Loadable | null => box.current?.querySelector('glyph-player') as Loadable | null;
  useEffect(() => {
    void fetch(`${FILES}/videos`)
      .then((response) => response.json() as Promise<HubVideo[]>)
      .then((list) => setSamples(list.slice(0, 8)))
      .catch(() => setSamples([]));
  }, []);
  const show = (next: { src: string; poster?: string; heading: string }) => {
    const player = element();
    for (const name of ['youtube', 'server']) player?.removeAttribute(name);
    setSrc(next.src);
    setPoster(next.poster);
    setHeading(next.heading);
    setNote('');
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const open = async (file: File | null) => {
    if (!file) return;
    // a local file goes straight into the player: a .gcast as a stream, anything else as a video drawn live
    const url = URL.createObjectURL(file);
    show({ src: file.name.toLowerCase().endsWith('.gcast') ? `${url}#file.gcast` : url, heading: file.name });
  };
  const camera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const player = element();
      setPoster(undefined);
      setHeading('Камера');
      await player?.load(stream);
      await player?.player.play();
    } catch (error) {
      setNote(`Камера недоступна: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const watchYoutube = () => {
    const player = element();
    if (!player || !youtube.trim()) return;
    let server = 'http://127.0.0.1:8787';
    try {
      server = localStorage.getItem('glyphcast-server') ?? server;
    } catch {}
    setPoster(undefined);
    setHeading('YouTube');
    player.setAttribute('server', server);
    player.setAttribute('youtube', youtube.trim());
    setNote('YouTube идёт через локальный сервер: браузер не даёт читать кадры чужих видео. Запустите npx glyphcast serve (нужны ffmpeg и yt-dlp).');
  };
  return (
    <>
      <header className="top">
        <a className="logo" href="./">
          glyph<b>cast</b>
        </a>
        <nav className="actions" style={{ marginLeft: 'auto' }}>
          <a className="button" href="https://gcast.1lop.ru/">
            Конвертер
          </a>
          <a className="button" href={HUB}>
            Хаб
          </a>
          <a className="button ghost" href="https://github.com/MrProLopstar/glyphcast">
            GitHub
          </a>
        </nav>
      </header>
      <main className="page">
        <div className="hero">
          <h1>
            видео <b>цветными символами</b>
          </h1>
          <p>Плеер на WebGL2 рисует каждый кадр брайлем, полутонами или символами. Откройте свой файл, включите камеру или выберите ролик из хаба; настройки картинки — в шестерёнке плеера.</p>
        </div>
        <div ref={box}>
          <Ambient>
            <Player src={src} poster={poster} heading={heading} />
          </Ambient>
        </div>
        <section className="box">
          <div className="tools">
            <label className="button primary" style={{ position: 'relative' }}>
              Открыть файл
              <input type="file" accept="video/*,.gcast" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} onChange={(event) => void open(event.target.files?.[0] ?? null)} />
            </label>
            <button type="button" className="button" onClick={() => void camera()}>
              Камера
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                watchYoutube();
              }}
            >
              <input type="url" placeholder="Ссылка на YouTube" value={youtube} onChange={(event) => setYoutube(event.target.value)} />
              <button type="submit" className="button">
                Смотреть символами
              </button>
            </form>
          </div>
          {note && <p className="note">{note}</p>}
        </section>
        {samples.length > 0 && (
          <section className="box">
            <h2>Из хаба</h2>
            <div className="samples">
              {samples.map((video) => (
                <button key={video.id} type="button" onClick={() => show({ src: `${FILES}/v/${video.id}.gcast`, poster: video.poster ? `${FILES}/v/${video.id}.jpg` : undefined, heading: video.title })}>
                  <div className="thumb">
                    {video.poster ? <img loading="lazy" alt="" src={`${FILES}/v/${video.id}.jpg`} /> : <div className="glyphs">⣿⡇⠶</div>}
                    <time>{clock(video.duration)}</time>
                  </div>
                  <span>{video.title}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="box">
          <h2>Клавиши</h2>
          <div className="keys">
            {KEYS.map(([keys, action]) => (
              <span key={action}>
                {keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}{' '}
                {action}
              </span>
            ))}
          </div>
        </section>
        <section className="box">
          <h2>На своём сайте</h2>
          <pre className="code">{`npm install glyphcast

import 'glyphcast/element';
<glyph-player src="movie.gcast" mode="braille"></glyph-player>`}</pre>
          <h2>В терминале</h2>
          <pre className="code">{`npx glyphcast play hub:<id>            # видео из хаба со звуком
npx glyphcast encode movie.mp4 --detail --embed --poster
npx glyphcast help encode               # все параметры`}</pre>
        </section>
      </main>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<Playground />);
