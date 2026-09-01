#!/usr/bin/env node
// ============================================================================
// 🗑️ 「消したのに戻ってくる」を二度と入れない見張り — 消す印(__deleteMapKeys)
// ----------------------------------------------------------------------------
// 【何が起きたか】2026-09-01 清水さんの申し出:
//   「既にある『休み／他』の登録で、ボタン連打しても休みとか他が戻ってこないから、
//     ミスしても直せないよ」
//   作業者ロスターは 出勤→休み→他工場→出勤 と回る作りだが、
//   **「出勤に戻す」だけは「キーを消す」で表していた**。
//   このアプリの保存は merge:true なので **送らなかったキーは消えない**。
//   消す印(__deleteMapKeys)を明示していなかったので保存が素通りし、
//   他工場のまま焼き付いて二度と戻せなかった。
//   ⚠ 1人だけ登録が有る日は「地図まるごと1個」を送るので偶然消えていた。
//     **現場のように何人も登録が有る日ほど必ず踏む**形だったので、
//     1人で試すと直って見え、気づきにくかった。
//
// 【この見張りが数える物】
//   DM-1 (赤) 保存へ渡す物を作る流れの中で「キーを消して」いるのに、
//             その保存の引数に **消す印が届いていない**。
//             ・delete X[k] / delete X.k
//             ・X[k] = undefined
//   DM-2 (赤) 見張り自身が実コードを **0バイト**しか読んでいない
//             (2026-08-30「緑なのに何も守っていない見張り」5件と同じ形)
//   DM-3 (赤) 消す所と保存する所が **別の場所**にあり、印がどこにも無い
//             (画面の state に消した地図を入れ、保存は別の関数、という形)
//
// 【関数の境目をまたいで追う】2026-08-30 に「関所が別関数に任せていると
//   検査対象から外れる」で素通りした前科があるので、
//   ・消す所 … その関数から呼んでいる **この製品の中の関数** の中まで追う(深さ2)
//   ・印    … 保存の引数に渡した変数・引数の中で呼んでいる関数の戻り値も追う(深さ2)
//   両方向に追う。片方だけ追うと「消すのを別関数へ移す」で素通りする。
//
// 【わざと外す形は全部 赤にする】(--selftest で毎回機械が確かめる)
//   ・印を外す ・別の設定で印なしの delete ・印を文字列の中に書く
//   ・印をコメントに書く ・印を if の枝の中だけに置く(保存に届かない)
//   ・印を別の変数名にする ・delete を別関数へ移して呼ぶ
//   ・X[k] = undefined で消す
//   さらに **正しい形が緑のまま** である事も同じ試験で確かめる。
//
// 【重ねない】2026-08-17 の教訓。重ねると「直す所」が水増しされて本物が埋もれる。
//   ・verify-worktime-guard.mjs … 中身が **丸ごと** 消える保存(tasks:{} など)
//   ・verify-save-safety.mjs    … 順番・投げっぱなし・見えない事
//   ・この見張り                … **名指しで消した1つのキーが消えない**事だけ
//   だから `x = {}`(丸ごと空にする)は見ない。SS-4/WTG-020 の担当。
//   だから `x = ''`(空文字)も見ない。**空文字は本物の値**で、merge はちゃんと保存する。
//   消す印が要るのは「キーそのものが無くなる」時だけ。
//
// 【誤検出しない為に、わざと見ない事】⚠ 隠さず書く。ここが見張りの弱い所。
//   ① 大きすぎる入れ物(2万文字超)は「1つの流れ」と数えない。App 全体を1つの流れにすると
//      5000行離れた画面の消し方まで拾って誤検出になる(実測 46件)。
//   ② setXxx / useXxx の中は追わない。画面の中身であって保管庫ではない。
//   ③ 保存へ **丸ごと** 渡す入れ物からキーを落とす所は数えない。それは「送らない」の意味で、
//      merge:true では正しい。印を付けたら逆に本番のデータが消える(製品 App.jsx の復元がこの形)。
//   ④ 消した後に入れ物を作り直している / 途中で return して抜けている道は数えない。
//   ⑤ `x = {}`(丸ごと空)と `x = ''`(空文字)は見ない。担当が別(重ねない)。
//   → ①〜④で見逃した形は DM-3(消す所と保存する所が別)が別の目で拾う。
//
// 【言い訳(allow)の帳面】scripts/delete-mark-allow.json (無ければ言い訳ゼロ)
//   🚨 言い訳を置ける仕組みは、放っておくと「本物を黙らせる道具」になる。だから
//     ・理由(reason)が空なら **赤**
//     ・1件も当たらない言い訳(古くなった言い訳)が残っていたら **赤**
//     ・当たった所は毎回、理由ごと画面に出す(数だけにしない)
//   ⚠ アプリごとに中身が違うので、この .mjs 本体だけを4アプリで同じ物にする。
//
// 【使い方】
//   node scripts/verify-delete-mark.mjs            … 自己試験 → このリポを見る
//   node scripts/verify-delete-mark.mjs --selftest … 見張り自身の試験だけ
//   node scripts/verify-delete-mark.mjs --list     … 通した所の根拠だけ出す
//   APP_ROOT=<道> node scripts/verify-delete-mark.mjs … 別のアプリを見る
//   環境変数 DELETE_MARK_NO_SELFTEST=1 … 自己試験を飛ばす(自己試験の中から呼ぶ時だけ)
//
// 🚨 通した所は **黙って通さない**。行番号と中身を必ず印字する。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARK = '__deleteMapKeys';

// 保存の窓口の名前。ここに無い名前で保存していると、この見張りは何も見ない。
// ⚠ 名前を足す時は「本当に保管庫へ書く物」だけ。画面の state を書く物は入れない。
export const SAVE_NAMES = [
  'saveSettings', 'saveSettingsConfig', 'saveData', 'saveLot', 'saveMapConfig',
  'saveTemplate', 'deleteSettingsFields', 'persistPhotos',
  'onSave', 'onSaveLayouts', 'setDoc', 'updateDoc', 'save',
];

// 括弧を数える時に「関数の入れ物」ではない `(`。ここを間違えると if の中を関数と誤解する。
const NOT_FN_HEAD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return']);

