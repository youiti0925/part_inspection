// 🔎 動画の中を「言葉で探す」— いま在る文字だけで作る。
//
// ⚠⚠ この機能の前提は一度ひっくり返っている:
//   最初は「AIが聞き取った字幕から探す」で設計した。ところが本番の video_recipes を
//   数えたら **手本動画は製品5本・最終0本、字幕も章も1件も無い**。
//   清水さん「現場で本当にしゃべりながら仕事する事って本当に可能で、やってるの？」
//   → **喋る前提で作らない**。材料は「もう手で書いてある文字」を主にする。
//
// 探す材料(重い順):
//   急所 / 作業手順 / 急所の理由  … ⏸止め絵・🖼画像に手で書いた物(いちばん当たる)
//   章の名前                      … 工程の名前
//   字幕(caption) / テロップ(text) … 映像に焼き込む文字
//   吹き込んだ言葉(voice)          … あとから静かな所で喋った物
//   AIが聞き取った言葉(ai)         … ⚠必ず「AIが聞き取った」と分かる形で出す。根拠は映像。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxBytes } from '../lotCapacity.js';
import {
  WORD_KINDS, kindLabel, kindWeight, normJa, queryTokens,
  collectWords, searchWords, wordsMap, wordsFromMap,
  capWordsForDoc, WORDS_BUDGET, wordsBytes, sliceWordsMap, wordsFromRecipe,
} from '../videoWords.js';

const freeze = (id, at, extra = {}) => ({ id, type: 'freeze', srcId: 's1', atSec: at, durationSec: 3, marks: [], caption: '', ...extra });

const projectOf = (clips, overlays = [], notes = {}) => ({ clips, overlays, notes });
// timeline は videoProject.timelineOf の形(index と outStart だけ使う)
const tlOf = (clips) => {
  let at = 0;
  return clips.map((c, i) => {
    const d = c.type === 'video' ? (c.end - c.start) : c.durationSec;
    const row = { ...c, index: i, outStart: at, outEnd: at + d, outSec: d };
    at += d;
    return row;
  });
};

// ---------------------------------------------------------------------------
// 言葉のならし(日本語)
// ---------------------------------------------------------------------------
test('F01 ⚠カタカナで打ってもひらがなで打っても同じ物として当たる', () => {
  assert.equal(normJa('ノギス'), normJa('のぎす'));
  assert.equal(normJa('ﾉｷﾞｽ'), normJa('ノギス'));
});

test('F02 ⚠全角の英数・大文字小文字・空白の違いで外れない', () => {
  assert.equal(normJa('Ｍ８ボルト'), normJa('m8ボルト'));
  assert.equal(normJa(' トルク  レンチ '), normJa('トルクレンチ'));
});

test('F03 ⚠句読点やカッコを打っても外れない', () => {
  assert.equal(normJa('ノギスの、当て方。'), normJa('ノギスの当て方'));
  assert.equal(normJa('（急所）'), normJa('急所'));
});

test('F04 ⚠長音「ー」は消さない(コード と コーﾄﾞ を同じにしない)', () => {
  assert.notEqual(normJa('コード'), normJa('コド'));
});

test('F05 打った言葉を語に割る(全角の空白でも割れる)', () => {
  assert.deepEqual(queryTokens('ノギス　当て方'), [normJa('ノギス'), normJa('当て方')]);
  assert.deepEqual(queryTokens('   '), []);
  assert.deepEqual(queryTokens(null), []);
});

// ---------------------------------------------------------------------------
// 材料を集める
// ---------------------------------------------------------------------------
test('F06 ⏸止め絵の 作業手順・急所・急所の理由 が別々の1件になる', () => {
  const clips = [
    { id: 'c1', type: 'video', srcId: 's1', start: 0, end: 10 },
    freeze('c2', 4, { step: '銘板を貼る', point: '上端を筐体の線に合わせる', why: 'ずれると出荷検査で戻る' }),
  ];
  const p = projectOf(clips);
  const words = collectWords({ project: p, timeline: tlOf(clips) });
  const kinds = words.map(w => w.kind).sort();
  assert.deepEqual(kinds, ['point', 'step', 'why']);
  // ⚠出てくる秒は「出来上がりの中の秒」= その止め絵が始まる所
  assert.ok(words.every(w => w.atOut === 10));
});

