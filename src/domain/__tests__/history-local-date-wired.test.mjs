// ============================================================================
// 📅 完了履歴・分析の「日付で絞る」は端末の日付(日本なら日本の 0:00〜23:59)で数える
// ----------------------------------------------------------------------------
// 2026-11-10 社内版の家の試しで実測: 'YYYY-MM-DD' だけを new Date に渡すと UTC の 0時(日本の 9:00)になり、
//   朝 9 時前に完了したロットが完了履歴の「今日」に出なかった(既定の絞り込みが 今日〜今日 の画面)。
//   同じファイルの他の絞り込みは new Date(x + 'T00:00:00')(端末の日付の0時)で数えている。それに揃える。
// ここでは画面のコードに書かれている式そのものを取り出し、時差の違う2つの土地で計算して確かめる。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
// new Date(filterStartDate) / new Date(customStartDate + 'T00:00:00') … の形を全部拾う
const RE = /new Date\(\s*((?:filter|custom)(?:Start|End)Date)\s*(\+\s*'[^']*')?\s*\)/g;
const uses = [...APP.matchAll(RE)].map((m) => ({ text: m[0], name: m[1] }));
const TZS = ['Asia/Tokyo', 'America/Los_Angeles'];

const evalAt = (tz, expr, name, ymd) => {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    const d = new Function(name, `return ${expr};`)(ymd);
    return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  } finally { process.env.TZ = saved; if (saved === undefined) delete process.env.TZ; }
};

test('H01 完了履歴・分析の日付の絞り込みの式が画面のコードに在る(拾えていないと試験が空振りする)', () => {
  assert.ok(uses.some((u) => u.name === 'filterStartDate'), 'filterStartDate(完了履歴の始まり)が見つからない');
  assert.ok(uses.some((u) => u.name === 'customStartDate'), 'customStartDate(分析の期間指定の始まり)が見つからない');
});

test('H02 始まりの日は、どの時差の端末でも「その日の 0:00」から数える(朝 9 時前の完了を落とさない)', () => {
  for (const u of uses.filter((x) => x.name.endsWith('StartDate'))) {
    for (const tz of TZS) {
      const r = evalAt(tz, u.text, u.name, '2026-11-10');
      assert.deepEqual(r, { y: 2026, m: 11, day: 10, h: 0, min: 0 }, `${u.text} が ${tz} で 2026-11-10 0:00 にならない(UTC の0時で数えている)`);
    }
  }
});

test('H03 終わりの日も、どの時差の端末でも「その日」(前の日にずれない)', () => {
  for (const u of uses.filter((x) => x.name.endsWith('EndDate'))) {
    for (const tz of TZS) {
      const r = evalAt(tz, u.text, u.name, '2026-11-10');
      assert.deepEqual([r.y, r.m, r.day], [2026, 11, 10], `${u.text} が ${tz} で 2026-11-10 にならない`);
    }
  }
});

test('H04 実際の場面: 日本の端末で、今日 08:30 に完了したロットは「今日〜今日」の完了履歴に入る', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    for (const u of uses.filter((x) => x.name === 'filterStartDate')) {
      const start = new Function('filterStartDate', `return ${u.text}.getTime();`)('2026-11-10');
      const completedAt = Date.parse('2026-11-10T08:30:00+09:00');
      assert.ok(completedAt >= start, `${u.text}: 08:30 の完了が始まり(${new Date(start).toISOString()})より前に見えている`);
    }
  } finally { process.env.TZ = saved; if (saved === undefined) delete process.env.TZ; }
});
