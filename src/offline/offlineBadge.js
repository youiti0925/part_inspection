// ============================================================================
// 📴 「オフライン中・未送信 N 件」の札(2026-11-02・8アプリで同じ中身)
// ----------------------------------------------------------------------------
// 何のため: Wi-Fi/LAN/サーバーが切れても検査の入力は続けられる(記録は端末に貯まり、つながると自動で送られる)。
//   その間「今は切れている」「まだ送れていない物が N 件ある」「何が使えないか」を、どの画面でも見える所に出す。
// 作り:
//   ・React を使わない(main.jsx から1回呼ぶだけ・8アプリの画面の作りに依らない)。
//   ・「切れている」の判断は2本の OR: ブラウザの navigator.onLine === false / 同じ口の小さなファイル(precache.json)に
//     HEAD で聞いて返事が無い。⚠Wi-Fi は繋がっているが社内 LAN・サーバーだけ落ちた時は navigator.onLine が true のままなので、
//     聞いてみる方が要る(2026-11-02 の LAN 断はこの形)。
//   ・未送信の数は呼ぶ側が渡す(Firestore 版 = 端末の待ち行列の数 firestorePending.js・社内版 = 送信待ちの箱の数)。
//   ・何も無い時(つながっていて未送信 0)は何も出さない。
// ⚠読み取り(Firestore の課金)は1件も使わない。聞くのは同じ口の静的ファイルへの HEAD だけ(30〜60秒に1回・画面が見えている間だけ)。
// ⚠押す物は 44px 以上・字は 13px 以上(現場は手袋)。
// ============================================================================

/** 使えない物の既定(アプリが上書きできる)。 */
export const DEFAULT_OFFLINE_LIMITS = Object.freeze([
  '機番AI・写真から読む機能(通信が要る)',
  '写真・資料の送信(つながってから撮り直す/送り直す)',
  '通知・連絡の送受信',
  '他の端末が入れた変更の受け取り(つながると届きます)',
]);

/**
 * 札の中身を決める(純関数・試験あり)。
 * @param s.navOnline   navigator.onLine(false の時だけ「切れている」と言い切れる)
 * @param s.probeOk     最後に聞いた返事(true=届いた / false=届かない / null=まだ聞いていない)
 * @param s.pending     { count: number|null, failed: number, known: boolean }
 * @param s.pendingAgeMs 未送信が続いている時間。⚠つながっている時は、普通の保存でも一瞬「未送信 1」になる。
 *                       それを毎回出すと現場が慣れて見なくなるので、SENDING_QUIET_MS 続いた時だけ出す(切れている時はすぐ出す)。
 */
export const SENDING_QUIET_MS = 8000;
export const decideBadge = ({ navOnline = true, probeOk = null, pending = null, pendingAgeMs = Infinity } = {}) => {
  const offline = navOnline === false || probeOk === false;
  const p = pending || {};
  const count = Number.isFinite(p.count) ? Math.max(0, p.count) : null;
  const failed = Math.max(0, Number(p.failed) || 0);
  const has = count === null ? !!p.has : count > 0;
  const hidden = { show: false, offline: false, tone: 'none', text: '', count, failed };
  if (!offline && !has && failed === 0) return hidden;
  if (!offline && failed === 0 && pendingAgeMs < SENDING_QUIET_MS) return hidden;
  const nTxt = count === null ? 'あり' : `${count} 件`;
  let text;
  let tone;
  if (offline) {
    tone = 'offline';
    text = has ? `📴 オフライン中・未送信 ${nTxt}` : '📴 オフライン中(入力は端末に保存されます)';
  } else {
    tone = 'sending';
    text = has ? `⏳ 未送信 ${nTxt}・送信中` : '';
  }
  if (failed > 0) { tone = 'failed'; text = `${text ? `${text}・` : ''}🚨 送れない保存 ${failed} 件(押して確認)`; }
  return { show: true, offline, tone, text, count, failed };
};

const TONE_STYLE = {
  offline: 'background:#475569;border-color:#1e293b;',
  sending: 'background:#d97706;border-color:#92400e;',
  failed: 'background:#e11d48;border-color:#881337;',
};

/**
 * 今「切れている」か(通信が要る機能が、押された時に先に断る為)。
 * ⚠札が置かれていない時は navigator.onLine だけで決める。
 */
export const isAppOffline = (win = (typeof window !== 'undefined' ? window : null)) => {
  if (!win) return false;
  if (win.navigator && win.navigator.onLine === false) return true;
  return win.__appOffline === true;
};

/** 切れている時に、通信が要る機能が出す決まった文(機能の名前を入れる)。 */
export const offlineFeatureMessage = (feature) =>
  `📴 オフライン中のため「${feature}」は使えません。つながってからもう一度押してください。検査の入力・完了はこのまま続けられます(記録は端末に保存され、つながると自動で送られます)。`;

