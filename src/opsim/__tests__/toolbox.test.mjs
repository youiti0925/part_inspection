// =============================================================================
//  toolbox.test.mjs — 🧰 道具箱(案A ⑤)の見張り(2026-09-18)
// -----------------------------------------------------------------------------
//  清水さん「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメだと思う」
//
//  この見張りが守る事(狙い):
//    X1 6つの箱が **決めた順** で出る(⏱ / 🧷 / 👥 / 🕒 / ⚙ / ▶)
//    X2 閉じている時は 1つも描かない(盤の場所を1pxも取らない)
//    X3 閉じる道が3つ(× / 背景 / Esc)で、どれも **閉じるだけ**(確定の道が1本も無い)
//    X4 中身は呼ぶ側が渡した物をそのまま描く(道具箱が自分で計算・整形しない)
//    X5 渡っていない箱も 箱ごと消さない(在るはずの道具が黙って消えない)
//    X6 押す物 44px 以上・文字 12px 以上・px 直書き 0
//    X7 製品の事情を import していない(製品と最終で md5 の対にする為)
//    X8 **移した物が1つも消えていない**: 元の道具の呼び口が 全部 画面に残っている
//       (⏱時間を進める / 🧷固定 / 👥両方の工場 / 🪜はしご / 条件くらべ / ⚙設定 / 🧾根拠 /
//        ？数字の意味 / ▶ロットの流れ)
//
//  🚨 壊し方(赤を見た): TOOLBOX_SECTIONS から1つ消す → X1 が赤。
//    `if (!open) return null;` を消す → X2 が赤。
//    Panel の sections から remedy を外す → X8 が赤。
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
const SRC = at('src/opsim/Toolbox.jsx');
const code = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const panel = fs.readFileSync(at('src/OperationsSimulationPanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
/** 注意書きを外した中身（注意書きに名前を書いただけで赤にしない）。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => `${p1} `);
const body = strip(code);
const panelBody = strip(panel);

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
const { Toolbox, ToolboxButton } = await server.ssrLoadModule('/src/opsim/Toolbox.jsx');
const { mount, findAll, findByAttr, textOf } = host;

/** 子の部品(Section)まで展げる。⚠ hooks を使わない部品だけ。 */
const expand = (node) => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!node.__el) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  const props = { ...node.props };
  if (props.children !== undefined) props.children = expand(props.children);
  return { ...node, props };
};

const SECTIONS = {
  clock: { __el: true, type: 'div', props: { 'data-test-body': 'clock', children: 'とけいの中身' } },
  keep: { __el: true, type: 'div', props: { 'data-test-body': 'keep', children: 'こていの中身' } },
  shared: { __el: true, type: 'div', props: { 'data-test-body': 'shared', children: 'りょうほうの中身' } },
  remedy: { __el: true, type: 'div', props: { 'data-test-body': 'remedy', children: 'なのうきの中身' } },
  gear: { __el: true, type: 'div', props: { 'data-test-body': 'gear', children: 'せっていの中身' } },
  flow: { __el: true, type: 'div', props: { 'data-test-body': 'flow', children: 'ながれの中身' } },
};

const boot = (over = {}) => mount(Toolbox, { open: true, onClose: null, sections: SECTIONS, note: '', ...over });

// ─────────────────────────────────────────────────────────────────────────────
test('X1 6つの箱が 決めた順で出る', () => {
  const inst = boot();
  const keys = findAll(expand(inst.tree), (el) => el.props && el.props['data-opsim-toolbox-section'])
    .map((el) => el.props['data-opsim-toolbox-section']);
  assert.deepEqual(keys, ['clock', 'keep', 'shared', 'remedy', 'gear', 'flow'],
    `6つの箱の並びが違います: ${keys.join(' / ')}`);
  const root = findByAttr(inst.tree, 'data-opsim-toolbox');
  assert.equal(root.props['data-opsim-toolbox'], '6', '道具箱が名乗る箱の数が6ではない');
  const t = textOf(expand(inst.tree));
  for (const w of ['時間を進める', '決めた物を守る', '両方の工場で働ける人', '納期を守る手', '設定と根拠', 'ロットの流れ']) {
    assert.ok(t.includes(w), `箱の名前が出ていない: ${w}`);
  }
});

test('X2 閉じている時は1つも描かない(盤の場所を1pxも取らない)', () => {
  const inst = boot({ open: false });
  assert.equal(inst.tree, null, '閉じているのに何かを描いています');
});

