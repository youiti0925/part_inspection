// ============================================================================
// 🥇 priority — 「どの仕事を先に」「その人を今この仕事へ使ってよいか」
// ----------------------------------------------------------------------------
// 出典: 是正指示書 5.5(配置優先順位) / 5.6(熟練者の使い方) と
//       src/domain/operationsSimulation/CONTRACT.md の priority.js の節。
//
// このファイルが答えるのは2つだけ:
//   ① 残っている仕事を、どの順で配るか            → compareJobs
//   ② その仕事へ、その人を使ってよいか(温存すべきか) → reserveSpecialist
//   ③ ①の物差し                                   → slackMs
// 実際に時間を進めて人を貼り付けるのは simulate.js の仕事。ここは「順番」と「可否」だけ。
//
// 🚨 決め事(CONTRACT.md 0章)
//   - React / Firebase を import しない。
//   - 関数の中で現在時刻や乱数を読まない。今の時刻は必ず ctx.atMs / 引数 atMs で受ける。
//     → 同じ入力なら毎回同じ並びになる(S23)。
//   - 分からない値を推測で埋めない。分からない時は null を返し、後回しの側へ倒す。
//   - しきい値・係数を直書きしない。ctx / options で受ける。
//
// ----------------------------------------------------------------------------
// 【なぜ「納期が早い順」ではないのか】(指示書5.5末尾)
//   納期が早い＝急ぎ、ではない。残作業30時間で納期が木曜の仕事と、残作業4時間で
//   納期が水曜の仕事なら、先に手を付けないと落ちるのは前者。
//   だから比べるのは **納期余裕(slack) = 納期までに実際に働ける時間 − 残作業** 。
//   「実際に働ける時間」は壁の時計の引き算では出ない(土日・休憩・休みがある)ので、
//   必ず calendar.workMsBetween に数えさせる。
//
// ----------------------------------------------------------------------------
// 【ctx に何を入れるか】
//   CONTRACT.md は compareJobs(a,b,ctx) / reserveSpecialist(job,worker,ctx) の
//   ctx の中身までは決めていない。ここで受け取る物を全部書く。
//   **入っていない物は「分かりません」として扱い、その観点での並べ替えをしない**。
//   （勝手に「設備は空いている」「その人は空いている」と決めつけない）
//
//   必須:
//     atMs                 今の実時刻(epoch ms)。now / nowMs でも受ける
//     calendar             makeCalendar() の戻り値。slack を出すのに要る
//   任意(あれば効く):
//     pendingJobs          まだ終わっていない・まだ誰も持っていない Job[]
//                          (jobs + doneJobIds / assignedJobIds でも同じ意味になる)
//     doneJobIds           終わった jobId の Set か配列
//     assignedJobIds       今 誰かが持っている jobId の Set か配列
//     eligibility          historyEligibility.buildEligibility() の戻り値
//     eligibleNamesOf(job) 上の代わりに直接 名前の配列を返す関数
//     isReady(job)         工程順・到着の判定を simulate 側が持っている場合
//     lotById              lotId -> normalized の lot。dueKind を見る
//     dueKindOf(job)       上の代わり
//     busyEquipment        今ふさがっている設備idの Set か配列
//     freeWorkers          今すぐ動ける人の名前(Set か配列)。busyWorkers / isFree(name) でも可
//     workers              [{name, currentJobId, busyUntilMs}] の配列でも読み取る
//     currentJobIdOf(name) その人が今やっている jobId
//     busyUntilOf(name)    その人が今の仕事を終える実時刻
//     workerName           今 仕事を探している人。持ち替えを避ける判定(規則9)に使う
//     switchGainThresholdMs 持ち替えてよい最小の改善(ms)。🚨 直書きしない。
//                          **渡されなければ持ち替えない**(数分ごとの持ち替えを防ぐ既定)
//     safetyFactor         残作業の安全側の見込み。既定1(見積そのまま。水増ししない)
//     priorityClass        🧵 true の時だけ、優先度の区分(job.priorityClass 0緊急/1特注/2通常)を
//                          **0番目の鍵** にする(2026-09-10 清水さん)。無ければ区分は1件も見ない
//
// ----------------------------------------------------------------------------
// 【指示書5.5 の1〜10 を、どこで効かせているか】
//   1 すでに納期超過        → compareJobs 第1鍵
//   2 納期余裕が小さい      → compareJobs 第2鍵(slackMs)
//   3 確定納期を暫定より先  → compareJobs 第3鍵(lot.dueKind)
//   4 今すぐ開始可能        → compareJobs 第4鍵
//   5 担当候補が少ない工程  → compareJobs 第5鍵
//   6 1人しかできない人を   → compareJobs 第6鍵(仕事の側の印) ＋ reserveSpecialist(本体)
//     共通作業へ使わない
//   7 共通作業は技能の範囲が→ reserveSpecialist の(b)。
//     狭い人から              🚨 これは「誰を選ぶか」の規則で、仕事の並び順では表せない。
//                             compareJobs に無理に鍵を作ると、意味の無い並べ替えになるので
//                             作らなかった。代わりに reserveSpecialist が
//                             「もっと範囲の狭い人が空いているなら、この人は温存」と答える。
//   8 設備が空いている      → compareJobs 第7鍵
//   9 不要な持ち替えを避ける→ compareJobs 第8鍵 ＋ reserveSpecialist の持ち替えしきい値
//  10 安定したID順          → compareJobs 最終鍵(jobId 昇順)
// ============================================================================

// 🧵 優先度の区分の番号の読み方(0/1 以外は通常)。番号と呼び名は lotFocus.js ただ1本。
import { priorityClassRank } from './lotFocus.js';

/** 既定値。🚨 現場の数字(勤務時間・間接係数など)はここに書かない。効かせない側の値だけ。 */
export const DEFAULT_PRIORITY_OPTIONS = Object.freeze({
  // 残作業の見込みを何倍で見るか。1 = 見積そのまま。
  // 🚨 既定で 1.2 などを掛けない。元データに無い水増しを既定にすると、
  //    「余裕が無い」という結論の出どころが分からなくなる。
  safetyFactor: 1,
  // 作業中の人を別の仕事へ移してよい最小の改善(ms)。
  // 🚨 既定は null = 「渡されないなら持ち替えない」。ここに5分などを書くと、
  //    指示書5.6 の「閾値は設定」が守られなくなる。
  switchGainThresholdMs: null,
});

