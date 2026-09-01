#!/usr/bin/env node
// ============================================================================
// 🚨 出す前の見張り —「古い版を開いたままの人」を殺さない為の門番
//
// ⚠⚠ なぜ作ったか（2026-08-17 の事故）:
//   8/12 から画面を開きっぱなしだった端末(Edge)で、8/17 にアプリが起動しなくなった。
//   起動しないので、その端末に貯まっていた 8/12 の作業（時間取り）が
//   送られないまま消えた。
//
//   起きていた事（本番で実測した事実）:
//     https://inspection-time-c4fd3.web.app/assets/
//       index-D4LMK6Kl.js  → text/html  ← 消えている（index.html が返ってくる）
//       index-Dp0LoHux.js  → text/html  ← 消えている
//       index-MOelDncI.js  → text/html  ← 消えている
//       index-xjtw4ujW.js  → text/javascript ← いまの物だけ本物
//
//   ① `firebase deploy` は dist の中身で **丸ごと置き換える**。
//      前のビルドの部品(assets/index-〇〇.js)は本番から **消える**。
//   ② firebase.json の rewrites が `"source": "**"` なので、
//      **無いファイルにも index.html(HTML) を返す**。
//   ③ 古い index.html を握っている端末は `<script src=".../index-D4LMK6Kl.js">` を読む
//      → 中身が HTML → **構文エラー** → アプリが起動しない。
//   ④ 5日で19回出した。19回ぶん、古い部品を踏み潰した。
//
//   私(Claude)は「新しい版をどう届けるか」しか考えていなかった。
//   「古い版を開いている人がどうなるか」を一度も考えなかった。
//   → **もう記憶に頼らない。出す前に、機械にここで止めさせる。**
//
// ⚠⚠ **嘘の合格は、見逃しより悪い**（MISTAKES.md D11）。だから
//   ・確かめられなかった物は ✅ にしない。**「分からない」も不合格**として出す
//   ・本番に問い合わせる試験には **対照**を置く
//     （実在する玉が 200/JS で返る事を先に確かめる。返らないなら試験自体が信用できない）
//   ・見張り自身を **わざと壊した設定**で試験する → node scripts/selftest-deploy-safety.mjs
//
// 使い方:
//   node scripts/verify-deploy-safety.mjs            … 全部見る（既定）
//   node scripts/verify-deploy-safety.mjs --pre      … ビルド前（設定と本番の返り方だけ）
//   node scripts/verify-deploy-safety.mjs --post     … ビルド後（dist と本番の玉を突き合わせる）
//   node scripts/verify-deploy-safety.mjs --after    … 出した後（本番で実際に確かめる）
//   node scripts/verify-deploy-safety.mjs --offline  … 通信しない（設定だけ見る）
//   node scripts/verify-deploy-safety.mjs --base=http://127.0.0.1:5260
//                                                    … 手元の hosting に向けて実測する
//                                                      （⚠5174 は親が使用中。5260 以降を使う）
//
// 逃げ道（試験用。人が使う物ではない）:
//   DEPLOY_SAFETY_ROOT=…      別の木を見る（selftest が使う）
//   DEPLOY_SAFETY_FIXTURE=…   通信の答えを差し替える（selftest が使う）
//   DEPLOY_SAFETY_RETRY_MS=…  引き直しの待ち時間ms(カンマ区切り。selftest が '1,1' で速くする)
// ============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.DEPLOY_SAFETY_ROOT || join(HERE, '..');

const ARGS = process.argv.slice(2);
const hasFlag = (f) => ARGS.includes(f);
const valOf = (name, dflt = '') => {
  const hit = ARGS.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : dflt;
};
const MODE = hasFlag('--after') ? 'after' : hasFlag('--post') ? 'post' : hasFlag('--pre') ? 'pre' : 'full';
const OFFLINE = hasFlag('--offline') || process.env.DEPLOY_SAFETY_OFFLINE === '1';
const BASE_OVERRIDE = valOf('--base', process.env.DEPLOY_SAFETY_BASE || '');

/**
 * 🚨🚨 2026-09-01(その2)。待ちの下限(SETTLE_MIN_*)を入れた直後に、**同じ形の穴が
 *   もっと大きく空いている**のが実測で出た。
 *
 *   実測（本番へは1回も聞いていない。0.58秒で終わった）:
 *     DEPLOY_SAFETY_FIXTURE=<自分で書いた見本> node scripts/verify-deploy-safety.mjs --after
 *       → 「✅ D6 出した後の照合 / 合格 7件 / 不合格 0件」 終了値 **0**
 *   待ちを0にするより悪い。待ちは「短くなる」だけだが、こちらは
 *   **本番の答えそのものが作り物に化ける**。deploy.mjs は子へ環境をそのまま渡すので、
 *   `DEPLOY_SAFETY_FIXTURE=… npm run deploy` で「出した後の照合」が丸ごと嘘になる。
 *
 *   同じ形の切り替えが他に3つ:
 *     DEPLOY_SAFETY_ROOT         … 見に行くフォルダを別の所にする（別の dist を照合する）
 *     DEPLOY_SAFETY_BASE / --base=… … 聞きに行く住所を別の所にする（自分の立てた所へ聞ける）
 *     DEPLOY_SAFETY_MATCHER_FROM … 照合の物差しを別の所から読む
 *
 * → 試験用の切り替えは **DEPLOY_SAFETY_SELFTEST=1 と一緒でなければ 赤で止まる**。
 *   🚨 黙って無視しない。無視すると今度は逆に
 *     「作り物で測っているつもりが、実は本番に聞いていた」が起きる。どちらも嘘になる。
 *
 * ⚠ ここに入れない物と、その理由（実測で確かめた）:
 *   ・`--offline` / DEPLOY_SAFETY_OFFLINE … 答えが status 0 ＝「分からない」になる。
 *     この見張りは「分からない」を合格にしないので、これで緑は作れない。
 *   ・DEPLOY_SAFETY_RETRY_MS … 引き直すのは通信エラー(status 0)だけで、
 *     404 や型違いは引き直さない。短くしても長くしても緑は作れない。
 */
export const SELFTEST_ONLY_SWITCHES = [
  ['DEPLOY_SAFETY_FIXTURE', '本番の答えを丸ごと作り物に差し替える'],
  ['DEPLOY_SAFETY_ROOT', '見に行くフォルダを別の所にする'],
  ['DEPLOY_SAFETY_BASE', '聞きに行く住所を別の所にする'],
  ['DEPLOY_SAFETY_MATCHER_FROM', '照合の物差しを別の所から読む'],
];

/** 試験用の切り替えが、試験の印(DEPLOY_SAFETY_SELFTEST=1)無しで渡されていないか。 */
export const selftestOnlyMisuse = (env = process.env, argv = ARGS) => {
  if (String(env.DEPLOY_SAFETY_SELFTEST || '').trim() === '1') return [];
  const bad = SELFTEST_ONLY_SWITCHES
    .filter(([k]) => String(env[k] == null ? '' : env[k]).trim() !== '')
    .map(([k, why]) => `${k} … ${why}`);
  if (argv.some((a) => a === '--base' || a.startsWith('--base='))) {
    bad.push('--base=… … 聞きに行く住所を別の所にする');
  }
  return bad;
};

const readText = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const readJson = (rel) => {
  const t = readText(rel);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
};

// ---------------------------------------------------------------------------
// 🧭 このアプリはどこへ出るのか（firebase.json + .firebaserc から組み立てる）
//   ⚠ Hosting は 1つのアプリを **2つの住所**で配る（.web.app と .firebaseapp.com）。
//     試験は .web.app に投げるが、直す時は両方が同じ物を返す事を忘れない。
// ---------------------------------------------------------------------------
export const appConfig = () => {
  const fb = readJson('firebase.json') || {};
  const rc = readJson('.firebaserc') || {};
  const projectId = rc?.projects?.default || '';
  const hostings = Array.isArray(fb.hosting) ? fb.hosting : fb.hosting ? [fb.hosting] : [];
  const targets = rc?.targets?.[projectId]?.hosting || {};
  return hostings.map((h) => {
    const site = h.site || (h.target ? (targets[h.target] || [])[0] : '') || projectId;
    return {
      target: h.target || '',
      site,
      publicDir: h.public || 'dist',
      rewrites: Array.isArray(h.rewrites) ? h.rewrites : [],
      baseUrl: BASE_OVERRIDE || (site ? `https://${site}.web.app` : ''),
      alsoAt: site ? `https://${site}.firebaseapp.com` : '',
    };
  });
};

