// 🧾 型式×テンプレ単位の抜取／スキップ(templateSkip.js)の見張り。2026-09-06。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  templateSkipKey, normalizeTemplateSkipCfg, conditionsFor, lotHadNg, isTemplateSkippedLot, streakOf,
  judgeTemplateSkip, buildTemplateSkippedTasks, templateSkipRows, templateSkipSummary, TEMPLATE_SKIP_DEFAULT,
} from '../templateSkip.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 1);
const lot = (i, { model = 'SS-100', templateId = 'T1', ng = false, skip = false, done = true, qty = 2, sec = 600 } = {}) => {
  const tasks = {};
  for (let u = 0; u < qty; u++) tasks[`s1-${u}`] = skip
    ? { status: 'skipped', samplingSkipped: true, templateSkipped: true, duration: 0 }
    : { status: ng && u === 0 ? 'ng' : 'completed', duration: sec };
  return { id: `L${i}`, model, templateId, quantity: qty, status: done ? 'completed' : 'waiting', completedAt: done ? T0 + i * DAY : null, createdAt: T0 + i * DAY, tasks, ...(skip ? { templateSkip: { skip: true } } : {}) };
};
const cfgOn = (extra = {}) => ({ enabled: true, allow: { [templateSkipKey('SS-100', 'T1')]: true }, default: { qualifyLots: 3, lotSkipEvery: 4 }, ...extra });

test('T1 鍵は 型式::テンプレ。設定は壊れた値を既定へ戻す', () => {
  assert.equal(templateSkipKey(' SS-100 ', 'T1'), 'SS-100::T1');
  const c = normalizeTemplateSkipCfg({ enabled: 'yes', default: { qualifyLots: 0, lotSkipEvery: 1 } });
  assert.equal(c.enabled, false, '文字の enabled を true にしている');
  assert.deepEqual(c.default, { qualifyLots: TEMPLATE_SKIP_DEFAULT.default.qualifyLots, lotSkipEvery: TEMPLATE_SKIP_DEFAULT.default.lotSkipEvery });
  assert.deepEqual(conditionsFor({ byKey: { 'A::B': { qualifyLots: 7 } } }, 'A::B'), { qualifyLots: 7, lotSkipEvery: 4 }, '組ごとの上書きが効かない');
});

test('T2 欠点(NG)の読み方はタスクの status と ngCount。スキップしたロットは templateSkip.skip で見分ける', () => {
  assert.equal(lotHadNg(lot(1)), false);
  assert.equal(lotHadNg(lot(1, { ng: true })), true);
  assert.equal(lotHadNg({ tasks: {}, ngCount: 2 }), true);
  assert.equal(isTemplateSkippedLot(lot(1, { skip: true })), true);
  assert.equal(isTemplateSkippedLot(lot(1)), false);
});

test('T3 連続無欠点は新しい順に数え、NG で切れる。スキップで流したロットは数えも切りもしない', () => {
  const lots = [lot(1), lot(2), lot(3, { ng: true }), lot(4), lot(5), lot(6, { skip: true })];
  const st = streakOf(lots, 'SS-100::T1');
  assert.equal(st.streak, 2, 'NG(3)より後の 4,5 の2本のはず');
  assert.equal(st.sinceFull, 1, '直近の検査ロットより後にスキップが1本');
  assert.equal(st.inspected, 5);
  assert.equal(st.lastNgAt, T0 + 3 * DAY);
  assert.equal(streakOf(lots, 'XX::T1').streak, 0, '別の組を混ぜている');
});

test('T4 判定: 停止中／絶対に減らさない／許可なし／条件不足 は全数。そろえばスキップ。Nロットに1回は全数', () => {
  const lots = [lot(1), lot(2), lot(3), lot(4)];
  const key = 'SS-100::T1';
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots, cfg: { enabled: false, allow: { [key]: true } } }).reason, 'off');
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots, cfg: cfgOn({ never: { [key]: true } }) }).reason, 'never');
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots, cfg: cfgOn({ allow: {} }) }).reason, 'not-allowed');
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots: [lot(1), lot(2)], cfg: cfgOn() }).reason, 'not-enough');
  const j = judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots, cfg: cfgOn() });
  assert.equal(j.reason, 'skip'); assert.equal(j.skip, true); assert.equal(j.streak, 4); assert.equal(j.need, 3);
  // 3本スキップで流した後(4ロットに1回)は全数の番
  const withSkips = [...lots, lot(5, { skip: true }), lot(6, { skip: true }), lot(7, { skip: true, done: false })];
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots: withSkips, cfg: cfgOn() }).reason, 'every-nth');
  // NG が出たら次から全数(連続が切れる)
  const afterNg = [...lots, lot(5, { ng: true })];
  assert.equal(judgeTemplateSkip({ model: 'SS-100', templateId: 'T1', lots: afterNg, cfg: cfgOn() }).reason, 'not-enough');
});

test('T5 スキップのロットの tasks は全工程 skipped(システム)。lotOnce は lot 鍵1つ。工程0件なら {}', () => {
  const tasks = buildTemplateSkippedTasks([{ id: 'a' }, { id: 'b', lotOnce: true }], 3, { at: 123 });
  assert.deepEqual(Object.keys(tasks).sort(), ['a-0', 'a-1', 'a-2', 'b-lot-0']);
  assert.equal(tasks['a-0'].status, 'skipped');
  assert.equal(tasks['a-0'].samplingSkipped, true, '時間の物差しから外す印が無い');
  assert.equal(tasks['a-0'].templateSkipped, true);
  assert.equal(tasks['a-0'].workerName, 'システム(抜取判定)');
  assert.equal(tasks['a-0'].skipAt, 123);
  assert.deepEqual(buildTemplateSkippedTasks([], 2), {});
});

test('T6 一覧と合計: 数字は実測の分だけ。月の見込み = 1ロットの平均分 × 月のロット数 × (N-1)/N', () => {
  const now = T0 + 10 * DAY;
  const lots = [lot(1, { sec: 600 }), lot(2, { sec: 600 }), lot(3, { sec: 600 }), lot(4, { sec: 600 }), lot(9, { model: 'ZZ-1', sec: 300 })];
  const rows = templateSkipRows({ lots, cfg: cfgOn(), nowMs: now, months: 3 });
  const r = rows.find((x) => x.key === 'SS-100::T1');
  assert.equal(r.completed, 4);
  assert.equal(r.avgMinPerLot, 20, '2台×600秒=1200秒=20分のはず');
  assert.equal(r.lotsPerMonth, 4 / 3);
  assert.ok(Math.abs(r.minPerMonth - 20 * (4 / 3) * 0.75) < 1e-9, '月の見込みの式が違う');
  assert.equal(r.judge.reason, 'skip');
  const sm = templateSkipSummary(rows);
  assert.equal(sm.combos, 2); assert.equal(sm.allowed, 1);
  assert.ok(sm.minPerMonthAllowed > 0 && sm.minPerMonthIfAll >= sm.minPerMonthAllowed);
});
