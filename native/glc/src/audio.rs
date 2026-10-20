//! The embedded sound: Ogg Opus pages decoded with libopus and played through waveOut. A thread feeds the device;
//! the playback position of the device is the player's clock.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Media::Audio::*;
use windows_sys::Win32::Media::{MMTIME, TIME_BYTES, TIME_SAMPLES};

const RATE: usize = 48000;
const BUFFERS: usize = 4;
const BUFFER_SAMPLES: usize = RATE / 10;

struct Page {
    granule: i64,
    packets: Vec<Vec<u8>>,
}

enum Command {
    Start(f64),
    Pause,
    Volume(f32),
}

pub struct Audio {
    commands: Sender<Command>,
    device: Arc<AtomicIsize>,
    /// Playback time at the last start and the device position then: some drivers do not reset it.
    base: Arc<Mutex<(f64, f64)>>,
    started: Arc<AtomicBool>,
    block: usize,
}

/// Splits an Ogg stream into pages with their complete packets (a packet belongs to the page it ends on).
fn pages(bytes: &[u8]) -> Vec<Page> {
    let mut out = Vec::new();
    let mut partial: Vec<u8> = Vec::new();
    let mut at = 0;
    while at + 27 <= bytes.len() && &bytes[at..at + 4] == b"OggS" {
        let granule = i64::from_le_bytes(bytes[at + 6..at + 14].try_into().unwrap());
        let segments = bytes[at + 26] as usize;
        let lacing = &bytes[at + 27..(at + 27 + segments).min(bytes.len())];
        let mut data = at + 27 + segments;
        let mut packets = Vec::new();
        for &size in lacing {
            let end = (data + size as usize).min(bytes.len());
            partial.extend_from_slice(&bytes[data..end]);
            data = end;
            if size < 255 {
                packets.push(std::mem::take(&mut partial));
            }
        }
        out.push(Page { granule, packets });
        at = data;
    }
    out
}

impl Audio {
    /// None when the bytes are not Ogg Opus (other embedded formats need the npm package).
    pub fn new(bytes: Vec<u8>) -> Option<Audio> {
        let pages = pages(&bytes);
        let head = pages.first()?.packets.first()?;
        if head.len() < 19 || &head[0..8] != b"OpusHead" {
            return None;
        }
        let channels = head[9].clamp(1, 2) as usize;
        let preskip = u16::from_le_bytes([head[10], head[11]]) as i64;
        let (commands, receive) = channel();
        let device = Arc::new(AtomicIsize::new(0));
        let base = Arc::new(Mutex::new((0.0, 0.0)));
        let started = Arc::new(AtomicBool::new(false));
        let (d, b, s) = (device.clone(), base.clone(), started.clone());
        thread::spawn(move || feed(pages, channels, preskip, receive, d, b, s));
        Some(Audio { commands, device, base, started, block: channels * 2 })
    }

    pub fn start(&self, at: f64) {
        let _ = self.commands.send(Command::Start(at));
    }
    pub fn pause(&self) {
        let _ = self.commands.send(Command::Pause);
    }
    pub fn volume(&self, level: f32) {
        let _ = self.commands.send(Command::Volume(level));
    }

    /// Seconds of the sound played so far, None until the device runs.
    pub fn clock(&self) -> Option<f64> {
        if !self.started.load(Ordering::Acquire) {
            return None;
        }
        let samples = position(self.device.load(Ordering::Acquire) as HWAVEOUT, self.block)?;
        let (at, offset) = *self.base.lock().unwrap();
        Some(at + (samples - offset).max(0.0) / RATE as f64)
    }
}

/// Samples the device has played since it was opened (drivers may count bytes instead).
fn position(device: HWAVEOUT, block: usize) -> Option<f64> {
    let mut time: MMTIME = unsafe { std::mem::zeroed() };
    time.wType = TIME_SAMPLES;
    if unsafe { waveOutGetPosition(device, &mut time, std::mem::size_of::<MMTIME>() as u32) } != 0 {
        return None;
    }
    Some(if time.wType == TIME_BYTES { (unsafe { time.u.cb }) as f64 / block as f64 } else { (unsafe { time.u.sample }) as f64 })
}

