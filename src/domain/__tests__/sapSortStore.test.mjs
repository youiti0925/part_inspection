// 🧪 SAP 工程の仕分けの登録の置き場の試験(段1)
// 目的: 登録の保存・読み込み(管理者でなければ保存を拒む・版の食い違いを拒む・同じ日は読み直さない)・複数グループの形と重なりの印・未分類の数え方・段0と同じ答えを確かめる
// 入力: src/domain/sapSortStore.js・sapSort.js・groupKinds.js(Firestore の代わりに配列の中の配列を断る見本の窓口を使う)
// 出力: node --test の合否
// 触る外の物: なし(ネットワーク・Firebase に触れない。本物の Firestore での確認は scripts/verify-sap-sort-emulator.mjs)
// 確かめ方: node --test src/domain/__tests__/sapSortStore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOp, classifyCore, validateSapSort, DEFAULT_SAP_SORT, groupsOfWc, overlapMarks, setActiveSapSort, getActiveSapSort, wcsOfTemplate, withTemplateOps } from '../sapSort.js';
import { loadSapSort, saveSapSort, toStored, fromStored, storedSize, summarizeSort, isSapSortAdmin, SapSortError, applySapSortOnce, _resetOnceForTest } from '../sapSortStore.js';
import { GROUP_KINDS, kindsForCommander, kindOfRegGroup, groupKindOf } from '../groupKinds.js';
import { LANE_ORDER } from '../sapBoard.js';
import * as before from './fixtures/sapProgressBefore.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const NS = 'parts-inspection-v1';
const ADMIN = { name: '管理者' }, WORKER = { name: '山田' };

/** Firestore と同じく「配列の中の配列」を断る見本の窓口(読んだ回数・書いた回数も数える) */
function fakeProvider(initial = null) {
    let doc = initial ? clone(initial) : null;
    const p = { reads: 0, writes: 0, failRead: false, last: null,
        async getOne() { p.reads++; if (p.failRead) throw new Error('通信できません'); return doc ? clone(doc) : null; },
        async save(ns, col, id, data, opts) {
            p.writes++;
            const walk = (v, inArr = false) => { if (Array.isArray(v)) { if (inArr) throw new Error('Nested arrays are not supported'); v.forEach((x) => walk(x, true)); } else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, false)); };
            walk(data);
            assert.equal(col, 'settings'); assert.equal(id, 'sap_sort'); assert.equal(opts.merge, false);
            doc = clone(data); p.last = doc;
        } };
    return p;
}
const memCache = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
const NOW = new Date(2026, 10, 26, 9, 0, 0).getTime();

test('配列の中の配列を開いて保存し、読んで戻すと元と同じ(Firestore は入れ子の配列を断る)', () => {
    const st = toStored(DEFAULT_SAP_SORT);
    const walk = (v, inArr = false) => { if (Array.isArray(v)) { assert.ok(!inArr, '入れ子の配列が残っている'); v.forEach((x) => walk(x, true)); } else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, false)); };
    walk(st);
    assert.deepEqual(fromStored(st), clone(DEFAULT_SAP_SORT));
    assert.deepEqual(fromStored(clone(DEFAULT_SAP_SORT)), clone(DEFAULT_SAP_SORT));   // もともと配列の形でも読める
});

test('保存: 管理者でなければ 窓口に触る前に拒む(読みも書きもしない)', async () => {
    for (const user of [WORKER, { name: 'フリー' }, { name: '' }, null, undefined]) {
        const p = fakeProvider();
        await assert.rejects(saveSapSort({ provider: p, ns: NS, reg: DEFAULT_SAP_SORT, baseRev: 1, user, cache: memCache() }), (e) => e instanceof SapSortError && e.code === 'not-admin');
        assert.equal(p.reads + p.writes, 0);
    }
    assert.equal(isSapSortAdmin('管理者'), true);
    assert.equal(isSapSortAdmin('管理者 '), false);
});

