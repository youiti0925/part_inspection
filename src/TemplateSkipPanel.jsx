// 🧾 型式×テンプレ単位の 抜取／スキップ(製品検査)。清水さん(2026-09-06)
//   「項目毎じゃなくて 型式テンプレ毎で、その作業中に不具合の有無で判定」「SS系はいまスキップで流している」
//   「この機能がアプリ上に無いと負荷計算ができない」
// この画面が答える1つの問い: 「どの 型式×テンプレ を流してよいか。流すと月に何分減るか」
// 🚨 数字は domain/templateSkip.js(純関数)が実測から出す。ここで数えない。
// 🚨 情報は消さない: スキップと決めたロットも検査リストに『スキップ』の札で残る(削除しない)。
import React, { useMemo, useState } from 'react';
import { ShieldCheck, ListChecks, Activity, Lock } from 'lucide-react';
import { normalizeTemplateSkipCfg, templateSkipRows, templateSkipSummary, latestCompletedMs, JUDGE_REASON_TEXT } from './domain/templateSkip.js';

const fmtMin = (m) => (m == null ? '—' : m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}分`);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '—');
// 保存の口(押した時だけ動く)。⚠ 時計(Date.now)は描画の中で読まない(React の純度の決まり)ので module の階に置く。
const makeSaver = ({ canEdit, saveSettings, currentUserName }) => (next, action, target, detail) => {
  if (!canEdit || typeof saveSettings !== 'function') return;
  const entry = { t: Date.now(), by: currentUserName || '—', action, target, detail };
  saveSettings({ templateSkip: { ...next, history: [entry, ...(next.history || [])].slice(0, 200) } });
};

export default function TemplateSkipPanel({ lots = [], templates = [], settings = null, saveSettings = null, canEdit = false, currentUserName = '', onOpenOpsim = null, unitLabel = '型式' }) {
  const cfg = useMemo(() => normalizeTemplateSkipCfg(settings && settings.templateSkip), [settings]);
  const [q, setQ] = useState('');
  const [onlyReady, setOnlyReady] = useState(false);
  // 「今」は時計ではなく 直近の完了ロットの時刻(同じ入力なら同じ答え・描画の中で時計を読まない)
  const nowMs = useMemo(() => latestCompletedMs(lots), [lots]);
  const rows = useMemo(() => templateSkipRows({ lots, cfg, nowMs, months: 3 }), [lots, cfg, nowMs]);
  const sum = useMemo(() => templateSkipSummary(rows), [rows]);
  const tplName = (id) => (id === 'demo' ? '詳細デモ手順' : (templates.find((t) => t.id === id)?.name || (id ? `(${id})` : '（テンプレなし）')));
  const shown = rows.filter((r) => (!q || `${r.model} ${tplName(r.templateId)}`.toLowerCase().includes(q.toLowerCase())) && (!onlyReady || r.streak >= r.cond.qualifyLots));

  const saveWith = makeSaver({ canEdit, saveSettings, currentUserName });
  const save = (next, entry) => saveWith(next, entry.action, entry.target, entry.detail);
  const hist = (action, target, detail) => ({ action, target, detail });
  const setPolicy = (key, pol) => {
    const allow = { ...cfg.allow }; const never = { ...cfg.never };
    delete allow[key]; delete never[key];
    if (pol === 'allow') allow[key] = true;
    if (pol === 'never') never[key] = true;
    save({ ...cfg, allow, never }, hist('許可の変更', key, pol === 'allow' ? '許可' : pol === 'never' ? '絶対に減らさない' : '必ず全数'));
  };
  const policyOf = (r) => (r.never ? 'never' : r.allowed ? 'allow' : 'full');
  const toggleEnabled = () => save({ ...cfg, enabled: !cfg.enabled }, hist('稼働切替', '', !cfg.enabled ? 'ON' : 'OFF'));
  const setDefault = (patch) => save({ ...cfg, default: { ...cfg.default, ...patch } }, hist('条件の変更', '', JSON.stringify(patch)));

  const total = Math.max(1, sum.combos);
  return (
    <div className="space-y-3" data-template-skip-panel="1">
      {/* ① 状態と決めごと(1段) */}
      <div className={`rounded-xl border-2 bg-white overflow-hidden ${cfg.enabled ? 'border-emerald-400' : 'border-slate-300'}`} data-template-skip-top="1">
        <div className="p-3 flex flex-wrap items-center gap-3">
          <ShieldCheck className={`w-6 h-6 shrink-0 ${cfg.enabled ? 'text-emerald-600' : 'text-slate-400'}`} />
          <div className="min-w-0">
            <div className="font-black text-slate-800 text-sm flex flex-wrap items-center gap-1.5">抜取／スキップ（{unitLabel}×テンプレ）
              <span className={`rounded-full px-2 py-0.5 text-xs ${cfg.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{cfg.enabled ? '稼働中（ON）' : '停止中（OFF）'}</span>
            </div>
            <div className="text-[11px] text-slate-500">{cfg.enabled ? '新しいロットを登録した時に、許可した{unitLabel}×テンプレで条件がそろっていれば「スキップ」で流します' : 'OFF = 今までどおり全数。候補と見込みの確認だけ'}</div>
          </div>
          <button type="button" disabled={!canEdit} onClick={toggleEnabled} data-template-skip-toggle={cfg.enabled ? '1' : '0'} className={`min-h-[40px] px-4 rounded-lg font-bold text-sm shadow-sm text-white disabled:opacity-40 ${cfg.enabled ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{cfg.enabled ? 'OFFにする' : 'ONにする'}</button>
          <div className="ml-auto min-w-[16rem] flex-1 max-w-lg" data-template-skip-bar={`${sum.allowed}/${sum.never}/${sum.combos - sum.allowed - sum.never}`}>
            <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-slate-200" title={`許可 ${sum.allowed}／絶対に減らさない ${sum.never}／未決定 ${sum.combos - sum.allowed - sum.never}`}>
              {sum.allowed > 0 ? <div className="bg-emerald-500 h-full" style={{ width: `${(sum.allowed / total) * 100}%` }} /> : null}
              {sum.never > 0 ? <div className="bg-rose-500 h-full" style={{ width: `${(sum.never / total) * 100}%` }} /> : null}
              {(sum.combos - sum.allowed - sum.never) > 0 ? <div className="bg-slate-400 h-full" style={{ width: `${((sum.combos - sum.allowed - sum.never) / total) * 100}%` }} /> : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] font-bold">
              <span className="text-emerald-700">■ 許可 <b className="text-[13px]">{sum.allowed}</b></span>
              <span className="text-rose-700">■ 🔒 絶対に減らさない <b className="text-[13px]">{sum.never}</b></span>
              <span className="text-slate-600">■ 未決定（＝全数） <b className="text-[13px]">{sum.combos - sum.allowed - sum.never}</b></span>
              <span className="text-slate-400 font-normal">全 {sum.combos} 組</span>
            </div>
          </div>
        </div>
        <div className="px-3 pb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
          <label className="flex items-center gap-1 font-bold text-slate-700">連続無欠点ロット数
            <input type="number" min={1} max={50} value={cfg.default.qualifyLots} disabled={!canEdit} onChange={(e) => setDefault({ qualifyLots: Math.max(1, Number(e.target.value) || 1) })} data-template-skip-qualify="1" className="w-16 border rounded px-1.5 py-1 text-right" />
          </label>
          <label className="flex items-center gap-1 font-bold text-slate-700">全数に戻す間隔
            <input type="number" min={2} max={20} value={cfg.default.lotSkipEvery} disabled={!canEdit} onChange={(e) => setDefault({ lotSkipEvery: Math.max(2, Number(e.target.value) || 2) })} data-template-skip-every="1" className="w-14 border rounded px-1.5 py-1 text-right" />
            <span className="font-normal text-slate-500">ロットに1回は全数</span>
          </label>
          <span className="text-amber-800">⚠ 欠点（NG）が出たロットで連続は切れ、次から全数に戻ります。スキップと決めたロットは消さず、検査リストに『スキップ』の札で残ります（押して完了にするだけ）。</span>
        </div>
      </div>

      {/* ② 見込み(主役) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-template-skip-summary="1">
        <div className="bg-white rounded-xl border-2 border-emerald-300 p-3">
          <div className="text-xs font-black text-slate-600">いまの許可で 減る見込み（月）</div>
          <div className="text-3xl font-black text-emerald-700" data-template-skip-min-allowed={Math.round(sum.minPerMonthAllowed)}>{fmtMin(sum.minPerMonthAllowed)}</div>
          <div className="text-[11px] text-slate-500">許可済みで条件がそろっている組の合計</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs font-black text-slate-600">条件がそろっている組を全部許可したら（月）</div>
          <div className="text-3xl font-black text-slate-800">{fmtMin(sum.minPerMonthIfAll)}</div>
          <div className="text-[11px] text-slate-500">上限（絶対に減らさない以外を全部流したら） {fmtMin(sum.minPerMonthCeiling)}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-col gap-1.5">
          <div className="text-xs font-black text-slate-600">数え方</div>
          <div className="text-[11px] text-slate-600 leading-relaxed">直近3か月の完了ロットの実測から「1ロットの平均分 × 月のロット数 × (N−1)/N」。目標時間では計算しません。予想であって約束ではありません。</div>
          {typeof onOpenOpsim === 'function' ? (
            <button type="button" onClick={onOpenOpsim} data-template-skip-open-opsim="1" className="self-start rounded-md border border-cyan-300 bg-cyan-50 px-2 py-1 text-[11px] font-black text-cyan-800 hover:bg-cyan-100" title="スキップで流したロットは残り工程0として割付に効きます">
              <Activity className="inline w-3.5 h-3.5 mr-1" />操業シミュレーションで見る ▸
            </button>
          ) : null}
        </div>
      </div>

      {/* ③ 組ごとの一覧(決める所) */}
      <div className="bg-white rounded-xl border border-slate-200 p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <ListChecks className="w-4 h-4 text-indigo-600" />
          <span className="text-sm font-black text-slate-800">{unitLabel}×テンプレごとの実績と決めごと</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${unitLabel}・テンプレで絞る（例: SS）`} data-template-skip-search="1" className="border rounded px-2 py-1 text-xs w-56" />
          <label className="text-xs font-bold text-slate-600 flex items-center gap-1"><input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} className="w-4 h-4" />条件がそろった組だけ</label>
          <span className="ml-auto text-[11px] text-slate-400">{shown.length} 組</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse min-w-[56rem]" data-template-skip-table="1">
            <thead><tr className="text-slate-500 border-b border-slate-200 text-left">
              <th className="py-1 pr-2">{unitLabel}</th><th className="py-1 pr-2">テンプレ</th><th className="py-1 pr-2 text-right">検査した完了</th>
              <th className="py-1 pr-2">連続無欠点</th><th className="py-1 pr-2">直近NG</th><th className="py-1 pr-2 text-right">1ロット平均</th>
              <th className="py-1 pr-2 text-right">月ロット</th><th className="py-1 pr-2 text-right">月の見込み</th><th className="py-1 pr-2">いま新規が来たら</th><th className="py-1">決めごと</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const pol = policyOf(r);
                const pct = Math.min(100, (r.streak / Math.max(1, r.cond.qualifyLots)) * 100);
                const ok = r.streak >= r.cond.qualifyLots;
                return (
                  <tr key={r.key} data-template-skip-row={r.key} data-template-skip-judge={r.judge.reason} className="border-b border-slate-100 align-middle">
                    <td className="py-1.5 pr-2 font-black text-slate-800 whitespace-nowrap">{r.model || `（${unitLabel}なし）`}</td>
                    <td className="py-1.5 pr-2 text-indigo-800 whitespace-nowrap max-w-[14rem] truncate" title={tplName(r.templateId)}>{tplName(r.templateId)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{r.inspected}</td>
                    <td className="py-1.5 pr-2 min-w-[8rem]">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-20 rounded bg-slate-200 overflow-hidden"><div className={`h-full ${ok ? 'bg-emerald-500' : 'bg-amber-400'}`} style={{ width: `${pct}%` }} /></div>
                        <span className={`font-mono font-black ${ok ? 'text-emerald-700' : 'text-slate-700'}`}>{r.streak}/{r.cond.qualifyLots}</span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 text-rose-700">{fmtDate(r.lastNgAt)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtMin(r.avgMinPerLot)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{r.lotsPerMonth == null ? '—' : r.lotsPerMonth.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono font-black text-emerald-800">{fmtMin(r.minPerMonth)}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`rounded px-1.5 py-0.5 font-bold ${r.judge.skip ? 'bg-emerald-100 text-emerald-800' : r.judge.reason === 'every-nth' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'}`}>{JUDGE_REASON_TEXT[r.judge.reason]}</span>
                    </td>
                    <td className="py-1.5">
                      <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                        {[['full', '必ず全数'], ['allow', '許可'], ['never', '🔒']].map(([k, label]) => (
                          <button key={k} type="button" disabled={!canEdit} onClick={() => setPolicy(r.key, k)} data-template-skip-policy={`${r.key}:${k}`}
                            className={`px-2 py-1 text-[11px] font-bold whitespace-nowrap disabled:opacity-40 ${pol === k ? (k === 'allow' ? 'bg-emerald-600 text-white' : k === 'never' ? 'bg-rose-600 text-white' : 'bg-slate-700 text-white') : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                            title={k === 'never' ? '絶対に減らさない（クレーム対象など）' : k === 'allow' ? '条件がそろったら スキップで流す' : '今までどおり全数'}>{label}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 ? <tr><td colSpan={10} className="py-6 text-center text-slate-400">該当する組がありません（完了ロットが無い{unitLabel}×テンプレは出ません）</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-[10px] text-slate-500 flex items-center gap-1"><Lock className="w-3 h-3" />変更は操作者と日時つきで設定の履歴に残ります（最新200件）。判定はロット登録の瞬間に行い、根拠（連続数・条件）をロットに保存します。</div>
      </div>
    </div>
  );
}
