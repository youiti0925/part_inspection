// 🎓 級・検定は「保存せず導出する」。ここが壊れると、新人の級が黙って変わる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRAINING_CONFIG, TRAINEE_BASELINE_MIN_N, BASELINE_SOURCE_LABEL,
  normalizeTrainingConfig, tierLabel, pickBaseline,
  traineeCellProgress, collectTraineeCells, buildTraineeReport,
} from '../traineeProgress.js';

const T0 = 1_800_000_000_000;
const rec = (duration, i) => ({ duration, endTime: T0 + i * 60000 });
// ものさし100秒。級の目標は 150 / 130 / 110、検定は 120。
const BASE = 100;

test('TP01 既定の設定 (級3段+検定)', () => {
  assert.deepEqual(DEFAULT_TRAINING_CONFIG.tiers, [1.5, 1.3, 1.1]);
  assert.equal(DEFAULT_TRAINING_CONFIG.examRatio, 1.2);
  assert.equal(DEFAULT_TRAINING_CONFIG.examStreak, 3);
});

test('TP02 設定の掃除: 級は必ず厳しくなる向きに並べ替える(逆順に入れられても昇級で楽にならない)', () => {
  const c = normalizeTrainingConfig({ tiers: [1.1, 1.5, 1.3, 1.3], examRatio: 1.2, examStreak: 3 });
  assert.deepEqual(c.tiers, [1.5, 1.3, 1.1]); // 降順・重複なし
  // 壊れた値は既定へ戻す(画面が真っ白になったり、0除算で級が跳ねたりしない)
  const bad = normalizeTrainingConfig({ tiers: ['x', -1, 0], examRatio: 0, examStreak: 0 });
  assert.deepEqual(bad.tiers, DEFAULT_TRAINING_CONFIG.tiers);
  assert.equal(bad.examRatio, DEFAULT_TRAINING_CONFIG.examRatio);
  assert.equal(bad.examStreak, DEFAULT_TRAINING_CONFIG.examStreak);
  assert.deepEqual(normalizeTrainingConfig(null).tiers, DEFAULT_TRAINING_CONFIG.tiers);
});

test('TP03 昇級: 目標以内を3回連続で1つ上がる。2回では上がらない', () => {
  const two = traineeCellProgress({ records: [rec(140, 1), rec(145, 2)], baseline: BASE });
  assert.equal(two.tier, 0);
  assert.equal(two.streak, 2);
  assert.equal(two.remaining, 1); // あと1回

  const three = traineeCellProgress({ records: [rec(140, 1), rec(145, 2), rec(120, 3)], baseline: BASE });
  assert.equal(three.tier, 1);
  assert.equal(three.streak, 0);       // 昇級したら連続はリセットして次の級を目指す
  assert.equal(three.stageRatio, 1.3); // 次の目標は ×1.3
  assert.equal(three.stageGoal, 130);
  assert.equal(three.tierName, '3級');
});

test('TP04 連続リセット: 途中で外すと連続は0に戻る。ただし**級は下がらない**', () => {
  // 3回連続で3級 → その後わざと遅い記録
  const r = traineeCellProgress({
    records: [rec(140, 1), rec(140, 2), rec(140, 3), rec(999, 4), rec(120, 5)],
    baseline: BASE,
  });
  assert.equal(r.tier, 1);   // 級は下がらない
  assert.equal(r.streak, 1); // 999 で0に戻り、120 で1
  const h = r.history;
  assert.equal(h[2].promoted, true);
  assert.equal(h[3].pass, false);
  assert.equal(h[3].goalRatio, 1.3); // 昇級後は ×1.3 で判定されている
});

