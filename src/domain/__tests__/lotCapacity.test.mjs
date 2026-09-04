import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DOC_LIMIT, SAFE_BYTES, DANGER_BYTES, approxBytes, inlineImagesOf, inlineBytesOf,
    getAt, setAt, planAutoOffload, offloadInsufficient, lotsNeedingOffload,
    predictRecompressed, planRecompress, capacityLabel,
    lotHeavyParts, capacityAdviceFor,
} from '../lotCapacity.js';

const img = (kb) => 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024 - 23);

test('LC01 ロット本体に直接入っている写真を、場所つきで全部拾う', () => {
    const lot = {
        packagingPhotos: { 全体: [img(50), img(60)], 銘板: img(40), メモ: 'lotimg:li-1' },
        tasks: { a: { aiAnalysis: { imageUrl: img(140) } }, b: { aiAnalysis: { imageUrl: 'lotimg:li-2' } }, c: {} },
    };
    const got = inlineImagesOf(lot);
    assert.equal(got.length, 4);
    assert.deepEqual(got.map(g => g.path), [
        ['packagingPhotos', '全体', 0], ['packagingPhotos', '全体', 1],
        ['packagingPhotos', '銘板'], ['tasks', 'a', 'aiAnalysis', 'imageUrl'],
    ]);
    // 別置き済みの参照('lotimg:')は写真として数えない = 二重に数えない
    assert.equal(got.filter(g => g.label.includes('メモ')).length, 0);
});

test('LC02 写真が1枚もないロットは対象外(空配列。例外を投げない)', () => {
    assert.deepEqual(inlineImagesOf(null), []);
    assert.deepEqual(inlineImagesOf({}), []);
    assert.equal(inlineBytesOf({ tasks: { a: { aiAnalysis: { imageUrl: 'lotimg:x' } } } }), 0);
});

test('LC03 ★差分だけで測ると見落とす: 5KBの差分でも合体後が上限に近ければ手を出す', () => {
    // 本番 59a5fa04b8ec の形(写真7枚 983KB + 検査記録)を再現
    const cur = { id: 'x', tasks: { t1: { aiAnalysis: { imageUrl: img(140) } }, t2: { aiAnalysis: { imageUrl: img(140) } } }, memo: 'x'.repeat(500_000) };
    const patch = { tasks: { t3: { status: 'completed' } } }; // 5KBもない差分
    assert.ok(approxBytes(patch) < 5000, '差分は小さい');
    const plan = planAutoOffload(cur, patch);
    assert.equal(plan.needed, true, '差分は小さくても合体後で判断する');
    assert.ok(plan.pull.includes('tasks'));
    assert.ok(plan.freed > 280_000);
});

test('LC04 まだ余裕があるロットには手を出さない(無駄な書き込みをしない)', () => {
    const cur = { tasks: { t1: { aiAnalysis: { imageUrl: img(50) } } } };
    const plan = planAutoOffload(cur, { status: 'completed' });
    assert.equal(plan.needed, false);
    assert.deepEqual(plan.pull, []);
});

test('LC05 差分にすでに packagingPhotos が入っているなら二重に巻き込まない', () => {
    const cur = { packagingPhotos: { 全体: [img(400)] }, tasks: { t: { aiAnalysis: { imageUrl: img(400) } } } };
    const plan = planAutoOffload(cur, { packagingPhotos: { 全体: [img(400)] } });
    assert.equal(plan.needed, true);
    assert.deepEqual(plan.pull, ['tasks'], 'packagingPhotos は差分に入っているので足さない');
});

test('LC06 tasks は差分に一部だけ入る事があるので、必ず合体版を巻き込む', () => {
    const cur = { tasks: { t1: { aiAnalysis: { imageUrl: img(400) } }, t2: { aiAnalysis: { imageUrl: img(400) } } } };
    // 差分に t1 だけ入っている → t2 の写真が取り残されると容量は減らない
    const plan = planAutoOffload(cur, { tasks: { t1: { status: 'completed' } } });
    assert.ok(plan.pull.includes('tasks'));
    assert.equal(plan.images, 2, '合体版から数えるので2枚');
});

test('LC07 ★別置きしても収まらないロットを見分ける(写真以外が重い場合)', () => {
    const heavy = { memo: 'x'.repeat(800_000), tasks: { t: { aiAnalysis: { imageUrl: img(100) } } } };
    assert.equal(offloadInsufficient(heavy), true, '写真を全部逃がしても800KB残る');
    const normal = { memo: 'x'.repeat(50_000), tasks: { t: { aiAnalysis: { imageUrl: img(800) } } } };
    assert.equal(offloadInsufficient(normal), false);
});

