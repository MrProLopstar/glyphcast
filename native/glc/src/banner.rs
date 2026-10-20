//! The greeting of the interactive player: the logo in block letters with a braille cell beside it, in the
//! glyphcast orange fading to yellow.

const LOGO: [&str; 4] = [
    "⣿⣿  ▄▄▄▄ ▄    ▄   ▄ ▄▄▄▄  ▄   ▄  ▄▄▄▄  ▄▄▄   ▄▄▄▄ ▄▄▄▄▄",
    "⣿⣿ █     █    ▀▄ ▄▀ █   █ █   █ █     █   █ █       █  ",
    "⠛⣿ █  ▄▄ █      █   █▄▄▄▀ █▀▀▀█ █     █▀▀▀█  ▀▀▀▄   █  ",
    "⣿⣿ ▀▄▄▄▀ ▀▄▄▄▄  ▀   ▀     ▀   ▀  ▀▄▄▄ ▀   ▀ ▄▄▄▄▀   ▀  ",
];

pub fn print(version: &str, tagline: &str) {
    let mut out = String::from("\n");
    for line in LOGO {
        let width = line.chars().count().max(1) as f64;
        out.push_str("  ");
        for (at, ch) in line.chars().enumerate() {
            let t = at as f64 / width;
            // #f0a04b → #ffd75c
            let (r, g, b) = (240.0 + 15.0 * t, 160.0 + 55.0 * t, 75.0 + 17.0 * t);
            out.push_str(&format!("\x1b[38;2;{};{};{}m{ch}", r as u8, g as u8, b as u8));
        }
        out.push_str("\x1b[0m\n");
    }
    out.push_str(&format!("\n  \x1b[2m{tagline} · v{version}\x1b[0m\n"));
    print!("{out}");
}
