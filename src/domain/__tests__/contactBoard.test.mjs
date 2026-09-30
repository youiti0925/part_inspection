// 工程連絡ポータルの表示ロジック(contactBoard.js)のテスト。
// 製品検査 / 最終検査 で同一ファイル。部品検査へは 2026-09-30 に製品から写した(contactBoard.js も製品と同じ中身)。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RANGE_OPTIONS, DEFAULT_RANGE_ID, rangeOptionOf, rangeStartMs, withinRange, filterByRange,
    DEFAULT_QUICK_TIMES, quickTimesOf, quickDateOptions, quickTimeLabel, dateTimeMs, toDateStr, toTimeStr,
    mergeArrivalEntries, arrivalReplyStats, finishReplyEnabled,
    buildWorkStatusRows, groupRowsByWorker, workStatusEnabled, workStatusShowName, lotFirstStartMs,
    buildHistory, isWideLayout, LAYOUT_MODES,
    DEFAULT_TEMPLATE_WORDS, templateWordsOf, templateWordMatches,
    ARRIVAL_WHEN, arrivalWhenOf, arrivalFilterMatches,
  itemAnswerKey, answerPatch, effectiveItems, arrivalAnswerSave,
} from '../contactBoard.js';
// 🏁 突き合わせ用。**本物の finishEta を呼んで**、行の並びの鍵と画面に出る時刻が同じ事を確かめる。
import { finishEta } from '../finishEta.js';

// 2026-07-29(水) 13:00 を「今」とする
const NOW = new Date(2026, 6, 29, 13, 0, 0, 0).getTime();
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// ---------- 表示期間 ----------
test('C01 既定は2日分', () => {
    assert.equal(DEFAULT_RANGE_ID, '2d');
    assert.equal(rangeOptionOf(DEFAULT_RANGE_ID).days, 2);
    assert.equal(RANGE_OPTIONS.some(o => o.id === '1w' && o.days === 7), true);
});

test('C02 2日分 = 昨日00:00から(暦日で切る。now-48hではない)', () => {
    assert.equal(rangeStartMs('2d', NOW), at(2026, 7, 28, 0, 0));
    // 今日の朝一に見ても、昨日の朝の分は残る(48h窓だと消える)
    assert.equal(withinRange(at(2026, 7, 28, 8, 0), '2d', at(2026, 7, 29, 8, 30)), true);
});

test('C03 1週間 = 7暦日 / すべて は無制限', () => {
    assert.equal(rangeStartMs('1w', NOW), at(2026, 7, 23, 0, 0));
    assert.equal(rangeStartMs('all', NOW), null);
    assert.equal(withinRange(at(2020, 1, 1), 'all', NOW), true);
});

test('C04 知らないIDは既定(2日)に落とす', () => {
    assert.equal(rangeOptionOf('zzz').id, DEFAULT_RANGE_ID);
    assert.equal(rangeStartMs('zzz', NOW), at(2026, 7, 28, 0, 0));
});

test('C05 時刻が無いものは期間で切れない=出さない(すべて以外)', () => {
    assert.equal(withinRange(0, '2d', NOW), false);
    assert.equal(withinRange(undefined, '2d', NOW), false);
    assert.equal(withinRange(0, 'all', NOW), true);
});

test('C06 filterByRange は隠した件数も返す(黙って切らない)', () => {
    const items = [{ at: at(2026, 7, 29, 9) }, { at: at(2026, 7, 28, 9) }, { at: at(2026, 7, 20, 9) }];
    const r = filterByRange(items, '2d', NOW);
    assert.equal(r.shown.length, 2);
    assert.equal(r.hidden, 1);
    assert.equal(r.total, 3);
});

// ---------- 簡易選択 ----------
test('C07 簡易日付は 本日/明日/あさって で曜日つき', () => {
    const o = quickDateOptions(NOW);
    assert.equal(o.length, 3);
    assert.equal(o[0].value, '2026-07-29');
    assert.equal(o[1].value, '2026-07-30');
    assert.match(o[0].label, /^本日\(7\/29 水\)$/);
    assert.match(o[1].label, /^明日\(7\/30 木\)$/);
});

test('C08 月末をまたいでも日付が壊れない', () => {
    const o = quickDateOptions(at(2026, 7, 31, 10));
    assert.equal(o[0].value, '2026-07-31');
    assert.equal(o[1].value, '2026-08-01');
});

test('C09 簡易時刻の既定は 10/12/15/17 時・設定で差し替え可', () => {
    assert.deepEqual(DEFAULT_QUICK_TIMES, ['10:00', '12:00', '15:00', '17:00']);
    assert.deepEqual(quickTimesOf(null), DEFAULT_QUICK_TIMES);
    assert.deepEqual(quickTimesOf({ contactArrival: { quickTimes: ['09:00', '13:30'] } }), ['09:00', '13:30']);
    // 形が壊れている値は捨てて既定に戻す(空のボタン列を出さない)
    assert.deepEqual(quickTimesOf({ contactArrival: { quickTimes: ['あさ', ''] } }), DEFAULT_QUICK_TIMES);
});

test('C10 時刻ラベルは 00分なら「10時」', () => {
    assert.equal(quickTimeLabel('10:00'), '10時');
    assert.equal(quickTimeLabel('09:00'), '9時');
    assert.equal(quickTimeLabel('10:30'), '10:30');
});

test('C11 dateTimeMs は日付か時刻が欠けたら null', () => {
    assert.equal(dateTimeMs('2026-07-29', '10:00'), at(2026, 7, 29, 10, 0));
    assert.equal(dateTimeMs('2026-07-29', ''), null);
    assert.equal(dateTimeMs('', '10:00'), null);
    assert.equal(dateTimeMs('7/29', '10:00'), null);
});

test('C12 toDateStr / toTimeStr は端末のローカル時刻(0埋め)', () => {
    assert.equal(toDateStr(at(2026, 7, 5, 9, 5)), '2026-07-05');
    assert.equal(toTimeStr(at(2026, 7, 5, 9, 5)), '09:05');
});

