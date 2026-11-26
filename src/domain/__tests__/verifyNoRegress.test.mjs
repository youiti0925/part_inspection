// ⓪ 本番の変更を消さない見張り(scripts/verify-no-regress.mjs)の試験。
// 純粋な判定 + 本物の git で作った小さなリポジトリでの祖先判定。通信はしない(差し替え)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDirtyTracked, parseStampJson, parseStampHtml, shortShaFromBuild, lastLedgerCommit,
  pendingMergeUnresolved, validReason, parseFlags, decide, runStage0, realDeps,
  ledgerFields, collectBuildStamp,
} from '../../../scripts/verify-no-regress.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('NR01 dirty: 追跡中の変更だけ数える(?? と .claude/ は数えない)', () => {
  const out = [' M src/App.jsx', 'M  src/x.js', '?? tmp.txt', ' M .claude/settings.local.json', 'R  a.md -> b.md', '!! dist/'].join('\n');
  assert.deepEqual(parseDirtyTracked(out), ['src/App.jsx', 'src/x.js', 'b.md']);
  assert.deepEqual(parseDirtyTracked(''), []);
  assert.deepEqual(parseDirtyTracked('?? only-untracked'), []);
});

test('NR02 印の読み取り: version.json(commit/dirty あり・なし)・壊れた物・HTML', () => {
  const full = parseStampJson(JSON.stringify({ build: '20261103-184626-de4d02f', commit: A, dirty: true, builtAt: 'x' }));
  assert.equal(full.commit, A);
  assert.equal(full.dirty, true);
  assert.equal(full.short, A.slice(0, 7));
  const old = parseStampJson('{"build":"20261103-184626-de4d02f","builtAt":"t"}');
  assert.equal(old.commit, '');
  assert.equal(old.short, 'de4d02f');
  assert.equal(old.dirty, false);
  assert.equal(parseStampJson('<!doctype html><html>'), null); // SPA が HTML を返した
  assert.equal(parseStampJson('{"build":""}'), null);
  assert.equal(parseStampJson('{"build":"x","commit":"zzz"}').commit, '');
  const m = parseStampHtml('<head><meta name="app-build" content="20261103-184626-abc1234"></head>');
  assert.equal(m.short, 'abc1234');
  assert.equal(parseStampHtml('<head></head>'), null);
  assert.equal(shortShaFromBuild('20261103-184626'), '');
  assert.equal(shortShaFromBuild('20261103-184626-DE4D02F'), 'de4d02f');
});

test('NR03 台帳: 最後の commit / pendingMerge の未解決', () => {
  const ledger = { builds: [{ at: '1' }, { at: '2', commit: A, branch: 'master' }, { at: '3', commit: B, branch: 'fix', pendingMerge: true }, { at: '4', note: 'x' }] };
  assert.equal(lastLedgerCommit(ledger).commit, B);
  assert.equal(lastLedgerCommit({ builds: [{ at: '1' }] }), null);
  assert.equal(lastLedgerCommit(null), null);
  assert.deepEqual(pendingMergeUnresolved(ledger, () => true), []);
  const un = pendingMergeUnresolved(ledger, (s) => (s === B ? false : true));
  assert.equal(un.length, 1);
  assert.equal(un[0].branch, 'fix');
  assert.equal(pendingMergeUnresolved(ledger, () => null)[0].missingLocally, true);
  assert.deepEqual(pendingMergeUnresolved({ builds: [{ commit: A }] }, () => false), []); // pendingMerge でなければ見ない
});

test('NR04 旗: 理由は20文字以上・2通りの書き方', () => {
  assert.equal(validReason('短い'), false);
  assert.equal(validReason('清水さんが了承した。理由はカメラの直しを後で戻すため。'), true);
  assert.deepEqual(parseFlags(['--allow-regress', 'abc', '--bootstrap-regress-check']), { allowRegress: 'abc', bootstrap: true });
  assert.equal(parseFlags(['--allow-regress=xyz']).allowRegress, 'xyz');
  assert.equal(parseFlags(['--allow-regress']).allowRegress, '');
  assert.equal(parseFlags(['--dry-run']).allowRegress, null);
});

const REASON = '清水さんが了承した(2026-11-03 口頭)ので通す';
const base = { dirtyFiles: [], live: { build: '20261103-184626-abc1234', commit: '', short: 'abc1234', dirty: false, source: 'version.json' }, ledgerLast: null, liveKnown: true, liveIsAncestor: true, pending: [], flags: {} };
const codes = (r) => r.stops.map((s) => s.code);

