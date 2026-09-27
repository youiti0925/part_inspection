// ============================================================================
// ⏱ そのロットの「残り時間」— 進み具合(タスク)から数える
// ----------------------------------------------------------------------------
// ⚠⚠ 2026-08-11 清水さんの指摘:
//   「作業予定の個人の予定時間が、そのロットが残り79%になってるのに
//     0%で計算されてるように見える。ちゃんと計算して」
//
//   原因: 残りを **経過時間** から引いていた（見積 − 経過）。
//     ・止まっていた時間(残ロット待ち・中断・翌日へ持ち越し)は経過に入らない
//     ・まとめて開始のように「実測が totalWorkTime に積まれない」作りだと経過が拾えない
//     → 23/29 台まで終わっていても、経過が小さいと **ほぼ手つかず扱い** になっていた。
//
//   直し: **まだ終わっていないタスクの目標時間を足す**。
//     終わった物は 0、やらない物(該当なし・抜取)も 0。これなら進み具合がそのまま残りになる。
//
// ⚠⚠ タスクの鍵の決まりは computeLotProgress と **完全に同じ** にする。
//   ここだけ別の鍵で数えると、画面に出る「進捗%」と「残り時間」が食い違う。
//     通常工程   : `${step.id}-${台}`（旧データ用に `${工程の並び順}-${台}` も見る）
//     ロット1回  : `${step.id}-lot-${回}`（分母は実施回数。台数では数えない）
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/** ロット1回工程の鍵を、実施回の順に並べて返す。⚠App.jsx の lotOnceKeysOf と同じ規則。 */
export const defaultLotOnceKeys = (tasks, step) => Object.keys(tasks || {})
  .filter(k => k.startsWith(`${step?.id}-lot-`))
  .sort((a, b) => parseInt(a.slice(a.lastIndexOf('-') + 1)) - parseInt(b.slice(b.lastIndexOf('-') + 1)));

/** その台・その工程は「もう時間がかからない」か。 */
export const isDoneTask = (t) => {
  if (!t) return false;
  // ⚠該当なし・抜取で省略した物も「もう時間はかからない」側。
  if (t.status === 'skipped' || t.samplingSkipped || t.autoNa || t.profileSkipped) return true;
  return t.status === 'completed';
};

/**
 * 残り時間(秒)を、まだ終わっていないタスクの目標時間から数える。
 * @param lot
 * @param targetSecOf (step) => その工程1台あたりの目標秒
 * @param opts.lotOnceKeys (tasks, step) => string[]
 * @returns {{remainingSec, totalSec, doneSec, doneRatio, countedSteps, doneTasks, totalTasks}}
 */
export const remainingByTasks = (lot, targetSecOf, opts = {}) => {
  const steps = Array.isArray(lot?.steps) ? lot.steps : [];
  const qty = Math.max(1, Number(lot?.quantity) || 1);
  const tasks = (lot && lot.tasks) || {};
  const lotOnceKeys = opts.lotOnceKeys || defaultLotOnceKeys;
  let remainingSec = 0, totalSec = 0, countedSteps = 0, doneTasks = 0, totalTasks = 0;

  steps.forEach((step, sIdx) => {
    if (!step) return;
    const t = Number(targetSecOf(step)) || 0;
    if (t <= 0) return;              // 目標時間が無い工程は足しようがない
    countedSteps += 1;

    const add = (task) => {
      totalSec += t; totalTasks += 1;
      if (isDoneTask(task)) doneTasks += 1; else remainingSec += t;
    };

    if (step.lotOnce) {
      // ⚠ロット1回工程は台数を掛けない。分母は実施回数(最低1回)。
      const keys = lotOnceKeys(tasks, step);
      if (keys.length === 0) add(undefined);
      else keys.forEach(k => add(tasks[k]));
      return;
    }
    for (let u = 0; u < qty; u++) {
      add((step.id && tasks[`${step.id}-${u}`]) || tasks[`${sIdx}-${u}`]);
    }
  });

  const doneSec = Math.max(0, totalSec - remainingSec);
  return {
    remainingSec, totalSec, doneSec,
    doneRatio: totalSec > 0 ? doneSec / totalSec : 0,
    countedSteps, doneTasks, totalTasks,
  };
};

/**
 * 表示に使う残り時間。
 * ⚠タスクから数えられない時(工程も目標時間も無い等)だけ、今までどおり「見積 − 経過」に落とす。
 *   落ちたことが分かるように basis を返す(数字には出どころを添える、の決まり)。
 */
export const lotRemainingSec = (lot, targetSecOf, estimatedSec, elapsedSec, opts = {}) => {
  const r = remainingByTasks(lot, targetSecOf, opts);
  if (r.countedSteps > 0 && r.totalSec > 0) {
    return { sec: r.remainingSec, basis: 'tasks', doneRatio: r.doneRatio, totalSec: r.totalSec, doneTasks: r.doneTasks, totalTasks: r.totalTasks };
  }
  const est = Number(estimatedSec) || 0;
  const el = Number(elapsedSec) || 0;
  return {
    sec: Math.max(0, est - el), basis: 'elapsed',
    doneRatio: est > 0 ? Math.min(1, el / est) : 0, totalSec: est, doneTasks: 0, totalTasks: 0,
  };
};