test('F07 ⚠空欄は拾わない(空の行が並ぶと探す気が失せる)', () => {
  const clips = [freeze('c1', 0, { step: '  ', point: '', why: null })];
  assert.equal(collectWords({ project: projectOf(clips), timeline: tlOf(clips) }).length, 0);
});

test('F08 章の名前・字幕・テロップも材料になる', () => {
  const clips = [
    { id: 'c1', type: 'video', srcId: 's1', start: 0, end: 20 },
    freeze('c2', 5, { caption: 'ここでノギスを当てる' }),
  ];
  const overlays = [{ id: 'o1', kind: 'text', text: '2回測る', from: 3, to: 6 }, { id: 'o2', kind: 'mosaic', from: 1, to: 2 }];
  const words = collectWords({
    project: projectOf(clips, overlays),
    timeline: tlOf(clips),
    chapters: [{ name: '外観検査', atOut: 0 }, { name: '', atOut: 8 }],
  });
  const byKind = (k) => words.filter(w => w.kind === k);
  assert.deepEqual(byKind('caption').map(w => w.text), ['ここでノギスを当てる']);
  assert.deepEqual(byKind('text').map(w => w.text), ['2回測る']);
  assert.deepEqual(byKind('chapter').map(w => [w.text, w.atOut]), [['外観検査', 0]]);
  // ⚠目隠し(モザイク)には文字が無い。拾わない。
  assert.equal(words.some(w => w.ref === 'o2'), false);
});

test('F09 ⚠AIが聞き取った言葉は kind=ai で入る(出す時に「AIが聞き取った」と言えるように)', () => {
  const clips = [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 30 }];
  const words = collectWords({
    project: projectOf(clips), timeline: tlOf(clips),
    transcript: [{ at: 12.5, text: 'ここで一回止めます' }, { at: 3, text: '' }],
  });
  assert.deepEqual(words.filter(w => w.kind === 'ai').map(w => [w.text, w.atOut]), [['ここで一回止めます', 12.5]]);
  assert.equal(kindLabel('ai'), 'AIが聞き取った言葉');
});

test('F10 ⚠あとから吹き込んだ言葉は「鍵つきの入れ物」(map)から読む — 配列にしない', () => {
  const clips = [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 30 }];
  const notes = {
    n1: { at: 5, text: '面取りを忘れない', kind: 'voice', by: '山田' },
    n2: { at: 9, text: '', kind: 'voice' },
  };
  const words = collectWords({ project: projectOf(clips, [], notes), timeline: tlOf(clips) });
  assert.deepEqual(words.filter(w => w.kind === 'voice').map(w => [w.text, w.atOut, w.by]), [['面取りを忘れない', 5, '山田']]);
});

test('F11 ⚠idが重ならない(同じ文字が2か所にあっても別件として出る)', () => {
  const clips = [freeze('c1', 0, { step: '締める' }), freeze('c2', 0, { step: '締める' })];
  const words = collectWords({ project: projectOf(clips), timeline: tlOf(clips) });
  assert.equal(words.length, 2);
  assert.equal(new Set(words.map(w => w.id)).size, 2);
});

test('F12 ⚠壊れた入力でも落ちない', () => {
  assert.deepEqual(collectWords({}), []);
  assert.deepEqual(collectWords(null), []);
  assert.deepEqual(collectWords({ project: { clips: 'x', overlays: 3, notes: 7 }, chapters: 'y', transcript: 9 }), []);
});

// ---------------------------------------------------------------------------
// 探す
// ---------------------------------------------------------------------------
const sample = () => {
  const clips = [
    { id: 'c1', type: 'video', srcId: 's1', start: 0, end: 60 },
    freeze('c2', 30, { step: 'ノギスを当てる', point: 'ノギスは軸に対してまっすぐ当てる', why: '斜めだと0.2mm大きく出る' }),
  ];
  return collectWords({
    project: projectOf(clips, [{ id: 'o1', kind: 'text', text: '当て方に注意', from: 5, to: 8 }]),
    timeline: tlOf(clips),
    chapters: [{ name: '寸法測定', atOut: 0 }],
    transcript: [{ at: 20, text: 'ノギスの当て方はここです' }],
  });
};

test('F13 打った言葉で当てはまる要点が出る', () => {
  const hits = searchWords(sample(), 'ノギス');
  assert.ok(hits.length >= 3);
  assert.ok(hits.every(h => normJa(h.text).includes(normJa('ノギス'))));
});

