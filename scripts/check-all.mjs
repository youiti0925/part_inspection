#!/usr/bin/env node
// =============================================================================
// 🚦 出荷ゲート — 全部の段を **最後まで走らせて**、赤い理由を全部出す
// -----------------------------------------------------------------------------
// なぜこれが要るか（2026-08-20 に最終検査で分かった事）:
//   これまで `check` は `A && B && C && …` の直列だった。
//   直列は「**最初に落ちた1つで止まる**」ので、
//     ・1段目の eslint が落ちる
//     → 2段目以降（試験・読み込み待ち・時間取り・保存の安全・読み取りの枠）が
//       **一度も走っていなかった**。
//   つまり「出荷ゲートが在る」と思っていた物が、実際には1段目しか見ていなかった。
//   部品検査の `check` も 2026-08-30 まで `npm test && save-safety && read-budget` の
//   直列で、しかも **3段しか無かった**（読み込み待ち・時間取り・eslint・JSX は無かった）。
//
// 🚨 ここでやっている事は「緩める」事ではありません。
//   ・どの段も、判定そのものは1文字も変えていない
//   ・1つでも赤なら、このゲート全体は **赤のまま**（exit 1）
//   ・変わったのは「**赤を1つ見つけた所で目を閉じない**」事だけ
//
// -----------------------------------------------------------------------------
// ⚠⚠ **最終検査(golden)に在って、部品検査に無い段**（黙って減らさない為に書いておく）
// -----------------------------------------------------------------------------
//   ・「約束と実装の突合」(verify-promises.mjs / selftest-promises.mjs)
//       最終検査・製品検査の見張りは P1〜P32 の約束を **名指しで** 見ている
//       （編集室・動画の書き出し・作業標準の写真・星取表の明文・機番の打ち直し 等）。
//       部品検査には その機能が1つも無く、`docs/約束.md` も無い。
//       中身を空にして段だけ置くと「**何も食べていないのに緑**」になり、
//       2026-08-23 の「見張りが作り物を食っていて緑のまま本番だけ壊れていた」と同じ形になる。
//       🚨 だから **わざと置いていない**。清水さんから部品検査への約束が出たら、
//          `docs/約束.md` を作り、最終検査の verify-promises.mjs を土台に段を足す事。
//   ・「書き込みの枠」(verify-write-budget.mjs)
//       最終検査・製品検査にはあるが、部品検査・司令塔③には無い。移していない。
// =============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BAIL = process.argv.includes('--bail');

const node = process.execPath;
const S = (f) => path.join('scripts', f);

// -----------------------------------------------------------------------------
// 🚨 試験の対象（2段目）。ここが「黙って0件」になると、ゲートは緑のまま何も見なくなる。
// -----------------------------------------------------------------------------
// 実測(2026-08-20): `node --test "src/NOPE/**/*.test.mjs"` は
//   ℹ tests 0 / fail 0 を出して **exit 0** で終わる。
//   つまり フォルダ名を変えた・パターンが壊れた だけで、
//   試験が丸ごと消えても **ゲートは緑になる**。
// → 走らせる前に「本当にファイルが見つかるか」を数え、0件なら赤にする。
const TEST_GLOBS = ['src/domain/**/*.test.mjs', 'src/data/**/*.test.mjs'];

// package.json の `npm test` が見ている対象を読む。
// ⚠人が目で見る約束は必ず抜ける。ここで機械に見させる。
function testGlobsInPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const line = pkg?.scripts?.test || '';
  return (line.match(/"([^"]*\*[^"]*)"/g) || []).map((s) => s.slice(1, -1));
}