// ---------- 到着予定ボード ----------
const REQ = {
    id: 'cr-1', kind: 'arrival', to: '組立', status: 'answered', createdAt: at(2026, 7, 29, 8),
    items: [
        { lotId: 'L1', orderNo: '1001', model: 'RTT-215', quantity: 2, date: '2026-07-29', time: '10:00', by: '片山', at: at(2026, 7, 29, 9) },
        { lotId: 'L2', orderNo: '1002', model: 'RTT-315', quantity: 1, date: '2026-07-29', time: '15:00', by: '片山', at: at(2026, 7, 29, 9, 5), finish: { ts: at(2026, 7, 29, 17), by: '検査', at: at(2026, 7, 29, 9, 10) } },
        { lotId: 'L3', orderNo: '1003', model: 'RTT-415', date: '', time: '' }, // 未回答
    ],
};
const ARR = [
    { id: 'L1', orderNo: '1001', model: 'RTT-215', date: '2026-07-29', time: '10:00', by: '片山', group: '組立', viaReq: 'cr-1', at: at(2026, 7, 29, 9) },
    { id: 'L9', orderNo: '1009', model: 'RTT-515', date: '2026-07-29', time: '12:00', by: '尾田', group: '組立', viaReq: '', at: at(2026, 7, 29, 11) },
];

test('C13 依頼への回答と自発登録を1つの表に束ねる', () => {
    const e = mergeArrivalEntries({ arrivalTimes: ARR, contactRequests: [REQ], group: '組立', now: NOW });
    // L1(依頼回答) L2(依頼回答) L9(自発) の3件。L3は未回答なので出ない。
    assert.deepEqual(e.map(x => x.lotId).sort(), ['L1', 'L2', 'L9']);
});

test('C14 依頼への回答の写し(arrival_times.viaReq)を二重に出さない', () => {
    const e = mergeArrivalEntries({ arrivalTimes: ARR, contactRequests: [REQ], group: '組立', now: NOW });
    assert.equal(e.filter(x => x.lotId === 'L1').length, 1);
    assert.equal(e.find(x => x.lotId === 'L1').source, 'req');
});

test('C15 viaReq が無い古いデータでも、依頼側に同じロットが居れば二重に出さない', () => {
    const old = [{ id: 'L2', orderNo: '1002', model: 'RTT-315', date: '2026-07-29', time: '15:00', by: '片山', group: '組立', at: at(2026, 7, 29, 9, 5) }];
    const e = mergeArrivalEntries({ arrivalTimes: old, contactRequests: [REQ], group: '組立', now: NOW });
    assert.equal(e.filter(x => x.lotId === 'L2').length, 1);
});

test('C16 返事したかどうか(replied)が付く', () => {
    const e = mergeArrivalEntries({ arrivalTimes: ARR, contactRequests: [REQ], group: '組立', now: NOW });
    assert.equal(e.find(x => x.lotId === 'L2').replied, true);
    assert.equal(e.find(x => x.lotId === 'L1').replied, false);
    assert.deepEqual(arrivalReplyStats(e), { total: 3, replied: 1, waiting: 2, appliedOnly: 0, handled: 1, untouched: 2 });
});

// 入荷時間へ入れた印(applied)は arrival_times にしか無い。ここを拾い落とすと、
// 処理が済んでいるのに「未対応」と急かし続けてしまう(清水さん 2026-08-05)。
test('C16b 入荷時間へ入れた印(applied)を拾う / handled が付く', () => {
    const arr = [{ ...ARR[0], applied: { at: 1, entryAt: 2, by: 'auto' } }];
    const e = mergeArrivalEntries({ arrivalTimes: arr, contactRequests: [], group: '組立', now: NOW });
    assert.equal(e[0].applied.entryAt, 2);
    assert.equal(e[0].replied, false, '終了予定の返信はまだ');
    assert.equal(e[0].handled, true, '入荷時間へ入れてあるので処理済み');
    // 印が無いものは今までどおり
    const e2 = mergeArrivalEntries({ arrivalTimes: [ARR[0]], contactRequests: [], group: '組立', now: NOW });
    assert.equal(e2[0].applied, null);
    assert.equal(e2[0].handled, false);
});

test('C17 自発登録側の finish も返事として扱う', () => {
    const arr = [{ ...ARR[1], finish: { ts: at(2026, 7, 29, 16), by: '検査', at: at(2026, 7, 29, 11, 30) } }];
    const e = mergeArrivalEntries({ arrivalTimes: arr, contactRequests: [], group: '組立', now: NOW });
    assert.equal(e[0].replied, true);
    assert.equal(e[0].finish.ts, at(2026, 7, 29, 16));
});

test('C18 到着時刻を過ぎたのに未返信は late', () => {
    const e = mergeArrivalEntries({ arrivalTimes: ARR, contactRequests: [REQ], group: '組立', now: NOW });
    assert.equal(e.find(x => x.lotId === 'L1').late, true);   // 10:00 予定・今13:00・未返信
    assert.equal(e.find(x => x.lotId === 'L9').late, true);   // 12:00 予定・今13:00・未返信
    assert.equal(e.find(x => x.lotId === 'L2').late, false);  // 返信済
});

test('C19 取消された依頼は出さない / 班でしぼれる', () => {
    const canceled = { ...REQ, status: 'canceled' };
    assert.equal(mergeArrivalEntries({ contactRequests: [canceled], now: NOW }).length, 0);
    const other = mergeArrivalEntries({ arrivalTimes: ARR, contactRequests: [REQ], group: '機械', now: NOW });
    assert.equal(other.length, 0);
});

test('C19b 元の依頼が消えている到着予定は「孤児」として印を付ける(捨てない)', () => {
    // viaReq が今は存在しない依頼を指している = 依頼だけ削除された状態(実データ 1001398676 TWA-160)
    const orphan = [{ id: 'L7', orderNo: '1007', model: 'TWA-160', date: '2026-07-17', time: '09:27', by: 'S', group: '組立', viaReq: 'cr-gone', at: at(2026, 7, 17, 9, 27) }];
    const e = mergeArrivalEntries({ arrivalTimes: orphan, contactRequests: [REQ], group: '組立', now: NOW });
    const got = e.filter(x => x.lotId === 'L7');
    assert.equal(got.length, 1);
    assert.equal(got[0].orphan, true);
    // 依頼が実在するなら孤児ではない(=写しとして捨てられる)
    const kept = mergeArrivalEntries({ arrivalTimes: [{ ...orphan[0], viaReq: 'cr-1' }], contactRequests: [REQ], group: '組立', now: NOW });
    assert.equal(kept.filter(x => x.lotId === 'L7').length, 0);
    // 自発登録(viaReq なし)は孤児ではない
    assert.equal(mergeArrivalEntries({ arrivalTimes: [ARR[1]], contactRequests: [], now: NOW })[0].orphan, false);
});

