// 🎯 P166 年間目標タブ(製品 App.jsx:31479 GoalLayerView と 1846-2279 の目標の計算を写した・部品は読むだけ)。
//
// 既定: 部品の画面は **読むだけ**。書く物(目標の設定・週次ブリーフの作成・カルテ化・却下)は製品だけに残す
//   (remaining P166 の決まり)。ここから goal-shared-v1 へは1文字も書かない。
// 既定: 製品・最終のロットを直には読まない(読み取り数が増えるため・本番で 429 が出た事がある)。
//   3アプリ合算の数字は、製品が週1回作る共有の「今週のブリーフ」(goal-shared-v1/weekly_briefs)の
//   goal.byApp をそのまま出す(同じ数字を2つの計算から出さない)。
//   部品の中身(原資・共通ポイント・10%の測り方)は、このアプリのロットから製品と同じ式で出す。
// App.jsx の中にある計算(profitRanking・measureWindow など)は kit で受け取る(同じ関数を2つ持たない)。
import React, { useState, useEffect, useMemo } from 'react';
import { goalGapOf, candidateOf, planPortfolio } from '../domain/goal/portfolioPlanner.js';
import { GOAL_PRIMARY_METRICS } from '../domain/goal/fiscalMath.js';
import { autoLaborPctLabel } from '../domain/taskTimeQuality.js';

const GOAL_SHARED_NS = 'goal-shared-v1';
const GOAL_DEFAULT_YEAR = { reductionPct: 10, moneyTargetYen: 1000000, chargePerHour: 2800 };
// 年度: 既定は12月開始〜11月終わり。年度キーは「終わる年」(製品と同じ)。
const fiscalYearOf = (nowMs, startMonth = 12) => {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const sm = Math.min(12, Math.max(1, Number(startMonth) || 12));
  const startYear = (m >= sm) ? y : y - 1;
  const startMs = new Date(startYear, sm - 1, 1).getTime();
  const endMs = new Date(startYear + 1, sm - 1, 1).getTime() - 1;
  const key = String(sm === 1 ? startYear : startYear + 1);
  const endMonth = sm === 1 ? 12 : sm - 1;
  return { key, startMs, endMs, label: `${key}年度（${startYear}/${sm}〜${sm === 1 ? startYear : startYear + 1}/${endMonth}）` };
};
// 週のキー = その週の月曜の日付(製品 goalWeekKey と同じ)
const goalWeekKey = (nowMs) => {
  const d = new Date(nowMs);
  const dow = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
};
const GOAL_ENGINE_DEFAULTS = {
  stallDays: 10, mineMinYen: 20000, mineCount: 3, breakTolPct: 5, trendPct: 15,
  commonMinModels: 3, commonPct: 10, autoLaborPct: 100, successRatePct: 70, maxActive: 3,
  briefEnabled: true, pushEnabled: true,
};
const goalEngineOf = (goalCfg) => ({ ...GOAL_ENGINE_DEFAULTS, ...((goalCfg && goalCfg.engine) || {}) });

