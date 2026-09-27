// ============================================================================
// 📄 作業標準を Excel / 紙(PDF) に出す — ブラウザで動く所
// ----------------------------------------------------------------------------
// ⚠⚠ 中身の組み立ては `domain/workStandardDoc.js`(試験あり)。ここは
//   **絵を作る・ファイルにする** だけ。表の中身をここで組み直さない。
//
// ⚠⚠ 絵は「その1枚」を **書き出しと同じ描き方** で作る。
//   プレビューだけ別の描き方にすると、紙と動画で印の位置が違う物ができる
//   (2026-08-13 に動画の書き出しで同じ形の事故を出している)。
//   → paintFrame + drawMarksOnCanvas を使う(動画の書き出しと同じ道)。
// ============================================================================

import { paintFrame, drawOverlays } from './domain/videoOverlay.js';
import { drawMarksOnCanvas } from './domain/videoMarks.js';
import { outputDims, zoomAt } from './domain/videoProject.js';
import { buildWorkStandard, standardFileName, zoomProgressForStill, titleFor } from './domain/workStandardDoc.js';
import { COLUMNS, cellText } from './domain/workStandardDoc.js';
import { workStandardHtml } from './domain/workStandardPrint.js';
import { entryToDoc, rebuildCheck } from './domain/workStandardLibrary.js';

const xlsxYmd = (ms) => {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

// 紙に貼る絵の幅(ピクセル)。
// ⚠⚠ **紙の上で 170mm** に伸ばすので、荒いと印がにじむ。
//   170mm ≒ 6.7インチ。150dpi なら約1000px、200dpi なら約1340px。
//   1280px にして、紙でもExcelでも印がはっきり見えるようにする。
//   ⚠ここを小さくすると、また「見えない作業標準」に戻る。
const SHOT_W = 1280;

/** 動画の「その1枚」を取り出す。⚠seek は待たないと前の絵が出る。 */
const grabVideoFrame = (videoEl, atSec) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('絵の取り出しが終わりませんでした')), 8000);
  const done = () => { clearTimeout(t); videoEl.removeEventListener('seeked', done); resolve(); };
  videoEl.addEventListener('seeked', done);
  try { videoEl.currentTime = Math.max(0, atSec); } catch (e) { clearTimeout(t); reject(e); }
});

/**
 * 行ごとの絵を作る。
 * @param doc       buildWorkStandard(...) の結果（rows と pic を持っている）
 * @param getVideo  (srcId) => HTMLVideoElement | null
 * @param getImage  (imageId) => HTMLImageElement | dataUrl | null
 * @returns { [rowId]: dataUrl }
 *
 * ⚠⚠ **1枚も作れなくても止めない。** 作れた分だけ返し、作れなかった行は
 *   紙側が「写真なし」と書く。ここで例外を投げると書類が1枚も出ない。
 *
 * ⚠⚠ **画面で見えている絵と同じ物を作る。**（2026-08-15 実測で4つ抜けていた）
 *   回転 / 切り抜き / 明るさ / 寄り(ズーム) / 🕶目隠し。渡していなかったので
 *   「縦に構えて撮り、編集室で回して直した動画 → 紙だけ横倒し」
 *   「他社名に目隠しを掛けた場面 → 紙とExcelでは丸見え」が起きていた。
 */
export const buildShots = async (doc, { getVideo, getImage } = {}) => {
  const rows = (doc && doc.rows) || [];
  const pic = (doc && doc.pic) || {};
  const out = {};
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const scratch = (w2, h2) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w2); c.height = Math.max(1, h2);
    return c;
  };
  for (const r of rows) {
    try {
      let src = null, sw = 0, sh = 0;
      if (r.shot.kind === 'freeze') {
        const v = getVideo && getVideo(r.shot.srcId);
        if (!v || !v.videoWidth) continue;
        await grabVideoFrame(v, r.shot.atSec);
        src = v; sw = v.videoWidth; sh = v.videoHeight;
      } else {
        const im = getImage && getImage(r.shot.imageId);
        if (!im) continue;
        const el = typeof im === 'string' ? await loadImg(im) : im;
        if (!el || !el.naturalWidth) continue;
        src = el; sw = el.naturalWidth; sh = el.naturalHeight;
      }
      // ⚠⚠ 絵の大きさは **書き出しと同じ出し方**(回転で縦横が入れ替わる・切り抜きで比が変わる)。
      //   ここを元の大きさのままにすると、絵の周りに黒帯ができて **印が帯のぶんズレる**。
      const { width: w, height: h } = outputDims(sw, sh, pic.rotate, pic.crop, SHOT_W);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      // ⚠書き出しと同じ描き方(絵の入れ方・余白の付け方を1か所に)
      paintFrame(ctx, w, h, src, sw, sh, {
        rotate: pic.rotate, crop: pic.crop, adjust: pic.adjust,
        zoom: zoomAt(r.zoom, zoomProgressForStill(r.zoom)),
      });
      // ⚠⚠ 順番は 目隠し → 印。逆にすると、隠した所に付けた印まで潰れる。
      if ((r.hides || []).length) drawOverlays(ctx, w, h, r.hides, { scratch });
      drawMarksOnCanvas(ctx, w, h, r.marks || []);
      out[r.id] = cv.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      // ⚠1行つまずいても続ける。作れなかった行は紙で「写真なし」になる。
      console.warn('作業標準の写真を作れませんでした', r.id, e);
    }
  }
  return out;
};

