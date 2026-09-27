// =============================================================================
//  opsim/Monthly.jsx — 月ごとの画面「この先3か月 人は足りる？」
// -----------------------------------------------------------------------------
//  清水さん(2026-09-01):
//    「シュミレーションは一月毎にして、月毎の必要な人材を確認する感じ」
//    「一週間前だと間に合わないけど、一月前にわかったら準備する時間もあるから間に合う」
//    「10月ぶんの入荷・納期は、これから登録する予定」
//  清水さん(2026-09-02):
//    「人間が視覚的に理解しやすくするのが第一条件」「文字だらけにしやがって」
//    「品目コードしか書いてないけど、テンプレによって作業内容かわるから、品目コードだけ記載されてても意味ない」
//
//  ■ ここが守っている決まり（scratchpad/decisions.md 1〜6・12）
//   決まり1  中身の無い月を「回ります」と言わせない。判定は Worker(monthly.js) の verdict そのまま。
//            この画面は verdict を **色と言葉に置くだけ**で、判定し直さない。
//            仕事が0件の月は灰色「まだ判定していません」（空だから回ります、とは書かない）。
//   決まり2  10月は「育っていく様子」＝ 登録N件 ／ 入荷の登録は◯日ぶんまで ／ 先週との差は
//            **出せません**（前の控えが無い。数字を作らない）。登録が増えれば自然に判定へ変わる。
//   決まり3  今月が主役（いちばん広い枠。週の山は今月だけ）。札に暦日と営業日を併記(rangeLabel)。
//   決まり4  必要な人材を1つの数に丸めない。①要る ②働ける ③不足 ③′1か月フル(分母を同じ行) ④数えられていない3つ。
//            工程の行に **持てる人の名前**。合計欄は作らない。「持てる人が分かりません」は不足に混ぜない（灰の別枠）。
//   決まり5  教育の逆算日は出さない。出すのは材料3つの札と「営業N日×1日1組＝最大N組」まで。
//   決まり6  大きい字は答え（何人日／回ります／まだ判定していません）。件数ではない。px 直書きなし（rem 段）。
//   決まり12 品目コードにテンプレを添える。工程の行は「工程名 ／ テンプレ名 ／ 品目コード」。
//
//  ■ 数字の出どころは1つ
//   props.monthly ＝ Worker(operationsSimulation.worker.js ⑦) が monthly.js で出した物そのまま。
//   「到着待ちに置かれたまま作業の記録0件」を数える／数えないの2通りを Worker が **両方** 返し、
//   この画面は切替でどちらかを **置くだけ**。ここで足し算・引き算を1つも書かない。
//
//  ■ 見た目
//   色の意味は4つに固定: 緑=回ります ／ 橙=きわどい ／ 赤=足りません ／ 灰=まだ判定していません。
//   人の色は左端の帯と小さな札だけ（workerColors.js。盤と同じ対応）。
//   px 直書きをしない（文字サイズ設定で1ピクセルも拡大しなくなる）。見た目だけの拡大（押した所がズレる方式）も使わない。
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { buildWorkerColors, toneOf } from './workerColors.js';
// 決まり19B（2026-09-04）: この画面は「来月の手当て」に作り直した。
//   主役＝ NextMonthPlan（工程が主役の案B）。**元の『月ごと』の中身は1つも消していない**。
//   下の折りたたみにそのまま残してある（情報は 移す・畳む・強さを変える。消さない）。
import { NextMonthPlan } from './nextMonth/index.js';
import { Signal, Dots, Glyph } from './vizKit.jsx';
// 🚨 vizKit は数を作らない。渡された値を色・形・長さに変えるだけ(2026-09-15)。
/** 月の verdict → 信号の段。色だけでなく **形** も変える(白黒でも読める)。 */
const SIGNAL_OF = Object.freeze({ short: 'danger', tight: 'warn', ok: 'ok', partial: 'unknown', unjudgeable: 'unknown' });
const signalOfVerdict = (v) => SIGNAL_OF[v] || 'unknown';

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

