import { test } from "node:test";
import assert from "node:assert/strict";

await import("../js/qr.js");
const QR = globalThis.TDCCQR;

const bin = (n, width) => n.toString(2).padStart(width, "0");
const SOLANA_URL =
  "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=20" +
  "&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" +
  "&reference=4Rf9mGD7FeYknun5JczX5nGLTfQuS1GRjNVfkEMKE92b" +
  "&label=TDCC&message=TDCC%20balance%20top-up&memo=order-20261029";

/* ---------- Independent reader used to cross-check generated symbols ---------- */

// Reads both copies of the format information (MSB first, per ISO figure 25).
function readFormat(m) {
  const n = m.length, b = (x, y) => (m[y][x] ? 1 : 0);
  let a = 0, c = 0;
  for (let x = 0; x <= 5; x++) a = (a << 1) | b(x, 8);
  a = (a << 1) | b(7, 8);
  a = (a << 1) | b(8, 8);
  a = (a << 1) | b(8, 7);
  for (let y = 5; y >= 0; y--) a = (a << 1) | b(8, y);
  for (let y = n - 1; y >= n - 7; y--) c = (c << 1) | b(8, y);
  for (let x = n - 8; x < n; x++) c = (c << 1) | b(x, 8);
  return [a, c];
}

// Function-module map built from the spec rules, separately from the encoder.
function functionMap(v) {
  const n = 17 + 4 * v;
  const f = Array.from({ length: n }, () => new Array(n).fill(false));
  const box = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = true;
  };
  box(0, 0, 9, 9); // finder + separator + format
  box(n - 8, 0, 8, 9);
  box(0, n - 8, 9, 8);
  for (let i = 0; i < n; i++) f[6][i] = f[i][6] = true;
  const al = QR._alignment(v), last = al.length - 1;
  al.forEach((cy, i) => al.forEach((cx, j) => {
    // skip the three positions covered by finder patterns
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    box(cx - 2, cy - 2, 5, 5);
  }));
  if (v >= 7) {
    box(n - 11, 0, 3, 6);
    box(0, n - 11, 6, 3);
  }
  return f;
}

// Unmasks, reads the zigzag, de-interleaves with the given block layout and
// returns the decoded byte-mode payload (also checks every block's EC bytes).
function decode(q, blocks /* [[count, dataLen], ...] */, ecLen) {
  const { modules: m, version: v, mask } = q;
  const n = m.length, f = functionMap(v);
  const masks = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const bits = [];
  let col = n - 1, dir = -1;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < n; i++) {
      const y = dir < 0 ? n - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (f[y][x]) continue;
        bits.push((m[y][x] ? 1 : 0) ^ (masks[mask](x, y) ? 1 : 0));
      }
    }
    col -= 2;
    dir = -dir;
  }
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) cws.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const lens = blocks.flatMap(([count, len]) => new Array(count).fill(len));
  const data = lens.map(() => []), ec = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...lens); i++) lens.forEach((len, b) => { if (i < len) data[b].push(cws[k++]); });
  for (let i = 0; i < ecLen; i++) lens.forEach((_, b) => ec[b].push(cws[k++]));
  assert.equal(k, cws.length, "codeword count matches block layout");
  data.forEach((d, b) => assert.deepEqual(QR._rs(d, ecLen), ec[b], `EC of block ${b}`));
  const stream = data.flat().map((c) => bin(c, 8)).join("");
  assert.equal(stream.slice(0, 4), "0100", "byte mode indicator");
  const ccBits = v < 10 ? 8 : 16;
  const len = parseInt(stream.slice(4, 4 + ccBits), 2);
  const out = [];
  for (let i = 0; i < len; i++) out.push(parseInt(stream.slice(4 + ccBits + 8 * i, 12 + ccBits + 8 * i), 2));
  return new TextDecoder().decode(new Uint8Array(out));
}

/* ---------- Reference data ---------- */

