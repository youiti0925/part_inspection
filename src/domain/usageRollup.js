// ============================================================================
// 📈 「いま4つのアプリで、1日に何回読んで・何回書いているか」を **実測で集める**
// ----------------------------------------------------------------------------
// 何のために作ったか(清水さんの言葉 2026-08-23):
//   > 現状どれぐらい使用されているかわからないから正確な上限がわからない
//
//   無料枠(読み 50,000件/日・書き 20,000回/日)は **4つのアプリで1つ**。
//   使い切ると4つとも止まる(2026-08-17 に実際に止まった)。
//   ところが **いま何回使っているかを誰も知らない**。
//   read-budget-gate の数字は **見積り**であって実測ではない。
//     実測(この端末・2026-08-22): 開いた回数1回・読み773件。
//     見積りは1回1,511件だった = 見積りは **上振れ**していた。
//
//   各アプリは既に端末の中で読み取り件数を数えている
//   (製品検査 App.jsx:85 `READ_LOG_KEY = 'product.readLog.v1'` / countRead / countOpen)。
//   だが **どこにも集まらない**ので合計が出せない。ここはそれを集める為の純関数。
//
// 集める先(勝手に変えない):
//   artifacts/<APP_DATA_ID>/public/data/usage_daily/<YYYY-MM-DD>__<deviceId>
//   🚨 **1端末・1日・1件**。同じ日に何度呼んでも同じ docId = 上書き。件数が増えない。
//
// 🚨🚨 この仕組み自体が枠を食う。
//   1端末・1アプリ・1日で **書き込み1回**。4アプリ × 端末数 / 日。
//   その数は summarizeUsage が `selfWrites` として返す。**画面に必ず出す事**。
//
// 🚨🚨 数えていない物を「0」と出さない。
//   書き込みを数えていないアプリは writes:null / writesMeasured:false。
//   合計も、1台でも測っていない端末が混ざったら **null**(「測っていない」)。
//   割合(%)は **測れている物だけ**で出す。測っていない物は分母にも分子にも入れない。
//
// 🚨 送信に失敗しても現場の作業を1ミリも止めない。
//   ここは純関数しか置かない。呼ぶ側が try/catch で黙って諦め、翌日また試す。
//   (buildUsageDoc は入力が変なら **throw せず null を返す**。呼ぶ側は null なら送らない)
//
// ⚠⚠ ここは純関数だけ。React も Firebase も localStorage も触らない
//    (node --test で全部確かめられるようにするため)。
//    localStorage は ensureDeviceId が **関数で受け取る**(storageGet/storageSet)。
//
// ⚠⚠ `Date.now()` をこの中で呼ばない。時刻は必ず `nowMs` で受ける。
// ============================================================================

import { quotaWindowKey, FREE_READS_PER_DAY } from './readBudget.js';

// ---------------------------------------------------------------------------
// 0. 決めごと
// ---------------------------------------------------------------------------
/** 集める先のコレクション名。 */
export const USAGE_COL = 'usage_daily';

/**
 * 無料枠。⚠**4つのアプリで1つ**。1アプリぶんの枠ではない。
 * 読みは readBudget.js の FREE_READS_PER_DAY と **同じ物**を使う(2箇所に別の数を置かない)。
 * 書きの 20,000 は quotaMeter.js の QUOTA_LIMITS.writes と同じ値。
 */
export const FREE_TIER = Object.freeze({
  readsPerDay: FREE_READS_PER_DAY,
  writesPerDay: 20000,
});

/** 一緒に枠を使うアプリの数(製品・最終・部品・司令塔③)。 */
export const APPS_SHARING_QUOTA = 4;

/** 端末の印をしまう場所(localStorage のキー)。 */
export const USAGE_DEVICE_KEY = 'usage.deviceId.v1';

/** 「きょうはもう送った」を覚えておく場所(localStorage のキー)。 */
export const USAGE_LAST_SENT_KEY = 'usage.lastSent.v1';

/**
 * 端末の印の形。**乱数16文字(0-9a-f)だけ**。
 * 🚨 個人が分かる物(名前・PIN・端末名・IPアドレス・時刻)を **1文字も入れない**。
 *    時刻を混ぜると「いつ初めて使ったか」が分かってしまうので、それも入れない。
 */