test('LC08 起動時の自動移行は「重い順」。軽いロットは急がない', () => {
    const lots = [
        { id: 'small', tasks: { t: { aiAnalysis: { imageUrl: img(50) } } } },   // 300KB未満 → 対象外
        { id: 'big', tasks: { t: { aiAnalysis: { imageUrl: img(800) } } } },
        { id: 'mid', tasks: { t: { aiAnalysis: { imageUrl: img(400) } } } },
        { id: 'noimg', memo: 'x'.repeat(900_000) },                             // 写真なし → 別置きでは直らない
    ];
    const got = lotsNeedingOffload(lots);
    assert.deepEqual(got.map(g => g.id), ['big', 'mid']);
});

test('LC09 setAt は元のオブジェクトを壊さない(呼び元のstateを書き換えない)', () => {
    const lot = { packagingPhotos: { 全体: ['a', 'b'] } };
    const next = setAt(lot, ['packagingPhotos', '全体', 1], 'z');
    assert.equal(lot.packagingPhotos.全体[1], 'b', '元は無傷');
    assert.equal(next.packagingPhotos.全体[1], 'z');
    assert.equal(getAt(next, ['packagingPhotos', '全体', 1]), 'z');
    assert.ok(Array.isArray(next.packagingPhotos.全体), '配列は配列のまま(オブジェクト化するとFirestoreで形が変わる)');
});

test('LC10 再圧縮の見積りは安全側(減りを少なめに言う)。品質を上げる指定では増やさない', () => {
    const b = 100_000;
    assert.ok(predictRecompressed(b, 0.9, 0.55) < b);
    assert.ok(predictRecompressed(b, 0.9, 0.55) > b * 0.4, '減りを大きく言い過ぎない');
    assert.equal(predictRecompressed(b, 0.6, 0.9), b, '上げる指定では元のまま(勝手に増やさない)');
});

test('LC11 ★清水さん案: 必要な分だけ、大きい写真から落とす(小さい写真は触らない)', () => {
    const images = [
        { label: '大', bytes: 140_000 }, { label: '中', bytes: 90_000 },
        { label: '小', bytes: 12_000 }, { label: '極小', bytes: 4_000 },
    ];
    const r = planRecompress(images, { needBytes: 50_000, quality: 0.55, assumeQuality: 0.9 });
    assert.equal(r.picks[0].label, '大', '大きい方から');
    assert.ok(r.predictedFreed >= 50_000);
    assert.ok(!r.picks.some(p => p.label === '極小'), '30KB未満は画質だけ落ちて効かないので触らない');
    assert.equal(r.enough, true);
});

test('LC12 必要量に届かない時は「足りない」と正直に返す(できたふりをしない)', () => {
    const r = planRecompress([{ label: 'a', bytes: 40_000 }], { needBytes: 500_000, quality: 0.4, assumeQuality: 0.9 });
    assert.equal(r.enough, false);
    assert.ok(r.predictedFreed < 500_000);
});

test('LC13 needBytes 未指定なら全部落とす(保管総量を減らす用途)', () => {
    const images = [{ label: 'a', bytes: 100_000 }, { label: 'b', bytes: 80_000 }, { label: 'c', bytes: 5_000 }];
    const r = planRecompress(images, { quality: 0.5, assumeQuality: 0.9 });
    assert.equal(r.picks.length, 2, '30KB未満のcは除外');
    assert.equal(r.enough, true);
});

test('LC14 容量表示は上限に対する割合。しきい値の順序が壊れていない', () => {
    assert.ok(SAFE_BYTES < DANGER_BYTES && DANGER_BYTES < DOC_LIMIT);
    assert.equal(capacityLabel(1_044_000).level, 'danger');
    assert.equal(capacityLabel(750_000).level, 'warn');
    assert.equal(capacityLabel(100_000).level, 'ok');
    // 本番 59a5fa04b8ec の実測 1024KB は「上限の99%以上」と出る
    assert.ok(capacityLabel(1024 * 1024).pct >= 99);
});

// =========================================================================
// 📏 容量の内訳(診断専用) — 2026-08-14 追加
// =========================================================================

// 製品ロットの形。測定図はテンプレから複製されて steps に入り、不具合写真は
// 作業者が撮って interruptions に入る。
const prodLot = ({ diagKb = 0, photoKb = [] } = {}) => ({
    id: 'L1',
    steps: diagKb ? [{ id: 's1', measurementConfig: { diagramImage: img(diagKb) } }] : [],
    interruptions: photoKb.length ? [{ id: 'i1', type: 'defect', photos: photoKb.map((k) => img(k)) }] : [],
    tasks: { 'a-1': { status: 'done', duration: 12 } },
});