test('保存→読み込み: 管理者が保存すると版が1つ上がり、誰がいつを残し、読み戻した登録の答えは保存前と同じ', async () => {
    const p = fakeProvider(), cache = memCache();
    const reg = clone(DEFAULT_SAP_SORT);
    reg.commanders[1].groups[0].name = '旋盤(第1)';
    const r = await saveSapSort({ provider: p, ns: NS, reg, baseRev: DEFAULT_SAP_SORT.rev, user: ADMIN, now: NOW, cache });
    assert.equal(r.rev, 2);
    assert.equal(p.last.updatedBy, '管理者');
    assert.equal(p.last.updatedAt, new Date(NOW).toISOString());
    const L = await loadSapSort({ provider: p, ns: NS, now: NOW + 86400000, cache: memCache() });
    assert.equal(L.usedDefault, false); assert.equal(L.rev, 2); assert.equal(L.source, 'server');
    assert.equal(classifyOp('2315:旋盤', '2315', L.reg).name, '旋盤(第1)');
    assert.equal(classifyOp('2385:平面研削', '2385', L.reg).name, '平面研削');
    // 2回目の保存は版が合っていないと「他の人が先に直しました」
    await assert.rejects(saveSapSort({ provider: p, ns: NS, reg, baseRev: 1, user: ADMIN, now: NOW, cache }), (e) => e.code === 'stale');
    const r2 = await saveSapSort({ provider: p, ns: NS, reg, baseRev: 2, user: ADMIN, now: NOW, cache });
    assert.equal(r2.rev, 3);
});

test('保存: 壊れた登録(知らない版・重なり)は保存しない・大きすぎも保存しない', async () => {
    const p = fakeProvider();
    const bad = clone(DEFAULT_SAP_SORT); bad.commanders[1].groups[1].wcRanges = [[2313, 2319]];
    await assert.rejects(saveSapSort({ provider: p, ns: NS, reg: bad, baseRev: 1, user: ADMIN, cache: memCache() }), (e) => e.code === 'invalid');
    await assert.rejects(saveSapSort({ provider: p, ns: NS, reg: { ...clone(DEFAULT_SAP_SORT), schema: 'sap-sort/9' }, baseRev: 1, user: ADMIN, cache: memCache() }), (e) => e.code === 'invalid');
    const big = clone(DEFAULT_SAP_SORT); big.commanders[0].labels = { keys: { x: 'あ'.repeat(800000) } };
    await assert.rejects(saveSapSort({ provider: p, ns: NS, reg: big, baseRev: 1, user: ADMIN, cache: memCache() }), (e) => e.code === 'too-big');
    assert.equal(p.writes, 0);
});

test('読み込み: 文書が無い・読めない・壊れている・知らない版でも 今と同じ分け方(既定)で動く・同じ日は読み直さない', async () => {
    const same = (L) => assert.equal(classifyOp('2385:平面研削', '2385', L.reg).name, '平面研削');
    const none = await loadSapSort({ provider: fakeProvider(), ns: NS, now: NOW, cache: memCache() });
    assert.equal(none.usedDefault, true); assert.equal(none.source, 'none'); same(none);
    const pf = fakeProvider(); pf.failRead = true;
    const err = await loadSapSort({ provider: pf, ns: NS, now: NOW, cache: memCache() });
    assert.equal(err.usedDefault, true); assert.equal(err.source, 'error'); assert.ok(err.errors.length); same(err);
    for (const doc of [{ schema: 'sap-sort/9' }, { schema: 'sap-sort/1', commanders: 'x' }, { foo: 1 }]) {
        const L = await loadSapSort({ provider: fakeProvider(doc), ns: NS, now: NOW, cache: memCache() });
        assert.equal(L.usedDefault, true); assert.ok(L.errors.length); same(L);
    }
    const none2 = await loadSapSort({ provider: null, ns: NS, now: NOW, cache: memCache() });
    assert.equal(none2.usedDefault, true);
    // 同じ日の2回目は読みに行かない(読み取り 1/日/台)・日が変われば1回
    const p = fakeProvider(), cache = memCache();
    await loadSapSort({ provider: p, ns: NS, now: NOW, cache });
    await loadSapSort({ provider: p, ns: NS, now: NOW + 3600000, cache });
    assert.equal(p.reads, 1);
    await loadSapSort({ provider: p, ns: NS, now: NOW + 86400000, cache });
    assert.equal(p.reads, 2);
    // 読めなかった日でも、前の控えがあればそれで動く
    const pc = fakeProvider(), cc = memCache();
    const reg = clone(DEFAULT_SAP_SORT); reg.commanders[1].groups[0].name = '旋盤(控え)';
    await saveSapSort({ provider: pc, ns: NS, reg, baseRev: 1, user: ADMIN, now: NOW, cache: cc });
    pc.failRead = true;
    const L = await loadSapSort({ provider: pc, ns: NS, now: NOW + 86400000, cache: cc });
    assert.equal(L.source, 'cache'); assert.equal(classifyOp('2315:旋盤', '2315', L.reg).name, '旋盤(控え)');
});

