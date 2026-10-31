// Original soundtrack for the marketplace launch video (social/launch-video.html),
// synthesised from scratch so it carries no third-party rights.
// Usage: node social/launch-audio.mjs <out.wav>
// 128 BPM; the timeline (seconds) matches TIMELINE in launch-video.html.
import { writeFileSync } from "node:fs";

const SR = 48000;
const BPM = 128;
const BEAT = 60 / BPM;          // 0.46875 s
const BAR = BEAT * 4;           // 1.875 s
const T = {
  riser: 6 * BAR - 2 * BAR,     // 7.5
  drop: 6 * BAR,                // 11.25
  list: 8 * BAR,                // 15.0
  rent: 11 * BAR,               // 20.625
  machines: 14 * BAR,           // 26.25
  trust: 16 * BAR,              // 30.0
  release: 18 * BAR,            // 33.75
  token: 21 * BAR,              // 39.375
  end: 23 * BAR,                // 43.125
  total: 50,
};
const N = Math.ceil(T.total * SR);
const L = new Float32Array(N), R = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N);

// Seeded noise so every render is identical.
let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const add = (i, l, r = l, send = 0) => {
  if (i < 0 || i >= N) return;
  L[i] += l; R[i] += r;
  if (send) { sendL[i] += l * send; sendR[i] += r * send; }
};
const note = (n) => 440 * Math.pow(2, (n - 69) / 12);
const s = (t) => Math.floor(t * SR);

// ---------- instruments ----------

function kick(t0, gain = 1) {
  let ph = 0;
  for (let k = 0; k < s(0.5); k++) {
    const t = k / SR;
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 7.5);
    const click = k < 120 ? rnd() * 0.25 * (1 - k / 120) : 0;
    const v = (Math.sin(ph) * env + click) * 0.95 * gain;
    add(s(t0) + k, v);
  }
}

function clap(t0, gain = 1) {
  let hp = 0, prev = 0;
  for (let k = 0; k < s(0.35); k++) {
    const t = k / SR;
    const x = rnd();
    hp = 0.97 * (hp + x - prev); prev = x;
    // three quick bursts, then a tail
    const bursts = [0, 0.011, 0.023].reduce((a, o) => a + (t >= o ? Math.exp(-(t - o) * 180) : 0), 0);
    const env = bursts * 0.5 + Math.exp(-t * 14) * 0.6;
    const tone = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.3;
    const v = (hp * env + tone) * 0.38 * gain;
    add(s(t0) + k, v * 0.9, v, 0.35);
  }
}

function hat(t0, gain = 1, open = false) {
  let hp = 0, prev = 0;
  const len = open ? 0.22 : 0.05;
  for (let k = 0; k < s(len); k++) {
    const t = k / SR;
    const x = rnd();
    hp = 0.6 * (hp + x - prev); prev = x;
    const v = hp * Math.exp(-t * (open ? 16 : 75)) * 0.16 * gain;
    add(s(t0) + k, v * 0.8, v);
  }
}

// Sub boom + noise burst + shimmer, the "impact" on big reveals.
function impact(t0, gain = 1) {
  let ph = 0, lp = 0;
  for (let k = 0; k < s(3.2); k++) {
    const t = k / SR;
    const f = 32 + 70 * Math.exp(-t * 6);
    ph += (2 * Math.PI * f) / SR;
    const boom = Math.sin(ph) * Math.exp(-t * 1.6) * 0.9;
    lp += 0.08 * (rnd() - lp);
    const noise = lp * Math.exp(-t * 4) * 1.4;
    const shimmer = (Math.sin(2 * Math.PI * 1760 * t) + Math.sin(2 * Math.PI * 2637 * t)) * Math.exp(-t * 2.2) * 0.03;
    const v = (boom + noise + shimmer) * gain;
    add(s(t0) + k, v, v, 0.5);
  }
}

