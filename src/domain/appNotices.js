// 「アプリを直したよ」を、開いた人に **1回だけ** 見せるお知らせ。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   置き場所は要望箱と同じ **contact-shared-v1 の app_notices**(4アプリ共通の棚)。
//   同じ更新のお知らせを4回書かせない。誰に見せるかは中身の `targets` で決める。
//
// 清水さん(2026-08-01):「今アプリ直すとみんなにお知らせもしたいから、
//   アプリ開いたら一回だけ相手に更新したお知らせを見れるようにしてほしいな」
//
// ⚠「1回だけ」は **端末ごと** に覚える(localStorage)。共有の棚に「読んだ」を書くと、
//   誰か1人が読んだ瞬間に他の全員から消える(多端末の落とし穴・2026-07-17の教訓と同じ)。
//
// ⚠ここは純粋な計算だけ(画面と保存はここに書かない)。

export const NOTICE_COL = 'app_notices';
export const NOTICE_SEEN_LS_KEY = 'appNoticeSeen';
export const NOTICE_SEEN_MAX = 200; // 覚えておく上限(古いものから捨てる)

// 誰に見せるか。⚠'all' は「この4アプリ全部」。増やす時はラベルも必ず足す。
export const NOTICE_TARGETS = [
    { id: 'product', label: '製品検査' },
    { id: 'final', label: '最終検査' },
    { id: 'portal', label: '組立ポータル' },
];
export const NOTICE_TARGET_IDS = NOTICE_TARGETS.map(t => t.id);
export const noticeTargetLabel = (id) => (id === 'all' ? 'ぜんぶ' : (NOTICE_TARGETS.find(t => t.id === id)?.label || id));

/** その端末が今どこを見ているか → 対象の名前。 */
export const audienceOf = ({ app, side }) => (side === 'portal' ? 'portal' : String(app || ''));

// ============================================================ 📷 画像
// 清水さん(2026-08-10):「更新した部分を相手に知らせるために画像を追加できるようにしてほしい」
//
// ⚠⚠ 画像は **お知らせのドキュメントに直接** 入れる(別置きにしない)。
//   理由: お知らせは数が少なく寿命も短い。ロットの写真(何百枚・1年残る)とは事情が違う。
//   代わりに **入る量を必ず数えて止める**。Firestore の1ドキュメントは 1MB が上限で、
//   超えると保存が丸ごと落ちる(2026-07-26 に実際に踏んだ。浅く数えて 1024KB を 139KB と
//   誤認した事故もある)。→ ここでは **保存される文字数そのもの** を数える。
//   base64 は ASCII なので「文字数 = バイト数」。推定しない。
export const NOTICE_IMAGE_MAX_COUNT = 4;      // 1件のお知らせに付けられる枚数
export const NOTICE_IMAGE_BUDGET = 700 * 1024; // 画像に使ってよい合計(本文・題名の余白を残す)

/** お知らせの画像一覧。⚠壊れていても画面を止めない(空に倒す)。 */
export const noticeImagesOf = (n) => {
    const list = (n && Array.isArray(n.images)) ? n.images : [];
    return list
        .filter(im => im && typeof im.src === 'string' && im.src.startsWith('data:image/'))
        .map(im => ({ src: im.src, caption: String(im.caption || '') }));
};

/** 保存されるバイト数(= 文字数)。data URI は ASCII なのでそのまま数えてよい。 */
export const noticeImageBytes = (images) =>
    (images || []).reduce((s, im) => s + String((im && im.src) || '').length + String((im && im.caption) || '').length, 0);

/**
 * もう1枚 足せるか。足せない時は **理由を日本語で** 返す(画面にそのまま出す)。
 * ⚠「保存できませんでした」だけ出すのは禁止。何をどう減らせばいいか分からない。
 */
