// =============================================================================
//  parallelLab/lotPair.js — 本番のロット2つで「自動運転のあいだに、もう一つ進める」を計算する純関数(2026-09-24)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-23〜24):
//   「各エリアからエリアへの距離と時間を初期データとして登録するだけ。司令塔の地図の座標を応用」
//   「後は型式テンプレ台数との組み合わせだけでシミュレーションできる」
//   「この距離でこの二つのロットを移動する価値があるか」「その一つロットで並列作業できるなら他の作業行く必要ない」
//   「①(ChatGPT の見本)に②(区画の距離)を足せばいいだけ。本来合体してるもの」
//
//  流れ: ロットA の残りの仕事を「人1人・機械1台」で並べる(inLotScheduleOf)
//        → 自動運転の間に 同じロットの他の台の手作業で埋まる分と、埋まらずに残る空き(窓)が出る
//        → 空きの窓ごとに「区画A↔区画B の往復＋戻りの余裕」を引いて、ロットB の手作業がどれだけ進むか(tripValueOf)
//        → 片道は 区画どうしの分数の表 → 同じ区画の中の移動 → 司令塔の工場の図の点(無ければ区画の図)×横幅(m) の順(travelOf)
//        → 地図の横幅が未入力なら、行く価値が出る片道の上限(breakEvenTravelOf)で答える
//        → 一番大きい空きの窓を ChatGPT の engine.mjs(3案: 待つ／終了前に戻る／Bを終えて戻る)へ渡す(engineInputOf)
//
//  🚨 実測(本番の控え 2026-09-23_1500): 「まとめて開始(batch)」の自動工程は 1台ずつ機械に載る(machineRuns 646回すべて1台・重なり0)。
//     だから自動は台ごとに1回ずつ数え、1台が自動の間に 他の台の手作業ができる(前の lotAutoProfileOf は1ロット1回と数えて誤り)。
//  🚨 機械は1ロットに1台。自動工程と「測定機を使う(workResource='measurement-machine')」手作業は機械を押さえる。
//  🚨 時間: 手作業=実績の P75(estimateDuration・無ければテンプレ目標)。自動=設定の autoEndSec(無ければ記録の P75)。出典を必ず返す。
//     どれも無い工程は「分からない」(数字を作らない)。
// =============================================================================
import { isAutoStep } from '../workExecution.js';
import { estimateDuration } from '../operationsSimulation/estimate.js';
import { readZoneTravel, travelKeyOf, zoneCenterOf, zoneHistoryOfTemplates } from './lotParallel.js';
import { MIN_TRIP_WORK_MIN } from '../juggleGuide.js';

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const r1 = (n) => Math.round(n * 10) / 10;
/** 空きの窓のうち、これより短い物には行かない(往復と戻りの余裕を引いた後に残る 手作業の分)。
 *  ⚠値の持ち主は ../juggleGuide.js(2026-09-26 部品検査へ juggleGuide.js をそのまま写すために移した)。ここは同じ名前で出し直すだけ。 */
export { MIN_TRIP_WORK_MIN };
/** 「行く価値あり」と言う合計の下限(分) */
export const MIN_GAIN_MIN = 5;
/** 「ロットの中で埋まる」と言う 残りの空きの上限(分) */
export const IN_LOT_OK_IDLE_MIN = 5;
/** 戻りの余裕(分)の既定。ChatGPT の見本と同じ 2分 */
export const DEFAULT_MARGIN_MIN = 2;

const DONE = new Set(['completed', 'skipped', 'rework-done']);
/** 機械を使う手作業を 工程名から見る(workResource が付いていない工程の分)。🚨 推定なので 画面に「工程名から」と出し、別に機械が在れば外せる。
 *   第三者(2026-09-24): 「三次元測定開始」(手作業・印なし)を 同じ三次元測定機の校正(自動)の最中に 別ロットで進める案を出していた。 */
export const MACHINE_TITLE_RE = /(測定開始|キャリブレーション|測定機)/;
const taskOf = (tasks, step, idx, key) => (tasks && (tasks[`${str(step.id)}-${key}`] || tasks[`${idx}-${key}`])) || null;
const isDone = (t) => !!t && DONE.has(t.status);

/**
 * 工程ごとの時間と出典。
 * @returns {Array<{ id, idx, title, auto:boolean, lotOnce:boolean, machine:boolean, sec:number|null, source:'setting'|'record'|'target'|'calibrated'|null, why:string }>}
 */
export function stepTimesOf({ lot, stats = null, customTargetTimes = null, modelGroups = null, mode = 'P75', masterIndex = null } = {}) {
  const steps = Array.isArray(lot && lot.steps) ? lot.steps : [];
  return steps.map((s, idx) => {
    const auto = isAutoStep(s, masterIndex);
    const byRes = str(s && s.workResource) === 'measurement-machine';
    const byTitle = !auto && !byRes && MACHINE_TITLE_RE.test(str(s && s.title));
    const base = { id: str(s && s.id) || `idx-${idx}`, idx, title: str(s && s.title) || `工程${idx + 1}`, auto, lotOnce: !!(s && s.lotOnce), machine: auto || byRes || byTitle, machineBy: auto ? 'auto' : byRes ? 'resource' : byTitle ? 'title' : null };
    if (auto) {
      const set = Number(s && s.autoEndSec);
      if (Number.isFinite(set) && set > 0) return { ...base, sec: set, source: 'setting', why: `設定の自動時間 ${r1(set / 60)}分` };
    }
    const e = estimateDuration({ step: s, templateId: lot && lot.templateId, model: lot && lot.model, customTargetTimes, modelGroups, stats, mode });
    if (e && e.seconds > 0) {
      const source = e.source === 'template-target' ? 'target' : e.source === 'calibrated' ? 'calibrated' : 'record';
      return { ...base, sec: e.seconds, source, why: auto ? `自動の時間の設定が無いので記録から: ${e.why}` : e.why };
    }
    return { ...base, sec: null, source: null, why: (e && e.why) || '実績も目標時間も無い' };
  });
}

