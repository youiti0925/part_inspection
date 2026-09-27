// 📋 編集メモ と ▶要点だけ見るモード — 試験
// ⚠⚠ ここが崩れると「作ったのに、どこにあるか分からない」に戻る(2026-08-15 清水さん)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editHistory, atLabel, markLabel, noNameCount,
  keyMoments, nextMoment, speedAt, normSkipSpeed, SKIP_SPEEDS,
  momentIndexAt, crossedMoment,
} from '../editHistory.js';

const proj = () => ({
  clips: [
    { id: 'c1', type: 'video', srcId: 's1', start: 0, end: 4, speed: 1 },
    {
      id: 'c2', type: 'freeze', srcId: 's1', atSec: 4, durationSec: 3,
      step: 'ねじを締める', point: '対角に締める', why: '片締めで歪む',
      marks: [{ shape: 'ellipse', text: 'ここ', x: 0.5, y: 0.5 }, { shape: 'arrow2', text: '', x: 0.1, y: 0.1, x2: 0.4, y2: 0.4 }],
    },
    { id: 'c3', type: 'video', srcId: 's1', start: 4, end: 10, speed: 1 },
    { id: 'c4', type: 'image', imageId: 'i1', durationSec: 5, step: '', point: '', caption: '' },
  ],
  overlays: [
    { id: 'o1', kind: 'text', from: 2, to: 5, text: '注意' },
    { id: 'o2', kind: 'mosaic', from: 8, to: 9 },
    { id: 'o3', kind: 'mark', from: 1, to: 3, mark: { shape: 'rect', text: '型式' } },
  ],
});
const chaps = () => [{ name: '組立', atOut: 0 }, { name: '', atOut: 7 }];

test('EH1 分:秒で出す(現場は秒を数えない)', () => {
  assert.equal(atLabel(0), '0:00');
  assert.equal(atLabel(3), '0:03');
  assert.equal(atLabel(65), '1:05');
  assert.equal(atLabel(3725), '1:02:05');
  assert.equal(atLabel(-5), '0:00');
  assert.equal(atLabel(NaN), '0:00');
});

test('EH2 印の形を現場の言葉で(横文字を出さない)', () => {
  assert.equal(markLabel({ shape: 'ellipse' }), '⭕ 丸');
  assert.equal(markLabel({ shape: 'arrow2' }), '➡ 矢印');
  assert.equal(markLabel({ shape: 'arrow' }), '➡ 矢印');
  assert.equal(markLabel({ shape: 'rect' }), '⬜ 四角');
  assert.equal(markLabel(null), '⭕ 丸');
});

test('EH3 ⚠⚠作った物が1つも欠けずに並ぶ', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  // ⏸1 + その印2 + 🖼1 + 重ね3 + 章2 = 9件（動画の区間は「作った物」ではないので出さない）
  assert.equal(rows.length, 9, rows.map(r => r.key).join(','));
  const keys = rows.map(r => r.key);
  for (const k of ['clip:c2', 'mark:c2:0', 'mark:c2:1', 'clip:c4', 'ov:o1', 'ov:o2', 'ov:o3', 'ch:0', 'ch:1']) {
    assert.ok(keys.includes(k), `${k} が並びに無い`);
  }
});

test('EH4 ⚠時刻順に並ぶ。同じ秒なら 止め絵→その印→重ね→章 の順', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].at >= rows[i - 1].at, `${rows[i - 1].atText} の後に ${rows[i].atText} が来ている`);
  }
  const i2 = rows.findIndex(r => r.key === 'clip:c2');
  assert.equal(rows[i2 + 1].key, 'mark:c2:0', '止め絵の次はその印');
  assert.equal(rows[i2 + 2].key, 'mark:c2:1');
});

test('EH5 ⚠⚠「何秒に〇」「何秒に→」が分かる', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  const maru = rows.find(r => r.key === 'mark:c2:0');
  const ya = rows.find(r => r.key === 'mark:c2:1');
  assert.equal(maru.atText, '0:04'); assert.equal(maru.title, '⭕ 丸'); assert.equal(maru.sub, 'ここ');
  assert.equal(ya.atText, '0:04'); assert.equal(ya.title, '➡ 矢印');
  const shikaku = rows.find(r => r.key === 'ov:o3');
  assert.equal(shikaku.atText, '0:01'); assert.equal(shikaku.title, '⬜ 四角');
});

test('EH6 ⚠名前の無い物は「（名前なし）」で必ず見える（空欄は探せない・作業標準に載らない）', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  assert.equal(rows.find(r => r.key === 'clip:c4').title, '（名前なし）');
  assert.equal(rows.find(r => r.key === 'clip:c4').noName, true);
  assert.equal(rows.find(r => r.key === 'ch:1').title, '（名前なし）');
  assert.equal(rows.find(r => r.key === 'mark:c2:1').sub, '（ひと言なし）');
  assert.equal(rows.find(r => r.key === 'clip:c2').noName, false, '名前がある物は印を付けない');
  // 名前なし: c4 / ch:1 / mark:c2:1 = 3件
  assert.equal(noNameCount(rows), 3);
});

test('EH7 消す/選ぶ為の身元が全部の行に付いている', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  for (const r of rows) {
    assert.ok(r.ref && r.ref.type, `${r.key} に ref が無い`);
    if (r.ref.type === 'mark') assert.ok(r.ref.clipId && Number.isInteger(r.ref.markIndex));
    if (r.ref.type === 'clip' || r.ref.type === 'overlay') assert.ok(r.ref.id);
    if (r.ref.type === 'chapter') assert.ok(Number.isInteger(r.ref.index));
  }
});

