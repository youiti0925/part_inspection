// 🚨 読み取りを減らす計算の試験。
// ⚠一番大事なのは「減らしても **画面の数字が1つも変わらない**」事。
//   だから R2x では「今までの購読(500件)」と「新しい合体」を突き合わせて、
//   **同じ配列になる**事を確かめる(件数だけでなく順番と中身も)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mergeLotsById, windowIsWholeCollection, needsLotHistory, planLotSubscriptions,
  isQuotaError, nextQuotaResetAt, quotaDayKeyOf, formatRemaining, formatClock,
  snapshotReads, queryReads, emptyTally, tallyAdd, quotaPercent, estimateOpenReads,
  liveLotsSpec, historyLotsSpec, openLotsSpec,
  LOTS_LIVE_LIMIT, LOTS_HISTORY_LIMIT, FREE_TIER_DAILY_READS,
} from '../readBudget.js';

// 本番の姿に近いロットを作る(新しい順 = createdAt の大きい順)
const makeLots = (n, { openEvery = 0 } = {}) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = openEvery > 0 && (i % openEvery === 0);
    out.push({ id: `lot-${String(n - i).padStart(4, '0')}`, createdAt: 1_800_000_000_000 - i * 60000,
      status: open ? 'processing' : 'completed', tasks: { 's1-0': { status: 'completed', duration: 60 + i } } });
  }
  return out;
};
/** 今までの購読と同じ = createdAt の新しい順に 500 件 */
const todaysLots = (all) => all.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, LOTS_HISTORY_LIMIT);

// ---------------------------------------------------------------------------
// R0x 合体そのもの
// ---------------------------------------------------------------------------
test('R01 土台の並び順は崩さない。同じ id は後から来た行で差し替える', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const live = [{ id: 'b', v: 99 }];
  assert.deepEqual(mergeLotsById(base, live), [{ id: 'a', v: 1 }, { id: 'b', v: 99 }, { id: 'c', v: 1 }]);
});

test('R02 土台に無い id は末尾に足す(捨てない)', () => {
  const out = mergeLotsById([{ id: 'a' }], [{ id: 'z' }]);
  assert.deepEqual(out.map(r => r.id), ['a', 'z']);
});

test('R03 土台が無い(まだ読んでいない)時は、後から来た行だけになる', () => {
  assert.deepEqual(mergeLotsById(null, [{ id: 'a' }, { id: 'b' }]).map(r => r.id), ['a', 'b']);
  assert.deepEqual(mergeLotsById(undefined), []);
});

test('R04 id の無い行は混ぜない(突き合わせできず二重に出るため)', () => {
  const out = mergeLotsById([{ id: 'a' }], [{ noId: true }, null, { id: 'b' }]);
  assert.deepEqual(out.map(r => r.id), ['a', 'b']);
});

test('R05 後から来た行が複数あっても、順に上書きする(最後が勝つ)', () => {
  const out = mergeLotsById([{ id: 'a', v: 0 }], [{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }]);
  assert.deepEqual(out, [{ id: 'a', v: 2 }]);
});

// ---------------------------------------------------------------------------
// R1x 「全部読んだ」の判定
// ---------------------------------------------------------------------------
test('R10 上限に届かなければ、それがコレクションの全部', () => {
  assert.equal(windowIsWholeCollection(0, 120), true);
  assert.equal(windowIsWholeCollection(119, 120), true);
});

test('R11 🚨ちょうど上限件なら「全部」と言い切らない(もっと在るかもしれない)', () => {
  assert.equal(windowIsWholeCollection(120, 120), false);
  assert.equal(windowIsWholeCollection(500, 120), false);
});

