// 🚦 全ロットを見る開始ガード(ChatGPT live-guards 2026-09-26 を取り込み、Claude が穴を直した)。
//   決まり: 1人の手作業は同時に1つ(自動測定は別)。開いているロットだけでなく、この端末に届いている全ロットを見る。
//   追加の読取り・保存はしない。開いているロットは購読の古い値ではなく、呼出時のローカル状態で置き換える。
//
// 🚨 Claude が直した穴(反証役が本番の写しで再現・数えた 2026-09-26):
//   ① 担当の引き方: 前は「セッションの workerId → ロットの担当」だけで、担当未割当のロット(未完了504件中498件)で名前の作業者が始めた
//      手作業は担当不明になり、**全端末の全員の手作業開始を止めていた**(写しでこの形が108セッション/14ロット)。
//      → task.workerName から作業者を引く。それでも分からない手作業は「誰のか分からない」ので **止めない**(工場を止める方が重い)。
//   ② 管理者・フリー(作業者の記録が無い端末)は 前の作りどおり 開いているロットの中だけを見る(前は一切始められなくなっていた)。
//   ③ 完了ロットは見ない。工程が引けない作業中の記録(工程を後から消した等)は手作業と決めつけない。
//   ④ 自動工程の修正(再測定)は機械が回っている=自動として扱う(手作業を止める理由にしない)。
import { isAutoStep, startGuard } from './workExecution.js';

// IDにハイフンがある工程、旧数値キー、ロット1回のキーを同じ規約で解決する。
export function stepForTask(steps = [], key = '') {
  const match = String(key).match(/^(.+)-(?:lot-)?\d+$/);
  if (!match) return null;
  const ident = match[1].replace(/-lot$/, '');
  return steps.find(s => s?.id === ident)
    || (/^\d+$/.test(ident) ? steps[Number(ident)] : null) || null;
}

export const REWORK_STEP = Object.freeze({ title: '修正作業', executionMode: 'manual' });
export const SEQUENTIAL_KEY = '__sequential__';
const SELF = '__self__';

const isDone = (lot) => lot?.status === 'completed' || lot?.location === 'completed';

// この端末で取得済みの全ロットを参照する。追加読取り・保存は行わない。
// 開いているロットは購読の古い値ではなく、呼出時のローカル状態で置き換える。
//   workers: 作業者マスタ([{id,name}])。task.workerName から担当を引くのに使う(無くても動く)。
export function collectRunningLotTasks({ lots = [], currentLot, workerId, workers = [], masterIndex = null } = {}) {
  const currentId = currentLot?.id || currentLot?.__id;
  const source = lots.filter(l => l && !isDone(l) && (!currentId || (l.id || l.__id) !== currentId));
  if (currentLot) source.push(currentLot);
  const idByName = new Map((workers || []).filter(w => w && w.id && w.name).map(w => [String(w.name).trim(), w.id]));
  const out = [];
  for (const lot of source) {
    const lotId = lot.id || lot.__id;
    const isCurrent = lot === currentLot;
    const owner = isCurrent ? workerId : (lot.workerId || null);
    const steps = lot.steps || [];
    for (const [key, task] of Object.entries(lot.tasks || {})) {
      const rework = task?.status === 'reworking' && !!task.reworkStartTime && !task.reworkPausedAt;
      if (task?.status !== 'processing' && !rework) continue;
      const step = stepForTask(steps, key);
      if (!step) continue;                                   // ③ 工程が引けない記録は手作業と決めつけない
      const session = (task.sessions || []).find(s => s?.startTime && !s.endTime);
      const byName = idByName.get(String(task.workerName || '').trim()) || null;
      out.push({ lotId, key, orderNo: lot.orderNo || '',
        workerId: isCurrent ? owner : (session?.workerId || byName || owner),   // ① 名前からも引く
        // ④ 自動工程の修正(再測定)は機械が回っている=自動。手作業の修正だけ REWORK_STEP
        step: rework && !isAutoStep(step, masterIndex) ? REWORK_STEP : step });
    }
    // 順序実行の手作業は tasks.startTime が無く、ロットの時計で計測される。
    if (lot.executionType === 'sequential' && lot.status === 'processing' && lot.workStartTime) {
      const step = steps[lot.currentStepIndex || 0] || null;
      if (step) out.push({ lotId, key: SEQUENTIAL_KEY, orderNo: lot.orderNo || '', workerId: owner, step });
    }
  }
  return out;
}

export function guardLotTaskStart({ lots, currentLot, workerId, targetStep,
  excludeKey = null, masterIndex = null, workers = [] } = {}) {
  const lotId = currentLot?.id || currentLot?.__id;
  // ② 作業者の記録が無い端末(管理者・フリー・未選択)は、前の作りどおり 開いているロットの中だけ見る
  const me = workerId || SELF;
  const running = collectRunningLotTasks({ lots: workerId ? lots : [], currentLot, workerId: me, workers, masterIndex });
  // ① 誰のか分からない手作業(担当なし・名前も引けない)は止める理由にしない
  const known = running.filter(t => t.workerId);
  const result = startGuard({ workerId: me, targetStep, runningTasks: known,
    excludeKey, excludeLotId: lotId, masterIndex });
  if (result.ok) return result;
  const conflict = known.find(t => t.workerId === me && !isAutoStep(t.step, masterIndex)
    && !(t.lotId === lotId && t.key === excludeKey));
  return { ...result, conflict: conflict ? { lotId: conflict.lotId, taskKey: conflict.key } : null,
    message: conflict && conflict.lotId !== lotId
      ? `指図 ${conflict.orderNo || conflict.lotId} の「${conflict.step?.title || '工程不明の作業'}」が作業中です。先に完了または中断してください。`
      : result.message };
}