test('TP05 検定合格: 最上級の後 ×1.2 以内を3回連続', () => {
  // 3回×3段 = 9回で1級 → さらに120以内を3回で検定合格
  const recs = [];
  let i = 0;
  [140, 140, 140, 125, 125, 125, 105, 105, 105].forEach(d => recs.push(rec(d, ++i)));
  const top = traineeCellProgress({ records: recs, baseline: BASE });
  assert.equal(top.tier, 3);
  assert.equal(top.tierName, '1級');
  assert.equal(top.stage, 'exam');
  assert.equal(top.stageGoal, 120);
  assert.equal(top.examPassed, false);

  const exam = traineeCellProgress({ records: [...recs, rec(120, ++i), rec(118, ++i), rec(119, ++i)], baseline: BASE });
  assert.equal(exam.examPassed, true);
  assert.equal(exam.examStreak, 3);
  assert.equal(exam.remaining, 0);
});

test('TP06 検定も1回外すと連続リセット(合格前)。合格した後は取り消さない', () => {
  const base9 = [140, 140, 140, 125, 125, 125, 105, 105, 105];
  let i = 0;
  const recs = base9.map(d => rec(d, ++i));
  const near = traineeCellProgress({ records: [...recs, rec(118, ++i), rec(118, ++i), rec(300, ++i)], baseline: BASE });
  assert.equal(near.examPassed, false);
  assert.equal(near.examStreak, 0);

  let j = 0;
  const recs2 = base9.map(d => rec(d, ++j));
  const after = traineeCellProgress({
    records: [...recs2, rec(118, ++j), rec(118, ++j), rec(118, ++j), rec(999, ++j)],
    baseline: BASE,
  });
  assert.equal(after.examPassed, true); // 一度受かった検定は取り消さない
  assert.equal(after.examStreak, 0);    // 連続だけリセット
});

test('TP07 境界値: ちょうど比率と同じ秒は「合格」(浮動小数で落とさない)', () => {
  const r = traineeCellProgress({ records: [rec(150, 1)], baseline: BASE });
  assert.equal(r.history[0].pass, true);
  // 1.1 × 100 は浮動小数で 110.00000000000001 になる。整数側でも必ず通ること
  const top = traineeCellProgress({
    records: [rec(150, 1), rec(150, 2), rec(150, 3), rec(130, 4), rec(130, 5), rec(130, 6), rec(110, 7)],
    baseline: BASE,
  });
  assert.equal(top.history[6].pass, true);
  assert.equal(top.history[6].goalRatio, 1.1);
});

test('TP08 ものさしが無い(記録不足)ときは判定しない。0件でも落ちない', () => {
  const r = traineeCellProgress({ records: [rec(120, 1), rec(130, 2)], baseline: null });
  assert.equal(r.ready, false);
  assert.equal(r.tier, 0);
  assert.equal(r.examPassed, false);
  assert.deepEqual(r.history, []);
  assert.equal(r.n, 2);            // 記録があること自体は数える(黙って捨てない)
  assert.equal(r.stageGoal, null);
  const empty = traineeCellProgress({});
  assert.equal(empty.n, 0);
  assert.equal(empty.ready, false);
});

test('TP09 0秒の記録は数えない(押してすぐ閉じた記録で昇級しない)', () => {
  const r = traineeCellProgress({ records: [rec(0, 1), rec(0, 2), rec(0, 3)], baseline: BASE });
  assert.equal(r.n, 0);
  assert.equal(r.tier, 0);
  // 0秒3件 + 合格2件 では昇級しない(0秒を合格に数えたら3回連続になってしまう)
  const mixed = traineeCellProgress({ records: [rec(0, 1), rec(140, 2), rec(0, 3), rec(140, 4)], baseline: BASE });
  assert.equal(mixed.n, 2);
  assert.equal(mixed.tier, 0);
  assert.equal(mixed.streak, 2);
});

test('TP10 記録は endTime で並べ直す(画面から渡る順番に依存しない)', () => {
  const shuffled = [rec(105, 9), rec(140, 1), rec(140, 2), rec(140, 3)];
  const r = traineeCellProgress({ records: shuffled, baseline: BASE });
  assert.equal(r.tier, 1);                    // 先に140が3回 → 3級
  assert.equal(r.history[3].duration, 105);   // 一番新しい記録が最後
  assert.equal(r.history[3].goalRatio, 1.3);
});

