#!/usr/bin/env node
// =============================================================================
// 🧪🚨 「試したつもり」の見張り — エミュレータの繋ぎ先と、端末の控え
// -----------------------------------------------------------------------------
// なぜこれが要るか（実測 2026-09-04）:
//   2026-08-30 に「ポートは必ず .env.local から読む」と直したのは
//   ③本体(src/App.jsx)**1ファイルだけ**だった。同じリポジトリの
//   src/AssemblyPortal.jsx（組立の連絡ポータル ?renraku=1）は
//     connectFirestoreEmulator(db, '127.0.0.1', 8080)
//     connectAuthEmulator(getAuth(fbApp), 'http://127.0.0.1:9099', …)
//   のまま残っていた。ミラーが 8380 に居ても、この道だけ **空の 8080** を見る＝
//   「エミュレータで確かめた」が一度も成り立たない。
//   しかも誰も赤にしなかった（この見張りが無かった）。
//
//   もう1つ。同じファイルは getFirestore(fbApp) の名前付き別インスタンスで、
//   ③本体の端末の控え(persistentLocalCache)を **共有しない**。
//   組立の人が常時開く画面が、開くたびサーバから全件読む形だった。
//
// 🚨 この見張りは **実コードを食う**。src/**.jsx / **.js を読んで、
//    ① エミュレータへ繋ぐ所に **数字を直に書いていないか**（環境変数から読んでいるか）
//    ② Firestore を作る所が **端末の控え** を持っているか
//   を見る。当てはまる所が0箇所なら「何も食べずに緑」になるので、それも赤にする。
//
// 使い方: node scripts/verify-emulator-wiring.mjs [--selftest]
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** 行コメント・ブロックコメントを落とす（コメントの中の 8080 で赤にしない）。 */
export const stripComments = (s) =>
  String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * エミュレータへ繋ぐ1行が「環境変数から読んでいる」か。
 * 🚨 判定は **その呼び出しの丸かっこの中だけ** を見る。行全体を見ると、
 *   同じ行の別の場所に import.meta.env が在るだけで通ってしまう。
 */
export const emulatorCallsOf = (src) => {
  const out = [];
  const text = stripComments(src);
  const re = /connect(?:Firestore|Auth)Emulator\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    // 対応する閉じかっこまで拾う
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    const args = text.slice(re.lastIndex, i - 1);
    const line = text.slice(0, m.index).split('\n').length;
    const kind = m[0].includes('Firestore') ? 'firestore' : 'auth';
    // 「番地(ポート)」を直に書いているか。import.meta.env を通していれば良い。
    let fromEnv = /import\s*\.\s*meta\s*\.\s*env/.test(args);
    // 4桁以上の数字＝ポートの直書き。`|| 8080` のような **逃げ道の既定値** は
    // import.meta.env と一緒に書いてあれば許す(環境変数が無い時の既定)。
    const hasNumber = /\b\d{4,5}\b/.test(args);
    // 🚨 引数が変数の時に「変数だから分からない」で逃げない。
    //   同じファイルの中でその変数がどう作られたかを見て、import.meta.env から
    //   来ていれば通す。追えない変数は **通さない**(unresolved)。
    const idents = [...args.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0])
      .filter((w) => !['http', 'https', 'disableWarnings', 'true', 'false', 'Number', 'String',
        'db', 'auth', 'firestore', 'getAuth', 'fbApp', 'app'].includes(w));
    const unresolved = [];
    if (!fromEnv && !hasNumber) {
      for (const id of idents) {
        const def = text.match(new RegExp(`(?:const|let|var)\\s+${id}\\s*=([^;\\n]*)`));
        if (def && /import\s*\.\s*meta\s*\.\s*env/.test(def[1])) fromEnv = true;
        else if (def) unresolved.push(id);
        // 定義が見つからない語(関数名・文字列の中身など)は数えない
      }
    }
    out.push({ kind, line, args: args.replace(/\s+/g, ' ').trim(), fromEnv, hasNumber,
      unresolved,
      // ①数字の直書きで環境変数を通していない ②変数を追っても環境変数に届かない
      bad: (hasNumber && !fromEnv) || (!hasNumber && !fromEnv) });
  }
  return out;
};

/**
 * Firestore を作る所が端末の控えを持っているか。
 * 🚨 見るのは「**名前を付けた別インスタンス**」を作っているファイルだけ。
 *   理由(実測): getFirestore(既に作ってあるapp) は **同じ物を返す** ので、
 *   ③本体が控え付きで作った既定のappを使い回すファイル(src/demoGate.jsx など)は
 *   控えを持っている。そこまで赤にすると「直しようの無い赤」を配る事になる。
 *   名前付き(initializeApp(cfg, 'assembly-portal'))だけは **別の物** なので、
 *   自分で控えを付けないと控え無しになる。ここが 2026-09-04 に見つかった穴。
 */