/**
 * 納期の確からしさの順位。小さいほど先。
 * 実データの lot.dueKind は 'planned'(予定日) と 'none' の2つだけ
 * (normalizeInput.js 参照)。'confirmed' は今のデータには無いが、指示書5.5-3 が
 * 「確定納期を暫定納期より優先する」と言っているので、入ってきた時に効くようにしておく。
 */
const DUE_KIND_RANK = Object.freeze({
  confirmed: 0,
  fixed: 0,
  planned: 1,
  provisional: 1,
  none: 2,
});

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isFn = (v) => typeof v === 'function';
/**
 * 数として読める値だけを返す。読めなければ null。
 * 🚨 null / undefined / 空文字 / 真偽値を先に弾く理由:
 *   Number(null) は 0、Number('') も 0 になる。これを素通しにすると
 *   「納期が無い(dueLineMs=null)」が「1970年が納期」に化けて、
 *   全部の仕事が納期超過の先頭に並ぶ。実際にこの取り違えを作り込んで、
 *   カレンダーが「400日を超えました」で止まった。
 */
const finite = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 人は名前で見分ける(historyEligibility と同じ)。{name} を渡されても受ける。 */
const nameOf = (w) => {
  if (typeof w === 'string') return w.trim();
  if (isObj(w)) return String(w.name ?? w.worker ?? '').trim();
  return '';
};

/**
 * 並べ替えの最後の決め手。
 * ⚠ localeCompare を使わない。実行環境の言語データの有無で結果が変わる事があり、
 *   「同じ入力→同じ結果」(S23)が端末をまたいだ時に崩れる。
 *   jobId は `${lotId}#${工程}#${台}` で英数と # なので、符号位置の比較で足りる。
 */
const cmpId = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
};

/** 配列 / Set のどちらでも Set にして返す。無ければ null(=分かりません)。 */
const asSet = (v) => {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return null;
};

/** 名前の集合。{name} の配列でも受ける。 */
const asNameSet = (v) => {
  if (v instanceof Set) return new Set([...v].map(nameOf).filter(Boolean));
  if (Array.isArray(v)) return new Set(v.map(nameOf).filter(Boolean));
  return null;
};

/** obj / Map のどちらでも引ける読み出し。 */
const lookup = (holder, key) => {
  if (holder instanceof Map) return holder.get(key);
  if (isObj(holder)) return holder[key];
  return undefined;
};

// ── 納期余裕 ────────────────────────────────────────────────────────────────

/**
 * 安全側の残作業時間(ms)。分からなければ null。
 * 🚨 分からない時に 0 や 60秒を入れない(S16)。入れた瞬間、目標時間が無い工程が
 *    「すぐ終わる仕事」として扱われ、余裕があるという嘘の結論になる。
 * ⚠ ここと slackMs / makeView の2箇所で同じ規則を書くとすぐ食い違うので、定義はこの1本。
 */
const remainingMsOf = (job, givenMs, factor) => {
  const given = finite(givenMs);
  const own = job.durationKnown === false ? null : finite(job.durationMs);
  const base = given != null ? given : own;
  if (base == null) return null;
  return Math.round(Math.max(0, base) * factor);
};

/**
 * 「いつから数え始めるか」。
 * ⚠ まだ着いていない物は、着くまで始められない。今から数えると、来週着くロットに
 *   今週ぶんの働ける時間まで足してしまい、余裕が実際より大きく出る。
 */
const startFromMs = (job, atMs) => {
  const arrival = finite(job.arrivalMs);
  return (arrival != null && arrival > atMs) ? arrival : atMs;
};

/**
 * from から納期線までに実際に働けるミリ秒。
 * 既に越えていれば **負**(越えた分だけ小さくして、深く越えている物を先に出す)。
 * 🚨 壁の時計の引き算にしない。土日・休憩・休みを働ける時間に数えてしまう。
 */
const signedAvailMs = (fromMs, dueMs, who, calendar) => (
  fromMs >= dueMs
    ? -calendar.workMsBetween(dueMs, fromMs, who)
    : calendar.workMsBetween(fromMs, dueMs, who)
);

/**
 * 納期までの実働可能時間 − 安全側の残作業時間。
 *
 * @param {object} job        buildJobs の Job
 * @param {number} atMs       今の実時刻(epoch ms)
 * @param {object} calendar   makeCalendar() の戻り値
 * @param {string} [workerName] その人の休み・勤務を効かせたい時に渡す
 * @param {object} [options]  { safetyFactor, remainingMs }
 *        remainingMs … この仕事だけでなく「ロットの残り全部」で測りたい時に、
 *                      呼ぶ側(simulate)が計算して渡す。渡さなければこの仕事の見積を使う。
 * @returns {number|null} ミリ秒。小さいほど危ない。**null は「分かりません」**。
 *
 * 🚨 null を 0 や Infinity に丸めない。納期が無いロット(S17)や目標時間が無い工程(S16)を
 *    数値にしてしまうと、それが「間に合う」「間に合わない」の結論として一人歩きする。
 */
export function slackMs(job, atMs, calendar, workerName, options = {}) {
  if (!isObj(job)) {
    throw new Error('priority.slackMs: job（buildJobs が作った仕事1件）を渡してください');
  }
  const at = finite(atMs);
  if (at == null) {
    throw new Error('priority.slackMs: atMs（今の実時刻 epoch ms）を渡してください。この関数の中では現在時刻を読みません');
  }
  if (!isObj(calendar) || !isFn(calendar.workMsBetween)) {
    // 壁の時計の引き算で代用すると、土日・休憩・休みを「働ける時間」に数えてしまい、
    // 余裕が実際より大きく出る。黙って代用せず止める。
    throw new Error('priority.slackMs: calendar（makeCalendar の戻り値）を渡してください');
  }

  const due = finite(job.dueLineMs);
  if (due == null) return null; // S17: 納期が無い物を「今」や「間に合う」にしない

  const opt = isObj(options) ? options : {};
  const factorRaw = finite(opt.safetyFactor);
  const factor = (factorRaw != null && factorRaw > 0) ? factorRaw : DEFAULT_PRIORITY_OPTIONS.safetyFactor;

  // 残作業。呼ぶ側が「ロットの残り全部」を渡してくればそちらを優先する。
  const remain = remainingMsOf(job, opt.remainingMs, factor);
  if (remain == null) return null; // S16: 目標時間が無い所へ60秒などを入れない

  const who = nameOf(workerName) || undefined;
  return signedAvailMs(startFromMs(job, at), due, who, calendar) - remain;
}

