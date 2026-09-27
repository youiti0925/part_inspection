import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import { runPipeline, app } from './engine.js';
import { runPlacementReview, dayKey, parseDay } from '../../domain/planningReview/placement.js';
import { auditProgressWorkbook } from '../../domain/planningReview/excelAudit.js';
import './review.css';

const weekdays=['日','月','火','水','木','金','土'];
const placeLabels={product:'製品',final:'最終',off:'休み'};
const dateLabel=d=>`${Number(d.slice(5,7))}/${Number(d.slice(8,10))}（${weekdays[parseDay(d).getDay()]}）`;
const timeLabel=ms=>new Date(ms).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
const step={id:'appearance',title:'外観検査',category:'検査',targetTime:3600};
const sample={
  lots:[{id:'sample-lot',templateId:'sample-template',model:'サンプル品目コード',orderNo:'例001',quantity:6,location:'inspection',entryAt:new Date('2026-09-04T08:30:00').getTime(),dueDate:'2026-09-09',steps:[step],tasks:{}}],
  templates:[{id:'sample-template',name:'外観検査の例',steps:[step]}], workers:[{id:'sample-worker',name:'作業者A'}],
  settings:{}, now:new Date('2026-09-07T08:30:00').getTime(),horizonDays:5,mode:'all',scenario:{compareAllSkills:false},
};
const filters=[['shipment-before-primary','日付の前後'],['split-dates-collapsed','分割予定'],['base-header-reference-mismatch','見出しと数式'],['all','すべて']];

function SourceTimeline({primaryDate,shipment,primaryLabel}) {
  if(!primaryDate||!shipment) return null;
  const a=parseDay(primaryDate)?.getTime(),b=parseDay(shipment)?.getTime();
  if(!Number.isFinite(a)||!Number.isFinite(b)) return null;
  const reversed=b<a;
  const utc=d=>Date.UTC(...d.split('-').map((v,i)=>Number(v)-(i===1?1:0)));
  const gap=Math.abs(utc(primaryDate)-utc(shipment))/86400000;
  const extent=70*Math.min(gap,31)/31;
  const inspectX=reversed?15+extent:15,shipX=reversed?15:15+extent;
  return <div className="source-time" aria-label={`${primaryLabel}予定 ${primaryDate}、出荷予定 ${shipment}`}>
    <svg viewBox="0 0 100 20" role="img" aria-label={reversed?'出荷予定の方が先':`${primaryLabel}予定の方が先`}>
      <line x1="10" y1="10" x2="90" y2="10" stroke="#cbd5e1" strokeWidth="1"/>
      <line x1={inspectX} y1="10" x2={shipX} y2="10" stroke={reversed?'#be123c':'#0e7490'} strokeWidth="3"/>
      <circle cx={inspectX} cy="10" r="3" fill="#0e7490"/>
      <path d={`M${shipX} 6 l4 7 h-8 Z`} fill="#be123c"/>
    </svg>
    <div className="spread"><span>● {primaryLabel} {primaryDate.slice(5)}</span><span>▲ 出荷 {shipment.slice(5)}</span></div>
    <small>{gap}日差{gap>31?'（31日幅を超えています）':''}</small>
  </div>;
}

function Schedule({result,input,name,title}) {
  if(!result) return null;
  const worker=result.normalized.workers.find(w=>w.name===name);
  const dates=worker?.availability||[];
  const byLot=new Map(input.lots.map(l=>[l.id||l.__id,l]));
  const tpl=new Map((input.templates||[]).map(t=>[t.id||t.__id,t.name]));
  return <section className="schedule"><h3>{title}</h3><div className="days">
    {dates.map(day=>{
      const jobs=(result.base.assignments||[]).filter(a=>(a.worker===name||a.partner===name)&&dayKey(a.startMs)===day.date).sort((a,b)=>a.startMs-b.startMs);
      const groups=[];
      for(const job of jobs){const last=groups[groups.length-1];if(last?.lotId===job.lotId)last.items.push(job);else groups.push({lotId:job.lotId,items:[job]});}
      const away=day.rosterStatus==='other',off=day.availableDirectMinutes===0;
      return <article key={day.date} className={`day ${away?'away':off?'off':''}`}>
        <header>{dateLabel(day.date)}</header>
        <strong>{away?'他工場':off?'勤務なし':`${day.availableDirectMinutes}分`}</strong>
        {groups.map((group,i)=>{const lot=byLot.get(group.lotId)||{};return <div className="job" key={`${group.lotId}-${i}`}>
          <b>{lot.model||group.lotId}</b><small>{tpl.get(lot.templateId)||lot.specialConditions||'作業内容名未取得'}</small><small>指図 {lot.orderNo||'未登録'}</small>
          {group.items.map((a,n)=><span key={n}>{timeLabel(a.startMs)} → {dayKey(a.startMs)===dayKey(a.endMs)?'':`${dayKey(a.endMs).slice(5)} `}{timeLabel(a.endMs)}</span>)}
        </div>;})}
        {!jobs.length&&<p className="muted">{off?'割付なし':'この日に始める仕事なし'}</p>}
      </article>;
    })}
  </div></section>;
}

