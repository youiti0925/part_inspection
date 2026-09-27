// =============================================================================
//  operationsSimulation/sharedWorkerPlan.js
//    — 両方の工場で働ける人を「どの日は製品・どの日は最終」で置く(2026-09-05)。純関数だけ
// -----------------------------------------------------------------------------
//  清水さん(2026-09-05 原文):
//    「シミュレーションで両方の工場で働ける人でボタン押したけど、よくわからなかった。
//      むしろこの説明で相手がわかると思った？」
//    「これだったら **どの日に製品に行って この日は最終検査とか** そういう意味で言ったのに」
//    「両方の負荷をもしこうだったらってシミュレーションして、**負荷を平均でするか、
//      どっちかの優先率を設定して**、そっちに移動することが多くするかとかそんな感じ」
//
//  答える1行:
//    「この期間、村さんは **どの営業日に製品・どの営業日に最終** に居るべきか。
//      そうすると両方の遅れは何件になるか」
//
//  いま在る sharedWorker.js は「期間まるごとここ／期間まるごと向こう」の2通りしか出せない。
//  ここは その間を埋める:
//    ① buildDailyLoadDoc   … 自分の工場の「日ごとの負荷」を1枚の書類にする(相手が読む物)
//    ② allocateSharedWorker … 両方の書類を見て、日ごとにどちらへ置くかを決める
//    ③ planToAbsences      … 決めた配置を「向こうに居る日 = ここでは休み」へ翻訳(既存の口)
//
//  🚨 このファイルは Firestore も React も時計も持たない。「今」は呼ぶ側が ms を渡す
//     (acceptance.test.mjs S23/S24 が operationsSimulation 配下の .js を機械で走査している)。
//  🚨 数字を作らない。分からない日は place:null / whyKey:'noData'。0 で埋めない
//     (Number(null)===0 の罠。2026-08-22「分かりません を 0 で埋めるな」)。
//  🚨 同じ数字を2つの計算から出さない。遅れの **切り方** は atRisk.js の atRiskBreakdown
//     ただ1本(measureRun も同じ物を使っている)。ここは その切り方の結果を
//     「その日の終わりまでに納期線が来ている物だけ」で絞って数えるだけ。数え直さない。
//     ⚠ 2026-09-05 の検証で、ここが独自に「納期線を越えた物ぜんぶ」を数えていて
//       **すでに納期を過ぎた物** が混ざり、隣に並ぶ measureRun.count(すでに超過を除く)と
//       同じ工場で 4件 対 1件 になっていた(2026-08-22「3つの数を混ぜるな」の再発)。
//     ⚠ 2026-09-06 の再検証で **場所を変えた再発**: 日ごとの atRiskCount は
//       「納期線がその日より後のロットを落とす」ので、最終日を取っても measureRun.count と
//       一致しない(納期 10/1・見通し 9/9 の unresolved 1件で 日ごと 0件 対 本家 1件)。
//       画面が横に並べる件数は **書類まるごとの合計 `totals`** ただ1つを使う。
//  🚨 数え方の窓は「日ごとの内訳(days[].atRiskCount)」と「まるごとの合計(totals)」の2つ。
//     日の札の中だけが内訳を使う。左右に並べる件数は必ず totals。
//  🚨 不足(gap)は **その人ひとり** を外した時の物。合計 sharedWorkerMinutes を使うと
//     両方で働ける人が2人居る時に「誰を選んでも同じ答え」になる(2026-09-05 実測)。
//     名前ごとの分は days[].sharedMinutesByName。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)にする。片方だけ変えない。
// =============================================================================

import { atRiskBreakdown } from './atRisk.js';
import { makeCalendar } from './calendar.js';
import { measureRun } from './rescueLadder.js';
import { ymdLocal } from './sharedWorker.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());
// 🚨 null/'' を 0 にしない。素の Number() で「渡されたか」を判定しない。
const finite = (v) => ((v == null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** 24時間(ミリ秒)。相手の書類が これより古ければ「読めていません」と言う。 */
export const STALE_MS = 24 * 60 * 60 * 1000;

export const PLACE = Object.freeze({ HERE: 'here', THERE: 'there' });
export const PLAN_MODE = Object.freeze({ BALANCE: 'balance', PRIORITY: 'priority' });
/**
 * 配置先として知っている工場。これ以外の字(打ち間違い・将来の3つ目の工場)は
 * 「分かりません」として **休みにしない**(2026-09-14 ChatGPT の指摘③: 'typo' も休みにしていた)。
 */
export const APPS = Object.freeze(['product', 'final']);

/**
 * 👥 2026-09-16 「向こうの工場に居る日」の休みの表の記号。
 *   清水さん「休みじゃなくて、他のグループ応援してるが正しいよね、ちゃんとどのグループ応援してるか記載して」
 *   'off'(休み)と書くと 計算は『担当の候補がこの期間ずっと休みです』としか言えなかった。
 *   🚨 記号を読むのは calendar.js(absenceReasonOf)・normalizeInput.js(known)・simulate.js(allAwayReason)。
 *     ここを変える時は その3か所と、見張り support-reason-reaches-screen.test.mjs を一緒に直す。
 */
export const SUPPORT_STATUS = Object.freeze({ product: 'support:product', final: 'support:final' });
/** 向こうの工場 → 休みの表の記号。知らない工場なら 'off'(今までと同じ = 推測で埋めない)。 */
export const supportStatusOf = (app) => SUPPORT_STATUS[str(app)] || 'off';
/** 記号 → 向こうの工場('product'|'final')。応援の記号でなければ ''。 */
export const supportAppOf = (status) => (str(status) === SUPPORT_STATUS.product ? 'product' : (str(status) === SUPPORT_STATUS.final ? 'final' : ''));
const isKnownApp = (v) => APPS.includes(str(v));
/** 曜日の札(0=日..6=土)。 */
export const WEEKDAY_JA = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
/**
 * 'YYYY-MM-DD' → 曜日(0..6)。読めなければ null。
 * ⚠ ローカル時刻で作る(UTC へ寄せると1日ずれる)。🚨 時計は読まない(引数の日付を組むだけ)。
 */
export const weekdayOfYmd = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(ymd));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 🚨 13月40日 のような字は Date が黙って繰り上げる。組んだ日付が同じ物か確かめる
  if (Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getDay();
};

/**
 * 入力指紋の元になる安定ハッシュ。
 * 🚨 normalizeInput.js 344行の stableHash を **写した物**(あちらは const で export されていない)。
 *   あちらを触らずに同じ形を使う為に写している。片方を直したら もう片方も直す。
 * 🚨 WebCrypto の digest は非同期・node:crypto は Worker で動かないので sha1 は使えない。
 */
const stableHash = (text) => {
  const s = String(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i + 1) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

/** 'YYYY-MM-DD' の 00:00(現場の壁時計)。読めない字は null。 */
const startOfYmd = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(ymd));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return d.getTime();
};

/** その日の 00:00 の翌日の 00:00。 */
const nextDayMs = (ms) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 名簿({name} でも 文字列でも)から名前だけ。 */
const namesOf = (list) => arr(list)
  .map((w) => (w && typeof w === 'object' ? str(w.name) : str(w)))
  .filter(Boolean);

const round1 = (n) => Math.round(Number(n) * 10) / 10;
/**
 * 分 → 人が読む長さの文字。
 * 🚨 0より大きいのに「0時間」へ丸まると、画面に『0時間 ＞ 0時間』という
 *   意味の通らない札が出る(2026-09-05 実測: 不足2分 対 0分)。
 *   0.1時間(6分)未満は **分** で書く。0 だけが「0時間」。
 */
const hoursText = (minutes) => {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return '分かりません';
  if (m <= 0) return '0時間';
  if (m < 6) return `${Math.max(1, Math.round(m))}分`;
  return `${round1(m / 60).toLocaleString('ja-JP')}時間`;
};
/** 分をそのまま「◯分」で書く(丸めで同じ文字になった時の内訳用)。 */
const minutesText = (minutes) => {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return '分かりません';
  return `${Math.round(m).toLocaleString('ja-JP')}分`;
};
/** 「A の不足 ◯ ＞ B の不足 ◯」。丸めで同じ文字になる時は ＞ を使わない。 */
const gapCompareText = (aLabel, aMin, bLabel, bMin) => {
  const ta = hoursText(aMin);
  const tb = hoursText(bMin);
  if (ta === tb) {
    return `不足の差はごくわずかです（${aLabel} ${minutesText(aMin)}／${bLabel} ${minutesText(bMin)}）`;
  }
  return `${aLabel}の不足 ${ta} ＞ ${bLabel}の不足 ${tb}`;
};
/** 優先率をかけた後の値を「◯ × ◯% = ◯」で書く(＞ の左右は **実際に比べた数**)。 */
const weightedText = (label, rawMin, w) => `${label}の不足 ${hoursText(rawMin)} × ${Math.round(Number(w) * 100)}% = ${hoursText(Number(rawMin) * Number(w))}`;

