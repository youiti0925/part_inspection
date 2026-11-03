// ⏱ 2026-10-03 B3 共有棚 daily_load の書き直しを「5分に1回まで」・「最新にする」の印(daily_load_requests)。
//   清水さん(2026-10-03 夜・原文)「その頻度でもいいけど、作業者が最新情報欲しい時は、更新ボタン押してできるようにしてもらえるならいいと思うよ」
//   直す前: 操業シミュの画面を開いている間、ロットが1回書かれるたびに daily_load を丸ごと書き直していた。
//   🚨 決まりは純関数と書く係(dailyLoadThrottle.js)。作り物の時計と待つ道具で、本物を走らせて数える。
//   ⚠ このファイルは製品と最終検査で同じ中身。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LOAD_MIN_GAP_MS, planDailyLoadWrite, createDailyLoadPublisher, urgentKeyOf,
  newRequestId, buildRefreshRequest, shouldAnswerRequest, answerDelayMs, docStampOf,
  refreshPhaseOf, refreshPhaseText, publishStateText,
  REQUEST_NO_ANSWER_MS, REQUEST_STALL_MS, REQUEST_MAX_AGE_MS,
} from '../operationsSimulation/dailyLoadThrottle.js';

const T0 = Date.parse('2026-10-03T09:00:00+09:00');
const MIN = 60 * 1000;
const doc = (fingerprint, extra = {}) => ({ ok: true, app: 'final', fingerprint, writtenAt: T0, days: [{ ymd: '2026-10-03' }], ...extra });
const settle = () => new Promise((r) => { setTimeout(r, 0); });

/** 本物の書く係を、作り物の時計で走らせる。 */
function rig({ publish = null, gap = DAILY_LOAD_MIN_GAP_MS } = {}) {
  let now = T0;
  const timers = [];
  const sent = [];
  let wrote = 0;
  const errors = [];
  const pub = createDailyLoadPublisher({
    publish: publish || ((d) => { sent.push(d); return Promise.resolve(true); }),
    nowFn: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    minGapMs: gap,
    onWrote: () => { wrote += 1; },
    onError: (e) => { errors.push(e); },
  });
  return {
    pub, sent, timers, errors,
    wrote: () => wrote,
    now: () => now,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now);
        if (!due.length) break;
        due.forEach((t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.fn(); });
        await settle();
      }
      await settle();
    },
  };
}

// ── 純関数 ─────────────────────────────────────────────────────────────────
test('TH-1 初めての1件は待たずに書く・同じ指紋は書かない・5分の内は待つ・5分たてば書く', () => {
  const base = { doc: doc('a'), shelfLoaded: true, nowMs: T0 };
  assert.deepEqual(planDailyLoadWrite(base), { kind: 'now', reason: 'first' });
  assert.equal(planDailyLoadWrite({ ...base, sentFp: 'a', sentAtMs: T0 - MIN }).kind, 'none', '同じ指紋なのに書く');
  const w = planDailyLoadWrite({ ...base, doc: doc('b'), sentFp: 'a', sentAtMs: T0 - MIN });
  assert.equal(w.kind, 'wait', '1分前に書いたのに また書く(間引かれていない)');
  assert.equal(w.waitMs, 4 * MIN, '待つ時間は 5分 − 経った時間');
  assert.equal(planDailyLoadWrite({ ...base, doc: doc('b'), sentFp: 'a', sentAtMs: T0 - 5 * MIN }).kind, 'now', 'ちょうど5分で書かない');
  assert.equal(planDailyLoadWrite({ ...base, doc: doc('b'), sentFp: 'a', sentAtMs: T0 + 3 * MIN }).kind, 'now', '時計が戻った端末で止まったまま');
  assert.equal(planDailyLoadWrite({ ...base, doc: doc('b'), sentFp: 'a', sentAtMs: T0 - MIN, minGapMs: 0 }).kind, 'now', '間隔0(戻し方)で毎回書かない');
});

