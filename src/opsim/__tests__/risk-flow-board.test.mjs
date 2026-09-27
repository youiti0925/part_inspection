// 🧭 2026-09-23 遅れの見取り図(RiskFlowBoard)の見張り。ChatGPT/Codex の枝 codex/opsim-visual-monthly-20260902 を合流。
//   ① px を書かない(rem／Tailwind の段だけ) ② 押せる物は min-h-11 ③ 禁じ語なし ④ 製品・最終で同じ中身(md5 の対)
//   ⑤ 画面に本当に載っている（最終=opsimfi/AssignFI.jsx、製品=OperationsSimulationPanel.jsx。それぞれ在る方で見る）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const readLF = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const BOARD = path.join(SRC, 'opsim', 'RiskFlowBoard.jsx');
const PRES = path.join(SRC, 'opsim', 'opsimPresentation.js');
const board = readLF(BOARD);
const pres = readLF(PRES);

/** 🚨 対の片方だけ変えない。両方を直したら 下の2つを `sed 's/\r$//' f | md5sum` で更新する。 */
const PINNED = Object.freeze({
  'opsim/RiskFlowBoard.jsx': 'c733969b53fcaf69dedd7691ff610d46',
  'opsim/opsimPresentation.js': 'a3fcf889dffb13499b720aef153d3555',
});

const FORBIDDEN = ['できない', '不可', '未経験', '初級', '上級者', '有意', '標本', 'スコア', '偏差', '予定表'];

test('RF-1 px を書かない（rem／Tailwind の段だけ）', () => {
  for (const [name, src] of [['RiskFlowBoard.jsx', board], ['opsimPresentation.js', pres]]) {
    const hits = src.match(/\d+(\.\d+)?px\b|\[[^\]]*px\]|px\s*:/g) || [];
    assert.deepEqual(hits, [], `${name} に px がある: ${hits.join(' / ')}`);
  }
  assert.ok(board.includes('rem') || /\b(h|w|p|m|gap)-\d/.test(board), '大きさの指定が1つも無い（見張りが空振り）');
});

