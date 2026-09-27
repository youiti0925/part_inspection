// =============================================================================
//  src/opsim/vizKit.jsx — 絵の語彙。21画面が同じ見た目になる為の小さな部品7つ。
// -----------------------------------------------------------------------------
//  清水さん(2026-09-15)「文字ばっかりじゃなくてグラフとかイラストとかで分かりやすく」
//
//  【採点法】2026-09-03 に決めた「文字を全部隠した写真で何が分かるか」。
//    芯 = 「色・長さ・位置で答え、文字は札だけ」。
//
//  【実測で分かった事(2026-09-15 1740x1020 の写し21枚)】
//    ・絵がまともに在るのは 分析(14.4%) と 全体進捗(10.7%) の2画面だけ。
//    ・その2画面は App.jsx の中に **その場限りの markup** で描いてある。
//      共有部品が無いから、他の19画面へ1つも広がらなかった。← これがこのファイルを作る理由。
//    ・星取表は押す物が1177個も在るのに notext の写真が **ほぼ真っ白**。
//      星を ★◎○ の **文字** で描いていたので、文字を消すと絵が1つも残らない。
//      ⇒ 星は Signal / Glyph（SVG）で描く。文字で描かない。
//
//  🚨🚨🚨 この部品は **数を作らない**。渡された値を長さ・位置・色に変えるだけ。
//     ・新しい集計をここで書かない。画面がいま持っている値をそのまま渡す。
//     ・渡されなければ **何も描かない**（点線の枠＝「読めていません」を出す）。
//       0 と「読めていません」を同じ絵にしない。
//     ・並べる為の割り算（value/max）はするが、その答えを **数字として画面に出さない**。
//       数字を出すのは呼ぶ側。だから「同じ数字を2つの計算から出さない」を破らない。
//
//  🚨 色は決まりのファイルから借りる。ここで rose / amber を直書きしない。
//     赤(rose)=遅れ専用 lateTone.js ／ 橙(amber)=空き(スキル待ち)専用 idleTone.js
//     工場の色 製品=cyan・最終=violet は人や量に使わない。
//  🚨 色だけで見分けさせない(workerColors.js の決まり)。Signal は色と **形** を両方変える。
//     Avatar は必ず名前の文字を横に置く。
//  🚨 src/opsim/ の下なので **px の直書き禁止**(見張り L5)。大きさは class で渡す。
//     SVG の viewBox の数は単位が無いので px ではない(これは可)。
//  🚨 外の絵の部品(npm)を増やさない。SVG は手で書く。
//  🚨 製品検査と最終検査で **md5 の対**。片方だけ直さない。改行は LF で揃える。
// =============================================================================
import React from 'react';
import { measured } from './workloadMeter.js';
import { LATE_TONE } from './lateTone.js';
import { KIND_TONE } from './idleTone.js';
import { IDLE_KIND } from '../domain/operationsSimulation/idleReason.js';

// --- 色の表 ---------------------------------------------------------------
//  遅れ=赤 / 空き=橙 / 進み=緑 / ただの量=青 / 静かな量=灰。
//  赤と橙は決まりのファイルから借りる(直書きすると 2026-09-05 の
//  「遅れと空きがほぼ同じ色」がまた起きる)。
const VIZ_TONE = Object.freeze({
  late:     Object.freeze({ bar: LATE_TONE.past.bar,     dot: LATE_TONE.past.dot,     text: LATE_TONE.past.text,     fill: '#f43f5e' }),
  lateSoon: Object.freeze({ bar: LATE_TONE.forecast.bar, dot: LATE_TONE.forecast.dot, text: LATE_TONE.forecast.text, fill: '#fda4af' }),
  idle:     Object.freeze({ bar: KIND_TONE[IDLE_KIND.SKILL].bar, dot: 'bg-amber-500', text: KIND_TONE[IDLE_KIND.SKILL].text, fill: '#f59e0b' }),
  ahead:    Object.freeze({ bar: 'bg-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-700', fill: '#10b981' }),
  plain:    Object.freeze({ bar: 'bg-sky-600',     dot: 'bg-sky-600',     text: 'text-sky-700',     fill: '#0284c7' }),
  quiet:    Object.freeze({ bar: 'bg-slate-400',   dot: 'bg-slate-400',   text: 'text-slate-600',   fill: '#94a3b8' }),
});
const toneOfKey = (k) => VIZ_TONE[k] || VIZ_TONE.plain;

