// ============================================================================
// 🚗 型式マスタ (settings.modelMasters) の解決ロジック
// ----------------------------------------------------------------------------
// 「品質規格マスタ」の後継。型式を主役にして、型式ごとに
//   ・使うテンプレート(複数可)
//   ・品質規格番号(standardNo) … **任意**。調べるのに時間がかかるので必須にしない。
//     分かった時に書けばよく、空でも全部動く。
//   ・K33日からの検査日オフセット(daysBefore) … 進捗管理表Excel取込の互換用
//   ・工程プロファイル(stepProfile) … 「使う/該当なし」トグルの保存先
// を登録する。
//
// データ構造:
//   settings.modelMasters: {
//     [型式名]: {
//       model, note, createdAt, updatedAt,
//       templates: [{ templateId, standardNo, revision, daysBefore, stepProfile, ... }]
//     }
//   }
//
// ⚠旧・品質規格マスタ(settings.qualityStandards)から取り込んだエントリは
//   measurementOverrides / measurementConditions / defaultValues / checklistItemsByStep も
//   そのまま持ち込む。適用は App.jsx の applyQualityStandardToSteps が互換のまま面倒を見る
//   (= ここは「どのエントリが効くか」を決めるだけ。工程への焼き付けはしない)。
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/**
 * エントリが「実質空」かどうか。
 * ModelMasterPanel の「テンプレート追加」は {templateId:'', standardNo:'', revision:''} を即保存する。
 * この空エントリが templateId 空(=全テンプレ共通の catch-all)として全テンプレに解決されると、
 * 中身の無い規格が「効いている」ことになってしまうため、解決側で無害化する(保存側は変えない)。
 * 判定: templateId 以外のフィールドに実データが1つも無ければ空。
 *   - null / undefined / '' / 空オブジェクト / 空配列 は「データ無し」
 *   - 数値の 0 や false は実データ扱い (daysBefore: 0 などは意味を持つ)
 */
export const isEmptyEntry = (e) => {
  if (!e || typeof e !== 'object') return true;
  return Object.entries(e).every(([k, v]) => {
    if (k === 'templateId') return true; // 所属の指定であって「中身」ではない
    if (v == null || v === '') return true;
    if (typeof v === 'object') return Object.keys(v).length === 0; // {} / [] は空
    return false;
  });
};

/**
 * 型式マスタから (model, templateId) に効くエントリを探す。
 * 優先順位 (旧・品質規格マスタの entry 解決と同じ考え方):
 *   - templateId 指定時: templateId 完全一致 → templateId 空('')の共通エントリ
 *   - templateId 未指定時: templateId 空の共通エントリ → 1件しか無いときだけそれを採用
 *     (複数あるのにどれか分からない時は null = 誤適用しない)
 * ⚠templateId が空で中身も実質空のエントリ(追加ボタン直後の未入力行)は catch-all として採用しない。
 * @returns { entry, master, source: 'modelMaster' } | null
 */
export const resolveModelEntry = (settings, model, templateId = null) => {
  if (!model) return null;
  const masters = settings && settings.modelMasters;
  if (!masters || typeof masters !== 'object') return null;
  const master = masters[model];
  if (!master || typeof master !== 'object') return null;
  const list = (Array.isArray(master.templates) ? master.templates : [])
    .filter(e => e && typeof e === 'object')
    // 空の catch-all(templateId 空+中身なし)は候補から外す。templateId 付きは中身が無くても
    //  「この型式はこのテンプレを使う」という指定なので従来どおり残す。
    .filter(e => e.templateId || !isEmptyEntry(e));
  if (list.length === 0) return null;
  let entry = null;
  if (templateId) {
    entry = list.find(e => e.templateId === templateId)
      || list.find(e => !e.templateId)
      || null;
  } else {
    entry = list.find(e => !e.templateId)
      || (list.length === 1 ? list[0] : null);
  }
  if (!entry) return null;
  return { entry, master, source: 'modelMaster' };
};

/**
 * 型式専用テンプレ(model_templates コレクション)の docId。
 * ⚠決め打ちにして upsert できるようにする (同じ 型式×テンプレ は常に1ドキュメント)。
 * ⚠型式名は自由入力(記号・空白あり)なので encodeURIComponent で安全にする。
 */
export const modelTemplateDocId = (model, templateId) =>
  `mt_${encodeURIComponent(String(model))}__${templateId}`;

/**
 * 購読済み model_templates 配列から (model, templateId) の専用テンプレを探す。
 * 無ければ null (= 共通の工程テンプレートを使う)。
 */
export const findModelTemplate = (modelTemplates, model, templateId) => {
  if (!model || !templateId) return null;
  return (Array.isArray(modelTemplates) ? modelTemplates : [])
    .find(d => d && d.model === model && d.templateId === templateId) || null;
};