const loadImg = (url) => new Promise((res) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => res(null);         // ⚠読めない絵で永久に待たない
  i.src = url;
});

/** 📄 紙にする(PDFはこの画面から「PDFに保存」で作る)。 */
export const printWorkStandard = (doc, shots, opts = {}) => {
  const w = window.open('', '_blank');
  if (!w) { alert('別のウィンドウが開けませんでした。ブラウザのポップアップの許可を確認してください。'); return false; }
  w.document.open();
  w.document.write(workStandardHtml(doc, shots, opts));
  w.document.close();
  return true;
};

/**
 * 📊 Excel の中身を組み立てる。
 * ⚠⚠ **ダウンロードと分けてある**。分けないと、出来上がったファイルを
 *   読み返して確かめる試験が書けない(ブラウザの外では document が無い)。
 *   実際に「Excelを作った」と言いながら中身を一度も見ない、が起きやすい。
 * @param ExcelJS  読み込み済みの ExcelJS
 */
export const buildWorkStandardWorkbook = (doc, shots, ExcelJS) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('作業標準');

  // ⑥ 承認。⚠⚠ 紙と同じ物が出るように、判定も題名も **紙と同じ関数** を通す。
  //   ここで別に組み立てると「紙は承認済み・Excelは原案」が必ず起きる。
  const ap = doc.approval || {};
  const approved = !!ap.by;

  // ⚠見出しと列幅は domain の1つの形から。ここで並べ直さない。
  ws.addRow([titleFor(doc.title, approved)]).font = { bold: true, size: 14 };
  ws.addRow([`型式: ${doc.model || ''}`, `指図: ${doc.orderNo || ''}`, `作成: ${doc.madeBy || ''}`]);
  // ⚠⚠ 文書番号・版・制定日は **空の行** を置くだけ。勝手に採番しない(承認しても採番しない)。
  ws.addRow(['文書番号', '', '版', '', '制定日', '']).font = { bold: true };
  // ⑥ 承認した人と日付の1行。⚠まだなら「原案（未承認）」とはっきり書く。
  const apRow = ws.addRow(approved
    ? ['承認', ap.by, '承認日', xlsxYmd(ap.at), '状態', '承認済み']
    : ['承認', '', '承認日', '', '状態', '原案（未承認）']);
  apRow.font = { bold: true, color: { argb: approved ? 'FF166534' : 'FFB91C1C' } };
  ws.addRow([`元の動画: ${doc.videoName || ''}`]);
  const holes = ['step', 'point', 'why'].reduce((a, k) => a + ((doc.missing && doc.missing[k]) || 0), 0);
  if (holes > 0) {
    const r = ws.addRow([`⚠ まだ書かれていない所が ${holes}か所 あります。空欄のまま出しています（推測では埋めていません）。`]);
    r.font = { bold: true, color: { argb: 'FF7C2D12' } };
  }
  ws.addRow([]);

  const head = ws.addRow(COLUMNS.map(c => c.label));
  head.font = { bold: true };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  // ⚠写真の列を **絵の幅に合わせて広げる**。Excel の幅1 ≒ 7px なので 600px ≒ 86。
  //   狭いままだと絵が列からはみ出して、隣の文字に重なる。
  COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = c.key === 'shot' ? 86 : c.width; });

  const shotCol = COLUMNS.findIndex(c => c.key === 'shot');
  for (const r of doc.rows) {
    const row = ws.addRow(COLUMNS.map(c => cellText(r, c.key)));
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; });
    const url = shots && shots[r.id];
    if (url) {
      // ⚠⚠ **写真が本体**。小さく貼ると Excel でも見えない(紙で名刺サイズを出した反省)。
      //   幅600px(16:9で高さ338px)。Excel の行の高さは pt なので、338px ≒ 254pt。
      //   ⚠行を高くしないと絵が隣の行にはみ出して重なる。
      row.height = 260;
      const id = wb.addImage({ base64: String(url).split(',')[1] || '', extension: 'jpeg' });
      ws.addImage(id, { tl: { col: shotCol + 0.05, row: row.number - 1 + 0.05 }, ext: { width: 600, height: 338 } });
    } else {
      row.height = 60;
      row.getCell(shotCol + 1).value = '写真なし';   // ⚠無いことを黙らない
    }
  }

  return wb;
};

