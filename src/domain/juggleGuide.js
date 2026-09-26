// 🚶 掛け持ち案内(自動測定の待ちの間に、別のロットへ行って戻る)— 純関数・UI/Firebase 非依存。
//
// 土台にした事実(本番の控え 2026-09-25_1000・自動運転620回・2026-07-27〜09-25):
//   ・実際の掛け持ち(自動中に別ロットの手作業)69回のうち 6分の分割測定の間が 59回(全部 作業者A)。
//   ・相手のロットは 別の区画が 63/70。相手でした作業は 片付け26・測定準備22・準備21・初回準備17。
//   ・相手は「測定済みで進行中」が47回(2つの区画の測定機を交互に回す形)、新しいロットが23回。
//   ・測定が終わった時まだ相手にいた37回のうち19回は、その相手を次に機械へ(=区切りの自動測定まで持っていって戻る)。
//   ・清水さん(2026-09-26): 区画の片道は 中間・完品どうし 約10秒、それらと三次元・第一組立は 約30秒。測定機は1区画に1台。
//     「別のロットを区切りのいい自動測定まで持っていってから元のロットへ戻るのが一番いい」。
//
// この案内が答えること:
//   「今の自動測定が終わるまでに、どのロットへ行って、何をして、いつ戻るか」。
//   候補は 自分の担当か担当なしのロットだけ(他の人のロットは出さない=取り合いにしない)。
//   計画は「そのロットの次の自動測定(区切り)まで」で切る。先の工程を先取りさせない。
//
// ⚠仮定の数字は入れない。片道の秒は 設定の表(settings.opsim.zoneTravel.override・分) → 区画の名前の目安(清水さんの実感) の順。
//   どちらも無ければ「片道 不明」として出す(0秒と決めつけない)。

// 🚶 2分の決まり(空きの窓のうち、これより短い物には行かない 手作業の分)。清水さん 2026-09-26「そのままでいいけど、すぐ変更できる状態に」。
//   ⚠ここが持ち主(2026-09-26 部品検査へこのファイルを そのまま写すため、lotPair.js から移した)。
//     parallelLab/lotPair.js は ここから import して同じ名前で出し直している(値は1か所)。
export const MIN_TRIP_WORK_MIN = 2;

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---- 片道の秒 ----------------------------------------------------------------------------------

/** 区画の名前から片道の目安(秒)。清水さん 2026-09-26 の実感。表に無い組だけに使う。 */
export const WALK_SEC_BY_NAME = Object.freeze([
  { a: /中間|完品/, b: /中間|完品/, sec: 10, why: '中間・完品どうし(清水さん 09-26: ほぼ10秒)' },
  { a: /三次元/, b: /中間|完品/, sec: 30, why: '三次元 ↔ 中間・完品(清水さん 09-26: 30秒ぐらい)' },
  { a: /第一組立/, b: /中間|完品/, sec: 30, why: '第一組立 ↔ 中間・完品(清水さん 09-26: 30秒)' },
]);

const zoneNameOf = (zones, id) => { const z = (zones || []).find((x) => x && str(x.id) === str(id)); return z ? str(z.name) || str(id) : ''; };

/**
 * 片道(秒)。① 設定の表(分) ② 同じ区画は 0秒 ③ 区画の名前の目安 ④ 不明(null)。
 * @param {{ a:string, b:string, zones:Array, travel?:{override?:object} }} p
 * @returns {{ sec:number|null, source:'table'|'same'|'name'|null, why:string }}
 */
export function walkSecOf({ a, b, zones = [], travel = null } = {}) {
  const A = str(a); const B = str(b);
  if (!A || !B) return { sec: null, source: null, why: '区画が未定' };
  if (A === B) return { sec: 0, source: 'same', why: '同じ区画' };
  const key = [A, B].sort().join('|');
  const ov = travel && travel.override ? travel.override[key] : undefined;
  const ovMin = num(ov);
  if (ovMin != null && ovMin >= 0) return { sec: Math.round(ovMin * 60), source: 'table', why: '区画どうしの表' };
  const na = zoneNameOf(zones, A); const nb = zoneNameOf(zones, B);
  for (const r of WALK_SEC_BY_NAME) {
    if ((r.a.test(na) && r.b.test(nb)) || (r.a.test(nb) && r.b.test(na))) return { sec: r.sec, source: 'name', why: r.why };
  }
  return { sec: null, source: null, why: '片道が未登録(区画どうしの表に入れてください)' };
}

