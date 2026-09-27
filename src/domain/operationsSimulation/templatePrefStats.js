// =============================================================================
//  operationsSimulation/templatePrefStats.js — 「このテンプレを優先」が **どれだけ効いたか** を数える純関数(2026-09-17)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-16 深夜)「テンプレート優先設定してるのに 優先されているのかまったくわからん。優先率ってはなしだね」
//
//  答える1行: 「その人が優先にしたテンプレの仕事が この期間に N件 在り、そのうち M件をその人がやる(率 M/N)」
//  🚨 ここで割付を変えない。割付の答え(assignments)と 仕事の一覧(normalized.jobs)と 設定(prefs)を突き合わせるだけ。
//  🚨 数えるのは **仕事(job)** の単位(台×工程)。ロットの単位ではない(1ロットの中で人が替わる事がある)。
//  🚨 分母が0(その期間に優先テンプレの仕事が無い)なら 率は null(0% と書かない)。
// =============================================================================

const str = (v) => (v == null ? '' : String(v)).trim();

/**
 * @param {object} o
 * @param {Array}  o.assignments  simulate の base.assignments([{ jobId, lotId, worker, partner, pickedFor? }])
 * @param {Array}  o.jobs         normalized.jobs([{ jobId, lotId, templateId }])
 * @param {object} o.prefs        { 作業者名: [テンプレid, …] }(settings.workerProfiles[名前].templatePrefs を集めた物)
 * @returns {{ byWorker: Object<string, { templates:string[], total:number, mine:number, rate:number|null, elsewhere:Array<{lotId:string, jobId:string, templateId:string, worker:string}> }>, workers:string[] }}
 */
export function templatePrefStats({ assignments = [], jobs = [], prefs = {} } = {}) {
  const jobById = new Map();
  for (const j of (Array.isArray(jobs) ? jobs : [])) if (j && j.jobId != null) jobById.set(str(j.jobId), j);
  const workerByJob = new Map();
  for (const a of (Array.isArray(assignments) ? assignments : [])) {
    if (!a || a.jobId == null) continue;
    const id = str(a.jobId);
    if (!workerByJob.has(id)) workerByJob.set(id, str(a.worker));
  }
  const byWorker = {};
  const table = (prefs && typeof prefs === 'object') ? prefs : {};
  for (const [name0, list] of Object.entries(table)) {
    const name = str(name0);
    const templates = (Array.isArray(list) ? list : []).map(str).filter(Boolean);
    if (!name || !templates.length) continue;
    const set = new Set(templates);
    let total = 0; let mine = 0; const elsewhere = [];
    for (const [jobId, w] of workerByJob) {
      const j = jobById.get(jobId);
      if (!j || !set.has(str(j.templateId))) continue;
      total += 1;
      if (w === name) mine += 1;
      else elsewhere.push({ lotId: str(j.lotId), jobId, templateId: str(j.templateId), worker: w });
    }
    byWorker[name] = { templates, total, mine, rate: total > 0 ? mine / total : null, elsewhere };
  }
  return { byWorker, workers: Object.keys(byWorker) };
}

/** 1行の言い方(画面はこれをそのまま出す)。 */
export function templatePrefText(stat) {
  if (!stat) return '';
  if (stat.total === 0) return '優先テンプレの仕事は この期間に在りません';
  const pct = stat.rate == null ? '—' : `${Math.round(stat.rate * 100)}%`;
  return `優先テンプレの仕事 ${stat.total}件中 ${stat.mine}件をこの人が担当（${pct}）`;
}

export default templatePrefStats;
