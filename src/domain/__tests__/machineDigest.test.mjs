// 🧪 機械の集計(最上位司令塔へ載せる物 top_status/machine)の試験
// 目的: ①数字が機械グループの画面(capacityGroups・handoffList・summarizeSort)と同じ ②入れてよい欄だけが出て指図・品目・客先・金額・作業者名が1つも入らない
//       ③わざと混ぜた見本が全部落ちる ④書くのは管理者だけ・押した時の1件だけ(形が違えば書かない)
// 入力: src/domain/machineDigest.js(作り物の SAP の行から、画面と同じ関数で作った答え)
// 出力: node --test の合否
// 触る外の物: なし(ネットワーク・Firebase に触れない。本物の Firestore での確認は scripts/verify-top-machine-emulator.mjs)
// 確かめ方: node --test src/domain/__tests__/machineDigest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders, handoffList } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { capacityGroups } from '../sapGroups.js';
import { DEFAULT_SAP_SORT } from '../sapSort.js';
import { summarizeSort, SapSortError } from '../sapSortStore.js';
import {
    buildMachineDigest, validateMachineDigest, publishMachineDigest, sortRowsOf, MachineDigestError,
    DIGEST_SCHEMA, TOP_NS, TOP_COL, TOP_DOC, MAX_BYTES,
} from '../machineDigest.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);   // 火曜
const TODAY = '2026-11-17';

// ---- 作り物の SAP の行(わざと「指図らしい長い番号」「品目」「客先らしい品名」を入れる=外へ出ない事を確かめる) ----
const SECRET = { orders: ['4900123456', '4900123457', '4900123458', '4900123459', '4900123460'], item: 'ZZ-SECRET-777', itemText: '客先ABC向け 秘密シャフト 金額123456円' };
const row = (A, B, C, T, extra = {}) => ({ A, B, C, D: T, F: 1, U: SECRET.item, V: SECRET.itemText, ...extra });
const ROWS = [
    // ① 平面研削が今日済(→フライスへ渡った=終わった 1)
    row(SECRET.orders[0], '0010', '2385', '平面研削:a', { J: 1, L: 4, N: 1, H: D(TODAY), I: D(TODAY), R: D('2026-11-15'), S: D(TODAY) }),
    row(SECRET.orders[0], '0020', '2325', 'フライス:b', { J: 1, L: 3, N: 1, R: D(TODAY), S: D('2026-11-20') }),
    // ② フライスが作業中で今日終わる見込み → 次は受入検査(2519=部品検査へ今日届く見込み)
    row(SECRET.orders[1], '0010', '2325', 'フライス:b', { J: 1, L: 3, N: 1, H: D('2026-11-15'), R: D('2026-11-15'), S: D(TODAY) }),
    row(SECRET.orders[1], '0020', '2519', '受入検査', { J: 0, L: 0, N: 0.2, R: D(TODAY), S: D('2026-11-21') }),
    // ③ 平面研削が作業中で今日終わる見込み → 次は歯切り
    row(SECRET.orders[2], '0010', '2385', '平面研削:a', { J: 1, L: 4, N: 1, H: D('2026-11-16'), R: D('2026-11-16'), S: D(TODAY) }),
    row(SECRET.orders[2], '0020', '2392', '歯切り:c', { J: 1, L: 3, N: 1, R: D(TODAY), S: D('2026-11-20') }),
    // ④ 平面研削に大きな仕事(今週あふれる)
    row(SECRET.orders[3], '0010', '2386', '平面研削:a', { J: 2, L: 60, N: 5, R: D(TODAY), S: D('2026-11-20') }),
    // ⑤ どの決まりにも当たらない作業区(まだ仕分けていない) 2行
    row(SECRET.orders[4], '0010', '2397', 'ホーニング:z', { J: 1, L: 2, N: 1, R: D(TODAY), S: D('2026-11-20') }),
    row(SECRET.orders[4], '0020', '2397', 'ホーニング:z', { J: 1, L: 2, N: 1, R: D(TODAY), S: D('2026-11-20') }),
];
function screenAnswers(rows = ROWS, opts = {}) {
    const orders = scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders;
    const cap = capacityGroups(orders, { nowMs: NOW, ...opts });
    const handoffs = handoffList(orders, TODAY);
    const sortSummary = summarizeSort(sortRowsOf(rows), DEFAULT_SAP_SORT);
    return { orders, cap, handoffs, sortSummary };
}
const build = (rows = ROWS, opts = {}, extra = {}) => {
    const a = screenAnswers(rows, opts);
    return { a, d: buildMachineDigest({ cap: a.cap, handoffs: a.handoffs, todayIso: TODAY, builtAtMs: NOW, reg: DEFAULT_SAP_SORT, sortSummary: a.sortSummary, basis: { resource: 'machine', otHours: 0, saturday: false, perQty: true }, ...extra }) };
};

