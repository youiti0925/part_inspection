// ============================================================================
// 📉 ロットは「前回の続きだけ読む」(2026-09-28・部品検査)の純関数
// ----------------------------------------------------------------------------
// 製品(product-inspection-app の claude/delta-sync-20260927・bb9933d)と最終(golden の同じ名前の枝・b73f22f)で
// 作った形を、部品の購読の形に合わせて写した。
//   ⚠ 製品の lotsDeltaSync.js とは **1バイト同じにできない**。製品の窓は「作った日の30日の窓」(条件の窓)、
//     部品の窓は「新しい順120件」(上位N件の窓)と「未完了400件」で、どのロットが窓に入るかの決まりが違う。
//     名前・形を揃えた物: 墓標の置き場所(lots_deleted)と中身 {lotId, deletedAt}・差分/墓標の指定・時刻の読み方・
//     余裕5分・墓標の保持期間(2026-10-03 に「7日」から替えた)・上限300/200・張り直し150件/25分。
//
// なぜ要るか:
//   Firestore の購読は **張った時** と **30分より長く切れて戻った時** に、答えを全部読み直す(全部課金)。
//   部品のロットは ①普段の窓(新しい順120件) と ②窓に入らない未完了(400件まで) を開くたびに読み直す。
//
// 形(App.jsx の「ロットの購読」と lotsDeltaController.js が使う):
//   ① ①②の購読は **問い合わせも受け口も今と同じ**。差分読みの時だけ、サーバではなく
//      **端末の控え(persistentLocalCache)** に張る(onSnapshot の source:'cache')。
//      並び・上限・未完了の判定は SDK が同じ問い合わせを控えに対して答える
//      = 控えが「サーバと同じ中身」である限り、画面に出るロットの集合と並びは1件も変わらない。
//   ② 控えを最新にするのは **差分の購読**: where updatedAt > (前回の時刻 − 余裕5分)。
//      ロットを書く道は全部 updatedAt(サーバの時刻)を付ける(saveData・札の戻し・該当なしの掃除)。
//   ③ 消したロットは lots_deleted に墓標 {lotId, deletedAt} を残す。前回より新しい物だけ読み、
//      見つけたらそのロットをサーバから1件読み直す(SDK が「無い」を控えに書き、控えの窓から消える)。
//   ④ 控えを信じてよいかは **開く前に** 端末の中だけで確かめる(checkCachedLots)。
//      前回の終わりに「窓の範囲に居たロットの id と updatedAt」を控え帳(manifest)に書いておき、
//      ・控えのロットで前回の時刻より古い物は、控え帳と同じ版か(控え帳に無いのに範囲に居る = 古い残り)
//      ・控え帳の範囲のロットが控えから消えていないか(控えの掃除 = LRU で消えた等)
//      を見る。さらにサーバに **件数だけ**(集計・1本1読み)を聞いて範囲の件数が合うかを見る
//      (墓標を残さない古い版の端末が消した物が控えに残る形を拾う)。1つでも合わなければ **今までどおり全部読む**。
//   ⑤ 上位N件の窓の「範囲」:
//      ・前回 ①が120件に届かなかった(= それがロット全部) → 範囲 = ロット全部(whole)
//      ・届いた → 範囲 = 前回の120件目より上(createdAt が大きい・同じなら id が大きい = Firestore の並びと同じ)
//        + 未完了の全部(②)。開いている間も ①の控えの答えの120件目が範囲の中に居るかを見張る
//        (消されて窓が範囲の下へ伸びたら、その下は控えが古いかもしれない → 全部読みへ戻す)。
//   ⑥ 全部読みに戻す時: 控え帳が無い・前回から墓標の保持期間より長い(今は無期限=日数では戻さない)・時計が戻った・控えが前回と合わない・
//      件数が合わない・差分/墓標が上限・購読が壊れた・①の窓が範囲の下へ伸びた。
//
// 🚨 画面の数字は1つも変えない。変わるのは「どこから読むか」だけ。
//   全部読みと差分読みで同じロットの集合・同じ並び・同じ版になる事は
//   src/domain/__tests__/lotsDeltaSync.test.mjs の写し(何日分もの作成・更新・完了・再開・削除・墓標なしの削除・
//   一括取込(同じ時刻)・控えの掃除)で確かめる。
//
// ⚠⚠ ここは純関数だけ。localStorage も Firestore も React も触らない(node --test で回す)。
// ============================================================================
import { LOTS_LIVE_LIMIT, OPEN_LOTS_LIMIT, LOT_DONE_STATUS } from './readBudget.js';