test('NR05 判定: 祖先なら通る / 祖先でないなら止まる / 理由つき旗で通る', () => {
  assert.equal(decide(base).ok, true);
  const bad = decide({ ...base, liveIsAncestor: false });
  assert.deepEqual(codes(bad), ['NOT_ANCESTOR']);
  const ok = decide({ ...base, liveIsAncestor: false, flags: { allowRegress: REASON } });
  assert.equal(ok.ok, true);
  assert.equal(ok.bypass.reason, REASON);
  const short = decide({ ...base, liveIsAncestor: false, flags: { allowRegress: '短い' } });
  assert.equal(short.ok, false);
  assert.ok(codes(short).includes('REASON_TOO_SHORT'));
});

test('NR06 判定: 作業ツリーの汚れは旗でも通せない', () => {
  const r = decide({ ...base, dirtyFiles: ['src/a.js'], flags: { allowRegress: REASON } });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['DIRTY_TREE']);
});

test('NR07 判定: 本番の commit がこの PC に無い・本番が dirty', () => {
  assert.deepEqual(codes(decide({ ...base, liveKnown: false, liveIsAncestor: null })), ['LIVE_UNKNOWN']);
  const d = decide({ ...base, live: { ...base.live, dirty: true } });
  assert.deepEqual(codes(d), ['LIVE_DIRTY']); // 祖先でも止まる(残っているか証明できない)
  assert.equal(decide({ ...base, live: { ...base.live, dirty: true }, flags: { allowRegress: REASON } }).ok, true);
});

test('NR08 判定: 印が無い→台帳へ / 台帳も無い→止まる / 初回の抜け道には理由が要る', () => {
  const noStamp = { ...base, live: null };
  const fromLedger = decide({ ...noStamp, ledgerLast: { commit: A } });
  assert.equal(fromLedger.ok, true);
  assert.equal(fromLedger.basis, 'deploy-ledger.json');
  assert.deepEqual(codes(decide(noStamp)), ['NO_BASIS']);
  assert.deepEqual(codes(decide({ ...noStamp, flags: { bootstrap: true } })), ['BOOTSTRAP_NEEDS_REASON']);
  const boot = decide({ ...noStamp, flags: { bootstrap: true, allowRegress: REASON } });
  assert.equal(boot.ok, true);
  assert.equal(boot.bypass.bootstrap, true);
  // 理由だけでは(bootstrap 無しでは)NO_BASIS は通らない
  assert.deepEqual(codes(decide({ ...noStamp, flags: { allowRegress: REASON } })), ['NO_BASIS']);
});

test('NR09 判定: 前回の枝出荷が master に戻っていなければ止まる', () => {
  const p = [{ commit: A, branch: 'claude/x', at: '11-03', missingLocally: false }];
  assert.deepEqual(codes(decide({ ...base, pending: p })), ['PENDING_MERGE']);
  assert.equal(decide({ ...base, pending: p, flags: { allowRegress: REASON } }).ok, true);
});

test('NR10 台帳の控え: master 以外は pendingMerge', () => {
  assert.equal(ledgerFields({ head: A, branch: 'master' }).pendingMerge, undefined);
  assert.equal(ledgerFields({ head: A, branch: 'claude/x' }).pendingMerge, true);
  assert.equal(ledgerFields({ head: A, branch: 'HEAD' }).pendingMerge, true);
  assert.equal(ledgerFields({ head: A, branch: 'master' }).commit, A);
});

test('NR11 ビルドの印: commit(40桁)・dirty・build の形', () => {
  const calls = { 'rev-parse': A, status: ' M src/a.js\n' };
  const exec = (args) => calls[args[0]];
  const s = collectBuildStamp({ now: new Date(2026, 10, 3, 18, 46, 26), exec });
  assert.equal(s.build, `20261103-184626-${A.slice(0, 7)}`);
  assert.equal(s.commit, A);
  assert.equal(s.dirty, true);
  const clean = collectBuildStamp({ exec: (a) => (a[0] === 'status' ? '?? x\n M .claude/s.json\n' : A) });
  assert.equal(clean.dirty, false);
  const nogit = collectBuildStamp({ now: new Date(2026, 0, 2, 3, 4, 5), exec: () => { throw new Error('no git'); } });
  assert.equal(nogit.build, '20260102-030405');
  assert.equal(nogit.commit, '');
});

