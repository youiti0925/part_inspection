// ============================================================================
// 🧩 buildJobs — ロットを「実行できる最小単位(Job)」へ割る
// ----------------------------------------------------------------------------
// 出典: Claude是正指示_実績監査ではなく操業シミュレーターを作る.md 5.2 / CONTRACT.md
//
// ⚠ なぜ台ごとに割るのか (指示書5.2):
//   「10台ロットは画面では1カードだが、内部では実行可能な『台×次工程』へ分ける。
//     10台を丸ごと1人へ固定しない」。
//   1ロット=1仕事にすると、10台ロットが来た時に1人がその10台ぶんを抱え込み、
//   他の人が空いていても手伝えない絵になる。それでは「総時間が足りないのか」
//   「技能が偏っているのか」を切り分けられない(S11)。
//
// ⚠ React も firebase も import しない。Date.now() / new Date() / Math.random() も
//   呼ばない。時刻は normalized が既に持っている物だけを使う。
//   → 同じ入力なら毎回まったく同じ Job 配列を返す(S23)。
//
// ⚠ 目標時間が無い工程に 60秒などを入れない(S16)。durationKnown:false のまま出し、
//   時間の扱いは simulate 側の unknown に任せる。
// ============================================================================

// 📦 分納で「この台はいつから触れるか」を引く。⚠ 数え方(0が1台目)は splitArrivalLoad.js ただ1本。
//   🚨 lot.arrivalChunks が無ければ1度も呼ばない = 今までと1ミリも同じ。
//   ⚠ splitArrivalLoad.js は React も firebase も import しない純関数だけの束。
import { unitReadyAtMs } from './splitArrivalLoad.js';

// ----------------------------------------------------------------------------
// 🚨 「ロットに1回」工程(perUnit:false = 員数/一括/段取り/片付け)の順番について
// ----------------------------------------------------------------------------
// 「その工程より前の全台が終わってから」なのか「台に関係なく順番どおり」なのかを、
// 想像でなく本番の実装 src/App.jsx の globalNextTask (18477行付近) で確かめた。
// 実装はこうなっている:
//
//   ② 先頭側ゲート : 工程を index 順に見て、ロット1回工程が未済ならそれを「次」に返す。
//                    途中で「まだ台の作業が残っている通常工程」に当たったら break する。
//                    → ロット1回工程が動けるのは、それより前の通常工程が【全台】
//                      片付いている時だけ。
//   ③ 台の作業     : ②でロット1回工程が返らなかった時だけ、台×工程を走査する。
//                    → 未済のロット1回工程が待っている間、後続の台の作業は始まらない。
//   ④ 末尾側ゲート : 全台の作業が終わった後に、残ったロット1回工程(片付け等)を返す。
//
// つまり現物は【全台終わってから】であり、かつ【後続の全台を止める関所】でもある。
// 推測ではなく実装どおりなので、こちらを採る。
//
// 🚨 契約(CONTRACT.md)の Job は afterJobId を【1本しか】持てない。
//   関所の本当の先行条件は「前の通常工程 × 全台」という複数本なので、1本の
//   afterJobId だけでは表しきれない。ここで無理に1本の鎖へ直列化すると、ロット内が
//   常に1人ずつの作業になり、上に書いた「10台を1人へ固定しない」が壊れる(並行して
//   進める余地が消える)。契約に無い afterJobIds を勝手に足すのも禁じられている。
//
//   そこで、
//     ・afterJobId には「このロットで直前に作った Job」を入れる。これは必ず本物の
//       先行条件ではあるが、【必要条件であって十分条件ではない】。台数が1のロット
//       では先行工程の台が1台しかないので、これだけで完全に一致する。
//     ・関所の完全な条件は、Job 配列だけから導ける構造規則として残す:
//
//         unitIndex === null の Job は、同じ lotId で
//         unitIndex !== null かつ stepIndex がそれより小さい Job が
//         すべて終わるまで待つ(それまでは開始しない)。
//
//       simulate 側はこの規則も必ず併せて見ること。見落とすと、まだ 1号機が残って
//       いるのに片付けを始めてしまい、結果が実際より楽な方へ寄る。
//   この点は CONTRACT.md の afterJobId の但し書きとして追記する価値がある。
//
// ・逆向き(関所 → その後ろの台の作業)は先行条件が1本なので afterJobId で正確に
//   表せる。関所を作った時点で、全台の「直前 Job」をその関所へ付け替えている。
// ----------------------------------------------------------------------------

/**
 * 台ごとの工程のタスク鍵の候補。
 * ⚠App.jsx の computeLotProgress / lotRemaining.js と同じ規則にする。ここだけ別の鍵で
 *   数えると、画面に出る進捗%と Job の数が食い違う。
 *   通常は `${step.id}-${台}`。id が無い古い工程は `${工程の並び順}-${台}`。
 */
