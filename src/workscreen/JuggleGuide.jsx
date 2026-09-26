// ============================================================================
// 🚶 掛け持ち案内(作業画面) — 自動測定の待ちの間に「どのロットへ行って・何をして・いつ戻るか」を出す。
//   計算は domain/juggleGuide.js(純関数)。ここは描くだけ。押す物は min-h-11(iPad は 48px)・文字は 14px 以上。
//   土台: 作業者Aの実際の動き(6分測定の間に、隣の区画のロットの 準備・測定準備・片付け をして戻る。相手の測定まで持っていって戻る)。
//   🖐 2026-09-26 清水さん「作業画面がごちゃごちゃして見づらい・イライラするというクレームがある」
//     → 畳んだ状態は **1行だけ**(この間に → 区画 → ロット → 片道 → 向こうで使える時間 → まず何を → 移る)。
//       他の候補と工程の中身は押した時だけ広げる。前は候補3件を全部カードで出していて 800×600 の画面では高さの6割を占めていた。
//     Claude Design の案 https://claude.ai/artifact/B6JfSCQWEx7pYZnRZtBXxp(①畳んだ1行 ②広げた時 ③別ロットにいる時の帯)に合わせた。
// ----------------------------------------------------------------------------
import React, { useState } from 'react';
import { Footprints, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtSec } from '../domain/juggleGuide.js';

const walkText = (c) => (c.walkSec == null ? '不明' : c.walkSec === 0 ? '同じ区画' : `${c.walkSec}秒`);

/** 「見出し 値」の組(片道 10秒 / 向こうで 5:26 使える / まず #3 測定準備) */
const Fact = ({ label, value, unit = '', mono = false, strong = false, shrink = false }) => (
  <span className={`inline-flex items-baseline gap-1 whitespace-nowrap ${shrink ? 'min-w-0' : 'shrink-0'}`}>
    <span className="text-sm text-slate-600 shrink-0">{label}</span>
    <span className={`${mono ? 'font-mono' : ''} font-black ${strong ? 'text-teal-800 text-lg' : 'text-slate-900 text-base'} ${shrink ? 'truncate max-w-[14rem]' : ''}`}>{value}</span>
    {unit ? <span className="text-sm text-slate-600">{unit}</span> : null}
  </span>
);

