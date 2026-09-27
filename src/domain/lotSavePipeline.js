// Phase B.1: ロット保存の共通パイプライン (テスト可能な形へ抽出)。
//
// B.0 では App.jsx のクロージャ内に直書きしていたため、
//   ・保存を「連続して」通した時の挙動 (直前の生成結果の引き継ぎ)
//   ・Firestore の prop 更新前に次の操作が来た場合
// をテストできなかった。ここへ出して統合テストの対象にする。
//
// ⚠同時編集について (B.1 で表現を訂正):
//   この保存は setDoc(merge:true) であり Firestore トランザクションではない。
//   「多端末でも安全」ではない。開閉処理を冪等にして"壊れにくく"しているだけで、
//   同じロットを同時に2端末で操作すれば後勝ちで区間が失われうる。
//   → 運用制約: 同じロットは同時に複数端末で操作しないこと。
//   → 恒久対策(未実施): runTransaction 化、またはセッションを別コレクションへ追記型で持つ。

import { applySessionTransitions, sessionsOf, closeSession, openSession } from './workSessions.js';
import { applyMachineRunTransitions } from './machineRuns.js';

// 担当変更 (B.1 #3): 進行中タスクは、停止を挟まなくても担当が変わった時点で区間を割る。
//   A が開始 → 停止せず B へ担当変更 → B が完了 のとき、A の区間と B の区間が両方残る。
//   これをやらないと、開いているセッションの workerId は開始した A のままで、
//   B が働いた時間まで A に付く(= B.0 の「それぞれの人の時間になる」は成立していなかった)。
export const splitSessionsOnHandoff = ({ tasks = {}, now, newWorkerId, newWorkerName = '' } = {}) => {
  if (!now || !newWorkerId) return { tasks, changed: false };
  const out = { ...tasks };
  let changed = false;
  Object.keys(tasks).forEach(key => {
    const t = tasks[key];
    if (!t || t.status !== 'processing' || !t.startTime) return;
    const open = sessionsOf(t).find(s => s && s.startTime && !s.endTime);
    if (!open) return;
    if (open.workerId === newWorkerId) return; // 既に新担当の区間
    const closed = closeSession(t, { now });
    out[key] = openSession(closed, { now, workerId: newWorkerId, workerName: newWorkerName, source: 'handoff' });
    changed = true;
  });
  return { tasks: out, changed };
};

// ⚠B.1 の実機検証で判明した必須処理:
//   画面側の React state (tasks) には、このパイプラインが付けた sessions が入っていない。
//   (setTasks は sessions を足す前の値で呼ばれ、Firestore の購読が返るまで反映されない)
//   そのため次の遷移は「sessions を持たないタスク」から組み立てられ、
//   開いているセッションを見つけられず閉じられない ＝ 開始したまま永遠に閉じない区間ができる。
//   → 前回保存時の sessions を、next 側が持っていない場合だけ引き継ぐ。
//   例外: やり直し等で waiting へ戻し firstStartTime も消しているタスクは、履歴ごと初期化する。
//
// 🎓 trainee も同じ理由で引き継ぐ (2026-08-08)。
//   画面 state の tasks には前回焼き付けた trainee が入っていないため、そのまま保存すると
//   返り値 (= 次回の prevTasks) から印が消え、「この保存で動いたか」の判定がずれる。
//   ※Firestore は setDoc(merge:true) なので実データ上は消えないが、判定の土台を正しく保つ。
//   やり直し (reset) のときだけは記録ごと作り直しなので false を明示する
//   (印だけ残すと、先輩がやり直した記録まで教育中扱いになりものさしから落ちる)。
//
// 🎓 「取り消し」(undo) も同じ扱いが要る (2026-08-09 出荷前是正)。
//   取り消しは status を 'processing' に戻すだけで firstStartTime を消さないため isReset に当たらず、
//   印だけが残っていた。そのまま先輩が完了させると **先輩の実測に🎓が焼き付く**
//   (= 較正・達成率・Cpk・作業者評価から先輩の記録が丸ごと落ちる)。
//   ⚠ここで `trainee:false` を**明示的に書く**必要がある。保存は setDoc(merge:true) なので、
//     キーを省くだけでは Firestore に残った true は消えない (印は二度と外せなくなる)。
const carrySessions = (prev, next, { undo = false } = {}) => {
  const out = { ...next };
  Object.keys(next).forEach(key => {
    const after = next[key];
    const before = prev[key];
    if (!after || typeof after !== 'object') return;
    const isReset = after.status === 'waiting' && !after.firstStartTime;
    // ⚠「この保存で巻き戻った台」だけ。取り消しの payload は tasks 全体のスナップショットなので、
    //   触っていない完了済みの台(前に新人が仕上げた別の台)の印まで消してはいけない。
    const isUndone = undo
      && !!before && (before.status === 'completed' || before.status === 'ng')
      && after.status !== 'completed' && after.status !== 'ng';
    let patch = null;
    if (!Array.isArray(after.sessions)) {                  // 明示的に持っているならそれが正
      if (isReset) patch = { sessions: [] };
      else if (before && Array.isArray(before.sessions)) patch = { sessions: before.sessions };
    }
    // ⚠印が付いていた台にだけ触る。未着手の台まで trainee:false を書くと、
    //   保存のたびに全タスクへ無駄なキーが増える(1MB上限が近いドキュメントで効いてくる)。
    if (isUndone && (after.trainee === true || (before && before.trainee === true))) {
      patch = { ...(patch || {}), trainee: false };
    } else if (after.trainee === undefined && before && before.trainee === true) {
      patch = { ...(patch || {}), trainee: !isReset };
    }
    if (patch) out[key] = { ...after, ...patch };
  });
  return out;
};