// ---------------------------------------------------------------------------
// 🔤 firebase.json の rewrites の書き方（glob）を、正規表現にする。
//   ⚠ ここを甘く作ると **嘘の合格**になる。だから
//     ・`**` は `/` をまたぐ、`*` はまたがない
//     ・`**/` は「間にフォルダが0個でもよい」＝ (?:.*/)?
//     ・`!(a|b)` `@(a|b)` `+(…)` `?(…)` `*(…)` （拡張glob）も読む
//   と、実際に効く形で書く。
// ---------------------------------------------------------------------------
const closeParen = (s, openIdx) => {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
};
const bare = (re) => re.source.replace(/^\^/, '').replace(/\$$/, '');

export const globToRegExp = (glob) => {
  const g = String(glob || '').replace(/^\//, '');
  let out = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    // 拡張glob … !( @( +( ?( *(
    if ('!@+?*'.includes(c) && g[i + 1] === '(') {
      const close = closeParen(g, i + 1);
      if (close > 0) {
        const alts = g.slice(i + 2, close).split('|').map((a) => bare(globToRegExp(a))).join('|');
        if (c === '!') out += `(?!(?:${alts})$)[^/]*`;
        else if (c === '@') out += `(?:${alts})`;
        else if (c === '+') out += `(?:${alts})+`;
        else if (c === '?') out += `(?:${alts})?`;
        else out += `(?:${alts})*`;
        i = close + 1;
        continue;
      }
    }
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` は フォルダ0個でも当たる。`**` 単独は 何にでも当たる
        if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i++; continue;
    }
    if (c === '?') { out += '[^/]'; i++; continue; }
    if (c === '{') {
      const close = g.indexOf('}', i);
      if (close > 0) {
        const alts = g.slice(i + 1, close).split(',').map((a) => bare(globToRegExp(a))).join('|');
        out += `(?:${alts})`;
        i = close + 1;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${out}$`);
};

/**
 * 頭の `!` は **打ち消し**（`!(…)` の拡張glob とは別物）。
 *   例: `"source": "!/@(assets|notice-assets)/**"` ＝「/assets/… **以外**」に当たる。
 *
 * 🎯 なぜ打ち消しと言い切れるか（**憶測ではなく実測**）:
 *   Firebase Hosting のふるまいを実装しているのは `superstatic` で、その判定は
 *   `minimatch(glob-slasher(道), glob-slasher(source))` ただ1行
 *   （node_modules/superstatic/lib/utils/patterns.js:52）。
 *   minimatch は頭の `!` を打ち消しとして読む。実際に流して確かめた:
 *     /renraku            → 当たる（index.html に流れる。リンクが開ける）
 *     /assets/index-A.js  → 当たらない（＝404 になる。事故が起きない）
 *   ⚠それでも **最後の答えは本番が持っている**。D4 で実測して確かめる。
 */
export const negatedGlob = (source) => {
  const s = String(source || '');
  return s.startsWith('!') && s[1] !== '(' ? s.slice(1) : null;
};

/**
 * 🎯 **本物の判定器で測る。**
 *   Firebase Hosting のふるまいを実装しているのは `superstatic` で、その中身は
 *   `minimatch(glob-slasher(path), glob-slasher(source))` ただ1行
 *   （node_modules/superstatic/lib/utils/patterns.js:52 と middleware/rewrites.js:47 で確認）。
 *   firebase-tools が入っているアプリでは **同じ物**を呼べる＝憶測が要らない。
 *   ⚠ 入っていないアプリ（部品検査・司令塔③）では、下の自前の読みに落ちる。
 *   ⚠ そして最後の答えは **本番**が持っている。だから D4 で実測して確かめる。
 */
export const realMatcher = (() => {
  const from = process.env.DEPLOY_SAFETY_MATCHER_FROM || ROOT;
  try {
    const req = createRequire(join(from, 'package.json'));
    const mod = req('minimatch');
    const mm = typeof mod === 'function' ? mod : mod.minimatch;
    const slasher = req('glob-slasher');
    if (typeof mm !== 'function' || typeof slasher !== 'function') return null;
    // 使えるかを1回試す（壊れた版を掴んで黙って落ちない為）
    if (mm(slasher('/a/b.js'), slasher('**')) !== true) return null;
    return {
      test: (glob, path) => mm(slasher(path), slasher(glob)),
      where: 'minimatch + glob-slasher（superstatic と同じ物）',
    };
  } catch { return null; }
})();

/** 自前の読み（判定器が無いアプリ用）。⚠ minimatch と同じ読み方に合わせてある。 */
export const myHits = (source, path) => {
  const neg = negatedGlob(source);
  try {
    return neg ? !globToRegExp(neg).test(path) : globToRegExp(source).test(path);
  } catch { return false; }
};

/** その道(path)は、この rewrite に当たるか。本物の判定器が在ればそれで、無ければ自前で。 */
export const rewriteHits = (r, path) => {
  if (realMatcher) {
    try { return realMatcher.test(r.source, path); } catch { /* 落ちたら自前の読みへ */ }
  }
  return myHits(r.source, path);
};

/** 頭の `!` を「打ち消し」として読んだ時に当たるか（読み方A）。 */
export const hitsAsNegation = (r, path) => {
  const neg = negatedGlob(r.source);
  if (!neg) return null;
  try { return !globToRegExp(neg).test(path); } catch { return null; }
};