// ---------------------------------------------------------------------------
// ① 文字列・コメント・正規表現を空白へ潰す(長さと改行はそのまま)
// ---------------------------------------------------------------------------
// 🚨 ここを甘くすると「印を文字列の中に書く」「印をコメントに書く」が素通りする。
//   長さを変えないので、潰した後の位置から元の行番号がそのまま出せる。
// ⚠ 素の文字列は行をまたがない。閉じ忘れても行末で打ち切る(誤解の連鎖を止める堤防)。
const REGEX_OK_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '+', '\n']);
// 🚨 この言葉の直後の `/` は必ず正規表現(割り算ではない)。
//   実測 2026-09-02: これを入れずに走らせたら、製品の
//     `return /[",\r\n]/.test(s) ? ...`
//   の `"` を **文字列の始まり**と誤解し、そこから括弧の対応が丸ごと崩れた。
//   → DM-000(このファイルを読めていません)で赤になった。**黙って0件と言わずに済んだ形**。
const REGEX_OK_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof']);

export const maskSource = (src) => {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let j = from; j < to && j < n; j++) if (out[j] !== '\n') out[j] = ' '; };
  let i = 0;
  let prev = '\n';      // 直前の「意味のある」1文字
  let prev2 = '';       // その1つ前(`=>` を見るため)
  let prevIdx = -1;     // その位置(直前の「言葉」を読み直す為)
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      blank(i, j); prev2 = prev; prev = 'x'; prevIdx = -1; i = j; continue;
    }
    if (c === '`') {
      // テンプレート。`${ }` の中は普通のコードなので潰さない。
      let j = i + 1; blank(i, i + 1);
      while (j < n) {
        if (src[j] === '\\') { blank(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { blank(j, j + 1); j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 0, k = j + 1;
          for (; k < n; k++) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') { depth--; if (depth === 0) break; }
          }
          j = k + 1; continue;                       // 中は潰さない
        }
        blank(j, j + 1); j++;
      }
      prev2 = prev; prev = 'x'; prevIdx = -1; i = j; continue;
    }
    if (c === '/') {
      // 正規表現か割り算か。🚨 JSX があるので `<` `>` `{` `}` は正規表現の合図に入れない。
      //   実測(2026-08-18・保存の安全の見張り): `>` を入れたら `</b>` の `/` を
      //   正規表現の始まりと誤解し、括弧の対応が丸ごと崩れた。
      let isRe = REGEX_OK_PREV.has(prev) || (prev === '>' && prev2 === '=');
      if (!isRe && prevIdx >= 0 && /[\w$]/.test(prev)) {
        let w = prevIdx; while (w >= 0 && /[\w$]/.test(out[w])) w--;
        isRe = REGEX_OK_WORD.has(out.slice(w + 1, prevIdx + 1).join(''));
      }
      if (isRe) {
        let j = i + 1, inClass = false, closed = false;
        for (; j < n; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '\n') break;
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
        }
        if (closed) { blank(i, j); prev2 = prev; prev = 'x'; prevIdx = -1; i = j; continue; }
      }
    }
    if (!/\s/.test(c)) { prev2 = prev; prev = c; prevIdx = i; } else if (c === '\n') { prev2 = prev; prev = '\n'; prevIdx = -1; }
    i++;
  }
  return out.join('');
};

// ---------------------------------------------------------------------------
// ② 括弧を数えて「関数の入れ物」を割り出す
// ---------------------------------------------------------------------------
const backSkipWs = (m, i) => { let j = i; while (j >= 0 && /\s/.test(m[j])) j--; return j; };
const backIdent = (m, i) => {
  let j = i; while (j >= 0 && /[\w$]/.test(m[j])) j--;
  return { word: m.slice(j + 1, i + 1), at: j };
};

/** @returns {{ blocks: Array<{open:number,close:number,isFn:boolean,name:string}>, parenOpenOf: Map<number,number>, parenCloseOf: Map<number,number>, balanced: boolean }} */
export const scanBlocks = (m) => {
  const parenOpenOf = new Map();   // ) の位置 → ( の位置
  const parenCloseOf = new Map();  // ( の位置 → ) の位置
  const pstack = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '(') pstack.push(i);
    else if (m[i] === ')') { const o = pstack.pop(); if (o != null) { parenOpenOf.set(i, o); parenCloseOf.set(o, i); } }
  }
  const blocks = [];
  const bstack = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '{') bstack.push(i);
    else if (m[i] === '}') {
      const o = bstack.pop();
      if (o == null) continue;
      let isFn = false;
      const p = backSkipWs(m, o - 1);
      if (p >= 1 && m[p] === '>' && m[p - 1] === '=') isFn = true;            // (a) => {
      else if (p >= 0 && m[p] === ')') {
        const po = parenOpenOf.get(p);
        if (po != null) {
          const q = backSkipWs(m, po - 1);
          const { word } = backIdent(m, q);
          if (!NOT_FN_HEAD.has(word)) isFn = true;                            // function f(){ / f(){ / method(){
        }
      }
      blocks.push({ open: o, close: i, isFn, name: isFn ? nameOfFnBlock(m, o) : '' });
    }
  }
  blocks.sort((a, b) => a.open - b.open);
  return { blocks, parenOpenOf, parenCloseOf, balanced: bstack.length === 0 && pstack.length === 0 };
};

/** 関数の入れ物の名前を、直前200文字から拾う(見つからなければ空)。 */
const nameOfFnBlock = (m, open) => {
  const head = m.slice(Math.max(0, open - 220), open);
  const re = /function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*(?::|\()/g;
  let last = '', mm;
  while ((mm = re.exec(head))) last = mm[1] || mm[2] || mm[3] || last;
  return last;
};

/** 位置 k を包む一番内側の「関数の入れ物」。無ければ null。 */
export const enclosingFn = (blocks, k) => {
  let best = null;
  for (const b of blocks) {
    if (!b.isFn) continue;
    if (b.open < k && k < b.close) { if (!best || b.open > best.open) best = b; }
  }
  return best;
};

// ---------------------------------------------------------------------------
// ③ 消している所・印・保存の呼び出しを拾う
// ---------------------------------------------------------------------------
const RE_DELETE = /\bdelete\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\?\.\s*[A-Za-z_$][\w$]*)*)\s*(\[|\.)/g;
const RE_UNDEF = /([A-Za-z_$][\w$]*)\s*(?:\[[^\]\n]*\]|\.\s*[A-Za-z_$][\w$]*)\s*=\s*undefined\b/g;
// 印は2通りある。どちらも「名指しで消す」正しい書き方。
//   ① __deleteMapKeys … 窓口(provider)が消す印へ変換する
//   ② DATA_DELETE      … 番兵をその場に置く(src/data/sentinels.js)
//   ③ deleteField()    … Firestore 直の書き方(古い所に残っている)
const RE_MARK = new RegExp(`(?:${MARK}|DATA_DELETE|deleteField\\s*\\()(?![\\w$])`, 'g');