const perUnitTaskKeys = (stepId, sourceIndex, unitIndex) => {
  const keys = [];
  if (stepId) keys.push(`${stepId}-${unitIndex}`);
  keys.push(`${sourceIndex}-${unitIndex}`);
  return keys;
};

/** その台のその工程は、もう終わっているか。 */
const isPerUnitDone = (doneSet, stepId, sourceIndex, unitIndex) =>
  perUnitTaskKeys(stepId, sourceIndex, unitIndex).some((k) => doneSet.has(k));

/**
 * ロット1回工程は終わっているか。
 * ⚠鍵は `${step.id}-lot-${回}` で、5台ずつ持ち込み等で回が増える(App.jsx 1300行付近)。
 *   App.jsx の lotSatisfied は「1回でも済んでいれば済」なので、それに合わせて前方一致で
 *   どれか1つでも見つかれば済とする。
 * ⚠stepId が無いと鍵を組めない。その時は「済」と決めつけず仕事として残す(安全側。
 *   消してしまうと、ありもしない余裕が出る)。
 */
const isLotOnceDone = (doneKeys, stepId) => {
  if (!stepId) return false;
  const prefix = `${stepId}-lot-`;
  return doneKeys.some((k) => k.startsWith(prefix));
};

/**
 * 正規化済み入力から Job 配列を作る。
 * @param {object} normalized normalizeInput.js の戻り値
 * @returns {Array<object>} Job[]
 */
export function buildJobs(normalized) {
  const lots = Array.isArray(normalized?.lots) ? normalized.lots : [];
  const jobs = [];
  // ⚠ロットの並びは入力のまま保つ(並べ替えない)。同じ入力なら同じ並びで返る(S23)。
  //   S12「同じ型式の別ロット」は lotId が別なので、jobId も Job 群も自然に分かれる。
  for (let i = 0; i < lots.length; i++) appendLotJobs(jobs, lots[i]);
  return jobs;
}

