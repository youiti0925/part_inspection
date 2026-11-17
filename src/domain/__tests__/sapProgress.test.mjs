// SAP 工程の進み(作り物の小さな行で)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialToIso, readWorkName, buildOrders, reachList, loadByWorkCenter, loadByGroup, itemSummary } from '../sapProgress.js';
import { parseSheetXml } from '../sapXlsx.js';

// 46000 = 2025-12-... を ISO に直した値で組む
const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const row = (o) => ({ A: '1001', U: 'X1', V: '部品', F: 1, ...o });
const ROWS = [
    row({ B: '0010', C: '2385', D: '2385:平面研削：ﾛｰﾀﾘｰ研削(小)', H: D('2026-11-01'), I: D('2026-11-03'), J: 1, L: 2, N: 0 }),
    row({ B: '0020', C: '2325', D: 'ﾌﾗｲｽ:MN(MV･NV)', H: D('2026-11-10'), J: 0.5, L: 1.5, R: D('2026-11-10'), S: D('2026-11-20') }),
    row({ B: '0030', C: '2393', D: '歯切り：ｳｫｰﾑｷﾞｱ仕', J: 2, R: D('2026-11-21'), S: D('2026-11-25') }),
    row({ B: '0040', C: '2509', D: '付帯作業一時置き：三次元検査', J: 0.1, R: D('2026-11-26'), S: D('2026-11-26') }),
    // 別の指図: 検査系の工程なし・全部未
    { A: '1002', B: '0010', C: '2367', D: '門M/C:BM(660N-600N)', U: 'X2', V: '本体', F: 2, J: 3, R: D('2026-11-18'), S: D('2026-11-19') },
    // 別の指図: 全部済
    { A: '1003', B: '0010', C: '2371', D: '円筒研削：円筒研削', U: 'X1', V: '部品', H: D('2026-10-01'), I: D('2026-10-02'), J: 1 },
];

test('SP01 Excel シリアル → 日付(空は null)', () => {
    assert.equal(serialToIso(46402), '2027-01-15');
    assert.equal(serialToIso(undefined), null);
    assert.equal(serialToIso(0), null);
});

test('SP02 作業テキスト → 工程名と種類(接頭の作業区・全角コロン・半角カナ)', () => {
    assert.deepEqual(readWorkName('2385:平面研削：ﾛｰﾀﾘｰ研削(小)', '2385'), { name: '平面研削', kind: 'machine' });
    assert.equal(readWorkName('ﾌﾗｲｽ:MN(MV･NV)', '2325').name, 'フライス');
    assert.equal(readWorkName('2367:門M/C:BM(660N-600N)', '2367').name, '門M/C');
    assert.equal(readWorkName('横M/C:BM(HX400)', '2351').name, '横M/C');
    assert.equal(readWorkName('立旋盤：NC立旋盤(4APC)', '2349').name, '立旋盤');
    assert.equal(readWorkName('2313:旋盤：対話NC旋盤QT300MB', '2313').name, '旋盤');
    assert.deepEqual(readWorkName('付帯作業一時置き：三次元検査', '2509'), { name: '三次元検査', kind: 'inspect' });
    assert.equal(readWorkName('2503:面取り洗浄工程', '2503').kind, 'wash');
    assert.equal(readWorkName('付帯作業一時置き：先行仕上', '2503').kind, 'misc');
    assert.equal(readWorkName('', '2371').name, '円筒研削');   // 作業テキストが空 → 作業区コードから
});

test('SP03 状態: 実績終了=済・開始のみ=作業中・なし=未', () => {
    const o = buildOrders(ROWS).find((x) => x.order === '1001');
    assert.deepEqual(o.stages.map((s) => s.status), ['done', 'working', 'todo', 'todo']);
    assert.equal(o.doneCount, 1); assert.equal(o.total, 4);
});

test('SP04 今どの工程か(活動順で最初の未完了)', () => {
    const o = buildOrders(ROWS).find((x) => x.order === '1001');
    assert.equal(o.currentLabel, '0020 フライス');
    assert.equal(o.current.status, 'working');
    assert.equal(buildOrders(ROWS).find((x) => x.order === '1003').currentLabel, '全工程済');
});

test('SP05 活動が行の順と逆でも活動順に並べる', () => {
    const o = buildOrders([...ROWS.slice(0, 4)].reverse()).find((x) => x.order === '1001');
    assert.deepEqual(o.stages.map((s) => s.act), ['0010', '0020', '0030', '0040']);
});