// ---- 本物の git での通し(小さなリポジトリ) ----
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const mkRepo = () => {
  const d = mkdtempSync(join(tmpdir(), 'noregress-'));
  git(d, 'init', '-q', '-b', 'master');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'commit.gpgsign', 'false');
  const c = (name) => { writeFileSync(join(d, name), name); git(d, 'add', name); git(d, 'commit', '-q', '-m', name); return git(d, 'rev-parse', 'HEAD'); };
  return { d, c };
};
const fakeDeps = (root, live) => ({
  ...realDeps(root),
  fetchAll: () => true,
  httpGet: async (url) => {
    if (url.includes('version.json') && live) return { status: 200, body: JSON.stringify(live) };
    return { status: 404, body: '' };
  },
});
const quiet = () => {};

test('NR12 本物の git: 祖先なら通る / 枝のまま出していた版が master に無ければ止まる(事故の再現)', async () => {
  const { d, c } = mkRepo();
  try {
    const base1 = c('a.txt');
    git(d, 'checkout', '-q', '-b', 'fuzoku-deploy');
    const fix = c('camera.txt'); // 枝にだけ在る直し(本番に出た)
    git(d, 'checkout', '-q', 'master');
    const m2 = c('other.txt');
    // 本番=fuzoku-deploy の版。master から出そうとする → 止まる
    const lines = [];
    const r = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, { build: '20261025-000000-' + fix.slice(0, 7), commit: fix }), log: (s) => lines.push(s) });
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.result), ['NOT_ANCESTOR']);
    const text = lines.join('\n');
    assert.match(text, /camera\.txt/);
    assert.match(text, /fuzoku-deploy/);
    // 本番=master の古い版(base1)なら通る(短いハッシュだけの印でも)
    const ok = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, { build: '20261025-000000-' + base1.slice(0, 7) }), log: quiet });
    assert.equal(ok.ok, true);
    // 枝を merge した後なら通る
    git(d, 'merge', '-q', '--no-edit', 'fuzoku-deploy');
    const merged = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, { build: 'x-' + fix.slice(0, 7), commit: fix }), log: quiet });
    assert.equal(merged.ok, true);
    void m2;
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('NR13 本物の git: 作業ツリーの汚れ・この PC に無い版・台帳 pendingMerge', async () => {
  const { d, c } = mkRepo();
  try {
    const first = c('a.txt');
    // 汚れ
    writeFileSync(join(d, 'a.txt'), 'changed');
    const dirty = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, { build: 'x-' + first.slice(0, 7), commit: first }), log: quiet });
    assert.deepEqual(codes(dirty.result), ['DIRTY_TREE']);
    git(d, 'checkout', '-q', '--', 'a.txt');
    // 無い版
    const ghost = 'c'.repeat(40);
    const unk = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, { build: 'x-' + ghost.slice(0, 7), commit: ghost }), log: quiet });
    assert.deepEqual(codes(unk.result), ['LIVE_UNKNOWN']);
    // 印なし+台帳なし → 止まる / 台帳に commit → 通る
    const none = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: fakeDeps(d, null), log: quiet });
    assert.deepEqual(codes(none.result), ['NO_BASIS']);
    const withLedger = { ...fakeDeps(d, null), readLedger: () => ({ builds: [{ commit: first, branch: 'master' }] }) };
    assert.equal((await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: withLedger, log: quiet })).ok, true);
    // 台帳 pendingMerge: 枝の commit が HEAD(master)に入っていない
    git(d, 'checkout', '-q', '-b', 'side');
    const sideSha = c('side.txt');
    git(d, 'checkout', '-q', 'master');
    const pend = { ...fakeDeps(d, { build: 'x-' + first.slice(0, 7), commit: first }), readLedger: () => ({ builds: [{ commit: sideSha, branch: 'side', pendingMerge: true, at: 't' }] }) };
    assert.deepEqual(codes((await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: [], deps: pend, log: quiet })).result), ['PENDING_MERGE']);
    // 旗つきなら通り、台帳に残す物が返る
    const byp = await runStage0({ root: d, baseUrl: 'https://x.web.app', argv: ['--allow-regress', REASON], deps: pend, log: quiet });
    assert.equal(byp.ok, true);
    assert.equal(byp.ledgerNote.regressBypass.reason, REASON);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
