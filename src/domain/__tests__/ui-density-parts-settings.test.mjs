// =============================================================================
// 🧹 部品検査「マスタ設定・全体進捗の帯が、また1つの物のために横幅を丸ごと使う」を
//    二度と作らない為の見張り(2026-09-08)。
// -----------------------------------------------------------------------------
// 何があったか(写しを 1366×768 で測った実測。測った道具 = _ui01_survey.mjs):
//   前の担当は「無駄0本」と報告したが、その道具は **決め打ちの札の一覧** を使っていて、
//   名前が合わない画面を黙って素通りしていた。道具を直して測り直したら
//   現場マップ・全体進捗・マスタ設定 が **1枚も測られていなかった** と分かり、帯が11本残っていた:
//
//     画面        帯                                          中身   高さ
//     全体進捗    作業者ロスターの表                          24%   188px
//     マスタ設定  全てリセット                                10%    45px
//     マスタ設定  作業エリア設定(見出しだけの行)              16%    31px
//     マスタ設定  全設定を保存する                            19%    52px
//     マスタ設定  取り消し猶予時間 / 秒                       23%    46px
//     マスタ設定  マスタ設定 / 工程テンプレート / 測定設定    24%    39px
//     マスタ設定  最小表示 (5項目) / 全表示 (デフォルト)      26%    33px
//     マスタ設定  新しいエリアを追加 / 自動タイル配置         32%    39px
//     マスタ設定  太さ / 24（画面内 約12px）                  43%    35px
//     マスタ設定  💡 規格の名前付けのコツ: …                  51%    78px
//     マスタ設定  前班 / 設計 / 調達 / 機械                   51%    37px
//   ⚠「登録」の画面にも同じ10本が出ていたが、これはマスタ設定と同じ物を見ているだけ。
//
// 直し方は 設計「画面の無駄を全部なくす」の 決まり1・2・3・6 のとおり4つだけ:
//   畳む(details) / 移す / 小さくする / 絵にする。**消した物は1つも無い。**
//
// 🚨 この見張りが守る事(全部「数える」。字面の有る無しだけでは緑にしない):
//   S-1  💡 規格の名前付けのコツ は details に畳んである。中の3行は1文字も消えていない
//   S-2  不具合原因工程マスタの「入れる所」と「登録済みの札」が同じ1行に居る
//   S-3  操作取り消し設定の 見出し・入れる所・説明 が同じ1行に居る
//   S-4  ゲージの「太さ」の行に「うっすら下地」が並んでいる(部品は1つだけ)
//   S-5  「全てリセット」は文字サイズ設定の見出しの行に1つだけ在る(専用の行を作らない)
//   S-6  「最小表示 (5項目)」「全表示 (デフォルト)」は見出しの行に在る(専用の行を作らない)
//   S-7  「作業エリア設定」の見出しと 押す物2つ が同じ1行に居る
//   S-8  「全設定を保存する」の行に、何が保存されるかの説明が同じ行で並んでいる
//   S-9  マスタ設定では 親タブ(マスタ設定|工程テンプレート|測定設定)が中身の見出しの行へ合流している
//   S-10 作業者ロスターの表の **右** に 読み方の文と凡例が並んでいる(表の上下へ戻していない)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ S-0 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回確かめる(ソースには1バイトも書かない)。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 目印から目印までを切り出す。範囲を先に切らないと、同じ言い方の別の部品を拾う。
const between = (code, from, to, why) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `${why}: 始まりの目印 ${from} がソースに無い`);
  const b = code.indexOf(to, a + from.length);
  assert.ok(b > a, `${why}: 終わりの目印 ${to} が見つからない`);
  return code.slice(a, b);
};
const after = (code, from, len, why) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `${why}: 目印 ${from} がソースに無い`);
  return code.slice(a, a + len);
};
const count = (code, needle) => code.split(needle).length - 1;

// マスタ設定の画面(TemplatesView)の中だけを切る。
const templatesView = (code) => between(code, 'const TemplatesView = ({ editingTemplate', 'const WorkOrderOptimizerModal = (', 'マスタ設定の画面');
// 作業者ロスターの部品だけを切る。
const roster = (code) => between(code, 'const WorkerRosterPanel = ({ workers = []', 'const ProgressOverviewView = ({', '作業者ロスター');

