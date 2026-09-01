// ============================================================================
// 🚨 「繰り返し書く処理」を全部名指しして、1日の書き込み枠を食う速さを出す
// ----------------------------------------------------------------------------
// なぜ要るのか(2026-08-17 の実測):
//   書き込みの1日の枠(20,000回)を使い切ると、Firestore は **黙る**。
//     @firebase/firestore/dist/common-091f2944.esm.js
//       :6028-6042   RESOURCE_EXHAUSTED を「一時エラー」と判定(永続エラーではない)
//       :15733-15738 「Only handle permanent errors here」→ 書き込みは reject されない
//       :15020-15023 最大60秒間隔で無限に再送
//       :16982-16984 Promise はサーバの ack/reject まで解決しない
//   🚨 **await した保存が永久に返らない。失敗にもならない。画面にも何も出ない。**
//   だから「使い切ってから気づく」は手遅れ。**使い切る前に、コードから計算する。**
//
//   実測で分かっている食い方(スマホ中継 live_frames):
//     ・1コマ = 1書類まるごと差し替え(src/liveRooms.js の merge:false)
//     ・8/14〜8/15 の既定 0.5秒×2スロット = 2回/秒 = 7,200回/時 → **2.8時間で枠が尽きる**
//     ・8/16(cfeb128)で 1回/秒 = 3,600回/時 → 5.6時間。2台同時なら半分
//     ・🚨録画していなくても、カメラ画面を開いているだけで送り続ける
//     ・🚨PCがタブを消すと部屋が最大30分残る(ROOM_TTL_MIN) → 誰も見ていないのに書き続ける
//     ・読み取りも同数出る(見る人1人につき、書込1回=読取1回)
//
// この見張りが出す物:
//   ① setInterval / **再帰の setTimeout** の中で保管庫へ書いている処理を **全部** 名指し
//   ② それぞれ 1時間あたり何回書くか
//   ③ 1日の枠(20,000回)を使い切るまで何時間か
//   ④ 🚨 **1つの機能だけで1日の枠の半分(10,000回)以上を使う物が在れば ❌**
//      （1日動かして 10,000回 = 1時間 約417回。さらに「1直(8時間)で半分」なら 🚨 を足す）
//
// ⚠⚠ **いまは ❌ が出るのが正しい。** 合格に見せる為に threshold を緩めない。
//   中継の直しは別の受け持ちが作業中。直ったらこの見張りが黙る。
//
// ⚠⚠ **見張り自身も試験する**(嘘の合格・実コードを食う誤検出を過去に出している)。
//   `--selftest` で「わざと壊した見本なら落ちる／直した見本なら通る」を毎回確かめてから
//   実コードを見る。壊れた物差しで測って「合格」と言わない為。
//
// 使い方:
//   node scripts/verify-write-budget.mjs              … src の下を全部見る
//   node scripts/verify-write-budget.mjs <ファイル…>   … 指定した物だけ見る
//   node scripts/verify-write-budget.mjs --selftest   … 見張り自身の試験
//   node scripts/verify-write-budget.mjs --list       … 指摘があっても止めない(一覧だけ)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// 決め事
// ---------------------------------------------------------------------------
// 🚨 2026-09-01(NC3) **この見張りは4アプリで同じ1つの物**(4つとも md5 が同じ)。
//   だが `src/domain/quotaMeter.js`(枠の数の持ち主)は 製品検査・最終検査にしか無い。
//   静かな `import` のままだと、部品検査・司令塔③では **起動もできず** 段が置けない。
//   → 在れば現物から読む。無ければ 4アプリ共通の1日の枠を使い、**どちらを使ったかを毎回印字する**。
//   ⚠ 数を2か所で持つのは危ないので、現物が在る時は必ず現物が勝つ。
//     黙って既定値へ落ちないよう、出どころは画面に出す(下の main で印字)。
const QUOTA_MOD = await (async () => {
  try { return await import(pathToFileURL(path.join(ROOT, 'src', 'domain', 'quotaMeter.js')).href); }
  catch { return null; }
})();

/** 4アプリ共通の「1日に書ける回数」(Firebase の無料枠)。現物が無いアプリで使う。 */
export const LIMIT_WRITES_SHARED = 20000;

/** その数を **現物から** 取れたか。⚠ 黙って既定値へ落ちていない事を、下の自己試験が毎回見る。 */
export const LIMIT_FROM_FILE = Number(QUOTA_MOD && QUOTA_MOD.QUOTA_LIMITS && QUOTA_MOD.QUOTA_LIMITS.writes) > 0;

/** 1日に書ける回数。⚠ 現物(src/domain/quotaMeter.js)が在る時は **必ず現物** から取る。 */
export const LIMIT_WRITES = LIMIT_FROM_FILE ? Number(QUOTA_MOD.QUOTA_LIMITS.writes) : LIMIT_WRITES_SHARED;

/** その数をどこから取ったか(人に見せる)。 */
export const LIMIT_SOURCE = LIMIT_FROM_FILE
  ? 'src/domain/quotaMeter.js（このアプリの現物）'
  : `4アプリ共通の枠 ${LIMIT_WRITES_SHARED}回（このアプリに src/domain/quotaMeter.js が無い）`;

/**
 * 🚨 ❌ にする線 =「**1つの機能が、1日の枠の半分(10,000回)以上を使う**」。
 *   1日(24時間)動かしたとして 10,000回 = **1時間あたり 約417回**。
 * なぜ「半分」か: 枠は4アプリ(製品検査・最終検査・部品検査・司令塔)で分け合う。
 *   1つの機能が半分を持って行ったら、残り全部が残り半分で回らない。
 */
export const NG_PER_HOUR = (LIMIT_WRITES / 2) / 24;            // ≒ 416.7

/**
 * 🚨🚨 さらに悪い線 =「**1直(8時間)動かしただけで**半分を使う」= 1時間あたり 1,250回。
 *   ここに乗る物は、朝から使い始めて **昼過ぎには枠を半分溶かす**。
 *   実測: スマホ中継 1回/秒 = 3,600回/時 は、これを3倍近く超えている。
 */
export const SHIFT_HOURS = 8;
export const SHIFT_NG_PER_HOUR = (LIMIT_WRITES / 2) / SHIFT_HOURS;   // = 1250

/** ⚠ ❌ ではないが放置しない線 =「1日動かすと枠の1割(2,000回)を超える」。 */
export const WARN_PER_HOUR = (LIMIT_WRITES * 0.1) / 24;        // ≒ 83.3

// ---------------------------------------------------------------------------
// 下ごしらえ
// ---------------------------------------------------------------------------
/**
 * ⚠コメントを消してから見る。コメントの中の例示コードを実コードとして数えると
 *   指摘の文言が嘘になる(2026-08-16 に実コードを食う誤検出を出した)。
 *   ⚠ URL の `//` を消さないよう、直前が `:` の時は行コメントとみなさない。
 * ⚠ 消すのでなく **同じ長さの空白に置き換える**(文字の位置＝行番号がズレない)。
 */
export const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const lineOf = (src, idx) => src.slice(0, Math.max(0, idx)).split('\n').length;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `(` から対応する `)` の位置。文字列/テンプレートは飛ばす。 */
const parenClose = (src, openIdx) => {
  let depth = 0, q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
};

/** `{` から対応する `}` の位置。 */
const braceClose = (src, openIdx) => {
  let depth = 0, q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
};

/**
 * 引数を「一番外側のカンマ」で切る。⚠ () {} [] と文字列の中のカンマでは切らない。
 * ⚠ sep を渡すと別の字で切れる(for(…;…;…) の `;` を切る時に使う)。既定はカンマのまま。
 */
export const splitTopLevel = (inner, sep = ',') => {
  const out = [];
  let depth = 0, q = null, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push({ text: inner.slice(start, i), start }); start = i + 1; }
  }
  out.push({ text: inner.slice(start), start });
  return out;
};

/**
 * `{` を使わない1行の中身の終わり(`;` まで)。
 * 🚨 `for (const lot of lots) DATA(db).save(…);` の形。中括弧が無いので braceClose では取れない。
 *   ここを取り違えると「繰り返しの中で書いている」を見落とす(2026-09-01 の L3)。
 */
export const statementEnd = (src, i) => {
  let depth = 0, q = null;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth < 0) return k; }
    else if (c === ';' && depth === 0) return k + 1;
  }
  return src.length;
};

