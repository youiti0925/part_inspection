// 🔍 部品検査に いつ来るか(Fable の見本「検査_いつ来るか_製品検査形」案4=まとめて見出し)
// 目的: SAP の計画に対して 検査へ 順調に来るか・遅れているか を 1行1指図+日付の軸で見せる。機械の負荷は出さない。
//   上の灰の細い棒=SAP の計画だけ(◇=検査予定日)/下の棒=済んだ分(濃)・今日からの見込み(薄い水色)・予定を越える分(赤)・◆=着く日/止まりは赤い点線/日付が出せない物は棒なしで理由一文。
// 数は作らない(src/domain/sapArrivalForecast.js の答えを置くだけ)。出庫日(紫▼)とリミット(橙)は 本物のデータが無い間 作り物の日付で印の見た目だけを示し、黄色の帯で言う。
// 入力: forecast(arrivalForecast の結果)・shipMode('mock'|'real')・fileLabel
// 呼ぶ人: SapProgressPanel.jsx の「部品検査に いつ来るか」の入口
// 確かめ方: sap-demo.html で実データを選ぶ
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import './inspectArrival.css';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TONE = { '旋盤': '#3b82f6', '立旋盤': '#0ea5e9', 'フライス': '#14b8a6', '横M/C': '#8b5cf6', '門M/C': '#d946ef', '平面研削': '#65a30d', '円筒研削': '#6366f1', '歯切り': '#f97316', '仕様変更': '#ec4899', '一時置き': '#94a3b8', '付帯作業': '#94a3b8', '洗浄': '#0891b2', '検査': '#059669' };
const INI = { '一時置き': '置', '付帯作業': '付' };
const SPAN_DEF = { a: [-28, 20, '4週前〜3週先'], b: [-7, 20, '1週前〜3週先'], c: [-28, 62, '4週前〜9週先'] };   // 月曜からの日数(今週の月曜を 0 として)
const GROUPS = [
    ['red', '予定より遅れて来る', '下の棒の赤 = 遅れる分', (r) => r.kind === 'bar' && r.late != null],
    ['stop', '止まっている', '赤い点線 = 動きの無い間・着く日は出せない', (r) => r.kind === 'stuck'],
    ['gray', '日付が出せない', '始まっていない・入力もれ', (r) => r.kind === 'unknown'],
    ['here', 'もう検査に着いている', '◆ = 着いた日', (r) => r.kind === 'here'],
    ['green', '予定どおり', '◇ と ◆ が同じ位置', (r) => r.kind === 'bar' && r.late == null],
];

