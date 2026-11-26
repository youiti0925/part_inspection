// 🧪 採点(docs/採点_登録画面と機械の札_1126.md)の部品側の直し: P1 P2 P3 P6 P7 P8 P9 P10 P12 P13
// 目的: 各直しが 直す前は赤・直した後は緑になる事を、作り物の登録と窓口で確かめる(実データなし・ネットワークなし)
// 入力: sapSortStore.js・sapSortEdit.js・sapSort.js・machineDigest.js・画面の部品(SapSortAdmin.jsx・TopPublishBar.jsx は文字の読みだけ)
// 触る外の物: なし
// 確かめ方: node --test src/domain/__tests__/sapSortFixes1126.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_SAP_SORT, classifyCore, validateSapSort } from '../sapSort.js';
import { loadSapSort, saveSapSort, toStored, toUpper, prevOfStored, summarizeSort, SapSortError, applySapSortOnce, _resetOnceForTest } from '../sapSortStore.js';
import { assignWc, placementOf, compareSort, loadState, exportSortFile, MISC_KEY } from '../sapSortEdit.js';
import { buildMachineDigest, needsStaleConfirm, friendlyDigestError } from '../machineDigest.js';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { capacityGroups } from '../sapGroups.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const NS = 'parts-inspection-v1';
const ADMIN = { name: '管理者' };
const memCache = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
const NOW = new Date(2026, 10, 26, 9, 0, 0).getTime();
const DAY = '2026-11-26';
const ROWS = [
    { text: '2315:旋盤 荒', code: '2315', n: 4 }, { text: '2385:平面研削', code: '2385', n: 5 }, { text: '2386:平面研削', code: '2386', n: 2 },
    { text: '2397:ホーニング', code: '2397', n: 6 }, { text: '2398:バリ取り', code: '2398', n: 3 }, { text: '付帯作業:片付け', code: '2399', n: 1 },
];
/** 取引つきの見本の窓口(saveIfRev を持つ・同時に呼ばれても1つずつ通る=本物の runTransaction と同じ意味) */
function txProvider(initial = null) {
    let doc = initial ? clone(initial) : null;
    let chain = Promise.resolve();
    const p = { reads: 0, writes: 0,
        async getOne() { p.reads++; return doc ? clone(doc) : null; },
        saveIfRev(ns, col, id, expectRev, build, defaultRev = 1) {
            const run = chain.then(async () => {
                p.reads++;
                const cur = doc ? clone(doc) : null;
                const curRev = cur && Number.isFinite(cur.rev) ? cur.rev : defaultRev;
                if (curRev !== Number(expectRev)) return { ok: false, reason: 'stale', cur, rev: curRev };
                const d = build(cur); p.writes++; doc = clone(d);
                return { ok: true, doc: d, rev: curRev };
            });
            chain = run.catch(() => {});
            return run;
        },
        peek: () => doc };
    return p;
}
/** 取引の無い見本の窓口(読み→書きの間で他の人が割り込める) */
function plainProvider(initial = null) {
    let doc = initial ? clone(initial) : null;
    const p = { reads: 0, writes: 0,
        async getOne() { p.reads++; const d = doc ? clone(doc) : null; await Promise.resolve(); await Promise.resolve(); return d; },
        async save(ns, col, id, data) { p.writes++; doc = clone(data); },
        peek: () => doc };
    return p;
}
const withRev = (reg, rev) => ({ ...toStored(reg), rev });

