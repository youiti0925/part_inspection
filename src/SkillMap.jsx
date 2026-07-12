// =============================================================================
//  SkillMap.jsx — スキルマップ（作業者 × スキル：レベル＋回数）
// -----------------------------------------------------------------------------
//  ・スキル種別(回転分割/傾斜分割/…/ファナック等)を管理者が定義(settings.skills)。
//  ・各テンプレが「使うスキル(種別＋必要レベル)」を持つ(template.requiredSkills)。
//  ・作業者のレベルは管理者が設定(settings.workerSkills[作業者名][skillId]=level)。
//  ・回数は“完了ロット”から自動集計：そのロットのテンプレが使うスキル × 担当した作業者
//    （task.workerName）で +1。過去の完了データから即・遡って反映される。
//  ・このデータは将来の「自動配置(空いてる得意な人へ)」の土台になる。
// =============================================================================
import React, { useState, useMemo } from 'react';
import { Users, Plus, Trash2, Settings as Cog, ChevronDown, ChevronUp, ChevronRight, Award, X } from 'lucide-react';

export const DEFAULT_SKILLS = [
  { id: 'sk_rot', name: '回転分割' },
  { id: 'sk_inc', name: '傾斜分割' },
  { id: 'sk_rotgen', name: '回転軸一般精度' },
  { id: 'sk_incrotgen', name: '傾斜回転軸一般精度' },
  { id: 'sk_fanuc', name: 'ファナック' },
  { id: 'sk_meldas', name: 'メルダス' },
  { id: 'sk_brother', name: 'ブラザー' },
];

export const SKILL_LEVELS = [
  { v: 0, label: '−', mark: '−', cls: 'text-slate-300', cell: '' },
  { v: 1, label: '見習い', mark: '△', cls: 'text-amber-600', cell: 'bg-amber-50' },
  { v: 2, label: '一人前', mark: '○', cls: 'text-blue-600', cell: 'bg-blue-50' },
  { v: 3, label: '熟練', mark: '◎', cls: 'text-emerald-700', cell: 'bg-emerald-50' },
];
const lvl = (v) => SKILL_LEVELS.find(l => l.v === (v || 0)) || SKILL_LEVELS[0];