/** その rewrite は「無い部品を頼まれた時に HTML を返す」形か。 */
export const rewriteSwallows = (rewrites, samplePath) => {
  for (const r of rewrites || []) {
    if (!r || !r.source) continue;
    const dest = String(r.destination || '');
    const hit = rewriteHits(r, samplePath);
    if (hit === false) continue;
    // 先に当たった1本が勝つ（Firebase は上から順に見る）
    return {
      source: r.source,
      destination: dest,
      isHtml: /\.html?$/i.test(dest),
      asNegation: hitsAsNegation(r, samplePath),
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// 🌐 通信。⚠**本文は取らない**（HEAD）。本番の玉は 3MB 超えが在るので、
//   ここで中身まで取ると、確かめるだけで通信量を食う。
//   ⚠ index.html だけは中身が要る（どの玉を指しているかを読む）。数KB。
// ---------------------------------------------------------------------------
const FIXTURE = process.env.DEPLOY_SAFETY_FIXTURE
  ? JSON.parse(readFileSync(process.env.DEPLOY_SAFETY_FIXTURE, 'utf8'))
  : null;

// 見本は `seq: [答え1, 答え2, …]` の形も読める（同じ URL を聞くたびに順に返し、最後の答えを繰り返す）。
// 「1回目は通信エラー・2回目は 200」のような **一過性のエラー** を selftest で作る為。
const fixtureSeqCount = new Map();
const fixtureAnswer = (url0) => {
  if (!FIXTURE) return null;
  // 🔁 印(?nc1fresh=…)は **聞き方**であって、聞いている物ではない。外してから見本を引く。
  //    ⚠ ただし「印を付けて聞いた時だけの答え」は分けて持てる様にする(鍵の後ろに `#fresh`)。
  //      本番の手前(CDN)は 404 を覚えるので、印なしは古い答え・印ありは本体の答えになる。
  //      ここを分けられないと、**印を付けずに聞き直す作りに戻しても試験が緑のまま**になる
  //      (2026-09-01 実測で確認した穴)。
  const isFresh = /[?&]nc1fresh=/.test(String(url0));
  const url = String(url0).split('?')[0];
  const pick = (key, v) => {
    if (v && Array.isArray(v.seq)) {
      const n = fixtureSeqCount.get(key) || 0;
      fixtureSeqCount.set(key, n + 1);
      return v.seq[Math.min(n, v.seq.length - 1)];
    }
    return v;
  };
  if (isFresh && FIXTURE[`${url}#fresh`]) return pick(`${url}#fresh`, FIXTURE[`${url}#fresh`]);
  if (FIXTURE[url]) return pick(url, FIXTURE[url]);
  for (const [k, v] of Object.entries(FIXTURE)) {
    if (k === '*' || k.endsWith('#fresh')) continue;
    if (k.endsWith('*') && url.startsWith(k.slice(0, -1))) return pick(k, v);
  }
  return FIXTURE['*'] ? pick('*', FIXTURE['*']) : { status: 0, error: '見本に載っていない' };
};

const askOnce = async (url, { body = false } = {}) => {
  const fx = fixtureAnswer(url);
  if (fx) return { url, status: fx.status || 0, contentType: fx.contentType || '', body: fx.body || '', error: fx.error || '' };
  if (OFFLINE) return { url, status: 0, contentType: '', body: '', error: '通信しない指定(--offline)' };
  try {
    const res = await fetch(url, {
      method: body ? 'GET' : 'HEAD',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10000),
    });
    return {
      url,
      status: res.status,
      contentType: String(res.headers.get('content-type') || ''),
      body: body ? await res.text() : '',
      error: '',
    };
  } catch (e) {
    return { url, status: 0, contentType: '', body: '', error: String(e?.message || e) };
  }
};

/**
 * 🔁 通信エラー(status 0)**だけ** 300ms/1200ms 待って引き直す（2回まで）。
 *   2026-08-29 実測: D6(--after)は直列ループで 124〜161本の HEAD を連射し、まれに
 *   `fetch failed` が混ざるが、直後に curl すると **全部 200** ＝一過性のエラー。
 *   ⚠ 404 や型違いは「答えが返ってきた」＝確定なので **引き直さない**（誤魔化しになる）。
 *   ⚠ 引き直しても駄目なら status 0 のまま返す。「分からない」を合格にしない原則はそのまま。
 */
export const RETRY_MS = (process.env.DEPLOY_SAFETY_RETRY_MS || '300,1200')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
/**
 * ⏳ 待つ。
 * 🚨🚨 2026-09-01: 自己試験は今まで `DEPLOY_SETTLE_STEPS_MS=1,1,1` で待ちを潰していた。
 *   その為に **「待ちを 0 にすると赤になる」を試験できず**、しかも同じ環境変数を
 *   本物のデプロイに渡せば見張りを丸ごと無力化できた（実測で緑のまま通った）。
 *   → 待ちの刻みは **本物のまま**にして、代わりに
 *     「作り物の答え(fixture)で測っている＝本番に一切触っていない」時だけ、
 *     実際に眠るのをやめる。刻みの数も回数も本物と同じ道を通る。
 *   ⚠ fixture が入っている時は そもそも通信の答えが全部 作り物なので、
 *     ここで眠らない事によって新しく素通りできる物は無い。
 */
const sleep = (ms) => (FIXTURE ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

export const ask = async (url, { body = false } = {}) => {
  let r = await askOnce(url, { body });
  let tries = 0;
  while (r.status === 0 && !OFFLINE && tries < RETRY_MS.length) {
    await sleep(RETRY_MS[tries]);
    tries++;
    r = await askOnce(url, { body });
  }
  return { ...r, retried: tries };
};

/**
 * 🔁🚨 手前(CDN)を通り抜けて、**本体**に聞き直す。
 *
 * ⚠⚠ なぜ要るか（2026-09-01 実測。4サイトとも同じ）:
 *   本番が返す 404 には `cache-control: public, max-age=31536000, immutable` が付いていて、
 *   2回目からは `x-cache: HIT` になる。**手前が「その名前は無い」を覚える。**
 *   `Cache-Control: no-cache` を送っても HIT のまま。3分14秒(19回)見張って一度も MISS に戻らなかった。
 *   → **同じ名前をただ聞き直しても、覚えた答えが返るだけ。待っても一生 変わらない。**
 *      「404 が出たら少し待って もう一度」を素直に書くと、緑になる事が無い見張りになる。
 *
 *   毎回ちがう印を付けると 手前を素通りする(実測: 12回とも x-cache: MISS)。
 *   在る玉に同じ印を付けても 200 + 正しい型で返る(実測: 4サイト4件とも)ので、
 *   **印を付けた測り方でも嘘にならない**。
 */
let freshSeq = 0;
export const askFresh = async (url) => {
  freshSeq += 1;
  const mark = `nc1fresh=${Date.now().toString(36)}${freshSeq}`;
  const r = await ask(url.includes('?') ? `${url}&${mark}` : `${url}?${mark}`);
  return { ...r, fresh: true };
};

/**
 * ⏳ 反映を待つ刻み(ミリ秒)。既定 2/4/8/15/30/30秒 = 待ちの合計 89秒・測り直し6回。
 *
 * ⚠ この数字の出どころ（決めうちではない・全部 2026-09-01 の実測）:
 *   ・1回聞くのに掛かる時間 … 中央 0.20〜2.1秒 / 最長 3.3秒（4サイト・HEAD・打ち切りは10秒）
 *     → 6回 測り直しても 通信ぶんは最悪でも 20秒ほど。89秒の待ちに対して十分小さい。
 *   ・手前(CDN)が 404 を覚えている間は 印なしで聞き直しても無駄（上に書いた194秒の実測）。
 *     → 89秒は「手前が忘れるのを待つ」時間ではない。**本体に届くのを待つ**時間。
 *   ・8/31 の実際の赤は「今まさに出した部品が404 → 数十秒後は全部200」だった。
 *     89秒はその「数十秒」を包む。
 *   🚨 ここはまだ **本物のデプロイでは測れていない**（この作業ではデプロイしない決まり）。
 *     出した後の照合は、待った時は必ず「何秒で届いたか」を画面に出す。
 *     次に本物を出した時のその数字で、この刻みを直す事。
 */
export const DEFAULT_SETTLE_STEPS_MS = [2000, 4000, 8000, 15000, 30000, 30000];

/**
 * 🚨🚨 2026-09-01 の わざと壊す試験で見つかった穴。
 *   `DEPLOY_SETTLE_STEPS_MS=0,0,0,0,0,0` … 6回 測り直すが **待ちは0秒**  → 緑のまま
 *   `DEPLOY_SETTLE_STEPS_MS=1`           … 1回・1ミリ秒                  → 緑のまま
 *   ＝ 今夜入れた「反映を待つ」直しは、**コードを1文字も変えずに環境変数だけで消せた**。
 *     deploy.mjs は子へ環境をそのまま渡すので `DEPLOY_SETTLE_STEPS_MS=0 npm run deploy` で
 *     8/31 の形(404 即赤)に戻り、しかも自己試験は「信用してよい」と言い続けた。
 *
 * → **下限を作る**。下限より小さい値を渡したら **赤で止まる**。
 *   🚨 黙って下限へ丸めない。丸めると「0 を渡したのに 89秒 待った」という嘘になる。
 *   ⚠ **長くするのは通す**（急ぎたい時に短くするのを止めるのが狙いで、慎重にするのは止めない）。
 *
 * 下限の出どころ(2026-09-01 の実測。決めうちではない):
 *   ・1回聞くのに掛かる時間 … 中央 0.20〜2.1秒 / 最長 3.3秒(4サイト・HEAD)
 *     → 1回の待ちが 2秒 を切ると「待った」と言えない(通信そのものの揺れに埋もれる)。
 *   ・8/31 の実際の赤は「今まさに出した部品が404 → 数十秒後は全部200」だった。
 *     → 合計が 60秒 を切ると、その「数十秒」を包めない。
 *   ・1回きりでは「たまたま」と区別が付かない → 測り直しは 4回以上。
 */
export const SETTLE_MIN_STEP_MS = 2000;
export const SETTLE_MIN_TOTAL_MS = 60_000;
export const SETTLE_MIN_STEPS = 4;

/**
 * 反映待ちの刻みを読む。**画面もファイルも触らない純粋な関数**(だから試験できる)。
 * @returns {{ steps:number[]|null, ok:boolean, why:string, source:string }}
 */
export const parseSettleSteps = (raw, {
  minStep = SETTLE_MIN_STEP_MS, minTotal = SETTLE_MIN_TOTAL_MS, minSteps = SETTLE_MIN_STEPS,
} = {}) => {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return { steps: DEFAULT_SETTLE_STEPS_MS.slice(), ok: true, why: '', source: '既定' };
  const parts = txt.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const nums = parts.map(Number);
  if (!parts.length || nums.some((n) => !Number.isFinite(n))) {
    return { steps: null, ok: false, source: 'DEPLOY_SETTLE_STEPS_MS',
      why: `DEPLOY_SETTLE_STEPS_MS=${txt} が数字の並びとして読めない` };
  }
  const bad = [];
  if (nums.length < minSteps) bad.push(`測り直しが ${nums.length}回（下限 ${minSteps}回）`);
  const shortOnes = nums.filter((n) => n < minStep);
  if (shortOnes.length) bad.push(`1回の待ちが短すぎる: ${shortOnes.join(',')}ms（下限 ${minStep}ms）`);
  const total = nums.reduce((a, b) => a + b, 0);
  if (total < minTotal) bad.push(`待ちの合計が ${total}ms（下限 ${minTotal}ms）`);
  if (bad.length) {
    return { steps: null, ok: false, source: 'DEPLOY_SETTLE_STEPS_MS',
      why: `DEPLOY_SETTLE_STEPS_MS=${txt} … ${bad.join(' / ')}` };
  }
  return { steps: nums, ok: true, why: '', source: 'DEPLOY_SETTLE_STEPS_MS' };
};

export const SETTLE = parseSettleSteps(process.env.DEPLOY_SETTLE_STEPS_MS);
export const SETTLE_STEPS_MS = SETTLE.steps || DEFAULT_SETTLE_STEPS_MS.slice();

/**
 * 本番の index.html を読んで、いま名指しされている玉を返す。
 * ⚠ 同じ物を何度も取りに行かない（1回の実行で1回だけ）。
 */
const prodCache = new Map();
export const liveFromProd = async (baseUrl) => {
  if (!baseUrl || OFFLINE) return { assets: [], say: '本番は見ていない' };
  if (prodCache.has(baseUrl)) return prodCache.get(baseUrl);
  const idx = await ask(`${baseUrl}/index.html`, { body: true });
  const got = (idx.status === 200 && /html/i.test(idx.contentType))
    ? { assets: assetsInHtml(idx.body), say: '' }
    : { assets: [], say: `⚠本番の index.html が読めなかった（${idx.status || idx.error}）` };
  prodCache.set(baseUrl, got);
  return got;
};

/** index.html が名指ししている玉（/assets/… ）を拾う。 */
export const assetsInHtml = (html) => {
  const out = new Set();
  for (const m of String(html || '').matchAll(/(?:src|href)\s*=\s*["']\/?((?:assets|static)\/[^"'?#]+)["']/g)) {
    out.add(m[1]);
  }
  return [...out];
};

// ---------------------------------------------------------------------------
// 📒 台帳 — 「いつ、どの名前の玉を出したか」。
//   ⚠ index.html は **入口の玉しか名指ししない**。
//     あとから読む玉(exceljs / jszip / mp4box …)の名前は 玉の中に書いてある。
//     だから本番を見るだけでは全部は分からない。**出した時に自分で控える**。
// ---------------------------------------------------------------------------
export const LEDGER_REL = 'scripts/deploy-ledger.json';
export const readLedger = () => readJson(LEDGER_REL) || { app: '', builds: [], lost: [] };
export const writeLedger = (l) => writeFileSync(join(ROOT, LEDGER_REL), `${JSON.stringify(l, null, 2)}\n`, 'utf8');

/**
 * 🧳 もう1つの出どころ … keep-old-assets.mjs の置き場（.hosting-attic/index.json）。
 *   あの仕掛けは「置き場に在る物」を毎回 dist へ戻してから出す。
 *   つまり **置き場の中身＝本番に出ている古い部品** なので、ここも見ないと数え落とす。
 *   ⚠ 出どころは1つに決めつけない。台帳・置き場・本番の index.html の **3つとも**見る。
 */
export const atticAssets = () => {
  const idx = readJson('.hosting-attic/index.json');
  const files = idx?.files && typeof idx.files === 'object' ? Object.keys(idx.files) : [];
  return files.map((f) => (f.startsWith('assets/') ? f : `assets/${f}`));
};

/** 台帳＋置き場に載っていて、まだ生きている事になっている玉。 */
export const ledgerAlive = () => {
  const l = readLedger();
  const lost = new Set((l.lost || []).map((x) => x.name));
  const alive = new Set();
  for (const b of l.builds || []) for (const a of b.assets || []) if (!lost.has(a)) alive.add(a);
  for (const a of atticAssets()) if (!lost.has(a)) alive.add(a);
  return [...alive];
};

/** 手元の dist に入っている玉。 */
export const distAssets = (publicDir) => {
  const base = join(ROOT, publicDir);
  if (!existsSync(base)) return null;
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(base, p).split(sep).join('/'));
    }
  };
  walk(base);
  return out;
};

