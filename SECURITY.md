# Security

## Supported versions

Only the latest release of each part gets fixes: the npm/JSR package `glyphcast`, the `glyphcast` crate and `glc.exe`.

## Reporting a vulnerability

Please do not open a public issue. Use [Report a vulnerability](https://github.com/MrProLopstar/glyphcast/security/advisories/new) (private) or write to gosyar@gmail.com. You get an answer within a week; a fix for a confirmed issue ships as a patch release with credit, unless you prefer otherwise.

## Scope

Interesting:

- crashes, hangs or memory blow-ups of the decoders (`StreamReader`, `decodeChunk`, the Rust `Reader`/`decode_chunk`) on a crafted `.gcast`;
- `<glyph-player>` attributes or `.gcast` contents (titles, subtitles) that lead to script execution in the page;
- `glyphcast serve` and `glc telnet` reachable in ways they should not be, or reading files outside `--dir`;
- `glc login` / `glc publish` leaking the Google token.

Not in scope: the hub's content moderation, and denial of service by simply sending a large valid file.
