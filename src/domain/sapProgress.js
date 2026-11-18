// 🏭 SAP 工程の進み(純粋関数・部品検査に届く見込みと機械グループの負荷)
// 目的: SAP の工程表(行)から、指図ごとの「今どの工程か」「機械工程が終わる日」「部品検査に届く見込み日」、
//       作業区(機械グループ)ごとの負荷を出す。
// 入力: sapXlsx.js の rows(A指図 B活動 C作業区 D作業テキスト F数量 H/I実績開始/終了(Excelシリアル) J/L/N標準値(H) R/S最早開始/終了 U品目 V品目テキスト)
// 出力: buildOrders(rows) → 指図の配列 / reachList / loadByWorkCenter / loadByGroup / itemSummary
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない)
// 確かめ方: node --test src/domain/__tests__/sapProgress.test.mjs

export const DAY_MS = 86400000;
/** Excel シリアル → 'YYYY-MM-DD'(空・不正は null) */
export function serialToIso(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 1) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n + 1e-9) * DAY_MS).toISOString().slice(0, 10);
}
export function isoToDayNo(iso) { return Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY_MS); }

// 作業区コード → 名前(作業テキストが空の行の保険)
const CODE_FALLBACK = [
    [2381, 2389, '平面研削'], [2371, 2379, '円筒研削'], [2390, 2396, '歯切り'], [2320, 2329, 'フライス'],
    [2351, 2359, '横M/C'], [2361, 2369, '門M/C'], [2341, 2349, '立旋盤'], [2313, 2319, '旋盤'],
    [2509, 2509, '三次元検査'], [2519, 2519, '受入検査'],
];
// 工程名のキーワード(先に当たった物を採用)
const NAME_RULES = [
    ['平面研削', '平面研削'], ['円筒研削', '円筒研削'], ['歯切り', '歯切り'],
    ['ﾌﾗｲｽ', 'フライス'], ['フライス', 'フライス'], ['門M/C', '門M/C'], ['横M/C', '横M/C'],
    ['立旋盤', '立旋盤'], ['旋盤', '旋盤'],
];