export const DEVICE_ID_RE = /^[0-9a-f]{16}$/;

/** 日付の形(YYYY-MM-DD)。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** アプリの名前として許す形(Firestore のパスを壊す文字を入れない)。 */
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 🚨🚨 **本物の数字かどうか**。ここを `Number.isFinite(Number(v))` で書いてはいけない。
 *   `Number(null) === 0` なので、**「測っていない(null)」が「0回」に化ける**。
 *   それがまさにこのファイルが防ごうとしている嘘。
 *   (2026-08-23 の試験 U03/U05 で実際に化けた。文字列 '' も Number('') === 0 で同じ罠)
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d) => (isNum(v) ? v : d);
const nonNegInt = (v) => Math.max(0, Math.round(Number(v)));
/** 数えていなければ **null**(0にしない)。 */
const measuredInt = (v) => (isNum(v) ? nonNegInt(v) : null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 「日×アプリ×端末」を1つの文字にまとめる時の区切り。
 * ⚠ dayKey は数字と '-' だけ、appId は英数字と '._-' だけ、deviceId は16進だけなので、
 *   '|' はどれにも現れない = 別の組み合わせが同じ文字にならない(数え間違いが起きない)。
 * ⚠ ここに見えない文字を区切りに使わない。ファイルが「バイナリ」扱いになって
 *   grep も差分も効かなくなる(2026-08-23 に実際にやった)。
 */
const SEP = '|';
const keyOf = (...parts) => parts.join(SEP);
const round1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// 1. 日の区切り — 🚨 ここを間違えると「同じ日」の意味が食い違う
// ---------------------------------------------------------------------------
/**
 * 1日の区切り。**readBudget.js の quotaWindowKey をそのまま使う**(自前で計算し直さない)。
 *
 * 🚨🚨 指示は「日本時間の 0:00」だったが、**実物はそうなっていない**。
 *   ・readBudget.js `quotaWindowKey` = **米国西部(America/Los_Angeles)の 0:00**
 *   ・quotaMeter.js  `quotaDayKey`    = 同じく米国西部の 0:00(日本時間 16:00 / 冬 17:00)
 *   読み帳面(readLog.key)は rollReadLog が **米国西部の 0:00 で捨てて作り直している**
 *   (App.jsx:100 readLogNow → rollReadLog)。無料枠が戻るのもその瞬間(2026-08-17 実測)。
 *
 *   もしここだけ日本時間 0:00 にすると:
 *     日本時間 0:00〜16:00 の読みは **前の日の枠**を食っているのに「きょう」に積まれ、
 *     1つの dayKey の中に **2つの枠**が混ざる。
 *     さらに shouldSend で readLog.key(米国西部の日) と todayKey(日本の日) が
 *     日本時間 0:00〜16:00 の間ずっと食い違い、送る/送らないの判定が壊れる。
 *
 *   → 指示の括弧の中「rollReadLog と同じ区切りにしろ。違う区切りにすると『同じ日』の
 *     意味が食い違う」に従い、**米国西部の 0:00** に合わせた。
 *     ⚠この判断は人に確認してもらう事(勝手に日本時間へ戻さない。戻すなら readLog 側も一緒に)。
 *
 * @param nowMs 現在時刻(ミリ秒)。⚠有限な数以外は null を返す(1970年を作らない)。
 */
export const usageDayKey = (nowMs) => (isNum(nowMs) ? quotaWindowKey(nowMs) : null);

/** 文字が日付の形をしていれば返す。していなければ null。 */
const asDayKey = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);

/**
 * この読み帳面が属する日。
 * ⚠帳面が自分で名乗っている日(readLog.key)を **最優先**。
 *   画面を開きっぱなしで区切りをまたぐと readLog.key は前の日のままになる。
 *   その中身は前の日の枠を食った分なので、**前の日として送る**のが正しい。
 */
const dayKeyOfLog = (readLog, nowMs) =>
  asDayKey(isObj(readLog) ? readLog.key : null) || usageDayKey(nowMs);

