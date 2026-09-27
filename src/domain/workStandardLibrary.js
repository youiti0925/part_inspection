// ============================================================================
// 📚 作った作業標準を「資料の棚」へ入れる ／ ⑥ 承認した人と日付
// ----------------------------------------------------------------------------
// 清水さん(2026-08-15)
//   ③「印刷 → PDFで保存 → 資料ライブラリで新規登録、と手が3つ。忙しい現場では
//      使われずに死にます」
//   ⑥「作業者・品質保証から見て、原案と承認済みが見分けられること」
//
// ■ 何を棚に入れるか（ここが一番大事）
//   ⚠⚠ **PDFの中身は入れない。入れられない。**
//     この機能のPDFは「ブラウザの印刷」で作っている。つまり **アプリはPDFを持っていない**。
//     持っていない物を保存しようとすると、写真をbase64で抱え込むしかなくなり、
//     資料1本で 600KB(実測)。設定の箱は1ドキュメント1MB なので、
//     **1本入れただけで目標時間・型式マッピング・宛先グループまで保存できなくなる**
//     (2026-07-26 に実際に起きた。`fileOffload.js` / `lotCapacity.js` を見ること)。
//
//   → 棚に入れるのは **「どの動画の・どの要点か」だけ**(この1件で数KB)。
//     開いた時に、その動画から写真を作り直す。
//       ・保存が軽い（写真を持たない）
//       ・動画を直したら書類も直る
//
//   ⚠⚠ 引き換えに **元の動画が消えたら作り直せない**。だから
//     ①「元の動画：○○」を必ず書類に残す（videoName）
//     ②Driveに無い動画・挟んだ画像は「あとで作り直せません」と **入れる前に** 言う
//       (rebuildCheck)。あとで気づくのが一番まずい。
//
// ■ ⑥ 承認（1段だけ）
//   ⚠⚠ **多段承認の仕組みを作らない。** 段を増やすと運用が回らずに死ぬ。
//     「承認した / していない」の2つだけ。
//   ⚠ 取り消せること（押し間違いで詰まない）。
//   ⚠⚠ **承認したあとに中身が変わったら、承認は自動で外れる。**
//     承認済みの札が付いたまま中身が別物になるのが一番危ない。
//     → 承認した時の中身の指紋(contentKey)を一緒に持ち、今の中身と食い違ったら外す。
//   ⚠⚠ **文書番号・版・制定日は機械で採番しない**(2026-08-12 の約束)。
//     承認しても空欄のまま。勝手に番号を付けると偽の社内文書になる。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

import { baseTitle } from './workStandardDoc.js';
import { hashStr } from './fileOffload.js';
import { approxBytes } from './lotCapacity.js';

/** 棚の中でこの1件が「動画から作った作業標準」だと分かる印。 */
export const WS_KIND = 'video-standard';
export const RECIPE_VERSION = 1;

/**
 * 1件の上限。⚠⚠ 設定の箱(1MB)を全員で分け合っている。
 *   ふつうの1件は数KB。ここまで膨らむのは何かがおかしい(写真が紛れ込んだ等)ので、
 *   **入れさせない**。1件のために設定ごと保存不能にする方がはるかに損害が大きい。
 */
export const RECIPE_MAX_BYTES = 40_000;

const txt = (v) => String(v == null ? '' : v).trim();
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ymd = (ms) => {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

export const isVideoStandard = (entry) => !!entry && entry.kind === WS_KIND && !!entry.recipe;

/**
 * ⚠⚠ 写真(data:)が1文字でも紛れ込んでいないか、入れる前にふるいにかける。
 *   いまの中身に写真は無いが、あとで誰かが行にサムネイルを足した瞬間に
 *   設定の箱が死ぬ。**気づけないので、機械で落とす。**
 */
export const dropDataUrls = (v) => {
  if (typeof v === 'string') return v.startsWith('data:') ? '' : v;
  if (Array.isArray(v)) return v.map(dropDataUrls);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = dropDataUrls(x);
    return out;
  }
  return v;
};

