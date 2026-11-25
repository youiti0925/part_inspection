// 🗂 SAP 工程の仕分けの登録画面(管理者だけ直せる・旗 feature:sapSort が ON の時だけ出る・既定 OFF)
// 目的: ①作業区を機械のグループ(旋盤・研削…)へ仕分ける ②検査テンプレートを SAP の作業区に結びつける ③画面の言葉(辞書)を変える。直した所は「保存」を押した時の1件だけ書く(読み取りは増やさない)
// 入力: loader(登録を読む=開いた時に1回だけ)・saver(保存=管理者だけ通る)・userName・templates/modelTemplates(結びつけの選び肢)・groupLabels(グループの辞書)。SAP の表の行は sapSortEdit.js の置き場から(端末の中だけ)
// 呼ぶ人: App.jsx のマスタ設定(SapProgressPanel の下)
// 触る外の物: 保存だけ(saver 経由で settings/sap_sort の1文書)。管理者でない人は見るだけ(押しても書かない)
// 確かめ方: node --test src/domain/__tests__/sapSortEdit.test.mjs ／ エミュレータの実画面(docs/登録画面_1126)
import { useEffect, useMemo, useState } from 'react';
import { applySapSortOnce, isSapSortAdmin, sapSortFlagOn } from './domain/sapSortStore.js';
import { DEFAULT_SAP_SORT, setActiveSapSort } from './domain/sapSort.js';
import { LABEL_CATALOG, COMMON_WORDS, buildLabels, setActiveLabels } from './domain/labels.js';
import {
    assignWc, removeShared, sortTargets, rangeText, wcsInGroup, placementOf, compareSort, sameReg, withLabel, clearLabels, labelsOf,
    templateChoices, siteWcChoices, setTemplateWc, linkedWcs, getSharedSortRows, subscribeSharedSortRows,
} from './domain/sapSortEdit.js';

const DICT_COMMANDER = 'machine';   // 画面の言葉の辞書を持たせる司令塔(機械グループ・SAP の画面が使う)
const WHERE = { 'src/MachineGroupView.jsx': '機械グループの画面', 'src/SapProgressPanel.jsx': 'SAP 工程の進みの画面' };
const NOT_ADMIN = '直せるのは管理者の人だけです。ヘッダー左上で「管理者」を選んでください(今は見るだけです)。';
const btn = 'px-3 py-1.5 rounded border text-xs font-bold ';
const TABS = [['sort', '工程の仕分け'], ['tpl', 'テンプレートと工程'], ['dict', '画面の言葉(辞書)']];

/** 入力欄: 打っている間は自分の中だけ・欄を出た時か Enter で確定(1文字ごとに登録を作り直さない) */
function CommitInput({ value, onCommit, disabled, placeholder, testId, width = 'w-44' }) {
    const [v, setV] = useState(value);
    useEffect(() => { setV(value); }, [value]);
    return <input value={v} disabled={disabled} placeholder={placeholder} data-testid={testId} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} className={`border rounded px-2 py-1 text-sm ${width} disabled:bg-slate-100`} />;
}