/** 読めていない時の共通の見た目。0 とは違う絵にする。 */
const UNKNOWN_BOX = 'rounded border border-dashed border-slate-400 bg-transparent';

// =============================================================================
//  1. Bar — 1つの量を長さで見せる
// -----------------------------------------------------------------------------
//  分析①「工程別の時間」で実際に読めている形(灰の溝＋色の棒)をそのまま部品にした物。
//  markAt は 分析② の赤い点線＝目標。位置だけ。値は呼ぶ側が文字で出す。
//  @param {number|string|null} value 長さにする量(そのまま渡す。ここで足さない)
//  @param {number|string|null} max   目盛りの上限(同じ行で比べる物は必ず同じ max を渡す)
//  @param {string} tone  'late'|'lateSoon'|'idle'|'ahead'|'plain'|'quiet'
//  @param {string} height 'h-1.5'(行内) | 'h-3'(標準) | 'h-5'(主役)
//  @param {number|null} markAt 目盛りの上に立てる線の値(目標など)。null なら出さない
// =============================================================================
export function Bar({ value, max, tone = 'plain', height = 'h-3', markAt = null, title = '', className = '' }) {
  const v = measured(value);
  const m = measured(max);
  const t = toneOfKey(tone);
  if (v == null || m == null || m <= 0) {
    // 🚨 読めていない。0 の棒(＝長さ0の色)ではなく点線の枠を出す。
    return <div className={`${height} ${UNKNOWN_BOX} ${className}`} title={title || '読めていません'} aria-label="読めていません" />;
  }
  const pct = Math.min(100, (v / m) * 100);
  const mk = measured(markAt);
  const mkPct = mk == null ? null : Math.min(100, (mk / m) * 100);
  return (
    <div className={`relative ${height} overflow-hidden rounded bg-slate-100 ${className}`} title={title} aria-hidden="true">
      <div className={`h-full ${t.bar}`} style={{ width: `${pct}%` }} />
      {mkPct == null ? null : (
        <div className="absolute inset-y-0 border-l-2 border-dashed border-rose-600" style={{ left: `${mkPct}%` }} />
      )}
    </div>
  );
}

// =============================================================================
//  2. StackBar — 内訳を1本の帯で(働いている/待ち/空き など)
// -----------------------------------------------------------------------------
//  🚨 total を渡さない時は、渡した区間だけで帯を埋める(並べる為の割り算)。
//     その合計を **数字として画面に出さない**。数字は呼ぶ側が出す。
//  @param {Array<{key:string, value:number, tone:string, title?:string}>} segments
//  @param {number|null} total 帯の全長にあたる量。渡すと「余り」が灰の溝で見える
// =============================================================================
export function StackBar({ segments = [], total = null, height = 'h-3', className = '' }) {
  const segs = (Array.isArray(segments) ? segments : [])
    .map((s) => (s && typeof s === 'object' ? { ...s, v: measured(s.value) } : null))
    .filter((s) => s && s.v != null && s.v > 0);
  const given = measured(total);
  const sum = segs.reduce((a, s) => a + s.v, 0);
  const denom = given != null && given > 0 ? given : sum;
  if (!segs.length || denom <= 0) {
    return <div className={`${height} ${UNKNOWN_BOX} ${className}`} title="読めていません" aria-label="読めていません" />;
  }
  return (
    <div className={`flex ${height} overflow-hidden rounded bg-slate-100 ${className}`} aria-hidden="true">
      {segs.map((s) => (
        <div key={s.key} className={`h-full ${toneOfKey(s.tone).bar}`} style={{ width: `${(s.v / denom) * 100}%` }} title={s.title || ''} />
      ))}
    </div>
  );
}

