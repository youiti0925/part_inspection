// ============================================================================
// 🔎 実コードから「式そのもの」を取り出す道具(見張りの下ごしらえ)
// ----------------------------------------------------------------------------
// なぜ要るか(2026-09-02 の実測):
//   これまでの見張りは `src.includes('factoryClock')` のように **文字が在るか** だけを見ていた。
//   だから
//     ・配り口の値だけ null にする        <Ctx.Provider value={null}>
//     ・受け取り口を1つだけ切る            const cal = null;   // useContext をやめる
//     ・引数を落とさず null に **する**    addWorkSeconds(a, b, c, d, null)
//   のどれをやっても **緑のまま** だった(= 何も守っていない)。
//   ここは「名前が在るか」ではなく **その場所に入っている式** を取り出して、
//   死んだ値(null / undefined / {} / [])が入っていないかを見る。
//
// 🚨 この道具そのものを試験する(各アプリの factoryCalendarFlow.test.mjs の F0 群)。
//   道具が空振りしていると、その上に載った見張りは全部「緑なのに何も守っていない」になる。
//
// ⚠ ここは JSX/巨大ファイルを **文字として** 見る。構文解析器は入れない(依存を増やさない)。
//   代わりに 文字列・テンプレ文字列・注釈 を必ず読み飛ばす。読み飛ばしを間違えると
//   注釈の中の `null` を欠陥として数えるので、そこを F0 で固定する。
// ⚠ App.jsx は CRLF の事がある。読み込んだ側で必ず \r を落としてから渡す。
// ============================================================================

/** 引用符の終わり(次の位置)。行末で切れている壊れた文字列でも止まる。 */
/**
 * 🚨 .gitignore がこの見張りの部品を **飲み込んでいない** か。
 *   2026-09-02 実測: 最初この道具を `_flowScan.mjs` という名前で置いたら、
 *   3アプリとも .gitignore の `_*.mjs` に当たって **git に載らなかった**。
 *   気付かずコミットすると、次の人の手元でも CI でも import が失敗して
 *   見張り一式が丸ごと動かない(しかも「無くなった」と誰も気付かない)。
 * ⚠ ここは簡単な形(`*` と `?` だけ)しか見ない。凝った書き方の判定は git に任せる。
 * @returns 当たった .gitignore の行(当たらなければ空配列)
 */
export const gitignoreHits = (gitignoreText, relPath) => {
  const base = String(relPath).split('/').pop();
  const out = [];
  for (const raw of String(gitignoreText || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const pat = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat) continue;
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    if (re.test(base) || re.test(relPath)) out.push(line);
  }
  return out;
};

const endOfString = (src, i, q) => {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    if (src[i] === '\n') return i;      // 壊れた文字列。ここで諦める(暴走させない)
    i++;
  }
  return i;
};

/** テンプレ文字列の終わり(次の位置)。⚠ `${ }` の中は普通のコードなので入れ子で数える。 */
const endOfTemplate = (src, i) => {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') { i = matchPair(src, i + 1); continue; }
    i++;
  }
  return i;
};

/**
 * src[i] の開き括弧( ( [ { )に対応する閉じ括弧の **次** の位置。
 * 文字列・テンプレ文字列・注釈は数えない。
 */
