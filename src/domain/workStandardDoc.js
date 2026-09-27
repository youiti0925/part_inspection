// ============================================================================
// 📄 動画の要点から「作業標準」を組み立てる
// ----------------------------------------------------------------------------
// 清水さん(2026-08-14)
//   「動画の要点だけを自動で作業標準として作成できる機能もほしいかな PDFとかExcelでね」
//   「作業標準は画像と内容になるかもしれないけど、内容は動画の情報になると思うけど、
//     内容として使える情報って動画に追加できたっけ、できなかったらそんな機能追加したいね」
//
// ⚠⚠ **答え: 60文字の1行だけ在った。作業標準には足りない。**
//   いまの止め絵/挟んだ画像には `caption` があり、編集画面から60文字まで入れられる。
//   ただしこれは **映像に焼き込まれる字幕** で、1行しか無い。
//   作業標準は「何をするか」だけでは使えない。**どこで失敗するか(急所)** と
//   **なぜそうするのか(理由)** が無いと、読んだ人が同じ物を作れない。
//   → 3つに分ける。これは現場の作業分解(TWI)と同じ並びで、
//     生産技術・品質保証がそのまま読める形。
//
//       step  作業手順   … 何をするか（例: 銘板を貼る）
//       point 急所      … ここを外すと失敗する所（例: 上端を筐体の線に合わせる）
//       why   急所の理由 … なぜそうするか（例: ずれると出荷検査で戻る）
//
// ⚠⚠ **caption を作業手順に流用しない。** caption は映像に焼き込まれる字幕で、
//   直すと**動画の見た目が変わる**。書類のために字幕を書き換えることになり、
//   「書類を直したら動画が変わった」が起きる。別の欄にする。
//   ただし **step が空なら caption を初期値として使う**(今までの動画からも
//   すぐ作業標準が作れる。ゼロから書き直させない)。
//
// ⚠⚠ **勝手に埋めない。** 空欄は空欄のまま出す。
//   「たぶんこうだろう」で急所や理由を作ると、**現場が嘘の標準に従う**ことになる。
//   代わりに「まだ書かれていない所」を数えて画面に出し、人に埋めてもらう。
//
// ⚠⚠ 文書番号・版・制定日は **空欄で出す**。勝手に採番すると偽の社内文書になる
//   (2026-08-12 の社内標準でも同じ約束にした)。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

// 📍章の形は2つ在る(編集室 {name,atOut} / 手本レシピ {label,start})。読み替えは1本に寄せる。
import { normChapters } from './videoProject.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const txt = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();

/** 作業標準に使える3つの欄。⚠この並びと名前をあちこちで書き直さない。 */
export const FIELDS = [
  { key: 'step', label: '作業手順', hint: '何をするか（例: 銘板を貼る）', max: 60 },
  { key: 'point', label: '急所', hint: 'ここを外すと失敗する所（例: 上端を筐体の線に合わせる）', max: 60 },
  { key: 'why', label: '急所の理由', hint: 'なぜそうするか（例: ずれると出荷検査で戻る）', max: 80 },
];

/** その部品が作業標準の1行になるか。⚠映像そのものは行にしない(止まっている絵だけ)。 */
export const isStandardClip = (c) => !!c && (c.type === 'freeze' || c.type === 'image');

/**
 * 部品1つ → 作業標準の1行。
 * ⚠step が空なら caption を使う(今までの動画からもすぐ作れるように)。
 *   ただし **書き戻さない**。あくまで表示と書き出しの時だけ。
 */
export const rowOfClip = (clip) => ({
  id: (clip && clip.id) || '',
  type: (clip && clip.type) || '',
  step: txt(clip && clip.step) || txt(clip && clip.caption),
  point: txt(clip && clip.point),
  why: txt(clip && clip.why),
  holdSec: Math.max(0, num(clip && clip.durationSec, 0)),
  marks: (clip && clip.marks) || [],
  // ⚠寄り(ズーム)も行に持たせる。持たせないと、紙だけ引きのままになる。
  zoom: (clip && clip.zoom) || null,
  // 絵をどこから取るか。止め絵は「元の動画のその1枚」、挟んだ画像はその画像。
  shot: clip && clip.type === 'freeze'
    ? { kind: 'freeze', srcId: (clip.srcId || ''), atSec: Math.max(0, num(clip.atSec, 0)) }
    : { kind: 'image', imageId: (clip && clip.imageId) || '' },
});

