// Phase B: 作業セッション (task.sessions) の記録 — 純関数・UI/Firebase非依存。
//
// なぜ必要か (仕様書 3.6 / 5.1):
//   現在は「累積duration」「最初の開始 firstStartTime」「最後の終了 endTime」しか残らない。
//   10:00〜10:05 作業 / 10:05〜10:20 中断 / 10:20〜10:25 作業 の場合、
//     実作業 = 10分、firstStartTime〜endTime = 25分。
//   自動運転との重なりを正確に出すには「2本の作業区間」そのものが要る。
//
// ⚠設計上の要 (取りこぼし防止):
//   アプリ内の全遷移が守っている不変条件を使う —
//     開始/再開は必ず `startTime: <時刻>` を書き、
//     停止/完了/NG/やり直しは必ず `startTime: null` を書く。
//   よって「保存直前に前回値と比べて startTime の出入りを見る」だけで、
//   20箇所以上ある遷移点を個別に改造せずに全経路を捕捉できる。
//
// ⚠同時編集について — 「多端末でも安全」ではない (B.1 で表現を訂正):
//   開閉は冪等にしてあるが (開く: 既に開いていれば何もしない / 閉じる: 開いていなければ何もしない)、
//   保存は setDoc(merge:true) でありトランザクションではない。
//   同じロットを同時に2端末で操作すると、後から保存した側の sessions 配列で丸ごと上書きされ、
//   もう一方が記録した区間は失われる。冪等性は「二重適用で壊れない」だけで、競合を解決しない。
//   → 運用制約: 同じロットを同時に複数端末で操作しないこと。
//   → 恒久対策(未実施): runTransaction 化、またはセッションを別コレクションへ追記型で持つ。
//
// ⚠容量 (実測 2026-07-20):
//   製品検査の最大ロットは 143KB / 最大 tasks 71件。Firestore上限は1ドキュメント約1MB。
//   sessions を足しても余裕があるが、一時停止を延々繰り返した場合に無限に伸びないよう
//   MAX_SESSIONS_PER_TASK で頭打ちにする(古い順に畳む)。
//   ※最終検査は最大ロットが既に約1MBのため、この方式をそのまま横展開しないこと。

export const MAX_SESSIONS_PER_TASK = 40;

// セッションの品質。confirmed=開始と終了の両方を実際に打刻した区間。
//   estimated=手入力や旧データからの近似。確定と混ぜて表示しない(仕様書 5.4)。
export const SESSION_QUALITY = { confirmed: 'confirmed', estimated: 'estimated' };

export const sessionsOf = (task) => (Array.isArray(task?.sessions) ? task.sessions : []);

// 開いている(終了時刻が未設定の)セッション。正常なら高々1本。
export const openSessionIndex = (task) => sessionsOf(task).findIndex(s => s && s.startTime && !s.endTime);
export const hasOpenSession = (task) => openSessionIndex(task) >= 0;

// 実作業時間 = 閉じた区間の合計。開いている区間は now を渡した時だけ加える。
export const sessionsDurationMs = (task, now = null) =>
  sessionsOf(task).reduce((sum, s) => {
    if (!s || !s.startTime) return sum;
    const end = s.endTime || (now && now > s.startTime ? now : null);
    return end ? sum + (end - s.startTime) : sum;
  }, 0);

// 古いセッションを畳んで上限に収める。捨てずに1本へまとめる(合計時間を失わないため)。
const capSessions = (list) => {
  if (list.length <= MAX_SESSIONS_PER_TASK) return list;
  const overflow = list.slice(0, list.length - MAX_SESSIONS_PER_TASK + 1);
  const kept = list.slice(list.length - MAX_SESSIONS_PER_TASK + 1);
  const totalMs = overflow.reduce((s, x) => s + Math.max(0, (x.endTime || x.startTime) - x.startTime), 0);
  const folded = {
    id: `${overflow[0].id}+folded`,
    startTime: overflow[0].startTime,
    endTime: overflow[0].startTime + totalMs, // 合計時間は保つが、実時刻の並びは失われる
    workerId: overflow[0].workerId || null,
    workerName: overflow[0].workerName || '',
    source: 'folded',
    quality: SESSION_QUALITY.estimated, // 畳んだ時点で確定ではない
    foldedCount: overflow.length,
  };
  return [folded, ...kept];
};

