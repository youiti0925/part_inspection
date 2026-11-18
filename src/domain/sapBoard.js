// 🏭 SAP 工程の一覧(純粋関数・製品検査アプリの操業シミュレーション「納期の一覧+日付の軸」と同じ作り)
// 目的: scheduleOrders の結果から、(1)品目(指図)ごとの行 (2)工程(作業区グループ)ごとの行 (3)工程そのものの行 (4)上の4枚 の数を作る。
//       行の並べ方は 製品側と同じ dueListOrder.js(遅れの大きい順・終わる順 など)をそのまま使う。
// 入力: scheduleOrders の orders(見込み日時入り)・queueTable の結果・origins・基準日・基準時刻
// 出力: orderRows / stageRows / laneSummary / boardStats
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapBoard.test.mjs
import { hoursOf } from './sapSchedule.js';
import { DAY_MS } from './sapProgress.js';
import { DUE_TIER } from './operationsSimulation/dueRowFacts.js';

export const HOURS_PER_DAY = 7.75;       // 定時 08:30-17:00 から休憩を引いた1台あたりの1日の働ける時間
export const HEAT_WARN_DAYS = 4;         // 待ちの標準時間 ÷ 台数 が この日数ぶん以上 → 黄(注意)
export const HEAT_BAD_DAYS = 8;          // この日数ぶん以上 → 赤(溜まり大)
export const LANE_ORDER = ['旋盤', '立旋盤', 'フライス', '横M/C', '門M/C', '平面研削', '円筒研削', '歯切り', '仕様変更', '面取り洗浄', '受入検査', '三次元検査', '検査'];

export const chainOf = (o) => o.stages.filter((s) => s.kind !== 'misc');
const r1 = (x) => Math.round(x * 10) / 10;
/** 'YYYY-MM-DD' と 'HH:MM'(無ければ dflt)→ ms(端末の時刻) */
export function msOf(iso, time, dflt) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number); const [h, mi] = (time || dflt).split(':').map(Number);
    return new Date(y, m - 1, d, h, mi).getTime();
}

/** 積み上げの基準時刻 = 基準日('YYYY-MM-DD')の始業 08:30。実行した時刻(夜など)で積むと、全部が「今夜終わる」見た目になるため */
export const baseNowMs = (iso) => msOf(iso, null, '08:30');

/** 工程 → 棒の元(開始・終了の ms)。作業中=実績開始から・未=見込み(est)の開始から。見込みが無ければ SAP の計画日(日の始め〜定時) */
export function segOf(s) {
    const startMs = s.status === 'working' && s.actualStart ? msOf(s.actualStart, s.actualStartTime, '08:30') : msOf(s.planStart, s.planStartTime, '08:30');
    let endMs = msOf(s.planEnd, s.planEndTime, '17:00');
    if (startMs != null && endMs != null && endMs < startMs) endMs = startMs;
    return { act: s.act, name: s.name, wc: s.wc, kind: s.kind, status: s.status, startMs, endMs, est: !!s.est, h: s.stdHours, hJ: s.hJ, hL: s.hL, hN: s.hN, planEndMs: msOf(sapEndOf(s), null, '17:00'), delayMs: s.est && s.status !== 'done' ? s.delayMs : null, origin: s.origin ? `${s.origin.name}(${s.origin.wc}) ${s.origin.day.slice(5)}` : '' };
}
/** SAP の計画日(見込みで差し替わる前の元)。見込み(est)の工程は sapPlan*・見込みの無い工程は planStart/End がそのまま SAP の日付 */
export const sapStartOf = (s) => (s.est ? s.sapPlanStart : s.planStart) || null;
export const sapEndOf = (s) => (s.est ? s.sapPlanEnd : s.planEnd) || null;
const planEndMsOf = (s) => msOf(sapEndOf(s), null, '17:00');

/** 行の共通の数(段・遅れ日数)。製品側 dueRowFacts と同じ段の数え方: 計画終了が今より前=すでに過ぎた / 見込みが計画を越える=この先で遅れる */
function facts(dueMs, delayMs, finishMs, nowMs) {
    const lateDays = delayMs != null && delayMs > 0 ? Math.ceil(delayMs / DAY_MS) : null;
    let tier = DUE_TIER.OK;
    if (dueMs == null) tier = DUE_TIER.UNKNOWN;
    else if (dueMs < nowMs) tier = DUE_TIER.PAST;
    else if (lateDays != null) tier = DUE_TIER.LATE;
    const pastDays = tier === DUE_TIER.PAST ? Math.max(1, Math.ceil((nowMs - dueMs) / DAY_MS)) : null;
    return { tier, dueMs, lateDays, pastDays, finishMs };
}

/** ① 品目(指図)ごとの行。1行=機械の工程が残る1指図。棒=残りの工程を横に繋ぐ */
export function orderRows(orders, { nowMs, hoursMode = 'machine*' } = {}) {
    const rows = [];
    for (const o of orders) {
        if (o.allDone || !o.stages.some((s) => s.kind === 'machine')) continue;
        const st = chainOf(o);
        const ci = st.findIndex((s) => s.status !== 'done');
        if (ci < 0) continue;
        const cur = st[ci], last = st[st.length - 1];
        const segs = st.slice(ci).filter((x) => x.status !== 'done').map(segOf).filter((g) => g.startMs != null && g.endMs != null);   // 並びの後ろに済の工程が混じる指図がある(SAP の実データ)ので済は除く
        const lastOpen = st.slice().reverse().find((s) => s.status !== 'done' && s.delayMs != null);
        const finishMs = segs.length ? segs[segs.length - 1].endMs : null;
        rows.push({
            key: o.order, lotId: o.order, orderNo: o.order, item: o.item, itemText: o.itemText.trim(), model: o.itemText.trim() || o.item,
            qty: (st[0] && st[0].qty) || 0, curName: cur.name, curWc: cur.wc, curStatus: cur.status, worker: cur.name,
            nextName: st[ci + 1] ? st[ci + 1].name : '', remaining: st.length - ci, remainH: r1(st.slice(ci).reduce((a, s) => a + hoursOf(s, hoursMode), 0)),
            segs, ...facts(planEndMsOf(last), lastOpen ? lastOpen.delayMs : null, finishMs, nowMs),
        });
    }
    return rows;
}

