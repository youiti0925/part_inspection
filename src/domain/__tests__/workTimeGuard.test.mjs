// ⏱🚨 作業時間が保存で消えないことの試験。
//
// ⚠⚠ ここに書いてある形は **想像ではなく、本番で実際に起きた形**(2026-08-17)。
//   本番 final-inspection-v1 の指図1001456630 ほか5ロットで tasks が空のマップになり、
//   8/12 に測った時間が全部消えた。
//
// ⚠ 上の調べで「合わない」と落ちた形(テンプレ再焼付・多端末の後勝ち)も、
//   将来の別ルート用に **試験としては残す**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workTimeOf, hasWorkTime, hasRecoverableMark, stepIdOfTaskKey, deletedTaskKeysOf,
  mergeTasksLikeFirestore, durationByStep, wouldLoseWorkTime, orphanedByStepRekey,
  describeLoss, assertSafeLotSave, EMPTY_MAP_REPLACES_ON_MERGE, LOSS_LEVEL,
  blankTasksRisk, assertLotsLoaded, isDeleteSentinel, LOTS_NOT_LOADED_MSG,
} from '../workTimeGuard.js';

/** 「このキーを消す」印(src/data/sentinels.js の DATA_DELETE と同じ形)。 */
const DEL = Object.freeze({ __dataSentinel: 'delete' });

// ---------------------------------------------------------------------------
// 現物に合わせた土台。
//   指図1001456630 の実データ: quantity=4 / steps 60件 /
//   別置き画像の label が `4d8a01360c14-0` 〜 `-3` = **タスクの鍵そのもの**。
//   その工程 `4d8a01360c14` は今も steps に在る(=工程の作り直しではない)。
// ---------------------------------------------------------------------------
const STEP_A = '4d8a01360c14';   // 外観チェック項目/指図・型式・機番の確認
const STEP_B = '68c8c1de0cd5';   // フレーム底面の確認
const T = (o = {}) => ({ status: 'completed', duration: 0, ...o });

/** 8/12 17:05 に着手して測り終えた 1ロットぶん。 */
const LOT_8_12 = () => ({
  id: '1818d302f1f3', orderNo: '1001456630', quantity: 4,
  firstWorkStartTime: 1786521953241,
  steps: [{ id: STEP_A, category: '外観チェック項目', title: '指図・型式・機番の確認' },
          { id: STEP_B, category: '外観チェック項目', title: 'フレーム底面の確認' }],
  tasks: {
    [`${STEP_A}-0`]: T({ duration: 125, firstStartTime: 1786521953241, endTime: 1786522078241, workerName: '平野' }),
    [`${STEP_A}-1`]: T({ duration: 179, firstStartTime: 1786522100000, endTime: 1786522279000, workerName: '平野' }),
    [`${STEP_A}-2`]: T({ duration: 140, firstStartTime: 1786522300000, endTime: 1786522440000, workerName: '平野' }),
    [`${STEP_A}-3`]: T({ duration: 160, firstStartTime: 1786522500000, endTime: 1786522660000, workerName: '平野' }),
    [`${STEP_B}-0`]: T({ duration: 259, firstStartTime: 1786523000000, endTime: 1786523259000, workerName: '平野' }),
  },
});

// ===========================================================================
// 1. 部品の試験
// ===========================================================================
test('W01 startTime は「時間」に数えない(時計を止めただけを事故と呼ばない)', () => {
  // 計測中: startTime だけ在って duration は 0
  assert.equal(hasWorkTime({ status: 'processing', startTime: 111, duration: 0 }), true, '着手していれば時間を持つ扱い');
  const w = workTimeOf({ status: 'processing', startTime: 111, duration: 0 });
  assert.equal(w.duration, 0);
  assert.equal(w.firstStartTime, 0, 'startTime を firstStartTime と混同しない');
  assert.equal(hasWorkTime({ status: 'waiting', duration: 0 }), false, '手つかずは時間を持たない');
  assert.equal(hasWorkTime(null), false);
  assert.equal(hasWorkTime({ status: 'waiting', duration: 0, firstStartTime: 999 }), true,
    '⚠seedItemGuard.hasAnyRecord が見落とす形(waiting+0秒だが着手時刻あり)もここでは記録扱い');
});

