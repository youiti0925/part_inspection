// 🧑‍🔧 「誰が検査をするか」の割付(Fable の見本 alloc.mjs と同じ式)。純関数: 同じ入力 → 同じ答え。時計・乱数・通信なし。
// 目的: 検査に着く日が出た指図(いつ来るか)を、着いた物から リミットの早い順に、一番早く手が空く人へ割り付ける。手が空く時間とその理由も出す。
// 入力: arrivalForecast の rows(arrive・limit・ih=検査の時間 h など)・検査員の名前(本物のデータの口・無ければ作り物の名前)・今日の曜日(dow0)
// 出力: { jobs:[{…, who, t0, t1, pieces, overDays, seq}], gaps:[{who, a, b, min, kind, nextReady}], skipped:{stuck, unknown, far} }
// 時刻は「今日 0:00 からの分」。1 日 = 1440。勤務は 8:30〜17:15・昼 45 分・15 時 15 分 = 465 分。
// 確かめ方: node --test src/domain/__tests__/sapInspectAlloc.test.mjs
export const WORK = Object.freeze({ start: 510, end: 1035, breaks: [[720, 765], [900, 915]] });   // 8:30〜17:15・昼 45 分・15 時 15 分 = 465 分
export const ASSUMED_MIN = 60;                               // 検査の標準値が 0 の指図は 仮に 60 分(札で「仮」と出す)
const isWork = (dow0, day) => { const w = (((dow0 + day) % 7) + 7) % 7; return w !== 0 && w !== 6; };
/** その日の働ける区間(分)。休みは [] */
export const windowsOf = (dow0, day) => {
  if (!isWork(dow0, day)) return [];
  const cuts = [WORK.start, ...WORK.breaks.flat(), WORK.end]; const out = [];
  for (let i = 0; i < cuts.length; i += 2) out.push([day * 1440 + cuts[i], day * 1440 + cuts[i + 1]]);
  return out;
};
/** t から dur 分の仕事を 勤務の窓に置く → [[a,b],…] */
export function place(dow0, t, dur) {
  const pieces = []; let left = dur; let day = Math.floor(t / 1440);
  for (let guard = 0; left > 0 && guard < 400; guard++, day++) {
    for (const [a, b] of windowsOf(dow0, day)) {
      const s = Math.max(a, t); if (s >= b) continue;
      const e = Math.min(b, s + left); pieces.push([s, e]); left -= e - s; if (left <= 0) break;
    }
  }
  return pieces;
}
/** t 以降で最初に働ける時刻 */
export function nextWorkT(dow0, t) {
  let day = Math.floor(t / 1440);
  for (let guard = 0; guard < 400; guard++, day++) for (const [a, b] of windowsOf(dow0, day)) if (t < b) return Math.max(a, t);
  return t;
}
export function allocate({ rows, inspectors, dow0, horizonDays = 45, nowMin = WORK.start }) {
  const pool = rows.filter((r) => (r.kind === 'here' || r.kind === 'bar') && r.arrive <= horizonDays).map((r) => ({
    r, ready: nextWorkT(dow0, r.kind === 'here' ? nowMin : Math.max(nowMin, r.arrive * 1440 + WORK.start)),
    dur: r.ih != null ? Math.max(5, Math.round(r.ih * 60)) : ASSUMED_MIN, assumed: r.ih == null,
  }));
  const free = inspectors.map(() => nextWorkT(dow0, nowMin));
  const jobs = []; const seq = inspectors.map(() => 0);
  let rest = pool.slice();
  while (rest.length) {
    // 一番早く手が空く人
    let i = 0; for (let k = 1; k < free.length; k++) if (free[k] < free[i]) i = k;
    let t = free[i];
    let cands = rest.filter((j) => j.ready <= t);
    if (!cands.length) { t = Math.min(...rest.map((j) => j.ready)); cands = rest.filter((j) => j.ready <= t); }
    // 着いている物の中で リミットの早い順 → 着いた順 → 指図番号
    cands.sort((a, b) => (a.r.limit ?? 9999) - (b.r.limit ?? 9999) || a.ready - b.ready || (a.r.o < b.r.o ? -1 : 1));
    const j = cands[0]; rest = rest.filter((x) => x !== j);
    const pieces = place(dow0, t, j.dur); const t1 = pieces[pieces.length - 1][1];
    const endDay = Math.floor(t1 / 1440);
    jobs.push({ o: j.r.o, it: j.r.it, tx: j.r.tx, q: j.r.q, kind: j.r.kind, arrive: j.r.arrive, limit: j.r.limit, ship: j.r.ship, late: j.r.late,
      who: inspectors[i], seq: ++seq[i], ready: j.ready, t0: pieces[0][0], t1, pieces, dur: j.dur, assumed: j.assumed,
      overDays: j.r.limit != null && endDay > j.r.limit ? endDay - j.r.limit : null });
    free[i] = nextWorkT(dow0, t1);
  }
  // 手が空く時間: 勤務の窓のうち 仕事の入っていない所(続きはまとめる)。理由 = 次の物がまだ着いていない / もう物が無い
  const gaps = [];
  inspectors.forEach((who) => {
    const mine = jobs.filter((j) => j.who === who).sort((a, b) => a.t0 - b.t0);
    const busy = mine.flatMap((j) => j.pieces);
    let cur = null;
    for (let day = 0; day <= horizonDays; day++) for (const [a, b] of windowsOf(dow0, day)) {
      let s = Math.max(a, nowMin);
      const inWin = busy.filter(([x, y]) => y > a && x < b).sort((p, q2) => p[0] - q2[0]);
      const frees = []; for (const [x, y] of inWin) { if (x > s) frees.push([s, x]); s = Math.max(s, y); } if (s < b) frees.push([s, b]);
      for (const [x, y] of frees) {
        const touches = cur && !busy.some(([p, q2]) => p >= cur.b && q2 <= x && q2 > p);
        if (touches) { cur.b = y; cur.min += y - x; } else { cur = { who, a: x, b: y, min: y - x }; gaps.push(cur); }
      }
    }
    gaps.filter((g) => g.who === who).forEach((g) => { const nx = mine.find((j) => j.t0 >= g.b - 1); g.kind = nx ? 'arrival' : 'nojob'; g.nextReady = nx ? Math.floor(nx.ready / 1440) : null; });
  });
  return { jobs, gaps: gaps.filter((g) => g.min >= 15), skipped: { stuck: rows.filter((r) => r.kind === 'stuck').length, unknown: rows.filter((r) => r.kind === 'unknown').length, far: rows.filter((r) => r.kind === 'bar' && r.arrive > horizonDays).length } };
}
