// 見本の入口: SAP の検査の到着見込みが 操業シミュレーションの「これから届く」に入る所を確かめる(画面確認用・本番の画面では使わない)
// ?auto=http://127.0.0.1:ポート/ で 同じ PC の SAP の xlsx の写しを読む。部品検査のロットは ここで作った「作り物」(指図番号は SAP の指図から借りる・一部は SAP に無い物)。
// 🚨 Firebase を import しない。何も保存しない。作り物のロットはこのファイルの中で作るだけ(実データはコミットしない)。
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import SapProgressPanel from './SapProgressPanel.jsx';
import OperationsSimulationPanel from './OperationsSimulationPanel.jsx';
import { readSapXlsx } from './domain/sapXlsx.js';
import { buildOrders } from './domain/sapProgress.js';
import { scheduleOrders } from './domain/sapSchedule.js';
import { inspectForecast } from './domain/sapInspect.js';
import { baseNowMs } from './domain/sapBoard.js';

try { localStorage.setItem('feature:sapProgress', '1'); } catch { /* 無くても出る */ }
const q = new URLSearchParams(location.search);
const auto = q.get('auto');
const autoUrl = auto && /^http:\/\/127\.0\.0\.1:\d+\//.test(auto) ? auto : null;

const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const WORKERS = ['尾田', '村', '片山'].map((name, i) => ({ id: 'w' + i, name }));
const TEMPLATE = { id: 'T-demo', name: '検査(作り物)', steps: [{ id: 'k1', title: '外観・寸法検査', targetTime: 1800 }] };

/** SAP の検査行から 部品検査のロットを作る(作り物): 先頭 N 件=SAP の指図番号と同じ・おまけに SAP に無い品目 3件・同じ品目コードで決まらない 2件 */
function demoLots(rows, nowMs) {
    const day = (n) => nowMs + n * 86400000;
    const ok = rows.filter((r) => r.inspWc === '2509' && r.startIso && r.phase !== 'started');
    const fut = ok.filter((r) => r.startIso >= todayIso()).sort((a, b) => (a.startIso < b.startIso ? -1 : 1));
    // 先の方から まばらに20件(SAP の予定が先の物)+ SAP の予定日が過ぎている物 3件(差し替えない例)
    const pick = [...fut.filter((_, i) => i % 3 === 0).slice(0, 20), ...ok.filter((r) => r.startIso < todayIso()).slice(0, 3)];
    const lots = pick.map((r, i) => ({
        id: 'demo-' + r.order, status: 'processing', location: 'arrival', orderNo: r.order, model: r.item, modelText: r.itemText, quantity: r.qty || 1,
        templateId: TEMPLATE.id, dueDate: new Date(day(10 + (i % 6))).toISOString().slice(0, 10), entryAt: day(1 + (i % 3)), steps: TEMPLATE.steps, tasks: {},
    }));
    ['ZZ-NONE-1', 'ZZ-NONE-2', 'ZZ-NONE-3'].forEach((m, i) => lots.push({ id: 'demo-none-' + i, status: 'processing', location: 'arrival', orderNo: 'X' + i, model: m, modelText: '作り物', quantity: 1, templateId: TEMPLATE.id, dueDate: new Date(day(8 + i)).toISOString().slice(0, 10), entryAt: day(2), steps: TEMPLATE.steps, tasks: {} }));
    return lots;
}

function Demo() {
    const [lots, setLots] = useState(null);
    useEffect(() => {
        if (!autoUrl) return;
        (async () => {
            const { rows } = await readSapXlsx(await (await fetch(autoUrl)).arrayBuffer());
            const base = buildOrders(rows); const nowMs = baseNowMs(todayIso());
            const fc = inspectForecast(base, scheduleOrders(base, { nowMs }).orders, { todayIso: todayIso() });
            setLots(demoLots(fc.rows, nowMs));
        })();
    }, []);
    if (!lots) return <div className="p-4 text-sm font-bold text-slate-600">SAP の写しを読んでいます…</div>;
    return (
        <div className="min-h-screen bg-slate-100 p-3">
            <div className="mb-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-xs font-black text-amber-800">見本(本番の画面ではありません)。ロット {lots.length}件は作り物(指図番号だけ SAP から借りた物+SAP に無い物)。Firebase へは繋いでいません。</div>
            <div style={{ height: '70vh' }} className="mb-3 overflow-hidden rounded-xl border bg-white">
                <OperationsSimulationPanel lots={lots} templates={[TEMPLATE]} workers={WORKERS} settings={{}} canEdit={false} arrivalByLot={{}} factoryCalendar={null} />
            </div>
            <div className="mx-auto max-w-7xl"><SapProgressPanel force autoUrl={autoUrl} lots={lots} /></div>
        </div>
    );
}
createRoot(document.getElementById('root')).render(<Demo />);
export default Demo;   // 画面部品だけを出す(react-refresh の規則を満たす・入口なので他からは読まない)
