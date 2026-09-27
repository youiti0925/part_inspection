// =============================================================================
//  parallelLab/fullPairInput.js — 本番のロット2つを ChatGPT(Codex)の「全台完了までの前後比較」へ渡す入力を作る(純関数・2026-09-25)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-24〜25): 「今の(並列シミュ)は使えない、何をしたくて作ったかわからん」「並列シュミレーション直した？ chatgptの資料見たよね」
//  → 計算は ChatGPT の domain/fullPair/scheduler.mjs(組む前 A→B / B→A と 組んだ後を、2ロットの全台・全工程が終わるまで並べて比べる)。
//    ここは その入力を 本番のロットから作るだけ。数字は作らない。
//
//  時間: stepTimesOf(実績の P75・テンプレの目標・設定の自動時間。出典つき)。無い工程は「時間が分からない」で止める。
//  分からない事は「前提(conditions)」として持ち、画面で選べるようにして 結果の横に必ず並べる(推測を黙って混ぜない):
//    ・AとBの機械は 別か同じか(号機の記録が無い) ・自動の間は離れてよいか ・誰でもどの工程もできるか
//    ・作業中/止めている/不良の工程の残り(記録が無い) ・機械を使う工程が続く時に 次まで機械を押さえるか
//  🔍 2026-09-25 第三者の穴探し(7件)で直した所:
//    2026-09-25 Codex: 工程の塊化を本番変換から撤去。途中状態・不良・設備占有不明は停止。
//    ・工程が多いと1組で数十秒・打ち切り → 上限160件、探索の幅は工程数で決める(fullPairOptionsOf)
//    ・根拠の文(「実績N件」)を入力に入れていて、どこかで1工程済むたびに計算がやり直しになった → 入力に入れない
//    ・場所が内部の名前(zone_…)のまま手順の表に出た → 区画の名前を使う
//    ・ロット1回の工程: 完了/該当なし/修正済みを済みとする。不良は確認が必要(lot-1以降も見る)
// =============================================================================

export const FULL_PAIR_CONDITIONS = Object.freeze({
  sameMachine: false,       // AとBで同じ機械を使う(取り合う)
  mayLeave: true,           // 自動運転の間は 人が離れてよい
  anyone: true,             // 誰でもどの工程もできる(最終検査の既定と同じ考え)
  inProgressAsWhole: false, // 残時間・占有状態のない途中工程は計算を止める
  holdToNext: true,         // 製品を取り外すまで機械を空き扱いにしない
  maxDelayA: 0,             // 組む前より Aが何分まで遅れてよいか
  maxDelayB: 0,             // 組む前より Bが何分まで遅れてよいか
});

/** 旧診断ヘルパーの互換用。本番の入力では工程を塊化しない。 */
export const FULL_PAIR_MERGE_OVER = 60;
/** 全工程を保持する上限。大きい問題は探索制限を明示し、UIから中止できる。 */
export const FULL_PAIR_MAX_JOBS = 160;
/** 探索の幅(工程の数で決める。広いほど良い案を探すが遅い) */
export function fullPairOptionsOf(jobCount) {
  const beamWidth = jobCount <= 40 ? 128 : jobCount <= 70 ? 48 : 24;
  return { beamWidth, maxExpansions: 100000 };
}

const DONE = new Set(['completed', 'skipped', 'rework-done']);
const LOT_DONE = DONE;
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const unitsOf = (lot) => { const q = Math.floor(Number(lot && lot.quantity)); return Number.isFinite(q) && q > 0 ? q : 1; };
const taskOf = (tasks, step, idx, key) => (tasks && (tasks[`${str(step && step.id)}-${key}`] || tasks[`${idx}-${key}`])) || null;
/** ロット1回の工程の記録(lot-0 だけでなく lot-1 以降も) */
const lotOnceTasksOf = (tasks, step, idx) => {
  const pre = [`${str(step && step.id)}-lot-`, `${idx}-lot-`];
  return Object.keys(tasks || {}).filter((k) => pre.some((p) => p !== '-lot-' && k.startsWith(p))).map((k) => tasks[k]);
};

/**
 * 1ロットの残りの仕事を 計算の工程(jobs)にする。
 * @param {{ merge?: boolean }} p merge=true の時だけ 続いている手作業(機械を使わない)を台ごとに1つの塊にする
 * @returns {{ jobs: Array, missing: string[], inProgress: number, merged: number }}
 */
