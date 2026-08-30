#!/usr/bin/env node
/**
 * selftest-keep-old-assets.mjs — 「古い部品の蔵(持ち越し)」の見張り
 * ===========================================================================
 *
 * 【なぜ在るか(2026-08-30)】
 *   2026-08-17 の事故: deploy は dist で本番を丸ごと置き換えるので、名前の変わった
 *   古い .js/.css が本番から消える。画面を開きっぱなしの端末は古い名前を取りに行き、
 *   404 → 起動しなくなり、その端末に貯まっていた作業の書き込みが送られないまま消えた。
 *   手当てが scripts/keep-old-assets.mjs(蔵に貯めて毎回一緒に出す)。
 *
 *   その蔵に、**期限の思い違い**が見つかった:
 *     持ち越した部品の lastSeen は更新されない(更新するのは今のビルドに入っている物だけ)。
 *     つまり 8/17 の部品の時計は、その後 何回デプロイしても 8/17 から動かない。
 *     30日の既定では 9/16 に捨てられ、8月中旬から開きっぱなしの端末が起動しなくなる所だった。
 *   → 既定を 90日 に延ばし、上限を 1000MB にし、
 *     「もうすぐ捨てる」「置き場が上限の70%」を **捨てる前に名指しで**出す様にした。
 *
 * 【この見張りが見る物】
 *   ・91日前の部品は捨てる / 捨てた事を台帳(scripts/deploy-ledger.json の "lost")に残す
 *   ・85日前の部品は捨てない / 「あと5日で捨てます」と名指しで出す
 *   ・10日前の部品は 警告も出さない
 *   ・既定が 90日 / 1000MB である事(決定A)
 *   ・置き場が上限の70%を超えたら、次に捨てる物を名指しで出す事(決定B)
 *   ・容量で捨てる時も、名指しで出して台帳に残す事
 *   ・⚠どの警告も **赤にしない**(終了値0)。出荷を止める話ではない
 *
 * 【🚨 見張り自身も試験する】
 *   過去に「見張りが作り物を食っていて緑のまま本番だけ壊れていた」事故が有った。
 *   だからここでは **本物の keep-old-assets.mjs を写して1行だけ壊した物**も走らせ、
 *   壊した時に ちゃんと赤になるかを毎回確かめる。
 *   壊しても緑のままなら、その見張りは当てにならない → この試験ごと赤にする。
 *
 * 【作り物はどこに作るか】
 *   os.tmpdir() の下。⚠ プロジェクトの中に作ると Vite が再読込して偽の不合格が出る
 *   (2026-08-10 に実際に起きた)。本物の .hosting-attic には1バイトも触らない。
 *
 * 使い方: node scripts/selftest-keep-old-assets.mjs   (終了値 0=合格 / 1=不合格)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(ROOT, 'scripts', 'keep-old-assets.mjs');

const DAY = 864e5;
const MB = 1024 * 1024;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const dayOf = (daysAgo) => iso(daysAgo).slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

let WORK = '';

// ---------------------------------------------------------------------------
// 作り物の木を1つ組む。
//   old     … 持ち越しぶん [{ name, daysAgo, bytes, declaredSize }]
//             ⚠ declaredSize は「台帳(index.json)にはこう書いてある」の値。
//               本物も合計は台帳の size で数えるので、大きい置き場を軽く作れる。
//   current … 今のビルドぶん [{ name, bytes }]
// ---------------------------------------------------------------------------
function makeTree(scriptPath, name, { old = [], current = [{ name: 'index-NEW00000.js', bytes: 32 }] } = {}) {
  const root = path.join(WORK, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hosting-attic', 'assets'), { recursive: true });

  fs.copyFileSync(scriptPath, path.join(root, 'scripts', 'keep-old-assets.mjs'));
  fs.writeFileSync(
    path.join(root, 'scripts', 'deploy-ledger.json'),
    `${JSON.stringify({ app: 'selftest', site: 'selftest', builds: [], lost: [] }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<html></html>', 'utf8');

  for (const c of current) {
    const body = 'x'.repeat(c.bytes);
    fs.writeFileSync(path.join(root, 'dist', 'assets', c.name), body, 'utf8');
  }

  const files = {};
  for (const o of old) {
    const body = 'x'.repeat(o.bytes ?? 32);
    fs.writeFileSync(path.join(root, '.hosting-attic', 'assets', o.name), body, 'utf8');
    files[o.name] = { lastSeen: iso(o.daysAgo), size: o.declaredSize ?? body.length };
  }
  fs.writeFileSync(
    path.join(root, '.hosting-attic', 'index.json'),
    `${JSON.stringify({ updatedAt: iso(1), retainDays: 90, maxMB: 1000, files }, null, 2)}\n`,
    'utf8'
  );
  return root;
}

function run(root, env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'keep-old-assets.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const read = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  };
  return {
    code: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    attic: fs.readdirSync(path.join(root, '.hosting-attic', 'assets')),
    index: read(path.join(root, '.hosting-attic', 'index.json'), { files: {} }),
    ledger: read(path.join(root, 'scripts', 'deploy-ledger.json'), null),
    dist: fs.readdirSync(path.join(root, 'dist', 'assets')),
  };
}

// ---------------------------------------------------------------------------
// 見る事の一覧。scriptPath を差し替えれば「壊した物」にも同じ試験をかけられる。
// 返り値: [{ label, ok, extra }]
// ---------------------------------------------------------------------------
function checks(scriptPath, tag) {
  const R = [];
  const say = (label, ok, extra = '') => R.push({ label, ok: !!ok, extra: String(extra) });
  const T = (n) => `${tag}-${n}`;

  // ── 1. 91日前 → 捨てる。台帳に残る。────────────────────────────────────────
  {
    const OLD = 'index-OLD91day.js';
    const g = run(makeTree(scriptPath, T('t1'), { old: [{ name: OLD, daysAgo: 91 }] }));
    say('91日前: 終了値が 0', g.code === 0, `実測 ${g.code}`);
    say('91日前: 蔵から実体が消えている', !g.attic.includes(OLD), JSON.stringify(g.attic));
    say('91日前: 蔵の index.json からも消えている', !(OLD in (g.index.files || {})));
    say('91日前: dist に戻していない', !g.dist.includes(OLD));
    const lost = ((g.ledger || {}).lost || []).find((x) => x.name === `assets/${OLD}`);
    say('91日前: 台帳 lost に載った', !!lost, JSON.stringify((g.ledger || {}).lost));
    say('91日前: 台帳の at が今日', !!lost && lost.at === today, lost && lost.at);
    say('91日前: 台帳の why に 何日経ったか が書いてある',
      !!lost && /90日/.test(lost.why) && /91日前/.test(lost.why), lost && lost.why);
    say('91日前: 台帳の形が既に在る物と同じ(name,at,why)',
      !!lost && Object.keys(lost).join(',') === 'name,at,why', lost && Object.keys(lost).join(','));
    say('91日前: 画面にも名指しで出る', /⚰ index-OLD91day\.js/.test(g.out));
  }

  // ── 2. 85日前 → 捨てない。名指しで警告。赤にしない。────────────────────────
  {
    const OLD = 'index-OLD85day.js';
    const g = run(makeTree(scriptPath, T('t2'), { old: [{ name: OLD, daysAgo: 85 }] }));
    say('85日前: 終了値が 0 (警告は赤にしない)', g.code === 0, `実測 ${g.code}`);
    say('85日前: 蔵に残っている', g.attic.includes(OLD));
    say('85日前: dist に戻している(本番へ出る)', g.dist.includes(OLD));
    say('85日前: 台帳 lost には足していない', ((g.ledger || {}).lost || []).length === 0);
    const want = `あと5日で捨てます: ${OLD} (最後にビルドに入っていたのは ${dayOf(85)})`;
    say('85日前: 警告が指定の文言・名指しで出る', g.out.includes(want), want);
    say('85日前: 何個あるかも出る', /もうすぐ捨てる部品が 1個/.test(g.out));
  }

  // ── 3. 10日前 → 警告も出ない。──────────────────────────────────────────────
  {
    const OLD = 'index-OLD10day.js';
    const g = run(makeTree(scriptPath, T('t3'), { old: [{ name: OLD, daysAgo: 10 }] }));
    say('10日前: 終了値が 0', g.code === 0, `実測 ${g.code}`);
    say('10日前: 蔵に残っている', g.attic.includes(OLD));
    say('10日前: 「もうすぐ捨てる」が出ない', !/もうすぐ捨てる部品/.test(g.out));
    say('10日前: 「あと◯日で捨てます」が1行も出ない', !/あと\d+日で捨てます/.test(g.out));
    say('10日前: 台帳 lost に足していない', ((g.ledger || {}).lost || []).length === 0);
  }

  // ── 4. 混ざっていても正しく分かれる(境目の取り違えを見る)。─────────────────
  {
    const g = run(makeTree(scriptPath, T('t4'), {
      old: [
        { name: 'a-91.js', daysAgo: 91 },
        { name: 'b-85.js', daysAgo: 85 },
        { name: 'c-10.js', daysAgo: 10 },
      ],
    }));
    say('混在: 終了値が 0', g.code === 0, `実測 ${g.code}`);
    say('混在: 91日前だけ捨てた', !g.attic.includes('a-91.js'));
    say('混在: 85日前と10日前は残っている', g.attic.includes('b-85.js') && g.attic.includes('c-10.js'));
    const lost = (g.ledger || {}).lost || [];
    say('混在: 台帳 lost は捨てた1個だけ', lost.length === 1 && lost[0].name === 'assets/a-91.js');
    say('混在: 85日前だけ名指しで警告', /あと5日で捨てます: b-85\.js/.test(g.out));
    say('混在: 10日前は警告に出ない', !/c-10\.js/.test((g.out.split('もうすぐ捨てる')[1] || '')));
  }

  // ── 5. 台帳が無い/壊れていても デプロイを止めない。ただし黙らない。──────────
  for (const [label, mut] of [
    ['台帳が無い', (root) => fs.rmSync(path.join(root, 'scripts', 'deploy-ledger.json'))],
    ['台帳が壊れている', (root) => fs.writeFileSync(path.join(root, 'scripts', 'deploy-ledger.json'), '{壊れ', 'utf8')],
  ]) {
    const root = makeTree(scriptPath, T(`t5-${label}`), { old: [{ name: 'd-91.js', daysAgo: 91 }] });
    mut(root);
    const g = run(root);
    say(`${label}: 終了値が 0 (デプロイを止めない)`, g.code === 0, `実測 ${g.code}`);
    say(`${label}: 控えられなかった事を名指しで言う`,
      /台帳に控えられませんでした/.test(g.out) && /d-91\.js/.test(g.out));
    say(`${label}: 捨てる方は そのまま動く`, !g.attic.includes('d-91.js'));
  }

  // ── 6. 決定A: 既定は 90日 / 1000MB。──────────────────────────────────────────
  {
    const g = run(makeTree(scriptPath, T('t6'), {
      old: [{ name: 'e-100.js', daysAgo: 100 }, { name: 'f-89.js', daysAgo: 89 }],
    }));
    say('既定A: 上限の既定が 1000MB', /上限 1000MB/.test(g.out), (g.out.match(/上限 \d+MB/) || [])[0]);
    say('既定A: 日数の既定が 90日', /設定 90日/.test(g.out), (g.out.match(/設定 \d+日/) || [])[0]);
    say('既定A: 100日前は捨てる', !g.attic.includes('e-100.js'));
    say('既定A: 89日前は捨てない(境目)', g.attic.includes('f-89.js'));
    say('既定A: 89日前は「あと1日で捨てます」と名指し',
      /あと1日で捨てます: f-89\.js/.test(g.out));
  }

  // ── 7. 決定B: 上限の70%を超えたら、触る前に言う。────────────────────────────
  //    ⚠ 合計は台帳(index.json)の size で数える(本物と同じ数え方)。
  //      750MB の実ファイルは作らず、台帳にそう書いた作り物で見る。
  {
    const g = run(makeTree(scriptPath, T('t7-70'), {
      old: [
        { name: 'big-old.js', daysAgo: 40, bytes: 32, declaredSize: 500 * MB },
        { name: 'big-new.js', daysAgo: 20, bytes: 32, declaredSize: 250 * MB },
      ],
    }));
    say('70%: 終了値が 0 (赤にしない)', g.code === 0, `実測 ${g.code}`);
    say('70%: 置き場の割合を出す', /置き場が 750\.0MB \/ 上限 1000MB \(75%\)/.test(g.out));
    say('70%: 日数より先に容量で捨てる、と言う', /日数より先に\*\*容量で\*\*古い部品から捨てられます/.test(g.out));
    say('70%: 次に捨てる(一番古い)物を名指しする',
      g.out.includes(`いま一番古いのは big-old.js (最後にビルドに入っていたのは ${dayOf(40)})`));
    say('70%: 上限は安全弁だと言う', /安全弁/.test(g.out));
  }
  {
    const g = run(makeTree(scriptPath, T('t7-60'), {
      old: [{ name: 'big-old.js', daysAgo: 40, bytes: 32, declaredSize: 600 * MB }],
    }));
    say('60%: 置き場の警告が出ない', !/置き場が .* \/ 上限/.test(g.out), (g.out.match(/置き場が .*/) || [])[0]);
  }
  {
    // 実バイトでも同じ事を見る(台帳の数字だけで通る試験にしない)。上限を 1MB にして測る。
    const g = run(
      makeTree(scriptPath, T('t7-real'), { old: [{ name: 'real-old.js', daysAgo: 40, bytes: 800 * 1024 }] }),
      { HOSTING_ATTIC_MAX_MB: '1' }
    );
    // 800KB ÷ 1MB = 78%。⚠ここを「8割くらい」と決めつけて書くと、試験が嘘をつく。
    say('70%(実バイト): 割合の警告が出る', /置き場が 0\.8MB \/ 上限 1MB \(7[5-9]%\)/.test(g.out),
      (g.out.match(/置き場が .*/) || [])[0]);
    say('70%(実バイト): 終了値が 0', g.code === 0, `実測 ${g.code}`);
    say('70%(実バイト): まだ捨てていない', g.attic.includes('real-old.js'));
  }

  // ── 8. 容量で捨てる時も、名指しで出して台帳に残す。──────────────────────────
  {
    const g = run(
      makeTree(scriptPath, T('t8'), {
        old: [
          { name: 'g-20.js', daysAgo: 20, bytes: 500 * 1024 },
          { name: 'h-10.js', daysAgo: 10, bytes: 500 * 1024 },
          { name: 'i-5.js', daysAgo: 5, bytes: 500 * 1024 },
        ],
        current: [{ name: 'index-NEW00000.js', bytes: 200 * 1024 }],
      }),
      { HOSTING_ATTIC_MAX_MB: '1' }
    );
    say('容量で捨てる: 終了値が 0', g.code === 0, `実測 ${g.code}`);
    say('容量で捨てる: 古い順に捨てた(20日前→10日前)',
      !g.attic.includes('g-20.js') && !g.attic.includes('h-10.js'), JSON.stringify(g.attic));
    say('容量で捨てる: 一番新しい持ち越しは残る', g.attic.includes('i-5.js'));
    const lost = (g.ledger || {}).lost || [];
    say('容量で捨てる: 捨てた分だけ台帳に載る', lost.length === 2, JSON.stringify(lost.map((x) => x.name)));
    say('容量で捨てる: 台帳の why に「上限」と書いてある',
      lost.length > 0 && lost.every((x) => /上限 1MB/.test(x.why)), lost[0] && lost[0].why);
    say('容量で捨てる: 画面にも名指しで出る', /⚰ g-20\.js/.test(g.out) && /⚰ h-10\.js/.test(g.out));
    say('容量で捨てる: 日数より早く捨てた事を言う', /設定の 90日より早く捨てました/.test(g.out));
  }

  return R;
}

