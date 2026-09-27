// ============================================================================
// 🧮 読み取りの「課金の見込み」を数える帳面(P-L1・P-L2 2026-09-27)
// ----------------------------------------------------------------------------
// なぜ要るか(所見 P-L1・P-L2 と反証役の確かめ):
//   今の読みメーター(readBudget.js の帳面・画面の「📖 この端末が読んだ件数」)は、
//   ・つながり直すたびに「全部読み直した」と数える(開きっぱなしのPC 1台で1日 約1.1〜1.2万を多めに出していた)
//   ・30分以上切れた後の全部読み直し(本当に課金される)を、変化が無い購読では0と数える(少なめ)
//   ・getDocsFromServer / getDocFromServer / REST の読みを数えない
//   ・置き場所の名前が道の最後の区切りだけ(最終の lots も製品の 'lots' に混ざる)
//   ・usage_daily へは「開いて90秒後の写し」しか送らず、昼の分は日が変わると捨てる
//   ・タブが2つあると互いの帳面を丸ごと上書きする
//   ので、無料枠(5万/日)を何が食っているかを帳面から言えなかった。
//
// ここが守る事:
//   ① 🚨 **画面に出る数字は1つも変えない。** 画面の読みメーターは今までの帳面(readBudget.js)のまま。
//      この帳面は画面に出さず、usage_daily の est(その日の写し)と full(締まった前の日)にだけ載せる。
//   ② 数えるために通信しない(端末の中だけ)。送るのは今までの写しの1件と、締まった日の1件だけ。
//   ③ Firestore の決まりに合わせる(公式の説明):
//        ・購読は、つながり直しが30分以内なら **変わった書類の分だけ** 課金。30分を超えたら新しい問い合わせとして全部。
//        ・1回だけ読む問い合わせは、0件でも1件ぶん課金。
//   ④ 足し算で書く(書く直前に保存済みの帳面を読み直し、この画面の差分を足す)= タブ同士で消し合わない。
//
// ⚠⚠ ここは純関数だけ。localStorage も Firestore も React も触らない(node --test で確かめる)。
// ⚠ これは **見込み** であって請求額ではない(仮定は下の各所に書いた)。
// ============================================================================
import { quotaWindowKey } from './readBudget.js';

/** 推定の帳面をしまう場所(localStorage)。⚠今までの帳面(product.readLog.v1)とは別。 */
export const EST_LOG_KEY = 'product.readLog.est.v1';
/** 締まった日の帳面(まだ送っていない物を含む)をしまう場所。 */
export const PREV_LOG_KEY = 'product.readLog.prev';
/** Firestore の「30分以内なら差分」の境目。 */
export const LONG_GAP_MS = 30 * 60 * 1000;
/** 締まった日の帳面を何日ぶんまで持つか(送れない日が続いても溢れさせない)。 */
export const PREV_KEEP = 7;
/** 開いてからこの間に張った購読は「開いた時の購読」とみなす(控えの続きから再開できるかの判定に使う)。 */
export const BOOT_WINDOW_MS = 2 * 60 * 1000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const n0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 置き場所ごとの名前。collection()/doc() に渡した道(db を除く)から作る。
 *   artifacts/<棚>/public/data/<コレクション>[/<id>] → '<棚>/<コレクション>'(例 'final-inspection-v1/lots')
 *   それ以外の道は最後のコレクション名だけ(今までと同じ名前)。
 */
export const pathColName = (segs, isDoc = false) => {
  const a = (Array.isArray(segs) ? segs : []).map((s) => String(s));
  const col = isDoc ? a[a.length - 2] : a[a.length - 1];
  // ⚠ 道の形(<根>/<棚>/public/data/<コレクション>)で見分ける。根の名前は字で書かない(直パスの見張り routes.test R09)。
  if (a.length >= (isDoc ? 6 : 5) && a[2] === 'public' && a[3] === 'data' && a[1]) return `${a[1]}/${col}`;
  return String(col || '(不明)');
};

/** 空の推定帳面。 */
export const emptyEstLog = (nowMs, aliveAt = null) => ({
  v: 1, key: quotaWindowKey(nowMs), total: 0, byCol: {}, opens: 0,
  reconnects: { short: 0, long: 0 }, longGapsMin: [], carriedOver: false,
  firstAt: nowMs, lastAt: nowMs, aliveAt: typeof aliveAt === 'number' ? aliveAt : null,
});

/** この画面がまだ書いていない差分。 */
export const emptyEstDelta = () => ({ total: 0, byCol: {}, opens: 0, short: 0, long: 0, longGapsMin: [], aliveAt: null });

