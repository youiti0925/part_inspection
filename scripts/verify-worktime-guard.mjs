// ============================================================================
// ⏱🚨 「作業時間を消しうる保存」が 見張り(src/domain/workTimeGuard.js)を通っているか
//      を **実コードで機械的に数える**。
// ----------------------------------------------------------------------------
// 2026-08-17 の事故:
//   本番 final-inspection-v1 の5ロットで tasks(時間取りデータ)が空のマップになり、
//   8/12・8/17 に測った時間が全部消えた。復旧手段はゼロだった。
//
// 根っこ:
//   Firestore の setDoc(merge:true) に **空のマップ `{}`** を渡すと、その項目は
//   丸ごと空に置き換わる(node_modules/@firebase/firestore/dist/common-091f2944.esm.js:20701-20706)。
//   このアプリはロット保存のほぼ全経路で **tasks のマップ全体** を送っている。
//   つまり「手元の tasks が空だった1回」で全部飛ぶ。**止める仕掛けは無かった。**
//
// この見張りが出す物:
//   ① 保存の関所(saveData)が workTimeGuard を通っているか
//   ② 関所を迂回して保管庫へ直接ロットを書いている所
//   ③ ロットの payload に **空のマップを直書き** している所
//   ④ `if (lot.tasks)` のような **空マップを素通しする真偽判定**
//   ⑤ tasks のマップ全体を送っている所の一覧(＝いま危ない所)
//
// ⚠⚠ **見張り自身も試験する。** 過去に嘘の合格3件・実コードを食う誤検出1件があった。
//   `node scripts/verify-worktime-guard.mjs --selftest` で
//   「直す前のコードなら落ちる／直した後のコードなら通る」を毎回確かめる。
//
// 使い方:
//   node scripts/verify-worktime-guard.mjs                 … このリポの本体を見る
//   node scripts/verify-worktime-guard.mjs <ファイル...>    … 指定した物を見る
//   node scripts/verify-worktime-guard.mjs --selftest      … 見張り自身の試験
//   環境変数 WTG_LIST_ONLY=1 … ⑤の一覧だけ出して常に exit 0(移行の途中で使う)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 下ごしらえ
// ---------------------------------------------------------------------------
// ⚠コメントを消してから見る。コメントの中の例示コードを「実コード」として
//   数えると嘘の指摘になる(2026-08-16 に実コードを食う誤検出を出した)。
//   ⚠ URL の `//` を消さないよう、直前が `:` の時は行コメントとみなさない。
export const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

/** `{` から対応する `}` までを返す(文字列/テンプレートは飛ばす簡易版)。 */
const blockFrom = (src, openIdx) => {
  let depth = 0, i = openIdx, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
};

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/**
 * その位置を囲んでいる一番内側の `{ ... }` の中身を返す。
 * ⚠これが無いと `let _skip = { plan:{}, tasks:{}, decisions:[] }` のような
 *   **ただの手元の変数** を「Firestore へ書く payload」と誤認する(実コードを食う誤検出)。
 */
const enclosingObject = (src, idx) => {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return blockFrom(src, i); depth--; }
  }
  return '';
};

/** ロットの doc らしさ。この語が同じオブジェクトに無ければ payload とみなさない。 */
const LOT_DOC_FIELDS = /\b(orderNo|serialNo|steps|interruptions|mapZoneId|templateId|unitSerialNumbers|quantity|dueDate)\s*:/;

// ---------------------------------------------------------------------------
// 本体: 1ファイルを調べる(純関数。--selftest はこれを文字列に対して回す)
// ---------------------------------------------------------------------------
export const GUARD_CALLS = /assertSafeLotSave|wouldLoseWorkTime/;

/**
 * 🚨🚨 2026-08-30(部品検査で実測): 関所が見張りを **別の関数に任せている** 形がある。
 *     const guardLotSave = (col, id, data) => { if (col !== 'lots') return; … assertSafeLotSave(…) };
 *     const saveData = async (col, id, data) => { …; guardLotSave(col, id, data); …; };
 *   この形だと saveData の中身に `assertSafeLotSave` も `'lots'` も出てこないので、
 *   **関所そのものが検査対象から外れていた**。
 *   ⚠実測: 部品検査の saveData から `guardLotSave(col, id, data);` の1行を消しても
 *     この見張りは **緑のままだった**(＝2026-08-17 の門が黙って外れても気づけない)。
 *
 * ⚠⚠ **名前を見ただけで通さない。** 見張り役として数えるのは
 *   「同じファイルに `const 名前 = …` が在って、**その中身が本物の見張り
 *   (assertSafeLotSave / wouldLoseWorkTime)を呼んでいる**」時だけ。
 *   でないと、中身が空の偽の見張りを1つ置くだけで関所が素通りする。
 * @param {string} src コメントを消した後のファイル全体
 * @returns {string[]} 見張り役として数えてよい関数の名前
 */
export const helperNamesWhere = (src, test) => {
  const out = [];
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (GUARD_CALLS.test(name)) continue; // 見張りそのものの別名定義は数えない
    // その定義1つぶん(次の「深さ0の ;」まで)を切り出す。
    let depth = 0;
    let body = src.slice(m.index);
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) { body = src.slice(m.index, i); break; }
    }
    if (test(body)) out.push({ name, size: body.length });
  }
  // 同じ名前が2回出たら短い方を残す(人に見せる時に「どれが門か」を選ぶ為)。
  const best = new Map();
  for (const h of out) if (!best.has(h.name) || best.get(h.name) > h.size) best.set(h.name, h.size);
  const names = [...best.keys()];
  // ⚠判定に使うのは名前の一覧(ここは今までどおり)。大きさは 人に見せる並べ替えだけに使う。
  names.sort((a, b) => best.get(a) - best.get(b));
  return names;
};

// ===========================================================================
// 🚨🚨 読み込みの門(assertLotsLoaded)を **実コードで** 追う道具 (2026-09-01)
// ---------------------------------------------------------------------------
// あら探しで実測: 保存の関所から `assertLotsLoaded(…)` の **1行を消しても**
//   check-load-guards.mjs / verify-save-safety.mjs / verify-worktime-guard.mjs /
//   verify-promises.mjs の4本が **全部 緑のまま** だった。
//   ・check-load-guards の A0 は「旗(lotsLoaded)が在るか」しか見ない → 旗は残るので緑
//   ・A3 は自動処理だけを見る → 関所は見ていない
//   ・WTG-001 は assertSafeLotSave だけを見る → そちらは残るので緑
//   ・単体試験は純関数だけで **配線を見ていない**
//   つまり「読み込みが終わる前に保存しない」という約束を、誰も見ていなかった。
//   これは 2026-08-17(作業時間が丸ごと消えた)と 2026-08-28(門が黙って外れる)の族。
//
// ⚠⚠ **「その行が在るか」だけで判定しない。** 次の4つを全部見る:
//   ① 関所が門を通っているか(**別の関数に任せていても1段は追う**)
//   ② 渡している旗が本物か(true の直書き・`|| true` は門を開きっぱなしにする)
//   ③ その旗が **下りる道** が在るか(一度も false にならない旗は門ではない)
//   ④ 保存より **前** で呼んでいるか(後ろで呼んでも手遅れ)
// ===========================================================================