/** 「行く価値がある最低の手作業」(秒)。既定は MIN_TRIP_WORK_MIN(2分・清水さん「そのままでいいが誰でもすぐ変えられるように」)。 */
export function minTripWorkSecOf(travel = null) {
  const v = num(travel && travel.minTripWorkMin);
  const min = v != null && v >= 0 ? v : MIN_TRIP_WORK_MIN;
  return Math.round(min * 60);
}

// ---- 自動終了の秒 --------------------------------------------------------------------------------

/** 自動終了の秒。①ロット工程自身 ②元テンプレの同一工程(id → 題名)。無ければ 0。(App.jsx の自動終了タイマーと同じ決め方) */
export function autoEndSecOf(step, tplSteps = []) {
  if (!step) return 0;
  if (step.executionMode === 'batch' && step.autoEndEnabled && Number(step.autoEndSec) > 0) return Number(step.autoEndSec);
  const ts = (tplSteps || []).find((x) => x && x.id && x.id === step.id) || (tplSteps || []).find((x) => x && (x.title || '') === (step.title || ''));
  if (ts && ts.executionMode === 'batch' && ts.autoEndEnabled && Number(ts.autoEndSec) > 0) return Number(ts.autoEndSec);
  return 0;
}

/** 自動測定の残り(秒)の目安: 自動終了の秒 → 無ければ目標時間。どちらも無ければ null(不明)。 */
export function autoLimitSecOf(step, tplSteps = []) {
  const a = autoEndSecOf(step, tplSteps);
  if (a > 0) return a;
  const t = Number(step && step.targetTime);
  return t > 0 ? t : null;
}

// ---- 台×工程の状態 -------------------------------------------------------------------------------

const taskOf = (tasks, step, sIdx, u) => (tasks && ((step && step.id && tasks[`${step.id}-${u}`]) || tasks[`${sIdx}-${u}`])) || null;
const lotTaskOf = (tasks, step) => (tasks && step && step.id && tasks[`${step.id}-lot-0`]) || null;
const settled = (s) => s === 'completed' || s === 'skipped' || s === 'ng' || s === 'rework-done';
// 🔧 2026-09-26 ChatGPT の確認: 目標が未設定の工程を 60秒と決めつけていた → null(不明)のまま持ち、区切りまでの時間は「出せない」と言う
const targetSecOf = (step) => { const t = Number(step && step.targetTime); return t > 0 ? t : null; };

/** 手作業が動いている(誰かが触っている)か。自動だけが動いているロットは「機械が回っているだけ」で、段取りはできる。 */
export const manualRunningOn = (lot, isAuto) => {
  const steps = (lot && lot.steps) || []; const tasks = (lot && lot.tasks) || {};
  return Object.keys(tasks).some((key) => {
    const t = tasks[key];
    // 🔧 2026-09-26 ChatGPT の確認: 手作業の修正中(reworking・止めていない)も「触っている」(開始ガード lotStartGuard.js と同じ見方)
    const rework = t && t.status === 'reworking' && !!t.reworkStartTime && !t.reworkPausedAt;
    if (!t || (t.status !== 'processing' && !rework)) return false;
    const m = String(key).match(/^(.*?)-(?:lot-)?(\d+)$/);
    const step = m ? (steps.find((s) => s && s.id === m[1]) || steps[Number(m[1])]) : null;
    return step ? !isAuto(step) : true;   // 工程が分からない鍵は「触っている」側に倒す
  });
};

