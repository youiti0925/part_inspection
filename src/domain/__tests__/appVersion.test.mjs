// ============================================================================
// 🆕 「新しい版が出ています」の判定の試験
//
// ⚠ここがズレると起きる事は2つとも重い:
//   ① 出すべき時に出ない → 開きっぱなしの端末が古い部品を掴んだまま(2026-08-17 の事故)
//   ② 出すべきでない時に出る → 現場に「押しても消えない札」が出続けて誰も読まなくなる
// ⚠この試験自体が当てにならない事があるので、末尾で **わざと壊して落ちるか** も見る。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseVersionPayload, compareBuild, shouldCheck, nextSnoozeUntil, canReload,
  decideFromPayload, parseBuildTime, formatBuildTime, buildTimeText, backoffMs,
  CHECK_INTERVAL_MS, SNOOZE_MS, MAX_BACKOFF_STEPS,
} from '../appVersion.js';

const T0 = Date.parse('2026-08-18T09:00:00+09:00');
const base = {
  now: T0, lastCheckAt: 0, notified: false, hidden: false, online: true,
  snoozeUntil: 0, hasBuildId: true,
};

// ---------------------------------------------------------------------------
// V01 版の印を読む
// ---------------------------------------------------------------------------
test('V01 まともな version.json は読める', () => {
  const r = parseVersionPayload('{"build":"20260818-abc123","builtAt":"2026-08-18T00:00:00Z"}');
  assert.equal(r.ok, true);
  assert.equal(r.build, '20260818-abc123');
});

test('V02 🚨 HTML が返ってきたら「分からない」。絶対に版として読まない', () => {
  // firebase.json の rewrites は「無い物に index.html を返す」書き方ができてしまう。
  // ここを取り違えると全端末に永久に知らせが出続ける。
  for (const html of [
    '<!doctype html>\n<html lang="ja"><head></head></html>',
    '<html><body>404</body></html>',
    '  <!DOCTYPE HTML>',
  ]) {
    const r = parseVersionPayload(html);
    assert.equal(r.ok, false, html.slice(0, 20));
    assert.equal(r.reason, 'html');
  }
});

test('V03 Content-Type が text/html なら中身に関わらず弾く', () => {
  const r = parseVersionPayload('{"build":"x1"}', 'text/html; charset=utf-8');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'html');
});

test('V04 空・壊れたJSON・形違いはすべて「分からない」', () => {
  assert.equal(parseVersionPayload('').reason, 'empty');
  assert.equal(parseVersionPayload(null).reason, 'empty');
  assert.equal(parseVersionPayload('   ').reason, 'empty');
  assert.equal(parseVersionPayload('{"build":').reason, 'not-json');
  assert.equal(parseVersionPayload('[1,2]').reason, 'not-object'); // JSON としては読めるが形が違う
  assert.equal(parseVersionPayload('{"nope":1}').reason, 'no-build');
  assert.equal(parseVersionPayload('{"build":123}').reason, 'no-build');
  assert.equal(parseVersionPayload('{"build":""}').reason, 'no-build');
  assert.equal(parseVersionPayload(`{"build":"${'a'.repeat(65)}"}`).reason, 'no-build');
});

// ---------------------------------------------------------------------------
// V10 比べる
// ---------------------------------------------------------------------------
test('V10 違えば知らせる／同じなら知らせない', () => {
  assert.equal(compareBuild('a1', 'a2').newer, true);
  assert.equal(compareBuild('a1', 'a1').newer, false);
  assert.equal(compareBuild('a1', 'a1').reason, 'same');
});

test('V11 巻き戻し(古い版に戻した)も知らせる', () => {
  // 大小は比べない。今の画面が本番と違う事に変わりはないので知らせる。
  assert.equal(compareBuild('20260818-zzz', '20260810-aaa').newer, true);
});

test('V12 🚨 どちらかの印が無い時は黙る', () => {
  assert.equal(compareBuild('', 'a2').newer, false);
  assert.equal(compareBuild('a1', '').newer, false);
  assert.equal(compareBuild(null, 'a2').newer, false);
  assert.equal(compareBuild('a1', undefined).newer, false);
  assert.equal(compareBuild('a1', 'a 2').newer, false); // 空白入り=印として認めない
});

