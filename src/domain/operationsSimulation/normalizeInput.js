// ============================================================================
// 🧭 操業シミュレーター — 生のフィールド名を知っている「唯一の」ファイル
// ----------------------------------------------------------------------------
// 正: docs/製品検査_操業シミュレーター_完全是正実装仕様書_2026-08-23.md
//     5.1(単一ポリシー) / 5.3(納期線) / 5.4(到着状態) / 5.5(作業者能力) / 6.4(この節)
//
// 🚨 `dueDate` / `entryAt` / `location` / `quantity` / `tasks` / `steps` /
//    `workerRoster` / `customTargetTimes` といった **生の名前をここから先へ漏らさない**。
//    下流(buildJobs / priority / simulate / explain)は、この戻り値の名前しか知らない。
//
// ⚠ここには React も Firebase も import しない (node --test で回すため)。
// 🚨 関数の中で Date.now() / new Date()(引数なし) / Math.random() を呼ばない。
//    現在時刻は必ず引数 `now` で受ける (同じ入力 → 同じ結果 = S23)。
//
// ----------------------------------------------------------------------------
// 【2026-08-23 の是正で変えた事】仕様書6.4 の「削除または置換」5点
//   1. 勤務表(computeWorkHours)から通常能力を作る処理を削除。
//      1人1日の直接作業時間は policy.js ただ1つが持つ(仕様書5.1 / D01)。
//      🚨 勤務表 08:30-17:00 から休憩を引いた440分は **420分の根拠にしない**。
//   2. 間接係数で直接能力を割る処理を削除。この語はこのファイルにもう1つも無い(T001)。
//   3. 到着予定時刻が過去なら手元にあると見なす処理を削除。
//      物理場所が到着エリアのままなら現物未確認 = 人を付けない(仕様書5.4 / D06 / T009)。
//   4. 納期の時刻を真夜中へ丸める処理を削除。日付だけの納期は、その日の
//      通常勤務終了時刻へ calendar.js の resolveDueAt が解決する(仕様書5.3 / D04 / T007)。
//   5. 名前付き作業者と旧 workloadEffectiveWorkers を同時に計算へ使う処理を削除。
//      計算は名前付きが正。旧設定との食い違いは警告として返す(仕様書5.5 / D07 / T011)。
//
// ----------------------------------------------------------------------------
// 【実データで確かめた事】2026-08-11 バックアップ product-inspection-v1 (ロット468件)
//   lot.steps      … **配列** 468/468。契約書は「マップ」と書いているが、実バックアップは配列だった。
//                    → 両方受ける (マップの時はキーの数値順)。index は **元の位置** を保つ。
//                      旧データのタスク鍵 `${工程の並び順}-${台}` がこの位置に依存しているため。
//   lot.tasks      … マップ 468/468 (配列は0件)。鍵は `${step.id}-${台}` 5145件 /
//                    `${step.id}-lot-${回}` 466件。
//   lot.location   … arrival 142 / completed 320 / planned 6
//   lot.dueDate    … 364/468 に有り。**予定日であって守るべき納期ではない**
//                    (完了実績の53.7%がこの日を過ぎている)。→ dueKind:'planned'
//   lot.entryAt    … 468/468 に有り。到着待ち142件のうち138件が 08:30 ちょうど。
//   step.category  … **0件**。よって目標時間の鍵は `_タイトル` に退化する (App.jsx と同じ)。
//   step.checkType … **0件**(製品検査には無い印)。ロット1回は step.lotOnce 752件。
//   step.targetTime… 0以下が25件 → 見積り無しへ。**60秒などを入れない**(S16 / T030)。
//   settings       … workSchedule **無し** / modelGroups **無し** /
//                    workloadEffectiveWorkers=3 / workerRoster 有り /
//                    設備の設定は46キー中 **0件** → equipmentUnmodeled:true(仕様書D21)
//
// ----------------------------------------------------------------------------
// 【戻り値の中の配列の中身】契約書が形を書いていない所。下流はこの通りに読む事。
//   unknowns.dueUnknown       : lotId(文字列)の配列
//   unknowns.arrivalUnknown   : lotId(文字列)の配列
//   unknowns.arrivalOverdue   : lotId(文字列)の配列 ← 2026-08-23 追加(仕様書5.4)
//   unknowns.durationUnknown  : { lotId, stepId, title } の配列
//   unknowns.templateMissing  : templateId(文字列)の配列
//   lot.unknowns              : 'dueUnknown'|'arrivalUnknown'|'arrivalOverdue'
//                               |'durationUnknown'|'templateMissing'|'noSteps' の配列
//   lot.doneTaskKeys          : task の鍵(文字列)の配列。昇順。
// ============================================================================

// 🚨 残り時間の判定は自作しない。「もう時間がかからない」の判定は
//    lotRemaining.js ただ1つ。ここで別の条件を書くと、画面の進捗% と
//    シミュレーターの残り仕事が食い違う。
import { isDoneTask } from '../lotRemaining.js';
// 納期の読み取りと未完了判定は既存の共通関数をそのまま使う。
//   dueMsOfLot   … `Mon Jun 08 2026 ...` 形式25件を取りこぼさない救済入り。
//                  ⚠ **その日の0時** を返す。時刻の解決は resolveDueAt に任せる(仕様書5.3)。
//   isOpenLot    … status だけで数えると1件多い(location==='completed' がある)
import { dueMsOfLot, isOpenLot, DEFAULT_WORK_SCHEDULE } from '../dueDefense.js';
// 工程の身元。🚨 historyEligibility が使う鍵と **同じ形** でないと突き合わせが0件になる。
import { processKeyOf, docIdOf } from '../soloDependency.js';
// ロットに1回だけの工程か。製品検査の lotOnce と最終検査の checkType:'count' を両方見る共通判定。
import { isOncePerLotStep } from '../finishEta.js';
// 🚨 1人1日の直接作業分数は policy.js だけが決める(仕様書5.1 / 6.2 / T001 / T002)。
import { resolveOperationPolicy, resolveWorkerDayMinutes } from './policy.js';
// 🚨 納期の時刻の解決は calendar.js だけが決める(仕様書5.3 / 6.3 / T007 / T008)。
// 👤 人ごとの勤務の窓(settings.workerProfiles)の読み方も calendar.js ただ1本(2026-09-05)。
//   ここでは「名簿に居る人の分だけ読んで calendarSpec へ写し、読めなかった値の警告を並べる」だけ。
import { resolveDueAt, normalizeWorkerProfiles, makeCalendar } from './calendar.js';
// 📅 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)。純関数だけ。
// 🚨 稼働日を「曜日だけ」で決めていた所を、この1本へ寄せる(2026-09-02)。
import { makeIsWorkday, calendarFingerprint } from '../factoryCalendar.js';
// 仕様書6.4 の戻り値に jobs が要る。buildJobs は normalized.lots しか読まない純関数。
import { buildJobs } from './buildJobs.js';
// 🚨 工数の見積りは estimate.js だけが決める(仕様書5.6 / 6.5 / F1)。
//   ここで実績を集め直さない(集め方が2つになると数字が食い違う)。
import {
  estimateDuration, ESTIMATE_MODE as EST_MODE, DEFAULT_ESTIMATE_MODE,
} from './estimate.js';
// 🚨 入荷日の件数(仮に置いた分・入れていない分)と、画面へ出す文は
//   arrivalAccounting.js **1か所**で作る。ここでも画面でも数え直さない。
//   数え直していたせいで「帯3件・カード4件」が出ていた(2026-09-01 矛盾B)。
import { buildArrivalAccounting, arrivalSentences } from './arrivalAccounting.js';
// ── 🆕 2026-09-10 「実際の生産に近い状態で」の配線(全部 既定 OFF) ─────────────
// 🚨 4本とも **渡されなければ1行も動かない**。読み方(分・台数・営業日)はそれぞれの
//   純関数ただ1本に任せ、ここでは時刻の引き算も台数の割り算も1つも書かない。
//   ・arrivalHabit    … 到着予定を班のクセぶんずらす(scenario.arrivalHabitMode)
//   ・splitArrivalLoad… 1指図が数便に分かれて着く時、台ごとの「着く時刻」を作る
//   ・shipDeadline    … 出荷日から逆算した本当の締切。**既存の納期線(dueLineMs)は変えない**
//   ・workerAvailability … 曜日ごとの窓・有給/半休/出張/会議は calendar.js が効かせる
//     (ここは calendarSpec に「切ってあるか」の1つの合図を写すだけ)
import { applyArrivalHabit, HABIT_MODE, habitWhyLabel } from './arrivalHabit.js';
import { splitArrivalLoad } from './splitArrivalLoad.js';
import { resolveDeadlines } from './shipDeadline.js';
// 🔧 設備: 工程の鍵の形と「どの設備か」の読み方は equipmentCapacity.js ただ1本(ここで鍵を作らない)。
import { equipmentIdOfStep, equipmentStepKeyOf, equipmentCapOf } from './equipmentCapacity.js';
// 👥 分担の区切り。読める字だけ通す作法は handoff.js ただ1本(ここで読み替えない)。
import { HANDOFF_MODE, normalizeHandoffMode } from './handoff.js';
// 🧵 優先度の区分の番号(緊急0/特注1/通常2)。番号と呼び名は lotFocus.js ただ1本。
import { PRIORITY_CLASS } from './lotFocus.js';
// 📌 2026-09-15 手で決めた担当(ロットの固定)。形は lotPins.js。門を掛けるのは simulate.js
import { normalizePins } from './lotPins.js';

/**
 * 🧵 lot.priority(字) → 優先度の区分(番号)。**読み替えはここ1か所**(2026-09-10 清水さん)。
 *   'urgent' … 緊急(0)  'special' … 特注(1)  'normal' … 通常(2)
 *   🚨 旧 'high'(急ぎ)は 'urgent' と読む(本番の写しは 577件 normal・2件 undefined で 'high' は0件だが、
 *     画面の旧い選択肢が書いた物を「通常」へ落とすと急ぎが黙って消える)。
 *   読めない字・空・数・真偽は 通常(2)。勝手に「もっと先」を作らない。
 * @param {*} raw lot.priority
 * @returns {0|1|2}
 */
export const priorityClassOf = (raw) => {
  const s = (typeof raw === 'string') ? raw.trim().toLowerCase() : '';
  if (s === 'urgent' || s === 'high') return PRIORITY_CLASS.URGENT;
  if (s === 'special') return PRIORITY_CLASS.SPECIAL;
  return PRIORITY_CLASS.NORMAL;
};

/**
 * 入荷Excel取込が作った entryAt を見分けるための「何日前」の候補。
 * 実装(App.jsx の入荷Excel取込)が書くのは **3** ただ1つ:
 *     const d = 納期日の Date; d.setHours(8,30,0,0); d.setDate(d.getDate() - 3);
 * 2026-08-22 の本番実測では 3日前197件 / 2日前41件 / 1日前38件 が出ているので、
 * 1 と 2 も候補に入れる。呼ぶ側は scenario.derivedArrivalDaysBefore で差し替えられる。
 */
export const DERIVED_ARRIVAL_DAYS_BEFORE = Object.freeze([3, 2, 1]);

/**
 * 稼働日の既定。仕様書3章「月曜〜金曜」。
 * 🚨 2026-09-02: これは **週の形** だけ。祝日・年末年始・お盆・全社休業・休日出勤は
 *   settings.factoryCalendar(共通の棚 contact-shared-v1 から来る工場の暦)が持ち、
 *   下の worksOnDay で1日ずつ上書きする。**登録が空ならここだけで決まる = 今までと同じ**。
 */
export const DEFAULT_WORKDAYS = Object.freeze([1, 2, 3, 4, 5]);

/**
 * 到着状態(仕様書5.4)。物理的な場所と予定時刻を混ぜない。
 *   inShop         … 到着エリア以外に居る = 手元。今から着手できる
 *   scheduled      … 到着エリアに居て、予定時刻がこれから。予定時刻以降に着手できる
 *   arrivalOverdue … 到着エリアに居て、予定時刻が過ぎた。**現物未確認**。着手させない
 *   arrivalUnknown … 到着エリアに居て、予定が無い。着手させない
 */
export const ARRIVAL_STATE = Object.freeze({
  IN_SHOP: 'inShop',
  SCHEDULED: 'scheduled',
  OVERDUE: 'arrivalOverdue',
  UNKNOWN: 'arrivalUnknown',
});

/**
 * 工数見積りの出どころ(仕様書5.6 の簡略版)。
 * ⚠ P50/P75/P90 と確定実績からの推定は estimate.js(C4)で作る。C1 の今は
 *   「管理者が入れた較正値」と「テンプレートの目標時間」の2つしか無い。
 *   目標時間は測った値ではないので、信頼度を high と言わない(仕様書D20 / T029)。
 */
export const ESTIMATE_SOURCE = Object.freeze({
  CALIBRATED: 'calibrated',
  TEMPLATE_TARGET: 'template-target',
  MISSING: 'missing',
});

