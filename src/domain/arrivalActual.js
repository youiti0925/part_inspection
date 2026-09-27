// 🚚 到着の「来た / 来ない」チェックと、班ごとのクセ(予定に対して早い・遅い)。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//
// 清水さん(2026-08-01):
//   「その到着時間に対して来てるとか来てないって、どこかにチェックできるところって
//     作れたらいいなって思う、来なかったら催促に使ったり、到着時間に対して早かったり
//     遅かったりもデータとして蓄積したら、傾向がわかるから、あの班の到着時間予定は、
//     だいたい30分後にくるかなとかわかったらいいなと思う。
//     **これはあくまで検査側の予測だけで使うやつで、他に見せることはしない**かな」
//
// ⚠⚠⚠ **組立には見せない。隠すのではなく、組立が読まない棚に置く。**
//   置き場所は各検査アプリ自身の名前空間の `arrival_actuals`(下の ACTUAL_COL)。
//   連絡の棚(arrival_times / contact_requests)には **1バイトも書かない**。
//   あそこは組立ポータルがそのまま読んでいるので、書いた瞬間に相手へ見える。
//   → 「readOnly フラグで隠す」方式にしない。制御装置の見るだけ画面と同じ考え方。
//
// ⚠この数字は見た人には「班の成績表」に見える。作りとして出さないだけでなく、
//   人数の少ない班では個人の評価になり得ることを忘れないこと。
//
// ⚠ここは純粋な計算だけ(画面と保存はここに書かない)。テストできる状態を保つため。

/** 検査アプリ自身の名前空間に置く。⚠contact-shared-v1 にも arrival_times にも置かない。 */
export const ACTUAL_COL = 'arrival_actuals';

/** 便(分納の1回ぶん)を一意に指す鍵。⚠配列の番号を鍵にしない(便が増減すると別物を指す)。 */
export const splitKeyOf = (date, time) => `${String(date || '')}T${String(time || '')}`;

