// ============================================================================
// 🔧 設備・治具の取り合い —「同時に何台まで」を過去の実績から数える
// ----------------------------------------------------------------------------
// 狙い(2026-09-10):
//   三次元測定機のように **台数が限られている設備** を、2人が同時に使う計画は嘘。
//   区画の定員(zoneCapacity.js)と同じ考え方で、設備にも門を付ける。
//
// 🚨 いまの割付は設備を1バイトも見ていない。
//   simulate.js には設備の門の形だけ在るが(busyEquipment / wait-equipment)、
//   normalizeInput.js が `equipmentId: null` を全部の工程に入れているので、
//   門は一度も閉じた事がない。ここはその「どの工程がどの設備を使うか」を
//   本番のデータから作る所。
//
// ── 本番の写しで実測(2026-09-10_0100・製品検査) ────────────────────────────
//   設備の手掛かりは **step.workResource** に入っていた(アプリ本体の工程エディタが書く欄。
//   App.jsx の札は「🔒 測定機占有」「治具占有」)。lot.machineRuns[].resourceId にも同じ字が入る。
//     ・テンプレ 34本 / 工程 286件 のうち 設備の指定が在る工程 89件(31%)・20本のテンプレ
//     ・出てきた設備の種類は **1つだけ**: measurement-machine(測定機)。治具の指定は0件
//     ・作業 7,423件(**完了は 7,067件**。他に 抜取で飛ばした351件・NG4件・止めた1件)のうち
//       設備を使う作業 1,873件(完了とNGだけを数え、抜取で飛ばした台・該当なしは外した数)
//       ⚠ 2026-09-10 の確かめ役が数え直して直した行。前は「完了した作業 7,423件」と
//         書いてあったが、7,423 は **全部の作業** の数で、完了は 7,067件。
//         (reworkRate.js:47 は最初から正しく「タスク 7,423件 → 完了 7,067件」と書いている)
//         この3つの数は下の見張り E17b が写しで数え直して突き合わせる。
//     ・時刻が読めた区間 1,823件 / 4人 / **同時に手を動かしていた人は最大2人**
//       (2人以上だった時間は全体の 0.4% / 3人以上は 0.0%)
//     ・自動測定の記録(machineRuns) 428区間 / **同時に走っていたのは最大3本**
//       (2本以上だった時間は 0.1%)
//     ・定員を1台にすると 開始が待たされる区間 164件(9.0%)。2台以上なら 0件
//     ・まだ終わっていないロットに残っている「設備を使う工程」743件 / 116ロット
//
// ⚠⚠ 決めるのは人。ここは「過去はこうだった」を出すだけで、上限を勝手に決めない。
//   ・設定(settings.opsim.equipmentCapacity)に人が書いた数が在れば **それが勝つ**
//   ・書いていなければ **上限をかけない**(null)。実測は出すが、使うかどうかは呼ぶ側が決める
//   ・実測も無ければ もちろん **制限しない**。分からない物を1台と決めつけない
//
// 🚨🚨 2026-09-10 の指摘で直した所:
//   前は「設定が無ければ **過去の実測を既定にする**」だった。これは この一連の8本の中で
//   **設備だけが「渡せば既定で効く」** という事で、他の7本(人の速さ・段取り替え・分納・
//   中断・修正・出荷期限・人の空き・危ない仕事)の「渡されなければ1行も動かない」と
//   食い違っていた。過去に1区間しか記録の無い設備でも observedMax=1 が そのまま cap:1 になり、
//   盤を塞ぐ。いまは:
//     ① 実測を上限に使うのは、呼ぶ側が **useObserved:true** と言った時だけ
//     ② その時も **件数が少ない設備(区間 5件未満)は enough:false** で上限を言い切らない
//   ⚠ 実測そのもの(observedMax / rows / 「1台にすると何件詰まるか」)は今までどおり全部出す。
//     隠すのではなく、**使うかどうかを呼ぶ側の一言に預ける** だけ。
//
// ⚠ 実測の読み方を2つ持つ理由:
//   ・人の同時数(observedWorkerMax)は zoneCapacity.js と同じ数え方。**下限**でしかない。
//   ・自動測定の同時本数(observedRunMax)は機械そのものの重なり。写しでは 3本 が同時に走っていて、
//     人の同時数(2人)より大きい。人だけで数えて「2台まで」と決めると、
//     **実際に3台同時に動いた過去を否定する上限** を作ってしまう。
//     だから既定は「2つのうち大きい方」= 見えている限りの下限にする。
//
// ⚠ 区画(zoneCapacity)との違い:
//   区画は **人** を数える(2人で入れば2人ぶん埋まる)。設備は **台** を数える。
//   2人で1台の測定機を触っても、埋まるのは1台。だから既定の必要台数は 1。
//
// ⚠ ここには React も firebase も import しない (node --test で回すため)。
// ⚠ 関数の中で今の時刻や乱数を読まない。時刻が要る所は now を引数で受け取る。
// ============================================================================

