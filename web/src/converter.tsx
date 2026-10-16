import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { convert, megabytes, type Converted } from './encode';
import { Player } from './Player';
import './site.css';

const quote = (name: string): string => (/[\s"'&()]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name);

const Converter = () => {
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [cols, setCols] = useState(160);
  const [fps, setFps] = useState(24);
  const [sound, setSound] = useState(true);
  const [detail, setDetail] = useState(true);
  const [share, setShare] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<(Converted & { url: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);
  const command = `npx glyphcast encode ${quote(file?.name ?? 'video.mp4')} --cols ${cols} --fps ${fps}${detail ? ' --detail' : ''}${sound ? ' --embed' : ''} --poster`;
  const pick = (picked: File | null) => {
    setFile(picked);
    setResult(null);
    setError('');
  };
  const start = async () => {
    if (!file) return;
    setShare(0);
    setError('');
    setResult(null);
    try {
      const done = await convert(file, { cols, fps, sound, detail }, setShare);
      setResult({ ...done, url: URL.createObjectURL(done.bytes) });
    } catch (failure) {
      setError(`Не получилось: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setShare(null);
    }
  };
  const ratio = result && file ? file.size / result.bytes.size : 0;
  return (
    <>
      <header className="top">
        <a className="logo" href="./">
          gcast<b>converter</b>
        </a>
        <nav className="actions" style={{ marginLeft: 'auto' }}>
          <a className="button" href="https://glc.1lop.ru/">
            Песочница
          </a>
          <a className="button" href="https://glc-hub.1lop.ru/">
            Хаб
          </a>
        </nav>
      </header>
      <main className="page">
        <div className="hero">
          <h1>
            видео → <b>.gcast</b>
          </h1>
          <p>Перегоните своё видео в поток символов прямо в браузере: файл никуда не отправляется. Картинка кодируется примерно в реальном времени, звук — в Opus за пару секунд.</p>
        </div>
        <section className="box">
          <label
            className={`pick big${over ? ' over' : ''}${file ? ' chosen' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              pick(event.dataTransfer.files[0] ?? null);
            }}
          >
            <input type="file" accept="video/*" onChange={(event) => pick(event.target.files?.[0] ?? null)} />
            <strong>{file ? file.name : 'Выберите видео'}</strong>
            <span>{file ? megabytes(file.size) : 'или перетащите его сюда: mp4, webm, mov'}</span>
          </label>
          <div className="options">
            <label className="field">
              Ширина в символах
              <select value={cols} onChange={(event) => setCols(Number(event.target.value))}>
                {[120, 160, 180, 240].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Кадров в секунду
              <select value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                {[15, 24, 30].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={detail} onChange={(event) => setDetail(event.target.checked)} />
              <span>
                Детали
                <small>чёткие титры и тонкие линии, файл больше примерно наполовину</small>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={sound} onChange={(event) => setSound(event.target.checked)} />
              <span>
                Вшить звук
                <small>Opus 40 кбит/с внутри файла</small>
              </span>
            </label>
          </div>
          {share !== null && (
            <div className="progress" aria-label="Конвертация">
              <div style={{ transform: `scaleX(${share.toFixed(3)})` }} />
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="button" className="button primary" disabled={!file || share !== null} onClick={() => void start()}>
              {share === null ? 'Конвертировать' : `Конвертация ${Math.round(share * 100)}%`}
            </button>
            <span className="note">Файлы больше 300 МБ или длиннее 20 минут получатся без звука: он не помещается в память браузера.</span>
          </div>
        </section>
        {result && file && (
          <section className="box">
            <h2>Готово</h2>
            <div className="sizes">
              <div>
                <span>Исходник</span>
                <strong>{megabytes(file.size)}</strong>
              </div>
              <div>
                <span>.gcast</span>
                <strong>{megabytes(result.bytes.size)}</strong>
              </div>
              <div className="win">
                <span>Меньше в</span>
                <strong>{ratio >= 1 ? `${ratio.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}×` : 'нет'}</strong>
              </div>
            </div>
            <div className="meter" aria-hidden="true">
              <div style={{ transform: `scaleX(${Math.min(1, result.bytes.size / file.size).toFixed(3)})` }} />
            </div>
            <p className="note">
              {result.cols}×{result.rows} символов
              {result.sound ? `, из них звук ${megabytes(result.sound)}` : result.droppedSound ? '. Звук для такого большого файла в браузере не поместился; фильм со звуком сделайте командой ниже' : ', без звука'}.
            </p>
            <Player src={`${result.url}#file.gcast`} heading={file.name} />
            <div className="row">
              <a className="button primary" href={result.url} download={file.name.replace(/\.[^.]+$/, '') + '.gcast'}>
                Скачать .gcast
              </a>
              <a className="button" href="https://glc-hub.1lop.ru/">
                Опубликовать в хабе
              </a>
            </div>
          </section>
        )}
        <section className="box">
          <h2>То же в консоли</h2>
          <p className="note">Быстрее, без ограничений по размеру и со звуком для целых фильмов. Нужен ffmpeg; рядом появится постер .jpg.</p>
          <div className="command">
            <pre className="code">{command}</pre>
            <button
              type="button"
              className="button"
              onClick={() =>
                void navigator.clipboard.writeText(command).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
          </div>
        </section>
      </main>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<Converter />);
