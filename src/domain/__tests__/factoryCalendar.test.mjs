// ============================================================================
// 工場の暦(祝日・全社休業・休日出勤)の見張り
// ----------------------------------------------------------------------------
// 🚨 この見張りは **わざと壊して赤を見てから** 置いている(下に記録)。
//    緑なのに何も守っていない見張りを増やさない(2026-08-30 の大掃除)。
// 🚨 時刻の帯(タイムゾーン)を変えても同じ答えになる事を、
//    **別の node を実際に起動して** 確かめる(2026-08-30「時計の帯に依る試験」)。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_WORKDAYS, DAY_OFF, DAY_WORK,
  isYmd, partsOfYmd, dowOfYmd, nextYmd, ymdOf, toYmd,
  normalizeCalendar, entryOfYmd, isWorkdayYmd, isWorkday,
  countWorkdaysBetween, countCalendarDaysBetween,
  listHolidaysBetween, listWorkOverridesBetween,
  monthRange, shiftMonth, monthDays, monthSummary,
  applyDay, cycleDay, setDayLabel,
} from '../factoryCalendar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, '..', 'factoryCalendar.js');

// 年末年始(2026-12-29 〜 2027-01-03)。会社が決める休みで、祝日法には無い。
const NENMATSU = {
  days: {
    '2026-12-29': { type: 'off', label: '年末年始' },
    '2026-12-30': { type: 'off', label: '年末年始' },
    '2026-12-31': { type: 'off', label: '年末年始' },
    '2027-01-01': { type: 'off', label: '年末年始' },
    '2027-01-02': { type: 'off', label: '年末年始' },
    '2027-01-03': { type: 'off', label: '年末年始' },
  },
};

// ----------------------------------------------------------------------------
// F01 既定 = 今までと1ミリも同じ
// ----------------------------------------------------------------------------

test('F01 登録が空なら月〜金。土日は休み(今までと同じ挙動)', () => {
  assert.deepEqual([...DEFAULT_WORKDAYS], [1, 2, 3, 4, 5]);
  // 2026-09-14(月) 〜 2026-09-20(日) の1週間
  const week = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
  const got = week.map((d) => isWorkdayYmd(d, null));
  assert.deepEqual(got, [true, true, true, true, true, false, false]);
  // 暦を渡さなくても、空の暦でも、空の days でも同じ
  for (const cal of [undefined, null, {}, { days: {} }, { days: null }, 'こわれた値', 123, []]) {
    assert.equal(isWorkdayYmd('2026-09-14', cal), true, String(cal));
    assert.equal(isWorkdayYmd('2026-09-19', cal), false, String(cal));
  }
});

test('F02 登録が空なら、その月の営業日は「平日の数」そのまま', () => {
  // 2026年9月: 暦30日・平日22日(独立に数えた値)
  assert.equal(countWorkdaysBetween({ from: '2026-09-01', to: '2026-09-30' }), 22);
  assert.equal(countCalendarDaysBetween({ from: '2026-09-01', to: '2026-09-30' }), 30);
  const s = monthSummary({ year: 2026, month: 9, calendar: null });
  assert.equal(s.workdays, 22);
  assert.equal(s.baseWorkdays, 22);
  assert.equal(s.diff, 0);
  assert.equal(s.registered, 0);
});

// ----------------------------------------------------------------------------
// F03/F04 両方向の上書き
// ----------------------------------------------------------------------------

test('F03 平日を休みにすると営業日が1日減る', () => {
  const one = { days: { '2026-09-21': { type: 'off', label: '敬老の日' } } };
  assert.equal(isWorkdayYmd('2026-09-21', one), false);
  assert.equal(countWorkdaysBetween({ from: '2026-09-01', to: '2026-09-30', calendar: one }), 21); // 22 - 1
  const s = monthSummary({ year: 2026, month: 9, calendar: one });
  assert.equal(s.workdays, 21);
  assert.equal(s.baseWorkdays, 22);
  assert.equal(s.diff, -1);
  assert.deepEqual(s.holidays.map((h) => h.ymd), ['2026-09-21']);
  assert.equal(s.holidays[0].label, '敬老の日');
});

test('F04 土日を出勤にすると営業日が1日増える', () => {
  assert.equal(dowOfYmd('2026-10-17'), 6, '2026-10-17 は土曜');
  const one = { days: { '2026-10-17': { type: 'work', label: '休日出勤' } } };
  assert.equal(isWorkdayYmd('2026-10-17', one), true);
  assert.equal(countWorkdaysBetween({ from: '2026-10-01', to: '2026-10-31', calendar: one }), 23); // 22 + 1
  const s = monthSummary({ year: 2026, month: 10, calendar: one });
  assert.equal(s.workdays, 23);
  assert.equal(s.diff, +1);
  assert.deepEqual(s.workOverrides.map((h) => h.ymd), ['2026-10-17']);
  // 「この期間の休み」には出さない(休みではないので)
  assert.deepEqual(listHolidaysBetween({ from: '2026-10-01', to: '2026-10-31', calendar: one }), []);
  assert.deepEqual(listWorkOverridesBetween({ from: '2026-10-01', to: '2026-10-31', calendar: one }).map((x) => x.ymd), ['2026-10-17']);
});

