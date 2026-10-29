/*
 * TDCC QR — a small, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Byte mode (UTF-8) only, error correction L/M/Q/H, versions 1–40, automatic
 * smallest version, all 8 masks scored with the four penalty rules.
 *
 * Works as a classic <script> (sets window.TDCCQR) and as an ES-module import
 * in Node (`await import("./qr.js")`, then read globalThis.TDCCQR).
 *
 *   TDCCQR.matrix(text, { ecc })  -> { size, version, mask, modules[y][x] }
 *   TDCCQR.svg(text, { ecc, margin, dark, light, title }) -> "<svg …>"
 */
(function (root) {
  "use strict";

  /* ---------- GF(256) arithmetic, primitive polynomial x^8+x^4+x^3+x^2+1 ---------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; // avoids a "mod 255" in mul
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  // Generator polynomial g(x) = (x - a^0)(x - a^1)…(x - a^(n-1)), highest degree first.
  const genCache = {};
  function generator(n) {
    if (genCache[n]) return genCache[n];
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j]; // * x
        next[j + 1] ^= mul(g[j], EXP[i]); // * a^i  (minus == plus in GF(2^8))
      }
      g = next;
    }
    return (genCache[n] = g);
  }

  // Reed–Solomon EC codewords: remainder of data(x) * x^n divided by g(x),
  // computed as a shift register (g is monic, so the leading term drops out).
  function rs(data, n) {
    const g = generator(n);
    const rem = new Array(n).fill(0);
    for (const d of data) {
      const factor = d ^ rem.shift();
      rem.push(0);
      for (let j = 0; j < n; j++) rem[j] ^= mul(g[j + 1], factor);
    }
    return rem;
  }

  /* ---------- Error-correction tables (ISO/IEC 18004 Table 9), versions 1..40 ---------- */
  const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
  const FORMAT_ECC = [1, 0, 3, 2]; // 2-bit indicator for L, M, Q, H
  // EC codewords per block.
  const EC_PER_BLOCK = [
    [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  ];
  // Total number of RS blocks (group 1 + group 2).
  const BLOCKS = [
    [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
  ];

  /* ---------- BCH codes for format and version information ---------- */
  // Remainder of value * x^(deg g) modulo the generator polynomial `poly` (binary).
  function bchRemainder(value, poly) {
    const deg = 31 - Math.clz32(poly);
    let r = value << deg;
    while (31 - Math.clz32(r) >= deg) r ^= poly << (31 - Math.clz32(r) - deg);
    return r;
  }
  // 15-bit format string: 2 ECC bits + 3 mask bits, BCH(15,5), XOR 101010000010010.
  function formatBits(ecc, mask) {
    const data = (FORMAT_ECC[LEVELS[ecc]] << 3) | mask;
    return ((data << 10) | bchRemainder(data, 0x537)) ^ 0x5412;
  }
  // 18-bit version string: 6 version bits, BCH(18,6) with generator 0x1F25.
  function versionBits(v) {
    return (v << 12) | bchRemainder(v, 0x1f25);
  }

  // Alignment pattern centre coordinates: first is 6, last is size-7, the rest
  // evenly spaced by an even step (version 32 is the one irregular case).
  function alignmentPositions(v) {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2;
    const last = 4 * v + 10;
    const step = v === 32 ? 26 : Math.ceil((4 * v + 4) / (2 * n - 2)) * 2;
    const pos = [6];
    for (let i = n - 2; i >= 0; i--) pos.push(last - i * step);
    return pos;
  }

  /* ---------- Matrix construction ---------- */
  // Builds the function patterns for a version. `fn[y][x]` marks reserved
  // modules; the count of unreserved modules is the raw data capacity in bits.
  function template(v) {
    const size = 17 + 4 * v;
    const dark = [], fn = [];
    for (let y = 0; y < size; y++) {
      dark.push(new Uint8Array(size));
      fn.push(new Uint8Array(size));
    }
    const set = (x, y, d) => {
      dark[y][x] = d ? 1 : 0;
      fn[y][x] = 1;
    };

    // Finder patterns plus their one-module light separators. Chebyshev
    // distance from the centre: 0,1 dark core, 2 light, 3 dark ring, 4 separator.
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const r = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, r !== 2 && r !== 4);
        }
      }
    }

    // Alignment patterns at every pair of centres except the three that would
    // overlap the finders.
    const pos = alignmentPositions(v);
    const last = pos.length - 1;
    pos.forEach((cy, i) => pos.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));

    // Timing patterns on row 6 and column 6 (consistent with alignment overlap).
    for (let i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    drawFormat(dark, fn, size, 0); // reserve the format areas (real bits later)
    set(8, size - 8, true); // the "dark module" at (8, 4V+9)

    if (v >= 7) {
      // Version info: two 6x3 blocks, bottom-left and its transpose top-right.
      const bits = versionBits(v);
      for (let i = 0; i < 18; i++) {
        const d = (bits >> i) & 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(b, a, d);
        set(a, b, d);
      }
    }
    return { size, dark, fn };
  }

  // Writes the 15 format bits twice (bit 0 = LSB). Copy 1 wraps the top-left
  // finder; copy 2 is split between the top-right and bottom-left finders.
  function drawFormat(dark, fn, size, bits) {
    const set = (x, y, i) => {
      dark[y][x] = (bits >> i) & 1;
      fn[y][x] = 1;
    };
    for (let i = 0; i <= 5; i++) set(8, i, i);
    set(8, 7, 6);
    set(8, 8, 7);
    set(7, 8, 8);
    for (let i = 9; i < 15; i++) set(14 - i, 8, i);
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, i);
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  /* ---------- Penalty score (ISO/IEC 18004 section 7.8.3) ---------- */
  const FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function penalty(m, size) {
    let p = 0, darkCount = 0;
    const scoreLine = (line) => {
      // N1: each run of >= 5 same-coloured modules scores 3 + (run - 5).
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on one side;
      // the line is padded with light modules to stand in for the quiet zone.
      const s = [0, 0, 0, 0, ...line, 0, 0, 0, 0];
      for (let i = 0; i + 11 <= s.length; i++) {
        for (const pat of [FINDER_A, FINDER_B]) {
          let k = 0;
          while (k < 11 && s[i + k] === pat[k]) k++;
          if (k === 11) p += 40;
        }
      }
    };
    for (let y = 0; y < size; y++) {
      scoreLine(Array.from(m[y]));
      scoreLine(m.map((row) => row[y]));
      for (let x = 0; x < size; x++) {
        darkCount += m[y][x];
        // N2: every 2x2 block of one colour scores 3.
        if (x < size - 1 && y < size - 1) {
          const c = m[y][x];
          if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
        }
      }
    }
    // N4: 10 points per full 5% the dark proportion deviates from 50%.
    p += 10 * Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5);
    return p;
  }

  /* ---------- Encoding ---------- */
  function matrix(text, { ecc = "M" } = {}) {
    const lvl = LEVELS[ecc];
    if (lvl === undefined) throw new TypeError("ecc must be one of L, M, Q, H");
    const bytes = new TextEncoder().encode(String(text));

    // Pick the smallest version whose data capacity holds mode + count + bytes.
    let v, t, dataCw;
    for (v = 1; v <= 40; v++) {
      t = template(v);
      let raw = 0;
      for (const row of t.fn) for (const f of row) raw += f ? 0 : 1;
      t.raw = raw;
      dataCw = (raw >> 3) - EC_PER_BLOCK[lvl][v - 1] * BLOCKS[lvl][v - 1];
      if (4 + (v < 10 ? 8 : 16) + 8 * bytes.length <= dataCw * 8) break;
    }
    if (v > 40) throw new RangeError("Data too long for a QR code");

    // Bit stream: mode 0100 (byte), character count, data, terminator, padding.
    const bits = [];
    const put = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(0b0100, 4);
    put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
      data.push(b);
    }
    for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

    // Split into blocks: group 1 has the shorter blocks, group 2 one codeword more.
    const nb = BLOCKS[lvl][v - 1], ecLen = EC_PER_BLOCK[lvl][v - 1];
    const shortLen = Math.floor(dataCw / nb), numLong = dataCw % nb;
    const blocks = [];
    for (let b = 0, off = 0; b < nb; b++) {
      const len = shortLen + (b >= nb - numLong ? 1 : 0);
      const d = data.slice(off, off + len);
      off += len;
      blocks.push({ d, e: rs(d, ecLen) });
    }
    // Interleave: codeword i of every block in turn, data first, then EC.
    const codewords = [];
    for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) codewords.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) codewords.push(b.e[i]);

    // Place bits in two-column strips from the bottom-right, alternating
    // upward/downward, skipping column 6 (vertical timing) and reserved modules.
    // Leftover remainder bits (0–7) stay light.
    const { size, dark, fn } = t;
    let bit = 0, upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let k = 0; k < size; k++) {
        const y = upward ? size - 1 - k : k;
        for (let x = right; x >= right - 1; x--) {
          if (fn[y][x]) continue;
          const cw = codewords[bit >> 3];
          dark[y][x] = cw === undefined ? 0 : (cw >> (7 - (bit & 7))) & 1;
          bit++;
        }
      }
      upward = !upward;
    }

    // Try all 8 masks (with their format bits drawn) and keep the lowest penalty.
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = dark.map((row, y) => row.map((d, x) => (!fn[y][x] && MASKS[mask](x, y) ? d ^ 1 : d)));
      drawFormat(m, fn, size, formatBits(ecc, mask)); // fn already marks these
      const score = penalty(m, size);
      if (!best || score < best.score) best = { score, mask, m };
    }
    return {
      size,
      version: v,
      mask: best.mask,
      modules: best.m.map((row) => Array.from(row, (d) => d === 1)),
    };
  }

  const escapeXml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function svg(text, { ecc = "M", margin = 4, dark = "#06122a", light = "#ffffff", title } = {}) {
    const { size, modules } = matrix(text, { ecc });
    const n = size + 2 * margin;
    // One path: a unit-high rectangle per horizontal run of dark modules.
    let d = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; ) {
        if (!modules[y][x]) { x++; continue; }
        let run = 1;
        while (x + run < size && modules[y][x + run]) run++;
        d += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
        x += run;
      }
    }
    const a11y = title != null ? ` role="img"><title>${escapeXml(title)}</title>` : ' aria-hidden="true">';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"${a11y}` +
      `<rect width="${n}" height="${n}" fill="${escapeXml(light)}"/>` +
      `<path fill="${escapeXml(dark)}" d="${d}"/></svg>`
    );
  }

  root.TDCCQR = { matrix, svg, _rs: rs, _formatBits: formatBits, _versionBits: versionBits, _alignment: alignmentPositions };
})(typeof globalThis !== "undefined" ? globalThis : window);