test('TH-2 棚を読み終える前・材料が足りない書類は書かない(閉じる時も頼まれた時も)', () => {
  assert.equal(planDailyLoadWrite({ doc: doc('a'), shelfLoaded: false, nowMs: T0 }).kind, 'none');
  assert.equal(planDailyLoadWrite({ doc: doc('a'), shelfLoaded: false, nowMs: T0, leaving: true, forceKey: 'r1' }).kind, 'none');
  assert.equal(planDailyLoadWrite({ doc: { ...doc('a'), ok: false }, shelfLoaded: true, nowMs: T0 }).kind, 'none');
  assert.equal(planDailyLoadWrite({ doc: null, shelfLoaded: true, nowMs: T0, forceKey: 'r1' }).kind, 'none');
});

test('TH-3 決めた配置が変わった時・頼まれた時・閉じる時は 5分を待たない', () => {
  const sent = { shelfLoaded: true, nowMs: T0, sentFp: 'a', sentAtMs: T0 - MIN };
  const placed = doc('a|p1', { placement: { name: '村', days: { '2026-10-03': 'final' } } });
  assert.deepEqual(planDailyLoadWrite({ ...sent, doc: placed }), { kind: 'now', reason: 'urgent' }, '配置を決めたのに5分待つ(閉じたら消える)');
  assert.deepEqual(planDailyLoadWrite({ ...sent, doc: doc('a'), forceKey: 'r1' }), { kind: 'now', reason: 'force' }, '同じ中身でも頼まれたら書く(相手は「書いた」を見て届いたと知る)');
  assert.equal(planDailyLoadWrite({ ...sent, doc: doc('a'), forceKey: 'r1', sentForceKey: 'r1' }).kind, 'none', '同じ頼みで2回書く');
  assert.deepEqual(planDailyLoadWrite({ ...sent, doc: doc('b'), leaving: true }), { kind: 'now', reason: 'leave' }, '閉じる時に最後の1回を書かない');
  assert.equal(planDailyLoadWrite({ ...sent, doc: doc('a'), leaving: true }).kind, 'none', '閉じる時、送り済みなのに また書く');
  assert.equal(urgentKeyOf(doc('a')), '');
});

// ── 書く係(本物を作り物の時計で走らせる) ─────────────────────────────────────
test('TH-4 画面を開いたまま ロットを10回書く(1分ごと) → 開いた時の1回 + 5分ごとの1回 + 閉じた時の1回(直す前は11回)', async () => {
  const r = rig();
  r.pub.update(doc('fp-0'), true);
  await settle();
  for (let i = 1; i <= 10; i += 1) {
    await r.advance(MIN);
    r.pub.update(doc(`fp-${i}`), true);
    await settle();
  }
  // 0分=fp-0 / 5分=その時の最新 fp-4 / 10分=その時の最新 fp-9。10分目の fp-10 は次の5分を待っている
  assert.deepEqual(r.sent.map((d) => d.fingerprint), ['fp-0', 'fp-4', 'fp-9'], '書く回数が間引かれていない');
  assert.equal(r.wrote(), 3, '書けた回だけ数えていない');
  assert.equal(r.pub.state().pending, true, '最後の計算(fp-10)を待っていない');
  // 画面を閉じると 最後の計算を書く。合わせて4回(直す前は 計算のたびに 11回)
  r.pub.dispose();
  await settle();
  assert.deepEqual(r.sent.map((d) => d.fingerprint), ['fp-0', 'fp-4', 'fp-9', 'fp-10'], '閉じた時に最後の計算を書いていない');
});

test('TH-5 🚨 最後の1回は必ず書く: 5分の内に画面を閉じても、まだ送っていない計算を書く', async () => {
  const r = rig();
  r.pub.update(doc('fp-0'), true);
  await settle();
  await r.advance(MIN);
  r.pub.update(doc('fp-1'), true);
  await r.advance(MIN);
  r.pub.update(doc('fp-2'), true);
  assert.deepEqual(r.sent.map((d) => d.fingerprint), ['fp-0']);
  r.pub.dispose();
  await settle();
  assert.deepEqual(r.sent.map((d) => d.fingerprint), ['fp-0', 'fp-2'], '閉じた時に最後の計算を書いていない');
  assert.equal(r.timers.length, 0, '閉じた後も待ちが残っている');
  await r.advance(10 * MIN);
  assert.equal(r.sent.length, 2, '閉じた後に また書いた');
});

