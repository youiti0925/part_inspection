// ⚠部品の写し: 製品 src/SkillMap.jsx(P135 新版)をそのまま写し、画面の言葉「型式」だけ「品目コード」にした(2か所)。
// =============================================================================
//  SkillMap.jsx — スキルマップ（スキルを作る・直す・人に付ける）2026-09-03 決まり17
// -----------------------------------------------------------------------------
//  ・スキル(settings.skills[]) = { id, name, note, scope:'shared'|'template', templateId }
//      共通＝複数のテンプレに効く／★特注機＝テンプレ1つ専用（作る時にそのテンプレへ自動で付く）
//  ・テンプレに要るスキル(template.requiredSkills[] = { skillId, stepIds:[] })は **テンプレ編集画面** で付ける。
//      ここは「効く工程」を見るだけ＋飛ぶボタン。
//  ・人のレベル(settings.workerSkills[名前][skillId] = 0〜3) は語彙4つ:
//      0 記録なし(分かりません) / 1 🎓教育中 / 2 一人でできる / 3 教えられる。配れる線＝2(skillRegistry.ASSIGNABLE_LEVEL)。
//  ・「実績」の列は完了ロットから自動で数えた **関与した回数**(computeSkillCounts)。
//  🚨 computeSkillCounts の回数は「ロットに関与した回数」であって、単独で任せられる事の認定ではない。
//     そのロットの**何らかの**タスクに名前が残った人へテンプレの必要スキルを**全部**足している。
//     → 自動配置の根拠に使ってはいけない。配置の根拠は operationsSimulation/historyEligibility.js
//       が工程(processKey)ごとに作る候補（実績＝soloDependency／登録＝skillRegistry.buildSkillConfig）。
//     (2026-08-22 清水さんの是正指示書 2.4 による訂正)
//  ・管理者以外にもボタンは出す。押すと「管理者でログインすると足せます」（どこにあるか分かる）。
// =============================================================================
import React, { useState, useMemo } from 'react';
import { Users, Plus, Trash2, Award, ArrowRight, Pencil } from 'lucide-react';
import { SoloDependencyPanel } from './SoloDependencyPanel.jsx';
import { computeSoloDependency } from './domain/soloDependency.js';
import {
  SKILL_LEVELS, ASSIGNABLE_LEVEL, SKILL_SCOPE, skillLevelOf, isAssignableLevel,
  normalizeSkills, upsertSkill, removeSkill, newSkillId, normalizeRequiredSkills, attachSkill, detachSkill,
  templatesBySkill, workerSkillLevel,
} from './domain/skillRegistry.js';
// 🚨 2026-08-22: DefenseCommandPanel（🛡納期あぶない順）はここから外した。
//   理由: あれが出していた「◯件が納期に間に合わない」は lot.dueDate を『守るべき納期』として
//   数えた物だった。本番の完了実績246件のうち **53.7% がその日を過ぎて完了している**（山の頂点は+1日）。
//   未来を動かす画面は operationsSimulation の「操業シミュレーション」タブへ作り直す。
// 🛟 新しいタブが描画で転んでも、**既存のスキルマップと他の画面を巻き込まない**ための受け皿。
import { ErrorBoundary } from './ErrorBoundary.jsx';
// 🛌 休止中の人。この画面は全員を出す(実績を消さない)ので、札で見分ける。
import { pausedNamesOf } from './domain/workerPause.js';
// 📋 決まり29(2026-09-05): 型式×テンプレ×人の「やった回数／登録」の表。Codex が作った読取専用の部品(src/opsim/skillGrid)。
//   数えるのは model.js の buildSkillGrid ただ1つ。この画面は結果を渡すだけ(ここで数え直さない)。
import { SkillGrid, buildSkillGrid } from './opsim/skillGrid/index.js';
// 🎨 絵の語彙(2026-09-15)。🚨 vizKit は数を作らない。impactOf の答えを長さ・点・形へ変えるだけ。
import { Bar, Dots, Signal, Glyph } from './opsim/vizKit.jsx';

export const DEFAULT_SKILLS = [
  { id: 'sk_rot', name: '回転分割' },
  { id: 'sk_inc', name: '傾斜分割' },
  { id: 'sk_rotgen', name: '回転軸一般精度' },
  { id: 'sk_incrotgen', name: '傾斜回転軸一般精度' },
  { id: 'sk_fanuc', name: 'ファナック' },
  { id: 'sk_meldas', name: 'メルダス' },
  { id: 'sk_brother', name: 'ブラザー' },
];

/** 言葉は skillRegistry ただ1つから。ここは互換のための再輸出。 */
export { SKILL_LEVELS };
const lvl = (v) => skillLevelOf(v);

// スキルの色（一覧・チップ・工程の●で同じ色）。id の並び順で決める。
const SKILL_COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#14b8a6', '#f59e0b', '#f43f5e', '#64748b', '#e11d48', '#0891b2', '#7c3aed', '#65a30d', '#ea580c'];
export const skillColorOf = (skillList, skillId) => {
  const i = (skillList || []).findIndex((s) => s.id === skillId);
  return SKILL_COLORS[(i < 0 ? (skillList || []).length : i) % SKILL_COLORS.length];
};

