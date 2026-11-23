// 🔍 部品検査に「いつ来るか」の見込み(検査 2509 の工程が未完了の指図ごと)
// 目的: 積み上げ(sapSchedule)は検査の日付に使わない(実データで SAP 予定より中央 +67 日の嘘になる)。代わりに:
//   ・近い物(残りの機械工程が 1 つ以下) = 前工程の済(実績)+ 工程ごとの普段の日数(過去の実績の中央値)で逆算
//   ・遠い物 = SAP の検査予定どおり(SAP の予定がもう過ぎた・普段の日数では間に合わない物は 逆算で出す)
//   ・止まっている(前の工程が済んで長く次が始まらない)物・未着手で予定を過ぎた物・完了の入力もれらしい物は 日付を作らず「不明」
// 入力: buildOrders の orders(SAP の元の日付と実績・見込みを混ぜない)・基準日('YYYY-MM-DD')・shipByOrder(指図 → 出庫日 'YYYY-MM-DD'・本物のデータ。無ければ null)
// 出力: { today, rows, sum, weekEnd, limitDays } ・ 日付は「今日からの日数」(今日=0)で持つ(画面が日の軸に置く)
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapArrivalForecast.test.mjs
import { isoToDayNo } from './sapProgress.js';

/** リミット = 出庫日の この稼働日数まえ(1か所) */
export const LIMIT_DAYS_BEFORE_SHIP = 2;
/** 止まっている目安: 工程ごとの普段の日数の 9 割点と この日数の大きい方を超えて動きが無い */
export const STUCK_MIN_DAYS = 5;
/** 工程ごとの普段の日数を 種類全体の値で代用する 標本の下限 */
export const MIN_SAMPLES = 10;

const CODE = [[2313, 2319, '旋盤'], [2320, 2329, 'フライス'], [2330, 2336, '仕様変更'], [2341, 2349, '立旋盤'], [2351, 2359, '横M/C'], [2361, 2369, '門M/C'], [2371, 2379, '円筒研削'], [2381, 2389, '平面研削'], [2390, 2396, '歯切り']];
/** 作業区コードの範囲でグループ名を決める(作業テキストの揺れに引きずられない)。範囲外は工程名 */
export const groupOfStage = (s) => { const c = Number(s.wc); const f = CODE.find(([a, b]) => c >= a && c <= b); return f ? f[2] : s.name; };
const NAME = { '面取り洗浄': '洗浄', '三次元検査': '検査', '付帯作業(一時置き)': '一時置き', '付帯作業': '付帯作業' };
const nmOf = (s) => { const g = groupOfStage(s); return NAME[g] || g || s.wc; };
/** 検査工程 = 作業区 2509(作業テキストに「検査」とあっても 2509 でなければ検査にしない) */
export const isInspectStage = (s) => s.wc === '2509';

const quantile = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (a) => ({ n: a.length, p25: quantile(a, 0.25), med: quantile(a, 0.5), p75: quantile(a, 0.75), p90: quantile(a, 0.9) });
export const hashOf = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** 工程ごとの「普段かかる日数」(前の工程が済 → その工程が済・暦日)を 過去の実績から出す */
export function leadTimes(orders) {
    const D = isoToDayNo;
    const key = (s) => (s.kind === 'machine' ? 'm:' + groupOfStage(s) : s.kind === 'wash' ? 'wash' : s.kind === 'misc' ? 'x:' + s.wc : 'insp');
    const byKey = new Map(), byKind = new Map();
    for (const o of orders) o.stages.forEach((s, i) => {
        if (i === 0 || s.status !== 'done' || o.stages[i - 1].status !== 'done') return;
        const d = D(s.actualEnd) - D(o.stages[i - 1].actualEnd); if (d < 0) return;
        const k = key(s); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(d);
        if (!byKind.has(s.kind)) byKind.set(s.kind, []); byKind.get(s.kind).push(d);
    });
    return (s) => { const a = byKey.get(key(s)); return a && a.length >= MIN_SAMPLES ? stat(a) : stat(byKind.get(s.kind) || [1]); };
}

