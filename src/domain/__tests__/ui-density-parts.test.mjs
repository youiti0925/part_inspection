// 🧹 部品検査「分析／作業最適化」の帯が、また4段に積み上がらない為の見張り(2026-09-07)。
//
// 何があったか(本番・1366×768 で実測):
//   上のナビ(56px) + 「分析 / 作業最適化」(41px・中身14%) + 大分類(80px)
//   + 「月単位 / 期間指定」(46px・中身24%) + 小分類(30px) = 帯だけで 253px。
//   中身が始まるのは 284px(写しで実測)。画面(768px)の 37% が帯。
//
// 直した形(写しで実測 187px):
//   帯1 = [分析 | 作業最適化(親タブ)] │ 大分類 … 右端に 出力(Excel / PDF)
//   帯2 = 見出し + 小分類 … 右端に 月単位 / 期間指定
//
// 🚨 この見張りが守る事は3つ:
//   ① 帯が2本より増えていない(数える)
//   ② 札の名前・順番・押した時の行き先が1つも変わっていない(全部並べて突き合わせる)
//   ③ 畳んだ文言がソースに残っている(消していない)
// ⚠ 字面ではなく **数える**。コメントは codeOf が落とすので、コメント化で緑にはできない。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 分析画面のヘッダー(帯の置き場)だけを切り出す。範囲を先に切らないと同名の物を拾う。
const headerSlice = () => {
  const a = app.indexOf('<div data-band="analysis-header"');
  assert.ok(a >= 0, '分析画面のヘッダーの目印 data-band="analysis-header" が無い');
  const b = app.indexOf('<div className="flex-1 overflow-y-auto p-6">', a);
  assert.ok(b > a, 'ヘッダーの終わり(中身の入れ物)が見つからない');
  return app.slice(a, b);
};