// =============================================================================
//  3. Spark — 時間で変わる量を小さな折れ線で
// -----------------------------------------------------------------------------
//  🚨 点が2つ未満なら描かない(1点の折れ線は嘘になる)。
//  🚨 lo/hi を渡さない時は渡された点の幅に合わせる。これは **描く為の枠** であって、
//     最大・最小を数字として画面に出す物ではない。
//  @param {Array<number>} points 古い順。歯抜けは呼ぶ側で落としてから渡す
//  @param {string} className 'w-8 h-3'(小) | 'w-16 h-4'(標準)
// =============================================================================
export function Spark({ points = [], min = null, max = null, tone = 'plain', className = 'w-8 h-3' }) {
  const ds = (Array.isArray(points) ? points : []).map(measured).filter((v) => v != null);
  if (ds.length < 2) {
    return <span className={`inline-block ${className} ${UNKNOWN_BOX}`} title="読めていません" aria-label="読めていません" />;
  }
  const lo0 = measured(min) ?? Math.min(...ds);
  const hi0 = measured(max) ?? Math.max(...ds);
  const span = hi0 - lo0 || 1;
  const W = 60, H = 20, PAD = 2;           // viewBox の中の数。単位が無いので px ではない
  const step = (W - PAD * 2) / (ds.length - 1);
  const d = ds.map((v, i) => `${PAD + i * step},${H - PAD - ((v - lo0) / span) * (H - PAD * 2)}`).join(' ');
  const t = toneOfKey(tone);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`inline-block ${className}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" stroke={t.fill} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// =============================================================================
//  4. Dots — 件数を点の並びで(10件=10個)
// -----------------------------------------------------------------------------
//  数が少ない時は、数字を読むより点を見る方が速い。
//  分析②の「1台ずつの点」が実測で読めていた形。
//  🚨 count を数えるのは呼ぶ側。ここは並べるだけ。
//  @param {number} count 何個描くか
//  @param {number} cap   これを越えたら「＋」を1つ足して打ち切る(並べ過ぎない為)
// =============================================================================
export function Dots({ count, cap = 10, tone = 'plain', size = 'w-2 h-2', className = '', title = '' }) {
  const n = measured(count);
  if (n == null) {
    return <span className={`inline-block w-4 h-2 ${UNKNOWN_BOX} ${className}`} title="読めていません" aria-label="読めていません" />;
  }
  const whole = Math.floor(n);
  const shown = Math.min(whole, cap);
  const t = toneOfKey(tone);
  return (
    <span className={`inline-flex flex-wrap items-center gap-0.5 ${className}`} title={title} aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className={`inline-block ${size} rounded-full ${t.dot}`} />
      ))}
      {whole > cap ? <span className={`inline-block ${size} rounded-full border border-dashed ${t.text} border-current`} /> : null}
      {whole === 0 ? <span className={`inline-block ${size} rounded-full border border-slate-300`} /> : null}
    </span>
  );
}

// =============================================================================
//  5. Signal — 危ない / 気を付ける / 大丈夫 を丸1つで
// -----------------------------------------------------------------------------
//  🚨 色だけで見分けさせない(workerColors.js の決まり)。**形も変える**:
//     危ない=中に縦棒 / 気を付ける=三角 / 大丈夫=塗った丸 / 分からない=点線の輪
//     色が見えない人・白黒で刷った時でも読める。
//  🚨 星取表の ★◎○ はこれで描き替える(文字で描くと notext で消える＝実測済み)。
//  @param {string} level 'danger'|'warn'|'ok'|'unknown'
// =============================================================================
export function Signal({ level = 'unknown', size = 'w-4 h-4', className = '', title = '' }) {
  const spec = {
    danger: { fill: VIZ_TONE.late.fill, label: '危ない' },
    warn: { fill: VIZ_TONE.idle.fill, label: '気を付ける' },
    ok: { fill: VIZ_TONE.ahead.fill, label: '大丈夫' },
    unknown: { fill: '#94a3b8', label: '分かりません' },
  }[level] || { fill: '#94a3b8', label: '分かりません' };
  const body = level === 'warn'
    ? <polygon points="10,2 18,17 2,17" fill={spec.fill} />
    : level === 'unknown'
      ? <circle cx="10" cy="10" r="7" fill="none" stroke={spec.fill} strokeWidth="2" strokeDasharray="3 3" />
      : <circle cx="10" cy="10" r="8" fill={spec.fill} />;
  return (
    <svg viewBox="0 0 20 20" className={`inline-block shrink-0 ${size} ${className}`} role="img" aria-label={title || spec.label}>
      <title>{title || spec.label}</title>
      {body}
      {level === 'danger' ? <rect x="9" y="5" width="2" height="7" rx="1" fill="#ffffff" /> : null}
      {level === 'danger' ? <rect x="9" y="13" width="2" height="2" rx="1" fill="#ffffff" /> : null}
    </svg>
  );
}

// =============================================================================
//  6. Avatar — 人の色の丸 + 頭文字
// -----------------------------------------------------------------------------
//  全体進捗の作業者カード(実測で一番読めていた形)の丸を部品にした物。
//  🚨 色は呼ぶ側が workerColors.js の buildWorkerColors/toneOf で決めて **渡す**。
//     ここで名前から色を決めない(同じ人が画面ごとに違う色になる)。
//  🚨 実データの作業者は4人。7人目から色が重なるので **色だけで見分けさせない**。
//     だから名前を必ず横に置く(showName 既定 true)。
//  @param {object|null} tone workerColors.js の toneOf(colorMap, name) の戻り
// =============================================================================
export function Avatar({ name, tone = null, size = 'w-7 h-7', showName = true, className = '' }) {
  const nm = typeof name === 'string' ? name.trim() : '';
  const t = tone && typeof tone === 'object' ? tone : null;
  const dot = t && t.dot ? t.dot : 'bg-slate-400';
  const txt = t && t.text ? t.text : 'text-slate-600';
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${size} ${dot} font-bold text-white`}
        title={nm || '名前が読めていません'}
        aria-hidden="true"
      >
        <span className="fi-tap-text leading-none">{nm ? nm.slice(0, 1) : '?'}</span>
      </span>
      {showName ? <span className={`fi-tap-text truncate font-bold ${txt}`}>{nm || '(名前なし)'}</span> : null}
    </span>
  );
}

