// 🚶 掛け持ち案内の ON/OFF(既定 OFF)の試験(2026-09-27)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { juggleGuideOn } from '../juggleGuideSwitch.js';

test('JS1 既定は OFF(設定が無い・欄が無い・true 以外は全部 OFF)', () => {
  assert.equal(juggleGuideOn(undefined), false);
  assert.equal(juggleGuideOn({}), false);
  assert.equal(juggleGuideOn({ juggleGuide: {} }), false);
  assert.equal(juggleGuideOn({ juggleGuide: { enabled: 'true' } }), false);
  assert.equal(juggleGuideOn({ juggleGuide: { enabled: false } }), false);
  assert.equal(juggleGuideOn({ juggleGuide: { enabled: true } }), true);
});

test('JS2 作業画面は OFF の時に案内を計算しない・親は OFF の時「移る/戻る」を渡さない・マスタ設定に切替がある', () => {
  const app = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const juggle = useMemo\(\(\) => \{\n[^\n]*\n    if \(!juggleEnabled\) return null;/, 'OFF でも案内を計算している');
  assert.match(app, /onSwitchLot=\{juggleGuideOn\(settings\) \?/, 'OFF でも移る口を渡している');
  assert.match(app, /juggleEnabled=\{juggleGuideOn\(settings\)\}/, '作業画面へ ON/OFF を渡していない');
  assert.match(app, /<JuggleGuideSwitch settings=\{settings\} saveSettings=\{saveSettings\} \/>/, 'マスタ設定に切替が無い');
});