const findAll = (re, m, from, to) => {
  const out = [];
  // 🚨 端から端まで走らせない。範囲の頭から始める(実測: 0から始めると App.jsx で2分以上かかった)。
  re.lastIndex = Math.max(0, from);
  let mm;
  while ((mm = re.exec(m))) {
    if (mm.index >= from && mm.index < to) out.push({ at: mm.index, text: mm[0], g1: mm[1] });
    if (mm.index >= to) break;
  }
  return out;
};

const hasMarkIn = (m, from, to) => findAll(RE_MARK, m, from, to).length > 0;

/** 消している所(1つの範囲の中だけ)。 */
export const deletionsIn = (m, from, to) => [
  ...findAll(RE_DELETE, m, from, to).map((d) => ({ at: d.at, kind: 'delete', target: d.g1 })),
  ...findAll(RE_UNDEF, m, from, to).map((d) => ({ at: d.at, kind: 'undefined', target: d.g1 })),
].sort((a, b) => a.at - b.at);

// 🚨 同じ範囲を何度も舐めない。実測(2026-09-02): 覚えさせる前は製品の App.jsx で
//   2分を超えても終わらなかった(保存の呼び出しが330件・1件ごとに同じ大きな関数を舐め直していた)。
//   覚えさせても **判定は1文字も変わらない**(同じ入力に同じ答えを返すだけ)。
const _memo = new Map();
const memo = (key, f) => { if (_memo.has(key)) return _memo.get(key); const v = f(); _memo.set(key, v); return v; };

/** 範囲の中で呼んでいる名前(この製品の中の関数を追う為)。 */
const calledNamesIn = (m, from, to) => {
  const re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  const out = new Set();
  re.lastIndex = from;
  let mm;
  while ((mm = re.exec(m)) && mm.index < to) {
    const w = mm[1];
    if (!NOT_FN_HEAD.has(w) && w !== 'function' && w !== 'typeof') out.add(w);
  }
  return out;
};

// ---------------------------------------------------------------------------
// ③-2 「その保存に本当に載る物」だけに絞る(逆向きにたどる)
// ---------------------------------------------------------------------------
// 🚨🚨 ここが無いと **誤検出だらけになり、いずれ誰にも読まれない見張り**になる。
//   実測 2026-09-02: 絞る前は製品で 46件の赤。中身を見たら、そのほとんどが
//     setBatchStartTimes(prev => { const c = {...prev}; delete c[sIdx]; return c; })
//   のような **画面の中だけの消し方**だった(保管庫へは1バイトも行かない)。
//   同じ関数の中に居るだけで「この保存が消している」と数えていた。
//
// やる事: 保存の引数に出てくる名前から **逆向きに** たどる。
//   ① 種 = 引数に出てくる名前 (例 `{ workerRoster: roster, ... }` → roster)
//   ② 「種に代入している行」を拾い、その行の名前を種に足す
//      (例 `roster[ymd] = day;` → day を足す)
//   ③ 変わらなくなるまで繰り返す(最大5周)
//   消している所は、**その名前を消している時だけ**数える。
//   ⚠ 限界: 何行にもまたがる代入は繋がらない事がある。落とす方(見逃し)へ倒している。
//     見逃した形は DM-3(消す所と保存する所が別)が別の目で拾う。
/** カンマで一番外側だけ切る(括弧の中のカンマでは切らない)。 */
export const splitTopLevel = (t) => {
  const out = []; let d = 0, s = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ',' && d === 0) { out.push(t.slice(s, i)); s = i + 1; }
  }
  out.push(t.slice(s));
  return out;
};

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'const', 'let', 'var', 'function', 'new', 'delete', 'typeof', 'true', 'false', 'null', 'undefined', 'this', 'await', 'async', 'of', 'in', 'try', 'catch', 'throw', 'case', 'switch', 'break', 'continue', 'default', 'do', 'void', 'class', 'extends', 'super', 'yield', 'instanceof']);
const identsIn = (t) => (t.match(/[A-Za-z_$][\w$]*/g) || []).filter((w) => !KEYWORDS.has(w));
const RE_ASSIGN_TARGET = /(?:^|[;{}(,]|\bconst\b|\blet\b|\bvar\b)\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]\n]*\]|\.\s*[A-Za-z_$][\w$]*)*\s*=(?![=>])/g;

/** 保存の引数から逆向きにたどって「その保存に載る名前」と「関わる行」を出す。 */
export const backwardSlice = (m, from, to, argFrom, argTo) => {
  const reach = new Set(identsIn(m.slice(argFrom, argTo)));
  const lines = [];
  { let s = from; for (let i = from; i < to; i++) if (m[i] === '\n') { lines.push({ s, e: i }); s = i + 1; } lines.push({ s, e: to }); }
  const relevant = new Set();
  // ⚠ 名前を無制限に増やさない。増やすと大きな部品(App 全体)で「何でも当てはまる」になり、
  //   画面の中だけの消し方まで拾って誤検出になる(実測 2026-09-02)。
  //   ① 足すのは **代入の右側**の名前だけ(左側の入れ物の名前は増やさない)
  //   ② 60個で打ち切る(そこまで広がったらもう「1つの流れ」ではない)
  const CAP = 60;
  for (let pass = 0; pass < 5 && reach.size < CAP; pass++) {
    let changed = false;
    for (let li = 0; li < lines.length && reach.size < CAP; li++) {
      if (relevant.has(li)) continue;
      const t = m.slice(lines[li].s, lines[li].e);
      let am, hitAt = -1;
      RE_ASSIGN_TARGET.lastIndex = 0;
      while ((am = RE_ASSIGN_TARGET.exec(t))) if (reach.has(am[1])) { hitAt = am.index + am[0].length; break; }
      if (hitAt < 0) continue;
      relevant.add(li); changed = true;
      for (const id of identsIn(t.slice(hitAt))) { if (reach.size < CAP) reach.add(id); }
    }
    if (!changed) break;
  }
  const relText = [...relevant].map((i) => m.slice(lines[i].s, lines[i].e)).join('\n');
  return { reach, relText };
};

