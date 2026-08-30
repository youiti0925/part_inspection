#!/usr/bin/env node
// =============================================================================
// 🧩 JSX見張り — eslint が JSXタグを見ない穴をふさぐ
// -----------------------------------------------------------------------------
// なぜ要るか(2026-08-29):
//   この eslint 設定では no-undef が JSXタグ(<Foo/>)の Foo を「使った名前」として
//   数えない。import忘れ・定義忘れの部品はビルドも通り、実行時に初めて白画面になる。
//   実例: golden src/App.jsx の <ComplaintModal/>(どこにも定義が無い)。
// 作り(柱は「黙って緑にしない」):
//   1) @babel/parser で AST にする。解決は createRequire(直接→推移的依存の順)。
//      解決に失敗したら **赤で止まる**(道具が無いのに緑、を許さない)。
//   2) ファイル内の束縛(import・宣言・関数の引数・catchの受け・代入)を
//      **1つの集合** に集める。有効範囲(スコープ)は追わない=
//      「どこかで束縛されていれば合格」。見逃しは少し残るが、偽の赤を出さない側に倒す。
//   3) JSXタグの根元の名前が集合に無ければ未定義=赤。
//      ・小文字始まり(div等)とダッシュ入り(web-component)は組み込みタグなので対象外
//      ・<Foo.Bar/> は根元 Foo で判定(<this.X/> と <svg:path> は対象外)
//   4) 構文が読めないファイルも赤(黙って飛ばすと、そのファイルは一生見ない事になる)。
//   5) 走査対象が 0件 なら赤(フォルダ名の変更・パターンの崩れで黙って緑、を止める)。
//   6) 自己試験7本を毎回先に走らせる(見張り自身が壊れたら実走査せず赤)。
// 除外(🚨黙って除外しない — 実行のたびに理由を1行出す):
//   golden の src/App.jsx は休眠の PocketBase 版(main.jsx でコメントアウト中・
//   現用は App.firebase.jsx)で、既知の未定義 <ComplaintModal/> を含む。
//   休眠ファイルで門を赤くしない為に、リポジトリ名で引いた除外表から外す。
//   復活させる時はこの除外を外す事。
// 走査対象: src/**/*.jsx(Vite は .js に JSX を書かせない為 .jsx だけで足りる)
// 使い方: node scripts/check-jsx-undefined.mjs   (exit 0=緑 / 1=赤)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// -----------------------------------------------------------------------------
// リポジトリごとの除外表。このファイルは製品/goldenで内容一致(md5同一)にする約束なので、
// 「どちらのリポジトリか」は package.json の name で引く。
// ⚠製品の src/App.jsx は現用の本体。golden 以外では絶対に除外しない。
// -----------------------------------------------------------------------------
const EXCLUDES_BY_REPO = {
  'golden-meteoroid': [
    {
      file: 'src/App.jsx',
      reason:
        '休眠のPocketBase版(main.jsxでコメントアウト中・現用はApp.firebase.jsx)。既知の未定義<ComplaintModal/>を含む。復活させる時はこの除外を外す事',
    },
  ],
};

function repoName() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name || '';
  } catch {
    return '';
  }
}

// -----------------------------------------------------------------------------
// 1) @babel/parser の解決 — 失敗したら赤(黙って緑にしない)
//    直接 require → 見つからなければ推移的依存をたどる
//    (@vitejs/plugin-react → @babel/core → @babel/parser)。
// -----------------------------------------------------------------------------
function resolveBabelParser() {
  const tried = [];
  try {
    return { parser: require('@babel/parser') };
  } catch (e) {
    tried.push(`直接: ${String(e.message).split('\n')[0]}`);
  }
  try {
    const r1 = createRequire(require.resolve('@vitejs/plugin-react/package.json'));
    const r2 = createRequire(r1.resolve('@babel/core/package.json'));
    return { parser: r2('@babel/parser') };
  } catch (e) {
    tried.push(`推移的依存(@vitejs/plugin-react→@babel/core): ${String(e.message).split('\n')[0]}`);
  }
  return { tried };
}

// -----------------------------------------------------------------------------
// AST 歩き(汎用)。type を持つ物だけを辿る。位置情報やコメントは辿らない。
// -----------------------------------------------------------------------------
const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range',
  'leadingComments', 'trailingComments', 'innerComments', 'comments', 'extra',
]);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    walk(node[key], visit);
  }
}