// ⚠⚠ **これが今回いちばん大事な試験**。
//   製品の置き場(測定図・不具合写真)を inlineImagesOf が拾い始めると、最終検査の
//   自動整理が「移せる」と数えたのに dehydrate は荷姿写真と tasks しか積まないため
//   減らない → 該当ロットを1回ずつ無駄に書き、全端末を再描画させ、恒久的に諦め印が付く。
//   将来うっかり足した時に、最終検査を触っていなくてもここで落ちる。
test('LC20 ⚠回帰ロック: 測定図と不具合写真は inlineImagesOf が拾わない(拾うと最終検査が壊れる)', () => {
    const lot = prodLot({ diagKb: 50, photoKb: [50] });
    assert.equal(inlineImagesOf(lot).length, 0);
    assert.equal(inlineBytesOf(lot), 0);
    // 自動整理の対象にも入らない
    assert.equal(lotsNeedingOffload([lot], { minBytes: 1, minImageBytes: 1000 }).length, 0);
    // 別置きの計画も立たない(＝空振りの書き込みが起きない)。images は「枚数」。
    // ⚠safeBytes を 1 まで下げて「本体が重い」状態を作ってもなお 0 枚であること。
    //   ここを下げないと before<=safe で早期に返り、拾わないことの証明にならない。
    const plan = planAutoOffload(lot, {}, { safeBytes: 1 });
    assert.equal(plan.needed, true, '重いことは認識する');
    assert.equal(plan.images, 0, '移せる写真は0枚(＝空振りの書き込みが起きない)');
    assert.deepEqual(plan.pull, []);
});

test('LC21 測定図は steps の内訳として出る(二重に足さない)', () => {
    const r = lotHeavyParts(prodLot({ diagKb: 100 }));
    assert.ok(r.diagramBytes > 90 * 1024);
    const steps = r.parts.find((p) => p.key === 'steps');
    assert.ok(steps, 'steps が parts に出る');
    assert.ok(steps.bytes >= r.diagramBytes, 'steps は測定図を含む(内訳)');
    assert.equal(steps.label, '工程の設定(測定図の絵を含む)');
});

test('LC22 測定図しか無いロットは「減らせる物ゼロ」', () => {
    const r = lotHeavyParts(prodLot({ diagKb: 300 }));
    assert.equal(r.removableBytes, 0);
    assert.equal(r.parts.every((p) => p.removable === false), true);
});

test('LC23 不具合写真だけが removable(作業者が自分で消せる唯一の重い物)', () => {
    const r = lotHeavyParts(prodLot({ diagKb: 100, photoKb: [200, 150] }));
    const ph = r.parts.find((p) => p.key === 'defectPhoto');
    assert.equal(ph.removable, true);
    assert.equal(ph.label, '不具合の写真 2枚');
    assert.ok(r.removableBytes > 340 * 1024);
    // parts は重い順
    for (let i = 1; i < r.parts.length; i++) assert.ok(r.parts[i - 1].bytes >= r.parts[i].bytes);
});

test('LC24 壊れた入力でも落ちない(保存の途中で例外を出すと保存自体が止まる)', () => {
    for (const bad of [null, undefined, {}, 'x', 5, { steps: 'no', interruptions: 7 },
        { steps: [{ measurementConfig: null }], interruptions: [{ photos: 'no' }] },
        { interruptions: [null, { photos: [null, 123, 'notimage'] }] }]) {
        const r = lotHeavyParts(bad);
        assert.equal(typeof r.removableBytes, 'number');
        assert.equal(Array.isArray(r.parts), true);
    }
});

// ⚠文面そのものを固定する。最終検査の文をコピーで戻されたら、ここで落ちる。
test('LC25 減らせない時の文に「写真を減らして」と製品に無い画面名を出さない', () => {
    const a = capacityAdviceFor(prodLot({ diagKb: 300 }));
    assert.equal(a.canFix, false);
    assert.equal(/写真.*減ら/.test(a.text), false, '減らせないのに写真を減らせと言っている');
    assert.equal(a.text.includes('画像データ管理'), false, '製品に無い画面へ案内している');
    assert.equal(a.afterFail.includes('画像データ管理'), false);
    assert.ok(a.text.includes('事務所'), '手が無い時は事務所へ回す');
    assert.ok(a.text.includes('入力はこのまま残ります'));
});

test('LC26 減らせる時だけ、どこで何KB減らせるかを言う', () => {
    const a = capacityAdviceFor(prodLot({ diagKb: 50, photoKb: [200] }));
    assert.equal(a.canFix, true);
    assert.ok(a.text.includes('不具合報告'), '消しに行く場所を言う');
    assert.ok(/\d+KB/.test(a.text), '何KB空くかを言う');
    assert.equal(a.text.includes('事務所'), false);
    assert.ok(a.afterFail.includes('入力は消えていません'));
});