export default function InspectArrivalView({ forecast, shipIsMock = true, fileLabel = '' }) {
    const { rows, sum: S, weekEnd, limitDays, today } = forecast;
    const real = !shipIsMock;
    const rootRef = useRef(null);
    const [span, setSpan] = useState('a');
    const [filter, setFilter] = useState('all');
    const [zig, setZig] = useState(false);
    const [openG, setOpenG] = useState({});
    const T0 = useMemo(() => new Date(today + 'T00:00:00Z').getTime(), [today]);
    const dt = (n) => new Date(T0 + n * 86400000);
    const md = (n) => { const d = dt(n); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
    const dow = (n) => dt(n).getUTCDay();
    const monOff = -((dow(0) + 6) % 7);
    const [A, B] = [monOff + SPAN_DEF[span][0], monOff + SPAN_DEF[span][1]];
    const cols = useMemo(() => {
        const c = []; let tot = 0;
        for (let n = A; n <= B; n++) { const off = dow(n) === 0 || dow(n) === 6; c.push({ n, off, w: off ? 0.35 : 1, l: tot }); tot += off ? 0.35 : 1; }
        c.forEach((x) => { x.left = x.l / tot * 100; x.width = x.w / tot * 100; x.mid = x.left + x.width / 2; });
        return c;
    }, [A, B, T0]); // eslint-disable-line react-hooks/exhaustive-deps
    const X = (n) => (n < A ? 0 : n > B ? 100 : cols[n - A].mid);

    const shown0 = rows;   // 出庫日・リミット・越えた日数は 見込みの行に入っている(本物が無い間は 作り物の日付で渡される)
    const overCount = shown0.filter((r) => r.over != null).length;
    const lateMax = Math.max(1, ...shown0.map((r) => r.late || 0));
    const FILTERS = {
        all: () => true, week: (r) => r.kind === 'bar' && r.arrive <= weekEnd, late: (r) => r.kind === 'bar' && r.late != null,
        stuck: (r) => r.kind === 'stuck', ok: (r) => r.kind === 'bar' && r.late == null, over: (r) => r.over != null,
    };

    const colsHtml = () => cols.map((c) => `<div class="col${c.off ? ' off' : ''}${c.n === 0 ? ' tod' : ''}${dow(c.n) === 1 ? ' mon' : ''}" style="left:${c.left}%;width:${c.width}%"></div>`).join('');
    const piece = (a, b, sap, cls, clsLate, extra) => {
        const xa = X(a), xb = X(b); if (!(xb > xa)) return '';
        const xs = sap == null ? 101 : (sap < A ? -1 : X(sap));
        const cut = Math.max(xa, Math.min(xb, xs));
        let h = '';
        if (cut > xa) h += `<div class="b ${cls} ${cut >= xb ? extra : extra.replace('rr', '').replace('sep', '')}" style="left:${xa}%;width:${cut - xa}%"></div>`;
        if (xb > cut) h += `<div class="b ${clsLate} ${cut <= xa ? extra : extra.replace('rl', '')}" style="left:${cut}%;width:${xb - cut}%"></div>`;
        return h;
    };
    const rowHtml = (r) => {
        const x0 = X(0);
        let h = colsHtml();
        // 上: SAP の計画の棒(開始〜検査の予定日)と ◇。🚨 済んだ分の塗りは入れない(済んだ分は下の棒だけ)
        if (r.sap != null) {
            const pa = r.planA == null ? r.sap : Math.min(r.planA, r.sap);
            const xa = X(pa), xb = X(r.sap);
            if (xb > xa) h += `<div class="pl" style="left:${xa}%;width:${xb - xa}%" title="SAP の計画 ${md(pa)}〜${md(r.sap)}"></div>`;
            if (r.sap >= A && r.sap <= B) h += `<div class="dm plan" style="left:${xb}%" title="SAP の検査予定 ${md(r.sap)}"></div><span class="lb plan t tn" style="left:${xb}%">${md(r.sap)}</span>`;
            else if (r.sap < A) h += `<span class="lb plan ledge t tn">◀ ${md(r.sap)}</span>`;
            else h += `<span class="lb plan edge t tn" style="margin-left:0">${md(r.sap)} ▶</span>`;
        }
        // 下: 済んだ分(濃い)
        if (r.firstAct != null) {
            const e = r.lastDone;
            if (X(e) > X(r.firstAct)) h += piece(r.firstAct, e, r.sap, 'done', 'doneL', 'rl' + (r.kind === 'here' ? '' : ' rr'));
            else h += `<div class="b ${r.sap != null && e > r.sap ? 'doneL' : 'done'} rl rr" style="left:calc(${X(e)}% - 0.25rem);width:0.5rem"></div>`;
            r.doneEnds.forEach((d) => { if (d > r.firstAct && d < e && d >= A) h += `<div class="tick" style="left:${X(d)}%"></div>`; });
            if (r.kind !== 'here' && X(0) > X(e)) h += `<div class="gap${r.kind === 'stuck' ? ' stop' : ''}" style="left:${X(e)}%;width:${x0 - X(e)}%" title="${md(e)} から動きなし(${-e}日)"></div>`;
        }
        // 下: これからの見込み(薄い)・予定を越える分は赤
        if (r.kind === 'bar') {
            const sg = r.segs;
            if (sg.length && sg[0].a > 0) h += `<div class="gap" style="left:${x0}%;width:${X(sg[0].a) - x0}%" title="${md(sg[0].a)} から始まる予定"></div>`;
            sg.forEach((s, i) => {
                if (i > 0 && X(s.a) > X(sg[i - 1].b)) h += `<div class="gap" style="left:${X(sg[i - 1].b)}%;width:${X(s.a) - X(sg[i - 1].b)}%"></div>`;
                h += piece(s.a, s.b, r.sap, 'fc', 'fcL', (i === 0 ? 'rl ' : '') + (i === sg.length - 1 ? 'rr' : 'sep')).replace(/class="b /g, `title="${esc(s.full)} 〜${md(s.b)}" class="b `);
                const la = Math.max(X(s.a), i === 0 ? x0 : 0), lw = (i === sg.length - 1 ? 100 : X(sg[i + 1].a)) - la;
                // 区切りの上の字 = 作業区の番号 + 工程名(活動番号は出さない・マウスを載せた時だけ)。入らなければ番号だけ・それも入らなければ省略
                if (s.a <= B && lw > 0) h += `<span class="sl t tn" data-short="${esc(s.wc)}" style="left:${la}%;max-width:${lw}%" title="${esc(s.full)}"><b>${esc(s.wc)}</b> ${esc(s.n)}</span>`;
            });
            const red = r.late != null;
            if (r.arrive <= B) { const xa = X(r.arrive); h += `<div class="dm arr${red ? ' red' : ''}" style="left:${xa}%"></div><span class="lb arr${red ? ' red' : ''}${xa > 90 ? ' flip' : ''} t tn" style="left:${xa}%">${md(r.arrive)} 着</span>`; }
            else h += `<span class="lb arr edge t tn" style="margin-left:0">${md(r.arrive)} 着 ▶</span>`;
        } else if (r.kind === 'here') {
            const red = r.late != null;
            if (r.arrive >= A) { const xa = X(r.arrive); h += `<div class="dm arr ${red ? 'red' : 'here'}" style="left:${xa}%"></div><span class="lb arr${red ? ' red' : ''} t tn" style="left:${xa}%">${md(r.arrive)} 着済</span>`; }
            else h += `<span class="lb arr ledge t tn">◀ ${md(r.arrive)} 着済</span>`;
        } else if (r.kind === 'stuck') h += `<span class="tag stop t" style="left:${x0}%" title="${esc(r.why)}">${r.tag}日止まり</span>`;
        else h += `<span class="tag unk t" style="left:${x0}%" title="${esc(r.why)}">? ${esc(r.short)}</span>`;
        // 出庫日(▼紫)とリミット(橙の太い線)
        const tipSrc = real ? '' : '・作り物';
        if (r.limit != null && r.limit >= A && r.limit <= B) h += `<div class="mk limit" style="left:${X(r.limit)}%" title="リミット ${md(r.limit)}(出庫日 ${md(r.ship)} の ${limitDays}稼働日前${tipSrc})"></div>`;
        if (r.ship != null && r.ship >= A && r.ship <= B) h += `<div class="mk ship" style="left:${X(r.ship)}%" title="出庫日 ${md(r.ship)}${tipSrc}"></div>`;
        // 今日の縦線(イナズマ線はボタンで重ねる)
        const xp = r.prog === 0 ? x0 : X(r.prog);
        if (zig) h += `<svg class="zz" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${x0},-12 ${xp},16 ${x0},112" fill="none" stroke="${xp < x0 ? '#e11d48' : xp > x0 ? '#059669' : '#0e7490'}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
        else h += `<div class="now" style="left:${x0}%"></div>`;
        const dots = [...r.stg].map((c, i) => `<span class="sd${c === '1' ? ' d' : ''}${i === r.k - 1 ? ' c' : ''}${i === r.insIdx ? ' i' : ''}"></span>`).join('');
        const nmHtml = `<div class="name"><span class="av" style="background:${TONE[r.cur] || '#94a3b8'}" title="今の工程: 作業区 ${esc(r.curWc)} ${esc(r.cur)}"><span class="t">${esc(INI[r.cur] || r.cur.slice(0, 1))}</span></span>
      <span class="l1" title="${esc(r.it)} ${esc(r.tx)}｜作業区 ${esc(r.curWc)} ${esc(r.cur)}"><span class="code tn">${esc(r.it || '—')}</span><b>${esc(r.tx)}</b><i class="t">｜${esc(r.curWc)} ${esc(r.cur)}${r.kind === 'here' ? '(着済)' : ''}</i></span>
      <span class="l2 tn"><span class="t">指図 ${esc(r.o)} ×${r.q}</span><span class="sds" title="全 ${r.n} 工程の ${r.k} 番目(濃い=済・水色の枠=今・◇=検査)">${dots}</span><b class="t">${r.k}/${r.n} 工程</b></span></div>`;
        const lateHtml = r.late == null ? '<span></span>' : `<span class="late" title="${r.lateKind === 'fc' ? `検査に着く見込みが SAP の検査予定より ${r.late}日 あと` : r.lateKind === 'fact' ? `SAP の検査予定より ${r.late}日 あとに着いた` : `SAP の検査予定を ${r.late}日 過ぎている`}"><span class="g${r.lateKind === 'fc' ? ' fc' : ''}"><div style="width:${Math.min(100, r.late / lateMax * 100)}%"></div></span><b class="tn t">+${r.late}日</b></span>`;
        const overHtml = r.over == null ? '' : `<span class="ov t tn" title="${r.arrive != null ? '検査に着く見込み' : '今日'}が リミット ${md(r.limit)} を ${r.over}日 越える(出庫日 ${md(r.ship)}${tipSrc})">リミット+${r.over}日</span>`;
        return `<div class="row grid${r.over != null ? ' over' : ''}" data-o="${esc(r.o)}" data-sig="${r.sig}" data-kind="${r.kind}"><span class="sig ${r.sig}"></span>${nmHtml}<span class="lc">${lateHtml}${overHtml}</span><div class="ax">${h}</div></div>`;
    };

    const list = useMemo(() => shown0.filter(FILTERS[filter] || FILTERS.all), [shown0, filter, weekEnd]); // eslint-disable-line react-hooks/exhaustive-deps
    const wide = cols.length <= 31;
    const heads = cols.map((c) => {
        if (c.n === 0) return `<div class="dh today t" style="left:${c.mid}%">今日 ${md(0)}(${WD[dow(0)]})</div>`;
        if (c.off) return '';
        if (!wide && dow(c.n) !== 1) return '';
        if (!wide && c.n > -5 && c.n < 5) return '';
        if (wide && Math.abs(c.n) === 1) return '';
        return `<div class="dh t" style="left:${c.left}%">${md(c.n)}${wide ? '' : `(${WD[dow(c.n)]})`}${!wide ? `<span class="rel">${c.n > 0 ? '+' : ''}${c.n}日</span>` : ''}</div>`;
    }).join('');
    const hdrHtml = `<div class="grid hdr"><div class="c t">品目コード 品名｜今の工程(作業区) ／ 指図・個数・何工程目</div><div class="c t" style="text-align:right">遅れ</div><div class="axis">${heads}</div></div>`;

    // 区切りの字が入らない時は 作業区番号だけ・それも入らなければ消す
    useLayoutEffect(() => {
        const root = rootRef.current; if (!root) return;
        root.querySelectorAll('.sl').forEach((el) => { if (el.scrollWidth > el.clientWidth + 1) { el.innerHTML = `<b>${el.dataset.short}</b>`; if (el.scrollWidth > el.clientWidth + 1) el.style.display = 'none'; } });
    });

    const tile = (k, l, n) => (
        <button key={k} type="button" className={`tile k-${k}`} aria-pressed={filter === k} onClick={() => { setFilter(filter === k ? 'all' : k); }} data-ia-tile={k}><div className="l">{l}</div><div className="n tn">{n}<small>件</small></div></button>
    );
    const wk = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
    return (
        <div className="ia" ref={rootRef} data-testid="sap-ia">
            <div className="head"><h1>部品検査に いつ来るか ― SAP の計画に対して 順調か・遅れているか</h1><span className="x2" style={{ color: '#64748b' }}>{fileLabel}・今日 = {wk(dt(0))}</span></div>
            <div className="legend">
                <span className="i"><span className="lg" style={{ height: '0.3125rem', background: '#cbd5e1' }} /><span style={{ display: 'inline-block', width: '0.5rem', height: '0.5rem', transform: 'rotate(45deg)', border: '2px solid #64748b', background: '#fff', marginRight: '0.125rem' }} />上の灰 = SAP の計画だけ(開始〜検査の予定日 ◇)</span>
                <span className="i"><span className="lg" style={{ background: '#0e7490' }} />下の濃い = 実際に済んだ分(最初の完了〜最後の完了)</span>
                <span className="i"><span className="lg" style={{ background: '#67e8f9' }} /><span style={{ display: 'inline-block', width: '0.5rem', height: '0.5rem', transform: 'rotate(45deg)', background: '#0891b2', marginRight: '0.125rem' }} />薄い = 今日から検査に着くまで(◆ = 着く日)</span>
                <span className="i"><span className="lg" style={{ background: '#fb7185' }} />赤 = 予定より遅れる分</span>
                <span className="i"><span style={{ display: 'inline-block', width: '0.125rem', height: '0.875rem', background: '#0e7490' }} />縦の線 = 今日</span>
                <span className="i"><span style={{ display: 'inline-block', width: '0.1875rem', height: '0.875rem', background: '#f59e0b' }} />橙 = リミット(出庫日の {limitDays} 稼働日前)</span>
                <span className="i"><span style={{ display: 'inline-block', border: '0.3125rem solid transparent', borderTop: '0.4375rem solid #7c3aed', borderBottom: 0 }} />紫 = 出庫日</span>
                <span className="i"><span style={{ display: 'inline-block', width: '0.25rem', height: '0.875rem', borderRadius: '0.25rem', background: '#e11d48' }} /><span style={{ display: 'inline-block', width: '0.25rem', height: '0.875rem', borderRadius: '0.25rem', background: '#f59e0b' }} /><span style={{ display: 'inline-block', width: '0.25rem', height: '0.875rem', borderRadius: '0.25rem', background: '#10b981' }} /><span title="黄 = 今の進みは SAP の計画より後ろだが、検査の予定日には間に合う見込み">左端の色 = 赤:遅れ / 黄:注意 / 緑:順調</span></span>
            </div>
            {!real ? <div className="mock" data-testid="sap-ia-mock">出庫日(紫)とリミット(橙)は <b>作り物の日付</b> です。本物の出庫日は進捗管理表に在りますが、部品の指図と結ぶデータが手元に無いため、印の見た目だけを示しています。指図ごとの出庫日を渡せば 本物で出ます。</div> : null}
            <div className="tiles">{[['week', '今週 検査に来る', S.week], ['late', '予定より遅れて来る', S.late], ['stuck', '止まっている', S.stuck], ['ok', '予定どおり', S.ontime]].map(([k, l, n]) => tile(k, l, n))}</div>
            <div className="bar2"><span className="lab">並び: 遅れの大きい順</span><button type="button" className="btn" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); }}>全部</button><span className="lab" style={{ marginLeft: '0.5rem' }}>見る幅:</span>
                <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>{Object.entries(SPAN_DEF).map(([k, v]) => <button key={k} type="button" className="btn" aria-pressed={span === k} onClick={() => setSpan(k)} data-ia-span={k}>{v[2]}</button>)}</span>
                <button type="button" className="btn" style={{ marginLeft: '0.5rem' }} aria-pressed={filter === 'over'} onClick={() => { setFilter(filter === 'over' ? 'all' : 'over'); }}>リミット越え {overCount}件{real ? '' : '(作り物)'}</button>
                <button type="button" className="btn" style={{ marginLeft: '0.5rem' }} aria-pressed={zig} onClick={() => setZig(!zig)}>イナズマ線を重ねる</button>
                <span className="other">全 {S.total}件(ほかに もう検査に着いている {S.here}件・日付が出せない {S.unknown}件)</span></div>
            <p className="scrollhint" data-testid="sap-ia-scrollhint">棒グラフは 左右に スクロールできます →</p>
            <div className="ia-scroll" data-testid="sap-ia-scroll"><div className="ia-scroll-in">
                <div dangerouslySetInnerHTML={{ __html: hdrHtml }} />
                {GROUPS.map(([k, title, hint, f]) => {
                    const g = list.filter(f); if (!g.length) return null;
                    const n = openG[k] ? g.length : Math.min(6, g.length);
                    return (
                        <React.Fragment key={k}>
                            <div className={`grp ${k}`} data-ia-group={k}><span className="n">{g.length}</span>件 {title}<small>{hint}</small></div>
                            <div dangerouslySetInnerHTML={{ __html: g.slice(0, n).map(rowHtml).join('') }} />
                            {g.length > n ? <button type="button" className="grpmore" onClick={() => setOpenG({ ...openG, [k]: true })}>{title}: あと {g.length - n}件を開く</button> : null}
                        </React.Fragment>
                    );
                })}
                {!list.length ? <div className="foot">この条件の指図はありません。</div> : null}
            </div></div>
            <div className="foot">検査に着く見込み: 残りの機械工程が 1 つ以下の物 = 前の工程の実績 + 工程ごとの普段の日数 / それより手前の物 = SAP の予定どおり(ただし SAP の予定がもう過ぎた・普段の日数では間に合わない物は 普段の日数で出す)。止まっている物・予定を過ぎて未着手の物・完了の入力もれらしい物は 日付を作らず「不明」と出します。土日は休みとして描いています(会社の暦は未反映)。SAP には「作業中」の記録が無いので、済んだ日だけを使っています。</div>
        </div>
    );
}
