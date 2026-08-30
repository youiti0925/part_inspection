// ============================================================================
// 🕵️ 「見張りが本当に実コードを食ったか」を見張る。
// ----------------------------------------------------------------------------
// 🚨🚨 なぜ要るか。2026-08-30 の1日で **同じ形を3件** 見つけた:
//   ① 試験の道具がリポジトリに無く、72件の試験が静かに飛んでいた
//   ② 依存の並び([lots, lotsLoaded])を「門」と数えていた(門を消しても緑)
//   ③ 製品の check-load-guards が `src/App.firebase.jsx` 決め打ちで、製品にその
//      ファイルは無い。毎回「対象のファイルが無いので省略」→ **終了値0**。
//      8/18 に足した A1〜A5 は **製品で一度も実コードを食っていなかった**。
//   共通の形は「**何も読んでいないのに緑**」。読んだ物を数えれば機械で見つかる。
//   2026-08-23 の「見張りが作り物を食っていて緑のまま本番だけ壊れていた」と同じ根。
//
// 何をするか:
//   見張りを1本ずつ子で走らせ、計測器(read-meter.mjs)で
//   **その見張りが自分で読んだファイルの数とバイト数**を数える。
//   ⚠ import で読んだ自分の道具は数えない。それを数えると
//     「1行も検査していない見張り」でも1件になり、この道具自身が嘘をつく。
//
// 判定:
//   ❌ 赤   : 終了値0 なのに 実コードを **0件** しか読んでいない
//             = 「緑なのに何も守っていない」。今日の3件はこの形。
//   ⚠ 人が見る所: 0件だが終了値が0でない(門は赤くなるので黙っては通らない)/
//             走らせていない物(実物のブラウザ・通信・子プロセスを使う物)/ 時間切れ
//   ✅       : 1件以上の実コードを読んでいる
//
// 🚨 走らせない物が有る事を隠さない。実物のブラウザを開く物・通信する物は
//   **本番へ触れうる**ので走らせない(2026-08-28 の「devサーバが本番へ書いた」事故)。
//   走らせていない事は、まとめに必ず出す。
//
// 使い方:
//   node scripts/verify-watchdogs-read-code.mjs              … このリポの見張りを測る
//   node scripts/verify-watchdogs-read-code.mjs --selftest   … 見張り自身の試験
//   node scripts/verify-watchdogs-read-code.mjs --repo <道>  … 別のアプリを読み取りだけで測る
//   node scripts/verify-watchdogs-read-code.mjs --list       … 走らせる/走らせない の一覧だけ
// ⚠ 計測中は **書き込みを止める**(read-meter.mjs)。測るだけで中身は変えない。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠ `--import` に Windows の生の道(C:\…)を渡すと node が解けない。file:// の形で渡す。
const METER = pathToFileURL(path.join(HERE, 'read-meter.mjs')).href;
const NODE = process.execPath;
const TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// 走らせてよい物の選り分け(純関数。--selftest はこれを文字列に対して回す)
// ---------------------------------------------------------------------------
// 🚨 実物のブラウザ・通信・子プロセスを使う見張りは **走らせない**。
//   dev サーバが本番を向いている事が実際に有った(2026-08-28)。測る為に本番へ触らない。
export const RISKS = [
  { re: /\b(?:playwright|puppeteer)\b/, why: '実物のブラウザを開く' },
  { re: /(?<![\w$.])fetch\s*\(|node:https?\b|https?\.request\s*\(/, why: '通信する' },
  { re: /node:child_process|\bexecSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(/, why: '子プロセスを起こす' },
];
/** 走らせてよいか。理由(走らせない時)を返す。 */
export const runRisk = (src) => {
  // ⚠コメントの中の例示で外れないよう、コメントを消してから見る。
  const s = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' ');
  const hit = RISKS.filter((r) => r.re.test(s)).map((r) => r.why);
  return hit.length ? hit.join(' / ') : '';
};

/** 見張りとして測る対象か。⚠まとめ役(check-all)と自分自身は外す。 */
export const isWatchdogName = (name) =>
  /^(?:verify|check)-.*\.mjs$/.test(name)
  && name !== 'check-all.mjs'
  && name !== 'verify-watchdogs-read-code.mjs';

/**
 * 判定。⚠ここが本体。
 * @param {{exit:number, fileCount:number, skipped:string, timedOut:boolean}} r
 * @returns {'red'|'look'|'ok'}
 */
export const judge = (r) => {
  if (r.skipped) return 'look';
  if (r.timedOut) return 'look';
  if (r.fileCount > 0) return 'ok';
  // 🚨 ここが今日の3件の形。**終了値0 なのに何も読んでいない**。
  if (r.exit === 0) return 'red';
  // 読んでいないが赤で終わる物は、門が止まるので黙っては通らない。人が見る。
  return 'look';
};

// ---------------------------------------------------------------------------
// 1本走らせて測る
// ---------------------------------------------------------------------------
const measureOne = (repo, file) => {
  const full = path.join(repo, 'scripts', file);
  const src = fs.readFileSync(full, 'utf8');
  const skipped = runRisk(src);
  if (skipped) return { file, skipped, exit: null, fileCount: 0, byteTotal: 0, read: [], blockedWrites: [] };

  const out = path.join(os.tmpdir(), `readmeter-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const res = spawnSync(NODE, ['--import', METER, path.join('scripts', file)], {
    cwd: repo,
    env: { ...process.env, READ_METER_OUT: out },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  let rec = { files: [], fileCount: 0, byteTotal: 0, blockedWrites: [] };
  try { rec = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* 記録が無い＝何も読んでいない扱い */ }
  try { fs.unlinkSync(out); } catch { /* 後片付けに失敗しても判定は続ける */ }
  return {
    file,
    skipped: '',
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    exit: typeof res.status === 'number' ? res.status : null,
    fileCount: rec.fileCount || 0,
    byteTotal: rec.byteTotal || 0,
    read: (rec.files || []).map((f) => path.relative(repo, f.path)),
    blockedWrites: rec.blockedWrites || [],
  };
};

export const measureRepo = (repo, only = null) => {
  const dir = path.join(repo, 'scripts');
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter(isWatchdogName).filter((n) => !only || only.includes(n)).sort();
  return names.map((n) => measureOne(repo, n));
};

// ---------------------------------------------------------------------------
// 見張り自身の試験
// ⚠⚠ **わざと「何も読まない見張り」を作って、赤になる事を確かめる。**
//   負の対照(ちゃんと読む物は緑)も一緒に見る。片方だけだと、
//   何も検出しない空っぽの見張りでも合格してしまう。
// ---------------------------------------------------------------------------
export const selftest = () => {
  let bad = 0;
  const say = (ok, what) => { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) bad++; };
  console.log('🧪 見張り自身の試験');

  // 🚨🚨 まず **計測器そのものが在るか**。実測(2026-08-30): 計測器のファイル名を変えた瞬間に、
  //   子が1本も起動できなくなり、全部が「終了値≠0・読んだ0件」＝「人が見る所」に落ちて
  //   **この段が緑のまま通った**。道具が消えたのに緑 ＝ この見張りが在る理由そのもの。
  //   ⚠ ここは一番先に見る。無ければ以降の判定は全部あてにならない。
  say(fs.existsSync(fileURLToPath(METER)),
    `🚨 計測器(scripts/read-meter.mjs)がこのリポジトリに在る (${fs.existsSync(fileURLToPath(METER)) ? '在る' : '**無い**'})`);

  // --- 判定そのもの(純関数) -------------------------------------------------
  say(judge({ exit: 0, fileCount: 0, skipped: '', timedOut: false }) === 'red',
    '🚨 終了値0 なのに1件も読んでいない見張りは 赤');
  say(judge({ exit: 0, fileCount: 1, skipped: '', timedOut: false }) === 'ok',
    '負の対照: 実コードを読んでいれば緑');
  say(judge({ exit: 1, fileCount: 0, skipped: '', timedOut: false }) === 'look',
    '負の対照: 読んでいなくても赤で終わる物は「人が見る所」(門は止まる)');
  say(judge({ exit: null, fileCount: 0, skipped: 'ブラウザ', timedOut: false }) === 'look',
    '負の対照: 走らせていない物を「赤」と言わない');

  // --- 走らせてよいかの選り分け ---------------------------------------------
  say(runRisk("import { chromium } from 'playwright';") !== '', 'ブラウザを開く物は走らせない');
  say(runRisk("// import { chromium } from 'playwright';  ← これは説明") === '',
    '負の対照: コメントに playwright と書いてあるだけでは走らせない側に倒さない');
  say(runRisk('const r = await fetch(url);') !== '', '通信する物は走らせない');
  say(runRisk("import { execSync } from 'node:child_process';") !== '', '子プロセスを起こす物は走らせない');
  say(runRisk("const s = fs.readFileSync('src/App.jsx','utf8');") === '',
    '負の対照: ただ読むだけの見張りは走らせてよい');
  say(runRisk("// 例: await fetch(url) と書いてもコメントなら関係ない\nconst s = fs.readFileSync('a','utf8');") === '',
    '負の対照: コメントの中の例示で走らせない側に倒さない');
  say(runRisk("const x = obj.fetch(1);") === '',
    '負の対照: `obj.fetch(` のような別物を通信と数えない');

  say(isWatchdogName('verify-promises.mjs') && isWatchdogName('check-load-guards.mjs'),
    '見張りの名前(verify-*/check-*)を拾う');
  say(!isWatchdogName('check-all.mjs') && !isWatchdogName('verify-watchdogs-read-code.mjs'),
    '負の対照: まとめ役と自分自身は測らない');
  say(!isWatchdogName('selftest-promises.mjs') && !isWatchdogName('deploy.mjs'),
    '負の対照: 自己試験の道具と出荷の道具は測らない');

  // --- 🚨 わざと作った見本を、**本物の仕掛けで** 走らせて測る -----------------
  //   ⚠ここはスタブではない。measureOne が使うのと同じ計測器・同じ子プロセス。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdcheck-'));
  const sdir = path.join(tmp, 'scripts');
  fs.mkdirSync(sdir);
  fs.writeFileSync(path.join(tmp, 'target.txt'), 'これは実コードのつもりの中身');
  // ① 何も読まずに「問題なし」と言って終了値0で終わる見張り(＝今日の3件の形)
  fs.writeFileSync(path.join(sdir, 'check-nothing.mjs'),
    "console.log('✅ 問題なし');\nprocess.exit(0);\n");
  // ② ちゃんと実コードを読む見張り(負の対照)
  fs.writeFileSync(path.join(sdir, 'check-reads.mjs'),
    "import fs from 'node:fs';\nconst s = fs.readFileSync('target.txt','utf8');\nconsole.log('読んだ', s.length);\nprocess.exit(0);\n");
  // ②' 🚨 **名前付きで取り込む** 見張り(`import { readFileSync } from 'node:fs'`)。
  //   計測器が先に node:fs を import していると、この形の読み取りが1件も数えられず
  //   **嘘の赤** が出る(実測: golden の verify-promises.mjs がこれで赤になった)。
  fs.writeFileSync(path.join(sdir, 'check-named.mjs'),
    "import { readFileSync } from 'node:fs';\nconst s = readFileSync('target.txt','utf8');\nconsole.log('読んだ', s.length);\nprocess.exit(0);\n");
  // ③ 読んでいないが赤で終わる見張り(負の対照: 赤ではなく「人が見る所」)
  fs.writeFileSync(path.join(sdir, 'check-loud.mjs'),
    "console.log('❌ だめ');\nprocess.exit(1);\n");
  // ④ 「対象が無いので省略」で終了値0 = 今日の製品の形そのもの
  fs.writeFileSync(path.join(sdir, 'check-skip.mjs'),
    "import fs from 'node:fs';\n"
    + "const files = ['src/App.firebase.jsx'].filter(f => fs.existsSync(f));\n"
    + "if (!files.length) { console.log('（対象のファイルが無いので省略）'); process.exit(0); }\n");
  // ⑤ 本物の src/ を **import して呼ぶ** 見張り(node --test の形)。読み方は違うが実コードを食っている。
  fs.mkdirSync(path.join(tmp, 'src', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'domain', 'real.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(sdir, 'check-imports-src.mjs'),
    "import { add } from '../src/domain/real.js';\nif (add(1,2) !== 3) process.exit(1);\nconsole.log('本物の関数を呼んだ');\nprocess.exit(0);\n");
  // ⑥ 🚨 負の対照: **自分の道具しか import しない** 見張りは、いくら import しても緑にしない。
  fs.writeFileSync(path.join(sdir, '_helper.mjs'), 'export const nothing = () => 0;\n');
  fs.writeFileSync(path.join(sdir, 'check-imports-own.mjs'),
    "import { nothing } from './_helper.mjs';\nnothing();\nconsole.log('✅ 問題なし');\nprocess.exit(0);\n");

  const got = Object.fromEntries(measureRepo(tmp).map((r) => [r.file, r]));
  say(judge(got['check-nothing.mjs']) === 'red',
    `🚨 わざと作った「何も読まない見張り」が赤になる (読んだ ${got['check-nothing.mjs'].fileCount}件 / 終了値 ${got['check-nothing.mjs'].exit})`);
  say(judge(got['check-reads.mjs']) === 'ok' && got['check-reads.mjs'].fileCount === 1,
    `負の対照: 実コードを読む見張りは緑 (読んだ ${got['check-reads.mjs'].fileCount}件)`);
  say(judge(got['check-named.mjs']) === 'ok' && got['check-named.mjs'].fileCount === 1,
    `🚨 名前付きで取り込む形(import { readFileSync })の読み取りも数える (読んだ ${got['check-named.mjs'].fileCount}件)`);
  say(judge(got['check-loud.mjs']) === 'look',
    '負の対照: 読んでいなくても赤で終わる物は赤と言わない');
  say(judge(got['check-skip.mjs']) === 'red',
    `🚨 「対象が無いので省略」で終了値0 を返す形(今日の製品と同じ)を捕まえる (読んだ ${got['check-skip.mjs'].fileCount}件 / 終了値 ${got['check-skip.mjs'].exit})`);
  say(judge(got['check-imports-src.mjs']) === 'ok',
    `負の対照: 本物の src/ を import して呼ぶ見張り(node --test の形)も「食った」と数える (${got['check-imports-src.mjs'].fileCount}件)`);
  say(judge(got['check-imports-own.mjs']) === 'red',
    `🚨 自分の道具(scripts/)しか import しない見張りは、import の数で緑にしない (${got['check-imports-own.mjs'].fileCount}件)`);

  // 🚨 計測器が **自分の読み込み(import)を数えていない** 事。
  //   ここを数えると「1行も検査していない見張り」が永久に緑になる = この道具が嘘になる。
  say(got['check-nothing.mjs'].fileCount === 0,
    '🚨 import で読んだ自分の道具を「実コードを食った」と数えない');

  // 🚨 計測中に書き込みを止めている事(人のリポジトリを測るのに中身を変えない)。
  fs.writeFileSync(path.join(sdir, 'check-writes.mjs'),
    "import fs from 'node:fs';\ntry { fs.writeFileSync('あかん.txt','x'); } catch (e) { console.log('止まった'); }\nconst s = fs.readFileSync('target.txt','utf8');\nprocess.exit(0);\n");
  const w = measureRepo(tmp, ['check-writes.mjs'])[0];
  say(w.blockedWrites.length >= 1 && !fs.existsSync(path.join(tmp, 'あかん.txt')),
    `🚨 計測中の書き込みを止める(止めた ${w.blockedWrites.length}件・ファイルは作られていない)`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? '🧪 見張り自身の試験: 合格' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗`);
  return bad === 0;
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
const main = (args) => {
  if (args.includes('--selftest')) return selftest() ? 0 : 1;
  if (!selftest()) {
    console.error('❌ 見張り自身が壊れているので、実コードの判定はしません。');
    return 1;
  }
  console.log('');

  const ri = args.indexOf('--repo');
  const repo = ri >= 0 ? path.resolve(args[ri + 1]) : process.cwd();
  // 🚨🚨 計測器が無ければ **測れていない**。測れていないのに緑を返すのが今日の3件の形。
  //   ⚠ここで「省略して終了値0」をやったら、この道具自身が同じ穴になる。赤で止める。
  if (!fs.existsSync(fileURLToPath(METER))) {
    console.error('❌ 計測器(scripts/read-meter.mjs)がありません。測れていないので、緑は返しません。');
    return 1;
  }
  const rows = measureRepo(repo);
  // 🚨 見張りが1本も見つからないのも「測れていない」。省略して緑にしない。
  if (!rows.length) {
    console.error(`❌ ${path.join(repo, 'scripts')} に見張り(verify-*/check-*.mjs)が1本もありません。`
      + '対象の決め方が壊れている可能性が高いので、緑は返しません。');
    return 1;
  }

  const red = [], look = [], ok = [];
  for (const r of rows) ({ red, look, ok })[judge(r)].push(r);

  console.log(`📄 ${repo}   見張り ${rows.length}本`);
  if (red.length) {
    console.log('');
    console.log('🚨 緑なのに実コードを1バイトも読んでいない見張り ──────────────');
    for (const r of red) {
      console.log(`  ❌ scripts/${r.file}   終了値 ${r.exit} / 読んだ実コード 0件`);
      console.log('      「対象が無いので省略」などで黙って通っている可能性が高い。対象の決め方を見る事');
    }
  }
  if (look.length) {
    console.log('');
    console.log('── 人が見る所（赤ではない） ────────────────────────────────');
    for (const r of look) {
      const why = r.skipped ? `走らせていない（${r.skipped}）`
        : r.timedOut ? '時間切れ'
          : `終了値 ${r.exit} で終わる（門は止まるので黙っては通らない）/ 読んだ実コード 0件`;
      console.log(`  ・scripts/${r.file}   ${why}`);
    }
  }
  const bw = rows.filter((r) => (r.blockedWrites || []).length);
  if (bw.length) {
    console.log('');
    console.log('── 計測中に止めた書き込み（測る側は中身を変えない） ──────────');
    for (const r of bw) console.log(`  ・scripts/${r.file}   ${r.blockedWrites.length}件  ${r.blockedWrites[0]}`);
  }
  console.log('');
  console.log(`✅ 実コードを読んでいる ${ok.length}本 / ❌ 読んでいないのに緑 ${red.length}本 / 人が見る所 ${look.length}本`);
  if (ok.length) {
    const top = ok.slice().sort((a, b) => b.byteTotal - a.byteTotal).slice(0, 3);
    console.log(`   （一番多く読んでいる物: ${top.map((r) => `${r.file} ${r.fileCount}件`).join(' / ')}）`);
  }
  if (!red.length) { console.log('✅ 見張りが実コードを食っているか: 問題なし'); return 0; }
  console.log('🚨 見張りを緩めて緑にしないでください。読む対象の決め方の方を直してください。');
  return 1;
};

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exit(main(process.argv.slice(2)));