/** 1ロットぶんの Job を out へ足す。 */
function appendLotJobs(out, lot) {
  if (!lot) return;
  const lotId = lot.lotId;
  // ⚠鍵が無いロットは jobId を安定・一意にする材料が無い。ここで作ると別ロットと同じ
  //   jobId になり afterJobId がどちらを指すか決まらなくなるため、作らない。
  //   (normalizeInput が lotId を必ず入れる契約なので、通常ここへは来ない)
  if (lotId === null || lotId === undefined || lotId === '') return;

  const rawSteps = Array.isArray(lot.steps) ? lot.steps : [];
  if (rawSteps.length === 0) return;

  // ⚠App.jsx が全域で `lot.quantity || 1` としているのに合わせる(現物合わせ)。
  const quantity = Math.max(1, Math.trunc(Number(lot.quantity)) || 1);

  const doneKeys = Array.isArray(lot.doneTaskKeys)
    ? lot.doneTaskKeys.filter((k) => typeof k === 'string')
    : [];
  const doneSet = new Set(doneKeys);

  // 工程順 = index の数値順。Array#sort は安定なので、index が同じ物は元の並びを保つ。
  // index が数字でない工程は、元データの並び位置をその工程の順番として扱う。
  const ordered = rawSteps
    .map((step, pos) => {
      const n = Number(step?.index);
      return { step: step || {}, pos, sourceIndex: Number.isFinite(n) ? n : pos };
    })
    .sort((a, b) => a.sourceIndex - b.sourceIndex || a.pos - b.pos);

  // 🚨 index が重複しているロット(元データの不整合)では jobId が衝突し、afterJobId が
  //   どちらを指すか決まらなくなる。その時だけ、ロット単位でまとめて「並べ替えた後の
  //   位置」を stepIndex に使う。位置は 0..n-1 で必ず一意なので衝突が起きない。
  //   一部の工程だけ落とすと仕事が黙って消えるので、ロット全体で揃える。
  const seen = new Set();
  let duplicatedIndex = false;
  for (const o of ordered) {
    if (seen.has(o.sourceIndex)) { duplicatedIndex = true; break; }
    seen.add(o.sourceIndex);
  }

  const prevJobIdByUnit = new Map();  // 台 -> その台で直前に作った Job の id
  let lastJobId = null;               // このロットで直前に作った Job の id(種類を問わない)

  ordered.forEach((o, sortedPos) => {
    const step = o.step;
    const stepIndex = duplicatedIndex ? sortedPos : o.sourceIndex;
    const stepId = step.stepId === undefined ? null : step.stepId;

    // 目標時間は「1台あたり」。ロット1回工程では「1回あたり」(App.jsx 1301行)。
    // どちらも Job 1個ぶんの時間なので、台数を掛けない。
    const targetSec = Number(step.targetSec);
    const durationKnown = Number.isFinite(targetSec) && targetSec > 0;

    const base = {
      lotId,
      model: lot.model === undefined ? null : lot.model,
      stepIndex,
      stepId,
      processKey: step.processKey === undefined ? null : step.processKey,
      // 🚨 分からない時に 60秒などを入れない(S16)。null のまま出して simulate に
      //   unknown として扱わせ、原因「時間不明」へ出してもらう。
      durationMs: durationKnown ? Math.round(targetSec * 1000) : null,
      durationKnown,
      equipmentId: step.equipmentId === undefined ? null : step.equipmentId,
      // 🏭 場所(区画)と 検査の種類(テンプレ)を素通しで運ぶ。equipmentId と同じ形。
      //   zoneId    … 同じ区画に何人まで立てるか(simulate の区画の門)
      //   templateId … 「この人はこのテンプレを優先」を人選びで効かせる為
      zoneId: lot.mapZoneId ? String(lot.mapZoneId) : null,
      templateId: lot.templateId === undefined ? null : lot.templateId,
      // 🧵 優先度の区分 0(緊急)|1(特注)|2(通常)。normalizeInput が付けた番号を **素通し** で運ぶ。
      //   ⚠ ここで読み替えない(字→番号は normalizeInput.priorityClassOf ただ1か所)。無ければ null。
      //   効かせるのは priority.js(scenario.priorityClass が立った時だけ 0番目の鍵)。
      priorityClass: lot.priorityClass === undefined ? null : lot.priorityClass,
      dueLineMs: lot.dueLineMs === undefined ? null : lot.dueLineMs,
      arrivalMs: lot.arrivalMs === undefined ? null : lot.arrivalMs,
    };

    // 📦 分納。⚠ 便の一覧が無い(切ってある・記録が無い)ロットは null のまま = 今までどおり。
    // 🚨 2026-09-22 便が1つでも渡ってくる(「6台のうち2台だけ」の一部だけの便)。
    //   normalizeInput が「全台そろう1便」は渡さないので、ここへ来た1便は必ず一部だけ。
    const chunks = Array.isArray(lot.arrivalChunks) && lot.arrivalChunks.length >= 1
      ? lot.arrivalChunks : null;

    // --- ロットに1回だけの工程(員数/一括/段取り/片付け) ---
    // perUnit が無い工程は台ごと扱い。App.jsx も step.lotOnce が falsy なら台ごと。
    if (step.perUnit === false) {
      if (isLotOnceDone(doneKeys, stepId)) return;  // 1回でも済んでいれば作らない
      const jobId = `${lotId}#${stepIndex}#lot`;
      out.push({ ...base, jobId, unitIndex: null, afterJobId: lastJobId });
      // この関所より後ろは、全台がこの Job の完了を待つ(App.jsx ②③のとおり)。
      // 全台の「直前 Job」をこの関所へ付け替えると、後続の台の作業は afterJobId
      // 1本だけで正しく止まる。
      for (let u = 0; u < quantity; u++) prevJobIdByUnit.set(u, jobId);
      lastJobId = jobId;
      return;
    }

    // --- 台ごとの工程 ---
    for (let u = 0; u < quantity; u++) {
      // 既に終わっている台の工程は Job を作らない。
      // ⚠旧式の鍵は「元データの並び位置」で組まれているので、jobId 用の stepIndex では
      //   なく sourceIndex を使う(index 重複時に両者がずれるため)。
      if (isPerUnitDone(doneSet, stepId, o.sourceIndex, u)) continue;
      const jobId = `${lotId}#${stepIndex}#${u}`;
      const prev = prevJobIdByUnit.get(u);
      // 📦 その台が乗っている便の時刻。
      //   🚨 2026-09-22 どの便にも乗っていない台(便の合計がロットの台数に足りない)は
      //     **到着が分からない** として arrivalMs を null にする。
      //     前は「ロットの起点のまま」にしていたので、入荷の予定が1台ぶんも無いのに
      //     割り付いていた(Codex の指摘「未定の4台まで割り付けない」)。
      //     ⚠ null は「いつでも着手できる」ではない。simulate の isJobReady が
      //       `if (arrival == null) return false` で置かず、未割付へ回して
      //       UNRESOLVED_REASON.ARRIVAL_UNKNOWN「到着の予定が分かりません」を出す。
      const unitAt = chunks ? unitReadyAtMs(chunks, u) : null;
      out.push({
        ...base,
        jobId,
        unitIndex: u,
        afterJobId: prev === undefined ? null : prev,
        // 便の一覧が在る時は null もそのまま入れる(到着未定の印)。無い時は今までどおり触らない。
        ...(chunks ? { arrivalMs: unitAt } : {}),
      });
      prevJobIdByUnit.set(u, jobId);
      lastJobId = jobId;
    }
  });
}

export default buildJobs;