test('C19c 取消された依頼への回答は「残す・孤児にしない」(2026-08-01 変更)', () => {
    // ⚠以前はここで丸ごと捨てていた。しかし arrival_times のその行は消えていないので、
    //   **入荷時間や検査リストのタグには効いているのに、板と表には出ない** という食い違いになる。
    //   質問(依頼)を取り消しても、相手がくれた「10時に着く」という答えは消えない。だから残す。
    //   依頼自体は実在するので孤児(=やりとりをたどれない)ではない。
    const canceled = { ...REQ, id: 'cr-x', status: 'canceled' };
    const a = [{ id: 'L8', orderNo: '1008', model: 'M', date: '2026-07-29', time: '10:00', group: '組立', viaReq: 'cr-x', at: NOW }];
    const out = mergeArrivalEntries({ arrivalTimes: a, contactRequests: [canceled], group: '組立', now: NOW });
    assert.equal(out.length, 1, '入荷時間には効いているのに画面から消える、を作らない');
    assert.equal(out[0].source, 'self');
    assert.equal(out[0].orphan, false);
});

test('C20 終了予定の返信は既定ON・設定でOFF', () => {
    assert.equal(finishReplyEnabled(null), true);
    assert.equal(finishReplyEnabled({ contactArrival: {} }), true);
    assert.equal(finishReplyEnabled({ contactArrival: { finishReply: false } }), false);
});

// ---------- 作業状況ボード ----------
// 🚨⚠⚠ 2026-08-16: **ここはもう終わりの時刻を計算しない**。
//   終わりの時刻は finishEta.js ただ1本が作り、この module は etaOf で受け取って持ち回るだけ。
//   休憩跨ぎ・定時跨ぎ・土日跨ぎの計算が正しいかは finishEta.test.mjs の E03-a〜e が見ている
//   (前はこの試験の W03/W04 が同じ計算を別の式で持っていた = 二重)。
//   ここで見るのは「受け取った時刻をそのまま持つか」「出せない時に作らないか」の2つだけ。

/** finishEta() の戻りの形(出せた時)。時刻はテストが決める。 */
const okEta = (ts) => ({ ok: true, reason: '', finishAt: ts, remainMin: 10, basis: {}, confidence: 'high', range: { earliest: ts, latest: ts } });
/** finishEta() の戻りの形(出せない時)。⚠finishAt は必ず null。 */
const ngEta = (reason) => ({ ok: false, reason, finishAt: null, remainMin: 0, basis: {}, confidence: 'low', range: { earliest: null, latest: null } });

const LOTS = [
    { id: 'L1', orderNo: '1001', model: 'RTT-215', quantity: 2, status: 'processing', workerId: 'w1', workStartTime: at(2026, 7, 29, 11) },
    { id: 'L2', orderNo: '1002', model: 'RTT-315', quantity: 1, status: 'paused', workerId: 'w1', workStartTime: null },
    { id: 'L3', orderNo: '1003', model: 'RTT-415', quantity: 3, status: 'waiting', workerId: 'w2' },
    { id: 'L4', orderNo: '1004', model: 'RTT-515', quantity: 1, status: 'completed', workerId: 'w2' },
];
const NAMES = { w1: '山田', w2: '佐藤' };
// 既定の etaOf: L1 だけ 13:40 に終わる見込みが出ている。他は「出せない」。
const ETA_BY_LOT = {
    L1: okEta(at(2026, 7, 29, 13, 40)),
    L2: ngEta('いま止まっています（残ロット待ち）'),
    L3: ngEta('まだ誰も手を付けていません'),
};
const base = {
    lots: LOTS, now: NOW,
    estimateSecOf: (l) => ({ L1: 3600, L2: 1800, L3: 7200 }[l.id] || 0),
    elapsedMsOf: (l) => ({ L1: 1200 * 1000, L2: 600 * 1000 }[l.id] || 0),
    etaOf: (l) => ETA_BY_LOT[l.id] || null,
    workerNameOf: (l) => NAMES[l.workerId] || '',
};

test('W01 完了ロットは出さない / 未着手で到着予定も無いものは出さない', () => {
    const rows = buildWorkStatusRows(base);
    assert.deepEqual(rows.map(r => r.lotId), ['L1', 'L2']);
});

// ⚠ 旧 W02 は「到着してから見積ぶん働いたら終わる時刻」をここで作っていた。
//   その時刻は画面に出ている 🏁 と別物(finishEta は着手前のロットには時刻を出さない)。
//   **並び順だけが別の式**という状態だったので、時刻を作るのをやめた。
//   着手前の行は到着予定で並べる = 相手が自分で教えてくれた実データだけで並ぶ。
test('W02 到着予定だけの未着手ロットに終了時刻を作らない(🏁と別の時刻を持たない)', () => {
    const rows = buildWorkStatusRows({ ...base, arrivalByLot: { L3: { date: '2026-07-29', time: '15:00' } } });
    const r = rows.find(x => x.lotId === 'L3');
    assert.equal(r.state, 'waiting');
    assert.equal(r.estEndFrom, 'arrival');
    assert.equal(r.arrivalTs, at(2026, 7, 29, 15, 0));
    assert.equal(r.estEndTs, null);                 // 🚨ここで時刻を作らない
    assert.equal(r.eta.ok, false);
    assert.match(r.eta.reason, /まだ誰も手を付けていません/);  // 「なぜ出せないか」は持って回る
});

test('W03 進行中の行は finishEta が出した時刻を**そのまま**持つ(足し算をしない)', () => {
    const rows = buildWorkStatusRows(base);
    const r = rows.find(x => x.lotId === 'L1');
    assert.equal(r.estimateSec, 3600);
    assert.equal(r.elapsedSec, 1200);
    assert.equal(r.remainSec, 2400);   // ⚠ただの引き算。時刻には使わない
    assert.equal(r.estEndFrom, 'now');
    assert.equal(r.estEndTs, at(2026, 7, 29, 13, 40));   // = etaOf が返した値そのもの
    assert.equal(r.estEndTs, ETA_BY_LOT.L1.finishAt);
});

test('W04 「見積−経過」から時刻を作らない(値を変えても行の時刻は動かない)', () => {
    // 見積も経過も大きく変えるが、etaOf が同じなら終了時刻は1ミリ秒も動かない。
    //   = この module の中に終わりの時刻を作る式が残っていない事の証明。
    const a = buildWorkStatusRows(base).find(r => r.lotId === 'L1');
    const b = buildWorkStatusRows({
        ...base, estimateSecOf: () => 99999, elapsedMsOf: () => 0,
    }).find(r => r.lotId === 'L1');
    assert.equal(a.estEndTs, b.estEndTs);
    assert.notEqual(a.estimateSec, b.estimateSec);   // 材料は確かに変わっている
});

