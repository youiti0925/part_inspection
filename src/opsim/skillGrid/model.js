// 決まり29: このファイルだけが回数を作る。画面は buildSkillGrid の結果を読むだけ。
// 完了ロットへの関与 = SkillMap.computeSkillCounts と同じ意味。単独作業の認定ではない。
import { SKILL_LEVELS, normalizeRequiredSkills, workerSkillLevel } from '../../domain/skillRegistry.js';
import { pausedNamesOf } from '../../domain/workerPause.js';

const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => value == null ? '' : String(value);
const nameOf = (value) => typeof value === 'string' && value.trim() ? value : '';
const compare = (a, b) => a.localeCompare(b, 'ja');
const keyOf = (...parts) => JSON.stringify(parts);

export const SKILL_GRID_STATES = Object.freeze({
  both: Object.freeze({ label: '実績と登録', mark: '●', cell: 'bg-emerald-50 border-emerald-300', ink: 'text-emerald-700', dot: 'bg-emerald-700 rounded-full' }),
  history: Object.freeze({ label: '実績のみ', mark: '◆', cell: 'bg-sky-50 border-sky-300', ink: 'text-sky-700', dot: 'bg-sky-700 rounded-sm' }),
  registration: Object.freeze({ label: '登録のみ', mark: '■', cell: 'bg-violet-50 border-violet-300', ink: 'text-violet-700', dot: 'bg-violet-700' }),
  neither: Object.freeze({ label: 'どちらも記録なし', mark: '−', cell: 'bg-slate-50 border-slate-300', ink: 'text-slate-700', dot: 'bg-slate-300 rounded-full' }),
});

function registrationOf(template, person, workerSkills, skillNames) {
  const requirements = normalizeRequiredSkills(template?.requiredSkills);
  const items = requirements.map(({ skillId }) => {
    const rawLevel = workerSkillLevel(workerSkills, person, skillId);
    const entry = SKILL_LEVELS.find((level) => level.v === rawLevel);
    return {
      skillId, name: skillNames.get(skillId) || skillId,
      level: entry?.v ?? 0, label: entry?.label || SKILL_LEVELS[0].label,
      invalid: !entry,
    };
  });
  const registeredCount = items.filter((item) => item.level > 0).length;
  const total = items.length;
  const invalid = items.some((item) => item.invalid);
  const state = !template ? 'missing_template' : !total ? 'not_configured'
    : !object(workerSkills) ? 'not_provided' : invalid ? 'invalid' : !registeredCount ? 'none'
      : registeredCount < total ? 'partial' : 'complete';
  const summary = state === 'missing_template' ? 'テンプレ不明'
    : state === 'not_configured' ? '必要スキル未設定'
      : state === 'not_provided' ? '登録データ未受領'
        : invalid ? '登録値を確認' : !registeredCount ? '登録なし' : `登録 ${registeredCount}/${total}`;
  return { state, summary, items, registeredCount, total, hasRegistration: registeredCount > 0 };
}

function makeGroup(templateId, model = null) {
  return { templateId, model, models: new Set(), lots: [], completed: [], people: new Map(), unnamed: [] };
}

/**
 * 唯一の表示用集計。入力は既存購読の lots/templates/workers/settings から渡す。
 * lots=null は未受領、[] は受領した範囲で0件。historyComplete=true は呼ぶ側が確認した時だけ。
 * 同一 lot.id は先勝ちで1回（重複数を警告）。id が無い入力は配列の1要素=1ロットで警告。
 * 名前は既存契約のまま完全一致。空白・改名・同姓同名を画面で推測して結合しない。
 * workerId の補完は tasks に名前が1つも無い時だけ。これは担当欄からの補完として内数を残す。
 * 回数が1でも0でも全員を残す。候補・優先順位・割付の計算はしない。
 */