export const canAddNoticeImage = (images, addBytes) => {
    const cur = images || [];
    if (cur.length >= NOTICE_IMAGE_MAX_COUNT) {
        return { ok: false, reason: `画像は ${NOTICE_IMAGE_MAX_COUNT}枚 までです。どれかを消してから足してください。` };
    }
    const after = noticeImageBytes(cur) + Number(addBytes || 0);
    if (after > NOTICE_IMAGE_BUDGET) {
        const kb = (v) => `${Math.round(v / 1024)}KB`;
        return { ok: false, reason: `画像の合計が大きすぎます（${kb(after)} / 上限 ${kb(NOTICE_IMAGE_BUDGET)}）。枚数を減らすか、写す範囲を狭くしてください。` };
    }
    return { ok: true };
};

export const buildNotice = ({ title, body, targets, by, now, id, until, images, fromDraft }) => {
    const ts = Array.isArray(targets) ? targets.filter(t => t === 'all' || NOTICE_TARGET_IDS.includes(t)) : [];
    return {
        id: id || `nt-${now}-${Math.random().toString(36).slice(2, 8)}`,
        title: String(title || '').trim(),
        body: String(body || '').trim(),
        images: noticeImagesOf({ images }),
        // ⚠空だと「誰にも出ない」お知らせが出来上がる。書いたのに誰も見ていない、が一番困る。
        targets: ts.length ? [...new Set(ts)] : ['all'],
        by: String(by || '').trim(),
        // どの下書きから出したか(空でよい)。⚠同じ下書きを二度出さないための目印。
        fromDraft: String(fromDraft || ''),
        active: true,
        until: Number(until) || 0,   // 0 = 期限なし
        createdAt: now,
        updatedAt: now,
    };
};

export const canSubmitNotice = (draft) => String((draft && draft.title) || '').trim().length > 0;

/** 今この人に出してよいお知らせか。 */
export const noticeApplies = (n, { app, side, now }) => {
    if (!n || n.active === false) return false;
    if (!String(n.title || '').trim()) return false;
    if (n.until && now > n.until) return false;
    const who = audienceOf({ app, side });
    const ts = Array.isArray(n.targets) ? n.targets : ['all'];
    return ts.includes('all') || ts.includes(who);
};

/** 端末に覚えている「見た」の一覧。⚠壊れていたら空に倒す(画面を止めない)。 */
export const parseSeenNotices = (raw) => {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    } catch (e) { return []; }
};
export const withSeenNotice = (seen, id) => {
    if (!id) return seen || [];
    const list = (seen || []).filter(x => x !== id);
    list.push(id);
    return list.slice(-NOTICE_SEEN_MAX); // ⚠古いものから捨てる。無限に伸ばさない
};
export const hasSeenNotice = (seen, id) => (seen || []).includes(id);

/**
 * 今この画面で出すべきお知らせ。**新しい順**に並べて返す。
 * ⚠一度に何枚も重ねない。呼び出し側は先頭の1件だけ出して、閉じたら次を出す。
 */
export const pendingNotices = ({ rows, seen, app, side, now }) =>
    (rows || [])
        .filter(n => noticeApplies(n, { app, side, now }))
        .filter(n => !hasSeenNotice(seen, n.id))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(a.id).localeCompare(String(b.id)));

/** 管理画面の一覧(新しい順・期限切れも出す=書いた本人が確かめられるように)。 */
export const sortNotices = (rows) => (rows || []).slice()
    .sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0) || String(a?.id || '').localeCompare(String(b?.id || '')));

/** 今 配信中の件数(管理画面の見出し用)。 */
export const liveNoticeCount = (rows, now) => (rows || [])
    .filter(n => n && n.active !== false && String(n.title || '').trim() && !(n.until && now > n.until)).length;

// 入切(4アプリ共通の棚)。⚠既定はON。書いても出ない、を既定にしない。
export const NOTICE_DEFAULTS = Object.freeze({ enabled: true });
export const noticeConfigOf = (shared) => {
    const c = (shared && shared.appNoticeConfig) || {};
    const out = { ...NOTICE_DEFAULTS };
    Object.keys(NOTICE_DEFAULTS).forEach(k => { if (typeof c[k] === 'boolean') out[k] = c[k]; });
    return out;
};
