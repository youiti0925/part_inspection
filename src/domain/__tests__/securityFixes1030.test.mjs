// 実行: node --test src/domain/__tests__/securityFixes1030.test.mjs
// 🔒 2026-10-30 セキュリティ試験の指摘(SAST-02・SAST-05・F3)の手当てを見張る。社内版(IS_ONPREM_BUILD)の枝だけを直している。
//   本番のビルド(IS_ONPREM_BUILD = false)の出力は前と同じ(dist/assets の sha256 が一致することを手で確かめた・コミットの説明)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const kit = fs.readFileSync(path.join(SRC, 'contact', 'ContactKit.jsx'), 'utf8');

test('PS01 ロットをタッチで動かす時の影: 社内版は指図番号・型式を textContent で入れる(innerHTML に入れない・SAST-02)', () => {
  const i = app.indexOf("ghost.id = 'touch-drag-ghost';");
  assert.ok(i > 0);
  const block = app.slice(i, app.indexOf('document.body.appendChild(ghost);', i));
  assert.match(block, /if \(IS_ONPREM_BUILD\) \{[\s\S]*l1\.textContent = String\(lot\.orderNo \?\? ''\);[\s\S]*l2\.textContent = String\(lot\.model \|\| ''\);[\s\S]*\} else \{\s*\n\s*ghost\.innerHTML/);
  const onpremBranch = block.slice(block.indexOf('if (IS_ONPREM_BUILD) {'), block.indexOf('} else {'));
  assert.doesNotMatch(onpremBranch, /\.innerHTML\s*=/);
});

test('PS02 ③ からの合図は送り主の origin を見る・宛先が分からない時は送らない(SAST-05)', () => {
  assert.match(kit, /if \(IS_ONPREM_BUILD && \(e\.source !== window\.parent \|\| !e\.origin \|\| e\.origin !== parentOriginOf\(document\.referrer\)\)\) return;\s*\n\s*const m = parseActiveMessage\(e\.data\);/);
  assert.match(kit, /if \(IS_ONPREM_BUILD && !parentOriginOf\(document\.referrer\)\) return;[^\n]*\n\s*const target = parentOriginOf\(document\.referrer\) \|\| '\*';/);
  assert.match(kit, /import \{[^}]*IS_ONPREM_BUILD[^}]*\} from '\.\.\/onprem\.js'/);
});
