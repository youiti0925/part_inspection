// PDCA効果判定エンジン (純関数・UIとFirebaseに依存しない)
// App.jsx から抽出。テストは __tests__/verdictEngine.test.mjs (node --test)。
// ⚠変更時は必ず npm test を通すこと。判定しきい値の変更は貯金箱「確定」の金額に直結する。
export const PDCA_MIN_N = 5;            // 効果判定に必要な片側の最小標本数
export const PDCA_THRESHOLD_PCT = 5;    // 改善/悪化と判定する変化率しきい値(%)
export const PDCA_STALE_DAYS = 14;      // 対策実施から効果が出ない/悪化を「放置」と見なす日数
// defectRate の分母は「検査機会(台数)」。旧凍結データのみ日数分母で比較(computeVerdict内で自動フォールバック)。
export const PDCA_KPIS = { time: '工程時間(中央値)', sigma: 'ばらつき(σ)', achievement: '達成率', defectRate: '不具合率(件÷検査機会)' };

// 統計オブジェクトの窓日数 (古いカルテ等で days 欠落時は startMs/endMs から復元)
export const pdcaWindowDays = (stat) => {
  if (!stat) return 1;
  if (stat.days) return stat.days;
  if (stat.startMs != null && stat.endMs != null && isFinite(stat.endMs)) return Math.max(1, (stat.endMs - stat.startMs) / 86400000);
  return 1;
};

export const pdcaKpiValue = (stat, kpi) => {
  if (!stat) return null;
  if (kpi === 'achievement') return stat.achievementRate;
  if (kpi === 'sigma') return stat.sigma;
  if (kpi === 'defectRate') return stat.defectCount;
  return stat.median || stat.mean;
};

export const computeVerdict = (baseline, after, kpi = 'time') => {
  const label = PDCA_KPIS[kpi] || PDCA_KPIS.time;
  const higherBetter = kpi === 'achievement';
  if (!baseline || !after) return { result: 'insufficient', reason: '測定データなし', label };
  const nB = baseline.n || 0, nA = after.n || 0;
  const bv = pdcaKpiValue(baseline, kpi), av = pdcaKpiValue(after, kpi);
  // 件数系(不具合)以外は片側5標本以上を要求
  if (kpi !== 'defectRate' && (nB < PDCA_MIN_N || nA < PDCA_MIN_N)) {
    return { result: 'insufficient', reason: `標本不足(前${nB}/後${nA}件・各${PDCA_MIN_N}件以上必要)`, label, nBefore: nB, nAfter: nA, beforeVal: bv, afterVal: av, higherBetter };
  }
  // 不具合件数: 分母は「検査機会(台数)」を最優先 (生産量が変わっても歪まない)。
  //   前後どちらかに unitsSeen が無い旧凍結データは、従来の「1日あたり件数」で比較(後方互換)。
  if (kpi === 'defectRate') {
    if (bv == null || av == null) return { result: 'insufficient', reason: '比較値が不足', label, nBefore: nB, nAfter: nA, beforeVal: bv, afterVal: av, higherBetter };
    const useUnits = (baseline.unitsSeen || 0) > 0 && (after.unitsSeen || 0) > 0;
    const bRate = useUnits ? bv / baseline.unitsSeen : bv / pdcaWindowDays(baseline);
    const aRate = useUnits ? av / after.unitsSeen : av / pdcaWindowDays(after);
    const deltaPct = bRate > 0 ? Math.round(((aRate - bRate) / bRate) * 1000) / 10 : null;
    let r;
    if (deltaPct == null) r = aRate > 0 ? 'worse' : 'flat';
    else r = deltaPct <= -PDCA_THRESHOLD_PCT ? 'improved' : (deltaPct >= PDCA_THRESHOLD_PCT ? 'worse' : 'flat');
    return { result: r, deltaPct, label, nBefore: nB, nAfter: nA, beforeVal: bv, afterVal: av, higherBetter, denominator: useUnits ? 'units' : 'days' };
  }
  if (bv == null || av == null || bv === 0) return { result: 'insufficient', reason: '比較値が不足', label, nBefore: nB, nAfter: nA, beforeVal: bv, afterVal: av, higherBetter };
  const deltaPct = ((av - bv) / Math.abs(bv)) * 100;
  let result;
  if (higherBetter) result = deltaPct >= PDCA_THRESHOLD_PCT ? 'improved' : (deltaPct <= -PDCA_THRESHOLD_PCT ? 'worse' : 'flat');
  else result = deltaPct <= -PDCA_THRESHOLD_PCT ? 'improved' : (deltaPct >= PDCA_THRESHOLD_PCT ? 'worse' : 'flat');
  return { result, deltaPct: Math.round(deltaPct * 10) / 10, label, nBefore: nB, nAfter: nA, beforeVal: bv, afterVal: av, higherBetter };
};