// 2段目を走らせる前の関所。exit 0 で「何も試験していない」を通さない。
function verifyTestTargets() {
  let ok = true;

  const inPkg = testGlobsInPackageJson();
  const same = inPkg.length === TEST_GLOBS.length && inPkg.every((g, i) => g === TEST_GLOBS[i]);
  if (!same) {
    ok = false;
    console.log('  ❌ `npm test` と `npm run check` が **違う物を試験しています**（片方だけ直すと、また抜けます）');
    console.log(`     npm test  … ${inPkg.length ? inPkg.join(' , ') : '(読み取れませんでした)'}`);
    console.log(`     check     … ${TEST_GLOBS.join(' , ')}`);
    console.log('     → package.json の "test" と scripts/check-all.mjs の TEST_GLOBS を揃えてください。');
  } else {
    console.log(`  ✅ npm test と同じ対象を見ています … ${TEST_GLOBS.join(' , ')}`);
  }

  for (const g of TEST_GLOBS) {
    let n = -1;
    try { n = [...fs.globSync(g, { cwd: ROOT })].length; } catch (e) { n = -1; console.log(`  ❌ ${g} … 数えられませんでした（${e.message}）`); }
    if (n === 0) {
      ok = false;
      console.log(`  ❌ ${g} … **0件**。node --test は0件でも exit 0 で終わります＝この段が黙って緑になります`);
    } else if (n > 0) {
      console.log(`  ✅ ${g} … ${n}件`);
    } else {
      ok = false;
    }
  }

  if (!ok) {
    console.log('\n  🚨 試験ファイルが見つからないまま走らせると、ゲートは「合格」と言います。ここで止めます。');
  }
  return ok;
}

// -----------------------------------------------------------------------------
// 🚨 段の見張りそのものが在るか。ファイル名を打ち間違えた・消えた時に
//   「走らせられなかったので緑」にしない為（黙って段が抜けるのが一番怖い）。
// -----------------------------------------------------------------------------
// ⚠ 欠けていても **そこで全部を止めない**。止めると、このゲートを作った理由
//   （「赤を1つ見つけた所で目を閉じない」）が消える。欠けた段だけを赤にして、残りは走らせる。
// @returns {Map<number,string>} 現物が無い段の id → 無いファイル名
function missingStageScripts() {
  const missing = new Map();
  for (const stage of STAGES) {
    for (const step of stage.steps) {
      if (!step.cmd) continue;
      const rel = step.cmd[step.cmd.length - 1];
      if (typeof rel !== 'string' || !rel.startsWith('scripts')) continue;
      if (!fs.existsSync(path.join(ROOT, rel))) {
        missing.set(stage.id, rel);
        console.log(`  ❌ ${rel} が在りません（${stage.id}. ${stage.name}）`);
        if (rel.endsWith('verify-map-z-order.mjs')) {
          console.log('     ⏳ これは 2026-08-30 に「移す」と決めた見張りです（親が移植中）。');
          console.log('        現物を scripts/verify-map-z-order.mjs へ置けば、この段はそのまま動きます。');
          console.log('        🚨 置くまでこの段は赤のままにしてあります（黙って抜けるのを防ぐ為）。');
        }
      }
    }
  }
  if (missing.size) console.log('\n  🚨 見張りのファイルが欠けています。その段は「走らせられない＝不合格」にします。');
  else console.log('  ✅ 全部在ります');
  return missing;
}

