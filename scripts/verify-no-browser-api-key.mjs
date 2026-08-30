#!/usr/bin/env node
// =============================================================================
// 🔑 ブラウザに鍵を置いていないか — 「公開バンドルに秘密が焼き込まれる」を止める
// -----------------------------------------------------------------------------
// なぜこれが要るか(2026-07 に実際に起きた):
//   機番AIが 403 になった。調べたら **Gemini の鍵が漏れていた**。
//   原因は2つ重なっていた:
//     ① `.env` をコミットした
//     ② `VITE_` で始まる値は **ビルド時にそのまま JS へ焼き込まれる**
//   焼き込まれた JS は Hosting から全世界へ配られる。つまり
//   「ブラウザから `?key=${apiKey}` で直に API を叩く」形は、**鍵を配る形**そのもの。
//   直し方は Cloudflare Worker を挟む事(鍵は Worker の secret にだけ置く)。
//
// 🚨 「いまは .env に値が入っていないから安全」は理由になりません。
//   コードに口が残っている限り、**次に誰かが値を入れた瞬間に漏れます**。
//   だから「値が在るか」ではなく **「口が在るか」** を見張ります。
//
// ⚠⚠ **説明のコメントは食べない。** この見張り自身が
//   「鍵を置くな」と書いた戒めのコメントを拾って赤にすると、
//   人はコメントを消して黙らせます(＝いちばん大事な注意書きが消える)。
//   だから **コメントを外してから** 実コードだけを見ます。
//   ⚠逆に、コメントの中に鍵の口を隠して素通りさせる事もできません
//     (コメントの中は動かないので、そこに口は作れない)。
//
// 見ている物:
//   K1 `import.meta.env.VITE_〇〇` の 〇〇 が 鍵・秘密・合言葉らしい名前
//   K2 URL に `?key=` / `&key=` を **組み立てて** 付けている(値が変数で入る形)
//   K3 ブラウザから Google の生成AIの口(generativelanguage.googleapis.com)を直に叩く
//
// ⚠ Firebase の web 用 apiKey は **公開前提の値**なので対象外です
//   (`apiKey:` という鍵名だけでは赤くしない)。見るのは上の3つだけ。
//
// 使い方:
//   node scripts/verify-no-browser-api-key.mjs             … 自己試験 → src を判定
//   node scripts/verify-no-browser-api-key.mjs --selftest  … 自己試験だけ
//
// 🚨 4アプリ共通で使えます(部品/最終/製品/司令塔③)。
//   休眠ファイル(main.jsx から外してある物)は **名指しはするがゲートは赤くしない**。
//   その一覧は下の DORMANT_BY_REPO に、理由つきで書いてあります。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.NO_BROWSER_KEY_ROOT || path.resolve(__dirname, '..');

// -----------------------------------------------------------------------------
// 休眠ファイル(いま配られていない物)。⚠ **黙って飛ばさない。名指しはする。**
//   ゲートを赤にしないだけ。復活させる時は必ず直す事。
//   リポジトリの見分けは package.json の name(check-jsx-undefined.mjs と同じやり方)。
// -----------------------------------------------------------------------------
const DORMANT_BY_REPO = {
  'golden-meteoroid': [
    { file: 'src/App.jsx', why: '休眠のPocketBase版(main.jsx でコメントアウト中・現用は App.firebase.jsx)。復活させる時は Worker 経由に直す事' },
  ],
};

function repoName() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name || ''; }
  catch { return ''; }
}

/**
 * 説明のコメントを外す(行数は変えない = 行番号がズレない)。
 * ⚠ `accept="video/*"` の `/*` をコメントの始まりと見ないよう、
 *   区切りの後に来た `/*` だけをコメントとみなす(2026-08-16 に実コードを23行飲んだ事故の直し)。
 * ⚠ URL の `//` を消さないよう、直前が `:` の時は行コメントとみなさない。
 */
