// Phase C: 画面へ出すための集計 (純関数)。App.jsx 側に計算を書かないための層。
//   autoOpportunity.js が「1ロットの自動区間を4つへ割る」担当。ここは複数ロットを束ねる担当。
//
// ⚠混ぜないもの (2026-07-21 是正: 文言と実装が食い違っていた):
//   実測 = 【機械の運転記録(lot.machineRuns)】から作った区間。sessions の有無では決めない。
//   さらに実測の窓で「活用」に数える手作業は【打刻された区間(quality==='confirmed')】だけ。
//     機械だけ実測で人が推定(開始〜終了の幅)なら、それは実測の活用に入れず件数・時間を別に残す。
//   推定 = 開始〜終了からの再構成。実測と合計しない。
//   低信頼 (完了押し忘れ疑い) は最初から除外し、除外件数だけ返す。
import { mergeIntervals } from './timeIntervals.js';
import { autoOpportunityWindows, summarizeWindows, taskWorkIntervals, taskIsMeasured } from './autoOpportunity.js';
import { taskTimeQualityOf } from './taskTimeQuality.js';

const EMPTY = { 件数: 0, 自動時間ms: 0, 休憩ms: 0, 取れた上限ms: 0, 活用ms: 0, 取り逃がしms: 0, 候補なしms: 0 };
const add = (a, b) => Object.fromEntries(Object.keys(EMPTY).map(k => [k, (a[k] || 0) + (b[k] || 0)]));

export const rateOf = (s) => (s && s.取れた上限ms > 0 ? s.活用ms / s.取れた上限ms : null);

const defaultKeyOf = (stepId, u) => `${stepId}-${u}`;

// タスクが評価に使えるか。低信頼・記録不足はここで落とす。
const usable = (t) => {
  const q = taskTimeQualityOf(t).quality;
  return q === 'confirmed' || q === 'estimated';
};

