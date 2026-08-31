import { analyzeRecording, DSP_CONFIG } from './dsp.js';
import { savePacket, listPackets, deletePacket, clearPackets } from './storage.js';
import { packetsToCSV, downloadCSV } from './csv.js';

const CAPTURE_SECONDS = 5.0;
const DESIRED_TAPS = 3;

const $ = (id) => document.getElementById(id);
const startButton = $('startCapture');
const exportCurrentButton = $('exportCurrent');
const exportAllButton = $('exportAll');
const clearHistoryButton = $('clearHistory');
const statusEl = $('status');
const resultPanel = $('resultPanel');
const historyBody = $('historyBody');
const historyEmpty = $('historyEmpty');
const peakValue = $('peakValue');
const decayValue = $('decayValue');
const repeatabilityValue = $('repeatabilityValue');
const tapsValue = $('tapsValue');
const sampleRateValue = $('sampleRateValue');
const fftBinsValue = $('fftBinsValue');
const spectrumCanvas = $('spectrumCanvas');
const waveformCanvas = $('waveformCanvas');
const decayCanvas = $('decayCanvas');
const spectrumRange = $('spectrumRange');
const tapSelector = $('tapSelector');
const metadataVariety = $('variety');
const metadataBrix = $('brix');
const metadataTruth = $('groundTruth');
const metadataNotes = $('notes');

