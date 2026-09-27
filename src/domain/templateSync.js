// ============================================================================
// 🔄 共通の工程テンプレート → 型式専用テンプレ(model_templates) への「反映」
// ----------------------------------------------------------------------------
// 清水さん(2026-08-10):
//   「登録したテンプレが工程テンプレでマスタが変更された場合は、それに関係する型式毎に
//     反映するか反映しないかや、反映する場合は何を反映するかとか細かく決めれたらいい。
//     ただ上書き反映したら、必要な情報まで消してしまうからね」
//
// いま何が起きているか(この設計の出発点):
//   共通テンプレを保存しても、専用テンプレを持つ型式には **永久に届かない**。
//   handleSaveTemplate はそのロットを丸ごと除外し、ロット生成は専用の steps で丸ごと置換する。
//   つまり共通に足した工程は専用型式に出ず、共通から消した工程は残り続ける。
//   **しかもそれが画面のどこにも出ていない**。
//
// ⚠⚠ この機能の一番の恐怖は「上書きで必要な情報が消える」こと。だから:
//   1. **既定では何も反映しない**。差が見えるだけ。
//   2. 反映する時は **消えるものを名指しで数えて見せてから** 確認する。
//   3. 「型式で人が入れた情報」(治具番号・規格値・写真・目標時間…)は **既定OFF**。
//   4. 突き合わせに **並び順(index)を使わない**。工程を1つ足しただけで全部ズレて、
//      無関係な工程どうしを上書きし合う——この設計で一番やってはいけない事故。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/** 反映できるフィールドの定義。⚠画面のチェックボックスはこの配列から作る(手書きしない)。 */
export const SYNC_FIELDS = [
  // --- 集合の操作 ---
  { key: 'addSteps', label: '共通に増えた工程を追加', group: 'set', owner: 'base', defaultOn: true },
  { key: 'removeSteps', label: '共通に無い工程を削除', group: 'set', owner: 'base', defaultOn: false, destructive: true },
  { key: 'reorder', label: '並び順を共通に合わせる', group: 'set', owner: 'base', defaultOn: false },
  // --- A群: 共通が持ち主(反映してよい) ---
  { key: 'title', label: '工程名', group: 'base', paths: ['title'], defaultOn: false },
  { key: 'type', label: '種別（重要/危険/測定）', group: 'base', paths: ['type'], defaultOn: false },
  { key: 'executionMode', label: '実行モード（手動/自動）', group: 'base', paths: ['executionMode'], defaultOn: false },
  { key: 'workResource', label: '使う設備・治具枠', group: 'base', paths: ['workResource'], defaultOn: false },
  { key: 'autoEnd', label: '自動終了の秒数', group: 'base', paths: ['autoEndEnabled', 'autoEndSec'], defaultOn: false },
  { key: 'lotOnce', label: 'ロット1回（段取り）', group: 'base', paths: ['lotOnce'], defaultOn: false },
  { key: 'rotary', label: '分割測定アプリ連携', group: 'base', paths: ['rotaryLink', 'rotaryRole', 'rotaryMode'], defaultOn: false },
  { key: 'observation', label: 'じっと見る要素', group: 'base', paths: ['observationElements', 'observationEnabled'], defaultOn: false },
  { key: 'measurementStructure', label: '測定の入力欄と計算式', group: 'base', paths: ['measurementConfig'], defaultOn: false },
  // --- B群: 型式で人が入れた情報(既定OFF = 消さない側) ---
  { key: 'targetTime', label: '目標時間', group: 'model', paths: ['targetTime'], defaultOn: false },
  { key: 'description', label: '説明文', group: 'model', paths: ['description'], defaultOn: false },
  { key: 'images', label: '写真', group: 'model', paths: ['images'], defaultOn: false },
  { key: 'pdfData', label: 'PDF', group: 'model', paths: ['pdfData'], defaultOn: false },
  { key: 'jigNo', label: '治具番号', group: 'model', paths: ['jigNo'], defaultOn: false },
  { key: 'programNo', label: 'プログラム番号', group: 'model', paths: ['programNo'], defaultOn: false },
  { key: 'checklistItems', label: 'チェック項目', group: 'model', paths: ['checklistItems'], defaultOn: false },
  { key: 'tolerance', label: '規格値（公差）', group: 'model', paths: ['measurementConfig.tolerance'], defaultOn: false },
];