// ── ctx の読み取り ──────────────────────────────────────────────────────────

/**
 * ctx ごとの計算結果の置き場。
 * ⚠ 並べ替えは1回の比較ごとに ctx を読む。毎回 slack を数え直したり、読み取り用の
 *   小関数を作り直したりすると、500件の並べ替え1回で 8ミリ秒かかった(実測)。
 *   出来事の度に並べ替える設計なので、これがそのまま iPad の待ち時間になる。
 *   → ctx と時刻が同じ間は、読み取り一式(view)ごと使い回す。
 * ⚠ 覚えるのは「時刻が同じなら変わらない物」だけ(slack・候補者・技能の範囲)。
 *   同じ時刻の中でも動く物(残っている仕事・誰が空いたか・設備)は、
 *   呼ばれた時に ctx から読み直す。
 */
const CTX_CACHE = new WeakMap();

function makeView(ctx, where) {
  if (!isObj(ctx)) {
    throw new Error(`priority.${where}: ctx（今の時刻・カレンダー・残っている仕事）を渡してください`);
  }
  const atMs = finite(ctx.atMs ?? ctx.nowMs ?? ctx.now);
  if (atMs == null) {
    throw new Error(`priority.${where}: ctx.atMs（今の実時刻 epoch ms）を渡してください。この関数の中では現在時刻を読みません`);
  }
  const calendar = (isObj(ctx.calendar) && isFn(ctx.calendar.workMsBetween)) ? ctx.calendar : null;

  let cache = CTX_CACHE.get(ctx);
  if (cache && cache.atMs === atMs && cache.view) return cache.view;
  if (!cache || cache.atMs !== atMs) {
    cache = {
      atMs, slack: new Map(), names: new Map(), breadth: new Map(),
      open: null, view: null, byProc: null, exKeys: new Map(),
      // 🚨 2026-08-23 性能: 温存の判定(reserveSpecialist)が全体の 88.2% を食っていた。
      //   中でも「その人しか頼めない仕事の待ち行列」を **1仕事×1候補者ごとに** 積み直していて、
      //   それだけで 47.9%(約3.8秒)。本番では尾田さん1人しか頼めない仕事が 1,904件あるため、
      //   一覧が桁違いに長い（実測: 12,895回 × 平均405件 = 延べ約590万件の積み直し）。
      //   下の3つは **「今の時刻」と「誰か」だけで決まり、どの仕事を頼もうとしているかに依存しない**。
      //   だから時刻ごとに1回だけ作って使い回す。
      exList: new Map(),      // 人 → その人しか頼めない、まだ手の付いていない仕事（並べ替え済み）
      exRunnable: new Map(),  // 人 → いま始められる専用作業が有るか(真偽)
      exBefore: new Map(),    // 人 → この仕事を挟まない時の遅れ(ms)
    };
    CTX_CACHE.set(ctx, cache);
  }

  /**
   * まだ手が付いていない仕事。pendingJobs が無ければ jobs から済み・持ち出し済みを引く。
   * ⚠ 済み一覧は **呼ばれる度に** 読む。同じ時刻の中でも1件ずつ配っていくので、
   *   view を作った時点で固めると「もう配った仕事」を残っている物として数えてしまう。
   */
  const openJobs = () => {
    const doneIds = asSet(ctx.doneJobIds ?? ctx.finishedJobIds);
    const assignedIds = asSet(ctx.assignedJobIds ?? ctx.inProgressJobIds);
    const raw = Array.isArray(ctx.pendingJobs) ? ctx.pendingJobs
      : (Array.isArray(ctx.runnableJobs) ? ctx.runnableJobs
        : (Array.isArray(ctx.jobs) ? ctx.jobs : []));
    if (!doneIds && !assignedIds) return raw.filter(isObj);
    return raw.filter((j) => isObj(j)
      && !(doneIds && doneIds.has(j.jobId))
      && !(assignedIds && assignedIds.has(j.jobId)));
  };

  /** 並べ替え用の索引。同じ時刻の間は使い回す(並べ替えの物差しなので、多少古くても順番が乱れるだけ)。 */
  const index = () => {
    if (cache.open) return cache.open;
    const list = openJobs();
    const byId = new Map();
    const lotGate = new Map(); // lotId -> 残っている「台ごとの工程」の中で一番小さい工程順
    for (const j of list) {
      byId.set(j.jobId, j);
      if (j.unitIndex !== null && j.unitIndex !== undefined) {
        const cur = lotGate.get(j.lotId);
        const n = finite(j.stepIndex);
        if (n != null && (cur == null || n < cur)) lotGate.set(j.lotId, n);
      }
    }
    cache.open = { list, byId, lotGate };
    return cache.open;
  };

  /**
   * まだ手が付いていない仕事を工程ごとに束ねた物。同じ時刻の間は使い回す。
   * 🚨 これが無いと reserveSpecialist が「残っている全部の仕事」を
   *   人ごと・呼ばれるたびに走査して並べ替える。実測(2026-08-22 本番282ロット・5日):
   *   その走査と並べ替えだけで全体の 56% を使い、1回の見立てに 26秒 かかっていた。
   */
  const openByProcess = () => {
    if (cache.byProc) return cache.byProc;
    const m = new Map();
    // 🚨 2026-08-23 性能(案B): ここは以前 index() を呼んでいた。
    //   index() は byId の Map と lotGate も作るが、**工程ごとに束ねるだけならどちらも要らない**。
    //   863ラウンド × pendingJobs 4,875件 = 約420万回の Map.set が丸ごと無駄だった（実測 −858ms）。
    //   ⚠ index() 自体は残す（jobById と readyNow の関所判定が使う）。呼ばないだけ。
    for (const j of openJobs()) {
      const k = String(j.processKey ?? '');
      let a = m.get(k);
      if (!a) { a = []; m.set(k, a); }
      a.push(j);
    }
    cache.byProc = m;
    return m;
  };

  /** その仕事がまだ配られていないか。索引は時刻ごとに固めるので、鮮度はここで見る。 */
  const stillOpen = (job) => {
    const doneIds = asSet(ctx.doneJobIds ?? ctx.finishedJobIds);
    const assignedIds = asSet(ctx.assignedJobIds ?? ctx.inProgressJobIds);
    if (doneIds && doneIds.has(job.jobId)) return false;
    if (assignedIds && assignedIds.has(job.jobId)) return false;
    return true;
  };

  /**
   * 「今このラウンドで実際に配れるか」。simulate が渡してくれる時はそちらを信じる。
   * readyNow は到着と前工程しか見ないので、目標時間が無くて配れない仕事も通してしまう。
   */
  const runnableNowOf = (job) => {
    if (isFn(ctx.isRunnableNow)) {
      const v2 = ctx.isRunnableNow(job);
      if (v2 !== null && v2 !== undefined) return !!v2;
    }
    if (job && job.durationKnown === false) return false;
    const d = finite(job && job.durationMs);
    if (d == null || d <= 0) return false;
    return readyNow(job);
  };

  /**
   * 「この人しか頼めない」まだ手の付いていない仕事。
   * 工程の数はロットの数よりずっと少ないので、工程ごとに1回だけ候補を調べる。
   */
  const exclusiveOpenFor = (who, exceptJobId) => {
    let keys = cache.exKeys.get(who);
    if (!keys) {
      keys = [];
      for (const [k, arr] of openByProcess()) {
        if (!arr.length) continue;
        const cand = candidateNames(arr[0]);
        if (Array.isArray(cand) && cand.length === 1 && cand[0] === who) keys.push(k);
      }
      cache.exKeys.set(who, keys);
    }
    const raw = [];
    for (const k of keys) {
      for (const j of (openByProcess().get(k) || [])) {
        if (j.jobId === exceptJobId) continue;
        if (!stillOpen(j)) continue;
        raw.push(j);
      }
    }
    // 🚨 **いつまでも始められない仕事のために手を空けない。**
    //   目標時間が入っていない工程は配れない。その後ろに並ぶ工程も、前が動かないので永久に動かない。
    //   これを温存の相手に数えると、熟練者が「来ない物」を待って共通作業も取らなくなる。
    //   しかもその納期が既に過ぎていると「割り込むと更に悪化する」と判定され、**永久に**温存される。
    //   実測(2026-08-22 本番): 尾田さんが16分。温存の相手10件は1件も着手できない物だった
    //   (f3cbc6ad2f24#7 に目標時間が無く、#8/#9/#10 がその後ろで詰まっていた)。
    const dead = new Set();
    for (const j of raw) {
      const d = finite(j.durationMs);
      if (j.durationKnown === false || d == null || d <= 0) dead.add(j.jobId);
    }
    // 前が動かない物も動かない。小さな集合なので不動点まで回す。
    for (let pass = 0; pass < raw.length + 1; pass += 1) {
      let grew = false;
      for (const j of raw) {
        if (dead.has(j.jobId)) continue;
        if (j.afterJobId && dead.has(j.afterJobId)) { dead.add(j.jobId); grew = true; }
      }
      if (!grew) break;
    }
    return raw.filter((j) => !dead.has(j.jobId));
  };

  /** この工程を頼める人の名前。分からなければ null(空配列と区別する)。 */
  const candidateNames = (job) => {
    const key = String(job?.processKey ?? '');
    if (cache.names.has(key)) return cache.names.get(key);
    let out = null;
    if (isFn(ctx.eligibleNamesOf)) {
      const r = ctx.eligibleNamesOf(job);
      if (Array.isArray(r)) out = r.map(nameOf).filter(Boolean);
    } else {
      const ef = isFn(ctx.eligibility?.eligibleFor) ? ctx.eligibility.eligibleFor
        : (isFn(ctx.eligibleFor) ? ctx.eligibleFor : null);
      if (ef) {
        const r = ef(job?.processKey);
        if (Array.isArray(r)) out = r.map(nameOf).filter(Boolean);
      }
    }
    cache.names.set(key, out);
    return out;
  };

  /**
   * その人の「技能の範囲の広さ」= いま残っている仕事の工程のうち、この人を候補に
   * 挙げている工程の数。指示書5.5-7 の「範囲が狭い人から」を測る物差し。
   * ⚠ 工程マスタ全体ではなく **残っている仕事** で数える。今日の配置の話なので、
   *   もう仕事の無い工程まで数えると「広い人」が実態より広く見える。
   */
  const breadthOf = (name) => {
    const who = nameOf(name);
    if (!who) return null;
    if (isFn(ctx.breadthOf)) {
      const v = finite(ctx.breadthOf(who));
      if (v != null) return v;
    }
    if (cache.breadth.has(who)) return cache.breadth.get(who);
    const keys = new Set();
    let known = false;
    for (const j of index().list) {
      const names = candidateNames(j);
      if (names == null) continue;
      known = true;
      if (names.includes(who)) keys.add(String(j.processKey ?? ''));
    }
    const out = known ? keys.size : null;
    cache.breadth.set(who, out);
    return out;
  };

  // この ctx が「誰のために」仕事を探しているか。休みの人の余裕は短くなるので、
  // 余裕を数える時にこの人を渡す。中の小関数の引数名 who と紛れないよう別名にする。
  const viewWorker = nameOf(ctx.workerName ?? ctx.worker ?? ctx.forWorker) || undefined;
  const factorRaw = finite(ctx.safetyFactor);
  const factor = (factorRaw != null && factorRaw > 0) ? factorRaw : DEFAULT_PRIORITY_OPTIONS.safetyFactor;

  /**
   * 「いつから」「どの納期線まで」で働ける時間を覚えておく。
   * ⚠ ここが並べ替えで一番重い(カレンダーを日ごとに歩く)。1ロット10台×3工程なら
   *   30件が同じ納期線・同じ到着なので、1回数えれば足りる。
   *   実測: 500件の余裕を出すのに、この覚え書きが無いと 3.2ミリ秒/回かかっていた。
   */
  const availCache = new Map();
  const availOf = (from, due) => {
    const key = `${from}|${due}`;
    if (availCache.has(key)) return availCache.get(key);
    const v = signedAvailMs(from, due, viewWorker, calendar);
    availCache.set(key, v);
    return v;
  };

  const slackOf = (job) => {
    const id = job?.jobId;
    if (cache.slack.has(id)) return cache.slack.get(id);
    let out = null;
    const due = calendar ? finite(job?.dueLineMs) : null;
    if (due != null) {
      // 🚨 規則は slackMs と同じ物を使う(remainingMsOf / startFromMs / signedAvailMs)。
      //    ここで書き直すと、画面に出る余裕と並べ替えの余裕が食い違う。
      const remain = remainingMsOf(job, undefined, factor);
      if (remain != null) out = availOf(startFromMs(job, atMs), due) - remain;
    }
    cache.slack.set(id, out);
    return out;
  };

  /** 今すぐ動ける人か。分からなければ null。 */
  const isFree = (name) => {
    const who = nameOf(name);
    if (!who) return null;
    // 休み・勤務時間外は、他に何が書いてあっても動けない。
    if (calendar && isFn(calendar.isAvailable) && !calendar.isAvailable(atMs, who)) return false;

    if (isFn(ctx.isFree)) return !!ctx.isFree(who);
    const freeSet = asNameSet(ctx.freeWorkers ?? ctx.idleWorkers ?? ctx.availableWorkers);
    if (freeSet) return freeSet.has(who);
    const busySet = asNameSet(ctx.busyWorkers);
    if (busySet) return !busySet.has(who);

    const until = busyUntilOf(who);
    if (until != null) return until <= atMs;
    if (currentJobIdOf(who)) return false;
    return null; // 何も手がかりが無い
  };

  const workerRow = (who) => {
    if (!Array.isArray(ctx.workers)) return null;
    return ctx.workers.find((w) => nameOf(w) === who) || null;
  };

  function currentJobIdOf(name) {
    const who = nameOf(name);
    if (!who) return null;
    if (isFn(ctx.currentJobIdOf)) return ctx.currentJobIdOf(who) ?? null;
    const m = lookup(ctx.currentJobIdByWorker ?? ctx.currentJobByWorker, who);
    if (m != null) return isObj(m) ? (m.jobId ?? null) : m;
    const row = workerRow(who);
    if (row) return row.currentJobId ?? row.jobId ?? null;
    // ctx 自体が1人ぶんの文脈として渡された時
    if (nameOf(ctx.workerName ?? ctx.worker) === who && ctx.currentJobId != null) return ctx.currentJobId;
    return null;
  }

  function busyUntilOf(name) {
    const who = nameOf(name);
    if (!who) return null;
    if (isFn(ctx.busyUntilOf)) return finite(ctx.busyUntilOf(who));
    const m = finite(lookup(ctx.busyUntilByWorker ?? ctx.workerBusyUntil ?? ctx.freeAtByWorker, who));
    if (m != null) return m;
    const row = workerRow(who);
    if (row) return finite(row.busyUntilMs ?? row.freeAtMs ?? row.endMs);
    if (nameOf(ctx.workerName ?? ctx.worker) === who) return finite(ctx.busyUntilMs ?? ctx.currentJobEndMs);
    return null;
  }

  /** 設備がふさがっているか。分からなければ null。 */
  const equipmentBusy = (job) => {
    const eq = job?.equipmentId;
    if (eq == null || eq === '') return false; // 設備の指定が無い＝取り合いにならない
    if (isFn(ctx.isEquipmentFree)) return !ctx.isEquipmentFree(eq);
    const busy = asSet(ctx.busyEquipment ?? ctx.occupiedEquipment);
    if (busy) return busy.has(eq);
    return null; // 設備の状態が渡されていない(設定自体が unset の事もある)
  };

  const dueKindOf = (job) => {
    if (isFn(ctx.dueKindOf)) return ctx.dueKindOf(job);
    const lot = lookup(ctx.lotById ?? ctx.lotsById, job?.lotId);
    if (isObj(lot) && lot.dueKind) return lot.dueKind;
    if (job && job.dueKind) return job.dueKind;
    return null;
  };

  const readyNow = (job) => {
    if (isFn(ctx.isReady)) return !!ctx.isReady(job);
    const arrival = finite(job?.arrivalMs);
    if (arrival != null && arrival > atMs) return false;
    const after = job?.afterJobId;
    if (after) {
      const doneIds = asSet(ctx.doneJobIds ?? ctx.finishedJobIds);
      // ⚠ 前工程が済んでいても、この後のロット1回工程の関所は必ず見る。
      //   ここで true を返して抜けると、まだ台の作業が残っているのに片付けを
      //   「始められる」と数えてしまう。
      if (doneIds) {
        if (!doneIds.has(after)) return false;
      } else if (index().byId.has(after)) {
        // 済み一覧が無くても、残っている仕事の中にまだ居るなら終わっていない。
        return false;
      }
    }
    // 🚨 ロットに1回の工程(片付け・員数)は、その前の「台ごとの工程」が全台終わるまで
    //    始められない(buildJobs.js の但し書き。afterJobId 1本では表せない条件)。
    if (job && (job.unitIndex === null || job.unitIndex === undefined)) {
      const gate = index().lotGate.get(job.lotId);
      const n = finite(job.stepIndex);
      if (gate != null && n != null && gate < n) return false;
    }
    return true;
  };

  const view = {
    atMs,
    calendar,
    openJobs,
    candidateNames,
    breadthOf,
    slackOf,
    isFree,
    currentJobIdOf,
    busyUntilOf,
    equipmentBusy,
    dueKindOf,
    readyNow,
    // 🚨 「今このラウンドで実際に配れるか」。simulate が渡してくれる時はそちらを信じる。
    //   readyNow は到着と前工程しか見ないので、目標時間が無くて配れない仕事も通してしまう。
    runnableNow: runnableNowOf,
    forWorker: viewWorker == null ? '' : viewWorker,
    // 🧵 優先度の区分(緊急>特注>通常)を **0番目の鍵** にするか。🚨 ctx.priorityClass === true の時だけ。
    //   立っていなければ compareJobs の並びは今までと1バイトも同じ。
    priorityClassOn: ctx.priorityClass === true,
    switchGainThresholdMs: finite(ctx.switchGainThresholdMs ?? ctx.reassignGainThresholdMs ?? ctx.switchThresholdMs),
    safetyFactor: finite(ctx.safetyFactor),
    jobById: (id) => index().byId.get(id) || null,
    exclusiveOpenFor,

    // 🚨 時刻ごとに1回だけ作る3つ（性能。答えは覚えない版と1ビットも変わらない）。
    /** その人しか頼めない、まだ手の付いていない仕事（納期順に並べ替え済み）。 */
    exListOf: (who) => {
      let v2 = cache.exList.get(who);
      if (v2 === undefined) {
        // ⚠ 写してから並べ替える。exclusiveOpenFor が返す配列をその場で並べ替えると
        //   工程ごとの束(openByProcess)の中身の並びまで変わってしまう。
        v2 = exclusiveOpenFor(who, null).slice().sort(byDueThenId);
        cache.exList.set(who, v2);
      }
      return v2;
    },
    /** いま始められる専用作業が有るか。 */
    exRunnableOf: (who, list) => {
      let v2 = cache.exRunnable.get(who);
      if (v2 === undefined) {
        v2 = list.some((j) => runnableNowOf(j));
        cache.exRunnable.set(who, v2);
      }
      return v2;
    },
    /** この仕事を挟まない時の、専門の待ち行列の遅れ(ms)。 */
    exBeforeOf: (who, list) => {
      let v2 = cache.exBefore.get(who);
      if (v2 === undefined) {
        v2 = runExclusiveQueue(list, atMs, 0, who, calendar).lateMs;
        cache.exBefore.set(who, v2);
      }
      return v2;
    },
    stillOpen,
  };
  cache.view = view;
  return view;
}

