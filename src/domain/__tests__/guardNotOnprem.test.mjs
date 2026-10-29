// ============================================================================
// 🛡 社内版を本番へ混ぜない関門(scripts/guard-not-onprem.mjs)の試験 — 4アプリ共通・中身は4つとも同じ(2026-10-30)
// ----------------------------------------------------------------------------
//   ①決め方を直に試す(大文字小文字・解決したパスでの比べ方 = DIST の抜け道を塞いだ事)
//   ②配線: vite.config.js・package.json の prebuild・firebase.json の predeploy・deploy.mjs
//   ③本物の vite / 本物のコマンドで止まる事(出力は一時フォルダ。本物の dist/ には触らない。通信はしない)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONPREM_MODE, ONPREM_OUT_DIR, ONPREM_BUILD_MARKER, ONPREM_MARKERS,
  onpremBuildProblem, deployOnpremProblems, envTextSetsOnprem, isCheckedEnvFile, hostingPublicDirs,
  pathKey, samePath, isInside, isOnpremFlag, onpremGuardPlugin,
} from '../../../scripts/guard-not-onprem.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const BS = String.fromCharCode(92);
const R = join(tmpdir(), 'gno-root');   // 決め方の試験用の置き場(作らない)
const B = (o) => onpremBuildProblem({ command: 'build', root: R, ...o });
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const GUARD = join(ROOT, 'scripts', 'guard-not-onprem.mjs');

test('GN01 いつものビルドに VITE_ONPREM=1 → 止める・mode=onprem なのに無い → 止める・開発サーバは止めない', () => {
  assert.equal(ONPREM_MODE, 'onprem'); assert.equal(ONPREM_OUT_DIR, 'dist-onprem');
  assert.match(B({ mode: 'production', flag: '1' }), /VITE_ONPREM=1 のまま いつものビルド/);
  assert.match(B({ mode: 'staging', flag: ' 1 ' }), /止めます/);
  assert.match(B({ mode: 'onprem', flag: '', outDir: 'dist-onprem' }), /VITE_ONPREM=1 がありません/);
  assert.equal(B({ mode: 'production', flag: '' }), '');
  assert.equal(B({ mode: 'production', flag: '0' }), '');
  assert.equal(B({ mode: 'production', flag: undefined, outDir: 'dist' }), '');
  assert.equal(B({ mode: 'onprem', flag: '1', outDir: 'dist-onprem' }), '');
  assert.equal(B({ mode: 'onprem', flag: '1', outDir: join(R, 'dist-onprem') }), '');
  assert.equal(onpremBuildProblem({ command: 'serve', mode: 'development', flag: '1' }), '');
});

test('GN02 🚨 抜け道: 社内版の出力先を DIST・Dist・.\\DIST\\・絶対パスの大文字・dist の中/外側にしても止める', () => {
  const bad = [
    'dist', 'DIST', 'Dist', `DIST${BS}`, `.${BS}DIST${BS}`, './Dist/', 'x/../DIST', join(R, 'DIST'),
    join(R, 'dist').toUpperCase(), join(R, 'dist', 'sub'), join(R, 'DIST', 'Sub'), '.', R, undefined,
    ['C:', 'other', 'DiSt'].join(BS), '/other/place/DIST',
  ];
  for (const outDir of bad) {
    assert.match(B({ mode: 'onprem', flag: '1', outDir }), /本番の出力先/, `出力先 ${outDir} は止めるはず`);
  }
  // firebase.json の public が dist 以外でも、その場所(大文字小文字問わず)へは出さない
  assert.match(B({ mode: 'onprem', flag: '1', outDir: 'PUBLIC-OUT', prodDirs: ['public-out'] }), /本番の出力先/);
  assert.equal(B({ mode: 'onprem', flag: '1', outDir: 'dist-onprem', prodDirs: ['public-out'] }), '');
  assert.equal(B({ mode: 'onprem', flag: '1', outDir: 'DIST-ONPREM' }), '', '社内版の置き場は大文字でも同じ所');
  // 逆向き: いつものビルドの出力先が dist-onprem(大文字小文字問わず)→ 止める
  for (const outDir of ['dist-onprem', 'DIST-ONPREM', `.${BS}Dist-OnPrem${BS}`, join(R, 'DIST-onprem')]) {
    assert.match(B({ mode: 'production', flag: '', outDir }), /npm run build:onprem/, `出力先 ${outDir}`);
  }
});