// ---------------------------------------------------------------------------
// ④ 本体 — 純関数。ここだけを自己試験が回す。
// ---------------------------------------------------------------------------
/**
 * @param {Array<{path:string, src:string}>} files
 * @returns {{ ok:boolean, bytes:number, fileCount:number, green:Array, red:Array, notes:Array }}
 */
export const analyze = (files, allow = []) => {
  const prepared = files.map((f) => {
    const m = maskSource(f.src);
    const { blocks, parenCloseOf, balanced } = scanBlocks(m);
    const starts = [0];
    for (let i = 0; i < f.src.length; i++) if (f.src[i] === '\n') starts.push(i + 1);
    const lineOf = (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
    const textOf = (idx) => { const ln = lineOf(idx); const s = starts[ln - 1]; const e = f.src.indexOf('\n', s); return f.src.slice(s, e < 0 ? f.src.length : e).trim(); };
    return { ...f, m, blocks, parenCloseOf, balanced, lineOf, textOf };
  });

  // この製品の中の関数を、名前で引ける様にする(ファイルをまたぐ)。
  const fnIndex = new Map();
  for (const p of prepared) {
    for (const b of p.blocks) {
      if (!b.isFn || !b.name) continue;
      if (!fnIndex.has(b.name)) fnIndex.set(b.name, []);
      fnIndex.get(b.name).push({ file: p, open: b.open, close: b.close });
    }
  }

  const red = [];
  const green = [];
  const notes = [];

  for (const p of prepared) {
    // 🚨 括弧が釣り合わなければ **黙って0件と言わない**。読めていない事を赤にする。
    if (!p.balanced) red.push({ id: 'DM-000', file: p.path, line: 1, why: '括弧の対応が取れませんでした(この見張りはこのファイルを読めていません)', text: '' });

    const saveRe = new RegExp(`(?:^|[^\\w$.])(${SAVE_NAMES.join('|')})\\s*\\(`, 'g');
    let mm;
    saveRe.lastIndex = 0;
    while ((mm = saveRe.exec(p.m))) {
      const nameEnd = mm.index + mm[0].length;      // `(` の次
      const parenOpen = nameEnd - 1;
      const parenClose = p.parenCloseOf.get(parenOpen);
      if (parenClose == null) continue;
      const argFrom = parenOpen, argTo = parenClose + 1;
      let fn = enclosingFn(p.blocks, mm.index);
      // 🚨 大きすぎる入れ物は「1つの流れ」ではない。App 全体(20万文字)を1つの流れと数えると、
      //   5000行離れた画面の消し方まで「この保存が消している」になる(実測 2026-09-02)。
      //   その時は、その保存を包む **一番内側の { } ** だけを見る。
      if (fn && fn.close - fn.open > 20000) {
        let inner = null;
        for (const b of p.blocks) if (b.open < mm.index && mm.index < b.close && (!inner || b.open > inner.open)) inner = b;
        if (inner && inner.close - inner.open <= 20000) fn = inner;
      }
      const from = fn ? fn.open : 0, to = fn ? fn.close : p.m.length;
      if (to - from > 20000) continue;   // それでも大きすぎる = 流れが読めない。黙って赤にしない。

      // --- その保存に本当に載る名前だけへ絞る(逆向きにたどる) ---
      const { reach, relText } = memo(`S:${p.path}:${from}:${to}:${argFrom}`, () => backwardSlice(p.m, from, to, argFrom, argTo));

      // --- 消している所(この関数の中 + **その流れの中で呼んでいる**関数の中。深さ2) ---
      // 🚨 呼んでいる関数を無条件に追うと、React の setXxx(画面の中だけの消し方)を
      //   全部拾って誤検出だらけになる(実測46件)。**流れに載っている呼び出しだけ**を追う。
      // --- 保存へ「丸ごと」渡す入れ物の名前(そこからキーを落とすのは「送らない」の意味) ---
      // 🚨 ここを数えないと、**印を足したら本番のデータが消える**所を「直せ」と言ってしまう。
      //   実測 2026-09-02 製品 src/App.jsx:43524
      //     if (…tasks が空マップなら) delete rest.tasks;   ← 「今サーバに在る記録を上書きしない」為
      //     const body = … { ...rest, id } … ;  await saveData('lots', docId, body, …);
      //   merge:true では「送らない」= そのまま残す。ここに消す印を付けたら検査記録が消える。
      //   → 保存の引数に **丸ごと** 載る入れ物(と、それへ展開される元)は数えない。
      //   ⚠ 鍵の下に入る物(`{ workerRoster: roster }` の roster)は別。そちらは数える。
      const bodyRoots = new Set();
      {
        const argTxt = p.m.slice(argFrom + 1, argTo - 1);
        // 素の名前だけの引数(`saveData('lots', id, body)` の body)
        for (const a of splitTopLevel(argTxt)) {
          const t = a.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(t)) bodyRoots.add(t);
          else { const om = t.match(/^\{([\s\S]*)\}$/); if (om) for (const s of splitTopLevel(om[1])) { const sm = s.trim().match(/^\.\.\.\s*([A-Za-z_$][\w$]*)/); if (sm) bodyRoots.add(sm[1]); } }
        }
        // `const body = { ...rest, id }` のように、丸ごと展開される元も辿る
        for (let pass = 0; pass < 3; pass++) {
          for (const t of relText.split('\n')) {
            const dm = t.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/);
            if (!dm || !bodyRoots.has(dm[1])) continue;
            for (const sm of dm[2].matchAll(/\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)|(?:[:?]|=)\s*([A-Za-z_$][\w$]*)\s*[;:]/g)) bodyRoots.add(sm[1] || sm[2]);
          }
        }
      }

      const dels = memo(`D:${p.path}:${from}:${to}`, () => deletionsIn(p.m, from, to))
        .filter((d) => {
          const root = String(d.target).split(/[.?]/)[0];
          if (!reach.has(root)) return false;
          if (bodyRoots.has(root)) return false;                    // 「送らない」の意味 → 印は要らない
          if (d.at > mm.index) return false;                        // 保存より後ろで消しても、この保存には載らない
          // 🚨 消した後で **入れ物を作り直して** いたら、その消しはこの保存に載らない。
          //   実測: handleSkipStep は if の枝で消して印つきで保存し、else の枝で
          //   `const newTasks = { ...tasks };` と作り直して別の保存をしている(別物)。
          const reDecl = new RegExp(`(?:const|let|var)\\s+${root}(?![\\w$])`, 'g');
          if (findAll(reDecl, p.m, d.at, mm.index).length) return false;
          // 🚨 消した所と保存の間に **return / throw** で抜ける枝が有れば、その消しはここへ来ない。
          //   実測 2026-09-02 golden saveStepMemo: メモを空にした時は
          //   `delete next[stepId]; … onSave({ stepMemos: { [stepId]: DATA_DELETE } }); return;`
          //   で抜けている。その先の `onSave({ stepMemos: next })` は別の道。
          let blk = null;
          for (const b of p.blocks) {
            if (b.open < d.at && d.at < b.close && !(b.open < mm.index && mm.index < b.close)) {
              if (!blk || b.open > blk.open) blk = b;
            }
          }
          if (blk && /\b(?:return|throw)\b/.test(p.m.slice(d.at, blk.close))) return false;
          return true;
        })
        .map((d) => ({ ...d, file: p, via: '' }));
      const seen = new Set();
      const walkCalls = (ff, text, depth, viaChain) => {
        if (depth > 2) return;
        for (const nm of new Set((text.match(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g) || []).map((s) => s.replace(/[^\w$]/g, '')))) {
          if (SAVE_NAMES.includes(nm) || NOT_FN_HEAD.has(nm) || KEYWORDS.has(nm)) continue;
          // 🚨 setXxx(画面の中身を書き換える) と useXxx(React の仕掛け) は追わない。
          //   保管庫へは1バイトも行かないので、ここを追うと画面の中だけの消し方を
          //   「保存が消している」と誤って数える(実測 2026-09-02: これだけで誤検出30件超)。
          if (/^(?:set|use)[A-Z]/.test(nm)) continue;
          for (const tgt of (fnIndex.get(nm) || [])) {
            const key = `${tgt.file.path}:${tgt.open}`;
            if (seen.has(key)) continue;
            seen.add(key);
            for (const d of memo(`D:${tgt.file.path}:${tgt.open}:${tgt.close}`, () => deletionsIn(tgt.file.m, tgt.open, tgt.close))) {
              dels.push({ ...d, file: tgt.file, via: [...viaChain, nm].join(' → ') });
            }
            walkCalls(tgt.file, tgt.file.m.slice(tgt.open, tgt.close), depth + 1, [...viaChain, nm]);
          }
        }
      };
      walkCalls(p, p.m.slice(argFrom, argTo) + '\n' + relText, 1, []);
      if (!dels.length) continue;                     // 消していない保存は関係ない

      // --- 印が この保存の引数に届いているか ---
      const evidences = [];
      let marked = hasMarkIn(p.m, argFrom, argTo);
      if (marked) evidences.push({ file: p, at: findAll(RE_MARK, p.m, argFrom, argTo)[0].at, how: '保存の引数に直接' });

      // 引数に渡した変数の中に印を入れている形
      if (!marked) {
        const ids = new Set();
        const idRe = /(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)/g;
        let im; idRe.lastIndex = 0;
        const argTxt = p.m.slice(argFrom, argTo);
        while ((im = idRe.exec(argTxt))) ids.add(im[1]);
        for (const id of ids) {
          const asnRe = new RegExp(`${id}\\s*(?:\\.${MARK}|\\[\\s*['"\`]?${MARK})`, 'g');
          if (findAll(asnRe, p.m, from, to).length) { marked = true; evidences.push({ file: p, at: findAll(asnRe, p.m, from, to)[0].at, how: `変数 ${id} に入れて渡している` }); break; }
          const declRe = new RegExp(`(?:const|let|var)\\s+${id}\\s*=`, 'g');
          const decl = findAll(declRe, p.m, from, to)[0];
          if (decl) {
            const stmtEnd = p.m.indexOf(';', decl.at);
            if (stmtEnd > 0 && hasMarkIn(p.m, decl.at, stmtEnd)) { marked = true; evidences.push({ file: p, at: decl.at, how: `変数 ${id} に入れて渡している` }); break; }
          }
        }
      }
      // 引数の中で呼んでいる関数が印を作って返す形(intWritePatch など)
      if (!marked) {
        for (const nm of calledNamesIn(p.m, argFrom, argTo)) {
          for (const tgt of (fnIndex.get(nm) || [])) {
            if (hasMarkIn(tgt.file.m, tgt.open, tgt.close)) {
              marked = true;
              evidences.push({ file: tgt.file, at: findAll(RE_MARK, tgt.file.m, tgt.open, tgt.close)[0].at, how: `${nm}() が印を作って返している` });
              break;
            }
          }
          if (marked) break;
        }
      }

      const rec = {
        id: 'DM-1', file: p.path, line: p.lineOf(mm.index), text: p.textOf(mm.index),
        saveName: mm[1],
        fnName: `${fn ? (fn.name || '(名前なし)') : '(ファイルの直下)'} の中の ${mm[1]}(`,
        dels: dels.slice(0, 4).map((d) => ({ line: d.file.lineOf(d.at), text: d.file.textOf(d.at), file: d.file.path, via: d.via })),
        delCount: dels.length,
        evidences: evidences.map((e) => ({ file: e.file.path, line: e.file.lineOf(e.at), text: e.file.textOf(e.at), how: e.how })),
      };
      if (marked) green.push(rec);
      else red.push({ ...rec, why: `キーを消しているのに、この保存の引数に ${MARK} が届いていません(merge:true は送らなかったキーを消しません)` });
    }
  }

  // --- DM-3 消す所と保存する所が別 ---
  for (const p of prepared) {
    const copyRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:\?)?\.\s*([A-Za-z_$][\w$]*)/g;
    let cm; copyRe.lastIndex = 0;
    while ((cm = copyRe.exec(p.m))) {
      const [, copyName, rootObj, field] = cm;
      const fn = enclosingFn(p.blocks, cm.index);
      if (!fn) continue;
      const dels = deletionsIn(p.m, fn.open, fn.close).filter((d) => d.target === copyName);
      if (!dels.length) continue;
      const saveInScope = new RegExp(`(?:^|[^\\w$.])(?:${SAVE_NAMES.join('|')})\\s*\\(`, 'g');
      if (findAll(saveInScope, p.m, fn.open, fn.close).length) continue;   // 同じ流れなら DM-1 の担当
      // その入れ物(rootObj)を保存へ渡している所が有るか
      const savedRe = new RegExp(`(?:^|[^\\w$.])(?:${SAVE_NAMES.join('|')})\\s*\\([^)]{0,400}?(?:^|[^\\w$.])${rootObj}(?![\\w$])`, 'gs');
      const saved = findAll(savedRe, p.m, 0, p.m.length);
      if (!saved.length) continue;
      // その場所(field)を名指しで消している印がファイルのどこかに有るか
      const markPath = new RegExp(`${MARK}[\\s\\S]{0,200}?${field}(?![\\w$])`, 'g');
      if (findAll(markPath, p.m, 0, p.m.length).length) continue;
      red.push({
        id: 'DM-3', file: p.path, line: p.lineOf(cm.index), text: p.textOf(cm.index),
        fnName: fn.name || '(名前なし)',
        why: `${rootObj}.${field} からキーを消していますが、保存はここではなく別の場所(${p.path}:${p.lineOf(saved[0].at)})で、${MARK} が ${field} を名指ししていません`,
        dels: dels.slice(0, 3).map((d) => ({ line: p.lineOf(d.at), text: p.textOf(d.at), file: p.path, via: '' })),
        delCount: dels.length, evidences: [],
      });
    }
  }

  const bytes = files.reduce((s, f) => s + Buffer.byteLength(f.src, 'utf8'), 0);
  if (bytes === 0) red.push({ id: 'DM-2', file: '-', line: 0, why: '実コードを 0バイト しか読んでいません(緑なのに何も守っていない見張りです)', text: '', dels: [], evidences: [] });

  // ------------------------------------------------------------------------
  // 言い訳(allow)。⚠ **黙って消さない**。当たった物は理由つきで必ず印字する。
  // ------------------------------------------------------------------------
  // 🚨 言い訳を置ける仕組みは、放っておくと「本物を黙らせる道具」になる。だから
  //   ・理由(reason)が空なら **赤**
  //   ・1件も当たらない言い訳(古くなった言い訳)が残っていたら **赤**
  //   ・当たった物は毎回 理由ごと画面に出す(数だけにしない)
  const allowed = [];
  const stale = [];
  for (const a of (allow || [])) {
    if (!a || !a.reason || !String(a.reason).trim()) { red.push({ id: 'DM-ALLOW', file: a && a.file || '-', line: 0, why: '言い訳に理由が書かれていません(理由の無い言い訳は置けません)', text: '', dels: [], evidences: [] }); continue; }
    const hit = red.filter((x) => x.file === a.file && String(x.text || '').includes(a.when));
    if (!hit.length) { stale.push(a); continue; }
    for (const h of hit) { allowed.push({ ...h, reason: a.reason, by: a.by || '' }); }
  }
  const allowedSet = new Set(allowed.map((x) => `${x.file}:${x.line}:${x.id}`));
  const remaining = red.filter((x) => !allowedSet.has(`${x.file}:${x.line}:${x.id}`));
  for (const a of stale) remaining.push({ id: 'DM-ALLOW', file: a.file, line: 0, why: `言い訳が古くなっています(この形はもうコードに在りません): 「${a.when}」`, text: '', dels: [], evidences: [] });

  return { ok: remaining.length === 0, bytes, fileCount: files.length, green, red: remaining, allowed, notes };
};

