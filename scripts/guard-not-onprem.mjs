#!/usr/bin/env node
// 目的: 「社内版の混入止め」 社内版(VITE_ONPREM=1)を本番(Firebase Hosting の dist)へ混ぜないよう、ビルドと出す前に止める関門。
// 入力: vite の mode・VITE_ONPREM・.env 系ファイル・firebase.json の hosting.public・出力先の中の社内版の印。
// 出力: 問題が無ければ何も出さず終了コード 0・有れば理由を出して 1(vite の設定は plugin として止める)。
// 呼ぶ人: vite.config.js の onpremGuardPlugin・npm run build の prebuild・firebase.json の predeploy・scripts/deploy.mjs。
// 触る外の物: ファイルを読むだけ(何も書かない・firebase も vite も import しない)。
// 確かめ方: npm test(src/domain/__tests__/guardNotOnprem.test.mjs)・4アプリで中身が同じ事を md5 で比べる。
// ============================================================================
// 🛡 社内版(VITE_ONPREM=1)を本番(Firebase Hosting)へ混ぜない関門 — 4アプリ共通・中身は4つとも同じ(2026-10-30)
// ----------------------------------------------------------------------------
// ⚠⚠ このファイルは ③・製品・最終・部品の4アプリで **1文字も違わない** 写し。直す時は4つとも同じに直す
//    (試験 src/domain/__tests__/guardNotOnprem.test.mjs も4つ同じ。中身の一致は試験の外で md5 を比べて確かめる)。
//
// 何が起きうるか:
//   VITE_ONPREM=1 が環境変数か .env 系のファイルに残ったまま `npm run build` すると、
//   Firebase を使わない社内版の中身が dist/ に出来る。firebase.json の public は dist なので、
//   そのまま firebase deploy すると現場の本番が社内版に化ける。
//
// 決まり(4アプリ共通):
//   ① 社内版は `npm run build:onprem` からだけ作る = vite の mode が 'onprem' で、VITE_ONPREM=1。
//      ・mode が onprem 以外(いつものビルド・predeploy の npm run build)に VITE_ONPREM=1 → 止める。
//      ・mode が onprem なのに VITE_ONPREM=1 が無い → 止める(社内版の置き場に Firebase 版を入れない)。
//   ② 出力先は **解決して(resolve)・大文字小文字を区別せずに** 比べる。
//      ⚠Windows はパスの大文字小文字を区別しないので、`--outDir DIST` や `.\Dist\` も本番の dist と同じ所。
//        前の関門は名前を 'dist' と文字で比べていたので DIST で抜けられた(2026-10-30 に塞いだ)。
//      ・社内版の出力先が、本番の出力先(firebase.json の hosting.public・無ければ dist)と同じ・その中・その外側
//        のどれか、または名前が dist(大文字小文字問わず)→ 止める。
//      ・いつものビルドの出力先が dist-onprem(大文字小文字問わず)→ 止める。
//   ③ 出す前(firebase.json の predeploy・npm run build の前の prebuild・deploy.mjs):
//      ・環境変数 VITE_ONPREM=1 → 止める。
//      ・.env で始まる全部のファイル(.env / .env.local / .env.production / .env.development … )に
//        VITE_ONPREM=1 の行 → 止める。
//        ⚠例外は2種類だけ: 社内版の mode の物(.env.onprem / .env.onprem.local = build:onprem の時しか読まれない)と、
//          見本(.env.example / .env.sample / .env.template)。
//      ・本番の出力先(hosting.public)に社内版の印(ONPREM_MARKERS)がある → 止める(--no-dist の時は見ない)。
//
// 使い方:
//   vite.config.js      … plugins の先頭に onpremGuardPlugin()(設定が決まった所で①②を見る。止める時は何も書かない)
//   package.json        … "prebuild": "node scripts/guard-not-onprem.mjs --no-dist"(npm run build の前に③の環境変数と .env 系)
//   firebase.json       … predeploy の "npm run build" の直後に "node scripts/guard-not-onprem.mjs"(③を dist の中身まで)
//   scripts/deploy.mjs  … 最初に --no-dist・手でビルドする道ではビルドの直後に(引数なし)
//
// ⚠開発サーバ(vite dev)は止めない。ビルドと出す時だけ。
// ⚠firebase も vite も import しない(node の試験でそのまま読める)。本番へは何も繋がない(ファイルを読むだけ)。
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ONPREM_MODE = 'onprem';
export const ONPREM_OUT_DIR = 'dist-onprem';
export const PROD_OUT_DIR = 'dist';
/** 社内版のビルドにだけ出来る印(onpremGuardPlugin が出す)。4アプリ共通。 */
export const ONPREM_BUILD_MARKER = 'onprem-build.json';
/** 本番の出力先にあったら「社内版のビルド」と見なすファイル(共通の印+各アプリが前から出している物)。 */
export const ONPREM_MARKERS = [ONPREM_BUILD_MARKER, 'sw-onprem.js', 'onprem-sw.js', 'onprem-config.example.json'];
const TAG = '[guard-not-onprem]';

