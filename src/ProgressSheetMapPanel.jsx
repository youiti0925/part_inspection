// 📊 P053 進捗管理表の読み方(表ごと)。製品 ProgressSheetMapPanel(25501-25760)を部品へ写した画面。
//   判定は domain/progressSheet.js の純関数(normalizeSheetProfiles / sheetMapProblems / detectColumns / profilesToSettings)。
//   ここは入れてもらう欄と、穴を赤で出すだけ。設定は settings.progressSheetProfiles / progressSheetMap に入る(製品と同じ鍵)。
//   部品の言葉: 「型式」→「品目コード」。Excel を開く道は App.jsx の openProgressBook_pi を openBook で受け取る。
import React, { useState, useRef } from 'react';
import { FileSpreadsheet, Upload, RotateCcw } from 'lucide-react';
import {
  DEFAULT_SHEET_MAP, K33_MEANS, normalizeSheetProfiles, sheetMapProblems, profilesToSettings, makeProfileId, detectColumns,
} from './domain/progressSheet.js';

/** 割付の欄。[鍵, 見出し, 説明, 必ず要るか]。部品の既定は製品と同じ列(C=品目番号・D=品目コード)。 */
const PROGRESS_MAP_FIELDS = [
    ['orderNo', '指図番号', '数字だけの指図。ここが読めないと1行も取り込めません', true],
    ['productNo', '品目番号', 'PARTS品を外すのに使います（空でも動きます）', false],
    ['model', '品目コード', '品質規格マスタを引く鍵。ここが読めないと1行も取り込めません', true],
    ['qty', '台数（指図数量）', '正の整数だけ受けます（空・小数・文字混じりは 台数を触らず、新規は理由を出して作りません）', false],
    ['k33', '入荷の日（K33）', '検査に品物が来る日。ここが読めないと1行も取り込めません', true],
    ['shipDate', '出荷日', '一番大事な納期。この日の「何日前までに検査を終えるか」を品質規格で決めます（空でも動きます）', false],
    ['start', '納期（基準終了日付）', '出荷日が入っていない行の納期（空でも動きます）', false],
    ['assyDone', '組立の完了予定日', '出荷日も納期も入荷も無い行の 最後の手段（空でも動きます）', false],
];