export const matchPair = (src, i) => {
  let depth = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = endOfString(src, i, c); continue; }
    if (c === '`') { i = endOfTemplate(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return i;
};

/** 深さ0のコンマで割る(呼び出しの引数を1つずつにする)。 */
export const splitTopLevel = (inner) => {
  const out = [];
  let start = 0, i = 0;
  while (i < inner.length) {
    const c = inner[i], n = inner[i + 1];
    if (c === '/' && n === '/') { const e = inner.indexOf('\n', i); i = e < 0 ? inner.length : e; continue; }
    if (c === '/' && n === '*') { const e = inner.indexOf('*/', i + 2); i = e < 0 ? inner.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = endOfString(inner, i, c); continue; }
    if (c === '`') { i = endOfTemplate(inner, i); continue; }
    if (c === '(' || c === '[' || c === '{') { i = matchPair(inner, i); continue; }
    if (c === ',') { out.push(inner.slice(start, i)); start = i + 1; i++; continue; }
    i++;
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter((s, idx, arr) => !(arr.length === 1 && s === ''));
};

/**
 * `const 名前 = …;` を丸ごと切り出す(注釈・文字列を跨いでも正しく終わる)。
 * ⚠ 字下げされている宣言も拾う(画面の中の宣言は必ず字下げされている)。
 */
export const sliceConst = (src, name) => {
  const re = new RegExp(`(^|\\n)([ \\t]*)(const|let)\\s+${name}\\s*=`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + (m[1] ? m[1].length : 0) + m[2].length;
  let i = src.indexOf('=', start) + 1;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = endOfString(src, i, c); continue; }
    if (c === '`') { i = endOfTemplate(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') { i = matchPair(src, i); continue; }
    if (c === ';') return src.slice(start, i + 1);
    i++;
  }
  return null;
};

/**
 * `名前(` の呼び出しを全部拾い、引数を1つずつに割って返す。
 * ⚠ `React.useContext(…)` のような「何かの下にぶら下がった呼び出し」も拾う
 *   (2026-09-02 実測: ここを外していて useContext の呼び出しが1件も見えていなかった)。
 */
export const callsOf = (src, name) => {
  const out = [];
  const re = new RegExp(`(^|[^A-Za-z0-9_$])(?:[A-Za-z0-9_$]+\\s*\\.\\s*)?${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;   // m[0] は必ず '(' で終わる
    if (src[open] !== '(') break;
    const end = matchPair(src, open);
    const inner = src.slice(open + 1, end - 1);
    const line = src.slice(0, open).split('\n').length;
    out.push({ line, args: splitTopLevel(inner), text: src.slice(m.index, Math.min(end, m.index + 160)) });
    re.lastIndex = open + 1;
  }
  return out;
};

/** JSX の `prop={…}` に入っている式を全部拾う。⚠ `propLoaded={…}` を巻き込まない。 */
export const jsxPropValues = (src, prop) => {
  const out = [];
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${prop}\\s*=\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;   // m[0] は必ず '{' で終わる
    if (src[open] !== '{') break;
    const end = matchPair(src, open);
    out.push({ line: src.slice(0, open).split('\n').length, expr: src.slice(open + 1, end - 1).trim() });
    re.lastIndex = open + 1;
  }
  return out;
};

/**
 * `{ a: 1, calendar: cal }` の形から `鍵:` の値の式を取り出す(無ければ null)。
 * 🚨 引数の **数** ではなく **中身** を見るため。null を「置いた」のと「落とした」のは同じ事。
 */
export const objProp = (objText, key) => {
  let t = String(objText || '').trim();
  if (!t.startsWith('{')) return null;
  t = t.slice(1, matchPair(t, 0) - 1);
  for (const part of splitTopLevel(t)) {
    const m = new RegExp(`^${key}\\s*:`).exec(part);
    if (m) return part.slice(m[0].length).replace(/\/\/[^\n]*$/gm, '').trim();
    if (part.trim() === key) return key;      // 省略記法 { calendar }
  }
  return null;
};

/**
 * 🚨 その式は「死んだ値」か。
 *   死んだ値 = null / undefined / false / 0 / '' / {} / [] のように、
 *   **そこに何が登録されていても答えが変わらない** 物。
 *   引数を1つ落とすのと同じ事を、引数を置いたまま出来てしまうのが 2026-09-02 の D6。
 */
export const isDeadExpr = (expr) => {
  let t = String(expr == null ? '' : expr).trim();
  while (t.startsWith('(') && matchPair(t, 0) === t.length) t = t.slice(1, -1).trim();
  if (t === '') return true;
  if (/^(null|undefined|void\s+0|false|true|0|NaN)$/.test(t)) return true;
  if (/^(''|""|``)$/.test(t)) return true;
  if (/^\{\s*\}$/.test(t)) return true;
  if (/^\[\s*\]$/.test(t)) return true;
  return false;
};

/** 名前(識別子・プロパティ参照・呼び出し)が1つでも入っているか。 */
export const hasIdentifier = (expr) => /[A-Za-z_$][A-Za-z0-9_$]*/.test(String(expr || '').replace(/'[^']*'|"[^"]*"/g, ''));

/**
 * 巨大ファイルから **本物の関数を切り出して、実際に走らせる形** にする。
 * 🚨 これが「値が本当に流れているか」を見る唯一の道。文字を数えるのではなく答えを見る。
 * @param src   ファイルの中身(\r を落としたもの)
 * @param names 先に要る物から順に。最後の名前が戻り値になる。
 * @param deps  外から入れる物({ factoryClock, isWorkdayYmd } など)
 */
export const buildFromSource = (src, names, deps = {}) => {
  const parts = names.map((n) => {
    const s = sliceConst(src, n);
    if (!s) throw new Error(`実コードから ${n} を切り出せません(名前が変わった / 形が変わった)`);
    return s;
  });
  const depNames = Object.keys(deps);
  const body = `${parts.join('\n')}\nreturn ${names[names.length - 1]};`;
  // ⚠ ここだけ new Function を使う。見張り専用で、外から来た文字は一切入らない
  //   (読むのは自分のリポジトリの src だけ)。**本物の実装をそのまま走らせる**ために要る。
  //   ⚠ eslint-disable は付けない。この設定では no-new-func が有効でないため、
  //     付けると「使われていない eslint-disable」が1件増えて出荷の門が赤くなる。
  const make = Function;
  return new make(...depNames, body)(...depNames.map((k) => deps[k]));
};