// Filtered-noise sweep plus a rising tone into the drop.
function riser(t0, t1, gain = 1) {
  const len = s(t1 - t0);
  let bp1 = 0, bp2 = 0, ph = 0;
  for (let k = 0; k < len; k++) {
    const p = k / len;
    const fc = 200 * Math.pow(40, p);
    const g = Math.tan((Math.PI * Math.min(fc, 16000)) / SR);
    const x = rnd();
    // simple state-variable band pass
    const hp = x - bp1 * 0.6 - bp2;
    bp1 += g * hp; bp2 += g * bp1;
    ph += (2 * Math.PI * (110 * Math.pow(8, p))) / SR;
    const tone = (2 * ((ph / (2 * Math.PI)) % 1) - 1) * 0.05 * p;
    const env = Math.pow(p, 2.2);
    const v = (bp1 * 0.5 + tone) * env * gain;
    const pan = Math.sin(p * 30) * 0.3 * p;
    add(s(t0) + k, v * (1 - pan), v * (1 + pan), 0.4);
  }
}

// Reverse swell: rising noise for a short build into a hit.
function swell(t0, t1, gain = 1) {
  const len = s(t1 - t0);
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const p = k / len;
    lp += (0.02 + 0.5 * p * p) * (rnd() - lp);
    const v = lp * Math.pow(p, 3) * 0.6 * gain;
    add(s(t0) + k, v, v, 0.5);
  }
}

// Warm detuned-saw pad with a one-pole low pass per voice.
function pad(t0, dur, notes, gain = 1, cutoff = 1200) {
  const len = s(dur);
  const voices = notes.flatMap((n) => [-0.08, 0.07].map((d) => ({ f: note(n + d), ph: Math.random() * 0 + n * 0.37, lp: 0 })));
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const env = Math.min(1, t / 0.6) * Math.min(1, (dur - t) / 0.8);
    let l = 0, r = 0;
    voices.forEach((v, j) => {
      v.ph += v.f / SR;
      const saw = 2 * (v.ph % 1) - 1;
      v.lp += a * (saw - v.lp);
      if (j % 2) r += v.lp; else l += v.lp;
    });
    const g = (0.055 * gain * env) / Math.sqrt(notes.length);
    add(s(t0) + k, l * g, r * g, 0.6);
  }
}

// Sub bass that ducks under every kick.
function bass(t0, dur, n, gain = 1, kicks = []) {
  const len = s(dur);
  let ph = 0, lp = 0;
  const f = note(n);
  for (let k = 0; k < len; k++) {
    const t = t0 + k / SR;
    ph += f / SR;
    const saw = 2 * (ph % 1) - 1;
    lp += 0.02 * (saw - lp);
    const sub = Math.sin(2 * Math.PI * ph);
    let duck = 1;
    for (const kt of kicks) if (t >= kt && t < kt + 0.25) duck = Math.min(duck, 0.15 + 0.85 * ((t - kt) / 0.25));
    const env = Math.min(1, (k / SR) / 0.01) * Math.min(1, (dur - k / SR) / 0.05);
    const v = (sub * 0.45 + lp * 0.35) * duck * env * gain;
    add(s(t0) + k, v);
  }
}

// Short UI blip (typing, clicks) and a success chime.
function blip(t0, f = 2400, gain = 1) {
  for (let k = 0; k < s(0.03); k++) {
    const t = k / SR;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 160) * 0.08 * gain;
    add(s(t0) + k, v * 0.7, v);
  }
}
function chime(t0, gain = 1) {
  [note(84), note(88), note(91)].forEach((f, j) => {
    for (let k = 0; k < s(1.2); k++) {
      const t = k / SR;
      const st = j * 0.06;
      if (t < st) continue;
      const v = Math.sin(2 * Math.PI * f * (t - st)) * Math.exp(-(t - st) * 4) * 0.06 * gain;
      add(s(t0) + k, v, v, 0.5);
    }
  });
}
function heartbeat(t0, gain = 1) {
  [0, 0.16].forEach((o, j) => {
    let ph = 0;
    for (let k = 0; k < s(0.4); k++) {
      const t = k / SR;
      ph += (2 * Math.PI * (55 - t * 30)) / SR;
      const v = Math.sin(ph) * Math.exp(-t * 12) * 0.5 * gain * (j ? 0.6 : 1);
      add(s(t0 + o) + k, v);
    }
  });
}

// ---------- arrangement ----------

// A minor: Am - F - C - G (MIDI roots)
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ROOT = [33, 29, 36, 31];