/**
 * 足りていない材料の鍵 → 日本語1文。
 * 🚨 画面に 'there:none' や 'workers[].availability' のような機械の言葉を出さない
 *   (2026-09-05 の検証で実際に清水さんが読む場所へ出ていた)。
 */
export function describeMissing(keys = [], { hereLabel = 'ここ', thereLabel = '向こう' } = {}) {
  return arr(keys).map((raw) => {
    const key = str(raw);
    const side = key.startsWith('there:') ? thereLabel : (key.startsWith('here:') ? hereLabel : null);
    const tail = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (side) {
      if (tail === 'missing') return `${side}の日ごとの負荷がまだ届いていません`;
      if (tail === 'empty') return `${side}の書類に日が1日も入っていません`;
      if (tail === 'stale') return `${side}の書類が24時間より古いです`;
      // 🚨 書類自身が「材料が揃っていない」と言っている。中身の 0 を根拠に言い切らない。
      if (tail === 'broken') return `${side}の書類の材料が揃っていません（工場の暦か割付が読めていません）`;
      if (tail === 'noTime') return `${side}の書類に書いた時刻が入っていません（いつの物か分かりません）`;
      return `${side}の書類が読めていません`;
    }
    if (key === 'name') return '動かす人が決まっていません';
    if (key === 'nowMs') return '書いた時刻が渡されていません';
    if (key === 'normalized') return '勤務の元(名簿と暦)が読めていません';
    if (key === 'base') return '割付の結果が読めていません';
    if (key === 'calendar') return '工場の暦が読めていません';
    if (key === 'workers[].availability') return '名簿の勤務予定が読めていません';
    return '材料が1つ読めていません';
  });
}

// =============================================================================
//  ① 日ごとの負荷を1枚の書類にする
// =============================================================================
/**
 * 自分の工場の「日ごとの負荷」を1枚の書類にする(相手の工場が読む物)。
 *
 * @param {object} o
 * @param {object} o.normalized  normalizeInput の戻り(workers[].availability / calendarSpec / now / horizonEnd)
 * @param {object} o.base        simulate の結果(assignments / lotResults)
 * @param {Array}  [o.roster]    名簿(休止中を除いた物)。渡すと この名前の人だけ数える
 * @param {Array}  [o.sharedNames] 両方の工場で働ける人の名前
 * @param {string} o.app         'product' | 'final'
 * @param {number} o.nowMs       書いた時刻。🚨 中で時計を読まない(呼ぶ側が渡す)
 * @returns {{app,writtenAt,baseNow,horizonEnd,fingerprint,sharedNames,days,ok,missing,missingText}}
 *
 * ⚠ 読む口と書く口の名前が違う: normalizeInput の戻りは `now` だが、
 *   この書類の欄名は設計書のとおり `baseNow` にしてある。
 */
export function buildDailyLoadDoc({
  normalized = null, base = null, roster = null, sharedNames = [], app = '', nowMs = null,
} = {}) {
  const missing = [];
  const written = finite(nowMs);
  if (written == null) missing.push('nowMs');
  if (!isObj(normalized)) missing.push('normalized');
  if (!isObj(base)) missing.push('base');

  const shared = new Set(namesOf(sharedNames));
  const workers = isObj(normalized) ? arr(normalized.workers).filter(isObj) : [];
  // 名簿を渡された時は その名前の人だけ数える(休止中を外すのは呼ぶ側の仕事)。
  const allow = roster == null ? null : new Set(namesOf(roster));

  // 日の並びは normalizeInput が既に作っている(期間ぶんの 'YYYY-MM-DD')。
  // 🚨 ここで暦から数え直さない(同じ数字を2つの計算から出さない)。
  const ymds = [];
  const seen = new Set();
  workers.forEach((w) => {
    arr(w.availability).filter(isObj).forEach((a) => {
      const d = str(a.date);
      if (d && !seen.has(d)) { seen.add(d); ymds.push(d); }
    });
  });
  ymds.sort();
  if (ymds.length === 0) missing.push('workers[].availability');

  let calendar = null;
  try {
    calendar = makeCalendar(isObj(normalized) ? (normalized.calendarSpec || normalized.calendar || {}) : {});
  } catch { calendar = null; }
  const canMeasure = !!(calendar && typeof calendar.workMsBetween === 'function');
  if (!canMeasure) missing.push('calendar');

  /**
   * 🚨 ここが唯一の時間の切り方。endMs - startMs は使わない
   *   (生の差だと 夜と土日が丸ごと入る)。monthly.js 967行の minutesIn と同じ形。
   * 🚨 暦が読めない／時刻が読めない時は **null**(「分かりません」)。0 を返してはいけない。
   *   2026-09-05 の検証で実測: ここが 0 を返していた為に requiredMinutes が全日 0 になり、
   *   その **作った 0** を根拠に「どちらも足りています」と言い切る札が出ていた(鉄則5)。
   */
  const minutesIn = (a, b, worker) => {
    if (!canMeasure) return null;
    const lo = finite(a);
    const hi = finite(b);
    if (lo == null || hi == null) return null;
    if (!(hi > lo)) return 0;   // 重なりが無い = 本当に 0分(「分かりません」ではない)
    let ms = null;
    try { ms = Number(calendar.workMsBetween(lo, hi, str(worker) || undefined)); } catch { return null; }
    return Number.isFinite(ms) ? ms / 60000 : null;
  };

  const assignments = isObj(base) ? arr(base.assignments).filter(isObj) : [];
  const lotResults = isObj(base) ? arr(base.lotResults).filter(isObj) : [];

  // 🚨 遅れの切り方は atRiskBreakdown **ただ1本**(measureRun と同じ物)。ここで数え直さない。
  //   ここがやるのは「その日の終わりまでに納期線が来ている物だけに絞る」ことだけ。
  //   ⚠ すでに納期を過ぎた物は atRiskBreakdown が危険の和集合から外している。
  //     混ぜると隣に並ぶ measureRun.count と件数が食い違う(2026-09-05 実測 4件 対 1件)。
  const risk = isObj(base) ? atRiskBreakdown(base) : null;
  const dueByLot = new Map();
  lotResults.forEach((r) => {
    if (r.lotId == null) return;
    dueByLot.set(String(r.lotId), finite(r.dueLineMs));
  });
  /** その日の終わりまでに納期線が来ている物だけを数える。納期線が無い物は数えない。 */
  const countDueBy = (set, dayEnd) => {
    if (!risk || !set || dayEnd == null) return null;
    let n = 0;
    set.forEach((id) => {
      const due = dueByLot.get(String(id));
      if (due == null) return;
      if (due > dayEnd) return;
      n += 1;
    });
    return n;
  };

  const days = ymds.map((ymd) => {
    const dayStart = startOfYmd(ymd);
    const dayEnd = dayStart == null ? null : nextDayMs(dayStart);
    const workday = (dayStart != null && calendar && typeof calendar.isWorkday === 'function')
      ? !!calendar.isWorkday(dayStart)
      : null;

    // 🚨 1分でも「分かりません」が混ざったら その日は **null のまま** 返す。
    //   Math.round(null) は 0 になるので、丸める前に分ける(2026-08-22「0 で埋めるな」)。
    let unreadable = !canMeasure || dayStart == null;
    let requiredMinutes = 0;
    let sharedWorkerMinutes = 0;
    // 名前ごとの分。両方の工場で働ける人は **1人ずつ** 別の欄で持つ。
    // 🚨 合計(sharedWorkerMinutes)だけだと、その人が2人以上居る時に
    //   「誰を選んでも同じ答え」になる(2026-09-05 実測: 村 と 佐藤 で配置も理由文も同一だった)。
    // 🚨 割付が無い人は **0分**(事実)。欄そのものが無い = 分かりません。この2つを分ける為に
    //   両方で働ける人 全員ぶんの欄を先に 0 で作っておく。
    const byName = {};
    shared.forEach((n) => { byName[n] = 0; });
    if (!unreadable) {
      for (const a of assignments) {
        const s = finite(a.startMs);
        const e = finite(a.endMs);
        if (s == null || e == null) continue;
        const lo = Math.max(s, dayStart);
        const hi = Math.min(e, dayEnd);
        if (!(hi > lo)) continue;
        // 本人と相方は別々に数える(2人で押さえている工程は2人分の負荷)。
        for (const who of [a.worker, a.partner]) {
          const name = str(who);
          if (!name) continue;
          const m = minutesIn(lo, hi, name);
          if (m == null) { unreadable = true; break; }
          if (!(m > 0)) continue;
          requiredMinutes += m;
          if (shared.has(name)) {
            sharedWorkerMinutes += m;
            byName[name] += m;
          }
        }
        if (unreadable) break;
      }
    }
    const sharedMinutesByName = unreadable ? null : Object.fromEntries(
      Object.keys(byName).sort().map((n) => [n, Math.round(byName[n])]),
    );

    // 🚨 人数×420 を新しく掛け算しない。normalizeInput が既に日ごとに作っている値を足すだけ
    //   (休みは 0分・残業の刻みも入っている)。名簿が1人も当たらない日は null のまま。
    let availableMinutes = null;
    workers.forEach((w) => {
      const name = str(w.name);
      if (allow && !allow.has(name)) return;
      const row = arr(w.availability).filter(isObj).find((a) => str(a.date) === ymd);
      if (!row) return;
      const m = finite(row.availableDirectMinutes);
      if (m == null) return;
      availableMinutes = (availableMinutes == null ? 0 : availableMinutes) + m;
    });

    // 🚨 3つの数を混ぜない(2026-08-22)。1つの lateCount には戻さない。
    //   atRiskCount = この先で遅れる ∪ 納期があるのに手が付かない(= measureRun.count と同じ切り方)。
    //   alreadyPastDueCount は 今日の事実で、どんな手を打っても減らない。**別の欄・別の色** で出す。
    const atRiskCount = countDueBy(risk ? risk.lotIds : null, dayEnd);
    const forecastLateCount = countDueBy(risk ? risk.forecastLateLotIds : null, dayEnd);
    const unresolvedDueCount = countDueBy(risk ? risk.unresolvedDueLotIds : null, dayEnd);
    const alreadyPastDueCount = countDueBy(risk ? risk.alreadyPastDueLotIds : null, dayEnd);

    return {
      ymd,
      workday,
      requiredMinutes: unreadable ? null : Math.round(requiredMinutes),
      availableMinutes: availableMinutes == null ? null : Math.round(availableMinutes),
      atRiskCount,
      forecastLateCount,
      unresolvedDueCount,
      alreadyPastDueCount,
      sharedWorkerMinutes: unreadable ? null : Math.round(sharedWorkerMinutes),
      sharedMinutesByName,
    };
  });

  // 👤 人ごとの勤務の窓(区画C・2026-09-05「村さんは9:30〜16:00の時短」)。
  //   要る分は calendar.workMsBetween(…, 本人の名前) なので **本人の窓で切られる** が、
  //   使える分は normalizeInput の availability[].availableDirectMinutes = 工場ぜんぶで
  //   同じ1日の分数(ci-setup 4f6acbd 実測: どの人も directMinutesPerDayEffective)。
  //   → 時短の人は「使える分」が多く出て、不足(gap)が実際より小さく出る。
  // 🚨 ここで使える分を作り直して直さない(同じ数字を2つの計算から出さない・鉄則6)。
  //   直す場所は normalizeInput の持ち場。ここは **在る事を札で言う** だけ。
  const profiles = (isObj(normalized) && isObj(normalized.calendarSpec))
    ? normalized.calendarSpec.workerProfiles : null;
  const counted = new Set(workers.map((w) => str(w.name)).filter((n) => n && (!allow || allow.has(n))));
  // 2026-09-06: normalizeInput が本人の窓で使える分を切るようになった(availability[].basis === 'window')。
  //   切られている人には札を出さない。切られていない人(古い書類・登録だけ在って窓が読めない人)だけ言う。
  const notClipped = (name) => {
    const w = workers.find((x) => str(x.name) === str(name));
    const regular = w ? arr(w.availability).filter((a) => isObj(a) && a.reason === 'regular') : [];
    return regular.length === 0 || regular.some((a) => a.basis !== 'window');
  };
  const profiledCounted = isObj(profiles)
    ? Object.keys(profiles).filter((n) => counted.has(str(n)) && notClipped(n)).sort() : [];
  const warnings = profiledCounted.length
    ? [`使える分は工場ぜんぶで同じ1日の分数です。個人の勤務時間（${profiledCounted.join('・')}）はまだ差し引かれていないので、不足は実際より小さく出ます`]
    : [];

  // 🚨 書類 **まるごとの合計**。日ごとの内訳(atRiskCount)とは別物。
  //   日ごとは countDueBy が「納期線がその日より後のロットを落とす」ので、
  //   最終日を取っても measureRun.count とは一致しない
  //   (2026-09-05 実測: 納期 10/1・見通し 9/9 の unresolved 1件で 日ごと 0件 対 本家 1件)。
  //   画面が「製品 N件／最終 M件」と横に並べる数は **必ずこちら** を使う(鉄則6)。
  //   risk が読めない時は null。0 で埋めない。
  const totals = risk ? {
    atRiskCount: risk.lotIds.size,
    forecastLateCount: risk.forecastLateLotIds.size,
    unresolvedDueCount: risk.unresolvedDueLotIds.size,
    alreadyPastDueCount: risk.alreadyPastDueLotIds.size,
  } : null;

  const sharedList = [...shared].sort();
  const fingerprint = stableHash(JSON.stringify({
    app: str(app),
    sharedNames: sharedList,
    // 🚨 合計を入れ忘れると、合計だけ変わった書類が「同じ指紋」で書き直されない。
    totals,
    days: days.map((d) => [
      d.ymd, d.workday, d.requiredMinutes, d.availableMinutes,
      d.atRiskCount, d.forecastLateCount, d.unresolvedDueCount, d.alreadyPastDueCount,
      d.sharedWorkerMinutes, d.sharedMinutesByName,
    ]),
  }));

  return {
    app: str(app),
    writtenAt: written,
    baseNow: isObj(normalized) ? finite(normalized.now) : null,
    horizonEnd: isObj(normalized) ? finite(normalized.horizonEnd) : null,
    fingerprint,
    sharedNames: sharedList,
    totals,
    days,
    ok: missing.length === 0 && days.length > 0,
    missing,
    missingText: describeMissing(missing),
    // 👤 「読めてはいるが、そのまま信じてはいけない」事。ok は下げない(画面は数を出し続ける)。
    warnings,
  };
}

