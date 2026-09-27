// =============================================================================
// 🔎 code() — 実コードを「字で」見張る時に、**コメントを落としてから** 見る為の道具。
// -----------------------------------------------------------------------------
// 🚨 なぜ要るか（2026-09-04 実測）:
//   製品の見張り F3 (src/domain/__tests__/fixes-2026-09-04.test.mjs) は
//   OperationsSimulationPanel.jsx の
//       fromMs: timeline.startMs,
//   を **生の文字のまま** 探していた。この行を
//       // fromMs: timeline.startMs,
//   とコメントにすると、画面は壊れているのに **試験は緑のまま** 通った（実測・写しで再現）。
//   行を消す／値を変える壊し方では赤になるので、「壊して赤を見た」だけでは見つからない穴。
//
// 🚨🚨🚨 2026-09-10 に見つかった、もっと重い穴（この道具そのものの読み違え）:
//   前の版は「1文字ずつ読む自前の読み手」で、JSX の閉じ札 `</span>` の `/` を
//   **正規表現の始まり** と読み違えていた（`<` を「正規表現が来てよい直前の字」に入れていた為）。
//   そこから先の読み位置がずれ、テンプレート文字列の開きを飲み込み、
//   閉じが新しい文字列の始まりになる…と連鎖して、
//   **製品 App.jsx で 475行・33区間 / 最終 App.firebase.jsx で 131行** のコメントが
//   落ちずに残っていた。残った区間の中には
//     ・ProgressSheetMapPanel（工機進捗管理表の読み方）
//     ・ModelMasterPanel（型式マスタ）
//   が丸ごと入っていて、「行を // でコメントにする」壊し方が **12通り試して12通りとも緑**。
//   つまりコメントに字を書いておくだけで、その画面の見張りは全部 素通りしていた。
//
//   → 直し方は2つ。両方入れる（片方だけだと また黙って素通りする）:
//     ① コメントの場所は **本物の構文解析器**（@babel/parser。JSX を知っている）に聞く。
//        自前の読み手は、解析器が読めなかった時（関数の中身だけを渡された等）の控え。
//     ② codeOf の出口に **門** を置く。落とし残し（行頭が //）が1行でも在ったら
//        行番号を並べて throw する。黙って素通りせず **止まる**
//        （2026-09-08「道具は黙って素通りせず 止まる形に」）。
//
// この道具がやる事:
//   ・`//` の行コメントを落とす
//   ・`/* … */` の中コメントを落とす（JSX の `{/* … */}` も中身が落ちる）
//   ・**文字列リテラルの中は 1文字も触らない**（'a // b' / "https://x" / `x // y`）
//   ・テンプレート文字列の `${ … }` の中は **コードとして** 扱う（中のコメントは落とす）
//   ・正規表現リテラル `/…/` の中は触らない（`/\/\//` を壊さない）
//   ・行数を変えない（行番号がずれると、赤の時に人が現物を探せない）
//
// ⚠ この道具自身も試験する（stripComments.test.mjs）。
//   「見張りが空振りしたまま黙って通過した」が過去に何度も起きているため
//   （2026-08-16「見張り自身も試験する」/ 2026-08-23「作り物を食っていた」）。
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// ① 本命 — 本物の構文解析器にコメントの場所を聞く
// ---------------------------------------------------------------------------
// 🚨 @babel/parser は eslint-plugin-react-hooks(devDependencies)→@babel/core が連れてくるので、
//   `npm ci` した所には必ず居る。無い時は黙って劣化させず、codeOf の門で止める。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireFrom = createRequire(path.join(HERE, '..', '..', '..', 'package.json'));

let PARSER = null;         // 読めた解析器
let PARSER_ERROR = '';     // 読めなかった理由（門の文に出す）
try {
  PARSER = requireFrom('@babel/parser');
} catch (err) {
  PARSER_ERROR = (err && err.message) || String(err);
}

/** 解析器が使えるか（試験から見たい）。 */
export const hasAstParser = () => !!(PARSER && typeof PARSER.parse === 'function');
/** 解析器が読めなかった理由。 */
export const astParserError = () => PARSER_ERROR;

const PARSE_OPTIONS = {
  sourceType: 'module',
  plugins: ['jsx'],
  errorRecovery: true,              // 少しくらい壊れていても、コメントの場所は取れる
  allowReturnOutsideFunction: true, // 見張りが「関数の中だけ」を切って渡す事がある
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowUndeclaredExports: true,
  ranges: false,
  tokens: false,
};

