// ============================================================================
// 📉 ロットの「前回の続きだけ読む」を動かす係(2026-09-28・部品検査)
// ----------------------------------------------------------------------------
// 決まり(何を信じて・いつ全部読みに戻すか)は lotsDeltaSync.js の純関数。ここはそれを順番に呼ぶだけ。
// 形は最終(golden)の lotsDeltaController.js と製品の App.jsx の LS を合わせた物。
//
// ⚠⚠ ここは Firestore も React も import しない。口は **App 側が渡す**:
//   getCachedLots()                     … 端末の控えにあるロット全部(通信なし)[{id, createdAt, status, u, stamp, pending}]
//   openDelta(sinceMs, next, onError)   … 差分(updatedAt > since)の購読。next(rows[{id,u,pending}], snap)
//   openTombs(sinceMs, next, onError)   … 墓標(deletedAt > since)の購読。next(rows[{id,lotId,deletedAt}], snap)
//   refetch(id)                         … そのロットをサーバから1件読み直す(消えていれば控えからも消える)
//   count(spec)                         … 件数だけをサーバに聞く(集計)
//   setSource(src)                      … ①②の窓をどこに張るか: 'server'(今までどおり) | 'cache'(端末の控え) | 'stopped'(429)
//   onQuota(err)                        … 上限(429)。今までの ①が落ちた時と同じ扱い(赤帯・保存を止める)
// 窓(①普段の窓 'live'・②未完了 'open')の購読そのものは App の今の useEffect のまま。
//   App は答えが来るたびに onWindow(name, rows, snap, src)、外した時に windowOff(name, src) を呼ぶ。
//   ③過去(新しい順500件・いつもサーバ)も 'history' として渡す: 過去が引き継いで ①を外した間も、
//   ③のサーバの答えで控え帳を書ける(書かないと前回の控え帳が古いまま残り、次に開いた時に全部読みへ戻る)。
//
// 流れ:
//   開いた時  planLotsSync → 'delta' なら 控えを突き合わせ(checkCachedLots)→ 合えば 差分+墓標を張り、窓は控えへ。
//             合わない・'full' なら 窓はサーバへ(今までどおり)。
//   差分の時  差分と墓標のサーバの答えが来て、墓標の読み直しが済んだら件数を確かめる(集計)。
//             ①の控えの答えが範囲の下へ伸びたら・上限・壊れた・件数が合わない → 控え帳を消して全部読み。
//   閉じる時  控え帳を書く(全部読みでも、サーバの答えが揃っていれば書く = 次に開いた時は差分)。
// ============================================================================
import {
  LOTS_LIVE_LIMIT, LOTS_HISTORY_LIMIT,
} from './readBudget.js';
import {
  DELTA_LIMIT, DELTA_REANCHOR_AT, TOMB_LIMIT, DELTA_MARGIN_MS, DELTA_WAKE_GAP_MS,
  deltaStateKey, tsMs, maxServerMs, planLotsSync, checkCachedLots, liveWindowInRange,
  buildDeltaState, fullWatermarkOf, reanchorSince, countChecksOf,
} from './lotsDeltaSync.js';

const fromCacheOf = (snap) => !!(snap && snap.metadata && snap.metadata.fromCache);
const pendingOf = (snap) => !!(snap && snap.metadata && snap.metadata.hasPendingWrites);

/**
 * @returns {{ start, onWindow, windowOff, wake, flush, stop, info }}
 */