// 💡 の中へ畳んだ文。1文字でも消えたら赤。
const TIPS_FOLDED = [
  '規格の名前付けのコツ',
  ': 「どんな製品群か」「どんな仕様か」が後で見て分かる名前を。',
  '「RT系 標準仕様」',
  '「特注パターンA」',
  '「RBS 高精度モデル」',
  '「KIT-22 改定3」',
  '規格番号は社内番号 (例: ',
  'QS-001',
  ') や 図面番号 / 仕様書番号 をそのまま流用してOK。',
];

export const CHECKS = {
  // ── S-1 💡 規格の名前付けのコツ は details に畳む。文は1文字も消さない ──
  S1: (code) => {
    assert.equal(count(code, '<details data-fold="qs-naming-tips"'), 1,
      '💡 規格の名前付けのコツ の details が無い(または2つ在る)');
    const det = between(code, '<details data-fold="qs-naming-tips"', '</details>', '💡 のコツ');
    assert.ok(det.includes('<summary'), '💡 のコツに summary(閉じている時の1行)が無い');
    for (const s of TIPS_FOLDED) {
      assert.ok(det.includes(s), `💡 のコツから文が消えている: 「${s}」`);
    }
    // 畳む前の「ただの div」へ戻していない
    assert.ok(!code.includes('<div className="bg-amber-50 border border-amber-200 rounded p-2 mb-4 text-[11px] text-amber-800">'),
      '💡 のコツが畳む前の div へ戻っている(78px・中身51%の帯が復活する)');
  },

  // ── S-2 不具合原因工程マスタ: 入れる所と登録済みの札が同じ1行 ──
  S2: (code) => {
    const v = templatesView(code);
    const row = between(v, '<div className="flex gap-2 items-start flex-wrap mb-1">', '軽微不良・改善提案の選択肢マスタ', '不具合原因工程マスタの1行');
    assert.ok(row.includes('placeholder="新しい原因工程名"'), '原因工程を入れる所が この行に居ない');
    assert.ok(row.includes('{defectProcessOptions.map((opt, idx) => ('), '登録済みの札が この行に居ない(37px・中身51%の行へ戻る)');
    assert.ok(/flex-1 min-w-\[200px\]/.test(row), '札の一覧が flex-1 で右を埋めていない(帯の右が空く)');
    assert.ok(row.includes('saveSettings({ defectProcessOptions: updated });'), '原因工程の保存の行き先が消えている');
    assert.ok(row.includes('const updated = defectProcessOptions.filter((_, i) => i !== idx);'), '原因工程を消す働きが消えている');
    // 元の「入れる所だけの行」へ戻していない
    assert.ok(!/<div className="flex gap-2 mb-4">\s*<input\s*\n\s*value=\{newProcessOpt\}/.test(v),
      '入れる所だけの行が復活している');
  },

  // ── S-3 操作取り消し設定: 見出し・入れる所・説明が同じ1行 ──
  S3: (code) => {
    const v = templatesView(code);
    const row = after(v, '<h3 className="text-base font-bold">操作取り消し設定</h3>', 900, '操作取り消し設定の行');
    assert.ok(row.includes('取り消し猶予時間'), '「取り消し猶予時間」が見出しと同じ行に居ない');
    assert.ok(row.includes('ボタン押し間違い時に、この秒数以内であれば取り消しが可能です'),
      '説明文が見出しと同じ行に居ない(または消えている)');
    // 説明は右の空きを埋める(flex-1)。埋めないと 46px・中身23% の帯へ逆戻り。
    const p = between(row, '<p className="text-xs text-slate-400', '</p>', '取り消し猶予の説明');
    assert.ok(/flex-1/.test(p), '取り消し猶予の説明が flex-1 で右を埋めていない(帯の右が空く)');
    // 保存の行き先は変えていない
    assert.ok(row.includes('saveSettings({ undoTimeout: parseInt(e.target.value) || 5 })'),
      '取り消し猶予時間の保存の行き先が変わっている');
    // 説明を別の行へ戻していない
    assert.ok(!v.includes('<p className="text-xs text-slate-400 mt-2">ボタン押し間違い時に'),
      '取り消し猶予の説明が専用の行へ戻っている');
  },

  // ── S-4 ゲージの「太さ」の行に「うっすら下地」が並んでいる ──
  S4: (code) => {
    const v = templatesView(code);
    assert.equal(count(v, 'うっすら下地'), 1, '「うっすら下地」が2つ在る(または消えている)');
    const row = between(v, '<span className="text-xs font-bold text-slate-600 w-32">太さ</span>', '</div>', '太さの行');
    assert.ok(row.includes('うっすら下地'), '「うっすら下地」が「太さ」の行に並んでいない(35px・中身43%の帯へ戻る)');
    assert.ok(row.includes('枠の全周を薄く表示して「どこまで塗られるか」を見せる'),
      'うっすら下地の説明文が消えている');
    assert.ok(row.includes('setOA({ gaugeTrack: e.target.checked })'), 'うっすら下地の働き(gaugeTrack)が消えている');
    assert.ok(row.includes('setOA({ gaugeWidth: Number(e.target.value) })'), '太さの働き(gaugeWidth)が消えている');
    assert.ok(/flex-1/.test(row), '太さの行の右が埋まっていない(flex-1 が無い)');
  },

  // ── S-5 「全てリセット」は見出しの行に1つだけ ──
  S5: (code) => {
    const v = templatesView(code);
    assert.equal(count(v, '全てリセット'), 1, '「全てリセット」が2つ在る(または消えている)');
    const head = between(v, '<Type className="w-5 h-5 text-blue-600" /> 文字サイズ設定</h3>', '<div className="mb-4 p-3 bg-blue-50/50', '文字サイズ設定の見出しの行');
    assert.ok(head.includes('全てリセット'), '「全てリセット」が文字サイズ設定の見出しの行に居ない(45px・中身10%の行へ戻る)');
    assert.ok(head.includes('各エリアの文字サイズを調整できます（100%が標準）'), '文字サイズ設定の説明文が消えている');
    assert.ok(head.includes('FONT_SIZE_AREAS.forEach(a => { reset[a.key] = 100; });'),
      '「全てリセット」の働き(全部100%に戻す)が消えている');
    assert.ok(!v.includes('<div className="mt-4 pt-3 border-t flex justify-end">'),
      '「全てリセット」の専用の行が復活している');
  },

  // ── S-6 「最小表示 (5項目)」「全表示 (デフォルト)」は見出しの行 ──
  S6: (code) => {
    const v = templatesView(code);
    assert.equal(count(v, '最小表示 (5項目)'), 1, '「最小表示 (5項目)」が2つ在る(または消えている)');
    assert.equal(count(v, '全表示 (デフォルト)'), 1, '「全表示 (デフォルト)」が2つ在る(または消えている)');
    const head = between(v, '<LayoutGrid className="w-5 h-5 text-blue-600" /> ロットカード 表示項目', '{(() => {', 'ロットカード 表示項目の見出しの行');
    assert.ok(head.includes('最小表示 (5項目)') && head.includes('全表示 (デフォルト)'),
      '押す物2つが見出しの行に居ない(33px・中身26%の行へ戻る)');
    assert.ok(head.includes('OFF にした項目は表示されなくなり、カードがコンパクトになります。'), '説明文が消えている');
    assert.ok(head.includes('lotCardDisplay: { ...DEFAULT_LOT_CARD_DISPLAY }'), '「全表示」の行き先が消えている');
    assert.ok(head.includes("progressBar: true, templateName: false"), '「最小表示」の行き先(5項目の中身)が変わっている');
    assert.ok(!v.includes('<div className="flex gap-2 justify-end">'), '押す物2つの専用の行が復活している');
  },

  // ── S-7 「作業エリア設定」の見出しと押す物2つが同じ1行 ──
  S7: (code) => {
    const v = templatesView(code);
    const row = between(v, '<MapIcon className="w-6 h-6 text-blue-600" /> 作業エリア設定</h3>', '<div className="space-y-3">', '作業エリア設定の見出しの行');
    assert.ok(row.includes('新しいエリアを追加'), '「新しいエリアを追加」が見出しの行に居ない');
    assert.ok(row.includes('自動タイル配置'), '「自動タイル配置」が見出しの行に居ない');
    assert.ok(row.includes('onClick={handleAddZone}'), '「新しいエリアを追加」の行き先が消えている');
    assert.ok(row.includes('onClick={handleAutoArrangeZones}'), '「自動タイル配置」の行き先が消えている');
    assert.ok(row.includes('title="全エリアを自動でタイル詰め配置 (重なり解消)"'), '自動タイル配置の説明(title)が消えている');
    // 右端が空かないように、いま何エリア在るかを置いてある
    assert.ok(/ml-auto[^>]*>エリア \{localZones\.length\} 個/.test(row),
      '見出しの行の右端が空いている(エリアの数の札が無い)');
    assert.ok(!v.includes('<div className="flex justify-between items-center mb-6">'),
      '見出しだけの行(31px・中身16%)が復活している');
    assert.ok(!v.includes('<div className="mb-6 flex gap-2 flex-wrap">'),
      '押す物2つだけの行(39px・中身32%)が復活している');
  },

  // ── S-8 「全設定を保存する」の行に、何が保存されるかを並べる ──
  S8: (code) => {
    const v = templatesView(code);
    assert.equal(count(v, '全設定を保存する</button>'), 1, '「全設定を保存する」の押す物が2つ在る(または消えている)');
    const row = between(v, '<div data-band="settings-save"', '全設定を保存する</button>', '全設定を保存するの行');
    assert.ok(row.includes('この1つで '), '何が保存されるかの説明が同じ行に無い(52px・中身19%の行へ戻る)');
    assert.ok(/flex-1/.test(row), '説明が flex-1 で左を埋めていない(押す物の左が8割空く)');
    // 🚨 押す物と行き先は1ミリも変えていない
    assert.ok(v.includes('<button onClick={handleSaveZoneSettings} className="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold shadow-lg hover:bg-blue-700 flex items-center gap-2"><Save className="w-5 h-5" /> 全設定を保存する</button>'),
      '「全設定を保存する」の押す物か行き先が変わっている');
    assert.ok(v.includes("saveSettings({ mapZones: localZones, breakAlerts: localBreakAlerts, complaintOptions: newComplaintOptions, comboPresets: localComboPresets, voiceSettings: localVoiceSettings, voiceCommands: localVoiceCommands });"),
      '「全設定を保存する」が保存する中身が変わっている');
    assert.ok(!/<div className="flex justify-end">\s*<button onClick=\{handleSaveZoneSettings\}/.test(v),
      '押す物だけの行が復活している');
  },

  // ── S-9 マスタ設定では 親タブが中身の見出しの行へ合流している ──
  S9: (code) => {
    // App 側: マスタ設定の時は帯を出さない
    assert.ok(code.includes("if (activeTab === 'templates') return null;"),
      'マスタ設定でも親タブの帯を別に出している(39px・中身24%の帯が残る)');
    // 帯の作り方は1か所のまま。渡す先が在る
    assert.ok(code.includes('parentTabs={renderTabGroupButtons(TAB_GROUPS.templates)}'),
      'マスタ設定の画面へ親タブを渡していない(工程テンプレート・測定設定へ行く道が消える)');
    // 受け取って描いている
    const v = templatesView(code);
    assert.ok(v.includes('parentTabs = null }) => {'), 'マスタ設定の画面が parentTabs を受け取っていない');
    assert.equal(count(v, '{parentTabs}'), 1, 'parentTabs を描いている所が1つでない');
    const head = between(v, '<div className="flex items-center gap-2 flex-wrap mb-2">', '</div>', 'マスタ設定の一番上の見出しの行');
    assert.ok(head.includes('作業者マスタ'), '親タブが一番上の見出し(作業者マスタ)の行に合流していない');
    assert.ok(head.includes('{parentTabs}'), '親タブが一番上の見出しの行に無い');
    // 札の名前・順番は1つも変えていない
    assert.ok(code.includes("{ id: 'templates', label: 'マスタ設定', icon: Settings },\n       { id: 'template-mgr', label: '工程テンプレート', icon: ClipboardList },\n       { id: 'measurement-settings', label: '測定設定', icon: Ruler },"),
      '親タブの札の名前か順番が変わっている');
    // 工程テンプレート・測定設定 は今までどおり帯で出す(合流先の画面がその2つには無い)
    assert.ok(!code.includes("if (activeTab === 'template-mgr') return null;"),
      '工程テンプレートの画面から、行き先の帯まで消している');
    assert.ok(!code.includes("if (activeTab === 'measurement-settings') return null;"),
      '測定設定の画面から、行き先の帯まで消している');
  },

  // ── S-10 作業者ロスター: 表の右に 読み方の文と凡例 ──
  S10: (code) => {
    const r = roster(code);
    const row = between(r, '<div className="flex items-start gap-4 flex-wrap">', '</table>', 'ロスターの表の行');
    assert.ok(row.includes('<div className="overflow-x-auto shrink-0 max-w-full">'),
      '表が横に伸びる箱のままで、右へ並べる形になっていない');
    const rightCol = between(r, '<div className="flex-1 min-w-[240px] flex flex-col gap-2">', '</div>\n      </div>', 'ロスターの右の列');
    assert.ok(rightCol.includes('休み・他工場（製品/最終を掛け持つ人が今日は別工場）の人を外して、'),
      '読み方の文が表の右に並んでいない(または消えている)');
    assert.ok(rightCol.includes('その日に本当にこの工場で使える人数'), '読み方の文の太字が消えている');
    assert.ok(rightCol.includes('下のキャパ計算もこの在席人数を使います。'), '読み方の文の後半が消えている');
    for (const s of ['出勤', '休み', '他工場（共有作業者が今日は別工場）',
      '※ 将来の統合管理アプリでは、この配置がそのまま「今日 誰がどの工場」になります。']) {
      assert.ok(rightCol.includes(s), `凡例が表の右から消えている: 「${s}」`);
    }
    // 文字で幅を埋める箱には印が要る(測る道具が「中身が少ない」と読み違えない為)
    assert.equal(count(rightCol, 'data-textfill="1"'), 2, '右の列の2つの文の箱に data-textfill の印が無い');
    // 表の中身と押す所は1つも変えていない
    assert.ok(r.includes('<th className="px-2 py-1 text-left font-bold sticky left-0 bg-white z-10">作業者</th>'), 'ロスターの表の見出しが変わっている');
    assert.ok(r.includes('onClick={() => cycle(ymd, w)}'), 'ロスターのセルを押した時の働きが消えている');
    assert.ok(r.includes('在席'), 'ロスターの「在席」の行が消えている');
    // 表の上・下へ戻していない
    assert.ok(!r.includes('<div className="text-[11px] text-slate-500 mb-2">休み・他工場'),
      '読み方の文が表の上へ戻っている(表の右が 4分の3 空く)');
    assert.ok(!r.includes('<div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500 flex-wrap">'),
      '凡例が表の下へ戻っている(表の右が 4分の3 空く)');
  },
};