/** 台数(1以上の整数) */
const unitsOf = (lot) => { const q = Math.floor(Number(lot && lot.quantity)); return Number.isFinite(q) && q > 0 ? q : 1; };

/**
 * 残りの仕事(台×工程・ロット1回)。済んだ物は外す。
 * @returns {{ jobs: Array<{ key, unit:number|null, idx, title, auto, lotOnce, machine, sec, source }>, missing: string[] }}
 */
export function remainingJobsOf({ lot, times }) {
  const steps = Array.isArray(lot && lot.steps) ? lot.steps : [];
  const tasks = lot && lot.tasks && typeof lot.tasks === 'object' ? lot.tasks : {};
  const q = unitsOf(lot);
  const jobs = []; const missing = new Set();
  steps.forEach((s, idx) => {
    const t = times[idx];
    if (t.lotOnce) {
      if (isDone(taskOf(tasks, s, idx, 'lot-0'))) return;
      if (t.sec == null) missing.add(t.title);
      jobs.push({ key: `${t.id}-lot-0`, unit: null, idx, title: t.title, auto: t.auto, lotOnce: true, machine: t.machine, sec: t.sec, source: t.source });
      return;
    }
    for (let u = 0; u < q; u += 1) {
      if (isDone(taskOf(tasks, s, idx, u))) continue;
      if (t.sec == null) missing.add(t.title);
      jobs.push({ key: `${t.id}-${u}`, unit: u, idx, title: t.title, auto: t.auto, lotOnce: false, machine: t.machine, sec: t.sec, source: t.source });
    }
  });
  return { jobs, missing: [...missing] };
}

/**
 * ロットの中の並べ方(人1人・機械1台)。自動が動いている間は、機械を使わない手作業(他の台)を先に進める。
 *   優先: ①機械が空いていて自動を始められる台 → 始める(人は手放しで次へ)
 *         ②人が空いていれば 手作業(次に自動が控えている台を先に・次に工程の若い順・台の若い順)
 *         ③何もできなければ 次の自動の終わりまで待つ = 空きの窓
 *   ロット1回の工程は関所: 前の工程が全台済むまで始めない／済むまで後ろの工程へ進まない。
 * @returns {{ ok:boolean, missing:string[], hasAuto:boolean, totalMin, autoMin, filledMin, idleMin, sequentialMin, savedMin,
 *             windows: Array<{ startMin, endMin, min, unit, title, afterTitle, afterMin }>, segments: Array<{ lane:'worker'|'machine', kind, startMin, endMin, unit, title }> }}
 */
