// 🎓 教育の出来事 (education_events) — サインオフと「やり方が変わりました」の純関数。
//
// ■ この小物たちの目的 (3つで1組):
//   ① サインオフ (SignoffModal): 卒業(独り立ち)の瞬間に「横で見た先輩」を1人だけ記録する。
//      Dozuki などの製造業向け手順書サービスに有る「トレーニングのサインオフ」の町工場版。
//      紙のハンコ台帳を作らず、いつもの卒業ボタンの直後に1枚出すだけにする。
//   ② 見守りカード (MimamoriCard): TWI(監督者訓練)の教え方4段階の最後
//      「教えたあと、様子を見に行く」を画面にした物。独り立ち直後の人の
//      最初の数台を、時間と不良の**事実だけ**で1枚に見せる。
//      🚨他人と比べる数字・順位・平均との差は出さない。見守りは応援であって査定ではない。
//   ③ やり方が変わりましたバナー (StandardChangeBanner): エース動画や作業標準を
//      直した時に、その工程を**やった事のある人にだけ**知らせる。教えっぱなし
//      (直したのに現場が古いやり方のまま)を防ぐ。未経験の人には出さない —
//      「変わりました」は前を知っている人向けのお知らせだから。
//
// ■ 評価に使わない:
//   ここの記録は教育のためだけに使う。誰かの査定・順位付け・賞罰の材料にしない。
//   だからこのファイルは比べ物(他人との比率・並び替えの根拠になる数字)を一切作らない。
//
// ■ 保存の器は「追記型」= 1出来事 1ドキュメント (education_events コレクション):
//   多端末で同じ配列に追記すると後勝ちで消える事故が実際に起きている
//   (2026-07-17 の教訓)。出来事ごとに別ドキュメントなら、2台が同時に書いても
//   両方残る。消えて困る記録は**構造で**守る。
//
// ■ ⚠このファイルは純関数だけ:
//   時計や乱数をこの中で作らない。nowMs と rand は必ず呼び出し側から渡す
//   (テストで固定できる・多端末の時刻ズレも呼び出し側で1回だけ吸収できる)。
//   画面(React)や保存(Firestore)もここに書かない。
//
// ■ 工程の鍵:
//   エース動画のひも付け(video_recipes の stepKeys)は **step.id 系**
//   (App.jsx 14403 の `steps.map(s => ({ key: s.id, ... }))` と aceFor が根拠)。
//   タスクの鍵は `${step.id}-${台番号}` / `${step.id}-lot-${回数}` / `${数値index}-${台番号}`
//   の3形式が混在する (App.jsx 16442〜16457 と同じ読み方をする)。

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ 時刻の読み方
// Firestore Timestamp ({seconds,nanoseconds}) と 数値ms を読む。
// ⚠文字列の日付はここでは読まない (時計の部品をこのファイルに持ち込まないため)。
//   文字列も読みたい呼び出し側は、App.jsx の toMsAny を toMs 引数で渡すこと。
const defaultToMs = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'number') return (Number.isFinite(raw) && raw > 0) ? raw : null;
  if (typeof raw === 'object' && raw.seconds) return raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0) ? n : null;
};

/** タスクが「いつ終わったか」(ms)。endTime → firstStartTime+duration → startTime+duration の順 (domain/dailyWork.js と同じ考え方)。 */
const taskEndMsOf = (task, toMs) => {
  const t = task || {};
  const durMs = (Number(t.duration) || 0) * 1000;
  const end = toMs(t.endTime);
  if (end > 0) return end;
  const first = toMs(t.firstStartTime);
  if (first > 0) return first + durMs;
  const st = toMs(t.startTime);
  if (st > 0) return st + durMs;
  return 0;
};

/**
 * タスクの鍵 → その工程 (lot.steps の1件) 。
 * 鍵の3形式 (`${id}-${台}` / `${id}-lot-${回}` / `${index}-${台}`) を App.jsx 16442〜16457 と同じ順で読む。
 * 見つからなければ null (推測で別の工程を返さない)。
 */
const stepOfTaskKey = (steps, key) => {
  const list = Array.isArray(steps) ? steps : [];
  const k = String(key || '');
  if (!k) return null;
  const lotM = k.match(/^(.+)-lot-(\d+)$/);
  const dash = k.lastIndexOf('-');
  const prefix = lotM ? lotM[1] : (dash >= 0 ? k.slice(0, dash) : k);
  if (/^\d+$/.test(prefix)) return list[Number(prefix)] || null;
  return list.find(s => s && String(s.id) === prefix) || null;
};

