// 軽微不良・不良の台帳(ロットに紐づかない記録を いつでも登録・後から直す)。製品 App.jsx の MinorReportLedgerModal を写した物。
//   - 保存先は専用コレクション minor_reports(ロットに載せない)
//   - 検査中の記録(interruptions)と NG判定の理由も同じ一覧に合流して直せる
//   - sample:true は「サンプル」表示+一括削除できる=本物の記録と混ざらない
//   部品向けの違い: 型式 → 品目コード+品名(modelText・空なら品目名簿から)。NG の理由はその1件の task だけ書く。
import React, { useMemo, useState } from 'react';
import { Megaphone, X, Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { settleSaveBriefly, mayCloseAfterSave, SAVE_REFUSED_MESSAGE } from './domain/settleSave.js';
import { intWritePatch, intDeletePatch } from './domain/interruptionLog.js';
import { resolveItemName } from './domain/itemMaster.js';
import { SjhGuide } from './SjhGuide.jsx';
import { sjhInsert } from './sjhText.js';

const MINOR_KINDS = [['complaint', '軽微不良'], ['improvement', '気づき・改善'], ['defect', '不良(不具合)']];
// 台帳の出所: minor=いつでも登録した単独記録 / interruption=検査中に付けた軽微不良・改善 / ng=カスタムのNG判定理由
const MINOR_SRC_BADGE = { minor: ['台帳', 'bg-purple-100 text-purple-700'], interruption: ['検査中', 'bg-emerald-100 text-emerald-700'], ng: ['NG判定', 'bg-rose-100 text-rose-700'] };

const pad = (n) => String(n).padStart(2, '0');
const toLocal = (ms) => { const d = new Date(Number(ms) || Date.now()); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toMs = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v === 'object' && v.seconds != null) return v.seconds * 1000; const n = new Date(v).getTime(); return isNaN(n) ? null : n; };