// ============================================================================
// 自己試験 — わざと壊して赤になるか / 正しい形が緑のままか
// ============================================================================
const GOOD = `
const WorkerRosterPanel = ({ settings, saveSettings }) => {
  const cycle = (ymd, worker) => {
    const cur = rosterStatusOf(settings, ymd, worker);
    const next = cur === 'present' ? 'off' : cur === 'off' ? 'other' : 'present';
    const roster = { ...(settings?.workerRoster || {}) };
    const day = { ...(roster[ymd] || {}) };
    const dead = [];
    if (next === 'present') { delete day[worker]; dead.push(['workerRoster', ymd, worker]); } else day[worker] = next;
    if (Object.keys(day).length === 0) { delete roster[ymd]; dead.push(['workerRoster', ymd]); } else roster[ymd] = day;
    saveSettings && saveSettings({ workerRoster: roster, ...(dead.length ? { __deleteMapKeys: dead } : {}) });
  };
  return null;
};
`;

const BREAKS = [
  {
    name: '① ロスターの印を外す',
    src: GOOD.replace(", ...(dead.length ? { __deleteMapKeys: dead } : {})", ''),
    expect: 'DM-1',
  },
  {
    name: '② 別の設定で印なしの delete を書く',
    src: GOOD + `
const PresetPanel = ({ settings, saveSettings }) => {
  const removePreset = (key) => {
    const next = { ...(settings?.customLayouts || {}) };
    delete next[key];
    saveSettings({ customLayouts: next });
  };
  return null;
};
`,
    expect: 'DM-1',
  },
  {
    name: '③ 印を文字列の中に書く',
    src: GOOD.replace("...(dead.length ? { __deleteMapKeys: dead } : {})", "note: '__deleteMapKeys'"),
    expect: 'DM-1',
  },
  {
    name: '④ 印をコメントに書く',
    src: GOOD.replace("...(dead.length ? { __deleteMapKeys: dead } : {})", "/* __deleteMapKeys: dead */"),
    expect: 'DM-1',
  },
  {
    name: '⑤ 印を if の枝の中だけに置く(保存に届かない)',
    src: GOOD.replace(
      "saveSettings && saveSettings({ workerRoster: roster, ...(dead.length ? { __deleteMapKeys: dead } : {}) });",
      "if (dead.length) { const patch = { __deleteMapKeys: dead }; logIt(patch); }\n    saveSettings && saveSettings({ workerRoster: roster });"
    ),
    expect: 'DM-1',
  },
  {
    name: '⑥ 印を別の変数名にする',
    src: GOOD.replace('__deleteMapKeys: dead', '__deleteMapKeysX: dead'),
    expect: 'DM-1',
  },
  {
    name: '⑦ delete を別関数へ移して呼ぶ',
    src: `
const stripWorker = (day, worker) => { delete day[worker]; return day; };
const WorkerRosterPanel = ({ settings, saveSettings }) => {
  const cycle = (ymd, worker) => {
    const roster = { ...(settings?.workerRoster || {}) };
    const day = stripWorker({ ...(roster[ymd] || {}) }, worker);
    roster[ymd] = day;
    saveSettings && saveSettings({ workerRoster: roster });
  };
  return null;
};
`,
    expect: 'DM-1',
  },
  {
    name: '⑧ delete ではなく undefined を入れて消す',
    src: GOOD
      .replace('delete day[worker];', 'day[worker] = undefined;')
      .replace(", ...(dead.length ? { __deleteMapKeys: dead } : {})", ''),
    expect: 'DM-1',
  },
  {
    name: '⑨ 消す所と保存する所が別(state に入れて別の関数で保存)',
    src: `
const CsvMappingPanel = ({ settings, saveSettingsConfig }) => {
  const [csvMapping, setCsvMapping] = useState({});
  const onChangeCol = (cond, v) => {
    const newMap = { ...(csvMapping.specialConditionsMap || {}) };
    if (v) newMap[cond] = v; else delete newMap[cond];
    setCsvMapping({ ...csvMapping, specialConditionsMap: newMap });
  };
  const handleSave = async () => {
    await saveSettingsConfig({ csvMapping, breakAlerts });
  };
  return null;
};
`,
    expect: 'DM-3',
  },
];

