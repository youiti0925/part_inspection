// ============================================================================
// 📦 バックアップに「別置きしてある中身」を必ず一緒に入れるための純関数。
// ----------------------------------------------------------------------------
// ⚠⚠ なぜ要るか(2026-08-14 本番の現物で確認):
//   バックアップボタンが出すJSONに、**資料PDFの中身が1バイトも入っていなかった**。
//     ・設定(settings.workStandards[].pdfData)に入っているのは `wsfile:wsf-…` という **札** だけ。
//       中身は Firestore の work_standard_files に別置きしてある(1MB上限を避けるため)。
//     ・書き出し側がそのコレクションを出していなかった。本番実測 1件 608KB が丸ごと欠けていた。
//     ・ヘルプ画像(help_images)も同じ(本番実測 13件 1,204KB)。
//   → 復元した現場は「一覧に資料は並ぶのに、どれも開けない」状態になる。
//     つまり「バックアップを取っている」が「戻せる」になっていなかった。
//
//   誰も気づかなかった理由は単純で、**枚数もバイト数も一度も数えていなかった**から。
//   だからこのファイルは「入れる」だけでなく **「数える」「足りなければ止める」** までを持つ。
//
// 決めごと:
//   ① 数は必ず実測。base64 は ASCII なので **文字数がそのままバイト数**(推定しない)。
//   ② 札の数と実体の数が合わなければ **書き出しを中止**。逃げ道は〈資料なし〉で書き出す1つだけ。
//      その時は **ファイル名に〈資料なし〉を入れる**(後で本物と取り違えると取り返しがつかない)。
//   ③ 復元は **実体が先、札を持っている側(ロット・設定)が後**。
//      途中で止まっても「札だけ在って中身が無い」状態を作らない。
//
// ⚠ここには React も firebase も import しない (node --test と試験スクリプトから回すため)。
// ============================================================================

import { WS_FILE_COLLECTION, referencedWsFileIds } from './fileOffload.js';
import { DIAGRAM_COLLECTION, referencedDiagramIds } from './diagramOffload.js';
import { NOTE_IMAGE_COLLECTION, noteImageIdOf } from './noteImages.js';

export const HELP_IMAGE_COLLECTION = 'help_images';

/** 1件が書き出しJSONで占める量。⚠base64はASCII=文字数がバイト数。推定しない。 */
export const rowBytes = (row) => JSON.stringify(row === undefined ? null : row).length;

/** 枚数とバイト数。画面・JSON・試験で **同じ数字** を使うため、ここ1か所で数える。 */
export const attachStats = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  return { n: list.length, bytes: list.reduce((a, r) => a + rowBytes(r), 0) };
};

