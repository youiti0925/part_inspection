// =============================================================================
//  shared-worker-strip-stale.test.mjs — 「両方の工場で働ける人」の帯が
//  **古い2通りの結果を出し続けない** 事を、本物の画面を動かして見る(2026-09-07)
// -----------------------------------------------------------------------------
//  直す前の穴(REVIEW 08・両アプリ):
//    ・土俵(groundKey)が 名前・基準時刻・見通しの日数 の3つだけだった。
//      ロット・名簿・設定が変わって盤を回し直しても この3つは同じままなので、
//      **前の入力で出した「遅れ ◯件」がそのまま残る**。
//    ・引き直しの途中で入力が変わっても、終わった順に setOut していた
//      (aliveRef は「画面が生きているか」しか見ていない)。
//
//  この見張りが押さえる物:
//    I1 土俵に inputKey が入る = 入力の指紋が変われば 前の2通りの結果は消える
//    I1b 指紋が同じなら消さない(「描き直す度に消す」で誤魔化していない)
//    I2 引き直しの途中で指紋が変わったら、その回の結果は置かない
//       (残りの段も引き直さない = runRung が2回目を呼ばれない)
//    I3 それでも「引き直しています」の札は必ず戻る(押せない帯にしない)
//    I4 呼ぶ側(SharedWorkerPlan)が inputKey を畳んだ帯へ渡している
//
//  🚨 文字が在るかだけの見張りにしない。本物の SharedWorkerStrip.jsx を
//     vite で読み、押した後の続き(await)まで実際に走らせて振る舞いを見る。
//     差し替えるのは React と 絵の部品だけ(_reactHost.mjs / _lucideStub.mjs)。
//  🚨 Firestore へは 1バイトも触らない。時計は渡した ms だけ。
//
//  壊し方(赤を見る手順・2026-09-07 に実際に走らせて赤を見た):
//    ・SharedWorkerStrip.jsx の groundKey から `, inputKey` を消す   → I1 と I2 が赤
//    ・run の中の `|| own !== epochRef.current` を2か所とも消す      → I2 だけ赤
//      (「古い入力で始めた引き直しの結果を、新しい入力の帯に置いている」)
//    ・SharedWorkerPlan.jsx の `inputKey={inputKey}` の行を消す      → I4 だけ赤
// =============================================================================
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import reactPlugin from '@vitejs/plugin-react';

const ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const at = (rel) => path.join(ROOT, rel);

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [reactPlugin()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: at('src/opsim/__tests__/_reactHost.mjs') },
      { find: /^react\/jsx-runtime$/, replacement: at('src/opsim/__tests__/_jsxRuntime.mjs') },
      { find: /^react\/jsx-dev-runtime$/, replacement: at('src/opsim/__tests__/_jsxRuntime.mjs') },
      { find: /^lucide-react$/, replacement: at('src/opsim/__tests__/_lucideStub.mjs') },
    ],
  },
});
after(() => server.close());

const host = await server.ssrLoadModule('/src/opsim/__tests__/_reactHost.mjs');
const { SharedWorkerStrip } = await server.ssrLoadModule('/src/opsim/SharedWorkerStrip.jsx');
const { mount, findByAttr, textOf, flushMicrotasks } = host;

const NOW = Date.UTC(2026, 8, 7, 1, 0, 0); // 2026-09-07 10:00 JST 相当の固定値(時計は使わない)

/** 帯を動かす。runRung は試験が握る。 */
const boot = (over = {}) => mount(SharedWorkerStrip, {
  hereWorkers: [{ name: '尾田' }, { name: '村' }],
  thereNames: ['坂井', '平野', '村'],
  pausedNames: [],
  hereLabel: '製品検査',
  thereLabel: '最終検査',
  nowMs: NOW,
  horizonDays: 5,
  untilMs: null,
  worksOnDay: null,
  runRung: async () => null,
  disposeRun: null,
  disabled: false,
  inputKey: 'K1',
  ...over,
});

const press = (inst) => {
  const btn = findByAttr(inst.tree, 'data-opsim-shared-run');
  assert.ok(btn, '「引き直す」ボタンが描かれていない(帯そのものが出ていない)');
  assert.equal(btn.props.disabled, false, 'ボタンが押せない状態で始まっている');
  return btn.props.onClick();
};