// 分割代入(オブジェクト/配列/初期値付き/rest)の中の名前も全部拾う
function addPatternNames(p, into) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': into.add(p.name); return;
    case 'ObjectPattern':
      for (const prop of p.properties) {
        if (prop.type === 'RestElement') addPatternNames(prop.argument, into);
        else addPatternNames(prop.value, into);
      }
      return;
    case 'ArrayPattern':
      for (const el of p.elements) addPatternNames(el, into);
      return;
    case 'AssignmentPattern': addPatternNames(p.left, into); return;
    case 'RestElement': addPatternNames(p.argument, into); return;
    default: return;
  }
}

// 束縛を1つの集合に集める(import・宣言・引数・catch・代入)
function collectBinding(node, into) {
  switch (node.type) {
    case 'ImportDefaultSpecifier':
    case 'ImportSpecifier':
    case 'ImportNamespaceSpecifier':
      if (node.local) into.add(node.local.name);
      return;
    case 'VariableDeclarator': addPatternNames(node.id, into); return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) into.add(node.id.name);
      if (node.params) for (const p of node.params) addPatternNames(p, into);
      return;
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      if (node.params) for (const p of node.params) addPatternNames(p, into);
      return;
    case 'CatchClause': addPatternNames(node.param, into); return;
    case 'AssignmentExpression':
      // 宣言なしの代入(まれ)。実行時には名前が居るので、偽の赤を出さない側に倒す。
      if (node.left && node.left.type === 'Identifier') into.add(node.left.name);
      return;
    default: return;
  }
}

// JSXタグの「根元の名前」。組み込みタグ(小文字始まり・ダッシュ入り)、
// <this.X/>、名前空間タグ(<svg:path>)は対象外なので null。
function rootTagName(nameNode) {
  if (!nameNode) return null;
  if (nameNode.type === 'JSXMemberExpression') {
    let o = nameNode.object;
    while (o && o.type === 'JSXMemberExpression') o = o.object;
    if (o && o.type === 'JSXIdentifier' && o.name !== 'this') return o.name;
    return null;
  }
  if (nameNode.type === 'JSXIdentifier') {
    const n = nameNode.name;
    if (/^[a-z]/.test(n) || n.includes('-')) return null; // 組み込みタグ
    return n;
  }
  return null;
}

// 1ファイルぶんの判定。構文が読めなければ parseError を返す(呼び手が赤にする)。
function analyzeSource(parser, code) {
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx'],
      errorRecovery: false,
    });
  } catch (e) {
    return { parseError: String(e.message).split('\n')[0] };
  }
  const bindings = new Set();
  const usages = [];
  walk(ast.program, (node) => {
    collectBinding(node, bindings);
    if (node.type === 'JSXOpeningElement') {
      const name = rootTagName(node.name);
      if (name) usages.push({ name, line: node.loc ? node.loc.start.line : 0 });
    }
  });
  return { findings: usages.filter((u) => !bindings.has(u.name)) };
}

// 走査結果の判定。0件走査は赤・構文が読めないファイルも赤・未定義も赤。
function verdict(scan) {
  const reasons = [];
  if (scan.fileCount === 0) {
    reasons.push('走査対象が0件(フォルダ名の変更やパターンの崩れでも黙って緑にはしない)');
  }
  for (const pe of scan.parseErrors) reasons.push(`構文が読めない: ${pe.file} — ${pe.message}`);
  for (const f of scan.findings) reasons.push(`未定義の部品: ${f.file}:${f.line} <${f.name}>(importも定義も見つからない)`);
  return { ok: reasons.length === 0, reasons };
}

// src/ 配下の .jsx を全部列挙(決め打ちの再帰。globの実装差に依存しない)
function listJsxFiles(dir) {
  const out = [];
  const walkDir = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.isFile() && ent.name.endsWith('.jsx')) out.push(full);
    }
  };
  walkDir(dir);
  return out.sort();
}

function runScan(parser, excludes) {
  const srcDir = path.join(ROOT, 'src');
  const all = listJsxFiles(srcDir).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

  // 除外表にあるのに実物が無い時も黙らない(削除済みなら表から外してもらう)
  for (const e of excludes) {
    if (!all.includes(e.file)) {
      console.log(`  ⚠ 除外指定 ${e.file} が src に見当たりません(削除済みなら EXCLUDES_BY_REPO から外してください)`);
    }
  }

  const excludedSet = new Set(excludes.map((e) => e.file));
  const files = [];
  for (const rel of all) {
    if (excludedSet.has(rel)) {
      const ex = excludes.find((e) => e.file === rel);
      console.log(`  ⚠ 除外: ${rel} — ${ex.reason}`);
      continue;
    }
    files.push(rel);
  }

  const findings = [];
  const parseErrors = [];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const r = analyzeSource(parser, code);
    if (r.parseError) parseErrors.push({ file: rel, message: r.parseError });
    else for (const f of r.findings) findings.push({ file: rel, line: f.line, name: f.name });
  }
  return { fileCount: files.length, findings, parseErrors };
}

