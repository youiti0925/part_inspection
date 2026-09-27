// 「その人が今日 実際に働いた時間」= 現場マップ／作業予定の **本日実績**。
//
// 🚨 2026-09-07 清水さん「製品検査の現場マップとかで予定(残)と実績あるけど、
//    実績は永遠にゼロのままなんだけど、なんで？」の根っこ:
//    本日実績は `lot.totalWorkTime` **ただ1つ** を読んでいた。ところが本番の写し
//    (2026-09-06 11:45 の写し・604ロット)を読んで数えると
//      ・完了ロット 409件 のうち `totalWorkTime > 0` は **10件だけ**
//      ・一方 `lot.tasks[鍵].duration` に作業時間が在るロットは **417件・623.1時間**
//      ・`totalWorkTime` だけ在って tasks が空のロットは **0件**
//    → 実績の欄はほぼ常に空だったので 0 のままだった。
//
// ここは「数える所を tasks に移す」為の純関数。
// 🚨 日付の決め方(endTime → firstStartTime+duration → …)、やり直し、計測中の扱いは
//    分析タブの「この日に働いた時間」と **同じ** `./dailyWork.js` を呼ぶ。
//    同じ問いに2つ目の計算を作らない。
// ⚠ ただし「分析タブと同じ数」ではない。現場マップ／作業予定は **今この瞬間** を出す画面なので、
//    分析タブが見ていない2つを足す(下の返り値の内訳で、いつでも分けて取り出せる):
//      ・liveSec     … 逐次モードで まだタスクへ書かれていない、回っている分
//      ・fallbackSec … tasks に1秒も無く totalWorkTime だけが在る古いロット
//    実測(2026-09-08): 8:00に開始 → 9:00に1工程ぶん書かれ → 12:00 まだ作業中 のロット1件で、
//    ここは 4.00h(taskSec 3600 + liveSec 10800)、分析タブと同じ3つ(task+rework+running)だけなら 1.00h。
//    数字を横に並べる時は、どちらの数え方かを必ず添える事。
//
// 人の見分け方(分析タブの resolveTaskWorker と同じ規約):
//    ① `task.workerName` が在ればそれが「実際にやった人」。
//       ⚠`lot.workerId` は「いまの持ち主」で、担当を付け替えると変わる。
//         写しでは 1ロットの中に2人以上の workerName が在るロットが 17件あった。
//         持ち主で数えると、この17件の中身が全部いまの持ち主の物になってしまう。
//    ② `task.workerName` が無い記録(写しで 978件)だけ `lot.workerId` で拾う。
//       始めたばかりの工程は完了時まで workerName が入らないので、ここが要る。

import { taskWorkedAt, runningSecondsInRange, reworkSecondsInRange, inRangeMs } from './dailyWork.js';

/** そのタスクを「この人がやった」と数えてよいか。 */
export const taskBelongsToWorker = (task, lot, workerId, workerName) => {
  const name = String((task && task.workerName) || '');
  if (name) return !!workerName && name === String(workerName);
  const owner = (lot && lot.workerId) || '';
  return !!workerId && owner === workerId;
};

/** そのロットの tasks に作業時間(duration>0)が1件でも在るか。 */
export const lotHasTaskSeconds = (lot) => Object
  .values((lot && lot.tasks) || {})
  .some((t) => (Number(t && t.duration) || 0) > 0);

/**
 * 逐次モード(ロット全体のストップウォッチ)で、**まだ tasks に書かれていない**「いま回っている分」。
 * ⚠二重に数えない為の2つの歯止め:
 *   ① そのロットに計測中(status='processing')のタスクが在る時は 0
 *      → そちらは runningSecondsInRange が数えている。
 *   ② 数え始めは「このセッションの開始(workStartTime)」と「最後にタスクへ書かれた終了時刻」の
 *      新しい方。逐次モードの「次へ」は経過をタスクへ書き込むので、書かれた分をもう一度数えない。
 */
