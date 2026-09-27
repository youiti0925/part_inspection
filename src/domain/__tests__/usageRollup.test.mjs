// ============================================================================
// 📈 使用量を集める入れ物の試験
// ----------------------------------------------------------------------------
// ここがズレると起きる事:
//   ・同じ端末が1日に何件も doc を作る → 台数も回数も水増し → 「まだ余裕がある」が嘘になる
//   ・数えていない物を 0 と出す → 「書き込みは1回も使っていない」という嘘を作る
//   ・日の区切りが読み帳面とズレる → 1つの日に2つの枠が混ざる
// ⚠⚠ 見張り自身も疑う。**わざと壊した実装なら落ちる**事を U09/U10 で確かめている。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_COL, FREE_TIER, APPS_SHARING_QUOTA,
  USAGE_DEVICE_KEY, USAGE_LAST_SENT_KEY, DEVICE_ID_RE,
  usageDayKey, usageDocPath,
  ensureDeviceId, shouldSend, buildUsageDoc, summarizeUsage,
} from '../usageRollup.js';
// 部品: 読み帳面は製品の rollReadLog/countRead/countOpen と別の物(tallyReads)なので U09 は外した(日の区切りは quotaWindowKey だけで見る)。
import { quotaWindowKey } from '../readBudget.js';

const at = (iso) => Date.parse(iso);
const NOW = at('2026-08-22T05:00:00Z');           // 日本時間 8/22 14:00 = 米国西部 8/21
const DEV_A = '0123456789abcdef';
const DEV_B = 'fedcba9876543210';

/** 試験用の入れ物(localStorage の代わり)。 */
const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    map: m,
  };
};

const logOf = ({ key, total, opens, byCol = {} }) => ({ key, total, opens, byCol, firstAt: 0, lastAt: 0 });

// ---------------------------------------------------------------------------
test('U00 決めごと(集める先と無料枠)', () => {
  assert.equal(USAGE_COL, 'usage_daily');
  assert.equal(FREE_TIER.readsPerDay, 50000);
  assert.equal(FREE_TIER.writesPerDay, 20000);
  assert.equal(APPS_SHARING_QUOTA, 4);
  assert.ok(Object.isFrozen(FREE_TIER));
  assert.equal(USAGE_DEVICE_KEY, 'usage.deviceId.v1');
  assert.equal(USAGE_LAST_SENT_KEY, 'usage.lastSent.v1');
  // 置き場所は usage_daily の下だけ。lots / settings / tasks を指さない。
  assert.equal(
    usageDocPath('product-inspection-v1', `2026-08-21__${DEV_A}`),
    `artifacts/product-inspection-v1/public/data/usage_daily/2026-08-21__${DEV_A}`,
  );
  // 変な物でパスを作らせない(path を壊して別の場所へ書かせない)。
  assert.equal(usageDocPath('product-inspection-v1', '../../lots/abc'), null);
  assert.equal(usageDocPath('../../..', `2026-08-21__${DEV_A}`), null);
  assert.equal(usageDocPath('product-inspection-v1', '2026-08-21__NOT-A-DEVICE'), null);
});

// ---------------------------------------------------------------------------
// U01 同じ日に2回呼んでも docId が同じ(= 件数が増えない)
// ---------------------------------------------------------------------------
test('U01 同じ日に2回呼んでも docId が同じ(上書きになる)', () => {
  const day = usageDayKey(NOW);
  const first = buildUsageDoc({
    appId: 'product-inspection-v1', deviceId: DEV_A,
    readLog: logOf({ key: day, total: 773, opens: 1, byCol: { lots: 700, templates: 73 } }),
    nowMs: NOW,
  });
  // 同じ日の 6時間後・件数が増えた状態でもう一度
  const later = buildUsageDoc({
    appId: 'product-inspection-v1', deviceId: DEV_A,
    readLog: logOf({ key: day, total: 1200, opens: 3, byCol: { lots: 1100, templates: 100 } }),
    nowMs: NOW + 6 * 3600 * 1000,
  });
  assert.equal(first.docId, later.docId);
  assert.equal(first.docId, `${day}__${DEV_A}`);
  // 上書きなので、2件渡しても1件として数える(件数が増えない)。
  const s = summarizeUsage([first.data, later.data]);
  assert.equal(s.byDay[day].devices, 1);
  assert.equal(s.byDay[day].entries, 1);
  assert.equal(s.byDay[day].reads, 1200);   // 後から来た方(最新)が残る
});

