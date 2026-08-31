export const DSP_CONFIG = Object.freeze({
  baselineSeconds: 0.45,
  preTriggerSeconds: 0.025,
  postTriggerSeconds: 0.55,
  impactSkipSeconds: 0.005,
  minTapSpacingSeconds: 0.45,
  fixedTriggerFloor: 0.025,
  adaptiveTriggerMultiplier: 7.0,
  peakMinHz: 30,
  peakMaxHz: 5000,
  maxFFTSize: 16384,
  decayFrameSeconds: 0.010,
  decayHopSeconds: 0.005,
});

export function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function standardDeviation(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function rms(values, start = 0, end = values.length) {
  const lo = Math.max(0, start | 0);
  const hi = Math.min(values.length, end | 0);
  if (hi <= lo) return 0;
  let energy = 0;
  for (let i = lo; i < hi; i += 1) energy += values[i] * values[i];
  return Math.sqrt(energy / (hi - lo));
}

export function nextPowerOfTwoFloor(n) {
  if (n < 2) return 1;
  return 2 ** Math.floor(Math.log2(n));
}

export function hannWindow(length) {
  const window = new Float64Array(length);
  if (length <= 1) {
    if (length === 1) window[0] = 1;
    return window;
  }
  for (let i = 0; i < length; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return window;
}

function reverseBits(value, bits) {
  let result = 0;
  for (let i = 0; i < bits; i += 1) {
    result = (result << 1) | (value & 1);
    value >>= 1;
  }
  return result;
}

export function fftReal(input) {
  const n = input.length;
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error('FFT input length must be a power of two.');
  }

  const bits = Math.log2(n);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    real[reverseBits(i, bits)] = input[i];
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < half; j += 1) {
        const angle = angleStep * j;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const even = start + j;
        const odd = even + half;
        const oddReal = real[odd] * cos - imag[odd] * sin;
        const oddImag = real[odd] * sin + imag[odd] * cos;
        const evenReal = real[even];
        const evenImag = imag[even];
        real[even] = evenReal + oddReal;
        imag[even] = evenImag + oddImag;
        real[odd] = evenReal - oddReal;
        imag[odd] = evenImag - oddImag;
      }
    }
  }

  return { real, imag };
}

export function singleSidedSpectrum(signal, sampleRate, maxFFTSize = DSP_CONFIG.maxFFTSize) {
  const fftSize = Math.min(maxFFTSize, nextPowerOfTwoFloor(signal.length));
  if (fftSize < 32) throw new Error('Not enough samples for spectral analysis.');

  const segment = new Float64Array(fftSize);
  let dc = 0;
  for (let i = 0; i < fftSize; i += 1) dc += signal[i];
  dc /= fftSize;

  const window = hannWindow(fftSize);
  let windowSum = 0;
  for (let i = 0; i < fftSize; i += 1) {
    segment[i] = (signal[i] - dc) * window[i];
    windowSum += window[i];
  }

  const { real, imag } = fftReal(segment);
  const count = fftSize / 2 + 1;
  const frequencies = new Float64Array(count);
  const magnitudes = new Float64Array(count);
  const scale = 2 / Math.max(windowSum, 1e-12);

  for (let i = 0; i < count; i += 1) {
    frequencies[i] = (i * sampleRate) / fftSize;
    let magnitude = Math.hypot(real[i], imag[i]) * scale;
    if (i === 0 || i === count - 1) magnitude *= 0.5;
    magnitudes[i] = magnitude;
  }

  return { fftSize, frequencies, magnitudes };
}

