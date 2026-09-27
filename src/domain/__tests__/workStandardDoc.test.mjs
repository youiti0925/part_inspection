// 📄 動画の要点 → 作業標準
//
// ⚠⚠ この試験の主役は **「勝手に埋めないこと」**。
//   空欄を推測で埋めると、現場が嘘の標準に従うことになる。
//   空欄は空欄のまま出して、**何件足りないかを名指しで言う**のが正しい。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELDS, isStandardClip, rowOfClip, chapterAt, buildWorkStandard,
  missingNote, standardFileName, COLUMNS, cellText,
  zoomProgressForStill, hidesForRow,
} from '../workStandardDoc.js';
import { timelineOf } from '../videoProject.js';

const proj = (clips) => ({ clips, overlays: [], quality: 'mid', fps: 30 });
const vid = (id, sec) => ({ id, type: 'video', srcId: 's1', start: 0, end: sec, speed: 1 });
const frz = (id, o = {}) => ({ id, type: 'freeze', srcId: 's1', atSec: 10, durationSec: 3, marks: [], caption: '', ...o });
const img = (id, o = {}) => ({ id, type: 'image', imageId: 'i1', durationSec: 5, marks: [], caption: '', ...o });

test('W01 作業標準の1行になるのは「止めた絵」と「挟んだ画像」だけ', () => {
  assert.equal(isStandardClip(vid('c1', 10)), false, '⚠流れている映像を行にすると、全部が行になって使えない');
  assert.equal(isStandardClip(frz('c2')), true);
  assert.equal(isStandardClip(img('c3')), true);
  assert.equal(isStandardClip(null), false);
});

test('W02 ⚠字幕(caption)を作業手順に流用しない。ただし空なら初期値に使う', () => {
  // caption は映像に焼き込まれる字幕。書類のために書き換えると動画の見た目が変わる。
  const a = rowOfClip(frz('c1', { caption: 'ねじを締める', step: '', point: '', why: '' }));
  assert.equal(a.step, 'ねじを締める', '今までの動画からもすぐ作業標準が作れる');
  // step が入っていれば caption には**戻さない**(別々の物)
  const b = rowOfClip(frz('c1', { caption: 'ねじを締める', step: '銘板を貼る' }));
  assert.equal(b.step, '銘板を貼る');
  assert.equal(b.point, '');
  assert.equal(b.why, '');
});

