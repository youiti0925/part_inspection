// =============================================================================
//  domain/progressSheetAudit.js — 進捗管理表の **元表の食い違い** を数える(純関数)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-14):
//    「エクセルにはヒューマンエラーで失敗していて矛盾することもあるから、そこも発見できたらいいね」
//  ChatGPT が実物(工機進捗管理表)で見つけた物(2026-09-12〜14):
//    ・出荷予定が入荷より前の行 10件 / 台ごとの入荷が分かれている 3行 / 丸数字の合計と台数が違う 4行
//    ・「2台9/9・4台9/10」が取込で「6台全部9/9」になる
//
//  🚨 ここは **数えて並べるだけ**。取込は止めない・セルを直さない・行を落とさない。
//     何を取り込むかは planProgressImport(progressSheet.js)が決める。ここは同じ行を別の目で見る。
//  🚨 数字は取込の件数と **別の物**(元表の行の数。灰色=出荷済の行は見ない)。画面はその事を書く。
//  🚨 日付の読み方は progressSheet.js の物をそのまま使う(cellToYMD / parseK33Cell / parseShipCell)。
//     ここで別の読み方を作らない(同じ数字を2つの計算から出さない)。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

import { cellToYMD, parseK33Cell, parseShipCell, parseQty, describeDueCell, dateTextProblem } from './progressSheet.js';

const str = (v) => (v == null ? '' : String(v).trim());
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 食い違いの種類。label は画面にそのまま出す。hint は「どう見ればよいか」。 */
export const AUDIT_CODES = Object.freeze({
  dup:                 { label: '同じ指図が2行以上', hint: '分けて書いた行か、写し間違いかを表で確かめてください' },
  shipBeforeArrival:   { label: '出荷日が入荷より前', hint: '入荷の日か出荷日のどちらかが古いままです' },
  dueColBeforeArrival: { label: '納期の列が入荷より前', hint: '入荷の日か納期の列のどちらかが古いままです' },
  shipBeforeDueCol:    { label: '出荷日が納期の列より前', hint: '納期の列(基準終了日付)より早く出荷する予定になっています' },
  // 2026-09-23 (R6) 説明を実装に合わせた: 取込は便(済でない日と台数)をロットへ一緒に渡す(planProgressImport の arrivalSplits)。「表でだけ分かる」は誤り
  splitArrival:        { label: '入荷が2回以上に分かれている', hint: '取込は 済(Z)でない最初の日を入荷にし、済でない日と台数は便(分納)としてロットへ一緒に渡します' },
  splitDueCol:         { label: '納期の基準の日が2つ以上', hint: 'この表ではこの列は入荷ではなく納期の基準です。取込は 済(Z)でない最初の日を使います' },
  splitQtyMismatch:    { label: '丸数字の台数の合計が台数と違う', hint: '残りの台数や済みの台数の書き方かもしれません。誤りと決めつけないでください' },
  yearRollover:        { label: '年の無い日付を来年と読んだ', hint: '今日より90日以上前の M/D は来年として読みます(印や丸数字が付いていても同じ)。年が違えば表に年を書いてください' },
  // 2026-09-23 ChatGPT の枝(planning-input-review)の excelAudit.js に在って ここに無かった3つ(invalid-date / date-with-note / base-header-reference-mismatch)
  invalidDate:         { label: '実在しない日付', hint: '2/30・13/1 のような日付は読みません(別の日に直しません)。表の字を直してから取り込んでください' },
  dateWithNote:        { label: '日付の後ろに字がある', hint: '「6/1 予定」「9/20 取消」のような注記です。取消は読みません。それ以外は日付の部分だけを読むので、意味を確かめてから表を直してください' },
  baseHeaderReferenceMismatch: { label: '納期の列の見出しは開始日・数式の参照先は終了日', hint: '取込はこの列を納期として使います。見出しだけで入荷の日と読まないでください' },
});

const CIRCLED_RE = /[①-⑳]/;
/** 元表(K20-221)で確かめた数式の形(工機生産表の 7列目 = 基準終了日付)。これ以外の数式は当てにいかない(excelAudit.js と同じ) */
const BASE_END_FORMULA_RE = /VLOOKUP\([^,]+,工機生産表!\$B\$3:\$AG\$999,7,FALSE\)/i;

