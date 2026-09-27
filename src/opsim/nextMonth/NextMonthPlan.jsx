// =============================================================================
//  opsim/nextMonth/NextMonthPlan.jsx — 「来月の手当て」
// -----------------------------------------------------------------------------
//  この画面が答える1行（決まり19B・これ以外は置かない）:
//    「来月、人は足りるか。足りないなら どの工程を・誰に・いつまでに 教えれば間に合うか」
//
//  ■ 上からの順（案B＝工程が主役。採点で合格した形）
//    ① 答えの1行（いちばん大きい字。件数ではない）
//    ② 月の棒3本（今月・来月・再来月）＝ 押すと主役の月が変わる。**主役にしない**（小さく1行）
//    ③ 工程の行（主役）… 帯の長さ＝要る時間 ／ 赤＝足りない時間 ／ 橙＝持てる人が分からない
//    ④ その工程を持てる人（名前）と、仮付与で引き直した効き目
//    ⑤ 足りない材料の札（教育）。🚨 日数は1文字も出さない（決まり5）
//
//  ■ 色の意味（文字を隠しても読める事）
//    赤＝時間が足りない ／ 橙＝持てる人が分からない ／ 緑＝回る ／ 灰＝まだ判定していません
//    斜線＝到着待ちで作業の記録が0件の山が半分以上（＝この月の数字は信用しきれない）
//
//  ■ 守っている決まり
//    決まり1  中身の無い月を「回ります」と言わせない（model.js の THIN_MONTH_RATIO）
//    決まり2  登録がこれからの月は「登録◯件（これから）」と言い、数字を出さない
//    決まり4  1つの数に丸めない。要る／働ける／不足／分かりません を別々に
//    決まり5  教育の逆算日は出さない。材料の札まで
//    決まり6  大きい字は答え。px 直書きなし（全部 rem 段）。zoom / transform:scale を使わない
//    決まり12 品目コードにテンプレを添える
//    2026-08-20「実績が無い＝できない」と書かない。「記録が無い＝分かりません」まで
// =============================================================================

import React, { useMemo } from 'react';
import { buildNextMonthView, NM_TONE } from './model.js';
import { WorkloadMeter } from '../WorkloadMeter.jsx';
import { Signal, Dots, Glyph } from '../vizKit.jsx';

const num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
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
const fmtMdHm = (ms) => {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 色は4つ＋きわどい。人の色（workerColors）とはぶつけない。 */
const TONE = Object.freeze({
  [NM_TONE.SHORT]: { solid: 'bg-red-600', text: 'text-red-700', ring: 'border-red-600', label: '足りません' },
  [NM_TONE.OWNER_UNKNOWN]: { solid: 'bg-amber-500', text: 'text-amber-700', ring: 'border-amber-500', label: '持てる人が分かりません' },
  [NM_TONE.TIGHT]: { solid: 'bg-yellow-500', text: 'text-yellow-700', ring: 'border-yellow-500', label: 'きわどい' },
  [NM_TONE.OK]: { solid: 'bg-green-600', text: 'text-green-700', ring: 'border-green-600', label: '回ります' },
  [NM_TONE.UNKNOWN]: { solid: 'bg-slate-500', text: 'text-slate-700', ring: 'border-slate-500', label: 'まだ判定していません' },
});
const toneOf = (t) => TONE[t] || TONE[NM_TONE.UNKNOWN];
/** 判定の段 → 信号の段。🚨 色だけでなく **形** を変える(丸に縦棒/三角/塗った丸/点線の輪)。
    白黒で刷っても、色が見えない人にも読める。描画関数の中では定義しない(ここに1つだけ置く)。 */
const SIGNAL_OF = Object.freeze({
  [NM_TONE.SHORT]: 'danger',
  [NM_TONE.OWNER_UNKNOWN]: 'warn',
  [NM_TONE.TIGHT]: 'warn',
  [NM_TONE.OK]: 'ok',
  [NM_TONE.UNKNOWN]: 'unknown',
});
const signalOf = (t) => SIGNAL_OF[t] || 'unknown';

/** 斜線＝到着待ち・記録0件の山が半分以上（この月の数字は信用しきれない） */
const HATCH_DARK = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,.42) 0 .3rem, rgba(0,0,0,.12) .3rem .6rem)',
});

