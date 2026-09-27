// =============================================================================
//  operationsSimulation/skipHistory.js — 記録で「ほぼ毎回飛ばす工程」を数える(2026-09-18・純関数だけ)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-18 朝)「これって該当なしなんでしょ、作業としてないってだけだから、別に止まる必要がなくて
//    作業がないだけだから飛ばしてやるだけでしょ？」
//  実測(本番の写し): 傾斜回転分割_RTT-215専用 の「制御装置用意」は 完了ロット25件のうち 飛ばし19件・
//    完了6件(6秒・7秒・16秒…＝タップで通しただけ)。このテンプレでは事実上「該当なし」の工程。
//    それを「出来る人が居ない」と読んでロットを止めていた(2026-09-17 の始めない決まり)のは、このケースでは誤り。
//
//  🚨 ここは **数えるだけ**。「飛ばしてよい」と決めているのではない。記録がそうなっている、と数えて渡すだけ。
//    使う側は normalizeInput.js(alwaysSkippedProcessKeys)。積む側へ戻す口は scenario.countAlwaysSkipped(最終検査と同じ名前)。
//  🚨 判定の材料は lot.tasks の status('completed' / 'skipped')だけ。秒数や名前で推測しない。
//  🚨 鍵は soloDependency.processKeyOf(templateId, stepId)(エンジンの工程の身元と同じ物)。
//  🚨 数を決め打ちで隠さない: しきい値は引数で渡せる。既定は「飛ばし3件以上 かつ 飛ばしが完了の2倍以上」
//    (最終検査の goldenProcessHistory は「完了0件 かつ 飛ばし3件以上」。製品は 数秒の完了が混ざるので比で見る)。
// =============================================================================
import { processKeyOf } from '../soloDependency.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());

export const SKIP_HISTORY_MIN_SKIPPED = 3;
export const SKIP_HISTORY_RATIO = 2;

/**
 * テンプレ×工程ごとに 完了／飛ばし の記録を数える。
 * @param {object} o
 * @param {Array}  o.lots       全ロット(完了込み)。lot.templateId と lot.tasks({ `${stepId}-${unit}`: { status } })を読む
 * @param {Array}  o.templates  テンプレ({ id, steps:[{ id, title }] })
 * @param {number} [o.minSkipped] 飛ばしの最少件数(既定 3)
 * @param {number} [o.ratio]      飛ばし ≥ ratio × 完了(既定 2)
 * @returns {{ keys: string[], rows: Array<{ key, templateId, templateName, stepId, stepTitle, done, skipped, lots }> }}
 *   keys … 「ほぼ毎回飛ばす」と数えた工程の鍵(昇順)。rows … その工程の数(画面はこれをそのまま出す)。
 */
export function skipHistoryOf({ lots = [], templates = [], minSkipped = SKIP_HISTORY_MIN_SKIPPED, ratio = SKIP_HISTORY_RATIO } = {}) {
  const tById = new Map();
  for (const t of (Array.isArray(templates) ? templates : [])) if (isObj(t) && str(t.id)) tById.set(str(t.id), t);
  const stat = new Map();   // key -> { done, skipped, lots:Set }
  for (const lot of (Array.isArray(lots) ? lots : [])) {
    if (!isObj(lot) || !isObj(lot.tasks)) continue;
    const tid = str(lot.templateId);
    const t = tById.get(tid);
    if (!t || !Array.isArray(t.steps)) continue;
    const lotId = str(lot.id) || str(lot.lotId);
    for (const step of t.steps) {
      const sid = isObj(step) ? str(step.id) : '';
      if (!sid) continue;
      // 記録の鍵は `${stepId}-${unit}`(台ごと)。台のどれか1つでも 完了/飛ばし が在れば、そのロットの記録として数える。
      let done = 0; let skipped = 0;
      for (const [k, v] of Object.entries(lot.tasks)) {
        if (!(k === sid || k.startsWith(`${sid}-`))) continue;
        const s = isObj(v) ? str(v.status) : '';
        if (s === 'completed') done += 1; else if (s === 'skipped') skipped += 1;
      }
      if (done === 0 && skipped === 0) continue;
      const key = processKeyOf(tid, sid);
      const o = stat.get(key) || { key, templateId: tid, templateName: str(t.name), stepId: sid, stepTitle: str(step.title), done: 0, skipped: 0, lots: new Set() };
      // ロット単位で数える(台数の多いロットで水増ししない): 1ロットにつき 完了か飛ばしのどちらか1票。
      if (done > 0) o.done += 1; else o.skipped += 1;
      if (lotId) o.lots.add(lotId);
      stat.set(key, o);
    }
  }
  const minS = Math.max(1, Math.trunc(Number(minSkipped)) || SKIP_HISTORY_MIN_SKIPPED);
  const rt = Number.isFinite(Number(ratio)) && Number(ratio) > 0 ? Number(ratio) : SKIP_HISTORY_RATIO;
  const rows = [...stat.values()]
    .filter((o) => o.skipped >= minS && o.skipped >= rt * o.done)
    .map((o) => ({ key: o.key, templateId: o.templateId, templateName: o.templateName, stepId: o.stepId, stepTitle: o.stepTitle, done: o.done, skipped: o.skipped, lots: o.lots.size }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { keys: rows.map((r) => r.key), rows };
}

/** 人が読む1文(帯の札)。数はここで作らない(rows を並べるだけ)。 */
export function skipHistoryText(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const ex = list.slice(0, 3).map((r) => `${r.templateName ? `${r.templateName}／` : ''}${r.stepTitle}（飛ばし${r.skipped}・完了${r.done}）`).join('、');
  return `記録でほぼ毎回飛ばす工程 ${list.length}件は 0分として飛ばしています（例: ${ex}${list.length > 3 ? ' …' : ''}）`;
}

export default skipHistoryOf;