// =============================================================================
//  ② 日ごとにどちらへ置くかを決める
// =============================================================================
const dayMapOf = (doc) => {
  const map = new Map();
  if (!isObj(doc)) return map;
  arr(doc.days).filter(isObj).forEach((d) => {
    const k = str(d.ymd);
    if (k) map.set(k, d);
  });
  return map;
};

/**
 * その日「**その人ひとり** に割り付いている分」(分)。分からなければ null。
 * 🚨 合計(sharedWorkerMinutes)を使ってはいけない。あれは両方で働ける人 **全員** の合計なので、
 *   2人居ると「誰を選んでも同じ配置・同じ理由文」になる(2026-09-05 実測)。
 */
const mineOf = (doc, day, who) => {
  if (!isObj(day) || !who) return null;
  const byName = isObj(day.sharedMinutesByName) ? day.sharedMinutesByName : null;
  if (byName) {
    // 欄が在れば その値(割付が無い人は 0分 = 事実)。欄が無い名前は **分かりません**。
    return Object.prototype.hasOwnProperty.call(byName, who) ? finite(byName[who]) : null;
  }
  // 古い版の書類には名前ごとの欄がない。両方で働ける人が **その人1人だけ** の書類なら
  // 合計 = その人の分 と言い切れる。2人以上なら分かりません(推測で割らない)。
  const list = isObj(doc) ? namesOf(doc.sharedNames) : [];
  if (list.length === 1 && list[0] === who) return finite(day.sharedWorkerMinutes);
  return null;
};

/**
 * その日「その人を外した時の不足」(分)。
 * gap = max(0, 要る分 − (使える分 − その人に割り付いている分))
 * 材料が欠けていれば null(0 にしない)。
 */
const gapOf = (doc, day, who) => {
  if (!isObj(day)) return null;
  const req = finite(day.requiredMinutes);
  const avail = finite(day.availableMinutes);
  const mine = mineOf(doc, day, who);
  if (req == null || avail == null || mine == null) return null;
  return Math.max(0, req - (avail - mine));
};

/**
 * 書類の困り事(在る／日が在る／材料が揃っている／書いた時刻が在る／古すぎない)。
 * 困っていなければ null。
 * ⚠ 書類そのものが無い時の鍵は 'missing'。'none' だと『無し:無し』と読めて意味が反転する。
 * 🚨 'broken': 書類自身が ok:false と言っているのに、その中身で村さんの配置を決めない
 *   (2026-09-05 実測: 暦が壊れた書類で requiredMinutes が全日 0 になり、
 *    その 0 を根拠に「どちらも足りています」と3日とも言い切っていた)。
 * 🚨 'noTime': 書いた時刻が無い書類は 24時間の見張りを素通りする。
 *   いつの物か分からない負荷で配置を決めない。
 */
const docTrouble = (doc, refMs) => {
  if (!isObj(doc)) return 'missing';
  if (!arr(doc.days).length) return 'empty';
  if (doc.ok === false) return 'broken';
  const w = finite(doc.writtenAt);
  if (w == null) return 'noTime';
  const ref = finite(refMs);
  if (ref != null && ref - w > STALE_MS) return 'stale';
  return null;
};

/**
 * 片側の書類が使えない理由(日の札の説明に出す日本語1文)。
 * 🚨 機械の鍵('there:broken' など)は画面に出さない。
 */
const sideTroubleText = (label, trouble, writtenText) => {
  const head = `${label}の負荷が読めていません`;
  if (trouble === 'missing') return `${head}（書類が届いていません）`;
  if (trouble === 'empty') return `${head}（書類に日が1日も入っていません）`;
  if (trouble === 'broken') return `${head}（書類の材料が揃っていません。工場の暦か割付が読めていません）`;
  if (trouble === 'noTime') return `${head}（書類に書いた時刻が入っていません。いつの物か分かりません）`;
  if (writtenText) return `${head}（書類は ${writtenText} の物）`;
  return `${head}（書類が届いていません）`;
};

