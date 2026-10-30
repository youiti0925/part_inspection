#!/usr/bin/env node
// ============================================================================
// 🔒 社内版の出力(dist-onprem)の関門(4アプリ共通・同じ中身)
// ----------------------------------------------------------------------------
//   node scripts/onprem-dist-guard.mjs [出力先(既定 dist-onprem)] --write   … 作る時: 調べて、配る物の一覧(onprem-files.json)を書く
//   node scripts/onprem-dist-guard.mjs [出力先(既定 dist-onprem)]           … 後から: 調べて、一覧と出力が今も同じかを確かめる
//   問題があれば一覧を出して終了コード 1(npm run build:onprem を失敗で終わらせる)。
//
// 🔒 2026-10-31 R17: 「配ってよい物だけ」の作り(許す一覧)に替えた。
//   前は「配らない名前の一覧」(device-login.json・*.key・*.pem・設定の email/password)で止めていたので、
//   一覧に無い名前(device-login (1).json・*.bak・onprem-config.old.json・superuser.json・.env・device-login.txt・server.pfx)は
//   止まらなかった(2回目の独立した検証で 8つのうち 1つしか止めなかった)。
//   今は、出力の全部のファイルが下の形(ALLOWED_DIST_PATH)に合わなければ失敗。合った物だけを一覧に書き、
//   入口(https-front)は一覧に名前と sha256 がそのまま載った物だけを配る(ほかは名前が何でも 404)。
//   ⚠形は入口(tools/onprem/https-front/server.mjs)の ALLOWED_DIST_PATH と同じ。片方を変えたら両方を変える。
// 形に合っても中を見る物:
//   ・JSON(manifest*.json・version.json・onprem-build.json・onprem-config.sample/example.json)… JSON として読めて、
//     合言葉に当たるキー(email・password・token・secret など・入れ子も)が無い事
//   ・設定の見本(onprem-config.sample/example.json)… 決めたキー(url・pbUrl・authCollection・appUrls・deviceName・'_' で始まる説明)だけ・値は文字
// 置かない物: リンク(シンボリックリンク・ジャンクション)・普通のファイルでない物・空の名前の区切り
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 配る物の一覧のファイル名(入口はこれ自体を配らない)。 */
export const DIST_MANIFEST = 'onprem-files.json';
/** 配ってよいファイルの形(出力の中の相対パス・/ 区切り・大文字小文字そのまま)。入口の ALLOWED_DIST_PATH と同じ。 */
// 🔒 2026-10-31 R30: 見本・試しのファイル(parallel-lab-sample.html・onprem-config.sample/example.json)は配る形から外した。
//   作る時(--write)に出力から消す(DROP_FROM_DIST)。見本はリポジトリの中の物(docs/・onprem/)を見る。
//   vite.svg は最終の index.html が使う(<link rel="icon">)ので残す。
export const ALLOWED_DIST_PATH = /^(?:index\.html|assets\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|wasm)|notice-assets\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}\.(?:png|jpe?g|gif|webp|svg)|(?:onprem-)?sw\.js|boot-inline-[0-9a-f]{6,64}\.js|manifest(?:-[a-z0-9]{1,32})?\.json|icon-\d{2,4}\.png|favicon\.(?:svg|ico|png)|icons\.svg|vite\.svg|version\.json|onprem-build\.json)$/;
/** 作る時に出力から消す見本・試しのファイル(出力の一番上の名前)。 */
export const DROP_FROM_DIST = Object.freeze(['parallel-lab-sample.html', 'onprem-config.sample.json', 'onprem-config.example.json']);

const CREDENTIAL_KEY = /^(email|e[-_]?mail|mail|identity|username|user|login|pwd|pin|auth)$|pass(word)?|secret|token|credential|api[-_]?key|private/i;
const SAMPLE_CONFIG = /^onprem-config\.(sample|example)\.json$/;
const SAMPLE_KEYS = new Set(['url', 'pbUrl', 'authCollection', 'appUrls', 'deviceName']);

/** 合言葉に当たるキーの場所('a.b' の形)の一覧。 */
export const credentialKeys = (obj, prefix = '') => {
  const out = [];
  if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...credentialKeys(v, `${prefix}[${i}]`)));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const at = prefix ? `${prefix}.${k}` : k;
      if (CREDENTIAL_KEY.test(k)) out.push(at);
      else out.push(...credentialKeys(v, at));
    }
  }
  return out;
};