export function arrivalForecast(orders, { todayIso, shipByOrder = null } = {}) {
    const D = isoToDayNo, T = D(todayIso);
    const dowOf = (n) => new Date((T + n) * 86400000).getUTCDay();
    const wk = (n) => { const d = dowOf(n); return d === 6 ? n + 2 : d === 0 ? n + 1 : n; };   // 土日に着く見込みは次の月曜
    const isoOf = (n) => new Date((T + n) * 86400000).toISOString().slice(0, 10);
    const addWork = (n, k) => { let x = n; const step = k < 0 ? -1 : 1; for (let i = 0; i < Math.abs(k);) { x += step; const w = dowOf(x); if (w !== 0 && w !== 6) i++; } return x; };
    const leadStat = leadTimes(orders);
    const rows = [];
    for (const o of orders) {
        const st = o.stages; const i = st.findIndex((s) => isInspectStage(s) && s.status !== 'done'); if (i < 0) continue;
        const ins = st[i], before = st.slice(0, i), openB = before.filter((s) => s.status !== 'done');
        const doneB = before.filter((s) => s.status === 'done');
        const anyDone = st.some((s) => s.status === 'done');
        const lastDoneIdx = st.reduce((a, s, x) => (s.status === 'done' ? x : a), -1);
        const lastDone = st.filter((s) => s.status === 'done').reduce((a, s) => (!a || s.actualEnd > a ? s.actualEnd : a), null);
        const idle = lastDone ? T - D(lastDone) : null;
        const ooo = before.some((s, x) => s.status !== 'done' && x < lastDoneIdx);   // 後ろが済で前が未 = 完了の入力もれらしい
        const cur = openB[0] || ins;
        const openMach = openB.filter((s) => s.kind === 'machine').length;
        const state = !openB.length ? 'here' : !anyDone ? 'notyet' : openMach <= 1 ? 'near' : 'mid';
        let base = T, lo = 0, med = 0; const calcSegs = [];
        const firstPlan = openB[0] && openB[0].planStart ? D(openB[0].planStart) : T;
        if (state === 'notyet') base = Math.max(T, firstPlan);
        openB.forEach((s, x) => {
            const L = leadStat(s);
            if (x === 0 && anyDone && !ooo) { const m = Math.max(L.med - idle, L.med > 0 ? 1 : 0); lo += Math.max(L.p25 - idle, s.kind === 'machine' ? 1 : 0); med += m; calcSegs.push({ n: nmOf(s), act: s.act, wc: s.wc, d: m }); }
            else if (ooo && before.indexOf(s) < lastDoneIdx) { /* 入力もれと思われる工程は足さない */ }
            else { lo += L.p25; med += L.med; calcSegs.push({ n: nmOf(s), act: s.act, wc: s.wc, d: L.med }); }
        });
        const calcLo = base + lo - T, calcMed = base + med - T;
        const sap = ins.planStart ? D(ins.planStart) - T : null;
        const L0 = leadStat(cur);
        const stuckNow = !ooo && (state === 'near' || state === 'mid') && idle > Math.max(L0.p90, STUCK_MIN_DAYS);

        let kind, arrive = null, segs = [], why = '', short = '', tag = null, sapAsIs = false;
        if (state === 'here' && lastDone) { kind = 'here'; arrive = D(lastDone) - T; }
        // 検査が最初の工程(手前の工程が無く・済も無い): 着いた日が分からない。日付を作らず「不明」(以前は D(null) が NaN になり画面ごと落ちた・実データで 356 指図中 6 件)
        else if (state === 'here') { kind = 'unknown'; short = '検査が最初の工程'; why = '手前の工程が表に無く、着いた日が分かりません(検査が最初の工程)。'; }
        else if (ooo) { kind = 'unknown'; short = '完了の入力もれ?'; why = `後ろの工程が済んでいるのに ${nmOf(cur)} が未完了のままです(完了の入力もれと思われます)。検査に着く日は出せません。`; }
        else if (stuckNow) { kind = 'stuck'; tag = idle; why = `${nmOf(cur)} の前で ${idle}日 動きがありません(普段は ${L0.med}日・長い時でも ${L0.p90}日)。動き出す日が分からないので、検査に着く日は出せません。`; }
        else if (sap == null) { kind = 'unknown'; short = '検査の予定日なし'; why = 'SAP に検査の予定日が入っていません。'; }
        else if (state === 'notyet' && firstPlan < T && (sap < 0 || sap < calcLo)) { const iso0 = isoOf(firstPlan - T), md0 = `${Number(iso0.slice(5, 7))}/${Number(iso0.slice(8, 10))}`; kind = 'unknown'; short = `${md0} 開始の予定が未着手`; why = `最初の工程(${nmOf(cur)})が SAP の予定 ${md0} を ${T - firstPlan}日 過ぎても始まっていません。始まる日が分からないので、検査に着く日は出せません。`; }
        else if (state === 'near' || (state === 'mid' && (sap < 0 || sap < calcLo))) {
            kind = 'bar'; let prev = 0;
            calcSegs.forEach((c) => { const a = wk(prev), b = wk(prev + c.d); segs.push({ n: c.n, act: c.act, wc: c.wc, a, b }); prev += c.d; });
            arrive = wk(calcMed);
        } else {
            kind = 'bar'; sapAsIs = true; arrive = sap; let prev = 0;
            openB.forEach((s, x) => {
                const last = x === openB.length - 1;
                const a = Math.min(sap, Math.max(prev, s.planStart ? D(s.planStart) - T : prev));
                const e = last ? sap : Math.min(sap, Math.max(a, s.planEnd ? D(s.planEnd) - T : a));
                segs.push({ n: nmOf(s), act: s.act, wc: s.wc, a, b: e }); prev = e;
            });
        }
        // 区切りの字: 幅の無い工程は隣へまとめる
        const merged = []; let carry = [], carryS = [];
        const join = (a) => a.filter((x, k) => k === 0 || x !== a[k - 1]).join('・');
        segs.forEach((s) => { if (s.b <= s.a) { carry.push(s.n); carryS.push(s); return; } const all = [...carryS, s]; merged.push({ a: s.a, b: s.b, n: join([...carry, s.n]), wc: all[0].wc, full: all.map((x) => `${x.wc} ${x.n}(活動 ${x.act})`).join(' → ') }); carry = []; carryS = []; });
        if (carry.length && merged.length) { const m = merged[merged.length - 1]; m.n = join([m.n, ...carry]); m.full += ' → ' + carryS.map((x) => `${x.wc} ${x.n}(活動 ${x.act})`).join(' → '); }
        // 遅れ(日): 棒の行=見込み−予定 / 着いた物=着いた日−予定 / 棒の無い物=今日−予定(もう過ぎた分)
        let late = null, lateKind = '';
        if (sap != null) {
            if (kind === 'bar' && arrive > sap) { late = arrive - sap; lateKind = 'fc'; }
            else if (kind === 'here' && arrive > sap) { late = arrive - sap; lateKind = 'fact'; }
            else if ((kind === 'stuck' || kind === 'unknown') && sap < 0) { late = -sap; lateKind = 'past'; }
        }
        const planA = st[0].planStart ? D(st[0].planStart) - T : null;
        const doneEnds = [...new Set(doneB.map((s) => D(s.actualEnd) - T))].sort((a, b) => a - b);
        const firstAct = doneB.length ? Math.min(...doneB.map((s) => D(s.actualStart || s.actualEnd) - T)) : null;
        let prog = 0;
        const lastDoneStage = lastDoneIdx >= 0 ? st[lastDoneIdx] : null;
        const nextPlan = cur.planStart ? D(cur.planStart) - T : null;
        if (lastDoneStage && lastDoneStage.planEnd && D(lastDoneStage.planEnd) - T > 0 && !ooo) prog = D(lastDoneStage.planEnd) - T;
        else if (nextPlan != null && nextPlan < 0) prog = nextPlan;
        const sig = (late != null || kind === 'stuck') ? 'red' : kind === 'unknown' ? 'gray' : prog < 0 ? 'yellow' : 'green';
        // 出庫日(本物のデータの口): 指図ごとに 'YYYY-MM-DD'。無ければ null(画面は作り物の日付で印の見た目だけ示す)
        const realShip = shipByOrder && shipByOrder[o.order] ? D(shipByOrder[o.order]) - T : null;
        const ship = realShip;
        const limit = ship == null ? null : addWork(ship, -LIMIT_DAYS_BEFORE_SHIP);
        const over = limit != null && arrive != null && arrive > limit ? arrive - limit : (limit != null && arrive == null && limit < 0 ? -limit : null);
        const curIdx = st.indexOf(cur);
        const ih = ins.hN > 0 ? Math.round(ins.hN * Math.max(1, ins.qty || 1) * 100) / 100 : null;   // 検査の時間(h)= 標準値3(作業者)× 数量。0 なら null(不明のまま)
        rows.push({
            it: o.item || '', k: curIdx + 1, n: st.length, curAct: cur.act, curWc: cur.wc, insAct: ins.act, ih, ship, limit, over,
            stg: st.map((s) => (s.status === 'done' ? 1 : 0)).join(''), insIdx: i,
            o: o.order, tx: (o.itemText || '').normalize('NFKC').trim() || '(品名なし)', q: ins.qty || st[0].qty || 0,
            cur: state === 'here' ? '検査' : nmOf(cur), state, kind, sapAsIs, idle, sap, arrive, arriveIso: arrive == null ? null : isoOf(arrive), late, lateKind, segs: merged, why, short, tag, left: openB.length,
            planA, firstAct, lastDone: lastDone ? D(lastDone) - T : null, doneEnds, prog, sig,
        });
    }
    const rank = (r) => (r.late != null ? 0 : r.kind === 'stuck' ? 1 : r.kind === 'unknown' ? 2 : 3);
    rows.sort((a, b) => rank(a) - rank(b) || (b.late || 0) - (a.late || 0) || (a.arrive ?? 9999) - (b.arrive ?? 9999) || (a.o < b.o ? -1 : 1));
    const weekEnd = 6 - ((new Date(T * 86400000).getUTCDay() + 6) % 7);    // 今週の日曜まで(今日からの日数)
    const c = (f) => rows.filter(f).length;
    const sum = {
        total: rows.length,
        week: c((r) => r.kind === 'bar' && r.arrive <= weekEnd),
        late: c((r) => r.kind === 'bar' && r.late != null),
        stuck: c((r) => r.kind === 'stuck'),
        ontime: c((r) => r.kind === 'bar' && r.late == null),
        here: c((r) => r.kind === 'here'), unknown: c((r) => r.kind === 'unknown'),
        over: c((r) => r.over != null),
    };
    return { today: todayIso, rows, sum, weekEnd, limitDays: LIMIT_DAYS_BEFORE_SHIP };
}

/** 作り物の出庫日(画面の見た目を示すためだけ・本物のデータの口が無い間): 検査予定日の 3〜9 稼働日あと。指図番号から決まる */
export function mockShipByOrder(forecast) {
    const T = isoToDayNo(forecast.today);
    const out = {};
    const dow = (n) => new Date((T + n) * 86400000).getUTCDay();
    const addWork = (n, k) => { let x = n; for (let i = 0; i < k;) { x += 1; const w = dow(x); if (w !== 0 && w !== 6) i++; } return x; };
    for (const r of forecast.rows) if (r.sap != null) out[r.o] = new Date((T + addWork(r.sap, 3 + (hashOf(r.o) % 7))) * 86400000).toISOString().slice(0, 10);
    return out;
}