// 🎓 教育中(新人)の記録に印を付ける (2026-08-08)。
//
// なぜ「焼き付け」なのか:
//   task には workerId がどこにも保存されていない (workerName しか無い)。
//   よって後から「この記録は誰がやったか → その人は当時教育中だったか」を ID で引き直すのは原理的に不可能。
//   保存の瞬間に task 自身へ印を付けるのが唯一の正解。
//
// 設計の要 (歴史を動かさない):
//   ・付けるのは **この保存で実際に動いた台だけ**。既にある記録 (前に別の人がやった台) は触らない。
//   ・trainee=false のときは何も書かない = 既存の trainee:true を消さない。
//     → 卒業させてフラグを false にしても、過去の記録は教育中のまま残る (集計が後から変わらない)。
//   ・sessions や trainee 自体の差では「動いた」と見なさない (付け直しの連鎖を防ぐ)。
const TRAINEE_WORK_FIELDS = ['status', 'startTime', 'endTime', 'duration', 'firstStartTime', 'workerName', 'ngReason', 'samplingSkipped'];
// 触っていない台の status。⚠未完了理由つきの完了は、一度も着手していない台に
//   `{status:'skipped', duration:0, firstStartTime: 完了時刻, endTime: 完了時刻}` を作る。
//   時刻が入るので「時刻の有無」だけでは未着手と区別できない → status で明示的に外す (あら探し#22)。
const TRAINEE_UNTOUCHED_STATUSES = ['waiting', 'skipped'];
export const stampTrainee = ({ prev = {}, next = {}, trainee = false } = {}) => {
  if (!trainee || !next) return next;
  const out = { ...next };
  let changed = false;
  Object.keys(next).forEach(key => {
    const after = next[key];
    if (!after || typeof after !== 'object') return;
    if (after.trainee === true) return; // 既に付いている
    // まだ作業が乗っていない台 (未着手・該当なし・未完了スキップ) には付けない。
    //   ここで付けると、後で先輩が完了させた記録まで教育中扱いになってしまう。
    //   また「触ってもいない全工程×全台」に印が付き、履歴・成績表の担当欄が丸ごと🎓になる。
    if (TRAINEE_UNTOUCHED_STATUSES.includes(after.status) && !(after.duration > 0)) return;
    if (!after.startTime && !after.firstStartTime && !(after.duration > 0)) return;
    const before = prev[key] || null;
    // ⚠既に**他人の実測が確定している台**には後から印を付けない (あら探し#6)。
    //   先輩が完了させた台(duration>0 の completed)を、教育中の人が「やり直し」で開くと
    //   status が completed→reworking へ動く = TRAINEE_WORK_FIELDS 的には「この保存で動いた」に見える。
    //   しかし duration は先輩の実測のまま。そこへ印を付けると、先輩の記録が
    //   較正・乖離アラート・達成率・作業者評価・Cpk から丸ごと消える(歴史を動かしてしまう)。
    if (before && before.status === 'completed' && (before.duration > 0)) return;
    // ⚠⚠印は「開始した人」ではなく「**この保存で実測が生まれた/変わった台**」に付ける (2026-08-09 出荷前是正)。
    //   上のガードだけでは次の2つが素通りし、**先輩の記録に🎓が焼かれる**。
    //   しかも trainee は「false のとき何も書かない」設計なので、一度 Firestore に入ると二度と消せない。
    //   経路A(まとめて開始＋担当交代): 新人が2台開始(=この保存で印) → 先輩に代わって完了。
    //     開始の保存では before.status が completed ではないのでガードが効かない。
    //     → 開始しただけ(実測がまだ0)の保存には印を付けない。完了の保存は先輩の trainee=false なので付かない。
    //   経路B(やり直し): 先輩の完了(120秒) → 新人が reworking(ここは上のガードで守られる)
    //     → 修正完了。before.status が 'reworking' なのでガードが効かず、先輩の実測120秒に印が焼かれる。
    //     rework-ok は duration を作り直さない(App.jsx の 'rework-ok' は currentTask の duration を維持)ので、
    //     → 既にあった実測と同じ値のままなら、それは他人の記録＝触らない。
    const beforeDur = (before && before.duration) || 0;
    const afterDur = after.duration || 0;
    const doneNow = (after.status === 'completed' || after.status === 'ng')
                 && !(before && (before.status === 'completed' || before.status === 'ng'));
    if (!(afterDur > beforeDur) && !doneNow) return; // 開始しただけの保存には付けない
    if (beforeDur > 0 && afterDur === beforeDur) return; // 既にあった他人の実測は触らない
    if (before && !TRAINEE_WORK_FIELDS.some(f => before[f] !== after[f])) return; // この保存では動いていない
    out[key] = { ...after, trainee: true };
    changed = true;
  });
  return changed ? out : next;
};