// ── 仕事の並び ──────────────────────────────────────────────────────────────
//
// ⚠ 比較の小道具は関数の外に置く。中で作ると、1回の比較ごとに小関数が作り直される。
//   500件の並べ替えは 4500回ほど比較するので、そこが丸ごと無駄になる(実測で効いた)。

/** 1. すでに納期を越えているか。0=越えている(先)。 */
const overdueRank = (job, atMs) => {
  const due = finite(job.dueLineMs);
  return (due != null && atMs > due) ? 0 : 1;
};

/** 3. 納期の確からしさ。見た事の無い区分は暫定と同じ扱いにする(勝手に確定にしない)。 */
const dueKindRank = (job, v) => {
  const k = v.dueKindOf(job);
  if (k == null) return finite(job.dueLineMs) == null ? DUE_KIND_RANK.none : DUE_KIND_RANK.planned;
  const r = DUE_KIND_RANK[String(k)];
  return r == null ? DUE_KIND_RANK.planned : r;
};

/**
 * 5. 担当候補の人数。少ないほど先。
 * 🚨 候補0人 と 分からない は、少ない側ではなく **後ろ** へ置く。
 *   0人は「この工程の記録がありません」という意味であって、今ここで人を貼れる相手が
 *   居ないという事。先頭に置いても置けないまま先頭を塞ぐだけ。
 */
