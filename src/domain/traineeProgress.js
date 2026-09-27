// 🎓 新人の「級・検定」と伸びのレポート。
//
// ⚠⚠ **判定は保存しない。** 級も検定も、履歴から毎回この純関数で導出する。
//   理由は3つ、どれも過去に実害が出た形:
//     ① 多端末。判定結果を書き込むと、2台が同時に別の判定を書いて後勝ちで消える。
//        「級が勝手に下がった」は原因が追えない事故になる。
//     ② ルールを変えたとき(×1.3 を ×1.25 にする等)、保存済みの判定は古いままで、
//        画面の設定と食い違う。導出なら過去に遡って一貫する。
//     ③ 純関数はテストできる。保存された状態は現物を見ないと分からない。
//   **保存するのは「人の判断」だけ** = workers doc の trainee / graduatedAt。
//
// ⚠⚠ 集計の単位は **型式 × テンプレ × 工程**。工程名だけで束ねるのは禁止。
//   実測: 同じ型式でもテンプレが違うと同名工程の中央値が 8.2倍 違う (App.jsx の profitRanking 参照)。
//   工程名だけで束ねると「あの人は測定が遅い」が、実は別種類の測定を1回やっただけ、になる。
//
// ⚠ 0秒の記録は数えない。押してすぐ閉じた等の記録で、速さの証拠にならない。
//   ただし「捨てた」ことが分かるように、使った件数(n)は必ず画面へ出すこと。

import { percentileOf, medianOf } from './arrivalActual.js';

// 級の目標倍率と検定。tiers[n] = 級n の目標 (ものさし × 倍率)。
//   3級=×1.5 → 2級=×1.3 → 1級=×1.1 と厳しくなり、最後に検定(×1.2 を3回連続)。
export const DEFAULT_TRAINING_CONFIG = { tiers: [1.5, 1.3, 1.1], examRatio: 1.2, examStreak: 3 };

// ものさしに使う「本人以外・非教育中」の実績が、この件数以上あれば P25 を使う。
//   足りないときは中央値 (P25 は少数だと一番速い1件に引っ張られる)。
export const TRAINEE_BASELINE_MIN_N = 5;

// ものさしの出どころ。⚠画面には必ずこの言葉を出す (数字だけ出すと「どこから出た数字だ」になる)。
// ⚠ target と templateTarget を混ぜないこと (2026-08-09 是正・あら探し#2/#9)。
//   target       = 目標時間最適化(較正)で会社が決めた値 = settings.customTargetTimes に実在する値。
//   templateTarget = テンプレを作った時の仮置き(step.targetTime)。誰も検証していない。
//   以前は getEffectiveTargetTime が両者を区別せず返していたため、テンプレの仮置き600秒で
//   3回で2級・12回で「🏅検定合格」が出た。しかも画面は【仮定】バッジ無しで「較正済み目標」と断言し、
//   管理者はその数字を根拠に卒業判断を押す = 元データに無い基準を事実として出す事故になっていた。
export const BASELINE_SOURCE_LABEL = {
  target: '較正済みの目標時間',
  p25: '本人以外・非教育中の実績 P25',
  median: '本人以外・非教育中の実績 中央値',
  templateTarget: 'テンプレの既定値（未較正）',
};

// 比率の境界 (ちょうど ×1.3 など) は「合格」。浮動小数の誤差で落とさないための遊び。
const EPS = 1e-9;

// Firestore Timestamp / 数値 / 日付文字列 のいずれでもミリ秒にする。
//   ⚠App.jsx の toMsAny と同じ規約 (nanoseconds を落とさない)。呼び出し側から toMs を渡せば
//   そちらが優先されるので、二重実装を増やしたくない場合は App.jsx の toMsAny を渡すこと。
const defaultToMs = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (raw.seconds) return raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
  const t = new Date(raw).getTime();
  return isNaN(t) ? null : t;
};

/**
 * 設定の掃除。⚠現場が⚙で好きな数字を入れられるので、壊れた値でも必ず動く形に直す。
 *   ・倍率は降順に並べ替える (級は必ず厳しくなっていく。逆に入れられると「昇級したら楽になる」)
 *   ・重複は落とす / 0以下は捨てる / 全部消えたら既定へ戻す
 */
export const normalizeTrainingConfig = (cfg) => {
  const src = (cfg && typeof cfg === 'object') ? cfg : {};
  let tiers = Array.isArray(src.tiers)
    ? src.tiers.map(Number).filter(v => Number.isFinite(v) && v > 0)
    : [];
  tiers = [...new Set(tiers)].sort((a, b) => b - a);
  if (!tiers.length) tiers = [...DEFAULT_TRAINING_CONFIG.tiers];
  const er = Number(src.examRatio);
  const examRatio = (Number.isFinite(er) && er > 0) ? er : DEFAULT_TRAINING_CONFIG.examRatio;
  let examStreak = Math.round(Number(src.examStreak));
  if (!Number.isFinite(examStreak) || examStreak < 1) examStreak = DEFAULT_TRAINING_CONFIG.examStreak;
  examStreak = Math.min(20, examStreak);
  return { tiers, examRatio, examStreak };
};