// -----------------------------------------------------------------------------
// 段の一覧。⚠ここから段を消す時は、必ず理由を書いて人に言う事。黙って消さない。
// -----------------------------------------------------------------------------
const STAGES = [
  {
    id: 1, name: 'eslint（構文エラー・未定義の名前は0固定 / 他は増やさない）',
    steps: [
      { title: '見張り自身の試験', cmd: [node, S('selftest-lint-baseline.mjs')] },
      { title: '判定', cmd: [node, S('verify-lint-baseline.mjs')] },
      // 🚨 2026-08-30 追加: 規則名を書かない eslint-disable を増やさない。
      //   規則名の無い抑制はその行の指摘を全部消すので、上の eslint 判定に穴が開く。
      //   実際に製品側で1件、本物の欠陥（期間が効かない）がこれで隠れていた。
      { title: '見張り自身の試験(規則名なしの抑制)', cmd: [node, S('selftest-bare-eslint-disable.mjs')] },
      { title: '判定(規則名なしの抑制を増やさない)', cmd: [node, S('verify-bare-eslint-disable.mjs')] },
    ],
  },
  {
    id: 2, name: '単体試験（src/domain と src/data）',
    steps: [
      { title: '試験の対象が本当に在るか（0件で黙って緑になるのを止める）', fn: verifyTestTargets },
      { title: 'node --test', cmd: [node, '--test', ...TEST_GLOBS] },
    ],
  },
  { id: 3, name: '読み込み待ちの見張り（読めていないのに書く事故）', steps: [{ title: '自己試験+判定', cmd: [node, S('check-load-guards.mjs')] }] },
  { id: 4, name: '時間取りが消える保存の見張り', steps: [{ title: '自己試験+判定', cmd: [node, S('verify-worktime-guard.mjs')] }] },
  {
    id: 5, name: '保存の安全（順番・投げっぱなし・見えない事）',
    steps: [
      { title: '見張り自身の試験', cmd: [node, S('selftest-save-safety.mjs')] },
      { title: '判定', cmd: [node, S('verify-save-safety.mjs')] },
    ],
  },
  { id: 6, name: '読み取りの枠（無料枠を昼に使い切らないか）', steps: [{ title: '判定', cmd: [node, S('verify-read-budget.mjs')] }] },
  {
    // 🧩 eslint の no-undef は JSXタグ(<Foo/>)の Foo を数えない設定なので、
    //    import忘れ・定義忘れの部品が素通りする。自己試験7本は中で毎回先に走る。
    id: 7, name: 'JSX未定義部品(eslintがJSXタグを見ない穴)',
    steps: [{ title: '自己試験+判定', cmd: [node, S('check-jsx-undefined.mjs')] }],
  },
  {
    // 🗺 2026-08-30: 製品検査で見つかった壊れ方2件が、部品検査にも同じ形で在る。
    //    ①ロットカードの onClick が e.stopPropagation() を呼ばず、親の
    //      onClick={() => onSetMode('map-only')} まで伝わる＝押すと必ず全画面マップへ飛ぶ
    //    ②全画面マップ(fixed inset-0 z-40)がヘッダ(z-50)の下に潜り、上端が押せない
    //      ⚠作業画面も z-50 なので、単純に上げると今度は作業画面を覆う
    //    → 重なりの順番と、押した所が親へ漏れないかを機械で見張る。
    //    現物は 2026-08-30 に置かれた(scripts/verify-map-z-order.mjs)。
    //    ⚠この段を消す時は必ず理由を書いて人に言う事。黙って消さない。
    id: 8, name: '全画面マップの重なり順と、押した所が親へ漏れないか',
    steps: [{ title: '自己試験+判定', cmd: [node, S('verify-map-z-order.mjs')] }],
  },
  {
    // 🔑 2026-08-30: ブラウザに鍵を置く口が部品検査に3か所残っていた
    //    (`?key=${apiKey}` で Google の生成AIを直に叩く形)。
    //    2026-07 の鍵の漏洩と同じ形なので、口ごと塞いで Worker 経由にした。
    //    🚨「いまは .env が空だから安全」は理由にならない。**口の有無**を見張る。
    //    ⚠この見張りは4アプリ共通で使える形にしてある(休眠ファイルは名指しのみ)。
    id: 9, name: 'ブラウザに鍵を置いていないか(公開バンドルへの焼き込み)',
    steps: [{ title: '自己試験+判定', cmd: [node, S('verify-no-browser-api-key.mjs')] }],
  },
  {
    // 🧳 2026-08-30 新設: 古い部品の蔵(持ち越し)。8/17 の事故そのものの手当て。
    //    ⚠ 持ち越した部品の lastSeen は更新されない=何回デプロイしても期限は伸びない。
    //      既定を 90日/1000MB にし、「もうすぐ捨てる」「上限の70%」を捨てる前に名指しで出す。
    //    この段は本物の keep-old-assets.mjs を写して1行ずつ壊し、赤になるかまで見る。
    //    ⚠この段を消す時は必ず理由を書いて人に言う事。黙って消さない。
    id: 10, name: '古い部品の蔵(持ち越し)— わざと壊して赤になるか',
    steps: [{ title: '自己試験+判定', cmd: [node, S('selftest-keep-old-assets.mjs')] }],
  },
  {
    // 🚪 2026-08-30 新設: **読み直しの関所**。ここが今夜いちばん重い。
    //    2026-08-17 に「作業時間が丸ごと消えた(復旧不可)」のは、まだサーバへ送れていない
    //    書き込みを抱えた端末で画面が読み直された事。その翌日 8/18 に足した
    //    「🆕 新しい版が出ました → 切り替える」は `go.onclick = hardReload` で、
    //    **事故と同じ引き金を対策として配っていた**(関所が在ったのは最終検査だけ)。
    //    ⚠この段を消す時は必ず理由を書いて人に言う事。黙って消さない。
    id: 11, name: '版の見張りと 読み直しの関所(送れていない間は押させない)',
    steps: [
      { title: '見張り自身の試験(配線をわざと外す22通り)', cmd: [node, S('selftest-version-watch.mjs')] },
      { title: '判定(配線)', cmd: [node, S('verify-version-watch.mjs')] },
      // 🚨文字を読むだけでは足りない。index.html の中身を **実際に走らせて**、
      //   詰まった時に押せない事・送り終われば押せる事・逃げ道が2段階な事まで見る。
      { title: '判定(実際に走らせる)', cmd: [node, S('verify-reload-gate.mjs')] },
    ],
  },
  {
    // 🕵️🚨 2026-08-31 新設(4アプリ共通)。**根っこの手当て**。
    //   2026-08-30 の1日で「緑なのに何も守っていない」を3件見つけた:
    //   ① 試験の道具がリポジトリに無く、72件の試験が静かに飛んでいた
    //   ② 依存の並び([lots, lotsLoaded])を「門」と数えていた(門を消しても緑)
    //   ③ 製品の check-load-guards が `src/App.firebase.jsx` 決め打ちで、製品にその
    //      ファイルは無い。毎回「対象が無いので省略」→ 終了値0。一度も実コードを食っていなかった。
    //   3件とも形は同じ「**何も読んでいないのに緑**」。それなら読んだ物を数えれば機械で見つかる。
    //   ⚠ 見張りを1本ずつ子で走らせ、読んだファイル数を数える。
    //     実物のブラウザを開く物・通信する物は **走らせない**(本番へ触れない為)。走らせていない物は一覧に出る。
    //   ⚠この段を消す時は必ず理由を書いて人に言う事。黙って消さない。
    id: 12, name: '見張りが本当に実コードを食ったか(緑なのに何も読んでいない物)',
    steps: [{ title: '自己試験+判定', cmd: [node, S('verify-watchdogs-read-code.mjs')] }],
  },
  {
    // 📝🖼 2026-08-31 新設。**取っている≠戻せる**(2026-07-26)の再発を止める。
    //   メモ・お知らせの写真は本体に無く note_images に別置きしてある。その note_images が
    //   控え(doBackup)・復元(restoreAllFromBackup)・移行(exportForPocketBase)の
    //   **3つの一覧のどれにも入っていなかった**。戻すと札だけ残って写真が永久に出ない。
    //   ⚠ここでは **実コード(src/App.jsx)を読んで** 3つの一覧と復元の並びを数える。
    //     エミュレータが無い時でも「何も読まずに緑」にはならない(読む物はソースだから)。
    //   ⚠「控えを取る→消す→戻す→写真が見える」の往復は エミュレータが要るので、この段には
    //     入っていない。手で走らせる事:
    //       FIRESTORE_EMULATOR_HOST=127.0.0.1:8470 AUTH_EMULATOR_PORT=9570 \
    //         node scripts/verify-note-image-roundtrip.mjs
    //   ⚠この段を消す時は必ず理由を書いて人に言う事。黙って消さない。
    id: 13, name: 'メモ/お知らせの写真が 控え・復元・移行の一覧に載っているか',
    steps: [{ title: '判定(実コードの3つの一覧と並び)', cmd: [node, S('verify-note-image-roundtrip.mjs')] }],
  },
];

