// =============================================================================
//  achieveShelf.js — 📊 生産達成率(標準時間 ÷ 実績時間)を ③ へ渡す共有棚の決まり(2026-10-04)
// -----------------------------------------------------------------------------
//  清水さん(2026-10-04・原文):
//    「標準時間がまだ設定されてないからだね。機能としてはボタン押すだけなんだけど、こっちがしてないから。
//      こっちが押したらすぐそっちも出せる用意しておいて」
//
//  置き場: capacity-shared-v1/achieve_rate/{product|parts|final}(1アプリ1件・丸ごと置き換え)
//    ・書くのは各検査アプリだけ。書くのは「達成率/分析の画面を開いた時(過去のロットを読み終えた後)」と
//      「目標時間を較正して保存した直後」だけ。🚨 新しくロットを読む道は作らない(読みは増やさない)。
//    ・中身が前に書いた物と同じなら書かない(印 sig を端末に控える)。
//    ・読むのは ③ だけ(開いた時に3件 getOne・購読なし)。
//
//  🚨 標準時間は **較正済みの目標(customTargetTimes にある物・型式グループの兄弟を含む)だけ**。
//     既定値(テンプレの targetTime)で動いている作業は標準時間に数えず、「標準時間が未設定の作業」の
//     実績秒(unset)として別に数える(③ が「未設定 ◯%(時間比)」で出す)。
//  🚨 どの作業を数えるか(完了/NG・抜取スキップ・教育中・0秒・目標値の写し)は **各アプリの今の達成率の画面と同じ**。
//     ここは行(rows)を受け取って月×人へ足すだけ。行を作るのは各アプリ(達成率の画面と同じ関数)。
//
//  ⚠ このファイルは 最終(golden)・製品・部品・③ で **同じ物**(md5 一致・試験 achieveShelf.test.mjs)。
//  ⚠ Firestore も React も持たない。保存・端末の控え・今の時刻(clock)は呼ぶ側が渡す。
// =============================================================================

/** 共有棚の名前空間(routes.js の NS.capacity と同じ)。 */
export const ACHIEVE_NS = 'capacity-shared-v1';
/** コレクション名(1アプリ1件・docId = アプリの key)。 */
export const ACHIEVE_COL = 'achieve_rate';
/** 検査の3工程(③ の切替の並び = 総工数比率と同じ 製品→部品→最終)。 */
export const ACHIEVE_APPS = Object.freeze([
  { key: 'product', label: '製品' },
  { key: 'parts', label: '部品' },
  { key: 'final', label: '最終' },
]);
export const achieveAppLabel = (k) => (k === 'all' ? '全体' : (ACHIEVE_APPS.find((a) => a.key === k) || {}).label || k);
/** 達成率の目標(%)の既定。③ の画面で変えて保存できる。 */
export const ACHIEVE_DEFAULT_TARGET = 80;
/** 1件の上限は 1MB。余裕を見てここで止める。 */
export const ACHIEVE_MAX_BYTES = 900_000;
/** 端末に控える「前に書いた中身の印」の鍵。 */
export const achieveSigKey = (app) => `achieve_shelf_sig_v1_${app}`;

const pad2 = (n) => String(n).padStart(2, '0');
/** 端末の時計(日本)での年月 'YYYY-MM'。 */
export const ymOfMs = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
/** 人の名前を「|」区切りの行へ入れられる形に(空は「(名前なし)」)。 */
export const cleanWorker = (w) => (String(w == null ? '' : w).trim().replace(/\|/g, '｜').slice(0, 40) || '(名前なし)');
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * 行 → 月×人 の足し算。
 *   行: { ms, worker, act(実績秒), cal(較正済みの標準秒・未設定なら 0) }
 *   出: Map 'YYYY-MM|人' → { std, act, unset, n, nCal }
 *     std   = Σ較正済みの標準秒          act = Σそれらの実績秒(達成率の分母)
 *     unset = Σ標準時間が未設定の作業の実績秒   n = 全件数  nCal = 較正済みの件数
 */
