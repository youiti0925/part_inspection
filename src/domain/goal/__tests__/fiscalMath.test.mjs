import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalRealizedOf } from '../fiscalMath.js';

const D = 86400000;
const fyStart = 0, fyEnd = 365 * D;

test('仕様#16: 年間換算と今年度実現は分かれる(年度途中の実施は年間換算より小さい)', () => {
  // 年180日目に実施、短縮60秒×年365回×3600円/h → 年間換算 ¥21,900
  const annualizedYen = Math.round(60 * 365 / 3600 * 3600);
  const f = fiscalRealizedOf({ perUnitSec: 60, occAnnual: 365, actionMs: 180 * D, nowMs: 200 * D, fyStartMs: fyStart, fyEndMs: fyEnd, charge: 3600 });
  assert.ok(f.forecastYen < annualizedYen); // 年度の残り185日分だけ
  assert.equal(f.forecastYen, Math.round(185 * 60 / 3600 * 3600)); // ≒185回分
  assert.equal(f.realizedYen, Math.round(20 * 60 / 3600 * 3600));  // 経過20日≒20回分(推定)
  assert.equal(f.estimated, true);
});

test('今年度実績: 実測回数(realizedExecs)を渡すと推定でなく実カウントで計算', () => {
  const f = fiscalRealizedOf({ perUnitSec: 60, occAnnual: 365, actionMs: 180 * D, nowMs: 200 * D, fyStartMs: fyStart, fyEndMs: fyEnd, charge: 3600, realizedExecs: 37 });
  assert.equal(f.realizedYen, Math.round(37 * 60 / 3600 * 3600));
  assert.equal(f.estimated, false);
});

test('年度末を跨いだ実施日以降は今年度に数えない', () => {
  const f = fiscalRealizedOf({ perUnitSec: 60, occAnnual: 365, actionMs: 400 * D, nowMs: 420 * D, fyStartMs: fyStart, fyEndMs: fyEnd, charge: 3600, realizedExecs: 10 });
  assert.equal(f.forecastYen, f.realizedYen); // 残り日数0
});

test('短縮ゼロ/実施日なしは0円', () => {
  assert.equal(fiscalRealizedOf({ perUnitSec: 0, occAnnual: 100, actionMs: 10, nowMs: 20, fyStartMs: 0, fyEndMs: 100, charge: 3600 }).forecastYen, 0);
  assert.equal(fiscalRealizedOf({ perUnitSec: 60, occAnnual: 100, actionMs: 0, nowMs: 20, fyStartMs: 0, fyEndMs: 100, charge: 3600 }).forecastYen, 0);
});