const fmtMd = (ms) => {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtYmd = (ms) => {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtMdHm = (ms) => {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** 分 → 人日（小数1桁）。分母は Worker が返した dayMinutes（policy.js の 420 など）。 */
const personDays = (minutes, dayMinutes) => {
  const m = num(minutes);
  const d = num(dayMinutes);
  if (m == null || d == null || !(d > 0)) return null;
  return Math.round((m / d) * 10) / 10;
};
/** 何か月ぶんの記録か（暦の月で数える。日数を月に換算しない） */
const monthsBetween = (fromMs, toMs) => {
  const a = num(fromMs);
  const b = num(toMs);
  if (a == null || b == null || b < a) return null;
  const da = new Date(a);
  const db = new Date(b);
  return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
};

// ── 色（4つに固定。人の色とぶつけない） ──────────────────────────────────────
const TONE = Object.freeze({
  ok: { tile: 'bg-green-600', pill: 'bg-green-600', label: '回ります' },
  tight: { tile: 'bg-amber-500', pill: 'bg-amber-500', label: 'きわどい' },
  short: { tile: 'bg-red-600', pill: 'bg-red-600', label: '足りません' },
  grey: { tile: 'bg-slate-500', pill: 'bg-slate-500', label: 'まだ判定していません' },
});
/** 斜線＝「本物か分からない」（到着待ち・記録0件の山が要る時間の半分以上） */
const HATCH_ON_DARK = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,.45) 0 .3rem, rgba(0,0,0,.15) .3rem .6rem)',
});
const HATCH_ON_LIGHT = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(71 85 105) 0 .3rem, rgb(201 209 218) .3rem .6rem)',
});

/**
 * 月の札に出す「答え」を verdict から選ぶ。
 * 🚨 判定し直していない。Worker の verdict を色と言葉に置いているだけ。
 * 🚨 仕事が0件の月（verdict は ok だが jobCount 0）を「回ります」にしない（決まり1）。
 */
function tileFacts(m, countPile, holdingWord) {
  const hasJobs = (num(m.jobCount) || 0) > 0;
  if (m.verdict === 'short') {
    return {
      tone: 'short',
      answer: `${m.shortPersonDays}人日 足りません`,
      why: `1か月フルで張り付く人に直すと ${m.peopleForWholeMonth}人分（${m.label}の営業${m.peopleForWholeMonthDenominatorWorkdays}日で割った値）`,
    };
  }
  if (m.verdict === 'tight') {
    return { tone: 'tight', answer: 'きわどい', why: `回りますが余裕がありません（余力 ${m.sparePersonDays}人日）` };
  }
  if (m.verdict === 'ok' && hasJobs) {
    return { tone: 'ok', answer: '回ります', why: `余力 ${m.sparePersonDays}人日` };
  }
  if (m.verdict === 'partial') {
    return { tone: 'grey', answer: `残り営業${m.workdays}日だけ`, why: m.partialWhy || '足りる／足りないの判定は出しません' };
  }
  if (m.verdict === 'unjudgeable') {
    // 山（到着待ち・記録0件）が理由の時は短く。同じ数字（percent・lotCount）を短い形に置くだけ。
    //   長い原文は下の「根拠の文」にそのまま出る（消していない）。
    const pileWhy = (m.pile && num(m.pile.percent) != null && m.pile.lotCount > 0
      && m.unjudgeableWhy && m.unjudgeableWhy === m.pile.sentence)
      ? `要る時間の ${m.pile.percent}% が${holdingWord} ${m.pile.lotCount}ロット（作業の記録0件）＝本物か分からない（斜線）`
      : '';
    return { tone: 'grey', answer: 'まだ判定していません', why: pileWhy || m.unjudgeableWhy || '' };
  }
  // ok なのに仕事が0件 ＝ 空。空だから「回ります」とは言わない。
  /* 🚨 決まり19B①（2026-09-04・後の決まりが勝つ）:
       登録が無い月は「登録 ◯件（これから）」と言い、**「判定していません」は出さない**。
       ⚠ 決まり2（2026-09-01）は「まだ判定していません」を文例に挙げていて、決まりが割れていた。
         親の指示（2026-09-05）で 19B を採る。数字は engine の lotCount そのまま（作らない）。 */
  return {
    tone: 'grey',
    answer: countPile
      ? `いま登録されているのは ${num(m.lotCount) || 0}件です（これから増えます）`
      : '記録のある仕事は 0件',
    why: countPile
      ? 'この月に納期が来る仕事は、まだこの数しか登録されていません（仕事が無いという意味ではありません）'
      : `${holdingWord}を外すと、この月に納期が来る仕事は残りません（登録 ${num(m.lotCount) || 0}件）。空だから「回ります」とは言いません`,
  };
}

// -----------------------------------------------------------------------------
// 小さな部品（🚨 描画関数の中で部品を定義しない。全部ここ）
// -----------------------------------------------------------------------------

