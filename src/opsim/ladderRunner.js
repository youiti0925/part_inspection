// =============================================================================
//  src/opsim/ladderRunner.js — 「効く手のはしご」の1段を実際に引き直す(製品検査)
// -----------------------------------------------------------------------------
//  🚨 計算は1行も持たない。既にある割付の入口
//     (src/workers/operationsSimulation.worker.js の runOperationsSimulationPipeline)
//     を、段ごとの条件で もう一度回すだけ。**新しい計算を書かない**(決まり23④)。
//
//  🚨 押した時だけ回る。自動では1回も回さない(4回ぶんの時間がかかるため)。
//     実測(2026-09-04・本番の写し633ロット・129件を計算・5営業日):
//       いまのまま 1.4秒 / 残業 1.0秒 / 土曜 1.0秒 / 両方 0.9秒 = 合計 4.3秒。
//
//  ⚠ 別スレッド(Worker)で回す。作れない端末ではこの場で回す(その間、画面は止まる)。
//    盤面が使っている Worker とは **別の物**を立てる。同じ物へ割り込むと、
//    盤面の計算が中止されて画面が空になる(worker は runId が変わると前の計算を捨てる)。
//
//  ⚠ 最終検査(golden)にも同じ役の物が在る。違うのは
//    ・呼ぶ Worker のファイル名 と 関数名
//    ・工場の暦を渡す口(製品は scenario.factoryCalendar / 最終は payload.factoryCalendar)
//    の2つだけ。純関数(rescueLadder.js)と画面(RescueLadder.jsx)は **同じ物**(md5 一致)。
// =============================================================================
import { docIdOf } from '../domain/soloDependency.js';
import { isOpenLot } from '../domain/dueDefense.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const nowStamp = () => (
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now() : Date.now()
);

/** 1段ぶんの上限(ミリ秒)。これを越えたら Worker を捨てて この場で回し直す。 */
const RUN_TIMEOUT_MS = 180000;

let w = null;
let seq = 0;
let broken = false;

/** はしご専用の Worker。🚨 盤面の Worker とは別に立てる(割り込ませない)。 */
function ensureWorker() {
  if (broken) return null;
  if (w) return w;
  try {
    w = new Worker(new URL('../workers/operationsSimulation.worker.js', import.meta.url), { type: 'module' });
    return w;
  } catch {
    broken = true;
    w = null;
    return null;
  }
}

/** はしごを閉じた時・画面を離れた時に呼ぶ。立てっぱなしにしない。 */
export function disposeLadderWorker() {
  if (w) { try { w.terminate(); } catch { /* 既に落ちている */ } }
  w = null;
}

/** Worker が作れない端末での道。🚨 別スレッドではない(その間、画面は止まる)。 */
async function runHere(payload) {
  const mod = await import('../workers/operationsSimulation.worker.js');
  return mod.runOperationsSimulationPipeline(payload, {
    yieldToHost: () => new Promise((r) => { setTimeout(r, 0); }),
  });
}

/** 1回ぶんの引き直し。Worker→駄目ならこの場、の順。 */
function runPayload(payload) {
  return new Promise((resolve, reject) => {
    const worker = ensureWorker();
    if (!worker) { runHere(payload).then(resolve, reject); return; }
    seq += 1;
    const runId = `rescue-ladder-${seq}`;
    let done = false;
    // ⚠ cleanup と onMsg が互いを参照するので、先に let で宣言してから代入する(no-use-before-define)。
    let onMsg = null; let onErr = null; let timer = null;
    const cleanup = () => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const fallback = () => {
      if (done) return;
      done = true;
      cleanup();
      disposeLadderWorker();
      runHere(payload).then(resolve, reject);
    };
    onMsg = (ev) => {
      const m = isObj(ev && ev.data) ? ev.data : null;
      if (!m || m.runId !== runId) return;   // 起動の合図(ready)や他の依頼は無視
      if (m.kind === 'result') {
        done = true; cleanup();
        if (m.ok) resolve(m.result);
        else reject(new Error(String(m.error || '引き直しに失敗しました')));
      } else if (m.kind === 'aborted') {
        done = true; cleanup();
        reject(new Error(String(m.reason || '中止しました')));
      }
    };
    onErr = () => { fallback(); };
    timer = setTimeout(fallback, RUN_TIMEOUT_MS);
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    try {
      worker.postMessage({ kind: 'run', runId, ...payload });
    } catch {
      fallback();
    }
  });
}

/** ロットを id で引ける形に(救えたロットの一覧で 型式・指図・納期 を出すため)。 */
export function lotsByIdOf(lots) {
  const m = new Map();
  (Array.isArray(lots) ? lots : []).forEach((l) => {
    const id = docIdOf(l);
    if (id) m.set(id, l);
  });
  return m;
}

/**
 * はしごの1段を引き直す。
 *
 * 🚨 段ごとに違うのは **3つだけ**:
 *   ① scenario へ重ねる残業(plan.scenarioPatch.overtimeExtraMinutes)
 *   ② 工場の暦(plan.factoryCalendar) … 土曜を出勤にした暦
 *   ③ 予測範囲の営業日数(plan.horizonDays) … どの段も **同じ実時刻の窓** を見るための数
 *      (土曜を足すと同じ 5 では窓が手前へ縮む。rescueLadder.js の workdaysToReach 参照)
 *
 * @returns {{normalized:object, simResult:object, tookMs:number}}
 */
export async function runLadderRung({
  plan,
  lots = [],
  templates = [],
  workers = [],
  settings = null,
  factoryCalendar = null,
  now,
  scenario = null,
  mode = null,
  estimateMode = 'P75',
  scopeFilter = null,
}) {
  if (!isObj(plan)) throw new Error('はしごの段が渡っていません');
  const base = isObj(scenario) ? scenario : {};
  const sc = {
    ...base,
    ...(isObj(plan.scenarioPatch) ? plan.scenarioPatch : {}),
    // 🚨 はしごは「遅れが何件消えるか」だけを見る。比べ物(全員万能)は回さない(その分だけ速い)。
    compareAllSkills: false,
    // 🚨 製品検査は暦を scenario の口で受ける(normalizeInput が settings より優先して読む)。
    //   null の時は settings.factoryCalendar が使われる＝登録どおり。
    factoryCalendar: plan.factoryCalendar || factoryCalendar || null,
  };

  const scopeLotIds = [];
  const pick = typeof scopeFilter === 'function' ? scopeFilter : null;
  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    if (!isOpenLot(lot)) return;
    if (pick) { let ok = false; try { ok = !!pick(lot); } catch { ok = false; } if (!ok) return; }
    const id = docIdOf(lot);
    if (id) scopeLotIds.push(id);
  });
  scopeLotIds.sort();

  const merged = isObj(settings)
    ? { ...settings, factoryCalendar: factoryCalendar || settings.factoryCalendar || null }
    : (factoryCalendar ? { factoryCalendar } : {});

  const payload = {
    lots, templates, workers,
    settings: merged,
    now,
    horizonDays: plan.horizonDays,
    scenario: sc,
    mode,
    estimateMode,
    scenarioId: `rescue-${plan.key}`,
    scopeLotIds,
    // 🚨 段どうしで同じ鍵。過去の作業記録の集計(重い方)を1回で済ませる。
    dataKey: `rescue-ladder|${lots.length}|${templates.length}|${workers.length}`,
  };

  const t0 = nowStamp();
  const res = await runPayload(payload);
  const tookMs = nowStamp() - t0;
  return { normalized: res && res.normalized ? res.normalized : null, simResult: res && res.base ? res.base : null, tookMs };
}

export default runLadderRung;
