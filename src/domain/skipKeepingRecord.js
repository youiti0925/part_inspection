// =============================================================================
//  src/domain/skipKeepingRecord.js — 終わっていない工程を「該当なし」で閉じる時、記録を落とさない
// -----------------------------------------------------------------------------
//  🚨⏱ 2026-09-19 作業者の立場での確かめで見つかった穴:
//    最後の1台の「完了」を押し忘れた(計測中の)まま／NGを付けたまま／一時停止のまま「全作業完了」を押すと、
//    その工程が { status:'skipped', duration: 0 } で **丸ごと差し替え** られ、
//    かけた時間も NG の判定も消えていた。ロットは完了扱いなので後から直せない。
//
//  🚨 同じアプリの中に正しい形が既に在った(現場マップの「ロット完了時の自動整理」)。
//    2つの場所で別々に書くと また片方だけ古くなるので、**ここ1本** にする。
//
//  決め方:
//    ・元の記録(task)を丸ごと残し、status だけ 'skipped' にする。
//    ・計測中だった分の経過秒を duration に **足す**。起点は batchStartedAt(まとめて開始・休憩分シフト済み)が先、
//      無ければ startTime。どちらも無ければ 0(勝手に作らない)。
//    ・firstStartTime は元の物を残す(無い時だけ 閉じた時刻)。endTime は閉じた時刻。
//    ・時計は中で読まない(nowMs を渡す)。
// =============================================================================

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 計測中だった分の経過秒。止まっていた工程は 0。
 * @param {object|null} task
 * @param {number} nowMs 閉じる時刻
 */
export function elapsedSecOfRunningTask(task, nowMs) {
  const now = num(nowMs);
  if (now == null || !task || task.status !== 'processing') return 0;
  const from = num(task.batchStartedAt) != null ? num(task.batchStartedAt) : num(task.startTime);
  if (from == null) return 0;
  return Math.max(0, Math.floor((now - from) / 1000));
}

/**
 * 終わっていない工程を「該当なし」で閉じる。記録(時間・判定・写真・担当)は1つも落とさない。
 * @param {object|null} task 元の工程の記録(無ければ null)
 * @param {object} o
 * @param {number} o.nowMs   閉じる時刻(🚨 中で時計を読まない)
 * @param {string} o.reason  なぜ該当なしにしたか
 * @param {string} [o.by]    決めた人(責任者)
 * @returns {object} 保存する工程の記録
 */
export function skipTaskKeepingRecord(task, { nowMs, reason = '', by = '' } = {}) {
  const now = num(nowMs);
  const base = (task && typeof task === 'object') ? task : {};
  const add = elapsedSecOfRunningTask(base, now);
  const out = {
    ...base,
    status: 'skipped',
    duration: (num(base.duration) || 0) + add,
    skipReason: String(reason || ''),
    skipAt: now,
    firstStartTime: base.firstStartTime != null ? base.firstStartTime : now,
    endTime: now,
  };
  if (by) out.skipBy = String(by);
  return out;
}

export default skipTaskKeepingRecord;