export const firestoreInitsOf = (src) => {
  const text = stripComments(src);
  const out = [];
  const re = /(initializeFirestore|getFirestore)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ how: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  const named = [...text.matchAll(/initializeApp\s*\([^;]*?,\s*['"]([^'"]+)['"]\s*\)/g)].map((x) => x[1]);
  const hasCache = /persistentLocalCache\s*\(/.test(text);
  const hasTabs = /persistentMultipleTabManager\s*\(/.test(text);
  return { calls: out, hasCache, hasTabs, named,
    // 名前付きの別インスタンスを作っている＝自分で控えを付けないと控え無し。
    ownsInstance: named.length > 0,
    // getFirestore しか無い＝控え無し。initializeFirestore が在れば控えの有無を見る。
    initializes: out.some((c) => c.how === 'initializeFirestore') };
};

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, acc); }
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) acc.push(p);
  }
  return acc;
};

// ---------------------------------------------------------------------------
// 🧪 見張り自身の試験。🚨 わざと壊した形を食わせて、赤になる事を確かめる。
// ---------------------------------------------------------------------------
export const selftest = () => {
  let ok = true;
  const say = (cond, what) => { if (!cond) ok = false; console.log(`  ${cond ? '✅' : '❌'} ${what}`); };

  const BAD = `connectFirestoreEmulator(db, '127.0.0.1', 8080);
connectAuthEmulator(getAuth(fbApp), 'http://127.0.0.1:9099', { disableWarnings: true });`;
  const GOOD = `connectFirestoreEmulator(db, '127.0.0.1', Number(import.meta.env.VITE_EMULATOR_PORT || 8080));
connectAuthEmulator(auth, \`http://127.0.0.1:\${Number(import.meta.env.VITE_EMULATOR_AUTH_PORT || 9099)}\`, { disableWarnings: true });`;

  const bad = emulatorCallsOf(BAD);
  say(bad.length === 2 && bad.every((c) => c.bad),
    '🚨 ポートを数字で直に書いた2口を、2口とも ❌ にする');
  const good = emulatorCallsOf(GOOD);
  say(good.length === 2 && good.every((c) => !c.bad),
    '環境変数から読んでいる2口は通す（`|| 8080` の逃げ道は既定値なので許す）');

  // 🚨 行全体を見て逃げていないか(同じ行の別の場所に import.meta.env が在るだけの形)
  const TRICK = `if (import.meta.env.DEV) connectFirestoreEmulator(db, '127.0.0.1', 8080);`;
  say(emulatorCallsOf(TRICK)[0].bad === true,
    '🚨 同じ行の別の所に import.meta.env が在るだけでは通さない（見るのは丸かっこの中だけ）');

  // 🚨 コメントの中の 8080 で赤にしない
  const COMMENT = `// ここに 8080 を焼き込んでいた\nconnectFirestoreEmulator(db, '127.0.0.1', Number(import.meta.env.VITE_EMULATOR_PORT || 8080));`;
  say(emulatorCallsOf(COMMENT).every((c) => !c.bad),
    'コメントに書いてある 8080 では赤にしない');

  // 🚨 引数が変数の時に「変数だから分からない」で逃げない（部品検査がこの形）
  const VAR_OK = `const emuHost = String(import.meta.env.VITE_EMULATOR_HOST || '').trim() || '127.0.0.1';
const fsPort = numOr(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT, 8080, 'x');
connectFirestoreEmulator(firestore, emuHost, fsPort);`;
  say(emulatorCallsOf(VAR_OK)[0].bad === false,
    '引数が変数でも、同じファイルで import.meta.env から作られていれば通す');
  const VAR_BAD = `const fsPort = 8080;
connectFirestoreEmulator(firestore, '127.0.0.1', fsPort);`;
  say(emulatorCallsOf(VAR_BAD)[0].bad === true,
    '🚨 変数に 8080 を入れて渡す逃げ方も ❌ にする');

  const noCache = firestoreInitsOf('const db = getFirestore(fbApp);');
  say(noCache.initializes === false && noCache.hasCache === false,
    '🚨 getFirestore だけ＝端末の控えが無い、と見抜く');
  const withCache = firestoreInitsOf(
    'const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });');
  say(withCache.initializes && withCache.hasCache && withCache.hasTabs,
    '控え(persistentLocalCache)と複数タブの管理役が在れば通す');
  const cacheNoTabs = firestoreInitsOf(
    'const db = initializeFirestore(fbApp, { localCache: persistentLocalCache() });');
  say(cacheNoTabs.hasCache && cacheNoTabs.hasTabs === false,
    '🚨 複数タブの管理役が無い形を見抜く（2枚目のタブだけ毎回全部読む）');

  // 🚨 名前付きの別インスタンス（＝既定のappの控えを共有しない）を見抜く
  const NAMED_BAD = `const fbApp = initializeApp(FIREBASE_CONFIG, 'assembly-portal');
const db = getFirestore(fbApp);`;
  const nb = firestoreInitsOf(NAMED_BAD);
  say(nb.ownsInstance && nb.named[0] === 'assembly-portal' && nb.hasCache === false,
    "🚨 名前付き(initializeApp(cfg,'assembly-portal')) + getFirestore = 控え無しの別インスタンス、と見抜く");
  const REUSE = `const fbApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
const db = getFirestore(fbApp);`;
  say(firestoreInitsOf(REUSE).ownsInstance === false,
    '名前を付けずに既定のappを使い回す形は「別インスタンス」と数えない（控えは付けた側のもの）');

  console.log(`🧪 見張り自身の試験: ${ok ? '合格' : '不合格'}`);
  return ok;
};

