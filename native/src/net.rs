//! HTTP(S) downloads through Windows' own WinHTTP, so the exe needs no TLS library. Also a tiny JSON reader for
//! the hub's catalog.

use windows_sys::Win32::Networking::WinHttp::*;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Handle(*mut core::ffi::c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

/// Streams `url` into `each` piece by piece; `each` returns false to stop early.
pub fn get(url: &str, mut each: impl FnMut(&[u8]) -> bool) -> Result<(), String> {
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") { (true, rest) } else if let Some(rest) = url.strip_prefix("http://") { (false, rest) } else { return Err(format!("не ссылка: {url}")) };
    let (host_port, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let path = if path.is_empty() { "/" } else { path };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => (host, port.parse().unwrap_or(443)),
        _ => (host_port, if secure { 443 } else { 80 }),
    };
    let fail = |what: &str| format!("сеть: {what} не удалось ({})", std::io::Error::last_os_error());
    unsafe {
        let session = Handle(WinHttpOpen(wide("glyphcast-glc").as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, std::ptr::null(), std::ptr::null(), 0));
        if session.0.is_null() {
            return Err(fail("WinHttpOpen"));
        }
        let connection = Handle(WinHttpConnect(session.0, wide(host).as_ptr(), port, 0));
        if connection.0.is_null() {
            return Err(fail("подключение"));
        }
        let request = Handle(WinHttpOpenRequest(connection.0, wide("GET").as_ptr(), wide(path).as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), if secure { WINHTTP_FLAG_SECURE } else { 0 }));
        if request.0.is_null() {
            return Err(fail("запрос"));
        }
        if WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0) == 0 || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0 {
            return Err(fail("запрос"));
        }
        let mut status: u32 = 0;
        let mut size = 4u32;
        WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, std::ptr::null(), &mut status as *mut u32 as *mut _, &mut size, std::ptr::null_mut());
        if status >= 400 {
            return Err(format!("сервер ответил {status}"));
        }
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let mut read = 0u32;
            if WinHttpReadData(request.0, buffer.as_mut_ptr() as *mut _, buffer.len() as u32, &mut read) == 0 {
                return Err(fail("загрузка"));
            }
            if read == 0 || !each(&buffer[..read as usize]) {
                return Ok(());
            }
        }
    }
}

pub fn text(url: &str) -> Result<String, String> {
    let mut out = Vec::new();
    get(url, |piece| {
        out.extend_from_slice(piece);
        true
    })?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[derive(Debug, Clone)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn text(&self) -> Option<&str> {
        match self {
            Json::Text(text) => Some(text),
            _ => None,
        }
    }
    pub fn number(&self) -> Option<f64> {
        match self {
            Json::Number(n) => Some(*n),
            _ => None,
        }
    }
    pub fn list(&self) -> &[Json] {
        match self {
            Json::List(items) => items,
            _ => &[],
        }
    }
}

pub fn parse(text: &str) -> Option<Json> {
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    value(&chars, &mut at)
}

fn skip(c: &[char], at: &mut usize) {
    while *at < c.len() && c[*at].is_whitespace() {
        *at += 1;
    }
}

fn value(c: &[char], at: &mut usize) -> Option<Json> {
    skip(c, at);
    match *c.get(*at)? {
        '{' => {
            *at += 1;
            let mut items = Vec::new();
            loop {
                skip(c, at);
                if c.get(*at) == Some(&'}') {
                    *at += 1;
                    return Some(Json::Object(items));
                }
                let Json::Text(key) = value(c, at)? else { return None };
                skip(c, at);
                if c.get(*at) != Some(&':') {
                    return None;
                }
                *at += 1;
                items.push((key, value(c, at)?));
                skip(c, at);
                if c.get(*at) == Some(&',') {
                    *at += 1;
                }
            }
        }
        '[' => {
            *at += 1;
            let mut items = Vec::new();
            loop {
                skip(c, at);
                if c.get(*at) == Some(&']') {
                    *at += 1;
                    return Some(Json::List(items));
                }
                items.push(value(c, at)?);
                skip(c, at);
                if c.get(*at) == Some(&',') {
                    *at += 1;
                }
            }
        }
        '"' => {
            *at += 1;
            let mut out = String::new();
            while let Some(&ch) = c.get(*at) {
                *at += 1;
                match ch {
                    '"' => return Some(Json::Text(out)),
                    '\\' => {
                        let escaped = *c.get(*at)?;
                        *at += 1;
                        match escaped {
                            'n' => out.push('\n'),
                            't' => out.push('\t'),
                            'r' => {}
                            'b' | 'f' => {}
                            'u' => {
                                let code = u32::from_str_radix(&c.get(*at..*at + 4)?.iter().collect::<String>(), 16).ok()?;
                                *at += 4;
                                // surrogate pairs come as two escapes
                                if (0xd800..0xdc00).contains(&code) && c.get(*at) == Some(&'\\') && c.get(*at + 1) == Some(&'u') {
                                    let low = u32::from_str_radix(&c.get(*at + 2..*at + 6)?.iter().collect::<String>(), 16).ok()?;
                                    *at += 6;
                                    out.push(char::from_u32(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)).unwrap_or('?'));
                                } else {
                                    out.push(char::from_u32(code).unwrap_or('?'));
                                }
                            }
                            other => out.push(other),
                        }
                    }
                    other => out.push(other),
                }
            }
            None
        }
        't' => {
            *at += 4;
            Some(Json::Bool(true))
        }
        'f' => {
            *at += 5;
            Some(Json::Bool(false))
        }
        'n' => {
            *at += 4;
            Some(Json::Null)
        }
        _ => {
            let start = *at;
            while *at < c.len() && matches!(c[*at], '-' | '+' | '.' | 'e' | 'E' | '0'..='9') {
                *at += 1;
            }
            c[start..*at].iter().collect::<String>().parse().ok().map(Json::Number)
        }
    }
}
