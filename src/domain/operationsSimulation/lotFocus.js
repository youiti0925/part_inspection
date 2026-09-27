// ============================================================================
// 🧵 lotFocus.js — 「ロットは持ったら最後まで」と「優先度の区分」の言葉と番号
// ----------------------------------------------------------------------------
// 清水さん(2026-09-10 23:30 人ごとの指示の写真2枚を見て):
//   「なんでこんなぐちゃぐちゃの仕事になるの？これならロット処理して次のロットでいいでしょ」
//   「優先度で通常と特注と緊急にして、優先度は緊急＞特注＞通常みたいな感じにして
//     シュミレーション時のときの優先度に反映するようにして」
//
// 写しの実測(2026-09-10_1000・5営業日・handoff:'unit')では ロットの持ち替えが
//   片山40回/尾田42回/信濃20回/村18回、1日に触った最大ロット数 片山14/尾田11。
//   原因は simulate.js の assignPass が **仕事を外側に回す**(急ぐ順に上から空いている人へ)ので、
//   3分の準備(ロットに1回の工程)を終えた人に 次は別ロットの一番急ぐ仕事が渡っていたから。
//
// 🚨 ここは **文と番号だけ**。React / Firebase を import しない。時刻も乱数も読まない。
// 🚨 「人がロットを離れた理由」の文は **ここ1か所** から出す。simulate.js で文を書かない。
//   画面(PersonDay の「なぜ次のロットへ？」)は lotResults[].lotSwitches[].why をそのまま出す。
// 🚨 scenario.lotFocus / scenario.priorityClass を渡さなければ、この束の関数は
//   simulate.js から1度も呼ばれない(割付・見込み・指紋は1バイト変わらない)。
// ============================================================================

const str = (v) => (v == null ? '' : String(v)).trim();

/** 優先度の区分。小さいほど先。lot.priority の字 → 番号 の読み替えは normalizeInput.js ただ1か所。 */
export const PRIORITY_CLASS = Object.freeze({
  URGENT: 0,   // 緊急
  SPECIAL: 1,  // 特注
  NORMAL: 2,   // 通常
});

/** 区分の呼び名(画面と理由の文に使う)。 */
export const PRIORITY_CLASS_LABEL = Object.freeze({
  [PRIORITY_CLASS.URGENT]: '緊急',
  [PRIORITY_CLASS.SPECIAL]: '特注',
  [PRIORITY_CLASS.NORMAL]: '通常',
});

/**
 * 番号として読めない物は 通常(2)。⚠ 0/1/2 以外の数も通常へ倒す
 *   (勝手に「もっと先」を作らない。区分は3つしか無い)。
 */
export const priorityClassRank = (v) => {
  const n = Number(v);
  return (n === PRIORITY_CLASS.URGENT || n === PRIORITY_CLASS.SPECIAL) ? n : PRIORITY_CLASS.NORMAL;
};

/** 人がロットを離れた理由の種類。 */
export const LOT_SWITCH_KIND = Object.freeze({
  LOT_DONE: 'lotDone',              // そのロットの仕事が全部終わった(手が付いていない物が無い)
  OTHERS_WORKING: 'othersWorking',  // 残りは全部 他の人が進めている
  WAITING: 'waiting',               // 残りは在るが、いま この人には渡せない(前工程/設備/到着…待ち)
  HIGHER_CLASS: 'higherClass',      // 優先度の区分が高いロット(緊急>特注>通常)が来たので移った
});

/**
 * 「いま渡せない」の内訳。simulate.js が数えた鍵をここで言葉にする。
 * ⚠ 鍵の名前は simulate.js の isJobReady / tryAssign の戻りと1対1。増やす時は両方。
 */
export const LOT_WAIT = Object.freeze({
  ARRIVAL: 'arrival',          // まだ物が着いていない
  PREV_STEP: 'prevStep',       // 前工程が終わっていない
  EQUIPMENT: 'equipment',      // 設備が空いていない
  ZONE: 'zone',                // 区画の定員
  UNIT_OWNER: 'unitOwner',     // その台は別の人が持っている(分担の区切り)
  RESERVED: 'reserved',        // 温存(この人しか頼めない仕事が待っている)
  PARTNER: 'partner',          // 2人でやる工程の相方が居ない
  MODEL_LOCK: 'modelLock',     // 1つの型式は1人で(別の人が持っている)
  PINNED: 'pinned',            // 手で別の人に固定した工程(2026-09-15)
  NO_RECORD: 'noRecord',       // この人にその工程の記録が無い(候補に入っていない)
  DURATION: 'duration',        // 目標時間が無い工程(置けない)
  OTHER: 'other',              // 上のどれでもない門で止まった
});

/** 「◯◯ 待ち」と言える物。 */
const WAIT_LABEL = Object.freeze({
  [LOT_WAIT.ARRIVAL]: '到着',
  [LOT_WAIT.PREV_STEP]: '前工程',
  [LOT_WAIT.EQUIPMENT]: '設備',
  [LOT_WAIT.ZONE]: '区画の空き',
  [LOT_WAIT.UNIT_OWNER]: 'その台を持っている人',
  [LOT_WAIT.PARTNER]: '相方',
  [LOT_WAIT.MODEL_LOCK]: 'その型式を持っている人',
});

