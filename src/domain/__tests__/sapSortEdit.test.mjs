// 🧪 SAP 工程の仕分けの登録画面の部品の試験(段B): 付け替え・重ね入れ・保存の権限・未仕分けの数・変更後の反映・辞書の既定戻し・テンプレートの結びつけ
// 目的: 管理者の登録画面が使う純粋関数と、保存の権限・読み取り/書き込みの数を確かめる(合成データだけ・実データなし)
// 入力: src/domain/sapSortEdit.js・sapSort.js・sapSortStore.js・labels.js(Firestore の代わりに見本の窓口)
// 出力: node --test の合否
// 触る外の物: なし(ネットワーク・Firebase に触れない)
// 確かめ方: node --test src/domain/__tests__/sapSortEdit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAP_SORT, classifyOp, validateSapSort, groupsOfWc, wcsOfTemplate, setActiveSapSort, getActiveSapSort } from '../sapSort.js';
import { saveSapSort, loadSapSort, summarizeSort, SapSortError } from '../sapSortStore.js';
import { makeT, mergeLabelLayers, buildLabels } from '../labels.js';
import { assignWc, removeShared, sortTargets, rangeText, placementOf, compareSort, sameReg, withLabel, clearLabels, labelsOf, templateChoices, siteWcChoices, setTemplateWc, linkedWcs } from '../sapSortEdit.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const NS = 'parts-inspection-v1';
const ADMIN = { name: '管理者' }, WORKER = { name: '山田' };
const memCache = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
function fakeProvider(initial = null) {
    let doc = initial ? clone(initial) : null;
    const p = { reads: 0, writes: 0,
        async getOne() { p.reads++; return doc ? clone(doc) : null; },
        async save(ns, col, id, data) {
            p.writes++;
            const walk = (v, inArr = false) => { if (Array.isArray(v)) { assert.ok(!inArr, '配列の中の配列'); v.forEach((x) => walk(x, true)); } else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, false)); };
            walk(data); doc = clone(data);
        } };
    return p;
}
// 合成の行(実データでない): 2397・2398 はどの範囲にも当たらず、作業テキストも工程名でない作業区
const ROWS = [
    { text: '2315:旋盤 荒', code: '2315', n: 4 }, { text: '2385:平面研削', code: '2385', n: 5 }, { text: '2386:平面研削', code: '2386', n: 2 },
    { text: '2397:ホーニング', code: '2397', n: 6 }, { text: '2398:バリ取り', code: '2398', n: 3 }, { text: '付帯作業:片付け', code: '2399', n: 1 },
];

test('未仕分け: 数と作業区の一覧が出る(2397・2398 が未分類・付帯作業の本物は数えない)', () => {
    const s = summarizeSort(ROWS, DEFAULT_SAP_SORT);
    assert.equal(s.unclassified.n, 9);
    assert.deepEqual(s.unclassified.byWc.map((e) => [e.wc, e.n]), [['2397', 6], ['2398', 3]]);
});

test('付け替え: 2397 を平面研削へ → 範囲に1つ足され、未分類が 9→3 件・全体の和は変わらない', () => {
    const after = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    assert.equal(validateSapSort(after).ok, true);
    assert.equal(placementOf(after, '2397').group, 'grind_flat');
    assert.equal(classifyOp('2397:ホーニング', '2397', after).name, '平面研削');
    const c = compareSort(ROWS, DEFAULT_SAP_SORT, after);
    assert.equal(c.total.same, true);
    assert.deepEqual([c.unclassified.before, c.unclassified.after], [9, 3]);
    const gf = c.groups.find((g) => g.key === 'grind_flat');
    assert.deepEqual([gf.before, gf.after], [7, 13]);
    assert.equal(DEFAULT_SAP_SORT.commanders[1].groups.find((g) => g.key === 'grind_flat').wcRanges.length, 1, '元の登録は変えない');
});

test('付け替え: 範囲の隣は1つにまとまり・真ん中を他へ移すと範囲が2つに割れる(重ならない)', () => {
    const a = assignWc(DEFAULT_SAP_SORT, '2397', 'gear');
    assert.equal(rangeText(a.commanders[1].groups.find((g) => g.key === 'gear')), '2390〜2397');
    const b = assignWc(DEFAULT_SAP_SORT, '2385', 'lathe');
    assert.equal(rangeText(b.commanders[1].groups.find((g) => g.key === 'grind_flat')), '2381〜2384・2386〜2389');
    assert.equal(validateSapSort(b).ok, true);
    assert.equal(placementOf(b, '2385').group, 'lathe');
    assert.equal(groupsOfWc('2385', b).filter((x) => !x.shared).length, 1, '数えるグループは1つだけ');
});

