// 🧑‍🔧 誰が検査をするか(Fable の見本「検査_誰がするか」1週間/1か月)
// 目的: 検査に着く日が出た指図を 着いた物から リミットの早い順に 一番早く手が空く人へ割り付け、誰が・何を・どの順で・リミットに間に合うか・手が空くならなぜか を見せる。
// 数は作らない(src/domain/sapInspectAlloc.js の答えを置くだけ)。検査員の名前・人数・出庫日・リミットは 本物のデータが無い間 作り物(画面に黄色の帯で明記)。本番を読まない。
// 入力: forecast(arrivalForecast の結果)・inspectors(検査員の名前の配列・無ければ作り物)
// 呼ぶ人: InspectArrivalSection.jsx(タブ「誰がするか」)
import React, { useMemo, useState } from 'react';
import './inspectArrival.css';
import './inspectWho.css';
import { allocate, WORK, ASSUMED_MIN } from './domain/sapInspectAlloc.js';

export const MOCK_INSPECTORS = ['佐藤', '鈴木', '高橋'];   // 作り物の名前(本番は読まない)
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const TONES = ['#3b82f6', '#14b8a6', '#8b5cf6', '#d946ef', '#0ea5e9'];
const MODES = { week: { days: 7, label: '1 週間', px: null }, month: { days: 31, label: '1 か月', px: 76 } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function whoHtml(DATA, mode) {
    const W = DATA.work, T0 = new Date(DATA.today + 'T00:00:00Z').getTime();
    const dt = (n) => new Date(T0 + n * 86400000);
    const md = (n) => { const d = dt(n); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
    const dow = (n) => dt(n).getUTCDay();
    const hm = (t) => { const m = ((t % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const dayOf = (t) => Math.floor(t / 1440);
    const when = (t) => `${md(dayOf(t))} ${hm(t)}`;
    const hrs = (min) => `${Math.round(min / 6) / 10}h`;
    const M = MODES[mode]; const A = 0, B = M.days - 1;
    const cols = []; let tot = 0;
    for (let n = A; n <= B; n++) { const off = dow(n) === 0 || dow(n) === 6; cols.push({ n, off, w: off ? 0.25 : 1, l: tot }); tot += off ? 0.25 : 1; }
    cols.forEach((c) => { c.left = c.l / tot * 100; c.width = c.w / tot * 100; });
    const axW = M.px ? `${Math.round(tot * M.px)}px` : null;
    const X = (t) => { const d = dayOf(t); if (d < A) return 0; if (d > B) return 100; const c = cols[d - A]; const m = t - d * 1440; const f = c.off ? 0.5 : Math.min(1, Math.max(0, (m - W.start) / (W.end - W.start))); return c.left + f * c.width; };
    const endT = (B + 1) * 1440;
    const colsHtml = cols.map((c) => `<div class="wcol${c.off ? ' off' : ''}${c.n === 0 ? ' tod' : ''}" style="left:${c.left}%;width:${c.width}%"></div>`).join('');
    const heads = cols.map((c) => (c.off ? '' : `<div class="wdh${c.n === 0 ? ' today' : ''}" style="left:${c.left}%;width:${c.width}%">${c.n === 0 ? '今日 ' : ''}${M.px && c.n !== 0 && dow(c.n) !== 1 ? dt(c.n).getUTCDate() : md(c.n)}(${WD[dow(c.n)]})</div>`)).join('');
    const bars = (pieces, cls) => pieces.filter(([a]) => a < endT).map(([a, b]) => `<div class="wb ${cls}" style="left:${X(a)}%;width:${Math.max(0.15, X(Math.min(b, endT - 1)) - X(a))}%"></div>`).join('');
    const gapBars = (g, cls) => { const out = []; for (let d = Math.max(A, dayOf(g.a)); d <= Math.min(B, dayOf(g.b - 1)); d++) { if (cols[d - A].off) continue; const a = Math.max(g.a, d * 1440 + W.start), b = Math.min(g.b, d * 1440 + W.end); if (b > a) out.push(`<div class="wb ${cls}" style="left:${X(a)}%;width:${X(b) - X(a)}%"></div>`); } return out.join(''); };
    const clipMin = (g) => { let m = 0; for (let d = Math.max(A, dayOf(g.a)); d <= Math.min(B, dayOf(g.b - 1)); d++) { if (cols[d - A].off) continue; for (const [s, e] of [[W.start, W.breaks[0][0]], [W.breaks[0][1], W.breaks[1][0]], [W.breaks[1][1], W.end]]) { const a = Math.max(g.a, d * 1440 + s), b = Math.min(g.b, d * 1440 + e); if (b > a) m += b - a; } } return m; };
    const jobsV = DATA.jobs.filter((j) => j.t0 < endT);
    const overN = jobsV.filter((j) => j.overDays != null).length;
    const idleMin = DATA.gaps.reduce((s, g) => s + (Math.min(g.b, endT) - g.a > 0 ? clipMin(g) : 0), 0);
    let h = `<div class="wtiles">
      <div class="wtile ta"><div class="l">${M.label}で 検査する</div><div class="n">${jobsV.length}<small>件</small></div></div>
      <div class="wtile tb"><div class="l">リミットを越えて終わる</div><div class="n">${overN}<small>件</small></div></div>
      <div class="wtile tc"><div class="l">手が空く(${DATA.inspectors.length}人の合計)</div><div class="n">${hrs(idleMin)}</div></div>
      <div class="wtile td"><div class="l">割り付けていない(止まり・日付なし)</div><div class="n">${DATA.skipped.stuck + DATA.skipped.unknown}<small>件</small></div></div></div>`;
    h += `<div class="wscroll${M.px ? ' month' : ''}"><div class="wtable" style="${axW ? `width:calc(36rem + ${axW})` : ''}">`;
    h += `<div class="wrow whead"><div class="wleft"><span class="x">${md(A)}(${WD[dow(A)]})〜${md(B)}(${WD[dow(B)]}) 誰が・何を・どの順で</span></div><div class="wax">${heads}</div></div>`;
    DATA.inspectors.forEach((who, wi) => {
        const mine = jobsV.filter((j) => j.who === who).sort((a, b) => a.t0 - b.t0);
        const gaps = DATA.gaps.filter((g) => g.who === who && g.a < endT);
        const busy = mine.reduce((s, j) => s + j.pieces.filter(([a]) => a < endT).reduce((x, [a, b]) => x + Math.min(b, endT) - a, 0), 0);
        const idle = gaps.reduce((s, g) => s + clipMin(g), 0);
        const over = mine.filter((j) => j.overDays != null).length;
        h += `<div class="wrow wperson"><div class="wleft"><span class="wav" style="background:${TONES[wi % TONES.length]}">${esc(who.slice(0, 1))}</span><span class="wname"><b>${esc(who)}</b><i>${mine.length}件・検査 ${hrs(busy)}・空き ${hrs(idle)}${over ? `・<em>リミット越え ${over}件</em>` : ''}</i></span></div>
        <div class="wax band">${colsHtml}${mine.map((j) => bars(j.pieces, j.overDays != null ? 'late' : 'ok')).join('')}${gaps.map((g) => gapBars(g, g.kind === 'arrival' ? 'idleA' : 'idleN')).join('')}</div></div>`;
        const seq = [...mine.map((j) => ({ at: j.t0, j })), ...gaps.map((g) => ({ at: g.a, g }))].sort((a, b) => a.at - b.at);
        let no = 0;
        seq.forEach(({ j, g }) => {
            if (g) {
                h += `<div class="wrow wgap ${g.kind}"><div class="wleft"><span class="wno dash"></span><span class="wtx"><b>手が空く(${hrs(clipMin(g))})</b><i>${when(g.a)} 〜 ${when(Math.min(g.b, endT - 1440 + W.end))}・${g.kind === 'arrival' ? `次の物がまだ着いていない(次は ${md(g.nextReady)} 着)` : '検査する物が無い'}</i></span><span class="wdue"></span></div>
            <div class="wax">${colsHtml}${gapBars(g, g.kind === 'arrival' ? 'idleA' : 'idleN')}</div></div>`;
                return;
            }
            no += 1;
            const red = j.overDays != null;
            const mk = (j.limit != null && j.limit <= B && j.limit >= A ? `<div class="wmk limit" style="left:${X(j.limit * 1440 + W.end)}%" title="リミット ${md(j.limit)}(作り物)"></div>` : '')
                + (j.ship != null && j.ship <= B && j.ship >= A ? `<div class="wmk ship" style="left:${X(j.ship * 1440 + W.end)}%" title="出庫日 ${md(j.ship)}(作り物)"></div>` : '')
                + (j.kind === 'bar' && j.arrive >= A && j.arrive <= B ? `<div class="wdm" style="left:${X(j.arrive * 1440 + W.start)}%" title="検査に着く見込み ${md(j.arrive)}"></div>` : '');
            h += `<div class="wrow wjob${red ? ' over' : ''}"><div class="wleft"><span class="wno">${no}</span>
          <span class="wtx"><b><span class="code">${esc(j.it || '—')}</span>${esc(j.tx)}</b><i>${when(j.t0)} → ${dayOf(j.t1) === dayOf(j.t0) ? hm(j.t1) : when(j.t1)}・検査 ${hrs(j.dur)}${j.assumed ? '<u>(仮)</u>' : ''}${j.kind === 'here' ? '・着済' : `・${md(j.arrive)} 着`}・指図 ${esc(j.o)} ×${j.q}</i></span>
          <span class="wdue ${red ? 'r' : ''}"><b>${j.limit == null ? 'リミットなし' : `リミット ${md(j.limit)}`}${red ? ` <em>+${j.overDays}日</em>` : j.limit == null ? '' : ' 間に合う'}</b><i>${when(j.t1)} 終</i></span></div>
          <div class="wax">${colsHtml}${mk}${bars(j.pieces, red ? 'late' : 'ok')}</div></div>`;
        });
        if (!seq.length) h += `<div class="wrow wgap nojob"><div class="wleft"><span class="wno dash"></span><span class="wtx"><b>この期間の割付なし</b></span><span class="wdue"></span></div><div class="wax">${colsHtml}</div></div>`;
    });
    return h + '</div></div>';
}

export default function InspectWhoView({ forecast, inspectors = null, shipIsMock = true, fileLabel = '', initialMode = 'week' }) {
    const [mode, setMode] = useState(MODES[initialMode] ? initialMode : 'week');
    const names = inspectors && inspectors.length ? inspectors : MOCK_INSPECTORS;
    const namesMock = !(inspectors && inspectors.length);
    const DATA = useMemo(() => {
        const dow0 = new Date(forecast.today + 'T00:00:00Z').getUTCDay();
        const A = allocate({ rows: forecast.rows, inspectors: names, dow0, horizonDays: 45 });
        return { today: forecast.today, work: WORK, inspectors: names, jobs: A.jobs, gaps: A.gaps, skipped: A.skipped };
    }, [forecast, names.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
    const html = useMemo(() => whoHtml(DATA, mode), [DATA, mode]);
    const T0 = new Date(forecast.today + 'T00:00:00Z');
    return (
        <div className="ia iw" data-testid="sap-who">
            <div className="head"><h1>誰が検査をするか ― 誰が・何を・どの順で・リミットに間に合うか。手が空くなら、なぜか</h1><span className="x2" style={{ color: '#64748b' }}>{fileLabel}・今日 = {T0.getUTCMonth() + 1}/{T0.getUTCDate()}({WD[T0.getUTCDay()]})</span></div>
            {(shipIsMock || namesMock) ? <div className="mock" data-testid="sap-who-mock">これは見本です。<b>{namesMock ? '検査員の名前・人数・' : ''}{shipIsMock ? '出庫日(紫)とリミット(橙)' : ''}は作り物</b>。割り付けた物は「いつ来るか」で 検査に着く日が出た指図だけ(着いた物を リミットの早い順に、一番早く手が空く人へ)。検査員の名前と出庫日の本物のデータを渡せば 本物で出ます(本番は読みません)。</div> : null}
            <div className="legend">
                <span className="i"><span className="lg" style={{ background: '#22d3ee' }} />棒 = 検査をする時間</span>
                <span className="i"><span className="lg" style={{ background: '#f43f5e' }} />赤 = リミットを越えて終わる</span>
                <span className="i"><span style={{ display: 'inline-block', width: '0.5rem', height: '0.5rem', transform: 'rotate(45deg)', background: '#0891b2', marginRight: '0.125rem' }} />◆ = 検査に着く日</span>
                <span className="i"><span style={{ display: 'inline-block', width: '0.1875rem', height: '0.875rem', background: '#f59e0b' }} />橙 = リミット(出庫日の 2 稼働日前)</span>
                <span className="i"><span style={{ display: 'inline-block', border: '0.3125rem solid transparent', borderTop: '0.4375rem solid #7c3aed', borderBottom: 0 }} />紫 = 出庫日</span>
                <span className="i"><span className="lg" style={{ background: '#7dd3fc' }} />水色 = 手が空く(次の物がまだ着いていない)</span>
                <span className="i"><span className="lg" style={{ background: '#94a3b8' }} />灰 = 手が空く(検査する物が無い)</span>
            </div>
            <div className="bar2"><span className="lab">見る幅:</span>{Object.entries(MODES).map(([k, v]) => <button key={k} type="button" className="btn" aria-pressed={mode === k} onClick={() => setMode(k)} data-wm={k}>{v.label}</button>)}<span className="other">検査員 {names.length}人{namesMock ? '(作り物の名前)' : ''}・1 日 {Math.round((WORK.end - WORK.start - WORK.breaks.reduce((s, [a, b]) => s + b - a, 0)) / 6) / 10}h・08:30〜17:15</span></div>
            <div dangerouslySetInnerHTML={{ __html: html }} />
            <div className="foot">検査の時間 = SAP の検査(2509)の標準値3 × 数量。標準値が 0 の指図は 仮に {ASSUMED_MIN} 分(行に「仮」)。着く日はその日の朝から検査できると置いています(着く時刻は SAP に無い)。止まっている物・日付が出せない物は 割り付けていません。土日は休みです(会社の暦は未反映)。</div>
        </div>
    );
}