// -----------------------------------------------------------------------------
// ⚠ scripts/verify-provider.mjs は **この一覧に入れていません**（実測 2026-08-30）。
//   あれは静かに読むだけの見張りではなく、**エミュレータへ実際に繋いで往復する試験**です。
//   FIRESTORE_EMULATOR_HOST が無いと
//     「❌ FIRESTORE_EMULATOR_HOST が未設定です。本番には繋ぎません。中止します。」
//   と言って **exit 0** で終わります。段に入れると、エミュレータを立てていない時に
//   **何も試さないまま緑**になる＝ゲートが1段ぶん嘘をつきます。
//   （最終検査(golden)の check-all にも同じ理由で入っていません）
//   使う時は エミュレータを立ててから手で走らせる事:
//     firebase emulators:start  →  FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 node scripts/verify-provider.mjs
// -----------------------------------------------------------------------------

const results = [];
let stopped = false;

// 🚨 段の見張りが欠けていないか。欠けている段は「走らせられない＝不合格」。
console.log('='.repeat(78));
console.log(`▶ 0/${STAGES.length}  見張りのファイルが全部在るか`);
console.log('='.repeat(78));
const MISSING = missingStageScripts();

for (const stage of STAGES) {
  if (stopped) {
    results.push({ ...stage, status: 'skipped', failedStep: null });
    continue;
  }
  if (MISSING.has(stage.id)) {
    results.push({ ...stage, status: 'fail', failedStep: `見張りの現物が無い（${MISSING.get(stage.id)}）` });
    if (BAIL) stopped = true;
    continue;
  }

  console.log('\n');
  console.log('='.repeat(78));
  console.log(`▶ ${stage.id}/${STAGES.length}  ${stage.name}`);
  console.log('='.repeat(78));

  let status = 'pass';
  let failedStep = null;

  for (const step of stage.steps) {
    // 中で判断する段（外のコマンドを呼ばない物）
    if (typeof step.fn === 'function') {
      console.log(`\n── ${step.title}`);
      let good = false;
      try { good = step.fn() === true; } catch (e) { console.log(`  ❌ 見られませんでした: ${e.message}`); good = false; }
      if (!good) {
        status = 'fail';
        failedStep = step.title;
        break;
      }
      continue;
    }

    const [bin, ...args] = step.cmd;
    console.log(`\n── ${step.title}: ${args.join(' ')}`);
    const r = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', shell: false });
    const code = r.status === null ? 1 : r.status;
    if (code !== 0) {
      status = 'fail';
      failedStep = `${step.title}（${path.basename(args[args.length - 1] || args[0])} が exit ${code}）`;
      break; // 同じ段の中は、先が落ちたらそこで止める（試験が落ちた見張りの判定は信用できない）
    }
  }

  results.push({ ...stage, status, failedStep });
  if (status === 'fail' && BAIL) stopped = true;
}