test('F05 2026年9月に敬老・国民の休日・秋分を入れると 22日 → 19日', () => {
  const cal = { days: {
    '2026-09-21': { type: 'off', label: '敬老の日' },
    '2026-09-22': { type: 'off', label: '国民の休日' },
    '2026-09-23': { type: 'off', label: '秋分の日' },
  } };
  const s = monthSummary({ year: 2026, month: 9, calendar: cal });
  assert.equal(s.baseWorkdays, 22);
  assert.equal(s.workdays, 19);
  assert.equal(s.calendarDays, 30);
});

test('F06 年末年始(12/29〜1/3)を入れると 12月は 23日→20日・1月は 21日→20日', () => {
  // 12/29(火) 12/30(水) 12/31(木) は平日 → 3日減る
  const dec = monthSummary({ year: 2026, month: 12, calendar: NENMATSU });
  assert.equal(dec.baseWorkdays, 23);
  assert.equal(dec.workdays, 20);
  assert.deepEqual(dec.holidays.map((h) => h.ymd), ['2026-12-29', '2026-12-30', '2026-12-31']);
  // 1/1(金)だけが平日。1/2(土) 1/3(日) は元から休み → 1日しか減らない
  const jan = monthSummary({ year: 2027, month: 1, calendar: NENMATSU });
  assert.equal(jan.baseWorkdays, 21);
  assert.equal(jan.workdays, 20);
  assert.equal(jan.holidays.length, 3, '登録した3日は「休み」として一覧に出る(土日でも)');
  // 期間をまたいで数えても合う
  assert.equal(countWorkdaysBetween({ from: '2026-12-01', to: '2027-01-31', calendar: NENMATSU }), 40);
});

// ----------------------------------------------------------------------------
// F07 壊れた値(落ちない・黙って全部休みにしない)
// ----------------------------------------------------------------------------

test('F07 鍵の形が違う値・知らない種類は読み捨てる。**黙って休みにしない**', () => {
  const junk = { days: {
    '2026/09/21': 'off',          // 区切りが違う
    '2026-9-21': 'off',           // 0詰めが無い
    '2026-13-01': 'off',          // 13月
    '2026-02-30': 'off',          // 実在しない日
    'きょう': 'off',
    '': 'off',
    '2026-09-24': 'やすみ',       // 知らない種類
    '2026-09-25': { type: 'ばつ' },
    '2026-09-28': null,
    '2026-09-29': [1, 2],
    '2026-09-30': true,
  } };
  const n = normalizeCalendar(junk);
  assert.deepEqual(Object.keys(n.days), [], '読めた登録は0件のはず');
  // 9月は1日も減らない(=壊れた値で工場が休みにならない)
  assert.equal(monthSummary({ year: 2026, month: 9, calendar: junk }).workdays, 22);
  // 呼んでも落ちない
  assert.equal(isWorkdayYmd('2026-09-24', junk), true);
  assert.equal(isWorkdayYmd('2026-02-30', junk), false, '日付として読めない物は営業日に数えない');
  assert.equal(isWorkdayYmd(null, junk), false);
  assert.equal(isWorkday(undefined, junk), false);
  assert.equal(entryOfYmd(junk, '2026-09-24'), null);
});

test('F08 稼働曜日が空・壊れていたら 月〜金 へ戻す(1日も働かない暦を作らない)', () => {
  assert.deepEqual([...normalizeCalendar({ workdays: [] }).workdays], [1, 2, 3, 4, 5]);
  assert.deepEqual([...normalizeCalendar({ workdays: 'げつ' }).workdays], [1, 2, 3, 4, 5]);
  assert.deepEqual([...normalizeCalendar({ workdays: [9, -1, 'x'] }).workdays], [1, 2, 3, 4, 5]);
  // ちゃんとした値なら効く(土曜も稼働の工場)
  assert.deepEqual([...normalizeCalendar({ workdays: [1, 2, 3, 4, 5, 6] }).workdays], [1, 2, 3, 4, 5, 6]);
  assert.equal(isWorkdayYmd('2026-10-17', { workdays: [1, 2, 3, 4, 5, 6] }), true);
});