test('段0と同じ答え: 既定の登録を保存→読み戻しても、切り替え前の readWorkName と 作業テキスト×作業区で差 0', async () => {
    const p = fakeProvider(), cache = memCache();
    await saveSapSort({ provider: p, ns: NS, reg: DEFAULT_SAP_SORT, baseRev: 1, user: ADMIN, now: NOW, cache });
    const { reg } = await loadSapSort({ provider: p, ns: NS, now: NOW + 86400000, cache: memCache() });
    const texts = ['', '2385:平面研削', '旋盤', 'ﾌﾗｲｽ加工', '仕様変更:旋盤', '仕様変更', '付帯作業', '付帯作業:一時置き', '応援', '現合', '洗浄', '歯切り', '横M/C', '門M/C', '立旋盤', '三次元検査', '謎の工程', 'ABC'];
    let n = 0;
    for (const t of texts) for (let c = 2300; c <= 2400; c++) {
        const a = before.readWorkName(t, String(c)), b = classifyOp(t, String(c), reg);
        assert.deepEqual({ name: b.name, kind: b.kind }, { name: a.name, kind: a.kind }, `${t}/${c}`); n++;
    }
    for (const c of ['2509', '2519', 'B05', '', null]) for (const t of texts) { const a = before.readWorkName(t, c), b = classifyOp(t, c, reg); assert.deepEqual({ name: b.name, kind: b.kind }, { name: a.name, kind: a.kind }); n++; }
    console.log(`  保存→読み戻しの登録 と 切り替え前: ${n} 通りで差 0`);
});

test('classifyCore は classifyOp と同じ答え(via を足しただけ)', () => {
    for (const t of ['', '旋盤', '洗浄', '付帯作業', '謎の工程', '仕様変更']) for (const c of ['2315', '2509', '9999', '']) {
        assert.deepEqual(classifyCore(t, c).out, classifyOp(t, c));
    }
});

test('未分類の数え方: どの決まりにも当たらず付帯作業へ落ちた物だけを数え、件数と作業区の一覧を出す(今の振る舞い=付帯作業の名前のまま)', () => {
    const rows = [
        { text: '2385:平面研削', code: '2385' }, { text: '旋盤', code: '2315' }, { text: '付帯作業:応援', code: '2399' },   // 本物の付帯作業(決まりに当たる)=未分類ではない
        { text: '謎の工程A', code: '2700' }, { text: '謎の工程B', code: '2700' }, { text: '謎の工程C', code: '2701' }, { text: '洗浄', code: '2800' },
    ];
    const S = summarizeSort(rows);
    assert.equal(S.total, 7);
    assert.equal(S.unclassified.n, 3);
    assert.deepEqual(S.unclassified.byWc.map((x) => [x.wc, x.n]), [['2700', 2], ['2701', 1]]);
    // 今と同じ: 未分類は 付帯作業の中に入ったまま(負荷に数えない)・合計は変わらない
    assert.equal(S.byGroup.misc, 4);
    assert.equal(Object.values(S.byGroup).reduce((a, b) => a + b, 0), S.total);
    // 本物の付帯作業と 未分類は区別できる
    assert.equal(classifyCore('付帯作業:応援', '2399').via, 'misc');
    assert.equal(classifyCore('謎の工程A', '2700').via, 'none');
    assert.equal(summarizeSort([], DEFAULT_SAP_SORT).unclassified.n, 0);
    assert.equal(summarizeSort(null).total, 0);
});