/** 1行(畳んだ時の主役・広げた時の各候補の見出し) */
function Row({ c, onGo, blocked, main }) {
  const goBtn = c.go === false || !main ? 'bg-white border-2 border-teal-700 text-teal-800' : 'bg-teal-700 text-white';
  return (
    <div className="flex items-center gap-3 min-w-0" data-juggle-card={c.lotId} data-juggle-go={String(c.go)}>
      <span className={`rounded-lg px-3 py-1.5 text-white text-lg font-black shrink-0 ${main && c.go !== false ? 'bg-teal-700' : 'bg-slate-600'}`}>{c.zoneName || '区画 未定'}</span>
      <span className="text-base font-bold text-slate-900 shrink-0 max-w-[11rem] truncate">{c.orderNo || c.model || 'ロット'}</span>
      {main && c.model && c.orderNo ? <span className="font-mono text-sm text-slate-500 truncate hidden lg:inline">{c.model}</span> : null}
      <Fact label="片道" value={walkText(c)} />
      {c.availableSec != null
        ? <Fact label="向こうで" value={fmtSec(c.availableSec)} unit="使える" mono strong={c.go === true} />
        : <span className="text-sm font-bold text-amber-800 shrink-0">{c.walkSec == null ? '片道が分からず時間は出せません' : '残り不明'}</span>}
      {c.items[0] ? <Fact label="まず" value={`${c.items[0].unitIdx != null ? `#${c.items[0].unitIdx + 1} ` : ''}${c.items[0].stepTitle}`} shrink /> : null}
      {!main && c.free ? <span className="text-sm text-slate-600 shrink-0">担当なし</span> : null}
      <button type="button" onClick={() => onGo(c.lotId)} disabled={!!blocked} data-juggle-go-btn={c.lotId}
        className={`ml-auto min-h-12 shrink-0 rounded-lg px-5 text-lg font-black flex items-center gap-2 ${blocked ? 'bg-slate-200 text-slate-500' : goBtn}`}>
        移る <ArrowRight className="w-5 h-5" />
      </button>
    </div>
  );
}

/** 広げた時の中身(何をするか・区切り) */
function Detail({ c }) {
  const shown = c.items.slice(0, 4); const more = c.items.length - shown.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-slate-600">向こうでやる順</span>
        {shown.map((it, i) => (
          <span key={`${it.stepId}-${it.unitIdx}-${i}`} className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-base border-2 ${i < c.fitsCount ? 'bg-white border-teal-700 text-slate-900' : 'bg-white border-slate-300 text-slate-500'}`}>
            <span className={`text-white text-sm font-black px-2 rounded ${i < c.fitsCount ? 'bg-blue-700' : 'bg-slate-400'}`}>{it.unitIdx != null ? `#${it.unitIdx + 1}` : 'ロット'}</span>
            <span className="font-bold">{it.stepTitle}</span>
            <span className="font-mono text-sm text-slate-500">{it.targetSec == null ? '時間 未設定' : fmtSec(it.targetSec)}</span>
          </span>
        ))}
        {more > 0 ? <span className="text-sm text-slate-600">…他{more}件</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-700">
        {c.fitsCount > 0 ? <span className="font-bold">濃い枠 = 戻るまでに終わる</span> : null}
        {c.kugiri
          ? (c.reachKugiri === true ? <span className="text-teal-800 font-bold">✓ #{c.kugiri.unitIdx + 1}の「{c.kugiri.stepTitle}」まで持っていって戻れます</span>
            : c.reachKugiri === false ? <span>#{c.kugiri.unitIdx + 1}の「{c.kugiri.stepTitle}」までは<b>途中まで</b>({fmtSec(c.secToKugiri)}要る)</span>
              : <span>区切り: #{c.kugiri.unitIdx + 1}の「{c.kugiri.stepTitle}」{c.secToKugiri == null ? '(目標が未設定の工程があり、要る時間は出せません)' : ''}</span>)
          : <span>残りは手作業だけ({c.planUnknown ? `${fmtSec(c.planSec)}+未設定` : fmtSec(c.planSec)})</span>}
        <span>{c.inProgress ? '測定済み・進行中' : '未着手'}{c.free ? '・担当なし' : ''}{c.walkSec ? `・往復${c.walkSec * 2}秒を引いた` : ''}</span>
        {c.go === false && c.minTripSec > 0 ? <span>{fmtSec(c.minTripSec)}働けない往復は「行く」にしません(設定で変えられます)</span> : null}
      </div>
    </div>
  );
}

/**
 * 掛け持ち案内の枠。畳んだ時は1行。
 * @param {{ cands:Array, remainingSec:number|null, runningTitle:string, unitIdx:number|null, onGo:function, blocked:string|null, compact?:boolean }} p
 */
export function JuggleGuide({ cands = [], remainingSec = null, runningTitle = '', unitIdx = null, onGo, blocked = null, compact = false }) {
  const [open, setOpen] = useState(false);
  if (!cands.length) return null;
  const [top, ...rest] = cands;
  return (
    <section aria-label="掛け持ち案内" data-juggle-guide="1" data-juggle-open={open ? '1' : '0'} className="mb-2 rounded-xl border-2 border-teal-700 bg-white overflow-hidden">
      <div className="flex items-center gap-3 min-w-0 px-3 py-2">
        <Footprints className="w-6 h-6 text-teal-800 shrink-0" />
        {!compact ? <span className="text-base font-black text-teal-800 shrink-0">この間に</span> : null}
        <div className="flex-1 min-w-0"><Row c={top} onGo={onGo} blocked={blocked} main /></div>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-juggle-toggle="1"
          className="min-h-12 shrink-0 rounded-lg border-2 border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 flex items-center gap-1">
          {open ? '閉じる' : rest.length ? `他${rest.length}件` : '中身'}{open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
      </div>
      {blocked ? <div className="px-3 pb-2 text-sm font-bold text-rose-700">{blocked}</div> : null}
      {open ? (
        <div className="flex flex-col gap-3 border-t-2 border-teal-100 bg-teal-50/60 px-3 py-3">
          <Detail c={top} />
          {rest.map((c) => (
            <div key={c.lotId} className="flex flex-col gap-2 rounded-lg border-2 border-slate-300 bg-white px-3 py-2">
              <Row c={c} onGo={onGo} blocked={blocked} main={false} />
              <Detail c={c} />
            </div>
          ))}
          <div className="text-sm text-slate-600">{unitIdx != null ? `#${unitIdx + 1} ` : ''}「{runningTitle}」の残り {remainingSec != null ? fmtSec(remainingSec) : '不明'}。向こうにいる間も、この測定の残りは上の帯に出ます。帯の「戻る」で戻れます。</div>
        </div>
      ) : null}
    </section>
  );
}

export default JuggleGuide;