/** 級の呼び名。tier=0 は「まだ級なし(見習い)」。 */
export const tierLabel = (tier, cfg) => {
  const c = normalizeTrainingConfig(cfg);
  if (!(tier > 0)) return '見習い';
  if (tier >= c.tiers.length) return '1級';
  return `${c.tiers.length - tier + 1}級`;
};

/**
 * ものさし(エースの基準)を選ぶ。優先順位:
 *   ① 較正済みの目標時間 → ② 本人以外・非教育中の実績 P25 → ③ その中央値 → ④ テンプレの既定値(未較正)
 *
 * ⚠④を①より後ろに置くのが要 (あら探し#2/#9)。テンプレの targetTime はほぼ全工程に入っているので、
 *   ①の判定を「値があるか」でやると②③の経路が**構造的に到達不能**になる。
 *   ④は「他に何も無い時だけ使う参考値」であり、画面では必ず【仮定】側へ落とすこと。
 *
 * @param targetSec        較正済みの目標時間(秒)。**較正されていない値をここへ渡さないこと。**
 * @param templateTargetSec テンプレの既定値(秒)。較正されていない仮置き。
 * @returns {{sec:number, source:'target'|'p25'|'median'|'templateTarget'|null, n:number|null}}
 */
export const pickBaseline = ({ targetSec = 0, templateTargetSec = 0, peerDurations = [], minN = TRAINEE_BASELINE_MIN_N } = {}) => {
  const tgt = Number(targetSec);
  if (Number.isFinite(tgt) && tgt > 0) return { sec: Math.round(tgt), source: 'target', n: null };
  const ds = (peerDurations || []).map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (ds.length >= minN) {
    // ⚠補間しない下側順位の P25 (arrivalActual と同じ)。n=3 で P25 が中央値に潰れるのを避ける。
    const v = percentileOf(ds, 25);
    if (v > 0) return { sec: Math.round(v), source: 'p25', n: ds.length };
  }
  if (ds.length) {
    const m = medianOf(ds);
    if (m > 0) return { sec: Math.round(m), source: 'median', n: ds.length };
  }
  const tpl = Number(templateTargetSec);
  if (Number.isFinite(tpl) && tpl > 0) return { sec: Math.round(tpl), source: 'templateTarget', n: null };
  return { sec: 0, source: null, n: ds.length };
};

/**
 * 1セル(型式×テンプレ×工程)ぶんの級・検定を、記録の並び順に沿って導出する。
 *
 * ロジック:
 *   ・級n の目標 = baseline × tiers[n]。その目標以内を examStreak 回**連続**で昇級。
 *   ・最上級まで上がった後は baseline × examRatio 以内を examStreak 回連続で「検定合格」。
 *   ・1回でも外すと連続はリセット。**級は下げない** (下げると「頑張っても取られる」になり、
 *     速さを盛るための記録の作為につながる)。
 *
 * @param records [{duration, endTime}] 時系列でなくてもよい (endTime で並べ直す)
 * @param baseline ものさし(秒)。無い(記録不足)なら null → 判定しない
 */