/**
 * 日ごとに どちらの工場へ置くかを決める。
 *
 * @param {object} o
 * @param {string} o.name         動かす人(例 '村')
 * @param {string[]} [o.days]     決める日('YYYY-MM-DD')。省くと here の書類の日を使う
 * @param {object} o.here         自分の工場の書類(buildDailyLoadDoc の戻り)
 * @param {object} o.there        相手の工場の書類
 * @param {'balance'|'priority'} [o.mode='balance']
 * @param {number} [o.priority=0.5] mode='priority' の時 0..1(1 = 常にここ)
 * @param {number} [o.minBlockDays=1] 同じ側に続けて置く最低の日数(往復を減らす)
 * @param {number} [o.nowMs]      古さを見る基準。🚨 中で時計を読まない。省くと here.writtenAt
 * @param {string} [o.hereLabel='ここ']
 * @param {string} [o.thereLabel='向こう']
 * @returns {{days:Array,summary:object,inputsOk:boolean,missing:string[],missingText:string[],mode:string,priority:number}}
 */
export function allocateSharedWorker({
  name = '', days = null, here = null, there = null,
  mode = PLAN_MODE.BALANCE, priority = 0.5, minBlockDays = 1,
  nowMs = null, hereLabel = 'ここ', thereLabel = '向こう',
  fixed = null,
  /** 📅 2026-09-17 その日が 何で決まっているか { ymd: 'day'|'weekly' }(fixedByFromWeekly)。無ければ全部 曜日。 */
  fixedBy = null,
} = {}) {
  // 📅 2026-09-14 曜日の配置(毎週)で決まっている日 { 'YYYY-MM-DD': 'here'|'there' }。
  //   清水さん「両方作業できる作業者を曜日毎で指定したのに、シュミレーションでは全く適用していなかった」
  //   🚨 決まっている日は負荷で決めない(往復を減らす寄せも、この日は動かさない)。
  const fixedMap = new Map(Object.entries(isObj(fixed) ? fixed : {})
    .map(([k, v]) => [str(k), v])
    .filter(([k, v]) => k && (v === PLACE.HERE || v === PLACE.THERE)));
  const fixedByMap = new Map(Object.entries(isObj(fixedBy) ? fixedBy : {}).map(([k, v]) => [str(k), str(v)]));
  const who = str(name);
  const useMode = mode === PLAN_MODE.PRIORITY ? PLAN_MODE.PRIORITY : PLAN_MODE.BALANCE;
  const pRaw = finite(priority);
  const p = (pRaw == null ? 0.5 : Math.min(1, Math.max(0, pRaw)));
  const block = Math.max(1, Math.trunc(Number(minBlockDays)) || 1);

  const hereMap = dayMapOf(here);
  const thereMap = dayMapOf(there);
  const refRaw = finite(nowMs);
  const ref = refRaw != null ? refRaw : (isObj(here) ? finite(here.writtenAt) : null);

  const missing = [];
  if (!who) missing.push('name');
  const hereBad = docTrouble(here, ref);
  const thereBad = docTrouble(there, ref);
  if (hereBad) missing.push(`here:${hereBad}`);
  if (thereBad) missing.push(`there:${thereBad}`);

  const ymds = (Array.isArray(days) && days.length)
    ? days.map(str).filter(Boolean)
    : [...hereMap.keys()].sort();

  const writtenTextOf = (doc) => {
    const ms = isObj(doc) ? finite(doc.writtenAt) : null;
    return ms == null ? null : ymdLocal(ms);
  };
  const thereWrittenText = writtenTextOf(there);
  const hereWrittenText = writtenTextOf(here);

  /** その日 その人に割り付いている分。読めなければ null(0 で埋めない)。 */
  const minutesOfName = (d, nm) => {
    if (!isObj(d) || !nm) return null;
    const by = d.sharedMinutesByName;
    if (!isObj(by)) return null;
    const v = finite(by[nm]);
    return v == null ? null : v;
  };

  let prev = null;
  const out = ymds.map((ymd) => {
    const dh = hereMap.get(ymd) || null;
    const dt = thereMap.get(ymd) || null;
    // 🚨 不足は **その人ひとり** を外した時の物。who を渡さないと誰を選んでも同じ答えになる。
    const gh = hereBad ? null : gapOf(here, dh, who);
    const gt = thereBad ? null : gapOf(there, dt, who);

    // 📅 曜日の配置で決まっている日。負荷が読めなくても この日は決まっている(規則が決めている)。
    const fx = who ? (fixedMap.get(ymd) || null) : null;
    if (fx) {
      prev = fx;
      const wd = weekdayOfYmd(ymd);
      // 📅 2026-09-17 「この日だけ」で決めた日は 理由もそう言う(曜日と混ぜない)。
      const byDay = fixedByMap.get(ymd) === 'day';
      return {
        ymd, place: fx, whyKey: byDay ? 'day' : 'weekly',
        why: byDay
          ? `この日だけ ${fx === PLACE.HERE ? hereLabel : thereLabel} と決めています（営業日の札で決めた日。もう一度押すと変わります）`
          : `曜日の配置で ${fx === PLACE.HERE ? hereLabel : thereLabel} と決めています（毎週${wd == null ? '' : WEEKDAY_JA[wd]}曜）`,
        hereGapMin: gh, thereGapMin: gt,
        hereSharedMin: minutesOfName(dh, who), thereSharedMin: minutesOfName(dt, who),
      };
    }

    if (!who || gh == null || gt == null) {
      // 🚨 材料が欠けている日は決めない。0 で埋めない。
      let why;
      if (!who) {
        why = '動かす人が決まっていません';
      } else if (gt == null && gh != null) {
        why = sideTroubleText(thereLabel, thereBad, thereWrittenText);
      } else if (gh == null && gt != null) {
        why = sideTroubleText(hereLabel, hereBad, hereWrittenText);
      } else {
        why = '両方の負荷が読めていません';
      }
      return { ymd, place: null, whyKey: 'noData', why };
    }

    const needHere = useMode === PLAN_MODE.PRIORITY ? gh * p : gh;
    const needThere = useMode === PLAN_MODE.PRIORITY ? gt * (1 - p) : gt;

    const isPriority = useMode === PLAN_MODE.PRIORITY;
    let place;
    let whyKey;
    let why;
    if (gh === 0 && gt === 0) {
      place = prev || PLACE.HERE;
      whyKey = 'either';
      why = prev
        ? '前日と同じ（どちらも足りています）'
        : `どちらも足りています（この期間の初日なので ${hereLabel} のまま）`;
    } else if (needHere > needThere) {
      place = PLACE.HERE;
      whyKey = 'gapHere';
      // 🚨 ＞ の左右は **実際に比べた数**。優先率をかけた時は かけた後の値を書く
      //   (生の不足だけを書くと『3.3時間 ＞ 5時間』という矛盾した札が出た。2026-09-05 実測)。
      why = isPriority
        ? `${weightedText(hereLabel, gh, p)} ＞ ${weightedText(thereLabel, gt, 1 - p)}`
        : gapCompareText(hereLabel, gh, thereLabel, gt);
    } else if (needThere > needHere) {
      place = PLACE.THERE;
      whyKey = 'gapThere';
      why = isPriority
        ? `${weightedText(thereLabel, gt, 1 - p)} ＞ ${weightedText(hereLabel, gh, p)}`
        : gapCompareText(thereLabel, gt, hereLabel, gh);
    } else if (gh !== gt) {
      // 🚨 優先率が端(0% / 100%)だと、かけた後は 0 対 0 で並ぶのに 生の不足は違う。
      //   ここを『同点』と言い切ると『不足が同じ 8.3時間』という嘘が出る(2026-09-05 実測)。
      //   両方の **生の値** を並べて、並んだ理由が優先率である事を書く。
      place = prev || PLACE.HERE;
      whyKey = 'priorityOverride';
      const placed = place === PLACE.HERE ? hereLabel : thereLabel;
      why = `${hereLabel}の不足 ${hoursText(gh)}／${thereLabel}の不足 ${hoursText(gt)}。`
        + `優先率をかけると どちらも ${hoursText(needHere)} で並ぶので ${placed} のまま`;
    } else {
      place = prev || PLACE.HERE;
      whyKey = 'tie';
      const both = `${hereLabel} ${hoursText(gh)}／${thereLabel} ${hoursText(gt)}`;
      why = prev
        ? `前日と同じ（不足は同じ ${both}）`
        : `不足が同じ（${both}）なので ${hereLabel} のまま`;
    }
    if (isPriority && whyKey !== 'either') {
      why += `（${hereLabel}を優先 ${Math.round(p * 100)}%）`;
    }
    prev = place;
    // 🚚 2026-09-12 清水さん「どっちかのアプリで決定したら…両方シュミレーションがこう変わるっていうのを
    //   画面で見せないとダメだと思うんだけど、だって何が遅れたり、良くなったりっていうのがわからないからね」
    //   🚨 相手の書類にはロットが1件も入っていないので、**相手の遅れが何件になるか** はこちらでは出せない。
    //     出せるのは「その日 相手に どれだけ足りないか」と「その人の分が何分か」。
    //     数を作らない為に、ここで既に計算した物をそのまま日へ載せる(画面で計算し直させない)。
    return {
      ymd, place, whyKey, why,
      hereGapMin: gh, thereGapMin: gt,
      hereSharedMin: minutesOfName(dh, who), thereSharedMin: minutesOfName(dt, who),
    };
  });

  // 往復を減らす: 決めた側が block 日より短く続いている所は、前の側へ寄せる。
  if (block > 1) {
    let i = 0;
    while (i < out.length) {
      if (out[i].place == null) { i += 1; continue; }
      let j = i;
      while (j + 1 < out.length && out[j + 1].place === out[i].place) j += 1;
      const runLen = j - i + 1;
      const before = i > 0 ? out[i - 1].place : null;
      if (runLen < block && before && before !== out[i].place) {
        for (let k = i; k <= j; k += 1) {
          if (fixedMap.has(out[k].ymd)) continue;   // 📅 曜日で決まっている日は寄せない
          out[k] = {
            ...out[k],
            place: before,
            whyKey: 'block',
            why: `${out[k].why}／ただし ${block}日より短い往復は作りません`,
          };
        }
      }
      i = j + 1;
    }
  }

  const summary = {
    hereDays: out.filter((d) => d.place === PLACE.HERE).length,
    thereDays: out.filter((d) => d.place === PLACE.THERE).length,
    unknownDays: out.filter((d) => d.place == null).length,
  };
  return {
    days: out,
    summary,
    inputsOk: missing.length === 0,
    missing,
    // 🚨 画面はこちらを描く(生の鍵 'there:missing' を清水さんに読ませない)。
    missingText: describeMissing(missing, { hereLabel, thereLabel }),
    mode: useMode,
    priority: p,
  };
}

