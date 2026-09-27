// ============================================================================
// 📄 作業標準を「印刷できる紙」にする（PDFはこれを印刷して作る）
// ----------------------------------------------------------------------------
// ⚠⚠⚠ **作業標準は写真が本体である。** ここを外すと紙として使えない。
//   清水さん(2026-08-15)
//     「画像小さすぎて全く理解できないよ？基本画像中心になるってことを理解した上で
//       作成して、人として見れるものを作る事と画像中心の作業標準ってことを理解して」
//
//   ⚠最初に作った物は **表計算の感覚で7列を1行に並べた**。
//     A4縦の幅190mmを 番号/工程/写真/手順/急所/理由/静止 で割ったので、
//     写真が **62mm**(名刺くらい)になった。現場でねじの向きなど見えない。
//     → **表をやめる。1つの要点 = 1枚のカード**にして、写真を紙いっぱいに出す。
//
// ■ いまの作り（A4縦・既定は1ページ2要点）
//     ┌──────────────────────────────┐
//     │ ① 外観 — ねじを締める          │ ← 番号・工程・作業手順(大きい字)
//     │ ┌──────────────────────────┐ │
//     │ │      写真 幅170mm          │ │ ← **主役**。紙の幅の9割
//     │ └──────────────────────────┘ │
//     │ 急所 │ 斜めに入れない          │
//     │ 理由 │ ねじ山がつぶれる        │
//     └──────────────────────────────┘
//   1ページの数は選べる(1 / 2 / 4)。既定は2。
//   ⚠4つ入れても写真の幅は **紙の半分(約88mm)** は確保する。それ以下にはしない。
//
// ⚠⚠ 表を2回書かない。行の中身は `workStandardDoc.js` の1つの形から作る。
// ⚠⚠ PDFは **ブラウザの印刷**で作る（このアプリの成績表と同じやり方）。
//   PDFの部品を足すと、その部品ぶんアプリが重くなる。
//   ⚠印刷の窓は素の HTML なので、アプリの見た目(Tailwind)は効かない。ここに全部書く。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

import { cellText, titleFor } from './workStandardDoc.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

export const COMPANY = '津田駒工業株式会社';
export const PLANT = '野々市工場';

/**
 * 1ページに入れる要点の数。
 * ⚠⚠ **写真の幅を先に決めてから**、入る数を決めている。逆にすると必ず写真が潰れる。
 *   A4縦の書ける幅 = 190mm。
 *
 * ⚠⚠ **高さも決める(photoMaxMm)。** 2026-08-15 実測で、幅しか決めていなかったため:
 *   ・おすすめ(1ページ2つ)でも 3枚のはずが **5枚** 出て、写真が紙をまたいで切れていた
 *   ・縦に構えて撮った動画(縦長の写真)だと 5枚のはずが **16枚**
 *   写真は幅を伸ばすと高さも伸びるので、幅だけ決めると紙の高さ(277mm)を必ず超える。
 *   → 幅と高さの **両方** で抑える。縦長の写真は高さで止まり、横長は幅いっぱいのまま。
 *
 * ⚠ firstN = 1ページ目に入れる数。1ページ目は題名・型式・警告の見出し(約47mm)が
 *   乗るので、同じ数を入れると必ずあふれる。**1ページ目だけ少なくする**。
 */
export const PER_PAGE = [
  // ⚠cardMaxMm は「A4の書ける高さ277mm から、見出し(1ページ目のみ。**実測67.4mm**)・
  //   カードの間(4mm)・ページ下の署名(約8mm) を引いて割った値」。実測で決めている。
  // ⚠2026-08-15: ⑥承認の1行を見出しに足したぶん(実測 +8.4mm)、**1ページ1つのカードだけ
  //   210mm では1ページ目に入らなくなった**。1つ目のカードは入らなくても置く決まりなので、
  //   気づかないまま紙からはみ出す(=写真が途中で切れる)。→ カードの上限を先に下げる。
  //   ⚠**写真の幅(178mm)は下げない**。作業標準は写真が本体。下がるのは縦の枠だけ。
  { n: 1, label: '1ページ1つ（いちばん大きい）', photoMm: 178, photoMaxMm: 165, cardMaxMm: 195, firstN: 1 },
  { n: 2, label: '1ページ2つ（おすすめ）', photoMm: 170, photoMaxMm: 92, cardMaxMm: 128, firstN: 1 },
  // ⚠2026-08-15: 見出しが 8.4mm 伸びたので、104mm のままだと **1ページ目だけ2つ**になり、
  //   「1ページ4つ」と名乗りながら1枚目が半分空く。→ カードの高さを下げて4つを守る。
  //   ⚠横長の写真は幅88mm・高さ49.5mm で **幅で決まっている** ので、この変更で小さくならない。
  { n: 4, label: '1ページ4つ（一覧向き）', photoMm: 88, photoMaxMm: 68, cardMaxMm: 98, firstN: 4 },
];
export const PER_PAGE_DEFAULT = 2;
export const perPageOf = (n) => PER_PAGE.find(p => p.n === Number(n)) || PER_PAGE.find(p => p.n === PER_PAGE_DEFAULT);

