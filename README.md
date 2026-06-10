# Lucid

**Hear the world again.** A live listening experience by Vision Wellbeing.

Put your headphones in. Lucid listens to the sounds around you — voices, keys, birds, traffic, café clatter — and recomposes them in real time into an evolving soundscape. Nothing is recorded or leaves your device; everything happens locally in your browser.

**Try it:** open the app over HTTPS, tap **begin**, allow the microphone.
**Demo mode** (no mic needed, synthetic sounds): append `?demo=1` to the URL.

## Modes

- **Lucid** — the engine listens for *moments*: distinct sounds that rise above the ambient floor. Each moment is captured, normalized (so quiet, distant sounds aren't lost), classified into a low / mid / high lane, and stored in a small memory pool. A composer then re-places these moments with deliberate space between them — solo placements, slowing echo trails, bouncing-ball accelerandos, far-away wet repeats, granular "shaker" clusters for bright sounds, occasional pitch fifths/octaves, reverses, and slow glides.
- **Liminal** — time folds back on itself. Rolling windows of the last few seconds are replayed slowed, forward → reversed → forward, through a phaser and a long reverb.

## Musical intelligence (round 2)

- **Harmonic frame** — the piece holds a slowly drifting pentatonic key. Tonal moments (voices, beeps, hums — detected by autocorrelation) are gently retuned (≤ ~1.5 semitones) so their replays land on scale tones. Non-tonal sounds pass through untouched.
- **Felt piano** — a synthesized felted upright (Karplus-Strong, no samples). Its main role is *call-and-response*: when a tonal moment replays, the piano sometimes answers at the nearest scale tone. It also plays sparse phrases of its own in denser phases.
- **Built-in textures** — synthesized leaves-in-wind and a log-crackle, rare and quiet, long fades.
- **Compositional arc** — sessions move through *arrival → bloom → weave → release* phases (cycling, key shifting between cycles), so longer sessions have shape. Debug fast-forward: `?fastarc=1`.

## Tips for the best experience

- **Wired headphones or earbuds give the best quality.** Bluetooth headphones that use their own mic drop to low-quality voice mode — if using Bluetooth, you may get better results letting the phone mic listen while audio plays through the headphones.
- It takes ~30 seconds for the soundscape to form — Lucid needs to hear a few moments first.
- Works best somewhere with occasional distinct sounds: a walk, a café, a park, a kitchen.

## Tech

Static PWA — no build step, no backend, no dependencies. Web Audio API with an `AudioWorklet` ring-buffer capture processor (12s of history, adaptive noise floor, onset detection) and a main-thread composer/scheduler. See [js/engine.js](js/engine.js).

Local dev: serve the folder over localhost (mic requires a secure context), e.g. `npx serve .`