// 正しい形(緑のままである事を確かめる見本)。⚠ 実コードから採った形。
const GREENS = [
  { name: '直下のキーを消す印', src: `const f = (onSave, newTasks, removed) => { delete newTasks[k]; onSave({ tasks: newTasks, ...(removed.length ? { __deleteMapKeys: { tasks: removed } } : {}) }); };` },
  { name: '深い場所を消す印', src: `const f = (saveSettings, next, model) => { delete next[model]; saveSettings({ measurementOverrides: next, __deleteMapKeys: [['measurementOverrides', model]] }); };` },
  { name: '別関数が印を作って返す', src: `export const intWritePatch = (prev, next) => { const patch = {}; const gone = keysGone(prev, next); if (gone.length) patch.__deleteMapKeys = gone; return patch; };
const g = (saveData, lot, prev, next) => { delete prev[x]; saveData('lots', lot.id, intWritePatch(prev, next)); };` },
  { name: '変数に入れて広げる', src: `const f = (onSave, newTasks, removed) => { delete newTasks[k]; const delKeys = removed.length ? { __deleteMapKeys: { tasks: removed } } : {}; onSave({ tasks: newTasks, ...delKeys }); };` },
  { name: '消していない保存は無関係', src: `const f = (saveSettings) => { saveSettings({ baseFontSize: 14 }); };` },
  { name: '空文字は本物の値(印は要らない)', src: `const f = (saveSettings, next, k) => { next[k] = ''; saveSettings({ memo: next }); };` },
];