test('F14 ⚠語をいくつ打っても全部入っている物だけ出る(AND)', () => {
  const hits = searchWords(sample(), 'ノギス 当て方');
  assert.deepEqual(hits.map(h => h.kind), ['ai']);
});

test('F15 ⚠急所が字幕やAIより先に出る(いちばん当たる物を上に)', () => {
  const hits = searchWords(sample(), '当て');
  assert.ok(hits.length >= 3);
  assert.equal(hits[0].kind === 'point' || hits[0].kind === 'step', true, `先頭=${hits[0].kind}`);
  assert.equal(hits[hits.length - 1].kind, 'ai', 'AIが聞き取った物は最後');
  assert.ok(kindWeight('point') > kindWeight('ai'));
});

test('F16 ⚠押した先の秒が必ず入っている(押しても飛べない結果を出さない)', () => {
  for (const h of searchWords(sample(), 'ノギス')) {
    assert.equal(Number.isFinite(h.atOut), true);
    assert.ok(h.atOut >= 0);
  }
});

test('F17 空の言葉では何も出さない(全件がだらっと出ない)', () => {
  assert.deepEqual(searchWords(sample(), ''), []);
  assert.deepEqual(searchWords(sample(), '   '), []);
  assert.deepEqual(searchWords(sample(), null), []);
});

test('F18 見つからない言葉では0件(嘘の結果を作らない)', () => {
  assert.deepEqual(searchWords(sample(), 'マイクロメータ'), []);
});

test('F19 出しすぎない(上限)', () => {
  const words = Array.from({ length: 500 }, (_, i) => ({ id: `w${i}`, kind: 'ai', text: 'ノギス', atOut: i }));
  assert.equal(searchWords(words, 'ノギス').length, 50);
  assert.equal(searchWords(words, 'ノギス', { limit: 5 }).length, 5);
});

test('F20 ⚠同じ秒・同じ文字が2回出ない(同じ物を2回押させない)', () => {
  const words = [
    { id: 'a', kind: 'ai', text: 'ノギスを当てる', atOut: 10 },
    { id: 'b', kind: 'ai', text: 'ノギスを当てる', atOut: 10.02 },
  ];
  assert.equal(searchWords(words, 'ノギス').length, 1);
});

test('F21 種類でしぼれる(AIが聞き取った物を外して見たい時)', () => {
  const hits = searchWords(sample(), 'ノギス', { kinds: ['step', 'point', 'why', 'chapter', 'caption', 'text', 'voice'] });
  assert.equal(hits.some(h => h.kind === 'ai'), false);
});

// ---------------------------------------------------------------------------
// 保存の形(多端末・1MB上限)
// ---------------------------------------------------------------------------
test('F22 ⚠⚠保存の形は「鍵つきの入れ物」(map)。配列にすると後勝ちで相手の分が消える', () => {
  const m = wordsMap(sample());
  assert.equal(Array.isArray(m), false);
  assert.equal(typeof m, 'object');
  for (const [k, v] of Object.entries(m)) {
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
    assert.deepEqual(Object.keys(v).sort(), ['at', 'kind', 'text'].filter(x => v[x] !== undefined).sort());
  }
});

test('F23 保存した物を読み戻せる(秒の順に並ぶ)', () => {
  const back = wordsFromMap(wordsMap(sample()));
  assert.ok(back.length > 0);
  const ats = back.map(w => w.atOut);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  assert.ok(back.every(w => typeof w.text === 'string' && w.text));
});

test('F24 ⚠壊れた保存でも読み戻しで落ちない', () => {
  assert.deepEqual(wordsFromMap(null), []);
  assert.deepEqual(wordsFromMap([1, 2]), []);
  assert.deepEqual(wordsFromMap({ a: null, b: { at: 'x', text: 'あ' }, c: { at: 3, text: '' } }), []);
});