test('TP11 ものさしの優先順位: 較正済み目標 → P25 → 中央値', () => {
  const peers = [100, 120, 140, 160, 180, 200];
  assert.deepEqual(pickBaseline({ targetSec: 90, peerDurations: peers }), { sec: 90, source: 'target', n: null });
  const p = pickBaseline({ targetSec: 0, peerDurations: peers });
  assert.equal(p.source, 'p25');
  assert.equal(p.n, 6);
  // 補間なし下側順位: 6件の25% → rank=ceil(1.5)=2 → 2番目に速い 120
  assert.equal(p.sec, 120);
  // 件数が足りなければ中央値へ(P25 は少数だと一番速い1件に引っ張られる)
  const few = pickBaseline({ targetSec: 0, peerDurations: [100, 200, 300] });
  assert.equal(few.source, 'median');
  assert.equal(few.sec, 200);
  // ものさしの材料が何も無ければ null (「無い」を数字で埋めない)
  const none = pickBaseline({ targetSec: 0, peerDurations: [] });
  assert.equal(none.source, null);
  assert.equal(none.sec, 0);
  assert.equal(TRAINEE_BASELINE_MIN_N, 5);
  assert.equal(typeof BASELINE_SOURCE_LABEL.p25, 'string');
});

// ---- collectTraineeCells / buildTraineeReport -------------------------------
const stepKeyOf = (s) => `${s.category || ''}_${s.title || ''}`;
const taskKeysOf = (l, step, idx) => Array.from({ length: l.quantity || 1 }, (_, i) => (
  (l.tasks || {})[`${step.id}-${i}`] !== undefined ? `${step.id}-${i}` : `${idx}-${i}`
));
const mkLot = (id, { model, templateId, tasks, quantity = 2 }) => ({
  id, model, templateId, quantity, status: 'completed', completedAt: T0,
  steps: [{ id: 's1', title: '測定', category: '検査', targetTime: 100 }],
  tasks,
});
const done = (workerName, duration, extra = {}) => ({ status: 'completed', workerName, duration, endTime: T0, ...extra });

test('TP12 集計単位は 型式×テンプレ×工程。テンプレが違っても型式が違っても別セル', () => {
  const lots = [
    mkLot('l1', { model: 'A', templateId: 'tplX', tasks: { 's1-0': done('新人', 200, { trainee: true }), 's1-1': done('先輩', 100) } }),
    mkLot('l2', { model: 'A', templateId: 'tplY', tasks: { 's1-0': done('新人', 900, { trainee: true }), 's1-1': done('先輩', 800) } }),
    // ⚠型式違い。ここが無いと「セルキーから model を落とす」改変を検出できない(あら探し#16)
    mkLot('l3', { model: 'B', templateId: 'tplX', tasks: { 's1-0': done('新人', 500, { trainee: true }), 's1-1': done('先輩', 450) } }),
  ];
  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf });
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map(c => `${c.model}|${c.templateId}`).sort(), ['A|tplX', 'A|tplY', 'B|tplX']);
  // 同じ型式Aの tplX セルには、型式Bの記録もB側のものさしも1件も混ざらない
  const ax = cells.find(c => c.model === 'A' && c.templateId === 'tplX');
  assert.deepEqual(ax.records.map(r => r.duration), [200]);
  assert.deepEqual(ax.peerDurations, [100]);
  // ⚠ここが束ねられたら「同名工程で中央値8.2倍差」の混在バグが復活している
});