// 🚨 旧 W05 は estEndTs === NOW を「今すぐ終わる見込み」として正しいと固定していた。
//   これが「見積が0/使い切りのロットで 🏁 が『いま』になる」欠陥そのもの。
//   見積を使い切った時に分かるのは「あと何回残っているか」だけで、**いつ終わるかは分からない**。
//   分からない物に「いま」と答えるのは作り話なので、null(=分かりません)に直した。
test('W05 見積を使い切っていても「いま終わる」と言わない(🏁が「いま」になる欠陥)', () => {
    const rows = buildWorkStatusRows({
        ...base,
        elapsedMsOf: (l) => (l.id === 'L1' ? 9999 * 1000 : 0),
        etaOf: (l) => (l.id === 'L1' ? ngEta('目安の時間をもう使い切っています（あと 2回 残っています）') : null),
    });
    const r = rows.find(x => x.lotId === 'L1');
    assert.equal(r.remainSec, 0);              // 引き算はマイナスにしない(ここは今まで通り)
    assert.equal(r.estEndTs, null);            // 🚨「いま」を返さない
    assert.notEqual(r.estEndTs, NOW);
    assert.match(r.eta.reason, /使い切って/);
});

test('W05b 見積が0のロットでも「いま」を返さない', () => {
    const rows = buildWorkStatusRows({
        ...base, estimateSecOf: () => 0, elapsedMsOf: () => 0,
        etaOf: () => ngEta('目安の時間（目標時間も実測も）が1つも登録されていないので、いつ終わるかは出せません'),
        lots: [{ id: 'L1', orderNo: '1', model: 'M', quantity: 1, status: 'processing', workerId: 'w1' }],
    });
    assert.equal(rows[0].estEndTs, null);
    assert.notEqual(rows[0].estEndTs, NOW);
});

test('W06 並び順は 作業中→停止→到着予定だけ、同順位は終了予定が早い順', () => {
    const rows = buildWorkStatusRows({ ...base, arrivalByLot: { L3: { date: '2026-07-29', time: '15:00' } } });
    assert.deepEqual(rows.map(r => r.state), ['processing', 'paused', 'waiting']);
});

test('W06b 同順位の並びは 🏁 と同じ値で決まる。出せない行は到着予定→指図番号で並ぶ', () => {
    const lots = [
        { id: 'A', orderNo: '9', model: 'M', quantity: 1, status: 'processing', workerId: 'w1' },
        { id: 'B', orderNo: '1', model: 'M', quantity: 1, status: 'processing', workerId: 'w1' },
        { id: 'C', orderNo: '5', model: 'M', quantity: 1, status: 'processing', workerId: 'w1' },
    ];
    const etas = { A: okEta(at(2026, 7, 29, 14, 0)), B: okEta(at(2026, 7, 29, 16, 0)), C: ngEta('担当が決まっていません') };
    const rows = buildWorkStatusRows({ ...base, lots, etaOf: (l) => etas[l.id] });
    // 🏁が早い順 → 出せない行は最後(指図番号順)
    assert.deepEqual(rows.map(r => r.lotId), ['A', 'B', 'C']);
    // 並びの鍵が画面の 🏁 と同じ値である事(別の式で並べていない)
    assert.deepEqual(rows.filter(r => r.estEndTs != null).map(r => r.estEndTs),
        [etas.A.finishAt, etas.B.finishAt]);
});

test('W06c 終了が出せない着手前の行は「到着が早い順」に並ぶ', () => {
    const lots = [
        { id: 'A', orderNo: '9', model: 'M', quantity: 1, status: 'waiting' },
        { id: 'B', orderNo: '1', model: 'M', quantity: 1, status: 'waiting' },
    ];
    const rows = buildWorkStatusRows({
        ...base, lots, etaOf: () => ngEta('まだ誰も手を付けていません'),
        arrivalByLot: { A: { date: '2026-07-29', time: '14:00' }, B: { date: '2026-07-29', time: '16:00' } },
    });
    assert.deepEqual(rows.map(r => r.lotId), ['A', 'B']);
});

test('W07 開始時刻は lot.workStartTime、差し替えもできる', () => {
    assert.equal(buildWorkStatusRows(base).find(r => r.lotId === 'L1').startedAt, at(2026, 7, 29, 11));
    const rows = buildWorkStatusRows({ ...base, startedAtOf: () => at(2026, 7, 29, 9) });
    assert.equal(rows.find(r => r.lotId === 'L1').startedAt, at(2026, 7, 29, 9));
});

test('W08 作業者ごとにまとめる(動いている人が上)', () => {
    const rows = buildWorkStatusRows({ ...base, arrivalByLot: { L3: { date: '2026-07-29', time: '15:00' } } });
    const g = groupRowsByWorker(rows);
    assert.equal(g[0].name, '山田');
    assert.equal(g[0].rows.length, 2);
    assert.equal(g[1].name, '佐藤');
});

test('W09 担当者が居ないロットは「担当なし」でまとまる', () => {
    const rows = buildWorkStatusRows({ ...base, workerNameOf: () => '' });
    assert.equal(groupRowsByWorker(rows)[0].name, '担当なし');
});

test('W09b 開始時刻はタスクの firstStartTime の最小(止めても飛ばない)', () => {
    const lot = {
        workStartTime: at(2026, 7, 29, 13, 30), // 休憩明けに再開した時刻(これを見せると嘘になる)
        tasks: {
            a: { firstStartTime: at(2026, 7, 29, 11, 0) },
            b: { firstStartTime: at(2026, 7, 29, 9, 30) },
            c: { firstStartTime: null },
        },
    };
    assert.equal(lotFirstStartMs(lot), at(2026, 7, 29, 9, 30));
    // タスクに時刻が1つも無ければ workStartTime に落ちる
    assert.equal(lotFirstStartMs({ workStartTime: 123, tasks: { a: {} } }), 123);
    assert.equal(lotFirstStartMs({}), null);
});

test('W10 作業状況の公開・氏名表示は既定ON、設定でOFF', () => {
    assert.equal(workStatusEnabled(null), true);
    assert.equal(workStatusEnabled({ contactPortal: { showWorkStatus: false } }), false);
    assert.equal(workStatusShowName(null), true);
    assert.equal(workStatusShowName({ contactPortal: { showWorkerName: false } }), false);
});

