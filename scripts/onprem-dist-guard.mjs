#!/usr/bin/env node
// ============================================================================
// 🔒 社内版の出力(dist-onprem)に合言葉・鍵が残っていないかの関門(2026-10-31・4アプリ共通・同じ中身)
// ----------------------------------------------------------------------------
//   node scripts/onprem-dist-guard.mjs [出力先(既定 dist-onprem)]
//   見つけたら一覧を出して終了コード 1(npm run build:onprem を失敗で終わらせる)。
//
// なぜ: 前に ③ の dist-onprem に、古い共有の合言葉(email / password)入りの onprem-config.json が残っていた
//   (build-onprem.mjs が「置いてあった設定を消さずに戻す」ため、作り直しても消えなかった)。
//   入口(https-front)はこの置き場の設定を読まない様にしたが、出力そのものにも残さない。
// 止める物:
//   ・device-login.json(端末ごとの合言葉)… どこにあっても(名前の大文字小文字を問わない)
//   ・*.key / *.pem(鍵・証明書)
//   ・onprem-config*.json / pb-config*.json の中に、合言葉に当たるキー(email・password・token・secret など・入れ子も)
//     ※ 見本(onprem-config.sample.json など)の「説明の文」に email と書くのは良い(キーだけを見る)
//   ・onprem-config.json / pb-config.json が JSON として読めない(中を確かめられない)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_KEY = /^(email|identity|username)$|pass(word)?|secret|token|credential|api[-_]?key|private/i;
const CONFIG_NAME = /^(onprem-config|pb-config)[^/\\]*\.json$/i;

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

/** 出力先を調べ、問題の一覧を返す(無ければ [])。 */
export const checkOnpremDist = (dir) => {
  const problems = [];
  if (!fs.existsSync(dir)) return problems;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (e.isDirectory()) { walk(p); continue; }
      const low = e.name.toLowerCase();
      if (low === 'device-login.json') { problems.push(`${rel}: 端末の合言葉のファイル(device-login.json)は出力に置かない`); continue; }
      if (/\.(key|pem)$/.test(low)) { problems.push(`${rel}: 鍵・証明書(*.key / *.pem)は出力に置かない`); continue; }
      if (CONFIG_NAME.test(e.name)) {
        let j;
        try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (err) {
          problems.push(`${rel}: JSON として読めない(中を確かめられない): ${err.message}`);
          continue;
        }
        const keys = credentialKeys(j);
        if (keys.length) problems.push(`${rel}: 合言葉に当たるキーがある(${keys.join(', ')})。email / password は書かない(端末ごとのアカウントはログインの画面で入れる)`);
      }
    }
  };
  walk(dir);
  return problems;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.resolve(root, process.argv[2] || 'dist-onprem');
  if (!fs.existsSync(dir)) { console.error(`❌ [onprem-dist-guard] 出力先がありません: ${dir}`); process.exit(1); }
  const problems = checkOnpremDist(dir);
  if (problems.length) {
    console.error(`\n❌ [onprem-dist-guard] 社内版の出力(${path.relative(root, dir) || dir})に、合言葉・鍵が残っています。消してから作り直してください:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`🔒 [onprem-dist-guard] ${path.relative(root, dir) || dir}: 合言葉・鍵(device-login.json・*.key・*.pem・設定の email/password)は 0 件`);
}
