#!/usr/bin/env node
// =============================================================================
// 🚦 規則名を書かない eslint-disable の見張り（基準値＝baseline 方式）
// -----------------------------------------------------------------------------
// なぜこれが要るか（2026-08-30）:
//   4アプリの src を数えたら、`// eslint-disable…` が **81件**あり、そのうち
//   製品21件・最終6件・部品3件は **規則名が書かれていなかった**。
//   規則名を書かない抑制は **その行の指摘を全部**消すので、後から入った別の欠陥まで
//   道連れで見えなくなる。
//
//   実際にそれで1件、本物の欠陥が隠れていた:
//     製品 src/App.jsx の analysisData が
//       `}, [lots, targetTolerance]); // eslint-disable-line`
//     で、期間(defectFilter*)が deps に入っていない事を誰も知らないまま
//     **期間を選び直しても工程改善分析の表が変わらなかった**（Excel/PDF も古い数字）。
//     兄弟の defectStats/complaintStats は4つとも並べてあったので、書き忘れと分かる。
//
// 決め方:
//   ① 規則名を書かない抑制は赤。書くなら `// eslint-disable-next-line 規則名 -- 理由`
//   ② 🚨ただし **いま在る分をいきなり赤にすると門が通らなくなる**ので、
//      lint-baseline と同じ「基準値＝いまの数から増やさない」方式にする。
//      減らすのは歓迎（紙を下げてと言う）。
//   ③ 新しく1件でも足したら赤。
//
// ⚠この見張り自身の試験は scripts/selftest-bare-eslint-disable.mjs にある。
//   「嘘の合格」を出さない事（わざと裸の抑制を足したら赤になる事）を毎回確かめる。
//
// ⚠数え方の約束: eslint は「コメントの中身の**先頭**が eslint-disable…」の時だけ
//   指示として扱う。だから日本語の説明文の中に `// eslint-disable-line` と
//   書いてあるだけの行は指示ではなく、ここでも数えない（実際にそう書いた行がある）。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'bare-eslint-disable-baseline.json');

// `npm run check` が見ている範囲と同じにする
export const TARGET_DIR = 'src';
export const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

// 長い物から先に見ないと eslint-disable-line が eslint-disable に食われる
const DIRECTIVES = ['eslint-disable-next-line', 'eslint-disable-line', 'eslint-disable'];

/**
 * コメントを1つ受け取り、それが「規則名の無い抑制」かどうかを返す純関数。
 * @param body コメントの中身（`//` や `/* *\/` を外した物）
 * @returns { directive, bare } | null （抑制でなければ null）
 */
export function classifyComment(body) {
  const t = String(body).trim();
  const d = DIRECTIVES.find(x => t === x || t.startsWith(x + ' ') || t.startsWith(x + '\t') || t.startsWith(x + '\n'));
  if (!d) return null;                       // 先頭が指示でなければ、ただの文章
  let rest = t.slice(d.length).trim();
  // `-- 理由` は説明であって規則名ではない。説明だけの抑制も「規則名なし」。
  const dash = rest.indexOf('--');
  if (dash >= 0) rest = rest.slice(0, dash).trim();
  rest = rest.replace(/,/g, ' ').trim();
  return { directive: d, bare: rest.length === 0 };
}

/**
 * ソース1本から、規則名の無い抑制を全部拾う純関数（ファイルを読まない＝試験しやすい）。
 * ⚠文字列の中の `//` も一応コメント扱いになるが、その中身が eslint-disable で
 *   始まる事はまず無いので、数え間違いにはならない。
 */
export function scanSource(text) {
  const hits = [];
  const lines = String(text).split('\n');
  // 行コメント
  lines.forEach((line, i) => {
    const at = line.indexOf('//');
    if (at < 0) return;
    const c = classifyComment(line.slice(at + 2));
    if (c && c.bare) hits.push({ line: i + 1, directive: c.directive, text: line.trim().slice(0, 160) });
  });
  // ブロックコメント（/* eslint-disable */ はファイル丸ごと効くので一番危ない）
  const re = /\/\*([\s\S]*?)\*\//g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = classifyComment(m[1]);
    if (c && c.bare) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ line, directive: c.directive, text: m[0].replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
      else if (EXTS.has(path.extname(e.name))) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function scanTree(root = ROOT, targetDir = TARGET_DIR) {
  const base = path.join(root, targetDir);
  const found = [];
  for (const f of listFiles(base)) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const h of scanSource(text)) found.push({ file: path.relative(root, f).replace(/\\/g, '/'), ...h });
  }
  return found;
}

