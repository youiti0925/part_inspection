// 🗺 P056 製品 src/mapviews/MapViewTimeline.jsx を部品へ写した(画面の文言「型式」を「品目コード」に替えただけ・中身の判定は同じ)。
// =====================================================================================
// 現場マップ 実験ビュー 案5「時間軸レーン盤」 (MapViewTimeline)
// -------------------------------------------------------------------------------------
// ■ 何のビューか (清水さん 2026-08-30「時間軸レーン盤は使えそう。もっと進化できるならして」)
//   横軸 = 今日の時間 (勤務の始業〜終業。休憩は薄く塗る。今の時刻に縦線)
//   🚨横軸は **今日から出さない**。前の日から場内に残っている台があっても軸は伸ばさない。
//     (伸ばすと軸が62日になり、今日ぶんが針の穴になって空っぽの行に見える。2026-08-30 実測)
//     残っている台は左端で折り、「◀前の日から」の印と本当の日付を出す。
//   縦軸 = レーン。**人ごと** と **エリアごと** を切り替えられる (既定は人ごと = 作業者目線)
//   ・進行中のロット … 「実際に始めた時刻 → 終わる見込み」の帯。実績ぶんと見込みぶんを描き分ける
//   ・待ちのロット   … 時間軸の左端の「これから」置き場に積む (時刻を勝手に作らない)
//   ・今日終わった物 … 実開始→実終了の緑の帯 (掴めない = 動かせない事を見た目で示す)
//
// ■ 🚨このビューの一番の目的は「カードを動かせる」こと
//   案4「人がレーン」(MapViewLanes) は見やすいと言われた一方で、カードが動かせないので
//   使えない、という声だった。よってここでは **担当替え・エリア替えを必ず通す**。
//   ・持ち上げ側(マウス): 帯/カードに draggable + dataTransfer 'lotId'
//     (本体 LotCard App.jsx:10292 と同じ鍵の文字列 'lotId' を使う)
//   ・持ち上げ側(指)    : 400ms長押し → バイブ → ゴースト → 落とし先を elementFromPoint で拾う
//     (本体 LotCard App.jsx:10161-10227 と同じ手順。現場はタブレットなので指の道が要る)
//   ・受け側            : レーンの行そのものに data-drop-zone / data-worker-id を付ける
//     (作業予定画面の人ごとの棚 App.jsx:23313 と同じ形)
//   ・保存の道          : **注入された onMoveLot (=本体 handleMoveLot) ただ1本**。
//     新しい保存の道は作らない。呼び方は2通りだけ:
//       人レーンへ落とす → onMoveLot(lotId, 'planned', workerId)   … エリアは据え置き・担当が変わる
//       エリアへ落とす   → onMoveLot(lotId, zoneId)                 … 担当は据え置き・エリアが変わる
//       未割当へ落とす   → onMoveLot(lotId, 'zone_unassigned')      … 担当とエリアが両方外れる(強い)
//     ⚠最後の1つは副作用が強いので、行の見出しにも、掴んで重ねた時の帯にも、はっきり書く。
//
//   ⚠注入 LotCard をそのまま帯に使わない理由: 注入カードは「幅いっぱいの札」の形しか持たず、
//     時間軸の上に置く細長い帯にはならない (variant map-strip でも w-80 固定)。
//     そこで帯は自前で描き、**掴む契約(dataTransfer 'lotId' / data-drop-zone / data-worker-id)
//     だけを本体と1文字も違わない形で写す**。動かせなくなる事だけは起こさない。
//
// ■ props (1個のオブジェクトで受ける。App固有の import は一切しない。他の4本と同じ流儀)
//   {
//     lots, zones, workers, arrivalByLot, settings,
//     onOpenExecution,   // (lot)=>void 帯/カードをタップで作業画面へ (本体と同じ条件で呼ぶ)
//     onMoveLot,         // (lotId, 'planned'|zoneId|'zone_unassigned', workerId?)=>void 【必ず使う】
//     ArrivalTag,        // 注入の到着予定タグ。無ければ自前フォールバック
//     estimateSecOf,     // (lot)=>秒 見込み工数の親玉 (calculateLotEstimatedTime 較正込み)
//     fmtWorkSec,        // (秒)=>'2時間15分'
//     pauseReasonColorOf,// (category)=>{bg,border,text,emoji}
//     finishEtaOf,       // 【任意・今は未注入】(lot)=>{ok,finishAt,reason} 本物の domain/finishEta.js を
//                        //   親が束ねて渡してくれた時だけ使う。無ければ下の「見込みの出し方」に従う。
//   }
//
// ■ 🚨見込みの出し方 (出せない物は正直に「見込みが出せません」と書く。時刻を作らない)
//   帯の右端(終わる見込み)を描いてよいのは、次を全部満たす時だけ:
//     ・実際に始まっている (task の firstStartTime/startTime がある = 実データ)
//     ・いま動いている (processing / reworking)。**止まっている物には終わりの時刻を出さない**
//       (domain/finishEta.js の掟と同じ:「動き出すまで終わりの時刻は出せません」)
//     ・残っている項目がある
//     ・1項目あたりの見込みが出せる … ①この ロットの実測(完了項目の duration 平均) が有ればそれ。
//       無ければ ②estimateSecOf(ロット全体の目標時間) ÷ 全項目数。どちらも無ければ **出さない**。
//   出せない時は帯を伸ばさず、実績ぶんだけ描いて「見込みが出せません(理由)」の印を横に置く。
//   ⚠見込みぶんの帯は斜線で塗る。実測ぶん(べた塗り)と見た目で必ず区別する。
//   ⚠残り項目数には「いま動かしている1項目」も入る = 見込みは少し長めに出る。近似である事を札に書く。
//
// ■ 作業者目線の工夫 (要件6)
//   ①「いま誰が何を」を盤の一番上に大きく出す (探さずに分かる)
//   ② 各レーンの「つぎ」を1件だけ強調 (次にやる物が1つに決まる)
//   ③ 遅れている物だけ赤 = **終業までに終わらない見込みの物だけ**。それ以外は色を足さない
//   ④ 自分の行を上に固定 = 行の📌を押すと一番上に来る (誰が見ているかはアプリが知らないので、
//      名前を当てるのではなく本人に押してもらう。端末に覚えさせない=localStorageに書かない)
//   ⑤ 動いている行だけに絞る札 (タブレットで縦に長くなりすぎない)
//
// ■ 守り
//   ・hooks はコンポーネント先頭に固定。条件付き hooks 無し・早期 return より後ろの hooks 無し
//     (そもそも早期 return をしない)。
//   ・サブコンポーネントはモジュール直下に定義 (描画関数の中で定義しない)。
//   ・localStorage に書かない (3択の記憶は親がやる。この中の切替はその場かぎり)。
//   ・文字は text-2xs (11px) 以上。px 直書きをしない (幅・高さは Tailwind の段か rem)。
// =====================================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Users, MapPin, Truck, Pin, PinOff, Lock, CircleAlert } from 'lucide-react';
import { packTimelineRows, timelineBoardMinWidthRem } from '../domain/timelineLayout.js';
// 🛌 休止中の人はレーンに出さない。ただし作業が残っている間は残す(名前が「不明(…)」に化けるのを防ぐ)。
import { laneWorkersOf, laneNameOf } from '../domain/workerPause.js';

// ---------------------------------------------------------------
// 純関数ヘルパー (App 本体と同じ考え方の読み取り専用レプリカ)
// ---------------------------------------------------------------

// Firestore Timestamp / number / 文字列 どれでも ms に
const toMsAny = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.seconds) return v.seconds * 1000;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
};

