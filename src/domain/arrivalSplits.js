// 分納の到着予定。
//
// 清水さん(2026-07-31): 「この指図(4台ロット)で、9時に2台・12時に1台・17時に1台を
//   指定して連絡したい」。1つの指図に対して **時刻ごとに台数を分けた到着予定** を持てるようにする。
//
// ⚠⚠ 保存の形(後方互換がいちばん大事)
//   arrival_times/{lotId} は今まで { date, time, quantity, ... } の **1件だけ** だった。
//   分納は `splits: [{date, time, qty}, ...]` を **足す**。
//   そして **date/time には一番早い便を入れ続ける**。
//   → 古い画面・古い集計・他アプリは今までどおり動く(一番早い到着として読める)。
//   ⚠Firestore は「配列の中の配列」を保存できない。splits は「配列の中のオブジェクト」なので大丈夫。
//
// ⚠ 全台がそろう1便は今までどおり splits を作らない(既存データと同じ形に保つ)。
//   1便でも「ロットの一部だけ」の時は、その台数を splits に残す。
//   🚨 台数を書いていない便(qty 0)は今までどおり = splits を作らない。
//     連絡ポータルで分納にせず答える道は台数を書かないので、ここを分けないと 0台 と読まれる。

import { dateTimeMs } from './contactBoard.js';

// 1つの指図に入れられる便の数。多すぎると相手が読めないし、書類にも載らない。
export const MAX_SPLITS = 8;

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

const normalize = (s) => ({
    date: String((s && s.date) || ''),
    time: String((s && s.time) || ''),
    qty: num(s && s.qty),
    by: String((s && s.by) || ''),
    at: Number((s && s.at) || 0) || 0,
});

// 早い順。⚠日時が読めないものは最後に置く(先頭に来ると「次の便」を誤る)。
const byTime = (a, b) => {
    const ta = dateTimeMs(a.date, a.time);
    const tb = dateTimeMs(b.date, b.time);
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
};

/** 保存されている到着予定 → 便の配列(早い順)。古いデータ(date/timeだけ)も1便として扱う。 */
export const splitsOf = (arrival) => {
    if (!arrival) return [];
    const raw = Array.isArray(arrival.splits) ? arrival.splits : null;
    if (raw && raw.length) {
        const list = raw.map(normalize).filter(s => s.time);
        if (list.length) return list.slice().sort(byTime);
    }
    if (arrival.time) {
        return [{ date: String(arrival.date || ''), time: String(arrival.time), qty: num(arrival.quantity), by: String(arrival.by || ''), at: Number(arrival.at || 0) || 0 }];
    }
    return [];
};

export const isSplitArrival = (arrival) => splitsOf(arrival).length > 1;
export const splitTotalQty = (splits) => (splits || []).reduce((n, s) => n + num(s && s.qty), 0);
export const splitMs = (s) => (s ? dateTimeMs(s.date, s.time) : null);

export const firstSplit = (splits) => (splits && splits.length ? splits[0] : null);
export const lastSplit = (splits) => (splits && splits.length ? splits[splits.length - 1] : null);

/** まだ来ていない一番早い便。全部過ぎていたら最後の便(=「予定を過ぎた」を出すため)。 */
export const nextSplit = (splits, now = Date.now()) => {
    const list = splits || [];
    if (!list.length) return null;
    const future = list.find(s => { const t = splitMs(s); return t != null && t >= now; });
    return future || list[list.length - 1];
};

/** 画面で「代表」として出す便。検査リストのタグや現場マップはこれを使う。 */
export const primarySplit = (arrival, now = Date.now()) => nextSplit(splitsOf(arrival), now);

/**
 * まだ来ていない便が残っているか。
 * ⚠これが true の間は「これから物が来る」ので、到着予定の棚から外してはいけない。
 *   分納で1便目を検査し始めた途端に棚から消えると、2便目がこれから来ることが誰にも見えなくなる。
 * ⚠日時が読めない便は「まだ来ていない」とは数えない(いつ来るか分からない物で棚を埋めない)。
 */
export const hasPendingArrival = (arrival, now = Date.now()) =>
    splitsOf(arrival).some(s => { const t = splitMs(s); return t != null && t >= now; });

