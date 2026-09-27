// =============================================================================
//  src/opsim/RiskFlowBoard.jsx — 遅れの見取り図（これから遅れる／いま遅れている／遅れて完了）
// -----------------------------------------------------------------------------
//  元: ChatGPT/Codex の枝 codex/opsim-visual-monthly-20260902（2026-09-23 合流）。
//  赤い棒の長さ＝納期を越えた量。青＝納期まで、縦線＝納期線。文字は札だけ（2026-09-03 設計は絵で）。
//  🚨 数はここで作らない。3列の分け方は opsimPresentation.buildDelayLanes ただ1本。
//     遅れて完了は Panel が lateDone.js で数えた rows をそのまま置く（決まり10: 消さない）。
//  🚨 大きさは rem／Tailwind の段だけ（px を書かない）。押せる物は min-h-11。文字は text-2xs(0.75rem) 以上。
//  🚨 2026-09-24 「期間の中で終わらない」(row.finishBeyondHorizon)も「これから遅れる」に出す（結論の帯と同じ数）。
//     量は出ないので 赤は一番長く・斜線（先が開いている）で描き、日数を言わない。
//  製品・最終で同じ中身(md5 の対)。
// =============================================================================
import React, { useMemo } from 'react';
import { buildDelayLanes } from './opsimPresentation.js';
// 決まり12: 品目コードの隣に 添え書き(テンプレ／特注仕様)。品目コードを素で出さない(最終の見張り 約束H)
import { ModelLabel } from './ModelLabel.jsx';

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const BAR_MAX = 45;
/** 「期間の中で終わらない」の斜線（先が開いている）。結論の帯の「これから遅れる」と同じ色。長さの単位は rem。 */
const OPEN_END_STYLE = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(225 29 72) 0 0.4rem, rgb(255 228 230) 0.4rem 0.8rem)',
});
/** 期間の言い方。日数が届いた時だけ名乗る（届いていなければ「見ている期間」）。 */
const periodText = (horizonDays) => (finite(horizonDays) != null && horizonDays > 0 ? `${horizonDays}営業日` : '見ている期間');

function fmtWhen(ms) {
  if (finite(ms) == null) return '時刻の記録なし';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}） ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 遅れの量の札。🚨 日数は lateDays(1本)の値をそのまま。当日中(null)は時間で言う。 */
function fmtLate(ms, daysLate = null) {
  if (Number.isFinite(daysLate) && daysLate > 0) return `${daysLate}日`;
  if (finite(ms) == null) return '量はまだ出せません';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `今日のうち（${hours}時間）`;
  return `今日のうち（${Math.max(0, totalMinutes)}分）`;
}

const SPEC = Object.freeze({
  future: {
    title: 'これから遅れる',
    note: 'この見立てのままだと納期線を越えます',
    shell: 'border-amber-300 bg-amber-50',
    badge: 'bg-amber-500',
  },
  current: {
    title: 'いま遅れている',
    note: 'いまの時刻がすでに納期線を越えています',
    shell: 'border-rose-400 bg-rose-50',
    badge: 'bg-rose-600',
  },
  completed: {
    title: '遅れて完了した',
    note: '完了後も事実を消さずに残します',
    shell: 'border-violet-300 bg-violet-50',
    badge: 'bg-violet-600',
  },
});

/** 青(納期まで)＋縦線(納期)＋赤(越えた量)。赤の長さは列をまたいで同じ物差し(maxLateMs)。 */
function DelayBar({ row, maxLateMs }) {
  const late = finite(row.lateMs);
  const beyond = row.finishBeyondHorizon === true;
  const width = beyond
    ? BAR_MAX
    : (late == null || !(maxLateMs > 0) ? 0 : Math.max(4, Math.min(BAR_MAX, (late / maxLateMs) * BAR_MAX)));
  return (
    <div className="mt-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-white ring-1 ring-inset ring-slate-200">
        <div className="w-[55%] border-r-2 border-slate-700 bg-cyan-300" title="納期まで" />
        {beyond ? (
          <div data-risk-open-end="" style={{ width: `${width}%`, ...OPEN_END_STYLE }} title="期間の中で終わらない（越える量はまだ出ません）" />
        ) : width > 0 ? (
          <div className="bg-rose-600" style={{ width: `${width}%` }} title="納期を越えた分" />
        ) : null}
      </div>
      <div className="mt-1 flex text-2xs font-bold text-slate-500">
        <span>作業</span>
        <span className="ml-auto mr-[42%]">納期線</span>
      </div>
    </div>
  );
}