const DAY_MS = 86400000;

/** 墓標の置き場所(同じ名前空間の中)。書類ID = ロットの id。⚠製品・最終と同じ名前。 */
export const LOTS_TOMB_COL = 'lots_deleted';
/** 前回の時刻から引く余裕。サーバの時刻どうしで比べるので、端末の時計のずれは入らない。取りこぼし防ぎの糊しろ。 */
export const DELTA_MARGIN_MS = 5 * 60 * 1000;
/**
 * 🪦 墓標(lots_deleted)を残しておく長さ。**今は墓標を消す処理が無い = 無期限(Infinity)**(製品・最終と同じ)。
 *   2026-10-03 に洗った: 部品・製品・最終・③の src / scripts に lots_deleted を消す道は無い(書くのは deleteData の前の save だけ)。
 *   firestore.indexes.json / firebase.json に TTL も無い。Cloud Functions も無い。
 * 🚨 前は「前回から7日以上たったら全部読み」(DELTA_MAX_AGE_MS = 7日)だった。
 *   控え帳の syncedAt は控え帳を書くたびに進むので、毎日使う端末では7日は一度も効かず、
 *   効いたのは **7日以上 開かなかった端末(連休明け)だけ** = 全端末が一斉に全部読み。
 *   差分で取りこぼさない為に要るのは「休んでいた間に消した物の墓標がまだ残っている事」なので、上限は墓標の保持期間に合わせる。
 *   墓標を書かない削除は件数の確かめ(countChecksOf)が拾う。差分が大きすぎる時は DELTA_LIMIT(300)・TOMB_LIMIT(200)で全部読みへ戻る。
 * ⚠墓標を消す・TTL を付ける時は、ここをその長さにする(超えて休んだ端末は全部読みへ戻る)。
 *   試験 DS30 が「墓標を消す道が無い事」を見張る(道を足すと赤になる)。
 */
export const TOMB_RETENTION_MS = Infinity;
/** 墓標の保持期間の境目の糊しろ(端末の時計のずれ・消す処理の遅れ)。保持期間 − これ より長く休んだら全部読み。 */
export const TOMB_RETENTION_MARGIN_MS = DAY_MS;
/** 差分の購読の上限。これに当たったら全部読みへ戻す。 */
export const DELTA_LIMIT = 300;
/** 差分の答えがこの件数まで育ったら、新しい時刻で張り直す(30分超の切断から戻った時の読み直しを小さく保つ)。 */
export const DELTA_REANCHOR_AT = 150;
/** 墓標の購読の上限。 */
export const TOMB_LIMIT = 200;
/** 眠っていた・切れていたとみなす長さ(Firestore の「30分」より少し短く)。 */
export const DELTA_WAKE_GAP_MS = 25 * 60 * 1000;
/** 控え帳の版。形を変えたら上げる(古い控え帳は読まずに全部読みになる)。 */
export const DELTA_STATE_VERSION = 1;
/** 控え帳(localStorage)の鍵。名前空間ごと。 */
export const deltaStateKey = (ns) => `parts.lotsDelta.v${DELTA_STATE_VERSION}.${String(ns || '')}`;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 前回の控え帳の時刻(syncedAt)から今までに消えた物を、墓標でまだ拾えるか(= 墓標の保持期間の内か)。
 * ⚠控え帳は「墓標の購読がサーバの答えを受けた後」にしか書かれない = そこまでの消えた物は控えに入っている。
 * @param retentionMs 墓標の保持期間(既定 TOMB_RETENTION_MS。試験で有限の長さを渡す)
 */