export default function SapSortAdmin({ loader = null, saver = null, userName = '', templates = [], modelTemplates = [], groupLabels = null }) {
    const [loaded, setLoaded] = useState(null);   // { reg, rev, usedDefault, errors } = 今保存されている登録
    const [draft, setDraft] = useState(null);     // 画面で直している登録(保存するまで本番へは行かない)
    const [tab, setTab] = useState('sort');
    const [rows, setRows] = useState(getSharedSortRows());
    const [form, setForm] = useState({ wc: '', group: '', shared: false });
    const [filter, setFilter] = useState('');
    const [msg, setMsg] = useState(null);
    const [busy, setBusy] = useState(false);
    const admin = isSapSortAdmin(userName);
    const on = sapSortFlagOn();

    useEffect(() => subscribeSharedSortRows(setRows), []);
    useEffect(() => {
        if (!on) return undefined;
        let dead = false;
        (async () => {
            const r = await applySapSortOnce({ loader });   // 仕分けの画面と同じ1回を分け合う(ここでは読みを増やさない)
            if (dead) return;
            const reg = r && r.reg ? r.reg : DEFAULT_SAP_SORT;
            setLoaded({ reg, rev: Number.isFinite(reg.rev) ? reg.rev : 1, usedDefault: !r || r.usedDefault !== false, errors: (r && r.errors) || [] });
            setDraft(reg);
        })();
        return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on]);

    const targets = useMemo(() => (draft ? sortTargets(draft) : []), [draft]);
    const cmp = useMemo(() => (loaded && draft ? compareSort(rows, loaded.reg, draft) : null), [rows, loaded, draft]);
    const changed = !!(loaded && draft && !sameReg(loaded.reg, draft));
    const choices = useMemo(() => templateChoices({ templates, modelTemplates }), [templates, modelTemplates]);
    const siteWcs = useMemo(() => (draft ? siteWcChoices(draft) : []), [draft]);
    if (!on) return null;
    if (!loaded || !draft) return <section data-testid="sap-sort-admin" className="bg-white border border-slate-300 rounded-lg p-4 my-4 text-sm text-slate-500">仕分けの登録を読み込んでいます…</section>;

    const sum = cmp;
    const unsortedNow = compareSort(rows, draft, draft);   // 今の下書きで数えた物(未分類・グループごとの件数・重なり)
    const unList = unsortedNow.unclassifiedList;
    const unN = unsortedNow.unclassified.after;
    const edit = (fn) => { setMsg(null); try { setDraft(fn(draft)); } catch (e) { setMsg({ ok: false, text: e && e.message ? e.message : String(e) }); } };
    const place = (wc, group) => edit((d) => assignWc(d, wc, group));
    const dictEdit = (part, key, value) => { const r = withLabel(draft, DICT_COMMANDER, part, key, value); if (r.problems.length) setMsg({ ok: false, text: r.problems.join(' / ') }); else { setMsg(null); setDraft(r.reg); } };
    const save = async () => {
        setBusy(true); setMsg(null);
        try {
            const r = await saver(draft, loaded.rev);
            setActiveLabels(buildLabels({ commander: labelsOf(draft, DICT_COMMANDER), group: groupLabels }));   // 保存した言葉と仕分けを、いま開いている画面にもすぐ効かせる
            setActiveSapSort(draft);
            setLoaded({ reg: draft, rev: r.rev, usedDefault: false, errors: [] });
            setMsg({ ok: true, text: `保存しました(第${r.rev}版)。` });
        } catch (e) { setMsg({ ok: false, text: e && e.message ? e.message : String(e) }); } finally { setBusy(false); }
    };
    const pl = form.wc && /^\d{1,6}$/.test(form.wc.trim()) ? placementOf(draft, form.wc.trim()) : null;
    const wantGroup = form.group || (targets[0] && targets[0].key) || '';
    const mainCountOf = (key) => (unsortedNow.groups.find((g) => g.key === key) || { after: 0 }).after;
    const dictKeys = labelsOf(draft, DICT_COMMANDER);
    const tplLinked = choices.filter((c) => linkedWcs(draft, c.id).length).length;
    const shownTpl = choices.filter((c) => !filter || c.label.includes(filter) || c.model.includes(filter)).slice(0, 200);
    const overlapNames = unsortedNow.overlaps.map((o) => ({ wc: o.wc, names: o.groups.map((k) => { for (const c of draft.commanders) for (const g of c.groups) if (g.key === k) return g.name; return k; }) }));

    return (
        <section data-testid="sap-sort-admin" className="bg-white border border-slate-300 rounded-lg p-4 my-4 text-sm text-slate-800">
            <h2 className="text-lg font-bold mb-1">🗂 SAP 工程の仕分け <span className="text-xs font-normal text-slate-500">(どの作業区が、どのグループの仕事かを決めます)</span></h2>
            <div className="flex flex-wrap items-center gap-2 mb-2" role="tablist" data-testid="sap-sort-tabs">
                {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`sap-sort-tab-${k}`} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === k ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{l}</button>)}
                <span className="text-xs text-slate-500">{admin ? '管理者として直せます' : '見るだけ(直せるのは管理者だけ)'}</span>
            </div>
            {!admin && <p data-testid="sap-sort-not-admin" className="text-xs bg-amber-50 border border-amber-300 text-amber-800 rounded px-2 py-1 mb-2">{NOT_ADMIN}</p>}
            {loaded.usedDefault && <p className="text-xs text-slate-500 mb-2">まだ保存した登録はありません。今の部品検査の画面と同じ分け方から始まります。{loaded.errors.length ? ` (${loaded.errors[0]})` : ''}</p>}

            {tab === 'sort' && (<div data-testid="sap-sort-pane-sort">
                <div className="text-xs text-slate-500">この工程は、どのグループの仕事か</div>
                <div className="text-lg font-bold my-1" data-testid="sap-sort-answer">
                    {!rows.length ? 'SAP の表を選ぶと、まだ仕分けていない工程の件数が出ます' : unList.length ? <>まだ仕分けていない工程が <span className="text-rose-600">{unList.length}つ</span>(未完了 {unN}件)あります</> : <span className="text-emerald-700">全部の工程が、どれかのグループに入っています</span>}
                </div>
                {!rows.length && <p className="text-xs text-slate-500 mb-1">上の「SAP 工程の進み」で xlsx を選ぶと数えます(選んだ表は送信も保存もしません)。作業区の番号だけで仕分ける事もできます。</p>}
                {unList.length > 0 && (<div className="overflow-x-auto"><table className="w-full min-w-[460px] text-xs border-collapse mb-2" data-testid="sap-sort-unsorted">
                    <thead><tr className="bg-slate-50 text-slate-500 text-left"><th className="p-1.5">作業区</th><th className="p-1.5">作業の言葉(よく出る物)</th><th className="p-1.5 text-right">未完了</th><th className="p-1.5">どのグループへ入れるか</th></tr></thead>
                    <tbody>{unList.map((u) => (
                        <tr key={u.wc} className="border-t"><td className="p-1.5 font-bold">{u.wc}</td><td className="p-1.5">「{String(u.sample).replace(/^\d{4}[:\s]+/, '')}」</td><td className="p-1.5 text-right">{u.n}件</td>
                            <td className="p-1.5">{/^\d+$/.test(u.wc) ? <select disabled={!admin} data-testid={`sap-sort-pick-${u.wc}`} value="" onChange={(e) => e.target.value && place(u.wc, e.target.value)} className="border rounded px-1 py-1 disabled:bg-slate-100"><option value="">選ぶ</option>{targets.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}</select> : <span className="text-slate-400">作業区の番号が無い工程です</span>}</td></tr>))}</tbody></table></div>)}

                <h3 className="font-bold mt-3 mb-1">機械のグループ <span className="text-xs font-normal text-slate-500">番号の範囲と、いま入っている作業区</span></h3>
                <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5" data-testid="sap-sort-groups">
                    {targets.map((t) => {
                        const g = draft.commanders.flatMap((c) => c.groups).find((x) => x.key === t.key);
                        const wcs = wcsInGroup(g);
                        const shr = draft.commanders.flatMap((c) => c.groups).find((x) => x.key === `${t.key}__shared`);
                        return (
                            <div key={t.key} data-testid={`sap-sort-group-${t.key}`} className={`border rounded-lg p-2 ${form.group === t.key ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}`}>
                                <div className="font-bold">{t.name} <span className="text-[11px] font-normal text-slate-500">{rangeText(g) || (t.key === 'wash' ? '「洗浄」の言葉' : '')}</span></div>
                                <div className="text-[11px] text-slate-500 mb-1">作業区 {wcs.length}・{rows.length ? `未完了 ${mainCountOf(t.key)}件` : '件数は SAP の表を選ぶと出ます'}</div>
                                <div className="flex flex-wrap gap-1">
                                    {form.group !== t.key && admin && <button type="button" data-testid={`sap-sort-edit-${t.key}`} onClick={() => setForm({ wc: '', group: t.key, shared: false })} className={btn + 'bg-white !py-0.5'}>直す</button>}
                                    {form.group === t.key && wcs.slice(0, 40).map((w) => <button key={w} type="button" disabled={!admin} title="この作業区を直す" onClick={() => setForm({ wc: w, group: t.key, shared: false })} className="px-1.5 py-0.5 rounded bg-slate-100 text-[11px] hover:bg-indigo-100 disabled:hover:bg-slate-100">{w}</button>)}
                                    {form.group === t.key && wcs.length > 40 && <span className="text-[11px] text-slate-400">ほか {wcs.length - 40}</span>}
                                    {shr && wcsInGroup(shr).map((w) => <span key={`s${w}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[11px]" title="重ね入れ(数には足しません)">{w} ＋重ね{admin && <button type="button" aria-label={`${w} の重ねを外す`} onClick={() => edit((d) => removeShared(d, w, t.key))} className="font-bold">×</button>}</span>)}
                                </div>
                            </div>);
                    })}
                </div>

                <div className="mt-3 border rounded-lg p-2 bg-slate-50" data-testid="sap-sort-form">
                    <div className="font-bold text-xs mb-1">作業区を直す <span className="font-normal text-slate-500">(作業区を選んで、入れるグループを選びます・作った後でも直せます)</span></div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <label>作業区 <input value={form.wc} disabled={!admin} inputMode="numeric" data-testid="sap-sort-form-wc" onChange={(e) => setForm({ ...form, wc: e.target.value })} className="border rounded px-2 py-1 w-24 disabled:bg-slate-100" placeholder="例 2397" /></label>
                        <label>入れるグループ <select value={wantGroup} disabled={!admin} data-testid="sap-sort-form-group" onChange={(e) => setForm({ ...form, group: e.target.value })} className="border rounded px-1 py-1 disabled:bg-slate-100">{targets.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}</select></label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={form.shared} disabled={!admin} data-testid="sap-sort-form-shared" onChange={(e) => setForm({ ...form, shared: e.target.checked })} />重ねて入れる(元のグループにも残し、数には足しません)</label>
                        <button type="button" disabled={!admin || !pl} data-testid="sap-sort-form-go" onClick={() => edit((d) => assignWc(d, form.wc.trim(), wantGroup, { shared: form.shared }))} className={btn + 'bg-indigo-600 text-white border-indigo-600 disabled:opacity-40'}>入れる</button>
                    </div>
                    {pl && <p className="text-xs text-slate-600 mt-1" data-testid="sap-sort-form-now">作業区 {pl.wc} は今: {pl.name ? `「${pl.name}」に入っています` : 'どのグループにも入っていません'}{pl.shared.length ? `(重ね入れ: ${pl.shared.map((s) => s.name).join('・')})` : ''}</p>}
                </div>
                {overlapNames.length > 0 && <p className="text-xs mt-2 bg-indigo-50 border border-indigo-200 rounded px-2 py-1" data-testid="sap-sort-overlaps">重なっている番号(数える先は1つだけ・重ね入れは数に足しません): {overlapNames.map((o) => `${o.wc}(${o.names.join('・')})`).join('、')}</p>}
                <p className="text-[11px] text-slate-500 mt-2">当てる順は決まっています: 検査の作業区 → 「洗浄」の言葉 → 付帯作業 → 番号の範囲 → 「仕様変更」→ 工程の名前の言葉。直せるのは「どの番号が、どのグループか」です。</p>

                <h3 className="font-bold mt-3 mb-1">保存の前の確かめ <span className="text-xs font-normal text-slate-500">今 → 変えた後</span></h3>
                {sum && !sum.valid && <p className="text-xs bg-rose-50 border border-rose-300 text-rose-700 rounded px-2 py-1 mb-1" data-testid="sap-sort-invalid">この登録は保存できません: {sum.errors.join(' / ')}</p>}
                {sum && sum.valid && (changed
                    ? <p className={`text-xs rounded px-2 py-1 mb-1 border ${sum.total.same ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-rose-50 border-rose-300 text-rose-700'}`} data-testid="sap-sort-check">{rows.length ? (sum.total.same ? `全体の件数は変わりません(${sum.total.after}件)。重なっている番号: ${sum.overlaps.length ? `${sum.overlaps.length}つ(印あり)` : 'ありません'}。保存できます。` : `全体の件数が変わっています(${sum.total.before}件 → ${sum.total.after}件)。保存しないでください。`) : '直した所があります。SAP の表を選ぶと、件数の変わり方をここで確かめられます。'}</p>
                    : <p className="text-xs text-slate-500 mb-1" data-testid="sap-sort-check">まだ直していません。</p>)}
                {sum && rows.length > 0 && changed && (<table className="w-full text-xs border-collapse mb-1" data-testid="sap-sort-check-table"><thead><tr className="bg-slate-50 text-slate-500 text-left"><th className="p-1.5">グループ</th><th className="p-1.5 text-right">未完了の件数</th></tr></thead><tbody>
                    {sum.groups.filter((g) => g.before !== g.after).map((g) => <tr key={g.key} className="border-t"><td className="p-1.5">{g.name}</td><td className="p-1.5 text-right">{g.before}件 → <b>{g.after}件</b></td></tr>)}
                    <tr className="border-t"><td className="p-1.5">まだ仕分けていない物</td><td className="p-1.5 text-right">{sum.unclassified.before}件 → <b>{sum.unclassified.after}件</b></td></tr>
                    <tr className="border-t font-bold"><td className="p-1.5">全体(変わってはいけない数)</td><td className="p-1.5 text-right">{sum.total.before}件 → {sum.total.after}件</td></tr></tbody></table>)}
            </div>)}

            {tab === 'tpl' && (<div data-testid="sap-sort-pane-tpl">
                <div className="text-xs text-slate-500">この検査テンプレートは、SAP のどの工程に当たるか</div>
                <div className="text-lg font-bold my-1" data-testid="sap-sort-tpl-answer">結びつけ済み <span className="text-emerald-700">{tplLinked}つ</span>・まだ <span className="text-rose-600">{choices.length - tplLinked}つ</span></div>
                <p className="text-xs text-slate-500 mb-1">結びつけが無いテンプレートは、今までと同じ動き(品目と作業区だけで見ます)。表は左右にスクロールできます →</p>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="品目コードかテンプレート名で絞る" data-testid="sap-sort-tpl-filter" className="border rounded px-2 py-1 text-xs w-64 mb-2" />
                {!choices.length ? <p className="text-xs text-slate-500">検査テンプレートがまだありません。</p> : (<div className="overflow-x-auto"><table className="w-full min-w-[560px] text-xs border-collapse" data-testid="sap-sort-tpl-table">
                    <thead><tr className="bg-slate-50 text-slate-500 text-left"><th className="p-1.5">品目コード</th><th className="p-1.5">検査テンプレート</th><th className="p-1.5">SAP の工程</th><th className="p-1.5">今の状態</th></tr></thead>
                    <tbody>{shownTpl.map((c) => { const cur = linkedWcs(draft, c.id)[0] || ''; return (
                        <tr key={c.id} className="border-t"><td className="p-1.5 font-bold">{c.model || '(共通)'}</td><td className="p-1.5">{c.label}</td>
                            <td className="p-1.5"><select value={cur} disabled={!admin} data-testid={`sap-sort-tpl-${c.id}`} onChange={(e) => edit((d) => setTemplateWc(d, c.id, e.target.value))} className="border rounded px-1 py-1 disabled:bg-slate-100"><option value="">結びつけなし(今と同じ)</option>{siteWcs.map((w) => <option key={w.wc} value={w.wc}>{w.wc} {w.label}</option>)}</select></td>
                            <td className="p-1.5">{cur ? <span className="px-2 py-0.5 rounded-full bg-emerald-600 text-white whitespace-nowrap">● 結びつけ済み</span> : <span className="px-2 py-0.5 rounded bg-amber-500 text-white whitespace-nowrap">◆ まだ</span>}</td></tr>); })}</tbody></table></div>)}
                {choices.length > shownTpl.length && <p className="text-xs text-slate-500 mt-1">{shownTpl.length}件まで出しています。品目コードで絞ってください。</p>}
                <p className="text-[11px] text-slate-500 mt-2">結びつけると: SAP で「受入検査(2519)が今日来る見込み」と分かった品目に、どのテンプレートで検査するかが先に出ます。</p>
            </div>)}

            {tab === 'dict' && (<div data-testid="sap-sort-pane-dict">
                <div className="text-xs text-slate-500">画面の言葉を、どう呼ぶか(辞書)</div>
                <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-xs border-collapse mt-1" data-testid="sap-sort-dict-table">
                    <thead><tr className="bg-slate-50 text-slate-500 text-left"><th className="p-1.5">今の画面の言葉</th><th className="p-1.5">こう呼ぶ</th><th className="p-1.5">どこで</th><th className="p-1.5" /></tr></thead>
                    <tbody>{LABEL_CATALOG.map((e) => { const v = dictKeys.keys[e.key] || ''; return (
                        <tr key={e.key} className="border-t"><td className="p-1.5">{e.text}</td>
                            <td className="p-1.5"><CommitInput value={v} disabled={!admin} placeholder="(今のまま)" testId={`sap-sort-dict-${e.key}`} onCommit={(nv) => dictEdit('keys', e.key, nv)} /></td>
                            <td className="p-1.5 text-slate-500">{WHERE[e.where] || e.where}</td>
                            <td className="p-1.5">{v && <button type="button" disabled={!admin} data-testid={`sap-sort-dict-reset-${e.key}`} onClick={() => dictEdit('keys', e.key, '')} className={btn + 'bg-white disabled:opacity-40'}>既定に戻す</button>}</td></tr>); })}</tbody></table></div>
                <h3 className="font-bold mt-3 mb-1 text-xs">よく使う単語 <span className="font-normal text-slate-500">(画面の中のその言葉が、全部置き換わります)</span></h3>
                <div className="grid gap-x-4 gap-y-1 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" data-testid="sap-sort-dict-words">
                    {COMMON_WORDS.map((w) => <label key={w} className="flex items-center gap-2 text-xs"><span className="w-24 shrink-0">{w}</span><CommitInput value={dictKeys.words[w] || ''} disabled={!admin} placeholder="(今のまま)" testId={`sap-sort-word-${w}`} width="w-32" onCommit={(nv) => dictEdit('words', w, nv)} /></label>)}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" disabled={!admin || !(Object.keys(dictKeys.keys).length || Object.keys(dictKeys.words).length)} data-testid="sap-sort-dict-reset-all" onClick={() => { setMsg(null); setDraft(clearLabels(draft, DICT_COMMANDER)); }} className={btn + 'bg-white disabled:opacity-40'}>辞書を全部「既定(今の言葉)」に戻す</button>
                    <span className="text-[11px] text-slate-500">何も入れていない言葉は、今の画面のまま(1文字も変わりません)。計算に使う目印と単位は変えられません。長さは 30 文字までです。</span></div>
            </div>)}

            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t" data-testid="sap-sort-savebar">
                <button type="button" disabled={!admin || !changed || busy || (sum && !sum.valid)} data-testid="sap-sort-save" onClick={save} className={btn + 'bg-indigo-600 text-white border-indigo-600 disabled:opacity-40'}>保存する(第{loaded.rev + 1}版になります)</button>
                <button type="button" disabled={!changed || busy} data-testid="sap-sort-revert" onClick={() => { setMsg(null); setDraft(loaded.reg); }} className={btn + 'bg-white disabled:opacity-40'}>直した所を元に戻す</button>
                <span className="text-xs text-slate-500">今は 第{loaded.rev}版{loaded.usedDefault ? '(保存した物は無し・今と同じ分け方)' : ''}。{admin ? '' : '直せるのは管理者だけです。'}</span>
            </div>
            {msg && <p data-testid="sap-sort-msg" className={`text-xs mt-2 rounded px-2 py-1 border ${msg.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-rose-50 border-rose-300 text-rose-700'}`}>{msg.text}</p>}
        </section>
    );
}
