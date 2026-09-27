// =============================================================================
//  useOperationsSimulation.js — 操業シミュレーションを画面から呼ぶための入口
// -----------------------------------------------------------------------------
//  出典: Claude是正指示_実績監査ではなく操業シミュレーターを作る.md 8.2 /
//        src/domain/operationsSimulation/PANEL_SPEC.md 8章
//
//  ここがやる事は4つだけ。
//    ① 計算に載せるロットを絞る（既定＝工場の中にある物 ＋ 14日以内に来る予定の物）
//    ② Worker（別スレッド）へ渡して、進み具合を受け取る
//    ③ Worker が作れない端末では、同じ計算をこの場（メインスレッド）で回す
//    ④ 同じ入力で二度計算しない
//
//  🚨 計算そのものはここに1行も無い。src/domain/operationsSimulation/（完成済み）と
//     src/workers/operationsSimulation.worker.js が持っている。
//
//  🚨 やり直しの道（usedFallback:true）は **メインスレッドで走る**。その間、画面は
//     止まる。setTimeout(...,0) を挟んでも別スレッドにはならない（指示書2.3）。
//     挟んでいるのは、区切りごとに進み具合を描き直させるためだけ。
//
//  【本番の実測 2026-08-22】手元10件=111ms / 179件=約5秒 / 282件=約8秒。
//     🚨 だから既定を「未完了ぜんぶ」にしない。既定は下の DEFAULT_SCOPE_DAYS。
//
// -----------------------------------------------------------------------------
//  【使い方】
//    const sim = useOperationsSimulation({
//      lots, templates, workers, settings,
//      enabled: tab === 'opsim',      // 🚨 既定は false。開いた瞬間に8秒使わない
//      scenario, mode, horizonDays: 5, estimateMode: 'P75',
//      scopeFilter,                   // 省略可。省略すると既定の絞り込み
//    });
//    // sim = { result, loading, progress, error, elapsedMs, cancel, rerun, usedFallback }
//
//    result = { base, allSkills, explain, normalized, meta }   ← worker と同じ形
//    progress = { phase, label, ratio, percent } | null
//
//  🚨 lots は **全部** 渡す事。過去の作業記録（完了ロット）が無いと
//     「誰がこの工程をやった記録があるか」が数えられず、全員が
//     「記録がありません」になって嘘の結論が出る。未来へ流す分だけを絞るのは
//     この中の scopeFilter がやる。
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docIdOf } from './domain/soloDependency.js';
import { dueMsOfLot, isOpenLot } from './domain/dueDefense.js';
// 📅 工場の暦の指紋。🚨 ここで自分で作らない(計算側と違う鍵になる)。
import { calendarFingerprint } from './domain/factoryCalendar.js';
// 👥 分担の区切り(settings.opsim.handoff)の指紋。読み方は realism.js ただ1本(既定 'unit' も向こうが持つ)。
//   🚨 これは **割付そのもの** を変えるので、scenario だけでなく 指紋(＝土俵 groundKey)にも要る。
import { handoffFingerprintOf } from './opsim/realism.js';
// 🧵🚩 ロットは持ったら最後まで／優先度の区分(settings.opsim.lotFocus / priorityClass)の指紋(2026-09-10 23:30)。
//   ⚠ 上の行と分けて書く(👥 の見張り HP-7 が上の1行を字で見ている)。
import { lotFocusFingerprintOf } from './opsim/realism.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 既定の絞り込み日数。「これから14日以内に来る予定の物まで」。 */
export const DEFAULT_SCOPE_DAYS = 14;

/** 既定の見通し日数（指示書5「5日操業シミュレーター」）。 */
export const DEFAULT_HORIZON_DAYS = 5;

/**
 * 🚨 ロットのフィールド名の出どころは
 *    src/domain/operationsSimulation/normalizeInput.js（指示書5.1）。
 *    ここに置いた2つだけは「正規化より **前** に絞る」ために、やむを得ず二重に持っている。
 *    増やさない事。増やしたくなったら、判定を normalizeInput 側へ出す。
 */
const LOT_FIELD = Object.freeze({ location: 'location', arrival: 'entryAt' });
/** 未入荷置き場。CONTRACT.md 1章（'arrival'=未入荷 / 'planned'=工場内 / 'completed'=完了）。 */
const LOCATION_ARRIVAL = 'arrival';