const TITLES = {
  S1: '💡 規格の名前付けのコツ は details に畳む(文は1文字も消さない)',
  S2: '不具合原因工程マスタ: 入れる所と登録済みの札が同じ1行',
  S3: '操作取り消し設定: 見出し・入れる所・説明が同じ1行',
  S4: 'ゲージの「太さ」の行に「うっすら下地」が並んでいる',
  S5: '「全てリセット」は文字サイズ設定の見出しの行に1つだけ',
  S6: '「最小表示 (5項目)」「全表示 (デフォルト)」は見出しの行',
  S7: '「作業エリア設定」の見出しと押す物2つが同じ1行',
  S8: '「全設定を保存する」の行に 何が保存されるかが並ぶ',
  S9: 'マスタ設定では親タブが中身の見出しの行へ合流している',
  S10: '作業者ロスター: 表の右に 読み方の文と凡例が並ぶ',
};

// ---------------------------------------------------------------------------
// S-0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行(札・文)を消す ②値・書き方を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['S1', '③ 💡 のコツを畳む前の div へ戻す', (s) => s
    .replace('<details data-fold="qs-naming-tips" className="bg-amber-50 border border-amber-200 rounded p-2 mb-4 text-[11px] text-amber-800">',
      '<div className="bg-amber-50 border border-amber-200 rounded p-2 mb-4 text-[11px] text-amber-800">')],
  ['S1', '① 畳んだ文を1つ消す', (s) => s.replace(') や 図面番号 / 仕様書番号 をそのまま流用してOK。', '')],
  ['S2', '③ 入れる所と札を別々の行へ戻す', (s) => s
    .replace('<div className="flex gap-2 items-start flex-wrap mb-1">', '<div className="flex gap-2 mb-4">\n             <input\n               value={newProcessOpt}')],
  ['S2', '② 札の一覧から flex-1 を外す(右が空く)', (s) => s
    .replace('<div className="flex flex-wrap gap-2 items-center flex-1 min-w-[200px]">', '<div className="flex flex-wrap gap-2 items-center">')],
  ['S3', '① 取り消し猶予の説明文を消す', (s) => s
    .replace('ボタン押し間違い時に、この秒数以内であれば取り消しが可能です', '')],
  ['S3', '② 説明の flex-1 を外す(右が空く)', (s) => s
    .replace('<p className="text-xs text-slate-400 flex-1 min-w-[200px]">ボタン押し間違い時に',
      '<p className="text-xs text-slate-400">ボタン押し間違い時に')],
  ['S4', '① 「うっすら下地」を消す', (s) => s
    .replace('<span className="text-xs font-bold text-slate-600">うっすら下地</span>', '')],
  ['S4', '③ 「うっすら下地」を別の行へ戻す', (s) => s
    .replace('<label className="flex items-center gap-2 cursor-pointer flex-1 min-w-[220px]">',
      '</div>\n                       <label className="flex items-center gap-2 cursor-pointer">')],
  ['S5', '③ 「全てリセット」を専用の行へ戻す', (s) => s
    .replace('<div className="flex items-center gap-2 flex-wrap mb-3">\n             <h3 className="text-base font-bold flex items-center gap-2"><Type',
      '<div className="mt-4 pt-3 border-t flex justify-end">\n             <h3 className="text-base font-bold flex items-center gap-2"><Type')],
  ['S5', '① 「全てリセット」の札を消す', (s) => s.replace('<Undo2 className="w-3 h-3" /> 全てリセット', '')],
  ['S6', '① 「最小表示 (5項目)」の札を消す', (s) => s.replace('最小表示 (5項目)', '')],
  ['S6', '③ 押す物2つを専用の行へ戻す', (s) => s
    .replace('<div className="flex gap-2 shrink-0">\n               <button\n                 type="button"',
      '</div>\n           <div className="flex gap-2 justify-end">\n               <button\n                 type="button"')],
  ['S7', '① 「自動タイル配置」の札を消す', (s) => s
    .replace('<LayoutGrid className="w-4 h-4" /> 自動タイル配置', '')],
  ['S7', '② エリアの数の札から ml-auto を外す(右端が空く)', (s) => s
    .replace('<span className="ml-auto text-xs text-slate-500 whitespace-nowrap"', '<span className="text-xs text-slate-500 whitespace-nowrap"')],
  ['S8', '① 何が保存されるかの説明を消す', (s) => s
    .replace('<span data-textfill="1" className="flex-1 min-w-[240px] text-xs text-slate-500">この1つで ', '<span>')],
  ['S8', '② 説明の flex-1 を外す(押す物の左が空く)', (s) => s
    .replace('<span data-textfill="1" className="flex-1 min-w-[240px] text-xs text-slate-500">この1つで ',
      '<span data-textfill="1" className="text-xs text-slate-500">この1つで ')],
  ['S9', '③ マスタ設定でも帯を別に出す', (s) => s.replace("if (activeTab === 'templates') return null;", '')],
  ['S9', '① 親タブを渡すのをやめる(行き先が消える)', (s) => s
    .replace('parentTabs={renderTabGroupButtons(TAB_GROUPS.templates)}', '')],
  ['S9', '② 親タブを描くのをやめる', (s) => s
    .replace('{parentTabs && <div data-band="templates-tabs" className="ml-auto flex items-center gap-1">{parentTabs}</div>}', '')],
  ['S10', '③ 読み方の文を表の上へ戻す', (s) => s
    .replace('<div data-textfill="1" className="text-[11px] text-slate-500">休み・他工場',
      '<div className="text-[11px] text-slate-500 mb-2">休み・他工場')],
  ['S10', '① 凡例の「他工場」を消す', (s) => s
    .replace('他工場（共有作業者が今日は別工場）', '')],
  ['S10', '② 表の箱を横に伸ばす形へ戻す', (s) => s
    .replace('<div className="overflow-x-auto shrink-0 max-w-full">', '<div className="overflow-x-auto">')],
];

test('S-0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 22, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