// ---------------------------------------------------------------------------
// R2x 🚨🚨 画面の数字が1つも変わらない事
// ---------------------------------------------------------------------------
test('R20 🚨ロットが窓(120)より少ない時 = 部品検査の今の本番。合体した中身は今までと完全に同じ', () => {
  const all = makeLots(0);
  const live = all.slice(0, LOTS_LIVE_LIMIT);
  assert.equal(windowIsWholeCollection(live.length, LOTS_LIVE_LIMIT), true);
  assert.deepEqual(mergeLotsById(null, live), todaysLots(all)); // どちらも []
});

test('R21 🚨ロット 80件(窓より少ない)。過去を読まなくても今までと完全に同じ', () => {
  const all = makeLots(80, { openEvery: 7 });
  const live = todaysLots(all).slice(0, LOTS_LIVE_LIMIT);
  assert.equal(windowIsWholeCollection(live.length, LOTS_LIVE_LIMIT), true);
  assert.deepEqual(mergeLotsById(null, live), todaysLots(all));
});

test('R22 🚨ロット 300件。過去(500件)を読んで合体すると、今までと **順番も中身も** 完全に同じ', () => {
  const all = makeLots(300, { openEvery: 9 });
  const history = todaysLots(all);
  const live = history.slice(0, LOTS_LIVE_LIMIT);
  const open = all.filter(l => l.status !== 'completed').slice(0, 400);
  assert.deepEqual(mergeLotsById(history, open, live), todaysLots(all));
});

test('R23 🚨ロット 500件ちょうど。合体しても今までと完全に同じ', () => {
  const all = makeLots(500, { openEvery: 11 });
  const history = todaysLots(all);
  const live = history.slice(0, LOTS_LIVE_LIMIT);
  const open = all.filter(l => l.status !== 'completed');
  assert.deepEqual(mergeLotsById(history, open, live), todaysLots(all));
});

test('R24 ⚠500件を超えた時だけ差が出る。今まで **見えていなかった未完了ロット** が末尾に足される', () => {
  const all = makeLots(600, { openEvery: 0 });
  all[580].status = 'processing'; // 500件の窓の外にある未完了ロット
  const history = todaysLots(all);
  const live = history.slice(0, LOTS_LIVE_LIMIT);
  const open = all.filter(l => l.status !== 'completed');
  const merged = mergeLotsById(history, open, live);
  // 今までは「見えない」= 作業画面に出てこなかった。合体では末尾に1件足される。
  assert.equal(merged.length, LOTS_HISTORY_LIMIT + 1);
  assert.equal(merged[merged.length - 1].id, all[580].id);
  // 先頭500件は今までと1件も違わない
  assert.deepEqual(merged.slice(0, LOTS_HISTORY_LIMIT), history);
});

test('R25 未完了の行が新しい版で来たら、過去の版を差し替える(古い姿を出さない)', () => {
  const all = makeLots(300);
  const history = todaysLots(all);
  const live = history.slice(0, LOTS_LIVE_LIMIT).map(l => ({ ...l, status: 'processing' }));
  const merged = mergeLotsById(history, live);
  assert.equal(merged.length, history.length);
  assert.equal(merged[0].status, 'processing');
  assert.equal(merged[LOTS_LIVE_LIMIT].status, history[LOTS_LIVE_LIMIT].status);
});

// ---------------------------------------------------------------------------
// R3x 過去が要る画面
// ---------------------------------------------------------------------------
test('R30 現場マップ・検査リストは過去を要らない(いま動いている物だけ)', () => {
  assert.equal(needsLotHistory({ activeTab: 'main', viewMode: 'dashboard' }), false);
  assert.equal(needsLotHistory({ activeTab: 'inspection' }), false);
  assert.equal(needsLotHistory({ activeTab: 'templates' }), false);
});

test('R31 🚨完了履歴・分析・作業最適化・達成率は過去が要る', () => {
  for (const t of ['history', 'analysis', 'optimize', 'progress']) {
    assert.equal(needsLotHistory({ activeTab: t }), true, `${t} が漏れている`);
  }
});

test('R32 🚨現場マップの中の「完了一覧」も過去が要る', () => {
  assert.equal(needsLotHistory({ activeTab: 'main', viewMode: 'completed-list' }), true);
});