test('付け替え: 知らないグループ・数字でない作業区は断る', () => {
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, '2397', 'nothing'));
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, 'abc', 'gear'));
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, '2397', 'product'), /選べません/);
});

test('重ね入れ(shared): 元のグループに残したまま重ねだけ足す・数には足さない・「重なっている」の印が出る・外せる', () => {
    const a = assignWc(DEFAULT_SAP_SORT, '2385', 'gear', { shared: true });
    assert.equal(validateSapSort(a).ok, true);
    const p = placementOf(a, '2385');
    assert.equal(p.group, 'grind_flat');
    assert.deepEqual(p.shared.map((x) => x.key), ['gear__shared']);
    assert.equal(classifyOp('2385:平面研削', '2385', a).group, 'grind_flat', '数える先は変わらない');
    const s = summarizeSort(ROWS, a);
    assert.equal(s.total, summarizeSort(ROWS, DEFAULT_SAP_SORT).total);
    assert.equal(s.alsoIn['gear__shared'], 5);
    assert.deepEqual(s.overlaps.map((o) => o.wc), ['2385']);
    const r = removeShared(a, '2385', 'gear');
    assert.equal(sameReg(r.commanders[1].groups.map((g) => g.key), DEFAULT_SAP_SORT.commanders[1].groups.map((g) => g.key)), true);
    assert.equal(summarizeSort(ROWS, r).overlaps.length, 0);
});

test('保存の権限: 管理者以外は窓口に触る前に拒まれ(読み0・書き0)・管理者は1件だけ書く', async () => {
    const after = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    for (const user of [WORKER, { name: 'フリー' }, null]) {
        const p = fakeProvider();
        await assert.rejects(saveSapSort({ provider: p, ns: NS, reg: after, baseRev: 1, user, cache: memCache() }), (e) => e instanceof SapSortError && e.code === 'not-admin');
        assert.equal(p.reads + p.writes, 0);
    }
    const p = fakeProvider();
    const r = await saveSapSort({ provider: p, ns: NS, reg: after, baseRev: DEFAULT_SAP_SORT.rev, user: ADMIN, cache: memCache() });
    assert.equal(r.rev, 2);
    assert.equal(p.writes, 1, '書くのは押した時の1件だけ');
    assert.equal(p.reads, 1, '版の確かめの読みだけ(1件)');
});

test('変更後の反映: 保存 → 別の端末が読む → 仕分けが新しい登録で動く・今使う登録にも入れられる', async () => {
    const p = fakeProvider();
    const after = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    await saveSapSort({ provider: p, ns: NS, reg: after, baseRev: 1, user: ADMIN, cache: memCache() });
    const L = await loadSapSort({ provider: p, ns: NS, cache: memCache() });
    assert.equal(L.usedDefault, false);
    assert.equal(classifyOp('2397:ホーニング', '2397', L.reg).group, 'grind_flat');
    try { setActiveSapSort(L.reg); assert.equal(classifyOp('2397:x', '2397').group, 'grind_flat'); }
    finally { setActiveSapSort(DEFAULT_SAP_SORT); }
    assert.equal(getActiveSapSort(), DEFAULT_SAP_SORT);
});

