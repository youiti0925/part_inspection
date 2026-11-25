// 目的: 「App.firebase.jsx を字として読む」試験・台本が、分割後も同じ物を読めるようにする共通の読み口(App + src/features + src/app + 区画ファイルを連結した字)。
// 入力: repo の根(既定は呼ぶ所の cwd)。
// 出力: readAppSources() = [{ path, code }](App が先・残りは名前順)・readAppText() = 連結した字・findAt(text, 目印) = 目印の位置(無ければ例外)。
// 呼ぶ人: 原本読みの試験・台本(段0-2で1本ずつ置き換える)・scripts/report-source-readers.mjs・scripts/selftest-split-slice.mjs。
// 触る外の物: ファイルの読み込みだけ(書かない・ネットなし)。戻し読みの結果は os の一時フォルダに覚える。
// 11-15 追記: App を読む試験・見張りは restoreApp / withSlices / restoreIfApp / readWatchedFile(区画を App に戻した字=基準と同じ字)を通して読む。区画を後ろに足す旧い読み口(SLICE_SEP・sliceBetween など)は廃止。
// 確かめ方: node scripts/selftest-split-slice.mjs
//
// ⚠ 位置で切る読み方(「const X = の位置から3万字」)は連結では意味が変わる: 区画が別ファイルへ移ると、その3万字は区画の外を読む。
//   位置で切る物は readOwnerOf(text, 目印) で「目印を持つファイル」だけを読む形へ1本ずつ直す(直したら、わざと壊して赤になる事を1回確かめる)。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const APP_FILE = 'src/App.firebase.jsx';
const SPLIT_DIRS = ['src/features', 'src/app'];

function walkDir(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.test\.(m?js)$/.test(e.name) && !p.split(path.sep).includes('__tests__')) out.push(p.split(path.sep).join('/'));
  }
}

/** App が先、残り(features・app の下の部品)は名前順。 */
export function readAppSources(root = '.') {
  const files = [];
  for (const d of SPLIT_DIRS) walkDir(path.join(root, d), files);
  for (let i = 0; i < files.length; i++) files[i] = path.relative(root, files[i]).split(path.sep).join('/');
  files.sort();
  return [APP_FILE, ...files].map((p) => ({ path: p, code: fs.readFileSync(path.join(root, p), 'utf8') }));
}

export const readAppText = (root = '.') => readAppSources(root).map((s) => s.code).join('\n');

/** 目印の位置(連結した字の中)。無い・2つ以上は例外(「読めずに緑」を作らない)。 */
export function findAt(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`目印が見つからない: ${JSON.stringify(marker.slice(0, 40))}`);
  if (text.indexOf(marker, i + 1) >= 0) throw new Error(`目印が2つ以上ある: ${JSON.stringify(marker.slice(0, 40))}`);
  return i;
}

/** 目印を持つファイルだけの字(位置で切る読み方の置き換え先)。 */
export function readOwnerOf(marker, root = '.') {
  const hit = readAppSources(root).filter((s) => s.code.includes(marker));
  if (hit.length !== 1) throw new Error(`目印を持つファイルが ${hit.length} 個(1個のはず): ${JSON.stringify(marker.slice(0, 40))}`);
  return hit[0];
}

// ───── 戻し読み(11-15・Fable 確認書 A 章) ─────
// 区画を App に戻した字(= 切り出す前の基準の App と1文字も同じ)を作る共通の読み口。App を字で読む試験・見張りは、これを通して読む。
// 手順は verify-slice-proof の reverseOne と同じ: 台帳を新しい順に、import の1行を外す → 呼ぶ1行を本文に置き換える → importEdits を元に戻す。
// 目印が1個でなければ例外(読めずに緑にしない)。App 以外の字に掛けると呼ぶ1行が無いので例外で止まる(=黙って通さない)。
const BEGIN_MARK = '// ▼ 移した本文(ここから・1文字も変えていない)';
const END_MARK = '// ▲ 移した本文(ここまで)';
const countOf = (s, t) => s.split(t).length - 1;

/** 区画ファイルから、移した本文を取り出す(センチネルの行の間・verify-slice-proof の extractBody と同じ)。 */
export function extractSliceBody(newFile, type) {
  const eol = newFile.includes('\r\n') ? '\r\n' : '\n';
  const a = newFile.indexOf(BEGIN_MARK + eol);
  const b = newFile.indexOf(eol + END_MARK);
  if (a < 0 || b < 0 || b < a) return null;
  const body = newFile.slice(a + BEGIN_MARK.length + eol.length, b);
  return type === 'V' ? body : body + eol;
}

function restoreUncached(text, root, from) {
  const mf = path.join(root, 'scripts/slice-manifest.json');
  if (!fs.existsSync(mf)) throw new Error('区画の台帳が無い(戻し読みできない)');
  const entries = JSON.parse(fs.readFileSync(mf, 'utf8')).slices.filter((e) => e.from === from);
  let t = text;
  for (const e of [...entries].reverse()) {
    const nf = fs.readFileSync(path.join(root, e.to), 'utf8');
    const body = extractSliceBody(nf, e.type);
    if (body == null) throw new Error(`戻し読み ${e.id}: 区画の本文の目印の行が無い(${e.to})`);
    if (countOf(t, e.importLine) !== 1) throw new Error(`戻し読み ${e.id}: import の1行が ${countOf(t, e.importLine)} 個(1個のはず)`);
    if (countOf(t, e.callText) !== 1) throw new Error(`戻し読み ${e.id}: 呼ぶ1行が ${countOf(t, e.callText)} 個(1個のはず)`);
    t = t.replace(e.importLine, () => '').replace(e.callText, () => body);
    for (const x of e.importEdits || []) {
      if (countOf(t, x.after) !== 1) throw new Error(`戻し読み ${e.id}: 外した import の文が ${countOf(t, x.after)} 個(1個のはず)`);
      t = t.replace(x.after, () => x.before);
    }
  }
  return t;
}

