// 🗺 P-L7/F2①(2026-09-27 製品と同じ直し): ③の🔎工場別・モニターの埋め込み(?embed=map)は地図だけを見せる読むだけの画面。
//   製品の所見: ?embed=map でも購読を1本も止めず、地図に出ない棚まで毎回読んでいた。
//   部品で当てはまるのは観測プラン(observationPlans)と、2026-10-03(A15)に足した要望箱(app_feedback)だけ:
//     ・製品が外した制御装置の4つ(controllers・order_motors・motor_ledger・spare_motors)は部品に無い。
//     ・軽微不良の台帳(minor_reports)・星取表の印(skill_marks)は部品では既に「開いた時だけ読む」(useLazyCollection)。
//   ここで見張る事:
//     EM-1 観測プランは EMBED_MAP の時だけ外れている(普段の画面では今までどおり張る)
//     EM-2 外した棚の中身が **地図(MapOnlyView)に渡っていない**(渡すように変えたら赤 = 購読を戻す合図)
//     EM-3 地図・埋め込みで動く物が使う棚(ロット・テンプレ・作業者・設定・メモ・お知らせ ほか)は外していない
//     EM-4 埋め込みでは観測プランを「張った」とも残さない(数えと購読を揃える)
//   壊し方: EMBED_MAP の枠を消す → EM-1 赤 / MapOnlyView に observationPlans を渡す → EM-2 赤 / templates を枠へ入れる → EM-3 赤。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const app = codeOf(path.join(ROOT, 'src', 'App.jsx'));

// 主の購読の効果(--- Data Sync ---)の中身だけを見る
const syncStart = app.lastIndexOf('if (LIVE_CODE) return;', app.indexOf("P.watchCollection(APP_DATA_ID, 'templates'"));
// 2026-10-01: 枠切れの後の張り直しの合図(readRetryToken)を依存に足した
const syncEnd = app.indexOf('}, [user, db, countReads, noteReadError, readRetryToken]);', syncStart);
const sync = app.slice(syncStart, syncEnd);

/** `...(EMBED_MAP ? [] : [` から、対になる `])` までを全部集める。 */
const embedBlocks = (() => {
  const out = [];
  let i = 0;
  const open = '...(EMBED_MAP ? [] : [';
  while ((i = sync.indexOf(open, i)) >= 0) {
    let depth = 0, j = i + open.length - 1;
    for (; j < sync.length; j++) {
      if (sync[j] === '[') depth++;
      else if (sync[j] === ']') { depth--; if (depth === 0) break; }
    }
    out.push(sync.slice(i, j + 1));
    i = j;
  }
  return out;
})();
const inEmbedBlock = (needle) => embedBlocks.some((b) => b.includes(needle));

const DROPPED = [
  ["watch('observationPlans'", 'observationPlans'],
  // 📉 2026-10-03 A15: 要望箱(app_feedback)も埋め込みでは張らない(最終 2026-09-27 G5 と同じ)。
  //   使うのは要望のタブ・要望の窓・札の数・連絡ポータルだけで、どれも埋め込みでは出ない。
  ['P.watchCollection(CONTACT_SHARED_NS, FEEDBACK_COL', 'appFeedback'],
];

test('EM-1 外した棚は EMBED_MAP の時だけ外れている(普段は今までどおり張る)', () => {
  assert.ok(syncStart > 0 && syncEnd > syncStart, '主の購読の効果が見つからない');
  assert.ok(embedBlocks.length >= 1, 'EMBED_MAP で外す枠が無い');
  for (const [needle] of DROPPED) {
    assert.ok(sync.includes(needle), `${needle} の購読そのものが無くなっている(普段の画面から消える)`);
    assert.ok(inEmbedBlock(needle), `${needle} が EMBED_MAP の枠の外に居る(埋め込みでも読む)`);
  }
});

test('EM-2 外した棚の中身は地図(MapOnlyView)に渡っていない', () => {
  const at = app.indexOf("{viewMode === 'map-only' && <MapOnlyView");
  const mapTag = app.slice(at, app.indexOf('/>}', at));
  assert.ok(at > 0 && mapTag.length > 50, 'MapOnlyView を出す所が見つからない');
  for (const [, state] of DROPPED) {
    assert.ok(!new RegExp(`\\b${state}\\b`).test(mapTag), `地図に ${state} を渡している → 埋め込みでも購読を戻すこと`);
  }
  const d0 = app.indexOf('const MapOnlyView = (');
  const def = app.slice(d0, app.indexOf('=>', d0));
  for (const [, state] of DROPPED) assert.ok(!new RegExp(`\\b${state}\\b`).test(def), `MapOnlyView が ${state} を受け取る形になっている`);
});