// ---------------- P1: 他の人が先に直した後も 二度と保存できなくならない ----------------
test('P1 控えが第3版・サーバーが第4版 → 保存は断る → その後の読みは第4版 → 第4版を元にした保存が通る(取引なしの窓口)', async () => {
    const reg4 = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    const prov = plainProvider(withRev(reg4, 4));
    const cache = memCache(); cache.set({ day: DAY, doc: withRev(DEFAULT_SAP_SORT, 3) });
    const mine = assignWc(DEFAULT_SAP_SORT, '2398', 'gear');
    await assert.rejects(saveSapSort({ provider: prov, ns: NS, reg: mine, baseRev: 3, user: ADMIN, cache, now: NOW }), (e) => e instanceof SapSortError && e.code === 'stale' && e.detail.rev === 4 && !/開き直して/.test(e.message));
    const L = await loadSapSort({ provider: prov, ns: NS, cache, now: NOW });
    assert.equal(L.rev, 4, '控えが 第4版に変わっている');
    assert.equal(classifyCore('2397:x', '2397', L.reg).out.group, 'grind_flat');
    const r = await saveSapSort({ provider: prov, ns: NS, reg: assignWc(L.reg, '2398', 'gear'), baseRev: L.rev, user: ADMIN, cache, now: NOW });
    assert.equal(r.rev, 5);
});

test('P1 断った時に 画面が使う「新しい版」(detail.latest)と、開き直した時の読み(applySapSortOnce)も 第4版になる', async () => {
    _resetOnceForTest();
    const reg4 = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    const prov = txProvider(withRev(reg4, 4));
    await applySapSortOnce({ loader: () => loadSapSort({ provider: prov, ns: NS, cache: memCache(), now: NOW }) });   // 1回読んだ後の状態
    let err;
    try { await saveSapSort({ provider: prov, ns: NS, reg: DEFAULT_SAP_SORT, baseRev: 3, user: ADMIN, cache: memCache(), now: NOW }); } catch (e) { err = e; }
    assert.equal(err.code, 'stale');
    assert.equal(classifyCore('2397:x', '2397', err.detail.latest).out.group, 'grind_flat');
    const again = await applySapSortOnce({});
    assert.equal(again.rev, 4);
    _resetOnceForTest();
});