/**
 * どの章(工程)に入るか。⚠章は「出来上がりの中の秒」で並んでいる。
 * ⚠⚠ 章の形は2つ在る(編集室 {name,atOut} / 手本レシピ {label,start})。
 *   読み替えは domain/videoProject.js の normChapter 1本に寄せる。
 *   前はここが {name,atOut} しか読まず、手本レシピから作った作業標準は
 *   **工程の欄が全行 空欄** になっていた。
 */
export const chapterAt = (chapters, tOut) => {
  const list = normChapters(chapters).slice().sort((a, b) => a.atOut - b.atOut);
  let cur = null;
  for (const c of list) { if (c.atOut <= num(tOut) + 1e-6) cur = c; else break; }
  return cur ? txt(cur.name) : '';
};

/**
 * 静止画は1枚しかない。寄り(ズーム)が動く部品では **いちばん寄っている方** を出す。
 * ⚠引きの方を出すと「見せたい所が小さい写真」になり、寄った意味が無くなる。
 * @returns 0(始めの状態) か 1(終わりの状態)
 */
export const zoomProgressForStill = (zoom) => {
  const a = num(zoom && zoom.from && zoom.from.scale, 1);
  const b = num(zoom && zoom.to && zoom.to.scale, a);
  return b >= a ? 1 : 0;
};

/**
 * その要点にかかっている 🕶目隠し(モザイク)。
 * ⚠⚠ **紙とExcelにも必ず持っていく。** 人の顔・他社名・PCの個人情報を隠した動画から
 *   作った書類が丸見えだと、その書類は社外へ出せない(隠した意味が消える)。
 * ⚠少しでも重なっていれば持っていく(隠す方に倒す)。要点の途中だけ掛かっている物を
 *   落とすと、掛けた本人は「掛けたはず」と思ったまま丸見えの紙を配ることになる。
 */
export const hidesForRow = (overlays, atOut, holdSec) => {
  const from = num(atOut, 0);
  const to = from + Math.max(0, num(holdSec, 0));
  return (overlays || []).filter(o => o && o.kind === 'mosaic'
    && num(o.from, 0) < to + 1e-6 && num(o.to, 0) > from - 1e-6);
};

/**
 * 作業標準の中身を組み立てる。
 * @param project  編集中の並び
 * @param opts.chapters [{name, atOut}]
 * @param opts.timeline timelineOf(project) の結果(出来上がりの秒を知るため)
 * @param opts.meta  { title, model, orderNo, madeBy, madeAt, videoName }
 *
 * ⚠⚠ 文書番号・版・制定日は入れない(呼び元が渡してきても捨てる)。
 *   偽の社内文書を作らないため。発行する時に人が手で入れる。
 */
export const buildWorkStandard = (project, opts = {}) => {
  const rows0 = (project && Array.isArray(project.clips) ? project.clips : []);
  const tl = Array.isArray(opts.timeline) ? opts.timeline : [];
  const rows = [];
  rows0.forEach((c, i) => {
    if (!isStandardClip(c)) return;
    const t = tl[i] ? num(tl[i].outStart, 0) : 0;
    const row = { ...rowOfClip(c), no: rows.length + 1, atOut: t, chapter: chapterAt(opts.chapters, t) };
    row.hides = hidesForRow(project && project.overlays, t, row.holdSec);
    rows.push(row);
  });
  const m = opts.meta || {};
  // ⚠空欄を数えて出す。「作れました」だけ言うと、空のまま配られる。
  const missing = {
    step: rows.filter(r => !r.step).length,
    point: rows.filter(r => !r.point).length,
    why: rows.filter(r => !r.why).length,
  };
  return {
    title: txt(m.title) || '作業標準（原案）',
    model: txt(m.model), orderNo: txt(m.orderNo),
    madeBy: txt(m.madeBy), madeAt: num(m.madeAt, 0), videoName: txt(m.videoName),
    // ⚠必ず空。ここを埋めると偽の社内文書になる。
    docNo: '', rev: '', issuedAt: '',
    // ⚠⚠ 画づくり(回転・切り抜き・明るさ)を **書類にも持っていく**。
    //   ここを渡していなかったので、縦に構えて撮って回した動画が **紙だけ横倒し** になり、
    //   切り抜いて外した所が紙には写っていた(2026-08-15 実測)。
    pic: {
      rotate: num(project && project.rotate, 0),
      crop: (project && project.crop) || null,
      adjust: (project && project.adjust) || null,
    },
    rows, missing,
    totalHoldSec: rows.reduce((a, r) => a + r.holdSec, 0),
  };
};