test('W02 Timestamp / 数値 / 文字列 のどれで来ても時刻として読む', () => {
  assert.equal(workTimeOf({ firstStartTime: { seconds: 100 } }).firstStartTime, 100000);
  assert.equal(workTimeOf({ firstStartTime: '2026-08-12T08:05:53.241Z' }).firstStartTime, 1786521953241);
  assert.equal(workTimeOf({ firstStartTime: 'ちがう' }).firstStartTime, 0);
});

test('W03 task の鍵から工程の身元を採る(-lot- の形も)', () => {
  assert.equal(stepIdOfTaskKey(`${STEP_A}-3`), STEP_A);
  assert.equal(stepIdOfTaskKey(`${STEP_A}-lot-2`), STEP_A);
  assert.equal(stepIdOfTaskKey('abc'), 'abc');
});

test('W04 消したキーの印は2通りの書き方どちらでも読む', () => {
  assert.deepEqual([...deletedTaskKeysOf({ __deleteMapKeys: { tasks: ['a-0', 'a-1'] } })], ['a-0', 'a-1']);
  assert.deepEqual([...deletedTaskKeysOf({ __deleteMapKeys: [['tasks', 'a-0']] })], ['a-0'],
    '⚠配列の形を弾くと「名指しの削除」が見えなくなる');
  assert.deepEqual([...deletedTaskKeysOf({ __deleteMapKeys: [['tasks', 'a-0', 'inputs', 'x']] })], [],
    '入力値1個の削除では task 自体は消えない');
  assert.deepEqual([...deletedTaskKeysOf({})], []);
});

// ===========================================================================
// 2. 🚨 merge:true の本当の意味(この前提の間違いが本番を壊した)
// ===========================================================================
test('W10 🚨🚨 空のマップを merge:true で送ると tasks は丸ごと空になる', () => {
  assert.equal(EMPTY_MAP_REPLACES_ON_MERGE, true,
    'node_modules/@firebase/firestore/dist/common-091f2944.esm.js:20701-20706 の実装がそうなっている');
  const before = LOT_8_12().tasks;
  const after = mergeTasksLikeFirestore(before, { tasks: {} });
  assert.deepEqual(after, {}, '🚨 これが 2026-08-17 に本番で起きた事');
});

test('W11 送らなかったキーは残る / 送った鍵は再帰マージ', () => {
  const before = LOT_8_12().tasks;
  const after = mergeTasksLikeFirestore(before, { tasks: { [`${STEP_A}-0`]: { duration: 300 } } });
  assert.equal(Object.keys(after).length, 5, '他の4件は残る');
  assert.equal(after[`${STEP_A}-0`].duration, 300);
  assert.equal(after[`${STEP_A}-0`].firstStartTime, 1786521953241, '送らなかった中身は残る(再帰マージ)');
});

test('W12 tasks そのものを送らなければ何も変わらない', () => {
  const before = LOT_8_12().tasks;
  assert.deepEqual(mergeTasksLikeFirestore(before, { mapZoneId: 'zone_touchup' }), before);
});

test('W13 merge:false は doc ごと置き換え(tasks を書かなければ全部消える)', () => {
  const before = LOT_8_12().tasks;
  assert.deepEqual(mergeTasksLikeFirestore(before, { status: 'paused' }, { merge: false }), {});
});

test('W14 1件だけ空のマップにしても、その task は空になる', () => {
  const before = LOT_8_12().tasks;
  const after = mergeTasksLikeFirestore(before, { tasks: { [`${STEP_A}-0`]: {} } });
  assert.deepEqual(after[`${STEP_A}-0`], {});
  assert.equal(Object.keys(after).length, 5);
});

// ===========================================================================
// 3. 🚨 実際に起きた形を再現する
// ===========================================================================
test('X01 🚨🚨【本番で起きた形】tasks を丸ごと入れ替えて時間を引き継がない', () => {
  // 検査画面が手元の空の state をそのまま送る = タッチアップ移動 / 完了確定 の経路
  const res = wouldLoseWorkTime(LOT_8_12(), {
    location: 'zone_touchup', mapZoneId: 'zone_touchup', status: 'paused',
    lastPausedAt: 1786928556789, tasks: {},
  });
  assert.equal(res.lost, true);
  assert.equal(res.level, 'wipe', '一番重い印が付く');
  assert.equal(res.counts.beforeWithTime, 5);
  assert.equal(res.counts.afterWithTime, 0);
  assert.equal(res.lostKeys.length, 5, '5件とも名指しで出る');
  assert.equal(res.lostSec, 863, '125+179+140+160+259');
  assert.match(describeLoss(res, LOT_8_12()), /1001456630/, '指図で名指しする');
});

