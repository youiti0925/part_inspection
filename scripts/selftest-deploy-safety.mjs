#!/usr/bin/env node
// ============================================================================
// 🔬 「出す前の見張り」自身の試験（負の対照）
//
// ⚠⚠ なぜ要るか:
//   **落ちない見張りを緑だと言わない。**
//   2026-08-16 に、約束の見張りが「嘘の合格」を3件出していた事が実際に在った。
//   見張りは、**わざと壊した設定を渡したら本当に落ちるか**を確かめて初めて信用できる。
//
//   ここでは 作り物の木を tmp に作って、見張りを流す:
//     ok/   … ちゃんとした形 → **合格しないと駄目**
//     ng-*/ … わざと壊した形 → **その理由で落ちないと駄目**
//              （「何かで落ちた」では駄目。**狙った目印**が出ている事まで見る）
//
// ⚠出力はプロジェクトの外(os.tmpdir)へ。中に書くと Vite が再読込して偽の不合格が出る。
//
// 使い方: node scripts/selftest-deploy-safety.mjs
// ============================================================================
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, 'verify-deploy-safety.mjs');
const BASE = join(tmpdir(), 'claude', 'deploy-safety-selftest');
rmSync(BASE, { recursive: true, force: true });

const put = (root, rel, body) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, 'utf8');
};

const SITE = 'testsite';
const BASE_URL = `https://${SITE}.web.app`;
const GOOD_REWRITE = [{ source: '**/!(*.js|*.css|*.map)', destination: '/index.html' }];
const BAD_REWRITE = [{ source: '**', destination: '/index.html' }];

/** 通信の答えを差し替える見本。実際には1回も通信しない。 */
const answers = ({ missing404 = true, control = true } = {}) => ({
  [`${BASE_URL}/index.html`]: {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<script type="module" src="/assets/index-NEW.js"></script><link rel="stylesheet" href="/assets/index-NEW.css">',
  },
  // control:false … 実在するはずの玉まで 404 が返る＝「この試験自体が当てにならない」状態
  [`${BASE_URL}/assets/index-NEW.js`]: control
    ? { status: 200, contentType: 'text/javascript; charset=utf-8' }
    : { status: 404, contentType: 'text/plain' },
  [`${BASE_URL}/assets/index-NEW.css`]: control
    ? { status: 200, contentType: 'text/css; charset=utf-8' }
    : { status: 404, contentType: 'text/plain' },
  [`${BASE_URL}/assets/index-OLD.js`]: control
    ? { status: 200, contentType: 'text/javascript; charset=utf-8' }
    : { status: 404, contentType: 'text/plain' },
  '*': missing404
    ? { status: 404, contentType: 'text/plain; charset=utf-8' }
    : { status: 200, contentType: 'text/html; charset=utf-8' }, // ← 事故そのもの
});

/**
 * 作り物の木を1つ作る。
 * @param name  木の名前
 * @param opt   どこをわざと壊すか
 */