export const traineeCellProgress = ({ records = [], baseline = null, config = null } = {}) => {
  const cfg = normalizeTrainingConfig(config);
  const baseNum = Number(baseline);
  const base = (Number.isFinite(baseNum) && baseNum > 0) ? baseNum : null;
  // 0秒の記録は速さの証拠にならないので落とす。並びは endTime 昇順 (無いものは最後)。
  const used = (records || [])
    .filter(r => r && Number(r.duration) > 0)
    .slice()
    .sort((a, b) => (a.endTime == null ? Infinity : a.endTime) - (b.endTime == null ? Infinity : b.endTime));

  let tier = 0, streak = 0, examStreak = 0, examPassed = false;
  const history = [];

  if (base != null) {
    used.forEach(r => {
      const d = Number(r.duration);
      const atMax = tier >= cfg.tiers.length;
      const goalRatio = atMax ? cfg.examRatio : cfg.tiers[tier];
      const goal = base * goalRatio;
      const pass = d <= goal + EPS;
      const tierBefore = tier;
      let promoted = false, passedNow = false;
      if (atMax) {
        if (pass) {
          examStreak += 1;
          if (examStreak >= cfg.examStreak && !examPassed) { examPassed = true; passedNow = true; }
        } else examStreak = 0;
      } else {
        if (pass) {
          streak += 1;
          if (streak >= cfg.examStreak) { tier += 1; streak = 0; promoted = true; }
        } else streak = 0;
      }
      history.push({
        duration: d, endTime: r.endTime ?? null, lotId: r.lotId || '', orderNo: r.orderNo || '',
        ratio: Math.round(d / base * 1000) / 1000,
        goal: Math.round(goal), goalRatio, pass, tier: tierBefore, promoted, examPassed: passedNow,
      });
    });
  }

  const atMax = tier >= cfg.tiers.length;
  const stage = atMax ? 'exam' : 'tier';
  const stageRatio = atMax ? cfg.examRatio : cfg.tiers[tier];
  const stageStreak = atMax ? examStreak : streak;
  return {
    n: used.length,
    baseline: base,
    ready: base != null,              // false = ものさしが無い(記録不足)ので判定していない
    tier,
    tierName: tierLabel(tier, cfg),
    streak,
    examStreak,
    examPassed,
    stage,                            // 'tier' = 昇級を目指している / 'exam' = 検定に挑戦中
    stageRatio,
    stageGoal: base != null ? Math.round(base * stageRatio) : null,
    stageStreak,
    stageNeed: cfg.examStreak,
    remaining: examPassed ? 0 : Math.max(0, cfg.examStreak - stageStreak),
    history,
    config: cfg,
  };
};

/**
 * ロットを1回なめて「型式×テンプレ×工程」のセルを作る。
 *   ・records     = 選んだ人の記録 (traineeMode='only' なら🎓が付いた記録だけ)
 *   ・peerDurations = **本人以外**の、教育中でない記録 = ものさしの材料
 *
 * ⚠キーの作り方(step.id-台 / 数値index / ロット1回)はアプリ側の規約なので、
 *   ここで作り直さず taskKeysOf / stepKeyOf を受け取る (同じ規約の二重実装を作らないため)。
 *
 * @param traineeMode 'only' = 🎓が付いた記録だけ / 'all' = その人の記録すべて
 *   (🎓を付ける前=フラグを立てる前の記録には印が無い。'all' はそれも見たい時に使う)
 */
export const collectTraineeCells = ({
  lots = [], workerName = '', traineeMode = 'only',
  stepKeyOf = null, taskKeysOf = null, targetSecOf = null, templateNameOf = null, toMs = defaultToMs,
} = {}) => {
  const name = String(workerName || '');
  if (!name) return [];
  const map = new Map();
  (lots || []).forEach(l => {
    if (!l) return;
    if (l.status !== 'completed' && l.location !== 'completed') return;
    const lotMs = toMs(l.completedAt) ?? toMs(l.updatedAt);
    const tpl = l.templateId || '';
    (l.steps || []).forEach((step, idx) => {
      if (!step) return;
      const sk = stepKeyOf ? stepKeyOf(step) : `${step.category || ''}_${step.title || ''}`;
      const key = `${l.model || ''}||${tpl}||${sk}`;
      let cell = map.get(key);
      if (!cell) {
        cell = {
          key, model: l.model || '', templateId: tpl,
          templateName: templateNameOf ? (templateNameOf(tpl) || '') : '',
          stepKey: sk, stepTitle: step.title || '', category: step.category || '',
          targetSec: 0, templateTargetSec: 0, records: [], peerDurations: [], lotIds: [],
        };
        map.set(key, cell);
      }
      // ⚠targetSecOf は「較正済みの秒」と「テンプレ既定値の秒」を分けて返すこと。
      //   数値をそのまま返す旧シグネチャも受ける(その場合は較正済みとして扱わない=安全側)。
      if (targetSecOf && !(cell.targetSec > 0)) {
        const raw = targetSecOf(l, step);
        const obj = (raw && typeof raw === 'object') ? raw : null;
        const cal = Number(obj ? obj.sec : NaN);
        const tplSec = Number(obj ? obj.templateSec : raw);
        if (Number.isFinite(cal) && cal > 0) cell.targetSec = cal;
        if (!(cell.templateTargetSec > 0) && Number.isFinite(tplSec) && tplSec > 0) cell.templateTargetSec = tplSec;
      }
      const keys = taskKeysOf ? (taskKeysOf(l, step, idx) || []) : [];
      keys.forEach(k => {
        const t = (l.tasks || {})[k];
        if (!t) return;
        if (t.status !== 'completed' && t.status !== 'ng') return;
        if (t.samplingSkipped) return;                 // 抜取でスキップした台は実作業していない
        const d = Number(t.duration) || 0;
        if (!(d > 0)) return;
        const isTrainee = t.trainee === true;
        const mine = (t.workerName || '') === name;
        if (mine) {
          if (traineeMode === 'all' || isTrainee) {
            cell.records.push({ duration: d, endTime: toMs(t.endTime) ?? lotMs, taskKey: k, lotId: l.id || '', orderNo: l.orderNo || '', ng: t.status === 'ng' });
            if (l.id && !cell.lotIds.includes(l.id)) cell.lotIds.push(l.id);
          }
          return; // ⚠自分の記録は「ものさし」に入れない (自分と自分を比べても伸びは見えない)
        }
        if (!isTrainee) cell.peerDurations.push(d);
      });
    });
  });
  return [...map.values()].filter(c => c.records.length > 0);
};