test('GN03 パスの比べ方: 解決して・区切りを揃え・大文字小文字を区別しない', () => {
  assert.equal(samePath('DIST', join(R, 'dist'), R), true);
  assert.equal(samePath(`.${BS}dist${BS}`, 'dist/', R), true);
  assert.equal(samePath('a/../dist', 'dist', R), true);
  assert.equal(samePath('dist-onprem', 'dist', R), false);
  assert.equal(isInside(join(R, 'DIST', 'a'), 'dist', R), true);
  assert.equal(isInside('dist-onprem', 'dist', R), false, 'dist-onprem は dist の中ではない');
  assert.equal(isInside('dist', 'dist', R), false);
  assert.equal(pathKey(['C:', 'A', 'Dist', ''].join(BS)), 'c:/a/dist');
});

test('GN04 .env 系: .env で始まる全部を見る(例外は .env.onprem 系と見本だけ)・VITE_ONPREM=1 の行だけ数える', () => {
  for (const n of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.staging.local', '.ENV.LOCAL']) {
    assert.equal(isCheckedEnvFile(n), true, n);
  }
  for (const n of ['.env.onprem', '.env.onprem.local', '.env.example', '.env.sample', '.env.local.template', '.envrc', 'x.env', '.environment']) {
    assert.equal(isCheckedEnvFile(n), false, n);
  }
  assert.equal(envTextSetsOnprem('VITE_ONPREM=1'), true);
  assert.equal(envTextSetsOnprem('A=1\r\nVITE_ONPREM = "1" # 社内\r\n'), true);
  assert.equal(envTextSetsOnprem("export VITE_ONPREM='1'"), true);
  assert.equal(envTextSetsOnprem('# VITE_ONPREM=1'), false);
  assert.equal(envTextSetsOnprem('VITE_ONPREM=0'), false);
  assert.equal(envTextSetsOnprem('VITE_ONPREM_AI_PROXY_URL=1'), false);
  assert.equal(envTextSetsOnprem(null), false);
  assert.equal(isOnpremFlag('1'), true); assert.equal(isOnpremFlag(undefined), false);
});

test('GN05 出す前の確かめ: 環境変数・.env 系・本番の出力先の印のどれでも止める', () => {
  const files = new Map();
  const k = (p) => p.replace(/\\/g, '/');
  const io = {
    listDir: () => [...files.keys()].filter((p) => p.startsWith(`${k(R)}/`) && !p.slice(k(R).length + 1).includes('/')).map((p) => p.slice(k(R).length + 1)),
    readFile: (p) => files.get(k(p)) ?? null,
    exists: (p) => files.has(k(p)),
  };
  const base = { root: R, env: {}, ...io };
  assert.deepEqual(deployOnpremProblems(base), []);
  assert.equal(deployOnpremProblems({ ...base, env: { VITE_ONPREM: '1' } }).length, 1);
  files.set(`${k(R)}/.env.development.local`, 'VITE_PB_URL=http://x\nVITE_ONPREM=1\n');
  assert.match(deployOnpremProblems(base).join(), /\.env\.development\.local/);
  files.clear();
  files.set(`${k(R)}/.env.onprem`, 'VITE_ONPREM=1');
  files.set(`${k(R)}/.env.example`, 'VITE_ONPREM=1');
  assert.deepEqual(deployOnpremProblems(base), [], '.env.onprem と見本は数えない');
  files.clear();
  for (const m of ONPREM_MARKERS) files.set(`${k(R)}/dist/${m}`, 'x');
  assert.equal(deployOnpremProblems(base).length, ONPREM_MARKERS.length);
  assert.deepEqual(deployOnpremProblems({ ...base, checkDist: false }), [], '--no-dist は出力先を見ない');
  files.clear();
  files.set(`${k(R)}/www/${ONPREM_BUILD_MARKER}`, 'x');
  assert.equal(deployOnpremProblems({ ...base, prodDirs: ['www'] }).length, 1, 'hosting.public が dist 以外でも見る');
});

