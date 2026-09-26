// ============================================================================
// 🖐 作業画面(順序実行)の作り直し 2026-09-24 — 画面が読む「並び・状態・次の一手」の純関数
// ----------------------------------------------------------------------------
// 清水さん 2026-09-24「時間・目標時間・今の作業(次の作業やテンプレの順番を一瞬で)・作業詳細・画像・測定を
//   1画面で。押したらすぐ拡大・すぐ切替。画面配分も変えられると面白い」→ Claude Design の案を「このまま進めて」。
//
// ここは数えるだけ(書き込まない・React を知らない)。鍵の決まりは App.jsx の getTaskKey / isTaskCompleted と同じ:
//   ・台ごとの工程 … `${step.id}-${台}`(旧データは `${工程の番号}-${台}`)
//   ・ロット1回の工程 … `${step.id}-lot-0`(順序実行は1回目だけを見る)
// 並びは今までどおり「工程が先」(1工程を全台 → 次の工程)。
// ⚠ 自動運転の工程を始めると その台は processing のまま機械に載る。次の一手はそれを飛ばして探す
//   (前は processing を書かないので、順序実行では自動運転を待つ間に何も案内できなかった)。
// ============================================================================

/** 工程の台の数。ロット1回は1。 */
export const unitsOfStep = (step, qty) => (step && step.lotOnce ? 1 : Math.max(1, Number(qty) || 1));

/** 工程×台の正しい鍵(書く時に使う方)。 */
export function seqTaskKeyOf(step, sIdx, u) {
  if (step && step.lotOnce && step.id) return `${step.id}-lot-0`;
  if (step && step.id) return `${step.id}-${u}`;
  return `${sIdx}-${u}`;
}

/** 工程×台の記録(新しい鍵 → 旧い鍵の順に読む)。無ければ null。 */
export function seqTaskOf(tasks, step, sIdx, u) {
  const t = tasks || {};
  if (step && step.lotOnce && step.id) return t[`${step.id}-lot-0`] || null;
  return (step && step.id && t[`${step.id}-${u}`]) || t[`${sIdx}-${u}`] || null;
}

const statusOfTask = (task) => (task && task.status) || 'waiting';
// 🚨 2026-09-24 第三者の確かめ: 前は completed だけを済にしていて、「該当なし(skipped)」「NG」「修正済み(rework-done)」で
//   順序実行が止まり、「完了して次へ」で その記録を completed に上書きしていた(アプリの他の所は skipped を済と数える)。
//   済(もう順序実行では触らない) = completed / skipped / ng / rework-done。動いている = processing / reworking(修正作業中)。
//   paused(カスタムで一時停止) は 済でも動いてもいない = 続きをやる物。
const SETTLED = new Set(['completed', 'skipped', 'ng', 'rework-done']);
const RUNNING = new Set(['processing', 'reworking']);
const isDone = (task) => SETTLED.has(statusOfTask(task));
const isRunning = (task) => RUNNING.has(statusOfTask(task));
/** 順序実行では もう触らない記録か(済・該当なし・NG・修正済み)。 */
export const seqIsSettled = (task) => isDone(task);
/** 動いているか(自動運転・修正作業中)。 */
export const seqIsRunning = (task) => isRunning(task);

/** 工程が先の並び(ロット1回は1回だけ)。 */
export function seqMovesOf(steps, qty) {
  const out = [];
  (steps || []).forEach((step, s) => {
    for (let u = 0; u < unitsOfStep(step, qty); u += 1) out.push({ s, u });
  });
  return out;
}

/**
 * 順番の帯と一覧に出す状態。工程ごとに台の状態を返す。
 *   done=済 / run=自動運転などで動いている / cur=いまここ / todo=まだ
 */
//   🖐 2026-09-24 確かめ役: 該当なし・NG も「済」の緑で出ていて見分けが付かなかった → skip / ng を分ける。
//   動いている物は 自動運転=run・手作業(カスタムで作業中)=active・修正作業中=rework(isAuto を渡した時)。
const SETTLED_VIEW = new Set(['done', 'skip', 'ng']);
export function seqStatusGridOf(steps, tasks, qty, cur, isAuto = null) {
  return (steps || []).map((step, s) => {
    const units = [];
    for (let u = 0; u < unitsOfStep(step, qty); u += 1) {
      const t = seqTaskOf(tasks, step, s, u);
      const st = statusOfTask(t);
      let status = 'todo';
      if (st === 'skipped') status = 'skip';
      else if (st === 'ng') status = 'ng';
      else if (isDone(t)) status = 'done';
      else if (st === 'reworking') status = 'rework';
      else if (st === 'processing') status = typeof isAuto === 'function' && !isAuto(step) ? 'active' : 'run';
      else if (cur && cur.s === s && (step && step.lotOnce ? true : cur.u === u)) status = 'cur';
      units.push({ u, status });
    }
    return { s, units, allDone: units.every((x) => SETTLED_VIEW.has(x.status)) };
  });
}