// ============================================================================
// 🚨 2026-09-04 追加。実測: この下の3つが無いと、25通り壊して18通りが緑だった
//   (＝2026-07-26 の「1MB上限」の見張りが、境界と経路を1つも見ていなかった)。
//   壊して赤になる事を4点セットで確かめてある:
//     ① path[0] → path[1]（荷姿写真を引き剥がす道が死ぬ）
//     ② freed >= need → freed > need（ちょうど足りる時に1枚多く落とす）
//
//   ⚠ 3つ目に挙がっていた「169行 t >= f を t > f にしても緑」は **赤にできません**。
//     t === f の時に通る式は Math.round(bytes * Math.pow(1, 1.35)) = bytes で、
//     返す値が1バイトも変わらないからです(実測: 1 / 7 / 99999 / 123457 / 1000003 で確認)。
//     つまりこの書き換えは **結果が同じ**＝欠陥ではありません。緑のままが正しい。
//     下の LC33 は「同じ画質では減らない」という **決まりの方** を留めています。
// ============================================================================

test('LC30 🚨荷姿写真だけで上限を越えたら、荷姿写真を引き剥がす(この道が死んでも今まで緑だった)', () => {
    // 写真は packagingPhotos にだけ在る。tasks には1枚も無い。
    const cur = { id: 'x', packagingPhotos: { 全体: [img(400), img(400)], 銘板: img(300) } };
    const plan = planAutoOffload(cur, { status: 'completed' });
    assert.equal(plan.needed, true, '1MBの安全線を越えているのに手を出していない');
    assert.deepEqual(plan.pull, ['packagingPhotos'],
        '🚨 引き剥がす対象に packagingPhotos が入っていない＝荷姿写真が本体に残ったまま保存され、'
        + '1MB上限で保存が丸ごと失敗する(2026-07-26 の事故の形)');
    assert.equal(plan.images, 3, '荷姿写真を3枚とも数えていない');
    assert.ok(plan.freed > 1_000_000);
    assert.ok(plan.after < plan.before, '引き剥がした後の見込みが減っていない');
});

test('LC31 🚨写真の場所(path)の1段目で見分ける。tasks の写真を荷姿写真と取り違えない', () => {
    const onlyTasks = { id: 'y', tasks: { t1: { aiAnalysis: { imageUrl: img(700) } }, t2: { aiAnalysis: { imageUrl: img(700) } } } };
    const plan = planAutoOffload(onlyTasks, { status: 'completed' });
    assert.equal(plan.needed, true);
    assert.deepEqual(plan.pull, ['tasks'],
        '荷姿写真が1枚も無いのに packagingPhotos を引き剥がそうとしている');
    // 場所の1段目が本当に見分けの鍵になっているか(取り違えたら上の2件のどちらかが必ず落ちる)
    const imgs = inlineImagesOf({ packagingPhotos: { 全体: [img(30)] }, tasks: { t: { aiAnalysis: { imageUrl: img(30) } } } });
    assert.deepEqual(imgs.map(i => i.path[0]), ['packagingPhotos', 'tasks']);
});

test('LC32 🚨「ちょうど足りる」で止める。1枚多く落として画質を無駄に下げない', () => {
    // 大 100,000 バイト → 0.9→0.55 で predictRecompressed だけ減る。
    const big = 100_000;
    const freedByBig = big - predictRecompressed(big, 0.9, 0.55);
    assert.ok(freedByBig > 0);
    const images = [{ label: '大', bytes: big }, { label: '中', bytes: 60_000 }];
    // ちょうど「大」1枚ぶんだけ要る時は、中には手を出さない
    const r = planRecompress(images, { needBytes: freedByBig, quality: 0.55, assumeQuality: 0.9 });
    assert.equal(r.picks.length, 1,
        '🚨 ちょうど足りているのに2枚目まで落としている(freed >= need の境界が壊れている)');
    assert.equal(r.enough, true);
    // 1バイトでも足りなければ2枚目に手を出す
    const r2 = planRecompress(images, { needBytes: freedByBig + 1, quality: 0.55, assumeQuality: 0.9 });
    assert.equal(r2.picks.length, 2, '足りないのに2枚目へ進んでいない');
});

test('LC33 🚨同じ画質を指定した時は「減らない」と言う(減ったふりをしない)', () => {
    const b = 100_000;
    assert.equal(predictRecompressed(b, 0.55, 0.55), b,
        '🚨 同じ画質なのに小さくなると答えている(t >= f の境界が壊れている)');
    assert.equal(predictRecompressed(b, 0.9, 0.9), b);
    assert.ok(predictRecompressed(b, 0.9, 0.89) < b, '少しでも下げれば減る');
    // 同じ画質しか選べない写真は、落とす対象に選ばれない
    const r = planRecompress([{ label: 'a', bytes: 100_000 }], { needBytes: 10_000, quality: 0.9, assumeQuality: 0.9 });
    assert.equal(r.picks.length, 0, '減らないのに落とす対象へ入れている');
    assert.equal(r.enough, false, '減らないのに「足りた」と言っている');
});