test('F25 ⚠⚠文字数で数えて上限で切る(Firestoreは1ドキュメント1MB)', () => {
  const many = Array.from({ length: 4000 }, (_, i) => ({
    id: `w${i}`, kind: 'ai', text: `これは${i}番目のとても長い聞き取りの文章です。現場の音がうるさいので長くなります。`, atOut: i,
  }));
  const r = capWordsForDoc(many, { limitBytes: 20_000 });
  assert.ok(r.kept.length > 0, '1件も残らないのはおかしい');
  assert.ok(r.dropped.length > 0, '切れていない');
  assert.equal(r.kept.length + r.dropped.length, many.length);
  assert.ok(wordsBytes(r.kept) <= 20_000, `入りきっていない: ${wordsBytes(r.kept)}`);
  assert.equal(r.bytes, wordsBytes(r.kept));
});

test('F26 ⚠⚠切った時は「何件切ったか」を必ず言葉で出す(黙って切らない)', () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: `w${i}`, kind: 'ai', text: `聞き取り${i}`.padEnd(40, 'あ'), atOut: i }));
  const r = capWordsForDoc(many, { limitBytes: 5_000 });
  assert.ok(r.note, '一言が空');
  assert.ok(r.note.includes(String(r.dropped.length)), `件数が入っていない: ${r.note}`);
  assert.ok(/入りきら|切りました|保存しません/.test(r.note), `何が起きたか分からない: ${r.note}`);
  // 内訳(どの種類が切れたか)も言う
  assert.ok(r.note.includes(kindLabel('ai')), `内訳が無い: ${r.note}`);
});

test('F27 ⚠切る時は「当たりにくい物」から捨てる(手で書いた急所を先に捨てない)', () => {
  const words = [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, kind: 'ai', text: 'あ'.repeat(60), atOut: i })),
    { id: 'p1', kind: 'point', text: 'ここを外すと不良', atOut: 500 },
    { id: 's1', kind: 'step', text: '銘板を貼る', atOut: 501 },
  ];
  const r = capWordsForDoc(words, { limitBytes: 2_000 });
  assert.ok(r.kept.some(w => w.id === 'p1'), '急所が消えた');
  assert.ok(r.kept.some(w => w.id === 's1'), '作業手順が消えた');
  assert.ok(r.dropped.every(w => w.kind === 'ai'), '手で書いた物まで捨てている');
});

test('F28 全部入るなら1件も切らない・一言も出さない', () => {
  const r = capWordsForDoc(sample(), { limitBytes: WORDS_BUDGET });
  assert.equal(r.dropped.length, 0);
  assert.equal(r.note, '');
  assert.ok(r.bytes > 0);
});

test('F29 ⚠上限の既定値がFirestoreの1ドキュメント上限より十分小さい', () => {
  assert.ok(WORDS_BUDGET > 10_000);
  assert.ok(WORDS_BUDGET < 1_048_576 / 2, '1MBの半分未満にしないと他の中身が入らない');
});

// ⚠⚠ 2026-08-15 に直した。**元は「JSONの文字数」で数えていた**。
//   日本語は UTF-8 で1文字3バイトなので、実測で **2.27倍**（88文字=200バイト）。
//   文字数で数えていたせいで、危険線 900,000 は実際には **1,266KB** を意味しており、
//   Firestore の上限 1,024KB を **既に超えていた**（＝警告が鳴る前に保存が落ちる）。
//   この試験は「文字数で数えること」を固定していたので、**間違った振る舞いを守っていた**。
//   → 正しい方（本当のバイト数）を固定し直す。文字数に戻したらここで落ちる。
test('F30 ⚠⚠数え方は「本当のバイト数」。文字数で数えると日本語で2倍以上ズレる', () => {
  const w = [{ id: 'x', kind: 'ai', text: 'あい', atOut: 1 }];
  const json = JSON.stringify(wordsMap(w));
  assert.equal(wordsBytes(w), new TextEncoder().encode(json).length);
  assert.ok(wordsBytes(w) > json.length, `⚠文字数のまま(${json.length})になっている`);
  // lotCapacity と同じ数え方であること(2か所でズレると、片方だけ間に合わない)
  assert.equal(wordsBytes(w), approxBytes(wordsMap(w)));
});

test('F31 種類は8つ。名前は日本語で、AI由来だけは必ずそう分かる名前', () => {
  assert.equal(WORD_KINDS.length, 8);
  assert.ok(WORD_KINDS.every(k => k.label && /[ぁ-んァ-ヶ一-龥]/.test(k.label)));
  assert.ok(kindLabel('ai').includes('AI'));
  assert.equal(kindLabel('nope'), 'その他');
});