test('R33 🚨日次集計などのモーダルは openPanels で要求する', () => {
  assert.equal(needsLotHistory({ activeTab: 'main', openPanels: [false, false] }), false);
  assert.equal(needsLotHistory({ activeTab: 'main', openPanels: [false, true] }), true);
});

// ---------------------------------------------------------------------------
// R4x 429(枠切れ)の見分け
// ---------------------------------------------------------------------------
test('R40 枠切れを見分ける', () => {
  assert.equal(isQuotaError({ code: 'resource-exhausted' }), true);
  assert.equal(isQuotaError({ code: 8 }), true);
  assert.equal(isQuotaError({ status: 429 }), true);
  assert.equal(isQuotaError(new Error('Quota exceeded for reads')), true);
  assert.equal(isQuotaError({ message: 'RESOURCE_EXHAUSTED: ...' }), true);
});

test('R41 🚨権限エラー・通信断を枠切れと混ぜない(「16時まで待て」は嘘になる)', () => {
  assert.equal(isQuotaError({ code: 'permission-denied' }), false);
  assert.equal(isQuotaError({ code: 'unavailable', message: 'Failed to get document because the client is offline.' }), false);
  assert.equal(isQuotaError({ code: 'unauthenticated' }), false);
  assert.equal(isQuotaError(null), false);
});

// ---------------------------------------------------------------------------
// R5x いつ直るか
// ---------------------------------------------------------------------------
test('R50 🚨戻るのは米西部の0時。夏時間のいま = 日本時間 16:00', () => {
  // 2026-08-18 10:00 JST = 2026-08-18 01:00 UTC
  const now = Date.UTC(2026, 7, 18, 1, 0, 0);
  const at = nextQuotaResetAt(now);
  assert.equal(new Date(at).toISOString(), '2026-08-18T07:00:00.000Z'); // = 16:00 JST
  assert.ok(at > now);
});

test('R51 16時を過ぎたら「次の日の16時」を出す(過去の時刻を出さない)', () => {
  const now = Date.UTC(2026, 7, 18, 8, 0, 0); // 17:00 JST
  const at = nextQuotaResetAt(now);
  assert.equal(new Date(at).toISOString(), '2026-08-19T07:00:00.000Z');
});

test('R52 ⚠冬時間は 1時間ずれる(「16時固定」と書かない)', () => {
  const now = Date.UTC(2026, 0, 15, 1, 0, 0); // 2026-01-15 10:00 JST
  const at = nextQuotaResetAt(now);
  assert.equal(new Date(at).toISOString(), '2026-01-15T08:00:00.000Z'); // = 17:00 JST
});

test('R53 枠の1日の名札は、16時をまたぐまで変わらない', () => {
  const a = quotaDayKeyOf(Date.UTC(2026, 7, 18, 1, 0, 0));  // 8/18 10:00 JST
  const b = quotaDayKeyOf(Date.UTC(2026, 7, 18, 6, 59, 0)); // 8/18 15:59 JST
  const c = quotaDayKeyOf(Date.UTC(2026, 7, 18, 7, 1, 0));  // 8/18 16:01 JST
  assert.equal(a, b);
  assert.notEqual(b, c);
});

test('R54 残り時間の書き方', () => {
  assert.equal(formatRemaining(0), 'まもなく');
  assert.equal(formatRemaining(59_000), 'まもなく');
  assert.equal(formatRemaining(25 * 60_000), '約25分');
  assert.equal(formatRemaining((2 * 60 + 7) * 60_000), '約2時間7分');
});

test('R55 時刻の書き方(端末の時計)', () => {
  const d = new Date(2026, 7, 18, 16, 5, 0);
  assert.equal(formatClock(d.getTime()), '8月18日 16:05');
});