/** 人が読む大きさ。1MB以上は MB で(「1,204KB」は現場で読み取りにくい)。 */
export const fmtSize = (b) => {
  const n = Number(b) || 0;
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(n / 1024).toLocaleString()}KB`;
};

const docIdOf = (r) => (r && (r.__id || r.id)) || '';

/**
 * 札(wsfile:…)と実体(work_standard_files)の突き合わせ。
 * ⚠中身が空の行は **無いのと同じ**(戻しても開けない)。「在るのに開けない」を作らないため欠けとして数える。
 * @param workStandards 設定の資料一覧(札のまま。中身に戻す前の物)
 * @param wsFileRows    work_standard_files から取り直した行 [{__id, data, ...}]
 */
export const checkAttachments = (workStandards, wsFileRows) => {
  const refs = [...referencedWsFileIds(workStandards || [])];
  const have = new Set((Array.isArray(wsFileRows) ? wsFileRows : [])
    .filter((r) => r && typeof r.data === 'string' && r.data.length > 0)
    .map(docIdOf).filter(Boolean));
  const missing = refs.filter((id) => !have.has(id));
  return { refN: refs.length, haveN: have.size, missing, ok: missing.length === 0 };
};

/**
 * 📐測定図の札(diagram:…)と実体(step_diagrams)の突き合わせ。資料PDFとまったく同じ理屈。
 * ⚠測定図は **ロットの中** に札が入っている(設定ではない)。だから見る場所が違う。
 *   これを出し忘れると、戻した現場は「工程は並ぶのに、測る図が1枚も出ない」状態になる。
 * ⚠中身が空の行は無いのと同じ(戻しても表示できない)ので欠けとして数える。
 */
export const checkDiagramRefs = (lots, diagramRows) => {
  const refs = [...referencedDiagramIds(lots || [])];
  const have = new Set((Array.isArray(diagramRows) ? diagramRows : [])
    .filter((r) => r && typeof r.data === 'string' && r.data.length > 0)
    .map(docIdOf).filter(Boolean));
  const missing = refs.filter((id) => !have.has(id));
  return { refN: refs.length, haveN: have.size, missing, ok: missing.length === 0 };
};

/** 📷 notes/announcements の札(noteimg:…)が指す画像 doc の id 一覧(重複なし)。 */
export const referencedNoteImageIds = (...docLists) => {
  const out = new Set();
  for (const list of docLists) {
    (Array.isArray(list) ? list : []).forEach((d) => {
      const id = noteImageIdOf(d && d.imageRef);
      if (id) out.add(id);
    });
  }
  return out;
};

/**
 * 📷 ノート/お知らせ画像の札(noteimg:…)と実体(note_images)の突き合わせ(2026-08-31)。
 * 資料PDF・測定図とまったく同じ理屈。札は notes と announcements の両方に入る。
 * ⚠実体の doc の中身の鍵は image(domain/noteImages.js の noteImageDoc が決める)。
 */
export const checkNoteImageRefs = (notes, announcements, noteImageRows) => {
  const refs = [...referencedNoteImageIds(notes || [], announcements || [])];
  const have = new Set((Array.isArray(noteImageRows) ? noteImageRows : [])
    .filter((r) => r && typeof r.image === 'string' && r.image.length > 0)
    .map(docIdOf).filter(Boolean));
  const missing = refs.filter((id) => !have.has(id));
  return { refN: refs.length, haveN: have.size, missing, ok: missing.length === 0 };
};

/** JSONと画面に出す内訳。⚠ここに入れておかないと、次に誰かが欠けても また気づけない。 */
export const attachmentReport = (wsFileRows, helpImageRows, check = null, stepDiagramRows = [], diagramCheck = null, noteImageRows = [], noteImageCheck = null) => {
  const ws = attachStats(wsFileRows);
  const help = attachStats(helpImageRows);
  const dia = attachStats(stepDiagramRows);
  const ni = attachStats(noteImageRows);
  const c = check || { refN: ws.n, missing: [], ok: true };
  const d = diagramCheck || { refN: dia.n, missing: [], ok: true };
  const nc = noteImageCheck || { refN: ni.n, missing: [], ok: true };
  return {
    workStandardFiles: ws,
    helpImages: help,
    stepDiagrams: dia,
    // 📷 ノート/お知らせ画像(2026-08-31 の別置き)
    noteImages: ni,
    refs: c.refN,
    missing: c.missing || [],
    diagramRefs: d.refN,
    diagramMissing: d.missing || [],
    noteImageRefs: nc.refN,
    noteImageMissing: nc.missing || [],
    complete: !!c.ok && !!d.ok && !!nc.ok,
  };
};

/** 画面に出す一言。例) 「資料PDF 1件 608KB ／ ヘルプ画像 13件 1.2MB ／ 測定図 4件 109KB ／ ノート画像 2件 3.1MB」 */
export const attachmentSummary = (att) => {
  const ws = (att && att.workStandardFiles) || { n: 0, bytes: 0 };
  const hp = (att && att.helpImages) || { n: 0, bytes: 0 };
  const dg = (att && att.stepDiagrams) || { n: 0, bytes: 0 };
  const ni = (att && att.noteImages) || { n: 0, bytes: 0 };
  const head = `資料PDF ${ws.n}件 ${fmtSize(ws.bytes)} ／ ヘルプ画像 ${hp.n}件 ${fmtSize(hp.bytes)} ／ 測定図 ${dg.n}件 ${fmtSize(dg.bytes)}`
    + (ni.n > 0 ? ` ／ ノート画像 ${ni.n}件 ${fmtSize(ni.bytes)}` : '');
  const miss = [...((att && att.missing) || []), ...((att && att.diagramMissing) || []), ...((att && att.noteImageMissing) || [])];
  return miss.length ? `${head}（⚠中身が見つからない ${miss.length}件は入っていません）` : head;
};

/**
 * 書き出すJSONを組み立てる。
 * ⚠画面と試験で **同じ関数** を通すこと。片方だけ直すと、また静かに欠ける。
 * @param body  今までどおりの中身 { meta, settings, lots, ... }
 */
export const buildBackupPayload = (body, { workStandardFiles = [], helpImages = [], check = null, stepDiagrams = [], diagramCheck = null, noteImages = [], noteImageCheck = null } = {}) => {
  const attachments = attachmentReport(workStandardFiles, helpImages, check, stepDiagrams, diagramCheck, noteImages, noteImageCheck);
  return {
    ...body,
    meta: { ...((body && body.meta) || {}), attachments },
    // ⚠キー名は復元側と対で決まっている。変えるなら restoreOrder も同時に直す。
    workStandardFiles,
    helpImages,
    // 📐測定図の実体。ロットには 'diagram:…' の札しか入っていないので、これが無いと図が出ない。
    stepDiagrams,
    // 📷 ノート/お知らせ画像の実体。本体には 'noteimg:…' の札しか入っていない(2026-08-31)。
    noteImages,
  };
};

/**
 * ファイル名。実体が欠けている物は **名前で分かるようにする**。
 * ⚠これをやらないと、半年後に「バックアップはある」と言って開いた時に初めて資料が無いと分かる。
 */
export const backupFileName = (dateStr, check = null, label = '製品検査', diagramCheck = null, noteImageCheck = null) => {
  const parts = [];
  if (check && check.ok === false) parts.push('資料');
  if (diagramCheck && diagramCheck.ok === false) parts.push('測定図');
  if (noteImageCheck && noteImageCheck.ok === false) parts.push('ノート画像');
  const mark = parts.length ? `〈${parts.join('・')}なし〉` : '';
  return `バックアップ_${label}_${dateStr}${mark}.json`;
};

/** 中止した時に画面へ出す文。⚠数字と、現場にとって何が起きるかを必ず書く。 */
export const missingFilesMessage = (check, diagramCheck = null, noteImageCheck = null) => {
  const c = check || { refN: 0, missing: [] };
  const n = (c.missing || []).length;
  const d = diagramCheck || { refN: 0, missing: [] };
  const dn = (d.missing || []).length;
  const ni = noteImageCheck || { refN: 0, missing: [] };
  const nin = (ni.missing || []).length;
  // ⚠画面にそのまま出す文なので飾り記号(**など)は使わない。書いた通りの字が出る。
  const lines = ['書き出しを中止しました。'];
  if (n > 0) {
    lines.push(`資料PDF ${c.refN}件のうち ${n}件 の中身が見つかりません（一覧には名前があるのに、中身の箱が空です）。`);
    lines.push('このまま書き出すと、戻した時にその資料は開けません。');
  }
  if (dn > 0) {
    lines.push(`測定図 ${d.refN}件のうち ${dn}件 の絵が見つかりません（工程に図の札はあるのに、絵の箱が空です）。`);
    lines.push('このまま書き出すと、戻した時に測定画面の図が出ません。');
  }
  if (nin > 0) {
    lines.push(`ノート/お知らせの画像 ${ni.refN}件のうち ${nin}件 の中身が見つかりません（本文に札はあるのに、画像の箱が空です）。`);
    lines.push('このまま書き出すと、戻した時にその画像は出ません。');
  }
  return lines.join('\n');
};

/**
 * 復元でどのコレクションを **どの順番で** 書くか。
 * ⚠⚠ 順番が命。**実体(資料PDF・ヘルプ画像)を先に書く**。
 *   ロットや設定(=札を持っている側)を先に書いて途中で止まると、
 *   「一覧には並ぶが開けない資料」が本番に残る。
 * ⚠キーは版によって2通りある(新しいバックアップ / PocketBase移行用)。両方拾う。
 */
export const RESTORE_COLLECTIONS = Object.freeze([
  // 📄 資料PDFの中身。設定側は札しか持っていないので、これを戻さないと資料が開けない。
  { col: WS_FILE_COLLECTION, keys: ['workStandardFiles', 'work_standard_files'] },
  // 🖼 ヘルプ画像。開いた時しか購読しないので、書き出し側でも取りこぼしやすい。
  { col: HELP_IMAGE_COLLECTION, keys: ['helpImages', 'help_images'] },
  // 📐測定図の絵。⚠**必ず lots より先**。ロットが持っているのは 'diagram:…' の札だけなので、
  //   ロットを先に戻して途中で止まると「工程は並ぶのに、測る図が1枚も出ない」現場が残る。
  { col: DIAGRAM_COLLECTION, keys: ['stepDiagrams', 'step_diagrams'] },
  // 📷 ノート/お知らせ画像の実体。⚠**必ず notes/announcements より先**(札だけ在って中身が無いを作らない)。
  { col: NOTE_IMAGE_COLLECTION, keys: ['noteImages', 'note_images'] },
  { col: 'lots', keys: ['lots'] },
  { col: 'templates', keys: ['templates'] },
  { col: 'workers', keys: ['workers'] },
  { col: 'indirectWork', keys: ['indirectWork'] },
  { col: 'improvements', keys: ['improvements'] },
  { col: 'observationPlans', keys: ['observationPlans'] },
  { col: 'notes', keys: ['notes'] },
  { col: 'announcements', keys: ['announcements'] },
  { col: 'logs', keys: ['logs'] },
  // 🚗 型式専用テンプレ。戻さないと「型式マスタは戻ったのに専用工程が消えた」状態になる。
  { col: 'model_templates', keys: ['modelTemplates', 'model_templates'] },
  // 📚 知識標準の講座と受講の記録(2026-07-26 の復元試験で 17中12 が黙って飛ばされていた実例あり)。
  { col: 'knowledge_courses', keys: ['knowledgeCourses', 'knowledge_courses'] },
  { col: 'knowledge_records', keys: ['knowledgeRecords', 'knowledge_records'] },
]);

/** バックアップの中身から [コレクション名, 配列] の並びを作る(上の順番のまま)。 */
export const restoreOrder = (parsed) => RESTORE_COLLECTIONS.map(({ col, keys }) => {
  for (const k of keys) { const v = parsed && parsed[k]; if (Array.isArray(v)) return [col, v]; }
  return [col, undefined];
});
