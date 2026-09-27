// 効果確定ゲート (純関数): 「効果あり」を許可する条件と、30日定着確認。
// 清水の決定(2026-07-19): verified(確定) は 自動判定improved + 前後標本 + 品質ガード + 30日定着 を全部通ったものだけ。
//   - 5%未満の小改善(判定flat)が正の金額のまま確定へ入るのを遮断する
//   - ベースライン標本不足のまま実施後5台だけで効果ありにするのを遮断する
import { PDCA_MIN_N } from './verdictEngine.js';

export const SUSTAIN_DAYS = 30;            // 定着確認までの日数 (60/90日は後回し)
export const QUALITY_TOL_PCT = 20;         // 品質ガード: 不具合率がこの%を超えて悪化したらNG
export const QUALITY_MIN_UNITS = 10;       // 品質ガード判定に必要な片側の最小検査機会数

// 品質ガード: 時間が縮んでも不具合率(件数/検査機会)が悪化していたら「効果あり」にしない。
//   機会数が足りない場合は 'unknown' (暫定にはできるが、確定の金額には品質確認済みの注記がつく)。
export const qualityGuardOf = ({ beforeDefects = 0, beforeUnits = 0, afterDefects = 0, afterUnits = 0, tolerancePct = QUALITY_TOL_PCT, minUnits = QUALITY_MIN_UNITS } = {}) => {
  if (!(beforeUnits >= minUnits) || !(afterUnits >= minUnits)) {
    return { passed: 'unknown', reason: `検査機会不足(前${beforeUnits}/後${afterUnits}・各${minUnits}以上で判定)`, beforeRate: null, afterRate: null };
  }
  const beforeRate = beforeDefects / beforeUnits;
  const afterRate = afterDefects / afterUnits;
  // ベースライン0件の場合: 実施後も0なら合格。発生していたら悪化(0→有)としてNG。
  const passed = beforeRate === 0 ? afterRate === 0 : afterRate <= beforeRate * (1 + tolerancePct / 100) + 1e-9;
  return { passed, reason: passed ? '' : `不具合率が悪化(${(beforeRate * 1000).toFixed(1)}→${(afterRate * 1000).toFixed(1)}件/1000機会)`, beforeRate, afterRate };
};

// 「効果あり」で閉じてよいか。ok=false の理由は全部 reasons に入る(ユーザーへそのまま表示)。
export const canCloseEffective = ({ verdict, before, after, quality, kpi = 'time', minN = PDCA_MIN_N, action = '', owner = '', actionDate = null } = {}) => {
  const reasons = [];
  if (!verdict || verdict.result !== 'improved') reasons.push(`自動判定が「改善」ではありません(現在: ${verdict ? verdict.result : 'なし'}・5%以上の改善が必要)`);
  if (kpi !== 'defectRate') {
    if (!before || (before.n || 0) < minN) reasons.push(`改善前の標本が${before?.n || 0}件(${minN}件以上必要)`);
    if (!after || (after.n || 0) < minN) reasons.push(`実施後の標本が${after?.n || 0}件(${minN}件以上必要)`);
  }
  if (quality && quality.passed === false) reasons.push(`品質ガードNG: ${quality.reason}`);
  if (!actionDate) reasons.push('対策の実施日がありません(「対策を実施」を先に)');
  if (!String(action || '').trim()) reasons.push('対策の内容が未記入です');
  if (!String(owner || '').trim()) reasons.push('担当が未設定です');
  return { ok: reasons.length === 0, reasons, qualityUnknown: !!quality && quality.passed === 'unknown' };
};

// 30日定着確認の対象か (効果あり・未確認・判定から30日以上)
export const sustainCheckDue = (card, nowMs, days = SUSTAIN_DAYS) => {
  if (!card || card.status !== 'effective' || !card.verdictFrozen) return false;
  if (card.verifiedStage === 'verified' || card.verifiedStage === 'broken') return false;
  const closedAt = card.closedAt || card.verdictFrozen.at || 0;
  return closedAt > 0 && (nowMs - closedAt) >= days * 86400000;
};

// 定着判定: 直近実測の中央値が定着時(afterVal)から tolPct 以内なら sustained。
export const sustainVerdict = ({ afterVal = 0, recentMedian = 0, recentN = 0, tolPct = 5, minN = 3 } = {}) => {
  if (!(afterVal > 0)) return { result: 'unknown', reason: '定着時の値がありません' };
  if (recentN < minN) return { result: 'unknown', reason: `直近の実測が${recentN}件(${minN}件以上で判定)` };
  const ok = recentMedian <= afterVal * (1 + tolPct / 100) + 1e-9;
  return { result: ok ? 'sustained' : 'broken', reason: ok ? '' : `直近中央値${Math.round(recentMedian)}秒が定着時${Math.round(afterVal)}秒より${tolPct}%超悪化` };
};

// カルテの確定段階: 'verified'(30日定着済=確定¥に算入) / 'provisional'(効果あり判定直後=暫定) / 'broken'(定着崩れ=要再確認) / null(未判定)
export const cardStageOf = (card) => {
  if (!card || card.status !== 'effective' || !card.verdictFrozen) return null;
  return card.verifiedStage || 'provisional';
};