test('X02 🚨【本番で起きた形】完了確定でも同じ穴が開く(完了なのに0件)', () => {
  // 指図1001554506 / 1001574478: 荷姿写真も撮影時間も残っているのに検査タスクは0件
  const res = wouldLoseWorkTime(LOT_8_12(), {
    status: 'completed', location: 'completed', mapZoneId: null,
    completedAt: 1786944462000, tasks: {},
  });
  assert.equal(res.level, 'wipe');
});

test('X03 merge:true で一部だけ書いても、他は消えない(=これは事故ではない)', () => {
  const res = wouldLoseWorkTime(LOT_8_12(), { tasks: { [`${STEP_B}-0`]: { duration: 300 } } });
  assert.equal(res.lost, false, '他の4件は残るので失っていない');
});

test('X04 🚨管理者パネルが duration を 0 にする(控えの印が無い)', () => {
  const res = wouldLoseWorkTime(LOT_8_12(), {
    tasks: { [`${STEP_B}-0`]: { duration: 0 } },
  });
  assert.equal(res.lost, true);
  assert.equal(res.level, 'shrink');
  assert.equal(res.lostSec, 259);
});

test('X05 🚨テンプレ再焼付で steps の id が変わると tasks の鍵が迷子になる', () => {
  const lot = LOT_8_12();
  const rebuilt = [{ id: 'NEW_a', category: '外観チェック項目', title: '指図・型式・機番の確認' },
                   { id: 'NEW_b', category: '外観チェック項目', title: 'フレーム底面の確認' }];
  const orphans = orphanedByStepRekey(lot, rebuilt);
  assert.equal(orphans.length, 5, '5件とも工程に繋がらなくなる');
  assert.equal(orphans.reduce((a, x) => a + x.duration, 0), 863);
  // ⚠ steps を作り直しても tasks を触らなければ Firestore 上は残る。
  //   「消える」のではなく「画面から見えなくなる」形。だから別の関数で見張る。
  assert.equal(wouldLoseWorkTime(lot, { steps: rebuilt }).lost, false,
    '⚠実データではこの形ではなかった(工程idは今も残っていた)。将来の別ルート用に残す');
});

test('X06 🚨多端末の後勝ち: 相手が足した分を握ったままの古いコピーで書き戻す', () => {
  const server = LOT_8_12();
  server.tasks['NEWSTEP-0'] = T({ duration: 88, firstStartTime: 1786530000000, endTime: 1786530088000 });
  // 別端末が「開いた瞬間のコピー」(NEWSTEP を知らない)を丸ごと書き戻す
  const stale = LOT_8_12().tasks;
  const res = wouldLoseWorkTime(server, { tasks: stale });
  // ⚠merge:true なので **鍵は消えない**。後勝ちで消えるのは「丸ごと置き換え」の時だけ。
  assert.equal(res.lost, false, 'merge:true では相手の新しい鍵は残る');
  const res2 = wouldLoseWorkTime(server, { tasks: stale }, { merge: false });
  assert.equal(res2.lost, true, '⚠merge:false(丸ごと置き換え)に変えた瞬間、後勝ちで消える');
  assert.equal(res2.lostKeys[0].key, 'NEWSTEP-0');
});

test('X07 🚨名指しで消しても、記録がある task なら止める', () => {
  // seedItemGuard の守り(hasAnyRecord)は firstStartTime を見ていない。
  // waiting + 0秒 + 着手時刻あり の task は、あの守りをすり抜けて消される。
  const lot = LOT_8_12();
  lot.tasks['GHOST-0'] = { status: 'waiting', duration: 0, firstStartTime: 1786521000000 };
  const res = wouldLoseWorkTime(lot, { steps: lot.steps, tasks: lot.tasks, __deleteMapKeys: { tasks: ['GHOST-0'] } });
  assert.equal(res.lost, true);
  assert.equal(res.level, 'drop');
  assert.match(res.lostKeys[0].what, /名指しで消された/);
});

