// 🚶 掛け持ち案内の計算。⚠仮定の数字を事実のように出さない・他の人のロットを出さない・先の工程を先取りさせない・終わりの時刻を遡らせる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkSecOf, minTripWorkSecOf, autoLimitSecOf, planUntilKugiri, juggleCandidates, autoCatchUp, manualRunningOn } from '../juggleGuide.js';
import { isAutoStep } from '../workExecution.js';

const isAuto = (s) => isAutoStep(s);
const ZONES = [
  { id: 'zone_inter_1', name: '中間分割1' }, { id: 'zone_inter_2', name: '中間分割2' }, { id: 'zone_comp_v1', name: '完品分割縦1' },
  { id: 'zone_3d', name: '三次元測定エリア' }, { id: 'zone_assembly_1', name: '第一組立エリア_1' }, { id: 'zone_assembly_3', name: '第三組立エリア' },
];
const PREP_LOT = { id: 'p0', title: '準備', executionMode: 'manual', lotOnce: true, targetTime: 120 };
const MPREP = { id: 's1', title: '測定準備', executionMode: 'manual', targetTime: 180 };
const AUTO = { id: 'a1', title: '分割自動測定開始', executionMode: 'batch', autoEndEnabled: true, autoEndSec: 360, workResource: 'measurement-machine' };
const CLEAN = { id: 's2', title: '片付け', executionMode: 'manual', targetTime: 90 };
const FINAL = { id: 'f0', title: '最終片付け', executionMode: 'manual', lotOnce: true, targetTime: 60 };
const lot = (id, over = {}) => ({ id, status: 'processing', quantity: 2, orderNo: `No.${id}`, model: 'RTT', mapZoneId: 'zone_inter_2', workerId: 'wA', steps: [PREP_LOT, MPREP, AUTO, CLEAN, FINAL], tasks: {}, ...over });
const CUR = lot('CUR', { mapZoneId: 'zone_inter_1', tasks: { 'a1-0': { status: 'processing', startTime: 1000 } } });

test('片道: 表(分)が最優先 → 同じ区画は0秒 → 名前の目安(10秒/30秒) → 分からなければ null', () => {
  assert.deepEqual(walkSecOf({ a: 'zone_inter_1', b: 'zone_inter_2', zones: ZONES, travel: { override: { 'zone_inter_1|zone_inter_2': 0.25 } } }).sec, 15);
  assert.equal(walkSecOf({ a: 'zone_inter_1', b: 'zone_inter_1', zones: ZONES }).sec, 0);
  assert.equal(walkSecOf({ a: 'zone_inter_1', b: 'zone_comp_v1', zones: ZONES }).sec, 10, '中間 ↔ 完品 は10秒');
  assert.equal(walkSecOf({ a: 'zone_3d', b: 'zone_inter_2', zones: ZONES }).sec, 30, '三次元 ↔ 中間 は30秒');
  assert.equal(walkSecOf({ a: 'zone_comp_v1', b: 'zone_assembly_1', zones: ZONES }).sec, 30, '第一組立 ↔ 完品 は30秒');
  const unk = walkSecOf({ a: 'zone_assembly_1', b: 'zone_3d', zones: ZONES });
  assert.equal(unk.sec, null, '第一組立 ↔ 三次元 は聞いていない → 0秒と決めつけない');
  assert.equal(walkSecOf({ a: 'zone_assembly_3', b: 'zone_inter_1', zones: ZONES }).sec, null, '第三組立は聞いていない');
  assert.equal(walkSecOf({ a: 'zone_inter_1', b: 'zone_3d', zones: ZONES, travel: { override: { 'zone_3d|zone_inter_1': null } } }).sec, 30, '消した印(null)は無いのと同じで名前の目安へ');
});

test('行く価値がある最低の手作業: 既定2分・設定で変えられる・変な値は既定', () => {
  assert.equal(minTripWorkSecOf(null), 120);
  assert.equal(minTripWorkSecOf({ minTripWorkMin: 0.5 }), 30);
  assert.equal(minTripWorkSecOf({ minTripWorkMin: 0 }), 0);
  assert.equal(minTripWorkSecOf({ minTripWorkMin: 'x' }), 120);
  assert.equal(minTripWorkSecOf({ minTripWorkMin: -1 }), 120);
});