// ---------------------------------------------------------------------------
// V20 いつ取りに行くか
// ---------------------------------------------------------------------------
test('V20 初回は取りに行く', () => {
  assert.equal(shouldCheck(base).check, true);
});

test('V21 🚨 裏に回っている画面では取りに行かない', () => {
  assert.equal(shouldCheck({ ...base, hidden: true }).check, false);
  assert.equal(shouldCheck({ ...base, hidden: true }).reason, 'hidden');
});

test('V22 圏外では取りに行かない', () => {
  assert.equal(shouldCheck({ ...base, online: false }).reason, 'offline');
});

test('V23 間隔より早ければ取りに行かない(既定10分)', () => {
  assert.equal(CHECK_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(shouldCheck({ ...base, lastCheckAt: T0 - 60_000 }).reason, 'too-soon');
  assert.equal(shouldCheck({ ...base, lastCheckAt: T0 - CHECK_INTERVAL_MS - 1 }).check, true);
});

test('V24 もう知らせを出しているなら、それ以上取りに行かない', () => {
  assert.equal(shouldCheck({ ...base, notified: true }).reason, 'already-notified');
});

test('V25 「あとで」の間は黙る／期限を過ぎたら再開する', () => {
  assert.equal(SNOOZE_MS, 30 * 60 * 1000);
  const until = nextSnoozeUntil(T0);
  assert.equal(until, T0 + SNOOZE_MS);
  assert.equal(shouldCheck({ ...base, snoozeUntil: until }).reason, 'snoozed');
  assert.equal(shouldCheck({ ...base, now: until + 1, snoozeUntil: until }).check, true);
});

test('V26 自分の版の印が無ければ何もしない', () => {
  assert.equal(shouldCheck({ ...base, hasBuildId: false }).reason, 'no-build-id');
});

test('V27 端末の時計が巻き戻っても止まったままにならない', () => {
  // 時刻合わせで lastCheckAt が未来になると now-last が負になり、永久に too-soon になりうる。
  const r = shouldCheck({ ...base, lastCheckAt: T0 + 86_400_000 });
  assert.equal(r.check, true);
  assert.equal(r.reason, 'clock-went-back');
});

// ---------------------------------------------------------------------------
// V30 🚨 まだ送れていない保存がある間は読み直させない
// ---------------------------------------------------------------------------
test('V30 3本の合図はどれか1本でも立っていたら止める(OR)', () => {
  assert.equal(canReload({ unsent: 1, fsPending: false, lotsPending: false }).allowed, false);
  assert.equal(canReload({ unsent: 0, fsPending: true, lotsPending: false }).allowed, false);
  assert.equal(canReload({ unsent: 0, fsPending: false, lotsPending: true }).allowed, false);
  assert.equal(canReload({ unsent: 0, fsPending: false, lotsPending: false }).allowed, true);
});

test('V31 検査記録が含まれる時は、そう名指しする', () => {
  const r = canReload({ unsent: 2, fsPending: false, lotsPending: true });
  assert.match(r.label, /検査記録/);
  assert.match(r.label, /2件/);
  const r2 = canReload({ unsent: 0, fsPending: true, lotsPending: false });
  assert.doesNotMatch(r2.label, /検査記録/);
  assert.doesNotMatch(r2.label, /件/);
});

test('V32 保存の状態を持たない画面(?live= 等)は押せる', () => {
  assert.equal(canReload(null).allowed, true);
  assert.equal(canReload(undefined).reason, 'no-save-state');
});

// ---------------------------------------------------------------------------
// V40 入口1本
// ---------------------------------------------------------------------------
test('V40 decideFromPayload が判定を1本にまとめている', () => {
  assert.equal(decideFromPayload('a1', '{"build":"a2"}').notify, true);
  assert.equal(decideFromPayload('a1', '{"build":"a1"}').notify, false);
  assert.equal(decideFromPayload('a1', '<!doctype html>').notify, false);
  assert.equal(decideFromPayload('a1', '<!doctype html>').reason, 'html');
});

// ---------------------------------------------------------------------------
// V50 🕒 いつ配られた版か(清水さん 2026-08-19「いつ更新されたかわからない」)
// ---------------------------------------------------------------------------
test('V50 版の印から「焼いた時刻」を読む', () => {
  const t = parseBuildTime('20260819-234007-0a9586a');
  assert.notEqual(t, 0);
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth() + 1, 8);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 40);
  // git が無い環境の印(時刻だけ)も読める
  assert.notEqual(parseBuildTime('20260819-234007'), 0);
});