const fmtHHMM = (ms) => {
  if (!ms) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 🚨日付をまたぐ時刻は必ず日付を付ける。
//   2026-08-30 実測の欠陥: 前の日に始まった台の実開始が「16:32〜」とだけ出ていた。
//   本当は **2026/8/28 16:32**(2日前)。盤の見出しが「今日の時間」なので、
//   読んだ人は「今日の夕方から始まる」と受け取ってしまう(実際は2日前に始まって今も残っている)。
//   同じ日なら今までどおり HH:MM、違う日なら「8/28 16:32」と月日を足す。
const fmtWhen = (ms, refMs) => {
  if (!ms) return '--:--';
  if (isSameLocalDay(ms, refMs)) return fmtHHMM(ms);
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtHHMM(ms)}`;
};

const fmtHMS = (sec) => {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// fmtWorkSec が注入されなかった時の予備 (「2時間15分」風)
const fallbackFmtWorkSec = (sec) => {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return `${n}秒`;
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  if (h <= 0) return `${m}分`;
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
};

// "HH:MM" → その日の 0:00 からの分 (本体 timeStrToMinutes App.jsx:2278 と同じ)
const timeStrToMin = (str) => {
  if (!str || typeof str !== 'string') return 0;
  const [h, m] = str.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
};

// 勤務時間の既定値。本体 DEFAULT_WORK_SCHEDULE (App.jsx:2261 / src/domain/workClock.js:10) の写し。
// ⚠settings.workSchedule が来たらそれを上に重ねる。残業を軸に入れるのは
//   includeOvertimeInCapacity === true の時だけ (既定は定時まで)。
const DEFAULT_SCHEDULE = {
  dayStart: '08:30',
  dayEnd: '17:00',
  overtimeStart: '17:15',
  overtimeEnd: '19:15',
  breaks: [
    { start: '10:00', end: '10:10', name: '10時休憩' },
    { start: '12:00', end: '12:45', name: '昼休憩' },
    { start: '15:00', end: '15:15', name: '15時休憩' },
    { start: '17:00', end: '17:15', name: '残業前休憩' },
  ],
  includeOvertimeInCapacity: false,
};

const localDayStartMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const isSameLocalDay = (a, b) => a != null && b != null && localDayStartMs(a) === localDayStartMs(b);

// 「完了扱い」の判定 (本体 computeLotProgress と同じ: completed か skipped)
const isDoneStatus = (st) => st === 'completed' || st === 'skipped';
// 「いま動いている」項目 (修正中も動いている)
const isRunningStatus = (st) => st === 'processing' || st === 'reworking';

// ロットの全項目を1つずつ見る。key は `${step.id}-${台}` (古い物は `${工程index}-${台}`) の2系統。
// ⚠lotOnce 工程は「接頭辞で拾う」近似 (本体 computeLotProgress / MapViewLanes と同じ考え方)。
const forEachTask = (lot, fn) => {
  const tasks = (lot && lot.tasks) || {};
  const steps = Array.isArray(lot && lot.steps) ? lot.steps : [];
  const qty = Math.max(1, Number(lot && lot.quantity) || 1);
  steps.forEach((step, sIdx) => {
    if (step && step.lotOnce) {
      const prefix = step.id ? `${step.id}-` : `${sIdx}-`;
      const keys = Object.keys(tasks).filter((k) => k.startsWith(prefix));
      if (keys.length === 0) { fn(null, step); return; }
      keys.forEach((k) => fn(tasks[k], step));
      return;
    }
    for (let u = 0; u < qty; u++) {
      const t = (step && step.id && tasks[`${step.id}-${u}`]) || tasks[`${sIdx}-${u}`] || null;
      fn(t, step);
    }
  });
};

// ロット1件の「実データだけ」の要約。ここで作った数字はすべて記録から来ている。
//   realStartMs / realEndMs … 項目に刻まれた実開始・実終了 (DailyWorkerGantt App.jsx:37611 と同じ拾い方)
//   running / paused        … いま動いているか・止まっているか
//   total / done / remaining… 項目の数
//   doneDurSec / doneCount  … 完了した項目の実測時間 (1項目あたりの実測平均の材料)
//   nowStepTitle            … いま動かしている工程名。無ければ次にやる未完了の工程名
const summarizeLot = (lot, nowMs) => {
  let total = 0, done = 0, doneDurSec = 0, doneCount = 0;
  let realStartMs = null, realEndMs = null;
  let running = false, paused = false;
  let nowStepTitle = '', nextStepTitle = '';
  forEachTask(lot, (t, step) => {
    total++;
    const st = t && t.status;
    if (isDoneStatus(st)) {
      done++;
      const dur = Number(t.duration) || 0;
      if (dur > 0) { doneCount++; doneDurSec += dur; }
    } else if (!nextStepTitle) {
      nextStepTitle = (step && step.title) || '';
    }
    if (isRunningStatus(st)) { running = true; if (!nowStepTitle) nowStepTitle = (step && step.title) || ''; }
    if (st === 'paused') { paused = true; if (!nowStepTitle) nowStepTitle = (step && step.title) || ''; }
    // --- 実時刻 ---
    const s = t && (typeof t.firstStartTime === 'number' ? t.firstStartTime
      : (typeof t.startTime === 'number' ? t.startTime : null));
    if (s == null) return;
    if (realStartMs == null || s < realStartMs) realStartMs = s;
    let e;
    if (isRunningStatus(st)) e = nowMs;                                  // 動いている物は今まで伸ばす
    else if (typeof t.endTime === 'number') e = t.endTime;
    else e = s + (Number(t.duration) || 0) * 1000;
    if (!(e > s)) e = s + Math.max(Number(t.duration) || 0, 1) * 1000;
    if (realEndMs == null || e > realEndMs) realEndMs = e;
  });
  // 項目が1つも組まれていないロット(テンプレ未適用)は、ロットの時計だけを見る
  if (realStartMs == null) {
    const ws = toMsAny(lot && (lot.firstWorkStartTime || lot.workStartTime));
    if (ws) { realStartMs = ws; realEndMs = Math.max(ws, nowMs); }
  }
  return {
    total, done, remaining: Math.max(0, total - done), doneDurSec, doneCount,
    realStartMs, realEndMs,
    running: running || (lot && lot.status === 'processing'),
    paused: !running && (paused || (lot && lot.status === 'paused')),
    completed: !!(lot && (lot.status === 'completed' || lot.location === 'completed')),
    progressPct: total > 0 ? Math.round((done / total) * 100) : 0,
    nowStepTitle: nowStepTitle || nextStepTitle,
  };
};

// 🚨終わる見込み。**出せない時は必ず ok:false と日本語の理由を返し、時刻は作らない**。
//   注入 finishEtaOf (本物の domain/finishEta.js) が有ればそれを最優先で使う。
const finishOf = (lot, sum, nowMs, estSec, finishEtaOf) => {
  if (typeof finishEtaOf === 'function') {
    try {
      const r = finishEtaOf(lot);
      if (r && r.ok && r.finishAt) return { ok: true, endMs: toMsAny(r.finishAt), basis: '見込み(アプリの計算)', approx: false };
      if (r && r.reason) return { ok: false, reason: String(r.reason) };
    } catch { /* 注入側が落ちてもこのビューは落とさない。下の自前判定に降りる */ }
  }
  if (sum.completed) return { ok: false, reason: '終わっています' };
  if (sum.remaining <= 0) return { ok: false, reason: '残っている項目がありません' };
  if (sum.paused) return { ok: false, reason: 'いま止まっています。動き出すまで終わりの時刻は出せません' };
  if (!sum.running) return { ok: false, reason: 'まだ始まっていません' };
  let perSec = 0, basis = '';
  if (sum.doneCount > 0 && sum.doneDurSec > 0) {
    perSec = sum.doneDurSec / sum.doneCount; basis = 'このロットの実測から';
  } else {
    const est = Number(estSec(lot)) || 0;
    if (est > 0 && sum.total > 0) { perSec = est / sum.total; basis = '目標時間から'; }
  }
  if (!(perSec > 0)) return { ok: false, reason: '目標時間も実測も登録されていません' };
  return { ok: true, endMs: nowMs + sum.remaining * perSec * 1000, remainSec: sum.remaining * perSec, basis, approx: true };
};

// 場内で動いているロット (入荷待ちは別棚。完了は「今日終わった物」だけ別に拾う)
const isOnFloorLot = (l) => !!l && l.status !== 'completed' && l.location !== 'completed' && l.location !== 'arrival';

// 📋テンプレ名。従来の現場マップのカードが3行目に太字で出している物(App.jsx:10440)。
// ⚠MapViewLanes は templates を受け取っていないので、ここが引けず **テンプレのID**
//   (📋35b2317867…)が画面に出てしまっている。この盤は App から templates を受け取るので
//   ちゃんと名前を出す。引けない時は「何も出さない」(IDを名前のふりで出さない)。
const templateNameOf = (lot, templatesArr) => {
  if (!lot) return '';
  if (lot.templateName) return lot.templateName;
  const hit = Array.isArray(templatesArr) ? templatesArr.find((t) => t && t.id === lot.templateId) : null;
  return (hit && hit.name) || '';
};

// 停止理由の色の予備 (本体 PAUSE_REASON_COLOR_MAP と同値)
const FALLBACK_PAUSE_COLORS = {
  waiting_lot: { bg: 'bg-amber-100', border: 'border-amber-300', text: 'text-amber-800', emoji: '🟡' },
  waiting_repair: { bg: 'bg-orange-100', border: 'border-orange-300', text: 'text-orange-800', emoji: '🟠' },
  paused: { bg: 'bg-rose-100', border: 'border-rose-300', text: 'text-rose-800', emoji: '🔴' },
  waiting_parts: { bg: 'bg-purple-100', border: 'border-purple-300', text: 'text-purple-800', emoji: '🟣' },
  waiting_decision: { bg: 'bg-blue-100', border: 'border-blue-300', text: 'text-blue-800', emoji: '🔵' },
};
const FALLBACK_PAUSE_DEFAULT = { bg: 'bg-slate-100', border: 'border-slate-300', text: 'text-slate-700', emoji: '⏸' };
const fallbackPauseColorOf = (c) => FALLBACK_PAUSE_COLORS[c] || FALLBACK_PAUSE_DEFAULT;

// 到着予定タグの予備
const FallbackArrivalTag = ({ arrival }) => {
  if (!arrival || !arrival.time) return null;
  const splits = Array.isArray(arrival.splits) ? arrival.splits : [];
  const multi = splits.length > 1;
  return (
    <span className={`inline-flex items-center gap-0.5 border rounded px-1 text-2xs font-bold whitespace-nowrap ${multi ? 'bg-yellow-100 border-yellow-400 text-yellow-900' : 'bg-teal-50 border-teal-300 text-teal-800'}`}>
      🚚{arrival.date ? `${arrival.date} ` : ''}{arrival.time}{multi ? ` 分納${splits.length}便` : ''}
    </span>
  );
};

// 帯の1段の高さ / 「これから」置き場の幅 (px 直書きを避けて rem で持つ)
const BAR_ROW_REM = 3.2;
// 帯の最低幅と段積み計算は domain/timelineLayout.js の同じ定数から出す。
// CSSだけ11rem、計算だけ11%のように別管理すると、計算上は空いていても画面では重なる。

// ---------------------------------------------------------------
// サブコンポーネント (モジュール直下に定義)
// ---------------------------------------------------------------

// 作業者/エリアの名札チップ
const StateChip = ({ label, mode }) => {
  const base = 'inline-flex items-center gap-0.5 border rounded-full px-1.5 text-2xs font-bold whitespace-nowrap';
  if (mode === 'processing') {
    return <span className={`${base} bg-blue-600 border-blue-700 text-white mvt-anim`} style={{ animation: 'mvtBlink 1s ease-in-out infinite' }}>{label}</span>;
  }
  if (mode === 'paused') return <span className={`${base} bg-amber-100 border-amber-400 text-amber-800`}>⏸{label}</span>;
  return <span className={`${base} bg-slate-100 border-slate-300 text-slate-600`}>{label}</span>;
};

// 「これから」置き場に積む待ちカード (掴める)
const QueueCard = ({ lot, sum, zone, arrival, isNext, carried, nowMs, tplName, estSec, fmtSec, pauseColorOf, ArrivalTag, dragProps, onOpen, dragging }) => {
  const Tag = typeof ArrivalTag === 'function' ? ArrivalTag : FallbackArrivalTag;
  const est = Number(estSec(lot)) || 0;
  // 🚨止まっている理由は従来の現場マップのカードに大きく出ている物。待ちの札にも必ず出す
  //   (前の日から残っている台はこの札に移したので、ここに無いと理由が画面から消えてしまう)。
  const pause = lot.pauseReason && lot.pauseReason.category
    ? ((typeof pauseColorOf === 'function' && pauseColorOf(lot.pauseReason.category)) || FALLBACK_PAUSE_DEFAULT)
    : null;
  return (
    <div
      data-lot-id={lot.id}
      {...dragProps}
      onClick={() => onOpen(lot)}
      title={`${lot.orderNo || ''} ${lot.model || ''} — ドラッグで担当やエリアを変えられます`}
      className={`w-full min-w-0 overflow-hidden rounded-lg border-2 bg-white px-1.5 py-1 cursor-grab active:cursor-grabbing select-none
        ${isNext ? 'border-blue-500 ring-2 ring-blue-300' : 'border-slate-300'} ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-1">
        {isNext && <span className="rounded bg-blue-600 px-1 text-2xs font-black text-white">つぎ</span>}
        <span className={`rounded border px-1 text-2xs font-bold text-slate-700 ${(zone && zone.color) || 'bg-slate-100 border-slate-300'}`}>{(zone && zone.name) || '未該当'}</span>
        {pause && (
          <span className={`${pause.bg} ${pause.border} ${pause.text} whitespace-nowrap rounded border px-1 text-2xs font-black`}>
            {pause.emoji}{lot.pauseReason.label || lot.pauseReason.category}
          </span>
        )}
      </div>
      {/* 🚨前の日から残っている台。**今日は1秒も動いていない**ので時間軸には置かない。
            いつ始めた物なのかを日付付きで必ず出す(「16:32〜」だけだと今日の夕方に読める)。 */}
      {carried && (
        <div className="truncate rounded border border-violet-400 bg-violet-100 px-1 text-2xs font-black text-violet-800"
          title={`この台は ${fmtWhen(sum.realStartMs, nowMs)} に始まって、まだ終わっていません。今日はまだ動いていないので時間軸には置いていません`}>
          ◀前の日から({fmtWhen(sum.realStartMs, nowMs)}〜)
        </div>
      )}
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-2xs font-bold text-slate-500">指図: {lot.orderNo || '—'}</span>
        <span className="whitespace-nowrap text-xs font-black text-blue-600">{lot.quantity || 1}<span className="text-2xs font-normal text-slate-500">台</span></span>
      </div>
      <div className="truncate text-xs font-black text-slate-800" title={lot.model || ''}>{lot.model || '(品目コードなし)'}</div>
      <div className="truncate text-2xs text-slate-600">🔧{sum.nowStepTitle || '工程なし'}</div>
      {/* 従来の現場マップのカードが太字で出しているテンプレ名。同じだけ出す */}
      {tplName && <div className="truncate text-2xs font-bold text-indigo-700" title={tplName}>📋{tplName}</div>}
      {/* 従来の現場マップのカードに出ている進み具合(9/10・90%)を、待ちの札にも同じだけ出す */}
      <div className="truncate text-2xs text-slate-500">
        <span className="font-bold text-slate-700">{sum.done}/{sum.total}<span className="ml-0.5 text-blue-700">{sum.progressPct}%</span></span>
        <span className="ml-1">残り{sum.remaining}項目{est > 0 ? ` / 見込み${fmtSec(est)}` : ' / 見込みが出せません'}</span>
      </div>
      {arrival && arrival.time ? <div className="mt-0.5"><Tag arrival={arrival} compact /></div> : null}
    </div>
  );
};