// 完了ロットから「作業者 × スキル」の回数を集計。counts[workerName][skillId] = 回数(完了ロット数)
export function computeSkillCounts(lots, templates, workers = []) {
  const wName = (id) => (workers.find(w => w.id === id)?.name) || null;
  const tplSkillIds = (tplId) => {
    const t = (templates || []).find(x => x.id === tplId);
    return (t?.requiredSkills || []).map(rs => (typeof rs === 'string' ? rs : rs.skillId)).filter(Boolean);
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

export function SkillMapView({ lots, templates, workers = [], skills, workerSkills = {}, canEdit = false, onSaveSkills, onSaveWorkerSkill, onSaveTemplateSkills }) {
  const [showConfig, setShowConfig] = useState(false);
  const [configTab, setConfigTab] = useState('template'); // 'template' | 'kinds'
  const [newSkill, setNewSkill] = useState('');

  const skillList = (skills && skills.length) ? skills : DEFAULT_SKILLS;
  const counts = useMemo(() => computeSkillCounts(lots, templates, workers), [lots, templates, workers]);

  // 行: 登録作業者 + 実績に出た名前(フリー等)も拾う
  const rowNames = useMemo(() => {
    const set = new Set((workers || []).map(w => w.name).filter(Boolean));
    Object.keys(counts).forEach(n => set.add(n));
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [workers, counts]);

  const getLevel = (wn, sid) => (workerSkills[wn] && workerSkills[wn][sid]) || 0;
  const tplSkillSet = (tpl) => new Set((tpl.requiredSkills || []).map(rs => (typeof rs === 'string' ? rs : rs.skillId)));

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">
      <div className="shrink-0 bg-gradient-to-r from-amber-600 to-orange-500 text-white px-5 py-3 flex items-center gap-3">
        <Award className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <div className="font-black text-lg leading-tight">スキルマップ（作業者 × スキル）</div>
          <div className="text-[11px] text-amber-100">レベルは管理者が設定。<b>回数は完了データから自動集計</b>（テンプレが使うスキル × 担当者）。将来の自動配置の土台。</div>
        </div>
        {canEdit && <button onClick={() => setShowConfig(s => !s)} className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${showConfig ? 'bg-white text-orange-600' : 'bg-white/15 hover:bg-white/30'}`}><Cog className="w-3.5 h-3.5" />設定</button>}
      </div>

      {showConfig && canEdit && (
        <div className="shrink-0 border-b border-slate-200 bg-slate-50">
          <div className="flex gap-1 px-4 pt-2">
            <button onClick={() => setConfigTab('template')} className={`px-3 py-1.5 rounded-t-lg text-xs font-bold ${configTab === 'template' ? 'bg-white border border-b-0 border-slate-200 text-orange-600' : 'text-slate-500'}`}>テンプレが使うスキル</button>
            <button onClick={() => setConfigTab('kinds')} className={`px-3 py-1.5 rounded-t-lg text-xs font-bold ${configTab === 'kinds' ? 'bg-white border border-b-0 border-slate-200 text-orange-600' : 'text-slate-500'}`}>スキル種別の編集</button>
          </div>
          <div className="bg-white border-t border-slate-200 p-3 max-h-64 overflow-auto">
            {configTab === 'kinds' ? (
              <div>
                <div className="flex gap-2 mb-2">
                  <input value={newSkill} onChange={e => setNewSkill(e.target.value)} placeholder="新しいスキル種別名" className="border rounded px-2 py-1 text-sm flex-1" onKeyDown={e => { if (e.key === 'Enter') { const n = newSkill.trim(); if (!n) return; onSaveSkills([...(skillList), { id: 'sk_' + Date.now().toString(36), name: n }]); setNewSkill(''); } }} />
                  <button onClick={() => { const n = newSkill.trim(); if (!n) return; onSaveSkills([...(skillList), { id: 'sk_' + Date.now().toString(36), name: n }]); setNewSkill(''); }} className="bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded text-sm font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />追加</button>
                </div>
                <div className="space-y-1">
                  {skillList.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                      <span className="text-[10px] text-slate-400 w-5 text-center">{i + 1}</span>
                      <div className="flex flex-col leading-none">
                        <button title="上へ" disabled={i === 0} onClick={() => { const a = [...skillList]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; onSaveSkills(a); }} className="text-slate-400 hover:text-orange-600 disabled:opacity-20"><ChevronUp className="w-4 h-4" /></button>
                        <button title="下へ" disabled={i === skillList.length - 1} onClick={() => { const a = [...skillList]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; onSaveSkills(a); }} className="text-slate-400 hover:text-orange-600 disabled:opacity-20"><ChevronDown className="w-4 h-4" /></button>
                      </div>
                      <input defaultValue={s.name} onBlur={e => { const v = e.target.value.trim(); if (!v || v === s.name) { e.target.value = s.name; return; } onSaveSkills(skillList.map(x => x.id === s.id ? { ...x, name: v } : x)); }} className="border border-slate-200 rounded px-2 py-1 text-sm flex-1 font-bold text-slate-700" title="名前を編集（入力後フォーカスを外すと保存）" />
                      <button onClick={() => { if (confirm(`スキル「${s.name}」を削除しますか？`)) onSaveSkills(skillList.filter(x => x.id !== s.id)); }} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-slate-400 mt-2">※ ▲▼で並び替え（表の列順に反映）／名前は直接編集（フォーカスを外すと保存）／既定の種別も自由に変更できます。</div>
              </div>
            ) : (
              <div>
                <div className="text-[11px] text-slate-500 mb-2">各テンプレが<b>どのスキルを使うか</b>をチェック。チェックした分が、そのテンプレの仕事を完了した作業者の回数に加算されます。</div>
                <table className="w-full text-xs border-collapse">
                  <thead><tr><th className="text-left px-2 py-1 border-b border-slate-200 sticky left-0 bg-white">テンプレ</th>{skillList.map(s => <th key={s.id} className="px-1 py-1 border-b border-slate-200 text-center font-bold" style={{ writingMode: 'vertical-rl' }}>{s.name}</th>)}</tr></thead>
                  <tbody>
                    {(templates || []).map(tpl => {
                      const set = tplSkillSet(tpl);
                      return (
                        <tr key={tpl.id} className="hover:bg-amber-50/40">
                          <td className="px-2 py-1 border-b border-slate-100 font-bold text-slate-700 sticky left-0 bg-white whitespace-nowrap">{tpl.name}</td>
                          {skillList.map(s => (
                            <td key={s.id} className="px-1 py-1 border-b border-slate-100 text-center">
                              <input type="checkbox" checked={set.has(s.id)} onChange={e => {
                                const cur = (tpl.requiredSkills || []).map(rs => (typeof rs === 'string' ? rs : rs.skillId));
                                const next = e.target.checked ? [...new Set([...cur, s.id])] : cur.filter(x => x !== s.id);
                                onSaveTemplateSkills(tpl.id, next.map(id => ({ skillId: id, level: 1 })));
                              }} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* メイン: 作業者 × スキル 表 */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-100 z-10">
            <tr>
              <th className="px-3 py-2 font-black border-b border-slate-300 text-left sticky left-0 bg-slate-100 z-20"><Users className="w-4 h-4 inline mr-1" />作業者</th>
              {skillList.map(s => <th key={s.id} className="px-2 py-2 font-black border-b border-slate-300 text-center min-w-[88px]">{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rowNames.map(wn => (
              <tr key={wn} className="border-b border-slate-100 hover:bg-amber-50/30">
                <td className="px-3 py-1.5 font-bold text-slate-800 sticky left-0 bg-white whitespace-nowrap">{wn}</td>
                {skillList.map(s => {
                  const level = getLevel(wn, s.id); const L = lvl(level); const cnt = (counts[wn] && counts[wn][s.id]) || 0;
                  return (
                    <td key={s.id} className={`px-2 py-1.5 text-center border-l border-slate-50 ${L.cell}`}>
                      <div className="flex flex-col items-center gap-0.5">
                        {canEdit ? (
                          <select value={level} onChange={e => onSaveWorkerSkill(wn, s.id, Number(e.target.value))} className={`text-sm font-black bg-transparent outline-none cursor-pointer ${L.cls}`} title="レベルを設定">
                            {SKILL_LEVELS.map(o => <option key={o.v} value={o.v}>{o.mark} {o.v > 0 ? o.label : ''}</option>)}
                          </select>
                        ) : (
                          <span className={`text-lg font-black ${L.cls}`} title={L.label}>{L.mark}</span>
                        )}
                        <span className={`text-[10px] ${cnt > 0 ? 'text-slate-500' : 'text-slate-300'}`} title="携わった回数(完了ロット)">{cnt}回</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
            {rowNames.length === 0 && <tr><td colSpan={skillList.length + 1} className="text-center py-10 text-slate-400">作業者がいません</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 px-4 py-2 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500">
        記号: <b className="text-emerald-700">◎熟練</b> / <b className="text-blue-600">○一人前</b> / <b className="text-amber-600">△見習い</b> / −なし。下の数字＝<b>携わった回数</b>（完了ロット）。{canEdit ? '右上「設定」でテンプレが使うスキルを設定すると、過去の完了分から回数が入ります。' : 'レベル設定は管理者のみ。'}
      </div>
    </div>
  );
}