/** 判定の本体。⚠ファイルを読まない純関数（試験が作り物の数字で確かめられる為） */
export function compare(found, baseline) {
  const limit = Number(baseline && baseline.max);
  const max = Number.isFinite(limit) ? limit : 0;
  const cur = found.length;
  return { ok: cur <= max, cur, max, over: Math.max(0, cur - max) };
}

export function buildBaseline(found) {
  const byFile = {};
  for (const h of found) byFile[h.file] = (byFile[h.file] || 0) + 1;
  return {
    '_これは何': '🚦 規則名を書かない eslint-disable を「今より増やさない」為の基準値。scripts/verify-bare-eslint-disable.mjs が使う。',
    '_なぜ在るか': '2026-08-30: 4アプリで81件の抑制のうち30件が規則名なしで、その中に本物の欠陥が1件隠れていた（製品 analysisData の期間が効かない）。',
    '_正しい書き方': '// eslint-disable-next-line react-hooks/exhaustive-deps -- なぜ要らないかを1行で',
    '_やってはいけない事': '🚨 赤を消す為にこの数字を上げる事。新しく足した抑制には必ず規則名を書く事。',
    '_減った時': 'node scripts/verify-bare-eslint-disable.mjs --update で下げる。下げないと、また増えても気づけない。',
    '_更新日': (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })(),
    max: found.length,
    _内訳: byFile,
  };
}

async function main() {
  const update = process.argv.includes('--update');
  const found = scanTree();

  console.log('──────────────────────────────────────────────────────────────');
  console.log(`🚦 規則名を書かない eslint-disable の見張り（対象: ${TARGET_DIR}）`);
  console.log(`   いま: ${found.length}件`);
  console.log('──────────────────────────────────────────────────────────────');

  if (update) {
    const next = buildBaseline(found);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`📝 基準値を書き直しました: ${path.relative(ROOT, BASELINE_FILE)} （max=${next.max}）`);
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`❌ 基準値の紙がありません: ${path.relative(ROOT, BASELINE_FILE)}`);
    console.error('   作る: node scripts/verify-bare-eslint-disable.mjs --update');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const { ok, cur, max, over } = compare(found, baseline);

  if (found.length) {
    console.log('  いま在る分（基準値の内なら止めません）:');
    for (const h of found.slice(0, 40)) console.log(`   ・${h.file}:${h.line}  ${h.text}`);
    if (found.length > 40) console.log(`   …ほか ${found.length - 40}件`);
  }

  if (cur < max) {
    console.log(`\n🎉 ${max}件 → ${cur}件 に減りました。`);
    console.log('   → 基準値を下げてください: node scripts/verify-bare-eslint-disable.mjs --update');
    console.log('     （下げないと、また増えた時に気づけません）');
  }

  if (ok) {
    console.log(`\n✅ 規則名なしの抑制は基準値(${max}件)から増えていません。`);
    process.exit(0);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`🚦 ❌ 不合格。出荷しないでください。基準値 ${max}件 → いま ${cur}件（${over}件 増えた）`);
  console.log('   🚨 規則名を書かない抑制は、その行の指摘を **全部** 消します。');
  console.log('      後から入った別の欠陥まで道連れで見えなくなります。');
  console.log('   直し方: 消したい規則の名前を書く。');
  console.log('      // eslint-disable-next-line react-hooks/exhaustive-deps -- なぜ要らないかを1行で');
  console.log('──────────────────────────────────────────────────────────────');
  process.exit(1);
}

// import された時は走らせない（見張り自身の試験が中身だけ使える為）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