// ------------------------------------------------------------ 保存する形を作る (検証つき)
export const STANDARD_CHANGE_SOURCES = ['video', 'workStandard'];

/**
 * サインオフ1件。卒業(独り立ち)の瞬間に「横で見た先輩」を残す。
 * ⚠不正はその場で throw する。黙って欠けた記録を作ると、後で読む側が全員困る。
 */
export const buildSignoffDoc = ({ worker, senior, lotId = '', orderNo = '', by, nowMs, rand, note = '' } = {}) => {
  const w = String(worker || '').trim();
  const s = String(senior || '').trim();
  const b = String(by || '').trim();
  const at = Number(nowMs);
  const r = String(rand || '').trim();
  if (!w) throw new Error('worker（独り立ちした人の名前）が空です');
  if (!s) throw new Error('senior（横で見た先輩の名前）が空です');
  if (w === s) throw new Error('worker と senior が同じ名前です。横で見た先輩は本人以外を選んでください');
  if (!b) throw new Error('by（操作した人の名前）が空です');
  if (!Number.isFinite(at) || !(at > 0)) throw new Error('nowMs（時刻ms）が正の数値ではありません');
  if (!r) throw new Error('rand（idの末尾。呼び出し側で作って渡す）が空です');
  return {
    id: `ed-${at}-${r}`,
    kind: 'signoff',
    worker: w,
    senior: s,
    lotId: String(lotId || '').trim(),
    orderNo: String(orderNo || '').trim(),
    by: b,
    at,
    note: String(note || '').trim(),
  };
};

/**
 * 「やり方が変わりました」1件。エース動画(source:'video')か作業標準(source:'workStandard')を
 * 直した時に作る。stepId は必須 — どの工程の話か分からないお知らせは出しても誰も動けない。
 */
export const buildStandardChangeDoc = ({ source, stepId, stepTitle = '', title, by, nowMs, rand } = {}) => {
  const src = String(source || '');
  if (!STANDARD_CHANGE_SOURCES.includes(src)) throw new Error("source は 'video' か 'workStandard' のどちらかです");
  const sid = String(stepId || '').trim();
  if (!sid) throw new Error('stepId（その工程の鍵）が空です');
  const ttl = String(title || '').trim();
  if (!ttl) throw new Error('title（何が変わったかの短文）が空です');
  const b = String(by || '').trim();
  if (!b) throw new Error('by（操作した人の名前）が空です');
  const at = Number(nowMs);
  if (!Number.isFinite(at) || !(at > 0)) throw new Error('nowMs（時刻ms）が正の数値ではありません');
  const r = String(rand || '').trim();
  if (!r) throw new Error('rand（idの末尾。呼び出し側で作って渡す）が空です');
  return {
    id: `ed-${at}-${r}`,
    kind: 'standard_change',
    source: src,
    stepId: sid,
    stepTitle: String(stepTitle || '').trim(),
    title: ttl,
    by: b,
    at,
  };
};

// ------------------------------------------------------------ 読み出し (導出)
/**
 * サインオフの一覧 → 人ごとのまとめ。
 * 返り値: { byWorker: Map(worker名 → { senior, lotId, orderNo, atMs, history:[…at昇順] }), badDocs }
 *   ・kind:'signoff' 以外は黙って読み飛ばす (badDocs にも数えない。器は共用だから他の種類が居て正常)。
 *   ・壊れた doc (worker/senior/at が欠けている等) は badDocs で数える。黙って捨てると
 *     「記録したはずなのに出ない」の原因が誰にも見えなくなる。
 *   ・同じ人に複数あれば at 昇順で最後の1件を表に出し、全件を history に残す
 *     (記録を上書きで消さない。追記型の器と同じ考え方)。
 */
export const deriveSignoffs = (events) => {
  const byWorker = new Map();
  let badDocs = 0;
  const rows = [];
  (Array.isArray(events) ? events : []).forEach((e) => {
    if (!e || typeof e !== 'object') { badDocs += 1; return; }
    if (e.kind !== 'signoff') return;
    const worker = String(e.worker || '').trim();
    const senior = String(e.senior || '').trim();
    const at = Number(e.at) || 0;
    if (!worker || !senior || !(at > 0)) { badDocs += 1; return; }
    rows.push({
      worker, senior,
      lotId: String(e.lotId || ''),
      orderNo: String(e.orderNo || ''),
      by: String(e.by || ''),
      note: String(e.note || ''),
      atMs: at,
      id: String(e.id || ''),
    });
  });
  rows.sort((a, b) => (a.atMs - b.atMs) || a.id.localeCompare(b.id));
  rows.forEach((r) => {
    const cur = byWorker.get(r.worker) || { history: [] };
    cur.history.push(r);
    cur.senior = r.senior;
    cur.lotId = r.lotId;
    cur.orderNo = r.orderNo;
    cur.atMs = r.atMs;
    byWorker.set(r.worker, cur);
  });
  return { byWorker, badDocs };
};