test('W03 ⚠⚠空欄を勝手に埋めない。何件足りないかを名指しで言う', () => {
  const p = proj([vid('c0', 5), frz('c1', { caption: 'ねじを締める' }), frz('c2', { step: '銘板を貼る', point: '上端を線に合わせる' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.equal(doc.rows.length, 2, '映像は行にならない');
  // 推測で入っていないこと
  assert.equal(doc.rows[0].point, '', '⚠急所を推測で作ってはいけない');
  assert.equal(doc.rows[0].why, '');
  assert.deepEqual(doc.missing, { step: 0, point: 1, why: 2 });
  const note = missingNote(doc);
  assert.ok(/急所 1件/.test(note), note);
  assert.ok(/急所の理由 2件/.test(note), note);
  assert.ok(/こちらでは埋めません/.test(note), '⚠「埋めない」と明言する');
});

test('W04 全部埋まっていれば、足りないとは言わない', () => {
  const p = proj([frz('c1', { step: 'あ', point: 'い', why: 'う' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.deepEqual(doc.missing, { step: 0, point: 0, why: 0 });
  assert.ok(/すべてに/.test(missingNote(doc)));
});

test('W05 要点が1つも無い時は、どうすればいいかを言う', () => {
  const p = proj([vid('c0', 10)]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.equal(doc.rows.length, 0);
  assert.ok(/止めて印を出す/.test(missingNote(doc)), '⚠「0件です」だけだと次に何をすればいいか分からない');
});

test('W06 ⚠⚠文書番号・版・制定日は空欄で出す(勝手に採番すると偽の社内文書)', () => {
  const p = proj([frz('c1', { step: 'あ' })]);
  const doc = buildWorkStandard(p, {
    timeline: timelineOf(p),
    meta: { docNo: '579-KQ-012', rev: '3', issuedAt: '2026-08-14', title: '手順書' },
  });
  assert.equal(doc.docNo, '', '⚠渡されても捨てる');
  assert.equal(doc.rev, '');
  assert.equal(doc.issuedAt, '');
  assert.equal(doc.title, '手順書', 'タイトルは受け取る');
});

test('W07 どの工程(章)の要点かが入る', () => {
  const chapters = [{ name: '外観', atOut: 0 }, { name: 'ねじ締め', atOut: 20 }];
  assert.equal(chapterAt(chapters, 0), '外観');
  assert.equal(chapterAt(chapters, 19.9), '外観');
  assert.equal(chapterAt(chapters, 20), 'ねじ締め');
  assert.equal(chapterAt(chapters, 100), 'ねじ締め');
  assert.equal(chapterAt([], 5), '', '章が無くても落ちない');
  assert.equal(chapterAt([{ name: '後半', atOut: 50 }], 10), '', '⚠最初の章より前は空(嘘の工程名を付けない)');
});

test('W08 並びは動画の順。番号は1から振り直す', () => {
  const p = proj([vid('c0', 10), frz('c1', { step: 'A' }), vid('c2', 10), img('c3', { step: 'B' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p), chapters: [{ name: '前半', atOut: 0 }, { name: '後半', atOut: 15 }] });
  assert.deepEqual(doc.rows.map(r => r.no), [1, 2]);
  assert.deepEqual(doc.rows.map(r => r.step), ['A', 'B']);
  assert.equal(doc.rows[0].chapter, '前半');
  assert.equal(doc.rows[1].chapter, '後半', `2件目の出来上がり秒=${doc.rows[1].atOut}`);
});

test('W09 絵をどこから取るかが行に入っている', () => {
  const p = proj([frz('c1', { srcId: 'sA', atSec: 42.5 }), img('c2', { imageId: 'iB' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.deepEqual(doc.rows[0].shot, { kind: 'freeze', srcId: 'sA', atSec: 42.5 });
  assert.deepEqual(doc.rows[1].shot, { kind: 'image', imageId: 'iB' });
});

test('W10 表は1つの形から作る(ExcelとPDFで中身が違わない)', () => {
  assert.deepEqual(COLUMNS.map(c => c.key), ['no', 'chapter', 'shot', 'step', 'point', 'why', 'holdSec']);
  const p = proj([frz('c1', { step: 'あ', point: 'い', why: 'う', durationSec: 3 })]);
  const r = buildWorkStandard(p, { timeline: timelineOf(p) }).rows[0];
  assert.equal(cellText(r, 'holdSec'), '3秒', '⚠単位はここで付ける(表示ごとにズレない)');
  assert.equal(cellText(r, 'shot'), '', '絵の列は文字を出さない');
  assert.equal(cellText(r, 'step'), 'あ');
  assert.equal(cellText(r, 'no'), '1');
});

test('W11 ファイル名を見れば中身が分かる', () => {
  const at = new Date(2026, 7, 14).getTime();
  const p = proj([frz('c1', { step: 'あ' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p), meta: { model: 'TK-1', madeAt: at } });
  assert.equal(standardFileName(doc, 'xlsx'), '作業標準_TK-1_20260814.xlsx');
  assert.equal(standardFileName(doc, 'pdf'), '作業標準_TK-1_20260814.pdf');
  // ⚠使えない字を落とす(保存が黙って失敗しない)
  const doc2 = buildWorkStandard(p, { timeline: timelineOf(p), meta: { model: 'A/B:C', madeAt: at } });
  assert.equal(/[\\/:*?"<>|]/.test(standardFileName(doc2)), false, standardFileName(doc2));
});

test('W12 3つの欄の名前と上限が1か所で決まっている', () => {
  assert.deepEqual(FIELDS.map(f => f.key), ['step', 'point', 'why']);
  assert.deepEqual(FIELDS.map(f => f.label), ['作業手順', '急所', '急所の理由']);
  // ⚠それぞれに「どんなことを書くか」の例が付いていること(空欄のまま配られないように)
  for (const f of FIELDS) { assert.ok(f.hint.includes('例'), `${f.label} に例が無い`); assert.ok(f.max >= 60); }
});

test('W13 壊れた入力でも落ちない(書類作りの途中で止まると何も出ない)', () => {
  for (const bad of [null, undefined, {}, { clips: 'x' }, { clips: [null, 5, { type: 'freeze' }] }]) {
    const doc = buildWorkStandard(bad, {});
    assert.equal(Array.isArray(doc.rows), true);
    assert.equal(typeof missingNote(doc), 'string');
  }
});

// ---------------------------------------------------------------------------
// 📄 印刷する紙（PDFはこれを印刷して作る）
// ---------------------------------------------------------------------------
import { workStandardHtml, COMPANY, PER_PAGE, MIN_PHOTO_MM, photoBoxMm, cardMm, paginate, MIN_PHOTO_BOX_MM } from '../workStandardPrint.js';

// ⚠⚠ 2026-08-15 に紙の作りを変えた。**表をやめて「1要点=1カード」**にしたため、
//   列見出しは紙に出ない。理由: 表にすると A4の幅190mm を7列で割るので写真が
//   **62mm(名刺サイズ)** になり、現場で印が見えない。清水さんに「あほみたいに小さい」
//   と言われて作り直した。**作業標準は写真が本体**。
//   → 見るのは「列見出しが在るか」ではなく **中身が全部載っているか**。
test('W14 紙に中身が全部載る(表をやめてカードにしても抜けない)', () => {
  const p = proj([frz('c1', { step: 'ねじを締める', point: '斜めに入れない', why: 'ねじ山がつぶれる', durationSec: 3 })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p), meta: { model: 'TK-1', madeBy: '清水' } });
  const html = workStandardHtml(doc, { c1: 'data:image/png;base64,AAA' });
  assert.ok(html.includes('ねじを締める') && html.includes('斜めに入れない') && html.includes('ねじ山がつぶれる'));
  assert.ok(html.includes('急所') && html.includes('急所の理由'), '欄の名前は出る');
  assert.ok(html.includes('3秒'), '静止の秒が出る');
  assert.ok(html.includes('data:image/png;base64,AAA'), '写真が貼られる');
  assert.ok(html.includes(COMPANY));
});

// ⚠⚠ **これが「あほみたいに小さい」の再発防止**。
//   紙の幅から写真の幅を決めているので、ここが崩れたら必ず落ちる。
//   実寸の確認は scripts/verify-work-standard.mjs が本物のブラウザでミリで測る。
test('W14b ⚠⚠写真の幅を「紙の幅から」決めている(中身の大きさに合わせない)', () => {
  const p = proj([frz('c1', { step: 'あ' })]);
  for (const n of [1, 2, 4]) {
    const html = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), { c1: 'x' }, { perPage: n });
    const m = html.match(/\.photo \{ width:(\d+)mm/);
    assert.ok(m, `${n}つ/ページ: 写真の幅が決め打ちになっていない`);
    assert.ok(Number(m[1]) >= MIN_PHOTO_MM, `${n}つ/ページ: 写真が ${m[1]}mm。${MIN_PHOTO_MM}mm 未満は現場で見えない`);
  }
  // 既定(2つ)は紙の幅の8割以上
  const html2 = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), { c1: 'x' });
  assert.ok(Number(html2.match(/\.photo \{ width:(\d+)mm/)[1]) >= 150, '既定の写真が150mm未満');
  // ⚠選べる並べ方すべてに、最低の大きさが守られていること
  for (const pp of PER_PAGE) assert.ok(pp.photoMm >= MIN_PHOTO_MM, `${pp.n}つ/ページ の ${pp.photoMm}mm が小さすぎる`);
});

test('W15 ⚠⚠文書番号・版・制定日は「空の枠」で出る(勝手に埋めない)', () => {
  const p = proj([frz('c1', { step: 'あ' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p), meta: { docNo: '579-KQ-012', rev: '3' } });
  const html = workStandardHtml(doc, {});
  assert.ok(html.includes('文書番号'), '枠は在る');
  assert.equal(html.includes('579-KQ-012'), false, '⚠渡された番号を紙に出してはいけない');
  assert.ok(/class="blank"/.test(html), '空の枠として出す');
});

test('W16 ⚠写真が用意できなかった行は「写真なし」と書く(黙って詰めない)', () => {
  const p = proj([frz('c1', { step: 'あ' }), frz('c2', { step: 'い' })]);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  const html = workStandardHtml(doc, { c1: 'data:image/png;base64,AAA' });   // c2 は無い
  assert.ok(html.includes('写真なし'), '⚠無いことを黙らない(あとで「元から無い」と誤解される)');
});

test('W17 ⚠空欄があると紙の上でも警告する(空のまま配られない)', () => {
  const p = proj([frz('c1', { step: 'あ' })]);
  const html = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {});
  assert.ok(/まだ書かれていない所が 2か所/.test(html), html.slice(html.indexOf('warn'), 200));
  assert.ok(/推測では埋めていません/.test(html));
  // 全部埋まっていれば警告を出さない
  const p2 = proj([frz('c1', { step: 'あ', point: 'い', why: 'う' })]);
  assert.equal(/まだ書かれていない所/.test(workStandardHtml(buildWorkStandard(p2, { timeline: timelineOf(p2) }), {})), false);
});

test('W18 ⚠字を安全に埋める(< や & で紙が壊れない)', () => {
  const p = proj([frz('c1', { step: '<script>alert(1)</script>', point: 'A & B', why: '1行目\n2行目' })]);
  const html = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {});
  assert.equal(html.includes('<script>alert(1)</script>'), false, '⚠そのまま埋めると紙が壊れる');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('A &amp; B'), '& が先に置き換わっている(順を逆にすると二重になる)');
  assert.ok(html.includes('1行目<br>2行目'), '改行が紙でも改行になる');
});

test('W19 ⚠カードの途中で改ページしない(写真と説明が別の紙に分かれない)', () => {
  const p = proj([frz('c1', { step: 'あ' }), frz('c2', { step: 'い' }), frz('c3', { step: 'う' })]);
  const html = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {});
  assert.ok(/page-break-inside:\s*avoid/.test(html), 'カードが紙をまたいで切れる');
  // 2つずつページに分かれる(3件なら2ページ)
  assert.equal((html.match(/class="page"/g) || []).length, 2);
  assert.ok(/page-break-before:\s*always/.test(html), '2ページ目が前のページに続いてしまう');
  // ⚠1ページの数を変えたら、ページ数も変わること
  const h1 = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {}, { perPage: 1 });
  assert.equal((h1.match(/class="page"/g) || []).length, 3);
  const h4 = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {}, { perPage: 4 });
  assert.equal((h4.match(/class="page"/g) || []).length, 1);
});

test('W20 ⚠空の欄は紙の上で「未記入」と出る(空白のまま配られない)', () => {
  const p = proj([frz('c1', { step: 'あ' })]);
  const html = workStandardHtml(buildWorkStandard(p, { timeline: timelineOf(p) }), {});
  assert.equal((html.match(/未記入/g) || []).length >= 2, true, '急所と理由の両方に「未記入」が出る');
});

// ---------------------------------------------------------------------------
// 2026-08-15 の是正: 紙の写真が「動画で見えている絵」と違っていた / 紙からはみ出していた
// ---------------------------------------------------------------------------
test('W21 ⚠⚠画づくり(回転・切り抜き・明るさ)が書類にも渡る', () => {
  // これを渡していなかったので、縦に構えて撮って回した動画が **紙だけ横倒し** になっていた。
  const p = { ...proj([frz('c1', { step: 'あ' })]), rotate: 90, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, adjust: { brightness: 1.4, contrast: 1, saturate: 1 } };
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.equal(doc.pic.rotate, 90);
  assert.deepEqual(doc.pic.crop, { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.equal(doc.pic.adjust.brightness, 1.4);
  // 何も設定していない動画でも落ちない
  assert.equal(buildWorkStandard(proj([frz('c1')]), {}).pic.rotate, 0);
});

test('W22 ⚠⚠目隠し(モザイク)が紙とExcelにも付いてくる', () => {
  // 顔・他社名を隠した場面の写真が丸見えだと、その書類は社外へ出せない。
  const p = {
    ...proj([vid('c0', 5), frz('c1', { step: 'あ', durationSec: 3 })]),
    overlays: [
      { id: 'o1', kind: 'mosaic', rect: { x: 0, y: 0, w: 0.4, h: 0.4 }, from: 6, to: 6.5 },   // 止め絵の途中だけ
      { id: 'o2', kind: 'mosaic', rect: { x: 0.5, y: 0, w: 0.4, h: 0.4 }, from: 20, to: 22 }, // 別の場面
      { id: 'o3', kind: 'text', text: 'ねじ', from: 5, to: 8 },                                // 字幕は紙には出さない
    ],
  };
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  const r = doc.rows[0];
  assert.equal(r.atOut, 5, '止め絵は5秒から');
  assert.equal(r.hides.length, 1, '⚠少しでも重なっていれば持っていく(隠す方に倒す)');
  assert.equal(r.hides[0].id, 'o1');
  assert.equal(r.hides.some(o => o.kind === 'text'), false, '字幕は写真に焼かない(欄に文字で出るので二重になる)');
  // 端がぴったり重なる場合も持っていく(隠す方に倒す)
  assert.equal(hidesForRow(p.overlays, 5, 3).length, 1);
  assert.equal(hidesForRow([{ kind: 'mosaic', from: 0, to: 5 }], 5, 3).length, 1, '止め絵の頭でちょうど終わる目隠しも拾う(境目で丸見えにしない)');
  assert.equal(hidesForRow(null, 0, 3).length, 0, '重ねが無くても落ちない');
});

test('W23 ⚠寄り(ズーム)は「いちばん寄っている方」を紙に出す', () => {
  assert.equal(zoomProgressForStill(null), 1, '寄りが無くても落ちない');
  assert.equal(zoomProgressForStill({ from: { scale: 1 }, to: { scale: 2.5 } }), 1, '寄っていく → 寄り切った方');
  assert.equal(zoomProgressForStill({ from: { scale: 3 }, to: { scale: 1 } }), 0, '引いていく → 寄っている始めの方');
  // 行に寄りが載っていること(載っていないと紙だけ引きのまま)
  const p = proj([frz('c1', { step: 'あ', zoom: { from: { scale: 2, cx: 0.9, cy: 0.5 }, to: { scale: 2, cx: 0.9, cy: 0.5 } } })]);
  assert.equal(buildWorkStandard(p, { timeline: timelineOf(p) }).rows[0].zoom.from.scale, 2);
});

test('W24 ⚠⚠長い文でも文字を切らない。写真の枠の方を小さくする', () => {
  const pp2 = PER_PAGE.find(x => x.n === 2);
  const shortRow = { step: 'ねじを締める', point: '斜めに入れない', why: 'ねじ山がつぶれる' };
  const longRow = { step: 'あ'.repeat(60), point: 'い'.repeat(60), why: 'う'.repeat(80) };
  const a = photoBoxMm(shortRow, pp2), b = photoBoxMm(longRow, pp2);
  assert.ok(b < a, `長い文の行は写真が小さくなる(${a}mm → ${b}mm)`);
  assert.ok(a <= pp2.photoMaxMm, '短い文でも上限は超えない');
  assert.ok(b >= MIN_PHOTO_BOX_MM, 'これ以上は小さくしない(見えなくなる)');
  // カード1枚の高さは、A4の書ける高さ(277mm)を超えない
  for (const pp of PER_PAGE) assert.ok(cardMm(longRow, pp) <= 277, `${pp.n}つ/ページ: カードが紙より高い`);
});

test('W25 ⚠⚠ページは「入る高さ」で割る(N個ごとに割ると紙が増えて写真が切れる)', () => {
  const mk = (n, o = {}) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, no: i + 1, step: 'ねじを締める', point: '斜めに入れない', why: 'ねじ山がつぶれる', holdSec: 3, ...o }));
  const pp2 = PER_PAGE.find(x => x.n === 2);
  const pages = paginate(mk(5), pp2);
  // 1ページ目は見出し(題名・型式の表・警告)のぶん、入る数が少ない
  assert.equal(pages[0].length, 1, '1ページ目に2つ入れると 328mm になって必ずはみ出す(実測)');
  assert.ok(pages.slice(1).every(pg => pg.length === 2), '2ページ目からは2つずつ');
  assert.equal(pages.reduce((a, pg) => a + pg.length, 0), 5, '要点を1つも落とさない');
  // 長い文の要点は、入らなければ次の紙へ送る(切らない)
  const long = mk(4, { step: 'あ'.repeat(60), point: 'い'.repeat(60), why: 'う'.repeat(80) });
  const pl = paginate(long, PER_PAGE.find(x => x.n === 4));
  assert.equal(pl.reduce((a, pg) => a + pg.length, 0), 4);
  assert.ok(pl.length >= 2, '長い文4つを1枚に詰め込まない');
  // 要点が0件でも落ちない
  assert.deepEqual(paginate([], pp2), []);
});
