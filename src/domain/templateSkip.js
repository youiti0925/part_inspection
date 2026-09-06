// ============================================================================
// 🧾 型式×テンプレ単位の 抜取／スキップ（製品検査・部品検査）— 純関数だけ
// ----------------------------------------------------------------------------
// 清水さん(2026-09-06):
//   「製品検査にも抜取とスキップ機能を追加してほしくて、こっちは項目毎じゃなくて 型式テンプレ毎で、
//     その作業中に不具合の有無で判定していきたい。SS系の型式は実際いまスキップだから、工程に流れて
//     きてもすぐ流して検査リストから削除している。部品検査にもこの機能が要る。今後このアプリを使う
//     時にこの機能がアプリ上に無いと負荷計算ができないから、今のうちに準備をしたい」
//
// 形(最終検査の項目ごとの抜取と同じ考え・単位だけ 型式×テンプレ):
//   ・判定の単位 = 型式 × テンプレート(key = `${model}::${templateId}`)
//   ・許可(allow)を与えた組だけが対象。既定は「与えていない」= 全数。絶対に減らさない(never)は常に全数。
//   ・条件 = 同じ組の完了ロットを新しい順に見て、欠点(NG)なしが 連続 qualifyLots 以上(既定 5)。
//     欠点が1件でも出たロットで連続は切れる(= その作業中の不具合の有無で判定)。
//   ・減らし方 = ロットごとのスキップ。ただし lotSkipEvery ロットに1回は全数(既定 4)。
//   ・スキップと決めたロットは **消さない**。全工程を「システム(抜取判定)」の skipped で作り、
//     検査リストには『スキップ』の札で残す(押して完了にするだけ)。→ 負荷計算(操業シミュレーション)は
//     残り工程 0 として数える(isDoneTask が skipped を「もう時間は掛からない」側に置く)。
//
// ⚠⚠ ここで時計を読まない(nowMs を受け取る)。数字を作らない(実測の分だけ)。
// ⚠ React も firebase も import しない(node --test で回す)。
// ============================================================================

const isObj = (v) => !!v && typeof v === 'object';
const str = (v) => String(v == null ? '' : v).trim();
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const toMs = (v) => { if (v == null || v === '') return 0; if (typeof v === 'number') return Number.isFinite(v) ? v : 0; if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; } if (isObj(v) && typeof v.seconds === 'number') return v.seconds * 1000; if (isObj(v) && typeof v.toMillis === 'function') { try { return v.toMillis(); } catch { return 0; } } return 0; };

export const TEMPLATE_SKIP_DEFAULT = Object.freeze({
  enabled: false,
  default: Object.freeze({
    qualifyLots: 5,     // 連続無欠点ロット数(同じ 型式×テンプレ)
    lotSkipEvery: 4,    // N ロットに1回は全数
  }),
  allow: Object.freeze({}),   // { [key]: true }
  never: Object.freeze({}),   // { [key]: true }  絶対に減らさない
  byKey: Object.freeze({}),   // { [key]: { qualifyLots, lotSkipEvery } } 組ごとの上書き
  history: Object.freeze([]), // [{ t, by, action, target, detail }] 新しい順
});

export const templateSkipKey = (model, templateId) => `${str(model)}::${str(templateId)}`;

/** 設定の正規化。⚠ 壊れた値は既定へ(黙って 0 にしない)。 */
export const normalizeTemplateSkipCfg = (raw) => {
  const r = isObj(raw) ? raw : {};
  const d = isObj(r.default) ? r.default : {};
  const q = Math.trunc(num(d.qualifyLots, TEMPLATE_SKIP_DEFAULT.default.qualifyLots));
  const e = Math.trunc(num(d.lotSkipEvery, TEMPLATE_SKIP_DEFAULT.default.lotSkipEvery));
  return {
    enabled: r.enabled === true,
    default: { qualifyLots: q >= 1 ? q : TEMPLATE_SKIP_DEFAULT.default.qualifyLots, lotSkipEvery: e >= 2 ? e : TEMPLATE_SKIP_DEFAULT.default.lotSkipEvery },
    allow: isObj(r.allow) ? { ...r.allow } : {},
    never: isObj(r.never) ? { ...r.never } : {},
    byKey: isObj(r.byKey) ? { ...r.byKey } : {},
    history: Array.isArray(r.history) ? [...r.history] : [],
  };
};

/** その組に効く条件(組ごとの上書き → 全体既定)。 */
export const conditionsFor = (cfg, key) => {
  const c = normalizeTemplateSkipCfg(cfg);
  const o = isObj(c.byKey[key]) ? c.byKey[key] : {};
  const q = Math.trunc(num(o.qualifyLots, c.default.qualifyLots));
  const e = Math.trunc(num(o.lotSkipEvery, c.default.lotSkipEvery));
  return { qualifyLots: q >= 1 ? q : c.default.qualifyLots, lotSkipEvery: e >= 2 ? e : c.default.lotSkipEvery };
};