// 時間軸に置く帯 (進行中 / 停止中 / 今日終わった物)
const TimeBar = ({
  lot, sum, eta, zone, workerName, late, locked, carried, tplName, dragProps, onOpen, dragging,
  leftPct, measuredPct, forecastPct, fmtSec, pauseColorOf, nowMs, showWorker,
}) => {
  const pause = lot.pauseReason && lot.pauseReason.category ? (pauseColorOf(lot.pauseReason.category) || FALLBACK_PAUSE_DEFAULT) : null;
  const startedMs = toMsAny(lot.workStartTime);
  // 🚨2026-08-30 実測の直し: 前は lot.totalWorkTime だけを見ていたので、
  //   9項目まで終わって90%まで進んでいる台が **0:00:00** と出ていた
  //   (まとめて開始などで totalWorkTime に積まれない作りがある)。
  //   本体のロット一覧(App.jsx:40151)と同じ順で、**完了項目の実測の合計を先に**見る。
  const recordedMs = sum.doneDurSec > 0 ? sum.doneDurSec * 1000 : (lot.totalWorkTime || 0);
  const elapsedMs = recordedMs + (lot.status === 'processing' && startedMs ? Math.max(0, nowMs - startedMs) : 0);
  // 実測ぶんと見込みぶんの割り振り。両方0(前の日で終わっている帯)は実測として塗る
  const spanPct = measuredPct + forecastPct;
  const solidW = spanPct > 0 ? (measuredPct / spanPct) * 100 : 100;
  const hatchW = spanPct > 0 ? (forecastPct / spanPct) * 100 : 0;
  const tone = locked ? 'border-emerald-400 bg-emerald-50'
    : late ? 'border-rose-500 bg-rose-50'
    : sum.paused ? 'border-amber-500 bg-amber-50'
    : sum.running ? 'border-blue-600 bg-blue-50'
    : 'border-slate-300 bg-white';
  const cardTitle = [
    `品目コード: ${lot.model || '(品目コードなし)'} ${lot.quantity || 1}台`,
    `指図: ${lot.orderNo || '—'}`,
    `工程: ${sum.nowStepTitle || '工程なし'}`,
    `担当: ${workerName || '未割当'}`,
    `エリア: ${(zone && zone.name) || '未該当'}`,
    tplName ? `テンプレ: ${tplName}` : '',
    `進捗: ${sum.done}/${sum.total} (${sum.progressPct}%)`,
    // 2026-09-02 取り込み: Codex の札は経過時間を面に出さない。2026-08-30 の「0:00:00 と出ていた」直し(上の recordedMs)を
    //   消さず、札の説明(title)へ畳む。消すのではなく置き場所を変えただけ。
    `経過: ${fmtHMS(elapsedMs / 1000)}`,
    locked ? '完了済み・移動できません' : 'クリックで詳細／ドラッグで担当やエリアを変更',
  ].filter(Boolean).join('\n');
  return (
    <div
      className="absolute flex items-stretch"
      style={{ left: `${leftPct}%`, width: `${measuredPct + forecastPct}%`, minWidth: '11rem' }}
    >
      {/* 実測ぶん(べた塗り) + 見込みぶん(斜線) を背景の帯として敷く */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex w-full overflow-hidden rounded-lg">
        <div
          className={`h-full ${locked ? 'bg-emerald-200' : sum.paused ? 'bg-amber-200' : late ? 'bg-rose-200' : 'bg-blue-200'}`}
          style={{ width: `${solidW}%` }}
          title="実際に記録された時間"
        />
        {hatchW > 0 && (
          <div
            className="mvt-forecast h-full"
            style={{ width: `${hatchW}%` }}
            title="ここから先は見込み(実測ではありません)"
          />
        )}
      </div>
      <div
        data-lot-id={lot.id}
        {...dragProps}
        onClick={() => { if (!locked) onOpen(lot); }}
        title={cardTitle}
        aria-label={cardTitle}
        className={`relative z-10 flex min-w-0 flex-1 flex-col justify-center rounded-lg border-2 px-1.5 py-0.5 shadow-sm select-none
          ${tone} ${locked ? 'cursor-not-allowed opacity-90' : 'cursor-grab active:cursor-grabbing'} ${dragging ? 'opacity-40' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {locked && <Lock className="h-3 w-3 shrink-0 text-emerald-700" />}
          {late && <span className="shrink-0 rounded bg-rose-600 px-1 text-2xs font-black text-white">終業超え</span>}
          <span className="truncate text-sm font-black text-slate-900" title={cardTitle}>{lot.model || '(品目コードなし)'}</span>
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs font-black text-blue-700">
            {lot.quantity || 1}<span className="text-2xs font-normal text-slate-500">台</span>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">🔧次: {sum.nowStepTitle || '工程なし'}</span>
          {showWorker && <span className="shrink-0 truncate text-2xs text-slate-600">👤{workerName || '未割当'}</span>}
          {pause && (
            <span className={`${pause.bg} ${pause.border} ${pause.text} shrink-0 whitespace-nowrap rounded border px-1 text-2xs font-black`}>
              {pause.emoji}{lot.pauseReason.label || lot.pauseReason.category}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden text-2xs">
          <span className="min-w-0 flex-1 truncate font-bold text-slate-700">
            {locked
              ? `${fmtWhen(sum.realStartMs, nowMs)}〜${fmtWhen(sum.realEndMs, nowMs)} 完了`
              : eta.ok
                ? `〜${fmtWhen(eta.endMs, nowMs)}見込み`
                : '終了見込みなし'}
          </span>
          <span className="shrink-0 whitespace-nowrap text-slate-600" title={`終わった項目 ${sum.done} / 全部で ${sum.total}`}>
            {sum.done}/{sum.total}
          </span>
          {carried && <span className="shrink-0 rounded border border-violet-400 bg-violet-100 px-1 font-black text-violet-800">前日〜</span>}
        </div>
      </div>
      {/* 🚨見込みが出せない物は帯を伸ばさず、この印を帯の右に置く。
          ⚠絶対位置(left-full)にする。帯の中に並べると**カードの文字を押し潰して読めなくなる**
            (実測: 短い帯で「D.. 🔧.. 👤片山..」まで縮んだ)。 */}
      {!locked && !eta.ok && (
        <span
          className="absolute left-full top-1/2 z-10 ml-1 flex -translate-y-1/2 items-center gap-0.5 whitespace-nowrap rounded border-2 border-slate-400 bg-white px-1 text-2xs font-bold text-slate-700"
          title={`終わる時刻は出せません: ${eta.reason}`}
        >
          <CircleAlert className="h-3 w-3 text-slate-500" />見込みが出せません
        </span>
      )}
      {eta.ok && eta.approx && eta.remainSec > 0 && (
        <span className="absolute left-full top-1/2 z-10 ml-1 hidden -translate-y-1/2 whitespace-nowrap rounded border border-slate-300 bg-white/90 px-1 text-2xs text-slate-500 xl:block"
          title={`${eta.basis}出した見込みです(実測ではありません)。いま動かしている1項目も残りに数えているので、少し長めに出ます`}>
          あと{fmtSec(eta.remainSec)}({eta.basis})
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------
// 本体
// ---------------------------------------------------------------
export default function MapViewTimeline(props) {
  const {
    lots, zones, workers, arrivalByLot, settings, templates,
    onOpenExecution, onMoveLot, ArrivalTag, estimateSecOf, fmtWorkSec, pauseReasonColorOf, finishEtaOf,
  } = props || {};

  // ⚠hooks はここに全部。条件付き無し・early return より後ろ無し (このビューは early return をしない)。
  const [laneMode, setLaneMode] = useState('worker');   // 'worker'(既定=作業者目線) | 'zone'
  const [pinnedLaneId, setPinnedLaneId] = useState(null); // 📌自分の行を上に固定 (その場かぎり)
  const [onlyActive, setOnlyActive] = useState(false);    // 動いている行だけに絞る
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dragLotId, setDragLotId] = useState(null);       // 掴んでいるロット (本体 draggedLotId と同じ役)
  const [dropTarget, setDropTarget] = useState(null);     // 重ねている行のキー
  const rootRef = useRef(null);
  const touchRef = useRef({ timer: null, dragging: false, ghost: null, startX: 0, startY: 0 });
  const boardRef = useRef(null);      // 横スクロールする盤の入れ物
  const nowPctRef = useRef(0);        // 「いま」の縦線が軸の何%の所か (描画のたびに入れ直す)
  const didCenterRef = useRef(false); // 最初の1回だけ「いま」に寄せる (以後は人のスクロールを邪魔しない)

  // 「いま」を画面に入れる。⚠実データが始業より前から有ると軸が左へ伸びるので、
  //   開いた時に「いま」が画面の外だと使えない。開いた直後に1回だけ寄せる。
  const scrollToNow = () => {
    const el = boardRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return false;
    // ⚠貼り付いている2列(見出し+これから)は常に左を覆っているので、
    //   その幅を除いた「本当に見えている場所」で位置を決める。
    //   ⚠nowPct は**時間軸の中**の割合なので、盤全体の幅で掛けると必ずズレる。
    let sticky = 0;
    el.querySelectorAll('[data-sticky-col]').forEach((c) => { sticky += c.getBoundingClientRect().width; });
    const timeW = Math.max(1, el.scrollWidth - sticky);
    const nowX = sticky + (nowPctRef.current / 100) * timeW;
    const visible = Math.max(160, el.clientWidth - sticky);
    el.scrollLeft = Math.max(0, nowX - sticky - visible * 0.3);
    return true;
  };
  useEffect(() => {
    if (didCenterRef.current) return;
    if (scrollToNow()) didCenterRef.current = true;
  });

  // 進行中の帯を伸ばす為の時計。5秒毎 (1秒だと枚数×再描画が重い — 本体 LotCard と同じ理由)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  // 指を離さずに画面が消えた時にゴーストが残らないようにする
  useEffect(() => () => {
    const t = touchRef.current;
    if (t.timer) clearTimeout(t.timer);
    if (t.ghost && t.ghost.remove) t.ghost.remove();
  }, []);

  // ---- 入力の防御 (欠けていても白画面にしない) ----
  const lotsArr = Array.isArray(lots) ? lots : [];
  const workersArr = Array.isArray(workers) ? workers : [];
  const arrivals = arrivalByLot && typeof arrivalByLot === 'object' ? arrivalByLot : {};
  const openExec = typeof onOpenExecution === 'function' ? onOpenExecution : () => {};
  const estSec = typeof estimateSecOf === 'function' ? (l) => (Number(estimateSecOf(l)) || 0) : () => 0;
  const fmtSec = typeof fmtWorkSec === 'function' ? fmtWorkSec : fallbackFmtWorkSec;
  const pauseColorOf = typeof pauseReasonColorOf === 'function' ? pauseReasonColorOf : fallbackPauseColorOf;
  const moveLot = typeof onMoveLot === 'function' ? onMoveLot : null; // 🚨保存の道はこれ1本だけ
  // 📋テンプレ名の引き先。App は templates を別のpropで渡してくる(設定の中には入っていない)
  const templatesArr = Array.isArray(templates) ? templates
    : (Array.isArray(settings && settings.templates) ? settings.templates : []);
  const tplNameOf = (l) => templateNameOf(l, templatesArr);

  // ゾーン一覧。未該当が無ければ補う (本体 ensureUnassignedZone と同じ発想)
  const zonesArr = Array.isArray(zones) ? zones.slice() : [];
  if (!zonesArr.some((z) => z && (z.isUnassigned || z.id === 'zone_unassigned'))) {
    zonesArr.push({ id: 'zone_unassigned', name: '未該当', color: 'bg-slate-100 border-slate-300', isUnassigned: true });
  }
  const unassignedZone = zonesArr.find((z) => z && (z.isUnassigned || z.id === 'zone_unassigned')) || null;
  const zoneOf = (l) => zonesArr.find((z) => z && z.id === l.mapZoneId) || unassignedZone;

  // ---- 勤務時間から横軸の骨を作る ----
  const sch = { ...DEFAULT_SCHEDULE, ...((settings && settings.workSchedule) || {}) };
  const dayBaseMs = localDayStartMs(nowMs);
  const bizStartMin = timeStrToMin(sch.dayStart);
  const bizEndMin = (sch.includeOvertimeInCapacity && sch.overtimeEnd)
    ? timeStrToMin(sch.overtimeEnd)
    : timeStrToMin(sch.dayEnd);
  const bizStartMs = dayBaseMs + bizStartMin * 60000;
  const bizEndMs = dayBaseMs + Math.max(bizEndMin, bizStartMin + 60) * 60000;

  // ---- 今日の盤に載せるロットを仕分ける ----
  //   場内のロット + 「今日終わった物」(実終了が今日のロット)。入荷待ちは下の棚だけに出す。
  const boardLots = useMemo(() => {
    const out = [];
    // ⚠ここで配列の防御をやり直す (外の lotsArr を使うと毎レンダー別物になり useMemo が効かない)
    (Array.isArray(lots) ? lots : []).forEach((l) => {
      if (!l) return;
      if (isOnFloorLot(l)) { out.push(l); return; }
      // 今日終わった物だけ、緑の帯として盤に残す (今日やった分が見える)。動かせない。
      if (l.status === 'completed' || l.location === 'completed') {
        const endMs = toMsAny(l.completedAt);
        if (endMs && isSameLocalDay(endMs, nowMs)) out.push(l);
      }
    });
    return out;
  }, [lots, nowMs]);

  // ロットごとの要約は1回だけ作って使い回す (帯・置き場・見出しで3回計算しない)
  const infoById = useMemo(() => {
    const m = new Map();
    boardLots.forEach((l) => {
      const sum = summarizeLot(l, nowMs);
      const eta = finishOf(l, sum, nowMs, estSec, finishEtaOf);
      // 🚨遅れ = 「終業までに終わらない見込み」だけを赤にする。それ以外に赤を足さない。
      const late = !sum.completed && eta.ok && eta.endMs > bizEndMs;
      m.set(l.id, { sum, eta, late });
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardLots, nowMs, bizEndMs]);

  const infoOf = (l) => infoById.get(l.id) || { sum: summarizeLot(l, nowMs), eta: { ok: false, reason: '' }, late: false };

  // ---- 横軸の範囲 = 勤務時間。ただし **今日の中で** 実データがはみ出す時だけ広げる ----
  //   (広げないと、始業前に始めた物・終業を越えた物が黙って消える)
  //
  // 🚨🚨 2026-08-30 実測で見つけた欠陥の直し。
  //   前は「実開始が軸より前なら軸をそこまで伸ばす」だけで、**今日という上限と比べていなかった**。
  //   現場には前の日から残っている台がある(実測: 6/29に始まって今も場内に居る台があった)。
  //   その1台だけで軸が **2026/6/29 16:45〜2026/8/30 17:00 = 62日** に伸び、
  //     ・盤の横幅 158,711px・1時間の目盛りが 1,489本・divが 9,083個
  //     ・今日ぶんは軸の 0.36% = 針の穴。尾田さんの3台は画面の外(-4,187〜-11,750px)に飛び、
  //       **「3件」と書いてある行が空っぽに見えていた**
  //     ・5秒ごとの時計の更新で毎回 740〜780ms 画面が固まる
  //   見出しには「横=今日の時間」と書いてあるのに中身は62日だった。
  //   → **軸は今日から出さない**。前の日から続いている台は軸を伸ばさず、左端から描いて
  //     「◀前の日から」の印と本当の日付を出す(時刻を作らない・消しもしない)。
  const todayStartMs = dayBaseMs;
  const todayEndMs = dayBaseMs + 24 * 3600000;
  let axisStartMs = bizStartMs;
  let axisEndMs = bizEndMs;
  boardLots.forEach((l) => {
    const { sum, eta } = infoOf(l);
    // ⚠今日より前の時刻では軸を伸ばさない(伸ばすと今日が針の穴になる)
    if (sum.realStartMs && sum.realStartMs >= todayStartMs && sum.realStartMs < axisStartMs) axisStartMs = sum.realStartMs;
    if (sum.realEndMs && sum.realEndMs <= todayEndMs && sum.realEndMs > axisEndMs) axisEndMs = sum.realEndMs;
    // ⚠見込みが日をまたぐ物でも軸は今日で止める。はみ出す事は赤い札(今日中に終わりません)で伝える
    if (eta.ok && eta.endMs <= todayEndMs && eta.endMs > axisEndMs) axisEndMs = eta.endMs;
  });
  if (nowMs > axisEndMs) axisEndMs = nowMs;
  if (nowMs < axisStartMs) axisStartMs = nowMs;
  // 念のための締め (どの道を通っても今日から出さない)
  if (axisStartMs < todayStartMs) axisStartMs = todayStartMs;
  if (axisEndMs > todayEndMs) axisEndMs = todayEndMs;
  // 15分単位に丸める (目盛りが半端にならない)
  axisStartMs = dayBaseMs + Math.floor((axisStartMs - dayBaseMs) / 900000) * 900000;
  axisEndMs = dayBaseMs + Math.ceil((axisEndMs - dayBaseMs) / 900000) * 900000;
  const axisSpanMs = Math.max(axisEndMs - axisStartMs, 3600000);
  const pctOf = (ms) => ((ms - axisStartMs) / axisSpanMs) * 100;
  const clampPct = (v) => Math.min(100, Math.max(0, v));
  nowPctRef.current = clampPct(pctOf(nowMs)); // 「いまへ」ボタンと初回の寄せが読む

  // 目盛り (30分刻み。長い日は60分刻み)
  const tickStepMin = axisSpanMs > 8 * 3600000 ? 60 : 30;
  const ticks = [];
  for (let ms = dayBaseMs + Math.ceil((axisStartMs - dayBaseMs) / (tickStepMin * 60000)) * tickStepMin * 60000; ms <= axisEndMs; ms += tickStepMin * 60000) {
    ticks.push(ms);
  }
  // 休憩帯 (勤務マスタの通り。薄く塗る)
  const breakBands = (Array.isArray(sch.breaks) ? sch.breaks : []).map((b) => ({
    name: b.name || '休憩',
    s: dayBaseMs + timeStrToMin(b.start) * 60000,
    e: dayBaseMs + timeStrToMin(b.end) * 60000,
  })).filter((b) => b.e > axisStartMs && b.s < axisEndMs);

  // ---- 掴む契約 (🚨本体 LotCard と1文字も違わない形で写す) ----
  // マウス: dataTransfer に 'lotId' を積む
  const mouseDragProps = (lot, locked) => (locked ? {} : {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData('lotId', lot.id);
      e.dataTransfer.effectAllowed = 'move';
      setDragLotId(lot.id);
      e.stopPropagation();
    },
    onDragEnd: () => { setDragLotId(null); setDropTarget(null); },
  });
  // 指: 400ms長押し → ゴースト → [data-drop-zone] を光らせる → 指の下の行へ落とす
  //   ⚠探すのはこの盤の中の行だけ (rootRef の中)。画面の他所の受け皿へは飛ばさない。
  const dropZonesInBoard = () => {
    const root = rootRef.current;
    return root ? Array.from(root.querySelectorAll('[data-drop-zone]')) : [];
  };
  const touchDragProps = (lot, locked) => (locked ? {} : {
    style: { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', touchAction: 'auto' },
    onTouchStart: (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      const t = touchRef.current;
      t.startX = touch.clientX; t.startY = touch.clientY; t.dragging = false;
      t.timer = setTimeout(() => {
        t.dragging = true;
        try { if (navigator.vibrate) navigator.vibrate(50); } catch { /* 端末が対応していないだけ。触らない */ }
        setDragLotId(lot.id);
        // ⚠innerHTML を使わない: 指図番号・型式は自由入力なのでタグがそのまま実行されてしまう
        const ghost = document.createElement('div');
        const l1 = document.createElement('div');
        l1.style.cssText = 'font-weight:bold;font-size:0.875rem';
        l1.textContent = String(lot.orderNo || '');
        const l2 = document.createElement('div');
        l2.style.cssText = 'font-size:0.75rem';
        l2.textContent = String(lot.model || '');
        ghost.append(l1, l2);
        ghost.style.cssText = `position:fixed;z-index:9999;pointer-events:none;background:#fff;border:2px solid #3b82f6;border-radius:0.75rem;padding:0.5rem 0.75rem;box-shadow:0 8px 24px rgba(0,0,0,0.3);opacity:0.9;transform:translate(-50%,-50%);left:${touch.clientX}px;top:${touch.clientY}px;min-width:5rem;text-align:center;`;
        document.body.appendChild(ghost);
        t.ghost = ghost;
        dropZonesInBoard().forEach((el) => { el.style.outline = '3px dashed #3b82f6'; el.style.outlineOffset = '-3px'; });
      }, 400);
    },
    onTouchMove: (e) => {
      const t = touchRef.current;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - t.startX), dy = Math.abs(touch.clientY - t.startY);
      // 指を滑らせただけ = 横スクロールの操作。長押しが立つ前なら掴まない
      if (!t.dragging && (dx > 10 || dy > 10)) { clearTimeout(t.timer); t.timer = null; return; }
      if (!t.dragging) return;
      e.preventDefault();
      if (t.ghost) { t.ghost.style.left = `${touch.clientX}px`; t.ghost.style.top = `${touch.clientY}px`; }
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      dropZonesInBoard().forEach((z) => { z.style.background = ''; });
      const zone = el && el.closest ? el.closest('[data-drop-zone]') : null;
      if (zone) zone.style.background = 'rgba(59,130,246,0.15)';
      setDropTarget(zone ? zone.getAttribute('data-lane-key') : null);
    },
    onTouchEnd: (e) => {
      const t = touchRef.current;
      if (t.timer) { clearTimeout(t.timer); t.timer = null; }
      if (t.ghost) { t.ghost.remove(); t.ghost = null; }
      dropZonesInBoard().forEach((el) => { el.style.outline = ''; el.style.outlineOffset = ''; el.style.background = ''; });
      setDropTarget(null);
      if (!t.dragging) return;
      t.dragging = false;
      setDragLotId(null);
      const touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const zone = el && el.closest ? el.closest('[data-drop-zone]') : null;
      if (!zone || !moveLot) return;
      const zoneId = zone.getAttribute('data-drop-zone');
      const workerId = zone.getAttribute('data-worker-id') || null;
      // 🚨保存は注入された onMoveLot(=本体 handleMoveLot) 1本。呼び方は本体の作法どおり。
      if (zoneId === 'planned') moveLot(lot.id, 'planned', workerId);
      else moveLot(lot.id, zoneId);
    },
    onTouchCancel: () => {
      const t = touchRef.current;
      if (t.timer) { clearTimeout(t.timer); t.timer = null; }
      if (t.ghost) { t.ghost.remove(); t.ghost = null; }
      dropZonesInBoard().forEach((el) => { el.style.outline = ''; el.style.outlineOffset = ''; el.style.background = ''; });
      t.dragging = false;
      setDragLotId(null);
      setDropTarget(null);
    },
  });
  const dragPropsFor = (lot, locked) => ({ ...mouseDragProps(lot, locked), ...touchDragProps(lot, locked) });

  // 行(レーン)が受ける側。マウスの落とし込み。
  const laneDropProps = (laneKey, dropZoneId, workerId) => ({
    'data-drop-zone': dropZoneId,
    'data-lane-key': laneKey,
    ...(workerId ? { 'data-worker-id': workerId } : {}),
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(laneKey); },
    onDragLeave: () => setDropTarget((cur) => (cur === laneKey ? null : cur)),
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation();
      setDropTarget(null); setDragLotId(null);
      const id = e.dataTransfer.getData('lotId');
      if (!id || !moveLot) return;
      if (dropZoneId === 'planned') moveLot(id, 'planned', workerId);
      else moveLot(id, dropZoneId);
    },
  });

  // ---- レーンを組み立てる ----
  //   人ごと: 作業者 + 担当が不明IDのロットの救済レーン + 未割当レーン
  //   エリアごと: ゾーン
  // 🚨 knownWorkerIds は **全員** で作る(休止中も含む)。ここを絞ると休止した人のロットが
  //   下の救済レーン「不明(a1b2c3)」へ落ちて、名前が画面から消える。
  const knownWorkerIds = new Set(workersArr.map((w) => w && w.id));
  const strayIds = [...new Set(boardLots.map((l) => l.workerId).filter((id) => id && !knownWorkerIds.has(id)))];
  const workerLanes = [
    // 🛌 レーンに出すのは在籍中の人。休止中でも **まだ盤にロットが残っている人は残す**。
    ...laneWorkersOf(workersArr, boardLots, { isOpen: () => true }).map((w) => ({
      key: `w-${w.id}`, id: w.id, name: `${laneNameOf(w, w.name || '(名前なし)')}${w.trainee ? '🎓' : ''}`,
      dropZoneId: 'planned', workerId: w.id, kind: 'worker',
      lots: boardLots.filter((l) => l.workerId === w.id),
    })),
    ...strayIds.map((id) => ({
      key: `w-${id}`, id, name: `不明(${String(id).slice(0, 6)})`,
      dropZoneId: 'planned', workerId: id, kind: 'worker',
      lots: boardLots.filter((l) => l.workerId === id),
    })),
    {
      key: 'w-none', id: 'none', name: '未割当',
      // ⚠ここへ落とすと担当もエリアも外れる (本体 handleMoveLot の zone_unassigned 分岐)。見出しに明記する。
      dropZoneId: 'zone_unassigned', workerId: null, kind: 'unassigned',
      lots: boardLots.filter((l) => !l.workerId),
    },
  ];
  const zoneLanes = zonesArr.map((z) => ({
    key: `z-${z.id}`, id: z.id, name: z.name || '(名前なし)', zone: z,
    dropZoneId: z.id, workerId: null, kind: 'zone',
    lots: boardLots.filter((l) => (zoneOf(l) || {}).id === z.id),
  }));
  let lanes = laneMode === 'zone' ? zoneLanes : workerLanes;

  // 行ごとの状態と並び順 (作業者目線: 動いている行を上に。📌は最優先)
  lanes = lanes.map((ln) => {
    const running = ln.lots.some((l) => infoOf(l).sum.running);
    const paused = !running && ln.lots.some((l) => infoOf(l).sum.paused);
    const late = ln.lots.some((l) => infoOf(l).late);
    const openLots = ln.lots.filter((l) => !infoOf(l).sum.completed);
    const planSec = openLots.reduce((n, l) => n + estSec(l), 0);
    return { ...ln, running, paused, late, openCount: openLots.length, planSec };
  });
  if (onlyActive) lanes = lanes.filter((ln) => ln.running || ln.paused || ln.openCount > 0 || ln.key === pinnedLaneId);
  const laneRank = (ln) => (ln.key === pinnedLaneId ? 0 : ln.running ? 1 : ln.paused ? 2 : ln.openCount > 0 ? 3 : 4);
  lanes = lanes.slice().sort((a, b) => laneRank(a) - laneRank(b));

  // ---- 人ごとの「いま／つぎ」(盤の一番上・1人1件だけ) ----
  // 大量の型式カードを読ませず、まず誰が何をするかを決められる入口にする。
  // 「つぎ」は各レーンと同じく、現在の担当順の先頭。新しい優先順位はここで発明しない。
  const actionRows = workerLanes
    .filter((lane) => lane.kind === 'worker')
    .map((lane) => {
      const openLots = lane.lots.filter((lot) => !infoOf(lot).sum.completed);
      const runningLots = openLots.filter((lot) => infoOf(lot).sum.running);
      const lot = runningLots[0] || openLots[0] || null;
      if (!lot) return null;
      return {
        lot,
        name: lane.name,
        info: infoOf(lot),
        isRunning: runningLots.length > 0,
        moreCount: Math.max(0, openLots.length - 1),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || (a.name || '').localeCompare(b.name || ''));

  // ---- 🚚到着予定の棚 (見るだけ。ここへは落とさない) ----
  const arrivalRows = lotsArr
    .filter((l) => l && l.status !== 'completed' && l.location !== 'completed')
    .map((l) => ({ lot: l, arrival: arrivals[l.id] }))
    .filter((r) => r.arrival && r.arrival.time)
    .sort((a, b) => `${a.arrival.date || ''} ${a.arrival.time || ''}`.localeCompare(`${b.arrival.date || ''} ${b.arrival.time || ''}`));
  const TagComp = typeof ArrivalTag === 'function' ? ArrivalTag : FallbackArrivalTag;

  // 1行ぶんの描画 (map の中で呼ぶ通常関数。コンポーネントとして定義しない)
  const renderLane = (ln) => {
    // 帯にできる物 (実開始がある) と 「これから」置き場に積む物 に分ける
    const bars = [];
    const queue = [];
    ln.lots.forEach((l) => {
      const { sum, eta, late } = infoOf(l);
      // 🚨「今日さわった記録があるか」。前の日に止まったままの台は、今日の時間軸に置ける物が
      //   何も無い(今日は1秒も動いていない)。無理に軸の左端へ置くと 08:30 に始めたように見え、
      //   しかも「いま」へ寄せた画面では左端が枠の外なので **その行が空っぽに見える**
      //   (実測: 尾田さんの行が「3件」と書いてあるのに帯が1本も見えなかった)。
      //   → 時刻を作らずに済む「これから」置き場へ積み、「◀前の日から」と本当の日付を出す。
      const touchedToday = !!(sum.realEndMs && sum.realEndMs >= todayStartMs);
      if (sum.realStartMs && touchedToday) {
        const endMs = sum.completed ? (sum.realEndMs || sum.realStartMs)
          : eta.ok ? Math.max(eta.endMs, sum.realEndMs || nowMs)
          : (sum.realEndMs || nowMs);
        // 🚨軸(今日)からはみ出す物は軸の端で折る。**本当の日時は札に出す**(消さない・作らない)。
        const carried = sum.realStartMs < axisStartMs; // 前の日から続いている台
        const s = Math.max(sum.realStartMs, axisStartMs);
        const e = Math.max(s, Math.min(endMs, axisEndMs));
        bars.push({ lot: l, sum, eta, late, carried, s, e });
      } else {
        queue.push({ lot: l, sum, eta, carried: !!sum.realStartMs });
      }
    });
    // 前の日から残っている(もう始めてある)物を先に。「つぎ」は手を付けかけの物から拾う
    queue.sort((a, b) => (b.carried ? 1 : 0) - (a.carried ? 1 : 0));
    // 重なる帯だけ縦に積む。CSSの最低幅(11rem)と余白を同じ純関数で計算する。
    // 以前の固定11%では、通常勤務幅の実カード(約19%)より小さく判定され、型式カードが重なっていた。
    const packedBars = packTimelineRows(bars, axisSpanMs);
    bars.length = 0;
    bars.push(...packedBars);
    const rowCount = Math.max(1, ...bars.map((b) => b.row + 1));
    // 「つぎ」= その行の待ちの先頭1件だけ (何から手を付けるかを1つに決める)
    const nextLotId = queue.length > 0 ? queue[0].lot.id : null;
    const over = dropTarget === ln.key;
    // 🚨🚨 2026-08-30 実測で見つけた欠陥の直し。
    //   前は `ln.kind === 'unassigned'` で見ていたので、**人ごとの「未割当」行にしか**
    //   「担当とエリアが外れます」の断り書きが出ていなかった。
    //   ところが **エリアごと**の「未該当エリア」行も落とし先は同じ 'zone_unassigned' で、
    //   本体の handleMoveLot はそこで workerId を null にする。
    //   実測: エリアごとで TWA-160(担当=片山) を「未該当エリア」行へ落としたら、
    //         何の断りもなく **片山さんの担当が消えた**(その台は元から未該当エリアに居たので、
    //         エリアとしては何も変わらないのに担当だけ消えた)。
    //   → 断り書きは「行の種類」ではなく **落とすと何が起きるか(dropZoneId)** で決める。
    const isUnassignedLane = ln.dropZoneId === 'zone_unassigned';

    return (
      <div
        key={ln.key}
        {...laneDropProps(ln.key, ln.dropZoneId, ln.workerId)}
        className={`flex items-stretch border-b border-slate-200 bg-white ${over ? (isUnassignedLane ? 'ring-2 ring-inset ring-amber-500 bg-amber-50' : 'ring-2 ring-inset ring-blue-500 bg-blue-50/40') : ''}`}
      >
        {/* 左: 行の見出し。横に流れても消えないよう貼り付ける */}
        <div className={`sticky left-0 z-20 flex w-36 shrink-0 flex-col gap-0.5 border-r border-slate-200 px-2 py-1.5
          ${isUnassignedLane ? 'bg-amber-50' : ln.running ? 'bg-blue-50' : 'bg-slate-50'}`}>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPinnedLaneId((cur) => (cur === ln.key ? null : ln.key))}
              title={pinnedLaneId === ln.key ? '固定をやめる' : '自分の行として一番上に固定する(この端末に覚えさせません)'}
              className={`shrink-0 rounded border px-1 py-0.5 ${pinnedLaneId === ln.key ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-400 hover:text-slate-700'}`}
            >
              {pinnedLaneId === ln.key ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
            </button>
            <span className="truncate text-xs font-black text-slate-800" title={ln.name}>{ln.name}</span>
          </div>
          <StateChip
            label={ln.running ? '作業中' : ln.paused ? '停止中' : ln.openCount > 0 ? '待機' : '予定なし'}
            mode={ln.running ? 'processing' : ln.paused ? 'paused' : 'idle'}
          />
          <div className="whitespace-nowrap text-2xs text-slate-600" title="この行の未完了ロットの見込み工数の合計 (目標時間から。実測ではありません)">
            ⏱残り <b>{ln.planSec > 0 ? fmtSec(ln.planSec) : '0分'}</b>
          </div>
          <div className="text-2xs text-slate-400">{ln.openCount}件{ln.late ? <span className="ml-1 font-black text-rose-600">遅れ</span> : null}</div>
          {isUnassignedLane && (
            <div className="text-2xs font-bold leading-tight text-amber-800">ここへ落とすと<br />担当とエリアが外れます</div>
          )}
        </div>

        {/* 中: 「これから」置き場 (時刻を作らない待ちの山)
            ⚠見出しと同じく貼り付ける。横に流すと**次にやる物が画面の外へ消えて掴めなくなる**
              (「いま」に寄せた時点で左端は画面外になる)。left-36 は左の見出し(w-36)の幅と揃える。 */}
        {/* ⚠背景を透かさない。半透明(bg-slate-50/95)にすると、下を通り過ぎた帯の文字が
              薄く透けて二重に見え、どちらも読めなくなる(実測)。 */}
        <div className="sticky left-36 z-20 flex w-44 shrink-0 flex-col gap-1 border-r border-dashed border-slate-300 bg-slate-50 p-1">
          <div className="text-2xs font-bold text-slate-500">これから({queue.length})</div>
          {queue.length === 0 && <div className="text-2xs text-slate-400">なし</div>}
          {queue.map(({ lot, sum, carried }) => (
            <QueueCard
              key={lot.id} lot={lot} sum={sum} zone={zoneOf(lot)} arrival={arrivals[lot.id]}
              isNext={lot.id === nextLotId} carried={carried} nowMs={nowMs} tplName={tplNameOf(lot)}
              estSec={estSec} fmtSec={fmtSec} pauseColorOf={pauseColorOf}
              ArrivalTag={ArrivalTag} onOpen={openExec} dragging={dragLotId === lot.id}
              dragProps={dragPropsFor(lot, false)}
            />
          ))}
        </div>

        {/* 右: 時間軸 */}
        <div className="relative min-w-0 flex-1" style={{ height: `${rowCount * BAR_ROW_REM + 0.5}rem` }}>
          {/* 休憩の薄い塗り */}
          {breakBands.map((b, i) => (
            <div key={`br-${i}`} className="pointer-events-none absolute inset-y-0 bg-slate-200/60"
              style={{ left: `${clampPct(pctOf(b.s))}%`, width: `${clampPct(pctOf(b.e)) - clampPct(pctOf(b.s))}%` }} title={b.name} />
          ))}
          {/* 目盛りの縦線 */}
          {ticks.map((t) => (
            <div key={`tk-${t}`} className="pointer-events-none absolute inset-y-0 border-l border-slate-100" style={{ left: `${clampPct(pctOf(t))}%` }} />
          ))}
          {/* 今の時刻 */}
          <div className="pointer-events-none absolute inset-y-0 z-30 border-l-2 border-rose-500" style={{ left: `${clampPct(pctOf(nowMs))}%` }} title={`いま ${fmtHHMM(nowMs)}`} />
          {/* 帯 */}
          {bars.map((b) => {
            const locked = b.sum.completed;
            const startPct = clampPct(pctOf(b.s));
            const measuredEnd = clampPct(pctOf(locked ? b.e : Math.min(b.sum.realEndMs || nowMs, b.e)));
            const totalEnd = clampPct(pctOf(b.e));
            return (
              <div key={b.lot.id} className="absolute inset-x-0" style={{ top: `${b.row * BAR_ROW_REM + 0.25}rem`, height: `${BAR_ROW_REM - 0.35}rem` }}>
                <TimeBar
                  lot={b.lot} sum={b.sum} eta={b.eta} zone={zoneOf(b.lot)}
                  workerName={(() => { const lw = workersArr.find((w) => w.id === b.lot.workerId); return lw ? laneNameOf(lw, lw.name || '') : ''; })()}
                  late={b.late} locked={locked} carried={b.carried} tplName={tplNameOf(b.lot)}
                  dragProps={dragPropsFor(b.lot, locked)} onOpen={openExec} dragging={dragLotId === b.lot.id}
                  leftPct={startPct} measuredPct={Math.max(measuredEnd - startPct, 0)} forecastPct={Math.max(totalEnd - measuredEnd, 0)}
                  fmtSec={fmtSec} pauseColorOf={pauseColorOf} nowMs={nowMs} showWorker={laneMode === 'zone'}
                />
              </div>
            );
          })}
          {bars.length === 0 && (
            <div className="flex h-full items-center px-2 text-2xs text-slate-400">時間軸に置ける記録はまだありません</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="w-full overflow-hidden rounded-xl border border-slate-300 bg-slate-100">
      <style>{`
        @keyframes mvtBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
        @keyframes mvtCard { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } 50% { box-shadow: 0 0 0 3px rgba(37,99,235,0.35); } }
        .mvt-forecast { background-image: repeating-linear-gradient(45deg, rgba(148,163,184,0.55) 0, rgba(148,163,184,0.55) 4px, rgba(255,255,255,0.85) 4px, rgba(255,255,255,0.85) 8px); }
        @media (prefers-reduced-motion: reduce) { .mvt-anim, .mvt-anim * { animation: none !important; } }
      `}</style>

      {/* ===== 見出し + 切替 ===== */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <Clock className="h-4 w-4 text-blue-600" />
        <span className="text-xs font-black text-slate-800">時間軸レーン盤</span>
        <span className="text-2xs text-slate-500">
          横=今日の時間({fmtHHMM(axisStartMs)}〜{fmtHHMM(axisEndMs)})・縦=レーン。カードは<b>ドラッグで動かせます</b>(指は長押し)。
        </span>
        {/* ⚠この eslint 設定は JSXタグ(<Foo/>)を「使った」と数えない。
            そのため部品を配列で回して <Ico/> のように使うと no-unused-vars の赤が出る。
            切替は2つだけなので、素直に2つ書く。 */}
        <div className="ml-auto flex items-center overflow-hidden rounded border border-indigo-300 bg-indigo-50">
          <button type="button" onClick={() => setLaneMode('worker')}
            className={`flex items-center gap-1 px-2 py-1 text-2xs font-bold ${laneMode === 'worker' ? 'bg-indigo-600 text-white' : 'text-indigo-700 hover:bg-indigo-100'}`}>
            <Users className="h-3 w-3" />人ごと
          </button>
          <button type="button" onClick={() => setLaneMode('zone')}
            className={`flex items-center gap-1 px-2 py-1 text-2xs font-bold ${laneMode === 'zone' ? 'bg-indigo-600 text-white' : 'text-indigo-700 hover:bg-indigo-100'}`}>
            <MapPin className="h-3 w-3" />エリアごと
          </button>
        </div>
        <button type="button" onClick={() => setOnlyActive((v) => !v)}
          title="予定が1件も無い行を隠す"
          className={`rounded border px-2 py-1 text-2xs font-bold ${onlyActive ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>
          動いている行だけ
        </button>
        <button type="button" onClick={() => scrollToNow()}
          title="いまの時刻が見える所まで横に動かす"
          className="rounded border border-rose-300 bg-white px-2 py-1 text-2xs font-bold text-rose-700 hover:bg-rose-50">
          いまへ
        </button>
      </div>

      {/* ===== ① 人ごとの「いま／つぎ」: まず1人1件だけ見せる ===== */}
      <div className="border-b border-slate-200 bg-white px-3 py-2">
        <div className="mb-1 flex items-center gap-1">
          <Users className="h-3.5 w-3.5 text-blue-600" />
          <span className="text-xs font-black text-slate-800">人ごとの今／次</span>
          <span className="text-2xs text-slate-500">最初にここだけ見れば、誰が何をするか分かります</span>
        </div>
        {actionRows.length === 0 ? (
          <div className="text-2xs text-slate-400">担当中・担当予定の仕事はありません</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {actionRows.map(({ lot, name, info, isRunning, moreCount }) => (
              <button key={`${name}-${lot.id}`} type="button" onClick={() => openExec(lot)}
                className={`min-w-0 rounded-lg border-2 px-2 py-2 text-left ${info.late ? 'border-rose-500 bg-rose-50' : isRunning ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-white'}`}>
                <div className="flex min-w-0 items-center gap-1">
                  <span className={`shrink-0 rounded px-1 text-2xs font-black text-white ${isRunning ? 'bg-blue-600' : 'bg-slate-600'}`}>
                    {isRunning ? 'いま' : 'つぎ'}
                  </span>
                  <span className="truncate text-sm font-black text-slate-900">{name}</span>
                  {moreCount > 0 && <span className="ml-auto shrink-0 text-2xs text-slate-500">ほか{moreCount}件</span>}
                </div>
                <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                  <span className="truncate text-base font-black text-slate-900">{lot.model || '(品目コードなし)'}</span>
                  <span className="shrink-0 text-xs font-bold text-blue-700">{lot.quantity || 1}台</span>
                </div>
                <div className="truncate text-xs font-bold text-slate-700">🔧{info.sum.nowStepTitle || '工程なし'}</div>
                <div className="mt-0.5 flex items-center justify-between gap-1 text-2xs">
                  <span className="truncate font-bold text-slate-600">
                    {isRunning
                      ? (info.eta.ok ? `〜${fmtWhen(info.eta.endMs, nowMs)}見込み` : '終了見込みなし')
                      : '開始待ち'}
                  </span>
                  {info.late && <span className="shrink-0 rounded bg-rose-600 px-1 font-black text-white">終業超え</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ===== ② 盤 (狭い画面は横スクロール) ===== */}
      <div ref={boardRef} className="overflow-x-auto">
        {/* 1時間あたり 7rem。px 直書きをしない (文字サイズ設定と一緒に伸び縮みする) */}
        <div style={{ minWidth: `${timelineBoardMinWidthRem(axisSpanMs)}rem` }}>
          {/* 時間の目盛り */}
          <div className="sticky top-0 z-30 flex items-stretch border-b-2 border-slate-300 bg-white">
            {/* data-sticky-col = 「いまへ」の寄せが左の覆いの幅を測る目印 (この2つだけに付ける) */}
            <div data-sticky-col className="sticky left-0 z-20 flex w-36 shrink-0 items-center border-r border-slate-200 bg-white px-2 py-1 text-2xs font-bold text-slate-500">
              {laneMode === 'zone' ? 'エリア' : '作業者'}
            </div>
            <div data-sticky-col className="sticky left-36 z-20 flex w-44 shrink-0 items-center border-r border-dashed border-slate-300 bg-slate-50 px-2 py-1 text-2xs font-bold text-slate-500">
              これから(時刻なし)
            </div>
            {/* ⚠時刻の目盛りと休憩の名前を同じ行に置くと重なって両方読めなくなる(実測: 「10:00休憩」)。
                  上半分=時刻・下半分=休憩の名前 に分ける。 */}
            <div className="relative min-w-0 flex-1" style={{ height: '2.5rem' }}>
              {breakBands.map((b, i) => (
                <div key={`hbr-${i}`} className="absolute inset-y-0 bg-slate-200/70"
                  style={{ left: `${clampPct(pctOf(b.s))}%`, width: `${clampPct(pctOf(b.e)) - clampPct(pctOf(b.s))}%` }} title={b.name}>
                  <span className="absolute bottom-0 left-0 whitespace-nowrap pl-0.5 text-2xs text-slate-500">{b.name}</span>
                </div>
              ))}
              {ticks.map((t) => (
                <div key={`htk-${t}`} className="absolute inset-y-0 border-l border-slate-300" style={{ left: `${clampPct(pctOf(t))}%` }}>
                  <span className="absolute top-0 left-0 whitespace-nowrap pl-0.5 text-2xs font-bold text-slate-600">{fmtHHMM(t)}</span>
                </div>
              ))}
              <div className="absolute inset-y-0 z-30 border-l-2 border-rose-500" style={{ left: `${clampPct(pctOf(nowMs))}%` }}>
                <span className="ml-0.5 rounded bg-rose-500 px-1 text-2xs font-black text-white">いま {fmtHHMM(nowMs)}</span>
              </div>
            </div>
          </div>

          {/* レーン */}
          {lanes.length === 0 && (
            <div className="px-3 py-4 text-2xs text-slate-500">
              {laneMode === 'zone' ? '表示できるエリアがありません (エリアフィルターを確認してください)' : '作業者が登録されていません。'}
            </div>
          )}
          {lanes.map((ln) => renderLane(ln))}
        </div>
      </div>

      {/* ===== ③ 🚚到着予定の棚 (見るだけ。ここへは落とさない) ===== */}
      <div className="bg-teal-50/60 px-3 py-2">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Truck className="h-4 w-4 text-teal-700" />
          <span className="text-xs font-black text-teal-800">到着予定の棚</span>
          <span className="text-2xs font-bold text-teal-700">{arrivalRows.length}件</span>
          <span className="text-2xs text-teal-700">この棚は見るだけです(ここへ落としても場所は変わりません)。カードは行へドラッグで割り当てられます。</span>
        </div>
        {arrivalRows.length === 0 && <div className="text-2xs text-slate-400">到着予定はありません</div>}
        <div className="flex flex-wrap gap-1.5">
          {arrivalRows.map(({ lot, arrival }) => (
            <div key={lot.id} {...dragPropsFor(lot, lot.status === 'completed')}
              className="flex max-w-full cursor-grab flex-wrap items-center gap-1.5 rounded-lg border-2 border-teal-200 bg-white px-2 py-1 active:cursor-grabbing">
              <TagComp arrival={arrival} compact />
              <span className="whitespace-nowrap text-2xs font-bold text-slate-500">指図: {lot.orderNo || '—'}</span>
              <span className="max-w-[10rem] truncate text-xs font-black text-slate-800">{lot.model || '(品目コードなし)'}</span>
              <span className="whitespace-nowrap text-xs font-black text-blue-600">{lot.quantity || 1}<span className="text-2xs font-normal text-slate-500">台</span></span>
            </div>
          ))}
        </div>
      </div>

      {/* ===== 凡例 ===== */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-3 py-1.5 text-2xs text-slate-600">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-6 rounded bg-blue-200" />実際に記録された時間</span>
        <span className="inline-flex items-center gap-1"><span className="mvt-forecast inline-block h-2 w-6 rounded border border-slate-300" />ここから先は見込み(実測ではありません)</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-6 rounded bg-slate-200" />休憩</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-rose-500" />いまの時刻</span>
        <span className="inline-flex items-center gap-1"><span className="rounded bg-rose-600 px-1 font-black text-white">赤</span>終業までに終わらない見込みの物だけ</span>
        <span className="inline-flex items-center gap-1"><span className="rounded border border-violet-400 bg-violet-100 px-1 font-black text-violet-800">◀前の日から</span>前の日から残っている物(帯は今日の左端で折っています。本当の日付は札に出ます)</span>
        <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3 text-emerald-700" />今日終わった物(動かせません)</span>
        <span className="inline-flex items-center gap-1"><CircleAlert className="h-3 w-3 text-slate-500" />見込みが出せない物は帯を伸ばしません</span>
      </div>
    </div>
  );
}