/**
 * 📊 Excel にして落とす。⚠写真も貼る(文字だけの表は作業標準にならない)。
 * @param loadExcelJS  アプリが持っている読み込み関数(必要な時だけ読む)
 */
export const exportWorkStandardXlsx = async (doc, shots, loadExcelJS) => {
  const ExcelJS = await loadExcelJS();
  const wb = buildWorkStandardWorkbook(doc, shots, ExcelJS);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = standardFileName(doc, 'xlsx'); a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return standardFileName(doc, 'xlsx');
};

export { buildWorkStandard };

// ===========================================================================
// 📚 棚に入れた作業標準を開く（写真は **その場で作り直す**）
// ---------------------------------------------------------------------------
// ⚠⚠ 棚に入っているのは「どの動画の・どの要点か」だけ。写真は1枚も入っていない。
//   （入れると設定の箱が1MBで死ぬ。`domain/workStandardLibrary.js` の頭を読むこと）
//   なので、開く人が押した時に **元の動画を取り直して** 切り出す。
//   ・保存が軽い ・動画を直したら書類も直る
//   ⚠その代わり **元の動画が Drive から消えていたら作り直せない**。
//     その時は黙って白い紙を出さず、「写真なし」の枠と元の動画名が紙に残る。
// ===========================================================================

/** 元動画を1本、切り出せる所まで用意する。⚠読めない動画で永久に待たない。 */
const openVideo = (url) => new Promise((resolve) => {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.muted = true; v.playsInline = true;
  v.style.display = 'none';
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true; clearTimeout(timer);
    resolve(ok ? v : null);
  };
  const timer = setTimeout(() => finish(false), 20000);
  v.addEventListener('loadeddata', () => finish(true));
  v.addEventListener('error', () => finish(false));
  document.body.appendChild(v);
  v.src = url;
});

/**
 * 棚の1件から、行ごとの写真を作り直す。
 * @param entry      棚の1件
 * @param videoUrlOf (driveId) => 動画のURL   … Driveの取り方はアプリが持っている
 * @returns { shots, missingVideos }  ⚠取れなかった動画を **黙らない**
 */
export const buildSavedShots = async (entry, { videoUrlOf } = {}) => {
  const doc = entryToDoc(entry);
  const srcs = (entry && entry.recipe && entry.recipe.sources) || [];
  const els = {};
  const missingVideos = [];
  const made = [];
  try {
    for (const s of srcs) {
      if (!s.driveId || typeof videoUrlOf !== 'function') { missingVideos.push(s.name || s.id); continue; }
      const v = await openVideo(videoUrlOf(s.driveId));
      if (v && v.videoWidth) { els[s.id] = v; made.push(v); }
      else { missingVideos.push(s.name || s.id); if (v) made.push(v); }
    }
    // ⚠🖼挟んだ画像は棚に残っていない(元の画像はアプリの外)。getImage は必ず null。
    //   → その行は「写真なし」で出る。作り直せる物と作り直せない物を混ぜない。
    const shots = await buildShots(doc, { getVideo: (id) => els[id] || null, getImage: () => null });
    return { shots, missingVideos };
  } finally {
    made.forEach((v) => {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* noop */ }
      try { v.remove(); } catch { /* noop */ }
    });
  }
};

/** 📄 棚の1件を紙にする(PDFはこの画面から「PDFに保存」)。 */
export const printSavedWorkStandard = async (entry, { videoUrlOf, perPage } = {}) => {
  const { shots, missingVideos } = await buildSavedShots(entry, { videoUrlOf });
  const doc = entryToDoc(entry);
  const pp = perPage != null ? perPage : ((entry && entry.recipe && entry.recipe.perPage) || undefined);
  const ok = printWorkStandard(doc, shots, { perPage: pp });
  return { ok, missingVideos, shots: Object.keys(shots).length };
};

/** 📊 棚の1件を Excel にする。 */
export const exportSavedWorkStandardXlsx = async (entry, loadExcelJS, { videoUrlOf } = {}) => {
  const { shots, missingVideos } = await buildSavedShots(entry, { videoUrlOf });
  const name = await exportWorkStandardXlsx(entryToDoc(entry), shots, loadExcelJS);
  return { name, missingVideos, shots: Object.keys(shots).length };
};

/** 開く前に人へ見せる一言(何が作り直せて、何が作り直せないか)。 */
export const savedStandardNote = (entry) =>
  rebuildCheck(entryToDoc(entry), (entry && entry.recipe && entry.recipe.sources) || []).note;