import { docIdOf, processKeyOf } from '../soloDependency.js';
// 時刻の読み方と「人が書いた上限」の読み方は区画と同じ物を使う(写して増やさない)。
import { msOfLoose, manualCapOf } from './zoneCapacity.js';

export { msOfLoose, manualCapOf };

/** 12時間より長い区間は記録の壊れ(閉じ忘れ)として捨てる。zoneCapacity.js と同じ。 */
const MAX_SEGMENT_MS = 12 * 3600 * 1000;

/**
 * 実測から上限を言ってよい最低件数(人の区間 + 自動測定の区間)。
 * ⚠ ここを下げると、1区間しか記録の無い設備で「同時1台まで」と言い切る事になる。
 *   他の7本と同じ 5件(estimate.js の MIN_SAMPLE_FOR_HIGH と同じ数)。
 *   ⚠ この数を持ち込むだけの為に estimate.js を取り込まない(設備は工数を数えていない)。
 */
export const MIN_SEGMENTS_FOR_CAP = 5;

/** 割付が塞がった時に残す印。simulate.js の audit と揃える。 */
export const EQUIPMENT_WAIT_KIND = 'wait-equipment';

/** 手が空いた理由の札。simulate.js の IDLE_REASON.ZONE_FULL と同じ書き方。 */
export const EQUIPMENT_FULL_LABEL = '設備が空くのを待っています';

/**
 * アプリ本体が使っている設備の呼び名。
 * App.jsx の工程エディタが書く値と、その画面の札に合わせる。
 * ⚠ ここに無い値は「そのまま名前として出す」。知らない字を捨てない。
 */
export const EQUIPMENT_NAMES = Object.freeze({
  'measurement-machine': '測定機',
  'jig-shared': '共用の治具',
});

/** 設備の呼び名。知らない id はその字のまま返す。 */
export const equipmentNameOf = (id) => {
  const k = String(id ?? '').trim();
  if (!k) return '';
  return EQUIPMENT_NAMES[k] || k;
};

/**
 * その工程が取り合う設備。
 * ⚠ 空文字・null は「設備を使わない」。欄そのものが無い(undefined)古い工程も、
 *   分からない物を塞がない為に **同じく素通り** にする。
 *   ただし「欄が無い工程が何件在ったか」は warnings で数える(黙って0件にしない)。
 */
export const equipmentIdOfStep = (step) => {
  const v = step == null ? undefined : step.workResource;
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s || null;
};

/** 工程の身元キー。normalizeInput.js の processKey と同じ形(長さ:テンプレid:工程id)。 */
export const equipmentStepKeyOf = (templateId, stepId) => processKeyOf(templateId, stepId);

/**
 * テンプレを読んで「どの工程がどの設備を取り合うか」を作る。
 * @param templates テンプレの配列(そのまま)
 * @returns {{
 *   byStepKey: { [processKey]: string },      工程キー -> 設備id
 *   byEquipment: { [equipmentId]: string[] }, 設備id -> 工程キーの並び(名前順)
 *   stepsTotal: number, stepsWithEquipment: number, stepsWithoutField: number,
 *   templatesWithEquipment: number,
 * }}
 */
export const equipmentStepIndex = (templates) => {
  const byStepKey = {};
  const byEquipment = {};
  let stepsTotal = 0;
  let stepsWithEquipment = 0;
  let stepsWithoutField = 0;
  const tplHit = new Set();

  for (const tpl of (templates || [])) {
    const templateId = docIdOf(tpl);
    if (!templateId) continue;
    for (const step of (tpl && Array.isArray(tpl.steps) ? tpl.steps : [])) {
      if (!step) continue;
      stepsTotal += 1;
      if (step.workResource === undefined) stepsWithoutField += 1;
      const eq = equipmentIdOfStep(step);
      if (!eq) continue;
      const stepId = String(step.id ?? step.stepId ?? '').trim();
      if (!stepId) continue;
      const key = equipmentStepKeyOf(templateId, stepId);
      byStepKey[key] = eq;
      (byEquipment[eq] = byEquipment[eq] || []).push(key);
      stepsWithEquipment += 1;
      tplHit.add(templateId);
    }
  }
  for (const eq of Object.keys(byEquipment)) byEquipment[eq].sort();
  return {
    byStepKey,
    byEquipment,
    stepsTotal,
    stepsWithEquipment,
    stepsWithoutField,
    templatesWithEquipment: tplHit.size,
  };
};