// ---------------- P2: 同時に押しても 後の人が前の人の直しを消さない ----------------
test('P2 取引つきの窓口: 2人が同時に 第1版から保存 → 1人だけ通り・もう1人は断られ・書く回数は1', async () => {
    const prov = txProvider();
    const a = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'), b = assignWc(DEFAULT_SAP_SORT, '2398', 'gear');
    const res = await Promise.allSettled([
        saveSapSort({ provider: prov, ns: NS, reg: a, baseRev: 1, user: ADMIN, cache: memCache(), now: NOW }),
        saveSapSort({ provider: prov, ns: NS, reg: b, baseRev: 1, user: ADMIN, cache: memCache(), now: NOW }),
    ]);
    assert.deepEqual(res.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(res.find((r) => r.status === 'rejected').reason.code, 'stale');
    assert.equal(prov.writes, 1);
    assert.equal(prov.reads, 2, '読みは取引の中の1回ずつだけ(別に getOne を足さない)');
});

test('P2 取引の無い窓口(PocketBase)は今の2手のまま動く(読み1・書き1)', async () => {
    const prov = plainProvider();
    const r = await saveSapSort({ provider: prov, ns: NS, reg: assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'), baseRev: 1, user: ADMIN, cache: memCache(), now: NOW });
    assert.equal(r.rev, 2); assert.equal(prov.reads, 1); assert.equal(prov.writes, 1);
});

test('P2 窓口が「saveIfRev に対応していません」と返す保管庫でも 2手へ落ちて保存できる', async () => {
    const prov = plainProvider();
    prov.saveIfRev = async () => { throw new Error('保管庫「pocketbase」は saveIfRev に対応していません (x/y)'); };
    const r = await saveSapSort({ provider: prov, ns: NS, reg: assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'), baseRev: 1, user: ADMIN, cache: memCache(), now: NOW });
    assert.equal(r.rev, 2);
});

// ---------------- P3: 読めなかった・壊れている時は 直す・保存を止める ----------------
test('P3 loadState: 読めなかった/壊れている/知らない版は ロック・本当に文書が無い時だけ「まだ保存した登録はありません」', async () => {
    const bad = await loadSapSort({ provider: plainProvider({ ...toStored(DEFAULT_SAP_SORT), schema: 'sap-sort/99', rev: 7 }), ns: NS, cache: memCache(), now: NOW });
    assert.equal(loadState(bad).locked, true); assert.match(loadState(bad).text, /読めませんでした/); assert.doesNotMatch(loadState(bad).text, /まだ保存した登録はありません/);
    const failing = { async getOne() { throw new Error('通信できません'); } };
    const err = await loadSapSort({ provider: failing, ns: NS, cache: memCache(), now: NOW });
    assert.equal(err.source, 'error'); assert.equal(loadState(err).locked, true);
    const none = await loadSapSort({ provider: plainProvider(), ns: NS, cache: memCache(), now: NOW });
    assert.deepEqual([loadState(none).locked, loadState(none).empty], [false, true]); assert.match(loadState(none).text, /まだ保存した登録はありません/);
    const ok = await loadSapSort({ provider: plainProvider(withRev(DEFAULT_SAP_SORT, 2)), ns: NS, cache: memCache(), now: NOW });
    assert.deepEqual([loadState(ok).locked, loadState(ok).empty], [false, false]);
});

// ---------------- P6: 付帯作業(数えない)への出口 ----------------
test('P6 2398 を付帯作業(数えない)へ → 未分類 0・全体の件数は同じ・負荷のグループの件数は変わらない', () => {
    const after = assignWc(DEFAULT_SAP_SORT, '2398', MISC_KEY);
    assert.equal(validateSapSort(after).ok, true);
    assert.equal(placementOf(after, '2398').group, MISC_KEY);
    assert.equal(classifyCore('2398:バリ取り', '2398', after).via, 'misc');
    assert.equal(classifyCore('2398:バリ取り', '2398', after).out.kind, 'misc');
    const c = compareSort(ROWS, DEFAULT_SAP_SORT, after);
    assert.equal(c.total.same, true);
    assert.deepEqual([c.unclassified.before, c.unclassified.after], [9, 6]);   // 2398(3件)だけ減る
    assert.equal(c.load.after, c.load.before, '機械の負荷に数える件数は 変わらない');
    const both = assignWc(after, '2397', MISC_KEY);
    assert.equal(summarizeSort(ROWS, both).unclassified.n, 0);
    assert.equal(assignWc(after, '2398', 'gear').commanders[1].special.misc.wcRanges, undefined, '普通のグループへ戻すと 付帯作業の範囲から抜ける');
    assert.equal(validateSapSort(assignWc(after, '2398', 'gear')).ok, true);
});

test('P6 付帯作業の範囲が 他のグループの範囲と重なる登録は 保存できない形(赤)', () => {
    const bad = clone(assignWc(DEFAULT_SAP_SORT, '2398', MISC_KEY));
    bad.commanders[1].special.misc.wcRanges.push([2385, 2385]);
    assert.equal(validateSapSort(bad).ok, false);
});

// ---------------- P7: 1つ前の版・書き出し ----------------
test('P7 保存すると 1つ前の版が prev に1つだけ残り(prev の中の prev は無い)・読み戻して取り出せる', async () => {
    const prov = txProvider();
    const a = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat'), b = assignWc(a, '2398', 'gear');
    await saveSapSort({ provider: prov, ns: NS, reg: a, baseRev: 1, user: ADMIN, cache: memCache(), now: NOW });
    await saveSapSort({ provider: prov, ns: NS, reg: b, baseRev: 2, user: ADMIN, cache: memCache(), now: NOW });
    const doc = prov.peek();
    assert.equal(doc.rev, 3); assert.equal(doc.prev.rev, 2); assert.equal(doc.prev.prev, undefined);
    const L = await loadSapSort({ provider: prov, ns: NS, cache: memCache(), now: NOW });
    assert.equal(L.prev.rev, 2);
    assert.notEqual(classifyCore('2398:x', '2398', L.prev.reg).out.group, 'gear', '1つ前の版では 2398 はまだ歯切りでない');
    assert.equal(prevOfStored({ prev: { schema: 'sap-sort/99' } }), null);
});

test('P7 書き出し: 版つきのファイル名・登録そのまま・テンプレートの結びつけ(品目コード)は入れない', () => {
    const reg = clone(DEFAULT_SAP_SORT); reg.rev = 4;
    reg.commanders[0].groups.find((g) => g.key === 'parts').templateOps = { 'ZZ-ITEM-1__tpl1': ['2519'] };
    const f = exportSortFile(reg);
    assert.equal(f.name, 'sap_sort_rev4.json');
    assert.doesNotMatch(f.text, /ZZ-ITEM-1|templateOps/);
    assert.equal(JSON.parse(f.text).schema, 'sap-sort/1');
});

// ---------------- P8: 重ね入れ・検査の作業区の穴 ----------------
test('P8 ①自分が入っているグループへ重ねて入れられない ②どこにも入っていない番号は重ねだけ入れられない ③移した後に行き先の重ねが残らない ④検査の作業区は動かせない', () => {
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, '2385', 'grind_flat', { shared: true }), /もう このグループに入っています/);
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, '2397', 'gear', { shared: true }), /先に入れるグループを決めてください/);
    const shared = assignWc(DEFAULT_SAP_SORT, '2385', 'gear', { shared: true });
    const moved = assignWc(shared, '2385', 'gear');
    assert.equal(placementOf(moved, '2385').group, 'gear');
    assert.deepEqual(placementOf(moved, '2385').shared, []);
    assert.equal(moved.commanders[1].groups.some((g) => g.key === 'gear__shared'), false, '空になった重ねは消える');
    assert.equal(validateSapSort(moved).ok, true);
    for (const w of ['2509', '2519', '2309', '2526']) assert.throws(() => assignWc(DEFAULT_SAP_SORT, w, 'lathe'), /検査の作業区なので動かせません/);
    assert.throws(() => assignWc(DEFAULT_SAP_SORT, '2509', MISC_KEY), /検査の作業区/);
});

test('P8 登録の検査: 検査の作業区が 工程の範囲に入っている登録は赤', () => {
    const bad = clone(DEFAULT_SAP_SORT);
    bad.commanders[1].groups.find((g) => g.key === 'lathe').wcRanges.push([2509, 2509]);
    const v = validateSapSort(bad);
    assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /2509 は検査の作業区/.test(e)));
});