test('TH-6 ページを隠した時(flush)も、まだ送っていない計算を書く。送り済みなら何もしない', async () => {
  const r = rig();
  r.pub.update(doc('fp-0'), true);
  await settle();
  r.pub.flush();
  await settle();
  assert.equal(r.sent.length, 1, '送り済みなのに隠した時に また書いた');
  await r.advance(MIN);
  r.pub.update(doc('fp-1'), true);
  r.pub.flush();
  await settle();
  assert.deepEqual(r.sent.map((d) => d.fingerprint), ['fp-0', 'fp-1']);
  // 隠して書いた後も 5分の間隔はそこから数える
  await r.advance(MIN);
  r.pub.update(doc('fp-2'), true);
  await settle();
  assert.equal(r.sent.length, 2);
  await r.advance(4 * MIN);
  assert.equal(r.sent.length, 3, '隠して書いた5分後に書いていない');
});

test('TH-7 送っている途中(返事待ち)に閉じても、返事を待たずに最後の計算を書く', async () => {
  let release = null;
  const sent = [];
  const r = rig({ publish: (d) => { sent.push(d.fingerprint); return new Promise((res) => { release = res; }); } });
  r.pub.update(doc('fp-0'), true);
  r.pub.update(doc('fp-1'), true);
  r.pub.dispose();
  assert.deepEqual(sent, ['fp-0', 'fp-1'], '送っている途中に閉じた時、最後の計算を落とした');
  release(true);
  await settle();
  assert.equal(sent.length, 2);
});

test('TH-7b 🚨 返事の来ない書き込みが1つ在っても、次の書き直しは止まらない', async () => {
  // 2026-10-04 写し: 前の版は「返事待ちの間は書かない」門を持っていた。その版で1回、画面を開いたままロット10回 →
  //   5分たっても・閉じても 0件 だった(原因が門だったかは確かめきれていない)。門を外した版では 5分目に1件書けた。
  //   電波が弱い時に返事が遅れても止まらないよう、門は持たない(返事待ちの数は札に出すだけ)。
  const sent = [];
  const r = rig({ publish: (d) => { sent.push(d.fingerprint); return new Promise(() => {}); } });
  r.pub.update(doc('fp-0'), true);
  await settle();
  await r.advance(MIN);
  r.pub.update(doc('fp-1'), true);
  await r.advance(4 * MIN);
  assert.deepEqual(sent, ['fp-0', 'fp-1'], '前の返事を待って 5分たっても書いていない');
  await r.advance(MIN);
  r.pub.update(doc('fp-2'), true);
  r.pub.dispose();
  assert.deepEqual(sent, ['fp-0', 'fp-1', 'fp-2'], '前の返事を待って 閉じた時に書いていない');
});

test('TH-8 落ちた回・書かなかった(false)回は数えない。連打しない。次の計算で書き直す', async () => {
  let mode = 'fail';
  const calls = [];
  const r = rig({ publish: (d) => { calls.push(d.fingerprint); if (mode === 'fail') return Promise.reject(new Error('落ちた')); if (mode === 'false') return Promise.resolve(false); return Promise.resolve(true); } });
  r.pub.update(doc('fp-0'), true);
  await settle(); await settle();
  assert.deepEqual(calls, ['fp-0'], '落ちた後に その場で書き直しに行った(落ち続ける口を連打する)');
  assert.equal(r.wrote(), 0, '落ちた回を数えている');
  assert.equal(r.errors.length, 1, '落ちた事を黙って捨てている');
  assert.equal(r.pub.state().sentFp, null, '指紋の門が開き直っていない');
  mode = 'false';
  r.pub.update(doc('fp-0'), true);
  await settle(); await settle();
  assert.deepEqual(calls, ['fp-0', 'fp-0']);
  assert.equal(r.wrote(), 0, '書かなかった(false)回を数えている');
  mode = 'ok';
  r.pub.update(doc('fp-0'), true);
  await settle();
  assert.equal(r.wrote(), 1, '書けたのに数えていない');
});

