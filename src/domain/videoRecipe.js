// 🎬 エース動画の「レシピ(events)」と「チャプター(chapters)」を読む共通ロジック。
//
// ⚠なぜここに出したか (2026-08-08):
//   区間の解釈 (スキップ/停止/倍速) は VideoRecipeStudio の onTime にしか無かった。
//   §5 の小窓プレイヤー(ChapterMiniPlayer)が同じ解釈を自前で書くと、
//   「片方だけ直る」事故になる(過去に同名機能の二重実装で実害あり)。
//   → 判定そのものを純関数にして、スタジオも小窓もここを呼ぶ。
//
// ⚠既存の互換について:
//   従来のレシピは stepKeys(工程ひも付け)だけを持ち chapters を持たない。
//   その場合 chapter は null を返す = 呼び出し側は「頭から再生」にフォールバックする。
//   逆に chapters を持つレシピは stepKeys も必ず同じ工程を含む(保存側の規約)。
//   既存の🎬表示4箇所は stepKeys しか見ないため、これを守らないと🎬が消える。

export const recipeEventsOf = (recipe) => (Array.isArray(recipe?.events) ? recipe.events : []);
export const chaptersOf = (recipe) => (Array.isArray(recipe?.chapters) ? recipe.chapters : []);

const inSet = (set, id) => !!(set && typeof set.has === 'function' && set.has(id));

/**
 * 再生位置 t における「いま何をすべきか」。VideoRecipeStudio.onTime と小窓の共通判定。
 *
 * @param events        レシピイベント [{id, type:'pause'|'speed'|'skip', start, end?, speed?}]
 * @param t             現在の再生位置(秒)
 * @param prev          直前の再生位置(秒)。停止ポイントの「またいだ」判定に使う
 * @param undoneSkipIds 「戻って見る」で無効化されたスキップの id (Set)
 * @param firedPauseIds 既に発火した停止ポイントの id (Set)
 * @param applyJumps    false = 打刻中/停止オーバーレイ表示中。スキップ・停止は判定しない(倍速だけ効かせる)
 * @param userSpeed     視聴者が選んだ速度。区間倍速に掛ける
 * @returns { skip, pause, rate } — skip があれば呼び出し側は seek して**そこで終わり**にする(元の onTime と同じ)
 */
export const recipeActionAt = ({
  events = [], t = 0, prev = 0,
  undoneSkipIds = null, firedPauseIds = null, applyJumps = true, userSpeed = 1,
} = {}) => {
  const list = Array.isArray(events) ? events : [];
  let skip = null;
  let pause = null;
  if (applyJumps) {
    // −0.05 は元の実装のまま: 区間の最後の1フレームで無限にスキップし続けるのを防ぐ遊び
    skip = list.find(e => e && e.type === 'skip' && t >= e.start && t < ((e.end || e.start) - 0.05) && !inSet(undoneSkipIds, e.id)) || null;
    if (!skip) pause = list.find(e => e && e.type === 'pause' && prev < e.start && t >= e.start && !inSet(firedPauseIds, e.id)) || null;
  }
  const sp = list.find(e => e && e.type === 'speed' && t >= e.start && t < (e.end || e.start)) || null;
  const rate = (sp ? (sp.speed || 1) : 1) * (userSpeed || 1);
  return { skip, pause, rate };
};

/**
 * チャプターを動画の長さに収める。
 * ⚠録画中の打刻は「録画開始からの相対秒」で積むが、端末によっては
 *   実際の動画がわずかに短い/長い。末尾がはみ出すと再生が即終了して「動かない」ように見える。
 */
export const clampChapter = (ch, durationSec = 0) => {
  if (!ch) return null;
  const dur = durationSec > 0 ? durationSec : 0;
  let start = Math.max(0, Number(ch.start) || 0);
  let end = Number(ch.end);
  if (!Number.isFinite(end)) end = dur || start;
  if (dur > 0) {
    start = Math.min(start, Math.max(0, dur - 0.2));
    end = Math.min(end, dur);
  }
  if (end < start + 0.2) end = dur > 0 ? Math.min(dur, start + 0.2) : start + 0.2;
  return { ...ch, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
};

/** この工程で使えるチャプターを持つ動画。chapter が null = 従来の工程ひも付けだけ(頭から再生) */
export const findChapterVideos = ({ recipes = [], stepKey = '', model = '' } = {}) => {
  if (!stepKey) return [];
  return (Array.isArray(recipes) ? recipes : [])
    .filter(r => r && (Array.isArray(r.stepKeys) ? r.stepKeys : []).includes(stepKey) && (!r.model || r.model === model))
    .map(r => ({ recipe: r, chapter: chaptersOf(r).find(c => c && c.stepKey === stepKey) || null }))
    // チャプター付き(=その工程の場面が特定できる)を先に出す。無い物は従来どおり頭から。
    .sort((a, b) => (a.chapter ? 0 : 1) - (b.chapter ? 0 : 1));
};

/** 自動再生で出す1本を選ぶ。チャプター付きを最優先。無ければ従来の紐付け動画。 */
export const pickChapterVideo = ({ recipes = [], stepKey = '', model = '' } = {}) =>
  findChapterVideos({ recipes, stepKey, model })[0] || null;
