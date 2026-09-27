// =============================================================================
//  opsim/JugglingStrip.jsx — 「1ロットずつ(既定)／掛け持ちあり」の切り替えと、両方で引き直して並べる1行(2026-09-26)
// -----------------------------------------------------------------------------
//  清水さん「基本は1ロットずつで、場合によって並列へ切り替えられるなら面白い」→ 切り替えは settings.opsim.jugglingMode。
//  ・切り替えると盤(操業シミュ本体)がその決まりで引き直る(scenario.parallelLab を載せる/載せない)。
//  ・「両方で引き直して比べる」は はしごと同じ Worker を2回回し(1ロットずつ = parallelLab 無し／掛け持ち = 組んだ入力)、
//    wholePlan.js の compareWholePlans で同じ物差しで並べる。何も保存しない。
//  🚨 数字を作らない。入力の出どころ(basis)を必ず横に出す。分からない片道・場所は「暫定」と言う。
// =============================================================================
import React from 'react';
import { Footprints, Loader2, Play } from 'lucide-react';
import { JUGGLING_CHOICES } from '../domain/parallelLab/juggling.js';
import { compareWholePlans } from '../domain/parallelLab/wholePlan.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const fmtInt = (n) => (num(n) == null ? '—' : Math.round(Number(n)).toLocaleString('ja-JP'));
const signed = (n) => (num(n) == null ? '—' : (n > 0 ? `+${fmtInt(n)}` : fmtInt(n)));

/**
 * @param {object} p
 * @param {'off'|'on'} p.mode 今の切り替え
 * @param {Function} p.onMode (mode) => void 保存(settings.opsim.jugglingMode)
 * @param {object|null} p.built jugglingScenarioOf の戻り({scenario, counted, basis})。off の時も比べるために渡す
 * @param {Function} p.runRung (plan) => Promise<{normalized, simResult, tookMs}>  ※はしごと同じ
 * @param {Function} [p.disposeRun]
 * @param {number} p.horizonDays
 * @param {string} [p.inputKey] 盤が回した入力の指紋。変わったら前の比較は捨てる
 * @param {Function} [p.lotLabel] (lotId) => 表示名
 * @param {boolean} [p.canEdit]
 */
