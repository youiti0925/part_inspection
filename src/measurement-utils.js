// 測定機能の純粋ヘルパー関数 (React 非依存)
// App.jsx から切り出して保守性向上

// 数式評価 (セキュリティ強化版)
// - 変数 ID は英数字・アンダースコアの組合せ (数字始まりも許可、例: 90_1_U)
// - new Function は使わず、自前 RPN 評価でサンドボックス化
export const evaluateFormula = (formula, values) => {
  if (!formula) return null;
  try {
    let expr = String(formula);
    // 長い名前から先に置換 (BG10 を先に処理して BG1 と衝突しないように)
    const vars = Object.keys(values).sort((a, b) => b.length - a.length);
    for (const v of vars) {
      // 識別子 (英字/数字/_)、最低1文字。 用途上、数字始まりも許可 (例: 90_1_U)
      if (!/^[a-zA-Z0-9_]+$/.test(v)) continue;
      const val = Number(values[v]);
      if (!Number.isFinite(val)) {
        // 該当変数の値が NaN/undefined の場合: その変数を含む数式は評価不可
        // ただしフォーミュラに該当変数が含まれていなければ OK
        const tester = new RegExp(`(^|[^a-zA-Z0-9_])${v}([^a-zA-Z0-9_]|$)`);
        if (tester.test(expr)) return null;
        continue;
      }
      // 単語境界 (\b は _ で混乱するので独自境界: 前後が英数字/_ 以外)
      // (^|[^a-zA-Z0-9_]) ... ([^a-zA-Z0-9_]|$) で囲んでマッチさせる
      const re = new RegExp(`(^|[^a-zA-Z0-9_])${v}(?=[^a-zA-Z0-9_]|$)`, 'g');
      expr = expr.replace(re, `$1(${val})`);
    }
    // 置換後は数字・空白・演算子・括弧・指数記号のみであるべき
    if (!/^[\d\s+\-*/().eE]+$/.test(expr)) return null;
    const result = evalArith(expr);
    return Number.isFinite(result) ? result : null;
  } catch { return null; }
};

// シンプルな算術式評価 (eval 不使用、安全)
export const evalArith = (s) => {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/()'.includes(c)) { tokens.push(c); i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.eE+\-]/.test(s[j])) {
        if ((s[j] === '+' || s[j] === '-') && j > i && s[j - 1] !== 'e' && s[j - 1] !== 'E') break;
        j++;
      }
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error('bad num');
      tokens.push(num);
      i = j;
      continue;
    }
    throw new Error('bad char');
  }
  const out = []; const op = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3 };
  let prev = null;
  for (const t of tokens) {
    if (typeof t === 'number') { out.push(t); prev = t; continue; }
    if (t === '(') { op.push(t); prev = t; continue; }
    if (t === ')') {
      while (op.length && op[op.length - 1] !== '(') out.push(op.pop());
      if (op.pop() !== '(') throw new Error('paren');
      prev = t; continue;
    }
    let oper = t;
    if ((oper === '+' || oper === '-') && (prev === null || prev === '(' || (typeof prev === 'string' && '+-*/'.includes(prev)))) {
      if (oper === '-') oper = 'u-';
      else { prev = t; continue; }
    }
    while (op.length && op[op.length - 1] !== '(' && prec[op[op.length - 1]] >= prec[oper]) out.push(op.pop());
    op.push(oper);
    prev = t;
  }
  while (op.length) { const x = op.pop(); if (x === '(') throw new Error('paren'); out.push(x); }
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') { st.push(t); continue; }
    if (t === 'u-') { const a = st.pop(); st.push(-a); continue; }
    const b = st.pop(); const a = st.pop();
    if (t === '+') st.push(a + b);
    else if (t === '-') st.push(a - b);
    else if (t === '*') st.push(a * b);
    else if (t === '/') { if (b === 0) throw new Error('div0'); st.push(a / b); }
  }
  if (st.length !== 1) throw new Error('eval');
  return st[0];
};

// ブロックゲージのプリセット値
export const BLOCK_GAUGE_PRESETS = [
  1.0, 1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007, 1.008, 1.009,
  1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09,
  1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
  2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0,
  20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0
];

// 計算方式の定義
export const CALCULATION_METHODS = [
  { value: 'max-min', label: '最大-最小', desc: '入力値の最大と最小の差' },
  { value: 'sum', label: '合計', desc: '全入力値の合計 (例: ブロックゲージ+ダイヤルゲージ)' },
  { value: 'average', label: '平均', desc: '入力値の平均' },
  { value: 'group-max-min', label: 'グループ別最大差', desc: 'グループ(A,B,C,D) 各グループ内の最大-最小 → さらに最大' },
  { value: 'rows-diff', label: '通りの差', desc: 'グループ(A,B,C,D) 各グループの平均値同士の差 (最大-最小)' },
  { value: 'diff', label: '2点間の差', desc: '対象入力2つの差 (1点目-2点目)。3つ以上の場合は最初と最後の差' },
  { value: 'abs-max', label: '絶対値の最大', desc: '入力値の絶対値の中で最大' },
  { value: 'formula', label: 'カスタム数式', desc: '自由な計算式 例: (b+c)/2+d/2。他の計算IDも変数として使用可能' }
];

// 計算の上限 (UI と保存両方で参照)
export const MAX_CALCULATIONS = 20;

// 入力値を「グループ」に分類する共通ロジック
// 1) input.group が明示的に設定されていればそれを使う
// 2) なければ ID の英字プレフィックス (数字を除いた部分) でグループ化
export const groupKeyFor = (input) => {
  if (input?.group) return String(input.group);
  if (input?.id) return String(input.id).replace(/[0-9]/g, '') || '_default';
  return '_default';
};
