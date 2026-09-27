// 再作業(やり直し)の分析 純関数のテスト。
// ⚠ここは「作り話の数字を1つも出さない」ことを守らせるための番人。
//   原因が引けない行は必ず「原因不明」として別枠に出る、を機械的に固定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reworkRows, byCause, byCauseModelTemplate, byRound, reworkSummary, ROUND_LABELS,
} from '../reworkAnalysis.js';

const D = (s) => new Date(s).getTime();

// ---- テスト用のロットを作る小道具 -------------------------------------------
const mkLot = (over = {}) => ({
  id: 'lot1', orderNo: 'A-001', model: 'GX-100', templateId: 'tpl1',
  steps: [{ id: 's0', title: '芯出し' }, { id: 's1', title: '分割測定' }],
  tasks: {},
  ...over,
});
const TEMPLATES = [{ id: 'tpl1', name: '標準テンプレ' }, { id: 'tpl2', name: '短縮テンプレ' }];

// ---------------------------------------------------------------------------
// ⚠この決め方は本番バックアップ(2026-08-06_0500 の lots.json)を1件ずつ数えて決めた。
//   実データは reworks が 258件、うち duration が 0秒 の物が 3件。
//   0秒の3件も「やり直しが起きた記録」として実在するので、こちらの判断で捨てない。
//   捨てると画面の件数(255)が元データ(258)と合わず、誰も説明できなくなる。
//   時間は0秒なので合計時間は1秒も変わらない。
test('R01 duration が 0 や 未入力 の再作業も1件として数える (時間は1秒も増やさない)', () => {
  const lot = mkLot({
    tasks: {
      's0-0': { reworks: [
        { round: 1, duration: 0, endTime: D('2026-08-01T10:00:00') },
        { round: 2, endTime: D('2026-08-01T11:00:00') },
        { round: 3, duration: 120, endTime: D('2026-08-01T12:00:00'), reason: 'バックラッシュ大' },
      ] },
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.seconds), [0, 0, 120]);
  assert.deepEqual(rows.map(r => r.zeroSeconds), [true, true, false]);
  const sum = reworkSummary(rows);
  assert.equal(sum.count, 3);
  assert.equal(sum.seconds, 120);        // 0秒は時間を1秒も動かさない
  assert.equal(sum.zeroSecondsCount, 2); // 何件が0秒だったかは隠さず出せる
});

test('R01b マイナスの時間は 0秒 として扱う (記録は捨てない・合計を減らさない)', () => {
  const lot = mkLot({ tasks: { 's0-0': { reworks: [
    { round: 1, duration: -500, reason: 'バックラッシュ大' },
    { round: 2, duration: 300, reason: 'バックラッシュ大' },
  ] } } });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seconds, 0);
  const sum = reworkSummary(rows);
  assert.equal(sum.count, 2);
  assert.equal(sum.seconds, 300); // マイナスで引かれない
  assert.equal(sum.zeroSecondsCount, 1);
});

