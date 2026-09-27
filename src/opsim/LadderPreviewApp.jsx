// ============================================================================
// 👁 試写の画面部品 — 操業シミュレーションを、控えのデータで出す(製品検査)
// ----------------------------------------------------------------------------
// なぜこのファイルが在るか(2026-09-05):
//   試写の入口 src/opsim/ladderPreview.jsx に **画面部品と起動の両方**が入っていて、
//   eslint の react-refresh/only-export-components が
//   「部品が在るのに export が1つも無い＝部品を別ファイルへ出しなさい」と1件増やしていました
//   （門の段1 の基準値 30 → 31 で赤）。
//   🚨 基準値の紙を書き換えて緑にするのは禁止。**言われたとおり部品を別ファイルへ出しました**。
//     ・このファイル … 画面部品だけ（export は部品1つだけ＝規則が求める形）
//     ・ladderPreview.jsx … 起動だけ（部品を1つも定義しない＝規則が鳴らない形）
//
// 🚨 これは本番の画面ではありません。dist には入りません
//   （vite.config.js に入口の追加が無いので、build が見るのは index.html だけ）。
// 🚨 Firebase を1行も import していません＝本番のデータへ 1バイトも書かない・1回も読まない。
// 🚨 データは ?data=<URL> で渡した所から fetch した JSON だけ（GET だけ）。
// ============================================================================
import React from 'react';
import '../index.css';
import OperationsSimulationPanel from '../OperationsSimulationPanel.jsx';

/**
 * 控えの JSON を1本読んで、操業シミュレーションの画面をそのまま出すだけの入れ物。
 * 🚨 ここで数字を1つも作りません（読んで渡すだけ）。
 */
export function LadderPreviewApp() {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('data');
    if (!url) { setErr('?data=<JSONのURL> を付けてください。'); return undefined; }
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`読めませんでした (${r.status})`))))
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { if (alive) setErr(String(e && e.message ? e.message : e)); });
    return () => { alive = false; };
  }, []);

  if (err) return <div className="p-4 text-sm font-bold text-rose-700">{err}</div>;
  if (!data) return <div className="p-4 text-sm font-bold text-slate-600">控えを読んでいます…</div>;

  return (
    <div className="min-h-screen bg-slate-100 p-3">
      <div className="mb-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-2xs font-black text-amber-800">
        試写(本番の画面ではありません)。控え {data.lots.length}ロット。Firebase へは繋いでいません。
      </div>
      <OperationsSimulationPanel
        lots={data.lots}
        templates={data.templates}
        workers={data.workers}
        settings={data.settings}
        canEdit={false}
        arrivalByLot={data.arrivalByLot || {}}
        factoryCalendar={data.factoryCalendar || null}
      />
    </div>
  );
}

export default LadderPreviewApp;