/**
 * settings のうち、エンジンが読む物だけ。指紋を作るのに使う。
 * 🚨🚨 **エンジンが読む物を足したら、必ずここにも足す。**
 *   足し忘れると「登録しても計算し直さない = 押しても何も変わらない画面」になる。
 *   2026-09-02 に factoryCalendar(工場の暦=祝日表)を足した。祝日を1日登録すると
 *   月の営業日が減り、必要な人数が変わる。ここに無いと、その変化が画面へ出ない。
 */
const SETTINGS_KEYS = Object.freeze([
  'workSchedule', 'indirectFactor', 'workerRoster', 'workloadEffectiveWorkers',
  'customTargetTimes', 'modelGroups', 'workerSkills',
  // 🧮 2026-09-05: 操業ポリシー(1日の分数・直工比率の補正 applyIndirectFactor)。無いと ⚙ や全体進捗で変えても **計算し直さない画面** になる(実画面で確認: チェックを押しても 420分のまま)。
  'operationPolicy',
  // 👤 2026-09-05: 人ごとの勤務の窓(時短・直工比率)。無いと作業者マスタで 9:30〜16:00 と入れても
  //   **計算し直さない画面** になる(operationPolicy で同じ穴を今日踏んだ)。
  //   ⚠ 2026-09-10 の新3欄(byWeekday / days / overtime)も同じ入れ物の中なので、この1語で指紋に乗る
  //   (stableKey は入れ物の中身を丸ごと文字にする)。
  'workerProfiles',
  // 🎛 2026-09-10 確かめ: settings.opsim(realism / equipmentCapacity / zoneCapacity …)は **ここに足さない**。
  //   エンジンは settings.opsim を1行も読まない(domain/operationsSimulation で settings.opsim を読むのは
  //   equipmentCapacity.readManualEquipmentCaps だけで、それを呼ぶのは画面)。画面が読んで scenario に
  //   載せ替え(realismForSim / equipCapForSim / zoneCapForSim)、その scenario の中身は下の scenarioKey
  //   (stableKey)で runKey に入る。実績の表(reworkRates 等)と 分納の便(splitArrival.byLot)も scenario に
  //   載って来るので、到着のデータを別に指紋へ足す必要は無い(載っている物が変われば scenarioKey が変わる)。
  //   ⚠ 'opsim' を丸ごと足さないのは、scenario に載る物を二重に数えない為(足しても答えは変わらないが、
  //     この一覧は「エンジンが settings から直に読む物」の一覧であり、それ以外を混ぜると意味が濁る)。
  // 📅 工場の暦。⚠ 実際は settings ではなく共通の棚から来るので、下の factoryCalendar
  //   引数からも別に指紋を作る。settings に入っている運用へ変わっても拾える様に両方見る。
  'factoryCalendar',
]);

/** Worker が起動の合図すら返さない時に、やり直しの道へ切り替えるまでの待ち時間。 */
const WORKER_BOOT_TIMEOUT_MS = 10000;

const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});
const IDLE_STATE = Object.freeze({
  result: null, loading: false, progress: null, error: null, elapsedMs: null, usedFallback: false,
});

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));

// -----------------------------------------------------------------------------
// 絞り込み（範囲）
// -----------------------------------------------------------------------------
/**
 * 既定の絞り込み。
 *   ・工場の中にある物は全部
 *   ・未入荷の物は「days 日以内に来る予定」の物だけ
 *   ・到着も納期も分からない物は **落とさない**（「分かりません」として画面に出したいので）
 * @param {number} nowMs 今の実時刻。呼ぶ側で1回だけ決めた物
 * @param {number} [days]
 * @returns {(lot:object)=>boolean}
 */
export function makeDefaultScopeFilter(nowMs, days = DEFAULT_SCOPE_DAYS) {
  const span = Number.isFinite(Number(days)) ? Math.max(0, Number(days)) : DEFAULT_SCOPE_DAYS;
  const until = Number(nowMs) + span * DAY_MS;
  return (lot) => {
    if (!isOpenLot(lot)) return false;
    if (str(lot && lot[LOT_FIELD.location]) !== LOCATION_ARRIVAL) return true;
    const entry = Number(lot && lot[LOT_FIELD.arrival]);
    if (Number.isFinite(entry)) return entry <= until;
    const due = dueMsOfLot(lot);
    if (due != null) return due <= until;
    return true;
  };
}

/**
 * 画面の「範囲」切替に使える組み合わせ。呼ぶ側が選んで scopeFilter を作る。
 * 🚨 ここに件数を書かない。件数は今日の日付とデータで変わるので、書いた瞬間に嘘になる。
 *    実際に何件になったかは result.meta.lotsScoped に入っている。
 */