// ===========================================================================
// 4. ⚠正しい書き換えは通す(ここが線引き。緩めたら見張りが死ぬ)
// ===========================================================================
test('Y01 時間が増える・項目が増えるのは当然通す', () => {
  const lot = LOT_8_12();
  const t = { ...lot.tasks };
  t[`${STEP_B}-1`] = T({ duration: 200, firstStartTime: 1786524000000, endTime: 1786524200000 });
  t[`${STEP_A}-0`] = { ...t[`${STEP_A}-0`], duration: 300 };
  assert.equal(wouldLoseWorkTime(lot, { tasks: t }).lost, false);
});

test('Y02 計測中の時計を止める(startTime が消えて duration に化ける)のは通す', () => {
  const lot = { ...LOT_8_12(), tasks: { [`${STEP_A}-0`]: { status: 'processing', startTime: 1000, duration: 0, firstStartTime: 1000 } } };
  const stopped = { [`${STEP_A}-0`]: { status: 'paused', startTime: null, duration: 300, firstStartTime: 1000, pausedAt: 1300 } };
  assert.equal(wouldLoseWorkTime(lot, { tasks: stopped }).lost, false, 'startTime を「失った時間」に数えない');
});

test('Y03 🔢員数/一括のもどし: 先頭に合計・他は0+印。工程ぐるみの合計が減らないので通す', () => {
  // 300秒を5台で60秒ずつに割ってしまった記録を、先頭300秒＋他0秒に戻す
  const tasks = {};
  for (let u = 0; u < 5; u++) tasks[`${STEP_A}-${u}`] = T({ duration: 60, firstStartTime: 5000, endTime: 5300 });
  const lot = { ...LOT_8_12(), tasks };
  const patch = {};
  for (let u = 0; u < 5; u++) {
    patch[`${STEP_A}-${u}`] = {
      duration: u === 0 ? 300 : 0,
      ...(u === 0 ? {} : { countCovered: true }),
      countMergeFix: { at: 1, before: 60, total: 300, units: 5, head: u === 0 },
    };
  }
  const res = wouldLoseWorkTime(lot, { tasks: patch });
  assert.equal(res.lost, false, '工程ごとの合計 300秒 → 300秒。減っていない');
  assert.equal(durationByStep(mergeTasksLikeFirestore(lot.tasks, { tasks: patch })).get(STEP_A), 300);
});

test('Y04 按分補正・手入力は「元の値を控える印」があるので通す', () => {
  const lot = LOT_8_12();
  const withOrig = wouldLoseWorkTime(lot, {
    tasks: { [`${STEP_B}-0`]: { duration: 52, origDuration: 259, batchDivisionCorrected: true } },
  });
  assert.equal(withOrig.lost, false, 'origDuration に元が残る＝取り消せる');
  const manual = wouldLoseWorkTime(lot, {
    tasks: { [`${STEP_B}-0`]: { duration: 30, manualTime: true } },
  });
  assert.equal(manual.lost, false, '人が画面で打ち直した');
  assert.equal(hasRecoverableMark({ origDuration: 0 }), true, '0秒でも「控えた」事実は残る');
  assert.equal(hasRecoverableMark({ manualTime: false }), false, '印が false なら控えていない');
});

test('Y05 記録が1つも無い task を名指しで消すのは通す(お手本の項目の掃除)', () => {
  const lot = LOT_8_12();
  lot.tasks['SEED-0'] = { status: 'waiting', duration: 0 };
  const res = wouldLoseWorkTime(lot, { steps: lot.steps, tasks: lot.tasks, __deleteMapKeys: { tasks: ['SEED-0'] } });
  assert.equal(res.lost, false);
});

test('Y06 元が空／前の姿を知らない時は判定しない(新規登録を止めない)', () => {
  assert.equal(wouldLoseWorkTime(null, { tasks: {} }).lost, false, '前の姿を知らない');
  assert.equal(wouldLoseWorkTime({ id: 'x', tasks: {} }, { tasks: {} }).lost, false, '元から空');
  assert.equal(wouldLoseWorkTime({ id: 'x' }, { tasks: {}, interruptions: [] }).lost, false, '新しいロットの登録');
});

