// ============================================================================
// 👀 誰がいつ手本を見たか（教育の記録）
// ----------------------------------------------------------------------------
// 清水さん(2026-08-15) 市場調査の⑤を採用。
//   手順書ツール10社中9社が持つ市場の常識機能。ISO/IATFの力量管理で使われる。
//
// ⚠⚠⚠ **人の評価には絶対に使わない。**
//   査定・成績・力量マップのレベルへ **自動で反映しない**。
//   見張られていると感じた瞬間に現場は動画を開かなくなり、手本そのものが死ぬ。
//   ここが出すのは「この工程の手本を見た人」までで、**そこから先は人が判断する**。
//   → だからこの入れ物には **点数も合否も入れない**。見た事実と時刻だけ。
//
// ⚠⚠ **「開いた」を「見た」にしない。**
//   前例: display:none の iframe でも document.hidden は false になり、
//   誰も見ていないのに既読が付いた(2026-08-01)。
//   → **再生が実際に進んだ秒**で数える。開いただけ・止めたままは数えない。
//
// ⚠⚠ **配列に足さない。** 多端末で同時に見られるので、読んで書き足す形は
//   後勝ちで相手の記録を消す。**人ごとの鍵**にする(2026-07-17 の教訓)。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const txt = (v) => String(v == null ? '' : v).trim();

/** 「見た」と数える最低の秒数。⚠短すぎると開いただけで既読になる。 */
export const WATCHED_MIN_SEC = 10;
/** 動画が短い時は、この割合まで見たら「見た」。⚠15秒の手本で10秒は厳しすぎる。 */
export const WATCHED_MIN_RATIO = 0.5;

/**
 * この人は「見た」と言えるか。
 * @param playedSec  **再生が実際に進んだ秒**（開いていた時間ではない）
 * @param durationSec 動画の長さ
 */
export const isWatched = (playedSec, durationSec = 0) => {
  const p = num(playedSec, 0), d = num(durationSec, 0);
  if (p <= 0) return false;
  const need = d > 0 ? Math.min(WATCHED_MIN_SEC, d * WATCHED_MIN_RATIO) : WATCHED_MIN_SEC;
  return p >= need - 1e-6;
};

/**
 * 人の鍵。⚠名前をそのまま鍵にすると、Firestore で使えない字(. / [ ] # $)で壊れる。
 * ⚠空の名前は鍵にしない(誰の記録か分からない物を残さない)。
 */
export const watcherKey = (name) => {
  const s = txt(name).replace(/[.[\]#$/\s]+/g, '_');
  return s ? `w_${s.slice(0, 40)}` : '';
};

/**
 * 「見た」を書く差分。⚠**人ごとの鍵に、その人の分だけ**書く。
 * @returns null なら書かない(見たと言えない / 名前が無い)
 *
 * ⚠⚠ 同じ人が何度見ても **1件のまま**（回数と最後に見た日を更新するだけ）。
 *   毎回足すと Firestore の1MBにいずれ当たる。
 */
export const watchPatch = (log, name, { playedSec, durationSec = 0, nowMs = 0 } = {}) => {
  const key = watcherKey(name);
  if (!key) return null;
  if (!isWatched(playedSec, durationSec)) return null;
  const prev = (log && log[key]) || {};
  return {
    watch: {
      [key]: {
        name: txt(name).slice(0, 40),
        // ⚠初めて見た日は上書きしない(教育の記録として「いつ教えたか」が要る)
        firstAt: num(prev.firstAt, 0) || num(nowMs, 0),
        lastAt: num(nowMs, 0),
        times: num(prev.times, 0) + 1,
        // 参考。⚠「何秒見たか」は最長の1回だけ持つ(足すと現実離れした数字になる)
        maxSec: Math.max(num(prev.maxSec, 0), Math.round(num(playedSec, 0))),
      },
    },
  };
};

/** 見た人の並び。⚠新しく見た順。 */
export const watchers = (log) => {
  const src = (log && typeof log === 'object') ? log : {};
  return Object.entries(src)
    .filter(([, v]) => v && !v.deleted && txt(v.name))
    .map(([key, v]) => ({ key, name: txt(v.name), firstAt: num(v.firstAt, 0), lastAt: num(v.lastAt, 0), times: num(v.times, 0), maxSec: num(v.maxSec, 0) }))
    .sort((a, b) => b.lastAt - a.lastAt);
};

/**
 * 画面に出す一言。
 * ⚠⚠ **「まだ見ていない人」を名指ししない。** 名指しは追い立てになり、
 *   現場が嫌がって機能ごと死ぬ。出すのは「見た人」と件数だけ。
 * ⚠0件の時は「誰も見ていない」ではなく **「まだ記録がありません」**
 *   (見ていない証明にはならない。記録が始まる前に見た人がいる)。
 */
export const watchNote = (log) => {
  const list = watchers(log);
  if (!list.length) return 'まだ見た記録がありません（記録は今日から貯まります）。';
  const names = list.slice(0, 3).map(w => w.name).join('・');
  return list.length <= 3
    ? `${list.length}人が見ました（${names}）`
    : `${list.length}人が見ました（${names} ほか${list.length - 3}人）`;
};

/**
 * その人が見たか。⚠**「見ていない＝できない」ではない**ので、
 *   呼び元は「未受講」のような言葉を使わないこと。
 */
export const hasWatched = (log, name) => {
  const key = watcherKey(name);
  return !!(key && log && log[key] && !log[key].deleted);
};

/**
 * 記録を消す差分（間違えて別の人の名前で見た時など）。
 * ⚠鍵は消せない(merge:true)ので **消した印** を置く。
 */
export const watchDeletePatch = (name) => {
  const key = watcherKey(name);
  return key ? { watch: { [key]: { deleted: true } } } : null;
};

/**
 * 再生が実際に進んだ秒を数える道具。
 * ⚠⚠ 早送り・飛ばしを足さない。`timeupdate` の**進んだ差**だけを足す。
 *   飛ばした分まで足すと、10秒送りを2回押しただけで「見た」になる。
 * ⚠巻き戻し(負)は0扱い。⚠1回の跳びが大きい時は飛ばしとみなして足さない。
 */
export const MAX_STEP_SEC = 2;
export const addPlayed = (playedSec, prevT, nowT) => {
  const d = num(nowT, 0) - num(prevT, 0);
  return num(playedSec, 0) + (d > 0 && d <= MAX_STEP_SEC ? d : 0);
};