/**
 * 伸び画面用のレポート。セルごとに ものさし・自分の中央値・比率・級/検定 を出し、
 * **差の大きい順**(= 合計で何秒損しているか)に並べる = 次に何を教えるべきかの優先順位。
 *
 * ⚠並べ替えの既定を「1台あたりの差」ではなく「差 × 回数」にしている理由:
 *   1台あたり5分遅い工程を年に2回やるより、30秒遅い工程を毎日やる方が効く。
 *   教える順番は「その人が実際に使っている時間」で決めるのが正しい。
 */
export const buildTraineeReport = ({ cells = [], config = null, resolveBaseline = null, sort = 'gap', minRecords = 1 } = {}) => {
  const cfg = normalizeTrainingConfig(config);
  const rows = (cells || []).filter(c => (c.records || []).length >= minRecords).map(c => {
    const b = resolveBaseline
      ? resolveBaseline(c)
      : pickBaseline({ targetSec: c.targetSec, templateTargetSec: c.templateTargetSec, peerDurations: c.peerDurations });
    const baseline = Number(b?.sec) > 0 ? Number(b.sec) : 0;
    const sorted = (c.records || []).slice().sort((x, y) => (x.endTime == null ? Infinity : x.endTime) - (y.endTime == null ? Infinity : y.endTime));
    const durations = sorted.map(r => r.duration).filter(d => d > 0);
    const n = durations.length;
    const median = medianOf(durations) || 0;
    const recent = durations.slice(-5);
    const recentMedian = medianOf(recent) || 0;
    const progress = traineeCellProgress({ records: sorted, baseline, config: cfg });
    const gapPerSec = baseline > 0 ? Math.max(0, median - baseline) : 0;
    return {
      ...c,
      records: sorted,
      baseline, baselineSource: b?.source || null, baselineN: b?.n ?? null,
      n, median, recentMedian,
      // ⚠Math.min(...arr) は要素数が多いと引数上限で落ちる(=白画面)。件数が読めないので畳み込みで出す。
      best: n ? durations.reduce((a, b) => (b < a ? b : a), durations[0]) : 0,
      worst: n ? durations.reduce((a, b) => (b > a ? b : a), durations[0]) : 0,
      firstMs: sorted.length ? sorted[0].endTime : null,
      lastMs: sorted.length ? sorted[sorted.length - 1].endTime : null,
      ratio: (baseline > 0 && median > 0) ? Math.round(median / baseline * 100) / 100 : null,
      recentRatio: (baseline > 0 && recentMedian > 0) ? Math.round(recentMedian / baseline * 100) / 100 : null,
      gapPerSec,
      gapTotalSec: gapPerSec * n,     // 合計で何秒損しているか = 教える優先順位
      progress,
    };
  });

  const cmp = {
    gap: (a, b) => b.gapTotalSec - a.gapTotalSec,
    gapPer: (a, b) => b.gapPerSec - a.gapPerSec,
    ratio: (a, b) => (b.ratio ?? -1) - (a.ratio ?? -1),
    count: (a, b) => b.n - a.n,
    recent: (a, b) => (b.lastMs || 0) - (a.lastMs || 0),
  };
  rows.sort(cmp[sort] || cmp.gap);

  const measurable = rows.filter(r => r.baseline > 0);
  const times = rows.flatMap(r => r.records.map(x => x.endTime)).filter(v => typeof v === 'number');
  return {
    rows,
    config: cfg,
    summary: {
      cellCount: rows.length,
      recordCount: rows.reduce((s, r) => s + r.n, 0),
      measurableCells: measurable.length,          // ものさしがあって判定できたセル
      noBaselineCells: rows.length - measurable.length, // 記録不足でものさしが作れないセル
      examPassedCells: rows.filter(r => r.progress.examPassed).length,
      tieredCells: rows.filter(r => r.progress.tier > 0).length,
      gapTotalSec: rows.reduce((s, r) => s + r.gapTotalSec, 0),
      firstMs: times.length ? times.reduce((a, b) => (b < a ? b : a), times[0]) : null,
      lastMs: times.length ? times.reduce((a, b) => (b > a ? b : a), times[0]) : null,
    },
  };
};
