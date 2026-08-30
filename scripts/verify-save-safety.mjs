// ============================================================================
// 🚨🚨 保存の安全 — 機械の見張り (2026-08-17 の事故を二度と起こさないため)
// ----------------------------------------------------------------------------
// 【何が起きたか】2026-08-12 の検査の作業時間が丸ごと消えた(5ロット/うち2件は
//   「完了」なのに記録0件)。復旧手段はゼロだった。
//   原因は **保存の順番**。saveData は
//     ① 写真を lot_images へ書き、**そのサーバ受領を await してから**
//     ② ロット本体(tasks＝作業時間)を書く
//   だったので、通信が詰まっている間に画面を閉じると ①だけが端末の待ち行列に残り、
//   ②は「await の続き」ごと消えて **待ち行列に一度も入らなかった**。
//   ＝ 写真だけ残って作業記録が無い。
//
// 【それを見えなくしていた物】
//   ・画面の tasks が サーバと合わせ直されない  → 送れていなくても「済み」に見える
//   ・保存が await も catch もされていない        → 失敗が誰にも届かない
//   ・「サーバに届いたか」を人が確かめる手段が無い(hasPendingWrites の使用が0件)
//
// 【この見張りが数える物】(1つずつ、負の対照つき)
//   ① SS-1 保存の順番   : 写真の受領を待ってから本体を書く形
//   ② SS-2 投げっぱなし : onSave( / saveData( が await も catch も無い所
//   ③ SS-3 購読の onError: watch( / onSnapshot( に onError が無い所
//   ④ SS-4 空マップ     : {} をそのまま保管庫へ送る道
//   ⑤ SS-5 「済み」の嘘 : 一度だけ初期化してサーバと合わせ直さない画面の state
//   ⑥ SS-6 未送信の見せ方: hasPendingWrites を人に見せているか
//   ⑦ SS-7 1MBに載る写真 : 別置き(dehydrate)の対象外の写真
//   ⑧ SS-8 関所         : ロット本体を書く所が 順番の関所(runLotWrite)を通っているか
//
// 【⚠既存の見張りとの分担】重ねない。重ねると「直す所」が水増しされて本物が埋もれる。
//   ・verify-worktime-guard.mjs … 中身が **消える** 保存(tasks:{}・関所の迂回・if(lot.tasks))
//   ・この見張り                … **順番・投げっぱなし・見えない事**(消えない保存でも起きる)
//   だから SS-4 は tasks を見ない(tasks:{} は WTG-020/021 の担当)。
//
// 【4アプリ全部を見る】1つでも漏れたらそこで起きる。
//   APP_ROOT=C:\Users\anrw3\product-inspection-app node scripts/verify-save-safety.mjs
//
// 【使い方】
//   node scripts/verify-save-safety.mjs                 … このリポを見る
//   APP_ROOT=<path> node scripts/verify-save-safety.mjs … 別のアプリを見る
//   node scripts/verify-save-safety.mjs --json          … 機械が読む形で出す
//   node scripts/verify-save-safety.mjs --selftest      … 見張り自身の試験だけ
//   環境変数 SAVE_SAFETY_LIST_ONLY=1 … 一覧だけ出して常に exit 0(移行の途中で使う)
//   環境変数 SAVE_SAFETY_NO_SELFTEST=1 … 自己試験を飛ばす(自己試験の中から呼ぶ時だけ)
//
// ⚠⚠ **誤検出する見張りは、いずれ全部無視される。**
//   だから analyzeSources() は純関数にして、scripts/selftest-save-safety.mjs で
//   「わざと壊した見本で落ちる／正しい見本で通る」を毎回機械で確かめてから実コードを見る。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 下ごしらえ(全部 純関数)
// ============================================================================

// ---------------------------------------------------------------------------
// 🚨🚨 括弧の数え方(ここを甘くすると、見張りが **黙って「0件」と言う**)
// ---------------------------------------------------------------------------
// 実測 2026-08-18: 素朴に `'` `"` だけを見て数えたら、正規表現の中の引用符
//   (例: /[\\/:*?"<>|]/g の `"`)が **文字列の始まり** と誤解され、そこから括弧の
//   対応が丸ごとズレた。最終検査の App では「3行以上またぐ文字列」が **1399件** 検出され、
//   保存の関所(saveData)が「見つからない」＝ **①も⑧も 0件で合格** という嘘が出た。
//   → 正規表現・テンプレート・素の文字列を1つずつ正しく飛ばす。
//   → さらに、数え終わって釣り合っていなければ **SS-000 で赤にする**(黙って0件と言わない)。
// ---------------------------------------------------------------------------

/** 素の文字列。⚠ 行をまたぐ '...' "..." は無い → 行末で打ち切る(誤検出の連鎖を止める堤防)。 */
const skipString = (src, i) => {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j + 1;
    if (c === '\n') return j;
  }
  return src.length;
};

/** 正規表現。⚠ [ ] の中の `/` は終わりではない。1行で閉じなければ割り算とみなす。 */
const skipRegex = (src, i) => {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return i + 1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
  }
  return i + 1;
};

/** テンプレート。`${ }` の中は普通のコードなので、入れ子のテンプレートも正しく飛ばす。 */
const skipTemplate = (src, i) => {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') {
      let depth = 0, k = j + 1;
      for (; k < src.length; k++) {
        const e = skipLiteralAt(src, k);
        if (e > k) { k = e - 1; continue; }
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) break; }
      }
      j = k;
    }
  }
  return src.length;
};

