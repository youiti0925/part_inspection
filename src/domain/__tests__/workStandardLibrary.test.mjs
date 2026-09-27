// 📚 作った作業標準を「資料の棚」へ1タップで入れる／⑥承認した人と日付
//
// ⚠⚠ この試験の主役は3つ。
//   ① **写真(base64)を棚に持ち込まない**。持ち込んだ瞬間に設定の箱(1MB)が死ぬ。
//      棚に入れるのは「どの動画の・どの要点か」だけ。開いた時に写真を作り直す。
//   ② **元の動画の名前とDriveのIDを必ず残す**。消えたら作り直せない = その書類は二度と出せない。
//      作り直せない物は「作り直せません」と**先に**言う(あとで気づくのが一番まずい)。
//   ③ **承認は1段だけ・取り消せる・中身が変わったら自動で外れる**。
//      承認済みの札が付いたまま中身が別物になるのが一番危ない。
//   そして **版番号は機械で採番しない**(2026-08-12 の約束)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkStandard, titleFor, baseTitle } from '../workStandardDoc.js';
import { workStandardHtml } from '../workStandardPrint.js';
import { timelineOf } from '../videoProject.js';
import {
  WS_KIND, isVideoStandard, buildLibraryEntry, entryToDoc, rebuildCheck,
  contentKey, approvalState, isApproved, approveEntry, unapproveEntry,
  approvalLabel, entryBytes, entryTooBig, defaultStandardName, RECIPE_MAX_BYTES,
} from '../workStandardLibrary.js';
// ⚠⚠ backupBundle.js は **最終検査と製品で別物**(名前が同じだけ)。
//   最終＝写真(lot_images)の分割書き出し／製品＝測定図(step_diagrams)とヘルプ画像。
//   だから最終の buildBackupFiles は製品に無い。確かめたい事(＝PDFを持たない棚の1件を
//   「資料が欠けている」と誤判定しない／バックアップに素直に入る)は同じなので、
//   **製品のやり方**で同じ事を確かめる。⚠md5を揃えに行かないこと。
import { checkAttachments, buildBackupPayload, backupFileName } from '../backupBundle.js';

