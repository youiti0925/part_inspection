// =============================================================================
//  src/opsim/TodaySignal.jsx — 「今日の判断」の本体（人ごとの指示 ＋ 何が・どれだけ遅れるか）
// -----------------------------------------------------------------------------
//  🚨 決まり8(2026-09-02 清水さん)「人間が視覚的に理解しやすくするのが第一条件」
//     → 文字を読む前に **色・長さ・位置** で分かる形にする。文字は札だけ。
//  🚨 決まり9「何が遅れるのか」: 1本の横棒 = 1ロット。長さ = どれだけ遅れるか。
//     札は 品目コード｜テンプレ｜指図（決まり12: 品目コードだけでは意味が無い）。
//  🚨 遅れの3つを **混ぜない**（2026-08-22 の「すでに超過／この先の見込み／判定がつかない」と同じ族）:
//     ① いま遅れている   … lotResults.alreadyPastDue（今日の事実。人を増やしても減らない）
//     ② これから遅れる   … lotResults.late && !alreadyPastDue（この見立ての結果）
//     ③ 遅れて完了した   … domain/lateDone.js（決まり10: 完了しても消さない）
//  🚨 ここでは判定しない。①②は lotResults の値そのまま、③は buildLateDone の行そのまま。
//     dueLineMs と finishMs を比べ直すと、盤と別の答えを持つ画面になる。
//  🚨 px 直書きをしない（文字サイズ設定で1pxも拡大しないため）。長さは % と rem だけ。
//  🚨 CSS の zoom / transform:scale は使わない（押した所がズレる。2026-08-08 に廃止）。
//  🚨 出してはいけない言葉: できない・不可・未経験・初級・上級者・有意・標本・スコア・偏差・予定表
// =============================================================================
import React, { useMemo, useState } from 'react';
import { WorkerLanes } from './WorkerLanes.jsx';
// 🎨 絵の語彙(2026-09-15)。この画面が新しい見た目を作らない為に vizKit から借りる。
//   🚨 ここで数を作らない。画面がもう持っている値(rows.length / row.days)を長さと点に変えるだけ。
import { Dots, Glyph } from './vizKit.jsx';

const DAY = 86400000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtMD = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
};
const fmtInt = (n) => (isNum(n) ? n.toLocaleString('ja-JP') : '—');

/** templatesById は Map でも素のオブジェクトでも、値が文字列でも受ける（Board.jsx と同じ読み方）。 */
function tplNameOf(templatesById, id) {
  if (!id || !templatesById) return '';
  const t = templatesById instanceof Map ? templatesById.get(id) : templatesById[id];
  if (typeof t === 'string') return t;
  return (t && typeof t.name === 'string') ? t.name : '';
}

/** 「これから遅れる」の斜線。色はここ1か所。長さの単位は rem（px 直書きをしない）。 */
const HATCH_STYLE = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(225 29 72) 0 0.4rem, rgb(255 228 230) 0.4rem 0.8rem)',
});

/** 群の見た目。🚨 色の意味は固定: 赤=いま遅れている / 赤の斜線=これから遅れる / 灰＋赤い数字=遅れて完了。 */
const KIND = Object.freeze({
  now: {
    key: 'now',
    title: 'いま遅れている',
    hint: '納期線をもう越えている物（今日の事実）。棒の長さ＝納期からの日数',
    edge: 'border-rose-300',
    head: 'bg-rose-50 text-rose-700',
    num: 'text-rose-600',
  },
  soon: {
    key: 'soon',
    title: 'これから遅れる',
    hint: 'この見立てでは納期線を越える物。棒の長さ＝越える日数。▼＝納期',
    edge: 'border-rose-300',
    head: 'bg-rose-50 text-rose-700',
    num: 'text-rose-600',
  },
  done: {
    key: 'done',
    title: '遅れて完了した',
    hint: '納期を過ぎてから完了した物（完了しても消しません）。棒の長さ＝遅れた日数',
    edge: 'border-slate-300',
    head: 'bg-slate-100 text-slate-700',
    num: 'text-rose-600',
  },
});