/** 機械に載っている台(その台の自動運転が動いている)。ロット1回の自動が動いている間は全台。 */
function busyUnitsOf(steps, tasks, qty, auto) {
  const busy = new Set(); let all = false;
  for (const m of seqMovesOf(steps, qty)) {
    const st = steps[m.s];
    if (!auto(st) || !isRunning(seqTaskOf(tasks, st, m.s, m.u))) continue;
    if (st && st.lotOnce) all = true; else busy.add(m.u);
  }
  return { any: all || busy.size > 0, has: (u) => all || busy.has(u) };
}

/**
 * 次にやる工程×台。
 *   頭から工程が先の順で「済でも 動いている でもない」最初の物。
 *   それが無く、動いている物(自動運転)だけが残っているなら その物を waiting:true で返す(= 待つ画面)。
 *   全部 済 なら null(= 全作業完了へ)。
 * ⚠ 今いる所の「後ろ」からだけ探すと、待ち時間に先の台の工程へ移った後で 前の台の残りを飛ばす。
 *   だから毎回 頭から探す(順序実行で済は必ず前に詰まっているので、普段の動きは今までと同じ)。
 */
//   ・その台の前の工程が済んでいない物は飛ばす(機械に載っている台の後ろの工程を先に出さない)
//   ・自動運転の工程は 同じ工程が別の台で動いている間は飛ばす(機械は1台ずつ。本番の記録でも まとめて開始の自動は1台ずつ載っている)
//   isAuto を渡さない時は 自動かどうかを見ない(前の形)。
//   opts.needsInput(s, u): 自動運転の工程で 測定/確認チェックの入力が要るのに 入っていない時 true。
//     その工程が自動運転で済(completed)になっても 入力が済むまで 次の作業にしない(自動の待ちの間に 測定の枠が隠れて入れ忘れる)。
export function seqNextOf(steps, tasks, qty, isAuto = null, opts = {}) {
  const auto = typeof isAuto === 'function' ? isAuto : () => false;
  const needsInput = typeof opts.needsInput === 'function' ? opts.needsInput : () => false;
  let running = null; let first = null;
  const hasAuto = typeof isAuto === 'function';
  const busyUnit = busyUnitsOf(steps, tasks, qty, auto);
  const busyStep = new Set();
  for (const m of seqMovesOf(steps, qty)) if (isRunning(seqTaskOf(tasks, steps[m.s], m.s, m.u))) busyStep.add(m.s);
  for (const m of seqMovesOf(steps, qty)) {
    const t = seqTaskOf(tasks, steps[m.s], m.s, m.u);
    if (statusOfTask(t) === 'completed' && auto(steps[m.s]) && needsInput(m.s, m.u)) return { ...m, waiting: false, inputOnly: true };
    if (isDone(t)) continue;
    if (isRunning(t)) { if (!running) running = m; continue; }
    if (!first) first = m;
    if (!readyFor(steps, tasks, qty, m.s, m.u)) continue;
    // opts.sameStepAuto: 同じ工程の自動を 別の台でも始める案内用(機械が2台以上ある時の逃げ道)。機械に載っている台は それでも出さない
    if (auto(steps[m.s]) && busyStep.has(m.s) && !opts.sameStepAuto) continue;
    // 🖐 2026-09-24 確かめ役: 機械に載っている台の作業を 次に出さない(カスタムで順番を飛ばした時に起きる)
    if (hasAuto && (steps[m.s] && steps[m.s].lotOnce ? busyUnit.any : busyUnit.has(m.u))) continue;
    return { ...m, waiting: false };
  }
  if (running) return { ...running, waiting: true };
  return first ? { ...first, waiting: false } : null;
}

/** この台の、この工程より前が全部済か(ロット1回の工程は 全台の前の工程が済か)。 */
function readyFor(steps, tasks, qty, s, u) {
  const step = steps[s];
  for (let p = 0; p < s; p += 1) {
    const prev = steps[p];
    if (step && step.lotOnce) {
      for (let x = 0; x < unitsOfStep(prev, qty); x += 1) if (!isDone(seqTaskOf(tasks, prev, p, x))) return false;
    } else if (!isDone(seqTaskOf(tasks, prev, p, prev && prev.lotOnce ? 0 : u))) return false;
  }
  return true;
}

