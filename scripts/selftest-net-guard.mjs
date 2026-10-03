#!/usr/bin/env node
// =============================================================================
// 🧪🚫 外への通信の見張り(net-guard.mjs)の自己試験 — わざと外へ繋いで、止まる事・外したら赤になる事を見る
// -----------------------------------------------------------------------------
// A02: 子の中で更に子(孫)を起こし、孫から 192.0.2.1:443 / 8.8.8.8:443 / https / fetch / dns / UDP /
//      worker へ繋ごうとして、**通信する前に** 例外(ERR_NET_GUARD_BLOCKED)で止まる事。
//      孫の起こし方は4通り: env をそのまま継ぐ / env から NODE_OPTIONS を落とした spawnSync / 同じく fork / 同じく util.promisify(execFile)。
// 握り潰し: 止められた例外を try/catch で捨てて exit 0 しても、見張りが exit 3 に変える事。
// 外したら赤: 見張りの写しを1か所ずつ壊して(口を1つ外す)、その口の探りが必ず変わる事。
//            「0件だった」だけを証明にしない(壊して赤を見る)。
// ⚠ 本物の Firebase には繋がない。宛先は 192.0.2.1(TEST-NET-1・経路なし)と *.invalid(必ず無い名前)だけ。
//   8.8.8.8 は同じ process で 192.0.2.1 が止まった時だけ試す(壊した写しでは試さない)。
// ⚠ 4アプリ共通の同じファイル。
// =============================================================================

import './net-guard.mjs'; // この試験そのものも見張りの中で走らせる(最初の import)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(__dirname, 'net-guard.mjs');
const PROBE = path.join(__dirname, 'net-guard-probe.mjs');

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) fails++;
};

function withoutGuard(nodeOptions) {
  return String(nodeOptions || '').split(/\s+/).filter((t) => t && !/net-guard\.mjs/.test(t)).join(' ');
}

/** 指定した見張り(本物 or 壊した写し)を NODE_OPTIONS で渡して、探り役を走らせる */
function runProbe(guardFile, mode) {
  const flag = `--import=${pathToFileURL(guardFile).href}`;
  const env = { ...process.env, NODE_OPTIONS: `${withoutGuard(process.env.NODE_OPTIONS)} ${flag}`.trim() };
  const r = spawnSync(process.execPath, [PROBE, mode], { env, encoding: 'utf8', timeout: 60000 });
  const line = String(r.stdout || '').split(/\r?\n/).reverse().find((l) => l.startsWith('NETGUARD_PROBE '));
  let data = null;
  try { data = line ? JSON.parse(line.slice('NETGUARD_PROBE '.length)) : null; } catch { data = null; }
  return { exit: r.status, data, stderr: String(r.stderr || '') };
}

// 本物の見張りで、各口がどの段で止まるべきか
const EXPECT = {
  guard: 'yes',
  net: 'blocked:net.Socket.connect',
  net8888: 'blocked:net.Socket.connect',
  tls: 'blocked:tls.connect',
  http2: 'blocked:http2.connect',
  https: 'blocked:tls.connect',
  fetch: 'blocked:fetch',
  dns: 'blocked:dns.lookup',
  udp: 'blocked:dgram.send',
  worker: 'blocked:net.Socket.connect',
  local: 'ok',
  shapeLookup: 'address,family',
  shapeExecFile: 'stderr,stdout',
};
if (typeof globalThis.WebSocket === 'function') EXPECT.ws = 'blocked:WebSocket';

function checkAll(who, r) {
  if (!r) { ok(false, `${who}: 探り役の結果が読めない`); return; }
  const bad = Object.entries(EXPECT).filter(([k, v]) => r[k] !== v).map(([k, v]) => `${k}=${r[k]}(期待 ${v})`);
  ok(bad.length === 0, `${who}: 外への口 ${Object.keys(EXPECT).length - 4}通り 全部 通信前に止まり・手元(localhost)へは繋がり・promisify の形も変わらない${bad.length ? ` … ${bad.join(' / ')}` : ''}`);
}

