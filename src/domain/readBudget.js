// ============================================================================
// 読み取り(read)の予算 — 部品検査アプリ
// ----------------------------------------------------------------------------
// 🚨 2026-08-17、最終検査で **読み取りが枠切れ(429)して 14:36〜15:59 止まった**。
//   無料枠は 50,000件/日。**4アプリで1つ**(同じ Firebase プロジェクト inspection-time-c4fd3)。
//   つまり部品検査が食った分だけ、製品検査と最終検査の枠が減る。
//
// このファイルは「どれだけ読むか」を決める **ただの計算** だけを持つ。
//   Firebase も React も import しない = Node の試験で1行ずつ確かめられる。
//
// ⚠⚠ ここの数を変えると **画面の数字が変わる**。
//   変える時は src/domain/__tests__/readBudget.test.mjs を必ず一緒に直す事。
// ============================================================================

/** 無料枠(1日あたりの読み取り件数)。⚠4アプリ合計でこの数。 */
export const FREE_TIER_DAILY_READS = 50000;

/**
 * 普段いつも購読するロットの件数。
 * ⚠この数より **少なく** 返ってきたら「コレクションを全部読んだ」と確定できる
 *   (createdAt の新しい順に上限まで取っているので、上限に届かない = それが全部)。
 *   その時は今までと1件も違わないので、過去の読み込みは要らない。
 */
export const LOTS_LIVE_LIMIT = 120;

/**
 * 過去が要る画面(完了履歴/分析/達成率/日次実績/成績表)を開いた時に読む件数。
 * ⚠**今までの購読と同じ 500**。だから合体した後の中身は今までと1件も違わない。
 */
export const LOTS_HISTORY_LIMIT = 500;

/**
 * 「窓に入らないが、まだ終わっていないロット」を拾う時の上限(暴走よけ)。
 * ⚠これに届いたら黙って切らずに、画面に「拾い切れていない」と出す事。
 */
export const OPEN_LOTS_LIMIT = 400;

/** 完了を表す status。これ **以外** が「まだ終わっていない」。 */
export const LOT_DONE_STATUS = 'completed';

// ----------------------------------------------------------------------------
// 1) ロットの合体
// ----------------------------------------------------------------------------
/**
 * 土台(base)の **並び順をそのまま保ったまま**、後から来た行で同じ id を差し替える。
 * 土台に無い id は **末尾** に足す(土台は createdAt の新しい順なので、
 * 窓に入らなかった = より古い、が普通)。
 *
 * ⚠並べ替えない。今までの `orderBy('createdAt','desc') + limit(500)` の順を崩さないため。
 * ⚠id の無い行は落とす(合体の突き合わせに使えないので、混ぜると二重に出る)。
 */
export const mergeLotsById = (base, ...overlays) => {
  const out = Array.isArray(base) ? base.slice() : [];
  const at = new Map();
  out.forEach((r, i) => { if (r && r.id != null) at.set(r.id, i); });
  const extra = [];
  for (const arr of overlays) {
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (!r || r.id == null) continue;
      const i = at.get(r.id);
      if (i === undefined) { at.set(r.id, out.length + extra.length); extra.push(r); }
      else out[i] = r;
    }
  }
  return extra.length ? out.concat(extra) : out;
};

/**
 * 上限まで読んで、上限に **届かなかった** なら、それがコレクションの全部。
 * ⚠等号を入れない。ちょうど上限件だった時は「もっと在るかもしれない」が正しい。
 */
export const windowIsWholeCollection = (rowCount, limit) =>
  (Number(rowCount) || 0) < (Number(limit) || 0);

/**
 * 「まだ終わっていないロット」の絞り込み条件。窓口(provider)へ渡す **ただの配列**。
 * ⚠Firestore の where() を画面で組み立てない(保管庫を差し替えられなくなる)。
 */
export const openLotsSpec = () => ({
  where: [['status', '!=', LOT_DONE_STATUS]],
  limit: OPEN_LOTS_LIMIT,
});

/** 普段の窓(いつも購読する分)。 */
export const liveLotsSpec = () => ({
  orderBy: [['createdAt', 'desc']],
  limit: LOTS_LIVE_LIMIT,
  includeMetadataChanges: true,
});

