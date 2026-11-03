// =============================================================================
//  src/opsim/dailyLoadRefresh.js — 共有棚 daily_load の「5分に1回まで」と「最新にする」(2026-10-03 B3)
// -----------------------------------------------------------------------------
//  清水さん(2026-10-03 夜・原文):
//    「その頻度でもいいけど、作業者が最新情報欲しい時は、更新ボタン押してできるようにしてもらえるならいいと思うよ」
//
//  ここに在る物(決まりは全部 domain/operationsSimulation/dailyLoadThrottle.js。ここは React の配線だけ):
//    ・useDailyLoadPublisher … 画面(と裏の書き直し役)が棚へ書く口。5分に1回まで・閉じる/隠す時に最後の1回
//    ・useDailyLoadRefreshHub … App に1つ。「最新にする」の印を書く側(頼む)と、印を見て書く側(応える)
//    ・ボタン2つ(相手の数字の隣の「最新にする」・自分の画面の「今すぐ反映」)は DailyLoadRefreshButton.jsx
//  🚨 計算の中身・画面の数字は変えない。変えるのは「いつ書くか」だけ。
//  🚨 印は capacity-shared-v1/daily_load_requests/{app} の1件。2台が同時に応えても取引(claimOnce)で1台だけが書く。
//  🚨 押す物は min-h-11(44px)・文字は .fi-tap-text / text-2xs 以上。
//  🚨 製品検査と最終検査で同じファイル。片方だけ変えない。
// =============================================================================
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDailyLoadPublisher, newRequestId, buildRefreshRequest, shouldAnswerRequest, answerDelayMs,
  docStampOf, refreshPhaseOf, refreshPhaseText,
} from '../domain/operationsSimulation/dailyLoadThrottle.js';

/** App が配る「応える」側の口(頼まれた書き直し)。画面の部品が読む。値は めったに変わらない。 */
export const DailyLoadForceContext = createContext(null);
/** App が配る「頼む」側の口と札。押してから届くまでの間だけ 1秒ごとに変わる(画面の部品は読まない)。 */
export const DailyLoadRefreshContext = createContext(null);

export const APP_LABEL = Object.freeze({ product: '製品検査', final: '最終検査', parts: '部品検査' });
/** 受けたのに書けないまま、この時間が過ぎたら受け持ちを下ろす(押した端末は「届いていません」を見る)。 */
const FORCE_GIVE_UP_MS = 90 * 1000;

/**
 * 画面(と裏の書き直し役)が共有棚へ書く口。
 * @param doc         自分の工場の日ごとの負荷(hereDailyLoad)
 * @param shelfLoaded 共有棚を読み終えたか(🚨 読む前に書かない)
 * @param publish     App の publishDailyLoad(書けた時 true / 書かなかった時 false)
 * @param onWrote     書けた後に1回(札の数を増やす)
 * @param publishOnly 裏の書き直し役か(頼まれた書き直しを受ける係を分ける)
 */
