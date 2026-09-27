// 📅 P149 / P160 工場の暦の登録画面(製品 App.jsx:41731 FactoryCalendarPanel を写した)。
//   置き場所は検査アプリ共通の棚 contact-shared-v1/settings/config.factoryCalendar(製品・最終と同じ1か所)。
//   部品の全体進捗・操業シミュは既にこの棚を読んでいるので、ここで登録すれば部品の計算にもそのまま効く。
//   既定: 部品からは書かない(settings.factoryCalendarEditInParts が true の時だけ登録できる)。
//     共通の棚は製品・最終・司令塔も見るので、切り替えるまでは「見るだけ」の暦を出す。
import React, { useState, useMemo } from 'react';
import { Calendar } from 'lucide-react';
import {
  DAY_OFF as FCAL_OFF, DAY_WORK as FCAL_WORK,
  normalizeCalendar as fcalNormalize, monthSummary as fcalMonthSummary,
  monthDays as fcalMonthDays, shiftMonth as fcalShiftMonth, cycleDay as fcalCycleDay,
  setDayLabel as fcalSetDayLabel, ymdOf as fcalYmdOf,
} from '../domain/factoryCalendar.js';


export const FactoryCalendarPanel = ({ calendar = null, onSave = null, loaded = true, nowMs = null, canToggle = false, editOn = false, onToggleEdit = null }) => {
  // 🚨 hooks は必ずガード(return null)より **上**。2026-08-27「ガードより後ろの hooks で
  //   画面が丸ごと消えた」(Rendered fewer hooks)。ここには早期 return を入れない。
  // ⚠ 「きょう」は描画のたびに時計を読まない(react-hooks/purity)。開いた時に1回だけ決める。
  //   使い道は今日のマスに枠を出すだけなので、日付が変わっても実害はない。
  const [todayYmd] = useState(() => fcalYmdOf(nowMs ?? Date.now()) || '');
  const [ym, setYm] = useState(() => {
    const t = new Date(nowMs ?? Date.now());
    return { year: t.getFullYear(), month: t.getMonth() + 1 };
  });
  // 一言(なぜ休みか)の下書き。1文字ごとに保存しにいかない(打っている間に他端末の値で消えるため)。
  const [labelDraft, setLabelDraft] = useState({});
  const cal = useMemo(() => fcalNormalize(calendar), [calendar]);
  const summary = useMemo(() => fcalMonthSummary({ year: ym.year, month: ym.month, calendar: cal }), [ym, cal]);
  const days = useMemo(() => fcalMonthDays(ym.year, ym.month, cal), [ym, cal]);
  const registered = useMemo(() => days.filter((d) => d.type), [days]);
  // 格子の頭の空きマス(1日の曜日ぶん)
  const lead = days.length ? days[0].dow : 0;

  const commit = (r) => {
    if (!onSave) return;
    onSave({ days: r.days, deleteKeys: r.deleteKeys });
  };
  const onCell = (ymd) => commit(fcalCycleDay(cal, ymd));
  const onLabel = (ymd, text) => {
    setLabelDraft((m) => { const n = { ...m }; delete n[ymd]; return n; });
    commit(fcalSetDayLabel(cal, ymd, text));
  };

  const DOW_HEAD = ['日', '月', '火', '水', '木', '金', '土'];
  const cellClass = (d) => {
    if (d.type === FCAL_OFF) return 'bg-slate-200 text-slate-500 border-slate-300';
    if (d.type === FCAL_WORK) return 'bg-emerald-100 text-emerald-700 border-emerald-300';
    if (d.weekend) return 'bg-slate-50 text-slate-300 border-slate-100';
    return 'bg-white text-slate-700 border-slate-200';
  };

  const readOnly = !onSave;
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <div className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-rose-600" /> 工場の暦（休みを先に登録）
        </div>
        <div className="text-xs text-slate-400">{readOnly ? "見るだけ（部品検査からの登録は切り替えで入れます）" : "日をタップで 出勤 ⇄ 休み を切替（もう一度押すと元に戻ります）"}</div>
      </div>
      <div className="text-xs text-slate-500 mb-3">
        祝日・年末年始・お盆・全社休業を <b>先に</b> 登録します。土曜に出るなら「休日出勤」も同じ操作で登録できます。
        <span className="text-slate-400">（人ごとの休みは下の「作業者ロスター」。こちらは工場ごとです）</span>
      </div>

      {/* 月を送る + この月の営業日(答えを一番大きく) */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-1">
          <button onClick={() => setYm((v) => fcalShiftMonth(v.year, v.month, -1))}
            className="min-w-10 min-h-10 px-2 rounded-lg border border-slate-200 bg-white text-slate-600 font-bold hover:bg-slate-50">◀</button>
          <div className="px-3 text-base font-bold text-slate-800 whitespace-nowrap">{ym.year}年{ym.month}月</div>
          <button onClick={() => setYm((v) => fcalShiftMonth(v.year, v.month, +1))}
            className="min-w-10 min-h-10 px-2 rounded-lg border border-slate-200 bg-white text-slate-600 font-bold hover:bg-slate-50">▶</button>
          <button onClick={() => { const t = new Date(nowMs ?? Date.now()); setYm({ year: t.getFullYear(), month: t.getMonth() + 1 }); }}
            className="ml-1 min-h-10 px-3 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-500 hover:bg-slate-50">今月へ</button>
        </div>
        {summary && (
          <div className="flex items-end gap-2">
            <span className="text-xs font-bold text-slate-500 mb-1">この月の営業日</span>
            <span className="text-2xl font-bold text-slate-800 leading-none">{summary.workdays}</span>
            <span className="text-sm font-bold text-slate-500 mb-0.5">日</span>
            <span className="text-xs text-slate-400 mb-1">
              （暦{summary.calendarDays}日
              {summary.diff !== 0 && <b className={summary.diff < 0 ? 'text-rose-600' : 'text-emerald-600'}> ・登録で {summary.diff > 0 ? '+' : ''}{summary.diff}日</b>}
              ）
            </span>
          </div>
        )}
      </div>

      {/* 月の格子 */}
      <div className="grid grid-cols-7 gap-1 max-w-2xl">
        {DOW_HEAD.map((w, i) => (
          <div key={w} className={`text-center text-xs font-bold pb-1 ${i === 0 ? 'text-rose-400' : i === 6 ? 'text-sky-400' : 'text-slate-400'}`}>{w}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div key={`lead${i}`} />)}
        {days.map((d) => (
          <button key={d.ymd} onClick={() => onCell(d.ymd)} disabled={!loaded || readOnly}
            title={d.label || (d.type === FCAL_OFF ? '休み' : d.type === FCAL_WORK ? '休日出勤' : '')}
            className={`min-h-10 rounded-lg border flex flex-col items-center justify-center leading-tight
              ${cellClass(d)} ${d.ymd === todayYmd ? 'ring-2 ring-indigo-400' : ''}
              ${readOnly ? "cursor-default" : loaded ? "hover:opacity-80" : "opacity-50 cursor-wait"}`}>
            <span className="text-sm font-bold">{d.day}</span>
            <span className="text-xs">{d.type === FCAL_OFF ? '休' : d.type === FCAL_WORK ? '出' : ' '}</span>
          </button>
        ))}
      </div>

      {/* 登録した日 + 一言 */}
      <div className="mt-3">
        {registered.length === 0 ? (
          <div className="text-xs text-slate-400">この月に登録した休み・休日出勤はありません（＝ 月〜金が営業日）。</div>
        ) : (
          <>
            <div className="text-xs font-bold text-slate-500 mb-1">この月に登録した日（{registered.length}件）</div>
            <div className="flex flex-col gap-1">
              {registered.map((d) => (
                <div key={d.ymd} className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-bold px-2 min-h-10 inline-flex items-center rounded-lg ${d.type === FCAL_OFF ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>
                    {ym.month}/{d.day}（{d.dowLabel}） {d.type === FCAL_OFF ? '休み' : '休日出勤'}
                  </span>
                  <input
                    readOnly={readOnly}
                    value={labelDraft[d.ymd] ?? d.label}
                    onChange={(e) => setLabelDraft((m) => ({ ...m, [d.ymd]: e.target.value }))}
                    onBlur={(e) => { if (e.target.value !== d.label) onLabel(d.ymd, e.target.value); else setLabelDraft((m) => { const n = { ...m }; delete n[d.ymd]; return n; }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="一言（祝日名・全社休業 など。空でもかまいません）"
                    className="flex-1 min-w-0 min-h-10 px-2 text-sm rounded-lg border border-slate-200 text-slate-700 placeholder:text-slate-300" />
                  <button onClick={() => onCell(d.ymd)} disabled={!loaded || readOnly}
                    className="min-h-10 px-3 rounded-lg border border-slate-200 text-xs font-bold text-slate-500 hover:bg-slate-50">取り消す</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 mt-3 text-xs text-slate-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-white border border-slate-200" />営業日</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-slate-200" />休み（登録した日）</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100" />休日出勤（登録した日）</span>
        {!loaded && <span className="text-amber-600 font-bold">共通の棚をまだ読み込んでいます…</span>}
      </div>
      <div className="text-xs text-slate-400 mt-1">
        ※ 登録先は <b>検査アプリ共通の棚</b>です（製品検査・最終検査で登録した休みもここに出ます）。部品検査の全体進捗・操業シミュはこの暦で数えます。
      </div>
      {canToggle && onToggleEdit && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 min-h-10">
          <input type="checkbox" checked={!!editOn} onChange={(e) => onToggleEdit(e.target.checked)} className="w-5 h-5" />
          部品検査からも暦を登録する（既定: しない。登録は製品検査・最終検査でも同じ棚に入ります）
        </label>
      )}
    </div>
  );
};

export default FactoryCalendarPanel;