test('W11 終了予定が算出できない時は null(嘘の時刻を出さない)', () => {
    const rows = buildWorkStatusRows({ ...base, etaOf: () => ngEta('材料が足りません') });
    rows.forEach(r => assert.equal(r.estEndTs, null));
});

test('W11b etaOf を渡さなければ終了時刻は出ない(自分では作らない)', () => {
    // 🚨ここが一番大事: 終わりの時刻を作る式がこの module に1つも残っていない事。
    const rows = buildWorkStatusRows({ ...base, etaOf: undefined });
    assert.equal(rows.length > 0, true);
    rows.forEach(r => {
        assert.equal(r.estEndTs, null);
        assert.equal(r.eta, null);
    });
});

test('W11c 壊れた eta を渡されても時刻を作らない', () => {
    for (const bad of [null, undefined, {}, { ok: true, finishAt: null }, { ok: true, finishAt: NaN },
        { ok: false, finishAt: NOW }, { ok: 'true', finishAt: NOW }]) {
        const rows = buildWorkStatusRows({ ...base, etaOf: () => bad });
        rows.forEach(r => assert.equal(r.estEndTs, null, JSON.stringify(bad)));
    }
});

// ============================================================================
// 🚨 X: 「表に出ている時刻」と「並び順」が食い違わない事の突き合わせ
// ----------------------------------------------------------------------------
// ⚠これは作り物の eta ではなく **本物の finishEta を呼ぶ**。
//   2026-08-16 に、ここで 9通り中 8通りが食い違っていた(最大15時間)。
//   ・contactBoard: finishAt(now, 見積−経過) …人数も止まっているかも見ない。残業も込み
//   ・finishEta   : 残っている回の目安を積んで、人数で割って、定時までで数える
//   同じロットに2つの時刻が有ったのが原因。今は etaOf 1本なので、何を入れても必ず一致する。
// ============================================================================
const WEDX = (h, mi = 0) => at(2026, 7, 29, h, mi);
// App と同じ配線をここで作る(見積は目標時間×台数、経過は完了タスクの合計)
const xPlannedRounds = (s, qty) => (String(s.checkType || '') === 'count' ? 1 : qty);
const xEstimateSecOf = (lot) => (lot.steps || []).reduce(
    (a, s) => a + Number(s.targetTime || 0) * xPlannedRounds(s, Math.max(1, lot.quantity || 1)), 0);
const xElapsedMsOf = (lot) => Object.values(lot.tasks || {}).reduce(
    (a, t) => a + (t && (t.status === 'completed' || t.status === 'ng') ? Number(t.duration || 0) : 0), 0) * 1000;

/** App の refreshWorkStatus と同じ形で1行を作る。 */
const xRows = (lot, now, { arrivalByLot = {}, worker = '山田' } = {}) => buildWorkStatusRows({
    lots: [lot], arrivalByLot,
    estimateSecOf: xEstimateSecOf,
    elapsedMsOf: xElapsedMsOf,
    workerNameOf: () => worker,
    etaOf: (l) => finishEta({ lot: l, now, workers: worker ? [worker] : [] }),
});

const X_CASES = [
    ['進行中・1台やって1台稼働中', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 3, status: 'processing',
        steps: [{ id: 's1', title: '外観', targetTime: 600 }],
        tasks: {
            's1-0': { status: 'completed', duration: 600, firstStartTime: WEDX(8, 40) },
            's1-1': { status: 'processing', startTime: WEDX(9, 20) },
        },
    }, WEDX(9, 30), {}],
    ['中断中', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 3, status: 'paused',
        pauseReason: { label: '残ロット待ち' },
        steps: [{ id: 's1', title: '外観', targetTime: 600 }],
        tasks: { 's1-0': { status: 'completed', duration: 600, firstStartTime: WEDX(8, 40) } },
    }, WEDX(13, 0), {}],
    ['未着手＋到着予定', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 3, status: 'waiting',
        steps: [{ id: 's1', title: '外観', targetTime: 600 }], tasks: {},
    }, WEDX(13, 0), { arrivalByLot: { L1: { date: '2026-07-29', time: '15:00' } } }],
    ['見積0(🏁が「いま」になっていた欠陥)', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 3, status: 'processing',
        steps: [{ id: 's1', title: '外観', targetTime: 0 }],
        tasks: { 's1-0': { status: 'processing', startTime: WEDX(9, 0) } },
    }, WEDX(9, 30), {}],
    ['見積を使い切っている', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 2, status: 'processing',
        steps: [{ id: 's1', title: '外観', targetTime: 600 }],
        tasks: {
            's1-0': { status: 'completed', duration: 3000, firstStartTime: WEDX(8, 0) },
            's1-1': { status: 'processing', startTime: WEDX(9, 20) },
        },
    }, WEDX(9, 30), {}],
    ['員数/一括を台数倍しない', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 5, status: 'processing',
        steps: [{ id: 's1', title: '員数', targetTime: 600, checkType: 'count' }],
        tasks: { 's1-0': { status: 'processing', startTime: WEDX(9, 30) } },
    }, WEDX(9, 30), {}],
    ['担当が決まっていない', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 3, status: 'processing',
        steps: [{ id: 's1', title: '外観', targetTime: 600 }],
        tasks: { 's1-0': { status: 'processing', startTime: WEDX(9, 30) } },
    }, WEDX(9, 30), { worker: '' }],
    ['16:30に あと120分(定時跨ぎ)', {
        id: 'L1', orderNo: '1', model: 'M', quantity: 12, status: 'processing',
        steps: [{ id: 's1', title: '外観', targetTime: 600 }],
        tasks: { 's1-0': { status: 'processing', startTime: WEDX(16, 30) } },
    }, WEDX(16, 30), {}],
];

test('X01 🚨 並び順の鍵(estEndTs)と画面に出る時刻(finishEta)は必ず同じ', () => {
    X_CASES.forEach(([name, lot, now, opt]) => {
        const r = xRows(lot, now, opt)[0];
        assert.ok(r, `${name}: 行が出ない`);
        const eta = finishEta({ lot, now, workers: opt.worker === '' ? [] : ['山田'] });
        const shown = eta.ok === true ? eta.finishAt : null;   // 画面は ok:false なら時刻を出さない
        assert.equal(r.estEndTs, shown, `${name}: 並び順の鍵と画面の時刻が食い違う`);
        assert.equal(r.eta.ok, eta.ok, name);
        assert.equal(r.eta.reason, eta.reason, name);
    });
});

