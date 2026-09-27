// 🗂 P067 品目コードマスタ(製品 App.jsx:26144〜 ModelMasterPanel を写した・言葉は「型式」→「品目コード」)
//   品目コードが主役で、規格番号は任意。品質規格マスタ(規格番号が主役)は互換で残す(既定: 両方を並べ、品目コードマスタを第一候補)。
//   App の中の関数(isAutoStep・getQsTemplateEntries)は props で受ける(App を読み込まない為)。
import React, { useState, useMemo, useRef } from 'react';
import { ClipboardCheck, ClipboardList, FileSpreadsheet, Pencil, Plus, Trash2 } from 'lucide-react';
import { pendingGroupsOf } from './domain/progressSheet.js';
import { findModelTemplate } from './domain/modelMaster.js';
import { diffTemplate as tsDiff, syncPolicyOf as tsPolicy } from './domain/templateSync.js';
import { duplicateSummaryText } from './domain/lotDuplicates.js';
import { resolveItemName } from './domain/itemMaster.js';
// ⚠ 描画中に時刻を読まない(react-hooks/purity)。押した時の関数からだけ呼ぶ
const clockNow = () => Date.now();
const localYMD = (d) => { const x = (d instanceof Date) ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
const ModelMasterPanel = ({ templates, lots, modelMasters, qualityStandards, modelStandardMap, modelTemplates = [], saveSettings, deleteSettingsFields, deleteData = null, onEditModelStep = null, onRevertModelTemplate = null, onRemoveEntry = null, onOpenSync = null, onUndoSync = null, onEntryDaysChanged = null, initialModel = '', pendingImport = null, onRegisterPending = null, onRemovePending = null, duplicateGroups = null, onDeleteLots = null, isAutoStep = () => false, getQsTemplateEntries = () => [], itemMaster = {} }) => {
    const nameOf = (m) => resolveItemName(m, '', itemMaster) || '';
    // 🧹 2026-09-18 `modelMasters || {}` は無い時に毎回新しい {} を作り、下の useMemo 3つの依存が毎回変わっていた(eslint exhaustive-deps)。1回だけ作る。
    const masters = useMemo(() => modelMasters || {}, [modelMasters]);
    const [selectedModel, setSelectedModel] = useState(() => String(initialModel || '').trim());
    const [newModelName, setNewModelName] = useState('');
    const [importModelNames, setImportModelNames] = useState({}); // { qsId: 品目コード名 } 旧QS取り込みフォームの入力

    const modelList = useMemo(() => Object.keys(masters).sort((a, b) => a.localeCompare(b, 'ja')), [masters]);
    const master = masters[selectedModel];
    const entries = useMemo(() => (Array.isArray(master?.templates) ? master.templates : []), [master]);

    // 旧・品質規格マスタの残り (取り込みセクション用)
    const qsList = useMemo(() => Object.values(qualityStandards || {}).sort((a, b) =>
        (a.standardNo || '').localeCompare(b.standardNo || '', 'ja')), [qualityStandards]);

    // 利用可能な品目コード (ロット実績 + 品目コードマスタ + 旧マッピング)
    const knownModels = useMemo(() => {
        const set = new Set();
        (lots || []).forEach(l => { if (l.model) set.add(l.model); });
        Object.keys(masters).forEach(m => set.add(m));
        Object.keys(modelStandardMap || {}).forEach(m => set.add(m));
        return Array.from(set).sort();
    }, [lots, masters, modelStandardMap]);

    // 🚗 2026-09-12: 操業シミュの「編集」から飛んで来た時、その品目コードを開いた状態にする。
    //   ⚠ 人が画面で選び直した後に上書きしない(飛んで来た合図が変わった時だけ動く)。
    // (部品には操業シミュからの飛び先が無いので initialModel は初めの選択にだけ使う)

    // 品目コード1件ぶんを保存 (merge なので他の品目コードは触らない)
    const writeMaster = (model, patch) => {
        const cur = masters[model];
        const now = clockNow();
        const next = { ...(cur || { model, note: '', createdAt: now, templates: [] }), ...patch, updatedAt: now };
        return saveSettings({ modelMasters: { ...masters, [model]: next } });
    };
    const writeEntries = (newEntries) => { if (selectedModel) writeMaster(selectedModel, { templates: newEntries }); };

    // 🗂 2026-09-17 名前を渡して登録する形にした(未登録リストの「品目コードを登録」も同じ道を通る)
    const createModelNamed = (name) => {
        const m = String(name || '').trim();
        if (!m) return;
        if (masters[m]) { setSelectedModel(m); setNewModelName(''); return; } // 既にあるなら選ぶだけ
        const now = clockNow();
        saveSettings({ modelMasters: { ...masters, [m]: { model: m, note: '', createdAt: now, updatedAt: now, templates: [] } } });
        setSelectedModel(m);
        setNewModelName('');
    };
    const createModel = () => createModelNamed(newModelName);
    // 🗂 品目コードマスタ 未登録リスト(進捗管理表の取込で「品目コードマスタに品目コードの登録なし」で落ちた行)。品目コードごとにまとめる。
    const pendingRows = useMemo(() => (pendingImport && Array.isArray(pendingImport.rows) ? pendingImport.rows : []), [pendingImport]);
    const pendingGroups = useMemo(() => pendingGroupsOf(pendingRows, { modelMasters: masters, qualityStandards: qualityStandards || {}, modelStandardMap: modelStandardMap || {} }), [pendingRows, masters, qualityStandards, modelStandardMap]);
    const pendingCountOf = (m) => pendingRows.filter(r => r && String(r.model || '').trim() === String(m || '').trim()).length;

    const deleteModel = async (m) => {
        const mm = masters[m];
        if (!mm) return;
        const dedicatedDocs = (modelTemplates || []).filter(d => d && d.model === m);
        const msg = `品目コード「${m}」を品目コードマスタから削除しますか？\n`
            + `・テンプレ設定 ${Array.isArray(mm.templates) ? mm.templates.length : 0}件 の登録が消えます\n`
            + (dedicatedDocs.length ? `・品目コード専用テンプレ ${dedicatedDocs.length}件 も一緒に削除します\n` : '')
            + `・既存ロットは焼き付け済みなので影響ありません`;
        if (!confirm(msg)) return;
        // 順序は doc削除→設定削除。専用テンプレdocの削除に失敗したら設定は消さない
        //   (先に設定を消すと、失敗時に「マスタから消えたのに専用テンプレだけ残る」宙ぶらりんになる)。
        try {
            if (typeof deleteData === 'function') {
                for (const d of dedicatedDocs) { await deleteData('model_templates', d.id); }
            }
        } catch (e) {
            alert('品目コード専用テンプレの削除に失敗しました: ' + ((e && e.message) || e) + '\n品目コードマスタの設定は消していません。通信状態を確認して、もう一度お試しください。');
            return;
        }
        // ⚠消せてから選択を外す。先に外すと「消えたように見えて残っている」になる
        try {
            await deleteSettingsFields([['modelMasters', m]]);
        } catch (e) {
            alert('品目コードマスタの削除に失敗しました: ' + ((e && e.message) || e) + ' 通信を確かめて、もう一度お試しください。');
            return;
        }
        if (selectedModel === m) setSelectedModel('');
    };

    // --- テンプレートエントリの操作 -----------------------------------------
    const addEntry = () => {
        if (!selectedModel) return;
        writeEntries([...entries, { templateId: '', standardNo: '', revision: '' }]);
    };
    const setEntryField = (idx, patch) => {
        writeEntries(entries.map((e, i) => i === idx ? { ...e, ...patch } : e));
    };
    // 📅➡📋 3つの日数(K33・納期・入荷)を打ち替えて欄から離れたら、
    //   「検査リストの関係するロットも直しますか」を出す(清水さん 2026-09-09 の依頼4)。
    //   🚨 保存(writeEntries)は今までどおり1文字ごとに済ませる。窓は **その後** に1回だけ。
    //     打つたびに窓を出すと、中身を読まずに押す癖が付く。
    // 🚚 2026-09-11 出荷日の何日前までに検査を終えるか(shipDaysBefore)も日数の1つ。ここに足さないと、打ち替えても案内が出ない。
    const DAY_KEYS = ['daysBefore', 'dueDaysBefore', 'entryDaysBefore', 'shipDaysBefore'];
    const daysFocusRef = useRef({});
    const onDaysFocus = (idx) => {
        const e = entries[idx] || {};
        daysFocusRef.current[idx] = { daysBefore: e.daysBefore ?? null, dueDaysBefore: e.dueDaysBefore ?? null, entryDaysBefore: e.entryDaysBefore ?? null, shipDaysBefore: e.shipDaysBefore ?? null };
    };
    const onDaysBlur = (idx) => {
        const before = daysFocusRef.current[idx];
        delete daysFocusRef.current[idx];
        const after = entries[idx];
        if (!before || !after || typeof onEntryDaysChanged !== 'function') return;
        if (DAY_KEYS.every(k => (before[k] ?? null) === (after[k] ?? null))) return;   // 打ち替えていない
        onEntryDaysChanged({ model: selectedModel, templateId: after.templateId || '', before, after });
    };
    const setEntryTemplateId = async (idx, newTemplateId) => {
        // 同じ品目コード内で同じテンプレは1回だけ (旧・品質規格マスタと同じルール)
        if (newTemplateId && entries.some((e, i) => i !== idx && e.templateId === newTemplateId)) {
            alert('同じテンプレートはこの品目コードに 1 回しか登録できません');
            return;
        }
        // 🗂 2026-09-17 未登録リストに この品目コードの行が在るなら、テンプレを割り当てた直後に「今 検査リストへ登録しますか」と聞く
        //   (清水さん「そこで登録したら、そのリストのやつが自動で登録する」)。
        //   🚨 保存が settings に届く前に判定すると「まだテンプレが無い」と嘘を言うので、今の品目コードマスタを ctxOverride で渡す。
        const nextEntries = entries.map((e, i) => i === idx ? { ...e, templateId: newTemplateId } : e);
        const wasReady = entries.some(e => e && e.templateId);
        const pendN = selectedModel ? pendingCountOf(selectedModel) : 0;
        if (!(newTemplateId && !wasReady && pendN > 0 && typeof onRegisterPending === 'function')) { setEntryField(idx, { templateId: newTemplateId }); return; }
        try { await writeMaster(selectedModel, { templates: nextEntries }); }
        catch (e) { alert('品目コードマスタの保存に失敗しました: ' + ((e && e.message) || e)); return; }
        const nextMasters = { ...masters, [selectedModel]: { ...(masters[selectedModel] || { model: selectedModel, templates: [] }), templates: nextEntries } };
        if (confirm(`品目コード「${selectedModel}」にテンプレートを割り当てました。\n未登録リストに この品目コードの行が ${pendN}行 あります。今 検査リストへ登録しますか？\n\n（テンプレートをまだ足すなら「キャンセル」。後で上の未登録リストの「検査リストへ登録」から登録できます）`)) {
            onRegisterPending(selectedModel, { modelMasters: nextMasters });
        }
    };
    // 🚨 2026-09-12: 消す式は App の removeModelTemplateEntry ただ1本。
    //   操業シミュからも同じ物を呼ぶので、ここへ書き写さない(2画面で食い違わない為)。
    //   テンプレ未選択の行(まだ何も割り当てていない下書き)だけは、ここで並びから外す。
    const removeEntry = (idx) => {
        const entry = entries[idx] || {};
        if (!entry.templateId) {
            if (!confirm('まだテンプレートを選んでいない行です。並びから外しますか？')) return;
            writeEntries(entries.filter((_, i) => i !== idx));
            return;
        }
        if (typeof onRemoveEntry === 'function') { onRemoveEntry(selectedModel, entry.templateId); return; }
        const tplName = templates.find(t => t.id === entry.templateId)?.name || '(未選択)';
        if (!confirm(`テンプレート「${tplName}」の設定 (規格番号・該当なしトグルなど) をこの品目コードから削除しますか？`)) return;
        writeEntries(entries.filter((_, i) => i !== idx));
    };

    // 「使う/該当なし」トグル (stepProfile.enabled)。undefined/null は除去 (Firestore は undefined 不可)。
    //   templates は配列なので merge 保存でも丸ごと差し替わる = キー削除がそのまま効く。
    const updateStepProfile = (idx, stepId, patch) => {
        const cur = { ...(entries[idx]?.stepProfile || {}) };
        const merged = { ...(cur[stepId] || {}), ...patch };
        Object.keys(merged).forEach(k => { if (merged[k] === undefined || merged[k] === null) delete merged[k]; });
        if (Object.keys(merged).length === 0) delete cur[stepId]; else cur[stepId] = merged;
        writeEntries(entries.map((e, i) => i === idx ? { ...e, stepProfile: cur } : e));
    };

    // --- 旧・品質規格マスタ → 品目コードマスタ 取り込み ---------------------------
    const importQs = async (qs) => {
        const m = String(importModelNames[qs.id] ?? (qs.name || '')).trim();
        if (!m) { alert('品目コード名を入力してください'); return; }
        const qsEntries = getQsTemplateEntries(qs); // 新旧フォーマットを正規化 (公差/条件/初期値/チェック/プロファイルごと持ち込む)
        if (qsEntries.length === 0) { alert('この規格にはテンプレート設定がありません'); return; }
        const cur = masters[m];
        const curEntries = Array.isArray(cur?.templates) ? cur.templates : [];
        const used = new Set(curEntries.map(e => e.templateId || ''));
        const added = qsEntries.filter(e => !used.has(e.templateId || '')).map(e => ({
            ...e,
            standardNo: qs.standardNo || '',
            revision: qs.revision || '',
        }));
        // 追加できるものが1件も無い = 全テンプレが既存エントリと重複。
        //   旧実装はここから「旧規格の削除確認」へ進んでいたが、何も取り込んでいないのに
        //   旧規格だけ消える誤誘導になるため、何もせず終了する。
        if (added.length === 0) {
            alert(`品目コード「${m}」には既に同じテンプレートのエントリがあるため、取り込みませんでした。\n旧規格はそのまま残します。`);
            return;
        }
        const now = clockNow();
        const nextMaster = {
            ...(cur || { model: m, note: qs.note || '', createdAt: now, templates: [] }),
            model: m,
            templates: [...curEntries, ...added],
            updatedAt: now,
        };
        try {
            await saveSettings({ modelMasters: { ...masters, [m]: nextMaster } });
        } catch {
            return; // ⚠保存に失敗したら旧QSは消さない (両方消えるのが最悪)
        }
        setSelectedModel(m);
        // 保存が成功してから、確認の上で旧QSを削除 (紐付いていた旧マッピングも一緒に)
        const usedModels = Object.entries(modelStandardMap || {}).filter(([, v]) => v === qs.id).map(([k]) => k);
        if (confirm(`品目コードマスタ「${m}」へ取り込みました (テンプレ設定 ${added.length}件追加)。\n`
            + `旧・品質規格「${qs.standardNo || ''} ${qs.name || ''}」を旧マスタから削除しますか？\n`
            + (usedModels.length ? `(旧の品目コードマッピング ${usedModels.join(', ')} も一緒に解除します)\n` : '')
            + `※残しても、品目コードマスタの方が優先されます`)) {
            try {
                await deleteSettingsFields([
                    ['qualityStandards', qs.id],
                    ...usedModels.map(um => ['modelStandardMap', um]),
                ]);
            } catch (e) {
                alert('旧・品質規格の削除に失敗しました: ' + ((e && e.message) || e) + ' 品目コードマスタへの取り込みは済んでいます（旧の方が残っているだけです）。');
            }
        }
    };

    return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mt-6">
            <h3 className="text-lg font-bold mb-2 flex items-center gap-2 text-slate-800">
                <ClipboardCheck className="w-5 h-5 text-indigo-600" /> 品目コードマスタ
            </h3>
            {/* 🚨 2026-09-11 清水さん「品目コードマスタがどんな機能になっているのか謎で、もう少しわかりやすくしないとだめかな、表現とか見た目ね」
                → 何をする場所かを ①②③ の3つに分けて、ふつうの日本語で書く。文字は 12px の床(.fi-tap-text)。 */}
            <div className="fi-tap-text text-slate-600 mb-4 leading-relaxed space-y-1.5">
                <div>この画面は <b>品目コードごとに「どう検査するか」と「いつまでにやるか」</b> を決める場所です。</div>
                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))' }}>
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5">
                        <b className="text-indigo-800">① 使うテンプレート</b>
                        <div>その品目コードで行う検査の型紙。1つの品目コードに何本でも登録できます。</div>
                    </div>
                    <div className="rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-1.5">
                        <b className="text-orange-800">② その品目コードだけの工程</b>
                        <div>各工程の<b>「編集」</b>で変えた中身は<b>この品目コードだけ</b>に効き、共通のテンプレートは変わりません。</div>
                    </div>
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5">
                        <b className="text-rose-800">③ Excel から取り込む時の日数</b>
                        <div>納期と入荷を何日ずらすか。<b>取り込む時だけ</b>効きます（下の4つの欄）。</div>
                    </div>
                </div>
                <div>品質規格番号は <span className="font-bold text-indigo-700">分かったときに書けばOK（空でも全部動きます）</span>。</div>
            </div>

            {/* 品目コードの選択 + 新規登録 */}
            <div className="flex flex-wrap items-end gap-3 mb-4">
                <div className="flex-1 min-w-[240px]">
                    <label className="block text-xs font-bold text-slate-600 mb-1">編集する品目コード</label>
                    <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="w-full border rounded p-2 text-sm bg-slate-50">
                        <option value="">-- 品目コードを選択 --</option>
                        {modelList.map(m => (
                            <option key={m} value={m}>{m}{nameOf(m) ? `｜${nameOf(m)}` : ''}（テンプレ {Array.isArray(masters[m]?.templates) ? masters[m].templates.length : 0}件）</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">新しい品目コード名</label>
                    <input value={newModelName} onChange={e => setNewModelName(e.target.value)} list="mm-known-models"
                        onKeyDown={e => { if (e.key === 'Enter') createModel(); }}
                        placeholder="例: RTT-441" className="w-44 border rounded p-2 text-sm"/>
                    <datalist id="mm-known-models">
                        {knownModels.filter(m => !masters[m]).map(m => <option key={m} value={m}/>)}
                    </datalist>
                </div>
                <button type="button" onClick={createModel} disabled={!newModelName.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white px-3 py-2 rounded text-sm font-bold shadow flex items-center gap-1">
                    <Plus className="w-4 h-4" /> 品目コードを登録
                </button>
            </div>

            {/* 🧯 2026-09-18 同じ指図×品目コード×テンプレの未完了ロットの重複(実測 26組52件: 8/21 の登録と 9/17 17:46 の取込の対)。
                数えるのは純関数 lotDuplicates.js。消すのは人が押した時だけ(deleteData(lots) ただ1つ)。残す1件は 記録がある物(無ければ一番古い物)。 */}
            {Array.isArray(duplicateGroups) && duplicateGroups.length > 0 && (
                <div data-lot-duplicates={duplicateGroups.length} className="mb-4 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
                    <div className="text-sm font-bold text-rose-900">🧯 重複しているロット — {duplicateSummaryText(duplicateGroups)}</div>
                    <div className="fi-tap-text text-rose-800 mt-1">原因: 進捗管理表の取込が「もう在るロット」を見つけられなかった（30日の中のロットが多すぎて古い分が読めていなかった。読み方は直しました）。残す1件＝作業の記録がある物、無ければ一番古い物。</div>
                    <div className="mt-2 flex flex-col gap-1">
                        {duplicateGroups.slice(0, 60).map((g) => (
                            <div key={g.key} data-lot-duplicate-group={g.key} className="flex flex-wrap items-center gap-2 rounded border border-rose-200 bg-white px-2 py-1">
                                <span className="fi-tap-text font-bold text-slate-800">指図 {g.orderNo} {g.model}｜{(templates.find((t) => t.id === g.templateId) || {}).name || g.templateId}</span>
                                <span className="fi-tap-text text-slate-600">{g.needsReview ? `要確認（${g.differs.map((d) => d.label).join('・')}が違う。同じ物と決められないので一括削除に入れません） ` : ''}{g.lots.map((r) => `${r.id === g.keepId ? '残す' : (r.hasWork ? '記録あり' : '消せる')}: ${r.createdAt ? localYMD(new Date(r.createdAt)) : '日付なし'} ${r.importSource || '手'} 納期${r.dueDate || '—'}`).join(' ／ ')}</span>
                                {g.removeIds.length > 0 && typeof onDeleteLots === 'function'
                                    ? <button type="button" data-lot-duplicates-remove={g.removeIds.length} onClick={() => onDeleteLots(g.removeIds)} className="min-h-11 px-3 rounded-lg border-2 border-rose-400 bg-white text-rose-700 font-black fi-tap-text ml-auto">記録の無い {g.removeIds.length}件を消す</button>
                                    : <span className="fi-tap-text text-slate-500 ml-auto">記録が両方に在るので、人が見て決めてください</span>}
                            </div>
                        ))}
                        {duplicateGroups.some((g) => g.removeIds.length) && typeof onDeleteLots === 'function' ? (
                            <button type="button" data-lot-duplicates-remove="all" onClick={() => onDeleteLots(duplicateGroups.flatMap((g) => g.removeIds))} className="min-h-11 self-start px-3 rounded-lg bg-rose-600 text-white font-black fi-tap-text">記録の無い重複を全部消す（{duplicateGroups.reduce((n, g) => n + g.removeIds.length, 0)}件）</button>
                        ) : null}
                    </div>
                </div>
            )}
            {/* 🗂 2026-09-17 品目コードマスタ 未登録リスト(清水さん「品目コードマスタに未登録リストみたいなのがあって、そこで登録したら、そのリストのやつが自動で登録する」) */}
            {pendingGroups.length > 0 && (
                <div data-model-master-pending={pendingRows.length} className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="text-sm font-bold text-amber-900">🗂 未登録リスト — 進捗管理表に在るのに 品目コードマスタに無い品目コード（{pendingGroups.length}種 / {pendingRows.length}行）</div>
                        <div className="fi-tap-text text-amber-800">{pendingImport && pendingImport.fileName ? `取込: ${pendingImport.fileName}` : ''}{pendingImport && pendingImport.at ? ` ${localYMD(new Date(pendingImport.at))}` : ''}</div>
                    </div>
                    <div className="fi-tap-text text-amber-800 mt-1">
                        <b>品目コードを登録</b> → <b>使うテンプレートを割り当てる</b> と、その品目コードの行を <b>検査リストへ登録</b> できます（Excel を取り込み直す必要はありません）。
                    </div>
                    <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(20rem, 1fr))' }}>
                        {pendingGroups.map(g => (
                            <div key={g.model} data-pending-model={g.model} data-pending-ready={g.ready ? '1' : '0'} className="rounded-lg border border-amber-200 bg-white px-2.5 py-2 flex items-center gap-2 flex-wrap">
                                <div className="min-w-0 flex-1">
                                    <div className="font-mono font-bold text-slate-800 truncate">{g.model} <span className="font-sans font-normal fi-tap-text text-slate-500">{g.rows.length}行 / {g.orders}指図</span></div>
                                    <div className="fi-tap-text text-slate-500 truncate">{g.rows.slice(0, 4).map(r => r.orderNo).join('・')}{g.rows.length > 4 ? ' …' : ''}</div>
                                    <div className="fi-tap-text font-bold">{g.ready ? <span className="text-emerald-700">✓ テンプレ割当済み — 登録できます</span> : (g.inMaster ? <span className="text-amber-700">品目コードは登録済み — テンプレートが未割当</span> : <span className="text-rose-700">品目コードマスタに無い</span>)}</div>
                                </div>
                                {g.ready
                                    ? <button type="button" onClick={() => typeof onRegisterPending === 'function' && onRegisterPending(g.model)} className="min-h-11 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold shadow">検査リストへ登録</button>
                                    : (g.inMaster
                                        ? <button type="button" onClick={() => setSelectedModel(g.model)} className="min-h-11 px-3 rounded border border-amber-400 bg-amber-100 hover:bg-amber-200 text-amber-900 text-sm font-bold">テンプレを割り当てる</button>
                                        : <button type="button" onClick={() => createModelNamed(g.model)} className="min-h-11 px-3 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold shadow flex items-center gap-1"><Plus className="w-4 h-4" /> 品目コードを登録</button>)}
                                <button type="button" onClick={() => typeof onRemovePending === 'function' && onRemovePending(g.model)} title="登録せずにリストから外す" className="min-h-11 px-2 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 fi-tap-text">外す</button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 選択中の品目コードの編集 */}
            {master && (
                <div className="space-y-3">
                    {/* メタ情報 (備考 + 品目コード削除) */}
                    <div className="text-base font-black text-slate-800">{selectedModel}{nameOf(selectedModel) ? <span className="font-bold text-slate-500">｜{nameOf(selectedModel)}</span> : null}</div>
                    <div className="bg-slate-50 rounded-lg p-3 flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-[220px]">
                            <label className="block fi-tap-text font-bold text-slate-600 mb-0.5">備考</label>
                            <textarea value={master.note || ''} onChange={e => writeMaster(selectedModel, { note: e.target.value })}
                                className="w-full border rounded p-1 text-sm" rows={2} placeholder="仕様のメモ・規格書の出典など"/>
                        </div>
                        <button type="button" onClick={() => deleteModel(selectedModel)}
                            className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded text-xs font-bold flex items-center gap-1">
                            <Trash2 className="w-3 h-3" /> この品目コードを削除
                        </button>
                    </div>

                    {/* テンプレート追加 */}
                    <div className="bg-indigo-50/50 border border-indigo-200 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-bold text-indigo-900 flex items-center gap-1.5">
                                <ClipboardList className="w-4 h-4"/> 使うテンプレート ({entries.length} 件)
                                <span className="fi-tap-text font-normal text-indigo-600 ml-1">受入→中間→最終 のように複数並べられます</span>
                            </div>
                            <button type="button" onClick={addEntry} className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded font-bold flex items-center gap-1">
                                <Plus className="w-3 h-3"/> テンプレート追加
                            </button>
                        </div>
                        {entries.length === 0 && (
                            <div className="text-xs text-slate-400 text-center py-3">「+ テンプレート追加」でこの品目コードが使うテンプレートを追加してください</div>
                        )}
                    </div>

                    {/* 各テンプレートエントリのカード */}
                    {entries.map((entry, entryIdx) => {
                        const tpl = templates.find(t => t.id === entry.templateId);
                        const dedicated = findModelTemplate(modelTemplates, selectedModel, entry.templateId);
                        const stepsForList = (dedicated && Array.isArray(dedicated.steps) && dedicated.steps.length > 0) ? dedicated.steps : (tpl?.steps || []);
                        const otherUsed = entries.map((e, i) => i !== entryIdx ? e.templateId : null).filter(Boolean);
                        return (
                            <div key={entryIdx} className="border-2 border-indigo-200 rounded-lg overflow-hidden">
                                {/* エントリヘッダー */}
                                <div className="bg-indigo-100 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
                                    <div className="flex items-center gap-2 text-sm font-bold text-indigo-900 min-w-0">
                                        <span className="bg-indigo-600 text-white fi-tap-text font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0">{entryIdx + 1}</span>
                                        <span className="truncate">{tpl?.name || '(テンプレート未選択)'}</span>
                                        {dedicated && <span className="fi-tap-text bg-orange-100 text-orange-700 border border-orange-300 px-1.5 py-0.5 rounded font-bold shrink-0" title="このテンプレの工程はこの品目コード専用に編集されています">✏️ 専用テンプレ編集済み</span>}
                                        {/* 🔄 共通テンプレとの差。⚠既定で必ず出す。
                                            「見せない/触らないはフラグで隠さず置き場所で守る」の逆側 =
                                            **見えないこと自体が事故** なので、ここは隠さない。押さなければ何も起きない。 */}
                                        {dedicated && tpl && (() => {
                                            const d = tsDiff(tpl.steps || [], Array.isArray(dedicated.steps) ? dedicated.steps : [], tsPolicy(dedicated).stepMap);
                                            if (!d.hasDiff) return <span className="fi-tap-text bg-emerald-50 text-emerald-700 border border-emerald-300 px-1.5 py-0.5 rounded font-bold shrink-0" title="共通の工程テンプレートと同じ内容です">共通と同じ</span>;
                                            const parts = [d.counts.added && `+${d.counts.added}`, d.counts.removed && `-${d.counts.removed}`, d.counts.changed && `変${d.counts.changed}`].filter(Boolean).join(' ');
                                            return (
                                                <button type="button" onClick={() => onOpenSync && onOpenSync(selectedModel, entry.templateId)}
                                                    className="fi-tap-text bg-amber-100 text-amber-800 border border-amber-400 px-1.5 py-0.5 rounded font-black shrink-0 hover:bg-amber-200"
                                                    title="共通の工程テンプレートと差があります。押すと、何が違うかと、反映するかどうかを選べます">
                                                    ⚠ 共通と差あり（{parts}）
                                                </button>
                                            );
                                        })()}
                                        {dedicated && Array.isArray(dedicated.prevSteps) && (
                                            <button type="button" onClick={() => onUndoSync && onUndoSync(selectedModel, entry.templateId)}
                                                className="fi-tap-text bg-white text-slate-600 border border-slate-300 px-1.5 py-0.5 rounded font-bold shrink-0 hover:border-slate-500"
                                                title={`${dedicated.prevAt ? new Date(dedicated.prevAt).toLocaleString('ja-JP') : ''} の反映を取り消して、その前の状態に戻します（1回だけ）`}>
                                                ↩ 反映を取り消す
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                        {/* 📥 Excel から取り込む時の日数。
                                            🚨 2026-09-11 清水さん「品目コードマスタはもう少しわかりやすくしないとだめかな、表現とか見た目ね」
                                              それまでは 9px・10px の札が3つ横に並び、どれが何を起点にした日数か読めなかった。
                                              4つとも「何の日から 何日」を **ふつうの日本語1文** で書き、
                                              文字は 12px の床(.fi-tap-text)・入れる所は 44px 以上にする。
                                            🚨 起点が違う物を同じ見た目で並べない。左の色帯で見分ける。 */}
                                        <div className="w-full rounded-lg border border-slate-300 bg-slate-50 p-2">
                                            <div className="fi-tap-text font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                                                <FileSpreadsheet className="w-4 h-4 text-slate-500"/> Excel から取り込む時の日数
                                                <span className="font-normal text-slate-500">（空なら 取込の既定を使います）</span>
                                            </div>
                                            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(17rem, 1fr))' }}>
                                                {/* ① 🚚 出荷日(AD列)の何日前までに検査を終えるか ＝ 一番大事な納期 */}
                                                <label className="flex items-center gap-2 rounded-lg border-l-4 border-l-rose-400 border border-slate-200 bg-white px-2 py-1.5">
                                                    <span className="fi-tap-text flex-1 min-w-0 leading-snug text-slate-700">
                                                        <b className="text-rose-700">出荷日</b>の
                                                        <input type="number" value={entry.shipDaysBefore ?? ''} placeholder="1"
                                                            onFocus={() => onDaysFocus(entryIdx)} onBlur={() => onDaysBlur(entryIdx)}
                                                            onChange={e => setEntryField(entryIdx, { shipDaysBefore: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                                                            className="fi-tap-text mx-1 w-14 border rounded px-1 text-center font-mono bg-white align-middle"
                                                            style={{ minHeight: 'max(2.75rem, 44px)' }}/>
                                                        日前までに検査を終える
                                                        <span className="block text-slate-500">＝ 一番大事な納期（進捗管理表の出荷日の列）</span>
                                                    </span>
                                                </label>
                                                {/* ② 🗓 入荷登録Excel の納期をずらす */}
                                                <label className="flex items-center gap-2 rounded-lg border-l-4 border-l-sky-400 border border-slate-200 bg-white px-2 py-1.5">
                                                    <span className="fi-tap-text flex-1 min-w-0 leading-snug text-slate-700">
                                                        <b className="text-sky-700">入荷登録Excel の納期</b>の
                                                        <input type="number" value={entry.dueDaysBefore ?? ''} placeholder="0"
                                                            onFocus={() => onDaysFocus(entryIdx)} onBlur={() => onDaysBlur(entryIdx)}
                                                            onChange={e => setEntryField(entryIdx, { dueDaysBefore: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                                                            className="fi-tap-text mx-1 w-14 border rounded px-1 text-center font-mono bg-white align-middle"
                                                            style={{ minHeight: 'max(2.75rem, 44px)' }}/>
                                                        日前を納期にする
                                                        <span className="block text-slate-500">工機進捗管理表には効きません</span>
                                                    </span>
                                                </label>
                                                {/* ③ 🚚 入荷は納期の何日前か */}
                                                <label className="flex items-center gap-2 rounded-lg border-l-4 border-l-amber-400 border border-slate-200 bg-white px-2 py-1.5">
                                                    <span className="fi-tap-text flex-1 min-w-0 leading-snug text-slate-700">
                                                        <b className="text-amber-700">入荷</b>は 納期の
                                                        <input type="number" value={entry.entryDaysBefore ?? ''} placeholder="3"
                                                            onFocus={() => onDaysFocus(entryIdx)} onBlur={() => onDaysBlur(entryIdx)}
                                                            onChange={e => setEntryField(entryIdx, { entryDaysBefore: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                                                            className="fi-tap-text mx-1 w-14 border rounded px-1 text-center font-mono bg-white align-middle"
                                                            style={{ minHeight: 'max(2.75rem, 44px)' }}/>
                                                        日前
                                                        <span className="block text-slate-500">進捗管理表の入荷の列が空の行と、入荷登録Excel で使います</span>
                                                    </span>
                                                </label>
                                                {/* ④ 📅 入荷の日しか無い行の、最後の手段 */}
                                                <label className="flex items-center gap-2 rounded-lg border-l-4 border-l-emerald-400 border border-slate-200 bg-white px-2 py-1.5">
                                                    <span className="fi-tap-text flex-1 min-w-0 leading-snug text-slate-700">
                                                        <b className="text-emerald-700">入荷の日</b>の
                                                        <input type="number" value={entry.daysBefore ?? ''} placeholder="0"
                                                            onFocus={() => onDaysFocus(entryIdx)} onBlur={() => onDaysBlur(entryIdx)}
                                                            onChange={e => setEntryField(entryIdx, { daysBefore: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                                                            className="fi-tap-text mx-1 w-14 border rounded px-1 text-center font-mono bg-white align-middle"
                                                            style={{ minHeight: 'max(2.75rem, 44px)' }}/>
                                                        日後を 仮の納期にする
                                                        <span className="block text-slate-500">出荷日も納期も書いていない行だけ。負の数＝何日前</span>
                                                    </span>
                                                </label>
                                            </div>
                                        </div>
                                        <select value={entry.templateId || ''} onChange={e => setEntryTemplateId(entryIdx, e.target.value)}
                                            className="text-xs border rounded p-1 bg-white max-w-[200px]" title="このエントリに割り当てるテンプレート">
                                            <option value="">-- 未選択 --</option>
                                            {templates.filter(t => !otherUsed.includes(t.id) || t.id === entry.templateId).map(t => (
                                                <option key={t.id} value={t.id}>{t.name}</option>
                                            ))}
                                        </select>
                                        {dedicated && (
                                            <button type="button" onClick={() => onRevertModelTemplate && onRevertModelTemplate(selectedModel, entry.templateId)}
                                                className="fi-tap-text bg-white text-orange-700 border border-orange-300 hover:bg-orange-50 px-2 py-1 rounded font-bold"
                                                title="この品目コード専用の工程編集を削除して、共通の工程テンプレートに戻す">共通に戻す</button>
                                        )}
                                        <button type="button" onClick={() => removeEntry(entryIdx)} className="text-rose-600 hover:bg-rose-100 p-1 rounded" title="このテンプレート設定を削除">
                                            <Trash2 className="w-3.5 h-3.5"/>
                                        </button>
                                    </div>
                                </div>

                                {/* エントリ本体 */}
                                <div className="p-3 bg-white space-y-3">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                        <div className="md:col-span-2">
                                            <label className="block fi-tap-text font-bold text-slate-600 mb-0.5">品質規格番号 <span className="font-normal text-slate-400">(任意 — 分かったときに記入すればOK)</span></label>
                                            <input value={entry.standardNo || ''} onChange={e => setEntryField(entryIdx, { standardNo: e.target.value })}
                                                placeholder="例: 835-KQ-113（空でも動きます）" className="w-full border rounded p-1.5 text-sm font-mono"/>
                                        </div>
                                        <div>
                                            <label className="block fi-tap-text font-bold text-slate-600 mb-0.5">Rev</label>
                                            <input value={entry.revision || ''} onChange={e => setEntryField(entryIdx, { revision: e.target.value })}
                                                placeholder="A" className="w-full border rounded p-1.5 text-sm"/>
                                        </div>
                                    </div>

                                    {!entry.templateId ? (
                                        <div className="text-sm text-slate-400 py-4 text-center bg-slate-50 rounded">
                                            右上のドロップダウンで対象テンプレートを選択してください
                                        </div>
                                    ) : stepsForList.length === 0 ? (
                                        <div className="text-sm text-slate-400 py-4 text-center bg-slate-50 rounded">
                                            このテンプレートに工程がありません
                                        </div>
                                    ) : (
                                        <div className="border-t-2 border-indigo-100 pt-2">
                                            <div className="text-xs font-black text-indigo-700 mb-1">🧩 工程（この品目コードで使う工程・品目コード専用の編集）</div>
                                            <div className="fi-tap-text text-slate-500 mb-1.5">「該当なし」にした工程はこの品目コードのロット作成時に自動でスキップ（作業者は検査画面で解除可）。工程の中身を変えたい時は「編集」から — <span className="font-bold text-orange-700">この品目コードだけの情報</span>として保存され、共通の工程テンプレートは変わりません。</div>
                                            <div className="space-y-1">
                                                {stepsForList.map(step => {
                                                    const prof = entry.stepProfile?.[step.id] || {};
                                                    const enabled = prof.enabled !== false;
                                                    const isAuto = isAutoStep(step); // 共通判定(A.1)
                                                    return (
                                                        <div key={step.id} className={`rounded border ${enabled ? 'border-slate-200 bg-white' : 'border-slate-300 bg-slate-100'}`}>
                                                            <div className="flex items-center gap-2 px-2 py-1">
                                                                <button onClick={() => updateStepProfile(entryIdx, step.id, { enabled: enabled ? false : undefined })}
                                                                    className={`fi-tap-text font-bold px-2 py-0.5 rounded border whitespace-nowrap ${enabled ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-slate-400 text-white border-slate-500'}`}>
                                                                    {enabled ? '使う' : '該当なし'}
                                                                </button>
                                                                {isAuto && <span className="fi-tap-text bg-purple-100 text-purple-700 px-1 rounded shrink-0">自動</span>}
                                                                <span className={`text-xs font-bold flex-1 truncate ${enabled ? 'text-slate-800' : 'text-slate-400 line-through'}`} title={step.title}>{step.title}</span>
                                                                {step.jigNo && <span className="fi-tap-text font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">🔧治具:{step.jigNo}</span>}
                                                                {step.programNo && <span className="fi-tap-text font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 shrink-0">📐Prg:{step.programNo}</span>}
                                                                <button onClick={() => onEditModelStep && onEditModelStep(selectedModel, entry.templateId, step.id)}
                                                                    className="fi-tap-text bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-0.5 rounded font-bold shrink-0 flex items-center gap-1"
                                                                    title="この工程をこの品目コード専用に編集する（共通テンプレは変わりません）">
                                                                    <Pencil className="w-3 h-3"/> 編集
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 旧・品質規格マスタからの取り込み (旧データが残っている時だけ出る) */}
            {qsList.length > 0 && (
                <div className="mt-6 border-2 border-amber-200 rounded-lg overflow-hidden">
                    <div className="bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">📦 旧・品質規格マスタからの取り込み ({qsList.length}件)</div>
                    <div className="p-3 space-y-2 bg-white">
                        <p className="fi-tap-text text-slate-500">
                            旧形式の品質規格が残っています。品目コード名を確認して「品目コードマスタへ取り込む」を押すと、テンプレート設定・規格番号・工程の該当なし設定ごと品目コードマスタへ移せます (取り込み後、旧データを消すか確認します)。
                        </p>
                        {qsList.map(qs => (
                            <div key={qs.id} className="border border-amber-200 rounded p-2 flex items-center gap-2 flex-wrap text-xs">
                                <span className="font-mono font-bold text-amber-800">{qs.standardNo || '(規格番号なし)'}</span>
                                {qs.revision ? <span className="text-slate-500">Rev.{qs.revision}</span> : null}
                                <span className="font-bold text-slate-700 flex-1 min-w-[80px] truncate">{qs.name || '(名称なし)'}</span>
                                <label className="fi-tap-text text-slate-500">品目コード名:</label>
                                <input value={importModelNames[qs.id] ?? (qs.name || '')} onChange={e => setImportModelNames(p => ({ ...p, [qs.id]: e.target.value }))}
                                    list="mm-known-models" placeholder="品目コード名" className="w-36 border rounded p-1 text-xs"/>
                                <button type="button" onClick={() => importQs(qs)} className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded text-xs font-bold">品目コードマスタへ取り込む</button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 品目コード一覧 (全体俯瞰) */}
            {modelList.length > 0 && (
                <div className="mt-6 pt-4 border-t">
                    <div className="text-xs font-bold text-slate-500 mb-2">品目コード一覧 ({modelList.length} 件)</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                        {modelList.map(m => {
                            const mm = masters[m];
                            const tplCount = Array.isArray(mm?.templates) ? mm.templates.length : 0;
                            const stdNos = [...new Set((mm?.templates || []).map(e => e.standardNo).filter(Boolean))];
                            return (
                                <div key={m} className="bg-indigo-50 border border-indigo-200 rounded px-2 py-1.5 text-xs flex items-center justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="font-bold text-indigo-900 truncate">{m}{nameOf(m) ? <span className="font-normal text-indigo-700">｜{nameOf(m)}</span> : null}</div>
                                        <div className="text-indigo-600 fi-tap-text truncate">テンプレ {tplCount}件{stdNos.length ? ` ・規格 ${stdNos.join(', ')}` : ' ・規格番号 未記入'}</div>
                                    </div>
                                    <button type="button" onClick={() => { setSelectedModel(m); document.querySelector('[data-mm-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className="text-indigo-600 hover:text-indigo-800 p-1" title="この品目コードを編集"><Pencil className="w-3 h-3" /></button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};
export default ModelMasterPanel;
