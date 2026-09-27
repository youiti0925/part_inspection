// 📬 P136 週次ブリーフ(部品): 既定 OFF のスイッチと、組み立てが製品と同じ事を見張る(2026-09-27)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.resolve(HERE, '..', '..', 'App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const PROD = path.resolve(HERE, '..', '..', '..', '..', 'product-inspection-app', 'src', 'App.jsx');

const bodyOf = (src, start, end) => {
  const i = src.indexOf(start); const j = src.indexOf(end, i);
  return i < 0 || j < 0 ? null : src.slice(i, j);
};

test('WB01 自動生成は settings.weeklyBrief.enabled === true の時だけ(既定 OFF)', () => {
  assert.match(APP, /const weeklyBriefOn = settings\?\.weeklyBrief\?\.enabled === true;/);
  assert.match(APP, /if \(!weeklyBriefOn \|\| weeklyBriefTriedRef\.current\) return;/);
  assert.match(APP, /checked=\{settings\?\.weeklyBrief\?\.enabled === true\}/);
});

test('WB02 buildWeeklyBrief は製品と同じ(catch (e) → catch だけ違う)', (t) => {
  if (!fs.existsSync(PROD)) { t.skip('製品のリポが無い'); return; }
  const prod = fs.readFileSync(PROD, 'utf8').replace(/\r\n/g, '\n');
  const a = bodyOf(APP, 'const buildWeeklyBrief = ', '\n// 📬 P136 週次ブリーフの生成(部品版)');
  const b = bodyOf(prod, 'const buildWeeklyBrief = ', '\n// 週次ブリーフの生成(claim');
  assert.ok(a && b, '両方で見つかる');
  assert.equal(a.replace(/catch \(e\) \{/g, 'catch {').trimEnd(), b.replace(/catch \(e\) \{/g, 'catch {').trimEnd());
});
