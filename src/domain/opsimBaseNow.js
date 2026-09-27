// =============================================================================
//  opsimBaseNow.js — 操業シミュレーションの「基準時刻」を決める（純関数だけ）
// -----------------------------------------------------------------------------
//  出典: 清水さんの指摘（2026-08-30）原文
//    「夜に開くと全員が『勤務時間外』になります。計画用途なら、
//      今から ／ 次の勤務開始から を切り替えられるようにすると、
//      盤面がかなり理解しやすくなります」
//
//  ■ このファイルが持つ責任はただ1つ
//    「実時計の時刻」と「画面で選んだ基準の決め方」から、
//    シミュレーションへ渡す基準時刻(epoch ms)を1つ決める。それだけ。
//
//  🚨 暦の決まりを1つも発明していない。
//    ・何曜日が勤務日か / 1日に何分働けるか … domain/operationsSimulation/policy.js
//    ・始業・休憩・その日いつまで働けるか   … domain/operationsSimulation/calendar.js
//    ・勤務表の既定値                       … domain/dueDefense.js の DEFAULT_WORK_SCHEDULE
//    ここは上の3つを **そのまま呼ぶだけ**。新しい時刻の決まりはこのファイルに1行も無い。
//
//  🚨 「次の勤務開始」の実体は calendar.addDirectWorkMs(from, 0)。
//    calendar.js の原文コメント(:568-571)がこう決めている:
//      「workMs=0 は『今すぐ働けるならその時刻、働けないなら次に働ける時刻』」
//    だから
//      ・勤務時間の中で押した時は 実時計の時刻がそのまま返る（値が動かない＝2回押しても同じ）
//      ・夜中・休憩中・土日に押した時だけ 次に働ける時刻へ進む
//
//  🚨 残業シナリオでも基準時刻を動かさない。
//    使うのは policy の **通常** の分数(既定420分)だけ。
//    仕様書5.8「比べてよいのは基準時刻が同じ時だけ」を守るため、
//    基準時刻はシナリオ(残業/欠員/教育/任せ替え)で1ミリも変わってはいけない。
//    ＝ この関数は scenario を1つも読まない。
//
//  ■ 決め事
//   - React / Firebase を import しない。
//   - 関数の中で現在時刻を取らない。時刻は必ず引数で受ける（同じ入力なら毎回同じ結果）。
//   - 決められない時は黙って適当な時刻を作らない。null を返して、呼ぶ側に言わせる。
// =============================================================================
import { makeCalendar } from './operationsSimulation/calendar.js';
import { resolveOperationPolicy } from './operationsSimulation/policy.js';
import { DEFAULT_WORK_SCHEDULE } from './dueDefense.js';

/**
 * 基準時刻の決め方。画面の2択と、この2つが1対1で対応する。
 *   NOW        … 実時計の今そのまま（今までの挙動。既定）
 *   NEXT_START … 今が勤務時間の中ならそのまま／外なら次に働ける時刻
 */
export const BASE_TIME_MODE = Object.freeze({
  NOW: 'now',
  NEXT_START: 'next-start',
});

