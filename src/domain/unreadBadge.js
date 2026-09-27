// 「見たら消える」未読バッジ。
//
// ⚠⚠ 決めごと(2026-07-31 清水さん): **画面に出す数字と、アプリアイコン(タスクバー)の数字は必ず同じにする**。
//   アイコンに数字が出ている ＝ 新しい連絡が来た ＝ 見に行く。
//   見たら消える ＝ もう見るものは無い。
//   なので数えるのは「やることの残り件数」ではなく **前に見た時より後に届いたもの(＝新着)** 。
//   やることの残り(返事待ちなど)は数字バッジにしない(消えない数字を出すと、数字の意味が2種類になって信用されなくなる)。
//
// ⚠ レーンは重ならないようにする。同じ連絡を2つのレーンで数えると、
//   タブのバッジを足した数 ≠ アイコンの数 になって「同じ数」の約束が崩れる。

// 数字バッジを出すレーン。arr(到着の返事)/now(検査の今) は新着そのものが無いので出さない。
export const UNREAD_LANES = ['todo', 'done', 'finish'];

export const LANE_LABEL = {
    todo: '返事をお願いします',
    done: '検査完了',
    finish: '終了予定',
};

// ---- 既読時刻の入れ物 ----------------------------------------------------
// 形: { [グループ名]: { [レーン]: 既読にした時刻ms } }
//   班ごとに分ける(ポータルは班を切り替えられる。他の班の既読を持ち込まない)。

export const parseSeen = (raw) => {
    if (!raw) return {};
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (e) {
        return {}; // 壊れていたら「まだ何も見ていない」に倒す(落とさない)
    }
};

export const seenOf = (map, group, lane) => {
    const v = map && map[group || ''] && map[group || ''][lane];
    return Number.isFinite(v) ? v : 0;
};

// 既読時刻を1つ更新した新しい入れ物を返す(元は書き換えない)。
export const withSeen = (map, group, lane, ms) => {
    const g = group || '';
    const prev = (map && map[g]) || {};
    // ⚠時刻は前に進めるだけ。古い時刻で上書きすると、既に読んだものが未読に戻る。
    if (Number.isFinite(prev[lane]) && prev[lane] >= ms) return map || {};
    return { ...(map || {}), [g]: { ...prev, [lane]: ms } };
};

// この端末で初めて開いた班は「今」を既読の起点にする。
//   ⚠これが無いと、過去の連絡が全部未読になってアイコンに何十件と出る(そして誰も見なくなる)。
export const initSeen = (map, group, lanes, now) => {
    const g = group || '';
    if (map && map[g]) return map || {};
    const fresh = {};
    (lanes || UNREAD_LANES).forEach(l => { fresh[l] = now; });
    return { ...(map || {}), [g]: fresh };
};

// ---- 新着の数え方 --------------------------------------------------------

// seenMs より後に届いたものだけ数える。時刻が無いものは数えない(いつ来たか分からない＝新着と言えない)。
export const countNew = (items, seenMs, atOf) => {
    const s = Number.isFinite(seenMs) ? seenMs : 0;
    const at = atOf || ((x) => (x && x.at) || 0);
    let n = 0;
    (items || []).forEach(it => {
        const t = Number(at(it)) || 0;
        if (t > s) n += 1;
    });
    return n;
};

// レーンごとの新着件数。画面のバッジはこの数をそのまま出す。
export const laneCounts = ({ map, group, todo, done, finish, atOf }) => ({
    todo: countNew(todo, seenOf(map, group, 'todo'), atOf && atOf.todo),
    done: countNew(done, seenOf(map, group, 'done'), atOf && atOf.done),
    finish: countNew(finish, seenOf(map, group, 'finish'), atOf && atOf.finish),
});

// アプリアイコンに出す数 = 画面のバッジの合計。ここがズレたら約束が壊れる。
export const totalNew = (counts) => UNREAD_LANES.reduce((n, l) => n + (Number(counts && counts[l]) || 0), 0);

// タブの id からレーンを引く。到着の返事/検査の今 は数字バッジを持たない。
export const laneOfTab = (tabId) => (UNREAD_LANES.includes(tabId) ? tabId : null);