/** その玉は「中身の種類」まで正しく返ってきたか。⚠ .js に HTML が返るのが 8/17 の事故。 */
export const rightKind = (name, contentType) => {
  if (name.endsWith('.js')) return /javascript|ecmascript/i.test(contentType);
  if (name.endsWith('.css')) return /text\/css/i.test(contentType);
  return !/text\/html/i.test(contentType);
};

// ---------------------------------------------------------------------------
// 判定の入れ物。ok / ng / unknown / skip
//   ⚠ **unknown も不合格**。「確かめられなかった」は「大丈夫」ではない。
// ---------------------------------------------------------------------------
const mark = { ok: '✅', ng: '❌', unknown: '⚠', skip: '⚪' };
const results = [];
const add = (id, title, level, msg, detail = []) => results.push({ id, title, level, msg, detail });

// ---------------------------------------------------------------------------
// 【1】出し方が1つの口になっているか（裏口が在ると、見張りを通さずに出せる）
// ---------------------------------------------------------------------------
/**
 * 「本番へ出す」を叩いている行か。
 * 🚨 `firebase deploy` だけを探すと **見落とす**。
 *   deploy.bat は `set FIREBASE=npx firebase` と置いてから `%FIREBASE% deploy` と書く。
 *   この見落としは、この見張りを作った当日に実際に起きた（裏口を1つ見逃していた）。
 */
const DEPLOY_CALL = /(?:\bfirebase\b|%\w*FIREBASE\w*%|\$\{?\w*FIREBASE\w*\}?)\s+deploy\b|\bdeploy\s+--only\s+hosting\b/i;
/** その道は見張りを通っているか（通っていれば裏口ではない）。 */
const THROUGH_GUARD = /verify-deploy-safety|scripts[/\\]deploy\.mjs|npm\s+run\s+deploy\b/;

const checkOneDoor = () => {
  const pkg = readJson('package.json') || {};
  const scripts = pkg.scripts || {};
  const bad = [];
  if (!scripts.deploy) {
    bad.push('package.json に "deploy" が無い（出し方が決まっていない）');
  } else if (!THROUGH_GUARD.test(scripts.deploy)) {
    bad.push(`"deploy" が見張りを通っていない: ${scripts.deploy}`);
  }
  // 他の npm script が直に本番へ出していないか
  for (const [k, v] of Object.entries(scripts)) {
    if (k === 'deploy') continue;
    if (DEPLOY_CALL.test(String(v))) bad.push(`npm script "${k}" が直に本番へ出している: ${v}`);
  }
  // 根っこの .bat / .cmd / .ps1 / .sh の裏口
  for (const name of existsSync(ROOT) ? readdirSync(ROOT) : []) {
    if (!/\.(bat|cmd|ps1|sh)$/i.test(name)) continue;
    const body = readText(name) || '';
    if (!DEPLOY_CALL.test(body)) continue;
    const guarded = body.split(/\r?\n/).some((l) => THROUGH_GUARD.test(l));
    if (!guarded) bad.push(`${name} が見張りを通さずに本番へ出している（裏口）`);
  }
  if (bad.length) add('D1', '出し方が1つの口か', 'ng', '見張りを通さずに出せる道が残っている', bad);
  else add('D1', '出し方が1つの口か', 'ok', 'npm run deploy 以外の道が無い');
};