/** ロットに欠点(NG)が1件でも在るか。⚠ 判定はタスクの status だけ(不具合登録の別集計は読まない=同じ物差し)。 */
export const lotHadNg = (lot) => {
  if (!isObj(lot)) return false;
  if (num(lot.ngCount, 0) > 0) return true;
  const tasks = isObj(lot.tasks) ? Object.values(lot.tasks) : [];
  return tasks.some((t) => isObj(t) && (t.status === 'ng' || num(t.ngCount, 0) > 0));
};

/** このロットは「抜取判定でスキップした」ロットか。 */
export const isTemplateSkippedLot = (lot) => !!(isObj(lot) && isObj(lot.templateSkip) && lot.templateSkip.skip === true);

const completedMs = (l) => toMs(l.completedAt) || toMs(l.updatedAt) || toMs(l.entryAt) || toMs(l.createdAt);
const isCompleted = (l) => isObj(l) && (l.status === 'completed' || l.location === 'completed');

/**
 * その組の実績。完了ロットを新しい順に並べて数える。
 *   streak      … 直近から続く「欠点なしで **検査した**」完了ロットの数(スキップしたロットは数えない・切りもしない)
 *   sinceFull   … 直近の「検査した」完了ロットより後に、スキップで流したロットが何本続いているか(未完了も含む)
 *   lastNgAt    … 直近の欠点があったロットの完了時刻(無ければ null)
 *   inspected   … 検査した完了ロットの数(全期間)
 */
export const streakOf = (lots, key, { excludeLotId = null } = {}) => {
  const rows = (Array.isArray(lots) ? lots : [])
    .filter((l) => isObj(l) && l.id !== excludeLotId && templateSkipKey(l.model, l.templateId) === key);
  const done = rows.filter(isCompleted).sort((a, b) => completedMs(b) - completedMs(a));
  let streak = 0, lastNgAt = null, inspected = 0, broken = false;
  for (const l of done) {
    if (isTemplateSkippedLot(l)) continue;               // 流しただけ。数えも切りもしない
    inspected += 1;
    if (lotHadNg(l)) { if (!broken) { broken = true; lastNgAt = completedMs(l) || null; } continue; }
    if (!broken) streak += 1;
  }
  // 直近の「検査した」ロットより新しい物のうち、スキップで流した本数(完了・未完了とも)
  const newest = rows.slice().sort((a, b) => (completedMs(b) || toMs(b.createdAt)) - (completedMs(a) || toMs(a.createdAt)));
  let sinceFull = 0;
  for (const l of newest) { if (isTemplateSkippedLot(l)) sinceFull += 1; else break; }
  return { key, streak, sinceFull, lastNgAt, inspected, completed: done.length, total: rows.length };
};

/**
 * 新しいロット(model, templateId)を いま作るなら スキップしてよいか。
 * @returns {{ skip:boolean, reason:string, key, streak, need, every, sinceFull, allowed, never, enabled }}
 *   reason: 'off' | 'never' | 'not-allowed' | 'not-enough' | 'every-nth' | 'skip'
 */
export const judgeTemplateSkip = ({ model, templateId, lots = [], cfg = null, excludeLotId = null } = {}) => {
  const c = normalizeTemplateSkipCfg(cfg);
  const key = templateSkipKey(model, templateId);
  const cond = conditionsFor(c, key);
  const st = streakOf(lots, key, { excludeLotId });
  const base = { key, streak: st.streak, need: cond.qualifyLots, every: cond.lotSkipEvery, sinceFull: st.sinceFull, lastNgAt: st.lastNgAt,
    allowed: c.allow[key] === true, never: c.never[key] === true, enabled: c.enabled };
  if (!c.enabled) return { ...base, skip: false, reason: 'off' };
  if (c.never[key] === true) return { ...base, skip: false, reason: 'never' };
  if (c.allow[key] !== true) return { ...base, skip: false, reason: 'not-allowed' };
  if (st.streak < cond.qualifyLots) return { ...base, skip: false, reason: 'not-enough' };
  if (st.sinceFull >= cond.lotSkipEvery - 1) return { ...base, skip: false, reason: 'every-nth' };
  return { ...base, skip: true, reason: 'skip' };
};

export const JUDGE_REASON_TEXT = Object.freeze({
  off: '機能が停止中（全数）',
  never: '絶対に減らさない（全数）',
  'not-allowed': '許可していない（全数）',
  'not-enough': '連続無欠点ロット数がまだ足りない（全数）',
  'every-nth': 'N ロットに1回の全数の番',
  skip: 'スキップ（検査せず流す）',
});

/**
 * スキップと決めたロットの tasks。全工程を「システム(抜取判定)」の skipped で作る。
 * ⚠ 形は 型式別プロファイルの該当なし(profileSkipped)と同じ並びに、samplingSkipped/templateSkipped を足した物。
 *   samplingSkipped = 時間の物差し(isStatTask)から外す印。isDoneTask は skipped を「もう時間は掛からない」側に置く。
 * ⚠ 工程が0件なら {}(呼ぶ側は tasks の鍵ごと送らない・空マップは既存の記録を消す)。
 */