// -----------------------------------------------------------------------------
console.log('▶ A02 本物の見張り: 子 → 孫(4通り) から外へ繋ぐ');
{
  const r = runProbe(GUARD, 'chain');
  ok(r.exit === 0, `子の終了値 0(期待どおり止められた分は握り潰し扱いにしない) … exit ${r.exit}`);
  checkAll('子', r.data?.self);
  checkAll('孫(env をそのまま継ぐ spawnSync)', r.data?.grand?.inherit);
  checkAll('孫(env から NODE_OPTIONS を落とした spawnSync → 見張りが足し直す)', r.data?.grand?.strippedSpawnSync);
  checkAll('孫(env から NODE_OPTIONS を落とした fork → 見張りが足し直す)', r.data?.grand?.strippedFork);
  checkAll('孫(env から NODE_OPTIONS を落とした util.promisify(execFile) → 形を保ったまま足し直す)', r.data?.grand?.strippedPromisifiedExecFile);
  ok(r.data?.grand?.inherit?.net8888 === 'blocked:net.Socket.connect', `孫から 8.8.8.8:443 … ${r.data?.grand?.inherit?.net8888}`);
}

console.log('\n▶ 握り潰し: 止められた例外を捨てて exit 0 しようとする');
{
  const r = runProbe(GUARD, 'swallow');
  ok(r.exit === 3, `exit 3 に変わる(合格にしない) … exit ${r.exit}`);
}

// -----------------------------------------------------------------------------
// 外したら赤: 写しを1か所ずつ壊す。壊した口の探りが「止まらない/別の段で止まる」に変わらなければ、この試験が節穴。
// -----------------------------------------------------------------------------
console.log('\n▶ 見張りを外す・1か所ずつ壊す(赤になるのを見る)');
const SRC = fs.readFileSync(GUARD, 'utf8');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'net-guard-mut-'));
function mutant(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  let src;
  if (tag === 'none') {
    src = '// 見張りを丸ごと外した写し(何もしない)\nexport {};\n';
  } else {
    const re = new RegExp(`/\\*<M:${tag}>\\*/[\\s\\S]*?/\\*</M:${tag}>\\*/`);
    if (!re.test(SRC)) return null;
    src = SRC.replace(re, `/* M:${tag} を外した */`);
  }
  const f = path.join(dir, 'net-guard.mjs');
  fs.writeFileSync(f, src);
  return f;
}