// 以下は kit(App.jsx の計算)を受けて作る(製品 dataStartMsOf・goalMeasureWindow・goalAppSummary・goalPerUnitLens と同じ式)。
const makeGoalCalc = ({ toMsAny, isStatTask, profitRanking, measureWindow, modelGroupsOf, enumerateModelTplSteps }) => {
  const dataStartMsOf = (lots) => {
    let min = Infinity;
    (lots || []).forEach(l => {
      const lotMs = toMsAny(l.completedAt) || toMsAny(l.updatedAt);
      Object.values(l.tasks || {}).forEach(t => {
        if (!t || (t.status !== 'completed' && t.status !== 'ng')) return;
        if (!isStatTask(t)) return;
        if ((t.duration || 0) <= 0) return;
        const ms = toMsAny(t.endTime) || lotMs;
        if (ms != null && ms > 0 && ms < min) min = ms;
      });
    });
    return isFinite(min) ? min : null;
  };
  const goalMeasureWindow = (lots, nowMs) => {
    const dataStartMs = dataStartMsOf(lots);
    const start90 = nowMs - 90 * 86400000;
    const startMs = dataStartMs != null ? Math.max(dataStartMs, start90) : start90;
    return { startMs, endMs: nowMs, days: Math.max(7, (nowMs - startMs) / 86400000), dataStartMs };
  };
  const goalAppSummary = (lots, settings, { nowMs, chargePerHour, annualUnitsByModel = null, templates = null, autoLaborPct = 100 }) => {
    const win = goalMeasureWindow(lots, nowMs);
    const ranking = profitRanking(lots, settings, { startMs: win.startMs, endMs: win.endMs, ratePerHour: chargePerHour, lowFreq: 0, annualUnitsByModel, byTemplate: true, templates, autoLaborPct });
    const excessRatio = ranking.totalCostSec > 0 ? ranking.totalSaveSec / ranking.totalCostSec : 0;
    return { win, ranking, excessRatio };
  };
  const goalPerUnitLens = (lots, settings, { fiscalStartMs, nowMs }) => {
    const ds = dataStartMsOf(lots);
    const baseStart = Math.max(fiscalStartMs, ds ?? fiscalStartMs);
    const baseEnd = baseStart + 28 * 86400000;
    const curStart = nowMs - 28 * 86400000;
    if (curStart <= baseEnd) return { ok: false, reason: 'データがまだ8週未満（基準4週と直近4週が分離できるまでお待ちください）' };
    const ctt = settings?.customTargetTimes || {};
    const groups = modelGroupsOf(settings);
    let wSum = 0, wBase = 0, rows = 0;
    enumerateModelTplSteps(lots).forEach(msr => {
      const b = measureWindow(lots, { model: msr.model, stepKey: msr.stepKey, templateId: msr.templateId || undefined, customTargetTimes: ctt, modelGroups: groups, startMs: baseStart, endMs: baseEnd });
      const c = measureWindow(lots, { model: msr.model, stepKey: msr.stepKey, templateId: msr.templateId || undefined, customTargetTimes: ctt, modelGroups: groups, startMs: curStart, endMs: nowMs });
      if (b.n < 3 || c.n < 3) return;
      rows++;
      wBase += b.median * c.n;
      wSum += c.median * c.n;
    });
    if (!rows || wBase <= 0) return { ok: false, reason: '基準期間と直近の両方に3台以上ある工程がまだ無い' };
    return { ok: true, pct: Math.round((1 - wSum / wBase) * 1000) / 10, rows, baseStart, baseEnd, curStart };
  };
  return { dataStartMsOf, goalMeasureWindow, goalAppSummary, goalPerUnitLens };
};

const TYPE_LABEL = { pick: '今週の最優先', stall: '催促', break: '崩れ', common: '共通ポイント', mine: '原資', trend: '悪化の兆し' };