export const stripComments = (src) => String(src || '')
  .replace(/(^|[\s{(,;=>])\/\*[\s\S]*?\*\//g,
    (m, head) => head + (m.slice(head.length).match(/\n/g) || []).join(''))
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

// -----------------------------------------------------------------------------
// 判定の中身。⚠ここは純関数(自己試験が作り物の文字列で確かめられるように)。
// -----------------------------------------------------------------------------

/** 鍵・秘密・合言葉らしい名前。⚠ URL や FLAG は秘密ではないので入れない。 */
export const SECRET_NAME = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)/i;

export const analyze = (rawSrc, file = '(memory)') => {
  const src = stripComments(rawSrc);
  const lines = src.split('\n');
  const findings = [];
  const at = (idx) => src.slice(0, idx).split('\n').length;
  const add = (id, line, why) =>
    findings.push({ id, file, line, why, code: String(lines[line - 1] || '').trim().slice(0, 160) });

  // --- K1: import.meta.env.VITE_〇〇 の 〇〇 が 秘密らしい名前 -----------------
  //   🚨 VITE_ で始まる値は **ビルドで公開バンドルに焼き込まれる**。
  //   ⚠ VITE_GEMINI_PROXY_URL / VITE_DRIVE_PROXY_URL は URL なので対象外(秘密ではない)。
  for (const m of src.matchAll(/import\s*\.\s*meta\s*\.\s*env\s*\.\s*(VITE_[A-Z0-9_]+)/g)) {
    if (!SECRET_NAME.test(m[1])) continue;
    add('K1', at(m.index),
      `🚨 ${m[1]} をブラウザ側のコードで読んでいる。VITE_ の値は **ビルドで公開バンドルへ焼き込まれ**、`
      + 'Hosting から全世界へ配られる(2026-07 の鍵の漏洩そのもの)。'
      + '鍵はサーバ(Cloudflare Worker)の secret にだけ置き、ブラウザは Worker を呼ぶ事');
  }

  // --- K2: URL に key= を組み立てて付けている ---------------------------------
  //   `?key=${apiKey}` / `&key=' + apiKey` の形。**値が変数で入る**物だけを見る
  //   (`?key=固定文字` は秘密の受け渡しではないので数えない)。
  for (const m of src.matchAll(/[?&]key=\s*(?:\$\{|['"`]?\s*\+)/g)) {
    add('K2', at(m.index),
      '🚨 URL に `key=` を **組み立てて** 付けている。ブラウザから送る URL は、'
      + '通信の記録・拡張機能・共有された画面から丸見えになる。'
      + 'サーバ(Worker)側で付ける事');
  }

  // --- K3: ブラウザから Google の生成AIの口を直に叩いている --------------------
  for (const m of src.matchAll(/generativelanguage\.googleapis\.com/g)) {
    add('K3', at(m.index),
      '🚨 ブラウザから Google の生成AIの口を直に叩いている。'
      + 'この形は必ず鍵をブラウザへ置く事になる。Worker 経由にする事');
  }

  findings.sort((a, b) => a.line - b.line);
  return { file, findings };
};

// -----------------------------------------------------------------------------
// 見張り自身の試験。⚠ **作り物だけで信じない**ようにする為、
//   「本物は通す / 偽物は落ちる / コメントは食べない」を毎回確かめる。
// -----------------------------------------------------------------------------
export const selftest = () => {
  let bad = 0;
  const say = (ok, what) => { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) bad++; };
  console.log('🧪 見張り自身の試験');

  const k1 = analyze("const k = import.meta.env.VITE_GEMINI_API_KEY || '';", '(K1)');
  say(k1.findings.some((f) => f.id === 'K1'), '直す前: VITE_〇〇_API_KEY をブラウザで読む形を捕まえる');

  const k1b = analyze("const t = import.meta.env.VITE_SLACK_TOKEN;\nconst s = import.meta.env.VITE_APP_SECRET;", '(K1b)');
  say(k1b.findings.filter((f) => f.id === 'K1').length === 2,
    `直す前: TOKEN / SECRET も捕まえる (実際 ${k1b.findings.filter((f) => f.id === 'K1').length}/2件)`);

  const k2 = analyze('const url = `https://x.example/v1:go?key=${apiKey}`;', '(K2)');
  say(k2.findings.some((f) => f.id === 'K2'), '直す前: URL に key= を組み立てる形を捕まえる');

  const k2b = analyze("const url = 'https://x.example/v1:go?key=' + apiKey;", '(K2b)');
  say(k2b.findings.some((f) => f.id === 'K2'), '直す前: 文字の足し算で key= を付ける形も捕まえる');

  const k3 = analyze("await fetch('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent');", '(K3)');
  say(k3.findings.some((f) => f.id === 'K3'), '直す前: 生成AIの口を直に叩く形を捕まえる');

  // ⚠負の対照 ①: **戒めのコメントを食べない**。ここが一番大事。
  //   食べてしまうと、人は注意書きの方を消して黙らせる(＝一番残したい物が消える)。
  const commented = analyze([
    '// 🚨 import.meta.env.VITE_GEMINI_API_KEY は書かない事',
    '/* 昔は https://generativelanguage.googleapis.com/... を ?key=${apiKey} で叩いていた */',
    "const u = import.meta.env.VITE_GEMINI_PROXY_URL || '';",
  ].join('\n'), '(コメントだけ)');
  say(commented.findings.length === 0,
    `負の対照: 戒めのコメントを実コードとして数えない (実際 ${commented.findings.length}件)`);

  // ⚠負の対照 ②: URL は秘密ではない。プロキシのURLで赤くしない。
  const proxyOk = analyze([
    "const P = import.meta.env.VITE_GEMINI_PROXY_URL || '';",
    "const D = import.meta.env.VITE_DRIVE_PROXY_URL || '';",
    "const E = import.meta.env.VITE_USE_EMULATOR;",
    "await fetch(`${P}/generate`, { method: 'POST' });",
  ].join('\n'), '(Worker 経由・正しい形)');
  say(proxyOk.findings.length === 0,
    `負の対照: Worker 経由の正しい形は通す (実際 ${proxyOk.findings.length}件)`);

  // ⚠負の対照 ③: Firebase の web apiKey は **公開前提**。ここで赤くすると嘘になる。
  const fbCfg = analyze("const USER_DEFINED_CONFIG = { apiKey: 'AIzaSyEXAMPLE', authDomain: 'x.firebaseapp.com' };", '(Firebaseの公開web鍵)');
  say(fbCfg.findings.length === 0,
    `負の対照: Firebase の公開web鍵(apiKey:)を秘密と取り違えない (実際 ${fbCfg.findings.length}件)`);

  // ⚠負の対照 ④: 固定文字の key= は秘密の受け渡しではない
  const fixedKey = analyze("const u = 'https://example.com/list?key=all&sort=asc';", '(固定の key=)');
  say(fixedKey.findings.length === 0,
    `負の対照: 値が変数でない key= は数えない (実際 ${fixedKey.findings.length}件)`);

  // ⚠ 直す前 > 直した後(見張りが空っぽでない事の確認)
  const before = analyze("const k = import.meta.env.VITE_GEMINI_API_KEY;\nconst u = `https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=${k}`;", '(直す前)');
  const after = analyze("const P = import.meta.env.VITE_GEMINI_PROXY_URL || '';\nawait fetch(`${P}/generate`);", '(直した後)');
  say(before.findings.length > after.findings.length && after.findings.length === 0,
    `直す前(${before.findings.length}件) > 直した後(${after.findings.length}件)。見張りが実際に効いている`);

  console.log(bad ? `🧪 見張り自身の試験: ❌ ${bad}件 失敗` : '🧪 見張り自身の試験: 合格');
  return bad === 0;
};

// -----------------------------------------------------------------------------
const listSources = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); continue; }
      if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const main = (args) => {
  if (args.includes('--selftest')) return selftest() ? 0 : 1;
  // ⚠まず見張り自身の試験を通してから実コードを見る。壊れた物差しで「合格」と言わない。
  if (!selftest()) { console.error('❌ 見張り自身が壊れているので、実コードの判定はしません。'); return 1; }
  console.log('');

  const srcDir = path.join(ROOT, 'src');
  if (!fs.existsSync(srcDir)) { console.log('（src が無いので省略）'); return 0; }
  const files = listSources(srcDir);
  // 🚨 走査0件で黙って緑にしない(node --test の「0件でも exit 0」と同じ穴)。
  if (files.length === 0) {
    console.log('❌ src に見るファイルが1つもありません。走査0件を「合格」とは言いません。');
    return 1;
  }

  const dormant = new Map((DORMANT_BY_REPO[repoName()] || []).map((d) => [path.normalize(d.file), d.why]));
  let hard = 0, soft = 0;
  for (const abs of files) {
    const rel = path.normalize(path.relative(ROOT, abs));
    const r = analyze(fs.readFileSync(abs, 'utf8'), rel);
    if (!r.findings.length) continue;
    const why = dormant.get(rel);
    for (const f of r.findings) {
      // 休眠は **名指しはする**(黙って飛ばさない)が、ゲートは赤くしない。
      console.log(`  ${why ? '⚠' : '❌'} [${f.id}] ${rel}:${f.line}`);
      console.log(`      ${f.why}`);
      if (f.code) console.log(`      ${f.code}`);
      if (why) console.log(`      ⚠ いま配られていないファイルなので数には入れません: ${why}`);
      if (why) soft++; else hard++;
    }
  }

  console.log('');
  console.log(`🔑 見たファイル ${files.length}件 / 危ない所 ${hard}件${soft ? ` / いま配られていない所 ${soft}件` : ''}`);
  if (!hard) {
    console.log('✅ ブラウザ側に鍵の口はありません。（AIはサーバ(Worker)経由）');
    return 0;
  }
  console.log('');
  console.log('🚨 この状態で出さないでください。ビルドすると鍵が公開バンドルに入ります。');
  console.log('   直し方: 鍵は Cloudflare Worker の secret に置き、ブラウザは Worker の口を呼ぶ。');
  console.log('   ⚠ 見張りを緩めて緑にしない。VITE_ の名前を変えて逃げるのも同じ事です。');
  return 1;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main(process.argv.slice(2)));