/** 差分に読んだ件数を足す(新しい差分を返す)。 */
export const estDeltaAdd = (delta, name, n) => {
  const d = isObj(delta) ? delta : emptyEstDelta();
  const add = Math.max(0, Math.round(n0(Number(n))));
  if (!add) return d;
  const k = String(name || '(不明)').slice(0, 96);
  return { ...d, total: n0(d.total) + add, byCol: { ...(d.byCol || {}), [k]: n0((d.byCol || {})[k]) + add } };
};

/**
 * 足し算で書く: 保存されていた帳面(他のタブの分も入っている)に、この画面の差分を足す。
 *   日(米国西部の0時・今までの帳面と同じ区切り)が変わっていたら、保存されていた帳面を prev として返し、
 *   新しい日の帳面に差分を足す(⚠ 捨てない = 昼の分を送り直せる)。
 * @param stored  localStorage にあった帳面(壊れていても落ちない)
 * @param delta   この画面の差分
 * @param openKey この画面を開いた時の日。今の日と違えば「開いたまま日をまたいだ」印を立てる
 * @returns {{ log, prev }}
 */
export const mergeEstDelta = (stored, delta, nowMs, { openKey = null } = {}) => {
  const key = quotaWindowKey(nowMs);
  const d = isObj(delta) ? delta : emptyEstDelta();
  let base = isObj(stored) && typeof stored.key === 'string' ? stored : null;
  let prev = null;
  if (base && base.key !== key) { prev = base; base = null; }
  if (!base) base = emptyEstLog(nowMs, prev ? prev.aliveAt : (isObj(stored) ? stored.aliveAt : null));
  const byCol = { ...(isObj(base.byCol) ? base.byCol : {}) };
  for (const [k, v] of Object.entries(isObj(d.byCol) ? d.byCol : {})) byCol[k] = n0(byCol[k]) + n0(v);
  const rc = isObj(base.reconnects) ? base.reconnects : {};
  const gaps = [...(Array.isArray(base.longGapsMin) ? base.longGapsMin : []), ...(Array.isArray(d.longGapsMin) ? d.longGapsMin : [])].slice(-24);
  const alive = Math.max(n0(base.aliveAt), n0(d.aliveAt));
  const log = {
    ...base,
    total: n0(base.total) + n0(d.total),
    byCol,
    opens: n0(base.opens) + n0(d.opens),
    reconnects: { short: n0(rc.short) + n0(d.short), long: n0(rc.long) + n0(d.long) },
    longGapsMin: gaps,
    carriedOver: !!base.carriedOver || (typeof openKey === 'string' && openKey !== key),
    lastAt: nowMs,
    aliveAt: alive > 0 ? alive : null,
  };
  return { log, prev };
};

/** 差分に書く物が在るか(無ければ localStorage に書かない)。 */
export const estDeltaEmpty = (d) => !isObj(d) || (!n0(d.total) && !n0(d.opens) && !n0(d.short) && !n0(d.long) && !(Array.isArray(d.longGapsMin) && d.longGapsMin.length));

/**
 * 締まった日の帳面を並びに入れる。同じ日の物は差し替え。中身が空の日は入れない。PREV_KEEP 日ぶんまで。
 * @param oldLog 今までの帳面(画面の読みメーター)の同じ日の物。在れば比べられるように添える。
 */
export const pushPrevLog = (list, prevLog, oldLog = null) => {
  const arr = (Array.isArray(list) ? list : []).filter((p) => isObj(p) && typeof p.key === 'string');
  if (!isObj(prevLog) || typeof prevLog.key !== 'string') return arr;
  if (!(n0(prevLog.total) > 0 || n0(prevLog.opens) > 0)) return arr;
  const old = isObj(oldLog) && oldLog.key === prevLog.key
    ? { reads: n0(oldLog.total), opens: n0(oldLog.opens), byCol: isObj(oldLog.byCol) ? oldLog.byCol : {} } : null;
  const entry = { ...prevLog, sent: false, old };
  const out = [...arr.filter((p) => p.key !== prevLog.key), entry].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.slice(-PREV_KEEP);
};

/** まだ送っていない締まった日を1つ(古い順)。今の日の物は選ばない。 */
export const nextPrevToSend = (list, currentKey) =>
  (Array.isArray(list) ? list : []).find((p) => isObj(p) && !p.sent && p.key !== currentKey) || null;

