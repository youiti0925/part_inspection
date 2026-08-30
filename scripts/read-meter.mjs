// ============================================================================
// 📏 見張りが「実際に何を読んだか」を数える計測器(preload)。
// ----------------------------------------------------------------------------
//   使い方(単体では使わない。verify-watchdogs-read-code.mjs が呼ぶ):
//     READ_METER_OUT=<出力先> node --import ./scripts/read-meter.mjs <見張り.mjs>
//
// 🚨🚨 なぜ要るか(2026-08-30 に同じ形を3件見つけた):
//   ① 試験の道具がリポジトリに無く、72件の試験が静かに飛んでいた
//   ② 依存の並びを門と数えていた(門を消しても緑)
//   ③ 製品の check-load-guards が `src/App.firebase.jsx` 決め打ちで、製品にその
//      ファイルが無く「対象が無いので省略」→ **終了値0**。一度も実コードを食っていなかった。
//   共通の形は「**何も読んでいないのに緑**」。読んだ物を数えれば機械で見つかる。
//
// ⚠⚠ ここは **計測だけ** する。判定は verify-watchdogs-read-code.mjs 側でやる。
// 🚨 書き込みは **止める**(投げる)。人のリポジトリを測るのに、測る側が中身を変えては
//   いけない。止めた事は記録に残す(黙って握り潰さない)。
// ============================================================================
// 🚨🚨 ここで `import fs from 'node:fs'` と書いてはいけない(実測で嘘の赤を出した)。
//   ESM の `import { readFileSync } from 'node:fs'` は、**その組み込みモジュールが
//   最初に import された時点の中身を写し取る**。計測器が先に import してしまうと、
//   後から差し替えても写しの方が使われ、**名前付きで読む見張りの読み取りが1件も
//   数えられない**。実測: golden の verify-promises.mjs(名前付き import)が
//   「0件・終了値0」＝ 嘘の赤 になった。
//   → import せずに素の中身を取り、**差し替えてから** 見張りに import させる。
const fs = process.getBuiltinModule('node:fs');
const fsp = process.getBuiltinModule('node:fs/promises');
const path = process.getBuiltinModule('node:path');

const OUT = process.env.READ_METER_OUT || '';
// 🚨 記録の置き場所だけは自分の網から外す。
//   ⚠ 以前ここを「一時フォルダ全部」にしていたら、**一時フォルダに作った見本の
//     リポジトリで読んだ物まで数えなくなり、自己試験が嘘の不合格を出した**(実測)。
//     外すのは記録1本だけにする。
const OUT_ABS = OUT ? path.resolve(OUT) : '';

// 🚨 差し替える前の本物を控えておく(記録を書くのに使う。自分の網に掛からない為)。
const realWriteFileSync = fs.writeFileSync;

const reads = new Map();   // 実際の path → { bytes, viaLoader }
const blockedWrites = [];  // 止めた書き込み

/**
 * 🚨🚨 **見張り自身の読み込み(import)を「実コードを食った」と数えない。**
 *   node は `import` の時にもファイルを読む。そこまで数えると、
 *   **1行も検査していない見張りでも「1ファイル読んだ」になり、永久に緑**になる。
 *   ＝ 今日3件見つけた形を、この道具自身が繰り返す事になる。
 *   見分け方: import で読む時は呼び出し元が node の内側(node:internal/modules/…)。
 *   見張りが自分で `fs.readFileSync(…)` と書いた時は、その枠が出てこない。
 */
const calledByModuleLoader = () => {
  // ⚠⚠ 「stack のどこかに node:internal/modules が在るか」で見てはいけない。
  //   見張りの **一番外側の行**(トップレベル)は import の続きとして走るので、
  //   自分で readFileSync を書いていても loader の枠が下に残る。
  //   → 見るのは **すぐ上の呼び出し元1枠だけ**。
  const st = String(new Error().stack || '').split('\n');
  // 0行目 = "Error"、1行目 = この計測器の中の包み。2行目が呼び出し元。
  const caller = st.slice(1).find((l) => !l.includes('read-meter.mjs')) || '';
  return /node:internal[\\/]modules[\\/]/.test(caller);
};

const isMeterOut = (p) => {
  try { return !!OUT_ABS && path.resolve(String(p)).toLowerCase() === OUT_ABS.toLowerCase(); }
  catch { return false; }
};

/** アプリの中身(src/ の下)か。 */
const isSrcPath = (p) => {
  try { return path.resolve(String(p)).includes(`${path.sep}src${path.sep}`); }
  catch { return false; }
};