/** ② 工程(作業区グループ)ごと: その工程を まだ済ませていない指図の行。棒=その工程での作業・薄い棒=前の工程が済んでから始まるまでの待ち */
export function stageRows(orders, name, { nowMs, hoursMode = 'machine*' } = {}) {
    const rows = [];
    for (const o of orders) {
        const st = chainOf(o);
        st.forEach((_, i) => {
        if (!(st[i].name === name && st[i].status !== 'done')) return;
        const s = st[i], prev = i > 0 ? st[i - 1] : null;
        const seg = segOf(s);
        let readyMs = null;
        if (prev) readyMs = prev.status === 'done' ? msOf(prev.actualEnd, prev.actualEndTime, '17:00') : msOf(prev.planEnd, prev.planEndTime, '17:00');
        const ci = st.findIndex((x) => x.status !== 'done');
        const where = i === ci ? (s.status === 'working' ? 'working' : 'waiting') : 'next';   // 作業中 / 前が済んで待っている / これから来る
        const waitMs = s.status === 'working' || readyMs == null || seg.startMs == null || seg.startMs <= readyMs ? 0 : seg.startMs - readyMs;
        rows.push({
            key: o.order + '|' + s.act, lotId: o.order, orderNo: o.order, item: o.item, itemText: o.itemText.trim(), model: o.itemText.trim() || o.item,
            qty: st[0].qty || 0, curName: st[ci] ? st[ci].name : '', worker: name, stageWc: s.wc, where, prevLabel: prev ? `${prev.name}(${prev.wc})` : '(最初の工程)',
            hours: r1(hoursOf(s, hoursMode)), planStartMs: msOf(sapStartOf(s), null, '08:30'), seg, readyMs, waitMs, segs: seg.startMs != null ? [seg] : [],
            ...facts(planEndMsOf(s), seg.delayMs, seg.endMs, nowMs),
        });
        });
    }
    return rows;
}

/** ③ 工程(作業区グループ)そのものの一覧。opts: { capOf(wc)=>台数, queue(queueTable の結果), hoursMode } */
export function laneSummary(orders, { hoursMode = 'machine*', capOf = () => 1, queue = null, days = 14 } = {}) {
    const lanes = new Map();
    const L = (n, kind) => { if (!lanes.has(n)) lanes.set(n, { name: n, kind, now: 0, wait: 0, next: 0, waitH: 0, wcs: new Set() }); return lanes.get(n); };
    for (const o of orders) for (const s of chainOf(o)) L(s.name, s.kind).wcs.add(s.wc);
    for (const o of orders) {
        if (o.allDone || !o.stages.some((s) => s.kind === 'machine')) continue;
        const st = chainOf(o); const ci = st.findIndex((s) => s.status !== 'done'); if (ci < 0) continue;
        const l = L(st[ci].name, st[ci].kind);
        if (st[ci].status === 'working') l.now++; else { l.wait++; l.waitH += hoursOf(st[ci], hoursMode); }
        if (st[ci + 1]) L(st[ci + 1].name, st[ci + 1].kind).next++;
    }
    const sparkOf = {};
    if (queue) for (const r of queue.rows) {
        const a = (sparkOf[r.name] ??= new Array(days).fill(0));
        r.perShown.slice(0, days).forEach((x, i) => { a[i] = r1(a[i] + x.h); });
    }
    const rank = (n) => { const i = LANE_ORDER.indexOf(n); return i < 0 ? 999 : i; };
    return [...lanes.values()].map((l) => {
        const wcs = [...l.wcs];
        const dai = wcs.reduce((a, wc) => a + Math.max(1, capOf(wc) || 1), 0) || 1;
        const backlogDays = l.waitH / (dai * HOURS_PER_DAY);
        return { ...l, wcs, dai, waitH: r1(l.waitH), total: l.wait + l.now, backlogDays: r1(backlogDays),
            heat: backlogDays >= HEAT_BAD_DAYS ? 3 : backlogDays >= HEAT_WARN_DAYS ? 2 : 1, spark: sparkOf[l.name] || new Array(days).fill(0) };
    }).filter((l) => l.wait + l.now + l.next > 0).sort((a, b) => rank(a.name) - rank(b.name));
}

/** 上の4枚。rows=orderRows の結果・lanes=laneSummary の結果・origins=scheduleOrders の起点 */
export function boardStats(rows, lanes, origins = []) {
    const top = lanes.slice().sort((a, b) => b.backlogDays - a.backlogDays)[0] || null;
    let maxDelayDays = 0;
    for (const r of rows) maxDelayDays = Math.max(maxDelayDays, r.lateDays || 0);
    return {
        top, origin: origins[0] || null, open: rows.length,
        late: rows.filter((r) => r.lateDays != null).length, maxDelayDays,
        pastNow: rows.filter((r) => r.tier === DUE_TIER.PAST).length,
    };
}