// ---------------------------------------------------------------------------
// 🚨 見張り自身の試験 — 本物を写して1行だけ壊し、ちゃんと赤になるかを見る。
//   壊しても緑のままなら、その判定は見ていないのと同じ。
// ---------------------------------------------------------------------------
const MUTANTS = [
  {
    id: 'M1 もうすぐ捨てるの判定',
    from: '  if (left <= WARN_DAYS) soon.push({ rel, left, seenDay: dayOf(v.lastSeen) });',
    to: '  if (false) soon.push({ rel, left, seenDay: dayOf(v.lastSeen) });',
    mustFail: '85日前: 警告が指定の文言・名指しで出る',
  },
  {
    id: 'M2 台帳へ控える所',
    from: '  if (entries.length === 0) return;',
    to: '  if (entries.length >= 0) return;',
    mustFail: '91日前: 台帳 lost に載った',
  },
  {
    id: 'M3 上限の既定(決定A)',
    from: "const MAX_MB = numFromEnv('HOSTING_ATTIC_MAX_MB', 1000);",
    to: "const MAX_MB = numFromEnv('HOSTING_ATTIC_MAX_MB', 300);",
    mustFail: '既定A: 上限の既定が 1000MB',
  },
  {
    id: 'M4 日数の既定(決定A)',
    from: "const RETAIN_DAYS = numFromEnv('HOSTING_ATTIC_DAYS', 90);",
    to: "const RETAIN_DAYS = numFromEnv('HOSTING_ATTIC_DAYS', 30);",
    mustFail: '既定A: 日数の既定が 90日',
  },
  {
    id: 'M5 70%の判定(決定B)',
    from: 'if (usedBytes >= MAX_BYTES * WARN_FULL_RATIO) {',
    to: 'if (usedBytes >= MAX_BYTES * 99) {',
    mustFail: '70%: 置き場の割合を出す',
  },
];

