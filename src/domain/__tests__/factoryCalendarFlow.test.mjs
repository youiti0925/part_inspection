// ============================================================================
// 📅🩸 工場の暦(祝日表)が「本当に **値として** 流れているか」の見張り(部品検査アプリ)
// ----------------------------------------------------------------------------
// 🚨 なぜ既にある factoryCalendarWiring.test.mjs と別に要るか。2026-09-02 実測:
//   祝日表は繋いだ。試験は全部緑。ところが **次の2通りで壊しても緑のままだった**。
//     P2 共通の棚から読むのをやめる   setFactoryCalendar(null)        → 祝日が丸ごと死ぬ
//     P3 ロスターが暦を捨てる         isWorkdayYmd(ymd, null)         → 平均在席が祝日を数える
//   前の見張りは `body.includes('isWorkdayYmd(')` `SRC.includes('setFactoryCalendar(')`
//   のように **文字が在るか** しか見ていなかった。文字は在るのに値が流れない、が通っていた。
//   さらに B3(鍵の形の $ を1文字消す)も3アプリ共通の穴だった。
//
// 🚨 だからここは2本立てにする。
//   ① App.jsx から **本物の関数を切り出して実際に走らせ**、答えが変わる事(P1〜P4)。これが主。
//   ② 画面(JSX)は import できないので、**その場所に入っている式** を取り出して
//      死んだ値(null / {} / [])でない事を見る(P5〜P7)。文字の有無は見ない。
//
// 🚨 この見張りは わざと壊して赤を見てから置いた。各試験の頭に
//   「どこをどう戻すと落ちるか」を書いてある。書いていない試験は信用しない事。
// ⚠ 時計を使わない。「今日」は必ず試験が ms で渡す。
// ⚠ App.jsx は CRLF。当て込みが空振りしないよう、読んだ直後に \r を落とす。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isYmd, normalizeCalendar, isWorkdayYmd, makeIsWorkday, monthSummary } from '../factoryCalendar.js';
import { sliceConst, callsOf, jsxPropValues, isDeadExpr, gitignoreHits, buildFromSource, splitTopLevel } from './flowScan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..', '..');
const APP_JSX = path.join(APP_ROOT, 'src', 'App.jsx');
const SRC = fs.readFileSync(APP_JSX, 'utf8').replace(/\r\n/g, '\n');

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// 2026年9月の実際の祝日。敬老の日(月)・国民の休日(火)・秋分の日(水)が3日続く。
const SEP3 = Object.freeze({
  days: {
    '2026-09-21': { type: 'off', label: '敬老の日' },
    '2026-09-22': { type: 'off', label: '国民の休日' },
    '2026-09-23': { type: 'off', label: '秋分の日' },
  },
});
const SEP1 = Object.freeze({ days: { '2026-09-21': { type: 'off', label: '敬老の日' } } });
const 土出勤 = Object.freeze({ days: { '2026-09-19': { type: 'work', label: '休日出勤' } } });

// ============================================================================
// P0 自己試験 — 道具が本物のコードを噛んでいるか
// ============================================================================

test('P0-a 死んだ値の見分け(null を「置いた」のは、引数を「落とした」のと同じ)', () => {
  for (const s of ['null', 'undefined', 'void 0', '{}', '{ }', '[]', '0', "''", '""', 'false', '(null)', '']) {
    assert.equal(isDeadExpr(s), true, `死んだ値なのに生きていると答えた: ${s}`);
  }
  for (const s of ['factoryCalendar', 'settings?.factoryCalendar', 'cal || null', 'makeIsWorkday(cal)']) {
    assert.equal(isDeadExpr(s), false, `生きた式なのに死んでいると答えた: ${s}`);
  }
  const [c] = callsOf('const x = f(a, g(b, c), "カンマ, 入り", null);', 'f');
  assert.deepEqual(c.args, ['a', 'g(b, c)', '"カンマ, 入り"', 'null']);
  assert.equal(splitTopLevel('').length, 0);
});

test('P0-b 実物の src/App.jsx を読んでいる(作り物ではない)', () => {
  assert.ok(SRC.length > 200000, `App.jsx が小さすぎる(${SRC.length}文字)。読む場所を間違えている`);
  assert.ok(sliceConst(SRC, 'rosterAdjustedAvailable'), '実コードからロスターの関数を切り出せない');
  assert.ok(sliceConst(SRC, 'computeElapsedWorkSeconds'), '実コードから経過時間の関数を切り出せない');
});

