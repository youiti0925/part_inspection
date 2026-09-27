// 🔧 P131 NG を付けた瞬間の「修正のお願い」(製品 App.jsx:16696 shouldSkipReworkContact と 20974 openRepairContact の文面を写した)。
//   既定: OFF(settings.contactFeature.repairOnNg)。止める設定 reworkContactSkip も既定 OFF(cfg.enabled !== true)。

/** 中間分割の精度・バックラッシュNGだけ連絡を出さない判定(製品と同じ)。 */
export const shouldSkipReworkContact = (cfg, templateName, ngReason) => {
  if (!cfg || cfg.enabled !== true) return false;
  const name = String(templateName || '');
  const prefixes = (cfg.templatePrefixes && cfg.templatePrefixes.length) ? cfg.templatePrefixes : ['中間分割'];
  if (!prefixes.some(p => p && name.startsWith(String(p)))) return false;
  const rsn = String(ngReason || '').trim();
  if (!rsn) return false;
  const kws = (cfg.reasonKeywords && cfg.reasonKeywords.length) ? cfg.reasonKeywords : ['バックラッシュ', '分割精度', 'BDS'];
  return kws.some(k => k && rsn.includes(String(k)));
};

/**
 * 修正のお願いの下書き。部品は頭に【品目コード｜品名】を付ける。
 * @param {{ taskKey:string, reason?:string, noteLabel?:string, steps?:Array, itemLabel?:string }} a
 */
export const buildRepairDraft = ({ taskKey, reason = '', noteLabel = '', steps = [], itemLabel = '' } = {}) => {
  const m = String(taskKey || '').match(/^(.*)-(\d+)$/);
  const sid = m ? m[1] : '';
  const uIdx = m ? parseInt(m[2], 10) : null;
  const st = (steps || []).find(s => String(s?.id) === sid) || (steps || [])[parseInt(sid, 10)] || null;
  const stepTitle = st?.title || '';
  const rsnTxt = String(reason || '').trim();
  const unit = uIdx != null && !Number.isNaN(uIdx) ? `${uIdx + 1}台目` : '';
  return {
    kind: 'repair', stepTitle, unitLabel: unit,
    message: `${itemLabel ? `【${itemLabel}】` : ''}${noteLabel ? `【${noteLabel}】` : ''}${stepTitle}${unit ? ` ${unit}` : ''}${rsnTxt ? `：${rsnTxt}` : ''} の修正をお願いします`.trim(),
    chips: rsnTxt ? [rsnTxt] : [],
  };
};