fn feed(pages: Vec<Page>, channels: usize, preskip: i64, commands: Receiver<Command>, device: Arc<AtomicIsize>, base: Arc<Mutex<(f64, f64)>>, started: Arc<AtomicBool>) {
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: channels as u16,
        nSamplesPerSec: RATE as u32,
        nAvgBytesPerSec: (RATE * channels * 2) as u32,
        nBlockAlign: (channels * 2) as u16,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    let mut handle: HWAVEOUT = std::ptr::null_mut();
    if unsafe { waveOutOpen(&mut handle, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) } != 0 {
        return;
    }
    device.store(handle as isize, Ordering::Release);
    let mut buffers: Vec<Vec<i16>> = (0..BUFFERS).map(|_| vec![0i16; BUFFER_SAMPLES * channels]).collect();
    let mut headers: Vec<Box<WAVEHDR>> = (0..BUFFERS).map(|_| Box::new(unsafe { std::mem::zeroed::<WAVEHDR>() })).collect();
    let mut decoder = opus::Decoder::new(RATE as u32, if channels == 2 { opus::Channels::Stereo } else { opus::Channels::Mono }).unwrap();
    let mut pcm = vec![0i16; 5760 * channels];
    let mut pending: Vec<i16> = Vec::new();
    let (mut page, mut packet) = (pages.len(), 0usize);
    let mut skip: i64 = 0;
    let mut playing = false;
    let mut volume = 1.0f32;
    loop {
        // commands: a new start position resets the device and the decoder
        let wait = if playing { Duration::from_millis(10) } else { Duration::from_millis(50) };
        if let Ok(command) = commands.recv_timeout(wait) {
            match command {
                Command::Start(at) => unsafe {
                    waveOutReset(handle);
                    for header in headers.iter_mut() {
                        if header.dwFlags & WHDR_PREPARED != 0 {
                            waveOutUnprepareHeader(handle, header.as_mut(), std::mem::size_of::<WAVEHDR>() as u32);
                        }
                        header.dwFlags = 0;
                    }
                    let target = (at * RATE as f64) as i64 + preskip;
                    // start a little before the target so the decoder settles, then drop samples up to it
                    let found = pages.iter().rposition(|p| p.granule >= 0 && p.granule <= target - RATE as i64 / 5).unwrap_or(0);
                    page = found;
                    packet = 0;
                    let decoded = if found == 0 { 0 } else { pages[found - 1].granule.max(0) };
                    skip = (target - decoded).max(0) * channels as i64;
                    decoder.reset_state().ok();
                    pending.clear();
                    *base.lock().unwrap() = (at, position(handle, channels * 2).unwrap_or(0.0));
                    playing = true;
                    started.store(true, Ordering::Release);
                },
                Command::Pause => unsafe {
                    waveOutPause(handle);
                },
                Command::Volume(level) => volume = level,
            }
            continue;
        }
        if !playing {
            continue;
        }
        // fill every free buffer
        for slot in 0..BUFFERS {
            let header = headers[slot].as_mut();
            if header.dwFlags & WHDR_PREPARED != 0 && header.dwFlags & WHDR_DONE == 0 {
                continue;
            }
            while pending.len() < BUFFER_SAMPLES * channels && page < pages.len() {
                if packet >= pages[page].packets.len() {
                    page += 1;
                    packet = 0;
                    continue;
                }
                let data = &pages[page].packets[packet];
                packet += 1;
                if data.starts_with(b"OpusHead") || data.starts_with(b"OpusTags") {
                    continue;
                }
                if let Ok(count) = decoder.decode(data, &mut pcm, false) {
                    let mut got = &pcm[..count * channels];
                    if skip > 0 {
                        let drop = (skip as usize).min(got.len());
                        skip -= drop as i64;
                        got = &got[drop..];
                    }
                    pending.extend_from_slice(got);
                }
            }
            if pending.is_empty() {
                break;
            }
            let take = pending.len().min(BUFFER_SAMPLES * channels);
            let buffer = &mut buffers[slot];
            for (out, sample) in buffer.iter_mut().zip(pending.drain(..take)) {
                *out = (sample as f32 * volume) as i16;
            }
            unsafe {
                if header.dwFlags & WHDR_PREPARED != 0 {
                    waveOutUnprepareHeader(handle, header, std::mem::size_of::<WAVEHDR>() as u32);
                }
                *header = std::mem::zeroed();
                header.lpData = buffer.as_mut_ptr() as *mut u8;
                header.dwBufferLength = (take * 2) as u32;
                waveOutPrepareHeader(handle, header, std::mem::size_of::<WAVEHDR>() as u32);
                waveOutWrite(handle, header, std::mem::size_of::<WAVEHDR>() as u32);
            }
        }
    }
}
