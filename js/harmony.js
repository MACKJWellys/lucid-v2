// Lucid — harmonic frame
// A slowly drifting pentatonic key. Tonal moments are gently retuned to land
// on scale tones; the felt piano answers in the same key.

export class Harmony {
  constructor() {
    this.scale = [0, 2, 4, 7, 9];                        // major pentatonic
    this.rootMidi = 55 + Math.floor(Math.random() * 5);  // G3..B3
  }

  shift() {
    // Move by a musically near key: down a fourth, up a fifth, or a step
    const moves = [-5, 7, 2, -2];
    this.rootMidi += moves[Math.floor(Math.random() * moves.length)];
    while (this.rootMidi < 50) this.rootMidi += 12;
    while (this.rootMidi > 62) this.rootMidi -= 12;
  }

  midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // A random scale tone within a midi offset range from the root
  randomToneHz(loOffset = 5, hiOffset = 24) {
    const span = [];
    for (let oct = -12; oct <= 36; oct += 12) {
      for (const deg of this.scale) {
        const off = oct + deg;
        if (off >= loOffset && off <= hiOffset) span.push(off);
      }
    }
    const off = span[Math.floor(Math.random() * span.length)] || 12;
    return this.midiToHz(this.rootMidi + off);
  }

  // Nearest scale tone (any octave) to a frequency, in log space
  nearestHz(hz) {
    if (!hz || hz <= 0) return this.midiToHz(this.rootMidi + 12);
    const midi = 69 + 12 * Math.log2(hz / 440);
    let best = null, bestDist = Infinity;
    const baseOct = Math.floor((midi - this.rootMidi) / 12);
    for (let oct = baseOct - 1; oct <= baseOct + 1; oct++) {
      for (const deg of this.scale) {
        const m = this.rootMidi + oct * 12 + deg;
        const d = Math.abs(m - midi);
        if (d < bestDist) { bestDist = d; best = m; }
      }
    }
    return this.midiToHz(best);
  }

  // A short melodic walk on the scale, returned as Hz values
  phrase(len, centerOffset = 17) {
    const degrees = [];
    for (let oct = 0; oct <= 24; oct += 12) for (const d of this.scale) degrees.push(oct + d);
    let idx = degrees.reduce((bi, d, i) =>
      Math.abs(d - centerOffset) < Math.abs(degrees[bi] - centerOffset) ? i : bi, 0);
    const out = [];
    for (let i = 0; i < len; i++) {
      out.push(this.midiToHz(this.rootMidi + degrees[idx]));
      const step = Math.random() < 0.65 ? (Math.random() < 0.5 ? -1 : 1)
        : (Math.random() < 0.5 ? -2 : 2);
      idx = Math.max(0, Math.min(degrees.length - 1, idx + step));
    }
    return out;
  }
}

// Autocorrelation pitch detection on a captured moment.
// Returns {hz, clarity} or null. clarity ~0..1 (normalized correlation).
export function detectPitch(samples, rate) {
  if (samples.length < 2048) return null;

  // Window centered on the loudest region
  const W = Math.min(4096, samples.length);
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peakVal) { peakVal = a; peakIdx = i; }
  }
  let start = Math.max(0, Math.min(peakIdx - (W >> 1), samples.length - W));

  // Mean-removed copy
  const x = new Float32Array(W);
  let mean = 0;
  for (let i = 0; i < W; i++) mean += samples[start + i];
  mean /= W;
  for (let i = 0; i < W; i++) x[i] = samples[start + i] - mean;

  const lagMin = Math.max(8, Math.floor(rate / 800));   // up to 800 Hz
  const lagMax = Math.min(W >> 1, Math.floor(rate / 70)); // down to 70 Hz
  const L = W - lagMax;
  if (L < 512) return null;

  let e0 = 0;
  for (let i = 0; i < L; i++) e0 += x[i] * x[i];
  if (e0 < 1e-9) return null;

  let bestLag = 0, bestR = 0;
  const corr = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0, eL = 0;
    for (let i = 0; i < L; i++) { r += x[i] * x[i + lag]; eL += x[i + lag] * x[i + lag]; }
    const norm = r / Math.sqrt(e0 * eL + 1e-12);
    corr[lag] = norm;
    if (norm > bestR) { bestR = norm; bestLag = lag; }
  }
  if (bestR < 0.5 || bestLag === 0) return null;

  // Prefer the smallest lag nearly as good as the best (avoids octave-down errors)
  for (let lag = lagMin; lag < bestLag; lag++) {
    if (corr[lag] > bestR * 0.92) { bestLag = lag; break; }
  }

  return { hz: rate / bestLag, clarity: bestR };
}
