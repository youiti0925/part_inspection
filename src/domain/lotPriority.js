// =============================================================================
//  🚩 ロットの優先度 — 通常 / 特注 / 緊急（3択）の 字・言葉・読み替え
// -----------------------------------------------------------------------------
//  清水さん(2026-09-10 23:30):
//    「優先度で通常と特注と緊急にして、優先度は緊急＞特注＞通常みたいな感じにして
//      シュミレーション時のときの優先度に反映するようにして」
//
//  ここは **純関数だけ**(React も Firebase も入れない。node --test でそのまま回す為)。
//  🚨 字と言葉の持ち主は **このファイルただ1つ**。画面(App.jsx / 最終検査 App.firebase.jsx)で
//    'urgent' や「緊急」を手で書かない(片方だけ言い方が変わる事故を作らない)。
//
//  ■ 字(lot.priority に入る物)
//    'normal'  … 通常
//    'special' … 特注
//    'urgent'  … 緊急
//  ■ 旧 'high'(急ぎ)は **'urgent'(緊急) と読む**。読み替えは normalizeLotPriority ただ1か所。
//    (エンジン側は normalizeInput の1か所で同じ読み替えをする。約束: 2026-09-10 まとめ役)
//  ■ 優先度の区分(エンジンが normalized.lots[].priorityClass に持つ数)
//    0 = 緊急 / 1 = 特注 / 2 = 通常。小さいほど先。画面は **この数を読むだけ**(ここで数え直さない)。
// =============================================================================

/** 字。🚨 この3つ以外を lot.priority に書かない。 */
export const LOT_PRIORITY = Object.freeze({
  NORMAL: 'normal',
  SPECIAL: 'special',
  URGENT: 'urgent',
});

/** 旧い字。読む時だけ 'urgent' に倒す(書く時には二度と使わない)。 */
export const LEGACY_PRIORITY_HIGH = 'high';

/** 言葉。🚨 画面はここから取る(手で「緊急」と書かない)。 */
export const LOT_PRIORITY_LABEL = Object.freeze({
  [LOT_PRIORITY.NORMAL]: '通常',
  [LOT_PRIORITY.SPECIAL]: '特注',
  [LOT_PRIORITY.URGENT]: '緊急',
});

/** 登録・編集の select と 一覧の絞りの並び(通常 → 特注 → 緊急)。 */
export const LOT_PRIORITY_CHOICES = Object.freeze(
  [LOT_PRIORITY.NORMAL, LOT_PRIORITY.SPECIAL, LOT_PRIORITY.URGENT]
    .map((key) => Object.freeze({ key, label: LOT_PRIORITY_LABEL[key] })),
);

/**
 * 優先度の区分(エンジンの priorityClass)。0=緊急 / 1=特注 / 2=通常。
 * ⚠ 画面はエンジンが返した priorityClass を読む。ここは 字→数 の対応表として持つだけ。
 */
export const PRIORITY_CLASS = Object.freeze({
  [LOT_PRIORITY.URGENT]: 0,
  [LOT_PRIORITY.SPECIAL]: 1,
  [LOT_PRIORITY.NORMAL]: 2,
});

/** 区分(数) → 字。 */
const PRIORITY_OF_CLASS = Object.freeze([LOT_PRIORITY.URGENT, LOT_PRIORITY.SPECIAL, LOT_PRIORITY.NORMAL]);
/** 区分(数) → 字。読めなければ null(画面はその時 札を押されていない形で出す)。2026-09-15 納期一覧の行から優先度を変える為。 */
export const priorityOfClass = (n) => (Number.isInteger(n) && PRIORITY_OF_CLASS[n] ? PRIORITY_OF_CLASS[n] : null);

/**
 * lot.priority を3択の字に正す。🚨 旧 'high' → 'urgent'。空・知らない字 → 'normal'。
 * @param {*} v
 * @returns {'normal'|'special'|'urgent'}
 */
export const normalizeLotPriority = (v) => {
  const s = (typeof v === 'string') ? v.trim() : '';
  if (s === LOT_PRIORITY.URGENT || s === LEGACY_PRIORITY_HIGH) return LOT_PRIORITY.URGENT;
  if (s === LOT_PRIORITY.SPECIAL) return LOT_PRIORITY.SPECIAL;
  return LOT_PRIORITY.NORMAL;
};

/**
 * 画面に出す言葉。旧 'high' は「緊急」。
 * @param {*} v lot.priority
 * @returns {string}
 */
export const priorityLabelOf = (v) => LOT_PRIORITY_LABEL[normalizeLotPriority(v)];

/**
 * 入荷 Excel の優先度の欄を字に読み替える。
 *   '緊急' → 'urgent' / '特注' → 'special' / '急ぎ'(旧) → 'urgent' / それ以外(空欄・「通常」) → 'normal'
 * @param {*} text
 * @returns {'normal'|'special'|'urgent'}
 */
export const priorityFromImportText = (text) => {
  const t = String(text == null ? '' : text).trim();
  if (t === LOT_PRIORITY_LABEL.urgent || t === '急ぎ') return LOT_PRIORITY.URGENT;
  if (t === LOT_PRIORITY_LABEL.special) return LOT_PRIORITY.SPECIAL;
  return LOT_PRIORITY.NORMAL;
};

/** 小さな札の色。緊急=赤 / 特注=橙。通常は札を出さない(null)。 */
const BADGE = Object.freeze({
  [LOT_PRIORITY.URGENT]: Object.freeze({
    key: LOT_PRIORITY.URGENT,
    label: LOT_PRIORITY_LABEL.urgent,
    cls: 'border-rose-400 bg-rose-50 text-rose-700',
    solidCls: 'bg-rose-600 text-white border-rose-700',
    hoverCls: 'hover:bg-rose-50 hover:border-rose-300',
  }),
  [LOT_PRIORITY.SPECIAL]: Object.freeze({
    key: LOT_PRIORITY.SPECIAL,
    label: LOT_PRIORITY_LABEL.special,
    cls: 'border-orange-400 bg-orange-50 text-orange-700',
    solidCls: 'bg-orange-500 text-white border-orange-600',
    hoverCls: 'hover:bg-orange-50 hover:border-orange-300',
  }),
});

/**
 * カード・一覧の行に付ける小さな札。🚨 通常は **null**(札を出さない)。
 * @param {*} v lot.priority(旧 'high' も可)
 * @returns {{key:string,label:string,cls:string,solidCls:string,hoverCls:string}|null}
 */
export const priorityBadgeOf = (v) => BADGE[normalizeLotPriority(v)] || null;

/**
 * エンジンが返した区分(normalized.lots[].priorityClass: 0|1|2)から札を作る。
 * 🚨 数が渡っていない(undefined / null / 知らない数)なら **null**(札を出さない・ここで推測しない)。
 * @param {*} priorityClass
 * @returns {{key:string,label:string,cls:string}|null}
 */
export const priorityClassBadgeOf = (priorityClass) => {
  if (!Number.isInteger(priorityClass)) return null;
  const key = PRIORITY_OF_CLASS[priorityClass];
  return key ? (BADGE[key] || null) : null;
};

/** 絞り込みの札の見た目(通常も含む3つ)。⚠ 言葉は LOT_PRIORITY_LABEL から。 */
export const priorityFilterStyleOf = (key) => {
  const b = BADGE[key];
  if (b) return { on: b.solidCls, off: `bg-white text-slate-600 border-slate-200 ${b.hoverCls}` };
  return { on: 'bg-slate-700 text-white border-slate-700', off: 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50' };
};
