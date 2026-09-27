// =============================================================================
//  src/opsim/DueCalendar.jsx — 納期一覧（清水さんが「見やすい」と言った唯一の画面。ここが主役）
// -----------------------------------------------------------------------------
//  横軸が日付。1行=1ロット。棒が「いつ始まっていつ終わるか」、縦線が納期。
//  🚨 決まり9: **納期線を越えた分だけ赤**。赤の長さ＝どれだけ遅れるか。
//  🚨 決まり10: 遅れて完了した物は消さない。一番下に灰色の棒＋赤い +N日。
//  🚨 決まり12: 全行に 品目コード｜テンプレ。
//  🚨 決まり14（2026-09-03 清水さんの5点）:
//    1. 休日はゲージを消す … 土日・祝日の列は細く網掛け。棒は営業日の列だけに切って描く（dueAxis.segmentsOf）。
//    2. 作業者は1人      … 分数が一番多い人を主担当（mainWorker.js）。75%未満の時だけ「＋◯◯と分担」を小さく。
//    3. 暇と理由         … 盤の一番上に IdleStrip（buildIdleByDay の戻りを置くだけ）。
//    4. 指図             … 品目コード｜テンプレの下に「指図 ◯◯ ・ ×台数 ・ 主担当」。
//    5. 人・日順         … 「人ごとの指示」タブ（WorkerLanes → PersonDay）。ここは納期順。
//
//  🚨 計算は一切しない。渡された assignments / lotResults / lateDone / idleByDay を置くだけ。
//  🚨 遅れの判定は lotResults の late/alreadyPastDue をそのまま使う。
//  ⚠ px 直書きをしない（rem 段）。
// =============================================================================
import React, { useMemo, useState } from 'react';
import { LATE_TONE } from './lateTone.js';
import { buildWorkerColors, toneOf, workerNamesOf } from './workerColors.js';
import { tplNameOf } from '../domain/workerPlan.js';
import { buildDayColumns, xOf, segmentsOf, columnAt, workWindowOfSpec, mergeSpans } from './dueAxis.js';
import { arrivalLineOf, arrivalLineTip, arrivalMsOfLot } from './arrivalLine.js';
import { mainWorkerOf, assignmentsByLot } from './mainWorker.js';
import { summarizeSplits } from '../domain/operationsSimulation/handoff.js';
// 🚩 優先度の札(緊急=赤 / 特注=橙 / 通常は出さない)。🚨 数(priorityClass)はエンジン(normalizeInput)が
//   normalized.lots[] に持つ物をそのまま読む。言葉と色は domain/lotPriority.js ただ1本。
import { priorityClassBadgeOf } from '../domain/lotPriority.js';
import { IdleStrip } from './IdleStrip.jsx';
// 🔀 並べ方(2026-09-15)・段と遅れ日数(納期一覧と相手へ渡す書類で同じ数)・優先度の3択
import { sortDueRows, normalizeDueSort, DUE_SORT_KEYS, DUE_SORT_LABEL, dueSortHint } from '../domain/operationsSimulation/dueListOrder.js';
import { dueRowFacts, DUE_TIER } from '../domain/operationsSimulation/dueRowFacts.js';
import { LOT_PRIORITY_CHOICES, priorityOfClass } from '../domain/lotPriority.js';
import { OFF_HATCH } from './idleTone.js';
// 🎨 絵の語彙(2026-09-15)。🚨 数を作らない部品だけを借りる。赤は lateTone.js から借りている。
import { Bar, Avatar } from './vizKit.jsx';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const fmtMD = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtHM = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 段(tier)。🚨「すでに過ぎた」「この先で遅れる」「判定できません」を1つの点数に混ぜない。 */
const TIER = DUE_TIER;   // 段の数は dueRowFacts.js ただ1本(相手へ渡す書類と同じ)
const TIER_LABEL = ['すでに予定日を過ぎています', 'この先で遅れます', '判定できません', ''];

/** 左列: 品目コード｜テンプレ（1行目）／ 指図・台数・主担当（2行目）。全行で同じ形。 */
/**
 * 📏 遅れの札(2026-09-16)。🚨 日の軸の **外**(左の列のすぐ右)に置く。
 *   軸の中に置くと「遅れの長さの棒」が次の日の列に重なり、**もう一度手が付く棒** に見える
 *   (清水さん「なんで連続で作業処理しないの？飛んで仕事を開始してる」= 実は +1日 の札の棒だった)。
 *   🚨 数は作らない。r.lateDays / r.pastDays を lateMax で割って長さにするだけ(札の数字はそのまま)。
 */
function LateChip({ r, lateMax }) {
  const days = r.lateDays != null ? r.lateDays : r.pastDays;
  if (days == null) return <span data-row-late="" />;
  const soon = r.lateDays != null && r.tier !== TIER.PAST;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 justify-self-end" data-row-late={days}
      title={soon ? `納期を ${days}日 越えます（一番遅れる行を全幅にした長さです）` : `予定日を ${days}日 過ぎています（一番遅れる行を全幅にした長さです）`}>
      <Bar value={days} max={lateMax} tone={soon ? 'lateSoon' : 'late'} height="h-2" className="w-10 rounded-full" />
      <b className="whitespace-nowrap text-sm font-black leading-none text-rose-600 tabular-nums">{`+${days}日`}</b>
    </span>
  );
}