// ---------------- P9: 保存の前の確かめ ----------------
test('P9 確かめ: 付帯作業の行は「まだ仕分けていない物」を含めない(同じ物を2回数えない)・機械の負荷に数える工程の 今→後 を出す・saveOk', () => {
    const after = assignWc(DEFAULT_SAP_SORT, '2397', 'grind_flat');
    const c = compareSort(ROWS, DEFAULT_SAP_SORT, after);
    const misc = c.groups.find((g) => g.key === 'misc');
    assert.equal(misc.name, '付帯作業');
    assert.deepEqual([misc.before, misc.after], [1, 1], '本物の付帯作業(2399=1件)だけ');
    assert.deepEqual([c.unclassified.before, c.unclassified.after], [9, 3]);
    assert.deepEqual([c.load.before, c.load.after], [11, 17], '旋盤4+平面研削7 → 2397(6件)が平面研削へ増える');
    assert.equal(c.consistent, true); assert.equal(c.saveOk, true);
    const bad = clone(after); bad.commanders[1].groups.find((g) => g.key === 'lathe').wcRanges.push([2385, 2386]);
    assert.equal(compareSort(ROWS, DEFAULT_SAP_SORT, bad).saveOk, false, '赤い登録は saveOk が false');
});

// ---------------- P10: 持ち越しの黄色が上で緑にならない ----------------
test('P10 持ち越しだけが多いグループ(画面は黄色)は 最上位へ載せる時 ぎりぎり(tight)になる', () => {
    const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
    const NOW2 = new Date(2026, 10, 17, 8, 30).getTime();
    const row = { A: '1', B: '0010', C: '2385', D: '平面研削:a', F: 1, J: 1, L: 48, N: 1, R: D('2026-11-09'), S: D('2026-11-13'), U: 'x', V: 'y' };
    const orders = scheduleOrders(buildOrders([row]), { nowMs: NOW2 }).orders;
    const cap = capacityGroups(orders, { nowMs: NOW2 });
    assert.equal(cap.groups[0].verdict.level, 'yellow', '前提: 画面は持ち越しで黄色');
    assert.equal(cap.groups[0].cells.slice(0, 3).some((c) => c.level === 'yellow'), false, '前提: 週のマスは黄色でない');
    const d = buildMachineDigest({ cap, handoffs: [], todayIso: '2026-11-17', builtAtMs: NOW2, reg: DEFAULT_SAP_SORT, sortSummary: null, basis: { resource: 'machine', otHours: 0, saturday: false, perQty: true } });
    assert.equal(d.groups[0].status, 'tight');
});

