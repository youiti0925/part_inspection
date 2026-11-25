// 🧪 機械の集計(最上位司令塔へ載せる top_status/machine)を、本物の Firestore(エミュレータ)で 書いて読み戻す確かめ
// 目的: 作り物の SAP の表(scripts/sap_synth の合成データ)を 画面と同じ読み方(readSapXlsx→buildOrders→scheduleOrders→capacityGroups)で読み →「載せる」→ 読み戻し。
//       ①書く件数は1件だけ ②読み戻した物に 指図番号・品目・品名が1つも無い ③管理者でなければ拒まれ文書は変わらない ④firestore.rules を通って書ける(新しい置き場の許可は要らない)
// 入力: 環境変数 VITE_USE_EMULATOR=1・FIRESTORE_EMULATOR_HOST=127.0.0.1:ポート・FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:ポート(エミュレータは呼ぶ側が起動・本番へは繋がない)
//       SYNTH_APP_XLSX=アプリ用に絞った作り物の xlsx(無ければ python で作る)・SYNTH_BASE_DATE=基準日(既定 2026-11-26)
// 出力: 各確認の ✅/❌ と、最後に RESULT: OK / RESULT: FAIL(失敗があれば終了値 1)。SEED_ONLY=1 なら載せた後に止まらず終了(③の画面の確かめ用に載せたままにする)
// 触る外の物: 127.0.0.1 のエミュレータだけ(demo- で始まるプロジェクト)・作り物の xlsx の読み取り。本番・.env.local・ネットワークの外には触れない
// 確かめ方: node scripts/verify-top-machine-emulator.mjs
import './net-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import * as FS from 'firebase/firestore';
import { providerFor } from '../src/data/provider.js';
import { DEFAULT_PROVIDERS } from '../src/data/routes.js';
import { readSapXlsx } from '../src/domain/sapXlsx.js';
import { buildOrders, handoffList } from '../src/domain/sapProgress.js';
import { scheduleOrders } from '../src/domain/sapSchedule.js';
import { capacityGroups } from '../src/domain/sapGroups.js';
import { baseNowMs } from '../src/domain/sapBoard.js';
import { DEFAULT_SAP_SORT } from '../src/domain/sapSort.js';
import { summarizeSort, SapSortError } from '../src/domain/sapSortStore.js';
import { buildMachineDigest, publishMachineDigest, validateMachineDigest, sortRowsOf, TOP_NS, TOP_COL, TOP_DOC, MachineDigestError } from '../src/domain/machineDigest.js';

const must = (name) => { const x = process.env[name]; if (!x) { console.error(`${name} が未設定です`); process.exit(2); } return x; };
if (process.env.VITE_USE_EMULATOR !== '1') { console.error('VITE_USE_EMULATOR=1 が無いので止めます(本番を書き換えない為)'); process.exit(2); }
const fsHost = must('FIRESTORE_EMULATOR_HOST'), authHost = must('FIREBASE_AUTH_EMULATOR_HOST');
for (const h of [fsHost, authHost]) if (!/^(127\.0\.0\.1|localhost):\d+$/.test(h)) { console.error(`エミュレータの場所が 127.0.0.1 ではありません: ${h}`); process.exit(2); }
const [fh, fp] = fsHost.split(':'), [ah, ap] = authHost.split(':');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✅' : '❌'} ${msg}`); if (!c) bad++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('0) 作り物の SAP の表を用意する(scripts/sap_synth の合成データ・本物は使わない)');
const BASE = process.env.SYNTH_BASE_DATE || '2026-11-26';
let xlsx = process.env.SYNTH_APP_XLSX;
if (!xlsx) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top-machine-synth-'));
    const full = path.join(dir, 'synth.xlsx'); xlsx = path.join(dir, 'app.xlsx');
    const r1 = spawnSync('python', ['-I', '-X', 'utf8', path.join(ROOT, 'scripts/sap_synth/make_synth_xlsx.py'), '--out', full, '--seed', '505', '--base-date', BASE, '--size', 'small'], { encoding: 'utf8' });
    const r2 = spawnSync('python', ['-I', '-X', 'utf8', path.join(ROOT, 'scripts/sap_narrow_for_app.py'), full, xlsx], { encoding: 'utf8' });
    if (r1.status !== 0 || r2.status !== 0) { console.error('作り物の表を作れませんでした', r1.stderr, r2.stderr); process.exit(2); }
}
const { rows, baseDate } = await readSapXlsx(fs.readFileSync(xlsx));
const today = baseDate || BASE;
ok(rows.length > 0, `作り物の表を読めた(${rows.length} 行・基準日 ${today})`);

