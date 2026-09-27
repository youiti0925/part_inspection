// =============================================================================
// 📐 保存計画に「計算した時の条件」を残し、後で **同じ条件で最新のデータを計算し直す**(2026-09-22)。
// -----------------------------------------------------------------------------
// 🚨 2つの操作を混ぜない
//   ① 提出した版を見る … 当時の結果をそのまま(版の本体。書いたら変わらない)
//   ② その条件で最新データを再計算 … 条件(この書類)だけ当時の物にし、ロット・作業者・設定は今の物。
//      新しい試算が出来、保存計画との差が画面に出る。提出した版は1バイトも変わらない。
//
// エンジンに渡る物の棚卸し(useOperationsSimulation の payload / runKey):
//   条件(この書類に保存)   … now(基準時刻) / horizonDays / rangeKey / mode(技能の扱い) / estimateMode(工数の見方)
//                            / scenario(残業・土曜・応援・休み・曜日配置・区画の定員・担当固定・ロット集中…
//                              画面の切替が全部入った1つの物。Worker へ渡るので JSON 化できる)
//   最新のデータ(保存しない) … lots / templates / workers / settings(個人設定・技能・設備・見積条件)
//                            / factoryCalendar(工場の暦)
//   参照版(指紋だけ保存)     … runKey の各部分。再計算の時に「当時と何が違うか」を言う為
//
// 🚨 純関数だけ。firebase も React も import しない。
// =============================================================================

export const CONDITIONS_VERSION = 1;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 文字列の短い指紋(FNV-1a 32bit を2本・16桁)。🚨 runKey の data の部分はロット id が全部入って 33KB になる。生で保存しない。 */
export function shortHash(str) {
  const s = String(str ?? '');
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x27d4eb2f) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** runKey は useOperationsSimulation が '||' で繋いだ9つ。順番はフックの持ち主が決めている。 */
export const RUN_KEY_PARTS = Object.freeze(['data', 'scope', 'now', 'horizonDays', 'scenario', 'mode', 'estimate', 'calendar', 'token']);

export function parseRunKey(runKey) {
  if (typeof runKey !== 'string' || !runKey) return null;
  const parts = runKey.split('||');
  if (parts.length !== RUN_KEY_PARTS.length) return null;
  return Object.fromEntries(RUN_KEY_PARTS.map((k, i) => [k, parts[i]]));
}

/** JSON を通して写す(関数・undefined を落とす。Worker へ渡す時と同じ形)。 */
function jsonClone(v) {
  try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; }
}

/**
 * 計算した時の条件を、計画に載せる形にする。
 * @returns {object|null} 何も渡されなければ null(古い版と同じ扱い)
 */
export function captureConditions({ now, horizonDays, rangeKey, mode, estimateMode, scenario, runKey } = {}) {
  const keys = parseRunKey(runKey);
  const out = {
    version: CONDITIONS_VERSION,
    now: numOrNull(now),
    horizonDays: numOrNull(horizonDays),
    rangeKey: typeof rangeKey === 'string' ? rangeKey : null,
    mode: Array.isArray(mode) ? mode.map(String) : (mode == null ? null : String(mode)),
    estimateMode: estimateMode == null ? null : String(estimateMode),
    scenario: isObj(scenario) ? jsonClone(scenario) : {},
    // 参照版: 当時のデータ・暦・条件の指紋。再計算の時「何が当時と違うか」を言う為だけに使う
    keys: keys ? { data: shortHash(keys.data), calendar: shortHash(keys.calendar), scenario: shortHash(keys.scenario), scope: shortHash(keys.scope) } : null,
  };
  return out;
}

/** 読み取った版の conditions が使える形か。 */
export function hasRestorableConditions(plan) {
  const c = plan && plan.conditions;
  return isObj(c) && c.version === CONDITIONS_VERSION && isObj(c.scenario);
}

/** 保存の形へ: scenario は JSON 文字列にする(🚨 入れ子の配列が中に在っても Firestore に拒否されない)。 */
export function conditionsToStored(c) {
  if (!isObj(c)) return null;
  const { scenario, ...rest } = c;
  return { ...rest, scenarioJson: JSON.stringify(scenario ?? {}) };
}

/** 読んだ形から戻す。古い形(scenario がそのまま入っている)も読む。 */
export function conditionsFromStored(s) {
  if (!isObj(s)) return null;
  if (typeof s.scenarioJson === 'string') {
    const { scenarioJson, ...rest } = s;
    let scenario = {};
    try { scenario = JSON.parse(scenarioJson); } catch { scenario = {}; }
    return { ...rest, scenario: isObj(scenario) ? scenario : {} };
  }
  return { ...s, scenario: isObj(s.scenario) ? s.scenario : {} };
}

/** 再計算の時の「当時と何が違うか」の言葉。差が無ければ空。 */
export const DRIFT_LABELS = Object.freeze({
  data: 'ロット・作業者・設定のいずれか',
  calendar: '工場の暦(休日の登録)',
  scope: '対象のロットの顔ぶれ',
  scenario: '条件の切替',
});

/**
 * 保存した条件と、今の計算の鍵(runKey)を比べる。
 * @returns {Array<{what:string,label:string}>} 当時と違う物。keys が無い古い版なら [] ではなく null(比べられない)
 */
export function conditionsDrift(conditions, currentRunKey) {
  const saved = conditions && conditions.keys;
  const cur = parseRunKey(currentRunKey);
  if (!isObj(saved) || !cur) return null;
  const out = [];
  for (const what of ['data', 'calendar', 'scope', 'scenario']) {
    if (typeof saved[what] !== 'string') continue;
    if (saved[what] !== shortHash(cur[what])) out.push({ what, label: DRIFT_LABELS[what] });
  }
  return out;
}

/** 復元する時にフックへ渡す形(scenario / mode / estimateMode)。無ければ null。 */
export function restorableInputs(plan) {
  if (!hasRestorableConditions(plan)) return null;
  const c = plan.conditions;
  return { revision: plan.revision, scenario: jsonClone(c.scenario) || {}, mode: c.mode ?? null, estimateMode: c.estimateMode ?? null,
    now: c.now, rangeKey: c.rangeKey, horizonDays: c.horizonDays };
}
