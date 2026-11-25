// 🧪 SAP 工程の仕分けの登録(sap-sort/1)に集約した前後で、結果が1つも変わらない事を数字で確かめる試験
// 目的: 切り替え前の関数(fixtures/sapProgressBefore.mjs=git の元の版)と、切り替え後(sapProgress.js → sapSort.js の登録)に、同じ入力を通して差 0 を見る。
//       入力は 作業テキスト×作業区の組み合わせ と、合成データ(scripts/sap_synth・本物の SAP データは使わない)の全工程。
// 入力: scripts/sap_synth/make_synth_xlsx.py と scripts/sap_narrow_for_app.py が作る一時の xlsx(python が要る)
// 出力: node --test の合否(グループ別の件数の表も出す)
// 触る外の物: 一時フォルダの書き込みだけ(ネットワーク・Firebase に触れない)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as before from './fixtures/sapProgressBefore.mjs';
import * as after from '../sapProgress.js';
import { classifyOp, validateSapSort, resolveSapSort, buildCodeDefault, DEFAULT_SAP_SORT, laneOrderOf, appWcsOf, machineKindsOf } from '../sapSort.js';
import { LANE_ORDER } from '../sapBoard.js';
import { readSapXlsx } from '../sapXlsx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/sap_feed/fixtures', n), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const OLD_LANE = ['旋盤', '立旋盤', 'フライス', '横M/C', '門M/C', '平面研削', '円筒研削', '歯切り', '仕様変更', '面取り洗浄', '受入検査', '三次元検査', '検査'];

function py(args) {
    for (const exe of ['python', 'py']) {
        const r = spawnSync(exe, ['-I', '-X', 'utf8', ...args], { cwd: ROOT, encoding: 'utf8' });
        if (!r.error) { assert.equal(r.status, 0, `${args[0]} が失敗: ${r.stderr || r.stdout}`); return; }
    }
    assert.fail('python が見つからない(合成データを作るのに要る)');
}

const TEXTS = ['', '2385:平面研削', '旋盤', 'ﾌﾗｲｽ加工', '仕様変更:旋盤', '仕様変更', '付帯作業', '付帯作業:一時置き', '応援', '現合', '洗浄', '検査前洗浄', '歯切り', '全角：コロン', '  ２３８５：円筒研削 ',
    '横M/C', '門M/C', '立旋盤', '2330:仕様変更', '作業 2381-0010', '三次元検査', '2509:何か', '付帯作業一時置き：三次元検査', '仕様変更:平面研削', '仕様変更:ﾌﾗｲｽ', '旋盤 平面研削', '立旋盤:NC', '付帯作業:洗浄'];
const CODES = [...Array.from({ length: 101 }, (_, i) => String(2300 + i)), 'B05', '', 'abc', '2509', '2519', '2330', ' 2381 ', '2381.0', '0', 'NaN', '2309', '2526', null, 2381, 2509];

async function synthRows() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapsort-'));
    const out = [];
    for (const [seed, orders, quirk] of [[1, 300, null], [2, 300, 'all'], [3, 120, 'all']]) {
        const x = path.join(dir, `s${seed}.xlsx`), n = path.join(dir, `n${seed}.xlsx`);
        py(['scripts/sap_synth/make_synth_xlsx.py', '--out', x, '--seed', String(seed), '--orders', String(orders), ...(quirk ? ['--quirk', quirk] : [])]);
        py(['scripts/sap_narrow_for_app.py', x, n, '--mode', 'all']);
        out.push({ seed, rows: (await readSapXlsx(fs.readFileSync(n))).rows });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
}

test('作業テキスト×作業区の全組み合わせで、切り替え前と切り替え後の name・kind が差 0', () => {
    let n = 0; const kinds = new Set();
    for (const t of TEXTS) for (const c of CODES) {
        const a = before.readWorkName(t, c), b = after.readWorkName(t, c);
        assert.deepEqual(b, a, `差あり: ${JSON.stringify([t, c])}`);
        kinds.add(a.kind); n++;
    }
    assert.deepEqual([...kinds].sort(), ['inspect', 'machine', 'misc', 'wash']);
    console.log(`  組み合わせ ${n} 通り・差 0・kind ${[...kinds].sort().join('/')}`);
});

