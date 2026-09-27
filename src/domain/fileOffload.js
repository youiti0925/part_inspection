// 📄 資料(作業標準)のPDFを「設定」の箱から外へ出すための純関数。
//
// なぜ要るか(2026-07-26 実測):
//   Firestore は1ドキュメント1MBまで。**設定は箱ひとつ**で、その中に資料PDFが中身ごと入っていた。
//     製品 786KB(上限の77%) … うち 608KB が資料PDF **1本**(578-KQ-052)。残り約262KB。
//     最終 320KB           … うち 288KB が資料PDF 1本(578-KQ-042)。
//   同じ大きさの資料をもう1本入れると箱が溢れる。溢れると「資料が保存できない」では済まず、
//   **同じ箱に入っている目標時間・型式マッピング・宛先グループ・スキップ条件が全部保存できなくなる**。
//   しかもエラー文は原因を教えてくれない。
//
// やること(写真の別置きとまったく同じ考え方):
//   保存前: pdfData の中身を work_standard_files へ逃がし、設定側には 'wsfile:<id>' という札だけ置く。
//   読取後: 札を中身に戻してから画面へ渡す。→ 表示・ダウンロード側のコードは無改修で動く。
//
// ⚠IDは**中身から決める**(ランダムにしない)。端末が複数あるので、同じPDFを2台が同時に
//   逃がしてもドキュメントは1つにしかならない(冪等)。孤児が生まれない。

export const WS_FILE_PREFIX = 'wsfile:';
export const WS_FILE_COLLECTION = 'work_standard_files';
// これ未満は箱を分ける意味がない(参照1つ分のほうが重くなる)
export const WS_OFFLOAD_MIN = 20000;

export const isWsFileRef = (v) => typeof v === 'string' && v.startsWith(WS_FILE_PREFIX);
export const isOffloadableFile = (v) => typeof v === 'string' && v.startsWith('data:') && v.length >= WS_OFFLOAD_MIN;

// 中身から決める短いID。衝突を避けるため2つの異なるハッシュと長さを組み合わせる。
export const hashStr = (s) => {
    let a = 0x811c9dc5, b = 0x01000193 >>> 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = (Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13)) >>> 0;
    }
    return a.toString(36) + b.toString(36);
};
export const wsFileIdFor = (dataUrl) => `wsf-${hashStr(dataUrl)}${dataUrl.length.toString(36)}`;

// ---- 読取後: 札 → 中身 ----
// ⚠まだ読めていない札は **札のまま返す**。'' に潰すと、その状態で設定を保存した瞬間に
//   Firestore 上の札が空文字で恒久上書きされ、資料が二度と開けなくなる(写真で一度やりかけた形)。
export const hydrateWorkStandards = (list, fileMap) => {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const out = list.map((s) => {
        if (!s || !isWsFileRef(s.pdfData)) return s;
        const hit = (fileMap || {})[s.pdfData.slice(WS_FILE_PREFIX.length)];
        if (!hit) return s;
        changed = true;
        return { ...s, pdfData: hit };
    });
    return changed ? out : list;
};

// ---- 保存前: 中身 → 札 ----
// writeFile(id, {name, mime, data, at}) は呼び元が Firestore への書き込みを行う関数。
// 返すのは新しい配列(元は壊さない)。既に札のものは触らない。
export const dehydrateWorkStandards = async (list, writeFile) => {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const out = [];
    for (const s of list) {
        if (!s || !isOffloadableFile(s.pdfData)) { out.push(s); continue; }
        const id = wsFileIdFor(s.pdfData);
        const mime = (/^data:([^;,]+)/.exec(s.pdfData) || [])[1] || 'application/pdf';
        await writeFile(id, { name: s.name || '', mime, data: s.pdfData, at: Date.now() });
        out.push({ ...s, pdfData: WS_FILE_PREFIX + id });
        changed = true;
    }
    return changed ? out : list;
};

// どの札が今も使われているか(掃除用)。資料を消しても中身の箱は自動では消えないため。
export const referencedWsFileIds = (list) =>
    new Set((Array.isArray(list) ? list : [])
        .map((s) => (s && isWsFileRef(s.pdfData) ? s.pdfData.slice(WS_FILE_PREFIX.length) : null))
        .filter(Boolean));

// 設定の中に「まだ箱の外へ出していないPDF」が残っているか(自動移行の判定)。
export const needsWsOffload = (list) =>
    (Array.isArray(list) ? list : []).some((s) => s && isOffloadableFile(s.pdfData));

// 移行でどれだけ設定が軽くなるか(画面と報告で同じ数字を使う)。
export const wsOffloadSaving = (list) =>
    (Array.isArray(list) ? list : []).reduce((a, s) => a + (s && isOffloadableFile(s.pdfData) ? s.pdfData.length : 0), 0);