test('TH-9 頼まれた時(force)は 中身が同じでも1回だけ書き、頼みの番号と送った時刻を添える', async () => {
  const r = rig();
  r.pub.update(doc('fp-0'), true);
  await settle();
  const done = [];
  await r.advance(MIN);
  r.pub.force('r-abc', (ok) => done.push(ok));
  await settle();
  assert.equal(r.sent.length, 2, '頼まれたのに書いていない(中身が同じでも書く)');
  assert.equal(r.sent[1].answersReq, 'r-abc', '頼みの番号を添えていない(押した端末が「届いた」と分からない)');
  assert.equal(r.sent[1].publishedAt, T0 + MIN, '送った時刻を添えていない');
  assert.deepEqual(done, [true]);
  r.pub.force('r-abc', (ok) => done.push(ok));
  r.pub.update(doc('fp-0'), true);
  await settle();
  assert.equal(r.sent.length, 2, '同じ頼みで2回書いた');
  // 頼みで書いた後の普段の書き直しも、そこから5分
  r.pub.update(doc('fp-1'), true);
  await settle();
  assert.equal(r.sent.length, 2);
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 3);
  assert.ok(!('answersReq' in r.sent[2]), '普段の書き直しに頼みの番号が付いている');
});

test('TH-10 計算がまだの時に頼まれたら、計算が出来た時に1回書く(裏の書き直し役の形)', async () => {
  const r = rig();
  const done = [];
  r.pub.force('r-1', (ok) => done.push(ok));
  r.pub.update(null, true);
  await settle();
  assert.equal(r.sent.length, 0);
  r.pub.update(doc('fp-0'), true);
  await settle();
  assert.equal(r.sent.length, 1, '計算が出来たのに書いていない');
  assert.equal(r.sent[0].answersReq, 'r-1');
  assert.deepEqual(done, [true]);
});

test('TH-11 頼みが落ちたら 1回で終える(計算のたびに頼みを繰り返さない)', async () => {
  let fail = true;
  const calls = [];
  const r = rig({ publish: (d) => { calls.push(d.answersReq || ''); return fail ? Promise.reject(new Error('x')) : Promise.resolve(true); } });
  const done = [];
  r.pub.update(doc('fp-0'), true);
  await settle(); await settle();
  r.pub.force('r-1', (ok) => done.push(ok));
  await settle(); await settle();
  assert.deepEqual(done, [false]);
  fail = false;
  r.pub.update(doc('fp-0'), true);
  await settle();
  assert.equal(calls.filter((c) => c === 'r-1').length, 1, '落ちた頼みを計算のたびに繰り返している');
});

// ── 「最新にする」の印 ─────────────────────────────────────────────────────────
test('TH-12 印は丸ごと置き換える形・番号は時計と乱数を渡して作る', () => {
  const id = newRequestId({ nowMs: T0, rand: 0.5 });
  assert.match(id, /^r[0-9a-z]+$/);
  assert.notEqual(id, newRequestId({ nowMs: T0, rand: 0.25 }));
  assert.deepEqual(buildRefreshRequest({ target: 'final', from: 'product', nowMs: T0, reqId: id }),
    { app: 'final', reqId: id, requestedAt: T0, from: 'product', claimedBy: null, claimedAt: null });
  assert.equal(buildRefreshRequest({ target: '', nowMs: T0, reqId: id }), null);
  assert.equal(buildRefreshRequest({ target: 'final', nowMs: null, reqId: id }), null);
});

test('TH-13 応えに行くのは 自分の工場の・まだ誰も受けていない・この端末で受け終わっていない・10分以内の印だけ', () => {
  const req = { app: 'final', reqId: 'r1', requestedAt: T0, claimedBy: null };
  assert.equal(shouldAnswerRequest({ req, hereApp: 'final', nowMs: T0 + 1000 }), true);
  assert.equal(shouldAnswerRequest({ req: { ...req, claimedBy: 'final-x' }, hereApp: 'final', nowMs: T0 }), false, '他の端末が受けた後に また受けに行く');
  assert.equal(shouldAnswerRequest({ req, hereApp: 'final', nowMs: T0, handledReqId: 'r1' }), false, '同じ頼みに2回応える');
  assert.equal(shouldAnswerRequest({ req, hereApp: 'product', nowMs: T0 }), false, '別の工場の印に応える');
  assert.equal(shouldAnswerRequest({ req, hereApp: 'final', nowMs: T0 + REQUEST_MAX_AGE_MS + 1 }), false, '古い印で計算し直す');
  assert.equal(shouldAnswerRequest({ req: null, hereApp: 'final', nowMs: T0 }), false);
  assert.equal(answerDelayMs({ screenOpen: true, rand: 0.9 }), 0, '画面を開いている端末が待っている');
  const d = answerDelayMs({ screenOpen: false, rand: 0.5 });
  assert.ok(d >= 1500 && d <= 4500, `画面を開いていない端末の待ちが変 (${d})`);
});