test('Y07 完了確定の自動整理(残りを該当なしにする)は時間を落とさないので通す', () => {
  const lot = { ...LOT_8_12() };
  lot.tasks['LEFT-0'] = { status: 'paused', duration: 40, firstStartTime: 7000, startTime: null };
  const clean = { ...lot.tasks };
  clean['LEFT-0'] = { status: 'skipped', duration: 40, firstStartTime: 7000, endTime: 9000, startTime: null, skipReason: '該当なし (ロット完了時の自動整理)' };
  assert.equal(wouldLoseWorkTime(lot, { status: 'completed', tasks: clean }).lost, false);
});

// ===========================================================================
// 5. 止める側
// ===========================================================================
test('Z01 assertSafeLotSave は投げて止める(無言で return しない)', () => {
  const lot = LOT_8_12();
  let blocked = null;
  assert.throws(() => assertSafeLotSave(lot, { tasks: {} }, { onBlock: (r) => { blocked = r; } }),
    (e) => e.name === 'WorkTimeLossError' && /1001456630/.test(e.message));
  // ⚠空のマップは **前の姿と突き合わせる前** に止める(level='blank')。
  //   突き合わせの結果(level='wipe')より手前で弾くので、前の姿を知らない時でも止まる。
  assert.equal(blocked.level, 'blank');
  assert.equal(blocked.levelRank, LOSS_LEVEL.blank);
  assert.equal(blocked.counts.beforeWithTime, 5, '止めた時に「何を止めたか」を持って出る');
  assert.equal(blocked.lostSec, 863);
  assert.equal(wouldLoseWorkTime(lot, { tasks: {} }).level, 'wipe', '突き合わせの判定そのものは今までどおり');
  assert.equal(assertSafeLotSave(lot, { mapZoneId: 'z' }).lost, false, '普通の保存は素通し');
});

test('Z02 通してよい重さは呼ぶ側が明示する。既定では何も通さない', () => {
  const lot = LOT_8_12();
  assert.throws(() => assertSafeLotSave(lot, { tasks: { [`${STEP_B}-0`]: { duration: 0 } } }));
  assert.equal(assertSafeLotSave(lot, { tasks: { [`${STEP_B}-0`]: { duration: 0 } } }, { allow: 'shrink' }).lost, true,
    '通した時も lost:true は返す(記録は残せる)');
  assert.throws(() => assertSafeLotSave(lot, { tasks: {} }, { allow: 'shrink' }),
    '⚠丸ごと消えるのは shrink を許しても止める');
  assert.equal(LOSS_LEVEL.wipe > LOSS_LEVEL.drop, true);
});

// ===========================================================================
// 5.5 ⚠⚠ **現場の正しい操作を止めないこと**(ここが緩すぎても厳しすぎても現場が壊れる)
//   ⚠厳しすぎると「見張りが邪魔だから外せ」になる。だから **実際の画面の書き方そのまま**で試験する。
//   ⚠通す条件は1つだけ: **元の秒数と着手時刻を控えている**(redoReset)。控え無しでは通らない。
// ===========================================================================
const RESET_PATHS = [
  // 「最初から作業」(src/App.firebase.jsx handleTaskMenuAction 'restart')
  { name: '最初から作業', patch: (now, cur) => ({
    ...cur, status: 'processing', duration: 0, startTime: now, firstStartTime: now, endTime: undefined,
    redoReset: { at: now, why: 'restart', before: cur.duration, firstStartTime: cur.firstStartTime } }) },
  // 「該当なし」の解除(スキップ解除)。⚠firstStartTime も消える形
  { name: '該当なし解除', patch: (now, cur) => ({
    status: 'waiting', duration: 0, startTime: null, firstStartTime: null, endTime: null,
    redoReset: { at: now, why: 'unskip', before: cur.duration, firstStartTime: cur.firstStartTime } }) },
  // まとめて開始の開き直し(秒数リセットあり)
  { name: 'まとめて開き直し', patch: (now, cur) => ({
    ...cur, status: 'processing', startTime: now, firstStartTime: cur.firstStartTime, endTime: null, duration: 0,
    redoReset: { at: now, why: 'batch-restart', before: cur.duration, firstStartTime: cur.firstStartTime } }) },
  // 工程まるごとの記録消し(画面で「元に戻せません」と確認して押す)
  { name: '工程まるごとリセット', patch: (now, cur) => ({
    status: 'waiting', duration: 0,
    redoReset: { at: now, why: 'batch-reset', before: cur.duration, firstStartTime: cur.firstStartTime } }) },
  // 音声の「リセット」
  { name: '音声リセット', patch: (now, cur) => ({
    status: 'waiting', duration: 0,
    redoReset: { at: now, why: 'voice-reset', before: cur.duration, firstStartTime: cur.firstStartTime } }) },
];