export const SCOPE_PRESETS = Object.freeze([
  { key: 'inShop', label: '工場の中にある物と、到着予定日を過ぎた物', days: 0, note: 'これから来る分は入れません' },
  { key: 'd14', label: '14日以内に来る分まで', days: DEFAULT_SCOPE_DAYS, note: '既定' },
  { key: 'd30', label: '30日以内に来る分まで', days: 30, note: '' },
  { key: 'all', label: '未完了ぜんぶ', days: null, note: '2026-08-22 の本番で282件。計算に約8秒かかります' },
]);

/**
 * SCOPE_PRESETS の key から絞り込みを作る。
 * @param {string} key
 * @param {number} nowMs
 */
export function makeScopeFilter(key, nowMs) {
  const preset = SCOPE_PRESETS.find((p) => p.key === key) || null;
  if (!preset) return makeDefaultScopeFilter(nowMs);
  if (preset.days === null) return (lot) => isOpenLot(lot);
  return makeDefaultScopeFilter(nowMs, preset.days);
}

// -----------------------------------------------------------------------------
// 指紋（同じ入力で作り直さないための鍵）
// -----------------------------------------------------------------------------
/** Firestore の時刻を、数でも Timestamp でも1つの文字にする。 */
function stampOf(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') {
      try { return String(v.toMillis()); } catch { return ''; }
    }
    if (typeof v.seconds === 'number') return `${v.seconds}.${v.nanoseconds || 0}`;
  }
  return '';
}

const countKeys = (v) => (isObj(v) ? Object.keys(v).length : 0);

/**
 * 並び順の決まった文字列。
 * ⚠ JSON.stringify はキーの入った順で並ぶので、同じ中身でも別の文字になる事がある。
 *   鍵がずれても「作り直す」だけで結果は変わらないが、無駄が出るのでキーを並べ替える。
 * ⚠ worker 側にも同じ物がある。engine を主スレッドの束へ引き込まないための二重持ち。
 */
function stableKey(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'function') return '"fn"';
  return JSON.stringify(value);
}

/**
 * ロット・検査表・作業者・設定の指紋。
 * ⚠ ロットは updatedAt（saveData が毎回書く）とタスク数で見ている。
 *   もし updatedAt を動かさずに中身だけ書き換える道があると、作り直しが起きない。
 *   その時は画面の「もう一度計算」を押せば必ず作り直す。
 */
function fingerprintData(lots, templates, workers, settings) {
  const l = lots.map((x) => `${docIdOf(x)}:${stampOf(x && x.updatedAt)}:${countKeys(x && x.tasks)}`).join('|');
  const t = templates.map((x) => `${docIdOf(x)}:${stampOf(x && x.updatedAt)}:${Array.isArray(x && x.steps) ? x.steps.length : 0}`).join('|');
  const w = workers.map((x) => `${docIdOf(x)}:${str(x && x.name)}`).join('|');
  const s = SETTINGS_KEYS.map((k) => `${k}=${stableKey(isObj(settings) ? settings[k] : null)}`).join('|');
  // 👥 分担の区切り(settings.opsim.handoff)。
  // 🚨 settings.opsim は SETTINGS_KEYS へ丸ごとは足さない決まり(scenario 経由で二重に数えない)。
  //   だが これは **割付そのもの** を変えるので、土俵(groundKey = metrics.inputFingerprint)が
  //   変わらないと、区切りを変える **前** に貯めた「通常との差」の表が、変えた **後** の数字と混ざる。
  //   だから 答えが変わるこの1つだけを名指しで足す。読み方は realism.js の1本(既定 'unit' も向こう)。
  const h = handoffFingerprintOf(settings);
  // 🧵🚩 ロットは持ったら最後まで／優先度の区分(settings.opsim.lotFocus / priorityClass)。
  //   2026-09-10 清水さん「ロット処理して次のロットでいいでしょ」「緊急＞特注＞通常」。
  //   これも **割付そのもの** を変えるので、handoff と同じ理由で名指しで足す(押しても計算し直さない穴を作らない)。
  const f = lotFocusFingerprintOf(settings);
  return `L${lots.length}#${l}//T${t}//W${w}//S${s}//${h}//${f}`;
}

// -----------------------------------------------------------------------------
// 中止の合図（AbortController が無い端末でも同じ形の物を渡す）
// -----------------------------------------------------------------------------
function makeAbortToken() {
  if (typeof AbortController === 'function') {
    const ctrl = new AbortController();
    return { signal: ctrl.signal, abort: () => ctrl.abort() };
  }
  const signal = { aborted: false };
  return { signal, abort: () => { signal.aborted = true; } };
}