const scarcityRank = (job, v) => {
  const names = v.candidateNames(job);
  if (names == null || names.length === 0) return Number.POSITIVE_INFINITY;
  return names.length;
};

/** 6. 1人しか頼めない仕事の印。0=1人だけ。 */
const soloRank = (job, v) => {
  const names = v.candidateNames(job);
  return (names && names.length === 1) ? 0 : 1;
};

/**
 * 8. 設備がふさがっている物は後ろ。
 * 🚨 設備の状態が渡されていなければ 0 のまま=並べ替えに使わない。
 *   本番の settings に設備の設定は1件も無い(unknowns.equipment='unset')ので、
 *   「空いている」と決めつけるとありもしない余裕が出る。
 */
const equipmentRank = (job, v) => (v.equipmentBusy(job) === true ? 1 : 0);

/** 9. 今やっている作業の続き(0) > 同じロット(1) > 別のロット(2)。 */
const stayRank = (job, currentJobId, currentJob) => {
  if (job.jobId === currentJobId) return 0;
  if (currentJob && job.lotId === currentJob.lotId) return 1; // 同じロットなら持ち替えが軽い
  return 2;
};

/**
 * 指示書5.5 の順で2つの仕事を比べる。負なら a が先。
 * 合計点は作らない。上の鍵で差が付いたらそこで決まる(点数にすると、何で決まったかが
 * 説明できなくなる)。
 *
 * @param {object} a Job
 * @param {object} b Job
 * @param {object} ctx 上の【ctx に何を入れるか】参照
 * @returns {number}
 */
