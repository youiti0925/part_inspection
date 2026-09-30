// 🗺 P056 製品 src/mapviews/MapViewLanes.jsx を部品へ写した(画面の文言「型式」を「品目コード」に替えただけ・中身の判定は同じ)。
// =====================================================================================
// 現場マップ 実験ビュー 案4「人がレーン」 (MapViewLanes)
// -------------------------------------------------------------------------------------
// ■ 何のビューか
//   作業者ごとに横一列のレーンを作り、その人が担当しているロットのカードを横に並べる。
//   ・レーン左端(幅150px): 名前・状態(作業中=青点滅/停止中=琥珀/待機)・予定(残)=当人のロットの
//     estimateSecOf 合計・件数
//   ・レーン本体: 当人のロットカード横並び。各カードの前に「エリア色の札」(縦書きのゾーン名)
//   ・最上段: エリア(ゾーン)のサマリー帯 — 名前・件数・作業中の人(青点滅)・停止中の人(琥珀)
//   ・最下段: 「未割当/未該当」レーン(担当者が付いていないロット) と 🚚到着予定棚(⏱処理時間つき)
//
// ■ props の前提 (1個のオブジェクトで受ける。App固有の import は一切しない)
//   {
//     lots,             // ロット配列 (Firestore 'lots'。steps/tasks/status/workerId/mapZoneId 等)
//     zones,            // ゾーン配列 (settings.mapZones 相当。{id,name,color(Tailwindクラス文字列),isUnassigned?})
//     workers,          // 作業者配列 ({id,name,trainee?})
//     arrivalByLot,     // { [lotId]: {time,date,splits,quantity,_spreadFrom,...} } 到着予定の早見表
//     settings,         // 設定 (mapZoneNameSize 等。無くても動く)
//     onOpenExecution,  // (lot)=>void カードタップで作業画面へ (本体と同じ条件: mapZoneId有 && 未完了)
//     onMoveLot,        // 【必ず使う】(lotId, 'planned'|zoneId|'zone_unassigned', workerId?)=>void
//                       //   = 本体 handleMoveLot。カードを動かす保存の道はこれ**ただ1本**。
//     LotCard,          // 注入カード。ここでは使わない (理由は LaneLotCard のコメント。
//                       //   「使えないから」ではなく「見た目を変えない為」)
//     ArrivalTag,       // 注入の到着予定タグ ({arrival,compact})。無ければ自前フォールバック
//     estimateSecOf,    // (lot)=>秒 予定工数の親玉 (製品=calculateLotEstimatedTime較正込み)
//     fmtWorkSec,       // (秒)=>'2時間15分' 等の表示
//     pauseReasonColorOf// (category)=>{bg,border,text,emoji} 停止理由の色。無ければ自前フォールバック
//   }
//
// ■ 操作について (要件D)
//   ・カードのタップ → onOpenExecution(lot)。本体の LotCard と同じ条件
//     (lot.mapZoneId が有り、かつ status!=='completed' の時だけ) で呼ぶ。
//   ・カードのドラッグ → 担当替え・エリア替え。下の「■ 🚨なぜ今は動かせるのか」の通り。
//
// ■ 🚨なぜ今は動かせるのか (2026-08-30。ここには前まで嘘の説明が2つ書いてあった)
//   清水さん「人がレーンのやつは見やすいって好評だけど、**型式カードがそこでは自由に
//   動かせないから意味ない**ってみんな言ってた」
//   ① 前の説明「注入 LotCard は templates/saveData/setDraggedLotId を要求するが props に無い」
//      → **事実と違った**。App 側の BoundLotCard (App.jsx:11825) がその3つを先に束ねてから
//        渡しているし、templates/saveData/setDraggedLotId はこのビューの props にも来ている
//        (App.jsx:11844-11848)。格子(Grid2)と棚(Kanban)は同じ注入カードと同じ onMoveLot で
//        組んである(⚠この2つは今 MAP_VIEW_CHOICES から外してあり画面からは選べない。
//        部品は MAP_VIEW_COMPONENTS に生きている = コードは動くが今は誰も見ていない)。
//        つまり「動かせない理由」は最初から無かった。
//   ② 前の説明「横スクロールとドラッグが競合する」→ **こちらは本物の論点**。ただし
//        「だから提供しない」は解ではない。時間軸レーン盤(MapViewTimeline)が実画面で
//        この競合を解いている: **指を10px以上滑らせたら長押しを取り消す = そのまま横スクロール**。
//        掴むのは長押し(400ms)が立った時だけ。マウスのドラッグは横スクロールと競合しない。
//      → その掴む契約 (mouseDragProps / touchDragProps / laneDropProps) を**そのまま**写した。
//   ・自前カード(LaneLotCard)を描き続けるのは「注入カードが使えないから」ではなく、
//     **清水さんが見やすいと言ったこの小さいカードの見た目を1つも変えない為**。
//     写したのは見た目ではなく掴む契約 (dataTransfer の鍵 'lotId' / data-drop-zone /
//     data-worker-id / 長押し400ms / 10pxで取り消し) で、本体と1文字も違わない。
//
// ■ 動かし方 (🚨保存の道は onMoveLot ただ1本。新しい道は作らない)
//   人のレーンへ落とす       → onMoveLot(lotId, 'planned', workerId) … エリア据え置き・担当が変わる
//   「エリアの状況」の札へ落とす → onMoveLot(lotId, zoneId)            … 担当据え置き・エリアが変わる
//   未該当へ落とす           → onMoveLot(lotId, 'zone_unassigned')    … 担当とエリアが両方外れる(強い)
//   🚨最後の1つは副作用が強いので断り書きを出す。判定は **落とすと何が起きるか(dropZoneId)** で行う。
//     行の種類(「未割当レーンかどうか」)では判定しない — 時間軸盤のあら探しが見つけた欠陥
//     (エリア側の「未該当」札も落とし先は同じ 'zone_unassigned' なのに断り書きが出ず、
//      黙って担当が消えていた) と同じ形をここで作らない。
//   完了したロットは掴めない (本体と同じ draggable={lot.status !== 'completed'})。🔒で見た目にも出す。
//   🚨ただし **この盤に🔒が出る場面は今のところ無い**(あら探し 2026-08-30 実測)。
//     isActiveLot が status/location==='completed' を先に外すので、完了カードは1枚も並ばない。
//     実画面の実測でもカード6枚は6枚とも掴めて、🔒は0枚だった。isLocked は「書いてあるが
//     まだ誰も見ていない守り」= 到着棚などを将来掴めるようにした時の備え、と読むこと。
//
// ■ 色の意味 (要件E・既存踏襲)
//   青=作業中(点滅可・prefers-reduced-motion で停止) / 琥珀=停止 / 緑=完了 / 黄=分納
//   文字はすべて fi-tap-text 以上。
//
// ■ 守り
//   ・hooks はコンポーネント先頭に固定。条件付き hooks 無し・
//     早期 return より後ろの hooks 無し(そもそも早期 return をしない)。
//   ・サブコンポーネントはモジュール直下に定義 (描画関数の中で定義しない)。
//   ・🚨見やすさは1つも変えていない: 左端150px固定の名前列・色と点滅の状態・11px以上の文字・
//     エリアの状況帯・縦のエリア色の札・救済レーン(不明な担当ID)・5秒ごとの更新。
//     足したのは「掴む契約」と「落とし先の印(枠が光る)」と「🔒掴めない印」だけ。
//   ・localStorage に書かない。
// =====================================================================================
import React, { useEffect, useRef, useState } from 'react';
import { Truck, Users, MapPin, Lock } from 'lucide-react';
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