test('RF-2 押せる物（<button）は全部 min-h-11', () => {
  // ⚠ onClick の中に `=>` があるので `[^>]*` では切れる。<button から最初の className の文字列までを1つの札と見る。
  const buttons = board.match(/<button\b[\s\S]*?className=\{?[`"'][^`"']*[`"']/g) || [];
  assert.equal(buttons.length, (board.match(/<button\b/g) || []).length, '<button の数と className の数が合わない（className の無い button）');
  assert.ok(buttons.length >= 1, '<button が1つも無い（見張りが空振り）');
  for (const b of buttons) assert.ok(/className=\{?[`"'][^`"']*\bmin-h-11\b/.test(b), `min-h-11 の無い button: ${b.slice(0, 160)}`);
});

test('RF-3 禁じ語が1つも無い', () => {
  for (const [name, src] of [['RiskFlowBoard.jsx', board], ['opsimPresentation.js', pres]]) {
    const hit = FORBIDDEN.filter((w) => src.includes(w));
    assert.deepEqual(hit, [], `${name} に禁じ語: ${hit.join('・')}`);
  }
});

test('RF-4 数はここで作らない: 3列の分け方は buildDelayLanes、+N日 は lateDone.lateDays ただ1本', () => {
  assert.ok(board.includes("from './opsimPresentation.js'"), 'RiskFlowBoard が buildDelayLanes を読んでいない');
  assert.ok(!/Math\.ceil\([^)]*86400000/.test(board), '画面で日数を数え直している');
  assert.ok(pres.includes("from '../domain/operationsSimulation/lateDone.js'"), 'lateDays を lateDone.js から読んでいない');
  assert.ok(!/86400000/.test(pres), '日数の式を2本目として書いている');
  assert.ok(!pres.includes('buildCompletedLateRows'), '枝の buildCompletedLateRows（遅れて完了の数え直し）を持ち込んでいる');
  assert.ok(!/Date\.now\(/.test(pres) && !/Date\.now\(/.test(board), 'Date.now を呼んでいる（つまみの時刻を受けるだけ）');
});

test('RF-5 製品・最終で同じ中身（md5 の対。片方だけ変えない）', () => {
  // 部品: RiskFlowBoard.jsx は「型式」を「品目コード」に変えたので md5 の対にしない(純関数の opsimPresentation.js だけ対)
  assert.equal(md5(pres), PINNED['opsim/opsimPresentation.js'], '🚨 対の片方だけ変えない: opsim/opsimPresentation.js（両方直したら PINNED を更新）');
});

test('RF-8 期間の中で終わらない物(finishBeyondHorizon)を「これから遅れる」に描く・量を作らない（2026-09-24 帯と同じ数）', () => {
  assert.ok(pres.includes('finishBeyondHorizon: true'), 'buildDelayLanes が 期間の中で終わらない物を future に入れていない');
  assert.ok(!/horizonEnd/.test(pres) && !/horizonEnd/.test(board), '「期間の終わり − 納期線」を量にしている（simulate.js が禁じた数）');
  assert.ok(board.includes('row.finishBeyondHorizon === true'), '画面が finishBeyondHorizon を読んでいない');
  for (const w of ['期間の中で終わらない', '期間の中で終わらず納期を越える', 'futureBeyondHorizonCount', '納期の記録なし', 'unknownNoDueCount', '判定がつかない', 'つまみの時刻']) {
    assert.ok(board.includes(w), `画面に「${w}」が無い`);
  }
  assert.ok(!board.includes('納期か終わりが出ない'), '旧い札「納期か終わりが出ない」が残っている（中身は納期の記録なし／判定がつかない だけになった）');
  assert.ok(!/5営業日/.test(board), '期間の日数を決め打ちしている（期間は 5営業日／今月／来月 で変わる。horizonDays が届いた時だけ名乗る）');
});

const FI_ASSIGN = path.join(SRC, 'opsimfi', 'AssignFI.jsx');
const FI_VIEW = path.join(SRC, 'opsimfi', 'assignView.js');
const PRODUCT_PANEL = path.join(SRC, 'OperationsSimulationPanel.jsx');

test('RF-6 最終検査: AssignFI.jsx が <RiskFlowBoard を載せ、VIEW_MODES に「遅れの見取り図」がある', { skip: !fs.existsSync(FI_ASSIGN) && '最終検査のファイルが無い(製品側)' }, () => {
  const a = readLF(FI_ASSIGN);
  assert.ok(a.includes("from '../opsim/RiskFlowBoard.jsx'"), 'import が無い');
  assert.ok(/<RiskFlowBoard\b/.test(a), '<RiskFlowBoard が載っていない');
  assert.ok(/viewMode === 'risk'/.test(a), "viewMode === 'risk' の枝が無い");
  assert.ok(/lateDone=\{lateDone\}/.test(a.match(/<RiskFlowBoard[\s\S]*?\/>/)[0]), '遅れて完了(lateDone)を渡していない');
  const v = readLF(FI_VIEW);
  assert.ok(/key: 'risk', label: '遅れの見取り図'/.test(v), 'assignView.js の VIEW_MODES に risk が無い');
});

test('RF-7 製品検査: OperationsSimulationPanel.jsx が <RiskFlowBoard を載せ、VIEW_MODES に「遅れの見取り図」がある', { skip: !fs.existsSync(PRODUCT_PANEL) && '製品検査のファイルが無い(最終側)' }, () => {
  const p = readLF(PRODUCT_PANEL);
  assert.ok(p.includes("from './opsim/RiskFlowBoard.jsx'"), 'import が無い');
  assert.ok(/<RiskFlowBoard\b/.test(p), '<RiskFlowBoard が載っていない');
  assert.ok(/viewMode === 'risk'/.test(p), "viewMode === 'risk' の枝が無い");
  assert.ok(/lateDone=\{lateDone\}/.test((p.match(/<RiskFlowBoard[\s\S]*?\/>/) || [''])[0]), '遅れて完了(lateDone)を渡していない');
  assert.ok(/key: 'risk', label: '遅れの見取り図'/.test(p), 'VIEW_MODES に risk が無い');
});