const ProgressSheetMapPanel = ({ settings, saveSettings, openBook }) => {
    // 📚 2026-09-11 清水さん「Excel毎で形式が変わるから、Excel毎…の取込みカスタマイズできるように」
    //   表は1つではない。割付を **表ごと** に何本でも持ち、取り込む時に選ぶ。
    //   🚨 選んだ物は progressSheetMap にも書き戻す(古い道が読んでも答えが割れない)。
    const { profiles, activeId } = normalizeSheetProfiles(settings, DEFAULT_SHEET_MAP);
    const current = profiles.find(p => p.id === activeId) || profiles[0];
    const map = current.map;
    const problems = sheetMapProblems(map, DEFAULT_SHEET_MAP);
    const [detectBusy, setDetectBusy] = useState('');
    const detectRef = useRef(null);
    // 押す物は 44px 以上(手袋でも押せる大きさ)
    const TAP = { minHeight: 'max(2.75rem, 44px)' };

    /** 一覧ごと保存する(選んだ表も一緒に書き戻す)。 */
    const writeAll = (list, nextId) => saveSettings(profilesToSettings(list, nextId || activeId, DEFAULT_SHEET_MAP));
    /** いま選んでいる表の割付だけを直す。 */
    const write = (patch) => writeAll(profiles.map(p => (p.id === activeId ? { ...p, map: { ...p.map, ...patch } } : p)));
    const writeCol = (key, v) => write({ cols: { ...map.cols, [key]: v } });
    const renameActive = (name) => writeAll(profiles.map(p => (p.id === activeId ? { ...p, name } : p)));
    const selectProfile = (id) => writeAll(profiles, id);
    const addProfile = (copyFrom) => {
        const base = copyFrom ? { ...map, cols: { ...map.cols } } : { ...DEFAULT_SHEET_MAP, cols: { ...DEFAULT_SHEET_MAP.cols } };
        const id = makeProfileId('tbl');
        const name = copyFrom ? `${current.name} の写し` : `表${profiles.length + 1}`;
        writeAll([...profiles, { id, name, map: base }], id);
    };
    const removeActive = () => {
        if (profiles.length <= 1) { alert('表の割付は 1つは残ります。名前と中身を直してお使いください。'); return; }
        if (!confirm(`「${current.name}」の割付を消します。よろしいですか？\n（取り込んだロットは消えません。割付だけです）`)) return;
        const rest = profiles.filter(p => p.id !== activeId);
        writeAll(rest, rest[0].id);
    };

    // ✍ 打っている途中の字は手元に置き、**欄から離れた時に1回だけ** 保存する(2026-09-10)。
    //   🚨 前は1文字ごとに saveSettings を投げていた(「最終検査状況」と打つと7回)。
    const [draft, setDraft] = useState(null);
    const shown = (key, cur) => (draft && key in draft ? draft[key] : cur);
    const onType = (key, v) => setDraft(d => ({ ...(d || {}), [key]: v }));
    const commit = () => setDraft(null);
    const resetToDefault = () => {
        if (!confirm(`「${current.name}」を 既定（いまの表の形）に戻しますか？\n入れた列の字・シート名・メモは消えます。`)) return;
        commit();
        write({ ...DEFAULT_SHEET_MAP, cols: { ...DEFAULT_SHEET_MAP.cols } });
    };

    // 🔍 選んだファイルの見出し行(開始行の1〜2行上)を読んで、列を当てる。
    //   ⚠ 当てた結果は confirm で見せてから入れる(黙って設定を書き換えない)。
    const detectFromFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        e.target.value = '';
        setDetectBusy('この表の見出しを読んでいます…');
        try {
            // 📊 2026-09-10: 取込本体と同じ2人目の読み手(ExcelJS が落ちる表でも見出しを読める)
            const wb = await openBook(await file.arrayBuffer());
            const sheet = await wb.getWorksheet(map.sheetName);
            if (!sheet) {
                const names = (wb.worksheets || []).map(w => w.name);
                alert(`「${map.sheetName}」シートが見つかりません。\n\nこのファイルに入っているシート:\n・${names.join('\n・')}\n\n上の「シート名」を、この中の どれかに直してください。`);
                return;
            }
            const headerRows = [];
            for (let r = Math.max(1, map.firstDataRow - 2); r < map.firstDataRow; r++) {
                const row = sheet.getRow(r);
                const cells = [];
                for (let c = 1; c <= 200; c++) {
                    const v = row.getCell(c).value;
                    cells[c - 1] = v == null ? ''
                        : (typeof v === 'object'
                            ? (Array.isArray(v.richText) ? v.richText.map(t => t.text).join('') : String(v.result != null ? v.result : (v.text != null ? v.text : '')))
                            : String(v));
                }
                headerRows.push(cells);
            }
            const found = detectColumns(headerRows);
            const keys = Object.keys(found);
            if (!keys.length) {
                alert('見出しの行から列を見つけられませんでした。\n「データの開始行」が合っているか確かめてください（見出しは 開始行の1〜2行上 を読みます）。');
                return;
            }
            const lines = keys.map(k => `・${(PROGRESS_MAP_FIELDS.find(f => f[0] === k) || [k, k])[1]} → ${found[k]}列`);
            if (!confirm(`この表から次の列を読み取りました。\n\n${lines.join('\n')}\n\nこの内容で「${current.name}」の欄を書き換えますか？\n（違っていたら「既定に戻す」で戻せます）`)) return;
            commit();
            write({ cols: { ...map.cols, ...found }, fileHint: file.name });
        } catch (err) {
            alert('読み取りに失敗しました: ' + ((err && err.message) || err));
        } finally {
            setDetectBusy('');
        }
    };

    return (
        <div data-progress-sheet-map="1" className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 ">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                    <FileSpreadsheet className="w-5 h-5 text-indigo-600" /> 📊 進捗管理表の読み方（表ごと）
                </h3>
                <div className="flex gap-2 flex-wrap">
                    <button type="button" onClick={() => detectRef.current && detectRef.current.click()} disabled={!!detectBusy}
                        style={TAP}
                        className="text-xs px-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded font-bold flex items-center gap-1.5">
                        <Upload className="w-4 h-4" /> {detectBusy || 'この表から自動で読み取る'}
                    </button>
                    <input type="file" ref={detectRef} accept=".xlsx" onChange={detectFromFile} className="hidden" />
                    <button type="button" onClick={resetToDefault} style={TAP}
                        className="text-xs px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-bold flex items-center gap-1.5">
                        <RotateCcw className="w-4 h-4" /> 既定に戻す
                    </button>
                </div>
            </div>

            {/* 📚 表の選び口。清水さん「進捗データのExcelは何種類もあって今は一種類だけあるような感じになってる」 */}
            <div data-progress-sheet-profiles="1" className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 mb-3">
                <div className="text-xs font-bold text-indigo-900 mb-1.5">どの表の読み方を直しますか</div>
                <div className="flex flex-wrap items-center gap-2">
                    {profiles.map(p => (
                        <button type="button" key={p.id} data-progress-sheet-profile={p.id}
                            onClick={() => { commit(); selectProfile(p.id); }} style={TAP}
                            className={`text-xs px-3 rounded-lg border font-bold ${p.id === activeId
                                ? 'border-indigo-600 bg-indigo-600 text-white'
                                : 'border-indigo-300 bg-white text-indigo-800 hover:bg-indigo-100'}`}>
                            {p.name}
                        </button>
                    ))}
                    <button type="button" data-progress-sheet-profile-add="1" onClick={() => addProfile(false)} style={TAP}
                        className="text-xs px-3 rounded-lg border border-dashed border-indigo-400 bg-white text-indigo-700 font-bold">＋ 別の表を足す</button>
                    <button type="button" onClick={() => addProfile(true)} style={TAP}
                        className="text-xs px-3 rounded-lg border border-indigo-300 bg-white text-indigo-700 font-bold">この表を写して足す</button>
                </div>
                <div className="flex flex-wrap items-end gap-2 mt-2">
                    <div className="flex-1 min-w-[14rem]">
                        <label className="block text-xs font-bold text-indigo-900 mb-1">この表の呼び名</label>
                        <input value={shown('name', current.name)}
                            onChange={e => onType('name', e.target.value)}
                            onBlur={e => { commit(); renameActive(e.target.value); }}
                            style={TAP} placeholder="例: 工機進捗管理表"
                            className="text-xs w-full border rounded p-2" />
                    </div>
                    <button type="button" data-progress-sheet-profile-remove="1" onClick={removeActive} style={TAP}
                        className="text-xs px-3 rounded-lg border border-rose-300 bg-white text-rose-700 font-bold">この表の割付を消す</button>
                </div>
                <div className="text-xs text-indigo-800 mt-1.5">
                    取り込む時は、開いた Excel の<b>シート名</b>から この中の どれかを自動で選びます。決められない時は 押して選んでもらいます。
                </div>
            </div>

            <p className="text-xs text-slate-600 mb-3 leading-relaxed">
                進捗管理表の Excel を取り込む時に、<b>どのシートの どの列を読むか</b>を決めます。
                表の形が変わったら ここを直せば、取込はそのまま使えます。列は Excel で見えるとおりの<b>列の字</b>（B・Z・AB）で入れてください。
            </p>

            {/* 🚨 割付の穴。読めない列があると取込は黙って0件になる。押す前に赤で出す */}
            {problems.length > 0 && (
                <div data-progress-sheet-map-problems="1" className="bg-rose-50 border border-rose-300 rounded-lg p-3 mb-3">
                    <div className="text-sm font-black text-rose-800 mb-1">⚠ この読み方には穴があります（このままだと取込が0件になります）</div>
                    <ul className="text-xs text-rose-700 list-disc pl-5 space-y-0.5">
                        {problems.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">シート名</label>
                    <input value={shown('sheetName', map.sheetName)}
                        onChange={e => onType('sheetName', e.target.value)}
                        onBlur={e => { commit(); write({ sheetName: e.target.value }); }}
                        style={TAP} placeholder={DEFAULT_SHEET_MAP.sheetName}
                        className="text-xs w-full border rounded p-2" />
                    <div className="text-xs text-slate-500 mt-0.5">見つからない時は、そのファイルに入っているシート名を全部出します</div>
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">データの開始行（1・2行目は見出し）</label>
                    <input type="number" min="1" value={shown('firstDataRow', map.firstDataRow)}
                        onChange={e => onType('firstDataRow', e.target.value)}
                        onBlur={e => { commit(); write({ firstDataRow: parseInt(e.target.value, 10) || DEFAULT_SHEET_MAP.firstDataRow }); }}
                        style={TAP} className="text-xs w-full border rounded p-2 font-mono" />
                    <div className="text-xs text-slate-500 mt-0.5">見出しは この行の 1〜2行上 を読みます</div>
                </div>
            </div>

            {/* 🚚 2026-09-11 清水さんの説明。同じ鍵でも表によって意味が違うので、推測させないで字で持つ。 */}
            <div data-progress-sheet-meaning="1" className="rounded-lg border border-slate-300 bg-slate-50 p-3 mb-4">
                <div className="text-xs font-bold text-slate-700 mb-1.5">日付の読み方</div>
                <div className="text-xs text-slate-600 mb-2">
                    納期は <b className="text-rose-700">出荷日</b> →（無ければ）<b className="text-sky-700">納期の列</b> →（どちらも無ければ）入荷の日から仮に作る、の順で決めます。
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                    {[[K33_MEANS.ARRIVAL, '入荷の日', '検査に品物が来る日（工機進捗管理表のZ列）'],
                      [K33_MEANS.DUE, '納期の基準', 'その列が納期そのもの（最終検査状況シートのC列）']].map(([v, label, help]) => (
                        <button type="button" key={v} data-progress-k33-means={v}
                            onClick={() => write({ k33Means: v })} style={TAP}
                            className={`text-xs px-3 rounded-lg border text-left font-bold ${map.k33Means === v
                                ? 'border-emerald-600 bg-emerald-600 text-white'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`}>
                            {PROGRESS_MAP_FIELDS.find(f => f[0] === 'k33')[1]} は「{label}」
                            <span className={`block font-normal ${map.k33Means === v ? 'text-emerald-50' : 'text-slate-500'}`}>{help}</span>
                        </button>
                    ))}
                </div>
                <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                    <b className="text-rose-700">出荷日</b>の
                    <input type="number" value={shown('shipDaysBefore', map.shipDaysBefore)}
                        onChange={e => onType('shipDaysBefore', e.target.value)}
                        onBlur={e => { commit(); write({ shipDaysBefore: e.target.value === '' ? DEFAULT_SHEET_MAP.shipDaysBefore : (parseInt(e.target.value, 10) || 0) }); }}
                        style={TAP} data-progress-ship-days="1"
                        className="text-xs w-16 border rounded px-1 text-center font-mono bg-white" />
                    日前までに検査を終える ＝ 納期
                    <span className="text-slate-500">（品質規格にその品目コードの日数が入っていれば そちらが勝ちます）</span>
                </label>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden mb-4">
                <div className="bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 border-b border-slate-200">列の割付</div>
                <div className="divide-y divide-slate-100">
                    {PROGRESS_MAP_FIELDS.map(([key, label, help, required]) => (
                        <div key={key} className="flex items-center gap-3 p-2 flex-wrap">
                            <div className="w-56 shrink-0">
                                <div className="text-xs font-bold text-slate-700">{label}{required && <span className="ml-1 text-rose-600">必須</span>}</div>
                                <div className="text-xs text-slate-500">{help}</div>
                            </div>
                            <input value={shown(`col:${key}`, map.cols[key] || '')}
                                onChange={e => onType(`col:${key}`, e.target.value)}
                                onBlur={e => { commit(); writeCol(key, e.target.value); }}
                                style={TAP} placeholder={required ? '例: B' : '空でも可'}
                                className={`text-xs w-24 border rounded p-2 font-mono text-center uppercase ${required && !map.cols[key] ? 'border-rose-400 bg-rose-50' : ''}`} />
                            <span className="text-xs text-slate-400">列（既定 {DEFAULT_SHEET_MAP.cols[key] || '—'}）</span>
                        </div>
                    ))}
                </div>
            </div>

            <label className="flex items-start gap-2 cursor-pointer mb-4" style={TAP}>
                <input type="checkbox" className="mt-1 w-5 h-5 accent-indigo-600 shrink-0" checked={!!map.grayIsShipped} onChange={e => write({ grayIsShipped: e.target.checked })} />
                <span className="text-xs text-slate-700"><b>灰色の行は「出荷済」とみなす</b> — 取り込まず、検査リストに残っていれば「表では終わっている」に出します。表の色の付け方が変わったら OFF にしてください。</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">ファイル名の目安</label>
                    <input value={shown('fileHint', map.fileHint)}
                        onChange={e => onType('fileHint', e.target.value)}
                        onBlur={e => { commit(); write({ fileHint: e.target.value }); }}
                        style={TAP} placeholder={DEFAULT_SHEET_MAP.fileHint}
                        className="text-xs w-full border rounded p-2" />
                    <div className="text-xs text-slate-500 mt-0.5">同じシート名の表が2つ在る時に、どちらかを決めるのに使います</div>
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">置き場所のメモ（人が読むだけ）</label>
                    <input value={shown('fileNote', map.fileNote)}
                        onChange={e => onType('fileNote', e.target.value)}
                        onBlur={e => { commit(); write({ fileNote: e.target.value }); }}
                        style={TAP} placeholder="例: 共有サーバーの 生産管理 → 進捗 の中"
                        className="text-xs w-full border rounded p-2" />
                    <div className="text-xs text-slate-500 mt-0.5">アプリはこの場所を見に行きません。人が探す時の道しるべです</div>
                </div>
            </div>
        </div>
    );
};

export default ProgressSheetMapPanel;