// 保存1回分の変換。副作用なし。呼び出し側は返ってきた nextTasks / nextRuns を
// 「直前に生成した値」として保持し、次回の prevTasks / prevRuns に渡すこと (Firestore の往復を待たない)。
// undo=true: この保存が「取り消し」(handleUndo) 由来であることを伝える。
//   ⚠印は payload に混ぜない(保存データの形を変えないため)。呼び出し側 (App.jsx の onSave) が
//     payload から外して、この引数として渡すこと。
export const buildLotSave = ({
  payload = {}, lot = {}, prevTasks = {}, prevRuns = null, now,
  workerId = null, workerName = '', resolveKey, isAuto, resolveWorkerName = null, trainee = false,
  undo = false,
} = {}) => {
  const currentWorkerId = workerId || lot.workerId || null;

  // ① 担当変更のみの保存 (changeInspector は onSave({workerId}) しか呼ばない)
  const handoffTo = payload.workerId && payload.workerId !== currentWorkerId ? payload.workerId : null;
  let baseTasks = payload.tasks || null;
  let handoffApplied = false;
  if (handoffTo && !baseTasks) {
    const nm = (typeof resolveWorkerName === 'function' ? resolveWorkerName(handoffTo) : '') || '';
    const r = splitSessionsOnHandoff({ tasks: prevTasks, now, newWorkerId: handoffTo, newWorkerName: nm });
    if (r.changed) { baseTasks = r.tasks; handoffApplied = true; }
  }

  if (!baseTasks) {
    // tasks に触らない保存 (合計時間の flush など) はそのまま通す
    return { payload, tasks: prevTasks, machineRuns: prevRuns, touched: false };
  }

  // 画面 state が落としてきた sessions を復元してから判定する (これが無いと区間が閉じない)
  baseTasks = carrySessions(prevTasks, baseTasks, { undo });

  const effectiveWorkerId = handoffTo || currentWorkerId;
  const effectiveWorkerName = handoffTo
    ? ((typeof resolveWorkerName === 'function' ? resolveWorkerName(handoffTo) : '') || workerName)
    : workerName;

  // ② 手動作業セッション。開始/再開は startTime の出現、停止/完了は startTime の消失で捕捉する
  let nextTasks = handoffApplied
    ? baseTasks // 担当変更だけの保存では startTime の出入りが無いので二重適用しない
    : applySessionTransitions({ prev: prevTasks, next: baseTasks, now, workerId: effectiveWorkerId, workerName: effectiveWorkerName });

  // ③ tasks を伴う保存でも担当が同時に変わっているなら分割する
  if (handoffTo && !handoffApplied) {
    const nm = (typeof resolveWorkerName === 'function' ? resolveWorkerName(handoffTo) : '') || '';
    nextTasks = splitSessionsOnHandoff({ tasks: nextTasks, now, newWorkerId: handoffTo, newWorkerName: nm }).tasks;
  }

  // ③' 🎓 教育中の印。この保存で動いた台にだけ付ける (担当交代の分割まで済ませた後に打つ)。
  nextTasks = stampTrainee({ prev: prevTasks, next: nextTasks, trainee });

  // ④ 機械運転。⚠prevRuns を必ず使う。lot.machineRuns は Firestore の往復が終わるまで古い。
  const nextRuns = applyMachineRunTransitions({
    lot, prev: prevTasks, next: nextTasks, now,
    prevRuns: Array.isArray(prevRuns) ? prevRuns : (lot.machineRuns || []),
    resolveKey, isAuto, workerId: effectiveWorkerId,
  });

  const hadRuns = (Array.isArray(prevRuns) ? prevRuns : (lot.machineRuns || [])).length > 0;
  const hasRuns = Array.isArray(nextRuns) && nextRuns.length > 0;
  const outPayload = {
    ...payload,
    tasks: nextTasks,
    ...((hadRuns || hasRuns) ? { machineRuns: nextRuns } : {}),
  };
  return { payload: outPayload, tasks: nextTasks, machineRuns: nextRuns, touched: true };
};