export function PlanningReview() {
  const [tab,setTab]=useState('placement');
  const [input,setInput]=useState(sample),[source,setSource]=useState('動作確認用サンプル・全員が工程を持てる仮定');
  const [name,setName]=useState('作業者A'),[plan,setPlan]=useState({});
  const [review,setReview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [workbook,setWorkbook]=useState(null),[fileName,setFileName]=useState(''),[referenceDate,setReferenceDate]=useState(()=>dayKey(Date.now()));
  const [audit,setAudit]=useState(null),[filter,setFilter]=useState('shipment-before-primary');
  const [expanded,setExpanded]=useState(false);
  const changeDay=(wd,value)=>{setPlan(p=>({...p,[name]:{...p[name],weekdays:{...p[name]?.weekdays,[wd]:value}}}));setReview(null);};
  const run=async()=>{
    setBusy(true);setError('');setReview(null);
    try { await new Promise(resolve=>setTimeout(resolve,0));setReview(await runPlacementReview({input,app,plan,runPipeline})); }
    catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const loadInput=async e=>{
    const f=e.target.files?.[0];if(!f)return;
    try{
      const p=JSON.parse(await f.text());
      if(!Array.isArray(p.lots)||!Array.isArray(p.workers)||!p.workers.length||!Number.isFinite(p.now)||!Number.isInteger(p.horizonDays)||p.horizonDays<1||p.horizonDays>31)throw new Error('計算入力JSONには lots・workers・now・horizonDays（1〜31営業日）が必要です');
      setInput(p);setName(p.workers[0].name);setSource(f.name);setPlan({});setReview(null);setError('');
    }catch(err){setError(err.message);}
  };
  const loadExcel=async e=>{
    const f=e.target.files?.[0];if(!f)return;setBusy(true);setError('');setAudit(null);setWorkbook(null);
    try{await new Promise(resolve=>setTimeout(resolve,0));const w=XLSX.read(await f.arrayBuffer(),{type:'array',cellDates:false,cellStyles:true});setWorkbook(w);setFileName(f.name);setAudit(auditProgressWorkbook(w,{referenceDate}));}
    catch(err){setError(err.message);}finally{setBusy(false);}
  };
  const rows=(audit?.issues||[]).filter(i=>filter==='all'||i.code===filter);
  return <main>
    <header className="top"><div><p className="eyebrow">操業シミュレーション · 独立した確認画面</p><h1>配置と予定を、計算まで確かめる</h1></div><span className="app-label">{placeLabels[app]}検査</span></header>
    <nav aria-label="確認内容"><button className={tab==='placement'?'selected':''} onClick={()=>setTab('placement')}>人を置く曜日</button><button className={tab==='excel'?'selected':''} onClick={()=>setTab('excel')}>Excelの日付</button></nav>
    <p className="muted">この画面の変更は試算だけです。保存済みの配置・ロット・Excelは変更しません。</p>
    {error&&<p role="alert" className="alert">{error}</p>}
    {tab==='placement'?<>
      <section className="controls"><div className="spread"><h2>どの曜日に、どちらへ置く？</h2><label className="file-label">計算入力JSONを開く<input type="file" accept=".json" onChange={loadInput} disabled={busy}/></label></div>
        <p className="source">使用中：{source}</p>
        <label>作業者 <select value={name} onChange={e=>setName(e.target.value)} disabled={busy}>{input.workers.map(w=><option key={w.id||w.name}>{w.name}</option>)}</select></label>
        <div className="week">{[1,2,3,4,5,6,0].map(wd=><label key={wd} className={`weekday ${plan[name]?.weekdays?.[wd]||''}`}><b>{weekdays[wd]}</b><select aria-label={`${weekdays[wd]}曜日の配置`} disabled={busy} value={plan[name]?.weekdays?.[wd]||''} onChange={e=>changeDay(wd,e.target.value)}><option value="">登録どおり</option><option value="product">製品</option><option value="final">最終</option><option value="off">休み</option></select></label>)}</div>
        <button className="primary" onClick={run} disabled={busy}>{busy?'計算中…':'この配置で計算する'}</button>
      </section>
      {review&&<><div role="status" className={`result ${review.issues.length||review.conflicts.length?'problem':''}`}><strong>{review.issues.length?`反映を確認できない箇所 ${review.issues.length}件`:review.conflicts.length?`休み等と配置の重なり ${review.conflicts.length}件`:review.expected.length?'指定した配置制限を計算結果で確認しました':'曜日の変更はありません'}</strong><span>勤務情報と作業開始日を照合。終日をまたぐ作業の拘束区間は別途確認が必要です。</span></div>
        {[...review.conflicts,...review.issues].map((i,n)=><p className="alert" key={n}>{i.name} {i.date}：{i.message}</p>)}
        <Schedule result={review.after} input={input} name={name} title="この配置での仕事"/>
        <details><summary>変更前と比べる</summary><Schedule result={review.before} input={input} name={name} title="登録どおりの仕事"/></details>
      </>}
    </>:<>
      <section className="controls"><div className="spread"><h2>予定の食い違いを探す</h2><label className="file-label">Excelを開く<input type="file" accept=".xlsx,.xls" onChange={loadExcel} disabled={busy}/></label></div>
        <label>照合の基準日 <input type="date" value={referenceDate} onChange={e=>{setReferenceDate(e.target.value);setAudit(null);}} disabled={busy}/></label>
        {workbook&&!audit&&<button onClick={()=>{try{setAudit(auditProgressWorkbook(workbook,{referenceDate}));setError('');}catch(e){setError(e.message);}}}>この基準日で照合する</button>}
        {busy&&<p role="status">Excelを確認中…</p>}
        {!audit&&<p className="muted">自動修正はしません。元のセル・日付・備考を並べ、確認する場所を絞ります。</p>}
      </section>
      {audit&&<>
        <p className="source">{fileName} ／ {audit.sourceLabel} ／ 読み方：Z＝入荷・AB＝納期・AD＝出荷日（進捗管理表の既定）</p>
        <div className="stats"><div><b>{audit.counts.shipBeforePrimary}</b><span>出荷が{audit.primaryLabel}より前</span></div><div><b>{audit.counts.splitDatesCollapsed}</b><span>分割予定がまとまる</span></div><div><b>{audit.counts.shipUnreadable}</b><span>出荷日が文字のみ</span></div></div>
        <div className="quality" aria-label={`出荷日を読める${audit.counts.shipReadable}行、文字のみ${audit.counts.shipUnreadable}行、空欄${audit.counts.shipBlank}行`}>
          <i style={{flex:audit.counts.shipReadable,background:'#0e7490'}}/><i style={{flex:audit.counts.shipUnreadable,background:'#a16207'}}/><i style={{flex:audit.counts.shipBlank,background:'#94a3b8'}}/>
        </div><p className="muted">出荷日 {audit.counts.shipReadable}行 ／ 文字のみ {audit.counts.shipUnreadable}行 ／ 空欄 {audit.counts.shipBlank}行。{audit.scope}</p>
        <div className="filters">{filters.map(([key,label])=><button key={key} className={filter===key?'selected':''} onClick={()=>{setFilter(key);setExpanded(false);}}>{label} {key==='all'?audit.issues.length:audit.issues.filter(i=>i.code===key).length}</button>)}</div>
        <p className="muted">日付の線は全行共通の31日幅。長さが日付の差を表します。</p>
        <div className="issues">{rows.slice(0,expanded?rows.length:12).map((issue,i)=>{const r=audit.rows.find(r=>r.row===issue.row);return <article className="issue" key={`${issue.row}-${issue.code}-${i}`}><div><p className="eyebrow">{issue.cells.join(' · ')}</p><h3>{issue.model}</h3><p className="muted">指図 {issue.orderNo}</p><SourceTimeline primaryDate={r?.primaryDate} shipment={r?.shipment} primaryLabel={audit.primaryLabel}/></div><div><strong>{issue.message}</strong>{issue.parts&&<div className="parts">{issue.parts.map((p,n)=><span key={n}>{p.count}台 <b>{p.ymd.slice(5)}</b></span>)}</div>}<details><summary>元の値・備考</summary><p>{audit.primaryLabel}：{r?.rawPrimary||'空欄'} ／ 出荷：{r?.rawShipment||'空欄'}</p>{issue.note&&<p>{issue.note}</p>}{issue.related?.map((e,n)=><p key={n}>{e.sheet} {e.row}行：検査 {e.inspection} ／ 出荷 {e.shipment}</p>)}</details></div></article>;})}</div>
        {!rows.length&&<p>この種類の指摘はありません。日付の正しさを保証するものではありません。</p>}
        {!expanded&&rows.length>12&&<button onClick={()=>setExpanded(true)}>残り {rows.length-12}件を表示</button>}
      </>}
    </>}
  </main>;
}
createRoot(document.getElementById('root')).render(<PlanningReview/>);