/**
 * ⚠差分計算で **見てはいけない** フィールド。
 *   step.id            = 突き合わせの主鍵(値ではない)
 *   category / parallelSafe / targetTimeCalibrated / __srcId
 *                      = テンプレ編集画面の newStep リテラルに無く、1回編集しただけで消える。
 *                        差分に入れると「編集済みの工程は全部“変更あり”」になってノイズで潰れる。
 *   conditionPreset / qsDefaultValues
 *                      = ロット生成時に注入される物で、テンプレの持ち物ではない。
 */
export const IGNORED_KEYS = new Set(['id', 'category', 'parallelSafe', 'targetTimeCalibrated', '__srcId']);

export const defaultSyncFields = () =>
  Object.fromEntries(SYNC_FIELDS.map(f => [f.key, !!f.defaultOn]));

/** model_templates doc に入っている方針を、既定で埋めて返す。⚠壊れていても止めない。 */
export const syncPolicyOf = (doc) => {
  const p = (doc && doc.syncPolicy) || {};
  const fields = { ...defaultSyncFields() };
  if (p.fields && typeof p.fields === 'object') {
    Object.keys(fields).forEach(k => { if (typeof p.fields[k] === 'boolean') fields[k] = p.fields[k]; });
  }
  return {
    fields,
    stepMap: (p.stepMap && typeof p.stepMap === 'object') ? p.stepMap : {},
    rebakeUntouchedLots: p.rebakeUntouchedLots === true,
    updatedAt: p.updatedAt || 0,
    updatedBy: p.updatedBy || '',
  };
};

// ---------------------------------------------------------------- 突き合わせ
/**
 * 共通の step と 専用の step を対応付ける。
 * ⚠⚠ **並び順(index)では絶対に突き合わせない。**
 *   共通と専用は自由に乖離した2つの配列で、工程を1つ足した/消しただけで以降が全部1つズレ、
 *   無関係な工程どうしを上書きし合う。Excel取込が index を使えるのは
 *   「書き出して戻した=並びが保証されている」からで、ここは前提がまったく違う。
 * 手順: ① id 完全一致 → ② 残った中で title が **どちらにも1つずつ** のときだけ → ③ 打ち切り
 *   ⚠製品の step は category を持たない(UIに入力欄が無く常に空)ので title 単独で突き合わせる。
 *     だから「同名が複数」の打ち切りが必須。
 * @returns {{pairs:{base,ded}[], onlyBase:[], onlyDed:[], ambiguous:{title,baseCount,dedCount}[]}}
 */