// ---------------------------------------------------------------------------
// R6x 何件読んだかを数える
// ---------------------------------------------------------------------------
test('R60 🚨0件でも1件ぶん課金される(最初のスナップショット)', () => {
  assert.equal(snapshotReads(true, 0), 1);
  assert.equal(queryReads(0), 1);
});

test('R61 最初は全件(全部が「追加」で来る)、2回目以降は変わった件数だけ', () => {
  assert.equal(snapshotReads(true, 240), 240);
  assert.equal(snapshotReads(false, 3), 3);
  assert.equal(snapshotReads(false, 0), 0); // 中身が変わらない通知は0件
});

test('R61b 🚨端末のキャッシュから出した分は数えない(課金されない)', () => {
  assert.equal(snapshotReads(true, 240, true), 0);
  assert.equal(snapshotReads(false, 5, true), 0);
  // キャッシュで1回鳴った後、サーバの答えでもう1回鳴る = そこで初めて数える
  assert.equal(snapshotReads(true, 240, false), 240);
});

test('R61c 🚨キャッシュが新しいまま開き直した時は「最低料金の1件」だけ', () => {
  // サーバは「変わっていない」と答える = docChanges は0件。
  // ここで全件(240)を数えると、実際の240倍に見える(嘘の警告を出す事になる)。
  assert.equal(snapshotReads(true, 0, false), 1);
});

test('R62 数を足す。枠の1日が変わったら0から数え直す', () => {
  let t = emptyTally('2026-08-18');
  t = tallyAdd(t, '2026-08-18', 'lots', 120, { at: 1 });
  t = tallyAdd(t, '2026-08-18', 'templates', 8);
  assert.equal(t.total, 128);
  assert.deepEqual(t.byCol, { lots: 120, templates: 8 });
  const t2 = tallyAdd(t, '2026-08-19', 'lots', 5);
  assert.equal(t2.total, 5);
  assert.deepEqual(t2.byCol, { lots: 5 });
});

test('R63 繋ぎ直した回数も数える(読み直しの正体はこれ)', () => {
  let t = emptyTally('d');
  t = tallyAdd(t, 'd', 'lots', 120, { attach: true });
  t = tallyAdd(t, 'd', 'lots', 120, { attach: true });
  assert.equal(t.attaches, 2);
  assert.equal(t.total, 240);
});

test('R64 無料枠に対する%', () => {
  assert.equal(FREE_TIER_DAILY_READS, 50000);
  assert.equal(quotaPercent(500), 1);
  assert.equal(quotaPercent(52500), 105);
  assert.equal(quotaPercent(0), 0);
});

// ---------------------------------------------------------------------------
// R7x 1回開くと何件読むか(見積り)
// ---------------------------------------------------------------------------
test('R70 🚨データが1件も無くても、購読の数だけ課金される(部品検査の今の姿)', () => {
  const zero = {};
  const before = estimateOpenReads(zero, { mode: 'before' });
  const after = estimateOpenReads(zero, { mode: 'after' });
  assert.equal(before.total, 10); // 10本の購読 × 最低1件
  // ロットが窓(120)に届かない = 未完了の拾い直しは要らない → 7本
  assert.equal(after.total, 7);
  assert.ok(after.total < before.total);
});

test('R71 🚨ロットが貯まるほど差が開く(240件の時)', () => {
  const counts = { lots: 240, openLots: 12, templates: 8, workers: 6, notes: 20, announcements: 10, observationPlans: 4, logs: 240, indirectWork: 300, improvements: 15 };
  const before = estimateOpenReads(counts, { mode: 'before' });
  const after = estimateOpenReads(counts, { mode: 'after' });
  assert.equal(before.total, 240 + 8 + 6 + 240 + 20 + 10 + 300 + 15 + 4 + 1); // 844
  assert.equal(after.total, 120 + 12 + 8 + 6 + 20 + 10 + 4 + 1);              // 181
  assert.ok(after.total < before.total / 4);
});