export const isOnpremFlag = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '') === '1';

// ---- パスの比べ方(解決して・区切りを / に・大文字小文字を区別しない) ------------------------
/** 比べる為の形: 絶対パスにし、区切りを / に揃え、末尾の / を落とし、小文字にする。 */
export const pathKey = (p, root = process.cwd()) => {
  const s = String(p ?? '');
  // Windows の書き方(C:\ や \\server\)は、どの OS で走らせても絶対パスとして扱う(試験を Linux でも同じにする)
  const abs = /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}/.test(s) ? s : resolve(String(root || process.cwd()), s);
  return abs.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
};
export const samePath = (a, b, root) => pathKey(a, root) === pathKey(b, root);
/** child が parent の中か(同じ所は含まない)。 */
export const isInside = (child, parent, root) => pathKey(child, root).startsWith(`${pathKey(parent, root)}/`);
const nameOf = (p) => basename(String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/')).toLowerCase();

/**
 * ビルドを止める理由(止めない時は '')。
 * @param command  vite の command('build' / 'serve')
 * @param mode     vite の mode
 * @param flag     VITE_ONPREM(loadEnv で読んだ物 = 環境変数と .env 系の両方)
 * @param outDir   出力先(相対なら root から)。省略 = dist
 * @param root     アプリの置き場
 * @param prodDirs 本番の出力先(firebase.json の hosting.public)。省略 = ['dist']
 */
export const onpremBuildProblem = ({ command, mode, flag, outDir, root = process.cwd(), prodDirs = [PROD_OUT_DIR] } = {}) => {
  if (command !== 'build') return '';
  const on = isOnpremFlag(flag);
  const onMode = mode === ONPREM_MODE;
  if (on && !onMode) {
    return `VITE_ONPREM=1 のまま いつものビルド(mode=${mode})をしようとしました。本番の dist/ に社内版が入るので止めます。`
      + ' 社内版は npm run build:onprem(出力 dist-onprem/)で作ってください。本番を作るなら環境変数と .env 系から VITE_ONPREM を外してください。';
  }
  if (onMode && !on) return '社内版のビルド(mode=onprem)なのに VITE_ONPREM=1 がありません。npm run build:onprem を使ってください。';
  const out = outDir == null || outDir === '' ? PROD_OUT_DIR : outDir;
  const prods = (prodDirs && prodDirs.length ? prodDirs : [PROD_OUT_DIR]);
  if (on) {
    const hit = nameOf(out) === PROD_OUT_DIR
      || prods.some((d) => samePath(out, d, root) || isInside(out, d, root) || isInside(d, out, root));
    if (hit) {
      return `社内版を本番の出力先(${prods.join(', ')}/)へ出そうとしました(出力先 ${out})。大文字小文字の違い(DIST など)も同じ所です。`
        + ` 出力先は ${ONPREM_OUT_DIR}/ にしてください。`;
    }
    return '';
  }
  if (nameOf(out) === ONPREM_OUT_DIR || samePath(out, ONPREM_OUT_DIR, root)) {
    return `VITE_ONPREM が無いのに出力先が ${ONPREM_OUT_DIR}/ です(${out})。社内版は npm run build:onprem で作ってください。`;
  }
  return '';
};

// ---- .env 系 -------------------------------------------------------------------------------
/** .env 系の中身から VITE_ONPREM=1 の行を探す(コメント行は見ない)。 */
export const envTextSetsOnprem = (text) => String(text || '').split(/\r?\n/).some((line) => {
  const m = /^\s*(?:export\s+)?VITE_ONPREM\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
  return !!m && isOnpremFlag(m[1]);
});
/** 見る .env 系か。.env で始まる物全部。⚠例外=社内版の mode の物と見本。 */
export const isCheckedEnvFile = (name) => {
  const n = String(name || '');
  if (!/^\.env(\..+)?$/i.test(n)) return false;
  if (/^\.env\.onprem(\.local)?$/i.test(n)) return false;
  if (/\.(example|sample|template)$/i.test(n)) return false;
  return true;
};

/** firebase.json の hosting.public を全部(無ければ ['dist'])。 */
export const hostingPublicDirs = (firebaseJsonText) => {
  try {
    const fb = JSON.parse(String(firebaseJsonText || ''));
    const hs = Array.isArray(fb.hosting) ? fb.hosting : fb.hosting ? [fb.hosting] : [];
    const dirs = hs.map((h) => h && h.public).filter((d) => typeof d === 'string' && d.trim());
    return dirs.length ? dirs : [PROD_OUT_DIR];
  } catch { return [PROD_OUT_DIR]; }
};

/**
 * 出す前の確かめ。止める理由を全部返す(空なら出してよい)。
 * @param root      アプリの置き場
 * @param env       process.env の様な物
 * @param listDir   (dir) => string[]  ファイル名の一覧
 * @param readFile  (path) => string | null
 * @param exists    (path) => boolean
 * @param prodDirs  本番の出力先(hosting.public)
 * @param checkDist false なら出力先の中身は見ない(--no-dist)
 */
export const deployOnpremProblems = ({ root, env = {}, listDir, readFile, exists, prodDirs = [PROD_OUT_DIR], checkDist = true }) => {
  const out = [];
  if (isOnpremFlag(env.VITE_ONPREM)) out.push('環境変数 VITE_ONPREM=1 が立っています(社内版の切替)。');
  let names = [];
  try { names = listDir(root) || []; } catch { names = []; }
  for (const f of [...names].sort()) {
    if (!isCheckedEnvFile(f)) continue;
    if (envTextSetsOnprem(readFile(join(root, f)))) out.push(`${f} に VITE_ONPREM=1 があります(社内版の切替)。`);
  }
  if (checkDist) {
    for (const d of prodDirs) {
      for (const m of ONPREM_MARKERS) {
        if (exists(join(resolve(root, d), m))) out.push(`${d}/${m} があります = ${d}/ は社内版のビルドです。`);
      }
    }
  }
  return out;
};

// ---- vite の部品(4アプリとも plugins の先頭に置く) --------------------------------------
/**
 * 設定が決まった所(--outDir・--mode まで合わさった後)で①②を見る。止める時は何も書かずにビルドを失敗させる。
 * 社内版のビルドの時だけ、出力に印(onprem-build.json)を出す(③が本番の出力先で見つける為)。
 * ⚠いつものビルドでは何も足さない = 本番の出力は今までと同じ。
 */
export const onpremGuardPlugin = () => {
  let onprem = false;
  return {
    name: 'guard-not-onprem',
    apply: 'build',
    enforce: 'pre',
    configResolved(c) {
      const flag = c.env && c.env.VITE_ONPREM;
      let fbText = '';
      try { fbText = readFileSync(join(c.root, 'firebase.json'), 'utf8'); } catch { fbText = ''; }
      const problem = onpremBuildProblem({
        command: c.command, mode: c.mode, flag, outDir: c.build && c.build.outDir, root: c.root, prodDirs: hostingPublicDirs(fbText),
      });
      if (problem) throw new Error(`${TAG} ${problem}`);
      onprem = isOnpremFlag(flag);
    },
    generateBundle() {
      if (!onprem) return;
      this.emitFile({ type: 'asset', fileName: ONPREM_BUILD_MARKER, source: `${JSON.stringify({ onprem: true, note: 'on-prem build. Never deploy this folder to Firebase Hosting.' })}\n` });
    },
  };
};

// ---- コマンドとして -------------------------------------------------------------------------
//   node scripts/guard-not-onprem.mjs            … 環境変数・.env 系・本番の出力先の中身(predeploy で build の直後)
//   node scripts/guard-not-onprem.mjs --no-dist  … 環境変数・.env 系だけ(prebuild・deploy.mjs の最初)
const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const root = process.env.DEPLOY_SAFETY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let fbText = '';
  try { fbText = readFileSync(join(root, 'firebase.json'), 'utf8'); } catch { fbText = ''; }
  const problems = deployOnpremProblems({
    root, env: process.env,
    listDir: (d) => readdirSync(d),
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    exists: existsSync,
    prodDirs: hostingPublicDirs(fbText),
    checkDist: !process.argv.includes('--no-dist'),
  });
  if (problems.length) {
    console.error(`❌ ${TAG} 社内版の印があるので、本番用のビルド・出荷を止めます:`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error('   社内版は npm run build:onprem(出力 dist-onprem/)。本番を出すなら上の印を外し、npm run build で dist/ を作り直してください。');
    process.exit(1);
  }
  console.log(`✓ ${TAG} 社内版の印なし(環境変数・.env 系${process.argv.includes('--no-dist') ? '' : '・本番の出力先'})`);
}