export function JugglingStrip({ mode = 'off', onMode = null, built = null, runRung = null, disposeRun = null, horizonDays = null, inputKey = '', lotLabel = (id) => id, canEdit = false }) {
  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [out, setOut] = React.useState(null);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const aliveRef = React.useRef(true);
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const epochRef = React.useRef(0);
  const groundKey = [horizonDays, inputKey, built ? Object.keys(built.scenario.autoSteps || {}).length : 0].join('|');
  React.useEffect(() => { epochRef.current += 1; setOut(null); setError(''); }, [groundKey]);

  const run = React.useCallback(async () => {
    if (typeof runRung !== 'function' || !built) return;
    const own = ++epochRef.current;
    setBusy(true); setError(''); setOut(null); setStep(0);
    const plans = [
      { key: 'one', label: '1ロットずつ', horizonDays, scenarioPatch: { parallelLab: null } },
      { key: 'juggle', label: '掛け持ちあり', horizonDays, scenarioPatch: { parallelLab: built.scenario } },
    ];
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    try {
      const got = [];
      for (let i = 0; i < plans.length; i += 1) {
        setStep(i + 1);
        const r = await runRung(plans[i], i);
        if (!aliveRef.current || own !== epochRef.current) return;
        got.push(r ? r.simResult : null);
      }
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const cmp = compareWholePlans({ stay: got[0], release: got[1], lotLabel });
      setOut({ ...cmp, seconds: t1 > t0 ? (t1 - t0) / 1000 : null });
    } catch (e) {
      if (aliveRef.current && own === epochRef.current) setError((e && e.message) ? String(e.message) : '引き直しに失敗しました');
    } finally {
      if (typeof disposeRun === 'function') { try { disposeRun(); } catch { /* 畳めなくても止めない */ } }
      if (aliveRef.current) { setBusy(false); setStep(0); }
    }
  }, [runRung, built, horizonDays, disposeRun, lotLabel]);

  const d = out && out.delta;
  return (
    // 🔧 2026-09-26 ChatGPT の確認: 3列の真ん中だけ縦に伸びて盤が下へ押し出されていた → 帯は全幅の1行(!basis-full)。根拠は押した時だけ
    <section className="!basis-full flex flex-col gap-1.5 rounded-xl border-2 border-teal-700 bg-white px-3 py-2 text-xs" data-opsim-juggling={mode} data-opsim-juggling-auto={built ? String(Object.keys(built.scenario.autoSteps || {}).length) : '0'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1 text-sm font-black text-slate-900"><Footprints className="h-4 w-4 text-teal-800" />割付の前提: 掛け持ち</span>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="掛け持ちの切り替え">
          {JUGGLING_CHOICES.map((c) => (
            <button key={c.key} type="button" disabled={!canEdit} aria-pressed={mode === c.key} data-opsim-juggling-pick={c.key}
              onClick={() => { if (typeof onMode === 'function' && mode !== c.key) onMode(c.key); }}
              className={`min-h-11 rounded-lg border-2 px-3 text-xs font-black ${mode === c.key ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-300 bg-white text-slate-800'} ${!canEdit ? 'opacity-60' : ''}`}>
              {c.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={run} disabled={busy || !built || typeof runRung !== 'function'} data-opsim-juggling-run=""
          title="今の盤の条件で「1ロットずつ」と「掛け持ちあり」を実際に2回引き直して並べます。何も保存しません。"
          className={`inline-flex min-h-11 items-center gap-1 rounded-lg border-2 px-2.5 text-xs font-black ${busy || !built ? 'border-slate-300 bg-slate-100 text-slate-400' : 'border-teal-700 bg-white text-teal-800 hover:bg-teal-50'}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {busy ? `引き直しています（${step}／2）` : '両方で引き直して比べる'}
        </button>
        {error ? <span className="font-bold text-rose-700">{error}</span> : null}
        {out && d ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" data-opsim-juggling-result="">
            <span title="計算の終わりで納期を過ぎるロットの数。盤の「この先で遅れる」とは範囲(期間内に終わらない物を別に数える)が違います">納期超過 <b className="text-sm tabular-nums">{fmtInt(d.stayLate)}件 → {fmtInt(d.releaseLate)}件</b>（{signed(d.lateLots)}件・超過の合計 {signed(Math.round(d.lateMs / 60000))}分）</span>
            <span>期間内に終わらない <b className="tabular-nums">{fmtInt(d.stayUnfinished)}件 → {fmtInt(d.releaseUnfinished)}件</b></span>
            <span>早く終わる {fmtInt(d.earlier)}・遅くなる {fmtInt(d.later)}・人を離した回数 {fmtInt(d.released)}</span>
            <span className={`font-bold ${out.provisional ? 'text-amber-800' : 'text-slate-600'}`}>{out.provisional ? `⚠ 暫定（足していない移動 ${fmtInt(d.travelUnknown + d.zoneUnknown)}回）` : '移動は全部足した'}</span>
            {out.seconds != null ? <span className="text-slate-500">{Math.round(out.seconds * 10) / 10}秒</span> : null}
          </span>
        ) : null}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-xs font-bold text-slate-700">{open ? '出どころを閉じる' : '出どころ'}</button>
      </div>
      {open && built ? (
        <ul className="list-disc pl-5 text-2xs text-slate-700" data-opsim-juggling-basis="">
          {built.basis.map((b, i) => <li key={i}>{b}</li>)}
          <li>切り替えを「掛け持ちあり」にすると、この盤・納期一覧の割付がその前提で引き直ります(保存は設定だけ・現場の指示には書きません)。</li>
        </ul>
      ) : null}
      {open && out ? (
        <ul className="list-disc pl-5 text-2xs text-slate-700" data-opsim-juggling-lines="">
          {out.lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

export default JugglingStrip;
