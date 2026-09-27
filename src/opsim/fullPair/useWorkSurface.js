import { useEffect, useState } from 'react';

// Mount ONCE above map/modal/list. Switching surfaces reuses one observation.
export function useWorkSurface({ input, observation, workerId, currentLotId }) {
  const key = JSON.stringify({ input, observation, workerId, currentLotId });
  const [result, setResult] = useState(null);
  useEffect(() => {
    let alive = true, worker;
    try {
      worker = new Worker(new URL('./workSurface.worker.mjs', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { if (alive && data.key === key) setResult(data); };
      worker.onerror = e => { if (alive) setResult({ key, error: e.message || '組合せを計算できませんでした' }); };
      worker.postMessage({ key, ...JSON.parse(key) });
    } catch (e) { queueMicrotask(() => { if (alive) setResult({ key, error: String(e.message || e) }); }); }
    return () => { alive = false; worker?.terminate(); };
  }, [key]);
  return result?.key === key ? { ...result, calculating: false } : { calculating: true };
}