test('V51 🚨 読めない印は 0。**推測した時刻を作らない**', () => {
  assert.equal(parseBuildTime(''), 0);
  assert.equal(parseBuildTime(null), 0);
  assert.equal(parseBuildTime('abc'), 0);
  assert.equal(parseBuildTime('2026-08-19'), 0);
  // ⚠Date は 13月・32日を黙って繰り上げる。繰り上がった=読めていない。
  assert.equal(parseBuildTime('20261332-000000'), 0);
  assert.equal(parseBuildTime('20260819-256100'), 0);
});

test('V52 時刻の見せ方(分まで。0 や 読めない値は空文字)', () => {
  assert.equal(formatBuildTime(0), '');
  assert.equal(formatBuildTime(NaN), '');
  assert.equal(formatBuildTime(-1), '');
  assert.equal(formatBuildTime('x'), '');
  assert.equal(formatBuildTime(parseBuildTime('20260819-234007')), '2026/8/19 23:40');
  assert.equal(formatBuildTime(parseBuildTime('20260101-000500')), '2026/1/1 00:05');
});

test('V53 builtAt が読めればそれを使う／無ければ印から割り出す／どちらも駄目なら空', () => {
  // ⚠ 端末の時間帯に関係なく成り立つ形だけを見る(現物の時刻は端末の地方時で出す)。
  assert.match(buildTimeText('20260819-234007-abc', '2026-08-19T14:40:07.268Z'), /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  assert.equal(buildTimeText('20260819-234007-abc', ''), '2026/8/19 23:40');
  assert.equal(buildTimeText('20260819-234007-abc', 'こわれた値'), '2026/8/19 23:40');
  assert.equal(buildTimeText('printed-by-hand', ''), '');
  assert.equal(buildTimeText('', ''), '');
});

test('V54 version.json の builtAt を判定と一緒に運ぶ', () => {
  const p = parseVersionPayload('{"build":"a2","builtAt":"2026-08-19T14:40:07.268Z"}');
  assert.equal(p.ok, true);
  assert.equal(p.builtAt, '2026-08-19T14:40:07.268Z');
  // 古い version.json(builtAt なし)でも版の判定は成立する
  assert.equal(parseVersionPayload('{"build":"a2"}').builtAt, '');
  const d = decideFromPayload('a1', '{"build":"a2","builtAt":"2026-08-19T14:40:07.268Z"}');
  assert.equal(d.notify, true);
  assert.equal(d.builtAt, '2026-08-19T14:40:07.268Z');
  assert.equal(decideFromPayload('a1', '<!doctype html>').builtAt, '');
});

// ---------------------------------------------------------------------------
// V60 🔇 取れない時に騒ぎ続けない
// ---------------------------------------------------------------------------
test('V60 失敗が続くほど間隔を伸ばす／上限で止める', () => {
  assert.equal(backoffMs(1000, 0), 1000);
  assert.equal(backoffMs(1000, 1), 2000);
  assert.equal(backoffMs(1000, 3), 4000);
  assert.equal(backoffMs(1000, MAX_BACKOFF_STEPS), 1000 * (1 + MAX_BACKOFF_STEPS));
  // ⚠上限が無いと、一時的な不通のあと二度と見に行かなくなる
  assert.equal(backoffMs(1000, 9999), 1000 * (1 + MAX_BACKOFF_STEPS));
  assert.equal(backoffMs(1000, -5), 1000);
  assert.equal(backoffMs(0, 0), CHECK_INTERVAL_MS);
  assert.equal(backoffMs('x', 'y'), CHECK_INTERVAL_MS);
});

// ---------------------------------------------------------------------------
// V90 🚨 見張り自身の試験 — わざと壊したら、この試験は本当に落ちるか
// ---------------------------------------------------------------------------
// 「試験が全部通った」は、試験が本当に見ている時にしか意味が無い。
// appVersion.js の本文を1行だけ壊した写しを作り、上と同じ確認をして
// **落ちる事** を確かめる。落ちなければ、その確認は何も見ていない。
// ---------------------------------------------------------------------------
const SRC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'appVersion.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

/** 本文を書き換えた写しを読み込む(ファイルは作らない。data: URL で読む) */
async function loadMutant(find, replace) {
  assert.ok(SRC.includes(find), `壊す対象が本文に無い: ${find}`);
  const code = SRC.replace(find, replace);
  assert.notEqual(code, SRC, '書き換えが効いていない');
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
}

/** fn を走らせて「落ちた」なら true */
const failed = async (fn) => { try { await fn(); return false; } catch { return true; } };

test('V90 HTML を弾く所を壊すと落ちる', async () => {
  const m = await loadMutant(
    "if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<')) {",
    'if (false) {'
  );
  assert.equal(
    await failed(() => assert.equal(m.parseVersionPayload('<!doctype html><html></html>').reason, 'html')),
    true,
    '🚨 HTML を弾く確認が、壊しても落ちなかった = 何も見ていない'
  );
});

test('V91 裏のタブで取りに行かない所を壊すと落ちる', async () => {
  const m = await loadMutant(
    "if (s.hidden) return { check: false, reason: 'hidden' };",
    ''
  );
  assert.equal(
    await failed(() => assert.equal(m.shouldCheck({ ...base, hidden: true }).check, false)),
    true,
    '🚨 裏タブの確認が、壊しても落ちなかった'
  );
});

test('V92 送れていない保存の関所を壊すと落ちる', async () => {
  const m = await loadMutant(
    'const waiting = n > 0 || !!saveStatus.fsPending || !!saveStatus.lotsPending;',
    'const waiting = false;'
  );
  for (const st of [
    { unsent: 1, fsPending: false, lotsPending: false },
    { unsent: 0, fsPending: true, lotsPending: false },
    { unsent: 0, fsPending: false, lotsPending: true },
  ]) {
    assert.equal(
      await failed(() => assert.equal(m.canReload(st).allowed, false)),
      true,
      `🚨 関所の確認が、壊しても落ちなかった: ${JSON.stringify(st)}`
    );
  }
});

test('V93 同じ版なら黙る所を壊すと落ちる', async () => {
  const m = await loadMutant(
    "if (mine === theirs) return { newer: false, reason: 'same' };",
    ''
  );
  assert.equal(
    await failed(() => assert.equal(m.compareBuild('a1', 'a1').newer, false)),
    true,
    '🚨 同版の確認が、壊しても落ちなかった'
  );
});

test('V94 「繰り上がった日付は読めていない」を壊すと落ちる', async () => {
  const m = await loadMutant(
    `  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d
    || dt.getHours() !== h || dt.getMinutes() !== mi) return 0;`,
    '  if (false) return 0;'
  );
  assert.equal(
    await failed(() => assert.equal(m.parseBuildTime('20261332-000000'), 0)),
    true,
    '🚨 でたらめな印を弾く確認が、壊しても落ちなかった(現場に嘘の時刻を出す)'
  );
});

test('V95 間隔を伸ばす上限を壊すと落ちる', async () => {
  const m = await loadMutant(
    'const n = Math.max(0, Math.min(MAX_BACKOFF_STEPS, Math.floor(Number(fails) || 0)));',
    'const n = Math.max(0, Math.floor(Number(fails) || 0));'
  );
  assert.equal(
    await failed(() => assert.equal(m.backoffMs(1000, 9999), 1000 * (1 + MAX_BACKOFF_STEPS))),
    true,
    '🚨 上限の確認が、壊しても落ちなかった(一度の不通で二度と見に行かなくなる)'
  );
});

test('V96 🚨画面が落ちた瞬間に関所が開かない（分からない時は押させない）', () => {
  // 2026-08-20 実測の穴: 画面が消える時に null を置いていたので、
  // canReload(null) が「押してよい」を返し、**未送信を抱えたまま読み直せた**。
  const unknown = canReload({ unknown: true });
  assert.equal(unknown.allowed, false, '🚨分からない時は押させない');
  assert.ok(unknown.label.includes('分かりません'), '理由を人の言葉で出す');
  // ⚠一度も画面が動いていない(?live= の撮影画面など)は今までどおり押してよい
  assert.equal(canReload(null).allowed, true, '保存する物が無い画面を永久に止めない');
  assert.equal(canReload(undefined).allowed, true);
  // ⚠送れていれば押せる / 送れていなければ押せない は今までどおり
  assert.equal(canReload({ unsent: 0, fsPending: false, lotsPending: false }).allowed, true);
  assert.equal(canReload({ unsent: 2, lotsPending: true }).allowed, false);
});
