// ============================================================================
// 🧪 見張り自身の試験 (scripts/verify-version-watch.mjs)
// ----------------------------------------------------------------------------
// ⚠⚠ **配線を見ていない見張りは、配線が外れても緑のまま**。
//   2026-08-19 に実際にそうなっていた(純関数の試験23件が全部緑・機能は0%動作)。
//   だから毎回この試験を通してから実コードを見る。確かめるのは2つ:
//     ① 実コードの写しを **わざと1か所だけ壊すと、狙った番号で落ちる**
//        (落ちなければ、その確認は何も見ていない)
//     ② 壊していない実コードでは **1件も出ない**(直っている物に文句を言わない)
//
//   ⚠ 壊すのは **メモリの中の写し** だけ。ファイルには一切書かない。
//
//   node scripts/selftest-version-watch.mjs
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeWiring, readWiringFiles, WIRING_FILES, WIRING_FILES_INLINE, profileOfFiles, filesForProfile,
} from './verify-version-watch.mjs';

/**
 * 壊し方の一覧。
 *   id     … これを壊したら出るはずの番号
 *   file   … 壊すファイル
 *   find   … 実コードに **必ず在る** 文字(無ければ試験が落ちる = 台帳が腐った合図)
 *   replace… 差し替える文字
 */
export const MUTANTS = [
  // ── 見張りを始める配線 ──
  { id: 'VW-001', file: 'src/main.jsx', find: "from './versionWatch.js'", replace: "from './nowhere.js'", note: 'import を外す(2026-08-19 の正体)' },
  { id: 'VW-002', file: 'src/main.jsx', find: 'window.__startVersionWatch =', replace: 'window.__startVersionWatchTYPO =', note: '置く名前を1文字変える' },
  { id: 'VW-004', file: 'index.html', find: 'window.__startVersionWatch();', replace: 'void 0;', note: '呼ぶのをやめる' },
  { id: 'VW-005', file: 'index.html', find: 'window.__startVersionWatch();', replace: 'startVersionWatch();', note: '🚨2026-08-19 と同じ形(index.html に無い名前を裸で呼ぶ)' },
  // ── 押させない関所 ──
  { id: 'VW-010', file: 'src/versionWatch.js', find: 'export function installReloadGate()', replace: 'export function installReloadGateXX()', note: '関所を置く関数を消す' },
  { id: 'VW-011', file: 'src/versionWatch.js', find: 'window.__appCanReload = ()', replace: 'window.__appCanReloadTYPO = ()', note: '関所の名前を変える' },
  { id: 'VW-012', file: 'src/main.jsx', find: '\ninstallReloadGate()', replace: '\n// 外した', note: '関所を置き忘れる' },
  { id: 'VW-013', file: 'index.html', find: "if (typeof window.__appCanReload === 'function') return window.__appCanReload();", replace: 'return { allowed: true };', note: '🚨説明の HTML コメントには名前が残る = コメントで合格しないかを見る' },
  { id: 'VW-014', file: 'src/App.firebase.jsx', find: 'window.__appSaveStatus = saveStatus;', replace: 'window.__appSaveStatusTYPO = saveStatus;', note: '保存の札を渡さない(2026-08-19 の実測状態)' },
  { id: 'VW-015', file: 'src/versionWatch.js', find: 'window.__appSaveStatus || null', replace: 'null', note: '関所が保存の札を見ない' },
  { id: 'VW-017', file: 'index.html', find: 'go.disabled = true;', replace: 'go.disabled = false;', note: '送信待ちでも押せる見た目にする' },
  // ── 知らせ ──
  { id: 'VW-020', file: 'index.html', find: 'window.__showUpdateNotice = showUpdateNotice;', replace: 'window.__showUpdateNoticeTYPO = showUpdateNotice;', note: '出口の名前を変える' },
  { id: 'VW-021', file: 'src/versionWatch.js', find: 'window.__showUpdateNotice({', replace: 'window.__showUpdateNoticeTYPO({', note: '呼ぶ名前を変える' },
  // ── 「あとで」 ──
  { id: 'VW-030', file: 'index.html', find: "new Event('app-update-later')", replace: "new Event('app-update-nope')", note: '飛ばす合図の名前を変える' },
  { id: 'VW-031', file: 'src/versionWatch.js', find: "const LATER_EVENT = 'app-update-later';", replace: "const LATER_EVENT = 'app-update-nope';", note: '🚨定数の中身を変える(定数を開けない見張りは見逃す)' },
  { id: 'VW-032', file: 'src/versionWatch.js', find: 'nextSnoozeUntil(Date.now())', replace: '0', note: '「あとで」で黙らない' },
  // ── 勝手に読み直さない / 枠を使わない / 裏で取りに行かない ──
  { id: 'VW-040', file: 'src/versionWatch.js', find: 'state.notified = true;', replace: 'state.notified = true; location.reload();', note: '🚨勝手に読み直す' },
  { id: 'VW-041', file: 'src/versionWatch.js', find: 'import {\n  shouldCheck,', replace: "import { onSnapshot } from 'firebase/firestore';\nimport {\n  shouldCheck,", note: '🚨Firestore を通す' },
  { id: 'VW-043', file: 'src/versionWatch.js', find: "cache: 'no-store'", replace: "cache: 'default'", note: '端末の控えを読む' },
  { id: 'VW-044', file: 'src/versionWatch.js', find: 'hidden: !!document.hidden', replace: 'hidden: false', note: '裏のタブでも取りに行く' },
  { id: 'VW-045', file: 'src/versionWatch.js', find: 'backoffMs(intervalMs, state.fails)', replace: 'intervalMs', note: '失敗しても間隔を伸ばさない' },
  // ── いつ更新されたか ──
  { id: 'VW-051', file: 'vite.config.js', find: "name: 'app-built-at'", replace: "name: 'app-built-atX'", note: '版の時刻を焼き込まない' },
  { id: 'VW-052', file: 'vite.config.js', find: "fileName: 'version.json'", replace: "fileName: 'v.json'", note: 'version.json を出さない' },
  { id: 'VW-053', file: 'src/versionWatch.js', find: 'buildTimeText(', replace: 'String(', all: true, note: '時刻を作らない' },
  { id: 'VW-054', file: 'src/versionWatch.js', find: 'window.__showUpdateNotice({', replace: 'window.__showUpdateNotice(0 || {', note: '時刻を渡さない形にする' },
  { id: 'VW-055', file: 'index.html', find: 'function showUpdateNotice(detail) {', replace: 'function showUpdateNotice() {', note: '時刻を受け取らない' },
  { id: 'VW-056', file: 'index.html', find: '__update_when', replace: '__u_w', note: '札に「いつ」を出す場所を消す' },
  // ── 逃げ道(2026-08-30) ──
  { id: 'VW-060', file: 'index.html', find: '__update_force', replace: '__u_f', all: true, note: '🚨逃げ道を丸ごと消す(詰まると画面を開き直せなくなる)' },
  { id: 'VW-061', file: 'index.html', find: '__update_force_confirm', replace: '__u_f_c', all: true, note: '確かめを消す(一発で取り消せない事をさせる)' },
];

