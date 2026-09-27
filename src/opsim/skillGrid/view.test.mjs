import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { buildSkillGrid } from './model.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { SkillGrid } = await server.ssrLoadModule('/src/opsim/skillGrid/SkillGrid.jsx');
const render = (model) => renderToStaticMarkup(React.createElement(SkillGrid, { model }));

test('未接続は灰色の未受領表示で、0回の表を作らない', () => {
  const html = render(null);
  assert.match(html, /元データをまだ受け取っていません/);
  assert.doesNotMatch(html, /<table/);
});

test('4状態を描画し、同じ1行の各セルに回数と登録を置く', () => {
  const model = buildSkillGrid({
    lots: [{ id: '1', templateId: 't', model: '確認型式', status: 'completed', tasks: [{ workerName: 'A' }, { workerName: 'B' }] }],
    workers: ['A', 'B', 'C', 'D'].map((name) => ({ id: name, name })),
    templates: [{ id: 't', name: '確認テンプレ', requiredSkills: ['s'] }],
    workerSkills: { A: { s: 2 }, C: { s: 1 } },
  });
  const html = render(model);
  for (const state of ['both', 'history', 'registration', 'neither']) assert.match(html, new RegExp(`data-skill-grid-state="${state}"`));
  assert.equal((html.match(/data-skill-grid-row=/g) || []).length, 1);
  assert.equal((html.match(/data-skill-grid-state=/g) || []).length, 4);
  assert.match(html, /教育中/);
  assert.match(html, /色は記録の有無で、力量・割付の判定ではありません/);
});

test('不明・未設定・休止中・補完内数が表から読める', () => {
  const model = buildSkillGrid({
    lots: [{ id: '1', model: '確認', templateId: 't', status: 'completed', workerId: 'w', tasks: {} }],
    templates: [{ id: 't', name: '確認' }], workers: [{ id: 'w', name: '確認者', paused: true }], workerSkills: {},
  });
  const html = render(model);
  assert.match(html, /休止中/);
  assert.match(html, /必要スキル未設定/);
  assert.match(html, /うち担当補完 1回/);
  assert.match(html, /履歴を全部受け取れたか未確認/);
});

test('ユーザーの型式名・作業者名はHTMLとして実行しない', () => {
  const model = buildSkillGrid({
    lots: [{ id: '1', model: '<script>alert(1)</script>', templateId: 't', status: 'completed', tasks: [{ workerName: '<img src=x>' }] }],
    templates: [{ id: 't', name: '確認' }], workers: [], workerSkills: {},
  });
  const html = render(model);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});
