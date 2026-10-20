//! The library's stream reader with what the player tracks around it: whether the download ended, and its error.

pub use glyphcast::format::{Frame, Info};

pub struct Library {
    reader: glyphcast::format::Reader,
    pub done: bool,
    pub error: Option<String>,
}

impl std::ops::Deref for Library {
    type Target = glyphcast::format::Reader;
    fn deref(&self) -> &Self::Target {
        &self.reader
    }
}

impl Library {
    pub fn new() -> Self {
        Library { reader: glyphcast::format::Reader::new(), done: false, error: None }
    }
    pub fn push(&mut self, bytes: &[u8]) {
        if self.error.is_some() {
            return;
        }
        if let Err(error) = self.reader.push(bytes) {
            self.error = Some(match error {
                glyphcast::format::Error::NotGcast => crate::tr("not a .gcast file", "это не файл .gcast").to_string(),
                glyphcast::format::Error::Version(v) => {
                    if crate::russian() { format!("формат {v}: этот плеер читает файлы glyphcast 1.0 и новее (формат 6). Перекодируйте файл командой glc encode или в конвертере") } else { format!("format {v}: this player reads files of glyphcast 1.0 and later (format 6). Re-encode with glc encode or the converter") }
                }
                other => other.to_string(),
            });
        }
    }
    pub fn audio_ready(&self) -> bool {
        self.reader.audio_ready() || self.done
    }
}

pub fn decode_chunk(info: &Info, data: &[u8]) -> Result<Vec<Frame>, String> {
    glyphcast::format::decode_chunk(info, data).map_err(|e| e.to_string())
}
