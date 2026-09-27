// ============================================================================
// 📊 工機進捗管理表(Excel)の取込 —— 「1行をどう扱うか」を決める純関数
// ----------------------------------------------------------------------------
// 清水さん(2026-09-09):「一回製品でこれを渡したら自動で変更する機能あったと思うけど、それって完璧？
//   今の検査リストの状況と照らし合わせてほしい、後おかしなところあったら直してかつもっと良い機能にしてほしい」
//
// 🚨 なぜ純関数として切り出したか:
//   今までは App.jsx の handleProgressMgmtUpload の中に判定が全部埋まっていて、
//   **本番の写しと Excel を突き合わせて確かめる手段が無かった**(画面から押すしかない)。
//   ここに出せば node --test で回せるし、本番の写し(バックアップ)+実物の Excel で答え合わせができる。
//
// 📄 進捗管理表シートの列(2026-09-09 の実物 K20-221(4) で確認):
//   B 指図番号 / C 品目コード / D 品目 Text(型式) / E 指図数量
//   Y 組立の完了予定日(自動計算)   Z K33 = 中間製品検査(このアプリの検査)の予定日   AB F30 基準開始日付(組立の開始)
//   行の塗り: 灰色 = 出荷済
//   Z列の書き方: 日付 / 「-」(検査終了) / 空 / 「①Z8/28①Z8/31」(丸数字=台数・Z=済・Y=予定・M=未定)
//
// ⚠ React も firebase も import しない(node --test で回すため)。
// ⚠ 関数の中で Date.now() を呼ばない(today は呼び出し側が渡す)。同じ入力なら毎回同じ結果。
// ============================================================================

import { resolveEntriesForModel } from './importPlan.js';
import { makeIsWorkday, prevWorkdayYmd } from './factoryCalendar.js';
import { dueCancelled } from './dueDefense.js';

/** 実在する日か(2/30・4/31 を弾く)。new Date は黙って 3/2 に化かすので、化けたら「読めない」。 */
const isRealYmdParts = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };

/** 行を捨てた／残した理由。画面にそのまま出す文なので、ここ1箇所で持つ。 */
export const PS_REASON = Object.freeze({
  ORDER_NOT_NUMERIC: '指図が数字でない（試験部品など・検査対象外）',
  SHIPPED_GRAY: '灰色行: 出荷済の可能性',
  K33_DASH: 'Z列="-": 検査終了済',
  K33_ALL_DONE: 'Z列が全部 Z(済): 検査終了済',
  NO_MODEL: '型式が空',
  PARTS: 'PARTS品 (検査対象外)',
  NO_DATE: '日付の列がどれも読めません',   // 割付で列を1つも指定していない時だけここへ来る
  NO_MASTER: '型式マスタに型式の登録なし',
  NO_TEMPLATE_ASSIGNED: '」にテンプレ未割当',   // 画面では `「型式」にテンプレ未割当`(本番と同じ言い回し)
  TEMPLATE_MISSING: 'テンプレ未存在',
  // 🏁 最終検査(1行=1ロット)で使う。表の「詳細(工程)」「進捗」が終わりを指している行。
  STAGE_DONE: '詳細(工程)が終わっている',
  PROGRESS_DONE: '進捗が終わっている',
  NO_TEMPLATE_ID: '1行=1ロットの取込なのに、使うテンプレが決まっていない',
  // 📦 台数(指図数量)。2026-09-10: parseInt が 1.5→1・"2abc"→2 と黙って切り捨てていた(ChatGPT が発見)。
  QTY_EMPTY: '台数（指図数量）が空です。表に台数を入れてから取り込んでください',
  QTY_INVALID: '台数が正の整数ではない',   // 画面では `台数が正の整数ではない: 1.5`(不正な値をそのまま添える)
});

/**
 * 🧭 1行を何個のロットにするか。**アプリごとに形が違う**ので、ここで名前を付けて分ける。
 *
 *   MODEL_MASTER … 製品検査。型式マスタを引いて、その型式に登録されたテンプレの数だけロットを作る。
 *   SINGLE       … 最終検査(golden)。型式マスタも テンプレの割当も無い(1ロット=1指図・
 *                  テンプレは 'final_inspection_std' 固定)。型式マスタを引かず、行そのままで1ロット。
 *
 * 🚨 既定は MODEL_MASTER。渡さなければ製品検査の動きと1ミリも変わらない。
 */
export const PS_MODE = Object.freeze({
  MODEL_MASTER: 'model-master',
  SINGLE: 'single',
});

/** 納期の基準に使った列。画面で「どの列から決めた日付か」を必ず出す。 */
/**
 * 🏷 「その納期は どの列の どの日から作ったか」の言い方(既定の列の字での形)。
 * 🚨 2026-09-11 清水さんの説明で列の意味が変わった。
 *   それまで K33 は 'Z'(＝検査予定日そのもの)だった。今は Z列は **入荷** なので、
 *   Z しか日付が無い行の納期は「入荷の日から作った仮の納期」になる。
 */
export const BASE_SOURCE = Object.freeze({
  DUE_COL: 'AB列 納期',                    // 清水さん「AB列自身は納期として設定して良い」
  K33: 'Z列 入荷日から(仮)',                // Z(入荷)しか日付が無い行の最後の手段
  K33_DUE: 'Z列',                          // その表の k33 が「納期の基準」の時(最終検査状況シートの C列)
  K33_MULTI: 'Z(複数)',                     // 「①9/9④9/10」の中の、済(Z)でない最初の日付
  ASSY_DONE: 'Y列 組立完了予定から(仮)',     // 組立の完了予定日。他に何も無い行の仮置き
  START: 'AB列 納期',                       // 昔の名前(AB列)。DUE_COL と同じ物
});

// ---------------------------------------------------------------------------
// 日付まわり(その土地の時刻で数える)
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
export const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYMD = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  if (dt.getFullYear() !== +m[1] || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) return null;
  return dt;
};
const shiftDays = (ymd, days) => {
  const dt = parseYMD(ymd);
  if (!dt) return '';
  dt.setDate(dt.getDate() + (Number.isFinite(days) ? days : 0));
  return ymdOf(dt);
};
const ymdHHMMToMs = (ymd, hhmm = '08:30') => {
  const dt = parseYMD(ymd);
  if (!dt) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()) || [null, '8', '30'];
  dt.setHours(Math.min(23, +m[1]), Math.min(59, +m[2]), 0, 0);
  return dt.getTime();
};

/**
 * セルの生の値 → 'YYYY-MM-DD' か null。
 *   Date / 'YYYY-MM-DD' / 'YYYY/M/D' / Excelシリアル / 'M/D'(年は today から補う)
 * ⚠ 文字列の中に丸数字や Z/Y が混ざる物(「①Z8/28」)はここでは読まない。parseK33Cell が受け持つ。
 */