export const main = () => {
  if (process.argv.includes('--selftest')) return selftest() ? 0 : 1;
  console.log('🧪 見張り自身の試験');
  if (!selftest()) { console.error('❌ 見張り自身が壊れているので、判定は出しません。'); return 1; }

  console.log('\n==========================================================================');
  console.log('🧪🚨 エミュレータの繋ぎ先と、端末の控え');
  console.log(`   見た場所: ${SRC}`);
  console.log('==========================================================================');

  if (!fs.existsSync(SRC)) { console.error(`❌ ${SRC} が無い`); return 1; }
  const files = walk(SRC);
  const reasons = [];
  let calls = 0; let inits = 0; let defaultCache = null;

  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8');
    if (!/connect(?:Firestore|Auth)Emulator|getFirestore|initializeFirestore/.test(src)) continue;

    const em = emulatorCallsOf(src);
    for (const c of em) {
      calls++;
      const mark = c.bad ? '❌' : '✅';
      console.log(`  ${mark} ${rel}:${c.line}  connect${c.kind === 'firestore' ? 'Firestore' : 'Auth'}Emulator(${c.args})`);
      if (c.bad) {
        reasons.push(`${rel}:${c.line} エミュレータの番地(ポート)を数字で直に書いている`
          + '（.env.local を変えても効かない＝「エミュレータで確かめた」が成り立たない）');
      }
    }

    const fi = firestoreInitsOf(src);
    if (!fi.calls.length) continue;
    inits++;
    const full = fi.initializes && fi.hasCache && fi.hasTabs;
    // 名前付きの別インスタンスは、そのファイルの中で控えを付けないと控え無しになる
    // (既定のappの控えは共有しない)。ここが 2026-09-04 に見つかった穴。
    if (fi.ownsInstance) {
      if (full) {
        console.log(`  ✅ ${rel}  名前付き(${fi.named.join('/')})に 端末の控え + 複数タブの管理役 が在る`);
      } else {
        console.log(`  ❌ ${rel}  名前付き(${fi.named.join('/')})なのに 端末の控えが揃っていない`
          + `（initializeFirestore:${fi.initializes} / localCache:${fi.hasCache} / 複数タブ:${fi.hasTabs}）`);
        reasons.push(`${rel} 名前付きの別インスタンス(${fi.named.join('/')})に端末の控えが無い`
          + '（既定のappの控えは共有しない＝開き直すたびサーバから全件読む'
          + '＝4アプリ共有の読み取り枠を食う）');
      }
      continue;
    }
    if (full) { defaultCache = rel; console.log(`  ✅ ${rel}  既定のappに 端末の控え + 複数タブの管理役 を付けている`); }
    else console.log(`  ・${rel}  既定のappの Firestore を使うだけ（控えは付けた側のもの）`);
  }
  // 既定のapp: どこか1つが控えを付けていれば良い(getFirestore は同じ物を返す)。
  if (!defaultCache) {
    reasons.push('既定の Firebase app に端末の控え(persistentLocalCache)を付けているファイルが1つも無い');
  } else {
    console.log(`\n  ✅ 既定のappの控えは ${defaultCache} が付けています（他のファイルはそれを使い回します）`);
  }

  // 🚨 「何も食べずに緑」を防ぐ。当てはまる所が0なら赤。
  if (calls === 0) reasons.push('エミュレータへ繋ぐ所を1箇所も見つけられなかった（数え方が壊れている疑い）');
  if (inits === 0) reasons.push('Firestore を作る所を1箇所も見つけられなかった（数え方が壊れている疑い）');

  console.log('\n==========================================================================');
  if (!reasons.length) {
    console.log(`🚦 ✅ 合格。エミュレータの口 ${calls}箇所 ・ Firestore を作るファイル ${inits}件 を見ました。`);
    console.log('==========================================================================');
    return 0;
  }
  console.log('🚦 ❌ 不合格。出荷しないでください。');
  reasons.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));
  console.log('   ポートは `Number(import.meta.env.VITE_EMULATOR_PORT || 8080)` の形で読む事。');
  console.log('   控えは `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`。');
  console.log('==========================================================================');
  return 1;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main());
