#!/usr/bin/env node
/**
 * deploy-onprem.mjs — 社内サーバ版を社内サーバのフォルダへ写す(2026-10-29・点検 G10)
 * ===========================================================================
 * 使い方:
 *   npm run build:onprem                                   … dist-onprem を作る
 *   node scripts/deploy-onprem.mjs --to D:\inetpub\parts --dry-run   … 何をするかだけ出す
 *   node scripts/deploy-onprem.mjs --to D:\inetpub\parts             … 写す
 *
 * 決まり(firebase deploy の道とは別。firebase の道は scripts/deploy.mjs のまま):
 *   ① 先の assets/ は消さない(開きっぱなしの端末が前の版のファイルを取りに来ても 404 にしない。
 *      keep-old-assets.mjs と同じ理由・2026-08-17 の事故)。
 *   ② 先の onprem-config.json は上書きしない(サーバごとの行き先と合言葉が入っている)。
 *   ③ index.html は一番最後に写す(新しい index.html が先に出て、まだ無い assets を指す時間を作らない)。
 *   ④ 写す前に dist-onprem の中に外(Firebase・Worker)の字が残っていないか数えて出す(止めはしない。報告だけ)。
 * ⚠ このスクリプトは Firebase へは何も送らない。社内サーバのフォルダ(ネットワークドライブ可)へ写すだけ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const EXTERNAL_PATTERNS = ['firebaseapp.com', 'googleapis.com', 'workers.dev', 'web.app', 'gstatic.com'];
export const KEEP_IN_TARGET = ['onprem-config.json'];

/** 写す順番を決める(純関数・試験用)。index.html は最後。onprem-config.json は写さない。 */
export const planCopy = (srcFiles) => {
  const rel = srcFiles.map((f) => f.split(String.fromCharCode(92)).join('/'));
  const skip = rel.filter((f) => KEEP_IN_TARGET.includes(f));
  const body = rel.filter((f) => f !== 'index.html' && !KEEP_IN_TARGET.includes(f)).sort();
  const last = rel.includes('index.html') ? ['index.html'] : [];
  return { order: [...body, ...last], skip };
};

/** 外の字を数える(純関数・試験用)。 */
export const countExternal = (text) => Object.fromEntries(EXTERNAL_PATTERNS.map((p) => [p, text.split(p).length - 1]));

const walk = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
};

const main = () => {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : '';
  const src = path.join(ROOT, 'dist-onprem');
  if (!fs.existsSync(path.join(src, 'index.html'))) {
    console.error('dist-onprem/index.html がありません。先に npm run build:onprem を走らせてください。');
    process.exit(2);
  }
  if (!to) { console.error('写し先がありません: --to <社内サーバのフォルダ>'); process.exit(2); }
  const files = walk(src);
  const { order, skip } = planCopy(files);
  // ④ 外の字を数える
  const hits = {};
  for (const f of files) {
    if (!/\.(js|html|json|css)$/.test(f)) continue;
    const c = countExternal(fs.readFileSync(path.join(src, f), 'utf8'));
    for (const [k, v] of Object.entries(c)) if (v) (hits[f] ||= {})[k] = v;
  }
  console.log(`社内版: ${order.length}個を ${to} へ${dry ? '写す予定(--dry-run・何も写していません)' : '写します'}。index.html は最後。`);
  if (skip.length) console.log(`  写さない: ${skip.join(', ')}(写し先の物を残す)`);
  if (!fs.existsSync(path.join(to, KEEP_IN_TARGET[0]))) console.warn(`  ⚠ 写し先に ${KEEP_IN_TARGET[0]} がありません。docs/onprem-config.example.json を見て置いてください(無いと起動時に「行き先が決まっていません」と出ます)。`);
  if (Object.keys(hits).length) console.warn('  ⚠ 外の字が残っています(Firebase の SDK の中の字など。理由は報告を見てください):', JSON.stringify(hits));
  if (dry) return;
  for (const f of order) {
    const d = path.join(to, f);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(path.join(src, f), d);   // ⚠ 先の assets/ は消さない(上書きだけ)
  }
  console.log('写し終えました。');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
