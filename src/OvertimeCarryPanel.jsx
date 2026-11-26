// 🕘 機械グループの「① 残業は いくつ要るか」「② 持ち越しは いつ無くなるか」(旗 feature:sapSort の時だけ MachineGroupView の上に出る)
// 目的: 「あふれるか」の先の「だから残業は何時間・どこで・いつ」「持ち越しはいつ無くなるか・早く無くすには残業はいくつ」を 一番上の1行で答える。
// 数は作らない(src/domain/sapOvertime.js と sapGroups.js の答えを置くだけ)。残業の上限(1人1日)と 片付ける目標は 画面で変えられる(おすすめ=上限 2h)。
// 入力: orders・基準時刻・台数/人数/掛け持ちの設定(今の画面と同じ)・数える資源(機械/人)
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない。画面の中の状態だけ)
// 確かめ方: node --test src/domain/__tests__/sapOvertime.test.mjs / sap-demo.html で実データを選ぶ
import React, { useMemo, useState } from 'react';
import { capacityGroups } from './domain/sapGroups.js';
import { factoryClock, DEFAULT_WORK_SCHEDULE } from './domain/workClock.js';
import { overtimePlan, weekSeries, carryOutlook, carryGoal, OT_CHOICES, OT_DEFAULT, HORIZON } from './domain/sapOvertime.js';