export default function MinorReportLedgerModal({ reports = [], lots = [], workers = [], currentUserName = '', saveData, deleteData, onClose, itemMaster = {} }) {
  const blank = () => ({ _src: 'minor', type: 'complaint', at: toLocal(Date.now()), model: '', modelText: '', orderNo: '', stepTitle: '', content: '', workerName: currentUserName || '' });
  const [form, setForm] = useState(blank);
  const [editRow, setEditRow] = useState(null); // 編集中の行 (出所つき)
  const [filter, setFilter] = useState('all');   // complaint/improvement
  const [srcFilter, setSrcFilter] = useState('all'); // all/minor/interruption/ng
  const [q, setQ] = useState('');
  // 3つの出所を1つの一覧に合流する。過去の検査中データ・NG判定もここで見える＆直せる。
  const all = useMemo(() => {
    const out = [];
    (reports || []).filter(Boolean).forEach(r => out.push({ _src: 'minor', id: r.id, type: r.type || 'complaint', timestamp: toMs(r.timestamp), model: r.model || '', modelText: r.modelText || '', orderNo: r.orderNo || '', stepTitle: r.stepTitle || '', content: r.content || '', workerName: r.workerName || '', sample: !!r.sample }));
    (lots || []).forEach(lot => {
      const steps = lot.steps || [];
      const titleForKey = (key) => { for (const s of steps) { if (s?.id && String(key).startsWith(`${s.id}-`)) return s.title || '全体'; } const m = /^(\d+)-/.exec(String(key)); if (m && steps[+m[1]]) return steps[+m[1]].title || '全体'; return '全体'; };
      (lot.interruptions || []).filter(i => i && (i.type === 'complaint' || i.type === 'improvement')).forEach(i => {
        out.push({ _src: 'interruption', _lotId: lot.id, id: i.id, type: i.type, timestamp: toMs(i.timestamp), model: lot.model || '', modelText: lot.modelText || '', orderNo: lot.orderNo || '', stepTitle: i.stepInfo?.title || i.targetStepTitle || '全体', content: i.label || '', workerName: i.workerName || '' });
      });
      Object.entries(lot.tasks || {}).forEach(([key, t]) => {
        if (t && typeof t.ngReason === 'string' && t.ngReason.trim()) out.push({ _src: 'ng', _lotId: lot.id, _key: key, id: `ng:${lot.id}:${key}`, type: 'complaint', timestamp: toMs(t.ngAt) || toMs(t.endTime), model: lot.model || '', modelText: lot.modelText || '', orderNo: lot.orderNo || '', stepTitle: titleForKey(key), content: t.ngReason.trim(), workerName: t.workerName || '' });
      });
    });
    return out;
  }, [reports, lots]);
  const list = useMemo(() => all
    .filter(r => filter === 'all' || r.type === filter)
    .filter(r => srcFilter === 'all' || r._src === srcFilter)
    .filter(r => { const s = q.trim(); return !s || [r.content, r.model, r.modelText, r.orderNo, r.stepTitle, r.workerName].some(v => String(v || '').includes(s)); })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)), [all, filter, srcFilter, q]);
  const counts = useMemo(() => ({ minor: all.filter(r => r._src === 'minor').length, interruption: all.filter(r => r._src === 'interruption').length, ng: all.filter(r => r._src === 'ng').length }), [all]);
  const sampleCount = (reports || []).filter(r => r && r.sample).length;
  const workerNames = [...new Set((workers || []).map(w => w.name).filter(Boolean))];
  const editing = !!editRow;
  const lockModel = editing && editRow._src !== 'minor';   // 検査中/NGは型式・指図がロットに紐づくので変更不可
  const lockTime = editing && editRow._src === 'ng';       // NGの日時は判定時刻なので変更不可
  const save = async () => {
    if (!form.content.trim()) { alert('内容を入力してください'); return; }
    const ts = new Date(form.at).getTime();
    const tsSafe = Number.isFinite(ts) ? ts : Date.now();
    const src = editRow ? editRow._src : 'minor';
    // 🚨 打った内容は **この画面にしか無い**。保存が拒否されたらフォームを空にしない(2026-08-31)。
    let p = null;
    if (src === 'minor') {
      const id = editRow ? editRow.id : `mr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      p = saveData('minor_reports', id, { type: form.type, timestamp: tsSafe, model: form.model.trim(), modelText: form.modelText.trim(), orderNo: form.orderNo.trim(), stepTitle: form.stepTitle.trim(), content: form.content.trim(), workerName: form.workerName.trim(), updatedAt: Date.now(), ...(editRow ? {} : { createdAt: Date.now() }) });
    } else if (src === 'interruption') {
      const lot = (lots || []).find(l => l.id === editRow._lotId); if (!lot) return;
      const cur = (lot.interruptions || []).find(i => i && i.id === editRow.id); if (!cur) return;
      const next = { ...cur, type: form.type, label: form.content.trim(), timestamp: tsSafe, workerName: form.workerName.trim(), stepInfo: { ...(cur.stepInfo || {}), title: form.stepTitle.trim() || '全体' } };
      p = saveData('lots', lot.id, intWritePatch(cur, next)); // ⚠1件だけ書く(配列を丸ごと書くと作業画面の古い配列で巻き戻る)
    } else if (src === 'ng') {
      const lot = (lots || []).find(l => l.id === editRow._lotId); if (!lot) return;
      const t = (lot.tasks || {})[editRow._key]; if (!t) return;
      p = saveData('lots', lot.id, { tasks: { [editRow._key]: { ...t, ngReason: form.content.trim(), workerName: form.workerName.trim() || t.workerName } } });
    }
    const r = await settleSaveBriefly(p);
    if (!mayCloseAfterSave(r)) { alert(SAVE_REFUSED_MESSAGE); return; }
    setForm(blank()); setEditRow(null);
  };
  const startEdit = (r) => { setEditRow(r); setForm({ _src: r._src, type: r.type || 'complaint', at: toLocal(r.timestamp), model: r.model || '', modelText: r.modelText || '', orderNo: r.orderNo || '', stepTitle: r.stepTitle || '', content: r.content || '', workerName: r.workerName || '' }); };
  // 🚨 2026-08-31 SS-201: 消す保存を投げっぱなしにしていた。
  //   同じ画面の「保存」側(下の save)は settleSaveBriefly + mayCloseAfterSave で
  //   拒否された事を人に出しているのに、**消す側だけ素通り**だった。
  //   関所(assertSafeLotSave)が消す保存を止めた時、押した人には何も出ず、
  //   一覧からは行が消えたように見えるので「消したのに翌日また出ている」になる。
  //   → 同じ画面の作法へ揃える(拒否なら入力欄も片付けない)。
  const del = async (r) => {
    let p = null;
    if (r._src === 'minor') { if (!window.confirm('この記録を削除しますか？')) return; deleteData('minor_reports', r.id); }
    // ⚠配列から抜いて丸ごと書き戻さない。作業画面が握っている古い配列ですぐ復活する。消したことを共有に1件書く。
    else if (r._src === 'interruption') { const lot = (lots || []).find(l => l.id === r._lotId); if (!lot) return; const cur = (lot.interruptions || []).find(i => i && i.id === r.id); if (!cur) return; if (!window.confirm('検査中に付けたこの記録を削除しますか？')) return; p = saveData('lots', lot.id, intDeletePatch(cur, currentUserName)); }
    else if (r._src === 'ng') { const lot = (lots || []).find(l => l.id === r._lotId); if (!lot) return; const t = (lot.tasks || {})[r._key]; if (!t) return; if (!window.confirm('このNG判定の「理由」を消しますか？（NG自体は残りますが、理由テキストが空になります）')) return; p = saveData('lots', lot.id, { tasks: { [r._key]: { ...t, ngReason: '' } } }); }
    if (p && !mayCloseAfterSave(await settleSaveBriefly(p))) { alert(SAVE_REFUSED_MESSAGE); return; }
    if (editRow && editRow.id === r.id) { setForm(blank()); setEditRow(null); }
  };
  const delAllSample = () => { if (!sampleCount) return; if (!window.confirm(`サンプル ${sampleCount}件をすべて削除しますか？（本物の記録は残ります）`)) return; (reports || []).filter(r => r && r.sample).forEach(r => deleteData('minor_reports', r.id)); };
  const inputCls = 'border border-slate-300 rounded-lg px-2 py-1.5 text-sm';
  const lockCls = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-slate-100 text-slate-400';
  return (
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 bg-purple-600 text-white flex items-center gap-2 shrink-0 flex-wrap">
          <Megaphone className="w-5 h-5" />
          <span className="font-black">軽微不良・改善 台帳（過去の分もすべて・後から編集）</span>
          <span className="fi-tap-text font-normal bg-white/20 rounded px-2 py-0.5">全 {all.length} 件（台帳{counts.minor}/検査中{counts.interruption}/NG{counts.ng}）</span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
        </div>
        {/* 登録・編集フォーム */}
        <div className="p-4 border-b border-slate-200 bg-slate-50 shrink-0">
          <div className="text-xs font-black text-slate-500 mb-2 flex items-center gap-2">
            {editing ? <>✏ この記録を編集 <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded ${MINOR_SRC_BADGE[editRow._src][1]}`}>{MINOR_SRC_BADGE[editRow._src][0]}</span>{lockModel && <span className="fi-tap-text font-normal text-slate-400">品目コード・指図はロットに紐づくため変更不可</span>}</> : '＋ 新しく登録（検査中でなくても・思い出したときにここから）'}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">種類</span>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} disabled={editing && editRow._src === 'ng'} className={editing && editRow._src === 'ng' ? lockCls : inputCls}>{MINOR_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">日時</span>
              <input type="datetime-local" value={form.at} onChange={e => setForm({ ...form, at: e.target.value })} disabled={lockTime} className={lockTime ? lockCls : inputCls} />
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">報告者</span>
              <input value={form.workerName} onChange={e => setForm({ ...form, workerName: e.target.value })} list="mr-workers" placeholder="名前" className={inputCls} />
              <datalist id="mr-workers">{workerNames.map(n => <option key={n} value={n} />)}</datalist>
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">品目コード</span>
              <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} disabled={lockModel} placeholder="品目コード" className={lockModel ? lockCls : inputCls} />
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">品名</span>
              {/* 空なら品目名簿の品名を薄字で出す(打てば打った方が優先) */}
              <input value={form.modelText} onChange={e => setForm({ ...form, modelText: e.target.value })} disabled={lockModel} placeholder={resolveItemName(form.model, '', itemMaster) || '品名(任意)'} className={lockModel ? lockCls : inputCls} />
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">指図番号</span>
              <input value={form.orderNo} onChange={e => setForm({ ...form, orderNo: e.target.value })} disabled={lockModel} placeholder="任意" className={lockModel ? lockCls : inputCls} />
            </label>
            <label className="flex flex-col gap-0.5"><span className="fi-tap-text font-bold text-slate-400">工程</span>
              <input value={form.stepTitle} onChange={e => setForm({ ...form, stepTitle: e.target.value })} disabled={editing && editRow._src === 'ng'} placeholder="例: 分割精度 / 全体" className={editing && editRow._src === 'ng' ? lockCls : inputCls} />
            </label>
            <label className="flex flex-col gap-0.5 col-span-2 md:col-span-3"><span className="fi-tap-text font-bold text-slate-400">内容</span>
              <textarea value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} rows={3} placeholder="状況: 何があったか / 対処: どうしたか / 判断: 最後どうなったか" className={inputCls} />
              <SjhGuide onInsert={() => setForm(f => ({ ...f, content: sjhInsert(f.content) }))} />
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            {editing && <button onClick={() => { setForm(blank()); setEditRow(null); }} className="px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100">新規に戻す</button>}
            <button onClick={save} className="px-4 py-1.5 rounded-lg text-sm font-black text-white bg-purple-600 hover:bg-purple-700 flex items-center gap-1.5"><Plus className="w-4 h-4" /> {editing ? '更新' : '登録'}</button>
          </div>
        </div>
        {/* 絞り込み */}
        <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2 flex-wrap shrink-0">
          <div className="flex bg-slate-100 rounded p-0.5">
            {[['all', 'すべて'], ['complaint', '軽微不良'], ['improvement', '気づき・改善']].map(([id, l]) => (
              <button key={id} onClick={() => setFilter(id)} className={`px-2.5 py-1 text-xs font-bold rounded ${filter === id ? 'bg-white shadow text-purple-700' : 'text-slate-500'}`}>{l}</button>
            ))}
          </div>
          <div className="flex bg-slate-100 rounded p-0.5">
            {[['all', '全部'], ['minor', '台帳'], ['interruption', '検査中'], ['ng', 'NG判定']].map(([id, l]) => (
              <button key={id} onClick={() => setSrcFilter(id)} className={`px-2.5 py-1 text-xs font-bold rounded ${srcFilter === id ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>{l}</button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="内容・品目コード・工程・報告者で絞り込み" className="w-full border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 text-sm" />
          </div>
          {sampleCount > 0 && <button onClick={delAllSample} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-amber-700 border border-amber-300 bg-amber-50 hover:bg-amber-100 whitespace-nowrap">🧪 サンプル{sampleCount}件を削除</button>}
        </div>
        {/* 一覧 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 fi-tap-text text-slate-500 z-10">
              <tr className="border-b"><th className="text-left px-3 py-2 whitespace-nowrap">日時</th><th className="text-left px-2 py-2">出所</th><th className="text-left px-2 py-2">種類</th><th className="text-left px-2 py-2">品目コード / 品名 / 指図</th><th className="text-left px-2 py-2">工程</th><th className="text-left px-3 py-2">内容</th><th className="text-left px-2 py-2">報告者</th><th className="px-2 py-2"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map(r => (
                <tr key={r.id} className={`hover:bg-purple-50/40 ${r.sample ? 'bg-amber-50/40' : ''} ${editRow && editRow.id === r.id ? 'ring-2 ring-purple-300' : ''}`}>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{r.timestamp ? new Date(r.timestamp).toLocaleString('ja-JP', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                  <td className="px-2 py-2 whitespace-nowrap"><span className={`fi-tap-text font-black px-1.5 py-0.5 rounded ${MINOR_SRC_BADGE[r._src][1]}`}>{MINOR_SRC_BADGE[r._src][0]}</span></td>
                  <td className="px-2 py-2 whitespace-nowrap"><span className={`fi-tap-text font-black px-1.5 py-0.5 rounded ${r.type === 'improvement' ? 'bg-sky-100 text-sky-700' : r.type === 'defect' ? 'bg-rose-100 text-rose-700' : 'bg-purple-100 text-purple-700'}`}>{r.type === 'improvement' ? '改善' : r.type === 'defect' ? '不良' : '軽微'}</span>{r.sample && <span className="ml-1 fi-tap-text font-black px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">サンプル</span>}</td>
                  <td className="px-2 py-2"><div className="font-bold text-slate-700">{r.model || '—'}</div>{resolveItemName(r.model, r.modelText, itemMaster) && <div className="fi-tap-text text-slate-500">{resolveItemName(r.model, r.modelText, itemMaster)}</div>}<div className="fi-tap-text text-slate-400 font-mono">{r.orderNo || ''}</div></td>
                  <td className="px-2 py-2 text-xs text-slate-600">{r.stepTitle || '全体'}</td>
                  <td className="px-3 py-2 text-slate-800 whitespace-pre-wrap max-w-[28ch]">{r.content || ''}</td>
                  <td className="px-2 py-2 text-xs text-slate-600 whitespace-nowrap">{r.workerName || ''}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button onClick={() => startEdit(r)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="編集"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => del(r)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="削除"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-slate-400">該当がありません。絞り込みを「全部」にすると、過去の検査中・NG判定の記録も出ます。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
