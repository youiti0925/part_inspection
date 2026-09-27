// ============================================================================
// 👁 試写だけの入口 — 操業シミュレーションの画面を、控えのデータで出す(製品検査)
// ----------------------------------------------------------------------------
// なぜ要るか(2026-09-04):
//   「効く手のはしご」(決まり23)を **実データの実画面で撮る** ため。
//   本番の Firestore へは 1バイトも書かない・1回も読まない事を機械で保証したいので、
//   Firebase を **1行も import しない** 入口を分けています。
//
// 🚨 これは本番の画面ではありません。dist には入りません(index.html からは辿れません)。
// 🚨 データは ?data=<URL> で渡した所から fetch した JSON だけ(GET だけ)。
//
// 🚨 2026-09-05: このファイルには **画面部品と起動の両方** が入っていました。
//   eslint の react-refresh/only-export-components が
//   「部品が在るのに export が1つも無い」で1件増え、門の段1（基準値 30 → 31）が赤でした。
//   🚨 基準値の紙を書き換えて緑にするのは禁止。**画面部品を別ファイルへ出しました**。
//     ・画面部品 … src/opsim/LadderPreviewApp.jsx（export は部品1つだけ）
//     ・このファイル … 起動だけ。**部品を1つも定義しない**ので規則が鳴りません。
//
// 使い方:
//   npm run dev -- --port 5440
//   http://localhost:5440/ladder-preview.html?data=http://127.0.0.1:5441/product.json
// ============================================================================
import { createRoot } from 'react-dom/client';
import { LadderPreviewApp } from './LadderPreviewApp.jsx';

createRoot(document.getElementById('root')).render(<LadderPreviewApp />);