// ---------------------------------------------------------------------------
// U02 1日1回だけ
// ---------------------------------------------------------------------------
test('U02 まだ今日送っていなければ true / 送っていれば false', () => {
  const day = usageDayKey(NOW);
  const readLog = logOf({ key: day, total: 773, opens: 1 });
  assert.equal(shouldSend({ readLog, lastSentKey: null, todayKey: day }), true);
  assert.equal(shouldSend({ readLog, lastSentKey: day, todayKey: day }), false);
  // 前の日に送った物は関係ない(きょうの分はまだ)
  assert.equal(shouldSend({ readLog, lastSentKey: '2026-08-20', todayKey: day }), true);
  // 何も数えていないなら送らない(書き込み1回を使って「何も分からない」を増やさない)
  assert.equal(shouldSend({ readLog: logOf({ key: day, total: 0, opens: 0 }), lastSentKey: null, todayKey: day }), false);
  // 帳面が無い / 日が分からない
  assert.equal(shouldSend({ readLog: null, lastSentKey: null, todayKey: day }), false);
  assert.equal(shouldSend({ readLog, lastSentKey: null, todayKey: 'きょう' }), true); // 帳面の日を使う
  assert.equal(shouldSend({ readLog: { total: 5, opens: 1 }, lastSentKey: null, todayKey: null }), false);
  assert.equal(shouldSend(), false);
  // ⚠区切りをまたいだ古い帳面は「その古い日」として扱う。既に送っていれば false。
  const stale = logOf({ key: '2026-08-20', total: 500, opens: 2 });
  assert.equal(shouldSend({ readLog: stale, lastSentKey: '2026-08-20', todayKey: day }), false);
  assert.equal(shouldSend({ readLog: stale, lastSentKey: day, todayKey: day }), true);
});

// ---------------------------------------------------------------------------
// U03 数えていない物を 0 と出さない
// ---------------------------------------------------------------------------
test('U03 writes を数えていないアプリは writes:null / writesMeasured:false（0にならない）', () => {
  const day = usageDayKey(NOW);
  const base = { appId: 'final-inspection-v1', deviceId: DEV_A, readLog: logOf({ key: day, total: 300, opens: 2 }), nowMs: NOW };

  const none = buildUsageDoc(base);
  assert.equal(none.data.writes, null);
  assert.equal(none.data.writesMeasured, false);
  assert.notEqual(none.data.writes, 0);            // 🚨 0 と書いていない事

  // 測っているアプリは数が入る。0回もれっきとした実測なので 0 でよい。
  const zero = buildUsageDoc({ ...base, writeLog: { dayKey: day, writes: 0 } });
  assert.equal(zero.data.writes, 0);
  assert.equal(zero.data.writesMeasured, true);

  const some = buildUsageDoc({ ...base, writeLog: { dayKey: day, writes: 42 } });
  assert.equal(some.data.writes, 42);
  assert.equal(some.data.writesMeasured, true);
  assert.equal(buildUsageDoc({ ...base, writeLog: 42 }).data.writes, 42);

  // 「測っていない」と自分で言っている帳面は、数が入っていても信用しない。
  const lying = buildUsageDoc({ ...base, writeLog: { dayKey: day, writes: 99, measured: false } });
  assert.equal(lying.data.writes, null);
  assert.equal(lying.data.writesMeasured, false);

  // 🚨 別の日の回数をきょうに貼り付けない(実測ではなく捏造になる)。
  const otherDay = buildUsageDoc({ ...base, writeLog: { dayKey: '2026-08-19', writes: 500 } });
  assert.equal(otherDay.data.writes, null);
  assert.equal(otherDay.data.writesMeasured, false);

  // 内訳(どこを何件読んだか)は **本物の数だけ**載せる。
  //   数でない物・0・マイナスは載せない(載せると「測った」に見えてしまう)。
  const messy = buildUsageDoc({
    ...base,
    readLog: logOf({ key: day, total: 700, opens: 1, byCol: { lots: 700, kowareta: null, hen: 'たくさん', zero: 0, neg: -5 } }),
  });
  assert.deepEqual(messy.data.byCol, { lots: 700 });
  assert.ok(!('kowareta' in messy.data.byCol));
  assert.ok(!('hen' in messy.data.byCol));
  assert.ok(!('zero' in messy.data.byCol));
  assert.ok(!('neg' in messy.data.byCol));

  // 読み取りも同じ。帳面が無ければ null(0ではない)。
  const noLog = buildUsageDoc({ appId: 'parts-inspection-v1', deviceId: DEV_A, readLog: null, nowMs: NOW });
  assert.equal(noLog.data.reads, null);
  assert.equal(noLog.data.opens, null);
  assert.deepEqual(noLog.data.byCol, {});
});

