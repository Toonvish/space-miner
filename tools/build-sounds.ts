// Procedural sound effects -> public/sounds/*.wav (mono, 22.05 kHz, 16-bit: PS2-era crunch).
// Usage: bun run sounds            (also writes spectrograms to tools/sound-previews/ if ffmpeg exists)
// Every sound is deterministic (seeded noise), so re-running produces identical files.
import { mkdirSync, writeFileSync } from "node:fs";

const SR = 22050;
type Buf = Float32Array;
type Fn = number | ((t: number) => number);
const val = (f: Fn, t: number) => (typeof f === "number" ? f : f(t));

// ---------------------------------------------------------------- primitives
let seed = 1;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const noise = () => rnd() * 2 - 1;
const n = (sec: number) => Math.round(sec * SR);
const buf = (sec: number) => new Float32Array(n(sec));

function white(sec: number): Buf {
  const b = buf(sec);
  for (let i = 0; i < b.length; i++) b[i] = noise();
  return b;
}

/** Brown-ish noise (leaky integrated white): deep rumbles. */
function brown(sec: number): Buf {
  const b = buf(sec);
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 0.985 + noise() * 0.15;
    b[i] = v;
  }
  return b;
}

/** Oscillator with an optionally time-varying frequency (phase-accumulated, so sweeps are clean). */
function osc(sec: number, freq: Fn, shape: "sin" | "saw" | "sqr" | "tri" = "sin"): Buf {
  const b = buf(sec);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    ph = (ph + val(freq, i / SR) / SR) % 1;
    b[i] = shape === "sin" ? Math.sin(ph * 2 * Math.PI)
      : shape === "saw" ? ph * 2 - 1
      : shape === "sqr" ? (ph < 0.5 ? 1 : -1)
      : 1 - 4 * Math.abs(ph - 0.5);
  }
  return b;
}