export const selftest = () => {
  let ok = true;
  const line = (s) => console.log(s);
  line('🧪 見張り自身の試験 — わざと壊して赤になるか / 正しい形が緑のままか');
  line('   壊し方 / 期待 / 実際 / 判定');

  for (const b of BREAKS) {
    if (b.src === GOOD) { ok = false; line(`   ❌ ${b.name} … **見本が1文字も変わっていません**(当て込みが空振り)`); continue; }
    const r = analyze([{ path: 'fixture.jsx', src: b.src }]);
    const got = r.red.map((x) => x.id);
    const hit = got.includes(b.expect);
    if (!hit) ok = false;
    line(`   ${hit ? '✅' : '❌'} ${b.name} / 赤(${b.expect}) / ${r.red.length ? got.join(',') : '緑のまま'} / ${hit ? '合格' : '**不合格**'}`);
  }

  line('');
  line('   正しい形が緑のままか');
  const g0 = analyze([{ path: 'fixture.jsx', src: GOOD }]);
  if (!g0.ok) { ok = false; line(`   ❌ ロスターの正しい形 … 赤になりました(${g0.red.map((x) => x.why).join(' / ')})`); }
  else line(`   ✅ ロスターの正しい形 … 緑 / 印の根拠 ${g0.green.length}件`);
  for (const g of GREENS) {
    const r = analyze([{ path: 'fixture.jsx', src: g.src }]);
    if (!r.ok) { ok = false; line(`   ❌ ${g.name} … 赤になりました(${r.red.map((x) => x.why).join(' / ')})`); }
    else line(`   ✅ ${g.name} … 緑`);
  }

  // 🚨 言い訳(allow)の仕組み自体も試験する。言い訳が「本物を黙らせる道具」にならない事。
  line('');
  line('   言い訳(allow)の仕組み');
  const brokenSrc = BREAKS[0].src;
  const a1 = analyze([{ path: 'fixture.jsx', src: brokenSrc }], [{ file: 'fixture.jsx', when: 'saveSettings({ workerRoster: roster })', reason: '' }]);
  const a1ok = !a1.ok && a1.red.some((x) => x.id === 'DM-ALLOW');
  if (!a1ok) ok = false;
  line(`   ${a1ok ? '✅' : '❌'} 理由の無い言い訳は赤 / 赤 / ${a1.ok ? '緑のまま' : a1.red.map((x) => x.id).join(',')} / ${a1ok ? '合格' : '**不合格**'}`);
  const a2 = analyze([{ path: 'fixture.jsx', src: brokenSrc }], [{ file: 'fixture.jsx', when: 'もう存在しない書き方()', reason: 'あるある' }]);
  const a2ok = !a2.ok && a2.red.some((x) => x.id === 'DM-ALLOW' && /古く/.test(x.why));
  if (!a2ok) ok = false;
  line(`   ${a2ok ? '✅' : '❌'} 古くなった言い訳は赤 / 赤 / ${a2.ok ? '緑のまま' : a2.red.map((x) => x.id).join(',')} / ${a2ok ? '合格' : '**不合格**'}`);
  const a3 = analyze([{ path: 'fixture.jsx', src: brokenSrc }], [{ file: 'fixture.jsx', when: 'saveSettings({ workerRoster: roster })', reason: 'ここは丸ごと置換で消えるから' }]);
  const a3ok = a3.ok && a3.allowed.length === 1 && !!a3.allowed[0].reason;
  if (!a3ok) ok = false;
  line(`   ${a3ok ? '✅' : '❌'} 理由つきの言い訳は通り、理由が必ず出る / 緑+理由1件 / ${a3.ok ? `緑+理由${a3.allowed.length}件` : '赤'} / ${a3ok ? '合格' : '**不合格**'}`);

  // 🚨 見張りが「何も読まない」で緑にならない事
  const empty = analyze([]);
  const zeroOk = !empty.ok && empty.red.some((x) => x.id === 'DM-2');
  if (!zeroOk) ok = false;
  line(`   ${zeroOk ? '✅' : '❌'} 0バイトしか読まなければ赤(DM-2) / 赤 / ${empty.ok ? '緑のまま' : 'DM-2'} / ${zeroOk ? '合格' : '**不合格**'}`);

  line(ok ? '   ✅ 見張り自身の試験 合格' : '   ❌ 見張り自身の試験 不合格');
  return ok;
};

