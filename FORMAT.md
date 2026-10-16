# The .gcast format, version 6

`.gcast` stores video as a grid of character cells: every cell has a color and, optionally, a pattern of 2×4 dots
(the dots of a braille character). Players draw the grid with glyphs, braille dots or blocks, on a GPU or in a text
terminal. This document describes version 6 completely enough to write a decoder. It is frozen: files written as
version 6 will play in every later version of glyphcast. Older versions (3–5) are described briefly at the end.

All numbers are little-endian. `u8`, `u16`, `u32` are unsigned integers, `f32` and `f64` IEEE floats.

## File layout

```
header (20 bytes)
chunk*
```

A finished file is ordered: header, subtitles chunk (optional), audio chunks (optional), frame chunks, index chunk.
A live stream is the header followed by frame chunks as they are produced, without an index.

### Header

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | magic `0x54534347` (bytes `G C S T`) |
| 4 | u8 | version: `6` |
| 5 | u8 | flags: bits 0–5 threshold (0–63), bit 6 `shades`, bit 7 `detail` |
| 6 | u16 | `cols`: cells across (1–4096) |
| 8 | u16 | `rows`: cells down (1–4096) |
| 10 | f32 | `fps`: frames per second (0 < fps ≤ 240) |
| 14 | u16 | `chunkFrames`: nominal frames per chunk (chunks may be shorter) |
| 16 | u32 | `frameCount`: total frames, 0 when unknown (live) |

`detail` means frames carry dot masks. `shades` (only with `detail`) means frames may carry the color of the dark
dots of patterned cells. `threshold` is the default quantizer of the stream (frames name their own, see below).

### Chunks

```
u32 size      bytes of data
u16 kind      what the chunk holds
u8[size] data
```

| `kind` | Chunk |
|---|---|
| 1–65519 (`0x0001`–`0xffef`) | frames: `kind` is the number of frames in the chunk |
| 0 | a piece of the embedded audio file |
| `0xfff0`–`0xfffd` | reserved for extensions: readers must skip them |
| `0xfffe` | subtitles: WebVTT or SRT text, UTF-8 |
| `0xffff` | the index |

**Audio.** The audio file (Ogg Opus, WebM Opus, M4A or MP3, told apart by its signature) is split into pieces of at
most 64 KiB, stored in order before the first frame chunk. Concatenated, they are the original file. Players use it as
the clock and may read only the part around the playback time with range requests.

**Index.** The last chunk of a finished file. Its data is one 16-byte entry per frame chunk followed by an 8-byte
trailer:

```
entry:   f64 offset (of the chunk's 6-byte head, from the start of the file), u32 first frame, u32 frames
trailer: u32 length of the whole index chunk including its 6-byte head, u32 0x58444947 ("GIDX")
```

So the last 8 bytes of a file tell whether it has an index and how long it is; a player reads them, then the index,
then only the chunks it needs.

**Frame chunks** are independent: each starts with a key frame and fresh coding state, so decoding can start at any
of them. Their data is described next.

## Frame chunk data

```
LEB128 frames   number of frames (equal to the chunk's kind)
range-coded frames
```

LEB128: 7 bits per byte, least significant first, bit 7 set on every byte but the last.

### The picture of a frame

A frame consists of:

- `Y`: brightness, `cols × rows` values 0–63;
- `U`, `V`: color, one value 0–31 per 2×2 cells, `ceil(cols/2) × ceil(rows/2)` each;
- with `detail`, `M`: one mask byte per cell. Bit `y·2 + x` stands for the dot in column `x` (0–1) and row `y`
  (0–3) of the cell. 0 means a flat cell. In a patterned cell `Y`, `U` and `V` are the color of the lit dots.
- with `shades`, `S`: for patterned cells, RGB of the dark dots (0 means "not stored": players guess it, see
  *Dark sides*).

To RGB, per cell (`u`, `v` of the 2×2 group the cell is in):

```
y' = Y · 255 / 63,  u' = (U − 16) · 8.2,  v' = (V − 16) · 8.2
R = y' + 1.402 v'
G = y' − 0.344136 u' − 0.714136 v'
B = y' + 1.772 u'
```

computed in double precision and clamped and rounded as a `Uint8ClampedArray` store does (round half to even).

The grid is cut into **blocks** of 8×4 cells, numbered in raster order (`blocksX = ceil(cols/8)`). Inside a block,
cells are visited in raster order: first all `Y` cells of the block, then the `U` cells, then the `V` cells covering
it (columns `bx/2 … (bx+8)/2 − 1`, rows `by/2 … (by+4)/2 − 1`, clipped to the planes).

### Range coder

Binary arithmetic coding as in LZMA, with two probability estimates per context.

