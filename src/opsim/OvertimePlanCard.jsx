// =============================================================================
//  opsim/OvertimePlanCard.jsx — 納期対応の残業・土曜(必要分)の箱(2026-09-16)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-16):
//    「必要に応じて残業と土曜日出る計算をして、必要なタイミングで必要な分をする計算をして、
//      それを作業者に見せて、できるかどうか確認して、大丈夫ならそれでいく感じにしたい」
//
//  答える1行:
//    「遅れを間に合わせるには 誰が・どの日に・何分 残業し、誰が・どの土曜に出ればよいか。
//      作業者は できる／むずかしい で答え、全員できるなら「これでいく」で盤に効かせる」
//
//  流れ(3段):
//    ① 必要分を計算する … Worker(kind:'overtimePlan')で貪欲法(overtimePlan.js)を回す。押した時だけ。
//    ② 作業者に見せる   … settings.opsim.overtimePlan = { proposedAt, days, acks:{} } を保存。
//                          人ごとに「できる」「むずかしい」(acks)。
//    ③ これでいく       … 全員「できる」の時だけ押せる。adopted:true を保存すると
//                          scenario に extraByDay / workOnDays が載り(runKey が変わり)盤が引き直る。
//
//  🚨 この画面は **描くだけ**。数字は Worker(純関数)が返した物をそのまま出す。ここで足し算・判定を書かない。
//  🚨 時計は親から nowMs で受ける(中で Date.now() を呼ばない)。
//  🚨 hooks は必ずガード(return null)より上。
//  🚨 押す物は min-h-11・文字は fi-tap-text 以上。数の直書き(px)は書かない(文字サイズの設定が効かなくなる)。
//  🚨 禁じられた言葉(できない／不可／未経験 …)を画面の字に出さない。答えの2択は「できる」「むずかしい」。
// =============================================================================

import React from 'react';
import { CalendarPlus, Check, Loader2, Play, Users } from 'lucide-react';
import { planWorkerNames, everyoneOk } from '../domain/operationsSimulation/overtimePlan.js';
// 🎨 足す分の長さ(数は d.extraMin そのまま。分母は表の中の最大)。確かめ役(2026-09-17)「+120分 と +60分 が同じ幅の札で、文字を消すと区別が付かない」
import { Bar } from './vizKit.jsx';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** 'YYYY-MM-DD' → 「9/18(金)」。文字を作るだけ(数を作らない)。 */
const dayLabel = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
};
const stampLabel = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 止まった理由の文(overtimePlan.js の stoppedBecause をそのまま言い換えるだけ)。 */
const STOP_TEXT = Object.freeze({
  'no-late': '遅れは残っていません',
  'no-improvement': 'これ以上足しても遅れは減りません(効かなかった手は外しました)',
  'no-move': '足せる手が残っていません(担当者が居ない・1日の上限・土曜も使い切り)',
  'max-iterations': '手数の上限で止めました',
});

const BTN = 'fi-tap-text inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border-2 px-3 font-black';
const BTN_MAIN = `${BTN} border-cyan-700 bg-cyan-700 text-white hover:bg-cyan-800 disabled:cursor-not-allowed disabled:opacity-40`;
const BTN_SUB = `${BTN} border-slate-400 bg-white text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40`;

