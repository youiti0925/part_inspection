// 📌 営業日ごとの札を「押すと切り替わる」の見張り(2026-09-17)
//   清水さんの言葉「両方で働ける人のやつで、営業日ごとボタンでどっちで働くか切り替えれればいいけど、
//   そうでもなく、どこで切り替えれるの？謎すぎる」
//
// 🚨 この見張りが守る事(狙い):
//   B-1 札を押すと 親の保存の口(onSaveWeekly)へ { name, weekly, days } が渡る(押しても何も起きない、を防ぐ)
//   B-2 その日が 何で決まったか(fixedBy)を 純関数へ渡している(渡さなければ理由が「毎週」に化ける)
//   B-3 札の見た目が 3通り('day'/'1'/'0')に分かれている(この日だけ／毎週／負荷)
//   B-4 「この日だけ」の1文を 純関数(dayRuleText)が作っている(画面で文を組み立てない)
//   B-5 札は 44px 以上・12px 以上、px 直書きが無い
//   B-6 製品と最終で **同じ形**(違ってよいのは inputKey の扱いだけ)
//
// 🚨 壊し方(赤になる事を確かめる): onSaveWeekly({ name, weekly の行を消す → B-1 が赤。
//   allocateSharedWorker の fixedBy を消す → B-2 が赤。'day' を '1' にする → B-3 が赤。
//   dayRuleText( の呼びを消す → B-4 が赤。min-h-11 を外す → B-5 が赤。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'opsim', 'SharedWorkerPlan.jsx');
const code = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

test('B-1 日の札を押すと 親の保存の口へ { name, weekly, days } が渡る', () => {
  assert.ok(/data-opsim-shared-day=\{d\.ymd\}/.test(code), '日の札の印が無い');
  assert.ok(code.includes('onSaveWeekly({ name, weekly: (weeklyRule && weeklyRule.weekly) || {}, days });'),
    '押しても保存の口へ days が渡らない(押しても何も起きない)');
  assert.ok(code.includes("const next = cur === '' ? hereApp : (cur === hereApp ? thereApp : '');"),
    "この日だけの決めが '' → ここ → 向こう → '' の順に回っていない");
  assert.ok(code.includes('if (next) days[d.ymd] = next; else delete days[d.ymd];'),
    '決めない に戻した時に その日の決めを消していない');
  assert.ok(code.includes("if (typeof onSaveWeekly !== 'function') { setOpenDay(openDay === d.ymd ? '' : d.ymd); return; }"),
    '保存の口が無い時に 今までどおり理由の開け閉めだけ、になっていない');
  assert.ok(code.includes('setOpenDay(d.ymd);'), '押した後に理由の箱を出していない');
});

test('B-2 その日が何で決まったか(fixedBy)を 純関数へ渡している', () => {
  assert.ok(/import \{[\s\S]*?fixedByFromWeekly[\s\S]*?\} from '\.\.\/domain\/operationsSimulation\/sharedWorkerPlan\.js';/.test(code),
    'fixedByFromWeekly を読んでいない');
  assert.ok(code.includes('const fixedBy = React.useMemo('), 'fixedBy を作っていない');
  assert.ok(code.includes('fixedByFromWeekly({ rule: weeklyRule, ymds: docDayKeys(hereDoc) })'),
    'fixedBy を純関数で作っていない');
  assert.ok(/allocateSharedWorker\(\{[\s\S]*?fixedBy,[\s\S]*?\}\)/.test(code),
    'allocateSharedWorker へ fixedBy を渡していない(渡さなければ1行も動かない)');
  assert.ok(/\}\), \[name, hereDoc, thereDoc, mode, priority, minBlockDays, nowMs, hereLabel, thereLabel, fixed, fixedBy\]\);/.test(code),
    'fixedBy が memo の材料に入っていない(押しても計算し直さない)');
});

test('B-3 札の見た目が 3通り(この日だけ／毎週／負荷)に分かれている', () => {
  assert.ok(code.includes("const byDay = d.whyKey === 'day';"), 'この日だけ の判定が無い');
  assert.ok(code.includes("const byWeekly = d.whyKey === 'weekly';"), '毎週 の判定が無い');
  assert.ok(code.includes("data-opsim-shared-fixed={byDay ? 'day' : (byWeekly ? '1' : '0')}"),
    '札の印が 3通りになっていない');
  assert.ok(code.includes("${byDay ? 'border-4' : (byWeekly ? 'border border-dashed' : 'border-2')}"),
    '枠が 太い/点線/実線 の3通りになっていない');
  assert.ok(code.includes('{byDay ? <span className="mr-0.5">📌</span> : null}'),
    'この日だけ の札に 📌 が無い');
  assert.ok(code.includes('押すと この日だけ ${hereLabel} → ${thereLabel} → 決めない の順に変わります（両方の工場の盤にすぐ効きます）'),
    '札の title が 押すと何が起きるかを言っていない');
});