let currentPacket = null;
let lastWaveform = null;
let lastSampleRate = null;

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `spank-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(message, mode = 'neutral') {
  statusEl.textContent = message;
  statusEl.dataset.mode = mode;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenChunks(chunks, totalLength) {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function recordPCM(seconds) {
  if (!window.isSecureContext) {
    throw new Error('Microphone access requires HTTPS. Open SPANK from its GitHub Pages HTTPS address.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose microphone capture. Use current Safari on iPhone/iPad.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Web Audio is unavailable in this browser.');
  }

  const audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(2048, 1, 1);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  const chunks = [];
  let totalLength = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    totalLength += copy.length;
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);

  const start = performance.now();
  const timer = setInterval(() => {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed < DSP_CONFIG.baselineSeconds) {
      setStatus('Listening to ambient baseline… keep still.', 'working');
    } else {
      const remaining = Math.max(0, seconds - elapsed);
      setStatus(`Tap the watermelon 3 times, about 0.7 s apart. ${remaining.toFixed(1)} s`, 'working');
    }
  }, 100);

  try {
    await delay(seconds * 1000);
  } finally {
    clearInterval(timer);
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    processor.onaudioprocess = null;
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
  }

  if (!totalLength) throw new Error('No microphone samples were captured.');
  return {
    samples: flattenChunks(chunks, totalLength),
    sampleRate: audioContext.sampleRate,
  };
}

function metadataFromForm() {
  const brixText = metadataBrix.value.trim();
  const brixValue = brixText === '' ? null : Number(brixText);
  return {
    variety: metadataVariety.value.trim(),
    brix: Number.isFinite(brixValue) ? brixValue : null,
    groundTruth: metadataTruth.value,
    notes: metadataNotes.value.trim(),
  };
}

async function startMeasurement() {
  startButton.disabled = true;
  exportCurrentButton.disabled = true;
  setStatus('Requesting microphone permission…', 'working');
  try {
    const { samples, sampleRate } = await recordPCM(CAPTURE_SECONDS);
    setStatus('Analyzing taps and full spectrum…', 'working');
    await delay(0);
    const analysis = analyzeRecording(samples, sampleRate, DESIRED_TAPS);
    if (!analysis.taps.length) {
      throw new Error('No tap impulse was detected. Try a firmer tap and keep the room quiet.');
    }

    currentPacket = {
      schemaVersion: 1,
      id: uuid(),
      createdAt: new Date().toISOString(),
      app: 'SPANK PWA',
      sampleRateHz: sampleRate,
      captureDurationSeconds: samples.length / sampleRate,
      requestedTapCount: DESIRED_TAPS,
      detectedTapCount: analysis.taps.length,
      triggerBaselineRms: analysis.detection.baselineRms,
      triggerThreshold: analysis.detection.threshold,
      analysisConfig: { ...DSP_CONFIG },
      metadata: metadataFromForm(),
      device: {
        userAgent: navigator.userAgent,
        platform: navigator.platform ?? '',
      },
      summary: analysis.summary,
      taps: analysis.taps,
      averageSpectrum: analysis.averageSpectrum,
      rawAudioRetained: false,
    };

    lastWaveform = samples;
    lastSampleRate = sampleRate;
    await savePacket(currentPacket);
    renderResult();
    await renderHistory();
    const warning = analysis.taps.length < DESIRED_TAPS
      ? ` Only ${analysis.taps.length} of ${DESIRED_TAPS} taps were detected.`
      : '';
    setStatus(`Measurement saved locally.${warning}`, analysis.taps.length === DESIRED_TAPS ? 'success' : 'warning');
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'Capture failed.', 'error');
  } finally {
    startButton.disabled = false;
    exportCurrentButton.disabled = !currentPacket;
  }
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.floor(rect.width * ratio));
  const height = Math.max(160, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function drawAxes(ctx, width, height, xLabel, yLabel) {
  const border = cssColor('--border', '#c9c9c9');
  const muted = cssColor('--muted', '#666');
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(46, 12);
  ctx.lineTo(46, height - 30);
  ctx.lineTo(width - 10, height - 30);
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(xLabel, width - 72, height - 8);
  ctx.save();
  ctx.translate(13, 66);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function drawWaveform() {
  const { ctx, width, height } = canvasContext(waveformCanvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, width, height, 'time (s)', 'amplitude');
  if (!lastWaveform || !lastSampleRate) return;
  const plotLeft = 46;
  const plotRight = width - 10;
  const plotTop = 12;
  const plotBottom = height - 30;
  const plotWidth = plotRight - plotLeft;
  const center = (plotTop + plotBottom) / 2;
  const span = (plotBottom - plotTop) * 0.46;
  const samplesPerPixel = Math.max(1, Math.floor(lastWaveform.length / Math.max(1, plotWidth)));
  const stroke = cssColor('--series', '#3c6382');
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = 0; px < plotWidth; px += 1) {
    const start = px * samplesPerPixel;
    const end = Math.min(lastWaveform.length, start + samplesPerPixel);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i += 1) {
      const v = lastWaveform[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const x = plotLeft + px;
    const y1 = center - max * span;
    const y2 = center - min * span;
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();
  ctx.fillStyle = cssColor('--muted', '#666');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('0', plotLeft, height - 12);
  ctx.fillText((lastWaveform.length / lastSampleRate).toFixed(1), plotRight - 18, height - 12);
}

function selectedSpectrum() {
  if (!currentPacket) return [];
  const selected = tapSelector.value;
  if (selected === 'average') return currentPacket.averageSpectrum;
  const tap = currentPacket.taps.find((item) => String(item.tapIndex) === selected);
  return tap?.spectrum ?? currentPacket.averageSpectrum;
}

function drawSpectrum() {
  const { ctx, width, height } = canvasContext(spectrumCanvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, width, height, 'frequency (Hz)', 'relative dB');
  const spectrum = selectedSpectrum();
  if (!spectrum.length) return;

  const nyquist = spectrum[spectrum.length - 1].frequencyHz;
  const requested = spectrumRange.value === 'full' ? nyquist : Number(spectrumRange.value);
  const maxHz = Math.min(nyquist, requested);
  let maxMag = 0;
  for (const bin of spectrum) {
    if (bin.frequencyHz > maxHz) break;
    if (bin.magnitude > maxMag) maxMag = bin.magnitude;
  }
  maxMag = Math.max(maxMag, 1e-12);
  const minDb = -80;
  const plotLeft = 46;
  const plotRight = width - 10;
  const plotTop = 12;
  const plotBottom = height - 30;
  const stroke = cssColor('--series', '#3c6382');
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  let started = false;
  for (const bin of spectrum) {
    if (bin.frequencyHz > maxHz) break;
    const db = Math.max(minDb, 20 * Math.log10(Math.max(bin.magnitude, 1e-15) / maxMag));
    const x = plotLeft + (bin.frequencyHz / maxHz) * (plotRight - plotLeft);
    const y = plotBottom - ((db - minDb) / -minDb) * (plotBottom - plotTop);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  const selectedTrace = tapSelector.value === 'average' ? null : currentPacket.taps.find((tap) => String(tap.tapIndex) === tapSelector.value);
  const peakHz = selectedTrace?.dominantPeakHz ?? currentPacket.summary?.dominantPeakHz ?? 0;
  if (peakHz > 0 && peakHz <= maxHz) {
    const accent = cssColor('--accent', '#9a3412');
    const x = plotLeft + (peakHz / maxHz) * (plotRight - plotLeft);
    ctx.strokeStyle = accent;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accent;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${peakHz.toFixed(1)} Hz`, Math.min(x + 4, width - 70), plotTop + 12);
  }

  ctx.fillStyle = cssColor('--muted', '#666');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('0', plotLeft, height - 12);
  ctx.fillText(Math.round(maxHz).toLocaleString(), plotRight - 38, height - 12);
  ctx.fillText('-80', 18, plotBottom + 4);
  ctx.fillText('0', 28, plotTop + 4);
}

