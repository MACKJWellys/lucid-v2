// Lucid — synthesized texture palette
// Built-in sounds rendered at runtime: a felty muted piano (Karplus-Strong),
// leaves in wind, and a crunchy log/fire crackle. Non-identifiable, quiet,
// and deliberately sparse in the mix.

export class TexturePalette {
  constructor(ctx) {
    this.ctx = ctx;
    this.pianoCache = new Map();
    this._leaves = null;
    this._crackles = [];
  }

  piano(hz) {
    const key = Math.round(hz * 2); // cache at half-Hz resolution
    if (!this.pianoCache.has(key)) {
      this.pianoCache.set(key, renderFeltPiano(this.ctx, hz));
      if (this.pianoCache.size > 40) {
        const first = this.pianoCache.keys().next().value;
        this.pianoCache.delete(first);
      }
    }
    return this.pianoCache.get(key);
  }

  leaves() {
    if (!this._leaves) this._leaves = renderLeaves(this.ctx);
    return this._leaves;
  }

  crackle() {
    if (this._crackles.length < 3) this._crackles.push(renderCrackle(this.ctx));
    return this._crackles[Math.floor(Math.random() * this._crackles.length)];
  }
}

// Felty muted piano: two slightly detuned Karplus-Strong strings with a
// soft lowpassed excitation and heavy damping — like a felted upright.
function renderFeltPiano(ctx, hz) {
  const rate = ctx.sampleRate;
  const dur = Math.min(4.5, 1.3 + 500 / hz); // lower notes ring longer
  const len = Math.floor(rate * dur);
  const out = new Float32Array(len);
  const t60 = dur * 0.85;

  for (const detune of [0.9985, 1.0015]) {
    const f = hz * detune;
    const N = Math.max(4, Math.round(rate / f));
    const d = new Float32Array(N);
    // Excitation: heavily lowpassed noise burst → soft, felty attack
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += 0.16 * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * 2.2;
    }
    const g = Math.pow(10, -3 * (N / rate) / t60); // per-loop decay for t60
    for (let n = 0; n < len; n++) {
      const idx = n % N;
      const next = (n + 1) % N;
      out[n] += d[idx] * 0.5;
      d[idx] = g * 0.5 * (d[idx] + d[next]);
    }
  }

  // Final tone shaping: one-pole lowpass keeps it muted; soft attack ramp
  const aLp = 1 - Math.exp(-2 * Math.PI * 2400 / rate);
  let lp2 = 0;
  for (let i = 0; i < len; i++) {
    lp2 += aLp * (out[i] - lp2);
    out[i] = lp2;
  }
  const atk = Math.floor(rate * 0.006);
  for (let i = 0; i < atk; i++) out[i] *= i / atk;
  const rel = Math.floor(rate * 0.25);
  for (let i = 0; i < rel; i++) out[len - 1 - i] *= i / rel;

  normalize(out, 0.5);
  const buf = ctx.createBuffer(1, len, rate);
  buf.copyToChannel(out, 0);
  return buf;
}

// Bright leaves in wind: high-passed noise under a slow wandering envelope
// with a light fast flutter.
function renderLeaves(ctx) {
  const rate = ctx.sampleRate;
  const dur = 8;
  const len = Math.floor(rate * dur);
  const out = new Float32Array(len);

  const aHp = 1 - Math.exp(-2 * Math.PI * 1400 / rate);
  const aLp = 1 - Math.exp(-2 * Math.PI * 7500 / rate);
  let lpA = 0, lpB = 0;

  // Slow envelope: retargeted random walk; flutter: smoothed fast noise
  let env = 0, envTarget = 0.4, nextRetarget = 0;
  const aEnv = 1 - Math.exp(-2 * Math.PI * 0.7 / rate);
  let flut = 0;
  const aFlut = 1 - Math.exp(-2 * Math.PI * 10 / rate);

  for (let i = 0; i < len; i++) {
    if (i >= nextRetarget) {
      envTarget = Math.pow(Math.random(), 1.6);
      nextRetarget = i + Math.floor(rate * (0.3 + Math.random() * 0.9));
    }
    env += aEnv * (envTarget - env);
    flut += aFlut * (Math.random() - flut);

    const white = Math.random() * 2 - 1;
    lpA += aHp * (white - lpA);            // track lows…
    const hp = white - lpA;                // …and remove them
    lpB += aLp * (hp - lpB);               // tame the very top
    out[i] = lpB * env * (0.65 + 0.7 * flut);
  }

  // Long edge fades so it can drift in and out
  const fade = Math.floor(rate * 1.2);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[len - 1 - i] *= g;
  }
  normalize(out, 0.35);
  const buf = ctx.createBuffer(1, len, rate);
  buf.copyToChannel(out, 0);
  return buf;
}

// Crunchy log crackle: sparse resonant micro-impulses, denser at the start,
// like wood settling.
function renderCrackle(ctx) {
  const rate = ctx.sampleRate;
  const dur = 3.5;
  const len = Math.floor(rate * dur);
  const out = new Float32Array(len);
  const events = 50 + Math.floor(Math.random() * 50);

  for (let e = 0; e < events; e++) {
    const t = Math.floor(len * Math.pow(Math.random(), 1.35)); // cluster early
    const f = 160 + Math.random() * 720;
    const tau = (0.0025 + Math.random() * 0.009) * rate;
    const amp = 0.15 + 0.85 * Math.pow(Math.random(), 2);
    const span = Math.min(Math.floor(tau * 5), len - t - 1);
    const w = 2 * Math.PI * f / rate;
    for (let k = 0; k < span; k++) {
      out[t + k] += amp * Math.sin(w * k) * Math.exp(-k / tau);
    }
    if (t < len) out[t] += amp * 0.6 * (Math.random() * 2 - 1); // bite
  }

  const fade = Math.floor(rate * 0.15);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[len - 1 - i] *= g;
  }
  normalize(out, 0.4);
  const buf = ctx.createBuffer(1, len, rate);
  buf.copyToChannel(out, 0);
  return buf;
}

function normalize(arr, target) {
  let peak = 0;
  for (let i = 0; i < arr.length; i++) peak = Math.max(peak, Math.abs(arr[i]));
  if (peak < 1e-9) return;
  const g = target / peak;
  for (let i = 0; i < arr.length; i++) arr[i] *= g;
}
