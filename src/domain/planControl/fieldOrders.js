// =============================================================================
// 👷 現場への指示は「採用中の計画の版」から出す(2026-09-22)。
// -----------------------------------------------------------------------------
// 🚨 新しい試算(画面で押した直後の答え)を そのまま現場の指示にしない。
//   現場が見る物 = 共有棚の採用中の版(保存された物)。試算はあくまで比べる為の物。
//   作業者に分かる事: ① 自分がどの版で動くのか ② 今日どこで何をどの順で いつまでに
//   ③ 前の版から何が変わったか(担当・順番・時刻・納期・場所)。
//
// 🚨 純関数だけ。既存の「今日の指示」(TodayOrders)が読む割付の形(worker/partner/startMs/endMs/lotId)へ
//   変換するだけで、指示の描き方は今の画面を使う(新しい大型カードは作らない)。
// =============================================================================
import { comparePlans } from './planControl.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

/** 採用中の版の工程 → 「今日の指示」が読む割付の並び。未割付は載せない(指示ではない)。 */
export function assignmentsFromPlan(plan) {
  if (!isObj(plan) || !Array.isArray(plan.tasks)) return [];
  const out = [];
  for (const t of plan.tasks) {
    const a = t && t.assignment;
    if (!isObj(a) || !Number.isFinite(a.startMs) || !Number.isFinite(a.endMs) || !str(a.worker)) continue;
    out.push({
      jobId: t.jobId, lotId: t.lotId, templateId: t.templateId, stepId: t.stepId, unitIndex: t.unitIndex,
      worker: a.worker, partner: a.partner || null, startMs: a.startMs, endMs: a.endMs,
      ...(a.zone ? { zone: a.zone } : {}),
      dueMs: Number.isFinite(t.dueMs) ? t.dueMs : null, planKey: t.key,
    });
  }
  out.sort((x, y) => x.startMs - y.startMs || String(x.worker).localeCompare(String(y.worker)));
  return out;
}

/** その人の その日の並び(開始順の鍵の列)。 */
function orderKeys(plan, name, dayStartMs, dayEndMs) {
  return (plan.tasks || []).filter((t) => t.assignment && t.assignment.worker === name
    && t.assignment.startMs < dayEndMs && t.assignment.endMs > dayStartMs)
    .sort((a, b) => a.assignment.startMs - b.assignment.startMs).map((t) => t.key);
}
/**
 * 「順番が変わった」= 両方の版に在る仕事の中で **相対の並び** が変わった物だけ。
 * 🚨 1件が外れただけで後ろ全部の番号がずれる。それを順番の変更と言うと、作業者には雑音になる
 *   (写しで 21件中20件が「順番」になった)。両方に在る仕事のうち自分より前に在る顔ぶれで比べる。
 */
function orderChangedKeys(prevPlan, plan, name, dayStartMs, dayEndMs) {
  const p = orderKeys(prevPlan, name, dayStartMs, dayEndMs), c = orderKeys(plan, name, dayStartMs, dayEndMs);
  const common = new Set(p.filter((k) => c.includes(k)));
  const pc = p.filter((k) => common.has(k)), cc = c.filter((k) => common.has(k));
  // 動いた物の最小の集まり = 前の並びの番号の列から「最長の増える部分列」を除いた物。
  //   1件が6件を飛び越えたら、動いたのはその1件(飛び越された6件ではない)。
  const pos = new Map(pc.map((k, i) => [k, i]));
  const seq = cc.map((k) => pos.get(k));
  const n = seq.length, len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let best = -1; for (let i = 0; i < n; i += 1) if (best < 0 || len[i] > len[best]) best = i;
  const keep = new Set(); for (let i = best; i >= 0; i = prev[i]) keep.add(cc[i]);
  return new Set(cc.filter((k) => !keep.has(k)));
}

export const CHANGE_KIND_LABELS = Object.freeze({ worker: '担当', order: '順番', time: '時刻', due: '納期', zone: '場所', added: '追加', removed: '外れた' });

/**
 * 前の版からの変更(その人・その日)。
 * @returns {Array<{key, kinds:string[], labels:string[], before, after}>}  比べられない(期間が違う等)なら null
 */
export function changesForWorker(prevPlan, plan, name, dayStartMs, dayEndMs) {
  if (!isObj(prevPlan) || !isObj(plan) || !str(name)) return null;
  let diff;
  try { diff = comparePlans(prevPlan, plan); } catch { return null; }
  const orderChanged = orderChangedKeys(prevPlan, plan, name, dayStartMs, dayEndMs);
  const out = [];
  const inDay = (t) => t && t.assignment && t.assignment.startMs < dayEndMs && t.assignment.endMs > dayStartMs;
  for (const c of diff.changes) {
    const b = c.before, a = c.after;
    const mineBefore = !!(b && b.assignment && b.assignment.worker === name && inDay(b));
    const mineAfter = !!(a && a.assignment && a.assignment.worker === name && inDay(a));
    if (!mineBefore && !mineAfter) continue;
    const kinds = [];
    if (mineBefore && !mineAfter) kinds.push(a && a.assignment && a.assignment.worker !== name ? 'worker' : 'removed');
    else if (!mineBefore && mineAfter) kinds.push(b && b.assignment && b.assignment.worker && b.assignment.worker !== name ? 'worker' : 'added');
    else {
      if (b.assignment.startMs !== a.assignment.startMs || b.assignment.endMs !== a.assignment.endMs) kinds.push('time');
      if ((b.assignment.zone || null) !== (a.assignment.zone || null)) kinds.push('zone');
      if (c.changes && c.changes.includes('dueMs')) kinds.push('due');
      if (orderChanged.has(c.key)) kinds.push('order');
    }
    if (kinds.length === 0) continue;
    out.push({ key: c.key, kinds, labels: kinds.map((k) => CHANGE_KIND_LABELS[k]), before: b || null, after: a || null });
  }
  // 順番だけ変わった(比較の changes に載らない)物も拾う
  for (const key of orderChanged) {
    if (!out.some((x) => x.key === key)) {
      const t = plan.tasks.find((x) => x.key === key), p = prevPlan.tasks.find((x) => x.key === key);
      out.push({ key, kinds: ['order'], labels: ['順番'], before: p || null, after: t || null });
    }
  }
  return out;
}

/** 画面の1行「第N版（承認済み・9/22 12:51）に基づく指示」。 */
export function fieldPlanLine({ revision, reviewLabel, committedAt, fmt }) {
  if (!Number.isInteger(revision)) return 'まだ保存した計画がありません（今の試算を表示しています。現場の指示ではありません）';
  const when = typeof fmt === 'function' && Number.isFinite(committedAt) ? fmt(committedAt) : '';
  return `現場の指示は 第${revision}版（${reviewLabel || '保存済み'}${when ? '・' + when : ''}）に基づきます`;
}

/** 開いている間に新しい版が保存されたか。 */
export function newerVersionNotice(shownRevision, headRevision) {
  if (!Number.isInteger(headRevision) || !Number.isInteger(shownRevision)) return '';
  if (headRevision <= shownRevision) return '';
  return `新しい第${headRevision}版が保存されました。表示は第${shownRevision}版のままです。読み直してください`;
}

/** その日の窓(端末の暦で 0:00〜24:00)。今日の指示・変更の比較に使う。 */
export function dayWindowOf(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { start, end: start + 24 * 3600 * 1000 };
}