// ---------------------------------------------------------------------------
// U04 端末2台ぶんを足す
// ---------------------------------------------------------------------------
test('U04 端末2台ぶんを足すと devices:2・reads が合計になる', () => {
  const day = '2026-08-21';
  const a = buildUsageDoc({
    appId: 'product-inspection-v1', deviceId: DEV_A,
    readLog: logOf({ key: day, total: 773, opens: 1, byCol: { lots: 773 } }),
    writeLog: { dayKey: day, writes: 30 }, nowMs: NOW,
  }).data;
  const b = buildUsageDoc({
    appId: 'product-inspection-v1', deviceId: DEV_B,
    readLog: logOf({ key: day, total: 1227, opens: 4, byCol: { lots: 1227 } }),
    writeLog: { dayKey: day, writes: 70 }, nowMs: NOW,
  }).data;

  const s = summarizeUsage([a, b]);
  assert.equal(s.latestDay, day);
  assert.equal(s.byDay[day].devices, 2);
  assert.equal(s.byDay[day].reads, 2000);
  assert.equal(s.byDay[day].opens, 5);
  assert.equal(s.byDay[day].writes, 100);
  assert.equal(s.byDay[day].writesMeasured, true);
  // 送る事自体の代金: 2件 = 書き込み2回
  assert.equal(s.byDay[day].selfWrites, 2);
  assert.ok(s.warnings.some((w) => w.includes('2回 の書き込みを使っています')));
  // 「これで全部ではない」を必ず言う
  assert.ok(s.warnings.some((w) => w.includes('送っていない端末の分は入っていません')));

  // 同じ端末が別のアプリからも送ってきたら、台数は1台のまま・アプリ別は2つ。
  const aFinal = { ...a, appId: 'final-inspection-v1' };
  const s2 = summarizeUsage([a, aFinal]);
  assert.equal(s2.byDay[day].devices, 1);
  assert.equal(Object.keys(s2.byDay[day].byApp).length, 2);
  assert.equal(s2.byDay[day].byApp['product-inspection-v1'].reads, 773);
  assert.equal(s2.byDay[day].byApp['final-inspection-v1'].reads, 773);
  assert.equal(s2.byDay[day].reads, 1546);
  assert.equal(s2.byDay[day].selfWrites, 2);   // アプリごとに1回ずつ書く
});

