// 操業シミュレーションの時間軸配置だけを扱う純関数。
// CSSの実寸と重なり計算を同じ定数から出し、見た目だけカードが重なる事故を防ぐ。
export const TIMELINE_LAYOUT = Object.freeze({
  boardMinRem: 56,
  stickyColumnsRem: 20, // 作業者9rem + 「これから」11rem
  axisRemPerHour: 7,
  boardExtraRem: 22,
  timeBarMinRem: 11,
  timeBarGapRem: 0.75,
});

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const timelineBoardMinWidthRem = (axisSpanMs) => {
  const hours = positive(axisSpanMs, 1) / 3600000;
  return Math.max(
    TIMELINE_LAYOUT.boardMinRem,
    hours * TIMELINE_LAYOUT.axisRemPerHour + TIMELINE_LAYOUT.boardExtraRem,
  );
};

export const timelineMinVisualRatio = (axisSpanMs) => {
  const boardRem = timelineBoardMinWidthRem(axisSpanMs);
  const timeAxisRem = Math.max(1, boardRem - TIMELINE_LAYOUT.stickyColumnsRem);
  return Math.min(
    1,
    (TIMELINE_LAYOUT.timeBarMinRem + TIMELINE_LAYOUT.timeBarGapRem) / timeAxisRem,
  );
};

export const packTimelineRows = (inputBars, axisSpanMs) => {
  const bars = Array.isArray(inputBars) ? inputBars.slice() : [];
  const spanMs = positive(axisSpanMs, 1);
  const minVisualMs = spanMs * timelineMinVisualRatio(spanMs);
  const rowEnds = [];

  bars.sort((a, b) => positive(a && a.s, 0) - positive(b && b.s, 0));

  return bars.map((bar) => {
    const start = Number(bar && bar.s) || 0;
    const end = Number(bar && bar.e) || start;
    const visualEnd = Math.max(end, start + minVisualMs);
    let row = rowEnds.findIndex((rowEnd) => rowEnd <= start);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(visualEnd);
    } else {
      rowEnds[row] = visualEnd;
    }
    return { ...bar, row };
  });
};