/**
 * 🚚 決めた配置で「その側」がどうなるかを数える(2026-09-12 清水さんの依頼)。
 *
 * 🚨 出せるのは **分(時間)** まで。相手の遅れが何件になるかは出せない。
 *   相手の書類(daily_load)には日ごとの合計しか無く、ロットが1件も入っていないから。
 *   件数まで出すには 相手のアプリで1回引き直す必要がある。ここで作り話をしない。
 *
 * @param {object} o
 * @param {Array}  o.days   allocateSharedWorker の戻りの days
 * @param {'here'|'there'} o.side  どちらの側を数えるか
 * @returns {{
 *   days:number, withPerson:number, withoutPerson:number,
 *   gapMin:number|null, coveredMin:number|null, leftMin:number|null, unreadableDays:number
 * }}
 *   days          … その側の負荷が読めた営業日の数
 *   withPerson    … その人が その側に居る日
 *   withoutPerson … その人が 反対側へ行く日
 *   gapMin        … その人が居ない時に その側に足りない分の合計(居る日は数えない)
 *   coveredMin    … その人が居る日に その側で働く分の合計
 *   leftMin       … 居る日のぶんを差し引いても なお足りない分(= gapMin)。分からなければ null
 */
export function planSideEffect({ days = [], side = PLACE.THERE } = {}) {
  const want = side === PLACE.HERE ? PLACE.HERE : PLACE.THERE;
  const gapKey = want === PLACE.HERE ? 'hereGapMin' : 'thereGapMin';
  const minKey = want === PLACE.HERE ? 'hereSharedMin' : 'thereSharedMin';
  let withPerson = 0; let withoutPerson = 0; let unreadableDays = 0;
  let gapMin = 0; let coveredMin = 0; let gapOk = true; let coverOk = true; let counted = 0;
  arr(days).filter(isObj).forEach((d) => {
    const g = finite(d[gapKey]);
    const m = finite(d[minKey]);
    if (g == null) { unreadableDays += 1; return; }
    counted += 1;
    if (d.place === want) {
      withPerson += 1;
      if (m == null) coverOk = false; else coveredMin += m;
    } else if (d.place != null) {
      withoutPerson += 1;
      gapMin += g;
    } else {
      unreadableDays += 1;
    }
  });
  if (!counted) gapOk = false;
  return {
    days: counted,
    withPerson,
    withoutPerson,
    gapMin: gapOk ? gapMin : null,
    coveredMin: coverOk ? coveredMin : null,
    leftMin: gapOk ? gapMin : null,
    unreadableDays,
  };
}

// =============================================================================
//  ②' 決めた配置(placement)。書類に載せて両方の工場が読む
// =============================================================================
//  🚨 2026-09-12 清水さん「この配置で引き直すしても、盤とかのシュミレーション変化してないよ、
//     村さんが最終検査に結構いくのに、製品検査に名前あるのおかしいんだけど」
//  それまで「引き直す」は 帯の中の1行の数字を出すだけで、盤は1ミリも変わらなかった。
//  決めた配置を **書類(daily_load)に載せて** 両方の工場が読み、盤の休みとして効かせる。
//  ⚠ 新しい置き場は作らない(Firestore の許可を増やさない)。自分の書類の中の1欄 placement。
//  ⚠ place は 'here'/'there' ではなく **アプリの名前('product'|'final')** で書く。
//     相手が読んだ時に「向こう」が逆さになるのを防ぐ。

/**
 * 決めた配置を書類に載せる形にする。決めていない日(place:null)は載せない。
 * @param {object} o
 * @param {string} o.name      その人
 * @param {Array}  o.planDays  allocateSharedWorker の戻りの days
 * @param {string} o.hereApp   'product' | 'final'(この工場)
 * @param {string} o.thereApp  相手の工場
 * @param {number} o.nowMs     決めた時刻(**押した時刻**)。🚨 中で時計を読まない。
 *   🚨 計算の基準時刻(baseNowMs)を渡してはいけない。過去の期間を選んで押すと decidedAt が小さくなり、
 *     新旧比べで古い配置に負ける(2026-09-14 ChatGPT の指摘②)。
 * @returns {object|null} { name, decidedAt, decidedBy, days:[{ymd, app}] }
 */
export function buildPlacement({ name = '', planDays = [], hereApp = '', thereApp = '', nowMs = null } = {}) {
  const who = str(name);
  const here = str(hereApp);
  const there = str(thereApp);
  const at = finite(nowMs);
  if (!who || !here || !there || at == null) return null;
  const days = arr(planDays).filter(isObj).map((d) => {
    const ymd = str(d.ymd);
    if (!ymd) return null;
    if (d.place === PLACE.HERE) return { ymd, app: here };
    if (d.place === PLACE.THERE) return { ymd, app: there };
    return null;   // 決めていない日は載せない(「分かりません」を「休み」にしない)
  }).filter(Boolean);
  if (!days.length) return null;
  return { name: who, decidedAt: at, decidedBy: here, days };
}

/**
 * 配置を **外した** という決定(2026-09-14)。
 * 🚨 自分の書類から配置を消すだけでは、相手の書類に残った古い配置が pickPlacement で選ばれ、
 *   開き直すと復活する(ChatGPT の指摘①)。外す事も「新しい決定」として書類に載せ、新旧比べで勝たせる。
 * @returns {object|null} { name, decidedAt, decidedBy, cleared:true, days:[] }
 */
export function clearPlacement({ name = '', hereApp = '', nowMs = null } = {}) {
  const who = str(name);
  const here = str(hereApp);
  const at = finite(nowMs);
  if (!who || !here || at == null) return null;
  return { name: who, decidedAt: at, decidedBy: here, cleared: true, days: [] };
}

/** 盤に効く配置か(外した決定・壊れた物は false)。 */
export function isPlacementActive(placement) {
  const p = isObj(placement) ? placement : null;
  return !!(p && str(p.name) && p.cleared !== true && arr(p.days).filter(isObj).length);
}

/** 書類の中の配置を読む(壊れていれば null)。外した決定も読む(cleared:true・days 空)。 */
export function readPlacement(doc, name = '') {
  const p = isObj(doc) ? doc.placement : null;
  if (!isObj(p)) return null;
  const who = str(p.name);
  if (!who) return null;
  if (str(name) && who !== str(name)) return null;
  const at = finite(p.decidedAt);
  if (at == null) return null;
  if (p.cleared === true) return { name: who, decidedAt: at, decidedBy: str(p.decidedBy), cleared: true, days: [] };
  const days = arr(p.days).filter(isObj)
    .map((d) => ({ ymd: str(d.ymd), app: str(d.app) }))
    .filter((d) => d.ymd && d.app);
  if (!days.length) return null;
  return { name: who, decidedAt: at, decidedBy: str(p.decidedBy), days };
}

/**
 * 両方の書類から「いま効いている配置」を1つ選ぶ。**新しい方**(decidedAt)。
 * 🚨 同じ時刻なら here を採る(自分で決めた物を相手の古い写しに負けさせない)。
 */