/**
 * 製品検査・部品検査・司令塔③(index.html の中で見張る作り)の壊し方。
 * 🚨 主役は **関所**。2026-08-18〜2026-08-30 のあいだ、3アプリは関所なしで配られていた。
 * ⚠ 壊す文字は **1行だけ**にする事。index.html は CRLF なので、
 *   複数行をまたぐ文字は永久に一致しない(実測で「壊す場所が見つかりません」になった)。
 */
export const MUTANTS_INLINE = [
  // ── 関所 ──
  { id: 'VW-100', file: 'src/reloadGate.js', find: 'export function installReloadGate()', replace: 'export function installReloadGateXX()', note: '関所を置く関数を消す' },
  { id: 'VW-101', file: 'src/reloadGate.js', find: 'window.__appCanReload = ()', replace: 'window.__appCanReloadTYPO = ()', note: '関所の名前を変える' },
  { id: 'VW-102', file: 'src/main.jsx', find: "from './reloadGate.js'", replace: "from './nowhere.js'", note: 'import を外す(import が無い物は一生動かない)' },
  { id: 'VW-103', file: 'src/main.jsx', find: 'installReloadGate()', replace: 'void 0', note: '関所を置き忘れる' },
  { id: 'VW-104', file: 'index.html', find: "if (typeof window.__appCanReload === 'function') return window.__appCanReload();", replace: 'return { allowed: true };', note: '🚨説明の HTML コメントには名前が残る = コメントで合格しないかを見る' },
  { id: 'VW-105', file: 'src/App.jsx', find: 'window.__appSaveStatus = saveStatus;', replace: 'window.__appSaveStatusTYPO = saveStatus;', note: '保存の札を渡さない(2026-08-30 まで3アプリが この状態だった)' },
  { id: 'VW-106', file: 'src/reloadGate.js', find: 'window.__appSaveStatus || null', replace: 'null', note: '関所が保存の札を見ない' },
  { id: 'VW-107', file: 'src/reloadGate.js', find: 'return canReload(', replace: 'return ({ allowed: true }) || canReloadX(', note: '判定を domain に頼まない' },
  { id: 'VW-108', file: 'src/domain/appVersion.js', find: 'export function canReload(', replace: 'export function canReloadX(', note: '判定の本体を消す' },
  { id: 'VW-109', file: 'src/App.jsx', find: 'window.__appSaveStatus = { unknown: true }', replace: 'window.__appSaveStatus = null', note: '🚨落ちた瞬間に関所が開く(2026-08-20 に golden で実測した穴)' },
  // ── 押させない見た目と、押す直前の見直し ──
  { id: 'VW-120', file: 'index.html', find: 'go.disabled = true;', replace: 'go.disabled = false;', note: '送信待ちでも押せる見た目にする' },
  { id: 'VW-121', file: 'index.html', find: 'if (go) go.onclick = function () {', replace: 'if (go) go.onclick = hardReload; if (0) go.onclick = function () {', note: '🚨2026-08-18〜30 に3アプリが配っていた形そのもの' },
  { id: 'VW-122', file: 'index.html', find: 'if (!g.allowed) { paintGate(); return; }', replace: 'if (false) { paintGate(); return; }', note: '押す直前の見直しを外す' },
  { id: 'VW-123', file: 'index.html', find: 'setInterval(paintGate, 2000)', replace: 'setInterval(function () {}, 2000)', note: '送り終わっても押せるようにならない(人を待たせっぱなしにする)' },
  // ── 逃げ道 ──
  { id: 'VW-130', file: 'index.html', find: '__update_force', replace: '__u_f', all: true, note: '🚨逃げ道を丸ごと消す(詰まると画面を開き直せなくなる)' },
  { id: 'VW-131', file: 'index.html', find: '__update_force_confirm', replace: '__u_f_c', all: true, note: '確かめを消す(一発で取り消せない事をさせる)' },
  // ── 知らせと見張り ──
  { id: 'VW-140', file: 'index.html', find: 'function showUpdateNotice(', replace: 'function showUpdateNoticeX(', note: '札そのものを消す' },
  { id: 'VW-141', file: 'index.html', find: 'function checkVersion() {', replace: 'function checkVersionX() {', note: '版を見に行かない' },
  { id: 'VW-142', file: 'index.html', find: "cache: 'no-store'", replace: "cache: 'default'", note: '端末の控えを読む' },
  { id: 'VW-143', file: 'index.html', find: 'document.hidden', replace: 'false', all: true, note: '裏のタブでも取りに行く' },
  { id: 'VW-144', file: 'index.html', find: 'snoozeUntil = Date.now() + SNOOZE_MS', replace: 'snoozeUntil = 0', note: '🚨「あとで」で黙らない(宣言だけ見る見張りは、これを見逃す)' },
  { id: 'VW-145', file: 'index.html', find: 'if (theirs && theirs !== mine) showUpdateNotice();', replace: 'if (theirs && theirs !== mine) hardReload();', note: '🚨見張りが勝手に読み直す(検査の途中で画面が飛ぶ)' },
];