test('保存できない形(重なる範囲を手で入れた)は保存を断る・画面の compareSort も赤を返す', async () => {
    const bad = clone(assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'));
    bad.commanders[1].groups.find((g) => g.key === 'lathe').wcRanges.push([2385, 2386]);
    assert.equal(compareSort(ROWS, DEFAULT_SAP_SORT, bad).valid, false);
    await assert.rejects(saveSapSort({ provider: fakeProvider(), ns: NS, reg: bad, baseRev: 1, user: ADMIN, cache: memCache() }), (e) => e.code === 'invalid');
});

test('sortTargets: 仕分け先に選べるのは工程のまとまりだけ(検査の現場・重ね入れは出ない)', () => {
    const k = sortTargets(assignWc(DEFAULT_SAP_SORT, '2385', 'gear', { shared: true })).map((x) => x.key);
    assert.ok(k.includes('lathe') && k.includes('wash'));
    assert.ok(!k.includes('product') && !k.includes('parts') && !k.includes('gear__shared'));
});

test('辞書: 言い換えを入れると t() に効き・空にすると今の文字へ・全部戻すと既定(空)に戻る', () => {
    const r1 = withLabel(DEFAULT_SAP_SORT, 'machine', 'keys', 'machine.title', '機械の負荷');
    assert.deepEqual(r1.problems, []);
    const t1 = makeT(mergeLabelLayers([labelsOf(r1.reg, 'machine')]));
    assert.equal(t1('machine.title', '機械グループ 負荷'), '機械の負荷');
    assert.equal(t1('machine.inner.heading', '中の作業区'), '中の作業区', '入れていない言葉は今のまま');
    const r2 = withLabel(r1.reg, 'machine', 'words', '型式', '品目コード');
    assert.equal(makeT(mergeLabelLayers([labelsOf(r2.reg, 'machine')]))('x', '型式を選ぶ'), '品目コードを選ぶ');
    const r3 = withLabel(r2.reg, 'machine', 'keys', 'machine.title', '');
    assert.equal(makeT(mergeLabelLayers([labelsOf(r3.reg, 'machine')]))('machine.title', '機械グループ 負荷'), '機械グループ 負荷', '空にすると今の文字に戻る');
    const r4 = clearLabels(r2.reg, 'machine');
    assert.equal(sameReg(r4, DEFAULT_SAP_SORT), true, '全部戻すと既定と同じ');
    assert.equal(validateSapSort(r2.reg).ok, true);
});

test('辞書: 長すぎる言い換えは入れず理由を返す(元の登録のまま)', () => {
    const r = withLabel(DEFAULT_SAP_SORT, 'machine', 'keys', 'machine.title', 'あ'.repeat(31));
    assert.ok(r.problems.length > 0);
    assert.equal(sameReg(r.reg, DEFAULT_SAP_SORT), true);
});

test('辞書: 保存 → 別の端末が読むと司令塔の辞書が戻り、buildLabels で効く(画面は司令塔の辞書を使う)', async () => {
    const p = fakeProvider();
    const { reg } = withLabel(DEFAULT_SAP_SORT, 'machine', 'keys', 'sap.title', 'SAP の進み(確かめ)');
    await saveSapSort({ provider: p, ns: NS, reg, baseRev: 1, user: ADMIN, cache: memCache() });
    const L = await loadSapSort({ provider: p, ns: NS, cache: memCache() });
    const t = makeT(buildLabels({ commander: L.commanderLabels.machine }));
    assert.equal(t('sap.title', 'SAP 工程の進み'), 'SAP の進み(確かめ)');
});

test('テンプレートの結びつけ: 専用(品目コード__テンプレID)と共通を選び肢に出し・結びつけ・付け替え・外しが wcsOfTemplate に出る', () => {
    const ch = templateChoices({ templates: [{ id: 'tA', name: '受入の検査' }], modelTemplates: [{ model: '見本-A100', templateId: 'tA', baseName: '受入の検査' }] });
    assert.deepEqual(ch.map((c) => c.id), ['tA', '見本-A100__tA']);
    assert.deepEqual(siteWcChoices(DEFAULT_SAP_SORT).map((x) => x.wc), ['2309', '2526', '2509', '2519']);
    assert.equal(siteWcChoices(DEFAULT_SAP_SORT).find((x) => x.wc === '2509').label, '三次元検査');
    let r = setTemplateWc(DEFAULT_SAP_SORT, '見本-A100__tA', '2519');
    assert.deepEqual(wcsOfTemplate('tA', '見本-A100', r), ['2519']);
    assert.deepEqual(wcsOfTemplate('tA', '見本-B220', r), [], '結びつけが無い物は今と同じ([])');
    r = setTemplateWc(r, '見本-A100__tA', '2509');
    assert.deepEqual(linkedWcs(r, '見本-A100__tA'), ['2509'], '付け替えると前の結びつけは外れる');
    r = setTemplateWc(r, '見本-A100__tA', '');
    assert.deepEqual(linkedWcs(r, '見本-A100__tA'), []);
    assert.equal(sameReg(r, DEFAULT_SAP_SORT), true, '外すと既定と同じ');
    assert.throws(() => setTemplateWc(DEFAULT_SAP_SORT, 'tA', '9999'));
    assert.equal(validateSapSort(setTemplateWc(DEFAULT_SAP_SORT, 'tA', '2526')).ok, true);
});

test('保存した後に画面を開き直しても(applySapSortOnce)、保存前の古い登録でなく保存した版・辞書が返る', async () => {
    const { applySapSortOnce, _resetOnceForTest } = await import('../sapSortStore.js');
    _resetOnceForTest();
    const p = fakeProvider(), cache = memCache();
    const first = await applySapSortOnce({ loader: () => loadSapSort({ provider: p, ns: NS, cache }) });
    assert.equal(first.rev, 1);
    const { reg } = withLabel(assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'), 'machine', 'keys', 'sap.title', '進み(確かめ)');
    await saveSapSort({ provider: p, ns: NS, reg, baseRev: first.rev, user: ADMIN, cache });
    const again = await applySapSortOnce({ loader: () => { throw new Error('読み直さない'); } });
    assert.equal(again.rev, 2);
    assert.equal(classifyOp('2397:x', '2397', again.reg).group, 'grind_flat');
    assert.equal(again.commanderLabels.machine.keys['sap.title'], '進み(確かめ)');
    setActiveSapSort(DEFAULT_SAP_SORT); _resetOnceForTest();
});