/**
 * 自動運転を待つ間に、このロットの中で 手でできる作業(無ければ null)。
 *   条件: 手作業の工程 / 済でも動いてもいない / その台の前の工程が全部済(機械に載っている台は自動運転が済むまで出ない)。
 *   並びは工程が先の順(一番早く片付く物から)。
 */
export function seqWhileAutoOf(steps, tasks, qty, isAuto) {
  const auto = typeof isAuto === 'function' ? isAuto : () => false;
  const busyUnit = busyUnitsOf(steps, tasks, qty, auto);
  for (const m of seqMovesOf(steps, qty)) {
    const step = steps[m.s];
    if (auto(step)) continue;
    const t = seqTaskOf(tasks, step, m.s, m.u);
    if (isDone(t) || isRunning(t)) continue;
    if (step && step.lotOnce ? busyUnit.any : busyUnit.has(m.u)) continue; // 機械に載っている台は出さない
    if (readyFor(steps, tasks, qty, m.s, m.u)) return m;
  }
  return null;
}

/**
 * このロットの残りの見込み(秒)。済でない工程×台の目標を足す。
 *   ・今の工程×台は 目標 − 今の経過(下限0)
 *   ・動いている物(自動運転)は 目標 − 始めてからの経過(下限0)
 *   ・目標が分からない工程は 足さず unknown に数える(0分と言わない)
 */
export function seqRemainingOf(steps, tasks, qty, { targetOf, cur = null, curElapsedSec = 0, nowMs = Date.now() } = {}) {
  let sec = 0;
  let unknown = 0;
  let left = 0;
  for (const m of seqMovesOf(steps, qty)) {
    const step = steps[m.s];
    const t = seqTaskOf(tasks, step, m.s, m.u);
    if (isDone(t)) continue;
    left += 1;
    const target = Number(typeof targetOf === 'function' ? targetOf(m.s) : 0) || 0;
    if (!(target > 0)) { unknown += 1; continue; }
    if (isRunning(t)) {
      const ran = t.startTime ? Math.max(0, (nowMs - t.startTime) / 1000) : 0;
      sec += Math.max(0, target - ran);
    } else if (cur && cur.s === m.s && cur.u === m.u) sec += Math.max(0, target - curElapsedSec);
    else sec += target;
  }
  return { sec: Math.round(sec), unknown, left };
}

/** 画面の型(作業者ごとに覚える)。 */
export const SEQ_PRESETS = Object.freeze([
  { key: 'desc', label: '説明重視' },
  { key: 'measure', label: '測定重視' },
  { key: 'fig', label: '図重視' },
]);
export const seqPresetOf = (v) => (SEQ_PRESETS.some((p) => p.key === v) ? v : 'desc');

/**
 * 枠の並べ方(CSS grid)。d=作業内容 f=図・画像 m=測定/確認チェック n=この後の流れ。
 *   図が無い工程は図の枠を取らない(本番は工程の画像 0/6,995。今の「画像なし」の空箱をやめる)。
 */
export function seqAreasOf({ preset, hasFig, hasInput }) {
  const p = seqPresetOf(preset);
  const big = 'minmax(0, 1.45fr) minmax(0, 1fr)';
  if (hasFig && hasInput) {
    const rows = 'minmax(0, 1fr) minmax(0, 1fr)';
    if (p === 'measure') return { cols: big, rows, areas: "'m d' 'm f'", panels: ['d', 'f', 'm'] };
    if (p === 'fig') return { cols: big, rows, areas: "'f d' 'f m'", panels: ['d', 'f', 'm'] };
    return { cols: 'minmax(0, 1.2fr) minmax(0, 1fr)', rows, areas: "'d f' 'd m'", panels: ['d', 'f', 'm'] };
  }
  const rows = 'minmax(0, 1fr)';
  if (hasInput) {
    if (p === 'desc') return { cols: 'minmax(0, 1.1fr) minmax(0, 1fr)', rows, areas: "'d m'", panels: ['d', 'm'] };
    return { cols: big, rows, areas: "'m d'", panels: ['d', 'm'] };
  }
  if (hasFig) {
    if (p === 'fig') return { cols: big, rows, areas: "'f d'", panels: ['d', 'f'] };
    return { cols: 'minmax(0, 1.2fr) minmax(0, 1fr)', rows, areas: "'d f'", panels: ['d', 'f'] };
  }
  return { cols: 'minmax(0, 1.6fr) minmax(0, 1fr)', rows, areas: "'d n'", panels: ['d', 'n'] };
}