export function inLotScheduleOf({ lot, times }) {
  const { jobs, missing } = remainingJobsOf({ lot, times });
  const hasAuto = jobs.some((j) => j.auto);
  const empty = { ok: false, missing, hasAuto, totalMin: 0, autoMin: 0, filledMin: 0, idleMin: 0, sequentialMin: 0, savedMin: 0, windows: [], segments: [] };
  if (!jobs.length) return { ...empty, ok: true };
  if (missing.length) return empty;
  const EPS = 1e-9;
  const min = (j) => j.sec / 60;
  // 1台ずつ順番(人が自動のそばで待つ) = 全部の合計
  const sequentialMin = jobs.reduce((n, j) => n + min(j), 0);
  const once = jobs.filter((j) => j.lotOnce);
  const q = unitsOf(lot);
  const queue = Array.from({ length: q }, (_, u) => jobs.filter((j) => j.unit === u).sort((a, b) => a.idx - b.idx));
  // 🚨 2026-09-24 第三者の指摘: 関所(ロット1回)は「始めた時」ではなく「終わった時」に開く。
  //   前は始めた瞬間に開いていて、校正(自動15分)の最中に後ろの「準備」を進めていた(86ロットで 空きを埋まったと言い過ぎ)。
  const onceAt = new Map(); // ロット1回の工程 key → { start, end }
  const started = [];       // 始めた台の工程 { idx, end }
  let t = 0; let workerFree = 0; let machineFree = 0;
  const unitFree = Array(q).fill(0);
  const segments = []; const windows = [];
  const running = []; // 動いている自動 { endMin, unit, title }
  let autoMin = 0;
  const onceDone = (o) => onceAt.has(o.key) && t >= onceAt.get(o.key).end - EPS;
  const onceBlocking = (idx) => once.some((o) => o.idx < idx && !onceDone(o));
  const readyOnce = () => once.find((o) => !onceAt.has(o.key)
    && queue.every((qq) => qq.every((j) => j.idx > o.idx))
    && started.every((s) => s.idx > o.idx || s.end <= t + EPS)
    && once.every((p) => p === o || p.idx > o.idx || onceDone(p))) || null;
  const nextOf = (u) => { const j = queue[u][0]; if (!j || onceBlocking(j.idx)) return null; return j; };
  const remainOf = () => queue.some((qq) => qq.length) || once.some((o) => !onceAt.has(o.key));
  let guard = 0;
  while (guard < 100000) {
    guard += 1;
    const remain = remainOf();
    const live = running.filter((r) => r.endMin > t + EPS);
    // 🚨 2026-09-24 第三者の指摘: 最後の自動が動いている間の人の空きも数える(前は仕事の列が空になった瞬間に止めて落としていた)
    if (!remain && !live.length) break;
    let acted = false;
    if (remain) {
      // ① 機械が空いていて 自動を始められる(人も台も空いている時点で始める)
      if (t >= machineFree - EPS && t >= workerFree - EPS) {
        const oa = readyOnce();
        if (oa && oa.auto) {
          const end = t + min(oa); segments.push({ lane: 'machine', kind: 'auto', startMin: t, endMin: end, unit: null, title: oa.title });
          running.push({ endMin: end, unit: null, title: oa.title }); machineFree = end; autoMin += min(oa); onceAt.set(oa.key, { start: t, end }); acted = true;
        } else {
          for (let u = 0; u < q && !acted; u += 1) {
            const j = nextOf(u);
            if (j && j.auto && t >= unitFree[u] - EPS) {
              const end = t + min(j); segments.push({ lane: 'machine', kind: 'auto', startMin: t, endMin: end, unit: u, title: j.title });
              running.push({ endMin: end, unit: u, title: j.title }); machineFree = end; unitFree[u] = end; autoMin += min(j); queue[u].shift(); started.push({ idx: j.idx, end }); acted = true;
            }
          }
        }
      }
      if (acted) continue;
      // ② 人の手作業
      if (t >= workerFree - EPS) {
        const oa = readyOnce();
        let pick = null;
        if (oa && !oa.auto && (!oa.machine || t >= machineFree - EPS)) pick = { j: oa, u: null };
        if (!pick) {
          const cands = [];
          for (let u = 0; u < q; u += 1) {
            const j = nextOf(u);
            if (!j || j.auto || t < unitFree[u] - EPS) continue;
            if (j.machine && t < machineFree - EPS) continue;
            // 次の自動までに残る手作業の数(少ない台ほど早く機械に載る)。自動が先に無ければ最後
            const k = queue[u].findIndex((x) => x.auto);
            cands.push({ j, u, toAuto: k < 0 ? 1e6 : k });
          }
          cands.sort((a, b) => a.toAuto - b.toAuto || a.j.idx - b.j.idx || a.u - b.u);
          if (cands.length) pick = cands[0];
        }
        if (pick) {
          const { j, u } = pick; const end = t + min(j);
          segments.push({ lane: 'worker', kind: 'work', startMin: t, endMin: end, unit: u, title: j.title });
          if (j.machine) { segments.push({ lane: 'machine', kind: 'setup', startMin: t, endMin: end, unit: u, title: j.title }); machineFree = end; }
          workerFree = end;
          if (u === null) onceAt.set(j.key, { start: t, end }); else { unitFree[u] = end; queue[u].shift(); started.push({ idx: j.idx, end }); }
          continue;
        }
      }
    }
    // ③ 何もできない → 次の出来事まで進む
    const events = [workerFree, machineFree, ...unitFree, ...[...onceAt.values()].map((v) => v.end), ...running.map((r) => r.endMin)].filter((x) => x > t + EPS);
    if (!events.length) break; // 進めない(あり得ない形)
    const next = Math.min(...events);
    if (t >= workerFree - EPS && live.length) {
      const r = [...live].sort((a, b) => a.endMin - b.endMin)[0];
      windows.push({ startMin: t, endMin: next, min: next - t, unit: r.unit, title: r.title });
      segments.push({ lane: 'worker', kind: 'idle', startMin: t, endMin: next, unit: r.unit, title: r.title });
    }
    t = next;
    for (let i = running.length - 1; i >= 0; i -= 1) if (running[i].endMin <= t + EPS) running.splice(i, 1);
  }
  if (remainOf()) {
    return { ...empty, missing: ['並べ方が途中で止まった(工程の順番が読めない)'] };
  }
  const totalMin = Math.max(t, workerFree, machineFree, ...unitFree, ...[...onceAt.values()].map((v) => v.end));
  // 埋まった分 = 自動運転の区間と人の手作業の区間の重なり
  const autoSegs = segments.filter((s) => s.lane === 'machine' && s.kind === 'auto');
  const workSegs = segments.filter((s) => s.lane === 'worker' && s.kind === 'work');
  let filledMin = 0;
  for (const a of autoSegs) for (const w of workSegs) filledMin += Math.max(0, Math.min(a.endMin, w.endMin) - Math.max(a.startMin, w.startMin));
  // 空きの窓は 隣り合う物をまとめる(次の出来事ごとに刻んでいるだけで、人から見れば1つの待ち)
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.endMin - w.startMin) < EPS) { last.endMin = w.endMin; last.min = last.endMin - last.startMin; } else merged.push({ ...w });
  }
  // 窓のあとに人がやる手作業(= Aの終了対応)
  for (const w of merged) {
    w.rawMin = w.endMin - w.startMin;
    const after = workSegs.find((s) => s.startMin >= w.endMin - EPS);
    w.afterTitle = after ? after.title : '';
    w.afterMin = after ? r1(after.endMin - after.startMin) : 0;
    w.startMin = r1(w.startMin); w.endMin = r1(w.endMin); w.min = r1(w.min);
  }
  const kept = merged.filter((w) => w.rawMin > 0.05);
  const idleMin = kept.reduce((n, w) => n + (w.rawMin || w.min), 0); // 丸める前の長さで足す
  return {
    ok: true, missing, hasAuto, totalMin: r1(totalMin), autoMin: r1(autoMin), filledMin: r1(filledMin), idleMin: r1(idleMin),
    sequentialMin: r1(sequentialMin), savedMin: r1(Math.max(0, sequentialMin - totalMin)),
    windows: kept, segments,
  };
}