/**
 * 相手ロットで「次の区切り(自動測定)までにできる手作業」。
 *   先頭のロット1回工程(準備など) → 台ごとに テンプレ順で 自動の手前まで → 全台の自動が済んでいれば 末尾のロット1回工程(最終片付けなど)。
 *   機械に載っている台(自動が processing / reworking / ng)と、誰かが手作業中の台は飛ばす。
 * @returns {{ items:Array<{stepId,stepTitle,unitIdx,targetSec,lotOnce?:boolean}>, kugiri:{unitIdx,stepTitle}|null, secToKugiri:number|null, measuredBefore:boolean }}
 */
export function planUntilKugiri({ lot, isAuto } = {}) {
  const steps = (lot && lot.steps) || []; const tasks = (lot && lot.tasks) || {}; const qty = Math.max(1, Number(lot && lot.quantity) || 1);
  const items = []; let kugiri = null; let secToKugiri = null;
  const firstAuto = steps.findIndex((s) => s && !s.lotOnce && isAuto(s));
  const noAuto = firstAuto < 0;   // 🔧 2026-09-26 ChatGPT の確認: 自動が無いロットは 先頭の処理で全部載せ、末尾の処理では二重に載せない
  const lastAuto = (() => { for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i] && !steps[i].lotOnce && isAuto(steps[i])) return i; return -1; })();
  const measuredBefore = steps.some((s, si) => s && !s.lotOnce && isAuto(s) && Array.from({ length: qty }, (_, u) => taskOf(tasks, s, si, u)).some((t) => t && (settled(t.status) || t.status === 'processing')))
    || (Array.isArray(lot && lot.machineRuns) && lot.machineRuns.length > 0);
  // 先頭のロット1回工程(最初の自動より前)
  steps.forEach((s, si) => {
    if (!s || !s.lotOnce || isAuto(s)) return;
    if (!noAuto && si > firstAuto) return;
    const t = lotTaskOf(tasks, s); const st = t ? t.status : 'waiting';
    if (settled(st) || st === 'processing' || st === 'reworking') return;
    items.push({ stepId: s.id, stepTitle: s.title || '', unitIdx: null, targetSec: targetSecOf(s), lotOnce: true });
  });
  // 台ごと。acc は分かっている時間の合計・unknown は目標未設定の工程が混じった印
  let acc = items.reduce((a, it) => a + (it.targetSec || 0), 0); let unknown = items.some((it) => it.targetSec == null);
  for (let u = 0; u < qty; u += 1) {
    let unitItems = []; let unitKugiri = null; let skip = false;
    for (let si = 0; si < steps.length; si += 1) {
      const s = steps[si]; if (!s || s.lotOnce) continue;
      const t = taskOf(tasks, s, si, u); const st = t ? t.status : 'waiting';
      if (isAuto(s)) {
        if (st === 'processing' || st === 'reworking' || st === 'ng') { skip = true; break; }   // 機械に載っている台
        if (settled(st)) continue;
        unitKugiri = { unitIdx: u, stepTitle: s.title || '' }; break;                          // 次の区切り
      }
      if (settled(st)) continue;
      if (st === 'processing' || st === 'reworking') { skip = true; break; }                   // 誰かが手作業中
      unitItems.push({ stepId: s.id, stepTitle: s.title || '', unitIdx: u, targetSec: targetSecOf(s) });
    }
    if (skip) continue;
    unitItems.forEach((it) => { items.push(it); acc += it.targetSec || 0; if (it.targetSec == null) unknown = true; });
    if (unitKugiri && !kugiri) { kugiri = unitKugiri; secToKugiri = unknown ? null : acc; }   // 目標未設定が混じれば「出せない」
  }
  // 末尾のロット1回工程(最後の自動より後)。全台の自動が済んでいる時だけ
  const allAutoDone = lastAuto >= 0 && Array.from({ length: qty }, (_, u) => taskOf(tasks, steps[lastAuto], lastAuto, u)).every((t) => t && settled(t.status));
  if (!noAuto && allAutoDone) {
    steps.forEach((s, si) => {
      if (!s || !s.lotOnce || isAuto(s)) return;
      if (lastAuto >= 0 && si < lastAuto) return;
      if (firstAuto >= 0 && si <= firstAuto) return;
      const t = lotTaskOf(tasks, s); const st = t ? t.status : 'waiting';
      if (settled(st) || st === 'processing' || st === 'reworking') return;
      items.push({ stepId: s.id, stepTitle: s.title || '', unitIdx: null, targetSec: targetSecOf(s), lotOnce: true });
    });
  }
  return { items, kugiri, secToKugiri, measuredBefore };
}

