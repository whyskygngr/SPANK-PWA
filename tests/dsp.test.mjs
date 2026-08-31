import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRecording,
  dominantPeak,
  singleSidedSpectrum,
  t20Decay,
  detectTapIndices,
  averageSpectrum,
} from '../dsp.js';

const sampleRate = 48000;

function decayingSine(frequency, durationSeconds, tauSeconds, amplitude = 0.8) {
  const count = Math.round(durationSeconds * sampleRate);
  const data = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    data[i] = amplitude * Math.exp(-t / tauSeconds) * Math.sin(2 * Math.PI * frequency * t);
  }
  return data;
}

test('FFT recovers known resonant frequency', () => {
  const signal = decayingSine(176, 0.5, 0.2);
  const spectrum = singleSidedSpectrum(signal, sampleRate);
  const peak = dominantPeak(spectrum);
  assert.ok(Math.abs(peak.frequencyHz - 176) < 2.0, `peak=${peak.frequencyHz}`);
});

test('T20 follows known exponential decay', () => {
  const tau = 0.06;
  const signal = decayingSine(220, 0.45, tau);
  const result = t20Decay(signal, sampleRate);
  const expected = tau * Math.log(10);
  assert.ok(result.t20Seconds > 0);
  assert.ok(Math.abs(result.t20Seconds - expected) < 0.035, `actual=${result.t20Seconds}, expected=${expected}`);
});

test('tap detector finds three separated impulses', () => {
  const samples = new Float64Array(sampleRate * 4);
  const locations = [1.0, 1.8, 2.6].map((t) => Math.round(t * sampleRate));
  for (const index of locations) {
    samples[index] = 0.8;
    samples[index + 1] = 0.4;
  }
  const detected = detectTapIndices(samples, sampleRate, 3);
  assert.equal(detected.indices.length, 3);
  detected.indices.forEach((index, i) => assert.ok(Math.abs(index - locations[i]) < 3));
});

test('recording analysis produces full per-tap and average spectra', () => {
  const duration = 4.5;
  const samples = new Float64Array(Math.round(duration * sampleRate));
  const starts = [0.8, 1.7, 2.6];
  for (const startTime of starts) {
    const start = Math.round(startTime * sampleRate);
    samples[start] = 0.95;
    const ring = decayingSine(182, 0.55, 0.07, 0.5);
    for (let i = 1; i < ring.length && start + i < samples.length; i += 1) samples[start + i] += ring[i];
  }
  const result = analyzeRecording(samples, sampleRate, 3);
  assert.equal(result.taps.length, 3);
  assert.ok(result.averageSpectrum.length > 1000);
  assert.equal(result.averageSpectrum.length, result.taps[0].spectrum.length);
  assert.ok(Math.abs(result.summary.dominantPeakHz - 182) < 3);
});

test('average spectrum preserves bin count', () => {
  const taps = [
    { spectrum: [{ frequencyHz: 0, magnitude: 1 }, { frequencyHz: 10, magnitude: 3 }] },
    { spectrum: [{ frequencyHz: 0, magnitude: 3 }, { frequencyHz: 10, magnitude: 5 }] },
  ];
  const average = averageSpectrum(taps);
  assert.deepEqual(average, [
    { frequencyHz: 0, magnitude: 2 },
    { frequencyHz: 10, magnitude: 4 },
  ]);
});

import { packetsToCSV } from '../csv.js';

test('CSV export preserves every spectrum bin', () => {
  const packet = {
    id: 'packet-1',
    createdAt: '2026-08-30T12:00:00Z',
    sampleRateHz: 48000,
    captureDurationSeconds: 5,
    metadata: {},
    summary: { dominantPeakHz: 180, t20Ms: 80, dominantPeakStdDevHz: 2, t20StdDevMs: 3 },
    taps: [{
      tapIndex: 1,
      triggerTimeSeconds: 1,
      dominantPeakHz: 180,
      t20Seconds: 0.08,
      decayMethod: 'threshold',
      spectrum: [
        { frequencyHz: 0, magnitude: 0.1 },
        { frequencyHz: 10, magnitude: 0.2 },
        { frequencyHz: 20, magnitude: 0.3 },
      ],
    }],
    averageSpectrum: [
      { frequencyHz: 0, magnitude: 0.1 },
      { frequencyHz: 10, magnitude: 0.2 },
      { frequencyHz: 20, magnitude: 0.3 },
    ],
  };
  const csv = packetsToCSV([packet]);
  assert.equal((csv.match(/tap_spectrum/g) || []).length, 3);
  assert.equal((csv.match(/average_spectrum/g) || []).length, 3);
});