/** 何便目まで着いたか。「2/4便 到着ずみ」の表示に使う。 */
export const arrivedCount = (splits, now = Date.now()) =>
    (splits || []).filter(s => { const t = splitMs(s); return t != null && t < now; }).length;

/**
 * 入力の検算。
 * ⚠台数を超える分納は止める(合計が台数と違うと、検査側が何台来るのか分からなくなる)。
 * ⚠足りないのは止めない(まだ決まっていない分を後から足せるようにする)。ただし画面には出す。
 */
export const validateSplits = (splits, quantity) => {
    const list = (splits || []).map(normalize);
    const filled = list.filter(s => s.time);
    const total = splitTotalQty(filled);
    const q = num(quantity);
    if (!filled.length) return { ok: false, total: 0, quantity: q, over: 0, short: q, reason: '時間を1つも入れていません' };
    if (filled.length > MAX_SPLITS) return { ok: false, total, quantity: q, over: 0, short: 0, reason: `分けられるのは ${MAX_SPLITS}回 までです` };
    if (filled.some(s => !s.qty)) return { ok: false, total, quantity: q, over: 0, short: 0, reason: '台数が入っていない行があります' };
    // ⚠同じ日時が2行あると、どちらが本当か分からない
    const seen = new Set();
    for (const s of filled) {
        const k = `${s.date}T${s.time}`;
        if (seen.has(k)) return { ok: false, total, quantity: q, over: 0, short: 0, reason: '同じ日時が2つあります' };
        seen.add(k);
    }
    if (q && total > q) return { ok: false, total, quantity: q, over: total - q, short: 0, reason: `合計 ${total}台 が この指図の ${q}台 を超えています` };
    return { ok: true, total, quantity: q, over: 0, short: q ? Math.max(0, q - total) : 0, reason: '' };
};

/** 「9:00×2台 / 12:00×1台 / 17:00×1台」。画面と印刷で同じ書き方にする。 */
export const formatSplits = (splits, { max = 4, withDate = false } = {}) => {
    const list = splits || [];
    if (!list.length) return '';
    const one = (s) => `${withDate && s.date ? `${String(s.date).slice(5).replace('-', '/')} ` : ''}${s.time}×${s.qty}台`;
    if (list.length <= max) return list.map(one).join(' / ');
    return `${list.slice(0, max).map(one).join(' / ')} ほか${list.length - max}件`;
};

/** 1行の要約。「4台を3回に分けて / 次は 12:00 に1台」 */
export const arrivalSummaryLine = (arrival, now = Date.now()) => {
    const list = splitsOf(arrival);
    if (!list.length) return '';
    if (list.length === 1) return `${list[0].time}${list[0].qty ? ` に ${list[0].qty}台` : ''}`;
    const nx = nextSplit(list, now);
    return `${splitTotalQty(list)}台を${list.length}回に分けて（次は ${nx ? `${nx.time} に ${nx.qty}台` : '—'}）`;
};

/**
 * 保存する形を1箇所で作る。
 * ⚠date/time は **一番早い便**。ここを変えると古い画面が別の日時を読む。
 * ⚠全台がそろう1便なら splits を付けない(今までのデータと同じ形のままにする)。
 * ⚠1便でも「一部だけ」で台数が書いてあるなら、その台数を残す(省略すると ロット総数 として読まれる)。
 */