test('自動の残りの目安: 自動終了の秒 → テンプレの同一工程 → 目標時間 → 不明', () => {
  assert.equal(autoLimitSecOf(AUTO), 360);
  assert.equal(autoLimitSecOf({ id: 'a1', title: '分割自動測定開始', executionMode: 'batch' }, [AUTO]), 360, 'テンプレへ落ちる');
  assert.equal(autoLimitSecOf({ id: 'zz', title: '分割自動測定開始', executionMode: 'batch' }, [AUTO]), 360, '題名一致でも落ちる');
  assert.equal(autoLimitSecOf({ id: 'a2', title: '回転自動測定開始', executionMode: 'batch', targetTime: 1500 }), 1500);
  assert.equal(autoLimitSecOf({ id: 'a3', title: '回転自動測定開始', executionMode: 'batch' }), null);
});

test('区切りまでの計画: 先頭のロット1回 → 台ごとに自動の手前まで → 次の自動が区切り。先の工程を先取りしない', () => {
  const B = lot('B', { tasks: { 'p0-lot-0': { status: 'completed' }, 's1-0': { status: 'completed' }, 'a1-0': { status: 'completed' } } });
  const p = planUntilKugiri({ lot: B, isAuto });
  assert.deepEqual(p.items.map((i) => `${i.stepTitle}#${i.unitIdx}`), ['片付け#0', '測定準備#1']);
  assert.deepEqual(p.kugiri, { unitIdx: 1, stepTitle: '分割自動測定開始' });
  assert.equal(p.secToKugiri, 90 + 180);
  assert.equal(p.measuredBefore, true);
});

test('区切りまでの計画: 新しいロットは 準備(ロット1回) から。最終片付けは全台の自動が済むまで出さない', () => {
  const p = planUntilKugiri({ lot: lot('N'), isAuto });
  assert.deepEqual(p.items.map((i) => `${i.stepTitle}#${i.unitIdx}`), ['準備#null', '測定準備#0', '測定準備#1']);
  assert.deepEqual(p.kugiri, { unitIdx: 0, stepTitle: '分割自動測定開始' });
  assert.equal(p.measuredBefore, false);
  const done = lot('D', { tasks: { 'p0-lot-0': { status: 'completed' }, 's1-0': { status: 'completed' }, 's1-1': { status: 'completed' }, 'a1-0': { status: 'completed' }, 'a1-1': { status: 'completed' }, 's2-0': { status: 'completed' } } });
  const q = planUntilKugiri({ lot: done, isAuto });
  assert.deepEqual(q.items.map((i) => `${i.stepTitle}#${i.unitIdx}`), ['片付け#1', '最終片付け#null']);
  assert.equal(q.kugiri, null);
});

test('区切りまでの計画: 機械に載っている台(自動が processing / ng / reworking)と 誰かが手作業中の台は飛ばす', () => {
  const B = lot('B', { tasks: { 'p0-lot-0': { status: 'completed' }, 's1-0': { status: 'completed' }, 'a1-0': { status: 'ng' }, 's1-1': { status: 'processing', startTime: 5 } } });
  const p = planUntilKugiri({ lot: B, isAuto });
  assert.deepEqual(p.items, [], 'NG再測定待ちの台の片付けも、他人が触っている台も出さない');
  const C = lot('C', { tasks: { 'p0-lot-0': { status: 'completed' }, 's1-0': { status: 'completed' }, 'a1-0': { status: 'processing', startTime: 5 } } });
  assert.deepEqual(planUntilKugiri({ lot: C, isAuto }).items.map((i) => `${i.stepTitle}#${i.unitIdx}`), ['測定準備#1'], '自分の別ロットの機械が回っていても 次の台の段取りはできる');
});

