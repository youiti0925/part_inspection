import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRunningLotTasks, guardLotTaskStart, stepForTask } from '../lotStartGuard.js';
const manual = { id: 'prepare', title: '段取り', executionMode: 'manual' };
const auto = { id: 'auto', title: '測定', executionMode: 'auto' };
const lot = (id, tasks = {}, rest = {}) => ({ id, orderNo: id, workerId: 'w1', steps: [manual, auto], tasks, ...rest });
const currentLot = lot('B');
const run = { status: 'processing', startTime: 10 };
const check = (lots, more = {}) => guardLotTaskStart({ lots, currentLot, workerId: 'w1', targetStep: manual, ...more });

test('同じ工程キーの別ロットを自分自身と誤って除外しない', () => {
  const r = check([lot('A', { 'prepare-0': run })], { excludeKey: 'prepare-0' });
  assert.equal(r.ok, false); assert.equal(r.conflict.lotId, 'A'); assert.match(r.message, /A.*段取り/);
});
test('自動だけ動いているAからBの手作業を始められる', () => {
  assert.equal(check([lot('A', { 'auto-0': run })]).ok, true);
});
test('別担当の手作業は自分の開始を妨げない', () => {
  assert.equal(check([lot('A', { 'prepare-0': run }, { workerId: 'w2' })]).ok, true);
});
test('古い購読の自ロットをローカル状態で置き換える', () => {
  assert.equal(check([lot('B', { 'prepare-0': run })]).ok, true);
});
test('ローカルで直前に始めた工程は購読前でもブロックする', () => {
  assert.equal(check([], { currentLot: lot('B', { 'prepare-0': run }) }).ok, false);
});
test('自ロットの同一キーだけ除外できる', () => {
  assert.equal(check([], { currentLot: lot('B', { 'prepare-0': run }), excludeKey: 'prepare-0' }).ok, true);
});
for (const state of [
  { status: 'ng' }, { status: 'paused' }, { status: 'completed' },
  { status: 'reworking', reworkStartTime: null, reworkPausedAt: 20 },
]) test(`${JSON.stringify(state)}は進行中の手作業にしない`, () => {
  assert.equal(check([lot('A', { 'prepare-0': state })]).ok, true);
});
test('順序実行のロット時計も他ロットから検出する', () => {
  const seq = lot('A', {}, { executionType: 'sequential', status: 'processing', workStartTime: 1, currentStepIndex: 0 });
  assert.equal(check([seq]).ok, false);
  assert.equal(check([{ ...seq, currentStepIndex: 1 }]).ok, true);
  assert.equal(check([{ ...seq, status: 'paused' }]).ok, true);
});
test('工程が引けない進行中の記録(工程を後から消した等)は 手作業と決めつけて止めない(Claude 2026-09-26: 前は全端末を止めていた)', () => {
  assert.equal(check([lot('A', { 'missing-0': run })]).ok, true);
});

test('完了ロットの残った processing は見ない', () => {
  assert.equal(check([lot('A', { 'prepare-0': run }, { status: 'completed' })]).ok, true);
});

test('自動工程の修正(再測定)は機械が回っているだけ=手作業を止めない。手作業の修正は止める', () => {
  assert.equal(check([lot('A', { 'auto-0': { status: 'reworking', reworkStartTime: 10 } })]).ok, true);
  assert.equal(check([lot('A', { 'prepare-0': { status: 'reworking', reworkStartTime: 10 } })]).ok, false);
});
test('ロット1回、旧数値、ハイフン付きIDを解決する', () => {
  assert.equal(stepForTask([manual], 'prepare-lot-0'), manual);
  assert.equal(stepForTask([manual], '0-0'), manual);
  const st = { id: 'part-set' }; assert.equal(stepForTask([st], 'part-set-3'), st);
});
test('作業者の記録が無い端末(管理者・フリー)は 開いているロットの中だけ見る(前の作りどおり。止めない)', () => {
  assert.equal(check([lot('A', { 'prepare-0': run })], { workerId: null }).ok, true, '別ロットは見ない');
  assert.equal(check([], { workerId: null, currentLot: lot('B', { 'prepare-0': run }) }).ok, false, '同じロットの手作業2つ目は止める');
});
test('別ロットの担当不明の手作業は 名前から担当を引く。引けなければ止めない(前は全端末の全員を止めた: 写しで108セッション/14ロット)', () => {
  const named = { ...run, workerName: '甲' };
  assert.equal(check([lot('A', { 'prepare-0': named }, { workerId: null })], { workers: [{ id: 'w1', name: '甲' }] }).ok, false, '名前が自分なら止める');
  assert.equal(check([lot('A', { 'prepare-0': named }, { workerId: null })], { workers: [{ id: 'w2', name: '甲' }] }).ok, true, '名前が他人なら止めない');
  assert.equal(check([lot('A', { 'prepare-0': run }, { workerId: null })]).ok, true, '誰のか分からなければ止めない');
});
test('開始済みセッションの担当を使用し、旧完了者名は参照しない', () => {
  const task = { ...run, workerName: '旧担当', sessions: [{ startTime: 10, workerId: 'w1', endTime: null }] };
  assert.equal(check([lot('A', { 'prepare-0': task }, { workerId: 'w2' })]).ok, false);
});
test('自ロットは担当変更直後のworkerIdを採用する', () => {
  const task = { ...run, sessions: [{ startTime: 10, workerId: 'old' }] };
  const rows = collectRunningLotTasks({ lots: [], currentLot: lot('B', { 'prepare-0': task }), workerId: 'new' });
  assert.equal(rows[0].workerId, 'new');
});
test('旧工程マスタのmanual指定を全ロット判定でも守る', () => {
  const steps = [{ id: 'old', title: '自動測定開始' }];
  assert.equal(check([lot('A', { 'old-0': run }, { steps })], { masterIndex: new Map([['_自動測定開始', 'manual']]) }).ok, false);
});
test('入力ロットやタスクを変更しない', () => {
  const input = [lot('A', { 'prepare-0': run })], before = structuredClone(input);
  check(input); assert.deepEqual(input, before);
});