// ---------------------------------------------------------------------------
// 「保管庫へ書いている」形
// ---------------------------------------------------------------------------
// ⚠端末の中だけに書く物(IndexedDB の store.put など)は入れない。枠を食わないので。
//
// 🚨🚨 2026-09-01(NC3) **窓口ごしの書き込み `DATA(db).save / .remove` が1件も入っていなかった。**
//   実測(この見張りを直す前):
//     ・setInterval で 0.2秒ごとに `DATA(db).save(…)` を呼ぶ形(1日432,000回＝枠の21.6倍)を
//       食わせても **緑(終了値0)** だった。
//     ・まったく同じ物を `saveData(` の形で書くと ❌(終了値1) になった。
//   つまり「書き込みの枠の見張り」が、本番でいちばん普通に使われている書き方を
//   1件も数えていなかった。実コードの数(2026-09-01 実測・コメントを除いた本文だけ):
//     最終25(save 20/remove 5) / 製品29(save 25/remove 4) / 部品6(save 5/remove 1) / 司令塔1(save 1)
//
// ⚠⚠ **`.save(` を丸ごと数えてはいけない。** 絵を描く `ctx.save()` は
//   この見張りが見るファイルの中に 製品10・最終11 か所ある(2026-09-01 実測。
//   試験ファイルの `sc.save()` 88か所は見張りの対象外)。絵を描くだけの処理を
//   「保管庫へ書いている」と名指しすると、指摘の文言がそのまま嘘になり誰も見なくなる
//   (2026-08-16 に実コードを食う誤検出を出した)。
//   → 数えるのは **受け手が窓口だと分かる形** だけ:
//       ① `DATA(…).save/remove(…)`            … その場で窓口を作って書く
//       ② そのファイルで `const P = DATA(db)` と受けた **別名**ごしの `P.save/remove(…)`
//          (→ aliasWriteCalls。ファイルを読んでから作るので、ここには書けない)
//   ⚠ `setFields` / `appendCapped` は窓口にしか無い名前なので、受け手を問わず数えてよい
//     (2026-09-01 実測: 4アプリの受け手は db)/store/p/be/docStore＝すべて保管庫の窓口)。
export const WRITE_CALLS = [
  { re: /\bsaveData\s*\(/g, what: 'saveData(…)' },
  { re: /\bsaveLot\s*\(/g, what: 'saveLot(…)' },
  { re: /\bdeleteData\s*\(/g, what: 'deleteData(…)' },
  { re: /\bsaveSettingsConfig\s*\(/g, what: 'saveSettingsConfig(…)' },
  { re: /\b(?:setDoc|updateDoc|addDoc|deleteDoc)\s*\(/g, what: 'Firestore へ直書き' },
  { re: /\.\s*patch\s*\(/g, what: '….patch(…)（部屋/コマ送りへ書き込み）' },
  { re: /\bP\.(?:save|remove)\s*\(/g, what: 'P.save/remove(…)' },
  // 🚨 NC3(2026-09-01) で足した。ここが空いていたので 1日43万回が緑で通っていた。
  { re: /\bDATA\s*\([^()]*\)\s*\.\s*(?:save|remove)\s*\(/g, what: 'DATA(db).save/remove(…)（窓口ごしの書き込み）' },
  { re: /\.\s*setFields\s*\(/g, what: '….setFields(…)（項目の差し替え＝updateDoc 1回）' },
  { re: /\.\s*appendCapped\s*\(/g, what: '….appendCapped(…)（配列に足す＝書き込み1回）' },
  // ⚠実コードを読んで確かめた物だけ書く(claimOnce は実際に1回書く)
  { re: /\bclaim(?:Once)?\s*\(/g, what: 'claim(…)（claimOnce＝先に書けた端末だけが進む。1回書く）' },
];

/**
 * 🚨 そのファイルで **窓口を別名で受けている** 名前を集める。
 *   実コードの形: `const P = DATA(db);`（製品2・最終1・部品5か所。2026-09-01 実測）
 *   別名ごしの `P.save(…)` は本物の書き込みなのに、名前が違うだけで数え落とす。
 * ⚠ `const unsub = DATA(db).watchCollection(…)` の `unsub` は窓口ではなく
 *   「見るのをやめる関数」。受けた直後に `.` が続く形は取らない。
 * ⚠ ここで拾えない形は正直に書いておく:
 *   ・窓口を **引数で** もらう物(src/liveRooms.js の `makeRoomApi(P, ns)`)
 *     → 上の WRITE_CALLS に `P.save/remove` を名指しで置いて凌いでいる。
 *   ・窓口を別のファイルへ export して、向こうで別名を付ける形(いまは実コードに無い)。
 */
export const providerAliases = (src) => {
  const out = new Set();
  const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${factoryNames(src).map(esc).join('|')})\\s*\\([^()]*\\)\\s*(?=[;,\\n)]|$)`, 'g');
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
};

/**
 * 🚨🚨 NC3(2026-09-01) **別名で import した窓口**。
 *   `import { DATA as D } from './App';` と受けて `D(db).save(…)` と書くと、
 *   名前が `DATA` でないので、名指しの形に1つも当たらない＝**緑のまま通る**。
 *   同じ事が `import { saveData as put }` でも起きる。
 * ⚠ `import * as X` で `X.DATA(db)` と書く形は拾えない(下の「見えない物」に書いてある)。
 *
 * @returns Map<このファイルでの名前, 元の名前>
 */
export const IMPORTED_WRITE_NAMES = [
  'DATA', 'providerFor', 'createProvider',
  'saveData', 'saveLot', 'deleteData', 'saveSettingsConfig',
  'setDoc', 'updateDoc', 'addDoc', 'deleteDoc',
];

export const importAliases = (src) => {
  const out = new Map();
  const im = /\bimport\s*\{([^{}]*)\}\s*from\s*['"][^'"]*['"]/g;
  let m;
  while ((m = im.exec(src))) {
    for (const p of splitTopLevel(m[1])) {
      const kv = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(p.text);
      if (!kv) continue;
      if (!IMPORTED_WRITE_NAMES.includes(kv[1])) continue;
      if (kv[2] === kv[1]) continue;
      out.set(kv[2], kv[1]);
    }
  }
  return out;
};

/** 窓口を作る関数の名前(既定＋別名で import した物)。 */
export const factoryNames = (src) => {
  const base = ['DATA', 'providerFor', 'createProvider'];
  for (const [local, orig] of importAliases(src)) if (base.includes(orig)) base.push(local);
  return base;
};

/**
 * 🚨🚨 NC3(2026-09-01) **窓口を「分解して」受ける形**を数える。
 *   実測(直す前): `const { save } = DATA(db);` と受けて 0.2秒ごとに `save(…)` を呼ぶ形
 *   (1日432,000回＝枠の21.6倍)が **緑(終了値0)** だった。
 *   前の版の見張りは「実コードに0件だから」と穴のまま残していたが、
 *   **0件なのは今日だけ**で、1行足った瞬間に緑のまま通る。
 *
 * 数える形(受け手が窓口だと **コードから読める** 物だけ):
 *   ① `const { save, remove } = DATA(db);`      → save / remove
 *   ② `const { save: put } = DATA(db);`         → put
 *   ③ `const s = DATA(db).save;`                → s（呼ばずに関数だけ受ける）
 *   ④ `const P = DATA(db); const { save } = P;` → save（①〜③の元が窓口の別名でもよい）
 * ⚠ `const { save } = useThing()` のような **窓口以外**からの分解は数えない
 *   (数えると、名前が同じだけの別物を「保管庫へ書いている」と名指しして嘘になる)。
 *
 * @returns Map<受け皿の名前, 元の書き方>
 */
export const WRITE_METHODS = ['save', 'remove', 'setFields', 'claimOnce', 'appendCapped'];

export const providerFnAliases = (src) => {
  const objs = [...providerAliases(src)].map(esc);
  // 窓口そのもの / 窓口を受けた別名 のどちらでもよい
  const SRC = `(?:(?:${factoryNames(src).map(esc).join('|')})\\s*\\([^()]*\\)${objs.length ? `|${objs.join('|')}` : ''})`;
  const out = new Map();
  const meth = WRITE_METHODS.join('|');

  // ①②④ 分解して受ける: const { save, remove: rm } = DATA(db);
  const de = new RegExp(`\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${SRC}\\s*(?=[;,\\n)]|$)`, 'g');
  let m;
  while ((m = de.exec(src))) {
    for (const p of splitTopLevel(m[1])) {
      const t = p.text.trim();
      if (!t) continue;
      const kv = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/.exec(t);
      if (!kv) continue;
      if (!WRITE_METHODS.includes(kv[1])) continue;   // 読む方(getAll 等)は枠を食わない
      out.set(kv[2] || kv[1], `const { ${t} } = 窓口`);
    }
  }
  // ③④ 関数だけ受ける: const s = DATA(db).save;   /   const s = P.save;
  const one = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${SRC}\\s*\\.\\s*(${meth})\\s*(?=[;,\\n)]|$)`, 'g');
  while ((m = one.exec(src))) out.set(m[1], `const ${m[1]} = 窓口.${m[2]}`);

  return out;
};

/** 別名ごしの書き込みを、WRITE_CALLS と同じ形で作る。 */
export const aliasWriteCalls = (src) => {
  const list = [...providerAliases(src)].map((n) => ({
    re: new RegExp(`\\b${esc(n)}\\s*\\.\\s*(?:${WRITE_METHODS.join('|')})\\s*\\(`, 'g'),
    what: `${n}.save/remove(…)（DATA(db) を ${n} で受けた窓口）`,
  }));
  // 🚨 分解して受けた形は「名前をそのまま呼ぶ」ので、受け皿の名前で数える
  for (const [name, how] of providerFnAliases(src)) {
    list.push({
      re: new RegExp(`\\b${esc(name)}\\s*\\(`, 'g'),
      what: `${name}(…)（${how} で分解して受けた窓口ごしの書き込み）`,
    });
  }
  // 🚨 別名で import した窓口・保存関数
  for (const [local, orig] of importAliases(src)) {
    if (['DATA', 'providerFor', 'createProvider'].includes(orig)) {
      list.push({
        re: new RegExp(`\\b${esc(local)}\\s*\\([^()]*\\)\\s*\\.\\s*(?:${WRITE_METHODS.join('|')})\\s*\\(`, 'g'),
        what: `${local}(db).save/remove(…)（${orig} を ${local} という名前で import した窓口）`,
      });
    } else {
      list.push({
        re: new RegExp(`\\b${esc(local)}\\s*\\(`, 'g'),
        what: `${local}(…)（${orig} を ${local} という名前で import した保存）`,
      });
    }
  }
  return list;
};

// ===========================================================================
// 🚨🚨 NC3(2026-09-01) **繰り返し(ループ)の中の書き込みは、繰り返す数だけ掛ける**
// ---------------------------------------------------------------------------
// 実測(直す前): 60秒ごとに `for (const lot of lots) DATA(db).save(…)` を回す形
//   (1回300件＝18,000回/時)が **緑(終了値0)** だった。
//   しかも見張りは **その for 文の行を印字したうえで ✅** を付けていた。
//   ＝ 書き込みは見つけているのに、**繰り返しの数を1回として数えていた**。
//
// 決め事:
//   ・繰り返す数が **コードから読める** なら掛ける(その根拠を必ず印字する)
//   ・読めないなら 🚨**「分かりません」として ❌**(黙って1回と数えない)
//   ・「1回しか回らない事がコードから読める形」(要素1つの配列・slice(0,1) 等)は 1回として通す
// ⚠ 読めない形を増やす方向にしか間違えない事(＝分からない物は赤)。
//   ここを「たぶん少ない」で通すと、8/17 と同じ「使い切ってから気づく」に戻る。
// ===========================================================================
/** ループの中で書いているか(印字用。判定は loopSpans / loopMulFor で行う)。 */
const LOOP_RE = /\bfor\s*\(|\bwhile\s*\(|\.\s*(?:forEach|map|flatMap)\s*\(/;

/** 数字そのもの、または同じファイルの決め値(const N = 300)なら数を返す。 */
const numOf = (t, consts) => {
  const s = String(t || '').trim();
  if (NUM_RE.test(s)) return Number(s.replace(/_/g, ''));
  if (consts.has(s)) return consts.get(s);
  return null;
};

/** `]` から対応する `[` を後ろ向きに探す。⚠文字列が混ざる形は諦める(＝分からない＝赤)。 */
const backMatch = (s, idx) => {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = s[i];
    if (c === ']' || c === ')' || c === '}') depth++;
    else if (c === '[' || c === '(' || c === '{') { depth--; if (depth === 0) return i; }
  }
  return -1;
};

/**
 * 「この式は何個のものを回すか」。読めなければ {n:null}。
 * 読める形（＝コードだけで上限が言い切れる物）だけを数える:
 *   ・要素を並べた配列 `[a, b, c]`      → 3
 *   ・`… .slice(0, 40)`                → 40（0以外の始まりも引き算する）
 *   ・**上の2つを `const` で受けた名前**（実コードにある形:
 *       `const targets = lotsNeedingDiagramOffload(raw).slice(0, 3);`
 *       … `for (const t of targets)` の回る数は、この1行を見ないと分からない）
 *
 * ⚠⚠ 名前をたどる時の決まり（ここを緩めると **嘘の緑** になる）:
 *   ・`const` だけ。`let`/`var` は後から入れ替わりうる
 *   ・たどって出てよいのは **切ってある形(.slice)** だけ。
 *     `const a = []` は0個に見えるが、後で `a.push(…)` されるので **0ではない**
 *   ・その名前に `.push/.unshift/.splice/.concat=` が1つでも在れば「分かりません」に倒す
 *   ・たどるのは1段だけ（深く追うほど「本当にその値か」が言えなくなる）
 */
export const exprCount = (expr, consts = new Map(), src = '', nearIdx = 0, depth = 0) => {
  const t = String(expr || '').trim().replace(/[\s;]+$/, '');
  if (!t) return { n: null, why: '回る数が書かれていない' };

  // … .slice(A, B) … で切ってあるなら、多くても B-A 個
  const sl = /\.\s*slice\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*$/.exec(t);
  if (sl) {
    const a = Number(sl[1]), b = Number(sl[2]);
    if (a >= 0 && b >= a) return { n: b - a, why: `.slice(${a}, ${b}) で ${b - a}個までに切ってある` };
  }
  // 要素を並べた配列（その場に書いた物は後から増えない）
  if (t.endsWith(']') && depth === 0) {
    const open = backMatch(t, t.length - 1);
    if (open === 0 && !/["'`]/.test(t)) {
      const inner = t.slice(1, -1).trim();
      const n = inner ? splitTopLevel(inner).filter((p) => p.text.trim()).length : 0;
      return { n, why: `その場に並べた配列＝${n}個` };
    }
  }
  // 名前だけの時は、いちばん近い手前の `const 名前 = …` を1段だけたどる
  if (depth === 0 && src && /^[A-Za-z_$][\w$]*$/.test(t)) {
    const de = new RegExp(`\\bconst\\s+${esc(t)}\\s*=`, 'g');
    const opens = [];
    let m2;
    while ((m2 = de.exec(src))) opens.push(m2);
    // ⚠同じ名前が何個も在る(実測: 最終検査の App.firebase.jsx に `targets` が7個)。
    //   **仕掛けている場所より手前でいちばん近い物**を採る(findFnBody と同じ決まり)。
    //   別人の宣言を読むと、回る数がそのまま嘘になる。
    const before = opens.filter((x) => x.index <= nearIdx);
    const hit = before.length ? before[before.length - 1] : null;
    if (!hit) return { n: null, why: `${t} をどこで作っているか(手前の const ${t} = …)が見つかりません` };
    // ⚠ 宣言は何行にもまたがる(実測: golden の targets は4行)。行末でなく `;` まで読む。
    const eq = hit.index + hit[0].length;
    const value = src.slice(eq, statementEnd(src, eq)).replace(/;\s*$/, '');
    // 🚨 宣言してから回すまでの間に **中身を足して** いたら、切ってある数はもう当てにならない。
    //   ⚠ファイル全体で探さない(同じ名前の別人の push に当たる。実測でそうなった)。
    const between = src.slice(hit.index, Math.max(hit.index, nearIdx));
    if (new RegExp(`\\b${esc(t)}\\s*\\.\\s*(?:push|unshift|splice|fill)\\s*\\(`).test(between)) {
      return { n: null, why: `${t} は回すまでに中身を足している(push/splice)ので、いくつ回るか分かりません` };
    }
    const r = exprCount(value, consts, src, nearIdx, depth + 1);
    if (r.n != null) return { n: r.n, why: `const ${t} = … ${r.why}` };
    return { n: null, why: `${t} が何個か分かりません（const ${t} = ${value.replace(/\s+/g, ' ').slice(0, 40)}）` };
  }
  return { n: null, why: `いくつ回るかコードから読めません: ${t.replace(/\s+/g, ' ').slice(0, 50)}` };
};

/** for(…) の頭から回る数を出す。 */
export const forCount = (head, consts = new Map(), src = '', nearIdx = 0) => {
  const h = String(head || '');
  const of = /\bof\s+([\s\S]+)$/.exec(h);
  if (of && /\b(?:const|let|var)\s|^\s*\w+\s+of\s/.test(h)) return exprCount(of[1], consts, src, nearIdx);
  if (/\bin\s+/.test(h) && /\b(?:const|let|var)\s/.test(h)) {
    return { n: null, why: 'for … in（いくつ回るかコードから読めません）' };
  }
  const parts = splitTopLevel(h, ';');
  if (parts.length === 3) {
    const mi = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(-?\d[\d_]*)\s*$/.exec(parts[0].text);
    const mc = /^\s*([A-Za-z_$][\w$]*)\s*(<=|<)\s*(.+?)\s*$/.exec(parts[1].text);
    if (mi && mc && mi[1] === mc[1]) {
      const lim = numOf(mc[3], consts);
      const from = Number(mi[2].replace(/_/g, ''));
      if (lim != null) {
        const n = mc[2] === '<' ? lim - from : lim - from + 1;
        if (n >= 0) return { n, why: `for(${mi[1]}=${from}; ${mi[1]}${mc[2]}${mc[3].trim()}) ＝ ${n}回` };
      }
    }
  }
  return { n: null, why: `for(…) が何回回るかコードから読めません: ${h.replace(/\s+/g, ' ').slice(0, 50)}` };
};

/**
 * ファイルの中の「繰り返し」を全部、範囲つきで拾う。
 * ⚠ 中括弧の無い1行の for（`for (const l of lots) DATA(db).save(…);`）も拾う。
 */
export const loopSpans = (src, consts = new Map()) => {
  const out = [];
  const kw = /\b(for|while)\s*\(/g;
  let m;
  while ((m = kw.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = parenClose(src, open);
    const head = src.slice(open + 1, close);
    let i = close + 1;
    while (i < src.length && /\s/.test(src[i])) i++;
    const end = src[i] === '{' ? braceClose(src, i) + 1 : statementEnd(src, i);
    const c = m[1] === 'for' ? forCount(head, consts, src, m.index)
      : { n: null, why: 'while(…) が何回回るかコードから読めません' };
    out.push({ kind: m[1], start: m.index, end, head: `${m[1]}(${head.replace(/\s+/g, ' ').trim().slice(0, 60)})`, ...c });
  }
  const mt = /\.\s*(forEach|map|flatMap)\s*\(/g;
  while ((m = mt.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = parenClose(src, open) + 1;
    const recv = src.slice(Math.max(0, m.index - 300), m.index);
    // 受け手が「名前だけ」なら、その名前で数える(`targets.forEach` の targets)。
    // ⚠ `a.b.forEach` や `f(x).forEach` は名前だけではないので、そのままの式で見る。
    const idOnly = /(?:^|[^\w$.\])])([A-Za-z_$][\w$]*)\s*$/.exec(recv);
    const c = exprCount(idOnly ? idOnly[1] : recv, consts, src, m.index);
    const tail = recv.replace(/\s+/g, ' ').slice(-40);
    // ⚠ 受け手が名前でない時は、300字の切れ端をそのまま理由に出さない(読めない文になる)
    if (c.n == null && !idOnly) c.why = `受け手（…${tail}）が何個か、コードから読めません`;
    out.push({ kind: m[1], start: m.index, end, head: `${tail}.${m[1]}(…)`, ...c });
  }
  return out.sort((a, b) => a.start - b.start);
};

/**
 * その書き込み1か所が「1tick で何回走るか」。
 * @param region 追いかけた先の範囲。**その範囲の中で始まる繰り返し**だけ数える
 *   (時計そのものを囲んでいる外側の繰り返しは、ここでは数えない＝下の「見えない物」に書く)。
 * @returns {{n:number|null, loops:[…]}} n=null は「分かりません」＝❌
 */
export const loopMulFor = (spans, idx, regionFrom, regionTo) => {
  const enc = spans.filter((s) => s.start >= regionFrom && s.start < idx && idx < s.end && s.start < regionTo);
  let n = 1;
  for (const s of enc) { if (s.n == null) { n = null; break; } n *= s.n; }
  return { n, loops: enc };
};

/** 追いかけない名前(言葉の作りや、よく使う道具)。 */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'console', 'Math', 'Number', 'String', 'Object', 'Array', 'JSON', 'Date', 'Promise', 'Set', 'Map',
  'useEffect', 'useState', 'useMemo', 'useCallback', 'useRef',
]);

const findWrites = (src, from, to, extra = []) => {
  const body = src.slice(from, to);
  const hits = [];
  // ⚠同じ1か所が2つの形に当たる事がある(`const P = DATA(db)` の P は、名指しの
  //   `P.save` と 別名ごしの `P.save` の両方に当たる)。**同じ場所は1回だけ数える**。
  //   ここを二重に数えると「書いている所」の件数が水増しされ、報告がそのまま嘘になる。
  const seen = new Set();
  for (const w of [...WRITE_CALLS, ...extra]) {
    const re = new RegExp(w.re.source, 'g');
    let m;
    while ((m = re.exec(body))) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      hits.push({
        what: w.what,
        idx: from + m.index,
        line: lineOf(src, from + m.index),
        // 🚨 どの範囲を追いかけて見つけたか(＝この中の繰り返しだけを掛ける)
        regionFrom: from,
        regionTo: to,
        code: body.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return hits.sort((a, b) => a.idx - b.idx);
};

/**
 * 中身の中の保存を数える。
 * ⚠⚠ **1つ内側まで追いかける。** 時計が呼ぶのは `drain()` の1語で、書いているのは
 *   その中、という形が実際に在る(src/data/outbox.js:227)。ここを追わないと
 *   「繰り返し書く処理を全部名指し」が嘘になる。
 * ⚠追うのは1段だけ。深く追うほど「本当に毎回通るのか」が言えなくなる。
 *   追って見つけた物は `via` を付けて、**どの関数の中で書いているか**を必ず出す。
 */
// ===========================================================================
// 🚨🚨 2026-09-02(NC3 第3弾) **「置き場(ref).current」越しに呼ぶ形を追う**
// ---------------------------------------------------------------------------
// 実測(直す前・製品 src/App.jsx): 測定図の巡回(90秒ごと)が、その日のうちに
//     const saveDataRef = useRef(null);
//     useEffect(() => { saveDataRef.current = saveData; });
//     …
//     const save = saveDataRef.current;
//     await save('lots', t.id, { steps: cur.steps }, …);
//   という形へ変わった。その瞬間、この見張りの一覧から **その時計がまるごと消えた**。
//   前の日までは ❓(＝止める)と名指ししていた物が、名指しすらされなくなった。
//   時計は今も90秒ごとに回って lots と step_diagrams を書いている。
// 🚨 これは「直って緑になった」のではなく「**見えなくなった**」。
//   2026-08-23 の「見張りが作り物を食っていて緑のまま本番だけ壊れていた」と同じ形。
// ⚠ だから **書く数を数える前に、置き場ごしの受け渡しをほどく**。
//   ここで足すのは「見える範囲」だけ。通す条件は1つも緩めていない。
// ===========================================================================
/**
 * `どこかの置き場.current = 関数名` を集める。
 * @returns Map<置き場の名前, 入れた関数の名前>   例: saveDataRef → saveData
 * ⚠ null/undefined を入れているだけの行(`ref.current = null`)は数えない。
 */
export const refHandoffs = (src) => {
  const out = new Map();
  const re = /\b([A-Za-z_$][\w$]*)\s*\.\s*current\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n}]/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2] === 'null' || m[2] === 'undefined') continue;
    out.set(m[1], m[2]);
  }
  return out;
};

export const collectWrites = (src, from, to, extra = []) => {
  const hits = findWrites(src, from, to, extra);
  const bodyText = src.slice(from, to);
  // 🚨 置き場ごしの受け渡しをほどく(上の注記を読む事)。
  const refs = refHandoffs(src);
  //   `const save = saveDataRef.current` … この中だけで通じる別名 save ＝ saveData
  const alias = new Map();
  const ar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*current\b/g;
  let a;
  while ((a = ar.exec(bodyText))) { if (refs.has(a[2])) alias.set(a[1], refs.get(a[2])); }
  const names = new Set();
  const re = /\b([A-Za-z_$][\w$]{2,})\s*\(/g;   // ⚠2文字以下は取り違えが多いので追わない
  let m;
  while ((m = re.exec(bodyText))) names.add(m[1]);
  //   別名は2文字でも拾う(上の正規表現は3文字以上しか見ないので、ここで足す)
  //   ⚠正規表現を文字列から組み立てない(書き損じが黙って別の意味になる)。素直に「名前(」を探す。
  for (const local of alias.keys()) {
    for (let p = bodyText.indexOf(local); p >= 0; p = bodyText.indexOf(local, p + 1)) {
      const before = p === 0 ? '' : bodyText[p - 1];
      if (/[\w$.]/.test(before)) continue;           // 名前の途中／なにかの持ち物
      let q = p + local.length;
      while (q < bodyText.length && /\s/.test(bodyText[q])) q += 1;
      if (bodyText[q] === '(') { names.add(local); break; }
    }
  }
  //   `saveDataRef.current(…)` と直に呼ぶ形も拾う
  const dr = /\b([A-Za-z_$][\w$]*)\s*\.\s*current\s*\(/g;
  while ((m = dr.exec(bodyText))) { if (refs.has(m[1])) names.add(refs.get(m[1])); }
  for (const n0 of names) {
    const n = alias.get(n0) || n0;            // 置き場ごしなら本物の名前へ置き換える
    if (NOT_A_FUNCTION.has(n)) continue;
    const fn = findFnBody(src, n, from);
    if (!fn || fn.from < 0) continue;
    if (fn.from >= from && fn.to <= to) continue;      // 自分の中にある物は既に数えた
    const via = n0 === n ? n : `${n0}（＝ ${n}。置き場ごし）`;
    findWrites(src, fn.from, fn.to, extra).forEach((h) => hits.push({ ...h, via }));
  }
  return hits.sort((x, y) => x.idx - y.idx);
};

// ---------------------------------------------------------------------------
// 「何ミリ秒ごとか」を読む
// ---------------------------------------------------------------------------
const NUM_RE = /^-?\d[\d_]*(?:\.\d+)?$/;

/** ファイルの中の `const NAME = 数字` を集める(間隔が名前で書いてある時に使う)。 */
export const numericConsts = (src) => {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d[\d_]*(?:\.\d+)?)\s*[;,\n]/g;
  let m;
  while ((m = re.exec(src))) map.set(m[1], Number(m[2].replace(/_/g, '')));
  return map;
};

/**
 * 間隔の式から ミリ秒 を出す。
 * @returns {{ms:number|null, why:string, assumed:boolean}}
 *   ms=null … 読めなかった(⚠**黙って捨てない**。読めない事を出す)
 */
export const resolveDelay = (expr, consts = new Map(), hints = []) => {
  const t = String(expr || '').trim();
  if (!t) return { ms: null, why: '間隔が書かれていない', assumed: false };

  if (NUM_RE.test(t)) return { ms: Number(t.replace(/_/g, '')), why: 'そのまま書いてある', assumed: false };

  if (consts.has(t)) return { ms: consts.get(t), why: `${t} = ${consts.get(t)}（同じファイルの決め値）`, assumed: false };

  // Math.max( … ) / Math.min( … )
  const mm = /^Math\.(max|min)\s*\(/.exec(t);
  if (mm) {
    const close = parenClose(t, t.indexOf('('));
    const parts = splitTopLevel(t.slice(t.indexOf('(') + 1, close)).map((p) => resolveDelay(p.text, consts, hints));
    const nums = parts.filter((p) => p.ms != null).map((p) => p.ms);
    if (nums.length) {
      const ms = mm[1] === 'max' ? Math.max(...nums) : Math.min(...nums);
      return { ms, why: `Math.${mm[1]}(…) を計算した`, assumed: parts.some((p) => p.assumed) };
    }
  }

  // `なにか || 600` … 読めない物の既定値を使う(⚠推定である事を残す)
  const ors = splitOr(t);
  if (ors.length > 1) {
    for (let i = ors.length - 1; i >= 0; i--) {
      const r = resolveDelay(ors[i], consts, hints);
      if (r.ms != null) return { ms: r.ms, why: `${r.why}（|| の既定値。実際はもっと短くなりうる）`, assumed: true };
    }
  }

  // 外から渡した手がかり(例: sp.everyMs → src/domain/liveSession.js の FRAME_SPEEDS)
  for (const h of hints) {
    if (h.re.test(t)) return { ms: h.ms, why: h.why, assumed: false };
  }

  return { ms: null, why: `間隔の式が読めない: ${t.replace(/\s+/g, ' ').slice(0, 60)}`, assumed: false };
};

const splitOr = (t) => {
  const out = [];
  let depth = 0, q = null, start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 0 && c === '|' && t[i + 1] === '|') { out.push(t.slice(start, i)); i++; start = i + 1; }
  }
  out.push(t.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
};

// ---------------------------------------------------------------------------
// 呼ばれる中身(ブロック)を探す
// ---------------------------------------------------------------------------
/**
 * 名前で定義を探して、その中身の範囲を返す。
 * ⚠⚠ **同じ名前が何個も在る**(実測: src/App.firebase.jsx に `tick` が4個・`check` が4個)。
 *   最初に見つかった1つを使うと **別人の中身を数える**。指摘の文言がそのまま嘘になる。
 *   → `nearIdx`(仕掛けている場所)より **手前で いちばん近い定義** を採る。
 *     手前に無ければ、後ろでいちばん近い物。
 */
export const findFnBody = (src, name, nearIdx = 0) => {
  const n = esc(name);
  const pats = [
    `\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`,
    `\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>\\s*\\{`,
    `\\b(?:async\\s+)?function\\s+${n}\\s*\\([^)]*\\)\\s*\\{`,
    `\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*\\{`,
  ];
  const opens = [];
  for (const p of pats) {
    const re = new RegExp(p, 'g');
    let m;
    while ((m = re.exec(src))) opens.push(m.index + m[0].length - 1);
  }
  if (!opens.length) return null;
  opens.sort((a, b) => a - b);
  const before = opens.filter((i) => i <= nearIdx);
  const open = before.length ? before[before.length - 1] : opens[0];
  return { from: open, to: braceClose(src, open) + 1, name };
};

/** 引数に書かれた中身の範囲を返す。⚠ nearIdx = 仕掛けている場所(同名の定義を取り違えない為)。 */
const bodyOfCallback = (src, absStart, text, nearIdx = 0) => {
  const t = text.trim();
  const lead = text.length - text.replace(/^\s+/, '').length;
  const at = absStart + lead;

  // その場に書いた関数: () => { … } / async () => { … } / function (…) { … }
  const inline = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/.exec(t)
    || /^(?:async\s+)?function\s*[A-Za-z_$]*\s*\([^)]*\)\s*\{/.exec(t);
  if (inline) {
    const open = at + inline[0].length - 1;
    return { from: open, to: braceClose(src, open) + 1, name: '', inline: true };
  }
  // その場に書いた1行の関数: () => なにか
  const oneline = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(t);
  if (oneline) return { from: at + oneline[0].length, to: absStart + text.length, name: '', inline: true };

  // 名前で渡した関数: setInterval(ring, iv)
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const found = findFnBody(src, t, nearIdx);
    if (found) return { ...found, inline: false };
    return { from: -1, to: -1, name: t, inline: false, missing: true };
  }
  return { from: -1, to: -1, name: '', inline: false, missing: true };
};

// ---------------------------------------------------------------------------
// 本体(純関数。--selftest はこれを文字列に対して回す)
// ---------------------------------------------------------------------------
/**
 * @param rawSrc  中身
 * @param file    見せる名前
 * @param opts    {hints:[{re,ms,why}]}
 * @returns {{sites:[…]}}
 */
export const analyze = (rawSrc, file = '(memory)', opts = {}) => {
  const src = stripComments(rawSrc);
  const consts = numericConsts(src);
  const hints = opts.hints || [];
  // 🚨 窓口の別名(`const P = DATA(db)` / `const { save } = DATA(db)`)は **ファイルごとに違う**。
  //   先に読んでから数える。
  const aliasCalls = aliasWriteCalls(src);
  // 🚨 繰り返しの範囲は1ファイルに1回だけ数えて使い回す(書き込み1件ごとに数え直すと遅い)
  const spans = loopSpans(src, consts);
  const found = [];

  const re = /\b(setInterval|setTimeout)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const kind = m[1];
    const open = m.index + m[0].length - 1;
    const close = parenClose(src, open);
    const inner = src.slice(open + 1, close);
    const parts = splitTopLevel(inner);
    if (parts.length < 1) continue;

    const body = bodyOfCallback(src, open + 1 + parts[0].start, parts[0].text, m.index);
    if (!body || body.from < 0) continue;

    // 🚨 **再帰の setTimeout**: 呼ばれる中身の内側から、また同じ物を仕掛けている
    const recursive = kind === 'setTimeout' && m.index >= body.from && m.index <= body.to;
    // 一度きりの setTimeout は「繰り返し書く処理」ではないので数えない
    if (kind === 'setTimeout' && !recursive) continue;

    const rawWrites = collectWrites(src, body.from, body.to, aliasCalls);
    if (!rawWrites.length) continue;      // 書いていない時計は枠を食わない

    // 🚨🚨 1tick で何回書くか。**繰り返しの中なら、繰り返す数だけ掛ける。**
    //   1つでも「何回回るか分からない」物があれば、この時計は ❓＝❌(黙って1回と数えない)。
    const writes = rawWrites.map((w) => {
      const L = loopMulFor(spans, w.idx, w.regionFrom, w.regionTo);
      return { ...w, mul: L.n, loops: L.loops };
    });
    const unknownLoop = writes.filter((w) => w.mul == null);
    // ⚠ 足さずに **いちばん多い1つ** で数える。枝分かれ(if/else)を足して嘘の ❌ を出さない為。
    //   ＝ 実際はこれ以上になりうる(下の「見えない物」に明記)。
    const perTick = unknownLoop.length ? null : Math.max(1, ...writes.map((w) => w.mul));

    const delay = resolveDelay(parts[1] ? parts[1].text : '', consts, hints);
    const bodyText = src.slice(body.from, body.to);

    found.push({
      file,
      kind,
      recursive,
      timerLine: lineOf(src, m.index),
      name: body.name || '（その場に書いた処理）',
      bodyKey: body.from,
      delayMs: delay.ms,
      delayWhy: delay.why,
      delayAssumed: delay.assumed,
      perTick,
      unknownLoop,
      loop: LOOP_RE.test(bodyText),
      // 🔒 中身の文字も持つ(スマホ中継の「門」が配線されているかを、後で見る為)
      bodyText,
      writes,
    });
  }

  // 同じ中身を指す物はまとめる(kick off と 再帰の2つが出るため)。
  // ⚠まとめる時は **再帰の方の間隔**を採る。最初の1回だけ短い物に引きずられない。
  const byBody = new Map();
  for (const s of found) {
    const prev = byBody.get(s.bodyKey);
    if (!prev) { byBody.set(s.bodyKey, s); continue; }
    if (s.recursive && !prev.recursive) byBody.set(s.bodyKey, s);
    else if (s.recursive === prev.recursive && (s.delayMs ?? Infinity) < (prev.delayMs ?? Infinity)) byBody.set(s.bodyKey, s);
  }

  const sites = [...byBody.values()]
    .map((s) => ({ ...s, ...budgetOf(s.delayMs, s.perTick) }))
    .sort((a, b) => (b.perHour || 0) - (a.perHour || 0) || a.timerLine - b.timerLine);

  return { sites };
};

/**
 * 1時間あたり何回・枠まで何時間・判定。
 * @param perTick 1tick で何回書くか。**繰り返しの中なら繰り返す数**。
 *   null = 「何回書くか分かりません」＝ ❓(＝止める)。⚠ 黙って1回と数えない。
 *   0 = 数える所が1つも残っていない(全部が許可の紙で「1日◯回まで」に決まっている時)
 * @param extraPerHour 許可の紙で決めた「1日◯回まで」を1時間あたりに直した数。
 *   ⚠ **足す。除かない。** 許した物も同じだけ枠を食う。
 */
export const budgetOf = (delayMs, perTick = 1, extraPerHour = 0) => {
  if (!(Number(delayMs) > 0) || perTick == null || !(Number(perTick) >= 0)) {
    return { perHour: null, hoursToLimit: null, hoursToHalf: null, verdict: 'unknown', shiftNg: false };
  }
  const perHour = Math.round((Number(perTick) > 0 ? (3600000 / Number(delayMs)) * Number(perTick) : 0)
    + (Number(extraPerHour) || 0));
  if (!(perHour > 0)) {
    return { perHour: 0, hoursToLimit: null, hoursToHalf: null, verdict: 'ok', shiftNg: false };
  }
  const hoursToLimit = Math.round((LIMIT_WRITES / perHour) * 10) / 10;
  const hoursToHalf = Math.round(((LIMIT_WRITES / 2) / perHour) * 10) / 10;
  let verdict = 'ok';
  if (perHour >= NG_PER_HOUR) verdict = 'ng';
  else if (perHour >= WARN_PER_HOUR) verdict = 'warn';
  return { perHour, hoursToLimit, hoursToHalf, verdict, shiftNg: perHour >= SHIFT_NG_PER_HOUR };
};

const MARK = { ng: '❌', warn: '⚠', ok: '✅', unknown: '❓' };

// ===========================================================================
// 🔒🚨 スマホ中継(コマ送り)の「門」を、実コードで確かめる（2026-08-31）
// ---------------------------------------------------------------------------
// 中継の tick は素の速さで数えると 1,800〜3,600回/時 = ❌。
// だが 2026-08-31 から、実コードに2つの門が入った:
//   ① 見ている人がいる時だけ送る（見る側の心拍 viewAt が30秒途切れたら止まる）
//   ② 1日の硬い上限（RELAY_HARD_CAP_DAY = 枠の2割 = 4,000回）で必ず止まる
// この2つが **本物なら**、中継が1日に書ける回数はどう使っても上限どまり。
// → その時だけ、上限から見た最悪値（4,000回/日 ≒ 167回/時）で数え直す。
//
// ⚠⚠ **確かめ方は「文字が在るか」ではなく、実物の関数を呼ぶ**(①②)。
//   スタブや作り物を食わせて緑を出した前科(2026-08-23)があるので、
//   src/domain/liveSession.js の frameSendPlan **そのもの** に
//   「心拍が切れた部屋」「上限に達した回数」を食わせて、止まるかを毎回見る。
// ⚠③(画面の tick が門を通しているか)だけは文字の確認。ここが外れていると
//   門がいくら正しくても呼ばれない(=素通し)ので、3つ全部そろって初めて数え直す。
// ⚠1つでも欠けたら **❌のまま**。線を上げて緑にする事はしない。
// ===========================================================================

/** 「心拍が30秒途切れたら止める」の決め(2026-08-31)。これより遅い見切りは門と認めない。 */
export const RELAY_STALE_MAX_MS = 30000;
/**
 * 印を一度も受け取っていない部屋にだけ足してよい、時計ズレの余裕の上限(2026-08-31 夜)。
 * ⚠ここが青天井だと「①の見切りは30秒」と言いながら、実際は何分でも送り続けられる。
 *   受け取った時刻を渡す道(撮影画面)には1ミリ秒も足されないので、足すのはこちらの道だけ。
 */
export const RELAY_SKEW_MAX_MS = 60000;
/**
 * 🚨 **受け取った時刻が分からない時だけ**許す、いちばん遅い見切り(ms)。
 * ⚠ room.viewAt は 見る側(PC)の時計で書かれた数字。撮る側(スマホ)の時計と直に引き算すると
 *   「経過時間 ＋ 端末どうしの時計のズレ」になる。そこで実コードは、印を **受け取った時刻**
 *   (こちらの時計)を渡す形にした。渡せない古い部屋のぶんだけ、時計ズレの余裕を足す。
 * ⚠その余裕込みでも 75秒(＝2026-08-31 の朝までの見切り)より遅くしてはいけない。
 *   ここを外すと「印が無ければ何時間でも送り続ける」に化ける。
 * ⚠上の RELAY_SKEW_MAX_MS(余裕そのものの上限)と **両方**見る。片方だけだと抜ける。
 */
export const RELAY_STALE_NOSEEN_MAX_MS = 75000;

/**
 * ①② 門の本体(domain)を **実際に呼んで** 確かめる。
 *
 * 🚨🚨 2026-08-31 夜: **実コードと同じ呼び方で食わせる**。
 *   撮影画面(LiveCamera.jsx)は frameSendPlan に viewSeenAt(印を受け取った時刻)を渡す。
 *   ここで渡さずに呼ぶと、見張りは「古い部屋のぶんの余裕」だけを見て
 *   **本番と違う道**を判定してしまう(＝作り物を食う見張り)。
 *
 * @param mod  import('src/domain/liveSession.js') の結果(またはそれと同じ形の物)
 * @returns [{ok, label}]
 */
export const relayGateChecks = (mod) => {
  const out = [];
  const say = (ok, label) => out.push({ ok: !!ok, label });
  const plan = mod && typeof mod.frameSendPlan === 'function' ? mod.frameSendPlan : null;
  if (!plan) { say(false, '① frameSendPlan(唯一の門)が domain に見当たらない'); return out; }
  const stale = Number(mod.VIEW_STALE_MS);
  const cap = Number(mod.RELAY_HARD_CAP_DAY);
  const now = 10_000_000;
  const st = Number.isFinite(stale) && stale > 0 ? stale : 1;
  // ⏱ 受け取った時刻が **分からない時だけ** 足す、時計ズレの余裕(domain が持ち主)。
  //   ⚠撮影画面は受け取った時刻(viewSeenAt)を渡すので、そちらには1ミリ秒も足されない。
  const slack = Math.max(0, Number(mod.VIEW_SKEW_SLACK_MS) || 0);
  // ⚠⚠ わざと **時計がずれた部屋**にする。時計の数字をそのまま引き算する門なら、
  //   ここで必ず化けの皮が剥がれる(2026-08-31 夜に実際そうなった)。
  //   直す前の製品の見張りは viewAt を「たった今」にしていたので、
  //   相手の時計を直に引く門を **9/9 ✅ で素通し** していた(実測)。
  //   ・freshRoom = PCの時計が3分 **遅れて**いる。印は たった今 受け取った
  //       → 数字を引き算する門は「3分前＝誰も見ていない」と誤る(止めてはいけない場面で止まる)
  //   ・staleRoom = PCの時計が3分 **進んで**いる。印は 30秒 以上 届いていない
  //       → 数字を引き算する門は「未来＝ついさっき」と誤る(止まるべき場面で止まらない)
  const SKEW = 180_000;
  const freshRoom = { code: 'AB7K9M', createdAt: 1000, viewAt: now - SKEW };
  const staleRoom = { code: 'AB7K9M', createdAt: 1000, viewAt: now + SKEW };
  const oldRoom = { code: 'AB7K9M', createdAt: 1000, viewAt: now - st - slack - 1 };
  // ① 見ている人がいる間は送る / 心拍が途切れたら録画中でも止まる
  //   🚨呼び方は **撮影画面の tick と同じ**(受け取った時刻を渡す)。渡さない呼び方だけで確かめると、
  //     実際の画面が通っていない道を試験する事になる(2026-08-31 に実際そうなっていた)。
  const fresh = plan({ room: freshRoom, nowMs: now, recording: true, todayWrites: 0, viewSeenAt: now - 1000 });
  say(fresh && fresh.send === true,
    `① 見ている人がいる間は送る(録画中・実物の門で確認。相手の時計が${SKEW / 1000}秒ずれていても止めない)`);
  const noView = plan({ room: staleRoom, nowMs: now, recording: true, todayWrites: 0, viewSeenAt: now - st - 1 });
  say(noView && noView.send === false && noView.why === 'noviewer',
    `① 心拍が途切れたら録画中でも止まる(受け取った時刻で・実際: send=${noView && noView.send}, why=${noView && noView.why})`);
  say(Number.isFinite(stale) && stale > 0 && stale <= RELAY_STALE_MAX_MS,
    `① 心拍の見切りが30秒以内(実際 ${stale}ms)`);
  // ①b 🚨 受け取った時刻が渡らない道(古い部屋・最初の心拍が来る前)でも、**いつかは必ず止まる**。
  //   ここを見ないと「viewSeenAt を渡さなければ一生送り続ける」抜け道が残る。
  const noView2 = plan({ room: oldRoom, nowMs: now, recording: true, todayWrites: 0 });
  say(noView2 && noView2.send === false && noView2.why === 'noviewer',
    `①b 受け取った時刻が分からない部屋も、いつかは止まる(実際: send=${noView2 && noView2.send}, why=${noView2 && noView2.why})`);
  say(slack <= RELAY_SKEW_MAX_MS,
    `①b 時計ズレの余裕そのものが ${RELAY_SKEW_MAX_MS / 1000}秒以内(実際 ${slack}ms)`);
  say(Number.isFinite(stale) && stale > 0 && stale + slack <= RELAY_STALE_NOSEEN_MAX_MS,
    `①b 余裕込みの見切りが75秒以内(実際 ${stale}+${slack}=${stale + slack}ms)`);
  // ② 硬い上限
  say(Number.isFinite(cap) && cap > 0 && cap < LIMIT_WRITES / 2,
    `② 硬い上限が1日の枠の半分より下(実際 ${cap}回/日・枠 ${LIMIT_WRITES}回)`);
  const capStop = plan({ room: freshRoom, nowMs: now, recording: true, todayWrites: Number.isFinite(cap) ? cap : 0, viewSeenAt: now - 1000 });
  say(capStop && capStop.send === false && capStop.why === 'budget',
    `② 上限に達したら録画中でも止まる(実際: send=${capStop && capStop.send}, why=${capStop && capStop.why})`);
  const capOk = plan({ room: freshRoom, nowMs: now, recording: true, todayWrites: (Number.isFinite(cap) ? cap : 1) - 1, viewSeenAt: now - 1000 });
  say(capOk && capOk.send === true, '② 上限の手前までは送る(締めすぎて使えない、も欠陥)');
  say(capStop && typeof capStop.text === 'string' && capStop.text.length > 3,
    '② 止める時に理由が言葉になる(黙って止まらない)');
  return out;
};

/**
 * ③ 画面の tick が、その門を **本当に通しているか**(中身の文字で見る)。
 * ⚠門がいくら正しくても、tick が呼ばなければ素通し。ここが繋がって初めて意味を持つ。
 */
export const relayWiringChecks = (bodyText) => {
  const t = String(bodyText || '');
  // 🔢🚨 2026-08-31(夜) **記憶の床**。控え(localStorage)に書けない端末
  //   (私用モード・容量満杯)は setItem が例外を投げるので、控えの数は増えない。
  //   そこで tick が「今日の回数」を控えの値で **入れ替えて** いると、毎回数が戻り
  //   4,000回の門に一生届かない(実測: 3,995で撒くと 3,996 のまま45秒たっても止まらない)。
  //   → 控えとは必ず **大きい方を採る**。入れ替えの形が1つでも在れば ❌。
  const floorOk = !/relayCountRef\.current\s*=\s*readDayCount\s*\(/.test(t)
    && /Math\.max\(\s*relayCountRef\.current\s*,/.test(t)
    && /Math\.max\(\s*relayCountRef\.current\s*\+\s*1\s*,/.test(t);
  return [
    { ok: /\bframeSendPlan\s*\(/.test(t), label: '③ tick が frameSendPlan(唯一の門)を呼んでいる' },
    { ok: /todayWrites\s*:/.test(t), label: '③ tick が todayWrites(今日の回数)を門へ渡している' },
    // 🚨 これを渡さないと、門は「相手の時計で書かれた viewAt」との引き算に落ち、
    //   時計ズレのぶんの余裕(75秒)で判定される＝ 30秒の心拍は **本番では効かない**。
    { ok: /viewSeenAt\s*:/.test(t), label: '③ tick が viewSeenAt(印を受け取った時刻)を門へ渡している' },
    { ok: /if\s*\(\s*plan\.send\s*\)/.test(t), label: '③ 書き込みが plan.send の中にある(門の答えに従う)' },
    { ok: floorOk, label: '③ 今日の回数を控えの値で入れ替えていない(控えに書けない端末でも数が下がらない=記憶の床)' },
  ];
};

/**
 * 🔒 ①②③が全部そろった時だけ、**硬い上限から見た最悪値**で数え直す。
 * そろわなければ site をそのまま返す(❌のまま。黙って緑にしない)。
 */
export const applyRelayCap = (site, mod) => {
  const checks = [...relayGateChecks(mod), ...relayWiringChecks(site.bodyText)];
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  if (!allOk) return { ...site, relayChecks: checks, relayCapped: false };
  // 🚨 NC3(2026-09-01): 上限は「1回送るたびに1つ数える」形。**繰り返しで1tickに何回も書く**なら
  //   その数え方は合わないので、数え直さない(＝素の判定のまま。黙って緑にしない)。
  if (site.perTick == null || site.perTick > 1) return { ...site, relayChecks: checks, relayCapped: false };
  const cap = Number(mod.RELAY_HARD_CAP_DAY);
  const cappedPerHour = Math.ceil(cap / 24);            // 1日中動かしても、上限÷24時間が最悪
  const b = budgetOf(3600000 / cappedPerHour);
  return {
    ...site,
    relayChecks: checks,
    relayCapped: true,
    relayCap: cap,
    rawPerHour: site.perHour,
    perHour: b.perHour,
    hoursToLimit: b.hoursToLimit,
    hoursToHalf: b.hoursToHalf,
    verdict: b.verdict,
    shiftNg: b.shiftNg,
  };
};

// ---------------------------------------------------------------------------
// 見張り自身の試験
// ---------------------------------------------------------------------------
const SELFTEST_HINTS = [{ re: /everyMs/, ms: 1000, why: '（試験用の手がかり）' }];

const SAMPLE_BAD = `
  useEffect(() => {
    const t = setInterval(async () => {
      await saveData('lots', id, { at: Date.now() });
    }, 500);
    return () => clearInterval(t);
  }, []);
`;

const SAMPLE_FIXED = `
  useEffect(() => {
    const t = setInterval(async () => {
      await saveData('lots', id, { at: Date.now() });
    }, 60000);
    return () => clearInterval(t);
  }, []);
`;

const SAMPLE_NO_WRITE = `
  const t = setInterval(() => setNowMs(Date.now()), 500);
`;

const SAMPLE_COMMENTED = `
  // 昔は setInterval(() => saveData('lots', id, {}), 500) と書いていた
  /* const t = setInterval(async () => { await saveData('lots', id, {}); }, 200); */
  const url = 'https://example.com/a//b';
  const t = setInterval(() => setNowMs(Date.now()), 1000);
`;

const SAMPLE_RECURSIVE = `
  const sp = frameSpeedOf(speed);
  const send = async () => {
    if (dead) return;
    await roomApi.frame(code, 0).patch({ url, at: Date.now() });
    if (!dead) timer = setTimeout(send, sp.everyMs);
  };
  timer = setTimeout(send, 600);
`;

const SAMPLE_UNKNOWN = `
  const t = setInterval(() => { saveData('lots', id, {}); }, cfg.everyThing);
`;

const SAMPLE_NAMED = `
  const pass = async () => { await saveData('lots', l.id, u); };
  const timer = setInterval(pass, 90000);
`;

// ⚠⚠ 時計が呼ぶのは1語で、書いているのはその中(src/data/outbox.js:227 と同じ形)
const SAMPLE_INDIRECT = `
  const drainAll = async () => { await saveData('lots', id, {}); };
  const iv = setInterval(() => { if (isOnline()) drainAll(); }, 15000);
`;

// ⚠⚠ 同じ名前が何個も在る時に、**別人の中身を数えない**か
//   (実測: src/App.firebase.jsx に tick が4個・check が4個ある)
const SAMPLE_SAMENAME = `
  function A() {
    const tick = () => { setNowMs(Date.now()); };
    const t = setInterval(tick, 1000);
  }
  function B() {
    const tick = () => { saveData('lots', id, {}); };
    const t = setInterval(tick, 2000);
  }
`;

// ============================================================================
// 🚨 NC3(2026-09-01)用の見本。**窓口ごしの書き込みを数え落としていた**形。
// ============================================================================
// ⑪a その場で窓口を作って書く(0.2秒ごと = 1日432,000回 = 枠の21.6倍)
const SAMPLE_DATA_SAVE = `
  useEffect(() => {
    const t = setInterval(async () => {
      await DATA(db).save(APP_DATA_ID, 'lots', id, { at: Date.now() });
    }, 200);
    return () => clearInterval(t);
  }, []);
`;
// ⑪b 消す方も同じだけ枠を食う
const SAMPLE_DATA_REMOVE = `
  const t = setInterval(() => { DATA(db).remove(APP_DATA_ID, 'lots', id); }, 200);
`;
// ⑪c 窓口を別名で受けてから書く(実コードの `const P = DATA(db);` と同じ形)
const SAMPLE_ALIAS_SAVE = `
  const kick = () => {
    const P = DATA(db);
    const t = setInterval(async () => { await P.save(APP_DATA_ID, 'lots', id, {}); }, 1000);
  };
`;
// ⑪d 項目の差し替え(updateDoc 1回)・配列に足す(書き込み1回)
const SAMPLE_SETFIELDS = `
  const t = setInterval(() => { DATA(db).setFields(APP_DATA_ID, 'lots', id, { a: 1 }); }, 500);
`;
const SAMPLE_APPENDCAPPED = `
  const t = setInterval(() => { DATA(db).appendCapped(APP_DATA_ID, 'lots', id, 'log', {}); }, 500);
`;
// ⑪e 🚨**絵を描く save は保管庫への書き込みではない。**
//   ctx.save() は見張りが見るファイルの中に 製品10・最終11 か所ある(2026-09-01 実測)。
//   ここを誤って名指しすると、指摘そのものが嘘になる。
const SAMPLE_CANVAS_SAVE = `
  const t = setInterval(() => {
    ctx.save();
    ctx.translate(10, 10);
    ctx.restore();
    sc.save();
  }, 200);
`;
// ⑪f 窓口を受けた直後に `.` が続く形は窓口ではない(見るのをやめる関数)
const SAMPLE_UNSUB_NOT_ALIAS = `
  const unsub = DATA(db).watchCollection(APP_DATA_ID, 'lots', () => {});
  const t = setInterval(() => { unsub.save(); }, 200);
`;

// ============================================================================
// 🚨🚨 NC3(2026-09-01)の第2弾用の見本。
//   ⑫ **窓口を分解して受ける形**（L1）… 前の版は「実コードに0件」で穴のまま残していた
//   ⑬ **繰り返しの中の書き込み**（L3）… 前の版は for 文の行を印字したうえで ✅ を付けた
// ============================================================================
// ⑫a const { save } = DATA(db) … 0.2秒ごと = 1日432,000回(枠の21.6倍)
const SAMPLE_DESTRUCTURED = `
  const { save } = DATA(db);
  const t = setInterval(() => { save(APP_DATA_ID, 'lots', id, { at: Date.now() }); }, 200);
`;
// ⑫b 名前を変えて受ける
const SAMPLE_DESTRUCTURED_RENAMED = `
  const { save: put, remove: drop } = DATA(db);
  const t = setInterval(() => { put(APP_DATA_ID, 'lots', id, {}); drop(APP_DATA_ID, 'lots', id); }, 200);
`;
// ⑫c 関数だけ受ける
const SAMPLE_METHOD_REF = `
  const s = DATA(db).setFields;
  const t = setInterval(() => { s(APP_DATA_ID, 'lots', id, { a: 1 }); }, 200);
`;
// ⑫d 窓口の別名から分解する
const SAMPLE_DESTRUCTURED_VIA_ALIAS = `
  const P = DATA(db);
  const { appendCapped } = P;
  const t = setInterval(() => { appendCapped(APP_DATA_ID, 'lots', id, 'log', {}); }, 200);
`;
// ⑫e 🚨誤検出の側: **窓口でない物**からの分解は数えない(名前が同じだけの別物)
const SAMPLE_DESTRUCTURED_NOT_PROVIDER = `
  const { save } = useEditorStore();
  const t = setInterval(() => { save({ draft: true }); }, 200);
`;
// ⑫f 🚨誤検出の側: 読む方(getAll)は枠(書き込み)を食わない
const SAMPLE_DESTRUCTURED_READ = `
  const { getAll } = DATA(db);
  const t = setInterval(() => { getAll(APP_DATA_ID, 'lots'); }, 200);
`;
// ⑫g 🚨 別名で import した窓口(名前が DATA でないので、名指しの形に1つも当たらない)
const SAMPLE_IMPORT_ALIAS = `
  import { DATA as D } from './App';
  const t = setInterval(() => { D(db).save(APP_DATA_ID, 'lots', id, {}); }, 200);
`;
// ⑫h 別名で import した保存関数
const SAMPLE_IMPORT_ALIAS_FN = `
  import { saveData as put, deleteData } from './App';
  const t = setInterval(() => { put('lots', id, {}); }, 200);
`;
// ⑫i 別名で import した窓口を、さらに分解して受ける(⑫と⑫gの合わせ技)
const SAMPLE_IMPORT_ALIAS_DESTRUCTURED = `
  import { DATA as D } from './App';
  const { save } = D(db);
  const t = setInterval(() => { save(APP_DATA_ID, 'lots', id, {}); }, 200);
`;
// ⑬a 60秒ごとに **中括弧の無い for** で全ロットへ書く(1回300件 = 18,000回/時)
const SAMPLE_LOOP_UNKNOWN = `
  const t = setInterval(() => {
    for (const lot of lots) DATA(db).save(APP_DATA_ID, 'lots', lot.id, { at: Date.now() });
  }, 60000);
`;
// ⑬b forEach で回る数が分からない形
const SAMPLE_LOOP_FOREACH = `
  const t = setInterval(() => { rows.forEach(r => { saveData('lots', r.id, {}); }); }, 60000);
`;
// ⑬c 二重の繰り返し
const SAMPLE_LOOP_NESTED = `
  const t = setInterval(() => {
    groups.forEach(g => { g.lots.forEach(l => { saveData('lots', l.id, {}); }); });
  }, 60000);
`;
// ⑬d while(…) も分からない
const SAMPLE_LOOP_WHILE = `
  const t = setInterval(() => { while (queue.length) { saveData('lots', queue.pop(), {}); } }, 60000);
`;
// ⑬e ✅ 回る数が **読める** 形(切ってある)。掛けて数える
const SAMPLE_LOOP_SLICED = `
  const t = setInterval(() => { rows.slice(0, 40).forEach(r => { saveData('lots', r.id, {}); }); }, 60000);
`;
// ⑬f ✅ 回る数が読める形(数字で書いた for)
const SAMPLE_LOOP_COUNTED = `
  const t = setInterval(() => { for (let i = 0; i < 3; i++) { saveData('lots', ids[i], {}); } }, 300000);
`;
// ⑬g ✅ **1回しか回らない事がコードから読める** 形は緑のまま
const SAMPLE_LOOP_ONCE = `
  const t = setInterval(() => { for (const l of [lot]) DATA(db).save(APP_DATA_ID, 'lots', l.id, {}); }, 60000);
`;
// ⑬h ✅ 実コードに在る形: 切った物を const で受けて回す(製品 src/App.jsx:43171 と同じ)
const SAMPLE_LOOP_CONST_SLICE = `
  const t = setInterval(async () => {
    const targets = lotsNeedingDiagramOffload(raw).slice(0, 3);
    for (const x of targets) { await saveData('lots', x.id, {}); }
  }, 90000);
`;
// ⑬i 🚨 `const a = []` を後から push する物を「0個」と読まない
const SAMPLE_LOOP_PUSHED = `
  const t = setInterval(() => {
    const box = [];
    rows.forEach(r => box.push(r));
    for (const b of box) { saveData('lots', b.id, {}); }
  }, 60000);
`;

// ===========================================================================
// ⑭ 🚨🚨 2026-09-02(NC3 第3弾)用の見本: **置き場(ref).current 越しに隠した書き込み**
// ---------------------------------------------------------------------------
// これを足す前の見張りは、下の3つとも **名指しすらしなかった**(＝1件も数えていない)。
//   ⑭b は 0.2秒ごとに書く物(1時間 18,000回)なのに、一覧に出てこなかった。
// 実際に製品の測定図の巡回(90秒ごと)が、この形へ変わった日に一覧から消えている。
// ⚠ この3件が緑になったら、それは「直った」のではなく「**また見えなくなった**」。
// ===========================================================================
const SAMPLE_REF_HANDOFF = `
  const doSave = (col, id) => { (rows || []).forEach(r => { DATA(db).save(A, col, r.id, {}); }); };
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current = doSave; });
  const t = setInterval(() => {
    const go = boxRef.current;
    if (!go) return;
    go('lots', 1);
  }, 60000);
`;
// ⑭b 置き場ごしに隠した「0.2秒ごとに1回書く」物
const SAMPLE_REF_HANDOFF_FAST = `
  const doSave = (id) => { DATA(db).save(A, 'lots', id, {}); };
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current = doSave; });
  const t = setInterval(() => { const go = boxRef.current; go(1); }, 200);
`;
// ⑭c 置き場から取り出さずに `boxRef.current(…)` と直に呼ぶ形
const SAMPLE_REF_HANDOFF_DIRECT = `
  const doSave = (id) => { (rows || []).forEach(r => DATA(db).save(A, 'lots', r, {})); };
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current = doSave; });
  const t = setInterval(() => { boxRef.current(1); }, 60000);
`;
// ⑭d 置き場ごしでも **上限が読めれば通す**(止めすぎていない事の裏取り)
const SAMPLE_REF_HANDOFF_CAPPED = `
  const doSave = (id) => { (rows || []).slice(0, 3).forEach(r => DATA(db).save(A, 'lots', r, {})); };
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current = doSave; });
  const t = setInterval(() => { const go = boxRef.current; go(1); }, 60000);
`;
// ⑭e 🚨「人が押した時だけ」の顔をして、実は時計で回る形。
//   名前が handle…/onSubmit… でも、時計から回るなら **数える**(名前で見逃さない)。
const SAMPLE_HANDLER_FACE = `
  const handleClickSave = () => { (rows || []).forEach(r => { saveData('lots', r.id, {}); }); };
  const t = setInterval(handleClickSave, 60000);
`;
const SAMPLE_HANDLER_FACE_CAPPED = `
  const onSubmitSave = () => { (rows || []).slice(0, 4).forEach(r => { saveData('lots', r.id, {}); }); };
  const t = setInterval(onSubmitSave, 60000);
`;

// 🔒 ⑩用: 実物と同じ振る舞いのミニチュアの門と、**わざと壊した**変種を作る道具。
//   viewerGate=false → ①誰も見ていなくても送る / capGate=false → ②上限で止まらない
//   seenGate=false   → 🚨①の見切りを「相手の時計で書かれた viewAt」と直に引き算する
//                      (＝2026-08-31 夜に見つかった形。時計が18秒ずれるだけで
//                        見ている最中に止まる)
const gateMock = ({ cap = 4000, stale = 30000, slack = 45000, viewerGate = true, capGate = true, seenGate = true } = {}) => ({
  VIEW_STALE_MS: stale,
  VIEW_SKEW_SLACK_MS: seenGate ? slack : 0,
  RELAY_HARD_CAP_DAY: cap,
  frameSendPlan: (s = {}) => {
    const out = (send, why) => ({ send, why, text: `${why} のため止めています/送っています`, left: 0 });
    if (capGate && (Number(s.todayWrites) || 0) >= cap) return out(false, 'budget');
    const at = Number(s.room && s.room.viewAt);
    const seen = Number(s.viewSeenAt) || 0;
    const nowMs = Number(s.nowMs) || 0;
    // ⚠実物と同じ形: 受け取った時刻が分かるなら **こちらの時計だけ** で測る(時計ズレが式から消える)。
    //   seenGate=false = 直す前の形。受け取った時刻を捨て、相手の時計と直に引き算する。
    const useSeen = seenGate && seen > 0;
    const age = useSeen ? nowMs - seen : nowMs - at;
    const limit = useSeen ? stale : stale + (seenGate ? slack : 0);
    if (viewerGate && Number.isFinite(at) && at > 0 && age >= limit) return out(false, 'noviewer');
    if (s.recording) return out(true, 'recording');
    return out(false, 'previewdone');
  },
});

// 🔒 ⑩用: 門を正しく通している tick の見本(実物 LiveCamera.jsx と同じ形)。
const SAMPLE_RELAY_GATED = `
  const sp = frameSpeedOf(speed);
  const tick = async () => {
    if (dead) return;
    const now = Date.now();
    if (store) {
      const kept = readDayCount(store, RELAY_COUNT_KEY, now);
      relayCountRef.current = Math.max(relayCountRef.current, kept);
    }
    const base = frameSendPlan({ room: roomRef.current, nowMs: now, recording: rec, todayWrites: relayCountRef.current, viewSeenAt: viewSeenAtRef.current });
    let plan = base;
    if (plan.send) {
      p = roomApi.frame(code, 0).patch({ url, at: now });
      relayCountRef.current = Math.max(relayCountRef.current + 1, store ? addDayCount(store, RELAY_COUNT_KEY, now, 1) : 0);
    }
    if (!dead) timer = setTimeout(tick, base.send ? sp.everyMs : 2000);
  };
  timer = setTimeout(tick, 600);
`;

// 🔒 ⑩用: **今日の回数を門へ渡していない** tick(=上限が一生効かない配線)。
const SAMPLE_RELAY_NO_TODAY = SAMPLE_RELAY_GATED.replace(', todayWrites: relayCountRef.current', '');
// 🔒 ⑩用: **控えの値で入れ替える** tick(=控えに書けない端末で上限が一生閉まらない配線)。
const SAMPLE_RELAY_NO_FLOOR = SAMPLE_RELAY_GATED
  .replace('relayCountRef.current = Math.max(relayCountRef.current, kept);', 'relayCountRef.current = readDayCount(store, RELAY_COUNT_KEY, now);')
  .replace('relayCountRef.current = Math.max(relayCountRef.current + 1, store ? addDayCount(store, RELAY_COUNT_KEY, now, 1) : 0);', 'relayCountRef.current = store ? addDayCount(store, RELAY_COUNT_KEY, now, 1) : relayCountRef.current + 1;');
// 🔒 ⑩用: **印を受け取った時刻を門へ渡していない** tick
//   (＝30秒の心拍が本番では効かず、時計ズレの余裕で判定される配線)。
const SAMPLE_RELAY_NO_SEEN = SAMPLE_RELAY_GATED.replace(', viewSeenAt: viewSeenAtRef.current', '');

const selftest = () => {
  let bad = 0;
  const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? '  ✅' : '  ❌'} ${msg}`); };
  const run = (src, o = {}) => analyze(src, '(見本)', { hints: SELFTEST_HINTS, ...o });

  console.log('🧪 見張り自身の試験');

  // ① わざと壊した見本で **落ちる**
  const bad1 = run(SAMPLE_BAD).sites;
  say(bad1.length === 1, `わざと壊した見本(0.5秒ごとに保存)を1件見つける (実際 ${bad1.length}件)`);
  say(bad1[0] && bad1[0].perHour === 7200, `1時間あたり 7200回 と出す (実際 ${bad1[0] && bad1[0].perHour})`);
  say(bad1[0] && bad1[0].hoursToLimit === 2.8, `枠まで 2.8時間 と出す (実際 ${bad1[0] && bad1[0].hoursToLimit})`);
  say(bad1[0] && bad1[0].verdict === 'ng', 'わざと壊した見本は ❌ になる');

  // ② 直した見本では **黙る**
  const ok1 = run(SAMPLE_FIXED).sites;
  say(ok1.length === 1 && ok1[0].verdict === 'ok', `1分ごとなら ✅ (実際 ${ok1[0] && ok1[0].verdict})`);
  say(ok1[0] && ok1[0].perHour === 60, `1時間あたり 60回 (実際 ${ok1[0] && ok1[0].perHour})`);

  // ③ 書いていない時計は数えない(誤検出で信用を落とさない)
  say(run(SAMPLE_NO_WRITE).sites.length === 0, '保存しない時計は名指ししない');

  // ④ ⚠コメントの中の例示を実コードとして数えない
  const cm = run(SAMPLE_COMMENTED).sites;
  say(cm.length === 0, `コメントの中の例示を数えない (実際 ${cm.length}件)`);
  say(stripComments(SAMPLE_COMMENTED).includes('https://example.com'), '⚠ URL の // をコメントとして消さない');

  // ⑤ 🚨再帰の setTimeout を見つけ、**再帰側の間隔**で数える(最初の1回の600msに引きずられない)
  const rec = run(SAMPLE_RECURSIVE).sites;
  say(rec.length === 1, `再帰の setTimeout を1件にまとめる (実際 ${rec.length}件)`);
  say(rec[0] && rec[0].recursive === true, '再帰だと分かる');
  say(rec[0] && rec[0].delayMs === 1000, `間隔は再帰側の 1000ms (実際 ${rec[0] && rec[0].delayMs}ms。600 に引きずられない)`);
  say(rec[0] && rec[0].verdict === 'ng', '1秒ごとの中継は ❌');

  // ⑥ 間隔が読めない物を **黙って捨てない**
  const unk = run(SAMPLE_UNKNOWN).sites;
  say(unk.length === 1 && unk[0].verdict === 'unknown', `間隔が読めない物も名指しする (実際 ${unk.length}件/${unk[0] && unk[0].verdict})`);

  // ⑦ 名前で渡した関数の中身も見る
  const named = run(SAMPLE_NAMED).sites;
  say(named.length === 1 && named[0].perHour === 40, `名前で渡した関数の中の保存も数える (実際 ${named.length}件/${named[0] && named[0].perHour}回per時)`);

  // ⑦a ⚠⚠1つ内側で書いている物も名指しする(見落とすと「全部名指し」が嘘になる)
  const ind = run(SAMPLE_INDIRECT).sites;
  say(ind.length === 1, `1つ内側で書いている物も名指しする (実際 ${ind.length}件)`);
  say(ind[0] && ind[0].writes.some((w) => w.via === 'drainAll'), 'どの関数の中で書いているかを出す(via)');
  say(ind[0] && ind[0].perHour === 240, `15秒ごと = 240回/時 (実際 ${ind[0] && ind[0].perHour})`);
  say(ind[0] && ind[0].verdict === 'warn', `240回/時 は ⚠（1日で枠の1割超・半分には届かない） (実際 ${ind[0] && ind[0].verdict})`);

  // ⑦b ⚠⚠同じ名前の定義が何個も在る時、仕掛けている場所に近い方を採る
  const same = run(SAMPLE_SAMENAME).sites;
  say(same.length === 1, `同名の関数を取り違えず、保存する方だけを名指しする (実際 ${same.length}件)`);
  say(same[0] && same[0].delayMs === 2000, `保存する方の間隔 2000ms を採る (実際 ${same[0] && same[0].delayMs}ms)`);
  say(findFnBody(SAMPLE_SAMENAME, 'tick', SAMPLE_SAMENAME.length).from
    > findFnBody(SAMPLE_SAMENAME, 'tick', 0).from, '手前でいちばん近い定義を選んでいる');

  // ⑪ 🚨🚨 NC3(2026-09-01): **窓口ごしの書き込みを数える**
  //   ここが空いていた為、0.2秒ごとの DATA(db).save(1日432,000回＝枠の21.6倍)が緑で通っていた。
  const ds = run(SAMPLE_DATA_SAVE).sites;
  say(ds.length === 1, `DATA(db).save(…) を1件見つける (実際 ${ds.length}件)`);
  say(ds[0] && ds[0].perHour === 18000, `0.2秒ごと = 18000回/時 (実際 ${ds[0] && ds[0].perHour})`);
  say(ds[0] && ds[0].verdict === 'ng', '0.2秒ごとの DATA(db).save は ❌');
  say(ds[0] && ds[0].shiftNg === true, '🚨1直で枠の半分に届く印が付く');
  const dr = run(SAMPLE_DATA_REMOVE).sites;
  say(dr.length === 1 && dr[0].verdict === 'ng', `DATA(db).remove(…) も数える (実際 ${dr.length}件/${dr[0] && dr[0].verdict})`);
  const al = run(SAMPLE_ALIAS_SAVE).sites;
  say(al.length === 1, `別名で受けた窓口(const P = DATA(db))ごしの P.save も数える (実際 ${al.length}件)`);
  say(al[0] && al[0].perHour === 3600, `1秒ごと = 3600回/時 (実際 ${al[0] && al[0].perHour})`);
  say(providerAliases(SAMPLE_ALIAS_SAVE).has('P'), '別名 P を窓口として拾う');
  const sf = run(SAMPLE_SETFIELDS).sites;
  say(sf.length === 1 && sf[0].verdict === 'ng', `setFields(項目の差し替え) も数える (実際 ${sf.length}件/${sf[0] && sf[0].verdict})`);
  const ap = run(SAMPLE_APPENDCAPPED).sites;
  say(ap.length === 1 && ap[0].verdict === 'ng', `appendCapped(配列に足す) も数える (実際 ${ap.length}件/${ap[0] && ap[0].verdict})`);
  // 🚨誤検出の側。ここが壊れると「絵を描くだけの処理」を保管庫への書き込みと名指しする
  const cv = run(SAMPLE_CANVAS_SAVE).sites;
  say(cv.length === 0, `🚨絵を描く ctx.save()/sc.save() は名指ししない (実際 ${cv.length}件)`);
  say(!providerAliases(SAMPLE_UNSUB_NOT_ALIAS).has('unsub'),
    '受けた直後に . が続く物(unsub = DATA(db).watchCollection…)は窓口として拾わない');
  say(run(SAMPLE_UNSUB_NOT_ALIAS).sites.length === 0, 'その unsub.save() も名指ししない');
  // 🚨 同じ場所を二重に数えていないか(名指しの P.save と 別名の P.save が両方当たる)
  const dupSrc = `
    const P = DATA(db);
    const t = setInterval(() => { P.save(APP_DATA_ID, 'lots', id, {}); }, 1000);
  `;
  const dup = run(dupSrc).sites;
  say(dup.length === 1 && dup[0].writes.length === 1,
    `同じ1か所を二重に数えない (実際 ${dup[0] && dup[0].writes.length}件)`);
  // 🚨 数える形の本数が **減っていないか**(誰かが黙って1行消したら落ちる)
  say(WRITE_CALLS.length === 11, `数える形は11本ある (実際 ${WRITE_CALLS.length}本)`);
  say(WRITE_CALLS.some((w) => /DATA/.test(w.re.source)),
    '🚨 WRITE_CALLS に「窓口ごしの書き込み(DATA(…).save/remove)」が入っている');

  // ⑫ 🚨🚨 NC3 第2弾: **窓口を分解して受ける形**(L1)。前の版は全部 0件＝緑だった。
  const de1 = run(SAMPLE_DESTRUCTURED).sites;
  say(de1.length === 1, `const { save } = DATA(db) ごしの save(…) を数える (実際 ${de1.length}件)`);
  say(de1[0] && de1[0].perHour === 18000, `0.2秒ごと = 18000回/時 (実際 ${de1[0] && de1[0].perHour})`);
  say(de1[0] && de1[0].verdict === 'ng', 'それは ❌ になる');
  say(providerFnAliases(SAMPLE_DESTRUCTURED).has('save'), '分解して受けた save を窓口として拾う');
  const de2 = run(SAMPLE_DESTRUCTURED_RENAMED).sites;
  say(de2.length === 1 && de2[0].verdict === 'ng',
    `名前を変えて受ける const { save: put } も数える (実際 ${de2.length}件/${de2[0] && de2[0].verdict})`);
  const de3 = run(SAMPLE_METHOD_REF).sites;
  say(de3.length === 1 && de3[0].verdict === 'ng',
    `関数だけ受ける const s = DATA(db).setFields も数える (実際 ${de3.length}件/${de3[0] && de3[0].verdict})`);
  const de4 = run(SAMPLE_DESTRUCTURED_VIA_ALIAS).sites;
  say(de4.length === 1 && de4[0].verdict === 'ng',
    `窓口の別名から分解する const { appendCapped } = P も数える (実際 ${de4.length}件/${de4[0] && de4[0].verdict})`);
  // 🚨誤検出の側(ここが壊れると、名前が同じだけの別物を「保管庫へ書いている」と名指しして嘘になる)
  say(run(SAMPLE_DESTRUCTURED_NOT_PROVIDER).sites.length === 0,
    '🚨窓口でない物からの const { save } = useEditorStore() は名指ししない');
  say(run(SAMPLE_DESTRUCTURED_READ).sites.length === 0,
    '🚨読む方 const { getAll } = DATA(db) は書き込みとして数えない');
  say(WRITE_METHODS.length === 5, `窓口の「書く」道具は5つ (実際 ${WRITE_METHODS.length}つ)`);
  // ⑫g〜i 🚨 別名で import した窓口
  const ia1 = run(SAMPLE_IMPORT_ALIAS).sites;
  say(ia1.length === 1 && ia1[0].verdict === 'ng',
    `import { DATA as D } ごしの D(db).save を数える (実際 ${ia1.length}件/${ia1[0] && ia1[0].verdict})`);
  say(importAliases(SAMPLE_IMPORT_ALIAS).get('D') === 'DATA', '別名 D の元が DATA だと分かる');
  say(factoryNames(SAMPLE_IMPORT_ALIAS).includes('D'), '窓口を作る名前に D が入る');
  const ia2 = run(SAMPLE_IMPORT_ALIAS_FN).sites;
  say(ia2.length === 1 && ia2[0].verdict === 'ng',
    `import { saveData as put } ごしの put(…) を数える (実際 ${ia2.length}件/${ia2[0] && ia2[0].verdict})`);
  const ia3 = run(SAMPLE_IMPORT_ALIAS_DESTRUCTURED).sites;
  say(ia3.length === 1 && ia3[0].verdict === 'ng',
    `別名 import した窓口を分解して受ける形も数える (実際 ${ia3.length}件/${ia3[0] && ia3[0].verdict})`);
  say(!importAliases(`import { useState as us } from 'react';`).has('us'),
    '🚨保管庫と関係のない import の別名は拾わない(react の useState など)');

  // ⑬ 🚨🚨 NC3 第2弾: **繰り返しの中の書き込み**(L3)。
  //   前の版は for 文の行を印字したうえで ✅ を付けていた(＝繰り返しの数を1回として数えていた)。
  const lp1 = run(SAMPLE_LOOP_UNKNOWN).sites;
  say(lp1.length === 1, `中括弧の無い for の中の DATA(db).save を見つける (実際 ${lp1.length}件)`);
  say(lp1[0] && lp1[0].perTick === null, '🚨 回る数が分からないので「1tick で何回か」を出さない(1回と数えない)');
  say(lp1[0] && lp1[0].verdict === 'unknown', `🚨 それは ❓＝止める (実際 ${lp1[0] && lp1[0].verdict})`);
  say(lp1[0] && lp1[0].unknownLoop.length === 1 && /for\(/.test(lp1[0].unknownLoop[0].loops[0].head),
    'どの繰り返しが読めないのかを名指しする');
  const lp2 = run(SAMPLE_LOOP_FOREACH).sites;
  say(lp2.length === 1 && lp2[0].verdict === 'unknown', `forEach の中も ❓ (実際 ${lp2[0] && lp2[0].verdict})`);
  const lp3 = run(SAMPLE_LOOP_NESTED).sites;
  say(lp3.length === 1 && lp3[0].verdict === 'unknown', `二重の繰り返しも ❓ (実際 ${lp3[0] && lp3[0].verdict})`);
  say(lp3[0] && lp3[0].unknownLoop[0].loops.length === 2,
    `二重だと繰り返しを2つ名指しする (実際 ${lp3[0] && lp3[0].unknownLoop[0].loops.length}つ)`);
  const lp4 = run(SAMPLE_LOOP_WHILE).sites;
  say(lp4.length === 1 && lp4[0].verdict === 'unknown', `while(…) の中も ❓ (実際 ${lp4[0] && lp4[0].verdict})`);
  // ✅ 読める形は **掛けて** 数える
  const lp5 = run(SAMPLE_LOOP_SLICED).sites;
  say(lp5[0] && lp5[0].perTick === 40, `slice(0,40) は 1tick 40回として掛ける (実際 ${lp5[0] && lp5[0].perTick})`);
  say(lp5[0] && lp5[0].perHour === 2400, `60秒ごと×40件 = 2400回/時 (実際 ${lp5[0] && lp5[0].perHour})`);
  say(lp5[0] && lp5[0].verdict === 'ng', '2400回/時 は ❌（掛けた結果で判定している）');
  const lp6 = run(SAMPLE_LOOP_COUNTED).sites;
  say(lp6[0] && lp6[0].perTick === 3 && lp6[0].perHour === 36,
    `for(i=0;i<3;i++) は3回 = 36回/時 (実際 ${lp6[0] && lp6[0].perTick}回/${lp6[0] && lp6[0].perHour})`);
  say(lp6[0] && lp6[0].verdict === 'ok', '5分ごと×3件は ✅ のまま(正しい形まで赤にしない)');
  const lp7 = run(SAMPLE_LOOP_ONCE).sites;
  say(lp7[0] && lp7[0].perTick === 1 && lp7[0].verdict === 'ok',
    `「1回しか回らない」と読める形(for … of [lot])は ✅ のまま (実際 ${lp7[0] && lp7[0].perTick}回/${lp7[0] && lp7[0].verdict})`);
  const lp8 = run(SAMPLE_LOOP_CONST_SLICE).sites;
  // ⚠ 90秒ごと×3件 = 120回/時。1日で枠の1割(2,000回)を超えるので ⚠ が正しい(❓でも❌でもない)。
  say(lp8[0] && lp8[0].perTick === 3 && lp8[0].perHour === 120 && lp8[0].verdict === 'warn',
    `const targets = ….slice(0,3) を受けた for も3回と読む (実際 ${lp8[0] && lp8[0].perTick}回/${lp8[0] && lp8[0].perHour}回per時/${lp8[0] && lp8[0].verdict})`);
  const lp9 = run(SAMPLE_LOOP_PUSHED).sites;
  say(lp9[0] && lp9[0].verdict === 'unknown',
    `🚨 const box = [] を後から push する物を「0個」と読まない (実際 ${lp9[0] && lp9[0].verdict})`);

  // ⑭ 🚨🚨 NC3 第3弾: **置き場(ref).current 越しの受け渡し**。
  //   直す前の見張りは、下の3件を **名指しすらしなかった**(＝完全に見えていなかった)。
  //   ⚠「名指しされない」で緑になるのがいちばん危ない形なので、まず **見えている事**を見る。
  say(refHandoffs('const r = useRef(null); r.current = doSave;').get('r') === 'doSave',
    '置き場に入れた関数の名前を読む (r.current = doSave → doSave)');
  say(!refHandoffs('r.current = null;').has('r'),
    '⚠ r.current = null は「関数を入れた」と読まない');
  const rh1 = run(SAMPLE_REF_HANDOFF).sites;
  say(rh1.length === 1,
    `🚨 置き場ごしに隠した書き込みを **名指しする** (実際 ${rh1.length}件。直す前は0件＝見えていなかった)`);
  say(rh1[0] && rh1[0].verdict === 'unknown',
    `🚨 その中の上限の無い繰り返しは ❓＝止める (実際 ${rh1[0] && rh1[0].verdict})`);
  say(rh1[0] && rh1[0].writes.some((w) => /置き場ごし/.test(String(w.via || ''))),
    'どの置き場をほどいたかを出す(via に「置き場ごし」と書く)');
  const rh2 = run(SAMPLE_REF_HANDOFF_FAST).sites;
  say(rh2[0] && rh2[0].perHour === 18000 && rh2[0].verdict === 'ng',
    `🚨 置き場ごしに隠した0.2秒ごとの書き込みは 18000回/時 で ❌ (実際 ${rh2[0] && rh2[0].perHour}回/${rh2[0] && rh2[0].verdict})`);
  const rh3 = run(SAMPLE_REF_HANDOFF_DIRECT).sites;
  say(rh3[0] && rh3[0].verdict === 'unknown',
    `🚨 boxRef.current(…) と直に呼ぶ形も追う (実際 ${rh3[0] && rh3[0].verdict})`);
  // ⚠ 止めすぎていない事も見る(上限が読めれば通す)。ここが赤くなると現場が出荷できなくなる。
  const rh4 = run(SAMPLE_REF_HANDOFF_CAPPED).sites;
  say(rh4[0] && rh4[0].perTick === 3 && rh4[0].verdict !== 'unknown',
    `置き場ごしでも上限が読めれば通す (実際 ${rh4[0] && rh4[0].perTick}回/${rh4[0] && rh4[0].verdict})`);

  // ⑭e 🚨 名前で見逃さない。「人が押した時だけ」の顔でも、時計から回るなら数える。
  const hf1 = run(SAMPLE_HANDLER_FACE).sites;
  say(hf1[0] && hf1[0].verdict === 'unknown',
    `🚨 handleClick… という名前でも、時計から回れば ❓＝止める (実際 ${hf1[0] && hf1[0].verdict})`);
  const hf2 = run(SAMPLE_HANDLER_FACE_CAPPED).sites;
  say(hf2[0] && hf2[0].perTick === 4,
    `🚨 onSubmit… という名前でも 1tick 4回とちゃんと数える (実際 ${hf2[0] && hf2[0].perTick}回)`);
  // 🚨 繰り返しが1つも無い時に、余計な掛け算をしていないか
  say(run(SAMPLE_FIXED).sites[0].perTick === 1, '繰り返しが無い時は 1tick 1回のまま');
  say(budgetOf(60000, 300).perHour === 18000, `1分ごと×300件 = 18000回/時 (実際 ${budgetOf(60000, 300).perHour})`);
  say(budgetOf(60000, null).verdict === 'unknown', '「何回書くか分からない」は ❓（黙って1回と数えない）');

  // ⑧b 🚨 NC3(2026-09-01) 枠の数の出どころ。**黙って既定値へ落ちない**事を毎回見る。
  //   この見張りは4アプリで同じ1つの物にしたので、現物(quotaMeter.js)が無いアプリでも
  //   起動はする。だが「無かったので既定値を使った」を黙っていると、
  //   数を2か所で持っているのに誰も気づかない形になる。
  const quotaHere = fs.existsSync(path.join(ROOT, 'src', 'domain', 'quotaMeter.js'));
  say(LIMIT_WRITES > 0, `1日の枠が数として出ている (実際 ${LIMIT_WRITES}回)`);
  say(quotaHere === LIMIT_FROM_FILE,
    `枠の出どころが実物と合っている (現物 ${quotaHere ? '有' : '無'} / ${LIMIT_SOURCE})`);

  // ⑧ 線そのもの
  //   ❌ =「1つの機能が1日の枠の半分(10000回)以上を使う」= 10000/24時間 ≒ 416.7回/時
  say(Math.round(NG_PER_HOUR * 10) / 10 === 416.7, `❌の線は 1時間 約416.7回 (実際 ${NG_PER_HOUR})`);
  say(SHIFT_NG_PER_HOUR === 1250, `1直で半分の線は 1時間 1250回 (実際 ${SHIFT_NG_PER_HOUR})`);
  say(budgetOf(3600000 / 417).verdict === 'ng', '417回/時（1日で枠の半分に届く）は ❌');
  say(budgetOf(3600000 / 416).verdict !== 'ng', '416回/時 は ❌ にしない');
  say(budgetOf(3600000 / 1250).shiftNg === true, '1250回/時 は「1直で半分」の印が付く');
  say(budgetOf(3600000 / 417).shiftNg === false, '417回/時 には「1直で半分」の印は付かない');
  say(budgetOf(3600000 / 84).verdict === 'warn', '84回/時（1日で枠の1割超）は ⚠');
  say(budgetOf(3600000 / 60).verdict === 'ok', '60回/時（1分ごと）は ✅');
  say(budgetOf(0).verdict === 'unknown', '0ms は「読めない」扱い');

  // ⑨ 見張りが「何も見ていない」状態で合格していないこと
  say(bad1.length > run(SAMPLE_NO_WRITE).sites.length, '壊れた見本の方が指摘が多い(見張りが実際に効いている)');

  // ⑩ 🔒 中継の門(2026-08-31): **実物の関数を呼んで**確かめ、①②③がそろった時だけ数え直す
  const okChecks = relayGateChecks(gateMock());
  say(okChecks.length >= 9 && okChecks.every((c) => c.ok),
    `門が本物なら全部 ✅ (実際 ${okChecks.filter((c) => c.ok).length}/${okChecks.length})`);
  // 🚨 本数が減っていないか(検査を1本でも落としたら、この見張りは前より弱い)
  say(okChecks.length === 10, `①②の検査は10本ある (実際 ${okChecks.length}本)`);
  say(relayWiringChecks('').length === 5, `③の配線の検査は5本ある (実際 ${relayWiringChecks('').length}本)`);
  say(relayGateChecks(gateMock({ viewerGate: false })).some((c) => !c.ok), '①を外す(誰も見ていなくても送る)と ❌ が出る');
  say(relayGateChecks(gateMock({ capGate: false })).some((c) => !c.ok), '②を外す(上限で止まらない)と ❌ が出る');
  say(relayGateChecks(gateMock({ cap: LIMIT_WRITES / 2 })).some((c) => !c.ok), '②の上限を枠の半分へ緩めると ❌ が出る(線を上げて緑は不可)');
  say(relayGateChecks(gateMock({ stale: 75000 })).some((c) => !c.ok), '①の見切りを75秒へ緩めると ❌ が出る(方針は30秒)');
  say(relayGateChecks(gateMock({ slack: 120000 })).some((c) => !c.ok), '①の時計ズレの余裕を2分へ広げると ❌ が出る(青天井にさせない)');
  say(relayGateChecks(null).some((c) => !c.ok), 'domain が読めない時も ❌ (黙って緑にしない)');
  // 🚨🚨 2026-08-31 夜: 時計を混ぜる門(受け取った時刻を見ない版)を **見張りが見抜くか**
  //   ここが無いと「相手の時計で引き算する門」が緑のまま通り、
  //   時計が18秒ずれた端末では見ている最中に送信が止まる(現場は「映らない」と言う)。
  //   ⚠実測(直す前の製品の見張り): この門を 9/9 ✅ で素通ししていた。
  const seenBad = relayGateChecks(gateMock({ seenGate: false }));
  say(seenBad.some((c) => !c.ok),
    '🚨①の判定を「相手の時計の viewAt」との引き算に戻すと ❌ が出る(時計ズレで見ている人を追い出す門)');
  say(seenBad.find((c) => /見ている人がいる間は送る/.test(c.label))?.ok === false,
    '🚨その時に落ちるのは「見ている間は送る」の方(＝止まってはいけない場面で止まっている)');
  // 🚨 余裕を足しても、そこを越えたら止まる事。「印が無ければ一生送り続ける」を許さない
  say(relayGateChecks(gateMock({ slack: 600_000 })).some((c) => !c.ok),
    '🚨 時計ズレの余裕を10分へ広げると ❌ が出る(余裕込みでも75秒まで)');
  const gated = run(SAMPLE_RELAY_GATED).sites;
  say(gated.length === 1 && gated[0].verdict === 'ng', `数え直す前は素の速さで ❌ (実際 ${gated[0] && gated[0].verdict})`);
  const capped = applyRelayCap(gated[0], gateMock());
  say(capped.relayCapped === true && capped.verdict !== 'ng', `①②③がそろえば ❌ を外れる (実際 ${capped.verdict})`);
  say(capped.perHour === Math.ceil(4000 / 24), `上限4,000回/日 → ${Math.ceil(4000 / 24)}回/時 相当 (実際 ${capped.perHour})`);
  say(capped.verdict === 'warn', `枠の2割は ⚠(1日で1割超)止まり。✅ とは言わない (実際 ${capped.verdict})`);
  const noWire = applyRelayCap(run(SAMPLE_RELAY_NO_TODAY).sites[0], gateMock());
  say(noWire.relayCapped === false && noWire.verdict === 'ng', '③tick が todayWrites を渡していなければ ❌ のまま');
  // 🔢 記憶の床(2026-08-31 夜・実測で確かめた形): 控えの値で入れ替える配線は ❌ のまま
  const noFloor = applyRelayCap(run(SAMPLE_RELAY_NO_FLOOR).sites[0], gateMock());
  say(noFloor.relayCapped === false && noFloor.verdict === 'ng',
    '③tick が今日の回数を控えの値で入れ替えていたら ❌ のまま(控えに書けない端末で上限が閉まらない)');
  const noSeenWire = applyRelayCap(run(SAMPLE_RELAY_NO_SEEN).sites[0], gateMock());
  say(noSeenWire.relayCapped === false && noSeenWire.verdict === 'ng',
    '🚨③tick が viewSeenAt(印を受け取った時刻)を渡していなければ ❌ のまま(30秒の心拍が本番で効かない)');
  const brokenDomain = applyRelayCap(gated[0], gateMock({ capGate: false }));
  say(brokenDomain.relayCapped === false && brokenDomain.verdict === 'ng', '門(domain)が壊れていれば tick 側が正しくても ❌ のまま');

  console.log(bad === 0 ? '🧪 見張り自身の試験: 合格\n' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗\n`);
  return bad === 0;
};

// ---------------------------------------------------------------------------
// 実コードを見る
// ---------------------------------------------------------------------------
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '__tests__', '.git', 'coverage']);

const walk = (dir, out = []) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); continue; }
    if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
};

/** 🔒 門の本体(src/domain/liveSession.js の実物)。読めなければ null(=門は確かめられない→❌のまま)。 */
const loadDomain = async () => {
  try { return await import(pathToFileURL(path.join(ROOT, 'src', 'domain', 'liveSession.js')).href); }
  catch { return null; }
};

/** 🎥 中継のコマ送りの間隔は、決め値のファイルから読む(ここに数字を書き写さない)。 */
const loadHints = (mod) => {
  const hints = [];
  const speeds = Object.values((mod && mod.FRAME_SPEEDS) || {}).filter((s) => Number(s && s.everyMs) > 0);
  if (speeds.length) {
    // ⚠一番速い設定で数える。**いちばん食う時**を見ないと意味がない。
    const fastest = speeds.reduce((a, b) => (Number(a.everyMs) <= Number(b.everyMs) ? a : b));
    hints.push({
      re: /everyMs/,
      ms: Number(fastest.everyMs),
      why: `src/domain/liveSession.js の FRAME_SPEEDS のうち一番速い「${fastest.key}」= ${fastest.everyMs}ms`,
    });
  }
  return hints;
};

const main = async (args) => {
  if (args.includes('--selftest')) return selftest() ? 0 : 1;

  // ⚠まず見張り自身の試験を通してから実コードを見る(壊れた物差しで測らない)
  if (!selftest()) {
    console.error('❌ 見張り自身が壊れているので、実コードの判定はしません。');
    return 1;
  }

  const mod = await loadDomain();
  const hints = loadHints(mod);
  const given = args.filter((a) => !a.startsWith('--'));
  const files = (given.length ? given : walk(path.join(ROOT, 'src')))
    .filter((f) => fs.existsSync(f));

  if (!files.length) { console.log('（見るファイルがありません）'); return 0; }

  console.log(`🚨 繰り返し書く処理をぜんぶ数えます（1日の枠 ${LIMIT_WRITES}回）`);
  console.log(`   枠の数の出どころ: ${LIMIT_SOURCE}`);
  console.log(`   ❌の線 = 1つの機能で1日の枠の半分(${LIMIT_WRITES / 2}回)以上 ＝ 1時間 ${Math.round(NG_PER_HOUR * 10) / 10}回`);
  console.log(`   🚨さらに 1直(${SHIFT_HOURS}時間)で半分に届く = 1時間 ${SHIFT_NG_PER_HOUR}回`);
  console.log(`   見たファイル: ${files.length}件`);
  if (hints.length) console.log(`   手がかり: ${hints[0].why}`);
  console.log('');

  const found = [];
  for (const f of files) {
    const rel = path.relative(ROOT, path.resolve(f)) || f;
    const r = analyze(fs.readFileSync(f, 'utf8'), rel, { hints });
    found.push(...r.sites);
  }
  // 🔒 スマホ中継の tick(frameSendPlan を呼ぶ物)だけは、①見ている人がいる時だけ
  //   ②1日の硬い上限 ③その配線 を **実コードで確かめてから**、上限の最悪値で数え直す。
  //   確かめられなければ素の速さのまま ❌(黙って緑にしない)。
  const all = found.map((s) => (/\bframeSendPlan\s*\(/.test(s.bodyText || '') ? applyRelayCap(s, mod) : s));
  all.sort((a, b) => (b.perHour || 0) - (a.perHour || 0));

  if (!all.length) {
    console.log('✅ 繰り返し保管庫へ書く処理は見つかりませんでした。');
    return 0;
  }

  let ng = 0, warn = 0, unknown = 0, totalPerHour = 0;
  for (const s of all) {
    const mark = MARK[s.verdict];
    if (s.verdict === 'ng') ng++;
    else if (s.verdict === 'warn') warn++;
    else if (s.verdict === 'unknown') unknown++;
    if (s.perHour) totalPerHour += s.perHour;

    const how = s.recursive ? '再帰の setTimeout' : 'setInterval';
    console.log(`${mark} ${s.file}:${s.timerLine}  ${s.name}（${how}）`);
    if (s.perHour == null) {
      if (s.delayMs == null) {
        console.log(`   間隔: ❓ ${s.delayWhy}`);
        console.log('   ⚠ 間隔が読めないので回数を出せません。**黙って通しません。**手がかりを足すか、数字で書いてください。');
      } else {
        console.log(`   間隔: ${s.delayMs}ms … ${s.delayWhy}`);
      }
      // 🚨 繰り返しの数が読めなかった時。**1回と数えて通す事は絶対にしない。**
      for (const w of (s.unknownLoop || [])) {
        console.log(`   ❓ ${s.file}:${w.line}${w.via ? `（${w.via}() の中）` : ''} は **繰り返しの中**で書いています`);
        for (const lp of w.loops) {
          console.log(`      繰り返し: ${lp.head}`);
          console.log(`      → ${lp.n == null ? `🚨 ${lp.why}` : `${lp.n}回`}`);
        }
        console.log('      🚨 **何回書くのか分かりません。** 1tick で1回とは数えません。');
        console.log('         直し方: ① 回る数を上限つきにする(例 list.slice(0, 40)) ②「1回だけ」と読める形にする');
        console.log('         ③ どうしても分からない時は、この繰り返しを時計から外す');
      }
    } else {
      console.log(`   間隔: ${s.delayMs}ms … ${s.delayWhy}${s.delayAssumed ? ' ⚠推定' : ''}`);
      // 🔒 中継の門の確認結果(あれば)。1行ずつ全部出す(何を確かめて通したのかを隠さない)。
      if (s.relayChecks) {
        for (const c of s.relayChecks) console.log(`   ${c.ok ? '✅' : '❌'} ${c.label}`);
        if (s.relayCapped) {
          console.log(`   🔒 素の速さ(${s.rawPerHour}回/時)は上の門で **1日${s.relayCap}回(枠の${Math.round((s.relayCap / LIMIT_WRITES) * 100)}%)** までに必ず抑えられる`);
          console.log(`      → ${s.perHour}回/時 相当として判定します（門を1つでも外すと、この数え直しは無効＝❌に戻る）`);
        } else {
          console.log('   🔒 門を実コードで確かめられなかったので、素の速さのまま判定します（緑にしない）');
        }
      }
      // 🚨 1tick で2回以上書く時は、その根拠(どの繰り返しが何回か)を必ず出す
      if (s.perTick > 1) {
        console.log(`   🔁 1tick で ${s.perTick}回 書きます（間隔ぶんの回数に掛けています）`);
        for (const w of s.writes.filter((x) => x.mul > 1)) {
          for (const lp of w.loops) console.log(`      ${s.file}:${w.line} ← ${lp.head} … ${lp.why}`);
        }
      }
      console.log(`   1時間あたり: ${s.perHour}回${s.perTick > 1 ? `（${Math.round(3600000 / s.delayMs)}tick × ${s.perTick}回）` : ''}`);
      console.log(`   1日の枠(${LIMIT_WRITES}回)を使い切るまで: ${s.hoursToLimit}時間 ／ 半分(${LIMIT_WRITES / 2}回)まで: ${s.hoursToHalf}時間`);
      if (s.verdict === 'ng') {
        console.log(`   ❌ この1つの機能だけで1日の枠の半分(${LIMIT_WRITES / 2}回)以上を使います（${s.hoursToHalf}時間で半分）`);
        if (s.shiftNg) {
          console.log(`   🚨 しかも1直(${SHIFT_HOURS}時間)動かすだけで半分に届きます（朝から使えば昼過ぎには半分）`);
        }
      } else if (s.verdict === 'warn') {
        console.log(`   ⚠ 1日動かすと枠の1割(${LIMIT_WRITES * 0.1}回)を超えます`);
      }
    }
    s.writes.slice(0, 3).forEach((w) => console.log(
      `   書いている所: ${s.file}:${w.line}${w.via ? `（${w.via}() の中）` : ''}`
      + `${w.loops && w.loops.length ? `【繰り返しの中 ${w.mul == null ? '🚨回る数が分かりません' : `×${w.mul}`}】` : ''}`
      + `  ${w.what}  ${w.code}`));
    if (s.writes.length > 3) console.log(`   … ほか ${s.writes.length - 3}件`);
    console.log('');
  }

  console.log('──────────────────────────────────────────');
  console.log(`名指しした処理: ${all.length}件（❌ ${ng} / ⚠ ${warn} / ❓ ${unknown}）`);
  if (totalPerHour > 0) {
    const h = Math.round((LIMIT_WRITES / totalPerHour) * 10) / 10;
    console.log(`全部が同時に動いた時: 1時間あたり ${totalPerHour}回 → 1日の枠を ${h}時間 で使い切ります`);
    console.log('⚠ これは1台ぶんです。2台で同時に使えば半分の時間で尽きます。');
    console.log('⚠ 読み取りも同じだけ出ます（書込1回 = 見ている人1人につき読取1回）。');
  }
  console.log('⚠ 枠は4アプリ（製品検査・最終検査・部品検査・司令塔）で分け合っています。');
  console.log('');
  // ⚠⚠ **見えない物を「無い」と言わない。** 見張りの届く範囲を毎回そのまま出す。
  console.log('── この見張りに見えない物（人が見る所） ──');
  console.log('  ・引数で渡された関数の中の保存（例: src/data/outbox.js の drain() は apply() を呼ぶだけで、');
  console.log('    実際に書くのはその apply()。誰を渡したかはこのファイルからは分からない）');
  console.log('  ・2段より内側で書いている物（追うのは1段だけ）');
  console.log('  ・人が押した時だけ走る保存（繰り返しではないので、ここでは数えない）');
  console.log('  ・購読(onSnapshot)が呼び戻す中での保存');
  // 🚨 NC3(2026-09-01)で窓口ごしの書き込みを数えるようにした時に、**まだ拾えない形**。
  //   2026-09-01 時点では4アプリのどれにも1件も無い(実測)。増えたらここが穴になる。
  console.log('  ・窓口を「引数でもらう」形で、受け皿の名前が P 以外の物');
  console.log('    （src/liveRooms.js の makeRoomApi(P, ns) だけは P を名指しして数えている）');
  console.log('  ・DATA( … ) の中にさらに ( ) が入る形（例 DATA(getDb()).save）… 実コードに0件');
  // 🚨 NC3(2026-09-01) 繰り返しを数えるようにした時に、**わざと数えない事にした物**。
  console.log('  ・同じ繰り返しの中に書く所が2つ以上あっても、いちばん多い1つで数えます（足しません）');
  console.log('    → 実際はこれ以上になりえます。枝分かれ(if/else)を足して嘘の ❌ を出さない為');
  console.log('  ・時計そのものを外側から囲んでいる繰り返し（＝時計が何個も仕掛かる形）');
  console.log('  ・繰り返しの回数が実行時にしか決まらない物は、数えずに ❓＝止めます（通しません）');
  console.log('');

  if (args.includes('--list')) {
    console.log('（--list なので、指摘があっても止めません）');
    return 0;
  }
  if (ng || unknown) {
    const noLoop = all.filter((s) => s.verdict === 'unknown' && s.perTick == null).length;
    const noDelay = unknown - noLoop;
    console.log(`❌ 出荷できません（❌ ${ng}件 / 間隔が読めない ${noDelay}件 / 🚨繰り返す数が分からない ${noLoop}件）`);
    return 1;
  }
  console.log('✅ 1日の枠の半分を1直で使う処理はありません。');
  return 0;
};

// ⚠ここから下は「直接動かした時」だけ。import して analyze() だけ使う道を塞がない。
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(await main(process.argv.slice(2)));