/** ⚠これより小さい写真は作らない。名刺サイズでは現場で見えない。 */
export const MIN_PHOTO_MM = 85;

// ---------------------------------------------------------------------------
// 紙の高さの見積もり
// ⚠⚠ **文字は削らない。写真の方を小さくする。**
//   作業手順60字・急所60字・理由80字まで入るので、長い文だとカードが伸びる。
//   伸びたぶんを紙からはみ出させると **写真が途中で切れて出てくる**(実測)。
//   かといって文字を切ると標準として使えない。→ 写真の枠を先に縮める。
// ⚠係数は Chrome の印刷で実測した値(1行あたりのmm、1行に入る字数)。
// ---------------------------------------------------------------------------
const PAGE_MM = 277;      // A4縦(297) − 上下の余白(10+10)
const FOOT_MM = 8;        // ページ下の会社名(実測4.8mm＋余裕)
// 1ページ目の見出し(題名・型式の表・警告)。
// ⚠⚠ **実測して決める。見積もりで足さない。**
//   2026-08-15 実測(空欄の警告が出ている＝ふつうの状態):
//     ⑥承認の行を足す前 59.0mm → 足した後 **67.4mm**(+8.4mm)。
//   「1行だから5mmくらい」と見積もって 59 のままにしたら、1ページ目が 276.6mm となり
//   A4の書ける高さ(277mm)まで **残り0.4mm** だった。型式名が1行伸びれば即はみ出す。
const TITLE_MM = 68;
const GAP_MM = 4;         // カードの間
const CARD_PAD_MM = 10;   // カードの内側の余白＋枠＋写真の下の余白
const LINE_KV_MM = 5.9, ROW_PAD_MM = 3.5, LINE_HEAD_MM = 6.2;
/** ⚠これ以上小さくしない。ここまで来たら「文が長すぎる」ので、紙が増える方を選ぶ。 */
export const MIN_PHOTO_BOX_MM = 45;

/**
 * 1行に入る字数と、見出しの土台の高さ(カードの幅で変わる)。
 * ⚠⚠ **多めに見積もる**。少なく見積もると紙からはみ出して写真が切れる。
 *   多めに見積もった時に起きるのは「写真が少し小さい」だけで済む。
 * ⚠4つ並べ(カード幅93mm)は、番号の丸と工程の札で作業手順の幅が食われる。
 *   実測: 工程名が長いと札だけで2行になる(短い文なのに見出し15.7mm)。
 */
const charsPerLine = (n) => (n === 4 ? { head: 5, kv: 12, base: 16 } : { head: 22, kv: 28, base: 11 });
const linesOf = (s, cpl) => String(s == null ? '' : s).split('\n')
  .reduce((a, l) => a + Math.max(1, Math.ceil([...l].length / Math.max(1, cpl))), 0) || 1;

/** 見出し(番号・工程・作業手順)の高さ。 */
export const headMm = (row, n) => charsPerLine(n).base + LINE_HEAD_MM * (linesOf((row && row.step) || '（作業手順が未記入）', charsPerLine(n).head) - 1);
/** 急所・理由の表の高さ。 */
export const kvMm = (row, n) => [(row && row.point) || '未記入', (row && row.why) || '未記入']
  .reduce((a, v) => a + ROW_PAD_MM + LINE_KV_MM * linesOf(v, charsPerLine(n).kv), 0);

/**
 * その要点の写真の枠の高さ(mm)。長い文の行ほど小さくなる。
 * ⚠⚠ 決め打ちの mm で返す。%にすると印刷で効かず、絵が枠を突き抜けて下が切れる(実測)。
 */