export const tombsCover = (syncedAt, nowMs, retentionMs = TOMB_RETENTION_MS) => {
  if (!fin(syncedAt) || !fin(nowMs)) return false;
  if (retentionMs === Infinity) return true;
  if (!fin(retentionMs) || retentionMs <= 0) return false;
  return nowMs - syncedAt < retentionMs - TOMB_RETENTION_MARGIN_MS;
};

/**
 * サーバの時刻(Timestamp)・数・Date・{seconds,nanoseconds} をミリ秒に。読めなければ null。
 * ⚠ 送信待ち(serverTimestamp がまだ決まっていない)は null で来る = 数えない。
 */
export const tsMs = (v) => {
  if (v == null) return null;
  if (fin(v)) return v;
  if (v instanceof Date) { const t = v.getTime(); return fin(t) ? t : null; }
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') { try { const t = v.toMillis(); return fin(t) ? t : null; } catch { return null; } }
    if (fin(v.seconds)) return v.seconds * 1000 + Math.floor((fin(v.nanoseconds) ? v.nanoseconds : 0) / 1e6);
  }
  return null;
};

/**
 * サーバの時刻の形(Firestore の Timestamp、または {seconds,nanoseconds})か。
 * ⚠ 数(Date.now() で書いた古い形)は **端末の時計** なので「ここまで読んだ」の目印に使わない。
 *   差分の購読(updatedAt > Timestamp)も数の updatedAt には当たらない(型が違う)。
 */
export const isServerStamp = (v) => !!v && typeof v === 'object' && !(v instanceof Date)
  && (typeof v.toMillis === 'function' || fin(v.seconds));

/**
 * ②の `status != 'completed'` と同じ決まり: status の項目が **有って**(null も「有る」) 'completed' でない。
 * ⚠ 控えの行は d.get('status') で作る(項目が無ければ undefined・null はそのまま null)。
 */
export const isOpenLot = (row) => !!row && row.status !== undefined && row.status !== LOT_DONE_STATUS;

/** 差分の購読の指定(ただのデータ。Date は SDK が Timestamp に直す)。 */
export const deltaLotsSpec = (sinceMs, limit = DELTA_LIMIT) => ({
  where: [['updatedAt', '>', new Date(sinceMs)]],
  orderBy: [['updatedAt', 'asc']],
  limit,
});

/** 墓標の購読の指定。 */
export const tombLotsSpec = (sinceMs, limit = TOMB_LIMIT) => ({
  where: [['deletedAt', '>', new Date(sinceMs)]],
  orderBy: [['deletedAt', 'asc']],
  limit,
});

/** 墓標の中身(消す時に書く)。deletedAt はサーバの時刻の印(DATA_SERVER_NOW)を呼ぶ側が入れる。 */
export const tombDocOf = (lotId, serverNow) => ({ lotId: String(lotId), deletedAt: serverNow });

/** サーバから届いた行(送信待ちでない)の時刻の一番新しい物。無ければ null。field='u' は差分の軽い行({id,u,pending})。 */
export const maxServerMs = (rows, field = 'u') => {
  let m = null;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || r.pending) continue;
    const t = field === 'u' ? (fin(r.u) ? r.u : tsMs(r.updatedAt)) : tsMs(r[field]);
    if (t != null && (m == null || t > m)) m = t;
  }
  return m;
};

// ----------------------------------------------------------------------------
// 範囲(控え帳が「サーバと同じ」と言える所)
// ----------------------------------------------------------------------------
/**
 * Firestore の並び(orderBy createdAt desc の同じ時刻の中は書類IDの大きい順)で、id どうしを比べてよい形か。
 * ⚠ 半角(ASCII)だけ・数の書類ID(__id123__)でない物だけ JS の文字の比べ方と同じ並びになる。
 */
