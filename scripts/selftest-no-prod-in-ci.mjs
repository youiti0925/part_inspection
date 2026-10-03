#!/usr/bin/env node
// =============================================================================
// 🧪🏭 A01 / A03 — 本番の道具は CI では動かない・エミュレータ前提の道具はエミュレータが無くても本番へ戻らない
// -----------------------------------------------------------------------------
// A01: 本番を読む道具(--prod / --live を受ける物・いつも本番を見る物)を CI の環境(CI=true)で
//      その切り替え付きで呼ぶ → **データを取る前に** 拒否される(exit 2・外へ繋ごうとした跡が0回)。
//      ・道具の最初の import が no-prod-in-ci.mjs か(後ろの import より先に評価される為)
//      ・実際に走らせる(この試験は外への通信の見張りの中で走る＝拒否が壊れていても本番へは届かない)
//      ・CI の印が無くても、見張りの中(check-all の子)なら拒否される
//      ・拒否を外した作り物の道具では赤になる(壊して赤を見る)
// A03: FIRESTORE_EMULATOR_HOST を読むエミュレータ前提の verify-* / check-* を、エミュレータの印を消して走らせる
//      → 本番へ繋ごうとしない(見張りが止めた跡が0回)で終わる。本番へ戻る作り物では赤になる。
// ⚠ ブラウザ(playwright / puppeteer)を使う道具は **走らせない**(ブラウザ本体は node の見張りの外)。字面だけ見る。
// ⚠ 本物の Firebase には繋がない。作り物の宛先は 192.0.2.1(TEST-NET-1)と *.invalid だけ。
// ⚠ 4アプリ共通の同じファイル。
// =============================================================================