// ---------------------------------------------------------------------------
// U05 一部の端末だけ測れている日を「これが全部です」と言わない
// ---------------------------------------------------------------------------
test('U05 一部の端末が writes を測っていない日は、合計の writes が null', () => {
  const day = '2026-08-21';
  const measured = buildUsageDoc({
    appId: 'product-inspection-v1', deviceId: DEV_A,
    readLog: logOf({ key: day, total: 800, opens: 1 }),
    writeLog: { dayKey: day, writes: 30 }, nowMs: NOW,
  }).data;
  const notMeasured = buildUsageDoc({
    appId: 'final-inspection-v1', deviceId: DEV_B,
    readLog: logOf({ key: day, total: 200, opens: 1 }),
    writeLog: null, nowMs: NOW,
  }).data;

  const s = summarizeUsage([measured, notMeasured]);
  const d = s.byDay[day];
  assert.equal(d.writes, null);              // 🚨 30 と出さない(「これが全部」と言わない)
  assert.notEqual(d.writes, 30);
  assert.notEqual(d.writes, 0);
  assert.equal(d.writesMeasured, false);
  assert.equal(d.recordsMissingWrites, 1);   // ⚠「台」ではなく「記録の件数」
  assert.equal(d.writesFromMeasured, 30);    // 測れている分は別に持つ
  assert.equal(d.reads, 1000);               // 読みは両方測れているので合計が出る
  assert.ok(s.warnings.some((w) => w.includes('書き込みを測っていない記録が 1件')));
  // アプリごとに見ると、測れている方だけは合計が出る。
  assert.equal(d.byApp['product-inspection-v1'].writes, 30);
  assert.equal(d.byApp['final-inspection-v1'].writes, null);

  // 🚨 数える単位を取り違えない: 同じ端末が2つのアプリから送ったら **記録は2件・台数は1台**。
  //    ここを「台」で数えると、1台しか無いのに「2台が測れていない」と出て判断を誤る。
  const sameDev2Apps = [
    { appId: 'product-inspection-v1', deviceId: DEV_A, dayKey: day, reads: 100, opens: 1, byCol: {}, writes: null, writesMeasured: false, at: NOW },
    { appId: 'final-inspection-v1', deviceId: DEV_A, dayKey: day, reads: 100, opens: 1, byCol: {}, writes: null, writesMeasured: false, at: NOW },
  ];
  const s3 = summarizeUsage(sameDev2Apps);
  assert.equal(s3.byDay[day].devices, 1);                 // 台数は1台
  assert.equal(s3.byDay[day].entries, 2);                 // 記録は2件
  assert.equal(s3.byDay[day].recordsMissingWrites, 2);    // 「2台」ではない
  assert.equal(s3.byDay[day].selfWrites, 2);              // 書き込みも2回(アプリごと)
  assert.ok(s3.warnings.some((w) => w.includes('書き込みを測っていない記録が 2件')));
  assert.ok(!s3.warnings.some((w) => w.includes('2台')));

  // 読み取りが測れていない端末が混ざった時も同じ扱い。
  const noReads = { ...notMeasured, reads: null };
  const s2 = summarizeUsage([measured, noReads]);
  assert.equal(s2.byDay[day].reads, null);
  assert.notEqual(s2.byDay[day].reads, 800);
  assert.equal(s2.byDay[day].readsFromMeasured, 800);
  assert.ok(s2.warnings.some((w) => w.includes('読み取りを測っていない記録が 1件')));
});