// ---------------------------------------------------------------------------
// 【2】無いファイルに HTML を返す設定になっていないか（firebase.json の rewrites）
// ---------------------------------------------------------------------------
const SAMPLE_MISSING = 'assets/index-VERIFYME123.js';
const SAMPLE_PAGE = 'renraku'; // 画面の道（これは index.html に流さないと、リンクを開いた時に 404 になる）
const HOWTO_MEASURE = [
  '⚠設定を読むだけでは決まらない。**手元の hosting で実測**する（憶測で「直した」と言わない）:',
  '  npx firebase emulators:start --only hosting --port 5260   （⚠5174 は親が使用中）',
  '  node scripts/verify-deploy-safety.mjs --base=http://127.0.0.1:5260',
];

/**
 * 🔬 **自前の読みが、本物の判定器と同じ答えを出すか。**
 *   自前の読みは「判定器が入っていないアプリ」（部品検査・司令塔③）で使う。
 *   そこで嘘をつくと**気づけない**ので、判定器が在るアプリ（最終検査）で毎回突き合わせる。
 */
const CROSS_SAMPLES = [
  'assets/index-ABC123.js', 'assets/index-ABC123.css', 'assets/deep/x.js',
  'notice-assets/a.png', 'renraku', 'index.html', 'lot/1001456630', 'firebase-messaging-sw.js',
];
const checkReaderAgrees = (cfgs) => {
  if (!realMatcher) {
    add('D0', '自前の読みの突き合わせ', 'skip',
      '本物の判定器(minimatch)がこのアプリに無いので、突き合わせできない',
      ['⚠ 最終検査(golden)では毎回突き合わせている。答えの拠り所は D4 の実測']);
    return;
  }
  const bad = [];
  let n = 0;
  for (const c of cfgs) {
    for (const r of c.rewrites || []) {
      for (const p of CROSS_SAMPLES) {
        n++;
        const mine = myHits(r.source, p);
        const real = realMatcher.test(r.source, p);
        if (mine !== real) bad.push(`  "${r.source}" × /${p} … 自前=${mine} / 本物=${real}`);
      }
    }
  }
  if (bad.length) {
    add('D0', '自前の読みの突き合わせ', 'ng',
      '自前の読みが本物の判定器と食い違っている（判定器の無いアプリで嘘をつく）', bad);
  } else {
    add('D0', '自前の読みの突き合わせ', 'ok', `${n}通り 全部一致（${realMatcher.where}）`);
  }
};

const checkRewrites = (cfgs) => {
  checkReaderAgrees(cfgs);
  for (const c of cfgs) {
    const who = c.target ? `[${c.target}]` : '';
    const hit = rewriteSwallows(c.rewrites, SAMPLE_MISSING);
    const pageHit = rewriteSwallows(c.rewrites, SAMPLE_PAGE);

    // ① 無い部品に HTML を返していないか（8/17 の事故そのもの）
    if (hit && hit.isHtml) {
      add('D2', `rewrites が /assets を巻き込んでいないか ${who}`, 'ng',
        `無い部品 /${SAMPLE_MISSING} に HTML(${hit.destination}) を返す設定になっている`,
        [
          `当たっている行: { "source": "${hit.source}", "destination": "${hit.destination}" }`,
          'ブラウザは <script> の中身として HTML を読み → 構文エラー → アプリが起動しない',
          '直し方（firebase.json）: rewrites の source から 部品の拡張子を外す。例:',
          '  { "source": "**/!(*.js|*.css|*.map|*.json|*.png|*.svg|*.woff2)", "destination": "/index.html" }',
          ...HOWTO_MEASURE,
        ]);
    } else if (hit) {
      add('D2', `rewrites が /assets を巻き込んでいないか ${who}`, 'unknown',
        `無い部品に ${hit.destination} を返す設定。HTML ではないが、404 でもない`,
        [`当たっている行: { "source": "${hit.source}", "destination": "${hit.destination}" }`, ...HOWTO_MEASURE]);
    } else {
      add('D2', `rewrites が /assets を巻き込んでいないか ${who}`, 'ok',
        `無い部品は rewrites に当たらない（404 になる）`,
        realMatcher
          ? [`測った物: ${realMatcher.where}`, '⚠ 最後の答えは本番が持っている → D4 で実測する']
          : ['⚠ 判定器(minimatch)がこのアプリに無いので、自前の読みで見た（最終検査で毎回突き合わせている）',
            '⚠ D4 の実測が本当の答え']);
    }

    // ② 直しすぎて、画面の道まで殺していないか（片方だけ直すと、今度はリンクが開かない）
    if (!pageHit) {
      add('D2b', `画面の道が index.html に流れるか ${who}`, 'ng',
        `/${SAMPLE_PAGE} を index.html に流す rewrite が無い（リンクを直に開くと 404 になる）`,
        ['部品(.js/.css)だけを外して、画面の道は今まで通り index.html に流す']);
    } else {
      add('D2b', `画面の道が index.html に流れるか ${who}`, 'ok', `/${SAMPLE_PAGE} は index.html に流れる`,
        realMatcher ? [`測った物: ${realMatcher.where}`] : []);
    }
  }
};

// ---------------------------------------------------------------------------
// 【3】次に出す dist に、いま本番で使われている玉が入っているか
//      入っていない＝**この deploy で本番から消える**
// ---------------------------------------------------------------------------
/** 「古い部品を持ち越す仕掛け」が、出す道の上に本当に載っているか。 */
export const carryWired = () => {
  if (!existsSync(join(ROOT, 'scripts/keep-old-assets.mjs'))) return false;
  const fb = readJson('firebase.json') || {};
  const hs = Array.isArray(fb.hosting) ? fb.hosting : fb.hosting ? [fb.hosting] : [];
  const pre = hs.flatMap((h) => (Array.isArray(h.predeploy) ? h.predeploy : h.predeploy ? [h.predeploy] : []));
  const pkgDeploy = String((readJson('package.json') || {}).scripts?.deploy || '');
  // predeploy に載っているか、出す口(deploy.mjs)が通すか、のどちらかで良い
  return pre.some((c) => /keep-old-assets/.test(String(c))) || /scripts[/\\]deploy\.mjs/.test(pkgDeploy);
};