// `/` が正規表現の始まりになれる位置(直前の意味のある文字で決まる)。
// 🚨🚨 JSX があるので `<` `>` `{` `}` は **入れてはいけない**。
//   実測 2026-08-18: `>` を入れていたら `</b>` の `/` を正規表現の始まりと誤解し、
//   同じ行の次の `/` まで丸ごと飛ばして **括弧の対応が崩れた**(最終検査の App が読めなくなった)。
//   ただし `=>` の後ろの正規表現(`s => /abc/.test(s)`)は本物なので、`=>` だけは残す。
//   ⚠ 算術記号(`+ - * % ~ ^`)も入れてはいけない。実測: 画面の文字
//     「直工{r}% / 合計{(t/60)}h」の `%` の後ろの `/` を正規表現の始まりと誤解して
//     波括弧を1つ飲み込んだ。`a + /re/` のような書き方は現実に存在しない。
const REGEX_PREV = /(?:=>|[(,=:[!&|?;]|\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void))\s*$/;

/** src[i] が文字列/テンプレート/正規表現の始まりなら、その次の位置を返す。違えば i。 */
export const skipLiteralAt = (src, i) => {
  const c = src[i];
  if (c === '"' || c === "'") return skipString(src, i);
  if (c === '`') return skipTemplate(src, i);
  // ⚠ `</div>` の `/` は閉じ札。正規表現ではない。
  if (c === '/' && src[i - 1] !== '<' && REGEX_PREV.test(src.slice(Math.max(0, i - 12), i))) return skipRegex(src, i);
  return i;
};

/**
 * コメントを消す(位置と行番号は1文字もずらさない)。
 * ⚠ これが無いと、説明のために書いた例示コードを「実コード」として数えて嘘の指摘になる
 *   (2026-08-16 に実際にやった)。
 * 🚨🚨 **文字列の中を見てはいけない。** 実測 2026-08-18:
 *   accept="image/(星印)" の中の「斜線＋星印」を注釈の始まりと誤解して、そこから
 *   3行下のJSX注釈の終わりまで丸ごと消していた。消えた中に波括弧が入っていたので
 *   括弧の対応が崩れ、保存の関所が「見つからない」= 全項目0件で合格、という嘘が出る一歩手前だった。
 * ⚠ URL の `//` を消さないよう、直前が `:` の時は行コメントとみなさない。
 */
export const stripComments = (src) => {
  const ranges = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i) - 1; continue; }
    if (c === '`') { i = skipTemplate(src, i) - 1; continue; }
    if (c !== '/') continue;
    const n = src[i + 1];
    if (n === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      ranges.push([i, end]); i = end - 1; continue;
    }
    if (n === '/' && src[i - 1] !== ':') {
      let e = src.indexOf('\n', i); if (e < 0) e = src.length;
      ranges.push([i, e]); i = e - 1; continue;
    }
    if (src[i - 1] !== '<' && REGEX_PREV.test(src.slice(Math.max(0, i - 12), i))) { i = skipRegex(src, i) - 1; }
  }
  let out = '', last = 0;
  for (const [s, e] of ranges) { out += src.slice(last, s) + src.slice(s, e).replace(/[^\n]/g, ' '); last = e; }
  return out + src.slice(last);
};

/** `(` から対応する `)` まで。文字列・テンプレート・正規表現・入れ子の括弧を飛ばす。 */
export const readParen = (src, openIdx) => {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const e = skipLiteralAt(src, i);
    if (e > i) { i = e - 1; continue; }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i }; }
  }
  return { inner: src.slice(openIdx + 1), end: src.length };
};

/** 引数を「深さ0のカンマ」で割る。 */
export const splitArgs = (inner) => {
  const out = [];
  let depth = 0, last = 0;
  for (let i = 0; i < inner.length; i++) {
    const e = skipLiteralAt(inner, i);
    if (e > i) { i = e - 1; continue; }
    const c = inner[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(inner.slice(last, i)); last = i + 1; }
  }
  out.push(inner.slice(last));
  return out.map((s) => s.trim()).filter((s, i2, a) => s !== '' || i2 < a.length - 1);
};

/** その位置から「1つの文」を取り出す(深さ0の `;` まで。閉じ括弧に当たったらそこまで)。 */
export const statementFrom = (src, idx, cap = 8000) => {
  let depth = 0;
  for (let i = idx; i < src.length && i - idx < cap; i++) {
    const e = skipLiteralAt(src, i);
    if (e > i) { i = e - 1; continue; }
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (depth < 0) return src.slice(idx, i); }
    else if (c === ';' && depth === 0) return src.slice(idx, i + 1);
  }
  return src.slice(idx, Math.min(src.length, idx + cap));
};

/**
 * ファイル全体の `{ ... }` を **1回のなぞりで** 全部拾って、親子を覚える。
 * ⚠ 1件ごとに後ろ向きへなぞると 3MB のファイルで何億回も回る(実測で使い物にならない)。
 * @returns { blocks, byStart, balanced } balanced=false なら **この見張りは当てにならない**。
 */
export const buildBlocks = (src) => {
  const stack = [], blocks = [];
  let broke = false;
  for (let i = 0; i < src.length; i++) {
    const e = skipLiteralAt(src, i);
    if (e > i) { i = e - 1; continue; }
    const c = src[i];
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const s = stack.pop();
      if (s === undefined) broke = true;
      else blocks.push({ start: s, end: i, parent: stack.length ? stack[stack.length - 1] : -1 });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  const byStart = new Map();
  blocks.forEach((b, i) => byStart.set(b.start, i));
  return { blocks, byStart, balanced: !broke && stack.length === 0 };
};

/** idx を囲む一番内側の `{ }` の番号。無ければ -1。 */
export const innermostBlock = ({ blocks, byStart }, idx) => {
  let lo = 0, hi = blocks.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (blocks[mid].start <= idx) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  // 兄弟(idx より前に閉じた塊)は「その親」へ飛ばす。入れ子なので必ず親が候補になる。
  let guard = 0;
  while (k >= 0 && blocks[k].end < idx && guard++ < 10000) {
    const p = blocks[k].parent;
    k = p >= 0 && byStart.has(p) ? byStart.get(p) : -1;
  }
  return k >= 0 && blocks[k].start <= idx && blocks[k].end >= idx ? k : -1;
};

// 関数の本体の `{` は、その手前が `=>` か `function (...)` で終わる。
// ⚠ `if (...) {` も手前が `)` なので、`)` だけで判定してはいけない。
const FN_HEAD = /(=>|function\s*[\w$]*\s*\([^()]*\))\s*$/;

/** idx を囲む「関数の本体」を内側から順に返す(最大 max 個)。 */
export const enclosingFunctions = (src, index, idx, max = 8) => {
  const out = [];
  let k = innermostBlock(index, idx), guard = 0;
  while (k >= 0 && out.length < max && guard++ < 10000) {
    const b = index.blocks[k];
    if (FN_HEAD.test(src.slice(Math.max(0, b.start - 200), b.start))) out.push(b);
    const p = b.parent;
    k = p >= 0 && index.byStart.has(p) ? index.byStart.get(p) : -1;
  }
  return out;
};

const lineOfFactory = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1, k = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= idx) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k + 1;
  };
};

// ============================================================================
// 言葉の定義(どの語を「保存」「写真」「記録」とみなすか)
// ============================================================================

