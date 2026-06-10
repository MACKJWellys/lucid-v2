// Lucid — audio engine
// Listens to the environment, captures "moments", and recomposes them into
// an evolving soundscape. Two modes: Lucid (moment composer) and Liminal
// (forward/reverse time-smearing).

import { Harmony, detectPitch } from './harmony.js';
import { TexturePalette } from './textures.js';

// Compositional arc: sessions move through phases instead of being
// statistically uniform. density scales gesture rate; piano/texture are
// per-check probabilities; answer is the chance a tonal gesture gets a
// felt-piano reply.
const ARC = {
  arrival: { dur: [40, 55],   density: 0.6,  piano: 0.0,  texture: 0.08, answer: 0.0 },
  bloom:   { dur: [80, 120],  density: 1.0,  piano: 0.2,  texture: 0.18, answer: 0.3 },
  weave:   { dur: [100, 150], density: 1.3,  piano: 0.45, texture: 0.3,  answer: 0.5 },
  release: { dur: [45, 75],   density: 0.55, piano: 0.12, texture: 0.25, answer: 0.15 },
};
const ARC_NEXT = { arrival: 'bloom', bloom: 'weave', weave: 'release', release: 'bloom' };

// Every sound-producing layer. Each is toggleable in the UI, has its own
// level, and its own analyser for the per-layer spectrum view.
export const LAYER_DEFS = [
  { id: 'wash',     label: 'Wash',         hue: 210, desc: 'Your environment right now, softened and breathed into the reverb. The always-on presence.' },
  { id: 'reflex',   label: 'Reflex',       hue: 268, desc: 'An immediate shimmering answer to sounds just as they happen — the fastest layer.' },
  { id: 'echoes',   label: 'Echoes',       hue: 178, desc: 'Captured moments re-placed as patterns: slowing trails, bounces, clusters, reverses.' },
  { id: 'piano',    label: 'Felt piano',   hue: 46,  desc: 'A soft felted piano answering tonal sounds on the nearest note of the current key.' },
  { id: 'pad',      label: 'Harmonic bed', hue: 330, desc: 'A very quiet drone holding the current key under everything, so there is never true silence.' },
  { id: 'textures', label: 'Textures',     hue: 110, desc: 'Synthesized leaves-in-wind and wood crackle. Rare, quiet colour.' },
  { id: 'smear',    label: 'Time smear',   hue: 16,  desc: 'Liminal mode only: the last few seconds replayed slowed — forwards, then backwards.' },
];

export class LucidEngine {
  constructor() {
    this.ctx = null;
    this.workletNode = null;
    this.inputNode = null;
    this.mode = 'lucid';          // 'lucid' | 'liminal'
    this.intensity = 0.6;          // 0..1, scales density + wash level
    this.running = false;
    this.listeners = {};           // event callbacks

    // Analysis state mirrored from worklet
    this.level = { rms: 0, fast: 0, slow: 0, floor: 1e-3 };

    // Moment pool
    this.pool = [];                // {buffer, lane, gain, interest, born, lastUsed, uses, duration}
    this.poolMax = 18;
    this.extractPending = new Map();
    this.extractId = 0;
    this.lastCaptureAt = -10;

    // Composer state
    this.laneNext = { low: 0, mid: 0, high: 0 };
    this.restUntil = 0;
    this.nextRestCheck = 0;
    this.breathPhase = Math.random() * Math.PI * 2;
    this.breathPeriod = 60 + Math.random() * 30;

    // Liminal state
    this.liminalNextCapture = 0;

    // Layer mixer: enabled/level survive across start/stop; nodes are
    // rebuilt each session in buildGraph.
    this.layerState = {};
    for (const d of LAYER_DEFS) this.layerState[d.id] = { enabled: true, level: 1 };
    this.layers = {};

    // Reflex (immediate response) state
    this.lastReflexAt = -10;

    // Harmony, textures, arc
    this.harmony = new Harmony();
    this.arcSpeed = 1;             // >1 fast-forwards phases (debugging)
    this.arcPhase = 'arrival';
    this.arcUntil = 0;
    this.arcCycles = 0;
    this.nextTextureAt = 0;
    this.nextPianoAt = 0;

    this._tickTimer = null;
  }

  on(event, fn) { (this.listeners[event] ||= []).push(fn); }
  emit(event, data) { (this.listeners[event] || []).forEach(fn => fn(data)); }

  // ---------------------------------------------------------------- lifecycle