/**
 * B で1回の訪問に進められる手作業のかたまり。B 自身の並べ方で、人が待つ所(B の自動運転)で区切る。
 *   machine = そのかたまりに 機械を使う手作業(測定機での段取り)が入っているか。
 *   🚨 2026-09-24 第三者の指摘: 前は B の手作業を全部足していて、B の自動の後ろの手作業まで「1回で進む」と言っていた。
 */
//   availAt  = そのかたまりに手を付けられる時刻(B 自身の並べ方で最初の手作業が始まる時。今=0)
//   gapAfter = そのかたまりを終えてから 次のかたまりに手を付けられるまで(B の自動運転を待つ分)
//   🚨 2026-09-24 ChatGPT の再現: 前は かたまりの間の B の自動を待たずに 次の空きで次のかたまりを数えていた
//     (B = 手5分→自動100分→手10分 で、A の空き 0〜10分・15〜35分 に「合計15分進む」と言っていた。本当は5分)。
export function manualChunkInfoOf(sched) {
  if (!sched || !sched.ok) return [];
  const segs = (sched.segments || []).filter((s) => s.lane === 'worker').sort((a, b) => a.startMin - b.startMin);
  const setup = (sched.segments || []).filter((s) => s.lane === 'machine' && s.kind === 'setup');
  const out = []; let cur = 0; let mac = false; let first = null; let last = null;
  const push = () => { out.push({ min: r1(cur), machine: mac, availAt: r1(first), endAt: last }); cur = 0; mac = false; first = null; };
  for (const s of segs) {
    if (s.kind === 'work') {
      if (first === null) first = s.startMin;
      cur += s.endMin - s.startMin; last = s.endMin;
      if (setup.some((m) => Math.abs(m.startMin - s.startMin) < 1e-9 && Math.abs(m.endMin - s.endMin) < 1e-9)) mac = true;
    } else if (s.kind === 'idle' && cur > 0) push();
  }
  if (cur > 0) push();
  return out.map((c, i) => {
    const next = out[i + 1];
    const { endAt, ...rest } = c;
    return { ...rest, gapAfter: next ? r1(Math.max(0, next.availAt - endAt)) : 0 };
  });
}
export function manualChunksOf(sched) { return manualChunkInfoOf(sched).map((c) => c.min); }

/** かたまりは 数(分)でも { min, availAt, gapAfter } でも受ける。数だけの時は 待ちを知らない(前の形)。 */
const chunkOf = (c) => (typeof c === 'number'
  ? { min: c, availAt: 0, gapAfter: 0 }
  : { min: Number(c && c.min) || 0, availAt: Number(c && c.availAt) || 0, gapAfter: Number(c && c.gapAfter) || 0 });

/** ロットの残りの手作業(分)の合計。 */
export function manualLeftOf({ lot, times }) {
  const { jobs, missing } = remainingJobsOf({ lot, times });
  const man = jobs.filter((j) => !j.auto);
  if (man.some((j) => j.sec == null)) return { ok: false, min: null, missing, jobs: man.length };
  return { ok: true, min: r1(man.reduce((n, j) => n + j.sec / 60, 0)), missing: [], jobs: man.length };
}

/** 工場に在るか(入荷待ち location==='arrival' は まだ工場に無い。入荷予定 entryAt を返す) */
export function presenceOf(lot) {
  const loc = str(lot && lot.location);
  const entryMs = Number(lot && lot.entryAt);
  if (loc === 'arrival') return { present: false, entryMs: Number.isFinite(entryMs) ? entryMs : null };
  return { present: true, entryMs: null };
}

/** 移動の設定(settings.opsim.zoneTravel)。地図の尺度は 地図ごとに別(司令塔の工場の図 overviewWidthM/overviewHeightM ／ 製品の区画の図 mapWidthM/mapHeightM) */
export function readTravelCfg(settings) {
  const base = readZoneTravel(settings);
  const raw = (settings && settings.opsim && settings.opsim.zoneTravel) || {};
  const pos = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const nonneg = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const override = {};
  for (const [k, v] of Object.entries(base.override || {})) { const n = nonneg(v); if (n != null) override[k] = n; } // 消した印(null)は無いのと同じ
  return { ...base, override, overviewWidthM: pos(raw.overviewWidthM), overviewHeightM: pos(raw.overviewHeightM), sameZoneMin: nonneg(raw.sameZoneMin) };
}