/**
 * 解析器でコメントの範囲を取り、その字だけ落とす（改行は残すので行数は変わらない）。
 * 読めなかったら null（呼ぶ側が控えの読み手へ回る）。
 * @param {string} s
 * @returns {string|null}
 */
const stripByAst = (s) => {
  if (!hasAstParser()) return null;
  let ast;
  try {
    ast = PARSER.parse(s, PARSE_OPTIONS);
  } catch {
    return null;                     // 断片を渡された等。控えの読み手に任せる
  }
  const comments = (ast && ast.comments) || [];
  if (!comments.length) return s;
  const buf = [];
  let cur = 0;
  // 出てくる順に並んでいるが、念の為に並べ直す（重なりは無い）。
  const ranges = comments
    .map(c => [c.start, c.end])
    .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  for (const [a, b] of ranges) {
    if (a < cur) continue;           // 重なっていたら後ろは捨てる
    buf.push(s.slice(cur, a));
    // 🚨 行数を変えない。コメントの中の改行だけ残す。
    const inner = s.slice(a, b);
    const nl = inner.length - inner.replace(/\n/g, '').length;
    if (nl) buf.push('\n'.repeat(nl));
    cur = b;
  }
  buf.push(s.slice(cur));
  return buf.join('');
};

// ---------------------------------------------------------------------------
// ② 控え — 自前の読み手（解析器が読めない断片用）
// ---------------------------------------------------------------------------
// `/` が正規表現の始まりになれる文脈か。直前の「意味のある文字」で見分ける。
// ⚠ ここを間違えると割り算 `a / b` を正規表現と読み、そこから先を丸ごと飲み込む。
// 🚨 '<' と '>' は **入れない**。入れると JSX の閉じ札の `/` を
//   正規表現の始まりと読んで、そこから先の読み位置がずれる（2026-09-10 の穴の元）。
const REGEX_OK_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '\n', '']);
const REGEX_OK_WORDS = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * `s[i]` の `/` から始まる正規表現が **同じ行の中で閉じるか** を先に見る。
 * 🚨 閉じないなら正規表現ではない（本物の正規表現リテラルは行をまたげない）。
 *   ここを見ないと、読み違えた「正規表現」が行末まで飲み込んで読み位置がずれる。
 */
const regexClosesOnSameLine = (s, i) => {
  let k = i + 1;
  let inClass = false;
  while (k < s.length) {
    const c = s[k];
    if (c === '\n') return false;
    if (c === '\\') { k += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return true;
    k += 1;
  }
  return false;
};

/**
 * JS / JSX のソースから **コメントだけ** を落とす（控えの読み手）。
 * 文字列・テンプレート文字列・正規表現リテラルの中身と、行数はそのまま残す。
 * @param {string} src
 * @returns {string}
 */
export function stripCommentsByScan(src) {
  const s = String(src ?? '');
  const buf = [];                 // ⚠ 1文字ずつ足すと 320万字の App.jsx で秒がかかる。配列に貯める。
  let i = 0;
  // 直前に出した「空白でない文字」。正規表現かどうかの見分けに使う。
  let lastSig = '';
  // テンプレート文字列の `${` に潜った時、外側の波かっこの深さを積む。
  const tplStack = [];
  let braceDepth = 0;

  let tail = '';                  // 直前に出した 24文字（`return /re/` のような書き方の見分け用）
  const emit = (t) => {
    buf.push(t);
    tail = (tail + t).slice(-24);
    for (let k = t.length - 1; k >= 0; k -= 1) {
      const ch = t[k];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') { lastSig = ch; return; }
    }
  };

  // 引用符の中をそのまま写す。`${` に入ったら 'interp' を返してコードへ戻る。
  const copyString = (quote) => {
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { emit(s.slice(i, i + 2)); i += 2; continue; }
      // ⚠ JSX の地の文の「'」(it's のような字)で、そこから先を丸ごと文字列だと
      //   読み違えないように、'…' と "…" は行をまたがない所で必ず切る。
      if (c === '\n' && quote !== '`') return 'eof';
      if (quote === '`' && c === '$' && s[i + 1] === '{') {
        emit('${'); i += 2;
        tplStack.push(braceDepth);
        braceDepth = 0;
        return 'interp';
      }
      if (c === quote) { emit(c); i += 1; return 'done'; }
      emit(c); i += 1;
    }
    return 'eof';
  };

  // 正規表現リテラルをそのまま写す。`[...]` の中の `/` は終わりではない。
  const copyRegex = () => {
    let inClass = false;
    emit('/'); i += 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') return;                         // 改行が来たら正規表現ではなかった
      if (c === '\\') { emit(s.slice(i, i + 2)); i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { emit(c); i += 1; while (i < s.length && /[a-z]/.test(s[i])) { emit(s[i]); i += 1; } return; }
      emit(c); i += 1;
    }
  };

  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];

    // ── コメント（落とす。行数は変えない）
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      let nl = '';
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') nl += '\n'; i += 1; }
      i += 2;
      buf.push(nl);                                    // 🚨 行番号をずらさない
      continue;
    }

    // ── 文字列（1文字も触らない）
    if (c === '"' || c === "'" || c === '`') {
      emit(c); i += 1;
      copyString(c);
      continue;
    }

    // ── テンプレート文字列の `${ … }` を閉じたら、文字列の続きへ戻る
    if (c === '}') {
      if (braceDepth === 0 && tplStack.length > 0) {
        braceDepth = tplStack.pop();
        emit('}'); i += 1;
        copyString('`');
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      emit(c); i += 1; continue;
    }
    if (c === '{') { braceDepth += 1; emit(c); i += 1; continue; }

    // ── 正規表現リテラルか、割り算か
    if (c === '/') {
      const canBeRegex = (REGEX_OK_CHARS.has(lastSig) || REGEX_OK_WORDS.test(tail)) && regexClosesOnSameLine(s, i);
      if (canBeRegex) { copyRegex(); continue; }
      emit(c); i += 1; continue;
    }

    emit(c); i += 1;
  }

  return buf.join('');
}