/**
 * @param {Array} rows   取込に渡すのと同じ行(row, orderNo, model, qty, k33, assyDone, start, shipDate, isGray, startFormula?)
 *   startFormula … 納期の列(AB)の数式の字(在れば)。App が exceljs の cell.value.formula から渡す。無ければ見出しと数式の食い違いは見ない
 * @param {object} ctx
 *   today     'YYYY-MM-DD' か Date(M/D に年を補う)
 *   labels    { k33:'Z', assyDone:'Y', start:'AB', shipDate:'AD' } 画面に出す列の字
 *   k33Means  'arrival'(既定) | 'due'。'due' の時は Z列を入荷とは呼ばない(入荷との比較は出さない)
 *   startHeader      納期の列の見出しの字(1行目)。sourceEndHeader 参照先の表(工機生産表)の H2 の字。どちらも無ければ見出しと数式の食い違いは見ない
 * @returns {{ rowsSeen:number, rowsChecked:number, issues:Array, counts:object, codes:object }}
 *   issues[] = { row, orderNo, model, code, label, cells:[{col, text}], detail }
 */
export function auditProgressRows(rows, ctx = {}) {
  const today = ctx.today || null;
  const L = isObj(ctx.labels) ? ctx.labels : {};
  const colK33 = str(L.k33) || 'Z';
  const colAssy = str(L.assyDone) || 'Y';
  const colStart = str(L.start) || 'AB';
  const colShip = str(L.shipDate) || 'AD';
  const colQty = str(L.qty) || 'E';
  const colOrder = str(L.orderNo) || 'B';
  const k33IsArrival = ctx.k33Means !== 'due';
  const headerSaysStart = str(ctx.startHeader).includes('開始');
  const sourceSaysEnd = str(ctx.sourceEndHeader).includes('終了');
  const thisYear = (() => {
    if (today instanceof Date) return today.getFullYear();
    const m = /^(\d{4})-/.exec(str(today));
    return m ? Number(m[1]) : null;
  })();

  const issues = [];
  const counts = {};
  const add = (r, code, cells, detail = '') => {
    const c = AUDIT_CODES[code];
    if (!c) return;
    counts[code] = (counts[code] || 0) + 1;
    issues.push({ row: r.row, orderNo: str(r.orderNo), model: str(r.model), code, label: c.label, cells, detail });
  };
  const textOf = (v) => (v instanceof Date ? (cellToYMD(v) || '') : str(v));

  const seen = new Map();
  let rowsSeen = 0; let rowsChecked = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!isObj(r)) continue;
    rowsSeen += 1;
    if (r.isGray) continue;                     // 出荷済の行は取込も見ない。ここも見ない
    const orderNo = str(r.orderNo);
    if (!orderNo) continue;
    rowsChecked += 1;

    // ① 同じ指図が2行以上
    if (seen.has(orderNo)) add(r, 'dup', [{ col: `${colOrder}${seen.get(orderNo)}`, text: orderNo }, { col: `${colOrder}${r.row}`, text: orderNo }]);
    else seen.set(orderNo, r.row);

    const k33 = parseK33Cell(r.k33, today);
    const ship = parseShipCell(r.shipDate, today);
    const dueCol = cellToYMD(r.start, today);
    const arrival = k33IsArrival ? k33.ymd : null;

    // ② 日付の前後
    if (arrival && ship.ymd && ship.ymd < arrival) add(r, 'shipBeforeArrival', [{ col: `${colK33}${r.row}`, text: textOf(r.k33) }, { col: `${colShip}${r.row}`, text: textOf(r.shipDate) }], `入荷 ${arrival} ／ 出荷 ${ship.ymd}`);
    if (arrival && dueCol && dueCol < arrival) add(r, 'dueColBeforeArrival', [{ col: `${colK33}${r.row}`, text: textOf(r.k33) }, { col: `${colStart}${r.row}`, text: textOf(r.start) }], `入荷 ${arrival} ／ 納期の列 ${dueCol}`);
    if (ship.ymd && dueCol && ship.ymd < dueCol) add(r, 'shipBeforeDueCol', [{ col: `${colStart}${r.row}`, text: textOf(r.start) }, { col: `${colShip}${r.row}`, text: textOf(r.shipDate) }], `納期の列 ${dueCol} ／ 出荷 ${ship.ymd}`);

    // ③ 分かれた入荷(済でない日が2つ以上)。取込の入荷は最初の日。便(日と台数)はロットへ一緒に渡る
    //    🚨 2026-09-23 (R6) この列が納期の基準(k33Means='due')なら「入荷」と呼ばない(splitDueCol)
    if (k33.kind === 'multi') {
      const open = k33.parts.filter((p) => p.mark !== 'Z' && p.ymd);
      const distinct = [...new Set(open.map((p) => p.ymd))];
      if (distinct.length >= 2) {
        add(r, k33IsArrival ? 'splitArrival' : 'splitDueCol', [{ col: `${colK33}${r.row}`, text: k33.raw }],
          open.map((p) => `${p.count}台 ${p.ymd}`).join(' ／ ') + `（取込は ${distinct[0]} だけ` + (k33IsArrival ? `・便 ${distinct.length}つは分納として渡す）` : '）'));
      }
      // ④ 丸数字の合計と台数
      const q = parseQty(r.qty);
      if (q.ok && CIRCLED_RE.test(k33.raw) && k33.parts.length) {
        const sum = k33.parts.reduce((n, p) => n + (Number.isFinite(p.count) ? p.count : 0), 0);
        if (sum !== q.value) add(r, 'splitQtyMismatch', [{ col: `${colK33}${r.row}`, text: k33.raw }, { col: `${colQty}${r.row}`, text: str(r.qty) }], `丸数字の合計 ${sum}台 ／ 台数 ${q.value}台`);
      }
    }

    // ⑤ 年の無い日付を来年と読んだ。
    //    🚨 2026-09-23 (R5) 素の M/D だけでなく 印付き('M6/1')・丸数字付き('①1/10')も同じ。
    //    年を補ったかは読み手(parseK33Cell / parseShipCell / describeDueCell)が言う。ここで正規表現を増やさない
    if (thisYear != null) {
      const over = (ymd) => !!ymd && Number(ymd.slice(0, 4)) > thisYear;
      const rolled = [];
      if (k33.yearGuessed && (over(k33.ymd) || k33.parts.some((p) => over(p.ymd)))) rolled.push({ col: `${colK33}${r.row}`, text: str(r.k33) });
      if (typeof r.start === 'string' && describeDueCell(r.start, today).yearGuessed && over(dueCol)) rolled.push({ col: `${colStart}${r.row}`, text: str(r.start) });
      if (ship.yearGuessed && over(ship.ymd)) rolled.push({ col: `${colShip}${r.row}`, text: str(r.shipDate) });
      if (rolled.length) add(r, 'yearRollover', rolled, rolled.map((c) => `${c.text} → ${thisYear + 1}年`).join(' ／ '));
    }

    // ⑥ 実在しない日付(13/1・2026/2/30) ／ 日付の後ろに字(「6/1 予定」「9/20 取消」)。取込はどちらも読まない(黙って別の日にしない)
    //    読み方は progressSheet.js の dateTextProblem(mdToYMD と同じ範囲・実在の決まり)
    const bad = { invalidDate: [], dateWithNote: [] };
    for (const [col, v] of [[colK33, r.k33], [colAssy, r.assyDone], [colStart, r.start], [colShip, r.shipDate]]) {
      const p = dateTextProblem(v, today);
      if (p === 'invalid') bad.invalidDate.push({ col: `${col}${r.row}`, text: str(v) });
      else if (p === 'note') bad.dateWithNote.push({ col: `${col}${r.row}`, text: str(v) });
    }
    if (bad.invalidDate.length) add(r, 'invalidDate', bad.invalidDate, bad.invalidDate.map((c) => `${c.col} "${c.text}" は読まない`).join(' ／ '));
    if (bad.dateWithNote.length) add(r, 'dateWithNote', bad.dateWithNote, bad.dateWithNote.map((c) => `${c.col} "${c.text}" は読まない`).join(' ／ '));

    // ⑦ 納期の列の見出しは「開始」なのに、数式の参照先は工機生産表の「終了」の列(excelAudit.js から移した)。
    //    入荷(Z)が空で納期の列だけ在る行に出す(その行は納期の列から入荷を逆算するので、見出しだけで入荷と読むと違う日になる)。
    //    ⚠ 数式(r.startFormula)・見出し(ctx.startHeader / ctx.sourceEndHeader)は App が exceljs から渡す。無ければ見ない(当てずっぽうにしない)
    if (k33IsArrival && k33.kind === 'blank' && dueCol && headerSaysStart && sourceSaysEnd && BASE_END_FORMULA_RE.test(str(r.startFormula))) {
      add(r, 'baseHeaderReferenceMismatch', [{ col: `${colStart}${r.row}`, text: textOf(r.start) }, { col: '工機生産表!H2', text: str(ctx.sourceEndHeader) }], `見出し「${str(ctx.startHeader)}」／ 数式 ${str(r.startFormula).slice(0, 60)}`);
    }
  }
  issues.sort((a, b) => (a.row - b.row) || a.code.localeCompare(b.code));
  return { rowsSeen, rowsChecked, issues, counts, codes: AUDIT_CODES };
}

/** 画面の見出しに出す1文。何も無ければ ''。 */
export function auditSummaryText(audit) {
  if (!isObj(audit) || !Array.isArray(audit.issues) || !audit.issues.length) return '';
  const parts = Object.entries(audit.counts || {}).map(([code, n]) => `${(AUDIT_CODES[code] || {}).label || code} ${n}行`);
  return `元表で食い違っている行 ${audit.issues.length}件（${parts.join('・')}）`;
}
