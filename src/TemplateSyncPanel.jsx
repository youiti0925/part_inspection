// 🔄 共通の工程テンプレートを保存したときに出る「品目コードへ反映しますか？」の画面。
// 📋 P104 部品へ写した(製品 src/TemplateSyncPanel.jsx の画面の文言「型式」を「品目コード」に直しただけ。文言を直したので md5 の対にはしない)
//
// 清水さん(2026-08-10):「反映するかしないかや、反映する場合は何を反映するかとか細かく決めれたら。
//   ただ上書き反映したら、必要な情報まで消してしまうからね」
//
// ⚠⚠ この画面の役目は **押す前に結果を見せること**。
//   ・既定では何も反映されない(閉じれば今までどおり)
//   ・緑=増えるだけ / 赤=消える / 灰=判定不能で触らない、の3色で危険度が一目で分かる
//   ・「変更」は必ず **共通の値 → 品目コードの値** を実値で出す(項目名だけでは判断できない)
//   ・下の赤い箱に **この操作で消えるもの** を名指しで出す。1件も無ければ「消えるものはありません」
//
// ⚠ロジックは src/domain/templateSync.js(純関数・テストあり)。ここは描くだけ。

import React, { useMemo, useState } from 'react';
import { X, AlertTriangle, Plus, Minus, Pencil, HelpCircle, ShieldCheck } from 'lucide-react';
import { SYNC_FIELDS, diffTemplate, lossesOf, applySync, syncPolicyOf } from './domain/templateSync.js';