// ---------------- P12 / P13 ----------------
test('P13 toUpper: テンプレートの結びつけ(品目コード)を落とす・元は変えない', () => {
    const reg = clone(DEFAULT_SAP_SORT);
    reg.commanders[0].groups.find((g) => g.key === 'parts').templateOps = { 'ZZ-ITEM-1__tpl1': ['2519'] };
    const up = toUpper(reg);
    assert.doesNotMatch(JSON.stringify(up), /ZZ-ITEM-1/);
    assert.match(JSON.stringify(reg), /ZZ-ITEM-1/);
});

test('P13 古い表(基準日が今日でない)を載せる時は 確かめが要る', () => {
    assert.equal(needsStaleConfirm('2026-11-25', NOW), true);
    assert.equal(needsStaleConfirm('2026-11-26', NOW), false);
});

test('P12 載せられない理由は よく起きる2つを現場の言葉にする(名前の長さ・長い数字)', () => {
    const e1 = { message: 'x', detail: ['集計.groups[1].name: 文字(1〜24字)ではありません'] };
    assert.match(friendlyDigestError(e1, ['旋盤', 'とても長いグループの名前とても長いグループの名前とても']), /『とても長い.*』が長すぎるので載せられません\(24字まで\)/);
    const e2 = { message: 'x', detail: ['集計.groups[0].name: 名前に長い数字・制御文字は入れられません: 旋盤12345'] };
    assert.match(friendlyDigestError(e2, ['旋盤12345']), /長い数字/);
    assert.equal(friendlyDigestError(new Error('別の理由')), '別の理由');
});

test('画面の部品(文字の読み): 保存した版の番号・ロック・古い版の差し替え・見るだけ/ほかのグループでも見る・持ち越しの確かめ', () => {
    const adm = fs.readFileSync(new URL('../../SapSortAdmin.jsx', import.meta.url), 'utf8');
    assert.match(adm, /const saved = \{ \.\.\.draft, rev: r\.rev \}/, 'P13: 保存した版の番号を入れる');
    assert.match(adm, /setActiveSapSort\(saved\)/);
    assert.match(adm, /const admin = isAdm && !lock\.locked/, 'P3: 読めない時は直せない');
    assert.match(adm, /e\.code === 'stale' && e\.detail && e\.detail\.latest/, 'P1: 古い版を新しい版に差し替える');
    assert.doesNotMatch(adm, /開き直してからやり直して/);
    assert.match(adm, /ほかのグループでも見る\(数は今のグループだけで数えます\)/);
    assert.match(adm, /＋見るだけ/); assert.doesNotMatch(adm, /＋重ね/);
    assert.match(adm, /機械の司令塔のグループ/);
    assert.match(adm, /<details[^>]*>.*仕分けの決まりを見る/s);
    assert.match(adm, /言い換えている言葉/);
    assert.match(adm, /onCommit\(v\) === false\) setV\(value\)/, '入れられない言葉の時は 欄の字を戻す');
    assert.match(adm, /MISC_LABEL/);
    assert.match(adm, /1つ前の版/); assert.match(adm, /書き出す/);
    const bar = fs.readFileSync(new URL('../../TopPublishBar.jsx', import.meta.url), 'utf8');
    assert.match(bar, /movedCount > 0/); assert.match(bar, /needsStaleConfirm/); assert.match(bar, /friendlyDigestError/);
    const mg = fs.readFileSync(new URL('../../MachineGroupView.jsx', import.meta.url), 'utf8');
    assert.match(mg, /movedCount=\{moved\.length\}/);
});
