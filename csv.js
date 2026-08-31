function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

const COLUMNS = [
  'row_type', 'packet_id', 'created_at', 'sample_rate_hz', 'capture_duration_s',
  'variety', 'brix', 'ground_truth', 'notes',
  'tap_index', 'trigger_time_s', 'dominant_peak_hz', 't20_ms', 'decay_method',
  'dominant_peak_stddev_hz', 't20_stddev_ms',
  'frequency_hz', 'magnitude'
];

function row(values) {
  return COLUMNS.map((key) => csvCell(values[key])).join(',');
}

export function packetRows(packet) {
  const shared = {
    packet_id: packet.id,
    created_at: packet.createdAt,
    sample_rate_hz: packet.sampleRateHz,
    capture_duration_s: packet.captureDurationSeconds,
    variety: packet.metadata?.variety ?? '',
    brix: packet.metadata?.brix ?? '',
    ground_truth: packet.metadata?.groundTruth ?? '',
    notes: packet.metadata?.notes ?? '',
  };
  const rows = [];
  rows.push(row({
    ...shared,
    row_type: 'packet_summary',
    dominant_peak_hz: packet.summary?.dominantPeakHz,
    t20_ms: packet.summary?.t20Ms,
    dominant_peak_stddev_hz: packet.summary?.dominantPeakStdDevHz,
    t20_stddev_ms: packet.summary?.t20StdDevMs,
  }));

  for (const tap of packet.taps ?? []) {
    rows.push(row({
      ...shared,
      row_type: 'tap_summary',
      tap_index: tap.tapIndex,
      trigger_time_s: tap.triggerTimeSeconds,
      dominant_peak_hz: tap.dominantPeakHz,
      t20_ms: tap.t20Seconds * 1000,
      decay_method: tap.decayMethod,
    }));
    for (const bin of tap.spectrum ?? []) {
      rows.push(row({
        row_type: 'tap_spectrum',
        packet_id: packet.id,
        tap_index: tap.tapIndex,
        frequency_hz: bin.frequencyHz,
        magnitude: bin.magnitude,
      }));
    }
  }

  for (const bin of packet.averageSpectrum ?? []) {
    rows.push(row({
      row_type: 'average_spectrum',
      packet_id: packet.id,
      frequency_hz: bin.frequencyHz,
      magnitude: bin.magnitude,
    }));
  }
  return rows;
}

export function packetsToCSV(packets) {
  const lines = [COLUMNS.join(',')];
  for (const packet of packets) lines.push(...packetRows(packet));
  return lines.join('\n');
}

export function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
