// 🧭 2026-09-23 清水さん「1,2,3でやって」: 今日決めること(3つ)＋遅れる・止まるロットの理由の表。
//   数は todayDecisionsOf ただ1本。1件のロットは理由1つにだけ入る(足すと合計)。製品・最終で同じ中身(md5 の対)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { todayDecisionsOf, decisionKindOf, DECISION_KINDS } from '../todayDecisions.js';
import { UNRESOLVED_REASON, UNJUDGEABLE } from '../../domain/operationsSimulation/simulate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.resolve(HERE, '..', f), 'utf8').replace(/\r\n/g, '\n');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const rows = [
  { lotId: 'A', late: true, alreadyPastDue: false },                       // 時間が足りない
  { lotId: 'B', late: true, alreadyPastDue: false },                       // 仮の入荷日のまま遅れる
  { lotId: 'C', late: true, alreadyPastDue: true },                        // もう過ぎている
  { lotId: 'D', finishMs: null, blocked: UNRESOLVED_REASON.NO_CANDIDATE, late: true },
  { lotId: 'E', finishMs: null, blocked: UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL, late: true },
  { lotId: 'F', finishMs: null, blocked: UNRESOLVED_REASON.TOO_LONG, late: true },
  { lotId: 'G', late: false, judgeable: false, unknownReason: UNJUDGEABLE.NO_DUE },
  { lotId: 'H', late: false },                                             // 困っていない
  { lotId: 'I', late: true },                                              // 納期の更新が必要(下の一覧)
];

test('TD-1 1件は理由1つだけ・足すと合計・困っていないロットは入らない', () => {
  const m = todayDecisionsOf({ lotResults: rows, conflictLotIds: ['I', 'Z'], assumedLotIds: ['B'] });
  const all = m.rows.flatMap((r) => r.lotIds);
  assert.equal(new Set(all).size, all.length, '同じロットが2つの理由に入っている');
  assert.equal(m.total, all.length);
  assert.ok(!all.includes('H'), '困っていないロットが入っている');
  const by = Object.fromEntries(m.rows.map((r) => [r.key, r.lotIds]));
  assert.deepEqual(by.conflict, ['I', 'Z'], '納期の更新が必要は 帯の札と同じ一覧(期間の外 Z も)をそのまま数える');
  assert.deepEqual(by.time, ['A', 'F'], '遅れる＋働ける時間に収まらない は「人か時間が足りない」');
  assert.deepEqual(by.arrival, ['B']);
  assert.deepEqual(by.past, ['C']);
  assert.deepEqual(by.skill, ['D']);
  assert.deepEqual(by.support, ['E']);
  assert.deepEqual(by.noDue, ['G']);
});

test('TD-2 多い順・同数は決まった順。上から3つが 今日決めること', () => {
  const m = todayDecisionsOf({ lotResults: rows, conflictLotIds: ['I', 'Z'], assumedLotIds: ['B'] });
  for (let i = 1; i < m.rows.length; i += 1) assert.ok(m.rows[i - 1].n >= m.rows[i].n, '多い順になっていない');
  assert.deepEqual(m.top.map((r) => r.key), ['conflict', 'time', 'past']);
  assert.equal(m.max, 2);
  assert.deepEqual(todayDecisionsOf({}).rows, [], '材料が無い時は 0件(札を出さない)');
});

test('TD-3 手が付かない理由は エンジンの定数から読む(文言で比べない)。全部の理由に行き先が在る', () => {
  const keys = new Set(DECISION_KINDS.map((k) => k.key));
  for (const reason of Object.values(UNRESOLVED_REASON)) {
    const k = decisionKindOf({ lotId: 'x', blocked: reason }, {});
    assert.ok(keys.has(k) && k !== null, `理由「${reason}」の行き先が無い`);
  }
  assert.equal(decisionKindOf({ lotId: 'x', blocked: '知らない理由' }, {}), 'other', '知らない理由を黙って捨てない');
});

test('TD-4 画面: 閉じている時は札3枚だけ・押す物は44px・「外した後の計算ではない」と言う・hooks はガードより上', () => {
  const ui = read('TodayDecisions.jsx');
  const iHook = ui.indexOf('React.useState(false)');
  const iGuard = ui.indexOf('if (!rows.length) return null;');
  assert.ok(iHook > 0 && iGuard > iHook, 'hooks がガードより後ろ');
  assert.equal((ui.match(/<button/g) || []).length, (ui.match(/min-h-11/g) || []).length, '押す物が 44px でない');
  assert.ok(ui.includes('外した後の計算ではありません'), '件数が「外したら進む数」だと読める');
  assert.ok(!/\d+px/.test(ui) && !/text-\[\d/.test(ui), 'px の直書き・12px 未満の文字');
  for (const w of ['できない', '不可', '未経験', 'スコア', '予定表']) assert.ok(!ui.includes(w) && !read('todayDecisions.js').includes(w), `使わない言葉「${w}」`);
});

test('TD-5 製品・最終で同じ中身(md5 の対。片方だけ直さない)', () => {
  assert.equal(md5(read('todayDecisions.js')), 'bb6fff495ced0ae84451346263304688', 'todayDecisions.js が対の片方だけ変わった(もう片方も同じに直し、この値を理由付きで直す)');
  assert.equal(md5(read('TodayDecisions.jsx')), '203cc1ebcf17e5c3d5ec2d6f2d6f7898', 'TodayDecisions.jsx が対の片方だけ変わった');
});