test('P0-z この見張りの部品が .gitignore に飲み込まれていない', () => {
  // 🚨 2026-09-02 実測: 道具を `_flowScan.mjs` の名前で置いたら .gitignore の `_*.mjs` に当たり、
  //   3アプリとも **git に載らなかった**。そのままコミットすると次の人の手元でも CI でも
  //   import が失敗して、この見張り一式が丸ごと動かない(しかも誰も気付かない)。
  const gi = fs.existsSync(path.join(APP_ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(APP_ROOT, '.gitignore'), 'utf8') : '';
  for (const f of ['src/domain/__tests__/flowScan.mjs', 'src/domain/__tests__/factoryCalendarFlow.test.mjs']) {
    assert.ok(fs.existsSync(path.join(APP_ROOT, f)), `${f} が無い`);
    assert.deepEqual(gitignoreHits(gi, f), [], `🚨 ${f} が .gitignore に当たっている(git に載らない)`);
  }
});

// ============================================================================
// P1〜P4 本物の道を1回通す。**答えが変わる事**を見る
// ============================================================================

test('P1 [P3] 平均在席 — App.jsx の本物を切り出して走らせる(祝日を人の平均に混ぜない)', () => {
  // 🚨 戻すと落ちる所: App.jsx の `isWorkdayYmd(ymd, factoryCalendar)` を
  //    `isWorkdayYmd(ymd, null)` にすると、この試験が赤になる。
  //    ⚠ 前の見張りは `body.includes('isWorkdayYmd(')` だったので緑のままだった。
  const f = buildFromSource(SRC,
    ['rymd', 'rosterStatusOf', 'rosterDayStats', 'rosterAdjustedAvailable'], { isWorkdayYmd });

  const 名前 = ['田中', '佐藤', '鈴木', '高橋'];
  const 月曜 = at(2026, 9, 21);                    // 敬老の日(月)
  const 日曜 = at(2026, 9, 27);
  // 9/21(月)だけ2人休み。他の日は全員出勤。
  const settings = { workerRoster: { '2026-09-21': { 田中: 'off', 佐藤: 'off' } } };

  const なし = f(settings, 名前, 月曜, 日曜, 4, null);
  assert.equal(なし.days, 5, '暦なしの営業日が5日でない(前提が崩れている)');
  assert.equal(なし.avg, (2 + 4 + 4 + 4 + 4) / 5, '暦なしの平均が今までと違う');

  const あり = f(settings, 名前, 月曜, 日曜, 4, SEP3);
  assert.equal(あり.days, 2, '🚨 祝日3日を登録しても営業日が5日のまま(暦が捨てられている)');
  assert.equal(あり.avg, 4, '🚨 誰も居ない祝日を人の平均に混ぜている(処理能力を低く見せる)');
  assert.equal(あり.anyEntry, false, '祝日の休みを「人の休み」として数えている');

  // 休日出勤も同じ道で効く(片道の直しにしない)
  assert.equal(f(settings, 名前, at(2026, 9, 19), at(2026, 9, 19), 4, null).days, 0, '土曜は元から数えない');
  assert.equal(f(settings, 名前, at(2026, 9, 19), at(2026, 9, 19), 4, 土出勤).days, 1,
    '🚨 休日出勤を登録した土曜を数えていない');
});

test('P2 [P3] 経過時間の時計 — App.jsx の本物を切り出して走らせる', () => {
  // 🚨 戻すと落ちる所: App.jsx の `const factoryCalendar = sch.factoryCalendar || null;` を
  //    `= null;` にする / `isWorkdayYmd(…, calWithBase)` を `null` にすると赤になる。
  const f = buildFromSource(SRC,
    ['DEFAULT_WORK_SCHEDULE', 'timeStrToMinutes', 'computeElapsedWorkSeconds'], { isWorkdayYmd });

  const 月 = [at(2026, 9, 21, 8, 30), at(2026, 9, 21, 17, 0)];
  assert.equal(f(月[0], 月[1], null, true), 26400, '暦なしの答えが今までと違う(前提が崩れている)');
  assert.equal(f(月[0], 月[1], { factoryCalendar: SEP1 }, true), 0,
    '🚨 敬老の日を登録したのに、その日を勤務時間として数えている');

  const 土 = [at(2026, 9, 19, 8, 30), at(2026, 9, 19, 17, 0)];
  assert.equal(f(土[0], 土[1], null, true), 0, '土曜は元から数えない');
  assert.equal(f(土[0], 土[1], { factoryCalendar: 土出勤 }, true), 26400,
    '🚨 休日出勤を登録した土曜を数えていない(片道の直しになっている)');

  // 週の形の持ち主は勤務表のまま(暦は登録した日だけを上書きする)
  assert.equal(f(土[0], 土[1], { daysPerWeek: 6 }, true), 26400, '週6日の勤務表で土曜が数えられていない');
});

test('P3 [B3] 鍵の形 — 通ってはいけない例で登録が「効いたふり」をしない', () => {
  // 🚨 戻すと落ちる所: factoryCalendar.js の YMD_RE から末尾の $ を1文字消すと赤になる。
  //    $ が無いと '2026-09-21T00:00:00.000Z' が鍵として通り、保存はされるのに
  //    9/21 は営業日のまま = **登録しても黙って効かない**。
  for (const bad of ['2026-09-21T00:00:00.000Z', '2026-09-2199', '2026-09-21 ', '2026-09-21x', ' 2026-09-21', '2026-9-1']) {
    assert.equal(isYmd(bad), false, `🚨 鍵として通してはいけない形を通している: ${JSON.stringify(bad)}`);
  }
  for (const ok of ['2026-09-21', '2028-02-29', '2026-12-31']) assert.equal(isYmd(ok), true, ok);

  const isoで登録 = { days: { '2026-09-21T00:00:00.000Z': { type: 'off', label: '敬老の日' } } };
  assert.equal(Object.keys(normalizeCalendar(isoで登録).days).length, 0, '読めない鍵を登録として数えている');
  assert.equal(monthSummary({ year: 2026, month: 9, calendar: isoで登録 }).workdays, 22);
  assert.equal(monthSummary({ year: 2026, month: 9, calendar: SEP3 }).workdays, 19);
});

test('P4 壊れた値・年ごとの束・空の登録(本物の道で確かめる)', () => {
  // 🚨 戻すと落ちる所:
  //   ・normalizeEntry の `return null;` を `{ type: DAY_OFF }` にする(壊れた1件で工場が休みになる)
  //   ・rawDaysOf から年の鍵をほどく行を消す(最終検査と同じ形で来た暦が黙って0件になる)
  const f = buildFromSource(SRC,
    ['rymd', 'rosterStatusOf', 'rosterDayStats', 'rosterAdjustedAvailable'], { isWorkdayYmd });
  const 名前 = ['田中'];
  const 週 = [at(2026, 9, 21), at(2026, 9, 27)];

  const こわれた = { days: { '2026-09-21': 'なんだこれ', '2026-09-22': { type: 123 }, '2026-09-23': null } };
  assert.equal(Object.keys(normalizeCalendar(こわれた).days).length, 0, '読めない値を登録として数えている');
  assert.equal(f({}, 名前, 週[0], 週[1], 1, こわれた).days, 5, '🚨 壊れた値で工場を休みにしている');

  const 年ごと = { 2026: SEP3, 2027: { days: { '2027-01-01': { type: 'off', label: '元日' } } } };
  assert.equal(f({}, 名前, 週[0], 週[1], 1, 年ごと).days, 2, '🚨 年ごとの束をほどけていない(祝日が黙って消える)');
  assert.equal(isWorkdayYmd('2027-01-01', 年ごと), false, '翌年ぶんが黙って消えている');
  assert.equal(makeIsWorkday(年ごと)('2026-09-21'), false, '畳んだ判定が年の束を読めていない');

  // 登録が空なら今までと1ミリも同じ
  for (const 空 of [null, undefined, {}, [], { days: {} }, 'こわれた', 0]) {
    assert.equal(f({}, 名前, 週[0], 週[1], 1, 空).days, 5, `登録が空(${JSON.stringify(空)})なのに答えが動いた`);
  }
});

// ============================================================================
// P5〜P7 画面(JSX) — その場所に入っている **式** を見る
// ============================================================================

test('P5 [P2] 共通の棚から読む道が生きている(暦が一生 null にならない)', () => {
  // 🚨 戻すと落ちる所: `setFactoryCalendar((data && data.factoryCalendar) || null)` を
  //    `setFactoryCalendar(null)` にする / 購読を消すと赤になる。
  //    ⚠ 前の見張りは includes('setFactoryCalendar(') だったので緑のままだった。
  assert.ok(/watchDoc\(\s*CONTACT_SHARED_NS\s*,\s*'settings'\s*,\s*'config'/.test(SRC),
    '🚨 共通の棚(settings/config)を購読していない。暦が一生 null のままになる');

  const 入れる = callsOf(SRC, 'setFactoryCalendar');
  assert.ok(入れる.length >= 1, '🚨 読んだ暦をどこにも入れていない');
  const 生きている = 入れる.filter((c) => !isDeadExpr(c.args[0] || '') && /\bdata\b/.test(c.args[0] || ''));
  assert.ok(生きている.length >= 1,
    '🚨 暦に入れているのが「購読した中身」ではない(死んだ値・作り物を入れている): '
    + 入れる.map((c) => `${c.line}: setFactoryCalendar(${(c.args[0] || '').slice(0, 60)})`).join(' / '));

  // 🚨 このアプリは登録しない(共通の棚へ書く道を作らない)
  const 書く道 = SRC.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('CONTACT_SHARED_NS') && /\.save\(|\.setFields\(|\.remove\(|setDoc\(|updateDoc\(|deleteDoc\(/.test(l))
    .map(([n, l]) => `${n}: ${l.trim()}`);
  assert.deepEqual(書く道, [], '部品検査アプリから共通の棚へ書く道ができている(登録は製品検査/最終検査だけ)');
});

test('P6 配り口・渡し口が生きた値である(死んだ値を配っていない)', () => {
  // 🚨 戻すと落ちる所: <ProgressOverviewView … factoryCalendar={null}> /
  //    <WorkScheduleContext.Provider value={null}> にすると赤になる。
  const 渡し = jsxPropValues(SRC, 'factoryCalendar');
  assert.ok(渡し.length >= 1, `🚨 暦を画面へ渡している所が ${渡し.length}箇所しかない`);
  for (const v of 渡し) {
    assert.equal(isDeadExpr(v.expr), false,
      `🚨 ${v.line}行目 factoryCalendar={${v.expr}} が死んだ値(その画面だけ祝日が効かない)`);
  }

  const i = SRC.indexOf('<WorkScheduleContext.Provider');
  assert.notEqual(i, -1, '勤務表を配る所が無い');
  const 値 = jsxPropValues(SRC.slice(i, i + 300), 'value')[0];
  assert.ok(値 && !isDeadExpr(値.expr), `🚨 勤務表の配り口が死んだ値: value={${値 ? 値.expr : '無し'}}`);
  const 宣言 = sliceConst(SRC, 値.expr);
  assert.ok(宣言, `配っている ${値.expr} の宣言が見つからない`);
  // 🚨 毎描画で作り直さない(2026-08-30「札の描き直し 370枚→2枚」と同じ穴)
  const [memo] = callsOf(宣言, 'useMemo');
  assert.ok(memo, `🚨 ${値.expr} を毎描画で作り直している(札が全部描き直しになる)`);
  // 🚨🚨 見る所は「作る式そのもの(第1引数)」。
  //   2026-09-02 実測: ここを `/factoryCalendar/.test(宣言)` にしていたら、
  //   作る式から暦を外しても **依存の並び(第2引数)に名前が残っている** ので緑のままだった。
  //   = 経過時間の時計に祝日が1日も届かないのに、見張りは何も言わない。
  assert.match(memo.args[0] || '', /factoryCalendar/,
    `🚨 ${値.expr} を作る式に暦が入っていない(依存にだけ名前が残っている = 時計に祝日が届かない)`);
  assert.match(memo.args[1] || '', /factoryCalendar/,
    `🚨 ${値.expr} の作り直しの合図に暦が入っていない(登録しても画面が古い値を使い回す)`);
});

test('P7 暦を使う呼び出しに、暦を「中身つきで」渡している', () => {
  // 🚨 戻すと落ちる所: rosterAdjustedAvailable(… , baselineWorkers, null) にすると赤になる
  //    (引数を落とさなくても)。⚠ 引数の **数** ではなく **中身** を見ている。
  let 見た = 0;
  const 死んでいる = [];
  for (const c of callsOf(SRC, 'rosterAdjustedAvailable')) {
    if (c.args.length <= 5) continue;                     // 定義行 / 既定に任せる呼び出し
    if (/^[A-Za-z0-9_$]+\s*=/.test(c.args[5])) continue;  // 既定値つきの定義行
    見た++;
    if (isDeadExpr(c.args[5])) 死んでいる.push(`src/App.jsx:${c.line} rosterAdjustedAvailable(… , ${c.args[5]})`);
  }
  assert.ok(見た >= 1, `🚨 ロスターへ暦を渡している呼び出しが1件も無い(${見た}件)`);
  assert.deepEqual(死んでいる, [],
    '🚨 暦を渡しているつもりで死んだ値を渡している:\n  ' + 死んでいる.join('\n  '));
});