/**
 * 計算の途中に画面へ出す言い方の差し替え（2026-08-30 清水さんの指摘2）。
 *
 * 清水さんの原文:
 *   「『通常』を選んでいるのに途中で『全員がどの工程も持てる仮定で、もう一度進めています』と出ます。
 *     『主因を判定するため、全員万能の仮定とも比較しています』と表示した方が理解できます。」
 *
 * なぜ差し替えが要るか: 「通常」を選んでいるのに『もう一度進めています』だけを読むと、
 *   **選んだ条件が勝手に全員万能へ差し替わった** ように読める。実際は、主因が
 *   「仕事量」か「人の偏り」かを切り分けるために **比べているだけ** で、
 *   画面に出る結果は「通常」のまま。だから「比較しています」と言い切る。
 *
 * 🚨 なぜ Worker の PHASE_LABEL を直さずここで差し替えるか:
 *   Worker(`src/workers/operationsSimulation.worker.js`)は別の作業で触っている最中なので、
 *   同じファイルを2人で書き換えない。言い方は画面の持ち物なので、画面側の入口で決める。
 * 🚨 **文字ではなく区切りの名前(phase)で引き当てる**。Worker 側の文言が後で変わっても、
 *   ここが黙って効かなくなる事が無い。
 * 🚨 画面に出す文は1本道。`opsim/Header.jsx` の `prog.label` ただ1箇所が
 *   この値を描く（実コードで確認。他に進み具合を描く所は無い）。
 */
const PHASE_LABEL_OVERRIDE = Object.freeze({
  allSkills: '主因を判定するため、全員万能の仮定とも比較しています',
  /**
   * 🚨 'done' は **まだ終わっていない**（2026-08-30 実測）。
   *   計算側は「原因と対策」が済んだ所で done を出し、その **後で** 教育の提案を回す。
   *   画面で見えた順（見張りで全部拾った実測）:
   *     … → 遅れの原因と、効く手を分けています
   *        → 計算が終わりました        ← ここで done(100%)
   *        → 将来どの工程で人が足りなくなるかを見ています   ← まだ働いている
   *   「終わりました」と言った後に続きが出るので、読んだ人は何を待たされているか分からない。
   *   区切りの順番そのものは計算側の持ち物なので触らない。**画面の言い方だけ**を、
   *   本当に終わるまで「終わりました」と言わない形へ直す。
   *   ⚠ 本当に終わった事は、この帯が **消える** 事で分かる（loading が false になる）。
   *     だからここで「終わりました」と言う必要は無い。
   */
  done: '仕上げています（もう少しです）',
});

const toProgress = (phase, label, ratio) => {
  const r = Number(ratio);
  const safe = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  const key = str(phase);
  return {
    phase: key,
    label: PHASE_LABEL_OVERRIDE[key] || str(label),
    ratio: Math.round(safe * 100) / 100,
    percent: Math.round(safe * 100),
  };
};

// =============================================================================
//  本体
// =============================================================================
/**
 * @param {object} args
 *   lots, templates, workers, settings … アプリが既に読んでいる配列（追加の読み取り0件）
 *   enabled     … true の間だけ計算する。🚨 既定 false（開いた瞬間に8秒使わない）
 *   scenario    … エンジンへそのまま渡す（dailyHours / absences / dueBufferDays / ojt など）
 *   mode        … 担当候補の区分。省略で ['provisional_id','provisional_name']
 *   horizonDays … 何日先まで見るか。省略で5
 *   estimateMode… 工数の見積り。'P50'|'P75'|'P90'。省略で 'P75'。
 *                 🚨 モードが違う結果どうしは比べられない(指紋が変わる)
 *   scopeFilter … (lot)=>boolean。省略で「工場の中＋14日以内に来る予定」
 *   now         … 基準時刻(epoch ms)。省略するとこのフックが最初に走った時刻を使う。
 *                 🚨 渡した時は **呼ぶ側が時計の持ち主**。rerun() でここが時計を取り直さない。
 *                    取り直すと、画面が絞り込み(scopeFilter)や休みの日付に使っている時刻と
 *                    計算に渡る時刻が2つに分かれ、押すたび差が開く。
 * @returns {{result:object|null, loading:boolean, progress:object|null, error:string|null,
 *            elapsedMs:number|null, cancel:function, rerun:function, usedFallback:boolean}}
 */
