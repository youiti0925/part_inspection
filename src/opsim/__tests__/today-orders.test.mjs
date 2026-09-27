// =============================================================================
//  today-orders.test.mjs — 「今日の指示」(案A ②)を **本物のまま動かして** 見る(2026-09-18)
// -----------------------------------------------------------------------------
//  清水さんの言葉(2026-09-18)
//    「あなたの作りこみが甘すぎるよ」「いろんなところに機能が散らばりすぎてる」
//    「答えを出す道具ではなく見せる道具で止まっている」
//
//  この見張りが守る事(狙い):
//    T1 人ごとに1枚出る(名簿の人は 割付が無くても居ない事にしない)
//    T2 「いま」= 基準時刻を含む割付。無ければ 基準時刻以降の最初の割付
//    T3 「次」= その後の **別のロット** の最初の割付(同じロットの続きは「次」にしない)
//    T4 応援・休みの人は 記号から作った言葉("◯◯検査の応援")を出し、棒を描かない
//    T5 📌「この指示で全部固定」は 納期一覧と同じ形([{lotId, worker}])を親へ渡す
//    T6 数をここで作らない(ロットの件数は割付の別ロット数そのまま)・Date.now を読まない
//    T7 押す物 44px 以上(min-h-11)・文字 12px 以上(text-3xs を使わない)・px 直書き 0
//    T8 製品の事情を import していない(製品と最終で md5 の対にする為)
//
//  🚨 壊し方(赤を見た): todayOrderOf の「別のロット」の条件を外す → T3 が赤。
//    absencesToday を読む行を消す → T4 が赤。pinList の worker を空にする → T5 が赤。
//    min-h-11 を min-h-8 にする → T7 が赤。
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
const SRC = at('src/opsim/TodayOrders.jsx');
const code = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
/** 注意書きを外した中身。🚨 注意書きに名前を書いただけで赤にすると、
    見張りを黙らせる為に **注意書きの方を消す** 事になるので、中身だけを見る。 */
const body = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => `${p1} `);

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
const { TodayOrders } = await server.ssrLoadModule('/src/opsim/TodayOrders.jsx');
const { mount, findAll, findByAttr, textOf } = host;

// ── 作り物の材料(固定の時刻だけ。Date.now は1回も呼ばない) ────────────────────
const D = (h, m) => new Date(2026, 8, 18, h, m, 0, 0).getTime();   // 2026-09-18(金)
const NOW = D(9, 0);

/** その日の窓は 08:30〜17:15(暦の代わり。試験が握る)。 */
const calendar = {
  workerWindowOf: () => ({ startMs: D(8, 30), endMs: D(17, 15), effectiveEndMs: D(17, 15) }),
};

const LOTS = [
  { lotId: 'L1', model: 'TWA-100', templateId: 't1', orderNo: '1001528140' },
  { lotId: 'L2', model: 'RTH-302', templateId: 't1', orderNo: '1001528141' },
  { lotId: 'L3', model: 'RWM-160R-2', templateId: 't2', orderNo: '1001525896' },
];
const TEMPLATES = new Map([['t1', { name: '傾斜分割' }], ['t2', { name: '中間分割_回転' }]]);

const A = (worker, lotId, a, b) => ({ jobId: `${lotId}#0#0`, lotId, worker, startMs: a, endMs: b });

// 📐 2026-09-18 夜: 既定は畳んだ形(1人1行)。ここの試験は 大きな札(defaultOpen)の中身を見る。畳んだ形は today-orders-compact.test.mjs。
const boot = (over = {}) => mount(TodayOrders, {
  defaultOpen: true,
  assignments: [
    // 尾田: いま L1(08:30〜10:00)、同じ L1 の続き(10:00〜10:30)、その後 L2
    A('尾田', 'L1', D(8, 30), D(10, 0)),
    A('尾田', 'L1', D(10, 0), D(10, 30)),
    A('尾田', 'L2', D(10, 30), D(12, 0)),
    // 片山: 基準時刻より後から始まる L3
    A('片山', 'L3', D(13, 0), D(15, 30)),
  ],
  lots: LOTS,
  templatesById: TEMPLATES,
  calendar,
  baseNowMs: NOW,
  workerNames: ['尾田', '村', '片山'],
  absencesToday: { 村: 'support:final' },
  pinsByLot: {},
  actualPinsNote: '手が付いた 3件はその人のまま',
  keepDecided: true,
  onPinAll: null,
  onSelectLot: null,
  dateText: '9/18（金）',
  ...over,
});