// 完了ロットから「作業者 × スキル」の回数を集計。counts[workerName][skillId] = 回数(完了ロット数)
export function computeSkillCounts(lots, templates, workers = []) {
  const wName = (id) => (workers.find(w => w.id === id)?.name) || null;
  const tplSkillIds = (tplId) => {
    const t = (templates || []).find(x => x.id === tplId);
    return normalizeRequiredSkills(t?.requiredSkills).map(rs => rs.skillId);
  };
  const counts = {};
  (lots || []).filter(l => l.status === 'completed').forEach(lot => {
    const sids = tplSkillIds(lot.templateId);
    if (!sids.length) return;
    const wset = new Set();
    Object.values(lot.tasks || {}).forEach(t => { if (t && t.workerName) wset.add(t.workerName); });
    if (wset.size === 0 && lot.workerId) { const n = wName(lot.workerId); if (n) wset.add(n); }
    wset.forEach(wn => {
      counts[wn] = counts[wn] || {};
      sids.forEach(sid => { counts[wn][sid] = (counts[wn][sid] || 0) + 1; });
    });
  });
  return counts;
}

const ScopeChip = ({ scope }) => (scope === SKILL_SCOPE.TEMPLATE
  ? <span className="fi-tap-text font-bold px-1.5 py-0.5 rounded-full border border-pink-300 bg-pink-50 text-pink-700">★特注機</span>
  : <span className="fi-tap-text font-bold px-1.5 py-0.5 rounded-full border border-slate-300 bg-white text-slate-600">共通</span>);

