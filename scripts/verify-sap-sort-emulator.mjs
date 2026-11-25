// 🧪 SAP 工程の仕分けの登録・辞書を、本物の Firestore(エミュレータ)で保存して読み戻す確かめ
// 目的: 試験の見本窓口でなく、本物の Firestore の決まり(配列の中の配列を断る・firestore.rules)で 登録の保存→読み戻し・辞書の保存→読み戻し・管理者でない時の拒みを確かめる。
// 入力: 環境変数 VITE_USE_EMULATOR=1・FIRESTORE_EMULATOR_HOST=127.0.0.1:ポート・FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:ポート(エミュレータは呼ぶ側が起動・本番へは繋がない)
// 出力: 各確認の ✅/❌ と、最後に RESULT: OK / RESULT: FAIL(失敗があれば終了値 1)
// 触る外の物: 127.0.0.1 のエミュレータだけ(demo- で始まるプロジェクト)。本番・.env.local・ネットワークの外には触れない
// 確かめ方: node scripts/verify-sap-sort-emulator.mjs(エミュレータの起動は docs でなくこの先頭コメントの環境変数を参照)
import './net-guard.mjs';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import * as FS from 'firebase/firestore';
import { providerFor } from '../src/data/provider.js';
import { DEFAULT_PROVIDERS } from '../src/data/routes.js';
import { DEFAULT_SAP_SORT, classifyOp, withTemplateOps, wcsOfTemplate } from '../src/domain/sapSort.js';
import { loadSapSort, saveSapSort, toStored, fromStored, SapSortError } from '../src/domain/sapSortStore.js';
import { cleanLabels, mergeLabelLayers, makeT } from '../src/domain/labels.js';

const NS = 'parts-inspection-v1';
const must = (name, v) => { const x = process.env[name]; if (!x) { console.error(`${name} が未設定です`); process.exit(2); } return x; };
if (process.env.VITE_USE_EMULATOR !== '1') { console.error('VITE_USE_EMULATOR=1 が無いので止めます(本番を書き換えない為)'); process.exit(2); }
const fsHost = must('FIRESTORE_EMULATOR_HOST'), authHost = must('FIREBASE_AUTH_EMULATOR_HOST');
for (const h of [fsHost, authHost]) if (!/^(127\.0\.0\.1|localhost):\d+$/.test(h)) { console.error(`エミュレータの場所が 127.0.0.1 ではありません: ${h}`); process.exit(2); }
const [fh, fp] = fsHost.split(':'), [ah, ap] = authHost.split(':');

const clone = (o) => JSON.parse(JSON.stringify(o));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✅' : '❌'} ${msg}`); if (!c) bad++; };

const app = initializeApp({ apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT || 'demo-sapsort1125', appId: 'demo' });
connectAuthEmulator(getAuth(app), `http://${ah}:${ap}`, { disableWarnings: true });
await signInAnonymously(getAuth(app));
const db = FS.getFirestore(app);
FS.connectFirestoreEmulator(db, fh, Number(fp));
const P = providerFor(db, FS, DEFAULT_PROVIDERS);
const ADMIN = { name: '管理者' }, WORKER = { name: '山田' };
const mem = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
const NOW = Date.now();

console.log('1) 本物の Firestore は 配列の中の配列を断る(だから保存の形に開く)');
let nestedRejected = false;
try { await P.save(NS, 'settings', 'probe_nested', { r: [[1, 2]] }, { merge: false }); } catch { nestedRejected = true; }
ok(nestedRejected, '開かずに入れると Firestore が断る');

console.log('2) 管理者が登録を保存 → 別の端末(控え無し)が読み戻す');
const reg = clone(DEFAULT_SAP_SORT);
reg.commanders[1].groups[0].name = '旋盤(確かめ)';
reg.commanders[1].labels = { schema: 'labels/1', keys: { 'machine.title': '機械の負荷(確かめ)' }, words: { 型式: '品目コード' } };
const r1 = await saveSapSort({ provider: P, ns: NS, reg, baseRev: DEFAULT_SAP_SORT.rev, user: ADMIN, now: NOW, cache: mem() });
ok(r1.rev === 2, `保存できた(版 ${r1.rev}・${r1.bytes} バイト)`);
const L = await loadSapSort({ provider: P, ns: NS, now: NOW, cache: mem() });
ok(L.source === 'server' && !L.usedDefault && L.rev === 2, `読み戻せた(source=${L.source}・版=${L.rev}・usedDefault=${L.usedDefault}・errors=${L.errors.length})`);
ok(eq(fromStored(toStored(L.reg)).commanders[1].textRules, DEFAULT_SAP_SORT.commanders[1].textRules), '言葉の決まり(配列の中の配列だった所)が元の形で戻る');
ok(classifyOp('2315:旋盤', '2315', L.reg).name === '旋盤(確かめ)' && classifyOp('2385:平面研削', '2385', L.reg).name === '平面研削', '読み戻した登録で仕分けると、直した所だけ変わり他は同じ');
ok(L.commanderLabels.machine && L.commanderLabels.machine.keys['machine.title'] === '機械の負荷(確かめ)', '司令塔の辞書(上書き)も一緒に戻る');
ok(makeT(mergeLabelLayers([L.commanderLabels.machine]))('x', '型式を選ぶ') === '品目コードを選ぶ', '辞書の単語の置き換えが効く');

