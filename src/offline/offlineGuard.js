// 目的: 「端末の未送信を守る」 保存を消さないよう頼む・いちばん古い未送信の古さを出す・未送信をファイルに書き出す(設計 A1〜A3・2026-11-28)。
// 入力: 端末の IndexedDB(inspection-outbox の commands)の行・navigator.storage・渡された window/document。
// 出力: 画面の小さな札(data-offline-guard)と、書き出した JSON ファイル(onprem-outbox-export-v1)。
// 呼ぶ人: src/offline/onpremOffline.js(社内版の4アプリで同じ中身)。
// 触る外の物: 端末の IndexedDB を読むだけ(書かない)・保存の持続の申請・ブラウザの「ファイルを保存」。サーバーへは何も送らない。
// 確かめ方: node --test src/data/__tests__/offlineGuard.test.mjs
// ============================================================================
// A1 起動の時に navigator.storage.persist() を頼み、断られたら「この端末は保存が守られていません」を出す。
// A2 いちばん古い未送信の古さ(○時間前)を出し、24 時間を超えたら色を変える(橙)。
// A3 [未送信をファイルに保存] = 箱の中身をそのまま 1 つの JSON にして書き出す(PC を替える前・ブラウザを掃除する前の逃げ道)。
// ⚠読むだけ。箱が無い時に作らない(onupgradeneeded が来たら取り消す)。画面は止めない(全部 try で囲む)。
// ============================================================================
export const GUARD_DB_NAME = 'inspection-outbox';
export const GUARD_STORE_NAME = 'commands';
export const EXPORT_FORMAT = 'onprem-outbox-export-v1';
export const OLD_WARN_MS = 24 * 60 * 60 * 1000;
export const PERSIST_DENIED_TEXT = 'この端末は保存が守られていません(ブラウザの掃除で未送信が消える事があります)';