function NameCell({ r, workerColors }) {
  const main = r.worker;
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2" data-row-name={r.lotId}>
      {/* 🎨 案A(2026-09-16): 担当の丸(w-8)。色は workerColors の tone を渡す(Avatar は色を決めない)。
          担当が未定なら 赤の点線の輪に「?」(色ではなく形でも分かる)。名前の字は2行目に在る(showName=false)。 */}
      {main ? (
        <Avatar name={main} tone={toneOf(workerColors, main)} size="w-8 h-8" showName={false} className="row-span-2 shrink-0" />
      ) : (
        <span className="row-span-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-rose-400 bg-white text-2xs font-black text-rose-600" title="担当が決まっていません" aria-hidden="true">?</span>
      )}
      <span className="min-w-0 truncate text-base font-black leading-tight text-slate-900" title={`${r.model}｜${r.tplName || 'テンプレ名なし'}`}>
        {/* 🚩 優先度の小さな札(2026-09-10 清水さん「緊急＞特注＞通常」)。通常は出さない。
            🚨 数はエンジンの priorityClass そのまま(渡っていなければ札なし。ここで推測しない)。 */}
        {/* 👤 この人が「優先」にしているテンプレの仕事(2026-09-17)。印は計算の pickedFor そのまま。 */}
        {r.prefPicked ? (
          <span data-row-pref="1" className="mr-1 inline-block rounded border border-amber-400 bg-amber-50 px-1 align-middle text-2xs font-black leading-none text-amber-800" title="この担当が「優先」にしているテンプレの仕事です（個人設定）">優先</span>
        ) : null}
        {r.priorityBadge ? (
          <span data-row-priority={r.priorityBadge.key} className={`mr-1 inline-block rounded border px-1 align-middle text-2xs font-black leading-none ${r.priorityBadge.cls}`}>
            {r.priorityBadge.label}
          </span>
        ) : null}
        {r.model}
        <span className="text-sm font-bold text-slate-500">{`｜${r.tplName || 'テンプレ名なし'}`}</span>
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-1.5 truncate text-2xs leading-tight text-slate-500" data-row-order={r.orderNo || ''}>
        <span className="tabular-nums">指図 {r.orderNo || '—'}</span>
        {isNum(r.quantity) ? <span className="tabular-nums">×{r.quantity}</span> : null}
        <span className={`font-black ${main ? 'text-slate-700' : 'text-rose-600'}`} data-row-worker={main || ''}>{main || '未定'}</span>
        {r.helper ? (
          <span className="truncate text-amber-700" title={`割付が台ごとに ${r.worker} と ${r.helper} へ分かれています（主担当 ${Math.round((r.share || 0) * 100)}%）。1人に決めるには割付の方針の話です。`}>
            ＋{r.helper}と分担{isNum(r.helperShare) ? `(${Math.round(r.helperShare * 100)}%)` : ''}
          </span>
        ) : null}
        {/* 🚨 2026-09-10 清水さん「なんで分担したって書いてないからわかりづらい」。
            計算が残した理由(lotResults[].handoff.splits[].why)をそのまま出す。
            ⚠ 計算が理由を持っていなければ 1文字も出さない(もっともらしい札を作らない)。 */}
        {r.splitWhy ? (
          <span data-row-split-why={r.lotId} className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 leading-none text-amber-800"
            title={r.splitAll || r.splitWhy}>
            なぜ分担？{r.splitCount > 1 ? `(${r.splitCount}回)` : ''}
          </span>
        ) : null}
        {r.assumed ? (
          /* 🚨 2026-09-04: 丸めた物を「納期の2日前」と言わない。色も分ける(橙→赤寄り)。 */
          <span
            data-assumed-kind={r.assumedKind || 'unknown'}
            className={`shrink-0 rounded border px-1 leading-none ${r.assumedKind === 'clampedToNow'
              ? 'border-red-500 bg-red-50 text-red-800'
              : 'border-amber-400 bg-amber-50 text-amber-800'}`}
            title={r.assumedKind === 'clampedToNow'
              ? '入荷日が無いので納期より前に置こうとしましたが、その日はもう過ぎているので、計算の基準時刻に置いています。納期が来ているのに入荷の登録がありません。'
              : (r.assumedKind === 'beforeDue'
                ? '入荷日が無いので、納期より前に仮に置いて計算しています。本当の入荷日を入力すると、そちらで計算し直します。'
                : '入荷日が無いので仮に置いて計算しています（どちらの置き方かは計算から返ってきていません）。')}
          >
            {r.assumedKind === 'clampedToNow' ? '仮(過ぎ)' : '仮'}
          </span>
        ) : null}
      </span>
    </div>
  );
}


/**
 * 🛠 選んだ行の操作(2026-09-15 清水さん「この画面で誰がするか変更したり、外したり、優先度変えて再計算したり、
 *   後、ここで検査リストから削除と編集もできたらいい」)。
 * 🚨 渡された口だけ出す(渡されなければ1つも出ない)。数は作らない。押す物は min-h-11(44px)・文字は .fi-tap-text。
 * 🚨 行そのものは <button>(選ぶ)なので、その **外** に置く(ボタンの中にボタンを入れない)。
 */