test('合成データの全工程を通して、工程ごとの分類と集計(グループ別の件数・時間)が丸ごと一致', async () => {
    const sets = await synthRows();
    let stages = 0;
    for (const { seed, rows } of sets) {
        const ob = before.buildOrders(rows), oa = after.buildOrders(rows);
        assert.deepEqual(oa, ob, `seed ${seed}: 指図ごとのまとめが違う`);
        const gAfter = after.loadByGroup(oa);
        assert.deepEqual(gAfter, before.loadByGroup(ob), `seed ${seed}: loadByGroup`);
        assert.deepEqual(after.loadByWorkCenter(oa), before.loadByWorkCenter(ob), `seed ${seed}: loadByWorkCenter`);
        assert.deepEqual(after.dailyLoad(oa, '2026-11-22'), before.dailyLoad(ob, '2026-11-22'), `seed ${seed}: dailyLoad`);
        assert.deepEqual(after.itemSummary(oa), before.itemSummary(ob), `seed ${seed}: itemSummary`);
        // 登録の group 目印も、名前と矛盾しない(同じ名前は同じ group)
        const g = new Map();
        for (const r of rows) { const c = classifyOp(r.D, r.C); if (g.has(c.name) && g.get(c.name) !== c.group) assert.fail(`同じ名前が別の group: ${c.name}`); g.set(c.name, c.group); }
        const n = oa.reduce((s, o) => s + o.stages.length, 0);
        stages += n;
        console.log(`  seed ${seed}: 指図 ${oa.length}・工程 ${n}・グループ ${gAfter.length} 個: ${gAfter.map((x) => `${x.name}=${x.openCount}件/${x.openHours}h`).join(' ')}`);
    }
    assert.ok(stages > 600, `工程が少なすぎる ${stages}`);
    console.log(`  工程 合計 ${stages}・全部一致`);
});

test('画面の並び順・アプリ別の作業区・束に入れる kind が、切り替え前の表と同じ', () => {
    assert.deepEqual(LANE_ORDER, OLD_LANE);
    assert.deepEqual(laneOrderOf(), OLD_LANE);
    assert.deepEqual(appWcsOf(), fx('app_wcs.before.json').apps);
    assert.deepEqual(machineKindsOf(), fx('machine_rules.before.json').machine_kinds);
});

test('コードの既定 = 同梱の登録(_about 以外)・同梱の登録は形の検査を通る', () => {
    const j = clone(DEFAULT_SAP_SORT); delete j._about;
    assert.deepEqual(clone(buildCodeDefault()), j);
    assert.equal(validateSapSort(DEFAULT_SAP_SORT).ok, true);
});

test('登録が無い・壊れている・知らない版・重なりは、今と同じ分け方(既定)で動き理由を返す', () => {
    const ov = clone(DEFAULT_SAP_SORT); ov.commanders[1].groups[0].wcRanges = [[2313, 2325]];   // 旋盤とフライスが重なる
    const bads = [{}, { schema: 'sap-sort/9' }, { schema: 'sap-sort/1', commanders: [] }, '壊れ', 42, ov];
    for (const cand of bads) {
        const r = resolveSapSort(cand);
        assert.equal(r.usedDefault, true);
        assert.ok(r.errors.length > 0);
        for (const t of TEXTS) for (const c of CODES) assert.deepEqual(classifyOp(t, c, r.reg), classifyOp(t, c));
    }
    assert.equal(resolveSapSort(null).usedDefault, true);
    assert.equal(resolveSapSort(null).errors.length, 0);
    assert.equal(resolveSapSort(clone(DEFAULT_SAP_SORT)).usedDefault, false);
});

test('見張りが効く: 登録を1か所だけ変えると、切り替え前との比べが赤になる', () => {
    const mut = clone(DEFAULT_SAP_SORT);
    mut.commanders[1].groups[5].wcRanges = [[2381, 2388]];   // 平面研削の範囲を 1 つ短く(2389 が外れる)
    assert.equal(validateSapSort(mut).ok, true);
    const strip = (x) => JSON.stringify({ name: x.name, kind: x.kind });
    const diffs = TEXTS.flatMap((t) => CODES.map((c) => [t, c])).filter(([t, c]) => strip(classifyOp(t, c, mut)) !== strip(before.readWorkName(t, c)));
    assert.ok(diffs.length > 0, '1 か所変えたのに差が出ない=比べが何も見ていない');
    console.log(`  わざと 2389 を外す → 差 ${diffs.length} 通り(赤になる)`);
});
