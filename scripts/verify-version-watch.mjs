// ============================================================================
// 🚨🚨 版の見張りの「配線」を機械で確かめる (2026-08-19)
// ----------------------------------------------------------------------------
// 【なぜ要るか】
//   2026-08-19 の点検で分かった事:
//     ・index.html が `startVersionWatch()` と直に書いていたが、その名前は index.html の
//       中に無い(中身は src/versionWatch.js の export で、誰も import していなかった)。
//       → 毎回 ReferenceError。しかもそれが ErrorBoundary の「最後に落ちた理由」を
//         上書きして、**本物の白画面の原因を消していた**。
//     ・window.__appCanReload は startVersionWatch の中でしか代入されず、常に undefined。
//       → 「まだ送れていない保存がある間は押させない」関所は **完全に素通り**。
//     ・window.__appSaveStatus は **誰も代入していない**。→ canReload(null) で全部通る。
//     ・「あとで」を聞く側が動いていない。→ 札が連続で出る。
//   それでも appVersion.test.mjs(23件) は **全部緑** だった。純関数しか見ていないから。
//
//   ＝ **「試験が緑」と「機能が動く」は別物**。この見張りは その隙間だけを見る。
//      見るのは「AがBを呼ぶ時の名前が、Bが名乗っている名前と同じか」＝ 配線。
//
// 【約束】
//   ⚠ 誤検出する見張りは、いずれ全部無視される。
//     → analyzeWiring() は **純関数**(ファイルを読まない)。
//       scripts/selftest-version-watch.mjs が「わざと配線を外したら落ちる」を毎回確かめる。
//   ⚠ この見張り自身も node --test から走る
//     (src/domain/__tests__/versionWatchWiring.test.mjs)。**手で走らせる物にしない**。
//
// 【使い方】
//   node scripts/verify-version-watch.mjs            … このリポを見る
//   node scripts/verify-version-watch.mjs --json     … 機械が読む形で出す
//   APP_ROOT=<path> node scripts/verify-version-watch.mjs … 別のアプリを見る
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------------------
// 🔗 約束した名前。**ここが唯一の台帳**。
//   片側だけ名前を変えたら、もう片側で見つからなくなって落ちる = それが狙い。
//   両側そろえて変えるなら、ここも変える(変えないと落ちる = 台帳が腐らない)。
// ----------------------------------------------------------------------------
export const CONTRACT = {
  start: '__startVersionWatch', // main.jsx が置く  → index.html が呼ぶ
  gate: '__appCanReload',       // versionWatch.js が置く → index.html が見る
  save: '__appSaveStatus',      // App.firebase.jsx が置く → versionWatch.js が読む
  show: '__showUpdateNotice',   // index.html が置く → versionWatch.js が呼ぶ
  later: 'app-update-later',    // index.html が飛ばす → versionWatch.js が聞く
  metaBuild: 'app-build',       // vite.config.js が焼く → versionWatch.js が読む
  metaBuiltAt: 'app-built-at',  // 同上(いつ焼いたか)
};

/** 見るファイル(この鍵で files に渡す)。＝ 最終検査(golden)の作り。 */
export const WIRING_FILES = [
  'index.html',
  'src/main.jsx',
  'src/versionWatch.js',
  'src/App.firebase.jsx',
  'vite.config.js',
];