test('B-4 「この日だけ」の1文は 純関数が作る。説明文に 3通りの読み方が在る', () => {
  assert.ok(/import \{[\s\S]*?dayRuleText[\s\S]*?\} from '\.\.\/domain\/operationsSimulation\/sharedWorkerPlan\.js';/.test(code),
    'dayRuleText を読んでいない');
  assert.ok(code.includes('const dayRuleLine = dayRuleText({'), '画面で文を組み立てている(純関数を呼んでいない)');
  assert.ok(code.includes('rule: weeklyRule, ymds: plan.days.map((d) => d.ymd), hereApp, hereLabel, thereLabel,'),
    'dayRuleText へ この期間の日々を渡していない');
  assert.ok(code.includes('data-opsim-day-rule-text={dayRuleLine}'), '1文の印が無い');
  assert.ok(code.includes('太い枠＋📌＝この日だけ決めた日／点線の枠＝②の毎週で決まった日／実線の枠＝③の負荷で決めた日／「—」＝決まっていません'),
    '札の下の説明文が 3通りの読み方になっていない');
  assert.ok(code.includes('（③の営業日の札で 1日だけ変えられます）'), '②の見出しが ③との強さの順を言っていない');
  assert.ok(code.includes('日の札を押すと その日だけ決められます（残りは負荷で振り分けます）'), '③の見出しが 押せる事を言っていない');
});

test('B-5 札は 44px 以上・12px 以上。px 直書きが無い', () => {
  assert.ok(/data-opsim-shared-day=\{d\.ymd\}[\s\S]{0,1600}?className=\{`fi-tap-text min-h-11 rounded-lg px-2 font-bold/.test(code),
    '日の札が 44px/12px 未満になり得る');
  const px = code.match(/\[[0-9.]+px\]/g) || [];
  assert.deepEqual(px, [], `px 直書きが在る: ${px.join(',')}`);
});

// 🚨 2アプリで同じ文言は片方だけ変えない(決まり)。違ってよいのは inputKey の扱いだけ。
//   丸ごと比べると inputKey まわりのコメントの差で毎回赤になるので、
//   **作業Bで足した所の文言** が相手のアプリにも1字違わず在るかを数える。
const SAME_IN_BOTH = [
  'fixedByFromWeekly',
  'dayRuleText',
  'const fixedBy = React.useMemo(',
  'onSaveWeekly({ name, weekly: (weeklyRule && weeklyRule.weekly) || {}, days });',
  "data-opsim-shared-fixed={byDay ? 'day' : (byWeekly ? '1' : '0')}",
  "${byDay ? 'border-4' : (byWeekly ? 'border border-dashed' : 'border-2')}",
  'data-opsim-day-rule-text={dayRuleLine}',
  '太い枠＋📌＝この日だけ決めた日／点線の枠＝②の毎週で決まった日／実線の枠＝③の負荷で決めた日／「—」＝決まっていません',
  '押すと この日だけ ${hereLabel} → ${thereLabel} → 決めない の順に変わります（両方の工場の盤にすぐ効きます）',
  '（③の営業日の札で 1日だけ変えられます）',
  '日の札を押すと その日だけ決められます（残りは負荷で振り分けます）',
];

test('B-6 製品と最終で同じ文言・同じ形(違ってよいのは inputKey の扱いだけ)', () => {
  const OTHER = /golden-meteoroid/i.test(ROOT)
    ? 'C:/Users/anrw3/product-inspection-app/src/opsim/SharedWorkerPlan.jsx'
    : 'C:/Users/anrw3/.gemini/antigravity/playground/golden-meteoroid/src/opsim/SharedWorkerPlan.jsx';
  assert.ok(fs.existsSync(OTHER), `相手のアプリの写しが読めない: ${OTHER}`);
  const other = fs.readFileSync(OTHER, 'utf8').replace(/\r\n/g, '\n');
  for (const s of SAME_IN_BOTH) {
    assert.ok(code.includes(s), `こちらのアプリに無い: ${s}`);
    assert.ok(other.includes(s), `相手のアプリに無い(片方だけ直した): ${s}`);
  }
  // inputKey の扱いだけは違ってよい(製品=prop / 最終=baseRun から作る)。それ以外の行数は揃える。
  const lines = (t) => t.split('\n').length;
  assert.ok(Math.abs(lines(code) - lines(other)) <= 12,
    `2つの写しの行数が離れすぎている(${lines(code)} 対 ${lines(other)})`);
});
