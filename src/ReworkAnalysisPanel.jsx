// 🔁 やり直し(再作業)の中身 — 何を直すと効くか(不具合分析タブの中に出す)。
//   製品 App.jsx の reworkStats(useMemo)と「やり直し(再作業)の中身」の表を写した物。
//   部品向けの違い: 型式の列は「品目コード｜品名」(itemMaster の resolveItemName)で出す。
//   ロットの中の tasks[].reworks[] を「1回 = 1行」に開き(domain/reworkAnalysis.js)、原因ごと・種別ごと・回ごとに数え直す。
//   時間の元は reworks[].duration(秒)だけ。
import React, { useMemo, useState } from 'react';
import { RotateCcw, ChevronRight } from 'lucide-react';
import { reworkRows, byCause, byCauseModelTemplate, byRound, reworkSummary, ROUND_LABELS, UNKNOWN_CAUSE, UNKNOWN_KIND } from './domain/reworkAnalysis.js';
import { REWORK_KIND_COLOR, reworkKindOrder } from './reworkKinds.js';
import { resolveItemName } from './domain/itemMaster.js';

// isInPeriod(ms): 不具合分析の期間に入るか。
export default function ReworkAnalysisPanel({ lots = [], templates = [], settings = {}, isInPeriod }) {
  const [reworkRoundMode, setReworkRoundMode] = useState('all'); // 'all'=まとめて / 'each'=回ごと
  // 押して開いている原因の key(byCause の key)。⚠原因の「文字」で持たない。
  //   自由入力で「原因不明」と打たれた行と、本物の原因不明の行が同じ文字になり得るため。
  const [reworkOpenCause, setReworkOpenCause] = useState(null);  // 開いている原因の key(型式×テンプレの内訳を出す)
  // 全ロットを開くのは重いので、ロットとテンプレが変わった時だけ(期間での数え直しは下で・やり直しの行だけなので軽い)
  const allUnfiltered = useMemo(() => reworkRows({ lots, templates }), [lots, templates]);
  const reworkStats = useMemo(() => {
    // ⚠⚠ 絞り込みは「日付なし」を数える **前** に当てる。
    //   後に当てると、「やり直し 2件」の真下に「日付が入っていないやり直しが全体で 41件」と出て、
    //   同じ画面に母集団の違う2つの数字が並ぶ(どちらの話か誰にも分からない)。
    //   ⚠内容(dimLabel/dimText)は当てない。r.cause は「やり直し理由」で不具合内容とは別の言葉。
    const all = allUnfiltered;
    // ⚠日付が入っていない記録は、この期間の物かどうかが分からない。
    //   期間に入れる理由が無いので落とし、件数だけ画面に出して隠さない(勝手に今月扱いにしない)。
    const dated = all.filter(r => r.endedAt > 0);
    const noDateCount = all.length - dated.length;
    const noDateSeconds = all.reduce((s, r) => s + (r.endedAt > 0 ? 0 : r.seconds), 0);
    const noDateCountAll = allUnfiltered.length - allUnfiltered.filter(r => r.endedAt > 0).length; // 絞り込みなしの全体(併記用)
    const rows = dated.filter(r => isInPeriod(r.endedAt));

    // 種別は不良項目マスタ(⚙設定)側に人が付けた札を引くだけ。ここで中身から推測しない。
    const kindTable = settings?.complaintKinds || {};
    const kindOf = (cause) => kindTable[cause] || '';

    const causes = byCause(rows, { kindOf });
    const detail = byCauseModelTemplate(rows);
    const rounds = byRound(rows);
    const summary = reworkSummary(rows);

    // 種別ごとの合計。⚠「原因不明」は種別ではなく別枠なので、未分類には絶対に混ぜない。
    const kindAgg = new Map();
    causes.forEach(c => {
      const key = c.unknown ? UNKNOWN_CAUSE : (c.kind || UNKNOWN_KIND);
      if (!kindAgg.has(key)) kindAgg.set(key, { kind: key, count: 0, seconds: 0, causeCount: 0 });
      const hit = kindAgg.get(key);
      hit.count += c.count;
      hit.seconds += c.seconds;
      hit.causeCount += 1;
    });
    const kindOrder = reworkKindOrder(settings);
    const kinds = kindOrder
      .map(k => kindAgg.get(k))
      .filter(Boolean)
      // マスタに無い種別(昔の設定の残り)も落とさずに後ろへ付ける
      .concat([...kindAgg.values()].filter(x => !kindOrder.includes(x.kind)));

    // 何回もやり直しているマス。1マス = 1ロットの1作業(taskKey)。
    // ⚠区切り文字を自分で決めると型式名に入っていた時に別のマスが1つに潰れる → JSONで束ねる。
    const cellMap = new Map();
    rows.forEach(r => {
      const key = JSON.stringify([r.lotId, r.taskKey]);
      if (!cellMap.has(key)) {
        cellMap.set(key, {
          key, lotId: r.lotId, orderNo: r.orderNo, model: r.model, templateName: r.templateName,
          stepTitle: r.stepTitle, taskKey: r.taskKey, count: 0, seconds: 0, maxRound: 0, causes: [],
        });
      }
      const hit = cellMap.get(key);
      hit.count += 1;
      hit.seconds += r.seconds;
      hit.maxRound = Math.max(hit.maxRound, Number(r.round) || 0);
      const c = r.cause || UNKNOWN_CAUSE;
      if (!hit.causes.includes(c)) hit.causes.push(c);
    });
    const repeats = [...cellMap.values()]
      .filter(x => x.count >= 3) // 3回以上やり直しているマスだけ(9回の異常が埋もれないように)
      .sort((a, b) => (b.count - a.count) || (b.seconds - a.seconds));

    return { rows, causes, detail, rounds, summary, kinds, repeats, noDateCount, noDateSeconds, noDateCountAll, totalAll: all.length };
  // ⚠見張る設定は「種別の表」と「種別の語彙」だけ(設定全体を見張ると全ロットの数え直しで重くなる)。
  }, [allUnfiltered, settings, isInPeriod]);

  // 絞り込み(P043)はまだ無いので、日付なしの件数は全体と同じ
  const isDimActive = false;
  // 🔁 時給は⚙設定の人件費単価。無ければ既定¥2,800。⚠丸めた値を足し算に使わない。
  const rw = reworkStats;
  const rwRate = Number(settings?.laborCostPerHour) || 2800;
  const rwH = (sec) => (sec / 3600).toFixed(2);
  const rwYenNum = (sec) => Math.round(sec / 3600 * rwRate);
  const yenTxt = (n) => `¥${Math.round(n).toLocaleString()}`;
  const maxCauseSec = Math.max(1, ...rw.causes.map(x => x.seconds));
  const rwFrom = rw.summary.byCauseFrom;
  // 品目コード → 「品目コード｜品名」
  const modelLabel = (code) => { const n = resolveItemName(code, '', settings?.itemMaster); return n ? `${code}｜${n}` : (code || ''); };
  return (
               <div className="bg-white rounded-xl shadow-sm border p-3 space-y-3">
                 <div className="flex flex-wrap items-center justify-between gap-2">
                   <h3 className="font-bold text-slate-700 flex items-center gap-2"><RotateCcw className="w-4 h-4 text-orange-600"/> やり直し(再作業)の中身 — 何を直すと効くか</h3>
                   <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                     <span className="fi-tap-text text-slate-500 px-1">回数の見方</span>
                     <button onClick={() => setReworkRoundMode('all')} className={`px-2 py-1 text-xs font-bold rounded ${reworkRoundMode === 'all' ? 'bg-white shadow text-orange-600' : 'text-slate-500'}`}>まとめて</button>
                     <button onClick={() => setReworkRoundMode('each')} className={`px-2 py-1 text-xs font-bold rounded ${reworkRoundMode === 'each' ? 'bg-white shadow text-orange-600' : 'text-slate-500'}`}>回ごと</button>
                   </div>
                 </div>

                 {/* まず全体の数。件数=やり直しが起きた回数(1回のやり直し=1件) */}
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                   {/* ⚠件数は元データ(reworks の記録)の数そのもの。0秒の記録もここに入れる。
                       やり直しが起きた事実は記録に残っているので、こちらの判断で黙って捨てない
                       (捨てると元データと画面の数が食い違い、誰も説明できなくなる)。
                       0秒の分は時間・金額には1秒も効いていないので、その旨を必ず横に書く。 */}
                   <div className="bg-orange-50 border-2 border-orange-200 p-3 rounded-xl">
                     <div className="fi-tap-text font-bold text-orange-700 mb-1">やり直した回数</div>
                     <div className="text-2xl font-black text-orange-700">
                       {rw.summary.count}<span className="text-xs font-normal ml-1">件</span>
                       {rw.summary.zeroSecondsCount > 0 && (
                         <span className="text-xs font-bold text-orange-700/80 ml-1">（うち0秒 {rw.summary.zeroSecondsCount}件）</span>
                       )}
                     </div>
                     {rw.summary.zeroSecondsCount > 0 && (
                       <div className="fi-tap-text text-orange-700/80 mt-0.5">0秒＝押してすぐ閉じた記録。件数には入れますが、時間と金額には入っていません。</div>
                     )}
                   </div>
                   <div className="bg-orange-50 border-2 border-orange-200 p-3 rounded-xl">
                     <div className="fi-tap-text font-bold text-orange-700 mb-1">かかった時間</div>
                     <div className="text-2xl font-black text-orange-700">{rwH(rw.summary.seconds)}<span className="text-xs font-normal ml-1">時間</span></div>
                   </div>
                   <div className="bg-teal-50 border-2 border-teal-200 p-3 rounded-xl">
                     <div className="fi-tap-text font-bold text-teal-700 mb-1">金額にすると</div>
                     <div className="text-2xl font-black text-teal-700">{yenTxt(rwYenNum(rw.summary.seconds))}</div>
                     <div className="fi-tap-text text-teal-700/80 mt-0.5">{rwH(rw.summary.seconds)}h × {yenTxt(rwRate)}/時</div>
                   </div>
                   {/* ⚠一番大きい数字(合計)には「NG理由からの代用＝たぶんこれ」が混ざっている。
                       合計だけが独り歩きしないよう、確定分(回ごとの理由)を必ず横に併記する。 */}
                   <div className="bg-white border-2 border-slate-200 p-3 rounded-xl">
                     <div className="fi-tap-text font-bold text-slate-500 mb-1">うち原因が引けた分</div>
                     <div className="text-2xl font-black text-slate-700">
                       {rw.summary.knownCount}<span className="text-xs font-normal ml-1">件</span>
                       <span className="text-xs font-bold text-emerald-700 ml-1">（うち確定 {rwFrom['回ごと'].count}件）</span>
                     </div>
                     <div className="fi-tap-text text-slate-500 mt-0.5">確定＝その修正回に付いていた理由 / 代用 {rwFrom['NG理由の代用'].count}件 は「たぶんこれ」</div>
                     <div className="fi-tap-text text-slate-500 mt-0.5">原因不明 {rw.summary.unknownCount}件 / {rwH(rw.summary.unknownSeconds)}h は別枠</div>
                   </div>
                   {/* 🎓教育中(新人)の再作業。上の合計・金額には入っていない。
                       ⚠件数と時間を黙って捨てないため、0件でない時は必ずこの1行を出す。 */}
                   {rw.summary.traineeCount > 0 && (
                     <div className="bg-amber-50 border-2 border-amber-200 p-3 rounded-xl">
                       <div className="fi-tap-text font-bold text-amber-700 mb-1">🎓 教育中の再作業（別掲）</div>
                       <div className="text-2xl font-black text-amber-700">
                         {rw.summary.traineeCount}<span className="text-xs font-normal ml-1">件</span>
                         <span className="text-sm font-bold ml-2">{rwH(rw.summary.traineeSeconds)}<span className="text-xs font-normal ml-0.5">時間</span></span>
                       </div>
                       <div className="fi-tap-text text-amber-700/80 mt-0.5">練習中のやり直しなので、上の合計・原因別・金額には入れていません（覚えれば減る分を対策の的にしないため）。</div>
                     </div>
                   )}
                 </div>

                 {/* ⚠金額を出す画面の決まり: 出どころと実数の式を必ず画面に書く */}
                 <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 fi-tap-text text-amber-900 leading-relaxed">
                   <div className="font-bold mb-1">金額の出どころと式</div>
                   <div>金額 ＝ やり直しにかかった時間 × 時給 <b>{yenTxt(rwRate)}/時</b>（{settings?.laborCostPerHour ? '⚙設定の人件費単価' : '⚙設定に人件費単価が入っていないので既定の¥2,800で計算'}）。</div>
                   <div>この期間の実数: <b>{rwH(rw.summary.seconds)}h</b> × {yenTxt(rwRate)} ＝ <b>{yenTxt(rwYenNum(rw.summary.seconds))}</b>（{rw.summary.seconds.toLocaleString()}秒 ÷ 3600 × {rwRate}）。</div>
                   <div className="text-amber-800/80 mt-1">時間の元は1回ごとの実測秒(reworks の duration)だけです。開始時刻と終了時刻の引き算は使っていません（実測でズレる記録があったため）。</div>
                 </div>

                 {/* ⚠数字の出どころ。「原因が本当に分かっている分」と「NG理由で代用した分」を混ぜて見せない */}
                 <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 fi-tap-text text-slate-700 leading-relaxed">
                   {/* ⚠畳むのは理由の本文だけ。見出しと内訳のチップ3つは summary に出したまま(閉じても
                       「代用が混ざる」事実が消えない)。日付なしの件数は details の外に置く。 */}
                   <details>
                     <summary className="min-h-11 flex items-center flex-wrap gap-x-4 gap-y-1 cursor-pointer list-none">
                       <span className="font-bold">数字の出どころ（原因をどこから持ってきたか・代用が混ざります）</span>
                       <span>回ごとの理由 <b>{rwFrom['回ごと'].count}</b>件 / {rwH(rwFrom['回ごと'].seconds)}h</span>
                       <span>NG理由からの代用 <b>{rwFrom['NG理由の代用'].count}</b>件 / {rwH(rwFrom['NG理由の代用'].seconds)}h</span>
                       <span>原因不明 <b>{rwFrom['原因不明'].count}</b>件 / {rwH(rwFrom['原因不明'].seconds)}h</span>
                       <span className="shrink-0 text-slate-400 font-bold">▾ 理由</span>
                     </summary>
                     <div className="text-slate-500 mt-1">
                       ⚠昔の記録は1回目のやり直しに理由が焼き付いていないため「NG理由からの代用」になります。
                       NG理由は作業に1つしか持てず、次のNGで上書きされるので、代用分は<b>「たぶんこれ」であって確定ではありません</b>。
                     </div>
                   </details>
                   {rw.noDateCount > 0 && (
                     <div className="text-slate-500 mt-1">
                       ⚠{isDimActive ? 'この絞り込みの範囲で、' : ''}日付が入っていないやり直しが {rw.noDateCount}件 / {rwH(rw.noDateSeconds)}h あります。{isDimActive && rw.noDateCountAll !== rw.noDateCount ? `（絞り込みなしでは ${rw.noDateCountAll}件）` : ''}
                       どの期間の物か分からないので、この集計には入れていません（勝手に今の期間の物にはしません）。
                     </div>
                   )}
                 </div>

                 {rw.rows.length === 0 ? (
                   <div className="text-center text-slate-400 text-sm py-8">この期間にやり直し(再作業)の記録はありません</div>
                 ) : (
                   <>
                     {/* 種別ごと。⚠合計に混ぜない(「直しが要った」と「測り直しだけ」は別の話) */}
                     <div>
                       {/* 🧾 2026-09-08: 5列の格子に札が1枚だけの時、幅の19%しか使わない帯になっていた(実測 80px)。
                           見出しと下の注意書きを同じ行へ入れ、3つで1本の帯を端まで使う。文言・札の中身は1文字も変えていない。 */}
                       <div className="flex flex-wrap items-stretch gap-2">
                         <div className="text-xs font-bold text-slate-600 shrink-0 self-center">種別ごと（1つの合計に混ぜていません）</div>
                         {rw.kinds.map(k => (
                           <div key={k.kind} className={`border rounded-lg p-2 min-w-[9rem] ${REWORK_KIND_COLOR[k.kind] || 'bg-white text-slate-700 border-slate-200'}`}>
                             <div className="fi-tap-text font-bold">{k.kind}{k.kind === UNKNOWN_CAUSE ? '（別枠）' : ''}</div>
                             <div className="text-lg font-black leading-tight">{rwH(k.seconds)}<span className="fi-tap-text font-normal ml-0.5">時間</span></div>
                             <div className="fi-tap-text opacity-80">{k.count}件 ・ {yenTxt(rwYenNum(k.seconds))}</div>
                           </div>
                         ))}
                         <div data-textfill="1" className="fi-tap-text text-slate-500 flex-1 min-w-[14rem] self-center">
                           種別は ⚙設定 →「軽微不良・改善提案の選択肢マスタ」で項目ごとに決めます（既定は「{UNKNOWN_KIND}」）。
                           「{UNKNOWN_CAUSE}」は種別ではなく、原因そのものが引けなかった分の別枠です。
                         </div>
                       </div>
                     </div>

                     {reworkRoundMode === 'each' && (
                       <div>
                         <div className="text-xs font-bold text-slate-600 mb-2">回ごと（1回目で終わらなかった分がどれだけあるか）</div>
                         <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                           {rw.rounds.map(r => (
                             <div key={r.label} className="border border-slate-200 rounded-lg p-2 bg-white">
                               <div className="fi-tap-text font-bold text-slate-600">{r.label}</div>
                               <div className="text-lg font-black text-slate-700 leading-tight">{rwH(r.seconds)}<span className="fi-tap-text font-normal ml-0.5">時間</span></div>
                               <div className="fi-tap-text text-slate-500">{r.count}件 ・ {yenTxt(rwYenNum(r.seconds))}</div>
                             </div>
                           ))}
                         </div>
                       </div>
                     )}

                     {/* 原因別。押すと 原因 × 型式 × テンプレ の内訳が開く */}
                     <div>
                       <div className="text-xs font-bold text-slate-600 mb-2">原因別（時間の大きい順・行を押すと品目コードとテンプレの内訳が開きます）</div>
                       <div className="overflow-x-auto border rounded-lg">
                         <table className="w-full text-left border-collapse text-xs min-w-[44rem]">
                           <thead className="bg-slate-50 text-slate-500">
                             <tr className="border-b">
                               <th className="p-2 font-bold">原因</th>
                               <th className="p-2 font-bold">種別</th>
                               <th className="p-2 font-bold">時間</th>
                               <th className="p-2 font-bold text-right">件数</th>
                               <th className="p-2 font-bold text-right">金額</th>
                               {reworkRoundMode === 'each' && ROUND_LABELS.map(l => (
                                 <th key={l} className="p-2 font-bold text-right whitespace-nowrap">{l}</th>
                               ))}
                             </tr>
                           </thead>
                           <tbody>
                             {rw.causes.map(c => {
                               // ⚠開いている行の判定も内訳の突き合わせも「原因の文字」ではなく key で行う。
                               //   理由は現場の自由入力なので、誰かが理由に「原因不明」と打つと
                               //   本物の原因不明と同じ文字の行が2本並ぶ。文字で突き合わせると
                               //   別の行の内訳が混ざって出てしまう(金額まで嘘になる)。
                               //   key は byCause の key ＝ byCauseModelTemplate の causeKey と同じ文字列。
                               const open = reworkOpenCause === c.key;
                               const inner = open ? rw.detail.filter(d => d.causeKey === c.key) : [];
                               const cols = reworkRoundMode === 'each' ? 5 + ROUND_LABELS.length : 5;
                               return (
                                 <React.Fragment key={c.key}>
                                   <tr onClick={() => setReworkOpenCause(open ? null : c.key)} className={`border-b cursor-pointer hover:bg-orange-50 ${c.unknown ? 'bg-slate-50' : ''}`}>
                                     <td className="p-2 font-bold text-slate-700">
                                       <span className="inline-flex items-center gap-1">
                                         <ChevronRight className={`w-3 h-3 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}/>
                                         {c.cause}
                                       </span>
                                       {c.unknown && <span className="ml-1 fi-tap-text font-normal text-slate-500">（原因が引けなかった分・別枠）</span>}
                                     </td>
                                     <td className="p-2">
                                       <div className="flex flex-wrap items-center gap-1.5">
                                         <span className={`px-1.5 py-0.5 rounded border fi-tap-text font-bold ${REWORK_KIND_COLOR[c.unknown ? UNKNOWN_CAUSE : c.kind] || 'bg-white text-slate-600 border-slate-200'}`}>{c.unknown ? UNKNOWN_CAUSE : c.kind}</span>
                                       </div>
                                     </td>
                                     <td className="p-2">
                                       <div className="flex items-center gap-2">
                                         <div className="w-24 bg-slate-100 rounded-full h-3 overflow-hidden shrink-0">
                                           <div className={`h-full rounded-full ${c.unknown ? 'bg-slate-400' : 'bg-gradient-to-r from-orange-400 to-orange-600'}`} style={{ width: `${(c.seconds / maxCauseSec) * 100}%` }}/>
                                         </div>
                                         <span className="font-mono font-bold text-slate-700 whitespace-nowrap">{rwH(c.seconds)}h</span>
                                       </div>
                                     </td>
                                     <td className="p-2 text-right font-mono text-slate-600">{c.count}</td>
                                     <td className="p-2 text-right font-mono font-bold text-teal-700 whitespace-nowrap">{yenTxt(rwYenNum(c.seconds))}</td>
                                     {reworkRoundMode === 'each' && c.rounds.map(r => (
                                       <td key={r.label} className="p-2 text-right font-mono text-slate-600 whitespace-nowrap">{r.count > 0 ? `${r.count}件 / ${rwH(r.seconds)}h` : '-'}</td>
                                     ))}
                                   </tr>
                                   {open && (
                                     <tr className="border-b bg-orange-50/40">
                                       <td colSpan={cols} className="p-3">
                                         <div className="fi-tap-text font-bold text-slate-600 mb-1">
                                           「{c.cause}」{c.unknown ? '（原因が引けなかった分）' : ''}の内訳 — 品目コード × テンプレ
                                           <span className="font-normal text-slate-500 ml-1">（工程名だけでは束ねません。同じ工程名でも品目コード・テンプレが違えば別物だからです）</span>
                                         </div>
                                         <div className="overflow-x-auto">
                                           <table className="w-full text-left border-collapse fi-tap-text bg-white rounded">
                                             <thead className="bg-slate-100 text-slate-500">
                                               <tr>
                                                 <th className="p-1.5 font-bold">品目コード</th>
                                                 <th className="p-1.5 font-bold">テンプレ</th>
                                                 <th className="p-1.5 font-bold text-right">件数</th>
                                                 <th className="p-1.5 font-bold text-right">時間</th>
                                                 <th className="p-1.5 font-bold text-right">金額</th>
                                               </tr>
                                             </thead>
                                             <tbody>
                                               {inner.map((d, di) => (
                                                 <tr key={di} className="border-b last:border-b-0">
                                                   <td className="p-1.5 font-bold text-slate-700">{d.model ? modelLabel(d.model) : '(品目コードなし)'}</td>
                                                   <td className="p-1.5 text-slate-600">{d.templateName || '(テンプレ不明)'}</td>
                                                   <td className="p-1.5 text-right font-mono">{d.count}</td>
                                                   <td className="p-1.5 text-right font-mono font-bold">{rwH(d.seconds)}h</td>
                                                   <td className="p-1.5 text-right font-mono text-teal-700">{yenTxt(rwYenNum(d.seconds))}</td>
                                                 </tr>
                                               ))}
                                               {inner.length === 0 && <tr><td colSpan="5" className="p-3 text-center text-slate-400">内訳がありません</td></tr>}
                                             </tbody>
                                           </table>
                                         </div>
                                       </td>
                                     </tr>
                                   )}
                                 </React.Fragment>
                               );
                             })}
                           </tbody>
                         </table>
                       </div>
                     </div>

                     {/* 何回もやり直しているマス。1マス = 1ロットの1作業 */}
                     <div>
                       <div className="text-xs font-bold text-slate-600 mb-2">
                         3回以上やり直したマス（{rw.repeats.length}件）
                         <span className="font-normal text-slate-500 ml-1">※1マス = そのロットのその作業。回数が飛び抜けている物がここに出ます</span>
                       </div>
                       <div className="overflow-x-auto border rounded-lg max-h-72 overflow-y-auto">
                         <table className="w-full text-left border-collapse fi-tap-text min-w-[46rem]">
                           <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10">
                             <tr className="border-b">
                               <th className="p-2 font-bold text-right">回数</th>
                               <th className="p-2 font-bold">品目コード</th>
                               <th className="p-2 font-bold">指図番号</th>
                               <th className="p-2 font-bold">テンプレ</th>
                               <th className="p-2 font-bold">工程</th>
                               <th className="p-2 font-bold">出ている原因</th>
                               <th className="p-2 font-bold text-right">時間</th>
                               <th className="p-2 font-bold text-right">金額</th>
                             </tr>
                           </thead>
                           <tbody>
                             {rw.repeats.map(x => (
                               <tr key={x.key} className={`border-b ${x.count >= 5 ? 'bg-rose-50' : ''}`}>
                                 <td className="p-2 text-right font-black text-rose-700 whitespace-nowrap">{x.count}回</td>
                                 <td className="p-2 font-bold text-slate-700">{x.model ? modelLabel(x.model) : '(品目コードなし)'}</td>
                                 <td className="p-2 text-slate-500">{x.orderNo || '-'}</td>
                                 <td className="p-2 text-slate-600">{x.templateName || '(テンプレ不明)'}</td>
                                 <td className="p-2 text-slate-600">{x.stepTitle}</td>
                                 <td className="p-2 text-slate-600">{x.causes.join(' / ')}</td>
                                 <td className="p-2 text-right font-mono font-bold whitespace-nowrap">{rwH(x.seconds)}h</td>
                                 <td className="p-2 text-right font-mono text-teal-700 whitespace-nowrap">{yenTxt(rwYenNum(x.seconds))}</td>
                               </tr>
                             ))}
                             {rw.repeats.length === 0 && <tr><td colSpan="8" className="p-6 text-center text-slate-400">3回以上やり直したマスはありません</td></tr>}
                           </tbody>
                         </table>
                       </div>
                     </div>
                   </>
                 )}
               </div>
  );
}