// ---------------------------------------------------------------------------
// 章で切り出した時の秒 / 既にある手本レシピから索引を作る
// ---------------------------------------------------------------------------
test('F32 ⚠⚠章で切り出したら、区間の始まりを引いた秒になる(引かないと違う場面へ飛ぶ)', () => {
  const map = { 'point:a': { kind: 'point', text: 'ノギスの当て方', at: 12.5 } };
  const cut = sliceWordsMap(map, 10, 20);
  assert.equal(cut['point:a'].at, 2.5);
  assert.equal(cut['point:a'].text, 'ノギスの当て方');
  assert.equal(cut['point:a'].kind, 'point');
});

test('F33 ⚠区間の外の言葉は入れない(その動画に写っていない場面を指す索引を作らない)', () => {
  const map = {
    a: { kind: 'point', text: 'まえ', at: 5 },
    b: { kind: 'point', text: 'なか', at: 15 },
    c: { kind: 'point', text: 'あと', at: 25 },
  };
  const cut = sliceWordsMap(map, 10, 20);
  assert.deepEqual(Object.keys(cut), ['b']);
});

test('F34 区間の頭ぴったりの言葉は残る(0秒になる)・終わりぴったりは次の区間の物', () => {
  const map = { a: { kind: 'point', text: 'あたま', at: 10 }, b: { kind: 'point', text: 'おわり', at: 20 } };
  const cut = sliceWordsMap(map, 10, 20);
  assert.equal(cut.a.at, 0);
  assert.equal(cut.b, undefined);
  assert.equal(sliceWordsMap(map, 20, 30).b.at, 0);
});

test('F35 切り出しても保存の形は変わらない(kind/text/at の3つだけ)', () => {
  const cut = sliceWordsMap({ a: { kind: 'point', text: 'あ', at: 12, by: '山田' } }, 10, 20);
  assert.deepEqual(Object.keys(cut.a).sort(), ['at', 'kind', 'text']);
});

test('F36 ⚠⚠既にある手本レシピの ⏸要点・📍頭出し から索引が作れる(0件のままにしない)', () => {
  const w = wordsFromRecipe({
    events: [
      { id: 'e1', type: 'pause', start: 8, label: 'ノギスの当て方', text: '斜めに当てると0.1大きく出る' },
      { id: 'e2', type: 'skip', start: 20, end: 30 },
      { id: 'e3', type: 'speed', start: 40, end: 50, speed: 2 },
    ],
    chapters: [{ id: 'c1', stepKey: '外観__銘板', label: '銘板の確認', start: 60 }],
  });
  assert.deepEqual(w.map(x => [x.kind, x.text, x.atOut]), [
    ['point', 'ノギスの当て方', 8],
    ['why', '斜めに当てると0.1大きく出る', 8],
    ['chapter', '銘板の確認', 60],
  ]);
  // 打った言葉で実際に当たること(ひらがなで打っても当たる)
  assert.equal(searchWords(w, 'のぎす').length, 1);
});

test('F37 ⚠文字の無い要点は拾わない・スキップと倍速は拾わない', () => {
  const w = wordsFromRecipe({
    events: [{ id: 'e1', type: 'pause', start: 3, label: '', text: '' }, { id: 'e2', type: 'skip', start: 5, end: 9 }],
    chapters: [{ id: 'c1', label: '', start: 1 }],
  });
  assert.equal(w.length, 0);
});

test('F38 ⚠レシピ由来の id は保存済みの索引とぶつからない(足しても二重に出ない)', () => {
  const saved = wordsFromMap({ 'point:c1': { kind: 'point', text: '締め付け', at: 5 } });
  const live = wordsFromRecipe({ events: [{ id: 'c1', type: 'pause', start: 5, label: '締め付け' }] });
  assert.notEqual(saved[0].id, live[0].id);
  // 同じ文字が同じ秒にある時は、探した結果では1件にまとまる(同じ物を2回押させない)
  assert.equal(searchWords([...saved, ...live], '締め付け').length, 1);
});

test('F39 中身が無い物を渡しても落ちない(空の入れ物を返す)', () => {
  assert.deepEqual(sliceWordsMap(null, 0, 10), {});
  assert.deepEqual(sliceWordsMap(undefined, 0, 10), {});
  assert.deepEqual(wordsFromRecipe(null), []);
  assert.deepEqual(wordsFromRecipe({}), []);
});