// ----------------------------------------------------------------------------
// 🚨 2026-08-30: 4アプリで走る様にした。
//   きっかけ: **関所(__appCanReload)が最終検査にしか無かった**。
//   製品検査・部品検査・司令塔③ は `go.onclick = hardReload` で、
//   まだ送れていない保存が有っても「切り替える」を押した瞬間に読み直していた。
//   ＝ 2026-08-17 に作業時間が丸ごと消えたのと同じ引き金を、
//     2026-08-18 に「対策」として3アプリへ配ってしまっていた。
//
//   ⚠4アプリは版の見張りの作りが違う(今は揃えない。清水さんの決定 2026-08-30):
//     ・golden … vite が焼く <meta app-build> と /version.json(100バイト弱)を10分ごと。
//     ・他の3つ … index.html(約20KB)を5分ごとに取って、玉の名前を比べる。
//   だから「版の見張り」の見方は分けるが、**関所は4アプリ共通で必ず見る**。
//   ⚠見方を分けた事は必ず画面に出す(どちらで見たか分からない見張りは信用されない)。
// ----------------------------------------------------------------------------
/** 司令塔③・製品検査・部品検査(index.html の中で見張る作り)で見るファイル。 */
export const WIRING_FILES_INLINE = [
  'index.html',
  'src/main.jsx',
  'src/reloadGate.js',
  'src/App.jsx',
  'src/domain/appVersion.js',
];

/**
 * どちらの作りかを **渡された中身から** 決める。
 * ⚠「versionWatch.js が無いから inline」だけで決めない。
 *   それだと golden の versionWatch.js を消した時に、見方が黙って切り替わり、
 *   golden 向けの確認が **1件も走らないまま緑**になる(いちばん危ない壊れ方)。
 *   index.html が __startVersionWatch を呼んでいるなら golden の作りのまま = 欠けを赤にする。
 */
export function profileOfFiles(files) {
  const watch = String((files && files['src/versionWatch.js']) || '');
  const html = String((files && files['index.html']) || '');
  if (watch.trim() !== '' || /window\.__startVersionWatch/.test(html)) return 'golden';
  return 'inline';
}

/** その作りで見るファイルの一覧。 */
export const filesForProfile = (profile) => (profile === 'golden' ? WIRING_FILES : WIRING_FILES_INLINE);

// ----------------------------------------------------------------------------
// 下ごしらえ(全部 純関数)
// ----------------------------------------------------------------------------

/**
 * コメントを落とす。⚠「コメントに書いてあるだけ」を配線と数えない為。
 * ⚠ index.html は説明の HTML コメントが長く、その中に window.__appCanReload 等の名前が
 *   そのまま書いてある。落とさないと **説明文だけで合格**してしまう(嘘の合格)。
 */
const stripHtmlComments = (src) => String(src).replace(/<!--[\s\S]*?-->/g, '');
const stripLineComments = (src) => String(src)
  .split('\n')
  .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
  .join('\n');

/**
 * `const NAME = '値'` を実際の値に開く。
 * ⚠ 定数を解けないと「addEventListener(LATER_EVENT」を見逃して **嘘の合格**を出す
 *   (verify-save-safety.mjs が同じ穴で 0件と言った前科がある)。
 */
export const expandConsts = (src) => {
  let out = String(src);
  const re = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^'\n]{1,80})'\s*;/g;
  const table = [];
  let m;
  while ((m = re.exec(out))) table.push([m[1], m[2]]);
  for (const [name, value] of table) {
    out = out.replace(new RegExp(`(?<![.\\w])${name}(?![\\w])`, 'g'), `'${value}'`);
  }
  return out;
};

/** 見張りが実際に読む形(コメントを落として定数を開いた形)。 */
export const codeOf = (src) => {
  const t = stripLineComments(stripHtmlComments(src));
  // ⚠3MB級のファイル(App.firebase.jsx)で定数を開くと何十秒もかかる。
  //   定数で名前を隠しているのは versionWatch.js だけなので、小さいファイルだけ開く。
  return t.length > 200000 ? t : expandConsts(t);
};

// ----------------------------------------------------------------------------
// 本体
// ----------------------------------------------------------------------------
/**
 * @param {Record<string,string>} files  { 'index.html': 中身, ... }
 * @returns {{findings: Array<{id:string,file:string,msg:string}>}}
 */
