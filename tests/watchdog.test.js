import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceStallWatchdog, VoiceClassifier, VoiceSensor } from '../voice-watchdog.js';

test('five seconds of substantial sound with no text triggers a single stall per session', () => {
  let now = 0; const stalls = [];
  const detector = new VoiceStallWatchdog({ now: () => now, onStall: count => stalls.push(count) });
  detector.begin();
  for (let i = 0; i < 49; i++) { now += 100; detector.sample(true, 100); }
  assert.deepEqual(stalls, []);
  now += 100; detector.sample(true, 100);
  assert.deepEqual(stalls, [1]);
  now += 6000; detector.sample(true, 100);
  assert.deepEqual(stalls, [1]);
  detector.begin();
  for (let i = 0; i < 50; i++) { now += 100; detector.sample(true, 100); }
  assert.deepEqual(stalls, [1, 2]);
});
test('silence, isolated sounds and text progress do not trigger false restarts', () => {
  let now = 0; let stalls = 0;
  const detector = new VoiceStallWatchdog({ now: () => now, onStall: () => stalls++ });
  detector.begin();
  for (let i = 0; i < 200; i++) { now += 100; detector.sample(i % 10 === 0, 100); }
  assert.equal(stalls, 0);
  detector.progress();
  for (let i = 0; i < 100; i++) { now += 100; detector.sample(true, 100); if (i % 30 === 0) detector.progress(); }
  assert.equal(stalls, 0);
  detector.end(); now += 6000; detector.sample(true, 6000); assert.equal(stalls, 0);
});
test('classifier rejects silence and low levels but accepts loud samples after calibration', () => {
  const classifier = new VoiceClassifier();
  for (let i = 0; i < 5; i++) assert.equal(classifier.classify(-70, 100), false);
  assert.equal(classifier.classify(-60, 100), false);
  assert.equal(classifier.classify(-100, 100), false);
  for (let i = 0; i < 55; i++) assert.equal(classifier.classify(-25, 100), true);
});
test('sensor measures synthetic audio and tears down mic, callback and context', async () => {
  let stopped = 0, closed = 0; const frames = [];
  const track = { stop() { stopped++; }, addEventListener() {} };
  const node = () => ({ connect() {}, disconnect() {} });
  const processor = node();
  const sensor = new VoiceSensor({ onFrame: (...frame) => frames.push(frame), getUserMedia: async options => {
    assert.equal(options.audio.autoGainControl, false); return { getTracks: () => [track] };
  }, createContext: () => ({ state: 'running', createMediaStreamSource: node, createScriptProcessor: () => processor,
    createGain: () => ({ ...node(), gain: {} }), close: async () => { closed++; } }) });
  await sensor.start();
  for (let i = 0; i < 65; i++) processor.onaudioprocess({ inputBuffer: { sampleRate: 1000, getChannelData: () => new Float32Array(100).fill(i < 5 ? .0001 : .2) } });
  assert.ok(frames.some(([voiced]) => voiced));
  sensor.stop(); assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(processor.onaudioprocess, null);
});
test('sensor measures through an AudioWorklet when available and tears it down', async () => {
  const workletNodes = []; const modules = []; const frames = []; let closed = 0;
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class { constructor(context, name) { this.name = name; this.port = {}; workletNodes.push(this); } connect() {} disconnect() {} };
  try {
    const node = () => ({ connect() {}, disconnect() {} });
    const sensor = new VoiceSensor({ onFrame: (...frame) => frames.push(frame), gestureTarget: null,
      getUserMedia: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }),
      createContext: () => ({ state: 'running', sampleRate: 1000, audioWorklet: { addModule: async url => { modules.push(url); } },
        createMediaStreamSource: node, createScriptProcessor: () => { throw new Error('fallback must not be used'); },
        createGain: () => ({ ...node(), gain: {} }), close: async () => { closed++; } }) });
    await sensor.start();
    assert.equal(workletNodes.length, 1); assert.equal(workletNodes[0].name, 'echoflow-level'); assert.match(modules[0], /^blob:/);
    for (let i = 0; i < 65; i++) workletNodes[0].port.onmessage({ data: { energy: (i < 5 ? .0001 : .2) ** 2 * 100, count: 100 } });
    assert.ok(frames.some(([voiced]) => voiced)); assert.equal(frames[0][1], 100);
    sensor.stop(); assert.equal(workletNodes[0].port.onmessage, null); assert.equal(closed, 1);
  } finally { globalThis.AudioWorkletNode = previous; }
});
test('sensor stops a late microphone stream after cancellation, and failure degrades gracefully', async () => {
  let resolve; let stopped = 0, unavailable = 0;
  const pending = new Promise(r => { resolve = r; });
  const sensor = new VoiceSensor({ onFrame() {}, getUserMedia: () => pending });
  const started = sensor.start(); sensor.stop(); resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await started; assert.equal(stopped, 1);
  const failed = new VoiceSensor({ onFrame() {}, getUserMedia: async () => { throw new Error('denied'); }, onUnavailable() { unavailable++; } });
  await failed.start(); assert.equal(unavailable, 1); assert.equal(failed.pending, false);
});
