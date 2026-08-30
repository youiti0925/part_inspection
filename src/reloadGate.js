// ============================================================================
// 🚨 reloadGate.js — 「いま読み直してよいか」の関所を window に1つだけ置く
// ============================================================================
//
// 【なぜ要るか(2026-08-30)】
//   2026-08-17: まだサーバへ送れていない保存を抱えた端末で画面が読み直され、
//   その端末に貯まっていた作業がそのまま消えた(復旧できていない)。
//   2026-08-18(事故の翌日)に「🆕 新しい版が出ました → 切り替える」の札を足したが、
//   その時この関所を入れ忘れた。つまり **事故と同じ引き金を、対策として配っていた**。
//   関所が在ったのは最終検査(golden)だけで、製品検査・部品検査・司令塔③には無かった。
//
// 【約束】
//   ⚠ index.html の中の素のJavaScript は React を知らない(知りようが無い)。
//     window に置く以外に渡す道が無いので、**ここが唯一の受け渡し口**。
//   ⚠ 判定の中身は domain/appVersion.js の canReload **ただ1か所**。
//     ここに「unsent が…」と枝を書かない(二重管理は必ず片方が腐る)。
//   ⚠ 版の見張りとは **切り離して**置く事。golden は 2026-08-19 まで
//     「版の印が無いビルドでは関所も置かれない」形で、関所が完全に素通りだった。
//     関所は「新しい版が在るか」とは無関係に、いつでも正しく答えられなければならない。
//   ⚠ 画面(App)が消える時は window.__appSaveStatus に { unknown:true } が置かれる。
//     canReload はそれを「分からない＝押させない」と読む(落ちた瞬間＝未送信を抱えている時)。
//
// 【配線】
//   src/App.jsx        → window.__appSaveStatus に保存の札を置く
//   src/main.jsx       → installReloadGate() を呼ぶ
//   index.html         → window.__appCanReload() を見て「切り替える」を押せなくする
//   scripts/verify-version-watch.mjs が、この4つの名前が繋がっている事を毎回確かめる。
// ============================================================================
import { canReload } from './domain/appVersion.js';

export function installReloadGate() {
  if (typeof window === 'undefined') return;
  // 🚨 保存以外の「まだどこにも残っていない物」も、ここで一言だけ受ける。
  //   (例: 録画中。録っている映像はまだ保存されていないが、canReload は Firestore の
  //    送信待ちしか見ないので、そのままでは押せてしまう)
  window.__appCanReload = () => {
    const busy = typeof window.__appBusyNote === 'string' ? window.__appBusyNote : '';
    if (busy) return { allowed: false, waiting: true, reason: 'busy', label: busy };
    return canReload(window.__appSaveStatus || null);
  };
}
