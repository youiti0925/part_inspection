// 📦 検査完了の「分納」— 4台のうち今日2台ぶんだけ完了を知らせる。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//
// 清水さん(2026-08-01):「組立アプリで分納の機能追加したと思うけど、検査完了も分納したいなって思う」
//   → 到着予定の分納(arrivalSplits.js)と同じ考え方を、完了の知らせ側にも入れる。
//
// ⚠⚠ **数を持たない。送った1件1件を持つ。**
//   「もう何台送ったか」を数値で持つと、2人が同時に送った時に後から保存した方の数で
//   上書きされ、送ったはずの分が消える(要望箱の やりとり と同じ理由)。
//   → `parts` はキー付きの入れ物(map)。合計は **毎回そこから数え直す**。
//
// ⚠古いデータ(parts が無い completeNotified)は「全部送り終わった」とみなす。
//   そうしないと、今まで連絡済みだったロットが急に「まだ残っている」に見えて二重送信になる。

/** ロットの台数(既定1)。⚠0台は無い。 */
export const lotQtyOf = (lot) => Math.max(1, Number(lot && lot.quantity) || 1);

/** 送った1件ずつ。⚠配列にしない(同時送信で消える)。 */
export const completePartsOf = (lot) => {
    const cn = lot && lot.completeNotified;
    if (!cn || cn.declined) return [];
    const m = (cn.parts && typeof cn.parts === 'object' && !Array.isArray(cn.parts)) ? cn.parts : null;
    if (!m) {
        // 旧データ: 1回で全部送っていた。台数はロットの台数そのもの。
        if (!cn.at) return [];
        return [{ id: cn.reqId || '__legacy', qty: lotQtyOf(lot), at: cn.at, by: cn.by || '', group: cn.group || '', legacy: true }];
    }
    return Object.entries(m)
        .map(([k, v]) => (v && typeof v === 'object' ? { ...v, id: v.id || k } : null))
        .filter(p => p && Number(p.qty) > 0)
        .sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id)));
};

/** これまでに知らせた台数。⚠保存された数値は使わない。毎回 parts から数え直す。 */
export const sentQtyOf = (lot) => completePartsOf(lot).reduce((s, p) => s + (Number(p.qty) || 0), 0);

/** まだ知らせていない台数。 */
export const remainingQtyOf = (lot) => Math.max(0, lotQtyOf(lot) - sentQtyOf(lot));

/** 全部知らせ終わったか。 */
export const isFullyNotified = (lot) => remainingQtyOf(lot) <= 0;

/** 「連絡しない」を選んだか。 */
export const isDeclined = (lot) => !!(lot && lot.completeNotified && lot.completeNotified.declined);

/** 一部だけ知らせている途中か(画面で「残りN台」を出すため)。 */
export const isPartiallyNotified = (lot) => sentQtyOf(lot) > 0 && !isFullyNotified(lot);

/**
 * 送れるか。
 * ⚠**残りを超える台数は送れない**。相手が受け取る台数の合計が指図の台数を超えてしまう。
 * ⚠0台や負の数も送れない(中身の無い連絡が残る)。
 */
export const canSendComplete = (lot, qty) => {
    const n = Math.floor(Number(qty) || 0);
    if (n <= 0) return { ok: false, reason: '台数を1以上にしてください' };
    const rest = remainingQtyOf(lot);
    if (rest <= 0) return { ok: false, reason: 'この指図はもう全部連絡しています' };
    if (n > rest) return { ok: false, reason: `残りは ${rest}台 です（${n}台は送れません）` };
    return { ok: true, reason: '' };
};

/** 送る1件。⚠undefined を混ぜない(Firestoreが受け取らない)。 */
export const buildCompletePart = ({ id, qty, by, group, now }) => ({
    id: String(id || ''),
    qty: Math.max(1, Math.floor(Number(qty) || 1)),
    by: String(by || ''),
    group: String(group || ''),
    at: Number(now) || 0,
});

/**
 * ロットに書き戻す中身。
 * ⚠`parts` の **1件だけ**を送る。merge:true が既存の他の便を残すので、同時送信でも両方残る。
 * ⚠旧データ(parts が無い)から分納へ移る時は、旧1件を parts の中に移してから足す
 *   (移さないと completePartsOf が旧データを見なくなり、送った分が消える)。
 */
export const completeNotifyPatch = (lot, part) => {
    const cn = (lot && lot.completeNotified) || {};
    const hadMap = !!(cn.parts && typeof cn.parts === 'object' && !Array.isArray(cn.parts));
    const parts = { [part.id]: part };
    if (!hadMap && cn.at && !cn.declined) {
        // 旧1件を引き継ぐ。⚠キーは reqId(無ければ '__legacy')。
        const k = cn.reqId || '__legacy';
        parts[k] = { id: k, qty: lotQtyOf(lot), at: cn.at, by: cn.by || '', group: cn.group || '' };
    }
    return {
        completeNotified: {
            // 一番新しい1件を今までどおり直下にも置く。古い画面はここしか見ていない。
            at: part.at, by: part.by, group: part.group, reqId: part.id,
            declined: false,
            parts,
        },
    };
};

/** 相手に届く文。⚠分納の時は「4台のうち2台」と必ず書く(何台ぶんの話か分からないと動けない)。 */
export const completeMessage = ({ model, qty, total, sentBefore }) => {
    const head = model ? `${model} ` : '';
    if (!total || qty >= total) return `${head}検査が完了しました${total ? `（${total}台）` : ''}`;
    const done = (Number(sentBefore) || 0) + Number(qty);
    return `${head}検査が完了しました（${total}台のうち ${qty}台・これまで ${done}/${total}台）`;
};

/** 画面の見出し。「残り2台」を出す。 */
export const completeStatusLabel = (lot) => {
    if (isDeclined(lot)) return '連絡しない';
    const total = lotQtyOf(lot);
    const sent = sentQtyOf(lot);
    if (sent <= 0) return '未連絡';
    if (sent >= total) return `連絡済み（${total}台）`;
    return `${sent}/${total}台 連絡済み（残り ${total - sent}台）`;
};
