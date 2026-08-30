#!/usr/bin/env node
// =============================================================================
// 🧪 見張り自身の試験: scripts/verify-bare-eslint-disable.mjs
// -----------------------------------------------------------------------------
// 🚨 なぜ要るか: 2026-08-16 に「嘘の合格を出す見張り」を3件、
//   2026-08-23 に「作り物を食っていて永久に緑の見張り」を1件やっている。
//   見張りは **わざと壊して、赤になる事を確かめてから** 使う。
//
// ここで確かめる事:
//   ① 規則名の無い抑制を **裸だと言い当てる**（行・次行・ファイル丸ごとの3種）
//   ② 規則名の有る抑制を **裸だと言わない**（誤検出しない）
//   ③ 日本語の説明文の中に `// eslint-disable-line` と書いてあるだけの行を数えない
//      （実際にそう書いたコメントが src にある。ここを間違えると永久に赤になる）
//   ④ 判定が「基準値から増えたら赤・同じなら緑・減ったら緑」になっている
// =============================================================================

import assert from 'node:assert/strict';
import { classifyComment, scanSource, compare, scanTree } from './verify-bare-eslint-disable.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

console.log('🧪 verify-bare-eslint-disable.mjs の試験');

// ── ① 裸を言い当てる ────────────────────────────────────────────────
t('裸: // eslint-disable-line', () => {
  const hits = scanSource('const a = 1; // eslint-disable-line\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].directive, 'eslint-disable-line');
});
t('裸: // eslint-disable-next-line', () => {
  assert.equal(scanSource('// eslint-disable-next-line\nconst a = 1;\n').length, 1);
});
t('裸: /* eslint-disable */（ファイル丸ごと＝一番危ない）', () => {
  const hits = scanSource('/* eslint-disable */\nconst a = 1;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].directive, 'eslint-disable');
});
t('裸: 理由だけ書いて規則名が無い物も裸', () => {
  // `-- 理由` は説明であって規則名ではない。これでも全部の指摘が消える。
  assert.equal(scanSource('const a = 1; // eslint-disable-line -- あとで直す\n').length, 1);
});

// ── ② 規則名が有れば裸ではない ──────────────────────────────────────
t('緑: 規則名あり（行）', () => {
  assert.equal(scanSource('const a = 1; // eslint-disable-line no-unused-vars\n').length, 0);
});
t('緑: 規則名あり + 理由', () => {
  assert.equal(scanSource('// eslint-disable-next-line react-hooks/exhaustive-deps -- なぜ要らないか\nconst a = 1;\n').length, 0);
});
t('緑: 規則名が複数', () => {
  assert.equal(scanSource('/* eslint-disable no-undef, no-empty */\n').length, 0);
});

// ── ③ 文章の中の言及は数えない ──────────────────────────────────────
t('緑: 日本語の説明の中に eslint-disable-line と書いてあるだけ', () => {
  const src = '  //   ⚠行末が **規則名なしの `// eslint-disable-line`** だったので警告ごと消えていた。\n';
  assert.equal(scanSource(src).length, 0, '文章の中の言及を数えると、直した本人が永久に赤になる');
});
t('緑: コメントの先頭が指示でなければ指示ではない（eslint と同じ判定）', () => {
  assert.equal(scanSource('// TODO eslint-disable-line を消す\n').length, 0);
});
t('classifyComment: 指示でなければ null', () => {
  assert.equal(classifyComment(' ただのコメント'), null);
  assert.equal(classifyComment(' eslint-disable-line')?.bare, true);
  assert.equal(classifyComment(' eslint-disable-line no-undef')?.bare, false);
});

// ── ④ 基準値の判定 ──────────────────────────────────────────────────
t('赤: 基準値より増えたら不合格', () => {
  const r = compare(new Array(21).fill({}), { max: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.over, 1);
});
t('緑: 基準値と同じなら合格', () => {
  assert.equal(compare(new Array(20).fill({}), { max: 20 }).ok, true);
});
t('緑: 減ったら合格（紙を下げてと言うだけ）', () => {
  const r = compare(new Array(3).fill({}), { max: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.cur, 3);
});
t('赤: 紙が壊れていたら max=0 扱いで、1件でも赤（黙って通さない）', () => {
  assert.equal(compare([{}], {}).ok, false);
  assert.equal(compare([], {}).ok, true);
});

// ── ⑤ 本物の src を1回食べて、動く事を確かめる ──────────────────────
t('本物の src を読む（作り物だけを食べて永久に緑、をやらない）', () => {
  // 2026-08-23 の教訓: 試験のスタブだけを食べる見張りは永久に緑になる。
  const found = scanTree();
  assert.ok(Array.isArray(found), 'scanTree は配列を返す');
  for (const h of found) {
    assert.ok(h.file && h.line > 0, '見つけた物には file と line が付く（どこかを言えないと直せない）');
  }
  console.log(`     （いまの src の裸の抑制: ${found.length}件）`);
});

console.log(`\n✅ ${n}件すべて合格。この見張りは わざと裸の抑制を足すと赤になります。`);