test('SP06 部品検査に届く見込み = 検査の直前までの機械工程の終了日の最大(済は実績・他は最早終了)', () => {
    const o = buildOrders(ROWS).find((x) => x.order === '1001');
    assert.equal(o.reach, '2026-11-25');        // 歯切り S=11-25 が最大
    assert.equal(o.reachKind, 'estimate');
    assert.equal(o.machinesDone, false);
    assert.equal(o.machineEnd, '2026-11-25');
});

test('SP07 検査工程が無い指図は機械の終了見込みで代用・全部済は一覧に出さない', () => {
    const os = buildOrders(ROWS);
    const o2 = os.find((x) => x.order === '1002');
    assert.equal(o2.reach, '2026-11-19'); assert.equal(o2.reachKind, 'machine-end');
    assert.equal(os.find((x) => x.order === '1003').allDone, true);
    const l = reachList(os, '2026-11-17');
    assert.deepEqual(l.map((x) => x.order), ['1002', '1001']);   // 早い順・1003 は除く
    assert.equal(l[0].daysFromToday, 2);
});

test('SP08 今後N日以内で絞る(過ぎた物は入れない)', () => {
    const os = buildOrders(ROWS);
    assert.deepEqual(reachList(os, '2026-11-17', { withinDays: 3 }).map((x) => x.order), ['1002']);
    assert.deepEqual(reachList(os, '2026-11-30', { withinDays: 14 }).map((x) => x.order), []);   // どちらも過ぎた
});

test('SP09 作業区ごとの負荷(未完了の件数・標準時間・実績あり)', () => {
    const w = loadByWorkCenter(buildOrders(ROWS));
    const c = Object.fromEntries(w.map((x) => [x.wc, x]));
    assert.equal(c['2385'].openCount, 0); assert.equal(c['2385'].actual, 1);
    assert.equal(c['2325'].openCount, 1); assert.equal(c['2325'].openHours, 2); assert.equal(c['2325'].workingCount, 1);
    assert.equal(c['2367'].openHours, 3);
    assert.equal(w[0].wc, '2367');   // 未完了 H が大きい順
});

test('SP10 機械グループごと・品目ごとの集計', () => {
    const os = buildOrders(ROWS);
    const g = loadByGroup(os).find((x) => x.name === 'フライス');
    assert.equal(g.openCount, 1);
    const it = itemSummary(os).find((x) => x.item === 'X1');
    assert.equal(it.orderCount, 2); assert.equal(it.count, 5); assert.equal(it.actual, 3);
});

test('SP11 xlsx の sheet XML(インライン文字列・数値・空セル)を読む', () => {
    const xml = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>指図</t></is></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>10&amp;2</t></is></c><c r="D2" t="inlineStr" /><c r="F2" t="n"><v>2.5</v></c></row></sheetData>';
    const r = parseSheetXml(xml);
    assert.deepEqual(r[1], { A: '10&2', F: 2.5 });
});

import { orderChart, handoffList, dailyLoad } from '../sapProgress.js';

test('SP12 1指図のチャート: 付帯作業を外し 活動順・色は状態・今日の線', () => {
    const o = buildOrders(ROWS).find((x) => x.order === '1001');
    const c = orderChart(o, '2026-11-17');
    assert.deepEqual(c.bars.map((b) => b.act), ['0010', '0020', '0030', '0040']);
    assert.equal(c.bars[0].start, '2026-11-01'); assert.equal(c.bars[0].end, '2026-11-03');   // 済=実績
    assert.equal(c.bars[1].end, '2026-11-20');                                               // 作業中=実績開始〜最早終了
    assert.equal(c.todayDay - c.minDay, 16);
});

test('SP13 次の工程への連絡: 前が済→渡った・今の工程→渡る見込み', () => {
    const h = handoffList(buildOrders(ROWS), '2026-11-17').filter((x) => x.order === '1001');
    assert.equal(h.length, 2);
    assert.deepEqual([h[0].kind, h[0].fromName, h[0].toName, h[0].toWc, h[0].date], ['passed', '平面研削', 'フライス', '2325', '2026-11-03']);
    assert.deepEqual([h[1].kind, h[1].fromName, h[1].toName, h[1].date], ['expected', 'フライス', '歯切り', '2026-11-20']);
});

