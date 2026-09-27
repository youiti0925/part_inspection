// ============================================================================
// ⚠部品: 製品の写し。部品では sendCompleteOnce が src/contact/ContactHub.jsx にあるので、既定の読み先だけ変えた。
// 🚨 完了連絡の窓は「何も送っていない時」に閉じてはいけない (2026-08-31 夜)
// ----------------------------------------------------------------------------
// 何が起きていたか(実測):
//   src/App.jsx の sendCompleteOnce は、次の2つで **return true** を返していた。
//     ① 台数が残りを超えている(canSendComplete 不合格)
//     ② 連絡先グループが未設定
//   呼び出し側は `const ok = await sendComplete(...); if (ok) setCompletePrompt(null);`。
//   つまり **1バイトも送っていないのに窓が閉じる**。
//   閉じるとその指図は自動プロンプトが二度と出ず(completeSeenRef が進む)、
//   📦の復旧一覧も sentQtyOf>0 が条件なので載らない ＝ **連絡する道が消える**。
//
//   2026-08-21「モーダルの背景タップで取り消せない確定をするな
//   (最終検査の完了連絡が68件中68件とも飛んでいなかった)」と同じ族。
//
// ⚠ 上の2つ(別の人が「連絡しない」を選んだ / 既に全数連絡済み)は話が片付いているので
//   閉じてよい。ここで見るのは「**人が直せば送れる**のに閉じてしまう」2枝だけ。
//
// ⚠⚠ **わざと壊したら赤になる事を、この試験の中で毎回確かめる**(C03/C04)。
//   直す前の形(return true)へ戻した文字列を同じ物差しに当てて、落ちる事を見る。
//   物差しが壊れていたら「合格」は嘘になるので。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canSendComplete, remainingQtyOf } from '../completeSplit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.PRODUCT_APP_SRC || process.env.APP_SRC
  || path.resolve(HERE, '..', '..', 'contact', 'ContactHub.jsx'); // 部品: 完了連絡は ContactHub.jsx にある

/** `{` から対応する `}` まで。文字列/テンプレートの中は数えない。 */
const braceClose = (src, openIdx) => {
  let depth = 0, q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
};

/** sendCompleteOnce の中身だけを切り出す(別の関数の return を数えない為)。 */
export const sendCompleteBody = (src) => {
  const m = /const\s+sendCompleteOnce\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return src.slice(open, braceClose(src, open) + 1);
};

/**
 * 🚨 物差し本体。「何も送っていないのに窓を閉じる」枝が在れば findings に出る。
 * @returns {string[]} 空 = 合格
 */
