import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_DELETE, DATA_SERVER_NOW, isSentinel, sentinelKind, materialize, hasSentinel,
  splitDeletions, applyDeletePaths, withDeletions, cleanUndefined, DELETE_KEYS,
} from '../sentinels.js';

const CONV = { delete: () => '<<del>>', serverNow: () => '<<now>>' };

test('S01 印は「ただのオブジェクト」= JSON にしても中身が残る', () => {
  // ⚠Firestore の deleteField() は JSON にすると意味が消える。
  //   送信待ちの保存を端末に貯める(M2)には、JSON で往復できないと使えない。
  const back = JSON.parse(JSON.stringify({ a: DATA_DELETE, b: DATA_SERVER_NOW }));
  assert.equal(sentinelKind(back.a), 'delete');
  assert.equal(sentinelKind(back.b), 'serverNow');
});

test('S02 印は structuredClone を通る(IndexedDB に入れられる)', () => {
  // ⚠Firestore の FieldValue はここで DataCloneError になる。これがオフライン再送の壁。
  const c = structuredClone({ x: { y: DATA_DELETE } });
  assert.equal(sentinelKind(c.x.y), 'delete');
});

test('S03 印かどうかの判定', () => {
  assert.equal(isSentinel(DATA_DELETE), true);
  assert.equal(isSentinel(DATA_SERVER_NOW), true);
  assert.equal(isSentinel({}), false);
  assert.equal(isSentinel(null), false);
  assert.equal(isSentinel('delete'), false);
  assert.equal(isSentinel([DATA_DELETE]), false);
  assert.equal(sentinelKind({}), null);
});

test('S04 materialize は入れ子の印だけを差し替える', () => {
  const out = materialize({ a: 1, t: DATA_SERVER_NOW, deep: { d: DATA_DELETE, keep: [1, 2] } }, CONV);
  assert.deepEqual(out, { a: 1, t: '<<now>>', deep: { d: '<<del>>', keep: [1, 2] } });
});

test('S05 materialize は元のオブジェクトを書き換えない', () => {
  const src = { deep: { d: DATA_DELETE } };
  materialize(src, CONV);
  assert.equal(sentinelKind(src.deep.d), 'delete');
});

test('S06 配列の中に印を置いたら、その場で落とす(黙って壊れたデータを保存しない)', () => {
  // Firestore は配列要素の deleteField() を許さない。素通しすると
  // {__dataSentinel:'delete'} という「ただのオブジェクト」が保存され、誰も気づかない。
  assert.throws(() => materialize({ arr: [DATA_DELETE, 1] }, CONV), /配列の中に印は置けません/);
  assert.throws(() => materialize({ a: { b: [1, DATA_SERVER_NOW] } }, CONV), /1番目/);
});

test('S07 変換方法が渡されていなければ、黙って通さず落ちる', () => {
  assert.throws(() => materialize({ a: DATA_DELETE }, { serverNow: () => 1 }), /delete/);
});

test('S08 hasSentinel は入れ子も配列も見る', () => {
  assert.equal(hasSentinel({ a: { b: [{ c: DATA_DELETE }] } }), true);
  assert.equal(hasSentinel({ a: 1 }), false);
});

// ----------------------------------------------------------------------------
// 消したキーの受け渡し
// ----------------------------------------------------------------------------

test('S09 splitDeletions: 直下のキー(形①)', () => {
  const { body, deletePaths } = splitDeletions({ tasks: { k: 1 }, [DELETE_KEYS]: { tasks: ['s_a-0', 's_a-1'] } });
  assert.deepEqual(body, { tasks: { k: 1 } });
  assert.deepEqual(deletePaths, [['tasks', 's_a-0'], ['tasks', 's_a-1']]);
});

test('S10 splitDeletions: 深い場所(形②)', () => {
  const { body, deletePaths } = splitDeletions({ [DELETE_KEYS]: [['workerRoster', '2026-07-27', '田中']] });
  assert.deepEqual(body, {});
  assert.deepEqual(deletePaths, [['workerRoster', '2026-07-27', '田中']]);
});

test('S11 印が無ければ、そのまま返す(余計な複製をしない)', () => {
  const raw = { a: 1 };
  assert.equal(splitDeletions(raw).body, raw);
  assert.equal(withDeletions(raw), raw);
});

test('S12 applyDeletePaths: 途中の入れ物を作りながら印を置く', () => {
  const out = applyDeletePaths({ keep: 1 }, [['a', 'b', 'c']]);
  assert.deepEqual(out.keep, 1);
  assert.equal(sentinelKind(out.a.b.c), 'delete');
});

test('S13 applyDeletePaths: 元のオブジェクトを書き換えない', () => {
  const src = { a: { b: { x: 1 } } };
  const out = applyDeletePaths(src, [['a', 'b', 'y']]);
  assert.equal(src.a.b.y, undefined);
  assert.equal(sentinelKind(out.a.b.y), 'delete');
  assert.equal(out.a.b.x, 1, '同じ階層の他のキーが消えている');
});

test('S14 パスは配列で扱う(型式名にドットが入っても壊れない)', () => {
  // ⚠ドット区切りにすると「MB-200.5」が2階層に化ける。過去に実際にやっている。
  const out = applyDeletePaths({}, [['models', 'MB-200.5']]);
  assert.equal(sentinelKind(out.models['MB-200.5']), 'delete');
  assert.equal(out.models.MB, undefined);
});

test('S15 withDeletions: 入口で1回通せば本体＋印になる', () => {
  const out = withDeletions({ tasks: { keep: 1 }, [DELETE_KEYS]: { tasks: ['gone'] } });
  assert.equal(out[DELETE_KEYS], undefined, '印の入れ物が残っている');
  assert.equal(out.tasks.keep, 1);
  assert.equal(sentinelKind(out.tasks.gone), 'delete');
});

test('S16 壊れた指定は黙って捨てる(空パス・非配列)', () => {
  assert.deepEqual(splitDeletions({ [DELETE_KEYS]: [[], null, ['ok']] }).deletePaths, [['ok']]);
  assert.deepEqual(splitDeletions({ [DELETE_KEYS]: { a: 'notArray' } }).deletePaths, []);
});

// ----------------------------------------------------------------------------
// undefined の掃除
// ----------------------------------------------------------------------------

test('S17 cleanUndefined は印を壊さない', () => {
  // ⚠印は「凍結した素のオブジェクト」なので再帰の対象になるが、
  //   中身(__dataSentinel)ごとコピーされるので意味は残る。
  const out = cleanUndefined({ a: DATA_DELETE, b: undefined, c: DATA_SERVER_NOW });
  assert.equal(sentinelKind(out.a), 'delete');
  assert.equal(sentinelKind(out.c), 'serverNow');
  assert.equal('b' in out, false);
});

test('S18 cleanUndefined を通した後でも materialize できる', () => {
  const out = materialize(cleanUndefined({ t: DATA_SERVER_NOW }), CONV);
  assert.deepEqual(out, { t: '<<now>>' });
});

test('S19 undefined は null に、配列の中も見る', () => {
  assert.deepEqual(cleanUndefined({ a: [1, undefined, { b: undefined, c: 2 }] }), { a: [1, null, { c: 2 }] });
});