export const plainDocId = (id) => typeof id === 'string' && /^[\x20-\x7e]*$/.test(id) && !/^__id-?\d+__$/.test(id);

/**
 * そのロット(createdAt と id)が **上位N件の窓の範囲**(前回の N件目より上か同じ)に居るか。
 * @param edge { c: N件目の createdAt, id: N件目の id }
 */
const aboveEdge = (createdAt, id, edge) => {
  if (!edge || !fin(createdAt)) return false;
  if (createdAt > edge.c) return true;
  return createdAt === edge.c && plainDocId(String(id)) && String(id) >= edge.id;
};

/** 行が控え帳の範囲に居るか(行の今の中身で見る)。 */
export const inCoveredRange = (row, state) => {
  if (!row || !state) return false;
  if (state.whole) return true;
  return isOpenLot(row) || aboveEdge(row.createdAt, row.id, state.edge);
};

/** 控え帳の1行: [updatedAt(ms|null), createdAt(数|null), 未完了か(1/0)]。 */
export const manifestEntryOf = (row) => [
  tsMs(row && row.updatedAt),
  fin(row && row.createdAt) ? row.createdAt : null,
  isOpenLot(row) ? 1 : 0,
];

const manifestInRange = (id, entry, state) => {
  if (!Array.isArray(entry)) return false;
  if (state.whole) return true;
  return entry[2] === 1 || aboveEdge(entry[1], id, state.edge);
};

/** 控え帳の形を確かめる。壊れていれば null(= 全部読み)。 */
export const normalizeDeltaState = (raw, ns) => {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== DELTA_STATE_VERSION) return null;
  if (raw.ns !== ns) return null;
  if (!fin(raw.watermarkMs) || !fin(raw.syncedAt)) return null;
  if (typeof raw.whole !== 'boolean') return null;
  if (!raw.whole && !(raw.edge && fin(raw.edge.c) && plainDocId(raw.edge.id))) return null;
  if (!raw.manifest || typeof raw.manifest !== 'object' || Array.isArray(raw.manifest)) return null;
  return {
    v: raw.v, ns: raw.ns,
    watermarkMs: raw.watermarkMs,
    tombWatermarkMs: fin(raw.tombWatermarkMs) ? raw.tombWatermarkMs : raw.watermarkMs,
    syncedAt: raw.syncedAt,
    whole: raw.whole,
    edge: raw.whole ? null : { c: raw.edge.c, id: raw.edge.id },
    manifest: raw.manifest,
  };
};

/**
 * 開いた時に「差分で読むか・全部読むか」を決める。
 * @param state 控え帳(localStorage から読んだ生の物)
 * @param o { nowMs(端末の時計), ns, enabled(控えが使える保管庫か), tombRetentionMs(墓標の保持期間・試験用) }
 * @returns {{ mode:'delta', sinceMs, tombSinceMs, state } | { mode:'full', reason }}
 */
export const planLotsSync = (state, { nowMs, ns, enabled = true, tombRetentionMs = TOMB_RETENTION_MS } = {}) => {
  if (!enabled) return { mode: 'full', reason: '端末の控えが使えない保管庫' };
  const s = normalizeDeltaState(state, ns);
  if (!s) return { mode: 'full', reason: '前回の控え帳が無い' };
  if (!fin(nowMs) || s.syncedAt > nowMs) return { mode: 'full', reason: '端末の時計が戻った' };
  // 🪦 日数では戻さない(前の「7日以上」はやめた)。戻すのは、休んでいた間の墓標がもう消えているかもしれない時だけ。
  if (!tombsCover(s.syncedAt, nowMs, tombRetentionMs)) return { mode: 'full', reason: '前回から墓標の保持期間より長くたった' };
  return {
    mode: 'delta',
    sinceMs: s.watermarkMs - DELTA_MARGIN_MS,
    tombSinceMs: s.tombWatermarkMs - DELTA_MARGIN_MS,
    state: s,
  };
};