const makeTree = (name, opt = {}) => {
  const root = join(BASE, name);
  put(root, '.firebaserc', { projects: { default: SITE } });
  put(root, 'firebase.json', {
    hosting: {
      public: 'dist',
      predeploy: ['npm run build', 'node scripts/keep-old-assets.mjs'],
      rewrites: opt.rewrites || GOOD_REWRITE,
    },
  });
  put(root, 'package.json', {
    name,
    scripts: opt.scripts || { build: 'vite build', deploy: 'node scripts/deploy.mjs' },
  });
  // 📒 台帳 … 本番に出ている物。OLD(前の版) と NEW(いま出ている版)
  put(root, 'scripts/deploy-ledger.json', opt.ledger || {
    app: name,
    site: SITE,
    builds: [
      { at: '2026-08-01', assets: ['assets/index-OLD.js'] },
      { at: '2026-08-10', assets: ['assets/index-NEW.js', 'assets/index-NEW.css'] },
    ],
    lost: [],
  });
  // 📦 dist … **これから出す次の版**(NEXT)。
  //   ⚠ ここが本物と同じ形になっているかが大事:
  //     ・NEXT は まだ本番に無い（出す前だから）
  //     ・OLD と NEW は keep-old-assets が持ち越して入っている
  put(root, 'dist/index.html', '<script src="/assets/index-NEXT.js"></script>');
  put(root, 'dist/assets/index-NEXT.js', 'console.log(2)');
  if (!opt.dropOld) {
    put(root, 'dist/assets/index-NEW.js', 'console.log(1)');
    put(root, 'dist/assets/index-NEW.css', 'body{}');
    put(root, 'dist/assets/index-OLD.js', 'console.log(0)');
  }
  // 🚨 裏口の見本は **わざと変数越し**にしてある（本物の deploy.bat がこの形）。
  //   `firebase deploy` という字面だけを探す見張りは、これを見落とす。
  // 🧳 置き場（keep-old-assets が貯めた物）。持ち越しで戻るかどうかの判定に使う
  if (opt.attic) {
    put(root, 'scripts/keep-old-assets.mjs', '// 形だけ');
    // keep-old-assets は **過去に出した物を全部**貯めている（30日ぶん）
    put(root, '.hosting-attic/index.json', {
      updatedAt: '2026-08-17T00:00:00.000Z',
      files: {
        'assets/index-OLD.js': { lastSeen: '2026-08-01T00:00:00.000Z', size: 10 },
        'assets/index-NEW.js': { lastSeen: '2026-08-10T00:00:00.000Z', size: 10 },
        'assets/index-NEW.css': { lastSeen: '2026-08-10T00:00:00.000Z', size: 10 },
      },
    });
  }
  if (opt.backDoor) put(root, 'deploy.bat', '@echo off\r\nset FIREBASE=npx firebase\r\ncall %FIREBASE% deploy --only hosting\r\n');
  // 見張りを通している .bat は 裏口ではない（誤検出したら赤くなる）
  if (opt.goodBat) put(root, 'ok-deploy.bat', '@echo off\r\ncall npm run deploy\r\n');
  // fixtureExtra … D6(--after)の試験用に、通信の答えを1本ずつ差し替える/足す。
  //   `seq:[…]` の形は「聞くたびに順に返す」（1回目=通信エラー・2回目=200 の一過性を作れる）。
  put(root, 'fixture.json', { ...answers(opt), ...(opt.fixtureExtra || {}) });
  return root;
};

/**
 * 見張りを1回流して、出た文字と終了コードを返す。
 * @param matcher true にすると **本物の判定器**(minimatch)をこのリポジトリから借りて測らせる。
 *   作り物の木には node_modules が無いので、既定では自前の読みの方が試される。
 *   **両方の道を試す**（片方しか試さないと、もう片方が腐る）。
 */