export const windowStaysOpenChecks = (src) => {
  const bad = [];
  const body = sendCompleteBody(src);
  if (!body) return ['sendCompleteOnce が見つからない(名前が変わった?)'];

  // ① 台数が残りを超えている
  const chkLine = body.split('\n').find((l) => /if\s*\(\s*!\s*chk\.ok\s*\)/.test(l));
  if (!chkLine) bad.push('① canSendComplete 不合格の枝(!chk.ok)が見つからない');
  else if (/return\s+true/.test(chkLine)) {
    bad.push('① 台数が残りを超えている枝が return true(何も送っていないのに窓が閉じる)');
  } else if (!/return\s+false/.test(chkLine)) {
    bad.push('① 台数が残りを超えている枝が false を返していない');
  }

  // ② 宛先グループ未設定
  const gLine = body.split('\n').find((l) => /連絡先グループが未設定/.test(l));
  if (!gLine) bad.push('② 宛先グループ未設定の枝が見つからない');
  else if (/return\s+true/.test(gLine)) {
    bad.push('② 宛先グループ未設定の枝が return true(何も送っていないのに窓が閉じる)');
  } else if (!/return\s+false/.test(gLine)) {
    bad.push('② 宛先グループ未設定の枝が false を返していない');
  }

  // ③ 呼び出し側が「true の時だけ閉じる」ままである事
  //   (ここが `setCompletePrompt(null)` の直呼びに変わったら、①②を false にしても意味が無い)
  if (!/const\s+ok\s*=\s*await\s+sendComplete\(/.test(src)
    || !/if\s*\(\s*ok\s*\)\s*setCompletePrompt\(null\)/.test(src)) {
    bad.push('③ 送信ボタンが「返り値が true の時だけ閉じる」形になっていない');
  }
  return bad;
};

const SRC = fs.readFileSync(APP, 'utf8');

// ---------------------------------------------------------------------------
test('C01 何も送っていない2枝(台数超過・宛先未設定)では窓を閉じない', () => {
  assert.deepEqual(windowStaysOpenChecks(SRC), [], `見た所: ${APP}`);
});

test('C02 話が片付いている枝(他の人が「連絡しない」/ 既に全数連絡済み)は今までどおり閉じてよい', () => {
  const body = sendCompleteBody(SRC);
  assert.ok(body, 'sendCompleteOnce が読める');
  // この2つは setCompletePrompt(null) を自分で呼んでから true を返す = 直していない
  assert.match(body, /cn\.declined[\s\S]*?setCompletePrompt\(null\);\s*return true;/);
  assert.match(body, /isFullyNotified\(cur\)[\s\S]*?setCompletePrompt\(null\);\s*return true;/);
});

// --- 🚨 負の対照: わざと直す前の形へ戻したら、この物差しは落ちるか -----------
test('C03 【負の対照】①を return true へ戻すと落ちる', () => {
  const before = SRC.replace(
    'if (!chk.ok) { alert(chk.reason); return false; }',
    'if (!chk.ok) { alert(chk.reason); return true; }');
  assert.notEqual(before, SRC, '差し替えが当たっている(当たらないと negative control が空振りする)');
  const bad = windowStaysOpenChecks(before);
  assert.equal(bad.length, 1, `落ちるはず。実際: ${JSON.stringify(bad)}`);
  assert.match(bad[0], /^① .*return true/);
});

test('C04 【負の対照】②を return true へ戻すと落ちる', () => {
  const before = SRC.replace(
    "if (!g) { alert('連絡先グループが未設定です（連絡タブの「宛先・公開設定」でグループを追加してください）'); return false; }",
    "if (!g) { alert('連絡先グループが未設定です（連絡タブの「宛先・公開設定」でグループを追加してください）'); return true; }");
  assert.notEqual(before, SRC, '差し替えが当たっている');
  const bad = windowStaysOpenChecks(before);
  assert.equal(bad.length, 1, `落ちるはず。実際: ${JSON.stringify(bad)}`);
  assert.match(bad[0], /^② .*return true/);
});

test('C05 【負の対照】呼び出し側が返り値を見ずに閉じるようになったら落ちる', () => {
  const before = SRC.replace(
    'const ok = await sendComplete(completePrompt.lot, sel, completePrompt.qty);',
    'await sendComplete(completePrompt.lot, sel, completePrompt.qty);');
  assert.notEqual(before, SRC, '差し替えが当たっている');
  assert.ok(windowStaysOpenChecks(before).some((b) => /^③/.test(b)));
});

// --- ①の入口(純関数)が「送れない」と言う場面そのもの ------------------------
test('C06 残り2台に3台を送ろうとすると canSendComplete は不合格＋理由を言葉で返す', () => {
  // ⚠parts は **キー付きの入れ物(map)**。配列にすると completePartsOf が旧データ扱いに落ちる。
  const lot = { quantity: 5, completeNotified: { parts: { r1: { id: 'r1', qty: 3, at: 1 } } } };
  assert.equal(remainingQtyOf(lot), 2);
  const chk = canSendComplete(lot, 3);
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, '残りは 2台 です（3台は送れません）');
  // 🚨 理由が空だと、窓は開いたままでも **画面に何も出ない**(黙って閉じないの片割れ)
  assert.ok(chk.reason.length > 3, '止める時は理由が言葉になっている');
});