export function dominantPeak(spectrum, minHz = DSP_CONFIG.peakMinHz, maxHz = DSP_CONFIG.peakMaxHz) {
  const { frequencies, magnitudes } = spectrum;
  let bestIndex = -1;
  let bestMagnitude = -Infinity;
  for (let i = 1; i < magnitudes.length - 1; i += 1) {
    const f = frequencies[i];
    if (f < minHz || f > maxHz) continue;
    if (magnitudes[i] > bestMagnitude) {
      bestMagnitude = magnitudes[i];
      bestIndex = i;
    }
  }
  if (bestIndex < 1) return { frequencyHz: 0, magnitude: 0, binIndex: -1 };

  const y1 = magnitudes[bestIndex - 1];
  const y2 = magnitudes[bestIndex];
  const y3 = magnitudes[bestIndex + 1];
  const denominator = y1 - 2 * y2 + y3;
  let offset = 0;
  if (Math.abs(denominator) > 1e-15) {
    offset = 0.5 * (y1 - y3) / denominator;
    offset = Math.max(-0.5, Math.min(0.5, offset));
  }
  const binWidth = frequencies[1] - frequencies[0];
  return {
    frequencyHz: frequencies[bestIndex] + offset * binWidth,
    magnitude: y2,
    binIndex: bestIndex,
  };
}

export function t20Decay(signal, sampleRate, config = DSP_CONFIG) {
  const skip = Math.round(config.impactSkipSeconds * sampleRate);
  const frame = Math.max(16, Math.round(config.decayFrameSeconds * sampleRate));
  const hop = Math.max(8, Math.round(config.decayHopSeconds * sampleRate));
  if (signal.length < skip + frame * 2) return { t20Seconds: 0, envelope: [] };

  const envelope = [];
  for (let start = skip; start + frame <= signal.length; start += hop) {
    envelope.push({
      timeSeconds: (start + frame / 2) / sampleRate,
      rms: rms(signal, start, start + frame),
    });
  }
  if (!envelope.length) return { t20Seconds: 0, envelope };

  const earlyLimit = Math.max(1, Math.min(envelope.length, Math.ceil(0.06 / config.decayHopSeconds)));
  let peakIndex = 0;
  for (let i = 1; i < earlyLimit; i += 1) {
    if (envelope[i].rms > envelope[peakIndex].rms) peakIndex = i;
  }
  const peak = envelope[peakIndex].rms;
  if (peak <= 1e-12) return { t20Seconds: 0, envelope };
  const threshold = peak * 0.1;

  for (let i = peakIndex + 1; i < envelope.length - 2; i += 1) {
    if (envelope[i].rms <= threshold && envelope[i + 1].rms <= threshold && envelope[i + 2].rms <= threshold) {
      const t = envelope[i].timeSeconds - envelope[peakIndex].timeSeconds;
      return { t20Seconds: Math.max(0, t), envelope, method: 'threshold' };
    }
  }

  const fitPoints = envelope
    .slice(peakIndex)
    .filter((point) => point.rms > peak * 0.02 && point.rms <= peak)
    .map((point) => ({ x: point.timeSeconds - envelope[peakIndex].timeSeconds, y: 20 * Math.log10(point.rms / peak) }));

  if (fitPoints.length >= 6) {
    const xMean = mean(fitPoints.map((p) => p.x));
    const yMean = mean(fitPoints.map((p) => p.y));
    let numerator = 0;
    let denominator = 0;
    for (const p of fitPoints) {
      numerator += (p.x - xMean) * (p.y - yMean);
      denominator += (p.x - xMean) ** 2;
    }
    const slope = denominator > 0 ? numerator / denominator : 0;
    if (slope < -1e-6) {
      const t20Seconds = -20 / slope;
      if (Number.isFinite(t20Seconds) && t20Seconds >= 0) {
        return { t20Seconds, envelope, method: 'linear-fit' };
      }
    }
  }

  return { t20Seconds: 0, envelope, method: 'unresolved' };
}