test('X02 🚨 出せない時は必ず null。**「いま」を返す組み合わせが1つも無い**', () => {
    X_CASES.forEach(([name, lot, now, opt]) => {
        const r = xRows(lot, now, opt)[0];
        if (r.eta.ok === true) return;
        assert.equal(r.estEndTs, null, `${name}: 出せないのに時刻がある`);
        assert.notEqual(r.estEndTs, now, `${name}: 🏁が「いま」になっている`);
        assert.ok(r.eta.reason.length > 0, `${name}: なぜ出せないかが空`);
    });
});

test('X03 🚨 見積0・見積使い切りは「いま」ではなく「分かりません」', () => {
    for (const idx of [3, 4]) {                       // 見積0 / 使い切り
        const [name, lot, now, opt] = X_CASES[idx];
        const r = xRows(lot, now, opt)[0];
        assert.equal(r.eta.ok, false, name);
        assert.equal(r.estEndTs, null, name);
        assert.notEqual(r.estEndTs, now, `${name}: 🏁が「いま」`);
    }
});

test('X04 中断中・担当未定のロットに終了時刻を作らない', () => {
    for (const idx of [1, 6]) {                       // 中断中 / 担当なし
        const [name, lot, now, opt] = X_CASES[idx];
        const r = xRows(lot, now, opt)[0];
        assert.equal(r.estEndTs, null, name);
    }
});

test('X05 定時を跨ぐ時は翌営業日。行の鍵も同じ翌営業日になる', () => {
    const [, lot, now, opt] = X_CASES[7];
    const r = xRows(lot, now, opt)[0];
    const eta = finishEta({ lot, now, workers: ['山田'] });
    assert.equal(eta.ok, true);
    assert.equal(r.estEndTs, eta.finishAt);
    assert.equal(new Date(r.estEndTs).getDate(), 30);   // 翌日(7/30)へ送られている
});

test('X06 員数/一括(checkType:count)を台数倍していない', () => {
    const [, lot, now, opt] = X_CASES[5];
    const eta = finishEta({ lot, now, workers: ['山田'] });
    assert.equal(eta.ok, true);
    assert.equal(eta.basis.残り回数, 1);        // 5台でも「あと1回」
    assert.equal(eta.remainMin, 10);            // 600秒 = 10分。50分ではない
    assert.equal(xRows(lot, now, opt)[0].estEndTs, eta.finishAt);
});

// ---------- 履歴 ----------
test('H01 履歴に自発登録の到着予定も混ざる', () => {
    const h = buildHistory({ contactRequests: [REQ], arrivalTimes: ARR, group: '組立', rangeId: 'all', now: NOW });
    assert.deepEqual(h.shown.map(x => x.type).sort(), ['arrival', 'req']);
});

test('H02 依頼への回答の写しは履歴に二重に出さない', () => {
    const h = buildHistory({ contactRequests: [REQ], arrivalTimes: ARR, group: '組立', rangeId: 'all', now: NOW });
    assert.equal(h.shown.filter(x => x.type === 'arrival').length, 1); // L9 だけ
});

test('H03 履歴は既定2日分で切られ、隠した件数が分かる', () => {
    const old = { id: 'cr-old', kind: 'call', to: '組立', createdAt: at(2026, 7, 1, 10), items: [] };
    const h = buildHistory({ contactRequests: [REQ, old], arrivalTimes: ARR, group: '組立', now: NOW });
    assert.equal(h.hidden, 1);
    assert.equal(h.shown.some(x => x.req?.id === 'cr-old'), false);
});

test('H04 新しい順に並ぶ', () => {
    const h = buildHistory({ contactRequests: [REQ], arrivalTimes: ARR, group: '組立', rangeId: 'all', now: NOW });
    assert.equal(h.shown[0].at >= h.shown[1].at, true);
});

// ---------- テンプレートの言葉でしぼる ----------
test('T01 既定は 中間/一般/傾斜/回転・設定で差し替え可', () => {
    assert.deepEqual(DEFAULT_TEMPLATE_WORDS, ['中間', '一般', '傾斜', '回転']);
    assert.deepEqual(templateWordsOf(null), DEFAULT_TEMPLATE_WORDS);
    assert.deepEqual(templateWordsOf({ contactPortal: { templateWords: ['分割', 'モーター'] } }), ['分割', 'モーター']);
    assert.deepEqual(templateWordsOf({ contactPortal: { templateWords: ['', '  '] } }), DEFAULT_TEMPLATE_WORDS);
});

test('T02 テンプレ名に言葉が含まれるかで判定(実データの名前で確認)', () => {
    assert.equal(templateWordMatches('中間分割_回転分割_センタハイト_直角', '中間'), true);
    assert.equal(templateWordMatches('中間分割_回転分割_センタハイト_直角', '回転'), true);
    assert.equal(templateWordMatches('円テーブル一般精度_三次元', '一般'), true);
    assert.equal(templateWordMatches('傾斜分割_モーター', '傾斜'), true);
    assert.equal(templateWordMatches('傾斜分割_モーター', '中間'), false);
    // テンプレ名が無いものはどの言葉にも当たらない(空文字で全部に当たる、を防ぐ)
    assert.equal(templateWordMatches('', '中間'), false);
    assert.equal(templateWordMatches('中間分割', ''), false);
});

// ---------- 到着予定の「いつ」 ----------
test('A01 今日・明日・それ以降・過ぎた を暦日で分ける', () => {
    const w = (d, t) => arrivalWhenOf({ date: d, time: t }, NOW).when;   // NOW = 7/29 13:00
    assert.equal(w('2026-07-29', '15:00'), ARRIVAL_WHEN.TODAY);
    assert.equal(w('2026-07-29', '10:00'), ARRIVAL_WHEN.PAST);           // 今日だが過ぎている
    assert.equal(w('2026-07-30', '09:00'), ARRIVAL_WHEN.TOMORROW);
    assert.equal(w('2026-07-31', '09:00'), ARRIVAL_WHEN.LATER);
    assert.equal(arrivalWhenOf(null, NOW).when, ARRIVAL_WHEN.NONE);
    assert.equal(arrivalWhenOf({ date: '2026-07-29', time: '' }, NOW).when, ARRIVAL_WHEN.NONE);
});

