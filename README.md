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

## Layers & the lab (round 3)

Every sound source is a **layer** with its own bus, level, toggle, and analyser: Wash, Reflex, Echoes, Felt piano, Harmonic bed, Textures, Time smear. "Explore the layers" in the app opens the lab: per-layer explanations, switches, level sliders, and a live log-frequency spectrum where each layer draws in its own colour — built for giving precise feedback about each layer.

Round 3 also reworked dynamics to remove the on/off jolt: partial RMS loudness normalization (quiet sounds keep some distance), slow swelling attacks with exponential releases, long curved fade-outs baked into captured buffers, a continuous harmonic bed so there is never true silence, and a **Reflex** layer that answers any distinct sound within ~0.4s of it happening.

## Round 4 — progression, binaural, presets, 3D

- **Bed progression** — the harmonic bed slowly cycles: hold the root ~25–38s, glide down a fourth, rise partway back, return. Key shifts between arc cycles now glide the bed too.
- **Overtones layer** — two slow upper voices breathing in and out on notes of the key, retuning while silent. Never repeats itself.
- **Binaural beat layer** — the same low tone in each ear offset by a few Hz (dry only; reverb would blur the interaural difference). Presets choose theta (~4–6 Hz, meditative) or alpha (~10 Hz, calm focus).
- **Presets** — walk / ground / focus / dream: one tap sets activity, the layer mix, mode, and beat frequency. Tweaking any layer switches you back to a custom mix.
- **3D space** — about half of replayed moments are placed with HRTF panning: beside, above, even behind you.

## Tips for the best experience

- **Wired headphones or earbuds give the best quality.** Bluetooth headphones that use their own mic drop to low-quality voice mode — if using Bluetooth, you may get better results letting the phone mic listen while audio plays through the headphones.
- It takes ~30 seconds for the soundscape to form — Lucid needs to hear a few moments first.
- Works best somewhere with occasional distinct sounds: a walk, a café, a park, a kitchen.

## Tech

Static PWA — no build step, no backend, no dependencies. Web Audio API with an `AudioWorklet` ring-buffer capture processor (12s of history, adaptive noise floor, onset detection) and a main-thread composer/scheduler. See [js/engine.js](js/engine.js).

Local dev: serve the folder over localhost (mic requires a secure context), e.g. `npx serve .`