/**
 * 見立て(lotResults)を ①いま ②これから の2群に分ける。
 * 🚨 判定は lotResults の alreadyPastDue / late / judgeable / lateMs **そのまま**。ここで比べ直さない。
 * ⚠ 「いま遅れている」の日数 = ceil((いま − 納期線) / 1日)。今日の事実なので見立てで動かない。
 */
function splitLotResults({ lotResults, lots, templatesById, nowMs }) {
  const byId = new Map();
  (Array.isArray(lots) ? lots : []).forEach((l) => { if (l && l.lotId) byId.set(String(l.lotId), l); });
  const now = [];
  const soon = [];
  let unjudgeable = 0;
  let ok = 0;
  (Array.isArray(lotResults) ? lotResults : []).forEach((r) => {
    if (!r || !r.lotId) return;
    const l = byId.get(String(r.lotId)) || {};
    const dueLineMs = isNum(r.dueLineMs) ? r.dueLineMs : (isNum(l.dueLineMs) ? l.dueLineMs : null);
    const base = {
      lotId: String(r.lotId),
      model: (typeof l.model === 'string' && l.model.trim()) || '(品目コードなし)',
      tplName: tplNameOf(templatesById, l.templateId) || 'テンプレ名なし',
      orderNo: (typeof l.orderNo === 'string' && l.orderNo.trim()) || '',
      dueLineMs,
      assumed: l.arrivalKind === 'assumed',
    };
    if (r.alreadyPastDue === true) {
      const days = (isNum(nowMs) && isNum(dueLineMs)) ? Math.max(1, Math.ceil((nowMs - dueLineMs) / DAY)) : null;
      // 濃い赤＝人が付く見立てが出ている(judgeable) / 薄い赤＝到着の予定が無い等で見立てが出ない
      now.push({ ...base, days, deep: r.judgeable !== false, reason: r.judgeable === false ? (r.unknownReason || r.blocked || '') : '' });
      return;
    }
    if (r.late === true) {
      // lateMs が無い = 配置はできたが、この期間の中では終わらない(いつ終わるかは出せない)
      const days = isNum(r.lateMs) ? Math.max(1, Math.ceil(r.lateMs / DAY)) : null;
      soon.push({ ...base, days, finishMs: isNum(r.finishMs) ? r.finishMs : null, blocked: r.blocked || null });
      return;
    }
    if (r.judgeable === false) { unjudgeable += 1; return; }
    ok += 1;
  });
  now.sort((a, b) => ((b.days ?? -1) - (a.days ?? -1)) || a.lotId.localeCompare(b.lotId));
  // 終わりが出せない物(days:null)は「期間の外まで遅れる」なので一番上に置く。
  soon.sort((a, b) => ((b.days ?? Infinity) - (a.days ?? Infinity)) || a.lotId.localeCompare(b.lotId));
  return { now, soon, unjudgeable, ok };
}

/** 札: 品目コード｜テンプレ｜指図（決まり12）。 */
function LotLabel({ model, tplName, orderNo, assumed }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 leading-tight">
      <span className="truncate text-sm font-black text-slate-900">{assumed ? '［仮］' : ''}{model}</span>
      <span className="truncate text-xs font-bold text-slate-500">｜{tplName}</span>
      {orderNo ? <span className="shrink-0 text-2xs font-bold tabular-nums text-slate-400">｜{orderNo}</span> : null}
    </span>
  );
}