// ---------------------------------------------------------------------------
// U06 割合は測れている物だけで出す
// ---------------------------------------------------------------------------
test('U06 割合は測れている物だけで出す（測っていない物は分母にも分子にも入れない）', () => {
  const day = '2026-08-21';
  const mk = (dev, appId, reads, writes, writesMeasured) => ({
    appId, deviceId: dev, dayKey: day, reads, opens: 1, byCol: {},
    writes, writesMeasured, at: NOW,
  });

  // 読み 5,000 / 枠 50,000 = 10.0% ・ 書き 2,000 / 枠 20,000 = 10.0%
  const s = summarizeUsage([mk(DEV_A, 'product-inspection-v1', 5000, 2000, true)]);
  assert.equal(s.readsPct, 10);
  assert.equal(s.writesPct, 10);

  // 書きを測っていない端末が混ざったら writesPct は null(0% でも 10% でもない)
  const s2 = summarizeUsage([
    mk(DEV_A, 'product-inspection-v1', 5000, 2000, true),
    mk(DEV_B, 'final-inspection-v1', 5000, null, false),
  ]);
  assert.equal(s2.readsPct, 20);            // 読みは両方測れている = 10,000/50,000
  assert.equal(s2.writesPct, null);         // 🚨 測っていない物を混ぜて % を作らない
  assert.notEqual(s2.writesPct, 10);
  assert.notEqual(s2.writesPct, 0);

  // 1件も無い日は「0%」ではなく null。
  const empty = summarizeUsage([]);
  assert.equal(empty.latestDay, null);
  assert.equal(empty.readsPct, null);
  assert.equal(empty.writesPct, null);
  assert.deepEqual(empty.byDay, {});
  assert.ok(empty.warnings.some((w) => w.includes('まだ測っていない')));

  // 枠は差し替えられる(4アプリで1つ、という前提を試験でも動かせるように)
  const s3 = summarizeUsage([mk(DEV_A, 'product-inspection-v1', 5000, 2000, true)],
    { freeTier: { readsPerDay: 10000, writesPerDay: 4000 } });
  assert.equal(s3.readsPct, 50);
  assert.equal(s3.writesPct, 50);

  // 枠の8割を超えたら警告が出る
  const s4 = summarizeUsage([mk(DEV_A, 'product-inspection-v1', 45000, 19000, true)]);
  assert.equal(s4.readsPct, 90);
  assert.ok(s4.warnings.some((w) => w.includes('読み取りが無料枠の 90%')));
  assert.ok(s4.warnings.some((w) => w.includes('書き込みが無料枠の 95%')));
});

// ---------------------------------------------------------------------------
// U07 端末の印に個人が分かる物が入らない
// ---------------------------------------------------------------------------
test('U07 deviceId は乱数だけ（英数字・長さ固定・個人が分かる物が入らない）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const st = fakeStore();
    const id = ensureDeviceId(st.get, st.set);
    assert.match(id, DEVICE_ID_RE);
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]+$/);          // 英数字(16進)だけ。記号も日本語も入らない
    seen.add(id);
  }
  assert.ok(seen.size > 495, `乱数になっていない(${seen.size}/500)`);

  // 時刻が混ざっていない(いつ作ったかが分からない)
  const nowStr = String(Date.now());
  for (const id of seen) {
    assert.ok(!id.includes(nowStr.slice(0, 8)), '時刻が混ざっている');
    assert.ok(!id.includes(Date.now().toString(16).slice(0, 6)), '時刻が混ざっている');
  }

  // ensureDeviceId は端末の名前も利用者の名前も **受け取らない**(引数は入れ物2つだけ)
  assert.equal(ensureDeviceId.length, 2);

  // 一度作ったら覚える(呼ぶたびに変わらない = 1端末1日1件が守れる)
  const st = fakeStore();
  const a = ensureDeviceId(st.get, st.set);
  const b = ensureDeviceId(st.get, st.set);
  assert.equal(a, b);
  assert.equal(st.map.get(USAGE_DEVICE_KEY), a);

  // 壊れた値が入っていたら作り直す
  const bad = fakeStore({ [USAGE_DEVICE_KEY]: '清水さんのタブレット' });
  const fixed = ensureDeviceId(bad.get, bad.set);
  assert.match(fixed, DEVICE_ID_RE);

  // 🚨 覚えられない端末は null(印が毎回変わって台数を水増しするより、送らない方がまし)
  const cannotWrite = ensureDeviceId(() => null, () => { throw new Error('QuotaExceeded'); });
  assert.equal(cannotWrite, null);
  const silentlyDrops = ensureDeviceId(() => null, () => { /* 書けたつもりで書けていない */ });
  assert.equal(silentlyDrops, null);
  assert.equal(ensureDeviceId(null, null), null);
  // 読む側が例外を投げても落ちない(現場の作業を1ミリも止めない)
  const st2 = fakeStore();
  const okAnyway = ensureDeviceId(() => { throw new Error('boom'); }, st2.set);
  assert.equal(okAnyway, null);   // 読み直して確かめられないので送らない

  // 印が無ければ doc も作らない
  assert.equal(buildUsageDoc({ appId: 'product-inspection-v1', deviceId: null, readLog: logOf({ key: '2026-08-21', total: 1, opens: 1 }), nowMs: NOW }), null);
  assert.equal(buildUsageDoc({ appId: 'product-inspection-v1', deviceId: '../../lots', readLog: logOf({ key: '2026-08-21', total: 1, opens: 1 }), nowMs: NOW }), null);
  assert.equal(buildUsageDoc({ appId: '', deviceId: DEV_A, readLog: logOf({ key: '2026-08-21', total: 1, opens: 1 }), nowMs: NOW }), null);
  assert.equal(buildUsageDoc(), null);   // throw しない(現場を止めない)
});