// ============================================================================
// 実コードを見る
// ============================================================================
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(HERE, '..');

const collectFiles = (root) => {
  const out = [];
  const push = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: path.relative(root, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }); };
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); }
      else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) push(p);
    }
  };
  // 画面の本体(大きい物は名指し) + domain/data の全部
  for (const n of ['App.jsx', 'App.firebase.jsx', 'App.pocketbase.jsx']) push(path.join(root, 'src', n));
  walk(path.join(root, 'src', 'domain'));
  walk(path.join(root, 'src', 'data'));
  for (const d of ['components', 'opsim', 'opsimfi', 'panels']) walk(path.join(root, 'src', d));
  // 同じファイルを2度読まない
  const seen = new Set();
  return out.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
};

const main = () => {
  const argv = process.argv.slice(2);
  const onlySelftest = argv.includes('--selftest');
  const listOnly = argv.includes('--list');

  let selfOk = true;
  if (!process.env.DELETE_MARK_NO_SELFTEST) {
    selfOk = selftest();
    console.log('');
  }
  if (onlySelftest) process.exit(selfOk ? 0 : 1);

  const files = collectFiles(ROOT);
  // 言い訳の帳面。無ければ「言い訳ゼロ」。⚠ 中身は必ず画面に出す(黙って効かせない)。
  // ⚠ 見張り本体(.mjs)は4アプリで同じ物にするので、アプリごとに違う「言い訳」は
  //   **見る側のアプリの scripts/ から**読む(HERE ではない。APP_ROOT で他所を見る時に付いて来ない為)。
  const allowPath = path.join(ROOT, 'scripts', 'delete-mark-allow.json');
  let allow = [];
  if (fs.existsSync(allowPath)) {
    try { allow = JSON.parse(fs.readFileSync(allowPath, 'utf8')).allow || []; }
    catch (e) { console.log(`🚨 ${path.basename(allowPath)} が読めません: ${e.message}`); process.exit(1); }
  }
  const r = analyze(files, allow);

  console.log(`🗑️ 消す印(${MARK})の見張り — ${ROOT}`);
  console.log(`📖 読んだ実コード: ${r.fileCount}ファイル / ${r.bytes.toLocaleString()}バイト`);
  if (r.fileCount === 0) console.log('   🚨 1ファイルも読めていません。対象の道が違います。');
  else console.log(`   ${files.slice(0, 6).map((f) => f.path).join(' , ')}${files.length > 6 ? ` , ほか${files.length - 6}件` : ''}`);
  console.log('');

  console.log(`✅ 印が付いている保存 … ${r.green.length}件(根拠を出します。黙って通しません)`);
  for (const g of r.green) {
    console.log(`   ${g.file}:${g.line}  ${g.fnName})`);
    console.log(`      保存 : ${g.text.slice(0, 150)}`);
    for (const d of g.dels.slice(0, 2)) console.log(`      消す : ${d.file}:${d.line} ${d.text.slice(0, 110)}${d.via ? `  ← ${d.via}() 経由` : ''}`);
    for (const e of g.evidences) console.log(`      印   : ${e.file}:${e.line} (${e.how}) ${e.text.slice(0, 110)}`);
  }
  console.log('');

  console.log(`📝 言い訳で通した所 … ${r.allowed.length}件(理由を必ず出します。黙って通しません)`);
  for (const a of r.allowed) {
    console.log(`   [${a.id}] ${a.file}:${a.line}  ${a.text.slice(0, 110)}`);
    console.log(`      理由 : ${a.reason}${a.by ? `  (${a.by})` : ''}`);
  }
  console.log('');

  if (r.red.length) {
    console.log(`❌ 印が届いていない保存 … ${r.red.length}件`);
    for (const x of r.red) {
      console.log(`   [${x.id}] ${x.file}:${x.line}  ${x.fnName || ''}`);
      console.log(`      ${x.why}`);
      if (x.text) console.log(`      保存 : ${x.text.slice(0, 150)}`);
      for (const d of (x.dels || []).slice(0, 3)) console.log(`      消す : ${d.file}:${d.line} ${d.text.slice(0, 110)}${d.via ? `  ← ${d.via}() 経由` : ''}`);
    }
    console.log('');
    console.log('   直し方: 保存の引数に消したキーの場所を渡してください。');
    console.log(`     saveSettings({ workerRoster: roster, ...(dead.length ? { ${MARK}: dead } : {}) });`);
    console.log("     dead は [['workerRoster','2026-09-01','田中']] のような **配列** の並び(ドット区切りは型式名で壊れます)。");
  } else {
    console.log('❌ 印が届いていない保存 … 0件');
  }

  const ok = selfOk && (listOnly || r.ok);
  console.log('');
  console.log(ok ? '✅ 合格' : '❌ 不合格');
  process.exit(ok ? 0 : 1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