/** RBJ biquad; cutoff may sweep over time. */
function filt(x: Buf, type: "lp" | "hp" | "bp", f: Fn, q = 0.707): Buf {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = Math.min(Math.max(val(f, i / SR), 20), SR * 0.45);
    const w = (2 * Math.PI * fc) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    else if (type === "hp") { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; }
    const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Multiply by an envelope function of time. */
function env(x: Buf, e: (t: number) => number): Buf {
  for (let i = 0; i < x.length; i++) x[i] *= e(i / SR);
  return x;
}
const decay = (tau: number, attack = 0.002) => (t: number) => Math.min(1, t / attack) * Math.exp(-t / tau);

/** Add `src` into `dst` at `atSec` with gain. */
function mix(dst: Buf, src: Buf, gain = 1, atSec = 0): Buf {
  const o = n(atSec);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * gain;
  return dst;
}

function normalize(x: Buf, peak = 0.9): Buf {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** Short fade in/out so one-shots never click. */
function edges(x: Buf, inSec = 0.002, outSec = 0.02): Buf {
  const a = n(inSec), b = n(outSec);
  for (let i = 0; i < a && i < x.length; i++) x[i] *= i / a;
  for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** Seamless loop: equal-power crossfade of the tail into the head. */
function loopify(x: Buf, fadeSec: number): Buf {
  const f = n(fadeSec), len = x.length - f;
  const y = x.slice(0, len);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    y[i] = x[i] * Math.sin((k * Math.PI) / 2) + x[len + i] * Math.cos((k * Math.PI) / 2);
  }
  return y;
}

/** Inharmonic metallic ring (struck plate). */
function metal(sec: number, base: number, tau: number): Buf {
  const out = buf(sec);
  [1, 2.57, 4.93, 7.8].forEach((r, k) => mix(out, env(osc(sec, base * r), decay(tau / (1 + k * 0.6))), 1 / (1 + k)));
  return out;
}

/** Heavy mechanical clunk: low thump + dull noise hit. */
function clunk(sec: number, pitch = 85): Buf {
  const out = env(osc(sec, (t) => pitch * (1 + 1.5 * Math.exp(-t * 40))), decay(0.09));
  mix(out, env(filt(white(sec), "lp", 700), decay(0.035)), 0.8);
  return out;
}

// ---------------------------------------------------------------- the sounds
const S: Record<string, () => Buf> = {
  // continuous engine rumble; playback rate + gain follow throttle at runtime
  engine_loop() {
    const d = 2.4;
    const out = filt(brown(d), "lp", 220);
    mix(out, filt(osc(d, 55, "saw"), "lp", 380), 0.35);
    mix(out, osc(d, 110), 0.18);
    mix(out, filt(white(d), "bp", 1400, 0.6), 0.05);
    mix(out, osc(d, 880), 0.012); // faint turbine whine
    return normalize(loopify(out, 0.4), 0.8);
  },
  // extra roar layered on top while boosting
  boost_loop() {
    const d = 2.4;
    const out = filt(white(d), "bp", 1800, 0.7);
    mix(out, filt(white(d), "bp", 650, 0.9), 0.8);
    mix(out, filt(brown(d), "lp", 160), 0.6);
    return normalize(loopify(out, 0.4), 0.8);
  },
  boost_start() {
    const d = 0.8;
    const out = env(filt(white(d), "bp", (t) => 350 + 3200 * Math.min(1, t / 0.45), 1.6), (t) => Math.min(1, t / 0.08) * Math.exp(-t / 0.3));
    mix(out, clunk(d, 60), 0.5);
    return normalize(edges(out), 0.85);
  },
  // mining laser: buzzy, amplitude-modulated; integer frequencies => exactly periodic over 1 s
  laser_loop() {
    const d = 2;
    const raw = osc(d, 220, "saw");
    mix(raw, osc(d, 222, "saw"), 0.7); // 2 Hz beating
    env(raw, (t) => 0.72 + 0.28 * Math.sin(2 * Math.PI * 30 * t));
    const out = filt(raw, "bp", 1300, 0.8);
    mix(out, osc(d, 1760), 0.12);
    mix(out, osc(d, 2640), 0.05);
    return normalize(out.slice(n(1)), 0.75); // second half: filter has settled, loops perfectly
  },
  // rock being cut: dense crackle + grind
  drill_hit_loop() {
    const d = 1.4;
    const clicks = buf(d);
    for (let k = 0; k < d * 140; k++) mix(clicks, env(white(0.012), decay(0.0025, 0.0003)), 0.4 + rnd() * 0.6, rnd() * d);
    const out = filt(clicks, "bp", 2600, 1.1);
    mix(out, env(filt(white(d), "lp", 320), (t) => 0.6 + 0.4 * Math.sin(t * 37) * Math.sin(t * 11)), 0.35);
    mix(out, filt(white(d), "hp", 4000), 0.05);
    return normalize(loopify(out, 0.3), 0.75);
  },
  explosion_small() { return explosion(1.3, 0.6); },
  explosion_large() { return explosion(2.8, 1.4); },
  ore_pickup() {
    const d = 0.24;
    const out = buf(d);
    const blip = (f: number, len: number) => {
      const b = env(osc(len, f), decay(0.05, 0.003));
      mix(b, env(osc(len, f * 3), decay(0.025, 0.003)), 0.12);
      return edges(b, 0.003, 0.01);
    };
    mix(out, blip(1320, 0.08), 0.8);
    mix(out, blip(1980, 0.19), 1, 0.05);
    return normalize(edges(out, 0.001), 0.6);
  },
  collect() {
    const d = 0.8;
    const out = buf(d);
    [880, 988, 1175, 1319, 1568, 1760].forEach((f, k) => mix(out, env(osc(0.3, f, "tri"), decay(0.08)), 0.8, k * 0.07));
    return normalize(edges(out), 0.65);
  },
  dock() {
    const d = 1.2;
    const out = clunk(d, 80);
    mix(out, metal(d, 520, 0.35), 0.18);
    mix(out, edges(env(filt(white(0.9), "hp", 2600), (t) => Math.min(1, t / 0.05) * Math.exp(-t / 0.25)), 0.002, 0.25), 0.3, 0.15);
    mix(out, clunk(0.3, 120), 0.5, 0.85); // locking clamps
    return normalize(edges(out), 0.85);
  },
  undock() {
    const d = 1.0;
    const out = env(filt(white(d), "hp", 2200), (t) => Math.min(1, t / 0.03) * Math.exp(-t / 0.22));
    mix(out, clunk(0.4, 110), 0.6, 0.04);
    mix(out, env(osc(0.5, (t) => 260 + 500 * t), (t) => Math.sin(Math.min(1, t / 0.5) * Math.PI) * 0.8), 0.25, 0.35);
    return normalize(edges(out), 0.8);
  },
  build() {
    const d = 1.9;
    const out = buf(d);
    [0, 0.24, 0.48].forEach((t, k) => {
      mix(out, metal(0.6, 300 + k * 37, 0.22), 0.5, t);
      mix(out, clunk(0.3, 95 + k * 10), 0.5, t);
    });
    [523, 659, 784, 1047].forEach((f, k) => mix(out, env(osc(0.6, f, "tri"), decay(0.18)), 0.35, 0.85 + k * 0.11));
    return normalize(edges(out), 0.85);
  },
  deploy() {
    const d = 1.25;
    const out = buf(d);
    const servo = env(filt(osc(0.8, (t) => 170 + 520 * t, "saw"), "lp", 1300), (t) => (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 40)) * Math.min(1, t / 0.05) * (t < 0.72 ? 1 : (0.8 - t) / 0.08));
    mix(out, servo, 0.35);
    mix(out, clunk(0.4, 100), 0.8, 0.8);
    mix(out, env(osc(0.3, 1200), decay(0.08)), 0.15, 0.92);
    return normalize(edges(out), 0.8);
  },
  collision() {
    const d = 0.55;
    const out = clunk(d, 65);
    mix(out, metal(d, 430, 0.2), 0.25);
    return normalize(edges(out), 0.85);
  },
  cargo_full() {
    const d = 0.55;
    const out = buf(d);
    for (const t of [0, 0.24]) mix(out, edges(filt(osc(0.14, 740, "sqr"), "lp", 2500), 0.004, 0.015), 0.5, t);
    return normalize(edges(filt(out, "lp", 3000)), 0.55);
  },
  notify() {
    const d = 0.5;
    const out = env(osc(d, 988, "tri"), decay(0.12));
    mix(out, env(osc(0.38, 1319, "tri"), decay(0.15)), 1, 0.11);
    return normalize(edges(out), 0.5);
  },
  ui_click() {
    const out = env(osc(0.05, 1800), decay(0.008, 0.0005));
    mix(out, env(white(0.05), decay(0.002, 0.0002)), 0.3);
    return normalize(edges(out, 0.0005, 0.005), 0.45);
  },
  ui_deny() {
    const d = 0.3;
    const out = buf(d);
    for (const t of [0, 0.14]) mix(out, edges(filt(osc(0.1, 150, "sqr"), "lp", 1200), 0.004, 0.015), 0.6, t);
    return normalize(edges(out), 0.5);
  },
};

function explosion(d: number, size: number): Buf {
  const out = env(osc(d, (t) => 110 * Math.exp(-t * 3) + 32), decay(0.28 * size, 0.004)); // thump
  mix(out, env(filt(white(d), "lp", (t) => 300 + 4200 * Math.exp(-t * 4 / size)), decay(0.32 * size, 0.003)), 0.9);
  mix(out, env(filt(brown(d), "lp", 150), decay(0.8 * size, 0.02)), 0.9); // rumble tail
  for (let k = 0; k < 30 * size; k++) { // debris crackle
    mix(out, env(filt(white(0.02), "bp", 1500 + rnd() * 2500, 2), decay(0.004)), 0.15 * rnd(), 0.08 + rnd() * d * 0.6);
  }
  return normalize(edges(out, 0.001, 0.1), 0.95);
}

// ---------------------------------------------------------------- output
function wav(x: Buf): Uint8Array {
  const data = new DataView(new ArrayBuffer(44 + x.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); data.setUint32(4, 36 + x.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, SR, true); data.setUint32(28, SR * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  str(36, "data"); data.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Uint8Array(data.buffer);
}

mkdirSync("public/sounds", { recursive: true });
mkdirSync("tools/sound-previews", { recursive: true });
const hasFfmpeg = Bun.spawnSync(["which", "ffmpeg"]).exitCode === 0;
let total = 0;
for (const [name, make] of Object.entries(S)) {
  seed = 1 + [...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7); // per-sound deterministic noise
  const data = wav(make());
  writeFileSync(`public/sounds/${name}.wav`, data);
  total += data.length;
  if (hasFfmpeg) {
    Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", `public/sounds/${name}.wav`,
      "-lavfi", "showspectrumpic=s=480x200:legend=0", `tools/sound-previews/${name}.png`]);
  }
  console.log(`${name.padEnd(16)} ${(data.length / 1024).toFixed(0).padStart(4)} KB`);
}
console.log(`total ${(total / 1024).toFixed(0)} KB`);