/** 要る時間の棒に、働ける時間の白線。線を越えた分が赤。 */
function CapBar({ requiredMinutes, workableMinutes, dayMinutes, hatch = false, workerCount = 0, workdays = 0 }) {
  const req = Math.max(0, num(requiredMinutes) || 0);
  const cap = num(workableMinutes);
  const capV = cap == null ? 0 : Math.max(0, cap);
  const scale = Math.max(req, capV, 1) * 1.15;
  const reqPct = (req / scale) * 100;
  const capPct = (capV / scale) * 100;
  const overPct = req > capV ? ((req - capV) / scale) * 100 : 0;
  return (
    <div className="relative h-6 rounded-md bg-white/25" aria-label="要る時間と働ける時間">
      <div className="absolute inset-y-0 left-0 rounded-md bg-black/45" style={{ width: `${reqPct}%`, ...(hatch ? HATCH_ON_DARK : null) }} />
      {overPct > 0 ? (
        <div className="absolute inset-y-0 rounded-r-md bg-red-700" style={{ left: `${capPct}%`, width: `${overPct}%` }} />
      ) : null}
      {cap == null ? null : (
        <div className="absolute -inset-y-1 w-1 bg-white" style={{ left: `${capPct}%` }} title="働ける時間" />
      )}
      <div className="absolute inset-y-0 left-1.5 flex items-center whitespace-nowrap text-xs font-black text-white drop-shadow">
        {req > 0 ? `要る ${personDays(req, dayMinutes)}人日` : '要る 0'}
      </div>
      <div className="absolute inset-y-0 right-1.5 flex items-center whitespace-nowrap text-2xs font-bold text-white">
        {cap == null
          ? '働ける時間は測れません'
          : `働ける ${personDays(capV, dayMinutes)}人日（${workerCount}人×${workdays}日）`}
      </div>
    </div>
  );
}

