// 見本の入口: SAP 工程の進みだけを出す(Firebase・App.jsx を読み込まない)
// ?auto=http://127.0.0.1:ポート/ を付けると、同じ PC の写しを自動で読む(画面確認用・127.0.0.1 だけ)
import { createRoot } from 'react-dom/client';
import './index.css';
import SapProgressPanel from './SapProgressPanel.jsx';

const auto = new URLSearchParams(location.search).get('auto');
const autoUrl = auto && /^http:\/\/127\.0\.0\.1:\d+\//.test(auto) ? auto : null;
const autoStage = new URLSearchParams(location.search).get('stage');
const autoDays = Number(new URLSearchParams(location.search).get('days')) || null;
const autoSort = new URLSearchParams(location.search).get('sort');
const autoMg = new URLSearchParams(location.search).get('mg');
// 確かめ用: ?moves=<JSON> で 手で回した工程を端末の中に仕込む(画面の確認のためだけ)
const seedMoves = new URLSearchParams(location.search).get('moves');
if (seedMoves) { try { JSON.parse(seedMoves); localStorage.setItem('sapProgress:moves', seedMoves); } catch { /* 読めなければ仕込まない */ } }
const autoSub = new URLSearchParams(location.search).get('sub');
const autoTab = new URLSearchParams(location.search).get('tab') || 'order';
createRoot(document.getElementById('root')).render(
    <div className="max-w-7xl mx-auto p-3"><SapProgressPanel force autoUrl={autoUrl} autoStage={autoStage} autoTab={autoTab} autoDays={autoDays} autoSort={autoSort} autoMg={autoMg} autoSub={autoSub} /></div>
);
