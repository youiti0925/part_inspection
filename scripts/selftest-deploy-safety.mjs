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
  // ⚠ noFirebaseJson … 出し先が読めない木。門の **順番** を試す為だけに使う（ng-19）。
  if (!opt.noFirebaseJson) {
    put(root, 'firebase.json', {
      hosting: {
        public: 'dist',
        predeploy: ['npm run build', 'node scripts/keep-old-assets.mjs'],
        rewrites: opt.rewrites || GOOD_REWRITE,
      },
    });
  }
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
const runVerify = (root, args = [], matcher = false, extraEnv = null) => {
  const env = {
    ...process.env,
    DEPLOY_SAFETY_ROOT: root,
    DEPLOY_SAFETY_FIXTURE: join(root, 'fixture.json'),
    // 🔁 引き直しの待ち時間を 1ms×2回 にする（試験を待たせない。本物の既定は 300ms/1200ms）
    DEPLOY_SAFETY_RETRY_MS: '1,1',
    // 🚨🚨 2026-09-01(その2): 上の2つ(ROOT / FIXTURE)は **本番の答えと見に行く先を差し替える**物。
    //   本物のデプロイに渡すと「確かめた」と言いながら中身が作り物になる（実測で緑になった）。
    //   → 見張り側は「この印が無ければ受け付けない」形にしたので、試験だけが印を付ける。
    DEPLOY_SAFETY_SELFTEST: '1',
  };
  // 🚨🚨 2026-09-01: ここは `DEPLOY_SETTLE_STEPS_MS: '1,1,1'` を渡していた。
  //   その為に **「待ちを0にすると赤になる」を一度も試験できず**、しかも同じ環境変数を
  //   本物のデプロイに渡せば見張りを丸ごと無力化できた（`DEPLOY_SETTLE_STEPS_MS=0 npm run deploy`）。
  //   → 刻みは **本物の既定のまま**にする。作り物の答え(fixture)で測っている間は
  //     見張り側が実際には眠らないので、試験は今まで通り速い。
  //   ⚠ 環境から漏れ込むと試験の意味が消えるので、必ず消してから渡す。
  delete env.DEPLOY_SETTLE_STEPS_MS;
  if (extraEnv) for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
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
    name: 'ok-5 … 出した後(--after)、本番の部品が全部 200 なら緑。待っていないのに「待った」と言わない',
    tree: () => makeTree('ok-5', {
      fixtureExtra: { [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' } },
    }),
    args: ['--after'],
    want: { code: 0 },
    mustHave: ['✅ D6', '全部 生きている'],
    // 🚨 2026-09-02 追記。ok-9 の裏側。1回目で 200 が返った時は
    //   「待った」も「待ったら届いた」も出してはいけない（出したら嘘の実測になる）。
    //   ⚠ これを書かずに ok-9 だけ直すと、判定を `if (true)` にしても両方 緑で通る。
    mustNotHave: ['❌', '待ったら届いた', '⏳ 反映を待っています'],
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
  // ---- ⏳ 反映待ちの試験3件（2026-09-01 追記。上の既存の試験は触っていない） ----
  //   2026-08-31 実測: 司令塔③の「出した後の照合」が2回とも赤。中身は
  //   「今まさに出した部品が404」＝ Firebase Hosting の反映待ちで、数十秒後は全部200だった。
  //   正しく出せているのに赤が出る → 人が「どうせ反映待ち」と読み飛ばす → **本物の404を見逃す**。
  //   🚨 だからと言って 404 を緑にはしない。**待って測り直して、それでも駄目なら赤**。
  {
    name: 'ok-9 … 1回目だけ404（反映待ち）→ 待って測り直したら200 なら緑。待っている事を画面に出す',
    tree: () => makeTree('ok-9', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        // 印なし: 1回目=404（まだ届いていない）→ 2回目から 200（seq は最後の答えを繰り返す）
        // 印あり: 本体には先に届いている
        [`${BASE_URL}/assets/index-OLD.js`]: { seq: [
          { status: 404, contentType: 'text/html; charset=utf-8' },
          { status: 200, contentType: 'text/javascript; charset=utf-8' },
        ] },
        [`${BASE_URL}/assets/index-OLD.js#fresh`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    want: { code: 0 },
    mustHave: ['⏳ 反映を待っています', '✅ D6', '待ったら届いた'],
    mustNotHave: ['❌'],
  },
  {
    name: 'ng-11 … 在りもしない名前は、待って測り直しても 赤のまま（緑にしてはいけない）',
    tree: () => makeTree('ng-11', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 404, contentType: 'text/html; charset=utf-8' },
      },
    }),
    args: ['--after'],
    want: { code: 1 },
    mustHave: ['⏳ 反映を待っています', '❌ D6', '/assets/index-OLD.js', '測り直しても駄目'],
  },
  {
    // 🚨 手前(CDN)だけが古い形。本体には有るのに、現場と同じ聞き方では返らない。
    //   2026-09-01 実測: 本番の404は max-age=31536000 + x-cache:HIT で、194秒 見張っても
    //   MISS に戻らなかった＝**印を付けずに聞き直しても永久に変わらない**。
    //   ここを緑にすると「本体に有るから大丈夫」と言って、端末が動かないまま出す事になる。
    name: 'ng-12 … 本体には届いたのに現場の聞き方では404のままなら 赤（本体に有る＝緑 にしない）',
    tree: () => makeTree('ng-12', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        // 🚨 印なし(現場と同じ聞き方)は **ずっと404**。印あり(本体へ聞き直す)だけ 200。
        //   ＝ 本番の手前(CDN)が「無い」を覚えたまま の形。2026-09-01 実測の通り、
        //     印を付けずに聞き直しても 194秒 見張って一度も変わらなかった。
        //   ⚠ この2本を分けておかないと、「印を付けずに聞き直す」作りに戻した時に
        //     試験が **緑のまま** になる（実測で1回そうなった。だからここを分けている）。
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 404, contentType: 'text/html; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js#fresh`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    want: { code: 1 },
    mustHave: ['❌ D6', '本体には届いている', '現場と同じ聞き方'],
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
  // ---- 🚨🚨 反映待ちを環境変数で消せない事（2026-09-01 追記） ------------------
  //   この日の わざと壊す試験で、次の2つが **どちらも緑** で通った(実測):
  //     DEPLOY_SETTLE_STEPS_MS=0,0,0,0,0,0  … 6回 測り直すが 待ち0秒
  //     DEPLOY_SETTLE_STEPS_MS=1            … 1回・1ミリ秒
  //   しかも自己試験は「24件とも狙い通り。この見張りは信用してよい」と言い続けた。
  //   ＝ 待つ直しが **コードを1文字も変えずに** 消せた。ここで下限を固定する。
  {
    name: 'ng-13 … 待ちを0秒にしたら 赤で止まる（環境変数で見張りを無力化できない）',
    tree: () => makeTree('ng-13', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SETTLE_STEPS_MS: '0,0,0,0,0,0' },
    want: { code: 1 },
    mustHave: ['反映を待つ刻みが、下限より短い', '1回の待ちが短すぎる', '待ちの合計が'],
    // 🚨 止まったのに「照合した」と言っていない事（8/31 の嘘の合格と同じ形にしない）
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    name: 'ng-14 … 待ち1ミリ秒×1回も 赤で止まる（回数の下限にも当たる）',
    tree: () => makeTree('ng-14', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SETTLE_STEPS_MS: '1' },
    want: { code: 1 },
    mustHave: ['反映を待つ刻みが、下限より短い', '測り直しが 1回'],
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    name: 'ng-15 … 数字として読めない刻みも 赤（黙って既定に戻さない）',
    tree: () => makeTree('ng-15', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SETTLE_STEPS_MS: 'はやく' },
    want: { code: 1 },
    mustHave: ['数字の並びとして読めない'],
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    // ⚠ 短くするのだけ止める。慎重にする側（長くする）は通す。
    name: 'ok-10 … 待ちを **長く** するのは通る（急ぐ側だけ止めている）',
    tree: () => makeTree('ok-10', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SETTLE_STEPS_MS: '30000,30000,30000,30000,30000,30000' },
    want: { code: 0 },
    mustHave: ['✅ D6', '反映を待つ刻み: 30秒→30秒'],
    mustNotHave: ['❌'],
  },
  {
    // 🚨 環境変数を渡さない＝本物の既定(2/4/8/15/30/30秒)で走る。
    //   自己試験がここを通るという事は、**本物のデプロイと同じ刻み**で判定の道を通した という事。
    name: 'ok-11 … 何も渡さなければ 本物の既定(2/4/8/15/30/30秒)で走る',
    tree: () => makeTree('ok-11', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    want: { code: 0 },
    mustHave: ['反映を待つ刻み: 2秒→4秒→8秒→15秒→30秒→30秒', '合計 89秒', '✅ D6'],
    mustNotHave: ['❌'],
  },
  // ---- 🚨🚨 試験用の切り替えを本物のデプロイで使えない事（2026-09-01 その2） ---------
  //   待ちの下限を入れた直後に、**同じ形でもっと大きい穴**が実測で出た:
  //     DEPLOY_SAFETY_FIXTURE=<自分で書いた見本> node scripts/verify-deploy-safety.mjs --after
  //       → 「合格 7件 / 不合格 0件」終了値 0。本番へは1回も聞いていない（0.58秒）。
  //   待ちを0にするのは「短くなる」だけだが、こちらは **答えそのものが作り物に化ける**。
  //   ⚠ ここの試験は、runVerify が既定で付けている印(DEPLOY_SAFETY_SELFTEST=1)を
  //     **わざと外して**走らせる。外した時に赤くならなければ、この直しは効いていない。
  {
    name: 'ng-16 … 試験の印が無ければ、作り物の答え(FIXTURE)は受け付けず 赤で止まる',
    tree: () => makeTree('ng-16', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SAFETY_SELFTEST: '' },
    want: { code: 1 },
    mustHave: ['試験用の切り替えが渡されています', 'DEPLOY_SAFETY_FIXTURE', 'DEPLOY_SAFETY_ROOT'],
    // 🚨 止まったのに「照合した」と言っていない事
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    name: 'ng-17 … 印が無い時は 引数の --base=… でも 赤（環境変数だけ塞いでも意味が無い）',
    tree: () => makeTree('ng-17', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after', '--base=https://example.invalid'],
    env: { DEPLOY_SAFETY_SELFTEST: '' },
    want: { code: 1 },
    mustHave: ['試験用の切り替えが渡されています', '--base='],
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    name: 'ng-18 … 印を真似た値(0)では通らない（1 ちょうどだけ）',
    tree: () => makeTree('ng-18', {
      fixtureExtra: {
        [`${BASE_URL}/assets/index-NEXT.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
        [`${BASE_URL}/assets/index-OLD.js`]: { status: 200, contentType: 'text/javascript; charset=utf-8' },
      },
    }),
    args: ['--after'],
    env: { DEPLOY_SAFETY_SELFTEST: '0' },
    want: { code: 1 },
    mustHave: ['試験用の切り替えが渡されています'],
    mustNotHave: ['✅ 出してよい', '✅ D6'],
  },
  {
    // 🚨 順番の試験。この門を firebase.json の検査の **後ろ** に置いていた時は、
    //   見に行く先を別のフォルダに向けると「hosting が無い」が先に赤になり、
    //   この門は一度も通らなかった（赤は出るので、直したつもりで気付けない形）。
    //   ＝ 赤かどうかだけでなく **どの理由で赤か** を見る。
    name: 'ng-19 … 見に行く先が hosting の無いフォルダでも、先に「試験用の切り替え」で止まる（順番）',
    tree: () => makeTree('ng-19', { noFirebaseJson: true }),
    args: ['--pre'],
    env: { DEPLOY_SAFETY_SELFTEST: '' },
    want: { code: 1 },
    mustHave: ['試験用の切り替えが渡されています', 'DEPLOY_SAFETY_ROOT'],
    // 🚨 「hosting が無い」が先に出ていたら、この門は通っていない
    mustNotHave: ['hosting が無い', '✅ 出してよい'],
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
  const { code, out } = runVerify(root, c.args || [], !!c.matcher, c.env || null);
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