/** A1: 保存を消さないよう頼む。戻り 'granted' | 'denied' | 'unsupported'。 */
export const requestPersist = async (nav = (typeof navigator !== 'undefined' ? navigator : null)) => {
  try {
    const st = nav && nav.storage;
    if (!st || typeof st.persist !== 'function') return 'unsupported';
    if (typeof st.persisted === 'function' && await st.persisted()) return 'granted';
    return (await st.persist()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
};

/** A2: いちばん古い未送信。rows = 箱の行。 */
export const oldestInfo = (rows, now = Date.now()) => {
  const ts = (rows || []).map((r) => (r && Number.isFinite(r.createdAt) ? r.createdAt : null)).filter((t) => t !== null);
  if (!ts.length) return { oldestAt: null, ageMs: 0, hours: 0, warn: false, text: '' };
  const oldestAt = Math.min(...ts);
  const ageMs = Math.max(0, now - oldestAt);
  const hours = Math.floor(ageMs / 3600000);
  const when = hours >= 1 ? `${hours} 時間前` : `${Math.floor(ageMs / 60000)} 分前`;
  return { oldestAt, ageMs, hours, warn: ageMs > OLD_WARN_MS, text: `いちばん古い未送信: ${when}` };
};

/** A3: 箱の中身をそのまま 1 つの JSON にする(行は 1 つも変えず・減らさない)。 */
export const buildExport = (rows, now = Date.now(), app = '') => JSON.stringify({
  format: EXPORT_FORMAT, exportedAt: new Date(now).toISOString(), app: String(app || ''), count: (rows || []).length, commands: rows || [],
}, null, 1);

/** 箱の全行を読む(cursor・読むだけ)。読めない時は null。 */
export const readOutboxRows = ({ idb = (typeof indexedDB !== 'undefined' ? indexedDB : null) } = {}) => new Promise((resolve) => {
  if (!idb) { resolve(null); return; }
  let req;
  try { req = idb.open(GUARD_DB_NAME); } catch { resolve(null); return; }
  let created = false;
  req.onupgradeneeded = () => { created = true; try { req.transaction.abort(); } catch { /* noop */ } };
  req.onerror = () => resolve(created ? [] : null);
  req.onblocked = () => resolve(null);
  req.onsuccess = () => {
    const db = req.result;
    const done = (v) => { try { db.close(); } catch { /* noop */ } resolve(v); };
    try {
      if (!db.objectStoreNames.contains(GUARD_STORE_NAME)) { done([]); return; }
      const rows = [];
      const g = db.transaction(GUARD_STORE_NAME, 'readonly').objectStore(GUARD_STORE_NAME).openCursor();
      g.onsuccess = () => { const c = g.result; if (c) { rows.push(c.value); c.continue(); } else done(rows); };
      g.onerror = () => done(null);
    } catch { done(null); }
  };
});

/** 書き出したファイルを端末に保存する(a[download])。戻りは保存したファイル名。 */
export const downloadExport = (text, { doc = document, win = window, now = Date.now() } = {}) => {
  const name = `未送信_${new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)}.json`;
  const url = win.URL.createObjectURL(new win.Blob([text], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url; a.download = name;
  doc.body.appendChild(a); a.click(); a.remove();
  const t = setTimeout(() => { try { win.URL.revokeObjectURL(url); } catch { /* noop */ } }, 10000);
  if (t && typeof t.unref === 'function') t.unref();   // node の試験が10秒待たされない(ブラウザでは数字なので何もしない)
  return name;
};

/** 札を置く(A1〜A3 をつなぐ)。戻りは外す関数。 */
export const startOfflineGuard = ({
  doc = (typeof document !== 'undefined' ? document : null), win = (typeof window !== 'undefined' ? window : null),
  idb, nav = (typeof navigator !== 'undefined' ? navigator : null), app = '', everyMs = 30000,
} = {}) => {
  if (!doc || !win || !doc.body || win.__offlineGuardInstalled) return () => {};
  win.__offlineGuardInstalled = true;
  let persist = 'unsupported'; let rows = []; let dead = false; let timer = null;
  const el = doc.createElement('div');
  el.setAttribute('data-offline-guard', '1');
  el.style.cssText = 'position:fixed;bottom:calc(64px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);z-index:2147482999;display:none;max-width:94vw;background:#fff;color:#1e293b;border:2px solid #475569;border-radius:12px;padding:6px 10px;font-size:13px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,.25);';
  const msg = doc.createElement('div');
  const btn = doc.createElement('button');
  btn.type = 'button'; btn.textContent = '未送信をファイルに保存';
  btn.style.cssText = 'min-height:44px;margin-top:4px;padding:6px 12px;border-radius:10px;border:2px solid #1e293b;background:#f1f5f9;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;';
  el.appendChild(msg); el.appendChild(btn); doc.body.appendChild(el);
  const render = () => {
    const o = oldestInfo(rows);
    const lines = [];
    if (rows.length) lines.push(`${o.text}${o.warn ? '(24時間を超えています・早めにつないでください)' : ''}`);
    if (persist === 'denied') lines.push(PERSIST_DENIED_TEXT);
    el.setAttribute('data-persist', persist);
    el.setAttribute('data-warn', o.warn ? '1' : '0');
    el.style.borderColor = o.warn ? '#d97706' : '#475569';
    msg.textContent = lines.join(' / ');
    btn.style.display = rows.length ? 'block' : 'none';
    el.style.display = lines.length ? 'block' : 'none';
  };
  btn.addEventListener('click', async () => {
    try { const r = (await readOutboxRows({ idb })) || rows; downloadExport(buildExport(r, Date.now(), app), { doc, win }); } catch { /* 画面は止めない */ }
  });
  const tick = async () => {
    if (dead) return;
    try { const r = await readOutboxRows({ idb }); if (Array.isArray(r)) rows = r; } catch { /* 前の値 */ }
    render();
    if (!dead) timer = setTimeout(tick, everyMs);
  };
  requestPersist(nav).then((p) => { persist = p; render(); }, () => {});
  tick();
  return () => { dead = true; clearTimeout(timer); try { el.remove(); } catch { /* noop */ } win.__offlineGuardInstalled = false; };
};