// -----------------------------------------------------------------------------
// 自己試験7本。見張り自身が壊れたら実走査せず赤(嘘の緑を出さない)。
// 1〜6 は実走査と同じ analyzeSource を、7 は実走査と同じ verdict を食う。
// -----------------------------------------------------------------------------
const SELF_TESTS = [
  {
    name: '未定義の大文字タグ <Missing/> を見つける',
    code: 'export default function A(){ return <Missing/>; }',
    check: (r) => !r.parseError && r.findings.length === 1 && r.findings[0].name === 'Missing',
  },
  {
    name: 'import した部品は合格',
    code: "import Foo from './x.jsx';\nexport default () => <Foo/>;",
    check: (r) => !r.parseError && r.findings.length === 0,
  },
  {
    name: 'ファイル内で定義した部品(function/const)は合格',
    code: 'function Bar(){ return null; }\nconst Baz = () => null;\nexport default () => <div><Bar/><Baz/></div>;',
    check: (r) => !r.parseError && r.findings.length === 0,
  },
  {
    name: '小文字タグ(div等)とダッシュ入りタグは対象外',
    code: 'export default () => <div><span/><my-element/></div>;',
    check: (r) => !r.parseError && r.findings.length === 0,
  },
  {
    name: '<Foo.Bar/> は根元で判定(import済は合格・無い根元は赤)',
    code: "import * as Icons from './i.js';\nexport default () => <div><Icons.Check/><Ghost.Tail/></div>;",
    check: (r) => !r.parseError && r.findings.length === 1 && r.findings[0].name === 'Ghost',
  },
  {
    name: '構文が読めないファイルは赤',
    code: 'const a = <div',
    check: (r) => !!r.parseError,
  },
  {
    name: '走査0件は赤(node --test の「0件でexit 0」と同じ穴を許さない)',
    special: true,
    check: () => {
      const v = verdict({ fileCount: 0, findings: [], parseErrors: [] });
      return v.ok === false && v.reasons.length === 1;
    },
  },
];

function main() {
  const t0 = Date.now();
  console.log('🧩 JSX見張り(check-jsx-undefined) — eslintがJSXタグを見ない穴');

  const resolved = resolveBabelParser();
  if (!resolved.parser) {
    console.log('  🚨 @babel/parser の解決に失敗しました。道具が無いまま緑は出しません。');
    for (const t of resolved.tried) console.log(`     - ${t}`);
    console.log('     → node_modules を作り直してから(npm ci)もう一度走らせてください。');
    process.exit(1);
  }
  const parser = resolved.parser;

  // --- 自己試験 ---
  let pass = 0;
  for (let i = 0; i < SELF_TESTS.length; i++) {
    const t = SELF_TESTS[i];
    let good = false;
    try {
      good = t.special ? t.check() === true : t.check(analyzeSource(parser, t.code)) === true;
    } catch (e) {
      console.log(`     (試験中の例外: ${String(e.message).split('\n')[0]})`);
      good = false;
    }
    console.log(`  ${good ? '✅' : '❌'} 自己試験 ${i + 1}/${SELF_TESTS.length}: ${t.name}`);
    if (good) pass++;
  }
  if (pass !== SELF_TESTS.length) {
    console.log(`\n  🚨 自己試験 ${pass}/${SELF_TESTS.length} 合格。見張り自身が壊れています。実走査はせず赤で止めます。`);
    process.exit(1);
  }

  // --- 実走査 ---
  const excludes = EXCLUDES_BY_REPO[repoName()] || [];
  const scan = runScan(parser, excludes);
  const v = verdict(scan);
  const ms = Date.now() - t0;

  if (v.ok) {
    console.log(`  ✅ 実走査: ${scan.fileCount}ファイル・未定義0件 (${ms}ms)`);
    process.exit(0);
  }
  console.log(`  ❌ 実走査: ${scan.fileCount}ファイル (${ms}ms)`);
  for (const r of v.reasons) console.log(`     - ${r}`);
  console.log('  🚨 見張りを緩めて緑にしないでください。未定義の部品(import忘れ/定義忘れ)の方を直してください。');
  process.exit(1);
}

main();