import './net-guard.mjs'; // この試験と、ここから起こす道具の全部を見張りの中で走らせる(最初の import)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALWAYS_PROD } from './no-prod-in-ci.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
let warns = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) fails++; };

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const SELF = new Set(['no-prod-in-ci.mjs', 'selftest-no-prod-in-ci.mjs', 'net-guard.mjs', 'net-guard-probe.mjs', 'selftest-net-guard.mjs']);
const files = fs.readdirSync(__dirname).filter((f) => /\.(mjs|js|cjs)$/.test(f) && !SELF.has(f));
const code = new Map(files.map((f) => [f, stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'))]));
const usesBrowser = (f) => /playwright|puppeteer/.test(code.get(f));
const NET_BLOCK = '[net-guard] 外への通信を止めました';
const REFUSE = '[no-prod-in-ci]';

function run(file, args, envPatch, cwd = ROOT) {
  const env = { ...process.env, ...envPatch };
  for (const k of Object.keys(envPatch)) if (envPatch[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [file, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { exit: r.status, signal: r.signal, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const NO_EMU = { FIRESTORE_EMULATOR_HOST: undefined, FIREBASE_AUTH_EMULATOR_HOST: undefined };
const CI_ON = { CI: 'true', GITHUB_ACTIONS: 'true', ...NO_EMU };
const CI_OFF = { CI: undefined, GITHUB_ACTIONS: undefined, ...NO_EMU };

// -----------------------------------------------------------------------------
// A01 本番の道具を見つける(字面で漏れない様に: 切り替えの字 + いつも本番の名前)
// -----------------------------------------------------------------------------
const prodTools = [];
for (const f of files) {
  const c = code.get(f);
  const m = /['"](--prod|--live)['"]/.exec(c);
  if (m) prodTools.push({ file: f, args: [m[1]] });
  else if (Object.prototype.hasOwnProperty.call(ALWAYS_PROD, f)) prodTools.push({ file: f, args: ALWAYS_PROD[f] ? [ALWAYS_PROD[f]] : [] });
}

console.log(`▶ A01 本番の道具 ${prodTools.length}本: ${prodTools.map((t) => `${t.file} ${t.args.join(' ')}`.trim()).join(' / ') || '(無し)'}`);
for (const t of prodTools) {
  const src = fs.readFileSync(path.join(__dirname, t.file), 'utf8');
  const firstImport = (src.match(/^import\s[^\n]*$/m) || [''])[0];
  const hasRefuse = /^import\s+['"]\.\/no-prod-in-ci\.mjs['"]/.test(firstImport);
  if (usesBrowser(t.file)) {
    // ブラウザの道具は CI にも check にも入っていない(入れない)。ブラウザ本体は見張りの外なので **走らせない**。字面だけ見る。
    // 拒否の import が無い時は ⚠ で名指しする(赤にはしない。直すまで毎回この一覧に出る)。
    if (hasRefuse) console.log(`  ✅ ${t.file}: 最初の import が no-prod-in-ci.mjs(ブラウザを使うので走らせない)`);
    else { warns++; console.log(`  ⚠ ${t.file}: ブラウザで本番を開く道具なのに、最初の import が no-prod-in-ci.mjs ではない … 要対応(走らせない)`); }
    continue;
  }
  ok(hasRefuse, `${t.file}: 最初の import が no-prod-in-ci.mjs … ${firstImport.slice(0, 60) || '(import が無い)'}`);
  const a = run(path.join(__dirname, t.file), t.args, CI_ON);
  ok(a.exit === 2 && a.out.includes(REFUSE) && !a.out.includes(NET_BLOCK),
    `${t.file} ${t.args.join(' ')} を CI=true で → exit ${a.exit}・拒否の印 ${a.out.includes(REFUSE) ? '有' : '無'}・外へ繋ごうとした跡 ${a.out.includes(NET_BLOCK) ? '有(データを取りに行った)' : '無'}`);
  const b = run(path.join(__dirname, t.file), t.args, CI_OFF);
  ok(b.exit === 2 && b.out.includes(REFUSE) && !b.out.includes(NET_BLOCK),
    `${t.file} ${t.args.join(' ')} を CI の印なし・見張りの中で → exit ${b.exit}・拒否の印 ${b.out.includes(REFUSE) ? '有' : '無'}`);
}

// -----------------------------------------------------------------------------
// A03 エミュレータ前提の道具(エミュレータの印を消して走らせる)
// -----------------------------------------------------------------------------
const prodSet = new Set(prodTools.map((t) => t.file));
const emuTools = files.filter((f) => /^(verify|check)-.*\.mjs$/.test(f) && !prodSet.has(f) && !usesBrowser(f)
  && /process\.env\.FIRESTORE_EMULATOR_HOST/.test(code.get(f)));
console.log(`\n▶ A03 エミュレータ前提の道具 ${emuTools.length}本(エミュレータの印を消して走らせる): ${emuTools.join(' / ') || '(無し)'}`);
for (const f of emuTools) {
  const fallsBackToLocal = /FIRESTORE_EMULATOR_HOST\s*\|\|\s*['"`](127\.0\.0\.1|localhost)/.test(code.get(f));
  if (fallsBackToLocal) {
    ok(true, `${f}: 印が無い時の行き先は手元(127.0.0.1/localhost)と字面で決まっている → 走らせない(手元のエミュレータを触らない為)`);
    continue;
  }
  const r = run(path.join(__dirname, f), [], CI_ON);
  ok(r.signal === null && r.exit !== null && !r.out.includes(NET_BLOCK),
    `${f}: エミュレータ無しで → exit ${r.exit}${r.signal ? `(${r.signal}・時間切れ)` : ''}・本番へ繋ごうとした跡 ${r.out.includes(NET_BLOCK) ? '有' : '無'}`);
}

// -----------------------------------------------------------------------------
// 壊して赤を見る: 作り物の道具で、拒否を外す・本番へ戻す と この試験の判定が赤になる事
// -----------------------------------------------------------------------------
console.log('\n▶ 壊して赤を見る(作り物の道具で)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-prod-in-ci-'));
try {
  const realMod = fs.readFileSync(path.join(__dirname, 'no-prod-in-ci.mjs'), 'utf8');
  const fake = [
    "import './no-prod-in-ci.mjs';",
    "import net from 'node:net';",
    "if (process.argv.includes('--prod')) { const s = net.connect({ host: '192.0.2.1', port: 443 }); s.on('error', () => {}); s.destroy(); }",
    "console.log('本番を読んだ(作り物)');",
  ].join('\n');
  const mk = (name, mod) => {
    const d = path.join(tmp, name); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'no-prod-in-ci.mjs'), mod);
    fs.writeFileSync(path.join(d, 'fake-prod-tool.mjs'), fake);
    return path.join(d, 'fake-prod-tool.mjs');
  };
  const good = run(mk('good', realMod), ['--prod'], CI_ON, tmp);
  ok(good.exit === 2 && !good.out.includes(NET_BLOCK), `本物の拒否 → exit ${good.exit}・繋ごうとした跡 ${good.out.includes(NET_BLOCK) ? '有' : '無'}`);
  const brokenMod = realMod.replace(/\nrefuseProdInCI\(\);\s*$/, '\n// 拒否を外した写し\n');
  ok(brokenMod !== realMod, '拒否の呼び出し(refuseProdInCI();)を写しから外せた');
  const bad = run(mk('bad', brokenMod), ['--prod'], CI_ON, tmp);
  const seen = !(bad.exit === 2 && !bad.out.includes(NET_BLOCK));
  ok(seen, `拒否を外した写し → ${seen ? `赤を見た(exit ${bad.exit}・見張りが通信を止めた跡 ${bad.out.includes(NET_BLOCK) ? '有' : '無'})` : '赤にならない＝この試験が節穴'}`);

  const emuFake = [
    "import net from 'node:net';",
    "const host = process.env.FIRESTORE_EMULATOR_HOST;",
    "// ↓ エミュレータが無い時に本番へ戻る形(作り物。宛先は必ず無い名前)",
    "const [h, p] = (host || 'firestore.googleapis.com.invalid:443').split(':');",
    "try { const s = net.connect({ host: h, port: Number(p) }); s.on('error', () => {}); s.destroy(); } catch { /* 見張りが止める */ }",
    'process.exit(1);',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, 'verify-fake-emu.mjs'), emuFake);
  const e = run(path.join(tmp, 'verify-fake-emu.mjs'), [], CI_ON, tmp);
  ok(e.out.includes(NET_BLOCK), `エミュレータが無いと本番へ戻る作り物 → ${e.out.includes(NET_BLOCK) ? 'A03 の判定が赤を見た(見張りが止めた跡 有)' : '赤にならない＝この試験が節穴'}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + (fails ? `❌ 不合格 ${fails}件` : `✅ A01/A03: 全部 合格${warns ? `(⚠ 要対応 ${warns}件・上の一覧)` : ''}`));
process.exit(fails ? 1 : 0);
