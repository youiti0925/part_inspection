// Phase B: 機械運転セッション (lot.machineRuns) の記録 — 純関数・UI/Firebase非依存。
//
// なぜ必要か (仕様書 3.7 / 5.2):
//   一括5台を10分間 自動測定した場合、機械が動いた壁時計は 10分。
//   現在は「壁時計を台数で割った duration」と「各台に同じ firstStartTime/endTime」が混在しており、
//   台別按分(2分×5台)と作業者評価用の壁時計(10分)が区別できない。
//   作業者の自動中活用評価で 50分 として扱ってはいけない。
//   → 同じ機械が同じ時間に動いたなら machineRun は 1件。台別按分とは別に持つ。
//
// segments: 停止を挟んだら区間を分ける。和集合は timeIntervals.js 側で取る。
// closeReason: 'manual'(手で完了) / 'auto-end'(自動終了) / 'batch'(まとめて完了) / 'reset'(やり直し)

// ⚠ monitoringRequirement(「機械が動いている間、人は離れられますか？」)は撤去した。
//   仕様書 4.4 にあったので実装したが、答えはこのアプリの作りに既にあり、人に設定させる意味がなかった:
//     ① canStartTask が「自動+手動=許可」と決めている = 自動運転中は離れて別作業してよい設計
//     ② 張り付いた時間は interruptions(type='monitoring') で実際に記録される仕組みが既にある
//   よって Phase C は「マスタの申告値」ではなく「実際に監視・中断が記録された時間」だけを差し引く。
//   ⚠既に保存済みの古い step.monitoringRequirement は消さない。読まない(無視する)だけ。

export const machineRunsOf = (lot) => (Array.isArray(lot?.machineRuns) ? lot.machineRuns : []);

// 開いている(最後のsegmentが閉じていない)run
const isOpenRun = (run) => {
  const segs = run?.segments || [];
  const last = segs[segs.length - 1];
  return !!(last && last.startTime && !last.endTime);
};
export const openRunForStep = (lot, stepId) =>
  machineRunsOf(lot).find(r => r.stepId === stepId && isOpenRun(r)) || null;

// 機械が実際に動いた区間 (timeIntervals の mergeIntervals へ渡す形)。
//   ⚠台数で掛けない。segments をそのまま返すだけ。
export const machineIntervalsOf = (lot, { now = null } = {}) => {
  const out = [];
  machineRunsOf(lot).forEach(run => (run.segments || []).forEach(sg => {
    if (!sg?.startTime) return;
    const end = sg.endTime || (now && now > sg.startTime ? now : null);
    if (end) out.push({ start: sg.startTime, end });
  }));
  return out;
};

// ---- 保存直前の一括適用 (作業セッションと同じ choke point で呼ぶ) ----
// resolveKey: taskKey -> { step, unitIdx } | null   (キー形式の違いを呼び出し側で吸収する)
// isAuto:     step -> boolean                       (共通 isAutoStep を渡す)
// 運転が終わった理由を「呼び出し側の申告」ではなく実データから決める (B.1)。
//   ⚠B.0の不具合: closeReason を引数の既定値 'manual' で決めていたため、実画面からは常に 'manual' になり、
//     再開時に探す `closeReason === 'pause'` が絶対に一致せず、一時停止→再開が別runに割れていた。
//     (テスト側が 'pause' を明示的に渡していたため隠れていた)
const closeReasonFor = (stepId, next, resolveKey) => {
  let sawPaused = false, sawAutoEnd = false, sawBatch = 0;
  Object.keys(next || {}).forEach(key => {
    const r = resolveKey(key);
    if (!r || !r.step || (r.step.id || r.step.title) !== stepId) return;
    const t = next[key];
    if (!t) return;
    if (t.status === 'paused') sawPaused = true;
    if (t.autoEnded) sawAutoEnd = true;
    if (t.status === 'completed' || t.status === 'ng') sawBatch += 1;
  });
  if (sawPaused) return 'pause';       // 停止 = 同じ運転の続きになりうる
  if (sawAutoEnd) return 'auto-end';
  if (sawBatch > 1) return 'batch';    // 複数台が同時に完了 = まとめて完了
  return 'manual';
};

export const applyMachineRunTransitions = ({
  lot = {}, prev = {}, next = {}, now, resolveKey, isAuto, workerId = null,
  prevRuns = null,   // B.1: 直前に生成した machineRuns。Firestoreのprop更新を待たずに引き継ぐ
  closeReason = null, // 明示指定は上書き(テスト用)。通常は next から推論する
} = {}) => {
  const baseRuns = Array.isArray(prevRuns) ? prevRuns : machineRunsOf(lot);
  if (!now || !next || typeof resolveKey !== 'function' || typeof isAuto !== 'function') return baseRuns;

  // 自動工程ごとに「今 動いている台」と「さっき動いていた台」を集める
  const running = new Map();  // stepId -> { step, units:Set }
  const scan = (map, acc) => Object.keys(map || {}).forEach(key => {
    const t = map[key];
    if (!t || t.status !== 'processing' || !t.startTime) return;
    const r = resolveKey(key);
    if (!r || !r.step || !isAuto(r.step)) return;
    const id = r.step.id || r.step.title;
    if (!acc.has(id)) acc.set(id, { step: r.step, units: new Set() });
    acc.get(id).units.add(r.unitIdx);
  });
  scan(next, running);

  let runs = baseRuns.map(r => ({ ...r, segments: (r.segments || []).map(s => ({ ...s })) }));

  // ① 動き出した / 動き続けている
  running.forEach(({ step, units }, stepId) => {
    const open = runs.find(r => r.stepId === stepId && isOpenRun(r));
    if (open) {
      // 同じ運転の続き。台が増えていたら unitIndices へ足す (一括で後から台を足した場合)
      const merged = new Set([...(open.unitIndices || []), ...units]);
      open.unitIndices = [...merged].sort((a, b) => a - b);
      return;
    }
    const closed = runs.find(r => r.stepId === stepId && !isOpenRun(r) && r.closeReason === 'pause');
    if (closed) {
      // 一時停止からの再開 = 同じ運転に区間を足す (別の run にしない)
      closed.segments.push({ startTime: now, endTime: null });
      closed.closeReason = null;
      const merged = new Set([...(closed.unitIndices || []), ...units]);
      closed.unitIndices = [...merged].sort((a, b) => a - b);
      return;
    }
    runs.push({
      id: `run${now}-${stepId}`,
      stepId,
      stepTitle: step.title || '',
      unitIndices: [...units].sort((a, b) => a - b),
      resourceId: step.workResource || null,
      workerId,
      segments: [{ startTime: now, endTime: null }],
      closeReason: null,
    });
  });

  // ② 全台が止まった = 運転終了。開いている区間を閉じる
  runs.forEach(run => {
    if (!isOpenRun(run)) return;
    if (running.has(run.stepId)) return; // まだ動いている
    const last = run.segments[run.segments.length - 1];
    last.endTime = Math.max(now, last.startTime);
    run.closeReason = closeReason || closeReasonFor(run.stepId, next, resolveKey);
  });

  return runs;
};