export const sumAchieveCells = (rows) => {
  const m = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const ms = Number(r.ms); const act = Number(r.act);
    if (!Number.isFinite(ms) || !(act > 0)) continue;
    const key = `${ymOfMs(ms)}|${cleanWorker(r.worker)}`;
    let o = m.get(key);
    if (!o) { o = { std: 0, act: 0, unset: 0, n: 0, nCal: 0 }; m.set(key, o); }
    o.n += 1;
    const cal = Number(r.cal);
    if (cal > 0) { o.std += cal; o.act += act; o.nCal += 1; } else { o.unset += act; }
  }
  return m;
};

/** customTargetTimes の中の較正済みの数(型式の数・工程の数)。 */
export const countCalibrated = (customTargetTimes) => {
  let models = 0; let keys = 0;
  for (const [k, o] of Object.entries(customTargetTimes || {})) {
    if (!o || typeof o !== 'object') continue;
    const n = Object.values(o).filter((v) => typeof v === 'number' && v > 0).length;
    if (n > 0 && String(k).startsWith('model_')) { models += 1; keys += n; } else if (n > 0) keys += n;
  }
  return { models, keys };
};

/** 文字列の印(FNV-1a 32bit・16進)。中身が同じかどうかを見るだけ(暗号ではない)。 */
export const sigOf = (s) => {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};
export const utf8Bytes = (s) => new TextEncoder().encode(String(s)).length;

/**
 * 共有棚へ置く1件を作る。
 *   cells: 'YYYY-MM|人|標準秒|実績秒|未設定の実績秒|件数|較正済みの件数'(配列の中に配列は置けないので文字)
 *   sig  : 中身(cells・較正の数・揃っているか)の印。書いた時刻・理由は印に入れない(同じ中身を書き直さない為)。
 * @param {{app:string, rows:Array, calibrated?:{models:number,keys:number}, complete?:boolean, note?:string, writtenAt:number, reason?:string}} a
 */
export const buildAchieveDoc = ({ app, rows, calibrated = { models: 0, keys: 0 }, complete = true, note = '', writtenAt, reason = '' }) => {
  if (!ACHIEVE_APPS.some((x) => x.key === app)) throw new Error(`知らないアプリ: ${app}`);
  const cells = [...sumAchieveCells(rows).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, o]) => [k, r1(o.std), r1(o.act), r1(o.unset), o.n, o.nCal].join('|'));
  const cal = { models: Number(calibrated && calibrated.models) || 0, keys: Number(calibrated && calibrated.keys) || 0 };
  const body = { cells, calibrated: cal, complete: !!complete, note: String(note || '').slice(0, 200) };
  const sig = sigOf(JSON.stringify([app, body.cells, cal.models, cal.keys, body.complete, body.note]));
  const doc = { v: 1, app, ...body, sig, writtenAt: Number(writtenAt) || 0, reason: String(reason || '') };
  const bytes = utf8Bytes(JSON.stringify(doc));
  if (bytes > ACHIEVE_MAX_BYTES) throw new Error(`達成率の集計が大きすぎて保存できません(${Math.round(bytes / 1024)}KB)`);
  return doc;
};

/**
 * 書く係。同じ中身なら書かない(端末の控え+この画面の中の控え)。
 *   save(doc)  : 共有棚へ丸ごと置き換える(Promise)。呼ぶ側が渡す。
 *   storage    : { get(k), set(k,v) }(localStorage 等・無くてもよい。壊れていても止めない)
 * publish(...) は { written, reason, doc } を返す。失敗は投げる(握り潰さない)。
 */
export const makeAchievePublisher = ({ app, save, storage = null, clock = () => Date.now() }) => {
  let lastSig = null;
  let inflight = null;
  const readSig = () => { try { return storage ? storage.get(achieveSigKey(app)) : null; } catch { return null; } };
  const writeSig = (s) => { try { if (storage) storage.set(achieveSigKey(app), s); } catch { /* 控えられなくても止めない */ } };
  const publish = async ({ rows, calibrated, complete = true, note = '', reason = '' }) => {
    const doc = buildAchieveDoc({ app, rows, calibrated, complete, note, writtenAt: clock(), reason });
    const prev = lastSig != null ? lastSig : readSig();
    if (prev === doc.sig) return { written: false, reason: 'same', doc };
    if (inflight && inflight.sig === doc.sig) { await inflight.p; return { written: false, reason: 'same', doc }; }
    const p = Promise.resolve(save(doc));
    inflight = { sig: doc.sig, p };
    try { await p; } finally { if (inflight && inflight.p === p) inflight = null; }
    lastSig = doc.sig;
    writeSig(doc.sig);
    return { written: true, reason: 'changed', doc };
  };
  return { publish };
};