const proj = {
  clips: [
    { id: 'c0', type: 'video', srcId: 's1', start: 0, end: 10, speed: 1 },
    { id: 'c1', type: 'freeze', srcId: 's1', atSec: 8, durationSec: 3, marks: [{ id: 'm1', shape: 'ellipse', x: 0.1, y: 0.2, w: 0.3, h: 0.3 }], caption: '', step: 'ねじを締める', point: '斜めに入れない', why: 'ねじ山がつぶれる' },
    { id: 'c2', type: 'video', srcId: 's1', start: 10, end: 30, speed: 1 },
    { id: 'c3', type: 'image', imageId: 'i1', durationSec: 5, marks: [], caption: '銘板の位置', step: '', point: '', why: '' },
  ],
  overlays: [{ id: 'o1', kind: 'mosaic', from: 0, to: 40, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
  rotate: 90, crop: { x: 0, y: 0, w: 1, h: 0.8 }, adjust: { brightness: 1.1 },
  quality: 'mid', fps: 30,
};
const chapters = [{ name: '外観', atOut: 0 }];
const sources = [
  { id: 's1', name: '手本_TK-1.mp4', driveId: 'drive-abc', durationSec: 40 },
];
const mkDoc = (p = proj) => buildWorkStandard(p, {
  timeline: timelineOf(p), chapters,
  meta: { title: '作業標準（原案）', model: 'TK-1', madeBy: '清水', madeAt: 1755000000000, videoName: '手本_TK-1.mp4' },
});
const mkEntry = (over = {}) => buildLibraryEntry(mkDoc(), {
  sources, by: '清水', at: 1755000000000, perPage: 2, ...over,
});

test('L01 ⚠⚠ 棚に入れる1件は **写真を1枚も持たない**（設定の箱が1MBで死ぬ）', () => {
  const e = mkEntry();
  const json = JSON.stringify(e);
  assert.ok(!/data:image/.test(json), '⚠⚠base64の写真が混ざっている = 即1MB上限');
  assert.ok(!/pdfData"\s*:\s*"data:/.test(json), '⚠PDFの中身も持たない(アプリはPDFを持っていない)');
  assert.ok(entryBytes(e) < 8000, `軽くない: ${entryBytes(e)}バイト`);
});

test('L02 「どの動画の・どの要点か」が入っている（開いた時に作り直せる）', () => {
  const e = mkEntry();
  assert.equal(e.kind, WS_KIND);
  assert.equal(isVideoStandard(e), true);
  assert.equal(e.recipe.sources[0].driveId, 'drive-abc', '⚠Driveのidが無いと動画を取り直せない');
  assert.equal(e.recipe.doc.rows.length, 2);
  assert.equal(e.recipe.doc.rows[0].shot.srcId, 's1');
  assert.equal(e.recipe.doc.rows[0].shot.atSec, 8, '⚠元の動画の「何秒の1枚か」');
  assert.equal(e.recipe.doc.rows[0].step, 'ねじを締める');
  // ⚠画づくり(回転・切り抜き・明るさ)を落とすと、あとで作り直した紙だけ横倒しになる
  assert.equal(e.recipe.doc.pic.rotate, 90);
  assert.equal(e.recipe.doc.pic.crop.h, 0.8);
  // ⚠目隠しを落とすと、隠したはずの紙が丸見えで配られる
  assert.equal(e.recipe.doc.rows[0].hides.length, 1);
});

test('L03 ⚠元の動画の名前が必ず書類に残る（Driveから消えたら作り直せないから）', () => {
  const e = mkEntry();
  assert.equal(e.recipe.doc.videoName, '手本_TK-1.mp4');
  const d = entryToDoc(e);
  assert.equal(d.videoName, '手本_TK-1.mp4');
  const html = workStandardHtml(d, {});
  assert.ok(html.includes('手本_TK-1.mp4'), '⚠紙に元の動画名が出ていない');
  // 動画名を渡し忘れても、元動画の名前から埋まる(空欄で出さない)
  const e2 = buildLibraryEntry(buildWorkStandard(proj, { timeline: timelineOf(proj), chapters, meta: {} }), { sources });
  assert.equal(e2.recipe.doc.videoName, '手本_TK-1.mp4');
});

test('L04 ⚠Driveに無い動画は「あとで作り直せません」と先に言う', () => {
  const ok = rebuildCheck(mkDoc(), sources);
  assert.equal(ok.freeze.total, 1);
  assert.equal(ok.freeze.rebuildable, 1);
  const ng = rebuildCheck(mkDoc(), [{ id: 's1', name: '手元の動画.mp4', driveId: '' }]);
  assert.equal(ng.ok, false);
  assert.equal(ng.freeze.rebuildable, 0);
  assert.deepEqual(ng.missingVideos, ['手元の動画.mp4']);
  assert.ok(/手元の動画\.mp4/.test(ng.note), '⚠どの動画がだめなのか名指しする');
  assert.ok(/Drive/.test(ng.note));
});

test('L05 ⚠🖼挟んだ画像の要点は、あとで作り直せない（数えて名指しで言う）', () => {
  const c = rebuildCheck(mkDoc(), sources);
  assert.equal(c.image.total, 1, '挟んだ画像は1件');
  assert.equal(c.ok, false, '⚠作り直せない要点が在るのに ok にしない');
  assert.ok(/画像/.test(c.note) && /1/.test(c.note), c.note);
});

test('L06 棚の1件 → そのまま紙にできる（表を2回書かない）', () => {
  const d = entryToDoc(mkEntry());
  assert.equal(d.rows.length, 2);
  assert.equal(d.model, 'TK-1');
  assert.equal(d.rows[0].marks.length, 1, '⚠印を落とすと「どこを見るか」が消える');
  const html = workStandardHtml(d, {});
  assert.ok(html.includes('ねじを締める'));
  assert.ok(html.includes('斜めに入れない'));
});

test('L07 ⑥ 承認は **1段だけ**（承認した／していない）', () => {
  const e = mkEntry();
  assert.equal(approvalState(e), 'none');
  assert.equal(isApproved(e), false);
  const a = approveEntry(e, '田中', 1755100000000);
  assert.equal(approvalState(a), 'approved');
  assert.equal(isApproved(a), true);
  assert.equal(a.approval.by, '田中');
  assert.equal(a.approval.at, 1755100000000);
  // ⚠多段にしない。段や順番を持たせない。
  assert.ok(!('stage' in a.approval) && !('level' in a.approval) && !('steps' in a.approval));
  const label = approvalLabel(a);
  assert.ok(/承認済み/.test(label) && /田中/.test(label) && /\d{4}\/\d{1,2}\/\d{1,2}/.test(label), label);
});

test('L08 ⚠承認を取り消せる（間違えた時に詰まない）', () => {
  const a = approveEntry(mkEntry(), '田中', 1755100000000);
  const u = unapproveEntry(a);
  assert.equal(approvalState(u), 'none');
  assert.equal(isApproved(u), false);
  assert.ok(!u.approval, '取り消したら承認の札は残さない');
  // 元を壊さない
  assert.equal(isApproved(a), true);
});

test('L09 ⚠⚠承認したあとに中身が変わったら、承認は **自動で外れる**', () => {
  const a = approveEntry(mkEntry(), '田中', 1755100000000);
  // 作業手順を直した = 別の中身
  const changed = { ...a, recipe: { ...a.recipe, doc: { ...a.recipe.doc, rows: a.recipe.doc.rows.map((r, i) => (i === 0 ? { ...r, step: 'ねじを **緩める**' } : r)) } } };
  assert.equal(approvalState(changed), 'stale', '⚠承認済みの札が付いたまま別の中身になるのが一番危ない');
  assert.equal(isApproved(changed), false);
  assert.ok(/外れ/.test(approvalLabel(changed)), approvalLabel(changed));
  // 紙にも「承認済み」を出さない
  const html = workStandardHtml(entryToDoc(changed), {});
  assert.ok(!html.includes('田中'), '⚠外れた承認者の名前を紙に出してはいけない');
  assert.ok(html.includes('原案'), '未承認に戻ったら原案として出す');
});

test('L10 承認に関係ない所（名前・分類・説明）を直しても承認は外れない', () => {
  const a = approveEntry(mkEntry(), '田中', 1755100000000);
  const renamed = { ...a, name: '作業標準_TK-1（正式）', category: '最終検査', description: '説明を足した', updatedAt: Date.now() };
  assert.equal(approvalState(renamed), 'approved', '棚の見出しを直しただけで承認が飛ぶと運用が回らない');
  // 急所を直したら外れる
  const edited = { ...a, recipe: { ...a.recipe, doc: { ...a.recipe.doc, rows: a.recipe.doc.rows.map((r, i) => (i === 0 ? { ...r, point: '別の急所' } : r)) } } };
  assert.equal(approvalState(edited), 'stale');
});

test('L11 ⚠⚠版番号を機械で採番しない（承認しても空のまま）', () => {
  const a = approveEntry(mkEntry(), '田中', 1755100000000);
  const d = entryToDoc(a);
  assert.equal(d.docNo, '');
  assert.equal(d.rev, '');
  assert.equal(d.issuedAt, '');
  const json = JSON.stringify(a);
  assert.ok(!/"rev"\s*:\s*"?[0-9]/.test(json), '⚠版を数字で採番している');
  assert.ok(!/第\d+版/.test(json));
  const html = workStandardHtml(d, {});
  assert.ok(!/第\d+版/.test(html));
});

test('L12 承認済みは題名から（原案）が消える／未承認は必ず付く', () => {
  assert.equal(baseTitle('作業標準（原案）'), '作業標準');
  assert.equal(titleFor('作業標準（原案）', false), '作業標準（原案）');
  assert.equal(titleFor('作業標準（原案）', true), '作業標準');
  assert.equal(titleFor('作業標準', false), '作業標準（原案）');
  // ⚠二重に付けない
  assert.equal(titleFor('作業標準（原案）（原案）', false), '作業標準（原案）');
  // ⚠見るのは **紙に出る所** だけ(CSSの注釈まで見ると、注釈が書けなくなる)。
  //   実際に目に見えるかどうかは scripts/verify-work-standard.mjs が本物のブラウザで測る。
  const html = workStandardHtml(entryToDoc(approveEntry(mkEntry(), '田中', 1755100000000)), {})
    .replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.ok(!/原案/.test(html), '⚠承認済みの紙に原案が残っていると、どちらが本物か分からなくなる');
});

test('L13 ⚠大きすぎる1件は入れさせない（設定の箱ごと巻き添えにする）', () => {
  const e = mkEntry();
  assert.equal(entryTooBig(e), false);
  const fat = { ...e, recipe: { ...e.recipe, doc: { ...e.recipe.doc, rows: [{ ...e.recipe.doc.rows[0], why: 'あ'.repeat(RECIPE_MAX_BYTES) }] } } };
  assert.equal(entryTooBig(fat), true);
});

test('L14 棚に並べた時に中身が当てられる名前になる', () => {
  const n = defaultStandardName(mkDoc(), sources);
  assert.ok(n.includes('作業標準'), n);
  assert.ok(n.includes('TK-1') || n.includes('手本_TK-1'), n);
  assert.ok(!/\.mp4/.test(n), '⚠拡張子は名前に残さない');
  assert.ok(n.length <= 60, n);
});

test('L16 ⚠バックアップに素直に入る（新しい棚を作っていない＝取れているのに戻せない、を作らない）', () => {
  const e = mkEntry();
  // ⚠⚠ 動画から作った1件は **PDFを持たない**(持てない)。製品の資料は「PDFの実体が
  //   別の箱にあるか」を見張っているので、ここで欠け扱いにすると、棚に1件入れただけで
  //   バックアップのファイル名に「資料が足りない」と付く = 戻せない物だと誤解される。
  const check = checkAttachments([e], []);
  assert.equal(check.ok, true, '⚠PDFを持たない1件で「資料が足りない」と誤判定してはいけない');
  assert.equal(check.refN, 0, '⚠PDFの札を1枚も参照していない');
  assert.ok(!/足りない|欠け/.test(backupFileName('2026-08-15', check, '製品検査')),
    '⚠バックアップのファイル名に欠けの印が付かない');
  // ⚠新しい箱(コレクション)を作っていない = 設定の棚にそのまま乗るので、
  //   今の書き出し/復元の道にそのまま入る。
  const json = JSON.stringify(buildBackupPayload({ workStandards: [e] }, { check }));
  assert.ok(json.includes('drive-abc') && json.includes('ねじを締める'), '⚠棚の1件がバックアップの中に入っている');
});

test('L15 中身の指紋は「並び順」まで見る（入れ替えたら承認が外れる）', () => {
  const e = mkEntry();
  const k1 = contentKey(e);
  const swapped = { ...e, recipe: { ...e.recipe, doc: { ...e.recipe.doc, rows: [...e.recipe.doc.rows].reverse() } } };
  assert.notEqual(contentKey(swapped), k1, '⚠順番が変われば別の標準');
  // 同じ中身なら同じ指紋(端末が違っても同じ)
  assert.equal(contentKey(mkEntry()), k1);
});
