// ============================================================================
// 📝🖼 noteImages.js — メモ(notes)・お知らせ(announcements)の写真の別置き
// ----------------------------------------------------------------------------
// 【なぜ在るか(2026-08-31)】
//   notes / announcements は本文・コメント・写真(base64)を1つの doc に抱えていた。
//   別置き(dehydrate)は lots だけなので、写真つきのメモやお知らせは
//   Firestore の 1MB 上限へ向かって太っていく(出荷の門 verify-save-safety.mjs の
//   SS-701 が名指しした3か所)。
//   → 写真は note_images(1件=1枚。lot_images / help_images と同じ形)へ置き、
//     本体には短い札(imageRef)だけを持たせる。
//
// 【古い doc との共存】
//   既に保存されている doc は image(base64) を持ったまま。読む側は
//   displaySrcOf() で「札が有れば札の中身、無ければ昔の image」を選ぶ。
//   古い doc を書き直しはしない(merge:true なので鍵を送らなければ消えない)。
//
// ⚠ React も Firebase も import しない(node --test で確かめられる形を保つ)。
// ============================================================================

/** 写真の置き場(1 doc = 1枚)。名前に image を含む棚は「写真の置き場そのもの」扱い。 */
export const NOTE_IMAGE_COLLECTION = 'note_images';

/** 本体側に置く札の頭。 */
export const NOTE_IMG_PREFIX = 'noteimg:';

/** それは札か。 */
export const isNoteImageRef = (v) => typeof v === 'string' && v.startsWith(NOTE_IMG_PREFIX);

/** 札 → 画像 doc の id。札でなければ空文字。 */
export const noteImageIdOf = (ref) => (isNoteImageRef(ref) ? ref.slice(NOTE_IMG_PREFIX.length) : '');

/** 新しい画像 doc の id。⚠時刻と乱数は呼ぶ側が渡す(ここは純関数のまま)。 */
export const newNoteImageId = (nowMs, rand) => `nimg_${Number(nowMs) || 0}_${String(rand || '0')}`;

/**
 * 別置きする1枚ぶんの doc。
 * @param dataUrl base64 の data URL(resizeImage 済み前提)
 * @param kind    'note' | 'announcement'
 * @param refId   本体 doc の id(掃除・突き合わせ用)
 */
export const noteImageDoc = (dataUrl, { kind, refId, nowMs }) => ({
  image: String(dataUrl || ''),
  kind: String(kind || ''),
  refId: String(refId || ''),
  createdAt: Number(nowMs) || 0,
});

/** 本体側に足す札の部分。imgId が無ければ {}(= 鍵ごと送らない)。 */
export const imageRefPart = (imgId) => (imgId ? { imageRef: NOTE_IMG_PREFIX + String(imgId) } : {});

/** その doc は写真を持っているか(札でも昔の inline でも)。📷の印などに使う。 */
export const hasNoteImage = (doc) => !!(doc && (isNoteImageRef(doc.imageRef) || doc.image));

/**
 * 表示に使う src を選ぶ。
 * @param doc      notes / announcements の doc
 * @param resolved 札を読んで得た base64(まだ無ければ null)
 * @returns 表示できる src。札がまだ読めていない時は null(呼ぶ側が「読み込み中」を出す)
 */
export const displaySrcOf = (doc, resolved) => {
  if (!doc) return null;
  if (isNoteImageRef(doc.imageRef)) return resolved || null;
  return doc.image || null;
};

/**
 * 🚨🖼「取っている≠戻せる」(2026-07-26)を防ぐ為の口。
 *   メモ/お知らせの並びから、**札が指している写真の id** を重複なしで取り出す。
 *   控え(バックアップ)・移行の書き出し・復元後の確かめ の3か所が同じ答えを使う。
 *   ⚠昔の inline(base64)の doc は札を持たないので、ここには出てこない(本体に写真が在るから)。
 * @param {...Array} lists notes / announcements など、doc の配列を何本でも
 * @returns {string[]} 写真 doc の id(出てきた順・重複なし)
 */
export const noteImageRefIdsOf = (...lists) => {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const d of (list || [])) {
      if (!d || !isNoteImageRef(d.imageRef)) continue;
      const id = noteImageIdOf(d.imageRef);
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
};