export const photoBoxMm = (row, pp) => {
  const rest = pp.cardMaxMm - headMm(row, pp.n) - kvMm(row, pp.n) - CARD_PAD_MM;
  return Math.round(Math.max(MIN_PHOTO_BOX_MM, Math.min(pp.photoMaxMm, rest)) * 10) / 10;
};

/** カード1枚の高さ(mm)。 */
export const cardMm = (row, pp) => headMm(row, pp.n) + photoBoxMm(row, pp) + kvMm(row, pp.n) + CARD_PAD_MM;

/**
 * 要点をページへ詰める。
 * ⚠⚠ 「N個ずつ」で機械的に割らない。**入る高さで決める**。
 *   1ページ目は見出しのぶん狭い / 文が長い要点はカードが高い。
 *   高さを見ずに割ったので、おすすめの並べ方でも 3枚のはずが5枚出ていた(2026-08-15 実測)。
 * @returns [[row, ...], ...]
 */
export const paginate = (rows, pp) => {
  const list = rows || [];
  const pages = [];
  let i = 0;
  while (i < list.length) {
    const first = pages.length === 0;
    const budget = PAGE_MM - FOOT_MM - (first ? TITLE_MM : 0);
    const page = [];
    let used = 0;
    // 4つ並べる時は横2列。高さは「その行の高い方」で決まる。
    const step = pp.n === 4 ? 2 : 1;
    while (i < list.length && page.length < pp.n) {
      const group = list.slice(i, i + step);
      const h = Math.max(...group.map(r => cardMm(r, pp))) + (page.length ? GAP_MM : 0);
      if (page.length && used + h > budget) break;   // ⚠1つ目は入らなくても置く(永久に置けなくなる)
      group.forEach(r => page.push(r));
      used += h;
      i += group.length;
    }
    pages.push(page);
  }
  return pages;
};