/**
 * JS / JSX のソースから **コメントだけ** を落とす。
 * まず本物の構文解析器に聞き、読めなければ控えの読み手で落とす。
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const s = String(src ?? '');
  const byAst = stripByAst(s);
  return byAst === null ? stripCommentsByScan(s) : byAst;
}

// ---------------------------------------------------------------------------
// ③ 門 — 落とし残しが1行でも在ったら止まる
// ---------------------------------------------------------------------------
/**
 * コメントを落とした後の字の中で、**まだ行頭が `//` のままの行**の行番号。
 * 0件でなければ「その区間の見張りは、行を // にする壊し方を素通りする」という事。
 * @param {string} code
 * @returns {number[]} 1始まりの行番号
 */
export function leftoverCommentLines(code) {
  const out = [];
  String(code == null ? '' : code).split('\n').forEach((line, idx) => {
    if (line.trim().startsWith('//')) out.push(idx + 1);
  });
  return out;
}

// 同じファイルを何度も読む見張りが多いので控えておく（App.jsx は 320万字ある）。
// ⚠ 控えの鍵は「道 + 大きさ + 更新時刻」。中身が変わったら作り直す。
const CACHE = new Map();

/**
 * ファイルを読んで、コメントを落とした「コードだけ」を返す。
 * 🚨 落とし残しが1行でも在ったら **throw する**（黙って素通りしない）。
 *   落とし残しの区間の中では「行を // でコメントにする」壊し方が全部 素通りするので、
 *   そこを見ている見張りは全部「緑なのに何も守っていない」に変わる。
 */
export const codeOf = (file) => {
  let key = String(file);
  try { const st = fs.statSync(file); key += `|${st.size}|${st.mtimeMs}`; } catch { /* 無ければ道だけを鍵にする */ }
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const left = leftoverCommentLines(code);
  if (left.length) {
    const head = left.slice(0, 20).join(', ');
    const why = hasAstParser()
      ? '構文解析器は読めています。落とし残しの行を見て、この道具の穴を塞いでください。'
      : `@babel/parser が読めませんでした（${PARSER_ERROR || '理由不明'}）。npm ci を実行してください。`;
    throw new Error(
      `🚨 codeOf: コメントを落とし切れていません — ${file}\n`
      + `  落とし残し ${left.length}行（行 ${head}${left.length > 20 ? ' …' : ''}）\n`
      + `  この区間を見ている見張りは「行を // でコメントにする」壊し方を素通りします。\n`
      + `  ${why}`
    );
  }
  CACHE.set(key, code);
  return code;
};