const checkNoAssetLoss = async (cfgs) => {
  for (const c of cfgs) {
    const who = c.target ? `[${c.target}]` : '';
    const dist = distAssets(c.publicDir);
    if (!dist) {
      add('D3', `古い玉を消さないか ${who}`, MODE === 'pre' ? 'skip' : 'ng',
        `${c.publicDir}/ がまだ無い（ビルド前）`,
        MODE === 'pre' ? [] : ['ビルドしてから、もう一度この見張りを通す']);
      continue;
    }
    const have = new Set(dist);
    const live = new Set(ledgerAlive());
    const attic = atticAssets();
    const from = [
      `台帳(${LEDGER_REL}) … ${readLedger().builds?.reduce((n, b) => n + (b.assets || []).length, 0) || 0}件`,
      `置き場(.hosting-attic/index.json) … ${attic.length}件`,
    ];

    if (!OFFLINE && c.baseUrl) {
      const prod = await liveFromProd(c.baseUrl);
      prod.assets.forEach((a) => live.add(a));
      from.push(prod.say || `本番の index.html … ${prod.assets.length}件`);
    }

    if (!live.size) {
      add('D3', `古い玉を消さないか ${who}`, 'unknown',
        'いま本番に何が在るのかが分からない（台帳が空で、本番も読めていない）',
        [...from,
          '⚠これは「大丈夫」ではない。**分からない**という意味。',
          '台帳を作る: node scripts/deploy.mjs --bootstrap-ledger']);
      continue;
    }

    const gone = [...live].filter((a) => !have.has(a));
    const atticSet = new Set(attic);
    const rescuable = gone.filter((a) => atticSet.has(a));   // 置き場に在る＝持ち越しで戻る
    const reallyGone = gone.filter((a) => !atticSet.has(a)); // どこにも無い＝本当に消える

    if (gone.length && MODE === 'pre' && carryWired() && !reallyGone.length) {
      // ⚠ ビルド前の dist は「前回のビルドの残り」。ここで赤にすると **毎回赤**になり、
      //   そのうち誰も見なくなる（約束.md にその失敗が書いてある）。
      //   持ち越しの仕掛けが通る事まで確かめて、通るなら通す。
      add('D3', `古い玉を消さないか ${who}`, 'ok',
        `dist にまだ ${gone.length}個 足りないが、置き場に在って 持ち越し(keep-old-assets)が通るので戻る`,
        [...from, '⚠ ビルド後に --post でもう一度、実物で数える']);
    } else if (gone.length) {
      const detail = [...from];
      reallyGone.forEach((a) => detail.push(`  🚨 消える（どこにも無い）: /${a}`));
      rescuable.forEach((a) => detail.push(`  ⚠ dist に無い（置き場には在る）: /${a}`));
      if (rescuable.length && !carryWired()) {
        detail.push('置き場には在るのに、戻す仕掛けが通っていない:');
        detail.push('  firebase.json の hosting.predeploy に "node scripts/keep-old-assets.mjs" を入れる');
      }
      detail.push('古い画面を開いたままの端末は、この部品を読みに来る。消すと起動しない。');
      add('D3', `古い玉を消さないか ${who}`, 'ng',
        `この dist を出すと、本番から ${gone.length}個の部品が消える`, detail);
    } else {
      add('D3', `古い玉を消さないか ${who}`, 'ok', `いま生きている ${live.size}個の部品は、全部 dist に入っている`, from);
    }
  }
};

// ---------------------------------------------------------------------------
// 【4】無い物を頼まれた時、本当に 404 が返るか（**実測**）
//   ⚠ 対照を取る。実在する玉が 200/JS で返らないなら、この試験の答えは信じない。
// ---------------------------------------------------------------------------
const checkRealNotFound = async (cfgs) => {
  for (const c of cfgs) {
    const who = c.target ? `[${c.target}]` : '';
    if (OFFLINE || !c.baseUrl) {
      add('D4', `無い物に 404 が返るか（実測）${who}`, 'skip', '通信しない指定なので測っていない');
      continue;
    }
    // 🚨 対照は **いま本番に在る玉**から選ぶ。
    //   ⚠ dist から選ぶと間違う: dist には **まだ出していない次の版**が入っているので、
    //     本番には無くて当たり前 → 対照が落ちる → 毎回「分からない」と言う嘘の警告になる。
    const prod = await liveFromProd(c.baseUrl);
    const live = [...prod.assets, ...ledgerAlive()];
    const control = live.find((a) => a.endsWith('.css')) || live.find((a) => a.endsWith('.js')) || '';

    let controlOk = false;
    let controlSay = '対照に使える玉が分からない（本番の index.html も台帳も読めていない）';
    if (control) {
      const r = await ask(`${c.baseUrl}/${control}`);
      controlOk = r.status === 200 && rightKind(control, r.contentType);
      controlSay = `対照 /${control} → ${r.status || r.error} ${r.contentType}`;
    }

    const miss = await ask(`${c.baseUrl}/assets/index-VERIFY${Date.now().toString(36)}.js`);
    const isHtml = /text\/html/i.test(miss.contentType);
    const missSay = `無い物 ${miss.url.replace(c.baseUrl, '')} → ${miss.status || miss.error} ${miss.contentType}`;

    if (!controlOk) {
      add('D4', `無い物に 404 が返るか（実測）${who}`, 'unknown',
        '対照が取れないので、この試験の答えは信用しない',
        [controlSay, missSay, '⚠「測れなかった」を合格にしない為に、わざと不合格にしている']);
      continue;
    }
    // 🚨 2026-08-29 判定の訂正: 危険の実体は「**200**でHTMLが返る」事(8/17の事故)。
    //   ブラウザは 404 の <script> の中身を実行しない(status が 2xx でない script は評価されない)ので、
    //   404+HTML(Firebaseの既定の404ページ)は事故にならない。前の条件(404かつ非HTML)は
    //   Firebase Hosting では**構造的に満たせず永久に赤**→誰も門を通らなくなり、裏口(deploy.bat)が
    //   常用されて台帳が腐った(2026-08-29 実測)。永久赤の見張りは無いより悪い(約束.mdの教訓)。
    // 🚨 2026-08-30 追記: 「いまの本番が危ない形で、**この dist がそれを直す**」場合を止めない。
    //   D4 は本番の**いまの姿**を測る。8/17 の形(200+HTML)が本番に残っているアプリでは、
    //   それを直す為のデプロイまで門が止めてしまい、**事故の形が永久に本番へ残る**
    //   (部品検査は 8/06、司令塔③は 8/14 から直せないままだった。2026-08-30 実測)。
    //   手元の設定(D2)が「無い部品は rewrites に当たらない」= 直っている時だけ、
    //   'fixing' として通す。⚠合格にはしない・出した後の ④(--after) で本当に直ったかを必ず測る。
    //   手元の設定が直っていなければ今までどおり ng(出しても直らないので止めるのが正しい)。
    const localFixed = !rewriteSwallows(c.rewrites, SAMPLE_MISSING);
    if (miss.status === 404) {
      add('D4', `無い物に 404 が返るか（実測）${who}`, 'ok',
        '無い部品には 404 が返る（中身がHTMLでも 404 なら <script> は実行されない。危険なのは 200+HTML）',
        [controlSay, missSay]);
    } else if (localFixed && MODE !== 'after') {
      add('D4', `無い物に 404 が返るか（実測）${who}`, 'ok',
        `⚠ いまの本番は危ない形（${miss.status}${isHtml ? '+HTML' : ''}）です。この dist を出すと直ります`,
        [controlSay, missSay,
          '手元の firebase.json は「無い部品は rewrites に当たらない」形（D2 が緑）＝出せば直る',
          '🚨 出した後の ④（--after）で、本当に直ったかを必ず実測する事',
          `もう一方の住所も忘れずに: ${c.alsoAt}`]);
    } else {
      add('D4', `無い物に 404 が返るか（実測）${who}`, 'ng',
        isHtml ? '無い部品に **HTML** が返っている（これが 8/17 の事故の直接の原因）'
          : `無い部品に ${miss.status} が返っている（404 ではない）`,
        [controlSay, missSay,
          'ブラウザは <script> として HTML を読む → 構文エラー → アプリが起動しない',
          ...(localFixed ? ['🚨 出した後なのに直っていない。rewrites が効いていない可能性がある'] : ['手元の firebase.json の rewrites も直っていない（出しても直らない）']),
          `もう一方の住所でも同じか: ${c.alsoAt}`]);
    }
  }
};

// ---------------------------------------------------------------------------
// 【5】台帳が本番に追いついているか（口を通さずに出していないか）
// ---------------------------------------------------------------------------
const checkLedger = async (cfgs) => {
  const l = readLedger();
  if (!existsSync(join(ROOT, LEDGER_REL))) {
    add('D5', '台帳', 'ng', `${LEDGER_REL} が無い（何を出したかの記録が残っていない）`,
      ['node scripts/deploy.mjs --bootstrap-ledger で作る']);
    return;
  }
  const builds = l.builds || [];
  const lost = l.lost || [];
  const detail = [`控えた版 ${builds.length}件 / 生きている部品 ${ledgerAlive().length}個 / もう戻せない部品 ${lost.length}個`];
  lost.forEach((x) => detail.push(`  ⚰ ${x.name}（${x.at || '日付不明'}）${x.why || ''}`));

  if (!builds.length) {
    add('D5', '台帳', 'unknown', '台帳が空（過去に何を出したかが分からない）', detail);
    return;
  }
  if (!OFFLINE && cfgs[0]?.baseUrl) {
    const idx = await ask(`${cfgs[0].baseUrl}/index.html`, { body: true });
    if (idx.status === 200) {
      const now = assetsInHtml(idx.body);
      const alive = new Set(ledgerAlive());
      const unknown = now.filter((a) => !alive.has(a));
      if (unknown.length) {
        add('D5', '台帳', 'ng', '本番に、台帳に無い版が出ている（口を通さずに出した）',
          [...detail, ...unknown.map((a) => `  台帳に無い: /${a}`)]);
        return;
      }
    }
  }
  add('D5', '台帳', 'ok', '本番に出ている版は台帳に載っている', detail);
};

