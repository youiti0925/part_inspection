// 工程別の年間実施回数と、自動運転時間の人件費分離 (純関数)。
// 清水の決定(2026-07-19): 純粋な自動運転時間は人件費から除外。人が操作する時間+離れられない拘束時間だけを人件費に含める。
//   機械時間の短縮は「設備能力・納期効果」として別表示(人件費と混ぜない)。
//
// 年間実施回数(仕様4.3): 登録年間台数をそのまま全工程に掛けない。
//   - 抜取(1/10なら)   → 実施回数 = 年間台数 × 窓内実施率(実施回数/対象台数=0.1)
//   - ロット1回工程     → 実施回数 = 年間台数 × (窓内実施回数/窓内台数) = 実質ロット回数
//   - 通常(毎台)        → 実施率≈1 で従来と同じ
//   - 年間台数が未登録   → 従来どおり窓内実施回数の365日換算(実施回数ベースなので元々正しい)

// 自動工程判定は src/domain/workExecution.js の共通関数が唯一の正 (2026-07-20統一)。
//   ここは再エクスポートのみ。独自ロジックを書き戻さないこと
//   (旧実装は rotaryLink + 名称のみで判定し、executionMode='manual' の工程まで自動にしていた:
//    実測「分割測定開始_手動」「三次元測定開始」が自動扱いになる不具合があった)。
export { isAutoStep } from '../workExecution.js';

// 年間実施回数: 登録台数があれば「台数×窓内実施率」、無ければ実測回数の年換算。
export const annualOccurrencesOf = ({ useActual = false, inputAnnualUnits = 0, windowExecs = 0, windowUnits = 0, measuredAnnualExecs = 0 } = {}) => {
  if (!useActual || !(inputAnnualUnits > 0)) return { occ: measuredAnnualExecs, source: 'estimated', execPerUnit: null };
  if (!(windowUnits > 0)) return { occ: measuredAnnualExecs, source: 'estimated', execPerUnit: null };
  const execPerUnit = windowExecs / windowUnits; // 抜取1/10なら≈0.1、ロット1回(5台ロット)なら≈0.2、毎台なら≈1
  return { occ: Math.max(0, Math.round(inputAnnualUnits * execPerUnit)), source: 'actual', execPerUnit };
};

// 人件費に入れてよい秒数: 手作業=全額 / 自動=拘束率(autoLaborPct%)分だけ。
//   拘束率は設定(3アプリ共有)。100%=従来どおり全額(上限値)、未計測のまま勝手な数字を仮定しない。
export const laborSecOf = ({ workKind = 'manual', sec = 0, autoLaborPct = 100 } = {}) => {
  if (workKind !== 'auto') return sec;
  const pct = Math.min(100, Math.max(0, Number(autoLaborPct ?? 100)));
  return sec * pct / 100;
};

// 機械時間(設備能力・納期効果として別表示する分): 自動工程の全時間。
export const machineSecOf = ({ workKind = 'manual', sec = 0 } = {}) => (workKind === 'auto' ? sec : 0);