test('SP14 作業区の日別の負荷: 標準Hを 最早開始〜終了に等分・過去は遅れ・済は入れない', () => {
    const d = dailyLoad(buildOrders(ROWS), '2026-11-17', { days: 14 });
    const g = Object.fromEntries(d.rows.map((r) => [r.name, r]));
    assert.equal(g['門M/C'].total, 3);
    assert.equal(g['門M/C'].perDay[1], 1.5); assert.equal(g['門M/C'].perDay[2], 1.5);   // 11-18・11-19 に半々
    assert.equal(g['フライス'].total, 2);          // 0.5+1.5
    assert.equal(g['フライス'].late, 1.3);         // 11-10〜20(11日)のうち過去 7 日分 = 2×7/11
    assert.equal(g['円筒研削'], undefined);        // 済だけの作業区は出ない
});

import { gaugeOf, stageView, serialToTime } from '../sapProgress.js';

test('SP15 時刻: 小数部が無ければ null(でっち上げない)・あれば HH:MM', () => {
    assert.equal(serialToTime(46402), null);
    assert.equal(serialToTime(46402.5), '12:00');
    assert.equal(serialToTime(46402.75), '18:00');
});

test('SP16 ゲージ: 付帯作業を除き活動順・色の状態は 済/作業中/未/遅れ・日付だけ(時刻なし)', () => {
    const o = buildOrders(ROWS).find((x) => x.order === '1001');
    const g = gaugeOf(o, '2026-11-22');
    assert.deepEqual(g.segs.map((s) => s.act), ['0010', '0020', '0030', '0040']);
    assert.deepEqual(g.segs.map((s) => s.status), ['done', 'late', 'todo', 'todo']);   // 0020 は予定終了 11-20 を過ぎて未完了
    assert.equal(g.segs[0].startLabel, '11-01'); assert.equal(g.segs[0].endLabel, '11-03');
    assert.equal(g.hasTime, false);
    assert.equal(gaugeOf(o, '2026-11-17').segs[1].status, 'working');
});

test('SP17 ゲージの時刻: SAP に時刻がある時だけ出す', () => {
    const rows = [{ A: '9', B: '0010', C: '2385', D: '平面研削：x', H: D('2026-11-01') + 0.375, I: D('2026-11-01') + 0.5, J: 1 }];
    const g = gaugeOf(buildOrders(rows)[0], '2026-11-17');
    assert.equal(g.segs[0].startLabel, '11-01 09:00'); assert.equal(g.segs[0].endLabel, '11-01 12:00'); assert.equal(g.hasTime, true);
});

test('SP18 工程中心: 今いる・次に来る(前が済・来る見込み日順)・済(新しい順)', () => {
    const rows = [
        ...ROWS,
        { A: '2001', B: '0010', C: '2385', D: '平面研削：a', U: 'Y', V: 'y', H: D('2026-11-05'), I: D('2026-11-06'), J: 1 },
        { A: '2001', B: '0020', C: '2325', D: 'ﾌﾗｲｽ:a', U: 'Y', V: 'y', R: D('2026-11-12'), S: D('2026-11-13'), J: 1 },
        { A: '2002', B: '0010', C: '2325', D: 'ﾌﾗｲｽ:b', U: 'Z', V: 'z', R: D('2026-11-11'), S: D('2026-11-12'), J: 1 },   // 最初の工程が未
        { A: '2003', B: '0010', C: '2371', D: '円筒研削：c', U: 'Z', V: 'z', J: 1 },
        { A: '2003', B: '0020', C: '2325', D: 'ﾌﾗｲｽ:c', U: 'Z', V: 'z', R: D('2026-11-08'), S: D('2026-11-09'), J: 1 },      // 前が未 → 次ではない
    ];
    const v = stageView(buildOrders(rows), 'フライス', '2026-11-17');
    assert.deepEqual(v.working.map((x) => x.order), ['1001']);
    assert.deepEqual(v.next.map((x) => x.order), ['2002', '2001']);          // 11-11 < 11-12
    assert.equal(v.next[1].prevLabel, '0010 平面研削(2385)');
    assert.equal(v.done.length, 0);
    const h = stageView(buildOrders(rows), '平面研削', '2026-11-17');
    assert.deepEqual(h.done.map((x) => x.order), ['2001', '1001', '1003'].filter((x) => x !== '1003'));  // 平面研削の済: 2001(11-06)・1001(11-03)
    assert.equal(stageView(buildOrders(rows), '2325', '2026-11-17', { by: 'wc' }).next.length, 2);
});
