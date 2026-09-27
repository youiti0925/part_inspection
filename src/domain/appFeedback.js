// 現場からの「こうしてほしい」を受け取る箱。
//
// ⚠⚠ 置き場所は **contact-shared-v1 の app_feedback**。4アプリ共通の棚に入れる。
//   理由: アプリごとに分けると、見る場所が4つになって結局どれも見なくなる。
//   どのアプリから出したかは中身の `app` で分かる。
//
// ⚠ここは純粋な計算だけ(画面と保存はここに書かない)。テストできる状態を保つため。

export const FEEDBACK_COL = 'app_feedback';

// 種類。増やすときは必ずラベルも足す(idだけ増えると画面に「undefined」が出る)。
export const FEEDBACK_KINDS = [
    { id: 'add', label: '追加してほしい', hint: 'こんな機能があると助かる', emoji: '➕' },
    { id: 'fix', label: '直してほしい', hint: 'おかしい・使いにくい・間違っている', emoji: '🔧' },
];
export const FEEDBACK_KIND_IDS = FEEDBACK_KINDS.map(k => k.id);
export const feedbackKindOf = (id) => FEEDBACK_KINDS.find(k => k.id === id) || FEEDBACK_KINDS[0];

// 状態。⚠「見送り」を用意する。出したのに何の返事も無い状態が一番やる気を削ぐ。
export const FEEDBACK_STATUS = [
    { id: 'open', label: '未対応', color: 'rose' },
    { id: 'doing', label: '対応中', color: 'amber' },
    { id: 'done', label: '対応済み', color: 'emerald' },
    { id: 'wont', label: '見送り', color: 'slate' },
];
export const FEEDBACK_STATUS_IDS = FEEDBACK_STATUS.map(s => s.id);
export const feedbackStatusOf = (id) => FEEDBACK_STATUS.find(s => s.id === id) || FEEDBACK_STATUS[0];
export const isOpenFeedback = (r) => !r || r.status === 'open' || r.status === 'doing' || !r.status;

export const APP_LABEL = {
    product: '製品検査', final: '最終検査', parts: '部品検査', overview: '司令塔',
};
export const appLabelOf = (id) => APP_LABEL[id] || id || '';

// 送信できるか。⚠本文が空のまま送れると、誰も読めない空の要望が溜まる。
export const canSubmitFeedback = (draft) => {
    const t = String((draft && draft.text) || '').trim();
    return t.length > 0 && FEEDBACK_KIND_IDS.includes((draft && draft.kind) || '');
};

// 保存する形を1箇所で作る。⚠undefined を混ぜない(Firestoreが受け取らない)。
export const buildFeedback = ({ kind, text, where, by, app, side, now, id }) => ({
    id: id || `fb-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: FEEDBACK_KIND_IDS.includes(kind) ? kind : 'add',
    text: String(text || '').trim(),
    where: String(where || '').trim(),
    by: String(by || '').trim(),
    app: String(app || ''),
    side: side === 'portal' ? 'portal' : 'app',
    status: 'open',
    reply: '',
    hidden: false,   // みんなの一覧から隠す(まずい書き込みへの逃げ道)
    comments: {},    // やりとり。⚠**配列にしない**(下の理由)
    agrees: {},      // 「同じこと思ってた」
    createdAt: now,
    updatedAt: now,
});

// ============================================================================
//  やりとり(コメント)
// ----------------------------------------------------------------------------
// ⚠⚠ **配列で持たない。キー付きの入れ物(map)にする。**
//   配列に足す書き方だと「読んで→足して→丸ごと書き戻す」になり、2人が同時に書いた時に
//   後から保存した方の中身で上書きされ、片方の書き込みが黙って消える(実際にやった)。
//   map なら `comments.<id>` だけを書くので、同時に書いても両方残る。
// ⚠Firestore の setDoc(merge:true) は map を **合体** する。だから1件だけ送ればよい。
// ============================================================================
export const buildComment = ({ text, by, app, admin, now, id }) => ({
    id: id || `c-${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: String(text || '').trim(),
    by: String(by || '').trim(),
    app: String(app || ''),
    admin: !!admin,      // 管理グループからの返事(名前を伏せる設定でも「管理グループ」と出す)
    at: now,
});

/** 1件のやりとりを古い順に。⚠同時刻は id で決める(並びが毎回入れ替わると読めない)。 */
export const commentsOf = (row) => {
    const m = (row && row.comments && typeof row.comments === 'object' && !Array.isArray(row.comments)) ? row.comments : {};
    const out = Object.entries(m)
        .map(([k, v]) => (v && typeof v === 'object' ? { ...v, id: v.id || k } : null))
        .filter(c => c && String(c.text || '').trim());
    // 旧データ: 管理側が1行だけ書けた `reply` は、最初の返事として混ぜる(消さない)
    if (row && String(row.reply || '').trim()) {
        out.push({ id: '__reply', text: String(row.reply).trim(), by: '', admin: true, at: row.updatedAt || row.createdAt || 0, legacy: true });
    }
    return out.sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id)));
};
export const commentCount = (row) => commentsOf(row).length;

/** 送れるか。⚠空の返事を残せると、通知だけ飛んで中身が無い、が起きる。 */
export const canSubmitComment = (text) => String(text || '').trim().length > 0;