console.log('1) 画面と同じ読み方で 機械グループの答えを作り、載せる物を作る');
const nowMs = baseNowMs(today);
const orders = scheduleOrders(buildOrders(rows), { nowMs }).orders;
const cap = capacityGroups(orders, { nowMs });
const handoffs = handoffList(orders, today);
const sortSummary = summarizeSort(sortRowsOf(rows), DEFAULT_SAP_SORT);
const digest = buildMachineDigest({ cap, handoffs, todayIso: today, builtAtMs: Date.now(), reg: DEFAULT_SAP_SORT, sortSummary, basis: { resource: 'machine', otHours: 0, saturday: false, perQty: true } });
ok(validateMachineDigest(digest).ok && digest.groups.length === cap.groups.length, `載せる物ができた(グループ ${digest.groups.length}・あふれる ${digest.groups.filter((g) => g.status === 'over').length}・ぎりぎり ${digest.groups.filter((g) => g.status === 'tight').length}・今日終わる見込み ${digest.today.finishToday}・終わった ${digest.today.doneToday}・仕分け未了 ${digest.unsorted.wcs.length} つ)`);

console.log('2) 本物の Firestore(エミュレータ・firestore.rules つき)へ 管理者が載せる → 1件だけ書く');
const app = initializeApp({ apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT || 'demo-top1126b', appId: 'demo' });
connectAuthEmulator(getAuth(app), `http://${ah}:${ap}`, { disableWarnings: true });
await signInAnonymously(getAuth(app));
const db = FS.getFirestore(app);
FS.connectFirestoreEmulator(db, fh, Number(fp));
const P = providerFor(db, FS, DEFAULT_PROVIDERS);
let writes = 0, reads = 0;
const counting = { getOne: (...a) => { reads++; return P.getOne(...a); }, save: (...a) => { writes++; return P.save(...a); } };
const ADMIN = { name: '管理者' };
const r = await publishMachineDigest({ provider: counting, digest, user: ADMIN });
ok(writes === 1 && reads === 0, `書いた件数 ${writes}・読んだ件数 ${reads}(押した時の1件だけ)`);
ok(r.bytes < 32 * 1024, `大きさ ${r.bytes} バイト(上限 32KB)`);

console.log('3) 読み戻し: 載せた物と同じ・指図番号・品目・品名が1つも無い');
const back = await P.getOne(TOP_NS, TOP_COL, TOP_DOC);
ok(eq(back, digest), '読み戻した物が 載せた物と1文字も違わない');
const json = JSON.stringify(back);
const secrets = new Set();
for (const rw of rows) { for (const k of ['A', 'U', 'V']) if (rw[k] != null && String(rw[k]).length >= 3) secrets.add(String(rw[k])); }
const hits = [...secrets].filter((s) => json.includes(s));
ok(secrets.size > 20 && hits.length === 0, `表にあった 指図番号・品目・品名 ${secrets.size} 種類のうち 載せた物に入っていたのは ${hits.length} 個${hits.length ? ': ' + hits.slice(0, 3).join(',') : ''}`);
const strs = []; (function w(v) { if (typeof v === 'string') strs.push(v); else if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strs.push(k); w(x); } })(back);
ok(strs.length > 20 && !strs.some((x) => /\d{6,}/.test(x)), '文字(欄の名前も)に 長い数字列(指図番号らしい物)が無い');

console.log('4) 管理者でなければ拒まれ、文書は変わらない');
const before = await P.getOne(TOP_NS, TOP_COL, TOP_DOC);
for (const user of [{ name: '山田' }, { name: '' }, null]) {
    let code = '';
    try { await publishMachineDigest({ provider: counting, digest: { ...digest, builtAt: digest.builtAt + 1 }, user }); } catch (e) { code = e instanceof SapSortError ? e.code : String(e); }
    ok(code === 'not-admin', `${user ? `「${user.name}」` : 'null'} は拒まれた(${code})`);
}
ok(eq(before, await P.getOne(TOP_NS, TOP_COL, TOP_DOC)) && writes === 1, '拒んだ後も 文書は変わらず 書いた回数は 1 のまま');

console.log('5) 禁止物が混ざった物は 管理者でも書かない(わざと混ぜる)');
for (const [name, mut] of [['指図の欄', (x) => { x.order = [...secrets][0]; }], ['グループ名に指図番号', (x) => { x.groups[0].name = '4900123456'; }], ['品目の一覧', (x) => { x.groups[0].items = ['ZZ-1']; }]]) {
    const x = JSON.parse(JSON.stringify(digest)); mut(x);
    let code = '';
    try { await publishMachineDigest({ provider: counting, digest: x, user: ADMIN }); } catch (e) { code = e instanceof MachineDigestError ? e.code : String(e); }
    ok(code === 'invalid', `${name} → 書かれなかった(${code})`);
}
ok(writes === 1 && eq(before, await P.getOne(TOP_NS, TOP_COL, TOP_DOC)), '書いた回数は 1 のまま・文書は変わらない');

console.log('6) 押し直すと丸ごと置き換わる(前の欄が残らない)・置き場は 1件のまま');
const d2 = { ...digest, builtAt: digest.builtAt + 60000 };
await publishMachineDigest({ provider: counting, digest: d2, user: ADMIN });
ok(eq(await P.getOne(TOP_NS, TOP_COL, TOP_DOC), d2) && writes === 2, '2回目で 作った時刻が新しくなった(書いた回数 2)');

console.log(bad ? `RESULT: FAIL (${bad} 件)` : 'RESULT: OK');
process.exit(bad ? 1 : 0);