// ---------------------------------------------------------------------------
// 2. 端末の印 — 🚨 乱数だけ。個人が分かる物を入れない
// ---------------------------------------------------------------------------
/** 8バイトの乱数を16進16文字に。⚠時刻も端末名も混ぜない。 */
const randomDeviceId = () => {
  const bytes = new Uint8Array(8);
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // ⚠crypto が無い所(古い端末)向けの控え。個人は分からないままなので方針は崩れない。
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, '0');
  return s;
};

/**
 * 端末を見分ける印。無ければ作る。
 *
 * @param storageGet (key) => string|null   例: (k) => window.localStorage.getItem(k)
 * @param storageSet (key, value) => void   例: (k, v) => window.localStorage.setItem(k, v)
 * @returns 16文字の印。**しまえなかった時は null**。
 *
 * 🚨 なぜ「しまえなかったら null」なのか:
 *   しまえないと開くたびに **別の印**が出来る。すると
 *   ・usage_daily の doc が端末1台で何件も出来る(1端末1日1件が崩れる)
 *   ・台数が水増しされ、「何台が使っているか」が嘘になる
 *   ・書き込みを余計に食う(この仕組みが枠を食う元になる)
 *   → 印をしまえない端末は **送らない**。呼ぶ側は null なら黙って諦める事。
 *
 * ⚠「書けたつもりで書けていない」入れ物があるので、書いた後に **読み直して**確かめる。
 * ⚠storageGet / storageSet が例外を投げても落ちない(現場の作業を止めない)。
 */
export function ensureDeviceId(storageGet, storageSet) {
  const get = typeof storageGet === 'function' ? storageGet : null;
  const set = typeof storageSet === 'function' ? storageSet : null;

  let cur = null;
  if (get) { try { cur = get(USAGE_DEVICE_KEY); } catch { cur = null; } }
  if (typeof cur === 'string' && DEVICE_ID_RE.test(cur)) return cur;

  if (!set) return null;
  const made = randomDeviceId();
  try { set(USAGE_DEVICE_KEY, made); } catch { return null; }

  if (get) {
    let back = null;
    try { back = get(USAGE_DEVICE_KEY); } catch { back = null; }
    if (back !== made) return null;   // 書けていない = 覚えられない端末
  }
  return made;
}

// ---------------------------------------------------------------------------
// 3. きょうのぶんを送るべきか — 1日1回だけ
// ---------------------------------------------------------------------------
/**
 * @param readLog    端末の読み帳面(readBudget.js の形)。
 * @param lastSentKey 最後に送った日(localStorage に覚えてある文字。無ければ null)。
 * @param todayKey   きょうの日(usageDayKey(nowMs) で作った文字)。
 * @returns true = 送る / false = 送らない
 *
 * 🚨 送るのは1日1回。何度呼んでも2回目からは false。
 * ⚠ 何も数えていない(読み0・開いた回数0)なら送らない。
 *    書き込み1回を使って「何も分からない」を1件増やすだけだから。
 * ⚠ 帳面が名乗る日(readLog.key)が優先。区切りをまたいだ古い帳面は、その古い日として送る。
 */
export function shouldSend({ readLog, lastSentKey, todayKey } = {}) {
  const day = asDayKey(isObj(readLog) ? readLog.key : null) || asDayKey(todayKey);
  if (!day) return false;                       // いつの分か分からない物は送らない
  if (asDayKey(lastSentKey) === day) return false; // きょうはもう送った
  if (!isObj(readLog)) return false;
  const reads = numOr(readLog.total, 0);
  const opens = numOr(readLog.opens, 0);
  return reads > 0 || opens > 0;                // 中身が無いなら送らない
}

// ---------------------------------------------------------------------------
// 4. 送る中身を作る
// ---------------------------------------------------------------------------
/** 内訳(どのコレクションを何件読んだか)を綺麗にする。⚠キーを並べ替えて毎回同じ形にする。 */
const cleanByCol = (byCol) => {
  const out = {};
  if (!isObj(byCol)) return out;
  for (const k of Object.keys(byCol).sort()) {
    const n = byCol[k];
    if (!isNum(n) || n <= 0) continue;   // 数えていない物は載せない
    out[String(k).slice(0, 64)] = nonNegInt(n);
  }
  return out;
};