/** C1 の見積りモード。C4 で 'P50' | 'P75' | 'P90' が入る。 */
export const ESTIMATE_MODE = 'template-target';

/** 渡された見積りモードを P50/P75/P90 のどれかに正す。知らない値は既定へ。 */
const resolveEstimateMode = (v) => (EST_MODE[v] !== undefined || v === 'P50' || v === 'P75' || v === 'P90'
  ? (v === 'P50' || v === 'P75' || v === 'P90' ? v : DEFAULT_ESTIMATE_MODE)
  : DEFAULT_ESTIMATE_MODE);

/** 日付をまたぐループの安全弁。これを超えたら諦めてその時点の値を返す(固まらせない)。 */
const MAX_DAY_STEPS = 4000;

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const numOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const pad2 = (n) => String(n).padStart(2, '0');

/** 'HH:MM' → {h, m}。読めない時は null (推測で真夜中を入れない)。 */
const splitHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(s).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, m: mi };
};

/** 'YYYY-MM-DD'。UTC へ寄せると1日ずれるので getFullYear 系で作る。 */
const ymdOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** その実時刻の「ローカルのその日の0時」。 */
const startOfDayMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 翌日の0時。月末・年末はこちらで数えない。 */
const nextDayMs = (ms) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 稼働日で n 日ぶん進めた(負なら戻した)実時刻。時刻(時分秒)はそのまま持ち越す。
 * ⚠ n=0 は「動かさない」。土日に落ちていても翌営業日へ寄せない
 *   (寄せると納期線が勝手に後ろへ動いて、遅れが少なく見える)。
 * 🚨 2026-09-02: 稼働日の判定は worksOn(工場の暦を畳んだ物)ただ1つに通す。
 *   曜日だけで数えていた頃は、祝日を1営業日と数えて納期線が実際より後ろに立っていた。
 * @param {(ms:number)=>boolean} worksOn 稼働日か。渡さない時は暦日として数える(従来と同じ逃げ道)
 */
const addWorkdays = (ms, n, worksOn) => {
  const steps = Math.trunc(numOr(n, 0));
  if (steps === 0) return ms;
  const dir = steps > 0 ? 1 : -1;
  // 稼働日が1日も無い指定は、数え続けると止まらない。暦日として数える。
  const countAll = typeof worksOn !== 'function';
  const d = new Date(ms);
  let left = Math.abs(steps);
  let guard = 0;
  while (left > 0 && guard < MAX_DAY_STEPS) {
    d.setDate(d.getDate() + dir);
    guard += 1;
    if (countAll || worksOn(d.getTime())) left -= 1;
  }
  return d.getTime();
};

/**
 * 「納期日の始業時刻から N 暦日前」の実時刻。
 * 🚨 **営業日ではなく暦日**。App.jsx の入荷Excel取込がそう書いているし、
 *   実測でも到着待ち142件のうち32件が日曜・18件が土曜に落ちている(土日を飛ばしていない)。
 */
const derivedArrivalMs = (dueDayMs, daysBefore, hhmm) => {
  const t = splitHHMM(hhmm);
  if (t == null) return null;
  const d = new Date(dueDayMs);
  d.setHours(t.h, t.m, 0, 0);
  d.setDate(d.getDate() - daysBefore);
  return d.getTime();
};

/**
 * 納期の値に「時刻」が書いてあるか。書いていなければ日付だけ。
 * 🚨 真夜中(0:00:00)は「時刻を書いた」と見なさない。書き手が時刻を入れていない印であり、
 *   ここを時刻ありとして通すと、その日の仕事を前日までに終える計算に戻る(仕様書D04)。
 * ⚠ 文字列からは **書いてある壁時計の数字** をそのまま取る。時差の付いた文字列
 *   (`Mon Jun 08 2026 09:00:00 GMT+0900`)も、現場が読む時刻は 09:00 だから。
 */
const explicitTimeOf = (raw) => {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 100000) {
    const d = new Date(raw);
    const h = d.getHours();
    const mi = d.getMinutes();
    const s = d.getSeconds();
    return (h || mi || s) ? { h, m: mi, s } : null;
  }
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(str(raw));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  if (h === 0 && mi === 0 && s === 0) return null;
  return { h, m: mi, s };
};

/**
 * ロットの工程を「元の並び位置つき」で取り出す。
 * 配列(実バックアップ468/468)とマップ(契約書の記載)の両方を受ける。
 * 🚨 index を詰め直さない。旧データのタスク鍵 `${並び位置}-${台}` がこの数字に依存している。
 */
const stepEntriesOf = (rawSteps) => {
  if (Array.isArray(rawSteps)) {
    return rawSteps.map((step, index) => ({ index, step })).filter((e) => isObj(e.step));
  }
  if (isObj(rawSteps)) {
    return Object.keys(rawSteps)
      .filter((k) => /^\d+$/.test(k))
      .map(Number)
      .sort((a, b) => a - b)
      .map((index) => ({ index, step: rawSteps[String(index)] }))
      .filter((e) => isObj(e.step));
  }
  return [];
};

/**
 * 目標時間の較正値を引く時の工程の鍵。App.jsx の targetTimeStepKey と1字も変えない。
 * ⚠ step.category は実測0件なので、実際は `_タイトル` になる。
 */
const targetTimeStepKey = (step) => `${step?.category || ''}_${step?.title || ''}`;

/**
 * その工程1台(または1回)あたりの見積り秒と、その出どころ。
 * 🚨 App.jsx の getEffectiveTargetTime と **同じ順**:
 *      ① 型式別の較正値 customTargetTimes[`model_${型式}`][`${分類}_${題}`]
 *      ② 同じ型式グループの別型式の較正値
 *      ③ テンプレ既定 step.targetTime
 *    順を変えると、画面に出ている目標時間とシミュレーターの見積が食い違う。
 * ⚠ ①② は管理者が入れた較正値なので仕様書5.6 の1位(calibrated)。
 *   ③ は目標であって測った値ではないので、信頼度を high と言わない。
 */
const estimateOf = (step, model, customTargetTimes, modelGroups) => {
  if (model && isObj(customTargetTimes)) {
    const sk = targetTimeStepKey(step);
    const own = customTargetTimes[`model_${model}`]?.[sk];
    if (typeof own === 'number' && own > 0) {
      return { sec: own, source: ESTIMATE_SOURCE.CALIBRATED, confidence: 'high' };
    }
    const groups = asArray(modelGroups);
    const g = groups.find((gr) => Array.isArray(gr?.models) && gr.models.includes(model));
    if (g) {
      for (const sibling of g.models) {
        if (sibling === model) continue;
        const v = customTargetTimes[`model_${sibling}`]?.[sk];
        if (typeof v === 'number' && v > 0) {
          return { sec: v, source: ESTIMATE_SOURCE.CALIBRATED, confidence: 'high' };
        }
      }
    }
  }
  const target = numOr(step?.targetTime, 0);
  if (target > 0) {
    return { sec: target, source: ESTIMATE_SOURCE.TEMPLATE_TARGET, confidence: 'low' };
  }
  // 🚨 T030: 60秒などを入れない。0 も入れない。分からないまま原因へ出す。
  return { sec: null, source: ESTIMATE_SOURCE.MISSING, confidence: 'unknown' };
};

/** 休みの表(日付 → 名前 → 'off'|'other')を、文字列の値だけ拾って写す。 */
const copyAbsences = (src) => {
  const out = {};
  if (!isObj(src)) return out;
  for (const dateKey of Object.keys(src).sort()) {
    const day = src[dateKey];
    if (!isObj(day)) continue;
    const row = {};
    for (const name of Object.keys(day).sort()) {
      const v = day[name];
      if (typeof v === 'string' && v) row[name] = v;
    }
    if (Object.keys(row).length > 0) out[dateKey] = row;
  }
  return out;
};

/** 2枚の休みの表を重ねる(後勝ち)。シナリオの「この人をこの日休みにする」を効かせるため。 */
const mergeAbsences = (base, extra) => {
  const out = copyAbsences(base);
  const add = copyAbsences(extra);
  for (const dateKey of Object.keys(add)) {
    out[dateKey] = { ...(out[dateKey] || {}), ...add[dateKey] };
  }
  return out;
};

/**
 * 入力指紋の元になる安定ハッシュ(仕様書6.10「SHA-256または同等の安定ハッシュ」)。
 * 🚨 WebCrypto の digest は非同期で、node:crypto はブラウザの Worker で動かない。
 *   ここは同期・依存なしで足りるので、32bit を2本回して64bitぶんの16進を作る。
 *   乱数も現在時刻も使わないので、同じ文字列からは必ず同じ値が出る(S23)。
 */