// 🛟 2026-09-04: 中身は Body に置き、外(下の SkillMapView)で ErrorBoundary に包む。
//   ここが転ぶと main.jsx のアプリ全体の受け皿が拾って **画面が丸ごと消える**(2026-08-27 と同じ形)。
//   包み方は OperationsSimulationPanel.jsx の <ErrorBoundary compact where=...> と同じ流儀。
function SkillMapViewBody({ lots, templates, workers = [], skills, workerSkills = {}, canEdit = false, onSaveSkills, onSaveWorkerSkill, onSaveTemplateSkills, onOpenTemplate = null, currentUserName = '', historyComplete = false, historyNote = '' }) {
  // 🚨 hooks は全部ここ（ガードより上）。
  // 'skill' … スキル（作る・直す・人に付ける） / 'table' … 作業者×スキルの表 / 'solo' … 根拠・データ監査
  const [mainTab, setMainTab] = useState('skill');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);       // { id, name, note, scope, templateId, isNew }
  const [notice, setNotice] = useState('');       // 管理者以外へ「どこで足せるか」
  const [tplMatrixOpen, setTplMatrixOpen] = useState(false);

  const skillList = useMemo(() => normalizeSkills((skills && skills.length) ? skills : DEFAULT_SKILLS), [skills]);
  const counts = useMemo(() => computeSkillCounts(lots, templates, workers), [lots, templates, workers]);
  const tplUse = useMemo(() => templatesBySkill(templates), [templates]);
  // 実績（工程ごとに「やった記録」がある人）。配置の根拠と同じ数え方（soloDependency）。
  const solo = useMemo(() => {
    try { return computeSoloDependency({ lots: lots || [], templates: templates || [], workers: workers || [] }); }
    catch { return null; }
  }, [lots, templates, workers]);
  // templateId -> { 名前 -> 記録のある工程数 }
  const recordByTpl = useMemo(() => {
    const out = {};
    ((solo && solo.processes) || []).forEach((p) => {
      const tid = String(p.templateId || '');
      if (!tid) return;
      const m = out[tid] || (out[tid] = {});
      (p.people || []).forEach((x) => { const n = x && x.workerName; if (n) m[n] = (m[n] || 0) + 1; });
    });
    return out;
  }, [solo]);

  // 🛌 休止中の人の名前。**消さない**(過去の実績も表も残す)。ただし札を出して、
  //    「ここで登録しても、いまの割付には効かない」ことが読めるようにする(2026-09-04)。
  //    根拠: 隣の操業シミュレーションは activeWorkersOf で休止中を外した人だけを回す
  //          (App.jsx の activeWorkers)。simulate は休止中の名前を1件も回さない。
  const pausedNames = useMemo(() => pausedNamesOf(workers), [workers]);
  // 📋 決まり29: 型式×テンプレ×人の表。回数＝完了ロットへの関与(どの工程でも1回)。割付の順は工程ごとの回数(historyEligibility)で、この表の数字とは単位が違う。
  //   historyComplete / historyNote は親(App.jsx の skillGridHistory)。③過去の取り寄せが来て 500件に頭打ちしていない時だけ「全部」。
  const skillGrid = useMemo(() => buildSkillGrid({
    lots, templates, workers, skills: skillList, workerSkills: workerSkills || {},
    historyComplete: historyComplete === true,
    sourceLabel: historyNote || 'この端末が受け取っている一覧',
  }), [lots, templates, workers, skillList, workerSkills, historyComplete, historyNote]);

  // 行: 登録作業者 + 実績に出た名前(フリー等)も拾う
  const rowNames = useMemo(() => {
    const set = new Set((workers || []).map(w => w.name).filter(Boolean));
    Object.keys(counts).forEach(n => set.add(n));
    Object.keys(workerSkills || {}).forEach(n => set.add(n));
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [workers, counts, workerSkills]);

  const selected = skillList.find((s) => s.id === selectedId) || null;
  // 決まり14-3 の「だから何」(設計 絵1 右上): このスキルが効く未完了ロットと、いま配れる人／分かりません の人数。
  //   🚨 数えるだけ(割付し直しではない)。配れる＝登録(一人でできる以上) か 実績(その工程をやった記録)。
  const impactOf = (sk) => {
    if (!sk) return null;
    const uses = tplUse[sk.id] || [];
    const tids = new Set(uses.map((u) => u.templateId));
    const pendingLots = (lots || []).filter((l) => l && l.status !== 'completed' && tids.has(l.templateId)).length;
    const who = rowNames.map((wn) => {
      const byReg = isAssignableLevel(workerSkillLevel(workerSkills, wn, sk.id));
      const byRec = uses.reduce((a, u) => a + ((recordByTpl[u.templateId] || {})[wn] || 0), 0) > 0;
      return { byReg, byRec };
    });
    return {
      templates: tids.size, pendingLots, total: who.length,
      canAssign: who.filter((x) => x.byReg || x.byRec).length,
      byReg: who.filter((x) => x.byReg).length,
      byRecOnly: who.filter((x) => !x.byReg && x.byRec).length,
      unknown: who.filter((x) => !x.byReg && !x.byRec).length,
    };
  };
  const impact = impactOf(selected);
  // 🎨 選ぶ前でも全部読める様にする為の下ごしらえ。
  //   🚨 数は impactOf / tplUse ただ1つ。選んだ時に使っているのと **同じ関数・同じ入力**。
  //      ここで新しい数え方を書いていない(書くと同じ数字が2つの計算から出る)。
  const overview = skillList.map((s) => ({ s, im: impactOf(s), use: (tplUse[s.id] || []).length }));
  const maxTplUse = overview.reduce((a, o) => Math.max(a, o.use), 0);
  const maxPending = overview.reduce((a, o) => Math.max(a, o.im.pendingLots), 0);
  const getLevel = (wn, sid) => workerSkillLevel(workerSkills, wn, sid);
  const tplName = (tid) => ((templates || []).find((t) => t.id === tid)?.name) || tid;

  const requireAdmin = () => {
    if (canEdit) return true;
    setNotice(`管理者でログインすると足せます（いまは「${currentUserName || '未ログイン'}」）。場所はここ＝工程改善・最適化 ▸ スキルマップ。`);
    return false;
  };
  const startNew = () => {
    if (!requireAdmin()) return;
    setDraft({ id: newSkillId(Date.now(), Math.random().toString(36).slice(2, 5)), name: '', note: '', scope: SKILL_SCOPE.SHARED, templateId: '', isNew: true });
  };
  const startEdit = (s) => { if (!requireAdmin()) return; setDraft({ ...s, templateId: s.templateId || '', isNew: false }); };
  const saveDraft = () => {
    if (!draft) return;
    const name = (draft.name || '').trim();
    if (!name) { alert('スキルの名前を入れてください'); return; }
    if (draft.scope === SKILL_SCOPE.TEMPLATE && !draft.templateId) { alert('★特注機は、効くテンプレを1つ選んでください'); return; }
    const skill = { id: draft.id, name, note: (draft.note || '').trim(), scope: draft.scope, templateId: draft.scope === SKILL_SCOPE.TEMPLATE ? draft.templateId : '', by: currentUserName || '', at: Date.now() };
    onSaveSkills(upsertSkill(skillList, skill));
    // ★特注機: 作った時にそのテンプレへ自動で付ける（全工程。工程の絞りはテンプレ編集で）
    if (skill.scope === SKILL_SCOPE.TEMPLATE && onSaveTemplateSkills) {
      const tpl = (templates || []).find((t) => t.id === skill.templateId);
      if (tpl && !normalizeRequiredSkills(tpl.requiredSkills).some((rs) => rs.skillId === skill.id)) {
        onSaveTemplateSkills(tpl.id, attachSkill(tpl.requiredSkills, skill.id, []));
      }
    }
    setSelectedId(skill.id);
    setDraft(null);
  };
  const deleteSkill = (s) => {
    if (!requireAdmin()) return;
    const use = (tplUse[s.id] || []).length;
    const tail = use ? `（${use}件のテンプレの「要るスキル」からも外します）` : '';
    if (!confirm(`スキル「${s.name}」を消しますか？${tail} 人ごとの登録レベルは残ります（同じ id で作り直すと戻ります）。`)) return;
    onSaveSkills(removeSkill(skillList, s.id));
    if (onSaveTemplateSkills) {
      (tplUse[s.id] || []).forEach((u) => {
        const tpl = (templates || []).find((t) => t.id === u.templateId);
        if (tpl) onSaveTemplateSkills(tpl.id, detachSkill(tpl.requiredSkills, s.id));
      });
    }
    if (selectedId === s.id) setSelectedId(null);
    setDraft(null);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">
      <div className="shrink-0 bg-gradient-to-r from-amber-600 to-orange-500 text-white px-5 py-3 flex items-center gap-3">
        <Award className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <div className="font-black text-lg leading-tight">スキルマップ</div>
          {mainTab === 'solo'
            ? <div className="fi-tap-text text-amber-100">作業記録だけを数えた<b>根拠の表</b>です。力量の認定ではありません。<b>実績1件でも「やった記録があります」</b>／<b>実績なしは「分かりません」</b>。</div>
            : mainTab === 'grid'
            ? <div className="fi-tap-text text-amber-100">品目コードとテンプレごとに、<b>誰が何回やったか</b>（完了ロットへの関与＝どの工程でも1回）と、<b>いまの登録</b>。割付は<b>完了ロットの回数が多い人を先に</b>配ります（決まり29）。回数は力量の認定ではありません。</div>
            : <div className="fi-tap-text text-amber-100">スキルを作る・直す・人に付ける。<b>要るスキルをテンプレに付けるのはテンプレ編集画面</b>。「実績」は<b>ロットに関与した回数</b>（完了ロット）で、単独で任せられる事の認定ではありません。</div>}
        </div>
        {mainTab !== 'solo' && (
          <button type="button" onClick={startNew} data-skillmap="add" className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 bg-white text-orange-600 hover:bg-orange-50 shadow">
            <Plus className="w-3.5 h-3.5" />スキルを追加
          </button>
        )}
      </div>

      <div className="shrink-0 flex gap-1 px-4 pt-2 bg-slate-50 border-b border-slate-200">
        <button onClick={() => setMainTab('skill')} className={`px-3 py-1.5 rounded-t-lg text-xs font-bold ${mainTab === 'skill' ? 'bg-white border border-b-0 border-slate-200 text-orange-600' : 'text-slate-500 hover:text-slate-700'}`}>スキル（作る・直す・人に付ける）</button>
        <button onClick={() => setMainTab('grid')} data-skillmap-tab="grid" className={`px-3 py-1.5 rounded-t-lg text-xs font-bold ${mainTab === 'grid' ? 'bg-white border border-b-0 border-slate-200 text-orange-600' : 'text-slate-500 hover:text-slate-700'}`}>品目コード × テンプレ × 人（回数／登録）</button>
        <button onClick={() => setMainTab('table')} className={`px-3 py-1.5 rounded-t-lg text-xs font-bold ${mainTab === 'table' ? 'bg-white border border-b-0 border-slate-200 text-orange-600' : 'text-slate-500 hover:text-slate-700'}`}>作業者 × スキルの表</button>
        {/* 🚨 2026-08-22 是正指示書 10章「実績から見た工程（疑似）を『根拠・データ監査』へ改名して主画面から下げる」。 */}
        <button onClick={() => setMainTab('solo')} className={`px-3 py-1.5 rounded-t-lg fi-tap-text font-bold ${mainTab === 'solo' ? 'bg-white border border-b-0 border-slate-200 text-slate-700' : 'text-slate-400 hover:text-slate-600'}`}>根拠・データ監査</button>
      </div>

      {notice && (
        <div className="shrink-0 mx-4 mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-bold flex items-center gap-2" data-skillmap="notice">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="text-amber-700 underline">閉じる</button>
        </div>
      )}

      {mainTab === 'solo' && (
        <ErrorBoundary where="skillmap-solo" compact>
          <SoloDependencyPanel lots={lots} templates={templates} workers={workers} />
        </ErrorBoundary>
      )}

      {/* 📋 決まり29: 型式×テンプレ×人。転んでもスキルマップ全体を消さない(ErrorBoundary) */}
      {mainTab === 'grid' && (
        <div className="flex-1 min-h-0 overflow-auto p-4" data-skillmap-grid="1">
          <ErrorBoundary where="skillmap-grid" compact>
            <SkillGrid model={skillGrid} />
          </ErrorBoundary>
        </div>
      )}

      {mainTab === 'skill' && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* 左: スキル一覧 */}
          <div className="w-72 shrink-0 border-r border-slate-200 bg-slate-50 overflow-y-auto p-3">
            <div className="fi-tap-text font-bold text-slate-500 mb-2">スキル（{skillList.length}）</div>
            <div className="space-y-1.5" data-skillmap="list">
              {skillList.map((s) => {
                const use = (tplUse[s.id] || []).length;
                const on = selectedId === s.id;
                return (
                  <button key={s.id} type="button" onClick={() => { setSelectedId(s.id); setDraft(null); }} data-skill-id={s.id}
                    className={`w-full text-left px-3 py-2 rounded-lg border flex items-center gap-2 ${on ? 'border-orange-400 bg-orange-50' : 'border-slate-200 bg-white hover:border-orange-200'}`}>
                    <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: skillColorOf(skillList, s.id) }} />
                    <span className="font-bold text-sm text-slate-800 truncate flex-1">{s.name}</span>
                    <ScopeChip scope={s.scope} />
                    {/* 🎨 『テンプレ 21』と『テンプレ 0』が同じ見た目だった。長さに変える。数字は隣に残す。 */}
                    <Bar value={use} max={maxTplUse} tone="quiet" height="h-1.5" className="w-12 shrink-0" title={`要ると付けたテンプレ ${use}件`} />
                    <span className="fi-tap-text text-slate-400 shrink-0">テンプレ {use}</span>
                  </button>
                );
              })}
              {skillList.length === 0 && <div className="text-xs text-slate-400 py-6 text-center">スキルがまだありません。右上の「スキルを追加」から。</div>}
            </div>
            <div className="fi-tap-text text-slate-400 mt-3 leading-relaxed border-l-2 border-slate-200 pl-2">
              「テンプレ ◯」＝そのスキルを要ると付けたテンプレの数（テンプレ編集画面で付ける）。<br />★特注機＝テンプレ1つにしか効かないスキル。
            </div>
          </div>

          {/* 右: 直す／効く工程／持っている人 */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-3">
            {draft ? (
              <div className="rounded-xl border border-orange-300 bg-white p-4 space-y-3" data-skillmap="form">
                <div className="font-black text-slate-800">{draft.isNew ? 'スキルを作る' : 'スキルを直す'}</div>
                <label className="flex items-center gap-3 text-sm"><span className="w-16 text-slate-500">名前</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例: RTT-215 傾斜回転" data-skillmap="name" className="flex-1 border rounded-lg px-3 py-2 font-bold" autoFocus /></label>
                <label className="flex items-start gap-3 text-sm"><span className="w-16 text-slate-500 pt-2">説明</span>
                  <textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} rows={2} placeholder="何ができれば持っていると言えるか（例: 専用治具での段取りが一人でできる）" data-skillmap="note" className="flex-1 border rounded-lg px-3 py-2" /></label>
                <div className="flex items-center gap-3 text-sm"><span className="w-16 text-slate-500">種類</span>
                  <label className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={draft.scope === SKILL_SCOPE.SHARED} onChange={() => setDraft({ ...draft, scope: SKILL_SCOPE.SHARED })} data-skillmap="scope-shared" /> 共通（複数のテンプレに効く）</label>
                  <label className="flex items-center gap-1 cursor-pointer ml-4"><input type="radio" checked={draft.scope === SKILL_SCOPE.TEMPLATE} onChange={() => setDraft({ ...draft, scope: SKILL_SCOPE.TEMPLATE })} data-skillmap="scope-template" /> ★特注機（テンプレ1つ専用）</label>
                </div>
                {draft.scope === SKILL_SCOPE.TEMPLATE && (
                  <label className="flex items-center gap-3 text-sm"><span className="w-16 text-slate-500">テンプレ</span>
                    <select value={draft.templateId} onChange={(e) => setDraft({ ...draft, templateId: e.target.value })} data-skillmap="template" className="flex-1 border rounded-lg px-3 py-2">
                      <option value="">— 選ぶ —</option>
                      {(templates || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select></label>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setDraft(null)} className="px-4 py-2 rounded-lg border text-slate-600 font-bold">やめる</button>
                  <button type="button" onClick={saveDraft} data-skillmap="save" className="px-5 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-bold">保存</button>
                </div>
              </div>
            ) : !selected ? (
              <div className="space-y-3" data-skillmap="overview">
                <div className="text-sm text-slate-400">左からスキルを選ぶと、説明・効く工程・持っている人が出ます。</div>
                {/* 🎨 2026-09-15: ここは画面の55%を占めて1文しか出していなかった。
                     7スキル全部の「配れる人／分かりません」を **押す前に** 絵で出す。
                     🚨 数は impactOf ただ1つ(選んだ時の右側と同じ関数)。数え直していない。
                     🚨 印は形も変える(Signal)。色が見えない人・白黒で刷った時でも読める。
                     🚨 赤(遅れ専用)は使わない。0人は「危ない」ではなく「分かりません」(実績なし＝分かりません・2026-08-20)。 */}
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Glyph kind="person" className="w-4 h-4 text-slate-500" />
                    <span className="fi-tap-text font-bold text-slate-700">スキルごとに、いま配れる人</span>
                    <span className="fi-tap-text text-slate-400">●=配れる(登録 or 実績) ／ ○=分かりません</span>
                  </div>
                  <div className="space-y-1">
                    {overview.map(({ s, im }) => {
                      const lv = im.canAssign === 0 ? 'unknown' : im.canAssign === 1 ? 'warn' : 'ok';
                      const lvTitle = im.canAssign === 0 ? 'このスキルを配れる人が居ません(登録も実績も無し)'
                        : im.canAssign === 1 ? '配れる人が1人だけ。その人が休むと止まります'
                        : `配れる人が${im.canAssign}人`;
                      return (
                        <button key={s.id} type="button" onClick={() => { setSelectedId(s.id); setDraft(null); }}
                          data-skillmap-overview-id={s.id}
                          className="w-full min-h-11 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left hover:border-orange-300">
                          <Signal level={lv} size="w-4 h-4" title={lvTitle} />
                          <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: skillColorOf(skillList, s.id) }} />
                          <span className="fi-tap-text font-bold text-slate-800 truncate w-32 shrink-0">{s.name}</span>
                          <Dots count={im.canAssign} cap={8} tone="plain" title={`配れる人 ${im.canAssign}人`} />
                          <Dots count={im.unknown} cap={8} tone="quiet" title={`分かりません ${im.unknown}人`} />
                          <span className="fi-tap-text text-slate-500 shrink-0">配れる <b className="font-mono">{im.canAssign}</b> ／ 分かりません <b className="font-mono">{im.unknown}</b>（{im.total}人中）</span>
                          <span className="flex-1" />
                          <Glyph kind="lot" className="w-4 h-4 text-slate-400 shrink-0" />
                          <Bar value={im.pendingLots} max={maxPending} tone="plain" height="h-1.5" className="w-24 shrink-0" title={`このスキルが効く未完了ロット ${im.pendingLots}`} />
                          <span className="fi-tap-text font-mono text-slate-600 w-8 text-right shrink-0">{im.pendingLots}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="fi-tap-text text-slate-400 mt-2 leading-relaxed">
                    棒＝そのスキルが効く未完了ロット。配れる＝「一人でできる」以上の登録か、その工程をやった記録。
                    これは力量の認定ではありません。
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-slate-200 bg-white p-4" data-skillmap="detail">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3.5 h-3.5 rounded-full" style={{ background: skillColorOf(skillList, selected.id) }} />
                    <span className="font-black text-lg text-slate-800">{selected.name}</span>
                    <ScopeChip scope={selected.scope} />
                    {selected.scope === SKILL_SCOPE.TEMPLATE && <span className="text-xs text-slate-500">{tplName(selected.templateId)}</span>}
                    <span className="flex-1" />
                    <button type="button" onClick={() => startEdit(selected)} data-skillmap="edit" className="px-3 py-1.5 rounded-lg border text-xs font-bold text-slate-700 flex items-center gap-1 hover:bg-slate-50"><Pencil className="w-3.5 h-3.5" />直す</button>
                    <button type="button" onClick={() => deleteSkill(selected)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600" title="消す"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <div className={`mt-2 text-sm ${selected.note ? 'text-slate-700' : 'text-slate-400'}`} data-skillmap="note-view">{selected.note || '説明はまだありません（「直す」で書けます）'}</div>
                </div>

                {/* 決まり14-3: この登録で変わる事(大きい字は答え＝人数とロット数。件数の羅列にしない) */}
                {impact && (
                  <div className="rounded-xl border-2 border-orange-300 bg-orange-50/60 p-4" data-skillmap="impact">
                    <div className="text-xs font-bold text-orange-800 mb-2">この登録で変わる事 <span className="font-normal text-slate-500">（数えるだけ。割付し直した結果ではありません）</span></div>
                    <div className="flex items-end gap-8 flex-wrap">
                      <div><div className="text-3xl font-black text-emerald-700 leading-none" data-skillmap-impact="can">{impact.canAssign}<span className="text-base text-slate-500">／{impact.total}人</span></div><div className="fi-tap-text text-slate-600 mt-1">配れる人（登録 {impact.byReg}・実績だけ {impact.byRecOnly}）</div></div>
                      <div><div className="text-3xl font-black text-rose-600 leading-none" data-skillmap-impact="unknown">{impact.unknown}<span className="text-base text-slate-500">人</span></div><div className="fi-tap-text text-slate-600 mt-1">分かりません（登録すると配れる）</div></div>
                      <div><div className="text-3xl font-black text-slate-800 leading-none" data-skillmap-impact="lots">{impact.pendingLots}<span className="text-base text-slate-500">ロット</span></div><div className="fi-tap-text text-slate-600 mt-1">このスキルが効く未完了ロット（テンプレ {impact.templates}）</div></div>
                    </div>
                    {impact.templates === 0 && <div className="fi-tap-text font-bold text-rose-700 mt-2">まだどのテンプレにも付いていないので、登録しても割付は変わりません。先にテンプレ編集画面で「要るスキル」に付けてください。</div>}
                  </div>
                )}

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="font-bold text-slate-700 text-sm mb-2">効く工程（テンプレ編集画面で決めた物。ここは見るだけ）</div>
                  {(tplUse[selected.id] || []).length === 0 ? (
                    <div className="text-xs text-slate-400">まだどのテンプレにも付いていません。テンプレ編集画面の「このテンプレに要るスキル」で付けます。</div>
                  ) : (
                    <div className="space-y-2">
                      {(tplUse[selected.id] || []).map((u) => (
                        <div key={u.templateId} className="flex items-center gap-3 text-sm">
                          <span className="font-bold text-slate-800 w-56 truncate" title={u.name}>{u.name}</span>
                          <span className="fi-tap-text text-slate-400">{u.totalSteps}工程のうち</span>
                          <span className="w-32 h-2 rounded bg-slate-200 overflow-hidden"><span className="block h-full" style={{ width: `${u.totalSteps ? Math.round((u.stepCount / u.totalSteps) * 100) : 0}%`, background: skillColorOf(skillList, selected.id) }} /></span>
                          <span className="font-bold text-slate-700">{u.allSteps ? '全工程' : `${u.stepCount}工程`}</span>
                          {onOpenTemplate && <button type="button" onClick={() => onOpenTemplate(u.templateId)} className="ml-auto text-xs font-bold text-orange-600 border border-orange-300 rounded-lg px-2 py-1 flex items-center gap-1 hover:bg-orange-50">テンプレ編集で工程を選ぶ <ArrowRight className="w-3 h-3" /></button>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="font-bold text-slate-700 text-sm mb-2">持っている人</div>
                  <table className="w-full text-sm border-collapse" data-skillmap="people">
                    <thead><tr className="fi-tap-text text-slate-500 border-b border-slate-200">
                      <th className="text-left px-2 py-1 font-bold">作業者</th>
                      <th className="text-left px-2 py-1 font-bold">実績（記録から・自動）</th>
                      <th className="text-left px-2 py-1 font-bold">登録（人の判断）</th>
                      <th className="text-left px-2 py-1 font-bold">割付で</th>
                    </tr></thead>
                    <tbody>
                      {rowNames.map((wn) => {
                        const level = getLevel(wn, selected.id);
                        const L = lvl(level);
                        const cnt = (counts[wn] && counts[wn][selected.id]) || 0;
                        // 実績＝このスキルを要るテンプレの工程に「やった記録」がある（配置の根拠と同じ数え方）
                        const recProc = (tplUse[selected.id] || []).reduce((a, u) => a + ((recordByTpl[u.templateId] || {})[wn] || 0), 0);
                        const byReg = isAssignableLevel(level);
                        const verdict = byReg ? (level >= 3 ? '配れる（OJTの教え手）' : '配れる') : (recProc > 0 ? '配れる（実績1件で可）' : '分かりません → 登録すると配れる');
                        const unknown = !byReg && recProc === 0;
                        return (
                          <tr key={wn} className={`border-b border-slate-100 ${unknown ? 'bg-rose-50/60' : ''}`} data-skillmap-row={wn}>
                            <td className="px-2 py-1.5 font-bold text-slate-800 whitespace-nowrap">{wn}</td>
                            <td className="px-2 py-1.5 text-slate-600">{recProc > 0 ? `○ 記録あり（工程${recProc}件・関与${cnt}ロット）` : <span className="text-slate-400">記録なし</span>}</td>
                            <td className="px-2 py-1.5">
                              {canEdit ? (
                                <select value={level} onChange={(e) => onSaveWorkerSkill(wn, selected.id, Number(e.target.value))} data-skillmap-level={wn} className={`font-bold bg-transparent border rounded px-2 py-1 ${L.cls}`}>
                                  {SKILL_LEVELS.map((o) => <option key={o.v} value={o.v}>{o.mark} {o.label}</option>)}
                                </select>
                              ) : <span className={`font-bold ${L.cls}`}>{L.mark} {L.label}</span>}
                            </td>
                            <td className={`px-2 py-1.5 font-bold ${unknown ? 'text-rose-600' : 'text-emerald-700'}`}>
                              {verdict}
                              {unknown && canEdit && <button type="button" onClick={() => onSaveWorkerSkill(wn, selected.id, ASSIGNABLE_LEVEL)} data-skillmap-register={wn} className="ml-2 px-2 py-0.5 rounded bg-orange-500 hover:bg-orange-600 text-white text-xs">登録する</button>}
                            </td>
                          </tr>
                        );
                      })}
                      {rowNames.length === 0 && <tr><td colSpan={4} className="text-center py-6 text-slate-400">作業者がいません</td></tr>}
                    </tbody>
                  </table>
                  <div className="fi-tap-text text-slate-500 mt-2 border-l-2 border-slate-200 pl-2">
                    実績も登録も無い人だけ「分かりません」。件数で足切りしない。登録は「一人でできる」以上で割付に配れる（「教えられる」はOJTの教え手の目印）。登録は人の判断であって査定ではない。
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {mainTab === 'table' && (
        <>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr>
                  <th className="px-3 py-2 font-black border-b border-slate-300 text-left sticky left-0 bg-slate-100 z-20"><Users className="w-4 h-4 inline mr-1" />作業者</th>
                  {skillList.map(s => <th key={s.id} className="px-2 py-2 font-black border-b border-slate-300 text-center min-w-[88px]"><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: skillColorOf(skillList, s.id) }} />{s.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rowNames.map(wn => (
                  <tr key={wn} className="border-b border-slate-100 hover:bg-amber-50/30">
                    <td className={`px-3 py-1.5 font-bold sticky left-0 whitespace-nowrap ${pausedNames.has(wn) ? 'text-slate-500 bg-slate-50' : 'text-slate-800 bg-white'}`}>
                      {wn}
                      {pausedNames.has(wn) && (
                        <span className="ml-1.5 fi-tap-text font-bold px-1.5 py-0.5 rounded-full border border-slate-400 bg-white text-slate-600" title="いま休止中です。実績と登録はそのまま残していますが、操業シミュレーションの割付には出てきません。">🛌休止中</span>
                      )}
                    </td>
                    {skillList.map(s => {
                      const level = getLevel(wn, s.id); const L = lvl(level); const cnt = (counts[wn] && counts[wn][s.id]) || 0;
                      return (
                        <td key={s.id} className={`px-2 py-1.5 text-center border-l border-slate-50 ${L.cell}`}>
                          <div className="flex flex-col items-center gap-0.5">
                            {canEdit ? (
                              <select value={level} onChange={e => onSaveWorkerSkill(wn, s.id, Number(e.target.value))} className={`text-sm font-black bg-transparent outline-none cursor-pointer ${L.cls}`} title="レベルを設定">
                                {SKILL_LEVELS.map(o => <option key={o.v} value={o.v}>{o.mark} {o.label}</option>)}
                              </select>
                            ) : (
                              <span className={`text-lg font-black ${L.cls}`} title={L.label}>{L.mark}</span>
                            )}
                            <span className={`fi-tap-text ${cnt > 0 ? 'text-slate-500' : 'text-slate-300'}`} title="そのロットに関与した回数(完了ロット)。単独で任せられる事の認定ではありません">{cnt}回</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {rowNames.length === 0 && <tr><td colSpan={skillList.length + 1} className="text-center py-10 text-slate-400">作業者がいません</td></tr>}
              </tbody>
            </table>
            {canEdit && (
              <div className="m-3 border border-slate-200 rounded-lg">
                <button type="button" onClick={() => setTplMatrixOpen((v) => !v)} className="w-full text-left px-3 py-2 text-xs font-bold text-slate-600 bg-slate-50">テンプレ × スキル（全工程で要る物だけ。工程ごとの絞りはテンプレ編集画面）{tplMatrixOpen ? ' ▲' : ' ▼'}</button>
                {tplMatrixOpen && (
                  <div className="p-2 overflow-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead><tr><th className="text-left px-2 py-1 border-b border-slate-200 sticky left-0 bg-white">テンプレ</th>{skillList.map(s => <th key={s.id} className="px-1 py-1 border-b border-slate-200 text-center font-bold" style={{ writingMode: 'vertical-rl' }}>{s.name}</th>)}</tr></thead>
                      <tbody>
                        {(templates || []).map(tpl => {
                          const req = normalizeRequiredSkills(tpl.requiredSkills);
                          return (
                            <tr key={tpl.id} className="hover:bg-amber-50/40">
                              <td className="px-2 py-1 border-b border-slate-100 font-bold text-slate-700 sticky left-0 bg-white whitespace-nowrap">{tpl.name}</td>
                              {skillList.map(s => {
                                const hit = req.find((rs) => rs.skillId === s.id);
                                return (
                                  <td key={s.id} className="px-1 py-1 border-b border-slate-100 text-center" title={hit && hit.stepIds.length ? `${hit.stepIds.length}工程だけ（テンプレ編集で決めた物）` : ''}>
                                    <input type="checkbox" checked={!!hit} onChange={e => onSaveTemplateSkills(tpl.id, e.target.checked ? attachSkill(tpl.requiredSkills, s.id, []) : detachSkill(tpl.requiredSkills, s.id))} />
                                    {hit && hit.stepIds.length ? <span className="fi-tap-text text-pink-600 block">{hit.stepIds.length}工程</span> : null}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="shrink-0 px-4 py-2 border-t border-slate-200 bg-slate-50 fi-tap-text text-slate-500">
            記号: {SKILL_LEVELS.slice(1).map((o) => <b key={o.v} className={`${o.cls} mr-2`}>{o.mark}{o.label}</b>)}／−記録なし。下の数字＝<b>ロットに関与した回数</b>（完了ロット）。<b className="text-slate-700">単独で任せられる事の認定ではありません。</b>{canEdit ? '' : 'レベルの登録は管理者のみ。'}
            {pausedNames.size > 0 && <> ／<b className="text-slate-700">🛌休止中 {pausedNames.size}人</b>は表に残していますが、<b>いまの操業シミュレーションの割付には出てきません</b>（復帰すると効きます）。</>}
          </div>
        </>
      )}
    </div>
  );
}

// 🛟 スキルマップ全体の受け皿。ここで受けると、転んだ時に消えるのはこの画面だけで、
//   アプリ(現場マップ・検査リスト等)は生き残る。
export function SkillMapView(props) {
  return (
    <ErrorBoundary compact where="スキルマップ">
      <SkillMapViewBody {...props} />
    </ErrorBoundary>
  );
}