/** 納期が来る日の山（週ごとの件数）。🚨 件数は Worker の buildWeeklyBreakdown（納期線の週にただ1つ）。 */
function WeekHills({ weeks }) {
  const list = arr(weeks);
  if (list.length === 0) return null;
  const mx = Math.max(1, ...list.map((w) => num(w.dueLotCount) || 0));
  return (
    <div title="納期が来る日の山（件数・週ごと・到着待ちを含む登録ぜんぶ）">
      <div className="mt-4 mb-3.5 flex h-8 items-end gap-1">
        {list.map((w) => {
          const n = num(w.dueLotCount) || 0;
          return (
            <div
              key={w.label}
              className="relative min-h-1 flex-1 rounded-t-sm bg-white/70"
              style={{ height: `${(n / mx) * 100}%` }}
              title={`${w.heading || w.label}：${n}件`}
            >
              <span className="absolute -top-4 left-0 right-0 text-center text-2xs font-black text-white">{n}</span>
              <span className="absolute -bottom-4 left-0 right-0 truncate text-center text-3xs font-bold text-white/90">{w.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 納期を過ぎた分（別枠）。どの月の「要る」にも「不足」にも足していない。 */
function OverdueTile({ overdue, dayMinutes }) {
  const lots = num(overdue && overdue.lotCount) || 0;
  const noArr = num(overdue && overdue.noArrivalLotCount) || 0;
  const pdays = personDays(overdue && overdue.minutes, dayMinutes);
  return (
    <div className="grid min-w-0 grid-rows-[auto_auto_1fr_auto] gap-1 rounded-2xl bg-red-600 px-3 py-2.5 text-white" data-month-tile="overdue">
      <div className="text-base font-black leading-tight">納期を過ぎた</div>
      <div className="text-4xl font-black leading-none tabular-nums">{lots}<span className="ml-0.5 text-base">件</span></div>
      <div className="text-2xs font-bold leading-snug text-white/95">
        要る {pdays == null ? '—' : `${pdays}人日`}
        <br />どの月の「要る」にも「不足」にも足していません（別枠）
      </div>
      <div className="text-2xs font-bold leading-snug text-white/95">うち手が付けられない（到着の予定が無い／過ぎた） {noArr}</div>
    </div>
  );
}

/** 月の札1枚。🚨 大きい字は答えだけ。 */
function MonthTile({ m, index, countPile, holdingWord, weeks, latestArrivalMs, workerCount, wide = false }) {
  const f = tileFacts(m, countPile, holdingWord);
  const tone = TONE[f.tone] || TONE.grey;
  const hatch = countPile && m.pile && num(m.pile.percent) != null && m.pile.percent >= 50;
  const isFirst = index === 0;
  const lotCount = num(m.lotCount) || 0;
  return (
    <div
      className={`grid min-w-0 grid-rows-[auto_auto_auto_1fr_auto] gap-1 rounded-2xl px-3.5 py-2.5 text-white ${tone.tile}`}
      data-month-tile={m.ym}
      data-month-verdict={m.verdict}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-black leading-none">{m.label}</span>
        <span className="truncate text-2xs font-bold text-white/90">{m.rangeLabel}</span>
      </div>
      {/* 🚨 答えの横に信号。色だけでなく形も変えるので、白黒で刷っても・色が見えなくても読める */}
      <div className={`flex items-center gap-2 font-black leading-tight ${f.answer.length > 8 ? 'text-xl' : 'text-2xl'} ${wide ? 'xl:text-3xl' : ''}`}>
        <Signal level={signalOfVerdict(m.verdict)} size="w-6 h-6" />
        <span className="min-w-0">{f.answer}</span>
      </div>
      <CapBar
        requiredMinutes={m.requiredMinutes}
        workableMinutes={m.workableMinutes}
        dayMinutes={m.dayMinutes}
        hatch={hatch}
        workerCount={workerCount}
        workdays={m.workdays}
      />
      <div className="min-w-0">
        {f.why ? <div className="text-2xs font-bold leading-snug text-white/95">{f.why}</div> : null}
        {isFirst ? <WeekHills weeks={weeks} /> : null}
        {!isFirst ? (
          <div className="mt-1 text-2xs font-bold leading-snug text-white/95">
            {/* 🚨 「登録◯件」は文字だけだった。点で並べると 1件 と 23件 が読まずに分かる。
                数字は札としてそのまま横に残す(情報を消さない)。 */}
            <Dots count={lotCount} cap={12} tone="quiet" size="w-2 h-2" className="mr-1 align-middle" title="この月に納期が来る登録の件数" />
            登録 {lotCount}件
            <br />先週との差：出せません（前の控えが無い）
            <br />入荷の登録は {latestArrivalMs == null ? '（記録なし）' : `${fmtMd(latestArrivalMs)} ぶんまで`}
            <br />登録が増えれば判定に変わります（押す物はありません）
          </div>
        ) : null}
      </div>
      {/* ⚠ 「日別の予定が未登録の◯人日は通常勤務として仮に置いています」(provisionalNote) は
          下の「根拠の文」に移した（消していない。札を短くして 1280×800 に収める為）。 */}
      {isFirst ? (
        <div className="text-2xs font-bold leading-snug text-white/90">
          {`山＝納期が来る週ごとの件数（${holdingWord}を含む登録ぜんぶ）・登録 ${lotCount}件（うち${holdingWord}・記録0件 ${num(m.pile && m.pile.lotCount) || 0}・納期が過ぎた ${num(m.overdue && m.overdue.lotCount) || 0} は左の赤へ）`}
        </div>
      ) : null}
    </div>
  );
}

/** 工程の行: 工程名／テンプレ／品目コード ・ 棒＝要る／黒線＝持てる人が働ける ・ 持てる人の札 */
function ProcessRow({ p, scale, dayMinutes, colors, hatch }) {
  const req = Math.max(0, num(p.requiredMinutes) || 0);
  const cap = Math.max(0, num(p.workableMinutes) || 0);
  const short = Math.max(0, num(p.shortMinutes) || 0);
  const reqPct = (req / scale) * 100;
  const capPct = (cap / scale) * 100;
  const shortPct = (short / scale) * 100;
  return (
    <div className="grid grid-cols-[minmax(10rem,14rem)_1fr_minmax(6rem,9rem)] items-center gap-2 py-1 text-xs" data-process-key={p.processKey}>
      <div className="min-w-0">
        <div className="truncate text-sm font-black text-slate-900">{p.title || p.processKey}</div>
        <div className="truncate text-2xs font-bold text-slate-600">
          ｜{p.templateName || 'テンプレ名なし'}
          {arr(p.models).length ? ` ｜${p.models.join('・')}${p.modelCount > p.models.length ? ` ほか${p.modelCount - p.models.length}品目コード` : ''}` : ''}
        </div>
      </div>
      <div className="relative h-4 rounded-md bg-slate-100">
        <div className="absolute inset-y-0 left-0 rounded-md bg-slate-600" style={{ width: `${reqPct}%`, ...(hatch ? HATCH_ON_LIGHT : null) }} />
        {short > 0 ? <div className="absolute inset-y-0 rounded-r-md bg-red-600" style={{ left: `${capPct}%`, width: `${shortPct}%` }} /> : null}
        <div className="absolute -inset-y-1 w-1 bg-slate-900" style={{ left: `${capPct}%` }} title={`持てる人が働ける ${personDays(cap, dayMinutes)}人日`} />
        <div className="absolute inset-y-0 flex items-center whitespace-nowrap pl-1 text-2xs font-black text-slate-900" style={{ left: `${reqPct}%` }}>
          {personDays(req, dayMinutes)}人日{short > 0 ? `（${personDays(short, dayMinutes)}人日 足りない）` : ''}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {arr(p.workers).map((w) => {
          const t = toneOf(colors, w);
          return (
            <span key={w} className={`rounded-md border bg-white px-1.5 text-2xs font-black ${t.border} ${t.text}`}>{w}</span>
          );
        })}
      </div>
    </div>
  );
}

/** 教育（決まり5）。材料3つの札と、設定値だけから出る「最大N組」。日数の見込みは出さない。 */
function EducationBox({ month, nextMonthFromMs, materials, maxOjtPairsPerDay, baseNow }) {
  const workdays = Math.max(0, num(month && month.workdays) || 0);
  const pairs = Math.max(0, num(maxOjtPairsPerDay) || 0);
  const slots = workdays * pairs;
  const mats = materials || {};
  const firstMs = num(mats.firstRecordMs);
  const months = firstMs == null ? null : monthsBetween(firstMs, baseNow);
  const nextMonthLabel = num(nextMonthFromMs) == null ? '来月1日' : fmtMd(nextMonthFromMs);
  return (
    <div className="grid min-h-0 grid-rows-[auto_auto_auto_1fr] gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5" data-month-education="1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-black text-slate-900">教育 ・ {nextMonthLabel} までに組める OJT</h3>
        <span className="text-2xs font-bold text-slate-500">設定値だけから</span>
      </div>
      <div>
        <div className="grid grid-cols-11 gap-1">
          {Array.from({ length: Math.min(slots, 44) }, (_, i) => (
            <i key={i} className="block aspect-square rounded-sm border border-slate-400 bg-slate-100" />
          ))}
        </div>
        <p className="mt-1.5 text-xs font-bold leading-snug text-slate-600">
          営業 {workdays}日 × 1日{pairs}組 ＝ 最大 <b className="text-base text-slate-900">{slots}組</b>
          {slots > 44 ? '（四角は44個まで）' : ''}（誰に何を、は下の3つが埋まると決まります）
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-dashed border-slate-400 px-2 py-1.5 text-center text-2xs font-bold text-slate-600">
          <Signal level={mats.teachMarksProvided && (num(mats.teachMarkCount) || 0) > 0 ? 'ok' : 'unknown'} size="w-4 h-4" className="mb-0.5" />
          <b className="block text-xl text-slate-900">{mats.teachMarksProvided ? (num(mats.teachMarkCount) ?? '—') : '—'}</b>
          🎓の印・「教えられる」の指名
          <span className="block text-3xs font-bold text-slate-500">{mats.teachMarksProvided ? '' : 'この計算には渡っていません'}</span>
        </div>
        <div className="rounded-lg border border-dashed border-slate-400 px-2 py-1.5 text-center text-2xs font-bold text-slate-600">
          <b className="block text-xl text-slate-900">{num(mats.traineeTaskCount) ?? '—'}</b>
          教育中として付いた作業の記録
        </div>
        <div className="rounded-lg border border-dashed border-slate-400 px-2 py-1.5 text-center text-2xs font-bold text-slate-600">
          <b className="block text-xl text-slate-900">{months == null ? '—' : `${months}か月`}</b>
          記録の長さ
          <span className="block text-3xs font-bold text-slate-500">{firstMs == null ? '完了の記録がありません' : `${fmtYmd(firstMs)} の完了から`}</span>
        </div>
      </div>
      <p className="text-2xs font-bold leading-snug text-slate-500">
        日数の見込みは出しません（材料が無い。検定の設定を1つ触ると数字が動く＝作り物になる）。
        誰に何を、は上の3つが埋まると決まります。
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
/**
 * @param {object} props
 * @param {object|null} props.monthly Worker が返した result.monthly（無ければ「計算中」）
 * @param {boolean} props.loading 計算中か
 * @param {string|null} props.error 計算の失敗（本体の error）
 * @param {string} [props.scopeKey] 見ている範囲（'onhand' | 'soon' | 'all'。条件・根拠タブと同じ状態）
 * @param {Function} [props.onScope] 範囲を変える（'all' を渡すと未完了ぜんぶ）
 * @param {object|null} [props.meta] Worker の result.meta（lotsIn / lotsScoped）
 */
export function MonthlyOutlook({
  monthly = null, loading = false, error = null, scopeKey = 'soon', onScope = null, meta = null,
  /* 決まり19B: 仮付与の引き直しと教育の材料。Worker への配線は別の担当。
     🚨 渡って来なくても画面が壊れない事（渡らなければ灰色で「まだ選べません」と出る）。 */
  decisionBoard = null, educationLeadTime = null,
}) {
  // 🚨 hooks はガード（return）より上（2026-08-27 の白画面の形を作らない）。
  const [countPile, setCountPile] = useState(true);
  /* 決まり19B: 主役の月（0=今月 / 1=来月 / 2=再来月）。既定は来月（この画面が答える問いが「来月」だから）。 */
  const [monthIndex, setMonthIndex] = useState(1);
  const colors = useMemo(() => buildWorkerColors(monthly && monthly.ok ? monthly.roster : []), [monthly]);
  // 窓の高さで工程の行数を決める（1280×800 でスクロール無しに収める）。px の決め打ちで描かない。
  const [winH, setWinH] = useState(() => (typeof window === 'undefined' ? 1080 : window.innerHeight));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!monthly) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm font-bold text-slate-600" data-opsim-monthly="waiting">
        {loading ? '月ごとの表を作っています（計算が終わると出ます）' : (error ? '計算が最後まで進まなかったので、月ごとの表は出せません' : '月ごとの表は、計算が終わると出ます')}
      </section>
    );
  }
  if (!monthly.ok) {
    return (
      <section className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800" data-opsim-monthly="error">
        月ごとの表を出せませんでした：{monthly.error || '理由が取れませんでした'}
      </section>
    );
  }

  const src = countPile ? monthly.withPile : monthly.withoutPile;
  const months = arr(src && src.months);
  const first = months[0] || null;
  const holdingWord = monthly.holdingWord || '到着待ち';
  const workerCount = arr(monthly.roster).length;
  const dayMinutes = monthly.dayMinutes;
  const firstWeeks = arr(monthly.weeks)[0] ? monthly.weeks[0].weeks : [];

  // 工程の行（今月）。重い順は Worker（monthly.js）が並べた順のまま。上位を出し、残りは畳む（消さない）。
  const procs = first ? arr(first.processes).filter((p) => !p.ownerUnknown) : [];
  const TOP = winH >= 900 ? 10 : 5;
  const scopeAll = scopeKey === 'all';
  const lotsIn = num(meta && meta.lotsIn);
  const lotsScoped = num(meta && meta.lotsScoped);
  const top = procs.slice(0, TOP);
  const rest = procs.slice(TOP);
  const scale = Math.max(1, ...procs.map((p) => Math.max(num(p.requiredMinutes) || 0, num(p.workableMinutes) || 0))) * 1.08;
  const procHatch = countPile && first && first.pile && num(first.pile.percent) != null && first.pile.percent >= 50;
  const unknownOwner = first ? (num(first.unknownOwnerProcessCount) || 0) : 0;
  const unc = (first && first.uncounted) || { estimateUnknownJobCount: 0, dueUnknownJobCount: 0, ownerUnknownProcessCount: 0 };

  return (
    <section className="grid gap-2" data-opsim-monthly="ready" data-count-pile={countPile ? '1' : '0'}>
      {/* ── 決まり19B（2026-09-04）: 主役は「来月の手当て」──────────────────────
          伝える1行:「来月、人は足りるか。足りないなら どの工程を・誰に・いつまでに 教えれば間に合うか」
          🚨 元の『月ごと』の表は1つも消していない。この下の折りたたみに全部そのまま在る。 */}
      {/* 🚨 2026-09-15 畳む: この画面(月ごと)を開いても、画面に出ていたのは
          「来月の手当て」そのものだった(実測: 17-月ごと と 19-来月の手当て の写しが
          帯の文字以外まったく同じ)。中身は1文字も消さず、**畳んで下へ弱める**。
          月ごとの問い＝「この先3か月、月ごとに何人日 足りないか。支度に使える営業日は残り何日か」 */}
      <details className="rounded-xl border border-slate-200 bg-white px-3 py-2" data-opsim-monthly-nextmonth-fold="1">
        <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 text-xs font-black text-slate-700">
          <Signal level={signalOfVerdict(first && first.verdict)} size="w-5 h-5" />
          <Glyph kind="person" className="w-4 h-4 text-slate-500" />
          <span>来月の手当て（どのテンプレを・誰に 教えるか）を開く</span>
        </summary>
        <div className="mt-2">
      <NextMonthPlan
        monthly={monthly}
        monthIndex={monthIndex}
        onMonthIndex={setMonthIndex}
        countPile={countPile}
        decisionBoard={decisionBoard}
        educationLeadTime={educationLeadTime}
        /* 見ている範囲。3か月を見る画面なので、絞っている時は判定より先にその事を言う */
        scopeKey={scopeKey}
        meta={meta}
        onScope={onScope}
        loading={loading}
        error={error}
      />
        </div>
      </details>

      {/* ── ここから下は 元の「月ごと」の中身（畳んだだけ・1つも消していない） ──
          🚨 2026-09-15: この画面の題は「月ごと」なので、月ごとの中身を **開いた状態** で出す。
             閉じていた為に、月ごとタブに月ごとの絵が1つも出ていなかった(実測)。 */}
      <details open className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" data-opsim-monthly-legacy="1">
        <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-2 text-xs font-black text-slate-700">
          {/* 閉じていても3か月の色と形がここで読める(文字を隠しても3つの信号が残る) */}
          <span className="inline-flex items-center gap-1" aria-hidden="true">
            {months.map((mm) => <Signal key={mm.ym || mm.label} level={signalOfVerdict(mm.verdict)} size="w-5 h-5" title={mm.label} />)}
          </span>
          <span>この先3か月（3か月の札・週の山・工程ごとの棒・教育のOJT枠・根拠の文）</span>
        </summary>
        <div className="mt-2 grid gap-2">
      {/* 見出し（問い）と、いつの計算か */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black text-slate-900">この先3か月 人は足りる？</h2>
        <span className="text-2xs font-bold text-slate-500" data-month-scope={scopeAll ? 'all' : undefined}>
          基準 {fmtMdHm(monthly.baseNow)} ・ {workerCount}人
          ・ 計算に載せたロット {lotsScoped == null ? '—' : `${lotsScoped}件`}{lotsIn == null ? '' : `／渡された ${lotsIn}件`}
          {scopeAll ? ' ・ 範囲は未完了ぜんぶ' : ''}
          ・ 判定は「今月末まで」＝一月前に分かれば教育の準備が間に合う範囲
        </span>
      </div>

      {/* 見ている範囲。🚨 3か月を見る画面なのに範囲が「未完了ぜんぶ」でない時は、その事を先に言う
          （10月の登録が0件に見えるのは、範囲で切れているだけ、という事がある）。全部の時はこの帯は出ない。 */}
      {scopeAll ? null : (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-900" data-month-scope={scopeKey}>
        <span>
          見ている範囲を⚙ 設定 で絞っています（載せた {lotsScoped == null ? '—' : `${lotsScoped}件`}／渡された {lotsIn == null ? '—' : `${lotsIn}件`}）。
          3か月ぶんの登録は、範囲を広げないと月の箱に入りません
        </span>
        {typeof onScope === 'function' ? (
          <button
            type="button"
            onClick={() => onScope('all')}
            className="ml-auto min-h-11 rounded-lg border border-amber-500 bg-white px-3 text-xs font-black text-amber-900 hover:bg-amber-100"
            title="見ている範囲を「未完了ぜんぶ」にして計算し直します（時間がかかります。何も保存しません）"
          >
            未完了ぜんぶで計算し直す
          </button>
        ) : null}
      </div>
      )}

      {/* 切替（到着待ち・記録0件の山を数える／数えない）と、色の凡例 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-600">{holdingWord} {num(monthly.pileLotCount) || 0}件（作業の記録0件）を</span>
        <div className="inline-flex overflow-hidden rounded-lg border-2 border-slate-900" role="group" aria-label="到着待ちの山を数えるか">
          <button
            type="button"
            onClick={() => setCountPile(true)}
            aria-pressed={countPile}
            className={`min-h-11 px-3 text-sm font-black ${countPile ? 'bg-slate-900 text-white' : 'bg-white text-slate-900'}`}
          >
            これからやる仕事として数える
          </button>
          <button
            type="button"
            onClick={() => setCountPile(false)}
            aria-pressed={!countPile}
            className={`min-h-11 px-3 text-sm font-black ${!countPile ? 'bg-slate-900 text-white' : 'bg-white text-slate-900'}`}
          >
            数えない
          </button>
        </div>
        <span className="text-2xs font-bold text-slate-500">記録が無いだけか本当に未着手か、この記録では分かりません</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {['ok', 'tight', 'short', 'grey'].map((k) => (
            <span key={k} className={`rounded-md px-2 py-0.5 text-2xs font-black text-white ${TONE[k].pill}`}>{TONE[k].label}</span>
          ))}
        </div>
      </div>

      {/* 札: 左に「納期を過ぎた」の赤い箱、右に3か月（今月が広い） */}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(8rem,9rem)_1.7fr_1fr_1fr]">
        <OverdueTile overdue={src.overdue} dayMinutes={dayMinutes} />
        {months.map((m, i) => (
          <MonthTile
            key={m.ym || i}
            m={m}
            index={i}
            countPile={countPile}
            holdingWord={holdingWord}
            weeks={firstWeeks}
            latestArrivalMs={monthly.latestArrivalMs}
            workerCount={workerCount}
            wide={i === 0}
          />
        ))}
      </div>

      {/* 下: 今月の工程ごと（棒＝要る／黒線＝持てる人が働ける／持てる人の札）と 教育 */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-[2fr_1fr]">
        <div className="grid min-h-0 grid-rows-[auto_1fr_auto] gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-black text-slate-900">{first ? first.label : '今月'} 工程ごと ・ 棒＝要る ／ 黒線＝持てる人が働ける</h3>
            <span className="text-2xs font-bold text-slate-500">
              {countPile ? '数える' : '数えない'}側 ・ 重い順{Math.min(TOP, procs.length)}件／全{first ? arr(first.processes).length : 0}工程 ・ 線を越えた分が赤（{first ? `今は${num(first.shortProcessCount) || 0}` : '—'}）・ 足しても全体にはならない
            </span>
          </div>
          <div className="min-h-0">
            {top.length === 0 ? (
              <div className="p-2 text-xs font-bold text-slate-500">
                要る時間が 0（{countPile ? 'この月に納期が来る仕事がありません' : `${holdingWord}を外すと工程の行が残りません`}）
              </div>
            ) : top.map((p) => (
              <ProcessRow key={p.processKey} p={p} scale={scale} dayMinutes={dayMinutes} colors={colors} hatch={procHatch} />
            ))}
            {rest.length > 0 ? (
              <details className="mt-1">
                <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-black text-cyan-700">…ほか {rest.length}工程（開く）</summary>
                {rest.map((p) => (
                  <ProcessRow key={p.processKey} p={p} scale={scale} dayMinutes={dayMinutes} colors={colors} hatch={procHatch} />
                ))}
              </details>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-slate-400 px-3 py-1.5 text-xs font-bold text-slate-600">
            <span><b className="mr-1 text-xl text-slate-900">{unknownOwner}</b>工程は 持てる人が分かりません（実績も設定も無い ＝ やれない、ではない）</span>
            <span className="text-slate-400">｜</span>
            <span>数えていない: 見積り不明 {num(unc.estimateUnknownJobCount) || 0}件 ・ 納期不明 {num(unc.dueUnknownJobCount) || 0}件</span>
          </div>
        </div>
        <EducationBox
          month={first}
          nextMonthFromMs={months[1] ? months[1].fromMs : null}
          materials={monthly.materials}
          maxOjtPairsPerDay={monthly.maxOjtPairsPerDay}
          baseNow={monthly.baseNow}
        />
      </div>

      {/* 根拠の文（畳む。消さない）。Worker の headline / notes をそのまま。 */}
      <details className="rounded-xl border border-slate-200 bg-white px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-black text-slate-700">月ごとの根拠の文（計算がそのまま言っている事）</summary>
        <div className="mt-2 grid gap-2">
          {months.map((m) => (
            <div key={m.ym} className="text-xs leading-snug text-slate-700">
              <div className="font-black text-slate-900">{m.headline}</div>
              {m.subline ? <div>{m.subline}</div> : null}
              {m.unjudgeableWhy ? <div>{m.unjudgeableWhy}</div> : null}
              <div>{m.uncountedSentence}</div>
              {m.provisionalNote ? <div>{m.provisionalNote}</div> : null}
              {arr(m.notes).map((n, i) => <div key={i} className="text-slate-500">{n}</div>)}
            </div>
          ))}
          <div className="text-2xs font-bold text-slate-500">
            納期が無い仕事 {num(src.outside && src.outside.noDueJobCount) || 0}件 ・ 3か月より先に納期が来る仕事 {num(src.outside && src.outside.afterLastMonthJobCount) || 0}件 は、どの月にも入っていません。
          </div>
        </div>
      </details>
        </div>
      </details>
      {/* ── 元の「月ごと」の中身 ここまで ── */}
    </section>
  );
}

export default MonthlyOutlook;