/**
 * 🧪 子の部品(OrderCard / Avatar)まで展げてから見る。
 * 土台(_reactHost)は **一番上の部品だけ** を描くので、
 * 子の中の実際の札を見るにはここで展げる必要がある。
 * ⚠ 展げるのは hooks を使わない部品だけ(OrderCard / Avatar は使っていない)。
 */
const expand = (node) => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!node.__el) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  const props = { ...node.props };
  if (props.children !== undefined) props.children = expand(props.children);
  return { ...node, props };
};

const cardOf = (inst, name) => findAll(expand(inst.tree), (el) => el.props && el.props['data-today-order-worker'] === name)[0] || null;

// ─────────────────────────────────────────────────────────────────────────────
test('T1 名簿の人は全員1枚ずつ出る(割付が無くても居ない事にしない)', () => {
  const inst = boot();
  const root = findByAttr(inst.tree, 'data-today-orders');
  assert.ok(root, '「今日の指示」そのものが描かれていない');
  assert.equal(root.props['data-today-orders'], '3', '人の枚数が名簿の人数と違う');
  for (const n of ['尾田', '村', '片山']) assert.ok(cardOf(inst, n), `${n} の札が出ていない`);
});

test('T2 「いま」は 基準時刻を含む割付。無ければ 基準時刻以降の最初', () => {
  const inst = boot();
  const oda = textOf(cardOf(inst, '尾田'));
  assert.ok(oda.includes('いま'), '「いま」の行が無い');
  assert.ok(oda.includes('TWA-100｜傾斜分割'), `いまの仕事が出ていない: ${oda}`);
  assert.ok(oda.includes('8:30〜10:00'), `いまの仕事の時刻が出ていない: ${oda}`);
  // 片山は基準時刻(09:00)に仕事が無いので、その後の最初(13:00)が「いま」
  const kata = textOf(cardOf(inst, '片山'));
  assert.ok(kata.includes('RWM-160R-2｜中間分割_回転'), `後の最初の仕事が「いま」になっていない: ${kata}`);
  assert.ok(kata.includes('13:0'), `後の最初の仕事の時刻が出ていない: ${kata}`);
});

test('T3 「次」は 別のロット(同じロットの続きは「次」にしない)', () => {
  const inst = boot();
  const oda = textOf(cardOf(inst, '尾田'));
  assert.ok(oda.includes('次'), '「次」の行が無い');
  assert.ok(oda.includes('RTH-302'), `「次」が別のロットになっていない(同じ L1 の続きを出している): ${oda}`);
  // 片山は「次」が無い ＝ 無い物を書かない
  assert.ok(!textOf(cardOf(inst, '片山')).includes('RTH-302'), '片山の札に他人の仕事が出ている');
});

test('T4 応援の人は 記号から作った言葉を出し、棒を描かない', () => {
  const inst = boot();
  const mura = cardOf(inst, '村');
  assert.equal(mura.props['data-today-order-state'], 'away', '応援の人の状態が away になっていない');
  const t = textOf(mura);
  assert.ok(t.includes('最終検査の応援'), `応援の言葉が出ていない: ${t}`);
  assert.ok(!t.includes('休み'), '応援を「休み」に丸めている(2026-09-16 清水さんの指摘)');
  assert.equal(findAll(mura, (el) => el.props && el.props['data-today-order-bar']).length, 0,
    '応援の日に仕事の棒を描いている');
  // 知らない記号は そのまま出す(推測で丸めない)
  const inst2 = boot({ absencesToday: { 村: '研修' } });
  assert.ok(textOf(cardOf(inst2, '村')).includes('研修'), '知らない記号を勝手に言い換えている');
});

test('T5 📌「この指示で全部固定」は 納期一覧と同じ形を親へ渡す', () => {
  let got = null;
  const inst = boot({ onPinAll: (list) => { got = list; } });
  const btn = findByAttr(inst.tree, 'data-today-orders-pin-all');
  assert.ok(btn, '📌 の札が出ていない');
  btn.props.onClick();
  assert.ok(Array.isArray(got), '親へ並びが渡っていない(押しても何も起きない)');
  const byLot = Object.fromEntries(got.map((x) => [x.lotId, x.worker]));
  assert.deepEqual(byLot, { L1: '尾田', L2: '尾田', L3: '片山' }, `渡した形が違う: ${JSON.stringify(got)}`);
  assert.equal(btn.props['data-today-orders-pin-all'], '3', '札の件数が渡す件数と違う');
  // 渡す口が無ければ札そのものを出さない(押せるのに何も起きない札を作らない)
  assert.equal(findByAttr(boot({ onPinAll: null }).tree, 'data-today-orders-pin-all'), null,
    '渡す口が無いのに 📌 の札が出ている');
});

