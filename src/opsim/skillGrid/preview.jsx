// 単独の見た目・操作確認専用。アプリのindexからexportしない。通信も保存もしない。
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SkillGrid, buildSkillGrid } from './index.js';
import './preview.css';

const workers = ['確認用A', '確認用B', '確認用C', '確認用D'].map((name, index) => ({ id: `w${index}`, name, paused: index === 3 }));
const templates = [
  { id: 't1', name: '確認用・回転分割／一般精度', requiredSkills: ['rotation', 'general'] },
  { id: 't2', name: '確認用・耐圧／外観検査', requiredSkills: ['pressure'] },
  { id: 't3', name: '確認用・必要スキル未設定', requiredSkills: [] },
];
const sample = {
  workers, templates,
  skills: [{ id: 'rotation', name: '回転分割' }, { id: 'general', name: '一般精度' }, { id: 'pressure', name: '耐圧検査' }],
  workerSkills: { 確認用A: { rotation: 3, general: 2 }, 確認用B: { pressure: 2 }, 確認用C: { rotation: 1, pressure: 1 } },
  lots: [
    ...Array.from({ length: 12 }, (_, index) => ({ id: `example-${index}`, orderNo: `確認ロット-${index + 1}`, model: index < 8 ? '確認品目コードA' : '確認品目コードB', templateId: 't1', status: 'completed', quantity: 2, tasks: [{ workerName: '確認用A' }, ...(index < 3 ? [{ workerName: '確認用B' }] : [])] })),
    { id: 'example-13', orderNo: '確認ロット-13', model: '確認品目コードC', templateId: 't2', status: 'completed', tasks: [{ workerName: '確認用B' }] },
    { id: 'example-14', orderNo: '確認ロット-14', model: '確認品目コードC', templateId: 't2', status: 'completed', tasks: {}, workerId: 'w0' },
    { id: 'example-15', model: '確認品目コードD', templateId: 't3', status: 'pending', tasks: {} },
  ],
  sourceLabel: '試験用データ。実データではありません。',
  historyComplete: false,
};

export function Preview() {
  const [input, setInput] = useState(sample);
  const [error, setError] = useState('');
  const [imported, setImported] = useState(false);
  const model = useMemo(() => buildSkillGrid(input), [input]);
  const readSnapshot = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.lots) || !Array.isArray(data.templates) || !Array.isArray(data.workers)) throw new Error('lots / templates / workers の配列が必要です。');
      setInput({
        lots: data.lots, templates: data.templates, workers: data.workers,
        skills: data.skills ?? data.settings?.skills ?? [], workerSkills: data.workerSkills ?? data.settings?.workerSkills ?? null,
        historyComplete: data.historyComplete === true,
        sourceLabel: `${file.name} ／ ${data.sourceLabel || '取得日・範囲は未記入'}`,
      });
      setImported(true);
      setError('');
    } catch (reason) { setError(reason.message); }
  };
  return <main className="min-h-screen bg-slate-50 p-4 md:p-6">
    <div className="max-w-screen-2xl mx-auto space-y-4">
      <div className="rounded border-2 border-slate-700 bg-white p-3 space-y-2">
        <p className="font-bold text-slate-800" role="status">{imported ? '手元のJSONを表示中（内容が実データかは未検証）' : '試験用データでの表示確認です。実データの写真ではありません。'}</p>
        <label className="block text-sm text-slate-700">確認済みの写しを、この画面だけで開く（外部に送りません） <input type="file" accept="application/json,.json" onChange={readSnapshot} /></label>
        {error && <p role="alert" className="text-rose-700">{error}</p>}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-4"><SkillGrid model={model} /></div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')).render(<Preview />);
