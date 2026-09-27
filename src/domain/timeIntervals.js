// 時間区間の集合演算 (純関数)。自動運転中評価の土台。
// ⚠重なりは必ず和集合(merge)にしてから交差を取る。区間ごとに加算して最後に上限で切ると水増しになる
//   (実測バグ: 手動A 10:00-10:30 と 手動B 10:00-10:30 を足して60分=100% と表示していた。正しくは30分=50%)。
// 区間は { start, end } (ミリ秒)。end <= start は無効として捨てる。

export const mergeIntervals = (intervals) => {
  const xs = (intervals || [])
    .filter(x => x && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (!last || x.start > last.end) out.push({ start: x.start, end: x.end });
    else last.end = Math.max(last.end, x.end);
  }
  return out;
};

export const intersectIntervals = (base, covers) => {
  const a = mergeIntervals(base);
  const b = mergeIntervals(covers);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end <= b[j].end) i += 1; else j += 1;
  }
  return out;
};

// base から removed を差し引く (休憩・監視・計画手待ちを順に除外するのに使う)
export const subtractIntervals = (base, removed) => {
  const a = mergeIntervals(base);
  const b = mergeIntervals(removed);
  const out = [];
  let j = 0;
  for (const seg of a) {
    let cursor = seg.start;
    while (j < b.length && b[j].end <= cursor) j += 1;
    let k = j;
    while (k < b.length && b[k].start < seg.end) {
      if (b[k].start > cursor) out.push({ start: cursor, end: Math.min(b[k].start, seg.end) });
      cursor = Math.max(cursor, b[k].end);
      if (cursor >= seg.end) break;
      k += 1;
    }
    if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
  }
  return out.filter(x => x.end > x.start);
};

export const durationMs = (intervals) =>
  mergeIntervals(intervals).reduce((sum, x) => sum + (x.end - x.start), 0);