Decoder state: `range = 0xFFFFFFFF`, `code` = the first 4 bytes of the coded data, big-endian. (The encoder's first
output byte is always zero and is left out of the file.) Reading past the end yields zero bytes.

Each context keeps `fast` and `slow`, both starting at 16384 (of 32768). Its probability of a zero is
`p = (fast + slow) >> 5` (if that is 0, use 1), out of 2048.

```
decodeBit(context):
  bound = (range >>> 11) · p
  if code < bound: range = bound, bit = 0
  else: code −= bound, range −= bound, bit = 1
  fast += bit ? −(fast >> 4) : (32768 − fast) >> 4
  slow += bit ? −(slow >> 7) : (32768 − slow) >> 7
  while range < 2^24: range ·= 256, code = code · 256 + next byte
  return bit

decodeDirect():          an equiprobable bit
  range = range >>> 1
  bit = code ≥ range ? 1 : 0; if bit: code −= range
  normalize as above
```

**Numbers.**

- `unsigned(group)`: for `i` = 0…15, read `decodeBit(group + i)`; on the first 0 the value is `i`. After sixteen 1s,
  the value is `16 + golomb()`.
- `golomb()`: count `k` direct 1-bits up to a 0 (more than 24 is an error), then read `k` direct bits as `rest`, most
  significant first; the value is `2^k − 1 + rest`.
- `signed(group)` (a group of 18 contexts): `decodeBit(group)` = 0 means 0. Otherwise `negative = decodeBit(group+1)`,
  `size = unsigned(group + 2) + 1`, value `negative ? −size : size`.

**Contexts.** All contexts of a chunk start fresh. `SIGNED = 18`.

| Name | First index | Count |
|---|---|---|
| FRAME | 0 | 32 |
| INTRA | 32 | 3 |
| CBF | 35 | 6 |
| MV | 41 | 2 × SIGNED |
| RES | 77 | 18 × SIGNED |
| RES_INTRA | 401 | 30 × SIGNED |
| SKIP | 941 | 3 |
| PATTERN | 944 | 8 |
| DOT | 952 | 1024 |
| DARK_FLAG | 1976 | 3 |
| DARK | 1979 | 1536 |

### Frames

Frames of a chunk are decoded in order. The first one is a **key frame**; the others are predicted from the frame
before them (the **reference**). Before the key frame, the reference is `Y` = 32, `U` = `V` = 16, masks 0.

Each frame starts with its quantizers:

```
threshold      = unsigned(FRAME)        0–63, for blocks predicted by motion
intraThreshold = unsigned(FRAME + 16)   0–63, for intra blocks (key frames are all intra)
```

and their steps: `step(Y) = 2t + 1`, `step(U) = step(V) = 2·round(t/3) + 1` (round half up) for each `t`.

Then every block, in order:

**1. Mode.** In a key frame every block is intra. Otherwise
`intra = decodeBit(INTRA + leftIntra + topIntra)`, where `leftIntra`, `topIntra` are 1 for an intra block to the
left or above (0 at the edges).

**2. Motion.** For a block that is not intra, a vector `(dx, dy)` in **dots** (a dot is half a cell across and a
quarter of a cell down). Its prediction is the component-wise median of the vectors of the left (A), top (B) and
top-right (C) blocks of this frame (intra blocks have vector 0), with the substitutions: no left block → A = 0; no top
block → B = A; no top-right block → C = B. `median = max(min(A, B), min(max(A, B), C))`.

```
dx = predictedX + signed(MV)
dy = predictedY + signed(MV + 18)
```

Both must lie in −64…63. Intra blocks have `dx = dy = 0`. (Players may use `round(dx/2)`, `round(dy/4)` in cells to
draw frames in between.)

**3. Masks** (only with `detail`). Prediction: for each cell, the mask of the reference shifted by `(dx, dy)` dots:
dot `d` of cell `(cx, cy)` is the reference dot at `(clamp(2cx + (d & 1) + dx), clamp(4cy + (d >> 1) + dy))`, clamped
to the dot grid `2·cols × 4·rows`. In a key frame the prediction is 0.

In other frames, `skip = decodeBit(SKIP + leftSkip + topSkip)`. If set, every cell of the block takes its predicted
mask. Otherwise each cell of the block (raster order) is decoded:

```
patterned = decodeBit(PATTERN + guessed + 2·leftPatterned + 4·topPatterned)
```

where `guessed` is 1 if the predicted mask is not 0, and `leftPatterned`, `topPatterned` tell whether the cell to the
left / above (in this frame) has a mask. If not patterned the mask is 0. Otherwise its 8 dots are decoded,
`d` = 0…7 at dot `(x, y) = (2cx + (d & 1), 4cy + (d >> 1))`:

```
context = P(x, y) | P(x+1, y) << 1 | P(x, y+1) << 2
        | D(x−1, y) << 3 | D(x, y−1) << 4 | D(x−1, y−1) << 5 | D(x+1, y−1) << 6
        | D(x−2, y) << 7 | D(x, y−2) << 8 | guessed << 9
bit d = decodeBit(DOT + context)
```

`P` is the predicted dot (the shifted reference as above; 0 in key frames). `D` is a dot of this frame: 0 outside
the grid on the left, top or right, 0 in cells whose masks are not decoded yet, and for the current cell only its
already decoded dots (those with a lower bit number) count.

**4. Residuals.** `coded = decodeBit(CBF + 3·intra + leftCoded + topCoded)`. Then for every cell of the block in
coding order (`Y`, then `U`, then `V`) a prediction, a level (0 if not `coded`) and the result
`clamp(prediction + level · step, 0, 63 for Y / 31 for U and V)`, using the intra or motion step.

Levels of **motion-predicted** blocks: `signed(RES + ((plane·3 + around)·2 + patterned)·18)`, `plane` 0/1/2 for
Y/U/V, `around` the number of cells to the left and above in the same plane of this frame with a nonzero level,
`patterned` 1 for a `Y` cell with a mask.

Levels of **intra** blocks: `signed(RES_INTRA + ((plane·5 + activity)·2 + patterned)·18)`, where for the
reconstructed left `a`, top `b` and top-left `c` values of the plane, `g = |a − c| + |b − c|` (`g = 2` when `a` or
`b` is missing), and the class is 0 for `g` = 0, 1 for ≤ 2, 2 for ≤ 6, 3 for ≤ 14, 4 above.

Predictions:

- **intra**, any plane: the median predictor of LOCO-I over the reconstructed cells of this frame: with only `b`,
  `b`; with only `a`, `a`; with neither, 32 for `Y` and 16 for `U`/`V`; otherwise `min(a, b)` if `c ≥ max(a, b)`,
  `max(a, b)` if `c ≤ min(a, b)`, else `a + b − c`.
- **motion, `Y`**: from the reference's dot brightness (below), shifted by `(dx, dy)`: the average of the 8 dots of
  the shifted cell, or, if the cell's mask (decoded in step 3) is not 0, of the dots it lights. Dot positions are
  clamped to the grid; the average is `floor((sum + floor(n/2)) / n)`.
- **motion, `U`/`V`**: bilinear in the reference plane at a quarter of a cell across and an eighth down:
  `x0 = x + (dx >> 2)`, `y0 = y + (dy >> 3)`, `fx = dx & 3`, `fy = dy & 7` (arithmetic shifts), positions clamped;
  `((a(4−fx) + b·fx)(8−fy) + (c(4−fx) + d·fx)·fy + 16) >> 5` for the values `a` at `(x0, y0)`, `b` at `(x0+1, y0)`,
  `c` at `(x0, y0+1)`, `d` at `(x0+1, y0+1)`.

**Dot brightness** of a decoded frame, used by the next frame: for a flat cell all 8 dots get its `Y`. For a
patterned cell the lit dots get its `Y` and the dark dots the average (rounded as above) of the `Y` of the left, right,
top and bottom cells whose `Y` is below `Y − 3`; with no such neighbor, `Y >> 1`.

**5. Dark sides** (only with `shades`), after all blocks of the frame. Convert the frame to RGB. For every block with
at least one patterned cell, `flag = decodeBit(DARK_FLAG + leftFlag + topFlag)` (flags of blocks without patterned
cells are 0). Without the flag, the dark sides of the block's cells are 0. With it, for each patterned cell in raster
order and each channel `ch` 0–2:

```
guess = the player's guess for the channel (below) >> 5
node = 1; repeat 6 times: node = node·2 + decodeBit(DARK + (ch·8 + guess)·64 + node)
dark = ((node − 64) << 2) | 2
```

The guess is the average (floored) of the RGB of the left, right, top and bottom cells whose luma
`0.299R + 0.587G + 0.114B` is below the cell's own luma minus 10; with no such neighbor, the cell's own color `>> 1`.
Players draw dark sides of 0 with the same kind of estimate.

## Older versions

- **3**: frames compressed with raw deflate; byte 5 bits 0–6 threshold, bit 7 detail.
- **4**: as 3, plus dark-side colors (`shades`).
- **5**: as 4, compressed with zstd; byte 5 bit 6 `shades`, bits 0–5 threshold.

They use 8×4 blocks with 15 whole-cell vectors and byte-aligned residuals; see `decodeChunkMotion` in
`src/format.ts`, which keeps reading them.
