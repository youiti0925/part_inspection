// =============================================================================
//  domain/opsimRules.js — 割付の決まりの「設定できる口」(2026-09-22 清水さん)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-22)「AとBとか色々カスタマイズできるようにして。それ以外の設定もあると思うけど、
//    設定にないから設定できるようにしておいて」
//  エンジン(simulate.js / priority.js / normalizeInput.js)が scenario の鍵で読むのに、画面に口が無かった決まりを
//  ここに **1か所** で並べる。⚠ operationsSimulation の外に置く(エンジンは settings.opsim を直に読まない決まり・見張り T5)。保存先は settings.opsim.<key>(製品・最終で同じ鍵)。
//
//  🚨 既定は **今までの計算と1バイトも同じ**(登録が無ければ scenario に鍵を出さない)。
//  🚨 数字を作らない・言い換えない。画面はここの label/choices/fact をそのまま出す。
// =============================================================================

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 決まりの一覧。key = settings.opsim の鍵。
 *   choices[].key … 保存する値。既定(default)は「今までどおり」。
 *   scenario(value) … エンジンへ渡す断片(既定の時は {} = 鍵を出さない)。
 */
export const OPSIM_RULES = Object.freeze([
  {
    key: 'priorityPreempt', icon: '🚩', label: '特注・緊急が来た時、持っているロットは',
    fact: '2026-09-22 の写し(製品)で 尾田さんが RBS-250R,H,J を 9/24 に始め、9/25 08:32 に「特注の RTT-215,AB が来たので一旦置いて」離れ、続きは別の人が 9/28 に終えた。',
    default: 'interrupt',
    choices: [
      { key: 'interrupt', label: '一旦置いて特注へ' },
      { key: 'orderOnly', label: '最後までやる（区分は次に取る順番だけ）' },
    ],
    scenario: (v) => (v === 'orderOnly' ? { priorityPreempt: 'orderOnly' } : {}),
  },
  {
    key: 'lotWaitMinutes', icon: '⏳', label: '続きが前工程待ちの時',
    fact: '「別のロットへ」だと 前工程が数分で終わる時も別のロットへ移り、戻りが遅れる。「待つ」は 前工程(作業中)の終わりが N分以内なら手を空けて待つ(それより先なら今までどおり移る)。',
    default: 0,
    choices: [
      { key: 0, label: '別のロットへ' },
      { key: 15, label: '15分までなら待つ' },
      { key: 30, label: '30分までなら待つ' },
      { key: 60, label: '60分までなら待つ' },
    ],
    scenario: (v) => (Number(v) > 0 ? { lotWaitMinutes: Number(v) } : {}),
  },
  {
    key: 'reserveSpecialist', icon: '🧑‍🔧', label: 'この人しか頼めない仕事のために手を空ける（温存）',
    fact: '2026-09-22 の写し(製品)で 尾田さんが RBS-160R,H を 9/24 13:55 に「この人しか頼めない別の仕事のために手を空けている」で離れた。切ると 温存せず目の前の続きを取る。',
    default: 'on',
    choices: [
      { key: 'on', label: '温存する' },
      { key: 'off', label: '温存しない' },
    ],
    scenario: (v) => (v === 'off' ? { reserveSpecialist: false } : {}),
  },
  {
    key: 'assumeArrivalDays', icon: '📦', label: '入荷日が分からないロットを納期の何日前に仮に置くか',
    fact: '2026-08-31 清水さん「とりあえず仮日入れないとなんも進まない」で既定 2日。0 = 実データだけ(仮に置かない)。',
    default: 2,
    choices: [
      { key: 0, label: '仮に置かない' },
      { key: 1, label: '1日前' },
      { key: 2, label: '2日前' },
      { key: 3, label: '3日前' },
      { key: 5, label: '5日前' },
    ],
    scenario: (v) => (Number(v) > 0 ? { assumeArrivalDaysBeforeDue: Number(v) } : {}),
  },
  {
    key: 'switchGainMinutes', icon: '🔁', label: '作業中の人を別の仕事へ移してよい最小の改善',
    fact: 'priority.js の switchGainThresholdMs。既定は「渡さない＝持ち替えない」。分を入れると、その分以上 納期が良くなる時だけ持ち替える。',
    default: 0,
    choices: [
      { key: 0, label: '持ち替えない' },
      { key: 15, label: '15分以上よくなる時' },
      { key: 60, label: '60分以上よくなる時' },
      { key: 240, label: '4時間以上よくなる時' },
    ],
    scenario: (v) => (Number(v) > 0 ? { switchGainThresholdMs: Number(v) * 60000 } : {}),
  },
  {
    key: 'safetyFactor', icon: '🛡', label: '残作業の見込みの安全率',
    fact: 'priority.js の safetyFactor。既定 1 = 見積そのまま(水増ししない)。1.2 なら残作業を2割多く見て並べる(棒の長さは変えない。順番だけ)。',
    default: 1,
    choices: [
      { key: 1, label: '見積そのまま' },
      { key: 1.1, label: '1割多く見る' },
      { key: 1.2, label: '2割多く見る' },
      { key: 1.5, label: '5割多く見る' },
    ],
    scenario: (v) => (Number(v) > 1 ? { safetyFactor: Number(v) } : {}),
  },
  {
    key: 'dueOffsetWorkdays', icon: '📅', label: '納期を何稼働日 前倒しして並べるか',
    fact: 'normalizeInput の dueOffsetWorkdays(暦日ではなく稼働日)。既定 0。1 なら「納期の1稼働日前に終える」つもりで並べる(帳票の納期は変えない)。',
    default: 0,
    choices: [
      { key: 0, label: '前倒ししない' },
      { key: 1, label: '1稼働日' },
      { key: 2, label: '2稼働日' },
      { key: 3, label: '3稼働日' },
    ],
    scenario: (v) => (Number(v) > 0 ? { dueOffsetWorkdays: Number(v) } : {}),
  },
]);

