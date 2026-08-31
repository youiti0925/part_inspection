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

/** 中身が **本物の見張り** を呼んでいる関数の名前(＝見張り役として数えてよい)。 */
export const guardHelperNames = (src) => helperNamesWhere(src, (body) => GUARD_CALLS.test(body));
/** 中身が **ロットを名指ししている** 関数の名前(＝ロットを扱う関所の一部)。 */
export const lotHelperNames = (src) => helperNamesWhere(src, (body) => /['"]lots['"]/.test(body));

export const analyze = (rawSrc, file = '(memory)') => {
  const src = stripComments(rawSrc);
  // 🚨 見張りを任されている関数(guardLotSave など)。中身まで見て決める。
  const helpers = guardHelperNames(src);
  const lotHelpers = lotHelperNames(src);
  const callRe = (names) => (names.length ? new RegExp(`(?<![\\w$])(?:${names.join('|')})\\s*\\(`) : null);
  const HELPER_CALL = callRe(helpers);
  const LOT_HELPER_CALL = callRe(lotHelpers);
  /** 関所が見張りを通っているか。**自分で呼ぶ** か **本物の見張り役に任せている** か。 */
  const passesGuard = (body) => GUARD_CALLS.test(body) || !!(HELPER_CALL && HELPER_CALL.test(body));
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
  const lines = src.split('\n');
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
    // 根拠つきで通した「関所の外の直接書き込み」。⚠黙って通さず、必ず人にも見せる。
    bypassPassed,
    chokes: chokes.map((c) => ({ name: c.name, line: c.line, guarded: passesGuard(c.body) })),
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

const AFTER_FIX = `
const saveData = async (col, id, rawData) => {
    let data = withDeletions(rawData);
    if (col === 'lots') {
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

  // ⚠負の対照 ①: **手元の作業用の変数** を「本番が消える」と言わない
  const localVar = analyze(`
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
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

  const after = analyze(AFTER_FIX, '(直した後)');
  say(after.findings.length === 0, `直した後: 指摘ゼロになる (実際 ${after.findings.length}件: ${after.findings.map((f) => f.id).join(',')})`);
  say(after.chokes.every((c) => c.guarded), '直した後: 関所が見張りを通っている');

  // ⚠誤検出よけ: コメントの中の例示コードを実コードとして数えない
  const commented = analyze(`
// 例: saveData('lots', id, { tasks: {} })  ← これは説明。実コードではない
/* if (lot.tasks) update.tasks = lot.tasks; */
const saveData = async (col, id, rawData) => { if (col === 'lots') assertSafeLotSave(cur, rawData); await DATA(db).save(ns, col, id, rawData); };
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
    r.chokes.forEach((c) => console.log(`   関所 ${c.name}() @${c.line} … ${c.guarded ? '✅ 見張りを通っている' : '❌ 通っていない'}`));

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