export function useDailyLoadPublisher({ doc = null, shelfLoaded = false, publish = null, onWrote = null, publishOnly = false } = {}) {
  const force = useContext(DailyLoadForceContext);
  const [info, setInfo] = useState(null);
  const pubRef = useRef(null);
  const publishRef = useRef(publish);
  const onWroteRef = useRef(onWrote);
  // 最新の窓口・数える口を覚える(描く最中には触らない)
  useEffect(() => { publishRef.current = publish; onWroteRef.current = onWrote; });
  const hasPublish = typeof publish === 'function';
  // 書く係は画面を開いている間 1つ。閉じる時に、まだ送っていない計算を送ってから待ちをやめる(最後の1回は必ず書く)。
  useEffect(() => {
    const pub = createDailyLoadPublisher({
      publish: (d) => (typeof publishRef.current === 'function' ? publishRef.current(d) : false),
      nowFn: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
      onWrote: (w) => { if (typeof onWroteRef.current === 'function') onWroteRef.current(w); },
      // 🚨 2026-09-19: 失敗を黙って捨てない。製品検査は 9/16〜9/19 のあいだ 入れ子の配列で書けず、誰も気づけなかった。
      onError: (e) => { console.error('[共有棚] 日ごとの負荷の書き込みに失敗しました', e); },
      onChange: (st) => setInfo(st),
    });
    pubRef.current = pub;
    return () => { pub.dispose(); if (pubRef.current === pub) pubRef.current = null; };
  }, []);
  useEffect(() => {
    if (!hasPublish || !pubRef.current) return;
    pubRef.current.update(doc, shelfLoaded);
  }, [doc, shelfLoaded, hasPublish]);
  // ページを隠す・閉じる時も、まだ送っていない計算を送る(タブを切り替えたまま5分待たせない)。
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const onVis = () => { if (document.visibilityState === 'hidden' && pubRef.current) pubRef.current.flush(); };
    const onHide = () => { if (pubRef.current) pubRef.current.flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  // 相手の端末から頼まれた書き直し。画面を開いている端末は画面が、開いていない端末は裏の書き直し役が受ける。
  const job = force && force.forceJob ? force.forceJob : null;
  const jobId = job ? job.reqId : '';
  const mine = !!job && (publishOnly ? !force.screenOpen : !!force.screenOpen);
  const onForcedDone = force ? force.onForcedDone : null;
  useEffect(() => {
    if (!mine || !jobId || !hasPublish || !pubRef.current) return;
    pubRef.current.force(jobId, (ok) => { if (typeof onForcedDone === 'function') onForcedDone(jobId, ok); });
  }, [mine, jobId, hasPublish, onForcedDone]);
  // 「今すぐ反映」(自分の画面のボタン)
  const publishNow = useCallback(() => {
    if (pubRef.current) pubRef.current.force(`self-${Date.now().toString(36)}`);
  }, []);
  return { info, publishNow };
}

/**
 * App に1つ。「最新にする」を頼む側と、頼まれて書く側。
 * @param api       { writeRequest(target, doc), watchRequest(app, cb, onError) → unsub, claim(app, reqId, by) → {acquired} }
 * @param hereApp   'final' | 'product'
 * @param screenOpen 操業シミュの画面を開いているか
 * @param active    印を聞くか(購読を外している間・連絡ポータルは false)
 * @param docsByApp { product, final } いま見えている daily_load(購読済みの物。読み直さない)
 */
export function useDailyLoadRefreshHub({ api = null, hereApp = '', screenOpen = false, active = false, docsByApp = null } = {}) {
  const deviceIdRef = useRef('');
  const docsRef = useRef(docsByApp);
  const screenOpenRef = useRef(screenOpen);
  // 最新の書類・画面の開き具合を覚える(描く最中には触らない)
  useEffect(() => { docsRef.current = docsByApp; screenOpenRef.current = screenOpen; });

  // ── 頼む側 ───────────────────────────────────────────────────────────────
  const [pendingByApp, setPendingByApp] = useState({});
  const [reqSeen, setReqSeen] = useState({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const patchPending = useCallback((target, reqId, patch) => {
    setPendingByApp((prev) => {
      const cur = prev[target];
      if (!cur || cur.reqId !== reqId) return prev;
      return { ...prev, [target]: { ...cur, ...patch } };
    });
  }, []);
  const request = useCallback((target) => {
    if (!api || !target || target === hereApp) return;
    const nowMs = Date.now();
    const reqId = newRequestId({ nowMs, rand: Math.random() });
    const doc = buildRefreshRequest({ target, from: hereApp, nowMs, reqId });
    if (!doc) return;
    const baseStamp = docStampOf(docsRef.current ? docsRef.current[target] : null);
    setPendingByApp((prev) => ({ ...prev, [target]: { reqId, pressedAt: nowMs, baseStamp, sentOk: false, failed: false, claimedAt: null, arrivedAt: null } }));
    setNowTick(nowMs);
    Promise.resolve(api.writeRequest(target, doc))
      .then(() => patchPending(target, reqId, { sentOk: true }))
      .catch((e) => { console.warn('[共有棚] 最新にするの印が書けませんでした', e); patchPending(target, reqId, { failed: true }); });
  }, [api, hereApp, patchPending]);
  // 札を出す為の1つの式(届いたか・受けた端末が居るか)。
  const phaseOf = useCallback((target, nowMs) => refreshPhaseOf({
    pending: pendingByApp[target] || null,
    req: reqSeen[target] || null,
    theirDoc: docsByApp ? docsByApp[target] : null,
    nowMs,
  }), [pendingByApp, reqSeen, docsByApp]);
  // 届いた時刻を1回だけ覚える(後から見ても同じ時刻を出す)。
  useEffect(() => {
    const now = Date.now();
    Object.keys(pendingByApp).forEach((t) => {
      const p = pendingByApp[t];
      if (!p || p.arrivedAt != null) return;
      const ph = phaseOf(t, now);
      if (ph.phase === 'arrived') patchPending(t, p.reqId, { arrivedAt: now });
    });
  }, [pendingByApp, phaseOf, patchPending]);
  // 待っている間だけ 印を聞く(受けた端末が居るか)。届いた・受けた・誰も受けない で外す。
  const watchTargets = Object.keys(pendingByApp).filter((t) => {
    const ph = phaseOf(t, nowTick).phase;
    return ph === 'asking';
  }).sort().join(',');
  useEffect(() => {
    if (!api || !watchTargets) return undefined;
    const offs = watchTargets.split(',').map((t) => api.watchRequest(t, (d) => {
      setReqSeen((prev) => ({ ...prev, [t]: d || null }));
      if (d && d.claimedBy) {
        setPendingByApp((prev) => {
          const cur = prev[t];
          if (!cur || cur.reqId !== d.reqId || cur.claimedAt != null) return prev;
          return { ...prev, [t]: { ...cur, claimedAt: Date.now() } };
        });
      }
    }, (e) => { console.warn('[共有棚] 最新にするの印が読めていません', e); }));
    return () => offs.forEach((off) => { if (typeof off === 'function') off(); });
  }, [api, watchTargets]);
  // 札の時計(押してから届くまでの間だけ 1秒ごと)。🚨 読み書きは1件もしない。
  const waiting = Object.keys(pendingByApp).some((t) => {
    const ph = phaseOf(t, nowTick).phase;
    return ph === 'sending' || ph === 'asking' || ph === 'claimed';
  });
  useEffect(() => {
    if (!waiting) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  const statusOf = useCallback((target) => {
    const ph = phaseOf(target, nowTick);
    return { ...ph, text: refreshPhaseText(ph, APP_LABEL[target] || '') };
  }, [phaseOf, nowTick]);

  // ── 応える側 ─────────────────────────────────────────────────────────────
  const [ownReq, setOwnReq] = useState(null);
  useEffect(() => {
    if (!api || !active || !hereApp) return undefined;
    const off = api.watchRequest(hereApp, (d) => setOwnReq(d || null), (e) => { console.warn('[共有棚] 最新にするの印が読めていません(応える側)', e); });
    return () => { if (typeof off === 'function') off(); };
  }, [api, active, hereApp]);
  const handledRef = useRef(null);
  const [forceJob, setForceJob] = useState(null);
  useEffect(() => {
    if (!api || !active) return undefined;
    if (!shouldAnswerRequest({ req: ownReq, hereApp, nowMs: Date.now(), handledReqId: handledRef.current })) return undefined;
    const reqId = String(ownReq.reqId);
    // 画面を開いている端末は待たずに受ける。開いていない端末は少し待つ(その間に他の端末が受ければ、印が変わってここは取り消される)
    const t = setTimeout(() => {
      handledRef.current = reqId;
      // この画面(タブ)の名札。受けた端末を印に残すだけ(人の名前は書かない)
      if (!deviceIdRef.current) deviceIdRef.current = `${hereApp || 'app'}-${Math.random().toString(36).slice(2, 10)}`;
      Promise.resolve(api.claim(hereApp, reqId, deviceIdRef.current))
        .then((r) => { if (r && r.acquired) setForceJob({ reqId, at: Date.now() }); })
        .catch((e) => { console.warn('[共有棚] 最新にするの印を受けられませんでした', e); });
    }, answerDelayMs({ screenOpen: screenOpenRef.current, rand: Math.random() }));
    return () => clearTimeout(t);
  }, [api, active, hereApp, ownReq]);
  // 受けたのに書けないまま時間が過ぎたら、受け持ちを下ろす(裏の書き直し役を出しっぱなしにしない)
  useEffect(() => {
    if (!forceJob) return undefined;
    const t = setTimeout(() => setForceJob((cur) => (cur && cur.reqId === forceJob.reqId ? null : cur)), FORCE_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [forceJob]);
  const onForcedDone = useCallback((reqId) => {
    setForceJob((cur) => (cur && cur.reqId === reqId ? null : cur));
  }, []);

  const forceValue = useMemo(() => ({ forceJob, onForcedDone, screenOpen: !!screenOpen }), [forceJob, onForcedDone, screenOpen]);
  const refreshValue = useMemo(() => ({ hereApp, canRequest: !!api, request, statusOf }), [hereApp, api, request, statusOf]);
  return { forceValue, refreshValue, bgForce: !!forceJob && !screenOpen };
}

/** 相手の工場の鍵。書類の app 欄が先、無ければ工場の名前から(書類がまだ届いていない時も押せるように)。 */
export function targetAppOf({ doc = null, label = '' } = {}) {
  if (doc && typeof doc === 'object' && typeof doc.app === 'string' && doc.app) return doc.app;
  const hit = Object.keys(APP_LABEL).find((k) => APP_LABEL[k] === String(label || ''));
  return hit || '';
}