/**
 * 保存の約束(Promise)を待つ。⚠つながっている時は今までと1つも変わらない(そのまま待つ)。
 * 切れている時だけ、最大 ms 待ったら先へ進む(= Firestore の待ち行列には入っている。サーバーの受け取りはつながった時)。
 * 何のため: Firestore の書き込みの約束は「サーバーが受け取った時」にしか解けない。切れている間にそれを await すると、
 *   登録の窓が「保存中」のまま閉じず、作業者が2回押して同じロットが2つできる(2026-11-02 製品の登録で実測)。
 * ⚠送る前に投げる失敗(容量の確認で「いいえ」・形が悪い等)は ms より早く出るので、今まで通り呼んだ側へ届く。
 * ⚠後から失敗した時は、保存の関数が自分で画面に出す(ここでは握り潰さず、未処理の拒否にしない為に受けるだけ)。
 */
export const settleOrQueued = (p, ms = 1500) => {
  if (!p || typeof p.then !== 'function' || !isAppOffline()) return p;
  p.catch((e) => console.warn('[offline] つながってから送った保存が失敗しました', e));
  return Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);
};

/** 同じ口の小さなファイルへ HEAD で聞く(SW は HEAD を扱わない = 本当にネットワークへ行く)。 */
export const probeOnce = async (url, { fetchImpl = (typeof fetch === 'function' ? fetch : null), timeoutMs = 5000 } = {}) => {
  if (!fetchImpl || !url) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => { try { ctl && ctl.abort(); } catch { /* noop */ } }, timeoutMs);
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${url}${sep}probe=${Date.now()}`, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
    // ⚠返事が来た = サーバーまで届いた(404 でも届いている)。5xx は入口が PB/置き場に届かない時もあるので「届かない」側。
    return !!res && res.status > 0 && res.status < 500;
  } catch { return false; } finally { clearTimeout(t); }
};

/**
 * 札を置く。戻りは外す関数。
 * @param probeUrl    同じ口の小さなファイル(例: アプリの根 + 'precache.json')
 * @param getPending  async () => { count: number|null, has?: boolean, failed?: number }
 * @param limits      切れている間に使えない物の説明(行の配列)
 * @param onFailedClick 「送れない保存」を押した時(社内版の送り直しの画面など)。無ければ説明だけ出す。
 */
export const installOfflineBadge = ({
  probeUrl, getPending, limits = DEFAULT_OFFLINE_LIMITS, onFailedClick = null,
  doc = (typeof document !== 'undefined' ? document : null), win = (typeof window !== 'undefined' ? window : null),
  okEveryMs = 60000, offEveryMs = 15000, pendingEveryMs = 5000,
} = {}) => {
  if (!doc || !win || !doc.body) return () => {};
  if (win.__offlineBadgeInstalled) return () => {};
  win.__offlineBadgeInstalled = true;
  let probeOk = null;
  let pending = { count: 0, failed: 0 };
  let pendingSince = 0;   // 未送信が「ある」になった時刻(0 = 無い)
  let dead = false;
  let probeTimer = null;
  let pendTimer = null;
  let open = false;

  const el = doc.createElement('div');
  el.setAttribute('data-offline-badge', '1');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  // ⚠置き場は「下の真ん中」。上に置くと各アプリのヘッダー(タブ・使用者選択・検索)に重なって押せなくなる
  //   (製品の 2026-08-09 の帯と同じ罠・部品のオフライン試験で実測)。最終の保存の札は左下・製品の「保存中」は右下なので真ん中を使う。
  //   iPhone/iPad の下のバー(ホームインジケータ)に掛からない様に safe-area の分だけ上げる。説明の窓は札の上に開く。
  el.style.cssText = 'position:fixed;bottom:calc(8px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);z-index:2147483000;display:none;max-width:94vw;flex-direction:column-reverse;align-items:center;';
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'min-height:44px;padding:6px 14px;border-radius:12px;border:2px solid;color:#fff;font-weight:900;font-size:14px;line-height:1.3;box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;text-align:left;font-family:inherit;';
  const panel = doc.createElement('div');
  panel.style.cssText = 'display:none;margin-bottom:6px;background:#fff;color:#1e293b;border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.6;box-shadow:0 6px 18px rgba(0,0,0,.3);max-width:min(560px,94vw);';
  el.appendChild(btn); el.appendChild(panel);
  doc.body.appendChild(el);

  const render = () => {
    const d = decideBadge({ navOnline: win.navigator ? win.navigator.onLine !== false : true, probeOk, pending,
      pendingAgeMs: pendingSince ? Date.now() - pendingSince : 0 });
    win.__appOffline = !!d.offline;   // 通信が要る機能(機番AI など)が「切れている」と言う為(isAppOffline)
    el.setAttribute('data-state', d.show ? d.tone : 'none');
    el.setAttribute('data-count', d.count === null || d.count === undefined ? '' : String(d.count));
    if (!d.show) { el.style.display = 'none'; open = false; panel.style.display = 'none'; return; }
    el.style.display = 'flex';
    btn.textContent = d.text;
    btn.style.cssText = btn.style.cssText.replace(/background:[^;]*;border-color:[^;]*;/, '') + (TONE_STYLE[d.tone] || TONE_STYLE.offline);
    const lines = [];
    if (d.offline) {
      lines.push('<b>サーバーにつながっていません。</b>検査の入力・開始・完了はそのまま続けられます。記録はこの端末に保存され、つながると<b>自動で送られます</b>(再読込しても端末に残ります)。');
      lines.push('<b>切れている間に使えない物:</b>');
      for (const l of limits) lines.push(`・${String(l).replace(/[<>&]/g, '')}`);
      lines.push('<span style="color:#64748b">⚠ブラウザの「閲覧データを削除」・端末のアプリのデータ削除をすると、送れていない記録も消えます。つながるまで行わないでください。</span>');
      // iPad/iPhone: ホーム画面に置いたアプリは Safari と別の保存場所(web.dev「Storage for the web」)。片方で入れた未送信は、もう片方からは見えない
      lines.push('<span style="color:#64748b">⚠iPad: ホーム画面のアプリと Safari のタブは保存場所が別です。切れている間に入れた記録は、入れた方で開き直してください(つながれば自動で送られます)。</span>');
    } else if (d.count || pending.has) {
      lines.push('つながりました。端末に貯まっていた記録を送っています。');
    }
    if (d.failed > 0) lines.push('<b style="color:#be123c">送れない保存があります。</b>事務所(管理者)に連絡してください。消さずに端末に残してあります。');
    panel.innerHTML = lines.join('<br>');
    panel.style.display = open ? 'block' : 'none';
  };

  btn.addEventListener('click', () => {
    if (pending.failed > 0 && typeof onFailedClick === 'function') { try { onFailedClick(); } catch { /* 札は落とさない */ } }
    open = !open; render();
  });

  const visible = () => !doc.visibilityState || doc.visibilityState === 'visible';
  const doProbe = async () => {
    if (dead) return;
    clearTimeout(probeTimer);
    if (visible()) {
      const was = probeOk;
      probeOk = await probeOnce(probeUrl);
      render();
      // 📴 届かなかったのが届く様になった = 社内 LAN・サーバーが戻った。navigator.onLine は変わらない事が多い(Wi-Fi は繋がったまま)ので、
      //   送信待ちの箱などが「今すぐ送り直す」合図に使える様に知らせる(outbox.js が 'app-reconnected' を聞く)。
      if (was === false && probeOk === true) { try { win.dispatchEvent(new Event('app-reconnected')); } catch { /* 古い端末 */ } }
    }
    if (!dead) probeTimer = setTimeout(doProbe, probeOk === false || (win.navigator && win.navigator.onLine === false) ? offEveryMs : okEveryMs);
  };
  let lastCount = 0;
  const doPending = async () => {
    if (dead) return;
    clearTimeout(pendTimer);
    try { const p = await getPending(); if (p && typeof p === 'object') pending = p; } catch { /* 数えられない時は前の値 */ }
    // 📴 未送信が増えた(=今保存した)のに送れていない時は、待たずに届くか聞き直す(60秒待たずに「オフライン中」と出す)
    const cNow = Number.isFinite(pending.count) ? pending.count : 0;
    if (cNow > lastCount && probeOk !== false) doProbe();
    lastCount = cNow;
    const has = Number.isFinite(pending.count) ? pending.count > 0 : !!pending.has;
    pendingSince = has ? (pendingSince || Date.now()) : 0;
    render();
    if (!dead) pendTimer = setTimeout(doPending, pendingEveryMs);
  };
  const onNet = () => { render(); doProbe(); doPending(); };
  win.addEventListener('online', onNet);
  win.addEventListener('offline', onNet);
  doc.addEventListener('visibilitychange', onNet);
  doProbe(); doPending();
  // 📴 端末の保存(送れていない記録・画面の部品)を「容量が足りない時に消してよい物」から外してもらう(持続保存の申請)。
  //   Chrome/Edge はアプリとして入れた画面などで黙って認める・Safari はホーム画面のアプリなどで認める(どちらも判断はブラウザ)。
  //   ⚠認められなくても動きは変わらない(申請するだけ・画面は止めない)。結果は el の data-persisted に出す(確かめ用)。
  try {
    const st = win.navigator && win.navigator.storage;
    if (st && typeof st.persisted === 'function') {
      st.persisted().then((p) => (p || typeof st.persist !== 'function' ? p : st.persist()))
        .then((p) => { el.setAttribute('data-persisted', p ? '1' : '0'); }, () => {});
    }
  } catch { /* 古い端末 */ }
  return () => {
    dead = true; clearTimeout(probeTimer); clearTimeout(pendTimer);
    win.removeEventListener('online', onNet); win.removeEventListener('offline', onNet);
    doc.removeEventListener('visibilitychange', onNet);
    try { el.remove(); } catch { /* noop */ }
    win.__offlineBadgeInstalled = false;
  };
};