export const buildAutoOpportunityReport = ({
  lots = [], isAuto, keyOf = defaultKeyOf,
  resolveWorkerName = null, resolveTemplateName = null,
} = {}) => {
  if (typeof isAuto !== 'function') return null;

  // 1) 使えるタスクだけに絞る + 除外件数
  let excludedUnreliable = 0, excludedMissing = 0, excludedTrainee = 0;
  const prepared = lots.map(lot => {
    const tasks = {};
    Object.entries(lot.tasks || {}).forEach(([k, t]) => {
      if (!t || typeof t !== 'object') return;
      // 🎓教育中(新人)の記録は「活用できていたか」のものさしに使わない。
      //   新人は自動運転中に手を出さない/出せないのが普通で、率が実力と無関係に下がる。
      //   ⚠件数は必ず 除外 に残す(黙って捨てない)。
      if (t.trainee === true) { excludedTrainee++; return; }
      const q = taskTimeQualityOf(t).quality;
      if (q === 'unreliable') { excludedUnreliable++; return; }
      if (q === 'missing') { excludedMissing++; return; }
      tasks[k] = t;
    });
    return { lot, tasks };
  }).filter(x => Object.keys(x.tasks).length > 0);

  // 2) 全ロット・全作業者の手作業区間 (別ロットの作業も「活用」として数える)
  //    ⚠打刻された区間と、そうでない区間を分ける。実測の窓では前者しか活用に数えない。
  const manualAll = [];
  const manualConfirmed = [];
  prepared.forEach(({ lot, tasks }) => {
    const byId = new Map((lot.steps || []).map(s => [s.id, s]));
    Object.entries(tasks).forEach(([k, t]) => {
      const step = byId.get(k.slice(0, k.lastIndexOf('-')));
      if (!step || isAuto(step)) return;
      const ivs = taskWorkIntervals(t);                          // sessions があればそこから
      ivs.forEach(iv => manualAll.push(iv));
      if (taskIsMeasured(t)) ivs.forEach(iv => manualConfirmed.push(iv));
    });
  });
  const manualMerged = mergeIntervals(manualAll);
  const manualConfirmedMerged = mergeIntervals(manualConfirmed);

  const breaksOf = (lot) => (lot.interruptions || [])
    .filter(i => i && i.type === 'break' && i.startTime && i.endTime && i.endTime > i.startTime)
    .map(i => ({ start: i.startTime, end: i.endTime }));

  // 3) 区間を作る
  const rows = [];
  let unconfirmedMs = 0;                                        // 実測窓に重なったが打刻で確認できなかった手作業
  prepared.forEach(({ lot, tasks }) => {
    autoOpportunityWindows({
      lot: { ...lot, tasks }, isAuto, keyOf,
      manualIntervals: manualMerged, confirmedManualIntervals: manualConfirmedMerged,
      breakIntervals: breaksOf(lot),
    }).forEach(w => {
      unconfirmedMs += (w.usedUnconfirmedMs || 0);
      const first = tasks[keyOf(w.stepId, (w.units || [])[0] ?? 0)] || {};
      // ⚠実測= machineRuns の区間から作られた窓だけ。sessions の有無というラベルで判定しない
      //   (ChatGPT指摘 2026-07-21: 実測と表示しながら開始〜終了の幅で計算していた)
      const measured = !!w.measured;
      rows.push({
        ...w, lotId: lot.id || lot.__id || null, qty: lot.quantity || 1,
        model: lot.model || '(型式なし)',
        templateName: (resolveTemplateName && resolveTemplateName(lot.templateId)) || '(テンプレ不明)',
        worker: first.workerName || (resolveWorkerName && resolveWorkerName(lot.workerId)) || '(担当不明)',
        measured,
      });
    });
  });

  const group = (list, keyer) => {
    const g = new Map();
    list.forEach(r => { const k = keyer(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); });
    return [...g.entries()].map(([key, rs]) => ({
      key, ...summarizeWindows(rs), 率: rateOf(summarizeWindows(rs)),
      ロット数: new Set(rs.map(r => r.lotId)).size,
      実測区間: rs.filter(r => r.measured).length,
    })).sort((a, b) => (b.取り逃がしms + b.候補なしms) - (a.取り逃がしms + a.候補なしms));
  };

  const build = (list) => ({
    全体: { ...summarizeWindows(list), 率: rateOf(summarizeWindows(list)) },
    作業者別: group(list, r => r.worker),
    工程別: group(list, r => `${r.templateName} / ${r.title}`),
    台数別: group(list, r => (r.qty === 1 ? '1台' : r.qty <= 3 ? '2-3台' : r.qty <= 9 ? '4-9台' : '10台以上')),
  });

  const measured = rows.filter(r => r.measured);
  const estimated = rows.filter(r => !r.measured);
  return {
    実測: build(measured),
    推定: build(estimated),
    合算しない理由: '実測(機械の運転記録から作った区間)と推定(開始〜終了からの再構成)は精度が違うため合計しない',
    除外: {
      低信頼: excludedUnreliable, 記録不足: excludedMissing, 教育中: excludedTrainee,
      // 機械は実測でも人の記録が打刻でなかった時間。実測の活用には入れないが、黙って消さずに残す。
      実測窓に重なった未確認手作業ms: unconfirmedMs,
    },
    区間数: { 実測: measured.length, 推定: estimated.length },
    rows,
  };
};

// 画面に出す1行ぶんの表示用(時間は「時」へ)。⚠率の分母は必ず 取れた上限ms。
export const toHours = (ms) => Math.round((ms || 0) / 36000) / 100;
export const summaryView = (s) => ({
  自動時間h: toHours(s?.自動時間ms), 取れた上限h: toHours(s?.取れた上限ms),
  活用h: toHours(s?.活用ms), 取り逃がしh: toHours(s?.取り逃がしms),
  候補なしh: toHours(s?.候補なしms), 休憩h: toHours(s?.休憩ms),
  率pct: s && s.取れた上限ms > 0 ? Math.round((s.活用ms / s.取れた上限ms) * 1000) / 10 : null,
});