const ymd = (ms) => {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

/**
 * @param doc   buildWorkStandard の結果
 * @param shots { [rowId]: dataUrl }  … 行ごとの写真(呼び出し側が canvas から作る)
 * @param opts.perPage 1 / 2 / 4
 *
 * ⚠写真が用意できなかった行は **枠を残して「写真なし」と書く**。
 *   黙って詰めると、あとで見た人が「元から無い」と誤解する。
 */
export const workStandardHtml = (doc, shots = {}, opts = {}) => {
  const d = doc || {};
  const rows = d.rows || [];
  const pp = perPageOf(opts.perPage);
  const two = pp.n === 4;   // 4つの時だけ横に2列並べる
  // ⑥ 承認。⚠⚠ **1段だけ**(承認した/していない)。ここで段を増やさない。
  //   ⚠承認が生きているかどうかは呼び元(workStandardLibrary の entryToDoc)が決める。
  //     中身が変わって外れた承認は、ここへ渡ってこない = 紙にその人の名前は出ない。
  const ap = d.approval || {};
  const approved = !!ap.by;
  // ⚠⚠ 題名を手で組み立てない。承認と（原案）が食い違った紙が必ず出る。
  const title = titleFor(d.title, approved);

  const card = (r) => {
    const url = shots[r.id];
    const photo = url
      ? `<img src="${esc(url)}" alt="">`
      : `<div class="nophoto">写真なし</div>`;
    // ⚠見出しは「番号・工程・作業手順」。作業手順は**この要点の題名**なので大きく出す。
    const head = `<div class="head">
        <span class="no">${esc(r.no)}</span>
        ${r.chapter ? `<span class="chap">${esc(r.chapter)}</span>` : ''}
        <span class="step">${nl2br(r.step) || '<span class="hole">（作業手順が未記入）</span>'}</span>
        ${r.holdSec > 0 ? `<span class="hold">静止 ${esc(cellText(r, 'holdSec'))}</span>` : ''}
      </div>`;
    // ⚠急所と理由は写真の下。**空なら「未記入」と出す**(空白のまま配られない)
    const line = (label, v, cls) => `<tr><th class="${cls}">${esc(label)}</th><td>${v ? nl2br(v) : '<span class="hole">未記入</span>'}</td></tr>`;
    // ⚠⚠ 写真の枠の高さは **行ごとに** 決める(長い文の行は写真が小さくなる)。
    //   ここを共通のCSSだけでやると、長い文の時に文字が切れるか紙からはみ出す。
    return `<div class="card">
        ${head}
        <div class="photo" style="height:${photoBoxMm(r, pp)}mm">${photo}</div>
        <table class="kv">
          ${line('急所', r.point, 'k1')}
          ${line('急所の理由', r.why, 'k2')}
        </table>
      </div>`;
  };

  // ⚠ページの区切りは **入る高さ** で決める(paginate)。「N個ごと」で機械的に割ると、
  //   1ページ目の見出しや長い文のぶんがはみ出して、紙が増え、写真が途中で切れる。
  const pages = paginate(rows, pp);

  // ⚠⚠ 文書番号・版・制定日は **空の枠** で出す。人が手で書き込む所。
  //   勝手に埋めると偽の社内文書になる。
  //
  // ⑥ 承認した人と日付は **1行**。⚠段は作らない(1段で止める)。
  //   ⚠承認が無い時も行そのものは出す。紙に出た標準に「承認欄が無い」と、
  //     承認したかどうかを紙の上で示せなくなる(手で書き込む所として残す)。
  const meta = `
    <table class="meta">
      <tr>
        <td class="k">型式</td><td>${esc(d.model)}</td>
        <td class="k">指図</td><td>${esc(d.orderNo)}</td>
        <td class="k">文書番号</td><td class="blank"></td>
      </tr>
      <tr>
        <td class="k">作成</td><td>${esc(d.madeBy)}</td>
        <td class="k">作成日</td><td>${esc(ymd(d.madeAt))}</td>
        <td class="k">版 / 制定日</td><td class="blank"></td>
      </tr>
      <tr class="appr">
        <td class="k">承認</td><td>${approved ? esc(ap.by) : '<span class="hole">（未承認）</span>'}</td>
        <td class="k">承認日</td><td>${approved ? esc(ymd(ap.at)) : ''}</td>
        <td class="k">状態</td><td>${approved ? '<b>承認済み</b>' : '<b class="draft-sm">原案</b>'}</td>
      </tr>
      <tr><td class="k">元の動画</td><td colspan="5">${esc(d.videoName)}</td></tr>
    </table>`;

  const holes = ['step', 'point', 'why'].reduce((a, k) => a + ((d.missing && d.missing[k]) || 0), 0);
  const warn = holes > 0
    ? `<div class="warn">⚠ まだ書かれていない所が ${holes}か所 あります。<b>空欄のまま出しています</b>（推測では埋めていません）。配る前に埋めてください。</div>`
    : '';

  // ⚠⚠ 承認前は **紙に大きく「原案」** と出す。題名の（原案）だけだと見落とす。
  //   ⚠題名と同じ行に置く(行を増やすと紙の高さが足りなくなり、写真が小さくなる)。
  const stamp = approved ? '' : '<span class="draft">原案</span>';
  // ⚠2ページ目以降は見出しが無い。**そこだけ原案の印が消える**と、
  //   その紙だけ抜き出された時に承認済みと見分けが付かない。→ 足元にも出す。
  const footMark = approved ? '' : '　—　<b class="draft-sm">原案（未承認）</b>';

  const body = pages.map((pg, i) => `
    <section class="page">
      ${i === 0 ? `<h1>${stamp}${esc(title)}</h1><div class="sub">${esc(COMPANY)}　${esc(PLANT)}</div>${meta}${warn}` : ''}
      <div class="cards${two ? ' two' : ''}">${pg.map(card).join('')}</div>
      <div class="foot">${esc(COMPANY)}　${esc(PLANT)}　—　${i + 1} / ${pages.length}${footMark}</div>
    </section>`).join('');

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Yu Gothic","Meiryo",sans-serif; color:#000; margin:0; font-size:11pt; }
  .screen-only { padding:14px; background:#eff6ff; border-bottom:1px solid #bfdbfe; text-align:center; font-weight:700; color:#1d4ed8; }
  @media print { .screen-only { display:none } }
  .page { width:190mm; margin:0 auto; padding:0; }
  .page + .page { break-before: page; page-break-before: always; }
  h1 { font-size:18pt; margin:0 0 1mm; text-align:center; letter-spacing:.1em; }
  .sub { text-align:center; font-size:9pt; color:#333; margin-bottom:3mm; }
  .meta { border-collapse:collapse; width:100%; margin-bottom:2.5mm; font-size:9pt; }
  .meta td { border:1px solid #000; padding:1.2mm 2mm; }
  .meta .k { background:#f1f5f9; font-weight:700; width:13ch; white-space:nowrap; }
  .meta .blank { min-width:20ch; }
  .warn { border:1.5px solid #b45309; background:#fffbeb; color:#7c2d12; padding:2mm 3mm; margin-bottom:3mm; font-size:9pt; }
  /* ⑥ 原案の印。⚠**大きく**出す(承認済みと見分けが付かないのが一番危ない)。
     ⚠題名と同じ行に置く = 紙の高さを1ミリも増やさない。増やすと写真が小さくなる。 */
  .draft { display:inline-block; border:2pt solid #b91c1c; color:#b91c1c; font-size:17pt; font-weight:900;
           letter-spacing:.15em; padding:0 2mm; margin-right:3mm; vertical-align:2pt; }
  .draft-sm { color:#b91c1c; }

  /* ⚠⚠ ここが本題。写真を主役にする。 */
  .cards { display:flex; flex-direction:column; gap:4mm; }
  .cards.two { display:grid; grid-template-columns:1fr 1fr; gap:4mm; }
  /* ⚠⚠ カードは **文字を絶対に切らない**(切ったら標準として使えない)。
     長い文のぶんは、写真の枠の方を小さくして吸収する(photoBoxMm)。
     それでも収まらないほど長い時は、そのカードを **次の紙へ送る**(paginate)。 */
  .card { border:1.5px solid #000; padding:2.5mm; break-inside:avoid; page-break-inside:avoid;
          display:flex; flex-direction:column; }
  .head, .kv { flex:0 0 auto; }
  .head { display:flex; align-items:baseline; gap:2.5mm; margin-bottom:2mm; border-bottom:1px solid #cbd5e1; padding-bottom:1.5mm; }
  .head .no { display:inline-flex; align-items:center; justify-content:center; min-width:9mm; height:9mm; border-radius:50%; background:#000; color:#fff; font-weight:800; font-size:12pt; }
  .head .chap { background:#e2e8f0; border-radius:2mm; padding:0.6mm 2mm; font-size:9pt; font-weight:700; white-space:nowrap; }
  .head .step { flex:1; font-size:14pt; font-weight:800; line-height:1.3; }
  .head .hold { font-size:8.5pt; color:#475569; white-space:nowrap; }

  /* ⚠写真の幅は **紙の幅から決め打ち**。中身の大きさに合わせない(小さい写真で縮まない)
     ⚠⚠ 高さも紙から決める(枠は mm。行ごとに style で上書きする)。
        高さを決めないと、縦に構えて撮った動画の写真が紙3枚ぶんの高さになり、
        紙が増えて写真が途中で切れる(2026-08-15 実測: 5枚のはずが16枚)。
     ⚠⚠ %で決めると **印刷では効かない**(枠165mmに対して絵が316mmのまま突き抜けた)。
        枠の高さが mm で決まっていれば、中の絵の max-height:100% が印刷でも効く。 */
  .photo { width:${pp.photoMm}mm; height:${pp.photoMaxMm}mm; margin:0 auto 2mm;
           display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
  .photo img { max-width:100%; max-height:100%; width:auto; height:auto; display:block; border:1px solid #94a3b8; }
  /* ⚠「写真なし」の枠は **写真の枠と同じ大きさ**。縦横比で決めると枠より高くなり、
     下の「急所」の表に重なる(2026-08-15 画面写真で発見)。 */
  .photo .nophoto { width:100%; height:100%; border:1px dashed #94a3b8; background:#f8fafc;
                    display:flex; align-items:center; justify-content:center; color:#64748b; font-size:10pt; }

  .kv { border-collapse:collapse; width:100%; font-size:11pt; }
  .kv th, .kv td { border:1px solid #000; padding:1.5mm 2mm; vertical-align:top; text-align:left; }
  .kv th { width:13ch; background:#f1f5f9; font-weight:700; white-space:nowrap; }
  .kv .k1 { background:#fee2e2; }
  .kv .k2 { background:#fef3c7; }
  .hole { color:#94a3b8; font-weight:400; }
  .foot { margin-top:3mm; text-align:center; font-weight:700; font-size:8.5pt; }
</style></head><body>
<div class="screen-only">印刷の画面が出ます。<br>PDFにする時は 送信先を「PDFに保存」にしてください。</div>
${body || `<section class="page"><h1>${stamp}${esc(title)}</h1><div class="sub">要点がまだありません。</div></section>`}
<script>window.onload=function(){setTimeout(function(){window.print();},600);};<\/script>
</body></html>`;
};