// ---------------------------------------------------------------------------
// 【6】出しすぎていないか
//   ⚠ 8/17 の事故は「5日で19回」出した事が引き金だった（1日およそ4回）。
//     古い部品を持ち越す仕掛けが入ったので、もう即 事故にはならない。
//     それでも **出す回数は事故の大きさそのもの**なので、数えて見せる。
//     止めたい訳ではない。**「今日もう3回出しているけど、本当に今 要る？」**と聞く為。
// ---------------------------------------------------------------------------
const TODAY_LIMIT = 3;
const WEEK_LIMIT = 15;
const checkFrequency = () => {
  // ⚠ 台帳を作った時の1行（seed / bootstrap）は **出した回数ではない**。数に入れない。
  const builds = (readLedger().builds || [])
    .filter((b) => /deploy/i.test(String(b.by || '')))
    .map((b) => Date.parse(b.at))
    .filter((t) => Number.isFinite(t));
  if (!builds.length) { add('D7', '出す回数', 'skip', '台帳に出した記録がまだ無い'); return; }
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const nToday = builds.filter((t) => new Date(t).toISOString().slice(0, 10) === today).length;
  const nWeek = builds.filter((t) => now - t < 7 * day).length;
  const say = `今日 ${nToday}回 / 直近7日 ${nWeek}回`;
  if (hasFlag('--frequency-ok')) { add('D7', '出す回数', 'ok', `${say}（--frequency-ok で通した）`); return; }
  if (nToday >= TODAY_LIMIT || nWeek >= WEEK_LIMIT) {
    add('D7', '出す回数', 'ng', `出しすぎ: ${say}`, [
      `目安: 1日 ${TODAY_LIMIT}回未満 / 7日 ${WEEK_LIMIT}回未満`,
      '8/17 の事故は「5日で19回」出した事が引き金（1日およそ4回）',
      'まとめて出せないか考える。どうしても今 出すなら --frequency-ok を付ける',
    ]);
  } else {
    add('D7', '出す回数', 'ok', say);
  }
};

// ---------------------------------------------------------------------------
// 出した後（--after）… 本番で、新しい玉と 持ち越した古い玉の **両方**が生きているか
//   🔁 2026-08-29: 答えを3種類に分ける。
//     bad   … 404 や型違い ＝ 答えが返ってきた上で壊れている → ❌
//     flaky … 通信エラー(status 0)が引き直し(300ms/1200ms)でも続く → ⚠「確かめられなかった」
//             （⚠合格にはしない。unknown も不合格の原則は変えない → 従来どおり exit 1）
//     ok    … 全部 200/正しい型。引き直しで通った物が在れば注記する（一過性のエラーだった証拠）
// ---------------------------------------------------------------------------
const rightAnswer = (a, r) => r.status === 200 && rightKind(a, r.contentType);

/**
 * 部品1個を本番で測る。⏳ **404 は待って測り直す**（8/31 の赤2件は全部これだった）。
 *
 * ⚠ 返す物は4通り。「分からない」を合格にしない原則は変えない。
 *   ok        … 200 + 正しい型。waitedMs>0 なら「待ったら届いた」
 *   bad       … 待ち切っても本体に無い ＝ 本当に出せていない → ❌
 *   edgeStale … 本体には届いたのに、印なしの聞き方では まだ古い答えが返る
 *               ＝ 現場の端末には まだ届いていない → ❌（緑にしない）
 *   flaky     … 通信エラーのまま ＝ 確かめられなかった → ⚠(不合格)
 */
const measureAsset = async (baseUrl, a, say) => {
  const url = `${baseUrl}/${a}`;
  // ① まず 現場の端末と同じ聞き方(印なし)。緑ならここで終わり＝今までと同じ通信量。
  let last = await ask(url);
  if (last.status === 0) return { kind: 'flaky', r: last };
  if (rightAnswer(a, last)) return { kind: 'ok', r: last, waitedMs: 0, tries: 0 };

  const t0 = Date.now();
  let phase = 'origin';   // origin=本体に届くのを待つ / edge=本体には有る。手前が追いつくのを待つ
  for (let i = 0; i < SETTLE_STEPS_MS.length; i++) {
    // 🚨 黙って待たない。待っている事と、いま何が返っているかを その場で出す。
    say(`   ⏳ 反映を待っています（${i + 1}回目 / 経過 ${Math.round((Date.now() - t0) / 1000)}秒）`
      + ` … /${a} → いまは ${last.status || last.error}`
      + (phase === 'edge' ? '（本体には届いています。手前の入れ替わり待ち）' : ''));
    await sleep(SETTLE_STEPS_MS[i]);
    if (phase === 'origin') {
      const f = await askFresh(url);
      last = f;
      if (f.status === 0) continue;
      if (!rightAnswer(a, f)) continue;     // まだ本体に無い
      phase = 'edge';
      const plain = await ask(url);
      last = plain;
      if (rightAnswer(a, plain)) return { kind: 'ok', r: plain, waitedMs: Date.now() - t0, tries: i + 1 };
    } else {
      const plain = await ask(url);
      last = plain;
      if (rightAnswer(a, plain)) return { kind: 'ok', r: plain, waitedMs: Date.now() - t0, tries: i + 1 };
    }
  }
  const waitedMs = Date.now() - t0;
  if (last.status === 0) return { kind: 'flaky', r: last, waitedMs };
  if (phase === 'edge') return { kind: 'edgeStale', r: last, waitedMs };
  return { kind: 'bad', r: last, waitedMs };
};