/**
 * 書き込みの帳面を読む。
 * 🚨 数えていないなら **writes:null / measured:false**。**0 と書かない。**
 * 受け付ける形:
 *   ・null / undefined        → 測っていない
 *   ・数値                     → その回数(測っている)
 *   ・{ writes } / { total }   → その回数(quotaMeter.js の数え札もこれ)
 *   ・{ measured:false, ... }  → 測っていない(数が入っていても信用しない)
 * ⚠ dayKey を名乗っていて、その日が集計しようとしている日と **違う**なら測っていない扱い。
 *    別の日の回数をきょうに貼り付けたら、それは実測ではなく捏造になる。
 */
const normWrites = (writeLog, dayKey) => {
  const no = { writes: null, measured: false };
  if (writeLog === null || writeLog === undefined) return no;
  if (typeof writeLog === 'number') return isNum(writeLog) ? { writes: nonNegInt(writeLog), measured: true } : no;
  if (!isObj(writeLog)) return no;
  if (writeLog.measured === false || writeLog.writesMeasured === false) return no;
  const own = asDayKey(writeLog.dayKey) || asDayKey(writeLog.key);
  if (own && dayKey && own !== dayKey) return no;   // 別の日の物
  const raw = writeLog.writes !== undefined ? writeLog.writes : writeLog.total;
  // 🚨 isNum で見る。Number(null)===0 で「測っていない」が「0回」に化けるのを止める。
  return isNum(raw) ? { writes: nonNegInt(raw), measured: true } : no;
};

/**
 * 送る中身。
 * @returns { docId, data } / 送れない入力なら **null**(throw しない)
 *
 * docId = `YYYY-MM-DD__<deviceId>`
 *   🚨 同じ日に何度呼んでも同じ docId。上書きになるので **件数が増えない**。
 */
export function buildUsageDoc({ appId, deviceId, readLog, writeLog = null, nowMs } = {}) {
  const app = typeof appId === 'string' && APP_ID_RE.test(appId) ? appId : null;
  const dev = typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? deviceId : null;
  const dayKey = dayKeyOfLog(readLog, nowMs);
  if (!app || !dev || !dayKey) return null;

  const log = isObj(readLog) ? readLog : null;
  const w = normWrites(writeLog, dayKey);

  return {
    docId: `${dayKey}__${dev}`,
    data: {
      appId: app,
      deviceId: dev,
      dayKey,
      // 🚨 数えていなければ null。0 と書かない(「読んでいない」と「測っていない」は別)。
      reads: measuredInt(log ? log.total : undefined),
      opens: measuredInt(log ? log.opens : undefined),
      byCol: cleanByCol(log ? log.byCol : null),
      writes: w.writes,
      writesMeasured: w.measured,
      at: isNum(nowMs) ? nowMs : null,
    },
  };
}

/**
 * 置き場所。artifacts/<APP_DATA_ID>/public/data/usage_daily/<docId>
 * ⚠ 既存の本番データ(lots / settings / tasks)には1バイトも触らない。ここだけ。
 */
export function usageDocPath(appDataId, docId) {
  const ns = typeof appDataId === 'string' && APP_ID_RE.test(appDataId) ? appDataId : null;
  const id = typeof docId === 'string' && /^\d{4}-\d{2}-\d{2}__[0-9a-f]{16}$/.test(docId) ? docId : null;
  if (!ns || !id) return null;
  return `artifacts/${ns}/public/data/${USAGE_COL}/${id}`;
}