/** 画面に出す一言。⚠「できました」で終わらせず、**空欄を名指しで**言う。 */
export const missingNote = (doc) => {
  const m = (doc && doc.missing) || {};
  const n = (doc && doc.rows && doc.rows.length) || 0;
  if (!n) return '要点がまだ1つもありません。動画で「⏸ 止めて印を出す」を使うと、その1枚が作業標準の1行になります。';
  const holes = FIELDS.filter(f => (m[f.key] || 0) > 0).map(f => `${f.label} ${m[f.key]}件`);
  return holes.length
    ? `要点 ${n}件 から作りました。⚠まだ書かれていない所があります：${holes.join(' / ')}。空欄のまま出します（こちらでは埋めません）。`
    : `要点 ${n}件 すべてに 作業手順・急所・理由 が入っています。`;
};

// ---------------------------------------------------------------------------
// 原案 / 承認済み の題名
// ⚠⚠ **題名を手で組み立てない。** 「作業標準（原案）」という文字が紙・Excel・棚の3か所に
//   バラバラに書かれていると、承認したのに（原案）のままの紙が必ず出る。
//   承認したかどうかだけ渡して、題名はここ1か所で作る。
// ⚠承認の中身(だれが・いつ・まだ生きているか)は `workStandardLibrary.js` が決める。
//   ここは「（原案）を付けるか外すか」だけ。
// ---------------------------------------------------------------------------
export const DRAFT_MARK = '（原案）';
/** （原案）を外した素の題名。⚠二重に付いていても全部外す。 */
export const baseTitle = (t) => {
  let s = txt(t);
  while (s.endsWith(DRAFT_MARK)) s = s.slice(0, -DRAFT_MARK.length).trim();
  return s || '作業標準';
};
/** 承認済みなら素の題名、まだなら必ず（原案）を付ける。 */
export const titleFor = (t, approved) => (approved ? baseTitle(t) : baseTitle(t) + DRAFT_MARK);

/** ファイル名。⚠あとでフォルダを見た人が中身を当てられる名前にする。 */
export const standardFileName = (doc, ext = 'xlsx') => {
  const d = new Date(num(doc && doc.madeAt, 0) || 0);
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 30);
  return ['作業標準', safe(doc && doc.model) || '共通', stamp].filter(Boolean).join('_') + '.' + String(ext).replace(/^\./, '');
};

// ---------------------------------------------------------------------------
// 表の形（Excel も 印刷 も、この1つの形から作る）
// ⚠⚠ 表を2回書かない。片方だけ直して、ExcelとPDFで中身が違う、が必ず起きる。
// ---------------------------------------------------------------------------
export const COLUMNS = [
  { key: 'no', label: 'No', width: 5 },
  { key: 'chapter', label: '工程', width: 16 },
  { key: 'shot', label: '写真', width: 26 },      // 絵を貼る列(幅は絵に合わせる)
  { key: 'step', label: '作業手順', width: 30 },
  { key: 'point', label: '急所', width: 30 },
  { key: 'why', label: '急所の理由', width: 34 },
  { key: 'holdSec', label: '静止', width: 7 },
];

/** 1行を、表に出す文字にする。⚠数字の単位はここで付ける(表示ごとにズレないように)。 */
export const cellText = (row, key) => {
  if (!row) return '';
  if (key === 'holdSec') return row.holdSec > 0 ? `${Math.round(row.holdSec * 10) / 10}秒` : '';
  if (key === 'shot') return '';                 // 絵は別で貼る
  const v = row[key];
  return v == null ? '' : String(v);
};