console.log('3) 管理者でない人の保存は拒まれ、文書は変わらない');
const before = await P.getOne(NS, 'settings', 'sap_sort');
for (const user of [WORKER, { name: 'フリー' }, null]) {
    let code = '';
    try { await saveSapSort({ provider: P, ns: NS, reg: DEFAULT_SAP_SORT, baseRev: 2, user, now: NOW, cache: mem() }); } catch (e) { code = e instanceof SapSortError ? e.code : String(e); }
    ok(code === 'not-admin', `${user ? user.name : 'null'} の保存は拒まれた(${code})`);
}
const after = await P.getOne(NS, 'settings', 'sap_sort');
ok(eq(before, after), '拒んだ後も文書は1文字も変わっていない(版=' + after.rev + '・更新者=' + after.updatedBy + ')');
let stale = '';
try { await saveSapSort({ provider: P, ns: NS, reg, baseRev: 1, user: ADMIN, now: NOW, cache: mem() }); } catch (e) { stale = e.code; }
ok(stale === 'stale', '古い版からの保存は「他の人が先に直しました」で拒まれる');

console.log('4) 辞書(グループの上書き)を 設定の文書 settings/config の labels 欄へ保存 → 読み戻し(他の項目は消えない)');
await P.save(NS, 'settings', 'config', { laborCostPerHour: 1234, labels: { schema: 'labels/1', words: { ロット: '指図' }, keys: { 'sap.title': '工程の進み' } } }, { merge: true });
await P.save(NS, 'settings', 'config', { labels: { schema: 'labels/1', words: { ロット: '指図' }, keys: { 'sap.title': '工程の進み(2)' } } }, { merge: true });
const cfg = await P.getOne(NS, 'settings', 'config');
ok(cfg.laborCostPerHour === 1234, '同じ文書の他の項目(時給)は残る');
const cl = cleanLabels(cfg.labels);
ok(cl.problems.length === 0 && makeT(cl.labels)('sap.title', 'SAP 工程の進み') === '工程の進み(2)' && makeT(cl.labels)('z', 'ロット') === '指図', '辞書が保存どおり読み戻り、言葉が変わる');

console.log('5) 設定の文書は消せない(firestore.rules の既存の決まり)');
let delBlocked = false;
try { await P.remove(NS, 'settings', 'sap_sort'); } catch { delBlocked = true; }
ok(delBlocked && !!(await P.getOne(NS, 'settings', 'sap_sort')), '登録の文書は消せない');

console.log('6) 1回の読み込みの読み取り数: 控え無しで 1文書、同じ日の2回目は 0');
const c2 = mem(); let reads = 0;
const counting = { getOne: (...a) => { reads++; return P.getOne(...a); } };
await loadSapSort({ provider: counting, ns: NS, now: NOW, cache: c2 });
await loadSapSort({ provider: counting, ns: NS, now: NOW + 60000, cache: c2 });
ok(reads === 1, `2回開いて 読み取り ${reads} 文書`);

console.log('7) テンプレートごとの作業区の結びつけ(templateOps)の保存→読み戻し(管理者だけ)');
const L2 = await loadSapSort({ provider: P, ns: NS, now: NOW, cache: mem() });
const reg2 = withTemplateOps(withTemplateOps(L2.reg, 'parts', 'T1', ['2509']), 'parts', 'M123__T2', ['2519']);
let tcode = '';
try { await saveSapSort({ provider: P, ns: NS, reg: reg2, baseRev: L2.rev, user: WORKER, now: NOW, cache: mem() }); } catch (e) { tcode = e.code; }
ok(tcode === 'not-admin', '管理者でない人は結びつけを保存できない');
const r7 = await saveSapSort({ provider: P, ns: NS, reg: reg2, baseRev: L2.rev, user: ADMIN, now: NOW, cache: mem() });
const L3 = await loadSapSort({ provider: P, ns: NS, now: NOW, cache: mem() });
ok(r7.rev === L2.rev + 1 && eq(wcsOfTemplate('T1', 'M9', L3.reg), ['2509']) && eq(wcsOfTemplate('T2', 'M123', L3.reg), ['2519']) && eq(wcsOfTemplate('T3', 'M123', L3.reg), []), '結びつけ有り・専用(品目コード__テンプレID)・無しが読み戻りで保たれる');

// 後片付け: 設定の文書は規則で消せない為、エミュレータごと止めて消す(呼ぶ側が止める)
console.log(bad ? `RESULT: FAIL (${bad} 件)` : 'RESULT: OK');
process.exit(bad ? 1 : 0);