/** 送った/送れなかった印を付け替える。 */
export const markPrevSent = (list, key, sent) =>
  (Array.isArray(list) ? list : []).map((p) => (isObj(p) && p.key === key ? { ...p, sent: !!sent } : p));

/** usage_daily に載せる形(数えていない物は載せない・キーは並べ替える)。 */
export const estSummary = (log) => {
  if (!isObj(log)) return null;
  const byCol = {};
  for (const k of Object.keys(isObj(log.byCol) ? log.byCol : {}).sort()) {
    const v = n0(log.byCol[k]);
    if (v > 0) byCol[k] = Math.round(v);
  }
  const rc = isObj(log.reconnects) ? log.reconnects : {};
  return {
    reads: Math.round(n0(log.total)), opens: Math.round(n0(log.opens)), byCol,
    reconnects: { short: Math.round(n0(rc.short)), long: Math.round(n0(rc.long)) },
    longGapsMin: Array.isArray(log.longGapsMin) ? log.longGapsMin.slice(-24) : [],
    carriedOver: !!log.carriedOver,
    firstAt: typeof log.firstAt === 'number' ? log.firstAt : null,
    lastAt: typeof log.lastAt === 'number' ? log.lastAt : null,
  };
};

const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 締まった日を usage_daily の **同じ書類**(<日>__<端末>)へ送り直す中身。
 *   🚨 上の段(reads / opens / byCol / dayKey …)には1つも書かない。書くのは入れ子の `full` だけ。
 *     ・その日の写し(開いて90秒後)が在る書類 → `full` が足されるだけ(③の使用量の画面の数字は変わらない)
 *     ・写しが無い書類 → `full` だけの書類ができる。③は dayKey で絞って読むので、この書類は③の画面に出ない
 *   ⚠ 呼ぶ側は merge:true で書く(写しを消さない)。
 * @returns { docId, data } / 送れない入力なら null
 */
export const buildPrevUsageDoc = ({ appId, deviceId, prev, nowMs } = {}) => {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return null;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null;
  if (!isObj(prev) || typeof prev.key !== 'string' || !DAY_RE.test(prev.key)) return null;
  return {
    docId: `${prev.key}__${deviceId}`,
    data: {
      full: {
        appId, deviceId, dayKey: prev.key,
        closedAt: typeof nowMs === 'number' ? nowMs : null,
        est: estSummary(prev),
        // 画面の読みメーター(今までの数え方)の、その日の締めの値(比べる為)。無ければ null。
        old: isObj(prev.old) ? { reads: Math.round(n0(prev.old.reads)), opens: Math.round(n0(prev.old.opens)), byCol: estSummary({ byCol: prev.old.byCol }).byCol } : null,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// 購読1本ぶんの数え方(課金の見込み)
// ---------------------------------------------------------------------------
/**
 * 購読のスナップショット1回で、何件を課金の見込みに足すか。
 *   ・1回目(開いた時・張った時):
 *       控えの続きから再開できない時(fresh=true: 端末が30分以上だれも開いていなかった/後から張った購読)
 *       → 全件(0件でも1件)。控えから出た1回目でも数える(サーバでは全部読み直している)。
 *       再開できる時 → サーバから来た時の docChanges だけ(新しい端末なら全部 added なので全件になる)。
 *   ・2回目から:
 *       控え(fromCache)から出た合図 → 0
 *       サーバの合図 → docChanges の数。ただし直前に「全部読み直し」を数えた(skip=true)なら 0(二重に数えない)
 * @returns { add, skipNext }  skipNext = 次のサーバの合図を数えない
 */
export const listenerEstimate = ({ first, fresh, fromCache, size, changes, skip }) => {
  const sz = Math.max(0, Math.round(n0(size)));
  const ch = Math.max(0, Math.round(n0(changes)));
  if (first) {
    if (fresh) return { add: Math.max(1, sz), skipNext: !!fromCache };
    return { add: fromCache ? 0 : ch, skipNext: false };
  }
  if (fromCache) return { add: 0, skipNext: !!skip };
  if (skip) return { add: 0, skipNext: false };
  return { add: ch, skipNext: false };
};

/** 1回だけ読む問い合わせ(getDocs / getDocsFromServer / REST)。0件でも1件ぶん課金。 */
export const oneShotEstimate = (size) => Math.max(1, Math.round(n0(size)));

/** つながっていない間の長さが「全部読み直し」になる長さか。 */
export const isLongGap = (fromMs, toMs) => n0(toMs) - n0(fromMs) >= LONG_GAP_MS;