// ---------------------------------------------------------------------------
// ③ が読む側
// ---------------------------------------------------------------------------
const toNum = (s) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };

/** 共有棚の1件 → 画面で使う形。壊れた行は飛ばす。 */
export const parseAchieveDoc = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  const app = String(doc.app || '');
  if (!ACHIEVE_APPS.some((x) => x.key === app)) return null;
  const cells = [];
  for (const line of Array.isArray(doc.cells) ? doc.cells : []) {
    const p = String(line).split('|');
    if (p.length < 7 || !/^\d{4}-\d{2}$/.test(p[0])) continue;
    cells.push({ app, ym: p[0], worker: p[1], std: toNum(p[2]), act: toNum(p[3]), unset: toNum(p[4]), n: toNum(p[5]), nCal: toNum(p[6]) });
  }
  const c = doc.calibrated && typeof doc.calibrated === 'object' ? doc.calibrated : {};
  return {
    app, cells, writtenAt: Number(doc.writtenAt) || null, reason: String(doc.reason || ''),
    complete: doc.complete !== false, note: String(doc.note || ''),
    calibrated: { models: toNum(c.models), keys: toNum(c.keys) },
  };
};

/** 工程('all'|アプリ)・人の絞り込み。members=null は全員。 */
export const filterAchieveCells = (cells, { app = 'all', members = null, worker = null } = {}) => {
  const set = members ? new Set(members) : null;
  return (cells || []).filter((c) => (app === 'all' || c.app === app) && (!set || set.has(c.worker)) && (!worker || c.worker === worker));
};

/** 達成率(%)。標準も実績も較正済みの作業だけ。実績が0なら null。 */
export const achieveRateOf = (o) => (o && o.act > 0 ? (o.std / o.act) * 100 : null);
/** 標準時間が未設定の作業の割合(時間比 %)。数える実績が0なら null。 */
export const unsetShareOf = (o) => { const all = (o ? o.act + o.unset : 0); return all > 0 ? (o.unset / all) * 100 : null; };

const finish = (o) => ({ ...o, rate: achieveRateOf(o), unsetPct: unsetShareOf(o) });

/** 月ごと(データの無い月は0・率は null)。秒のまま足す。 */
export const achieveMonthly = (cells, months) => {
  const by = new Map(months.map((ym) => [ym, { ym, std: 0, act: 0, unset: 0, n: 0, nCal: 0 }]));
  for (const c of cells || []) {
    const o = by.get(c.ym);
    if (!o) continue;
    o.std += c.std; o.act += c.act; o.unset += c.unset; o.n += c.n; o.nCal += c.nCal;
  }
  return months.map((ym) => finish(by.get(ym)));
};

/** 期間の合計。 */
export const achieveTotal = (series) => {
  const o = { std: 0, act: 0, unset: 0, n: 0, nCal: 0 };
  for (const s of series || []) for (const k of Object.keys(o)) o[k] += s[k];
  return finish(o);
};

/** 人ごとの月の系列(期間に較正済みの実績が無い人は出さない)。 */
export const achievePerWorker = (cells, months) => {
  const workers = [...new Set((cells || []).map((c) => c.worker))].sort((a, b) => a.localeCompare(b, 'ja'));
  return workers
    .map((worker) => { const series = achieveMonthly(cells.filter((c) => c.worker === worker), months); return { worker, series, total: achieveTotal(series) }; })
    .filter((p) => p.total.act > 0);
};

/** データのある最初・最後の月(実績のどれかが0より大きい月)。 */
export const achieveMonthBounds = (cells) => {
  let first = null; let last = null;
  for (const c of cells || []) {
    if (!(c.act + c.unset > 0)) continue;
    if (!first || c.ym < first) first = c.ym;
    if (!last || c.ym > last) last = c.ym;
  }
  return { first, last };
};

/** 秒 → 時間(小数2桁・資料の表と同じ)。 */
export const fmtHours2 = (sec) => (sec == null ? '' : (Math.round((sec / 3600) * 100) / 100).toFixed(2));
/** % → 「85%」(null は —)。 */
export const fmtPct0 = (p) => (p == null ? '—' : `${Math.round(p)}%`);
