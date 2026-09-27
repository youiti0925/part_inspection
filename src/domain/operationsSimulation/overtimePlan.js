// =============================================================================
//  operationsSimulation/overtimePlan.js — 納期対応の残業・土曜(必要分)を決める純関数
// -----------------------------------------------------------------------------
//  清水さん(2026-09-16):
//    「必要に応じて残業と土曜日出る計算をして、必要なタイミングで必要な分をする計算をして、
//      それを作業者に見せて、できるかどうか確認して、大丈夫ならそれでいく感じにしたい。
//      納期対応用の必要分の残業と土曜日計算をするモードがほしい」
//
//  答える1行:
//    「いまの見立てで遅れるロットを間に合わせるには、**誰が・どの日に・何分** 残業し、
//      **誰が・どの土曜** に出ればよいか(必要な分だけ)」
//
//  決め方(貪欲法。1手ずつ足して、効かなければ止まる):
//    1. いちばん早く遅れるロット(納期が一番手前の遅れ)を見る。
//    2. そのロットの担当者に、そのロットへ手が付いている日のうち **納期に一番近い営業日** へ
//       +stepMin(既定30分)。1人1日の上限(maxExtraMin = policy の残業込み上限 − いまの1日の分数)を越えない。
//    3. 上限に当たったら、そのロットの納期より前の **直近の土曜** に出る(workOnDays)。
//    4. 1手ごとに引き直し(runOnce)。**改善しなければ**(遅れ件数も遅れの合計も減らない)その手を戻し、
//       そのロットは諦めて次の候補へ(全部試し終えたら止まる)。すでに超過(納期 < 基準時刻)のロットは候補にしない。
//
//  🚨 決め事:
//    - 中で時計を読まない(Date.now / new Date() を引数なしで呼ばない)。日付は全部 引数から。
//    - 数字を推測で埋めない。runOnce が返した遅れをそのまま数える(ここで遅れを作らない)。
//    - React / Firebase を import しない。
//    - 引き直しは runOnce(呼ぶ側が用意。Worker の中では normalizeInput + simulate)。
//      ここは「次に何を足すか」を決めるだけで、割付の計算は1行も持たない。
//
//  scenario に載る2つの鍵(calendar.js の segmentsFor が読む):
//    extraByDay = { 'YYYY-MM-DD': { [名前]: 追加の分数 } }  … その人のその日の終業を分数ぶん延ばす
//    workOnDays = { 'YYYY-MM-DD': [名前, …] }              … 工場の休み(土曜)でも その人だけ通常の窓で働く
// =============================================================================

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (v == null ? '' : String(v)).trim();
/** 数か null。🚨 Number(null) は 0 になるので、先に無いことを見る(0 に化けると「遅れ0分」の嘘になる)。 */
const numOrNull = (v) => ((v == null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** epoch ms → 'YYYY-MM-DD'(端末のローカル時刻。calendar.js の absences の鍵と同じ流儀)。 */
export const ymdOfMs = (ms) => {
  const n = numOrNull(ms);
  if (n == null) return null;
  const d = new Date(n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

/**
 * 遅れの重さ。{ count: 件数, stuck: 進み具合の分からない件数, remaining: 期間の中で手が付かなかった仕事の数, sumMs: 納期からの遅れの合計 }。
 *   ・終わりの時刻(finishMs)が在る … finishMs − dueMs
 *   ・期間の中で終わらない(finishMs 無し) … 残った仕事の数(remainingJobs)と、手が付いた最後の仕事の終わり(lastEndMs)− dueMs で
 *     「どこまで進んだか」を数える(実測の値。推測ではない。残業を足すと 残りが減る／最後の終わりが手前へ来る)
 *   ・どちらも無い(1つも手が付いていない) … stuck に数える(数字を作らない)
 * 比べ方は 件数 → stuck → 残りの仕事 → 合計 の順(先の物が減れば改善)。
 */
const lateScore = (late) => {
  const list = Array.isArray(late) ? late : [];
  let sum = 0; let stuck = 0; let remaining = 0;
  for (const l of list) {
    if (!l) continue;
    const d = numOrNull(l.dueMs);
    remaining += Math.max(0, Math.trunc(Number(l.remainingJobs) || 0));
    const f = numOrNull(l.finishMs) ?? numOrNull(l.lastEndMs);
    if (f == null || d == null) { stuck += 1; continue; }
    sum += Math.max(0, f - d);
  }
  return { count: list.length, stuck, remaining, sumMs: sum };
};
const improved = (before, after) => {
  for (const k of ['count', 'stuck', 'remaining', 'sumMs']) {
    if (after[k] < before[k]) return true;
    if (after[k] > before[k]) return false;
  }
  return false;
};

/** runOnce の戻りを揃える(無い鍵は空にする。数を作らない)。 */
const normalizeRun = (res) => {
  const r = isObj(res) ? res : {};
  const late = (Array.isArray(r.late) ? r.late : []).map((l) => (isObj(l) ? {
    lotId: str(l.lotId),
    dueMs: numOrNull(l.dueMs),
    finishMs: numOrNull(l.finishMs),
    lastEndMs: numOrNull(l.lastEndMs),
    remainingJobs: Math.max(0, Math.trunc(Number(l.remainingJobs) || 0)),
    workers: (Array.isArray(l.workers) ? l.workers : []).map(str).filter(Boolean),
    workYmds: (Array.isArray(l.workYmds) ? l.workYmds : []).map(str).filter((y) => YMD_RE.test(y)),
  } : null)).filter(Boolean);
  const lateCount = Number.isFinite(Number(r.lateCount)) ? Number(r.lateCount) : late.length;
  return { late, lateCount };
};

/** 深い写し(戻す為)。 */
const cloneExtra = (x) => Object.fromEntries(Object.entries(x).map(([d, m]) => [d, { ...m }]));
const cloneWorkOn = (x) => Object.fromEntries(Object.entries(x).map(([d, a]) => [d, [...a]]));

/**
 * 納期対応の残業・土曜を「必要な分だけ」決める。
 *
 * @param {object} o
 * @param {(patch:{extraByDay:object, workOnDays:object}) => ({late:Array, lateCount:number}|Promise)} o.runOnce
 *   1回の引き直し。late = [{ lotId, dueMs, finishMs, lastEndMs?, remainingJobs?, workers:[名前], workYmds:['YYYY-MM-DD'] }]
 *   (lastEndMs = 手が付いた最後の仕事の終わり / remainingJobs = 期間の中で手が付かなかった仕事の数。
 *    期間の中で終わらないロットの「どこまで進んだか」)
 * @param {string[]} o.workers   残業を頼める人の名前。空なら late.workers をそのまま信じる
 * @param {string[]} o.horizonYmds 見ている期間の営業日('YYYY-MM-DD' 昇順)
 * @param {string[]} o.saturdays   期間の中の土曜(工場が休みの日)。空なら土曜出勤は足さない
 * @param {number} [o.stepMin=30]  1手で足す分数
 * @param {number} o.maxExtraMin   1人1日に足せる上限(policy の残業込み上限 − いまの1日の分数)。0 なら残業は足さず土曜だけ
 * @param {number} [o.maxIterations=40]
 * @param {number|null} [o.nowMs]  計算の基準時刻。🚨 納期がこれより前(すでに超過)のロットは 残業では救えないので候補にしない
 *   (写しの実測 2026-09-16: 超過のロットを先頭に置くと1手目で「効かない」となり全体が止まって案が空になった)
 * @returns {Promise<{days:Array, extraByDay:object, workOnDays:object, lateBefore:number, lateAfter:number, iterations:number, stoppedBecause:string, lateLotIdsAfter:string[]}>}
 */
export async function planOvertimeAsNeeded({
  runOnce, workers = [], horizonYmds = [], saturdays = [], stepMin = 30, maxExtraMin = 0, maxIterations = 40, nowMs = null,
} = {}) {
  if (typeof runOnce !== 'function') throw new Error('overtimePlan: runOnce(引き直す関数)を渡してください');
  const names = (Array.isArray(workers) ? workers : []).map(str).filter(Boolean);
  const nameSet = new Set(names);
  const hz = (Array.isArray(horizonYmds) ? horizonYmds : []).map(str).filter((y) => YMD_RE.test(y)).sort();
  const sats = (Array.isArray(saturdays) ? saturdays : []).map(str).filter((y) => YMD_RE.test(y)).sort();
  const step = Math.max(1, Math.trunc(Number(stepMin) || 0));
  const cap = Math.max(0, Math.trunc(Number(maxExtraMin) || 0));
  const maxIt = Math.max(1, Math.trunc(Number(maxIterations) || 0));

  const extraByDay = {};
  const workOnDays = {};
  /** (日|名前) → その手を足した理由のロット。画面の「forLots」になる。 */
  const forLots = new Map();
  const noteFor = (ymd, name, lotId) => {
    const k = `${ymd}|${name}`;
    if (!forLots.has(k)) forLots.set(k, []);
    const a = forLots.get(k);
    if (lotId && !a.includes(lotId)) a.push(lotId);
  };

  const first = normalizeRun(await runOnce({ extraByDay: {}, workOnDays: {} }));
  const lateBefore = first.lateCount;
  let cur = first;
  let curScore = lateScore(cur.late);
  let iterations = 0;
  let stoppedBecause = 'max-iterations';
  /** もう手を足せないと分かったロット(同じロットで空回りしない)。 */
  const exhausted = new Set();
  /** 効かなくて戻した手が1つでも在ったか(全ロットを試し終えた時の止まった理由に使う)。 */
  let revertedAny = false;

  /** ロットごとに もう試した手('YYYY-MM-DD' か 'sat:YYYY-MM-DD')。同じ手を2回試さない。 */
  const tried = new Map();
  const triedOf = (lotId) => { if (!tried.has(lotId)) tried.set(lotId, new Set()); return tried.get(lotId); };
  const uniqDesc = (...lists) => { const out = []; for (const l of lists) for (const y of l.slice().sort().reverse()) if (!out.includes(y)) out.push(y); return out; };

  while (iterations < maxIt) {
    const base = numOrNull(nowMs);
    const candidates = cur.late
      .filter((l) => !exhausted.has(l.lotId))
      // 🚨 すでに超過(納期 < 基準時刻)は残業では戻せない。候補にすると効かない手で空回りする
      .filter((l) => !(base != null && l.dueMs != null && l.dueMs < base))
      .sort((a, b) => ((a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)) || (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0));
    if (cur.late.length === 0) { stoppedBecause = 'no-late'; break; }
    if (candidates.length === 0) { stoppedBecause = revertedAny ? 'no-improvement' : 'no-move'; break; }
    const lot = candidates[0];
    const dueYmd = ymdOfMs(lot.dueMs);
    const people = lot.workers.filter((n) => nameSet.size === 0 || nameSet.has(n));
    if (people.length === 0) { exhausted.add(lot.lotId); continue; }
    const done = triedOf(lot.lotId);

    // その日の候補(新しい順): ロットに手が付いている日のうち納期以前 → 手が付いている日 → 期間の営業日で納期以前(手が付いている日が無い時)
    //   🚨 1つの日が効かなかったら(終わる日の途中で終わるロット等)その日は諦めて **前の日** を試す。
    const byDue = (list) => (dueYmd ? list.filter((y) => y <= dueYmd) : list);
    const inHz = lot.workYmds.filter((y) => hz.length === 0 || hz.includes(y));
    const dayOrder = uniqDesc(byDue(inHz), inHz, inHz.length ? [] : byDue(hz));
    let day = null;
    if (cap > 0) {
      for (const y of dayOrder) {
        if (done.has(y)) continue;
        const room = people.some((n) => (((extraByDay[y] && extraByDay[y][n]) || 0) + step) <= cap);
        if (room) { day = y; break; }
      }
    }

    // 1手を組む。残業(+step)が入る日が在れば残業、無ければ土曜。
    const prevExtra = cloneExtra(extraByDay);
    const prevWorkOn = cloneWorkOn(workOnDays);
    const prevForLots = new Map([...forLots].map(([k, v]) => [k, [...v]]));
    let moved = false;
    let moveKey = '';
    if (day) {
      for (const n of people) {
        const now = (extraByDay[day] && extraByDay[day][n]) || 0;
        if (now + step <= cap) {
          if (!extraByDay[day]) extraByDay[day] = {};
          extraByDay[day][n] = now + step;
          noteFor(day, n, lot.lotId);
          moved = true;
        }
      }
      moveKey = day;
    }
    if (!moved && sats.length) {
      // 納期より前の直近の土曜(納期が無いロットは期間の最初の土曜)。既に出ている土曜・試した土曜は飛ばす。
      const satPool = (dueYmd ? sats.filter((y) => y < dueYmd) : sats.slice()).sort();
      for (let i = satPool.length - 1; i >= 0 && !moved; i -= 1) {
        const s = satPool[i];
        if (done.has('sat:' + s)) continue;
        const list = workOnDays[s] || [];
        const add = people.filter((n) => !list.includes(n));
        if (add.length === 0) continue;
        workOnDays[s] = [...list, ...add];
        add.forEach((n) => noteFor(s, n, lot.lotId));
        moved = true;
        moveKey = 'sat:' + s;
      }
    }
    if (!moved) { exhausted.add(lot.lotId); continue; }

    iterations += 1;
    const next = normalizeRun(await runOnce({ extraByDay: cloneExtra(extraByDay), workOnDays: cloneWorkOn(workOnDays) }));
    const nextScore = lateScore(next.late);
    if (!improved(curScore, nextScore)) {
      // 効かなかった手は戻す(足しても減らない残業を作業者に見せない)。
      // 🚨 ここで全体を止めない: この日は諦めて 前の日 → 土曜 → 次のロット と試す(1手目が効かないと
      //   他を一度も試さずに終わっていた = 写しで案が空になった原因)。
      for (const k of Object.keys(extraByDay)) delete extraByDay[k];
      Object.assign(extraByDay, prevExtra);
      for (const k of Object.keys(workOnDays)) delete workOnDays[k];
      Object.assign(workOnDays, prevWorkOn);
      forLots.clear(); for (const [k, v] of prevForLots) forLots.set(k, v);
      done.add(moveKey);
      revertedAny = true;
      continue;
    }
    cur = next;
    curScore = nextScore;
    if (cur.late.length === 0) { stoppedBecause = 'no-late'; break; }
  }
  if (stoppedBecause === 'max-iterations' && cur.late.length === 0) stoppedBecause = 'no-late';

  const days = [];
  for (const ymd of Object.keys(extraByDay).sort()) {
    for (const n of Object.keys(extraByDay[ymd]).sort()) {
      days.push({ ymd, worker: n, extraMin: extraByDay[ymd][n], saturday: false, forLots: forLots.get(`${ymd}|${n}`) || [] });
    }
  }
  for (const ymd of Object.keys(workOnDays).sort()) {
    for (const n of [...workOnDays[ymd]].sort()) {
      days.push({ ymd, worker: n, extraMin: 0, saturday: true, forLots: forLots.get(`${ymd}|${n}`) || [] });
    }
  }
  days.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0) || (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0));

  return {
    days,
    extraByDay,
    workOnDays,
    lateBefore,
    lateAfter: cur.lateCount,
    lateLotIdsAfter: cur.late.map((l) => l.lotId),
    // 残った遅れのうち すでに超過(納期 < 基準時刻)。残業・土曜では戻らない物(画面が1行言う)
    pastDueAfter: (() => { const b = numOrNull(nowMs); return b == null ? 0 : cur.late.filter((l) => l.dueMs != null && l.dueMs < b).length; })(),
    iterations,
    stoppedBecause,
  };
}

// ── 画面と scenario の橋(純関数。数を作らない) ──────────────────────────────

/**
 * 保存した案(settings.opsim.overtimePlan)を scenario の2つの鍵へ。
 * 🚨 adopted === true の案だけ。それ以外は null(= scenario に何も載らない = 今までと1ミリも同じ)。
 * @param {object|null} plan { days:[{ymd, worker, extraMin, saturday}], adopted }
 * @returns {{extraByDay:object, workOnDays:object}|null}
 */
export function scenarioOfOvertimePlan(plan) {
  if (!isObj(plan) || plan.adopted !== true) return null;
  const extraByDay = {};
  const workOnDays = {};
  for (const d of (Array.isArray(plan.days) ? plan.days : [])) {
    if (!isObj(d)) continue;
    const ymd = str(d.ymd); const w = str(d.worker);
    if (!YMD_RE.test(ymd) || !w) continue;
    if (d.saturday === true) {
      if (!workOnDays[ymd]) workOnDays[ymd] = [];
      if (!workOnDays[ymd].includes(w)) workOnDays[ymd].push(w);
      continue;
    }
    const m = Math.trunc(Number(d.extraMin));
    if (!(m > 0)) continue;
    if (!extraByDay[ymd]) extraByDay[ymd] = {};
    extraByDay[ymd][w] = (extraByDay[ymd][w] || 0) + m;
  }
  if (Object.keys(extraByDay).length === 0 && Object.keys(workOnDays).length === 0) return null;
  return { extraByDay, workOnDays };
}

/** 案に出てくる人の名前(重複なし・並び順)。画面の「できる／むずかしい」の行になる。 */
export function planWorkerNames(plan) {
  const out = [];
  for (const d of (isObj(plan) && Array.isArray(plan.days) ? plan.days : [])) {
    const w = str(d && d.worker);
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** 全員が「できる」と答えたか。人が0人なら false(何も無い案を「これでいく」にしない)。 */
export function everyoneOk(plan) {
  const names = planWorkerNames(plan);
  if (names.length === 0) return false;
  const acks = isObj(plan) && isObj(plan.acks) ? plan.acks : {};
  return names.every((n) => acks[n] === 'ok');
}

export default planOvertimeAsNeeded;