test('EH8 空でも落ちない', () => {
  assert.deepEqual(editHistory(null), []);
  assert.deepEqual(editHistory({}), []);
  assert.deepEqual(editHistory({ project: { clips: [], overlays: [] }, chapters: [] }), []);
  assert.equal(noNameCount(null), 0);
});

// ---- ▶ 要点だけ見るモード ----

test('EH9 止まる所は ⏸止め絵 / 🖼画像 / 📍章 だけ（流したままの印や文字では止めない）', () => {
  const rows = editHistory({ project: proj(), chapters: chaps() });
  const ms = keyMoments(rows);
  assert.deepEqual(ms.map(m => m.ref.type), ['chapter', 'clip', 'chapter', 'clip']);
  // 0秒=章／4秒=止め絵／7秒=章／13秒=挟んだ画像(動画4秒+止め絵3秒+動画6秒 の後)
  assert.deepEqual(ms.map(m => m.at), [0, 4, 7, 13]);
  assert.ok(!ms.some(m => m.ref.type === 'overlay'), '重ねで止めてはいけない');
});

test('EH10 ⚠いま止まっている所ちょうどでは止め直さない（押しても進まなくなる）', () => {
  const ms = keyMoments(editHistory({ project: proj(), chapters: chaps() }));
  assert.equal(nextMoment(ms, 0).at, 4, '0秒で止まっている → 次は4秒');
  assert.equal(nextMoment(ms, 4).at, 7);
  assert.equal(nextMoment(ms, 4.01).at, 7);
  assert.equal(nextMoment(ms, 7).at, 13);
  assert.equal(nextMoment(ms, 13), null, '最後の後は無い');
  assert.equal(nextMoment([], 0), null);
});

test('EH11 選べる速さ。⚠等速(1)も残す', () => {
  assert.ok(SKIP_SPEEDS.includes(1), '「速くしたくない」人が必ずいる');
  assert.equal(normSkipSpeed(2), 2);
  assert.equal(normSkipSpeed(2.4), 2);
  assert.equal(normSkipSpeed(100), 4);
  assert.equal(normSkipSpeed(0), 1);
  assert.equal(normSkipSpeed('へんな値'), 2);
});

test('EH12 ⚠止まる所の手前は等速に戻す（飛ばしたまま突入すると何が起きたか分からない）', () => {
  const ms = keyMoments(editHistory({ project: proj(), chapters: chaps() }));
  assert.equal(speedAt(ms, 0.5, 3), 3, '次(4秒)まで遠い → 早送り');
  assert.equal(speedAt(ms, 3.0, 3), 1, '次(4秒)まで1.0秒 → 等速に戻す');
  assert.equal(speedAt(ms, 2.4, 3), 3, '次まで1.6秒 → まだ手前でないので早送りのまま');
  assert.equal(speedAt(ms, 7.5, 3), 3, '次(13秒)まで遠い → 早送り');
  assert.equal(speedAt(ms, 12.0, 3), 1, '次(13秒)まで1.0秒 → 等速に戻す');
  assert.equal(speedAt(ms, 13.5, 3), 3, '最後の後はずっと早送り');
});

test('EH13 いま何番目の要点か（画面の「要点 3 / 7」）', () => {
  const ms = keyMoments(editHistory({ project: proj(), chapters: chaps() }));   // 0,4,7,13秒
  assert.equal(momentIndexAt(ms, -1), -1, 'まだ最初の要点より前');
  assert.equal(momentIndexAt(ms, 0), 0);
  assert.equal(momentIndexAt(ms, 3.9), 0);
  assert.equal(momentIndexAt(ms, 4), 1);
  assert.equal(momentIndexAt(ms, 12.9), 2);
  assert.equal(momentIndexAt(ms, 13), 3);
  assert.equal(momentIndexAt(ms, 99), 3, '最後まで行っても最後の要点のまま');
  assert.equal(momentIndexAt([], 5), -1);
  assert.equal(momentIndexAt(null, 5), -1);
});

test('EH14 ⚠⚠ 跨いだ要点で止める。押した瞬間にまた同じ所で止まらない（＝続きに進める）', () => {
  const ms = keyMoments(editHistory({ project: proj(), chapters: chaps() }));   // 0,4,7,13秒
  // 1コマ(1/30秒)進んだだけ → 何も跨いでいない
  assert.equal(crossedMoment(ms, 1.0, 1.033), null);
  // 4秒の要点を跨いだ → 4秒で止める(通り過ぎた位置ではなく **要点ぴったり**)
  assert.equal(crossedMoment(ms, 3.98, 4.02).at, 4);
  // ⚠⚠ 1コマ前が要点の 0.02秒手前でも **素通りしない**(ここを取りこぼすと止まらない)
  assert.equal(crossedMoment(ms, 3.99, 4.001).at, 4);
  // ⚠⚠ ここが「押したら続く」の要。4秒で止まっている所から進めても、また4秒で止めない
  assert.equal(crossedMoment(ms, 4, 4.03), null, '止まった所で止め直したら永久に進めない');
  // ⚠<video>の時刻はわずかに戻る事がある。さっき止まった所(4秒)なら、戻っても止め直さない
  assert.equal(crossedMoment(ms, 3.999, 4.03, 4), null);
  assert.equal(crossedMoment(ms, 3.999, 4.03, null).at, 4, 'さっき止まった所でなければ止める');
  assert.equal(crossedMoment(ms, 4, 7.01).at, 7, '次の要点までは進める');
  // 1コマで2つ跨いだ時は **手前の1つ**(残りは次の▶で順に出す)
  assert.equal(crossedMoment(ms, 3.9, 20).at, 4);
  assert.equal(crossedMoment(ms, 13, 99), null, '最後の要点の後は止まらない(最後まで流す)');
  assert.equal(crossedMoment([], 0, 99), null);
  assert.equal(crossedMoment(null, 0, 99), null);
});