// ============================================================================
//  「同じこと思ってた」(賛同)
// ----------------------------------------------------------------------------
// ⚠数ではなく **誰が押したか** を持つ。数だけだと、押し直しで増え続ける/多端末で二重に増える。
// ⚠鍵は端末ごとに作る。名前は任意入力なので、名前だけを鍵にすると同名の別人が上書きし合う。
// ============================================================================
export const agreeKeyOf = (deviceId, name) => {
    const d = String(deviceId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const n = String(name || '').trim().slice(0, 20);
    return `${d || 'x'}__${n}`.replace(/[.#$[\]/]/g, '_'); // ⚠Firestore のキーに使えない文字を落とす
};
export const agreesOf = (row) => {
    const m = (row && row.agrees && typeof row.agrees === 'object' && !Array.isArray(row.agrees)) ? row.agrees : {};
    return Object.entries(m).map(([k, v]) => ({ key: k, by: (v && v.by) || '', at: (v && v.at) || 0 }));
};
export const agreeCount = (row) => agreesOf(row).length;
export const hasAgreed = (row, key) => !!(key && row && row.agrees && row.agrees[key]);

/**
 * 押す/取り消すの保存内容を作る。
 * ⚠取り消しは「送らない」では消えない(merge:true は送らなかったキーを残す)。
 *   `__deleteMapKeys` で「このキーを消す」と明示する。2026-07-26 の是正と同じ理由。
 */
export const toggleAgreePatch = (row, key, by, now) => {
    if (!key) return null;
    if (hasAgreed(row, key)) return { __deleteMapKeys: { agrees: [key] }, updatedAt: now };
    return { agrees: { [key]: { by: String(by || '').trim(), at: now } }, updatedAt: now };
};

// ============================================================================
//  見せ方の設定(4アプリ共通の棚 contact-shared-v1/settings/config)
// ----------------------------------------------------------------------------
// 清水さん(2026-08-01):「各種機能はＯＮＯＦＦできるようにしてほしい、何かあったら見えなくしないとだめだから」
// ⚠既定で **名前は出さない**。誰が書いたかが全員に見えると、本当に困っていることほど書けなくなる。
//   管理グループの画面では今までどおり名前が見える(聞き返せないと困るため)。
// ============================================================================
export const FEEDBACK_DEFAULTS = Object.freeze({
    enabled: true,      // 要望箱そのもの
    board: true,        // みんなに一覧を見せる
    comments: true,     // やりとり(返事を書ける)
    agree: true,        // 「同じこと思ってた」
    showNames: false,   // 一覧に名前を出す(既定=出さない)
    portal: true,       // 組立ポータルからも出せる
});
export const feedbackConfigOf = (shared) => {
    const c = (shared && shared.appFeedbackConfig) || {};
    const out = { ...FEEDBACK_DEFAULTS };
    Object.keys(FEEDBACK_DEFAULTS).forEach(k => { if (typeof c[k] === 'boolean') out[k] = c[k]; });
    return out;
};

/** みんなに見せる一覧。⚠隠した1件は管理グループ以外には出さない。 */
export const boardFeedback = (rows, { admin = false } = {}) =>
    (rows || []).filter(r => r && (admin || !r.hidden));

/** 画面に出す名前。⚠設定で伏せている時に、うっかり素の `by` を出さないための唯一の入口。 */
export const displayNameOf = (byName, { admin = false, showNames = false, isAdminPost = false } = {}) => {
    if (isAdminPost) return '管理グループ';
    const n = String(byName || '').trim();
    if (!n) return '名前なし';
    if (admin || showNames) return n;
    return '現場の方';
};

// 一覧のしぼり込み。
//   ⚠'active'(=まだ終わっていない: 未対応+対応中) と 'open'(=未対応だけ) は**別物**。
//     ここを同じ id にすると、ボタンが2つとも同じ絞り込みになり、件数だけ違って見える(実際にやった)。
export const FEEDBACK_FILTER_ACTIVE = 'active';
export const filterFeedback = (rows, { status, kind, app, q } = {}) => {
    const s = String(q || '').trim().toLowerCase();
    return (rows || []).filter(r => {
        if (!r) return false;
        if (status && status !== 'all') {
            if (status === FEEDBACK_FILTER_ACTIVE) { if (!isOpenFeedback(r)) return false; }
            else if ((r.status || 'open') !== status) return false;
        }
        if (kind && kind !== 'all' && r.kind !== kind) return false;
        if (app && app !== 'all' && r.app !== app) return false;
        if (s && !`${r.text || ''} ${r.where || ''} ${r.by || ''}`.toLowerCase().includes(s)) return false;
        return true;
    });
};

// 新しい順。⚠同時刻は id で決める(並びが毎回入れ替わると読めない)。
export const sortFeedback = (rows) => (rows || []).slice().sort((a, b) =>
    (b?.createdAt || 0) - (a?.createdAt || 0) || String(a?.id || '').localeCompare(String(b?.id || '')));

// 未対応の件数(画面の見出しに出す)。
export const openFeedbackCount = (rows) => (rows || []).filter(isOpenFeedback).length;