// ---- 数字が画面と同じ ----
test('TM01 グループの週ごとの%・持ち越し・判定は 画面(capacityGroups)の答えと同じ(新しい計算をしていない)', () => {
    const { a, d } = build();
    assert.equal(d.schema, DIGEST_SCHEMA);
    assert.equal(d.groups.length, a.cap.groups.length);
    a.cap.groups.forEach((g, i) => {
        const x = d.groups[i];
        assert.equal(x.name, g.name);
        assert.deepEqual(x.pcts, g.cells.map((c) => (Number.isFinite(c.pct) ? Math.round(c.pct * 100) : null)));   // 画面の pc() と同じ丸め
        assert.equal(x.carryH, Math.round(g.carry)); assert.equal(x.carryN, g.carryN);
        assert.equal(x.workCenters, g.wcs.length); assert.equal(x.open, g.n);
        const over = g.verdict.level === 'red';
        const tight = !over && g.cells.slice(0, 3).some((c) => c.level === 'yellow');
        assert.equal(x.status, over ? 'over' : tight ? 'tight' : 'ok');
    });
    assert.deepEqual(d.summary.reds, a.cap.summary.reds);
    assert.equal(d.summary.allCarryH, Math.round(a.cap.summary.allCarry)); assert.equal(d.summary.allCarryN, a.cap.summary.allCarryN);
    assert.deepEqual(d.weeks.map((w) => [w.name, w.label, w.thin]), a.cap.weeks.map((w) => [w.name, w.label, !!w.thin]));
    // 作り物の狙い: 平面研削は あふれる
    const flat = d.groups.find((g) => g.name === '平面研削');
    assert.equal(flat.status, 'over'); assert.ok(flat.pcts[0] > 100);
});

test('TM02 今日終わる見込み・終わった・部品検査へ届く見込みは 画面の「次の工程への連絡」(handoffList)と同じ数え方', () => {
    const { a, d } = build();
    const machineNames = new Set(a.cap.groups.map((g) => g.name));
    const mine = a.handoffs.filter((h) => machineNames.has(h.fromName));
    assert.equal(d.today.finishToday, mine.filter((h) => h.kind === 'expected' && h.date === TODAY).length);
    assert.equal(d.today.doneToday, mine.filter((h) => h.kind === 'passed' && h.date === TODAY).length);
    assert.equal(d.today.finishToday, 2); assert.equal(d.today.doneToday, 1);   // 作り物の狙い
    assert.equal(d.today.toParts, 1);                                           // フライス → 受入検査(2519)
    assert.deepEqual(d.flow.slice().sort((x, y) => (x.from + x.to < y.from + y.to ? -1 : 1)).map((f) => [f.from, f.to, f.n]),
        [['フライス', '受入検査', 1], ['平面研削', '歯切り', 1]]);
});

test('TM03 まだ仕分けていない作業区は 作業区の番号と件数だけ(作業テキストの見本は載せない)', () => {
    const { a, d } = build();
    assert.equal(a.sortSummary.unclassified.n, 2);
    assert.deepEqual(d.unsorted, { n: 2, wcs: [{ wc: '2397', n: 2 }] });
    assert.ok(!JSON.stringify(d).includes('ホーニング'));
});

