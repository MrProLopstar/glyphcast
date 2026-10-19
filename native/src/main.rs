//! glc.exe: plays .gcast files in the Windows console. Drop a file onto the exe, or start it and drag files into
//! the window. Space pauses, ←/→ seek 5 s, ↑/↓ volume, Q or Esc stops.

mod audio;
mod gcast;

use std::io::{BufRead, Write};
use std::sync::mpsc::{sync_channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Console::*;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn console() -> (isize, isize) {
    unsafe {
        let output = GetStdHandle(STD_OUTPUT_HANDLE) as isize;
        let input = GetStdHandle(STD_INPUT_HANDLE) as isize;
        let mut mode = 0;
        GetConsoleMode(output as _, &mut mode);
        SetConsoleMode(output as _, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT);
        SetConsoleOutputCP(65001);
        SetConsoleCP(65001);
        (output, input)
    }
}

fn size(output: isize) -> (usize, usize) {
    unsafe {
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        if GetConsoleScreenBufferInfo(output as _, &mut info) == 0 {
            return (120, 40);
        }
        (((info.srWindow.Right - info.srWindow.Left) + 1) as usize, ((info.srWindow.Bottom - info.srWindow.Top) + 1) as usize)
    }
}

enum Key {
    Pause,
    Back,
    Forward,
    Louder,
    Quieter,
    Quit,
}

/// Keys pressed since the last call, without waiting.
fn keys(input: isize) -> Vec<Key> {
    let mut out = Vec::new();
    unsafe {
        loop {
            let mut count = 0;
            if GetNumberOfConsoleInputEvents(input as _, &mut count) == 0 || count == 0 {
                break;
            }
            let mut record: INPUT_RECORD = std::mem::zeroed();
            let mut read = 0;
            if ReadConsoleInputW(input as _, &mut record, 1, &mut read) == 0 || read == 0 {
                break;
            }
            if record.EventType as u32 != KEY_EVENT {
                continue;
            }
            let key = record.Event.KeyEvent;
            if key.bKeyDown == 0 {
                continue;
            }
            match key.wVirtualKeyCode {
                0x20 => out.push(Key::Pause),
                0x25 => out.push(Key::Back),
                0x27 => out.push(Key::Forward),
                0x26 => out.push(Key::Louder),
                0x28 => out.push(Key::Quieter),
                0x51 | 0x1B => out.push(Key::Quit),
                _ => {}
            }
        }
    }
    out
}

/// Our mask bit y·2+x to the Unicode braille dot numbering.
fn braille(mask: u8) -> char {
    const DOTS: [u32; 8] = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
    let bits = (0..8).filter(|bit| mask >> bit & 1 == 1).map(|bit| DOTS[bit]).sum::<u32>();
    char::from_u32(0x2800 + bits).unwrap_or(' ')
}

#[derive(Clone, Copy, PartialEq)]
struct Cell {
    ch: char,
    fg: [u8; 3],
    bg: [u8; 3],
}

/// The color of a patterned cell's dark dots: stored, or the average of the darker neighbors, or half its color.
fn dark(frame: &gcast::Frame, cols: usize, rows: usize, cell: usize) -> [u8; 3] {
    if let Some(shades) = &frame.shades {
        if shades[cell] != [0, 0, 0] {
            return shades[cell];
        }
    }
    let luma = |c: [u8; 3]| c[0] as f32 * 0.299 + c[1] as f32 * 0.587 + c[2] as f32 * 0.114;
    let own = luma(frame.rgb[cell]);
    let (x, y) = (cell % cols, cell / cols);
    let mut sum = [0u32; 3];
    let mut count = 0;
    for (ok, near) in [(x > 0, cell.wrapping_sub(1)), (x + 1 < cols, cell + 1), (y > 0, cell.wrapping_sub(cols)), (y + 1 < rows, cell + cols)] {
        if ok && luma(frame.rgb[near]) < own - 10.0 {
            for c in 0..3 {
                sum[c] += frame.rgb[near][c] as u32;
            }
            count += 1;
        }
    }
    if count == 0 {
        return frame.rgb[cell].map(|v| v / 2);
    }
    [0, 1, 2].map(|c| (sum[c] / count) as u8)
}

/// The frame scaled to the window, one stream cell per console character at most.
fn layout(frame: &gcast::Frame, info: &gcast::Info, width: usize, height: usize) -> (usize, usize, Vec<Cell>) {
    let scale = (width as f64 / info.cols as f64).min(height as f64 / info.rows as f64).min(1.0);
    let (w, h) = (((info.cols as f64 * scale) as usize).max(1), ((info.rows as f64 * scale) as usize).max(1));
    let mut cells = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let cell = (y * info.rows / h) * info.cols + x * info.cols / w;
            let color = frame.rgb[cell];
            let mask = if info.detail { frame.masks[cell] } else { 0 };
            cells.push(if mask == 0 { Cell { ch: ' ', fg: color, bg: color } } else { Cell { ch: braille(mask), fg: color, bg: dark(frame, info.cols, info.rows, cell) } });
        }
    }
    (w, h, cells)
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// Decodes chunks in order from `first`, a few ahead of playback; a seek starts a new reader.
fn reader(file: std::sync::Arc<gcast::File>, first: usize) -> Receiver<(usize, Vec<gcast::Frame>)> {
    let (send, receive) = sync_channel(3);
    thread::spawn(move || {
        for chunk in &file.chunks[first..] {
            let frames = gcast::decode_chunk(&file.info, &file.bytes[chunk.data.clone()]).unwrap_or_default();
            if send.send((chunk.start, frames)).is_err() {
                return;
            }
        }
    });
    receive
}

