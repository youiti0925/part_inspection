/** Isolated two-lot experiment. Minutes relative to an explicit experiment origin.
 * No production imports, persistence or implicit clocks. NOT a factory scheduler.
 */
export const MODES = ['wait', 'return', 'finish'];
export function compare(input) {
  const x = structuredClone(input);
  const required = ['autoMin','responseMin','otherMin','outMin','backMin','marginMin','windowMin'];
  const errors = required.filter(k => typeof x[k] !== 'number' || !Number.isFinite(x[k]) || x[k] < 0).map(k=>`${k}: 0以上の数値が必要`);
  for (const k of ['dueA','dueB']) if (x[k] !== null && (typeof x[k] !== 'number' || !Number.isFinite(x[k]) || x[k] < 0)) errors.push(`${k}: 数値またはnullが必要`);
  for (const k of ['mayLeave','canDoB','equipmentBAvailable','sameEquipment','interruptible','urgent']) if (typeof x[k] !== 'boolean') errors.push(`${k}: 明示的な真偽値が必要`);
  if (!x.autoMin || !x.responseMin || !x.otherMin || !x.windowMin) errors.push('自動・終了対応・別作業・勤務窓は正の時間が必要');
  if (errors.length) return {status:'unknown', errors, rows:[]};
  const rows = MODES.map(mode => run(x,mode));
  const base = rows[0];
  for (const row of rows) {
    row.delta = row.status === 'ok' && base.status === 'ok' ? {
      a: row.aEnd-base.aEnd, b:row.bEnd-base.bEnd,
      pair: row.pairEnd-base.pairEnd, idle: row.idleMin-base.idleMin,
      travel: row.travelMin-base.travelMin,
    } : null;
  }
  return {status:'ok', scope:'two-terminal-tasks-one-worker', input:x, rows, productionEligible:false};
}
function run(x, mode) {
  const segments=[];
  const add=(lane,kind,start,end)=>{ if(end>start) segments.push({lane,kind,start,end}); };
  const rejected=reason=>({mode,status:'blocked',reason,segments:[]});
  // Two terminal jobs only. A owns its equipment until its response is complete.
  let aStart=x.autoMin, bStart, bEnd, aEnd, idleMin=0,travelMin=0,progress=0;
  if(mode==='wait') {
    aEnd=aStart+x.responseMin;
    bStart=aEnd+x.outMin; bEnd=bStart+x.otherMin;
    add('worker','idle',0,x.autoMin);idleMin=x.autoMin;
    add('worker','response',aStart,aEnd);
    add('worker','travel',aEnd,bStart); travelMin=x.outMin;
    add('worker','other',bStart,bEnd);
  } else {
    if(!x.mayLeave) return rejected('この自動工程は離席不可、または監視が必要');
    if(!x.canDoB) return rejected('この作業者は別工程を担当できない');
    if(!x.equipmentBAvailable || x.sameEquipment) return rejected('別工程の設備を使えない（元の設備は終了対応まで占有）');
    const budget=x.autoMin-x.marginMin-x.outMin-x.backMin;
    progress=mode==='finish'?x.otherMin:Math.min(x.otherMin,Math.max(0,budget));
    if(progress<=0) return rejected('往復と戻り余裕を引くと作業時間が残らない');
    if(progress<x.otherMin && !x.interruptible) return rejected('終了前に戻るには中断が必要だが、この工程は中断不可');
    const backAt=x.outMin+progress+x.backMin;
    if(x.urgent && backAt>x.autoMin-x.marginMin) return rejected('緊急ロットの戻り期限を超える');
    aStart=Math.max(x.autoMin,backAt); aEnd=aStart+x.responseMin;
    add('worker','travel',0,x.outMin);
    add('worker','other',x.outMin,x.outMin+progress);
    add('worker','travel',x.outMin+progress,backAt);
    add('worker','idle',backAt,aStart);idleMin=Math.max(0,aStart-backAt);
    add('worker','response',aStart,aEnd);travelMin=x.outMin+x.backMin;
    if(progress<x.otherMin) {
      bStart=aEnd+x.outMin; bEnd=bStart+(x.otherMin-progress);
      add('worker','travel',aEnd,bStart);travelMin+=x.outMin;
      add('worker','other',bStart,bEnd);
    } else bEnd=x.outMin+x.otherMin;
  }
  // Baseline B eligibility also matters: do not make the baseline feasible by fiat.
  if(!x.canDoB || !x.equipmentBAvailable) return rejected('別工程の技能または設備の条件が未成立');
  const pairEnd=Math.max(aEnd,bEnd);
  if(pairEnd>x.windowMin) return rejected('指定した連続勤務窓を超える。休憩・休日を含む全体計算が必要');
  add('A','auto',0,x.autoMin);add('A','waiting',x.autoMin,aStart);add('A','response',aStart,aEnd);
  for(const s of segments.filter(s=>s.lane==='worker' && s.kind==='other')) add('B','other',s.start,s.end);
  add('equipmentA','occupied',0,aEnd);
  const late=(end,due)=>due===null?null:Math.max(0,end-due);
  return {mode,status:'ok',segments,aEnd,bEnd,pairEnd,idleMin,travelMin,
    machineWaitMin:aStart-x.autoMin,lateA:late(aEnd,x.dueA),lateB:late(bEnd,x.dueB),
    deadlineUnknown:x.dueA===null||x.dueB===null,progressBeforeReturn:progress};
}
export const EXAMPLE={autoMin:30,responseMin:5,otherMin:20,outMin:3,backMin:3,marginMin:2,windowMin:120,
 dueA:40,dueB:60,mayLeave:true,canDoB:true,equipmentBAvailable:true,sameEquipment:false,interruptible:false,urgent:false};