// =============================================================================
//  7. Glyph — ロット / 工程 / 設備 / 区画 を表す小さな線画(手書きSVG)
// -----------------------------------------------------------------------------
//  🚨 npm を増やさない。lucide は既に入っているが、ここは
//     「この4つは必ず同じ絵」を守る為に手で書いて1か所に閉じる。
//  @param {string} kind 'lot'|'step'|'equipment'|'zone'|'due'|'person'
// =============================================================================
const GLYPH_PATH = Object.freeze({
  // 箱＝ロット
  lot: { d: 'M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4 M12 11v10', label: 'ロット' },
  // 四角が矢印で繋がる＝工程
  step: { d: 'M3 9h5v6H3z M16 9h5v6h-5z M9 12h6 M13 10l2 2-2 2', label: '工程' },
  // 歯車の芯＝設備
  equipment: { d: 'M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M6 6l2 2 M16 16l2 2 M18 6l-2 2 M8 16l-2 2', label: '設備' },
  // 枠で囲った床＝区画
  zone: { d: 'M3 4h18v16H3z M3 10h18 M9 10v10', label: '区画' },
  // 旗＝納期
  due: { d: 'M5 3v18 M5 4h12l-2.5 4L17 12H5', label: '納期' },
  // 人
  person: { d: 'M12 4a4 4 0 100 8 4 4 0 000-8z M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7', label: '人' },
});
export function Glyph({ kind, className = 'w-4 h-4', title = '' }) {
  const g = GLYPH_PATH[kind];
  if (!g) return null;          // 🚨 知らない種類は描かない(適当な絵を出さない)
  return (
    <svg viewBox="0 0 24 24" className={`inline-block shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={title || g.label}>
      <title>{title || g.label}</title>
      <path d={g.d} />
    </svg>
  );
}

export default { Bar, StackBar, Spark, Dots, Signal, Avatar, Glyph, VIZ_TONE };