/** 画面に出す短い名前。文言はここ1箇所で持つ（画面と報告で字が食い違わないように）。 */
export const BASE_TIME_MODE_LABEL = Object.freeze({
  [BASE_TIME_MODE.NOW]: '今から',
  [BASE_TIME_MODE.NEXT_START]: '次の勤務開始から',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * 実時刻(epoch ms)として受け取ってよい値か。
 * 🚨 Number() で寄せない。Number(null) は 0、Number('') も 0 になり、
 *   1970年1月1日を基準時刻にしたまま盤が描かれる（そのまま数字が出るので誰も気づけない）。
 */
const isEpochMs = (v) => typeof v === 'number' && Number.isFinite(v);
/** 'HH:MM' の形かどうかだけを見る。中身の意味は calendar.js が判定する。 */
const isHHMM = (v) => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());

/**
 * 基準時刻を出すためだけのカレンダー設定を組み立てる。
 *
 * ⚠ normalizeInput.js の calendarSpec と **同じ材料・同じ既定** から作る。
 *   （policy の workdays ／ settings.workSchedule の dayStart・dayEnd・breaks ／
 *     読めない値は DEFAULT_WORK_SCHEDULE へ落とす、まで同じ）
 *   違うのは分数だけで、ここは必ず policy の **通常** の分数を使う（上の🚨の理由）。
 *
 * @param {object|null} settings アプリの設定（無くてもよい。既定で組む）
 * @returns {object} makeCalendar に渡せる形
 */
export function baseCalendarSpecOf(settings) {
  const { policy } = resolveOperationPolicy(settings);
  const cfg = isObj(settings) ? settings : {};
  const schedule = isObj(cfg.workSchedule) ? cfg.workSchedule : DEFAULT_WORK_SCHEDULE;

  const dayStartHHMM = isHHMM(schedule.dayStart) ? String(schedule.dayStart).trim() : DEFAULT_WORK_SCHEDULE.dayStart;
  const dayEndHHMM = isHHMM(schedule.dayEnd) ? String(schedule.dayEnd).trim() : DEFAULT_WORK_SCHEDULE.dayEnd;
  const rawBreaks = Array.isArray(schedule.breaks) ? schedule.breaks : DEFAULT_WORK_SCHEDULE.breaks;
  const breaks = rawBreaks
    .filter((b) => isObj(b) && isHHMM(b.start) && isHHMM(b.end))
    .map((b) => ({ start: String(b.start).trim(), end: String(b.end).trim() }));

  const minutes = Number(policy.regularDirectMinutesPerDay);
  return {
    directMinutesPerDay: minutes,
    dailyHours: minutes / 60,
    workdays: [...policy.workdays],
    dayStartHHMM,
    dayEndHHMM,
    breaks,
  };
}

/**
 * fromMs から見た「次に働ける時刻」。
 *   ・fromMs が勤務時間の中なら fromMs そのもの（＝2回通しても値が動かない）
 *   ・夜間・休憩中・土日なら、次に働ける時刻
 *
 * 🚨 中身は calendar.addDirectWorkMs(fromMs, 0) ただ1行。ここで暦を数え直さない。
 * 🚨 誰の休みも見ない（人の名前を渡さない）。基準時刻は全員に共通の1つでないと、
 *   盤の現在線と作業者の行がズレる。
 *
 * @param {number} fromMs 実時計の時刻(epoch ms)
 * @param {object|null} settings アプリの設定
 * @returns {number|null} 次に働ける時刻。設定が読めず決められない時は null
 */
export function nextWorkStartMs(fromMs, settings) {
  if (!isEpochMs(fromMs)) return null;
  try {
    const cal = makeCalendar(baseCalendarSpecOf(settings));
    const at = cal.addDirectWorkMs(fromMs, 0);
    return Number.isFinite(at) ? at : null;
  } catch {
    // 勤務表の設定が読めない時。ここで適当な時刻を作ると、その嘘のまま盤が描かれる。
    return null;
  }
}

/**
 * 画面の2択から、実際に使う基準時刻を1つ決める。
 *
 * @param {object}      args
 * @param {number}      args.wallNowMs 実時計の時刻(epoch ms)。🚨 必ず実時計を起点にする
 *                      （前の基準から進めると、押すたび先へ行ってしまう）
 * @param {string}      [args.mode]    BASE_TIME_MODE のどれか。読めない値は NOW 扱い
 * @param {object|null} [args.settings]
 * @returns {{
 *   mode:string, baseNowMs:number, wallNowMs:number,
 *   nextStartMs:number|null, shifted:boolean, resolved:boolean
 * }}
 *   baseNowMs  … シミュレーションへ渡す基準時刻
 *   shifted    … 実時計より後ろへ動かしたか（画面の但し書きを出すかどうかの判断に使う）
 *   resolved   … 「次の勤務開始」を決められたか。false なら実時計のまま動かしていない
 */
export function resolveBaseNow({ wallNowMs, mode = BASE_TIME_MODE.NOW, settings = null } = {}) {
  if (!isEpochMs(wallNowMs)) {
    throw new Error('opsimBaseNow: resolveBaseNow には実時計の時刻(epoch ms)を渡してください');
  }
  const wall = wallNowMs;
  const want = mode === BASE_TIME_MODE.NEXT_START ? BASE_TIME_MODE.NEXT_START : BASE_TIME_MODE.NOW;
  if (want === BASE_TIME_MODE.NOW) {
    return {
      mode: BASE_TIME_MODE.NOW,
      baseNowMs: wall,
      wallNowMs: wall,
      nextStartMs: null,
      shifted: false,
      resolved: true,
    };
  }
  const next = nextWorkStartMs(wall, settings);
  if (next == null) {
    return {
      mode: BASE_TIME_MODE.NEXT_START,
      baseNowMs: wall,
      wallNowMs: wall,
      nextStartMs: null,
      shifted: false,
      resolved: false,
    };
  }
  return {
    mode: BASE_TIME_MODE.NEXT_START,
    baseNowMs: next,
    wallNowMs: wall,
    nextStartMs: next,
    shifted: next > wall,
    resolved: true,
  };
}

export default resolveBaseNow;