/**
 * その人が最近さわったロット (新しい順・limit件)。サインオフの「そのロット」候補に使う。
 * task.workerName がその人のタスクを持つ完了/進行ロットだけ。
 */
export const recentLotsOfWorker = ({ lots = [], workerName = '', limit = 8, toMs = null } = {}) => {
  const t = toMs || defaultToMs;
  const name = String(workerName || '').trim();
  if (!name) return [];
  const out = [];
  (Array.isArray(lots) ? lots : []).forEach((l) => {
    if (!l) return;
    const tasks = (l.tasks && typeof l.tasks === 'object') ? l.tasks : {};
    let hit = false;
    let lastMs = 0;
    Object.values(tasks).forEach((task) => {
      if (!task || typeof task !== 'object') return;
      if (String(task.workerName || '').trim() !== name) return;
      if (task.status !== 'completed' && task.status !== 'ng' && task.status !== 'processing') return;
      hit = true;
      const ms = taskEndMsOf(task, t) || t(task.startTime) || 0;
      if (ms > lastMs) lastMs = ms;
    });
    if (!hit) return;
    if (!(lastMs > 0)) lastMs = t(l.completedAt) || t(l.updatedAt) || t(l.createdAt) || 0;
    out.push({
      lotId: String(l.id || l.__id || ''),
      orderNo: String(l.orderNo || ''),
      model: String(l.model || ''),
      lastMs,
    });
  });
  out.sort((a, b) => (b.lastMs - a.lastMs) || a.lotId.localeCompare(b.lotId));
  return out.slice(0, Math.max(0, Number(limit) || 0));
};

/**
 * 👀 見守りレポート。卒業(graduatedAt)が nowMs から windowDays 以内の人だけカードにする。
 * カードの中身は「卒業のあとに終わった作業」の事実 (工程名・型式・時間・不良の有無) を
 * **古い順に maxItems 件** = 独り立ちして最初の数台。
 * 🚨他人との比べ物 (比率・順位・平均との差) はここに一切入れない。
 * ⚠記録が0件でもカードは出す — 画面が「まだ記録がありません」を出せるようにする
 *   (カードごと消すと「見守る相手が居る」事実まで消える)。
 */
export const buildMimamoriReport = ({ lots = [], workers = [], signoffs = null, nowMs, windowDays = 14, maxItems = 10, toMs = null } = {}) => {
  const t = toMs || defaultToMs;
  const now = Number(nowMs) || 0;
  const winMs = Math.max(0, Number(windowDays) || 0) * DAY_MS;
  const byWorker = (signoffs && signoffs.byWorker instanceof Map) ? signoffs.byWorker
    : (signoffs instanceof Map ? signoffs : new Map());
  const cards = [];
  (Array.isArray(workers) ? workers : []).forEach((w) => {
    if (!w || w.trainee === true) return;      // いま🎓の人は「卒業直後」ではない
    const name = String(w.name || '').trim();
    if (!name) return;
    const gMs = t(w.graduatedAt) || 0;
    if (!(gMs > 0)) return;
    const since = now - gMs;
    if (since < 0 || since > winMs) return;    // ちょうど windowDays は入れる (<=)
    const all = [];
    (Array.isArray(lots) ? lots : []).forEach((l) => {
      if (!l) return;
      const steps = Array.isArray(l.steps) ? l.steps : [];
      const tasks = (l.tasks && typeof l.tasks === 'object') ? l.tasks : {};
      Object.keys(tasks).forEach((k) => {
        const task = tasks[k];
        if (!task || typeof task !== 'object') return;
        if (task.status !== 'completed' && task.status !== 'ng') return;
        if (String(task.workerName || '').trim() !== name) return;
        const endMs = taskEndMsOf(task, t);
        if (!(endMs > gMs)) return;            // 卒業より前(同時刻を含む)の記録は入れない
        const step = stepOfTaskKey(steps, k);
        all.push({
          orderNo: String(l.orderNo || ''),
          model: String(l.model || ''),
          stepTitle: String((step && step.title) || ''),
          durationSec: Number(task.duration) || 0,
          ng: task.status === 'ng' || !!task.ngReason,
          ngReason: String(task.ngReason || ''),
          endMs,
        });
      });
    });
    all.sort((a, b) => a.endMs - b.endMs);     // 古い順 = 独り立ちして最初の数台
    const sf = byWorker.get(name);
    cards.push({
      worker: name,
      graduatedAtMs: gMs,
      senior: (sf && sf.senior) || null,
      sinceDays: Math.floor(since / DAY_MS),
      items: all.slice(0, Math.max(0, Number(maxItems) || 0)),
      count: all.length,
      ngCount: all.filter(x => x.ng).length,
    });
  });
  cards.sort((a, b) => (b.graduatedAtMs - a.graduatedAtMs) || a.worker.localeCompare(b.worker));
  return { cards };
};