test('R72 見積りは内訳を必ず持つ(合計だけ出して信じさせない)', () => {
  const r = estimateOpenReads({ lots: 50 }, { mode: 'after' });
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) {
    assert.equal(typeof row.col, 'string');
    assert.ok(row.reads >= 1);
    assert.ok(String(row.note).length > 0);
  }
  assert.equal(r.total, r.rows.reduce((s, x) => s + x.reads, 0));
});

// ---------------------------------------------------------------------------
// R8x 窓口へ渡す絞り込みの形(Firestore 固有の値を画面で作らない)
// ---------------------------------------------------------------------------
// ⚠🚦 出荷ゲート(scripts/verify-read-budget.mjs)は **実コードを静的に読む**。
//   絞り込みを関数の戻り値で spread すると「where も limit も無い」と誤って読まれる。
//   → App.jsx には **リテラルで直書き** し、その中身がここの定義と一致する事をここで縛る。
test('R82 🚨App.jsx のロット購読は、絞り込みを **リテラルで直書き** してある(見張りが静的に読めるように)', () => {
  const src = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  const need = [
    `{ orderBy: [['createdAt', 'desc']], limit: LOTS_LIVE_LIMIT, includeMetadataChanges: true,`,
    `{ orderBy: [['createdAt', 'desc']], limit: LOTS_HISTORY_LIMIT, includeMetadataChanges: true,`,
    `{ where: [['status', '!=', 'completed']], limit: OPEN_LOTS_LIMIT,`,
  ];
  for (const n of need) assert.ok(src.includes(n), `App.jsx に直書きが無い: ${n}`);
  // spread(…Spec()) に戻していないか。戻すと見張りが ❌ を出す。
  assert.ok(!/\.\.\.(live|history|open)LotsSpec\(\)/.test(src), 'App.jsx が絞り込みを関数の spread に戻している');
});

test('R83 🚨直書きの中身が、ここの定義と1つも食い違っていない', () => {
  const src = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  // 数はここが持ち主。App.jsx は名前で参照しているので、値がずれる事は無い。
  assert.ok(src.includes('LOTS_LIVE_LIMIT, LOTS_HISTORY_LIMIT, OPEN_LOTS_LIMIT'), 'App.jsx が件数を domain から取っていない');
  assert.equal(liveLotsSpec().orderBy[0][0], 'createdAt');
  assert.equal(historyLotsSpec().orderBy[0][0], 'createdAt');
  assert.equal(openLotsSpec().where[0][0], 'status');
});

test('R80 絞り込みは「ただの配列/数」だけ(関数やFirebaseの値を混ぜない)', () => {
  for (const spec of [liveLotsSpec(), historyLotsSpec(), openLotsSpec()]) {
    assert.equal(JSON.parse(JSON.stringify(spec)) && true, true);
    for (const v of Object.values(spec)) assert.notEqual(typeof v, 'function');
  }
  assert.deepEqual(openLotsSpec().where, [['status', '!=', 'completed']]);
  assert.equal(liveLotsSpec().limit, LOTS_LIVE_LIMIT);
});

test('R81 🚨過去を読む形は「今までの購読」と1文字も違わない', () => {
  // App.jsx の今までの購読(旧コード実物):
  //   { orderBy: [['createdAt','desc']], limit: 500, includeMetadataChanges: true }
  // ⚠includeMetadataChanges を落とすと「まだサーバへ送れていません」の表示が消える。
  assert.deepEqual(historyLotsSpec(), { orderBy: [['createdAt', 'desc']], limit: LOTS_HISTORY_LIMIT, includeMetadataChanges: true });
  assert.equal(LOTS_HISTORY_LIMIT, 500);
});

test('R65 🚨購読を張ったら0件でも名前を残す(「読んでいない」と「購読していない」を見分ける)', () => {
  let t = emptyTally('d');
  t = tallyAdd(t, 'd', 'lots(未完了)', 0, { attach: true });
  assert.deepEqual(t.byCol, { 'lots(未完了)': 0 });
  assert.equal(t.total, 0);
  assert.equal(t.attaches, 1);
  t = tallyAdd(t, 'd', 'lots(未完了)', 20);
  assert.deepEqual(t.byCol, { 'lots(未完了)': 20 });
});

