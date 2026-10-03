// =============================================================================
// 🚫🏭 本番を読む道具は、CI と 出荷前の確かめ の中では動かさない(データを取る前に止める)
// -----------------------------------------------------------------------------
// 使い方: 本番へ繋ぐ道具の **最初の import** にこの1行を置く(順番を変えない事。後ろの import より先に評価される)。
//     import './no-prod-in-ci.mjs';
//
// 止める時(どちらか):
//   ・CI の中(CI が真 / GITHUB_ACTIONS=true)
//   ・外への通信の見張り(net-guard.mjs)の中 = check-all や CI の試験の step から起こされた
// かつ、次のどれか:
//   ・--prod / --live を付けた(本番を読む切り替え)
//   ・いつも本番を見る道具(ALWAYS_PROD。backup-daily は --run の時だけ)
// → exit 2。firebase も本番の設定もまだ何も読んでいない時点で止まる。
//
// ⚠ 抜け道の環境変数は作らない。CI で本番を見たい時は、人が手元で --prod を付けて走らせる。
// ⚠ 4アプリ共通の同じファイル。直す時は4つとも直す事。
// =============================================================================

import path from 'node:path';

export const PROD_SWITCHES = ['--prod', '--live'];
// いつも本番を見る道具(4アプリ分の和)。値 = その切り替えが付いた時だけ本番(null = いつも)
export const ALWAYS_PROD = {
  'smoke-prod.mjs': null,
  '_smoke-prod.mjs': null,
  'sweep-diagram-orphans.mjs': null,
  'backup-daily.mjs': '--run',
};

const truthy = (v) => v !== undefined && v !== null && String(v) !== '' && !/^(0|false|no|off)$/i.test(String(v));

export function inCI(env = process.env) {
  return truthy(env.CI) || String(env.GITHUB_ACTIONS || '') === 'true';
}

export function underNetGuard() {
  return !!globalThis[Symbol.for('inspection.netGuard')]?.active;
}

export function prodRequested(argv = process.argv) {
  const args = argv.slice(2);
  if (args.some((a) => PROD_SWITCHES.includes(a) || PROD_SWITCHES.some((s) => a.startsWith(`${s}=`)))) return true;
  const base = path.basename(String(argv[1] || ''));
  if (Object.prototype.hasOwnProperty.call(ALWAYS_PROD, base)) {
    const sw = ALWAYS_PROD[base];
    return sw === null || args.includes(sw);
  }
  return false;
}

export function refuseProdInCI({ argv = process.argv, env = process.env } = {}) {
  if (!prodRequested(argv)) return false;
  const why = inCI(env) ? `CI の中(CI=${env.CI ?? ''} GITHUB_ACTIONS=${env.GITHUB_ACTIONS ?? ''})`
    : underNetGuard() ? '出荷前の確かめ / CI の試験の中(外への通信の見張りが掛かっている)' : null;
  if (!why) return false;
  console.error(`🚫 [no-prod-in-ci] 本番を読む道具は ${why} では動かしません。データを取る前に止めました。`);
  console.error(`   道具: ${path.basename(String(argv[1] || ''))}  引数: ${argv.slice(2).join(' ') || '(なし)'}`);
  console.error('   本番を見る必要がある時は、人が手元で(CI の外で)走らせてください。');
  process.exit(2);
}

refuseProdInCI();
