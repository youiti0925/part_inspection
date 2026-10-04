// =============================================================================
//  operationsSimulation/dailyLoadThrottle.js
//    — 共有棚 capacity-shared-v1/daily_load の書き直しを「5分に1回まで」に間引く決まりと、
//      相手の端末へ「今すぐ書いて」を頼む印(daily_load_requests)の決まり(2026-10-03 B3)
// -----------------------------------------------------------------------------
//  清水さん(2026-10-03 夜・原文):
//    「その頻度でもいいけど、作業者が最新情報欲しい時は、更新ボタン押してできるようにしてもらえるならいいと思うよ」
//
//  直す前: 操業シミュの画面を開いている間、ロットが1回書かれるたびに計算し直し、
//    daily_load を丸ごと書き直していた(聞いている端末 約10台 × 書いた回数 の読みが出る)。
//  直した後:
//    ① 書き直しは 5分に1回まで。🚨 最後の1回は必ず書く(画面を閉じる・ページを隠す/閉じる時に送る)。
//    ② 決めた配置(placement)が変わった時は待たずに書く(人が決めた事。棚の1欄にしか置き場が無い)。
//    ③ 読む側の「最新にする」= 印(daily_load_requests/{app})を書く → 書く側の端末が1台だけ取引で受けて、待たずに書く。
//  🚨 計算の中身・画面の数字は1つも変えない。変えるのは「いつ書くか」だけ。
//  🚨 このファイルは Firestore も React も時計も持たない。「今」と「待つ道具」は呼ぶ側が渡す。
// =============================================================================

/** 書き直しの間隔(5分)。🚨 戻す時はここを 0 にする(毎回書く=直す前と同じ)。 */
export const DAILY_LOAD_MIN_GAP_MS = 5 * 60 * 1000;

/** 「今すぐ書いて」の印の置き場(capacity-shared-v1 の中)。1アプリ1件(docId = product|final)。 */
export const DAILY_LOAD_REQUEST_COL = 'daily_load_requests';

/** 印を書いてから、どの端末も受けなければ「今は応える端末がありません」と出すまで。 */
export const REQUEST_NO_ANSWER_MS = 20 * 1000;
/** 受けた端末が居るのに、新しい数字が届かないまま「届いていません」と出すまで。 */
export const REQUEST_STALL_MS = 2 * 60 * 1000;
/** これより古い印には応えない(後から開いた端末が、昔の印で計算し直さない)。 */
export const REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** 画面を開いていない端末が受けるまでの待ち(画面を開いている端末を先に受けさせる)。 */
export const ANSWER_DELAY_MIN_MS = 1500;
export const ANSWER_DELAY_SPAN_MS = 3000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? '' : String(v));

/** 書類の「急ぎの鍵」= 決めた配置。変わった時は間隔を待たずに書く。 */
export function urgentKeyOf(doc) {
  if (!isObj(doc) || doc.placement === undefined || doc.placement === null) return '';
  try { return JSON.stringify(doc.placement); } catch { return ''; }
}

/**
 * 今この書類を書くか。純関数。
 * @returns {{kind:'none'|'now'|'wait', reason:string, waitMs?:number}}
 *   reason: 'not-ready' 書ける材料が無い / 'same' 前に書いた物と同じ / 'force' 頼まれた・押された /
 *           'first' この画面で初めて / 'urgent' 配置が変わった / 'gap' 間隔が過ぎた / 'leave' 閉じる・隠す / 'throttle' 待つ
 */