export const matchSteps = (baseSteps, dedSteps, stepMap = {}) => {
  const base = (baseSteps || []).filter(Boolean);
  const ded = (dedSteps || []).filter(Boolean);
  const pairs = [];
  const usedDed = new Set();
  const restBase = [];

  // ① 手で結びつけた対応 → ② id 完全一致
  for (const b of base) {
    const mappedId = stepMap && stepMap[b.id];
    const d = ded.find(x => !usedDed.has(x.id) && (mappedId ? x.id === mappedId : x.id === b.id));
    if (d) { pairs.push({ base: b, ded: d }); usedDed.add(d.id); } else { restBase.push(b); }
  }
  const restDed = ded.filter(d => !usedDed.has(d.id));

  // ③ title 完全一致。⚠**両方でちょうど1つずつ** のときだけ。
  const norm = (v) => String(v || '').trim();
  const countBy = (arr) => arr.reduce((m, x) => { const t = norm(x.title); m[t] = (m[t] || 0) + 1; return m; }, {});
  const cb = countBy(restBase), cd = countBy(restDed);
  const onlyBase = [], ambiguous = [];
  const matchedDed = new Set();
  for (const b of restBase) {
    const t = norm(b.title);
    if (!t) { onlyBase.push(b); continue; }
    if (cb[t] === 1 && cd[t] === 1) {
      const d = restDed.find(x => norm(x.title) === t && !matchedDed.has(x.id));
      if (d) { pairs.push({ base: b, ded: d }); matchedDed.add(d.id); continue; }
    }
    if (cd[t] > 0) { ambiguous.push({ title: t, baseCount: cb[t], dedCount: cd[t], base: b }); continue; }
    onlyBase.push(b);
  }
  const onlyDed = restDed.filter(d => {
    if (matchedDed.has(d.id)) return false;
    const t = norm(d.title);
    return !(cb[t] > 0 && cd[t] > 0 && !(cb[t] === 1 && cd[t] === 1)); // 判定不能は onlyDed でなく ambiguous 扱い
  });
  return { pairs, onlyBase, onlyDed, ambiguous };
};

// ---------------------------------------------------------------- 値の比較
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const sameValue = (a, b) => {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch (e) { return false; }
  }
  return a === b;
};

/** 見せるための短い文字列。⚠中身が大きい物(写真・PDF)は「あり/なし」に潰す。 */
export const showValue = (key, v) => {
  if (key === 'images') return `${(v || []).length}枚`;
  if (key === 'pdfData') return v ? 'あり' : 'なし';
  if (key === 'checklistItems') return `${(v || []).length}項目`;
  if (key === 'observationElements') return `${(v || []).length}要素`;
  if (key === 'targetTime') return v ? `${v}秒` : '未設定';
  if (key === 'description') return v ? `${String(v).slice(0, 24)}${String(v).length > 24 ? '…' : ''}` : 'なし';
  if (isEmpty(v)) return 'なし';
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 40); } catch (e) { return '(内容あり)'; } }
  return String(v);
};

/** measurementConfig から「規格値だけ」「構造だけ」を取り出す(比較用) */
const tolerancesOf = (mc) => ((mc && mc.calculations) || []).map(c => ({
  id: c.id, label: c.label,
  nominal: c.nominal, toleranceUpper: c.toleranceUpper, toleranceLower: c.toleranceLower, toleranceEnabled: c.toleranceEnabled,
}));
const structureOf = (mc) => {
  if (!mc) return null;
  return {
    inputs: mc.inputs, layout: mc.layout,
    calculations: (mc.calculations || []).map(c => ({ id: c.id, label: c.label, method: c.method, formula: c.formula, inputIds: c.inputIds, unit: c.unit })),
  };
};

/**
 * ⚠⚠ measurementConfig を **丸ごとコピーしない**。
 *   「入力欄と計算式(共通が持ち主)」と「規格値(型式で人が入れた)」が
 *   同じオブジェクトの中にいるため、丸コピーすると規格値が黙って消える。
 * @returns {{mc, dropped:string[]}} dropped = 専用にしか無くて消える計算の名前
 */