export const GoalLayerView = ({ lots = [], settings = {}, db = null, DATA = null, templates = [], kit }) => {
  const { pdcaFmtSec, measureWindow, modelGroupsOf, crossStepRanking, loadExcelJS } = kit;
  const calc = useMemo(() => makeGoalCalc(kit), [kit]);
  const [nowMs] = useState(() => Date.now());
  const yen = (n) => `¥${Math.round(n || 0).toLocaleString()}`;
  const man = (n) => `${((n || 0) / 10000).toFixed((n || 0) >= 1000000 ? 0 : 1)}万`;
  const hrs0 = (sec) => `${Math.round((sec || 0) / 3600).toLocaleString()}h`;
  const dstr = (ms) => ms ? new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '—';

  const [goalCfg, setGoalCfg] = useState(null);
  const [brief, setBrief] = useState(null);
  const weekKey = goalWeekKey(nowMs);
  useEffect(() => {
    if (!db || !DATA) return undefined;
    return DATA(db).watchDoc(GOAL_SHARED_NS, 'settings', 'config', (data) => setGoalCfg(data || {}), { onError: () => setGoalCfg({}) });
  }, [db, DATA]);
  useEffect(() => {
    if (!db || !DATA) return undefined;
    return DATA(db).watchDoc(GOAL_SHARED_NS, 'weekly_briefs', weekKey, (data) => setBrief(data), { onError: (e) => console.warn('[購読] 今週のブリーフを読めませんでした', e) });
  }, [db, DATA, weekKey]);

  const fiscalStartMonth = Number(goalCfg?.fiscalStartMonth) || 12;
  const fy = fiscalYearOf(nowMs, fiscalStartMonth);
  const yearCfg = useMemo(() => ({
    ...GOAL_DEFAULT_YEAR,
    chargePerHour: Number(settings?.laborCostPerHour) || GOAL_DEFAULT_YEAR.chargePerHour,
    ...((goalCfg?.years || {})[fy.key] || {}),
  }), [goalCfg, fy.key, settings?.laborCostPerHour]);
  const charge = Number(yearCfg.chargePerHour) || GOAL_DEFAULT_YEAR.chargePerHour;
  const moneyTarget = Number(yearCfg.moneyTargetYen) || 0;
  const reductionPct = Number(yearCfg.reductionPct) || 10;
  const engine = useMemo(() => goalEngineOf(goalCfg), [goalCfg]);
  const annualUnitsByModel = useMemo(() => (settings?.annualProduction && settings.annualProduction[fy.key]) || {}, [settings, fy.key]);
  const annualInputCount = Object.values(annualUnitsByModel).filter(v => Number(v) > 0).length;
  const primaryMetric = ['annualized', 'fiscalForecast', 'fiscalRealized'].includes(goalCfg?.primaryMetric) ? goalCfg.primaryMetric : 'annualized';

  // 部品の中身(製品が週次ブリーフで数える sumParts と同じ式・同じ窓)
  const sumParts = useMemo(() => calc.goalAppSummary(lots, settings, { nowMs, chargePerHour: charge, annualUnitsByModel, templates, autoLaborPct: engine.autoLaborPct }), [calc, lots, settings, nowMs, charge, annualUnitsByModel, templates, engine.autoLaborPct]);
  const commonTop = useMemo(() => {
    try {
      const cr = crossStepRanking(lots, settings, { startMs: sumParts.win.startMs, endMs: nowMs, ratePerHour: charge, reductionPct: (engine.commonPct || 10) / 100, annualUnitsByModel, byTemplate: true, templates, autoLaborPct: engine.autoLaborPct });
      return (cr.groups || []).filter(g => g.modelCount >= (engine.commonMinModels || 3) && g.annualCostSec > 0).slice(0, 3);
    } catch { return []; }
  }, [crossStepRanking, lots, settings, sumParts, nowMs, charge, annualUnitsByModel, templates, engine]);
  // 部品だけで見た逆算(3アプリ合算の逆算は下のブリーフの gap)
  const partsPortfolio = useMemo(() => {
    const gap = goalGapOf({ moneyTargetYen: 0, chargePerHour: charge, baselineAnnualLaborSec: sumParts.ranking.totalCostSec || 0, reductionPct, verifiedFixedYen: 0 });
    const cands = sumParts.ranking.rows.map(r => candidateOf(r, { appId: 'parts' }));
    return { gap, pf: planPortfolio({ candidates: cands, remainingHours: gap.remainingHours, successRatePct: engine.successRatePct, openKeys: new Set() }) };
  }, [sumParts, charge, reductionPct, engine.successRatePct]);
  const fiscalAggParts = useMemo(() => measureWindow(lots, { customTargetTimes: settings?.customTargetTimes || {}, modelGroups: modelGroupsOf(settings), startMs: fy.startMs, endMs: nowMs }), [measureWindow, modelGroupsOf, lots, settings, fy.startMs, nowMs]);
  const lens2 = useMemo(() => calc.goalPerUnitLens(lots, settings, { fiscalStartMs: fy.startMs, nowMs }), [calc, lots, settings, fy.startMs, nowMs]);
  const dataStart = sumParts.win.dataStartMs;
  const lens1Available = dataStart != null && dataStart < fy.startMs;
  const lens3 = useMemo(() => {
    const sumAct = fiscalAggParts?.sumAct || 0;
    const sumTgt = fiscalAggParts?.sumTgt || 0;
    if (sumAct <= 0 || sumTgt <= 0) return { ok: false, reason: '年度内の実績または目標がまだ無い' };
    return { ok: true, achievement: Math.round(sumTgt / sumAct * 1000) / 10, excessPct: Math.round((sumAct / sumTgt - 1) * 1000) / 10 };
  }, [fiscalAggParts]);

  const elapsedPct = Math.max(0, Math.min(100, Math.round((nowMs - fy.startMs) / (fy.endMs - fy.startMs) * 100)));
  const g = brief && brief.goal ? brief.goal : null;
  const seg = (v) => moneyTarget > 0 ? Math.max(0, Math.min(100, (v || 0) / moneyTarget * 100)) : 0;
  const partsRows = sumParts.ranking.rows || [];

  const goalExcel = async () => {
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      const s1 = wb.addWorksheet('目標と貯金箱');
      s1.addRows([
        ['年度', fy.label], ['改善金額目標(円)', moneyTarget], ['時間削減目標(%)', reductionPct], ['チャージ(円per時)', charge], ['年度経過(%)', elapsedPct], [],
        ['確定(円・今週のブリーフ)', g ? g.fixedYen : ''], ['暫定(円)', g ? g.provisionalYen : ''], ['実施中見込み(円)', g ? g.runningYen : ''], ['候補在庫(円)', g ? g.stockYen : ''],
        ['  うち部品(円・この端末で計算)', sumParts.ranking.totalSaveYen || 0], ['目標まで残り(円)', g ? g.remainYen : ''],
      ]);
      s1.getColumn(1).width = 30; s1.getColumn(2).width = 30;
      const s2 = wb.addWorksheet('今週のブリーフ');
      s2.addRow(['種類', 'タイトル', '内容', '減らし方のヒント', '金額(円per年)', '判断']);
      Object.entries(brief?.findings || {}).forEach(([fid, f]) => {
        const dec = (brief?.decisions || {})[fid];
        s2.addRow([TYPE_LABEL[f.type] || f.type, f.title, f.detail, f.hint || '', f.yen || 0, dec ? (dec.action === 'carded' ? 'カルテ化済' : '却下') : '']);
      });
      const s3 = wb.addWorksheet('部品の原資(明細)');
      s3.addRow(['品目コード', 'テンプレート', '工程', '標本数', '実績中央値', '目標', '年間台数', '台数の出どころ', '年間削減見込(円)', '年間人件費(円)']);
      partsRows.slice(0, 100).forEach(r => s3.addRow([r.model, r.templateName || '', r.stepTitle, r.n, pdcaFmtSec(r.median), pdcaFmtSec(r.target), r.annualUnits, r.annualUnitsSource === 'actual' ? '登録値' : '実測ペース推定', r.annualSaveYen, r.annualCostYen]));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `年間目標_部品_${fy.key}年度_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
    } catch (e) { alert('Excel出力に失敗しました: ' + (e?.message || e)); }
  };

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1100px] mx-auto">
      <div className="bg-gradient-to-r from-rose-50 to-amber-50 border border-rose-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px]">
          <div className="text-xs text-slate-500 font-bold">{fy.label}・グループ目標（3アプリ合算）</div>
          <div className="text-2xl font-black text-slate-800 mt-0.5">改善金額 {man(moneyTarget)}円 ・ 時間 {reductionPct}%削減</div>
          <div className="text-xs text-slate-500 mt-1">チャージ {charge.toLocaleString()}円/h・年度は{fiscalStartMonth}月はじまり。<b>部品検査では見るだけ</b>（目標の設定・週次ブリーフの作成・カルテ化は製品検査の 分析 → 🎯年間目標）。</div>
        </div>
        <button onClick={goalExcel} className="min-h-10 px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm font-bold text-emerald-700 hover:bg-emerald-50">📗 Excel</button>
      </div>

      {/* 🏦 3アプリ合算の貯金箱(製品が作った今週のブリーフの数字をそのまま) */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div className="text-sm font-bold text-slate-700">🏦 改善金額の貯金箱 — 目標 {man(moneyTarget)}円 に対して</div>
          <div className="text-xs text-slate-400">年度経過 {elapsedPct}%{brief?.createdAt ? `・${new Date(brief.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 作成のブリーフより` : ''}</div>
        </div>
        {!g ? (
          <div className="mt-2 text-xs text-slate-500">今週のブリーフがまだありません（製品検査で週の最初に自動で作られます）。3アプリ合算の数字はそれが出来てから出ます。</div>
        ) : (
          <>
            <div className="mt-3 relative h-9 bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
              <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${seg(g.fixedYen)}%` }} title={`確定 ${yen(g.fixedYen)}`}></div>
              <div className="absolute inset-y-0 bg-teal-400/80" style={{ left: `${seg(g.fixedYen)}%`, width: `${seg(g.provisionalYen)}%` }} title={`暫定 ${yen(g.provisionalYen)}`}></div>
              <div className="absolute inset-y-0 bg-sky-400/80" style={{ left: `${seg((g.fixedYen || 0) + (g.provisionalYen || 0))}%`, width: `${seg(g.runningYen)}%` }} title={`実施中見込み ${yen(g.runningYen)}`}></div>
              <div className="absolute inset-y-0 bg-amber-300/70" style={{ left: `${seg((g.fixedYen || 0) + (g.provisionalYen || 0) + (g.runningYen || 0))}%`, width: `${seg(g.stockYen)}%` }} title={`候補在庫 ${yen(g.stockYen)}`}></div>
              <div className="absolute inset-y-0 border-l-2 border-dashed border-slate-500" style={{ left: `${elapsedPct}%` }} title={`年度経過 ${elapsedPct}%`}></div>
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3"><div className="text-xs text-emerald-700 font-bold">✅ 確定（30日定着済）</div><div className="text-xl font-black text-emerald-700">{yen(g.fixedYen)}</div></div>
              <div className="bg-teal-50 border border-teal-200 rounded-lg p-3"><div className="text-xs text-teal-700 font-bold">⏳ 暫定</div><div className="text-xl font-black text-teal-700">{yen(g.provisionalYen)}</div></div>
              <div className="bg-sky-50 border border-sky-200 rounded-lg p-3"><div className="text-xs text-sky-700 font-bold">🔧 実施中の見込み</div><div className="text-xl font-black text-sky-700">{yen(g.runningYen)}</div></div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3"><div className="text-xs text-amber-700 font-bold">⛏ 候補在庫</div><div className="text-xl font-black text-amber-700">{yen(g.stockYen)}</div>
                <div className="text-xs text-slate-500 mt-0.5">製品 {yen(g.byApp?.product?.stockYen)} ＋ 最終 {yen(g.byApp?.golden?.stockYen)} ＋ 部品 {yen(g.byApp?.parts?.stockYen)}</div></div>
            </div>
            <div className="mt-2 text-sm font-bold text-slate-700">目標まであと <span className="text-rose-600 text-lg">{yen(g.remainYen)}</span>（{GOAL_PRIMARY_METRICS[primaryMetric] || '年間換算'}・確定ベース）</div>
            {brief.gap && (
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="bg-slate-50 rounded-lg p-2"><div className="text-slate-500">必要削減</div><div className="text-lg font-black text-slate-800">{(brief.gap.requiredHours || 0).toLocaleString()}h/年</div></div>
                <div className="bg-emerald-50 rounded-lg p-2"><div className="text-slate-500">確定済み</div><div className="text-lg font-black text-emerald-700">{brief.gap.fixedHours || 0}h</div></div>
                <div className="bg-rose-50 rounded-lg p-2"><div className="text-slate-500">残り → 必要計画在庫</div><div className="text-lg font-black text-rose-700">{brief.gap.remainingHours || 0}h → {brief.gap.pipelineRequiredHours || 0}h</div></div>
                <div className={`rounded-lg p-2 ${brief.gap.sufficient ? 'bg-emerald-50' : 'bg-amber-50 border border-amber-300'}`}><div className="text-slate-500">使える候補在庫</div><div className="text-lg font-black">{brief.gap.usableHours || 0}h</div><div className="text-xs text-slate-500">{brief.gap.sufficient ? '✅ 届く見込み' : `⚠ 不足 約${brief.gap.shortfallHours || 0}h`}</div></div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 📬 今週のブリーフ(読むだけ) */}
      <div className="bg-white border-2 border-indigo-200 rounded-xl p-4">
        <div className="text-sm font-bold text-indigo-800">📬 今週のブリーフ <span className="text-xs font-normal text-slate-400">製品検査が作る・カルテ化と却下は製品検査で</span></div>
        {!brief || !brief.goal ? (
          <div className="mt-2 text-xs text-slate-500">今週分はまだありません。</div>
        ) : (
          <div className="mt-2 space-y-2">
            {Object.keys(brief.findings || {}).length === 0 && <div className="text-xs text-emerald-600">今週の指摘はありません ✅</div>}
            {['pick', 'stall', 'break', 'common', 'mine', 'trend'].map(tp =>
              Object.entries(brief.findings || {}).filter(([, f]) => f.type === tp).sort((a, b) => (b[1].yen || 0) - (a[1].yen || 0)).map(([fid, f]) => {
                const dec = (brief.decisions || {})[fid];
                const tone = { pick: 'bg-yellow-50 border-yellow-400 border-2', stall: 'bg-rose-50 border-rose-200', break: 'bg-amber-50 border-amber-200', common: 'bg-violet-50 border-violet-200', mine: 'bg-emerald-50 border-emerald-200', trend: 'bg-sky-50 border-sky-200' }[tp];
                return (
                  <div key={fid} className={`rounded-lg p-2.5 border ${tone} ${dec?.action === 'dismissed' ? 'opacity-50' : ''}`}>
                    <div className="text-sm font-bold text-slate-800">{f.title}{dec && <span className="ml-2 text-xs font-bold text-slate-500">{dec.action === 'carded' ? '📋 カルテ化済' : '❌ 却下'}（{dec.by}）</span>}</div>
                    <div className="text-xs text-slate-600 mt-0.5 leading-relaxed">{f.detail}</div>
                    {f.hint && <div className="text-xs text-indigo-800 bg-indigo-50/80 rounded px-2 py-1 mt-1.5 leading-relaxed">{f.hint}</div>}
                  </div>
                );
              })
            )}
            {(brief.notices || []).map((n, i) => <div key={i} className="text-xs text-slate-400">※ {n}</div>)}
          </div>
        )}
      </div>

      {/* ⛏ 部品の原資(このアプリのロットから・製品と同じ式) */}
      <div className="bg-white border border-amber-200 rounded-xl p-4">
        <div className="text-sm font-bold text-amber-800">⛏ 部品検査の原資 — 年 約{yen(sumParts.ranking.totalSaveYen)}（直近{Math.round(sumParts.win.days)}日の実ペース×365日）</div>
        <div className="text-xs text-slate-500 mt-0.5 mb-2">実績中央値と目標の差 × 年間台数 × チャージ。全部は取り切れない前提の理論上限です。部品だけで{reductionPct}%削るなら 年 約{Math.round(partsPortfolio.gap.timeRequiredHours || 0)}h。</div>
        {partsRows.length === 0 ? <div className="text-xs text-slate-400">まだ数えられる記録がありません。</div> : (
          <div className="space-y-1">
            {partsRows.slice(0, 10).map(r => (
              <div key={`${r.model}||${r.templateId || ''}||${r.stepKey}`} className="flex items-center gap-2 text-xs bg-slate-50 rounded px-2 py-1">
                <span className="truncate flex-1">{r.model}{r.templateName ? `〔${r.templateName}〕` : ''} {r.stepTitle}</span>
                <span className="text-slate-500 shrink-0">今 {pdcaFmtSec(r.median)} / 目標 {pdcaFmtSec(r.target)} × 年{r.annualUnits}台</span>
                <span className="font-bold text-slate-700 shrink-0">{yen(r.annualSaveYen)}</span>
              </div>
            ))}
            {partsRows.length > 10 && <div className="text-xs text-slate-400">…ほか{partsRows.length - 10}件（📗Excelに全件）</div>}
          </div>
        )}
      </div>

      {commonTop.length > 0 && (
        <div className="bg-white border border-violet-200 rounded-xl p-4">
          <div className="text-sm font-bold text-violet-800">🔗 全部に効く共通ポイント（部品）</div>
          <div className="space-y-2 mt-2">
            {commonTop.map((cg, i) => (
              <div key={cg.title} className="bg-violet-50/60 rounded-lg p-2.5">
                <div className="text-sm font-bold text-slate-800">{i + 1}. {cg.title} <span className="text-xs font-normal text-slate-500">（{cg.modelCount}品目に共通）</span></div>
                <div className="text-xs text-slate-600">年 約{Math.round(cg.annualCostSec / 3600)}時間 ＝ {yen(cg.annualCostYen)}・{engine.commonPct || 10}%削ると 年 約{yen(cg.saveByPctYen)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-sm font-bold text-slate-700 mb-2">⏱ 時間{reductionPct}%削減 — 3つの測り方（部品）</div>
        <div className="space-y-2 text-xs">
          <div className="bg-slate-50 rounded-lg p-2.5"><b>① 前年比</b> {lens1Available ? '前年データあり（計算は製品と同じく次段）' : <span>まだ使えません — 時間データは <b>{dstr(dataStart)}</b> 開始のため前年度の実績がありません。</span>}</div>
          <div className="bg-slate-50 rounded-lg p-2.5"><b>② 台あたり</b> {lens2.ok ? <span className={lens2.pct >= reductionPct ? 'text-emerald-700 font-bold' : ''}>年度はじめ4週と直近4週で {lens2.pct > 0 ? '−' : '+'}{Math.abs(lens2.pct)}%（対象{lens2.rows}工程）</span> : lens2.reason}</div>
          <div className="bg-slate-50 rounded-lg p-2.5"><b>③ 目標比</b> {lens3.ok ? <span>達成率 <b>{lens3.achievement}%</b>{lens3.excessPct > 0 ? `（実績が目標より ${lens3.excessPct}% 多い）` : '（目標内 ✅）'}</span> : lens3.reason}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 text-xs text-slate-600 space-y-1">
        <div className="text-sm font-bold text-slate-700">🩺 数字の信頼度</div>
        <div>📅 部品の時間データの開始: <b>{dstr(dataStart)}</b>。年度内の記録時間 {hrs0(fiscalAggParts?.sumAct || 0)}。</div>
        <div>{annualInputCount === 0 ? '⚠ 年間生産台数が未登録（0品目）。今は測定ペースからの推定です。' : `✅ 年間生産台数 ${annualInputCount}品目 登録済み。`}</div>
        <div>※ {autoLaborPctLabel(engine.autoLaborPct ?? 100)}</div>
        <div>※ 貯金箱・ブリーフの数字は製品検査が週1回作った物です（部品の原資は製品側でも同じ式で候補在庫に入ります）。部品の改善カルテの金額はまだ製品の貯金箱に合算されていません。</div>
      </div>
    </div>
  );
};

export default GoalLayerView;