  async start(inputSource) {
    // inputSource: undefined → mic, or a function (ctx) => AudioNode (demo mode)
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // iOS 17+ audio session hint for simultaneous record + playback
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'play-and-record'; } catch (e) { /* non-fatal */ }
    }

    await this.ctx.audioWorklet.addModule('js/capture-processor.js');

    if (typeof inputSource === 'function') {
      this.inputNode = inputSource(this.ctx);
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.stream = stream;
      this.inputNode = this.ctx.createMediaStreamSource(stream);
    }

    this.buildGraph();

    this.workletNode = new AudioWorkletNode(this.ctx, 'lucid-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.workletNode.port.onmessage = (e) => this.onWorkletMessage(e.data);
    this.inputNode.connect(this.workletNode);
    // Keep worklet alive in graph without hearing it
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    this.workletNode.connect(sink).connect(this.ctx.destination);

    this.inputNode.connect(this.washIn);

    this.textures = new TexturePalette(this.ctx);
    this.arcPhase = 'arrival';
    this.arcUntil = this.ctx.currentTime + this.arcDur('arrival');
    this.nextTextureAt = this.ctx.currentTime + 20;
    this.nextPianoAt = this.ctx.currentTime + 15;

    this.running = true;
    this.startedAt = this.ctx.currentTime;
    this._tickTimer = setInterval(() => this.tick(), 250);
    this.applyMode();
    this.emit('state', 'running');
  }

  stop() {
    this.running = false;
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.pool = [];
    this.emit('state', 'stopped');
  }

  setMode(mode) {
    this.mode = mode;
    if (this.running) this.applyMode();
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
    if (this.running) this.applyMode();
  }

  setLayer(id, { enabled, level }) {
    const st = this.layerState[id];
    if (!st) return;
    if (enabled !== undefined) st.enabled = enabled;
    if (level !== undefined) st.level = level;
    this.applyLayer(id);
  }

  applyLayer(id) {
    const st = this.layerState[id];
    const L = this.layers[id];
    if (!L || !this.ctx) return;
    const g = st.enabled ? st.level : 0;
    const t = this.ctx.currentTime;
    L.dryBus.gain.setTargetAtTime(g, t, 0.15);
    L.wetBus.gain.setTargetAtTime(g, t, 0.15);
  }

  // ---------------------------------------------------------------- graph

  buildGraph() {
    const ctx = this.ctx;

    // Master: mix → soft limiter → out
    this.masterIn = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.masterOut = ctx.createGain();
    this.masterOut.gain.value = 0.9;
    this.masterIn.connect(this.limiter).connect(this.masterOut).connect(ctx.destination);

    // Reverb: generated stereo impulse, lush but not muddy
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1.0;
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(4.2, 2.6);
    const reverbHP = ctx.createBiquadFilter();
    reverbHP.type = 'highpass'; reverbHP.frequency.value = 180;
    this.reverbSend.connect(reverbHP).connect(this.convolver);
    const reverbOut = ctx.createGain(); reverbOut.gain.value = 0.85;
    this.convolver.connect(reverbOut).connect(this.masterIn);

    // Layer buses: every sound-producing layer gets a dry bus (→ master),
    // a wet bus (→ reverb), and an analyser tap for the spectrum view.
    for (const def of LAYER_DEFS) {
      const dryBus = ctx.createGain();
      const wetBus = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;
      dryBus.connect(this.masterIn);
      wetBus.connect(this.reverbSend);
      dryBus.connect(analyser);
      wetBus.connect(analyser);
      this.layers[def.id] = { dryBus, wetBus, analyser, hue: def.hue };
      this.applyLayer(def.id);
    }

    // Shimmer echo: filtered feedback delay, attributed to the echoes layer
    this.echoSend = ctx.createGain(); this.echoSend.gain.value = 1.0;
    this.echoDelay = ctx.createDelay(2.0);
    this.echoDelay.delayTime.value = 0.43;
    const echoFb = ctx.createGain(); echoFb.gain.value = 0.34;
    const echoHP = ctx.createBiquadFilter(); echoHP.type = 'highpass'; echoHP.frequency.value = 320;
    const echoLP = ctx.createBiquadFilter(); echoLP.type = 'lowpass'; echoLP.frequency.value = 5200;
    this.echoSend.connect(this.echoDelay);
    this.echoDelay.connect(echoHP).connect(echoLP).connect(echoFb).connect(this.echoDelay);
    const echoOut = ctx.createGain(); echoOut.gain.value = 0.5;
    echoLP.connect(echoOut);
    echoOut.connect(this.layers.echoes.dryBus);
    echoOut.connect(this.layers.echoes.wetBus);

    // Live wash: subtle real-time presence so the piece feels alive immediately.
    // Input → highpass → wash gain → phaser → echo + reverb (no dry path).
    this.washIn = ctx.createGain(); this.washIn.gain.value = 1.0;
    const washHP = ctx.createBiquadFilter(); washHP.type = 'highpass'; washHP.frequency.value = 260;
    this.washGain = ctx.createGain(); this.washGain.gain.value = 0.0;

    // Phaser: 4 modulated allpass stages (used gently in Lucid, strongly in Liminal)
    this.phaserStages = [];
    let phaserChainIn = ctx.createGain();
    let prev = phaserChainIn;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 400 + i * 350;
      ap.Q.value = 0.6;
      prev.connect(ap);
      prev = ap;
      this.phaserStages.push(ap);
    }
    this.phaserLFO = ctx.createOscillator();
    this.phaserLFO.frequency.value = 0.07;
    this.phaserDepth = ctx.createGain();
    this.phaserDepth.gain.value = 280;
    this.phaserLFO.connect(this.phaserDepth);
    this.phaserStages.forEach(ap => this.phaserDepth.connect(ap.frequency));
    this.phaserLFO.start();

    this.washIn.connect(washHP).connect(this.washGain).connect(phaserChainIn);
    prev.connect(this.layers.wash.wetBus);
    const washDirect = ctx.createGain(); washDirect.gain.value = 0.25;
    prev.connect(washDirect).connect(this.layers.wash.dryBus);

    this.buildPad();
  }

  // A very quiet harmonic drone holding the current key — the bed that
  // removes the "silence → jolt" contrast.
  buildPad() {
    const ctx = this.ctx;
    this.padOscs = [];
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.4;
    const lpLFO = ctx.createOscillator(); lpLFO.frequency.value = 0.045;
    const lpDepth = ctx.createGain(); lpDepth.gain.value = 260;
    lpLFO.connect(lpDepth).connect(lp.frequency);
    lpLFO.start();

    // Root (low), fifth, and a softly detuned root an octave up
    const defs = [
      { off: -12, type: 'triangle', g: 1.0, detune: 0 },
      { off: -5,  type: 'triangle', g: 0.55, detune: 3 },
      { off: 0,   type: 'sine',     g: 0.4, detune: -4 },
    ];
    for (const d of defs) {
      const o = ctx.createOscillator();
      o.type = d.type;
      o.frequency.value = this.harmony.midiToHz(this.harmony.rootMidi + d.off);
      o.detune.value = d.detune;
      const g = ctx.createGain(); g.gain.value = d.g;
      o.connect(g).connect(lp);
      o.start();
      this.padOscs.push({ osc: o, off: d.off });
    }
    lp.connect(this.padGain);
    const dry = ctx.createGain(); dry.gain.value = 0.45;
    this.padGain.connect(dry).connect(this.layers.pad.dryBus);
    this.padGain.connect(this.layers.pad.wetBus);
  }

  updatePadKey() {
    const t = this.ctx.currentTime;
    for (const p of this.padOscs) {
      p.osc.frequency.setTargetAtTime(
        this.harmony.midiToHz(this.harmony.rootMidi + p.off), t, 4);
    }
  }

  // Pad level breathes with the arc phase and overall ambient level
  updatePadLevel() {
    if (!this.padGain) return;
    const phaseMul = { arrival: 0.6, bloom: 1.0, weave: 1.0, release: 1.35 }[this.arcPhase] || 1;
    const base = 0.05 * (0.5 + this.intensity * 0.7) * phaseMul;
    this.padGain.gain.setTargetAtTime(base, this.ctx.currentTime, 3);
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        // Lowpass the noise progressively so the tail darkens naturally
        const a = 0.12 + 0.5 * (1 - i / len);
        lp += a * ((Math.random() * 2 - 1) - lp);
        ch[i] = lp * env;
      }
    }
    return buf;
  }

  applyMode() {
    const t = this.ctx.currentTime;
    const washBase = this.mode === 'liminal' ? 0.22 : 0.14;
    const wash = washBase * (0.4 + this.intensity * 0.9);
    this.washGain.gain.setTargetAtTime(wash, t, 0.8);
    this.updatePadLevel();
    this.phaserDepth.gain.setTargetAtTime(this.mode === 'liminal' ? 900 : 220, t, 1.0);
    this.phaserLFO.frequency.setTargetAtTime(this.mode === 'liminal' ? 0.11 : 0.05, t, 1.0);
    this.echoDelay.delayTime.setTargetAtTime(this.mode === 'liminal' ? 0.74 : 0.43, t, 0.5);
  }

  // ---------------------------------------------------------------- analysis

  onWorkletMessage(msg) {
    if (msg.type === 'level') {
      this.level = msg;
      this.adaptWash();
      this.emit('level', msg);
    } else if (msg.type === 'onset') {
      if (this.mode === 'lucid') {
        this.considerReflex(msg);
        this.considerCapture(msg);
      }
    } else if (msg.type === 'extracted') {
      const pending = this.extractPending.get(msg.id);
      this.extractPending.delete(msg.id);
      if (pending && msg.samples) pending(msg);
    }
  }

  adaptWash() {
    // Duck the live wash when the environment is loud so it doesn't smear
    if (!this.washGain) return;
    const loud = Math.min(1, this.level.slow / 0.05);
    const base = (this.mode === 'liminal' ? 0.22 : 0.14) * (0.4 + this.intensity * 0.9);
    this.washGain.gain.setTargetAtTime(base * (1 - loud * 0.7), this.ctx.currentTime, 0.6);
  }

  // Reflex: a fast shimmering answer to a sound just as it happens.
  // ~0.4s from the real-world sound to its reply — the connection layer.
  considerReflex(onset) {
    const now = this.ctx.currentTime;
    if (now - this.lastReflexAt < 1.8) return;
    if (!this.layerState.reflex.enabled) return;
    this.lastReflexAt = now;

    const rate = this.ctx.sampleRate;
    const durSamples = Math.floor(0.36 * rate);
    const startAbs = Math.max(0, onset.abs - Math.floor(0.06 * rate));
    setTimeout(() => {
      if (!this.running) return;
      const id = ++this.extractId;
      this.extractPending.set(id, (msg) => this.playReflex(msg.samples, msg.rate));
      this.workletNode.port.postMessage({ type: 'extract', id, startAbs, durSamples });
    }, 320);
  }

  playReflex(samples, rate) {
    const a = analyzeBuffer(samples, rate);
    if (a.peak < 0.004) return;
    let gain = Math.pow(0.09 / Math.max(a.rms, 1e-4), 0.55);
    gain = Math.min(gain, 8, 0.6 / a.peak);

    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(applyFades(samples, rate, 0.015, 0.12), 0);
    const L = this.layers.reflex;
    const t0 = ctx.currentTime + 0.04;
    const lvl = gain * (0.4 + this.intensity * 0.5);

    // The sound itself, soft and mostly wet…
    const plays = [
      { at: 0, rate: 1.0, g: 1.0, pan: Math.random() * 0.6 - 0.3 },
      // …then a sparkling fifth-up whisper just behind it
      { at: 0.28 + Math.random() * 0.15, rate: 1.5, g: 0.45, pan: Math.random() * 1.0 - 0.5 },
    ];
    for (const p of plays) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = p.rate;
      const env = ctx.createGain();
      const dur = buf.duration / p.rate;
      env.gain.setValueAtTime(0, t0 + p.at);
      env.gain.linearRampToValueAtTime(lvl * p.g, t0 + p.at + 0.03);
      env.gain.setTargetAtTime(0, t0 + p.at + dur * 0.6, dur * 0.2);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
      const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pn.pan) pn.pan.value = p.pan;
      src.connect(env).connect(hp).connect(pn);
      const dry = ctx.createGain(); dry.gain.value = 0.35;
      const verb = ctx.createGain(); verb.gain.value = 0.85;
      pn.connect(dry).connect(L.dryBus);
      pn.connect(verb).connect(L.wetBus);
      src.start(t0 + p.at);
    }
    this.emit('gesture', { lane: 'reflex', pattern: 'reply', repeats: 2, duration: buf.duration });
  }

  considerCapture(onset) {
    const now = this.ctx.currentTime;
    if (now - this.lastCaptureAt < 0.8) return;            // capture cooldown
    if (this.extractPending.size > 2) return;
    this.lastCaptureAt = now;

    const rate = this.ctx.sampleRate;
    const preroll = Math.floor(0.09 * rate);
    const dur = (0.45 + Math.random() * 1.5);              // 0.45–1.95s moments
    const durSamples = Math.floor(dur * rate) + preroll;
    const startAbs = Math.max(0, onset.abs - Math.floor(0.03 * rate) - preroll);

    // Wait until the moment has fully happened, then pull it from the ring
    setTimeout(() => {
      if (!this.running) return;
      const id = ++this.extractId;
      this.extractPending.set(id, (msg) => this.ingestMoment(msg.samples, msg.rate, onset));
      this.workletNode.port.postMessage({ type: 'extract', id, startAbs, durSamples });
    }, dur * 1000 + 80);
  }

  ingestMoment(samples, rate, onset) {
    const a = analyzeBuffer(samples, rate);
    if (a.peak < 0.004) return;                            // too quiet even for us

    // Partial loudness normalization: quiet, distant sounds get lifted so
    // they're audible, but keep some of their natural distance (exponent
    // < 1) so replays don't all jolt out at one loudness.
    const targetRms = 0.11;
    let gain = Math.pow(targetRms / Math.max(a.rms, 1e-4), 0.65);
    gain = Math.min(gain, 14, 0.8 / a.peak);               // peak safety

    const lane = a.lowRatio > 0.48 ? 'low' : (a.highRatio > 0.36 ? 'high' : 'mid');
    const interest = Math.min(10, onset.strength) * a.crest;

    // Is this moment tonal? If so the composer can retune it to the key
    // and the piano can answer it.
    const pitch = detectPitch(samples, rate);
    const tonal = !!(pitch && pitch.clarity > 0.62);

    const buffer = this.ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(applyFades(samples, rate, 0.03, 0.22), 0);

    const moment = {
      buffer, lane, gain, interest,
      tonal, pitchHz: tonal ? pitch.hz : 0,
      born: this.ctx.currentTime, lastUsed: -100, uses: 0,
      duration: samples.length / rate,
    };

    if (this.pool.length >= this.poolMax) {
      // Evict the least interesting of the three oldest
      const oldest = [...this.pool].sort((x, y) => x.born - y.born).slice(0, 3);
      const evict = oldest.sort((x, y) => x.interest - y.interest)[0];
      this.pool.splice(this.pool.indexOf(evict), 1);
    }
    this.pool.push(moment);
    this.emit('moment', {
      lane, interest, tonal, pitchHz: moment.pitchHz,
      duration: moment.duration, poolSize: this.pool.length,
    });
  }

  // ---------------------------------------------------------------- composer

  tick() {
    if (!this.running || !this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.mode === 'liminal') { this.tickLiminal(now); return; }

    this.updateArc(now);
    const arc = ARC[this.arcPhase];

    // Built-in textures and independent piano phrases, gated by arc phase
    if (now > this.nextTextureAt) {
      this.nextTextureAt = now + 18 + Math.random() * 30;
      if (Math.random() < arc.texture * (0.5 + this.intensity)) this.playTexture(now);
    }
    if (now > this.nextPianoAt) {
      this.nextPianoAt = now + 14 + Math.random() * 18;
      if (Math.random() < arc.piano * (0.5 + this.intensity)) this.playPianoPhrase(now);
    }

    // Breathing density: slow sinusoid + occasional deliberate rests
    const breath = 0.55 + 0.45 * Math.sin(this.breathPhase + (now / this.breathPeriod) * Math.PI * 2);
    if (now > this.nextRestCheck) {
      this.nextRestCheck = now + 18 + Math.random() * 22;
      if (Math.random() < 0.5) {
        this.restUntil = now + 2.5 + Math.random() * 4.5;
        this.emit('rest', { until: this.restUntil });
      }
    }
    if (now < this.restUntil) return;

    const density = breath * (0.45 + this.intensity * 1.1) * arc.density;

    for (const lane of ['high', 'mid', 'low']) {
      if (now < this.laneNext[lane]) continue;
      const moment = this.pickMoment(lane);
      if (!moment) { this.laneNext[lane] = now + 1.5; continue; }
      this.playGesture(moment, lane, now);
      const [lo, hi] = { high: [2.2, 6.5], mid: [3.5, 9.5], low: [8, 20] }[lane];
      const interval = (lo + Math.random() * (hi - lo)) / Math.max(0.25, density);
      this.laneNext[lane] = now + interval;
    }
  }

  pickMoment(lane) {
    const now = this.ctx.currentTime;
    let candidates = this.pool.filter(m => m.lane === lane && now - m.lastUsed > 6);
    if (!candidates.length && lane !== 'mid') {
      candidates = this.pool.filter(m => m.lane === 'mid' && now - m.lastUsed > 6);
    }
    if (!candidates.length) return null;
    // Weight by interest, freshness, and inverse use count
    let best = null, bestScore = -1;
    for (const m of candidates) {
      const freshness = Math.max(0.2, 1 - (now - m.born) / 240);
      const score = m.interest * freshness / (1 + m.uses * 0.4) * (0.5 + Math.random());
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  playGesture(moment, lane, now) {
    moment.lastUsed = now;
    moment.uses++;
    const t0 = now + 0.06;
    const pattern = choosePattern(lane);
    const events = buildPattern(pattern, lane, moment);

    // Harmonic retune: tonal moments land on scale tones. The adjustment is
    // small (≤ ~1.5 semitones) so the sound stays recognisably itself.
    if (moment.tonal) {
      for (const ev of events) {
        if (ev.glideTo) continue;                 // glides are deliberate sweeps
        const desired = moment.pitchHz * ev.rate;
        const target = this.harmony.nearestHz(desired);
        const retuned = ev.rate * (target / desired);
        if (retuned > 0.45 && retuned < 2.1) ev.rate = retuned;
      }
    }

    for (const ev of events) {
      this.playEvent(moment, t0 + ev.at, ev);
    }

    // Call-and-response: the felt piano answers what it just heard
    const arc = ARC[this.arcPhase];
    if (lane !== 'low' && Math.random() < arc.answer * (0.6 + this.intensity * 0.6)) {
      const last = events[events.length - 1];
      const answerAt = t0 + last.at + moment.duration / last.rate + 0.5 + Math.random() * 0.8;
      this.playPianoAnswer(moment, answerAt);
    }

    this.emit('gesture', { lane, pattern, repeats: events.length, duration: moment.duration, tonal: moment.tonal });
  }

  playEvent(moment, when, ev) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = ev.reverse ? reverseBuffer(ctx, moment.buffer) : moment.buffer;
    src.playbackRate.value = ev.rate;
    if (ev.glideTo) {
      src.playbackRate.setValueAtTime(ev.rate, when);
      src.playbackRate.linearRampToValueAtTime(ev.glideTo, when + moment.duration / ev.rate);
    }

    const env = ctx.createGain();
    const level = moment.gain * ev.gain * this.laneLevel(moment.lane);
    const durOut = (ev.slice ? ev.slice : moment.duration) / ev.rate;
    // Gentle swell in, long exponential release out — no on/off jolt.
    // Clusters keep snappy grains; everything else breathes.
    const atk = ev.slice ? 0.012 : Math.min(0.07 + Math.random() * 0.07, durOut * 0.3);
    const relTau = ev.slice ? 0.04 : Math.min(0.25, durOut * 0.25);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + atk);
    env.gain.setTargetAtTime(0, Math.max(when + atk, when + durOut - relTau * 1.5), relTau);

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (pan.pan) pan.pan.value = ev.pan;

    // Per-lane tone shaping
    let toneOut = env;
    if (moment.lane === 'low') {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
      env.connect(lp); toneOut = lp;
    } else if (moment.lane === 'high') {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      env.connect(hp); toneOut = hp;
    }

    src.connect(env);
    if (toneOut !== env) { /* already connected above */ }
    toneOut.connect(pan);

    // Dry + sends through the echoes layer: later repeats get wetter
    const L = this.layers.echoes;
    const dry = ctx.createGain(); dry.gain.value = 1 - ev.wet * 0.7;
    const verb = ctx.createGain(); verb.gain.value = 0.25 + ev.wet * 0.75;
    const echo = ctx.createGain(); echo.gain.value = ev.echo;
    pan.connect(dry).connect(L.dryBus);
    pan.connect(verb).connect(L.wetBus);
    pan.connect(echo).connect(this.echoSend);

    if (ev.slice) {
      const offset = Math.min(ev.offset || 0, Math.max(0, moment.duration - ev.slice));
      src.start(when, offset, ev.slice);
    } else {
      src.start(when);
    }
    src.stop(when + durOut + relTau * 6 + 0.1);
  }

  laneLevel(lane) {
    return { low: 0.7, mid: 1.0, high: 0.85 }[lane];
  }

  // ------------------------------------------------------------- arc & key

  arcDur(phase) {
    const [lo, hi] = ARC[phase].dur;
    return (lo + Math.random() * (hi - lo)) / this.arcSpeed;
  }

  updateArc(now) {
    if (now < this.arcUntil) return;
    this.arcPhase = ARC_NEXT[this.arcPhase];
    this.arcUntil = now + this.arcDur(this.arcPhase);
    this.updatePadLevel();
    if (this.arcPhase === 'bloom') {
      this.arcCycles++;
      if (this.arcCycles > 1) {
        this.harmony.shift();   // each new cycle settles in a neighbouring key
        this.emit('key', { rootMidi: this.harmony.rootMidi });
      }
    }
    this.emit('phase', this.arcPhase);
  }

  // --------------------------------------------------------- piano & textures

  playPianoNote(hz, when, vel, pan = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.textures.piano(hz);
    const g = ctx.createGain();
    g.gain.value = vel;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (p.pan) p.pan.value = pan;
    src.connect(g).connect(p);
    const dry = ctx.createGain(); dry.gain.value = 0.75;
    const verb = ctx.createGain(); verb.gain.value = 0.6;
    p.connect(dry).connect(this.layers.piano.dryBus);
    p.connect(verb).connect(this.layers.piano.wetBus);
    src.start(when);
  }

  playPianoPhrase(now) {
    const n = 2 + Math.floor(Math.random() * 3);
    const notes = this.harmony.phrase(n, 12 + Math.floor(Math.random() * 10));
    let t = now + 0.1;
    const basePan = Math.random() * 0.8 - 0.4;
    const vel = (0.10 + Math.random() * 0.08) * (0.5 + this.intensity * 0.8);
    for (const hz of notes) {
      this.playPianoNote(hz, t, vel * (0.85 + Math.random() * 0.3), basePan + (Math.random() * 0.3 - 0.15));
      t += 0.55 + Math.random() * 0.85;
    }
    this.emit('gesture', { lane: 'piano', pattern: 'phrase', repeats: n, duration: t - now });
  }

  playPianoAnswer(moment, when) {
    // The piano replies at the nearest scale tone to what it just heard,
    // sometimes adding the octave or a second voice.
    const heard = moment.tonal ? moment.pitchHz : 0;
    let hz = heard ? this.harmony.nearestHz(heard) : this.harmony.randomToneHz(12, 26);
    while (hz < 160) hz *= 2;          // keep answers out of the mud
    while (hz > 1400) hz /= 2;
    const vel = (0.12 + Math.random() * 0.07) * (0.5 + this.intensity * 0.8);
    const pan = Math.random() * 0.8 - 0.4;
    this.playPianoNote(hz, when, vel, pan);
    if (Math.random() < 0.35) {
      this.playPianoNote(hz * 2, when + 0.4 + Math.random() * 0.5, vel * 0.6, -pan);
    }
    this.emit('gesture', { lane: 'piano', pattern: 'answer', repeats: 1, duration: 2 });
  }

  playTexture(now) {
    const ctx = this.ctx;
    const kind = Math.random() < 0.55 ? 'leaves' : 'crackle';
    const buf = kind === 'leaves' ? this.textures.leaves() : this.textures.crackle();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;

    const level = (kind === 'leaves' ? 0.07 : 0.1) * (0.5 + this.intensity * 0.8);
    const g = ctx.createGain();
    const t0 = now + 0.1;
    const dur = buf.duration / src.playbackRate.value;
    const fade = kind === 'leaves' ? 2.0 : 0.4;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + fade);
    g.gain.setValueAtTime(level, t0 + dur - fade);
    g.gain.linearRampToValueAtTime(0, t0 + dur);

    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (p.pan) {
      const from = Math.random() * 1.2 - 0.6;
      p.pan.setValueAtTime(from, t0);
      p.pan.linearRampToValueAtTime(from * -0.5, t0 + dur);
    }
    src.connect(g).connect(p);
    const dry = ctx.createGain(); dry.gain.value = 0.6;
    const verb = ctx.createGain(); verb.gain.value = 0.5;
    p.connect(dry).connect(this.layers.textures.dryBus);
    p.connect(verb).connect(this.layers.textures.wetBus);
    src.start(t0);
    this.emit('gesture', { lane: 'texture', pattern: kind, repeats: 1, duration: dur });
  }

  // ---------------------------------------------------------------- liminal

  tickLiminal(now) {
    if (now < this.liminalNextCapture) return;
    this.liminalNextCapture = now + 5 + Math.random() * 4;
    if (this.level.slow < this.level.floor * 1.2 && this.level.slow < 4e-4) return; // nothing happening

    const rate = this.ctx.sampleRate;
    const dur = 2.4 + Math.random() * 0.9;
    const durSamples = Math.floor(dur * rate);
    const startAbs = Math.max(0, this.level.abs - durSamples);
    const id = ++this.extractId;
    this.extractPending.set(id, (msg) => this.playLiminal(msg.samples, msg.rate));
    this.workletNode.port.postMessage({ type: 'extract', id, startAbs, durSamples });
  }

  playLiminal(samples, rate) {
    const a = analyzeBuffer(samples, rate);
    if (a.peak < 0.003) return;
    const gain = Math.min(14, 0.45 / a.peak);

    const ctx = this.ctx;
    const fwd = ctx.createBuffer(1, samples.length, rate);
    fwd.copyToChannel(applyFades(samples, rate, 0.12), 0);
    const rev = reverseBuffer(ctx, fwd);

    const slow = 0.78;
    const segDur = (samples.length / rate) / slow;
    const overlap = 0.35;
    let t = ctx.currentTime + 0.1;
    const panStart = (Math.random() * 1.4 - 0.7);
    const segments = [
      { buf: fwd, g: 0.9, wet: 0.45 },
      { buf: rev, g: 0.75, wet: 0.65 },
      { buf: fwd, g: 0.5, wet: 0.85 },
      { buf: rev, g: 0.32, wet: 1.0 },
    ];
    segments.forEach((seg, i) => {
      const src = ctx.createBufferSource();
      src.buffer = seg.buf;
      src.playbackRate.value = slow;
      const env = ctx.createGain();
      const lvl = gain * seg.g * (0.5 + this.intensity * 0.6) * 0.55;
      const xf = 0.25;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(lvl, t + xf);
      env.gain.setValueAtTime(lvl, t + segDur - xf);
      env.gain.linearRampToValueAtTime(0, t + segDur);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) {
        pan.pan.setValueAtTime(panStart * (i % 2 === 0 ? 1 : -1), t);
        pan.pan.linearRampToValueAtTime(panStart * (i % 2 === 0 ? -0.3 : 0.3), t + segDur);
      }
      src.connect(env).connect(pan);
      const dry = ctx.createGain(); dry.gain.value = 1 - seg.wet * 0.8;
      const verb = ctx.createGain(); verb.gain.value = seg.wet;
      pan.connect(dry).connect(this.layers.smear.dryBus);
      pan.connect(verb).connect(this.layers.smear.wetBus);
      src.start(t);
      t += segDur - overlap;
    });
    this.emit('gesture', { lane: 'liminal', pattern: 'mirror', repeats: 4, duration: segDur });
  }
}

