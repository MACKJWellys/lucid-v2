// Lucid — UI, visuals, lifecycle
import { LucidEngine, LAYER_DEFS } from './engine.js';

const $ = (s) => document.querySelector(s);
const engine = new LucidEngine();
window.lucid = engine; // for debugging / console poking
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');
if (params.has('fastarc')) engine.arcSpeed = 8; // fast-forward phases for testing

let wakeLock = null;

// ------------------------------------------------------------------ controls

const startBtn = $('#start');
const stopBtn = $('#stop');
const statusEl = $('#status');
const modeBtns = document.querySelectorAll('.mode-btn');
const intensityEl = $('#intensity');

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus(isDemo ? 'starting demo…' : 'asking for your microphone…');
  try {
    if (isDemo) {
      await startDemo();
    } else {
      await engine.start();
    }
    document.body.classList.add('running');
    setStatus('listening…');
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* fine */ }
  } catch (err) {
    console.error('[lucid] start failed', err);
    setStatus(err.name === 'NotAllowedError'
      ? 'microphone access was blocked — allow it in your browser settings and try again'
      : 'could not start: ' + err.message);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  console.log('[lucid] stop button pressed');
  engine.stop();
  document.body.classList.remove('running');
  startBtn.disabled = false;
  setStatus('');
  wakeLock?.release(); wakeLock = null;
});

modeBtns.forEach(btn => btn.addEventListener('click', () => {
  modeBtns.forEach(b => b.classList.toggle('active', b === btn));
  engine.setMode(btn.dataset.mode);
  setStatus(btn.dataset.mode === 'liminal' ? 'liminal — time folds back on itself' : 'lucid — listening for moments');
}));

intensityEl.addEventListener('input', () => engine.setIntensity(parseFloat(intensityEl.value)));
engine.setIntensity(parseFloat(intensityEl.value));

function setStatus(text) { statusEl.textContent = text; }

let firstMoment = true;
engine.on('moment', (m) => {
  console.log('[lucid] moment captured', m);
  if (firstMoment) { setStatus('first moment captured — the soundscape is forming'); firstMoment = false; }
});
engine.on('gesture', (g) => {
  console.log('[lucid] gesture', g);
  ripple(g.lane);
});
engine.on('state', (s) => console.log('[lucid] state', s));

const phaseWords = {
  arrival: 'arriving — just listen for a moment',
  bloom: 'the soundscape is forming',
  weave: 'weaving your world into music',
  release: 'space to breathe',
};
engine.on('phase', (p) => {
  console.log('[lucid] phase', p);
  if (engine.mode === 'lucid') setStatus(phaseWords[p] || '');
});
engine.on('key', (k) => console.log('[lucid] key shift', k));

// ------------------------------------------------------------------ lab panel
// Per-layer toggles + levels with explanations, and a live spectrum where
// each layer draws in its own colour.

const labEl = $('#lab');
const labToggle = $('#lab-toggle');
const rowsEl = $('#layer-rows');
const spectrum = $('#spectrum');
const spectrumCtx = spectrum.getContext('2d');

const savedLayers = JSON.parse(localStorage.getItem('lucid-layers') || '{}');

for (const def of LAYER_DEFS) {
  const saved = savedLayers[def.id] || {};
  const enabled = saved.enabled !== undefined ? saved.enabled : true;
  const level = saved.level !== undefined ? saved.level : 1;
  engine.setLayer(def.id, { enabled, level });

  const row = document.createElement('div');
  row.className = 'layer-row';
  row.innerHTML = `
    <div class="layer-top">
      <span class="layer-dot" style="background:hsl(${def.hue},70%,62%)"></span>
      <span class="layer-name">${def.label}</span>
      <label class="switch">
        <input type="checkbox" data-layer="${def.id}" ${enabled ? 'checked' : ''}>
        <span class="track"></span>
      </label>
    </div>
    <p class="layer-desc">${def.desc}</p>
    <input type="range" class="layer-level" data-layer="${def.id}"
           min="0" max="1.5" step="0.01" value="${level}">
  `;
  rowsEl.appendChild(row);
}

function persistLayers() {
  const out = {};
  for (const def of LAYER_DEFS) out[def.id] = { ...engine.layerState[def.id] };
  localStorage.setItem('lucid-layers', JSON.stringify(out));
}

rowsEl.addEventListener('change', (e) => {
  if (e.target.matches('input[type="checkbox"]')) {
    engine.setLayer(e.target.dataset.layer, { enabled: e.target.checked });
    persistLayers();
  }
});
rowsEl.addEventListener('input', (e) => {
  if (e.target.matches('.layer-level')) {
    engine.setLayer(e.target.dataset.layer, { level: parseFloat(e.target.value) });
    persistLayers();
  }
});

labToggle.addEventListener('click', () => {
  labEl.hidden = !labEl.hidden;
  labToggle.textContent = labEl.hidden ? 'explore the layers' : 'close layers';
});

