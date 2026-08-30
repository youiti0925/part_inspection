#!/usr/bin/env node
// =============================================================================
// 🧪 見張り自身の試験 — scripts/verify-lint-baseline.mjs は嘘をつかないか
// -----------------------------------------------------------------------------
// ⚠2026-08-16 の教訓: 見張りを作ったら **見張り自身も試験する**。
//   （あの時は「嘘の合格」が3件、「実コードを食う誤検出」が1件あった）
//
// ここで確かめる事:
//   ・増えたら赤になるか（嘘の合格を出さないか）
//   ・据え置きなら通るか（嘘の警告を出さないか）
//   ・🚨基準値の紙に書いても HARD_ZERO は黙らないか（＝紙で緩められない事）
//   ・構文エラーと「使われていない eslint-disable」を混ぜていないか
//   ・本物の eslint を回して、本当に構文エラー/未定義の名前を捕まえるか
//
// ⚠中間ファイルは os.tmpdir() の下に作る（プロジェクト内に書くと Vite が
//   作り直しを始めて、偽の不合格になる。2026-08-10 に実際にやった）
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import { compare, tally, classifyNullRule, buildBaseline, HARD_ZERO } from './verify-lint-baseline.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  … ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  … ' + extra : ''}`); }
};

console.log('🧪 見張り自身の試験: eslint 基準値\n');
console.log('── ① 判定の中身（作り物の数字で確かめる） ──');

const base = { rules: { 'no-unused-vars': { err: 10, warn: 0 }, 'no-empty': { err: 2, warn: 0 } } };

// 据え置き → 通る
ok('据え置きなら通る（嘘の警告を出さない）',
  compare({ 'no-unused-vars': { err: 10, warn: 0 }, 'no-empty': { err: 2, warn: 0 } }, base).ok === true);

// 1件増えた → 赤
{
  const r = compare({ 'no-unused-vars': { err: 11, warn: 0 }, 'no-empty': { err: 2, warn: 0 } }, base);
  ok('1件でも増えたら赤（嘘の合格を出さない）', r.ok === false && r.errors[0].rule === 'no-unused-vars',
    r.errors.map(e => e.rule).join(','));
}

// 減った → 赤にはしない、けれど黙らない
{
  const r = compare({ 'no-unused-vars': { err: 3, warn: 0 }, 'no-empty': { err: 2, warn: 0 } }, base);
  ok('減ったら赤にしない（良い変更を止めない）', r.ok === true);
  ok('減った事は黙らずお知らせする', r.notices.length === 1, r.notices[0] || '(無し)');
}

// 紙に無い規則が出た → 赤
{
  const r = compare({ 'no-unused-vars': { err: 10, warn: 0 }, 'no-empty': { err: 2, warn: 0 }, 'no-cond-assign': { err: 1, warn: 0 } }, base);
  ok('紙に無い規則が出たら赤', r.ok === false && r.errors.some(e => e.rule === 'no-cond-assign'));
}

// warning も見張る
{
  const r = compare({ 'no-unused-vars': { err: 10, warn: 1 }, 'no-empty': { err: 2, warn: 0 } }, base);
  ok('warning が増えても赤（error だけ見て見逃さない）', r.ok === false && r.errors.some(e => e.field === 'warn'));
}

console.log('\n── ② 🚨紙で緩められない事（ここが本丸） ──');
for (const rule of Object.keys(HARD_ZERO)) {
  // わざと基準値の紙に大きな数を書いて「許して」みる
  const cheatPaper = { rules: { [rule]: { err: 999, warn: 999 } } };
  const r = compare({ [rule]: { err: 1, warn: 0 } }, cheatPaper);
  ok(`${rule} は紙に 999 と書いても 1件で赤になる`, r.ok === false && r.errors.some(e => e.rule === rule && e.kind === 'hard-zero'));
}
{
  const built = buildBaseline({ 'no-undef': { err: 5, warn: 0 }, 'no-empty': { err: 2, warn: 0 } });
  ok('--update しても HARD_ZERO は紙に書かれない', !('no-undef' in built.rules) && ('no-empty' in built.rules),
    Object.keys(built.rules).join(','));
}

console.log('\n── ③ 種類分け（構文エラーと eslint-disable を混ぜていないか） ──');
ok('構文エラーは __PARSING_ERROR__ になる',
  classifyNullRule("Parsing error: Unexpected token }") === '__PARSING_ERROR__');
ok('使われていない eslint-disable は 構文エラー扱いしない',
  classifyNullRule("Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps').") === '__UNUSED_DISABLE__');
ok('__UNUSED_DISABLE__ は HARD_ZERO ではない（0件固定にすると嘘の赤が出る）',
  !HARD_ZERO['__UNUSED_DISABLE__'] && !!HARD_ZERO['__PARSING_ERROR__']);

console.log('\n── ④ 本物の eslint を回す（作り物でない事の証明） ──');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-baseline-selftest-'));
try {
  fs.writeFileSync(path.join(tmp, 'broken.js'), 'export function a() {\n  return 1;\n}}\n', 'utf8');       // 構文エラー
  fs.writeFileSync(path.join(tmp, 'undef.js'), 'export const x = totallyNotDefinedAnywhere + 1;\n', 'utf8'); // no-undef
  fs.writeFileSync(path.join(tmp, 'clean.js'), 'export const y = 1;\nexport const z = y + 1;\n', 'utf8');    // 何も無い

  const eslint = new ESLint({
    cwd: tmp,
    overrideConfigFile: true, // ← プロジェクトの設定を読まない（この試験だけの設定で回す）
    overrideConfig: [{
      files: ['**/*.js'],
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
      rules: { 'no-undef': 'error', 'no-unused-vars': 'error' },
    }],
  });
  const results = await eslint.lintFiles([tmp]);
  const t = tally(results);

  ok('本物の構文エラーを __PARSING_ERROR__ として数える', (t['__PARSING_ERROR__']?.err || 0) >= 1,
    `${t['__PARSING_ERROR__']?.err || 0}件`);
  ok('本物の no-undef を数える', (t['no-undef']?.err || 0) >= 1, `${t['no-undef']?.err || 0}件`);

  // 🚨 一番大事: 構文エラー/no-undef が在る状態で compare が絶対に通らない事
  ok('その状態で判定は必ず赤（基準値の紙が何であれ）',
    compare(t, { rules: { '__PARSING_ERROR__': { err: 99, warn: 99 }, 'no-undef': { err: 99, warn: 99 } } }).ok === false);

  // 負の対照: きれいなファイルだけなら 0件
  const clean = await eslint.lintFiles([path.join(tmp, 'clean.js')]);
  const tc = tally(clean);
  ok('負の対照: きれいなファイルに指摘を作らない', Object.keys(tc).length === 0, JSON.stringify(tc));
  ok('負の対照: きれいなファイルなら判定は通る', compare(tc, { rules: {} }).ok === true);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n🧪 見張り自身の試験: ${fail === 0 ? '合格' : '不合格'}（合格 ${pass} / 不合格 ${fail}）`);
console.log(`   見本の置き場所: ${os.tmpdir()} の下（プロジェクト内には1つも書いていません）`);
process.exit(fail === 0 ? 0 : 1);
