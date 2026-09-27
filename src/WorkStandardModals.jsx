// 📘 作業標準ライブラリ(動画から作った作業標準も並ぶ版)。部品検査・2026-09-27 製品検査から移した。
//   製品 src/App.jsx の WorkStandardsLibraryModal / WorkStandardEditModal を中身そのままで写した。
//   部品の古い2つ(App.jsx)は消さずに残し、描く所だけこちらへ向けた。
//   ⚠ 動画から作った1件は pdfData が空(承認・印刷・Excel は workStandardLibrary / workStandardExport が持つ)。
import React, { useState, useEffect, useMemo } from 'react';
import { BookOpen, Download, FileText, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { isVideoStandard, approvalState, approvalLabel, approveEntry, unapproveEntry, entryToDoc, entryTooBig, entryBytes } from './domain/workStandardLibrary.js';
import { printSavedWorkStandard, exportSavedWorkStandardXlsx, savedStandardNote } from './workStandardExport.js';
import { driveFileUrl } from './driveClient.js';

let _ExcelJS = null;
const loadExcelJS = async () => {
  if (_ExcelJS) return _ExcelJS;
  const mod = await import('exceljs');
  _ExcelJS = mod.default || mod;
  return _ExcelJS;
};
const toDateShort = (timestamp) => {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return `${d.getMonth()+1}/${d.getDate()}`;
};

const WorkStandardsLibraryModal = ({ standards, onClose, onEdit, allowManage = false, onSave = null, currentUserName = '' }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [wsBusy, setWsBusy] = useState('');

  const categories = useMemo(() => {
    const set = new Set(['all']);
    (standards || []).forEach(s => { if (s.category) set.add(s.category); });
    return Array.from(set);
  }, [standards]);

  const filtered = useMemo(() => {
    return (standards || []).filter(s => {
      if (selectedCategory !== 'all' && s.category !== selectedCategory) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const hay = `${s.name || ''} ${s.description || ''} ${s.category || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
  }, [standards, selectedCategory, searchQuery]);

  const selected = selectedId ? (standards || []).find(s => s.id === selectedId) : null;

  // ⑥ 承認の今の状態。'none'原案 / 'approved'承認済み / 'stale'中身が変わって自動で外れた
  const isVid = !!selected && isVideoStandard(selected);
  const apState = selected ? approvalState(selected) : 'none';
  const vRows = isVid ? (entryToDoc(selected).rows || []) : [];
  const whoNow = String(currentUserName || '').trim();
  // ⚠選ぶ物を変えたら前の一言を消す(別の資料の結果が残っていると読み間違える)
  useEffect(() => { setWsBusy(''); }, [selectedId]);

  /** 一覧と見出しに出す「原案／承認済み」の札。⚠見分けられることが清水さんの⑥。 */
  const apBadge = (s) => {
    if (!isVideoStandard(s)) return null;
    const st = approvalState(s);
    const cls = st === 'approved' ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
      : st === 'stale' ? 'bg-amber-100 text-amber-900 border-amber-400'
        : 'bg-slate-100 text-slate-600 border-slate-300';
    return <span className={`fi-tap-text border rounded px-1.5 py-0.5 font-bold shrink-0 ${cls}`} data-ws-badge={st}>{st === 'approved' ? '承認済み' : st === 'stale' ? '⚠承認が外れました' : '原案'}</span>;
  };

  const doApprove = async () => {
    if (!onSave || !selected) return;
    // ⚠approveEntry は名前が空だと throw する。押してから赤い字が出るのが一番まずいので、
    //   押せない形にした上で、ここでも念のため止める。
    if (!whoNow) { alert('使用者を選んでから承認してください（誰が承認したのかを残せません）。'); return; }
    try { await onSave(approveEntry(selected, whoNow)); setWsBusy(`✓ ${whoNow} さんの名前で承認しました。`); }
    catch (e) { alert('承認できませんでした: ' + (e?.message || e)); }
  };
  const doUnapprove = async () => {
    if (!onSave || !selected) return;
    if (!window.confirm('承認を取り消しますか？（紙・Excelには「原案（未承認）」と出るようになります）')) return;
    try { await onSave(unapproveEntry(selected)); setWsBusy('承認を取り消しました。'); }
    catch (e) { alert('取り消せませんでした: ' + (e?.message || e)); }
  };
  /** 🖨紙にする。⚠写真は棚に持っていないので、押した時に元の動画から作り直す。 */
  const doPrint = async () => {
    if (!selected) return;
    setWsBusy('元の動画から写真を作り直しています…（動画の本数によっては少し待ちます）');
    try {
      const r = await printSavedWorkStandard(selected, { videoUrlOf: driveFileUrl });
      setWsBusy(!r.ok ? '別のウィンドウが開けませんでした。ブラウザのポップアップの許可を確認してください。'
        : r.missingVideos.length ? `⚠ 取れなかった動画：${r.missingVideos.join(' / ')}。その行は「写真なし」で出ています（写真 ${r.shots}枚）。`
          : `写真 ${r.shots}枚 を作り直しました。開いた画面の印刷から「PDFに保存」を選ぶと紙の形で残せます。`);
    } catch (e) { setWsBusy('作れませんでした: ' + (e?.message || e)); }
  };
  const doXlsx = async () => {
    if (!selected) return;
    setWsBusy('元の動画から写真を作り直しています…（動画の本数によっては少し待ちます）');
    try {
      const r = await exportSavedWorkStandardXlsx(selected, loadExcelJS, { videoUrlOf: driveFileUrl });
      setWsBusy(r.missingVideos.length
        ? `⚠ 取れなかった動画：${r.missingVideos.join(' / ')}。その行は「写真なし」で出ています。${r.name} を保存しました。`
        : `${r.name} を保存しました（写真 ${r.shots}枚）。`);
    } catch (e) { setWsBusy('作れませんでした: ' + (e?.message || e)); }
  };

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden">
        {/* ヘッダー */}
        <div className="bg-orange-600 text-white px-4 py-3 flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold flex items-center gap-2"><BookOpen className="w-5 h-5"/> 作業標準ライブラリ</h2>
          <div className="flex items-center gap-2">
            {allowManage && (
              <button onClick={() => onEdit && onEdit(null)} className="bg-white/20 hover:bg-white/30 text-white px-3 py-1.5 rounded text-sm font-bold flex items-center gap-1"><Plus className="w-4 h-4"/> 新規登録</button>
            )}
            <button onClick={onClose} className="hover:bg-white/20 rounded p-1"><X className="w-6 h-6"/></button>
          </div>
        </div>
        {/* ボディ: 左 一覧 / 右 PDF プレビュー */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左カラム: リスト */}
          <div className="w-80 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0">
            <div className="p-3 border-b space-y-2">
              <div className="flex items-center gap-2 bg-white px-2 py-1.5 rounded border">
                <Search className="w-4 h-4 text-slate-400"/>
                <input type="text" placeholder="検索 (名前/カテゴリ/説明)" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="flex-1 text-sm outline-none"/>
              </div>
              <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className="w-full border rounded p-1.5 text-sm bg-white">
                {categories.map(c => <option key={c} value={c}>{c === 'all' ? '-- 全カテゴリ --' : c}</option>)}
              </select>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {filtered.length === 0 && (
                <div className="text-center text-slate-400 py-8 text-sm">
                  {(standards || []).length === 0 ? '作業標準が登録されていません' : '該当する作業標準がありません'}
                </div>
              )}
              {filtered.map(s => (
                <div
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`p-2 rounded border-2 cursor-pointer transition-all ${selectedId === s.id ? 'border-orange-500 bg-orange-50' : 'border-slate-200 bg-white hover:border-orange-300'}`}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="w-4 h-4 text-orange-600 shrink-0 mt-0.5"/>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-slate-800 truncate" title={s.name}>{s.name}</div>
                      {/* ⑥ 一覧の時点で 原案／承認済み が見分けられること(清水さん) */}
                      <div className="flex items-center gap-1 flex-wrap mt-0.5">
                        {s.category && <span className="fi-tap-text text-orange-700 bg-orange-100 inline-block px-1.5 py-0.5 rounded">{s.category}</span>}
                        {isVideoStandard(s) && <span className="fi-tap-text text-sky-700 bg-sky-100 border border-sky-200 rounded px-1.5 py-0.5 font-bold">🎬動画から</span>}
                        {apBadge(s)}
                      </div>
                      {s.description && <div className="fi-tap-text text-slate-500 mt-1 line-clamp-2">{s.description}</div>}
                    </div>
                  </div>
                  {allowManage && selectedId === s.id && (
                    <div className="flex gap-1 mt-2 pt-2 border-t border-orange-200">
                      <button onClick={(e) => { e.stopPropagation(); onEdit && onEdit(s); }} className="flex-1 fi-tap-text bg-blue-100 hover:bg-blue-200 text-blue-700 px-2 py-1 rounded font-bold flex items-center justify-center gap-1"><Pencil className="w-3 h-3"/> 編集</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          {/* 右カラム: PDF プレビュー */}
          <div className="flex-1 bg-slate-100 flex flex-col overflow-hidden">
            {!selected ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8">
                <BookOpen className="w-16 h-16 mb-3 opacity-30"/>
                <div className="font-bold text-lg">作業標準を選択してください</div>
                <div className="text-sm mt-1">左の一覧から PDF を選ぶと、ここに表示されます</div>
              </div>
            ) : (
              <>
                <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between shrink-0">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-slate-800 truncate">{selected.name}</div>
                    <div className="fi-tap-text text-slate-500 flex items-center gap-2">
                      {selected.category && <span className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-bold">{selected.category}</span>}
                      {selected.uploadedBy && <span>登録: {selected.uploadedBy}</span>}
                      {selected.updatedAt && <span>更新: {toDateShort(selected.updatedAt)}</span>}
                    </div>
                    {selected.description && <div className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">{selected.description}</div>}
                  </div>
                  {/* ⚠⚠ 中身が無いのに押せるボタンを出さない。動画から作った1件は pdfData が空なので、
                         今までは押しても「いまのページへ飛ぶだけ」だった(何も起きないボタン)。 */}
                  {selected.pdfData && (
                    <a href={selected.pdfData} download={`${selected.name || 'work-standard'}.pdf`} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-bold flex items-center gap-1 shrink-0 ml-3">
                      <Download className="w-4 h-4"/> ダウンロード
                    </a>
                  )}
                </div>
                {isVid ? (
                  <div className="flex-1 bg-white p-4 overflow-y-auto space-y-3" data-ws-video="1">
                    {/* ⑥ 承認。⚠1段だけ・取り消せる・中身が変わったら自動で外れる。
                           ⚠⚠ 承認しても 文書番号・版・制定日 は採番しない(偽の社内文書を作らない)。 */}
                    <div className={`rounded-lg border-2 p-3 ${apState === 'approved' ? 'border-emerald-300 bg-emerald-50' : apState === 'stale' ? 'border-amber-400 bg-amber-50' : 'border-slate-300 bg-slate-50'}`}>
                      <div className="text-sm font-bold text-slate-800" data-ws-approval={apState}>{approvalLabel(selected)}</div>
                      {allowManage && onSave && (
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {apState === 'approved' ? (
                            <button onClick={doUnapprove} className="px-3 py-2 min-h-[40px] rounded bg-white border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-100">承認を取り消す</button>
                          ) : (
                            <button onClick={doApprove} disabled={!whoNow} data-ws-approve="1"
                              className="px-4 py-2 min-h-[40px] rounded bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-bold">
                              ✓ {apState === 'stale' ? 'もう一度承認する' : '承認する'}（{whoNow || '使用者が未選択'}）
                            </button>
                          )}
                          {!whoNow && <span className="fi-tap-text text-rose-700 font-bold">使用者を選んでいないので承認できません（誰が承認したのかを残せないため）。</span>}
                        </div>
                      )}
                      <div className="fi-tap-text text-slate-500 mt-2">⚠ 文書番号・版・制定日は<b>空欄のまま</b>出ます（発行する時に人が入れてください）。承認した後に中身を直すと、承認は<b>自動で外れます</b>。</div>
                    </div>
                    {/* ⚠作り直せない物を黙らない(元の動画が消えていたら写真は作れない) */}
                    <div className="text-xs whitespace-pre-wrap text-slate-700 bg-slate-50 border border-slate-200 rounded p-2" data-ws-note="1">{savedStandardNote(selected)}</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={doPrint} data-ws-print="1" className="px-4 py-2.5 min-h-[44px] rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-sm font-bold">🖨 紙にする（開いた画面から「PDFに保存」）</button>
                      <button onClick={doXlsx} data-ws-xlsx="1" className="px-4 py-2.5 min-h-[44px] rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-bold">📊 Excelにする</button>
                    </div>
                    {wsBusy && <div className="text-xs font-bold text-sky-900 bg-sky-50 border border-sky-200 rounded p-2 whitespace-pre-wrap" data-ws-msg="1">{wsBusy}</div>}
                    <div className="border border-slate-200 rounded-lg overflow-hidden">
                      <div className="bg-slate-100 px-2 py-1.5 text-xs font-bold text-slate-600">要点 {vRows.length}件（⚠写真は棚に持っていません。🖨/📊を押した時に元の動画から作り直します）</div>
                      <div className="divide-y divide-slate-100">
                        {vRows.map(r => (
                          <div key={r.id} className="px-2 py-1.5 text-xs flex gap-2">
                            <span className="font-bold text-slate-400 tabular-nums shrink-0">{r.no}</span>
                            <span className="min-w-0 flex-1">
                              {r.chapter && <span className="fi-tap-text text-orange-700 bg-orange-100 rounded px-1 mr-1">{r.chapter}</span>}
                              {/* ⚠空欄は空欄と書く(推測で埋めない) */}
                              <span className="font-bold text-slate-800">{r.step || '（作業手順は空欄）'}</span>
                              {r.point && <span className="block text-slate-600">急所: {r.point}</span>}
                              {r.why && <span className="block text-slate-500">理由: {r.why}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 bg-slate-700 p-2 overflow-hidden">
                    {selected.pdfData ? (
                      <embed src={selected.pdfData} type="application/pdf" className="w-full h-full bg-white rounded"/>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-300">PDF データがありません</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// 作業標準の編集・登録モーダル (PDF アップロード + メタデータ)
const WorkStandardEditModal = ({ editingItem, onClose, onSave, onDelete, currentUserName = '' }) => {
  const [name, setName] = useState(editingItem?.name || '');
  const [category, setCategory] = useState(editingItem?.category || '');
  const [description, setDescription] = useState(editingItem?.description || '');
  const [pdfData, setPdfData] = useState(editingItem?.pdfData || null);
  const [pdfFileName, setPdfFileName] = useState('');
  const [busy, setBusy] = useState(false);

  const handlePdfUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) { e.target.value = ''; return; }
    if (file.type !== 'application/pdf') {
      alert('PDF ファイルを選択してください');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      if (!confirm(`ファイルサイズが ${(file.size / 1024 / 1024).toFixed(1)}MB と大きめです。Firestore に保存できますが、5MB を超えると失敗する可能性があります。続行しますか？`)) {
        e.target.value = '';
        return;
      }
    }
    setPdfFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setPdfData(ev.target.result);
    reader.onerror = () => {
      alert(`PDF の読込みに失敗しました: ${reader.error?.message || 'Unknown'}`);
      setPdfFileName(''); setPdfData(null);
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // 同じファイル再選択可
  };

  // 🎬 動画から作った1件は PDF を持っていない(持てない)。
  // ⚠⚠ ここで PDF を必須にしていると、棚に入れた後に名前も分類も直せない。
  //   編集室は「名前も分類も後で直せる」前提で1タップにしているので、直せないと約束が嘘になる。
  const isVid = isVideoStandard(editingItem);

  const handleSave = async () => {
    if (!name.trim()) { alert('名称を入力してください'); return; }
    if (!isVid && !pdfData) { alert('PDF ファイルを選択してください'); return; }
    const next = {
      ...(editingItem || {}),
      name: name.trim(),
      category: category.trim(),
      description: description.trim(),
      // ⚠動画の1件に pdfData を書き戻さない(空のまま持たせる)
      ...(isVid ? {} : { pdfData }),
      uploadedBy: editingItem?.uploadedBy || currentUserName || '',
    };
    // ⚠1件の門は編集室だけでなく **ここでも通す**。設定の箱(1MB)を全員で分け合っている。
    if (isVid && entryTooBig(next)) {
      alert(`この作業標準は大きすぎます（${Math.round(entryBytes(next) / 1024)}KB）。説明を短くするか、要点を分けてください。`);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[160] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="bg-orange-600 text-white px-4 py-3 flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold flex items-center gap-2"><BookOpen className="w-5 h-5"/> {editingItem ? '作業標準 編集' : '作業標準 新規登録'}</h2>
          <button onClick={onClose} className="hover:bg-white/20 rounded p-1"><X className="w-5 h-5"/></button>
        </div>
        <div className="flex-1 min-h-0 p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-bold text-slate-600 mb-1">名称 *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="例: 円テーブル組立作業標準書" className="w-full border rounded p-2 text-sm"/>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-600 mb-1">カテゴリ</label>
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder="例: 組立 / 検査 / 包装" className="w-full border rounded p-2 text-sm"/>
            <p className="fi-tap-text text-slate-400 mt-0.5">同じカテゴリ名でグループ化されます</p>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-600 mb-1">説明</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="作業標準の概要・適用範囲・改訂内容など" className="w-full border rounded p-2 text-sm"/>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-600 mb-1">PDF ファイル *</label>
            <label className="block w-full p-4 border-2 border-dashed border-orange-300 bg-orange-50 hover:bg-orange-100 rounded cursor-pointer text-center text-sm">
              <FileText className="w-8 h-8 mx-auto mb-1 text-orange-600"/>
              <div className="font-bold text-orange-800">{pdfData ? (pdfFileName || (editingItem ? '既存 PDF (差し替えるならクリック)' : '選択済み')) : 'クリックして PDF を選択'}</div>
              <div className="fi-tap-text text-slate-500 mt-1">推奨 5MB 以下</div>
              <input type="file" accept="application/pdf" onChange={handlePdfUpload} className="hidden"/>
            </label>
            {pdfData && (
              <div className="mt-2 h-48 bg-slate-700 rounded overflow-hidden">
                <embed src={pdfData} type="application/pdf" className="w-full h-full bg-white"/>
              </div>
            )}
          </div>
        </div>
        <div className="border-t bg-slate-50 px-4 py-3 flex justify-between gap-2 shrink-0">
          {editingItem && typeof onDelete === 'function' ? (
            <button
              onClick={async () => {
                if (!confirm(`作業標準「${editingItem.name}」を削除しますか？\nこの操作は元に戻せません。`)) return;
                setBusy(true);
                try { await onDelete(editingItem.id); onClose(); } finally { setBusy(false); }
              }}
              disabled={busy}
              className="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded font-bold disabled:opacity-50 flex items-center gap-1"
            ><Trash2 className="w-4 h-4"/> 削除</button>
          ) : <div/>}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="px-4 py-2 text-slate-600 hover:bg-slate-200 rounded font-bold disabled:opacity-50">キャンセル</button>
            <button onClick={handleSave} disabled={busy} className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded font-bold disabled:opacity-50">
              {busy ? '保存中…' : (editingItem ? '更新' : '登録')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export { WorkStandardsLibraryModal, WorkStandardEditModal };