/** `名前(` の直後から、深さ1の `,` または閉じ `)` までを1つ目の引数として切り出す。 */
export const firstArgOf = (src, afterOpenParen) => {
  let depth = 1, q = null, out = '';
  for (let i = afterOpenParen; i < src.length; i++) {
    const c = src[i];
    if (q) { out += c; if (c === '\\') { out += src[i + 1] || ''; i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
    if (c === ',' && depth === 1) break;
    out += c;
  }
  return out.trim();
};

// 「右側がいつも真」= `x || true` `x ?? 1` のような素通し。
const FORCED_TRUE = /(?:\|\||\?\?)\s*(?:true|1|!0|!!1)\s*$/;
// 変数として数えない語(これしか出てこない引数は **動かない値** = いつも同じ)。
const NOT_A_FLAG = /^(?:true|false|null|undefined|NaN|Boolean|Number|String|Object|Array)$/;

/**
 * assertLotsLoaded(…) の1つ目の引数が **本物の旗** かを見る。
 * ⚠ここが甘いと「条件を常に真にして素通しさせる」壊し方に気づけない。
 * @returns {{ok:true,expr:string}|{ok:false,why:string}}
 */
export const classifyLoadedArg = (arg) => {
  const a = String(arg || '').trim();
  if (!a) return { ok: false, why: '旗を1つも渡していない（引数が空）＝何も見ていない' };
  if (FORCED_TRUE.test(a)) return { ok: false, why: `\`${a}\` は右側でいつも真になる＝門が開きっぱなし` };
  // 文字列の中身を消してから、変数らしい語が1つでも残るかを見る。
  const bare = a.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ');
  const names = bare.match(/[A-Za-z_$][\w$]*/g) || [];
  if (!names.some((n) => !NOT_A_FLAG.test(n))) {
    return { ok: false, why: `\`${a}\` は動かない値（いつも同じ）＝門が開きっぱなし` };
  }
  return { ok: true, expr: a };
};

/** その本文に「本物の旗を渡した assertLotsLoaded(…)」が在るか。 */
export const hasGenuineLoadedCall = (body) => {
  const re = /(?<![\w$.])assertLotsLoaded\s*\(/g;
  let mm;
  while ((mm = re.exec(body))) {
    if (classifyLoadedArg(firstArgOf(body, mm.index + mm[0].length)).ok) return true;
  }
  return false;
};

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * その旗が **下りる道** が在るか。
 * ⚠ 一度も false にならない旗を渡していれば、門は在っても永久に開いている。
 *   `lotsLoadedRef.current = false` / `= ok`(何かを入れる) / `setLotsLoaded(false)` のどれかを探す。
 */
export const flagCanFall = (src, expr) => {
  const E = escRe(expr);
  if (new RegExp(`${E}\\s*=\\s*(?!=)(?!\\s*true\\b)`).test(src)) return true;
  const root = (String(expr).match(/[A-Za-z_$][\w$]*/) || [''])[0];
  // 🚨🚨 2026-09-01 実測(最終検査の実物で確かめた): ここで set…(false) を
  //   **控え(ref)にも** 効くものとして数えていたので、
  //   `lotsLoadedRef.current = false` を `= true` に書き換えても 緑のままだった。
  //   関所が読むのは **控えの方**。画面用の値が下りても控えが上がりっぱなしなら門は開いている。
  //   → 控えを読んでいる時(名前が Ref で終わる / .current を読む)は、
  //     **その控えそのものに下りる道が在る事** だけを認める。
  if (/\.current\b/.test(String(expr)) || /Ref$/.test(root)) return false;
  if (!root) return false;
  const setter = `set${root.charAt(0).toUpperCase()}${root.slice(1)}`;
  return new RegExp(`${escRe(setter)}\\s*\\(\\s*false\\s*\\)`).test(src);
};

/** 中身が **本物の見張り** を呼んでいる関数の名前(＝見張り役として数えてよい)。 */
export const guardHelperNames = (src) => helperNamesWhere(src, (body) => GUARD_CALLS.test(body));
/**
 * 中身が **本物の読み込みの門** を通している関数の名前。
 * 🚨 これが無いと、関所が門を別関数(guardLotSave など)に任せた形を追えない
 *   (2026-08-30 に「関所が別関数に任せていると検査対象から外れる」で素通りした前科)。
 */
export const loadedHelperNames = (src) =>
  helperNamesWhere(src, hasGenuineLoadedCall).filter((n) => !/assertLotsLoaded/.test(n));
/** 中身が **ロットを名指ししている** 関数の名前(＝ロットを扱う関所の一部)。 */
export const lotHelperNames = (src) => helperNamesWhere(src, (body) => /['"]lots['"]/.test(body));

export const analyze = (rawSrc, file = '(memory)') => {
  const src = stripComments(rawSrc);
  const lines = src.split('\n');
  // 🚨 見張りを任されている関数(guardLotSave など)。中身まで見て決める。
  const helpers = guardHelperNames(src);
  const lotHelpers = lotHelperNames(src);
  const callRe = (names) => (names.length ? new RegExp(`(?<![\\w$])(?:${names.join('|')})\\s*\\(`) : null);
  const HELPER_CALL = callRe(helpers);
  const LOT_HELPER_CALL = callRe(lotHelpers);
  /** 関所が見張りを通っているか。**自分で呼ぶ** か **本物の見張り役に任せている** か。 */
  const passesGuard = (body) => GUARD_CALLS.test(body) || !!(HELPER_CALL && HELPER_CALL.test(body));
  // 🚨 読み込みの門を通している関数(guardLotSave など)。**中身まで見て** 決める。
  const loadedHelpers = loadedHelperNames(src);
  const LOADED_HELPER_CALL = callRe(loadedHelpers);
  /** 関所が読み込みの門を通っているか。**自分で呼ぶ** か **本物の門役に任せている** か。 */
  const passesLoaded = (body) => hasGenuineLoadedCall(body) || !!(LOADED_HELPER_CALL && LOADED_HELPER_CALL.test(body));
  const findings = [];
  const exposure = [];
  const add = (id, level, line, why, code) =>
    findings.push({ id, level, file, line, why, code: String(code || '').trim().slice(0, 160) });

  // --- ① 保存の関所 --------------------------------------------------------
  //   `const saveData = async (col, id, rawData) => {` のような「ロット保存の入口」。
  const chokeRe = /const\s+(saveData|saveLot|saveDoc)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  const chokes = [];
  let m;
  while ((m = chokeRe.exec(src))) {
    const openIdx = src.indexOf('{', m.index + m[0].length - 1);
    const body = blockFrom(src, openIdx);
    chokes.push({ name: m[1], line: lineOf(src, m.index), body, start: openIdx, end: openIdx + body.length });
  }
  // 行番号 → その行の先頭の文字位置(「この行は関所の中か」を位置で判定するため。
  // ⚠文字列の一致で判定すると、関所が1行で書かれた時に外だと誤判定する)
  const lineStart = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1);
  //   ⚠行の先頭ではなく **その書き込みが在る位置** で判定する。
  //     関所が1行で書かれていると、行頭は関所の `{` より手前になり「外」と誤判定する。
  const insideAnyChoke = (lineIdx0, colInLine = 0) => {
    const at = (lineStart[lineIdx0] ?? 0) + colInLine;
    return chokes.some((c) => at >= c.start && at < c.end);
  };
  if (!chokes.length) {
    add('WTG-000', 'error', 0, '保存の関所(saveData)が見つからない。この見張りが当てにならない形になっている', '');
  }
  for (const c of chokes) {
    // ロットを扱う関所だけを対象にする(連絡やお知らせ専用の保存関数は対象外)
    // 🚨 見張りを別の関数へ任せている関所(部品検査の guardLotSave)も **ロットを扱う関所**。
    //   ここを入れないと、その関所は検査対象から丸ごと外れる(実測: 門を消しても緑だった)。
    const handlesLots = /['"]lots['"]/.test(c.body)
      || /col\s*===\s*['"]lots['"]/.test(c.body)
      || !!(LOT_HELPER_CALL && LOT_HELPER_CALL.test(c.body));
    c.handlesLots = handlesLots;   // ①-b(読み込みの門)でも同じ判定を使う
    if (!handlesLots) continue;
    if (!passesGuard(c.body)) {
      add('WTG-001', 'error', c.line,
        `${c.name}() が workTimeGuard を通っていない。ここが通っていない限り、下に並ぶ保存は全部そのまま消しにいける`,
        `const ${c.name} = async (col, id, rawData) => { ... }`);
      continue;
    }
    // 通っていても「保管庫へ渡した後」に呼んでいたら意味が無い
    // ⚠見張り役に任せている時は、その **呼び出しの位置** が「見張りを通した所」。
    const giSelf = c.body.search(GUARD_CALLS);
    const giHelper = HELPER_CALL ? c.body.search(HELPER_CALL) : -1;
    const cands = [giSelf, giHelper].filter((n) => n >= 0);
    const gi = cands.length ? Math.min(...cands) : -1;
    const si = c.body.search(/\.save\s*\(/);
    if (si >= 0 && gi > si) {
      add('WTG-002', 'error', c.line, `${c.name}() は保存した後で見張りを呼んでいる(手遅れ)。保管庫へ渡す前に呼ぶこと`, '');
    }
  }

  // 🚨🚨 見張り役(guardLotSave など)が **居るのに、どの関所からも呼ばれていない**。
  //   これは「門を作ったのに、誰も通していない」状態。上の per-関所 の判定は
  //   「その関所がロットを扱っている」と分かった時しか動かないので、
  //   呼び出しの1行を消すと **関所がロットを扱っている事すら見えなくなって黙る**。
  //   実測(2026-08-30 部品検査): saveData から `guardLotSave(col, id, data);` を消すと
  //   この一手が無い限り 見張りは **緑のまま** だった。門が外れたのに気づけない。
  if (helpers.length && chokes.length && !chokes.some((c) => passesGuard(c.body))) {
    // ⚠人に見せる名前は「見張りも呼び / ロットも名指ししている」物だけに絞る。
    //   大きな画面部品まで並べると、どれが門なのか分からなくなる。
    const named = helpers.filter((h) => lotHelpers.includes(h));
    add('WTG-001', 'error', chokes[0].line,
      `見張り役(${(named.length ? named : helpers).join(' / ')})がこのファイルに在るのに、`
      + `保存の関所(${chokes.map((c) => c.name).join(' / ')})が1つも呼んでいない。`
      + '門を作っただけで、誰も通していない状態', '');
  }

  // --- ①-b 読み込みの門(読み込みが終わる前に保存させない) -------------------
  //   🚨 2026-09-01 実測: 関所から assertLotsLoaded(…) の1行を消しても
  //     見張り4本が全部 緑だった。ここが「誰も見ていなかった約束」。
  //   ⚠ 行が在るかだけを見ない。旗が本物か・旗が下りるか・保存より前か まで見る。
  const loadedCalls = [];
  {
    const re = /(?<![\w$.])assertLotsLoaded\s*\(/g;
    let mm;
    while ((mm = re.exec(src))) {
      const arg = firstArgOf(src, mm.index + mm[0].length);
      loadedCalls.push({ at: mm.index, line: lineOf(src, mm.index), arg, ...classifyLoadedArg(arg) });
    }
  }
  // ② 旗が本物か。true の直書き・`|| true` は「門を素通しにする壊し方」そのもの。
  for (const lc of loadedCalls) {
    if (lc.ok) continue;
    add('WTG-004', 'error', lc.line,
      `🚨 読み込みの門 assertLotsLoaded(…) に本物の旗を渡していない: ${lc.why}。`
      + '読めていない手元(空)のまま保存が通り、サーバの検査記録をそのまま消す(2026-08-17 の形)',
      lines[lc.line - 1] || '');
  }
  // ③ 旗が下りる道が在るか。一度も false にならない旗は、門ではなく飾り。
  for (const lc of loadedCalls) {
    if (!lc.ok) continue;
    if (flagCanFall(src, lc.expr)) continue;
    add('WTG-004', 'error', lc.line,
      `🚨 読み込みの門に渡している旗 \`${lc.expr}\` が、このファイルのどこでも下りない`
      + '（false になる所も set…(false) も無い）。門は在るが永久に開いている',
      lines[lc.line - 1] || '');
  }
  // ① 関所が門を通っているか(別の関数に任せていても1段は追う)
  for (const c of chokes) {
    if (!c.handlesLots) continue;
    if (!passesLoaded(c.body)) {
      add('WTG-003', 'error', c.line,
        `${c.name}() が「ロットを読み込めたか」を1つも見ていない。読み込みが終わる前(手元が空)のまま`
        + '保存すると、サーバの検査記録を空で上書きする(2026-08-17 の事故そのもの)。'
        + '保存より前に assertLotsLoaded(読めた旗) を通すこと',
        `const ${c.name} = async (col, id, rawData) => { ... }`);
      continue;
    }
    // ④ 保存より前で呼んでいるか。後ろで呼んでも手遅れ。
    const liSelf = (() => {
      const re = /(?<![\w$.])assertLotsLoaded\s*\(/g;
      let mm;
      while ((mm = re.exec(c.body))) {
        if (classifyLoadedArg(firstArgOf(c.body, mm.index + mm[0].length)).ok) return mm.index;
      }
      return -1;
    })();
    const liHelper = LOADED_HELPER_CALL ? c.body.search(LOADED_HELPER_CALL) : -1;
    const cands2 = [liSelf, liHelper].filter((n) => n >= 0);
    const li = cands2.length ? Math.min(...cands2) : -1;
    const si2 = c.body.search(/\.save\s*\(/);
    if (si2 >= 0 && li > si2) {
      add('WTG-005', 'error', c.line,
        `${c.name}() は保管庫へ書いた後で読み込みの門を呼んでいる(手遅れ)。書く前に呼ぶこと`, '');
    }
  }
  // 🚨🚨 門の仕掛けはファイルに在るのに、**どの関所も通していない**。
  //   ⚠これが無いと「呼び出しの1行だけ消す」壊し方で黙る。関所がロットを扱っている事は
  //     その呼び出しから分かっている場合があり(部品検査の guardLotSave)、消すと
  //     関所ごと検査対象から外れてしまう。
  if ((loadedHelpers.length || loadedCalls.some((lc) => lc.ok)) && chokes.length
      && !chokes.some((c) => passesLoaded(c.body))) {
    add('WTG-003', 'error', chokes[0].line,
      `読み込みの門(${loadedHelpers.length ? loadedHelpers.join(' / ') : 'assertLotsLoaded'})がこのファイルに在るのに、`
      + `保存の関所(${chokes.map((c) => c.name).join(' / ')})が1つも通していない。`
      + '門を作っただけで、誰も通していない状態', '');
  }

  // --- ② 関所を迂回して保管庫へ直接書いている所 ----------------------------
  //   例: restoreAllFromBackup が DATA(db).save(APP_DATA_ID, col, docId, ...) を直に呼ぶ。
  //   col が変数でも、その近くで 'lots' を扱っていれば対象になりうる。
  //
  // 🚨🚨【黙らせない・根拠つきで通す】(2026-08-31)
  //   復元(restoreAllFromBackup)の「ロット以外を直に書く行」は、**col が変数** で、
  //   lots は先に関所(saveData)を通して continue し、直前に
  //   `if (col === 'lots') throw …` の番線が張ってある = この行にロットは来ない。
  //   ⚠名前や一覧表(allowlist)で通さない。**その番線が実コードに在る事を毎回読んで**通し、
  //     何を根拠に通したかを必ず出力する。番線を消せば即 ❌ に戻る。
  //   ⚠'lots' の直書き(.save(ns, 'lots', …))は番線が在っても絶対に通さない。
  //   ⚠番線と書き込みの間で col を入れ替えていたら通さない(番線が守っていない)。
  //
  // 🚨🚨【あら探しで実測・見張りが緩んでいた】(2026-08-31)
  //   手前を **文字数(1200文字)だけ** で見ていたので、番線の **支配が届かない所** の
  //   直接書き込みまで緑で通っていた。実測で次の2形とも通過した:
  //     (a) 番線の後に **別の関数** を置く
  //         const rawSave = async (col, id, data) => { await DATA(db).save(ns, col, id, data); };
  //     (b) 番線の後に **別のループ** を置く
  //         for (const [col, arr] of extraCols) { await DATA(db).save(ns, col, raw.id, raw); }
  //   どちらの col も 番線が見た col とは **別物**。見張りを緩めたまま出すのが一番危ない。
  //   → 通す条件を2つに増やした:
  //     ① 番線と書き込みが **同じ最内関数本体** に居る事(波括弧を歩いて確かめる。
  //        間に `=>` や `function(…)` の境界が開いていたら通さない)
  //     ② 番線と書き込みの間で colVar が **束縛し直されていない** 事
  //        (代入 / const・let・var / 分割代入 / for の束縛 / 引数 / catch のどれも「別物」)
  //
  // 🚨🚨【2回目のあら探しで実測・まだ緩かった】(2026-09-01)
  //   ①②を入れた後の見張りに、次の3形を食わせたら **3形とも緑で通った**:
  //     (c) 番線が if の枝の中   `if (strict) { if (col === 'lots') throw …; }`
  //         → strict が偽なら ロットはそのまま下の直接書き込みへ届く
  //     (d) 番線を try が握り潰す `try { if (col === 'lots') throw …; } catch (e) {}`
  //         → 番線は在るのに 1件も止まらない
  //     (e) 文字列の中の番線     `const memo = "if (col === 'lots') throw …";`
  //         → 動かない文字を根拠に通していた
  //   「同じ関数に在る」だけでは足りない。**同じ流れ(この書き込みを必ず通る道)に居る事**が要る。
  //   → 通す条件を さらに3つ足した:
  //     ③ 番線が、書き込みを囲む波括弧の **どれかの中に直に** 居る事
  //        (=書き込みへ行くには必ずその番線を踏む。枝の中・try の中は通さない)
  //     ④ 番線が **文字列の中でない** 事
  //     ⑤ 通せなかった時は「どんな番線を、なぜ数えなかったか」を人に言う
  const bypassPassed = [];
  /**
   * その位置を囲む **一番内側の関数の本体** の `{` の位置(無ければ -1 = 一番外側)。
   * ⚠ if / for / while / switch / catch / do の波括弧は「同じ関数の中」なので飛ばす。
   *   `=>` や `名前(…)` の波括弧に当たった所で止める = そこが関数の境界。
   */
  const enclosingFunctionOpen = (at) => {
    let depth = 0;
    for (let i = at; i >= 0; i--) {
      const c = src[i];
      if (c === '}') { depth++; continue; }
      if (c !== '{') continue;
      if (depth > 0) { depth--; continue; }
      // 深さ0の `{` = この位置を囲むブロックの開き。関数の本体かどうかを直前の形で見る。
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      if (k >= 1 && src[k] === '>' && src[k - 1] === '=') return i;     // … => {
      if (k >= 0 && src[k] === ')') {
        let d = 0, j = k;
        for (; j >= 0; j--) {
          if (src[j] === ')') d++;
          else if (src[j] === '(') { d--; if (d === 0) break; }
        }
        let p = j - 1;
        while (p >= 0 && /\s/.test(src[p])) p--;
        let e = p;
        while (e >= 0 && /[\w$]/.test(src[e])) e--;
        const word = src.slice(e + 1, p + 1);
        if (!/^(if|for|while|switch|catch|do)$/.test(word)) return i;   // function / メソッド / 名前付き
      }
      // オブジェクトリテラルや if/for/try の波括弧 → まだ関数の境界ではない。外側へ続ける。
    }
    return -1;
  };
  /** その位置を囲む **一番内側の波括弧** の `{` の位置。関数でもブロックでも区別しない。無ければ -1。 */
  const innerBlockOpen = (at) => {
    let depth = 0;
    for (let i = at; i >= 0; i--) {
      const c = src[i];
      if (c === '}') { depth++; continue; }
      if (c !== '{') continue;
      if (depth > 0) { depth--; continue; }
      return i;
    }
    return -1;
  };
  /**
   * 書き込みを囲む波括弧の連なり(内側 → 外側。最後の -1 = ファイルの直下)。
   * ⚠番線がこの **どれかの中に直に** 居る時だけ「その書き込みへ行くには必ず番線を踏む」と言える。
   *   if の枝の中や try の中の番線は ここに入らない = 支配していない。
   */
  const blockChain = (at) => {
    const chain = [];
    for (let cur = at; ;) {
      const o = innerBlockOpen(cur);
      if (o < 0) break;
      chain.push(o);
      cur = o - 1;
    }
    chain.push(-1);
    return chain;
  };
  /**
   * その位置が **文字列の中** か(同じ行で引用符が閉じていない)。
   * ⚠動かない文字を「番線が在る」の根拠にしない為。コメントは既に stripComments で消えている。
   */
  const insideStringAt = (at) => {
    const head = src.slice(src.lastIndexOf('\n', at - 1) + 1, at);
    const odd = (q) => {
      let n = 0;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === '\\') { i++; continue; }
        if (head[i] === q) n++;
      }
      return n % 2 === 1;
    };
    return odd("'") || odd('"') || odd('`');
  };
  /** 番線と書き込みの間で colVar が束縛し直されていれば、その理由を返す(番線が守っていない)。 */
  const rebindsBetween = (between, colVar) => {
    const V = `(?<![.\\w$])${colVar}(?![\\w$])`;
    const cases = [
      [new RegExp(`${V}\\s*=(?!=)`), '代入で入れ替えている'],
      [new RegExp(`(?<![.\\w$])(?:const|let|var)\\s+${colVar}(?![\\w$])`), '同じ名前で宣言し直している'],
      [new RegExp(`(?<![.\\w$])(?:const|let|var)\\s*[[{][^=;]{0,300}?${V}`), '分割代入(for の束縛を含む)で束縛し直している'],
      [new RegExp(`(?<![.\\w$])function[\\w\\s$]*\\([^)]{0,300}?${V}`), '関数の引数で束縛し直している'],
      [new RegExp(`\\([^()]{0,300}?${V}[^()]{0,300}?\\)\\s*=>`), '別の関数の引数で束縛し直している'],
      [new RegExp(`${V}\\s*=>`), '別の関数の引数で束縛し直している'],
      [new RegExp(`(?<![.\\w$])catch\\s*\\([^)]{0,120}?${V}`), 'catch の引数で束縛し直している'],
    ];
    for (const [re, why] of cases) if (re.test(between)) return why;
    return null;
  };
  /** @returns {{ok:true,line:number,code:string}|{ok:false,why:string}} */
  const lotsRejectBefore = (writeAt, colVar) => {
    // ① 書き込みを囲む一番内側の関数本体。番線はこの中に無ければ「支配が届かない」。
    const fnAt = enclosingFunctionOpen(writeAt);
    const from = fnAt >= 0 ? fnAt : 0;
    // ③ 書き込みを囲む波括弧の連なり。番線はこのどれかの中に直に居なければ「同じ流れ」ではない。
    const chain = new Set(blockChain(writeAt));
    const win = src.slice(from, writeAt);
    const re = new RegExp(`if\\s*\\(\\s*${colVar}\\s*===\\s*['"]lots['"]\\s*\\)\\s*throw`, 'g');
    let g = null, mm, skipped = '';
    while ((mm = re.exec(win))) {
      const at = from + mm.index;
      // 同じ最内関数本体に居る番線だけを採る(間に別の関数が開いていたら別物)。
      if (enclosingFunctionOpen(at) !== fnAt) { skipped = '別の関数の中に在った'; continue; }
      // if の枝の中 / try の中の番線は、この書き込みへ行く道を塞いでいない。
      if (!chain.has(innerBlockOpen(at))) { skipped = 'if や try の枝の中で、この書き込みを必ず通る道に無かった'; continue; }
      if (insideStringAt(at)) { skipped = '文字列の中で、動かない字だった'; continue; }
      g = mm;                                              // 一番近い(最後の)番線を採る
    }
    if (!g) return { ok: false, why: `${colVar} を止める番線が この書き込みと同じ流れに無い${skipped ? `。見つけた番線は ${skipped}` : ''}` };
    // ② 番線の後で col を束縛し直していたら、番線はこの書き込みを守っていない。
    const between = win.slice(g.index + g[0].length);
    const rebind = rebindsBetween(between, colVar);
    if (rebind) return { ok: false, why: `番線の後で ${colVar} を${rebind}` };
    const gAt = from + g.index;
    return { ok: true, line: lineOf(src, gAt), code: (src.split('\n')[lineOf(src, gAt) - 1] || '').trim().slice(0, 160) };
  };
  lines.forEach((ln, i) => {
    const direct = ln.match(/\.save\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(?:['"]lots['"]|col|colName|collection)\s*,/);
    if (!direct) return;
    // 関所の中の書き込みは迂回ではない(関所そのものの是非は WTG-001 が言う。
    // ⚠二重に出すと「直す所」が水増しされ、本当の迂回が埋もれる)
    if (insideAnyChoke(i, direct.index)) return;
    // col が **変数** の時だけ、番線(if (col === 'lots') throw)を読む。'lots' の直書きは対象外。
    const colVar = (direct[0].match(/,\s*(col|colName|collection)\s*,$/) || [])[1] || null;
    let why = '';
    if (colVar) {
      const guard = lotsRejectBefore((lineStart[i] ?? 0) + direct.index, colVar);
      if (guard.ok) {
        bypassPassed.push({ file, line: i + 1, code: ln.trim().slice(0, 160), guardLine: guard.line, guardCode: guard.code });
        return;
      }
      why = guard.why ? `（${guard.why}）` : '';
    }
    add('WTG-010', 'error', i + 1,
      `保存の関所を通さずに保管庫へロットを直接書いている。容量チェックも見張りも効かない${why}`, ln);
  });

  // --- ①-c 🚨🚨 門が投げた物を **握り潰していないか** ------------------------
  //   (2026-09-02 あら探しで実測。今回いちばん危なかった1件)
  //
  //   実測(製品・最終・部品の3アプリとも): 保存の関所の門を
  //       try { assertLotsLoaded(…); } catch (e) { console.warn(e); }
  //   と **囲むだけ** で、この見張りは 0(緑)。しかも
  //   「読み込みの門 ✅ 通っている」と印字していた。中身の見張り(assertSafeLotSave)も同じ。
  //   最終検査は 既に在る catch から **最後の `throw e;` を1行消す** だけで緑だった。
  //
  //   根っこ: この見張りは「門を **呼んでいるか**」しか見ていなかった。
  //     門は **投げる事でしか** 保存を止められない。投げた物が saveData の外へ出なければ、
  //     呼び出し側は「保存できた」と受け取って画面を閉じる = 2026-08-17 と同じ結末
  //     (作業時間が丸ごと消えた事故)。「保存が止まって面倒だから とりあえず包んだ」は
  //     現場で一番起きる直し方なので、ここを見ない見張りは飾りでしかない。
  //
  //   ⚠⚠ **正しい形の try/catch まで赤にしない。**
  //     正しい形 = 投げてから catch で人に札を出し、**最後に再送出する**。
  //     最終検査 src/App.firebase.jsx の関所 と 部品検査の guardLotSave が実際にこの形で、
  //     ここを一律に赤にすると 現場に出ている正しいコードを直させる事になる。
  //   ⚠ `throw` の字が在るかでは見ない。`if (x) throw e;` は偽の時に飲む。
  //     **catch の最後の文が throw** である事だけを認め、途中に return が在れば赤。
  //   ⚠ 見るのは **関所の中** と **関所が実際に呼んでいる見張り役の中** だけ。
  //     「本物の見張りを中に含む関数」で数えると、関所そのものや大きな画面部品まで
  //     名前に入って、関係のない try/catch を何十件も赤にする(実測で25件出た)。

  /** `(` から対応する `)` の次の位置。文字列は飛ばす。 */
  const parenEnd = (openIdx) => {
    let d = 0, q = null;
    for (let i = openIdx; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) return i + 1; }
    }
    return src.length;
  };

  /**
   * 波括弧の中身を「深さ0の文」に割る(文字列は飛ばす)。
   * ⚠文の切れ目は **`;` と、深さ0へ戻る `}`** だけ。`)` で切ると
   *   `const note = (res) => { … };` が2つに割れて、判定が狂う。
   */
  const topStatements = (blockText) => {
    const inner = blockText.slice(1, -1);
    const out = [];
    let depth = 0, q = null, cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (q) { cur += c; if (c === '\\') { cur += inner[i + 1] || ''; i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
      if (c === ')' || c === ']') { depth--; cur += c; continue; }
      if (c === '}') { depth--; cur += c; if (depth <= 0) { depth = 0; push(); } continue; }
      if (c === ';' && depth === 0) { cur += ''; push(); continue; }
      cur += c;
    }
    push();
    // ⚠ `if (…) { … } else { … }` は1つの文として扱う。
    //   でないと人に見せる文言が「else で終わっている」になり、読んだ人が意味を取り違える。
    for (let i = out.length - 1; i > 0; i--) {
      if (/^else(?![\w$])/.test(out[i])) { out[i - 1] = `${out[i - 1]} ${out[i]}`; out.splice(i, 1); }
    }
    return out;
  };

  /** その `try {` に付いている catch の中身(無ければ null = finally だけ ＝ 投げは外へ出る)。 */
  const catchOfTry = (tryOpenIdx) => {
    const body = blockFrom(src, tryOpenIdx);
    let i = tryOpenIdx + body.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (!/^catch(?![\w$])/.test(src.slice(i, i + 6))) return null;
    i += 5;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '(') { i = parenEnd(i); while (i < src.length && /\s/.test(src[i])) i++; }
    if (src[i] !== '{') return null;
    return { open: i, body: blockFrom(src, i) };
  };

  /**
   * その catch が **投げ返しているか**。
   * ⚠「throw の字が在るか」で見ない。`if (x) throw e;` は偽の時に飲む。
   *   認めるのは「**最後の文が throw**」だけ(＝どの道を通っても最後に投げ返す)。
   * ⚠途中に return が在れば、その先の throw は踏まれない = 飲んでいる。
   */
  const catchRethrows = (catchBlock) => {
    const st = topStatements(catchBlock.body);
    if (!st.length) return { ok: false, why: 'catch の中が空で、何もせず飲んでいる' };
    const ret = st.find((s) => /^return(?![\w$])/.test(s));
    if (ret) return { ok: false, why: `catch の中で \`${ret.slice(0, 40)}\` して飲んでいる` };
    const last = st[st.length - 1];
    if (!/^throw(?![\w$])/.test(last)) {
      return { ok: false, why: `catch の最後が \`${last.replace(/\s+/g, ' ').slice(0, 48)}\` で、投げ返していない` };
    }
    return { ok: true };
  };

  // ファイル中の `try {` を全部拾っておく(内側/外側の入れ子を歩く為)。
  const tryBlocks = [];
  {
    const re = /(?<![\w$.])try\s*\{/g;
    let t;
    while ((t = re.exec(src))) {
      const open = src.indexOf('{', t.index);
      if (open < 0) continue;
      const body = blockFrom(src, open);
      tryBlocks.push({ kw: t.index, open, end: open + body.length });
    }
  }
  /**
   * その位置を囲む try を **内側から外側へ** 全部見て、
   * 1つでも投げ返さない catch が在れば その理由を返す(＝投げは外へ出ない)。
   * ⚠内側が正しく投げ返していても、外側が飲んでいれば結果は同じ。だから全部見る。
   * @param fromIdx この位置より前に始まる try は「その関数の外」なので見ない
   */
  const swallowingTryAround = (at, fromIdx) => {
    const around = tryBlocks
      .filter((t) => at >= t.open && at < t.end && t.kw >= fromIdx)
      .sort((a, b) => b.open - a.open);
    for (const t of around) {
      const cc = catchOfTry(t.open);
      if (!cc) continue;                       // finally だけ ＝ 投げはそのまま外へ出る
      const r = catchRethrows(cc);
      if (!r.ok) return { line: lineOf(src, t.kw), why: r.why };
    }
    return null;
  };

  /** `const 名前 = (…) => { … }` の本体の範囲。見張り役の中まで追う為。 */
  const arrowBodyRange = (name) => {
    const re = new RegExp(`(?<![\\w$.])const\\s+${escRe(name)}\\s*=\\s*(?:async\\s*)?\\(`, 'g');
    let mm2;
    while ((mm2 = re.exec(src))) {
      let i = parenEnd(mm2.index + mm2[0].length - 1);
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.slice(i, i + 2) !== '=>') continue;
      i += 2;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== '{') continue;
      const body = blockFrom(src, i);
      return { open: i, end: i + body.length };
    }
    return null;
  };

  // 🚨 見張り役として **中まで追う** のは「ロットを扱う関所が実際に呼んでいる物」だけ。
  //   helperNamesWhere は「本物の見張りを中に含む関数」を全部返すので、関所そのものや
  //   大きな画面部品も混じる。そのまま使うと関係のない try/catch を何十件も赤にする。
  const chokeNameSet = new Set(chokes.map((c) => c.name));
  const delegates = [...new Set([...helpers, ...loadedHelpers])].filter((h) => {
    if (chokeNameSet.has(h)) return false;
    const re = new RegExp(`(?<![\\w$.])${escRe(h)}\\s*\\(`);
    return chokes.some((c) => c.handlesLots && re.test(c.body));
  });
  const GATE_NAMES = ['assertLotsLoaded', 'assertSafeLotSave', 'wouldLoseWorkTime', ...delegates];
  const GATE_CALL_SRC = `(?<![\\w$.])(${GATE_NAMES.map(escRe).join('|')})\\s*\\(`;
  const swallowAt = [];   // 握り潰しが見つかった位置(関所の ✅/❌ 表示にも使う)
  /** ある関数本体 [from,to) の中の門の呼び出しが、握り潰されていないかを見る。 */
  const scanSwallow = (whereName, from, to) => {
    const re = new RegExp(GATE_CALL_SRC, 'g');
    const region = src.slice(from, to);
    let mm2;
    while ((mm2 = re.exec(region))) {
      const at = from + mm2.index;
      const sw = swallowingTryAround(at, from);
      if (!sw) continue;
      const li = lineOf(src, at);
      swallowAt.push(at);
      add('WTG-006', 'error', li,
        `🚨 ${whereName} の中の ${mm2[1]}(…) を try が囲んでいて、その catch(${sw.line}行目の try)が投げ返していない`
        + `（${sw.why}）。門は投げる事でしか保存を止められないので、この形だと`
        + '**門は在るのに1件も止まらない**。呼び出し側は「保存できた」と受け取って画面を閉じ、'
        + '入力と検査記録がそのまま消える(2026-08-17 の事故と同じ結末)。'
        + 'catch で人に札を出すのは正しい。**最後に必ず投げ返す**こと',
        lines[li - 1] || '');
    }
  };
  for (const c of chokes) {
    if (!c.handlesLots) continue;
    scanSwallow(`関所 ${c.name}()`, c.start, c.end);
  }
  for (const h of delegates) {
    const r = arrowBodyRange(h);
    if (!r) continue;
    scanSwallow(`見張り役 ${h}()`, r.open, r.end);
  }

  // --- ①-d 🚨 await を外して「投げが呼び出し側へ届かない」形 -----------------
  //   実測(2026-09-01): 復元の `await saveData('lots', …)` から **await だけ外す** と、
  //   関所が止めても その投げは その場の catch へ届かない(Promise が拒否されるだけ)。
  //   ＝「止めた件数」が人に1件も出ないまま、復元が終わったように見える。
  //   ⚠見るのは **ロットの保存** で、しかも **try で受けている所** だけ。
  //     ここを広げると お知らせ・型式・作業者の保存まで赤になり、直せない赤が増える
  //     (実測: 広げた形で3アプリ合わせて10件の的外れな赤が出た)。
  //   ⚠他の呼び出しの引数に渡している形(`await settleSaveBriefly(saveData(…))`)は
  //     受け取った側が待つので対象外。
  const chokeNames = [...new Set(chokes.filter((c) => c.handlesLots).map((c) => c.name))];
  if (chokeNames.length) {
    const re = new RegExp(`(?<![\\w$.])(${chokeNames.map(escRe).join('|')})\\s*\\(`, 'g');
    let mm2;
    while ((mm2 = re.exec(src))) {
      const at = mm2.index;
      if (chokes.some((c) => at >= c.start - 200 && at < c.end)) continue;   // 定義そのもの/関所の中
      const argHead = src.slice(at + mm2[0].length, at + mm2[0].length + 24);
      if (!/^\s*(['"]lots['"]|col|colName|collection)\s*,/.test(argHead)) continue;  // ロットの保存だけ
      // 失敗を受ける気が在る所(catch を持つ try の中)だけを見る。
      const inTry = tryBlocks.filter((t) => at >= t.open && at < t.end).some((t) => !!catchOfTry(t.open));
      if (!inTry) continue;
      const head = src.slice(Math.max(0, at - 48), at).replace(/\s+$/, '');
      if (/(?:await|return|yield|void)$/.test(head)) continue;               // 待っている / 返している
      if (/[([,?:=&|]$/.test(head)) continue;                                // 他へ渡している
      const after = parenEnd(at + mm2[0].length - 1);
      if (/^\s*\.\s*(then|catch|finally)\b/.test(src.slice(after, after + 24))) continue;
      const li = lineOf(src, at);
      add('WTG-007', 'error', li,
        `🚨 try で受けているのに \`${mm2[1]}('lots'…)\` を await していない。`
        + '関所がその保存を止めても、投げは この catch へ届かない(約束が拒否されるだけ)。'
        + '＝「何件止めた／落ちた」が人に1件も出ないまま先へ進む。'
        + 'await を付けるか、この try で受けない形にすること',
        lines[li - 1] || '');
    }
  }

  // --- ③ 空のマップを ロットの payload に入れている所 -----------------------
  //   `tasks: {}` は merge:true でも **既存の tasks を丸ごと消す**。
  //   新規作成のつもりでも、その id の doc が既に在れば全部消える。
  //
  //   ⚠⚠ 2種類ある。両方拾う。
  //     WTG-020 直書き           : `tasks: {}`
  //     WTG-021 三項で空に落ちる : `tasks: editingLot ? editingLot.tasks : {}`
  //   ⚠⚠ `(?<![.\w$])` は必須。これが無いと `editingLot.tasks : {}` の
  //     **プロパティ参照**まで「キーの直書き」として数え、指摘の文言が嘘になる。
  //   ⚠⚠ 囲んでいるオブジェクトが「ロットの doc」でなければ出さない。
  //     手元の作業用の変数(_skip など)を指して「本番が消える」と言うのは誤検出。
  const scanEmpty = (re, id, why) => {
    const r = new RegExp(re.source, 'g');
    let mm;
    while ((mm = r.exec(src))) {
      const obj = enclosingObject(src, mm.index);
      if (!LOT_DOC_FIELDS.test(obj)) continue;      // ロットの doc ではない = 対象外
      const li = lineOf(src, mm.index);
      add(id, 'error', li, why, lines[li - 1]);
    }
  };
  scanEmpty(/(?<![.\w$])tasks\s*:\s*\{\s*\}/, 'WTG-020',
    '🚨 ロットの payload に tasks の空マップを直書きしている。merge:true でも **サーバの tasks が丸ごと空になる**');
  scanEmpty(/(?<![.\w$])tasks\s*:\s*[^,;{}]*\?[^;{}]*?:\s*\{\s*\}/, 'WTG-021',
    '🚨 条件が外れると tasks が空マップになる。その doc が既に在れば **時間取りが丸ごと消える**。空マップを書くのではなく **キーごと送らない** こと');

  // --- ④ 空マップを素通しする真偽判定 --------------------------------------
  //   `if (lot.tasks) update.tasks = lot.tasks;`
  //   JS では `{}` は真。空でも「在る」と判断して、そのまま空を送ってしまう。
  lines.forEach((ln, i) => {
    const mm = ln.match(/if\s*\(\s*([\w.[\]'"$]+)\.tasks\s*\)\s*[^;]*\.tasks\s*=/);
    if (!mm) return;
    add('WTG-030', 'error', i + 1,
      `🚨 \`if (${mm[1]}.tasks)\` は **空のマップ {} でも真**。空をそのまま送り、サーバの tasks を消す。件数(Object.keys(...).length)で見ること`, ln);
  });

  // --- ⑤ tasks のマップ全体を送っている所(=いま危ない所の一覧) -------------
  //   部分更新(1鍵だけ)は merge:true で安全なので、全体を送っている形だけ数える。
  //   ⚠⚠ **1行だけを見て判断しない。** `await onSave({` と `tasks: newTasks,` が
  //     別の行に書いてある形(タッチアップ移動・完了確定 が まさにこれ)を取りこぼす。
  //     囲んでいるオブジェクトの **手前** に保存の呼び出しがあるかで見る。
  const WHOLE = /(?<![.\w$])tasks\s*:\s*(?:newTasks|finalTasks|cleanT_fi|cleanTasks|nt\b|tasks\b|p\.newTasks|\{\s*\.\.\.)|\{\s*tasks\s*\}|update\.tasks\s*=/g;
  const SAVER = /(saveData|onSave|onSaveOtherLot|onSaveLot|onSaveTasks|\.save)\s*\(\s*$/;
  const seenLine = new Set();
  let w;
  while ((w = WHOLE.exec(src))) {
    const li = lineOf(src, w.index);
    if (seenLine.has(li)) continue;
    // 囲んでいるオブジェクトの直前 120文字に保存の呼び出しがあるか(改行を潰して見る)
    let objStart = -1, depth = 0;
    for (let i = w.index; i >= 0; i--) {
      const c = src[i];
      if (c === '}') depth++;
      else if (c === '{') { if (depth === 0) { objStart = i; break; } depth--; }
    }
    const head = (objStart > 0 ? src.slice(Math.max(0, objStart - 120), objStart) : '').replace(/\s+/g, ' ');
    const sameLine = /(saveData|onSave|onSaveOtherLot|onSaveLot|onSaveTasks|\.save)\s*\(/.test(lines[li - 1] || '');
    if (!sameLine && !SAVER.test(head + ' ') && !/update\.tasks/.test(lines[li - 1] || '')) continue;
    seenLine.add(li);
    exposure.push({ file, line: li, code: (lines[li - 1] || '').trim().slice(0, 160) });
  }
  exposure.sort((a, b) => a.line - b.line);

  // ⚠ guarded は「自分で見張りを呼ぶ」だけでなく「本物の見張り役に任せている」も ✅ にする。
  //   ここを GUARD_CALLS だけにすると、部品検査の関所が **通っているのに ❌ と表示** され、
  //   人が「この見張りは当てにならない」と思って見なくなる。
  return {
    file, findings, exposure,
    guardHelpers: helpers,
    loadedHelpers,
    // 根拠つきで通した「関所の外の直接書き込み」。⚠黙って通さず、必ず人にも見せる。
    bypassPassed,
    chokes: chokes.map((c) => ({
      name: c.name, line: c.line, guarded: passesGuard(c.body),
      // 🚨「読み込みが終わる前に保存しない」を、この関所が実際に見ているか。
      loadedGuarded: passesLoaded(c.body),
      // ⚠ロットを扱わない保存関数は判定の対象外。人に見せる時に ❌ と紛らわしいので区別する。
      handlesLots: !!c.handlesLots,
      // 🚨 門を呼んでいても、その投げを try/catch が握り潰していれば「通っている」ではない。
      swallowed: swallowAt.some((p) => p >= c.start && p < c.end)
        || [...new Set([...helpers, ...loadedHelpers])].some((h) => {
          if (!new RegExp(`(?<![\\w$.])${escRe(h)}\\s*\\(`).test(c.body)) return false;
          const r = arrowBodyRange(h);
          return !!r && swallowAt.some((p) => p >= r.open && p < r.end);
        }),
    })),
  };
};

// ---------------------------------------------------------------------------
// 見張り自身の試験
// ⚠⚠ 「直す前のコードなら落ちる」「直した後のコードなら通る」を両方確かめる。
//   片方だけだと、何も検出しない空っぽの見張りでも合格してしまう。
// ---------------------------------------------------------------------------
const BEFORE_FIX = `
const saveData = async (col, id, rawData) => {
    let data = withDeletions(rawData);
    if (col === 'lots') { data = await dehydrateLotUpdate(id, data, w); }
    await DATA(db).save(APP_DATA_ID, col, id, { ...cleanUndefined(data), updatedAt: DATA_SERVER_NOW });
};
const update = {};
if (lot.tasks) update.tasks = lot.tasks;
await saveData('lots', lot.id, update);
await onSave({ location: 'zone_touchup', status: 'paused', tasks: newTasks });
const lotData = { id, model, ...(existingLot ? {} : { tasks: {}, interruptions: [] }) };
await DATA(db).save(APP_DATA_ID, col, docId, { ...cleanUndefined(body), updatedAt: DATA_SERVER_NOW });
`;

// ⚠「読めた旗」の配線。直した後のコードには **必ず** これが在る。
//   (旗を立てる所・下ろす所・関所で見る所 の3つで1組)
const LOADED_WIRING = `
const lotsLoadedRef = useRef(false);
const onLotsError = () => { lotsLoadedRef.current = false; setLotsLoaded(false); };
const onLotsRows = (rows) => { lotsLoadedRef.current = true; setLotsLoaded(true); };
`;

const AFTER_FIX = LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
    let data = withDeletions(rawData);
    if (col === 'lots') {
        assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });
        assertSafeLotSave((rawLots || []).find(l => l.id === id) || null, data);
        data = await dehydrateLotUpdate(id, data, w);
    }
    await DATA(db).save(APP_DATA_ID, col, id, { ...cleanUndefined(data), updatedAt: DATA_SERVER_NOW });
};
const update = {};
if (Object.keys(lot.tasks || {}).length) update.tasks = lot.tasks;
await saveData('lots', lot.id, update);
await onSave({ location: 'zone_touchup', status: 'paused', tasks: newTasks });
const lotData = { id, model, ...(existingLot ? {} : { interruptions: [] }) };
await saveData('lots', docId, body);
`;

export const selftest = () => {
  let bad = 0;
  const say = (ok, what) => { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) bad++; };
  console.log('🧪 見張り自身の試験');

  const before = analyze(BEFORE_FIX, '(直す前)');
  const ids = new Set(before.findings.map((f) => f.id));
  say(ids.has('WTG-001'), '直す前: 関所が見張りを通っていない事を捕まえる');
  say(ids.has('WTG-010'), '直す前: 関所を迂回した直接書き込みを捕まえる');
  say(ids.has('WTG-020'), '直す前: tasks: {} の直書きを捕まえる');
  say(ids.has('WTG-030'), '直す前: if (lot.tasks) の素通しを捕まえる');
  say(before.exposure.length >= 2, `直す前: tasks 全体を送る所を一覧にする (${before.exposure.length}件)`);

  // 🚨🚨 2026-08-30 に足した所: 関所が見張りを **別の関数に任せている** 形(部品検査)。
  //   ⚠ここを見ないと、関所そのものが検査対象から外れる。
  //     実測: 部品検査の saveData から `guardLotSave(col, id, data);` を消しても緑のままだった。
  //   ⚠「名前を見て通す」だけにすると、中身の空の偽の見張りで素通りする。だから
  //     **本物は通し / 偽物は落ちる / 呼ぶのを消したら落ちる / 保存の後で呼んだら落ちる** を毎回確かめる。
  const DELEGATE_REAL = `
const guardLotSave = (col, id, data) => { if (col !== 'lots') return; assertSafeLotSave(before, data, { allow, onBlock: note }); };
const saveData = async (col, id, data) => { guardLotSave(col, id, data); await DATA(db).save(ns, col, id, data); };
`;
  const delegReal = analyze(DELEGATE_REAL, '(見張りを任せる・本物)');
  say(delegReal.findings.filter((f) => f.id === 'WTG-001').length === 0 && delegReal.chokes.every((c) => c.guarded),
    `負の対照: 見張りを別の関数(guardLotSave)に任せた関所は通す (実際 WTG-001 ${delegReal.findings.filter((f) => f.id === 'WTG-001').length}件)`);

  const delegFake = analyze(DELEGATE_REAL.replace('assertSafeLotSave(before, data, { allow, onBlock: note });', 'console.log("見張ったふり");'), '(見張りを任せる・偽物)');
  say(delegFake.findings.some((f) => f.id === 'WTG-001'),
    '🚨 任せた先が本物の見張りを呼んでいなければ落とす(中身の空の偽物では通さない)');

  const delegGone = analyze(DELEGATE_REAL.replace('guardLotSave(col, id, data); ', ''), '(任せる呼び出しを消した)');
  say(delegGone.findings.some((f) => f.id === 'WTG-001'),
    '🚨 関所から見張り役の呼び出しを **消したら** 落ちる(2026-08-17 の門が黙って外れるのを止める)');

  const delegLate = analyze(`
const guardLotSave = (col, id, data) => { if (col !== 'lots') return; assertSafeLotSave(before, data); };
const saveData = async (col, id, data) => { await DATA(db).save(ns, col, id, data); guardLotSave(col, id, data); };
`, '(保存した後で見張りを呼ぶ)');
  say(delegLate.findings.some((f) => f.id === 'WTG-002'),
    '🚨 任せた見張りを **保存した後** で呼んでいたら落とす(手遅れ)');

  // ═════════════════════════════════════════════════════════════════════════
  // 🚨🚨 読み込みの門(WTG-003 / 004 / 005) 2026-09-01
  // -------------------------------------------------------------------------
  // 実測: 保存の関所から assertLotsLoaded(…) の **1行を消しても** 見張り4本が
  //   全部 緑だった。ここは「わざと壊して赤になる」を4通り以上で毎回確かめる。
  // ═════════════════════════════════════════════════════════════════════════
  const has = (r, id) => r.findings.some((f) => f.id === id);
  const cnt = (r, id) => r.findings.filter((f) => f.id === id).length;

  const LOADED_OK = LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  if (col === 'lots') {
    assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });
    assertSafeLotSave(before, rawData, { onBlock: note });
  }
  await DATA(db).save(ns, col, id, rawData);
};
`;
  const okR = analyze(LOADED_OK, '(読み込みの門あり)');
  say(!has(okR, 'WTG-003') && !has(okR, 'WTG-004') && !has(okR, 'WTG-005') && okR.chokes.every((c) => c.loadedGuarded),
    `負の対照: 関所が読み込みの門を通っていれば通す (指摘 ${okR.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 壊し方 その1: その1行を消す ──────────────────────────────────────
  const brk1 = analyze(LOADED_OK.replace(/^.*assertLotsLoaded\(lotsLoadedRef\.current.*$\n/m, ''), '(門の1行を消した)');
  say(has(brk1, 'WTG-003'),
    '🚨 壊し方1: 関所から assertLotsLoaded(…) の1行を消したら ❌(4本の見張りが全部緑だった形)');

  // ── 壊し方 その2: 別の関数に任せて、その **呼び出しだけ** 消す ─────────
  //   ⚠この形は 関所の中に 'lots' の字が1つも無くなる。だから「関所がロットを扱っている」
  //     の判定ごと外れて、per-関所 の検査が黙る。**ファイル全体で見る一手** が要る。
  const DELEG_LOADED = LOADED_WIRING + `
const guardLotSave = (col, id, data) => {
  if (col !== 'lots') return;
  assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });
  assertSafeLotSave(before, data, { onBlock: note });
};
const saveData = async (col, id, data) => { guardLotSave(col, id, data); await DATA(db).save(ns, col, id, data); };
`;
  const delegOk = analyze(DELEG_LOADED, '(門を別関数に任せる・本物)');
  say(!has(delegOk, 'WTG-003') && !has(delegOk, 'WTG-004') && delegOk.chokes.every((c) => c.loadedGuarded),
    `負の対照: 門を別の関数(guardLotSave)に任せた関所も追えている (指摘 ${delegOk.findings.map((f) => f.id).join(',') || 'なし'})`);

  const brk2 = analyze(DELEG_LOADED.replace('guardLotSave(col, id, data); ', ''), '(任せる呼び出しだけ消した)');
  say(has(brk2, 'WTG-003'),
    '🚨 壊し方2: 別関数に任せた門の **呼び出しだけ** 消したら ❌');

  // ── 壊し方 その3: 別の関数へ移して、どこからも呼ばない ────────────────
  const brk3 = analyze(LOADED_OK.replace(/^.*assertLotsLoaded\(lotsLoadedRef\.current.*$\n/m, '')
    + `
const gateLots = (id) => { assertLotsLoaded(lotsLoadedRef.current, { onBlock: note }); };
`, '(門を別関数へ移して呼ばない)');
  say(has(brk3, 'WTG-003'),
    '🚨 壊し方3: 門を別の関数へ移して、どこからも呼んでいなければ ❌');

  // ── 壊し方 その4: 条件を常に真にして素通しさせる ─────────────────────
  const brk4a = analyze(LOADED_OK.replace('assertLotsLoaded(lotsLoadedRef.current,', 'assertLotsLoaded(true,'), '(旗に true を直書き)');
  say(has(brk4a, 'WTG-004') && has(brk4a, 'WTG-003'),
    `🚨 壊し方4a: assertLotsLoaded(true, …) は ❌ (${brk4a.findings.map((f) => f.id).join(',') || 'なし'})`);

  const brk4b = analyze(LOADED_OK.replace('assertLotsLoaded(lotsLoadedRef.current,', 'assertLotsLoaded(lotsLoadedRef.current || true,'), '(|| true で素通し)');
  say(has(brk4b, 'WTG-004'),
    `🚨 壊し方4b: \`旗 || true\` で素通しにしたら ❌ (${brk4b.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ⚠🚨 これは **最終検査の実物を壊して初めて見つかった穴**(2026-09-01)。
  //   画面用の値(setLotsLoaded(false))は残したまま、関所が読む **控え** だけを
  //   上がりっぱなしにすると、直す前のこの見張りは 緑のままだった。
  const brk4c = analyze(LOADED_OK.replace('lotsLoadedRef.current = false;', 'lotsLoadedRef.current = true;'), '(控えの旗が一度も下りない)');
  say(has(brk4c, 'WTG-004'),
    `🚨 壊し方4c: 関所が読む控えの旗が一度も下りないなら ❌（画面用の set…(false) が残っていても通さない） (${brk4c.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ⚠負の対照: 関所が **画面用の値そのもの** を読んでいて、set…(false) で下りるなら通す
  const stateFlag = analyze(`
const [lotsLoaded, setLotsLoaded] = useState(false);
const onLotsError = () => { setLotsLoaded(false); };
const saveData = async (col, id, rawData) => {
  if (col === 'lots') { assertLotsLoaded(lotsLoaded, { onBlock: note }); assertSafeLotSave(before, rawData); }
  await DATA(db).save(ns, col, id, rawData);
};
`, '(画面用の値を読む門)');
  say(!has(stateFlag, 'WTG-004') && !has(stateFlag, 'WTG-003'),
    `負の対照: set…(false) で下りる画面用の旗は通す (${stateFlag.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  // ── 壊し方 その5: 保管庫へ書いた **後** で門を呼ぶ(手遅れ) ────────────
  const brk5 = analyze(LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  await DATA(db).save(ns, col, id, rawData);
  if (col === 'lots') { assertLotsLoaded(lotsLoadedRef.current); assertSafeLotSave(before, rawData); }
};
`, '(保存の後で門を呼ぶ)');
  say(has(brk5, 'WTG-005'),
    `🚨 壊し方5: 保管庫へ書いた後で門を呼んでいたら ❌ (${brk5.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ⚠負の対照: ロットを扱わない保存関数に「門が無い」と言わない(直せない赤を出さない)
  const notLots = analyze(LOADED_WIRING + `
const saveDoc = async (col, id, body) => { await DATA(db).save(ns, 'announcements', id, body); };
`, '(ロットを扱わない関所)');
  say(cnt(notLots, 'WTG-003') === 0,
    `負の対照: ロットを扱わない保存関数に門を求めない (WTG-003 ${cnt(notLots, 'WTG-003')}件)`);

  // ⚠負の対照 ①: **手元の作業用の変数** を「本番が消える」と言わない
  const localVar = analyze(LOADED_WIRING + `
const saveData = async (col, id, rawData) => { if (col === 'lots') { assertLotsLoaded(lotsLoadedRef.current); assertSafeLotSave(cur, rawData); } await DATA(db).save(ns, col, id, rawData); };
let _skip = { plan: {}, tasks: {}, decisions: [] };
const counters = { tasks: {}, lots: {} };
`, '(手元の変数)');
  say(localVar.findings.length === 0,
    `負の対照: ロットの doc でない { tasks: {} } を誤検出しない (実際 ${localVar.findings.length}件)`);

  // ⚠負の対照 ②: プロパティ参照 `x.tasks : {}` をキーの直書きと数えない
  //   ただし「三項で空に落ちる」形そのものは WTG-021 で捕まえる(危険なのは事実)
  const ternary = analyze(`
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
const lotData = { id, orderNo, steps: finalSteps, tasks: editingLot ? editingLot.tasks : {}, interruptions: [] };
`, '(三項)');
  const tids = ternary.findings.map((f) => f.id);
  say(!tids.includes('WTG-020'), 'プロパティ参照を「空マップの直書き」と言わない');
  say(tids.includes('WTG-021'), `三項で空マップに落ちる形は捕まえる (${tids.join(',') || 'なし'})`);

  // 🚨🚨 2026-08-31 に足した所: 「関所の外の直接書き込み」を **番線を読んで** 通す形。
  //   前の担当が「黙らせるのは筋違い」と残した WTG-010(復元のロット以外を書く行)の直し。
  //   ⚠一覧表(allowlist)や名前では通さない。実コードに `if (col === 'lots') throw` が
  //     在る時だけ通し、根拠を必ず出す。**番線を消したら赤に戻る**事を毎回確かめる。
  const TRIPWIRE = `
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    for (const raw of arr) {
      if (col === 'lots') { await saveData('lots', raw.id, raw); continue; }
      if (col === 'lots') throw new Error('復元の不具合: ロットは保存の関所しか通らない道になっています');
      await DATA(db).save(APP_DATA_ID, col, raw.id, raw);
    }
  }
};
`;
  const trip = analyze(TRIPWIRE, '(番線あり)');
  say(trip.findings.filter((f) => f.id === 'WTG-010').length === 0 && trip.bypassPassed.length === 1,
    `番線(if (col === 'lots') throw)が手前に在る直接書き込みは、根拠つきで通す (通した ${trip.bypassPassed.length}件 / WTG-010 ${trip.findings.filter((f) => f.id === 'WTG-010').length}件)`);
  say(!!(trip.bypassPassed[0] && trip.bypassPassed[0].guardLine && trip.bypassPassed[0].guardCode),
    '通した根拠(番線の行と中身)を人に見せる形で持っている');

  const tripGone = analyze(TRIPWIRE.replace(/ *if \(col === 'lots'\) throw new Error\([^\n]*\n/, ''), '(番線を消した)');
  say(tripGone.findings.some((f) => f.id === 'WTG-010'),
    '🚨 わざと番線を消したら ❌ に戻る(黙って通り続けない)');

  const tripLiteral = analyze(TRIPWIRE.replace("await DATA(db).save(APP_DATA_ID, col, raw.id, raw);", "await DATA(db).save(APP_DATA_ID, 'lots', raw.id, raw);"), "('lots' の直書き)");
  say(tripLiteral.findings.some((f) => f.id === 'WTG-010'),
    "🚨 'lots' の直書きは、番線が在っても絶対に通さない");

  const tripSwap = analyze(TRIPWIRE.replace('await DATA(db).save(APP_DATA_ID, col, raw.id, raw);',
    "col = 'lots'; await DATA(db).save(APP_DATA_ID, col, raw.id, raw);"), '(番線の後で col を入れ替え)');
  say(tripSwap.findings.some((f) => f.id === 'WTG-010'),
    '🚨 番線の後で col を入れ替えていたら通さない(番線が守っていない)');

  // 🚨🚨 2026-08-31(あら探しで実測): 手前の文字数だけで見ていた頃は、
  //   番線の **支配の外** に在る直接書き込みが2形とも緑で通っていた。
  //   ⚠ここが赤にならない限り、この見張りは「番線を読んでいる」と言えない。
  const tripOtherFn = analyze(TRIPWIRE + `
const rawSave = async (col, id, data) => { await DATA(db).save(APP_DATA_ID, col, id, data); };
`, '(番線の外・別の関数)');
  say(tripOtherFn.findings.some((f) => f.id === 'WTG-010') && tripOtherFn.bypassPassed.length === 1,
    `🚨 番線の後に置いた **別の関数** の直接書き込みは通さない (WTG-010 ${tripOtherFn.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripOtherFn.bypassPassed.length}件)`);

  const tripOtherLoop = analyze(TRIPWIRE + `
const restoreExtra = async (extraCols) => {
  for (const [col, arr] of extraCols) {
    for (const raw of arr) {
      await DATA(db).save(APP_DATA_ID, col, raw.id, raw);
    }
  }
};
`, '(番線の外・別のループ)');
  say(tripOtherLoop.findings.some((f) => f.id === 'WTG-010') && tripOtherLoop.bypassPassed.length === 1,
    `🚨 番線の後に置いた **別のループ** の直接書き込みは通さない (WTG-010 ${tripOtherLoop.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripOtherLoop.bypassPassed.length}件)`);

  // ⚠同じ関数の中で col を束縛し直した第2ループも「番線の支配外」。
  const tripSecondLoop = analyze(`
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    if (col === 'lots') throw new Error('復元の不具合: ロットは保存の関所しか通らない道になっています');
    await DATA(db).save(APP_DATA_ID, col, arr.id, arr);
  }
  for (const [col, arr] of extraCols) {
    await DATA(db).save(APP_DATA_ID, col, arr.id, arr);
  }
};
`, '(同じ関数の中で束縛し直した第2ループ)');
  say(tripSecondLoop.findings.filter((f) => f.id === 'WTG-010').length === 1 && tripSecondLoop.bypassPassed.length === 1,
    `🚨 同じ関数でも col を束縛し直した後の書き込みは通さない (WTG-010 ${tripSecondLoop.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripSecondLoop.bypassPassed.length}件)`);

  // ⚠負の対照: 番線と書き込みの間に **ただの if / for の波括弧** が在るだけなら通す
  //   (本物の復元コードがこの形。ここを落とすと「直せない赤」を出す事になる)
  const tripBlocks = analyze(`
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    if (!Array.isArray(arr)) continue;
    if (col === 'lots') throw new Error('復元の不具合: ロットは保存の関所しか通らない道になっています');
    for (const raw of arr) {
      if (raw && raw.id) {
        try { note(raw); } catch (e) { console.error(e); }
        await DATA(db).save(APP_DATA_ID, col, raw.id, raw);
      }
    }
  }
};
`, '(間に if/for/try の波括弧)');
  say(tripBlocks.findings.filter((f) => f.id === 'WTG-010').length === 0 && tripBlocks.bypassPassed.length === 1,
    `負の対照: 間に if/for/try の波括弧が在るだけなら通す (WTG-010 ${tripBlocks.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripBlocks.bypassPassed.length}件)`);

  // 🚨🚨 2026-09-01(2回目のあら探しで実測): 「同じ関数に在る」だけでは まだ緩かった。
  //   次の3形は 番線が **この書き込みを必ず通る道に無い**(または動かない字)のに、
  //   直す前は3形とも 緑で通っていた。ここが赤にならない限り、通してよい根拠にならない。
  const HEAD = `
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
`;
  const tripCond = analyze(HEAD + `
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    for (const raw of arr) {
      if (strict) { if (col === 'lots') throw new Error('ロットは保存の関所しか通らない'); }
      await DATA(db).save(APP_DATA_ID, col, raw.id, raw);
    }
  }
};
`, '(番線が if の枝の中)');
  say(tripCond.findings.some((f) => f.id === 'WTG-010') && tripCond.bypassPassed.length === 0,
    `🚨 番線が if の枝の中(偽ならロットが素通り)なら通さない (WTG-010 ${tripCond.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripCond.bypassPassed.length}件)`);

  const tripSwallow = analyze(HEAD + `
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    for (const raw of arr) {
      try { if (col === 'lots') throw new Error('ロットは保存の関所しか通らない'); } catch (e) { console.error(e); }
      await DATA(db).save(APP_DATA_ID, col, raw.id, raw);
    }
  }
};
`, '(番線を try が握り潰す)');
  say(tripSwallow.findings.some((f) => f.id === 'WTG-010') && tripSwallow.bypassPassed.length === 0,
    `🚨 番線を try/catch が握り潰していたら通さない (WTG-010 ${tripSwallow.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripSwallow.bypassPassed.length}件)`);

  const tripInStr = analyze(HEAD + `
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    const memo = "if (col === 'lots') throw new Error('これは説明の字')";
    await DATA(db).save(APP_DATA_ID, col, arr.id, arr);
  }
};
`, '(文字列の中の番線)');
  say(tripInStr.findings.some((f) => f.id === 'WTG-010') && tripInStr.bypassPassed.length === 0,
    `🚨 文字列の中の番線(動かない字)を根拠にしない (WTG-010 ${tripInStr.findings.filter((f) => f.id === 'WTG-010').length}件 / 通した ${tripInStr.bypassPassed.length}件)`);

  say(/同じ流れ/.test((analyze(HEAD + `
const restore = async (parsed) => {
  for (const [col, arr] of cols) {
    await DATA(db).save(APP_DATA_ID, col, arr.id, arr);
  }
};
`, '(番線なし)').findings.find((f) => f.id === 'WTG-010') || {}).why || ''),
    '通さなかった時、その理由を人の言葉で言う');

  // ═════════════════════════════════════════════════════════════════════════
  // 🚨🚨 握り潰し(WTG-006) と await 外し(WTG-007)  2026-09-02
  // -------------------------------------------------------------------------
  // 実測: 保存の関所の門を `try { … } catch (e) { console.warn(e); }` と
  //   **囲むだけ** で、この見張りは 製品・最終・部品の3アプリとも 0(緑)だった。
  //   最終検査に至っては 既に在る catch から **`throw e;` を1行消す** だけで緑。
  //   門は投げる事でしか保存を止められないので、これは「門が1件も止まらない」形。
  //   ここは **6通り以上 わざと壊して、全部赤になる**事を毎回確かめる。
  // ⚠⚠ 同じだけ大事な事: **正しい形(札を出して再送出する)が緑のまま**である事。
  //   最終検査の関所と 部品検査の guardLotSave が実際にこの形なので、
  //   ここを一律に赤にすると 現場に出ている正しいコードを直させる事になる。
  // ═════════════════════════════════════════════════════════════════════════
  const SWALLOW_OK = LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  if (col === 'lots') {
    try {
      assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });
      assertSafeLotSave(before, rawData, { onBlock: note });
    } catch (e) {
      console.error('🚨 作業の記録が消える保存を止めました', col, id, e);
      alert('🚨 保存を止めました');
      throw e;
    }
  }
  await DATA(db).save(ns, col, id, rawData);
};
`;
  const okSw = analyze(SWALLOW_OK, '(札を出して投げ返す・正しい形)');
  say(!has(okSw, 'WTG-006') && okSw.findings.length === 0 && okSw.chokes.every((c) => !c.swallowed),
    `負の対照: catch で札を出して **再送出する** 正しい形は緑のまま (${okSw.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  // ── 握り潰し1: 既に在る catch から `throw e;` を1行消す(最終検査で実測した形) ──
  const swb1 = analyze(SWALLOW_OK.replace('      throw e;\n', ''), '(throw e; を1行消した)');
  say(has(swb1, 'WTG-006'),
    `🚨 壊し方6-1: catch の最後の \`throw e;\` を1行消したら ❌ (${swb1.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し2: catch の中で return して飲む ──────────────────────────
  const swb2 = analyze(SWALLOW_OK.replace('      throw e;', '      return;'), '(catch の中で return)');
  say(has(swb2, 'WTG-006'),
    `🚨 壊し方6-2: catch の中で return して飲んだら ❌ (${swb2.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し3: 読み込みの門だけを try/catch で囲む(3アプリで緑だった本命) ──
  const swb3 = analyze(LOADED_OK.replace(
    'assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });',
    'try { assertLotsLoaded(lotsLoadedRef.current, { onBlock: note }); } catch (e) { console.warn("門", e); }'),
  '(門だけを try/catch で囲む)');
  say(has(swb3, 'WTG-006'),
    `🚨 壊し方6-3: 読み込みの門を try/catch で囲んで console.warn だけしたら ❌ (${swb3.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し4: 中身の見張りを try/catch で囲む(製品で実測した本命) ────
  const swb4 = analyze(LOADED_OK.replace(
    'assertSafeLotSave(before, rawData, { onBlock: note });',
    'try { assertSafeLotSave(before, rawData, { onBlock: note }); } catch (e) { console.warn("見張り", e); }'),
  '(中身の見張りを try/catch で囲む)');
  say(has(swb4, 'WTG-006'),
    `🚨 壊し方6-4: 中身の見張りを try/catch で囲んで飲んだら ❌ (${swb4.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し5: try を関数の外側へ広げて **丸ごと** 包む ───────────────
  const swb5 = analyze(LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  try {
    if (col === 'lots') {
      assertLotsLoaded(lotsLoadedRef.current, { onBlock: note });
      assertSafeLotSave(before, rawData, { onBlock: note });
    }
    await DATA(db).save(ns, col, id, rawData);
  } catch (e) {
    console.warn('保存に失敗しました', e);
  }
};
`, '(関所を丸ごと try で包む)');
  say(has(swb5, 'WTG-006'),
    `🚨 壊し方6-5: 関所の中身を丸ごと try で包んで飲んだら ❌ (${swb5.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し6: 見張りを任せた **呼び出しの側** を囲む(部品検査の形) ───
  const swb6 = analyze(DELEG_LOADED.replace(
    'guardLotSave(col, id, data);',
    'try { guardLotSave(col, id, data); } catch (e) { console.warn(e); }'),
  '(任せた門の呼び出しを囲む)');
  say(has(swb6, 'WTG-006'),
    `🚨 壊し方6-6: 別関数に任せた門を、呼び出しの側で囲んで飲んだら ❌ (${swb6.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し7: 内側は正しく投げ返すが、**外側** が飲む ────────────────
  const swb7 = analyze(LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  try {
    if (col === 'lots') {
      try { assertLotsLoaded(lotsLoadedRef.current, { onBlock: note }); assertSafeLotSave(before, rawData); }
      catch (e) { alert(e.message); throw e; }
    }
    await DATA(db).save(ns, col, id, rawData);
  } catch (e) { console.warn('保存に失敗しました', e); }
};
`, '(内側は投げ返すが外側が飲む)');
  say(has(swb7, 'WTG-006'),
    `🚨 壊し方6-7: 内側が投げ返しても **外側の try** が飲んでいたら ❌ (${swb7.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ── 握り潰し8: 枝の中でだけ投げ返す(それ以外は飲む) ──────────────────
  const swb8 = analyze(SWALLOW_OK.replace('      throw e;', "      if (e && e.name === 'FatalError') throw e;"),
    '(枝の中でだけ投げ返す)');
  say(has(swb8, 'WTG-006'),
    `🚨 壊し方6-8: \`if (…) throw e;\` は偽の時に飲むので ❌ (${swb8.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ⚠負の対照: catch を持たない try(finally だけ)は、投げがそのまま外へ出る = 緑
  const swOkFinally = analyze(LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  if (col === 'lots') {
    try { assertLotsLoaded(lotsLoadedRef.current, { onBlock: note }); assertSafeLotSave(before, rawData); }
    finally { bumpInflight(-1); }
  }
  await DATA(db).save(ns, col, id, rawData);
};
`, '(finally だけ)');
  say(!has(swOkFinally, 'WTG-006'),
    `負の対照: finally だけの try は投げが外へ出るので緑 (${swOkFinally.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  // ⚠負の対照: **別の言葉にして** 投げ返すのも正しい形
  const swOkNew = analyze(SWALLOW_OK.replace('      throw e;', "      throw new Error('保存を止めました: ' + e.message);"),
    '(言い換えて投げ返す)');
  say(!has(swOkNew, 'WTG-006'),
    `負の対照: 別の言葉にして投げ返す形も緑 (${swOkNew.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  // ── await 外し(WTG-007) ───────────────────────────────────────────────
  const AWAIT_OK = LOADED_WIRING + `
const saveData = async (col, id, rawData) => {
  if (col === 'lots') { assertLotsLoaded(lotsLoadedRef.current, { onBlock: note }); assertSafeLotSave(before, rawData); }
  await DATA(db).save(ns, col, id, rawData);
};
const restore = async (parsed) => {
  for (const raw of parsed.lotRows) {
    try { await saveData('lots', raw.id, raw); ok++; }
    catch (e) { blocked++; console.error('復元を止めました(この1件だけ)', raw.id, e); }
  }
};
`;
  const awOk = analyze(AWAIT_OK, '(復元が await している)');
  say(!has(awOk, 'WTG-007'),
    `負の対照: try で受けて await している復元は緑 (${awOk.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  const awBad = analyze(AWAIT_OK.replace("await saveData('lots', raw.id, raw);", "saveData('lots', raw.id, raw);"),
    '(await だけ外した)');
  say(has(awBad, 'WTG-007'),
    `🚨 壊し方6-9: try で受けているのに await を外したら ❌（止めた件数が人に出なくなる） (${awBad.findings.map((f) => f.id).join(',') || 'なし'})`);

  // ⚠負の対照: ロット以外の保存には言わない(直せない赤を増やさない)
  const awOther = analyze(AWAIT_OK.replace("await saveData('lots', raw.id, raw);", "saveData('templates', raw.id, raw);"),
    '(ロット以外の保存)');
  say(!has(awOther, 'WTG-007'),
    `負の対照: ロット以外の保存には await を求めない (${awOther.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  // ⚠負の対照: 他の呼び出しの引数に渡している形(受け取った側が待つ)
  const awArg = analyze(AWAIT_OK.replace("await saveData('lots', raw.id, raw);", "await settleSaveBriefly(saveData('lots', raw.id, raw));"),
    '(引数として渡す)');
  say(!has(awArg, 'WTG-007'),
    `負の対照: \`await 他の関数(saveData(…))\` は対象外 (${awArg.findings.map((f) => f.id).join(',') || '指摘なし'})`);

  const after = analyze(AFTER_FIX, '(直した後)');
  say(after.findings.length === 0, `直した後: 指摘ゼロになる (実際 ${after.findings.length}件: ${after.findings.map((f) => f.id).join(',')})`);
  say(after.chokes.every((c) => c.guarded), '直した後: 関所が見張りを通っている');

  // ⚠誤検出よけ: コメントの中の例示コードを実コードとして数えない
  const commented = analyze(LOADED_WIRING + `
// 例: saveData('lots', id, { tasks: {} })  ← これは説明。実コードではない
/* if (lot.tasks) update.tasks = lot.tasks; */
const saveData = async (col, id, rawData) => { if (col === 'lots') { assertLotsLoaded(lotsLoadedRef.current); assertSafeLotSave(cur, rawData); } await DATA(db).save(ns, col, id, rawData); };
`, '(コメントだけ)');
  say(commented.findings.length === 0, `コメントの中の例示を実コードとして数えない (実際 ${commented.findings.length}件)`);

  // ⚠見張りが「何も見ていない」状態で合格しないこと
  say(before.findings.length > after.findings.length, '直す前より直した後の方が指摘が少ない(見張りが実際に効いている)');

  console.log(bad === 0 ? '🧪 見張り自身の試験: 合格' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗`);
  return bad === 0;
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
const main = (args) => {
  if (args.includes('--selftest')) return selftest() ? 0 : 1;

  // ⚠まず見張り自身の試験を通してから本番のコードを見る。
  //   壊れた物差しで測って「合格」と言わないため。
  if (!selftest()) {
    console.error('❌ 見張り自身が壊れているので、実コードの判定はしません。');
    return 1;
  }
  console.log('');

  const DEFAULTS = ['src/App.firebase.jsx', 'src/App.jsx'];
  const files = (args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : DEFAULTS)
    .filter((f) => fs.existsSync(f));
  if (!files.length) {
    console.log('（対象のファイルが無いので省略）');
    return 0;
  }

  // 🚨🚨 多層目(2026-09-01): 「根拠つきで通した所」の **件数を固定** する。
  //   番線を読んで通す道が在る以上、番線を1本足せば新しい裏道を作れてしまう。
  //   いま在ってよいのは **復元(restoreAllFromBackup)の 1件だけ**。
  //   増えても減っても止める:
  //     増えた → 新しい裏道。番線が在っても、人が中身を見るまで通さない。
  //     減った → 道が変わったのか、**見張りが読めなくなった**のか区別が付かない。
  //              「黙って見張りが止まる」を作らない為、これも人に確かめてもらう。
  //   ⚠ファイルを指定して走らせた時(部分的に見る時)は数えない。
  const BYPASS_EXPECTED = 1;
  const pinBypass = !args.filter((a) => !a.startsWith('--')).length;
  const bypassAll = [];

  let errors = 0;
  let exposureTotal = 0;
  for (const f of files) {
    const r = analyze(fs.readFileSync(f, 'utf8'), f);
    console.log(`📄 ${path.normalize(f)}`);
    r.chokes.forEach((c) => console.log(
      `   関所 ${c.name}() @${c.line} … `
      + (c.handlesLots
        ? `${c.guarded ? (c.swallowed ? '⚠ 見張りは呼んでいるが投げを握り潰している' : '✅ 見張りを通っている') : '❌ 通っていない'}`
          + ` / 読み込みの門 ${c.loadedGuarded ? '✅ 通っている' : '❌ 通っていない'}`
        : '（ロットを扱わない保存関数なので対象外）')));

    if (r.findings.length) {
      console.log(`   ── 危ない所 ${r.findings.length}件 ──`);
      r.findings.forEach((x) => {
        console.log(`   ❌ [${x.id}] ${x.file}:${x.line}`);
        console.log(`      ${x.why}`);
        if (x.code) console.log(`      ${x.code}`);
        errors++;
      });
    } else {
      console.log('   ✅ 危ない所は見つかりませんでした');
    }

    // 🚨黙って通さない。根拠つきで通した物は、その根拠ごと必ず出す(番線を消せば ❌ に戻る)。
    if (r.bypassPassed && r.bypassPassed.length) {
      bypassAll.push(...r.bypassPassed);
      console.log(`   ── 関所の外の直接書き込みで、番線を読んで通した所 ${r.bypassPassed.length}件 ──`);
      r.bypassPassed.forEach((x) => {
        console.log(`      ✅ ${x.file}:${x.line}  ${x.code}`);
        console.log(`         根拠: ${x.file}:${x.guardLine} に \`${x.guardCode}\` が在り、この行に lots は来ない`);
      });
    }

    if (r.exposure.length) {
      console.log(`   ── tasks のマップ全体を送っている所 ${r.exposure.length}件（関所が見張りを通っていれば全部守られる） ──`);
      r.exposure.forEach((x) => console.log(`      ・${x.file}:${x.line}  ${x.code}`));
      exposureTotal += r.exposure.length;
    }
    console.log('');
  }

  if (pinBypass && bypassAll.length !== BYPASS_EXPECTED) {
    errors++;
    console.log(`❌ 関所の外の直接書き込みで「番線を読んで通した所」が ${BYPASS_EXPECTED}件 → ${bypassAll.length}件 に変わりました。`);
    if (bypassAll.length > BYPASS_EXPECTED) {
      console.log('   🚨 番線が在っても、増えた分は人が中身を見るまで通しません(番線を1本足せば裏道が作れる為)。');
      bypassAll.forEach((x) => console.log(`      ・${x.file}:${x.line}  ${x.code}`));
    } else {
      console.log('   🚨 復元の道が変わったのか、見張りが読めなくなったのかが区別できません。');
      console.log('     どちらかを人が確かめてから、この見張りの BYPASS_EXPECTED を直してください。');
    }
    console.log('');
  }

  console.log(`合計: 危ない所 ${errors}件 / tasks 全体を送る所 ${exposureTotal}件`);
  if (String(process.env.WTG_LIST_ONLY || '') === '1') {
    console.log('（WTG_LIST_ONLY=1 のため、指摘があっても止めません）');
    return 0;
  }
  return errors ? 1 : 0;
};

// ⚠ここから下は「直接動かした時」だけ。import して analyze() だけ使う道を塞がない。
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main(process.argv.slice(2)));
