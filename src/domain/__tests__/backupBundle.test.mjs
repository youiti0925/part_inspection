import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachStats, rowBytes, fmtSize, checkAttachments, attachmentReport, attachmentSummary,
  buildBackupPayload, backupFileName, missingFilesMessage, restoreOrder, RESTORE_COLLECTIONS, HELP_IMAGE_COLLECTION,
  checkNoteImageRefs, referencedNoteImageIds,
} from '../backupBundle.js';
import { WS_FILE_COLLECTION, WS_FILE_PREFIX, wsFileIdFor } from '../fileOffload.js';
import { NOTE_IMAGE_COLLECTION, NOTE_IMG_PREFIX, newNoteImageId, noteImageDoc } from '../noteImages.js';

const pdf = (kb) => 'data:application/pdf;base64,' + 'A'.repeat(kb * 1024);
const tag = (data) => WS_FILE_PREFIX + wsFileIdFor(data);
const wsRow = (data, extra = {}) => ({ __id: wsFileIdFor(data), name: 'n', mime: 'application/pdf', data, at: 1, ...extra });

test('BB01 ★数は実測。base64はASCIIなので文字数がそのままバイト数(推定しない)', () => {
  const rows = [wsRow(pdf(10)), wsRow(pdf(20))];
  const s = attachStats(rows);
  assert.equal(s.n, 2);
  assert.equal(s.bytes, rowBytes(rows[0]) + rowBytes(rows[1]));
  assert.ok(s.bytes > 30 * 1024, '中身のバイト数がちゃんと乗っている');
  assert.deepEqual(attachStats(null), { n: 0, bytes: 0 }, '空でも落ちない');
});

test('BB02 ★札の数と実体の数が合っているか', () => {
  const a = pdf(600), b = pdf(14);
  const list = [{ id: 'ws-1', pdfData: tag(a) }, { id: 'ws-2', pdfData: tag(b) }];
  assert.equal(checkAttachments(list, [wsRow(a), wsRow(b)]).ok, true);
  const ng = checkAttachments(list, [wsRow(b)]);
  assert.equal(ng.ok, false);
  assert.equal(ng.missing.length, 1);
  assert.equal(ng.missing[0], wsFileIdFor(a));
});

test('BB03 ⚠中身が空の行は「在る」と数えない(戻しても開けないため)', () => {
  const a = pdf(600);
  const list = [{ id: 'ws-1', pdfData: tag(a) }];
  const r = checkAttachments(list, [{ __id: wsFileIdFor(a), name: 'n', data: '' }]);
  assert.equal(r.ok, false, '行はあるが中身が空 = 欠け');
});

test('BB04 ★書き出しJSONに中身と内訳が両方入る', () => {
  const a = pdf(600);
  const rows = [wsRow(a)];
  const help = [{ __id: 'h1', image: 'data:image/png;base64,AAAA' }];
  const check = checkAttachments([{ id: 'ws-1', pdfData: tag(a) }], rows);
  const out = buildBackupPayload({ meta: { app: 'product-inspection' }, lots: [] }, { workStandardFiles: rows, helpImages: help, check });
  assert.equal(out.workStandardFiles.length, 1);
  assert.equal(out.helpImages.length, 1);
  assert.ok(JSON.stringify(out).includes(a), '⚠PDFの中身そのものが入っている');
  assert.equal(out.meta.app, 'product-inspection', '今までの meta を壊さない');
  assert.equal(out.meta.attachments.workStandardFiles.n, 1);
  assert.equal(out.meta.attachments.complete, true);
});

test('BB05 ★欠けたまま出した物はファイル名で分かる', () => {
  assert.equal(backupFileName('2026-08-14', { ok: true }), 'バックアップ_製品検査_2026-08-14.json');
  assert.ok(backupFileName('2026-08-14', { ok: false }).includes('〈資料なし〉'));
  assert.equal(backupFileName('2026-08-14'), 'バックアップ_製品検査_2026-08-14.json', '判定が無い時は今までどおり');
});

test('BB06 ★中止の文に「何件」と「どうなるか」が入る', () => {
  const m = missingFilesMessage({ refN: 3, missing: ['x', 'y'] });
  assert.ok(m.includes('3件') && m.includes('2件'), '数字を出す');
  assert.ok(/開け/.test(m), '現場にとって何が起きるかを言う');
});

test('BB07 ★画面の一言。1MB以上はMBで読ませる', () => {
  const att = attachmentReport([wsRow(pdf(600))], [{ __id: 'h', image: 'x'.repeat(1300 * 1024) }], { refN: 1, missing: [], ok: true });
  const line = attachmentSummary(att);
  assert.ok(/資料PDF 1件/.test(line) && /ヘルプ画像 1件/.test(line));
  assert.ok(/MB/.test(line), '1MB超はMB表記');
  assert.equal(fmtSize(1024 * 512), '512KB');
});

test('BB08 ⚠欠けている時は一言にも必ず出す(黙って少ない数だけ見せない)', () => {
  const att = attachmentReport([], [], { refN: 2, missing: ['a', 'b'], ok: false });
  assert.ok(/2件/.test(attachmentSummary(att)));
});

test('BB09 ★★復元は実体(資料PDF・ヘルプ画像)が先、ロット・設定が後', () => {
  const cols = restoreOrder({ lots: [], workStandardFiles: [], helpImages: [] }).map(([c]) => c);
  assert.ok(cols.indexOf(WS_FILE_COLLECTION) < cols.indexOf('lots'), '途中で止まっても札だけを作らない');
  assert.ok(cols.indexOf(HELP_IMAGE_COLLECTION) < cols.indexOf('lots'));
  assert.equal(cols[0], WS_FILE_COLLECTION);
});