/** 押した後の続きを進めて、描き直す。 */
const settle = async (inst, ticks = 8) => {
  for (let i = 0; i < ticks; i += 1) await flushMicrotasks();
  inst.render();
};

const hasResult = (inst) => !!findByAttr(inst.tree, 'data-opsim-shared-result');
const isBusy = (inst) => textOf(inst.tree).includes('引き直しています');

// ─────────────────────────────────────────────────────────────────────────────
test('I1 入力の指紋が変わったら、前に出した2通りの結果は消える', async () => {
  const inst = boot();
  assert.equal(hasResult(inst), false, '押す前から結果が出ている');

  const p = press(inst);
  await p;
  await settle(inst);
  assert.equal(hasResult(inst), true, '押しても2通りの結果が出ていない(帯が動いていない)');

  // I1b 指紋が同じなら消さない(描き直す度に消す、で誤魔化していない)
  inst.render({ ...inst.props });
  assert.equal(hasResult(inst), true, '同じ入力で描き直しただけで結果を捨てている');

  // 盤が回し直した = 入力の指紋が変わった
  inst.render({ ...inst.props, inputKey: 'K2' });
  assert.equal(hasResult(inst), false,
    '入力の指紋が変わったのに、前の入力で出した「遅れ ◯件」が残っている(土俵に inputKey が入っていない)');
  inst.unmount();
});

test('I2 引き直しの途中で指紋が変わったら、その回の結果は置かない', async () => {
  let calls = 0;
  let release = null;
  const first = new Promise((res) => { release = res; });
  const inst = boot({
    runRung: async () => {
      calls += 1;
      if (calls === 1) return first;   // 1段目は試験が離すまで終わらない
      return null;
    },
  });

  press(inst);
  await flushMicrotasks();
  inst.render();
  assert.equal(calls, 1, '1段目が始まっていない');
  assert.equal(isBusy(inst), true, '押したのに「引き直しています」になっていない');

  // 引き直している最中に、盤が別の入力で回し直した
  inst.render({ ...inst.props, inputKey: 'K2' });

  release(null);
  await settle(inst);

  assert.equal(hasResult(inst), false,
    '古い入力で始めた引き直しの結果を、新しい入力の帯に置いている');
  assert.equal(calls, 1,
    '土俵が変わったのに 2段目まで引き直している(古い入力の計算を続けている)');
  // I3 押せない帯にしない
  assert.equal(isBusy(inst), false,
    '「引き直しています（1／2）」のまま戻らない(押せない帯になっている)');
  const btn = findByAttr(inst.tree, 'data-opsim-shared-run');
  assert.equal(btn.props.disabled, false, '引き直しが終わったのにボタンが押せないまま');
  inst.unmount();
});

test('I2b 指紋が変わらなければ、2段とも引き直して結果を置く(捨てすぎていない)', async () => {
  let calls = 0;
  const inst = boot({ runRung: async () => { calls += 1; return null; } });
  press(inst);
  await settle(inst);
  assert.equal(calls, 2, '2通りとも引き直していない');
  assert.equal(hasResult(inst), true, '結果を置いていない(世代の札で捨てすぎている)');
  inst.unmount();
});

test('I4 呼ぶ側(SharedWorkerPlan)が 畳んだ帯へ inputKey を渡している', () => {
  const file = at('src/opsim/SharedWorkerPlan.jsx');
  assert.ok(fs.existsSync(file), `画面が見つからない: ${file}。見張りが空振りしている。`);
  const code = fs.readFileSync(file, 'utf8');
  const strip = /<SharedWorkerStrip[\s\S]*?\/>/.exec(code);
  assert.ok(strip, '畳んだ中に SharedWorkerStrip を描いていない');
  assert.ok(strip[0].includes('inputKey={inputKey}'),
    '畳んだ Strip へ inputKey を渡していない(盤を回し直しても古い2通りが残る)');
  assert.match(code, /inputKey = '',/, 'SharedWorkerPlan が inputKey を受け取っていない');

  const panel = fs.readFileSync(at('src/OperationsSimulationPanel.jsx'), 'utf8');
  const plan = /<SharedWorkerPlan[\s\S]*?\/>/.exec(panel);
  assert.ok(plan, '入れ物が SharedWorkerPlan を描いていない');
  assert.match(plan[0], /inputKey=\{groundKey \|\| ''\}/,
    '入れ物が 盤の指紋(groundKey)を inputKey として渡していない');
});
