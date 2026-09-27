// Phase 1: 目標逆算エンジン (純関数)。
//   会社目標 → 必要削減時間 → 残り → 必要計画在庫(成功率で割増) → 候補の組み合わせ提案。
//   足りない時は「不足」と正直に返す(数字を作らない)。C評価(標本少/目標未較正)は自動採用しない(仕様5.3)。

// 必要削減時間: 金額目標(円→時間)と時間目標(基準工数×%)の大きい方(仕様2)。
export const goalGapOf = ({ moneyTargetYen = 0, chargePerHour = 2800, baselineAnnualLaborSec = 0, reductionPct = 10, verifiedFixedYen = 0 } = {}) => {
  const moneyRequiredHours = chargePerHour > 0 ? moneyTargetYen / chargePerHour : 0;
  const timeRequiredHours = (baselineAnnualLaborSec / 3600) * (reductionPct / 100);
  const requiredHours = Math.max(moneyRequiredHours, timeRequiredHours);
  const fixedHours = chargePerHour > 0 ? verifiedFixedYen / chargePerHour : 0;
  const remainingHours = Math.max(0, requiredHours - fixedHours);
  return { moneyRequiredHours, timeRequiredHours, requiredHours, fixedHours, remainingHours };
};

// 候補の信頼度: A=台数登録済+標本十分+目標較正済 / B=標本は十分だがどれか推定 / C=標本少or目標未較正(自動採用しない)
export const gradeCandidate = ({ n = 0, annualUnitsSource = 'estimated', hasTarget = false, targetSuspect = false, minN = 10 } = {}) => {
  if (!hasTarget || targetSuspect || n < minN) return { grade: 'C', confidence: 0.35 };
  if (annualUnitsSource === 'actual') return { grade: 'A', confidence: 0.8 };
  return { grade: 'B', confidence: 0.6 };
};

// ランキング行 → 候補 (期待値 = 短縮余地時間 × 信頼度)。重複キー=アプリ×型式×テンプレ×工程。
export const candidateOf = (row, { appId = 'product', targetSuspect = false } = {}) => {
  const g = gradeCandidate({ n: row.n, annualUnitsSource: row.annualUnitsSource, hasTarget: row.hasTarget, targetSuspect });
  const saveHours = (row.annualSaveSec || 0) / 3600;
  return {
    key: `${appId}||${row.model || ''}||${row.templateId || ''}||${row.stepKey || ''}`,
    appId, model: row.model || '', templateId: row.templateId || '', templateName: row.templateName || '',
    stepKey: row.stepKey || '', stepTitle: row.stepTitle || '', n: row.n || 0,
    saveHours, saveYen: row.annualSaveYen || 0,
    grade: g.grade, confidence: g.confidence,
    expectedHours: saveHours * g.confidence,
  };
};

// 組み合わせ提案: 期待値の大きい順にA/B候補を積み、必要計画在庫(残り÷成功率)に届くまで選ぶ。
//   届かなければ sufficient=false + 不足時間を正直に返す。C候補は数に入れず「要観測」として別枠。
export const planPortfolio = ({ candidates = [], remainingHours = 0, successRatePct = 70, openKeys = null, maxPick = 30 } = {}) => {
  const rate = Math.min(0.95, Math.max(0.3, (Number(successRatePct) || 70) / 100));
  const pipelineRequiredHours = remainingHours / rate;
  const seen = new Set();
  const usable = [], needsObservation = [];
  candidates.forEach(c => {
    if (!c || !(c.saveHours > 0)) return;
    if (seen.has(c.key)) return; // 同じ場所の二重計上を物理的に防ぐ(仕様6-1)
    seen.add(c.key);
    if (openKeys && openKeys.has(c.key)) return; // 既にカルテ進行中の場所は在庫に数えない
    (c.grade === 'C' ? needsObservation : usable).push(c);
  });
  usable.sort((a, b) => b.expectedHours - a.expectedHours);
  const picked = [];
  let sum = 0;
  for (const c of usable) {
    if (sum >= pipelineRequiredHours || picked.length >= maxPick) break;
    picked.push(c); sum += c.expectedHours;
  }
  const totalUsableHours = usable.reduce((s, c) => s + c.expectedHours, 0);
  return {
    pipelineRequiredHours, successRatePct: rate * 100,
    picked, pickedExpectedHours: sum,
    sufficient: sum >= pipelineRequiredHours,
    shortfallHours: Math.max(0, pipelineRequiredHours - totalUsableHours),
    totalUsableHours, usableCount: usable.length,
    needsObservation: needsObservation.sort((a, b) => b.saveHours - a.saveHours),
  };
};