// ---------------------------------------------------------------------------
// 5. 集める — 集まった doc の配列 → 1日ぶんの合計
// ---------------------------------------------------------------------------
/** Firestore から来た形(1件)を整える。{...data} でも {id,data} でも受ける。 */
const normEntry = (raw) => {
  if (!isObj(raw)) return null;
  const d = isObj(raw.data) && (raw.data.dayKey !== undefined || raw.data.deviceId !== undefined)
    ? raw.data : raw;
  const dayKey = asDayKey(d.dayKey);
  const deviceId = typeof d.deviceId === 'string' && DEVICE_ID_RE.test(d.deviceId) ? d.deviceId : null;
  // 🚨 端末の印が無い物は数えない。無理に1台に潰すと台数が嘘になるから。
  if (!dayKey || !deviceId) return null;
  const appId = typeof d.appId === 'string' && APP_ID_RE.test(d.appId) ? d.appId : '(アプリ不明)';
  const reads = measuredInt(d.reads);
  const opens = measuredInt(d.opens);
  const writesMeasured = d.writesMeasured === true && isNum(d.writes);
  return {
    dayKey,
    deviceId,
    appId,
    reads,
    opens,
    writes: writesMeasured ? nonNegInt(d.writes) : null,
    writesMeasured,
  };
};

const blankBucket = () => ({
  reads: null, readsMeasured: true, readsFromMeasured: 0,
  opens: null, opensMeasured: true, opensFromMeasured: 0,
  writes: null, writesMeasured: true, writesFromMeasured: 0,
  devices: 0, entries: 0, selfWrites: 0,
  // ⚠ここは **記録の件数**(アプリ×端末)であって台数ではない。
  //   同じ端末が2つのアプリから送れば2件になる。'台' と書くと数え間違いを生む。
  recordsMissingReads: 0, recordsMissingWrites: 0,
});

const addToBucket = (b, e) => {
  b.entries += 1;
  b.selfWrites += 1;                       // 🚨 この1件を送る事自体が書き込み1回
  if (e.reads === null) { b.readsMeasured = false; b.recordsMissingReads += 1; }
  else b.readsFromMeasured += e.reads;
  if (e.opens === null) b.opensMeasured = false;
  else b.opensFromMeasured += e.opens;
  if (!e.writesMeasured) { b.writesMeasured = false; b.recordsMissingWrites += 1; }
  else b.writesFromMeasured += e.writes;
};

/**
 * 締める。
 * 🚨 1台でも測っていない端末が混ざっていたら合計は **null**。
 *    測れている分だけの合計は `*FromMeasured` に別に置く
 *    (「これが全部です」と言わない為。画面には「測れている N台ぶんだけで X」と書く)。
 */
const sealBucket = (b) => {
  b.reads = b.readsMeasured ? b.readsFromMeasured : null;
  b.opens = b.opensMeasured ? b.opensFromMeasured : null;
  b.writes = b.writesMeasured ? b.writesFromMeasured : null;
  return b;
};

/** 割合(%)。測れていなければ null。⚠測っていない物を分母にも分子にも入れない。 */
const pctOf = (value, limit) => {
  if (!isNum(value) || !isNum(limit) || limit <= 0) return null;
  return round1((value / limit) * 100);
};

/**
 * 集まった doc の配列 → 1日ぶんの合計。
 *
 * @param docs  usage_daily の中身の配列(4アプリぶんを混ぜて渡してよい)
 * @param freeTier 無料枠(既定 FREE_TIER)
 * @returns {
 *   byDay: { 'YYYY-MM-DD': { reads, opens, devices, byApp:{}, writes, writesMeasured, ... } },
 *   latestDay, readsPct, writesPct, warnings: []
 * }
 *
 * 🚨 ここに出るのは **送ってきた端末の分だけ**。送っていない端末の分は入っていない。
 *    だから warnings の1本目は必ず「これで全部ではない」と言う。消さない事。
 */
