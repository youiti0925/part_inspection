// Exercise the actual component and its effects. This host does not model DOM
// reconciliation: unique sibling identities are checked at the React boundary.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import reactPlugin from '@vitejs/plugin-react';
import { exampleInput } from '../../domain/fullPair/fixture.mjs';
import { compareFullPair } from '../../domain/fullPair/scheduler.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// 🔧 2026-09-26 反証役: cacheDir と optimizeDeps が無く、Vite の依存探索が index.html から lucide-react を辿って落ちていた(既存の画面試験と同じ設定にする)
const server = await createServer({ root, configFile: false, logLevel: 'silent', appType: 'custom',
  cacheDir: path.join(os.tmpdir(), 'fullpair-comparison-selection-test-vite-cache'),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [reactPlugin({ jsxRuntime: 'classic' })],
  resolve: { alias: [{ find: /^react$/, replacement: path.join(root, 'src/opsim/__tests__/_reactHost.mjs') }] },
});
after(() => server.close());
const { mount, findAll, textOf } = await server.ssrLoadModule('/src/opsim/__tests__/_reactHost.mjs');
const { default: Comparison } = await server.ssrLoadModule('/src/opsim/fullPair/FullPairComparison.jsx');
const originalWorker = globalThis.Worker;
const workers = [];
globalThis.Worker = class {
  constructor() { workers.push(this); }
  postMessage(data) { this.request = data; }
  terminate() { this.terminated = true; }
};
after(() => { if (originalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = originalWorker; });

test('候補を A→B→C→A と選んでも作業順・距離表の識別子は重複せず、対象と探索条件がそろう', () => {
  const input = exampleInput({ quantityA: 2, quantityB: 2 });
  const result = compareFullPair(input);
  const candidates = ['one', 'two', 'three'].map((key, i) => ({ key, label: key,
    input: structuredClone(input), options: { beamWidth: 16 + i, maxExpansions: 12000 } }));
  const inst = mount(Comparison, { candidates });
  findAll(inst.tree, e => e.type === 'button' && /全台完了まで計算する/.test(textOf(e)))[0].props.onClick();
  inst.render();
  const worker = workers.at(-1);
  worker.onmessage({ data: { requestKey: worker.request.requestKey, done: true,
    rows: candidates.map(c => ({ ...c, result: structuredClone(result) })) } });
  inst.render();
  const routeKeys = new Map();
  for (const key of ['one', 'two', 'three', 'one']) {
    findAll(inst.tree, e => e.type === 'button' && e.props['aria-pressed'] !== undefined && textOf(e).startsWith(key))[0].props.onClick();
    inst.render();
    const routes = findAll(inst.tree, e => e.type?.name === 'WorkerRoute');
    const distances = findAll(inst.tree, e => e.type?.name === 'DistanceCheck');
    assert.equal(routes.length, 1);
    assert.equal(distances.length, 1);
    assert.notEqual(routes[0].props.key, distances[0].props.key, '別種の兄弟へ同じkeyを渡さない');
    const c = candidates.find(c => c.key === key);
    assert.strictEqual(routes[0].props.input, c.input);
    assert.strictEqual(distances[0].props.input, c.input);
    assert.strictEqual(distances[0].props.options, c.options);
    if (routeKeys.has(key)) assert.equal(routes[0].props.key, routeKeys.get(key));
    routeKeys.set(key, routes[0].props.key);
  }
  assert.equal(new Set(routeKeys.values()).size, 3, '候補が変わる時は展開状態もリセットする');
  inst.render({ candidates: candidates.map(c => ({ ...c, options: { ...c.options, beamWidth: 32 } })) });
  assert.equal(worker.terminated, true);
  worker.onmessage({ data: { requestKey: worker.request.requestKey, done: true,
    rows: candidates.map(c => ({ ...c, result })) } });
  inst.render();
  assert.equal(findAll(inst.tree, e => e.type?.name === 'WorkerRoute').length, 0, '前条件の遅い応答を再表示しない');
  inst.unmount();
});