/**
 * 端末の控えを信じてよいか(開く前・通信なし)。
 * @param state normalizeDeltaState の戻り
 * @param cachedRows 控えにあるロット全部 [{ id, createdAt, status, u(ms|null), stamp, pending }]
 * @param o { sinceMs }
 * @returns {{ ok: true } | { ok: false, reason, id }}
 */
export const checkCachedLots = (state, cachedRows, { sinceMs } = {}) => {
  if (!state) return { ok: false, reason: '控え帳が無い', id: '' };
  const man = state.manifest || {};
  const seen = new Set();
  for (const r of (Array.isArray(cachedRows) ? cachedRows : [])) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    seen.add(id);
    // 範囲が上位N件の時: createdAt が数でも null でもない(文字・時刻の形)ロットは並びが数と混ざる → 信じない
    if (!state.whole && r.createdAt !== undefined && r.createdAt !== null && !fin(r.createdAt)) {
      return { ok: false, reason: '作った時刻が数でないロットが控えにある', id };
    }
    if (r.pending) continue;                          // 送信待ち: 届けば updatedAt が新しくなり差分で読み直す
    // 前回の時刻より新しい: 差分の購読が読み直す。⚠ サーバの時刻の形の時だけ(数の updatedAt は差分に当たらない)
    if (fin(r.u) && r.u > sinceMs && r.stamp !== false) continue;
    const m = man[id];
    if (Array.isArray(m)) {
      const mu = fin(m[0]) ? m[0] : null;
      const cu = fin(r.u) ? r.u : null;
      if (mu !== cu) return { ok: false, reason: '控えのロットの版が控え帳と違う', id };
      continue;
    }
    if (inCoveredRange(r, state)) return { ok: false, reason: '控えにある範囲のロットが控え帳に無い(古い残りかもしれない)', id };
  }
  for (const [id, m] of Object.entries(man)) {
    if (seen.has(id)) continue;
    if (manifestInRange(id, m, state)) return { ok: false, reason: '控え帳にある範囲のロットが控えから消えている', id };
  }
  return { ok: true };
};

/**
 * 差分読みの間、①(普段の窓)の控えの答えがまだ範囲の中に収まっているか。
 * ⚠ 範囲が上位N件の時だけ見る。120件に届かない・120件目が前回の120件目より下 = 範囲の外の(古いかもしれない)控えが混ざる。
 * @returns {{ ok: true } | { ok: false, reason }}
 */
export const liveWindowInRange = (state, liveRows) => {
  if (!state || state.whole) return { ok: true };
  const rows = Array.isArray(liveRows) ? liveRows : [];
  if (rows.length < LOTS_LIVE_LIMIT) return { ok: false, reason: `普段の窓が${LOTS_LIVE_LIMIT}件に届かない(消された分、範囲の下へ伸びた)` };
  for (const r of rows) if (!r || !fin(r.createdAt)) return { ok: false, reason: '普段の窓に作った時刻が数でないロットがある' };
  const last = rows[rows.length - 1];
  if (!aboveEdge(last.createdAt, last.id, state.edge)) return { ok: false, reason: '普段の窓の一番下が前回の範囲より下へ伸びた' };
  return { ok: true };
};

/**
 * 今の窓の行から、次に開く時の控え帳を作る。作れない(= 次は全部読み)なら null。
 * @param o {
 *   ns, nowMs,
 *   liveRows     ①の行(新しい順120件の答えのまま)。③過去(新しい順500件)がサーバから届いている時はそちらを渡してよい
 *                (③は①と同じ並びで ①を含む = 範囲が広いだけ)。
 *   liveLimit    liveRows の上限(①=120・③=500)。これに届かない = それがロット全部
 *   openRows     ②の行
 *   openOn       ②の答えを持っているか(張っていて届いている)
 *   watermarkMs  ここまでの変化は控えに入っている、と言えるサーバの時刻
 *   tombWatermarkMs 墓標をここまで片付けた、と言えるサーバの時刻
 * }
 */
