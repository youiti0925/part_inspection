import { submissionRows, verdictLabel, VERDICT_LABELS } from '../../domain/planControl/submissionEvidence.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const reportClock = (ms, zone) => Number.isFinite(ms) ? new Date(ms).toLocaleString('ja-JP', { timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false }) : '未確認';
/* 🚨 2026-09-22 超過時間は 0.1時間まで で出す。丸めが無く「13.716666666666667 時間」と出ていた。
   ⚠ 数え方(lateMs)は1バイトも変えない。Excel には生の時間を入れるので、見せ方だけ。 */
export const hours1 = (ms) => (Number.isFinite(Number(ms)) ? Math.round(Number(ms) / 360000) / 10 : '未確認');
const chunks = (xs, n) => Array.from({length:Math.ceil(xs.length/n)},(_,i)=>xs.slice(i*n,(i+1)*n));

function gantt(l, plan) {
  const from = plan.context.fromMs, to = plan.context.toMs;
  const x = ms => Math.max(0,Math.min(100,(ms-from)/(to-from)*100));
  const spans = l.tasks.flatMap(t => plan.evidence.spansByTask[t.key] || []);
  const bars = spans.map(([s,e]) => `<i style="left:${x(s)}%;width:${Math.max(0,x(e)-x(s))}%"></i>${Number.isFinite(l.dueMs)&&e>l.dueMs?`<i class="late" style="left:${x(Math.max(s,l.dueMs))}%;width:${Math.max(0,x(e)-x(Math.max(s,l.dueMs)))}%"></i>`:''}`).join('');
  return `<div class="gantt">${bars}${Number.isFinite(l.dueMs)&&l.dueMs>=from&&l.dueMs<=to?`<b style="left:${x(l.dueMs)}%"></b>`:''}</div>${!spans.length?'<small>描ける勤務区間なし</small>':''}`;
}