fn play(path: &str, output: isize, input: isize) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|error| format!("не открылся файл: {error}"))?;
    let file = std::sync::Arc::new(gcast::open(bytes)?);
    let info = &file.info;
    if file.chunks.is_empty() {
        return Err("в файле нет кадров".into());
    }
    let duration = file.info.frames as f64 / info.fps;
    let sound = if file.audio.is_empty() { None } else { audio::Audio::new(file.audio.clone()) };
    let mut out = std::io::stdout().lock();
    write!(out, "\x1b[?25l\x1b[2J").ok();
    let chunk_at = |time: f64| -> usize {
        let frame = (time * info.fps) as usize;
        file.chunks.iter().rposition(|c| c.start <= frame).unwrap_or(0)
    };
    let mut position = 0.0f64;
    let mut decoded = reader(file.clone(), 0);
    let mut buffer: Vec<(usize, Vec<gcast::Frame>)> = Vec::new();
    let mut paused = false;
    let mut volume = 1.0f32;
    let mut wall = Instant::now();
    let mut wall_from = 0.0;
    let mut previous: Vec<Cell> = Vec::new();
    let mut last_size = (0, 0);
    let mut shown = usize::MAX;
    if let Some(s) = &sound {
        s.start(0.0);
    }
    let result = loop {
        let mut seek: Option<f64> = None;
        for key in keys(input) {
            match key {
                Key::Quit => return finish(&mut out),
                Key::Pause => {
                    paused = !paused;
                    if let Some(s) = &sound {
                        if paused { s.pause() } else { s.resume() }
                    }
                    wall = Instant::now();
                    wall_from = position;
                    shown = usize::MAX;
                }
                Key::Back => seek = Some((position - 5.0).max(0.0)),
                Key::Forward => seek = Some((position + 5.0).min(duration - 0.1)),
                Key::Louder | Key::Quieter => {
                    volume = (volume + if matches!(key, Key::Louder) { 0.1 } else { -0.1 }).clamp(0.0, 1.0);
                    if let Some(s) = &sound {
                        s.volume(volume);
                    }
                    shown = usize::MAX;
                }
            }
        }
        if let Some(to) = seek {
            position = to;
            decoded = reader(file.clone(), chunk_at(to));
            buffer.clear();
            if let Some(s) = &sound {
                s.start(to);
                if paused {
                    s.pause();
                }
            }
            wall = Instant::now();
            wall_from = to;
            shown = usize::MAX;
        }
        // the sound's clock when there is sound, else the wall clock
        if !paused {
            position = match sound.as_ref().and_then(|s| s.clock()) {
                Some(t) => t,
                None => wall_from + wall.elapsed().as_secs_f64(),
            };
        }
        if position >= duration {
            break Ok(());
        }
        let frame_index = ((position * info.fps) as usize).min(file.info.frames.saturating_sub(1));
        while !buffer.iter().any(|(start, frames)| frame_index >= *start && frame_index < start + frames.len()) {
            match decoded.recv_timeout(Duration::from_millis(5)) {
                Ok(chunk) => {
                    buffer.retain(|(start, frames)| start + frames.len() > frame_index);
                    buffer.push(chunk);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(_) => break,
            }
        }
        let size = size(output);
        let found = buffer.iter().find(|(start, frames)| frame_index >= *start && frame_index < start + frames.len());
        if let Some((start, frames)) = found {
            if frame_index != shown || size != last_size {
                let (w, h, cells) = layout(&frames[frame_index - start], info, size.0, size.1.saturating_sub(1));
                let mut text = String::with_capacity(cells.len() * 8);
                if size != last_size {
                    text.push_str("\x1b[0m\x1b[2J");
                    previous.clear();
                    last_size = size;
                }
                let left = (size.0.saturating_sub(w)) / 2;
                let mut colors = None;
                for y in 0..h {
                    let mut moved = false;
                    for x in 0..w {
                        let cell = cells[y * w + x];
                        if previous.get(y * w + x) == Some(&cell) {
                            moved = false;
                            continue;
                        }
                        if !moved {
                            text.push_str(&format!("\x1b[{};{}H", y + 1, left + x + 1));
                            moved = true;
                        }
                        if colors != Some((cell.fg, cell.bg)) {
                            text.push_str(&format!("\x1b[38;2;{};{};{};48;2;{};{};{}m", cell.fg[0], cell.fg[1], cell.fg[2], cell.bg[0], cell.bg[1], cell.bg[2]));
                            colors = Some((cell.fg, cell.bg));
                        }
                        text.push(cell.ch);
                    }
                }
                let status = format!(
                    " {} {} / {}   звук {}%   пробел пауза · ←/→ 5 с · ↑/↓ громкость · Q выход",
                    if paused { "❚❚" } else { "▶" },
                    clock(position),
                    clock(duration),
                    (volume * 100.0).round()
                );
                text.push_str(&format!("\x1b[0m\x1b[{};1H\x1b[2K{}", size.1, status.chars().take(size.0.saturating_sub(1)).collect::<String>()));
                out.write_all(text.as_bytes()).ok();
                out.flush().ok();
                previous = cells;
                shown = frame_index;
            }
        }
        thread::sleep(Duration::from_millis(4));
    };
    finish(&mut out)?;
    result
}