export const cellToYMD = (v, today) => {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : ymdOf(v);
  if (typeof v === 'number') {
    if (v > 59 && v < 80000) { const dt = new Date(Math.round((v - 25569) * 86400000)); return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`; }
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  // 🚨 2026-09-22 取消の注記(「2026/9/25（取消）」)を予定にしない。先頭が日付でも後ろに取消が付けば読まない
  if (dueCancelled(s)) return null;
  let m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(s);
  // 🚨 2026-09-22 '2026/2/30' を 3/2 に化かさない(打ち間違いは「読めない」。別の日へ戻さない)
  if (m) return isRealYmdParts(+m[1], +m[2], +m[3]) ? ymdOf(new Date(+m[1], +m[2] - 1, +m[3])) : null;
  m = /^(\d{1,2})[/\-.](\d{1,2})$/.exec(s);
  if (m && today) return mdToYMD(+m[1], +m[2], today);
  return null;
};

/**
 * 'M/D' に年を補う。今日より90日以上前なら来年(進捗管理表は先の予定を書く表)。
 * 🚨 2026-09-23 (ChatGPT の指摘 R3) '13/1' を来年の 1/1 に化かさない。
 *   月は 1〜12・日は 1〜31・補った年で実在する日だけ読む。読めなければ null(cellToYMD と同じ「読めない」)。
 */
const mdToYMD = (month, day, today) => {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const t = today instanceof Date ? today : (parseYMD(today) || new Date(2000, 0, 1));
  let year = t.getFullYear();
  let dt = new Date(year, month - 1, day);
  if (dt.getTime() < t.getTime() - 90 * 86400000) { year += 1; dt = new Date(year, month - 1, day); }
  return isRealYmdParts(year, month, day) ? ymdOf(dt) : null;
};

/** 年を書いていない 'M/D' の字か(今日から年を補った = 推定)。印(K/M/Z…)や丸数字を外した **日付の部分** に使う。 */
const isMDWithoutYear = (s) => /^\d{1,2}[/\-.]\d{1,2}$/.test(String(s || '').trim());

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const toHalf = (s) => String(s || '').replace(/[０-９／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const toHalfAlpha = (s) => String(s || '').replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/**
 * 🔎 日付の字の **打ち間違い・注記** を見つける(数を作らない。元表の食い違い(progressSheetAudit)が使う)。
 *   'invalid' … 実在しない日付(2026/2/30・13/1・4/31)。取込は読まない(null)ので、黙って別の日にはならない
 *   'note'    … 日付の前後に字がある(「6/1 予定」「2026/9/20取消」)。取込は黙って読まない
 *   ''        … 問題なし(日付でない字・Date・数値も '')
 * ⚠ 丸数字(①)・済/予定/未定の印(Z/Y/M)・出荷の印(K/M/L/Y)・時刻は表の書き方なので注記ではない。
 * 🚨 読み方(月日の範囲・実在)は mdToYMD / isRealYmdParts と同じ物(同じ数字を2つの計算から出さない)。
 */
export const dateTextProblem = (v, today) => {
  if (typeof v !== 'string') return '';
  // 出荷の印(K/M/L/Y)は parseShipCell と同じく先頭から外す(印は注記ではない)
  const s = toHalfAlpha(toHalf(v)).trim().replace(/^[KMLY]\s*(?=\d)/i, '');
  if (!s) return '';
  const TIME_RE = /\d{1,2}:\d{2}(:\d{2})?/g;
  const FULL_RE = /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/g;
  const fulls = [...s.matchAll(FULL_RE)];
  if (fulls.length) {
    if (fulls.some((f) => !isRealYmdParts(+f[1], +f[2], +f[3]))) return 'invalid';
    return s.replace(FULL_RE, '').replace(TIME_RE, '').trim() ? 'note' : '';
  }
  const MD_RE = /(\d{1,2})[/\-.](\d{1,2})/g;
  const mds = [...s.matchAll(MD_RE)];
  if (!mds.length) return '';
  if (mds.some((m) => !mdToYMD(+m[1], +m[2], today))) return 'invalid';
  const rest = s.replace(MD_RE, '').replace(TIME_RE, '').replace(/[①-⑳ZYMKLzymkl\s]/g, '');
  return rest ? 'note' : '';
};

/**
 * Z列(K33 検査予定日)の1セルを読む。
 * @returns {{ kind: 'date'|'dash'|'blank'|'multi'|'text', ymd: string|null, parts: Array<{count:number, mark:string, ymd:string|null}>, allDone: boolean, raw: string, yearGuessed: boolean, unreadable: number }}
 *   kind='multi' のとき ymd は **済(Z)でない最初の日付**(無ければ null)。allDone = 全部が Z(済)。
 *   ⚠ 「M」(未定)は日付が無いのが普通なので、日付の付いた物だけ parts に入る。
 *   yearGuessed … 年を書いていない M/D から今日で年を補った(印・丸数字付きでも同じ)。監査が「来年と読んだ」を出す元。
 *   unreadable  … 実在しない日付(13/1・4/31)の数。その部分は ymd:null で parts に残す(済(Z)の数や台数の合計を狂わせない)。
 *                 🚨 済でない最初の部分が読めなければ ymd は null(別の日を入荷にしない)。全部読めなければ kind='text'。
 */
export const parseK33Cell = (v, today) => {
  const base = { parts: [], allDone: false, raw: '', yearGuessed: false, unreadable: 0 };
  if (v == null) return { ...base, kind: 'blank', ymd: null };
  if (v instanceof Date) return { ...base, kind: 'date', ymd: cellToYMD(v) };
  if (typeof v === 'number') { const y = cellToYMD(v); return y ? { ...base, kind: 'date', ymd: y, raw: String(v) } : { ...base, kind: 'text', ymd: null, raw: String(v) }; }
  const raw = String(v).trim();
  if (!raw) return { ...base, kind: 'blank', ymd: null, raw };
  if (raw === '-' || raw === 'ー' || raw === '－') return { ...base, kind: 'dash', ymd: null, raw };
  // 🚨 2026-09-23 取消の注記(「9/25（取消）」)を丸数字の読み方で拾って入荷にしない(cellToYMD と同じ決まり)
  if (dueCancelled(raw)) return { ...base, kind: 'text', ymd: null, raw };
  const plain = cellToYMD(raw, today);
  if (plain && /^[\d/\-.: ]+$/.test(raw)) return { ...base, kind: 'date', ymd: plain, raw, yearGuessed: isMDWithoutYear(toHalf(raw)) };
  // 「①Z8/28①Z8/31」「②9/9④9/10」「①Y9/9」「⑭7/８」
  const parts = [];
  const re = /([①-⑳])?\s*([ZYM])?\s*(\d{1,2})\/(\d{1,2})/g;
  const half = toHalf(raw);
  let m;
  while ((m = re.exec(half))) {
    const count = m[1] ? CIRCLED.indexOf(m[1]) + 1 : 1;
    const mark = m[2] || '';
    const ymd = mdToYMD(+m[3], +m[4], today);
    parts.push({ count, mark, ymd });
  }
  const unreadable = parts.filter(p => !p.ymd).length;
  if (!parts.length || unreadable === parts.length) return { ...base, kind: 'text', ymd: null, raw, unreadable };
  const open = parts.filter(p => p.mark !== 'Z');
  const allDone = open.length === 0;
  return { kind: 'multi', ymd: open.length ? open[0].ymd : null, parts, allDone, raw, yearGuessed: true, unreadable };
};

// ---------------------------------------------------------------------------
// 📐 表の割付(どのシートの どの列を読むか)
// ----------------------------------------------------------------------------
// 清水さん(2026-09-09):「今の進捗管理のExcelが今後同じものであり続けることもないと思うから、
//   その場合、カスタマイズできるようにしておいてね、列とかシート名とかExcel名とかファイル場所とかね」
// 🚨 既定は今の実物(K20-221(4))の形。設定で1つずつ上書きできる。
//   列は「B」のような **列の字** で持つ(人が Excel で見て確かめられる形)。
// ---------------------------------------------------------------------------

/** 製品検査(中間製品検査)の既定。進捗管理表シートの Z列(K33)が検査予定日。 */
/**
 * 🏷 k33 の列が「何の日」か。表によって違うので、推測させないで 表の割付が字で持つ(2026-09-11)。
 *   arrival … その列は **入荷の日**(製品検査の進捗管理表 Z列。清水さん「Z列は入荷時間ね」)
 *   due     … その列は **納期の基準**(最終検査状況シート C列。今までと同じ読み方)
 */
export const K33_MEANS = Object.freeze({ ARRIVAL: 'arrival', DUE: 'due' });

/**
 * 🔑 納期と入荷を「何から決めたか」。**人が読む字ではなく、機械が読む印**。
 * 🚨 これをロットに残さないと、型式マスタの日数を後から変えた時に
 *   modelMasterPropagate が「どの日数を足せばよいか」を当てずっぽうで決める事になる
 *   (＝同じ数字を2つの計算から出す。2026-08-30 の決まりで禁止)。
 */
export const DUE_BASIS = Object.freeze({
  SHIP: 'ship',       // 出荷日の列 − 型式マスタの shipDaysBefore
  DUE_COL: 'dueCol',  // 納期の列そのもの(型式マスタの日数は効かない)
  ARRIVAL: 'arrival', // 入荷の列 ＋ 型式マスタの daysBefore(仮)
  ASSY: 'assy',       // 組立の完了予定(仮。型式マスタの日数は効かない)
});
export const ENTRY_BASIS = Object.freeze({
  ARRIVAL_COL: 'arrivalCol', // 表に書いてある本物の入荷日(型式マスタの日数で動かさない)
  FROM_DUE_COL: 'fromDueCol', // 納期の列 − 型式マスタの entryDaysBefore
  FROM_DUE: 'fromDue',        // 決まった納期 − 型式マスタの entryDaysBefore
});

export const DEFAULT_SHEET_MAP = Object.freeze({
  sheetName: '進捗管理表',
  firstDataRow: 3,          // 1・2行目は見出し
  // 🚨 stage/progress は製品検査の表には無い(空)。それでも **鍵は置いておく**。
  //   normalizeSheetMap は base.cols の鍵しか写さないので、鍵が片方に無いと
  //   最終検査の割付を製品検査の既定で正した瞬間に「詳細・進捗」が黙って消え、
  //   終わっている行を作り直してしまう。
  // 🚚 shipDate(AD列) … 清水さん(2026-09-10)「出荷日を進捗管理表のどの列から読みますか → これはAD列だね」
  cols: Object.freeze({ orderNo: 'B', productNo: 'C', model: 'D', qty: 'E', k33: 'Z', assyDone: 'Y', start: 'AB', shipDate: 'AD', stage: '', progress: '' }),
  // 🚚 2026-09-11 清水さん「まずZ列は入荷時間ね」「AB列自身は納期として設定して良い」
  //   「AD列には出荷日があって…こっちが一番大事な納期になる」
  k33Means: 'arrival',
  // 🚚 出荷日(AD列)の何日前までに検査を終えるか。清水さん「その日に検査をしていたら出荷ができない」
  //   型式マスタにその型式の日数が入っていればそちらが勝つ。ここは入っていない型式の既定。
  shipDaysBefore: 1,
  grayIsShipped: true,      // 灰色の行は出荷済とみなす
  doneStages: Object.freeze([]),    // 製品検査の表に「詳細(工程)」の欄は無い(空=何も見ない)
  doneProgress: Object.freeze([]),  // 同上
  fileHint: '工機進捗管理表',  // ファイル名の目安(選ぶ時の確認に使うだけ。強制はしない)
  fileNote: '',             // 置き場所のメモ(人が読むだけ)
});

/** 最終検査の既定。最終検査状況シート。1行=1ロット(型式マスタでの展開はしない)。 */
export const FINAL_SHEET_MAP = Object.freeze({
  sheetName: '最終検査状況',
  firstDataRow: 3,
  // ⚠ 最終検査状況シートに出荷日の欄は無い。鍵だけ置く(鍵が片方に無いと normalizeSheetMap で黙って消える)。
  cols: Object.freeze({ orderNo: 'E', productNo: '', model: 'G', qty: 'I', k33: 'C', assyDone: '', start: '', shipDate: '', stage: 'K', progress: 'L' }),
  // 🏁 最終検査状況シートの C列は **納期の基準**(入荷の日ではない)。今までと同じ読み方。
  k33Means: 'due',
  shipDaysBefore: 0,        // 最終検査状況シートに出荷日の列は無い(使われない)
  grayIsShipped: false,
  doneStages: Object.freeze(['出荷']),        // この工程まで進んでいたら 最終検査は終わっている
  doneProgress: Object.freeze(['完了']),      // 進捗が「完了」なら終わっている
  fileHint: '工機進捗管理表',
  fileNote: '',
});

/** 'B' → 1(0始まり) / 'AB' → 27。読めなければ -1。 */
export const colToIndex = (letter) => {
  const t = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(t)) return -1;
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
/** 1(0始まり) → 'B'。 */
export const indexToCol = (idx) => {
  let n = Number(idx);
  if (!Number.isFinite(n) || n < 0) return '';
  let out = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

/**
 * 設定の割付を、既定で穴埋めして正す。人が入れた小文字・全角・空白を吸収する。
 * 🚨 読めない列の字は **空** にする(黙って別の列を読まない)。
 */
export const normalizeSheetMap = (map, base = DEFAULT_SHEET_MAP) => {
  const m = map && typeof map === 'object' ? map : {};
  const cols = {};
  for (const key of Object.keys(base.cols)) {
    const raw = (m.cols && m.cols[key] !== undefined) ? m.cols[key] : base.cols[key];
    const up = String(raw == null ? '' : raw).trim().replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase();
    cols[key] = /^[A-Z]{1,3}$/.test(up) ? up : '';
  }
  const firstRow = parseInt(m.firstDataRow, 10);
  return {
    sheetName: String(m.sheetName == null || m.sheetName === '' ? base.sheetName : m.sheetName).trim(),
    firstDataRow: Number.isFinite(firstRow) && firstRow >= 1 ? firstRow : base.firstDataRow,
    cols,
    k33Means: (m.k33Means === K33_MEANS.ARRIVAL || m.k33Means === K33_MEANS.DUE) ? m.k33Means : (base.k33Means || K33_MEANS.ARRIVAL),
    shipDaysBefore: (m.shipDaysBefore === null || m.shipDaysBefore === undefined || m.shipDaysBefore === '' || !Number.isFinite(Number(m.shipDaysBefore)))
      ? (Number.isFinite(Number(base.shipDaysBefore)) ? Number(base.shipDaysBefore) : 1)
      : Number(m.shipDaysBefore),
    grayIsShipped: m.grayIsShipped === undefined ? base.grayIsShipped : !!m.grayIsShipped,
    doneStages: Array.isArray(m.doneStages) ? m.doneStages.map(String) : [...(base.doneStages || [])],
    doneProgress: Array.isArray(m.doneProgress) ? m.doneProgress.map(String) : [...(base.doneProgress || [])],
    fileHint: String(m.fileHint == null ? base.fileHint : m.fileHint),
    fileNote: String(m.fileNote == null ? (base.fileNote || '') : m.fileNote),
  };
};

// ---------------------------------------------------------------------------
// 📚 表ごとの割付(プロファイル)
// ---------------------------------------------------------------------------
/**
 * 🚨 2026-09-11 清水さん
 *   「Excel毎で形式が変わるから、Excel毎(進捗データのExcelは何種類もあって
 *     今は一種類だけあるような感じになってる)の取込みカスタマイズできるように」
 *
 * それまで割付は settings.progressSheetMap の **1個だけ** だった。
 * 表が2種類来たら、片方を取り込むたびに列を打ち直す事になる(打ち間違えると黙って0件)。
 *
 * 入れ物:
 *   settings.progressSheetProfiles = [{ id, name, map }]
 *   settings.progressSheetProfileId = いま選んでいる id
 * ⚠ 今までの settings.progressSheetMap は **消さない**。
 *   プロファイルが1件も無い時は、それを「いまの表」1件として読む(今までと1ミリも変わらない)。
 *   選んだプロファイルは progressSheetMap にも書き戻す(古い画面・古い道が読んでも同じ答えになる)。
 */
export const PROFILE_DEFAULT_NAME = 'いまの表';

/** 名前から id を作る(同じ名前が2つ在っても別の id になる)。 */
export const makeProfileId = (seed) => `ps_${String(seed || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * 設定 → 表ごとの割付の一覧と、いま選んでいる物。
 * @returns {{ profiles: Array<{id,name,map}>, activeId: string, active: object }}
 */
export const normalizeSheetProfiles = (settings, base = DEFAULT_SHEET_MAP) => {
  const st = settings && typeof settings === 'object' ? settings : {};
  const raw = Array.isArray(st.progressSheetProfiles) ? st.progressSheetProfiles : [];
  const profiles = raw
    .filter(p => p && typeof p === 'object')
    .map((p, i) => ({
      id: String(p.id || '').trim() || `ps_${i}`,
      name: String(p.name == null || p.name === '' ? `表${i + 1}` : p.name).trim(),
      map: normalizeSheetMap(p.map, base),
    }));
  if (profiles.length === 0) {
    // 今までの1個だけの割付を、そのまま1件目として読む(消さない・作り直さない)
    profiles.push({ id: 'ps_default', name: PROFILE_DEFAULT_NAME, map: normalizeSheetMap(st.progressSheetMap, base) });
  }
  const wanted = String(st.progressSheetProfileId || '').trim();
  const active = profiles.find(p => p.id === wanted) || profiles[0];
  return { profiles, activeId: active.id, active: active.map };
};

/** いま選んでいる表の割付だけが欲しい時。 */
export const activeSheetMap = (settings, base = DEFAULT_SHEET_MAP) => normalizeSheetProfiles(settings, base).active;

/**
 * 一覧と選んだ id → 保存する形。
 * 🚨 選んだ物は progressSheetMap にも同じ中身を書く(古い道が読んでも答えが割れない)。
 */
export const profilesToSettings = (profiles, activeId, base = DEFAULT_SHEET_MAP) => {
  const list = (Array.isArray(profiles) ? profiles : [])
    .filter(p => p && typeof p === 'object')
    .map((p, i) => ({
      id: String(p.id || '').trim() || makeProfileId(String(i)),
      name: String(p.name == null || p.name === '' ? `表${i + 1}` : p.name).trim(),
      map: normalizeSheetMap(p.map, base),
    }));
  if (list.length === 0) list.push({ id: 'ps_default', name: PROFILE_DEFAULT_NAME, map: normalizeSheetMap(null, base) });
  const act = list.find(p => p.id === activeId) || list[0];
  return {
    progressSheetProfiles: list,
    progressSheetProfileId: act.id,
    progressSheetMap: act.map,
  };
};

/**
 * 📄 開いた Excel から「どの表か」を当てる。
 * 🚨 当てられない時は **null**。勝手に1件目を使わない(違う表の列で読むと黙って0件 or 大量に消える)。
 * @param {string[]} sheetNames  そのブックに入っているシート名
 * @param {string}   fileName    ファイル名(目安。無くてもよい)
 * @param {Array}    profiles    normalizeSheetProfiles の profiles
 * @returns {{ profile:object, why:string }|null}
 */
export const guessProfile = (sheetNames, fileName, profiles) => {
  const names = (Array.isArray(sheetNames) ? sheetNames : []).map(n => String(n || '').trim()).filter(Boolean);
  const list = Array.isArray(profiles) ? profiles : [];
  const file = String(fileName || '').trim();
  const bySheet = list.filter(p => p && p.map && names.includes(String(p.map.sheetName || '').trim()));
  if (bySheet.length === 1) return { profile: bySheet[0], why: `「${bySheet[0].map.sheetName}」シートが在ります` };
  if (bySheet.length > 1 && file) {
    const byFile = bySheet.filter(p => p.map.fileHint && file.includes(String(p.map.fileHint)));
    if (byFile.length === 1) return { profile: byFile[0], why: `シートとファイル名（${byFile[0].map.fileHint}）の両方が合います` };
  }
  return null;
};

/** 割付の穴。押す前に画面へ出す(読めない列があると黙って0件になるため)。 */
export const sheetMapProblems = (map, base = DEFAULT_SHEET_MAP) => {
  const m = normalizeSheetMap(map, base);
  const out = [];
  if (!m.sheetName) out.push('シート名が空です');
  if (!m.cols.orderNo) out.push('指図番号の列が読めません（A〜ZZ の列の字で入れてください）');
  if (!m.cols.model) out.push('型式の列が読めません');
  if (!m.cols.k33) out.push('検査予定日の列が読めません');
  const seen = new Map();
  for (const [k, v] of Object.entries(m.cols)) {
    if (!v) continue;
    if (seen.has(v)) out.push(`列 ${v} が「${seen.get(v)}」と「${k}」で重なっています`);
    else seen.set(v, k);
  }
  return out;
};

/**
 * 🚚 AD列(出荷予定日)の読み方。清水さん(2026-09-10)「出荷日は AD列だね」。
 *
 * 実物の見出し(工機進捗管理表 2026-09-09):
 *   「出荷 予定日 K：確認 M:マトメ L:リミット Y:予定 ／ 出荷日当日着引当日」
 * つまり **日付の前に印が付く事がある**(実測 M9/7・Ｙ9/14 など22行)。
 *
 * 実物 538行の内訳(まとめ役が数えた 2026-09-10):
 *   素の日付 201 ／ 印つきの日付 22 ／ 空 78 ／ 日付でない字 237
 *   (日付でない字の例: 「16時引取」「確認要」「確認中」「残③」「注意」「未完了」「(金)」「しTGS」「L」)
 * 🚨 だから **読めない字を黙って捨てない**。読めた物だけ出荷日にし、読めなかった物は raw で返す
 *   (呼ぶ側が「何行が日付でなかったか」を言える様にする)。
 *
 * @param {*} raw   セルの生の値(Date / 数 / 文字)
 * @param {string|Date} today  'M/D' に年を補うための今日
 * @returns {{ymd:string|null, mark:string, raw:string}}
 *   ymd  … 'YYYY-MM-DD'。読めなければ null
 *   mark … 'K'|'M'|'L'|'Y'|''(印なし)。K:確認 M:マトメ L:リミット Y:予定
 */
export const parseShipCell = (raw, today) => {
  const direct = cellToYMD(raw, today);
  // yearGuessed: 年を書いていない M/D から今日で年を補った(印付き 'M6/1' でも同じ)。監査が「来年と読んだ」を出す元(2026-09-23 R5)
  if (direct) return { ymd: direct, mark: '', raw: raw instanceof Date ? direct : String(raw ?? '').trim(), yearGuessed: typeof raw === 'string' && isMDWithoutYear(toHalf(raw)) };
  const t = toHalfAlpha(toHalf(String(raw ?? ''))).trim();
  if (!t) return { ymd: null, mark: '', raw: '', yearGuessed: false };
  const m = /^([KMLY])\s*(.+)$/i.exec(t);
  if (m) {
    const y = cellToYMD(m[2].trim(), today);
    if (y) return { ymd: y, mark: m[1].toUpperCase(), raw: t, yearGuessed: isMDWithoutYear(m[2]) };
  }
  return { ymd: null, mark: '', raw: t, yearGuessed: false };
};

/**
 * 納期の元セルの読み取りの札(取込の確認画面が「元セル／読んだ日付／年の推定」を並べる為)。数を作らない。
 * 🚨 2026-09-23 (R5) 読み方は decideRowDates と同じ3本(cellToYMD → 印付き parseShipCell → 丸数字 parseK33Cell)。
 *   それまでは cellToYMD だけだったので、'M6/1' や '①9/9' から納期を作った行が画面で「読めない」と出て、年の推定も付かなかった。
 * @returns {{ raw:string, kind:'empty'|'cancelled'|'unreadable'|'date', yearGuessed:boolean }}
 */
export const describeDueCell = (v, today) => {
  if (v == null || String(v).trim() === '') return { raw: '', kind: 'empty', yearGuessed: false };
  const raw = v instanceof Date ? ymdOf(v) : String(v).trim();
  if (dueCancelled(raw)) return { raw, kind: 'cancelled', yearGuessed: false };
  if (cellToYMD(v, today)) return { raw, kind: 'date', yearGuessed: typeof v === 'string' && isMDWithoutYear(toHalf(raw)) };
  const ship = parseShipCell(v, today);
  if (ship.ymd) return { raw, kind: 'date', yearGuessed: ship.yearGuessed };
  const k33 = parseK33Cell(v, today);
  if (k33.ymd) return { raw, kind: 'date', yearGuessed: k33.yearGuessed };
  return { raw, kind: 'unreadable', yearGuessed: false };
};

/**
 * 📅 1行から「入荷の日」と「納期」を決める。
 *
 * 🚨 2026-09-11 清水さんの説明で **列の意味を直した**。
 *   それまでは Z列を「検査予定日」と読み、そこから納期を作り、納期の N日前を入荷にしていた。
 *   本当の意味は次のとおり(清水さんの言葉):
 *     ・Z列  = **入荷時間**。正確な日。ただし「その週とか日に近くないと入力されない」ので空が多い。
 *     ・AB列 = **納期**として設定してよい。
 *     ・AD列 = **出荷日**。必ず出荷日。入っているなら **これが一番大事な納期**。
 *              ただし出荷の当日に検査していては出荷できないので、
 *              型式マスタの「出荷の何日前までに検査を終えるか」だけ前へ倒す。
 *     ・Z列が無い時は AB列から 型式マスタの「二日前・三日前」を引いて **仮の入荷** にする。
 *
 * ⚠ 分からない事は埋めない(2026-07-10 の決まり)。読めなかった列は source に出し、
 *   仮で置いた物は provisional=true にして画面で分かる様にする。
 *
 * @param {object} r    1行。{ k33, start, shipDate, assyDone } は Excel の生の値
 * @param {object} ctx
 *   today            'YYYY-MM-DD' か Date(M/D に年を補うのに使う)
 *   entryDaysBefore  入荷は納期の何日前か(型式マスタ → 既定)
 *   shipDaysBefore   出荷日の何日前を納期にするか(型式マスタ → 既定)
 *   k33DaysBefore    Z列しか日付が無い時だけ効く昔のオフセット(型式マスタ daysBefore)
 *   labels           { k33:'Z', start:'AB', shipDate:'AD', assyDone:'Y' } 画面に出す列の字
 * @returns {{
 *   dueDate:string|null, dueSource:string, dueProvisional:boolean,
 *   entryYMD:string|null, entrySource:string, entryProvisional:boolean,
 *   ship:{ymd:string|null,mark:string,raw:string}, warnings:string[]
 * }}
 */
export function decideRowDates(r, ctx = {}) {
  const {
    today = null, entryDaysBefore = 3, shipDaysBefore = 1, k33DaysBefore = 0,
    labels = null,
    // 🚨 同じ鍵(k33)でも 表によって意味が違う。製品検査の進捗管理表は Z列=**入荷**、
    //   最終検査状況シートは C列=**納期の基準**。推測させないで、表の割付が字で持つ。
    k33Means = K33_MEANS.ARRIVAL,
  } = ctx;
  const k33IsDue = k33Means === K33_MEANS.DUE;
  const L = { k33: 'Z', start: 'AB', shipDate: 'AD', assyDone: 'Y', ...(labels || {}) };
  const warnings = [];
  const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const entryDays = num(entryDaysBefore, 3);
  const shipDays = num(shipDaysBefore, 1);
  const k33Days = num(k33DaysBefore, 0);

  // --- 出荷日(AD列)。印(K:確認 M:マトメ L:リミット Y:予定)が付く事がある ---
  const ship = parseShipCell(r.shipDate, today);
  // --- 納期の列(AB列) ---
  const dueCol = cellToYMD(r.start, today);
  // --- 入荷の列(Z列)。丸数字の済み・複数日付は parseK33Cell が読む ---
  const arr = parseK33Cell(r.k33, today);
  const arrivalYMD = (arr.kind === 'date' || (arr.kind === 'multi' && arr.ymd)) ? arr.ymd : null;

  // ========== 納期 ==========
  let dueDate = null; let dueSource = ''; let dueProvisional = false; let dueBase = null; let dueBasis = '';
  if (k33IsDue && arrivalYMD) {
    // この表では k33 の列そのものが納期の基準(最終検査状況シートの C列)。今までと同じ決め方。
    dueBase = arrivalYMD;
    dueDate = shiftDays(arrivalYMD, k33Days);
    dueSource = `${L.k33}列`; dueBasis = DUE_BASIS.ARRIVAL;
  } else if (ship.ymd) {
    dueBase = ship.ymd;
    dueDate = shiftDays(ship.ymd, -shipDays);
    dueSource = shipDays === 0 ? `${L.shipDate}列 出荷日` : `${L.shipDate}列 出荷日の${shipDays}日前`;
    dueBasis = DUE_BASIS.SHIP;
  } else if (dueCol) {
    dueBase = dueCol;
    dueDate = dueCol; dueSource = `${L.start}列 納期`; dueBasis = DUE_BASIS.DUE_COL;
  } else if (arrivalYMD) {
    // 出荷日も納期の列も無い。入荷の日しか無いので、昔の読み方(Z列＋オフセット)で仮に置く。
    dueBase = arrivalYMD;
    dueDate = shiftDays(arrivalYMD, k33Days);
    dueSource = `${L.k33}列 入荷日から(仮)`; dueProvisional = true; dueBasis = DUE_BASIS.ARRIVAL;
  } else {
    const y = cellToYMD(r.assyDone, today);
    if (y) { dueBase = y; dueDate = y; dueSource = `${L.assyDone}列 組立完了予定から(仮)`; dueProvisional = true; dueBasis = DUE_BASIS.ASSY; }
  }

  // ========== 入荷 ==========
  let entryYMD = null; let entrySource = ''; let entryProvisional = false; let entryBasis = ''; let entryBase = null;
  if (k33IsDue) {
    if (dueDate) { entryBase = dueDate; entryYMD = shiftDays(dueDate, -entryDays); entrySource = `納期の${entryDays}日前(仮)`; entryProvisional = true; entryBasis = ENTRY_BASIS.FROM_DUE; }
  } else if (arrivalYMD) {
    entryBase = arrivalYMD; entryYMD = arrivalYMD; entrySource = `${L.k33}列 入荷日`; entryBasis = ENTRY_BASIS.ARRIVAL_COL;
  } else if (dueCol) {
    // 清水さん「Z列が無いときは AB列に対して 型式マスタで登録されてる二日前とか三日前とかが入荷時間」
    entryBase = dueCol;
    entryYMD = shiftDays(dueCol, -entryDays);
    entrySource = `${L.start}列の${entryDays}日前(仮)`; entryProvisional = true; entryBasis = ENTRY_BASIS.FROM_DUE_COL;
  } else if (dueDate) {
    entryBase = dueDate;
    entryYMD = shiftDays(dueDate, -entryDays);
    entrySource = `納期の${entryDays}日前(仮)`; entryProvisional = true; entryBasis = ENTRY_BASIS.FROM_DUE;
  }

  // 🚨 入荷が納期より後ろになったら黙って通さない(検査する時間が1日も無い形)。
  if (dueDate && entryYMD && entryYMD > dueDate) {
    warnings.push(`入荷(${entryYMD} / ${entrySource})が 納期(${dueDate} / ${dueSource})より後ろです`);
  }
  return {
    dueDate, dueSource, dueProvisional, dueBase, dueBasis,
    // 📅 納期の基準にした **元のセル** と その読み取り(年を補ったか・取消・読めない)。画面が並べて人が照合する
    dueCell: describeDueCell(dueBasis === DUE_BASIS.SHIP ? r.shipDate : dueBasis === DUE_BASIS.DUE_COL ? r.start : dueBasis === DUE_BASIS.ASSY ? r.assyDone : r.k33, today),
    entryYMD, entrySource, entryProvisional, entryBasis, entryBase,
    // 🚨 検査する時間が1日も無い行。呼ぶ側が数えて画面に出す(黙って作らない)
    entryAfterDue: !!(dueDate && entryYMD && entryYMD > dueDate),
    ship, arrival: arr, warnings,
  };
}

/** 見出しの字から列を探す時の言い回し。表の形が変わったら ここに足す。 */
export const HEADER_WORDS = Object.freeze({
  orderNo: [/指図番号/, /^指図$/, /製造指図/],
  productNo: [/品目コード/, /^品目$/],
  model: [/品目Text/i, /^型式$/],
  qty: [/指図数量/, /^数量$/, /^台数$/, /^梱包$/],
  k33: [/中間.*製品.*検査/, /検査予定日/, /^納期$/],
  assyDone: [/組立.*完了.*予定/, /完了予定日/],
  start: [/基準開始日付/, /^開始$/],
  // ⚠ 「出荷」だけの見出しは拾わない(最終検査状況シートの D列が「出荷」で、あちらは日付の列ではない)
  shipDate: [/出荷予定日/, /^出荷日$/],
  stage: [/^詳細$/, /^工程$/],
  progress: [/^進捗$/, /^状態$/],
});

/**
 * 見出しの字から列を探す(表の形が変わった時の助け)。
 * @param headerRows 見出しの行の配列。各行は列ごとの文字列の配列(0始まり)
 * @returns { [key]: 'B' }  見つかった物だけ
 */
export const detectColumns = (headerRows, want = null) => {
  const WANT = want || HEADER_WORDS;
  const rows = Array.isArray(headerRows) ? headerRows : [];
  const found = {};
  const width = rows.reduce((n, r) => Math.max(n, (r || []).length), 0);
  for (const [key, pats] of Object.entries(WANT)) {
    for (let c = 0; c < width && !found[key]; c++) {
      // 見出しの空白は全部落として突き合わせる。
      // 全角の空白は字のまま書くと見分けが付かないので、番号(バックスラッシュ u3000)で書く。
      const text = rows.map(r => String((r || [])[c] == null ? '' : (r || [])[c])).join(' ').replace(/[\s\u3000]+/g, '');
      if (!text) continue;
      if (pats.some(p => p.test(text))) found[key] = indexToCol(c);
    }
  }
  return found;
};

/**
 * 🩶 灰色行(出荷済)の判定。2026-09-16 清水さん「進捗管理表で登録を何回もしているのに検査リストにない」。
 *   実物(工機進捗管理表 (2).xlsx 2026-09-09)の実測:
 *     ・H〜J列(8〜10列目)は **全部の行** が灰色(theme:0 tint:-0.25)の固定の塗り。
 *     ・本当に出荷した行は 指図(B)・型式(D)・数量(E)の欄まで灰色。
 *     ・直す前は 1〜10列目の半分以上が灰色なら出荷済 → 指図が橙(FFC000)で生きている行
 *       (1001514417 / 1001554525 / 1001514485)が 6列中3列(H〜J)で「出荷済」に落ちていた。
 *       落ちた行は検査リストに入らず、組立が到着予定を登録できなかった(🆕 の連絡が並ぶ原因)。
 *   決め方: **指図の欄が灰色** なら出荷済。指図が塗られていない時だけ、1〜6列目のうち2列以上が灰色なら出荷済。
 *     H〜J列(固定の灰色)は見ない。
 * @param {Array<{col:number, fgColor:object|null}>} fills  塗りの在るセル(1始まりの列番号と fgColor)
 * @param {object} [o]
 * @param {number} [o.orderCol=2]  指図の列(1始まり)
 * @param {number[]} [o.idCols]     指図が塗られていない時に見る列(既定 1〜6)
 */
export function isShippedGrayFills(fills, { orderCol = 2, idCols = [1, 2, 3, 4, 5, 6] } = {}) {
  const isGray = (fg) => !!fg && fg.theme === 0 && typeof fg.tint === "number" && fg.tint < -0.1 && fg.tint > -0.5;
  const list = Array.isArray(fills) ? fills.filter((f) => f && Number.isFinite(Number(f.col))) : [];
  const order = list.find((f) => Number(f.col) === Number(orderCol));
  if (order && order.fgColor) return isGray(order.fgColor);
  const grayIn = list.filter((f) => idCols.includes(Number(f.col)) && isGray(f.fgColor)).length;
  return grayIn >= 2;
}

/**
 * 🔎 「指図で検索しても出てこない」に、なぜ一覧に無いかを答える(2026-09-16 組立からのクレーム)。
 *   言えるのは 元データに在る事だけ:
 *     open      … 一覧に在る(未完了)                → 出てこないのは検索の問題
 *     completed … 検査が終わっている                → もう一度検査する分なら 🆕 で知らせる
 *     skipped   … 最後の取込で落ちた(理由つき)       → 検査側に伝える(型式マスタに無い・灰色行 等)
 *     deleted   … 最後の取込で一覧から消した(理由つき)
 *     unknown   … 最後の取込の表に載っていない／取込の記録が無い
 * @param {object} o
 * @param {string} o.orderNo   探した指図(全角の数字も受ける)
 * @param {Array}  [o.lots]    アプリのロット(完了も含む)
 * @param {object} [o.importLast] settings.progressImportLast({ at, skipped:[{orderNo,model,reason}], deleted:[…] })
 * @returns {{kind:string, text:string}|null}  指図の形でなければ null
 */
export function explainMissingOrder({ orderNo, lots = [], importLast = null } = {}) {
  const o = String(orderNo == null ? '' : orderNo).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!/^\d{5,}$/.test(o)) return null;
  const ymd = (ms) => { const d = new Date(Number(ms)); return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}` : '日付不明'; };
  const same = (Array.isArray(lots) ? lots : []).filter((l) => l && String(l.orderNo || '').trim() === o);
  const open = same.filter((l) => l.status !== 'completed');
  if (open.length) return { kind: 'open', text: `指図 ${o} は検査の一覧に在ります（${open.length}件・${open.map((l) => l.model || '型式なし').join('・')}）` };
  if (same.length) {
    const last = same.slice().sort((a, b) => (Number(b.completedAt) || 0) - (Number(a.completedAt) || 0))[0];
    return { kind: 'completed', text: `指図 ${o} は検査が終わっています（${same.length}件・完了 ${ymd(last.completedAt)}）。もう一度検査する分なら「検査リストに無いもの」として知らせてください` };
  }
  const il = importLast && typeof importLast === 'object' ? importLast : null;
  const find = (arr) => (Array.isArray(arr) ? arr.find((x) => x && String(x.orderNo || '').trim() === o) : null);
  const sk = il ? find(il.skipped) : null;
  if (sk) return { kind: 'skipped', text: `指図 ${o} は 進捗管理表の取込（${ymd(il.at)}）で「${sk.reason}」として検査の一覧に入っていません（型式 ${sk.model || '不明'}）。検査側に伝えてください` };
  const del = il ? find(il.deleted) : null;
  if (del) return { kind: 'deleted', text: `指図 ${o} は 進捗管理表の取込（${ymd(il.at)}）で「${del.reason}」として検査の一覧から消しています。検査側に伝えてください` };
  if (il) return { kind: 'unknown', text: `指図 ${o} は 最後の取込（${ymd(il.at)}）の進捗管理表に載っていません。表に無いか、取込より後に増えた指図です` };
  return { kind: 'unknown', text: `指図 ${o} は検査の一覧に在りません（取込の記録もありません）` };
}

/** 指図番号は数字だけ(SAP の指図)。A104… の試験部品などは検査対象外。 */
export const isNumericOrder = (orderNo) => /^\d+$/.test(String(orderNo || '').trim());

/**
 * 📦 台数(指図数量)の読み方。**正の整数だけ** を受ける。
 *   🚨 2026-09-10 まで parseInt(…, 10) だった → 1.5 は 1、"2abc" は 2 に **黙って** 切り捨てていた。
 *   ・全角の数字("３")は半角に直して受ける(表は手で打つ事がある)。
 *   ・小数(1.5)・文字混じり("2abc")・0・負(-1)・空("")は不正。丸めない・推測しない(2026-07-10 の決まり)。
 * @returns {{ ok:boolean, value:number|null, raw:string, empty:boolean }}
 *   ok=true … value が台数。 ok=false … empty=true なら空、false なら「正の整数ではない」。
 */
export const parseQty = (v) => {
  const raw = String(v == null ? '' : v).trim();
  if (raw === '') return { ok: false, value: null, raw, empty: true };
  const half = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!/^[0-9]+$/.test(half)) return { ok: false, value: null, raw, empty: false };
  const n = Number(half);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, value: null, raw, empty: false };
  return { ok: true, value: n, raw, empty: false };
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 進捗管理表の行の一覧 → 取込の計画。
 *
 * @param {Array} rows  1行 = {
 *     row: number(Excelの行番号), orderNo, productNo, model, qty,
 *     k33: Date|string|null(Z列の生の値), assyDone: Date|string|null(Y列), start: Date|string|null(AB列),
 *     shipDate: Date|string|null(AD列の生の値。出荷日),
 *     isGray: boolean(灰色行=出荷済)
 *   }
 * @param {object} ctx
 *   lots            アプリのロット(全部。完了も含む)
 *   modelMasters / qualityStandards / modelStandardMap / templates   型式マスタとテンプレ
 *   today           'YYYY-MM-DD' か Date。M/D に年を補うのに使う(🚨 Date.now() はここで呼ばない)
 *   options         { entryHHMM:'08:30', defaultEntryDaysBefore:3, calendar:null, includeProvisional:true,
 *                     mode:'model-master'|'single', singleTemplateId:'', singleDaysBefore:0, singleEntryDaysBefore:null,
 *                     doneStages:[], doneProgress:[], doneMatch:'order+template'|'order', entryPinned:{} }
 *     mode='single' … 型式マスタを引かず、1行=1ロット(最終検査)。テンプレは singleTemplateId 固定。
 *     doneStages / doneProgress … 表の「詳細(工程)」「進捗」がこの言葉なら、その行は終わっている
 *                                 (取り込まず、アプリに残っていれば stale に出す)。既定は空 = 何も見ない。
 *     doneMatch     … 「アプリではもう検査が終わっている」を何で当てるか。
 *                     'order+template'(既定・製品検査。同じ指図でもテンプレが違えば別の検査)
 *                     'order'(最終検査。1指図=1ロットなので指図だけで当てる)
 *     entryPinned   … { lotId: entryAt(ms) }。工程連絡で人が入れた入荷時間。
 *                     今のロットの入庫と一致していたら **取込は動かさない**(人の判断が勝つ)。
 * @returns {{
 *   createLots, updateLots, unchangedLots, skipped, warnings,
 *   stale: Array<{lot, row, orderNo, model, reason, hasTasks}>,  // Excel では終わっているのにアプリに残っている
 *   alreadyDone: Array,                                          // 表ではまだ未完だが、アプリではもう検査が終わっている(二重に作らない)
 *   notInSheet: Array<{lot}>,                                     // アプリには在るが Excel の表に無い(数字の指図だけ)
 *   totalRows, counts
 * }}
 */
export function planProgressImport(rows, ctx = {}) {
  const {
    lots = [], modelMasters = {}, qualityStandards = {}, modelStandardMap = {}, templates = [],
    today = null, options = {},
  } = ctx;
  const opt = {
    entryHHMM: '08:30', defaultEntryDaysBefore: 3, calendar: null, includeProvisional: true,
    // 🚚 出荷日(AD列)の何日前までに検査を終えるか。型式マスタに無い時の既定(2026-09-11)。
    defaultShipDaysBefore: 1,
    // 🏷 k33 の列が「入荷の日」か「納期の基準」か。表の割付が持つ(既定は製品検査＝入荷)。
    k33Means: K33_MEANS.ARRIVAL,
    mode: PS_MODE.MODEL_MASTER, singleTemplateId: '', singleDaysBefore: 0, singleEntryDaysBefore: null,
    doneStages: [], doneProgress: [],
    // 🚨 「アプリではもう検査が終わっている」の当て方。既定は 指図×テンプレ(製品検査)。
    doneMatch: 'order+template',
    // 🚚 工程連絡で人が入れた入荷時間 { lotId: ms }。取込はこれを上書きしない。
    entryPinned: null,
    // 🏷 画面に出す「どの列から決めた日付か」の札。既定は製品検査の列(Z / Y / AB)。
    //   🚨 最終検査は検査予定日が C列(納期)なので、ここを渡さないと画面が「Z列」と嘘を言う。
    //      渡さなければ製品検査の文言と1文字も変わらない。
    colLabels: null,
    ...(options || {}),
  };
  const LAB = { k33: 'Z', assyDone: 'Y', start: 'AB', shipDate: 'AD', ...(opt.colLabels || {}) };
  // 「日付がどこにも無い」の言い方も、実際に見た列で作る(既定は今までの文言そのまま)。
  const noDateCols = [LAB.shipDate, LAB.start, LAB.k33, LAB.assyDone].filter(Boolean);
  const noDateReason = noDateCols.length === 0 ? PS_REASON.NO_DATE
    : (noDateCols.length === 1 ? `${noDateCols[0]}列に日付なし` : `${noDateCols.join('列・')}列ともに日付なし`);
  // 🚨 1行=1ロット(最終検査)かどうか。ここ1箇所だけで決める。
  const single = opt.mode === PS_MODE.SINGLE;
  const wordList = (v) => (Array.isArray(v) ? v : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  const doneStages = wordList(opt.doneStages);
  const doneProgress = wordList(opt.doneProgress);
  const worksOn = makeIsWorkday(opt.calendar);
  const toPrevWorkday = (ymd) => (parseYMD(ymd) ? (prevWorkdayYmd(ymd, worksOn) || ymd) : ymd);

  const out = { createLots: [], updateLots: [], unchangedLots: [], skipped: [], warnings: [], stale: [], alreadyDone: [], notInSheet: [], totalRows: 0, counts: {} };
  const isOpen = (l) => l && !(l.status === 'completed' || l.location === 'completed');
  /**
   * 🚨 「作業の記録がある」= 消してはいけない・台数と入庫を動かしてはいけない。
   *   ⚠ 2026-09-10: ここは tasks の有無だけを見ていた。製品検査の逐次モードは
   *     status:'processing' と workStartTime を **tasks を1件も書かずに** 保存する道がある
   *     (src/App.jsx の onSave)。その状態のロットは「記録なし」と読まれ、
   *     消してよい側に入っていた(消すのは取り消せない)。
   *     アプリの別の門(ロット編集の「作業着手後」判定)は status も見ているので、そちらへ揃える。
   */
  const hasWork = (l) => {
    if (!l) return false;
    if (l.tasks && Object.keys(l.tasks).length > 0) return true;
    if (l.status === 'processing' || l.status === 'paused') return true;
    if (Number(l.workStartTime) > 0) return true;
    if (Number(l.totalWorkTime) > 0) return true;
    if (Array.isArray(l.interruptions) && l.interruptions.length > 0) return true;
    if (Number(l.currentStepIndex) > 0) return true;
    return false;
  };
  const hasTasks = hasWork;   // 画面と見張りが今まで使っている名前(意味は「作業の記録がある」)
  const openByOrder = new Map();
  // 🏁 アプリではもう検査が終わっている指図(+テンプレ)。表は必ず1日ぶん古いので、
  //   昨日今日 終わった指図が表ではまだ未完のまま載っている → そのまま作ると二重になる。
  const doneOrders = new Set();
  const doneOrderTpl = new Set();
  for (const l of lots) {
    if (!isOpen(l)) {
      const k = String(l && l.orderNo || '').trim();
      if (k) { doneOrders.add(k); doneOrderTpl.add(`${k}::${String(l.templateId || '').trim()}`); }
      continue;
    }
    const k = String(l.orderNo || '').trim();
    if (!openByOrder.has(k)) openByOrder.set(k, []);
    openByOrder.get(k).push(l);
  }
  // 🚨 既定は「指図×テンプレ」。同じ指図でもテンプレが違えば別の検査なので、作ってよい。
  const isAlreadyDone = (orderNo, templateId) => (opt.doneMatch === 'order'
    ? doneOrders.has(String(orderNo).trim())
    : doneOrderTpl.has(`${String(orderNo).trim()}::${String(templateId || '').trim()}`));
  const pinnedEntry = (opt.entryPinned && typeof opt.entryPinned === 'object') ? opt.entryPinned : null;
  const sheetOrders = new Set();
  let qtyInvalidRows = 0;
  let shipUnreadableRows = 0;   // 🚚 AD列に字は在るのに日付として読めなかった行
  // 🚨 2026-09-11: 納期 = 出荷日 − N / 入荷 = Z列の実日 の2本立てにしたので、
  //   出荷日と入荷日が近い行では **入荷が納期の後ろ** へ回る事がある(実物で十数件)。
  //   これは表がそう言っているだけで捏造ではないので **作る**。ただし黙って作らない。
  //   押す前に件数を画面へ出す(新しく作る物と、既にあるロットの入庫を動かす物の両方)。
  //   → 件数は out.summary.entryAfterDueCreate / entryAfterDueUpdate で createLots/updateLots から数える(ここで別に数えない)。
  const tplById = new Map((templates || []).filter(t => t && t.id).map(t => [t.id, t]));

  const skip = (r, reason, extra = {}) => { out.skipped.push({ row: r.row, orderNo: r.orderNo, model: r.model || '(空)', reason, ...extra }); };
  const staleOf = (r, reason) => {
    for (const l of openByOrder.get(String(r.orderNo).trim()) || []) {
      out.stale.push({ lot: l, lotId: l.id, row: r.row, orderNo: r.orderNo, model: l.model || r.model, templateId: l.templateId, reason, hasTasks: hasTasks(l) });
    }
  };

  for (const r0 of rows || []) {
    const r = {
      ...r0,
      orderNo: String(r0.orderNo == null ? '' : r0.orderNo).trim(),
      model: String(r0.model == null ? '' : r0.model).trim(),
      productNo: String(r0.productNo == null ? '' : r0.productNo).trim(),
      stage: String(r0.stage == null ? '' : r0.stage).trim(),
      progress: String(r0.progress == null ? '' : r0.progress).trim(),
    };
    if (!r.orderNo) continue;                       // 指図の無い行(見出し・空行)は数えない
    if (!isNumericOrder(r.orderNo)) { skip(r, PS_REASON.ORDER_NOT_NUMERIC); continue; }
    out.totalRows++;
    sheetOrders.add(r.orderNo);
    const k33 = parseK33Cell(r.k33, today);

    // --- 終わっている行: 取り込まない。ただしアプリに残っていれば stale に出す ---
    if (r.isGray) { skip(r, PS_REASON.SHIPPED_GRAY); staleOf(r, PS_REASON.SHIPPED_GRAY); continue; }
    if (k33.kind === 'dash') { skip(r, PS_REASON.K33_DASH); staleOf(r, PS_REASON.K33_DASH); continue; }
    if (k33.kind === 'multi' && k33.allDone) { skip(r, PS_REASON.K33_ALL_DONE, { detail: k33.raw }); staleOf(r, PS_REASON.K33_ALL_DONE); continue; }
    // 🏁 最終検査の表は「詳細(工程)」「進捗」で終わりが分かる(Z列の丸数字は無い)。
    //   🚨 doneStages / doneProgress が空なら1行も落とさない = 製品検査は今までと同じ。
    if (r.stage && doneStages.includes(r.stage)) { skip(r, `${PS_REASON.STAGE_DONE}（${r.stage}）`); staleOf(r, PS_REASON.STAGE_DONE); continue; }
    if (r.progress && doneProgress.includes(r.progress)) { skip(r, `${PS_REASON.PROGRESS_DONE}（${r.progress}）`); staleOf(r, PS_REASON.PROGRESS_DONE); continue; }

    if (!r.model) { skip(r, PS_REASON.NO_MODEL); continue; }
    if (r.productNo.includes('PARTS')) { skip(r, PS_REASON.PARTS); continue; }

    // --- 日付が1つも無い行はここで落とす(納期も入荷も作れない) ---
    //   🚨 2026-09-11 清水さんの説明で列の意味を直した。決め方は decideRowDates ただ1本が持つ。
    //     Z列=入荷 / AB列=納期 / AD列=出荷日(これが一番大事な納期)。
    const probe = decideRowDates(r, { today, entryDaysBefore: opt.defaultEntryDaysBefore, shipDaysBefore: opt.defaultShipDaysBefore, k33DaysBefore: 0, labels: LAB, k33Means: opt.k33Means });
    if (!probe.dueDate) { skip(r, noDateReason, { detail: k33.raw }); continue; }
    // 仮(出荷日も納期の列も無く、入荷の日や組立完了予定から作った物)の扱いは今までどおり
    const provisional = probe.dueProvisional;
    if (provisional && !opt.includeProvisional) { skip(r, `${LAB.shipDate || 'AD'}列(出荷日)も ${LAB.start || 'AB'}列(納期)も無い（${probe.dueSource} の仮取込は OFF）`); continue; }
    // 🚚 2026-09-15 入荷が2回以上に分かれている行(「②9/9④9/10」)は、便を **そのまま** 渡す(清水さん承認)。
    //   済(Z)の便は入れない。日が1つなら分納ではない(空)。取込の入荷日は今までどおり最初の日。
    //   🚨 元データに在る値だけ(日と台数)。時刻は表に無いので ここでは付けない(付けるのは App。仮置きだと明記する)。
    const arrivalSplits = (() => {
      if (k33.kind !== 'multi') return [];
      const open = k33.parts.filter(p => p.mark !== 'Z' && p.ymd);
      const days = [...new Set(open.map(p => p.ymd))];
      return days.length >= 2 ? open.map(p => ({ ymd: p.ymd, qty: p.count })) : [];
    })();
    if (k33.kind === 'multi') {
      const doneN = k33.parts.filter(p => p.mark === 'Z').reduce((n, p) => n + p.count, 0);
      out.warnings.push({ row: r.row, orderNo: r.orderNo, model: r.model, message: `${LAB.k33}列に複数日付検出: "${k33.raw.slice(0, 40)}" → 最初の日付を入荷にした (${probe.entryYMD}。済(Z)の日付は飛ばす)${doneN ? `（${doneN}台は検査済）` : ''}` });
    }
    // 🚨 2026-09-23 (R3) 実在しない日付(13/1・4/31)は読まない。黙って別の日にしない(行ごとに1回、字のまま出す)
    if (k33.unreadable) {
      out.warnings.push({ row: r.row, orderNo: r.orderNo, model: r.model, message: `${LAB.k33}列に実在しない日付: "${k33.raw.slice(0, 40)}" → その部分は読まない（入荷は ${probe.entryYMD || '無し'} / ${probe.entrySource || '決まらない'}）` });
    } else if (k33.kind === 'text') {
      out.warnings.push({ row: r.row, orderNo: r.orderNo, model: r.model, message: `${LAB.k33}列(入荷)が日付でない: "${k33.raw.slice(0, 20)}" → ${probe.entrySource} を仮の入荷にした` });
    }

    // 🚚 出荷予定日(AD列)。印(K:確認 M:マトメ L:リミット Y:予定)が付く事がある。
    //   読めなかった字は捨てずに数え、行ごとの警告にはしない(実物は237行が日付でない字で普通の状態)。
    const ship = probe.ship;
    if (r.shipDate != null && String(r.shipDate).trim() !== '' && !ship.ymd) shipUnreadableRows += 1;

    // --- 型式 → テンプレ(製品検査) / 1行=1ロット(最終検査) ---
    let usable; let matchedModel = r.model; let qsName = '';
    if (single) {
      // 🏁 最終検査には型式マスタもテンプレの割当も無い。行そのまま1ロット・テンプレは1つ固定。
      if (!opt.singleTemplateId) { skip(r, PS_REASON.NO_TEMPLATE_ID); continue; }
      usable = [{ templateId: String(opt.singleTemplateId), daysBefore: opt.singleDaysBefore, entryDaysBefore: opt.singleEntryDaysBefore }];
    } else {
      const resolved = resolveEntriesForModel({ modelMasters, qualityStandards, modelStandardMap }, r.model);
      if (!resolved) { skip(r, PS_REASON.NO_MASTER); continue; }
      usable = resolved.entries.filter(e => e && e.templateId);
      if (!usable.length) { skip(r, `「${resolved.matchedModel || r.model}${PS_REASON.NO_TEMPLATE_ASSIGNED}`); continue; }
      matchedModel = resolved.matchedModel;
      qsName = resolved.source === 'modelMaster' ? '型式マスタ' : '品質規格';
    }

    // 📦 台数(E列)。
    //   🚨 2026-09-10: 空・0・数でない行を **1台** に丸めていた(実物の表で26行)。
    //     その行が既存ロット(台数4・作業記録なし)に当たると台数が1へ落ち、
    //     unitSerialNumbers が3本 切り捨てられる(取り消せない)。
    //     元データに無い値を推測で埋めない(2026-07-10) → 分からない時は **触らない**。
    //   🚨 2026-09-10: parseInt は 1.5→1・"2abc"→2 と **黙って切り捨てる**(ChatGPT が発見)。
    //     正の整数だけ受け、それ以外は理由を出して 台数を触らない(parseQty)。
    const qtyP = parseQty(r.qty);
    const qtyKnown = qtyP.ok;
    const quantity = qtyKnown ? qtyP.value : null;
    const qtyInvalid = !qtyKnown && !qtyP.empty;                 // 入っているのに正の整数ではない(1.5 / "2abc" / 0 / -1 …)
    const qtyReason = qtyP.empty ? PS_REASON.QTY_EMPTY : `${PS_REASON.QTY_INVALID}: ${qtyP.raw}`;
    if (qtyInvalid) qtyInvalidRows++;
    let qtyWarned = false;
    for (const e of usable) {
      const tpl = tplById.get(e.templateId);
      if (templates && templates.length && !tpl) { skip(r, `${PS_REASON.TEMPLATE_MISSING} (${e.templateId})`); continue; }
      // 📅 納期と入荷は decideRowDates ただ1本が決める(2026-09-11 清水さんの説明)。
      //   型式マスタに入っていれば その型式の日数、無ければ取込の既定を使う。
      const daysBefore = Number.isFinite(Number(e.daysBefore)) && e.daysBefore !== null && e.daysBefore !== '' ? Number(e.daysBefore) : 0;
      const entryDays = e.entryDaysBefore !== null && e.entryDaysBefore !== undefined && e.entryDaysBefore !== '' && Number.isFinite(Number(e.entryDaysBefore))
        ? Number(e.entryDaysBefore) : opt.defaultEntryDaysBefore;
      // 🚚 出荷日(AD列)の何日前までに検査を終えるか。清水さん「その日に検査をしていたら出荷ができない」
      const shipDays = e.shipDaysBefore !== null && e.shipDaysBefore !== undefined && e.shipDaysBefore !== '' && Number.isFinite(Number(e.shipDaysBefore))
        ? Number(e.shipDaysBefore) : opt.defaultShipDaysBefore;
      const D = decideRowDates(r, { today, entryDaysBefore: entryDays, shipDaysBefore: shipDays, k33DaysBefore: daysBefore, labels: LAB, k33Means: opt.k33Means });
      const dueDate = D.dueDate;
      const baseYMD = D.dueBase; const baseSource = D.dueSource;
      // 入荷: Z列に本物の日が在ればその日。仮で作った日だけ 工場の休みなら前の営業日へ寄せる。
      const entryYMD = D.entryProvisional ? toPrevWorkday(D.entryYMD) : D.entryYMD;
      const entryAtPlain = entryYMD ? ymdHHMMToMs(entryYMD, opt.entryHHMM) : 0;
      for (const w of D.warnings) out.warnings.push({ row: r.row, orderNo: r.orderNo, model: r.model, message: w });

      const existing = (openByOrder.get(r.orderNo) || []).find(l => l.templateId === e.templateId);
      const oldEntryAt = existing ? (Number(existing.entryAt) || 0) : 0;
      // 🕗 入庫の **時刻** は人が入れる事がある(本番の写しで 10:00 が1件・17:00 が2件)。
      //   日付が動かないなら 時刻はそのまま残す(既定の 08:30 で塗り替えない)。
      const sameEntryDay = !!(oldEntryAt && ymdOf(new Date(oldEntryAt)) === entryYMD);
      const entryAt = sameEntryDay ? oldEntryAt : entryAtPlain;
      const lotData = {
        row: r.row, orderNo: r.orderNo, model: r.model, matchedModel, quantity, qtyKnown, qtyInvalid, qtyRaw: qtyP.raw,
        templateId: e.templateId, templateName: tpl ? (tpl.name || '') : '',
        dueDate, dueDateProvisional: provisional, baseDate: baseYMD, baseSource, daysBefore,
        // 🏷 画面に「どの列の どの日から どう作ったか」を1行で出す為の札(2026-09-11)
        dueSource: D.dueSource, entrySource: D.entrySource, entryProvisional: D.entryProvisional,
        // 🔑 機械が読む印。型式マスタの日数を後から変えた時に「どの日数が効くか」をここから決める。
        dueBasis: D.dueBasis, entryBasis: D.entryBasis, entryBase: D.entryBase || '',
        dueCell: D.dueCell,
        entryAfterDue: !!D.entryAfterDue,
        shipDaysBefore: shipDays,
        entryAt, entryYMD, entryDaysBefore: entryDays,
        // 🚚 出荷日(AD列)。清水さん(2026-09-10)「出荷日を…どの列から → AD列だね」。
        //   ⚠ ここでは **読んで渡すだけ**。「出荷の何営業日前までに検査を終える」の計算は
        //     操業シミュレーションの scenario.shipDeadline が持つ(日数を2か所で持たない)。
        //   読めない/空なら '' (null を入れて「分からない」を「無い」にしない)。
        shipDate: ship.ymd || '',
        shipMark: ship.mark || '',
        // 🚚 分かれた入荷の便(日と台数)。2つ以上の日に分かれている時だけ。作るのは App(arrival_times)。
        arrivalSplits,
        qsName,
      };
      if (existing) {
        // 📦 表の台数が分からない行(空・正の整数でない)は台数を触らない(既存のまま)。納期・入庫だけ直す。
        //   不正な値は **黙らない**: 行ごとに1回、警告に出す(空は表では普通の状態なので出さない)。
        if (qtyInvalid && !qtyWarned) { qtyWarned = true; out.warnings.push({ row: r.row, orderNo: r.orderNo, model: r.model, message: `${qtyReason} → 台数は触らず(${existing.quantity ?? '?'}台のまま)、納期・入庫だけ見直す` }); }
        const qtyChange = qtyKnown && !hasWork(existing) && Number(existing.quantity) !== quantity;
        const dueChange = String(existing.dueDate || '') !== dueDate;
        const provChange = !!existing.dueDateProvisional !== provisional;
        // 🚚 出荷日が表で変わったら直す。表に出荷日が無い行(空)は **既存を消さない**
        //   (空で上書きすると、一度入れた出荷日が取込のたびに消える)。
        const shipChange = !!lotData.shipDate && String(existing.shipDate || '') !== lotData.shipDate;
        // 🚚 2026-09-09 清水さん「進捗管理からデータが変更された場合は、製品検査なら型式マスタの入荷と納期をもとに更新しないとだめ」
        //   ⚠ もう作業が始まっている物・すでに検査へ来ている物の入庫は動かさない(リードタイムの実績が壊れる)。
        //      まだ入荷待ちで記録の無いロットだけ、納期から数え直した入庫にそろえる。
        //   🚚🚨 2026-09-10 追加: **工程連絡で人が反映した入荷** は動かさない。
        //      App.jsx の到着反映は「一度入れた到着は入れ直さない(手で直しても上書きし返さない)」と
        //      決めているのに、進捗管理表の取込にはその門が無く、5日 前へ戻す所だった(実測3件)。
        const entryPinnedHere = !!(pinnedEntry && oldEntryAt && Number(pinnedEntry[existing.id]) === oldEntryAt);
        const entryLockReason = entryPinnedHere ? '🚚工程連絡で入れた入荷（人が決めた時間なので動かしません）'
          : (hasWork(existing) ? '作業の記録があります（入庫はリードタイムの実測の起点）'
            : ((existing.location === 'arrival' || existing.location === 'planned' || !existing.location) ? ''
              : 'すでに検査へ来ています（入庫はリードタイムの実測の起点）'));
        const canMoveEntry = !entryLockReason;
        const entryChange = !!(canMoveEntry && entryAt && Math.abs(oldEntryAt - entryAt) >= 60000);
        const rec = {
          ...lotData, existingId: existing.id, oldDueDate: existing.dueDate || '', oldQuantity: existing.quantity,
          quantity: qtyKnown ? quantity : (existing.quantity ?? null),
          qtyChange, dueChange, entryChange, canMoveEntry, entryLockReason, entryPinned: entryPinnedHere, oldEntryAt,
          shipChange, oldShipDate: existing.shipDate || '',
        };
        if (dueChange || qtyChange || provChange || entryChange || shipChange) out.updateLots.push(rec); else out.unchangedLots.push(rec);
      } else if (!qtyKnown) {
        // 新しく作る時に台数が分からないなら、1台と決めつけない。理由を出して取り込まない。
        //   空 → QTY_EMPTY。入っているのに正の整数でない(1.5 / "2abc" / 0 / -1) → QTY_INVALID + その値。
        skip(r, qtyReason, { detail: qtyP.raw });
      } else if (isAlreadyDone(r.orderNo, e.templateId)) {
        // 🏁 アプリではもう検査が終わっている → 既定では作らない(押せば作れる)。
        out.alreadyDone.push({ ...lotData, doneMatch: opt.doneMatch });
      } else {
        out.createLots.push(lotData);
      }
    }
  }

  // --- アプリには在るが、表に無い指図(数字の指図だけ。古い指図か別の表) ---
  for (const [k, ls] of openByOrder) {
    if (!isNumericOrder(k) || sheetOrders.has(k)) continue;
    for (const l of ls) out.notInSheet.push({ lot: l, lotId: l.id, orderNo: k, model: l.model || '', templateId: l.templateId, hasTasks: hasTasks(l) });
  }

  out.counts = {
    rows: out.totalRows, create: out.createLots.length, update: out.updateLots.length, unchanged: out.unchangedLots.length,
    skipped: out.skipped.length, stale: out.stale.length, staleDeletable: out.stale.filter(x => !x.hasTasks).length, notInSheet: out.notInSheet.length,
    // 🗑 清水さんの言う「35ロット」はほぼ **指図の数**。ロットの数だけ出すと単位が食い違って見えるので
    //   別々の指図の数も一緒に出す(本番の写しで 63ロット = 36指図)。
    staleDeletableOrders: new Set(out.stale.filter(x => !x.hasTasks).map(x => String(x.orderNo || '').trim())).size,
    staleOrders: new Set(out.stale.map(x => String(x.orderNo || '').trim())).size,
    alreadyDone: out.alreadyDone.length,
    qtyInvalid: qtyInvalidRows,   // 📦 台数が入っているのに正の整数でない行(空は数えない)
    provisional: out.createLots.filter(c => c.dueDateProvisional).length + out.updateLots.filter(u => u.dueDateProvisional).length,
    entryChange: out.updateLots.filter(u => u.entryChange).length,
    // 🚚 出荷日(AD列)が読めた行・表で変わった行
    shipDate: out.createLots.filter(c => c.shipDate).length + out.updateLots.filter(u => u.shipDate).length,
    shipChange: out.updateLots.filter(u => u.shipChange).length,
    shipUnreadable: shipUnreadableRows,   // 日付でない字(「16時引取」「確認要」「残③」など)
    entryPinned: out.updateLots.concat(out.unchangedLots).filter(u => u.entryPinned).length,
    // 🚨 2026-09-11: 入荷が納期より後ろ＝検査する時間が1日も無い行。表がそう言っているので作るが、
    //   押す前に必ず数を見せる。作る物と、既にあるロットの入庫を後ろへ動かす物を分けて数える。
    entryAfterDueCreate: out.createLots.filter(c => c.entryAfterDue).length,
    entryAfterDueUpdate: out.updateLots.filter(u => u.entryAfterDue && u.entryChange).length,
    // 🚚 2026-09-15 分かれた入荷: 新規に作る行のうち 便を一緒に作る物の数(押す前に見せる)
    splitArrivalCreate: out.createLots.filter(c => Array.isArray(c.arrivalSplits) && c.arrivalSplits.length >= 2).length,
    // 🚚 既に在るロット(更新・変わらず)のうち、表で入荷が分かれている物。到着予定が **無い物だけ** に便を作る(到着予定の有無は App が見る)
    splitArrivalExisting: out.updateLots.concat(out.unchangedLots).filter(u => Array.isArray(u.arrivalSplits) && u.arrivalSplits.length >= 2).length,
  };
  return out;
}

// ---------------------------------------------------------------------------
// 🗂 型式マスタ 未登録リスト(2026-09-17)
//   清水さん「型式マスタがない場合は、わかりやすくしてほしい。登録時に型式マスタがないので
//   型式マスタ登録前に移動しますか？みたいな感じにして、型式マスタに未登録リストみたいなのがあって、
//   そこで登録したら、そのリストのやつが自動で登録するみたいにして」
//   取込で「型式マスタに型式の登録なし」で落ちた行を **表の値のまま** 設定に置き、
//   型式マスタに登録した後 同じ純関数(planProgressImport)で作り直す。Excel を取り込み直さなくてよい。
//   🚨 元データに無い値は足さない。日付の生の値(Date)は 'YYYY-MM-DD' に、数(Excelシリアル)と字はそのまま。
// ---------------------------------------------------------------------------
export const PENDING_MAX_ROWS = 600;
const rawToStorable = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return cellToYMD(v);
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
};
/** 取込の計画から「型式マスタに無い」で落ちた行だけを、保存できる形(JSON)で返す。順番は表のまま。 */
export function pendingRowsFromPlan(rows, plan) {
  const noMaster = new Set((plan && Array.isArray(plan.skipped) ? plan.skipped : [])
    .filter((x) => x && x.reason === PS_REASON.NO_MASTER).map((x) => x.row));
  if (!noMaster.size) return [];
  return (Array.isArray(rows) ? rows : []).filter((r) => r && noMaster.has(r.row)).map((r) => ({
    row: r.row, orderNo: String(r.orderNo || ''), productNo: String(r.productNo || ''), model: String(r.model || '').trim(),
    qty: r.qty == null ? '' : String(r.qty),
    k33: rawToStorable(r.k33), assyDone: rawToStorable(r.assyDone), start: rawToStorable(r.start), shipDate: rawToStorable(r.shipDate),
    stage: String(r.stage || ''), progress: String(r.progress || ''), isGray: !!r.isGray,
  }));
}
/** 前の未登録リストに 今回の行を重ねる。同じ 指図×型式 は今回の行で置き換える(表は毎回 全部の行を載せる)。上限を越えた分は古い方から落とす。 */
export function mergePendingRows(prevRows, nextRows, max = PENDING_MAX_ROWS) {
  const key = (r) => `${String(r.orderNo || '').trim()}::${String(r.model || '').trim()}`;
  const seen = new Set((Array.isArray(nextRows) ? nextRows : []).map(key));
  const kept = (Array.isArray(prevRows) ? prevRows : []).filter((r) => r && !seen.has(key(r)));
  const all = [...kept, ...(Array.isArray(nextRows) ? nextRows : [])];
  return all.length > max ? all.slice(all.length - max) : all;
}
/** 型式ごとにまとめる。ready = 型式マスタ(または旧・品質規格)にテンプレが1つ以上ある = 今すぐ検査リストへ登録できる。 */
export function pendingGroupsOf(rows, { modelMasters = {}, qualityStandards = {}, modelStandardMap = {} } = {}) {
  const by = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    const m = String(r.model || '').trim() || '(空)';
    if (!by.has(m)) by.set(m, []);
    by.get(m).push(r);
  }
  return [...by.entries()].map(([model, list]) => {
    const resolved = resolveEntriesForModel({ modelMasters, qualityStandards, modelStandardMap }, model);
    const usable = resolved ? resolved.entries.filter((e) => e && e.templateId).length : 0;
    return {
      model, rows: list, orders: new Set(list.map((r) => String(r.orderNo || '').trim())).size,
      inMaster: !!(modelMasters && modelMasters[model]), ready: usable > 0,
    };
  }).sort((a, b) => b.rows.length - a.rows.length || a.model.localeCompare(b.model, 'ja'));
}
