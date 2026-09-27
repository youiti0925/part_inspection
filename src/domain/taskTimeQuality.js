// 作業時間レコードの品質判定 (純関数)。Phase A の「誤評価を止める」担当。
// ⚠完了処理は startTime を null にする(実測: App.jsx の通常完了/自動終了/一括完了すべて)。
//   そのため startTime だけを見る評価は完了タスクを全部取りこぼす。ここで「0秒/評価なし」と
//   「記録があるが確定できない」を区別し、確定値として見せてはいけないものに印をつける。

export const TIME_QUALITY = {
  confirmed: '確定',      // sessions がある (Phase B以降)
  estimated: '推定',      // firstStartTime〜endTime しかない = 中断が含まれ得る
  unreliable: '低信頼',   // 記録同士が矛盾 (差と duration が大きく違う)
  missing: '記録不足',    // 時刻が無い
};

// 差と duration がこの比率以上ずれていたら「低信頼」(中断・休憩の混入疑い)
const UNRELIABLE_RATIO = 1.5;

export const taskTimeQualityOf = (task) => {
  if (!task) return { quality: 'missing', ms: 0, reason: 'タスクなし' };
  if (Array.isArray(task.sessions) && task.sessions.length > 0) {
    const ms = task.sessions.reduce((s, x) => s + Math.max(0, (x?.endTime || 0) - (x?.startTime || 0)), 0);
    // ⚠B.1 是正: セッションが「有る」だけで確定にしてはいけない。
    //   手入力(manual-entry)や上限超過で畳んだ区間(folded)は quality='estimated' で、打刻ではない。
    //   1本でも estimated が混ざっていれば、そのタスク全体を確定として見せない。
    const list = task.sessions.filter(Boolean);
    const est = list.filter(x => x.quality && x.quality !== 'confirmed');
    if (est.length > 0) {
      const allEst = est.length === list.length;
      return {
        quality: 'estimated', ms,
        sessionCount: list.length, estimatedSessionCount: est.length,
        reason: allEst
          ? '打刻ではない区間から算出(手入力・畳み込み)'
          : `確定${list.length - est.length}本と推定${est.length}本が混在(確定として扱わない)`,
      };
    }
    return { quality: 'confirmed', ms, sessionCount: list.length, estimatedSessionCount: 0, reason: '' };
  }
  const durMs = (task.duration || 0) * 1000;
  const first = task.firstStartTime || task.startTime || null;
  const end = task.endTime || null;
  if (!first || !end) {
    // 時刻が無い。duration だけあっても「いつやったか」が無いので自動運転との重なりは出せない。
    return durMs > 0
      ? { quality: 'missing', ms: durMs, reason: '開始終了時刻がない(時間評価に使えない)' }
      : { quality: 'missing', ms: 0, reason: '記録なし' };
  }
  const spanMs = Math.max(0, end - first);
  if (durMs > 0 && spanMs > 0) {
    const ratio = spanMs / durMs;
    if (ratio >= UNRELIABLE_RATIO) {
      return { quality: 'unreliable', ms: durMs, spanMs, reason: `記録時間${Math.round(durMs / 1000)}秒に対し開始〜終了が${Math.round(spanMs / 1000)}秒(中断・休憩の混入疑い)` };
    }
  }
  return { quality: 'estimated', ms: durMs || spanMs, spanMs, reason: '開始〜終了からの推定(中断が含まれ得る)' };
};

// A01: 完了タスクを「0秒の確定値」として捨てない。評価に使える区間があるかを別に返す。
export const hasUsableInterval = (task) => {
  const q = taskTimeQualityOf(task);
  return q.quality === 'confirmed' || q.quality === 'estimated';
};

// A13: autoLaborPct は設定値であって実測ではない。実測活用率として表示させないためのラベル。
export const autoLaborPctIsMeasured = () => false;
export const autoLaborPctLabel = (pct) =>
  `設定値 ${pct}%（現場実績から計測した拘束率ではありません）`;