// セッションを開く (冪等)。
export const openSession = (task, { now, workerId = null, workerName = '', source = 'tap', id = null } = {}) => {
  if (!task || !now) return task;
  if (hasOpenSession(task)) return task; // 既に開いている = 二重適用。何もしない
  const list = sessionsOf(task);
  const next = capSessions([...list, {
    id: id || `s${now}-${list.length}`,
    startTime: now,
    endTime: null,
    workerId,
    workerName,
    source,
    quality: SESSION_QUALITY.confirmed,
  }]);
  return { ...task, sessions: next };
};

// セッションを閉じる (冪等)。担当交代に対応するため、閉じる側の担当者も残せる。
export const closeSession = (task, { now, workerId = null, workerName = '' } = {}) => {
  if (!task || !now) return task;
  const idx = openSessionIndex(task);
  if (idx < 0) return task; // 開いていない = 二重適用、または打刻なしの手入力。何もしない
  const list = sessionsOf(task).slice();
  const cur = list[idx];
  list[idx] = {
    ...cur,
    endTime: Math.max(now, cur.startTime), // 時計ずれで負の区間を作らない
    // 開始時に担当が分からなかった場合だけ、閉じた側の担当で補う(開始担当を上書きしない)
    workerId: cur.workerId || workerId || null,
    workerName: cur.workerName || workerName || '',
    ...(workerId && cur.workerId && workerId !== cur.workerId
      ? { closedByWorkerId: workerId, closedByWorkerName: workerName || '' } // 担当交代の痕跡(仕様書 T15)
      : {}),
  };
  return { ...task, sessions: list };
};

// 手入力で時間を直した場合。打刻が無いので確定にしない(仕様書の禁止事項)。
export const setEstimatedSession = (task, { startTime, durationSec, workerId = null, workerName = '' } = {}) => {
  if (!task || !startTime || !(durationSec > 0)) return task;
  return {
    ...task,
    sessions: [{
      id: `est${startTime}`,
      startTime,
      endTime: startTime + durationSec * 1000,
      workerId, workerName,
      source: 'manual-entry',
      quality: SESSION_QUALITY.estimated,
    }],
  };
};

// ---- 保存直前の一括適用 (全遷移経路の共通入口) ----
// prev/next は tasks マップ。startTime の出入りだけを見て開閉する。
//   waiting/paused → processing : prev.startTime なし → next.startTime あり = 開く
//   processing → paused/completed/ng : prev.startTime あり → next.startTime なし = 閉じる
// 返り値は next を書き換えた新しい tasks マップ (元は破壊しない)。
export const applySessionTransitions = ({ prev = {}, next = {}, now, workerId = null, workerName = '' } = {}) => {
  if (!now || !next) return next;
  const out = { ...next };
  Object.keys(next).forEach(key => {
    const before = prev[key] || null;
    const after = next[key];
    if (!after || typeof after !== 'object') return;
    const wasRunning = !!(before && before.startTime);
    const isRunning = !!after.startTime;
    if (!wasRunning && isRunning) {
      out[key] = openSession(after, { now: after.startTime, workerId, workerName });
    } else if (wasRunning && !isRunning) {
      // ⚠区間の終わりは「アプリが実際に使った時刻」に合わせる。
      //   保存時刻(now)で閉じると duration との間に毎回1〜2秒ずれる(実機で実測)。
      //   完了は endTime、一時停止は pausedAt、NGは ngAt が正。どれも無ければ now。
      const closeAt = after.endTime || after.pausedAt || after.ngAt || now;
      out[key] = closeSession(after, { now: closeAt, workerId, workerName });
    }
    // 変化なし = 触らない (durationだけの更新などで余計な書き込みを増やさない)
  });
  return out;
};