// ------------------------------------------------------------------ helpers

function analyzeBuffer(samples, rate) {
  // One-pole band split: low < ~400Hz, high > ~2kHz, mid between
  const aLow = 1 - Math.exp(-2 * Math.PI * 400 / rate);
  const aHigh = 1 - Math.exp(-2 * Math.PI * 2000 / rate);
  let lp400 = 0, lp2000 = 0;
  let eLow = 0, eMid = 0, eHigh = 0, peak = 0, sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    lp400 += aLow * (x - lp400);
    lp2000 += aHigh * (x - lp2000);
    const low = lp400, mid = lp2000 - lp400, high = x - lp2000;
    eLow += low * low; eMid += mid * mid; eHigh += high * high;
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    sumSq += x * x;
  }
  const total = eLow + eMid + eHigh + 1e-12;
  const rms = Math.sqrt(sumSq / samples.length);
  return {
    lowRatio: eLow / total,
    midRatio: eMid / total,
    highRatio: eHigh / total,
    peak,
    rms,
    crest: Math.min(8, peak / Math.max(rms, 1e-6)),
  };
}

function applyFades(samples, rate, inSec = 0.03, outSec = 0.2) {
  const out = samples; // in place is fine — we own the buffer
  const fi = Math.min(Math.floor(inSec * rate), Math.floor(samples.length / 3));
  const fo = Math.min(Math.floor(outSec * rate), Math.floor(samples.length / 2));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) {
    const g = i / fo;
    out[out.length - 1 - i] *= g * g;   // long, curved tail — no cliff of hiss
  }
  return out;
}