/** 作業テキスト・作業区 → { name, kind } kind: machine / inspect / wash / misc */
export function readWorkName(text, code) {
    const raw = String(text || '').replace(/：/g, ':').replace(/\s+/g, ' ').trim();
    const t = raw.replace(/^\d{4}[:\s]+/, '');   // 先頭の「2385:」を外す
    if (/検査/.test(t) || String(code) === '2509') {
        const nm = /三次元/.test(t) || String(code) === '2509' ? '三次元検査' : /受入/.test(t) ? '受入検査' : '検査';
        return { name: nm, kind: 'inspect' };
    }
    if (/洗浄/.test(t)) return { name: '面取り洗浄', kind: 'wash' };
    const head = t.split(':')[0];
    if (/^(付帯作業|仕様変更)/.test(head) || /一時置き|応援|現合/.test(t)) {
        if (/^仕様変更/.test(head)) {
            const m = NAME_RULES.find(([k]) => t.includes(k));
            return { name: m ? m[1] : '仕様変更', kind: 'machine' };
        }
        return { name: t.includes('一時置き') ? '付帯作業(一時置き)' : '付帯作業', kind: 'misc' };
    }
    for (const [k, n] of NAME_RULES) if (head.includes(k) || t.includes(k)) return { name: n, kind: 'machine' };
    const c = Number(code);
    const f = CODE_FALLBACK.find(([a, b]) => c >= a && c <= b);
    if (f) return { name: f[2], kind: /検査/.test(f[2]) ? 'inspect' : 'machine' };
    return { name: '付帯作業', kind: 'misc' };
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const round1 = (x) => Math.round(x * 10) / 10;

/** 行 → 工程(状態つき) */
export function toStage(r) {
    const start = serialToIso(r.H), end = serialToIso(r.I);
    const { name, kind } = readWorkName(r.D, r.C);
    return {
        order: String(r.A ?? ''), act: String(r.B ?? ''), wc: String(r.C ?? ''), name, kind,
        qty: num(r.F),
        status: end ? 'done' : start ? 'working' : 'todo',
        actualStart: start, actualEnd: end,
        planStart: serialToIso(r.R), planEnd: serialToIso(r.S),
        actualStartTime: serialToTime(r.H), actualEndTime: serialToTime(r.I), planStartTime: serialToTime(r.R), planEndTime: serialToTime(r.S),
        hJ: num(r.J), hL: num(r.L), hN: num(r.N),
        stdHours: Math.round((num(r.J) + num(r.L)) * 1000) / 1000,   // 機械の占有時間 = 段取り(標準値1)+機械(標準値2)
        item: String(r.U ?? ''), itemText: String(r.V ?? ''),
    };
}
export const STATUS_LABEL = { done: '済', working: '作業中', todo: '未' };

const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
/** 工程の終了日 = 済なら実績終了・それ以外は最早終了日 */
const stageEndIso = (s) => (s.status === 'done' ? s.actualEnd : s.planEnd);

/** 1指図の工程列 → まとめ */
export function summarizeOrder(stages) {
    const st = stages.slice().sort((a, b) => (a.act < b.act ? -1 : a.act > b.act ? 1 : 0));
    const cur = st.find((s) => s.status !== 'done') || null;
    const isGate = (s) => s.kind === 'inspect' || s.kind === 'wash';   // 検査系(洗浄は検査の直前)
    const firstInspIdx = st.findIndex((s) => isGate(s) && s.status !== 'done');
    const hasInspect = st.some(isGate);
    const machines = st.filter((s) => s.kind === 'machine');
    const machinesDone = machines.length > 0 && machines.every((s) => s.status === 'done');
    let machineEnd = null;
    for (const m of machines) machineEnd = maxIso(machineEnd, stageEndIso(m));
    // 部品検査に届く見込み = 最初の未完了の検査系工程より前の機械工程の終了日(最大)
    //  検査系の工程が表に無い指図は「機械工程が全部終わる見込み日」で代用(reachKind='machine-end')
    let reach = null, reachKind = 'none';
    if (firstInspIdx >= 0) {
        const before = st.slice(0, firstInspIdx).filter((s) => s.kind === 'machine');
        for (const m of before) reach = maxIso(reach, stageEndIso(m));
        reachKind = !before.length ? 'no-machine' : reach ? 'estimate' : 'none';
    } else if (hasInspect) reachKind = 'inspect-done';
    else if (machines.length && !machinesDone && machineEnd) { reach = machineEnd; reachKind = 'machine-end'; }
    else reachKind = machinesDone ? 'machines-done' : 'no-inspect';
    const f = st[0] || {};
    return {
        order: f.order, item: f.item, itemText: f.itemText, stages: st,
        current: cur, currentLabel: cur ? `${cur.act} ${cur.name}` : '全工程済',
        allDone: !cur, machinesDone, machineEnd, reach, reachKind,
        doneCount: st.filter((s) => s.status === 'done').length, total: st.length,
    };
}

/** 行の配列 → 指図ごとのまとめ(指図の出現順) */
export function buildOrders(rows) {
    const map = new Map();
    for (const r of rows || []) {
        if (!r || r.A == null || r.A === '') continue;
        const s = toStage(r);
        if (!map.has(s.order)) map.set(s.order, []);
        map.get(s.order).push(s);
    }
    return [...map.values()].map(summarizeOrder);
}

/** 部品検査に近い順の一覧(届く見込み日が早い順・見込み不明と全部済は除く) */
export function reachList(orders, todayIso, { withinDays = null } = {}) {
    const today = isoToDayNo(todayIso);
    return orders
        .filter((o) => !o.allDone && o.reach)
        .map((o) => ({ ...o, daysFromToday: isoToDayNo(o.reach) - today }))
        .filter((o) => withinDays == null || (o.daysFromToday >= 0 && o.daysFromToday <= withinDays))
        .sort((a, b) => (a.reach < b.reach ? -1 : a.reach > b.reach ? 1 : a.order < b.order ? -1 : 1));
}

/** 作業区ごとの負荷(未完了=済でない工程) */
export function loadByWorkCenter(orders) {
    const m = new Map();
    for (const o of orders) for (const s of o.stages) {
        const k = s.wc;
        if (!m.has(k)) m.set(k, { wc: k, name: s.name, kind: s.kind, total: 0, actual: 0, stdTotal: 0, openCount: 0, openHours: 0, workingCount: 0 });
        const e = m.get(k);
        e.total++; e.stdTotal += s.stdHours;
        if (s.status === 'done') e.actual++;
        else { e.openCount++; e.openHours += s.stdHours; if (s.status === 'working') e.workingCount++; }
    }
    return [...m.values()].map((e) => ({ ...e, stdTotal: round1(e.stdTotal), openHours: round1(e.openHours) }))
        .sort((a, b) => b.openHours - a.openHours);
}

/** 機械グループ(工程名)ごとの負荷(作業区をまとめる) */
export function loadByGroup(orders) {
    const m = new Map();
    for (const e of loadByWorkCenter(orders)) {
        const k = e.name;
        if (!m.has(k)) m.set(k, { name: k, kind: e.kind, wcs: [], total: 0, actual: 0, openCount: 0, openHours: 0, stdTotal: 0 });
        const g = m.get(k);
        g.wcs.push(e.wc); g.total += e.total; g.actual += e.actual; g.openCount += e.openCount;
        g.openHours += e.openHours; g.stdTotal += e.stdTotal;
    }
    return [...m.values()].map((g) => ({ ...g, openHours: round1(g.openHours), stdTotal: round1(g.stdTotal) }))
        .sort((a, b) => b.openHours - a.openHours);
}

/** 品目ごとの集計(件数=工程数・標準時間合計・実績あり件数・指図数) */
export function itemSummary(orders) {
    const m = new Map();
    for (const o of orders) for (const s of o.stages) {
        const k = s.item;
        if (!m.has(k)) m.set(k, { item: k, itemText: s.itemText, orders: new Set(), count: 0, stdHours: 0, actual: 0 });
        const e = m.get(k);
        e.orders.add(o.order); e.count++; e.stdHours += s.stdHours;
        if (s.status !== 'todo') e.actual++;
    }
    return [...m.values()].map((e) => ({ item: e.item, itemText: e.itemText, orderCount: e.orders.size, count: e.count, stdHours: round1(e.stdHours), actual: e.actual }))
        .sort((a, b) => b.count - a.count);
}

// ───── 追加(清水さん 11-17): 1指図=1本のチャート・次の工程への連絡・作業区の日別の負荷 ─────

const dayNo = isoToDayNo;
const dayIso = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const chainOf = (o) => o.stages.filter((s) => s.kind !== 'misc');   // 工程の連なり(付帯作業は外す)

/** 1指図のチャート用の棒: 開始=実績開始(無ければ最早開始)・終了=実績終了(無ければ最早終了)。日付の無い工程は bar=null */
export function orderChart(o, todayIso) {
    const bars = chainOf(o).map((s) => {
        const a = s.actualStart || s.planStart, b = s.actualEnd || s.planEnd || a;
        const ok = a && b;
        return { act: s.act, name: s.name, wc: s.wc, kind: s.kind, status: s.status, start: ok ? a : null, end: ok ? b : null,
            startDay: ok ? dayNo(a) : null, endDay: ok ? dayNo(b) : null };
    });
    const ds = bars.flatMap((b) => (b.startDay == null ? [] : [b.startDay, b.endDay]));
    const today = dayNo(todayIso);
    if (!ds.length) return { bars, minDay: today, maxDay: today + 1, todayDay: today };
    return { bars, minDay: Math.min(...ds, today), maxDay: Math.max(...ds, today), todayDay: today };
}

/** 前の工程が済になった時の「次の工程(作業区)へ連絡」
 *  kind='passed': 前が済・次が未完了(渡った日=前の実績終了) / 'expected': 今の工程が終わる見込みで次へ渡る見込み日=最早終了 */
export function handoffList(orders, todayIso) {
    const out = [];
    for (const o of orders) {
        const c = chainOf(o);
        for (let i = 0; i + 1 < c.length; i++) {
            const p = c[i], n = c[i + 1];
            if (n.status === 'done') continue;
            let kind = null, date = null;
            if (p.status === 'done') { kind = 'passed'; date = p.actualEnd; }
            else if (o.current && p.act === o.current.act) { kind = 'expected'; date = p.planEnd; }
            if (!kind || !date) continue;
            out.push({ kind, order: o.order, item: o.item, itemText: o.itemText, date,
                fromAct: p.act, fromName: p.name, fromWc: p.wc, toAct: n.act, toName: n.name, toWc: n.wc, toStatus: n.status,
                daysFromToday: dayNo(date) - dayNo(todayIso) });
        }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order < b.order ? -1 : 1));
}