// -----------------------------------------------------------------------------
// まとめ — 🚨ここが本体。人が読むのはこの表。
// -----------------------------------------------------------------------------
const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skipped');

console.log('\n\n');
console.log('='.repeat(78));
console.log('🚦 出荷ゲート まとめ  （部品検査）');
console.log('='.repeat(78));
for (const r of results) {
  const mark = r.status === 'pass' ? '✅ 合格' : r.status === 'fail' ? '❌ 不合格' : '⏭ 走らせていない';
  console.log(` ${mark}  ${String(r.id).padStart(2)}. ${r.name}`);
  if (r.failedStep) console.log(`         └ 落ちた所: ${r.failedStep}`);
}
console.log('-'.repeat(78));
console.log(` 合格 ${results.filter(r => r.status === 'pass').length} / 不合格 ${failed.length} / 走らせていない ${skipped.length}  （全 ${STAGES.length} 段）`);
console.log(' ⚠ この一覧に「約束と実装の突合」が無いのは、部品検査に約束の一覧(docs/約束.md)が');
console.log('   まだ無いからです。空の段を置くと「何も食べずに緑」になるので置いていません。');

if (skipped.length) {
  console.log('\n⚠ --bail が付いているので、途中で止めました。');
  console.log('  残りの段も見るには --bail を外してください（npm run check）。');
}

if (failed.length === 0) {
  console.log('\n✅ 全部の段が合格しました。');
  process.exit(0);
}

console.log('\n🚨 不合格の段:');
for (const r of failed) console.log(`   ❌ ${r.id}. ${r.name}  … ${r.failedStep}`);
console.log('\n   上に、それぞれの段が出した理由がそのまま出ています。');
console.log('   🚨 見張りを緩めて緑にしないでください。落ちる理由の方を直してください。');
console.log('='.repeat(78));
process.exit(1);
