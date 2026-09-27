// 分析用の全件ページング取得 (純ロジック部分)。
// 背景(仕様4.2): 作業画面の常時購読は limit(500) — 現場の軽さのためこれは維持する。
//   しかし分析(年間目標/90日ベースライン/月次/前年比)が同じ500件を使うと、総ロットが500件を超えた日から黙って数字が欠ける。
//   → 分析側はこのページャで全件を取得し、画面に「全件/一部」を明示する。
export const fetchAllPaged = async (fetchPage, { pageSize = 500, maxPages = 40 } = {}) => {
  const all = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const { items, nextCursor } = await fetchPage({ cursor, pageSize });
    all.push(...(items || []));
    if (!nextCursor || (items || []).length < pageSize) return { items: all, complete: true, pages: i + 1 };
    cursor = nextCursor;
  }
  // maxPages(既定2万件)まで読んでも尽きない場合は「一部」と正直に返す(確定金額は出さない側で制御)
  return { items: all, complete: false, pages: maxPages };
};

// 履歴スナップショット(全件) と ライブ購読(直近500件) の合成。同じidはライブ優先(最新状態)。
export const mergeLotsById = (historical, live) => {
  const map = new Map();
  (historical || []).forEach(l => { if (l && l.id) map.set(l.id, l); });
  (live || []).forEach(l => { if (l && l.id) map.set(l.id, l); });
  return [...map.values()];
};