export function buildSkillGrid({ lots = null, templates = null, workers = null, skills = [], workerSkills = null, historyComplete = false, sourceLabel = '' } = {}) {
  const templateList = list(templates);
  const workerList = list(workers);
  const templateById = new Map(templateList.map((template) => [text(template.id), template]));
  const skillNames = new Map(list(skills).map((skill) => [text(skill.id), text(skill.name)]));
  const allNames = new Set(workerList.map((worker) => nameOf(worker.name)).filter(Boolean));
  Object.keys(object(workerSkills) ? workerSkills : {}).forEach((name) => { if (nameOf(name)) allNames.add(name); });
  const groups = new Map();
  const byTemplate = new Map(templateList.map((template) => [text(template.id), makeGroup(text(template.id))]));
  const seen = new Set();
  const audit = { completedLotCount: 0, duplicateLotCount: 0, missingLotIdCount: 0, unnamedLotCount: 0, fallbackLotCount: 0, missingModelLotCount: 0, missingTemplateLotCount: 0, ambiguousWorkerNameCount: 0 };
  let includedLotCount = 0;
  list(lots).forEach((lot, index) => {
    const lotId = text(lot.id);
    const lotKey = lotId ? keyOf('id', lotId) : keyOf('input', index);
    if (seen.has(lotKey)) { audit.duplicateLotCount += 1; return; }
    seen.add(lotKey);
    includedLotCount += 1;
    if (!lotId) audit.missingLotIdCount += 1;
    const templateId = text(lot.templateId);
    const model = text(lot.model);
    if (!model) audit.missingModelLotCount += 1;
    if (!templateById.has(templateId)) audit.missingTemplateLotCount += 1;
    const rowKey = keyOf(templateId, model);
    if (!groups.has(rowKey)) groups.set(rowKey, makeGroup(templateId, model));
    if (!byTemplate.has(templateId)) byTemplate.set(templateId, makeGroup(templateId));
    const targets = [groups.get(rowKey), byTemplate.get(templateId)];
    const completed = lot.status === 'completed';
    const participants = new Set();
    let fallback = false;
    if (completed) {
      audit.completedLotCount += 1;
      Object.values(lot.tasks || {}).forEach((task) => {
        const name = nameOf(task?.workerName);
        if (name) participants.add(name);
      });
      if (!participants.size && lot.workerId) {
        const name = nameOf(workerList.find((worker) => worker.id === lot.workerId)?.name);
        if (name) { participants.add(name); fallback = true; audit.fallbackLotCount += 1; }
      }
      if (!participants.size) audit.unnamedLotCount += 1;
      participants.forEach((name) => allNames.add(name));
    }
    const ref = { key: lotKey, lotId, label: text(lot.orderNo) || lotId || `入力 ${index + 1}`, model: model || '型式未記入', source: fallback ? 'lot_worker' : 'task_name' };
    targets.forEach((group) => {
      group.models.add(model || '型式未記入');
      group.lots.push(ref);
      if (!completed) return;
      group.completed.push(ref);
      if (!participants.size) group.unnamed.push(ref);
      participants.forEach((name) => {
        if (!group.people.has(name)) group.people.set(name, []);
        group.people.get(name).push(ref);
      });
    });
  });

  const pausedNames = pausedNamesOf(workerList);
  const people = [...allNames].sort(compare).map((name) => {
    const records = workerList.filter((worker) => worker.name === name);
    const ambiguous = records.length > 1;
    if (ambiguous) audit.ambiguousWorkerNameCount += 1;
    return { name, paused: pausedNames.has(name), inRoster: records.length > 0, ambiguous };
  });
  const finish = (group) => {
    const template = templateById.get(group.templateId);
    const cells = people.map((person) => {
      const references = group.people.get(person.name) || [];
      const count = references.length;
      const fallbackCount = references.filter((ref) => ref.source === 'lot_worker').length;
      const registration = registrationOf(template, person.name, workerSkills, skillNames);
      const state = count ? (registration.hasRegistration ? 'both' : 'history')
        : registration.hasRegistration ? 'registration' : 'neither';
      return { workerName: person.name, count, fallbackCount, references, registration, state };
    });
    return {
      key: keyOf(group.templateId, group.model), templateId: group.templateId,
      templateName: template?.name || (group.templateId ? `テンプレ不明 (${group.templateId})` : 'テンプレ未記入'),
      model: group.model, models: [...group.models].sort(compare),
      completedLotCount: group.completed.length, inputLotCount: group.lots.length,
      unnamedLotCount: group.unnamed.length, cells,
    };
  };
  const rowOrder = (a, b) => compare(a.templateName, b.templateName) || compare(text(a.model), text(b.model)) || compare(a.key, b.key);
  return {
    version: 1,
    ready: Array.isArray(lots) && Array.isArray(templates) && Array.isArray(workers),
    sourceLabel: text(sourceLabel), historyComplete: historyComplete === true,
    registrationProvided: object(workerSkills), includedLotCount,
    people, rows: [...groups.values()].map(finish).sort(rowOrder),
    templateRows: [...byTemplate.values()].map(finish).sort(rowOrder), audit,
  };
}