test('F09 平たい地図({ "YYYY-MM-DD": "off" })でも読める', () => {
  const flat = { '2026-09-21': 'off', '2026-10-17': '出勤' };
  const n = normalizeCalendar(flat);
  assert.deepEqual(Object.keys(n.days).sort(), ['2026-09-21', '2026-10-17']);
  assert.equal(n.days['2026-09-21'].type, DAY_OFF);
  assert.equal(n.days['2026-10-17'].type, DAY_WORK);
});

test('F10 期間が逆・壊れていたら 0(永久に回らない)', () => {
  assert.equal(countWorkdaysBetween({ from: '2026-09-30', to: '2026-09-01' }), 0);
  assert.equal(countWorkdaysBetween({}), 0);
  assert.equal(countWorkdaysBetween({ from: 'x', to: 'y' }), 0);
  assert.equal(countCalendarDaysBetween({ from: '2026-09-01', to: '2026-09-01' }), 1, '両端を含む');
  assert.equal(countWorkdaysBetween({ from: '2026-09-14', to: '2026-09-14' }), 1);
});

// ----------------------------------------------------------------------------
// F11 日付まわりの土台
// ----------------------------------------------------------------------------

test('F11 日付の道具(実在しない日を通さない・翌日が飛ばない)', () => {
  assert.equal(isYmd('2026-09-01'), true);
  assert.equal(isYmd('2026-02-29'), false, '2026年は閏年ではない');
  assert.equal(isYmd('2028-02-29'), true, '2028年は閏年');
  assert.equal(isYmd('2026-04-31'), false);
  assert.deepEqual(partsOfYmd('2026-09-01'), { y: 2026, m: 9, d: 1 });
  assert.equal(nextYmd('2026-09-30'), '2026-10-01');
  assert.equal(nextYmd('2026-12-31'), '2027-01-01');
  assert.equal(nextYmd('2028-02-28'), '2028-02-29');
  assert.equal(nextYmd('こわれ'), null);
  assert.equal(monthRange(2026, 2).to, '2026-02-28');
  assert.equal(monthRange(2028, 2).to, '2028-02-29');
  assert.equal(monthRange(2026, 13), null);
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2027, 1, -1), { year: 2026, month: 12 });
  assert.equal(monthDays(2026, 9, null).length, 30);
  assert.equal(toYmd(new Date(2026, 8, 21)), '2026-09-21');
});

// ----------------------------------------------------------------------------
// F12/F13 登録を変える(取り消せる = ミスしても直せる)
// ----------------------------------------------------------------------------

test('F12 セルを2回押すと元に戻る。戻す時は必ず「消す印」が付く', () => {
  // 平日: 出勤 → 休み → 出勤
  const a = cycleDay(null, '2026-09-21');
  assert.equal(a.next, DAY_OFF);
  assert.deepEqual(a.deleteKeys, []);
  const b = cycleDay({ days: a.days }, '2026-09-21');
  assert.equal(b.next, null, '2回目で登録なし(既定)へ戻る');
  assert.deepEqual(Object.keys(b.days), []);
  // 🚨 これが無いと merge:true で素通りし、休みのまま焼き付いて二度と戻せない
  assert.deepEqual(b.deleteKeys, [['factoryCalendar', 'days', '2026-09-21']]);
  // 土日: 休み → 出勤 → 休み
  const c = cycleDay(null, '2026-10-17');
  assert.equal(c.next, DAY_WORK);
  const d = cycleDay({ days: c.days }, '2026-10-17');
  assert.equal(d.next, null);
  assert.deepEqual(d.deleteKeys, [['factoryCalendar', 'days', '2026-10-17']]);
});

test('F13 保存する物を作るだけで、元の暦は書き換えない', () => {
  const base = { days: { '2026-09-21': { type: 'off', label: '敬老の日' } } };
  const snapshot = JSON.stringify(base);
  const r = applyDay(base, '2026-09-22', DAY_OFF, '国民の休日');
  assert.equal(JSON.stringify(base), snapshot, '元の値が書き換わっている');
  assert.deepEqual(Object.keys(r.days).sort(), ['2026-09-21', '2026-09-22']);
  // 一言だけ直す
  const l = setDayLabel(base, '2026-09-21', '  敬老の日（全社休業）  ');
  assert.equal(l.days['2026-09-21'].label, '敬老の日（全社休業）', '前後の空白は落とす');
  assert.equal(l.days['2026-09-21'].type, DAY_OFF, '種類は変えない');
  // 登録の無い日に一言だけ付けても、休みにはしない
  const n = setDayLabel(base, '2026-09-25', 'なにか');
  assert.equal(n.days['2026-09-25'], undefined);
  // 保存先のフィールド名は呼ぶ側が決める(共有の棚に置く時に変わる)
  const k = applyDay(base, '2026-09-21', null, '', 'sharedCal');
  assert.deepEqual(k.deleteKeys, [['sharedCal', 'days', '2026-09-21']]);
  // 壊れた日付では何も起きない(落ちない)
  const z = cycleDay(base, '2026-02-30');
  assert.deepEqual(z.deleteKeys, []);
  assert.equal(z.next, null);
});