export const buildDeltaState = ({ ns, nowMs, liveRows, liveLimit = LOTS_LIVE_LIMIT, openRows, openOn, watermarkMs, tombWatermarkMs } = {}) => {
  if (!fin(watermarkMs) || !fin(nowMs)) return null;
  // 目印がこの端末の「いま」より余裕以上に未来 = 端末の時計が遅れている or 目印がおかしい。書かない(次は全部読み)。
  if (watermarkMs > nowMs + DELTA_MARGIN_MS) return null;
  const live = Array.isArray(liveRows) ? liveRows : [];
  const open = openOn && Array.isArray(openRows) ? openRows : [];
  const whole = live.length < liveLimit;
  let edge = null;
  if (!whole) {
    if (!openOn) return null;                          // 窓より古い未完了を持てていない
    if (open.length >= OPEN_LOTS_LIMIT) return null;   // 未完了が上限で切れた = 全部を持てていない
    for (const r of live) if (!r || !fin(r.createdAt)) return null;
    const last = live[live.length - 1];
    // 境目(120件目/500件目)と同じ時刻のロットは id で並ぶ。id の並びが Firestore と同じと言えない時は作らない
    if (!plainDocId(String(last.id))) return null;
    edge = { c: last.createdAt, id: String(last.id) };
  }
  const manifest = {};
  for (const r of [...live, ...open]) {
    if (!r || r.id == null) continue;
    manifest[String(r.id)] = manifestEntryOf(r);
  }
  return {
    v: DELTA_STATE_VERSION, ns, syncedAt: nowMs, whole, edge,
    watermarkMs, tombWatermarkMs: fin(tombWatermarkMs) ? tombWatermarkMs : watermarkMs,
    manifest,
  };
};

/**
 * 全部読みの時の「ここまでの変化は控えに入っている」時刻 = ①②の行(サーバから届いた物)の updatedAt の一番新しい物。
 * ⚠ サーバの時刻の形(isServerStamp)だけ数える。送信待ち(null)・数の updatedAt(端末の時計)は数えない。
 */
export const fullWatermarkOf = (...groups) => {
  let m = null;
  for (const g of groups) for (const r of (Array.isArray(g) ? g : [])) {
    const t = r && isServerStamp(r.updatedAt) ? tsMs(r.updatedAt) : null;
    if (t != null && (m == null || t > m)) m = t;
  }
  return m;
};

/** 差分の購読を張り直してよいか: 新しい時刻が今の時刻より進んでいる時だけ(同じ時刻で張り直しても読みは減らない)。 */
export const reanchorSince = (watermarkMs, currentSinceMs) => {
  if (!fin(watermarkMs)) return null;
  const s = watermarkMs - DELTA_MARGIN_MS;
  return fin(currentSinceMs) && s <= currentSinceMs ? null : s;
};

/**
 * 件数の確かめ(集計)で聞く物と、控えの同じ範囲の件数。
 * ⚠ 範囲が上位N件の時は「120件目より新しい(createdAt >)」と「未完了」の2本。
 *   120件目と同じ時刻の行は数で絞れないので数えない(そこは控え帳の突き合わせと見張りが守る)。
 * @returns [{ key, spec, cached }]
 */
export const countChecksOf = (state, cachedRows) => {
  const rows = (Array.isArray(cachedRows) ? cachedRows : []).filter((r) => r && r.id != null);
  if (!state) return [];
  if (state.whole) return [{ key: '全部', spec: {}, cached: rows.length }];
  const c = state.edge.c;
  return [
    { key: `作った時刻 > ${c}`, spec: { where: [['createdAt', '>', c]] }, cached: rows.filter((r) => fin(r.createdAt) && r.createdAt > c).length },
    { key: '未完了', spec: { where: [['status', '!=', LOT_DONE_STATUS]] }, cached: rows.filter(isOpenLot).length },
  ];
};