/**
 * 過去が要る時に読む分。⚠**今までの購読と1文字も違わない形**
 * (App.jsx の旧コード: orderBy createdAt desc / limit 500 / includeMetadataChanges true)。
 * ⚠includeMetadataChanges を落とすと「まだサーバへ送れていません」の表示が消える。
 */
export const historyLotsSpec = () => ({
  orderBy: [['createdAt', 'desc']],
  limit: LOTS_HISTORY_LIMIT,
  includeMetadataChanges: true,
});

/**
 * ロットの購読を **どれを張ったままにするか** を決める、ただの計算。
 *
 * 🚨🚨 2026-08-30 に見つけた欠陥の再発止め(試験 R90〜R95)。
 *   窓(live)と過去(history)は、お互いに「相手が居るなら自分は要らない」と引っ込んでいた。
 *     窓  : 過去が届いた(historyLoaded)なら引っ込む
 *     過去: 窓が全部読めた(windowWhole)なら引っ込む
 *   この2つが **同じ描き直しの束で同時に立つ** と、両方が引っ込んで **購読が0本** になる。
 *   (窓と過去は同じコレクションを見ているので、2本とも待っている所へ最初の返事が来ると
 *    1回の処理で2本とも鳴る。React はそれを1つの束にまとめる = 普通に起きる。)
 *   そうなるとロットは最後の姿で **凍る**。しかも
 *     ・読めた印(lotsLoaded)は立ったままなので **保存の門は開いている**
 *     ・保存の見張りが突き合わせる姿(rawLots)も凍った姿のまま
 *     ・過去と窓の中身は同じ瞬間の物なので、突き合わせの見張りも 0件差で黙る
 *   → **画面には何も出ない**。到達する道: ロット総数が窓の上限(120)未満で、
 *     窓の最初の返事が届く前に人が履歴系の画面(完了履歴/分析/作業最適化/達成率/完了一覧/
 *     日次集計/引き継ぎ/異常値)へ移った時。
 *
 * 直し方の考え方: 引っ込む条件を **合体後の `lots` がどちらを読んでいるか** に合わせる。
 *   `lots` は windowWhole なら liveLots を読み、そうでなければ historyLots(+openLots)を読む。
 *   → **画面が読んでいる方は、必ず購読したままにする。**
 *
 * ⚠戻り値の live と history が **同時に false になる事は無い**。
 *   条件の書き方でそう保証してある(history が false なら live は必ず true)。
 *   ⚠ここを「両方の条件を独立に書く」形に戻すと、また0本になる道が開く。
 *
 * @param s {{ windowWhole, historyLoaded, historyWanted, historyWhole }}
 *   windowWhole   普段の窓(120件)が上限に届かなかった = それがコレクションの全部
 *   historyLoaded 過去(500件)のスナップショットが一度でも届いた
 *   historyWanted 過去が要る画面を一度でも開いた
 *   historyWhole  過去が届いていて、かつ上限(500)にも届かなかった
 * @returns {{ live: boolean, history: boolean, open: boolean }} 張ったままにする購読
 */
export const planLotSubscriptions = (s = {}) => {
  const windowWhole = !!s.windowWhole;
  const historyLoaded = !!s.historyLoaded;
  const historyWanted = !!s.historyWanted;
  const historyWhole = !!s.historyWhole;
  // 過去を読むのは「要る画面を開いた」かつ「窓が全部ではない」時だけ。
  const history = historyWanted && !windowWhole;
  // 🚨ここが要。過去を読まないなら **必ず** 窓を張る(history が false → live は true)。
  //   過去を読む時でも、届くまでは窓で繋ぐ(数字が空になる時間を作らない)。
  const live = !history || !historyLoaded;
  // 窓に入らない未完了の拾い直し。窓が全部 / 過去が全部 なら要らない。
  const open = !windowWhole && !historyWhole;
  return { live, history, open };
};

// ----------------------------------------------------------------------------
// 2) 過去のロットが要る画面かどうか
// ----------------------------------------------------------------------------
/**
 * 過去のロットを使う画面の一覧。
 * ⚠ここに書き忘れると **その画面の数字が黙って減る**。足す時は試験も足す事。
 *   main(現場マップ) と inspection(検査リスト) は「いま動いている物」しか出さないので入れない。
 *   ただし main の中の completed-list(完了一覧) は過去が要る → viewMode で見る。
 */
export const HISTORY_TABS = Object.freeze(['history', 'analysis', 'optimize', 'progress']);
export const HISTORY_VIEW_MODES = Object.freeze(['completed-list']);