// ---------------------------------------------------------------------------
// R9x 🚨🚨 ロットの購読が **1本も残らない** 状態を作らせない
// ---------------------------------------------------------------------------
// 2026-08-30 に見つけた欠陥。窓(live)と過去(history)がお互いに
// 「相手が居るなら自分は要らない」と引っ込む形だったので、
//   窓が「全部読めた」と言う ＆ 過去が「届いた」と言う  が **同じ描き直しの束で** 起きると
// 両方が引っ込んで購読が0本になり、ロットが最後の姿で凍っていた。
// しかも読めた印(lotsLoaded)は立ったままなので保存の門は開き、画面には何も出ない。
//
// ⚠ここは「1回の呼び出しの答え合わせ」では足りない。**状態の移り変わりを全部たどる**。

/** 張っている購読から、状態がどう動くか(窓の1発目=全部読めたかが決まる / 過去の1発目=届いた)。 */
const stepLotState = (s, fired, windowIsWhole) => ({
  windowWhole: fired.includes('live') ? windowIsWhole : s.windowWhole,
  historyLoaded: fired.includes('history') ? true : s.historyLoaded,
  historyWanted: s.historyWanted,
  historyWhole: s.historyWhole,
});

/**
 * 起動からたどれる状態を全部あるいて、購読が0本になる道を探す。
 * @param decide 張る物を決める関数({live,history} を返せばよい)
 * @returns 0本になった道筋の一覧(空なら作れない)
 */
const findFrozenPaths = (decide) => {
  const key = (s) => `${+s.windowWhole}${+s.historyLoaded}${+s.historyWanted}${+s.historyWhole}`;
  const seen = new Set();
  const frozen = [];
  const start = { windowWhole: false, historyLoaded: false, historyWanted: false, historyWhole: false };
  const queue = [{ s: start, path: ['起動(現場マップ)'] }];
  while (queue.length) {
    const { s, path } = queue.shift();
    if (seen.has(key(s))) continue;
    seen.add(key(s));
    const at = decide(s);
    if (!at.live && !at.history) { frozen.push(path); continue; }
    const nexts = [];
    // ① 人が履歴系の画面へ移る(一度立ったら戻らない)
    if (!s.historyWanted) nexts.push({ s: { ...s, historyWanted: true }, step: '人が履歴系の画面へ移る' });
    // ② 過去が上限(500)に届かなかった場合も見る
    if (s.historyLoaded && !s.historyWhole) nexts.push({ s: { ...s, historyWhole: true }, step: '過去も全部読めていた' });
    // ③ 張っている購読が届く。**単独でも、同じ束で2本同時でも**。
    for (const whole of [true, false]) {
      if (at.live) nexts.push({ s: stepLotState(s, ['live'], whole), step: `窓が届く(全部読めた=${whole})` });
      if (at.history) nexts.push({ s: stepLotState(s, ['history'], whole), step: '過去が届く' });
      if (at.live && at.history) nexts.push({ s: stepLotState(s, ['live', 'history'], whole), step: `窓と過去が同じ束で届く(全部読めた=${whole})` });
    }
    for (const n of nexts) if (!seen.has(key(n.s))) queue.push({ s: n.s, path: [...path, n.step] });
  }
  return frozen;
};

test('R90 🚨🚨 どの組み合わせでも、窓と過去が同時に引っ込む事は無い(購読が0本にならない)', () => {
  for (const windowWhole of [false, true])
    for (const historyLoaded of [false, true])
      for (const historyWanted of [false, true])
        for (const historyWhole of [false, true]) {
          const p = planLotSubscriptions({ windowWhole, historyLoaded, historyWanted, historyWhole });
          assert.ok(p.live || p.history,
            `購読が0本になった: ${JSON.stringify({ windowWhole, historyLoaded, historyWanted, historyWhole })}`);
        }
});

