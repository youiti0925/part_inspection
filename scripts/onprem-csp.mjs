#!/usr/bin/env node
// ============================================================================
// 社内版(dist-onprem)の画面に付ける CSP を、出来上がった出力から作る — 2026-10-30
// ----------------------------------------------------------------------------
//   node scripts/onprem-csp.mjs [--dist dist-onprem] [--out <ファイル>] [--json]
//
// 何をするか:
//   ・script-src に 'unsafe-inline' / 'unsafe-eval' を書かない。インラインで動く物は **中身の sha256** だけ許す:
//       ① index.html の <script>(読み込みの見張り・版の見張り)
//       ② 印刷の窓(about:blank に document.write)の <script>window.onload=…window.print()…</script>
//          (about:blank の窓は開いた画面の CSP を受け継ぐので、ここで許さないと印刷の画面が自動で出ない)
//       ③ 印刷の窓の <button onclick="window.print()">(属性の中の文は 'unsafe-hashes' + sha256 でだけ許せる)
//   ・中身が変わる(${…} を含む)インラインの script は許さない(見つけたら止めて知らせる)。
//   ・ビルドし直すと①の中身が変われば hash も変わる。出力を変えたら必ずこれを流し直して入口の設定を替える。
// ⚠ 本番(dist・Firebase Hosting)には使わない。社内版の入口(https-front)の CSP の材料。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIST = path.resolve(opt('--dist', 'dist-onprem'));
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

// ⚠ HTML の読み手は改行 CRLF を LF に直してから script の中身にする(CSP の hash もその中身で測る)。ファイルの CRLF のまま測ると合わない(実測 2026-10-30)。
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
const inlineHtml = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\ssrc\s*=/.test(m[1] || ''))
  .map((m) => m[2]);
const handlersHtml = [...html.matchAll(/\son[a-z]+\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);

const assets = path.join(DIST, 'assets');
const scriptsJs = [];
const handlersJs = [];
const dynamic = [];
const ignored = [];
for (const f of fs.readdirSync(assets).filter((n) => n.endsWith('.js'))) {
  const t = fs.readFileSync(path.join(assets, f), 'utf8');
  for (const m of t.matchAll(/<script>([\s\S]*?)<\\?\/script>/g)) {
    // 文字の部品として組み立てる所(core-js の古い IE 用 `<script>`+e+`</script>`・React の空の <script>)は動く script ではないので数えない
    if (!m[1] || m[1].includes('`')) { ignored.push(`${f}: ${JSON.stringify(m[0].slice(0, 60))}`); continue; }
    if (m[1].includes('${')) dynamic.push(`${f}: ${m[1].slice(0, 80)}`); else scriptsJs.push(m[1]);
  }
  for (const m of t.matchAll(/<[a-z]+[^<>`]*?\son([a-z]+)="([^"`$]*)"/g)) handlersJs.push(m[2]);
}
if (dynamic.length) { console.error('中身の変わるインラインの script があります(hash で許せません):\n' + dynamic.join('\n')); process.exit(2); }

const uniq = (a) => [...new Set(a)];
const scriptHashes = uniq([...inlineHtml, ...scriptsJs].map(sha));
const handlerHashes = uniq([...handlersHtml, ...handlersJs].map(sha));
const scriptSrc = ["'self'", ...scriptHashes, ...(handlerHashes.length ? ["'unsafe-hashes'", ...handlerHashes] : [])];

const result = {
  dist: DIST,
  inlineScripts: [...inlineHtml.map((s) => ({ from: 'index.html', length: s.length, hash: sha(s) })), ...uniq(scriptsJs).map((s) => ({ from: 'assets (印刷の窓)', text: s, hash: sha(s) }))],
  ignoredNotScripts: ignored,
  inlineHandlers: uniq([...handlersHtml, ...handlersJs]).map((s) => ({ text: s, hash: sha(s) })),
  directives: {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'data:', 'blob:'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'frame-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  },
};
const csp = Object.entries(result.directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
result.csp = csp;
const out = opt('--out', '');
if (out) fs.writeFileSync(out, args.includes('--json') ? JSON.stringify(result, null, 2) : `${csp}\n`);
console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : csp);
