#!/usr/bin/env node
// ============================================================================
// 📝🖼 「控えを取る → 消す → 戻す → 写真が見える」を **実際に通して** 確かめる
// ----------------------------------------------------------------------------
// なぜ要るか(2026-08-31):
//   メモ・お知らせの写真は本体(notes / announcements)に無く、note_images へ
//   別置きしてある。本体が持っているのは短い札(imageRef)だけ。
//   その note_images が **控え(doBackup)・復元(restoreAllFromBackup)・移行
//   (exportForPocketBase)の3つの一覧のどれにも入っていなかった**。
//   この状態で復元すると、メモは戻るのに写真は戻らず、札だけが残って
//   **写真が永久に表示されない**。まさに 2026-07-26 の「取っている≠戻せる」。
//
// この見張りがやる事:
//   ① 実コード(src/App.jsx)を読んで、3つの一覧に note_images が居るか数える
//      ⚠一覧の名前を書いた紙(allowlist)ではなく、**実コードそのもの** を読む。
//   ② エミュレータが在れば、本物の窓口(src/data/provider.js)で往復を通す:
//      メモ+写真を置く → 控えを組む → **保管庫から消す** → 控えだけで戻す →
//      本物の displaySrcOf() で「写真が見えるか」を確かめる。
//   ③ わざと壊す(--pretend-missing): 一覧から note_images を外した積もりで
//      同じ往復を回し、**❌ になる**事を見る。赤を見るまで緑を信じない。
//
// 🚨 本番には絶対つながない。FIRESTORE_EMULATOR_HOST が 127.0.0.1 でなければ止まる。
// ⚠ この見張りは自分が置いた doc(zzrt_ で始まる物)しか触らない。棚は空にしない。
//
// 使い方:
//   node scripts/verify-note-image-roundtrip.mjs                 … ①だけ(エミュレータ不要)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8470 AUTH_EMULATOR_PORT=9570 \
//     node scripts/verify-note-image-roundtrip.mjs               … ①+②
//   … --pretend-missing                                          … ③(わざと壊す)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'App.jsx');
const PRETEND = process.argv.includes('--pretend-missing');

let bad = 0;
const say = (ok, what) => { console.log(`  ${ok ? '✅' : '❌'} ${what}`); if (!ok) bad++; };

// ---------------------------------------------------------------------------
// ① 実コードを読む — 3つの一覧に note_images が居るか
// ---------------------------------------------------------------------------
/** `名前 = ` の後ろの本体を、深さ0の `;` まで切り出す(関数1つぶん)。 */
const bodyOf = (src, startRe) => {
  const m = startRe.exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i);
  }
  return src.slice(m.index);
};