test('候補: 入荷待ち・完了・他の人の担当・誰かが手作業中 は出さない。担当なし と 自分の担当 は出す', () => {
  const lots = [CUR,
    lot('ARR', { location: 'arrival', workerId: null }),
    lot('DONE', { status: 'completed' }),
    lot('OTHER', { workerId: 'wB' }),
    lot('BUSY', { tasks: { 's1-0': { status: 'processing', startTime: 5 } } }),
    lot('FREE', { workerId: null }),
    lot('MINE'),
  ];
  const r = juggleCandidates({ lots, currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 300, zones: ZONES, isAuto, maxItems: 9 });
  assert.deepEqual(r.map((c) => c.lotId), ['MINE', 'FREE'], '自分の担当が先・担当なしが次');
  assert.equal(manualRunningOn(lots[4], isAuto), true);
  assert.equal(manualRunningOn(CUR, isAuto), false, '自動だけなら「触っている」ではない');
});

test('候補: フリー・管理者(担当なし)で見ている時は 担当で絞らない', () => {
  const r = juggleCandidates({ lots: [CUR, lot('OTHER', { workerId: 'wB' })], currentLot: CUR, me: { workerId: null }, remainingSec: 300, zones: ZONES, isAuto });
  assert.equal(r.length, 1);
});

test('候補: 使える時間 = 残り − 片道×2。2分の決まりに届かなければ go=false・片道が不明なら go=null(0秒と決めつけない)', () => {
  const B = lot('B', { mapZoneId: 'zone_3d' });   // 中間1 ↔ 三次元 = 30秒
  const [c] = juggleCandidates({ lots: [CUR, B], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 300, zones: ZONES, isAuto });
  assert.equal(c.walkSec, 30); assert.equal(c.availableSec, 240); assert.equal(c.go, true);
  assert.equal(c.fitsCount, 1, '準備120 は入る・測定準備180 を足すと 300>240');
  assert.deepEqual(c.kugiri, { unitIdx: 0, stepTitle: '分割自動測定開始' }); assert.equal(c.reachKugiri, false);
  const [d] = juggleCandidates({ lots: [CUR, B], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 150, zones: ZONES, isAuto });
  assert.equal(d.availableSec, 90); assert.equal(d.go, false, '90秒 < 2分');
  const [e] = juggleCandidates({ lots: [CUR, B], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 150, zones: ZONES, isAuto, travel: { minTripWorkMin: 1 } });
  assert.equal(e.go, true, '決まりを1分にすれば行ける');
  const [f] = juggleCandidates({ lots: [CUR, lot('U', { mapZoneId: 'zone_assembly_3' })], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 300, zones: ZONES, isAuto });
  assert.equal(f.walkSec, null); assert.equal(f.go, null); assert.equal(f.availableSec, null);
  const [g] = juggleCandidates({ lots: [CUR, B], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: null, zones: ZONES, isAuto });
  assert.equal(g.go, null, '残りが不明なら決めつけない');
});

test('候補の並び: 行ける → 自分の担当 → 測定済みで進行中(交互に回している相手) → 片道が短い', () => {
  const inProg = lot('P', { mapZoneId: 'zone_3d', tasks: { 'p0-lot-0': { status: 'completed' }, 's1-0': { status: 'completed' }, 'a1-0': { status: 'completed' } } });
  const fresh = lot('F', { mapZoneId: 'zone_inter_2' });
  const far = lot('X', { mapZoneId: 'zone_inter_2', workerId: null, steps: [PREP_LOT, { ...MPREP, targetTime: 1200 }, AUTO, CLEAN] });
  const r = juggleCandidates({ lots: [CUR, fresh, inProg, far], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 360, zones: ZONES, isAuto });
  assert.deepEqual(r.map((c) => c.lotId), ['P', 'F', 'X'], '進行中の P(30秒先)が 新しい F(10秒先)より先。X は準備120秒だけ入る');
});