export function planDailyLoadWrite({
  doc = null, shelfLoaded = false, sentFp = null, sentUrgentKey = '', sentAtMs = null,
  nowMs = null, minGapMs = DAILY_LOAD_MIN_GAP_MS, forceKey = null, sentForceKey = null, leaving = false,
} = {}) {
  // 🚨 棚を読み終える前は書かない(読む前に書くと、前に決めた配置の無い書類で丸ごと置き換えて配置が消える・2026-09-17)。
  if (!shelfLoaded || !isObj(doc) || !doc.ok || !str(doc.fingerprint)) return { kind: 'none', reason: 'not-ready' };
  // 頼まれた(押された)時は、中身が同じでも書く(相手は「書いた」を見て新しい数字と知る)。
  if (forceKey && forceKey !== sentForceKey) return { kind: 'now', reason: 'force' };
  const urgent = urgentKeyOf(doc);
  const same = str(doc.fingerprint) === str(sentFp);
  if (same && urgent === str(sentUrgentKey)) return { kind: 'none', reason: 'same' };
  if (leaving) return { kind: 'now', reason: 'leave' };
  const last = finite(sentAtMs);
  if (last == null) return { kind: 'now', reason: 'first' };
  if (sentFp != null && urgent !== str(sentUrgentKey)) return { kind: 'now', reason: 'urgent' };
  const now = finite(nowMs);
  const gap = Math.max(0, finite(minGapMs) ?? DAILY_LOAD_MIN_GAP_MS);
  if (now == null) return { kind: 'wait', reason: 'throttle', waitMs: gap };   // 時刻が分からない時は急がない
  const elapsed = now - last;
  if (elapsed >= gap || elapsed < 0) return { kind: 'now', reason: 'gap' };     // 時計が戻った端末でも止まらない
  return { kind: 'wait', reason: 'throttle', waitMs: gap - elapsed };
}

/**
 * 書く係(1画面に1つ)。状態を持つが、時計・待つ道具・書く口は全部呼ぶ側が渡す。
 *   publish(doc)   … 書く口。true=書けた / false=書かなかった を返す Promise(App の publishDailyLoad)
 *   nowFn()        … 今の ms
 *   setTimer/clearTimer … 待つ道具(画面は setTimeout/clearTimeout)
 *   onWrote(info)  … 書けた後に1回(🚨 書く前ではなく書けた後に数える)
 *   onError(e)     … 落ちた時(黙って捨てない)
 *   onChange(state)… 画面の札(最後に書いた時刻・次に書く時刻)を描き直す合図
 */
export function createDailyLoadPublisher({
  publish, nowFn, setTimer, clearTimer, minGapMs = DAILY_LOAD_MIN_GAP_MS,
  onWrote = null, onError = null, onChange = null,
} = {}) {
  let doc = null;
  let shelfLoaded = false;
  let sentFp = null;
  let sentUrgentKey = '';
  let sentAtMs = null;     // 最後に送りに行った時刻(間隔はここから数える)
  let okAtMs = null;       // 最後に書けた時刻(落ちた時は ここへ戻す)
  let sentForceKey = null;
  let forceKey = null;
  let forceDone = null;
  let inFlight = 0;        // 返事待ちの数(札に出すだけ。🚨 門には使わない=返事が遅くても次の書き直しを止めない)
  let timer = null;
  let dueAtMs = null;
  let disposed = false;
  let writeCount = 0;

  const now = () => { const n = finite(typeof nowFn === 'function' ? nowFn() : null); return n; };
  const tell = () => { if (typeof onChange === 'function') { try { onChange(state()); } catch { /* 札が描けなくても書く方は止めない */ } } };
  const stopTimer = () => {
    if (timer != null && typeof clearTimer === 'function') clearTimer(timer);
    timer = null;
    dueAtMs = null;
  };
  function state() {
    const pending = !!(isObj(doc) && doc.ok && shelfLoaded
      && (str(doc.fingerprint) !== str(sentFp) || urgentKeyOf(doc) !== str(sentUrgentKey)));
    return { sentAtMs: okAtMs, dueAtMs, pending, inFlight: inFlight > 0, writeCount, forceKey, sentFp };
  }

  function send(reason, key) {
    const d = doc;
    const t = now();
    sentFp = d.fingerprint;
    sentUrgentKey = urgentKeyOf(d);
    sentAtMs = t;
    if (key) sentForceKey = key;
    inFlight += 1;
    stopTimer();
    tell();
    // publishedAt = 棚へ送った時刻(writtenAt は計算の基準時刻なので、書き直しても変わらない事がある)。
    //   読む側の「最新にする」は、この時刻か answersReq が変わったのを見て「届いた」と知る。
    const body = { ...d, publishedAt: t };
    if (key) body.answersReq = String(key);
    const doneForce = key ? forceDone : null;
    if (key) forceDone = null;
    const fpAtSend = d.fingerprint;
    let result;
    try { result = typeof publish === 'function' ? publish(body) : false; } catch (e) { result = Promise.reject(e); }
    const reopen = () => {
      // 書かなかった・落ちた → 指紋の門を開き直して、次の計算(update)で書き直す(間隔は最後に書けた時刻から)。
      //   頼みは1回で終える(連打しない)。🚨 ここで書き直しに行かない(落ち続ける口へ連打しない)。
      if (sentFp === fpAtSend) { sentFp = null; sentUrgentKey = ''; }
      sentAtMs = okAtMs;
      if (key) { sentForceKey = null; if (forceKey === key) forceKey = null; }
    };
    return Promise.resolve(result)
      .then((wrote) => {
        if (wrote) {
          if (okAtMs == null || (t != null && t > okAtMs)) okAtMs = t;
          writeCount += 1;
          if (typeof onWrote === 'function') onWrote({ reason, atMs: t, forceKey: key || null });
        } else {
          reopen();
        }
        if (doneForce) doneForce(!!wrote);
      })
      .catch((e) => {
        reopen();
        if (typeof onError === 'function') onError(e);
        if (doneForce) doneForce(false);
      })
      .then(() => { inFlight -= 1; tell(); });
  }

  function step(leaving = false) {
    if (disposed && !leaving) return;
    const p = planDailyLoadWrite({
      doc, shelfLoaded, sentFp, sentUrgentKey, sentAtMs, nowMs: now(), minGapMs, forceKey, sentForceKey, leaving,
    });
    if (p.kind === 'now') {
      send(p.reason, p.reason === 'force' ? forceKey : null);
      return;
    }
    if (p.kind === 'wait') {
      if (disposed) return;
      if (timer == null && typeof setTimer === 'function') {
        const w = Math.max(0, finite(p.waitMs) ?? 0);
        const n = now();
        dueAtMs = n == null ? null : n + w;
        timer = setTimer(() => { timer = null; dueAtMs = null; step(false); }, w);
        tell();
      }
      return;
    }
    stopTimer();
    tell();
  }

  return {
    /** 計算の結果が変わった時(描き直しのたび)に呼ぶ。 */
    update(nextDoc, nextShelfLoaded) {
      doc = isObj(nextDoc) ? nextDoc : null;
      shelfLoaded = !!nextShelfLoaded;
      step(false);
    },
    /** 待たずに書く(「今すぐ反映」・相手の端末からの頼み)。done(書けたか) は1回だけ呼ぶ。 */
    force(key, done = null) {
      const k = str(key);
      if (!k) return;
      forceKey = k;
      forceDone = typeof done === 'function' ? done : null;
      step(false);
    },
    /** 画面を隠す・閉じる時。まだ送っていない計算が在れば、間隔を待たずに書く。 */
    flush() { step(true); },
    /** 画面を閉じる時。送っていない物を送ってから、待ちを全部やめる。 */
    dispose() {
      step(true);
      disposed = true;
      stopTimer();
    },
    state,
  };
}