/** 作業の記録の鍵は `工程id-台番号`。工程idだけ取り出す。 */
export const stepIdOfTaskKey = (key) => String(key ?? '').replace(/-\d+$/, '');

/** 端点を重ね合わせて「同時に何本(何人)だったか」を数える。zoneCapacity.js と同じ手。 */
const sweep = (list) => {
  const ev = [];
  for (const x of list) { ev.push([x.a, 1, x.who]); ev.push([x.b, -1, x.who]); }
  // ⚠同時刻は「終わり」を先に処理する(入れ替わりを2つと数えない)。
  ev.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const held = new Map();
  let cur = 0; let max = 0; let last = null; let total = 0; let at2 = 0; let at3 = 0;
  for (const [t, d, who] of ev) {
    if (last != null && t > last) {
      total += t - last;
      if (cur >= 2) at2 += t - last;
      if (cur >= 3) at3 += t - last;
    }
    const n = (held.get(who) || 0) + d;
    if (n <= 0) held.delete(who); else held.set(who, n);
    cur = held.size;
    if (cur > max) max = cur;
    last = t;
  }
  return { max, total, at2, at3 };
};

/**
 * 過去の完了ロットから「その設備を 同時に何人・何本 使っていたか」を数える。
 *
 * 数える物は2つ。
 *   ① 人  … 設備を使う工程を、同時に手を動かしていた **別人** の数
 *   ② 自動 … lot.machineRuns[].segments の重なり(機械そのものの本数)
 *
 * @param lots 生のロット(tasks / steps / machineRuns を持つ物)
 * @param templates テンプレ(lot.steps に欄が無い古いロットの受け皿)
 * @param minSegments 実測から上限を言ってよい最低件数(既定 MIN_SEGMENTS_FOR_CAP)
 * @returns { [equipmentId]: {
 *   equipmentId, observedWorkerMax, observedRunMax, observedMax,
 *   segments, workers, runSegments, samples, enough, minSegments, why,
 *   share2, share3, runShare2, firstMs, lastMs } }
 *   enough … 件数が足りていて「上限はここまで」と言ってよいか。
 *            🚨 false でも observedMax は出す。数は見せるが、言い切らない。
 */
export const observedEquipmentConcurrency = ({ lots = [], templates = [], minSegments = MIN_SEGMENTS_FOR_CAP } = {}) => {
  const minN = (Number.isInteger(minSegments) && minSegments >= 1) ? minSegments : MIN_SEGMENTS_FOR_CAP;
  const { byEq, runByEq } = collectEquipmentSegments({ lots, templates });
  const out = {};
  const ids = new Set([...byEq.keys(), ...runByEq.keys()]);
  for (const eq of ids) {
    const list = byEq.get(eq) || [];
    const runs = runByEq.get(eq) || [];
    const w = sweep(list);
    const r = sweep(runs);
    // ⚠ 端は畳んで求める(区間が何万件になっても落ちない形にする)。
    let firstMs = null; let lastMs = null;
    for (const x of list) { if (firstMs == null || x.a < firstMs) firstMs = x.a; if (lastMs == null || x.b > lastMs) lastMs = x.b; }
    for (const x of runs) { if (firstMs == null || x.a < firstMs) firstMs = x.a; if (lastMs == null || x.b > lastMs) lastMs = x.b; }
    const samples = list.length + runs.length;
    const enough = samples >= minN;
    out[eq] = {
      equipmentId: eq,
      observedWorkerMax: w.max,
      observedRunMax: r.max,
      // 🚨 既定は「大きい方」。人だけで数えると、実際に同時に走っていた台数を下回る。
      observedMax: Math.max(w.max, r.max),
      segments: list.length,
      workers: new Set(list.map((x) => x.who)).size,
      runSegments: runs.length,
      // 🚨 件数が少ない設備で上限を言い切らない(2026-09-10)。
      //   1区間しか記録が無ければ 同時数は必ず1。それを「同時1台まで」と読むと盤が塞がる。
      samples,
      enough,
      minSegments: minN,
      why: enough
        ? `過去 ${samples}区間（人 ${list.length}・自動 ${runs.length}）で、同時に使われていたのは最大 ${Math.max(w.max, r.max)}`
        : `過去の記録が ${samples}区間（人 ${list.length}・自動 ${runs.length}）しかありません。`
          + `${minN}区間から「同時に何台まで」を言います`,
      share2: w.total > 0 ? w.at2 / w.total : 0,
      share3: w.total > 0 ? w.at3 / w.total : 0,
      runShare2: r.total > 0 ? r.at2 / r.total : 0,
      firstMs,
      lastMs,
    };
  }
  return out;
};

