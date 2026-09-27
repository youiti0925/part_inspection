// ⏱ 到着予定の「処理に要る時間(見込み)」まわりの小物（純関数・画面部品なし）。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   置き場所は 両方とも src/domain/incomingWork.js（IncomingArrivals.jsx と同じやり方）。
//
// なぜここに居るか(2026-08-29): もとは IncomingArrivals.jsx が export していたが、
//   画面部品のファイルに関数の export が同居すると react-refresh/only-export-components に
//   当たる(直し方は「新しいファイルへ分ける」が正)。使う側(App本体・IncomingArrivals.jsx)は
//   ここから直接 import する。IncomingArrivals.jsx からは出し直さない(出し直すと同じ規則に当たる)。

// ⏱ 処理見込み秒 → 「約1時間20分」。⚠0以下は '' = **時間の作り話をしない**(出せない時は出さない)。
export const fmtWorkSec = (sec) => {
    const s = Number(sec) || 0;
    if (s <= 0) return '';
    const m = Math.max(1, Math.round(s / 60));
    const h = Math.floor(m / 60), mm = m % 60;
    return h > 0 ? `約${h}時間${mm > 0 ? `${mm}分` : ''}` : `約${mm}分`;
};

// まだ1台も手を付けていないか = 「検査ぶん満額の見込み」を出してよいロットか。
// ⚠検査中のロットに満額を出すと「残り」より大きい嘘になるので、呼ぶ側はこれで絞る。
export const isUntouchedLot = (lot) => !!lot && !Object.values(lot.tasks || {}).some(
    t => t && (t.status === 'completed' || t.status === 'processing' || t.status === 'ng' || Number(t.duration) > 0));