test('自動終了の後追い: 終わりは 開始+自動終了の秒(気づいた時刻ではない)。まだなら触らない。完了ロットは触らない', () => {
  const start = 1_700_000_000_000;
  const L = lot('L', { tasks: { 'a1-0': { status: 'processing', startTime: start, duration: 0 }, 'a1-1': { status: 'processing', startTime: start + 200_000 } } });
  const r = autoCatchUp({ lot: L, now: start + 1_000_000, isAuto, inspectorName: 'A' });
  assert.equal(r.ended.length, 2);
  assert.equal(r.tasks['a1-0'].endTime, start + 360_000, '遡る');
  assert.equal(r.tasks['a1-0'].duration, 360); assert.equal(r.tasks['a1-0'].status, 'completed'); assert.equal(r.tasks['a1-0'].startTime, null);
  assert.equal(r.tasks['a1-0'].autoEnded, true); assert.equal(r.tasks['a1-0'].workerName, 'A'); assert.equal(r.tasks['a1-0'].firstStartTime, start);
  assert.equal(r.tasks['a1-1'].endTime, start + 560_000);
  assert.equal(r.earliestEnd, start + 360_000);
  assert.equal(autoCatchUp({ lot: L, now: start + 100_000, isAuto }).tasks, null, 'まだ');
  assert.equal(autoCatchUp({ lot: { ...L, status: 'completed' }, now: start + 1_000_000, isAuto }).tasks, null);
  const legacy = lot('G', { steps: [MPREP, { id: '', title: '分割自動測定開始', executionMode: 'batch', autoEndEnabled: true, autoEndSec: 60 }], tasks: { '1-0': { status: 'processing', startTime: start } } });
  assert.equal(autoCatchUp({ lot: legacy, now: start + 70_000, isAuto }).tasks['1-0'].endTime, start + 60_000, '古い鍵(番号)でも');
  const once = lot('O', { steps: [{ id: 'k1', title: '校正自動測定開始', executionMode: 'batch', autoEndEnabled: true, autoEndSec: 900, lotOnce: true }], tasks: { 'k1-lot-0': { status: 'processing', startTime: start } } });
  assert.equal(autoCatchUp({ lot: once, now: start + 1_000_000, isAuto }).tasks['k1-lot-0'].endTime, start + 900_000, 'ロット1回の鍵でも');
});

test('U16 ChatGPT の確認(09-26): 自動が無いロットの ロット1回工程を二重に載せない', () => {
  const p = planUntilKugiri({ lot: { id: 'X', quantity: 1, steps: [{ id: 'prep', title: '準備', lotOnce: true, targetTime: 120, executionMode: 'manual' }], tasks: {} }, isAuto });
  assert.deepEqual(p.items.map((i) => i.stepTitle), ['準備']);
});

test('U17 ChatGPT の確認(09-26): 目標が未設定の工程は 60秒と決めつけず、区切りまでの時間は「出せない」', () => {
  const p = planUntilKugiri({ lot: { id: 'Y', quantity: 1, steps: [{ id: 'm', title: '手作業', executionMode: 'manual' }, { id: 'a', title: '分割自動測定開始', executionMode: 'batch' }], tasks: {} }, isAuto });
  assert.equal(p.items[0].targetSec, null); assert.equal(p.secToKugiri, null);
  const [c] = juggleCandidates({ lots: [CUR, { id: 'Y', quantity: 1, mapZoneId: 'zone_inter_2', workerId: 'wA', steps: [{ id: 'm', title: '手作業', executionMode: 'manual' }, AUTO], tasks: {} }], currentLot: CUR, me: { workerId: 'wA' }, remainingSec: 300, zones: ZONES, isAuto });
  assert.equal(c.reachKugiri, null); assert.equal(c.fitsCount, 0); assert.equal(c.planUnknown, true);
});

test('U18 ChatGPT の確認(09-26): 手作業の修正中(止めていない)は「触っている」= 候補に出さない(開始ガードと同じ見方)', () => {
  const L = lot('R', { tasks: { 's1-0': { status: 'reworking', reworkStartTime: 10 } } });
  assert.equal(manualRunningOn(L, isAuto), true);
  assert.equal(manualRunningOn(lot('P', { tasks: { 's1-0': { status: 'reworking', reworkStartTime: 10, reworkPausedAt: 20 } } }), isAuto), false, '止めた修正は触っていない');
  assert.equal(manualRunningOn(lot('A', { tasks: { 'a1-0': { status: 'reworking', reworkStartTime: 10 } } }), isAuto), false, '自動工程の再測定は機械が回っているだけ');
});