/**
 * 過去の作業を「設備ごとの区間」に畳む。
 * ⚠ observedEquipmentConcurrency と equipmentWaitCountAtCap の **両方がここを使う**。
 *   数え方を2箇所に書くと、片方だけ直した日に画面と試験が違う数を出す。
 * @returns {{ byEq: Map<string,{a,b,who}[]>, runByEq: Map<string,{a,b,who}[]> }}
 */
export const collectEquipmentSegments = ({ lots = [], templates = [] } = {}) => {
  // テンプレ側の受け皿。`テンプレid::工程id` -> 設備id
  const tplRes = new Map();
  for (const tpl of (templates || [])) {
    const tid = docIdOf(tpl);
    if (!tid) continue;
    for (const s of (tpl && Array.isArray(tpl.steps) ? tpl.steps : [])) {
      const sid = String(s && (s.id ?? s.stepId) || '').trim();
      if (!sid) continue;
      tplRes.set(`${tid}::${sid}`, equipmentIdOfStep(s));
    }
  }

  const byEq = new Map();      // 設備id -> 人の区間
  const runByEq = new Map();   // 設備id -> 自動測定の区間

  for (const lot of (lots || [])) {
    if (!lot) continue;
    const tid = String(lot.templateId ?? '').trim();
    // ロットに焼き付いた工程が正。テンプレは後から書き換わるので、無い時だけ見る。
    const stepRes = new Map();
    for (const s of (Array.isArray(lot.steps) ? lot.steps : [])) {
      const sid = String(s && (s.id ?? s.stepId) || '').trim();
      if (!sid) continue;
      stepRes.set(sid, equipmentIdOfStep(s));
    }
    const resOf = (sid) => (stepRes.has(sid) ? stepRes.get(sid) : (tplRes.has(`${tid}::${sid}`) ? tplRes.get(`${tid}::${sid}`) : null));

    // ① 人の区間
    for (const [k, t] of Object.entries(lot.tasks || {})) {
      if (!t) continue;
      if (t.status !== 'completed' && t.status !== 'ng') continue;
      // ⚠ 抜取で飛ばした台・該当なしは「手を動かしていない」。設備も使っていない。
      if (t.samplingSkipped || t.autoNa || t.templateSkipped) continue;
      const eq = resOf(stepIdOfTaskKey(k));
      if (!eq) continue;
      const segs = (Array.isArray(t.sessions) && t.sessions.length)
        ? t.sessions
        : [{ startTime: t.firstStartTime || t.startTime, endTime: t.endTime }];
      for (const sg of segs) {
        const a = msOfLoose(sg && (sg.startTime ?? sg.start));
        const b = msOfLoose(sg && (sg.endTime ?? sg.end));
        if (a == null || b == null || b <= a || (b - a) > MAX_SEGMENT_MS) continue;
        const who = String((sg && sg.workerName) || t.workerName || '').trim();
        if (!who) continue;   // 誰がやったか分からない区間は数えない(人数を数える話なので)
        let list = byEq.get(eq);
        if (!list) { list = []; byEq.set(eq, list); }
        list.push({ a, b, who });
      }
    }

    // ② 自動測定の区間(機械そのもの)
    for (const run of (Array.isArray(lot.machineRuns) ? lot.machineRuns : [])) {
      const eq = String(run && run.resourceId || '').trim();
      if (!eq) continue;
      const runId = String(run.id || `${docIdOf(lot)}#${run.stepId || ''}`);
      for (const sg of (Array.isArray(run.segments) ? run.segments : [])) {
        const a = msOfLoose(sg && (sg.startTime ?? sg.start));
        const b = msOfLoose(sg && (sg.endTime ?? sg.end));
        if (a == null || b == null || b <= a || (b - a) > MAX_SEGMENT_MS) continue;
        let list = runByEq.get(eq);
        if (!list) { list = []; runByEq.set(eq, list); }
        // 自動は「本数」を数えるので、重ね合わせの身元は区間ごとに別にする。
        list.push({ a, b, who: `${runId}#${a}` });
      }
    }
  }
  return { byEq, runByEq };
};