/**
 * いま過去のロットが要るか。
 * @param s {{ activeTab, viewMode, openPanels: string[] }}
 */
export const needsLotHistory = (s = {}) => {
  if (HISTORY_TABS.includes(s.activeTab)) return true;
  if (HISTORY_VIEW_MODES.includes(s.viewMode)) return true;
  return (s.openPanels || []).some(Boolean);
};

// ----------------------------------------------------------------------------
// 3) 429(読み取りの枠切れ)の見分け
// ----------------------------------------------------------------------------
/**
 * 読み取りの枠切れか。
 * ⚠権限エラー(permission-denied)や通信断(unavailable)と **混ぜない**。
 *   混ぜると「16時まで待て」と嘘を言う事になる。
 */
export const isQuotaError = (e) => {
  if (!e) return false;
  const code = String(e.code || '').toLowerCase();
  if (code === 'resource-exhausted' || code === 'resource_exhausted') return true;
  if (Number(e.status) === 429 || Number(e.code) === 8) return true;
  const msg = String(e.message || e).toLowerCase();
  return /resource[-_ ]exhausted|quota exceeded|too many requests|\b429\b/.test(msg);
};

// ----------------------------------------------------------------------------
// 4) いつ直るか(無料枠が戻る時刻)
// ----------------------------------------------------------------------------
const DAY_MS = 86400000;

/** その時刻の「米西部の時計」と UTC のズレ(ms)。分からなければ null。 */
const pacificOffsetMs = (ms) => {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    if (!Number.isFinite(asUTC)) return null;
    return asUTC - Math.floor(ms / 1000) * 1000;
  } catch { return null; }
};

/**
 * 次に無料枠が戻る時刻(epoch ms)。**米西部の 0時**。
 * ⚠夏時間(いまの季節)は 日本時間 16:00、冬時間は 17:00 になる。
 *   「16:00 固定」と書かない事(冬に1時間ずれた案内をする事になる)。
 */
export const nextQuotaResetAt = (nowMs) => {
  const now = Number(nowMs) || 0;
  const off = pacificOffsetMs(now);
  if (off == null) {
    // 予備: 夏時間(PDT=UTC-7)の0時 = 07:00 UTC = 日本時間 16:00
    const d = new Date(now);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0, 0);
    return t > now ? t : t + DAY_MS;
  }
  const local = now + off;
  const since = ((local % DAY_MS) + DAY_MS) % DAY_MS;
  return now + (DAY_MS - since);
};

/** いまが属する「枠の1日」の名札。日付が変わっても 16時(米西部0時)までは同じ名札。 */
export const quotaDayKeyOf = (nowMs) => new Date(nextQuotaResetAt(nowMs)).toISOString().slice(0, 10);

/** 「あと X時間Y分」。1分未満は「まもなく」。 */
export const formatRemaining = (msLeft) => {
  const ms = Math.max(0, Number(msLeft) || 0);
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'まもなく';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `約${h}時間${m}分` : `約${m}分`;
};