export function fullPairJobsOf({ lotKey, lot, times, machineId, conditions = FULL_PAIR_CONDITIONS, merge = false }) {
  const c = { ...FULL_PAIR_CONDITIONS, ...(conditions || {}) };
  const steps = Array.isArray(lot && lot.steps) ? lot.steps : [];
  const tasks = lot && lot.tasks && typeof lot.tasks === 'object' ? lot.tasks : {};
  const q = unitsOf(lot);
  const jobs = []; const missing = new Set(); const mergedSteps = new Set(); const blocked = new Set(); const held = new Set();
  let inProgress = 0;
  const frontier = Array.from({ length: q }, () => []);
  const pending = Array.from({ length: q }, () => null); // 台ごとの 続いている手作業の塊
  const lastMachineJob = Array.from({ length: q }, () => null);
  const stateOf = (t) => {
    const s = str(t && t.status);
    if (!s || s === 'waiting' || s === 'pending') return 'waiting';
    if (DONE.has(s)) return 'done';
    inProgress += 1;
    blocked.add('作業中・停止中・不良の工程があります。残時間と設備占有を確認してから比較してください');
    return 'waiting'; // diagnostics only: blocked prevents this input reaching the scheduler
  };
  const push = (job, unit) => {
    jobs.push(job);
    if (unit === null) { for (let u = 0; u < q; u += 1) { frontier[u] = [job.id]; lastMachineJob[u] = null; } } else frontier[unit] = [job.id];
  };
  const flush = (u) => {
    const p = pending[u]; if (!p) return;
    pending[u] = null;
    if (p.idxs.length > 1) p.idxs.forEach((i) => mergedSteps.add(i));
    const title = p.titles.length > 1 ? `${p.titles[0]} ほか${p.titles.length - 1}工程` : p.titles[0];
    push({ id: `${lotKey}/手${p.idxs[0]}-${u}`, lotId: lotKey, stepId: `手${p.idxs[0]}`, label: title, unit: u, kind: 'manual', durationMin: p.min,
      qualified: c.anyone ? true : undefined, resourceId: null, releaseMin: 0, deps: [...frontier[u]] }, u);
    lastMachineJob[u] = null;
  };
  steps.forEach((s, idx) => {
    const t = times && times[idx];
    if (!t) { missing.add(str(s?.title) || `工程${idx + 1}`); return; }
    const min = t.sec != null ? t.sec / 60 : NaN;
    const after = times?.[idx + 1];
    if (c.holdToNext && t.auto && after && !after.auto && !after.machine && !after.machineConfirmed) {
      blocked.add(`自動終了後の「${after.title}」の機械使用が未確認です。取外しを含むなら機械使用に設定してください`);
    }
    if (t.lotOnce) {
      // 不良を完了扱いにしない。ロット共通の途中状態は下で拒否する。
      if (lotOnceTasksOf(tasks, s, idx).some((x) => LOT_DONE.has(str(x && x.status)))) return;
      if (lotOnceTasksOf(tasks, s, idx).some((x) => !['', 'waiting', 'pending'].includes(str(x && x.status)))) {
        inProgress += 1; blocked.add('ロット共通工程の途中・不良が残っています。確認後に比較してください');
      }
      for (let u = 0; u < q; u += 1) flush(u);
      if (c.holdToNext && t.machine && q > 1 && lastMachineJob.some(Boolean)) {
        blocked.add('全台の機械使用直後にロット共通工程があります。設備占有の区切りを確認してください');
      }
      if (t.sec == null) missing.add(t.title);
      push({ id: `${lotKey}/${t.id}-lot-0`, lotId: lotKey, stepId: t.id, label: t.title, unit: null, kind: t.auto ? 'auto' : 'manual', durationMin: min,
        qualified: c.anyone ? true : undefined, unattended: t.auto ? !!c.mayLeave : undefined, resourceId: t.machine ? machineId : null,
        releaseMin: 0, deps: [...new Set(frontier.flat())] }, null);
      return;
    }
    for (let u = 0; u < q; u += 1) {
      if (stateOf(taskOf(tasks, s, idx, u)) === 'done') {
        const next = times?.[idx + 1];
        if (c.holdToNext && t.machine && next?.machine && !DONE.has(str(taskOf(tasks, steps[idx + 1], idx + 1, u)?.status))) {
          // 🔧 2026-09-27: 別の機械なら取り合わないので止めない(載せたまま次の工程から続けると仮定して計算する)。同じ機械を取り合う時だけ止める。
          if (c.sameMachine) blocked.add('機械を使う工程の途中です。設備占有状態が未確認のため比較を止めました');
          else held.add(`${u + 1}台目は機械に載せたまま、次の「${str(next.title)}」から続ける`);
        }
        continue;
      }
      if (t.sec == null) missing.add(t.title);
      if (merge && !t.auto && !t.machine) {
        const p = pending[u] || (pending[u] = { idxs: [], titles: [], min: 0 });
        p.idxs.push(idx); p.titles.push(t.title); p.min += min;
        continue;
      }
      flush(u);
      const job = { id: `${lotKey}/${t.id}-${u}`, lotId: lotKey, stepId: t.id, label: t.title, unit: u, kind: t.auto ? 'auto' : 'manual', durationMin: min,
        qualified: c.anyone ? true : undefined, unattended: t.auto ? !!c.mayLeave : undefined, resourceId: t.machine ? machineId : null,
        releaseMin: 0, deps: [...frontier[u]] };
      const prev = lastMachineJob[u];
      if (t.machine && c.holdToNext && prev && frontier[u].length === 1 && frontier[u][0] === prev.id) prev.holdFor = job.id;
      push(job, u);
      lastMachineJob[u] = t.machine ? job : null;
    }
  });
  for (let u = 0; u < q; u += 1) flush(u);
  return { jobs, missing: [...missing], blocked: [...blocked], held: [...held], inProgress, merged: mergedSteps.size };
}