function reverseBuffer(ctx, buffer) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
  }
  return out;
}

function choosePattern(lane) {
  const r = Math.random();
  if (lane === 'low') return r < 0.6 ? 'solo' : 'pair';
  if (lane === 'mid') {
    if (r < 0.35) return 'solo';
    if (r < 0.70) return 'echoes';
    if (r < 0.90) return 'pair';
    return 'accel';
  }
  // high
  if (r < 0.25) return 'echoes';
  if (r < 0.45) return 'cluster';
  if (r < 0.60) return 'accel';
  if (r < 0.78) return 'pair';
  return 'solo';
}

function buildPattern(pattern, lane, moment) {
  const events = [];
  const basePan = Math.random() * 1.2 - 0.6;
  const maybeTransform = () => {
    const r = Math.random();
    if (lane === 'high' && r < 0.18) return { rate: Math.random() < 0.5 ? 1.5 : 2.0 };
    if (lane === 'mid' && r < 0.10) return { rate: 0.75 };
    if (lane === 'low' && r < 0.25) return { rate: 0.5 };
    if (r < 0.08) return { rate: 1.0, glideTo: Math.random() < 0.6 ? 1.45 : 0.7 };
    return { rate: 1.0 };
  };
  const reverse = (lane === 'mid' && Math.random() < 0.22) || (lane === 'high' && Math.random() < 0.12);
  const t = maybeTransform();

  const push = (at, gain, pan, wet, echo, extra = {}) =>
    events.push({ at, gain, pan, wet, echo, rate: t.rate, glideTo: t.glideTo, reverse, ...extra });

  switch (pattern) {
    case 'solo':
      push(0, 1.0, basePan, 0.35 + Math.random() * 0.25, lane === 'high' ? 0.3 : 0.12);
      break;
    case 'pair': {
      push(0, 1.0, basePan, 0.3, 0.1);
      const gap = 0.8 + Math.random() * 1.4;
      push(gap, 0.45, -basePan, 0.95, 0.25);
      break;
    }
    case 'echoes': {
      // Slowing echo trail: gaps stretch, each repeat quieter, wetter, alternating pans
      let at = 0, gap = 0.32 + Math.random() * 0.35, g = 1.0;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        push(at, g, i === 0 ? basePan : basePan * (i % 2 ? -1 : 1) * (0.5 + i * 0.18),
          0.25 + (i / n) * 0.75, 0.1 + i * 0.08);
        at += gap; gap *= 1.45; g *= 0.62;
      }
      break;
    }
    case 'accel': {
      // Bouncing-ball: gaps shrink into a flurry, then one last distant echo
      let at = 0, gap = 0.55 + Math.random() * 0.3, g = 1.0;
      const n = 4 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        push(at, g, basePan * (1 - i / n), 0.2 + (i / n) * 0.5, 0.1);
        at += gap; gap *= 0.68; g *= 0.78;
      }
      push(at + 1.1, 0.35, -basePan, 1.0, 0.3);
      break;
    }
    case 'cluster': {
      // "sksksk" — granular shaker burst from short bright slices
      const n = 4 + Math.floor(Math.random() * 5);
      const slice = 0.05 + Math.random() * 0.07;
      let at = 0;
      for (let i = 0; i < n; i++) {
        const offset = Math.random() * Math.max(0.01, moment.duration - slice);
        push(at, 0.6 + Math.random() * 0.4, basePan + (Math.random() * 0.5 - 0.25),
          0.3, 0.35, { slice, offset, rate: 1.0 + Math.random() * 0.3 });
        at += slice * (0.9 + Math.random() * 0.9);
      }
      break;
    }
  }
  return events;
}
