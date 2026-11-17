// 見本の入口: SAP 工程の進みだけを出す(Firebase・App.jsx を読み込まない)
// ?auto=http://127.0.0.1:ポート/ を付けると、同じ PC の写しを自動で読む(画面確認用・127.0.0.1 だけ)
import { createRoot } from 'react-dom/client';
import './index.css';
import SapProgressPanel from './SapProgressPanel.jsx';

const auto = new URLSearchParams(location.search).get('auto');
const autoUrl = auto && /^http:\/\/127\.0\.0\.1:\d+\//.test(auto) ? auto : null;
const autoStage = new URLSearchParams(location.search).get('stage');
createRoot(document.getElementById('root')).render(
    <div className="max-w-5xl mx-auto p-3"><SapProgressPanel force autoUrl={autoUrl} autoStage={autoStage} /></div>
);