function drawDecay() {
  const { ctx, width, height } = canvasContext(decayCanvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, width, height, 'time (ms)', 'relative dB');
  if (!currentPacket?.taps?.length) return;
  let envelope = [];
  if (tapSelector.value === 'average') {
    const envelopes = currentPacket.taps.map((tap) => tap.decayEnvelope ?? []).filter((items) => items.length);
    if (envelopes.length) {
      const count = Math.min(...envelopes.map((items) => items.length));
      envelope = Array.from({ length: count }, (_, i) => ({
        timeSeconds: envelopes[0][i].timeSeconds,
        rms: envelopes.reduce((sum, items) => sum + items[i].rms, 0) / envelopes.length,
      }));
    }
  } else {
    const selected = currentPacket.taps.find((tap) => String(tap.tapIndex) === tapSelector.value);
    envelope = selected?.decayEnvelope ?? [];
  }
  if (!envelope.length) return;
  const peak = Math.max(...envelope.map((p) => p.rms), 1e-12);
  const maxTime = envelope[envelope.length - 1].timeSeconds;
  const minDb = -40;
  const plotLeft = 46;
  const plotRight = width - 10;
  const plotTop = 12;
  const plotBottom = height - 30;
  ctx.strokeStyle = cssColor('--series2', '#6b7280');
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  envelope.forEach((point, i) => {
    const db = Math.max(minDb, 20 * Math.log10(Math.max(point.rms, 1e-15) / peak));
    const x = plotLeft + (point.timeSeconds / maxTime) * (plotRight - plotLeft);
    const y = plotBottom - ((db - minDb) / -minDb) * (plotBottom - plotTop);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const thresholdY = plotBottom - ((-20 - minDb) / -minDb) * (plotBottom - plotTop);
  ctx.strokeStyle = cssColor('--accent', '#9a3412');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(plotLeft, thresholdY);
  ctx.lineTo(plotRight, thresholdY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cssColor('--muted', '#666');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('−20', 14, thresholdY + 4);
  ctx.fillText('0', plotLeft, height - 12);
  ctx.fillText(Math.round(maxTime * 1000).toString(), plotRight - 28, height - 12);
}

function renderResult() {
  if (!currentPacket) {
    resultPanel.hidden = true;
    return;
  }
  resultPanel.hidden = false;
  peakValue.textContent = `${fmt(currentPacket.summary.dominantPeakHz, 1)} Hz`;
  decayValue.textContent = currentPacket.summary.t20Ms > 0 ? `${fmt(currentPacket.summary.t20Ms, 1)} ms` : 'unresolved';
  repeatabilityValue.textContent = `${fmt(currentPacket.summary.dominantPeakStdDevHz, 1)} Hz σ`;
  tapsValue.textContent = `${currentPacket.detectedTapCount}/${currentPacket.requestedTapCount}`;
  sampleRateValue.textContent = `${Math.round(currentPacket.sampleRateHz).toLocaleString()} Hz`;
  fftBinsValue.textContent = currentPacket.averageSpectrum.length.toLocaleString();

  tapSelector.innerHTML = '<option value="average">Average spectrum</option>' + currentPacket.taps
    .map((tap) => `<option value="${tap.tapIndex}">Tap ${tap.tapIndex}</option>`)
    .join('');
  tapSelector.value = 'average';
  drawWaveform();
  drawSpectrum();
  drawDecay();
}

function packetDate(packet) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(packet.createdAt));
  } catch {
    return packet.createdAt;
  }
}

