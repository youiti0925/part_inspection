// ============================================================================
// PocketBase移行 Phase M1 の回帰試験
// 「窓口(Provider)を通しても、今までの手書きと同じ場所へ・同じ結果で読み書きするか」
// を **本物の Firestore(エミュレータ)** に対して確かめる。
//
// 使い方(本番には絶対に繋がない):
//   npx firebase-tools emulators:start --only firestore,auth --project inspection-time-c4fd3
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/verify-provider.mjs
// ============================================================================

import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDocs, getDoc,
  serverTimestamp, deleteField, connectFirestoreEmulator,
} from 'firebase/firestore';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { createFirebaseBackend, createProvider, ROW_DOCID_WINS, ROW_DATA_WINS } from '../src/data/provider.js';
import { NS, GOAL_NS, CONTACT_NS, dataPath, areaOf, backendFor, PLANNED_PROVIDERS } from '../src/data/routes.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) {
  console.error('❌ FIRESTORE_EMULATOR_HOST が未設定です。本番には繋ぎません。中止します。');
  process.exit(1);
}

const app = initializeApp({ projectId: 'inspection-time-c4fd3', apiKey: 'fake-for-emulator' });
const db = getFirestore(app);
const [h, p] = HOST.split(':');
connectFirestoreEmulator(db, h, Number(p));
// ルールが匿名ログインを要求する(2026-07-26 の名前空間許可リスト)。アプリと同じ状態で試す。
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${h}:9099`, { disableWarnings: true });
await signInAnonymously(auth);

const FS = { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, getDoc, serverTimestamp };
const P = createProvider({ backends: { firebase: createFirebaseBackend(db, FS) } });

const NSX = NS.final;
const COL = 'lots';
const TAG = 'm1-verify';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); } };

// 昔の書き方(手書きパス)。比較の基準。
const oldDoc = (ns, col, id) => doc(db, 'artifacts', ns, 'public', 'data', col, id);

console.log('\n=== M1 回帰試験: 窓口を通しても今まで通りか ===\n');

// --- V1 パスが完全に一致する -------------------------------------------------
{
  const cases = [
    [NSX, COL, `${TAG}-1`], [NSX, 'settings', 'config'],
    [GOAL_NS, 'settings', 'config'], [CONTACT_NS, 'settings', 'config'],
    [NS.product, 'work_standard_files', 'wsf-abc'],
  ];
  let same = true, bad = '';
  for (const [ns, col, id] of cases) {
    const a = oldDoc(ns, col, id).path;
    const b = P.docRef(ns, col, id).path;
    if (a !== b) { same = false; bad = `${a} != ${b}`; }
  }
  ok('V1 窓口が組み立てるパスは手書きと1文字も違わない', same, bad);
  ok('V1b dataPath も同じ', dataPath(NSX, COL, 'x').join('/') === `artifacts/${NSX}/public/data/${COL}/x`);
}

// --- V2 merge:true の意味が同じ(送らなかったキーは残る) -----------------------
{
  const id = `${TAG}-merge`;
  await setDoc(oldDoc(NSX, COL, id), { a: 1, b: { x: 1, y: 2 }, arr: [1, 2, 3] });
  await P.save(NSX, COL, id, { b: { x: 9 } });                 // 既定 = merge:true
  const s = await getDoc(oldDoc(NSX, COL, id));
  const d = s.data();
  ok('V2 merge:true は送らなかったキーを消さない', d.a === 1 && d.b.y === 2 && d.b.x === 9,
    JSON.stringify(d));
  ok('V2b 配列は置き換わる(Firestoreの仕様どおり)', JSON.stringify(d.arr) === '[1,2,3]');
  await P.save(NSX, COL, id, { only: true }, { merge: false }); // 全上書き
  const s2 = await getDoc(oldDoc(NSX, COL, id));
  ok('V2c merge:false は全部消して書き換える',
    s2.data().a === undefined && s2.data().only === true, JSON.stringify(s2.data()));
  await deleteDoc(oldDoc(NSX, COL, id));
}

// --- V3 読み方2種の違いが実データで再現する ----------------------------------
{
  const id = `${TAG}-idfield`;
  // ⚠製品検査は本文の中にも id を持つ。どちらを優先するかで結果が変わる。
  await setDoc(oldDoc(NSX, COL, id), { id: 'body-id-9', name: 'A' });
  const docIdWins = await P.getAll(NSX, COL);
  const dataWins = await P.getAll(NSX, COL, { map: ROW_DATA_WINS });
  const a = docIdWins.find(r => r.name === 'A');
  const b = dataWins.find(r => r.name === 'A');
  ok('V3 既定はドキュメントID優先', a && a.id === id, JSON.stringify(a));
  ok('V3b map を渡すと本文のid優先', b && b.id === 'body-id-9', JSON.stringify(b));
  await deleteDoc(oldDoc(NSX, COL, id));
}

// --- V4 購読が生の onSnapshot と同じものを届ける -------------------------------
{
  const id = `${TAG}-watch`;
  await setDoc(oldDoc(NSX, COL, id), { hello: 'world', n: 7 });
  const viaProvider = await new Promise((res) => {
    const un = P.watchCollection(NSX, COL, (rows) => { un(); res(rows); });
  });
  const viaRaw = await new Promise((res) => {
    const un = onSnapshot(collection(db, 'artifacts', NSX, 'public', 'data', COL), (snap) => {
      un(); res(snap.docs.map(d => ({ ...d.data(), id: d.id })));
    });
  });
  const norm = (rows) => JSON.stringify(rows.map(r => ({ ...r })).sort((x, y) => String(x.id).localeCompare(String(y.id))));
  ok('V4 購読の結果は生の onSnapshot と完全一致', norm(viaProvider) === norm(viaRaw));

  const one = await new Promise((res) => {
    const un = P.watchDoc(NSX, COL, id, (data) => { un(); res(data); });
  });
  ok('V4b 1件購読も同じ中身', one && one.hello === 'world' && one.n === 7, JSON.stringify(one));
  await P.remove(NSX, COL, id);
  const gone = await getDoc(oldDoc(NSX, COL, id));
  ok('V4c 窓口経由の削除も効く', !gone.exists());
}

// --- V4d 「消したキー」の印が窓口で潰れない ------------------------------------
{
  // ⚠2026-07-26に直したばかりの穴: setDoc(merge:true) は「送らなかったキー」を消さない。
  //   だから削除は deleteField() の番兵をペイロードに入れて渡している。
  //   窓口がペイロードを作り直すと、この番兵がただのオブジェクトに化けて削除が効かなくなる。
  const id = `${TAG}-delfield`;
  await P.save(NSX, COL, id, { keep: 1, gone: { a: 1 }, nest: { x: 1, y: 2 } }, { merge: false });
  await P.save(NSX, COL, id, { gone: deleteField(), nest: { y: deleteField() } });
  const d = (await getDoc(oldDoc(NSX, COL, id))).data();
  ok('V4d 窓口を通しても deleteField() の削除が効く',
    d.keep === 1 && d.gone === undefined && d.nest.x === 1 && d.nest.y === undefined, JSON.stringify(d));
  await P.remove(NSX, COL, id);
}

// --- V5 領域の振り分けが設計どおり -------------------------------------------
{
  ok('V5 連絡の依頼は contact 領域', areaOf(NSX, 'contact_requests') === 'contact');
  ok('V5b 移行後も連絡は firebase のまま',
    backendFor(NSX, 'contact_requests', PLANNED_PROVIDERS) === 'firebase' &&
    backendFor(CONTACT_NS, 'settings', PLANNED_PROVIDERS) === 'firebase');
  ok('V5c 移行後は検査本体と写真が pocketbase',
    backendFor(NSX, 'lots', PLANNED_PROVIDERS) === 'pocketbase' &&
    backendFor(NSX, 'lot_images', PLANNED_PROVIDERS) === 'pocketbase');
  // まだ用意していない保管庫を指したら、黙って動かずに理由を出して止まる
  const future = createProvider({
    backends: { firebase: createFirebaseBackend(db, FS) }, providers: PLANNED_PROVIDERS,
  });
  let threw = '';
  try { future.docRef(NSX, 'lots', 'x'); } catch (e) { threw = e.message; }
  ok('V5d 未実装の保管庫は黙って素通りせず落ちる', /用意されていません/.test(threw), threw);
  ok('V5e 連絡だけは同じ設定でも通る', !!future.docRef(NSX, 'contact_requests', 'x'));
}

// --- V6 壊れたIDでサーバへ行かせない ------------------------------------------
{
  let threw = '';
  try { P.docRef(NSX, COL, 'a/b'); } catch (e) { threw = e.message; }
  ok('V6 スラッシュ入りIDは組み立て時に止める(別の場所へ書かせない)', /ドキュメントID/.test(threw), threw);
}

console.log(`\n=== 合計 ${pass + fail} 件: 合格 ${pass} / 不合格 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