export function compareJobs(a, b, ctx) {
  if (a === b) return 0;
  if (!isObj(a) || !isObj(b)) {
    throw new Error('priority.compareJobs: 仕事を2件渡してください');
  }
  const v = makeView(ctx, 'compareJobs');

  // ── 0. 優先度の区分(緊急0 > 特注1 > 通常2)。🚨 ctx.priorityClass === true の時だけ ──────
  // 清水さん(2026-09-10)「優先度は緊急＞特注＞通常みたいな感じにして、シミュレーション時の優先度に反映」。
  // 納期余裕(2)より **前** に置く。区分が同じ時だけ、下の1〜10で今までどおり並べる。
  // ⚠ 番号の読み替えは lotFocus.priorityClassRank(0/1 以外は通常)。ここで字は読まない。
  if (v.priorityClassOn) {
    const d0 = priorityClassRank(a.priorityClass) - priorityClassRank(b.priorityClass);
    if (d0 !== 0) return d0;
  }

  // ── 1. すでに納期を越えている物が先 ───────────────────────────────────
  // slack でも負になるので順番自体は同じだが、「越えている」と「間に合うが余裕が無い」は
  // 現場では別の話なので、鍵を分けて先頭に置く(指示書5.5-1)。
  const d1 = overdueRank(a, v.atMs) - overdueRank(b, v.atMs);
  if (d1 !== 0) return d1;

  // ── 2. 納期余裕が小さい方が先 ─────────────────────────────────────────
  // 🚨 余裕が分からない物(納期なし S17 / 目標時間なし S16)は、分かる物の後ろへ。
  //    先頭へ置くと、分からない物が延々と順番待ちの先頭を占める。
  //    「分かりません」は unknowns として explain 側が原因に出す。
  const sa = v.slackOf(a);
  const sb = v.slackOf(b);
  const ua = sa == null ? 1 : 0;
  const ub = sb == null ? 1 : 0;
  if (ua !== ub) return ua - ub;
  if (sa != null && sb != null && sa !== sb) return sa < sb ? -1 : 1;

  // ── 3. 確定納期を、暫定納期より先 ─────────────────────────────────────
  const d3 = dueKindRank(a, v) - dueKindRank(b, v);
  if (d3 !== 0) return d3;

  // ── 4. 今すぐ始められる物が先 ─────────────────────────────────────────
  const d4 = (v.readyNow(a) ? 0 : 1) - (v.readyNow(b) ? 0 : 1);
  if (d4 !== 0) return d4;

  // ── 5. 担当候補が少ない工程が先 ───────────────────────────────────────
  const c5a = scarcityRank(a, v);
  const c5b = scarcityRank(b, v);
  if (c5a !== c5b) return c5a < c5b ? -1 : 1;

  // ── 6. 1人しか頼めない仕事の印 ────────────────────────────────────────
  // 本体は reserveSpecialist(「その人を共通作業へ使わない」)。ここは仕事の側の印だけ。
  // 5の鍵と重なる場面が多いが、5を将来変えた時に規則6が黙って消えないよう残す。
  const d6 = soloRank(a, v) - soloRank(b, v);
  if (d6 !== 0) return d6;

  // ── 8. 設備が空いている方が先 ─────────────────────────────────────────
  // (7 は「誰を選ぶか」の規則なので reserveSpecialist 側。ファイル冒頭の対応表参照)
  const d8 = equipmentRank(a, v) - equipmentRank(b, v);
  if (d8 !== 0) return d8;

  // ── 9. 同じ危険度なら、今やっている作業を続ける ───────────────────────
  // 持ち替えは段取り替え・置き場の移動が要る。危険度が同じなら続ける方が速い。
  const current = v.forWorker ? v.currentJobIdOf(v.forWorker) : null;
  if (current) {
    const curJob = v.jobById(current);
    const d9 = stayRank(a, current, curJob) - stayRank(b, current, curJob);
    if (d9 !== 0) return d9;
  }

  // ── 10. 最後は安定したID順(同じ入力なら毎回同じ結果 = S23) ─────────────
  return cmpId(a.jobId, b.jobId);
}