const Chip = ({ tone, children }) => (
  <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded border ${tone}`}>{children}</span>
);

export const TemplateSyncPanel = ({ templateName, baseSteps, targets, onApply, onClose }) => {
  // targets: [{ model, templateId, doc }] — doc = model_templates のドキュメント
  const [sel, setSel] = useState(() => {
    const o = {};
    (targets || []).forEach(t => { o[t.model] = syncPolicyOf(t.doc).fields; });
    return o;
  });
  const [open, setOpen] = useState(() => (targets || [])[0]?.model || '');
  const [busy, setBusy] = useState('');

  const rows = useMemo(() => (targets || []).map(t => {
    const ded = Array.isArray(t.doc?.steps) ? t.doc.steps : [];
    const stepMap = syncPolicyOf(t.doc).stepMap;
    const d = diffTemplate(baseSteps, ded, stepMap);
    return { ...t, ded, stepMap, diff: d };
  }), [targets, baseSteps]);

  const diffRows = rows.filter(r => r.diff.hasDiff);
  if (!diffRows.length) return null;

  const setField = (model, key, v) => setSel(s => ({ ...s, [model]: { ...s[model], [key]: v } }));

  const apply = async (r) => {
    const fields = sel[r.model];
    const losses = lossesOf(baseSteps, r.ded, fields, r.stepMap);
    const res = applySync(baseSteps, r.ded, fields, r.stepMap);
    const summary = [
      res.applied.added ? `工程を ${res.applied.added}件 追加` : '',
      res.applied.removed ? `工程を ${res.applied.removed}件 削除` : '',
      res.applied.changed ? `${res.applied.changed}件 の中身を変更` : '',
    ].filter(Boolean).join(' / ') || '変更はありません';
    // ⚠消える物がある時は、名指しでもう一度見せてから確認する。件数だけの確認にしない。
    const lossText = losses.length
      ? `\n\n⚠ この操作で消えるもの ${losses.length}件:\n` + losses.slice(0, 12).map(l => `・${l.title}: ${l.detail}`).join('\n')
        + (losses.length > 12 ? `\n…ほか ${losses.length - 12}件` : '')
      : '\n\n消えるものはありません。';
    if (!window.confirm(`品目コード「${r.model}」の専用テンプレに反映します。\n\n${summary}${lossText}\n\n反映しますか？（反映前の状態は1回だけ元に戻せます）`)) return;
    setBusy(r.model);
    try { await onApply(r, res, fields, losses); } finally { setBusy(''); }
  };

  return (
    <div className="fixed inset-0 z-[95] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 bg-indigo-600 text-white flex items-center gap-2 shrink-0">
          <div className="font-black text-lg min-w-0 truncate">共通テンプレ「{templateName}」と、品目コード専用テンプレに差があります</div>
          <button onClick={onClose} className="ml-auto p-2 -mr-2 hover:bg-white/20 rounded-full shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 bg-indigo-50 border-b border-indigo-100 text-xs text-indigo-900 shrink-0 leading-relaxed">
          専用テンプレを持つ品目コードには、共通テンプレの変更が<b>自動では届きません</b>（今までずっとそうでした）。<br />
          <b>ここで何もせず閉じても、今までどおり何も変わりません。</b>反映したい品目コードだけ、反映したい項目を選んでください。
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
          {diffRows.map(r => {
            const c = r.diff.counts;
            const isOpen = open === r.model;
            const fields = sel[r.model] || {};
            const losses = lossesOf(baseSteps, r.ded, fields, r.stepMap);
            return (
              <div key={r.model} className="border-2 border-slate-200 rounded-2xl overflow-hidden">
                <button onClick={() => setOpen(isOpen ? '' : r.model)} className="w-full px-4 py-3 flex items-center gap-2 flex-wrap text-left hover:bg-slate-50">
                  <span className="font-black text-slate-800">{r.model}</span>
                  {c.added > 0 && <Chip tone="bg-emerald-50 text-emerald-700 border-emerald-300">＋{c.added} 追加できる</Chip>}
                  {c.removed > 0 && <Chip tone="bg-rose-50 text-rose-700 border-rose-300">−{c.removed} 品目コードにしか無い</Chip>}
                  {c.changed > 0 && <Chip tone="bg-amber-50 text-amber-800 border-amber-300">{c.changed} 中身がちがう</Chip>}
                  {c.ambiguous > 0 && <Chip tone="bg-slate-100 text-slate-600 border-slate-300">{c.ambiguous} 判定できない</Chip>}
                  {r.diff.reordered && <Chip tone="bg-slate-100 text-slate-600 border-slate-300">並び順がちがう</Chip>}
                  <span className="ml-auto text-xs font-bold text-indigo-600">{isOpen ? '閉じる' : 'くわしく見る'}</span>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 flex flex-col gap-3 border-t border-slate-100 pt-3">
                    {/* 緑: 増えるだけ = 何も消えない */}
                    {c.added > 0 && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                        <div className="text-xs font-black text-emerald-800 mb-1.5 flex items-center gap-1"><Plus className="w-3.5 h-3.5" />共通に増えた工程（{c.added}）— 追加しても何も消えません</div>
                        <div className="text-xs text-emerald-900 flex flex-wrap gap-x-3 gap-y-1">
                          {r.diff.added.map(s => <span key={s.id}>・{s.title || '(名前なし)'}</span>)}
                        </div>
                      </div>
                    )}
                    {/* 赤: 消える */}
                    {c.removed > 0 && (
                      <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
                        <div className="text-xs font-black text-rose-800 mb-1.5 flex items-center gap-1"><Minus className="w-3.5 h-3.5" />この品目コードにしか無い工程（{c.removed}）— 「削除」を選ぶと消えます</div>
                        <div className="text-xs text-rose-900 flex flex-col gap-0.5">
                          {r.diff.removed.map(s => (
                            <span key={s.id}>・{s.title || '(名前なし)'}
                              <span className="text-rose-500 ml-1">
                                {[s.jigNo && `🔧${s.jigNo}`, s.programNo && `📐${s.programNo}`,
                                  (s.images || []).length && `🖼${s.images.length}枚`, s.pdfData && '📄PDF',
                                  (s.checklistItems || []).length && `☑${s.checklistItems.length}項目`].filter(Boolean).join(' ')}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* 黄: 中身がちがう。⚠必ず 共通の値 → 品目コードの値 を実値で出す */}
                    {c.changed > 0 && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                        <div className="text-xs font-black text-amber-800 mb-1.5 flex items-center gap-1"><Pencil className="w-3.5 h-3.5" />中身がちがう工程（{c.changed}）</div>
                        <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                          {r.diff.changed.map(ch => (
                            <div key={ch.dedId} className="text-xs">
                              <div className="font-bold text-slate-700">{ch.title}</div>
                              {ch.rows.map((row, i) => (
                                <div key={i} className="flex items-center gap-1.5 pl-3 text-slate-600 flex-wrap">
                                  <span className="w-28 shrink-0 text-slate-500">{row.label}</span>
                                  <span className="font-mono">共通 {row.baseShow}</span>
                                  <span className="text-slate-400">→</span>
                                  <span className={`font-mono font-bold ${row.group === 'model' ? 'text-rose-700' : 'text-slate-800'}`}>いま {row.dedShow}</span>
                                  {row.group === 'model' && fields[row.key] && <span className="fi-tap-text font-black text-rose-600">⚠この品目コードの値が消えます</span>}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* 灰: 判定不能 = 一切触らない */}
                    {c.ambiguous > 0 && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                        <div className="font-black text-slate-700 mb-1 flex items-center gap-1"><HelpCircle className="w-3.5 h-3.5" />どれと同じ工程か決められないもの（{c.ambiguous}）</div>
                        同じ名前の工程が複数あるため、<b>この工程には一切手を触れません</b>（間違った工程を上書きしないため）。
                        <div className="mt-1">{r.diff.ambiguous.map((a, i) => <span key={i} className="mr-2">・{a.title}（共通{a.baseCount}／専用{a.dedCount}）</span>)}</div>
                      </div>
                    )}

                    {/* 何を反映するか */}
                    <div className="rounded-xl border border-slate-200 p-3">
                      <div className="text-xs font-black text-slate-600 mb-2">何を反映しますか？</div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1.5">
                        {SYNC_FIELDS.map(f => (
                          <label key={f.key} className={`flex items-center gap-1.5 text-xs cursor-pointer ${f.group === 'model' ? 'text-rose-800' : 'text-slate-700'}`}>
                            <input type="checkbox" className="w-4 h-4 accent-indigo-600" checked={!!fields[f.key]}
                              onChange={e => setField(r.model, f.key, e.target.checked)} />
                            <span className={f.destructive ? 'font-bold text-rose-700' : ''}>{f.label}</span>
                            {f.group === 'model' && <span className="fi-tap-text font-black bg-rose-100 text-rose-700 border border-rose-200 rounded px-1">品目コードの値</span>}
                          </label>
                        ))}
                      </div>
                      <div className="fi-tap-text text-slate-400 mt-2">
                        <b className="text-rose-700">「品目コードの値」</b>の札が付いた項目は、この品目コードのために人が入れた情報です。ONにすると共通の値で上書きされます（既定はOFF）。
                      </div>
                    </div>

                    {/* ⚠この操作で消えるもの(名指し) */}
                    <div className={`rounded-xl border-2 p-3 ${losses.length ? 'border-rose-300 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
                      {losses.length === 0 ? (
                        <div className="text-xs font-black text-emerald-800 flex items-center gap-1"><ShieldCheck className="w-4 h-4" />いまの選び方だと、消えるものはありません。</div>
                      ) : (
                        <>
                          <div className="text-xs font-black text-rose-800 flex items-center gap-1 mb-1"><AlertTriangle className="w-4 h-4" />この操作で消えるもの: {losses.length}件</div>
                          <div className="text-xs text-rose-900 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                            {losses.map((l, i) => <span key={i}>・<b>{l.title}</b> — {l.detail}</span>)}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => apply(r)} disabled={busy === r.model}
                        className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-black text-sm">
                        {busy === r.model ? '反映しています…' : `「${r.model}」に反映する`}
                      </button>
                      <span className="fi-tap-text text-slate-500">反映前の状態は<b>1回だけ元に戻せます</b>（品目マスタの画面から）。</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 shrink-0 flex items-center gap-2">
          <span className="text-xs text-slate-500">閉じても何も変わりません。あとで品目マスタの画面からいつでも開けます。</span>
          <button onClick={onClose} className="ml-auto px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-black text-sm">閉じる（反映しない）</button>
        </div>
      </div>
    </div>
  );
};

export default TemplateSyncPanel;
