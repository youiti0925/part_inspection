#!/usr/bin/env node
// ============================================================================
// 🚪 出す口は、ここ1つだけ — npm run deploy
//
// ⚠⚠ なぜ作ったか（2026-08-17 の事故）:
//   出し方がバラバラだった（deploy.bat / 手打ちの firebase deploy / npm script）。
//   どの道にも「古い版を開いている人はどうなるか」を見る所が無かった。
//   5日で19回出して、そのたびに古い部品を踏み潰し、
//   8/12 から開きっぱなしだった端末が 8/17 に起動しなくなった。
//   その端末に貯まっていた 8/12 の作業は、送られないまま消えた。
//
//   → **出す道を1本にして、その道の上に見張りを置く。**
//     人が思い出す必要が無い形にする（忘れるから）。
//
// 通る順番:
//   ① 📋 約束の見張り        npm run check
//   ② 🛡 出す前の見張り      verify-deploy-safety --pre
//   ③ 🚀 出す               firebase deploy
//        └ firebase.json の predeploy が
//          「npm run build」→「keep-old-assets（古い部品を持ち越す）」を必ず通す。
//          predeploy が無い設定なら、ここで自分で走らせる。
//   ④ 🔬 出した後の照合      verify-deploy-safety --after（**本番で実測**）
//   ⑤ 📒 台帳に控える        scripts/deploy-ledger.json
//
// 使い方:
//   npm run deploy              … 上を全部通して出す
//   npm run deploy:dry          … ③を飛ばす（出さない。手前まで全部確かめる）
//   node scripts/deploy.mjs --bootstrap-ledger
//                               … いま本番に在る玉を実測して台帳を作る（初回だけ）
//   node scripts/deploy.mjs --skip-check
//                               … ①を飛ばす。⚠**理由を清水さんに言ってから**使う事
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appConfig, ask, assetsInHtml, distAssets, readLedger, writeLedger, ledgerAlive,
} from './verify-deploy-safety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DEPLOY_SAFETY_ROOT || join(HERE, '..');
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const DRY = has('--dry-run') || has('--dry');
const line = '═'.repeat(78);

const readJson = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