export function analyzeWiring(files, profile = profileOfFiles(files)) {
  const findings = [];
  const add = (id, file, msg) => findings.push({ id, file, msg });

  // 🚨 読めなかったファイルが在るのに「0件・合格」と言わない。
  for (const f of filesForProfile(profile)) {
    if (typeof files[f] !== 'string' || files[f].trim() === '') {
      add('VW-000', f, '中身が読めませんでした。**この見張りは何も見ていません**(合格にしない)。');
    }
  }
  if (findings.length) return { findings, profile };

  const raw = (f) => String(files[f] || '');
  const html = codeOf(raw('index.html'));
  const main = codeOf(raw('src/main.jsx'));

  // 「export function 名前(」の中身だけを切り出す(次の export まで)。
  // ⚠ 名前は **括弧まで**で見る。前方一致で見ると installReloadGateXX を
  //   installReloadGate と取り違えて、消したのに合格する(実測で嘘の合格が出た)。
  const bodyOf = (src, name) => {
    const m = new RegExp(`export\\s+function\\s+${name}\\s*\\(`).exec(src);
    if (!m) return '';
    const i = m.index;
    const j = src.indexOf('\nexport ', i + 1);
    return src.slice(i, j < 0 ? src.length : j);
  };

  // index.html の中の「function 名前(」の中身を切り出す(次の function まで)。
  const fnBodyOf = (src, name) => {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
    if (!m) return '';
    const i = m.index;
    const j = src.indexOf('\n        function ', i + 1);
    return src.slice(i, j < 0 ? src.length : j);
  };

  if (profile !== 'golden') return { findings: analyzeInline({ add, findings, html, main, raw, bodyOf, fnBodyOf }), profile };

  const watch = codeOf(raw('src/versionWatch.js'));
  const app = codeOf(raw('src/App.firebase.jsx'));
  const vite = codeOf(raw('vite.config.js'));

  // ── ① 見張りを始める配線 ──────────────────────────────────────────────
  if (!/from\s+['"]\.\/versionWatch\.js['"]/.test(main)) {
    add('VW-001', 'src/main.jsx', 'src/versionWatch.js を import していません。**import が無い物は一生動きません**(2026-08-19 の正体)。');
  }
  if (!new RegExp(`window\\.${CONTRACT.start}\\s*=`).test(main)) {
    add('VW-002', 'src/main.jsx', `window.${CONTRACT.start} に代入していません。index.html はこの名前しか呼びません。`);
  }
  if (!/\bstartVersionWatch\s*\(/.test(main)) {
    add('VW-003', 'src/main.jsx', 'startVersionWatch() を呼ぶ所がありません(window へ置くだけでは、誰も呼ばなければ動きません)。');
  }
  if (!new RegExp(`window\\.${CONTRACT.start}\\s*\\(`).test(html)) {
    add('VW-004', 'index.html', `window.${CONTRACT.start}() を呼んでいません。見張りが始まりません。`);
  }
  // 🚨 2026-08-19 に実際に起きた形そのもの: index.html の中に無い名前を裸で呼ぶ。
  if (/(^|[^.\w])startVersionWatch\s*\(/m.test(html)) {
    add('VW-005', 'index.html', '`startVersionWatch(` を裸で呼んでいます。**その名前は index.html の中に存在しません**(毎回 ReferenceError → 白画面の原因を上書きする)。window.' + CONTRACT.start + ' 経由で呼ぶ事。');
  }

  // ── ② 押させない関所の配線 ────────────────────────────────────────────
  const gateBody = bodyOf(watch, 'installReloadGate');
  if (!gateBody) {
    add('VW-010', 'src/versionWatch.js', 'installReloadGate() がありません。関所を **見張りと切り離して** 置く事(印の無いビルドでも関所は要る)。');
  } else if (!new RegExp(`window\\.${CONTRACT.gate}\\s*=`).test(gateBody)) {
    add('VW-011', 'src/versionWatch.js', `installReloadGate() の中で window.${CONTRACT.gate} に代入していません。`);
  }
  if (!/\binstallReloadGate\s*\(\s*\)/.test(main)) {
    add('VW-012', 'src/main.jsx', 'installReloadGate() を呼んでいません。関所が置かれず、送信待ちでも押せてしまいます(2026-08-17 と同じ穴)。');
  }
  if (!new RegExp(`window\\.${CONTRACT.gate}`).test(html)) {
    add('VW-013', 'index.html', `window.${CONTRACT.gate} を見ていません。ボタンが無条件に押せます。`);
  }
  if (!new RegExp(`window\\.${CONTRACT.save}\\s*=\\s*saveStatus`).test(app)) {
    add('VW-014', 'src/App.firebase.jsx', `window.${CONTRACT.save} = saveStatus の代入がありません。**代入が無いと関所は素通り**(canReload(null) は「送る物が無い」と答える)。`);
  }
  if (!new RegExp(`window\\.${CONTRACT.save}`).test(watch)) {
    add('VW-015', 'src/versionWatch.js', `window.${CONTRACT.save} を読んでいません。関所が保存の状態を見ていません。`);
  }
  if (!/\bcanReload\s*\(/.test(watch)) {
    add('VW-016', 'src/versionWatch.js', 'canReload() を使っていません。判定は domain 側の1か所に置く事(枝を散らさない)。');
  }
  if (!/go\.disabled\s*=\s*true/.test(html)) {
    add('VW-017', 'index.html', '送信待ちの間にボタンを押せない見た目にしていません(押してから断ると必ず連打されます)。');
  }

  // ── ③ 知らせの配線 ───────────────────────────────────────────────────
  if (!new RegExp(`window\\.${CONTRACT.show}\\s*=`).test(html)) {
    add('VW-020', 'index.html', `window.${CONTRACT.show} を置いていません。見張りが知らせを出せません。`);
  }
  if (!new RegExp(`window\\.${CONTRACT.show}\\s*\\(`).test(watch)) {
    add('VW-021', 'src/versionWatch.js', `window.${CONTRACT.show}() を呼んでいません。`);
  }

  // ── ④ 「あとで」が本当に効く ──────────────────────────────────────────
  if (!new RegExp(`Event\\(\\s*'${CONTRACT.later}'`).test(html)) {
    add('VW-030', 'index.html', `「あとで」で '${CONTRACT.later}' を飛ばしていません。`);
  }
  if (!new RegExp(`addEventListener\\(\\s*'${CONTRACT.later}'`).test(watch)) {
    add('VW-031', 'src/versionWatch.js', `'${CONTRACT.later}' を聞いていません。**聞く側が居ないと「あとで」は効かず、札が連続で出ます**。`);
  }
  if (!/\bnextSnoozeUntil\s*\(/.test(watch)) {
    add('VW-032', 'src/versionWatch.js', 'nextSnoozeUntil() を使っていません。「あとで」を押しても黙りません。');
  }

  // ── ⑤ 勝手に読み直さない / 枠を使わない / 裏では取りに行かない ────────
  if (/location\.(reload|replace)\s*\(|location\.href\s*=/.test(watch)) {
    add('VW-040', 'src/versionWatch.js', '🚨 見張りの中で画面を読み直しています。**読み直すのは人が押した時だけ**(検査の途中で画面が飛ぶと入力が消えます)。');
  }
  if (/from\s+['"]firebase|firebase\/firestore|onSnapshot\s*\(/.test(watch)) {
    add('VW-041', 'src/versionWatch.js', '🚨 Firestore を通っています。版の確認は読み取り枠を1件も使わない事(/version.json は Hosting の静的ファイル)。');
  }
  if (!/\/version\.json/.test(watch)) {
    add('VW-042', 'src/versionWatch.js', '/version.json を取りに行っていません。');
  }
  if (!/cache:\s*'no-store'/.test(watch)) {
    add('VW-043', 'src/versionWatch.js', "cache:'no-store' が付いていません。端末の控えを読んで永久に古い印を見ます。");
  }
  if (!/hidden:\s*!!document\.hidden/.test(watch)) {
    add('VW-044', 'src/versionWatch.js', '画面が裏に回っているかを判定へ渡していません(裏のタブで通信します)。');
  }
  if (!/\bbackoffMs\s*\(/.test(watch)) {
    add('VW-045', 'src/versionWatch.js', '失敗が続いた時に間隔を伸ばしていません(取れない環境で永久に取りに行きます)。');
  }

  // ── ⑥ いつ更新されたかが分かる ────────────────────────────────────────
  if (!new RegExp(`name:\\s*'${CONTRACT.metaBuild}'`).test(vite)) {
    add('VW-050', 'vite.config.js', `<meta name="${CONTRACT.metaBuild}"> を焼き込んでいません。画面が自分の版を名乗れません。`);
  }
  if (!new RegExp(`name:\\s*'${CONTRACT.metaBuiltAt}'`).test(vite)) {
    add('VW-051', 'vite.config.js', `<meta name="${CONTRACT.metaBuiltAt}"> を焼き込んでいません。「いま自分がいつの版か」を出せません。`);
  }
  if (!/fileName:\s*'version\.json'/.test(vite)) {
    add('VW-052', 'vite.config.js', 'version.json を出していません。サーバ側の「今の版」が置かれません。');
  }
  if (!/\bbuildTimeText\s*\(/.test(watch)) {
    add('VW-053', 'src/versionWatch.js', 'buildTimeText() を使っていません。知らせに時刻が出ません(清水さん 2026-08-19「いつ更新されたかわからない」)。');
  }
  if (!new RegExp(`window\\.${CONTRACT.show}\\s*\\(\\s*\\{`).test(watch)) {
    add('VW-054', 'src/versionWatch.js', `window.${CONTRACT.show}() に時刻を渡していません(引数なしで呼ぶと、札に「いつ」が出ません)。`);
  }
  if (!/function\s+showUpdateNotice\s*\(\s*detail\s*\)/.test(html)) {
    add('VW-055', 'index.html', 'showUpdateNotice(detail) が時刻を受け取る形になっていません。');
  }
  if (!/__update_when/.test(html)) {
    add('VW-056', 'index.html', '札に「いつ配られたか」を出す場所がありません。');
  }

  // ── ⑦ 逃げ道(2026-08-30 に足した。⚠ただし一発では実行しない) ──────────
  //   🚨関所だけ有って逃げ道が無いと、送信が永久に詰まった時に **画面を開き直せなくなる**。
  //     閉じ込められる方が、関所が開くより重い事故になり得る。
  //     ⚠ここは inline の作り(VW-130/131)と同じ物を見ている。4アプリで同じ形にする事。
  if (!/__update_force\b/.test(html)) {
    add('VW-060', 'index.html', '🚨 逃げ道がありません。送信が永久に詰まると **画面を開き直せなくなります**(関所より重い事故)。');
  }
  if (!/__update_force_confirm/.test(html) || !/__update_force_no/.test(html)) {
    add('VW-061', 'index.html', '逃げ道に確かめがありません。**一発で取り消せない事をさせない**(2026-08-21 の背景タップと同じ話)。「やめる」で戻れる形にする事。');
  }

  return { findings, profile };
}

/**
 * 製品検査・部品検査・司令塔③(index.html の中で見張る作り)の配線。
 *
 * 🚨 ここの主役は **関所**。2026-08-18〜2026-08-30 のあいだ、3アプリは
 *   `go.onclick = hardReload` で、まだ送れていない保存が有っても押した瞬間に読み直していた。
 *   2026-08-17 に「作業時間が丸ごと消えた(復旧不可)」のは、まさにその送れていない書き込み。
 *   ⚠版の見張りの作りは今アプリごとに違う(清水さんの決定)。だから **版の見方は緩く、
 *     関所は固く** 見る。関所はどの作りでも同じでなければならない。
 */
function analyzeInline({ add, findings, html, main, raw, bodyOf, fnBodyOf }) {
  const gate = codeOf(raw('src/reloadGate.js'));
  const app = codeOf(raw('src/App.jsx'));
  const domain = codeOf(raw('src/domain/appVersion.js'));

  // ── ① 関所(4アプリ共通で必ず在る事) ────────────────────────────────────
  const gateBody = bodyOf(gate, 'installReloadGate');
  if (!gateBody) {
    add('VW-100', 'src/reloadGate.js', 'installReloadGate() がありません。関所を **版の見張りと切り離して** 置く事(版の印が無くても関所は要る)。');
  } else if (!new RegExp(`window\\.${CONTRACT.gate}\\s*=`).test(gateBody)) {
    add('VW-101', 'src/reloadGate.js', `installReloadGate() の中で window.${CONTRACT.gate} に代入していません。`);
  }
  if (!/from\s+['"]\.\/reloadGate\.js['"]/.test(main)) {
    add('VW-102', 'src/main.jsx', 'src/reloadGate.js を import していません。**import が無い物は一生動きません**。');
  }
  if (!/\binstallReloadGate\s*\(\s*\)/.test(main)) {
    add('VW-103', 'src/main.jsx', 'installReloadGate() を呼んでいません。関所が置かれず、送信待ちでも押せてしまいます(2026-08-17 と同じ穴)。');
  }
  if (!new RegExp(`window\\.${CONTRACT.gate}`).test(html)) {
    add('VW-104', 'index.html', `window.${CONTRACT.gate} を見ていません。「切り替える」が無条件に押せます。`);
  }
  if (!new RegExp(`window\\.${CONTRACT.save}\\s*=\\s*saveStatus`).test(app)) {
    add('VW-105', 'src/App.jsx', `window.${CONTRACT.save} = saveStatus の代入がありません。**代入が無いと関所は素通り**(canReload(null) は「送る物が無い」と答える)。`);
  }
  if (!new RegExp(`window\\.${CONTRACT.save}`).test(gate)) {
    add('VW-106', 'src/reloadGate.js', `window.${CONTRACT.save} を読んでいません。関所が保存の状態を見ていません。`);
  }
  if (!/\bcanReload\s*\(/.test(gate)) {
    add('VW-107', 'src/reloadGate.js', 'canReload() を使っていません。判定は domain 側の1か所に置く事(枝を散らさない)。');
  }
  if (!/export\s+function\s+canReload\s*\(/.test(domain)) {
    add('VW-108', 'src/domain/appVersion.js', 'canReload() がありません。判定の本体が無いと、関所は形だけになります。');
  }
  if (!new RegExp(`window\\.${CONTRACT.save}\\s*=\\s*\\{\\s*unknown:\\s*true\\s*\\}`).test(app)) {
    add('VW-109', 'src/App.jsx', `画面が消える時に window.${CONTRACT.save} = { unknown: true } を置いていません。null で片付けると canReload が「押してよい」に化けます(golden で 2026-08-20 実測)。`);
  }

  // ── ② 押させない見た目と、押す直前の見直し ────────────────────────────
  if (!/go\.disabled\s*=\s*true/.test(html)) {
    add('VW-120', 'index.html', '送信待ちの間にボタンを押せない見た目にしていません(押してから断ると必ず連打されます)。');
  }
  const goClick = html.slice(html.indexOf('go.onclick'));
  if (/go\.onclick\s*=\s*hardReload/.test(html)) {
    add('VW-121', 'index.html', '🚨 go.onclick = hardReload です。**押した瞬間に読み直します**。2026-08-17 に作業が消えた引き金そのものです。');
  } else if (!/if\s*\(!g\.allowed\)/.test(goClick)) {
    add('VW-122', 'index.html', '押す直前にもう一度 関所を見ていません(札を出してから押すまでの間に保存が始まる事があります)。');
  }
  if (!/setInterval\(\s*paintGate\s*,/.test(html)) {
    add('VW-123', 'index.html', '送信待ちの表示を塗り直していません。送り終わっても押せるようにならず、人を待たせっぱなしにします。');
  }

  // ── ③ 逃げ道(⚠ただし一発では実行しない) ──────────────────────────────
  if (!/__update_force\b/.test(html)) {
    add('VW-130', 'index.html', '🚨 逃げ道がありません。送信が永久に詰まると **画面を開き直せなくなります**(関所より重い事故)。');
  }
  if (!/__update_force_confirm/.test(html) || !/__update_force_no/.test(html)) {
    add('VW-131', 'index.html', '逃げ道に確かめがありません。**一発で取り消せない事をさせない**(2026-08-21 の背景タップと同じ話)。「やめる」で戻れる形にする事。');
  }

  // ── ④ 知らせと見張り(index.html の中で回す作り) ──────────────────────
  if (!/function\s+showUpdateNotice\s*\(/.test(html)) {
    add('VW-140', 'index.html', '「新しい版が出ました」の札がありません。開きっぱなしの端末は古い版のまま気付けません。');
  }
  if (!/function\s+checkVersion\s*\(/.test(html)) {
    add('VW-141', 'index.html', '版を見に行く所がありません。');
  }
  if (!/cache:\s*'no-store'/.test(html)) {
    add('VW-142', 'index.html', "cache:'no-store' が付いていません。端末の控えを読んで永久に古い版を見ます。");
  }
  if (!/document\.hidden/.test(html)) {
    add('VW-143', 'index.html', '裏に回っている画面でも取りに行っています(見ていない画面で通信しない事)。');
  }
  // ⚠`snoozeUntil =` だけを見ると、いちばん上の宣言(var snoozeUntil = 0)で合格してしまう。
  //   「あとで」で **実際に黙らせている** 式まで見る。
  if (!/snoozeUntil\s*=\s*Date\.now\(\)\s*\+\s*SNOOZE_MS/.test(html)) {
    add('VW-144', 'index.html', '「あとで」を押しても黙りません(札が連続で出ると、現場は必ず無視するようになります)。');
  }
  const check = fnBodyOf(html, 'checkVersion');
  if (check && /hardReload\s*\(|location\.(reload|replace)\s*\(/.test(check)) {
    add('VW-145', 'index.html', '🚨 見張りの中で画面を読み直しています。**読み直すのは人が押した時だけ**(検査の途中で画面が飛ぶと入力が消えます)。');
  }

  return findings;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.APP_ROOT || path.join(HERE, '..');

/**
 * 実ファイルを読む(見張り本体は純関数のまま保つ)。
 * ⚠ 2つの作りの **両方**のファイルを読む。どちらの作りかは中身を見てから決めるので、
 *   先に決め打ちすると「読んでいないから合格」が起きる。
 */
export function readWiringFiles(root = REPO_ROOT) {
  const files = {};
  for (const f of [...new Set([...WIRING_FILES, ...WIRING_FILES_INLINE])]) {
    try { files[f] = fs.readFileSync(path.join(root, f), 'utf8'); } catch { files[f] = ''; }
  }
  return files;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const wiring = readWiringFiles();
  const { findings, profile } = analyzeWiring(wiring);
  // ⚠どちらの作りとして見たかを必ず出す。黙って見方を変える見張りは信用されない。
  const how = profile === 'golden'
    ? '最終検査の作り(/version.json を src/versionWatch.js が見る)'
    : 'index.html の中で見張る作り(製品検査・部品検査・司令塔③)';
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ root: REPO_ROOT, profile, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`✅ 版の見張りと関所の配線: 合格（${how}として見ました）`);
  } else {
    console.log(`🚨 版の見張りと関所の配線: ${findings.length}件（${how}として見ました）`);
    for (const f of findings) console.log(`  [${f.id}] ${f.file}\n      ${f.msg}`);
  }
  process.exit(findings.length ? 1 : 0);
}