test('BB10 ★キーは新旧2通りとも拾う(PocketBase移行用のJSONも戻せる)', () => {
  const byCol = (parsed) => Object.fromEntries(restoreOrder(parsed));
  assert.deepEqual(byCol({ work_standard_files: [{ __id: 'a' }] })[WS_FILE_COLLECTION], [{ __id: 'a' }]);
  assert.deepEqual(byCol({ help_images: [{ __id: 'h' }] })[HELP_IMAGE_COLLECTION], [{ __id: 'h' }]);
  assert.deepEqual(byCol({ modelTemplates: [{ id: 'm' }] })['model_templates'], [{ id: 'm' }]);
  assert.equal(byCol({})[WS_FILE_COLLECTION], undefined, '無いキーは undefined(空配列で上書きしない)');
});

test('BB11 ⚠戻す対象から消えた物が無いか(2026-07-26 に17中12が黙って飛ばされていた)', () => {
  const cols = RESTORE_COLLECTIONS.map((c) => c.col);
  for (const need of ['lots', 'templates', 'workers', 'indirectWork', 'improvements', 'observationPlans',
    'notes', 'announcements', 'logs', 'model_templates', 'knowledge_courses', 'knowledge_records',
    WS_FILE_COLLECTION, HELP_IMAGE_COLLECTION, NOTE_IMAGE_COLLECTION]) {
    assert.ok(cols.includes(need), `${need} が復元の対象から抜けている`);
  }
  assert.equal(new Set(cols).size, cols.length, '同じコレクションを2回書かない');
});

// ==== 📷 ノート/お知らせ画像(2026-08-31 の別置き)もバックアップに乗る ====

const IMG_A = 'data:image/jpeg;base64,' + 'A'.repeat(4096);
const IMG_B = 'data:image/png;base64,' + 'B'.repeat(2048);
const ID_A = newNoteImageId(1000, 'aaaa');
const ID_B = newNoteImageId(2000, 'bbbb');
const niRow = (id, img) => ({ __id: id, ...noteImageDoc(img, { kind: 'note', refId: 'n1', nowMs: 1 }) });

test('BB12 📷札(noteimg:…)と実体(note_images)の突き合わせ。notes と announcements の両方を見る', () => {
  const notes = [{ id: 'n1', imageRef: NOTE_IMG_PREFIX + ID_A }];
  const anns = [{ id: 'a1', imageRef: NOTE_IMG_PREFIX + ID_B }];
  assert.deepEqual([...referencedNoteImageIds(notes, anns)], [ID_A, ID_B]);
  assert.equal(checkNoteImageRefs(notes, anns, [niRow(ID_A, IMG_A), niRow(ID_B, IMG_B)]).ok, true);
  const ng = checkNoteImageRefs(notes, anns, [niRow(ID_A, IMG_A)]);
  assert.equal(ng.ok, false);
  assert.deepEqual(ng.missing, [ID_B]);
  // ⚠中身が空の行は「在る」と数えない(戻しても出ないため)
  assert.equal(checkNoteImageRefs(notes, [], [{ __id: ID_A, image: '' }]).ok, false);
  // 旧形式(image に中身がそのまま)の doc は札を持たない = 突き合わせの対象外
  assert.equal(checkNoteImageRefs([{ id: 'n2', image: IMG_A }], [], []).ok, true);
});

test('BB13 📷書き出しJSONに画像の中身と内訳が入り、欠けたら complete=false', () => {
  const rows = [niRow(ID_A, IMG_A)];
  const nc = checkNoteImageRefs([{ id: 'n1', imageRef: NOTE_IMG_PREFIX + ID_A }], [], rows);
  const out = buildBackupPayload({ meta: { app: 'product-inspection' } }, { noteImages: rows, noteImageCheck: nc });
  assert.equal(out.noteImages.length, 1);
  assert.ok(JSON.stringify(out).includes(IMG_A), '画像の中身そのものが入っている');
  assert.equal(out.meta.attachments.noteImages.n, 1);
  assert.equal(out.meta.attachments.complete, true);
  const bad = buildBackupPayload({}, { noteImageCheck: { refN: 1, missing: ['x'], ok: false } });
  assert.equal(bad.meta.attachments.complete, false);
});

test('BB14 📷復元は note_images が notes/announcements より先(札だけ在って中身が無いを作らない)', () => {
  const cols = restoreOrder({ notes: [], note_images: [] }).map(([c]) => c);
  assert.ok(cols.indexOf(NOTE_IMAGE_COLLECTION) < cols.indexOf('notes'));
  assert.ok(cols.indexOf(NOTE_IMAGE_COLLECTION) < cols.indexOf('announcements'));
  const byCol = Object.fromEntries(restoreOrder({ noteImages: [{ __id: 'z' }] }));
  assert.deepEqual(byCol[NOTE_IMAGE_COLLECTION], [{ __id: 'z' }], '新キー(noteImages)も拾う');
});

test('BB15 📷欠けたまま出した物はファイル名で分かる(既存の印の出方は変えない)', () => {
  assert.ok(backupFileName('2026-08-31', { ok: true }, '製品検査', { ok: true }, { ok: false }).includes('〈ノート画像なし〉'));
  assert.ok(backupFileName('2026-08-31', { ok: false }, '製品検査', { ok: false }).includes('〈資料・測定図なし〉'));
  const m = missingFilesMessage(null, null, { refN: 2, missing: ['a'] });
  assert.ok(m.includes('2件') && m.includes('1件') && /画像/.test(m));
});
