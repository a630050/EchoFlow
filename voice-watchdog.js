// Independent microphone level sensing, without recording or sending audio anywhere.
export class VoiceStallWatchdog {
  constructor({ onStall, now = Date.now, thresholdMs = 5000, windowMs = 10000 }) {
    Object.assign(this, { onStall, now, thresholdMs, windowMs });
    this.reset();
  }
  reset() { this.stalls = 0; this.active = false; this.frames = []; this.lastProgress = this.now(); }
  begin() { this.active = true; this.frames = []; this.lastProgress = this.now(); }
  end() { this.active = false; this.frames = []; }
  progress() { this.frames = []; this.lastProgress = this.now(); this.stalls = 0; }
  sample(voiced, durationMs, time = this.now()) {
    if (!this.active) return;
    this.frames = this.frames.filter(([at]) => at > time - this.windowMs && at > this.lastProgress);
    if (voiced) this.frames.push([time, Math.min(250, Math.max(0, durationMs))]);
    if (time - this.lastProgress < this.thresholdMs || this.frames.reduce((sum, [, duration]) => sum + duration, 0) < this.thresholdMs) return;
    this.frames = [];
    this.lastProgress = time;
    this.active = false; // A new session must begin before samples may trigger again.
    this.stalls++;
    this.onStall(this.stalls);
  }
}

export class VoiceClassifier {
  constructor() { this.floor = -65; this.calibration = []; this.elapsed = 0; }
  classify(db, durationMs) {
    if (this.elapsed < 500) {
      this.calibration.push(db);
      this.elapsed += durationMs;
      if (this.elapsed >= 500) {
        const sorted = this.calibration.sort((a, b) => a - b);
        this.floor = Math.min(-50, Math.max(-90, sorted[Math.floor(sorted.length / 2)]));
        this.calibration = [];
      }
      return false;
    }
    const voiced = db >= -50 && db >= this.floor + 10;
    this.floor += db < this.floor ? (db - this.floor) * .3 : Math.min(db - this.floor, durationMs / 1000);
    return voiced;
  }
}

// Runs on the audio rendering thread: sums energy over ~2048 samples and posts it to the page.
// Inlined and loaded from a Blob URL so deployment stays a fixed set of files.
const LEVEL_WORKLET = `
class EchoFlowLevel extends AudioWorkletProcessor {
  constructor() { super(); this.energy = 0; this.count = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) this.energy += channel[i] * channel[i];
      this.count += channel.length;
      if (this.count >= 2048) { this.port.postMessage({ energy: this.energy, count: this.count }); this.energy = 0; this.count = 0; }
    }
    return true;
  }
}
registerProcessor('echoflow-level', EchoFlowLevel);
`;

export class VoiceSensor {
  constructor({ onFrame, onUnavailable = () => {}, getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints), createContext = () => new (window.AudioContext || window.webkitAudioContext)(), gestureTarget = globalThis.document }) {
    Object.assign(this, { onFrame, onUnavailable, getUserMedia, createContext, gestureTarget });
    this.generation = 0;
    this.pending = false;
    this.resume = () => { if (this.context?.state === 'suspended') void this.context.resume().catch(() => {}); };
  }
  async start() {
    if (this.pending || this.stream) { this.resume(); return; }
    this.pending = true;
    const generation = ++this.generation;
    let stream;
    try {
      stream = await this.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.context = this.createContext();
      const classifier = new VoiceClassifier();
      this.source = this.context.createMediaStreamSource(stream);
      const measure = (energy, count, sampleRate) => {
        if (generation !== this.generation || this.context?.state !== 'running' || !count) return;
        const rms = Math.sqrt(energy / count);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;
        const durationMs = count / sampleRate * 1000;
        this.onFrame(classifier.classify(db, durationMs), durationMs);
      };
      // Audio callbacks keep sampling when the tab is obscured; rAF would freeze.
      const processor = await this.createLevelNode(measure);
      if (generation !== this.generation) { try { processor.disconnect(); } catch {} return; } // stop() ran while the worklet loaded.
      this.processor = processor;
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);
      this.context.onstatechange = this.resume;
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (generation !== this.generation) return;
        this.stop(); this.onUnavailable();
      });
      this.gestureTarget?.addEventListener('pointerdown', this.resume, true);
      this.gestureTarget?.addEventListener('keydown', this.resume, true);
      this.resume();
    } catch {
      if (generation === this.generation) { this.stop(); this.onUnavailable(); }
      else stream?.getTracks().forEach(track => track.stop());
    } finally { if (generation === this.generation) this.pending = false; }
  }
  // AudioWorklet where available; the deprecated ScriptProcessorNode only as a fallback
  // (older engines, or a page whose policy blocks Blob-URL worklet modules).
  async createLevelNode(measure) {
    const context = this.context;
    const WorkletNode = globalThis.AudioWorkletNode;
    if (context.audioWorklet && typeof WorkletNode === 'function') {
      const url = URL.createObjectURL(new Blob([LEVEL_WORKLET], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
        const node = new WorkletNode(context, 'echoflow-level', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = ({ data }) => measure(data.energy, data.count, context.sampleRate);
        return node;
      } catch {} finally { URL.revokeObjectURL(url); }
    }
    const node = context.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = event => {
      const samples = event.inputBuffer.getChannelData(0);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      measure(energy, samples.length, event.inputBuffer.sampleRate);
    };
    return node;
  }
  stop() {
    this.generation++;
    this.pending = false;
    this.gestureTarget?.removeEventListener('pointerdown', this.resume, true);
    this.gestureTarget?.removeEventListener('keydown', this.resume, true);
    if (this.processor) { this.processor.onaudioprocess = null; if (this.processor.port) this.processor.port.onmessage = null; }
    for (const node of [this.source, this.processor, this.sink]) { try { node?.disconnect(); } catch {} }
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = this.context = this.processor = this.source = this.sink = null;
  }
}