// 経過/合計の H:MM:SS 表示 (本体 formatTime 相当の簡易版)
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

// 「作業中」判定 (本体 checkLotProcessing と同一ロジック)
const checkProcessing = (lot) => {
  if (!lot) return false;
  if (lot.status === 'processing') return true;
  const tasks = lot.tasks || {};
  for (const k in tasks) {
    if (tasks[k] && tasks[k].status === 'processing') return true;
  }
  return false;
};

// 「停止中」判定 (本体 LotCard と同じ: processing でなく、paused タスクか status='paused')
const checkPaused = (lot) => {
  if (!lot || checkProcessing(lot)) return false;
  if (lot.status === 'paused') return true;
  return Object.values(lot.tasks || {}).some((t) => t && t.status === 'paused');
};

// 進捗・ETA (本体 computeLotProgress の読み取り用レプリカ。
//   lotOnce 工程のキー拾いは「step.id- (無ければ stepIdx-) 接頭辞」の近似)
const computeProgress = (lot) => {
  if (!lot || !Array.isArray(lot.steps) || lot.steps.length === 0) return null;
  const tasks = lot.tasks || {};
  const qty = lot.quantity || 1;
  let total = 0;
  let done = 0;
  let doneDur = 0;
  lot.steps.forEach((step, sIdx) => {
    if (step.lotOnce) {
      const prefix = step.id ? `${step.id}-` : `${sIdx}-`;
      const keys = Object.keys(tasks).filter((k) => k.startsWith(prefix));
      total += Math.max(1, keys.length);
      keys.forEach((k) => {
        const t = tasks[k];
        if (t && (t.status === 'completed' || t.status === 'skipped')) { done++; doneDur += (t.duration || 0); }
      });
      return;
    }
    total += qty;
    for (let u = 0; u < qty; u++) {
      const t = (step.id && tasks[`${step.id}-${u}`]) || tasks[`${sIdx}-${u}`];
      if (t && (t.status === 'completed' || t.status === 'skipped')) { done++; doneDur += (t.duration || 0); }
    }
  });
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const remaining = total - done;
  let avg;
  if (done > 0) {
    avg = doneDur / done;
  } else {
    const targetSum = lot.steps.reduce((s, st) => s + (st.targetTime || 60), 0);
    avg = targetSum / lot.steps.length;
  }
  const startMs = toMsAny(lot.workStartTime);
  const etaMs = Date.now() + remaining * avg * 1000;
  // 標準予定 (targetTime ベース) と比べて遅延レベルを出す (本体と同じしきい値)
  const stdSec = lot.steps.reduce((s, st) => s + (st.lotOnce ? 0 : (st.targetTime || 60)), 0) * qty
    + lot.steps.reduce((s, st) => s + (st.lotOnce ? (st.targetTime || 60) : 0), 0);
  const stdEtaMs = (startMs || Date.now()) + stdSec * 1000;
  const delayMs = etaMs - stdEtaMs;
  let delayLevel = 'ontime';
  if (delayMs > 60 * 60 * 1000) delayLevel = 'critical';
  else if (delayMs > 30 * 60 * 1000) delayLevel = 'warning';
  else if (delayMs < -10 * 60 * 1000) delayLevel = 'ahead';
  return { totalTasks: total, completedCount: done, progressPct, remaining, startMs, etaMs, delayLevel };
};