test('TM04 画面の設定(残業・土曜・人)を変えた画面の数字も そのまま載る・どの設定かを basis に残す', () => {
    const { a, d } = build(ROWS, { otHours: 2, saturday: true, resource: 'worker' }, { basis: { resource: 'worker', otHours: 2, saturday: true, perQty: true } });
    assert.deepEqual(d.basis, { resource: 'worker', otHours: 2, saturday: true, perQty: true });
    assert.deepEqual(d.groups[0].pcts, a.cap.groups[0].cells.map((c) => Math.round(c.pct * 100)));
    assert.equal(validateMachineDigest(d).ok, true);
});

// ---- 入れてはいけない物が入らない ----
const walkStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, out)); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { out.push(k); walkStrings(x, out); }); return out; };

test('TM05 禁止物: 指図番号・品目・品名・客先らしい文字・金額・作業者名は 出来上がった物のどこにも無い(キー名も)', () => {
    const { d } = build();
    const json = JSON.stringify(d);
    for (const s of [...SECRET.orders, SECRET.item, SECRET.itemText, 'SECRET', '客先', '秘密', '金額', '123456']) assert.ok(!json.includes(s), `「${s}」が入っている`);
    for (const s of walkStrings(d)) assert.ok(!/\d{6,}/.test(s), `長い数字列: ${s}`);
    assert.equal(validateMachineDigest(d).ok, true, validateMachineDigest(d).errors.join(' / '));
    assert.ok(new TextEncoder().encode(json).length < MAX_BYTES / 4, '数KB台に収まる');
});

test('TM06 わざと混ぜた見本は全部落ちる(知らない欄・指図らしい数字列・長い文字・形の違い・大きすぎ)', () => {
    const { d } = build();
    const base = () => clone(d);
    const bad = {
        '指図の欄を足す': (x) => { x.order = SECRET.orders[0]; },
        '品目の欄を足す': (x) => { x.item = SECRET.item; },
        '客先の欄を足す': (x) => { x.customer = '客先ABC'; },
        '金額の欄を足す': (x) => { x.amount = 1234567; },
        '作業者名の欄を足す': (x) => { x.worker = '山田'; },
        '日本語の欄名で足す': (x) => { x['指図番号'] = '1'; },
        'グループの中に品目を足す': (x) => { x.groups[0].items = [SECRET.item]; },
        'グループの中に指図の一覧を足す': (x) => { x.groups[0].orders = SECRET.orders; },
        'グループの名前に指図番号': (x) => { x.groups[0].name = SECRET.orders[0]; },
        'グループの名前に品名': (x) => { x.groups[0].name = SECRET.itemText; },
        'グループの key に指図番号': (x) => { x.groups[0].key = SECRET.orders[1]; },
        '流れの行き先に指図番号つき': (x) => { x.flow.push({ from: '旋盤', to: `歯切り ${SECRET.orders[0]}`, n: 1 }); },
        '流れに指図の欄': (x) => { x.flow[0].order = SECRET.orders[0]; },
        '仕分け未了に作業テキスト': (x) => { x.unsorted.wcs[0].sample = 'ホーニング:z'; },
        '仕分け未了の作業区に指図番号': (x) => { x.unsorted.wcs[0].wc = SECRET.orders[4]; },
        '連絡の中身に指図': (x) => { x.notices = [{ order: SECRET.orders[0] }]; },
        '設定の欄に長い文': (x) => { x.basis.memo = '山田さんの客先ABC向けの分'; },
        '知らない版': (x) => { x.schema = 'top-machine/2'; },
        '版が無い': (x) => { delete x.schema; },
        '作った時刻が文字': (x) => { x.builtAt = '2026-11-17'; },
        '基準日の形が違う': (x) => { x.baseDate = '11/17'; },
        '%が文字': (x) => { x.groups[0].pcts[0] = '118%'; },
        '%が NaN': (x) => { x.groups[0].pcts[0] = NaN; },
        '判定が知らない言葉': (x) => { x.groups[0].status = '客先ABC'; },
        '件数がマイナス': (x) => { x.today.finishToday = -1; },
        '件数が小数': (x) => { x.today.doneToday = 1.5; },
        'グループが多すぎる': (x) => { x.groups = Array.from({ length: 200 }, () => clone(d.groups[0])); },
        '大きすぎる(数十KBを超える)': (x) => { x.flow = Array.from({ length: 5000 }, (_, i) => ({ from: '旋盤', to: '歯切り', n: i })); },
        '配列でないはずの所が配列': (x) => { x.today = [1, 2, 3]; },
        '中身が文字そのもの': () => 'これは文字',
    };
    let n = 0;
    for (const [name, mutate] of Object.entries(bad)) {
        const x = base(); const r = mutate(x);
        const v = validateMachineDigest(r === undefined ? x : r);
        assert.equal(v.ok, false, `落ちるはずが通った: ${name}`);
        assert.ok(v.errors.length > 0, name);
        n++;
    }
    assert.ok(n >= 25);
    // 何も混ぜなければ通る(落とし過ぎていない)
    assert.equal(validateMachineDigest(d).ok, true);
    assert.equal(validateMachineDigest(null).ok, false); assert.equal(validateMachineDigest(undefined).ok, false);
});