export const lotLiveSecondsInRange = (lot, nowMs, fromMs, toMs) => {
  const l = lot || {};
  if (l.status !== 'processing') return 0;
  const st = Number(l.workStartTime) || 0;
  if (!(st > 0)) return 0;
  const tasks = Object.values(l.tasks || {});
  if (tasks.some((t) => t && t.status === 'processing')) return 0;
  let written = st;
  tasks.forEach((t) => { const e = Number(t && t.endTime) || 0; if (e > written) written = e; });
  const end = Math.min(Number(nowMs) || 0, Number(toMs) || 0);
  const start = Math.max(written, Number(fromMs) || 0);
  if (!(end > start)) return 0;
  return Math.floor((end - start) / 1000);
};

/** 既定の「ロットが終わった時刻」。数値だけを見る(App からは toMsAny を渡す)。 */
const defaultLotDoneMs = (lot) => Number((lot && lot.completedAt)) || Number((lot && lot.updatedAt)) || 0;

/**
 * その人が fromMs〜toMs に実際に働いた秒。
 * 返す物: { totalSec, taskSec, reworkSec, runningSec, liveSec, fallbackSec, taskCount, fallbackLotCount }
 *
 * fallbackSec = 「tasks に作業時間が1件も無く、totalWorkTime だけが在る」古いロット。
 *   写しでは0件だが、落とすと本当にそこにしか無い記録が消えるので拾う。
 *   tasks に1秒でも在るロットは対象外なので、二重には数えない。
 */
export const workerWorkedSecondsInRange = (lots, opts = {}) => {
  const {
    workerId = '',
    workerName = '',
    fromMs = 0,
    toMs = 0,
    nowMs = Date.now(),
    lotDoneMsOf = defaultLotDoneMs,
  } = opts;

  let taskSec = 0;
  let reworkSec = 0;
  let runningSec = 0;
  let liveSec = 0;
  let fallbackSec = 0;
  let taskCount = 0;
  let fallbackLotCount = 0;

  (lots || []).forEach((lot) => {
    if (!lot) return;
    const tasks = lot.tasks || {};
    Object.values(tasks).forEach((task) => {
      if (!task || typeof task !== 'object') return;
      if (!taskBelongsToWorker(task, lot, workerId, workerName)) return;
      const dur = Number(task.duration) || 0;
      if (dur > 0) {
        const at = taskWorkedAt(task, lot);
        if (inRangeMs(at.ms, fromMs, toMs)) { taskSec += dur; taskCount += 1; }
      }
      // ★やり直しの時間は task.duration に入らない別枠 (dailyWork.js の注記)
      reworkSec += reworkSecondsInRange(task, fromMs, toMs);
      // まだ終わっていない作業も、その日働いた分として入れる
      runningSec += runningSecondsInRange(task, nowMs, fromMs, toMs);
    });

    // 逐次モードの「まだ書かれていない分」。持ち主のレーンにだけ足す。
    if (workerId && lot.workerId === workerId) {
      liveSec += lotLiveSecondsInRange(lot, nowMs, fromMs, toMs);
    }

    // tasks に1秒も無い古いロットだけ totalWorkTime を拾う
    if (workerId && lot.workerId === workerId && !lotHasTaskSeconds(lot)) {
      const twt = Number(lot.totalWorkTime) || 0;
      if (twt > 0 && inRangeMs(lotDoneMsOf(lot), fromMs, toMs)) {
        fallbackSec += twt / 1000;
        fallbackLotCount += 1;
      }
    }
  });

  return {
    totalSec: taskSec + reworkSec + runningSec + liveSec + fallbackSec,
    taskSec, reworkSec, runningSec, liveSec, fallbackSec, taskCount, fallbackLotCount,
  };
};

/** その日の始まり/終わり(端末の暦)。本日実績はここで切る。 */
export const dayRangeOf = (ms) => {
  const d = new Date(Number(ms) || Date.now());
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  return { fromMs: from, toMs: from + 24 * 60 * 60 * 1000 - 1 };
};
