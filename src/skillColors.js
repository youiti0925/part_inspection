// スキルの色（一覧・チップ・工程の●で同じ色）。id の並び順で決める。(製品 SkillMap.jsx の skillColorOf と同じ式)
//  画面の .jsx から式を export すると Fast refresh の見張り(react-refresh/only-export-components)が赤になるので、別のファイルに置く。
const SKILL_COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#14b8a6', '#f59e0b', '#f43f5e', '#64748b', '#e11d48', '#0891b2', '#7c3aed', '#65a30d', '#ea580c'];
export const skillColorOf = (skillList, skillId) => {
  const i = (skillList || []).findIndex((s) => s.id === skillId);
  return SKILL_COLORS[(i < 0 ? (skillList || []).length : i) % SKILL_COLORS.length];
};