const checkAfterDeploy = async (cfgs) => {
  for (const c of cfgs) {
    const who = c.target ? `[${c.target}]` : '';
    if (OFFLINE || !c.baseUrl) { add('D6', `出した後の照合 ${who}`, 'skip', '通信しない指定'); continue; }
    const want = new Set([...ledgerAlive(), ...(distAssets(c.publicDir) || []).filter((a) => a.startsWith('assets/'))]);
    const bad = [];        // 待ち切っても駄目 … 本当に壊れている
    const stale = [];      // 本体には有るのに 現場の聞き方では返らない
    const flaky = [];      // 通信エラーが続いた … 確かめられなかった
    const retriedOk = [];  // 一度は通信エラーだったが、引き直しで 200 が返った（一過性）
    const settled = [];    // 待ったら届いた（何秒で届いたかを控える）
    const say = (s) => console.log(s);
    for (const a of want) {
      const m = await measureAsset(c.baseUrl, a, say);
      const sec = (ms) => (ms / 1000).toFixed(1);
      if (m.kind === 'flaky') {
        flaky.push(`  /${a} → 通信エラー(${m.r.error})。${RETRY_MS.length}回 引き直しても届かなかった`);
        continue;
      }
      if (m.kind === 'bad') {
        bad.push(`  /${a} → ${m.r.status || m.r.error} ${m.r.contentType}`
          + `（${sec(m.waitedMs)}秒 待って ${SETTLE_STEPS_MS.length}回 測り直しても駄目）`);
        continue;
      }
      if (m.kind === 'edgeStale') {
        stale.push(`  /${a} → 本体には届いている（印を付けて聞くと 200）のに、`
          + `現場と同じ聞き方では ${m.r.status} のまま（${sec(m.waitedMs)}秒 待った）`);
        continue;
      }
      // 🚨🚨 2026-09-02: ここは `m.waitedMs > 0` だった＝**壁の時計が1ミリ秒 進んだかどうか**で
      //   「待ったら届いた」を出すか決めていた。作り物の答えで測る時は実際に眠らないので、
      //   同じ試験(ok-9)が **走らせるたびに緑になったり赤になったり** した
      //   (実測 2026-09-02: 製品5回中1回赤 / 最終3回中1回赤。中身は1行も変えていない)。
      //   ＝「待ちを0にすると赤になる」を確かめる自己試験そのものが、当てにならなかった。
      //   → 時計ではなく **測り直したかどうか(tries)** で決める。
      //     tries は 1回目の(印なしの)問い合わせで届いた時だけ 0。待ちの輪に入ったら必ず 1以上。
      if (m.tries > 0) settled.push(`  /${a} … ${sec(m.waitedMs)}秒 待ったら届いた（測り直し ${m.tries}回目）`);
      if (m.r.retried) retriedOk.push(`  /${a} … 1回目は通信エラー → 引き直しで 200（一過性）`);
    }
    const settleNote = settled.length
      ? [`⏳ ${settled.length}個は 反映を待ってから届いた。**この秒数が、待ち時間を決め直す唯一の実測**`,
        ...settled,
        `   いまの刻み: ${SETTLE_STEPS_MS.map((n) => `${n / 1000}秒`).join('→')}（環境変数 DEPLOY_SETTLE_STEPS_MS で変えられる）`]
      : [];
    if (bad.length || stale.length) {
      add('D6', `出した後の照合 ${who}`, 'ng',
        `本番で ${bad.length + stale.length}個の部品が正しく返ってこない（404/型違い。待って測り直した後の話）`,
        [...bad, ...stale, ...flaky, ...settleNote]);
    } else if (flaky.length) {
      add('D6', `出した後の照合 ${who}`, 'unknown',
        `通信エラーで ${flaky.length}個の部品を確かめられなかった（404/型違いは無い）`,
        [...flaky,
          '⚠「確かめられなかった」は「大丈夫」ではない。回線が落ち着いてから もう一度 --after を流す事',
          '  node scripts/verify-deploy-safety.mjs --after',
          ...settleNote]);
    } else {
      add('D6', `出した後の照合 ${who}`, 'ok', `本番で ${want.size}個の部品が全部 生きている`,
        [...(retriedOk.length
          ? [`⚠うち ${retriedOk.length}個は 引き直しで通った（通信エラーは一過性だった）`, ...retriedOk]
          : []),
        ...settleNote]);
    }
  }
};

// ---------------------------------------------------------------------------
const main = async () => {
  const cfgs = appConfig();
  const line = '─'.repeat(78);
  console.log(line);
  console.log(`🚨 出す前の見張り — ${cfgs.map((c) => c.site).join(', ') || '(出し先が読めない)'}`);
  console.log(`   見ている木: ${ROOT}`);
  console.log(`   やり方: ${MODE}${OFFLINE ? '（通信しない）' : ''}${BASE_OVERRIDE ? ` / 宛先=${BASE_OVERRIDE}` : ''}`);
  console.log('⚠「確かめられなかった」は合格にしない。');
  console.log(line);

  // 🚨🚨 試験用の切り替えを本物のデプロイに渡して、答えごと作り物にする道を **止める**（2026-09-01 その2）。
  //   実測: DEPLOY_SAFETY_FIXTURE=<自分で書いた見本> で --after が「合格7件/不合格0件」終了値0。
  //         本番へは1回も聞いていない（0.58秒）。待ちを0にするより悪い穴だった。
  // 🚨 **いちばん先に見る。** 最初ここを firebase.json の検査の後ろに置いていて、
  //   DEPLOY_SAFETY_ROOT を別のフォルダに向けた時は そちらが先に赤になり、
  //   この門は **一度も通っていなかった**（赤は出るが、理由が違う＝直しが効いた証拠にならない）。
  //   切り替えの検分は、見に行く先を使う前に済ませる。
  const misuse = selftestOnlyMisuse();
  if (misuse.length) {
    console.log('❌ 試験用の切り替えが渡されています。**この設定では測りません。**');
    for (const m of misuse) console.log(`   ・${m}`);
    console.log('   これらは 本番の答え・見に行く先・照合の物差し を差し替える物なので、');
    console.log('   本物のデプロイで使うと「確かめた」と言いながら **中身は作り物** になります。');
    console.log('   見張り自身の試験(node scripts/selftest-deploy-safety.mjs)は');
    console.log('   DEPLOY_SAFETY_SELFTEST=1 を付けて呼んでいるので、そのまま動きます。');
    console.log('   ⚠ 黙って無視はしません（無視すると今度は「作り物のつもりで本番に聞いていた」が起きます）。');
    console.log(line);
    process.exit(1);
  }

  if (!cfgs.length) {
    console.log('❌ firebase.json に hosting が無い。出し先が分からない。');
    process.exit(1);
  }

  // 🚨🚨 反映待ちを短くして見張りを無力化する道を、ここで **止める**（2026-09-01）。
  //   黙って下限へ丸めない＝「0 を渡したのに待った事にする」という嘘をつかない。
  if (!SETTLE.ok) {
    console.log('❌ 反映を待つ刻みが、下限より短い。**この設定では測りません。**');
    console.log(`   ${SETTLE.why}`);
    console.log(`   下限: 1回 ${SETTLE_MIN_STEP_MS}ms 以上 / 合計 ${SETTLE_MIN_TOTAL_MS}ms 以上 / 測り直し ${SETTLE_MIN_STEPS}回 以上`);
    console.log('   ⚠ 長くするのは通ります。短くするのだけ止めています。');
    console.log('     (待ちを0にすると「出した直後の404」を そのまま赤にしてしまい、');
    console.log('      しかも見張りは「確かめた」と言い続けます＝嘘の判定になります)');
    console.log(`   既定に戻すなら DEPLOY_SETTLE_STEPS_MS を外してください（既定 ${DEFAULT_SETTLE_STEPS_MS.join(',')}）`);
    console.log(line);
    process.exit(1);
  }
  console.log(`   ⏳ 反映を待つ刻み: ${SETTLE_STEPS_MS.map((n) => `${n / 1000}秒`).join('→')}`
    + `（合計 ${SETTLE_STEPS_MS.reduce((a, b) => a + b, 0) / 1000}秒 / ${SETTLE.source}`
    + `${FIXTURE ? ' / 作り物の答えで測っているので実際には眠りません' : ''}）`);

  checkOneDoor();
  checkRewrites(cfgs);
  if (MODE === 'after') {
    await checkAfterDeploy(cfgs);
  } else {
    await checkNoAssetLoss(cfgs);
    if (MODE !== 'post') await checkRealNotFound(cfgs);
  }
  await checkLedger(cfgs);
  checkFrequency();

  for (const r of results) {
    console.log(`${mark[r.level]} ${r.id} ${r.title}`);
    console.log(`     ${r.msg}`);
    for (const d of r.detail) console.log(`     ${d}`);
  }

  const ng = results.filter((r) => r.level === 'ng');
  const unknown = results.filter((r) => r.level === 'unknown');
  console.log(line);
  console.log(`合格 ${results.filter((r) => r.level === 'ok').length}件 / 不合格 ${ng.length}件 / 分からない ${unknown.length}件 / 測っていない ${results.filter((r) => r.level === 'skip').length}件`);
  if (ng.length || unknown.length) {
    console.log('');
    console.log('❌ この状態で出さない。出すと、古い画面を開いている端末が起動しなくなる。');
    console.log('   起動しない端末に貯まっている作業は、送られないまま消える（8/17 に実際に起きた）。');
    console.log(`   詳しくは docs/デプロイで壊した事故-2026-08-17.md`);
    console.log(line);
    process.exit(1);
  }
  console.log('✅ 出してよい。');
  console.log(line);
  process.exit(0);
};

// 直に呼ばれた時だけ動く（deploy.mjs / selftest からは 部品として取り込む）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error('⚠見張り自身が落ちた:', e); process.exit(1); });
}