export const OVERVIEW_AREA_PREFIX = 'product-inspection-v1:area:';

/**
 * 区画の座標。🧭 清水さん「司令塔の方でマップを登録して各ポイントに座標登録してるやつを応用」→ 司令塔の工場の図の点を先に使う。
 *   司令塔: mapConfig.areas['product-inspection-v1:area:<区画id>'] = { x, y }(司令塔の地図の枠の 横・縦の %)。
 *   ⚠ 枠の縦横比は 見る画面で変わる(司令塔: 高さ 62vh・図は枠に収める)。縦幅(m)が入っていなければ 図の縦横比 aspect で仮定する(画面に出す)。
 *   無ければ 製品の区画の図(settings.mapZones の中心・%)。縦幅(m)が無ければ 同じ尺度と仮定。
 * @param overviewMap { areas, aspect } | null
 */
export function geoOf({ settings, overviewMap = null, cfg = null }) {
  const c = cfg || readTravelCfg(settings);
  const areas = overviewMap && overviewMap.areas && typeof overviewMap.areas === 'object' ? overviewMap.areas : null;
  if (areas) {
    const points = {};
    for (const [k, v] of Object.entries(areas)) {
      if (!k.startsWith(OVERVIEW_AREA_PREFIX) || !v || !Number.isFinite(Number(v.x)) || !Number.isFinite(Number(v.y))) continue;
      points[k.slice(OVERVIEW_AREA_PREFIX.length)] = { x: Number(v.x), y: Number(v.y) };
    }
    if (Object.keys(points).length >= 2) {
      const imgAspect = Number(overviewMap.aspect);
      const hasH = c.overviewWidthM && c.overviewHeightM;
      const aspect = hasH ? c.overviewHeightM / c.overviewWidthM : (Number.isFinite(imgAspect) && imgAspect > 0 ? imgAspect : 1);
      return { basis: 'overview', points, aspect, assumedAspect: !hasH, aspectFrom: hasH ? 'input' : (Number.isFinite(imgAspect) && imgAspect > 0 ? 'image' : 'square') };
    }
  }
  const zones = Array.isArray(settings && settings.mapZones) ? settings.mapZones : [];
  const points = {};
  for (const z of zones) { const cc = zoneCenterOf(z); if (z && z.id && cc && str(z.id) !== 'zone_unassigned') points[str(z.id)] = cc; }
  if (Object.keys(points).length < 2) return { basis: null, points: {}, aspect: 1, assumedAspect: true, aspectFrom: 'square' };
  const hasH = c.mapWidthM && c.mapHeightM;
  return { basis: 'schematic', points, aspect: hasH ? c.mapHeightM / c.mapWidthM : 1, assumedAspect: !hasH, aspectFrom: hasH ? 'input' : 'square' };
}

