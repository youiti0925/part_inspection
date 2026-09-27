// =============================================================================
//  monthly.js — 「月毎の必要な人材」と、その中の週の内訳
// -----------------------------------------------------------------------------
//  清水さん(2026-08-31):
//    「シミュレーションは一月毎にして、月毎の必要な人材を確認する感じ。
//      詳細を見るために一週間毎も見る」
//    「月毎でやるのは…一週間前だと間に合わないけど、
//      一月前にわかったら準備する時間もあるから間に合うからね」
//    「月毎の意味は早めに必要な情報が知りたいからって意味」
//
//  つまりこの表が答えるのは「何人足りないか」だけではありません。
//  **その教育を今から始めて間に合うか** まで言えないと、月で見る意味がありません。
//  だから月×工程の行には **持てる人の名前** を必ず添えます（相手が決まらないと始められない）。
//
// -----------------------------------------------------------------------------
//  🚨 ここが守る事（どれも過去に事故を起こした形です）
//
//   ① **1つの数に丸めない。** 月の全体行は
//      ①要る時間 ②働ける時間 ③不足人日 ③′1か月フルで張り付く人 ④数えられていない件数
//      を並べて出します。1つに丸めると、期間を変えるだけで 5.57人→0.93人＝6.0倍 動く
//      形（実測）がそのまま画面へ出ます。
//
//   ② **③′の分母（その月の営業日数）を同じ行に必ず書く。**
//      「0.6人」だけを見た人は、何で割った 0.6 なのか分かりません。
//
//   ③ **工程の行を足しても全体の行になりません。** 同じ人が何工程も持てるからです
//      （forecast.js の buildProcessSupply にも同じ注意が書いてあります）。
//      だから **合計欄を作りません**。作った瞬間、その数が独り歩きします。
//
//   ④ **「持てる人が分かりません」を不足の数に混ぜない**（SHORTFALL.UNKNOWN）。
//      2026-08-20 清水さん: 実績が無いのは「分かりません」であって、
//      やれないという意味ではありません。混ぜると教育の機会が消えます。
//      灰色の別枠（unknownOwnerProcesses）に出します。
//
//   ⑤ **capacityByMonth は idleLog を1行も読みません。**
//      idleLog は「余っていた時間」で、仕事が詰まっているほど 0 に近づきます。
//      これを供給に使うと **忙しいほど必ず「足りない」と出る**（2026-09-01 段1-③で是正済み）。
//      供給は「その期間に**働ける**時間」＝ calendar.workMsBetween から出します。
//
//   ⑥ **時間を週へ切る時に `endMs - startMs` を使いません。**
//      simulate の addWorkMs は夜・土日・休憩をまたいで先へ送るので、生の引き算には
//      夜と土日が丸ごと入ります（段2で直した 3.19倍事故と同じ形）。必ず
//      `calendar.workMsBetween(max(start, 週の始め), min(end, 週の終わり), 名前)`。
//
//  ⚠ ここは純関数だけ。Firestore も React も時計(Date.now)も触りません。
//     基準時刻は必ず引数で受け取ります。
// =============================================================================

import {
  SHORTFALL,
  buildProcessDemand,
  buildProcessSupply,
  findShortfalls,
  namesOf,
  readNumberOrNull,
} from './forecast.js';
// 🚨 決まり22-3。判定の言葉に添える1文は untouchedPile.js の物を**呼ぶだけ**。
//   ここで文を書き起こすと、同じ数字が2つの計算から出ます。
import { pileArrivalSentence } from './untouchedPile.js';

// 🚨 納期の読み方は forecast.js から**もらう**。ここで書き直さない。
//   `Number(null)` は 0（＝1970年1月1日）。自分で書くとその罠を2か所に持つ事になる。
const num = readNumberOrNull;
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));

/** 月の判定。🚨 「足りない」と「まだ判定していません」を混ぜない。 */
export const MONTH_VERDICT = Object.freeze({
  /** 回ります */
  OK: 'ok',
  /** 回りますが余裕がありません */
  TIGHT: 'tight',
  /** 足りません */
  SHORT: 'short',
  /** まだ判定していません（材料が足りない）。🚨 「足ります」にも「足りません」にも寄せない */
  UNJUDGEABLE: 'unjudgeable',
  /**
   * この月は途中から見ている（もう終わった月・残りが数日しかない月）。
   * 🚨 2026-09-01 清水さん「実際も8月終わってるだろ今の人数で」。
   *   8月30日に見た「8月」は、営業21日のうち **残り1日** です。
   *   その1日に「8月に納期が来る仕事」を丸ごとぶつけて「2.46人日足りません」と
   *   出していました。**足りなかったのは8月ではなく、8月31日の1日** です。
   * 🚨 UNJUDGEABLE（材料が足りない）とは**別の言葉**にしてあります。
   *   ここは材料が揃っていて、見ている窓が短いだけです。混ぜると理由が伝わりません
   *   （2026-08-22「すでに超過／この先の見込み／判定できない を混ぜるな」）。
   */
  PARTIAL: 'partial',
});

/**
 * 週へ数える時の3つの規則。**混ぜません。足せる形で並べません。**
 * この3つは別々の話で、足し合わせても何の意味も持ちません。
 */
export const WEEK_RULE = Object.freeze({
  /** 時間(分) … 実際に働いた分だけその週へ。またいだ仕事は**両方の週に分かれる** */
  MINUTES: 'minutes-split',
  /** 片付く件数 … **終わる週にただ1つ**。分けると1件が1.5件に見える */
  FINISHED: 'finish-week-only',
  /** 納期が来る件数 … **納期線の週にただ1つ**。上の2つとは別の話 */
  DUE: 'due-week-only',
});

/** 'YYYY-MM-DD' → その日のローカル0時。🚨 new Date('2026-09-01') は UTC 扱いで9時間ずれる。 */
const ymdToLocalMs = (text) => {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(str(text));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
};