/** 「待ち」ではなく状態そのものを言う物。 */
const STATE_LABEL = Object.freeze({
  [LOT_WAIT.RESERVED]: 'この人しか頼めない別の仕事のために手を空けている',
  [LOT_WAIT.PINNED]: '手で別の人に固定した工程',
  [LOT_WAIT.NO_RECORD]: 'この人に記録の無い工程',
  [LOT_WAIT.DURATION]: '目標時間の無い工程',
  [LOT_WAIT.OTHER]: 'いま渡せない工程',
});

/** 並びを固定する(同じ入力なら同じ文)。 */
const WAIT_ORDER = Object.freeze([
  LOT_WAIT.PREV_STEP, LOT_WAIT.ARRIVAL, LOT_WAIT.EQUIPMENT, LOT_WAIT.ZONE, LOT_WAIT.UNIT_OWNER,
  LOT_WAIT.PARTNER, LOT_WAIT.MODEL_LOCK, LOT_WAIT.RESERVED, LOT_WAIT.PINNED, LOT_WAIT.NO_RECORD, LOT_WAIT.DURATION, LOT_WAIT.OTHER,
]);

/**
 * ロットの呼び名(理由の文だけに使う。計算には1バイトも効かない)。
 * 型式が分かれば型式、指図番号が在れば括弧で添える。どちらも無ければ lotId。
 */
export const lotLabelOf = (lot, lotId = '') => {
  const model = str(lot && lot.model);
  const order = str(lot && lot.orderNo);
  if (model && order) return `${model}（${order}）`;
  return model || order || str(lotId) || 'そのロット';
};

/**
 * 人がロットを離れた理由の1行。**画面にそのまま出す文**。
 * @param {object} o
 * @param {string} o.fromLabel   離れたロットの呼び名
 * @param {string} o.toLabel     次に持つロットの呼び名
 * @param {string} o.kind        LOT_SWITCH_KIND のどれか
 * @param {string[]} [o.waits]   kind:'waiting' の時の内訳(LOT_WAIT の鍵)
 * @param {number} [o.toClass]   kind:'higherClass' の時の、次のロットの区分
 * @returns {string} 🚨 空を返さない。種類が読めなければ「次のロットへ」とだけ言う。
 */
export const lotSwitchWhy = ({ fromLabel = '', toLabel = '', kind = '', waits = [], toClass = null } = {}) => {
  const a = str(fromLabel) || 'そのロット';
  const b = str(toLabel) || '次のロット';
  const k = String(kind || '');
  // 🚨 同じ指図に検査の種類(テンプレ)が2つ在ると、呼び名(型式＋指図)が同じになり
  //   「RTT-219,BA（1001454402） は全部終わったので、次のロット RTT-219,BA（1001454402） へ」と読める
  //   (2026-09-11 確かめ役が写しの画面 片山さん 9/11 の1行目で発見)。別のロットだと分かる言い方にする。
  //   ⚠ 呼び名が同じ時に もう一度その呼び名を言うと「同じ物じゃないか」と読める(2026-09-11 まとめ役が写しの画面で確認)。
  //   同じ時は呼び名を1回で止める。違う時の文は1バイトも変えない。
  const next = (a === b) ? `同じ型式・指図の別のロットへ` : `次のロット ${b} へ`;
  if (k === LOT_SWITCH_KIND.HIGHER_CLASS) {
    const cls = PRIORITY_CLASS_LABEL[priorityClassRank(toClass)] || '優先度の高い';
    return `${cls}の ${b} が来たので、${a} を一旦置いて`;
  }
  if (k === LOT_SWITCH_KIND.LOT_DONE) return `${a} は全部終わったので、${next}`;
  if (k === LOT_SWITCH_KIND.OTHERS_WORKING) return `${a} の残りは他の人が進めているので、${next}`;
  if (k === LOT_SWITCH_KIND.WAITING) {
    const keys = WAIT_ORDER.filter((w) => Array.isArray(waits) && waits.includes(w));
    const waitWords = keys.filter((w) => WAIT_LABEL[w]).map((w) => WAIT_LABEL[w]);
    const stateWords = keys.filter((w) => STATE_LABEL[w]).map((w) => STATE_LABEL[w]);
    const parts = [];
    if (waitWords.length) parts.push(`${waitWords.join('/')} 待ち`);
    parts.push(...stateWords);
    const body = parts.length ? parts.join('・') : 'いま渡せない工程';
    return `${a} の残りは ${body}なので、${next}`;
  }
  return `${a} から${next}`;
};

/**
 * 「離れた理由の内訳」を simulate.js の門の戻り(tryAssign の outcome)から鍵へ写す。
 * ⚠ 'assigned' は渡されない前提(渡ったなら離れていない)。
 */
export const waitKeyOfOutcome = (outcome) => {
  switch (String(outcome || '')) {
    case 'equipment':
    case 'equipment-full': return LOT_WAIT.EQUIPMENT;
    case 'zone-full': return LOT_WAIT.ZONE;
    case 'unit-owner-busy':
    case 'unit-owner-other': return LOT_WAIT.UNIT_OWNER;
    case 'reserved': return LOT_WAIT.RESERVED;
    case 'need-partner': return LOT_WAIT.PARTNER;
    case 'model-locked': return LOT_WAIT.MODEL_LOCK;
    case 'no-candidate':
    case 'not-eligible': return LOT_WAIT.NO_RECORD;
    case 'duration-unknown': return LOT_WAIT.DURATION;
    default: return LOT_WAIT.OTHER;
  }
};

export default lotSwitchWhy;
