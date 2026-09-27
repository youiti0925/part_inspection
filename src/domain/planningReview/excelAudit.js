import { DEFAULT_SHEET_MAP, parseK33Cell, parseShipCell, cellToYMD } from '../progressSheet.js';
import { parseDay } from './placement.js';

const text = x => x == null ? '' : String(x).trim();
const value = (sheet, col, row) => sheet?.[`${col}${row}`]?.v;
const shown = (sheet, col, row) => sheet?.[`${col}${row}`]?.w ?? value(sheet, col, row) ?? '';
const half = s => text(s).replace(/[０-９／]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
function dateProblems(raw, referenceDate) {
  if (typeof raw !== 'string') return [];
  const s = half(raw);
  const full = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(s); // 区切りは / . - のどれか(- は角かっこの最後なので文字どおり)
  if (full) {
    const ymd = `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
    if (!parseDay(ymd)) return ['invalid-date'];
    if (s.slice(full[0].length).trim()) return ['date-with-note'];
    return [];
  }
  const found = [...s.matchAll(/(\d{1,2})\/(\d{1,2})/g)];
  if (found.some(m => !parseDay(`${referenceDate.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`))) return ['invalid-date'];
  if (found.some(m => cellToYMD(`${m[1]}/${m[2]}`, referenceDate)?.slice(0, 4) !== referenceDate.slice(0, 4))) return ['year-rollover'];
  return [];
}
const labels = {
  'invalid-date': '存在しない日付です。別の日に直して取り込まないでください。',
  'date-with-note': '日付の後ろに文字があります。取消などの意味を確認してください。',
  'year-rollover': '年のない日付を現在の取込処理が翌年に変えます。対象年を確認してください。',
};

/** XLSX cell model in, review data out. Never edits workbook cells or creates lots.
 * This reports source inconsistencies, before shipped-row/template eligibility.
 * No absence of findings is represented as a guaranteed shippable plan.
 */
export function auditProgressWorkbook(workbook, { referenceDate, sheetMap = DEFAULT_SHEET_MAP } = {}) {
  if (!parseDay(referenceDate)) throw new Error('照合の基準日を YYYY-MM-DD で指定してください');
  const sheets = workbook?.Sheets || {};
  const sheet = sheets[sheetMap.sheetName];
  if (!sheet) throw new Error(`シート「${sheetMap.sheetName}」がありません`);
  const cols = sheetMap.cols;
  const primaryLabel = sheetMap.k33Means === 'due' ? '納期の基準' : '入荷';
  const last = Number(/\d+$/.exec(sheet['!ref'] || '')?.[0]);
  if (!(last > 0 && last <= 100000)) throw new Error('シートの行範囲を確認できません');
  const issues = [], rows = [], seen = new Map();
  const counts = { sourceRows: 0, numericOrders: 0, excludedIdentifiers: 0, shipReadable: 0, shipMarked: 0, shipBlank: 0, shipUnreadable: 0, shipBeforePrimary: 0, splitDatesCollapsed: 0, blankArrivalWithDueColumn: 0 };
  const add = (r, code, message, cells, severity = 'review', extra = {}) => issues.push({ row: r.row, orderNo: r.orderNo, model: r.model, code, message, cells, severity, ...extra });
  const finalSheet = sheets['最終検査状況'];
  const finalByOrder = new Map();
  for (const [key, cell] of Object.entries(finalSheet || {})) if (/^E\d+$/.test(key) && text(cell.v)) {
    const n = Number(key.slice(1)), id = text(cell.v);
    const evidence = { sheet: '最終検査状況', row: n, inspection: shown(finalSheet, 'C', n), shipment: shown(finalSheet, 'D', n), stage: value(finalSheet, 'K', n), progress: value(finalSheet, 'L', n) };
    finalByOrder.set(id, [...(finalByOrder.get(id) || []), evidence]);
  }
  for (let row = sheetMap.firstDataRow; row <= last; row++) {
    const orderNo = text(value(sheet, cols.orderNo, row));
    if (!orderNo) continue;
    counts.sourceRows++;
    const r = { row, orderNo, model: text(value(sheet, cols.model, row)), quantity: value(sheet, cols.qty, row) };
    const rawZ = value(sheet, cols.k33, row), rawShip = value(sheet, cols.shipDate, row);
    const z = parseK33Cell(rawZ, referenceDate), ship = parseShipCell(rawShip, referenceDate);
    if (ship.ymd) { counts.shipReadable++; if (ship.mark) counts.shipMarked++; }
    else if (!text(rawShip)) counts.shipBlank++; else counts.shipUnreadable++;
    if (!/^\d+$/.test(orderNo)) { counts.excludedIdentifiers++; continue; }
    counts.numericOrders++;
    if (seen.has(orderNo)) add(r, 'duplicate-order', '同じ指図が複数行にあります。分割か重複かを確認してください。', [`${cols.orderNo}${seen.get(orderNo)}`, `${cols.orderNo}${row}`]);
    seen.set(orderNo, row);
    const invalid = new Set();
    for (const col of [cols.k33, cols.assyDone, cols.start, cols.shipDate].filter(Boolean)) {
      for (const code of dateProblems(value(sheet, col, row), referenceDate)) {
        invalid.add(col); add(r, code, labels[code], [`${col}${row}`], 'error');
      }
    }
    const open = z.parts.filter(p => p.mark !== 'Z');
    const distinct = new Set(open.map(p => p.ymd));
    if (distinct.size > 1) {
      counts.splitDatesCollapsed++;
      add(r, 'split-dates-collapsed', `台ごとの${primaryLabel}予定が、現在の取込では最初の日付にまとまります。`, [`${cols.k33}${row}`, `${cols.qty}${row}`], 'error', { parts: open });
    }
    if (/[①-⑳]/.test(text(rawZ)) && z.parts.length && z.parts.reduce((n, p) => n + p.count, 0) !== Number(r.quantity)) {
      add(r, 'split-quantity-mismatch', '丸数字の台数合計と指図数量が一致しません。', [`${cols.k33}${row}`, `${cols.qty}${row}`]);
    }
    if (!invalid.has(cols.k33) && !invalid.has(cols.shipDate) && z.ymd && ship.ymd && ship.ymd < z.ymd) {
      counts.shipBeforePrimary++;
      add(r, 'shipment-before-primary', `出荷予定が${primaryLabel}より前です。予定の更新漏れや列の読み方を確認してください。`, [`${cols.k33}${row}`, `${cols.shipDate}${row}`], 'review', { primaryDate: z.ymd, shipment: ship.ymd, note: text(value(sheet, 'AE', row)), related: finalByOrder.get(orderNo) || [] });
    }
    if (sheetMap.k33Means === 'arrival' && z.kind === 'blank' && cellToYMD(value(sheet, cols.start, row), referenceDate)) {
      counts.blankArrivalWithDueColumn++;
      const formula = sheet[`${cols.start}${row}`]?.f || '';
      const header = text(value(sheet, cols.start, 1));
      // Recognize this exact workbook's demonstrable reference, not arbitrary formulas.
      const srcEndHeader = text(value(sheets['工機生産表'], 'H', 2));
      if (header.includes('開始') && srcEndHeader.includes('終了') && /VLOOKUP\([^,]+,工機生産表!\$B\$3:\$AG\$999,7,FALSE\)/i.test(formula)) {
        add(r, 'base-header-reference-mismatch', '元表の見出しは開始日、数式の参照先は終了日です。現在の取込では納期として使います。見出しだけで入荷日と解釈しないでください。', [`${cols.start}${row}`, '工機生産表!H2']);
      }
    }
    rows.push({ ...r, primaryDate: z.ymd, shipment: ship.ymd, rawPrimary: shown(sheet, cols.k33, row), rawShipment: shown(sheet, cols.shipDate, row), parts: z.parts });
  }
  return { referenceDate, primaryLabel, sheetName: sheetMap.sheetName, sourceLabel: text(value(sheet, 'D', 1)), scope: '元表の照合。出荷済・テンプレ割当など、取込対象の絞り込み前。', counts, rows, issues };
}