function DelayCard({ row, kind, maxLateMs, selected, onSelect }) {
  const done = kind === 'completed';
  const beyond = row.finishBeyondHorizon === true;
  return (
    <button
      type="button"
      data-lot-id={row.lotId}
      onClick={() => { if (typeof onSelect === 'function') onSelect(row.lotId); }}
      className={`min-h-11 w-full rounded-xl border-2 bg-white p-3 text-left shadow-sm transition hover:shadow-md ${selected ? 'ring-2 ring-cyan-500 ring-offset-1' : 'border-white'}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <ModelLabel model={row.model} sub={row.workLabel} className="min-w-0" modelClass="text-base font-black text-slate-900" subClass="text-xs font-bold text-cyan-800" />
        </div>
        {row.orderNo ? <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-black text-slate-600">指図 {row.orderNo}</span> : null}
      </div>
      <DelayBar row={row} maxLateMs={maxLateMs} />
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="font-bold text-slate-500">納期</div>
          <div className="font-black text-slate-800">{fmtWhen(row.dueMs)}</div>
        </div>
        <div>
          <div className="font-bold text-slate-500">{done ? '完了' : '完了見込み'}</div>
          <div className="font-black text-slate-800">{beyond ? '期間の中で終わらない' : fmtWhen(row.finishMs)}</div>
        </div>
      </div>
      {row.finishedInCalc ? (
        <div className="mt-1 text-2xs font-bold text-slate-500">計算の上では、いまの時刻までに終わっています</div>
      ) : null}
      <div className="mt-2 rounded-lg bg-rose-600 px-3 py-2 text-center text-sm font-black text-white">
        {beyond ? '期間の中で終わらず納期を越える' : `納期より ${fmtLate(row.lateMs, row.daysLate)} ${done ? '遅れて完了' : '遅れる'}`}
      </div>
    </button>
  );
}

const SHOW_FIRST = 10;
const EMPTY_ROWS = Object.freeze([]);

function DelayLane({ kind, rows, selectedLotId, onSelectLot, maxLateMs, extraNote = '' }) {
  const spec = SPEC[kind];
  return (
    <section data-risk-lane={kind} className={`min-w-0 rounded-2xl border-2 p-2.5 ${spec.shell}`}>
      <header className="mb-2 rounded-xl bg-white/80 p-2.5">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-black text-white ${spec.badge}`}>{spec.title}</span>
          <span className="ml-auto text-xl font-black tabular-nums text-slate-900">{rows.length}<span className="ml-1 text-xs">件</span></span>
        </div>
        <p className="mt-1 text-xs font-bold leading-snug text-slate-600">{spec.note}</p>
        {extraNote ? <p className="mt-1 text-2xs font-bold leading-snug text-slate-500">{extraNote}</p> : null}
      </header>
      {rows.length ? (
        <div className="space-y-2">
          {rows.slice(0, SHOW_FIRST).map((row) => (
            <DelayCard
              key={row.lotId}
              row={row}
              kind={kind}
              maxLateMs={maxLateMs}
              selected={selectedLotId === row.lotId}
              onSelect={onSelectLot}
            />
          ))}
          {rows.length > SHOW_FIRST ? (
            <details className="rounded-xl border border-slate-300 bg-white p-2">
              <summary className="min-h-11 cursor-pointer text-center text-xs font-black leading-loose text-cyan-700">ほか {rows.length - SHOW_FIRST}件を見る</summary>
              <div className="mt-2 space-y-2">
                {rows.slice(SHOW_FIRST).map((row) => (
                  <DelayCard key={row.lotId} row={row} kind={kind} maxLateMs={maxLateMs}
                    selected={selectedLotId === row.lotId} onSelect={onSelectLot} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-5 text-center text-sm font-bold text-slate-500">0件</div>
      )}
    </section>
  );
}

/**
 * @param {object} p
 * @param {Array}  p.lotResults  result.base.lotResults（見立て）
 * @param {Array}  p.lots        normalized.lots（品目コード・指図の元）
 * @param {object} p.lateDone    Panel の lateDone（{rows:[…]}。lateDone.js の buildLateDone の戻り）
 * @param {number} p.nowMs       いまの時刻（つまみの時刻）
 * @param {Function} [p.subOf]   品目コードに添える文字の引き方（製品=tplNameOf／最終=specialOf）
 * @param {string}   [p.subName] 札の名前（'テンプレ'／'特注仕様'）
 * @param {number}   [p.horizonDays] 期間の営業日数（届いた時だけ「N営業日」と名乗る）
 */
export function RiskFlowBoard({
  lotResults = [], lots = [], lateDone = null, nowMs = null,
  selectedLotId = null, onSelectLot = null, subOf = null, subName = 'テンプレ', horizonDays = null,
}) {
  const lateDoneRows = lateDone && Array.isArray(lateDone.rows) ? lateDone.rows : EMPTY_ROWS;
  const lanes = useMemo(
    () => buildDelayLanes({ lotResults, lots, lateDoneRows, nowMs, subOf, subName }),
    [lotResults, lots, lateDoneRows, nowMs, subOf, subName],
  );
  const allRows = [...lanes.future, ...lanes.current, ...lanes.completed];
  const maxLateMs = allRows.reduce((max, row) => Math.max(max, finite(row.lateMs) || 0), 0);
  const currentNote = lanes.currentFinishedCount > 0
    ? `うち ${lanes.currentFinishedCount}件は、計算の上では いまの時刻までに終わっています（遅れた事実は残します）`
    : '';
  const completedNote = lateDone && lateDone.windowText ? `${lateDone.windowText}の完了記録から` : '';
  const futureNote = lanes.futureBeyondHorizonCount > 0
    ? `うち ${lanes.futureBeyondHorizonCount}件は${periodText(horizonDays)}の中で終わらない`
    : '';
  const unknownRest = lanes.unknownCount - lanes.unknownNoDueCount;
  const basisText = finite(nowMs) != null ? `基準: ${fmtWhen(nowMs)}（つまみの時刻）` : '基準: つまみの時刻';
  return (
    <div data-opsim-risk-flow="" className="rounded-2xl border border-slate-200 bg-white p-2.5">
      <div className="mb-2 rounded-xl bg-slate-900 px-3 py-2.5 text-white">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <div className="text-base font-black">赤い部分が長いほど、納期を大きく越えます</div>
          <div data-risk-basis="" className="ml-auto text-xs font-bold text-slate-300">{basisText}</div>
        </div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs font-bold text-slate-200">
          <span>青＝納期まで</span><span>縦線＝納期</span><span>赤＝納期を越える量</span><span>赤の斜線＝期間の中で終わらない</span>
          <span className="ml-auto">
            間に合う {lanes.safeCount}件 ／ 納期の記録なし {lanes.unknownNoDueCount}件
            {unknownRest > 0 ? ` ／ 判定がつかない ${unknownRest}件` : ''}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
        <DelayLane kind="future" rows={lanes.future} selectedLotId={selectedLotId} onSelectLot={onSelectLot} maxLateMs={maxLateMs} extraNote={futureNote} />
        <DelayLane kind="current" rows={lanes.current} selectedLotId={selectedLotId} onSelectLot={onSelectLot} maxLateMs={maxLateMs} extraNote={currentNote} />
        <DelayLane kind="completed" rows={lanes.completed} selectedLotId={selectedLotId} onSelectLot={onSelectLot} maxLateMs={maxLateMs} extraNote={completedNote} />
      </div>
    </div>
  );
}

export default RiskFlowBoard;