const MD = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`; };
const h = (x) => `${Math.round(x * 100) / 100}h`;
const pc = (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
const dayOnly = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

const TONE = {
    red: { card: 'border-rose-300 bg-rose-50 border-l-4 border-l-rose-600', badge: 'bg-rose-600 text-white', mark: '▲', label: 'あふれる', head: 'text-rose-600' },
    yellow: { card: 'border-amber-300 bg-amber-50 border-l-4 border-l-amber-500', badge: 'bg-amber-500 text-white', mark: '◆', label: 'ぎりぎり', head: 'text-amber-700' },
    green: { card: 'border-emerald-300 bg-white border-l-4 border-l-emerald-600', badge: 'bg-emerald-600 text-white', mark: '●', label: '足りる', head: 'text-emerald-700' },
};

/** 「いつ」の言葉: その週の 残業を出す日(今日から)の最初〜最後・土曜の日付 */
function whenText(week, nowMs, isWorkday, satDays) {
    const days = [];
    let sat = null;
    for (let d = Math.max(week.startMs, dayOnly(nowMs)); d < week.endMs; d = dayOnly(d + 36 * 3600000)) {
        if (isWorkday(d)) days.push(d); else if (new Date(d).getDay() === 6 && sat == null) sat = d;
    }
    const a = days.length ? `${MD(days[0])}〜${MD(days[days.length - 1])} の 毎日` : '';
    const s = satDays > 0 && sat != null ? `${MD(sat)}` : '';
    return [a, s].filter(Boolean).join(' と ');
}

const wcPeople = (g, res) => {
    const v = g.wcs.map((x) => (res === 'worker' ? x.eff.worker : x.eff.machine));
    return v.every((n) => n === v[0]) ? `各${v[0]}人` : g.wcs.map((x, i) => `${x.wc}=${v[i]}人`).join('・');
};

function Toggle({ value, onChange, options, label, testid }) {
    return (
        <span className="inline-flex items-center gap-2 text-xs text-slate-600">{label}
            <span className="inline-flex overflow-hidden rounded-lg border border-slate-300">{options.map(([k, l]) => <button key={String(k)} type="button" onClick={() => onChange(k)} className={`min-h-8 px-3 py-1 text-sm font-bold ${value === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`} data-ov-opt={`${testid}:${k}`} aria-pressed={value === k}>{l}</button>)}</span>
        </span>
    );
}

function Bars({ demand, cap, otH, satH }) {
    const max = Math.max(demand, cap + otH + satH, 1);
    const w = (v) => `${Math.max(0, (v / max) * 100)}%`;
    const baseNeed = Math.min(demand, cap);
    return (
        <div className="my-2 text-xs text-slate-600">
            <div className="flex items-center gap-2"><span className="w-9 shrink-0">必要</span>
                <div className="flex h-4 flex-1 overflow-hidden rounded bg-slate-200"><div style={{ width: w(baseNeed) }} className="bg-slate-500" /><div style={{ width: w(Math.max(0, demand - cap)) }} className="bg-rose-600" /></div>
                <b className="w-14 shrink-0 text-right tabular-nums text-slate-800">{h(demand)}</b></div>
            <div className="mt-1 flex items-center gap-2"><span className="w-9 shrink-0">使える</span>
                <div className="flex h-4 flex-1 overflow-hidden rounded bg-slate-200"><div style={{ width: w(cap) }} className="bg-cyan-700" /><div style={{ width: w(otH), backgroundImage: 'repeating-linear-gradient(45deg,#22d3ee,#22d3ee 3px,#cffafe 3px,#cffafe 6px)' }} /><div style={{ width: w(satH), backgroundImage: 'repeating-linear-gradient(45deg,#a78bfa,#a78bfa 3px,#ede9fe 3px,#ede9fe 6px)' }} /></div>
                <b className="w-14 shrink-0 text-right tabular-nums text-slate-800">{h(cap + otH + satH)}</b></div>
        </div>
    );
}

function OvertimeTab({ cap, res, capOT, setCapOT, weekIdx, setWeekIdx, nowMs, isWorkday, unsetOf, onOpenGroup }) {
    const plan = useMemo(() => overtimePlan(cap, { weekIdx, capOT, res }), [cap, weekIdx, capOT, res]);
    const wk = cap.weeks[weekIdx];
    const resName = res === 'worker' ? '人の時間(段取り+作業者)' : '機械の時間(段取り+機械)';
    const phrase = (r) => `${r.ot > 0 ? `1日 ${r.ot}h × ${r.count}人` : ''}${r.satDays > 0 ? `${r.ot > 0 ? '+' : ''}土曜 ${r.satDays}日` : ''}` || '残業なし';
    const nm = (a) => a.map((x) => x.name).join('・');
    return (
        <div data-ov-tab="ot">
            <div className="text-xs text-slate-500">問い: 機械は、残業を 何時間・どこで・いつ すればよいか</div>
            <div className="mt-1 text-xl font-bold leading-snug" data-testid="sap-ov-answer">
                {plan.rows.length ? (<>{wk.name}、残業が要るのは <em className="not-italic text-rose-600">{plan.rows.length}グループ</em>: {plan.rows.map((r, i) => <React.Fragment key={r.name}>{i ? ' と ' : ''}<em className="not-italic text-rose-600">{r.name}</em>({phrase(r)})</React.Fragment>)}。{plan.fitByMove.length ? <span className="text-amber-700">{nm(plan.fitByMove)} は 回せば 残業は要りません。</span> : null}{plan.remainTotal > 0 ? <span className="text-rose-600"> それでも {h(plan.remainTotal)} 残ります。</span> : null}</>)
                    : plan.fitByMove.length ? (<>{wk.name}、グループ全体では 残業は要りません。<span className="text-amber-700">{nm(plan.fitByMove)} は 回せば 収まります。</span></>)
                        : <span className="text-emerald-700">{wk.name}、残業は要りません(計画の分だけで見ると)。</span>}
            </div>
            {plan.rows.length ? <div className="mt-1 text-xs text-slate-500" data-testid="sap-ov-total">{wk.name}の残業は 全部で <b>{h(plan.otTotal)}</b>({plan.otPeople}人){plan.satPeople ? `・土曜に出るのは ${plan.satPeople}人` : ''}。計画日を過ぎた 持ち越しを片付ける分は 入っていません(→ ②)。</div> : <div className="mt-1 text-xs text-slate-500">計画日を過ぎた 持ち越しを片付ける分は 入っていません(→ ②)。</div>}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Toggle label="見る週" value={weekIdx} onChange={setWeekIdx} options={[[0, '今週'], [1, '来週'], [2, '2週後']]} testid="week" />
                <Toggle label="残業の上限(1人1日)" value={capOT} onChange={setCapOT} options={OT_CHOICES.map((v) => [v, `${v}h`])} testid="cap" />
            </div>
            <div className="mt-3 space-y-3">
                {plan.rows.map((r) => {
                    const T = TONE[r.level] || TONE.red;
                    const g = cap.groups.find((x) => x.name === r.name);
                    return (
                        <section key={r.name} className={`rounded-xl border px-3 py-3 ${T.card}`} data-ov-group={r.name}>
                            <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${T.badge}`}>{T.mark} {T.label}</span><b className="text-lg">{r.name}</b><span className="text-xs text-slate-500">作業区 {g.wcs.length}・{g.dai}台・{g.people}人・{wk.name} {pc(r.pct)}</span>{unsetOf(g) ? <span className="rounded border border-slate-300 px-1 text-xs text-slate-600">台数 未確認</span> : null}</div>
                            <div className="mt-1 font-bold text-rose-600">{r.ot > 0 ? `残業 1日 ${r.ot}h × ${r.count}人 × ${r.workDays}日` : '平日の残業は 使えません(残り稼働日 0)'}{r.satDays > 0 ? ` + 土曜 ${r.satDays}日(${r.count}人)` : ''}</div>
                            <Bars demand={r.demand} cap={r.cap} otH={r.otHours} satH={r.satHours} />
                            <div className="text-sm"><b>いつ</b> {whenText(wk, nowMs, isWorkday, r.satDays) || '—'} ／ <b>どこで</b> 作業区 {r.wcs.join('・')}({wcPeople(g, res)})／ <b>合わせて</b> 残業 {h(r.otHours)}{r.satDays > 0 ? ` + 土曜 ${h(r.satHours)}` : ''}</div>
                            {r.remain > 0 ? <div className="mt-1 rounded border border-rose-300 bg-white px-2 py-1 text-sm font-bold text-rose-700" data-ov-remain={r.name}>それでも {h(r.remain)} 残ります(上限まで残業し、土曜も出た後)。仕事を回す・来週へ送る・納期の相談 を考えてください。</div> : null}
                            <details className="mt-2 rounded border border-dashed border-slate-300 bg-white/70 px-2 py-1 text-xs text-slate-700"><summary className="cursor-pointer font-semibold">計算を見る(足りない {h(r.short)} を どう割ったか)</summary>
                                <p className="mt-1">足りない時間 = 必要 {h(r.demand)} − 使える {h(r.cap)}{r.count * 7.75 * r.workDays === r.cap ? `(${r.count}${res === 'worker' ? '人' : '台'} × 7.75h × ${r.workDays}日)` : ''} = <b>{h(r.short)}</b>。</p>
                                {r.workDays > 0 ? <p>{h(r.short)} ÷({r.count}人 × {r.workDays}日)= 1人1日 {Math.round(r.short / (r.count * r.workDays) * 100) / 100}h → 0.5h きざみで切り上げ <b>{Math.ceil(r.short / (r.count * r.workDays) * 2 - 1e-6) / 2}h</b>。{Math.ceil(r.short / (r.count * r.workDays) * 2 - 1e-6) / 2 > capOT ? <>上限 {capOT}h を超えるので 残業は {capOT}h まで({r.count}人 × {r.workDays}日 × {capOT}h = {h(r.otHours)})。{r.satDays > 0 ? <>残り {h(r.short - r.otHours)} ÷({r.count}人 × 7.75h)= {Math.round((r.short - r.otHours) / (r.count * 7.75) * 100) / 100}日 → 0.5日きざみで切り上げ 土曜 <b>{r.satDays}日</b>({r.count}人 × 7.75h × {r.satDays}日 = {h(r.satHours)})。</> : <>この週は 土曜が ありません。</>}</> : null}</p> : <p>残り稼働日が 0 なので 平日の残業は使えません。</p>}
                                <p>作業区ごと: {g.wcs.map((x) => `${x.wc} ${pc(x.cells[weekIdx].pct)}`).join('・')}。グループの中で 仕事を回して ならす前提です(回せない仕事が多いと、あふれる作業区だけ もっと要ります)。時間は {resName}で数えています。</p>
                            </details>
                        </section>
                    );
                })}
                {plan.fitByMove.map((f) => {
                    const g = cap.groups.find((x) => x.name === f.name);
                    return (
                        <section key={f.name} className={`rounded-xl border px-3 py-3 ${TONE.yellow.card}`} data-ov-group={f.name} data-ov-move="1">
                            <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${TONE.yellow.badge}`}>◆ ぎりぎり</span><b className="text-lg">{f.name}</b><span className="text-xs text-slate-500">作業区 {g.wcs.length}・{g.dai}台・{g.people}人・{wk.name} {pc(f.pct)}</span>{unsetOf(g) ? <span className="rounded border border-slate-300 px-1 text-xs text-slate-600">台数 未確認</span> : null}</div>
                            <div className="mt-1 font-bold text-amber-700">回せば 収まります(残業は要りません)</div>
                            <Bars demand={f.demand} cap={f.cap} otH={0} satH={0} />
                            <div className="rounded border border-dashed border-amber-300 bg-white/70 px-2 py-1 text-sm">グループ全体では 足りています({h(f.demand)} ÷ {h(f.cap)} = {pc(f.pct)})。作業区 {f.wcOver.map((x) => `${x.wc}(${pc(x.pct)})`).join('・')} だけ 100%超(あふれる)。 <button type="button" onClick={() => onOpenGroup(f.name)} className="ml-1 min-h-8 rounded border border-slate-300 bg-white px-2 font-bold" data-ov-open={f.name}>回す候補を見る</button></div>
                        </section>
                    );
                })}
                {plan.fine.length ? (
                    <section className={`rounded-xl border px-3 py-3 ${TONE.green.card}`} data-ov-fine="1">
                        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${TONE.green.badge}`}>● 足りる</span><b className="text-emerald-700">残業は要りません</b></div>
                        <div className="mt-1 text-sm font-semibold">{plan.fine.map((f) => `${f.name} ${pc(f.pct)}`).join(' ・ ')}</div>
                    </section>
                ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-slate-500 align-[-2px]" />必要な時間(SAP の計画の分)</span><span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-rose-600 align-[-2px]" />あふれる分</span><span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-cyan-700 align-[-2px]" />定時で使える</span><span><i className="mr-1 inline-block h-3 w-3 rounded-sm align-[-2px]" style={{ backgroundImage: 'repeating-linear-gradient(45deg,#22d3ee,#22d3ee 3px,#cffafe 3px,#cffafe 6px)' }} />残業で足す分</span><span><i className="mr-1 inline-block h-3 w-3 rounded-sm align-[-2px]" style={{ backgroundImage: 'repeating-linear-gradient(45deg,#a78bfa,#a78bfa 3px,#ede9fe 3px,#ede9fe 6px)' }} />土曜で足す分</span>
            </div>
            <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="sap-ov-note">これは仮の計算です。実際に残業や土曜出勤をやるかは別の話です。「誰が」は 作業区に入れた人数です(SAP に人の名前はありません)。持ち越し(計画日を過ぎた未完了)は ここに入れていません → ②。</div>
        </div>
    );
}

function CarryTab({ cap, res, capOT, goal, setGoal, setCapOT }) {
    const rows = useMemo(() => cap.groups.map((g) => {
        const s = weekSeries(g, cap.weeks, res);
        const base = carryOutlook({ carry: g.carry, demand: s.demand, cap: s.cap });
        const gl = goal ? carryGoal({ carry: g.carry, demand: s.demand, cap: s.cap, work: s.work, sat: s.sat, count: s.count, N: goal, capOT }) : null;
        return { g, s, base, gl };
    }), [cap, res, goal, capOT]);
    const withCarry = rows.filter((r) => r.base.state !== 'none');
    const none = rows.filter((r) => r.base.state === 'none');
    const maxBal = Math.max(1, ...withCarry.flatMap((r) => r.base.balance));
    const bad = withCarry.filter((r) => r.base.state === 'grow' || r.base.state === 'remain');
    const good = withCarry.filter((r) => r.base.state === 'clear');
    const nm = (a) => a.map((r) => r.g.name).join('・');
    const needOt = (r) => (r.gl.ot > 0 || r.gl.sat > 0);
    const gp = (r) => `${r.gl.ot > 0 ? `1日 ${r.gl.ot}h × ${r.s.count}人` : ''}${r.gl.sat > 0 ? `${r.gl.ot > 0 ? ' + ' : ''}毎週 土曜 ${r.gl.sat}日` : ''}`;
    let head;
    if (!withCarry.length) head = <span className="text-emerald-700">持ち越しは ありません。</span>;
    else if (!goal) head = (<>{bad.length ? <>今のままでは <em className="not-italic text-rose-600">{nm(bad)}</em> の持ち越しは 片付きません。</> : <>今のままで 持ち越しは 全部 片付きます。</>}{good.length ? <span className="text-emerald-700">{good.map((r) => `${r.g.name}(${r.base.clearedAt}週)`).join('・')} は 残業なしで片付きます。</span> : null}</>);
    else {
        const need = withCarry.filter((r) => r.gl.ok && needOt(r)), ng = withCarry.filter((r) => !r.gl.ok), free = withCarry.filter((r) => r.gl.ok && !needOt(r));
        head = (<>{goal}週で片付けるには: {need.length ? need.map((r, i) => <React.Fragment key={r.g.name}>{i ? '・' : ''}<em className="not-italic text-rose-600">{r.g.name}</em> {gp(r)}</React.Fragment>) : '残業は要りません'}。{free.length ? <span className="text-emerald-700">{nm(free)} は 残業なしで間に合います。</span> : null}{ng.length ? <span className="text-rose-600"> {ng.map((r) => `${r.g.name}(${r.gl.weeksNeeded ? `${r.gl.weeksNeeded}週かかる` : `${HORIZON}週でも片付かない`})`).join('・')} は 上限 {capOT}h と土曜でも {goal}週では片付きません。</span> : null}</>);
    }
    const badge = (o, goalRes) => {
        if (o.state === 'none') return { cls: 'border-emerald-300 bg-emerald-50 text-emerald-800', t: '● 持ち越しなし' };
        if (o.state === 'clear') return { cls: 'border-emerald-300 bg-emerald-50 text-emerald-800', t: `● ${o.clearedAt}週で片付く` };
        if (goalRes) return { cls: 'border-rose-300 bg-rose-50 text-rose-700', t: `▲ ${goalRes.weeksNeeded ? `${goalRes.weeksNeeded}週かかる` : `${HORIZON}週でも片付かない`}` };
        return { cls: 'border-rose-300 bg-rose-50 text-rose-700', t: o.state === 'grow' ? '▲ 片付かない(増える)' : `▲ ${HORIZON}週後も ${o.left}h 残る` };
    };
    return (
        <div data-ov-tab="carry">
            <div className="text-xs text-slate-500">問い: 持ち越し(計画日を過ぎた未完了)は、いつ無くなるか。早く無くすには 残業は いくつか</div>
            <div className="mt-1 text-xl font-bold leading-snug" data-testid="sap-ov-answer">{head}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Toggle label="片付ける目標" value={goal} onChange={setGoal} options={[[0, '今のまま(残業なし)'], [2, '2週で'], [3, '3週で'], [4, '4週で']]} testid="goal" />
                {goal ? <Toggle label="残業の上限(1人1日)" value={capOT} onChange={setCapOT} options={OT_CHOICES.map((v) => [v, `${v}h`])} testid="cap2" /> : null}
            </div>
            <div className="mt-3 divide-y divide-slate-200">
                {withCarry.map((r) => {
                    const o = r.gl ? r.gl.outlook : r.base;
                    const B = r.gl && r.gl.ok ? { cls: 'border-emerald-300 bg-emerald-50 text-emerald-800', t: `● ${o.firstZero ?? goal}週で片付く` } : badge(o, r.gl);
                    const wkN = goal ? Math.min(goal, HORIZON) : 0;
                    const e1 = r.gl ? (r.gl.extra[1] ?? r.gl.extra[0]) : 0;
                    const avgNeed = r.gl ? Math.max(0, r.g.carry + r.s.demand.slice(0, wkN).reduce((a, d, k) => a + d - r.s.cap[k], 0)) / wkN : 0;
                    return (
                        <section key={r.g.name} className="py-3" data-ov-carry={r.g.name} data-ov-state={o.state}>
                            <div className="flex flex-wrap items-center gap-2"><b className="text-base">{r.g.name}</b><span className="text-xs text-slate-500">{r.g.dai}台・持ち越し 今 <b className="text-slate-800">{Math.round(r.g.carry)}h</b>({r.g.carryN}件・約{Math.round(r.g.carryDays * 10) / 10}日分)</span><span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${B.cls}`}>{B.t}</span></div>
                            <div className="mt-1 flex items-end gap-1" style={{ height: 56 }} role="img" aria-label={`${r.g.name} 持ち越しの行き先 ${o.balance.map((b) => `${b}h`).join(' → ')}`}>
                                {o.balance.map((b, k) => (
                                    <div key={k} className="flex flex-1 flex-col items-center justify-end" style={{ height: '100%', maxWidth: 48 }}>
                                        {b <= 1e-6 && k > 0 ? <div className="w-full" style={{ height: 3, background: '#16a34a' }} title="無くなった" /> : <div className={`w-full rounded-t ${k === 0 ? 'bg-slate-900' : 'bg-slate-500'}`} style={{ height: Math.max(2, Math.round(b / maxBal * 44)) }} />}
                                        <span className="mt-0.5 text-[10px] leading-none text-slate-500">{k === 0 ? '今' : `${k}週`}</span>
                                    </div>))}
                            </div>
                            {r.gl ? (needOt(r) || r.gl.ok ? <div className="mt-1 text-sm" data-ov-goalline={r.g.name}><b>要る残業</b> {needOt(r) ? `${goal}週のあいだ ${gp(r)}` : 'なし(残業なしで間に合う)'}{needOt(r) ? <span className="text-xs text-slate-500">(週に 平均 {h(avgNeed)} 要る → 残業 週 {h(e1)})</span> : null}</div> : null) : null}
                            {r.gl && !r.gl.ok ? <div className="mt-1 text-sm font-bold text-rose-700" data-ov-goalline={r.g.name}>上限 {capOT}h と土曜(毎週 {r.gl.sat}日)を 足しても {goal}週では片付きません({r.gl.weeksNeeded ? `${r.gl.weeksNeeded}週かかる` : `${HORIZON}週でも片付かない`})。仕事を回す・納期の相談 を考えてください。</div> : null}
                        </section>
                    );
                })}
                {none.length ? <section className="py-3 text-sm text-slate-600" data-ov-carry-none="1"><b className="text-emerald-700">持ち越しなし</b>: {none.map((r) => r.g.name).join('・')}</section> : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600"><span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-slate-900 align-[-2px]" />今の持ち越し</span><span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-slate-500 align-[-2px]" />その週の終わりに残る持ち越し(1〜{HORIZON}週後)</span><span><i className="mr-1 inline-block h-[3px] w-4 align-middle" style={{ background: '#16a34a' }} /> 無くなった</span></div>
            <div className="mt-2 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="sap-ov-calc"><b>計算</b> 週の終わりの持ち越し = 前の週の持ち越し +(その週に SAP の計画が求める時間 − 使える時間)。0 より下にはしません。使える時間 = 台数 × 7.75h × 稼働日(+残業)。4週目から先は SAP にまだ計画が入りきっていないので、今週〜2週後の平均が続くと置いています(目安)。<br /><b>目標の残業</b> = 0.5h きざみで、N週目の終わりに持ち越しが 0 になる 一番小さい 1人1日の残業。上限 {capOT}h を超える分は 土曜(0.5日きざみ)。</div>
            <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="sap-ov-note">SAP の日付は「最早」の日付で、持ち越しは 必ずしも 納期遅れではありません(計画日より あと、の意味です)。「誰が」は 作業区に入れた人数です(SAP に人の名前はありません)。これは仮の計算です。</div>
        </div>
    );
}

export default function OvertimeCarryPanel({ orders, nowMs, perQty = true, defCap = 1, capMap, peopleMap, multiMap, res = 'machine', onOpenGroup = () => {} }) {
    const [tab, setTab] = useState('ot');
    const [capOT, setCapOT] = useState(OT_DEFAULT);
    const [weekIdx, setWeekIdx] = useState(0);
    const [goal, setGoal] = useState(0);
    const isWorkday = useMemo(() => factoryClock(DEFAULT_WORK_SCHEDULE, null), []);
    // 残業 0・土曜なしの「基の答え」を 8週ぶん(今の画面の上の表の残業の入力とは別に・持ち越しの先を見る為)
    const cap = useMemo(() => {
        const cfgOf = (wc) => { const units = capMap[wc] ?? defCap; return { units, people: peopleMap[wc] ?? units, multi: !!multiMap[wc] }; };
        return capacityGroups(orders, { nowMs, weeks: HORIZON, perQty, cfgOf, otHours: 0, saturday: false, resource: res, isWorkday });
    }, [orders, nowMs, perQty, capMap, peopleMap, multiMap, defCap, res, isWorkday]);
    const unsetOf = (g) => g.wcs.every((x) => capMap[x.wc] == null);
    return (
        <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3" data-testid="sap-ov" data-ov-flag="1">
            <div className="mb-2 flex gap-2 overflow-x-auto" role="tablist">
                {[['ot', '① 残業は いくつ要るか'], ['carry', '② 持ち越しは いつ無くなるか']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-9 shrink-0 whitespace-nowrap rounded-lg border px-3 py-1 text-sm font-bold ${tab === k ? 'border-cyan-700 bg-cyan-700 text-white' : 'border-slate-300 bg-white text-slate-600'}`} data-ov-tabbtn={k}>{l}</button>)}
            </div>
            {cap.groups.length === 0 ? <div className="text-sm text-slate-500">済んでいない機械工程が ありません。</div>
                : tab === 'ot' ? <OvertimeTab cap={cap} res={res} capOT={capOT} setCapOT={setCapOT} weekIdx={weekIdx} setWeekIdx={setWeekIdx} nowMs={nowMs} isWorkday={isWorkday} unsetOf={unsetOf} onOpenGroup={onOpenGroup} />
                    : <CarryTab cap={cap} res={res} capOT={capOT} goal={goal} setGoal={setGoal} setCapOT={setCapOT} />}
        </div>
    );
}