/** 3つの一覧それぞれに note_images が居るか。実コードの文字列を返す(人に見せる為)。 */
export const listsInSource = (src) => {
  const backup = bodyOf(src, /const\s+doBackup\s*=/g);
  const restore = bodyOf(src, /const\s+restoreAllFromBackup\s*=/g);
  const pb = bodyOf(src, /const\s+exportForPocketBase\s*=/g);
  // 並び: 写真の実体は **札を持つ側(notes)より先** に書く(製品検査の RESTORE_COLLECTIONS と同じ)。
  //   逆だと、途中で止まった時に「メモは並ぶのに写真が出ない」が本番に残る。
  const iImg = restore ? restore.search(/\[\s*'note_images'\s*,/) : -1;
  const iNote = restore ? restore.search(/\[\s*'notes'\s*,/) : -1;
  return {
    backup: { found: !!backup, has: !!backup && /note_images/.test(backup) },
    restore: { found: !!restore, has: !!restore && iImg >= 0, beforeNotes: iImg >= 0 && iNote >= 0 && iImg < iNote },
    pocketbase: { found: !!pb, has: !!pb && /note_images\s*:/.test(pb) },
  };
};

// ⚠ここから下は「直接動かした時」だけ。import して listsInSource() だけ使う道を塞がない
//   (この見張り自身を別の所から試験できるようにする為)。
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!IS_MAIN) { /* import された時は何もしない */ } else {

const src = fs.readFileSync(APP, 'utf8');
const lists = listsInSource(src);
console.log('📄 実コード(src/App.jsx)の3つの一覧');
say(lists.backup.found, '控え(doBackup)が在る');
say(lists.backup.has, '控え(doBackup)に note_images が入っている');
say(lists.restore.found, '復元(restoreAllFromBackup)が在る');
say(lists.restore.has, "復元の一覧に ['note_images', …] が入っている");
say(lists.restore.beforeNotes, '復元の並びで、写真の実体が notes より **先** に来ている(途中で止まっても札だけを残さない)');
say(lists.pocketbase.found, '移行(exportForPocketBase)が在る');
say(lists.pocketbase.has, '移行の一覧に note_images が入っている');

// 🚨 見張り自身の試験: その1行を消した文字列を食わせたら ❌ になるか。
{
  const broken = src
    .replace(/\['note_images',\s*parsed\.note_images\],?/, '')
    .replace(/note_images:\s*noteImgs\.rows,?/, '')
    .replace(/note_images:\s*imgs\.rows/, '');
  const b = listsInSource(broken);
  say(!b.backup.has && !b.restore.has && !b.pocketbase.has,
    '🚨 わざと3つの一覧から note_images を消した文字列は ❌ になる(何も見ていない見張りではない)');
}

// ---------------------------------------------------------------------------
// ② エミュレータで往復(控えを取る → 消す → 戻す → 写真が見える)
// ---------------------------------------------------------------------------
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!HOST) {
  console.log('\n（FIRESTORE_EMULATOR_HOST が無いので、往復の試験は省略しました）');
  process.exit(bad ? 1 : 0);
}
const [EH, EP] = HOST.split(':');
if (!['127.0.0.1', 'localhost'].includes(EH)) {
  console.error('❌ エミュレータ(127.0.0.1)以外は使えません。本番へ書く事故を防ぐため中止します。');
  process.exit(1);
}

const { initializeApp } = await import('firebase/app');
const FSMOD = await import('firebase/firestore');
const { getAuth, connectAuthEmulator, signInAnonymously } = await import('firebase/auth');
const { providerFor } = await import('../src/data/provider.js');
const { NOTE_IMAGE_COLLECTION, NOTE_IMG_PREFIX, noteImageRefIdsOf, displaySrcOf, noteImageDoc } =
  await import('../src/domain/noteImages.js');

const app = initializeApp({ projectId: 'inspection-time-c4fd3', apiKey: 'emulator-fake-key' });
const db = FSMOD.getFirestore(app);
FSMOD.connectFirestoreEmulator(db, EH, Number(EP));
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${EH}:${process.env.AUTH_EMULATOR_PORT || '9099'}`, { disableWarnings: true });
await signInAnonymously(auth);

const FS_API = {
  collection: FSMOD.collection, doc: FSMOD.doc, onSnapshot: FSMOD.onSnapshot, setDoc: FSMOD.setDoc,
  deleteDoc: FSMOD.deleteDoc, getDocs: FSMOD.getDocs, getDoc: FSMOD.getDoc,
  serverTimestamp: FSMOD.serverTimestamp, deleteField: FSMOD.deleteField, updateDoc: FSMOD.updateDoc,
  runTransaction: FSMOD.runTransaction, query: FSMOD.query, where: FSMOD.where,
  orderBy: FSMOD.orderBy, limit: FSMOD.limit,
};
const DATA = providerFor(db, FS_API);
const NS = 'parts-inspection-v1';
const NOTE_ID = 'zzrt_note_roundtrip';
const IMG_ID = 'zzrt_nimg_roundtrip';
// 1x1 の絵。**中身の一致**で「同じ写真が戻った」を見る(件数だけでは足りない)。
const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log(`\n🔁 往復の試験（相手: ${HOST} / 棚: ${NS}）${PRETEND ? '  ※わざと壊した版' : ''}`);
try {
  // --- 置く ---------------------------------------------------------------
  await DATA.save(NS, 'notes', NOTE_ID, { id: NOTE_ID, text: '🧪往復の試験(消して構いません)', imageRef: NOTE_IMG_PREFIX + IMG_ID, createdAt: Date.now() });
  await DATA.save(NS, NOTE_IMAGE_COLLECTION, IMG_ID, noteImageDoc(PIC, { kind: 'note', refId: NOTE_ID, nowMs: Date.now() }));
  const seeded = await DATA.getOne(NS, NOTE_IMAGE_COLLECTION, IMG_ID);
  say(!!(seeded && seeded.image === PIC), '置いた: メモ1件 + その写真1枚');

  // --- 控えを取る(アプリの doBackup と同じ道: 札 → 1枚ずつ読む) -----------
  const noteRow = await DATA.getOne(NS, 'notes', NOTE_ID);
  const backup = { notes: [{ id: NOTE_ID, ...noteRow }], note_images: [] };
  for (const rid of noteImageRefIdsOf(backup.notes)) {
    const d = await DATA.getOne(NS, NOTE_IMAGE_COLLECTION, rid);
    if (d && d.image) backup.note_images.push({ id: rid, ...d });
  }
  // 🚨 わざと壊す: 一覧から note_images が抜けている状態(＝直す前の控え)を作る
  if (PRETEND) backup.note_images = undefined;
  say(PRETEND ? backup.note_images === undefined : backup.note_images.length === 1,
    `控えを取った: メモ ${backup.notes.length}件 / 写真 ${Array.isArray(backup.note_images) ? backup.note_images.length : 0}枚`);

  // --- 消す(保管庫から本当に消す) ------------------------------------------
  await DATA.remove(NS, 'notes', NOTE_ID);
  await DATA.remove(NS, NOTE_IMAGE_COLLECTION, IMG_ID);
  const goneNote = await DATA.getOne(NS, 'notes', NOTE_ID);
  const goneImg = await DATA.getOne(NS, NOTE_IMAGE_COLLECTION, IMG_ID);
  say(!goneNote && !goneImg, '消した: メモも写真も保管庫から無くなった');

  // --- 戻す(控えだけを頼りに。並びはアプリと同じ「実体が先・札が後」) ------
  const cols = [['note_images', backup.note_images], ['notes', backup.notes]];
  for (const [col, arr] of cols) {
    if (!Array.isArray(arr)) continue;                 // 古い控えは今までどおり素通り
    for (const raw of arr) { const { id, ...rest } = raw; await DATA.save(NS, col, id, rest); }
  }

  // --- 写真が見えるか(本物の displaySrcOf で確かめる) ----------------------
  const back = await DATA.getOne(NS, 'notes', NOTE_ID);
  say(!!(back && back.text), '戻った: メモの本体が読める');
  const refIds = noteImageRefIdsOf([{ ...back }]);
  const img = refIds.length ? await DATA.getOne(NS, NOTE_IMAGE_COLLECTION, refIds[0]) : null;
  const shown = displaySrcOf(back, img && img.image);
  say(shown === PIC, `写真が見える(札の先の中身が元と同じ) … ${shown ? `${String(shown).length}文字` : '見えない(札だけ)'}`);

  // --- 後片付け ------------------------------------------------------------
  await DATA.remove(NS, 'notes', NOTE_ID).catch(() => {});
  await DATA.remove(NS, NOTE_IMAGE_COLLECTION, IMG_ID).catch(() => {});
} catch (e) {
  console.error('❌ 往復の試験が途中で止まりました:', (e && e.message) || e);
  bad++;
}

if (PRETEND) {
  // わざと壊した版は **落ちるのが正解**。落ちなかったらこの見張りは何も見ていない。
  console.log(bad ? '\n✅ わざと壊した版は ❌ になりました(見張りが効いています)' : '\n❌ わざと壊したのに緑のままです。この見張りは何も見ていません');
  process.exit(bad ? 0 : 1);
}
console.log(bad ? `\n❌ ${bad}件 不合格` : '\n✅ 合格: 控えを取る→消す→戻す→写真が見える、まで通りました');
process.exit(bad ? 1 : 0);

} // ← IS_MAIN の終わり
