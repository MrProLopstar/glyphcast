//! glc.exe: plays .gcast videos in the Windows console like `glc play`: files, links and hub videos, with sound,
//! subtitles, render modes, glyph sets, colors and a clickable status bar. Drop a file onto the exe, or start it and
//! drag files into the window, paste a link, or type hub to pick a video from the gcast hub.

mod audio;
mod gcast;
mod net;
mod render;

use render::{Cell, Detail, Levels, Look, Rgb, BOOSTS, FILLS, GLYPH_SETS, MODES, TINTS};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Console::*;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HUB: &str = "https://glc-hub.1lop.ru";
const GLYPH_NAMES: [&str; 6] = ["классика", "блоки", "плотные", "точки", "двоичные", "катакана"];

// ---- console ----

struct Console {
    output: isize,
    input: isize,
    input_mode: u32,
}

impl Console {
    fn open() -> Console {
        unsafe {
            let output = GetStdHandle(STD_OUTPUT_HANDLE) as isize;
            let input = GetStdHandle(STD_INPUT_HANDLE) as isize;
            let mut mode = 0;
            GetConsoleMode(output as _, &mut mode);
            SetConsoleMode(output as _, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT);
            SetConsoleOutputCP(65001);
            SetConsoleCP(65001);
            let mut input_mode = 0;
            GetConsoleMode(input as _, &mut input_mode);
            Console { output, input, input_mode }
        }
    }
    /// Raw keys and mouse clicks while a video or the hub list is open; line input again afterwards.
    fn raw(&self, on: bool) {
        unsafe {
            SetConsoleMode(self.input as _, if on { ENABLE_WINDOW_INPUT | ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS } else { self.input_mode });
        }
    }
    fn size(&self) -> (usize, usize) {
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(self.output as _, &mut info) == 0 {
                return (120, 40);
            }
            (((info.srWindow.Right - info.srWindow.Left) + 1) as usize, ((info.srWindow.Bottom - info.srWindow.Top) + 1) as usize)
        }
    }
    /// Height of a console cell over its width, from the font; 2.25 when the console does not say.
    fn cell_ratio(&self) -> f64 {
        unsafe {
            let mut font: CONSOLE_FONT_INFOEX = std::mem::zeroed();
            font.cbSize = std::mem::size_of::<CONSOLE_FONT_INFOEX>() as u32;
            if GetCurrentConsoleFontEx(self.output as _, 0, &mut font) != 0 && font.dwFontSize.X > 0 && font.dwFontSize.Y > 0 {
                let ratio = font.dwFontSize.Y as f64 / font.dwFontSize.X as f64;
                if ratio > 1.0 && ratio < 4.0 {
                    return ratio;
                }
            }
            2.25
        }
    }
    fn events(&self) -> Vec<Event> {
        let mut out = Vec::new();
        unsafe {
            loop {
                let mut count = 0;
                if GetNumberOfConsoleInputEvents(self.input as _, &mut count) == 0 || count == 0 {
                    break;
                }
                let mut record: INPUT_RECORD = std::mem::zeroed();
                let mut read = 0;
                if ReadConsoleInputW(self.input as _, &mut record, 1, &mut read) == 0 || read == 0 {
                    break;
                }
                match record.EventType as u32 {
                    KEY_EVENT => {
                        let key = record.Event.KeyEvent;
                        if key.bKeyDown != 0 {
                            out.push(Event::Key(key.wVirtualKeyCode, char::from_u32(key.uChar.UnicodeChar as u32).unwrap_or('\0')));
                        }
                    }
                    MOUSE_EVENT => {
                        let mouse = record.Event.MouseEvent;
                        if mouse.dwEventFlags == 0 && mouse.dwButtonState & 1 != 0 {
                            out.push(Event::Click(mouse.dwMousePosition.X as usize, mouse.dwMousePosition.Y as usize));
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }
}

enum Event {
    Key(u16, char),
    Click(usize, usize),
}

// ---- sources ----

/// Where the picture comes from, and the sound when it is in another file (grid variants of hub videos have none).
struct Source {
    picture: String,
    sound: Option<String>,
    title: String,
    subtitles: Option<String>,
}

/// Reads a file or a link into the library in the background.
fn load(location: String, library: Arc<Mutex<gcast::Library>>, stop: Arc<std::sync::atomic::AtomicBool>, until_sound: bool) {
    thread::spawn(move || {
        let push = |piece: &[u8]| -> bool {
            let mut lib = library.lock().unwrap();
            lib.push(piece);
            let keep = !stop.load(std::sync::atomic::Ordering::Relaxed) && lib.error.is_none() && !(until_sound && lib.audio_ready());
            keep
        };
        let result = if location.starts_with("http://") || location.starts_with("https://") {
            net::get(&location, push)
        } else {
            match std::fs::File::open(&location) {
                Ok(mut file) => {
                    use std::io::Read;
                    let mut buffer = vec![0u8; 1 << 20];
                    loop {
                        match file.read(&mut buffer) {
                            Ok(0) => break Ok(()),
                            Ok(n) => {
                                if !push(&buffer[..n]) {
                                    break Ok(());
                                }
                            }
                            Err(error) => break Err(format!("не читается файл: {error}")),
                        }
                    }
                }
                Err(error) => Err(format!("не открылся файл: {error}")),
            }
        };
        let mut lib = library.lock().unwrap();
        if let Err(error) = result {
            lib.error.get_or_insert(error);
        }
        lib.done = true;
    });
}

// ---- subtitles ----

struct Cue {
    start: f64,
    end: f64,
    text: String,
}

fn seconds(stamp: &str) -> f64 {
    stamp.trim().replace(',', ".").split(':').fold(0.0, |total, part| total * 60.0 + part.trim().parse::<f64>().unwrap_or(f64::NAN))
}

fn parse_captions(text: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let text = text.replace('\r', "");
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.split('\n').collect();
        let Some(timing) = lines.iter().position(|line| line.contains("-->")) else { continue };
        let mut parts = lines[timing].split("-->");
        let start = seconds(parts.next().unwrap_or(""));
        let end = seconds(parts.next().unwrap_or("").split_whitespace().next().unwrap_or(""));
        let mut body = String::new();
        let mut tag = false;
        for ch in lines[timing + 1..].join(" ").chars() {
            match ch {
                '<' => tag = true,
                '>' => tag = false,
                _ if !tag => body.push(ch),
                _ => {}
            }
        }
        let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
        if !body.is_empty() && start.is_finite() && end.is_finite() {
            cues.push(Cue { start, end, text: body });
        }
    }
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    cues
}

// ---- the player ----

fn clock(seconds: f64) -> String {
    let s = (seconds.max(0.0) + 0.5) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn button(text: &str, on: Option<bool>) -> String {
    let ink = match on {
        Some(false) => "\x1b[38;2;110;118;129m",
        Some(true) => "\x1b[38;2;240;160;75m",
        None => "\x1b[38;2;232;236;239m",
    };
    format!("\x1b[48;2;34;39;46m{ink} {text} \x1b[0m")
}

#[derive(Clone, Copy)]
enum Act {
    Toggle,
    Seek,
    Mode,
    Glyphs,
    Tint,
    Boost,
    Fill,
    Sharp,
    Smooth,
    Subs,
    Quit,
}

struct Decoded {
    frames: HashMap<usize, Arc<Vec<gcast::Frame>>>,
}

fn play(console: &Console, source: Source) -> Result<(), String> {
    let library = Arc::new(Mutex::new(gcast::Library::new()));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    load(source.picture.clone(), library.clone(), stop.clone(), false);
    let sound_library = source.sound.as_ref().map(|url| {
        let lib = Arc::new(Mutex::new(gcast::Library::new()));
        load(url.clone(), lib.clone(), stop.clone(), true);
        lib
    });
    // wait for the header
    let started = Instant::now();
    let info = loop {
        {
            let lib = library.lock().unwrap();
            if let Some(error) = &lib.error {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                return Err(error.clone());
            }
            if let Some(info) = &lib.info {
                break gcast::Info { ..*info };
            }
            if lib.done {
                return Err("файл пустой".into());
            }
        }
        if started.elapsed() > Duration::from_secs(30) {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("сервер долго не отвечает".into());
        }
        print!("\r⠿ загрузка: {}", source.title);
        std::io::stdout().flush().ok();
        thread::sleep(Duration::from_millis(100));
    };
    let result = run(console, &source, &info, &library, sound_library.as_ref());
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    result
}

fn run(console: &Console, source: &Source, info: &gcast::Info, library: &Arc<Mutex<gcast::Library>>, sound_library: Option<&Arc<Mutex<gcast::Library>>>) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    write!(out, "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J").ok();
    console.raw(true);
    let cell_ratio = console.cell_ratio();
    let decoded = Arc::new(Mutex::new(Decoded { frames: HashMap::new() }));
    let (want, wanted) = std::sync::mpsc::channel::<(usize, Vec<u8>)>();
    {
        // chunks are decoded on a thread of their own, the current one and the next
        let decoded = decoded.clone();
        let info = gcast::Info { ..*info };
        thread::spawn(move || {
            while let Ok((start, data)) = wanted.recv() {
                if decoded.lock().unwrap().frames.contains_key(&start) {
                    continue;
                }
                let frames = gcast::decode_chunk(&info, &data).unwrap_or_default();
                decoded.lock().unwrap().frames.insert(start, Arc::new(frames));
            }
        });
    }
    let mut requested: std::collections::HashSet<usize> = Default::default();
    let mut sound: Option<audio::Audio> = None;
    let mut sound_tried = false;
    let mut look = Look { mode: 0, glyphs: 0, tint: 0, boost: 1.3, fill: 0 };
    let (mut sharp, mut smooth, mut show_subs) = (true, true, true);
    let mut cues: Vec<Cue> = source.subtitles.as_deref().map(parse_captions).unwrap_or_default();
    let mut base = 0.0f64;
    let mut started_at = Instant::now();
    let (mut playing, mut waiting) = (true, false);
    let mut volume = 1.0f32;
    let mut levels: Levels = render::NEUTRAL;
    let mut previous: Option<Vec<Rgb>> = None;
    let mut drawn: Vec<Cell> = Vec::new();
    let mut shown_phase = usize::MAX;
    let mut redraw = true;
    let mut last_layout = (0, 0, 0, 0);
    let mut controls: Vec<(usize, usize, Act)> = Vec::new();
    let mut bar_from = 0;
    let mut bar_width = 1;
    let mut last_status = String::new();
    let total = |lib: &gcast::Library| lib.total() as f64 / info.fps;
    loop {
        let (duration, chunks, done, audio_ready, subtitles) = {
            let lib = library.lock().unwrap();
            (total(&lib), lib.chunks.iter().map(|c| c.start).collect::<Vec<_>>(), lib.done, lib.audio_ready(), lib.subtitles.clone())
        };
        if cues.is_empty() {
            if let Some(text) = subtitles {
                cues = parse_captions(&text);
            }
        }
        // the sound starts once it has arrived whole: from this file, or from the main file of a grid variant
        if !sound_tried {
            let ready = match sound_library {
                Some(other) => {
                    let lib = other.lock().unwrap();
                    (lib.audio_ready() || lib.done).then(|| lib.audio.clone())
                }
                None => audio_ready.then(|| library.lock().unwrap().audio.clone()),
            };
            if let Some(bytes) = ready {
                sound_tried = true;
                sound = if bytes.is_empty() { None } else { audio::Audio::new(bytes) };
                if let Some(s) = &sound {
                    s.volume(volume);
                    if playing && !waiting {
                        base = now(base, started_at, playing, waiting, duration);
                        started_at = Instant::now();
                        s.start(base);
                    }
                }
            }
        }
        let mut seek: Option<f64> = None;
        let mut quit = false;
        let mut toggle = false;
        let act = |action: Act, column: usize, look: &mut Look, sharp: &mut bool, smooth: &mut bool, show_subs: &mut bool, toggle: &mut bool, quit: &mut bool, seek: &mut Option<f64>| match action {
            Act::Toggle => *toggle = true,
            Act::Seek => *seek = Some(((column as f64 - bar_from as f64 + 0.5) / bar_width as f64).clamp(0.0, 1.0) * duration),
            Act::Mode => look.mode = (look.mode + 1) % MODES.len(),
            Act::Glyphs => look.glyphs = (look.glyphs + 1) % GLYPH_SETS.len(),
            Act::Tint => look.tint = (look.tint + 1) % TINTS.len(),
            Act::Boost => look.boost = BOOSTS[(BOOSTS.iter().position(|b| (*b - look.boost).abs() < 0.01).map(|i| i + 1).unwrap_or(0)) % BOOSTS.len()],
            Act::Fill => look.fill = (look.fill + 1) % FILLS.len(),
            Act::Sharp => *sharp = !*sharp,
            Act::Smooth => *smooth = !*smooth,
            Act::Subs => *show_subs = !*show_subs,
            Act::Quit => *quit = true,
        };
        let time = now(base, started_at, playing, waiting, duration);
        for event in console.events() {
            redraw = true;
            match event {
                Event::Key(code, ch) => match (code, ch.to_ascii_lowercase()) {
                    (0x51, _) | (0x1B, _) => quit = true,
                    (0x20, _) | (0x4B, _) => toggle = true,
                    (0x25, _) => seek = Some(time - 5.0),
                    (0x27, _) => seek = Some(time + 5.0),
                    (0x4A, _) => seek = Some(time - 10.0),
                    (0x4C, _) => seek = Some(time + 10.0),
                    (0x30..=0x39, _) => seek = Some((code - 0x30) as f64 / 10.0 * duration),
                    (0x26, _) | (0x28, _) => {
                        volume = (volume + if code == 0x26 { 0.1 } else { -0.1 }).clamp(0.0, 1.0);
                        if let Some(s) = &sound {
                            s.volume(volume);
                        }
                    }
                    (0x4D, _) => look.mode = (look.mode + 1) % MODES.len(),
                    (0x47, _) => look.glyphs = (look.glyphs + 1) % GLYPH_SETS.len(),
                    (0x43, _) => look.tint = (look.tint + 1) % TINTS.len(),
                    (0x53, _) => show_subs = !show_subs,
                    (0xDB, _) => look.boost = ((look.boost - 0.1).max(0.0) * 10.0).round() / 10.0,
                    (0xDD, _) => look.boost = ((look.boost + 0.1).min(2.5) * 10.0).round() / 10.0,
                    (0x42, _) => look.fill = (look.fill + 1) % FILLS.len(),
                    (0x58, _) => sharp = !sharp,
                    (0x56, _) => smooth = !smooth,
                    _ => {}
                },
                Event::Click(x, y) => {
                    let (_, height) = console.size();
                    if y + 1 == height {
                        if let Some(&(_, _, action)) = controls.iter().find(|(from, to, _)| x + 1 >= *from && x + 1 < *to) {
                            act(action, x + 1, &mut look, &mut sharp, &mut smooth, &mut show_subs, &mut toggle, &mut quit, &mut seek);
                        }
                    } else {
                        toggle = true;
                    }
                }
            }
        }
        if quit {
            break;
        }
        if toggle {
            if playing {
                base = time;
                playing = false;
                if let Some(s) = &sound {
                    s.pause();
                }
            } else {
                playing = true;
                started_at = Instant::now();
                if let Some(s) = &sound {
                    s.start(base);
                }
            }
        }
        if let Some(to) = seek {
            base = to.clamp(0.0, (duration - 0.05).max(0.0));
            started_at = Instant::now();
            previous = None;
            if let Some(s) = &sound {
                s.start(base);
                if !playing {
                    s.pause();
                }
            }
        }
        // the sound's position is the clock while it plays
        let mut time = now(base, started_at, playing, waiting, duration);
        if playing && !waiting && seek.is_none() && !toggle {
            if let Some(t) = sound.as_ref().and_then(|s| s.clock()) {
                if (t - time).abs() < 2.0 {
                    time = t.min(duration);
                }
            }
        }
        let frames_total = (duration * info.fps).round().max(1.0) as usize;
        let index = ((time * info.fps) as usize).min(frames_total - 1);
        let chunk = chunks.iter().rposition(|&start| start <= index);
        let present = chunk.map(|at| at + 1 < chunks.len() || done).unwrap_or(false);
        // a chunk that has not arrived yet holds the picture with "loading"
        if playing && !waiting && !present {
            base = time;
            waiting = true;
            if let Some(s) = &sound {
                s.pause();
            }
        } else if waiting && present {
            waiting = false;
            started_at = Instant::now();
            if playing {
                if let Some(s) = &sound {
                    s.start(base);
                }
            }
        }
        if let Some(at) = chunk {
            for k in at..(at + 2).min(chunks.len()) {
                if requested.insert(chunks[k]) {
                    let data = library.lock().unwrap().chunks[k].data.clone();
                    want.send((chunks[k], data)).ok();
                }
            }
            // keep a few chunks around the playback position
            let keep: Vec<usize> = chunks[at.saturating_sub(1)..(at + 3).min(chunks.len())].to_vec();
            decoded.lock().unwrap().frames.retain(|start, _| keep.contains(start));
            requested.retain(|start| keep.contains(start));
        }
        let half = smooth && time * info.fps - index as f64 >= 0.5;
        let phase = index * 2 + half as usize;
        let (width, height) = console.size();
        let view_height = height.saturating_sub(1).max(1);
        if phase != shown_phase || redraw {
            let start = chunk.map(|at| chunks[at]);
            let frames = start.and_then(|s| decoded.lock().unwrap().frames.get(&s).cloned());
            if let (Some(start), Some(frames)) = (start, frames) {
                if let Some(frame) = frames.get(index - start) {
                    let mut pixels = frame.rgb.clone();
                    if half {
                        let next = if index + 1 - start < frames.len() { frames.get(index + 1 - start).map(|f| (f.rgb.clone(), f.motion.clone())) } else {
                            chunk.and_then(|at| chunks.get(at + 1)).and_then(|s| decoded.lock().unwrap().frames.get(s).and_then(|f| f.first().map(|f| (f.rgb.clone(), f.motion.clone()))))
                        };
                        if let Some((to, motion)) = next {
                            pixels = render::interpolate(&pixels, &to, &motion, info.cols, info.rows, 0.5);
                        }
                    }
                    if phase != shown_phase {
                        previous = Some(render::steady(previous.as_ref(), &pixels));
                    }
                    let shown = previous.clone().unwrap_or(pixels);
                    levels = render::ease(levels, render::auto_levels(&shown));
                    let (fw, fh) = render::fit(info.cols, info.rows, width, view_height, cell_ratio);
                    let left = width.saturating_sub(fw).div_ceil(2);
                    let top = view_height.saturating_sub(fh) / 2;
                    let mut text = String::with_capacity(fw * fh * 12);
                    if (left, top, fw, fh) != last_layout {
                        text.push_str("\x1b[0m\x1b[2J");
                        drawn.clear();
                        last_status.clear();
                        last_layout = (left, top, fw, fh);
                    }
                    let detail = info.detail.then(|| Detail { masks: &frame.masks, cols: info.cols, rows: info.rows, pixels: &shown, shades: frame.shades.as_deref() });
                    let cells = if sharp {
                        render::frame(&render::upscale2x(&shown, info.cols, info.rows), info.cols * 2, info.rows * 2, levels, &look, fw, fh, detail.as_ref())
                    } else {
                        render::frame(&shown, info.cols, info.rows, levels, &look, fw, fh, detail.as_ref())
                    };
                    let mut style = None;
                    for y in 0..fh {
                        let mut placed = false;
                        for x in 0..fw {
                            let cell = cells[y * fw + x];
                            if drawn.get(y * fw + x) == Some(&cell) {
                                placed = false;
                                continue;
                            }
                            if !placed {
                                text.push_str(&format!("\x1b[{};{}H", top + y + 1, left + x + 1));
                                placed = true;
                            }
                            if style != Some((cell.fg, cell.bg)) {
                                text.push_str(&format!("\x1b[0;38;2;{};{};{}m", cell.fg[0], cell.fg[1], cell.fg[2]));
                                if let Some(bg) = cell.bg {
                                    text.push_str(&format!("\x1b[48;2;{};{};{}m", bg[0], bg[1], bg[2]));
                                }
                                style = Some((cell.fg, cell.bg));
                            }
                            text.push(cell.ch);
                        }
                    }
                    drawn = cells;
                    // subtitles over the bottom of the picture; the cells under them are redrawn next frame
                    if show_subs {
                        if let Some(cue) = cues.iter().find(|cue| time >= cue.start && time < cue.end) {
                            let words: String = cue.text.chars().take(fw.saturating_sub(4).max(10)).collect();
                            let length = words.chars().count();
                            let row = top + fh.saturating_sub(1);
                            text.push_str(&format!("\x1b[{};{}H\x1b[0;48;2;0;0;0;38;2;255;246;200m {} \x1b[0m", row, left + 1 + fw.saturating_sub(length + 2) / 2, words));
                            let from = (row - 1 - top) * fw;
                            for cell in drawn.iter_mut().skip(from).take(fw) {
                                cell.ch = '\0';
                            }
                        }
                    }
                    out.write_all(text.as_bytes()).ok();
                    shown_phase = phase;
                    redraw = false;
                }
            }
        }
        // the status bar: pause, time, progress (click to seek) and the look, each a button
        let span = width;
        let time_text = format!(" {} / {}{} ", clock(time), clock(duration), if waiting { " загрузка…" } else { "" });
        let mut options: Vec<(String, Option<bool>, Act)> = vec![
            (MODES[look.mode].to_string(), None, Act::Mode),
            (GLYPH_NAMES[look.glyphs].to_string(), None, Act::Glyphs),
            (TINTS[look.tint].0.to_string(), None, Act::Tint),
            (format!("насыщ. {:.1}", look.boost), None, Act::Boost),
            (format!("фон {}", FILLS[look.fill]), None, Act::Fill),
            ("чёткость".into(), Some(sharp), Act::Sharp),
            ("плавность".into(), Some(smooth), Act::Smooth),
        ];
        if !cues.is_empty() {
            options.push(("субтитры".into(), Some(show_subs), Act::Subs));
        }
        options.push(("✕".into(), None, Act::Quit));
        let width_of = |items: &[(String, Option<bool>, Act)]| items.iter().map(|(t, _, _)| t.chars().count() + 3).sum::<usize>();
        while options.len() > 1 && (span as i64) - 3 - time_text.chars().count() as i64 - (width_of(&options) as i64) < 10 {
            options.remove(options.len() - 2);
        }
        let bar = (span as i64 - 3 - time_text.chars().count() as i64 - width_of(&options) as i64 - 3).max(4) as usize;
        let filled = if duration > 0.0 { ((time / duration) * bar as f64).round() as usize } else { 0 }.min(bar);
        let mut map = Vec::new();
        let mut column = 1;
        let mut status = button(if playing { "▌▌" } else { "▶ " }, None);
        map.push((column, column + 4, Act::Toggle));
        column += 4;
        status.push_str(&time_text);
        column += time_text.chars().count();
        bar_from = column;
        bar_width = bar;
        status.push_str(&format!("\x1b[38;2;240;160;75m{}\x1b[38;2;60;66;76m{}\x1b[0m ", "━".repeat(filled), "━".repeat(bar - filled)));
        map.push((column, column + bar, Act::Seek));
        column += bar + 1;
        for (text, on, action) in &options {
            status.push_str(&button(text, *on));
            status.push(' ');
            map.push((column, column + text.chars().count() + 2, *action));
            column += text.chars().count() + 3;
        }
        controls = map;
        if status != last_status {
            out.write_all(format!("\x1b[{height};1H\x1b[0m\x1b[2K{status}").as_bytes()).ok();
            last_status = status;
        }
        out.flush().ok();
        if playing && !waiting && time >= duration && done {
            break;
        }
        thread::sleep(Duration::from_millis(((1000.0 / info.fps / 4.0) as u64).max(4)));
    }
    drop(sound);
    console.raw(false);
    write!(out, "\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l").ok();
    out.flush().ok();
    Ok(())
}

fn now(base: f64, started_at: Instant, playing: bool, waiting: bool, duration: f64) -> f64 {
    if playing && !waiting { (base + started_at.elapsed().as_secs_f64()).min(duration) } else { base }
}

// ---- the hub ----

struct HubVideo {
    id: String,
    slug: String,
    title: String,
    duration: f64,
    cols: usize,
    variants: Vec<usize>,
    subtitles: bool,
}

fn hub() -> Result<(String, Vec<HubVideo>), String> {
    let config = net::parse(&net::text(&format!("{HUB}/hub.json"))?).ok_or("хаб ответил непонятно")?;
    let files = config.get("files").and_then(|f| f.text()).ok_or("хаб ответил непонятно")?.trim_end_matches('/').to_string();
    let list = net::parse(&net::text(&format!("{files}/videos"))?).ok_or("хаб ответил непонятно")?;
    let videos = list
        .list()
        .iter()
        .filter_map(|v| {
            Some(HubVideo {
                id: v.get("id")?.text()?.to_string(),
                slug: v.get("slug").and_then(|s| s.text()).unwrap_or("").to_string(),
                title: v.get("title").and_then(|s| s.text()).unwrap_or("").to_string(),
                duration: v.get("duration").and_then(|d| d.number()).unwrap_or(0.0),
                cols: v.get("cols").and_then(|d| d.number()).unwrap_or(0.0) as usize,
                variants: v.get("variants").map(|l| l.list().iter().filter_map(|c| c.number()).map(|c| c as usize).collect()).unwrap_or_default(),
                subtitles: matches!(v.get("subtitles"), Some(net::Json::Bool(true))),
            })
        })
        .collect();
    Ok((files, videos))
}

/// A hub video at the grid that fits the console; a smaller grid takes its sound from the main file.
fn hub_source(files: &str, video: &HubVideo, width: usize) -> Source {
    let mut grids: Vec<usize> = std::iter::once(video.cols).chain(video.variants.iter().copied()).filter(|&c| c > 0).collect();
    grids.sort();
    let pick = grids.iter().copied().filter(|&c| c as f64 <= width as f64 * 1.5).last().or(grids.first().copied()).unwrap_or(0);
    let main = format!("{files}/v/{}.gcast", video.id);
    let picture = if pick > 0 && pick != video.cols { format!("{files}/v/{}-{pick}.gcast", video.id) } else { main.clone() };
    let subtitles = if video.subtitles { net::text(&format!("{files}/v/{}.vtt", video.id)).ok() } else { None };
    Source { sound: (picture != main).then_some(main), picture, title: video.title.clone(), subtitles }
}

fn fit_text(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        format!("{text}{}", " ".repeat(width - count))
    } else {
        format!("{}…", text.chars().take(width.saturating_sub(1)).collect::<String>())
    }
}

/// The hub list: ↑/↓ choose, typing searches, Enter plays, Esc goes back.
fn pick(console: &Console, videos: &[HubVideo]) -> Option<usize> {
    let mut query = String::new();
    let (mut at, mut top) = (0usize, 0usize);
    let mut out = std::io::stdout().lock();
    write!(out, "\x1b[?1049h\x1b[?25l").ok();
    console.raw(true);
    let mut dirty = true;
    let result = loop {
        let found: Vec<usize> = (0..videos.len()).filter(|&i| videos[i].title.to_lowercase().contains(&query.to_lowercase())).collect();
        if dirty {
            let (width, height) = console.size();
            let rows = height.saturating_sub(4).max(3);
            at = at.min(found.len().saturating_sub(1));
            if at < top {
                top = at;
            }
            if at >= top + rows {
                top = at + 1 - rows;
            }
            let mut screen = String::from("\x1b[H\x1b[2J\x1b[1m\x1b[38;2;240;160;75mgcast hub\x1b[0m   \x1b[2m↑↓ выбор · Enter смотреть · Esc назад · печатайте для поиска\x1b[0m\n");
            screen.push_str(&format!("\x1b[38;2;154;160;168mПоиск:\x1b[0m {query}\x1b[7m \x1b[0m\n\n"));
            if found.is_empty() {
                screen.push_str("\x1b[2mНичего не нашлось\x1b[0m\n");
            }
            for (row, &i) in found.iter().enumerate().skip(top).take(rows) {
                let line = format!(" {}{:>9} ", fit_text(&videos[i].title, width.saturating_sub(14).max(20)), clock(videos[i].duration));
                screen.push_str(&if row == at { format!("\x1b[48;2;240;160;75m\x1b[38;2;26;18;6m{line}\x1b[0m\n") } else { format!("{line}\n") });
            }
            out.write_all(screen.as_bytes()).ok();
            out.flush().ok();
            dirty = false;
        }
        let mut chosen = None;
        let mut escape = false;
        for event in console.events() {
            dirty = true;
            if let Event::Key(code, ch) = event {
                match code {
                    0x1B => escape = true,
                    0x0D => chosen = found.get(at).copied(),
                    0x26 => at = at.saturating_sub(1),
                    0x28 => at = (at + 1).min(found.len().saturating_sub(1)),
                    0x21 => at = at.saturating_sub(10),
                    0x22 => at = (at + 10).min(found.len().saturating_sub(1)),
                    0x08 => {
                        query.pop();
                    }
                    _ if ch >= ' ' => {
                        query.push(ch);
                        at = 0;
                    }
                    _ => {}
                }
            }
        }
        if escape {
            break None;
        }
        if chosen.is_some() {
            break chosen;
        }
        thread::sleep(Duration::from_millis(20));
    };
    console.raw(false);
    write!(out, "[?25h[?1049l").ok();
    result
}


fn hub_menu(console: &Console, start: Option<&str>) -> Result<(), String> {
    println!("Загружаю список видео из хаба…");
    let (files, videos) = hub()?;
    if let Some(name) = start {
        let video = videos.iter().find(|v| v.slug == name || v.id == name).ok_or(format!("в хабе нет видео «{name}»"))?;
        return play(console, hub_source(&files, video, console.size().0));
    }
    while let Some(i) = pick(console, &videos) {
        if let Err(error) = play(console, hub_source(&files, &videos[i], console.size().0)) {
            println!("\n{}: {error}", videos[i].title);
            thread::sleep(Duration::from_secs(2));
        }
    }
    Ok(())
}

/// A path as Windows puts it when a file is dragged into the console: maybe in quotes, maybe with & in front.
fn clean(line: &str) -> String {
    let line = line.trim().trim_start_matches('&').trim();
    line.trim_matches('"').trim_matches('\'').to_string()
}

fn open(console: &Console, what: &str) -> Result<(), String> {
    if what == "hub" {
        return hub_menu(console, None);
    }
    if let Some(name) = what.strip_prefix("hub:") {
        return hub_menu(console, Some(name));
    }
    let remote = what.starts_with("http://") || what.starts_with("https://");
    if !remote && !std::path::Path::new(what).exists() {
        return Err("нет такого файла".into());
    }
    if !remote && !what.to_lowercase().ends_with(".gcast") {
        return Err("этот плеер играет файлы .gcast. Видео переводится в .gcast прямо в браузере: https://gcast.1lop.ru".into());
    }
    play(console, Source { picture: what.to_string(), sound: None, title: what.rsplit(['\\', '/']).next().unwrap_or(what).to_string(), subtitles: None })
}

fn main() {
    let console = Console::open();
    let mut queue: Vec<String> = std::env::args().skip(1).collect();
    queue.reverse();
    let from_arguments = !queue.is_empty();
    loop {
        let what = match queue.pop() {
            Some(item) => clean(&item),
            None => {
                if from_arguments {
                    // a file dropped onto the exe: after it the window offers the next one instead of closing
                }
                println!("\nglyphcast {VERSION} — видео символами в консоли");
                println!("Перетащите сюда файл .gcast или вставьте ссылку и нажмите Enter. hub — видео из хаба, Enter без ввода — выход.");
                print!("> ");
                std::io::stdout().flush().ok();
                let mut line = String::new();
                if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let what = clean(&line);
                if what.is_empty() {
                    return;
                }
                what
            }
        };
        if let Err(error) = open(&console, &what) {
            println!("\n{what}: {error}");
        }
    }
}