/**
 * 「その上限にしたら、過去の作業のうち何件が開始を待たされたか」。
 *
 * 🚨 上限を決める前に、これを画面に出す事。
 *   1台にすると 過去の 9.0%(164件/1823件・本番の写し 2026-09-10)が待ちに変わる。
 *   数字を見ずに「1台だろう」と決めると、盤が丸ごと後ろへずれる。
 *
 * ⚠ 数え方は「その区間が始まった時に、別人が何人 手を動かしていたか」。
 *   割付をやり直すのではなく、過去の重なりをそのまま当てるだけの近似。
 *
 * @returns { cap, blocked, total, share }  share は 0〜1
 */
export const equipmentWaitCountAtCap = ({ lots = [], templates = [], equipmentId = null, cap = 1, segments = null } = {}) => {
  const n = manualCapOf(cap);
  const list = Array.isArray(segments)
    ? segments
    : (collectEquipmentSegments({ lots, templates }).byEq.get(String(equipmentId ?? '')) || []);
  const total = list.length;
  if (n == null || total === 0) return { cap: n, blocked: 0, total, share: 0 };
  const sorted = [...list].sort((p, q) => (p.a - q.a) || (p.b - q.b) || String(p.who).localeCompare(String(q.who)));
  // 🚨 総当たりで数えない。本番の写しは1設備で1,823区間あり、総当たりだと画面が1秒以上止まる。
  //   始まりの順に歩き、終わった物を落としながら「いま手が動いている別人」を数える。
  const heap = [];   // 終わりが早い順の山(小さい二分ヒープ)
  const up = (i0) => {
    let i = i0;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].b <= heap[i].b) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
  };
  const down = () => {
    let i = 0;
    for (;;) {
      const l = i * 2 + 1; const r = l + 1; let m = i;
      if (l < heap.length && heap[l].b < heap[m].b) m = l;
      if (r < heap.length && heap[r].b < heap[m].b) m = r;
      if (m === i) break;
      const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
    }
  };
  const active = new Map();   // 名前 -> いま手を動かしている本数
  const drop = (x) => { const c = (active.get(x.who) || 0) - 1; if (c <= 0) active.delete(x.who); else active.set(x.who, c); };
  let blocked = 0;
  for (const s of sorted) {
    // ⚠ 終わった瞬間に次が始まるのは「重なり」ではない(b <= a は落とす)。
    while (heap.length && heap[0].b <= s.a) { drop(heap[0]); heap[0] = heap[heap.length - 1]; heap.pop(); if (heap.length) down(); }
    const others = active.size - (active.has(s.who) ? 1 : 0);
    if (others >= n) blocked += 1;
    active.set(s.who, (active.get(s.who) || 0) + 1);
    heap.push(s); up(heap.length - 1);
  }
  return { cap: n, blocked, total, share: total > 0 ? blocked / total : 0 };
};

/**
 * 人が書いた上限を読む。
 * ⚠⚠ 保存の形は **並び(配列)**: settings.opsim.equipmentCapacity = [{ equipmentId, cap }, ...]。
 *   表({id:n})にすると merge:true では1件消しても消えない(2026-07-26 の穴)。配列なら丸ごと置き換わる。
 *   古い表の形で保存されていても読めるようにしておく。
 * @returns { [equipmentId]: number } | null
 */
export const readManualEquipmentCaps = (settings) => {
  const raw = (settings && settings.opsim && settings.opsim.equipmentCapacity)
    || (settings && settings.equipmentCapacity)
    || null;
  if (!raw) return null;
  const m = {};
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const id = String(e && (e.equipmentId ?? e.id) || '').trim();
      const n = manualCapOf(e && e.cap);
      if (id && n != null) m[id] = n;
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const id = String(k || '').trim();
      const n = manualCapOf(v);
      if (id && n != null) m[id] = n;
    }
  }
  return Object.keys(m).length ? m : null;
};

/**
 * その設備の上限を決める。
 *
 * 🚨🚨 **渡されなければ効かない**(2026-09-10 に直した。他の7本と同じ形)。
 *   ① 人が設定に書いた数 …………………………………… それが勝つ(source:'setting')
 *   ② 過去の実測 ……… `useObserved:true` と言われた時 **だけ**(source:'observed')
 *      さらに件数が足りている(o.enough)時だけ。足りなければ source:'thin' で上限なし
 *   ③ 何も無い / 使うと言われていない ……………… 上限をかけない(cap:null)
 *
 * ⚠ source は「なぜその答えなのか」を必ず言う。cap:null の理由が3つ在るので1つに畳まない。
 *   'unlimited'          … 設定も実測も無い
 *   'observed-not-used'  … 実測は在るが、呼ぶ側が「使う」と言っていない
 *   'thin'               … 実測は在るが件数が足りない(言い切らない)
 *
 * @returns { cap:number|null, source:'setting'|'observed'|'observed-not-used'|'thin'|'unlimited',
 *            observed:number|null, enough:boolean }
 */