test('R91 🚨🚨 起動からたどれる道を全部あるいても、購読が0本になる所へは行けない', () => {
  const frozen = findFrozenPaths((s) => planLotSubscriptions(s));
  assert.deepEqual(frozen, [], `購読が0本になる道が残っている:\n${frozen.map(p => '  ' + p.join(' → ')).join('\n')}`);
});

test('R92 🚨この見張り自身の試験: 直す前の書き方(条件の直書き)なら、ちゃんと0本を見つける', () => {
  // 2026-08-30 まで App.jsx に在った実物のガード:
  //   窓  : if (historyLoaded) return;
  //   過去: if (!lotHistoryWanted || lotsWindowWhole) return;
  const before = (s) => ({ live: !s.historyLoaded, history: s.historyWanted && !s.windowWhole });
  const frozen = findFrozenPaths(before);
  assert.ok(frozen.length > 0, '壊した見本でも0本を見つけられない = この試験は何も守っていない');
  // 引き金は「窓と過去が同じ束で届く」事。道筋にそれが出ている事まで確かめる。
  assert.ok(frozen.some(p => p.some(step => step.includes('同じ束'))), '引き金(同じ束で届く)が道筋に出ていない');
});

test('R93 今まで通りの振る舞いは変えていない(過去が引き継いだら窓は止める)', () => {
  // 起動直後: 窓だけ
  assert.deepEqual(planLotSubscriptions({}), { live: true, history: false, open: true });
  // 履歴系を開いた直後(過去はまだ届いていない): 数字を空にしないので窓も残す
  assert.deepEqual(planLotSubscriptions({ historyWanted: true }), { live: true, history: true, open: true });
  // 過去が届いた(窓は全部ではない): 過去が引き継ぐので窓は止める ← 今まで通り
  assert.deepEqual(planLotSubscriptions({ historyWanted: true, historyLoaded: true }),
    { live: false, history: true, open: true });
  // 窓が全部読めた: 過去は要らない ← 今まで通り
  assert.deepEqual(planLotSubscriptions({ windowWhole: true, historyWanted: true }),
    { live: true, history: false, open: false });
  // 🚨凍っていた組み合わせ。**窓が残る**(合体後の lots が読んでいるのは窓の方だから)
  assert.deepEqual(planLotSubscriptions({ windowWhole: true, historyWanted: true, historyLoaded: true }),
    { live: true, history: false, open: false });
});

test('R94 未完了の拾い直しは、今までの条件(窓が全部 / 過去が全部 なら要らない)と同じ', () => {
  for (const windowWhole of [false, true])
    for (const historyWhole of [false, true]) {
      const before = !windowWhole && !historyWhole; // 直す前: !(lotsWindowWhole || historyIsWholeCollection)
      assert.equal(planLotSubscriptions({ windowWhole, historyWhole, historyWanted: true, historyLoaded: true }).open, before);
    }
});

test('R95 🚨App.jsx が本当にこの計算を使っている(条件の直書きが復活していない)', () => {
  const src = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('planLotSubscriptions({'), 'App.jsx が planLotSubscriptions を呼んでいない');
  for (const g of ['if (!lotSubPlan.live) return;', 'if (!lotSubPlan.history ||', 'if (!lotSubPlan.open ||'])
    assert.ok(src.includes(g), `App.jsx のガードが計算を見ていない: ${g}`);
  // 直す前の直書きが戻っていないか(戻ると購読が0本になる道が開く)
  assert.ok(!src.includes('if (historyLoaded) return;'), 'App.jsx に直す前の直書きガードが戻っている(窓)');
  assert.ok(!/if \(!lotHistoryWanted \|\| lotsWindowWhole/.test(src), 'App.jsx に直す前の直書きガードが戻っている(過去)');
});
