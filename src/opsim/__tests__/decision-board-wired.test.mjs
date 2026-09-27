// 🗂 2026-09-23 「割付と空き」(DecisionBoard・Codex 13bb9d2 の画面)が **本当に辿り着ける画面** として配線されているかの見張り。
//   🚨 2026-09-23 本番では runSkillTrials を Worker へ渡す口が無く、技能試行が一度も出ていなかった。
//     この見張りは「札が在る」「描く枝が在る」「runSkillTrials:true が Worker への道に載る」を **文字で** 数える
//     (隣の見張りと同じやり方。計算は decisionBoard.test.mjs の側)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.resolve(HERE, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');

const header = read('opsim/Header.jsx');
const panel = read('OperationsSimulationPanel.jsx');
const hook = read('useOperationsSimulation.js');
const board = read('opsim/DecisionBoard.jsx');

test('DB-1 Header と Panel の札に dispatch(割付と空き)が在る', () => {
  assert.match(header, /key:\s*'dispatch'/, 'Header.jsx の OPSIM_TABS に dispatch が無い');
  assert.match(header, /label:\s*'割付と空き'/, 'Header.jsx の札の名前が「割付と空き」でない');
  // 本当に描かれる一覧は Panel の OPSIM_TABS_MAIN(親が tabs= で渡す方)。予備の一覧だけでは画面に出ない。
  const main = panel.match(/const\s+OPSIM_TABS_MAIN\s*=\s*Object\.freeze\(\[([\s\S]*?)\n\]\);/);
  assert.ok(main, 'Panel の OPSIM_TABS_MAIN が読めない');
  assert.match(main[1], /key:\s*'dispatch'/, 'OPSIM_TABS_MAIN に dispatch が無い(押せる札が無い)');
  // 既定の札は盤面のまま(決まり13・19)
  assert.match(panel, /useState\(\s*'board'\s*\)/, '既定の札が board でない');
});

test('DB-2 Header は dispatch でも結論の1行(帯)を出し、切替を2つ出さない', () => {
  assert.match(header, /!\(tab === 'board' \|\| tab === 'dispatch'\) \? null :/, '結論の帯の条件に dispatch が無い');
  assert.match(header, /\(tab === 'board' \|\| tab === 'dispatch'\) \? null : <TabBar/, '帯の外の TabBar が dispatch でも出る(切替が2つ出る)');
});

test('DB-3 Panel は DecisionBoard を読み込み、opsimTab === dispatch で描く', () => {
  assert.match(panel, /import DecisionBoard from '\.\/opsim\/DecisionBoard\.jsx';/, 'DecisionBoard の import が無い');
  const branch = panel.match(/\{opsimTab === 'dispatch' && \(\s*<DecisionBoard([\s\S]*?)\/>\s*\)\}/);
  assert.ok(branch, 'opsimTab === dispatch の描く枝が無い(札は在るのに押した先が真っ白)');
  for (const prop of ['decisionBoard=', 'result=', 'snapshot=', 'lots=', 'onPickLot=', 'onRunTrials=', 'loading=']) {
    assert.ok(branch[1].includes(prop), `DecisionBoard に ${prop} が渡っていない`);
  }
});

test('DB-4 🎓 ボタン → runSkillTrials:true が Worker への道(useOperationsSimulation の payload)に載る', () => {
  assert.match(panel, /const \[runSkillTrials, setRunSkillTrials\] = useState\(false\)/, 'Panel に runSkillTrials の state が無い');
  assert.match(panel, /useOperationsSimulation\(\{[\s\S]*?runSkillTrials,/, 'Panel が runSkillTrials をフックへ渡していない');
  assert.match(panel, /onRunTrials=\{\(\) => \{[^}]*setRunSkillTrials\(true\)/, '🎓 ボタンが setRunSkillTrials(true) を呼ばない');
  assert.match(hook, /runSkillTrials: runSkillTrials === true/, 'フックの payload に runSkillTrials が無い(Worker は p.runSkillTrials === true を読む)');
  // 🔁 2026-09-23 runKey は保存計画の指紋(parseRunKey が9つで読む・PC-1)なので混ぜない。effect の依存に入れて押した瞬間に計算し直す
  assert.doesNotMatch(hook, /runSkillTrials \? 'trials' : ''/, 'runKey に runSkillTrials を混ぜている(保存計画の指紋が壊れる・PC-1)');
  assert.match(hook, /scenarioHints, runSkillTrials\]\);/, 'effect の依存に runSkillTrials が無い(押しても計算し直らない)');
  // 一致: Panel が渡す名前 と Worker が読む名前 は同じ文字
  const worker = read('workers/operationsSimulation.worker.js');
  assert.match(worker, /p\.runSkillTrials === true/, 'Worker 側の読み口が変わった。フックの payload の名前も揃え直す事');
});

test('DB-5 DecisionBoard.jsx: px の直書き無し・ボタンは全部 min-h-11・禁じた言葉無し・verdict をそのまま出す', () => {
  assert.equal((board.match(/\d+px\b/g) || []).join(','), '', 'px の直書きが在る');
  assert.equal((board.match(/text-\[\d+px\]/g) || []).length, 0, 'text-[Npx] が在る');
  // 開きタグの終わりまで(onClick の `=>` の > で切らない)
  const buttons = [...board.matchAll(/<button\b(?:=>|[^>])*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 4, `<button が少なすぎる(${buttons.length})`);
  for (const b of buttons) assert.ok(/min-h-11/.test(b), `min-h-11 の無い <button>: ${b.slice(0, 80)}`);
  for (const w of ['できない', '不可', '未経験', '初級', '上級者', '有意', '標本', 'スコア', '偏差', '予定表']) {
    assert.ok(!board.includes(w), `禁じた言葉「${w}」が在る`);
  }
  // master の verdict 4語を全部言葉にしている(tradeoff/worse を「効く」と読ませない)
  for (const v of ['improves', 'tradeoff', 'worse', "'no-change'"]) assert.ok(board.includes(v), `verdict ${v} の言葉が無い`);
  assert.match(board, /verdictOf\(row\) === 'improves'/, '人の行に添える試行が improves だけに絞られていない');
  assert.match(board, /decisionBoard\.trials \|\| decisionBoard\.rows/, 'master の decisionBoard.trials を読んでいない');
  assert.match(board, /🎓 技能の試行を計算する/, '押し口の文言が無い');
});