/** 区画を戻した字(App を渡す)。結果は一時ファイルに覚える(鍵 = 入力の字・台帳・区画ファイルの中身。1回 1〜2秒)。 */
export function restoreApp(appText, root = process.cwd(), { from = APP_FILE, cache = true } = {}) {
  const text = appText.replace(/\r\n/g, '\n');
  const mf = path.join(root, 'scripts/slice-manifest.json');
  if (!fs.existsSync(mf)) throw new Error('区画の台帳が無い(戻し読みできない)');
  const mtxt = fs.readFileSync(mf, 'utf8');
  const h = crypto.createHash('sha1').update(text).update('\0').update(mtxt).update('\0').update(from);
  for (const e of JSON.parse(mtxt).slices.filter((x) => x.from === from)) {
    const f = path.join(root, e.to);
    h.update(`\0${e.to}\0${fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''}`);
  }
  const cf = path.join(os.tmpdir(), `restore-app-${h.digest('hex')}.txt`);
  if (cache) { try { const hit = fs.readFileSync(cf, 'utf8'); try { const n = new Date(); fs.utimesSync(cf, n, n); } catch { /* 使用中の印(新しい時刻)を付けられなくても読める */ } return hit; } catch { /* 無ければ作る */ } }
  const out = restoreUncached(text, root, from);
  if (cache) { try { const tmp = `${cf}.${process.pid}`; fs.writeFileSync(tmp, out); fs.renameSync(tmp, cf); } catch { /* 覚えられなくても読める */ } pruneRestoreCache(cf); }
  return out;
}

/**
 * 覚え書き(restore-app-*.txt・1件 約3.7MB)が一時フォルダに溜まり続けないよう、新しく作った時だけ古い物を片づける(11-15 確認書 直す物6)。
 * 消す物 = ふつうのファイルで名前が restore-app-<40桁>.txt の物のうち「最後に読まれた/作られた時刻(読む時に更新する)が 6時間より前」か、「新しい順に 12 件を超えた分のうち 10 分より前」。
 * 他の担当が今使っている物(さっき読んだ=時刻が新しい)は消さない。フォルダ・リンクには入らない(lstat でふつうのファイルだけ・読み込み中で消せないものは飛ばす)。覚え書きは作り直せる写しなので、消えても正しさは変わらない(1〜2秒かかるだけ)。
 */
export function pruneRestoreCache(keep, { dir = os.tmpdir(), maxAgeMs = 6 * 3600e3, keepNewest = 12, graceMs = 10 * 60e3, now = Date.now() } = {}) {
  try {
    const rows = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/^restore-app-[0-9a-f]{40}\.txt$/.test(name)) continue;
      const f = path.join(dir, name);
      let st; try { st = fs.lstatSync(f); } catch { continue; }
      if (!st.isFile()) continue;
      rows.push({ f, t: st.mtimeMs });
    }
    rows.sort((a, b) => b.t - a.t);
    rows.forEach((r, i) => {
      if (keep && path.resolve(r.f) === path.resolve(keep)) return;
      const old = now - r.t > maxAgeMs;
      const over = i >= keepNewest && now - r.t > graceMs;
      if (old || over) { try { fs.unlinkSync(r.f); } catch { /* 使用中・権限は飛ばす */ } }
    });
  } catch { /* 片づけられなくても読める */ }
}

/** 見張りが「1本のファイルの字」を読む口。App.firebase.jsx なら区画を戻した字(基準と同じ字)・それ以外はそのまま。行番号は戻した字の行(区画の ファイル:行 ではない)。 */
export function readWatchedFile(file, root = process.cwd()) {
  const raw = fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file), 'utf8');
  return restoreIfApp(file, raw, root);
}

/** 台帳(slice-manifest.json)の to = 区画ファイルの道(root からの相対・/ 区切り)の集まり。台帳が無ければ空。App を戻し読みで読む見張りは、これを「別の1本として数えない」(本文は戻した App の中に在る=二重に数えない)。 */
export function sliceFilePaths(root = process.cwd()) {
  const mf = path.join(root, 'scripts/slice-manifest.json');
  if (!fs.existsSync(mf)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(mf, 'utf8')).slices.map((s) => s.to));
}

/** file が App.firebase.jsx で、台帳の在る木なら、区画を戻した字を返す(台帳の無い木=作り物の試験用の木は、切り出していないのでそのまま)。 */
export function restoreIfApp(file, raw, root = process.cwd()) {
  if (!/(^|[\\/])App\.firebase\.jsx$/.test(file)) return raw;
  if (!fs.existsSync(path.join(root, 'scripts/slice-manifest.json'))) return raw;
  return restoreApp(raw, root);
}

/** App の字を、区画を戻した字にして返す(旧: App の後ろに区画の字を足す形)。呼ぶ側はそのまま。App 以外の字には掛けられない(例外)。 */
export const withSlices = (appText, root = process.cwd()) => restoreApp(appText, root);