test('Y10 ⚠⚠ 人が押す「やり直し」5通りは全部通す(控えの印が付いているから)', () => {
  for (const p of RESET_PATHS) {
    const lot = LOT_8_12();
    const cur = lot.tasks[`${STEP_B}-0`];
    const res = wouldLoseWorkTime(lot, { tasks: { [`${STEP_B}-0`]: p.patch(1786930000000, cur) } });
    assert.equal(res.lost, false, `🚨 ${p.name} が止められている。これでは現場が使えず、見張りごと外される`);
  }
});

test('Y11 🚨ただし「控えの印が無いやり直し」は止める(黙って秒数が消えるのと同じ)', () => {
  for (const p of RESET_PATHS) {
    const lot = LOT_8_12();
    const cur = lot.tasks[`${STEP_B}-0`];
    const t = p.patch(1786930000000, cur);
    delete t.redoReset;                                  // ⚠印だけ外す
    const res = wouldLoseWorkTime(lot, { tasks: { [`${STEP_B}-0`]: t } });
    assert.equal(res.lost, true, `${p.name}: 控えが無いなら止める`);
  }
});

test('Y12 控えの印には「元の秒数」が入っている(あとで戻せる)', () => {
  const cur = LOT_8_12().tasks[`${STEP_B}-0`];
  for (const p of RESET_PATHS) {
    const t = p.patch(1786930000000, cur);
    assert.equal(t.redoReset.before, 259, `${p.name}: 元の秒数を控えている`);
    assert.equal(t.redoReset.firstStartTime, 1786523000000, `${p.name}: 元の着手時刻を控えている`);
    assert.equal(hasRecoverableMark(t), true);
  }
});

test('Y13 ⚠特注仕様を外して「実績を初期化」を人が選んだ時だけ、記録のある削除を通す', () => {
  const lot = LOT_8_12();
  const patch = { steps: lot.steps, tasks: lot.tasks, __deleteMapKeys: { tasks: [`${STEP_B}-0`] } };
  assert.throws(() => assertSafeLotSave(lot, patch), '既定では止める');
  assert.equal(assertSafeLotSave(lot, patch, { allow: 'drop' }).lost, true, '人が選んだ時だけ通す(記録は残る)');
  // ⚠'drop' を許しても「tasks を空にする」は通らない(鍵が別)
  assert.throws(() => assertSafeLotSave(lot, { tasks: {} }, { allow: 'drop' }),
    (e) => e.detail.level === 'blank');
});

// ===========================================================================
// 6. 🚨🚨 **前の姿を知らなくても止める**(2026-08-17 の事故はここが空いていた)
//    ⚠ここが無いと、読めていない画面・消えた後の画面から もう一度消せる。
// ===========================================================================
test('Z10 🚨🚨 手元に前の姿が無くても、空の tasks は止める', () => {
  // 事故当日と同じ形: 購読が死んでいる/消えた直後 = 手元は何も知らない
  for (const before of [null, undefined, {}, { id: 'x' }, { id: 'x', tasks: {} }]) {
    assert.throws(() => assertSafeLotSave(before, { location: 'zone_touchup', status: 'paused', tasks: {} }),
      (e) => e.name === 'WorkTimeLossError' && e.detail.level === 'blank',
      `before=${JSON.stringify(before)} でも止める`);
  }
  // ⚠これが 直す前 に素通しだった所。wouldLoseWorkTime 単体では今も false のまま(仕様)。
  assert.equal(wouldLoseWorkTime(null, { tasks: {} }).lost, false,
    '突き合わせの判定は「知らない事を危ないと言わない」まま。止めるのは形の判定(blankTasksRisk)の役目');
});

