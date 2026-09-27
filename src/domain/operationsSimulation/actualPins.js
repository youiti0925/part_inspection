// =============================================================================
//  operationsSimulation/actualPins.js — 現場で手が付いたロットは「実際の担当」のまま
// -----------------------------------------------------------------------------
//  🚨 2026-09-18 清水さんの言葉「配置ボタンしたら、次開いたら忘れてることある」
//    ＝ 同じ入力でも 開き直すと担当が入れ替わって見える(答えが揺れる)。
//    現場ではもう手が付いているのだから、その人のまま出すのが正しい。
//
//  ここがやる事は1つだけ:
//    **記録(tasks)に残っている実際の担当を読み、ロット→名前 の表にする。**
//    数は作らない・時刻を1つも読まない(Date.now を呼ばない)・元データへ1バイトも書かない。
//
//  使い道(呼ぶ側):
//    keepDecided(固定が既定・既定 ON)の時 scenario.pins = { ...actualPins, ...manualPins }
//    ＝ **手で決めた固定の方が強い**(手の固定が在ればそちらが勝つ)。
//    OFF の時は1バイトも渡さない ＝ 今までと1ミリも同じ計算。
//
//  🚨 製品検査と最終検査で **同じファイル**(md5 一致)。片方だけ変えない。
//    そのために import を1つも持たない(どちらのアプリの事情も知らない)。
// =============================================================================

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** ロットの id。__id(書類の id)が在ればそちら、無ければ id。 */
export const lotIdOf = (lot) => (isObj(lot) ? (str(lot.__id) || str(lot.id)) : '');

/**
 * このロットは「まだ終わっていない」か。
 * 🚨 呼ぶ側が isOpen を渡した時は **その判定だけ** を使う(アプリごとの決め方をここで作り直さない)。
 *   渡されなかった時だけ、両アプリに共通で在る欄(location / completedAt)で見る。
 *   ⚠ 元データに無い値を推測で埋めない。読めない時は「終わっていない」側に置かない(数に入れない)。
 */
export function isOpenLotForPins(lot, isOpen = null) {
  if (typeof isOpen === 'function') return !!isOpen(lot);
  if (!isObj(lot)) return false;
  if (str(lot.location) === 'completed') return false;
  if (lot.completedAt != null && str(lot.completedAt) !== '') return false;
  return true;
}

/**
 * 1件の記録(task)に付いている担当の名前。
 * 🚨 1件を2人で分けた記録(sessions が2人)も在る。その時は **分数のぶん だけ その人に足す**
 *   ようにしたいが、記録に1件ごとの分数が無い(sessions は時刻だけ の物も在る)。
 *   だから「分けられる時は分ける・分けられない時は task 全体を1人に乗せる」の2通りだけにする。
 * @returns {Array<{name:string, sec:number}>} 空配列＝名前が読めない(数に入れない)
 */
export function creditsOfTask(task) {
  if (!isObj(task)) return [];
  const out = [];
  // ① sessions ごとに 時刻の差が読める時は、その差をその人に足す。
  let sessionSec = 0;
  for (const s of asArray(task.sessions)) {
    if (!isObj(s)) continue;
    const n = str(s.workerName);
    if (!n) continue;
    const a = Number(s.startTime);
    const b = Number(s.endTime);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      const sec = (b - a) / 1000;
      out.push({ name: n, sec });
      sessionSec += sec;
    } else {
      out.push({ name: n, sec: 0 });
    }
  }
  // ② sessions から1秒も読めなかった時だけ、task 全体の分数を task.workerName に乗せる。
  //   🚨 ①と②を足すと **二重計上** になる(2026-09-10 の「修正の二重計上」と同じ形)。だから排他。
  const own = str(task.workerName);
  if (sessionSec <= 0) {
    const d = Number(task.duration);
    const sec = Number.isFinite(d) && d > 0 ? d : 0;
    if (own) {
      const hit = out.find((x) => x.name === own);
      if (hit) hit.sec += sec;
      else out.push({ name: own, sec });
    }
  } else if (own && !out.some((x) => x.name === own)) {
    out.push({ name: own, sec: 0 });
  }
  return out;
}

/**
 * 現場で手が付いたロット → 実際の担当(記録の分数が一番長い人)。
 *
 * @param {Array} lots ロットの並び(この画面が持っている物をそのまま)
 * @param {object} [o]
 * @param {Function|null} [o.isOpen] 「まだ終わっていない」の判定(アプリの物を渡す)
 * @returns {object} { [lotId]: workerName }。1件も無ければ {}
 *
 * 決め方:
 *   ・status が 'completed' の記録だけを見る(途中の物は「手が付いた」に数えない)。
 *   ・同じ分数で並んだ時は **先に記録した人**(記録の並びで先に出て来た人)。
 *   ・名前が1つも読めないロットは表に載せない(「分かりません」を担当として出さない)。
 */
export function actualWorkerPinsOf(lots, { isOpen = null } = {}) {
  const out = {};
  for (const lot of asArray(lots)) {
    if (!isOpenLotForPins(lot, isOpen)) continue;
    const id = lotIdOf(lot);
    if (!id) continue;
    const tasks = isObj(lot.tasks) ? lot.tasks : null;
    if (!tasks) continue;
    /** 名前 → { sec, order }。order は初めて出て来た順(同点の勝者を決める)。 */
    const by = new Map();
    let order = 0;
    for (const key of Object.keys(tasks)) {
      const task = tasks[key];
      if (!isObj(task)) continue;
      if (str(task.status) !== 'completed') continue;
      for (const c of creditsOfTask(task)) {
        const cur = by.get(c.name);
        if (cur) cur.sec += c.sec;
        else { by.set(c.name, { sec: c.sec, order }); order += 1; }
      }
    }
    if (!by.size) continue;
    let best = '';
    let bestSec = -1;
    let bestOrder = Number.POSITIVE_INFINITY;
    for (const [name, v] of by.entries()) {
      if (v.sec > bestSec || (v.sec === bestSec && v.order < bestOrder)) {
        best = name; bestSec = v.sec; bestOrder = v.order;
      }
    }
    if (best) out[id] = best;
  }
  return out;
}

/**
 * 画面の札の1文。🚨 数はここで作らない(受け取った表の件数をそのまま言う)。
 * @param {object} pins actualWorkerPinsOf の戻り
 */
export function actualPinsText(pins) {
  const n = isObj(pins) ? Object.keys(pins).length : 0;
  if (n <= 0) return '手が付いたロットはまだありません';
  return `手が付いた ${n.toLocaleString('ja-JP')}件はその人のまま`;
}

export default actualWorkerPinsOf;