/** 日×人の表(計算の結果も 保存した案も 同じ形で描く)。 */
function DaysTable({ days, compact = false, emptyText = '残業・土曜出勤は1件も要りません。' }) {
  const list = Array.isArray(days) ? days : [];
  const maxExtra = Math.max(1, ...list.map((d) => Number(d && d.extraMin) || 0));
  if (list.length === 0) {
    return <div className="fi-tap-text text-slate-600" data-overtime-plan-empty="1">{emptyText}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="fi-tap-text w-full border-collapse" data-overtime-plan-days={list.length}>
        <thead>
          <tr className="text-left text-2xs text-slate-500">
            <th className="py-1 pr-2 font-bold">日</th>
            <th className="py-1 pr-2 font-bold">人</th>
            <th className="py-1 pr-2 font-bold">足す分</th>
            {compact ? null : <th className="py-1 font-bold">どのロットの為</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((d) => (
            <tr key={`${d.ymd}|${d.worker}`} className="border-t border-slate-200" data-overtime-plan-day={d.ymd} data-overtime-plan-worker={d.worker}>
              <td className="py-1.5 pr-2 whitespace-nowrap font-bold text-slate-800">{dayLabel(d.ymd)}</td>
              <td className="py-1.5 pr-2 whitespace-nowrap text-base font-black text-slate-900">{d.worker}</td>
              <td className="py-1.5 pr-2 whitespace-nowrap">
                {d.saturday
                  ? <span className="inline-flex items-center rounded-md border border-violet-500 bg-violet-50 px-1.5 font-black text-violet-900">土曜出勤</span>
                  : <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500 bg-amber-50 px-1.5 font-black text-amber-900"><Bar value={d.extraMin} max={maxExtra} tone="idle" height="h-1.5" className="w-10" title={`+${d.extraMin}分（表の中で一番多い残業を全幅にした長さ）`} />+{d.extraMin}分</span>}
              </td>
              {compact ? null : (
                <td className="py-1.5 text-2xs text-slate-500">{(Array.isArray(d.forLots) ? d.forLots : []).join(' / ') || '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {object} p
 * @param {object|null} p.plan   settings.opsim.overtimePlan({ proposedAt, days, acks, adopted, lateBefore, lateAfter })
 * @param {boolean} p.canEdit
 * @param {number} p.nowMs       親の基準時刻(提示した時刻に使う。中で時計を読まない)
 * @param {() => Promise<object>} p.onCompute  Worker(kind:'overtimePlan')を1回回す(親が用意)
 * @param {(plan:object|null) => void} p.onSave settings.opsim.overtimePlan を書く(親が用意)
 * @param {boolean} [p.disabled] 盤の計算中など
 * @param {boolean} [p.saving]
 * @param {string} [p.saveError]
 */
export function OvertimePlanCard({
  plan = null, canEdit = false, nowMs = null, onCompute = null, onSave = null, disabled = false, saving = false, saveError = '',
}) {
  // ── hooks(全部ここ。返り値の分岐より上) ─────────────────────────────────────
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState(null);
  const [error, setError] = React.useState('');
  const aliveRef = React.useRef(true);
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const saved = isObj(plan) ? plan : null;
  const names = React.useMemo(() => planWorkerNames(saved), [saved]);
  const allOk = React.useMemo(() => everyoneOk(saved), [saved]);
  const acks = React.useMemo(() => ((saved && isObj(saved.acks)) ? saved.acks : {}), [saved]);
  const adopted = !!saved && saved.adopted === true;

  const compute = React.useCallback(async () => {
    if (typeof onCompute !== 'function' || busy) return;
    setBusy(true); setError(''); setOut(null);
    try {
      const r = await onCompute();
      if (!aliveRef.current) return;
      setOut(isObj(r) ? r : null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(String((e && e.message) || e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [onCompute, busy]);

  const show = React.useCallback(() => {
    if (typeof onSave !== 'function' || !out) return;
    const days = Array.isArray(out.days) ? out.days.map((d) => ({ ymd: d.ymd, worker: d.worker, extraMin: d.extraMin, saturday: d.saturday === true, forLots: Array.isArray(d.forLots) ? d.forLots : [] })) : [];
    // 🚨 acks は **人ごとに '' を明示して** 書く。保存は merge なので {} だと前の案の「できる」が残り、
    //   見せた瞬間に「これでいく」が押せてしまう(merge は書かなかった鍵を消さない・2026-09-09 の形)。
    const acks = Object.fromEntries(planWorkerNames({ days }).map((n) => [n, '']));
    onSave({
      proposedAt: Number.isFinite(Number(nowMs)) ? Number(nowMs) : null,
      days,
      lateBefore: out.lateBefore ?? null,
      lateAfter: out.lateAfter ?? null,
      acks,
      adopted: false,
    });
  }, [onSave, out, nowMs]);

  const ack = React.useCallback((name, v) => {
    if (typeof onSave !== 'function' || !saved) return;
    onSave({ ...saved, acks: { ...acks, [name]: v }, adopted: false });
  }, [onSave, saved, acks]);

  const adopt = React.useCallback(() => {
    if (typeof onSave !== 'function' || !saved || !allOk) return;
    onSave({ ...saved, adopted: true });
  }, [onSave, saved, allOk]);

  const withdraw = React.useCallback(() => {
    if (typeof onSave !== 'function') return;
    onSave(null);
  }, [onSave]);

  // ── 描く ─────────────────────────────────────────────────────────────────
  const stopText = out ? (STOP_TEXT[out.stoppedBecause] || String(out.stoppedBecause || '')) : '';
  // 🚨 残った遅れのうち すでに納期を過ぎている物は 残業・土曜では戻らない。黙って「足せる手が無い」で終えない。
  const pastDueNote = out && Number(out.pastDueAfter) > 0 ? `残り ${out.lateAfter}件のうち ${out.pastDueAfter}件は すでに納期を過ぎている(基準時刻より前)ので、残業・土曜では戻りません` : '';

  return (
    <section
      className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-slate-800 fi-tap-text"
      data-opsim-overtime-plan="1"
      data-opsim-overtime-plan-adopted={adopted ? '1' : '0'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CalendarPlus className="h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
        <b className="text-base text-slate-900">納期対応の残業・土曜（必要分）</b>
        <span className="text-2xs text-slate-600">遅れを間に合わせるのに 誰が・どの日に・何分 要るかを、必要な分だけ足して決めます</span>
      </div>

      {/* ① 計算する */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN_MAIN}
          onClick={compute}
          disabled={busy || disabled || typeof onCompute !== 'function'}
          data-overtime-plan-compute="1"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {busy ? '計算しています…' : '必要分を計算する'}
        </button>
        {out ? (
          <span className="inline-flex items-center gap-1 rounded-lg border-2 border-slate-700 bg-white px-2 py-1 font-black text-slate-900" data-overtime-plan-late={`${out.lateBefore}->${out.lateAfter}`}>
            遅れ {out.lateBefore}件 → {out.lateAfter}件
          </span>
        ) : null}
        {out ? <span className="text-2xs text-slate-600">{stopText}（引き直し {out.iterations}回・1手 +{out.stepMin}分・1人1日 最大 +{out.maxExtraMin}分）</span> : null}
        {pastDueNote ? <span className="text-2xs font-bold text-rose-700" data-overtime-plan-pastdue={out.pastDueAfter}>{pastDueNote}</span> : null}
        {/* 🚨 件数が減らないのに表に手が残る時(遅れの合計だけ減った手)。読む人に「減らないのに なぜ表が在る」を言う(確かめ役 2026-09-17) */}
        {out && out.lateAfter === out.lateBefore && Array.isArray(out.days) && out.days.length ? <span className="text-2xs text-slate-600" data-overtime-plan-same-count="1">遅れの件数は同じですが、納期からの遅れの量が減った手だけを残しています</span> : null}
      </div>
      {error ? <div className="mt-1 rounded-lg border border-rose-400 bg-rose-50 px-2 py-1 font-bold text-rose-800" data-overtime-plan-error="1">{error}</div> : null}

      {out ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-white p-2">
          {/* ⚠ 遅れが残ったまま案が空の時に「1件も要りません」と言わない(確かめ役 2026-09-16: 写しで 遅れ9件→9件 なのに「要りません」と出た) */}
          <DaysTable
            days={out.days}
            emptyText={Number(out.lateAfter) > 0
              ? '足しても遅れが減る手が見つからず、残業・土曜出勤は入れていません。'
              : '残業・土曜出勤は1件も要りません。'}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN_SUB}
              onClick={show}
              disabled={!canEdit || saving || typeof onSave !== 'function' || !(Array.isArray(out.days) && out.days.length)}
              data-overtime-plan-show="1"
            >
              <Users className="h-4 w-4" aria-hidden="true" />
              作業者に見せる
            </button>
            {!canEdit ? <span className="text-2xs text-slate-500">見せるには編集の権限が要ります</span> : null}
          </div>
        </div>
      ) : null}

      {/* ② 作業者に見せている案 → ③ これでいく */}
      {saved ? (
        <div className="mt-3 rounded-lg border-2 border-slate-300 bg-white p-2" data-overtime-plan-saved="1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-base text-slate-900">{adopted ? 'この案で盤を引いています' : '作業者に見せている案'}</b>
            {saved.proposedAt ? <span className="text-2xs text-slate-500">{stampLabel(saved.proposedAt)} 提示</span> : null}
            {saved.lateBefore != null && saved.lateAfter != null
              ? <span className="inline-flex items-center rounded-lg border border-slate-400 px-2 font-black">遅れ {saved.lateBefore}件 → {saved.lateAfter}件</span>
              : null}
          </div>
          <div className="mt-2"><DaysTable days={saved.days} compact /></div>

          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {names.map((n) => {
              const a = acks[n] || '';
              return (
                <div key={n} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2 py-1" data-overtime-plan-ack-row={n}>
                  <span className="min-w-0 flex-1 text-base font-black text-slate-900">{n}</span>
                  <button
                    type="button"
                    className={`${BTN} ${a === 'ok' ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-slate-400 bg-white text-slate-800'}`}
                    onClick={() => ack(n, 'ok')}
                    disabled={!canEdit || saving}
                    data-overtime-plan-ack={`${n}:ok`}
                    aria-pressed={a === 'ok'}
                  >
                    {a === 'ok' ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
                    できる
                  </button>
                  <button
                    type="button"
                    className={`${BTN} ${a === 'hard' ? 'border-rose-700 bg-rose-700 text-white' : 'border-slate-400 bg-white text-slate-800'}`}
                    onClick={() => ack(n, 'hard')}
                    disabled={!canEdit || saving}
                    data-overtime-plan-ack={`${n}:hard`}
                    aria-pressed={a === 'hard'}
                  >
                    むずかしい
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {adopted ? (
              <span className="inline-flex items-center gap-1 rounded-lg border-2 border-emerald-700 bg-emerald-50 px-2 py-1 font-black text-emerald-900">
                <Check className="h-4 w-4" aria-hidden="true" />
                全員「できる」。この案の残業・土曜で盤を引いています
              </span>
            ) : (
              <button
                type="button"
                className={BTN_MAIN}
                onClick={adopt}
                disabled={!canEdit || saving || !allOk}
                data-overtime-plan-adopt="1"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                これでいく
              </button>
            )}
            {!adopted && !allOk ? <span className="text-2xs text-slate-600">全員が「できる」になると押せます</span> : null}
            <button type="button" className={BTN_SUB} onClick={withdraw} disabled={!canEdit || saving} data-overtime-plan-withdraw="1">
              取り下げる
            </button>
            {saving ? <span className="inline-flex items-center gap-1 text-2xs text-slate-500"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />保存しています</span> : null}
          </div>
          {saveError ? <div className="mt-1 rounded-lg border border-rose-400 bg-rose-50 px-2 py-1 font-bold text-rose-800">{saveError}</div> : null}
        </div>
      ) : null}

      <div className="mt-2 text-2xs text-slate-500">
        足し方: いちばん早く遅れるロットの担当者に、そのロットへ手が付いている日のうち納期に一番近い営業日へ 1手ずつ残業を足し、
        1日の上限に当たったら納期より前の直近の土曜に出ます。足しても遅れが減らなければ止まります。
      </div>
    </section>
  );
}

export default OvertimePlanCard;