// ---------------------------------------------------------------------------
// U08 同じ入力2回で完全一致
// ---------------------------------------------------------------------------
test('U08 同じ入力を2回入れたら完全に同じ物が出る（Date.now を中で呼んでいない）', () => {
  const day = '2026-08-21';
  const args = {
    appId: 'product-inspection-v1', deviceId: DEV_A,
    readLog: logOf({ key: day, total: 773, opens: 1, byCol: { templates: 73, lots: 700 } }),
    writeLog: { dayKey: day, writes: 12 }, nowMs: NOW,
  };
  const x = buildUsageDoc(args);
  const y = buildUsageDoc(args);
  assert.deepEqual(x, y);
  assert.equal(JSON.stringify(x), JSON.stringify(y));   // 並び順まで同じ

  // 内訳のキーの順番が入力で変わっても、出来上がりは同じ(並べ替えている)
  const swapped = buildUsageDoc({ ...args, readLog: logOf({ key: day, total: 773, opens: 1, byCol: { lots: 700, templates: 73 } }) });
  assert.equal(JSON.stringify(x), JSON.stringify(swapped));

  const docs = [x.data, { ...x.data, deviceId: DEV_B, appId: 'final-inspection-v1' }];
  const s1 = summarizeUsage(docs);
  const s2 = summarizeUsage([...docs].reverse());
  assert.equal(JSON.stringify(s1), JSON.stringify(s2));  // 渡す順番が違っても同じ

  // 🚨 中で Date.now() を呼んでいたら、時計を進めた時に結果が変わる。
  const realNow = Date.now;
  try {
    Date.now = () => 4102444800000;   // 2100-01-01
    assert.equal(JSON.stringify(buildUsageDoc(args)), JSON.stringify(x));
    assert.equal(JSON.stringify(summarizeUsage(docs)), JSON.stringify(s1));
    assert.equal(usageDayKey(NOW), quotaWindowKey(NOW));
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
test('U10 わざと壊した実装（測っていない物を0として足す）なら、この試験は落ちる', () => {
  const day = '2026-08-21';
  const docs = [
    { appId: 'product-inspection-v1', deviceId: DEV_A, dayKey: day, reads: 800, opens: 1, byCol: {}, writes: 30, writesMeasured: true, at: NOW },
    { appId: 'final-inspection-v1', deviceId: DEV_B, dayKey: day, reads: 200, opens: 1, byCol: {}, writes: null, writesMeasured: false, at: NOW },
  ];

  // 壊れた集計(よくやる間違い): writes を `Number(w)||0` で足してしまう
  const brokenWrites = docs.reduce((a, d) => a + (Number(d.writes) || 0), 0);
  assert.equal(brokenWrites, 30);                       // 壊れた実装はこう出す
  assert.notEqual(summarizeUsage(docs).byDay[day].writes, brokenWrites);  // 本物は出さない
  assert.equal(summarizeUsage(docs).byDay[day].writes, null);

  // 壊れた集計: 同じ doc を2回渡されて2倍に数えてしまう
  const twice = summarizeUsage([...docs, ...docs]);
  assert.equal(twice.byDay[day].reads, 1000);           // 2000 にならない
  assert.equal(twice.byDay[day].devices, 2);            // 4 にならない
  assert.equal(twice.byDay[day].selfWrites, 2);

  // 壊れた集計: 台数を「doc の件数」で数えてしまう(同じ端末が4アプリから送る)
  const sameDevice4Apps = ['product-inspection-v1', 'final-inspection-v1', 'parts-inspection-v1', 'overview-app-v1']
    .map((appId) => ({ appId, deviceId: DEV_A, dayKey: day, reads: 100, opens: 1, byCol: {}, writes: 5, writesMeasured: true, at: NOW }));
  const s = summarizeUsage(sameDevice4Apps);
  assert.notEqual(s.byDay[day].devices, 4);
  assert.equal(s.byDay[day].devices, 1);
  assert.equal(s.byDay[day].reads, 400);
  assert.equal(s.byDay[day].selfWrites, 4);   // 🚨 書き込みは4回(アプリごと)

  // 🚨 端末の印が無い記録を、勝手に「1台」に化けさせない。
  //    化けさせると 台数も回数も嘘になる(別々の端末が1台に潰れる / 幽霊が1台増える)。
  const noDevice = { appId: 'product-inspection-v1', dayKey: day, reads: 999, opens: 1, byCol: {}, writes: 1, writesMeasured: true, at: NOW };
  const s2 = summarizeUsage([...docs, noDevice]);
  assert.equal(s2.byDay[day].devices, 2);            // 3 にならない
  assert.equal(s2.byDay[day].reads, 1000);           // 1999 にならない
  assert.equal(s2.byDay[day].selfWrites, 2);
  assert.ok(s2.warnings.some((w) => w.includes('数えられなかった記録が 1件')));

  // 形が違う記録は黙って足さない(数えられなかった事を言う)
  const dirty = summarizeUsage([...docs, { reads: 999 }, null, 'ごみ']);
  assert.equal(dirty.byDay[day].reads, 1000);
  assert.ok(dirty.warnings.some((w) => w.includes('数えられなかった記録が 3件')));
});

// ---------------------------------------------------------------------------
// U11 何日ぶんかを混ぜても、日ごとに分かれる
// ---------------------------------------------------------------------------
test('U11 何日ぶんか混ぜても日ごとに分かれ、latestDay は一番新しい日', () => {
  const mk = (dayKey, dev, reads) => ({
    appId: 'product-inspection-v1', deviceId: dev, dayKey, reads, opens: 1, byCol: {},
    writes: 10, writesMeasured: true, at: NOW,
  });
  const s = summarizeUsage([mk('2026-08-19', DEV_A, 100), mk('2026-08-21', DEV_A, 300), mk('2026-08-20', DEV_B, 200)]);
  assert.deepEqual(Object.keys(s.byDay), ['2026-08-19', '2026-08-20', '2026-08-21']);
  assert.equal(s.latestDay, '2026-08-21');
  assert.equal(s.byDay['2026-08-21'].reads, 300);
  assert.equal(s.byDay['2026-08-19'].reads, 100);
  // % は一番新しい日の分だけ
  assert.equal(s.readsPct, 0.6);   // 300 / 50000
});