/**
 * @param {Record<string,string>} files 実コードの中身
 * @returns {{failures: string[], checked: number}}
 */
export function runSelfTest(files, profile = profileOfFiles(files)) {
  const failures = [];
  const MUTS = profile === 'golden' ? MUTANTS : MUTANTS_INLINE;

  // ── ② 壊していない実コードでは1件も出ない ──
  const clean = analyzeWiring(files, profile);
  for (const f of clean.findings) {
    failures.push(`🚨 壊していない実コードで [${f.id}] ${f.file} が出ました: ${f.msg}`);
  }

  // ── 読めていないファイルを黙って合格にしない ──
  const empty = {};
  for (const f of filesForProfile(profile)) empty[f] = '';
  if (!analyzeWiring(empty, profile).findings.some((f) => f.id === 'VW-000')) {
    failures.push('🚨 ファイルが1つも読めていないのに VW-000 が出ませんでした(黙って合格する見張り)');
  }

  // ── 🚨 見方(作り)の取り違えを黙って通さない ──
  //   golden の versionWatch.js を消しても index.html が __startVersionWatch を呼ぶ限り
  //   golden の作りとして見続ける事(見方が黙って切り替わると、確認が丸ごと消える)。
  if (profile === 'golden') {
    const noWatch = { ...files, 'src/versionWatch.js': '' };
    if (profileOfFiles(noWatch) !== 'golden') {
      failures.push('🚨 versionWatch.js を空にしたら「別の作り」と見なされました = 確認が丸ごと消えます');
    }
  }

  // ── ① わざと壊すと、狙った番号で落ちる ──
  for (const m of MUTS) {
    const src = String(files[m.file] || '');
    if (!src.includes(m.find)) {
      failures.push(`🚨 [${m.id}] 壊す対象が ${m.file} に在りません: ${JSON.stringify(m.find.slice(0, 50))}（実コードを変えたなら、この台帳も直す事）`);
      continue;
    }
    // ⚠ all:true は「その名前が他所にも在る」時に使う(1か所だけ直しても素通りしてしまう為)。
    const broken = { ...files, [m.file]: m.all ? src.replaceAll(m.find, m.replace) : src.replace(m.find, m.replace) };
    // ⚠ 見方は **壊す前の物**を渡す。壊した中身から見方を決め直すと、
    //   壊した事で「別の作り」に化けて、狙った番号が出ないまま緑になる。
    const ids = analyzeWiring(broken, profile).findings.map((f) => f.id);
    if (!ids.includes(m.id)) {
      failures.push(`🚨 [${m.id}] ${m.file} を壊した(${m.note})のに落ちませんでした = その確認は何も見ていません。出たのは [${ids.join(', ') || 'なし'}]`);
    }
  }
  return { failures, checked: MUTS.length, profile };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { failures, checked, profile } = runSelfTest(readWiringFiles());
  // ⚠どちらの作りとして見たかを必ず出す(黙って見方を変える見張りは信用されない)。
  const how = profile === 'golden' ? '最終検査の作り' : 'index.html の中で見張る作り';
  if (failures.length === 0) {
    console.log(`✅ 見張り自身の試験: 合格（${how}・${checked}通りの壊し方すべてで、狙った番号が出ました）`);
    process.exit(0);
  }
  console.log(`🚨 見張り自身の試験: ${failures.length}件（${how}）`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}