const MUTATIONS = [
  { tag: 'none', mode: 'all', name: '見張りを丸ごと外す', red: (r) => r.data?.guard === 'no' && r.data?.net === 'open' },
  { tag: 'net', mode: 'all', name: 'net.Socket#connect の口を外す', red: (r) => r.data?.net === 'open' },
  { tag: 'tls', mode: 'all', name: 'tls/http2 の口を外す', red: (r) => r.data?.tls !== EXPECT.tls && r.data?.http2 !== EXPECT.http2 },
  { tag: 'fetch', mode: 'all', name: 'fetch/WebSocket の口を外す', red: (r) => r.data?.fetch !== EXPECT.fetch },
  { tag: 'dns', mode: 'all', name: 'dns の口を外す', red: (r) => r.data?.dns === 'open' },
  { tag: 'udp', mode: 'all', name: 'UDP の口を外す', red: (r) => r.data?.udp !== EXPECT.udp },
  { tag: 'worker', mode: 'all', name: 'worker_threads へ読ませるのを外す', red: (r) => r.data?.worker === 'open' },
  { tag: 'child', mode: 'chain', name: '子へ NODE_OPTIONS を足し直すのを外す', red: (r) => r.data?.grand?.strippedSpawnSync?.net === 'open' && r.data?.grand?.strippedFork?.net === 'open' && r.data?.grand?.strippedPromisifiedExecFile?.net === 'open' && r.data?.grand?.inherit?.net === EXPECT.net },
  { tag: 'exit', mode: 'swallow', name: '握り潰しを exit 3 にするのを外す', red: (r) => r.exit === 0 },
];
try {
  for (const m of MUTATIONS) {
    const f = mutant(m.tag);
    if (!f) { ok(false, `${m.name}: 見張りの中に印 /*<M:${m.tag}>*/ が無い(壊し方が効かない＝この試験が節穴)`); continue; }
    const r = runProbe(f, m.mode);
    const seen = m.red(r);
    ok(seen, seen ? `${m.name} → 探りが変わった＝赤を見た(見抜けた)` : `${m.name} → 探りが変わらない＝この試験が節穴: ${JSON.stringify(r.data)} exit ${r.exit}`);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// 10-03 のすり抜けの形: 字面に firebase も fetch も出さない見張りが、自作の部品を経由して本番を読み、
//   失敗を握り潰して「0件でした」と exit 0 する。見張りの中では赤(exit≠0)・見張りを外すと緑(exit 0)になる事。
// -----------------------------------------------------------------------------
console.log('\n▶ すり抜けの形(自作の部品経由 / 環境変数で行き先を変える / 別の口)を、見張りが赤にするか');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-guard-sneaky-'));
  try {
    const lib = [
      "import https from 'node:https';",
      "import http2 from 'node:http2';",
      '// 字面に firebase も fetch( も出さない「自作の部品」(作り物。宛先は必ず無い名前)',
      "const HOST = process.env.SNEAKY_HOST || 'firestore.googleapis.com.invalid';",
      'export function readLots() {',
      '  return new Promise((resolve) => {',
      "    try { const r = https.get(`https://${HOST}/v1/projects/p/databases/(default)/documents/lots`, () => resolve(1)); r.on('error', () => resolve(0)); }",
      '    catch { resolve(0); }',
      '  });',
      '}',
      'export function readImages() {',
      "  try { const s = http2.connect(`https://${HOST}`); s.on('error', () => {}); s.close(); } catch { /* 握り潰す */ }",
      "  try { globalThis.fetch?.(`https://${HOST}/x`).catch(() => {}); } catch { /* 握り潰す */ }",
      '  return 0;',
      '}',
    ].join('\n');
    const tool = [
      "import { readLots, readImages } from './_lib-sneaky.mjs';",
      'const n = (await readLots()) + readImages();',
      "console.log(`✅ 問題 ${n}件(作り物の見張り)`);",
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '_lib-sneaky.mjs'), lib);
    fs.writeFileSync(path.join(dir, 'verify-sneaky.mjs'), tool);
    const go = (guardFile) => {
      const flag = guardFile ? `--import=${pathToFileURL(guardFile).href}` : '';
      const env = { ...process.env, NODE_OPTIONS: `${withoutGuard(process.env.NODE_OPTIONS)} ${flag}`.trim() };
      const r = spawnSync(process.execPath, [path.join(dir, 'verify-sneaky.mjs')], { env, encoding: 'utf8', timeout: 60000 });
      return { exit: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    };
    const g = go(GUARD);
    ok(g.exit !== 0 && g.out.includes('外への通信を止めました'), `本物の見張りの中 → exit ${g.exit}(赤)・止めた跡 ${g.out.includes('外への通信を止めました') ? '有' : '無'}`);
    const none = path.join(dir, 'noguard', 'net-guard.mjs'); // 見張りを丸ごと外した写し(何もしない)
    fs.mkdirSync(path.dirname(none));
    fs.writeFileSync(none, 'export {};\n');
    const u = go(none);
    ok(u.exit === 0, `見張りを外す → exit ${u.exit}(緑のまま＝見張りが無いとすり抜ける事を確かめた)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// 配線: check-all が最初に見張りを読むか(読まないと、子・孫に掛からない)
// -----------------------------------------------------------------------------
console.log('\n▶ 配線: check-all.mjs が最初の import で見張りを読むか');
{
  const ca = fs.readFileSync(path.join(__dirname, 'check-all.mjs'), 'utf8');
  const firstImport = (ca.match(/^import\s[^\n]*$/m) || [''])[0];
  ok(/^import\s+['"]\.\/net-guard\.mjs['"]/.test(firstImport), `最初の import … ${firstImport || '(無い)'}`);
}

// -----------------------------------------------------------------------------
// 配線: CI の試験・確かめの step(npm test / npm run … / node scripts/… / npx eslint)に見張りが掛かっているか。
//   npm ci(依存の取得)と配備(複数行の run: | の段)には掛けない。
// -----------------------------------------------------------------------------
/** 1行の run: で試験・確かめを走らせているのに、同じ step に NODE_OPTIONS の見張りが無い物 */
function unguardedSteps(text) {
  const lines = String(text).split(/\r?\n/);
  const bad = [];
  lines.forEach((line, i) => {
    const m = /^\s+run:\s*(\S.*)$/.exec(line);
    if (!m || m[1].startsWith('|') || m[1].startsWith('>')) return;
    const cmd = m[1].trim();
    if (!/^(npm (test|run )|node scripts\/|npx eslint)/.test(cmd)) return;
    let guarded = false;
    for (let j = i - 1; j >= 0; j--) {
      if (/^\s+- (name|uses):/.test(lines[j]) || /^\s+-\s*$/.test(lines[j])) {
        // step の頭の行より上は別の step
        if (/NODE_OPTIONS:.*net-guard\.mjs/.test(lines[j])) guarded = true;
        break;
      }
      if (/NODE_OPTIONS:.*net-guard\.mjs/.test(lines[j])) { guarded = true; break; }
    }
    if (!guarded) bad.push(`${i + 1}行: ${cmd}`);
  });
  return bad;
}
console.log('\n▶ 配線: CI(.github/workflows)の試験・確かめの step に見張りが掛かっているか');
{
  const wfDir = path.join(__dirname, '..', '.github', 'workflows');
  const wfs = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  ok(wfs.length > 0, `workflow ${wfs.length}本 … ${wfs.join(', ')}`);
  let guardedCount = 0;
  for (const f of wfs) {
    const t = fs.readFileSync(path.join(wfDir, f), 'utf8');
    const bad = unguardedSteps(t);
    guardedCount += (t.match(/NODE_OPTIONS:.*net-guard\.mjs/g) || []).length;
    ok(bad.length === 0, `${f}: 見張りの無い試験・確かめの step ${bad.length}件${bad.length ? ` … ${bad.join(' / ')}` : ''}`);
    // 壊して赤を見る: 見張りの行を消した写しでは、必ず見つかる事
    const stripped = t.split(/\r?\n/).filter((l) => !/NODE_OPTIONS:.*net-guard\.mjs/.test(l)).join('\n');
    if (t !== stripped) ok(unguardedSteps(stripped).length > 0, `${f}: 見張りの行を消した写し → 見つかった(赤を見た)`);
  }
  ok(guardedCount > 0, `見張りを掛けた step 合計 ${guardedCount}`);
}

// -----------------------------------------------------------------------------
// 配線: 見張りのファイルが git に無視されていないか(無視されると CI の checkout に届かない)。
//   2026-10-03 実測: 最初 `_net-guard.mjs` と名付けたら 4リポとも .gitignore の `_*.mjs` で無視されていた。
// -----------------------------------------------------------------------------
console.log('\n▶ 配線: 見張りのファイルが git に無視されていないか');
{
  const mine = ['net-guard.mjs', 'net-guard-probe.mjs', 'no-prod-in-ci.mjs', 'selftest-net-guard.mjs', 'selftest-no-prod-in-ci.mjs', 'check-all.mjs'];
  const r = spawnSync('git', ['check-ignore', ...mine.map((f) => `scripts/${f}`)], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    console.log(`  ⏭ git で確かめられない(${r.error?.code || `exit ${r.status}`})。CI では見張りのファイルが無ければ node が起動せず赤になる`);
  } else {
    const ignored = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    ok(ignored.length === 0, `git に無視されている見張りのファイル ${ignored.length}件${ignored.length ? ` … ${ignored.join(', ')}` : ''}`);
  }
}

console.log('\n' + (fails ? `❌ 不合格 ${fails}件` : '✅ 外への通信の見張り: 全部 合格'));
process.exit(fails ? 1 : 0);
