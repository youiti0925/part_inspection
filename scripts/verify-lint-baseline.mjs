#!/usr/bin/env node
// =============================================================================
// 🚦 eslint の「今より増やさない」見張り（基準値＝baseline 方式）
// -----------------------------------------------------------------------------
// なぜこれが要るか（2026-08-20）:
//   `npm run check` の1段目が素の `npx eslint src` で、**395件で落ちていた**。
//   直列(&&)なので、後ろの7段（試験・約束・保存の安全・読み書きの枠）が
//   **一度も走っていなかった**。つまり出荷ゲートが丸ごと死んでいた。
//
// 🚨 やってはいけない直し方: 規則を無効にして緑にする事。
//    それをやると「白画面を見つける唯一の網」まで一緒に消える。
//
// ここでの決め方:
//   ① いま在る指摘の数を **規則ごとに** 数えて紙(lint-baseline.json)に書く
//   ② 次からは「その数より **増えたら赤**」。減るのは歓迎（紙を下げてと言う）
//   ③ 🚨ただし下の HARD_ZERO の規則だけは基準値を作らない。**1件でも赤**。
//      ここは白画面を見つける唯一の網なので、1件も溜めさせない。
//
// ⚠この見張り自身の試験は scripts/selftest-lint-baseline.mjs にある。
//   「嘘の合格」を出さない事を毎回確かめてから、この判定を使う事。
// =============================================================================

import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'lint-baseline.json');

// `npm run check` が見ている範囲と **同じ**にする事。
// （eslint . にすると node_modules 込みで数分かかり、誰も回さなくなる）
export const TARGETS = ['src'];

// -----------------------------------------------------------------------------
// 🚨 基準値を作らない規則 = 1件でも赤
//   ここは「ビルドは通るのに本番で白画面になる」を見つける唯一の網。
//   数が0のうちに固定しておかないと、溜まった瞬間に誰も気づけなくなる。
// -----------------------------------------------------------------------------
export const HARD_ZERO = {
  '__PARSING_ERROR__': '🚨 構文エラー。そのファイルは **読み込んだ瞬間に白画面**',
  'no-undef': '🚨 定義されていない名前を読んでいる。**その行を通った瞬間に白画面**',
  'no-use-before-define': '🚨 値が入る前の const を読んでいる。**描画中に白画面**（ビルドも no-undef も通ってしまう）',
};

// ruleId が null の指摘を種類分けする。
// ⚠「構文エラー」と「使われていない eslint-disable」は **全くの別物**なのに
//   どちらも ruleId=null で来る。混ぜると構文エラーが基準値に埋もれる。
export function classifyNullRule(message) {
  if (/Parsing error/i.test(message)) return '__PARSING_ERROR__';
  if (/Unused eslint-disable directive/i.test(message)) return '__UNUSED_DISABLE__';
  return '__OTHER_FATAL__';
}

// eslint の結果を「規則ごとの件数」に畳む
export function tally(results) {
  const out = {};
  for (const f of results) {
    for (const m of f.messages || []) {
      const rule = m.ruleId || classifyNullRule(m.message || '');
      if (!out[rule]) out[rule] = { err: 0, warn: 0 };
      if (m.severity === 2) out[rule].err++; else out[rule].warn++;
    }
  }
  return out;
}