test('TH-14 押した端末の札: 頼んでいます → 頼みました → 計算中 → 届きました／応える端末がありません／届いていません', () => {
  const pending = { reqId: 'r1', pressedAt: T0, baseStamp: T0 - 10 * MIN, sentOk: false };
  const old = { app: 'final', publishedAt: T0 - 10 * MIN };
  assert.equal(refreshPhaseOf({ pending, theirDoc: old, nowMs: T0 }).phase, 'sending');
  const sent = { ...pending, sentOk: true };
  assert.equal(refreshPhaseOf({ pending: sent, theirDoc: old, nowMs: T0 + 5000 }).phase, 'asking');
  assert.equal(refreshPhaseOf({ pending: sent, theirDoc: old, nowMs: T0 + REQUEST_NO_ANSWER_MS }).phase, 'noAnswer', '誰も受けないのに待ち続けている');
  const req = { reqId: 'r1', claimedBy: 'final-x' };
  assert.equal(refreshPhaseOf({ pending: sent, req, theirDoc: old, nowMs: T0 + 3000 }).phase, 'claimed');
  assert.equal(refreshPhaseOf({ pending: sent, req: { reqId: 'r0', claimedBy: 'x' }, theirDoc: old, nowMs: T0 + 3000 }).phase, 'asking', '前の頼みの「受けた」を今の頼みと取り違えている');
  assert.equal(refreshPhaseOf({ pending: sent, req, theirDoc: old, nowMs: T0 + REQUEST_STALL_MS }).phase, 'stalled');
  const fresh = refreshPhaseOf({ pending: sent, req, theirDoc: { app: 'final', publishedAt: T0 + 4000 }, nowMs: T0 + 6000 });
  assert.equal(fresh.phase, 'arrived', '押した後に送られた書類が来たのに 届いたと出ない');
  assert.equal(fresh.waitedMs, 6000);
  // 時計がずれている端末: 送った時刻が押した時刻より前でも、頼みの番号が入っていれば届いた
  assert.equal(refreshPhaseOf({ pending: { ...sent, baseStamp: T0 + 9 * MIN }, theirDoc: { app: 'final', publishedAt: T0 - 9 * MIN, answersReq: 'r1' }, nowMs: T0 + 6000 }).phase, 'arrived');
  // 覚えた届いた時刻は動かない
  assert.equal(refreshPhaseOf({ pending: { ...sent, arrivedAt: T0 + 7000 }, theirDoc: old, nowMs: T0 + 60 * MIN }).arrivedAt, T0 + 7000);
  assert.equal(refreshPhaseOf({ pending: { ...pending, failed: true }, nowMs: T0 }).phase, 'failed');
  assert.equal(refreshPhaseOf({ pending: null, nowMs: T0 }).phase, 'idle');
  // 古い書類(publishedAt が無い)は writtenAt で比べる
  assert.equal(docStampOf({ writtenAt: 5 }), 5);
  assert.equal(docStampOf({ writtenAt: 5, publishedAt: 9 }), 9);
});

test('TH-15 札の言葉は短い日本語・作業者向け(どの段にも文が在る)', () => {
  for (const phase of ['sending', 'failed', 'asking', 'claimed', 'arrived', 'noAnswer', 'stalled']) {
    const t = refreshPhaseText({ phase, pressedAt: T0, arrivedAt: T0 + 5000, waitedMs: 5000 }, '製品検査');
    assert.ok(t && t.length <= 40, `${phase} の文が無い/長い: ${t}`);
  }
  assert.match(refreshPhaseText({ phase: 'noAnswer' }, '製品検査'), /今は応える端末がありません/);
  assert.match(refreshPhaseText({ phase: 'arrived', arrivedAt: T0, waitedMs: 5000 }, '製品検査'), /届きました .*（5秒）/);
  assert.equal(refreshPhaseText({ phase: 'idle' }), '');
  assert.match(publishStateText({ sentAtMs: T0, dueAtMs: T0 + 5 * MIN, pending: true }), /相手へ反映 .*（次は .* ごろ）/);
  assert.equal(publishStateText({}), '');
});
