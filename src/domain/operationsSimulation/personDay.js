// =============================================================================
//  src/domain/operationsSimulation/personDay.js — 「人・日順」の材料（純関数）
// -----------------------------------------------------------------------------
//  🚨 決まり14-5（2026-09-03 清水さん）「その同じ日に作業する作業者を固めて表示するやつも
//     あってもいいかな、そうしたらその日にその作業者がどの順場で作業して、いつ終わるかとか
//     納期に対してとかもわかるからね」
//
//  日 → 人 → その日の順番 で、割付（assignments）を並べ直すだけ。
//    ・同じロットの工程が続く時は1行に束ねる（台ごとの割付は本数が多い）。3分以内の隙間は1本。
//    ・「空き」はその日の勤務の窓の中で割付が無い隙間。理由は idleLog の区間から引く（ここで作らない）。
//      隙間の分数は calendar.workMsBetween（休憩・時間外を引いた分）。
//  🚨 遅れの判定は lotResults（late / alreadyPastDue / lateMs）そのまま。ここで納期と比べ直さない。
//  🚨 Date.now() を読まない。
// =============================================================================
import { kindOfIdleReason, IDLE_KIND } from './idleReason.js';

const MS_DAY = 86400000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** 区間を（gapMs 以内の隙間ごと）1本にまとめる。 */
export function mergeSegments(segs, gapMs = 0) {
  const list = arr(segs)
    .map((s) => [Number(s[0]), Number(s[1])])
    .filter(([a, b]) => isNum(a) && isNum(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + gapMs) { if (e > last[1]) last[1] = e; continue; }
    out.push([s, e]);
  }
  return out;
}

/** 段。DueCalendar と同じ4段（混ぜない）。 */
export const TIER = Object.freeze({ PAST: 0, LATE: 1, UNKNOWN: 2, OK: 3 });

export function tierOf(verdict, dueMs) {
  if (verdict && verdict.alreadyPastDue === true) return TIER.PAST;
  if (verdict && verdict.late === true) return TIER.LATE;
  if ((verdict && verdict.judgeable === false) || dueMs == null) return TIER.UNKNOWN;
  return TIER.OK;
}

/**
 * @param {object} args
 * @param {Array} args.assignments simulate の assignments
 * @param {Array} args.lots        normalized.lots（model / templateId / orderNo / quantity / dueLineMs / steps）
 * @param {Array} args.lotResults  simulate の lotResults
 * @param {string[]} args.workerNames 名簿の並び（画面の並び順になる）
 * @param {Array<{ms:number, winStartMs:number, winEndMs:number, off:boolean}>} args.days 日の列（dueAxis.buildDayColumns）
 * @param {Array} [args.idleLog]   simulate の idleLog（隙間の理由）
 * @param {object} [args.calendar] makeCalendar の戻り（隙間の分数）
 * @param {Map<string,string>} [args.mainByLot] lotId → 主担当の名前（mainWorker.js で決めた物）
 * @param {number} [args.nowMs]    基準時刻。これより前に終わる隙間は「済んだ」ので出さない
 * @param {number} [args.gapMergeMs=180000] 同じロットの工程をつなぐ隙間の上限
 * @param {number} [args.minGapMin=5] これより短い空きは出さない
 * @returns {Array<{dayMs:number, off:boolean, workers:Array<{name:string, items:Array, gaps:Array, firstMs:number|null, lastMs:number|null, busyMin:number}>}>}
 *   営業日だけ。割付も空きも無い人は items が空のまま出す（居ない事にしない）。
 */