// 🚨 見張り自身のファイルは数えない。自分を読んでも何も検査していない。
const SELF = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';

const note = (p) => {
  try {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return; // fd などは数えない
    const s = p instanceof URL ? p.pathname.replace(/^\/([A-Za-z]:)/, '$1') : String(p);
    const abs = path.resolve(s);
    if (abs.includes(`${path.sep}node_modules${path.sep}`)) return; // 道具の中身は「実コード」ではない
    if (isMeterOut(abs)) return;                                    // 計測器の記録そのもの
    if (SELF && abs.toLowerCase() === SELF) return;                 // 見張り自身
    const viaLoader = calledByModuleLoader();
    const had = reads.get(abs);
    // 同じファイルを import でも自分でも読んだ時は「自分で読んだ」を優先する。
    if (had && (!had.viaLoader || viaLoader)) return;
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { size = 0; }
    reads.set(abs, { bytes: size, viaLoader });
  } catch { /* 計測でこけて本体を巻き込まない */ }
};

const wrapRead = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...args) { note(args[0]); return orig.apply(this, args); };
};

/**
 * 🚨 `openSync`/`open` は node が **import の時** に使う低い所。ここを普通に数えると
 *   見張り自身の読み込みまで「実コードを食った」になる(実測)。
 *   でも **src/ の下を import した時** は、本物の関数を呼んで確かめる見張り
 *   (node --test の形)なので「食った」で正しい。→ **src/ の下だけ** 数える。
 */
const wrapOpen = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...args) {
    try { if (isSrcPath(args[0])) note(args[0]); } catch { /* 計測で本体を巻き込まない */ }
    return orig.apply(this, args);
  };
};
const blockWrite = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...args) {
    if (isMeterOut(args[0])) return orig.apply(this, args);
    blockedWrites.push(`${name}(${String(args[0]).slice(0, 160)})`);
    throw new Error(`📏 計測中は書き込みを止めています: ${name} ${String(args[0]).slice(0, 160)}`);
  };
};

for (const n of ['readFileSync', 'readFile', 'createReadStream', 'globSync']) wrapRead(fs, n);
// ⚠ `openSync`/`open` は **src/ の下だけ** 数える(上の wrapOpen を見る事)。
for (const n of ['openSync', 'open']) wrapOpen(fs, n);
for (const n of ['open']) wrapOpen(fsp, n);
if (fs.promises) for (const n of ['open']) wrapOpen(fs.promises, n);
for (const n of ['readFile', 'glob']) wrapRead(fsp, n);
if (fs.promises) for (const n of ['readFile', 'glob']) wrapRead(fs.promises, n);
for (const n of ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'cpSync', 'copyFileSync', 'createWriteStream']) blockWrite(fs, n);
for (const n of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'cp', 'copyFile']) blockWrite(fsp, n);
if (fs.promises) for (const n of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'cp', 'copyFile']) blockWrite(fs.promises, n);

const dump = () => {
  if (!OUT) return;
  const all = [...reads.entries()].map(([p, v]) => ({ path: p, bytes: v.bytes, viaLoader: v.viaLoader }));
  // 🚨 「実コードを食った」と数えるのは次の2つ。
  //   ① 自分で読んだ物(fs.readFileSync など)… 中身を機械で調べる見張り
  //   ② **import した物のうち src/ の下**   … 本物の関数を呼んで確かめる見張り
  //      (node --test の形。これを数えないと、本物の domain を呼ぶ見張りが嘘の赤になる)
  //   ⚠ import した物でも scripts/ の下は **自分の道具**。数えない。
  //     数えると「1行も検査していない見張り」が永久に緑になり、この道具が嘘になる。
  const isSrc = (p) => `${path.sep}${p}`.includes(`${path.sep}src${path.sep}`)
    || p.includes(`${path.sep}src${path.sep}`);
  const files = all.filter((f) => !f.viaLoader || isSrc(f.path));
  const rec = {
    cwd: process.cwd(),
    files,
    loaded: all.filter((f) => f.viaLoader && !isSrc(f.path)).map((f) => f.path),
    fileCount: files.length,
    byteTotal: files.reduce((a, f) => a + f.bytes, 0),
    blockedWrites,
  };
  try { realWriteFileSync.call(fs, OUT, JSON.stringify(rec)); } catch { /* 記録が書けなくても本体は止めない */ }
};
process.on('exit', dump);
