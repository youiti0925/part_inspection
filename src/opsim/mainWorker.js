// =============================================================================
//  src/opsim/mainWorker.js — ロットの「主担当」を1人に決める。純関数。
// -----------------------------------------------------------------------------
//  🚨 決まり14-2（2026-09-03 清水さん）「作業者が二人いるけど、どっちか選択しないとおかしいだろ」
//     割付は台ごとに人を替える事があり（実測: 152ロットのうち 102ロットが2人以上）、
//     1行に「村・片山」と2人並べると「誰がやるのか」が答えにならない。
//
//  決め方（ここは私の規則。割付そのものは変えない）:
//    ・その人が持つ **分数** が一番多い人を主担当にする（partner=OJTの受け手は数えない）。
//    ・主担当の割合が helperShare（既定 0.75）を下回る時だけ、2番目の人を「分担の相手」として返す。
//      画面はこれを「決められない理由」（＋◯◯と台を分担 39%）として小さく出す。
//  🚨 名前を隠して点だけにする（Codex 129ee00 の形）はしない。決めるのと隠すのは違う。
// =============================================================================
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {Array<{worker:string, partner?:string|null, startMs:number, endMs:number}>} assignmentsOfLot
 * @param {object} [o]
 * @param {number} [o.helperShare=0.75] 主担当の割合がこれ未満なら分担の相手を返す
 * @returns {{worker:string, share:number|null, minutes:number, helper:string, helperShare:number|null,
 *            partners:string[], byWorker:Array<{name:string, minutes:number}>}}
 *   worker が '' ＝ 割付が1件も無い（画面は「未定」と理由を出す）。
 */
export function mainWorkerOf(assignmentsOfLot, { helperShare = 0.75 } = {}) {
  const mins = new Map();
  const partners = new Set();
  (Array.isArray(assignmentsOfLot) ? assignmentsOfLot : []).forEach((a) => {
    if (!a) return;
    const w = str(a.worker);
    const s = Number(a.startMs); const e = Number(a.endMs);
    if (!w || !isNum(s) || !isNum(e) || e <= s) return;
    mins.set(w, (mins.get(w) || 0) + (e - s) / 60000);
    const p = str(a.partner);
    if (p) partners.add(p);
  });
  const byWorker = [...mins.entries()]
    .map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'ja'));
  if (!byWorker.length) {
    return { worker: '', share: null, minutes: 0, helper: '', helperShare: null, partners: [...partners], byWorker };
  }
  const total = byWorker.reduce((a, r) => a + r.minutes, 0) || 1;
  const main = byWorker[0];
  const share = main.minutes / total;
  const cut = isNum(helperShare) ? helperShare : 0.75;
  const second = byWorker.length > 1 && share < cut ? byWorker[1] : null;
  return {
    worker: main.name,
    share,
    minutes: main.minutes,
    helper: second ? second.name : '',
    helperShare: second ? second.minutes / total : null,
    partners: [...partners],
    byWorker,
  };
}

/** assignments 全体を lotId ごとに束ねる（mainWorkerOf に渡す形）。 */
export function assignmentsByLot(assignments) {
  const m = new Map();
  (Array.isArray(assignments) ? assignments : []).forEach((a) => {
    if (!a || a.lotId == null) return;
    const id = String(a.lotId);
    let list = m.get(id);
    if (!list) { list = []; m.set(id, list); }
    list.push(a);
  });
  return m;
}

export default mainWorkerOf;