test('TP13 🎓が付いた記録だけ拾う / ものさしには本人の記録も教育中の記録も入れない', () => {
  const lots = [mkLot('l1', {
    model: 'A', templateId: 'tplX', quantity: 4,
    tasks: {
      's1-0': done('新人', 300, { trainee: true }),
      's1-1': done('新人', 280),                    // 🎓が付く前の記録 → 'only' では拾わない
      's1-2': done('先輩', 100),                    // ものさしの材料
      's1-3': done('別の新人', 400, { trainee: true }), // 他人の教育中 → ものさしに入れない
    },
  })];
  const only = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf });
  assert.deepEqual(only[0].records.map(r => r.duration), [300]);
  assert.deepEqual(only[0].peerDurations, [100]); // 本人の280も、他人の教育中400も入らない

  const all = collectTraineeCells({ lots, workerName: '新人', traineeMode: 'all', stepKeyOf, taskKeysOf });
  assert.deepEqual(all[0].records.map(r => r.duration).sort((a, b) => a - b), [280, 300]);
});

test('TP14 抜取スキップ / 未完了 / 0秒 は拾わない', () => {
  const lots = [mkLot('l1', {
    model: 'A', templateId: 'tplX', quantity: 4,
    tasks: {
      's1-0': done('新人', 300, { trainee: true, samplingSkipped: true }),
      's1-1': { status: 'processing', workerName: '新人', duration: 999, trainee: true },
      's1-2': done('新人', 0, { trainee: true }),
      's1-3': done('新人', 250, { trainee: true }),
    },
  })];
  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf });
  assert.deepEqual(cells[0].records.map(r => r.duration), [250]);
});

test('TP15 完了していないロットは見ない(途中の duration を混ぜない)', () => {
  const l = mkLot('l1', { model: 'A', templateId: 'tplX', tasks: { 's1-0': done('新人', 300, { trainee: true }) } });
  l.status = 'in_progress'; delete l.location;
  assert.deepEqual(collectTraineeCells({ lots: [l], workerName: '新人', stepKeyOf, taskKeysOf }), []);
});

test('TP16 レポート: 差×回数の大きい順に並ぶ(=教える優先順位)', () => {
  const lots = [
    // セル1: 1回だけ 5分遅い
    mkLot('l1', { model: 'A', templateId: 'tplX', quantity: 1, tasks: { 's1-0': done('新人', 400, { trainee: true }) } }),
  ];
  // セル2: 1回あたりは40秒しか遅くないが10回やる → 合計400秒でこちらが上に来る
  const steps2 = [{ id: 's2', title: '組付', category: '検査', targetTime: 100 }];
  const tasks2 = {};
  for (let i = 0; i < 10; i++) tasks2[`s2-${i}`] = done('新人', 140, { trainee: true, endTime: T0 + i * 1000 });
  lots.push({ id: 'l2', model: 'A', templateId: 'tplX', quantity: 10, status: 'completed', completedAt: T0, steps: steps2, tasks: tasks2 });

  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf, targetSecOf: (l, s) => s.targetTime });
  const rep = buildTraineeReport({ cells });
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.rows[0].stepTitle, '組付');      // 40秒×10回 = 400秒
  assert.equal(rep.rows[0].gapTotalSec, 400);
  assert.equal(rep.rows[1].gapTotalSec, 300);      // (400-100) × 1回
  assert.equal(rep.summary.cellCount, 2);
  assert.equal(rep.summary.recordCount, 11);
  assert.equal(rep.summary.gapTotalSec, 700);

  // 1台あたりの差で並べ替えると逆になる
  const per = buildTraineeReport({ cells, sort: 'gapPer' });
  assert.equal(per.rows[0].stepTitle, '測定');
});

test('TP17 レポート: ものさしが無いセルも落とさず「判定できない」として残す', () => {
  const lots = [mkLot('l1', {
    model: 'A', templateId: 'tplX', quantity: 1,
    tasks: { 's1-0': done('新人', 300, { trainee: true }) },
  })];
  // targetSecOf を渡さない = 較正済み目標なし、先輩の記録もなし → ものさしが作れない
  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf });
  const rep = buildTraineeReport({ cells });
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0].baseline, 0);
  assert.equal(rep.rows[0].baselineSource, null);
  assert.equal(rep.rows[0].progress.ready, false);
  assert.equal(rep.summary.noBaselineCells, 1);
  assert.equal(rep.summary.measurableCells, 0);
});