const stableHash = (text) => {
  const s = String(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i + 1) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

/**
 * 既存データを、シミュレーターが読む共通の形へ変換する。
 *
 * @param {Object}   o
 * @param {Array}    o.lots        アプリが既に読み込んでいるロット配列(新しい購読は足さない)
 * @param {Array}    o.templates   テンプレ配列。工程は各ロットに焼かれているので、有無の確認だけに使う
 * @param {Array}    o.workers     作業者名簿
 * @param {Object}   o.settings    設定1件(config)
 * @param {number}   o.now         現在時刻(epoch ms)。🚨 必須。中で Date.now() を呼ばない
 * @param {number}   [o.horizonDays=5]  何営業日ぶん先まで見るか
 * @param {Object}   [o.scenario]  overtime / dueOffsetWorkdays / workdays / absences /
 *                                 derivedArrivalDaysBefore
 * @returns {Object} 仕様書6.4 の形
 */
export function normalizeInput({
  lots, templates, workers, settings, now, horizonDays = 5, scenario = {},
  // 🚨 確定実績の統計(estimate.buildDurationStats の戻り値)。
  //   ⚠ **全ロット**(完了ロット込み)から作った物を呼ぶ側が渡す。
  //     ここで作らないのは、normalizeInput が受け取る lots が
  //     「範囲で絞った後」の物だからで、絞った物から実績を集めると標本が消える。
  //   渡されなければ実績を使わない(較正値→目標時間→不明 の従来どおり)。
  durationStats = null,
  // 見積りモード。P50(通常線) / P75(保険線) / P90(絶対線)。既定は P75。
  estimateMode = DEFAULT_ESTIMATE_MODE,
  /**
   * 🚫 記録でほぼ毎回飛ばす工程(skipHistory.js の keys)。2026-09-18 清水さん「該当なしなんでしょ、作業がないだけだから飛ばしてやるだけでしょ？」
   *   → 既定では仕事に積まない(0分で飛ばす見込み)。scenario.countAlwaysSkipped:true で積む側へ切り替えられる(最終検査と同じ口)。
   *   🚨 積まなかった数は inputQuality.alwaysSkipped に必ず出す(黙って消さない)。渡されなければ1行も動かない。
   */
  alwaysSkippedProcessKeys = null,
  // ── 🆕 2026-09-10 「実際の生産に近い状態で」の入口。**4つとも既定 null = 今までと同じ** ──
  //   🚨 データを渡しただけでは1ミリも動かない。効かせるのは scenario の合図(下の realism)。
  //     データと合図を分けてあるのは、「渡したのに効いていない」と「効かせたのにデータが無い」を
  //     混ぜない為(効かせたのにデータが無い時は warnings に1行出す)。
  /**
   * 🚚 入荷の遅れのクセ。
   * @type {null | { habit: object, groupByLot?: object, useAllWhenGroupUnknown?: boolean }}
   *   habit      … arrivalHabit.buildArrivalHabit() の戻り値
   *   groupByLot … { [lotId]: 班 }。無い時は lot.arrivalGroup / lot.group を見る
   *   ⚠ 班が分からない予定は動かさない(applyArrivalHabit が 'noGroup' で素通りする)
   */
  arrivalHabit = null,
  /**
   * 👤 曜日ごとの窓・その日の予定・残業。
   * @type {null | { profiles?: object }}
   *   profiles … settings.workerProfiles を差し替えたい時だけ(渡さなければ設定をそのまま読む)
   *   ⚠ 読み方は calendar.js → workerAvailability.js の1本。ここでは読み直さない。
   */
  workerAvailability = null,
  /**
   * 📦 分納(1指図が数便に分かれて着く)。
   * @type {null | { byLot: object }} byLot … { [lotId]: arrival_times/{lotId} の中身 }
   */
  splitArrival = null,
  /**
   * 🚚 出荷日。
   * @type {null | { shipByLot?: object }}
   *   shipByLot … { [lotId]: 'YYYY-MM-DD' }。lot.shipDate が入るまでの外からの口
   *   🚨 「効かせるか」と「何営業日前か」は scenario.shipDeadline = { on, leadDays } **だけ** が持つ
   *     (2026-09-10)。ここに leadDays を書いても読まない(2か所で違う日数を持たない)。
   */
  shipDeadline = null,
}) {
  const nowMs = Number(now);
  const estMode = resolveEstimateMode(estimateMode);
  if (!Number.isFinite(nowMs)) {
    // 🚨 ここで現在時刻に落とすと「同じ入力 → 同じ結果」(S23)が壊れる。黙って落とさない。
    throw new Error('normalizeInput: now(現在時刻ms)を引数で渡してください。同じ入力から同じ結果を出すためです');
  }
  const sc = isObj(scenario) ? scenario : {};
  // 🚫 記録でほぼ毎回飛ばす工程(2026-09-18)。積まなかった数を必ず出す。
  const skipOnlySet = new Set(
    (Array.isArray(alwaysSkippedProcessKeys)
      ? alwaysSkippedProcessKeys
      : (alwaysSkippedProcessKeys instanceof Set ? [...alwaysSkippedProcessKeys] : []))
      .map(str).filter(Boolean),
  );
  const countAlwaysSkipped = sc.countAlwaysSkipped === true;
  const applyAlwaysSkipped = skipOnlySet.size > 0 && !countAlwaysSkipped;
  let alwaysSkippedStepCount = 0;
  let alwaysSkippedMinutesByTarget = 0;
  const alwaysSkippedLots = new Set();
  const cfg = isObj(settings) ? settings : {};

  // ── 🆕 「実際の生産に近い状態で」の合図(全部 既定 OFF) ──────────────────────
  // 🚨 ここが唯一の入り口。**scenario に何も書かなければ4つとも切ってある** =
  //   清水さんが何も設定していない状態の答えは1ミリも変わらない。
  // ⚠ 合図が立っているのにデータが無い時は、黙って素通りせず警告を1行残す
  //   (「ONにしたのに何も起きない」を誰も見つけられない、を作らない)。
  const realismWarnings = [];
  // 🚨🚨 2026-09-10 scenario の鍵の約束(画面が書き、エンジンが読む。**この名前以外を読まない**):
  //   workerAvailabilityOn / arrivalHabitMode + arrivalHabit / splitArrivalOn + splitArrival /
  //   shipDeadline:{on,leadDays} / equipmentCapacity:{capacity,stepEquipment}
  //   実績の表は **scenario に載って Worker を越えて来る**(structured clone で渡せる生の値)。
  //   関数の引数(arrivalHabit / splitArrival / shipDeadline)は 直接呼ぶ側(試験・道具)の口として残すが、
  //   scenario に同じ鍵が在れば scenario が勝つ(2か所で違う物を渡した時に画面の値が勝つ)。
  /** 🚚 到着のクセ: 'off'(既定) | 'median' | 'p75' */
  const arrivalHabitMode = (sc.arrivalHabitMode === HABIT_MODE.MEDIAN || sc.arrivalHabitMode === HABIT_MODE.P75)
    ? sc.arrivalHabitMode : HABIT_MODE.OFF;
  // scenario.arrivalHabit は buildArrivalHabit の戻り(表そのもの: byGroup / all / pairs)か、
  //   { habit, groupByLot?, useAllWhenGroupUnknown? } の包み。どちらでも読む(表の形は作らない)。
  const arrivalHabitSrc = (() => {
    const x = sc.arrivalHabit;
    if (isObj(x)) {
      if (isObj(x.habit)) return x;
      if (isObj(x.byGroup) || isObj(x.all)) return { habit: x };
    }
    return isObj(arrivalHabit) ? arrivalHabit : null;
  })();
  const arrivalHabitTable = (arrivalHabitMode !== HABIT_MODE.OFF && arrivalHabitSrc && isObj(arrivalHabitSrc.habit))
    ? arrivalHabitSrc.habit : null;
  const arrivalHabitGroupByLot = (arrivalHabitSrc && isObj(arrivalHabitSrc.groupByLot)) ? arrivalHabitSrc.groupByLot : null;
  const arrivalHabitUseAll = !!arrivalHabitSrc && arrivalHabitSrc.useAllWhenGroupUnknown === true;
  if (arrivalHabitMode !== HABIT_MODE.OFF && !arrivalHabitTable) {
    realismWarnings.push('到着のクセを使う設定になっていますが、過去の到着の記録が渡されていません。到着予定は1件も動かしていません');
  }
  /** 👤 曜日ごとの窓・その日の予定を暦に効かせるか(既定 false) */
  const workerAvailabilityOn = sc.workerAvailabilityOn === true;
  /** 📦 分納で台ごとに着く時刻を分けるか(既定 false) */
  const splitArrivalOn = sc.splitArrivalOn === true;
  const splitArrivalSrc = (isObj(sc.splitArrival) && isObj(sc.splitArrival.byLot))
    ? sc.splitArrival : (isObj(splitArrival) ? splitArrival : null);
  const splitArrivalByLot = (splitArrivalOn && splitArrivalSrc && isObj(splitArrivalSrc.byLot))
    ? splitArrivalSrc.byLot : null;
  if (splitArrivalOn && !splitArrivalByLot) {
    realismWarnings.push('分納で分ける設定になっていますが、到着予定の記録(便の一覧)が渡されていません。今までどおり1回で全台が着く形で数えています');
  }
  /**
   * 🚚 出荷日から本当の締切を出すか(既定 false)。
   * 🚨 2026-09-10: 鍵は scenario.shipDeadline = { on, leadDays } **ただ1つ**。
   *   旧い「On の合図」と「LeadDays の日数」の2鍵は読まない(互換も残さない。画面側が同時に直した)。
   *   ChatGPT が見つけた④: 画面は日数を別の鍵に書き、ここは shipDeadline.leadDays を
   *   読んでいたので日数が一度も届いていなかった。1つの鍵にして食い違いの余地を消す。
   * ⚠ 関数の引数 shipDeadline は shipByLot(lot.shipDate が入るまでの外からの口)だけを運ぶ。
   */
  const shipDeadlineSc = isObj(sc.shipDeadline) ? sc.shipDeadline : null;
  const shipOn = !!shipDeadlineSc && shipDeadlineSc.on === true;
  const shipByLot = (shipOn && isObj(shipDeadline) && isObj(shipDeadline.shipByLot))
    ? shipDeadline.shipByLot : null;
  const shipLeadDays = (() => {
    if (!shipOn) return 0;
    const raw = shipDeadlineSc.leadDays;
    const v = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : 0;
    return (Number.isFinite(v) && v >= 0) ? v : 0;
  })();
  /**
   * 🔧 設備の台数(ChatGPT が見つけた③)。
   * 🚨 いままで各工程の equipmentId を null に焼き込んでいたので、設備の定員を設定しても
   *   仕事に設備が付かず、門(simulate.js の busyEquipment)が素通りしていた。
   *   → scenario.equipmentCapacity.stepEquipment(工程の鍵→設備id)で引く。
   *   鍵の形は equipmentCapacity.js の equipmentStepKeyOf ただ1本(ここで作らない)。
   * 🚨 分からない物を塞がない: **上限を決めた設備だけ** 仕事に付ける。
   *   上限の無い設備の id を付けると、S10 の門(1件ずつ)が「1台」と決めつけて塞ぐ。
   * ⚠ 渡されなければ(既定) 索引は空 = 今までどおり全部 null。
   */
  /**
   * 👥 分担の区切り(2026-09-10 清水さん「分担するときはできたら一台毎で区切る感じじゃないとだめ」)。
   * 🚨 鍵は scenario.handoff ただ1つ。'none'(既定) | 'soft' | 'unit'。
   *   読める字だけ通す(true / 1 / 'UNIT' は 'none')。読み替えの作法は handoff.js が持つ。
   * 🚨 ここは **写して渡すだけ**。門を掛けるのは simulate.js ただ1本。
   */
  const handoffMode = normalizeHandoffMode(sc.handoff);

  /**
   * 🧵 ロットは持ったら最後まで / 優先度の区分(2026-09-10 清水さん「ロット処理して次のロットでいいでしょ」
   *   「優先度で通常と特注と緊急にして…シミュレーション時の優先度に反映」)。
   * 🚨 鍵は scenario.lotFocus === true / scenario.priorityClass === true **ただ2つ**。
   *   true 以外(1 / 'on' / 'true')は「立っていない」。読み替えない。
   * 🚨 ここは **写して渡すだけ**。続きを配るのは simulate.js、並びの先頭の鍵は priority.js。
   *   区分の番号(lot.priorityClass)は合図に関わらず **いつも** 付ける(事実なので)。効かせるのは合図だけ。
   */
  const lotFocusOn = sc.lotFocus === true;
  const priorityClassOn = sc.priorityClass === true;

  const equipmentBySc = isObj(sc.equipmentCapacity) ? sc.equipmentCapacity : null;
  const equipmentCapacityTable = (equipmentBySc && isObj(equipmentBySc.capacity)) ? equipmentBySc.capacity : null;
  const equipmentIdByStepKey = new Map();
  if (equipmentBySc && isObj(equipmentBySc.stepEquipment) && equipmentCapacityTable) {
    for (const [k, v] of Object.entries(equipmentBySc.stepEquipment)) {
      const key = str(k).trim();
      const id = str(v).trim();
      if (key && id && equipmentCapOf(equipmentCapacityTable, id) != null) equipmentIdByStepKey.set(key, id);
    }
  }
  /** 工程1件の設備id。索引に無ければ その工程自身の欄(workResource)を equipmentIdOfStep で読む。上限の無い設備は null。 */
  const equipmentIdForStep = (templateId, stepId, step) => {
    if (!equipmentCapacityTable) return null;
    const fromIndex = equipmentIdByStepKey.get(equipmentStepKeyOf(templateId, stepId));
    if (fromIndex) return fromIndex;
    const own = equipmentIdOfStep(step);
    return (own && equipmentCapOf(equipmentCapacityTable, own) != null) ? own : null;
  };
  let equipmentStepCount = 0;   // 設備が付いた工程(ロット×工程)の数

  // ── ① ポリシー(仕様書5.1) ──────────────────────────────────────────────
  // 🚨 1人1日の直接作業分数を、ここで勤務表や係数から作らない。policy.js が正。
  const policyResult = resolveOperationPolicy(cfg) || {};
  const policy = isObj(policyResult.policy) ? policyResult.policy : null;
  const regularMinutes = Number(policy?.regularDirectMinutesPerDay);
  const overtimeMinutes = Number(policy?.overtimeDirectMinutesPerDay);
  if (!(regularMinutes > 0) || !(overtimeMinutes > 0)) {
    throw new Error('normalizeInput: policy.js が 1人1日の直接作業分数を返していません（仕様書5.1 / 6.2）');
  }
  const policyWarnings = asArray(policyResult.warnings);

  // 残業シナリオか。🚨 残業の分数は policy が持つ540分。勤務表からは作らない(D02 / T002)。
  // 正の合図は scenario.overtime === true(仕様書6.12)。画面(OperationsSimulationPanel)は
  //   2026-08-28 からこの形で送る。勤務表が何分でも、残業を選べば540分が効く。
  // ⚠ 下の legacyOvertimeSignal は旧い画面が scenario.dailyHours(勤務表の時間数)で
  //   送っていた頃の橋。数字は使わず「420分より大きいか」だけを意思表示として読む。
  //   🚨 この橋には「勤務表の合計が420分以下だと合図が立たない」穴がある
  //   (CONTRACT.md 9.1)。だから新規の呼び出しは必ず overtime:true を送る事。
  //   橋を消さないのは、既存の受入試験と挙動を変えないため(追加のみの決まり)。
  const legacyDailyHours = Number(sc.dailyHours);
  const legacyOvertimeSignal = Number.isFinite(legacyDailyHours)
    && legacyDailyHours * 60 > regularMinutes;
  const overtime = sc.overtime === true
    || sc.scenarioKey === 'overtime'
    || sc.scenarioId === 'overtime'
    || legacyOvertimeSignal;
  const directMinutesPerDay = overtime ? overtimeMinutes : regularMinutes;

  // ── 残業の刻み(2026-08-29 S2-2: 満額はpolicyの540が勝つ) ──────────────────
  // なぜ: 画面が「＋30分/＋60分」の小刻みな残業を試せる様にするため。
  //   新しい合図は scenario.overtimeExtraMinutes(正の整数。画面は 30 か 60 を送る)。
  //   ・満額(上の overtime)が立っている時は **そちらが勝つ**(policyの540)。
  //   ・extra が正の数なら regular + trunc(extra)。ただし上限は policy の540で頭打ち
  //     (D02: 1日の分数は policy.js が決める。勤務表からもここの足し算からも上限は作らない)。
  //   ・負・0・数でない物は黙って無視して従来どおり regular(旧い呼び出しが変な値を
  //     積んでも通常の計算を壊さない。追加のみの決まり)。
  const overtimeExtraRaw = sc.overtimeExtraMinutes;
  const overtimeExtraMinutes = (!overtime
    && typeof overtimeExtraRaw === 'number'
    && Number.isFinite(overtimeExtraRaw)
    && Math.trunc(overtimeExtraRaw) > 0)
    ? Math.trunc(overtimeExtraRaw)
    : null;
  // ⚠ 上の directMinutesPerDay(従来の2値)は1字も変えず、刻みを重ねた最終値を別名で持つ。
  //   extra が無ければ従来の値そのもの(既存の受入試験と挙動を変えない)。
  const directMinutesPerDayEffective = overtimeExtraMinutes != null
    ? Math.min(regularMinutes + overtimeExtraMinutes, overtimeMinutes)
    : directMinutesPerDay;

  // ── ② 勤務の壁時計 ────────────────────────────────────────────────────
  // ⚠ ここから取るのは「何時に始まって、いつ休憩で、定時が何時か」だけ。
  //   1日に何分働けるかは policy が決める(上の directMinutesPerDay)。
  const policyWorkdays = asArray(policy.workdays)
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const scenarioWorkdays = asArray(sc.workdays)
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const baseWorkdays = policyWorkdays.length > 0 ? policyWorkdays : [...DEFAULT_WORKDAYS];
  const workdays = scenarioWorkdays.length > 0 ? scenarioWorkdays : baseWorkdays;
  const workdaySet = new Set(workdays);

  // ── ②′ 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤) ─────────────────
  // 🚨 清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
  //   共通の棚(contact-shared-v1)から来る暦を、ここで **1回だけ** 畳んで下へ配る。
  //   ・週の形(何曜日に働くか)の持ち主は workdays。暦は「その日1日の上書き」だけ。
  //   ・両方向に効く: 平日→休み('off') / 土日→出勤('work')。
  //   🚨 登録が空(null / {})なら worksOnDay は workdays と同じ答えを返す = 今までと1ミリも同じ。
  //   ⚠ シナリオで差し替えられる様にしておく(「祝日に出勤したら間に合うか」を試す時)。
  const factoryCalendarRaw = (sc.factoryCalendar !== undefined && sc.factoryCalendar !== null)
    ? sc.factoryCalendar
    : (cfg.factoryCalendar || null);
  const worksOnDay = makeIsWorkday(factoryCalendarRaw, workdays);
  // 稼働日が1日も無い指定の時だけ、従来どおり「暦日として数える」逃げ道へ落とす。
  const worksOnForCount = workdaySet.size > 0 ? worksOnDay : null;
  // 指紋に混ぜる用。**登録が0件なら空文字**なので null へ落とし、
  //   指紋の JSON に鍵ごと出さない(今までと1バイトも変えない)。
  // 🚨 鍵の作り方の持ち主は factoryCalendar.js ただ一つ。ここで書き直さない。
  //   画面側(useOperationsSimulation)と別の作り方にすると、片方だけ作り直して
  //   もう片方が前の答えを使い回す(押しても変わらない画面になる)。
  const factoryCalendarKey = calendarFingerprint(factoryCalendarRaw) || null;

  const schedule = isObj(cfg.workSchedule) ? cfg.workSchedule : DEFAULT_WORK_SCHEDULE;
  const dayStartHHMM = splitHHMM(schedule.dayStart) ? str(schedule.dayStart) : str(DEFAULT_WORK_SCHEDULE.dayStart);
  const dayEndHHMM = splitHHMM(schedule.dayEnd) ? str(schedule.dayEnd) : str(DEFAULT_WORK_SCHEDULE.dayEnd);
  const rawBreaks = Array.isArray(schedule.breaks) ? schedule.breaks : DEFAULT_WORK_SCHEDULE.breaks;
  const breaks = rawBreaks
    .filter((b) => isObj(b) && splitHHMM(b.start) && splitHHMM(b.end))
    .map((b) => ({ start: str(b.start), end: str(b.end) }));

  // 🚨 納期の解決に使うのは **通常** の勤務終了時刻だけ。残業を選んでも動かさない(T008)。
  const regularSchedule = { dayStart: dayStartHHMM, dayEnd: dayEndHHMM };

  // 実在する休みのデータ(settings.workerRoster)。シナリオの追加分を上に重ねる。
  const registeredRoster = copyAbsences(cfg.workerRoster);
  const absences = mergeAbsences(registeredRoster, sc.absences);

  // 👤 人ごとの勤務の窓(settings.workerProfiles)。清水さん(2026-09-05)「村さんは9:30〜16:00の時短、
  //   片山さんは職長で管理業務があるから直工比率が高い。この辺を設定したい」。
  //   🚨 名簿(workers)に居る名前の分だけ。読めない値は黙って丸めず policyWarnings に1行ずつ残す。
  //   🚨 読み方は calendar.js の normalizeWorkerProfiles ただ1本(ここで HH:MM を解釈し直さない)。
  const rosterNamesForProfiles = asArray(workers).map((w) => str(w?.name).trim()).filter(Boolean);
  // 👤 呼ぶ側が差し替えを渡した時だけ、そちらを読む(渡さなければ設定そのまま = 今までと同じ)。
  const workerProfilesRaw = (isObj(workerAvailability) && isObj(workerAvailability.profiles))
    ? workerAvailability.profiles : cfg.workerProfiles;
  const workerProfilesResult = normalizeWorkerProfiles(workerProfilesRaw, { rosterNames: rosterNamesForProfiles });
  const workerProfiles = workerProfilesResult.profiles;
  const workerProfileCount = Object.keys(workerProfiles).length;
  workerProfilesResult.warnings.forEach((w) => policyWarnings.push(w));

  // 🕒 納期対応の残業・土曜(必要分)(2026-09-16 清水さん)。scenario の2つの鍵を整えて calendarSpec へ載せるだけ。
  //   extraByDay = { 'YYYY-MM-DD': { [名前]: 追加の分数 } } / workOnDays = { 'YYYY-MM-DD': [名前, …] }
  //   🚨 渡されなければ overtimePlanOn=false で、この下の道は1行も動かない(calendarSpec の形も1バイト変わらない)。
  //   🚨 分の上限は policy の残業込み上限 − この見立ての1日の分数(数はここで作らない。差を渡すだけ)。
  //   ⚠ 名簿に居ない名前・読めない日付・0以下の分は黙って捨てる(1人の書き間違いで全員の計算を止めない)。
  const rosterSetForPlan = new Set(rosterNamesForProfiles);
  const ymdOk = (y) => /^\d{4}-\d{2}-\d{2}$/.test(String(y || ''));
  const extraByDay = {};
  if (isObj(sc.extraByDay)) {
    for (const ymd of Object.keys(sc.extraByDay)) {
      const day = sc.extraByDay[ymd];
      if (!ymdOk(ymd) || !isObj(day)) continue;
      for (const name of Object.keys(day)) {
        const min = Math.trunc(Number(day[name]));
        if (!(min > 0) || !rosterSetForPlan.has(String(name).trim())) continue;
        if (!extraByDay[ymd]) extraByDay[ymd] = {};
        extraByDay[ymd][String(name).trim()] = min;
      }
    }
  }
  const workOnDays = {};
  if (isObj(sc.workOnDays)) {
    for (const ymd of Object.keys(sc.workOnDays)) {
      const list = sc.workOnDays[ymd];
      if (!ymdOk(ymd) || !Array.isArray(list)) continue;
      const names = [...new Set(list.map((n) => String(n ?? '').trim()).filter((n) => n && rosterSetForPlan.has(n)))].sort();
      if (names.length) workOnDays[ymd] = names;
    }
  }
  const overtimePlanExtraCount = Object.values(extraByDay).reduce((a, d) => a + Object.keys(d).length, 0);
  const overtimePlanWorkOnCount = Object.values(workOnDays).reduce((a, l) => a + l.length, 0);
  const overtimePlanOn = overtimePlanExtraCount > 0 || overtimePlanWorkOnCount > 0;

  /**
   * カレンダー設定。
   * ⚠ `directMinutesPerDay` が正(仕様書6.3)。`dailyHours` は同じ値を時間で言い直した
   *   別名で、まだ dailyHours を読む呼び出し口(calendar.js の現行 makeCalendar / Side.jsx)が
   *   残っている間の橋。2つの数字が食い違う事は無い(片方をもう片方から作っている)。
   */
  const calendarSpecOf = (minutesPerDay) => ({
    directMinutesPerDay: minutesPerDay,
    // 👤 2026-09-10: 所定内(残業を含まない)の分数。人ごとの残業を解く時にだけ使う。
    //   🚨 納期を解く暦(regularCalendarSpec)では 1日 = 所定内 なので、残業ぶんは 0分。
    //     人ごとの残業を登録しても納期線は動かない(T008 と同じ理由)。
    regularDirectMinutesPerDay: Math.min(regularMinutes, minutesPerDay),
    dailyHours: minutesPerDay / 60,
    workdays: [...workdays],
    // 📅 工場の暦。makeCalendar がこれを番んで「祝日には働ける区間を作らない」をやる。
    // ⚠ Worker へは構造化複製で渡るので、**関数ではなく生の値**を入れる。
    //   関数を入れると Worker の向こうで黙って消え、祝日が効かない画面になる。
    factoryCalendar: factoryCalendarRaw,
    dayStartHHMM,
    dayEndHHMM,
    breaks,
    absences,
    // 👤 人ごとの勤務の窓(読めた物だけ・生の値)。makeCalendar がこれで本人の区間を切る。
    //   ⚠ Worker へは構造化複製で渡るので関数は入れない。登録が無ければ {}(今までと同じ答え)。
    workerProfiles,
    // 👤 2026-09-10: 曜日ごとの窓・その日の予定(有給/半休/出張/会議)を暦に効かせるか。
    //   🚨 既定 false。false の間は calendar.js が今までの道(dayStart/dayEnd/directRatio)しか通らない。
    workerAvailability: workerAvailabilityOn,
  });
  // 2026-08-29 S2-2: 残業の刻みを含めた最終値でカレンダーを作る(extra無しなら従来と同値)。
  const calendarSpec = overtimePlanOn
    ? {
      ...calendarSpecOf(directMinutesPerDayEffective),
      // 🕒 納期対応の残業・土曜の案。calendar.js の segmentsFor がこれで区間を延ばす/土曜に区間を作る。
      //   ⚠ Worker へは構造化複製で渡るので生の値(関数を入れない)。
      extraByDay,
      workOnDays,
      extraMaxMinutesPerDay: Math.max(0, overtimeMinutes - directMinutesPerDayEffective),
    }
    : calendarSpecOf(directMinutesPerDayEffective);
  // 👤 2026-09-06(区画Bの検証で見つけた穴): 使える分(availableDirectMinutes)が どの人も工場一律だった。
  //   要る分は本人の窓で切られるのに使える分は切られず、時短の人(村さん 9:30〜16:00)の不足が実際より小さく出た。
  //   窓は calendar.js ただ1本(workerWindowOf / workMsBetween)から取る。登録の無い人は今までと同じ値。
  const windowCalendar = makeCalendar(calendarSpec);
  // 2026-08-29 S2-2: 刻み残業(extra)の時も、納期の解決は通常420分のまま(T008と同じ理由)。
  // 🕒 残業・土曜の案が載っている時も、納期の解決は通常のまま(納期線は残業で動かない)。
  const regularCalendarSpec = (overtime || overtimeExtraMinutes != null || overtimePlanOn)
    ? calendarSpecOf(regularMinutes) : calendarSpec;

  // ── ③ 予測範囲 ────────────────────────────────────────────────────────
  const hz = Math.max(0, Math.trunc(numOr(horizonDays, 0)));
  const horizonEnd = addWorkdays(nowMs, hz, worksOnForCount);

  // 予測範囲に入る稼働日(作業者の日別稼働予定を作るのに使う)。
  const horizonDates = [];
  const horizonDayMsByYmd = new Map();
  {
    let cur = startOfDayMs(nowMs);
    let guard = 0;
    while (cur <= horizonEnd && guard < MAX_DAY_STEPS) {
      // 🚨 2026-09-02: ここが曜日だけだった。祝日を「働ける日」と数えていたので、
      //   作業者の日別の働ける分数が1日ぶん余分に立っていた(処理能力を多く見積もる)。
      if (worksOnDay(cur)) { horizonDates.push(ymdOf(cur)); horizonDayMsByYmd.set(ymdOf(cur), cur); }
      cur = nextDayMs(cur);
      guard += 1;
    }
  }

  // ── ④ 作業者(仕様書5.5) ───────────────────────────────────────────────
  // 🚨 並びを固定する。Firestore の購読は同じ中身でも順番が変わる事があるので、
  //    入力の順のままだと「同じ入力なのに結果が違う」(S23違反)が起きうる。
  // 🚨 workerId が主キー。name は表示用と、名前で引く休みの表の突き合わせにだけ使う(D26)。
  const roster = asArray(workers)
    .map((w) => ({ workerId: docIdOf(w), name: str(w?.name).trim() }))
    .filter((w) => w.workerId || w.name)
    .sort((a, b) => (a.workerId === b.workerId
      ? a.name.localeCompare(b.name)
      : a.workerId.localeCompare(b.workerId)));

  let missingAvailabilityCount = 0;
  // 👤 2026-09-10 清水さん「残業は個人毎でお願い、しない人はしない人でいるからね」。
  //   🚨 1人1日の直接作業分数を決めるのは policy.js ただ1本(仕様書5.1 / D02)。
  //     ここは resolveWorkerDayMinutes の答えを受け取るだけで、分を足し引きしない。
  //   🚨 登録が無ければ changed:false で 工場の分数そのもの = 今までと1ミリも同じ。
  //   ⚠ 日付では変わらない(その人の残業の決まりは毎日おなじ)ので、1人1回だけ解く。
  const dayMinutesCache = new Map();
  /** 🚨 画面へ返すのは **残業の登録が在る人だけ**。登録が0人なら {} = 直す前と同じ姿。 */
  const workerDayMinutes = {};
  const dayMinutesOf = (name) => {
    const key = str(name);
    if (dayMinutesCache.has(key)) return dayMinutesCache.get(key);
    const profile = workerProfiles[key] || null;
    const res = resolveWorkerDayMinutes({
      name: key,
      base: { regularMin: regularMinutes, dayMin: directMinutesPerDayEffective },
      profile,
    });
    dayMinutesCache.set(key, res);
    if (profile && profile.overtime) workerDayMinutes[key] = res;
    return res;
  };
  const workersOut = roster.map((w) => {
    const dayRes = dayMinutesOf(w.name);
    const availability = horizonDates.map((date) => {
      const status = absences[date]?.[w.name];
      if (status == null || status === '' || status === 'present') {
        // 日別予定が未登録 → 通常勤務として暫定計算し、暫定である事を数える(仕様書5.5)。
        missingAvailabilityCount += 1;
        // 👤 本人の窓(個人設定)が在る日は、その窓で働ける分を上限にする。窓が無ければ工場一律(今までと同じ)。
        //   🚨 数字は calendar.js から。ここで 時刻の引き算をしない(休憩・比率は calendar が持つ)。
        const dayMs = horizonDayMsByYmd.get(date);
        const win = (dayMs != null && typeof windowCalendar.workerWindowOf === 'function')
          ? windowCalendar.workerWindowOf(dayMs, w.name) : null;
        let windowMinutes = null;
        if (win) {
          const ms = Number(windowCalendar.workMsBetween(dayMs, nextDayMs(dayMs), w.name));
          if (Number.isFinite(ms) && ms >= 0) windowMinutes = Math.round(ms / 60000);
        }
        return {
          date,
          // 2026-08-29 S2-2: 残業の刻みを含めた最終値(extra無しなら従来と同値)。
          // 👤 2026-09-10: その人の1日の分数(policy.js が解いた物)。登録が無ければ工場の値そのもの。
          availableDirectMinutes: windowMinutes != null ? Math.min(dayRes.directMin, windowMinutes) : dayRes.directMin,
          reason: 'regular',
          source: 'provisional',
          rosterStatus: null,
          // 👤 'window' = 本人の窓で切った。null = 工場一律。sharedWorkerPlan の札はこれを見る。
          basis: windowMinutes != null ? 'window' : null,
          windowMinutes,
          // 👤 残業の登録で分数が動いた人だけ、その理由を1行添える。
          //   🚨 動いていない人には鍵ごと出さない(登録が無いのに形だけ変わる事を避ける)。
          ...(dayRes.changed ? {
            overtimeBasis: dayRes.source,
            overtimeWhy: dayRes.why,
            factoryDirectMinutes: dayRes.factoryDayMin,
          } : {}),
        };
      }
      // 'off' = 終日の休み。'other' = 他の作業に入っていて検査へは回せない。
      // ⚠ 仕様書5.5 の reason には「他の作業」に当たる言葉が無い。検査に使える分数は
      //   どちらも0なので reason は absence にし、元の言葉を rosterStatus に残す。
      // 👥 2026-09-16 'support:product' / 'support:final' = 向こうの工場の応援(配置)。検査に使える分数は0。
      const known = status === 'off' || status === 'other' || status === 'support:product' || status === 'support:final';
      return {
        date,
        availableDirectMinutes: 0,
        reason: known ? 'absence' : 'unknown',
        source: 'registered',
        rosterStatus: str(status),
      };
    });
    return { workerId: w.workerId, name: w.name, availability };
  });

  // 🚨 旧設定 workloadEffectiveWorkers は割当の分母にしない(仕様書5.5 / D07 / T011)。
  //    計算は名前付き作業者の人数。食い違いは警告として画面へ返す。
  const legacyRaw = Number(cfg.workloadEffectiveWorkers);
  const legacyEffectiveWorkerCount = (Number.isFinite(legacyRaw) && legacyRaw > 0) ? legacyRaw : null;
  const effectiveWorkerCount = workersOut.length;
  const legacyWorkerCountConflict = legacyEffectiveWorkerCount != null
    && legacyEffectiveWorkerCount !== effectiveWorkerCount;

  // ── ⑤ ロット ──────────────────────────────────────────────────────────
  const templateIds = new Set(asArray(templates).map((t) => docIdOf(t)).filter(Boolean));
  const customTargetTimes = isObj(cfg.customTargetTimes) ? cfg.customTargetTimes : null;
  const modelGroups = Array.isArray(cfg.modelGroups) ? cfg.modelGroups : [];

  // 🚨 dueBufferDays から改名(仕様書5.3)。明示設定された稼働日数だけ日付を動かしてから、
  //    その日の通常勤務終了時刻を納期線にする。
  // ⚠ 旧名で渡されたら黙って無視しない。無視すると「納期を1日ずらしたのに何も変わらない」
  //   という、画面からは気づけない食い違いになる。
  if (Math.trunc(numOr(sc.dueBufferDays, 0)) !== 0) {
    throw new Error('normalizeInput: scenario.dueBufferDays は scenario.dueOffsetWorkdays へ名前が変わりました（仕様書5.3。暦日ではなく稼働日で動かします）');
  }
  const dueOffsetWorkdays = Math.trunc(numOr(sc.dueOffsetWorkdays, 0));
  const derivedDaysBefore = Array.isArray(sc.derivedArrivalDaysBefore)
    ? sc.derivedArrivalDaysBefore.map((d) => Math.trunc(Number(d))).filter((d) => Number.isFinite(d) && d > 0)
    : [...DERIVED_ARRIVAL_DAYS_BEFORE];

  /**
   * 🚨🚨 **仮に置く入荷日**（2026-08-24 清水さん「入荷時間ないからほとんど動かなかった。
   *   8/24分以降でないものは とりあえず 納期の2日前に設定してくれない。とりあえずね」）
   *
   * 🚨 これは **仮定** です。元のデータには1文字も書き戻しません。
   *   入っていない値を推測で埋めて「事実」として出すのは禁じられています。
   *   なので、この仮定で動かしたロットには必ず arrivalKind:'assumed' の印を付け、
   *   画面が「仮に置いた」と言えるようにします。
   *
   * 対象は次の2つだけ（入荷予定が これから の物には触りません）:
   *   ・到着エリアに居て、予定時刻を過ぎている（現物未確認）
   *   ・到着エリアに居て、予定が無い
   * ⚠ 納期が入っていない物は仮に置けません（起点が無い）。そのまま「分かりません」。
   * ⚠ 仮に置いた時刻が既に過ぎていたら「もう手元にある」とみなします。
   *   過去の時刻を着手できる時刻として渡すと、計算の起点がおかしくなります。
   */
  const assumeArrivalDaysBeforeDue = (() => {
    const v = Math.trunc(numOr(sc.assumeArrivalDaysBeforeDue, 0));
    return (Number.isFinite(v) && v > 0) ? v : null;
  })();

  const unknowns = {
    dueUnknown: [],
    arrivalUnknown: [],
    arrivalOverdue: [],
    // 🚨 仮に置いた入荷日で動かしたロット。**画面で必ず言う**（黙って埋めない）。
    //   ⚠ これは下の2つを合わせた物（両方の親）。読んでいる所を勝手に片方へ寄せない:
    //     arrivalAccounting.js（足りない=仮に入れた+入れていない の帳尻）と
    //     帯の一覧（仮で置いた顔ぶれ）は、どちらも「合わせた物」の意味で読んでいる。
    arrivalAssumed: [],
    // 🚨 2026-09-04: 「納期のN日前に置けた」物。帯の文が言葉どおり当てはまるのはこちらだけ。
    arrivalAssumedBeforeDue: [],
    // 🚨 2026-09-04: 「N日前がもう過ぎていたので基準時刻に置いた」物。
    //   **納期が来ているのに入荷の登録が無い**という別の話（2026-08-28 の矛盾アラームと同じ族）。
    arrivalAssumedClamped: [],
    durationUnknown: [],
    templateMissing: [],
    // 🚨 設備の設定は settings に1件も無い。「制約なし」と推測せず、分からないと言う(仕様書D21)。
    equipment: 'unset',
  };
  const templateMissingSet = new Set();
  let lowConfidenceEstimateCount = 0;
  // 🆕 「実際の生産に近い状態で」の3本が、実際に何件へ効いたか。
  //   🚨 効いた件数は **必ず数える**。0件なら画面が「ONにしたが1件も動かなかった」と言える。
  let arrivalHabitCount = 0;      // 到着予定を動かしたロット
  // 🚚 到着のクセ: 動かした/動かさなかった理由の内訳(applyArrivalHabit の why → 件数)。
  //   2026-09-10 確かめ役: 本番の写しの記録8件は全部「ずれ0分」で、ON にしても 0件しか動かないのに
  //   warnings が空だった(黙った素通り)。切ってある間は applyArrivalHabit を呼ばないので空のまま。
  const arrivalHabitWhyCounts = {};
  let splitArrivalCount = 0;      // 台ごとに分けたロット
  let shipDeadlineCount = 0;      // 出荷日から締切を出したロット
  let shipTighterCount = 0;       // そのうち 検査の予定日より締切が **前** だったロット
  const fingerprintLots = [];

  /**
   * 日付だけ / 時刻つきの納期を、実時刻へ解決する。
   * 🚨 時刻の決め方(日付だけなら通常勤務終了時刻)は calendar.js の resolveDueAt ただ1つが持つ。
   *    ここで真夜中へ丸めない(仕様書5.3 / D04 / T007)。
   * ⚠ 稼働日ぶんの前進は resolveDueAt に任せる。後ろ向き(納期より前に線を引く指定)は
   *    resolveDueAt が扱わないので、日付をこちらで戻してから渡す。
   */
  const resolveDue = (dueDayMs, explicit, offsetWorkdays) => {
    const back = offsetWorkdays < 0 ? offsetWorkdays : 0;
    const forward = offsetWorkdays > 0 ? offsetWorkdays : 0;
    const ymd = ymdOf(back === 0 ? dueDayMs : addWorkdays(dueDayMs, back, worksOnForCount));
    const dueDate = explicit
      ? `${ymd}T${pad2(explicit.h)}:${pad2(explicit.m)}:${pad2(explicit.s)}`
      : ymd;
    const resolved = Number(resolveDueAt({
      dueDate,
      hasExplicitTime: !!explicit,
      regularSchedule,
      dueOffsetWorkdays: forward,
      workdays,
    }));
    if (!Number.isFinite(resolved)) {
      // 🚨 黙って真夜中へ落とさない。落とすと、その日の仕事を前日までに終える計算に戻る。
      throw new Error(`normalizeInput: calendar.resolveDueAt が納期時刻を返しませんでした（${dueDate}）`);
    }
    return resolved;
  };

  // 🧵 優先度の区分が 通常 でないロット [lotId, 区分]。指紋(合図が立っている時だけ)と警告に使う。
  const priorityByLot = [];

  const lotsOut = asArray(lots).filter(isOpenLot).map((lot) => {
    const lotId = docIdOf(lot);
    const templateId = str(lot.templateId);
    const quantity = Math.max(1, Math.trunc(numOr(lot.quantity, 1)));
    const model = str(lot.model);
    // 🧵 優先度の区分(緊急0/特注1/通常2)。字→番号の読み替えは上の priorityClassOf ただ1か所。
    const priorityClass = priorityClassOf(lot.priority);
    if (priorityClass !== PRIORITY_CLASS.NORMAL) priorityByLot.push([lotId, priorityClass]);
    const locationRaw = str(lot.location);
    // 🚨 Number(null) は 0 になる。0 を「1970年に到着済み」として通すと、記録が無いロットが
    //   到着予定超過へ紛れ込む(実測: entryAt:null のロットが 1970/1/1 の予定として出た)。
    //   到着日時が無い物は、無いと言う(仕様書5.4 arrivalUnknown)。
    const entryRaw = Number(lot.entryAt);
    const entryMs = (lot.entryAt == null || lot.entryAt === '' || !Number.isFinite(entryRaw) || entryRaw <= 0)
      ? NaN
      : entryRaw;
    const lotUnknowns = [];

    // ── 納期(仕様書5.3) ────────────────────────────────────────────────
    // 🚨 lot.dueDate は **予定日** であって守るべき納期ではない。
    //    完了実績246件の53.7%がこの日を過ぎている(山の頂点は+1日、中央値+1.4日)。
    //    ここでは印(dueKind:'planned')だけ付ける。
    const dueDayMs = dueMsOfLot(lot);
    // 🚩 2026-09-09: 進捗管理表の取込が **仮**(Z列が空で Y列/AB列から作った)で置いた納期には
    //   lot.dueDateProvisional の印が付く。これを 'planned'(予定日)と同じ顔で通すと、
    //   組立の開始日から作った日付で「遅れます」と言い出す(嘘の赤)。
    //   ⚠ 山(工数)からは外さない。外すと先の仕事が見えなくなる(シミュの主目的が月ごとの人繰りのため)。
    //     外すのは **危険なロットの数** だけ(atRisk.js)。
    const dueKind = dueDayMs == null ? 'none' : (lot.dueDateProvisional === true ? 'provisional' : 'planned');
    const explicit = dueDayMs == null ? null : explicitTimeOf(lot.dueDate);
    const dueMs = dueDayMs == null ? null : resolveDue(dueDayMs, explicit, 0);
    const dueLineMs = dueDayMs == null
      ? null
      : (dueOffsetWorkdays === 0 ? dueMs : resolveDue(dueDayMs, explicit, dueOffsetWorkdays));
    if (dueDayMs == null) {
      // 🚨 S17: 納期が無いロットを「今」や「即時完了」にしない。分からないと言う。
      unknowns.dueUnknown.push(lotId);
      lotUnknowns.push('dueUnknown');
    }

    // ── 到着(仕様書5.4) ────────────────────────────────────────────────
    // 🚨 予定時刻と物理的な場所を混ぜない。到着エリアに残っている物は、
    //    予定時刻を過ぎていても現物未確認。人を付けない(D06 / T009)。
    let arrivalState;
    let arrivalMs = null;             // 着手できる最も早い時刻。人を付けられない物は null
    let scheduledArrivalMs = null;    // 記録されている到着予定。表示と説明に使う
    let assignable;
    let arrivalKind;                  // 旧名。画面(Side.jsx)が 'derived' を読んでいる
    // 🚨🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違うからいいかげんにして」。
    //   仮に置いた日には **2通り** ある。1つの数・1つの文にまとめると嘘になる:
    //     'beforeDue'     … 納期の N日前 に置けた（言葉どおり）
    //     'clampedToNow'  … N日前がもう過ぎていたので **基準時刻** に置いた（言葉と違う）
    //   実測(2026-08-30 の控え・基準 2026-09-07 08:30): 仮 38件 = beforeDue 24件 + clampedToNow 14件。
    //   なのに帯は38件とも「納期の2日前に着く」と言っていた。**画面まで2つのまま運ぶ**。
    let arrivalAssumedKind = null;    // 'beforeDue' | 'clampedToNow' | null(仮に置いていない)
    let arrivalAssumedWantMs = null;  // 丸める前の「納期のN日前」。画面が式を見せる為に残す
    // 🚚 到着のクセで何分ずらしたか。切ってある間は 0 と '' のまま(欄は増えない。下の spread を見る事)
    let arrivalHabitShiftMin = 0;
    let arrivalHabitWhy = '';
    // 📦 分納で分けた便。切ってある間は null(欄そのものを増やさない)
    let arrivalChunks = null;
    if (locationRaw !== 'arrival') {
      // 未入荷置き場に居ないロットは、もう手元にある。今から着手できる(T010)。
      arrivalState = ARRIVAL_STATE.IN_SHOP;
      arrivalMs = nowMs;
      assignable = true;
      arrivalKind = 'inShop';
      if (Number.isFinite(entryMs)) scheduledArrivalMs = entryMs;
    } else if (Number.isFinite(entryMs)) {
      scheduledArrivalMs = entryMs;
      // Excel取込が「納期日の始業時刻から N 暦日前」を機械的に書いた値かどうか。
      // 一致したら 'derived' = 誰かが到着を確かめた値ではない、という印。
      // ⚠ 見分けるのは **記録された生の値**。クセでずらした後の値で見ない
      //   (ずらすと 'derived' の印が消えてしまう)。
      const isDerived = dueDayMs != null
        && derivedDaysBefore.some((n) => derivedArrivalMs(dueDayMs, n, dayStartHHMM) === entryMs);
      arrivalKind = isDerived ? 'derived' : 'registered';
      // 🚚 入荷の遅れのクセ。🚨 切ってある間(既定)は applyArrivalHabit が
      //   渡した値をそのまま返すので、この2行は1ミリも効かない。
      //   ⚠ ずらすのは **予定** だけ。scheduledArrivalMs(記録された予定)は書き換えない。
      //   ⚠ 切ってある時は呼びもしない(1回の見立てで数百ロットを通る道。無駄な物を作らない)。
      const habitRes = arrivalHabitMode === HABIT_MODE.OFF ? null : applyArrivalHabit(entryMs, {
        group: arrivalHabitGroupByLot ? str(arrivalHabitGroupByLot[lotId]) : (str(lot.arrivalGroup) || str(lot.group)),
        habit: arrivalHabitTable,
        mode: arrivalHabitMode,
        // 到着エリアに居るロットは まだ現物が確かめられていない = 実際に着いた記録は無い。
        arrived: false,
        useAllWhenGroupUnknown: arrivalHabitUseAll,
      });
      if (habitRes) {
        // 理由の内訳は動かさなかった物も数える(ON なのに 0件 の時に「なぜ動かなかったか」を言う為)。
        arrivalHabitWhyCounts[habitRes.why] = (arrivalHabitWhyCounts[habitRes.why] || 0) + 1;
        if (habitRes.applied) {
          arrivalHabitShiftMin = habitRes.shiftMin;
          arrivalHabitWhy = habitRes.why;
          arrivalHabitCount += 1;
        }
      }
      const effectiveEntryMs = habitRes ? habitRes.ms : entryMs;
      if (effectiveEntryMs >= nowMs) {
        // 予定時刻はまだこれから。予定どおり着けば、その時刻から着手できる。
        arrivalState = ARRIVAL_STATE.SCHEDULED;
        arrivalMs = effectiveEntryMs;
        assignable = true;
      } else {
        // 🚨 予定時刻を過ぎているのに場所が到着エリアのまま = 現物未確認。
        //   ここで手元扱いにすると、まだ無い物へ人を付ける予測になる。
        arrivalState = ARRIVAL_STATE.OVERDUE;
        arrivalMs = null;
        assignable = false;
        unknowns.arrivalOverdue.push(lotId);
        lotUnknowns.push('arrivalOverdue');
      }
    } else {
      arrivalState = ARRIVAL_STATE.UNKNOWN;
      arrivalMs = null;
      assignable = false;
      arrivalKind = 'unknown';
      unknowns.arrivalUnknown.push(lotId);
      lotUnknowns.push('arrivalUnknown');
    }

    // 🚨🚨 仮に置く入荷日。**元のデータには書き戻さない**。印を必ず残す。
    //   入荷が分からない／予定を過ぎた物は assignable=false なので、盤に出ても
    //   一生人が付かず動かない（2026-08-24 清水さん「ほとんど動かなかった」）。
    //   仮に置くと動くようになるが、**それは仮定であって事実ではない**。
    //   だから arrivalKind:'assumed' と unknowns.arrivalAssumed に必ず残す。
    if (assumeArrivalDaysBeforeDue != null && !assignable && dueDayMs != null) {
      const assumed = derivedArrivalMs(dueDayMs, assumeArrivalDaysBeforeDue, dayStartHHMM);
      if (assumed != null) {
        // ⚠ 仮の時刻が既に過ぎていたら「もう手元にある」とみなす。
        //   過ぎた時刻を着手できる時刻として渡すと、計算の起点がおかしくなる。
        arrivalMs = Math.max(assumed, nowMs);
        assignable = true;
        arrivalState = arrivalMs > nowMs ? ARRIVAL_STATE.SCHEDULED : ARRIVAL_STATE.IN_SHOP;
        arrivalKind = 'assumed';
        // 🚨 丸めたかどうかを **ここで** 決めて、最後まで2つのまま運ぶ(2026-09-04)。
        //   画面で数え直させない(数え直すと2つの計算から同じ数字が出て食い違う)。
        arrivalAssumedWantMs = assumed;
        arrivalAssumedKind = assumed < nowMs ? 'clampedToNow' : 'beforeDue';
        unknowns.arrivalAssumed.push(lotId);
        if (arrivalAssumedKind === 'clampedToNow') unknowns.arrivalAssumedClamped.push(lotId);
        else unknowns.arrivalAssumedBeforeDue.push(lotId);
        lotUnknowns.push('arrivalAssumed');
      }
    }

    // ── 📦 分納(1指図が数便に分かれて着く) ────────────────────────────────
    // 🚨 切ってある間(既定)は splitArrivalByLot が null なので、この塊は丸ごと素通り。
    // 🚨 便が2つ以上 読めた時だけ効く。1便・記録なしは今までどおり(chunks は空で返る)。
    // ⚠ 台数の分け方は splitArrivalLoad.js ただ1本。ここで足し算をしない。
    let shipInfo = null;
    if (splitArrivalByLot) {
      const load = splitArrivalLoad({ lot, arrival: splitArrivalByLot[lotId] || null });
      // 🚨 2026-09-22 便が1つでも「一部だけ」なら分ける(splitArrivalLoad が SPLIT で返す)。
      if (load.chunks.length >= 1 && assignable && arrivalMs != null) {
        // 便の時刻が もう過ぎていたら「その台はもう手元にある」= 基準時刻から着手できる。
        //   ⚠ 過ぎた時刻をそのまま渡すと、計算の起点が過去になる(仮の入荷日と同じ扱い)。
        arrivalChunks = load.chunks.map((c) => ({ atMs: Math.max(c.atMs, nowMs), qty: c.qty }));
        const first = arrivalChunks[0].atMs;
        // 1便目が今の起点より早いなら、ロット全体の起点もそこまで前へ出す
        //   (段取りなど「ロットに1回」の工程は 1便目が着けば始められる)。
        if (first < arrivalMs) {
          arrivalMs = first;
          arrivalState = arrivalMs > nowMs ? ARRIVAL_STATE.SCHEDULED : ARRIVAL_STATE.IN_SHOP;
        }
        splitArrivalCount += 1;
      }
    }

    // ── 🚚 出荷日から逆算した「本当の締切」 ──────────────────────────────
    // 🚨 既存の納期線(dueMs / dueLineMs)は **1バイトも変えない**。別の欄で返すだけ。
    //   完了実績の53.7%が lot.dueDate を過ぎている(このファイルの頭の実測)ので、
    //   予定日の遅れと「出荷に間に合わない」を1つの線で言うと本当に危ない物が埋もれる。
    // 🚨 切ってある間(既定)は shipOn が false なので、この塊は丸ごと素通り。
    if (shipOn) {
      const d = resolveDeadlines({
        lot,
        shipYMD: shipByLot ? str(shipByLot[lotId]) : null,
        leadDays: shipLeadDays,
        // ⚠ 稼働日と勤務終了時刻は この見立てで使っている暦そのもの(2つ目の暦を作らない)。
        calendar: { workdays: [...workdays], factoryCalendar: factoryCalendarRaw, regularSchedule },
      });
      if (d.hardDueMs != null) {
        shipInfo = d;
        if (d.kind === 'ship') {
          shipDeadlineCount += 1;
          if (d.slackDays != null && d.slackDays < 0) shipTighterCount += 1;
        }
      }
    }

    // ── 工程 ────────────────────────────────────────────────────────────
    // 🚫 記録でほぼ毎回飛ばす工程は仕事に積まない(既定)。⚠ index は元の並びのまま残す(他の工程の jobId を変えない)。
    //   実測(2026-09-18): 傾斜回転分割_RTT-215専用 の「制御装置用意」(飛ばし19・完了6)を積むと誰にも配れずロットが止まっていた。
    const entriesAll = stepEntriesOf(lot.steps);
    const entries = !applyAlwaysSkipped ? entriesAll : entriesAll.filter(({ step }) => {
      const k = processKeyOf(templateId, str(step.id));
      if (!skipOnlySet.has(k)) return true;
      alwaysSkippedStepCount += 1;
      alwaysSkippedLots.add(lotId);
      const tsec = Number(step.targetTime);
      if (tsec > 0) alwaysSkippedMinutesByTarget += (tsec * (isOncePerLotStep(step) ? 1 : quantity)) / 60;
      return false;
    });
    if (entries.length === 0) lotUnknowns.push('noSteps');
    let hasUnknownDuration = false;
    const steps = entries.map(({ index, step }) => {
      const stepId = str(step.id);
      // 🚨 実績の統計が渡されていれば estimate.js の5段(較正→型式+工程→手順書+工程
      //   →題+台ごと→目標→不明)。渡されていなければ従来の3段。
      //   どちらも「分からない物は null。60秒などで埋めない」(T030)。
      const est = durationStats
        ? (() => {
          const d = estimateDuration({
            step,
            templateId,
            model,
            customTargetTimes,
            modelGroups,
            stats: durationStats,
            mode: estMode,
          });
          return {
            sec: d.seconds,
            source: d.source,
            confidence: d.confidence,
            sampleCount: d.sampleCount,
            groupLevel: d.groupLevel,
            why: d.why,
          };
        })()
        : estimateOf(step, model, customTargetTimes, modelGroups);
      if (est.sec == null) {
        unknowns.durationUnknown.push({ lotId, stepId, title: str(step.title) });
        hasUnknownDuration = true;
      } else if (est.confidence !== 'high') {
        lowConfidenceEstimateCount += 1;
      }
      return {
        stepId,
        index,
        title: str(step.title),
        category: str(step.category),
        processKey: processKeyOf(templateId, stepId),
        // 台数を掛ける工程か。ロット1回(段取り・員数/一括)は掛けない。
        perUnit: !isOncePerLotStep(step),
        // 🚨 T030: 分からない時に 0 も 60 も入れない。0 は「この工程は時間がかからない」と
        //   読めてしまい、本物の0秒と見分けが付かないまま合計へ足されて、
        //   人手が足りている様に見えてしまう。分からない物は null にして、
        //   読む側(buildJobs の durationKnown / explain の原因「時間不明」)に気付かせる。
        targetSec: est.sec,
        estimateSource: est.source,
        estimateConfidence: est.confidence,
        // 🚨 「何件の実績から出したか」「どの段から来たか」を画面へ運ぶ。
        //   数字だけ出すと、目標時間(測っていない値)と実績が同じ顔になる。
        estimateSampleCount: est.sampleCount == null ? 0 : est.sampleCount,
        estimateGroupLevel: est.groupLevel == null ? null : est.groupLevel,
        estimateWhy: est.why == null ? '' : est.why,
        // 🔧 設備。scenario.equipmentCapacity を渡された時だけ 上限を決めた設備の id が入る。
        //   渡されなければ(既定・本番の今の普通)全部 null。equipmentUnmodeled と対で読む事。
        equipmentId: (() => {
          const id = equipmentIdForStep(templateId, stepId, step);
          if (id) equipmentStepCount += 1;
          return id;
        })(),
      };
    });
    if (hasUnknownDuration) lotUnknowns.push('durationUnknown');

    if (templateId && !templateIds.has(templateId)) {
      templateMissingSet.add(templateId);
      lotUnknowns.push('templateMissing');
    }

    // ── 済んだ作業 ──────────────────────────────────────────────────────
    // 「もう時間がかからない」の判定は lotRemaining.js の isDoneTask ただ1つ
    //   (完了 / 抜取で省略 / 該当なし)。ここで条件を足すと画面の進捗%とズレる。
    const tasks = isObj(lot.tasks) ? lot.tasks : {};
    const doneTaskKeys = Object.keys(tasks).filter((k) => isDoneTask(tasks[k])).sort();

    // 指紋の材料は **生の値** で持つ(仕様書6.10)。現在時刻から作った値を混ぜると、
    // 時間が経っただけで指紋が変わり、同じ入力どうしの比較ができなくなる(5.8 / T014)。
    fingerprintLots.push([
      lotId, locationRaw, Number.isFinite(entryMs) ? entryMs : null,
      str(lot.dueDate), quantity, templateId,
      steps.map((s) => [s.stepId, s.index, s.processKey, s.perUnit, s.targetSec, s.estimateSource]),
      doneTaskKeys,
    ]);

    return {
      lotId,
      model,
      quantity,
      orderNo: str(lot.orderNo),
      dueMs,
      dueKind,
      dueTimeSource: dueDayMs == null ? null : (explicit ? 'explicit' : 'regular-work-end'),
      dueOffsetWorkdays,
      dueLineMs,
      arrivalState,
      assignable,
      // 「いつから着手してよいか」。人を付けられない物は null。
      assignableFromMs: assignable ? arrivalMs : null,
      arrivalMs,
      scheduledArrivalMs,
      arrivalKind,
      // 🚨 2026-09-04: 「仮」の中の2通り。札と title の文はこれで分ける。
      //   null = 仮に置いていない。'beforeDue' = 納期のN日前。'clampedToNow' = 基準時刻へ丸めた。
      arrivalAssumedKind,
      // 丸める前の「納期のN日前」。画面が式（納期 → N日前 → もう過ぎている → 置いた日）を見せる材料。
      arrivalAssumedWantMs,
      templateId,
      // 🏭 そのロットが置いてある区画(エリアマップ)。清水さん(2026-09-06)「作業する場所も意識して」。
      //   ⚠⚠ 上の fingerprintLots(指紋)には **足さない**。指紋は「同じ土俵か」を見る物で、
      //     直す前に採った値が試験に焼き込まれている(factory-calendar-capacity.test.mjs:305)。
      //     区画を動かした時の作り直しは useOperationsSimulation の fingerprintData(updatedAt)が拾う。
      //   ⚠ 空 = 決まっていない。決まっていない物に上限はかけない(zoneCapacity.js)。
      mapZoneId: str(lot.mapZoneId),
      // 🧵 優先度の区分 0(緊急)|1(特注)|2(通常)。buildJobs が job へ素通しで運ぶ。
      //   ⚠ 指紋には **合図(scenario.priorityClass)が立った時だけ** 混ぜる(下の priorityByLot)。
      //     いつも混ぜると、設定を何もしていないのに指紋が変わる(焼き込み 514c94d758a9f5d7 が割れる)。
      priorityClass,
      steps,
      doneTaskKeys,
      unknowns: lotUnknowns,
      // ── 🆕 「実際の生産に近い状態で」の3本。**切ってある間は鍵ごと出さない** ──
      //   🚨 常に null で出すと、ロットの形そのものが変わって
      //     「切ってあるのに答えが違う」と読めてしまう(既存の見張りが比べているのは形も含む)。
      // 🚚 到着のクセで動かした分。動かした物にだけ付く。
      ...(arrivalHabitShiftMin !== 0
        ? { arrivalHabitShiftMin, arrivalHabitWhy }
        : {}),
      // 📦 便ごとの「着く時刻と台数」。台ごとの起点は buildJobs がここから引く。
      ...(arrivalChunks ? { arrivalChunks } : {}),
      // 🚚 出荷日から逆算した本当の締切。⚠ dueLineMs(既存の納期線)とは別の欄。
      //   hardDueMs … 出荷日 − リードタイム(営業日)。出荷日が無ければ検査の予定日そのもの
      //   dueSlackWorkdays … 検査の予定日から締切まで あと何営業日。**負なら間に合わない**
      ...(shipInfo
        ? {
          hardDueMs: shipInfo.hardDueMs,
          hardDueKind: shipInfo.kind,
          shipDueMs: shipInfo.shipDueMs,
          dueSlackWorkdays: shipInfo.slackDays,
        }
        : {}),
    };
  })
    // 🚨 ロットの並びも固定する(購読の順に左右されない)。
    .sort((a, b) => a.lotId.localeCompare(b.lotId));

  unknowns.templateMissing = [...templateMissingSet].sort();
  unknowns.dueUnknown.sort();
  unknowns.arrivalUnknown.sort();
  unknowns.arrivalOverdue.sort();
  // ⚠ arrivalAssumed は昔から入力順のまま。ここで並べ替えると既存の並びが変わるので触らない。
  //   新しい2つだけ、はじめから並べて渡す(見張りが順で比べられる様に)。
  unknowns.arrivalAssumedBeforeDue.sort();
  unknowns.arrivalAssumedClamped.sort();
  unknowns.durationUnknown.sort((a, b) => (a.lotId === b.lotId
    ? a.stepId.localeCompare(b.stepId)
    : a.lotId.localeCompare(b.lotId)));
  fingerprintLots.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // 🧵 並びを固定する(lotsOut と同じ localeCompare。指紋の材料なので順で値が変わってはいけない)。
  priorityByLot.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // 🧵 区分を効かせる合図が立っているのに、全部 通常 なら黙らない(ON にしたのに並びが1つも変わらない)。
  if (priorityClassOn && priorityByLot.length === 0 && lotsOut.length > 0) {
    realismWarnings.push('優先度の区分を割付の先頭にする合図が立っていますが、この見立てのロットは全部「通常」です。並びは区分では1件も変わっていません');
  }

  // 🔧 設備: 上限を決めた設備が1件でも仕事に付いたら「設定あり」。渡されたのに1件も付かなければ黙らない。
  if (equipmentStepCount > 0) unknowns.equipment = 'set';
  else if (equipmentCapacityTable) {
    realismWarnings.push('設備の台数の設定を渡されましたが、上限を決めた設備を使う工程が この見立てのロットに1件もありません。設備の門は1件もかけていません');
  }
  // 🚚 到着のクセ: ON で表も渡されているのに1件も動かなかった時は、黙らず「なぜ動かなかったか」を1行にする。
  //   表そのものの気がかり(「8件とも 0分」「記録が5件に届かない班」など。buildArrivalHabit が数えた文)も添える。
  //   ⚠ 切ってある間(既定)はこの塊は丸ごと素通り(warnings は今までどおり空)。
  if (arrivalHabitMode !== HABIT_MODE.OFF && arrivalHabitTable) {
    const tableWarnings = Array.isArray(arrivalHabitTable.warnings) ? arrivalHabitTable.warnings.map(str).filter(Boolean) : [];
    for (const w of tableWarnings) realismWarnings.push(`到着のクセ: ${w}`);
    if (arrivalHabitCount === 0) {
      const parts = Object.entries(arrivalHabitWhyCounts).map(([why, n]) => `${habitWhyLabel(why) || why} ${n}件`);
      realismWarnings.push(
        '到着のクセを使う設定ですが、到着予定を動かしたロットは0件です'
        + (parts.length ? `（${parts.join('・')}）` : '（到着予定の時刻が入った未入荷のロットが1件もありません）'),
      );
    }
  }

  // ── ⑥ 入力指紋(仕様書6.10) ────────────────────────────────────────────
  // 🚨 シナリオで変わる物(残業・追加の休み・全員万能)を入れない。入れると
  //    「通常との差」を出す時に指紋が食い違い、比較そのものが拒否される(5.8 / T014)。
  // 🚨 写真や説明文などの巨大データは入れない。
  // 📌 2026-09-15 手で決めた担当(pins)。名簿に居ない名前・計算に載っていないロットは捨てて pinsDropped に残す(黙って素通りしない)。
  //   🚨 1件も無ければ鍵ごと出さない(登録が空なのに指紋だけが変わる事を避ける)。
  const pinsNorm = normalizePins(sc.pins, { lotIds: lotsOut.map((l) => l.lotId), workerNames: workersOut.map((w) => w.name) });
  const pinsOn = Object.keys(pinsNorm.pins).length > 0;
  // 📌 2026-09-19 やわらかい固定(softPins): 記録の実際の担当(固定が既定)。手で決めた固定(pins)が在るロットには載せない(手が勝つ)。
  //   '' (誰にも当てない)は やわらかい固定には無い。1件も無ければ鍵ごと出さない(pins と同じ)。
  const softNorm = normalizePins(sc.softPins, { lotIds: lotsOut.map((l) => l.lotId), workerNames: workersOut.map((w) => w.name) });
  const softPins = Object.fromEntries(Object.entries(softNorm.pins).filter(([id, w]) => w && !(id in pinsNorm.pins)));
  const softPinsOn = Object.keys(softPins).length > 0;
  const inputFingerprint = stableHash(JSON.stringify({
    v: 1,
    // 🚫 記録でほぼ毎回飛ばす工程を積まない/積む は入力の一部(2026-09-18)。鍵が変われば別の答え。
    //   🚨 1件も無ければ鍵ごと出さない(登録が空なのに指紋だけが変わる事を避ける。pins と同じ)。
    ...(skipOnlySet.size ? { alwaysSkipped: [applyAlwaysSkipped, [...skipOnlySet].sort()] } : {}),
    policy: [
      policy.schemaVersion ?? null,
      regularMinutes,
      overtimeMinutes,
      policy.uiStepFraction ?? null,
      policy.dueCutoff ?? null,
    ],
    horizonDays: hz,
    workdays: baseWorkdays,
    // 🚨 2026-09-02 工場の暦(祝日・全社休業・休日出勤)を指紋へ必ず混ぜる。
    //   混ぜないと「祝日を登録したのに計算し直さない画面」になり、
    //   暦の違う結果どうしを「同じ土俵」と誤認して並べてしまう(CONTRACT.md 5.8)。
    // ⚠ 登録が0件の時は鍵ごと出さない。こうしないと JSON の文字列が変わり、
    //   **登録が空なのに指紋だけが変わる**(直す前の結果と突き合わせられなくなる)。
    ...(factoryCalendarKey ? { factoryCalendar: factoryCalendarKey } : {}),
    // 👤 人ごとの窓を指紋へ混ぜる。混ぜないと「時短を登録したのに計算し直さない画面」になる。
    //   ⚠ 登録が0人なら鍵ごと出さない(登録が空なのに指紋だけが変わる事を避ける)。
    ...(workerProfileCount > 0 ? { workerProfiles } : {}),
    // ── 🆕 「実際の生産に近い状態で」の4本 ────────────────────────────────
    // 🚨 **切ってある時は鍵ごと出さない**。出すと JSON の文字列が変わって、
    //   設定を何もしていないのに指紋だけが変わる(2026-09-02 の暦と同じ轍)。
    //   焼き込み値の見張り factory-calendar-capacity.test.mjs:305('514c94d758a9f5d7')が
    //   赤にならない事を、この形で守っている。
    // 🚨 逆に、ONにした時は必ず変える。変えないと「クセを入れたのに計算し直さない画面」になる。
    ...(arrivalHabitMode !== HABIT_MODE.OFF
      ? { arrivalHabit: [arrivalHabitMode, arrivalHabitTable ? arrivalHabitTable.pairs : 0, arrivalHabitUseAll] }
      : {}),
    ...(workerAvailabilityOn ? { workerAvailability: true } : {}),
    // 🕒 納期対応の残業・土曜の案。載っている時だけ鍵を出す(無い時は指紋を1バイトも変えない)。
    //   🚨 載せないと「これでいく」を押しても runKey が変わらず、盤が引き直らない。
    ...(overtimePlanOn ? { overtimePlan: [extraByDay, workOnDays] } : {}),
    ...(splitArrivalOn ? { splitArrival: splitArrivalCount } : {}),
    ...(shipOn ? { shipDeadline: [shipLeadDays, shipDeadlineCount] } : {}),
    // 🔧 設備は「上限を決めた設備が仕事に付いた時」だけ。付いた工程の鍵→設備id と 上限を混ぜる
    //   (上限を 1→2 に変えたのに計算し直さない画面を作らない)。
    ...(equipmentStepCount > 0
      ? {
        equipment: [
          equipmentStepCount,
          [...equipmentIdByStepKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, id]) => [k, id, equipmentCapOf(equipmentCapacityTable, id)]),
        ],
      }
      : {}),
    // 👥 分担の区切り。🚨 切ってある('none')間は **鍵ごと出さない**。
    //   出すと JSON の文字列が変わって、設定を何もしていないのに指紋だけが変わる
    //   (焼き込み値 '514c94d758a9f5d7' の見張りが割れる)。
    // 🚨 逆に ONにしたら必ず変える。変えないと「区切りを入れたのに計算し直さない画面」になる。
    ...(handoffMode !== HANDOFF_MODE.OFF ? { handoff: handoffMode } : {}),
    // 🧵 ロットは持ったら最後まで / 優先度の区分。🚨 合図が立っていない間は **鍵ごと出さない**
    //   (焼き込み値 '514c94d758a9f5d7' の見張りが割れる)。
    // 🚨 逆に ONにしたら必ず変える。区分は「どのロットがどの区分か」まで混ぜる
    //   (緊急を1件付けたのに計算し直さない画面を作らない)。
    ...(lotFocusOn ? { lotFocus: true } : {}),
    ...(priorityClassOn ? { priorityClass: priorityByLot } : {}),
    // 📌 手で決めた担当。1件でも在れば指紋が変わる(固定したのに計算し直さない画面を作らない)。
    ...(pinsOn ? { pins: pinsNorm.pins } : {}),
    ...(softPinsOn ? { softPins } : {}),
    schedule: [dayStartHHMM, dayEndHHMM, breaks.map((b) => `${b.start}-${b.end}`)],
    dueOffsetWorkdays,
    // 🚨 仮に置いた入荷日は **別の入力**。指紋に入れないと、仮定を入れた結果と
    //   入れていない結果を「同じ土俵」と誤認して比べてしまう（CONTRACT.md 5.8）。
    assumeArrivalDaysBeforeDue,
    // 🚨 見積りモードは指紋に入れる。P50 と P90 は別の入力なので、
    //   混ぜて比べると「残業の効き目」に見積りモードの差が紛れ込む(CONTRACT.md 5.8)。
    estimateMode: estMode,
    // 🚨 実績の統計そのものは巨大なので入れない。代わりに「何件の標本から作ったか」
    //   だけを入れる。標本が増えれば見積りが変わるので、指紋も変わらないといけない。
    durationStatsSize: durationStats
      ? [durationStats.byModelStep?.size ?? 0, durationStats.byTemplateStep?.size ?? 0,
        durationStats.byTitleGroup?.size ?? 0, durationStats.diagnostics?.tasksWithDuration ?? 0]
      : null,
    roster: registeredRoster,
    workers: roster.map((w) => [w.workerId, w.name]),
    lots: fingerprintLots,
  }));

  // 🚨 2026-09-01 矛盾Bの直し。入荷日の件数の内訳と、帯・カードの文を
  //   **1つの計算から** 作る(arrivalAccounting.js)。画面はこれをそのまま出す。
  const arrivalQuality = buildArrivalAccounting({ unknowns, assumeArrivalDaysBeforeDue });
  const arrivalSaid = arrivalSentences(arrivalQuality);

  return {
    // ── 仕様書6.4 が並べている物 ──
    policy,
    policyWarnings,
    // ⚠ calendar / regularCalendar は makeCalendar() へ渡す **設定** を返す。
    //   calendar.js の実体(Calendar)は、使う側(worker / simulate / 画面)が作る。
    //   ここで作って返すと、Worker の外へ関数を渡す事になり構造化複製で消える。
    calendar: calendarSpec,
    regularCalendar: regularCalendarSpec,
    workers: workersOut,
    jobs: buildJobs({ lots: lotsOut }),
    lots: lotsOut,
    inputFingerprint,
    inputQuality: {
      arrivalOverdueCount: unknowns.arrivalOverdue.length,
      arrivalUnknownCount: unknowns.arrivalUnknown.length,
      /**
       * 🚨🚨 2026-09-01 矛盾Bの直し。入荷日の件数は **ここ1か所** から出す。
       *   上の2つを足した数(＝到着の情報が足りない件数)を、そのまま
       *   「この見立てに入れていません」と書いていたのが食い違いの元。
       *   仮の入荷日を当てた物は :702-713 で計算に入っているのに、
       *   :685 / :693 で入れた箱からは外れていないので、二重に数えていた。
       *   実測 帯3件・カード4件（4件のうち3件は入っているのに「入れていません」）。
       *   ⚠ 画面はここの数と文をそのまま出す。**画面側で数え直さない事。**
       */
      arrival: arrivalQuality,
      arrivalSentences: arrivalSaid,
      missingEstimateCount: unknowns.durationUnknown.length,
      lowConfidenceEstimateCount,
      /**
       * 🚫 記録でほぼ毎回飛ばす工程(2026-09-18)。積まなかった数。
       *   applied … 実際に積まなかったか(鍵が渡っていて countAlwaysSkipped でない時だけ true)
       *   keys    … 鍵(processKeyOf)。stepCount … 積まなかった工程の数(ロット×工程)。lotCount … それが在ったロットの数
       *   minutesByTarget … 目標時間で数えた分(測った値ではない。参考)
       * 🚨 「飛ばしてよい」と決めたのではない。記録がそうなっている工程を積むと誰にも配れずロットが止まるから。
       */
      alwaysSkipped: {
        applied: applyAlwaysSkipped,
        keyCount: skipOnlySet.size,
        keys: [...skipOnlySet].sort(),
        stepCount: alwaysSkippedStepCount,
        lotCount: alwaysSkippedLots.size,
        minutesByTarget: Math.round(alwaysSkippedMinutesByTarget * 10) / 10,
      },
      missingAvailabilityCount,
      legacyWorkerCountConflict,
      // 🚨 設備の要件は scenario.equipmentCapacity で上限を決めた設備が仕事に付いた時だけ「見ている」。
      //   渡されなければ(既定・本番の今の普通)1件も繋がっていないので未評価と言う(D21 / T031)。
      equipmentUnmodeled: equipmentStepCount === 0,
    },

    /**
     * 🆕 「実際の生産に近い状態で」の4本が、いま効いているか・何件へ効いたか。
     * 🚨 画面はここの数をそのまま出す(数え直さない)。
     *   ⚠ on が true でも count が 0 の事は普通に起きる(記録が足りない・班が分からない)。
     *     その時に「効いています」とだけ書くと嘘になるので、必ず件数と一緒に出す事。
     */
    /**
     * 👤 人ごとの残業(2026-09-10)。**誰の何分がどこから来たか**をそのまま返す。
     * 🚨 画面はここの why をそのまま札に出す(数え直さない・言い換えない)。
     *   changedCount が 0 なら「残業の個人設定はこの見立てに1件も効いていません」と言える。
     * ⚠ 登録が1件も無ければ people も changedCount も 0(直す前と同じ姿)。
     */
    workerOvertime: {
      byName: workerDayMinutes,
      people: Object.values(workerDayMinutes).filter((r) => r.source !== 'factory').length,
      changedCount: Object.values(workerDayMinutes).filter((r) => r.changed).length,
      factoryDirectMinutesPerDay: directMinutesPerDayEffective,
      regularDirectMinutesPerDay: regularMinutes,
    },

    realism: {
      arrivalHabit: {
        mode: arrivalHabitMode, on: arrivalHabitMode !== HABIT_MODE.OFF, shiftedLotCount: arrivalHabitCount,
        // 理由の内訳(why → 件数)。⚠ ON の時だけ鍵を出す(切ってある時の答えの形を1バイトも変えない)。
        ...(arrivalHabitMode !== HABIT_MODE.OFF ? { whyCounts: arrivalHabitWhyCounts } : {}),
      },
      workerAvailability: { on: workerAvailabilityOn, profileCount: workerProfileCount },
      splitArrival: { on: splitArrivalOn, splitLotCount: splitArrivalCount },
      shipDeadline: { on: shipOn, leadDays: shipLeadDays, lotCount: shipDeadlineCount, tighterThanInspectCount: shipTighterCount },
      // 🔧 設備: 上限を決めた設備が 何件の工程(ロット×工程)に付いたか。渡されなければ on:false / 0。
      equipment: { on: !!equipmentCapacityTable, stepCount: equipmentStepCount, indexedStepKeys: equipmentIdByStepKey.size },
      warnings: realismWarnings,
    },

    /**
     * 👥 分担の区切り。'none'(既定)なら **鍵ごと出さない**。
     * 🚨 出さないのは「渡されなければ1行も動かない」を形でも守る為で、
     *   simulate.js は scenario.handoff を先に見て、無い時だけここを見る。
     */
    ...(handoffMode !== HANDOFF_MODE.OFF ? { handoff: handoffMode } : {}),
    /**
     * 🧵 ロットは持ったら最後まで / 優先度の区分。合図が立っていない間は **鍵ごと出さない**。
     *   simulate.js は scenario を先に見て、無い時だけここを見る(handoff と同じ流儀)。
     */
    ...(lotFocusOn ? { lotFocus: true } : {}),
    ...(priorityClassOn ? { priorityClass: true } : {}),
    /** 🕒 納期対応の残業・土曜の案が効いているか(日×人の数)。載っていなければ鍵ごと出さない。 */
    ...(overtimePlanOn ? { overtimePlan: { extraCount: overtimePlanExtraCount, workOnCount: overtimePlanWorkOnCount } } : {}),
    /** 📌 手で決めた担当(2026-09-15)。lotId -> 名前('' = この期間は誰にも当てない)。無ければ鍵ごと出さない。 */
    ...(pinsOn ? { pins: pinsNorm.pins } : {}),
    ...(softPinsOn ? { softPins } : {}),
    ...(pinsNorm.dropped.length ? { pinsDropped: pinsNorm.dropped } : {}),

    // ── 既存の読み手が使っている物(消さない) ──
    now: nowMs,
    horizonEnd,
    /**
     * 📅 この見立てで使った工場の暦。画面はこれを
     * 「祝日を引いた計算です」と言い切る根拠に使う。
     * 🚨 登録が0件なら count=0。その時は「祝日を引いていません」と正直に出す。
     */
    factoryCalendar: {
      days: worksOnDay.days,
      count: Object.keys(worksOnDay.days || {}).length,
      workdays: [...workdays],
    },
    // 名前付き作業者の人数。🚨 旧 workloadEffectiveWorkers はここへ入れない(T011)。
    effectiveWorkerCount,
    legacyEffectiveWorkerCount,
    // calendar と同じ物。makeCalendar(normalized.calendarSpec) と書いている所のための別名。
    calendarSpec,
    estimateMode: durationStats ? estMode : ESTIMATE_MODE,
    overtime,
    unknowns,
    // どのフィールドから取ったかの記録。画面の「根拠を見る」がこれをそのまま出す。
    fieldMap: { due: 'lot.dueDate', arrival: 'lot.entryAt' },
    // S24: 既にメモリへ読んだ配列しか触っていない。追加の読取り・書込み・新規コレクションは0。
    diagnostics: { reads: 0, writes: 0, newCollections: 0 },
  };
}
