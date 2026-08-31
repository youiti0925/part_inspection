// ============================================================================
// 📝🖼 メモ・お知らせの写真の別置け(noteImages)の試験
// ----------------------------------------------------------------------------
// 🚨ここが狂うと: 写真の base64 が notes/announcements の本体に載り、
//   1MB 上限へ直行する(SS-701)。または古い doc の写真が表示から消える。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_IMAGE_COLLECTION, NOTE_IMG_PREFIX, isNoteImageRef, noteImageIdOf,
  newNoteImageId, noteImageDoc, imageRefPart, hasNoteImage, displaySrcOf,
  noteImageRefIdsOf,
} from '../noteImages.js';

test('N01 置き場の名前は image を含む(写真の置き場そのもの、と見張りが分かる形)', () => {
  assert.ok(/image/i.test(NOTE_IMAGE_COLLECTION));
});

test('N02 札の判定と id の取り出し', () => {
  const id = newNoteImageId(1725000000000, 'ab12c');
  const part = imageRefPart(id);
  assert.equal(part.imageRef, NOTE_IMG_PREFIX + id);
  assert.ok(isNoteImageRef(part.imageRef));
  assert.equal(noteImageIdOf(part.imageRef), id);
  // 札でない物は札と言わない
  assert.equal(isNoteImageRef('data:image/jpeg;base64,xxx'), false);
  assert.equal(isNoteImageRef(null), false);
  assert.equal(noteImageIdOf('data:image/jpeg;base64,xxx'), '');
});

test('N03 🚨 写真が無ければ札の部分は {}(鍵ごと送らない = 空や null を書かない)', () => {
  assert.deepEqual(imageRefPart(''), {});
  assert.deepEqual(imageRefPart(null), {});
  assert.deepEqual(imageRefPart(undefined), {});
});

test('N04 別置きの doc の形(kind と refId で突き合わせできる)', () => {
  const d = noteImageDoc('data:image/jpeg;base64,xxx', { kind: 'note', refId: 'note_1', nowMs: 123 });
  assert.equal(d.image, 'data:image/jpeg;base64,xxx');
  assert.equal(d.kind, 'note');
  assert.equal(d.refId, 'note_1');
  assert.equal(d.createdAt, 123);
});

test('N05 表示の選び方: 札が有れば読めた中身、まだ読めていなければ null(読み込み中)', () => {
  const doc = { imageRef: NOTE_IMG_PREFIX + 'nimg_1_a' };
  assert.equal(displaySrcOf(doc, null), null);           // まだ読めていない
  assert.equal(displaySrcOf(doc, 'data:image/jpeg;base64,yyy'), 'data:image/jpeg;base64,yyy');
});

test('N06 🚨 古い doc(inline の image)は札が無ければそのまま表示する(写真を消さない)', () => {
  const legacy = { image: 'data:image/jpeg;base64,old' };
  assert.equal(displaySrcOf(legacy, null), 'data:image/jpeg;base64,old');
  assert.equal(hasNoteImage(legacy), true);
});

test('N07 札が有る doc は inline に落ちない(札が優先。半端な二重表示をしない)', () => {
  const both = { imageRef: NOTE_IMG_PREFIX + 'nimg_2_b', image: 'data:image/jpeg;base64,old' };
  assert.equal(displaySrcOf(both, null), null);           // 札を読むまで出さない
  assert.equal(displaySrcOf(both, 'data:image/jpeg;base64,new'), 'data:image/jpeg;base64,new');
});

test('N08 hasNoteImage: 何も無ければ false(📷の印を嘘で出さない)', () => {
  assert.equal(hasNoteImage({}), false);
  assert.equal(hasNoteImage(null), false);
  assert.equal(hasNoteImage({ image: null }), false);
});

// ---------------------------------------------------------------------------
// 🚨🖼「取っている≠戻せる」(2026-07-26)。控え・移行・復元後の確かめが同じ口を使う。
// ---------------------------------------------------------------------------
test('N10 札の指す写真の id を、メモとお知らせの両方から重複なしで集める', () => {
  const notes = [
    { id: 'n1', imageRef: NOTE_IMG_PREFIX + 'nimg_1_a' },
    { id: 'n2' },                                         // 写真なし
    { id: 'n3', image: 'data:image/jpeg;base64,old' },    // 昔の inline(本体に写真が在る)
    null,
  ];
  const anns = [
    { id: 'a1', imageRef: NOTE_IMG_PREFIX + 'nimg_2_b' },
    { id: 'a2', imageRef: NOTE_IMG_PREFIX + 'nimg_1_a' }, // 同じ写真を指す = 1つに畳む
  ];
  assert.deepEqual(noteImageRefIdsOf(notes, anns), ['nimg_1_a', 'nimg_2_b']);
  assert.deepEqual(noteImageRefIdsOf(null, undefined), []);
});

test('N11 🚨 控えに入れる id が1つでも欠けると、戻した時に札だけが残る(欠けを数で見せる)', () => {
  const notes = [{ id: 'n1', imageRef: NOTE_IMG_PREFIX + 'nimg_1_a' }, { id: 'n2', imageRef: NOTE_IMG_PREFIX + 'nimg_2_b' }];
  const backedUp = [{ id: 'nimg_1_a', image: 'data:image/jpeg;base64,x' }]; // 1枚しか控えていない
  const have = new Set(backedUp.map((r) => r.id));
  const missing = noteImageRefIdsOf(notes).filter((id) => !have.has(id));
  assert.deepEqual(missing, ['nimg_2_b']);                 // = 戻しても写真が出ない札
});

// ---------------------------------------------------------------------------
// 🚨 わざと壊した形でも落ちるか(この試験自身の見張り)
// ---------------------------------------------------------------------------
test('N90 🚨 「札でも inline を出す」形に壊したら、この試験は落ちる', () => {
  const broken = (doc, resolved) => (doc && (resolved || doc.image)) || null; // 札を無視する壊れた版
  const both = { imageRef: NOTE_IMG_PREFIX + 'nimg_2_b', image: 'data:image/jpeg;base64,old' };
  // 壊れた版は「読み込み中」を出せず古い絵を出してしまう = N07 の判定と食い違う
  assert.notEqual(broken(both, null), displaySrcOf(both, null));
});