export function submissionHTML(plan, {summaryOnly=false, reviewLine=''}={}) {
  const rows = submissionRows(plan), zone = plan.evidence.timeZone;
  const clock = ms => reportClock(ms,zone);
  const counts = [0,1,2,3].map(t=>rows.filter(r=>r.tier===t).length);
  const header = title => `<header><div>${esc(plan.context.app==='final'?'最終検査':'製品検査')} ／ 第${esc(plan.revision)}版</div><h1>${title}</h1><p>${esc(clock(plan.context.fromMs))} ～ ${esc(clock(plan.context.toMs))}</p></header>`;
  const sections = [];
  sections.push(`${header('操業計画の承認依頼')}<div class="metrics">${VERDICT_LABELS.map((s,i)=>`<div class="tone${i}"><strong>${counts[i]}</strong>${s}ロット</div>`).join('')}</div>
    <h2>承認する対象</h2><p>この保存版の計算対象 ${rows.length} ロット・${plan.tasks.length} 工程。担当と時刻は後続の納期一覧・工程明細で照合できます。</p>
    <p>${esc(plan.evidence.scope)}</p><h2>確認が必要な内容</h2><p>未割付 ${plan.tasks.filter(t=>!t.assignment).length} 工程 ／ 入力の確認事項 ${plan.qualityIssues.length} 種類。</p>
    <p>日付は検査の納期線です。出荷日との対応と、取込元の正しさは別途確認が必要です。棒は予測した勤務区間で、実績ではありません。</p>
    <h2>採用条件と記録</h2><p>始業 ${esc(plan.evidence.calendarSpec?.dayStartHHMM || '未確認')} ／ 基準の直接作業 ${esc(plan.evidence.calendarSpec?.directMinutesPerDay ?? '未確認')} 分/日。個人設定・曜日配置・休日・残業の内訳はExcelの勤務条件と保存データに記録しています。</p><p>全設定の復元、他エリアとの同時予約、共有の承認履歴は未接続です。</p>
    <dl><dt>計画ID</dt><dd>${esc(plan.id)}</dd><dt>計算ID</dt><dd>${esc(plan.source.runId)}</dd><dt>計算日時</dt><dd>${esc(clock(plan.source.calculatedAt))}</dd><dt>計算版</dt><dd>${esc(plan.source.engineVersion)}</dd><dt>表示時刻の地域</dt><dd>${esc(zone)}</dd></dl>
    <div class="approval">判断： □ 承認 □ 条件付き □ 差戻し<br>承認者：________________ 日付：________________<br>条件・指示：________________________________________________</div>
    <p>${esc(reviewLine || 'アプリ上の承認記録: 未承認（保存のみ）')}</p>
    <p>${summaryOnly?'全件の根拠は「詳細版」を併せて提出してください。':'以降は保存した同じ計算の全件です。画面のページ送りや絞り込みは引き継ぎません。'}</p>`);
  if (!summaryOnly) {
    for (const group of chunks(rows,3)) sections.push(`${header('納期一覧 — 計算結果の根拠')}<p class="legend">青：勤務区間 赤：納期を越えた勤務区間 縦線：納期 空白：作業を割り付けていない時間（休日・休憩を含む）</p><p>${esc(clock(plan.context.fromMs))} ← 共通の暦時間軸 → ${esc(clock(plan.context.toMs))}</p>${group.map(l=>`<article class="tone${l.tier}" data-lot-id="${esc(l.lotId)}"><div class="rowhead"><strong>${esc(l.model)} ／ ${esc(l.variant)}</strong><b>${esc(verdictLabel(l))}</b></div><p>指図 ${esc(l.orderNo||'未記載')} ロット ${esc(l.lotId)}</p>${gantt(l,plan)}<p>納期 ${esc(clock(l.dueMs))} 完了見込み ${esc(clock(l.finishMs))} 超過 ${l.lateMs===null?'未確認':`${hours1(l.lateMs)} 時間（暦時間）`}</p><p>担当 ${esc([...new Set(l.tasks.flatMap(t=>[t.assignment?.worker,t.assignment?.partner]).filter(Boolean))].join('・')||'未割付')} ${esc(l.reason)}</p></article>`).join('')}`);
    for (const group of chunks(plan.tasks,6)) sections.push(`${header('工程別の割付 — 誰が何をいつ行うか')}<table><thead><tr><th>型式・内容／指図・台</th><th>工程・担当</th><th>開始／終了見込み</th></tr></thead><tbody>${group.map(t=>`<tr><td>${esc(t.model)} ／ ${esc(t.variant)}<br>${esc(t.orderNo||'指図未記載')} ／ ${t.unitIndex===null?'ロット1回':`${t.unitIndex+1}台目`}<br><small>${esc(t.lotId)}</small></td><td>${esc(t.processLabel||t.stepId)}<br>${esc(t.assignment?[t.assignment.worker,t.assignment.partner].filter(Boolean).join('・'):'未割付')}</td><td>${esc(clock(t.assignment?.startMs))}<br>${esc(clock(t.assignment?.endMs))}</td></tr>`).join('')}</tbody></table>`);
    for (const group of chunks(plan.qualityIssues,15)) sections.push(`${header('入力の未確認事項')}<ul>${group.map(q=>`<li>${esc(q.message)}</li>`).join('')}</ul><p>計画の保存時に確認扱いにした項目も残しています。確認済みとデータ修正済みは別です。</p>`);
  }
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>操業計画 第${esc(plan.revision)}版</title><style>
    @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:"Noto Sans JP","Yu Gothic","Meiryo",sans-serif;color:#172d43;font-size:.78rem;margin:0}section{break-after:page}section:last-of-type{break-after:auto}h1{font-size:1.5rem;margin:.2rem 0}h2{font-size:1rem;margin:.8rem 0 .3rem}p{margin:.3rem 0;overflow-wrap:anywhere}header{border-bottom:.15rem solid #172d43;margin-bottom:.6rem}header div{float:right}.metrics{display:flex;gap:1rem;margin:1rem 0}.metrics div{border-left:.4rem solid;padding:.3rem 1rem}.metrics strong{display:block;font-size:2rem}.metrics .tone0,.metrics .tone1,.tone0,.tone1{border-color:#b91c1c}.metrics .tone2,.tone2{border-color:#a16207}.metrics .tone3,.tone3{border-color:#0369a1}article{border-left:.3rem solid;padding:.25rem .7rem;margin:.4rem 0;background:#f4f7fa;break-inside:avoid}.rowhead{display:flex;justify-content:space-between;gap:1rem}.gantt{position:relative;height:1rem;background:repeating-linear-gradient(90deg,#e2e8f0 0,#e2e8f0 .06rem,transparent .06rem,transparent 10%);margin:.25rem 0}.gantt i{position:absolute;height:100%;background:#0369a1}.gantt i.late{background:#b91c1c}.gantt b{position:absolute;border-left:.15rem solid #991b1b;height:140%;top:-20%}table{width:100%;border-collapse:collapse;table-layout:fixed}th{text-align:left;background:#e2e8f0}td,th{padding:.4rem;border-bottom:.06rem solid #cbd5e1;overflow-wrap:anywhere}tr{break-inside:avoid}thead{display:table-header-group}dl{display:grid;grid-template-columns:8rem 1fr;margin:.5rem 0}dd{margin:0;overflow-wrap:anywhere}.approval{border:.08rem solid #64748b;padding:.8rem;line-height:2}footer{border-top:.06rem solid #94a3b8;margin-top:.6rem;padding-top:.2rem;overflow-wrap:anywhere;font-size:.65rem}button{padding:.6rem;margin:.5rem}@media print{.controls{display:none}footer{position:fixed;bottom:0;left:0;right:0;margin:0;background:white}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
    </style><div class="controls"><button onclick="window.print()">印刷・PDFに保存</button>保存計画の出力。承認操作は記録されません。</div>${sections.map(s=>`<section>${s}</section>`).join('')}<footer>計画 ${esc(plan.id)} ／ 第${esc(plan.revision)}版 ／ 計算 ${esc(plan.source.runId)}</footer></html>`;
}

export function openSubmission(plan,summaryOnly=false,meta={}) {
  const html = submissionHTML(plan,{summaryOnly, reviewLine: meta && meta.reviewLine ? meta.reviewLine : ''});
  const w = window.open('','_blank');
  if (!w) throw new Error('提出資料を開くため、ポップアップを許可してください');
  w.opener = null; w.document.open(); w.document.write(html); w.document.close();
}

export async function downloadSubmissionExcel(plan, meta = {}) {
  const rows = submissionRows(plan), zone = plan.evidence.timeZone;
  /* 🚨 2026-09-22 両アプリが持っている exceljs を使う(xlsx は製品検査にしか無く、
     最終検査ではビルドが通らなかった)。出す中身は1つも変えていない。 */
  const ExcelJS = (await import('exceljs')).default;
  // 表示する地域の壁時計に合わせた「Excel の日付」。⚠ 読めない時は空欄(勝手に今の時刻を入れない)。
  const cell = (ms) => {
    if (!Number.isFinite(ms)) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
  };
  const wb = new ExcelJS.Workbook();
  const sheet = (name, data) => {
    const ws = wb.addWorksheet(name);
    for (const r of data) {
      const row = ws.addRow(r.map(v => (v === null || v === undefined ? '' : v)));
      row.eachCell((c) => { if (c.value instanceof Date) c.numFmt = 'yyyy/mm/dd hh:mm'; });
    }
    ws.columns.forEach((c) => { c.width = 24; });
    ws.getRow(1).font = { bold: true };
  };
  sheet('提出条件', [['項目', '保存値'], ['計画ID', plan.id], ['版', plan.revision], ['計算ID', plan.source.runId], ['計算日時', cell(plan.source.calculatedAt)], ['計算版', plan.source.engineVersion], ['入力照合キー', '添付JSONの source.inputKey（省略なし）'], ['地域', zone], ['対象', plan.evidence.scope], ['承認状態', meta && meta.reviewLine ? meta.reviewLine : '未承認（保存のみ）'], ['復元範囲', '勤務条件はJSONに保存。全設定の再現は未対応']]);
  sheet('納期一覧', [['ロットID', '型式', 'テンプレ・特注仕様', '指図', '判定', '入荷（計算使用）', '納期', '完了見込み', '超過時間（暦h）', '理由'],
    ...rows.map(l => [l.lotId, l.model, l.variant, String(l.orderNo), verdictLabel(l), cell(l.arrivalMs), cell(l.dueMs), cell(l.finishMs), l.lateMs === null ? null : l.lateMs / 3600000, l.reason])]);
  sheet('工程割付', [['工程キー', 'ロットID', '型式', 'テンプレ・特注仕様', '指図', '台', '工程', '担当', '共同担当', '開始', '終了'],
    ...plan.tasks.map(t => [t.key, t.lotId, t.model, t.variant, String(t.orderNo), t.unitIndex === null ? 'ロット1回' : t.unitIndex + 1, t.processLabel, t.assignment?.worker || '未割付', t.assignment?.partner || '', cell(t.assignment?.startMs), cell(t.assignment?.endMs)])]);
  sheet('勤務区間', [['工程キー', '勤務開始', '勤務終了'],
    ...plan.tasks.flatMap(t => (plan.evidence.spansByTask[t.key] || []).map(([s, e]) => [t.key, cell(s), cell(e)]))]);
  sheet('未確認事項', [['識別子', '内容'], ...plan.qualityIssues.map(q => [q.id, q.message])]);
  const conditions = [];
  const flatten = (v, path) => {
    if (v && typeof v === 'object' && Object.keys(v).length) Object.entries(v).forEach(([k, value]) => flatten(value, path ? `${path}.${k}` : k));
    else conditions.push([path, v == null ? '未確認' : typeof v === 'object' ? JSON.stringify(v) : v]);
  };
  flatten(plan.evidence.calendarSpec, '勤務条件');
  sheet('勤務条件', [['計算に使用した設定の項目', '保存値'], ...conditions]);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `操業計画_第${plan.revision}版.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadEvidence(plan) {
  submissionRows(plan);
  const url=URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`操業計画_第${plan.revision}版_保存データ.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