test('R02 endTime が無くても startTime + duration で日付が出る (dailyWork と同じ作法)', () => {
  const lot = mkLot({
    tasks: {
      's0-0': { reworks: [{ round: 1, duration: 600, startTime: D('2026-08-01T09:00:00'), reason: '傾きNG再測定' }] },
      's1-0': { reworks: [{ round: 1, duration: 60, endTime: D('2026-08-02T15:00:00'), reason: '傾きNG再測定' }] },
      's1-1': { reworks: [{ round: 1, duration: 60, reason: '傾きNG再測定' }] }, // 時刻が一切無い記録
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  const byKey = Object.fromEntries(rows.map(r => [r.taskKey, r]));
  assert.equal(byKey['s0-0'].endedAt, D('2026-08-01T09:10:00')); // startTime + 600秒
  assert.equal(byKey['s1-0'].endedAt, D('2026-08-02T15:00:00')); // endTime 優先
  assert.equal(byKey['s1-1'].endedAt, 0);                        // 無い物は 0。作らない
  assert.equal(rows.length, 3);
});

test('R03 round が飛んでいても・無くても壊れない (無い時は並び順で補う)', () => {
  const lot = mkLot({
    tasks: {
      's0-0': { reworks: [
        { duration: 10, reason: 'ギヤ鳴り' },            // round 無し → 1回目
        { duration: 20, reason: 'ギヤ鳴り' },            // round 無し → 2回目
        { round: 9, duration: 30, reason: 'ギヤ鳴り' },  // 飛んでいる → 9 のまま
      ] },
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  assert.deepEqual(rows.map(r => r.round), [1, 2, 9]);
  const rr = byRound(rows);
  assert.equal(rr.find(x => x.label === '1回目').count, 1);
  assert.equal(rr.find(x => x.label === '2回目').count, 1);
  assert.equal(rr.find(x => x.label === '4回目以降').count, 1); // 9回目はここへ
  assert.equal(rr.find(x => x.label === '3回目').count, 0);
});

test('R04 原因の引き当ては 回ごと → NG理由の代用 → 原因不明 の順', () => {
  const lot = mkLot({
    tasks: {
      // 回ごとの理由が付いている
      's0-0': { ngReason: '分割精度不良', reworks: [{ round: 1, duration: 100, reason: 'バックラッシュ大' }] },
      // 回ごとの理由が無い → タスクの NG理由 で代用
      's0-1': { ngReason: '分割精度不良', reworks: [{ round: 1, duration: 200 }] },
      // どちらも無い → 原因不明
      's0-2': { reworks: [{ round: 1, duration: 300 }] },
      // 空白だけの理由は「有る」と見なさない
      's0-3': { ngReason: '   ', reworks: [{ round: 1, duration: 400, reason: '  ' }] },
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  const byKey = Object.fromEntries(rows.map(r => [r.taskKey, r]));
  assert.equal(byKey['s0-0'].cause, 'バックラッシュ大');
  assert.equal(byKey['s0-0'].causeFrom, '回ごと');
  assert.equal(byKey['s0-1'].cause, '分割精度不良');
  assert.equal(byKey['s0-1'].causeFrom, 'NG理由の代用');
  assert.equal(byKey['s0-2'].cause, '');
  assert.equal(byKey['s0-2'].causeFrom, '原因不明');
  assert.equal(byKey['s0-3'].causeFrom, '原因不明');
});

test('R05 工程名は taskKey から引く (工程ID前置き・数字インデックス・不明の3通り)', () => {
  const lot = mkLot({
    tasks: {
      's1-2': { reworks: [{ round: 1, duration: 10, reason: 'A' }] },       // 工程ID 前置き
      '0-3': { reworks: [{ round: 1, duration: 10, reason: 'A' }] },        // 数字インデックス
      'zzz-9': { reworks: [{ round: 1, duration: 10, reason: 'A' }] },      // どちらでもない
      's0-lot-1': { reworks: [{ round: 1, duration: 10, reason: 'A' }] },   // ロット1回だけの工程
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  const byKey = Object.fromEntries(rows.map(r => [r.taskKey, r]));
  assert.equal(byKey['s1-2'].stepTitle, '分割測定');
  assert.equal(byKey['0-3'].stepTitle, '芯出し');
  assert.equal(byKey['zzz-9'].stepTitle, '全体');
  assert.equal(byKey['s0-lot-1'].stepTitle, '芯出し');
});

test('R06 型式・指図・テンプレ名がそのまま行に付く (テンプレ名は templates から引く)', () => {
  const lots = [
    mkLot({ id: 'L1', orderNo: 'A-001', model: 'GX-100', templateId: 'tpl2', tasks: { 's0-0': { reworks: [{ round: 1, duration: 10, reason: 'A' }] } } }),
    // templates に無い templateId → lot.templateName で補える。無ければ空
    mkLot({ id: 'L2', orderNo: 'A-002', model: 'GX-200', templateId: 'nope', templateName: '手入力テンプレ', tasks: { 's0-0': { reworks: [{ round: 1, duration: 10, reason: 'A' }] } } }),
    mkLot({ id: 'L3', orderNo: 'A-003', model: 'GX-300', templateId: '', tasks: { 's0-0': { reworks: [{ round: 1, duration: 10, reason: 'A' }] } } }),
  ];
  const rows = reworkRows({ lots, templates: TEMPLATES });
  const byLot = Object.fromEntries(rows.map(r => [r.lotId, r]));
  assert.equal(byLot.L1.templateName, '短縮テンプレ');
  assert.equal(byLot.L1.orderNo, 'A-001');
  assert.equal(byLot.L1.model, 'GX-100');
  assert.equal(byLot.L2.templateName, '手入力テンプレ');
  assert.equal(byLot.L3.templateName, '');
});

test('R07 byCause は時間の大きい順・原因不明は他に混ぜず必ず最後の別枠', () => {
  const lot = mkLot({
    tasks: {
      's0-0': { reworks: [{ round: 1, duration: 100, reason: '傾きNG再測定' }] },
      's0-1': { reworks: [{ round: 1, duration: 500, reason: 'バックラッシュ大' }] },
      's0-2': { reworks: [{ round: 2, duration: 200, reason: 'バックラッシュ大' }] },
      's0-3': { reworks: [{ round: 1, duration: 9000 }] },  // 原因不明 (一番長いが別枠)
    },
  });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  const kindOf = (c) => (c === 'バックラッシュ大' ? '機械' : c === '傾きNG再測定' ? '測定' : '');
  const res = byCause(rows, { kindOf });
  assert.deepEqual(res.map(r => r.cause), ['バックラッシュ大', '傾きNG再測定', '原因不明']);
  assert.equal(res[0].seconds, 700);
  assert.equal(res[0].count, 2);
  assert.equal(res[0].kind, '機械');
  assert.equal(res[0].unknown, false);
  // 回別の内訳も持つ
  assert.equal(res[0].rounds.find(x => x.label === '1回目').seconds, 500);
  assert.equal(res[0].rounds.find(x => x.label === '2回目').seconds, 200);
  // 原因不明は時間が一番長くても最後。混ぜない印が付く
  const unk = res[2];
  assert.equal(unk.unknown, true);
  assert.equal(unk.seconds, 9000);
  assert.equal(unk.count, 1);
  assert.equal(unk.kind, '未分類');
});

test('R08 kindOf が空/未設定を返した原因は「未分類」になる (kindOf 自体を渡さなくても落ちない)', () => {
  const lot = mkLot({ tasks: { 's0-0': { reworks: [{ round: 1, duration: 60, reason: '治具使いずらい' }] } } });
  const rows = reworkRows({ lots: [lot], templates: TEMPLATES });
  assert.equal(byCause(rows, { kindOf: () => '' })[0].kind, '未分類');
  assert.equal(byCause(rows, { kindOf: () => undefined })[0].kind, '未分類');
  assert.equal(byCause(rows)[0].kind, '未分類');
});

test('R09 byCauseModelTemplate は 原因 × 型式 × テンプレ で束ねる (工程名だけで束ねない)', () => {
  const lots = [
    mkLot({ id: 'L1', model: 'GX-100', templateId: 'tpl1', tasks: {
      's0-0': { reworks: [{ round: 1, duration: 100, reason: 'バックラッシュ大' }] },
      's1-0': { reworks: [{ round: 1, duration: 50, reason: 'バックラッシュ大' }] },
    } }),
    // 同じ原因・同じ型式でもテンプレが違えば別の束
    mkLot({ id: 'L2', model: 'GX-100', templateId: 'tpl2', tasks: {
      's0-0': { reworks: [{ round: 1, duration: 900, reason: 'バックラッシュ大' }] },
    } }),
    // 同じ原因・同じテンプレでも型式が違えば別の束
    mkLot({ id: 'L3', model: 'GX-200', templateId: 'tpl1', tasks: {
      's0-0': { reworks: [{ round: 1, duration: 10, reason: 'バックラッシュ大' }] },
    } }),
  ];
  const rows = reworkRows({ lots, templates: TEMPLATES });
  const res = byCauseModelTemplate(rows);
  assert.equal(res.length, 3);
  assert.deepEqual(res[0], {
    causeKey: JSON.stringify(['known', 'バックラッシュ大']),
    cause: 'バックラッシュ大', model: 'GX-100', templateName: '短縮テンプレ', count: 1, seconds: 900, unknown: false,
  });
  assert.equal(res[1].templateName, '標準テンプレ');
  assert.equal(res[1].model, 'GX-100');
  assert.equal(res[1].seconds, 150); // 同じ束の2件は足し合う (工程が違っても束は同じ)
  assert.equal(res[2].model, 'GX-200');
});

test('R09b byCauseModelTemplate でも原因不明は別枠で最後', () => {
  const lot = mkLot({ tasks: {
    's0-0': { reworks: [{ round: 1, duration: 5, reason: 'ギヤ鳴り' }] },
    's0-1': { reworks: [{ round: 1, duration: 9999 }] },
  } });
  const res = byCauseModelTemplate(reworkRows({ lots: [lot], templates: TEMPLATES }));
  assert.equal(res[0].cause, 'ギヤ鳴り');
  assert.equal(res[1].cause, '原因不明');
  assert.equal(res[1].unknown, true);
});

// ⚠集計単位の検算は計算の検算と同じくらい大事(過去の教訓)。
//   原因の行を押して開く「型式×テンプレ」の表は、行が1本落ちても・二重に数えても
//   それぞれの行を見るだけのテストでは緑のまま通ってしまう。総和で縛る。
test('R09c 原因×型式×テンプレ の総和 = 原因別の総和 = 全体の合計 (件数も秒も)', () => {
  const lots = [
    mkLot({ id: 'L1', model: 'GX-100', templateId: 'tpl1', tasks: {
      's0-0': { ngReason: '分割精度不良', reworks: [{ round: 1, duration: 111 }, { round: 2, duration: 222, reason: 'バックラッシュ大' }] },
      's1-0': { reworks: [{ round: 1, duration: 333 }] },                                  // 原因不明
      's1-1': { reworks: [{ round: 5, duration: 444, reason: 'バックラッシュ大' }] },
      's1-2': { reworks: [{ round: 1, duration: 0, reason: 'バックラッシュ大' }] },          // 0秒も1件
    } }),
    mkLot({ id: 'L2', model: 'GX-100', templateId: 'tpl2', tasks: {
      's0-0': { reworks: [{ round: 1, duration: 555, reason: 'バックラッシュ大' }] },        // 型式同じ・テンプレ違い
    } }),
    mkLot({ id: 'L3', model: 'GX-200', templateId: 'tpl1', tasks: {
      's0-0': { reworks: [{ round: 3, duration: 666, reason: '傾きNG再測定' }] },
      's0-1': { reworks: [{ round: 1, duration: 777 }] },                                  // 原因不明(別の型式)
    } }),
  ];
  const rows = reworkRows({ lots, templates: TEMPLATES });
  const sum = reworkSummary(rows);
  const causes = byCause(rows, { kindOf: () => '' });
  const detail = byCauseModelTemplate(rows);

  // ① 全部の総和が一致する
  const sumOf = (list) => list.reduce((a, x) => ({ count: a.count + x.count, seconds: a.seconds + x.seconds }), { count: 0, seconds: 0 });
  assert.deepEqual(sumOf(detail), { count: sum.count, seconds: sum.seconds });
  assert.deepEqual(sumOf(detail), sumOf(causes));
  assert.equal(sum.count, rows.length);

  // ② 原因1本ずつでも一致する (どこか1本だけ落ちる/二重に数える を捕まえる)
  causes.forEach((c) => {
    const mine = detail.filter(d => d.causeKey === c.key);
    assert.ok(mine.length > 0, `内訳が1行も無い原因がある: ${c.cause}`);
    assert.deepEqual(sumOf(mine), { count: c.count, seconds: c.seconds }, `合計が合わない原因: ${c.cause}`);
  });

  // ③ 原因不明の分も内訳側で同じだけある (別枠のまま数が合う)
  const unknownDetail = detail.filter(d => d.unknown);
  assert.deepEqual(sumOf(unknownDetail), { count: sum.unknownCount, seconds: sum.unknownSeconds });
  assert.equal(unknownDetail.length, 2); // 型式が違えば原因不明も別の行になる (束ねすぎない)
});

test('R10 byRound は 1/2/3/4回目以降 の4本を必ず同じ並びで返す', () => {
  const lot = mkLot({ tasks: {
    's0-0': { reworks: [
      { round: 1, duration: 10, reason: 'A' }, { round: 2, duration: 20, reason: 'A' },
      { round: 3, duration: 30, reason: 'A' }, { round: 4, duration: 40, reason: 'A' },
      { round: 7, duration: 50, reason: 'A' },
    ] },
  } });
  const res = byRound(reworkRows({ lots: [lot], templates: TEMPLATES }));
  assert.deepEqual(res.map(r => r.label), ROUND_LABELS);
  assert.equal(res[0].seconds, 10);
  assert.equal(res[3].count, 2);
  assert.equal(res[3].seconds, 90); // 4回目 + 7回目
});

test('R11 まとめた合計 = 回別の合計 = 原因別の合計 (数字が合う)', () => {
  const lots = [
    mkLot({ id: 'L1', tasks: {
      's0-0': { ngReason: '分割精度不良', reworks: [{ round: 1, duration: 111 }, { round: 2, duration: 222, reason: 'バックラッシュ小' }] },
      's1-0': { reworks: [{ round: 1, duration: 333 }] },
      's1-1': { reworks: [{ round: 5, duration: 444, reason: '作業性悪い' }] },
    } }),
    mkLot({ id: 'L2', model: 'GX-900', templateId: 'tpl2', tasks: {
      's0-0': { reworks: [{ round: 1, duration: 555, reason: '作業性悪い' }] },
    } }),
  ];
  const rows = reworkRows({ lots, templates: TEMPLATES });
  const sum = reworkSummary(rows);
  const rr = byRound(rows);
  const bc = byCause(rows, { kindOf: () => '' });
  assert.equal(sum.count, 5);
  assert.equal(sum.seconds, 111 + 222 + 333 + 444 + 555);
  assert.equal(rr.reduce((a, r) => a + r.count, 0), sum.count);
  assert.equal(rr.reduce((a, r) => a + r.seconds, 0), sum.seconds);
  assert.equal(bc.reduce((a, r) => a + r.count, 0), sum.count);
  assert.equal(bc.reduce((a, r) => a + r.seconds, 0), sum.seconds);
  // 原因不明は別枠の数字としても取り出せる (s1-0 の 333 だけ)
  assert.equal(sum.unknownCount, 1);
  assert.equal(sum.unknownSeconds, 333);
  // 原因が引けた分の合計 = 全体 - 原因不明
  assert.equal(sum.knownSeconds, sum.seconds - 333);
  assert.equal(sum.knownCount, 4);
  // 引き当ての内訳も合計と合う
  assert.equal(sum.byCauseFrom['回ごと'].count + sum.byCauseFrom['NG理由の代用'].count + sum.byCauseFrom['原因不明'].count, sum.count);
  assert.equal(sum.byCauseFrom['NG理由の代用'].seconds, 111);
});

test('R12 空っぽ・壊れたデータでも落ちない', () => {
  assert.deepEqual(reworkRows({}), []);
  assert.deepEqual(reworkRows({ lots: null, templates: null }), []);
  assert.deepEqual(reworkRows({ lots: [null, {}, { tasks: { a: null } }, { tasks: { b: { reworks: 'x' } } }] }), []);
  const sum = reworkSummary([]);
  assert.equal(sum.count, 0);
  assert.equal(sum.seconds, 0);
  assert.equal(sum.hours, 0);
  assert.deepEqual(byCause([], { kindOf: () => '' }), []);
  assert.deepEqual(byCauseModelTemplate([]), []);
  assert.equal(byRound([]).length, 4);
  assert.equal(byRound([]).reduce((a, r) => a + r.seconds, 0), 0);
});

// ⚠NG理由は人が自由に打てる (作業画面の入力欄)。誰かが理由に「原因不明」と打っても、
//   本物の原因不明 (理由が1つも引けなかった行) と同じ束に混ざってはいけない。
//   混ざると、先に入った方の札で束全体の扱いが決まってしまい、
//   本物の原因不明に種別が付いて別枠から出てしまう = 元データに無い話になる。
const collisionLots = (freeTextFirst) => {
  const free = { 's0-0': { reworks: [{ round: 1, duration: 100, reason: '原因不明' }] } };     // 人が打った文字
  const real = { 's0-1': { reworks: [{ round: 2, duration: 9000 }] } };                        // 引けなかった本物
  return [mkLot({ tasks: freeTextFirst ? { ...free, ...real } : { ...real, ...free } })];
};

test('R14 理由に「原因不明」と打たれても、本物の原因不明と同じ束にしない (byCause)', () => {
  for (const freeTextFirst of [true, false]) { // 先に入った方で結果が変わらないこと
    const rows = reworkRows({ lots: collisionLots(freeTextFirst), templates: TEMPLATES });
    assert.equal(rows.length, 2);
    const res = byCause(rows, { kindOf: () => '作業' });
    assert.equal(res.length, 2, `別々の束にならなかった (freeTextFirst=${freeTextFirst})`);

    const typed = res[0];   // 人が打った方。時間は短いが原因が引けているので普通に並ぶ
    const real = res[1];    // 本物の原因不明。時間が長くても必ず最後の別枠
    assert.equal(typed.cause, '原因不明');
    assert.equal(typed.unknown, false);
    assert.equal(typed.kind, '作業');   // 打たれた理由には種別が付いてよい
    assert.equal(typed.count, 1);
    assert.equal(typed.seconds, 100);

    assert.equal(real.cause, '原因不明');
    assert.equal(real.unknown, true);
    assert.equal(real.kind, '未分類');  // ⚠本物に種別を付けたら作り話になる
    assert.equal(real.count, 1);
    assert.equal(real.seconds, 9000);

    // 文字は同じでも束のキーは別物 (画面はこのキーで内訳を突き合わせる)
    assert.notEqual(typed.key, real.key);
    // 合計は合ったまま
    assert.equal(res.reduce((a, r) => a + r.seconds, 0), 9100);
  }
});

test('R14b 理由に「原因不明」と打たれても別の束 (byCauseModelTemplate も同じ)', () => {
  for (const freeTextFirst of [true, false]) {
    const rows = reworkRows({ lots: collisionLots(freeTextFirst), templates: TEMPLATES });
    const res = byCauseModelTemplate(rows);
    assert.equal(res.length, 2, `内訳が1行に潰れた (freeTextFirst=${freeTextFirst})`);
    assert.equal(res[0].unknown, false);
    assert.equal(res[0].seconds, 100);
    assert.equal(res[1].unknown, true);   // 本物は最後
    assert.equal(res[1].seconds, 9000);
    assert.notEqual(res[0].causeKey, res[1].causeKey);
    // 原因別の束と内訳の束は同じキーでつながる
    const causes = byCause(rows, { kindOf: () => '作業' });
    assert.deepEqual(res.map(d => d.causeKey).sort(), causes.map(c => c.key).sort());
  }
});

test('R13 時間(h)は秒から計算するだけ。丸めた値を合計に使わない', () => {
  const lot = mkLot({ tasks: { 's0-0': { reworks: [{ round: 1, duration: 3600, reason: 'A' }, { round: 2, duration: 1800, reason: 'A' }] } } });
  const sum = reworkSummary(reworkRows({ lots: [lot], templates: TEMPLATES }));
  assert.equal(sum.seconds, 5400);
  assert.equal(sum.hours, 1.5);
});

// ---------------------------------------------------------------------------
// 🎓 教育中(新人)の再作業 (2026-08-08)
//   練習中のやり直しを「この原因は◯時間かかっている」に混ぜると、対策の的がずれる。
//   → 時間の集計からは外す。ただし **件数と時間は必ず別掲で返す**(黙って捨てない)。

const traineeLot = () => mkLot({
  tasks: {
    's0-0': { ngReason: 'バックラッシュ大', reworks: [{ round: 1, duration: 600, endTime: D('2026-08-01T10:00:00'), reason: 'バックラッシュ大' }] },
    // 同じ原因を、教育中の人がやり直した記録
    's0-1': { trainee: true, ngReason: 'バックラッシュ大', reworks: [{ round: 1, duration: 3000, endTime: D('2026-08-01T11:00:00'), reason: 'バックラッシュ大' }] },
  },
});

test('R-T1 rows には trainee がそのまま乗る (行自体は捨てない)', () => {
  const rows = reworkRows({ lots: [traineeLot()], templates: TEMPLATES });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.trainee), [false, true]);
});

test('R-T2 原因別・型式別・回別の時間から教育中が外れる (既定)', () => {
  const rows = reworkRows({ lots: [traineeLot()], templates: TEMPLATES });
  const causes = byCause(rows);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].count, 1, '教育中の1件は入らない');
  assert.equal(causes[0].seconds, 600, '3000秒(練習分)は混ざらない');
  assert.equal(byCauseModelTemplate(rows)[0].seconds, 600);
  assert.equal(byRound(rows)[0].seconds, 600);
});

test('R-T3 summary は合計から外したうえで「教育中 N件/X時間」を必ず返す', () => {
  const rows = reworkRows({ lots: [traineeLot()], templates: TEMPLATES });
  const s = reworkSummary(rows);
  assert.equal(s.count, 1);
  assert.equal(s.seconds, 600);
  assert.equal(s.traineeCount, 1, '件数を黙って捨てない');
  assert.equal(s.traineeSeconds, 3000, '時間も黙って捨てない');
});

test('R-T4 合計 = 回別 = 原因別 = 原因×型式×テンプレ の一致は教育中を外しても崩れない', () => {
  const rows = reworkRows({ lots: [traineeLot()], templates: TEMPLATES });
  const s = reworkSummary(rows);
  const sumOf = (arr) => arr.reduce((a, x) => a + x.seconds, 0);
  const cntOf = (arr) => arr.reduce((a, x) => a + x.count, 0);
  assert.equal(sumOf(byCause(rows)), s.seconds);
  assert.equal(sumOf(byCauseModelTemplate(rows)), s.seconds);
  assert.equal(sumOf(byRound(rows)), s.seconds);
  assert.equal(cntOf(byCause(rows)), s.count);
  assert.equal(cntOf(byRound(rows)), s.count);
});

test('R-T5 traineeMode:only / all で切り替えられる (伸び画面・実費用)', () => {
  const rows = reworkRows({ lots: [traineeLot()], templates: TEMPLATES });
  assert.equal(byCause(rows, { traineeMode: 'only' })[0].seconds, 3000);
  assert.equal(byCause(rows, { traineeMode: 'all' })[0].seconds, 3600);
  assert.equal(reworkSummary(rows, { traineeMode: 'all' }).count, 2);
  assert.equal(reworkSummary(rows, { traineeMode: 'all' }).traineeCount, 0, 'all の時は別掲しない(合計に入っているため)');
});