test('複数グループの形: 重ね入れ(shared)は他と重なってよく、重なりの印が出る・数えるのは1つだけ(二重に数えない)', () => {
    const reg = clone(DEFAULT_SAP_SORT);
    reg.commanders[1].groups.unshift({ key: 'grind_all', name: '研削まとめ(見るだけ)', type: 'process', kind: 'machine', count: false, shared: true, wcRanges: [[2371, 2389]] });
    assert.ok(validateSapSort(reg).ok, validateSapSort(reg).errors.join());
    // 重ねたのが shared でない時は 今まで通り保存できない
    const bad = clone(reg); delete bad.commanders[1].groups[0].shared;
    assert.equal(validateSapSort(bad).ok, false);
    // 仕分けの答えは shared を見ない=段0と同じ
    assert.equal(classifyOp('2385:平面研削', '2385', reg).group, 'grind_flat');
    assert.equal(classifyOp('円筒研削', '2375', reg).group, 'grind_round');
    const gs = groupsOfWc('2385', reg);
    assert.deepEqual(gs.map((g) => g.group), ['grind_flat', 'grind_all']);
    assert.equal(gs[0].shared, false);
    const marks = overlapMarks(reg);
    assert.ok(marks.some((m) => m.wc === '2385' && m.groups.join() === 'grind_flat,grind_all'));
    assert.ok(marks.every((m) => Number(m.wc) >= 2371 && Number(m.wc) <= 2389));   // 重ならない作業区には印が付かない
    assert.deepEqual(overlapMarks(DEFAULT_SAP_SORT), []);                          // 既定の登録は重なり0
    const S = summarizeSort([{ text: '平面研削', code: '2385' }, { text: '円筒研削', code: '2375' }, { text: '旋盤', code: '2315' }], reg);
    assert.equal(S.total, 3);
    assert.equal(Object.values(S.byGroup).reduce((a, b) => a + b, 0), 3);   // 数える先は1つだけ(合計 = 行数)
    assert.deepEqual(S.alsoIn, { grind_all: 2 });                            // 見るだけの方は別に出す(足さない)
    assert.equal(S.byGroup.grind_all, undefined);
    assert.equal(S.overlaps.length, marks.length);
    // 保存→読み戻しでも shared が残る
    assert.equal(fromStored(toStored(reg)).commanders[1].groups[0].shared, true);
});

test('登録を差し替えると画面の並び(LANE_ORDER)も同じ配列の中身が入れ替わり、既定へ戻せる', () => {
    const orig = LANE_ORDER.slice();
    const reg = clone(DEFAULT_SAP_SORT); reg.laneOrder = ['歯切り', ...reg.laneOrder.filter((x) => x !== '歯切り')];
    setActiveSapSort(reg);
    assert.equal(LANE_ORDER[0], '歯切り');
    setActiveSapSort(null);
    assert.deepEqual(LANE_ORDER, orig);
    assert.equal(getActiveSapSort(), DEFAULT_SAP_SORT);
    setActiveSapSort({ schema: 'sap-sort/9' });   // 壊れた登録は既定のまま
    assert.equal(getActiveSapSort(), DEFAULT_SAP_SORT);
});

test('画面を開いた時の読み込み: 1回だけ・失敗しても既定のまま・登録があれば今使う登録になる', async () => {
    _resetOnceForTest();
    let calls = 0;
    const reg = clone(DEFAULT_SAP_SORT); reg.commanders[1].groups[0].name = '旋盤X';
    const loader = async () => { calls++; return { reg, usedDefault: false, errors: [], source: 'server', commanderLabels: {} }; };
    await applySapSortOnce({ loader }); await applySapSortOnce({ loader });
    assert.equal(calls, 1);
    assert.equal(classifyOp('旋盤', '2315').name, '旋盤X');
    setActiveSapSort(null); _resetOnceForTest();
    const r = await applySapSortOnce({ loader: async () => { throw new Error('boom'); } });
    assert.equal(r.usedDefault, true);
    assert.equal(classifyOp('旋盤', '2315').name, '旋盤');
    _resetOnceForTest();
});

test('置き場の大きさ: 既定の登録を保存する大きさを数字で出し、1MB に十分な余裕がある', () => {
    const s = storedSize(DEFAULT_SAP_SORT);
    console.log(`  既定の登録 = ${s.bytes} バイト(${(s.ratio * 100).toFixed(2)}% / 1MB)`);
    assert.ok(s.ratio < 0.01);
    // 司令塔20・グループ200・作業区の範囲を各5つ に増えても 1MB の 20% 以内
    const reg = clone(DEFAULT_SAP_SORT);
    for (let i = 0; i < 200; i++) reg.commanders[1].groups.push({ key: `g${i}`, name: `グループ${i}`, type: 'process', kind: 'machine', count: true, wcRanges: Array.from({ length: 5 }, (_, j) => [4000 + i * 10 + j, 4000 + i * 10 + j]) });
    const big = storedSize(reg);
    console.log(`  グループ200個に増やした時 = ${big.bytes} バイト(${(big.ratio * 100).toFixed(1)}% / 1MB)`);
    assert.ok(big.ratio < 0.2);
});