test('X3 閉じる道が3つ(× / 背景 / Esc)で、どれも閉じるだけ', () => {
  let closed = 0;
  const inst = boot({ onClose: () => { closed += 1; } });
  const tree = expand(inst.tree);
  const back = findAll(tree, (el) => el.props && el.props['aria-hidden'] === 'true' && typeof el.props.onClick === 'function')[0];
  assert.ok(back, '背景を押して閉じる道がありません');
  back.props.onClick();
  const x = findAll(tree, (el) => el.props && el.props['aria-label'] === '閉じる')[0];
  assert.ok(x, '× のボタンがありません');
  x.props.onClick();
  assert.equal(closed, 2, '閉じる道が親の onClose へ届いていません');
  assert.ok(/e\.key !== 'Escape' && e\.key !== 'Esc'/.test(body), 'Esc で閉じる道がありません');
  // 🚨 2026-08-21 の事故(背景タップが取り消せない確定を焼き付けた)と同じ形を作らない
  assert.ok(!/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction/.test(body),
    '道具箱の中に「書く道具」があります(閉じるだけの場所から確定へ行く道を作らない)');
});

test('X4/X5 中身は渡された物をそのまま描く・渡っていない箱も箱ごと消さない', () => {
  const inst = boot();
  const tree = expand(inst.tree);
  for (const k of Object.keys(SECTIONS)) {
    assert.ok(findAll(tree, (el) => el.props && el.props['data-test-body'] === k).length === 1,
      `渡した中身が ${k} の箱に出ていません(道具箱が中身を作り直している)`);
  }
  // 渡っていない箱も 箱の見出しは出る（在るはずの道具が黙って消えない）
  const partial = boot({ sections: { clock: SECTIONS.clock } });
  const keys = findAll(expand(partial.tree), (el) => el.props && el.props['data-opsim-toolbox-section'])
    .map((el) => el.props['data-opsim-toolbox-section']);
  assert.equal(keys.length, 6, '中身が渡っていないと箱ごと消えています');
});

test('X6 押す物 44px 以上・文字 12px 以上・px 直書き 0', () => {
  const px = (body.match(/\[\d+(?:\.\d+)?px\]/g) || []).filter((x) => !/min\(/.test(x));
  assert.deepEqual(px, [], `px 直書きがあります: ${px.join(' ')}`);
  assert.ok(!/text-3xs/.test(body), 'text-3xs(12px 未満)を新しく使っています');
  assert.ok(/min-h-11/.test(body), '押す物に min-h-11(44px)がありません');
  assert.ok(!/zoom:|transform:\s*['"`]?scale/.test(body), 'zoom / transform:scale を使っています');
  // 開く札にも大きさが要る
  const btn = mount(ToolboxButton, { open: false, onToggle: null });
  assert.ok(String(btn.tree.props.className).includes('min-h-11'), '道具箱を開く札が 44px 未満です');
});

test('X7 製品の事情を import していない(製品と最終で md5 の対にする)', () => {
  const imports = [...code.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['lucide-react', 'react'],
    `対にできない import があります: ${imports.join(' / ')}`);
});

test('X8 移した道具が1つも消えていない(呼ぶ側が6つの箱へ全部渡している)', () => {
  // 道具箱そのものが画面に在る
  assert.ok(/<Toolbox\b/.test(panelBody), '画面が 🧰 道具箱 を描いていません');
  assert.ok(/<ToolboxButton\b/.test(panelBody), '道具箱を開く札がありません(開けない引き出しになります)');
  // 6つの鍵に全部 中身を渡している
  const sec = panelBody.match(/sections=\{\{[\s\S]*?\n\s*\}\}/);
  assert.ok(sec, '道具箱へ渡す 6つの箱(sections)が読めません');
  for (const k of ['clock', 'keep', 'shared', 'remedy', 'gear', 'flow']) {
    assert.ok(new RegExp(`\\b${k}:\\s*\\(`).test(sec[0]), `${k} の箱へ中身を渡していません(空の箱になります)`);
  }
  // 移した **元の部品** が1つも消えていない
  for (const [what, re] of [
    ['⏱ 時間を進める', /<BoardFullStrip\b/],
    ['👥 両方の工場で働ける人', /<SharedWorkerPlan\b/],
    ['🪜 効く手のはしご', /<RescueLadder\b/],
    ['条件くらべ', /<ScenarioCompare\b/],
    ['⚙ 設定をひらく', /<GearButton\b/],
    ['🧾 根拠', /data-opsim-goto-gear="evidence"/],
    ['？ 数字の意味', /data-opsim-why-toggle="1"/],
    ['🧷 固定が既定', /data-opsim-keep-pick=/],
    ['▶ ロットの流れ', /data-opsim-view-pick="board"/],
  ]) {
    assert.ok(re.test(panelBody), `移したはずの道具が画面から消えています: ${what}`);
  }
});