test('GN06 firebase.json の hosting.public を読む(無い・壊れている時は dist)', () => {
  assert.deepEqual(hostingPublicDirs('{"hosting":{"public":"dist"}}'), ['dist']);
  assert.deepEqual(hostingPublicDirs('{"hosting":[{"public":"a"},{"public":"b"}]}'), ['a', 'b']);
  assert.deepEqual(hostingPublicDirs('{'), ['dist']);
  assert.deepEqual(hostingPublicDirs(''), ['dist']);
  assert.deepEqual(hostingPublicDirs(read('firebase.json')), ['dist'], 'このアプリの本番の出力先');
});

test('GN07 vite の部品: 止める時は投げる・社内版の時だけ印を出す・いつものビルドでは何も足さない', () => {
  const run = (c) => {
    const p = onpremGuardPlugin(); const emitted = [];
    p.configResolved({ root: R, build: { outDir: 'dist' }, env: {}, command: 'build', mode: 'production', ...c });
    p.generateBundle.call({ emitFile: (f) => emitted.push(f.fileName) });
    return emitted;
  };
  assert.equal(onpremGuardPlugin().apply, 'build');
  assert.deepEqual(run({}), []);
  assert.deepEqual(run({ mode: 'onprem', env: { VITE_ONPREM: '1' }, build: { outDir: 'dist-onprem' } }), [ONPREM_BUILD_MARKER]);
  assert.throws(() => run({ env: { VITE_ONPREM: '1' } }), /guard-not-onprem/);
  assert.throws(() => run({ mode: 'onprem', env: { VITE_ONPREM: '1' }, build: { outDir: 'DIST' } }), /本番の出力先/);
});