test('種類の台帳: 4種類・工程の仕分けは棚を持たない・司令塔の種類ごとに足せる種類が決まる・登録のグループから種類を引ける', () => {
    assert.deepEqual(GROUP_KINDS.map((k) => k.id), ['final', 'product', 'parts', 'process']);
    assert.equal(groupKindOf('process').hasShelf, false);
    assert.ok(GROUP_KINDS.filter((k) => k.id !== 'process').every((k) => k.hasShelf));
    assert.deepEqual(kindsForCommander('inspect').map((k) => k.id), ['final', 'product', 'parts']);
    assert.deepEqual(kindsForCommander('process').map((k) => k.id), ['process']);
    assert.deepEqual(kindsForCommander('nothing'), []);
    const g = (key) => DEFAULT_SAP_SORT.commanders.flatMap((c) => c.groups).find((x) => x.key === key);
    assert.equal(kindOfRegGroup(g('parts')).id, 'parts');
    assert.equal(kindOfRegGroup(g('lathe')).id, 'process');
    assert.equal(kindOfRegGroup(null), null);
    assert.notEqual(groupKindOf('process').screenWord, groupKindOf('parts').screenWord);
});

test('テンプレートごとの作業区の結びつけ(templateOps): 有り/無し/壊れている/知らない作業区・専用テンプレ・保存→読み戻し・管理者だけ', async () => {
    const reg = withTemplateOps(withTemplateOps(DEFAULT_SAP_SORT, 'parts', 'T1', ['2509']), 'parts', 'M123__T2', ['2519', '2509']);
    assert.ok(validateSapSort(reg).ok);
    assert.deepEqual(wcsOfTemplate('T1', 'M999', reg), ['2509']);
    assert.deepEqual(wcsOfTemplate('T2', 'M123', reg), ['2519', '2509']);   // 品目専用が引ける
    assert.deepEqual(wcsOfTemplate('T2', 'M999', reg), []);                 // 他の品目では専用は効かない
    assert.deepEqual(wcsOfTemplate('T3', 'M123', reg), []);                 // 結びつけ無し=今と同じ
    assert.deepEqual(wcsOfTemplate('T1', 'M1', DEFAULT_SAP_SORT), []);      // 既定の登録は結びつけ0=段0と同じ
    assert.equal(DEFAULT_SAP_SORT.commanders[0].groups.some((g) => g.templateOps), false);
    // 元は変わらない・外せる
    assert.equal(withTemplateOps(reg, 'parts', 'T1', []).commanders[0].groups[2].templateOps.T1, undefined);
    assert.equal(withTemplateOps(withTemplateOps(reg, 'parts', 'T1', []), 'parts', 'M123__T2', []).commanders[0].groups[2].templateOps, undefined);
    assert.throws(() => withTemplateOps(reg, 'nothing', 'T1', ['2509']));
    // 壊れている・知らない作業区は保存できない・読む側は落ちず []
    const unk = withTemplateOps(DEFAULT_SAP_SORT, 'parts', 'T1', ['9999']);
    assert.equal(validateSapSort(unk).ok, false); assert.ok(validateSapSort(unk).errors.join().includes('知らない作業区'));
    assert.deepEqual(wcsOfTemplate('T1', '', unk), []);
    for (const bad of ['x', ['2509'], { T1: '2509' }, { T1: [5] }, { '': ['2509'] }]) {
        const r = clone(DEFAULT_SAP_SORT); r.commanders[0].groups[2].templateOps = bad;
        assert.equal(validateSapSort(r).ok, false, JSON.stringify(bad));
        assert.doesNotThrow(() => wcsOfTemplate('T1', 'M1', r));
        assert.deepEqual(wcsOfTemplate('T1', 'M1', r), bad && bad.T1 && Array.isArray(bad.T1) ? [] : []);
    }
    // 検査の仕分け(classifyOp)は結びつけで変わらない(段0と同じ答え)
    for (const c of ['2509', '2519', '2315', '2385']) assert.deepEqual(classifyOp('x', c, reg), classifyOp('x', c, DEFAULT_SAP_SORT));
    // 保存→読み戻し(管理者だけ)・テンプレ目印の "__" も保たれる
    const p = fakeProvider(), cache = memCache();
    await assert.rejects(saveSapSort({ provider: p, ns: NS, reg, baseRev: 1, user: WORKER, cache }), (e) => e.code === 'not-admin');
    await saveSapSort({ provider: p, ns: NS, reg, baseRev: 1, user: ADMIN, now: NOW, cache });
    const L = await loadSapSort({ provider: p, ns: NS, now: NOW + 86400000, cache: memCache() });
    assert.deepEqual(wcsOfTemplate('T2', 'M123', L.reg), ['2519', '2509']);
    assert.deepEqual(wcsOfTemplate('T1', 'M1', L.reg), ['2509']);
});