export const mergeMeasurementConfig = (baseMc, dedMc, fields) => {
  const wantStructure = !!fields.measurementStructure;
  const wantTolerance = !!fields.tolerance;
  if (!wantStructure && !wantTolerance) return { mc: dedMc, dropped: [] };
  if (!baseMc) return { mc: wantStructure ? null : dedMc, dropped: [] };
  const dedCalcs = (dedMc && dedMc.calculations) || [];
  const findDed = (c) => dedCalcs.find(x => x.id === c.id)
    || (dedCalcs.filter(x => x.label === c.label).length === 1 ? dedCalcs.find(x => x.label === c.label) : null);
  const src = wantStructure ? baseMc : (dedMc || baseMc);
  const calcs = ((src.calculations) || []).map(c => {
    const d = findDed(c);
    // 規格値を反映しない = 専用の値を **持ち越す**(消さない)
    if (!wantTolerance && d) {
      return { ...c, nominal: d.nominal, toleranceUpper: d.toleranceUpper, toleranceLower: d.toleranceLower, toleranceEnabled: d.toleranceEnabled };
    }
    return { ...c };
  });
  const keptIds = new Set(calcs.map(c => c.id));
  const dropped = wantStructure ? dedCalcs.filter(c => !keptIds.has(c.id) && !calcs.some(x => x.label === c.label)).map(c => c.label || c.id) : [];
  return { mc: { ...src, calculations: calcs }, dropped };
};

/**
 * 差分を作る。⚠A群/B群を必ず分けて返す(危険度が色で分かるように)。
 * @returns {{added:[], removed:[], changed:[], ambiguous:[], counts:{}}}
 */
export const diffTemplate = (baseSteps, dedSteps, stepMap = {}) => {
  const { pairs, onlyBase, onlyDed, ambiguous } = matchSteps(baseSteps, dedSteps, stepMap);
  const changed = [];
  for (const { base, ded } of pairs) {
    const rows = [];
    for (const f of SYNC_FIELDS) {
      if (f.group === 'set') continue;
      if (f.key === 'measurementStructure') {
        if (!sameValue(structureOf(base.measurementConfig), structureOf(ded.measurementConfig))) {
          rows.push({ key: f.key, label: f.label, group: f.group, baseShow: base.measurementConfig ? '設定あり' : 'なし', dedShow: ded.measurementConfig ? '設定あり' : 'なし' });
        }
        continue;
      }
      if (f.key === 'tolerance') {
        if (!sameValue(tolerancesOf(base.measurementConfig), tolerancesOf(ded.measurementConfig))) {
          rows.push({ key: f.key, label: f.label, group: f.group, baseShow: `${tolerancesOf(base.measurementConfig).length}件`, dedShow: `${tolerancesOf(ded.measurementConfig).length}件` });
        }
        continue;
      }
      for (const p of (f.paths || [])) {
        if (IGNORED_KEYS.has(p)) continue;
        if (!sameValue(base[p], ded[p])) {
          rows.push({ key: f.key, label: f.label, group: f.group, path: p, baseShow: showValue(p, base[p]), dedShow: showValue(p, ded[p]) });
          break; // 1フィールドにつき1行(autoEnd などは代表1つでよい)
        }
      }
    }
    if (rows.length) changed.push({ baseId: base.id, dedId: ded.id, title: ded.title || base.title, rows });
  }
  // 並び順のちがい(対応が付いた工程だけで見る)
  const baseOrder = (baseSteps || []).map(s => s.id);
  const dedOrder = (dedSteps || []).map(s => s.id);
  const common = baseOrder.filter(id => dedOrder.includes(id));
  const dedCommon = dedOrder.filter(id => baseOrder.includes(id));
  const reordered = JSON.stringify(common) !== JSON.stringify(dedCommon);
  return {
    added: onlyBase, removed: onlyDed, changed, ambiguous, reordered,
    counts: { added: onlyBase.length, removed: onlyDed.length, changed: changed.length, ambiguous: ambiguous.length },
    hasDiff: onlyBase.length > 0 || onlyDed.length > 0 || changed.length > 0 || reordered,
  };
};

/**
 * ⚠⚠ 反映で **消えるもの** を名指しで数える。押す前に必ず見せる。
 *   「N件を上書きします」だけでは、何が消えるのか誰にも分からない。
 */