/** 動画の素性。⚠driveId が無い動画は、あとで取り直せない = 写真を作り直せない。 */
export const sourceRefs = (sources) => (Array.isArray(sources) ? sources : [])
  .map((s) => ({ id: txt(s && s.id), name: txt(s && s.name), driveId: txt(s && s.driveId) }))
  .filter((s) => s.id);

/**
 * あとで写真を作り直せるか。**入れる前に人へ見せる文**もここで作る。
 * ⚠⚠ 「作り直せない」は欠陥ではなく仕様(元の動画が本体だから)。
 *   だから **黙らずに、何が作り直せないのかを名指しで** 言う。
 */
export const rebuildCheck = (doc, sources) => {
  const rows = (doc && doc.rows) || [];
  const refs = sourceRefs(sources);
  const byId = {};
  refs.forEach((s) => { byId[s.id] = s; });
  const freeze = rows.filter((r) => r && r.shot && r.shot.kind === 'freeze');
  const image = rows.filter((r) => r && r.shot && r.shot.kind === 'image');
  const missing = [];
  let okFreeze = 0;
  freeze.forEach((r) => {
    const s = byId[r.shot.srcId];
    if (s && s.driveId) { okFreeze++; return; }
    const nm = (s && s.name) || r.shot.srcId || '（名前の分からない動画）';
    if (!missing.includes(nm)) missing.push(nm);
  });
  const lines = [];
  if (missing.length) lines.push(`⚠この動画は Drive に保存されていないため、あとで写真を作り直せません：${missing.join(' / ')}。先に Drive へ保存してから入れてください。`);
  if (image.length) lines.push(`⚠🖼挟んだ画像の要点 ${image.length}件 は、あとで写真を作り直せません（画像はアプリに残らないため）。その行は「写真なし」で出ます。`);
  if (!rows.length) lines.push('要点がまだ1つもありません。');
  if (!lines.length) lines.push(`⏸止め絵 ${okFreeze}件 は、この棚から何度でも写真を作り直せます（元の動画：${txt(doc && doc.videoName) || '—'}）。`);
  return {
    ok: rows.length > 0 && missing.length === 0 && image.length === 0,
    freeze: { total: freeze.length, rebuildable: okFreeze },
    image: { total: image.length },
    missingVideos: missing,
    note: lines.join('\n'),
  };
};

/** 棚に並べた時に中身が当てられる名前。⚠拡張子は残さない(棚は書類の棚であって動画の棚ではない)。 */
export const defaultStandardName = (doc, sources) => {
  const vid = txt((doc && doc.videoName) || (sourceRefs(sources)[0] || {}).name).replace(/\.[^.]+$/, '');
  const model = txt(doc && doc.model);
  const head = model || vid || '';
  const tail = vid && vid !== head ? `（${vid}）` : '';
  return (`作業標準 ${head}${tail}`).trim().slice(0, 60);
};

/**
 * 📚 棚に入れる1件を組み立てる。**写真もPDFも持たない。**
 * @param doc  buildWorkStandard(...) の結果
 * @param opts.sources 編集室が持っている元動画 [{id,name,driveId}]
 * @param opts.name/category/description  棚での見出し(省略可)
 * @param opts.by  入れた人 / opts.at  入れた時刻 / opts.perPage 紙の並べ方
 *
 * ⚠id は付けない。棚に並べる時に App が採番する(既存の資料と同じ道を通す)。
 * ⚠文書番号・版・制定日は必ず空。
 */