/** 札に添える1行（納期・見込み・完了）。文字は補助。 */
function subLineOf(row, kind) {
  if (kind === 'now') {
    return `納期 ${fmtMD(row.dueLineMs)}${row.deep ? '' : `・${row.reason || '見立てが出ていません'}`}`;
  }
  if (kind === 'soon') {
    if (isNum(row.days)) return `納期 ${fmtMD(row.dueLineMs)} → 終わる見込み ${fmtMD(row.finishMs)}`;
    return `納期 ${fmtMD(row.dueLineMs)}・この期間の中では終わりません${row.blocked ? `（${row.blocked}）` : ''}`;
  }
  const note = row.completedSource === 'updatedAt' ? '（完了の記録なし・更新時刻で代用）' : '';
  return `${fmtMD(row.dueMs)} 納期 → ${fmtMD(row.completedMs)} 完了${note}`;
}

/**
 * 1本の横棒 = 1ロット。長さ = 日数 ÷ 目盛りの最大（3群で同じ目盛り。長さを見比べられる）。
 * 🚨 数字を大きく出すのは「答え」(+N日)だけ。
 */
function LateBar({ row, kind, scaleDays, selected, onSelect }) {
  const k = KIND[kind];
  const pct = (isNum(row.days) && scaleDays > 0) ? Math.max(3, Math.min(100, (row.days / scaleDays) * 100)) : 100;
  let barCls = 'bg-slate-400';
  let barStyle = null;
  if (kind === 'now') barCls = row.deep ? 'bg-rose-600' : 'bg-rose-300';
  else if (kind === 'soon') { barCls = ''; barStyle = HATCH_STYLE; }
  const sub = subLineOf(row, kind);
  const canSelect = typeof onSelect === 'function';
  return (
    <button
      type="button"
      data-lot-id={row.lotId}
      data-late-kind={kind}
      data-late-days={isNum(row.days) ? row.days : ''}
      disabled={!canSelect}
      onClick={() => { if (canSelect) onSelect(row.lotId); }}
      title={`${row.model}｜${row.tplName}${row.orderNo ? `｜${row.orderNo}` : ''}。${sub}${canSelect ? '（押すと、この仕事の詳しい話が出ます）' : ''}`}
      className={`grid w-full items-center gap-x-2 gap-y-0.5 rounded-lg px-1.5 py-1 text-left ${canSelect ? 'hover:bg-slate-50' : ''} ${selected ? 'ring-2 ring-cyan-500' : ''}`}
      style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) auto' }}
    >
      <span className="min-w-0">
        <LotLabel model={row.model} tplName={row.tplName} orderNo={row.orderNo} assumed={row.assumed} />
        <span className="block truncate text-2xs text-slate-500">{sub}</span>
      </span>
      <span className="relative h-4 min-w-0 rounded-sm bg-slate-100">
        <span className={`absolute inset-y-0 left-0 rounded-sm ${barCls}`} style={{ width: `${pct}%`, ...(barStyle || {}) }} />
        {kind === 'soon' ? <span aria-hidden="true" className="absolute -top-1.5 left-0 text-2xs leading-none text-rose-700">▼</span> : null}
      </span>
      <span className={`shrink-0 text-right text-xl font-black leading-none tabular-nums ${k.num}`}>
        {isNum(row.days) ? `+${fmtInt(row.days)}日` : <span className="text-sm">終わりが出せません</span>}
      </span>
    </button>
  );
}