const runVerify = (root, args = [], matcher = false) => {
  const env = {
    ...process.env,
    DEPLOY_SAFETY_ROOT: root,
    DEPLOY_SAFETY_FIXTURE: join(root, 'fixture.json'),
    // 🔁 引き直しの待ち時間を 1ms×2回 にする（試験を待たせない。本物の既定は 300ms/1200ms）
    DEPLOY_SAFETY_RETRY_MS: '1,1',
  };
  if (matcher) env.DEPLOY_SAFETY_MATCHER_FROM = join(HERE, '..');
  else delete env.DEPLOY_SAFETY_MATCHER_FROM;
  const r = spawnSync(process.execPath, [VERIFY, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ---------------------------------------------------------------------------
// 試験の一覧。⚠**合格の試験と、不合格の試験を両方置く。**
//   合格の試験が無いと「いつも赤い見張り」を作ってしまい、そのうち誰も見なくなる。
//   不合格の試験が無いと「いつも緑の見張り」＝嘘の合格になる。
// ---------------------------------------------------------------------------
const CASES = [
  {
    // ⚠ ここには **誤検出したら赤くなる物**を置いてある:
    //   ・npm run deploy を呼ぶだけの .bat（裏口ではない）
    name: 'ok … 全部ちゃんとしている（誤検出したら落ちる）',
    tree: () => makeTree('ok', { goodBat: true }),
    want: { code: 0 },
    mustHave: ['✅ 出してよい。'],
    mustNotHave: ['❌'],
  },
  {
    name: 'ng-1 … rewrites が "**"（無い部品に HTML を返す設定）',
    tree: () => makeTree('ng-1', { rewrites: BAD_REWRITE }),
    want: { code: 1 },
    mustHave: ['❌ D2', 'HTML'],
  },
  {
    // 🎯 いま4アプリが使っている本物の書き方。**本物の判定器**で測って、
    //   ①無い部品は流れない ②画面の道は流れる の両方が言える事を固定する。
    name: 'ok-3 … 本番の書き方 "!/@(assets|notice-assets)/**" を本物の判定器で測る',
    tree: () => makeTree('ok-3', { rewrites: [{ source: '!/@(assets|notice-assets)/**', destination: '/index.html' }] }),
    matcher: true,
    want: { code: 0 },
    mustHave: ['✅ D2', '✅ D2b', 'superstatic と同じ物'],
  },
  {
    // 判定器が無いアプリ（部品検査・司令塔③）でも、自前の読みで同じ答えが出る事
    name: 'ok-4 … 判定器が無くても、自前の読みで同じ答えが出る',
    tree: () => makeTree('ok-4', { rewrites: [{ source: '!/@(assets|notice-assets)/**', destination: '/index.html' }] }),
    want: { code: 0 },
    mustHave: ['✅ D2', '✅ D2b', '⚪ D0'],
  },
  {
    name: 'ng-1b … "**" は 本物の判定器でも 巻き込む',
    tree: () => makeTree('ng-1b', { rewrites: BAD_REWRITE }),
    matcher: true,
    want: { code: 1 },
    mustHave: ['❌ D2', 'HTML'],
  },
  {
    // 🚨 2026-08-30 分けた: 「本番が危ない形」には2通りある。
    //   (a) 手元の設定も直っていない → 出しても直らないので **止めるのが正しい**(このng-2)
    //   (b) 手元は直っていて本番だけ古い → **出せば直る**ので止めない(下の ok-8)
    //   前は両方 ❌ にしていたので、事故の形が残っているアプリは直す為のデプロイまで
    //   止められ、**永久に本番へ残った**(部品検査は8/06・司令塔③は8/14から直せなかった)。
    name: 'ng-2 … 本番も手元の設定も「無い部品」に HTML を返す（出しても直らない）',
    tree: () => makeTree('ng-2', { missing404: false, rewrites: BAD_REWRITE }),
    want: { code: 1 },
    mustHave: ['❌ D4', '事故の直接の原因', '手元の firebase.json の rewrites も直っていない'],
  },
  {
    name: 'ok-8 … 本番は危ない形だが手元の設定は直っている（出すと直る）ので止めない',
    tree: () => makeTree('ok-8', { missing404: false }),   // rewrites は既定=GOOD
    want: { code: 0 },
    mustHave: ['✅ D4', 'この dist を出すと直ります', '出した後の ④'],
    mustNotHave: ['❌ D4'],
  },
  // ⚠ --after では D4 は走らない(verify-deploy-safety.mjs:824-829。出した後は D6 が本当の検証)。
  //   なので「出した後なのに直っていない」を D4 で見る試験は作れない。
  //   代わりに、出す前の判定で **手元も直っていない時だけ止まる** 事を ng-2 が、
  //   **手元が直っていれば通す** 事を ok-8 が固定している。この2本で意図は守られる。
  {
    name: 'ng-3 … dist に古い部品が入っていない（出すと消える）',
    tree: () => makeTree('ng-3', { dropOld: true }),
    want: { code: 1 },
    mustHave: ['❌ D3', 'assets/index-OLD.js'],
  },
  {
    // ⚠ ビルド前の dist で赤を出すと **毎回赤**になり、そのうち誰も見なくなる。
    //   置き場に在って、持ち越しの仕掛けが通るなら、通してよい。
    name: 'ok-2 … ビルド前(--pre)で dist に無くても、置き場に在れば通す',
    tree: () => makeTree('ok-2', { dropOld: true, attic: true }),
    args: ['--pre'],
    want: { code: 0 },
    mustHave: ['✅ D3', '持ち越し'],
  },
  {
    name: 'ng-3b … 出す直前(--post)は、置き場に在っても dist に無ければ止める',
    tree: () => makeTree('ng-3b', { dropOld: true, attic: true }),
    args: ['--post'],
    want: { code: 1 },
    mustHave: ['❌ D3', 'assets/index-OLD.js'],
  },
  {
    name: 'ng-4 … 見張りを通さない裏口（deploy.bat）が在る',
    tree: () => makeTree('ng-4', { backDoor: true }),
    want: { code: 1 },
    mustHave: ['❌ D1', 'deploy.bat'],
  },
  {
    name: 'ng-5 … npm run deploy が見張りを通っていない',
    tree: () => makeTree('ng-5', { scripts: { build: 'vite build', deploy: 'firebase deploy --only hosting' } }),
    want: { code: 1 },
    mustHave: ['❌ D1', '見張りを通っていない'],
  },
  {
    name: 'ng-6 … 台帳が空（何を出したか分からない）',
    tree: () => makeTree('ng-6', { ledger: { app: 'x', site: SITE, builds: [], lost: [] } }),
    want: { code: 1 },
    mustHave: ['⚠ D5', '台帳が空'],
  },
  {
    name: 'ng-6b … 台帳が空 かつ 本番も見ない → 「分からない」を合格にしない',
    tree: () => makeTree('ng-6b', { ledger: { app: 'x', site: SITE, builds: [], lost: [] } }),
    args: ['--offline'],
    want: { code: 1 },
    mustHave: ['⚠ D3', '分からない'],
  },
  {
    name: 'ng-7 … 対照が取れない時に「合格」と言わない',
    tree: () => makeTree('ng-7', { control: false }),
    want: { code: 1 },
    mustHave: ['⚠ D4', '信用しない'],
  },
  {
    name: 'ng-8 … 画面の道まで潰す rewrites（直しすぎ）',
    tree: () => makeTree('ng-8', { rewrites: [{ source: 'assets/**', destination: '/index.html' }] }),
    want: { code: 1 },
    mustHave: ['❌ D2b', '404'],
  },
  // ---- 🔁 D6(--after) の試験4件（2026-08-29 追記。上の既存の試験は触っていない） ----
  //   D6 は本番へ HEAD を直列で 124〜161本 連射する（実測）。まれに混ざる一過性の
  //   通信エラー(fetch failed = status 0)だけ引き直す。404 は確定した答えなので引き直さない。
  {
    name: 'ok-5 … 出した後(--after)、本番の部品が全部 200 なら緑',
    tree: () => makeTree('ok-5', {
      fixtureExtra: { [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' } },
    }),
    args: ['--after'],
    want: { code: 0 },
    mustHave: ['✅ D6', '全部 生きている'],
    mustNotHave: ['❌'],
  },
  {
    name: 'ok-6 … 一過性の通信エラー(1回目だけ status 0)は引き直しで緑＋注記',
    tree: () => makeTree('ok-6', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { seq: [
          { status: 0, error: 'fetch failed' },
          { status: 200, contentType: 'text/javascript; charset=utf-8' },
        ] },
      },
    }),
    args: ['--after'],
    want: { code: 0 },
    mustHave: ['✅ D6', '引き直しで通った', '一過性'],
    mustNotHave: ['❌'],
  },
  {
    name: 'ng-9 … 本物の 404 は引き直さずに赤（bad）',
    tree: () => makeTree('ng-9', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 404, contentType: 'text/html; charset=utf-8' },
      },
    }),
    args: ['--after'],
    want: { code: 1 },
    mustHave: ['❌ D6', '/assets/index-OLD.js', '404'],
  },
  {
    name: 'ng-10 … 通信がずっと駄目なら「確かめられなかった」で不合格（緑にしない）',
    tree: () => makeTree('ng-10', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 0, error: 'fetch failed' },
      },
    }),
    args: ['--after'],
    want: { code: 1 },
    mustHave: ['⚠ D6', '確かめられなかった'],
    mustNotHave: ['❌ D6'],
  },
  // ---- 🚨 D4 の判定の試験1件（2026-08-30 追記。上の既存の試験は触っていない） ----
  //   2026-08-29 に D4 の判定を「404 かつ 非HTML」→「危険なのは 200+HTML」へ訂正したのに、
  //   **その訂正を元に戻しても 17件とも緑のままだった**(2026-08-30 実測)。
  //   見本の「無い物」は 404+text/plain しか用意しておらず、本物の Firebase Hosting が返す
  //   **404 + text/html**(既定の404ページ)を一度も試していなかったため。
  //   ⚠ 落ちない見張りは、無いのと同じ。ここでその1件を固定する。
  //   （200+HTML が赤になる事は ng-2 が見ている。ここは「404+HTML は緑」の側）
  {
    name: 'ok-7 … 無い部品に 404+HTML（本物のFirebaseの既定ページ）が返るのは緑',
    tree: () => makeTree('ok-7', {
      fixtureExtra: { '*': { status: 404, contentType: 'text/html; charset=utf-8' } },
    }),
    want: { code: 0 },
    mustHave: ['✅ D4', '危険なのは 200+HTML'],
    mustNotHave: ['❌'],
  },
];