test('UD1 分析画面のヘッダーの帯は 2本ちょうど(上のナビと合わせて3本)', () => {
  const h = headerSlice();
  const bands = [...h.matchAll(/data-band="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(bands, ['analysis-header', 'analysis-top', 'analysis-sub'],
    `帯の並びが違う: ${JSON.stringify(bands)} (入れ物1つ + 帯2本のはず)`);
});

test('UD2 大分類・小分類・月単位/期間指定・出力が、その2本の中に収まっている', () => {
  const h = headerSlice();
  const top = h.slice(h.indexOf('data-band="analysis-top"'), h.indexOf('data-band="analysis-sub"'));
  const sub = h.slice(h.indexOf('data-band="analysis-sub"'));
  // 帯1: 親タブ + 大分類 + 出力
  assert.ok(top.includes('{parentTabs}'), '帯1に親タブ(分析 | 作業最適化)が入っていない');
  assert.ok(top.includes('ANALYSIS_GROUPS.map('), '帯1に大分類が入っていない');
  // 🚨 2026-09-08 P3: 出力(Excel / PDF)は 帯1 の右端(ml-auto)から **帯2 の中へ移した**。
  //   帯2 は 本番の写し・1366×768 で 中身43%/50px(右に 732px の空き)だった。移した後は 64%。
  //   ⚠ ここを緩めていない: 「どちらかの帯に在れば良い」ではなく **帯2 に在って ml-auto を使っていない** 事を見る。
  assert.ok(!top.includes('flex gap-1 border rounded-lg overflow-hidden'), '出力(Excel / PDF)が帯1へ戻っている(帯2の右が 732px 空く)');
  assert.ok(sub.includes('flex gap-1 border rounded-lg overflow-hidden'), '帯2に出力(Excel / PDF)が入っていない');
  assert.ok(!sub.includes('ml-auto flex gap-1 border rounded-lg overflow-hidden'), '帯2の出力が ml-auto で右端へ飛んでいる(真ん中が空く)');
  assert.ok(sub.includes('<FileSpreadsheet className="w-3 h-3"/> Excel</button>'), '帯2から Excel の札が消えている');
  assert.ok(sub.includes('<Printer className="w-3 h-3"/> PDF</button>'), '帯2から PDF の札が消えている');
  // 帯2: 見出し + 小分類 + 月単位/期間指定
  assert.ok(sub.includes('activeGroup.tabs.filter('), '帯2に小分類が入っていない');
  assert.ok(sub.includes('{renderDefectFilterUI()}'), '帯2に 月単位 / 期間指定 が入っていない');
  assert.ok(/<h2 className="text-base font-bold/.test(sub), '帯2に見出しが入っていない');
  // 昔の「大分類の下にもう1段」の積み方が復活していない
  assert.ok(!h.includes('flex flex-col gap-1.5'), '大分類と小分類がまた縦に2段積みになっている');
  assert.ok(!h.includes('flex items-center justify-between'), '見出しと札を左右に離す古い1行が戻っている(帯が太る)');
});

test('UD3 「分析 / 作業最適化」だけの専用の帯を作らない(1か所で作って5か所で使う)', () => {
  const def = [...app.matchAll(/const renderTabGroupButtons = \(group\) =>/g)].length;
  assert.equal(def, 1, `親タブのボタンの作り方が ${def} か所(1か所のはず)`);
  const use = [...app.matchAll(/renderTabGroupButtons\(/g)].length; // 定義は `= (group) =>` の形なので、ここには数えられない
  // 🚨 2026-09-08: 3 → 4 へ。検査リストでも 親タブ(検査リスト | 完了履歴)を絞り込みの行へ合流させたので、
  //   使う所が1つ増えた(単独の帯・分析・作業最適化・検査リスト)。**作り方は1か所のまま** なので
  //   札の名前・順番・押した時の行き先は割れない。⚠ ここを「以上」に緩めない。増やす時は理由を書いてこの数を直す。
  // 🚨 2026-09-08(その2): 4 → 5 へ。マスタ設定でも 親タブ(マスタ設定 | 工程テンプレート | 測定設定)を
  //   中身の一番上の見出しの行へ合流させた(写しの実測で 39px・中身24% の帯だった)。
  //   これで使う所は 単独の帯・分析・作業最適化・検査リスト・マスタ設定 の5か所。作り方は1か所のまま。
  //   ⚠ 工程テンプレート・測定設定 の2画面は今までどおり単独の帯で出す(合流先の見出しがその2つに無い)。
  //   見張り: ui-density-parts-settings.test.mjs S-9。
  assert.equal(use, 5, `親タブのボタンを使っている所が ${use} か所(単独の帯・分析・作業最適化・検査リスト・マスタ設定 の5か所のはず)`);
  // 分析・作業最適化・検査リスト・マスタ設定 では、単独の帯は出さない(下の帯・下の行へ合流している)
  assert.ok(app.includes("if (activeTab === 'optimize') return null;"), '作業最適化で単独の帯を止めていない(帯が1本増える)');
  assert.ok(app.includes("if (activeTab === 'analysis' && analysisDataReady && !quotaBlock) return null;"),
    '分析で単独の帯を止めていない、または「合流先が描かれない時は出す」条件(analysisDataReady / quotaBlock)が抜けている');
  assert.ok(app.includes("if (activeTab === 'inspection') return null;"), '検査リストで単独の帯を止めていない(帯が1本増える)');
  assert.ok(app.includes("if (activeTab === 'templates') return null;"), 'マスタ設定で単独の帯を止めていない(帯が1本増える)');
  // 🚨 行き先を消さない: 合流先(AnalysisView / InspectionListView / TemplatesView)へ親タブを渡している
  assert.ok(app.includes('parentTabs={renderTabGroupButtons(TAB_GROUPS.analysis)}'), '分析画面へ親タブを渡していない(押す先が消える)');
  assert.ok(app.includes('parentTabs={renderTabGroupButtons(TAB_GROUPS.inspection)}'), '検査リスト画面へ親タブを渡していない(押す先が消える)');
  assert.ok(app.includes('parentTabs={renderTabGroupButtons(TAB_GROUPS.templates)}'), 'マスタ設定画面へ親タブを渡していない(工程テンプレート・測定設定へ行く道が消える)');
});

test('UD4 🚨 札の名前・順番・押した時の行き先が1つも変わっていない', () => {
  const a = app.indexOf('const ANALYSIS_GROUPS = [');
  assert.ok(a >= 0, 'ANALYSIS_GROUPS が無い');
  const g = app.slice(a, app.indexOf('\n];', a));
  const labels = [...g.matchAll(/label: '([^']*)'/g)].map((m) => m[1]);
  const subs = [...g.matchAll(/\bl: '([^']*)'/g)].map((m) => m[1]);
  const keys = [...g.matchAll(/\bk: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    '① データを正す', '② 現状を見る', '③④ 改善（計画→実行→効果）', '⑤ 基準を固める（定着）', '人・配分', '記録・出力',
  ], '大分類の札の名前か順番が変わっている');
  assert.deepEqual(subs, [
    '要確認（異常値・該当なし）',
    '工程分析（データを見る）', '達成率', '不具合分析', '軽微不良・改善提案', 'ダッシュボード', '経営分析',
    '改善PDCA（重点工程→対策→効果）', 'AI洞察・乖離アラート',
    '目標時間・厳密モードへ',
    '作業者評価', '直間分析',
    '月次レポート', '点検・バックアップ', 'データ書き出し',
  ], '小分類の札の名前か順番が変わっている');
  assert.deepEqual(keys, [
    'anomaly',
    'process-analysis', 'achievement', 'defects', 'complaints', 'dashboard', 'kpi',
    'pdca', 'improvement',
    'standardize',
    'worker-eval', 'direct-indirect',
    'monthly', 'audit', 'export',
  ], '札を押した時の行き先が変わっている');
  // 親タブ(分析 | 作業最適化)も同じく
  const t = app.indexOf('const TAB_GROUPS = {');
  const tg = app.slice(t, app.indexOf('\n   };', t));
  const aStart = tg.indexOf('analysis: [');
  const analysisPair = tg.slice(aStart, tg.indexOf(']', aStart));
  assert.deepEqual([...analysisPair.matchAll(/id: '([^']*)', label: '([^']*)'/g)].map((m) => [m[1], m[2]]),
    [['analysis', '分析'], ['optimize', '作業最適化']], '親タブの名前・順番・行き先が変わっている');
});

test('UD5 帯の中の文字は 12px 以上・大きすぎる文字を置かない', () => {
  const h = headerSlice();
  const tooBig = [...h.matchAll(/text-(2xl|3xl|4xl|5xl)\b/g)].map((m) => m[0]);
  assert.deepEqual(tooBig, [], `帯の中に大きすぎる文字がある: ${tooBig.join(', ')}`);
  const px = [...h.matchAll(/text-\[(\d+)px\]/g)].map((m) => Number(m[1]));
  assert.deepEqual(px.filter((n) => n < 12), [], `帯の中に 12px 未満の文字がある: ${px.join(', ')}`);
  assert.deepEqual(px.filter((n) => n >= 26), [], `帯の中に 26px 以上の直書きがある: ${px.join(', ')}`);
});

test('UD6 帯の縦の余白がまた太らない(py-4 / gap-3 に戻さない)', () => {
  const h = headerSlice();
  const head = h.slice(0, h.indexOf('data-band="analysis-top"'));
  assert.match(head, /px-6 py-2 flex flex-col gap-2/, 'ヘッダーの余白が太っている(py-2 / gap-2 のはず)');
});

test('UD7 🚨 畳んだ文言はソースに残っている(消していない)', () => {
  // 作業最適化の説明文は ？ の中へ畳んだ。1文字も消していない事を字で確かめる。
  assert.ok(app.includes('データから現場を最適化：<b>目標時間</b>→<b>厳密モード</b>→<b>スキル</b>。将来は空き人材・エリアから自動配置の土台に。'),
    '作業最適化の説明文が消えている');
  assert.ok(app.includes('<details className="relative">'), '説明文を畳む ？ が無い(畳まずに消したか、行を1本増やしている)');
  // 見出し15本(activeMode ごと)がそのまま残っている
  const h = headerSlice();
  const titles = [...h.matchAll(/activeMode === '([a-z-]+)' && \(<>/g)].map((m) => m[1]);
  assert.equal(titles.length, 15, `見出しが ${titles.length} 本(15本のはず。1つでも減らしてはいけない)`);
});

test('UD8 作業最適化の帯にも親タブを合流させ、専用の行を作らない', () => {
  const a = app.indexOf('<div data-band="optimize-top"');
  assert.ok(a >= 0, '作業最適化の帯の目印が無い');
  const bar = app.slice(a, a + 1200);
  assert.ok(bar.includes('renderTabGroupButtons(TAB_GROUPS.analysis)'), '作業最適化の帯に親タブが入っていない');
  assert.ok(bar.includes("setOptimizeView('target')"), '作業最適化の帯に小分類(目標時間最適化…)が入っていない');
});