test('TP18 レポート: 直近5回の中央値を別に持つ(伸びているのに古い記録で沈まない)', () => {
  const tasks = {};
  [400, 400, 400, 400, 120, 120, 120, 120, 120].forEach((d, i) => { tasks[`s1-${i}`] = done('新人', d, { trainee: true, endTime: T0 + i * 1000 }); });
  const lots = [{
    id: 'l1', model: 'A', templateId: 'tplX', quantity: 9, status: 'completed', completedAt: T0,
    steps: [{ id: 's1', title: '測定', category: '検査', targetTime: 100 }], tasks,
  }];
  // ⚠較正済み(sec)として渡す。数値をそのまま返す旧シグネチャは「テンプレの既定値」扱いになる(TP22)。
  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf, targetSecOf: (l, s) => ({ sec: s.targetTime, templateSec: s.targetTime }) });
  const rep = buildTraineeReport({ cells });
  const r = rep.rows[0];
  assert.equal(r.median, 120);
  assert.equal(r.recentMedian, 120);
  assert.equal(r.best, 120);
  assert.equal(r.worst, 400);
  assert.equal(r.baselineSource, 'target');
  assert.equal(r.baseline, 100);
  // 120 ≦ 100×1.5 が5回連続 → 3級→2級(120 ≦ 130)まで上がる
  assert.equal(r.progress.tier, 1);
});

test('TP19 級の呼び名: 上がるほど数字が小さくなる(3級→2級→1級)', () => {
  assert.equal(tierLabel(0), '見習い');
  assert.equal(tierLabel(1), '3級');
  assert.equal(tierLabel(2), '2級');
  assert.equal(tierLabel(3), '1級');
});

// ---- 2026-08-09 是正分 (あら探し #2/#9/#16) ---------------------------------

test('TP20 ものさしの優先順位: ①較正済み目標 → ②先輩P25 → ③中央値 → ④テンプレ既定値(未較正)', () => {
  // ①較正済みがあれば最優先(テンプレ既定値も先輩の実績も無視)
  const cal = pickBaseline({ targetSec: 300, templateTargetSec: 60, peerDurations: [100, 110, 120, 130, 140] });
  assert.equal(cal.source, 'target');
  assert.equal(cal.sec, 300);
  // ②較正されていないなら、テンプレ既定値ではなく先輩P25を使う
  //   ⚠ここが逆だと、誰も検証していない仮置きの数字が「会社が決めた基準」として級・検定を決めてしまう
  const p25 = pickBaseline({ targetSec: 0, templateTargetSec: 60, peerDurations: [100, 110, 120, 130, 140] });
  assert.equal(p25.source, 'p25');
  // ③先輩が5件未満なら中央値(これもテンプレ既定値より先)
  const med = pickBaseline({ targetSec: 0, templateTargetSec: 60, peerDurations: [200, 300] });
  assert.equal(med.source, 'median');
  assert.equal(med.sec, 250);
  // ④どれも無い時だけテンプレ既定値。必ず 'target' と別の出どころ名にする(画面で【仮定】側へ落とすため)
  const tpl = pickBaseline({ targetSec: 0, templateTargetSec: 60, peerDurations: [] });
  assert.equal(tpl.source, 'templateTarget');
  assert.equal(tpl.sec, 60);
  assert.notEqual(tpl.source, 'target');
  assert.equal(typeof BASELINE_SOURCE_LABEL.templateTarget, 'string');
  // 何も無ければ 0/null (「無い」を数字で埋めない)
  assert.equal(pickBaseline({}).source, null);
});