test('GN08 配線: 4アプリ同じ形(vite.config.js・package.json・firebase.json・deploy.mjs)・古い関門の名前が残っていない', () => {
  const vite = read('vite.config.js');
  assert.match(vite, /import \{ onpremGuardPlugin \} from '\.\/scripts\/guard-not-onprem\.mjs'/);
  assert.match(vite, /plugins: \[\s*onpremGuardPlugin\(\),\s*react\(\)/, 'plugins の先頭(社内版でも本番でも同じ1つの並び)');
  assert.doesNotMatch(vite, /onprem-guard\.mjs|checkOnpremBuild|onpremOutDirProblem/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.equal(pkg.scripts.prebuild, 'node scripts/guard-not-onprem.mjs --no-dist');
  assert.equal(pkg.scripts['guard:not-onprem'], 'node scripts/guard-not-onprem.mjs');
  const bo = pkg.scripts['build:onprem'];
  const boText = /build-onprem\.mjs/.test(bo) ? read('scripts/build-onprem.mjs') : bo;
  assert.match(boText, /--mode', 'onprem'|--mode onprem|mode: 'onprem'/, 'build:onprem は mode=onprem');
  const fb = JSON.parse(read('firebase.json'));
  for (const h of [fb.hosting].flat()) {
    const pre = h.predeploy || [];
    const b = pre.indexOf('npm run build');
    assert.ok(b >= 0 && pre[b + 1] === 'node scripts/guard-not-onprem.mjs', 'predeploy: build の直後に出力先の中身まで確かめる');
  }
  const dep = read('scripts/deploy.mjs');
  const i0 = dep.indexOf("['scripts/guard-not-onprem.mjs', '--no-dist']");
  const iMain = dep.indexOf('const main = async');
  const i1 = dep.indexOf("run('① 📋 約束の見張り");
  assert.ok(iMain > 0 && i0 > iMain && i0 < i1, 'deploy.mjs は最初に切替を確かめる');
  assert.equal(dep.split("run('③-1 🏗 ビルド").length - 1, 2);
  assert.equal(dep.split("['scripts/guard-not-onprem.mjs']);").length - 1, 2, '手でビルドする2つの道でも出力先を確かめる');
  assert.equal(existsSync(join(ROOT, 'scripts', 'onprem-guard.mjs')), false, '古い関門のファイルは消した(1つに揃えた)');
  assert.doesNotMatch(dep + read('firebase.json'), /onprem-guard\.mjs/);
});

// --- 本物で確かめる(出力は一時フォルダ・本番へは何も繋がない) --------------------------------
const cleanEnv = (extra = {}) => {
  const env = { ...process.env };
  delete env.VITE_ONPREM; delete env.DEPLOY_SAFETY_ROOT;
  return { ...env, ...extra };
};
const viteBuild = (args, extra) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gno-vite-'));
  try {
    const r = spawnSync(process.execPath, [VITE, 'build', ...args(tmp), '--emptyOutDir'], { cwd: ROOT, env: cleanEnv(extra), encoding: 'utf8', timeout: 110000 });
    const written = readdirSync(tmp, { recursive: true }).length;
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, written };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
};

test('GN09 🚨 本物の vite: VITE_ONPREM=1 のいつものビルド・社内版を DIST へ・mode=onprem で切替なし → 失敗して何も書かない', { skip: !existsSync(VITE) && 'vite が無い', timeout: 300000 }, () => {
  const a = viteBuild((t) => ['--outDir', join(t, 'o')], { VITE_ONPREM: '1' });
  assert.notEqual(a.status, 0, a.out.slice(-600)); assert.match(a.out, /guard-not-onprem/); assert.equal(a.written, 0);
  const b = viteBuild((t) => ['--mode', 'onprem', '--outDir', join(t, 'DIST')], { VITE_ONPREM: '1' });
  assert.notEqual(b.status, 0, b.out.slice(-600)); assert.match(b.out, /本番の出力先/); assert.equal(b.written, 0);
  const c = viteBuild((t) => ['--mode', 'onprem', '--outDir', join(t, 'o')], {});
  if (existsSync(join(ROOT, '.env.onprem')) && envTextSetsOnprem(readFileSync(join(ROOT, '.env.onprem'), 'utf8'))) {
    // .env.onprem に VITE_ONPREM=1 を置くアプリ(部品)は mode=onprem で切替が立つので、ここは確かめられない
  } else {
    assert.notEqual(c.status, 0, c.out.slice(-600)); assert.match(c.out, /VITE_ONPREM=1 がありません/); assert.equal(c.written, 0);
  }
});

test('GN10 🚨 本物のコマンド: .env.development / 環境変数 / 本番の出力先の印 → 終了コード1・何も無ければ 0', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gno-cli-'));
  const run = (args, extra = {}) => spawnSync(process.execPath, [GUARD, ...args], { cwd: tmp, env: cleanEnv({ DEPLOY_SAFETY_ROOT: tmp, ...extra }), encoding: 'utf8', timeout: 60000 });
  try {
    writeFileSync(join(tmp, 'firebase.json'), JSON.stringify({ hosting: { public: 'dist' } }));
    writeFileSync(join(tmp, '.env.onprem'), 'VITE_ONPREM=1\n');
    assert.equal(run([]).status, 0, '何も無い(.env.onprem は数えない)');
    assert.equal(run(['--no-dist'], { VITE_ONPREM: '1' }).status, 1);
    writeFileSync(join(tmp, '.env.development'), 'VITE_ONPREM=1\n');
    const r = run(['--no-dist']);
    assert.equal(r.status, 1); assert.match(r.stderr, /\.env\.development/);
    rmSync(join(tmp, '.env.development'));
    mkdirSync(join(tmp, 'dist'));
    writeFileSync(join(tmp, 'dist', ONPREM_BUILD_MARKER), '{}');
    assert.equal(run(['--no-dist']).status, 0, '--no-dist は出力先を見ない');
    assert.equal(run([]).status, 1, '本番の出力先に社内版の印');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('GN11 🚨 本物の deploy.mjs: VITE_ONPREM=1 → 最初の関門で終了コード1・見張りもビルドも走らない(--dry-run)', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'deploy.mjs'), '--dry-run'], { cwd: ROOT, env: cleanEnv({ VITE_ONPREM: '1' }), encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, out.slice(-600));
  assert.match(out, /guard-not-onprem/);
  assert.doesNotMatch(out, /npm run check|③-1/, '見張りも build も走っていない');
});