// ── 熟練者の温存 ────────────────────────────────────────────────────────────

/**
 * その人が「その人しか頼めない」仕事を、納期順に片付ける段取り。
 * @returns {{finishMs:number, lateMs:number}} 最後の1件が終わる実時刻と、遅れの合計
 *
 * ⚠ 目標時間が分からない仕事は数に入れない。0分でも60秒でも、入れれば嘘の結論になる。
 *   (入れない側に倒すと温存しにくくなる＝人を遊ばせにくい方へ倒れる)
 */
function runExclusiveQueue(list, fromMs, extraMs, who, calendar) {
  let t = calendar.addWorkMs(fromMs, Math.max(0, extraMs), who);
  let late = 0;
  for (const j of list) {
    const dur = finite(j.durationMs);
    if (j.durationKnown === false || dur == null || dur <= 0) continue;
    const arrival = finite(j.arrivalMs);
    const start = (arrival != null && arrival > t) ? calendar.addWorkMs(arrival, 0, who) : t;
    t = calendar.addWorkMs(start, dur, who);
    const due = finite(j.dueLineMs);
    if (due != null && t > due) late += t - due;
  }
  return { finishMs: t, lateMs: late };
}

/** 納期の早い順。納期が無い物は最後(順番の中でだけの扱いで、外しはしない)。 */
const byDueThenId = (x, y) => {
  const dx = finite(x.dueLineMs);
  const dy = finite(y.dueLineMs);
  if (dx == null && dy == null) return cmpId(x.jobId, y.jobId);
  if (dx == null) return 1;
  if (dy == null) return -1;
  if (dx !== dy) return dx < dy ? -1 : 1;
  return cmpId(x.jobId, y.jobId);
};

/**
 * 「この人は温存すべきか」= その仕事へ今この人を使わない方がよいか。
 * 指示書5.6。
 *
 * @param {object} job    これから頼もうとしている仕事
 * @param {string|object} worker 頼もうとしている人(名前 か {name})
 * @param {object} ctx    ファイル冒頭の【ctx に何を入れるか】
 * @returns {boolean} true なら「この人は温存」(＝この仕事へは付けない)
 *
 * 判定の順:
 *   0) その仕事をこの人しか頼めない → 本人の仕事なので温存しない
 *   1) この人しか頼めない仕事が1件も待っていない → 温存する理由が無い
 *   2) 今その仕事をやっている最中に聞かれた → 持ち替えの改善が閾値未満なら続ける
 *   3) この仕事を挟むと、専門の待ち行列が納期線を越える → 温存する
 *   4) もっと技能の範囲が狭い人が空いている → その人へ回す(指示書5.6末尾・5.5-7)
 *
 * 🚨 分からない事があれば false(温存しない)へ倒す。温存は人の手を止める判断なので、
 *    根拠が無いまま止めると「適格な仕事があるのに待機」(S02)を自分で作ってしまう。
 */
