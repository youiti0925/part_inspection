// 機械グループの画面の約束: 束が足りない時の警告(sapBundleCheck)・グループ全体と作業区の食い違いの言い方・狭い画面の読み方
// 確かめ方: node --test src/domain/__tests__/sapMachineView.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { capacityGroups } from '../sapGroups.js';
import { machineBundleCheck } from '../sapBundleCheck.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);
const R = (o, act, wc, text, extra = {}) => ({ A: o, B: act, C: wc, D: text, U: 'X', V: 'x', F: 1, R: D('2026-11-17'), S: D('2026-11-20'), ...extra });
const sched = (rows) => scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders;

// 指図 n 件: 機械(平面研削)→検査。withInspectOpen=false なら 検査を済にする
const bundle = (n, { inspectOpen, machine = true }) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
        const o = String(2000 + i);
        if (machine) rows.push(R(o, '0010', '2385', '平面研削:a', { J: 1, L: 1 }));
        rows.push(R(o, '0020', '2509', '付帯作業一時置き：三次元検査', inspectOpen ? {} : { H: D('2026-11-10'), I: D('2026-11-11') }));
    }
    return rows;
};

test('MV1 検査が未完了の指図だけの束(orders の束)は「機械グループの負荷が足りません」と言う', () => {
    const c = machineBundleCheck(sched(bundle(12, { inspectOpen: true })));
    assert.equal(c.short, true); assert.equal(c.why, 'inspect-only-orders'); assert.match(c.text, /機械グループの負荷が足りません/); assert.match(c.text, /--mode open/);
});

test('MV2 検査が済んだ指図が混ざる束(open の束)・小さすぎる束は言わない(束の外は数えられない=推測しない)', () => {
    const mixed = [...bundle(8, { inspectOpen: true }), ...bundle(5, { inspectOpen: false }).map((r) => ({ ...r, A: 'm' + r.A }))];
    assert.equal(machineBundleCheck(sched(mixed)).short, false);
    assert.equal(machineBundleCheck(sched(bundle(3, { inspectOpen: true }))).short, false);   // 10 件未満
    assert.equal(machineBundleCheck([]).short, false);
});

test('MV3 検査の行だけの束(inspect-only)は 機械の工程が無いと言う', () => {
    const c = machineBundleCheck(sched(bundle(4, { inspectOpen: true, machine: false })));
    assert.equal(c.short, true); assert.equal(c.why, 'no-machine');
});

test('MV4 グループ全体は足りるが 1 つの作業区が 100%超: summary.redWcGroups に出る(見出しが「あふれない」と言いつつ表が「あふれ」と言う矛盾の元)', () => {
    // 平面研削 2385: 段取り2h+機械38h=40h(窓 4日=31h/台 → 129%)・2386: 1h。グループ合計 41/62 = 66%
    const rows = [R('1', '0010', '2385', '平面研削:a', { J: 2, L: 38 }), R('2', '0010', '2386', '平面研削:b', { J: 1, L: 0 })];
    const cap = capacityGroups(sched(rows), { nowMs: NOW });
    const g = cap.groups[0];
    assert.equal(g.verdict.level, 'green'); assert.equal(g.redWcs, 1);
    assert.deepEqual(cap.summary.reds, []);
    assert.deepEqual(cap.summary.redWcGroups, [{ name: '平面研削', n: 1 }]);
});

test('MV5 画面の文言: グループ全体が足りる行は「あふれ」と書かず 100%超の作業区だと言う・見出しにも作業区の注記・狭い画面は箱の中で横スクロール', () => {
    const v = readFileSync(new URL('../../MachineGroupView.jsx', import.meta.url), 'utf8');
    assert.match(v, /グループ全体では足りる/);
    assert.match(v, /data-testid="sap-mg-wc-over"/);
    assert.match(v, /data-testid="sap-mg-bundle-short"/);
    assert.match(v, /overflow-x-auto[^"]*"[^>]*data-testid="sap-mg-scroll"/);
    assert.match(v, /max-lg:min-w-\[56rem\]/); assert.match(v, /max-lg:whitespace-nowrap/);   // PC 幅(1024px〜)は つぶれ方を変えない(lg 未満だけ)
    assert.doesNotMatch(v, /計画の分だけで あふれるグループは ありません/);   // 作業区の あふれと 食い違う言い方は戻さない
});

test('MV6 いつ来るか: 狭い画面では 一覧を最低幅の箱に入れて横スクロール・PC 幅(821px〜)の規則は変えない', () => {
    const v = readFileSync(new URL('../../InspectArrivalView.jsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../inspectArrival.css', import.meta.url), 'utf8');
    assert.match(v, /className="ia-scroll" data-testid="sap-ia-scroll"><div className="ia-scroll-in">/);
    assert.match(css, /@media \(max-width:820px\)\{[^}]*\.ia \.scrollhint\{display:block\}[^}]*\.ia \.ia-scroll-in\{min-width:48rem\}/);
    assert.match(css, /^\.ia \.grid\{display:grid;grid-template-columns:22rem 6rem 1fr/m);   // PC 幅の列の幅はそのまま
});