// ---------------------------------------------------------------------------
let bad = 0;
const line = '─'.repeat(70);

try {
  if (!fs.existsSync(TARGET)) {
    console.log(`❌ 見る相手が居ません: ${TARGET}`);
    console.log('   古い部品の持ち越しが無いという事は、出すと本番から古い部品が消えます。');
    process.exit(1);
  }
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-guard-'));

  console.log('🧳 古い部品の蔵(持ち越し)の見張り');
  console.log(`   見る相手: ${TARGET}`);
  console.log(`   作り物の置き場: ${WORK}  (⚠本物の .hosting-attic は読みも書きもしません)`);
  console.log(line);

  // 【1】本物 — 全部 合格でなければ赤。
  const real = checks(TARGET, 'real');
  for (const r of real) {
    if (!r.ok) bad += 1;
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.extra && !r.ok ? ` … ${r.extra}` : ''}`);
  }
  console.log(line);
  console.log(`  本物: 合格 ${real.filter((r) => r.ok).length} / 不合格 ${real.filter((r) => !r.ok).length}`);

  // 【2】わざと壊した物 — 赤にならなければ、その判定は見ていないのと同じ。
  console.log('');
  console.log('🚨 見張り自身の試験(1行だけ壊して、赤になるか)');
  const src = fs.readFileSync(TARGET, 'utf8');
  for (const m of MUTANTS) {
    if (!src.includes(m.from)) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 壊す場所が見つかりません。`);
      console.log(`     探した行: ${m.from.trim()}`);
      console.log('     🚨 本体が書き変わって、この試験が**何も壊せていない**という事です。');
      console.log('        壊す場所を今の本体に合わせて直してください(試験を消さない事)。');
      continue;
    }
    const mutPath = path.join(WORK, `mutant-${m.id.split(' ')[0]}.mjs`);
    fs.writeFileSync(mutPath, src.replace(m.from, m.to), 'utf8');
    const got = checks(mutPath, `mut-${m.id.split(' ')[0]}`);
    const target = got.find((r) => r.label === m.mustFail);
    if (!target) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 見るはずの判定「${m.mustFail}」が一覧に有りません(試験の書き間違い)`);
    } else if (target.ok) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 壊したのに **緑のまま**。この判定は見ていないのと同じです。`);
      console.log(`     緑のままだった判定: ${m.mustFail}`);
    } else {
      const reds = got.filter((r) => !r.ok).length;
      console.log(`  ✅ ${m.id} … 壊したら赤になった(赤 ${reds}件。うち「${m.mustFail}」)`);
    }
  }
} finally {
  if (WORK) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 消せなくても試験の結果は変わらない */ } }
}

console.log(line);
if (bad === 0) {
  console.log('✅ 古い部品の蔵: 全部 合格(わざと壊した物は全部 赤になりました)');
  process.exit(0);
}
console.log(`🚨 古い部品の蔵: 不合格 ${bad}件`);
console.log('   ⚠ここが赤のまま出すと、開きっぱなしの端末が起動しなくなる事故に戻ります。');
console.log('   🚨 見張りを緩めて緑にしないでください。落ちる理由の方を直してください。');
process.exit(1);