async function renderHistory() {
  const packets = await listPackets();
  historyBody.innerHTML = '';
  historyEmpty.hidden = packets.length > 0;
  exportAllButton.disabled = packets.length === 0;
  clearHistoryButton.disabled = packets.length === 0;

  for (const packet of packets) {
    const row = document.createElement('tr');
    const truth = packet.metadata?.groundTruth || '—';
    row.innerHTML = `
      <td>${packetDate(packet)}</td>
      <td>${fmt(packet.summary?.dominantPeakHz, 1)}</td>
      <td>${packet.summary?.t20Ms > 0 ? fmt(packet.summary.t20Ms, 1) : '—'}</td>
      <td>${truth}</td>
      <td><button type="button" class="smallButton" data-export="${packet.id}">CSV</button></td>
      <td><button type="button" class="smallButton danger" data-delete="${packet.id}">Delete</button></td>`;
    historyBody.appendChild(row);
  }

  historyBody.querySelectorAll('[data-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.export;
      const packet = (await listPackets()).find((item) => item.id === id);
      if (packet) downloadCSV(`SPANK-${packet.createdAt.replaceAll(':', '-')}.csv`, packetsToCSV([packet]));
    });
  });
  historyBody.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      await deletePacket(button.dataset.delete);
      await renderHistory();
    });
  });
}

async function exportCurrent() {
  if (!currentPacket) return;
  downloadCSV(`SPANK-${currentPacket.createdAt.replaceAll(':', '-')}.csv`, packetsToCSV([currentPacket]));
}

async function exportAll() {
  const packets = await listPackets();
  if (!packets.length) return;
  downloadCSV(`SPANK-dataset-${new Date().toISOString().slice(0, 10)}.csv`, packetsToCSV(packets));
}

async function clearHistory() {
  if (!confirm('Delete all locally stored SPANK measurements from this browser?')) return;
  await clearPackets();
  await renderHistory();
}

function redraw() {
  if (!currentPacket) return;
  drawWaveform();
  drawSpectrum();
  drawDecay();
}

startButton.addEventListener('click', startMeasurement);
exportCurrentButton.addEventListener('click', exportCurrent);
exportAllButton.addEventListener('click', exportAll);
clearHistoryButton.addEventListener('click', clearHistory);
spectrumRange.addEventListener('change', drawSpectrum);
tapSelector.addEventListener('change', () => {
  drawSpectrum();
  drawDecay();
});
window.addEventListener('resize', () => requestAnimationFrame(redraw));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
}

renderHistory().catch((error) => {
  console.error(error);
  setStatus('Local storage is unavailable in this browser.', 'warning');
});