test('Z11 tasks を空にする形は3通り全部止める(空マップ / null / マップ以外)', () => {
  assert.equal(blankTasksRisk({ tasks: {} }).kind, 'empty');
  assert.equal(blankTasksRisk({ tasks: null }).kind, 'null');
  assert.equal(blankTasksRisk({ tasks: [] }).kind, 'notmap', '配列を送ると map ではなくなる=中身が消える');
  assert.equal(blankTasksRisk({ tasks: 'x' }).kind, 'notmap');
  // 送っていない・中身がある・undefined は素通し
  assert.equal(blankTasksRisk({ mapZoneId: 'z' }).blank, false);
  assert.equal(blankTasksRisk({ tasks: { 'a-0': { duration: 1 } } }).blank, false);
  assert.equal(blankTasksRisk({ tasks: undefined }).blank, false, 'キーを送らないのと同じ扱い');
  assert.equal(blankTasksRisk(null).blank, false);
});

test('Z12 ⚠本当に全部消す道は「鍵が2つ」揃った時だけ(片方では通らない)', () => {
  const lot = LOT_8_12();
  // ① 重さの許可だけでは通らない。ここを通すと自動処理がうっかり全部消せる
  assert.throws(() => assertSafeLotSave(lot, { tasks: {} }, { allow: 'wipe' }),
    (e) => e.detail.level === 'blank');
  // ② 形の許可だけでも通らない。手元に「消える物」が見えているなら、それは事故
  assert.throws(() => assertSafeLotSave(lot, { tasks: {} }, { allowEmptyTasks: true }),
    (e) => e.detail.level === 'wipe' && e.detail.lostSec === 863,
    '⚠形を許しても、突き合わせで863秒失うと分かるので止まる');
  // ③ 両方を明示した時だけ通る(= grep で必ず一覧に出る2語)
  assert.equal(assertSafeLotSave(lot, { tasks: {} }, { allowEmptyTasks: true, allow: 'wipe' }).lost, true,
    '通した時も lost:true は返す(何をしたか記録に残せる)');
  // ④ 手元に失う物が無いロット(まだ1件も作業していない)なら、形の許可だけで足りる
  assert.equal(assertSafeLotSave({ id: 'new', tasks: {} }, { tasks: {} }, { allowEmptyTasks: true }).lost, false);
  assert.equal(blankTasksRisk({ tasks: {} }, { allowEmptyTasks: true }).blank, false);
});

test('Z13 🚨読み込みの門: 読めていなければ投げて止める(無言で return しない)', () => {
  let blocked = null;
  assert.throws(() => assertLotsLoaded(false, { onBlock: (r) => { blocked = r; } }),
    (e) => e.name === 'LotsNotLoadedError' && e.message === LOTS_NOT_LOADED_MSG);
  assert.equal(blocked.lost, true, '止めた事を知らせる(画面に赤く出す材料)');
  assert.match(LOTS_NOT_LOADED_MSG, /保存できません/);
  assert.equal(assertLotsLoaded(true), true, '読めていれば素通し');
  // ⚠旗が未定義(=まだ何も分からない)も「読めていない」側に倒す。
  assert.throws(() => assertLotsLoaded(undefined), (e) => e.name === 'LotsNotLoadedError');
});

test('Z14 「消す印」を tasks の中に直接置く形も読む(withDeletions を通した後の姿)', () => {
  assert.equal(isDeleteSentinel(DEL), true);
  assert.equal(isDeleteSentinel({}), false);
  assert.equal(isDeleteSentinel(null), false);
  const lot = LOT_8_12();
  // 記録がある task を印で消す → 止める
  const res = wouldLoseWorkTime(lot, { tasks: { [`${STEP_B}-0`]: DEL } });
  assert.equal(res.lost, true);
  assert.equal(res.level, 'drop');
  assert.match(res.lostKeys[0].what, /名指しで消された/);
  // 中の項目だけを印で消す(秒数を消す) → 減ったと読む
  const res2 = wouldLoseWorkTime(lot, { tasks: { [`${STEP_B}-0`]: { duration: DEL } } });
  assert.equal(res2.lost, true, '🚨印を素直に上書きすると「時間は在る」と誤読して素通しになる');
  // 記録が無い task を印で消すのは通す
  const lot2 = LOT_8_12();
  lot2.tasks['SEED-0'] = { status: 'waiting', duration: 0 };
  assert.equal(wouldLoseWorkTime(lot2, { tasks: { 'SEED-0': DEL } }).lost, false);
});
