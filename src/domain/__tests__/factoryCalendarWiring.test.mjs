// ============================================================================
// 工場の暦(祝日表)が **部品検査アプリの中で本当に使われているか** の見張り
// ----------------------------------------------------------------------------
// なぜ純関数の試験と別に要るか(2026-08-23 の教訓):
//   factoryCalendar.js だけを試験しても、App.jsx が呼んでいなければ
//   本番は今まで通り「土日だけ休み」で回る。**緑なのに何も守っていない**見張りになる。
//   ここは実物の src/App.jsx を読んで、稼働日を決める場所が暦を通しているかを見る。
//
// 🚨 この見張りは わざと壊して赤を見てから置いている(下に記録)。
// ⚠ App.jsx は CRLF(改行が \r\n)。当て込みで空振りしないよう、比較の前に必ず \r を落とす。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { countWorkdaysBetween, monthSummary, isWorkdayYmd } from '../factoryCalendar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..', 'App.jsx');
const SRC = fs.readFileSync(APP, 'utf8').replace(/\r\n/g, '\n');

/** `const 名前 = ` から、列0の `};` までを切り出す。 */
const bodyOf = (name) => {
  const head = `const ${name} = `;
  const i = SRC.indexOf(head);
  assert.notEqual(i, -1, `${name} が src/App.jsx に見つかりません`);
  const j = SRC.indexOf('\n};', i);
  assert.notEqual(j, -1, `${name} の終わりが見つかりません`);
  return SRC.slice(i, j + 3);
};

// ----------------------------------------------------------------------------
// W01〜W04 稼働日を決める場所が、暦を通っているか
// ----------------------------------------------------------------------------

test('W01 工場の暦を読み込んでいる', () => {
  assert.ok(
    /import\s*\{[^}]*\bisWorkdayYmd\b[^}]*\}\s*from\s*'\.\/domain\/factoryCalendar\.js'/.test(SRC),
    'src/App.jsx が domain/factoryCalendar.js を読み込んでいません(暦がどこにも効きません)',
  );
});

test('W02 ロスターの平均在席が、工場が休みの日を数えていない', () => {
  const body = bodyOf('rosterAdjustedAvailable');
  assert.ok(body.includes('isWorkdayYmd('), 'rosterAdjustedAvailable が暦を見ていません');
  assert.ok(/factoryCalendar\s*=\s*null/.test(body), '暦を受け取る引数がありません');
  // 🚨 土日だけを見る式が残っていたら、暦を足しても祝日は素通りする。
  assert.ok(
    !/dow\s*===\s*0\s*\|\|\s*dow\s*===\s*6/.test(body),
    'rosterAdjustedAvailable に「土日だけ休み」の式が残っています',
  );
});

test('W03 停止理由の経過時間が、工場が休みの日を数えていない', () => {
  const body = bodyOf('computeElapsedWorkSeconds');
  assert.ok(body.includes('sch.factoryCalendar'), '勤務表から暦を取り出していません');
  assert.ok(body.includes('isWorkdayYmd('), '暦を見ていません');
  assert.ok(
    !/dow\s*===\s*0\s*\|\|\s*dow\s*===\s*6/.test(body),
    'computeElapsedWorkSeconds に「土日だけ休み」の式が残っています',
  );
  // 週の形の持ち主は勤務表(daysPerWeek)のまま = 今までの挙動を変えない。
  assert.ok(body.includes('excludeWeekend ? [1, 2, 3, 4, 5]'), '勤務表の稼働日/週が効いていません');
});