export const resolveEquipmentCap = (equipmentId, { manual = null, observed = null, useObserved = false } = {}) => {
  const o = (observed && observed[equipmentId]) || null;
  const oMax = (o && Number.isFinite(o.observedMax)) ? o.observedMax : null;
  // ⚠ enough が付いていない古い形の observed を渡された時は「足りている」と決めつけない。
  //   欄が無い＝分からない。分からない物で盤を塞がない。
  const oEnough = !!(o && o.enough === true);
  const m = manualCapOf(manual && manual[equipmentId]);
  if (m != null) return { cap: m, source: 'setting', observed: oMax, enough: oEnough };
  if (!o || !(oMax >= 1)) return { cap: null, source: 'unlimited', observed: null, enough: false };
  if (useObserved !== true) return { cap: null, source: 'observed-not-used', observed: oMax, enough: oEnough };
  if (!oEnough) return { cap: null, source: 'thin', observed: oMax, enough: false };
  return { cap: oMax, source: 'observed', observed: oMax, enough: true };
};

/**
 * 割付へ渡す形({設備id: 上限}) を作る。
 * ⚠上限が無い設備は **鍵ごと出さない**(素通りさせる)。
 * ⚠ useObserved を渡さなければ、人が設定に書いた設備しか入らない **= 何もしなければ空の表**。
 */
export const equipmentCapacityMap = ({ manual = null, observed = null, index = null, useObserved = false } = {}) => {
  const ids = new Set([
    ...Object.keys((index && index.byEquipment) || {}),
    ...Object.keys(observed || {}),
    ...Object.keys(manual || {}),
  ]);
  const map = {};
  for (const id of ids) {
    if (!id) continue;
    const { cap } = resolveEquipmentCap(id, { manual, observed, useObserved });
    if (cap != null) map[id] = cap;
  }
  return map;
};

/** 何日前かを日で。⚠ now を渡さなければ null(関数の中で今の時刻を読まない)。 */
const daysBefore = (ms, now) => {
  const n = (typeof now === 'number' && Number.isFinite(now) && now > 0) ? now : null;
  if (n == null || ms == null) return null;
  return Math.floor((n - ms) / 86400000);
};

/**
 * 画面に出す1行(設備ごと)。⚠数字は全部ここまでで数えた物から作る(手書きしない)。
 */
export const equipmentCapacityRows = ({ manual = null, observed = null, index = null, now = null, useObserved = false } = {}) => {
  const byEquipment = (index && index.byEquipment) || {};
  const ids = new Set([
    ...Object.keys(byEquipment),
    ...Object.keys(observed || {}),
    ...Object.keys(manual || {}),
  ]);
  const rows = [];
  for (const id of ids) {
    if (!id) continue;
    const o = (observed || {})[id] || null;
    const r = resolveEquipmentCap(id, { manual, observed, useObserved });
    const stepKeys = byEquipment[id] || [];
    const d = o ? daysBefore(o.lastMs, now) : null;
    // 🚨 上限をかけていない時は、その理由まで1行に入れる(「実測が在る」だけで終わらせない)。
    const capNote = r.source === 'setting'
      ? `。設定の ${r.cap}台 で門をかけます`
      : r.source === 'observed'
        ? `。この実測の ${r.cap}台 で門をかけます`
        : r.source === 'thin'
          ? `。${o ? o.why : ''}。上限はかけません`
          : r.source === 'observed-not-used'
            ? '。上限をかけるかどうかは まだ誰も決めていないので、門はかけません'
            : '';
    const note = o
      ? `過去 ${o.segments}回の作業・${o.workers}人。同時に手を動かしていたのは最大 ${o.observedWorkerMax}人`
        + `（2人以上だった時間 ${(o.share2 * 100).toFixed(1)}%）`
        + `。自動測定の記録では同時 ${o.observedRunMax}本（${o.runSegments}区間）${capNote}`
      : `過去の作業の記録がありません（この設備は上限をかけません）${r.source === 'setting' ? capNote : ''}`;
    rows.push({
      equipmentId: id,
      name: equipmentNameOf(id),
      cap: r.cap,
      source: r.source,
      enough: o ? !!o.enough : false,
      samples: o ? o.samples : 0,
      observedMax: o ? o.observedMax : null,
      observedWorkerMax: o ? o.observedWorkerMax : null,
      observedRunMax: o ? o.observedRunMax : null,
      segments: o ? o.segments : 0,
      workers: o ? o.workers : 0,
      runSegments: o ? o.runSegments : 0,
      share2: o ? o.share2 : 0,
      stepKeys,
      stepCount: stepKeys.length,
      lastUsedMs: o ? o.lastMs : null,
      lastUsedDaysAgo: d,
      note,
    });
  }
  return rows.sort((a, b) => (b.segments - a.segments) || String(a.name).localeCompare(String(b.name), 'ja'));
};