export function detectTapIndices(samples, sampleRate, desiredCount = 3, config = DSP_CONFIG) {
  const baselineSamples = Math.min(samples.length, Math.round(config.baselineSeconds * sampleRate));
  const baselineRms = rms(samples, 0, baselineSamples);
  const threshold = Math.max(config.fixedTriggerFloor, baselineRms * config.adaptiveTriggerMultiplier);
  const minSpacing = Math.round(config.minTapSpacingSeconds * sampleRate);
  const searchStart = baselineSamples;
  const candidates = [];

  for (let i = searchStart + 1; i < samples.length - 1; i += 1) {
    const value = Math.abs(samples[i]);
    if (value < threshold) continue;
    if (value < Math.abs(samples[i - 1]) || value < Math.abs(samples[i + 1])) continue;
    candidates.push({ index: i, value });
  }

  const taps = [];
  for (const candidate of candidates) {
    const previous = taps[taps.length - 1];
    if (!previous || candidate.index - previous.index >= minSpacing) {
      taps.push(candidate);
    } else if (candidate.value > previous.value) {
      taps[taps.length - 1] = candidate;
    }
  }

  return {
    indices: taps.slice(0, desiredCount).map((tap) => tap.index),
    baselineRms,
    threshold,
  };
}

export function analyzeTap(samples, sampleRate, triggerIndex, tapIndex, config = DSP_CONFIG) {
  const pre = Math.round(config.preTriggerSeconds * sampleRate);
  const post = Math.round(config.postTriggerSeconds * sampleRate);
  const start = Math.max(0, triggerIndex - pre);
  const end = Math.min(samples.length, triggerIndex + post);
  const tapSignal = samples.slice(start, end);
  const relativeTrigger = triggerIndex - start;
  const analysisStart = Math.min(tapSignal.length, relativeTrigger + Math.round(config.impactSkipSeconds * sampleRate));
  const resonanceSignal = tapSignal.slice(analysisStart);
  const spectrum = singleSidedSpectrum(resonanceSignal, sampleRate, config.maxFFTSize);
  const peak = dominantPeak(spectrum, config.peakMinHz, config.peakMaxHz);
  const decaySignal = tapSignal.slice(relativeTrigger);
  const decay = t20Decay(decaySignal, sampleRate, config);

  return {
    tapIndex,
    triggerSample: triggerIndex,
    triggerTimeSeconds: triggerIndex / sampleRate,
    dominantPeakHz: peak.frequencyHz,
    dominantPeakMagnitude: peak.magnitude,
    t20Seconds: decay.t20Seconds,
    decayMethod: decay.method ?? 'unresolved',
    fftSize: spectrum.fftSize,
    spectrum: Array.from(spectrum.frequencies, (frequencyHz, i) => ({
      frequencyHz,
      magnitude: spectrum.magnitudes[i],
    })),
    decayEnvelope: decay.envelope,
  };
}

export function averageSpectrum(taps) {
  if (!taps.length) return [];
  const count = Math.min(...taps.map((tap) => tap.spectrum.length));
  const averaged = [];
  for (let i = 0; i < count; i += 1) {
    averaged.push({
      frequencyHz: taps[0].spectrum[i].frequencyHz,
      magnitude: mean(taps.map((tap) => tap.spectrum[i].magnitude)),
    });
  }
  return averaged;
}

export function summarizeTaps(taps) {
  const frequencies = taps.map((tap) => tap.dominantPeakHz).filter(Number.isFinite);
  const decaysMs = taps.map((tap) => tap.t20Seconds * 1000).filter(Number.isFinite);
  return {
    dominantPeakHz: median(frequencies),
    dominantPeakStdDevHz: standardDeviation(frequencies),
    t20Ms: median(decaysMs),
    t20StdDevMs: standardDeviation(decaysMs),
  };
}

export function analyzeRecording(samples, sampleRate, desiredCount = 3, config = DSP_CONFIG) {
  const detection = detectTapIndices(samples, sampleRate, desiredCount, config);
  const taps = detection.indices.map((triggerIndex, i) => analyzeTap(samples, sampleRate, triggerIndex, i + 1, config));
  return {
    detection,
    taps,
    averageSpectrum: averageSpectrum(taps),
    summary: summarizeTaps(taps),
  };
}
