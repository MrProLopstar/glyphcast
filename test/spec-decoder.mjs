// A second version 6 decoder, written from FORMAT.md alone: the test checks that the document describes the
// format completely and exactly.
const SIGNED = 18;
const C = { FRAME: 0, INTRA: 32, CBF: 35, MV: 41, RES: 77, RES_INTRA: 401, SKIP: 941, PATTERN: 944, DOT: 952, DARK_FLAG: 1976, DARK: 1979, END: 3515 };

/** Decodes a version 6 frame chunk following FORMAT.md, without any code from the library. */
export function decodeChunk(h, data) {
  let at = 0, frames = 0, scale = 1;
  for (;;) { const b = data[at++]; frames += (b & 127) * scale; scale *= 128; if (b < 128) break; }
  const bytes = data.subarray(at);
  let pos = 0; const next = () => bytes[pos++] ?? 0;
  let range = 0xffffffff, code = 0;
  for (let i = 0; i < 4; i++) code = code * 256 + next();
  const fast = new Uint16Array(C.END).fill(16384), slow = new Uint16Array(C.END).fill(16384);
  const norm = () => { while (range < 2 ** 24) { range *= 256; code = code * 256 + next(); } };
  const bit = (c) => {
    let p = (fast[c] + slow[c]) >> 5; if (p === 0) p = 1;
    const bound = (range >>> 11) * p; let b;
    if (code < bound) { range = bound; b = 0; } else { code -= bound; range -= bound; b = 1; }
    fast[c] = b ? fast[c] - (fast[c] >> 4) : fast[c] + ((32768 - fast[c]) >> 4);
    slow[c] = b ? slow[c] - (slow[c] >> 7) : slow[c] + ((32768 - slow[c]) >> 7);
    norm(); return b;
  };
  const direct = () => { range = range >>> 1; let b = 0; if (code >= range) { code -= range; b = 1; } norm(); return b; };
  const golomb = () => { let k = 0; while (direct()) k++; let rest = 0; for (let i = 0; i < k; i++) rest = rest * 2 + direct(); return 2 ** k - 1 + rest; };
  const unsigned = (g) => { for (let i = 0; i < 16; i++) if (!bit(g + i)) return i; return 16 + golomb(); };
  const signed = (g) => { if (!bit(g)) return 0; const neg = bit(g + 1); const size = unsigned(g + 2) + 1; return neg ? -size : size; };

  const { cols, rows } = h; const hc = Math.ceil(cols / 2), hr = Math.ceil(rows / 2);
  const blocksX = Math.ceil(cols / 8), blocks = blocksX * Math.ceil(rows / 4);
  const W = cols * 2, H = rows * 4;
  const cl = (v, m) => (v < 0 ? 0 : v >= m ? m - 1 : v);
  let ref = { y: new Uint8Array(cols * rows).fill(32), u: new Uint8Array(hc * hr).fill(16), v: new Uint8Array(hc * hr).fill(16) };
  let refMasks = new Uint8Array(cols * rows);
  let refDots = new Uint8Array(W * H).fill(32);
  const out = [];
  const steps = (t) => { const c = Math.round(t / 3); return { y: 2 * t + 1, u: 2 * c + 1, v: 2 * c + 1 }; };
  for (let f = 0; f < frames; f++) {
    const key = f === 0;
    const motionSteps = steps(unsigned(C.FRAME)), intraSteps = steps(unsigned(C.FRAME + 16));
    const cur = { y: new Uint8Array(cols * rows), u: new Uint8Array(hc * hr), v: new Uint8Array(hc * hr) };
    const masks = new Uint8Array(cols * rows), done = new Uint8Array(cols * rows);
    const vec = new Int16Array(blocks * 2), intraB = new Uint8Array(blocks), codedB = new Uint8Array(blocks), skipB = new Uint8Array(blocks);
    const nz = { y: new Uint8Array(cols * rows), u: new Uint8Array(hc * hr), v: new Uint8Array(hc * hr) };
    for (let b = 0; b < blocks; b++) {
      const bx = (b % blocksX) * 8, by = Math.floor(b / blocksX) * 4;
      const hasL = bx > 0, hasT = by > 0;
      const intra = key ? 1 : bit(C.INTRA + (hasL ? intraB[b - 1] : 0) + (hasT ? intraB[b - blocksX] : 0));
      intraB[b] = intra;
      let dx = 0, dy = 0;
      if (!intra) {
        const pred = [0, 1].map((k) => { const A = hasL ? vec[(b - 1) * 2 + k] : 0; const B = hasT ? vec[(b - blocksX) * 2 + k] : A; const Cc = hasT && bx + 8 < cols ? vec[(b - blocksX + 1) * 2 + k] : B; return Math.max(Math.min(A, B), Math.min(Math.max(A, B), Cc)); });
        dx = pred[0] + signed(C.MV); dy = pred[1] + signed(C.MV + 18);
      }
      vec[b * 2] = dx; vec[b * 2 + 1] = dy;
      const ycells = []; for (let y = by; y < Math.min(by + 4, rows); y++) for (let x = bx; x < Math.min(bx + 8, cols); x++) ycells.push([x, y]);
      if (h.detail) {
        const refDot = (x, y) => { x = cl(x, W); y = cl(y, H); return (refMasks[(y >> 2) * cols + (x >> 1)] >> ((y & 3) * 2 + (x & 1))) & 1; };
        const P = (x, y) => (key ? 0 : refDot(x + dx, y + dy));
        const predMask = (cx, cy) => { let m = 0; for (let d = 0; d < 8; d++) m |= P(cx * 2 + (d & 1), cy * 4 + (d >> 1)) << d; return m; };
        const skip = key ? 0 : bit(C.SKIP + (hasL ? skipB[b - 1] : 0) + (hasT ? skipB[b - blocksX] : 0));
        skipB[b] = skip;
        for (const [cx, cy] of ycells) {
          const cell = cy * cols + cx; const pm = predMask(cx, cy);
          if (skip) masks[cell] = pm;
          else {
            const guessed = pm ? 1 : 0;
            const lp = cx > 0 && masks[cell - 1] ? 1 : 0, tp = cy > 0 && masks[cell - cols] ? 1 : 0;
            let m = 0;
            if (bit(C.PATTERN + guessed + 2 * lp + 4 * tp)) {
              const D = (x, y, d) => { if (x < 0 || y < 0 || x >= W) return 0; const c2 = (y >> 2) * cols + (x >> 1); const bi = (y & 3) * 2 + (x & 1); if (c2 === cell) return bi < d ? (m >> bi) & 1 : 0; return done[c2] ? (masks[c2] >> bi) & 1 : 0; };
              for (let d = 0; d < 8; d++) { const x = cx * 2 + (d & 1), y = cy * 4 + (d >> 1);
                const ctx = P(x, y) | (P(x + 1, y) << 1) | (P(x, y + 1) << 2) | (D(x - 1, y, d) << 3) | (D(x, y - 1, d) << 4) | (D(x - 1, y - 1, d) << 5) | (D(x + 1, y - 1, d) << 6) | (D(x - 2, y, d) << 7) | (D(x, y - 2, d) << 8) | (guessed << 9);
                m |= bit(C.DOT + ctx) << d; }
            }
            masks[cell] = m;
          }
          done[cell] = 1;
        }
      }
      const coded = bit(C.CBF + 3 * intra + (hasL ? codedB[b - 1] : 0) + (hasT ? codedB[b - blocksX] : 0));
      codedB[b] = coded;
      const list = ycells.map(([x, y]) => ['y', x, y, cols]);
      for (const pl of ['u', 'v']) for (let y = by >> 1; y < Math.min((by + 4) >> 1, hr); y++) for (let x = bx >> 1; x < Math.min((bx + 8) >> 1, hc); x++) list.push([pl, x, y, hc]);
      const st = intra ? intraSteps : motionSteps;
      for (const [pl, x, y, w] of list) {
        const i = y * w + x, vals = cur[pl], pi = pl === 'y' ? 0 : pl === 'u' ? 1 : 2;
        const a = x > 0 ? vals[i - 1] : -1, bb = y > 0 ? vals[i - w] : -1, c = x > 0 && y > 0 ? vals[i - w - 1] : -1;
        let level = 0;
        if (coded) {
          const pat = pl === 'y' && masks[i] ? 1 : 0;
          if (intra) { const g = a < 0 || bb < 0 ? 2 : Math.abs(a - c) + Math.abs(bb - c); const cls = g === 0 ? 0 : g <= 2 ? 1 : g <= 6 ? 2 : g <= 14 ? 3 : 4; level = signed(C.RES_INTRA + ((pi * 5 + cls) * 2 + pat) * 18); }
          else { const around = (x > 0 ? nz[pl][i - 1] : 0) + (y > 0 ? nz[pl][i - w] : 0); level = signed(C.RES + ((pi * 3 + around) * 2 + pat) * 18); }
          if (level) nz[pl][i] = 1;
        }
        let pred;
        if (intra) pred = a < 0 && bb < 0 ? (pl === 'y' ? 32 : 16) : a < 0 ? bb : bb < 0 ? a : c >= Math.max(a, bb) ? Math.min(a, bb) : c <= Math.min(a, bb) ? Math.max(a, bb) : a + bb - c;
        else if (pl === 'y') { let s = 0, n = 0; const m = h.detail ? masks[i] : 0; for (let d = 0; d < 8; d++) { if (m && !((m >> d) & 1)) continue; s += refDots[cl(y * 4 + (d >> 1) + dy, H) * W + cl(x * 2 + (d & 1) + dx, W)]; n++; } pred = Math.floor((s + (n >> 1)) / n); }
        else { const x0 = x + (dx >> 2), y0 = y + (dy >> 3), fx = dx & 3, fy = dy & 7, R = ref[pl]; const g = (xx, yy) => R[cl(yy, hr) * hc + cl(xx, hc)]; pred = ((g(x0, y0) * (4 - fx) + g(x0 + 1, y0) * fx) * (8 - fy) + (g(x0, y0 + 1) * (4 - fx) + g(x0 + 1, y0 + 1) * fx) * fy + 16) >> 5; }
        vals[i] = Math.min(pl === 'y' ? 63 : 31, Math.max(0, pred + level * st[pl]));
      }
    }
    // RGB
    const rgb = new Uint8ClampedArray(cols * rows * 4);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const i = y * cols + x, hi = (y >> 1) * hc + (x >> 1); const yy = cur.y[i] * 255 / 63, u = (cur.u[hi] - 16) * 8.2, v = (cur.v[hi] - 16) * 8.2; rgb[i * 4] = yy + 1.402 * v; rgb[i * 4 + 1] = yy - 0.344136 * u - 0.714136 * v; rgb[i * 4 + 2] = yy + 1.772 * u; rgb[i * 4 + 3] = 255; }
    let shades = null;
    if (h.shades) {
      shades = new Uint8Array(cols * rows * 3);
      const flags = new Uint8Array(blocks);
      const lum = (i) => rgb[i * 4] * 0.299 + rgb[i * 4 + 1] * 0.587 + rgb[i * 4 + 2] * 0.114;
      for (let b = 0; b < blocks; b++) {
        const bx = (b % blocksX) * 8, by = Math.floor(b / blocksX) * 4; const pat = [];
        for (let y = by; y < Math.min(by + 4, rows); y++) for (let x = bx; x < Math.min(bx + 8, cols); x++) if (masks[y * cols + x]) pat.push(y * cols + x);
        if (!pat.length) continue;
        const flag = bit(C.DARK_FLAG + (bx > 0 ? flags[b - 1] : 0) + (by > 0 ? flags[b - blocksX] : 0)); flags[b] = flag;
        if (!flag) continue;
        for (const cell of pat) {
          const x = cell % cols, y = (cell - x) / cols, own = lum(cell); const near = [];
          if (x > 0) near.push(cell - 1); if (x < cols - 1) near.push(cell + 1); if (y > 0) near.push(cell - cols); if (y < rows - 1) near.push(cell + cols);
          const dark = near.filter((n) => lum(n) < own - 10);
          for (let ch = 0; ch < 3; ch++) {
            const guessFull = dark.length ? Math.floor(dark.reduce((s, n) => s + rgb[n * 4 + ch], 0) / dark.length) : rgb[cell * 4 + ch] >> 1;
            const guess = guessFull >> 5; let node = 1;
            for (let k = 0; k < 6; k++) node = node * 2 + bit(C.DARK + (ch * 8 + guess) * 64 + node);
            shades[cell * 3 + ch] = ((node - 64) << 2) | 2;
          }
        }
      }
    }
    out.push({ rgb, masks, shades });
    // dot brightness for the next frame
    const dots = new Uint8Array(W * H);
    for (let cell = 0; cell < cols * rows; cell++) { const x = cell % cols, y = (cell - x) / cols, v = cur.y[cell], m = masks[cell]; let dark = v;
      if (m) { let s = 0, n = 0; for (const [ok, nb] of [[x > 0, cell - 1], [x < cols - 1, cell + 1], [y > 0, cell - cols], [y < rows - 1, cell + cols]]) if (ok && cur.y[nb] < v - 3) { s += cur.y[nb]; n++; } dark = n ? Math.floor((s + (n >> 1)) / n) : v >> 1; }
      for (let d = 0; d < 8; d++) dots[(y * 4 + (d >> 1)) * W + x * 2 + (d & 1)] = !m || (m >> d) & 1 ? v : dark; }
    ref = cur; refMasks = masks; refDots = dots;
  }
  return out;
}

