// ============================================================================
// 🚨🚨 版の見張りが **本当に配線されているか** の試験
// ----------------------------------------------------------------------------
// 【なぜ純関数の試験と別に要るか】
//   2026-08-19 の実測: appVersion.test.mjs は23件すべて緑。なのに機能は0%動作だった。
//     ・index.html が呼ぶ名前が、どこにも存在しなかった(毎回 ReferenceError)
//     ・window.__appCanReload は常に undefined(押させない関所が素通り)
//     ・window.__appSaveStatus は誰も代入していない
//     ・「あとで」を聞く側が動いていない
//   純関数の試験は「判定が正しいか」しか見ない。**呼ばれているかは1件も見ていない**。
//   → この試験は **実コードの文字を読んで**、呼ぶ側と呼ばれる側の名前が
//     つながっているかだけを見る。
//
// 【この試験自身も試験する】
//   実コードの写しを1か所だけ壊して、**狙った番号で落ちるか** を毎回確かめる
//   (落ちない確認は、何も見ていないのと同じ)。中身は scripts/selftest-version-watch.mjs。
//
// ⚠ npm test / npm run check の `node --test "src/domain/**/*.test.mjs"` から自動で走る。
//   **手で走らせる物にしない**(手で走らせる物は、いつか誰も走らせなくなる)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWiring, readWiringFiles, CONTRACT } from '../../../scripts/verify-version-watch.mjs';
import { runSelfTest } from '../../../scripts/selftest-version-watch.mjs';

const files = readWiringFiles();

test('W00 🚨 版の見張りが実コードで配線されている(呼ぶ側と呼ばれる側の名前が一致)', () => {
  const { findings } = analyzeWiring(files);
  const msg = findings.map((f) => `\n  [${f.id}] ${f.file}\n      ${f.msg}`).join('');
  assert.equal(findings.length, 0, `🚨 配線が切れています:${msg}\n`);
});

test('W01 約束した名前が台帳どおり(片側だけ変えたら W00 が落ちる)', () => {
  // ⚠ここは台帳が空になっていない事だけを見る。中身の一致は W00 が実コードで見る。
  for (const [k, v] of Object.entries(CONTRACT)) {
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length > 0, k);
  }
});

test('W90 🚨 わざと配線を外すと、この試験は本当に落ちる', () => {
  const { failures, checked } = runSelfTest(files);
  assert.ok(checked >= 20, `壊し方が少なすぎます(${checked}通り)`);
  assert.deepEqual(failures, [], `🚨 見張り自身が壊れています:\n  ${failures.join('\n  ')}\n`);
});