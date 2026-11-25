// 🧪 画面の言葉の辞書の試験(段1)
// 目的: 既定+上書きの重ね方・無い言葉は既定に戻る・壊れた辞書でも落ちない・画面の文字と目録が1字も違わない事を確かめる
// 入力: src/domain/labels.js・labelsDefault.js・画面のソース(MachineGroupView.jsx・SapProgressPanel.jsx)
// 出力: node --test の合否
// 触る外の物: なし(ソースを読むだけ)
// 確かめ方: node --test src/domain/__tests__/labels.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLabels, mergeLabelLayers, makeT, buildLabels, t, setActiveLabels, unknownKeysOf, LABEL_LIMITS, LABEL_CATALOG, COMMON_WORDS } from '../labels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('辞書が空なら、どの文字も1文字も変わらない', () => {
    const tt = makeT(null);
    for (const e of LABEL_CATALOG) assert.equal(tt(e.key, e.text), e.text);
    assert.equal(tt('どこかの目印', '型式 ロット'), '型式 ロット');
    assert.equal(t('x', '今の文字'), '今の文字');   // 既定の辞書(空)
});

test('重ね方: コードの今の文字 → 種類の既定 → 司令塔 → グループ(後ろが強い)・無い言葉は手前の層に戻る', () => {
    const kind = { schema: 'labels/1', keys: { 'machine.title': '種類の既定', 'machine.inner.wc': '種類の作業区' } };
    const cmd = { schema: 'labels/1', keys: { 'machine.title': '司令塔の名前' } };
    const grp = { schema: 'labels/1', keys: { 'machine.title': 'グループの名前' } };
    const tt = makeT(mergeLabelLayers([kind, cmd, grp]));
    assert.equal(tt('machine.title', '機械グループ 負荷'), 'グループの名前');
    assert.equal(tt('machine.inner.wc', '作業区'), '種類の作業区');          // グループに無ければ 種類の既定
    assert.equal(tt('machine.inner.units', '台数'), '台数');                  // どこにも無ければコードの今の文字
    assert.equal(makeT(buildLabels({ commander: cmd }))('machine.title', 'X'), '司令塔の名前');
});

test('単語の置き換え: 目印が無い文字の中の単語だけ変わる・長い単語が先(立旋盤が旋盤に食われない)・目印の上書きが優先', () => {
    const tt = makeT(mergeLabelLayers([{ words: { 型式: '品目コード', 旋盤: 'ターニング', 立旋盤: '縦ターニング' }, keys: { 'a.b': '型式そのまま' } }]));
    assert.equal(tt('z', '型式を選ぶ'), '品目コードを選ぶ');
    assert.equal(tt('z', '立旋盤と旋盤'), '縦ターニングとターニング');
    assert.equal(tt('a.b', '型式を選ぶ'), '型式そのまま');   // 場所を決めた上書きは単語の置き換えより強い
});

test('辞書に1語入れると そこだけ変わる(画面の文字の目録で、他は全部同じ)', () => {
    const tt = makeT(mergeLabelLayers([{ keys: { 'machine.inner.units': '設備数' } }]));
    const changed = LABEL_CATALOG.filter((e) => tt(e.key, e.text) !== e.text).map((e) => e.key);
    assert.deepEqual(changed, ['machine.inner.units']);
});

test('壊れた辞書でも落ちない: 形が違う・知らない版・空の文字・長すぎ・多すぎは捨てて、残りは使う', () => {
    for (const bad of [42, 'x', [], { schema: 'labels/9', keys: { a: 'b' } }, { keys: 5 }, { words: [1, 2] }, { keys: { a: 1, b: '', c: ' ', d: null } }]) {
        const { labels } = cleanLabels(bad);
        assert.deepEqual(Object.keys(labels.keys).filter((k) => !['a'].includes(k)), [], JSON.stringify(bad));
        assert.doesNotThrow(() => makeT(mergeLabelLayers([bad]))('k', '今の文字'));
    }
    const long = { keys: { ok: '短い', ng: 'あ'.repeat(LABEL_LIMITS.textMax + 1) } };
    const r = cleanLabels(long);
    assert.deepEqual(Object.keys(r.labels.keys), ['ok']);
    assert.ok(r.problems.length === 1);
    const many = { keys: Object.fromEntries(Array.from({ length: LABEL_LIMITS.keysMax + 20 }, (_, i) => [`k${i}`, 'x'])) };
    assert.equal(Object.keys(cleanLabels(many).labels.keys).length, LABEL_LIMITS.keysMax);
    // 壊れた層があっても他の層は使う
    const tt = makeT(mergeLabelLayers([{ keys: { q: '生きてる' } }, 12345, null]));
    assert.equal(tt('q', 'x'), '生きてる');
    // t の第2引数が文字でなくても落ちない
    assert.equal(makeT(null)('k', undefined), '');
    assert.equal(makeT(null)('k', 12), '12');
});

test('今使う辞書の差し替え: setActiveLabels で t() が変わり、空に戻すと元の文字', () => {
    setActiveLabels(mergeLabelLayers([{ keys: { 'sap.title': '工程の進み(自分たち)' } }]));
    assert.equal(t('sap.title', 'SAP 工程の進み'), '工程の進み(自分たち)');
    setActiveLabels(null);
    assert.equal(t('sap.title', 'SAP 工程の進み'), 'SAP 工程の進み');
});

test('辞書の上限が設定の文書に収まる: 最大の辞書(300件×30字+100語)でも 1MB の 6% 以下(数字を出す)', () => {
    const keys = Object.fromEntries(Array.from({ length: LABEL_LIMITS.keysMax }, (_, i) => [`machine.some.very.long.key.name.${i}`, 'あ'.repeat(LABEL_LIMITS.textMax)]));
    const words = Object.fromEntries(Array.from({ length: LABEL_LIMITS.wordsMax }, (_, i) => [`単語${i}`, 'い'.repeat(LABEL_LIMITS.textMax)]));
    const bytes = Buffer.byteLength(JSON.stringify({ schema: 'labels/1', rev: 1, words, keys }), 'utf8');
    console.log(`  最大の辞書 = ${bytes} バイト(${(bytes / 1048576 * 100).toFixed(1)}% / 1MB)・今の目録 ${LABEL_CATALOG.length} 件・単語の目録 ${COMMON_WORDS.length} 語`);
    assert.ok(bytes < 0.06 * 1048576);
    assert.ok(COMMON_WORDS.length >= 30 && COMMON_WORDS.length <= 40);
});

test('見張り: 目録の目印と今の文字が、画面のソースに 1字も違わず書いてある(違えば赤)・目録に無い目印の上書きを見つける', () => {
    const cache = new Map();
    const src = (f) => cache.get(f) || (cache.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), cache.get(f));
    for (const e of LABEL_CATALOG) {
        assert.ok(src(e.where).includes(`t('${e.key}', '${e.text}')`), `${e.where} に t('${e.key}', '${e.text}') が無い`);
    }
    // 目録のキーは重ならない
    assert.equal(new Set(LABEL_CATALOG.map((e) => e.key)).size, LABEL_CATALOG.length);
    // わざと1字変えると見つかる
    assert.ok(!src('src/MachineGroupView.jsx').includes("t('machine.title', '機械グループ 負荷X')"));
    assert.deepEqual(unknownKeysOf({ keys: { 'machine.title': 'a', 'machine.typo': 'b' } }), ['machine.typo']);
});