// Intro: dark pad and a heartbeat that speeds up.
pad(0, T.drop, [45, 52, 57, 60], 0.9, 700);
for (let t = 0.3; t < T.riser; t += BEAT * 2) heartbeat(t, 0.55 + 0.4 * (t / T.riser));
for (let t = T.riser; t < T.drop - BEAT; t += BEAT) heartbeat(t, 0.7);
riser(T.riser, T.drop, 1.1);
// Silence the last beat before the drop for contrast (a gap is applied in the master below).

// Main section: drums + bass + pad from the drop to the end card.
const kicks = [];
for (let t = T.drop; t < T.end; t += BEAT) {
  const beatIdx = Math.round((t - T.drop) / BEAT);
  // a breath before the release reveal
  if (t >= T.release - BEAT * 2 && t < T.release) continue;
  kick(t, 1); kicks.push(t);
  if (beatIdx % 2 === 1) clap(t, 1);
  hat(t + BEAT / 2, beatIdx % 4 === 3 ? 1.1 : 0.9, beatIdx % 8 === 7);
  if (t >= T.list) hat(t + BEAT / 4, 0.45), hat(t + (3 * BEAT) / 4, 0.45);
}
// rapid-fire trust section: claps on every beat
for (let t = T.trust; t < T.release - BEAT * 2; t += BEAT) clap(t + BEAT / 2, 0.6);
for (let bar = 0; T.drop + bar * BAR < T.end; bar++) {
  const t0 = T.drop + bar * BAR;
  const c = bar % 4;
  pad(t0, BAR + 0.05, PROG[c], 0.8, 1600);
  bass(t0, BAR, ROOT[c], 0.9, kicks);
}
impact(T.drop, 1.0);
swell(T.release - BEAT * 2, T.release, 1);
impact(T.release, 0.8);
riser(T.token - BAR, T.token, 0.7);
impact(T.token, 1.0);
impact(T.end, 0.9);
// Outro: final chord ringing out.
pad(T.end, T.total - T.end, [45, 52, 57, 60, 64], 1, 1100);
bass(T.end, 2.5, 33, 0.7);

// UI sounds for the product scenes (times match the visuals).
for (let i = 0; i < 34; i++) blip(T.list + 0.6 + i * 0.045, 2200 + (i % 3) * 300, 0.9);   // typing the link command
chime(T.list + 2.6, 1);                                                                    // "linked"
blip(T.rent + 2.2, 1800, 1.4); blip(T.rent + 2.26, 2600, 1);                               // click Rent
chime(T.rent + 3.4, 0.9);                                                                  // "Accepted"
for (let i = 0; i < 26; i++) blip(T.machines + 0.5 + i * 0.04, 2000 + (i % 4) * 200, 0.7); // ssh command

// ---------- master ----------

// Gap before the drop: everything but the riser tail fades out over the last beat.
const g0 = s(T.drop - BEAT), g1 = s(T.drop);
for (let i = g0; i < g1; i++) { const k = 1 - 0.85 * ((i - g0) / (g1 - g0)); L[i] *= k; R[i] *= k; }

// Schroeder reverb on the send bus.
function reverb(inp, out, delays, ap) {
  const combs = delays.map((d) => ({ buf: new Float32Array(d), i: 0, fb: 0.82, lp: 0 }));
  const alls = ap.map((d) => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < N; n++) {
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.7 + c.lp * 0.3;
      c.buf[c.i] = inp[n] + c.lp * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    y /= combs.length;
    for (const a of alls) {
      const o = a.buf[a.i];
      const v = y + o * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      y = o - v * 0.5;
    }
    out[n] += y * 0.9;
  }
}
reverb(sendL, L, [1557, 1617, 1491, 1422], [225, 556]);
reverb(sendR, R, [1580, 1640, 1514, 1445], [248, 579]);

// Final fade and soft clip, normalised to -1 dBFS.
const f0 = s(T.total - 3);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = i > f0 ? 1 - (i - f0) / (N - f0) : 1;
  L[i] = Math.tanh(L[i] * 1.2) * fade;
  R[i] = Math.tanh(R[i] * 1.2) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;

// 16-bit stereo WAV.
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), i * 4 + 2);
}
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
head.write("data", 36); head.writeUInt32LE(data.length, 40);
writeFileSync(process.argv[2] || "launch-audio.wav", Buffer.concat([head, data]));
console.log(`wrote ${T.total}s soundtrack`);
