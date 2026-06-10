// Lucid — capture worklet
// Maintains a ring buffer of raw mic audio, tracks an adaptive noise floor,
// detects onsets, and serves extraction requests from the main thread.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringSize = Math.floor(sampleRate * 12); // 12 seconds of history
    this.ring = new Float32Array(this.ringSize);
    this.totalWritten = 0;

    // Envelope followers (block-rate, ~2.7ms per block at 48k)
    this.fast = 0;       // fast attack level
    this.slow = 0;       // slow ambient level
    this.floor = 1e-3;   // adaptive noise floor (falls fast, rises slow)

    this.blockCount = 0;
    this.lastOnsetTime = -10;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === 'extract') {
      const { id, startAbs, durSamples } = msg;
      const dur = Math.min(durSamples, this.ringSize - 128);
      // Reject if the requested region has been overwritten or not yet written
      if (startAbs < this.totalWritten - this.ringSize + dur || startAbs + dur > this.totalWritten) {
        this.port.postMessage({ type: 'extracted', id, samples: null });
        return;
      }
      const out = new Float32Array(dur);
      const startIdx = startAbs % this.ringSize;
      const firstChunk = Math.min(dur, this.ringSize - startIdx);
      out.set(this.ring.subarray(startIdx, startIdx + firstChunk), 0);
      if (firstChunk < dur) out.set(this.ring.subarray(0, dur - firstChunk), firstChunk);
      this.port.postMessage({ type: 'extracted', id, samples: out, rate: sampleRate }, [out.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const n = input[0].length;
    const channels = input.length;

    let sumSq = 0;
    let w = this.totalWritten % this.ringSize;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      s /= channels;
      this.ring[w] = s;
      w = (w + 1) % this.ringSize;
      sumSq += s * s;
    }
    this.totalWritten += n;

    const rms = Math.sqrt(sumSq / n);
    this.fast += (rms - this.fast) * 0.5;
    this.slow += (rms - this.slow) * 0.015;
    if (rms < this.floor) this.floor += (rms - this.floor) * 0.2;
    else this.floor += (rms - this.floor) * 0.0015;

    // Onset: fast envelope pops above both the ambient level and the noise floor
    const threshold = Math.max(this.floor * 2.5, this.slow * 1.55, 2.5e-4);
    if (this.fast > threshold && currentTime - this.lastOnsetTime > 0.22) {
      this.lastOnsetTime = currentTime;
      this.port.postMessage({
        type: 'onset',
        strength: this.fast / Math.max(this.slow, 1e-6),
        rms: this.fast,
        abs: this.totalWritten,
      });
    }

    if (++this.blockCount % 16 === 0) {
      this.port.postMessage({
        type: 'level',
        rms, fast: this.fast, slow: this.slow, floor: this.floor,
        abs: this.totalWritten,
      });
    }
    return true;
  }
}

registerProcessor('lucid-capture', CaptureProcessor);