const run = (label, cmd, args, hint = []) => {
  console.log('');
  console.log(line);
  console.log(`▶ ${label}`);
  console.log(`  ${cmd} ${args.join(' ')}`);
  console.log(line);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.log('');
    console.log(`❌ ${label} で止まりました（終了コード ${r.status}）。`);
    console.log('   ここで止めるのが正しい。直してから、もう一度 npm run deploy。');
    for (const h of hint) console.log(`   ${h}`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// 📒 初回だけ: いま本番に在る玉を実測して台帳を作る
//   ⚠ 中身は取らない（HEAD だけ）。3MB の玉が在るので、確かめるだけで通信を食わない為。
// ---------------------------------------------------------------------------
const bootstrapLedger = async () => {
  const cfgs = appConfig();
  const c = cfgs[0];
  if (!c?.baseUrl) { console.log('❌ 出し先が読めない（firebase.json / .firebaserc）'); process.exit(1); }

  const candidates = new Set(distAssets(c.publicDir)?.filter((a) => a.startsWith('assets/')) || []);
  const idx = await ask(`${c.baseUrl}/index.html`, { body: true });
  if (idx.status === 200) assetsInHtml(idx.body).forEach((a) => candidates.add(a));
  else console.log(`⚠本番の index.html が読めなかった（${idx.status || idx.error}）。手元の dist だけで作ります。`);

  const alive = [];
  for (const a of candidates) {
    const r = await ask(`${c.baseUrl}/${a}`);
    const okType = a.endsWith('.js') ? /javascript|ecmascript/i.test(r.contentType)
      : a.endsWith('.css') ? /text\/css/i.test(r.contentType) : r.status === 200;
    console.log(`  ${String(r.status).padEnd(4)} ${(r.contentType || r.error).padEnd(30)} /${a}`);
    if (r.status === 200 && okType) alive.push(a);
  }

  const l = readLedger();
  l.app = l.app || (readJson('package.json')?.name || '');
  l.site = c.site;
  l.builds = l.builds || [];
  l.builds.push({
    at: new Date().toISOString().slice(0, 10),
    by: 'bootstrap（本番に HEAD を投げて、1つずつ実測して控えた）',
    assets: alive,
  });
  writeLedger(l);
  console.log('');
  console.log(`📒 ${alive.length}個を台帳に控えました: scripts/deploy-ledger.json`);
};

// ---------------------------------------------------------------------------
const main = async () => {
  if (has('--bootstrap-ledger')) { await bootstrapLedger(); return; }

  const pkg = readJson('package.json') || {};
  const scripts = pkg.scripts || {};
  const fb = readJson('firebase.json') || {};
  const hostings = Array.isArray(fb.hosting) ? fb.hosting : fb.hosting ? [fb.hosting] : [];
  const cfgs = appConfig();

  console.log(line);
  console.log(`🚪 出す口（1本）— ${cfgs.map((c) => c.site).join(', ')}`);
  console.log(`   ${DRY ? '⚠ 出しません（--dry-run）。手前まで全部確かめます。' : '通したら本番に出ます。'}`);
  console.log(line);

  // ① 約束の見張り
  if (has('--skip-check')) {
    console.log('⚠ ①約束の見張りを飛ばしています（--skip-check）。理由を清水さんに言う事。');
  } else if (scripts.check) {
    run('① 📋 約束の見張り（npm run check）', 'npm', ['run', 'check'], [
      '',
      '⚠ 2026-08-17 に測った時点では、`npx eslint src` が **前から在るエラー**で赤でした',
      '  （最終検査 394件 / 製品検査 502件。どちらも今日いじっていないファイルを含む）。',
      '  つまり ここで赤になっても「今日の作業が悪い」とは限りません。**中身を見て下さい。**',
      '  約束の表だけを見たいなら: npm run promises',
      '  ⚠ どうしても今 出すなら --skip-check を付けられますが、',
      '    **勝手に飛ばさず、清水さんに言ってから**にする事（P29: やらない判断は清水さんの物）。',
    ]);
  } else {
    // 🚨 黙って飛ばさない。**無い物を在るふりにしない。**
    //   部品検査・司令塔③ には約束の見張り(verify-promises)がまだ無い。
    //   `eslint src` を門番にすると、前から在るエラー(部品検査 209件 / ③ 31件)で
    //   **永久に赤**になり、そのうち誰も見なくなる（約束.md に同じ失敗が書いてある）。
    //   → **ここは門番にしない。ただし黙らない。** どうするかは清水さんが決める事。
    console.log('');
    console.log('⚠⚠ このアプリには ①約束の見張り(npm run check)が有りません。');
    console.log('    そのまま進みますが、**通っていない**という事です。');
    console.log('    いま何件出るか: npx eslint src');
    console.log('    ⚠ 前から在るエラーを門番にすると全部のデプロイが止まるので、');
    console.log('      「直してから門番にする」かどうかは清水さんに決めてもらう事。');
  }

  // ② 出す前の見張り
  // 🚨 2026-08-30 直した: 見張りの D7 は「どうしても今 出すなら --frequency-ok を付ける」と
  //   案内するのに、この呼び出しがそのフラグを子へ渡していなかった。付けても効かない＝
  //   **案内が嘘**で、出したい人は結局この門ごと飛ばす道(--skip-check の乱用)へ行く。
  //   見張りを弱めるのではなく、書いてあるとおりに効く様にする。
  const passThru = has('--frequency-ok') ? ['--frequency-ok'] : [];
  run('② 🛡 出す前の見張り', 'node', ['scripts/verify-deploy-safety.mjs', '--pre', ...passThru]);

  // ③ 出す（predeploy が build と keep-old-assets を通す）
  const hasPredeploy = hostings.some((h) => Array.isArray(h.predeploy) ? h.predeploy.length : !!h.predeploy);
  if (!hasPredeploy) {
    console.log('');
    console.log('⚠ firebase.json に predeploy が無い。ここで自分で ビルド と 持ち越し を走らせます。');
    run('③-1 🏗 ビルド', 'npm', ['run', 'build']);
    if (existsSync(join(ROOT, 'scripts/keep-old-assets.mjs'))) {
      run('③-2 🧳 古い部品の持ち越し', 'node', ['scripts/keep-old-assets.mjs']);
    } else {
      console.log('❌ scripts/keep-old-assets.mjs が無い。古い部品を持ち越せない＝出すと消える。');
      process.exit(1);
    }
    run('③-3 🛡 出す直前の確かめ（dist と突き合わせ）', 'node', ['scripts/verify-deploy-safety.mjs', '--post']);
  } else if (DRY) {
    // 出さない時は predeploy が動かないので、同じ事を手で通して中身を見せる
    run('③-1 🏗 ビルド（--dry-run なので手で）', 'npm', ['run', 'build']);
    run('③-2 🧳 古い部品の持ち越し', 'node', ['scripts/keep-old-assets.mjs']);
    run('③-3 🛡 出す直前の確かめ（dist と突き合わせ）', 'node', ['scripts/verify-deploy-safety.mjs', '--post']);
  }

  if (DRY) {
    console.log('');
    console.log(line);
    console.log('⚪ --dry-run なので、ここで止めます（本番には出していません）。');
    console.log(line);
    return;
  }

  const targets = hostings.map((h) => h.target).filter(Boolean);
  const only = targets.length ? targets.map((t) => `hosting:${t}`).join(',') : 'hosting';
  run('③ 🚀 出す', 'npx', ['firebase', 'deploy', '--only', only]);

  // ⑤ 台帳に控える（④の照合が台帳を見るので、先に控える）
  const l = readLedger();
  l.app = l.app || pkg.name || '';
  l.site = cfgs[0]?.site || '';
  l.builds = l.builds || [];
  l.builds.push({
    at: new Date().toISOString(),
    by: 'npm run deploy',
    assets: (distAssets(cfgs[0]?.publicDir || 'dist') || []).filter((a) => a.startsWith('assets/')),
  });
  writeLedger(l);
  console.log('');
  console.log(`📒 台帳に控えました（生きている部品 ${ledgerAlive().length}個）`);

  // ④ 出した後の照合（本番で実測）
  run('④ 🔬 出した後の照合（本番で実測）', 'node', ['scripts/verify-deploy-safety.mjs', '--after', ...passThru]);

  console.log('');
  console.log(line);
  console.log('✅ 出しました。古い版を開いたままの端末も、自分の部品を取りに来れます。');
  console.log('   ⚠ 次は GitHub へ push する（P20: デプロイ → 本番の玉を照合 → push まで）。');
  console.log(line);
};

main().catch((e) => { console.error('⚠ 出す口で落ちた:', e); process.exit(1); });