export const buildTemplateSkippedTasks = (steps, qty, { at = null } = {}) => {
  const tasks = {};
  const n = Math.max(1, Math.trunc(num(qty, 1)));
  const base = { status: 'skipped', samplingSkipped: true, templateSkipped: true, duration: 0, startTime: null, firstStartTime: null, endTime: null, skipAt: at, workerName: 'システム(抜取判定)' };
  (Array.isArray(steps) ? steps : []).forEach((s) => {
    if (!isObj(s) || s.id == null) return;
    if (s.lotOnce) { tasks[`${s.id}-lot-0`] = { ...base }; return; }
    for (let u = 0; u < n; u += 1) tasks[`${s.id}-${u}`] = { ...base };
  });
  return tasks;
};

/** 実測の秒(1台×工程)。⚠ 按分・スキップ・該当なし・0秒は数えない(最終検査の skipSavingSim と同じ決まり)。 */
const realSec = (t) => {
  if (!isObj(t) || t.status === 'skipped' || t.samplingSkipped || t.profileSkipped || t.autoNa) return 0;
  if (t.split || t.avgSplit || t.groupMeasured) return 0;
  const d = num(t.duration, 0);
  return d > 0 ? d : 0;
};

/**
 * 組ごとの一覧(画面用)。数字は完了ロットの実測だけから。
 * @returns {Array<{ key, model, templateId, completed, inspected, streak, lastNgAt, avgMinPerLot, lotsPerMonth, minPerMonth, judge, allowed, never }>}
 */
export const templateSkipRows = ({ lots = [], cfg = null, nowMs = 0, months = 3 } = {}) => {
  const c = normalizeTemplateSkipCfg(cfg);
  const byKey = new Map();
  const from = nowMs > 0 && months > 0 ? nowMs - months * 30 * 86400000 : 0;
  (Array.isArray(lots) ? lots : []).forEach((l) => {
    if (!isObj(l)) return;
    const key = templateSkipKey(l.model, l.templateId);
    const e = byKey.get(key) || { key, model: str(l.model), templateId: str(l.templateId), completed: 0, measuredLots: 0, sec: 0, recentLots: 0, active: 0 };
    if (isCompleted(l)) {
      e.completed += 1;
      const ms = completedMs(l);
      if (from && ms >= from) e.recentLots += 1;
      let s = 0;
      Object.values(isObj(l.tasks) ? l.tasks : {}).forEach((t) => { s += realSec(t); });
      if (s > 0) { e.sec += s; e.measuredLots += 1; }
    } else e.active += 1;
    byKey.set(key, e);
  });
  return [...byKey.values()].map((e) => {
    const st = streakOf(lots, e.key);
    const avgMinPerLot = e.measuredLots > 0 ? e.sec / e.measuredLots / 60 : null;
    const lotsPerMonth = from ? e.recentLots / months : null;
    const cond = conditionsFor(c, e.key);
    // 見込み(月): 4ロットに1回は全数なので、流れるロットの (every-1)/every がスキップ
    const shareSkipped = (cond.lotSkipEvery - 1) / cond.lotSkipEvery;
    const minPerMonth = (avgMinPerLot != null && lotsPerMonth != null) ? avgMinPerLot * lotsPerMonth * shareSkipped : null;
    const judge = judgeTemplateSkip({ model: e.model, templateId: e.templateId, lots, cfg: c });
    return { ...e, streak: st.streak, inspected: st.inspected, lastNgAt: st.lastNgAt, sinceFull: st.sinceFull, avgMinPerLot, lotsPerMonth, minPerMonth, judge, allowed: c.allow[e.key] === true, never: c.never[e.key] === true, cond };
  }).sort((a, b) => (b.minPerMonth || 0) - (a.minPerMonth || 0) || b.completed - a.completed);
};

/** 直近の完了時刻(画面が「今」の代わりに使う基準。時計を読まず、データから決める=同じ入力なら同じ答え)。 */
export const latestCompletedMs = (lots) => (Array.isArray(lots) ? lots : []).reduce((a, l) => Math.max(a, isCompleted(l) ? completedMs(l) : 0), 0);

/** 一覧の合計(いまの許可で減る見込み・全部許可した時の見込み)。数字は行の足し算だけ。 */
export const templateSkipSummary = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const sum = (f) => list.reduce((a, r) => a + (f(r) ? (r.minPerMonth || 0) : 0), 0);
  return {
    combos: list.length,
    allowed: list.filter((r) => r.allowed && !r.never).length,
    never: list.filter((r) => r.never).length,
    readyNow: list.filter((r) => r.judge.reason === 'skip' || r.judge.reason === 'every-nth').length,
    minPerMonthAllowed: sum((r) => r.allowed && !r.never && r.streak >= r.cond.qualifyLots),
    minPerMonthIfAll: sum((r) => !r.never && r.streak >= r.cond.qualifyLots),
    minPerMonthCeiling: sum((r) => !r.never),
  };
};
