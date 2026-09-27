// =============================================================================
//  不良 / 軽微不良 / 気づき・改善 を「どこから数えるか」の唯一の定義
//  ⚠このファイルは 製品検査 と 最終検査 で **完全に同一**。片方を直したらもう片方へコピーする。
//
// 【なぜ作ったか(2026-08-14)】
//   同じ月の「軽微不良 何件」が 分析タブ / 管理者ダッシュボード / 月報PDF / 提出用Excel で
//   最大4通りに割れていた。分析タブだけが3ソースを見ていて、他3画面は lot.interruptions だけの1ソース。
//   実測(バックアップ_製品検査_2026-06-07 / 206ロット):
//     2026-05 = 分析タブ 49件 に対し 他3画面 41件 → 8件・16.3% の過少。
//     さらに台帳(minor_reports 18件)は他3画面で全件0。
//   改善活動の結果を「減った」と読む場面で、実際は数える場所が減っていただけ、という誤読が起きる。
//   → 数える場所をこの1本にする。画面ごとに数え直さない。
//
// 【3つの出所】
//   interruption : 検査中に付けた記録 lot.interruptions[]
//   ng           : NG判定の理由 task.ngReason
//   ledger       : 台帳 (製品 = minor_reports / 最終 = field_reports)
//
// 【⚠2アプリで ng の意味が違う — ここが最大の落とし穴】
//   製品 : NG(action==='ng')は task.ngReason を書くだけ。interruption も台帳も一切作らない。
//          → ngReason は本当に独立した記録。数えないと丸ごと欠ける。
//   最終 : NGは必ず不具合報告モーダルを開き、reportDefect が
//          field_reports(type:'defect', source:'inspection-ng') を作ると同時に
//          task.ngReason と **task.ngReportId(その報告のid)** を書く。
//          → ngReason は台帳の写し。両方数えると同じ1件を2回数える。
//   だから重複の判定は **ngReportId があるかどうか** で1件ずつ決める(本番データを見る前に推測で寄せない)。
//   ngReportId が無い古い記録は今まで通り独立した1件として数える(黙って減らさない)。
//   何件を写しとして畳んだかは mergedNg で返す。必ず画面に出すこと。
//
// 【入れない物】
//   ・不良率の分母(完了ロット数)はここでは作らない。台帳の記録はロットに紐づかないので
//     分母に対応する概念が無い。率は今まで通り呼び出し側で「検査中の記録 ÷ 完了ロット」で出す。
//   ・サンプル(製品 minor_reports の sample:true)は落とさず印だけ付けて返す。
//     捨てるか出すかは画面が決める(提出する書類には入れない・分析タブは【サンプル】付きで出す)。
// =============================================================================

// Firestore Timestamp / 数値 / 文字列 のどれでもミリ秒へ。読めなければ null(0にしない=1970年に飛ぶ)
const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v.seconds != null) return v.seconds * 1000;
  const n = new Date(v).getTime();
  return Number.isNaN(n) ? null : n;
};

export const SRC_LABEL = { interruption: '検査中', ng: 'NG判定', ledger: '台帳' };
export const KIND_LABEL = { defect: '不良(不具合)', complaint: '軽微不良', improvement: '気づき・改善' };
const KINDS = ['defect', 'complaint', 'improvement'];

// タスクキー(`${step.id}-${台番号}` / 旧 `${並び順}-${台番号}`)から工程を引く。
// ⚠分析タブに元々あった解決と同じ挙動(_titleForKey / _stepForKey)。見つからなければ null。
export const stepForTaskKey = (steps, key) => {
  const list = Array.isArray(steps) ? steps : [];
  for (const s of list) { if (s && s.id && String(key).startsWith(`${s.id}-`)) return s; }
  const m = /^(\d+)-/.exec(String(key));
  if (m && list[+m[1]]) return list[+m[1]];
  return null;
};

// 台帳の列名は2アプリで違う(製品 = content / stepTitle、最終 = label / stepInfo)。
// 同じファイルを両方に置くため **どちらの名前も読む**。無い方は空になるだけで害はない。
const ledgerText = (r) => (r.content != null ? r.content : (r.label != null ? r.label : '')) || '';
const ledgerStepTitle = (r) => r.stepTitle || (r.stepInfo && r.stepInfo.title) || '';
const ledgerCategory = (r) => r.category || (r.stepInfo && r.stepInfo.category) || '';

/**
 * 3つの出所を1本に合流する。元データは一切書き換えない(読むだけ)。
 * @param {{lots?:Array, ledger?:Array}} src
 * @returns {{rows:Array, mergedNg:number}}
 */
