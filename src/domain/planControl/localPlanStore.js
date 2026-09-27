import { prepareAdoption, capturePlan, taskKey } from './planControl.js';

export function validateStored(plan) {
  if (!plan || plan.version !== 1 || plan.status !== 'committed' || !Number.isInteger(plan.revision) || plan.revision < 1
    || !Array.isArray(plan.tasks) || !Array.isArray(plan.qualityIssues) || !plan.context || !plan.source) throw new Error('保存した計画を読み取れません');
  if (new Set(plan.tasks.map(t => t.key)).size !== plan.tasks.length) throw new Error('保存した仕事が重複しています');
  if (plan.tasks.some(t => taskKey(t) !== t.key)) throw new Error('保存した仕事の識別情報が一致しません');
  capturePlan({ id: plan.id, context: plan.context, source: plan.source,
    jobs: plan.tasks, assignments: plan.tasks.filter(t => t.assignment).map(t => ({ ...t.assignment, jobId: t.jobId })),
    qualityIssues: plan.qualityIssues, liveStateByKey: Object.fromEntries(plan.tasks.map(t => [t.key, t.workState])) });
  if (!Number.isFinite(plan.committedAt) || typeof plan.committedBy !== 'string') throw new Error('保存情報が不正です');
  return plan;
}

// IndexedDB transactions serialize concurrent adoptions across tabs. This is
// device-local, not a shared factory instruction store. No network writes.
export function createLocalPlanStore(indexedDB = globalThis.indexedDB) {
  let connection;
  async function db() {
    if (!indexedDB) throw new Error('この端末では計画を保存できません');
    if (!connection) connection = new Promise((resolve, reject) => {
      const r = indexedDB.open('inspection-plan-control-v1', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('heads'); r.result.createObjectStore('plans', { keyPath: 'id' }); };
      r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); connection = null; }; resolve(r.result); };
      r.onerror = () => { connection = null; reject(r.error); };
      r.onblocked = () => { connection = null; reject(new Error('別タブを閉じてから保存を開いてください')); };
    });
    return connection;
  }
  return {
    async read(app) {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction(['heads', 'plans'], 'readonly'); let value = null;
        const h = t.objectStore('heads').get(app);
        h.onsuccess = () => { if (h.result) {
          const p = t.objectStore('plans').get(h.result.id);
          p.onsuccess = () => { try { value = validateStored(p.result); if (value.revision !== h.result.revision) throw new Error('保存版が一致しません'); } catch (e) { reject(e); } };
        } };
        t.oncomplete = () => resolve(value); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('読込を中止しました'));
      });
    },
    async adopt(app, getOptions) {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction(['heads', 'plans'], 'readwrite'); let result, failure;
        const h = t.objectStore('heads').get(app);
        h.onsuccess = () => {
          const proceed = baseline => {
            try {
              const options = getOptions(); // live props, read inside transaction
              if (options.proposal.context.app !== app) throw new Error('アプリが一致しません');
              result = prepareAdoption({ ...options, baseline, headRevision: baseline?.revision || 0 });
              if (!result.ok) return;
              t.objectStore('plans').add(result.snapshot);
              t.objectStore('heads').put({ id: result.snapshot.id, revision: result.snapshot.revision }, app);
            } catch (e) { failure = e; t.abort(); }
          };
          if (!h.result) proceed(null);
          else { const p = t.objectStore('plans').get(h.result.id); p.onsuccess = () => {
            try { const p0 = validateStored(p.result); if (p0.revision !== h.result.revision) throw new Error('保存版が一致しません'); proceed(p0); } catch (e) { failure = e; t.abort(); }
          }; }
        };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(failure || t.error);
        t.onabort = () => reject(failure || t.error || new Error('保存を中止しました'));
      });
    },
  };
}