test('A02 夕方に見ても「明日」がずれない(now+24hで切らない)', () => {
    const evening = at(2026, 7, 29, 18, 0);
    assert.equal(arrivalWhenOf({ date: '2026-07-30', time: '09:00' }, evening).when, ARRIVAL_WHEN.TOMORROW);
    // now+24h だと 7/31 09:00 も「24時間以内の外」だが、暦日なら「それ以降」
    assert.equal(arrivalWhenOf({ date: '2026-07-31', time: '09:00' }, evening).when, ARRIVAL_WHEN.LATER);
});

test('A03 ラベルは 本日/明日/月日 で読める', () => {
    assert.equal(arrivalWhenOf({ date: '2026-07-29', time: '15:00' }, NOW).label, '本日 15:00');
    assert.equal(arrivalWhenOf({ date: '2026-07-30', time: '09:00' }, NOW).label, '明日 09:00');
    assert.equal(arrivalWhenOf({ date: '2026-08-03', time: '09:00' }, NOW).label, '8/3 09:00');
});

test('A04 しぼり込み: 空=全部 / has / none / 今日・明日・過ぎた', () => {
    const today = { date: '2026-07-29', time: '15:00' };
    const past = { date: '2026-07-29', time: '10:00' };
    const none = null;
    assert.equal(arrivalFilterMatches(today, [], NOW), true);
    assert.equal(arrivalFilterMatches(none, [], NOW), true);
    assert.equal(arrivalFilterMatches(today, ['has'], NOW), true);
    assert.equal(arrivalFilterMatches(none, ['has'], NOW), false);
    assert.equal(arrivalFilterMatches(none, ['none'], NOW), true);
    assert.equal(arrivalFilterMatches(today, ['none'], NOW), false);
    assert.equal(arrivalFilterMatches(today, ['today'], NOW), true);
    assert.equal(arrivalFilterMatches(past, ['today'], NOW), false);
    assert.equal(arrivalFilterMatches(past, ['past'], NOW), true);
    // 複数選択は「どれかに当たれば出す」
    assert.equal(arrivalFilterMatches(past, ['today', 'past'], NOW), true);
    assert.equal(arrivalFilterMatches(none, ['today', 'none'], NOW), true);
});

// ---------- レイアウト ----------
test('L01 自動は幅で決まる / 手動指定が勝つ', () => {
    assert.equal(isWideLayout('auto', 1280), true);
    assert.equal(isWideLayout('auto', 800), false);
    assert.equal(isWideLayout('narrow', 1920), false);
    assert.equal(isWideLayout('wide', 360), true);
    assert.deepEqual(LAYOUT_MODES.map(m => m.id), ['auto', 'wide', 'narrow']);
});

// ============================================================================
// 🚚 到着予定の回答が後勝ちで消えない（2026-08-14）
// ============================================================================

test('K01 回答は鍵つきの入れ物に1行ずつ。鍵が違えばぶつからない', () => {
  const it0 = { lotId: 'L1' }, it1 = { lotId: 'L2' };
  assert.notEqual(itemAnswerKey(it0, 0), itemAnswerKey(it1, 1));
  // ⚠並びが変わっても同じ行を指す(将来「行を消せる」ようにしても壊れない)
  assert.equal(itemAnswerKey(it1, 1), itemAnswerKey(it1, 7));
  // ロットIDが無い行だけ並び順に落ちる
  assert.equal(itemAnswerKey({}, 3), 'i3');
});

test('K02 ⚠鍵に使えない字は潰す（.や[]はマップの鍵で悪さをする）', () => {
  assert.equal(itemAnswerKey({ lotId: 'A.B[C]' }, 0), 'LA_B_C_');
  assert.match(itemAnswerKey({ lotId: '指図 123' }, 0), /^L/);
});

test('K03 ⚠⚠2人が別の行に同時に答えても、両方残る（これが本題）', () => {
  const base = { id: 'r1', kind: 'arrival', to: '班A', items: [{ lotId: 'L1' }, { lotId: 'L2' }] };
  // 村さんが L1 に、坂井さんが L2 に、ほぼ同時に答える
  const p1 = answerPatch(base.items[0], 0, { date: '2026-08-14', time: '10:00', by: '村', at: 1 });
  const p2 = answerPatch(base.items[1], 1, { date: '2026-08-14', time: '13:00', by: '坂井', at: 2 });
  // Firestore の merge:true は鍵つきの入れ物を合体する（配列は丸ごと差し替わる）
  const merged = { ...base, itemAnswers: { ...p1.itemAnswers, ...p2.itemAnswers } };
  const eff = effectiveItems(merged);
  assert.equal(eff[0].time, '10:00', '先に答えた人の回答が消えていない');
  assert.equal(eff[1].time, '13:00');
  assert.deepEqual([eff[0].by, eff[1].by], ['村', '坂井']);
});

test('K04 古い記録（itemAnswers が無い依頼）はそのまま読める', () => {
  const old = { id: 'r0', items: [{ lotId: 'L1', date: '2026-08-01', time: '09:00', by: '旧' }] };
  assert.deepEqual(effectiveItems(old), old.items, '移行は不要');
  assert.deepEqual(effectiveItems({}), []);
  assert.deepEqual(effectiveItems(null), []);
});

test('K05 ⚠⚠取り消しは「消す」ではなく「消したと書く」（古い回答が復活しない）', () => {
  // 鍵を消すだけにすると merge は消したキーを消さないので、古い items[] の値に落ちて復活する
  const r = { items: [{ lotId: 'L1', date: '2026-08-01', time: '09:00', by: '旧' }], itemAnswers: { LL1: { cleared: true } } };
  const eff = effectiveItems(r);
  assert.equal(eff[0].time, '', '取り消したのに古い時刻が出てはいけない');
  assert.equal(eff[0].by, '');
  assert.equal(eff[0].applied, null);
});

test('K06 板は重ねた後の値で作られる（消えた回答が板から落ちない）', () => {
  const reqs = [{
    id: 'r1', kind: 'arrival', to: '班A', createdAt: 100,
    items: [{ lotId: 'L1', orderNo: '1001' }, { lotId: 'L2', orderNo: '1002' }],
    itemAnswers: {
      LL1: { date: '2026-08-14', time: '10:00', by: '村', at: 1 },
      LL2: { date: '2026-08-14', time: '13:00', by: '坂井', at: 2 },
    },
  }];
  const out = mergeArrivalEntries({ arrivalTimes: [], contactRequests: reqs, group: '班A', now: Date.now() });
  assert.equal(out.length, 2, '2人ぶんとも板に出る');
  assert.deepEqual(out.map(e => e.time).sort(), ['10:00', '13:00']);
});