test('W04 共通の棚から暦を読む配線がある(読むだけ・書かない)', () => {
  assert.ok(SRC.includes("const CONTACT_SHARED_NS = 'contact-shared-v1';"), '共通の棚の名前がありません');
  assert.ok(
    /watchDoc\(CONTACT_SHARED_NS,\s*'settings',\s*'config'/.test(SRC),
    '共通の棚の settings/config を購読していません(暦が一生 null のままになります)',
  );
  assert.ok(SRC.includes('setFactoryCalendar('), '読んだ暦をどこにも入れていません');
  // 🚨 このアプリは登録しない。共通の棚へ **書く** 道は作らない。
  //   ⚠ 2026-09-01 実測: ここを「CONTACT_SHARED_NS から行末まで」で見ていて、
  //     `DATA(db).save(CONTACT_SHARED_NS, ...)` を **取り逃がした**(書く道を作っても緑だった)。
  //     書く言葉は名前の **前** にも来る。だから行を丸ごと見る。
  const bad = SRC.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('CONTACT_SHARED_NS')
      && /\.save\(|\.setFields\(|\.remove\(|setDoc\(|updateDoc\(|deleteDoc\(/.test(l))
    .map(([n, l]) => `${n}: ${l.trim()}`);
  assert.deepEqual(bad, [], '部品検査アプリから共通の棚へ書く道ができています(登録は製品検査/最終検査だけ)');
});

test('W05 暦を渡す先がつながっている(受け取る所・渡す所の両方)', () => {
  assert.ok(
    /const ProgressOverviewView = \(\{[^}]*factoryCalendar[^}]*\}\)/.test(SRC),
    'ProgressOverviewView が暦を受け取っていません',
  );
  assert.ok(
    /<ProgressOverviewView[^>]*factoryCalendar=\{factoryCalendar\}/.test(SRC),
    'ProgressOverviewView へ暦を渡していません',
  );
  assert.ok(
    /rosterAdjustedAvailable\([\s\S]{0,300}?baselineWorkers,\s*factoryCalendar\)/.test(SRC),
    'ロスターの計算へ暦を渡していません',
  );
  assert.ok(
    /<WorkScheduleContext\.Provider value=\{workScheduleWithCalendar\}>/.test(SRC),
    '勤務表の文脈へ暦を流していません',
  );
  // 🚨 文脈の値を毎描画で作り直すと、読んでいる札が全部描き直しになる。
  assert.ok(
    /const workScheduleWithCalendar = useMemo\(/.test(SRC),
    '勤務表+暦を毎描画で作り直しています(札が全部描き直しになります)',
  );
});

// ----------------------------------------------------------------------------
// W06 効き目(祝日を入れる前 / 入れた後)
// 🚨 画面が出す数字は、必ずこの純関数から出す(同じ数字を2つの計算から出さない)。
// ----------------------------------------------------------------------------

test('W06 2026年9月: 祝日を入れる前 22日 → 入れた後 19日', () => {
  const before = monthSummary({ year: 2026, month: 9, calendar: null });
  assert.equal(before.workdays, 22, '登録が空の時の営業日が今までと違う');

  const sep = {
    days: {
      '2026-09-21': { type: 'off', label: '敬老の日' },
      '2026-09-22': { type: 'off', label: '国民の休日' },
      '2026-09-23': { type: 'off', label: '秋分の日' },
    },
  };
  const after = monthSummary({ year: 2026, month: 9, calendar: sep });
  assert.equal(after.workdays, 19, '祝日3日を入れても営業日が減っていない');
  assert.equal(after.diff, -3);
  assert.equal(after.calendarDays, 30);

  // 休日出勤(9/26 土)を足すと1日戻る。
  const withWork = { days: { ...sep.days, '2026-09-26': { type: 'work', label: '休日出勤' } } };
  assert.equal(monthSummary({ year: 2026, month: 9, calendar: withWork }).workdays, 20);

  // ロスターが見る「今週7日」も同じ暦で数える。9/21(月)〜9/27(日)は 2日しか動かない。
  assert.equal(countWorkdaysBetween({ from: '2026-09-21', to: '2026-09-27', calendar: null }), 5);
  assert.equal(countWorkdaysBetween({ from: '2026-09-21', to: '2026-09-27', calendar: sep }), 2);
  assert.equal(isWorkdayYmd('2026-09-21', sep), false);
  assert.equal(isWorkdayYmd('2026-09-24', sep), true);
});