test("Reed–Solomon matches the HELLO WORLD 1-Q example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(QR._rs(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format information matches the standard table", () => {
  const M = ["101010000010010", "101000100100101", "101111001111100", "101101101001011",
    "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
  const L = ["111011111000100", "111001011110011", "111110110101010", "111100010011101",
    "110011000101111", "110001100011000", "110110001000001", "110100101110110"];
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(bin(QR._formatBits("M", mask), 15), M[mask], `M/${mask}`);
    assert.equal(bin(QR._formatBits("L", mask), 15), L[mask], `L/${mask}`);
  }
  assert.equal(bin(QR._formatBits("Q", 0), 15), "011010101011111");
  assert.equal(bin(QR._formatBits("H", 0), 15), "001011010001001");
});

test("version information matches the standard table", () => {
  assert.equal(bin(QR._versionBits(7), 18), "000111110010010100");
  assert.equal(bin(QR._versionBits(8), 18), "001000010110111100");
  assert.equal(bin(QR._versionBits(40), 18), "101000110001101001");
});

test("alignment pattern centres match the standard table", () => {
  assert.deepEqual(QR._alignment(1), []);
  assert.deepEqual(QR._alignment(2), [6, 18]);
  assert.deepEqual(QR._alignment(7), [6, 22, 38]);
  assert.deepEqual(QR._alignment(15), [6, 26, 48, 70]);
  assert.deepEqual(QR._alignment(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(QR._alignment(40), [6, 30, 58, 86, 114, 142, 170]);
});

/* ---------- Structure ---------- */

function checkStructure(q, ecc) {
  const { size, version: v, modules: m } = q;
  assert.equal(size, 17 + 4 * v);
  assert.equal(m.length, size);
  for (const row of m) assert.equal(row.length, size);
  // Finder patterns and light separators at three corners.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const x = ox + dx, y = oy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const r = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(m[y][x], r <= 1 || r === 3, `finder module (${x},${y})`);
    }
  }
  // Timing patterns alternate, starting dark.
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `row timing ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `column timing ${i}`);
  }
  assert.equal(m[4 * v + 9][8], true, "dark module");
  // Alignment patterns.
  const al = QR._alignment(v), last = al.length - 1;
  al.forEach((cy, i) => al.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      assert.equal(m[cy + dy][cx + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `alignment (${cx},${cy})`);
  }));
  // Both format copies agree with the reported ecc/mask.
  const [a, b] = readFormat(m);
  assert.equal(a, QR._formatBits(ecc, q.mask), "format copy 1");
  assert.equal(b, QR._formatBits(ecc, q.mask), "format copy 2");
  // Version info copies.
  if (v >= 7) {
    let tr = 0, bl = 0;
    for (let i = 17; i >= 0; i--) {
      const a2 = size - 11 + (i % 3), c = Math.floor(i / 3);
      tr = (tr << 1) | (m[c][a2] ? 1 : 0);
      bl = (bl << 1) | (m[a2][c] ? 1 : 0);
    }
    assert.equal(tr, QR._versionBits(v), "version info top-right");
    assert.equal(bl, QR._versionBits(v), "version info bottom-left");
  }
  assert.ok(q.mask >= 0 && q.mask <= 7);
}

test("version 1 for a 14-byte string, decodes back", () => {
  const q = QR.matrix("HELLO, WORLD!!");
  assert.equal(q.version, 1);
  checkStructure(q, "M");
  assert.equal(decode(q, [[1, 16]], 10), "HELLO, WORLD!!");
});

test("version 7 structure, alignment at 6/22/38, version info, decodes", () => {
  const text = "x".repeat(110); // M capacity: v6 = 106, v7 = 122
  const q = QR.matrix(text);
  assert.equal(q.version, 7);
  checkStructure(q, "M");
  assert.equal(decode(q, [[4, 31]], 18), text);
});

test("capacity boundaries at M pick the smallest version", () => {
  const caps = { 9: 180, 10: 213, 11: 251, 12: 287 };
  for (const [v, cap] of Object.entries(caps)) {
    assert.equal(QR.matrix("a".repeat(cap)).version, Number(v), `${cap} bytes`);
    assert.equal(QR.matrix("a".repeat(cap + 1)).version, Number(v) + 1, `${cap + 1} bytes`);
  }
  assert.equal(QR.matrix("a".repeat(200)).version, 10);
  assert.equal(QR.matrix("a".repeat(260)).version, 12);
});

test("200 and 260 byte strings: structure and round trip", () => {
  const t200 = "0123456789abcdefghij".repeat(10);
  const q10 = QR.matrix(t200);
  checkStructure(q10, "M");
  assert.equal(decode(q10, [[4, 43], [1, 44]], 26), t200);
  const t260 = "Zz-~%/".repeat(43) + "ab";
  const q12 = QR.matrix(t260);
  assert.equal(q12.version, 12);
  checkStructure(q12, "M");
  assert.equal(decode(q12, [[6, 36], [2, 37]], 22), t260);
});

test("all ecc levels and versions 1–15 have correct structure", () => {
  // Byte capacities (ISO table 7) for L/M/Q/H at versions 1–15.
  const caps = {
    L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520],
    M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412],
    Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292],
    H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220],
  };
  for (const [ecc, list] of Object.entries(caps)) {
    list.forEach((cap, i) => {
      const q = QR.matrix("q".repeat(cap), { ecc });
      assert.equal(q.version, i + 1, `${ecc} ${cap} bytes`);
      checkStructure(q, ecc);
    });
  }
});

test("Solana Pay URL encodes and round-trips", () => {
  assert.ok(SOLANA_URL.length >= 220 && SOLANA_URL.length <= 260, `length ${SOLANA_URL.length}`);
  const q = QR.matrix(SOLANA_URL);
  checkStructure(q, "M");
  assert.equal(q.version, 11);
  assert.equal(decode(q, [[1, 50], [4, 51]], 30), SOLANA_URL);
});

test("UTF-8 text round-trips", () => {
  const text = "Ödeme — 20 TDCC ✓";
  const q = QR.matrix(text);
  assert.equal(decode(q, [[1, 28]], 16), text); // 2-M
});

test("svg output", () => {
  const s = QR.svg(SOLANA_URL, { title: 'Pay <TDCC> & "go"' });
  const n = QR.matrix(SOLANA_URL).size + 8;
  assert.match(s, new RegExp(`viewBox="0 0 ${n} ${n}"`));
  assert.match(s, /shape-rendering="crispEdges"/);
  assert.match(s, /role="img"/);
  assert.match(s, /<title>Pay &lt;TDCC&gt; &amp; &quot;go&quot;<\/title>/);
  assert.equal((s.match(/<path/g) || []).length, 1);
  assert.match(s, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
  assert.doesNotMatch(s.replace(/<rect[^>]*>/, ""), /\s(width|height)=/);
  assert.match(s, /fill="#06122a"/);
  const plain = QR.svg("hi", { margin: 2, dark: "#000", light: "#eee" });
  assert.match(plain, /viewBox="0 0 25 25"/);
  assert.doesNotMatch(plain, /<title>/);
  // Dark-module count in the path equals the matrix's dark count.
  const m = QR.matrix("hi").modules;
  const dark = m.flat().filter(Boolean).length;
  const area = [...plain.matchAll(/h(\d+)v1/g)].reduce((t, x) => t + Number(x[1]), 0);
  assert.equal(area, dark);
});

test("rejects bad input", () => {
  assert.throws(() => QR.matrix("x", { ecc: "Z" }), TypeError);
  assert.throws(() => QR.matrix("x".repeat(2954)), RangeError);
  assert.equal(QR.matrix("x".repeat(2953), { ecc: "L" }).version, 40);
});