/** 1件の記録を作る。⚠undefined を混ぜない(Firestoreが受け取らない)。 */
export const buildActual = ({ lotId, orderNo, model, group, date, time, plannedTs, actualTs, qty, by, now }) => ({
    id: `${lotId}__${splitKeyOf(date, time)}`.replace(/[.#$[\]/]/g, '_'), // ⚠Firestoreのキーに使えない文字を落とす
    lotId: String(lotId || ''),
    orderNo: String(orderNo || ''),
    model: String(model || ''),
    group: String(group || ''),          // どの班からの連絡か(傾向はこれで束ねる)
    date: String(date || ''),
    time: String(time || ''),
    plannedTs: Number(plannedTs) || 0,   // 教えてもらった時刻
    actualTs: Number(actualTs) || 0,     // 実際に着いた時刻(検査側が押した時刻)
    qty: Number(qty) || 0,
    by: String(by || ''),
    at: Number(now) || 0,
});

/** ズレ(分)。**プラス=遅れ / マイナス=早い**。どちらか分からなくなるので必ずこの向きで統一する。 */
export const diffMinutes = (plannedTs, actualTs) => {
    if (!plannedTs || !actualTs) return null;
    return Math.round((actualTs - plannedTs) / 60000);
};
export const actualDiffMin = (row) => diffMinutes(row && row.plannedTs, row && row.actualTs);

/** 記録の一覧 → 鍵で引ける形。 */
export const actualsByKey = (rows) => {
    const m = {};
    (rows || []).forEach(r => { if (r && r.id) m[r.id] = r; });
    return m;
};
export const actualIdOf = (lotId, date, time) => `${lotId}__${splitKeyOf(date, time)}`.replace(/[.#$[\]/]/g, '_');
export const isChecked = (map, lotId, date, time) => !!(map && map[actualIdOf(lotId, date, time)]);

// ============================================================================
//  傾向(班ごとのクセ)
// ----------------------------------------------------------------------------
// ⚠**平均ではなく中央値**。1回だけ3時間遅れた便があると平均は嘘になる。
//   「だいたい何分」は中央値の方が実感に合う(改善の的でP25を使ったのと同じ理由)。
// ⚠**件数が少ないうちは傾向を出さない**。3件で「この班は30分遅い」と出すと、
//   それを見て段取りを組んで外れる。既定は5件から。
// ============================================================================
export const MIN_SAMPLES = 5;

/** 下側順位の百分位。⚠補間しない(n=3 で P25 が中央値に潰れるのを避ける。improvementTargets と同じ)。 */
export const percentileOf = (sorted, p) => {
    if (!sorted.length) return null;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
};

export const medianOf = (nums) => {
    const a = (nums || []).filter(n => typeof n === 'number' && isFinite(n)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

/**
 * 班ごとの傾向。
 * @returns [{ group, n, median, p25, p75, onTime, late, early, enough }]
 *   median  … だいたい何分ずれるか(＋遅れ / −早い)
 *   p25/p75 … ばらつき(「±どのくらい振れるか」)
 *   enough  … 件数が足りているか(足りなければ画面に数字を出さない)
 */
export const groupTrends = ({ rows, minSamples = MIN_SAMPLES, onTimeWithinMin = 10 } = {}) => {
    const by = {};
    (rows || []).forEach(r => {
        const d = actualDiffMin(r);
        if (d == null) return;
        const g = String((r && r.group) || '(班なし)');
        (by[g] = by[g] || []).push(d);
    });
    return Object.entries(by).map(([group, diffs]) => {
        const sorted = diffs.slice().sort((a, b) => a - b);
        return {
            group,
            n: diffs.length,
            median: medianOf(diffs),
            p25: percentileOf(sorted, 25),
            p75: percentileOf(sorted, 75),
            onTime: diffs.filter(d => Math.abs(d) <= onTimeWithinMin).length,
            late: diffs.filter(d => d > onTimeWithinMin).length,
            early: diffs.filter(d => d < -onTimeWithinMin).length,
            enough: diffs.length >= minSamples,
        };
    }).sort((a, b) => b.n - a.n || String(a.group).localeCompare(String(b.group)));
};

/** ある班の傾向を1つ引く(検査リストの札に添える用)。⚠件数不足なら null(何も出さない)。 */
export const trendForGroup = (trends, group) => {
    const t = (trends || []).find(x => x.group === group);
    return (t && t.enough) ? t : null;
};

/** 「だいたい +30分」の言い方。⚠0分ちょうどは「ほぼ時間どおり」と言う(±0分は硬い)。 */
export const trendLabel = (t) => {
    if (!t || !t.enough || t.median == null) return '';
    const m = t.median;
    if (Math.abs(m) <= 5) return 'ほぼ時間どおり';
    return m > 0 ? `だいたい ${m}分 遅れ` : `だいたい ${Math.abs(m)}分 早い`;
};

/** 実績を足した見込み時刻。⚠元の予定は書き換えない(あくまで検査側の頭の中の補正)。 */
export const adjustedTs = (plannedTs, trend) => {
    if (!plannedTs || !trend || !trend.enough || trend.median == null) return null;
    return plannedTs + trend.median * 60000;
};

// ============================================================================
//  チェック待ちの一覧(「来た/来てない」を押す画面)
// ----------------------------------------------------------------------------
// ⚠「予定を過ぎたのにまだ押していない」を一番上に出す。催促はここから打つ。
// ============================================================================
export const CHECK_STATE = { LATE: 'late', SOON: 'soon', FUTURE: 'future', DONE: 'done' };

/**
 * @param items [{ lotId, orderNo, model, group, date, time, qty, plannedTs }]
 * @param actuals 記録の map(actualsByKey)
 * @param now
 * @param soonMin 「もうすぐ」とみなす前倒し分(既定60分)
 */
export const buildCheckList = ({ items, actuals, now, soonMin = 60 } = {}) => {
    const rows = (items || []).map(it => {
        const id = actualIdOf(it.lotId, it.date, it.time);
        const rec = actuals ? actuals[id] : null;
        const planned = Number(it.plannedTs) || 0;
        let state = CHECK_STATE.FUTURE;
        if (rec) state = CHECK_STATE.DONE;
        else if (planned && planned <= now) state = CHECK_STATE.LATE;
        else if (planned && planned - now <= soonMin * 60000) state = CHECK_STATE.SOON;
        return {
            ...it, id, planned, state,
            actualTs: rec ? rec.actualTs : 0,
            diffMin: rec ? actualDiffMin(rec) : null,
            lateMin: (!rec && planned && planned <= now) ? Math.round((now - planned) / 60000) : 0,
        };
    });
    // 遅れ(長い順) → もうすぐ(近い順) → これから(近い順) → 済み(新しい順)
    const order = { [CHECK_STATE.LATE]: 0, [CHECK_STATE.SOON]: 1, [CHECK_STATE.FUTURE]: 2, [CHECK_STATE.DONE]: 3 };
    return rows.sort((a, b) => {
        if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
        if (a.state === CHECK_STATE.LATE) return b.lateMin - a.lateMin;
        if (a.state === CHECK_STATE.DONE) return (b.actualTs || 0) - (a.actualTs || 0);
        return (a.planned || Infinity) - (b.planned || Infinity);
    });
};

/** 画面の見出しに出す件数。 */
export const checkCounts = (rows) => ({
    late: (rows || []).filter(r => r.state === CHECK_STATE.LATE).length,
    soon: (rows || []).filter(r => r.state === CHECK_STATE.SOON).length,
    done: (rows || []).filter(r => r.state === CHECK_STATE.DONE).length,
    total: (rows || []).length,
});

/** 催促の文。⚠責める言い方にしない(毎日顔を合わせる相手)。 */
export const remindMessage = (row) => {
    const late = row && row.lateMin > 0 ? `（予定より ${row.lateMin}分 経過）` : '';
    return `到着予定の ${row?.date || ''} ${row?.time || ''} を過ぎていますが、まだ届いていません${late}。状況を教えてください。`;
};

// ============================================================================
//  到着予定 → チェックする行(便ごと)
// ----------------------------------------------------------------------------
// ⚠**分納は便ごとに1行**。まとめて1行にすると「9時の2台は来たが12時の1台はまだ」が表せない。
// ⚠古いものを永久に出さない。既定は7日前まで(それ以前は押し忘れではなく、もう終わった話)。
// ============================================================================
export const DEFAULT_DAYS_BACK = 7;

/**
 * @param arrivals arrival_times の一覧(splits 付き)
 * @param splitsOf 便の取り出し方(src/domain/arrivalSplits.js の splitsOf を渡す)
 * @param lotById  型式・台数の補完に使う(無くても動く)
 */
export const buildArrivalItems = ({ arrivals, splitsOf, lotById = null, now, daysBack = DEFAULT_DAYS_BACK } = {}) => {
    const from = now - daysBack * 86400000;
    const out = [];
    (arrivals || []).forEach(a => {
        if (!a || !a.id) return;
        const lot = lotById ? lotById[a.id] : null;
        const splits = typeof splitsOf === 'function' ? splitsOf(a) : [];
        splits.forEach(s => {
            if (!s || !s.date || !s.time) return;
            const ts = new Date(`${s.date}T${s.time}`).getTime();
            if (!isFinite(ts) || ts < from) return;   // 古すぎるものは出さない
            out.push({
                lotId: a.id,
                orderNo: a.orderNo || (lot && lot.orderNo) || '',
                model: a.model || (lot && lot.model) || '',
                group: a.group || '',
                date: s.date, time: s.time,
                qty: Number(s.qty) || 0,
                plannedTs: ts,
            });
        });
    });
    return out;
};