test('EM-3 地図・埋め込みで動く物が使う棚は外していない', () => {
  const KEPT = [
    "P.watchCollection(APP_DATA_ID, 'templates'",
    "P.watchCollection(APP_DATA_ID, 'workers'",
    "P.watchDoc(APP_DATA_ID, 'settings', 'config'",
    "watch('notes'",                // ヘッダーのバッジ
    "watch('announcements'",
    "watch('model_templates'",
    "watch('video_recipes'",
    'DIAGRAM_COLLECTION',           // ロットの測定図の札を戻す(保存の形に関わる)
    'NOTICE_COL',                   // 「アプリを更新しました」の窓は埋め込みの中でも出る(最終も外していない)
  ];
  for (const k of KEPT) {
    assert.ok(sync.includes(k), `${k} の購読が見つからない`);
    assert.ok(!inEmbedBlock(k), `${k} を埋め込みで外している(地図か、埋め込みで動く処理が使う)`);
  }
  // ロットの普段の窓は別の効果。埋め込みでも今までどおり張る(EMBED_MAP で止めていない)。
  const live = app.indexOf("{ orderBy: [['createdAt', 'desc']], limit: LOTS_LIVE_LIMIT, includeMetadataChanges: true");
  assert.ok(live > 0, 'ロットの普段の窓が見つからない');
  const liveEff = app.slice(app.lastIndexOf('useEffect(() => {', live), live);
  assert.ok(!liveEff.includes('EMBED_MAP'), 'ロットの普段の窓を埋め込みで止めている(地図が空になる)');
});

test('EM-4 観測プランを「張った」と残すのも埋め込みの時は外す(数えと購読を揃える)', () => {
  assert.ok(sync.includes("...(EMBED_MAP ? [] : ['observationPlans'])"), '張っていない観測プランを「張った」と残している');
});

test('EM-5 要望箱(appFeedback)を使う所は、埋め込みでは出ない所だけ(増えたら赤 = 埋め込みでも要るか見直す合図)', () => {
  // 使ってよい所: 札の数(タブの帯・埋め込みでは地図が全面を覆う) / 連絡ポータル(?renraku=1) / 要望のタブ / 要望の窓(押して開く・押す所は埋め込みに無い)
  const ALLOWED = [
    /openFeedbackCount\(appFeedback\)/,
    /appFeedback=\{appFeedback\} appNotices=\{appNotices\}/,  // ContactPortal(RENRAKU_PORTAL の時だけ描く)
    /^items=\{appFeedback\}$/,                               // FeedbackList(要望のタブ) / FeedbackModal(押して開く)
    /const \[appFeedback, setAppFeedback\] = useState\(\[\]\);/,
  ];
  const uses = app.split('\n').map((l) => l.trim()).filter((l) => /\bappFeedback\b/.test(l) && !/from '\.\/domain\/appFeedback\.js'/.test(l));
  const odd = uses.filter((l) => !ALLOWED.some((re) => re.test(l)));
  assert.deepEqual(odd, [], '要望箱を新しい所で使っている → 埋め込み(?embed=map)で出るなら、A15 の購読外しを戻すこと');
  assert.equal(uses.filter((l) => /^items=\{appFeedback\}$/.test(l)).length, 2, '要望のタブと要望の窓の2か所のはず');
  // 同じ行の中で使い方を足した時も拾う(宣言1・札の数2・ポータル2・タブと窓2 = 7)
  const n = uses.reduce((a, l) => a + (l.match(/\bappFeedback\b/g) || []).length, 0);
  assert.equal(n, 7, `appFeedback を使う数が変わった(${n})→ 埋め込みでも要るか見直すこと`);
  // 要望の窓は押した時だけ開き、押す所(ヘッダの💡・要望のタブ)は埋め込みでは描かない
  assert.match(app, /\{!EMBED_MAP && \(\s*<div className=\{`\$\{chromeBoxCls\} z-50`\}[^]*?setFeedbackOpen\(true\)/, 'ヘッダの💡(要望の窓を開く所)が埋め込みの枠の外に出た');
});
