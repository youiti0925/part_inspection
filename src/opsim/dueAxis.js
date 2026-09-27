// =============================================================================
//  src/opsim/dueAxis.js — 納期一覧の横軸（日の列）。純関数・React を知らない。
// -----------------------------------------------------------------------------
//  🚨 決まり14-1（2026-09-03 清水さん）「休日挟むとゲージが伸びるので見づらいから、
//     一旦休みの際はゲージはそこだけ消す方がみやすい」
//
//  ・列は1日1本。休みの日（isWorkday が false）は幅を offWeight 倍に縮め、棒を置かない。
//  ・営業日の列の中は「勤務の窓（startMin〜endMin）」を列の幅に写す。
//    8:30 に始まる棒は列の左端、17:15 に終わる棒は列の右端。夜は描かない。
//  ・segmentsOf は棒を **営業日ごとに切って** 返す。金曜の 15:00 から月曜の 10:00 の仕事は
//    金曜の棒と月曜の棒の2本になり、土日は空白。
//  🚨 isWorkday は計算で使った暦（calendar.isWorkday）を渡す。ここで曜日だけで決めない。
//  🚨 Date.now() を読まない。
// =============================================================================
const MS_DAY = 86400000;
const MS_MIN = 60000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const WD = ['日', '月', '火', '水', '木', '金', '土'];

const localDayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const nextDay = (dayMs) => {
  const d = new Date(dayMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 日の列を作る。
 * @param {object} o
 * @param {number} o.fromMs 見ている範囲の始まり
 * @param {number} o.toMs   見ている範囲の終わり
 * @param {function|null} [o.isWorkday] 計算で使った暦。無ければ土日を休みとする
 * @param {number} [o.offWeight=0.35] 休みの列の幅（営業日を 1 とした比）
 * @param {number} [o.startMin=510] 勤務の窓の始まり（0:00 からの分。8:30 = 510）
 * @param {number} [o.endMin=1035]  勤務の窓の終わり（17:15 = 1035）
 * @returns {Array<{ms:number, endMs:number, off:boolean, left:number, width:number, label:string, wd:string, winStartMs:number, winEndMs:number}>}
 */
export function buildDayColumns({ fromMs, toMs, isWorkday = null, offWeight = 0.35, startMin = 510, endMin = 1035 } = {}) {
  if (!isNum(fromMs) || !isNum(toMs) || toMs <= fromMs) return [];
  const w = isNum(offWeight) && offWeight >= 0 ? offWeight : 0.35;
  const s = isNum(startMin) ? startMin : 510;
  const e = isNum(endMin) && endMin > s ? endMin : Math.max(s + 1, 1035);
  // 🚨 休みの判定は **計算で使った暦（calendar.isWorkday）だけ**。ここで曜日を見て決めない
  //   （祝日・登録された休みを盤だけが無視して、同じ画面で営業日の数が2通りになる）。
  //   暦が渡されなければ全部を営業日として描く＝「休みを引いていない」のが見えて分かる形。
  const judge = typeof isWorkday === 'function' ? isWorkday : () => true;
  const days = [];
  let guard = 0;
  for (let t = localDayStart(fromMs); t < toMs && guard < 400; t = nextDay(t), guard += 1) {
    let on = false;
    try { on = !!judge(t); } catch { on = false; }
    days.push({ ms: t, endMs: nextDay(t), off: !on });
  }
  const total = days.reduce((a, d) => a + (d.off ? w : 1), 0) || 1;
  let acc = 0;
  return days.map((d) => {
    const width = ((d.off ? w : 1) / total) * 100;
    const left = (acc / total) * 100;
    acc += d.off ? w : 1;
    const dt = new Date(d.ms);
    return {
      ms: d.ms,
      endMs: d.endMs,
      off: d.off,
      left,
      width,
      label: `${dt.getMonth() + 1}/${dt.getDate()}`,
      wd: WD[dt.getDay()],
      winStartMs: d.ms + s * MS_MIN,
      winEndMs: d.ms + e * MS_MIN,
    };
  });
}

/** 列の中の位置（%）。営業日は勤務の窓を列の幅に写す。休みの日は1日を丸ごと列に写す。 */
export function xOf(cols, ms) {
  if (!Array.isArray(cols) || !cols.length || !isNum(ms)) return null;
  const first = cols[0];
  const last = cols[cols.length - 1];
  if (ms <= first.ms) return 0;
  if (ms >= last.endMs) return 100;
  for (const c of cols) {
    if (ms < c.ms || ms >= c.endMs) continue;
    if (c.off) return c.left + ((ms - c.ms) / (c.endMs - c.ms)) * c.width;
    const span = c.winEndMs - c.winStartMs;
    const frac = span > 0 ? Math.min(1, Math.max(0, (ms - c.winStartMs) / span)) : 0;
    return c.left + frac * c.width;
  }
  return null;
}

/**
 * 棒を営業日ごとに切る。休みの日は1本も返さない（＝そこだけゲージが消える）。
 * @returns {Array<{dayMs:number, startMs:number, endMs:number, left:number, width:number}>}
 */
export function segmentsOf(cols, startMs, endMs) {
  const out = [];
  if (!Array.isArray(cols) || !isNum(startMs) || !isNum(endMs) || endMs <= startMs) return out;
  for (const c of cols) {
    if (c.off) continue;
    if (c.endMs <= startMs || c.ms >= endMs) continue;
    const s = Math.max(startMs, c.winStartMs);
    const e = Math.min(endMs, c.winEndMs);
    if (!(e > s)) continue;
    const l = xOf(cols, s);
    const r = xOf(cols, e);
    if (l == null || r == null || !(r > l)) continue;
    out.push({ dayMs: c.ms, startMs: s, endMs: e, left: l, width: r - l });
  }
  return out;
}

const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
};

/**
 * 勤務の窓（0:00 からの分）を、計算で使った暦の spec（makeCalendar().spec）から出す。
 *   始まり = dayStartHHMM
 *   終わり = 始まり + directMinutesPerDay + 休憩の合計（＝暦が実際に勤務としている最後の時刻）
 * 🚨 ここで 17:00 などを直書きしない。残業（directMinutesPerDay が大きい）なら窓も自然に伸びる。
 * spec が読めなければ 8:30〜16:40（420分＋休憩70分）。
 */
/**
 * 割付の区間([startMs,endMs] の並び)を **重なり・接触をまとめて** 時刻順に返す。
 * 🚨 2026-09-10 清水さん「青い線が無駄に長いときがある」。
 *   納期一覧の棒は「一番早い始まり〜一番遅い終わり」を1本に塗っていたので、
 *   他のロットを挟んで手を付けていない日まで青かった。棒は **手が付いている区間だけ**。
 *   ここは純関数。読めない区間(数でない・終わりが始まり以下)は捨てる。
 * @param {Array<[number,number]>} spans
 * @returns {Array<[number,number]>}
 */
export function mergeSpans(spans) {
  const list = (Array.isArray(spans) ? spans : [])
    .map((x) => (Array.isArray(x) ? [Number(x[0]), Number(x[1])] : null))
    .filter((x) => x && isNum(x[0]) && isNum(x[1]) && x[1] > x[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) { if (e > last[1]) last[1] = e; }
    else out.push([s, e]);
  }
  return out;
}

export function workWindowOfSpec(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const startMin = parseHHMM(s.dayStartHHMM) ?? 510;
  const direct = isNum(Number(s.directMinutesPerDay)) && Number(s.directMinutesPerDay) > 0 ? Number(s.directMinutesPerDay) : 420;
  const breaks = Array.isArray(s.breaks) ? s.breaks : [];
  let breakMin = 0;
  breaks.forEach((b) => {
    const a = parseHHMM(b && b.start); const z = parseHHMM(b && b.end);
    if (a != null && z != null && z > a) breakMin += z - a;
  });
  if (!breaks.length) breakMin = 70;
  return { startMin, endMin: startMin + direct + breakMin };
}

/** 今日の列（nowMs を含む列）。無ければ null。 */
export function columnAt(cols, ms) {
  if (!Array.isArray(cols) || !isNum(ms)) return null;
  return cols.find((c) => ms >= c.ms && ms < c.endMs) || null;
}

export default buildDayColumns;