// ---- 候補 ----------------------------------------------------------------------------------------

/**
 * 掛け持ちの候補。
 * @param {object} p
 * @param {Array} p.lots 全ロット
 * @param {object} p.currentLot 今開いているロット(自動測定が動いている)
 * @param {{workerId:string|null}} p.me 自分。workerId が無い(フリー・管理者)なら担当で絞らない
 * @param {number|null} p.remainingSec 自動測定の残り(秒)。null = 不明
 * @param {Array} p.zones settings.mapZones
 * @param {object|null} p.travel settings.opsim.zoneTravel(生)
 * @param {function} p.isAuto
 * @param {number} [p.maxItems=3]
 */
export function juggleCandidates({ lots = [], currentLot = null, me = {}, remainingSec = null, zones = [], travel = null, isAuto, maxItems = 3 } = {}) {
  if (typeof isAuto !== 'function' || !currentLot) return [];
  const myId = str(me && me.workerId) || null;
  const minTripSec = minTripWorkSecOf(travel);
  const out = [];
  (lots || []).forEach((lot) => {
    if (!lot || !lot.id || lot.id === currentLot.id) return;
    if (lot.status === 'completed' || lot.location === 'completed') return;
    if (lot.location === 'arrival') return;                                    // 入荷待ち(まだ工場に無い)
    if (myId && lot.workerId && str(lot.workerId) !== myId) return;            // 他の人の担当(取り合いにしない)
    if (!Array.isArray(lot.steps) || !lot.steps.length) return;
    if (manualRunningOn(lot, isAuto)) return;                                  // 誰かが手作業中
    const plan = planUntilKugiri({ lot, isAuto });
    if (!plan.items.length) return;
    const walk = walkSecOf({ a: currentLot.mapZoneId, b: lot.mapZoneId, zones, travel });
    const availableSec = remainingSec == null || walk.sec == null ? null : Math.max(0, remainingSec - walk.sec * 2);
    let acc = 0; let fitsCount = 0;
    for (const it of plan.items) { if (it.targetSec == null) break; acc += it.targetSec; if (availableSec != null && acc <= availableSec) fitsCount += 1; else break; }   // 未設定の工程で数えるのをやめる(決めつけない)
    const planSec = plan.items.reduce((a, it) => a + (it.targetSec || 0), 0);
    const planUnknown = plan.items.some((it) => it.targetSec == null);
    // 行く: 使える時間が「最低の手作業」以上。工程1つが丸ごと収まらなくても、途中まで進めて戻れる(lotPair.js の tripValueOf と同じ考え)
    const go = availableSec == null ? null : availableSec >= minTripSec;
    const reachKugiri = plan.kugiri && availableSec != null && plan.secToKugiri != null ? plan.secToKugiri <= availableSec : null;
    out.push({
      lotId: lot.id, orderNo: str(lot.orderNo), model: str(lot.model), dueDate: str(lot.dueDate),
      zoneId: str(lot.mapZoneId) || null, zoneName: zoneNameOf(zones, lot.mapZoneId), sameZone: !!(currentLot.mapZoneId && str(currentLot.mapZoneId) === str(lot.mapZoneId)),
      walkSec: walk.sec, walkSource: walk.source, walkWhy: walk.why,
      items: plan.items, planSec, planUnknown, fitsCount, availableSec, go, minTripSec,
      kugiri: plan.kugiri, secToKugiri: plan.secToKugiri, reachKugiri,
      inProgress: plan.measuredBefore, mine: !!(myId && str(lot.workerId) === myId), free: !lot.workerId,
    });
  });
  // 並び: ①行ける ②自分の担当 ③測定済みで進行中(交互に回している相手) ④片道が短い ⑤納期が近い
  const dueMs = (d) => { const t = Date.parse(String(d || '').replace(/[年月]/g, '/').replace(/[日（(].*$/, '')); return Number.isFinite(t) ? t : Infinity; };
  const goRank = (g) => (g === true ? 2 : g == null ? 1 : 0);
  out.sort((a, b) => (goRank(b.go) - goRank(a.go)) || (b.mine - a.mine) || (b.inProgress - a.inProgress)
    || ((a.walkSec ?? 9e9) - (b.walkSec ?? 9e9)) || (dueMs(a.dueDate) - dueMs(b.dueDate)));
  return out.slice(0, maxItems);
}

// ---- 自動終了の後追い(別のロットにいる間に時間が来た分) -------------------------------------------

/**
 * 自動終了の秒が過ぎた自動タスクを「完了」にする。終わりの時刻は **開始+自動終了の秒**(遡る)。
 *   🚨 前は endTime を「気づいた時刻(now)」にしていた。別のロットにいる間に時間が来ると、戻って開き直した時刻が終わりになり、
 *      作業セッション・機械の運転記録が実際より長く残っていた(掛け持ちした6分測定70回のうち13回が6.5分超・最大7.0分)。
 * @returns {{ tasks:object|null, ended:Array<{key,title,endTime}>, earliestEnd:number|null, latestEnd:number|null }} tasks は変化が無ければ null。latestEnd = 機械の運転記録を閉じる時刻
 */
export function autoCatchUp({ lot, tplSteps = [], now, isAuto, inspectorName = '' } = {}) {
  const steps = (lot && lot.steps) || []; const cur = (lot && lot.tasks) || {}; const qty = Math.max(1, Number(lot && lot.quantity) || 1);
  if (!now || !lot || lot.status === 'completed') return { tasks: null, ended: [], earliestEnd: null, latestEnd: null };
  let nt = null; const ended = [];
  const finish = (key, t, limitSec, title) => {
    const endTime = t.startTime + limitSec * 1000;
    if (!nt) nt = { ...cur };
    nt[key] = { ...t, status: 'completed', duration: (t.duration || 0) + limitSec, startTime: null, endTime,
      firstStartTime: t.firstStartTime || t.startTime, autoEnded: true, workerName: t.workerName || inspectorName || '' };
    ended.push({ key, title, endTime });
  };
  steps.forEach((step, sIdx) => {
    if (!step || (typeof isAuto === 'function' && !isAuto(step))) return;
    const limitSec = autoEndSecOf(step, tplSteps);
    if (!(limitSec > 0)) return;
    if (step.lotOnce && step.id) {
      Object.keys(cur).filter((k) => k.startsWith(`${step.id}-lot-`)).forEach((key) => {
        const t = cur[key];
        if (!t || t.status !== 'processing' || !t.startTime) return;
        if (now - t.startTime >= limitSec * 1000) finish(key, t, limitSec, step.title || '');
      });
      return;
    }
    for (let u = 0; u < qty; u += 1) {
      const idKey = step.id ? `${step.id}-${u}` : null; const numKey = `${sIdx}-${u}`;
      const key = (idKey && cur[idKey]) ? idKey : (cur[numKey] ? numKey : (idKey || numKey));
      const t = cur[key];
      if (!t || t.status !== 'processing' || !t.startTime) continue;
      if (now - t.startTime >= limitSec * 1000) finish(key, t, limitSec, step.title || '');
    }
  });
  const earliestEnd = ended.length ? Math.min(...ended.map((e) => e.endTime)) : null;
  const latestEnd = ended.length ? Math.max(...ended.map((e) => e.endTime)) : null;
  return { tasks: nt, ended, earliestEnd, latestEnd };
}

/** 秒 → 「m:ss」 */
export const fmtSec = (s) => { const n = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