function DueRowActions({ r, names, onEditLot, onDeleteLot, onChangePriority, onPinWorker, pinsByLot, onClose = null, insetRight = false, renderWorkRouting = null }) {
  const hasPin = typeof onPinWorker === 'function';
  const pinNow = (pinsByLot && Object.prototype.hasOwnProperty.call(pinsByLot, r.lotId)) ? String(pinsByLot[r.lotId] ?? '') : '__auto';
  if (!renderWorkRouting && !hasPin && typeof onChangePriority !== 'function' && typeof onEditLot !== 'function' && typeof onDeleteLot !== 'function') return null;
  return (
    /* 🛠 2026-09-17 引き出しが右に開く画面では、その幅(md:w-[min(460px,94vw)] = 28.75rem)だけ右を空けて折り返す。px は書かない。 */
    <div className={`flex flex-wrap items-center gap-2 border-b border-cyan-200 bg-cyan-50 px-2 py-1 ${insetRight ? 'md:pr-[min(28.75rem,94vw)]' : ''}`} data-due-actions={r.lotId} data-due-actions-inset={insetRight ? '1' : '0'}>
      <span className="fi-tap-text font-black text-slate-800">この行（指図 {r.orderNo || '—'}）:</span>
      {/* 🚨 2026-09-15 清水さん「クリックしたら特殊とか編集とか出てくるけど、それを消すことができない」→ 閉じる札。行をもう一度押しても閉じる */}
      {typeof onClose === 'function' ? (
        <button type="button" data-due-actions-close={r.lotId} onClick={onClose}
          className="fi-tap-text ml-auto inline-flex min-h-11 items-center rounded-lg border-2 border-slate-400 bg-white px-3 font-black text-slate-800">✕ 閉じる</button>
      ) : null}
      {renderWorkRouting ? renderWorkRouting(r.lotId) : null}
      {hasPin ? (
        <label className="fi-tap-text inline-flex items-center gap-1 text-slate-700">担当
          <select value={pinNow} data-due-pin={r.lotId} data-due-pin-now={pinNow} onChange={(e) => onPinWorker(r.lotId, e.target.value)}
            className="fi-tap-text min-h-11 rounded border border-slate-300 bg-white px-1 font-bold">
            <option value="__auto">自動（計算に任せる）</option>
            {(names || []).map((n) => <option key={n} value={n}>{n} に固定</option>)}
            <option value="">この期間は誰にも当てない</option>
          </select>
        </label>
      ) : null}
      {typeof onChangePriority === 'function' ? (
        <span className="inline-flex items-center gap-1" role="group" aria-label="優先度">
          {LOT_PRIORITY_CHOICES.map((c) => (
            <button key={c.key} type="button" data-due-priority={c.key} aria-pressed={r.priorityKey === c.key}
              onClick={() => onChangePriority(r.lotId, c.key)}
              className={`fi-tap-text inline-flex min-h-11 items-center rounded-lg border-2 px-2 font-black ${r.priorityKey === c.key ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
              {c.label}
            </button>
          ))}
        </span>
      ) : null}
      {typeof onEditLot === 'function' ? (
        <button type="button" data-due-edit={r.lotId} onClick={() => onEditLot(r.lotId)}
          className="fi-tap-text inline-flex min-h-11 items-center rounded-lg border-2 border-slate-300 bg-white px-2 font-black text-slate-700">編集</button>
      ) : null}
      {typeof onDeleteLot === 'function' ? (
        <button type="button" data-due-delete={r.lotId} onClick={() => onDeleteLot(r.lotId)}
          className="fi-tap-text inline-flex min-h-11 items-center rounded-lg border-2 border-rose-300 bg-white px-2 font-black text-rose-700">検査リストから削除</button>
      ) : null}
    </div>
  );
}

export function DueCalendar({
  snapshot = null,
  assignments = null,
  lots = [],
  lotVerdictById = null,
  fromMs = null,
  toMs = null,
  nowMs = null,
  onSelectLot = null,
  selectedLotId = null,
  maxRows = 40,
  /** 🚨 2026-09-05 清水さん「納期一覧は月毎にしても結局一週間ぐらいしか出ない。一回いったよね？」
   *  原因: 40行で切って「下に あと◯件」と書くだけで、下に1行も無かった(納期順なので先頭40件≒1週間分)。
   *  期間が月(今月/来月)の時は最初から全部出す。5営業日でも押せば全部出る。 */
  showAllRowsOpen = false,
  /** 🔀 並べ方(dueListOrder の鍵)。onChangeSort が無ければ この画面の中だけで切り替える。 */
  sortKey = 'risk',
  onChangeSort = null,
  /** 🛠 行からの操作(2026-09-15)。渡されなければ札は1つも出ない(渡されなければ1行も動かない)。 */
  renderWorkRouting = null, onEditLot = null, onDeleteLot = null, onChangePriority = null, onPinWorker = null, pinsByLot = null,
  /** 🛠 2026-09-17 右に「詳しい話」の引き出し(LotDrawer md:w-[min(460px,94vw)])が開く画面では、行の操作の帯の右をその幅だけ空ける
   *  (実測: 拡大中に 編集・検査リストから削除・担当 が引き出しの下に隠れて押せなかった)。渡されなければ今までどおり。 */
  actionsInsetRight = false,
  /** 📌 2026-09-17 「決めた物は固定が既定」: いまの答えの担当をそのまま全部固定する／固定を全部外す。渡されなければ札は出ない。 */
  onPinAll = null, onUnpinAll = null,
  heightPx = null,
  /** テンプレ id → { name }（Map でも可）。決まり12。 */
  templatesById = null,
  /** 遅れて完了（決まり10）。buildLateDone の戻り + rows[].tplName。null なら段を出さない。 */
  lateDone = null,
  /** 計算で使った暦（makeCalendar の戻り）。isWorkday で休みの列を決め、spec で勤務の窓を決める。 */
  calendar = null,
  /** 暇と理由（buildIdleByDay の戻り）。null なら帯を出さない。 */
  idleByDay = null,
  /** 名簿の並び。無ければ snapshot から。 */
  workerNames = null,
  /** 👤📊 2026-09-17 優先がどれだけ効いたか(templatePrefStats)／この期間の負荷(workerLoadInWindow)。帯(IdleStrip)へ渡すだけ。 */
  prefStats = null, loadByWorker = null,
}) {
  const names = useMemo(() => (Array.isArray(workerNames) && workerNames.length ? workerNames : workerNamesOf(snapshot)), [workerNames, snapshot]);
  const workerColors = useMemo(() => buildWorkerColors(names), [names]);
  // 全部出すか。⚠ hooks はガード(下の return)より上。期間を月に切り替えたら自動で全部出す(prop に追従)。
  const [showAllRows, setShowAllRows] = useState(!!showAllRowsOpen);
  // prop が変わった時だけ追従する(描画中に setState する React 公式の「導出した状態」の形。effect で setState すると lint が赤)。
  const [prevShowAllOpen, setPrevShowAllOpen] = useState(!!showAllRowsOpen);
  if (!!showAllRowsOpen !== prevShowAllOpen) { setPrevShowAllOpen(!!showAllRowsOpen); setShowAllRows(!!showAllRowsOpen); }
  // 🔀 並べ方。親が持てば親の物(設定に残る)、無ければこの画面の中だけ。⚠ hooks はガードより上。
  const [sortLocal, setSortLocal] = useState(normalizeDueSort(sortKey));
  const sortNow = typeof onChangeSort === 'function' ? normalizeDueSort(sortKey) : sortLocal;
  const pickSort = (k) => { if (typeof onChangeSort === 'function') onChangeSort(k); else setSortLocal(k); };
  const cols = useMemo(() => {
    const win = workWindowOfSpec(calendar && calendar.spec);
    return buildDayColumns({
      fromMs, toMs,
      isWorkday: calendar && typeof calendar.isWorkday === 'function' ? calendar.isWorkday : null,
      startMin: win.startMin, endMin: win.endMin,
    });
  }, [fromMs, toMs, calendar]);
  const pctOf = (ms) => xOf(cols, ms);

  const rows = useMemo(() => {
    const byLot = assignmentsByLot(assignments);
    const out = [];
    (Array.isArray(lots) ? lots : []).forEach((l) => {
      if (!l || !l.lotId) return;
      const id = String(l.lotId);
      const v = lotVerdictById ? lotVerdictById.get(id) : null;
      const list = byLot.get(id) || null;
      // 🚨 2026-09-10 清水さん「青い線が無駄に長い」。棒は **手が付いている区間**(割付の和集合)だけ。
      //   始まり〜終わりの1本塗りだと、他のロットを挟んで触っていない日まで青かった。
      //   spans が空なら「始まりか終わりが出せません」(下の why)。
      const spans = mergeSpans((list || []).map((a) => [a.startMs, a.endMs]));
      const startMs = spans.length ? spans[0][0] : Infinity;
      const endMs = spans.length ? spans[spans.length - 1][1] : -Infinity;
      const main = mainWorkerOf(list || []);
      // 👥 分担の理由。計算(simulate)が lotResults[].handoff.splits へ残した物だけを読む。
      //   ⚠ ここで作らない(同じ数字・同じ文を2か所から出さない)。
      const splits = (v && v.handoff && Array.isArray(v.handoff.splits)) ? v.handoff.splits : null;
      const splitSum = splits ? summarizeSplits(splits) : null;
      // 段・納期・遅れ日数は dueRowFacts ただ1本(相手の工場へ渡す書類も同じ関数で作る)。
      const F = dueRowFacts({ verdict: v, lot: l, nowMs });
      const due = F.dueMs;
      const tier = F.tier;

      // 🚨 棒が引けない理由を必ず持つ。黙って空行にしない。
      let why = '';
      if (!list) why = due == null ? '納期が入っていません' : 'この期間の中では手が付きません';
      else if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) why = '始まりか終わりが出せません';
      if (!list && v && v.blocked) why = v.blockedDetail ? `${v.blocked}（${v.blockedDetail}）` : v.blocked;

      // どれだけ遅れるか（日）。🚨 エンジンの lateMs をそのまま日に直すだけ。無ければ書かない。
      const { lateMs, lateDays, pastDays } = F;

      out.push({
        lotId: id,
        // 🛠 行から優先度を変える札の「いま」の印。数はエンジンの priorityClass そのまま(字に直すだけ)。
        priorityKey: priorityOfClass(l.priorityClass),
        model: (typeof l.model === 'string' ? l.model.trim() : '') || '(品目コードなし)',
        tplName: tplNameOf(templatesById, l.templateId),
        orderNo: typeof l.orderNo === 'string' ? l.orderNo.trim() : (l.orderNo != null ? String(l.orderNo) : ''),
        quantity: isNum(Number(l.quantity)) && Number(l.quantity) > 0 ? Number(l.quantity) : null,
        worker: main.worker,
        share: main.share,
        helper: main.helper,
        helperShare: main.helperShare,
        splitWhy: splitSum && splitSum.count ? splitSum.first : '',
        splitCount: splitSum ? splitSum.count : 0,
        splitAll: splits && splits.length ? splits.map((x) => x.why).filter(Boolean).join(' ／ ') : '',
        startMs: list ? startMs : null,
        endMs: list ? (v && isNum(v.finishMs) ? Math.max(endMs, v.finishMs) : endMs) : null,
        // 手が付いている区間(時刻順・重なりはまとめ済み)。棒はこれだけを塗り、間は細い線。
        spans: list ? spans : [],
        finishMs: v && isNum(v.finishMs) ? v.finishMs : null,
        // 🧵 2026-09-17 手が付いているのに終わる時刻が無い(=この期間の中で止まる)行の理由。
        //   🚨 文は計算(lotResults.blocked / blockedDetail)そのまま。無ければ「この期間の中では終わりません」。
        //   ⚠ 始めない決まり(simulate.js lotStartedOf/unfinishableStepOf)で **始めていない** ロットはここに来ない(list が無い)。
        //     ここに来るのは 現場でもう進んでいて途中で出来る人が居なくなる物と、期間の終わりを越える物。
        stopWhy: (list && !(v && isNum(v.finishMs)))
          ? ((v && v.blocked) ? (v.blockedDetail ? `${v.blocked}（${v.blockedDetail}）` : v.blocked) : 'この期間の中では終わりません（続きは次の期間）')
          : '',
        dueMs: due,
        tier,
        why,
        lateMs,
        lateDays,
        pastDays,
        // 仮の入荷日で計算されている印(2026-08-31)。判定は normalizeInput の arrivalKind そのまま。
        assumed: l.arrivalKind === 'assumed',
        // 🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違う」。
        //   「仮」には2通りある。判定は normalizeInput の arrivalAssumedKind そのまま(ここで作らない)。
        assumedKind: l.arrivalAssumedKind || null,
        // 🚚 2026-09-18 入荷の縦線。日時も種類も normalizeInput の値そのまま(arrivalMs / arrivalKind)。
        //   'registered'=登録された入荷日(本当) / 'derived'=取込が納期から逆算して置いた日(仮) / 'assumed'=入荷日が無いので計算が仮に置いた日(仮) / 'inShop'=もう手元に在る(線なし)
        arrivalMs: arrivalMsOfLot(l),
        arrivalKind: typeof l.arrivalKind === 'string' ? l.arrivalKind : null,
        // 🚩 優先度の区分(0=緊急 / 1=特注 / 2=通常)。エンジンが normalized.lots[].priorityClass に持つ数そのまま。
        //   数が無ければ null = 札を出さない(ここで lot.priority から作り直さない)。
        priorityBadge: priorityClassBadgeOf(l.priorityClass),
        // 👤🧷 2026-09-17 誰を選んだ理由の印(計算が assignments[].pickedFor に残した物をそのまま)。
        prefPicked: !!(list && list.some((a) => a && a.pickedFor === 'tpl-pref')),
        prevKept: !!(list && list.some((a) => a && a.pickedFor === 'prev')),
      });
    });

    // 🔀 並べ方は dueListOrder ただ1本(既定の「危ない順」= 今までの並び)。
    return sortDueRows(out, sortNow);
  }, [sortNow, assignments, lots, lotVerdictById, templatesById, nowMs]);

  const limit = showAllRows ? rows.length : maxRows;
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  const nowPct = pctOf(nowMs);
  const todayCol = columnAt(cols, nowMs);

  // 遅れて完了（決まり10）。棒の長さ＝遅れた日数（一番遅れた物を全幅の6割にして、比で並べる）。
  const doneRows = lateDone && Array.isArray(lateDone.rows) ? lateDone.rows : null;
  const doneMax = doneRows && doneRows.length ? Math.max(...doneRows.map((r) => Number(r.daysLate) || 0), 1) : 1;
  /* 🚨 遅れの大きさを **長さ** にする為の物差し(2026-09-15)。
     いま画面に出ている r.lateDays / r.pastDays の一番大きい物を全幅にするだけ。
     🚨 新しい集計ではない(すぐ上の doneMax と同じやり方)。この数は画面に **1文字も出さない**
       (出すと「同じ数字を2つの計算から出さない」を破る)。長さの分母にだけ使う。
     🚨 rows(並べ替え済みの全行)で取る。shown だけで取ると「あと◯件を開く」を押した瞬間に
       棒の長さが全部変わって、同じ遅れが違う長さに見える。 */
  const lateMax = Math.max(1, ...rows.map((r) => Number(r.lateDays != null ? r.lateDays : r.pastDays) || 0));

  if (!rows.length && !(doneRows && doneRows.length)) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-slate-200 bg-white p-6 text-2xs text-slate-500">
        この範囲に、計算へ載せるロットが1件もありません。上の「見ている範囲」を広げてみてください。
      </div>
    );
  }

  const DayColumns = () => (
    <>
      {cols.map((d) => (
        <div key={d.ms}
          className="absolute top-0 bottom-0 border-l border-dashed border-slate-100"
          data-day-col={d.ms} data-day-off={d.off ? '1' : '0'}
          style={{ left: `${d.left}%`, width: `${d.width}%`, ...(d.off ? OFF_HATCH : null) }} />
      ))}
      {todayCol ? (
        <div className="absolute top-0 bottom-0 bg-cyan-50/60" style={{ left: `${todayCol.left}%`, width: `${todayCol.width}%` }} />
      ) : null}
    </>
  );

  // ⚠余白と枠は **親1本** に任せる(OperationsSimulationPanel の p-2.5 と CardBox の border+rounded-xl)。
  //   ここにも同じ丸角の白枠を持つと二重になり、上下20px と枠線2px を無駄にしていた。
  // ⚠WorkerLanes.jsx:300 は同じ形だが bg-slate-100 が「レーンの地」として色で効いているので、そちらは残す。
  return (
    <div className="bg-white" style={heightPx ? { minHeight: heightPx } : undefined} data-due-calendar={rows.length} data-due-shown={shown.length} data-due-load={loadByWorker ? '1' : '0'} data-due-pref={prefStats ? '1' : '0'}>

      {/* 🚨 決まり14-3: 一番上に「手が空く時間と理由」。日の列は下の行と同じ物。 */}
      <IdleStrip cols={cols} idleByDay={idleByDay} workerNames={names} workerColors={workerColors} nowMs={nowMs} prefStats={prefStats} loadByWorker={loadByWorker} />

      {/* 🎨 案A(2026-09-16): 見出しは1文。読み方の長い文は消さず title へ移す。凡例は末尾の1行(色の点＋短い語)。 */}

      {/* 🔀 2026-09-15 清水さん「納期順とか並べ替えもカスタマイズできるようにした方がいい」。並べるだけ(数は作らない)。
          鍵と字は dueListOrder.js ただ1本。親が持てば設定に残る(onChangeSort)。押す物は min-h-11・文字は .fi-tap-text。 */}
      <div className="mb-1 flex flex-wrap items-center gap-1" data-due-sort-bar={sortNow}>
        {/* 📐 2026-09-18 夜: この見出しだけで1段使っていた。並べ方の行の頭へ移した(title の読み方の文もそのまま)。 */}
        <span className="mr-1 text-sm font-black text-slate-900"
          title="棒＝手が付く時間（営業日だけ。休みの列は網掛けで棒を消す。他の仕事を挟んで触らない間は細い線）。縦線＝納期。線を越えた分だけ赤">
          いつ終わって、納期に間に合うか
        </span>
        <span className="fi-tap-text font-black text-slate-700">並べ方:</span>
        {DUE_SORT_KEYS.map((k) => (
          <button key={k} type="button" data-due-sort={k} aria-pressed={k === sortNow} onClick={() => pickSort(k)}
            className={`fi-tap-text inline-flex min-h-11 items-center rounded-lg border-2 px-2 font-black ${k === sortNow ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
            {DUE_SORT_LABEL[k]}
          </button>
        ))}
        {/* 📌 2026-09-17 「決めた物は固定が既定」: 計算のたびに担当が入れ替わると指示にならない。いまの答えの担当を **そのまま** 固定する
            (中身は行ごとの「◯◯ に固定」と同じ pins。数は作らない: 担当が在って まだ固定していない行を数えるだけ)。渡されなければ札は出ない。 */}
        {typeof onPinAll === 'function' || typeof onUnpinAll === 'function' ? (() => {
          const has = (id) => !!(pinsByLot && Object.prototype.hasOwnProperty.call(pinsByLot, id));
          const toPin = rows.filter((x) => x.worker && !has(x.lotId)).map((x) => ({ lotId: x.lotId, worker: x.worker }));
          // 🚨 外す数は **設定に在る固定ぜんぶ**(一覧に出ていない行の固定も)。一覧の行だけ数えると「全部外したのに残っている」になる(2026-09-17 確かめ役の実測 3件)。
          const pinnedIds = Object.keys(pinsByLot || {});
          const pinned = pinnedIds.length;
          return (
            <span className="ml-auto inline-flex flex-wrap items-center gap-1" data-due-pin-bar={pinned}>
              {typeof onPinAll === 'function' ? (
                <button type="button" data-due-pin-all={toPin.length} disabled={toPin.length === 0} onClick={() => onPinAll(toPin)}
                  title="いまの答えの担当を、そのまま行ごとの固定にします（計算し直しても担当が入れ替わりません。行の「担当」でいつでも外せます）"
                  className={`fi-tap-text inline-flex min-h-11 items-center gap-1 rounded-lg border-2 px-2 font-black ${toPin.length ? 'border-amber-500 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
                  📌 いまの担当で全部固定（{toPin.length.toLocaleString('ja-JP')}件）
                </button>
              ) : null}
              {typeof onUnpinAll === 'function' && pinned > 0 ? (
                <button type="button" data-due-unpin-all={pinned} onClick={() => onUnpinAll(pinnedIds)}
                  title="この工場の固定を全部外して、計算に任せます（いま一覧に出ていない行の固定も含みます）"
                  className="fi-tap-text inline-flex min-h-11 items-center rounded-lg border-2 border-slate-300 bg-white px-2 font-black text-slate-700">
                  固定を全部外す（{pinned.toLocaleString('ja-JP')}件）
                </button>
              ) : null}
            </span>
          );
        })() : null}
      </div>

      {/* 日付の目盛り */}
      <div className="grid grid-cols-[15rem_6rem_1fr] items-end gap-2">
        <div className="text-2xs font-black text-slate-500">品目コード｜テンプレ ／ 指図・台数・担当（1人）</div>
        <div className="text-2xs font-black text-slate-500 text-right" title="納期をどれだけ越えるか(日)。棒の長さは一番遅れる行を全幅にした比">遅れ</div>
        <div className="relative h-6 border-b-2 border-slate-200">
          {/* 🎨 案A: 今日の列だけ 水色の地＋濃い水色の字で目立たせる(todayCol は columnAt の答えそのまま) */}
          {cols.map((d) => {
            const isToday = !!(todayCol && todayCol.ms === d.ms);
            return (
              <div key={d.ms}
                className={`absolute bottom-0 truncate rounded-t px-1 text-2xs leading-none ${isToday ? 'bg-cyan-50 py-1 font-black text-cyan-700' : (d.off ? 'text-slate-300' : 'font-bold text-slate-600')}`}
                style={{ left: `${d.left}%`, width: `${d.width}%` }}
                data-day-head={d.ms} data-day-today={isToday ? '1' : '0'}>
                {/* 🧹 2026-09-23: 休業日(9/23)は基準の列が次の勤務日(9/24)へ移る。その列を「今日」と言わない */}{d.off && d.width < 3 ? d.wd : `${d.label}(${d.wd})${isToday ? (new Date(d.ms).toDateString() === new Date().toDateString() ? ' 今日' : ' 次の勤務') : ''}`}
              </div>
            );
          })}
        </div>
      </div>

      {shown.map((r) => {
        const duePct = pctOf(r.dueMs);
        const on = r.lotId === selectedLotId;
        // 🚨 棒は spans(手が付いている区間)ごとに切る。区間の間(他の仕事を挟んで触っていない時間)は
        //   細い線(data-bar-gap)だけ。finishMs が最後の区間より後ろ(中断の待ち等)なら、その分も細い線。
        const spanList = (Array.isArray(r.spans) && r.spans.length) ? r.spans
          : ((isNum(r.startMs) && isNum(r.endMs)) ? [[r.startMs, r.endMs]] : []);
        const segs = spanList.flatMap(([s0, e0]) => segmentsOf(cols, s0, e0));
        const hasBar = segs.length > 0;
        const gaps = [];
        for (let gi = 1; gi < spanList.length; gi += 1) {
          const a = pctOf(spanList[gi - 1][1]); const b = pctOf(spanList[gi][0]);
          if (a != null && b != null && b > a) gaps.push({ left: a, width: b - a, fromMs: spanList[gi - 1][1], toMs: spanList[gi][0] });
        }
        if (hasBar && isNum(r.finishMs) && spanList.length && r.finishMs > spanList[spanList.length - 1][1]) {
          const a = pctOf(spanList[spanList.length - 1][1]); const b = pctOf(r.finishMs);
          if (a != null && b != null && b > a) gaps.push({ left: a, width: b - a, fromMs: spanList[spanList.length - 1][1], toMs: r.finishMs });
        }
        const right = hasBar ? segs[segs.length - 1].left + segs[segs.length - 1].width : 0;
        const baseCls = r.tier === TIER.UNKNOWN ? 'bg-slate-300' : 'bg-cyan-400';
        const labelLeft = Math.min(right, 92);
        // 🚨 線を越えた分だけ赤。納期線が棒の中に在れば、線で切って右側だけ赤にする。
        const cut = (duePct != null && r.tier <= TIER.LATE) ? duePct : null;
        return (
          <React.Fragment key={r.lotId}>
          <button
            type="button"
            data-lot-id={r.lotId}
            data-row-tier={r.tier}
            /* 🚨 もう一度押すと閉じる(選んだ行を外す)。前は押すたびに選び直すだけで、帯を消す道が無かった(2026-09-15) */
            onClick={() => { if (typeof onSelectLot === 'function') onSelectLot(on ? null : r.lotId); }}
            className={`grid min-h-11 w-full grid-cols-[15rem_6rem_1fr] items-center gap-2 border-b border-slate-100 py-1 text-left hover:bg-slate-50 ${on ? 'bg-cyan-50' : ''}`}
          >
            <NameCell r={r} workerColors={workerColors} />
            {/* 📏 遅れの札は軸の外(2026-09-16)。軸の中に置くと2本目の棒に見えた */}
            <LateChip r={r} lateMax={lateMax} />

            {/* 🎨 案A: 軸は h-8。棒は h-3 の丸(top-2.5 で上下の真ん中)。細い線は h-0.5 で同じ真ん中。 */}
            <div className="relative h-8">
              <DayColumns />
              {nowPct != null ? (
                <div className="absolute top-0 bottom-0 z-10 w-px bg-slate-400" style={{ left: `${nowPct}%` }} />
              ) : null}

              {gaps.map((g) => (
                <div key={`gap-${g.fromMs}`} data-bar-gap="1"
                  className="absolute top-[0.9375rem] h-0.5 rounded-full bg-slate-300"
                  style={{ left: `${g.left}%`, width: `${g.width}%` }}
                  title={`${fmtMD(g.fromMs)} ${fmtHM(g.fromMs)}〜${fmtMD(g.toMs)} ${fmtHM(g.toMs)} は、このロットに手が付いていません（他の仕事を挟んでいます）`} />
              ))}
              {hasBar ? segs.map((s, i) => {
                const l = s.left; const rr = s.left + s.width;
                const overFrom = cut == null ? rr : Math.max(l, Math.min(rr, cut));
                const baseW = Math.max(0, overFrom - l);
                const overW = Math.max(0, rr - overFrom);
                const first = i === 0; const last = i === segs.length - 1;
                return (
                  <React.Fragment key={`${s.dayMs}-${s.startMs}`}>
                    {baseW > 0 ? (
                      <div className={`opsim-move absolute top-2.5 h-3 ${first ? 'rounded-l-full' : ''} ${last && overW <= 0 ? 'rounded-r-full' : ''} ${baseCls}`}
                        data-bar-day={s.dayMs}
                        /* 📏 2026-09-17 15〜39分の仕事は 5営業日の軸で 4〜11px になり見えなかった(実測5行)。最低幅を rem で持つ。 */
                        style={{ left: `${l}%`, width: `${Math.max(0.4, baseW)}%`, minWidth: '0.5rem' }} />
                    ) : null}
                    {overW > 0 ? (
                      <div className={`opsim-move absolute top-2.5 h-3 shadow-sm ${last ? 'rounded-r-full' : ''} ${first && baseW <= 0 ? 'rounded-l-full' : ''} ${r.tier === TIER.PAST ? LATE_TONE.past.bar : LATE_TONE.forecast.bar}`}
                        data-bar-day={s.dayMs} data-bar-over="1"
                        style={{ left: `${overFrom}%`, width: `${Math.max(0.4, overW)}%` }}
                        title={r.lateDays != null ? `納期を ${r.lateDays}日 越えます` : '納期を越えます'} />
                    ) : null}
                  </React.Fragment>
                );
              }) : (
                <span className={`absolute inset-y-0 left-0 flex items-center text-2xs font-bold leading-tight ${r.tier <= TIER.LATE ? 'text-rose-600' : 'text-slate-400'}`}>{r.why}</span>
              )}

              {/* 終わる時刻の札(text-2xs font-black・棒の右端)。遅れの数字は左の「遅れ」の列(LateChip)ただ1つ。 */}
              {hasBar && r.stopWhy ? (
                /* 🧵 2026-09-17 手が付いたのに終わらない行。棒の右端に赤い印＋理由(計算の文そのまま)。黙って棒だけを出さない。 */
                <span data-row-stalled="1" className="absolute inset-y-0 z-20 ml-1.5 flex items-center gap-1 whitespace-nowrap text-2xs font-black leading-none text-rose-700" style={{ left: `${labelLeft}%` }} title={r.stopWhy}>
                  <span aria-hidden="true" className="inline-block h-3.5 w-1.5 rounded-sm bg-rose-600" />
                  止まる: {r.stopWhy}
                </span>
              ) : hasBar ? (
                <span className="absolute inset-y-0 z-20 ml-1.5 flex items-center whitespace-nowrap text-2xs font-black leading-none text-slate-700 tabular-nums" style={{ left: `${labelLeft}%` }}>
                  {isNum(r.finishMs) ? `${fmtMD(r.finishMs)} ${fmtHM(r.finishMs)} 終` : ''}
                </span>
              ) : null}

              {/* 🚚 入荷の縦線(2026-09-18)。本当の入荷日=青緑の実線／仮の入荷日=橙の点線。もう手元に在るロットは出さない。 */}
              {(() => {
                // 出すか・本当か仮か は 純関数 arrivalLineOf ただ1本(2026-09-19。軸の外・1970年・最終検査の種類 を値で見張っている)。
                const line = arrivalLineOf(r, cols);
                if (!line) return null;
                const aPct = pctOf(line.ms);
                if (aPct == null) return null;
                const real = line.real;
                const tip = arrivalLineTip(line, `${fmtMD(line.ms)} ${fmtHM(line.ms)}`);
                return (
                  <div className={`absolute top-0 bottom-0 z-20 ${real ? 'w-1 rounded-sm bg-teal-600' : 'w-0 border-l-2 border-dashed border-amber-500'}`}
                    data-arrival-line={r.arrivalMs} data-arrival-kind={real ? 'real' : r.arrivalKind}
                    title={tip} style={{ left: `${aPct}%` }} />
                );
              })()}
              {/* 納期線は太く(w-1)赤。判定できない行は灰。 */}
              {duePct != null && duePct >= 0 && duePct <= 100 ? (
                <div className={`absolute top-0 bottom-0 z-20 w-1 rounded-sm ${r.tier <= TIER.LATE ? 'bg-rose-600' : 'bg-slate-400'}`}
                  data-due-line={r.dueMs}
                  style={{ left: `${duePct}%` }} />
              ) : null}
            </div>
          </button>
          {/* 🛠 選んだ行だけ、行の下に操作の帯(2026-09-15)。渡された口だけ出る。 */}
          {on ? <DueRowActions renderWorkRouting={renderWorkRouting} r={r} names={names} onEditLot={onEditLot} onDeleteLot={onDeleteLot} onChangePriority={onChangePriority} onPinWorker={onPinWorker} pinsByLot={pinsByLot} onClose={typeof onSelectLot === 'function' ? () => onSelectLot(null) : null} insetRight={!!actionsInsetRight} /> : null}
          </React.Fragment>
        );
      })}

      {/* 🚨 「下に あと◯件」と書くなら、下に **本当に在る** 形にする(押すと全部出る)。最終検査(2026-09-04)と同じ形。 */}
      {hidden > 0 ? (
        <button type="button" onClick={() => setShowAllRows(true)} data-due-more={hidden}
          className="mt-1 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white py-1.5 text-2xs font-black text-cyan-700 hover:bg-slate-50">
          あと {hidden.toLocaleString('ja-JP')}件を開く（{dueSortHint(sortNow)}。ここから下も同じ並び）
        </button>
      ) : null}
      {/* 🎨 案A: 凡例は末尾に小さく1行(色の点＋短い語)。長い説明は消さず各札の title へ。 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-2 py-1.5 text-2xs font-bold text-slate-500" data-due-legend="1">
        <span className="inline-flex items-center gap-1" title="棒＝手が付く時間（営業日だけ）"><span className="inline-block h-2 w-5 rounded-full bg-cyan-400" />納期の手前</span>
        <span className="inline-flex items-center gap-1" title="納期線を越えた分だけ赤。赤の長さ＝どれだけ遅れるか"><span className="inline-block h-2 w-5 rounded-full bg-rose-500" />すでに過ぎた分</span>
        <span className="inline-flex items-center gap-1" title="この見立てで納期線を越える分（薄い赤の縞）"><span className={`inline-block h-2 w-5 rounded-full ${LATE_TONE.forecast.bar}`} />この先で遅れる分</span>
        <span className="inline-flex items-center gap-1" title="納期が入っていない等で判定していない行の棒"><span className="inline-block h-2 w-5 rounded-full bg-slate-300" />判定できません</span>
        <span className="inline-flex items-center gap-1" title="縦線＝納期"><span className="inline-block h-3.5 w-1 rounded-sm bg-rose-600" />納期</span>
        <span className="inline-flex items-center gap-1" title="縦の実線(青緑)＝登録された入荷日。もう手元に在るロットには出しません" data-arrival-legend="real"><span className="inline-block h-3.5 w-1 rounded-sm bg-teal-600" />入荷</span>
        <span className="inline-flex items-center gap-1" title="縦の点線(橙)＝仮の入荷日。取込が納期から逆算して置いた日か、入荷日が無いので計算が仮に置いた日です" data-arrival-legend="assumed"><span className="inline-block h-3.5 w-0 border-l-2 border-dashed border-amber-500" />入荷（仮）</span>
        <span className="inline-flex items-center gap-1" title="他の仕事を挟んで、このロットに手が付いていない間"><span className="inline-block h-0.5 w-5 rounded-full bg-slate-300" />触らない間</span>
        <span className="inline-flex items-center gap-1" title="手が付いたのに、この期間の中では終わらない行。理由は行の右端に(出来る人が居ない工程／期間の終わり)"><span className="inline-block h-3.5 w-1.5 rounded-sm bg-rose-600" />止まる</span>
        <span className="inline-flex items-center gap-1" title="網掛け＝休み（土日と、登録された工場の休み）。棒は営業日だけに描いています"><span className="inline-block h-3 w-5 rounded border border-slate-200" style={OFF_HATCH} />休み</span>
        <span className="inline-flex items-center gap-1" title="遅れて完了した物は消さない。灰の棒＋赤い +N日"><span className="inline-block h-2 w-5 rounded-full bg-slate-400" />遅れて完了 <span className="font-black text-rose-600">+N日</span></span>
        <span className="ml-auto font-normal text-slate-400">
          {showAllRows && rows.length > maxRows ? <span data-due-all={rows.length}>{rows.length.toLocaleString('ja-JP')}件すべて出しています・</span> : null}
          遅れの棒の長さ＝一番遅れる行を全幅にした比
        </span>
      </div>

      {/* 段ごとの件数。🚨 1つの数に混ぜない。遅れて完了は4つ目の別枠。 */}
      <div className="mt-2 grid grid-cols-4 gap-2">
        {[TIER.PAST, TIER.LATE, TIER.UNKNOWN].map((t) => {
          const n = rows.filter((r) => r.tier === t).length;
          const cls = t === TIER.PAST ? 'border-rose-300 bg-rose-50 text-rose-700'
            : t === TIER.LATE ? LATE_TONE.forecast.chip
              : 'border-slate-300 bg-slate-50 text-slate-600';
          return (
            <div key={t} className={`rounded-lg border-2 px-2 py-1.5 ${cls}`}>
              <div className="text-2xs font-black leading-tight">{TIER_LABEL[t]}</div>
              <div className="text-lg font-black leading-none tabular-nums">{n.toLocaleString('ja-JP')}<span className="ml-0.5 text-2xs font-bold">件</span></div>
            </div>
          );
        })}
        {doneRows ? (
          <div className="rounded-lg border-2 border-slate-300 bg-slate-100 px-2 py-1.5 text-slate-600">
            <div className="text-2xs font-black leading-tight">遅れて完了（消しません）{lateDone.windowText ? `・${lateDone.windowText}` : ''}</div>
            <div className="text-lg font-black leading-none tabular-nums text-rose-600">{doneRows.length.toLocaleString('ja-JP')}<span className="ml-0.5 text-2xs font-bold text-slate-600">件</span></div>
          </div>
        ) : null}
      </div>

      {/* 🚨 決まり10: 遅れて完了した物。灰色の棒（長さ＝遅れた日数）＋赤い +N日。消さない。 */}
      {doneRows && doneRows.length ? (
        <div className="mt-3 border-t border-slate-200 pt-2" data-late-done-rows={doneRows.length}>
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xs font-black text-slate-700">遅れて完了した物（一回納期に遅れた事実は残します）</span>
            <span className="text-2xs text-slate-500">灰色の棒の長さ＝遅れた日数。数え方は納期の分析と同じ（納期の日の終わりを越えて完了した物）。</span>
          </div>
          {doneRows.map((r) => {
            const w = Math.max(2, (Number(r.daysLate) / doneMax) * 60);
            return (
              <div key={r.lotId} data-lot-id={r.lotId}
                className="grid w-full grid-cols-[15rem_6rem_1fr] items-center gap-2 border-b border-slate-100 py-1 text-left">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2">
                  <span className="row-span-2 inline-block h-8 w-8 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />
                  <span className="min-w-0 truncate text-base font-black leading-tight text-slate-600" title={`${r.model}｜${r.tplName || 'テンプレ名なし'}｜指図 ${r.orderNo || '—'}`}>
                    {r.model || '(品目コードなし)'}
                    <span className="text-sm font-bold text-slate-500">{`｜${r.tplName || 'テンプレ名なし'}`}</span>
                  </span>
                  <span className="col-start-2 truncate text-2xs leading-tight text-slate-500 tabular-nums">指図 {r.orderNo || '—'}{isNum(Number(r.quantity)) && Number(r.quantity) > 0 ? ` ×${Number(r.quantity)}` : ''}</span>
                </div>
                <span className="inline-flex items-center justify-self-end text-sm font-black leading-none text-rose-600 tabular-nums">{`+${r.daysLate}日`}</span>
                <div className="relative h-8">
                  <div className="absolute top-2.5 h-3 rounded-full bg-slate-400" style={{ left: 0, width: `${w}%` }}
                    title={`納期 ${fmtMD(r.dueMs)} より ${r.daysLate}日 遅れて ${fmtMD(r.completedMs)} に完了`} />
                  {/* 遅れの日数は左の「遅れ」の列に1つだけ。ここは 納期→完了 の日付の札。 */}
                  <span className="absolute inset-y-0 z-20 ml-1.5 flex items-center whitespace-nowrap text-2xs font-black leading-none text-slate-700 tabular-nums"
                    style={{ left: `${w}%` }}>
                    {`${fmtMD(r.dueMs)}納期→${fmtMD(r.completedMs)}完了`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default DueCalendar;