/** 保管庫へ書く動き。⚠ `.push(` のような手元の操作は入れない(誤検出のもと)。 */
const WRITE_VERB = /(?:\.save|setDoc|addDoc|updateDoc|writeDoc|\.put)\s*\(/g;
/** 写真・図の入れ物らしい名前(文字列で書いてある時)。 */
const IMAGE_LITERAL = /(['"])[\w/-]*(?:image|img|photo|diagram|picture)[\w/-]*\1/i;
/** ロット本体(＝作業時間が入る所)を書く形。 */
const LOT_BODY_WRITE = /runLotWrite\s*\(|(?:\.save|setDoc|addDoc|updateDoc)\s*\([^;]{0,160}?(?:['"]lots['"]|,\s*col\s*,)|saveData\s*\(\s*['"]lots['"]/;
/** ロットの doc らしさ。これが無いオブジェクトを「本番のロット」と呼ばない。 */
const LOT_DOC_FIELDS = /\b(orderNo|serialNo|steps|interruptions|mapZoneId|templateId|unitSerialNumbers|quantity|dueDate|tasks)\s*:/;
/** 作業の記録そのもの(これが入っている保存は失敗が致命的)。 */
const RECORD_KEYS = /(?<![.\w$])(tasks|interruptions|interruptionsMap|stepTimes|stepUnitTimes|measurementResults|totalWorkTime|duration|startTime|endTime)\s*:/;
/** 画面を閉じる・次へ進む動き(この直前の保存を待たないと、手元の記録ごと消える)。 */
const CLOSING_CALLS = /(?<![.\w$])(onClose|onFinish|onCompleted|closeModal|setExecutionLotId\s*\(\s*null|setShow\w*\s*\(\s*false|setOpen\s*\(\s*false|setEditModal|navigate|window\.close)\s*\(/;
/**
 * 写真らしい鍵。⚠ 鍵の名前は勝手に増える(signaturePhoto など)ので、語を **含む** 物を拾う。
 * ⚠ ただし `photoCount:` `imageWidth:` のような **写真そのものではない** 鍵を拾うと嘘になる。
 *   数・大きさ・札・名前で終わる鍵は落とす(下の PHOTO_KEY_DENY)。
 */
const PHOTO_KEY = /(?<![.\w$])([\w$]*(?:photo|image|img|picture|drawing|diagram|thumbnail|dataurl)[\w$]*)\s*:/gi;
const PHOTO_KEY_DENY = /(count|length|len|num|size|width|height|ratio|idx|index|id|ids|ref|refs|key|keys|name|at|enabled|topic|topics|mode|type|quality|max|min|limit|flag|ok)$/i;
/** DOM の出来事の受け口(ここに渡した約束は React が捨てる = 失敗が誰にも届かない)。 */
const DOM_HANDLER = /(on(?:Click|Change|Submit|Blur|Focus|KeyDown|KeyUp|KeyPress|Input|DoubleClick|MouseDown|MouseUp|TouchStart|TouchEnd|PointerDown|Drop|DragOver|Ended|Load|Scroll|Wheel|ContextMenu))\s*=\s*\{\s*(?:async\s*)?\([^()]*\)\s*=>\s*$/;
/** 「保存」と呼ぶ名前。⚠ 定義(`const saveData = `)は名前の直後が `(` でないので当たらない。 */
const SAVER_CALL = /(?<![.\w$])(onSave|onSaveRaw|onSaveLot|onSaveOtherLot|onSaveTasks|saveData|saveLot)\s*\(/g;
/** 包み(中で catch している保存)かどうかを見る時の名前。 */
const WRAPPED_HINT = /catch\s*\(|\.catch\s*\(/;

const shortCode = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 150);

// ============================================================================
// 本体: 与えられたソースを調べる(純関数。selftest はこれを文字列に対して回す)
// ============================================================================
/**
 * @param inputs [{ file, src }]
 * @param opts   { photoCoverKeys:Set, photoSelectKeys:Set, hasSaveOrderModule:boolean, appName:string }
 */
export const analyzeSources = (inputs, opts = {}) => {
  const findings = [];
  const stats = {
    files: inputs.length, chokes: [], saverCalls: 0, wrappedCalls: 0,
    subscriptions: 0, subsWithError: 0, pendingSignals: 0,
  };
  // 🚨 いま配られていないファイル(main.jsx から辿れない・移植途中の版など)の指摘は
  //   **消さずに名指しするが、出荷は止めない**。止めると「直す気の無い休眠コード」で
  //   ゲートが永久に赤くなり、本物の赤が誰にも読まれなくなる。
  const live = opts.liveFiles instanceof Set ? opts.liveFiles : null;
  const isLive = (file) => !live || live.has(file) || file === '(アプリ全体)';
  const add = (id, level, group, file, line, why, code) => {
    const dead = !isLive(file);
    findings.push({
      id, level: dead && level === 'error' ? 'warn' : level, group, file, line,
      why: dead ? `（いま配られていないファイル）${why}` : why,
      code: shortCode(code), dead,
    });
  };

  // 何本かのファイルにまたがる判定(⑥⑧)のための「アプリの実コード」。
  // ⚠ 窓口(src/data/*)は「ns, col, id を受け取って書くだけ」の配管。
  //   ここを画面と一緒に数えると、ロットを1件も書かないアプリ(③司令塔)まで
  //   「ロットを書いている」と誤認する(実測: provider.js の docRef(ns, col, id) に当たった)。
  //   ⚠ いま配られていないファイル(休眠版)も外す。休眠版だけがロットを書いていた場合に
  //     「このアプリは記録を書く」と数えると、⑥⑧が休眠コードのせいで赤くなる。
  const appSrc = inputs
    .filter((f) => !/^src[\\/]data[\\/]/.test(f.file) && isLive(f.file))
    .map((f) => stripComments(f.src)).join('\n');
  /** このアプリは「作業の記録が入るロット」を書くのか。書かないなら ⑥⑧ は対象外。 */
  const writesLotRecords = /(?:\.save|setDoc|addDoc|updateDoc)\s*\([^;]{0,80}['"]lots['"]/.test(appSrc)
    || /saveData\s*\(\s*['"]lots['"]/.test(appSrc);
  // 「順番の関所」の名前は domain/saveOrder.js が決める(名前を変えられても追えるように)。
  const ORDER_GATES = (opts.orderGateNames && opts.orderGateNames.length ? opts.orderGateNames : ['runLotWrite', 'saveInOrder', 'orderWrites']);
  const ORDER_GATE_RE = new RegExp(`(?<![.\\w$])(?:${ORDER_GATES.join('|')})\\s*\\(`);

  for (const input of inputs) {
    const file = input.file;
    const src = stripComments(input.src);
    const index = buildBlocks(src);
    const lineOf = lineOfFactory(src);
    const lines = src.split('\n');
    // 🚨 読めなかったファイルで「0件」と言わない。**黙った合格が一番危ない**
    //   (実測 2026-08-18: 正規表現の中の引用符で括弧の対応がズレ、関所が「見つからない」= 全項目0件になった)
    if (!index.balanced) {
      add('SS-000', 'error', 1, file, 0,
        '🚨 このファイルの括弧の対応が読み取れませんでした。**この見張りの結果は当てになりません**。'
        + 'まず読める形にするか、見張り側の読み取り(skipLiteralAt)を直すこと', '');
    }
    // `const NAME = '文字';` の対応表(入れ物の名前が定数で書いてある時に解く)
    const constMap = new Map();
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2\s*;/g)) constMap.set(m[1], m[3]);

    // ── その書き込みが「写真・図」を書いているか ─────────────────────────
    const imageWriteIn = (text) => {
      const re = new RegExp(WRITE_VERB.source, 'g');
      let m;
      while ((m = re.exec(text))) {
        const open = text.indexOf('(', m.index + m[0].length - 1);
        if (open < 0) continue;
        const { inner } = readParen(text, open);
        // 入れ物の名前は先頭2つの引数にしか出ない(save(ns, col, id, body) / setDoc(doc(db,col,id), body))
        const head = splitArgs(inner).slice(0, 2).join(', ');
        if (IMAGE_LITERAL.test(head)) return head;
        for (const id of head.match(/(?<![\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g) || []) {
          if (/IMAGE|IMG|PHOTO|DIAGRAM|PICTURE/.test(id)) return head;
          const v = constMap.get(id);
          if (v && IMAGE_LITERAL.test(`'${v}'`)) return head;
        }
      }
      return null;
    };

    // ========================================================================
    // ① SS-1 保存の順番 — 写真の受領を待ってから本体を書く形が0件であること
    // ========================================================================
    for (const m of src.matchAll(/(?<![\w$])await\s/g)) {
      const stmt = statementFrom(src, m.index);
      const who = imageWriteIn(stmt);
      if (!who) continue;                                  // 写真を書いていない await は関係ない
      const fns = enclosingFunctions(src, index, m.index, 3);
      const fn = fns[0];
      if (!fn) continue;
      const after = src.slice(m.index + stmt.length, fn.end);
      if (!LOT_BODY_WRITE.test(after)) continue;           // 後ろで本体を書いていないなら順番の問題ではない
      add('SS-101', 'error', 1, file, lineOf(m.index),
        `🚨 写真(${shortCode(who)})の**サーバ受領を待ってから**、同じ関数の後ろでロット本体(作業時間)を書いている。`
        + `通信が詰まっている間に画面を閉じると **本体は待ち行列に一度も入らず消える**(2026-08-17 の事故そのもの)。`
        + `記録を先に待ち行列へ入れ、写真は後ろへ回すこと(domain/saveOrder.js の runLotWrite)`,
        lines[lineOf(m.index) - 1]);
    }

    // ========================================================================
    // ② SS-2 投げっぱなし — onSave( / saveData( に await も catch も無い所
    // ========================================================================
    // 包み(中で catch して画面に出す関数)の中の呼び出しは「catch がある」= 握り潰しではない。
    // ⚠ 包みの有無は **その呼び出しを囲む関数の中だけ** で見る。ファイル全体で見ると、
    //   別の画面(例: 時間の手直しモーダル)の危ない呼び出しまで安全扱いになる。
    const wrapCache = new Map();
    const wrappedBy = (name, idx) => {
      for (const fn of enclosingFunctions(src, index, idx, 8)) {
        const key = `${fn.start}:${name}`;
        if (!wrapCache.has(key)) {
          const body = src.slice(fn.start, fn.end);
          const def = new RegExp(`const\\s+${name}\\s*=\\s*(?:useCallback\\s*\\()?\\s*(?:async\\s*)?\\(`).exec(body);
          wrapCache.set(key, def ? WRAPPED_HINT.test(body.slice(def.index, def.index + 2000)) : false);
        }
        if (wrapCache.get(key)) return true;
      }
      return false;
    };

    for (const m of src.matchAll(SAVER_CALL)) {
      const name = m[1];
      const open = m.index + m[0].length - 1;
      const { inner, end } = readParen(src, open);
      stats.saverCalls++;
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      const afterTxt = src.slice(end + 1, end + 40);
      // 待っている / 投げ返している / 受け止めている → 問題なし
      if (/(?<![\w$])(await|return|yield|typeof|void\s*await)\s*$/.test(before)) continue;
      if (/\.\s*(then|catch|finally)\s*\(/.test(afterTxt)) continue;
      // 式の途中(代入・引数・条件)は、その式を持っている側の責任 → ここでは見ない
      const isConciseArrow = /=>\s*$/.test(before);
      if (!isConciseArrow && /(?:[=([,?:]|&&|\|\||\.\.\.)\s*$/.test(before)) continue;
      if (isConciseArrow && !DOM_HANDLER.test(before)) continue;   // 呼んだ側へ約束を返している(配線)
      const line = lineOf(m.index);
      const stmtBlockEnd = Math.min(src.length, end + 400);
      const closesScreen = CLOSING_CALLS.test(src.slice(end, stmtBlockEnd));
      const record = RECORD_KEYS.test(inner) || /['"]lots['"]/.test(inner) || /['"]lots['"]/.test(src.slice(m.index, end));
      if (wrappedBy(name, m.index)) {
        stats.wrappedCalls++;
        if (closesScreen) {
          add('SS-203', 'error', 2, file, line,
            `🚨 包み(catchあり)の中だが、**この直後に画面を閉じている**のに待っていない。`
            + `閉じた瞬間に手元の記録が消えるので、ここは await すること`, lines[line - 1]);
        }
        continue;
      }
      if (record || closesScreen) {
        add('SS-201', 'error', 2, file, line,
          `🚨 ${name}() を投げっぱなし(await も catch も無い)。`
          + (record ? '**作業の記録を含む保存**なので、失敗しても誰にも届かない。' : '')
          + (closesScreen ? '**直後に画面を閉じている**ので、送れていない分は手元ごと消える。' : ''),
          lines[line - 1]);
      } else {
        add('SS-202', 'warn', 2, file, line,
          `${name}() を投げっぱなし(await も catch も無い)。失敗しても人に届かない`, lines[line - 1]);
      }
    }

    // ========================================================================
    // ③ SS-3 購読の onError — 読み取りが死んでも誰も気づかない所を数えて名指し
    // ========================================================================
    // ⚠ `P.watchCollection(` `DATA(db).watchDoc(` のように **窓口越し** に呼ぶ形が多い。
    //   直前の `.` を除いてしまうと、その購読を1件も数えられない(＝③が丸ごと空振りする)。
    // ⚠⚠ 窓口(src/data/*)そのものは数えない。あそこは
    //   `onErr ? fs.onSnapshot(ref, next, onErr) : fs.onSnapshot(ref, next)` のように
    //   **呼んだ側の onError をそのまま渡すだけ**。ここを欠陥と言うのは嘘になる(実測 ③司令塔で2件)。
    //   見るべきは「呼ぶ側が onError を渡しているか」なので、画面側だけを数える。
    for (const m of /^src[\\/]data[\\/]/.test(file) ? [] : src.matchAll(/(?<![\w$])(watch|watchCollection|watchDoc|onSnapshot)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const { inner } = readParen(src, open);
      const args = splitArgs(inner);
      const first = args[0] || '';
      // ⚠ 画面の大きさを見る `watch(el, set)` のような同名の別物を数えない。
      const isCollection = /^['"][\w-]+['"]$/.test(first) || /^[A-Z][A-Z0-9_]*(COL|COLLECTION|NS)[A-Z0-9_]*$/.test(first)
        || m[1] === 'watchCollection' || m[1] === 'watchDoc' || m[1] === 'onSnapshot';
      if (!isCollection) continue;
      stats.subscriptions++;
      if (/onError|onErr\b|\bcatch\b/.test(inner)) { stats.subsWithError++; continue; }
      const colName = (args.find((a) => /^['"][\w-]+['"]$/.test(a)) || first).replace(/['"]/g, '');
      const line = lineOf(m.index);
      const critical = /^(lots|lot_images|tasks)$/.test(colName);
      // その画面が自分で作った「購読の窓口」(const watch = (col, cb) => P.watchCollection(...))
      // ⚠ ここに onError を通す口が無いと、**呼ぶ側が渡したくても渡せない**。根っこはこちら。
      const isHelperDef = /const\s+[\w$]+\s*=\s*\([^()]*\)\s*=>\s*(?:[\w$]+\.)?$/.test(src.slice(Math.max(0, m.index - 140), m.index));
      if (isHelperDef) {
        add('SS-303', 'warn', 3, file, line,
          `購読の窓口 ${m[1]}(…) に onError を通す口が無い。`
          + `ここが塞がっている限り、呼ぶ側がいくら気をつけても読み取りの死に気づけない`, lines[line - 1]);
        continue;
      }
      add(critical ? 'SS-301' : 'SS-302', critical ? 'error' : 'warn', 3, file, line,
        `${critical ? '🚨 ' : ''}${m[1]}(${colName}) に onError が無い。`
        + `読み取りが 429・権限・回線で止まっても誰も気づかない。`
        + (critical ? '**しかも手元のキャッシュで動き続けるので、空の手元のまま本番を上書きできる**' : ''),
        lines[line - 1]);
    }

    // ========================================================================
    // ④ SS-4 空マップ — {} をそのまま保管庫へ送る道
    //   ⚠ tasks:{} は verify-worktime-guard.mjs(WTG-020/021)の担当。ここでは見ない。
    // ========================================================================
    for (const m of src.matchAll(/(?<![.\w$])(saveData|saveLot)\s*\(\s*(['"][\w-]+['"]|\w+)\s*,\s*[^,]+,\s*\{\s*\}/g)) {
      const line = lineOf(m.index);
      add('SS-401', 'error', 4, file, line,
        `🚨 空のマップ {} をそのまま保存している。setDoc(merge:true) は空マップを渡された項目を **丸ごと空に置き換える**`,
        lines[line - 1]);
    }
    for (const m of src.matchAll(/(?:\.save|setDoc|updateDoc)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const { inner } = readParen(src, open);
      const args = splitArgs(inner);
      const body = args.length >= 4 ? args[3] : (args[1] || '');
      if (!/^\{\s*\}$/.test(body)) continue;
      const line = lineOf(m.index);
      add('SS-402', 'error', 4, file, line,
        `🚨 保管庫へ空のマップ {} を書いている。その doc が既に在れば中身が消える`, lines[line - 1]);
    }
    for (const m of src.matchAll(/(?<![.\w$])(interruptionsMap|measurementResults|stepTimes|stepUnitTimes|packagingPhotos)\s*:\s*\{\s*\}/g)) {
      // 手元の作業用の変数を「本番が消える」と言わない(ロットの doc の中だけを見る)
      const k = innermostBlock(index, m.index);
      const obj = k >= 0 ? src.slice(index.blocks[k].start, index.blocks[k].end + 1) : '';
      if (!LOT_DOC_FIELDS.test(obj)) continue;
      const line = lineOf(m.index);
      add('SS-403', 'error', 4, file, line,
        `🚨 ロットの payload に ${m[1]} の空マップを直書きしている。merge:true でも **サーバ側が丸ごと空になる**。`
        + `空を書くのではなく **鍵ごと送らない** こと`, lines[line - 1]);
    }

    // ========================================================================
    // ⑤ SS-5 「済み」の嘘 — サーバ由来の state を一度だけ作って合わせ直さない所
    // ========================================================================
    for (const m of src.matchAll(/const\s*\[\s*([\w$]+)\s*,\s*(set[\w$]+)\s*\]\s*=\s*useState\s*\(/g)) {
      const [, stateName, setter] = m;
      const open = m.index + m[0].length - 1;
      const { inner } = readParen(src, open);
      const from = /(?<![\w$])(?:lot|_lotProp|initialLot|props\.lot|p\.lot)\s*\.\s*(tasks|interruptions|interruptionsMap|steps|packagingPhotos|measurementResults|stepTimes)(?![\w$])/.exec(inner);
      if (!from) continue;                       // サーバの doc から作った state ではない
      const key = from[1];
      // 同じ画面の中に「サーバと合わせ直す effect」が在るか
      const fns = enclosingFunctions(src, index, m.index, 4);
      const scope = fns.length ? src.slice(fns[fns.length - 1].start, fns[fns.length - 1].end) : src;
      // 🚨🚨 2026-08-30: ここは **偽の緑** を出していた。
      //   前の形は「useEffect( の後ろ 4000字以内に setter( が在る」だけを見ていた。
      //   これは *同じ effect の中* を見ていない。だから
      //     const [x, setXRaw] = useState(lot.stepTimes || {});
      //     const setX = useCallback((v) => { setXRaw(v); }, []);   ← 合わせ直しではない
      //   のように **set の入口を包んだだけ** の形でも、手前に無関係な useEffect が1つ在れば緑になる。
      //   実測(2026-08-30): 作業画面の stepTimes の合わせ直し effect を **丸ごと消しても** ⑤は 0件 のままだった。
      //   → setter の呼び出しが **その useEffect の中身** に在り、かつ
      //     **その同じ effect が lot.<鍵> を材料にしている** 事を確かめる。
      //   ⚠「合わせ直し」とは「サーバの姿を読んで state に入れ直す」事。
      //     材料(lot.<鍵>)と入れ直し(setter)は **同じ effect の中** にしか同居しない。
      //   ⚠ただし「材料」は `lot.<鍵>` を **その場で書いた物** とは限らない。この画面は
      //     react-hooks/exhaustive-deps が確かめられるように、わざと
      //       const serverInts = Array.isArray(lot.interruptions) ? lot.interruptions : null;
      //       useEffect(() => { ...setInterruptions(...) }, [serverInts]);
      //     と **一度変数へ置いてから** 使っている。この形を「材料が無い」と言うと、
      //     ちゃんと合わせ直している所を欠陥と呼ぶ見張りになる(2026-08-23 の逆の失敗)。
      //     → `lot.<鍵>` から作られた変数の名前も「材料」として数える。
      const escRe = (s) => s.replace(/[$]/g, '\\$&');
      const setterRe = new RegExp(`(?<![.\\w$])${escRe(setter)}\\s*\\(`);
      const aliases = new Set();
      const aliasRe = new RegExp(
        `(?:const|let|var)\\s+([\\w$]+)\\s*=[^;\\n]*?(?<![\\w$])(?:lot|_lotProp|initialLot|props\\.lot|p\\.lot)\\s*\\.\\s*${key}(?![\\w$])`, 'g');
      let am;
      while ((am = aliasRe.exec(scope))) aliases.add(am[1]);
      const materialRe = new RegExp(
        `\\.\\s*${key}(?![\\w$])` + (aliases.size ? `|(?<![.\\w$])(?:${[...aliases].map(escRe).join('|')})(?![\\w$])` : ''));
      let hasResync = false;
      const effRe = /(?<![.\w$])useEffect\s*\(/g;
      let em;
      while ((em = effRe.exec(scope))) {
        // ⚠readParen は引数を丸ごと返す = **依存配列も含む**。deps だけに材料が在る形も拾える。
        const { inner: body } = readParen(scope, em.index + em[0].length - 1);
        if (setterRe.test(body) && materialRe.test(body)) { hasResync = true; break; }
      }
      if (hasResync) continue;
      const line = lineOf(m.index);
      add('SS-501', 'error', 5, file, line,
        `🚨 ${stateName} は lot.${key} から **一度だけ** 作られ、以後サーバと合わせ直していない。`
        + `保存が1件も届いていなくても画面はずっと「済み」に見える(2026-08-17 の事故を見えなくした形)。`
        + `${setter} を呼ぶ useEffect(lot.${key} を材料に)を置くこと`, lines[line - 1]);
    }

    // ========================================================================
    // ⑦ SS-7 1MBに載る写真 — 別置きの対象外の写真
    // ========================================================================
    // (a) 別置きを通らない棚(lots 以外)へ base64 の写真を入れている所。
    //     ⚠ 配線(`onSaveXxx={(id,data) => saveData('xxx', id, data)}`)を先に読んで、
    //       どの呼び出しがどの棚へ行くのかを解く。
    const wires = new Map();
    for (const m of src.matchAll(/([\w$]+)\s*=\s*\{\s*(?:async\s*)?\([^()]*\)\s*=>\s*saveData\s*\(\s*['"]([\w-]+)['"]/g)) {
      if (/^(onSave|onSaveRaw|onSaveLot|onSaveOtherLot)$/.test(m[1])) continue;  // 名前が一般的すぎる物は使わない
      wires.set(m[1], m[2]);
    }
    const photoWriteCheck = (callName, col, idx, argText) => {
      if (col === 'lots') return;                       // lots は saveData が別置きする
      // ⚠ 写真の置き場そのもの(lot_images / help_images / step_diagrams)は **1件1枚が設計**。
      //   ここを「別置きされていない写真」と言うと、別置きの正しい行き先を欠陥と呼ぶことになる。
      if (IMAGE_LITERAL.test(`'${col}'`)) return;
      const re = new RegExp(PHOTO_KEY.source, 'gi');
      let hit = null, mm;
      while ((mm = re.exec(argText))) { if (!PHOTO_KEY_DENY.test(mm[1])) { hit = mm; break; } }
      if (!hit) return;
      const line = lineOf(idx);
      add('SS-701', 'error', 7, file, line,
        `🚨 ${callName}() は棚「${col}」へ写真(${hit[1]})を **そのまま(base64で)** 入れている。`
        + `別置き(dehydrate)は lots だけなので、この doc は 1MB 上限に直接ぶつかる`, lines[line - 1]);
    };
    for (const [propName, col] of wires) {
      for (const m of src.matchAll(new RegExp(`(?<![.\\w$])${propName}\\s*\\(`, 'g'))) {
        const open = m.index + m[0].length - 1;
        const { inner } = readParen(src, open);
        if (/=>/.test(inner.slice(0, 40))) continue;   // 配線そのもの
        photoWriteCheck(propName, col, m.index, inner);
      }
    }
    for (const m of src.matchAll(/(?<![.\w$])saveData\s*\(\s*['"]([\w-]+)['"]\s*,/g)) {
      const open = src.indexOf('(', m.index);
      const { inner } = readParen(src, open);
      photoWriteCheck('saveData', m[1], m.index, splitArgs(inner).slice(2).join(','));
    }
    // (b) ロットの payload に、別置きが知らない写真の鍵が生えていないか
    if (opts.photoCoverKeys && opts.photoCoverKeys.size) {
      for (const m of src.matchAll(new RegExp(PHOTO_KEY.source, 'gi'))) {
        const key = m[1];
        if (opts.photoCoverKeys.has(key) || PHOTO_KEY_DENY.test(key)) continue;
        const k = innermostBlock(index, m.index);
        const obj = k >= 0 ? src.slice(index.blocks[k].start, index.blocks[k].end + 1) : '';
        if (!LOT_DOC_FIELDS.test(obj)) continue;                 // ロットの doc ではない
        if (!/saveData|onSave|\.save\s*\(/.test(src.slice(Math.max(0, index.blocks[k].start - 200), index.blocks[k].start))) continue;
        const line = lineOf(m.index);
        add('SS-702', 'error', 7, file, line,
          `🚨 ロットの保存に写真の鍵「${key}」が入っているが、別置きの一覧(collectPhotoSlots)が **この鍵を知らない**。`
          + `この写真は本体に載ったままになり、1MB を食う`, lines[line - 1]);
      }
    }
  }

  // ========================================================================
  // ⑥ SS-6 未送信の見せ方(ファイルをまたいで1回だけ判定)
  // ========================================================================
  stats.writesLotRecords = writesLotRecords;
  if (writesLotRecords) {
    const hasPending = /hasPendingWrites/.test(appSrc);
    const hasMeta = /includeMetadataChanges/.test(appSrc);
    stats.pendingSignals = (hasPending ? 1 : 0) + (hasMeta ? 1 : 0) + (/waitForPendingWrites/.test(appSrc) ? 1 : 0);
    if (!hasPending) {
      add('SS-601', 'error', 6, '(アプリ全体)', 0,
        '🚨 hasPendingWrites の使用が **0件**。「サーバに届いたか」を人が確かめる手段が1つも無い。'
        + '2026-08-17 の事故が誰にも見えなかった土台の欠陥がこれ', '');
    } else {
      if (!hasMeta) {
        add('SS-602', 'error', 6, '(アプリ全体)', 0,
          '🚨 hasPendingWrites を見ているのに includeMetadataChanges を渡していない。'
          + '**届いた合図が来ないので ⏳ が一生消えない**(実測: [true] のまま貼り付く)', '');
      }
      // 「人に見せている」の見分け方は3通り。1つでも当たれば見せている。
      //   ⚠ 近くに set…( が在るかだけで見ると、いったん数える関数(countPendingDocs)に
      //     包んでから画面へ渡している形(製品検査)を「見せていない」と嘘をつく。
      const nearSetter = /hasPendingWrites[\s\S]{0,200}?set[A-Z][\w$]*\s*\(|set[A-Z][\w$]*\s*\([^;]{0,200}hasPendingWrites/.test(appSrc);
      const viaHelper = (() => {
        for (const m of appSrc.matchAll(/const\s+([\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{[\s\S]{0,600}?hasPendingWrites/g)) {
          if (new RegExp(`set[A-Z][\\w$]*\\s*\\([^;]{0,120}(?<![.\\w$])${m[1]}\\s*\\(`).test(appSrc)) return true;
        }
        return false;
      })();
      // 画面に出す言葉そのもの(domain/saveOrder.js の札)を使っているか
      const viaLabel = /pendingWriteCount|pendingLabel|SAVED_LABEL|UNLOAD_WARNING/.test(appSrc);
      if (!nearSetter && !viaHelper && !viaLabel) {
        add('SS-603', 'error', 6, '(アプリ全体)', 0,
          '🚨 hasPendingWrites を読んでいるが、**人に見せていない**(state にも札にも渡っていない)。'
          + '見えない見張りは無いのと同じ', '');
      }
    }
  }

  // ========================================================================
  // ⑧ SS-8 関所 — ロット本体を書く所が「順番の関所」を通っているか
  //   ⚠ 空マップ・記録の消失は verify-worktime-guard.mjs の担当。ここは **順番** だけ。
  // ========================================================================
  for (const input of inputs) {
    if (!writesLotRecords) break;               // ロットを書かないアプリ(③司令塔)は対象外
    const file = input.file;
    const src = stripComments(input.src);
    const index = buildBlocks(src);
    const lineOf = lineOfFactory(src);
    const lines = src.split('\n');
    for (const m of src.matchAll(/const\s+(saveData|saveLot|saveDoc)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      const k = index.byStart.has(open) ? index.byStart.get(open) : -1;
      if (k < 0) continue;
      const body = src.slice(index.blocks[k].start, index.blocks[k].end + 1);
      // ロットを扱う関所だけ。⚠ 部品検査のように **入れ物の名前を変数のまま** 書く関所も在る
      //   (`await DATA(db).save(NS, col, id, ...)`)。'lots' の直書きだけで探すと
      //   「関所が見つからない」＝ ⑧が丸ごと空振りする。
      const genericSaver = /(?:\.save|setDoc)\s*\([^;]{0,60}(?<![.\w$])col(?![\w$])/.test(body);
      if (!/['"]lots['"]/.test(body) && !(genericSaver && writesLotRecords)) continue;
      const guarded = ORDER_GATE_RE.test(body);
      stats.chokes.push({ file, name: m[1], line: lineOf(m.index), guarded });
      if (!guarded) {
        add('SS-802', 'error', 8, file, lineOf(m.index),
          `🚨 ${m[1]}() が **順番の関所(${ORDER_GATES.join(' / ')})を通っていない**。`
          + `記録を先に・写真を後に、間に await を挟まず待ち行列へ入れる仕掛けが無い`, lines[lineOf(m.index) - 1]);
      }
    }
    // 関所の外でロット本体を書いている所(=関所ごと迂回している)
    const chokeRanges = [];
    for (const m of src.matchAll(/const\s+(saveData|saveLot|saveDoc)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      const k = index.byStart.has(open) ? index.byStart.get(open) : -1;
      if (k >= 0) chokeRanges.push(index.blocks[k]);
    }
    for (const m of src.matchAll(/(?:\.save|setDoc)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const { inner } = readParen(src, open);
      const args = splitArgs(inner);
      const col = args[1] || '';
      const body = args[3] || '';
      if (!/^['"]lots['"]$/.test(col)) continue;
      if (!RECORD_KEYS.test(body) && !/\btasks\b/.test(body)) continue;
      if (chokeRanges.some((r) => m.index >= r.start && m.index <= r.end)) continue;
      if (/runLotWrite/.test(src.slice(Math.max(0, m.index - 300), m.index))) continue;
      add('SS-803', 'error', 8, file, lineOf(m.index),
        `🚨 関所(saveData)を通さずに、作業の記録を含むロットを直接書いている。順番の関所も容量の見積りも効かない`,
        lines[lineOf(m.index) - 1]);
    }
  }
  if (!stats.chokes.length && writesLotRecords) {
    add('SS-801', 'error', 8, '(アプリ全体)', 0,
      '🚨 ロット保存の関所(saveData)が見つからないのに、ロット本体を書く所が在る。この見張りが当てにならない形になっている', '');
  }
  if (opts.hasSaveOrderModule === false && writesLotRecords) {
    add('SS-804', 'error', 8, '(アプリ全体)', 0,
      '🚨 src/domain/saveOrder.js(順番の関所と、その試験)が無い。'
      + '判定と実行を画面の中に書くと、次に触った人が黙って順番を戻せる', '');
  }
  if (opts.photoSelectKeys && opts.photoCoverKeys) {
    const missing = [...opts.photoCoverKeys].filter((k) => !opts.photoSelectKeys.has(k));
    if (missing.length) {
      add('SS-703', 'warn', 7, '(アプリ全体)', 0,
        `⚠ 写真を **動かす側**(collectPhotoSlots)は ${[...opts.photoCoverKeys].join('/')} を見るのに、`
        + `**選ぶ側**(planAutoOffload/inlineImagesOf)は ${missing.join('/')} を数えない。`
        + `「移せる物が無い」と判断して、写真しか抱えていないロットが一生別置きされない`, '');
    }
  }

  findings.sort((a, b) => (a.group - b.group) || String(a.file).localeCompare(String(b.file)) || (a.line - b.line));
  return { findings, stats };
};

// ============================================================================
// ファイルを集める
// ============================================================================
const SKIP_DIR = /(^|[\\/])(node_modules|__tests__|assets|dist|\.git)([\\/]|$)/;
export const listSources = (root) => {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (SKIP_DIR.test(p)) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(e.name)) continue;
      if (/\.test\.(js|mjs|jsx)$/.test(e.name)) continue;
      // domain は保管庫に触らない純関数の棚。ここを混ぜると `{}` だらけで本物が埋もれる。
      if (/[\\/]src[\\/]domain[\\/]/.test(p)) continue;
      out.push(p);
    }
  };
  walk(path.join(root, 'src'));
  return out.sort();
};

/**
 * src/main.jsx から実際に辿れるファイル(＝いま配られている物)を集める。
 * ⚠ 最終検査には PocketBase 版の src/App.jsx が **コメントアウトされたまま** 残っている。
 *   これを現用と同列に赤くすると、ゲートが休眠コードで永久に赤くなる。
 */
export const liveFilesOf = (root) => {
  const start = ['src/main.jsx', 'src/main.js'].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  if (!start) return null;                       // 入口が分からない時は全部を現用扱い(安全側)
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src = '';
    try { src = stripComments(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      for (const cand of [base, base + '.js', base + '.jsx', path.join(base, 'index.js'), path.join(base, 'index.jsx')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { stack.push(cand); break; }
      }
    }
  }
  return seen;
};

/** 写真の別置きが「知っている鍵」を、実コードから読み取る。 */
export const photoKeysOf = (root) => {
  const cover = new Set(), select = new Set();
  const readFn = (file, fnName) => {
    let src = '';
    try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch { return ''; }
    const i = src.indexOf(fnName);
    if (i < 0) return '';
    const open = src.indexOf('{', i);
    if (open < 0) return '';
    const { blocks, byStart } = buildBlocks(src);
    const k = byStart.has(open) ? byStart.get(open) : -1;
    return k >= 0 ? src.slice(blocks[k].start, blocks[k].end + 1) : '';
  };
  const eat = (body, set) => {
    for (const m of body.matchAll(/\bobj\s*\.\s*([\w$]+)|\blot\s*\.\s*([\w$]+)|\[\s*'([\w$]+)'/g)) {
      const k = m[1] || m[2] || m[3];
      if (k && /photo|image|task|interruption/i.test(k)) set.add(k);
    }
  };
  eat(readFn(path.join(root, 'src', 'domain', 'saveOrder.js'), 'collectPhotoSlots'), cover);
  eat(readFn(path.join(root, 'src', 'domain', 'lotCapacity.js'), 'inlineImagesOf'), select);
  return { cover, select };
};

// ============================================================================
// 出す
// ============================================================================
const GROUP_TITLE = {
  1: '① 保存の順番(写真の受領を待ってから本体を書いていないか)',
  2: '② 投げっぱなし(await も catch も無い保存)',
  3: '③ 購読の onError(読み取りが死んでも気づけない所)',
  4: '④ 空マップ({} をそのまま送る道)',
  5: '⑤「済み」の嘘(合わせ直さない画面の state)',
  6: '⑥ 未送信の見せ方(hasPendingWrites を人に見せているか)',
  7: '⑦ 1MBに載る写真(別置きの対象外)',
  8: '⑧ 関所(順番の関所を通っているか)',
};

export const runOnRoot = (root) => {
  const files = listSources(root);
  const inputs = files.map((f) => ({ file: path.relative(root, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }));
  const { cover, select } = photoKeysOf(root);
  const orderFile = path.join(root, 'src', 'domain', 'saveOrder.js');
  const hasSaveOrderModule = fs.existsSync(orderFile);
  // 「順番の関所」の名前は決め打ちにしない。domain/saveOrder.js が出している名前を読む。
  let orderGateNames = [];
  if (hasSaveOrderModule) {
    const s = fs.readFileSync(orderFile, 'utf8');
    orderGateNames = [...s.matchAll(/export\s+const\s+([\w$]+)\s*=/g)].map((m) => m[1])
      .filter((n) => /^(runLotWrite|saveInOrder|orderWrites)$/.test(n));
  }
  return analyzeSources(inputs, {
    photoCoverKeys: cover, photoSelectKeys: select, hasSaveOrderModule, orderGateNames,
    liveFiles: liveFilesOf(root), appName: path.basename(root),
  });
};

const main = async (args) => {
  const root = path.resolve(process.env.APP_ROOT || args.find((a) => a.startsWith('--root='))?.slice(7) || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

  if (args.includes('--selftest')) {
    const { selftest } = await import('./selftest-save-safety.mjs');
    return selftest() ? 0 : 1;
  }
  // ⚠ 壊れた物差しで測って「合格」と言わないため、まず見張り自身を試験する。
  if (String(process.env.SAVE_SAFETY_NO_SELFTEST || '') !== '1') {
    try {
      const { selftest } = await import('./selftest-save-safety.mjs');
      if (!selftest({ quiet: true })) {
        console.error('❌ 見張り自身が壊れているので、実コードの判定はしません(node scripts/selftest-save-safety.mjs で中身が見えます)');
        return 1;
      }
    } catch (e) {
      console.error('❌ 見張り自身の試験が読み込めません:', e.message);
      return 1;
    }
  }

  if (!fs.existsSync(path.join(root, 'src'))) {
    console.error(`❌ src が無い: ${root}`);
    return 1;
  }
  const { findings, stats } = runOnRoot(root);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ root, stats, findings }, null, 2));
    return findings.some((f) => f.level === 'error') ? 1 : 0;
  }

  const app = path.basename(root);
  console.log(`\n🚨 保存の安全 見張り  ${app}`);
  console.log(`   ${root}`);
  console.log(`   見たファイル ${stats.files}本 / ロット保存の関所 ${stats.chokes.length}個 / 保存の呼び出し ${stats.saverCalls}件`
    + `(包み済み ${stats.wrappedCalls}件) / 購読 ${stats.subscriptions}件(onError付き ${stats.subsWithError}件)`);
  console.log(stats.writesLotRecords
    ? '   このアプリは作業の記録(ロット)を書きます → ⑥⑧も見ます'
    : '   このアプリは作業の記録(ロット)を書きません → ⑥⑧は対象外(黙って合格にせず、ここに書いています)');
  stats.chokes.forEach((c) => console.log(`   関所 ${c.name}() ${c.file}:${c.line} … ${c.guarded ? '✅ 順番の関所(runLotWrite)を通っている' : '❌ 通っていない'}`));
  console.log('');

  // 同じ指摘を1件ずつ理由付きで並べると読めなくなる(実測 57件)。
  // → 理由は種類ごとに1回、場所は1行ずつ。**件数は1件も省かない**。
  let errors = 0, warns = 0, dead = 0;
  const CAP = Number(process.env.SAVE_SAFETY_MAX_LINES || 60);
  for (const g of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const list = findings.filter((f) => f.group === g);
    const e = list.filter((f) => f.level === 'error').length;
    const w = list.filter((f) => f.level === 'warn').length;
    errors += e; warns += w; dead += list.filter((f) => f.dead).length;
    const head = g === 6 || g === 8
      ? (stats.writesLotRecords ? '' : '（対象外: このアプリは作業の記録を書きません）')
      : '';
    console.log(`${e ? '❌' : (w ? '⚠' : '✅')} ${GROUP_TITLE[g]} … ${e ? `危ない所 ${e}件` : '0件'}${w ? ` / 名指し ${w}件` : ''} ${head}`);
    // ⚠ 種類(ID)だけでまとめない。**重さ(❌/⚠)が違う物を1つの見出しに混ぜると件数が合わなくなる**
    //   (休眠ファイルの分は ⚠ に落としてあるため)。理由が1通りでない時は1件ずつ理由を書く。
    const byId = new Map();
    for (const f of list) { const k = `${f.id}|${f.level}`; if (!byId.has(k)) byId.set(k, []); byId.get(k).push(f); }
    for (const [, fs2] of byId) {
      const lv = fs2[0].level === 'error' ? '❌' : '⚠';
      const whys = [...new Set(fs2.map((f) => f.why))];
      if (whys.length === 1) {
        console.log(`   ${lv} [${fs2[0].id}] ${fs2.length}件 — ${whys[0]}`);
        fs2.slice(0, CAP).forEach((f) => console.log(`      ・${f.file}:${f.line}  ${f.code}`));
      } else {
        console.log(`   ${lv} [${fs2[0].id}] ${fs2.length}件（理由は ${whys.length}通り）`);
        fs2.slice(0, CAP).forEach((f) => {
          console.log(`      ・${f.file}:${f.line}  ${f.why}`);
          if (f.code) console.log(`         ${f.code}`);
        });
      }
      if (fs2.length > CAP) console.log(`      …他 ${fs2.length - CAP}件（SAVE_SAFETY_MAX_LINES=999 で全部出ます）`);
    }
    if (list.length) console.log('');
  }

  console.log(`\n合計: ❌ ${errors}件 / ⚠ ${warns}件（うち「いま配られていないファイル」${dead}件）   (${app})`);
  console.log('※ 中身が消える保存(tasks:{}・関所の迂回)は verify-worktime-guard.mjs の担当。ここは順番・投げっぱなし・見えない事を見ています。');
  if (String(process.env.SAVE_SAFETY_LIST_ONLY || '') === '1') {
    console.log('（SAVE_SAFETY_LIST_ONLY=1 のため、指摘があっても止めません）');
    return 0;
  }
  return errors ? 1 : 0;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) main(process.argv.slice(2)).then((code) => process.exit(code));