/** 区画 A↔B の中心の距離を 地図の横幅に対する割合で(縦は aspect で揃える)。座標が無ければ null */
export function spanFracOf(geo, a, b) {
  const pa = geo && geo.points ? geo.points[str(a)] : null; const pb = geo && geo.points ? geo.points[str(b)] : null;
  if (!pa || !pb) return null;
  const dx = (pa.x - pb.x) / 100; const dy = ((pa.y - pb.y) / 100) * (geo.aspect || 1);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 片道(分)。優先: ①区画どうしの分数の表(手で入れた値) ②同じ区画の中の移動(手で入れた値) ③地図の座標×横幅(m)÷歩く速さ。
 *   🚨 同じ区画を 0分と決めつけない(第三者 2026-09-24: 「行く価値あり」87件が全部 同じ区画・0分だった)。
 * @returns {{ min:number|null, source:'override'|'same'|'map'|null, meters:number|null, frac:number|null, why:string }}
 */
export function travelOf({ cfg, geo, a, b }) {
  const A = str(a); const B = str(b);
  if (!A || !B) return { min: null, source: null, meters: null, frac: null, why: 'place' };
  const ov = cfg && cfg.override ? cfg.override[travelKeyOf(A, B)] : undefined;
  if (ov !== undefined && ov !== null && ov !== '' && Number.isFinite(Number(ov)) && Number(ov) >= 0) return { min: Number(ov), source: 'override', meters: null, frac: spanFracOf(geo, A, B), why: '' };
  if (A === B) {
    if (cfg && Number.isFinite(cfg.sameZoneMin)) return { min: cfg.sameZoneMin, source: 'same', meters: null, frac: 0, why: '' };
    return { min: null, source: null, meters: null, frac: 0, why: 'same' };
  }
  const frac = spanFracOf(geo, A, B);
  if (frac == null) return { min: null, source: null, meters: null, frac: null, why: 'coords' };
  const W = geo && geo.basis === 'overview' ? cfg && cfg.overviewWidthM : cfg && cfg.mapWidthM;
  if (!W) return { min: null, source: null, meters: null, frac, why: 'width' };
  const meters = W * frac; const walk = (cfg && cfg.walkMPerMin) || 60;
  return { min: r1(meters / walk), source: 'map', meters: Math.round(meters), frac, why: '' };
}

/**
 * 空きの窓ごとに B へ往復して進められる手作業。
 *   1回の往復で進む分 = min(窓 − 片道×2 − 戻りの余裕, B の今のかたまりの残り)。
 *   MIN_TRIP_WORK_MIN 分に満たない往復はしない。ただし かたまりの残りを片付け切る往復は 短くても行く(でないと次のかたまりへ進めない)。
 *   B のかたまりは B 自身の自動運転で区切られる。1回の訪問では かたまりを越えない(越えるには B の自動を待つ)。
 */
// 🚨 2026-09-24 ChatGPT の再現2件で直した:
//   ・かたまりを終えたら 次のかたまりは「終えた時刻 + B の自動(gapAfter)」まで手を付けられない。
//     窓の時刻(startMin)が在る時は、着いてから その時刻まで待つ分を 使える時間から引く。
//   ・interruptible=false(B は途中で止めて戻れない)なら、残りのかたまりを 1回で終え切れる往復だけ数える
//     (下の比較 engine.mjs と同じ決まり。前は上の「行く価値あり」だけ 途中で止める前提で数えていた)。
export function tripValueOf({ windows = [], travelMin, marginMin = DEFAULT_MARGIN_MIN, bChunks = null, bManualMin = null, interruptible = true }) {
  if (!Number.isFinite(travelMin) || travelMin < 0) return { ok: false, gainMin: null, trips: 0, perWindow: [] };
  const chunks = Array.isArray(bChunks) && bChunks.length ? bChunks.map(chunkOf) : [chunkOf(Number.isFinite(bManualMin) ? bManualMin : Infinity)];
  let ci = 0; let left = chunks[0].min; let availAbs = chunks[0].availAt;
  let splitBlocked = 0; let waitedB = 0;
  const perWindow = windows.map((w) => {
    const usable = w.min - 2 * travelMin - marginMin;
    const timed = Number.isFinite(w.startMin);
    const arrive = timed ? w.startMin + travelMin : 0;
    const waitB = timed && ci < chunks.length ? Math.max(0, availAbs - arrive) : 0;
    let work = ci < chunks.length ? Math.min(Math.max(0, usable - waitB), left) : 0;
    const finishes = work > 0 && work >= left - 1e-9;
    let noSplit = false;
    if (!interruptible && work > 0 && !finishes) { work = 0; noSplit = true; splitBlocked += 1; }
    const go = work > 0 && (work >= MIN_TRIP_WORK_MIN || finishes);
    if (go) {
      waitedB += waitB;
      left -= work;
      if (left <= 1e-9) {
        const endAbs = arrive + waitB + work;
        const gap = chunks[ci].gapAfter;
        ci += 1;
        left = ci < chunks.length ? chunks[ci].min : 0;
        availAbs = endAbs + gap;
      }
    }
    return { ...w, usable: r1(usable), waitB: r1(waitB), noSplit, go, work: go ? r1(work) : 0 };
  });
  const gainMin = r1(perWindow.reduce((n, p) => n + p.work, 0));
  return { ok: true, gainMin, trips: perWindow.filter((p) => p.go).length, perWindow, splitBlocked, waitedB: r1(waitedB) };
}

/** 行く価値(合計 MIN_GAIN_MIN 分以上)が出る 片道の上限(0.5分刻み・最大30分)。途中で打ち切らず全部試して一番長い片道。片道0分でも出なければ null */
export function breakEvenTravelOf({ windows = [], marginMin = DEFAULT_MARGIN_MIN, bChunks = null, bManualMin = null, interruptible = true }) {
  let best = null;
  for (let tm = 0; tm <= 30; tm += 0.5) {
    const v = tripValueOf({ windows, travelMin: tm, marginMin, bChunks, bManualMin, interruptible });
    if (v.gainMin >= MIN_GAIN_MIN) best = tm;
  }
  return best;
}

/** 片道 tm 分に歩ける距離(m)が 区画間の距離になる 地図の横幅(m)。これ以下の横幅なら 行く価値あり */
export function widthLimitOf({ frac, travelMin, walkMPerMin = 60 }) {
  if (!Number.isFinite(frac) || frac <= 0 || !Number.isFinite(travelMin)) return null;
  return Math.round((travelMin * walkMPerMin) / frac);
}

/**
 * ロットの居場所: ロットに登録 → 型式テンプレの既定(設定) → 同じテンプレの過去のロットが一番多く居た区画 → 分からない
 */
export function zoneGuessOf({ lot, cfg, history }) {
  const own = str(lot && lot.mapZoneId);
  if (own && own !== 'zone_unassigned' && own !== 'buffer') return { zoneId: own, source: 'lot' };
  const tid = str(lot && lot.templateId);
  const tpl = cfg && cfg.zoneOfTemplate ? str(cfg.zoneOfTemplate[tid]) : '';
  if (tpl) return { zoneId: tpl, source: 'template' };
  const h = history && history[tid];
  if (h) {
    const top = Object.entries(h).sort((a, b) => b[1] - a[1])[0];
    const all = Object.values(h).reduce((n, v) => n + v, 0);
    if (top) return { zoneId: top[0], source: 'history', share: Math.round((top[1] / all) * 100), count: all };
  }
  return { zoneId: null, source: null };
}

export { zoneHistoryOfTemplates };

const WHY_TEXT = {
  place: 'AとBの場所を選ぶと、地図から片道が出ます',
  same: 'AとBが同じ区画です。「同じ区画の中の移動(片道)」を入れると答えが1つに決まります',
  coords: 'この区画は地図に点がありません。区画どうしの分数の表に入れると答えが1つに決まります',
  width: '地図の横幅(m)を入れると答えが1つに決まります',
};

/**
 * 行く事そのものを止める条件(細かな条件の欄・同じ区画で同じ種類の機械)。止める時は 理由の文を返す。
 *   sameMachine: A と B が同じ区画で、B のかたまりに機械を使う手作業が入っている(A の自動が その機械を使っている間は進まない)。
 *   flags.otherMachine が true(同じ区画に同じ種類の機械が別に在る)なら止めない。
 */
export function tripBlockOf({ flags = {}, sameZone = false, bChunkMachine = false }) {
  if (flags.mayLeave === false) return 'Aの自動運転中は そばで見ている決まりなので行かない';
  if (flags.canDoB === false) return 'この人は Bの工程の担当に入っていないので行かない';
  if (flags.equipmentBAvailable === false) return 'Bの設備が空いていないので行かない';
  if (flags.sameEquipment === true || (sameZone && bChunkMachine && flags.otherMachine !== true)) return '同じ区画で Bの工程も同じ種類の機械を使う(工程名・機械の印から)ので、Aの自動運転の間は進まない。機械が別に在るなら 細かな条件で「同じ種類の機械が別に在る」に印';
  return null;
}

/**
 * A と B の組み合わせの答え。
 * @param travel travelOf の戻り(または 試しの値 { min, source:'trial' })
 * @param block  tripBlockOf の戻り(止める理由)。在れば「行く価値なし」
 * @returns {{ kind:'noAuto'|'unknown'|'inLot'|'go'|'stay'|'breakEven'|'noGain', say, travel, gainMin, breakEvenMin, widthLimitM, trip }}
 */
export function pairAnswerOf({ schedA, bChunks = null, travel = null, marginMin = DEFAULT_MARGIN_MIN, walkMPerMin = 60, block = null, interruptible = true }) {
  if (!schedA || !schedA.ok) return { kind: 'unknown', say: `ロットAの時間が分からない工程があります(${(schedA && schedA.missing || []).join('・')})` };
  if (!schedA.hasAuto) return { kind: 'noAuto', say: 'ロットAに自動運転の工程が残っていません(手が空く時間が無い)' };
  if (schedA.idleMin < IN_LOT_OK_IDLE_MIN) {
    return { kind: 'inLot', say: `自動運転 ${schedA.autoMin}分のうち ${schedA.filledMin}分は同じロットの手作業で埋まり、残る空きは ${schedA.idleMin}分。他へ行く必要はありません` };
  }
  if (!Array.isArray(bChunks) || !bChunks.length) return { kind: 'unknown', say: 'ロットBに進められる手作業が無いか、時間が分からない工程があります' };
  if (block) return { kind: 'stay', say: `行く価値なし: ${block}`, travel, gainMin: 0, breakEvenMin: null, widthLimitM: null, blocked: true };
  const breakEvenMin = breakEvenTravelOf({ windows: schedA.windows, marginMin, bChunks, interruptible });
  // 途中で止められない事だけが理由で届かない時は、その理由を言う(Aを待たせて Bを終える案は下の比較で見る)
  const splitNote = (trip) => (!interruptible && trip && trip.splitBlocked > 0 ? `。Bは途中で止めて戻れない設定なので、空きの中で Bの手作業(${r1(chunkOf(bChunks[0]).min)}分のかたまり)を終え切れる往復しか数えていません(Aを待たせて Bを終えてから戻る案は 下の3案で)` : '');
  const waitNote = (trip) => (trip && trip.waitedB > 0 ? `(Bの自動運転を待つ ${trip.waitedB}分を除く)` : '');
  const widthLimitM = breakEvenMin != null && travel ? widthLimitOf({ frac: travel.frac, travelMin: breakEvenMin, walkMPerMin }) : null;
  if (travel && Number.isFinite(travel.min)) {
    const trip = tripValueOf({ windows: schedA.windows, travelMin: travel.min, marginMin, bChunks, interruptible });
    const tag = travel.source === 'trial' ? '(試しの値)' : travel.source === 'override' ? '(区画どうしの表)' : travel.source === 'same' ? '(同じ区画の中)' : travel.meters != null ? `(地図で ${travel.meters}m)` : '';
    if (trip.gainMin >= MIN_GAIN_MIN) return { kind: 'go', say: `行く価値あり: 空き ${schedA.windows.length}回のうち ${trip.trips}回 往復して、ロットBの手作業が ${trip.gainMin}分 進みます${waitNote(trip)}(片道 ${travel.min}分${tag})`, travel, gainMin: trip.gainMin, breakEvenMin, widthLimitM, trip };
    return { kind: 'stay', say: `行く価値なし: 片道 ${travel.min}分${tag}だと往復と戻りの余裕に消えて、進むのは ${trip.gainMin}分だけ(${MIN_GAIN_MIN}分に届かない)${splitNote(trip)}`, travel, gainMin: trip.gainMin, breakEvenMin, widthLimitM, trip };
  }
  if (breakEvenMin == null) {
    const t0 = tripValueOf({ windows: schedA.windows, travelMin: 0, marginMin, bChunks, interruptible });
    const g0 = t0.gainMin;
    // 途中で止められない事が理由で 片道0分でも届かない時は「往復に消える」ではない(札も言葉も分ける)
    if (!interruptible && t0.splitBlocked > 0 && tripValueOf({ windows: schedA.windows, travelMin: 0, marginMin, bChunks }).gainMin >= MIN_GAIN_MIN) {
      return { kind: 'stay', say: `行く価値なし: Bは途中で止めて戻れない設定で、空き(一番長くて ${Math.max(...schedA.windows.map((w) => w.min))}分)の中では Bの手作業(${r1(chunkOf(bChunks[0]).min)}分のかたまり)を終え切れません(Aを待たせて Bを終えてから戻る案は 下の3案で)`, travel, gainMin: g0, breakEvenMin, widthLimitM: null, noSplit: true };
    }
    return { kind: 'noGain', say: `行く価値なし: 空きが短く(一番長くて ${Math.max(...schedA.windows.map((w) => w.min))}分)、片道0分でも Bが進むのは ${g0}分(${MIN_GAIN_MIN}分に届かない)${splitNote(t0)}`, travel, gainMin: g0, breakEvenMin, widthLimitM: null };
  }
  const wl = widthLimitM != null ? `(この2区画なら 地図の横幅が ${widthLimitM}m 以下)` : '';
  return { kind: 'breakEven', say: `片道 ${breakEvenMin}分まで${wl}なら行く価値あり。${WHY_TEXT[travel && travel.why] || WHY_TEXT.width}`, travel, gainMin: null, breakEvenMin, widthLimitM };
}

/**
 * ChatGPT の engine.mjs(compare)へ渡す入力。空きの窓の1回分を見せる(後に A の手作業がある窓のうち一番長い物。無ければ一番長い窓)。
 *   autoMin = その窓(人の手が空く分) / responseMin = 窓のあとに A でやる手作業 / otherMin = B の今のかたまり(B の自動まで)
 *   締切は日付しか無いので null(engine は「締切不明」)。勤務窓は 既定 480分(1日8時間・変えられる)。緊急は画面の欄(flags.urgent)だけから。
 */
export function engineInputOf({ schedA, bChunks, travelMin, marginMin = DEFAULT_MARGIN_MIN, flags = {}, windowMin = 480, otherMinOverride = null, sameMachine = false }) {
  if (!schedA || !schedA.ok || !schedA.windows.length || !Array.isArray(bChunks) || !bChunks.length) return null;
  const byLen = [...schedA.windows].sort((a, b) => b.min - a.min);
  const w = byLen.find((x) => x.afterMin > 0) || byLen[0];
  const other = Number.isFinite(otherMinOverride) && otherMinOverride > 0 ? otherMinOverride : chunkOf(bChunks[0]).min;
  const x = {
    autoMin: Math.max(0.5, w.min), responseMin: Math.max(0.5, w.afterMin || 0.5), otherMin: Math.max(0.5, other),
    outMin: Number.isFinite(travelMin) ? travelMin : 0, backMin: Number.isFinite(travelMin) ? travelMin : 0,
    marginMin, windowMin: Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 480,
    dueA: null, dueB: null,
    mayLeave: flags.mayLeave !== false, canDoB: flags.canDoB !== false, equipmentBAvailable: flags.equipmentBAvailable !== false,
    sameEquipment: flags.sameEquipment === true || (sameMachine && flags.otherMachine !== true), interruptible: flags.interruptible !== false,
    urgent: flags.urgent === true,
  };
  return { input: x, window: w, noAfter: !(w.afterMin > 0) };
}

/**
 * A の相手(B)の順番。一覧の札と 画面の既定の B を同じ決め方にする(食い違わせない)。
 *   並び: (A が工場に在る時だけ)工場に在る相手が先 → ①行く価値が出る ②片道が分からない(1回で進める手作業の多い順) ③往復に消える・止める条件
 * @param candidates [{ id, chunks:number[], chunkMachine:boolean, zoneId, present:boolean }]
 */
export function rankPartnersOf({ schedA, zoneA, aPresent = true, candidates = [], cfg, geo, marginMin = DEFAULT_MARGIN_MIN, flags = {} }) {
  const windows = (schedA && schedA.windows) || [];
  return candidates.filter((c) => c && Array.isArray(c.chunks) && c.chunks.length).map((c) => {
    const travel = travelOf({ cfg, geo, a: zoneA, b: c.zoneId });
    const block = tripBlockOf({ flags, sameZone: !!zoneA && str(zoneA) === str(c.zoneId), bChunkMachine: !!c.chunkMachine });
    const gain = block ? 0 : Number.isFinite(travel.min) ? tripValueOf({ windows, travelMin: travel.min, marginMin, bChunks: c.chunks, interruptible: flags.interruptible !== false }).gainMin : null;
    const tier = gain != null && gain >= MIN_GAIN_MIN ? 1 : gain == null ? 2 : 3;
    const manual = c.chunks.reduce((n, v) => n + chunkOf(v).min, 0);
    return { id: c.id, travel, gain, tier, manual, first: chunkOf(c.chunks[0]).min, present: c.present !== false, block };
  }).sort((a, b) => (aPresent ? (Number(b.present) - Number(a.present)) : 0) || a.tier - b.tier || (a.tier === 2 ? b.first - a.first : (b.gain - a.gain) || (b.first - a.first)));
}