/** 設定の見本の形の問題(決めたキーだけ・値は文字)。 */
const sampleProblems = (j) => {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['オブジェクトでない'];
  const out = [];
  for (const [k, v] of Object.entries(j)) {
    if (k.startsWith('_')) { if (typeof v !== 'string') out.push(`${k} は文字だけ`); continue; }
    if (!SAMPLE_KEYS.has(k)) { out.push(`${k} は見本に書かないキー`); continue; }
    if (k === 'appUrls') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string')) out.push('appUrls は { 名前: 文字 } だけ');
    } else if (typeof v !== 'string') out.push(`${k} は文字だけ`);
  }
  return out;
};

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 出力の全部のファイルを調べる。@returns {{ problems: string[], files: Record<string, {size, sha256}> }} */
const scan = (dir) => {
  const problems = []; const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (e.isSymbolicLink()) { problems.push(`${rel}: リンクは出力に置かない`); continue; }
      if (e.isDirectory()) {
        let st; try { st = fs.lstatSync(p); } catch { st = null; }
        if (!st || st.isSymbolicLink()) { problems.push(`${rel}: リンクは出力に置かない`); continue; }
        walk(p); continue;
      }
      if (rel === DIST_MANIFEST) continue;
      if (!e.isFile()) { problems.push(`${rel}: 普通のファイルでない`); continue; }
      if (!ALLOWED_DIST_PATH.test(rel)) { problems.push(`${rel}: 配ってよい物の形に合わない(出力に置かない。要る物なら入口と関門の ALLOWED_DIST_PATH に足す)`); continue; }
      if (/\.json$/.test(rel)) {
        let j;
        try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (err) { problems.push(`${rel}: JSON として読めない(中を確かめられない): ${err.message}`); continue; }
        const keys = credentialKeys(j);
        if (keys.length) { problems.push(`${rel}: 合言葉に当たるキーがある(${keys.join(', ')})`); continue; }
        if (SAMPLE_CONFIG.test(rel)) {
          const sp = sampleProblems(j);
          if (sp.length) { problems.push(`${rel}: 設定の見本の形が違う(${sp.join(', ')})`); continue; }
        }
      }
      files[rel] = { size: fs.statSync(p).size, sha256: sha256File(p) };
    }
  };
  walk(dir);
  return { problems, files };
};

/** 出力先を調べ、問題の一覧を返す(無ければ [])。requireManifest のとき、一覧(onprem-files.json)と出力が同じかも確かめる。 */
export const checkOnpremDist = (dir, { requireManifest = false } = {}) => {
  if (!fs.existsSync(dir)) return [`出力先がありません: ${dir}`];
  const { problems, files } = scan(dir);
  if (requireManifest) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, DIST_MANIFEST), 'utf8')); } catch (e) { problems.push(`${DIST_MANIFEST} が読めない(--write で作る): ${e.code || e.message}`); return problems; }
    const listed = (m && m.files) || {};
    for (const [rel, meta] of Object.entries(listed)) {
      if (!files[rel]) problems.push(`${DIST_MANIFEST} の ${rel}: 出力に無い・形に合わない`);
      else if (files[rel].sha256 !== meta.sha256 || files[rel].size !== meta.size) problems.push(`${DIST_MANIFEST} の ${rel}: 中身が一覧と違う`);
    }
    for (const rel of Object.keys(files)) if (!(rel in listed)) problems.push(`${rel}: 一覧(${DIST_MANIFEST})に無い(入口は配らない)`);
  }
  return problems;
};

/** 調べて、問題が無ければ配る物の一覧を書く。@returns 問題の一覧(あれば書かない) */
export const writeOnpremManifest = (dir) => {
  if (!fs.existsSync(dir)) return [`出力先がありません: ${dir}`];
  try { fs.rmSync(path.join(dir, DIST_MANIFEST), { force: true }); } catch { /* 無ければよい */ }
  // R30: 見本・試しのファイルは配らない(出力から消す)
  for (const n of DROP_FROM_DIST) {
    const p = path.join(dir, n);
    try { if (fs.lstatSync(p).isFile()) { fs.rmSync(p); console.log(`🔒 [onprem-dist-guard] 見本・試しのファイル ${n} は配らないので出力から外しました(R30)`); } } catch { /* 無ければよい */ }
  }
  const { problems, files } = scan(dir);
  if (problems.length) return problems;
  if (!files['index.html']) return ['index.html がありません'];
  fs.writeFileSync(path.join(dir, DIST_MANIFEST), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
  return [];
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dir = path.resolve(root, pos[0] || 'dist-onprem');
  const write = process.argv.includes('--write');
  const shown = path.relative(root, dir) || dir;
  const problems = write ? writeOnpremManifest(dir) : checkOnpremDist(dir, { requireManifest: true });
  if (problems.length) {
    console.error(`\n❌ [onprem-dist-guard] 社内版の出力(${shown})に、配ってよい物の外の物・合言葉・鍵があります。消してから作り直してください:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const n = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, DIST_MANIFEST), 'utf8')).files).length;
  console.log(`🔒 [onprem-dist-guard] ${shown}: 全部のファイルが配ってよい物の形に合う(${n} 個)・合言葉・鍵 0 件。${write ? `一覧 ${DIST_MANIFEST} を書きました` : `一覧 ${DIST_MANIFEST} と同じ`}`);
}