export const lossesOf = (baseSteps, dedSteps, fields, stepMap = {}) => {
  const d = diffTemplate(baseSteps, dedSteps, stepMap);
  const losses = [];
  if (fields.removeSteps && d.removed.length) {
    d.removed.forEach(s => {
      const extras = [];
      if (s.jigNo) extras.push(`治具 ${s.jigNo}`);
      if (s.programNo) extras.push(`プログラム ${s.programNo}`);
      if ((s.images || []).length) extras.push(`写真 ${s.images.length}枚`);
      if (s.pdfData) extras.push('PDF');
      if ((s.checklistItems || []).length) extras.push(`チェック ${s.checklistItems.length}項目`);
      if (tolerancesOf(s.measurementConfig).length) extras.push(`規格値 ${tolerancesOf(s.measurementConfig).length}件`);
      losses.push({ kind: 'step', title: s.title || '(名前なし)', detail: extras.join(' / ') || '中身なし' });
    });
  }
  d.changed.forEach(c => {
    c.rows.forEach(r => {
      // B群を反映するとき = 型式で人が入れた値が共通の値で **上書きされる**
      if (r.group === 'model' && fields[r.key]) {
        losses.push({ kind: 'field', title: c.title, detail: `${r.label}: 「${r.dedShow}」→「${r.baseShow}」` });
      }
    });
  });
  return losses;
};

/**
 * 実際に反映した steps を作る。⚠元の配列は壊さない。
 * @returns {{steps, applied:{added,removed,changed}, dropped:string[]}}
 */
export const applySync = (baseSteps, dedSteps, fields, stepMap = {}) => {
  const base = (baseSteps || []).filter(Boolean);
  const ded = (dedSteps || []).filter(Boolean);
  const { pairs, onlyBase, onlyDed } = matchSteps(base, ded, stepMap);
  const pairByDedId = new Map(pairs.map(p => [p.ded.id, p]));
  const dropped = [];
  let changedCount = 0;

  const mergeOne = (b, d) => {
    const out = { ...d };
    let touched = false;
    for (const f of SYNC_FIELDS) {
      if (f.group === 'set' || !fields[f.key]) continue;
      if (f.key === 'measurementStructure' || f.key === 'tolerance') continue; // 下でまとめて
      for (const p of (f.paths || [])) {
        if (IGNORED_KEYS.has(p) || p.includes('.')) continue;
        if (!sameValue(out[p], b[p])) touched = true;
        if (b[p] === undefined) delete out[p]; else out[p] = b[p];
      }
    }
    if (fields.measurementStructure || fields.tolerance) {
      const m = mergeMeasurementConfig(b.measurementConfig, d.measurementConfig, fields);
      if (!sameValue(m.mc, d.measurementConfig)) touched = true;
      if (m.mc == null) delete out.measurementConfig; else out.measurementConfig = m.mc;
      m.dropped.forEach(x => dropped.push(`${d.title || d.id}: ${x}`));
    }
    if (touched) changedCount++;
    return out;
  };

  let steps;
  if (fields.reorder) {
    // 共通の並びを土台に、対応した専用の工程を置く。専用にしか無い物は末尾へ。
    steps = [];
    for (const b of base) {
      const p = pairs.find(x => x.base.id === b.id);
      if (p) steps.push(mergeOne(b, p.ded));
      else if (fields.addSteps && onlyBase.some(x => x.id === b.id)) steps.push({ ...b });
    }
    if (!fields.removeSteps) onlyDed.forEach(d => steps.push({ ...d }));
  } else {
    steps = ded.map(d => {
      const p = pairByDedId.get(d.id);
      return p ? mergeOne(p.base, d) : { ...d };
    });
    if (fields.removeSteps) steps = steps.filter(s => !onlyDed.some(d => d.id === s.id));
    if (fields.addSteps) onlyBase.forEach(b => steps.push({ ...b }));
  }
  return {
    steps,
    applied: {
      added: fields.addSteps ? onlyBase.length : 0,
      removed: fields.removeSteps ? onlyDed.length : 0,
      changed: changedCount,
    },
    dropped,
  };
};