/** 1群。見出しに件数、下に横棒。多い時は「ほか N件」で畳む（消さない）。 */
function LateGroup({ kind, rows, scaleDays, note, selectedLotId, onSelect, limit = 8 }) {
  const [all, setAll] = useState(false);
  const k = KIND[kind];
  const shown = all ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <section data-late-group={kind} data-late-count={rows.length} className={`flex min-w-0 flex-col rounded-xl border-2 bg-white ${k.edge}`}>
      <header className={`flex items-baseline gap-2 rounded-t-lg px-3 py-1.5 ${k.head}`} title={k.hint}>
        {/* 🚨 2026-09-15: 3つの群の見出しは notext で **全部真っ白** だった(色の付いた枠しか残らない)。
            旗(納期)の線画＋件数ぶんの点を足す。点の色で3群を見分ける:
              いま遅れている=濃い赤 / これから遅れる=薄い赤 / 遅れて完了した=灰。
            🚨 橙は空き(スキル待ち)専用なので遅れには使わない(決まり27)。
            🚨 点の数は rows.length そのまま＝この見出しが既に出している数。新しい集計をしていない。 */}
        <Glyph kind="due" className="w-4 h-4 shrink-0" title={k.title} />
        <span className="text-sm font-black">{k.title}</span>
        <b className="text-2xl font-black leading-none tabular-nums">{fmtInt(rows.length)}</b>
        <span className="text-xs font-bold">件</span>
        <Dots
          count={rows.length}
          cap={12}
          tone={kind === 'now' ? 'late' : (kind === 'soon' ? 'lateSoon' : 'quiet')}
          size="w-2 h-2"
          title={`${k.title} ${fmtInt(rows.length)}件`}
          className="shrink-0"
        />
        {note ? <span className="ml-auto truncate text-2xs font-bold opacity-80">{note}</span> : null}
      </header>
      <div className="flex flex-col gap-0.5 p-1.5">
        {rows.length === 0 ? (
          <div className="px-1.5 py-2 text-xs text-slate-500">
            {kind === 'done' ? 'この期間に、納期を過ぎてから完了した物はありません' : '1件もありません'}
          </div>
        ) : shown.map((r) => (
          <LateBar key={r.lotId} row={r} kind={kind} scaleDays={scaleDays} selected={selectedLotId === r.lotId} onSelect={onSelect} />
        ))}
        {(hidden > 0 || all) ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="mt-0.5 min-h-11 rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs font-bold text-cyan-700 hover:bg-white"
          >
            {all ? '上の分だけに戻す' : `ほか ${fmtInt(hidden)}件 を出す`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 「何が・どれだけ遅れるか」の3群。
 * @param {Array}  props.lotResults   result.base.lotResults（そのまま）
 * @param {Array}  props.lots         result.normalized.lots（品目コード・テンプレ・指図を引く）
 * @param {object} props.lateDone     buildLateDone の戻り値（rows(+tplName) / counts / windowText）。行はそのまま出す
 */
export function TodayLateBars({
  lotResults = [],
  lots = [],
  templatesById = null,
  nowMs = null,
  lateDone = null,
  selectedLotId = null,
  onSelectLot = null,
}) {
  const g = useMemo(() => splitLotResults({ lotResults, lots, templatesById, nowMs }), [lotResults, lots, templatesById, nowMs]);
  // 🚨 遅れて完了の行は buildLateDone の物そのまま。ここで数え直さない・落とさない。
  const doneRows = useMemo(() => {
    const rows = Array.isArray(lateDone && lateDone.rows) ? lateDone.rows : [];
    return rows.map((r) => ({
      lotId: r.lotId,
      model: r.model || '(品目コードなし)',
      tplName: r.tplName || tplNameOf(templatesById, r.templateId) || 'テンプレ名なし',
      orderNo: r.orderNo || '',
      days: r.daysLate,
      dueMs: r.dueMs,
      completedMs: r.completedMs,
      completedSource: r.completedSource,
    }));
  }, [lateDone, templatesById]);
  // 3群で同じ目盛り（一番長い物が枠いっぱい）。長さを見比べられる。
  const scaleDays = Math.max(
    1,
    ...g.now.map((r) => r.days || 0),
    ...g.soon.map((r) => r.days || 0),
    ...doneRows.map((r) => r.days || 0),
  );
  const hasResult = Array.isArray(lotResults) && lotResults.length > 0;
  const deepN = g.now.filter((r) => r.deep).length;
  // 期間と「窓の外にもある件数」は buildLateDone が白状した counts から(ここで数え直さない)。
  const outside = lateDone && lateDone.counts ? Number(lateDone.counts.outsideWindow) || 0 : 0;
  const doneNote = (lateDone && lateDone.windowText ? lateDone.windowText : '')
    + (outside ? `・期間の外にも ${fmtInt(outside)}件` : '')
    + (doneRows.length ? `・最大 +${fmtInt(doneRows[0].days)}日` : '');
  return (
    <div className="flex flex-col gap-1.5" data-today-late-bars="1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1">
        <span className="text-base font-black text-slate-900">何が遅れた？ 何が遅れる？</span>
        <span className="text-2xs text-slate-500">
          1本＝1ロット。長さ＝どれだけ遅れるか（3つとも同じ目盛り・枠いっぱい＝{fmtInt(scaleDays)}日）。札は 品目コード｜テンプレ｜指図
        </span>
        {hasResult ? (
          <span className="ml-auto text-2xs text-slate-500">
            守れる <b className="tabular-nums text-emerald-700">{fmtInt(g.ok)}</b>件・判定がつかない <b className="tabular-nums text-slate-700">{fmtInt(g.unjudgeable)}</b>件（棒にしていません）
          </span>
        ) : (
          <span className="ml-auto text-2xs text-slate-500">見立ては まだ計算していません（「遅れて完了した」は記録から出ます）</span>
        )}
      </div>
      <div className="grid gap-2 xl:grid-cols-3">
        <LateGroup
          kind="now" rows={g.now} scaleDays={scaleDays} selectedLotId={selectedLotId} onSelect={onSelectLot}
          note={g.now.length ? `濃い赤 ${fmtInt(deepN)}・薄い赤 ${fmtInt(g.now.length - deepN)}（見立てが出ない）` : ''}
        />
        <LateGroup
          kind="soon" rows={g.soon} scaleDays={scaleDays} selectedLotId={selectedLotId} onSelect={onSelectLot}
          note={g.soon.length ? '斜線＝この見立ての結果（手を打てば減ります）' : ''}
        />
        <LateGroup
          kind="done" rows={doneRows} scaleDays={scaleDays} selectedLotId={null} onSelect={null}
          note={doneNote}
        />
      </div>
    </div>
  );
}

/**
 * 「今日の判断」の本体。上から ①人ごとの指示（今日 誰が何を？）②何が遅れた？何が遅れる？
 * 帯（信号1つ）は Header が出す（同じ数え方 opsimTallyOf を読むため）。
 */
export function TodayJudgment({
  snapshot = null,
  assignments = null,
  lots = [],
  lotResults = [],
  templatesById = null,
  lotVerdictById = null,
  nowMs = null,
  lateDone = null,
  selectedLotId = null,
  onSelectLot = null,
  /** 🚨 2026-09-04: ここが無くて「今日 誰が何を？」が空だった（人・日順の材料は fromMs〜toMs の日の列から作る。
   *  無ければ日の列が0本＝「営業日が1日もありません」）。納期一覧・人ごとの指示と同じ物をそのまま渡す。 */
  calendar = null,
  idleLog = null,
  idleByDay = null,
  fromMs = null,
  toMs = null,
  workerNames = null,
}) {
  return (
    <div className="flex flex-col gap-2.5" data-today-judgment="1">
      <section className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 px-1">
          <span className="text-base font-black text-slate-900">今日 誰が何を？</span>
          <span className="text-2xs text-slate-500">1人につき「現在」「終わったら」。赤い枠＝納期線を越えている仕事</span>
        </div>
        <WorkerLanes
          snapshot={snapshot}
          assignments={assignments}
          lots={lots}
          nowMs={nowMs}
          templatesById={templatesById}
          lotVerdictById={lotVerdictById}
          selectedLotId={selectedLotId}
          onSelectLot={onSelectLot}
          calendar={calendar}
          idleLog={idleLog}
          idleByDay={idleByDay}
          fromMs={fromMs}
          toMs={toMs}
          workerNames={workerNames}
        />
      </section>
      <TodayLateBars
        lotResults={lotResults}
        lots={lots}
        templatesById={templatesById}
        nowMs={nowMs}
        lateDone={lateDone}
        selectedLotId={selectedLotId}
        onSelectLot={onSelectLot}
      />
    </div>
  );
}

export default TodayJudgment;