test('TM07 作る側も 禁止物を落とす: グループ名・作業区に長い数字列があれば 作らずに止まる', () => {
    const { a } = build();
    const cap = clone(a.cap); cap.groups[0].name = SECRET.orders[0];
    assert.throws(() => buildMachineDigest({ cap, handoffs: [], todayIso: TODAY, builtAtMs: NOW, reg: DEFAULT_SAP_SORT, sortSummary: a.sortSummary }), (e) => e instanceof MachineDigestError && e.code === 'invalid');
});

// ---- 書く ----
function fakeProvider() {
    const p = { reads: 0, writes: 0, calls: [],
        async getOne() { p.reads++; return null; },
        async save(ns, col, id, data, opts) { p.writes++; p.calls.push({ ns, col, id, data: clone(data), opts }); } };
    return p;
}
const ADMIN = { name: '管理者' };

test('TM08 載せる: 管理者の押した1回で 1件だけ書く(置き場 overview-app-v1/top_status/machine・丸ごと置き換え・読みは0)', async () => {
    const { d } = build(); const p = fakeProvider();
    const r = await publishMachineDigest({ provider: p, digest: d, user: ADMIN });
    assert.equal(p.writes, 1); assert.equal(p.reads, 0);
    assert.deepEqual([p.calls[0].ns, p.calls[0].col, p.calls[0].id, p.calls[0].opts], [TOP_NS, TOP_COL, TOP_DOC, { merge: false }]);
    assert.deepEqual([TOP_NS, TOP_COL, TOP_DOC], ['overview-app-v1', 'top_status', 'machine']);
    assert.deepEqual(p.calls[0].data, d);
    assert.ok(r.bytes > 0 && r.bytes < MAX_BYTES);
});

test('TM09 載せる: 管理者でなければ 窓口に触る前に拒む', async () => {
    const { d } = build();
    for (const user of [{ name: '山田' }, { name: '' }, null, undefined]) {
        const p = fakeProvider();
        await assert.rejects(publishMachineDigest({ provider: p, digest: d, user }), (e) => e instanceof SapSortError && e.code === 'not-admin');
        assert.equal(p.writes + p.reads, 0);
    }
});

test('TM10 載せる: 形が違う物・禁止物が混ざった物は 書かない(管理者でも)', async () => {
    const { d } = build();
    for (const mutate of [(x) => { x.order = SECRET.orders[0]; }, (x) => { x.groups[0].name = SECRET.orders[2]; }, (x) => { x.groups = 'x'; }]) {
        const x = clone(d); mutate(x); const p = fakeProvider();
        await assert.rejects(publishMachineDigest({ provider: p, digest: x, user: ADMIN }), (e) => e instanceof MachineDigestError && e.code === 'invalid');
        assert.equal(p.writes, 0);
    }
    await assert.rejects(publishMachineDigest({ provider: null, digest: d, user: ADMIN }), (e) => e instanceof MachineDigestError && e.code === 'no-provider');
});

test('TM11 sortRowsOf: 未完了の行だけを (作業区・作業テキスト)ごとの件数にする(済の行は数えない)', () => {
    const rows = [row('1', '10', '2397', 'ホーニング:z', { I: D(TODAY) }), row('2', '10', '2397', 'ホーニング:z'), row('3', '10', '2397', 'ホーニング:z')];
    assert.deepEqual(sortRowsOf(rows), [{ text: 'ホーニング:z', code: '2397', n: 2 }]);
});