export function summarizeUsage(docs, { freeTier = FREE_TIER } = {}) {
  const limits = {
    readsPerDay: numOr(isObj(freeTier) ? freeTier.readsPerDay : null, FREE_TIER.readsPerDay),
    writesPerDay: numOr(isObj(freeTier) ? freeTier.writesPerDay : null, FREE_TIER.writesPerDay),
  };

  // ① 同じ「日×アプリ×端末」は1件に潰す(同じ物を2回渡されても件数が増えない)。
  const uniq = new Map();
  let skipped = 0;
  for (const raw of (Array.isArray(docs) ? docs : [])) {
    const e = normEntry(raw);
    if (!e) { skipped += 1; continue; }
    uniq.set(keyOf(e.dayKey, e.appId, e.deviceId), e);
  }

  // ② 毎回まったく同じ形になるよう並べてから積む。
  const entries = [...uniq.values()].sort((a, b) =>
    (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1
      : a.appId < b.appId ? -1 : a.appId > b.appId ? 1
        : a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));

  const byDay = {};
  const dayDevices = new Map();   // dayKey -> Set(deviceId)
  const appDevices = new Map();   // dayKey|appId -> Set(deviceId)

  for (const e of entries) {
    if (!byDay[e.dayKey]) { byDay[e.dayKey] = { ...blankBucket(), byApp: {} }; dayDevices.set(e.dayKey, new Set()); }
    const day = byDay[e.dayKey];
    addToBucket(day, e);
    dayDevices.get(e.dayKey).add(e.deviceId);

    const ak = keyOf(e.dayKey, e.appId);
    if (!day.byApp[e.appId]) { day.byApp[e.appId] = blankBucket(); appDevices.set(ak, new Set()); }
    addToBucket(day.byApp[e.appId], e);
    appDevices.get(ak).add(e.deviceId);
  }

  for (const dayKey of Object.keys(byDay)) {
    const day = byDay[dayKey];
    // ⚠台数は **別々の端末の数**。同じ端末が4アプリから送ってきても1台。
    day.devices = dayDevices.get(dayKey).size;
    for (const appId of Object.keys(day.byApp)) {
      const b = day.byApp[appId];
      b.devices = appDevices.get(keyOf(dayKey, appId)).size;
      sealBucket(b);
    }
    sealBucket(day);
  }

  const days = Object.keys(byDay).sort();
  const latestDay = days.length ? days[days.length - 1] : null;
  const latest = latestDay ? byDay[latestDay] : null;

  const readsPct = latest ? pctOf(latest.reads, limits.readsPerDay) : null;
  const writesPct = latest ? pctOf(latest.writes, limits.writesPerDay) : null;

  // ③ 言い訳ではなく「この数字で何が言えないか」を必ず添える。
  const warnings = [];
  if (!latest) {
    warnings.push('まだ1件も集まっていません。これは「使用量が0」ではなく **まだ測っていない** という意味です。');
  } else {
    warnings.push(
      `この数字は、使用量を送ってきた ${latest.devices}台ぶん だけです。`
      + '送っていない端末の分は入っていません（本当の合計はこれより多い）。',
    );
    if (!latest.writesMeasured) {
      warnings.push(
        `🚨 書き込みを測っていない記録が ${latest.recordsMissingWrites}件 あります`
        + `（この日の記録は全部で ${latest.entries}件・アプリ×端末で数えた件数）。`
        + `合計は出しません（「0回」ではありません）。`
        + `測れている ${latest.entries - latest.recordsMissingWrites}件ぶんだけで ${latest.writesFromMeasured}回 です。`,
      );
    }
    if (!latest.readsMeasured) {
      warnings.push(
        `🚨 読み取りを測っていない記録が ${latest.recordsMissingReads}件 あります`
        + `（この日の記録は全部で ${latest.entries}件）。`
        + `合計は出しません（「0件」ではありません）。測れている分だけで ${latest.readsFromMeasured}件 です。`,
      );
    }
    warnings.push(
      `⚠ 使用量を送る事自体が、この日 ${latest.selfWrites}回 の書き込みを使っています`
      + `（1端末・1アプリ・1日で1回。無料枠 ${limits.writesPerDay.toLocaleString()}回/日 のうち）。`,
    );
    if (readsPct !== null && readsPct >= 80) {
      warnings.push(`🚨 読み取りが無料枠の ${readsPct}% です（測れている分だけで）。${APPS_SHARING_QUOTA}つのアプリで1つの枠です。`);
    }
    if (writesPct !== null && writesPct >= 80) {
      warnings.push(`🚨 書き込みが無料枠の ${writesPct}% です（測れている分だけで）。`);
    }
  }
  if (skipped > 0) {
    warnings.push(`⚠ 形が違って数えられなかった記録が ${skipped}件 あります（端末の印か日付が入っていない）。`);
  }

  return { byDay, latestDay, readsPct, writesPct, warnings };
}