// ── 「今すぐ書いて」の印 ─────────────────────────────────────────────────────

/** 頼みの番号。時計と乱数は呼ぶ側が渡す。 */
export function newRequestId({ nowMs, rand } = {}) {
  const t = finite(nowMs) ?? 0;
  const r = Math.floor((finite(rand) ?? 0) * 1e9);
  return `r${t.toString(36)}${r.toString(36)}`;
}

/** 印の書類。🚨 丸ごと置き換える(前の頼みの「受けた端末」を消して、新しい頼みにする)。 */
export function buildRefreshRequest({ target = '', from = '', nowMs = null, reqId = '' } = {}) {
  const t = finite(nowMs);
  if (!str(target) || !str(reqId) || t == null) return null;
  return { app: str(target), reqId: str(reqId), requestedAt: t, from: str(from), claimedBy: null, claimedAt: null };
}

/** この端末が その印に応えに行くか。 */
export function shouldAnswerRequest({ req = null, hereApp = '', nowMs = null, handledReqId = null, maxAgeMs = REQUEST_MAX_AGE_MS } = {}) {
  if (!isObj(req) || !str(req.reqId) || !str(hereApp)) return false;
  if (req.app && str(req.app) !== str(hereApp)) return false;
  if (req.claimedBy) return false;                         // もう他の端末が受けた
  if (str(req.reqId) === str(handledReqId)) return false;  // この端末で受け終わった
  const t = finite(req.requestedAt);
  const now = finite(nowMs);
  if (t == null || now == null) return false;
  const age = now - t;
  return age <= (finite(maxAgeMs) ?? REQUEST_MAX_AGE_MS) && age >= -REQUEST_MAX_AGE_MS;
}