/**
 * 2ロット(A・B)から 計算の入力を作る。
 * @param {{ A:{id,lot,times,zoneId,zoneName?,label}, B:{id,lot,times,zoneId,zoneName?,label}, travelMin:number|null, sameZone:boolean, travelNote?:string, conditions?:object }} p
 * @returns {{ ok:boolean, errors:string[], input:object|null, assumptions:string[], jobCount:number, options:object }}
 */
export function fullPairInputOf({ A, B, travelMin = null, sameZone = false, travelNote = '', conditions = FULL_PAIR_CONDITIONS, context = null, availability = null }) {
  const c = { ...FULL_PAIR_CONDITIONS, ...(conditions || {}) };
  const errors = []; const assumptions = [];
  const fail = (msgs, jobCount = 0) => ({ ok: false, errors: msgs, input: null, assumptions, jobCount, options: fullPairOptionsOf(jobCount) });
  if (!A || !B || !A.lot || !B.lot) return fail(['ロットを2つ選んでください']);
  if (str(A.id) === str(B.id)) return fail(['AとBに同じロットは選べません']);
  for (const [key, row] of [['A', A], ['B', B]]) {
    if (!Number.isInteger(Number(row.lot.quantity)) || Number(row.lot.quantity) < 1) errors.push(`${key}の台数を1以上の整数で確認してください`);
  }
  const keyA = 'A'; const keyB = 'B';
  const machA = c.sameMachine ? '共通の機械' : 'Aの機械';
  const machB = c.sameMachine ? '共通の機械' : 'Bの機械';
  const build = (merge) => [
    fullPairJobsOf({ lotKey: keyA, lot: A.lot, times: A.times, machineId: machA, conditions: c, merge }),
    fullPairJobsOf({ lotKey: keyB, lot: B.lot, times: B.times, machineId: machB, conditions: c, merge }),
  ];
  // Do not change the scheduling problem just to make it cheaper to search.
  const [ja, jb] = build(false);
  const merged = false;
  errors.push(...ja.blocked.map(x => `A: ${x}`), ...jb.blocked.map(x => `B: ${x}`));
  (ja.held || []).forEach(x => assumptions.push(`A: ${x}(機械の途中から・仮定)`));
  (jb.held || []).forEach(x => assumptions.push(`B: ${x}(機械の途中から・仮定)`));
  if (ja.missing.length) errors.push(`Aに時間が分からない工程があります: ${ja.missing.slice(0, 4).join('・')}${ja.missing.length > 4 ? ` ほか${ja.missing.length - 4}件` : ''}`);
  if (jb.missing.length) errors.push(`Bに時間が分からない工程があります: ${jb.missing.slice(0, 4).join('・')}${jb.missing.length > 4 ? ` ほか${jb.missing.length - 4}件` : ''}`);
  if (!ja.jobs.length) errors.push('Aに残りの工程がありません');
  if (!jb.jobs.length) errors.push('Bに残りの工程がありません');
  const jobs = [...ja.jobs, ...jb.jobs];
  if (availability) for (const [key, row] of [['A', A], ['B', B]]) {
    const at = availability[key];
    if (!Number.isFinite(at) || at < 0) errors.push(`${key}の到着時刻が未定です。「今日来る」だけでは時刻つきの短縮効果を確定しません`);
    else {
      jobs.filter(j => j.lotId === key).forEach(j => { j.baseReleaseMin = j.releaseMin; j.arrivalReleaseMin = at; j.releaseMin = at; });
      assumptions.push(`${key} ${row.label || row.id}は基準時点から${at}分後以降に着手する予測。実到着の確認とは別です`);
    }
  }
  if (jobs.length > FULL_PAIR_MAX_JOBS) errors.push(`工程が多すぎて計算できる数(${FULL_PAIR_MAX_JOBS})を越えます(${jobs.length}件。台数の少ないロットを選んでください)`);
  // 場所と片道(場所は区画の名前。手順の表に出るので 内部の名前にしない)
  const zA = str(A.zoneId); const zB = str(B.zoneId);
  if (!zA || !zB) errors.push('AとBの場所(区画)を選んでください');
  if (c.sameMachine && zA !== zB) errors.push('同じ固定設備を別の区画に同時配置できません。両ロットを測定機の設置区画に合わせてください');
  const nA = str(A.zoneName) || zA; let nB = str(B.zoneName) || zB;
  if (!sameZone && nA === nB) nB = `${nB}(${zB})`; // 名前が同じ別の区画
  const sameMin = sameZone && Number.isFinite(travelMin) && travelMin > 0;
  if (!(Number.isFinite(travelMin) && travelMin >= 0)) errors.push('区画が同じでも片道時間を確認してください。未登録を0分にしません');
  const locA = sameZone && sameMin ? `${nA}(A)` : nA;
  const locB = sameZone ? (sameMin ? `${nA}(B)` : nA) : nB;
  const travel = {};
  if (locA !== locB) {
    if (!(Number.isFinite(travelMin) && travelMin >= 0)) errors.push('AとBの間の片道(分)が分かりません');
    else { travel[locA] = { [locB]: travelMin }; travel[locB] = { [locA]: travelMin }; }
  }
  // 前提(画面に必ず並べる)
  assumptions.push(c.sameMachine ? 'AとBは同じ機械を使う(取り合う)' : 'AとBは別の機械(号機の記録が無いので 選んだ前提)');
  assumptions.push(c.mayLeave ? '自動運転の間は 人が離れてよい' : '自動運転の間も 人はそばで見ている');
  assumptions.push(c.holdToNext ? '連続する設備工程は次の対応まで機械を占有する' : '工程ごとに機械を解放する試算。実際に取り外せることの確認が必要');
  if (c.anyone) assumptions.push('誰でもどの工程もできる');
  if (ja.inProgress + jb.inProgress > 0) assumptions.push(`途中・不良の工程 ${ja.inProgress + jb.inProgress}件は残時間未確認のため計算を止めた`);
  if (merged) assumptions.push(`工程が多いので 続いている手作業を台ごとに1つの塊にした(${ja.merged + jb.merged}工程。組む前が長めに出て 短縮が多めに出ることがある)`);
  assumptions.push(sameZone && !sameMin ? '同じ区画なので 移動は0分' : `片道 ${Number.isFinite(travelMin) ? travelMin : '—'}分${travelNote ? `(${travelNote})` : ''}`);
  assumptions.push(context ? `指定した勤務日・休憩・終業を反映（勤務外の自動運転は${context.autoOutsideWindows ? '続ける' : '続けない'}）` : `時間の相性を見る試算。休憩・終業は未反映。${availability ? '到着待ちを含む共通の基準時点' : '2ロットがそろった時点'}から数えた`);
  assumptions.push('登録納期は日付のみ。時刻つきの納期確認は別途必要');
  if (context?.errors?.length) errors.push(...context.errors);
  if (errors.length) return fail(errors, jobs.length);
  const resources = {}; for (const j of jobs) if (j.resourceId) resources[j.resourceId] = 0;
  const input = {
    lots: [
      { id: keyA, label: `A ${str(A.label) || str(A.id)}`, location: locA, dueMin: null },
      { id: keyB, label: `B ${str(B.label) || str(B.id)}`, location: locB, dueMin: null },
    ],
    jobs, travel, startLocation: locA, workerWindows: context?.workerWindows || [[0, 60 * 24 * 14]], resources,
    maxLotDelay: { [keyA]: Math.max(0, Number(c.maxDelayA) || 0), [keyB]: Math.max(0, Number(c.maxDelayB) || 0) },
    assumptions: ['担当者の技能・設備の号機・入荷・納期は現場確認が必要です'],
    origin: context?.origin || (availability ? '到着待ちを含む共通の基準時点' : '2ロットがそろった時点'), startAt: context?.startAt || null,
    autoOutsideWindows: context ? context.autoOutsideWindows === true : true,
  };
  return { ok: true, errors: [], input, assumptions, jobCount: jobs.length, options: fullPairOptionsOf(jobs.length) };
}