// 停止理由の色。pauseReasonColorOf が注入されなかった時の予備 (本体 PAUSE_REASON_COLOR_MAP と同値)
const FALLBACK_PAUSE_COLORS = {
  waiting_lot:      { bg: 'bg-amber-100',  border: 'border-amber-300',  text: 'text-amber-800',  emoji: '🟡' },
  waiting_repair:   { bg: 'bg-orange-100', border: 'border-orange-300', text: 'text-orange-800', emoji: '🟠' },
  paused:           { bg: 'bg-rose-100',   border: 'border-rose-300',   text: 'text-rose-800',   emoji: '🔴' },
  waiting_parts:    { bg: 'bg-purple-100', border: 'border-purple-300', text: 'text-purple-800', emoji: '🟣' },
  waiting_decision: { bg: 'bg-blue-100',   border: 'border-blue-300',   text: 'text-blue-800',   emoji: '🔵' },
};
const FALLBACK_PAUSE_DEFAULT = { bg: 'bg-slate-100', border: 'border-slate-300', text: 'text-slate-700', emoji: '⏸' };
const fallbackPauseColorOf = (category) => FALLBACK_PAUSE_COLORS[category] || FALLBACK_PAUSE_DEFAULT;

// 完了/入荷待ちを除いた「場内で動いている」ロットか
const isActiveLot = (l) => {
  if (!l) return false;
  if (l.status === 'completed' || l.location === 'completed') return false;
  if (l.location === 'arrival') return false;
  return true;
};

// テンプレ名 (要件B)。⚠templates 配列はこのビューの props に無いので、
//   lot.templateName(あれば) → settings.templates(あれば) → templateId の短縮表示 の順で出す。
const templateNameOf = (lot, settings) => {
  if (!lot) return '';
  if (lot.templateName) return lot.templateName;
  const arr = Array.isArray(settings?.templates) ? settings.templates : null;
  const hit = arr ? arr.find((t) => t && t.id === lot.templateId) : null;
  if (hit && hit.name) return hit.name;
  if (lot.templateId) return String(lot.templateId).length > 10 ? `${String(lot.templateId).slice(0, 10)}…` : String(lot.templateId);
  return '';
};

// 未着手か (到着予定棚の⏱に入れるかの判定。本体 isUntouchedLot の近似:
//   経過時間なし・開始時刻なし・タスクに進みが1つも無い)
const isUntouched = (lot) => {
  if (!lot) return false;
  if (lot.status && lot.status !== 'waiting') return false;
  if (lot.totalWorkTime) return false;
  if (lot.workStartTime) return false;
  const tasks = lot.tasks || {};
  for (const k in tasks) {
    const st = tasks[k] && tasks[k].status;
    if (st === 'completed' || st === 'processing' || st === 'paused' || st === 'skipped' || st === 'ng') return false;
  }
  return true;
};

// ---------------------------------------------------------------
// サブコンポーネント (モジュール直下に定義。描画関数の中で定義しない)
// ---------------------------------------------------------------

// 作業者の名札チップ。mode: 'processing'(青・点滅) / 'paused'(琥珀・⏸) / 'idle'(灰)
const WorkerChip = ({ name, trainee, mode }) => {
  const base = 'inline-flex items-center gap-0.5 border rounded-full px-1.5 py-0.5 fi-tap-text font-bold whitespace-nowrap';
  if (mode === 'processing') {
    return (
      <span className={`${base} bg-blue-600 border-blue-700 text-white mvl-anim`} style={{ animation: 'mvlChipBlink 1s ease-in-out infinite' }}>
        {name}{trainee ? '🎓' : ''}
      </span>
    );
  }
  if (mode === 'paused') {
    return <span className={`${base} bg-amber-100 border-amber-400 text-amber-800`}>⏸{name}{trainee ? '🎓' : ''}</span>;
  }
  return <span className={`${base} bg-slate-100 border-slate-300 text-slate-600`}>{name}{trainee ? '🎓' : ''}</span>;
};

// 到着予定タグの予備 (注入 ArrivalTag が無い時だけ使う)。黄=分納。
const FallbackArrivalTag = ({ arrival }) => {
  if (!arrival || !arrival.time) return null;
  const splits = Array.isArray(arrival.splits) ? arrival.splits : [];
  const multi = splits.length > 1;
  return (
    <span className={`inline-flex items-center gap-0.5 border rounded px-1 py-0.5 fi-tap-text font-bold whitespace-nowrap ${multi ? 'bg-yellow-100 border-yellow-400 text-yellow-900' : 'bg-teal-50 border-teal-300 text-teal-800'}`}>
      🚚{arrival.date ? `${arrival.date} ` : ''}{arrival.time}{multi ? ` 分納${splits.length}便` : ''}
    </span>
  );
};

// カードの前に付く「エリア色の札」(縦書きのゾーン名)
const ZoneTab = ({ zone }) => {
  const color = zone?.color || 'bg-slate-100 border-slate-300';
  const name = zone?.name || '—';
  return (
    <div className={`${color} border rounded-l-lg px-0.5 flex items-center justify-center shrink-0 self-stretch`} title={`エリア: ${name}`}>
      <span className="fi-tap-text font-bold text-slate-700 leading-none" style={{ writingMode: 'vertical-rl' }}>{name}</span>
    </div>
  );
};

