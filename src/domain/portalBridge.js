// 組立ポータル(③)の中に検査ポータルを iframe で入れている時の、親子の連絡係。
//
// ⚠⚠ このファイルは **製品検査 / 最終検査 / 司令塔(③) の3つで同一**。
//   片方だけ直すと、次に配った時に静かに巻き戻る。直したら3つ全部へ配ること。
//   (③ は src/domain/portalBridge.js に置く)
//
// ── なぜ要るのか ──────────────────────────────────────────────
// 組立の人が見ているのは ③(factory-overview-app) で、その中に製品検査/最終検査の
// 連絡ポータルが iframe で入っている。ここで2つの問題が起きていた。
//
//  ① **数字を書く者が2人いた**。中の検査ポータルも `navigator.setAppBadge()` を呼び、
//     ③ も別の数え方(返事待ち件数)で呼んでいた。どちらが最後に走ったかでアイコンの
//     数字が変わる = 画面の赤い数字と一致しない。
//     → **バッジを持つのは一番外側の1人だけ**。中は数を報告するだけにする。
//
//  ② **見えていない iframe が勝手に既読になる**。`display:none` の iframe でも
//     `document.hidden` は false のままなので、中の画面は「見られている」と判断して
//     既読を付けてしまう。組立が一度も見ていないのに数字が消える。
//     → 親が「あなたは今 表に出ている/いない」を伝える。中はそれを見てから既読にする。
//
// ⚠ここは純粋な計算だけ(window に触らない)。テストできる状態を保つため。

export const BRIDGE_TYPE_UNREAD = 'renraku-unread'; // 子 → 親: 未読の数
export const BRIDGE_TYPE_ACTIVE = 'renraku-active'; // 親 → 子: 表に出ているか

/** 未読のレーン。⚠src/domain/unreadBadge.js の UNREAD_LANES と同じ並びにすること。 */
export const BRIDGE_LANES = ['todo', 'done', 'finish'];

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };

/** iframe の中にいるか。⚠クロスオリジンで top を読むと例外 = その時点で「入れ子」と分かる。 */
export const isEmbedded = (win) => {
    if (!win) return false;
    try { return win.top !== win.self; } catch (e) { return true; }
};

/** 親のオリジン(送り先)。分からなければ null を返す。⚠null の時に '*' で送るかは呼び出し側の判断。 */
export const parentOriginOf = (referrer) => {
    try {
        const o = new URL(String(referrer || '')).origin;
        return (o && o !== 'null') ? o : null;
    } catch (e) { return null; }
};

/** 子 → 親。未読の数だけを渡す(連絡の中身は一切渡さない)。 */
export const buildUnreadMessage = ({ app, group, counts, at }) => {
    const c = {};
    BRIDGE_LANES.forEach(l => { c[l] = num(counts && counts[l]); });
    return {
        type: BRIDGE_TYPE_UNREAD,
        app: String(app || ''),
        group: String(group || ''),
        counts: c,
        total: BRIDGE_LANES.reduce((n, l) => n + c[l], 0), // ⚠合計は必ずここで作る(送り手が別の数を入れられない)
        at: num(at),
    };
};

/** 受け取った中身を検める。形が違えば null(知らない相手の message を混ぜない)。 */
export const parseUnreadMessage = (data) => {
    if (!data || typeof data !== 'object' || data.type !== BRIDGE_TYPE_UNREAD) return null;
    if (!data.app) return null;
    const c = {};
    BRIDGE_LANES.forEach(l => { c[l] = num(data.counts && data.counts[l]); });
    return {
        app: String(data.app),
        group: String(data.group || ''),
        counts: c,
        total: BRIDGE_LANES.reduce((n, l) => n + c[l], 0), // ⚠送られてきた total は信用しない。中身から数え直す
        at: num(data.at),
    };
};

/** 親 → 子。 */
export const buildActiveMessage = (active) => ({ type: BRIDGE_TYPE_ACTIVE, active: !!active });

export const parseActiveMessage = (data) => {
    if (!data || typeof data !== 'object' || data.type !== BRIDGE_TYPE_ACTIVE) return null;
    return { active: !!data.active };
};

/** 送り主が身内かどうか。⚠オリジンで判定する(中身の app 名は誰でも名乗れる)。 */
export const isTrustedOrigin = (origin, urls) => {
    if (!origin) return false;
    const list = Array.isArray(urls) ? urls : Object.values(urls || {});
    return list.some(u => {
        try { return new URL(String(u)).origin === origin; } catch (e) { return false; }
    });
};

/** アプリごとの未読 → アイコンに出す合計。⚠画面に出ている赤い数字の合計と必ず一致させる。 */
export const sumUnread = (byApp) => Object.values(byApp || {})
    .reduce((n, v) => n + num(v && v.total), 0);

/**
 * 既読を付けてよいか。
 *  - 画面が裏に回っている → だめ(見ていないのに消える)
 *  - iframe に入っていて、親から「表に出ている」と言われていない → だめ
 *  - ⚠ただし親が古くて合図を送ってこない場合は、待ちぼうけにせず通す(graceMs 経過後)。
 *    そうしないと、③ を配り忘れた瞬間に「いくら見ても既読にならない」画面になる。
 */
export const canMarkSeen = ({ hidden, embedded, active, heard, sinceMs, graceMs = 8000 }) => {
    if (hidden) return false;
    if (!embedded) return true;
    if (heard) return !!active;
    return (sinceMs || 0) >= graceMs;
};

/**
 * 組立ポータルの見た目。
 *  - 'stacked' = 今まで通り。ヘッダー + 流れの帯 + アプリの入れ方の案内 を積み上げる。
 *  - 'compact' = 1画面。ヘッダー1本にタブを載せ、帯と案内は畳む(押した時だけ開く)。
 *
 * ⚠**既定は 'stacked'**(＝今のまま)。清水さん 2026-08-01:
 *   「相手からは仕事が増えると思われるのは嫌だから、今は機能だけ追加して後から」。
 *   検査アプリの 連絡 → 宛先・公開設定 から ON にした時だけ 'compact' になる。
 *   ⚠共通の棚(contact-shared-v1)に置く = 製品検査/最終検査 どちらから変えても同じ。
 */
export const portalLayoutOf = (shared) => (shared && shared.portalCompact === true ? 'compact' : 'stacked');