fn finish(out: &mut impl Write) -> Result<(), String> {
    write!(out, "\x1b[0m\x1b[2J\x1b[H\x1b[?25h").ok();
    out.flush().ok();
    Ok(())
}

/// A path as Windows puts it when a file is dragged into the console: maybe in quotes, maybe with & in front.
fn clean(line: &str) -> String {
    let line = line.trim().trim_start_matches('&').trim();
    line.trim_matches('"').trim_matches('\'').to_string()
}

fn main() {
    let (output, input) = console();
    let mut queue: Vec<String> = std::env::args().skip(1).collect();
    loop {
        let path = match queue.pop() {
            Some(path) => clean(&path),
            None => {
                println!("glyphcast {VERSION} — видео символами в консоли");
                print!("Перетащите сюда файл .gcast и нажмите Enter (Enter без файла — выход): ");
                std::io::stdout().flush().ok();
                let mut line = String::new();
                if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let path = clean(&line);
                if path.is_empty() {
                    return;
                }
                path
            }
        };
        if !path.to_lowercase().ends_with(".gcast") {
            println!("\nЭтот плеер играет файлы .gcast. Видео можно перевести в .gcast в браузере: https://gcast.1lop.ru\n");
            continue;
        }
        if let Err(error) = play(&path, output, input) {
            println!("\n{path}: {error}\n");
        }
    }
}