export const createLotsDeltaSync = (deps = {}) => {
  const {
    ns, enabled = true, storage = null, now = () => Date.now(),
    getCachedLots, openDelta, openTombs, refetch, count,
    setSource = () => {}, onQuota = () => {}, isQuota = () => false,
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
    log = () => {}, saveDelayMs = 15000, recountDelayMs = 5000,
  } = deps;
  const key = deltaStateKey(ns);

  let stopped = false;
  let mode = null;              // null(決めている途中) | 'full' | 'delta' | 'stopped'
  let source = null;            // 窓を張っている所
  let reason = '';
  let state = null;             // 差分の時: 開いた時の控え帳(範囲は開いている間これで見る)
  let watermark = null;
  let tombWatermark = null;
  let pair = null;              // { sinceMs, tombSinceMs, deltaServer, tombServer, unsubs }
  let oldPair = null;
  let win = {};                 // name → { rows, server, pending }
  const tombJobs = new Map();   // `${lotId}@${deletedAt}` → Promise<boolean>
  let jobsBusy = 0;
  let countState = 'idle';      // idle | running | ok | failed
  let countTimer = null;
  let saveTimer = null;

  const readState = () => { try { const s = storage && storage.get(key); return s ? JSON.parse(s) : null; } catch { return null; } };
  const writeState = (s) => { try { if (storage) { if (s) storage.set(key, JSON.stringify(s)); else storage.remove(key); } } catch { /* 覚えられなくても読みは今までどおり */ } };
  const safeUnsub = (u) => { try { if (typeof u === 'function') u(); } catch { /* 片付けで画面を落とさない */ } };
  const stopPair = (p) => { if (!p) return; p.unsubs.forEach(safeUnsub); p.unsubs = []; };
  const stopPairs = () => { stopPair(pair); stopPair(oldPair); pair = null; oldPair = null; };
  const clearTimers = () => {
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    if (countTimer) { clearTimer(countTimer); countTimer = null; }
  };

  const switchSource = (src) => {
    if (source === src) return;
    source = src;
    win = win.history ? { history: win.history } : {};   // ③はいつもサーバ(張る所が変わっても同じ購読)
    setSource(src);
  };

  // ── 全部読みへ戻す ────────────────────────────────────────────────────────
  const fallBack = (why) => {
    if (stopped || mode !== 'delta') return;
    log(`📉 ロット: 今までどおり全部読みます(${why})`);
    writeState(null);           // 信じられない控え帳を残さない(次に開いた時も全部読み)
    stopPairs();
    if (countTimer) { clearTimer(countTimer); countTimer = null; }
    mode = 'full'; reason = why; state = null; countState = 'idle';
    switchSource('server');
  };
  const quotaStop = (err) => {
    if (stopped) return;
    stopPairs();
    clearTimers();
    mode = 'stopped'; reason = '上限(429)';
    switchSource('stopped');
    onQuota(err);
  };
  const onPairError = (which) => (err) => {
    if (stopped || mode !== 'delta') return;
    if (isQuota(err)) { quotaStop(err); return; }
    fallBack(`${which}の購読が止まった(${(err && (err.code || err.message)) || err})`);
  };

  // ── 差分と墓標 ────────────────────────────────────────────────────────────
  const afterPairServer = (p) => {
    if (p === pair && oldPair && p.deltaServer && p.tombServer) { stopPair(oldPair); oldPair = null; }
  };
  const onDelta = (p, rows, snap) => {
    if (stopped || mode !== 'delta' || !p.unsubs.length) return;
    if (fromCacheOf(snap)) return;                 // 控えから出ただけ(サーバの答えではない)
    const list = Array.isArray(rows) ? rows : [];
    if (p === pair && list.length >= DELTA_LIMIT) { fallBack(`差分が上限(${DELTA_LIMIT}件)に当たった`); return; }
    const m = maxServerMs(list);
    if (m != null && (watermark == null || m > watermark)) watermark = m;
    p.deltaServer = true;
    afterPairServer(p);
    if (p === pair && list.length >= DELTA_REANCHOR_AT) reanchor(`差分が${list.length}件まで育った`);
    afterChange();
  };
  const onTombs = (p, rows, snap) => {
    if (stopped || mode !== 'delta' || !p.unsubs.length) return;
    const fromCache = fromCacheOf(snap);
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null);
    if (!fromCache && p === pair && list.length >= TOMB_LIMIT) { fallBack(`墓標が上限(${TOMB_LIMIT}件)に当たった`); return; }
    // 墓標1件 = そのロットをサーバから1件読み直す(消えていれば控えから消え、控えに張った窓から外れる)。
    //   ⚠ 読み直しに失敗した物は覚えを消して、次の答え(または次に開いた時)にやり直す。
    const jobs = list.map((r) => {
      const k = `${String(r.lotId || r.id)}@${tsMs(r.deletedAt)}`;
      let job = tombJobs.get(k);
      if (!job) {
        jobsBusy++;
        job = Promise.resolve().then(() => refetch(String(r.lotId || r.id))).then(() => true, (err) => {
          tombJobs.delete(k);
          if (isQuota(err)) { quotaStop(err); return false; }
          log(`📉 ロット: 消えたロット ${r.lotId || r.id} を控えから外せませんでした(あとでやり直します)`, err);
          return false;
        }).finally(() => { jobsBusy--; afterChange(); });
        tombJobs.set(k, job);
      }
      return job;
    });
    if (fromCache) return;
    const tw = maxServerMs(list, 'deletedAt');
    Promise.all(jobs).then((oks) => {
      if (stopped || mode !== 'delta' || !p.unsubs.length) return;
      // ⚠ 全部片付いた時だけ「ここまで片付けた」を進める(1件でも残れば次に開いた時に同じ墓標をもう一度読む)
      if (oks.every(Boolean) && tw != null && (tombWatermark == null || tw > tombWatermark)) tombWatermark = tw;
      p.tombServer = true;
      afterPairServer(p);
      afterChange();
    });
  };
  const startPair = (sinceMs, tombSinceMs) => {
    const p = { sinceMs, tombSinceMs, deltaServer: false, tombServer: false, unsubs: [] };
    p.unsubs.push(openDelta(sinceMs, (rows, snap) => onDelta(p, rows, snap), onPairError('差分')));
    p.unsubs.push(openTombs(tombSinceMs, (rows, snap) => onTombs(p, rows, snap), onPairError('墓標')));
    return p;
  };
  /** 差分の購読を新しい時刻で張り直す(新しい組がサーバの答えを受け取るまで古い組も生かしておく = 取りこぼさない)。 */
  function reanchor(why) {
    if (stopped || mode !== 'delta' || !pair || oldPair || !pair.deltaServer || !pair.tombServer) return false;
    const since = reanchorSince(watermark, pair.sinceMs);
    if (since == null) return false;
    const tombSince = tombWatermark != null ? Math.max(pair.tombSinceMs, tombWatermark - DELTA_MARGIN_MS) : pair.tombSinceMs;
    log(`📉 ロット: 差分の購読を新しい時刻で張り直します(${why})`);
    oldPair = pair;
    pair = startPair(since, tombSince);
    return true;
  }

  // ── 件数の確かめ(集計)────────────────────────────────────────────────────
  const maybeCount = () => {
    if (stopped || mode !== 'delta' || countState !== 'idle') return;
    if (!pair || !pair.deltaServer || !pair.tombServer || jobsBusy > 0) return;
    if (typeof count !== 'function' || typeof getCachedLots !== 'function') { countState = 'ok'; return; }
    countState = 'running';
    runCount(1);
  };
  const runCount = (attempt) => {
    Promise.resolve().then(() => getCachedLots()).then((rows) => {
      if (stopped || mode !== 'delta') return null;
      // 送信待ちが有る間は控えとサーバの件数が違って当たり前 → 少し待って数え直す
      if ((rows || []).some((r) => r && r.pending)) return 'pending';
      const checks = countChecksOf(state, rows);
      return Promise.all(checks.map((c) => Promise.resolve().then(() => count(c.spec)))).then((vals) => checks.map((c, i) => ({ ...c, server: Number(vals[i]) })));
    }).then((res) => {
      if (stopped || mode !== 'delta' || res == null) return;
      if (res !== 'pending') {
        const bad = res.find((c) => c.server !== c.cached);
        if (!bad) { countState = 'ok'; scheduleSave(); return; }
        if (attempt >= 2) { countState = 'failed'; fallBack(`件数が合わない(${bad.key}: サーバ ${bad.server}件 / 控え ${bad.cached}件)`); return; }
      }
      countTimer = setTimer(() => { countTimer = null; if (!stopped && mode === 'delta') runCount(res === 'pending' ? attempt : attempt + 1); }, recountDelayMs);
    }).catch((err) => {
      if (stopped || mode !== 'delta') return;
      if (isQuota(err)) { quotaStop(err); return; }
      countState = 'ok';        // 数えられなかった(通信など)。次に開いた時・戻った時にまた数える
      log('📉 ロット: 件数を確かめられませんでした', err);
    });
  };

  // ── 控え帳 ───────────────────────────────────────────────────────────────
  /** 今の答えから控え帳を作る。まだ作れない(答えが揃っていない・送信待ち)なら undefined、作れない形なら null。 */
  const currentState = () => {
    if (mode !== 'full' && mode !== 'delta') return undefined;
    // 上の窓: ③過去がサーバから届いていればそれ(①を含む・範囲が広い)、無ければ ①
    const H = win.history && win.history.server && !win.history.pending ? win.history : null;
    const L = H || win.live;
    const limit = H ? LOTS_HISTORY_LIMIT : LOTS_LIVE_LIMIT;
    const O = win.open;
    if (!L || L.pending) return undefined;
    const openOn = !!(O && !O.pending && (mode !== 'full' || O.server));
    const whole = L.rows.length < limit;
    if (!whole && !openOn) return undefined;
    if (mode === 'full') {
      if (!L.server) return undefined;
      const wm = fullWatermarkOf(L.rows, openOn ? O.rows : []);
      if (wm == null) return undefined;          // 時刻を持つ行が1件も無い = 前回の時刻を決められない
      // ⚠ 全部読みはサーバの今の答えなので、墓標の時刻も同じ所まで片付いている
      return buildDeltaState({ ns, nowMs: now(), liveRows: L.rows, liveLimit: limit, openRows: openOn ? O.rows : [], openOn, watermarkMs: wm, tombWatermarkMs: wm });
    }
    // 差分: ⚠ 差分のサーバの答えが来る前・墓標の読み直しが済む前・件数が合わなかった時は書かない
    if (!pair || !pair.deltaServer || !pair.tombServer || jobsBusy > 0 || countState === 'failed') return undefined;
    // ⚠ ③の答えを使う時の「ここまで」は、③と差分のどちらも届いている所 = 差分の目印(③は今のサーバの答え)
    return buildDeltaState({ ns, nowMs: now(), liveRows: L.rows, liveLimit: limit, openRows: openOn ? O.rows : [], openOn, watermarkMs: watermark, tombWatermarkMs: tombWatermark });
  };
  const saveNow = () => {
    if (!enabled || mode === 'stopped' || mode == null) return;
    try {
      const s = currentState();
      if (s === undefined) return;               // 揃っていない = 前回の控え帳のまま
      writeState(s);                             // null(上限で切れた等)なら消す = 次は全部読み
    } catch (e) { log('📉 ロット: 控え帳を書けませんでした(次は全部読みます)', e); }
  };
  const scheduleSave = () => {
    if (stopped || !enabled || saveTimer) return;
    saveTimer = setTimer(() => { saveTimer = null; if (!stopped) saveNow(); }, saveDelayMs);
  };
  const afterChange = () => {
    maybeCount();
    scheduleSave();
  };

  return {
    start() {
      if (stopped || mode != null) return;
      const plan = planLotsSync(readState(), { nowMs: now(), ns, enabled });
      if (plan.mode !== 'delta') {
        mode = 'full'; reason = plan.reason;
        if (enabled) log(`📉 ロット: 全部読み(${reason})`);
        switchSource('server');
        return;
      }
      // ⚠ 控えを確かめ終わるまで窓は張らない(確かめる前の控えで「読めた」にしない = 欠けた控えで保存させない)
      Promise.resolve().then(() => getCachedLots()).then((rows) => {
        if (stopped || mode != null) return;
        const chk = checkCachedLots(plan.state, rows, { sinceMs: plan.sinceMs });
        if (!chk.ok) {
          mode = 'full'; reason = `端末の控えが前回と合わない(${chk.reason}: ${chk.id})`;
          log(`📉 ロット: 全部読み(${reason})`);
          switchSource('server');
          return;
        }
        mode = 'delta'; reason = '前回の続き';
        state = plan.state;
        watermark = plan.state.watermarkMs;
        tombWatermark = plan.state.tombWatermarkMs;
        log(`📉 ロット: 前回の続きだけ読みます(updatedAt > ${new Date(plan.sinceMs).toISOString()})`);
        pair = startPair(plan.sinceMs, plan.tombSinceMs);
        switchSource('cache');
      }).catch((e) => {
        if (stopped || mode != null) return;
        mode = 'full'; reason = `端末の控えを読めない(${(e && e.message) || e})`;
        log(`📉 ロット: 全部読み(${reason})`);
        switchSource('server');
      });
    },
    /** ①②の答えが来た(App の購読の受け口から呼ぶ)。src はその購読を張った所。 */
    onWindow(name, rows, snap, src) {
      if (stopped) return;
      if (name === 'history') {   // ③はいつもサーバ(張る所に関わらず受け取る)
        win.history = { rows: Array.isArray(rows) ? rows : [], server: !fromCacheOf(snap), pending: pendingOf(snap) };
        if (mode === 'delta' || mode === 'full') afterChange();
        return;
      }
      if (src !== source) return;
      win[name] = { rows: Array.isArray(rows) ? rows : [], server: !fromCacheOf(snap), pending: pendingOf(snap) };
      if (mode === 'delta' && name === 'live') {
        const r = liveWindowInRange(state, win[name].rows);
        if (!r.ok) { fallBack(r.reason); return; }
      }
      if (mode === 'delta' || mode === 'full') afterChange();
    },
    /** ①②の購読を外した(App の useEffect の片付けから呼ぶ)。 */
    windowOff(name, src) {
      if (name === 'history') { delete win.history; return; }
      if (src !== source) return;
      delete win[name];
    },
    /** 眠っていた・隠れていた・切れていた後に戻った。長く切れていたら差分を今の時刻で張り直し、件数も確かめ直す。 */
    wake(gapMs) {
      if (stopped || mode !== 'delta') return false;
      if (!(Number(gapMs) >= DELTA_WAKE_GAP_MS)) return false;
      const moved = reanchor('眠っていた・切れていた');
      if (countState === 'ok') { countState = 'idle'; maybeCount(); }
      return moved;
    },
    /**
     * 件数をもう一度確かめる(集計 = 1〜2読み)。App が 30分ごとに呼ぶ。
     * ⚠ 墓標を残さない古い版の端末が、開いている間に消した物を見つけるため(最終と同じ)。
     */
    recheck() {
      if (stopped || mode !== 'delta' || countState !== 'ok') return false;
      countState = 'idle';
      maybeCount();
      return true;
    },
    /** 今の控え帳をすぐ書く(画面を閉じる・裏へ回る時)。 */
    flush() { if (saveTimer) { clearTimer(saveTimer); saveTimer = null; } if (!stopped) saveNow(); },
    stop() {
      if (stopped) return;
      if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
      saveNow();
      stopped = true;
      stopPairs();
      clearTimers();
    },
    info() {
      return { mode, source, reason, since: pair ? pair.sinceMs : null, watermark, tombWatermark, countState, whole: state ? state.whole : null };
    },
  };
};