export function buildPersonDayRows({
  assignments, lots, lotResults, workerNames, days,
  idleLog = null, calendar = null, mainByLot = null, nowMs = null,
  gapMergeMs = 180000, minGapMin = 5,
} = {}) {
  const names = arr(workerNames).map(str).filter(Boolean);
  const lotById = new Map();
  arr(lots).forEach((l) => { if (l && l.lotId != null) lotById.set(String(l.lotId), l); });
  const verdictById = new Map();
  arr(lotResults).forEach((r) => { if (r && r.lotId != null) verdictById.set(String(r.lotId), r); });
  const titleOf = new Map();
  arr(lots).forEach((l) => arr(l && l.steps).forEach((s) => { if (s && s.processKey && !titleOf.has(s.processKey)) titleOf.set(s.processKey, str(s.title)); }));
  const pkOfJob = new Map();
  // processKey は assignments に無い事がある。jobId = `${lotId}#${stepIndex}#…` なので lots[].steps[stepIndex] から引く。
  const stepOf = (a) => {
    const id = str(a && a.jobId);
    const m = /^(.*)#(\d+)#/.exec(id);
    if (!m) return '';
    const lot = lotById.get(m[1]);
    const st = lot && arr(lot.steps)[Number(m[2])];
    return st && st.processKey ? String(st.processKey) : '';
  };
  const canMeasure = !!(calendar && typeof calendar.workMsBetween === 'function');
  const minutesOf = (s, e, name) => (canMeasure ? (Number(calendar.workMsBetween(s, e, name)) || 0) / 60000 : (e - s) / 60000);

  const out = [];
  for (const d of arr(days)) {
    if (!d || d.off || !isNum(d.winStartMs) || !isNum(d.winEndMs)) continue;
    const dayMs = isNum(d.ms) ? d.ms : d.winStartMs - (d.winStartMs % MS_DAY);
    const workers = names.map((name) => {
      // 👤 2026-09-05: その人の窓(時短・直工比率)で切る。窓の持ち主は calendar.workerWindowOf ただ1つ(ここで作らない)。
      //   直す前は工場の窓で切っていたので、村さん(9:30〜16:00)の帯が「08:30 → 16:55」と出ていた
      //   (前の日の夕方から翌朝へ跨ぐ割付が、工場の窓いっぱいに描かれる。実画面で確認)。
      //   登録の無い人は workerWindowOf が null = 今までどおり工場の窓。
      const win = (calendar && typeof calendar.workerWindowOf === 'function') ? calendar.workerWindowOf(dayMs, name) : null;
      const winStartMs = win && isNum(win.startMs) ? Math.max(d.winStartMs, win.startMs) : d.winStartMs;
      const winEndMs = win && isNum(win.effectiveEndMs) ? Math.min(d.winEndMs, win.effectiveEndMs) : d.winEndMs;
      const mine = arr(assignments).filter((a) => a && (str(a.worker) === name || str(a.partner) === name)
        && isNum(Number(a.startMs)) && isNum(Number(a.endMs))
        && Number(a.startMs) < winEndMs && Number(a.endMs) > winStartMs)
        .sort((a, b) => Number(a.startMs) - Number(b.startMs));
      const groups = new Map();
      mine.forEach((a) => {
        const lotId = String(a.lotId);
        const s = Math.max(Number(a.startMs), winStartMs);
        const e = Math.min(Number(a.endMs), winEndMs);
        if (!(e > s)) return;
        let g = groups.get(lotId);
        if (!g) { g = { lotId, startMs: s, endMs: e, segs: [], processKeys: new Set(), asPartner: false, jobCount: 0 }; groups.set(lotId, g); }
        g.startMs = Math.min(g.startMs, s);
        g.endMs = Math.max(g.endMs, e);
        g.segs.push([s, e]);
        g.jobCount += 1;
        const pk = a.processKey != null && a.processKey !== '' ? String(a.processKey) : (pkOfJob.get(str(a.jobId)) || stepOf(a));
        if (pk) { g.processKeys.add(pk); pkOfJob.set(str(a.jobId), pk); }
        if (str(a.partner) === name) g.asPartner = true;
      });
      const items = [...groups.values()].sort((a, b) => a.startMs - b.startMs).map((g, i) => {
        const lot = lotById.get(g.lotId) || null;
        const v = verdictById.get(g.lotId) || null;
        const dueMs = v && isNum(v.dueLineMs) ? v.dueLineMs : (lot && isNum(lot.dueLineMs) ? lot.dueLineMs : null);
        const tier = tierOf(v, dueMs);
        const lateMs = v && isNum(v.lateMs) ? v.lateMs : null;
        const main = mainByLot ? (mainByLot.get(g.lotId) || '') : '';
        return {
          order: i + 1,
          lotId: g.lotId,
          model: (lot && str(lot.model)) || '(型式なし)',
          templateId: lot ? lot.templateId : null,
          orderNo: lot ? str(lot.orderNo) : '',
          quantity: lot && isNum(Number(lot.quantity)) ? Number(lot.quantity) : null,
          startMs: g.startMs,
          endMs: g.endMs,
          segs: mergeSegments(g.segs, gapMergeMs),
          stepTitles: [...g.processKeys].map((k) => titleOf.get(k) || '').filter(Boolean),
          jobCount: g.jobCount,
          asPartner: g.asPartner,
          isMain: main ? main === name : true,
          mainWorker: main,
          tier,
          dueMs,
          finishMs: v && isNum(v.finishMs) ? v.finishMs : null,
          lateDays: tier <= TIER.LATE && isNum(lateMs) && lateMs > 0 ? Math.ceil(lateMs / MS_DAY) : null,
          pastDays: tier === TIER.PAST && isNum(nowMs) && isNum(dueMs) ? Math.max(1, Math.ceil((nowMs - dueMs) / MS_DAY)) : null,
          assumed: !!(lot && lot.arrivalKind === 'assumed'),
        };
      });
      // 空き（隙間）。理由は idleLog の区間から引く。
      const busy = mergeSegments(items.flatMap((it) => it.segs), gapMergeMs);
      const gaps = [];
      let cur = Math.max(winStartMs, isNum(nowMs) ? nowMs : winStartMs);
      for (const [s, e] of busy) {
        if (s > cur) gaps.push([cur, s]);
        cur = Math.max(cur, e);
      }
      if (cur < winEndMs) gaps.push([cur, winEndMs]);
      const gapRows = gaps.map(([s, e]) => {
        const min = minutesOf(s, e, name);
        // 隙間と一番長く重なる idleLog の区間の理由を採る（隙間の頭と区間の頭は必ずしも揃わない）。
        let hit = null; let best = 0;
        arr(idleLog).forEach((x) => {
          if (!x || str(x.worker) !== name) return;
          const ov = Math.min(Number(x.toMs), e) - Math.max(Number(x.fromMs), s);
          if (isNum(ov) && ov > best) { best = ov; hit = x; }
        });
        const kind = hit ? kindOfIdleReason(hit.reason) : null;
        return { startMs: s, endMs: e, minutes: min, reason: hit ? str(hit.reason) : '', kind, logged: !!hit };
      }).filter((g) => g.minutes >= minGapMin && g.kind !== IDLE_KIND.UNAVAILABLE);
      // 🚨 2026-09-04: 働いた分は **ロットを横断して合体してから** 数える。
      //   直す前は it.segs（ロットごとに3分の隙間を埋めて合体した区間）をロット横断で足していたので、
      //   ① 同じ時刻に2ロットが乗ると倍で出る（作り物で 120分。本当の占有は60分）
      //   ② 3分の隙間ぶんがロットの本数だけ足される
      //   実測で 1人1日が420分の上限を超えた行が 最終12件・製品1件（坂井 2026/9/4=431.4分 ほか）。
      //   合体の隙間(gapMergeMs)は「1行にまとめる」ための物なので、分数には持ち込まない（隙間0で合体）。
      const busyMin = mergeSegments(items.flatMap((it) => it.segs), 0)
        .reduce((a, [s, e]) => a + minutesOf(s, e, name), 0);
      return {
        name,
        items,
        gaps: gapRows,
        firstMs: items.length ? items[0].startMs : null,
        lastMs: items.length ? Math.max(...items.map((it) => it.endMs)) : null,
        busyMin,
        // 🚨 2026-09-04: その日の「空き 合計」はここでは出さない（決まり6: 同じ数字を2つの計算から出さない）。
        //   合計は idleReason.buildIdleByDay ただ1本（idleLog を重なりを畳んで勤務時間で切った物）。
        //   ここの gaps は「どの時間帯に空いたか」の位置と理由だけを持つ。
        //   直す前は gaps の合計を freeMin として返しており、同じ人・同じ日で
        //   見出し(計算1)=0分／行(計算2)=420分 と、1枚の札の中で反対の事を言っていた。
      };
    });
    out.push({ dayMs, off: false, winStartMs: d.winStartMs, winEndMs: d.winEndMs, workers });
  }
  return out;
}

export default buildPersonDayRows;