// Spectrum: log-frequency, one translucent filled curve per enabled layer
const freqData = new Uint8Array(512);
function drawSpectrum() {
  requestAnimationFrame(drawSpectrum);
  if (labEl.hidden || !engine.running || !engine.ctx) return;
  const w = spectrum.width, h = spectrum.height;
  spectrumCtx.clearRect(0, 0, w, h);
  const nyquist = engine.ctx.sampleRate / 2;
  const fMin = 50, fMax = 14000;

  for (const def of LAYER_DEFS) {
    const L = engine.layers[def.id];
    const st = engine.layerState[def.id];
    if (!L || !st.enabled) continue;
    L.analyser.getByteFrequencyData(freqData);
    const bins = L.analyser.frequencyBinCount;

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const f = fMin * Math.pow(fMax / fMin, x / w);
      const bin = Math.min(bins - 1, Math.round(f / nyquist * bins));
      const v = freqData[bin] / 255;
      spectrumCtx.lineTo(x, h - Math.pow(v, 1.4) * h);
    }
    spectrumCtx.lineTo(w, h);
    spectrumCtx.closePath();
    spectrumCtx.fillStyle = `hsla(${def.hue}, 70%, 60%, 0.16)`;
    spectrumCtx.fill();
    spectrumCtx.strokeStyle = `hsla(${def.hue}, 75%, 65%, 0.75)`;
    spectrumCtx.lineWidth = 1.4;
    spectrumCtx.stroke();
  }
}
drawSpectrum();

// ------------------------------------------------------------------ visuals
// A breathing orb that swells with ambient level; gestures spawn ripples.

const canvas = $('#orb');
const ctx2d = canvas.getContext('2d');
let ripples = [];
let levelSmooth = 0;
let frame = 0;

function ripple(lane) {
  const hue = { low: 16, mid: 178, high: 268, liminal: 210, piano: 46, texture: 110, reflex: 268 }[lane] || 178;
  ripples.push({ r: 0, alpha: 0.55, hue, speed: 0.8 + Math.random() * 0.7 });
}

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
}
addEventListener('resize', resize);
resize();

function draw() {
  requestAnimationFrame(draw);
  frame++;
  const w = canvas.width, h = canvas.height;
  ctx2d.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.46;

  const lv = engine.level ? Math.min(1, engine.level.fast / 0.06) : 0;
  levelSmooth += (lv - levelSmooth) * 0.08;

  const breathe = Math.sin(frame / 140) * 0.06;
  const base = Math.min(w, h) * (0.16 + breathe + levelSmooth * 0.10);

  // Orb glow
  const running = document.body.classList.contains('running');
  const grad = ctx2d.createRadialGradient(cx, cy, base * 0.1, cx, cy, base * 2.4);
  const coreAlpha = running ? 0.85 : 0.5;
  grad.addColorStop(0, `rgba(165, 240, 230, ${coreAlpha})`);
  grad.addColorStop(0.35, `rgba(90, 160, 210, ${coreAlpha * 0.35})`);
  grad.addColorStop(1, 'rgba(20, 26, 48, 0)');
  ctx2d.fillStyle = grad;
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, base * 2.4, 0, Math.PI * 2);
  ctx2d.fill();

  // Ripples
  ripples = ripples.filter(r => r.alpha > 0.01);
  for (const r of ripples) {
    r.r += (base * 0.02 + 2) * r.speed * devicePixelRatio;
    r.alpha *= 0.975;
    ctx2d.strokeStyle = `hsla(${r.hue}, 70%, 70%, ${r.alpha})`;
    ctx2d.lineWidth = 1.5 * devicePixelRatio;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, base * 0.9 + r.r, 0, Math.PI * 2);
    ctx2d.stroke();
  }
}
draw();

// ------------------------------------------------------------------ demo mode
// Synthesizes chirps, clicks and thumps into the engine in place of the mic,
// so the experience can be heard (and tested) without ambient sound.

async function startDemo() {
  setStatus('demo mode — synthetic sounds in place of your environment');
  await engine.start((ctx) => {
    const bus = ctx.createGain();
    scheduleDemoSounds(ctx, bus);
    return bus;
  });
}

function scheduleDemoSounds(ac, bus) {
  function chirp(when) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    const f0 = 1400 + Math.random() * 2200;
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.3 + Math.random()), when + 0.12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.18, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
    o.connect(g).connect(bus);
    o.start(when); o.stop(when + 0.3);
  }
  function click(when) {
    const len = Math.floor(ac.sampleRate * 0.04);
    const b = ac.createBuffer(1, len, ac.sampleRate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * 0.5;
    const s = ac.createBufferSource(); s.buffer = b;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    s.connect(hp).connect(bus);
    s.start(when);
  }
  function thump(when) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.setValueAtTime(120, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.18);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.4, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    o.connect(g).connect(bus);
    o.start(when); o.stop(when + 0.35);
  }
  function tone(when) {
    // Mid-range, voice/melodic territory
    const o = ac.createOscillator();
    o.type = 'triangle';
    const g = ac.createGain();
    const f = 320 + Math.random() * 600;
    o.frequency.setValueAtTime(f, when);
    o.frequency.linearRampToValueAtTime(f * (0.92 + Math.random() * 0.2), when + 0.5);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.22, when + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.7);
    o.connect(g).connect(bus);
    o.start(when); o.stop(when + 0.8);
  }
  function loop() {
    if (!engine.running) return;
    const now = ac.currentTime;
    const kind = Math.random();
    if (kind < 0.35) chirp(now + 0.05);
    else if (kind < 0.6) { click(now + 0.05); if (Math.random() < 0.5) click(now + 0.16); }
    else if (kind < 0.85) tone(now + 0.05);
    else thump(now + 0.05);
    setTimeout(loop, 900 + Math.random() * 2600);
  }
  setTimeout(loop, 600); // engine.running flips true once start() resolves
}

if (isDemo) {
  $('#headphones-note').textContent = 'demo mode — synthetic sounds stand in for your environment. headphones still recommended.';
}