export function reserveSpecialist(job, worker, ctx) {
  if (!isObj(job)) return false;
  const who = nameOf(worker);
  if (!who) return false;

  const v = makeView(ctx, 'reserveSpecialist');
  if (!v.calendar) {
    throw new Error('priority.reserveSpecialist: ctx.calendar（makeCalendar の戻り値）を渡してください');
  }

  const names = v.candidateNames(job);
  if (names == null) return false;      // 候補が分からないなら温存の判断もしない
  if (!names.includes(who)) return false; // そもそもこの人の候補ではない
  if (names.length <= 1) return false;    // 0) この人しか頼めない＝本人の仕事

  // 1) この人しか頼めない、まだ手の付いていない仕事
  //    🚨 ここで毎回 openJobs() を全部なめて並べ替えていた(全体の56%)。
  //    工程ごとの束から拾い、並べ替えは **本当に要る所まで遅らせる**。
  // 🚨 2026-08-23 性能: ここは「時刻と人」だけで決まるので、時刻ごとに1回だけ作る。
  //   前は 1仕事×1候補者ごとに作り直していて、全体の 47.9% を食っていた。
  //
  //   ⚠ 覚えてよい理由: exceptJobId(= いま頼もうとしている仕事) が この一覧に入る事は無い。
  //     すぐ上の `if (names.length <= 1) return false;` が「その人しか頼めない仕事」を
  //     先に弾いているので、ここへ来る job は定義上「1人しか頼めない工程」ではない。
  //     本番実測でも 5日 11,673回 / 30日 58,541回すべてで **0件**（外れ0回）。
  //     それでも保険として、万一入っていたら覚え書きを使わない道を残す。
  //
  //   ⚠ 並べ替えは写してからやる。
  //     ⚠2026-08-23 訂正: 前はここに「exclusiveOpenFor が返す配列を その場で並べ替えると
  //       openByProcess の束まで書き換わる」と書いていたが、**それは事実ではない**。
  //       exclusiveOpenFor は最後に raw.filter(...) で **毎回新しい配列** を返すので、
  //       その場で並べ替えても束は1つも壊れない。
  //       写すのは「覚えた一覧を、呼ぶ側が並べ替えて壊さないようにする」ためだけ。
  const exCache = v.exListOf(who);
  const inCache = exCache.some((j) => j.jobId === job.jobId);
  let exclusive = inCache ? v.exclusiveOpenFor(who, job.jobId).slice().sort(byDueThenId) : exCache;
  // 🚩 優先度の区分(2026-09-11 確かめ役の実測): 緊急の仕事が並びの先頭に在っても、候補の全員が
  //   「この人しか頼めない **通常** の仕事が待っている」で温存され、緊急が 08:33→10:10 まで放置された
  //   (写し 2026-09-10_1000・3a4d46c1 を urgent にした時。信濃さんは温存のまま 1時間半 待機)。
  //   清水さんの「緊急＞特注＞通常」は温存より上に置く: **この仕事より区分の低い** 専用作業のためには
  //   手を空けない。同じか高い区分の専用作業が待っているなら、今までどおり温存する。
  // 🚨 ctx.priorityClass === true の時だけ。立っていなければ一覧は1件も削らない(答えは今までと同じ)。
  let classCut = false;
  if (v.priorityClassOn) {
    const myClass = priorityClassRank(job.priorityClass);
    const kept = exclusive.filter((j) => priorityClassRank(j.priorityClass) <= myClass);
    if (kept.length !== exclusive.length) { exclusive = kept; classCut = true; }
  }
  if (exclusive.length === 0) return false;
  const sortedExclusive = () => exclusive;

  // 2) 今まさにその仕事をやっている人に「続けるか」を聞かれている場合(指示書5.6)
  const currentJobId = v.currentJobIdOf(who);
  if (currentJobId && currentJobId === job.jobId) {
    const threshold = v.switchGainThresholdMs;
    // 🚨 閾値が渡されていなければ持ち替えない。ここに「5分」などを書くと、
    //    数分ごとに人が行ったり来たりする絵になる(指示書5.6)。
    if (threshold == null) return false;
    const busyUntil = v.busyUntilOf(who);
    if (busyUntil == null) return false; // いつ空くか分からないなら比べようがない
    const nowSwitch = runExclusiveQueue(sortedExclusive(), v.atMs, 0, who, v.calendar).lateMs;
    const keepGoing = runExclusiveQueue(sortedExclusive(), busyUntil, 0, who, v.calendar).lateMs;
    const gain = keepGoing - nowSwitch;
    return gain >= threshold;
  }

  // 2.5) 🚨 指示書5.6 の本文そのもの:
  //   「熟練者しかできない作業が **待っている** 時、熟練者を一般作業へ割り当てない」。
  //   3)4) だけでは弱かった。3) は「挟んでも納期に間に合うなら通す」、4) は「もっと範囲の
  //   狭い人が **空いている** 時だけ止める」なので、狭い人が埋まった瞬間に熟練者が共通作業へ
  //   流れ、専用作業が後ろへずれる。
  //   実測(2026-08-22 S05b): 共通作業2本＋専用作業1本／尾田(専用+共通)・片山(共通)で、
  //   片山が1本目を取った直後に尾田が2本目の共通作業を取り、専用作業が2時間遅れた。
  //   ⚠ **いま始められる**専用作業に限る。未入荷や前工程待ちの物まで待つと、
  //     手が空いているのに何もしない絵になる(指示書5.4 / S02「理由なし待機を出さない」)。
  //   🚨 目標の作業時間が分かっていない仕事は **配れない**（simulate が unresolved へ回す）。
  //   それを待って手を空けると、永久に来ない物を待つ「理由付きの待機」になる。
  //   実測(2026-08-22 本番): 尾田さんが 11:29〜11:45 を「専門の作業のために手を空けています」で
  //   待っていたが、待っていた相手は目標時間が無くて配置できない仕事だった。
  // 🚨 「いま始められる専用作業が有るか」も 時刻と人 だけで決まる（延べ1,155万件を見ていた）。
  // ⚠ 区分で削った一覧は 人ごとの覚え書き(exRunnableOf / exBeforeOf)と中身が違うので、覚え書きを使わない。
  const anyRunnable = (inCache || classCut)
    ? exclusive.some((j) => v.runnableNow(j))
    : v.exRunnableOf(who, exclusive);
  if (anyRunnable) return true;

  // 3) この仕事を挟んだせいで専門の待ち行列が線を越えるなら温存。
  //    ⚠ 挟まなくても既に越えているなら、この配置が原因ではない。温存しても救えないので
  //      手を止めさせない(assign.js の okAfter/okBefore と同じ考え方)。
  const dur = (job.durationKnown === false) ? 0 : (finite(job.durationMs) ?? 0);
  const after = runExclusiveQueue(sortedExclusive(), v.atMs, dur, who, v.calendar).lateMs;
  // 🚨 before は「この仕事を挟まない時」なので **仕事に依存しない**。時刻と人で1回だけ。
  const before = (inCache || classCut)
    ? runExclusiveQueue(sortedExclusive(), v.atMs, 0, who, v.calendar).lateMs
    : v.exBeforeOf(who, exclusive);
  if (after > before) return true;

  // 4) 納期の上ではまだ余裕があっても、他の人でもできる仕事へ熟練者を使わない
  //    (指示書5.6末尾「他の作業者が空いているのに熟練者だけが一般作業をしている状態を
  //     理由なく許さない」／5.5-7「共通作業は技能の範囲が狭い人から」)。
  //    ⚠ 一番狭い人は必ず false になるので、全員が温存されて仕事が止まる事は無い。
  const mine = v.breadthOf(who);
  if (mine == null) return false;
  for (const other of names) {
    if (other === who) continue;
    const theirs = v.breadthOf(other);
    if (theirs == null || theirs >= mine) continue;
    const free = v.isFree(other);
    // free===null は「誰が空いているか渡されていない」。その時は
    // 「simulate は空いている人について聞いてくる」という前提で、空いている物として扱う。
    // 🚨 明示されていれば必ずそちらが勝つ(ctx.freeWorkers / isFree / busyUntil…)。
    if (free === false) continue;
    return true;
  }

  return false;
}