export const OPSIM_RULE_KEYS = Object.freeze(OPSIM_RULES.map((r) => r.key));

const ruleOf = (key) => OPSIM_RULES.find((r) => r.key === key) || null;

/** 保存値が選択肢に在るか(在れば その key を返す。無ければ null)。数字は Number で比べる。 */
export const normalizeRuleValue = (key, raw) => {
  const r = ruleOf(key);
  if (!r) return null;
  const hit = r.choices.find((c) => (typeof c.key === 'number' ? Number(raw) === c.key : String(raw) === c.key));
  return hit ? hit.key : null;
};

/**
 * settings.opsim から全部の決まりを読む。
 * @returns {{ [key]: { value, registered:boolean, label:string } }}
 */
export const readOpsimRules = (settings, defaults = {}) => {
  const op = isObj(settings) && isObj(settings.opsim) ? settings.opsim : {};
  const out = {};
  for (const r of OPSIM_RULES) {
    const v = normalizeRuleValue(r.key, op[r.key]);
    // ⚠ defaults: アプリごとに「今までの計算」が違う物(最終検査は 仮の入荷日を渡していない=0)。鍵が無ければこの表の既定
    const dflt = Object.prototype.hasOwnProperty.call(defaults, r.key) ? defaults[r.key] : r.default;
    const value = v === null ? dflt : v;
    const choice = r.choices.find((c) => c.key === value);
    out[r.key] = { value, registered: v !== null, label: choice ? choice.label : String(value), default: dflt };
  }
  return out;
};

/** scenario へ足す断片(既定の物は鍵を出さない)。全部既定なら null。 */
export const rulesScenarioOf = (settings, defaults = {}) => {
  const rules = readOpsimRules(settings, defaults);
  const sc = {};
  // 🚨 登録した物だけ鍵を出す(既定のままなら 1つも出さない = 今までの計算と同じ)
  for (const r of OPSIM_RULES) if (rules[r.key].registered) Object.assign(sc, r.scenario(rules[r.key].value));
  return Object.keys(sc).length ? sc : null;
};

/** ⚙(条件・根拠)の行。既定のままの物は「（既定）」を添える。 */
export const rulesBasisLines = (settings, defaults = {}) => {
  const rules = readOpsimRules(settings, defaults);
  return OPSIM_RULES.map((r) => `${r.icon} ${r.label}: ${rules[r.key].label}${rules[r.key].registered ? '' : '（既定）'}`);
};