// ----------------------------------------------------------------------------
// F14 時刻の帯(タイムゾーン)
// ----------------------------------------------------------------------------

test('F14 時刻の帯を変えても同じ答え(別の node を実際に起動して確かめる)', () => {
  // ⚠ 同じプロセスの中で process.env.TZ を書き換えても、Node は既に読んだ帯を
  //   使い続けることがある。だから **子プロセスを起こして** 確かめる。
  const url = pathToFileURL(MODULE_PATH).href;
  const code = `
    const m = await import(${JSON.stringify(url)});
    const cal = ${JSON.stringify(NENMATSU)};
    const out = {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      off: new Date().getTimezoneOffset(),
      sep: m.countWorkdaysBetween({ from: '2026-09-01', to: '2026-09-30' }),
      dec: m.monthSummary({ year: 2026, month: 12, calendar: cal }).workdays,
      jan: m.monthSummary({ year: 2027, month: 1, calendar: cal }).workdays,
      dow: ['2026-09-21','2026-10-17','2027-01-01'].map(m.dowOfYmd),
      holi: m.listHolidaysBetween({ from: '2026-12-01', to: '2027-01-31', calendar: cal }).map(h => h.ymd),
      // 🚨 夏時間のある帯で日が飛ばない・同じ日を二度数えないか。
      //   ⚠ **春(1時間進む)と秋(1時間戻る)の両方**を見る。実測:
      //     America/New_York 2027-11-07 に 86400000 を足すと **同じ 11-07 に戻る**。
      //     Australia/Lord_Howe 2027-04-04 も同じ。春だけ見ていたら見逃す(実際に見逃した)。
      dstSpring: m.countCalendarDaysBetween({ from: '2027-03-08', to: '2027-03-21' }),
      dstSpringW: m.countWorkdaysBetween({ from: '2027-03-08', to: '2027-03-21' }),
      dstFall: m.countCalendarDaysBetween({ from: '2027-11-01', to: '2027-11-14' }),
      dstFallW: m.countWorkdaysBetween({ from: '2027-11-01', to: '2027-11-14' }),
      dstFallS: m.countCalendarDaysBetween({ from: '2027-04-01', to: '2027-04-14' }),
      dstNext: ['2027-11-06', '2027-11-07', '2027-03-13', '2027-04-03', '2027-04-04'].map(m.nextYmd),
      // 端末の帯にとっての「その日の正午」を渡す入口
      noonYmd: m.ymdOf(new Date(2026, 8, 21, 12, 0, 0).getTime()),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const run = (tz) => {
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8',
    });
    return JSON.parse(raw);
  };
  // ⚠ 夏時間のある帯を必ず入れる。無いと「日が飛ぶ/同じ日を二度数える」欠陥が素通りする。
  const zones = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Niue', 'Australia/Lord_Howe'];
  const results = zones.map((z) => [z, run(z)]);

  // ⚠ まず「帯が本当に変わったか」を確かめる。変わっていなければ、この試験は
  //   何も見ていない事になる(緑なのに守っていない見張りになる)。
  const offsets = new Set(results.map(([, r]) => r.off));
  assert.ok(offsets.size >= 3, `時刻の帯が実際に変わっていません(見た差 ${[...offsets].join(',')})`);

  const base = JSON.stringify({ ...results[0][1], tz: undefined, off: undefined });
  for (const [z, r] of results) {
    assert.equal(JSON.stringify({ ...r, tz: undefined, off: undefined }), base, `帯 ${z} で答えが変わりました`);
  }
  const first = results[0][1];
  assert.equal(first.sep, 22);
  assert.equal(first.dec, 20);
  assert.equal(first.jan, 20);
  assert.deepEqual(first.dow, [1, 6, 5]);
  assert.equal(first.dstSpring, 14, '夏時間(春)の切替をまたいでも 14日');
  assert.equal(first.dstSpringW, 10);
  assert.equal(first.dstFall, 14, '夏時間(秋)の切替をまたいでも 14日');
  assert.equal(first.dstFallW, 10);
  assert.equal(first.dstFallS, 14, '南半球の切替をまたいでも 14日');
  assert.deepEqual(first.dstNext, ['2027-11-07', '2027-11-08', '2027-03-14', '2027-04-04', '2027-04-05'],
    '切替の日の翌日が「同じ日」に戻っていない');
  assert.equal(first.noonYmd, '2026-09-21');
});
