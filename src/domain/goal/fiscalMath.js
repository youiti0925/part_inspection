// 年間換算効果 と 今年度実現(実績/見込み) の分離 (清水の決定1: 主目標は当面「年間換算」、他2つは別計算・別表示・設定で切替可)
//   年間換算   = 1回あたり短縮 × 年間実施回数 × チャージ (ペースの価値)
//   今年度実績 = 対策実施日から今日までに「実際に実施された回数」× 短縮 × チャージ (realizedExecs=実測件数を渡す。無い時はペース推定で estimated フラグ)
//   今年度見込み = 実績 + 残り日数をペースで走った場合の分
export const fiscalRealizedOf = ({ perUnitSec = 0, occAnnual = 0, actionMs = 0, nowMs = 0, fyStartMs = 0, fyEndMs = 0, charge = 0, realizedExecs = null } = {}) => {
  if (!(perUnitSec > 0) || !actionMs || !fyEndMs) return { realizedYen: 0, forecastYen: 0, realizedExecs: realizedExecs || 0, estimated: realizedExecs == null };
  const from = Math.max(actionMs, fyStartMs);
  const until = Math.min(nowMs, fyEndMs);
  const perDay = occAnnual / 365;
  const estimated = realizedExecs == null;
  const execs = estimated ? Math.max(0, Math.round(perDay * Math.max(0, until - from) / 86400000)) : realizedExecs;
  const realizedYen = Math.round(execs * perUnitSec / 3600 * charge);
  const remainDays = Math.max(0, (fyEndMs - Math.max(nowMs, from)) / 86400000);
  const forecastYen = realizedYen + Math.round(perDay * remainDays * perUnitSec / 3600 * charge);
  return { realizedYen, forecastYen, realizedExecs: execs, estimated };
};

export const GOAL_PRIMARY_METRICS = {
  annualized: '年間換算効果',
  fiscalForecast: '今年度実現見込み',
  fiscalRealized: '今年度実績',
};