// 指摘の実物（場所つき）を規則ごとに集める。赤の時に「どこか」を出す為。
export function samplesOf(results, rule, limit = 5) {
  const hits = [];
  for (const f of results) {
    for (const m of f.messages || []) {
      const r = m.ruleId || classifyNullRule(m.message || '');
      if (r !== rule) continue;
      hits.push(`${path.relative(ROOT, f.filePath)}:${m.line}  ${String(m.message).split('\n')[0]}`);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

// -----------------------------------------------------------------------------
// 判定の本体。⚠ここは eslint を呼ばない純粋な関数にしてある
//   （見張り自身の試験が、作り物の数字で「嘘の合格」を出さない事を確かめられる為）
// -----------------------------------------------------------------------------
export function compare(current, baseline) {
  const errors = [];   // 赤（出荷を止める）
  const notices = [];  // 減った等のお知らせ（止めない）
  const base = (baseline && baseline.rules) || {};

  // ① まず HARD_ZERO。基準値があろうが無かろうが、1件でも赤。
  for (const [rule, why] of Object.entries(HARD_ZERO)) {
    const cur = current[rule] || { err: 0, warn: 0 };
    const n = cur.err + cur.warn;
    if (n > 0) {
      errors.push({ rule, kind: 'hard-zero', cur: n, base: 0, why });
    }
  }

  // ② 残りの規則を基準値と突き合わせる
  const allRules = new Set([...Object.keys(current), ...Object.keys(base)]);
  for (const rule of allRules) {
    if (HARD_ZERO[rule]) continue; // ①で見た
    const cur = current[rule] || { err: 0, warn: 0 };
    const b = base[rule] || { err: 0, warn: 0 };

    if (cur.err > b.err) {
      errors.push({ rule, kind: 'increased', field: 'err', cur: cur.err, base: b.err,
        why: b.err === 0 ? '🆕 いままで0件だった規則が出た' : `基準値 ${b.err} → いま ${cur.err}（${cur.err - b.err}件 増えた）` });
    }
    if (cur.warn > b.warn) {
      errors.push({ rule, kind: 'increased', field: 'warn', cur: cur.warn, base: b.warn,
        why: b.warn === 0 ? '🆕 いままで0件だった警告が出た' : `基準値 ${b.warn} → いま ${cur.warn}（${cur.warn - b.warn}件 増えた）` });
    }
    if (cur.err < b.err) notices.push(`🎉 ${rule} (error) が ${b.err} → ${cur.err} に減りました`);
    if (cur.warn < b.warn) notices.push(`🎉 ${rule} (warn) が ${b.warn} → ${cur.warn} に減りました`);
  }

  return { errors, notices, ok: errors.length === 0 };
}

export function buildBaseline(current) {
  const rules = {};
  for (const k of Object.keys(current).sort()) {
    if (HARD_ZERO[k]) continue; // 🚨HARD_ZERO は紙に書かない（書いたら緩めた事になる）
    rules[k] = { err: current[k].err, warn: current[k].warn };
  }
  let totalErr = 0, totalWarn = 0;
  for (const v of Object.values(rules)) { totalErr += v.err; totalWarn += v.warn; }
  return {
    '_これは何': '🚦 eslint の指摘を「今より増やさない」為の基準値。scripts/verify-lint-baseline.mjs が使う。',
    '_なぜ在るか': '2026-08-20: npm run check の1段目が eslint 395件で落ち、後ろの7段が一度も走っていなかった。規則を無効にせず、後段を動かす為の紙。',
    '_やってはいけない事': '🚨 赤を消す為にこの数字を上げる事。増えた分は直す。どうしても直せないなら、なぜ増やすのかを人に説明してから上げる事。',
    '_ここに書けない規則': `🚨 ${Object.keys(HARD_ZERO).join(' / ')} は基準値を作らない。1件でも赤。白画面を見つける唯一の網なので緩めない。`,
    '_減った時': 'node scripts/verify-lint-baseline.mjs --update で下げる。下げないと、また増えても気づけない。',
    '_数え方': `対象=${TARGETS.join(', ')}（npm run check と同じ範囲）。規則ごとに error/warning を数える。`,
    '_合計': { err: totalErr, warn: totalWarn },
    // ⚠ toISOString() は UTC なので、日本時間の夕方以降だと前日になる。端末の日付で書く。
    '_更新日': (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })(),
    rules,
  };
}

// -----------------------------------------------------------------------------
export async function runEslint(cwd = ROOT, targets = TARGETS) {
  const eslint = new ESLint({ cwd });
  return eslint.lintFiles(targets);
}

async function main() {
  const update = process.argv.includes('--update');

  const results = await runEslint();
  const current = tally(results);

  let totalErr = 0, totalWarn = 0;
  for (const v of Object.values(current)) { totalErr += v.err; totalWarn += v.warn; }

  console.log('──────────────────────────────────────────────────────────────');
  console.log(`🚦 eslint の見張り（対象: ${TARGETS.join(', ')}）`);
  console.log(`   いまの指摘: error ${totalErr}件 / warning ${totalWarn}件`);
  console.log('──────────────────────────────────────────────────────────────');

  if (update) {
    const next = buildBaseline(current);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`📝 基準値を書き直しました: ${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`   error ${next._合計.err}件 / warning ${next._合計.warn}件 を「ここから増やさない」線にしました。`);
    // 🚨 --update でも HARD_ZERO は見逃さない
    const hz = Object.entries(HARD_ZERO).filter(([r]) => (current[r]?.err || 0) + (current[r]?.warn || 0) > 0);
    if (hz.length) {
      console.log('\n🚨 ただし、基準値を作れない規則が出ています（--update では消せません）:');
      for (const [rule, why] of hz) {
        console.log(`   ❌ ${rule} — ${why}`);
        for (const s of samplesOf(results, rule)) console.log(`      ・${s}`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`❌ 基準値の紙がありません: ${path.relative(ROOT, BASELINE_FILE)}`);
    console.error('   作る: node scripts/verify-lint-baseline.mjs --update');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const { errors, notices, ok } = compare(current, baseline);

  // 規則ごとの内訳を必ず出す（黙って通さない）
  const rows = Object.entries(current).sort((a, b) => (b[1].err + b[1].warn) - (a[1].err + a[1].warn));
  console.log('  規則ごとの内訳（左が いま / 右が 基準値）:');
  for (const [rule, v] of rows) {
    const b = HARD_ZERO[rule] ? { err: 0, warn: 0 } : (baseline.rules?.[rule] || { err: 0, warn: 0 });
    const mark = HARD_ZERO[rule] ? '🚨0固定' : (v.err > b.err || v.warn > b.warn ? '❌増えた' : (v.err < b.err || v.warn < b.warn ? '🎉減った' : '  据置'));
    console.log(`   ${mark}  ${rule.padEnd(34)} err ${String(v.err).padStart(3)}/${String(b.err).padStart(3)}   warn ${String(v.warn).padStart(3)}/${String(b.warn).padStart(3)}`);
  }

  for (const n of notices) console.log(`\n${n}`);
  if (notices.length) {
    console.log('   → 基準値を下げてください: node scripts/verify-lint-baseline.mjs --update');
    console.log('     （下げないと、また増えた時に気づけません）');
  }

  if (ok) {
    console.log('\n✅ eslint: 基準値から増えていません。（構文エラー・未定義の名前・値が入る前の読み取り は 0件）');
    process.exit(0);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('🚦 ❌ 不合格。出荷しないでください。');
  for (const e of errors) {
    console.log(`\n   ❌ ${e.rule} — ${e.why}`);
    for (const s of samplesOf(results, e.rule)) console.log(`      ・${s}`);
  }
  console.log('\n   🚨 直し方は「規則を無効にする」ではありません。増やした行を直してください。');
  console.log('   （どうしても直せない事情があるなら、先に人に説明してから基準値を上げる事）');
  console.log('──────────────────────────────────────────────────────────────');
  process.exit(1);
}

// import された時は走らせない（見張り自身の試験が中身だけ使える為）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