/**
 * 📢 その人にまだ出していない「やり方が変わりました」(新しい順)。
 *   ・kind:'standard_change' だけ。
 *   ・at が maxAgeDays 以内 (ちょうど maxAgeDays 日前は入れる)。古い変更を今さら出さない。
 *   ・seenIds (端末の既読) に無い物だけ。
 *   ・その人がその stepId の工程を過去に completed/ng した記録が1件でもある時だけ —
 *     「変わりました」は前のやり方を知っている人向け。未経験の人には出さない
 *     (未経験の人は最初から新しいやり方で教わるので、このお知らせは雑音になる)。
 */
export const pendingStandardChanges = ({ events = [], lots = [], workerName = '', seenIds = [], nowMs, maxAgeDays = 60, toMs = null } = {}) => {
  const t = toMs || defaultToMs;
  const name = String(workerName || '').trim();
  if (!name) return [];
  const now = Number(nowMs) || 0;
  const maxAge = Math.max(0, Number(maxAgeDays) || 0) * DAY_MS;
  const seen = new Set(Array.isArray(seenIds) ? seenIds : []);
  // 先に「やった事のある工程」の集合を作る (イベントごとに全ロットをなめ直さない)
  const doneSteps = new Set();
  (Array.isArray(lots) ? lots : []).forEach((l) => {
    if (!l) return;
    const steps = Array.isArray(l.steps) ? l.steps : [];
    const tasks = (l.tasks && typeof l.tasks === 'object') ? l.tasks : {};
    Object.keys(tasks).forEach((k) => {
      const task = tasks[k];
      if (!task || typeof task !== 'object') return;
      if (task.status !== 'completed' && task.status !== 'ng') return;
      if (String(task.workerName || '').trim() !== name) return;
      const step = stepOfTaskKey(steps, k);
      if (step && step.id != null && String(step.id)) doneSteps.add(String(step.id));
    });
  });
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === 'object' && e.kind === 'standard_change')
    .filter((e) => {
      const at = t(e.at) || 0;
      if (!(at > 0)) return false;
      if (now - at > maxAge) return false;   // 古すぎる変更は出さない (未来側は時計ズレを許す)
      if (seen.has(e.id)) return false;
      return doneSteps.has(String(e.stepId || ''));
    })
    .map((e) => ({ ...e }))
    .sort((a, b) => ((t(b.at) || 0) - (t(a.at) || 0)) || String(a.id || '').localeCompare(String(b.id || '')));
};

// ------------------------------------------------------------ 既読 (端末ごと)
// app_notices の appNoticeSeen と同じ流儀: 既読は**端末ごと**の記憶に置く (読み書きは画面側の仕事。
// このファイルは鍵の名前と、文字列⇄一覧の変換だけを持つ)。
// 共有の棚に「読んだ」を書くと、誰か1人が読んだ瞬間に他の全員から消える (2026-08-01 の教訓)。
// ⚠既読は「人の判断」ではなく表示の制御なので、端末ごとの記憶に置いてよい。
export const STANDARD_CHANGE_SEEN_LS_KEY = 'standardChangeSeen.v1';
export const STANDARD_CHANGE_SEEN_MAX = 200; // 覚えておく上限。古い方から捨てる

/** 端末に覚えている既読idの一覧。⚠壊れていたら空に倒す (画面を止めない)。 */
export const parseSeenStandardChanges = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export const withSeenStandardChange = (seen, id) => {
  if (!id) return seen || [];
  const list = (seen || []).filter(x => x !== id);
  list.push(id);
  return list.slice(-STANDARD_CHANGE_SEEN_MAX); // ⚠古い方から捨てる。無限に伸ばさない
};