/** 機械グループ(または作業区)ごとの日別の負荷(未完了の標準時間を 最早開始〜最早終了 に等分・今日より前は「遅れ」の列へ)
 *  戻り: { days:[iso×N], rows:[{ key, name, late, perDay:[H], total, noDate }] } */
export function dailyLoad(orders, todayIso, { days = 14, by = 'group' } = {}) {
    const today = dayNo(todayIso);
    const m = new Map();
    for (const o of orders) for (const s of o.stages) {
        if (s.status === 'done' || s.kind === 'misc' || s.kind === 'wash' || !s.stdHours) continue;
        const key = by === 'wc' ? s.wc : s.name;
        if (!m.has(key)) m.set(key, { key, name: s.name, late: 0, perDay: new Array(days).fill(0), total: 0, noDate: 0 });
        const e = m.get(key);
        e.total += s.stdHours;
        const a = s.planStart || s.planEnd, b = s.planEnd || s.planStart;
        if (!a) { e.noDate += s.stdHours; continue; }
        const d0 = dayNo(a), d1 = Math.max(dayNo(b), d0), per = s.stdHours / (d1 - d0 + 1);
        for (let d = d0; d <= d1; d++) {
            if (d < today) e.late += per;
            else if (d - today < days) e.perDay[d - today] += per;
        }
    }
    const r1 = (x) => Math.round(x * 10) / 10;
    const rows = [...m.values()].map((e) => ({ ...e, late: r1(e.late), perDay: e.perDay.map(r1), total: r1(e.total), noDate: r1(e.noDate) }))
        .sort((a, b) => b.total - a.total);
    return { days: Array.from({ length: days }, (_, i) => dayIso(today + i)), rows };
}