const nextDayMs = (dayMs) => {
  const d = new Date(dayMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 小数1桁。画面へ出す数はここで丸める（0.6人日 のような読める粒度にする）。 */
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// -----------------------------------------------------------------------------
// 1. 需要 — その月に納期が来る仕事
// -----------------------------------------------------------------------------
/**
 * 仕事を月へ振り分ける。
 *
 * 🚨 数え方は1行も書き直しません。振り分けた後は既存の buildProcessDemand を呼ぶだけです。
 *   ここで工程ごとの足し算をもう1本書くと、日・週の画面と月の画面で違う数が出ます。
 *
 * 🚨 切った外の分を落としません。落とすと「需要が小さい＝足りている」という嘘になります。
 *   ・納期が無い          → outside.noDue
 *   ・最初の月より前の納期 → outside.beforeFirstMonth（既に納期を過ぎた仕事）
 *   ・最後の月より後の納期 → outside.afterLastMonth
 *
 * ⚠ 振り分けは **暦の月まるごと**（monthFromMs〜monthToMs）で行います。
 *   index 0 の fromMs は「今」ですが、そちらで切ると
 *   「今日より前に納期が来ていた今月の仕事」がどの月にも入らず消えます。
 *
 * 🚨🚨 2026-09-01 清水さん「今の人数で処理できたのに足りないってどういうこと」。
 *   ここに **納期がもう過ぎている仕事** が混ざっていたのが、あの数字の一番大きい原因です。
 *   実測（2026-08-30 12:11 の控え）: 製品検査 8月の要る時間 5,688.3分 のうち
 *   納期超過分が大半で、比べる相手は「8月に**残っている**営業1日」でした。
 *   → `nowMs` を渡すと、**納期が nowMs より前の仕事は月の箱へ1件も入りません**。
 *     `outside.overdue` と、月ごとの `overdue`（別の行）へ出します。
 *   ⚠ nowMs を渡さない時は今までどおりの数え方です（後ろ向きに壊さない為）。
 *
 * 🚨 「一時置きに置かれたまま作業の記録が1件も無いロット」は `pileByLot` で数えます。
 *   **需要から引きません**（終わっている証拠が無いので。2026-08-20）。
 *   月ごとの `pile`（件数・分・割合）へ別に出して、判定の言葉を弱めるのに使います。
 *
 * @param {object} args
 * @param {Array} args.jobs buildJobs の戻り値（残っている仕事）
 * @param {Map<string,number|null>|object} [args.dueLineByLot] lotId → 納期線
 * @param {Array} args.periods buildMonthPeriods の戻り値
 * @param {number} [args.nowMs] 基準時刻。渡すと納期超過分を月の箱から外す
 * @param {Map<string,object>|Set<string>|object} [args.pileByLot] untouchedPile.js の byLot
 */
export function demandByMonth({
  jobs, dueLineByLot = null, periods = [], nowMs = null, pileByLot = null,
} = {}) {
  const ps = arr(periods);
  const now = num(nowMs);
  /** そのロットが「一時置き かつ 記録0件」か。渡っていなければ常に false。 */
  const isPile = (lotId) => {
    if (pileByLot instanceof Set) return pileByLot.has(lotId);
    if (pileByLot instanceof Map) {
      const v = pileByLot.get(lotId);
      return v === true || (isObj(v) && v.pile === true);
    }
    if (isObj(pileByLot)) {
      const v = pileByLot[lotId];
      return v === true || (isObj(v) && v.pile === true);
    }
    return false;
  };
  /**
   * 🚨 決まり22。その山が「入荷日で説明が付く」か。
   *   untouchedPile.js が付けた印（arrivalExplained / arrivalWhy）を **読むだけ**。
   *   ここで判定を書き起こしません（同じ数字を2つの計算から出さない）。
   *   Set だけを渡す古い呼び方では印が無いので null（＝分けていない）になります。
   */
  const pileRowOf = (lotId) => {
    if (pileByLot instanceof Set) return null;
    if (pileByLot instanceof Map) { const v = pileByLot.get(lotId); return isObj(v) ? v : null; }
    if (isObj(pileByLot)) { const v = pileByLot[lotId]; return isObj(v) ? v : null; }
    return null;
  };
  // 🚨 ここが「Number(null) は 0」の関所。num は forecast.js の物（null は null のまま）。
  const readDue = (lotId) => {
    if (dueLineByLot instanceof Map) return num(dueLineByLot.get(lotId));
    if (isObj(dueLineByLot)) return num(dueLineByLot[lotId]);
    return null;
  };

  const monthFrom = (p) => num(p.monthFromMs != null ? p.monthFromMs : p.fromMs);
  const monthTo = (p) => num(p.monthToMs != null ? p.monthToMs : p.toMs);

  const buckets = ps.map(() => []);
  /** 月ごとの「納期がもう過ぎている仕事」。🚨 buckets には1件も入れない */
  const overdueBuckets = ps.map(() => []);
  /** 月ごとの「一時置き かつ 記録0件」の仕事。⚠ buckets にも入っている（引かない） */
  const pileBuckets = ps.map(() => []);
  /** 🚨 決まり22。山のうち「入荷日で説明が付く」分 と「説明が付かない」分。⚠ どちらも buckets に入っている */
  const pileKnownBuckets = ps.map(() => []);
  const pileUnexplainedBuckets = ps.map(() => []);
  /** 月ごとの「理由 → ロット数」。決まり18 の2種をそのまま運ぶ（1つに混ぜない） */
  const pileWhyLots = ps.map(() => new Map());
  const noDue = [];
  const before = [];
  const after = [];
  const overdue = [];
  const firstFrom = ps.length ? monthFrom(ps[0]) : null;
  const lastTo = ps.length ? monthTo(ps[ps.length - 1]) : null;

  /** その納期がどの月の箱か。無ければ -1。 */
  const monthIndexOf = (due) => ps.findIndex((p) => {
    const f = monthFrom(p);
    const t = monthTo(p);
    return f != null && t != null && due >= f && due < t;
  });

  arr(jobs).forEach((job) => {
    if (!isObj(job)) return;
    const lotId = str(job.lotId);
    const due = readDue(lotId);
    // 🚨 納期が無い物を落とさない。0(1970年)にもしない。
    if (due == null) { noDue.push(job); return; }
    // 🚨🚨 納期がもう過ぎている仕事は、月の箱へ1件も入れない。
    //   ここを入れたままにすると、「もう終わった月」に積み残しをぶつけて
    //   「足りません」と言う形（2026-09-01 の苦情そのもの）に戻ります。
    //   ⚠ 落とすのではありません。overdue へ移して、別の行として必ず出します。
    if (now != null && due < now) {
      overdue.push(job);
      const oi = monthIndexOf(due);
      if (oi >= 0) overdueBuckets[oi].push(job);
      return;
    }
    if (firstFrom != null && due < firstFrom) { before.push(job); return; }
    if (lastTo != null && due >= lastTo) { after.push(job); return; }
    const i = monthIndexOf(due);
    // 帯に隙間があった時（buildMonthPeriods を使う限り起きない）。黙って捨てない。
    if (i < 0) { after.push(job); return; }
    buckets[i].push(job);
    // 🚨 山は buckets から**引きません**。同じ仕事を別の箱でも数えるだけです。
    if (isPile(lotId)) {
      pileBuckets[i].push(job);
      // 🚨 決まり22。山を2つに分ける。印が無い（＝索引が渡っていない）時は
      //   **どちらにも入れない**（0件と書かない＝「分けていません」の意味）。
      const row = pileRowOf(lotId);
      const explained = row ? row.arrivalExplained : null;
      if (explained === true) {
        pileKnownBuckets[i].push(job);
        const why = str(row.arrivalWhy) || 'unknownWhy';
        let s = pileWhyLots[i].get(why);
        if (!s) { s = new Set(); pileWhyLots[i].set(why, s); }
        s.add(lotId);
      } else {
        // 🚨 explained === false（説明が付かない）だけでなく、
        //   null（索引が渡っていない＝**確かめていない**）も こちらへ入れます。
        //   確かめていない物を「説明が付いた」側へ寄せると、索引を配線し忘れた日に
        //   黙って判定が出るようになります（見張りが素通りする形）。
        pileUnexplainedBuckets[i].push(job);
      }
    }
  });

  const mk = (list) => ({
    ...buildProcessDemand({ jobs: list }),
    jobCount: list.length,
    /** 🚨 ロット数は **同じ箱の job から**数える（別の所で数え直さない。決まり22-3 の分母） */
    lotCount: new Set(list.map((j) => str(j.lotId)).filter(Boolean)).size,
  });
  /** 件数と分だけの軽い箱（別の行に出す用）。工程ごとの表は要らない。 */
  const mkLite = (list) => {
    const d = buildProcessDemand({ jobs: list });
    const lotIds = new Set(list.map((j) => str(j.lotId)).filter(Boolean));
    return {
      jobCount: list.length,
      lotCount: lotIds.size,
      minutes: d.totalMinutes,
      unknownJobCount: d.unknownJobCount,
    };
  };

  return {
    months: ps.map((p, i) => ({
      index: p.index != null ? p.index : i,
      label: str(p.label),
      ym: str(p.ym),
      ...mk(buckets[i]),
      /**
       * 🚨 納期がもう過ぎている分。**上の totalMinutes には1分も入っていません。**
       *   画面では必ず別の行に出します（2026-08-22「混ぜるな」）。
       */
      overdue: mkLite(overdueBuckets[i]),
      /**
       * 🚨 一時置きに置かれたまま作業の記録が1件も無い分。
       *   **上の totalMinutes には入っています**（終わっている証拠が無いので引けません）。
       *   割合を出して、判定の言葉を弱めるのに使います。
       */
      pile: mkLite(pileBuckets[i]),
      /**
       * 🚨🚨 決まり22。山の内訳。**上の pile を2つに割った物**（足すと pile になります）。
       *   pileArrivalUnknown … 入荷日で説明が付く分。判定を止める理由に **使いません**
       *   pileUnexplained    … 説明が付かない分。判定を止めるのは **こちらだけ**
       *   ⚠ 索引が渡っていない時は両方 0件 のまま（＝分けていない）。
       */
      pileArrivalUnknown: {
        ...mkLite(pileKnownBuckets[i]),
        /** 理由ごとのロット数。決まり18 の2種をそのまま運ぶ */
        whyCounts: Object.fromEntries([...pileWhyLots[i].entries()].map(([k, s]) => [k, s.size])),
      },
      pileUnexplained: mkLite(pileUnexplainedBuckets[i]),
    })),
    outside: {
      /** 🚨 納期が入っていない仕事。どの月にも入りません */
      noDue: mk(noDue),
      noDueJobCount: noDue.length,
      /**
       * 🚨 納期がもう過ぎている仕事（nowMs を渡した時だけ）。
       *   どの月の不足人日にも1分も入っていません。
       */
      overdue: mk(overdue),
      overdueJobCount: overdue.length,
      overdueMinutes: buildProcessDemand({ jobs: overdue }).totalMinutes,
      /** 既に納期を過ぎている仕事（最初の月より前）。nowMs を渡すと overdue が先に拾います */
      beforeFirstMonth: mk(before),
      beforeFirstMonthJobCount: before.length,
      /** 見ている月より先に納期が来る仕事 */
      afterLastMonth: mk(after),
      afterLastMonthJobCount: after.length,
      totalJobCount: noDue.length + before.length + after.length + overdue.length,
    },
  };
}

// -----------------------------------------------------------------------------
// 2. 供給 — その月に働ける時間
// -----------------------------------------------------------------------------
/**
 * availability を「名前 → 日別の予定」の形へほどく。
 * normalizeInput の workersOut（[{ workerId, name, availability:[...] }]）でも、
 * 名前を鍵にした表でも、どちらでも受けます。
 */
function availabilityByName(availability) {
  const out = new Map();
  const put = (name, rows) => {
    const n = str(name).trim();
    if (!n) return;
    const list = arr(rows).filter(isObj);
    if (!out.has(n)) out.set(n, []);
    out.get(n).push(...list);
  };
  if (availability instanceof Map) {
    for (const [k, v] of availability) put(k, v);
    return out;
  }
  if (Array.isArray(availability)) {
    availability.forEach((w) => {
      if (!isObj(w)) return;
      put(w.name != null ? w.name : w.worker, w.availability != null ? w.availability : w.days);
    });
    return out;
  }
  if (isObj(availability)) {
    Object.keys(availability).forEach((k) => put(k, availability[k]));
  }
  return out;
}

/**
 * 月ごと・人ごとの「その月に働ける分数」。
 *
 * 🚨🚨 idleLog を1行も読みません。読んだ瞬間「忙しいほど足りない」に化けます。
 *   ここが出すのは **働ける時間**（勤務表・土日・休憩・休みを引いた分）で、
 *   **空いていた時間**（OJT の隙間探しに使う freeMinutesByWorkerOf）とは別物です。
 *
 * 土台は calendar.workMsBetween(月の始め, 月の終わり, 名前)。
 * そこへ availability の source:'registered' の日（休み／他の作業が**登録されている**日）を
 * 重ねます。
 *   🚨 重ね方は必ず「減らす方向だけ」。登録された分は **上限** として使います
 *     （Math.min）。足す方向へ動かせるようにすると、上限（人数×1日の分数×営業日数）を
 *     超える数が出ます。
 *   ⚠ calendar は normalizeInput 経由で同じ休みを既に知っているので、
 *     多くの場合この重ね合わせは何も変えません（0分の日を0分に置き直すだけ）。
 *     それでも書いてあるのは、カレンダーに渡っていない予定がある時に取りこぼさない為です。
 *
 * 🚨 registeredDays / provisionalDays / noDataDays を必ず一緒に返します。
 *   availability は見立ての期間の中しか持っていません。その先の月は
 *   「予定が未登録＝通常勤務の仮置き」になり、**先の月ほど楽な側へ外れます**。
 *   その件数を隠さず画面へ出す為の数です。
 *
 * @param {object} args
 * @param {object} args.calendar makeCalendar の戻り値
 * @param {Array|Map|object} [args.availability] 日別の予定
 * @param {Array} [args.roster] 名簿（文字列でも {name} でも可）。省略時は availability から採る
 * @param {Array} args.periods buildMonthPeriods の戻り値
 */
export function capacityByMonth({ calendar, availability = null, roster = null, periods = [] } = {}) {
  const ps = arr(periods);
  const avail = availabilityByName(availability);
  let names = namesOf(roster);
  if (names == null || names.length === 0) names = [...avail.keys()];
  // 同じ人を2回数えない（名簿に重複があっても供給は1人ぶん）。
  names = [...new Set(names.map((n) => str(n).trim()).filter(Boolean))];

  const canMeasure = calendar && typeof calendar.workMsBetween === 'function';

  const months = ps.map((p, i) => {
    const from = num(p.fromMs);
    const to = num(p.toMs);
    const byWorker = {};
    let totalMinutes = 0;
    let measuredWorkerCount = 0;
    let registeredDays = 0;
    let provisionalDays = 0;

    names.forEach((name) => {
      if (!canMeasure || from == null || to == null || !(to > from)) {
        // 🚨 測れない物を 0分 にしない。0分は「働ける時間が無い」と読めてしまう。
        byWorker[name] = null;
        return;
      }
      let minutes = null;
      try {
        let ms = Number(calendar.workMsBetween(from, to, name));
        if (!Number.isFinite(ms)) throw new Error('workMsBetween が数を返さない');
        for (const row of (avail.get(name) || [])) {
          const dayFrom = ymdToLocalMs(row.date);
          if (dayFrom == null) continue;
          const dayTo = nextDayMs(dayFrom);
          if (!(dayTo > from && dayFrom < to)) continue; // 期間の外
          const src = str(row.source);
          if (src === 'provisional') { provisionalDays += 1; continue; }
          if (src !== 'registered') continue;
          registeredDays += 1;
          const a = Math.max(dayFrom, from);
          const b = Math.min(dayTo, to);
          const dayMs = Number(calendar.workMsBetween(a, b, name));
          if (!Number.isFinite(dayMs) || dayMs <= 0) continue;
          const allowedMin = num(row.availableDirectMinutes);
          const allowedMs = allowedMin == null ? 0 : Math.max(0, allowedMin * 60000);
          // 🚨 減らす方向だけ。Math.min を外すと上限を超える（T-M2 が赤になる）。
          ms += Math.min(allowedMs, dayMs) - dayMs;
        }
        minutes = Math.max(0, ms) / 60000;
      } catch {
        // 期間の取り方が壊れている時。0分にすると「必ず足りない」に化けるので null（分かりません）。
        minutes = null;
      }
      byWorker[name] = minutes;
      if (minutes != null) { totalMinutes += minutes; measuredWorkerCount += 1; }
    });

    const workdays = Math.max(0, Math.trunc(num(p.workdays) || 0));
    // 日別の予定が1行も無い（人日）。＝この月は丸ごと通常勤務の仮置き。
    const noDataDays = Math.max(0, workdays * names.length - registeredDays - provisionalDays);

    return {
      index: p.index != null ? p.index : i,
      label: str(p.label),
      ym: str(p.ym),
      fromMs: from,
      toMs: to,
      workdays,
      byWorker,
      workerCount: names.length,
      measuredWorkerCount,
      /** 🚨 名簿の人を **1回だけ** 数えた合計。工程ごとの合計とは別物 */
      totalMinutes: measuredWorkerCount > 0 ? totalMinutes : null,
      /** 休み／他の作業が**登録されている**人日 */
      registeredDays,
      /** 日別の予定が未登録で、通常勤務として仮に置いた人日 */
      provisionalDays,
      /** 見立ての期間より先で、日別の予定がそもそも無い人日。🚨 先の月ほど楽な側へ外れる分 */
      noDataDays,
    };
  });

  return { names, months };
}

// -----------------------------------------------------------------------------
// 3. 月の全体行と、月×工程の行
// -----------------------------------------------------------------------------
/**
 * 数えられていない件数の文（🚨 3つ別々に。1つに丸めない）。
 * 「足ります」が独り歩きしないよう、どの判定の文にも必ず後ろへ付けます。
 */
function uncountedSentence(u) {
  return `数えられていない仕事は、見積りが分からない ${u.estimateUnknownJobCount}件 ・ `
    + `納期が分からない ${u.dueUnknownJobCount}件 ・ `
    + `担当できる人が分からない工程 ${u.ownerUnknownProcessCount}件 です。この数には入っていません。`;
}

/**
 * 月の全体行と、月×工程の行を作る。
 *
 * @param {object} args
 * @param {Array} args.periods buildMonthPeriods の戻り値
 * @param {object} args.demandByMonth demandByMonth の戻り値
 * @param {object} args.capacityByMonth capacityByMonth の戻り値
 * @param {object} [args.eligibility] buildEligibility の戻り値（誰がその工程を持てるか）
 * @param {number} [args.dayMinutes] 1人1日の直接作業の分数。既定420（policy.js から渡す）
 * @param {number} [args.tightRatio] この割合を超えたら「余裕がありません」。既定0.9
 * @param {number} [args.minRemainRatio]
 *   その月の営業日のうち、これ以上残っていないと「足りる／足りない」を言わない。既定0.5。
 *   🚨 2026-09-01 清水さん「実際も8月終わってるだろ今の人数で」。
 *     半分より短い窓に月まるごとの荷をぶつけた数は、月の話ではありません。
 *     清水さんが月で見たい理由は「一月前に分かれば準備の時間がある」なので、
 *     間に合わない窓で「足りません」と言っても、そもそも打つ手がありません。
 * @param {number} [args.pileUnjudgeableRatio]
 *   要る時間のうち、これ以上が「**入荷日でも説明が付かない**山」なら判定しない。既定0.5。
 *   🚨🚨 2026-09-04（決まり22）で意味が変わりました。前は「山ぜんぶ」で見ていたので、
 *     実データでは9月の山が100%になり **永久に「まだ判定していません」** でした。
 *     清水さん「いつ到着するかわからないからだよ、だから仮のやつ入力してって言ったと思ってるんだけど」
 *     ＝ 入荷日が分からない事で説明が付く山は、数えて判定します。
 * @param {number|null} [args.assumeArrivalDaysBeforeDue]
 *   仮に置く入荷日の日数（scenario.assumeArrivalDaysBeforeDue と同じ値）。
 *   🚨 判定の言葉に添える1文の言い回しに使うだけで、計算には1回も使いません。
 * @param {string} [args.holdingWord] 一時置きの呼び方。製品='到着待ち' / 最終='一時置き'
 */
export function buildMonthlyOutlook({
  periods = [],
  demandByMonth: dem = null,
  capacityByMonth: cap = null,
  eligibility = null,
  dayMinutes = 420,
  tightRatio = 0.9,
  minRemainRatio = 0.5,
  pileUnjudgeableRatio = 0.5,
  assumeArrivalDaysBeforeDue = null,
  holdingWord = '到着待ち',
} = {}) {
  const assumeDaysRaw = num(assumeArrivalDaysBeforeDue);
  const assumeDays = assumeDaysRaw != null && assumeDaysRaw > 0 ? Math.trunc(assumeDaysRaw) : null;
  const ps = arr(periods);
  const dm = num(dayMinutes);
  const dayMin = dm != null && dm > 0 ? dm : 420;
  const tr = num(tightRatio);
  const tight = tr != null && tr > 0 ? tr : 0.9;
  const mrr = num(minRemainRatio);
  const minRemain = mrr != null && mrr >= 0 && mrr <= 1 ? mrr : 0.5;
  const purr = num(pileUnjudgeableRatio);
  const pileLimit = purr != null && purr > 0 && purr <= 1 ? purr : 0.5;
  const holdName = str(holdingWord) || '一時置き';
  const demMonths = dem && Array.isArray(dem.months) ? dem.months : [];
  const capMonths = cap && Array.isArray(cap.months) ? cap.months : [];
  const outside = dem && isObj(dem.outside) ? dem.outside : null;
  const dueUnknownJobCount = outside ? outside.noDueJobCount : 0;

  const months = ps.map((p, i) => {
    const d = demMonths[i] || null;
    const c = capMonths[i] || null;

    // ── 月×工程 ─────────────────────────────────────────────────────────
    // 🚨 供給も不足の判定も、既存の buildProcessSupply / findShortfalls をそのまま使う。
    //   ここで判定をもう1本書くと、日・週の画面と月の画面が違う工程を指します。
    const byProcess = d && d.byProcess instanceof Map ? d.byProcess : new Map();
    const supply = buildProcessSupply({
      processKeys: byProcess.keys(),
      eligibility,
      // その工程を持てる人が、この月に働ける分。
      workMinutesOf: (name) => {
        if (!c || !isObj(c.byWorker)) return null;
        const v = c.byWorker[str(name).trim()];
        return v === undefined ? null : v;
      },
    });
    const shortfalls = findShortfalls(byProcess, supply);
    const shortByKey = new Map(shortfalls.map((s) => [s.processKey, s]));

    const processes = [];
    for (const [key, e] of byProcess) {
      const s = supply.get(key) || { workers: [], workerCount: 0, minutes: null, unknown: true };
      const sf = shortByKey.get(key) || null;
      const ownerUnknown = s.unknown === true;
      const shortMinutes = (!ownerUnknown && sf && sf.kind === SHORTFALL.CAPACITY)
        ? num(sf.shortMinutes) : (ownerUnknown ? null : 0);
      processes.push({
        processKey: key,
        title: str(e.title),
        requiredMinutes: e.minutes,
        unknownJobCount: e.unknownJobCount,
        jobCount: e.jobCount,
        lotCount: e.lotCount,
        earliestDueMs: e.earliestDueMs,
        /** 🚨 持てる人の**名前**。教育する相手が決まらないと、人数だけ出ても始められない */
        workers: arr(s.workers).map(str),
        workerCount: s.workerCount,
        /** 🚨 「持てる人が分かりません」。**0人と混ぜない**（やれない、という意味ではない） */
        ownerUnknown,
        workableMinutes: s.minutes,
        shortMinutes,
        shortPersonDays: shortMinutes == null ? null : round1(shortMinutes / dayMin),
        kind: sf ? sf.kind : null,
        why: sf ? sf.why : '',
        /** 画面にそのまま出せる1行 */
        note: ownerUnknown
          ? 'この工程を誰が担当できるか分かりません（実績も正式な設定もありません）。「やれないという意味ではありません。」'
          : (s.workerCount > 0
            ? `担当できるのは ${s.workers.join('・')} の ${s.workerCount}人 です。`
            : '担当できる人の記録がありません。'),
      });
    }
    // 重い順。🚨 並べ方を端末の言語データに委ねない（processKey の素の昇順で決める）。
    processes.sort((a, b) => ((num(b.shortMinutes) || 0) - (num(a.shortMinutes) || 0))
      || ((b.requiredMinutes || 0) - (a.requiredMinutes || 0))
      || (a.processKey < b.processKey ? -1 : a.processKey > b.processKey ? 1 : 0));

    // 🚨 「持てる人が分かりません」は不足の数に**混ぜない**。灰色の別枠。
    const unknownOwnerProcesses = processes.filter((x) => x.ownerUnknown);
    const shortProcesses = processes.filter((x) => !x.ownerUnknown && num(x.shortMinutes) > 0);

    // ── 月の全体行 ───────────────────────────────────────────────────────
    const requiredMinutes = d ? d.totalMinutes : null;          // ① 要る時間
    const workableMinutes = c ? c.totalMinutes : null;          // ② 働ける時間（人は1回だけ）
    const shortMinutes = (requiredMinutes != null && workableMinutes != null)
      ? Math.max(0, requiredMinutes - workableMinutes) : null;
    const sparePersonDays = (requiredMinutes != null && workableMinutes != null)
      ? round1(Math.max(0, workableMinutes - requiredMinutes) / dayMin) : null;
    const shortPersonDays = shortMinutes == null ? null : round1(shortMinutes / dayMin); // ③
    // ③′ 1か月フルで張り付く人に直すと何人分か。
    // 🚨 分母は **その月の営業日数**。見ている長さ（3か月ぶん／12か月ぶん）で動かさない。
    const denomWorkdays = Math.max(0, Math.trunc(num(p.workdays) || 0));
    const peopleForWholeMonth = (shortPersonDays == null || !(denomWorkdays > 0))
      ? null : round1(shortPersonDays / denomWorkdays);

    // ④ 数えられていない件数。🚨 3つ**別々に**。混ぜない。
    const uncounted = {
      estimateUnknownJobCount: d ? d.unknownJobCount : 0,
      dueUnknownJobCount,
      ownerUnknownProcessCount: unknownOwnerProcesses.length,
    };
    const countedJobCount = d ? Math.max(0, d.jobCount - d.unknownJobCount) : 0;

    // ── 判定 ────────────────────────────────────────────────────────────
    //
    // 🚨 「まだ判定していません」を出すのは、**この月の要る時間が数えられない時だけ**です。
    //   ⚠ 手順書の例文は「納期が入っていない仕事が 120件あるので、要る時間が数えられません」
    //     でした。ただしその通りに
    //     「納期の無い仕事がどこかに1件でもあれば、その月は判定しない」と書くと、
    //     本番（納期の入っていないロットが常にある）では **12か月とも一生
    //     「まだ判定していません」** になり、月の行が何も言わなくなります。
    //     しかも「納期が無い仕事」は月の外の話なので、
    //     仕事がある月では判定して、空の月だけ判定しない、という線の引き方には根拠がありません。
    //   → 判定は **数えられた仕事** で下し、数えられていない件数は
    //     uncountedSentence で3種類の文すべてに必ず付ける、という形にしました。
    //   🚨 ここは私が決めた所です。清水さんに確かめてください（報告に書いています）。
    const hasJobs = d ? d.jobCount > 0 : false;

    // ── 別の行に出す2つ（🚨 どちらも不足人日の計算に1分も入れていません） ────
    // ① 納期がもう過ぎている分。demandByMonth が月の箱から外して持ってきた物。
    const od = d && isObj(d.overdue) ? d.overdue : { jobCount: 0, lotCount: 0, minutes: 0 };
    const overdueMinutes = num(od.minutes) || 0;
    const overdue = {
      jobCount: Math.max(0, Math.trunc(num(od.jobCount) || 0)),
      lotCount: Math.max(0, Math.trunc(num(od.lotCount) || 0)),
      minutes: overdueMinutes,
      /** 🚨 人日に直した数も出しますが、**上の shortPersonDays とは別の欄**です */
      personDays: round1(overdueMinutes / dayMin),
      sentence: od.jobCount > 0
        ? `納期がもう過ぎている仕事が ${od.lotCount}ロット・${round1(overdueMinutes)}分 あります。`
          + 'これは「この先どれだけ人が要るか」とは別の話なので、'
          + '上の要る時間にも不足人日にも1分も入れていません。'
        : '',
    };
    // ② 一時置きに置かれたまま作業の記録が1件も無い分（要る時間の中に入っている）。
    const pud = d && isObj(d.pileUnexplained) ? d.pileUnexplained : { jobCount: 0, lotCount: 0, minutes: 0 };
    const pkd = d && isObj(d.pileArrivalUnknown) ? d.pileArrivalUnknown : { jobCount: 0, lotCount: 0, minutes: 0, whyCounts: {} };
    const pd = d && isObj(d.pile) ? d.pile : { jobCount: 0, lotCount: 0, minutes: 0 };
    const pileMinutes = num(pd.minutes) || 0;
    // 🚨 割合は**必ず**出す。出せない時は null（0 にしない）。
    const pileRatio = (requiredMinutes != null && requiredMinutes > 0)
      ? pileMinutes / requiredMinutes : null;
    const pilePercent = pileRatio == null ? null : Math.round(pileRatio * 1000) / 10;
    const pile = {
      jobCount: Math.max(0, Math.trunc(num(pd.jobCount) || 0)),
      lotCount: Math.max(0, Math.trunc(num(pd.lotCount) || 0)),
      minutes: pileMinutes,
      /** 🚨 要る時間に占める割合。**必ず画面へ出す**（null は「分かりません」） */
      ratio: pileRatio,
      percent: pilePercent,
      sentence: pd.jobCount > 0
        ? `要る時間 ${round1(requiredMinutes)}分 のうち ${round1(pileMinutes)}分`
          + `（${pilePercent == null ? '割合は分かりません' : `${pilePercent}%`}・${pd.lotCount}ロット）は、`
          + `${holdName}に置かれたまま作業の記録が1件も無いロットです。`
          // 🚨 決まり22（2026-09-04 清水さん「いつ到着するかわからないからだよ」）。
          //   入荷日で説明が付いた分は、2026-08-20 からの未決が**閉じています**。
          //   全部に説明が付いた月で「分かりません」と言い続けると、清水さんの答えを
          //   無かった事にします。**説明が付かない分が残っている時だけ**「分かりません」と言います。
          + (pkd.lotCount > 0 && pud.jobCount === 0
            ? '入荷日が分からないので、まだ着手できていない仕事です'
              + '（2026-09-04 清水さん「いつ到着するかわからないからだよ」）。'
            : 'これから検査する物か、検査は済んでいて記録だけ付いていない物か、この記録からは分かりません。')
        : '',
    };
    // ②′ 🚨🚨 決まり22（2026-09-04 夜・清水さん「いつ到着するかわからないからだよ、
    //    だから仮のやつ入力してって言ったと思ってるんだけど」）。
    //    山を「判定を出さない理由」にするのをやめ、**説明が付かない分だけ**で止めます。
    //    ⚠ 入荷日で説明が付くかの判定は untouchedPile.js が付けた印をそのまま読んでいます。
    const pileUnexplainedMinutes = num(pud.minutes) || 0;
    const pileUnexplainedRatio = (requiredMinutes != null && requiredMinutes > 0)
      ? pileUnexplainedMinutes / requiredMinutes : null;
    const pileUnexplained = {
      jobCount: Math.max(0, Math.trunc(num(pud.jobCount) || 0)),
      lotCount: Math.max(0, Math.trunc(num(pud.lotCount) || 0)),
      minutes: pileUnexplainedMinutes,
      ratio: pileUnexplainedRatio,
      percent: pileUnexplainedRatio == null ? null : Math.round(pileUnexplainedRatio * 1000) / 10,
      sentence: pud.jobCount > 0
        ? `${holdName}に置かれたまま作業の記録が1件も無いロットのうち ${pud.lotCount}ロット`
          + `（${round1(pileUnexplainedMinutes)}分）は、入荷日でも説明が付いていません。`
          + 'これから検査する物か、検査は済んでいて記録だけ付いていない物か、この記録からは分かりません。'
        : '',
    };
    const pileArrivalUnknown = {
      jobCount: Math.max(0, Math.trunc(num(pkd.jobCount) || 0)),
      lotCount: Math.max(0, Math.trunc(num(pkd.lotCount) || 0)),
      minutes: num(pkd.minutes) || 0,
      whyCounts: isObj(pkd.whyCounts) ? { ...pkd.whyCounts } : {},
    };
    /**
     * 🚨 決まり22-3。**判定の言葉に必ず添える1文**（畳んでよい・消してはいけない）。
     *   決まり18 と同じ2種の札をそのまま使います（ここで数え直しません）。
     */
    const arrivalSentence = pileArrivalSentence({
      monthLotCount: Math.max(0, Math.trunc(num(d && d.lotCount) || 0)),
      arrivalUnknownLotCount: pileArrivalUnknown.lotCount,
      whyCounts: pileArrivalUnknown.whyCounts,
      assumeDaysBeforeDue: assumeDays,
    });

    // ── その月の窓の長さ（🚨 もう終わった月・残りが数日しかない月を見分ける） ──
    const monthWorkdays = Math.max(0, Math.trunc(num(p.monthWorkdays) || 0));
    // 暦の月まるごとの営業日数が分からない時は、窓の長さを判定材料にしない（＝丸ごととみなす）。
    const remainRatio = monthWorkdays > 0 ? denomWorkdays / monthWorkdays : 1;
    const isPartialMonth = monthWorkdays > 0 && remainRatio < minRemain;

    let verdict;
    let unjudgeableWhy = '';
    let partialWhy = '';
    if (workableMinutes == null) {
      verdict = MONTH_VERDICT.UNJUDGEABLE;
      unjudgeableWhy = '働ける時間が測れませんでした（勤務表か名簿が渡っていません）。';
    } else if (requiredMinutes == null || (hasJobs && countedJobCount === 0)) {
      // この月に仕事はあるのに、1件も見積りが数えられない。
      verdict = MONTH_VERDICT.UNJUDGEABLE;
      unjudgeableWhy = `この月に納期が来る仕事 ${d ? d.jobCount : 0}件 は、`
        + `見積りが分からないので要る時間が数えられません。`;
    } else if (denomWorkdays === 0) {
      // 🚨 もう終わった月。ここに「足りません」を出していたのが 2026-09-01 の苦情です。
      verdict = MONTH_VERDICT.PARTIAL;
      partialWhy = `${p.label}に働ける営業日は、もう1日も残っていません`
        + `（${p.label}は営業${monthWorkdays}日・残り0日）。`
        + '足りる／足りないの判定は出しません。';
    } else if (isPartialMonth) {
      // 🚨 残りが半分より短い月。月まるごとの荷を短い窓にぶつけた数は月の話ではありません。
      verdict = MONTH_VERDICT.PARTIAL;
      partialWhy = `${p.label}は、いま見えているのが残り営業${denomWorkdays}日だけです`
        + `（${p.label}は営業${monthWorkdays}日）。`
        + '月まるごとの仕事を残りの日数にぶつけた数は、その月の話になりません。'
        + '足りる／足りないの判定は出しません。';
    } else if (pileUnexplainedRatio != null && pileUnexplainedRatio >= pileLimit && pud.jobCount > 0) {
      // 🚨🚨 決まり22。判定を止めるのは「**入荷日でも説明が付かない**山」の割合だけです。
      //   ⚠ ここを `pileRatio`（山ぜんぶ）に戻すと、実データでは9月の山が100%なので
      //     **永久に「まだ判定していません」**に戻ります（2026-09-04 実測）。
      //     清水さんが頼んだ「仮の入荷日」が、この1行に打ち消されていました。
      verdict = MONTH_VERDICT.UNJUDGEABLE;
      unjudgeableWhy = pileUnexplained.sentence;
    } else if (requiredMinutes > workableMinutes) {
      verdict = MONTH_VERDICT.SHORT;
    } else if (requiredMinutes > workableMinutes * tight) {
      verdict = MONTH_VERDICT.TIGHT;
    } else {
      verdict = MONTH_VERDICT.OK;
    }

    // 🚨🚨 判定を出さない月に「◯人日」を残さない（2026-08-22 の「混ぜるな」の本体）。
    //   担当は「別の欄に分けた」と書きましたが、判定の言葉（足りない）と
    //   大きい数字（2.46人日）は混ざったままでした。ここで数ごと外します。
    //   ⚠ 消しているのは **判定から出てくる数** だけです。
    //     要る時間・働ける時間・営業日数・超過の分・山の分は下でそのまま返しています。
    const judged = verdict === MONTH_VERDICT.OK
      || verdict === MONTH_VERDICT.TIGHT
      || verdict === MONTH_VERDICT.SHORT;
    const outShortMinutes = judged ? shortMinutes : null;
    const outShortPersonDays = judged ? shortPersonDays : null;
    const outPeopleForWholeMonth = judged ? peopleForWholeMonth : null;
    const outSparePersonDays = judged ? sparePersonDays : null;

    // ── 画面に出す1行（3種類だけ。混ぜない） ──────────────────────────────
    let headline;
    if (verdict === MONTH_VERDICT.UNJUDGEABLE) {
      headline = `${p.label}：まだ判定していません`;
    } else if (verdict === MONTH_VERDICT.PARTIAL) {
      // 🚨 「足りません」とも「回ります」とも書かない。数も出さない。
      headline = `${p.label}：この月は残り営業${denomWorkdays}日だけを見ています。`
        + '足りる／足りないの判定は出しません';
    } else if (verdict === MONTH_VERDICT.SHORT) {
      // 🚨 ③′の分母（その月の営業日数）を**同じ行に**書く。
      headline = `${p.label}：いまの人数だと ${shortPersonDays}人日 足りません`
        + `（1か月フルで ${peopleForWholeMonth}人分・${p.label}の営業${denomWorkdays}日で割った値）`;
    } else if (verdict === MONTH_VERDICT.TIGHT) {
      headline = `${p.label}：いまの人数で回りますが、余裕がありません（余力 ${sparePersonDays}人日）`;
    } else if (!hasJobs) {
      // 🚨 仕事が1件も無い月を「回ります（余力◯人日）」と書かない。
      //   何も載っていない月と、荷を積んだ上で余裕がある月は別の話です。
      headline = `${p.label}：この月に納期が来る仕事は 0件です`;
    } else {
      headline = `${p.label}：いまの人数で回ります（余力 ${sparePersonDays}人日）`;
    }
    // いちばん重い工程を、名前つきで添える（教育の相手が決まる）。
    // 🚨 ここに工程ごとの人日を並べて書かない。
    //   全体の行（17人日）と工程の行（8.4人日）は **違う計算** から出ています:
    //     全体 = その月の仕事の合計 ÷ 名簿の人を1回だけ数えた時間
    //     工程 = その工程の仕事 ÷ その工程を持てる人の時間を**丸ごとこの工程へ回せる**前提
    //   並べて書くと「17なのか8.4なのか」という、判断を誤らせる矛盾になります
    //   （2026-08-30「判定文の矛盾は別格で最優先」）。
    //   → 1行目は工程の**名前と担当できる人**だけにして、数の関係は下の注記で言い切ります。
    // 🚨 判定を出さない月には、工程の不足も添えない（そこだけ「足りない」が残ると混ざる）。
    const heaviest = judged ? (shortProcesses[0] || null) : null;
    const subline = heaviest
      ? `足りないのは ${shortProcesses.length}工程。いちばん重いのは〈${heaviest.title || heaviest.processKey}〉です。${heaviest.note}`
      : '';
    const measureNote = heaviest
      ? `〈${heaviest.title || heaviest.processKey}〉の ${heaviest.shortPersonDays}人日 は、`
        + `その工程を持てる人の時間を丸ごとこの工程へ回せるとした時の数です。`
        + `上の全体の ${shortPersonDays}人日 とは足し引きできません（別の計算です）。`
      : '';

    const provisionalNote = (c && c.noDataDays + c.provisionalDays > 0)
      ? `日別の予定が未登録の ${c.provisionalDays + c.noDataDays}人日 は、通常勤務として仮に置いています。`
      : '';

    return {
      index: p.index != null ? p.index : i,
      label: str(p.label),
      ym: str(p.ym),
      fromMs: num(p.fromMs),
      toMs: num(p.toMs),
      workdays: denomWorkdays,
      calendarDays: Math.max(0, Math.trunc(num(p.calendarDays) || 0)),
      monthWorkdays: Math.max(0, Math.trunc(num(p.monthWorkdays) || 0)),
      monthCalendarDays: Math.max(0, Math.trunc(num(p.monthCalendarDays) || 0)),
      rangeLabel: str(p.rangeLabel),
      monthRangeLabel: str(p.monthRangeLabel),

      requiredMinutes,          // ①
      workableMinutes,          // ②
      /**
       * ③ 🚨 判定を出した月（回ります／余裕がありません／足りません）にだけ数が入ります。
       *   「まだ判定していません」「この月は残り◯日だけ」の月は **null**（分かりません）です。
       *   0 にしていないのは、0 が「ちょうど足りている」と読めるからです。
       */
      shortMinutes: outShortMinutes,
      shortPersonDays: outShortPersonDays,
      peopleForWholeMonth: outPeopleForWholeMonth,      // ③′
      /** 🚨 ③′ を何で割ったか。同じ行に必ず出す */
      peopleForWholeMonthDenominatorWorkdays: denomWorkdays,
      sparePersonDays: outSparePersonDays,
      dayMinutes: dayMin,

      /**
       * 🚨 別の行に出す2つ。**上の不足人日には1分も入っていません。**
       *   overdue … 納期がもう過ぎている分（この先の見込みとは別の話）
       *   pile    … 一時置きに置かれたまま作業の記録が1件も無い分（割合つき）
       */
      overdue,
      pile,
      /**
       * 🚨🚨 決まり22。山の内訳（足すと pile になります）。
       *   pileArrivalUnknown … 入荷日で説明が付く分。**判定を止める理由に使いません**
       *   pileUnexplained    … 説明が付かない分。**判定を止めるのはこちらだけ**
       */
      pileArrivalUnknown,
      pileUnexplained,
      /**
       * 🚨 決まり22-3。判定の言葉に**必ず添える**1文（畳んでよい・消してはいけない）。
       *   決まり18 と同じ2種の札（2日前に置いた／2日前が過ぎて基準時刻に置いた）が入ります。
       */
      arrivalSentence,
      /** その月の営業日のうち、いま見えているのが何日か（残り／月まるごと） */
      remainWorkdays: denomWorkdays,
      remainRatio,
      /** 🚨 途中から見ている月か。ここが true の月に「足りません」は出しません */
      isPartialMonth: verdict === MONTH_VERDICT.PARTIAL,
      partialWhy,

      uncounted,                // ④（3つ別々）
      /** この月に納期が来る仕事の登録件数（demandByMonth の jobCount そのまま。数えられた／数えられていないを問わない） */
      registeredJobCount: d ? d.jobCount : 0,
      registeredDays: c ? c.registeredDays : 0,
      provisionalDays: c ? c.provisionalDays : 0,
      noDataDays: c ? c.noDataDays : 0,

      verdict,
      headline,
      subline,
      /** 🚨 全体の人日と工程の人日が違う計算から出ている事を言い切る1行。空なら出す物が無い */
      measureNote,
      /** 🚨 3種類とも「数えられていない件数」を必ず後ろに付ける */
      uncountedSentence: uncountedSentence(uncounted),
      unjudgeableWhy,
      provisionalNote,

      processes,
      shortProcesses,
      /** 🚨 灰色の別枠。不足の数には入っていない */
      unknownOwnerProcesses,
      notes: [
        // 🚨 工程の行を足しても全体にはならない。だから合計欄を作っていない。
        '工程の行を足しても全体の行にはなりません（同じ人が何工程も持てるため）',
        ...(measureNote ? [measureNote] : []),
        // 🚨 この2つは判定の言葉と同じ強さで必ず出す。畳んでよいが消してはいけません。
        //   ⚠ 判定しない理由がそのまま山の文だった時は、同じ1文を2回書きません
        //     （同じ数を2度出すと、読んだ人が別々の話だと思って足します）。
        ...(overdue.sentence ? [overdue.sentence] : []),
        ...(pile.sentence && pile.sentence !== unjudgeableWhy ? [pile.sentence] : []),
        // 🚨 決まり22-3。入荷日が未定の件数は判定の言葉に**必ず**付ける（畳んでよい・消さない）。
        ...(arrivalSentence ? [arrivalSentence] : []),
        ...(pileUnexplained.sentence && pileUnexplained.sentence !== unjudgeableWhy
          ? [pileUnexplained.sentence] : []),
      ],
    };
  });

  return { dayMinutes: dayMin, months, outside };
}

// -----------------------------------------------------------------------------
// 4. 週の内訳（段4。3つの規則を混ぜない）
// -----------------------------------------------------------------------------
/**
 * 月の中を週へ割る。
 *
 * | 数える物        | どの週へ                                          |
 * |-----------------|---------------------------------------------------|
 * | 時間(分)        | 実際に働いた分だけその週へ。またいだ仕事は両方の週に分かれる |
 * | 片付く件数      | **終わる週にただ1つ**                              |
 * | 納期が来る件数  | **納期線の週にただ1つ**                            |
 *
 * 🚨 時間は必ず calendar.workMsBetween(max(start,週の始め), min(end,週の終わり), 名前)。
 *   `endMs - startMs` を使ってはいけません。simulate の addWorkMs が夜・土日・休憩を
 *   またいで先へ送るので、生の引き算には夜と土日が丸ごと入ります。
 *
 * ⚠ 相方（2人でやる工程）の時間は workedMinutes に足さず partnerMinutes へ別に出します。
 *   需要（job.durationMs）が1人ぶんの見積りなので、片方だけ2人ぶんにすると
 *   要る時間と働いた時間で物差しが変わります。**落とさず別の列に出す**。
 *
 * @param {object} args
 * @param {Array} args.periods buildMonthPeriods の戻り値
 * @param {Array} args.assignments simulate の assignments（{lotId, worker, partner, startMs, endMs}）
 * @param {object} args.calendar makeCalendar の戻り値
 * @param {Array} [args.lotResults] simulate の lotResults（finishMs / dueLineMs を使う）
 * @param {Map<string,number|null>|object} [args.dueLineByLot] lotResults が無い時の納期線
 */
export function buildWeeklyBreakdown({
  periods = [], assignments = [], calendar = null, lotResults = null, dueLineByLot = null,
} = {}) {
  const ps = arr(periods);
  const asgs = arr(assignments).filter(isObj);
  const canMeasure = calendar && typeof calendar.workMsBetween === 'function';

  /** 🚨 ここが唯一の時間の切り方。endMs - startMs は使わない。 */
  const minutesIn = (a, b, worker) => {
    if (!canMeasure) return 0;
    const lo = num(a);
    const hi = num(b);
    if (lo == null || hi == null || !(hi > lo)) return 0;
    let ms = 0;
    try { ms = Number(calendar.workMsBetween(lo, hi, str(worker) || undefined)); } catch { return 0; }
    return Number.isFinite(ms) ? ms / 60000 : 0;
  };

  // ── ロットが片付く時刻（🚨 終わる週にただ1つ数える為の1点） ────────────────
  const finishByLot = new Map();
  arr(lotResults).forEach((r) => {
    if (!isObj(r)) return;
    const f = num(r.finishMs);
    if (f != null) finishByLot.set(str(r.lotId), f);
  });
  // lotResults が無い（か finishMs が入っていない）ロットは、
  // そのロットの **最後の仕事が終わる時刻** を片付いた時刻として使う。
  // ⚠ 別の入れ物で数えてから移す。lotId と同じ表に仮の鍵を混ぜると、
  //   lotId がその形をしていた時に本物と取り違える。
  const lastEndByLot = new Map();
  asgs.forEach((a) => {
    const id = str(a.lotId);
    if (!id || finishByLot.has(id)) return;
    const e = num(a.endMs);
    if (e == null) return;
    const cur = lastEndByLot.get(id);
    if (cur == null || e > cur) lastEndByLot.set(id, e);
  });
  for (const [id, e] of lastEndByLot) finishByLot.set(id, e);

  // ── 納期線（🚨 納期線の週にただ1つ） ────────────────────────────────────
  const dueByLot = new Map();
  arr(lotResults).forEach((r) => {
    if (!isObj(r)) return;
    const d = num(r.dueLineMs);
    if (d != null) dueByLot.set(str(r.lotId), d);
  });
  if (dueLineByLot instanceof Map) {
    for (const [k, v] of dueLineByLot) { const d = num(v); if (d != null && !dueByLot.has(str(k))) dueByLot.set(str(k), d); }
  } else if (isObj(dueLineByLot)) {
    Object.keys(dueLineByLot).forEach((k) => { const d = num(dueLineByLot[k]); if (d != null && !dueByLot.has(k)) dueByLot.set(k, d); });
  }

  const firstFrom = ps.length ? num(ps[0].fromMs) : null;
  const lastTo = ps.length ? num(ps[ps.length - 1].toMs) : null;
  let beforeFirstMonthMinutes = 0;
  let afterLastMonthMinutes = 0;

  const months = ps.map((p, mi) => {
    const mFrom = num(p.fromMs);
    const mTo = num(p.toMs);
    const weeks = arr(p.weeks).map((w) => ({
      index: w.index,
      label: str(w.label),
      /** 🚨 見出しには必ず営業日数。無いと「1週目だけ山が低い＝楽」と読み違える */
      heading: str(w.heading),
      fromMs: num(w.fromMs),
      toMs: num(w.toMs),
      workdays: Math.max(0, Math.trunc(num(w.workdays) || 0)),
      workedMinutes: 0,
      partnerMinutes: 0,
      byWorker: {},
      finishedLotCount: 0,
      finishedLotIds: [],
      dueLotCount: 0,
      dueLotIds: [],
      rules: WEEK_RULE,
    }));

    let monthWorkedMinutes = 0;
    let monthPartnerMinutes = 0;
    let crossWeekJobCount = 0;
    let crossMonthJobCount = 0;

    asgs.forEach((a) => {
      const s = num(a.startMs);
      const e = num(a.endMs);
      if (s == null || e == null || !(e > s)) return;
      // この月に1ミリ秒も掛からない仕事は、この月の話ではない。
      if (mFrom == null || mTo == null || !(e > mFrom && s < mTo)) return;
      // 🚨 月をまたぐ仕事は 0 に丸めず、件数として別の列に出す。
      if (s < mFrom || e > mTo) crossMonthJobCount += 1;

      const worker = str(a.worker);
      const partner = str(a.partner);
      let touchedWeeks = 0;
      weeks.forEach((w) => {
        if (!(e > w.fromMs && s < w.toMs)) return;
        const lo = Math.max(s, w.fromMs);
        const hi = Math.min(e, w.toMs);
        const m = minutesIn(lo, hi, worker);
        if (m > 0) {
          w.workedMinutes += m;
          w.byWorker[worker] = (w.byWorker[worker] || 0) + m;
          monthWorkedMinutes += m;
          touchedWeeks += 1;
        }
        if (partner) {
          const pm = minutesIn(lo, hi, partner);
          w.partnerMinutes += pm;
          monthPartnerMinutes += pm;
        }
      });
      if (touchedWeeks > 1) crossWeekJobCount += 1;
    });

    // 🚨 片付く件数は「終わる週にただ1つ」。分けると1件が1.5件に見える。
    for (const [lotId, finishMs] of finishByLot) {
      if (mFrom == null || mTo == null) break;
      if (!(finishMs >= mFrom && finishMs < mTo)) continue;
      const w = weeks.find((x) => finishMs >= x.fromMs && finishMs < x.toMs);
      if (!w) continue;
      w.finishedLotCount += 1;
      w.finishedLotIds.push(lotId);
    }
    // 🚨 納期が来る件数は「納期線の週にただ1つ」。上の2つとは別の話。
    for (const [lotId, dueMs] of dueByLot) {
      if (mFrom == null || mTo == null) break;
      if (!(dueMs >= mFrom && dueMs < mTo)) continue;
      const w = weeks.find((x) => dueMs >= x.fromMs && dueMs < x.toMs);
      if (!w) continue;
      w.dueLotCount += 1;
      w.dueLotIds.push(lotId);
    }

    return {
      index: p.index != null ? p.index : mi,
      label: str(p.label),
      ym: str(p.ym),
      fromMs: mFrom,
      toMs: mTo,
      /** 週と同じ切り方で出した月の合計。🚨 週の合計と必ず一致する（週は月を隙間なく敷き詰めている） */
      workedMinutes: monthWorkedMinutes,
      partnerMinutes: monthPartnerMinutes,
      /** 🚨 週をまたぐ仕事の件数。時間は両方の週に分かれている */
      crossWeekJobCount,
      /** 🚨 月をまたぐ仕事の件数。0に丸めず、別の列で出す */
      crossMonthJobCount,
      weeks,
    };
  });

  // 月の帯の外へはみ出した分。🚨 落とさない。
  asgs.forEach((a) => {
    const s = num(a.startMs);
    const e = num(a.endMs);
    if (s == null || e == null || !(e > s)) return;
    const worker = str(a.worker);
    if (firstFrom != null && s < firstFrom) beforeFirstMonthMinutes += minutesIn(s, Math.min(e, firstFrom), worker);
    if (lastTo != null && e > lastTo) afterLastMonthMinutes += minutesIn(Math.max(s, lastTo), e, worker);
  });

  return {
    months,
    outside: {
      beforeFirstMonthMinutes,
      afterLastMonthMinutes,
      /** 見ている月より先で片付くロット */
      finishedAfterLastMonthCount: lastTo == null ? 0
        : [...finishByLot.values()].filter((f) => f >= lastTo).length,
      finishedBeforeFirstMonthCount: firstFrom == null ? 0
        : [...finishByLot.values()].filter((f) => f < firstFrom).length,
    },
  };
}

/**
 * ロットごとの要る時間(分)。全体進捗の週次仕事量が読む(2026-09-05 清水さん「シミュレーションと計算違うくない？」)。
 * 🚨 buildJobs の durationMs を足すだけ。時間が分からない仕事(durationMs null)は足さず unknownJobCount に数える(0で埋めない)。
 * 🚨 ここ以外で「ロットの要る時間」を作らない(全体進捗は前に テンプレ目標×台数を自前で足していて、同じ問いに2つの数字が出ていた)。
 * @param {Array} jobs buildJobs の戻り
 * @returns {Object<string,{minutes:number,jobCount:number,unknownJobCount:number}>}
 */
export function demandByLot(jobs) {
  const out = {};
  arr(jobs).forEach((j) => {
    if (!isObj(j)) return;
    const id = str(j.lotId);
    if (!id) return;
    const row = out[id] || (out[id] = { minutes: 0, jobCount: 0, unknownJobCount: 0 });
    row.jobCount += 1;
    const d = num(j.durationMs);
    if (d != null && d > 0) row.minutes += d / 60000; else row.unknownJobCount += 1;
  });
  return out;
}