// ---------- 取り消したあと 答え直せるか(2026-09-09) ----------
// 🚨 組立側に「到着予定の取り消し」を付けた時に生まれた穴。確かめ役2人が別々に見つけた。
//   取り消しは itemAnswers[鍵] に { cleared: true } の墓標を書く(鍵を消すと merge で古い回答が
//   復活するため)。ところが **答え直す時に cleared を消していなかった**。
//   保存は setDoc(merge:true)なので墓標がマップに残り続け、effectiveItems が毎回その回答を
//   空に戻す = 入れ直した到着予定が どの板にも出ない(やり直しが1回きりで詰む)。
//   直し: arrivalAnswerSave が cleared を **いつも書く**(取り消し true / 答え直し false)。
const REQ0 = {
    id: 'R1', kind: 'arrival', to: '組立 高木班', status: 'waiting',
    items: [{ lotId: 'L1', orderNo: '1001', model: 'M-1', date: '', time: '', by: '', at: 0 }],
};
const applySave = (req, sv, status) => ({
    ...req,
    items: sv.items,
    // Firestore の setDoc(merge:true) と同じ重ね方(マップは鍵ごとに重なる。書かなかった鍵は残る)
    itemAnswers: { ...(req.itemAnswers || {}), ...Object.fromEntries(
        Object.entries(sv.itemAnswers).map(([k, v]) => [k, { ...((req.itemAnswers || {})[k] || {}), ...v }]),
    ) },
    ...(status ? { status } : {}),
});

test('CL01 答える → 取り消す → もう一度答える、で入れ直した時刻が効く', () => {
    const pat1 = { date: '2026-07-29', time: '10:00', by: '高木', at: 1 };
    let req = applySave(REQ0, arrivalAnswerSave(REQ0, 0, pat1, pat1), 'answered');
    assert.equal(effectiveItems(req)[0].time, '10:00', '1回目の回答が効いていない');

    // 取り消し(組立側 cancelArrival と同じ形)
    const svc = arrivalAnswerSave(req, 0, { date: '', time: '', by: '', at: 0 }, { cleared: true });
    req = applySave(req, svc, 'waiting');
    assert.equal(effectiveItems(req)[0].time, '', '取り消しが効いていない');

    // 答え直す
    const pat2 = { date: '2026-07-29', time: '17:00', by: '高木', at: 2 };
    const sv2 = arrivalAnswerSave(req, 0, pat2, pat2);
    req = applySave(req, sv2, sv2.answered ? 'answered' : 'waiting');
    assert.equal(effectiveItems(req)[0].time, '17:00',
        '🚨 答え直した時刻が消えている(取り消しの墓標 cleared:true が残っている)');
    assert.equal(req.status, 'answered', '答え直しても「未回答」のまま');
    assert.equal(effectiveItems(req)[0].date, '2026-07-29');
});

test('CL02 取り消しの墓標は 答え直しで false に上書きされる(鍵は消さない)', () => {
    const pat = { date: '2026-07-29', time: '10:00', by: '高木', at: 1 };
    const key = itemAnswerKey(REQ0.items[0], 0);
    const cancelled = arrivalAnswerSave(REQ0, 0, { date: '', time: '', by: '', at: 0 }, { cleared: true });
    assert.equal(cancelled.itemAnswers[key].cleared, true, '取り消しで cleared: true を書いていない');
    const answered = arrivalAnswerSave(REQ0, 0, pat, pat);
    assert.equal(answered.itemAnswers[key].cleared, false,
        '🚨 答え直しで cleared: false を書いていない(merge は書かなかった鍵を消さない)');
    assert.ok(key in answered.itemAnswers, '鍵ごと消している(古い回答が復活する)');
});

test('CL03 取り消し → 答え直す を2往復しても最後の回答が残る', () => {
    let req = REQ0;
    for (const t of ['09:00', '13:00']) {
        const pat = { date: '2026-07-29', time: t, by: '高木', at: 1 };
        req = applySave(req, arrivalAnswerSave(req, 0, pat, pat), 'answered');
        assert.equal(effectiveItems(req)[0].time, t);
        req = applySave(req, arrivalAnswerSave(req, 0, { date: '', time: '', by: '', at: 0 }, { cleared: true }), 'waiting');
        assert.equal(effectiveItems(req)[0].time, '');
    }
    const last = { date: '2026-07-29', time: '15:00', by: '高木', at: 9 };
    req = applySave(req, arrivalAnswerSave(req, 0, last, last), 'answered');
    assert.equal(effectiveItems(req)[0].time, '15:00', '2往復したら最後の回答が消えた');
});

// ---------- 2026-09-25 組立の声: 予定日のボタンに休みの日を出さない ----------
import { makeIsWorkday } from '../factoryCalendar.js';

test('C08b 金曜に開くと 本日(金)・月・火。月曜を「明日」と書かない', () => {
    const o = quickDateOptions(at(2026, 9, 25, 18), 3, makeIsWorkday(null));
    assert.deepEqual(o.map((x) => x.value), ['2026-09-25', '2026-09-28', '2026-09-29']);
    assert.match(o[0].label, /^本日\(9\/25 金\)$/);
    assert.match(o[1].label, /^月曜\(9\/28 月\)$/);
    assert.equal(o[1].short, '月曜');
    assert.ok(!o.some((x) => /明日|あさって/.test(x.label)));
});

test('C08c 土曜に開くと「本日」は出さず 次の出勤日から3つ', () => {
    const o = quickDateOptions(at(2026, 9, 26, 10), 3, makeIsWorkday(null));
    assert.deepEqual(o.map((x) => x.value), ['2026-09-28', '2026-09-29', '2026-09-30']);
    assert.ok(!o.some((x) => x.short === '本日'));
});

test('C08d 祝日(工場の休み)は飛ばし、休日出勤の土曜は出す', () => {
    const cal = { days: { '2026-10-12': { type: 'off', label: 'スポーツの日' }, '2026-10-10': { type: 'work', label: '休日出勤' } } };
    const o = quickDateOptions(at(2026, 10, 9, 9), 3, makeIsWorkday(cal));
    assert.deepEqual(o.map((x) => x.value), ['2026-10-09', '2026-10-10', '2026-10-13']);
    assert.match(o[1].label, /^明日\(10\/10 土\)$/);
});

test('C08e 平日の真ん中は今まで通り 本日/明日/あさって', () => {
    const o = quickDateOptions(at(2026, 9, 29, 9), 3, makeIsWorkday(null));
    assert.deepEqual(o.map((x) => x.short), ['本日', '明日', 'あさって']);
});