/** 端末の時計で「M月D日 HH:MM」。⚠端末は日本時間の前提(現場のPC/タブレット)。 */
export const formatClock = (ms) => {
  const d = new Date(Number(ms) || 0);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// ----------------------------------------------------------------------------
// 5) この端末が今日いくつ読んだか
// ----------------------------------------------------------------------------
// ⚠**この端末の分だけ**しか数えられない。他の端末・他の3アプリの分は見えない。
//   だから画面にもそう書く事(「全部の合計」と誤解させない)。
// ⚠数える事自体が読み書きを増やしてはいけない → localStorage(端末の中)だけを使う。

export const READ_TALLY_STORAGE_KEY = 'partsReadTally.v1';

export const emptyTally = (day) => ({ day, total: 0, byCol: {}, attaches: 0, since: null });

/**
 * 1回のスナップショットで読んだ件数。**Firestore の課金の数え方に合わせる。**
 * - 数えるのは「変わった件数」(docChanges)。最初の1回は全件が「追加」で来るので全件になる。
 * - 🚨端末のキャッシュから出した分は課金されないので数えない
 *   (永続キャッシュがあると、まずキャッシュで1回鳴ってからサーバの答えでもう1回鳴る)。
 * - ⚠キャッシュが新しいまま開き直した時は、サーバは「変わっていない」とだけ答える。
 *   その時は全件ではなく **最低料金の1件** だけ(全件を数えると実際の何倍にも見える)。
 * @param isFirst      サーバから来た最初のスナップショットか
 * @param changesLength snap.docChanges().length
 * @param fromCache    snap.metadata.fromCache
 */
export const snapshotReads = (isFirst, changesLength, fromCache = false) => {
  if (fromCache) return 0;
  const changed = Math.max(0, Number(changesLength) || 0);
  return isFirst ? Math.max(1, changed) : changed;
};

/** 1回だけの読み(getAll / getPage)。0件でも1件ぶん課金される。 */
export const queryReads = (rowCount) => Math.max(1, Number(rowCount) || 0);

/**
 * 数を足す。⚠枠の1日が変わったら 0 から数え直す(繰り越さない)。
 * ⚠購読を張った時は **0件でも名前を残す**。
 *   そうしないと「読んでいないのか、購読していないのか」を人が見分けられない
 *   (キャッシュが新しいと0件で済む事が普通に在る)。
 */
export const tallyAdd = (tally, day, col, n, opts = {}) => {
  const cur = (tally && tally.day === day) ? tally : emptyTally(day);
  const add = Math.max(0, Math.round(Number(n) || 0));
  const byCol = { ...cur.byCol };
  if (opts.attach && byCol[col] === undefined) byCol[col] = 0;
  if (add > 0) byCol[col] = (byCol[col] || 0) + add;
  return {
    day,
    total: cur.total + add,
    byCol,
    attaches: cur.attaches + (opts.attach ? 1 : 0),
    since: cur.since == null ? (opts.at ?? null) : cur.since,
  };
};

/** 無料枠に対して何%か(小数1桁)。⚠4アプリ合計の枠なので「この端末の分だけ」と併記する事。 */
export const quotaPercent = (total, limit = FREE_TIER_DAILY_READS) => {
  const l = Number(limit) || 0;
  if (l <= 0) return 0;
  return Math.round(((Number(total) || 0) / l) * 1000) / 10;
};

/**
 * 1回開くと何件読むか(見積り)。内訳つき。
 * ⚠「読んだ実績」ではなく **設計上の見積り**。実績は tally の方を見る事。
 * @param counts {{ lots, templates, workers, notes, announcements, observationPlans, logs, indirectWork, improvements }}
 */
export const estimateOpenReads = (counts = {}, opts = {}) => {
  const n = (k) => Math.max(0, Number(counts[k]) || 0);
  const one = (v) => Math.max(1, v); // 0件でも1件ぶん課金される
  const rows = [];
  const push = (col, reads, note) => rows.push({ col, reads, note });

  if (opts.mode === 'before') {
    push('lots', one(Math.min(n('lots'), LOTS_HISTORY_LIMIT)), `全ロットの新しい方から最大${LOTS_HISTORY_LIMIT}件`);
    push('templates', one(n('templates')), '全件');
    push('workers', one(n('workers')), '全件');
    push('logs', one(n('logs')), '全件(使うのはバックアップ画面だけ)');
    push('notes', one(n('notes')), '全件');
    push('announcements', one(n('announcements')), '全件');
    push('indirectWork', one(n('indirectWork')), '全件(使うのは達成率/分析/日次だけ)');
    push('improvements', one(n('improvements')), '全件(使うのは分析だけ)');
    push('observationPlans', one(n('observationPlans')), '全件');
    push('settings/config', 1, '1件');
  } else {
    const lotsN = n('lots');
    const live = one(Math.min(lotsN, LOTS_LIVE_LIMIT));
    push('lots(普段の窓)', live, `新しい方から最大${LOTS_LIVE_LIMIT}件`);
    if (lotsN >= LOTS_LIVE_LIMIT) push('lots(未完了の拾い直し)', one(n('openLots')), '窓に入らない未完了だけ');
    push('templates', one(n('templates')), '全件');
    push('workers', one(n('workers')), '全件');
    push('notes', one(n('notes')), '全件(ヘッダーのバッジで常に使う)');
    push('announcements', one(n('announcements')), '全件(ヘッダーのバッジで常に使う)');
    push('observationPlans', one(n('observationPlans')), '全件(作業画面で使う)');
    push('settings/config', 1, '1件');
  }
  return { rows, total: rows.reduce((s, r) => s + r.reads, 0) };
};