export function useOperationsSimulation({
  lots = EMPTY_ARRAY,
  templates = EMPTY_ARRAY,
  workers = EMPTY_ARRAY,
  settings = null,
  /**
   * 📅 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)。
   * 🚨 清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
   *   ⚠ これは settings ではなく **共通の棚(contact-shared-v1)** から来る。
   *     だから settings の指紋には乗らない。**下の calendarKey で必ず鍵に混ぜる**。
   *   🚨 混ぜ忘れると「祝日を登録しても計算し直さない = 押しても何も変わらない画面」になる。
   *   🚨 登録が空(null)なら 月〜金 のまま = 今までと1ミリも同じ。
   */
  factoryCalendar = null,
  enabled = false,
  scenario = EMPTY_OBJECT,
  /**
   * 🧷 2026-09-17 runKey に混ぜない「合図」(ref)。post の直前に scenario へ重ねる。
   *   使い道: 前回の答えの主担当(prevWorkers)。runKey に混ぜると答えが出るたびに鍵が変わって無限に回るので、ここだけ別。
   *   🚨 指紋(normalizeInput の inputFingerprint)にも入らない(前回の答えは「同じ土俵か」の材料ではない)。
   */
  scenarioHints = null,
  /**
   * 🎓 技能試行(決まり19B の材料①)を Worker に回させる合図。
   *   🚨 2026-09-23 本番では runSkillTrials を渡す口が無く 技能試行が一度も出ていなかった。
   *   true の時だけ Worker が「仮に担当記録を付けて割付し直す」(1件 約3秒)。既定 false。
   *   runKey には混ぜない(runKey は保存計画の指紋 parseRunKey が9つで読む)。effect の依存に入れて 押した瞬間に計算し直す。payload では p.runSkillTrials(Worker が読む名前)。
   */
  runSkillTrials = false,
  mode = null,
  horizonDays = DEFAULT_HORIZON_DAYS,
  scopeFilter = null,
  // 工数の見積りモード。P50(通常線) / P75(保険線) / P90(絶対線)。
  // 🚨 モードが違う結果どうしは **比べられない**(入力の指紋に入る / 仕様書5.8)。
  //   だから鍵(runKey)にも payload にも必ず入れる。入れ忘れると、モードを変えても
  //   前の結果が使い回されて「切り替えたのに何も変わらない」になる。
  estimateMode = 'P75',
  // どのシナリオとして回したかの札（'baseline'|'overtime'|'absence'|'all-skills'|'successor'）。
  // 🚨 結果に付けて返すので、画面が「これは通常の結果か」を取り違えない。
  scenarioId = 'baseline',
  /**
   * 基準時刻(epoch ms)。省略可。
   * 🚨 2026-08-30 是正: 以前は基準時刻の口が2つあった。
   *   画面(OperationsSimulationPanel の panelNow) … 絞り込みと休みの日付に使う
   *   このフック(nowMs)                           … 計算へ渡す
   *   この2つは繋がっておらず、rerun() を押すと **こちらだけ** 動いていた。
   *   「今から / 次の勤務開始から」を入れると、その差が数十時間になる。
   *   → 画面が渡してきた時は、こちらは時計を1度も読まない。
   */
  now = null,
} = {}) {
  // 🚨 今の時刻は **1回だけ** 決めて固定する。毎レンダー Date.now() を読むと
  //    入力が同じでも鍵が変わり、計算が終わらなくなる。作り直すのは rerun() の時だけ。
  //    ⚠ これは now を渡されなかった時の控え。渡された時は下の nowMs が採る。
  const [ownNowMs, setOwnNowMs] = useState(() => Date.now());
  // 渡された基準時刻が主。読めない値(null / NaN / 文字列)なら控えを使う。
  // 🚨 Number() で寄せない。Number(null) は 0 になり、1970年を基準に盤が描かれる。
  const givenNow = (typeof now === 'number' && Number.isFinite(now)) ? now : null;
  const nowMs = givenNow == null ? ownNowMs : givenNow;
  const [runToken, setRunToken] = useState(0);
  const [state, setState] = useState(IDLE_STATE);

  const lotList = useMemo(() => (Array.isArray(lots) ? lots.filter(Boolean) : EMPTY_ARRAY), [lots]);
  const templateList = useMemo(() => (Array.isArray(templates) ? templates.filter(Boolean) : EMPTY_ARRAY), [templates]);
  const workerList = useMemo(() => (Array.isArray(workers) ? workers.filter(Boolean) : EMPTY_ARRAY), [workers]);

  const dataKey = useMemo(
    () => fingerprintData(lotList, templateList, workerList, settings),
    [lotList, templateList, workerList, settings],
  );

  // 計算に載せるロット。scopeFilter の入れ物が毎回作り直されても、
  // **選ばれた結果が同じなら鍵は同じ** になるので、余計な作り直しは起きない。
  const scopeIds = useMemo(() => {
    const pick = typeof scopeFilter === 'function' ? scopeFilter : makeDefaultScopeFilter(nowMs);
    const out = [];
    for (const lot of lotList) {
      if (!isOpenLot(lot)) continue;
      let ok = false;
      try { ok = !!pick(lot); } catch { ok = false; }
      if (!ok) continue;
      const id = docIdOf(lot);
      if (id) out.push(id);
    }
    out.sort();
    return out;
  }, [lotList, scopeFilter, nowMs]);

  const scopeKey = useMemo(() => scopeIds.join(','), [scopeIds]);
  const scenarioKey = useMemo(() => stableKey(isObj(scenario) ? scenario : null), [scenario]);
  const modeKey = useMemo(() => (Array.isArray(mode) ? mode.join('+') : str(mode)), [mode]);

  /**
   * 📅 工場の暦の指紋。**登録された日と種類だけ**を見る(一言や書いた人では作り直さない)。
   * 🚨 登録が0件なら空文字。runKey の文字列が今までと変わらないので、
   *   祝日表を入れるまでは1度も余計な作り直しが起きない。
   */
  // 🚨 鍵の作り方の持ち主は domain/factoryCalendar.js ただ一つ。
  //   計算側(normalizeInput)と同じ関数を使う。別々に書くと、片方だけ作り直して
  //   もう片方が前の答えを使い回す(押しても変わらない画面になる)。
  const calendarKey = useMemo(() => calendarFingerprint(factoryCalendar), [factoryCalendar]);

  // 🚨 calendarKey を外すと「祝日を登録しても計算し直さない画面」に戻る。
  //   わざと外して赤になる事を試験(祝日を登録→鍵が変わる)で押さえてある。
  const runKey = [dataKey, scopeKey, nowMs, horizonDays, scenarioKey, modeKey, estimateMode, calendarKey, runToken].join('||');

  // ── 走らせる時に読む値（鍵が変わった時だけ効かせたいので、依存には入れない） ──
  const payloadRef = useRef(null);
  useEffect(() => {
    payloadRef.current = {
      lots: lotList,
      templates: templateList,
      workers: workerList,
      /**
       * 🚨 工場の暦は settings ではなく共通の棚から来るので、ここで **settings に混ぜてから**
       *   エンジンへ渡す。normalizeInput は settings.factoryCalendar を読む決まりなので、
       *   混ぜ忘れると Worker の向こうに暦が1件も届かず、祝日が効かない。
       * ⚠ 生の値をそのまま渡す(関数にしない)。Worker へは構造化複製で渡るので、
       *   関数を入れると黙って消える(2026-08-16 と同じ形の事故になる)。
       */
      settings: isObj(settings)
        ? { ...settings, factoryCalendar: factoryCalendar || settings.factoryCalendar || null }
        : (factoryCalendar ? { factoryCalendar } : null),
      now: nowMs,
      horizonDays,
      scenario: isObj(scenario) ? scenario : {},
      mode,
      estimateMode,
      scenarioId,
      // 🎓 押した時だけ true(Worker は p.runSkillTrials === true の時だけ技能試行を回す)
      runSkillTrials: runSkillTrials === true,
      scopeLotIds: scopeIds,
      dataKey,
    };
  });

  const workerRef = useRef(null);
  const workerReadyRef = useRef(false);
  const workerBrokenRef = useRef(false);
  const bootTimerRef = useRef(null);
  const activeRef = useRef(null);   // { runId, token, finished, onMainThread }
  const runSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const safeSetState = useCallback((updater) => {
    if (!mountedRef.current) return;
    setState(updater);
  }, []);

  const clearBootTimer = useCallback(() => {
    if (bootTimerRef.current != null) {
      clearTimeout(bootTimerRef.current);
      bootTimerRef.current = null;
    }
  }, []);

  const killWorker = useCallback(() => {
    clearBootTimer();
    const w = workerRef.current;
    workerRef.current = null;
    workerReadyRef.current = false;
    if (w) {
      try { w.terminate(); } catch { /* 既に落ちている */ }
    }
  }, [clearBootTimer]);

  const finishRun = useCallback((runId, patch) => {
    const act = activeRef.current;
    if (!act || act.runId !== runId || act.finished) return;
    act.finished = true;
    safeSetState((prev) => ({ ...prev, loading: false, progress: null, ...patch,
      planReceipt: patch.result ? { id: `plan-${runId}-${Date.now()}`, key: act.planRunKey, at: Date.now(), engineVersion: 'product-inspection-20260920' } : null,
    }));
  }, [safeSetState]);

  // ── メインスレッドでやり直す道 ────────────────────────────────────────────
  // 🚨 これは別スレッドではない。画面はこの間止まる。
  //    それでも「計算できません」で終わらせるより、遅くても答えを出す方を選ぶ。
  const runOnMainThread = useCallback(async (runId, payload) => {
    const act = activeRef.current;
    if (!act || act.runId !== runId) return;
    act.onMainThread = true;
    safeSetState((prev) => ({ ...prev, usedFallback: true }));

    const startedAt = Date.now();
    try {
      const mod = await import('./workers/operationsSimulation.worker.js');
      const result = await mod.runOperationsSimulationPipeline(payload, {
        signal: act.token.signal,
        yieldToHost: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
        isCurrent: () => activeRef.current === act && !act.finished,
        onProgress: (phase, label, ratio) => {
          if (activeRef.current !== act) return;
          safeSetState((prev) => ({ ...prev, progress: toProgress(phase, label, ratio) }));
        },
      });
      finishRun(runId, { result, error: null, elapsedMs: Math.round(Date.now() - startedAt) });
    } catch (err) {
      if (act.token.signal.aborted) {
        finishRun(runId, {});
        return;
      }
      const raw = (err && err.message) ? String(err.message) : String(err || '');
      finishRun(runId, {
        result: null,
        error: raw.replace(/\s+/g, ' ').trim().slice(0, 300)
          || '操業シミュレーションの計算が最後まで進みませんでした（理由が取れませんでした）',
      });
    }
  }, [finishRun, safeSetState]);

  // ── Worker が使えなくなった時 ─────────────────────────────────────────────
  const failOverToMainThread = useCallback((why) => {
    killWorker();
    workerBrokenRef.current = true;
    const act = activeRef.current;
    if (!act || act.finished || act.onMainThread) return;
    // 何が起きたかは黙らせない。画面には出さず、開発者向けに1行だけ残す。
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[操業シミュレーション] 別スレッドが使えないので、この画面で計算します:', why);
    }
    const payload = payloadRef.current;
    if (payload) runOnMainThread(act.runId, payload);
  }, [killWorker, runOnMainThread]);

  const handleWorkerMessage = useCallback((ev) => {
    const msg = isObj(ev && ev.data) ? ev.data : null;
    if (!msg) return;
    workerReadyRef.current = true;
    clearBootTimer();
    if (msg.kind === 'ready') return;

    const act = activeRef.current;
    if (!act || act.finished || act.onMainThread) return;
    if (msg.runId !== act.runId) return;      // 古い依頼の返事は捨てる

    if (msg.kind === 'progress') {
      safeSetState((prev) => ({ ...prev, progress: toProgress(msg.phase, msg.label, msg.ratio) }));
      return;
    }
    if (msg.kind === 'aborted') {
      finishRun(act.runId, {});
      return;
    }
    if (msg.ok === true) {
      finishRun(act.runId, {
        result: isObj(msg.result) ? msg.result : null,
        error: null,
        elapsedMs: Number.isFinite(Number(msg.elapsedMs)) ? Math.round(Number(msg.elapsedMs)) : null,
      });
      return;
    }
    if (msg.ok === false) {
      finishRun(act.runId, {
        result: null,
        error: str(msg.error) || '操業シミュレーションの計算が最後まで進みませんでした（理由が取れませんでした）',
      });
    }
  }, [clearBootTimer, finishRun, safeSetState]);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    if (workerBrokenRef.current) return null;
    if (typeof Worker === 'undefined') return null;
    try {
      const w = new Worker(new URL('./workers/operationsSimulation.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = handleWorkerMessage;
      w.onerror = (e) => failOverToMainThread((e && e.message) || 'onerror');
      w.onmessageerror = () => failOverToMainThread('messageerror');
      workerRef.current = w;
      workerReadyRef.current = false;
      // 起動の合図すら返らない端末（古い iPad Safari は module worker を読めない）を見張る。
      clearBootTimer();
      bootTimerRef.current = setTimeout(() => {
        if (!workerReadyRef.current) failOverToMainThread('起動の合図が返りませんでした');
      }, WORKER_BOOT_TIMEOUT_MS);
      return w;
    } catch (e) {
      workerBrokenRef.current = true;
      if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
        console.warn('[操業シミュレーション] 別スレッドを作れませんでした:', e);
      }
      return null;
    }
  }, [clearBootTimer, failOverToMainThread, handleWorkerMessage]);

  // ── 中止 ─────────────────────────────────────────────────────────────────
  const stopActive = useCallback(() => {
    const act = activeRef.current;
    if (!act || act.finished) return;
    act.finished = true;
    act.token.abort();
    const w = workerRef.current;
    if (w && !act.onMainThread) {
      try { w.postMessage({ kind: 'abort', runId: act.runId }); } catch { /* 送れなくても止める */ }
    }
    safeSetState((prev) => ({ ...prev, loading: false, progress: null }));
  }, [safeSetState]);

  const cancel = useCallback(() => { stopActive(); }, [stopActive]);

  const rerun = useCallback(() => {
    stopActive();
    // 🚨 もう一度押した時だけ、今の時刻を取り直す。
    //   ⚠ ただし基準時刻を渡されている時は **触らない**。時計の持ち主は呼ぶ側1人。
    //     ここでも取り直すと、画面が絞り込みに使った時刻と計算に渡る時刻が食い違う。
    if (givenNow == null) setOwnNowMs(Date.now());
    setRunToken((n) => n + 1);
  }, [stopActive, givenNow]);

  // ── 走らせる ─────────────────────────────────────────────────────────────
  // 🚨 実際に効く依存は runKey と enabled の2つだけ。lots などを直に入れると、
  //    Firestore の購読が同じ中身で配列を作り直すたびに8秒の計算をやり直す。
  //    だから中で読む値は payloadRef に入れてある。
  //    下に並んでいる関数は全部 useCallback で入れ物が変わらないので、
  //    並べても走る回数は増えない（見張りを黙らせるより、並べる方を選んだ）。
  useEffect(() => {
    if (!enabled) {
      stopActive();
      return undefined;
    }
    const payload = payloadRef.current;
    if (!payload) return undefined;

    if (payload.scopeLotIds.length === 0) {
      // 🚨 「0件だから守れます」と言わない。載せる物が無い、とだけ言う。
      activeRef.current = null;
      safeSetState((prev) => ({
        ...prev, result: null, loading: false, progress: null, elapsedMs: null,
        error: null,
      }));
      return undefined;
    }

    runSeqRef.current += 1;
    const runId = runSeqRef.current;
    const act = { runId, token: makeAbortToken(), finished: false, onMainThread: false, planRunKey: runKey };
    activeRef.current = act;

    safeSetState((prev) => ({
      ...prev,
      result: null,                 // 前の答えを新しい条件の答えのように見せない
      error: null,
      elapsedMs: null,
      loading: true,
      progress: toProgress('start', '計算をはじめます', 0),
    }));

    // 🧷 合図(prevWorkers 等)は runKey の外。post の直前にだけ重ねる。
    const hints = scenarioHints && scenarioHints.current && typeof scenarioHints.current === 'object' ? scenarioHints.current : null;
    const posted = (hints && Object.keys(hints).length) ? { ...payload, scenario: { ...(payload.scenario || {}), ...hints } } : payload;
    const w = ensureWorker();
    if (w) {
      try {
        w.postMessage({ kind: 'run', runId, ...posted });
      } catch (e) {
        // 別スレッドへ写せない値が混じっていた時。黙って固まらせない。
        failOverToMainThread((e && e.message) || 'postMessage');
      }
    } else {
      runOnMainThread(runId, posted);
    }

    return () => {
      if (act.finished) return;
      act.finished = true;
      act.token.abort();
      const cur = workerRef.current;
      if (cur && !act.onMainThread) {
        try { cur.postMessage({ kind: 'abort', runId }); } catch { /* 送れなくても止める */ }
      }
    };
  }, [runKey, enabled, ensureWorker, failOverToMainThread, runOnMainThread, safeSetState, stopActive, scenarioHints, runSkillTrials]);

  // ── 後片付け ─────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const act = activeRef.current;
      if (act && !act.finished) {
        act.finished = true;
        act.token.abort();
      }
      killWorker();
    };
  }, [killWorker]);

  return {
    result: state.result,
    planReceipt: state.planReceipt || null,
    planRunKey: runKey,
    loading: state.loading,
    progress: state.progress,
    error: state.error,
    elapsedMs: state.elapsedMs,
    usedFallback: state.usedFallback,
    cancel,
    rerun,
  };
}

export default useOperationsSimulation;