export function pickPlacement({ hereDoc = null, thereDoc = null, name = '' } = {}) {
  const a = readPlacement(hereDoc, name);
  const b = readPlacement(thereDoc, name);
  if (a && b) return b.decidedAt > a.decidedAt ? b : a;
  return a || b || null;
}

/**
 * 配置 → この工場の休みの表(scenario.absences の形)。
 * その人が **別の(知っている)工場に居る日** だけ休み。この工場に居る日・知らない工場の日・外した決定は何もしない。
 * @returns {object} { 'YYYY-MM-DD': { 村: 'support:final' } }(向こうの工場の応援)。1日も無ければ {}
 */
export function placementToAbsences({ placement = null, app = '' } = {}) {
  const p = isObj(placement) ? placement : null;
  const here = str(app);
  const out = {};
  if (!p || !here || !str(p.name) || p.cleared === true) return out;
  arr(p.days).filter(isObj).forEach((d) => {
    const ymd = str(d.ymd);
    const where = str(d.app);
    if (!ymd || !where || where === here) return;
    if (!isKnownApp(where)) return;   // 🚨 知らない工場は「分かりません」。休みにしない
    out[ymd] = { ...(out[ymd] || {}), [str(p.name)]: supportStatusOf(where) };
  });
  return out;
}

/** 配置の指紋(盤の鍵に混ぜる)。無ければ ''。外した決定も指紋が変わる(書類に載せる為)。 */
export function placementKey(placement) {
  const p = isObj(placement) ? placement : null;
  if (!p || !str(p.name)) return '';
  const at = finite(p.decidedAt) == null ? '' : finite(p.decidedAt);
  if (p.cleared === true) return `${str(p.name)}@${at}:cleared`;
  return `${str(p.name)}@${at}:${arr(p.days).filter(isObj).map((d) => `${str(d.ymd)}=${str(d.app)}`).join(',')}`;
}

/** 配置を人が読む1文(画面はこれをそのまま出す)。 */
export function placementText({ placement = null, hereApp = '', hereLabel = 'ここ', thereLabel = '向こう' } = {}) {
  const p = isObj(placement) ? placement : null;
  if (!p) return '';
  const here = str(hereApp);
  const by = str(p.decidedBy) === here ? hereLabel : (str(p.decidedBy) ? thereLabel : '');
  if (p.cleared === true) return `${str(p.name)}さんの配置を外しました${by ? `（${by}で外した）` : ''}`;
  const n = { here: 0, there: 0 };
  arr(p.days).filter(isObj).forEach((d) => { if (str(d.app) === here) n.here += 1; else n.there += 1; });
  return `${str(p.name)}さんを ${thereLabel} に ${n.there}日／${hereLabel} に ${n.here}日${by ? `（${by}で決めた配置）` : ''}`;
}