// ⚠templateName = 組立が選んだ検査手順(テンプレート)の名前。
//   到着予定の履歴に指図と型式しか残らず「どの手順の物か」が後から分からなかったので足した。
//   ⚠名前を引けない時は空のまま。lot.templateId から勝手に名前を作らない(元データに無い値を作らない)。
export const buildArrivalDoc = ({ lot = {}, templateName = '', splits, by = '', group = '', viaReq = '', now = Date.now() } = {}) => {
    const list = (splits || []).map(normalize).filter(s => s.time).sort(byTime)
        .map(s => ({ ...s, by: s.by || by, at: s.at || now }));
    const head = list[0] || null;
    const doc = {
        orderNo: String(lot.orderNo || ''),
        model: String(lot.model || ''),
        quantity: num(lot.quantity),
        dueDate: String(lot.dueDate || ''),
        templateId: String(lot.templateId || ''),
        templateName: String(templateName || ''),
        date: head ? head.date : '',
        time: head ? head.time : '',
        by: String(by || ''),
        group: String(group || ''),
        viaReq: String(viaReq || ''),
        at: now,
    };
    // splits を残すかどうか。⚠「分納をやめた」時は空配列で消さないと残り続ける。
    //   ① 2便以上            … 今までどおり残す
    //   ② 1便で 台数が書いてあり、ロットの総数と違う … 残す
    //      (省略すると splitsOf が quantity=ロット総数 を その便の台数として読み、2/6台 が 6/6台 に増える)
    //   ③ それ以外(全台そろう1便 / 台数を書いていない1便) … 今までどおり作らない
    //   🚨 ③の「台数を書いていない1便」を②に入れてはいけない。
    //     連絡ポータルで分納にせず答える道は qty 0 で来るので、0台 と読まれてしまう。
    const headQty = head ? num(head.qty) : 0;
    const lotQty = num(lot.quantity);
    if (list.length > 1 || (headQty > 0 && headQty !== lotQty)) doc.splits = list;
    else doc.splits = [];   // 空配列 = 分納なし。undefined にすると前の分納が消えない
    return doc;
};

/**
 * 「いつ来るか」の判定(arrivalWhenOf)に渡す形。
 * ⚠分納で1便目が着いた後、保存されている date/time(=一番早い便)のまま判定すると
 *   まだ2便目・3便目が来ていないのに「⚠予定を過ぎた」になる。**次の便**に置き換えて渡す。
 * ⚠ここで新しい判定を書かない。contactBoard の arrivalWhenOf をそのまま使うための入れ替えだけ。
 */
export const arrivalForWhen = (arrival, now = Date.now()) => {
    const list = splitsOf(arrival);
    if (list.length <= 1) return arrival;
    const nx = nextSplit(list, now);
    return nx ? { ...arrival, date: nx.date, time: nx.time } : arrival;
};

/** 終了予定を計算する基準の時刻。⚠全部そろってから終わるので **最後の便**。 */
export const finishBaseMs = (arrival, now = Date.now()) => {
    const list = splitsOf(arrival);
    if (!list.length) return null;
    const ms = splitMs(list[list.length - 1]);
    return ms == null ? null : ms;
};

/** 画面の初期値。今までの1件を1行目に入れて、そこから増やせるようにする。 */
export const draftFromArrival = (arrival, { todayStr = '', quantity = 0 } = {}) => {
    const list = splitsOf(arrival);
    if (list.length) return list.map(s => ({ date: s.date || todayStr, time: s.time, qty: s.qty || 0 }));
    return [{ date: todayStr, time: '', qty: num(quantity) }];
};

/**
 * 便を1つ足す。🚨 合計がもう指図の台数に達していれば、いちばん台数の多い便から1台を新しい便へ移す。
 *   清水さん(2026-09-08)「(分納を)中々使ってくれない」→ 写しで実測すると、便を足しても1便目の台数が
 *   減らないので合計が台数を超えて赤字になり、手で − を押して直すまで送れなかった。
 *   「足す」だけのつもりが必ず2手かかる = これが使われない一番の理由。
 * ⚠ 人が台数を触った便(touched)からは移さない(人が入れた数に逆らわない)。
 * ⚠ 移せる便が無い(全部1台・全部人が触った)時はそのまま足す。超過は validateSplits が今までどおり赤にする。
 * ⚠ MAX_SPLITS を超えたら何もしない。
 */
export const addSplitRow = (rows, quantity, { touched = new Set(), date = '' } = {}) => {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length >= MAX_SPLITS) return list;
    const q = num(quantity);
    const total = list.reduce((n, r) => n + num(r && r.qty), 0);
    const last = list[list.length - 1];
    const fresh = { date: (last && last.date) || date || '', time: '', qty: 1 };
    if (!q || total < q) return [...list, fresh];
    let idx = -1; let max = 1;
    list.forEach((r, i) => { const v = num(r && r.qty); if (!touched.has(i) && v > max) { max = v; idx = i; } });
    if (idx < 0) return [...list, fresh];
    return [...list.map((r, i) => (i === idx ? { ...r, qty: num(r.qty) - 1 } : r)), fresh];
};