/**
 * 本物の判定器(minimatch)がこのアプリに在るか。
 * ⚠ 無いアプリ（部品検査・司令塔③）では、判定器を使う試験は **飛ばす**。
 *   飛ばした事は必ず画面に出す（黙って消さない）。
 */
const HAS_MATCHER = (() => {
  try {
    const req = createRequire(join(HERE, '..', 'package.json'));
    req('minimatch'); req('glob-slasher');
    return true;
  } catch { return false; }
})();

const line = '─'.repeat(78);
console.log(line);
console.log('🔬 出す前の見張り 自身の試験（わざと壊した設定で、本当に落ちるか）');
if (!HAS_MATCHER) {
  console.log('⚪ このアプリには本物の判定器(minimatch)が無いので、それを使う試験は飛ばします。');
  console.log('   （最終検査 golden では通ります。自前の読みとの突き合わせもそこでやっています）');
}
console.log(line);

let bad = 0;
let skipped = 0;
for (const c of CASES) {
  if (c.matcher && !HAS_MATCHER) { console.log(`⚪ ${c.name}（判定器が無いので飛ばした）`); skipped++; continue; }
  const root = c.tree();
  const { code, out } = runVerify(root, c.args || [], !!c.matcher);
  const miss = [];
  if (code !== c.want.code) miss.push(`終了コードが ${code}（欲しいのは ${c.want.code}）`);
  for (const m of c.mustHave || []) if (!out.includes(m)) miss.push(`出ていない文字: ${m}`);
  for (const m of c.mustNotHave || []) if (out.includes(m)) miss.push(`出てはいけない文字: ${m}`);
  if (miss.length) {
    bad++;
    console.log(`❌ ${c.name}`);
    miss.forEach((m) => console.log(`     ${m}`));
    console.log('   ── 見張りが出した物 ──');
    out.split('\n').forEach((l) => console.log(`   | ${l}`));
  } else {
    console.log(`✅ ${c.name}`);
  }
}

console.log(line);
if (bad) {
  console.log(`❌ 見張り自身が ${bad}件 おかしい。**この見張りの結果を信用しない。**`);
  process.exit(1);
}
console.log(`✅ ${CASES.length - skipped}件とも、狙い通りに 合格/不合格 が出た。この見張りは信用してよい。`
  + (skipped ? `（判定器が無くて飛ばした ${skipped}件）` : ''));
console.log(line);
process.exit(0);
