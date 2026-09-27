import { compareFullPair } from '../../domain/fullPair/scheduler.mjs';
self.onmessage = ({ data }) => {
  const rows = [];
  for (const c of data.candidates) {
    self.postMessage({ requestKey: data.requestKey, rows, done: false, activeLabel: c.label });
    let result;
    try {
      result = c.cached || (c.errors?.length ? { status: 'unknown', recommended: false, errors: c.errors } : compareFullPair(c.input, { beamWidth: 128, maxExpansions: 100000, ...(data.options || {}), ...(c.options || {}) }));
    } catch (e) { result = { status: 'unknown', errors: [String(e?.message || e)], recommended: false }; }
    rows.push({ key: c.key, label: c.label, result });
    self.postMessage({ requestKey: data.requestKey, rows, done: rows.length === data.candidates.length, activeLabel: '' });
  }
};