test('TP21 未較正のテンプレ既定値では検定に受からない(先輩の実績が優先される)', () => {
  // 実話ベース: テンプレの仮置き600秒のまま較正していない工程で、実測120秒の新人が12回で「検定合格」になっていた。
  const tasks = {};
  for (let i = 0; i < 12; i++) tasks[`s1-${i}`] = done('新人', 120, { trainee: true, endTime: T0 + i * 1000 });
  // 先輩の実績(ものさしの材料)を5件。すべて100秒 → P25 = 100
  for (let i = 0; i < 5; i++) tasks[`s1-${12 + i}`] = done('先輩', 100, { endTime: T0 });
  const lots = [{
    id: 'l1', model: 'A', templateId: 'tplX', quantity: 17, status: 'completed', completedAt: T0,
    steps: [{ id: 's1', title: '外観検査', category: '検査', targetTime: 600 }], tasks,
  }];
  // 較正されていない = sec は 0、テンプレ既定値だけ渡す
  const cells = collectTraineeCells({
    lots, workerName: '新人', stepKeyOf, taskKeysOf,
    targetSecOf: (l, s) => ({ sec: 0, templateSec: s.targetTime }),
  });
  const r = buildTraineeReport({ cells }).rows[0];
  assert.equal(r.baselineSource, 'p25', 'テンプレの仮置き600秒ではなく先輩P25がものさしになる');
  assert.equal(r.baseline, 100);
  assert.equal(r.progress.tier, 2, '1級の目標110秒を切れないので2級止まり');
  assert.equal(r.progress.examPassed, false, '12回やっても検定には受からない');
  // ⚠もし600秒を「較正済み目標」として使うと、3級900/2級780/1級660/検定720 が全部通り
  //   12回で「🏅検定合格」になる = 誰も検証していない数字で卒業判断が押される。
  const wrong = buildTraineeReport({
    cells, resolveBaseline: () => ({ sec: 600, source: 'target', n: null }),
  }).rows[0];
  assert.equal(wrong.progress.examPassed, true, '(対照) 未較正の仮置きを基準にすると簡単に受かってしまう');
});

test('TP22 targetSecOf が数値を返す旧シグネチャは「較正済み」と見なさない(安全側)', () => {
  const lots = [mkLot('l1', {
    model: 'A', templateId: 'tplX', quantity: 1,
    tasks: { 's1-0': done('新人', 300, { trainee: true }) },
  })];
  const cells = collectTraineeCells({ lots, workerName: '新人', stepKeyOf, taskKeysOf, targetSecOf: (l, s) => s.targetTime });
  assert.equal(cells[0].targetSec, 0);
  assert.equal(cells[0].templateTargetSec, 100);
  assert.equal(buildTraineeReport({ cells }).rows[0].baselineSource, 'templateTarget');
});

test('TP23 級・検定の基準は設定どおりに効く(⚙で変えた値がハードコードに負けない)', () => {
  // 級は1段だけ(×1.2)・検定は×1.05・連続2回 という設定。
  const cfg = { tiers: [1.2], examRatio: 1.05, examStreak: 2 };
  // 105 は ×1.05 以内、120 は ×1.2 以内。2回連続で昇級 → さらに2回連続で検定合格。
  const p = traineeCellProgress({
    records: [rec(120, 1), rec(115, 2), rec(105, 3), rec(104, 4)],
    baseline: BASE, config: cfg,
  });
  assert.equal(p.config.examStreak, 2);
  assert.equal(p.tier, 1, '1段しかないので最上級');
  assert.equal(p.examPassed, true, '×1.05 以内を2回連続で検定合格');
  // 既定(3回連続)ならまだ合格していないこと = 設定が本当に使われている証拠
  const dflt = traineeCellProgress({ records: [rec(120, 1), rec(115, 2), rec(105, 3), rec(104, 4)], baseline: BASE });
  assert.equal(dflt.examPassed, false);
  assert.equal(dflt.config.examStreak, 3);
});