// =============================================================================
//  ③' 曜日の配置(毎週)。2026-09-14
//    清水さん「両方作業できる作業者を曜日毎で指定したのに、シュミレーションでは全く適用していなかった」
//    実測(本番の写し 2026-09-14): 曜日の登録は どちらのアプリにも1件も無く、
//    ロスター(日ごと)は 6/30〜8/17 で止まっていた(7日分しか見えない格子に毎週 入れていた)。
//    → 「毎週◯曜は◯◯」を **1回** 登録し、両方の工場が同じ物を読む(共有棚 capacity-shared-v1)。
//    🚨 ここは純関数だけ。書類の形: { name, weekly: { '1':'final', '2':'final', '3':'product' }, updatedAt, updatedBy }
// =============================================================================
/** 書類 → 曜日の配置(壊れていれば null)。知らない工場・0..6 でない鍵は捨てる。 */
export function normalizeWeeklyRule(raw) {
  if (!isObj(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const src = isObj(raw.weekly) ? raw.weekly : {};
  const weekly = {};
  for (let wd = 0; wd <= 6; wd += 1) {
    const v = str(src[String(wd)]);
    if (isKnownApp(v)) weekly[String(wd)] = v;
  }
  // 📅 2026-09-17 営業日ごとの決め(この日だけ)。清水さん「営業日ごとボタンでどっちで働くか切り替えれればいいけど、
  //   そうでもなく、どこで切り替えれるの？謎すぎる」→ 札を押した日は **その日だけ** 工場を決める。曜日より強い。
  //   🚨 'YYYY-MM-DD' でない鍵・知らない工場は捨てる(壊れた物を盤へ運ばない)。日付順に並べ直す。
  const dsrc = isObj(raw.days) ? raw.days : {};
  const days = {};
  Object.keys(dsrc).map(str).filter((k) => weekdayOfYmd(k) != null).sort().forEach((k) => {
    const v = str(dsrc[k]);
    if (isKnownApp(v)) days[k] = v;
  });
  return { name, weekly, days, updatedAt: finite(raw.updatedAt), updatedBy: str(raw.updatedBy) };
}

/** 書類の id。名前は日本語なので、文字の符号を並べた ASCII にする(置き場の道具が id に字種の制限を持つ事がある)。 */
export function weeklyRuleDocId(name) {
  const who = str(name);
  return who ? `w_${[...who].map((c) => c.codePointAt(0).toString(16)).join('_')}` : '';
}

/** 画面が押した物 → 書類。🚨 中で時計を読まない(nowMs は押した時刻)。 */
export function buildWeeklyRule({ name = '', weekly = null, days = null, updatedBy = '', nowMs = null } = {}) {
  const at = finite(nowMs);
  if (at == null) return null;
  const norm = normalizeWeeklyRule({ name, weekly, days });
  if (!norm) return null;
  return { ...norm, updatedAt: at, updatedBy: str(updatedBy) };
}

/** 曜日の配置を その日々に展開する → [{ ymd, app, by }]。決まっていない曜日は載せない。
 *  📅 2026-09-17 「この日だけ」(rule.days)が曜日より強い。by: 'day'(この日だけ) | 'weekly'(毎週)。 */
export function weeklyPlacementDays({ rule = null, ymds = [] } = {}) {
  const r = normalizeWeeklyRule(rule);
  if (!r) return [];
  return arr(ymds).map(str).filter(Boolean).map((ymd) => {
    const day = r.days[ymd] || '';
    if (day) return { ymd, app: day, by: 'day' };
    const wd = weekdayOfYmd(ymd);
    const app = wd == null ? '' : (r.weekly[String(wd)] || '');
    return app ? { ymd, app, by: 'weekly' } : null;
  }).filter(Boolean);
}

/** その日が 何で決まっているか → { 'YYYY-MM-DD': 'day'|'weekly' }(allocateSharedWorker の fixedBy)。 */
export function fixedByFromWeekly({ rule = null, ymds = [] } = {}) {
  const out = {};
  weeklyPlacementDays({ rule, ymds }).forEach((d) => { out[d.ymd] = d.by; });
  return out;
}

/** 「この日だけ」の決めを人が読む1文。何も決めていなければ ''。ymds を渡すと その日々の分だけ。 */
export function dayRuleText({ rule = null, ymds = null, hereApp = '', hereLabel = 'ここ', thereLabel = '向こう' } = {}) {
  const r = normalizeWeeklyRule(rule);
  if (!r) return '';
  const here = str(hereApp);
  const only = Array.isArray(ymds) ? new Set(ymds.map(str)) : null;
  const parts = Object.keys(r.days).filter((ymd) => !only || only.has(ymd)).map((ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    const wd = weekdayOfYmd(ymd);
    const label = r.days[ymd] === here ? hereLabel : thereLabel;
    return `${Number(m[2])}/${Number(m[3])}(${wd == null ? '' : WEEKDAY_JA[wd]})は ${label}`;
  });
  return parts.length ? `この日だけ ${parts.join('／')}` : '';
}

/** 曜日の配置 → allocateSharedWorker の fixed({ ymd: 'here'|'there' })。 */
export function fixedFromWeekly({ rule = null, ymds = [], hereApp = '' } = {}) {
  const here = str(hereApp);
  const out = {};
  if (!here) return out;
  weeklyPlacementDays({ rule, ymds }).forEach((d) => { out[d.ymd] = d.app === here ? PLACE.HERE : PLACE.THERE; });
  return out;
}

/** 書類(buildDailyLoadDoc)の日付だけを並べる(古い順)。 */
export function docDayKeys(doc) {
  return [...dayMapOf(doc).keys()].sort();
}

/** 曜日の配置を人が読む1文。何も決めていなければ ''。 */
export function weeklyText({ rule = null, hereApp = '', hereLabel = 'ここ', thereLabel = '向こう' } = {}) {
  const r = normalizeWeeklyRule(rule);
  if (!r) return '';
  const here = str(hereApp);
  const groups = new Map();
  // 月→日 の順に並べる(週の始まりは月曜)
  [1, 2, 3, 4, 5, 6, 0].forEach((wd) => {
    const app = r.weekly[String(wd)];
    if (!app) return;
    const label = app === here ? hereLabel : thereLabel;
    groups.set(label, [...(groups.get(label) || []), WEEKDAY_JA[wd]]);
  });
  if (!groups.size) return '';
  return `毎週 ${[...groups.entries()].map(([label, days]) => `${days.join('・')}は ${label}`).join('／')}`;
}

/**
 * 曜日の配置(全員分) + 決めた配置(1人) → この工場の休みの表(scenario.absences の形)。
 *   ・曜日で **別の工場** に居る日 → 休み
 *   ・決めた配置は その日の曜日の配置に **勝つ**(こちらに居ると決めた日は 休みを外す)
 *   ・外した決定(cleared)は 曜日の配置をそのまま残す
 * @param {object} o
 * @param {Array}  [o.rules]   曜日の配置の書類(人ごと)
 * @param {object} [o.decided] 決めた配置(pickPlacement の戻り)
 * @param {string[]} o.ymds    展開する日々(暦の日で良い。仕事の無い日は盤が使わないだけ)
 * @param {string} o.app       この工場
 * @returns {object} { 'YYYY-MM-DD': { 村: 'support:final' } }(向こうの工場の応援。休み 'off' ではない)
 */
export function composeAbsences({ rules = [], decided = null, ymds = [], app = '' } = {}) {
  const here = str(app);
  const out = {};
  if (!here) return out;
  const put = (ymd, who, where) => { out[ymd] = { ...(out[ymd] || {}), [who]: supportStatusOf(where) }; };
  const drop = (ymd, who) => {
    if (!out[ymd]) return;
    const rest = { ...out[ymd] };
    delete rest[who];
    if (Object.keys(rest).length) out[ymd] = rest; else delete out[ymd];
  };
  arr(rules).forEach((raw) => {
    const r = normalizeWeeklyRule(raw);
    if (!r) return;
    weeklyPlacementDays({ rule: r, ymds }).forEach((d) => { if (d.app !== here) put(d.ymd, r.name, d.app); });
  });
  if (isPlacementActive(decided)) {
    const who = str(decided.name);
    arr(decided.days).filter(isObj).forEach((d) => {
      const ymd = str(d.ymd);
      const where = str(d.app);
      if (!ymd || !where) return;
      if (where === here) { drop(ymd, who); return; }
      if (isKnownApp(where)) put(ymd, who, where);
    });
  }
  return out;
}

/** 暦の日を並べる(fromMs から days 日)。🚨 中で時計を読まない。 */
export function ymdsFrom({ fromMs = null, days = 0 } = {}) {
  const from = finite(fromMs);
  const n = Math.max(0, Math.min(400, Math.trunc(Number(days)) || 0));
  if (from == null) return [];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(ymdLocal(from + i * 86400000));
  return out;
}

// =============================================================================
//  ③ 決めた配置を「向こうに居る日 = ここでは休み」へ翻訳
// =============================================================================
/**
 * @param {object} o
 * @param {string} o.name  その人
 * @param {Array}  o.days  allocateSharedWorker の戻りの days
 * @param {'here'|'there'} [o.side='there'] 「ここでは休み」にする側
 * @param {string} [o.thereApp] 向こうの工場('product'|'final')。渡せば記号は 応援(support:◯◯)、渡さなければ 'off'(今までと同じ)
 * @returns {object|null} { 'YYYY-MM-DD': { 村: 'support:final' } }(sharedWorker.js の absencesForPeriod と同じ形)
 */
export function planToAbsences({ name = '', days = [], side = PLACE.THERE, thereApp = '' } = {}) {
  const who = str(name);
  if (!who) return null;
  const want = side === PLACE.HERE ? PLACE.HERE : PLACE.THERE;
  const out = {};
  arr(days).filter(isObj).forEach((d) => {
    const ymd = str(d.ymd);
    if (!ymd) return;
    // 🚨 決めていない日(place:null)は休みにしない。「分かりません」を「休み」に読み替えない。
    if (d.place !== want) return;
    out[ymd] = { [who]: (want === PLACE.THERE && str(thereApp)) ? supportStatusOf(thereApp) : 'off' };
  });
  return out;
}

// =============================================================================
//  ④ 決めた配置で「1回だけ」引き直す為の段と、その読み方
// =============================================================================
export const PLAN_RUN_KEY = 'sharedPlan';

/**
 * 引き直せない理由(日本語1文)。引き直せるなら null。
 * 🚨 画面の中で判定を書かない為に ここへ置く(画面は この文をそのまま出すだけ)。
 * 🚨 見通しの日数を **作らない**。`horizonDays || 5` と書くと、読めない時に勝手に
 *   5営業日で引き直し、期間ぜんぶの「前」と5日ぶんの「後」を矢印で並べてしまう
 *   (Number(null)===0 の罠。2026-09-05 の検証で実測)。
 *
 * @param {object} o
 * @param {string} o.name
 * @param {Array}  o.planDays  allocateSharedWorker の戻りの days
 * @param {number} o.horizonDays いま盤が回している営業日数
 * @param {number} o.nowMs
 * @param {boolean} [o.runnable] 引き直す道具(runRung)を受け取っているか
 * @returns {string|null}
 */
export function planRunBlocker({
  name = '', planDays = [], horizonDays = null, nowMs = null, runnable = true, thereApp = '',
} = {}) {
  if (!runnable) return '引き直す道具がまだ用意できていません';
  if (!str(name)) return '動かす人が決まっていません';
  if (finite(nowMs) == null) return '基準の時刻が読めていないので引き直せません';
  const d = finite(horizonDays);
  if (d == null || !(d >= 1)) return '見通しの日数が読めていないので引き直せません';
  const abs = planToAbsences({ name: str(name), days: planDays, side: PLACE.THERE, thereApp });
  if (!abs || Object.keys(abs).length === 0) return `${str(name)}さんが 向こうへ行く日が1日もありません（引き直しても今と同じです）`;
  return null;
}

/**
 * 決めた配置を、はしごと同じ形の「段」にする(ladderRunner.runLadderRung がそのまま食える)。
 * 🚨 引き直しは押した時だけ1回。ここで計算はしない(休みの表へ翻訳するだけ)。
 *
 * @param {object} o
 * @param {string} o.name
 * @param {Array}  o.planDays  allocateSharedWorker の戻りの days
 * @param {number} o.horizonDays いま盤が回している営業日数
 * @param {string} [o.hereLabel]
 * @param {string} [o.thereLabel]
 * @returns {object|null} { key, label, horizonDays, scenarioPatch, factoryCalendar }
 */
export function buildSharedPlanRung({
  name = '', planDays = [], horizonDays = null, hereLabel = 'ここ', thereLabel = '向こう', thereApp = '',
} = {}) {
  const who = str(name);
  if (!who) return null;
  const absences = planToAbsences({ name: who, days: planDays, side: PLACE.THERE, thereApp });
  if (!absences) return null;
  const awayDays = Object.keys(absences).length;
  // 🚨 見通しの日数を **作らない**。読めなければ段を作らない(呼ぶ側が理由を出す)。
  //   Math.max(1, Number(null) || 1) と書くと null が 1日 に化ける(Number(null)===0 の罠)。
  const raw = finite(horizonDays);
  const days = raw == null ? null : Math.trunc(raw);
  if (days == null || !(days >= 1)) return null;
  return {
    key: PLAN_RUN_KEY,
    label: `${who}さんを 日ごとに置き分ける（${thereLabel} に ${awayDays}日／${hereLabel} は その日 休み）`,
    horizonDays: days,
    scenarioPatch: { absences },
    factoryCalendar: null,
  };
}

/**
 * 引き直した結果を読む。🚨 数える式は rescueLadder.measureRun ただ1本(はしごと同じ数え方)。
 * 窓の端が違えば差を作らない。
 *
 * @param {object} o
 * @param {object} o.planRun  { key, label, normalized, simResult, tookMs, horizonDays }
 * @param {object} o.baseRun  いまの盤の結果を同じ形にした物(引き直す前)
 * @param {number} o.nowMs
 * @returns {{before:object,after:object,sameWindow:boolean,delta:object}}
 */
export function measurePlanRun({ planRun = null, baseRun = null, nowMs = null } = {}) {
  const now = finite(nowMs);
  const before = measureRun({ ...(isObj(baseRun) ? baseRun : {}), key: 'base' }, now);
  const after = measureRun({ ...(isObj(planRun) ? planRun : {}), key: PLAN_RUN_KEY }, now);
  const ok = before.measured && after.measured;
  const sameWindow = ok && before.windowEndMs != null && before.windowEndMs === after.windowEndMs;
  const diff = (k) => (sameWindow ? (Number(after[k]) - Number(before[k])) : null);
  return {
    before,
    after,
    sameWindow,
    delta: { count: diff('count'), forecastLate: diff('forecastLate'), unresolvedDue: diff('unresolvedDue') },
  };
}

export default allocateSharedWorker;

// =============================================================================
//  ⑤ 相手の納期一覧(2026-09-15)
//    清水さん「両方いける人の話になるけど、これはバランスの話だから、やっぱり両方の納期の一覧を
//    同時に見える状態が望ましいかな、それ見ながら調整するべきだしね」
//    自分の納期一覧の行(DueCalendar と同じ dueRowFacts で作った物)を、書類 daily_load の1欄 dueList に載せる。
//    相手はそれを読んで並べるだけ。🚨 ここで数を作り直さない。行数の上限だけ守る(1件 1MB の決まり)。
// =============================================================================
export const DUE_LIST_MAX_ROWS = 1500;
/**
 * 📏 2026-09-16 行に「手が付いている区間」spans([[startMs,endMs],…])を載せる(相手の一覧も 棒 で描く為)。
 *   清水さん「製品検査に最終検査の納期一覧って追加されてるけど、見づらいから、
 *   納期一覧 — 誰が・いつ終わり・納期に間に合うか みたいに表示して最終検査も」
 *   🚨 数は作らない。呼ぶ側が dueAxis.mergeSpans で作った物をそのまま載せる(無ければ空)。
 *   🚨 1件 1MB の決まり: 1行あたり最大 DUE_SPANS_PER_ROW 組・書類まるごとで DUE_SPANS_MAX 組。
 *     数字は Firestore で 8バイト。1500行×24組×2 = 72,000 個 ≒ 576KB は他の欄と合わせて危ないので、
 *     書類全体の予算(DUE_SPANS_MAX×2×8 ≒ 64KB)を超えた行は spans を空にする(行そのものは落とさない)。
 */
export const DUE_SPANS_PER_ROW = 24;
export const DUE_SPANS_MAX = 4000;
const cheapHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); };
const hhmmLocal = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/**
 * 区間の並びを読む(読めない組は捨てる・時刻順・上限 DUE_SPANS_PER_ROW)。まとめ直しはしない(呼ぶ側が mergeSpans 済み)。
 * 🚨 2026-09-19: 棚へ入れる形は **{ s, e } の並び**。
 *   [[開始,終了],…] のままだと Firestore が「配列の中の配列は入れられません」と断り、
 *   **書類まるごと** が書けなくなる(製品検査は 2026-09-16〜09-19 のあいだ 1度も書けていなかった)。
 *   入ってくる形は どちらでもよい([開始,終了] でも { s, e } でも読む)。
 */
