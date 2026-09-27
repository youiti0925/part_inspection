// 👤 P118 個人ごとの設定(時短の窓・直工比率・曜日ごとの窓・有給/出張/会議・残業・優先するテンプレ)。
//   製品 src/App.jsx 36648-37071 の WorkerProfilesEditor をそのまま写した(中身は製品と同じ)。
//   読む側: 部品の操業シミュレーション(domain/operationsSimulation/calendar.js・workerAvailability.js・policy.js)と
//   planningReview/placement.js。部品の在席表(settings.workerRoster)とは別の置き場(settings.workerProfiles)で、今の在席表は消さない。
import React from 'react';
import Viz from './opsim/vizKit.jsx';
import { activeWorkersOf } from './domain/workerPause.js';
import { buildWorkerColors, toneOf as vizToneOf } from './opsim/workerColors.js';

const vizWorkerTone = (workers, name) =>
  vizToneOf(buildWorkerColors((workers || []).map((w) => (w && w.name) || '')), name);

 // 👤 個人ごとの設定(2026-09-05 清水さん「個人レベルの設定ってどこかでできるんだっけ？ 村さんは9:30〜16:00までの
 //   時短勤務で、片山さんは職長だから管理業務もあるから普通の作業者より作業時間ができなかったりする
 //   (個人直工比率が高い)。この辺を設定したい」)。
 //
 // 👤 2026-09-09 清水さん「個人レベルの細かい設定できるようにって機能追加したはずだけど、**どこかわからない**、
 //   その設定にどんな機能あったかわからない」「他にも細かい設定できる状態にしておいてほしい」。
 //   → ① 見出しを **中身のとおりの言葉** にして、登録が0人でも埋もれない色にした(0人の時は開いた形で出す)。
 //     ② 足りなかった3つを足した: 曜日ごとの窓 / 有給・出張・会議の日 / 残業。
 //   🚨 3つとも **空なら今までと1ミリも変わらない**。登録した人の分だけ効く。
 //
 //   置き場: settings.workerProfiles = { [名前]: {
 //       dayStart:'HH:MM', dayEnd:'HH:MM', directRatio:0<r<=1, templatePrefs:[テンプレid...],
 //       byWeekday:{ 0(日)..6(土): { dayStart:'HH:MM', dayEnd:'HH:MM', off:true } },
 //       days:[{ ymd:'YYYY-MM-DD', kind:'off'|'half'|'half-am'|'half-pm'|'trip'|'meeting', note, hours }],
 //       overtime:{ allowed:boolean, maxMinPerDay:0〜720 } } }
 //   読む側: 操業シミュレーション。dayStart/dayEnd/directRatio は calendar.js の normalizeWorkerProfiles、
 //     新しい3つは domain/operationsSimulation/workerAvailability.js が読む(言葉と形はあちらに合わせる)。
 //
 //   🚨 workerProfiles は **入れ子の表**。saveSettings は merge:true なので、表を丸ごと送ると
 //     送らなかった人の分が消える(2026-08-17 に作業時間が丸ごと消えた事故と同じ形)。
 //     必ず今の表を広げてから1人分を上書きする。消す時は __deleteMapKeys で印を置く(送らないだけでは消えない)。
 //   🚨 入れ子の **中** (byWeekday の曜日・overtime の鍵)を消す時も印が要る。深い道は配列で書く:
 //     [['workerProfiles', 名前, 'byWeekday', '3']]。ドット区切りにすると名前の「.」で壊れる。
 //   🚨 鍵は名前(操業シミュレーションが休みの表 workerRoster と同じく名前で引くため)。
 const WORKER_WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
 // ⚠ 言葉も鍵も domain/operationsSimulation/workerAvailability.js の DAY_KINDS / DAY_KIND_LABELS と
 //   1文字も違えない。違うと「そのどれでもないので使っていません」と捨てられ、
 //   「設定したのに効かない画面」になる(誰も気づけない)。
 const WORKER_DAY_KIND_OPTIONS = [
   ['off', '休み'],
   ['half', '半休'],
   ['half-am', '午前休'],
   ['half-pm', '午後休'],
   ['trip', '出張'],
   ['meeting', '会議'],
 ];
 // 出張・会議は「その日のうち何時間 取られるか」が要る。入っていないと丸ごと外して数えられる。
 const WORKER_DAY_KIND_NEEDS_HOURS = new Set(['trip', 'meeting']);
 // 押す物の高さ。文字を大きくした人は max() で一緒に大きくなる。
 const WORKER_TAP = { minHeight: 'max(2.75rem, 44px)' };
 const WORKER_INPUT_CLS = 'border border-slate-300 rounded px-2 bg-white text-xs';
 /** Date → 'YYYY-MM-DD'。⚠ 画面の入力の初期値を作るだけ。計算(domain)では時計を読まない。 */
 const wpYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

 const WorkerProfilesEditor = ({ workers, settings, saveSettings, templates = [] }) => {
   const table = (settings && settings.workerProfiles && typeof settings.workerProfiles === 'object') ? settings.workerProfiles : {};
   const rows = activeWorkersOf(workers || []);
   // 1人分の上書き。今の表を広げてから、その人の分だけ差し替える。
   //   deeper = その人の書類の **もっと深い所** で消えた道(['byWeekday','3'] のような相対の道)。
   const put = (name, patch, deeper = []) => {
     if (!saveSettings || !name) return;
     const prev = (table[name] && typeof table[name] === 'object') ? table[name] : {};
     const next = { ...prev };
     const dead = [];
     Object.entries(patch).forEach(([k, v]) => {
       if (v == null || v === '') { delete next[k]; if (k in prev) dead.push(['workerProfiles', name, k]); }
       else next[k] = v;
     });
     // 🚨 親を丸ごと消す印と、その中の子を消す印を **同時に出さない**。
     //   印は入れ子の物なので、後から子の道を掘ると親に置いた印を上書きしてしまう。
     const killed = new Set(dead.map((p) => JSON.stringify(p.slice(2).map(String))));
     deeper.forEach((rel) => {
       if (!Array.isArray(rel) || rel.length === 0) return;
       for (let i = 1; i <= rel.length; i += 1) { if (killed.has(JSON.stringify(rel.slice(0, i).map(String)))) return; }
       dead.push(['workerProfiles', name, ...rel.map(String)]);
     });
     if (Object.keys(next).length === 0) {
       // 全部空 → その人の行ごと消す(印を置く。送らないだけでは merge:true で残る)。
       const rest = { ...table }; delete rest[name];
       saveSettings({ workerProfiles: rest, __deleteMapKeys: [['workerProfiles', name]] });
       return;
     }
     saveSettings({ workerProfiles: { ...table, [name]: next }, ...(dead.length ? { __deleteMapKeys: dead } : {}) });
   };
   const profOf = (name) => ((table[name] && typeof table[name] === 'object') ? table[name] : {});
   const ratioText = (p) => (p && Number.isFinite(Number(p.directRatio)) ? String(Math.round(Number(p.directRatio) * 100)) : '');
   const commitRatio = (name, text, revert) => {
     const t = String(text || '').trim();
     if (t === '') { put(name, { directRatio: null }); return; }
     const n = Number(t);
     if (!Number.isFinite(n) || n < 1 || n > 100) {
       window.alert('直工比率は 1〜100 の数(%)で入れてください。100 = 勤務時間を全部検査に使える。');
       revert();
       return;
     }
     put(name, { directRatio: Math.round(n) / 100 });
   };

   // ── ① 曜日ごとの窓 ───────────────────────────────────────────────────────
   const weekdayTable = (p) => ((p.byWeekday && typeof p.byWeekday === 'object' && !Array.isArray(p.byWeekday)) ? p.byWeekday : {});
   const weekdayOne = (p, wd) => {
     const v = weekdayTable(p)[String(wd)];
     return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
   };
   const putWeekday = (name, wd, patch) => {
     const p = profOf(name);
     const cur = weekdayTable(p);
     const key = String(wd);
     const prevOne = weekdayOne(p, wd);
     const merged = { ...prevOne, ...patch };
     const clean = {};
     if (typeof merged.dayStart === 'string' && merged.dayStart) clean.dayStart = merged.dayStart;
     if (typeof merged.dayEnd === 'string' && merged.dayEnd) clean.dayEnd = merged.dayEnd;
     if (merged.off === true) clean.off = true;
     const next = { ...cur };
     const deeper = [];
     if (Object.keys(clean).length === 0) {
       delete next[key];
       if (key in cur) deeper.push(['byWeekday', key]);
     } else {
       next[key] = clean;
       Object.keys(prevOne).forEach((k) => { if (!(k in clean)) deeper.push(['byWeekday', key, k]); });
     }
     if (Object.keys(next).length === 0) { put(name, { byWeekday: null }); return; }
     put(name, { byWeekday: next }, deeper);
   };

   // ── ② 有給・出張・会議の日 ───────────────────────────────────────────────
   // ⚠ **並び(配列)** で持つ。表にすると merge:true で1件消しても消えない(2026-07-26 の是正と同じ形)。
   const daysOf = (p) => (Array.isArray(p.days) ? p.days : []);
   const putDays = (name, list) => put(name, { days: (Array.isArray(list) && list.length) ? list : null });
   const addDay = (name) => {
     const list = daysOf(profOf(name));
     const used = new Set(list.map((e) => ((e && typeof e === 'object') ? String(e.ymd || '') : '')));
     // 同じ日が2件あると後の1件が捨てられるので、空いている日まで進めてから足す。
     const d = new Date(); d.setHours(12, 0, 0, 0);
     let ymd = wpYmd(d);
     for (let i = 0; i < 400 && used.has(ymd); i += 1) { d.setDate(d.getDate() + 1); ymd = wpYmd(d); }
     putDays(name, [...list, { ymd, kind: 'off', note: '' }]);
   };
   const patchDay = (name, idx, patch) => {
     const list = daysOf(profOf(name));
     if (!list[idx]) return;
     putDays(name, list.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
   };
   const removeDay = (name, idx) => putDays(name, daysOf(profOf(name)).filter((unused, i) => i !== idx));
   // 出張・会議の時間数。⚠ 読めない値は黙って丸めない。人に言い直してもらう(workerAvailability.js と同じ作法)。
   const commitDayHours = (name, idx, text, revert) => {
     const t = String(text || '').trim();
     if (t === '') { patchDay(name, idx, { hours: null }); return; }
     const n = Number(t);
     if (!Number.isFinite(n) || !(n > 0) || !(n <= 24)) {
       window.alert('時間数は 0 より大きく 24 以下の数で入れてください。空欄にすると、その日は丸ごと外して数えます。');
       revert();
       return;
     }
     patchDay(name, idx, { hours: n });
   };

   // ── ③ 残業 ───────────────────────────────────────────────────────────────
   const overtimeOf = (p) => ((p.overtime && typeof p.overtime === 'object' && !Array.isArray(p.overtime)) ? p.overtime : {});
   const putOvertime = (name, patch) => {
     const cur = overtimeOf(profOf(name));
     const merged = { ...cur, ...patch };
     const clean = {};
     if (typeof merged.allowed === 'boolean') clean.allowed = merged.allowed;
     if (Number.isInteger(merged.maxMinPerDay) && merged.maxMinPerDay >= 0 && merged.maxMinPerDay <= 720) clean.maxMinPerDay = merged.maxMinPerDay;
     const deeper = [];
     Object.keys(cur).forEach((k) => { if (!(k in clean)) deeper.push(['overtime', k]); });
     if (Object.keys(clean).length === 0) { put(name, { overtime: null }); return; }
     put(name, { overtime: clean }, deeper);
   };
   const otMaxText = (p) => { const n = overtimeOf(p).maxMinPerDay; return Number.isInteger(n) ? String(n) : ''; };
   const commitOvertimeMax = (name, text, revert) => {
     const t = String(text || '').trim();
     if (t === '') { putOvertime(name, { maxMinPerDay: null }); return; }
     const n = Number(t);
     if (!Number.isInteger(n) || n < 0 || n > 720) {
       window.alert('1日の残業の上限は 0〜720 の整数(分)で入れてください。空欄 = 工場の決まりのまま。');
       revert();
       return;
     }
     putOvertime(name, { maxMinPerDay: n });
   };

   // 畳んである時に「何が入っているか」を1目で言う札。数字は設定の写しをそのまま並べるだけ。
   const fineBits = (p) => {
     const bits = [];
     const wn = Object.keys(weekdayTable(p)).length;
     if (wn) bits.push(`曜日${wn}件`);
     const dn = daysOf(p).length;
     if (dn) bits.push(`休み・出張${dn}件`);
     const ot = overtimeOf(p);
     if (ot.allowed === false) bits.push('残業に回さない');
     else if (Number.isInteger(ot.maxMinPerDay)) bits.push(`残業${ot.maxMinPerDay}分まで`);
     else if (ot.allowed === true) bits.push('残業に回してよい');
     return bits;
   };

   const configured = rows.filter((w) => table[w.name] && typeof table[w.name] === 'object' && Object.keys(table[w.name]).length > 0);
   return (
     // 🔎 2026-09-09「どこかわからない」→ 灰色をやめ、登録0人でも見える色にする。
     //   data-worker-profiles-panel は「どこから来ても同じ表」の目印(操業シミュレーションからの口もここへ来る)。
     //   🚨 open は **いつも付ける**。configured の数で付けたり外したりすると、1人目を登録した
     //     その瞬間に React が open を外して画面が畳まれる(打っている途中で閉じる)。
     //     いつも true なら React は属性を書き直さないので、人が畳んだ形はそのまま残る。
     <details
       open
       className="mt-4 border-2 border-indigo-300 bg-indigo-50/70 rounded-xl"
       data-worker-profiles-panel="1"
       data-worker-profiles={configured.length}
     >
       <summary style={WORKER_TAP} className="cursor-pointer select-none px-3 py-2 text-sm font-bold text-indigo-900 flex items-center flex-wrap gap-x-2">
         👤 個人ごとの設定（時短・直工比率・優先テンプレ・休み）
         <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${configured.length > 0 ? 'bg-indigo-600 text-white' : 'bg-amber-400 text-amber-950'}`}>
           {configured.length > 0 ? `${configured.length}人に登録あり` : 'まだ0人 — ここで決められます'}
         </span>
         <span className="font-normal text-xs text-indigo-900/80">
           1人ずつ 勤務の窓・直工比率・優先するテンプレ・曜日ごとの窓・有給/出張/会議・残業 を決められます。操業シミュレーションの「働ける時間」に効きます。
         </span>
       </summary>
       <div className="px-3 pb-3">
         {/* 📐 2026-09-15 実測: この3行の説明は notext の写しで **完全に消える**(＝絵としては白紙)のに、
             本番では表の上を丸ごと1本ぶん(約54px)使っていた。
             🚨 1文字も消さない。畳んで、開けば今までどおり全部出る(移す・畳む・強さを変える)。
             🚨 押す物(summary)は 44px 以上(min-h-11)。字は 12px 以上。 */}
         <details className="mb-2">
           <summary style={WORKER_TAP} className="cursor-pointer select-none fi-tap-text text-slate-500 flex items-center gap-1.5">
             <Viz.Glyph kind="person" className="w-4 h-4" /> 読み方（空欄はどうなるか・直工比率とは）
           </summary>
         <p className="text-xs text-slate-700 mb-2">
           空欄 = 勤務時間マスタどおり（＝今までと1ミリも変わりません）。勤務開始・勤務終了はその人だけの窓（例: 時短 9:30〜16:00）。
           直工比率は勤務時間のうち検査に使える割合（例: 職長で管理業務がある人は 70%）。管理業務のぶんは1日の終わりに固めて置く計算です。
           曜日ごとの窓・有給/出張/会議・残業は右はしの「細かい設定」を開いてください。
         </p>
         </details>
         {rows.length === 0 ? <p className="text-xs text-slate-500">作業者がいません。</p> : (
           <div className="overflow-x-auto">
             <table className="text-xs min-w-full">
               <thead>
                 <tr className="text-slate-500 text-left">
                   <th className="py-1 pr-3 font-bold">名前</th>
                   <th className="py-1 pr-3 font-bold">勤務開始</th>
                   <th className="py-1 pr-3 font-bold">勤務終了</th>
                   <th className="py-1 pr-3 font-bold">直工比率(%)</th>
                   {/* 👤 2026-09-06 清水さん「個人設定でテンプレ毎に この人はこのテンプレを優先的にする設定もほしい」 */}
                   <th className="py-1 pr-3 font-bold">優先するテンプレ</th>
                   {/* 👤 2026-09-09「他にも細かい設定できる状態にしておいてほしい」→ 曜日・休み・残業 */}
                   <th className="py-1 pr-3 font-bold">細かい設定（曜日・休み・残業）</th>
                   <th className="py-1 pr-3 font-bold"></th>
                 </tr>
               </thead>
               <tbody>
                 {rows.map((w) => {
                   const p = (table[w.name] && typeof table[w.name] === 'object') ? table[w.name] : {};
                   const has = Object.keys(p).length > 0;
                   const bits = fineBits(p);
                   return (
                     <tr key={w.id} className={`border-t border-slate-200 align-top ${has ? 'bg-sky-50/60' : ''}`} data-worker-profile-row={w.name}>
                       {/* 🚦 2026-09-10 の再発防止(「設定できるのに計算へ効かない」5件)を **絵** にする。
                           大丈夫(塗った丸) = この人には登録が在る / 分かりません(点線の輪) = 空欄＝勤務時間マスタどおり。
                           🚨 判定は下の行が既に持っている has をそのまま使う(新しい判定を作らない)。
                           🚨 点線の輪は「読めていません」ではなく「まだ決めていない」。必ず札の字で言う。
                           🚨 名前は Avatar が出す(showName 既定 true)ので、字は1文字も消えていない。 */}
                       <td className="py-1 pr-3 whitespace-nowrap">
                         <span className="flex items-center gap-1.5">
                           <Viz.Signal level={has ? 'ok' : 'unknown'} size="w-4 h-4"
                             title={has ? 'この人だけの設定が登録されています' : '空欄＝勤務時間マスタどおり（まだ決めていません）'} />
                           <Viz.Avatar name={w.name} tone={vizWorkerTone(workers, w.name)} size="w-6 h-6" />
                         </span>
                       </td>
                       <td className="py-1 pr-3">
                         <input type="time" value={typeof p.dayStart === 'string' ? p.dayStart : ''} onChange={(e) => put(w.name, { dayStart: e.target.value })}
                           style={WORKER_TAP} className="border border-slate-300 rounded px-2 font-mono bg-white" aria-label={`${w.name} の勤務開始`} />
                       </td>
                       <td className="py-1 pr-3">
                         <input type="time" value={typeof p.dayEnd === 'string' ? p.dayEnd : ''} onChange={(e) => put(w.name, { dayEnd: e.target.value })}
                           style={WORKER_TAP} className="border border-slate-300 rounded px-2 font-mono bg-white" aria-label={`${w.name} の勤務終了`} />
                       </td>
                       <td className="py-1 pr-3">
                         <input type="number" min={1} max={100} step={1} inputMode="numeric" key={`${w.id}:${ratioText(p)}`} defaultValue={ratioText(p)} placeholder="100"
                           onBlur={(e) => { const el = e.target; if (el.value !== ratioText(p)) commitRatio(w.name, el.value, () => { el.value = ratioText(p); }); }}
                           onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                           style={WORKER_TAP} className="border border-slate-300 rounded px-2 w-20 font-mono bg-white" aria-label={`${w.name} の直工比率`} />
                         {/* 🎨 100 という字を **長さ** にする。
                             🚨 空欄(=勤務時間マスタどおり)の時は value に null を渡すので、vizKit が
                               **点線の枠** を出す。つまり「直工比率 0%」と「まだ決めていない」が
                               別の絵になる(2026-08-12「元データに無い値を推測で埋めるな」)。
                             🚨 数字は左の入力欄がそのまま持っている。ここで数え直していない。 */}
                         <Viz.Bar
                           value={ratioText(p) === '' ? null : Number(ratioText(p))} max={100}
                           tone="plain" height="h-1.5" className="mt-0.5 w-20"
                           title={ratioText(p) === '' ? '空欄＝勤務時間マスタどおり（まだ決めていません）' : `直工比率 ${ratioText(p)}%`}
                         />
                       </td>
                       {/* 👤 優先するテンプレ(複数可)。⚠ **順番だけ** に効く。
                           できる/できないは実績から決まる物なので、ここでは1バイトも変えない。
                           保存は **並び(配列)**: templatePrefs = [テンプレid...]。表にすると merge:true で1件消しても消えない。 */}
                       <td className="py-1 pr-3">
                         <select multiple size={1} value={Array.isArray(p.templatePrefs) ? p.templatePrefs : []}
                           onChange={(e) => { const picked = [...e.target.selectedOptions].map((o) => o.value); put(w.name, { templatePrefs: picked.length ? picked : null }); }}
                           style={WORKER_TAP} className="border border-slate-300 rounded px-1 min-w-[9rem] max-w-[14rem] bg-white text-xs" aria-label={`${w.name} が優先するテンプレート`}>
                           {(templates || []).map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                         </select>
                         {Array.isArray(p.templatePrefs) && p.templatePrefs.length > 0 && (
                           <span className="ml-1 fi-tap-text font-bold text-violet-700">{p.templatePrefs.length}件</span>
                         )}
                       </td>
                       {/* 👤 細かい設定。畳んで出す(1人1行が崩れない)。空なら今までと1ミリも変わらない。 */}
                       <td className="py-1 pr-3">
                         <details className="rounded border border-indigo-200 bg-white" data-worker-profile-fine={w.name}>
                           <summary style={WORKER_TAP} className="cursor-pointer select-none px-2 flex items-center gap-2 text-xs font-bold text-indigo-800 whitespace-nowrap">
                             ⚙ 曜日・休み・残業
                             <span className={`px-2 py-0.5 rounded-full fi-tap-text font-bold ${bits.length ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                               {bits.length ? bits.join('・') : '未設定'}
                             </span>
                           </summary>
                           <div className="px-2 pb-2 pt-1 w-[min(80vw,34rem)] max-w-full">
                             {/* ① 曜日ごとの窓 */}
                             <div className="mt-1" data-worker-profile-weekday={w.name}>
                               <div className="text-xs font-bold text-slate-700">① 曜日ごとの窓</div>
                               <p className="fi-tap-text text-slate-500 mb-1">空欄の曜日は上の勤務開始・勤務終了（または勤務時間マスタ）どおり。「休み」を入れた曜日はその人だけ1日まるごと休みになります。</p>
                               {WORKER_WEEKDAY_LABELS.map((lab, wd) => {
                                 const one = weekdayOne(p, wd);
                                 return (
                                   <div key={`${w.id}-wd-${wd}`} className="flex items-center gap-2 flex-wrap py-0.5">
                                     <span className="w-8 font-bold text-slate-700 text-xs">{lab}曜</span>
                                     <label style={WORKER_TAP} className="flex items-center gap-1 px-2 rounded border border-slate-300 bg-white cursor-pointer">
                                       <input type="checkbox" className="w-4 h-4" checked={one.off === true}
                                         onChange={(e) => putWeekday(w.name, wd, { off: e.target.checked ? true : null })}
                                         aria-label={`${w.name} の${lab}曜は休み`} />
                                       <span className="text-xs">休み</span>
                                     </label>
                                     <input type="time" value={typeof one.dayStart === 'string' ? one.dayStart : ''}
                                       onChange={(e) => putWeekday(w.name, wd, { dayStart: e.target.value || null })}
                                       style={WORKER_TAP} className={`${WORKER_INPUT_CLS} font-mono`} aria-label={`${w.name} の${lab}曜の勤務開始`} />
                                     <span className="text-xs text-slate-500">〜</span>
                                     <input type="time" value={typeof one.dayEnd === 'string' ? one.dayEnd : ''}
                                       onChange={(e) => putWeekday(w.name, wd, { dayEnd: e.target.value || null })}
                                       style={WORKER_TAP} className={`${WORKER_INPUT_CLS} font-mono`} aria-label={`${w.name} の${lab}曜の勤務終了`} />
                                   </div>
                                 );
                               })}
                             </div>
                             {/* ② 有給・出張・会議の日 */}
                             <div className="mt-3" data-worker-profile-days={w.name}>
                               <div className="text-xs font-bold text-slate-700">② 有給・出張・会議の日</div>
                               <p className="fi-tap-text text-slate-500 mb-1">1件も無ければ、ふつうに働く日として数えます。出張・会議は「その日のうち何時間 取られるか」を入れてください（空だとその日を丸ごと外して数えます）。</p>
                               {daysOf(p).length === 0 ? <p className="text-xs text-slate-500">まだ1件もありません。</p> : null}
                               {daysOf(p).map((e, i) => {
                                 const kind = String((e && e.kind) || '');
                                 const hoursText = (e && e.hours != null && e.hours !== '' && Number.isFinite(Number(e.hours))) ? String(Number(e.hours)) : '';
                                 const noteText = (e && typeof e.note === 'string') ? e.note : '';
                                 return (
                                   <div key={`${w.id}-day-${i}`} className="flex items-center gap-2 flex-wrap py-0.5" data-worker-profile-day={i}>
                                     <input type="date" value={typeof e.ymd === 'string' ? e.ymd : ''}
                                       onChange={(ev) => patchDay(w.name, i, { ymd: ev.target.value })}
                                       style={WORKER_TAP} className={`${WORKER_INPUT_CLS} font-mono`} aria-label={`${w.name} の${i + 1}件目の日付`} />
                                     <select value={kind} onChange={(ev) => patchDay(w.name, i, { kind: ev.target.value })}
                                       style={WORKER_TAP} className={WORKER_INPUT_CLS} aria-label={`${w.name} の${i + 1}件目の種類`}>
                                       {WORKER_DAY_KIND_OPTIONS.map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
                                     </select>
                                     {WORKER_DAY_KIND_NEEDS_HOURS.has(kind) && (
                                       <label className="flex items-center gap-1 text-xs text-slate-600">
                                         {/* ⚠ 1字ごとに保存すると書き込みが跳ね上がる(書き込み予算の見張りが在る)。
                                             欄を離れた時・Enter の時だけ保存する。 */}
                                         <input type="number" min={0.5} max={24} step={0.5} inputMode="decimal"
                                           key={`${w.id}:h:${i}:${hoursText}`} defaultValue={hoursText}
                                           onBlur={(ev) => { const el = ev.target; if (el.value !== hoursText) commitDayHours(w.name, i, el.value, () => { el.value = hoursText; }); }}
                                           onKeyDown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); }}
                                           style={WORKER_TAP} className={`${WORKER_INPUT_CLS} w-20 font-mono`} aria-label={`${w.name} の${i + 1}件目の時間数`} />
                                         時間
                                       </label>
                                     )}
                                     <input type="text" maxLength={200}
                                       key={`${w.id}:n:${i}:${noteText}`} defaultValue={noteText}
                                       onBlur={(ev) => { const el = ev.target; if (el.value !== noteText) patchDay(w.name, i, { note: el.value.slice(0, 200) }); }}
                                       onKeyDown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); }}
                                       placeholder="覚え書き（例: 定期健診）"
                                       style={WORKER_TAP} className={`${WORKER_INPUT_CLS} flex-1 min-w-[8rem]`} aria-label={`${w.name} の${i + 1}件目の覚え書き`} />
                                     <button type="button" onClick={() => removeDay(w.name, i)} style={WORKER_TAP}
                                       className="px-3 rounded border border-slate-300 text-xs text-slate-500 hover:text-rose-600 hover:bg-rose-50">消す</button>
                                   </div>
                                 );
                               })}
                               <button type="button" onClick={() => addDay(w.name)} style={WORKER_TAP}
                                 className="mt-1 px-3 rounded border border-indigo-300 bg-white text-xs font-bold text-indigo-700 hover:bg-indigo-50">＋ 1件足す</button>
                             </div>
                             {/* ③ 残業 */}
                             <div className="mt-3" data-worker-profile-overtime={w.name}>
                               <div className="text-xs font-bold text-slate-700">③ 残業</div>
                               <p className="fi-tap-text text-slate-500 mb-1">どちらも空 = 工場の決まりのまま。「残業に回さない」を選ぶと、1日の上限は 0分 として数えます。</p>
                               <div className="flex items-center gap-2 flex-wrap">
                                 <select value={overtimeOf(p).allowed === true ? 'yes' : (overtimeOf(p).allowed === false ? 'no' : '')}
                                   onChange={(e) => putOvertime(w.name, { allowed: e.target.value === 'yes' ? true : (e.target.value === 'no' ? false : null) })}
                                   style={WORKER_TAP} className={WORKER_INPUT_CLS} aria-label={`${w.name} の残業に回してよいか`}>
                                   <option value="">決めない（工場の決まりのまま）</option>
                                   <option value="yes">残業に回してよい</option>
                                   <option value="no">残業に回さない</option>
                                 </select>
                                 <label className="flex items-center gap-1 text-xs text-slate-600">
                                   1日
                                   <input type="number" min={0} max={720} step={10} inputMode="numeric"
                                     key={`${w.id}:ot:${otMaxText(p)}`} defaultValue={otMaxText(p)} placeholder="上限なし"
                                     onBlur={(ev) => { const el = ev.target; if (el.value !== otMaxText(p)) commitOvertimeMax(w.name, el.value, () => { el.value = otMaxText(p); }); }}
                                     onKeyDown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); }}
                                     style={WORKER_TAP} className={`${WORKER_INPUT_CLS} w-24 font-mono`} aria-label={`${w.name} の1日の残業の上限（分）`} />
                                   分まで
                                 </label>
                               </div>
                             </div>
                           </div>
                         </details>
                       </td>
                       <td className="py-1 pr-3">
                         {has && (
                           <button type="button" style={WORKER_TAP}
                             onClick={() => { if (window.confirm(`「${w.name}」の個人ごとの設定を全部消して、勤務時間マスタどおりに戻します。よろしいですか？`)) put(w.name, { dayStart: null, dayEnd: null, directRatio: null, templatePrefs: null, byWeekday: null, days: null, overtime: null }); }}
                             className="text-xs px-3 rounded border border-slate-300 text-slate-500 hover:text-rose-600 hover:bg-rose-50">マスタどおりに戻す</button>
                         )}
                       </td>
                     </tr>
                   );
                 })}
               </tbody>
             </table>
           </div>
         )}
       </div>
     </details>
   );
 };

export default WorkerProfilesEditor;
export { WorkerProfilesEditor };