test('T6 数をここで作らない・Date.now を読まない', () => {
  const inst = boot();
  assert.ok(textOf(cardOf(inst, '尾田')).includes('2ロット'), 'ロットの件数が割付の別ロット数と合っていない');
  assert.ok(textOf(inst.tree).includes('手が付いた 3件はその人のまま'),
    '固定の件数の1文が、渡された文字のまま出ていない(画面で数え直している)');
  assert.ok(!/Date\.now\(/.test(body), 'Date.now を呼んでいます(同じ入力で答えが揺れます)');
});

test('T7 押す物 44px 以上・文字 12px 以上・px 直書き 0', () => {
  const px = code.match(/\[\d+(?:\.\d+)?px\]/g) || [];
  assert.deepEqual(px, [], `px 直書きがあります: ${px.join(' ')}`);
  assert.ok(!/text-3xs/.test(code), 'text-3xs(12px 未満)を新しく使っています');
  const buttons = code.match(/<button[\s\S]*?className=/g) || [];
  assert.ok(buttons.length >= 1, 'ボタンが1つも無い');
  // 押す物のうち「札」(min-h を持つべき物)に min-h-11 が在るか
  assert.ok(/min-h-11/.test(code), '押す物に min-h-11(44px)がありません');
  assert.ok(!/zoom:|transform:\s*['"`]?scale/.test(code), 'zoom / transform:scale を使っています');
});

test('T8 製品の事情を import していない(製品と最終で md5 の対にする)', () => {
  const imports = [...code.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  const allowed = new Set(['react', './vizKit.jsx', './workerColors.js', './idleTone.js']);
  for (const p of imports) {
    assert.ok(allowed.has(p), `対にできない import があります: ${p}（props で受けてください）`);
  }
  assert.ok(!/\/App\.jsx|firebase|firestore/i.test(body), 'アプリ固有の物を読んでいます');
});

/* ══ 2026-09-18 **写しの実測で出た穴** をここで固定する ═══════════════════════════
   本番の写し(5610・633ロット)を自分で開いて数えたら、コードの読み合わせでは出なかった
   2つの嘘が画面に出ていた。どちらもこの部品の中の話なので、ここで赤にする。 */

test('T9 個人設定の登録が無い人でも 割付が在れば出す(「この日の割付はありません」と嘘を言わない)', () => {
  /* 🚨 実測: 暦の workerWindowOf は **個人設定が登録されている人にしか窓を返さない**。
     人ごとの窓で切っていたので、登録の無い人は割付が在るのに
     「この日の割付はありません」と出ていた(3人のうち2人)。 */
  const onlyOda = { workerWindowOf: (dayMs, name) => (name === '尾田' ? { startMs: D(8, 30), endMs: D(17, 15), effectiveEndMs: D(17, 15) } : null) };
  const inst = boot({ calendar: onlyOda });
  const kata = textOf(cardOf(inst, '片山'));
  assert.ok(kata.includes('RWM-160R-2'), `登録の無い人の仕事が消えています: ${kata}`);
  assert.ok(!kata.includes('この日の割付はありません'), '割付が在るのに「ありません」と出ています');
  // 1人も読めない時は その日ぜんぶを窓にする(それでも仕事は出す)
  const none = boot({ calendar: { workerWindowOf: () => null } });
  assert.ok(textOf(cardOf(none, '尾田')).includes('TWA-100'), '暦が1人も読めない時に仕事が消えています');
  assert.ok(textOf(cardOf(none, '片山')).includes('RWM-160R-2'), '暦が1人も読めない時に仕事が消えています');
  // 窓は **全員で1つ**(人ごとに幅が違うと隣の人の棒と見比べられない)
  assert.ok(/その日の \*\*1つの窓\*\*\(全員で同じ\)/.test(code), '窓を1つにする決めが注意書きから消えています');
});

test('T10 夜をまたぐ割付で 札の時刻が戻らない(窓で切る)', () => {
  /* 🚨 実測: いちばん遅い終わりが **翌日の 8:36** になり「11:14〜8:36」と時間が戻って見えていた。 */
  const night = boot({
    assignments: [
      A('尾田', 'L1', D(16, 0), D(17, 0)),
      A('尾田', 'L2', D(17, 0), D(8, 36) + 86400000),
    ],
  });
  const t = textOf(cardOf(night, '尾田'));
  assert.ok(!/〜8:36/.test(t), `札の時刻が翌日へ抜けています: ${t}`);
  assert.ok(/16:00〜17:15/.test(t), `札の時刻が窓で切られていません: ${t}`);
});