const spanPairOf = (x) => {
  if (Array.isArray(x)) return [finite(x[0]), finite(x[1])];
  if (isObj(x)) return [finite(x.s), finite(x.e)];
  return null;
};
const spansOf = (raw) => arr(raw)
  .map(spanPairOf)
  .filter((x) => x && x[0] != null && x[1] != null && x[1] > x[0])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  .slice(0, DUE_SPANS_PER_ROW)
  .map(([s, e]) => ({ s, e }));
const dueRowOf = (r) => ({
  lotId: str(r.lotId), orderNo: str(r.orderNo), model: str(r.model), sub: str(r.sub), qty: finite(r.qty),
  worker: str(r.worker), tier: finite(r.tier), dueMs: finite(r.dueMs), finishMs: finite(r.finishMs),
  lateDays: finite(r.lateDays), pastDays: finite(r.pastDays), why: str(r.why),
  spans: spansOf(r.spans),
});

/**
 * 自分の納期一覧 → 書類の1欄。
 * @param {object} o
 * @param {Array}  o.rows       DueCalendar と同じ行({ lotId, orderNo, model, sub, qty, worker, tier, dueMs, finishMs, lateDays, pastDays, why, spans })
 * @param {string} o.app        'product' | 'final'
 * @param {number} o.nowMs      書いた時刻。🚨 中で時計を読まない
 * @param {number} [o.horizonEnd]
 * @returns {object|null} { app, writtenAt, horizonEnd, total, truncated, rows, key, spansTruncated }
 */
export function buildDueListDoc({ rows = [], app = '', nowMs = null, horizonEnd = null } = {}) {
  const written = finite(nowMs);
  const here = str(app);
  if (written == null || !here) return null;
  const all = arr(rows).filter(isObj);
  const list = all.slice(0, DUE_LIST_MAX_ROWS).map(dueRowOf).filter((r) => r.lotId);
  // 📏 書類まるごとの区間の予算(1件 1MB)。超えた行は spans を空にする(行は落とさない・切った事を言う)。
  let used = 0;
  let spansTruncated = false;
  for (const r of list) {
    if (used + r.spans.length > DUE_SPANS_MAX) { if (r.spans.length) spansTruncated = true; r.spans = []; continue; }
    used += r.spans.length;
  }
  const key = `${list.length}:${cheapHash(list.map((r) => `${r.lotId}=${r.tier}/${r.finishMs}/${r.worker}/${r.lateDays}/${r.spans.map((x) => `${x.s}-${x.e}`).join('+')}`).join(','))}`;
  // truncated = 上限で切った時だけ(lotId の無い行を落とした分は「切った」ではない)
  return { app: here, writtenAt: written, horizonEnd: finite(horizonEnd), total: all.length, truncated: all.length > DUE_LIST_MAX_ROWS, rows: list, key, spansTruncated };
}

/** 書類(daily_load)の中の納期一覧を読む(壊れていれば null)。既に読んだ物(rows を持つ)をそのまま渡しても良い。 */
export function readDueListDoc(doc) {
  const p = isObj(doc) ? (Array.isArray(doc.rows) ? doc : doc.dueList) : null;
  if (!isObj(p) || !str(p.app)) return null;
  const rows = arr(p.rows).filter(isObj).map(dueRowOf).filter((r) => r.lotId);
  const total = finite(p.total);
  return {
    app: str(p.app), writtenAt: finite(p.writtenAt), horizonEnd: finite(p.horizonEnd),
    total: total == null ? rows.length : total, truncated: p.truncated === true, rows, key: str(p.key),
    spansTruncated: p.spansTruncated === true,
  };
}

/** 段ごとの件数。🚨 数は行の tier をそのまま数えるだけ。 */
export function dueListCounts(list) {
  const l = readDueListDoc(list);
  if (!l) return null;
  const out = { past: 0, late: 0, unknown: 0, ok: 0, total: l.rows.length, writtenAt: l.writtenAt };
  for (const r of l.rows) {
    if (r.tier === 0) out.past += 1; else if (r.tier === 1) out.late += 1; else if (r.tier === 2) out.unknown += 1; else out.ok += 1;
  }
  return out;
}

/** 見出しの1文(いつの物かを必ず言う)。 */
export function dueListText({ doc = null, label = '向こうの工場' } = {}) {
  const l = readDueListDoc(doc);
  if (!l) return '';
  const at = l.writtenAt;
  const when = at == null ? 'いつの物か分かりません' : `${ymdLocal(at)} ${hhmmLocal(at)} に ${label} が開いた時の物`;
  return `${label}の納期一覧 ${l.rows.length}件（${when}）`;
}

/** 📦🔄 共有棚の「自分の工場のぶん」が新しいと見なす長さ(2026-09-19)。これより古ければ アプリを開いた時に1回だけ書き直す。 */
export const DAILY_LOAD_FRESH_MS = 60 * 60 * 1000;

/**
 * この端末が いま 共有棚を書き直しに行くべきか(2026-09-19)。
 *
 * 🚨 清水さん「シュミレーションは、最終検査と製品検査あるけど、お互い更新しないと、見れないとのはおかしい、
 *    どっちか開いたら、どっちも更新でいいと思うけど」
 *   直す前は **操業シミュレーションの画面を開いた人が居る時だけ** 棚が書かれていた。
 *   実測(本番の控え 2026-09-19 03:00): 製品の負荷は 52.4時間前・最終は 15.8時間前 の物だった。
 *
 * 決め方(この4つを全部満たす時だけ true):
 *   ① 棚を読み終えている(読む前に書くと 決めた配置が消える。2026-09-17 の形)
 *   ② 自分のぶんが 無い / 時刻が読めない / 古い
 *   ③ 操業シミュレーションの画面を開いていない(開いていれば そちらが書く＝二重に計算しない)
 *   ④ この端末でまだ1回もやっていない
 *
 * @param {object} o
 * @param {object|null} o.ownDoc      共有棚の自分のぶん(daily_load の自分のアプリの1件)
 * @param {number} o.nowMs            いま。🚨 中で時計を読まない
 * @param {boolean} o.shelfLoaded     棚を読み終えたか
 * @param {boolean} o.simScreenOpen   操業シミュレーションの画面を開いているか
 * @param {boolean} [o.alreadyTried]  この端末でもう1回やったか
 * @param {number} [o.freshMs]        新しいと見なす長さ
 * @returns {boolean}
 */
export function shouldRefreshDailyLoad({ ownDoc = null, nowMs = null, shelfLoaded = false, simScreenOpen = false, alreadyTried = false, freshMs = DAILY_LOAD_FRESH_MS } = {}) {
  if (!shelfLoaded || simScreenOpen || alreadyTried) return false;
  const now = finite(nowMs);
  if (now == null) return false;                       // 時刻が分からない時は動かない(勝手に書かない)
  const w = isObj(ownDoc) ? finite(ownDoc.writtenAt) : null;
  if (w == null) return true;                          // 無い / 時刻が入っていない = 書き直す
  const span = finite(freshMs);
  return (now - w) >= (span == null ? DAILY_LOAD_FRESH_MS : span);
}