export function collectQualityRows({ lots = [], ledger = [] } = {}) {
  const rows = [];
  const byKey = new Map();
  let mergedNg = 0;
  const push = (row) => {
    if (!row.key || byKey.has(row.key)) return false;
    byKey.set(row.key, row);
    rows.push(row);
    return true;
  };

  // ① 台帳を先に入れる。後から自由に直せる側=こちらを正とする。
  //    ⚠最終検査では台帳へ移した記録が lot.interruptions と **同じ id** を持つことがある。
  //      先に台帳を入れてから id で弾く(既存の集計と同じ重複除外)。
  (ledger || []).forEach((r) => {
    if (!r || !KINDS.includes(r.type)) return;
    push({
      key: String(r.id),
      id: r.id,
      kind: r.type,
      src: 'ledger',
      srcLabel: SRC_LABEL.ledger,
      timestamp: toMs(r.timestamp),
      lotId: r.lotId || null,
      model: r.model || '',
      orderNo: r.orderNo || '',
      category: ledgerCategory(r),
      stepTitle: ledgerStepTitle(r),
      content: ledgerText(r),
      causeProcess: r.causeProcess || '',
      workerName: r.workerName || '',
      improvementKind: r.improvementKind || '',
      severity: r.severity || '',
      sample: !!r.sample,
    });
  });

  // ② 検査中に付けた記録
  (lots || []).forEach((lot) => {
    if (!lot) return;
    (lot.interruptions || []).forEach((i) => {
      if (!i || !KINDS.includes(i.type)) return;
      const ts = toMs(i.timestamp);
      push({
        key: String(i.id || `itr:${lot.id}:${ts}`),
        id: i.id || null,
        kind: i.type,
        src: 'interruption',
        srcLabel: SRC_LABEL.interruption,
        timestamp: ts,
        lotId: lot.id || null,
        model: lot.model || '',
        orderNo: lot.orderNo || '',
        category: (i.stepInfo && i.stepInfo.category) || '',
        stepTitle: (i.stepInfo && i.stepInfo.title) || i.targetStepTitle || '',
        content: i.label || i.note || '',
        causeProcess: i.causeProcess || '',
        workerName: i.workerName || '',
        improvementKind: i.improvementKind || '',
        severity: i.severity || '',
        sample: false,
      });
    });
  });

  // ③ NG判定の理由(task.ngReason)
  //    種別は complaint(軽微不良)。分析タブが元々そう数えていたので変えない。
  //    ⚠ngReportId があれば、それは①で入れた台帳の記録の写し → 数えずに mergedNg へ。
  (lots || []).forEach((lot) => {
    if (!lot) return;
    const steps = lot.steps || [];
    Object.entries(lot.tasks || {}).forEach(([taskKey, t]) => {
      if (!t || typeof t.ngReason !== 'string' || !t.ngReason.trim()) return;
      const key = t.ngReportId ? String(t.ngReportId) : `ng:${lot.id}:${taskKey}`;
      if (byKey.has(key)) { mergedNg++; return; }
      const s = stepForTaskKey(steps, taskKey);
      push({
        key,
        id: `ng:${lot.id}:${taskKey}`,
        kind: 'complaint',
        src: 'ng',
        srcLabel: SRC_LABEL.ng,
        timestamp: toMs(t.ngAt) || toMs(t.endTime),
        lotId: lot.id || null,
        taskKey,
        model: lot.model || '',
        orderNo: lot.orderNo || '',
        category: (s && s.category) || '',
        stepTitle: (s && s.title) || '全体',
        content: t.ngReason.trim(),
        causeProcess: t.ngCauseProcess || '',
        workerName: t.workerName || '',
        improvementKind: '',
        severity: t.ngSeverity || '',
        sample: false,
      });
    });
  });

  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { rows, mergedNg };
}

// 期間内か。startMs 以上 endMs 未満(月の境界と同じ半開区間)。時刻が無い行は入れない。
export const inPeriod = (row, startMs = null, endMs = null) => {
  const t = row && row.timestamp;
  if (t == null) return false;
  if (startMs != null && t < startMs) return false;
  if (endMs != null && t >= endMs) return false;
  return true;
};

/**
 * 画面が使う絞り込み。
 * @param {Array} rows collectQualityRows の rows
 * @param {{kinds?:string[], from?:number|null, to?:number|null, includeSample?:boolean}} opt
 *   includeSample 既定 false = サンプルは数えない。
 *   ⚠提出用(月報PDF/データ出力)に true を渡さない。作り物の記録が会社提出の書類に入る。
 */
export function filterQuality(rows = [], opt = {}) {
  const { kinds = null, from = null, to = null, includeSample = false } = opt;
  return rows.filter((r) => {
    if (!r) return false;
    if (!includeSample && r.sample) return false;
    if (kinds && !kinds.includes(r.kind)) return false;
    if (from != null || to != null) return inPeriod(r, from, to);
    return true;
  });
}

// 出所ごとの件数。画面に必ず出す(数が変わったことを黙らせないため)。
export function sourceBreakdown(rows = []) {
  const out = { interruption: 0, ng: 0, ledger: 0, sample: 0, total: 0 };
  rows.forEach((r) => {
    if (!r) return;
    out[r.src] = (out[r.src] || 0) + 1;
    if (r.sample) out.sample++;
    out.total++;
  });
  return out;
}

// 「検査中41 / NG判定8 / 台帳0」の一行。excludedSample=数えなかったサンプル、mergedNg=写しとして畳んだ件数。
export function sourceNote(rows = [], { mergedNg = 0, excludedSample = 0 } = {}) {
  const b = sourceBreakdown(rows);
  let s = `内訳: ${SRC_LABEL.interruption} ${b.interruption} / ${SRC_LABEL.ng} ${b.ng} / ${SRC_LABEL.ledger} ${b.ledger}`;
  if (excludedSample > 0) s += ` ／ サンプル ${excludedSample}件は数えていません`;
  if (mergedNg > 0) s += ` ／ NG判定 ${mergedNg}件は不具合報告と同じ記録のため二重に数えていません`;
  return s;
}
