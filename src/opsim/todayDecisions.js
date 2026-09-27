/* ============================================================================
 * 今日決めること ／ 遅れる・止まるロットの理由（2026-09-23 清水さん「1,2,3でやって」）
 * ----------------------------------------------------------------------------
 * 問い: 「管理者が今日 何を決めれば、いちばん多くのロットが前へ進むか」。
 *   帯の札（仮の入荷日・納期の更新が必要…）は **件数** は言うが、どれから手を付けるかを言わなかった。
 *   ここは エンジンの答え(lotResults)を **ロットごとに理由1つ** に振り分け、決める事の形で数える。
 *
 * 🚨 1件のロットは 1つの理由にだけ入る（足すと合計になる。表の見出しの件数と一致する）。
 *   振り分けの順（先に当たった物）:
 *     ① 入荷が納期より後（納期の更新が必要）… 帯の札と **同じ一覧** をそのまま数える（製品検査だけ）
 *     ② もう納期を過ぎている（alreadyPastDue）
 *     ③ 手が付かない理由（blocked。エンジンの UNRESOLVED_REASON をそのまま読む。文言で比べない）
 *     ④ 遅れる（late）… 入荷日が仮のロットは「入荷日を確かめる」、それ以外は「人か時間が足りない」
 *     ⑤ 納期の記録が無い（判定がつかない）
 * 🚨 件数は「その理由で遅れる・止まるロットの数」。**外した後の計算はしていない**（打った効き目の実測ではない）。
 *   画面の言葉も「関わるロット」に留め、「◯件 間に合うようになる」とは言わない。
 * ⚠ 製品・最終で同じ中身（md5 の対）。片方だけ直さない。
 * ========================================================================== */
import { UNRESOLVED_REASON, UNJUDGEABLE } from '../domain/operationsSimulation/simulate.js';

/** 決める事の一覧。並びは同数の時の順（止まる物 → 人 → 入力）。 */
export const DECISION_KINDS = Object.freeze([
  { key: 'conflict', verb: '納期を直す', why: '入荷が納期より後', tone: 'rose' },
  { key: 'past', verb: '納期を決め直す', why: 'もう納期を過ぎている', tone: 'rose' },
  { key: 'time', verb: '応援・残業を決める', why: '人か時間が足りない(納期をずらす手もある)', tone: 'pink' },
  { key: 'skill', verb: 'やる人を決める・教える', why: 'この工程をやった記録のある人がいない', tone: 'violet' },
  { key: 'support', verb: '応援の予定を見直す', why: 'やれる人がずっと他の工場の応援', tone: 'sky' },
  { key: 'away', verb: '休みの間の代わりを決める', why: 'やれる人がずっと休み', tone: 'sky' },
  { key: 'noTime', verb: '勤務の時間を入れる', why: 'この期間に働ける時間が無い', tone: 'slate' },
  { key: 'pin', verb: '固定した担当を見直す', why: '手で決めた担当のところで止まっている', tone: 'amber' },
  { key: 'arrival', verb: '入荷日を確かめる', why: '仮の入荷日のまま遅れる・入荷日が分からない', tone: 'amber' },
  { key: 'duration', verb: '目標時間を1回測る', why: '目標の作業時間が無い工程がある', tone: 'slate' },
  { key: 'noDue', verb: '納期を入れる', why: '納期の記録が無い', tone: 'slate' },
  { key: 'other', verb: '前の工程から見直す', why: '前の工程が止まっている', tone: 'slate' },
]);

const KIND_ORDER = new Map(DECISION_KINDS.map((k, i) => [k.key, i]));

const BLOCKED_TO_KIND = new Map([
  [UNRESOLVED_REASON.NO_CANDIDATE, 'skill'],
  [UNRESOLVED_REASON.ALL_CANDIDATES_AWAY, 'away'],
  [UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_PRODUCT, 'support'],
  [UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL, 'support'],
  [UNRESOLVED_REASON.NO_WORK_TIME, 'noTime'],
  [UNRESOLVED_REASON.TOO_LONG, 'time'],
  [UNRESOLVED_REASON.PINNED_NOT_ELIGIBLE, 'pin'],
  [UNRESOLVED_REASON.PINNED_NONE, 'pin'],
  [UNRESOLVED_REASON.DURATION_UNKNOWN, 'duration'],
  [UNRESOLVED_REASON.ARRIVAL_UNKNOWN, 'arrival'],
  [UNRESOLVED_REASON.PREV_UNRESOLVED, 'other'],
]);

const idSet = (v) => new Set((Array.isArray(v) ? v : []).map((x) => String(x && typeof x === 'object' ? (x.lotId ?? x.id ?? '') : x)).filter(Boolean));

/** 1件のロットの理由（どれにも当たらなければ null = 困っていない）。 */
export function decisionKindOf(r, { conflicts, assumed } = {}) {
  if (!r || r.lotId == null) return null;
  const id = String(r.lotId);
  if (conflicts && conflicts.has(id)) return 'conflict';
  if (r.alreadyPastDue === true) return 'past';
  if (r.blocked != null && r.blocked !== '') return BLOCKED_TO_KIND.get(String(r.blocked)) || 'other';
  if (r.late === true) return assumed && assumed.has(id) ? 'arrival' : 'time';
  if (r.judgeable === false && r.unknownReason === UNJUDGEABLE.NO_DUE) return 'noDue';
  return null;
}

/**
 * @param {{ lotResults?: any[], conflictLotIds?: any[], assumedLotIds?: any[] }} args
 * @returns {{ rows: Array<{key,verb,why,tone,n,lotIds:string[]}>, total:number, top:Array, max:number }}
 *   rows … 0件の理由は入れない。多い順（同数は DECISION_KINDS の順）。
 *   total … rows の n の合計（= 振り分けたロットの数）。
 *   top … 今日決めること = rows の上から3つ。
 */
export function todayDecisionsOf({ lotResults = [], conflictLotIds = [], assumedLotIds = [] } = {}) {
  const conflicts = idSet(conflictLotIds);
  const assumed = idSet(assumedLotIds);
  const byKind = new Map();
  const seen = new Set();
  const add = (kind, id) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(id);
  };
  // ① 納期の更新が必要は 帯の札と同じ一覧をそのまま（期間の外のロットも札は数えている → ここも数える）
  conflicts.forEach((id) => add('conflict', id));
  for (const r of Array.isArray(lotResults) ? lotResults : []) {
    const kind = decisionKindOf(r, { conflicts, assumed });
    if (kind) add(kind, String(r.lotId));
  }
  const rows = DECISION_KINDS
    .filter((k) => byKind.has(k.key))
    .map((k) => ({ ...k, n: byKind.get(k.key).length, lotIds: byKind.get(k.key) }))
    .sort((a, b) => (b.n - a.n) || (KIND_ORDER.get(a.key) - KIND_ORDER.get(b.key)));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.n), 0);
  return { rows, total, top: rows.slice(0, 3), max };
}