// レーンに並べる自前ロットカード (要件B)。
//   ⚠自前で描く理由は「注入 LotCard が使えないから」ではない (冒頭の「■ 🚨なぜ今は動かせるのか」
//     の通り、注入カードは App 側で必要な物を束ねてから渡されていて、格子・棚では現に動いている)。
//     **清水さんが見やすいと言ったこの小さいカードの見た目を変えない為**にこちらを使い続ける。
//     注入カードは幅いっぱいの札(w-80)なので、レーンに横並びにすると1レーンに1〜2枚しか入らない。
//   ⚠掴む契約 (dragProps) は親から丸ごと渡してもらう。ここでは中身を作らない
//     = 本体/時間軸盤と1文字も違わない物がそのまま付く。
//   ⚠⋮メニュー(編集/削除/移動)は onEdit / onDelete / saveData がこのビューの props に
//     無いため【省略】。編集・削除は既存の現場マップ側で行う。カードタップ=onOpenExecution のみ。
//   ⚠lockNote = 掴めない時の**理由**の文。掴めない理由は2つあり(終わったロット / この画面には
//     onMoveLot が来ていない)、どちらなのかを親が決めて文で渡す。ここで理由を決め打ちすると
//     「終わったロットなので動かせません」が終わっていないロットにも出てしまう。
const LaneLotCard = ({ lot, zone, workerName, arrival, nowMs, settings, onOpenExecution, ArrivalTag, pauseColorOf, estSec, fmtSec, dragProps, dragging, locked, lockNote }) => {
  const processing = checkProcessing(lot);
  const paused = checkPaused(lot);
  const p = computeProgress(lot);
  const pct = lot.status === 'completed' ? 100 : (p ? p.progressPct : 0);
  // 経過/合計 = totalWorkTime + (作業中なら now - workStartTime)。now は親が5秒毎に更新
  //   ⚠workStartTime は number / Firestore Timestamp どちらも来得るので必ず toMsAny を通す
  //     (生で引くと Timestamp の時 NaN になり「作業中なのに 0:00:00」の欠陥になる)
  const startedMs = toMsAny(lot.workStartTime);
  const elapsedMs = (lot.totalWorkTime || 0) + (lot.status === 'processing' && startedMs ? Math.max(0, nowMs - startedMs) : 0);
  const border = processing ? 'border-4 border-blue-600'
    : paused ? 'border-2 border-amber-500 bg-amber-50'
    : lot.status === 'error' ? 'border-2 border-rose-500 bg-rose-50'
    : lot.status === 'completed' ? 'border-2 border-emerald-400 bg-emerald-50'
    : 'border-2 border-slate-300 bg-white hover:border-blue-400';
  const procStyle = processing ? { animation: 'mvlCardBlink 1s ease-in-out infinite', backgroundColor: 'rgb(219,234,254)' } : undefined;
  const pause = lot.pauseReason && lot.pauseReason.category ? (pauseColorOf(lot.pauseReason.category) || FALLBACK_PAUSE_DEFAULT) : null;
  const tplName = templateNameOf(lot, settings);
  const est = Number(estSec(lot)) || 0;
  const delayCls = p && p.delayLevel === 'critical' ? 'text-rose-700 font-black'
    : p && p.delayLevel === 'warning' ? 'text-amber-700 font-bold'
    : p && p.delayLevel === 'ahead' ? 'text-emerald-700 font-bold'
    : 'text-blue-700 font-bold';
  const delayLabel = p && p.delayLevel === 'critical' ? '⚠遅延' : p && p.delayLevel === 'warning' ? '遅れ' : p && p.delayLevel === 'ahead' ? '前倒し' : '予定通り';
  const Tag = typeof ArrivalTag === 'function' ? ArrivalTag : FallbackArrivalTag;
  const clickable = !!lot.mapZoneId && lot.status !== 'completed';
  return (
    // 掴む所はカード全体 (エリア色の札も含む)。dragProps の中に draggable / onDragStart /
    // onTouchStart… と、指の長押し用の style(選択と長押しメニューの抑止) が入っている。
    // ⚠locked(完了ロット)の時 dragProps は空。掴めない事は 🔒 と cursor-not-allowed で見た目にも出す。
    <div
      data-lot-id={lot.id}
      {...dragProps}
      className={`flex shrink-0 w-60 ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${dragging ? 'opacity-40' : ''}`}
    >
      <ZoneTab zone={zone} />
      <div
        onClick={() => { if (clickable) onOpenExecution(lot); }}
        className={`mvl-anim relative flex-1 min-w-0 rounded-r-lg shadow-sm px-1.5 py-1 ${border} bg-white`}
        style={procStyle}
        title={`${lot.orderNo || ''} ${lot.model || ''}${locked ? ` — ${lockNote || '動かせません'}` : ' — ドラッグで担当やエリアを変えられます(指は長押し)'}`}
      >
        {/* 作業中の上端ストライプ (本体の lotStripeBlink 相当) */}
        {processing && (
          <div className="mvl-anim absolute top-0 left-0 right-0 h-1 bg-blue-500 pointer-events-none rounded-tr-lg" style={{ animation: 'mvlChipBlink 0.8s ease-in-out infinite' }} />
        )}
        {/* 1行目: 🚚到着タグ・停止理由バッジ */}
        {((arrival && arrival.time) || pause) && (
          <div className="flex items-center gap-1 flex-wrap mb-0.5">
            {/* ⚠到着が無い時は Tag 自体を描かない (注入 ArrivalTag が undefined 耐性を持たない可能性への防御) */}
            {arrival && arrival.time ? <Tag arrival={arrival} compact /> : null}
            {pause && (
              <span className={`${pause.bg} ${pause.border} ${pause.text} border rounded px-1 py-0.5 fi-tap-text font-black whitespace-nowrap`} title={lot.pauseReason.note || lot.pauseReason.label || lot.pauseReason.category}>
                {pause.emoji}{lot.pauseReason.label || lot.pauseReason.category}
              </span>
            )}
          </div>
        )}
        {/* 2行目: 指図・台数 (完了ロットは 🔒 = 掴めない印を先頭に出す) */}
        <div className="flex items-baseline justify-between gap-1">
          {locked && <Lock className="w-3 h-3 shrink-0 text-emerald-700 self-center" aria-label="動かせません" />}
          <span className="fi-tap-text text-slate-500 font-bold truncate">指図: {lot.orderNo || '—'}</span>
          <span className="text-[13px] font-black text-blue-600 whitespace-nowrap">{lot.quantity || 1}<span className="fi-tap-text text-slate-500 font-normal">台</span></span>
        </div>
        {/* 3行目: 品目コード・📋テンプレ名 */}
        <div className="flex items-baseline justify-between gap-1">
          <span className="text-[13px] font-black text-slate-800 truncate">{lot.model || '(品目コードなし)'}</span>
          {tplName ? <span className="fi-tap-text text-slate-500 truncate max-w-[45%]" title={tplName}>📋{tplName}</span> : null}
        </div>
        {/* 4行目: 担当者・経過/合計時間 */}
        <div className="flex items-center justify-between gap-1">
          <span className="fi-tap-text text-slate-600 truncate">👤{workerName || '未割当'}</span>
          <span className={`fi-tap-text font-mono whitespace-nowrap ${lot.status === 'processing' ? 'text-blue-600 font-bold' : 'text-slate-400'}`}>{fmtHMS(elapsedMs / 1000)}</span>
        </div>
        {/* 5行目: 進捗% と 開始〜見込み(ETA)。未着手は ⏱見込み工数を出す */}
        {p && (lot.status === 'processing' || lot.status === 'paused') && (
          <div className={`flex items-center justify-between gap-1 fi-tap-text ${delayCls}`}>
            <span className="font-black">{pct}%</span>
            <span className="text-slate-600 font-medium whitespace-nowrap">{fmtHHMM(p.startMs)}〜{fmtHHMM(p.etaMs)}</span>
            <span className="whitespace-nowrap">{delayLabel}</span>
          </div>
        )}
        {(lot.status === 'waiting' || !lot.status) && est > 0 && (
          <div className="flex items-center justify-between gap-1 fi-tap-text text-slate-500">
            <span className="font-black">{pct}%</span>
            <span title="この1件を処理するのに要る見込み(目標時間の合計。実測ではありません)">⏱処理に{fmtSec(est)}</span>
          </div>
        )}
        {/* 進捗バー (緑=完了・青=それ以外) */}
        <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden mt-0.5">
          <div className={`h-full ${lot.status === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------
// 本体
// ---------------------------------------------------------------
export default function MapViewLanes(props) {
  const {
    lots, zones, workers, arrivalByLot, settings,
    onOpenExecution, onMoveLot, // 🚨カードを動かす保存の道はこれ1本だけ (= 本体 handleMoveLot)
    ArrivalTag, estimateSecOf, fmtWorkSec, pauseReasonColorOf,
    // ⚠LotCard / saveData / setDraggedLotId / templates も App から来ているが、ここでは受け取らない。
    //   使わない理由は冒頭の「■ 🚨なぜ今は動かせるのか」①(見た目を変えない為)。
  } = props || {};

  // ⚠hooks はここに全部。必ずコンポーネント先頭・どの return よりも上に置く (条件付き禁止)。
  // 経過時間の再描画は5秒毎 (本体 LotCard と同じ。1秒だと枚数×re-render が重い)
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dragLotId, setDragLotId] = useState(null);   // 掴んでいるロット (本体 draggedLotId と同じ役)
  const [dropTarget, setDropTarget] = useState(null); // 重ねている落とし先のキー
  const rootRef = useRef(null);                       // 落とし先を探す範囲 = この盤の中だけ
  const touchRef = useRef({ timer: null, dragging: false, ghost: null, startX: 0, startY: 0 });
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
  // ⚠onMoveLot が来ていない使われ方をした時は、掴めるように見せない
  //   (掴めるのに何も起きないカードは嘘になる)。見出しの案内文も切り替える。
  const canMove = !!moveLot;

  // ゾーン一覧。未該当エリアが無ければ必ず補う (本体 ensureUnassignedZone と同じ発想)
  const zonesArr = Array.isArray(zones) ? zones.slice() : [];
  if (!zonesArr.some((z) => z && (z.isUnassigned || z.id === 'zone_unassigned'))) {
    zonesArr.push({ id: 'zone_unassigned', name: '未該当', color: 'bg-slate-100 border-slate-300', isUnassigned: true });
  }
  //   mapZoneId が無い/知らないIDのロットは「未該当」ゾーンの札を付ける (「—」の無情報表示を避ける)
  const unassignedZone = zonesArr.find((z) => z && (z.isUnassigned || z.id === 'zone_unassigned')) || null;
  const zoneOf = (l) => zonesArr.find((z) => z && z.id === l.mapZoneId) || unassignedZone;
  const zoneNameSize = Math.max(11, Number(settings?.mapZoneNameSize) || 14); // 11px未満は禁止

  // 場内で動いているロット (完了・入荷待ちを除く)
  const activeLots = lotsArr.filter(isActiveLot);

  // =============================================================
  // 掴む契約 (🚨時間軸レーン盤 MapViewTimeline.jsx から**そのまま**移植。
  //   元は本体 LotCard (App.jsx:10165-10231 / 10296) の写し。1文字も変えていない)
  //   ・鍵は 'lotId' (本体と同じ)
  //   ・落とし先は [data-drop-zone] / [data-worker-id] (本体と同じ属性名)
  //   ・保存は moveLot(= 注入 onMoveLot = 本体 handleMoveLot) ただ1本
  // =============================================================
  // 完了したロットは掴めない (本体と同じ draggable={lot.status !== 'completed'})。
  // onMoveLot が来ていない時も掴ませない (動かないのに掴めるように見せない)。
  const isLocked = (lot) => !canMove || !lot || lot.status === 'completed' || lot.location === 'completed';
  // 掴めない**理由**の文。理由は2つあるので、カード側で決め打ちせずここで選ぶ。
  //   ⚠「終わったロットなので動かせません」を onMoveLot が無いだけの時に出すと嘘になる。
  const lockNoteFor = (lot) => (!isLocked(lot) ? ''
    : (!canMove ? 'この画面ではカードを動かせません' : '終わったロットなので動かせません'));

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

  // ⚠探すのはこの盤の中の落とし先だけ (rootRef の中)。画面の他所の受け皿へは飛ばさない。
  const dropZonesInBoard = () => {
    const root = rootRef.current;
    return root ? Array.from(root.querySelectorAll('[data-drop-zone]')) : [];
  };

  // 指: 400ms長押し → バイブ → ゴースト → [data-drop-zone] を光らせる → 指の下へ落とす
  //   🚨**横スクロールとの競合はここで解いている**: 長押しが立つ前に指が10px以上動いたら
  //     長押しを取り消す = そのまま今までどおりレーンの横スクロールになる。
  //     (これが「ドラッグは提供しない」と書いてあった本当の論点の答え。時間軸盤で実証済み)
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
  const dragPropsFor = (lot) => {
    const locked = isLocked(lot);
    return { ...mouseDragProps(lot, locked), ...touchDragProps(lot, locked) };
  };

  // 落とし先 (レーンの行 / エリアの札) が受ける側。マウスの落とし込み。
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

  // 🚨断り書きは「行の種類」ではなく **落とすと何が起きるか(dropZoneId)** で決める。
  //   本体 handleMoveLot は 'zone_unassigned' で workerId を null にする = 担当が外れる。
  //   人ごとの「未割当」行も、エリアの「未該当」札も、落とし先は同じ 'zone_unassigned'。
  //   行の種類で見ていると、エリア側だけ断りなく担当が消える(時間軸盤で実際に起きた欠陥)。
  const dropClearsWorker = (dropZoneId) => dropZoneId === 'zone_unassigned';
  const dropRingClass = (laneKey, dropZoneId) => (dropTarget === laneKey
    ? (dropClearsWorker(dropZoneId) ? 'ring-2 ring-inset ring-amber-500 bg-amber-50' : 'ring-2 ring-inset ring-blue-500 bg-blue-50/40')
    : '');

  // ---- レーンの組み立て: 作業者ごと + 「不明な担当者ID」の救済レーン ----
  // 🚨 knownIds は **全員** で作る(休止中も含む)。ここを絞ると休止した人のロットが
  //   下の救済レーン「不明(a1b2c3)」へ落ちて、名前が画面から消える。
  const knownIds = new Set(workersArr.map((w) => w && w.id));
  // 🛌 レーンに出すのは在籍中の人。休止中でも **まだ場内にロットが残っている人は残す**。
  const laneWorkers = laneWorkersOf(workersArr, activeLots, { isOpen: () => true });
  const strayIds = [...new Set(activeLots.map((l) => l.workerId).filter((id) => id && !knownIds.has(id)))];
  strayIds.forEach((id) => laneWorkers.push({ id, name: `不明(${String(id).slice(0, 6)})`, _stray: true }));

  const lotsOfWorker = (wid) => activeLots.filter((l) => l.workerId === wid);
  // 未割当/未該当レーン = 担当者が付いていない場内ロット
  //   (担当者付きで zone_unassigned に居る物は、その人のレーンに「未該当」札付きで出る)
  const unassignedLots = activeLots.filter((l) => !l.workerId);

  // ---- エリアサマリー (要件A): ゾーンごとの 名前・件数・作業中の人(青点滅)・停止中の人(琥珀) ----
  const zoneSummaries = zonesArr.map((z) => {
    const zl = activeLots.filter((l) => l.mapZoneId === z.id);
    const byWorker = new Map();
    zl.forEach((l) => {
      if (!l.workerId) return;
      const w = laneWorkers.find((x) => x.id === l.workerId);
      const cur = byWorker.get(l.workerId) || { id: l.workerId, name: w ? laneNameOf(w, w.name) : String(l.workerId).slice(0, 6), trainee: !!(w && w.trainee), processing: false, paused: false };
      if (checkProcessing(l)) cur.processing = true;
      if (checkPaused(l) || (l.pauseReason && l.pauseReason.category)) cur.paused = true;
      byWorker.set(l.workerId, cur);
    });
    const people = [...byWorker.values()];
    return { zone: z, count: zl.length, working: people.filter((p) => p.processing), pausedPeople: people.filter((p) => !p.processing && p.paused) };
  });

  // ---- 🚚到着予定棚 (要件C): 到着予定のあるロット。⏱は未着手ぶんの見込み ----
  const arrivalRows = lotsArr
    .filter((l) => l && l.status !== 'completed' && l.location !== 'completed')
    .map((l) => ({ lot: l, arrival: arrivals[l.id] }))
    .filter((r) => r.arrival && r.arrival.time)
    .sort((a, b) => `${a.arrival.date || ''} ${a.arrival.time || ''}`.localeCompare(`${b.arrival.date || ''} ${b.arrival.time || ''}`));
  const arrivalWorkRows = arrivalRows.filter((r) => isUntouched(r.lot));
  const arrivalWorkSec = arrivalWorkRows.reduce((n, r) => n + estSec(r.lot), 0);
  const TagComp = typeof ArrivalTag === 'function' ? ArrivalTag : FallbackArrivalTag;

  // 1レーンぶんの描画 (map の中で使う小さな describe。コンポーネントではなく通常関数呼び出しで描く)
  const renderLane = (w) => {
    const wl = lotsOfWorker(w.id);
    const hasProcessing = wl.some(checkProcessing);
    const hasPaused = !hasProcessing && wl.some((l) => checkPaused(l) || (l.pauseReason && l.pauseReason.category));
    const planSec = wl.reduce((n, l) => n + estSec(l), 0); // 予定(残)=当人のロットの estimateSecOf 合計 (簡易値。進行中の按分はしない)
    const mode = hasProcessing ? 'processing' : hasPaused ? 'paused' : 'idle';
    // 人のレーン = 落とすと担当が変わる (エリアは据え置き)。本体 handleMoveLot の 'planned' 分岐。
    const laneKey = `w-${w.id}`;
    return (
      <div key={w.id} {...(canMove ? laneDropProps(laneKey, 'planned', w.id) : {})}
        className={`flex items-stretch border-b border-slate-200 bg-white ${dropRingClass(laneKey, 'planned')}`}>
        {/* 左150px: 名前・状態・予定(残)・件数 (⚠幅も中身も変えていない) */}
        <div className="w-[150px] shrink-0 border-r border-slate-200 bg-slate-50 px-2 py-1.5 flex flex-col gap-0.5">
          {/* 🛌 = 休止中。作業が残っているのでレーンを残している。付け替えれば次の描き直しで消える。 */}
          <div className="text-[13px] font-black text-slate-800 truncate" title={w.paused === true ? '休止中です。作業がまだ残っているのでレーンを残しています。' : ''}>{laneNameOf(w, w.name)}{w.trainee ? '🎓' : ''}</div>
          <div>
            <WorkerChip name={hasProcessing ? '作業中' : hasPaused ? '停止中' : wl.length > 0 ? '待機' : '予定なし'} mode={wl.length > 0 ? mode : 'idle'} />
          </div>
          <div className="fi-tap-text text-slate-600 whitespace-nowrap" title="この人のロットの見込み工数の合計 (estimateSecOf の単純合計。進行中の残り按分はしていません)">
            ⏱予定(残) <b>{planSec > 0 ? fmtSec(planSec) : '0分'}</b>
          </div>
          <div className="fi-tap-text text-slate-400">{wl.length}件</div>
        </div>
        {/* レーン本体: カード横並び (横スクロール)。
            ⚠横スクロールは今までどおり残す。指はカードを「10px滑らせたら横スクロール・
              長押ししたら持ち上げ」で切り分けている (touchDragProps 参照)。 */}
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="flex items-stretch gap-1.5 p-1.5 min-h-[90px]">
            {wl.length === 0 && (
              <div className="fi-tap-text text-slate-400 self-center px-2">担当ロットなし{canMove ? '（ここへ落とすとこの人の担当になります）' : ''}</div>
            )}
            {wl.map((l) => (
              <LaneLotCard key={l.id} lot={l} zone={zoneOf(l)} workerName={laneNameOf(w, w.name)} arrival={arrivals[l.id]} nowMs={nowMs}
                settings={settings} onOpenExecution={openExec} ArrivalTag={ArrivalTag} pauseColorOf={pauseColorOf} estSec={estSec} fmtSec={fmtSec}
                dragProps={dragPropsFor(l)} dragging={dragLotId === l.id} locked={isLocked(l)} lockNote={lockNoteFor(l)} />
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    // ⚠ref はこの盤の中だけを落とし先の探索範囲にする為 (画面の他所の受け皿へ飛ばさない)
    <div ref={rootRef} className="w-full bg-slate-100 rounded-xl border border-slate-300 overflow-hidden">
      {/* アニメーション定義。prefers-reduced-motion では .mvl-anim の動きを全部止める (青点滅は静的な青チップになる) */}
      <style>{`
        @keyframes mvlChipBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
        @keyframes mvlCardBlink {
          0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); background-color: rgb(219,234,254); }
          50% { box-shadow: 0 0 0 4px rgba(37,99,235,0.35); background-color: rgb(191,219,254); }
        }
        @media (prefers-reduced-motion: reduce) { .mvl-anim { animation: none !important; } }
      `}</style>

      {/* ===== 見出し ===== */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-slate-200">
        <Users className="w-4 h-4 text-blue-600" />
        <span className="text-[13px] font-black text-slate-800">実験ビュー: 人がレーン</span>
        <span className="fi-tap-text text-slate-500">
          作業者ごとの横レーン。カードタップで作業画面へ。
          {canMove
            ? <>カードは<b>ドラッグで動かせます</b>(指は長押し・そのまま滑らせると今までどおり横スクロール)。人の行へ落とすと担当が変わり、上の「エリアの状況」の札へ落とすとエリアが変わります。</>
            : '（このページではカードを動かせません）'}
        </span>
      </div>

      {/* ===== エリアサマリー帯 (要件A: 名前・件数・作業中の人=青点滅・停止中の人=琥珀) ===== */}
      <div className="px-3 py-2 bg-white border-b border-slate-200">
        <div className="flex items-center gap-1 mb-1">
          <MapPin className="w-3.5 h-3.5 text-slate-500" />
          <span className="fi-tap-text font-bold text-slate-600">エリアの状況</span>
          {canMove && <span className="fi-tap-text text-slate-400">この札へ落とすとエリアが変わります(担当は据え置き)</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {zoneSummaries.map(({ zone, count, working, pausedPeople }) => {
            // 🚨エリアの落とし先。判定は行の種類ではなく **落とし先のID** で行う:
            //   'zone_unassigned' に落とすと本体 handleMoveLot が workerId を null にする = 担当が外れる。
            //   人ごとの「未割当」行と同じ事が起きるので、断り書きもここに同じだけ出す。
            const zoneKey = `z-${zone.id}`;
            const clears = dropClearsWorker(zone.id);
            return (
              <div key={zone.id} {...(canMove ? laneDropProps(zoneKey, zone.id, null) : {})}
                className={`${zone.color || 'bg-slate-100 border-slate-300'} border rounded-lg px-2 py-1 flex items-center gap-1.5 ${dropRingClass(zoneKey, zone.id)}`}>
                <span className="font-black text-slate-800 whitespace-nowrap" style={{ fontSize: zoneNameSize }}>{zone.name}</span>
                <span className="fi-tap-text font-bold text-slate-600 whitespace-nowrap">{count}件</span>
                {canMove && clears && (
                  <span className="fi-tap-text font-bold text-amber-800 whitespace-nowrap" title="ここへ落とすと、エリアが未該当になるだけでなく担当者も外れます">
                    ⚠落とすと担当も外れます
                  </span>
                )}
                {/* key は配列 index でなく workerId (index だと人の入れ替わりで札が別人に引き継がれる) */}
                {working.map((p) => (
                  <WorkerChip key={`w-${p.id}`} name={p.name} trainee={p.trainee} mode="processing" />
                ))}
                {pausedPeople.map((p) => (
                  <WorkerChip key={`p-${p.id}`} name={p.name} trainee={p.trainee} mode="paused" />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== 作業者レーン ===== */}
      <div>
        {laneWorkers.length === 0 && (
          <div className="fi-tap-text text-slate-500 px-3 py-4">作業者が登録されていません。</div>
        )}
        {laneWorkers.map((w) => renderLane(w))}
      </div>

      {/* ===== 未割当/未該当レーン (担当者が付いていない場内ロット) =====
            🚨ここへ落とすと本体 handleMoveLot が workerId を null にする = 担当が外れる。
              断り書きは行の名前ではなく落とし先のID('zone_unassigned')で出している。 */}
      <div {...(canMove ? laneDropProps('w-none', 'zone_unassigned', null) : {})}
        className={`flex items-stretch border-b border-slate-200 bg-white ${dropRingClass('w-none', 'zone_unassigned')}`}>
        <div className="w-[150px] shrink-0 border-r border-slate-200 bg-amber-50 px-2 py-1.5 flex flex-col gap-0.5">
          <div className="text-[13px] font-black text-amber-800">未割当/未該当</div>
          <div className="fi-tap-text text-amber-700">担当者なし</div>
          <div className="fi-tap-text text-slate-600 whitespace-nowrap">⏱<b>{fmtSec(unassignedLots.reduce((n, l) => n + estSec(l), 0))}</b></div>
          <div className="fi-tap-text text-slate-400">{unassignedLots.length}件</div>
          {canMove && (
            <div className="fi-tap-text font-bold text-amber-800 leading-tight">ここへ落とすと<br />担当とエリアが外れます</div>
          )}
        </div>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="flex items-stretch gap-1.5 p-1.5 min-h-[90px]">
            {unassignedLots.length === 0 && (
              <div className="fi-tap-text text-slate-400 self-center px-2">未割当のロットはありません</div>
            )}
            {unassignedLots.map((l) => (
              <LaneLotCard key={l.id} lot={l} zone={zoneOf(l)} workerName="" arrival={arrivals[l.id]} nowMs={nowMs}
                settings={settings} onOpenExecution={openExec} ArrivalTag={ArrivalTag} pauseColorOf={pauseColorOf} estSec={estSec} fmtSec={fmtSec}
                dragProps={dragPropsFor(l)} dragging={dragLotId === l.id} locked={isLocked(l)} lockNote={lockNoteFor(l)} />
            ))}
          </div>
        </div>
      </div>

      {/* ===== 🚚到着予定の棚 (要件C: ⏱処理時間つき。合計は未着手ぶんだけを数える) =====
            ⚠この棚は今までどおり**見るだけ**にしてある(掴む契約を付けていない)。付け忘れではない。
              まだ着いていない物をレーンへ入れる話は、まだ誰にも決めてもらっていないので勝手に作らない。 */}
      <div className="bg-teal-50/60 px-3 py-2">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <Truck className="w-4 h-4 text-teal-700" />
          <span className="text-[13px] font-black text-teal-800">到着予定の棚</span>
          <span className="fi-tap-text font-bold text-teal-700">{arrivalRows.length}件</span>
          {arrivalWorkSec > 0 && (
            <span className="fi-tap-text font-bold text-teal-700" title="目標時間の合計から出した見込み(実測ではありません)">
              ⏱処理に{fmtSec(arrivalWorkSec)}{arrivalWorkRows.length < arrivalRows.length ? `（未着手${arrivalWorkRows.length}件ぶん）` : ''}
            </span>
          )}
        </div>
        {arrivalRows.length === 0 && (
          <div className="fi-tap-text text-slate-400">到着予定はありません</div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {arrivalRows.map(({ lot, arrival }) => {
            const est = estSec(lot);
            const splits = Array.isArray(arrival.splits) ? arrival.splits : [];
            return (
              <div key={lot.id} className="bg-white border-2 border-teal-200 rounded-lg px-2 py-1 flex items-center gap-1.5 flex-wrap max-w-full">
                <TagComp arrival={arrival} compact />
                <span className="fi-tap-text font-bold text-slate-500 whitespace-nowrap">指図: {lot.orderNo || '—'}</span>
                <span className="text-[12px] font-black text-slate-800 truncate max-w-[10rem]">{lot.model || '(品目コードなし)'}</span>
                <span className="text-[12px] font-black text-blue-600 whitespace-nowrap">{lot.quantity || 1}<span className="fi-tap-text font-normal text-slate-500">台</span></span>
                {splits.length > 1 && (
                  <span className="bg-yellow-100 border border-yellow-400 text-yellow-900 rounded px-1 fi-tap-text font-bold whitespace-nowrap">分納{splits.length}便</span>
                )}
                {arrival._spreadFrom && (
                  <span className="fi-tap-text text-slate-400 whitespace-nowrap" title="同じ指図の別ロットから広げた到着予定の札">↔同指図から展開</span>
                )}
                {isUntouched(lot) && est > 0 && (
                  <span className="fi-tap-text font-bold text-teal-700 whitespace-nowrap" title="この1件を処理するのに要る時間。目標時間の合計から出した見込みです（実測ではありません）">⏱処理に{fmtSec(est)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