/**
 * 🔧 まとめの入口。画面も割付もここ1つを呼べば済む形にする。
 *
 * @param lots      生のロット(読むだけ)
 * @param templates 生のテンプレ(読むだけ)
 * @param settings  設定の doc(config)。人が書いた上限をここから読む
 * @param now       いまの時刻(ms)。⚠渡さなければ「何日前か」は null になるだけで、他は変わらない
 * @param useObserved 🚨 既定 false。過去の実測を上限として **使ってよいか**。
 *                  false のままなら、人が設定に書いた設備しか門をかけない(= 何もしなければ盤は変わらない)。
 * @param minSegments 実測から上限を言ってよい最低の区間数(既定 MIN_SEGMENTS_FOR_CAP)
 * @returns {{
 *   equipments: {id,name,stepKeys,observedMax,cap,source,enough,samples}[],
 *   capacity: { [equipmentId]: number },
 *   stepEquipment: { [processKey]: string },
 *   rows: object[],
 *   warnings: {code,text,count}[],
 *   useObserved: boolean,
 * }}
 */
export const buildEquipmentCapacity = ({
  lots = [], templates = [], settings = null, now = null,
  useObserved = false, minSegments = MIN_SEGMENTS_FOR_CAP,
} = {}) => {
  const index = equipmentStepIndex(templates);
  const observed = observedEquipmentConcurrency({ lots, templates, minSegments });
  const manual = readManualEquipmentCaps(settings);
  const rows = equipmentCapacityRows({ manual, observed, index, now, useObserved });
  const capacity = equipmentCapacityMap({ manual, observed, index, useObserved });

  const warnings = [];
  const push = (code, text, count) => warnings.push({ code, text, count });

  if (index.stepsTotal === 0) {
    push('no-templates', 'テンプレの工程を1件も読めませんでした。設備の門は1件もかかりません。', 0);
  } else if (index.stepsWithEquipment === 0) {
    push('no-equipment-step', '「この工程はどの設備を使うか」の指定が1件もありません。設備の門は1件もかかりません。', 0);
  }
  if (index.stepsWithoutField > 0) {
    push(
      'legacy-step',
      `設備の欄そのものが無い古い工程が ${index.stepsWithoutField}件 あります（工程 ${index.stepsTotal}件中）。`
      + 'この工程は設備を使うかどうか分からないので、上限をかけません。',
      index.stepsWithoutField,
    );
  }
  for (const r of rows) {
    if (r.source === 'unlimited') {
      push('unlimited', `${r.name} は設定も過去の記録もないので、上限をかけません。`, 0);
    } else if (r.source === 'observed-not-used') {
      // 🚨 黙って素通りしない。「実測は在るが、使うと言われていないので効いていない」と言う。
      push(
        'observed-not-used',
        `${r.name} の過去の実測は 同時 ${r.observedMax}台（${r.samples}区間）ですが、`
        + '設定にも上限が入っておらず、実測を使う指定も受けていないので **門はかけていません**。'
        + '実測をそのまま上限にするなら useObserved を渡すか、設定に台数を書いてください。',
        r.observedMax,
      );
    } else if (r.source === 'thin') {
      push(
        'thin',
        `${r.name} は過去の記録が ${r.samples}区間しかありません（${minSegments}区間から言います）。`
        + '同時に何台までかは言い切れないので、上限をかけません。',
        r.samples,
      );
    } else if (r.source === 'observed' && r.observedRunMax > r.observedWorkerMax) {
      push(
        'run-above-worker',
        `${r.name} は 人の同時作業は最大 ${r.observedWorkerMax}人 でしたが、`
        + `自動測定は同時 ${r.observedRunMax}本 走っていました。既定は大きい方の ${r.observedMax}台 にしています。`,
        r.observedRunMax,
      );
    }
    if (r.stepCount === 0 && r.segments > 0) {
      push(
        'no-step-key',
        `${r.name} は過去の記録はありますが、いまのテンプレでこの設備を使う工程が1件もありません。`
        + '割付の門は閉じません。',
        0,
      );
    }
  }

  const equipments = rows.map((r) => ({
    id: r.equipmentId,
    name: r.name,
    stepKeys: r.stepKeys,
    observedMax: r.observedMax,
    cap: r.cap,
    source: r.source,
    enough: r.enough,
    samples: r.samples,
  }));

  return { equipments, capacity, stepEquipment: index.byStepKey, rows, warnings, useObserved: useObserved === true };
};