/** 受けに行くまでの待ち。画面を開いている端末は待たない(その場で書ける)。 */
export function answerDelayMs({ screenOpen = false, rand = 0 } = {}) {
  if (screenOpen) return 0;
  const r = Math.min(1, Math.max(0, finite(rand) ?? 0));
  return ANSWER_DELAY_MIN_MS + Math.floor(r * ANSWER_DELAY_SPAN_MS);
}

/** 書類が「いつ送られたか」の印(無い古い書類は writtenAt)。比べるだけに使う。 */
export function docStampOf(doc) {
  if (!isObj(doc)) return null;
  return finite(doc.publishedAt) ?? finite(doc.writtenAt);
}

/**
 * 押した端末の札。
 *   pending: { reqId, pressedAt, baseStamp, sentOk, failed, claimedAt, arrivedAt }
 * @returns {{phase:'idle'|'sending'|'failed'|'asking'|'claimed'|'arrived'|'noAnswer'|'stalled', pressedAt, arrivedAt, waitedMs}}
 */
export function refreshPhaseOf({ pending = null, req = null, theirDoc = null, nowMs = null } = {}) {
  if (!isObj(pending)) return { phase: 'idle', pressedAt: null, arrivedAt: null, waitedMs: null };
  const pressedAt = finite(pending.pressedAt);
  const now = finite(nowMs);
  const base = { pressedAt, arrivedAt: finite(pending.arrivedAt), waitedMs: null };
  if (base.arrivedAt != null) return { ...base, phase: 'arrived', waitedMs: pressedAt == null ? null : base.arrivedAt - pressedAt };
  if (pending.failed) return { ...base, phase: 'failed' };
  // 届いたか: 頼みの番号が入った書類 / 押した後に送られた書類(時計のずれに左右されない「変わったか」で見る)
  if (isObj(theirDoc)) {
    const stamp = docStampOf(theirDoc);
    const answered = str(theirDoc.answersReq) && str(theirDoc.answersReq) === str(pending.reqId);
    const changed = stamp != null && (finite(pending.baseStamp) == null || stamp > finite(pending.baseStamp));
    if (answered || changed) return { ...base, phase: 'arrived', arrivedAt: now, waitedMs: (now != null && pressedAt != null) ? now - pressedAt : null };
  }
  if (!pending.sentOk) return { ...base, phase: 'sending' };
  const claimed = finite(pending.claimedAt) != null
    || (isObj(req) && str(req.reqId) === str(pending.reqId) && !!req.claimedBy);
  const waited = (now != null && pressedAt != null) ? now - pressedAt : 0;
  if (claimed) return { ...base, phase: waited >= REQUEST_STALL_MS ? 'stalled' : 'claimed' };
  return { ...base, phase: waited >= REQUEST_NO_ANSWER_MS ? 'noAnswer' : 'asking' };
}

const hm = (ms) => {
  const t = finite(ms);
  if (t == null) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 札の1文(作業者向け・短く)。label = 相手の工場の名前(製品検査 / 最終検査)。 */
export function refreshPhaseText(ph, label = '') {
  const who = str(label) || '相手';
  if (!isObj(ph)) return '';
  switch (ph.phase) {
    case 'sending': return '計算を頼んでいます…';
    case 'failed': return '頼めませんでした。もう一度押してください';
    case 'asking': return `計算を頼みました ${hm(ph.pressedAt)}`;
    case 'claimed': return `${who}の端末が計算中 (${hm(ph.pressedAt)} に頼みました)`;
    case 'arrived': return `届きました ${hm(ph.arrivedAt)}${ph.waitedMs != null ? `（${Math.max(0, Math.round(ph.waitedMs / 1000))}秒）` : ''}`;
    case 'noAnswer': return `今は応える端末がありません（${who}のアプリを開いている端末が無い）`;
    case 'stalled': return '届いていません。もう一度押してください';
    default: return '';
  }
}

/** 自分の画面の札(「相手へ反映」の時刻)。 */
export function publishStateText({ sentAtMs = null, dueAtMs = null, pending = false, inFlight = false } = {}) {
  if (inFlight) return '相手へ送っています…';
  const last = finite(sentAtMs);
  const due = finite(dueAtMs);
  if (pending && due != null) return `相手へ反映 ${last != null ? hm(last) : '—'}（次は ${hm(due)} ごろ）`;
  if (last != null) return `相手へ反映 ${hm(last)}`;
  return pending ? '相手へまだ送っていません' : '';
}
