// =============================================================================
// 🚨 読み取りの枠切れ(429)の帯 — 「押せるか」「畳んでいるか」の決まり(2026-10-01)
// -----------------------------------------------------------------------------
// なぜ: 2026-10-01 に枠を使い切った時、帯の「もう一度読む」が window.location.reload() だった。
//   開き直すとまた 429 で同じ帯が出る(開き直すたびに読みも増える)。
//   それに帯が画面の一番上(z-600)で作業画面のヘッダーまで覆っていた。
// 決まり:
//   ・枠が戻る時刻(until = nextQuotaResetAt・米西部0時=いまは日本時間16:00)より前は **押せない**。
//     ボタンには「16:00 以降に押せます」と出す。
//   ・時刻を過ぎたら押せる。押したら **購読の張り直し**(画面は開き直さない)。
//   ・練習(drill)はいつでも終われる。
//   ・閉じたら until まで **畳む**(1行の細い札にする)。端末に覚える(localStorage・try/catch)。
// ⚠保存を止める門(quotaBlockRef・lotsLoaded)はここでは1つも触らない。決めるのは見せ方だけ。
// =============================================================================

/** 端末に覚える名前。値は「この時刻(ms)まで畳む」。 */
export const QUOTA_BAND_FOLD_KEY = 'partsQuotaBandFoldedUntil.v1';

/** 「16:00」の形(日本時間)。⚠固定値ではなく、その時の until から作る(冬は17:00)。 */
export const quotaClockHHMM = (ms) => {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  try {
    const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t));
    const hh = (parts.find(p => p.type === 'hour') || {}).value;
    const mm = (parts.find(p => p.type === 'minute') || {}).value;
    if (hh != null && mm != null) return `${String(Number(hh) % 24).padStart(2, '0')}:${mm}`;
  } catch { /* 下の予備へ */ }
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 「もう一度読む」を押せるか。
 * @param {{until:number, drill?:boolean}|null} block
 * @returns {{ canRetry:boolean, label:string, action:'none'|'endDrill'|'resubscribe' }}
 */
export const quotaRetryState = (block, nowMs) => {
  if (!block) return { canRetry: false, label: '', action: 'none' };
  if (block.drill) return { canRetry: true, label: '練習を終わる', action: 'endDrill' };
  const until = Number(block.until);
  const now = Number(nowMs) || 0;
  // ⚠ until が読めない時は「押せない」側に倒す(押すと枠を食う)。
  if (!Number.isFinite(until)) return { canRetry: false, label: '枠が戻るまで押せません', action: 'none' };
  if (now < until) return { canRetry: false, label: `${quotaClockHHMM(until)} 以降に押せます`, action: 'none' };
  return { canRetry: true, label: 'もう一度読む', action: 'resubscribe' };
};

/** 畳んでいるか。⚠端末に覚えた時刻を過ぎたら自然に開く。 */
export const isQuotaBandFolded = (storage, nowMs) => {
  let raw = null;
  try { raw = storage && typeof storage.getItem === 'function' ? storage.getItem(QUOTA_BAND_FOLD_KEY) : null; } catch { raw = null; }
  const until = Number(raw);
  if (!raw || !Number.isFinite(until)) return false;
  return (Number(nowMs) || 0) < until;
};

/** 閉じた = until まで畳む。⚠書けない端末(プライベート等)でも投げない(その場だけ畳む)。 */
export const foldQuotaBand = (storage, until) => {
  const t = Number(until);
  if (!Number.isFinite(t)) return false;
  try { if (storage && typeof storage.setItem === 'function') { storage.setItem(QUOTA_BAND_FOLD_KEY, String(t)); return true; } } catch { /* 覚えられないだけ */ }
  return false;
};

/** 開き直す(畳んだのを取り消す)。 */
export const unfoldQuotaBand = (storage) => {
  try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(QUOTA_BAND_FOLD_KEY); } catch { /* noop */ }
};