// ---------------------------------------------------------------------------
// 割付が使う門
// ---------------------------------------------------------------------------

/** その仕事が取り合う設備。無ければ null(素通り)。 */
export const equipmentIdOfJob = (job) => {
  const v = job == null ? undefined : job.equipmentId;
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s || null;
};

/**
 * その仕事が何台ぶん使うか。既定は 1。
 * ⚠ 区画と違って **人数ではない**。2人で1台の測定機を触っても、埋まるのは1台。
 */
const headsOfJob = (job) => {
  const n = Number(job && job.equipmentHeads);
  return (Number.isInteger(n) && n >= 1) ? n : 1;
};

/**
 * いまその設備を何台使っているか。
 * 渡せる形:
 *   ・Map / 表 で 設備id -> 台数(数)          … そのまま数える
 *   ・Map / 表 で 設備id -> 仕事id(数でない)   … 「1台 使っている」と読む
 *     (simulate.js の state.busyEquipment がこの形)
 *   ・Set / 配列 の 設備id                     … 入っていれば 1台
 *   ・配列 の {equipmentId} を持つ物            … 数え上げる
 *   ・null / undefined                          … 0台
 */
export const equipmentHeadsUsed = (holders, equipmentId) => {
  const id = String(equipmentId ?? '');
  if (!id || holders == null) return 0;
  // ⚠ 数として数えるのは **本物の数** だけ。仕事idの文字が "3" だった日に
  //   「3台 使っている」と読み替えない(黙って上限を食い潰す)。
  const asCount = (v) => {
    if (v === undefined || v === null || v === false) return 0;
    if (typeof v === 'number') return (Number.isFinite(v) && v >= 0) ? v : 1;
    return 1;
  };
  if (holders instanceof Map) return asCount(holders.get(id));
  if (holders instanceof Set) return holders.has(id) ? 1 : 0;
  if (Array.isArray(holders)) {
    let n = 0;
    for (const h of holders) {
      if (h == null) continue;
      if (typeof h === 'string') { if (h === id) n += 1; continue; }
      if (typeof h === 'object' && equipmentIdOfJob(h) === id) n += headsOfJob(h);
    }
    return n;
  }
  if (typeof holders === 'object') return asCount(holders[id]);
  return 0;
};

/** 上限の読み方。表でも Map でも読む。1以上の整数だけを上限として認める。 */
export const equipmentCapOf = (capacity, equipmentId) => {
  const id = String(equipmentId ?? '');
  if (!id || capacity == null) return null;
  const v = (capacity instanceof Map) ? capacity.get(id) : (typeof capacity === 'object' ? capacity[id] : undefined);
  return manualCapOf(v);
};

/**
 * 🚨 割付の門。塞いだら **必ず理由を返す**(理由を言えない門は作らない)。
 *
 * @param job      { equipmentId, jobId, lotId, equipmentHeads? }
 * @param holders  いま使っている物(equipmentHeadsUsed が読む形なら何でも)
 * @param capacity { 設備id: 上限 } か Map
 * @returns {{ ok:boolean, reason: null | {
 *   kind:'wait-equipment', equipmentId, equipmentName, cap, used, need, jobId, lotId, text } }}
 *
 * ⚠ 渡されなければ1行も動かない:
 *   ・仕事に設備が付いていない → ok
 *   ・その設備の上限が無い     → ok
 */
export const equipmentGate = ({ job = null, holders = null, capacity = null } = {}) => {
  const id = equipmentIdOfJob(job);
  if (id == null) return { ok: true, reason: null };
  const cap = equipmentCapOf(capacity, id);
  if (cap == null) return { ok: true, reason: null };
  const used = equipmentHeadsUsed(holders, id);
  const need = headsOfJob(job);
  if (used + need <= cap) return { ok: true, reason: null };
  const name = equipmentNameOf(id);
  return {
    ok: false,
    reason: {
      kind: EQUIPMENT_WAIT_KIND,
      equipmentId: id,
      equipmentName: name,
      cap,
      used,
      need,
      jobId: job && job.jobId !== undefined ? job.jobId : null,
      lotId: job && job.lotId !== undefined ? job.lotId : null,
      text: `${EQUIPMENT_FULL_LABEL}（${name} は同時 ${cap}台まで・いま ${used}台 使っています）`,
    },
  };
};