// -----------------------------------------------------------------------------
// ① 答えの1行
// -----------------------------------------------------------------------------
function AnswerLine({ view }) {
  const t = toneOf(view.tone);
  const sel = view.selected || {};
  const until = num(view.workdaysUntilStart);
  const hatchPct = sel.pile ? num(sel.pile.percent) : null;
  const hatchMonth = hatchPct != null && hatchPct >= 50;
  const holdingWord = view.holdingWord;
  return (
    <section
      className={`overflow-hidden rounded-2xl border-4 bg-white ${t.ring}`}
      data-nm-answer={view.tone}
      data-nm-month={sel.ym || ''}
    >
      {/* 🚨 答えの帯は色で塗る。文字を隠した写真でも「赤／橙／緑／灰」がひと目で分かる為 */}
      <div className={`px-4 py-3 ${t.solid}`}>
        <h2 className="text-2xl font-black leading-tight text-white drop-shadow-sm">{view.answer}</h2>
      </div>
      {/* 🚨 斜線＝この月の仕事の半分以上が「到着待ちで作業の記録0件」＝ 数字を信用しきれない。
          文字を隠しても分かるように、答えの帯のすぐ下に横いっぱいで敷く。 */}
      {hatchMonth ? (
        <div className="h-2.5 w-full" style={HATCH_DARK} title={`この月の仕事の${hatchPct}%が ${holdingWord}で作業の記録0件です（数字を信用しきれません）`} data-nm-hatch="1" />
      ) : null}
      <div className="grid items-start gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)]">
        <div className="grid min-w-0 gap-2">
        {view.why ? <p className="text-sm font-bold leading-snug text-slate-700">{view.why}</p> : null}
        {/* 🚨 決まり28（2026-09-05 清水さん「まわりますって言われてもどういう意味？何を根拠で」）:
            判定の横に **式**。engine の数を並べるだけ（model.js formulaOf）。判定を出さない月は出ない。 */}
        {view.formula && view.formula.sentence ? (
          <details className="rounded-md bg-slate-100 px-2 text-xs text-slate-800">
            <summary className="flex min-h-11 cursor-pointer items-center font-bold">計算の根拠を開く</summary>
          <p className="pb-2 font-black tabular-nums" data-nm-formula="1">
            根拠：{view.formula.sentence}
          </p>
          </details>
        ) : null}
        {/* 🚨 決まり28: 異常なら「ここがおかしい」を名指し（数は Worker が運んだ物だけ）。無ければ何も出さない。 */}
        {arr(view.alerts).length ? (
          <ul className="flex flex-wrap gap-1.5" data-nm-alerts={arr(view.alerts).length}>
            {arr(view.alerts).map((a) => (
              <li
                key={a.key}
                data-nm-alert={a.key}
                className={`rounded-md border px-2 py-0.5 text-2xs font-black ${a.tone === 'red'
                  ? 'border-rose-400 bg-rose-50 text-rose-800'
                  : a.tone === 'amber' ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-300 bg-slate-50 text-slate-700'}`}
              >
                {a.tone === 'red' ? '⚠ ' : ''}{a.text}
              </li>
            ))}
          </ul>
        ) : null}
        {/* 🚨 ここには「営業◯日」が2つ出る（月まるごとの長さ と、月が始まるまでの日数）。
            **どちらが何を数えた日数か** を必ず言葉で分ける（2026-09-05）。
            言葉が無いと、同じ画面に 22日 と 18日 が並んで「どっちが本当か」になる。 */}
        <details className="text-xs text-slate-600">
          <summary className="flex min-h-11 cursor-pointer items-center font-bold">月の期間・支度に使える日数</summary>
        {/* 🚨 月ごと画面の主目的＝教育のリードタイム(2026-08-31「一月前に分かれば準備が間に合う」)。
            「支度に使えるのは 営業◯日」は畳みの中の **文字** でしか出ていなかった(notext で真っ白)。
            畳みの外へ 四角の並び だけ出す。日数の数字は畳みの中の文にそのまま残す。
            🚨 教育に何日かかるかの見込みではない。暦の営業日を並べているだけ。 */}
        {until == null || until <= 0 ? null : (
          <span className="mb-1 inline-flex items-center gap-1 align-middle">
            <Glyph kind="due" className="w-4 h-4 text-slate-500" title="この月が始まるまで" />
            <Dots count={until} cap={22} tone="plain" size="w-2 h-2" title="今日からこの月が始まるまでの営業日" />
          </span>
        )}
        <p className="pb-2" data-nm-days="1">
          {sel.rangeLabel ? <span data-nm-days-kind="month-span">この月の長さ：{sel.rangeLabel}</span> : null}
          {sel.rangeLabel && until != null ? <span className="mx-1 text-slate-300">｜</span> : null}
          {until == null ? '' : (until > 0
            ? <span data-nm-days-kind="until-start">支度に使えるのは 今日からこの月が始まるまでの 営業{until}日（暦だけから言える事です。教えるのに何日かかるかは出していません）</span>
            : <span data-nm-days-kind="until-start">この月はもう始まっています</span>)}
        </p>
        </details>
        </div>
        <WorkloadMeter
          required={view.tone === NM_TONE.UNKNOWN ? null : sel.requiredMinutes}
          capacity={view.tone === NM_TONE.UNKNOWN ? null : sel.workableMinutes}
          requiredLabel={view.tone === NM_TONE.UNKNOWN ? '未判定' : `${num(sel.requiredPersonDays) ?? '—'}人日`}
          capacityLabel={view.tone === NM_TONE.UNKNOWN ? '未判定' : `${num(sel.workablePersonDays) ?? '—'}人日`}
          label={`${sel.label || '選んだ月'}の時間の比較`}
        />
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// ② 月の棒3本（主役にしない。押すと主役の月が変わる）
// -----------------------------------------------------------------------------
function MonthBar({ m, selected, onPick }) {
  const t = toneOf(m.tone);
  const req = Math.max(0, num(m.requiredMinutes) || 0);
  const cap = num(m.workableMinutes);
  const capV = cap == null ? 0 : Math.max(0, cap);
  const scale = Math.max(req, capV, 1) * 1.12;
  const reqPct = (req / scale) * 100;
  const capPct = (capV / scale) * 100;
  const overPct = req > capV ? ((req - capV) / scale) * 100 : 0;
  const hatch = m.pile && num(m.pile.percent) != null && m.pile.percent >= 50;
  const ownerUnknown = Math.max(0, Math.trunc(num(m.unknownOwnerProcessCount) || 0));
  return (
    <button
      type="button"
      onClick={() => onPick(num(m.index))}
      aria-pressed={selected}
      data-nm-month-bar={m.ym || m.label}
      data-nm-month-tone={m.tone}
      title={`${m.label}：${m.answer}${m.why ? ` — ${m.why}` : ''}`}
      className={`grid min-w-0 gap-1 rounded-xl border-2 px-2.5 py-1.5 text-left transition
        ${selected ? `${t.ring} bg-white shadow-sm` : 'border-slate-200 bg-slate-50 hover:bg-white'}`}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-base font-black leading-none text-slate-900">{m.label}</span>
        <Signal level={signalOf(m.tone)} size="w-5 h-5" />
      </div>
      {/* 同じ物差しの棒2本ぶん（要る＝濃い／働ける＝白い線）。灰の月は棒を出さない＝「余裕がある」と読ませない */}
{/* 🚨 「登録がこれから」の月は 棒を出さない(余裕があると読ませない)。
            代わりに **点で件数**を出す。1件と23件が、数字を読まずに区別できる。
            🚨 ここに 要る／働ける の人日を出してはいけない(見張り B3)。点は件数であって人日ではない。 */}
      {m.tone === NM_TONE.UNKNOWN ? (
        <div className="flex h-4 items-center gap-1 rounded-md border border-dashed border-slate-400 bg-white px-1.5 text-3xs font-black text-slate-500">
          <Dots count={num(m.lotCount) || 0} cap={10} tone="quiet" size="w-2 h-2" title="この月に納期が来る登録の件数" />
          <span>登録 {num(m.lotCount) || 0}件（これから）</span>
        </div>
      ) : (
        <div className="relative h-4 rounded-md bg-slate-200" aria-label="要る時間と働ける時間">
          <div className="absolute inset-y-0 left-0 rounded-md bg-slate-700" style={{ width: `${reqPct}%`, ...(hatch ? HATCH_DARK : null) }} />
          {overPct > 0 ? <div className="absolute inset-y-0 rounded-r-md bg-red-600" style={{ left: `${capPct}%`, width: `${overPct}%` }} /> : null}
          {cap == null ? null : <div className="absolute -inset-y-0.5 w-0.5 bg-slate-900" style={{ left: `${capPct}%` }} title="働ける時間" />}
        </div>
      )}
      {/* 🚨 緑でも「持てる人が分からない工程」がある事を橙で必ず添える（余裕があると読ませない） */}
      <div className="flex flex-wrap items-center gap-1 text-3xs font-bold leading-tight text-slate-600">
        {m.tone === NM_TONE.UNKNOWN ? (
          <span>納期の登録が {num(m.needLotCount) || 0}件に届いていません</span>
        ) : (
          <>
            <span>要る {num(m.requiredPersonDays) ?? '—'} ／ 働ける {num(m.workablePersonDays) ?? '—'}人日</span>
            {ownerUnknown > 0 ? (
              <span className="rounded-sm bg-amber-500 px-1 font-black text-white">持てる人が分からない {ownerUnknown}工程</span>
            ) : null}
          </>
        )}
      </div>
    </button>
  );
}

function MonthStrip({ view, onPick }) {
  return (
    <section aria-label="今月・来月・再来月" data-nm-month-strip="1">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-2xs font-bold text-slate-500">
        <span>押すと下の工程がその月に変わります（この3本は主役ではありません）</span>
        <span className="ml-auto">斜線＝{view.holdingWord}で作業の記録が0件の山が半分以上（数字を信用しきれない月）</span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {arr(view.months).map((m) => (
          <MonthBar
            key={m.ym || m.label}
            m={m}
            selected={num(m.index) === num(view.selectedIndex)}
            onPick={onPick}
          />
        ))}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// ③ 工程の行（主役）
// -----------------------------------------------------------------------------
function ProcessRow({ p, scale, hatch }) {
  const t = toneOf(p.tone);
  const req = Math.max(0, num(p.requiredMinutes) || 0);
  const cap = Math.max(0, num(p.workableMinutes) || 0);
  const short = Math.max(0, num(p.shortMinutes) || 0);
  /* 物差しは「要る時間」の一番大きい物。持てる人が多い工程は「働ける時間」が
     月まるごとぶんになるので、帯の外へ出る。外へ出た分は 100% で止めて印だけ置く
     （帯を縮めて全部を入れると、要る時間どうしの長さが比べられなくなる）。 */
  const pct = (v) => Math.max(0, Math.min(100, (v / scale) * 100));
  const reqPct = pct(req);
  const capPct = pct(cap);
  const capOutside = cap > scale;
  const shortPct = Math.max(0, Math.min(100 - capPct, (short / scale) * 100));
  const unknown = p.tone === NM_TONE.OWNER_UNKNOWN;
  return (
    <div
      /* 🚨 左の色帯が「この行は何色か」の答え。帯の長さ（要る時間）が短い工程でも色は必ず読める。 */
      className={`grid grid-cols-[minmax(9rem,15rem)_1fr_minmax(7rem,11rem)] items-center gap-2 border-b border-l-8 border-slate-100 py-1 pl-1.5 text-xs last:border-b-0 ${t.ring}`}
      data-nm-process={p.processKey}
      data-nm-process-tone={p.tone}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-black text-slate-900">{p.title}</div>
        <div className="truncate text-2xs font-bold text-slate-600">
          {p.templateName ? `｜${p.templateName}` : '｜テンプレ名が この計算へ渡っていません'}
          {p.models.length
            ? ` ｜${p.models.join('・')}${p.modelCount > p.models.length ? ` ほか${p.modelCount - p.models.length}品目コード` : ''}`
            : ' ｜品目コードの登録なし'}
        </div>
      </div>
      {/* 帯：長さ＝要る時間（全行で同じ物差し）。赤＝足りない時間。橙＝丸ごと「持てる人が分かりません」 */}
      <div className="relative h-5 rounded-md bg-slate-100">
        <div
          className={`absolute inset-y-0 left-0 rounded-md ${unknown ? 'bg-amber-500' : 'bg-slate-600'}`}
          style={{ width: `${reqPct}%`, ...(hatch && !unknown ? HATCH_DARK : null) }}
        />
        {short > 0 ? <div className="absolute inset-y-0 rounded-r-md bg-red-600" style={{ left: `${capPct}%`, width: `${shortPct}%` }} /> : null}
        {unknown || capOutside ? null : <div className="absolute -inset-y-1 w-1 bg-slate-900" style={{ left: `${capPct}%` }} title="持てる人が働ける時間" />}
        {capOutside ? <span className="absolute -inset-y-1 right-0 w-1 bg-slate-400" title="持てる人が働ける時間は、この帯の外（ずっと右）です" /> : null}
        <div className="absolute inset-y-0 flex items-center whitespace-nowrap pl-1 text-2xs font-black text-slate-900" style={{ left: `${reqPct}%` }}>
          {p.requiredPersonDays ?? '—'}人日
          {short > 0 ? `（${p.shortPersonDays ?? '—'}人日 足りない）` : ''}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {/* 決まり28: なぜ を1語（model.js processWhyOf）。橙＝記録0件（分かりません）。 */}
        {p.why ? (
          <span
            data-nm-why={p.why.key}
            className={`rounded-md px-1.5 py-0.5 text-2xs font-black ${unknown ? 'bg-amber-500 text-white' : 'border border-slate-300 bg-slate-50 text-slate-700'}`}
          >
            {p.why.text}
          </span>
        ) : null}
        {unknown ? null : p.workers.length ? (
          p.workers.map((w) => (
            <span key={w} className="rounded-md border border-slate-400 bg-white px-1.5 text-2xs font-black text-slate-800">{w}</span>
          ))
        ) : (
          <span className="text-2xs font-bold text-slate-500">担当できる人の記録がありません</span>
        )}
      </div>
    </div>
  );
}

/* ── テンプレ1行（決まり28・29）。工程はこの行の中に畳んで残す（消さない） ── */
function TemplateRow({ t, scale, hatch }) {
  const tone = toneOf(t.tone);
  const req = Math.max(0, num(t.requiredMinutes) || 0);
  const reqPct = Math.max(0, Math.min(100, (req / scale) * 100));
  const unknown = t.tone === NM_TONE.OWNER_UNKNOWN;
  return (
    <details
      className={`border-b border-l-8 border-slate-100 last:border-b-0 ${tone.ring}`}
      data-nm-template={t.templateName}
      data-nm-template-tone={t.tone}
      data-nm-template-processes={t.processCount}
    >
      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(11rem,17rem)_1fr_minmax(9rem,15rem)] items-center gap-2 py-1 pl-1.5 text-xs hover:bg-slate-50">
        <div className="min-w-0">
          <div className="truncate text-sm font-black text-slate-900">{t.templateName}</div>
          <div className="truncate text-2xs font-bold text-slate-600">
            {t.models.length ? `${t.models.slice(0, 4).join('・')}${t.models.length > 4 ? ` ほか${t.models.length - 4}品目コード` : ''}` : '品目コードの登録なし'}
            {` ｜工程 ${t.processCount}（開く）`}
          </div>
        </div>
        <div className="relative h-5 rounded-md bg-slate-100">
          <div
            className={`absolute inset-y-0 left-0 rounded-md ${tone.solid}`}
            style={{ width: `${reqPct}%`, ...(hatch && !unknown ? HATCH_DARK : null) }}
          />
          <div className="absolute inset-y-0 flex items-center whitespace-nowrap pl-1 text-2xs font-black text-slate-900" style={{ left: `${reqPct}%` }}>
            {t.requiredPersonDays ?? '—'}人日
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span
            data-nm-template-why={t.allNoRecord ? 'norecord' : t.shortCount > 0 ? 'short' : t.ownerUnknownCount > 0 ? 'partial-norecord' : t.singleOwnerCount > 0 ? 'single' : 'ok'}
            className={`rounded-md px-1.5 py-0.5 text-2xs font-black ${unknown ? 'bg-amber-500 text-white' : t.tone === NM_TONE.SHORT ? 'bg-red-600 text-white' : 'border border-slate-300 bg-slate-50 text-slate-700'}`}
          >
            {t.why}
          </span>
          {t.workers.slice(0, 4).map((w) => (
            <span key={w} className="rounded-md border border-slate-400 bg-white px-1.5 text-2xs font-black text-slate-800">{w}</span>
          ))}
        </div>
      </summary>
      <div className="border-t border-dashed border-slate-200 bg-slate-50/60 pl-2" data-nm-template-open={t.templateName}>
        {t.processes.map((p) => <ProcessRow key={p.processKey} p={p} scale={scale} hatch={hatch} />)}
      </div>
    </details>
  );
}

function ProcessRail({ view, onPick }) {
  const { counts } = view;
  // 主役の月に工程が1つも無い時、手当ての手がかりが在る月（工程が出ている月）へ行ける道を1つ置く。
  //   🚨 数字を作らない。押すと月が変わるだけ（この画面の中の移動）。
  const hint = arr(view.months).find((m) => !m.thin && (num(m.jobCount) || 0) > 0
    && num(m.index) !== num(view.selectedIndex));
  const hatch = view.selected && view.selected.pile && num(view.selected.pile.percent) != null
    && view.selected.pile.percent >= 50;
  const templates = arr(view.templates);
  const TOP = 12;
  const top = templates.slice(0, TOP);
  const rest = templates.slice(TOP);
  const noRecord = templates.filter((t) => t.allNoRecord).length;
  return (
    <section className="grid min-w-0 gap-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5" data-nm-rail="1" data-nm-rail-templates={templates.length}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* 🚨 決まり28（2026-09-05 清水さん「どの工程を手当てするかって書いてあるけどこれなに？」）:
            見出しは「何が起きるか」で言う。行はテンプレ毎（決まり29）。工程は開けば出る。 */}
        <h3 className="text-base font-black text-slate-900">持てる人が居ない仕事（このままだと誰にも配れない）</h3>
        <span className="flex flex-wrap items-center gap-1.5 text-2xs font-bold text-slate-600">
          <span>テンプレ <b className="text-sm text-slate-900">{templates.length}</b>・工程 <b className="text-sm text-slate-900">{counts.total}</b></span>
          <span className="inline-flex items-center gap-1"><Signal level="danger" size="w-4 h-4" />時間が足りない <Dots count={counts.short} cap={10} tone="late" size="w-2 h-2" title="時間が足りない工程の数" /><b className="text-sm text-slate-900">{counts.short}</b></span>
          <span className="inline-flex items-center gap-1"><Signal level="warn" size="w-4 h-4" />記録0件で持てる人が分からない <Dots count={counts.ownerUnknown} cap={10} tone="idle" size="w-2 h-2" title="持てる人が分からない工程の数" /><b className="text-sm text-slate-900">{counts.ownerUnknown}</b></span>
          {noRecord > 0 ? <span className="inline-flex items-center gap-1">うち誰もやった記録が無いテンプレ <b className="text-sm text-slate-900">{noRecord}</b></span> : null}
          <span className="inline-flex items-center gap-1"><Signal level="ok" size="w-4 h-4" />回る <Dots count={counts.ok} cap={10} tone="ahead" size="w-2 h-2" title="回る工程の数" /><b className="text-sm text-slate-900">{counts.ok}</b></span>
          {counts.unknown > 0 ? (
            <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-500" />
              {view.selected && view.selected.thin ? '登録がこれから' : 'まだ判定していません'}
              <b className="text-sm text-slate-900">{counts.unknown}</b>
            </span>
          ) : null}
        </span>
        <span className="ml-auto text-2xs font-bold text-slate-500">
          帯の長さ＝そのテンプレの工程に要る時間の合計（同じ物差し）・行を足しても全体にはなりません
        </span>
      </div>
      {templates.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border-2 border-dashed border-slate-400 bg-slate-50 px-3 py-4 text-sm font-bold text-slate-600" data-nm-rail-empty="1">
          <span className="min-w-0">
            {view.selected && view.selected.thin
              ? `${view.selected.label}の工程は、まだ出せません。${view.selected.thinWhy}。`
              : `${view.selected ? view.selected.label : 'この月'}に納期が来る仕事が、まだ1件も登録されていません。`}
          </span>
          {hint ? (
            <button
              type="button"
              onClick={() => onPick(num(hint.index))}
              data-nm-rail-jump={hint.ym || hint.label}
              title={`${hint.label}の工程を出します。何も確定しません（この画面の中で月を変えるだけです）`}
              className="ml-auto min-h-11 shrink-0 rounded-lg border-2 border-slate-800 bg-white px-3 text-xs font-black text-slate-900 hover:bg-slate-100"
            >
              いま手当てを決められるのは {hint.label} ▶
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="min-w-0">
            {top.map((t) => <TemplateRow key={t.templateName} t={t} scale={view.templateScaleMinutes} hatch={hatch} />)}
          </div>
          {rest.length > 0 ? (
            <details>
              <summary className="flex min-h-11 cursor-pointer select-none items-center py-1 text-xs font-black text-cyan-700">…ほか {rest.length}テンプレ（開く）</summary>
              {rest.map((t) => <TemplateRow key={t.templateName} t={t} scale={view.templateScaleMinutes} hatch={hatch} />)}
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// ④ 仮付与で引き直した効き目（誰に教えるか）
// -----------------------------------------------------------------------------
function RemedyBox({ remedy }) {
  if (remedy.state === 'missing') {
    return (
      <section className="grid gap-1 rounded-2xl border-2 border-dashed border-slate-400 bg-slate-50 px-3 py-2.5" data-nm-remedy="missing">
        <h3 className="text-base font-black text-slate-700">誰に教えると効くか</h3>
        <p className="text-2xl font-black text-slate-600">まだ選べません</p>
        <p className="text-xs font-bold leading-snug text-slate-600">{remedy.note}</p>
      </section>
    );
  }
  const good = remedy.state === 'improves';
  /* 効かなかった手の内訳。0の語は出さない（0件を「起きた」と読ませない）。 */
  const lossHeadline = [
    (remedy.tradeoffCount ?? 0) > 0 ? `交換条件つきが ${remedy.tradeoffCount}件` : '',
    (remedy.worseCount ?? 0) > 0 ? `損だけが ${remedy.worseCount}件` : '',
  ].filter(Boolean).join('・');
  return (
    <section
      className={`grid gap-1.5 rounded-2xl border-2 px-3 py-2.5 ${good ? 'border-cyan-500 bg-cyan-50' : 'border-slate-400 bg-slate-50'}`}
      data-nm-remedy={remedy.state}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-base font-black text-slate-900">誰に教えると効くか</h3>
        <span className="text-2xs font-bold text-slate-600">仮に持たせて割付を引き直した {remedy.testedCount}件（正式な力量へは書きません）</span>
      </div>
      {/* 🚨 「効いた手はありません」の行は消さない。効かなかった手が在る時だけ、その内訳を後ろに足す。
          ⚠ 交換条件つき（得も損もある）と 損だけ は **別の語** で数える。
            1つにまとめると、得が1つも無い手まで『何かと引き替えに得た手』と読ませてしまう。 */}
      <p className={`text-2xl font-black leading-tight ${good ? 'text-cyan-800' : 'text-slate-600'}`}>
        {good
          ? `${remedy.improvedCount}件が効きました`
          : `効いた手はありません${lossHeadline ? `（${lossHeadline}）` : ''}`}
      </p>
      <div className="grid gap-1">
        {remedy.trials.map((t, i) => {
          /* 引き替えに失う物。0の札は出さない（0件を「起きた」と読ませない）。 */
          const newlyLate = (t.newlyLateLotIds || []).length;
          const unjudgeable = (t.becameUnjudgeableLotIds || []).length;
          /* 🚨 行ごと消えたロット（missingLotIds）は **別の丸札にしない**。
             引き直した一覧から行が消えたロットは、必ず「判定できなくなった」にも入っている
             （missingLotIds ⊆ becameUnjudgeableLotIds。2026-09-08 実測: 本物の compareSkillTrial に
              「A の行が消えた」結果を渡すと becameUnjudgeable:['A'] と missing:['A'] の両方が返る）。
             2枚の丸札にすると、同じ1ロットが画面で2ロットに読める。内訳は札の説明に畳む。 */
          const missing = (t.missingLotIds || []).length;
          const traded = t.verdict === 'tradeoff' || t.verdict === 'worse';
          /* 得の札。交換条件つきの行でも **引き替えに得た分** を消さない（両方見せる約束）。 */
          const avoidedLate = (t.avoidedLateLotIds || []).length;
          const handedJobs = (t.newlyAssignedJobIds || []).length;
          const idleCutMin = t.skillIdleMinutesReduced ?? 0;
          /* 🚨 赤枠なのに札が1枚も無い **空の行** を出さない。何が起きたか一言で言う。 */
          const tradedBadges = [avoidedLate, handedJobs, idleCutMin, newlyLate, unjudgeable].filter((n) => n > 0).length;
          return (
            <div
              key={`${t.worker}-${t.processKey}-${i}`}
              className={`grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-2 rounded-lg border px-2 py-1 text-xs
                ${t.improves ? 'border-cyan-400 bg-white' : (traded ? 'border-rose-400 bg-white' : 'border-slate-300 bg-white/70')}`}
              data-nm-trial={t.verdict}
            >
              <div className="min-w-0 truncate font-black text-slate-900">{t.worker}さん <span className="text-2xs font-bold text-slate-600">に〈{t.processTitle}〉</span></div>
              {t.improves ? (
                <div className="flex flex-wrap gap-1 text-2xs font-black">
                  <span data-nm-gain="avoidedLate" className="rounded-full bg-green-600 px-2 py-0.5 text-white">遅れを防ぐ {t.avoidedLateLotIds.length}ロット</span>
                  <span data-nm-gain="handedJobs" className="rounded-full bg-cyan-700 px-2 py-0.5 text-white">渡せる {t.newlyAssignedJobIds.length}仕事</span>
                  <span data-nm-gain="idleCut" className="rounded-full bg-slate-600 px-2 py-0.5 text-white">技能が合わず空く時間 −{t.skillIdleMinutesReduced ?? 0}分</span>
                </div>
              ) : traded ? (
                <div className="flex flex-wrap items-center gap-1 text-xs font-black">
                  {avoidedLate > 0 ? (
                    <span data-nm-gain="avoidedLate" className="rounded-full bg-green-600 px-2 py-0.5 text-white">遅れを防ぐ {avoidedLate}ロット</span>
                  ) : null}
                  {handedJobs > 0 ? (
                    <span data-nm-gain="handedJobs" className="rounded-full bg-cyan-700 px-2 py-0.5 text-white">渡せる {handedJobs}仕事</span>
                  ) : null}
                  {idleCutMin > 0 ? (
                    <span data-nm-gain="idleCut" className="rounded-full bg-slate-600 px-2 py-0.5 text-white">技能が合わず空く時間 −{idleCutMin}分</span>
                  ) : null}
                  {newlyLate > 0 ? (
                    <span data-nm-loss="newlyLate" className="rounded-full bg-rose-600 px-2 py-0.5 text-white">新しく遅れる {newlyLate}ロット</span>
                  ) : null}
                  {unjudgeable > 0 ? (
                    <span
                      data-nm-loss="unjudgeable"
                      className="rounded-full bg-rose-700 px-2 py-0.5 text-white"
                      title={missing > 0
                        ? `うち ${missing}ロットは、引き直した結果から行ごと消えました（納期の答えが1つも出せない）。同じロットなので件数は分けて数えません。`
                        : '引き直すと、このロットの納期に間に合うかを判定できなくなります。'}
                    >判定できなくなる {unjudgeable}ロット</span>
                  ) : null}
                  {tradedBadges === 0 ? (
                    <span className="font-bold text-slate-600">引き替えに失う物が在るので、効いた手には数えません</span>
                  ) : null}
                </div>
              ) : (
                <div className="text-2xs font-bold text-slate-600">引き直しても 遅れ0・渡せる仕事0・空きも変わりませんでした</div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-2xs font-bold leading-snug text-slate-600">{remedy.note}</p>
    </section>
  );
}

// -----------------------------------------------------------------------------
// ⑤ 足りない材料の札（教育）。🚨 日数は1文字も出さない
// -----------------------------------------------------------------------------
function MaterialBox({ education }) {
  return (
    <section className="grid gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 py-2.5" data-nm-education={education.state}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-base font-black text-slate-900">いつまでに教えるか</h3>
        <span className="text-2xs font-bold text-slate-600">出せるのは「材料が有るか」まで</span>
      </div>
      <p className="text-2xl font-black leading-tight text-slate-600" data-nm-education-answer="1">
        {education.state === 'ready' ? '材料はそろっています' : `材料が ${3 - education.okCount}つ足りません`}
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {education.cards.map((c) => (
          <div
            key={c.key}
            className={`rounded-lg border-2 px-2 py-1.5 text-center text-2xs font-bold
              ${c.ok ? 'border-green-600 bg-green-50 text-green-800' : 'border-dashed border-slate-400 bg-slate-50 text-slate-600'}`}
            data-nm-material={c.key}
            data-nm-material-ok={c.ok ? '1' : '0'}
          >
            <Signal level={c.ok ? 'ok' : 'unknown'} size="w-4 h-4" className="mb-0.5" />
            <b className="block text-xl leading-tight text-slate-900">{c.value == null ? '—' : c.value}</b>
            {c.label}
            {c.note ? <span className="mt-0.5 block text-3xs font-bold text-slate-500">{c.note}</span> : null}
          </div>
        ))}
      </div>
      {education.missingLabels.length ? (
        <div className="flex flex-wrap gap-1">
          {education.missingLabels.map((m) => (
            <span key={m} className="rounded-full border border-slate-400 bg-white px-2 py-0.5 text-2xs font-bold text-slate-700">不足：{m}</span>
          ))}
        </div>
      ) : null}
      <p className="text-2xs font-bold leading-snug text-slate-500">{education.why}</p>
    </section>
  );
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
/**
 * @param {object} props
 * @param {object|null} props.monthly Worker が返した result.monthly（そのまま）
 * @param {number} [props.monthIndex] 0=今月 / 1=来月 / 2=再来月。既定は来月
 * @param {Function} [props.onMonthIndex] 月を変える。渡さなければ **この部品が自分で覚える**
 *   （タブの枠から monthIndex だけを固定で渡された時も、月の棒が押せるようにする）
 * @param {boolean} [props.countPile] 到着待ち・記録0件の山を数えるか
 * @param {object|null} [props.decisionBoard] Worker の仮付与の引き直し結果 {trials:[...]}
 * @param {object|null} [props.educationLeadTime] educationLeadTime.js の戻り値（材料の不足だけ読む）
 * @param {string} [props.scopeKey] 見ている範囲（'onhand'|'soon'|'d30'|'all'）。渡されない時は何も言わない
 * @param {object|null} [props.meta] Worker の result.meta（lotsIn / lotsScoped）
 * @param {Function} [props.onScope] 範囲を広げる（'all'）。渡されない時はボタンを出さない
 * @param {boolean} [props.autoPick] 頼んだ月の登録がこれからの時、登録が入っている月へ **主役を寄せる**か。
 *   既定は寄せる（実データの 10月は登録2件しか無く、そのままだと手当てを何も決められない画面になるため）。
 *   🚨 寄せた時は画面が小さく断る。false にすると「頼んだ月そのもの」を出す
 *     （見張りが月ごとの言葉を確かめる時・呼ぶ側が月を固定したい時に使う）。
 * @param {boolean} [props.loading]
 * @param {string|null} [props.error]
 */
export function NextMonthPlan({
  /* 決まり26/28（2026-09-05）: Panel が広げた範囲（暦日）と「どこまで」。数字を作らず言うだけ */
  scopeDays = null,
  scopeUntilMs = null,
  monthly = null,
  monthIndex = 1,
  onMonthIndex = null,
  countPile = true,
  decisionBoard = null,
  educationLeadTime = null,
  scopeKey = null,
  meta = null,
  onScope = null,
  autoPick = true,
  loading = false,
  error = null,
}) {
  /* 🚨 hooks はガード（return）より上（2026-08-27 の白画面の形を作らない）。
     月を覚えるのは呼ぶ側でもよいし、渡されなければここで覚える。
     タブの枠が monthIndex を固定で渡している時でも、月の棒が押せる（押せるのに何も起きない画面にしない）。 */
  const controlled = typeof onMonthIndex === 'function';
  const [ownIndex, setOwnIndex] = React.useState(monthIndex);
  React.useEffect(() => { setOwnIndex(monthIndex); }, [monthIndex]);
  const shownIndex = controlled ? monthIndex : ownIndex;
  /* 🚨 人が月を押したかどうか（2026-09-05）。押していない間だけ、登録がこれからの月から
     登録が入っている月へ寄せる。押した後は人の選びをそのまま出す（勝手に上書きしない）。 */
  const [userPicked, setUserPicked] = React.useState(false);
  React.useEffect(() => { setUserPicked(false); }, [monthIndex]);
  const view = useMemo(
    () => buildNextMonthView({
      monthly, monthIndex: shownIndex, countPile, decisionBoard, educationLeadTime,
      autoPick: autoPick !== false && !userPicked,
    }),
    [monthly, shownIndex, countPile, decisionBoard, educationLeadTime, userPicked, autoPick],
  );
  const pick = (i) => { setUserPicked(true); if (controlled) onMonthIndex(i); else setOwnIndex(i); };

  if (!view.ready) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm font-bold text-slate-600" data-opsim-next-month="waiting">
        {view.error
          ? `来月の手当てを出せませんでした：${view.error}`
          : (loading ? '来月の手当てを組み立てています（計算が終わると出ます）'
            : (error ? '計算が最後まで進まなかったので、来月の手当ては出せません' : '来月の手当ては、計算が終わると出ます'))}
      </section>
    );
  }

  return (
    <div className="grid min-w-0 gap-2" data-opsim-next-month="ready" data-nm-count-pile={view.countPile ? '1' : '0'}>
      {/* 🚨 2026-09-15 畳む: 主役(持てる人が居ない仕事の行)が 1行も画面に入っていなかった。
          上に積んだ 見出し行 + 基準の断り を **1行**へ畳む。文字は1つも消さず畳みの中へ移す。 */}
      <details className="rounded-lg border border-slate-200 bg-white px-3 py-1" data-nm-heading-fold="1">
      <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-2">
        <Signal level={signalOf(view.tone)} size="w-5 h-5" />
        <Glyph kind="person" className="w-4 h-4 text-slate-500" />
        <Dots count={view.roster.length} cap={10} tone="quiet" size="w-2 h-2" title="名簿の人数" />
        <span className="fi-tap-text font-black text-slate-700">{view.headingMonthLabel || 'この月'}の見立て（誰で・いつを見ているか）</span>
      </summary>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-1">
        {/* 🚨🚨 2026-09-05 に実データの実画面で見つけた食い違い（ここで直した）:
            見出しは「**来月**、人は足りるか」なのに、大きい答えは「**10月**：…」と別の月を名乗り、
            月を押して主役を変えても見出しは「来月」のままだった。**言葉と中身が合っていない**。
          → 見出しは view.headingMonthLabel（＝大きい答えと同じ月）から作る。焼き込みをやめる。
            見張りが data-nm-heading-ym と 答えの data-nm-month が同じかを毎回数える。 */}
        <h2
          className="text-sm font-black text-slate-700"
          data-nm-heading-ym={view.headingMonthYm || ''}
          data-nm-heading-label={view.headingMonthLabel || ''}
        >
          {view.headingMonthLabel || 'この月'}、人は足りるか。足りないなら どの工程を・誰に・いつまでに 教えれば間に合うか
        </h2>
        <span className="text-2xs font-bold text-slate-500">
          基準 {fmtMdHm(view.baseNow)} ・ {view.roster.length}人（{view.roster.join('・')}）
          ・ {view.holdingWord}で作業の記録0件 {num(view.pileLotCount) || 0}件を{view.countPile ? '数えています' : '数えていません'}
          {view.latestArrivalMs == null ? '' : ` ・ 入荷の登録は ${fmtMd(view.latestArrivalMs)} ぶんまで`}
        </span>
      </div>
      </details>

      {/* 🚨 主役の月をこちらで寄せた時は、**必ず小さく断る**（黙って別の月を出さない）。
          清水さんの判断 #2（decisions.md「19B の見出しの月」）。朝に伺う所。 */}
      {view.autoPicked ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1 text-2xs font-bold text-slate-600"
          data-nm-auto-picked={`${view.autoPicked.askedLabel}->${view.autoPicked.toLabel}`}
        >
          <span>
            この画面の題は「来月の手当て」ですが、{view.autoPicked.askedLabel}に納期が登録されているのは
            <b className="mx-0.5 text-slate-900">{view.autoPicked.askedLotCount}件</b>だけなので、
            <b className="mx-0.5 text-slate-900">{view.autoPicked.toLabel}</b>を主役にしています
            （{view.autoPicked.toLabel}は{view.autoPicked.toLotCount}件）。
          </span>
          <span className="text-slate-500">
            🙏 清水さんの判断 #2：この寄せ方でよいか、朝に伺います。
            {view.autoPicked.askedLabel}を見るには、下の「{view.autoPicked.askedLabel}」を押してください。
          </span>
        </div>
      ) : null}

      {/* 🚨 見ている範囲で切れている時は、判定より先に その事を言う。
          3か月を見る画面なのに範囲が「未完了ぜんぶ」でないと、来月ぶんが月の箱に入らない。
          ⚠ 範囲が渡って来ていない時は **何も言わない**（分からない事を断言しない）。 */}
      {scopeKey && scopeKey !== 'all' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-amber-500 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-900" data-nm-scope={scopeKey}>
          <span data-nm-scope-days={scopeDays == null ? '' : String(scopeDays)}>
            {num(scopeUntilMs) != null
              ? <>範囲：<b>{fmtMd(scopeUntilMs)} までに来る分まで</b>（この画面を開いたので、既定の「手元＋14日」から広げています）</>
              : <>見ている範囲を絞っています</>}
            {meta ? `（この画面に載ったロット ${num(meta.lotsScoped) ?? '—'}件／渡された ${num(meta.lotsIn) ?? '—'}件）` : ''}
            。それより先に来る物は月の箱に入りません
          </span>
          {typeof onScope === 'function' ? (
            <button
              type="button"
              onClick={() => onScope('all')}
              title="見ている範囲を「未完了ぜんぶ」にして計算し直します（時間がかかります。何も保存しません）"
              className="ml-auto min-h-11 rounded-lg border-2 border-amber-600 bg-white px-3 text-xs font-black text-amber-900 hover:bg-amber-100"
            >
              未完了ぜんぶで計算し直す
            </button>
          ) : null}
        </div>
      ) : null}

      <AnswerLine view={view} />
      <MonthStrip view={view} onPick={pick} />
      <ProcessRail view={view} onPick={pick} />
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <RemedyBox remedy={view.remedy} />
        <MaterialBox education={view.education} />
      </div>

      {/* 別枠。🚨 「すでに超過」を「この先の見込み」に足さない（2026-08-22） */}
      {view.overdue ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border-2 border-red-600 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-800" data-nm-overdue="1">
          <span className="text-lg font-black">納期を過ぎた {num(view.overdue.lotCount) || 0}件</span>
          <span>どの月の「要る」にも「不足」にも足していません（別枠）</span>
          <span className="ml-auto">うち 手が付けられない（到着の予定が無い／過ぎた） {num(view.overdue.noArrivalLotCount) || 0}件</span>
        </div>
      ) : null}
    </div>
  );
}

export default NextMonthPlan;
