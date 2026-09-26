// === バッチ(まとめて開始)タスクのライブ経過時間 ===============================
// まとめて開始(バッチ)の台は設計として duration に時間を積まない
// (完了時に「壁時計÷台数」で按分する)。起点は task.batchStartedAt が持ち、
// 休憩(toggleBreak)をまたぐと batchStartedAt は休憩分だけ後ろへシフト済み。
//
// 旧表示式 `duration + (now - startTime)` はこの設計を知らず、
//   ・再開で startTime が書き換わると表示が0から数え直しになる
//   ・中断中(paused)は duration=0 のままなので「⏸ 00:00」になる
// という「時間が消えたように見える」症状を起こしていた(2026-08 報告)。
//
// この関数が唯一の表示式。バッチ台は batchStartedAt 起点、通常タスクは従来どおり
// duration 起点で出す。完了済み(batchStartedAt は完了時に null へ戻る)は duration 据置。
export const liveSecOf = (t, now = Date.now()) => {
  if (!t) return 0;
  const base = t.duration || 0;
  if (t.batchStartedAt != null) {
    // 作業中: 起点からの壁時計。時計の逆行(端末間ズレ等)でマイナスにしない。
    if (t.status === 'processing') return base + Math.max(0, Math.floor((now - t.batchStartedAt) / 1000));
    // 中断中: 停止した瞬間(pausedAt)で凍結表示。0に戻さない。
    if (t.status === 'paused' && t.pausedAt) return base + Math.max(0, Math.floor((t.pausedAt - t.batchStartedAt) / 1000));
  }
  // 通常タスク: 作業中は duration + 今セッションの経過、それ以外は duration 据置。
  return (t.status === 'processing' && t.startTime) ? base + Math.floor((now - t.startTime) / 1000) : base;
};

// === まとめて開始の「起点」を tasks から作り直す =================================
// 画面側の batchStartTimes({[stepIdx]: 開始時刻}) は React の state にしか無く、
// 作業画面を閉じて開き直すと空に戻っていた。そのため
//   ・ボタンが「まとめて完了」に戻らず「まとめて開始」に見える
//   ・そこから「続きから開始」を押すと batchStartedAt が今の時刻で上書きされ、
//     バッチ台の唯一の時間の持ち主(=batchStartedAt)が消えて実測が全損する
// という事故が起きていた(2026-08 実機再現: 12:55 → 00:02)。
//
// 保存データ側には batchOwner(=stepIdx) と batchStartedAt が残っているので、
// そこから起点を作り直せる。新しい保存フィールドは一切増やさない。
//
// ・対象は「まだ生きているバッチ台」= status が processing / paused のものだけ。
//   完了時に batchOwner/batchStartedAt を null へ戻す既存規約があるので、
//   完了済み・NG・スキップの台がここに混ざることはない(念のため status で弾く)。
// ・同じ工程に値の違う台がある(個別再開で台ごとに後ろへズレる)場合は最小値を採る。
//   最小値なら、どの台の batchStartedAt よりも前 or 同じ = 完了時の按分で使う
//   フォールバック(t.batchStartedAt ?? batchStart)として安全側に倒れる。
const LIVE_BATCH_STATUS = new Set(['processing', 'paused']);
export const rebuildBatchStartTimes = (tasks) => {
  const out = {};
  if (!tasks || typeof tasks !== 'object') return out;
  Object.values(tasks).forEach((t) => {
    if (!t || t.batchOwner == null || t.batchStartedAt == null) return;
    if (!LIVE_BATCH_STATUS.has(t.status)) return;
    if (!Number.isFinite(t.batchStartedAt)) return;
    const si = t.batchOwner;
    if (out[si] == null || t.batchStartedAt < out[si]) out[si] = t.batchStartedAt;
  });
  return out;
};

// 復元の合成: 既にある起点は絶対に上書きしない(画面側の休憩シフト済みの値が正)。
// 足りない stepIdx だけ tasks から補う。変化が無ければ元のオブジェクトをそのまま返す
// (React の state を無意味に作り替えて再描画ループを起こさないため)。
export const mergeRestoredBatchStartTimes = (prev, restored) => {
  const base = prev && typeof prev === 'object' ? prev : {};
  let changed = false;
  const next = { ...base };
  Object.entries(restored || {}).forEach(([si, ts]) => {
    if (next[si] == null) { next[si] = ts; changed = true; }
  });
  return changed ? next : base;
};