// ───── 追加2(清水さん 11-17): 1指図=1本のゲージ・工程中心の見方 ─────

/** Excel シリアルの小数部 → 'HH:MM'(時刻が無い=小数部 0 は null。時刻をでっち上げない) */
export function serialToTime(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    const frac = n - Math.floor(n);
    if (frac < 1 / 2880) return null;
    const m = Math.round(frac * 1440);
    return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
const labelOf = (iso, time) => (iso ? (time ? `${iso.slice(5)} ${time}` : iso.slice(5)) : '');

/** 1指図の横1本ゲージ: 工程(付帯作業は除く)を活動順に隙間なく。status = done/working/todo/late(予定終了日を過ぎて未完了) */
export function gaugeOf(o, todayIso) {
    const segs = chainOf(o).map((s) => {
        // 見込みがある(est)時: 見込み終了が計画終了(S)を越えたら遅れ(赤)。見込みが無い時: SAP の計画終了を過ぎて未完了なら遅れ
        const late = s.status !== 'done' && (s.est ? s.delayMs > 0 : (s.sapPlanEnd ?? s.planEnd) && (s.sapPlanEnd ?? s.planEnd) < todayIso);
        const a = s.actualStart || s.planStart, b = s.actualEnd || s.planEnd;
        const plan = s.sapPlanEnd ?? s.planEnd;
        return {
            act: s.act, name: s.name, wc: s.wc, status: late ? 'late' : s.status,
            startLabel: labelOf(a, s.actualStart ? s.actualStartTime : s.planStartTime),
            endLabel: labelOf(b, s.actualEnd ? s.actualEndTime : s.planEndTime),
            startEst: !s.actualStart && !!s.est, endEst: !s.actualEnd && !!s.est,   // 見込み(標準時間から計算)か、SAP の実績か
            planEndLabel: plan ? plan.slice(5) : '',
            delayH: s.est && s.delayMs != null && s.status !== 'done' ? Math.round(s.delayMs / 360000) / 10 : null,
            origin: s.origin ? `${s.origin.name}(${s.origin.wc}) ${s.origin.day.slice(5)}` : '',
        };
    });
    return { order: o.order, item: o.item, itemText: o.itemText, segs, hasTime: segs.some((g) => /[0-9]{2}:[0-9]{2}/.test(g.startLabel + g.endLabel)) };
}

/** 工程中心の見方。key = 機械グループ名(by='group')または作業区(by='wc')
 *  working = 今その工程にいる(作業中) / next = 前の工程が済(または最初の工程)でこの工程が未(来る見込み日順) / done = 済(新しい順) */
export function stageView(orders, key, todayIso, { by = 'group', recent = 30 } = {}) {
    const hit = (s) => (by === 'wc' ? s.wc === key : s.name === key);
    const working = [], next = [], done = [];
    for (const o of orders) {
        const c = chainOf(o);
        c.forEach((s, i) => {
            if (!hit(s)) return;
            const prev = i > 0 ? c[i - 1] : null;
            const base = { order: o.order, item: o.item, itemText: o.itemText, act: s.act, name: s.name, wc: s.wc, stdHours: s.stdHours, o };
            if (s.status === 'working') working.push({ ...base, date: s.actualStart });
            else if (s.status === 'todo' && (!prev || prev.status === 'done')) {
                const date = s.planStart || (prev && prev.actualEnd) || s.planEnd || null;
                next.push({ ...base, date, prevLabel: prev ? `${prev.act} ${prev.name}(${prev.wc})` : '(最初の工程)', prevEnd: prev ? prev.actualEnd : null,
                    daysFromToday: date ? isoToDayNo(date) - isoToDayNo(todayIso) : null });
            } else if (s.status === 'done') done.push({ ...base, date: s.actualEnd });
        });
    }
    const byDate = (a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? -1 : 1);
    next.sort(byDate); working.sort(byDate);
    done.sort((a, b) => -byDate(a, b));
    return { working, next, done: done.slice(0, recent), doneTotal: done.length };
}