export const buildLibraryEntry = (doc, opts = {}) => {
  const src = sourceRefs(opts.sources);
  const d0 = doc || {};
  const clean = dropDataUrls({
    ...d0,
    // ⚠⚠ 元の動画名は必ず埋める。ここが空だと、作り直せなくなった時に
    //   「何の動画だったのか」が世界のどこにも残らない。
    videoName: txt(d0.videoName) || (src[0] || {}).name || '',
    title: baseTitle(d0.title),
    // ⚠承認しても採番しない。ここも必ず空で持つ。
    docNo: '', rev: '', issuedAt: '',
  });
  return {
    kind: WS_KIND,
    name: txt(opts.name) || defaultStandardName(clean, src),
    category: txt(opts.category) || '動画から',
    description: txt(opts.description) || `動画の要点 ${((clean.rows || []).length)}件から作りました。元の動画：${clean.videoName || '—'}`,
    // ⚠⚠ PDFの中身は持たない(アプリが持っていない)。空文字で置く。
    pdfData: '',
    uploadedBy: txt(opts.by),
    recipe: {
      v: RECIPE_VERSION,
      savedAt: num(opts.at, 0) || Date.now(),
      perPage: num(opts.perPage, 2),
      sources: src,
      doc: clean,
    },
  };
};

/**
 * 中身の指紋。**承認が生きているかの判定にだけ使う。**
 * ⚠見るのは「紙に出る中身」だけ。棚の見出し(名前・分類・説明)を直しただけで
 *   承認が飛ぶと運用が回らない。
 * ⚠並び順まで見る(順番が変われば別の標準)。
 */
export const contentKey = (entry) => {
  const r = (entry && entry.recipe) || {};
  const d = r.doc || {};
  const canon = JSON.stringify({
    title: baseTitle(d.title),
    model: txt(d.model), orderNo: txt(d.orderNo), videoName: txt(d.videoName),
    pic: d.pic || null,
    src: (r.sources || []).map((s) => [s.id, s.driveId, s.name]),
    rows: (d.rows || []).map((x) => [x.no, x.chapter, x.step, x.point, x.why, x.holdSec, x.shot, x.marks, x.zoom, x.hides]),
  });
  return hashStr(canon) + canon.length.toString(36);
};

/** 'none'(原案) / 'approved'(承認済み) / 'stale'(承認後に中身が変わった=自動で外れた) */
export const approvalState = (entry) => {
  const a = entry && entry.approval;
  if (!a || !txt(a.by)) return 'none';
  return a.key === contentKey(entry) ? 'approved' : 'stale';
};
export const isApproved = (entry) => approvalState(entry) === 'approved';

/**
 * ⑥ 承認する。**1段だけ**(段や順番は持たせない)。
 * ⚠だれが承認したのかが空の承認は作らない(あとで誰にも聞けない)。
 */
export const approveEntry = (entry, by, at = Date.now()) => {
  const who = txt(by);
  if (!who) throw new Error('承認した人の名前がありません。');
  return { ...(entry || {}), approval: { by: who, at: num(at, Date.now()), key: contentKey(entry) } };
};

/** ⚠承認を取り消せる（押し間違いで詰まない）。 */
export const unapproveEntry = (entry) => ({ ...(entry || {}), approval: null });

/** 画面に出す一言。⚠「外れた」ことを黙らない。 */
export const approvalLabel = (entry) => {
  const st = approvalState(entry);
  const a = (entry && entry.approval) || {};
  if (st === 'approved') return `承認済み（${a.by}・${ymd(a.at)}）`;
  if (st === 'stale') return `⚠中身が変わったので承認は外れました（前の承認：${a.by}・${ymd(a.at)}）。もう一度承認してください。`;
  return '原案（未承認）';
};

/**
 * 棚の1件 → 紙・Excel にできる書類。
 * ⚠⚠ 承認が生きている時だけ承認を載せる。外れた承認者の名前を紙に出すと、
 *   その人が承認していない中身に名前が付いて配られることになる。
 */
export const entryToDoc = (entry) => {
  const d = (entry && entry.recipe && entry.recipe.doc) || {};
  const approved = isApproved(entry);
  const a = (entry && entry.approval) || {};
  return {
    ...d,
    // ⚠⚠ 承認しても採番しない。
    docNo: '', rev: '', issuedAt: '',
    approval: approved ? { by: a.by, at: a.at } : null,
  };
};

/** この1件の重さ(JSONの長さ)。⚠設定の箱は全員で分け合っている。 */
export const entryBytes = (entry) => approxBytes(entry);
export const entryTooBig = (entry) => entryBytes(entry) > RECIPE_MAX_BYTES;
