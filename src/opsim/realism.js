// =============================================================================
//  🎛 本物に近づける設定 — 読み方と、シミュへの渡し方
// -----------------------------------------------------------------------------
//  清水さん(2026-09-07):「実際の生産に近い状態でシミュレーションしたい」
//
//  ここは **純関数だけ**。React も Firebase も入れない(node --test でそのまま回す為)。
//  画面は src/OperationsSimulationPanel.jsx の「🎛 本物に近づける設定」の箱。
//
//  ■ 8つの物
//   ① arrivalHabit  入荷の遅れのクセ ……… off / median / p75
//   ② equipment     設備の取り合い ……… off / observed(実測から) / manual(手で入れる)
//   ③ splitArrival  分納を分けて積む …… off / on
//   ④ shipDeadline  出荷日から逆算した締切(+ 梱包などの営業日数) … off / on
//   ⑤ rework        修正(やり直し)の発生率 … off / median / p75
//   ⑥ interruption  中断(部品待ち・不良対応) … off / median / p75
//   ⑦ workerSpeed   人ごとの速さ ………… off / on
//   ⑧ setupChange   段取り替え ………… off / on
//
//  🚨🚨🚨 **8つとも 既定 OFF**。清水さんが何も選んでいない間は
//    realismForScenario() が **null** を返し、呼ぶ側は scenario へ 1バイトも足さない。
//    ＝ シミュの答えは1ミリも変わらない(既存の見張り 593本がそのまま緑である事が合格の条件)。
//    ⚠ この決まりを崩す直し方(「とりあえず median を既定に」など)は入れない。
//
//  🚨 読めない値・知らない字は **必ず既定(OFF)へ倒す**。
//    「よく分からない字が入っていたので、とりあえず効かせておく」は絶対にしない。
//    (設定の書き間違い1つで、全ロットの見込みが黙って動く形になる)
//
//  ⚠ 置き場は settings.opsim.realism。新しい入れ物を作らない。
//  ⚠ 設備ごとの定員だけは **配列** で別に持つ(settings.opsim.equipmentCapacity)。
//    表({id:n}) にすると merge:true で1件消しても消えない(2026-07-26 の穴)。
//    読み書きの持ち主は domain/operationsSimulation/equipmentCapacity.js の
//    readManualEquipmentCaps ただ1本。ここには写しを作らない。
// =============================================================================

// 🚨 字(モードの名前)は **1つも自分で書かない**。全部 domain の持ち主から読む。
//   ここで 'median' 等を手打ちすると、向こうが名前を変えた時に黙って素通りする形になる。
import { MAX_LEAD_DAYS } from '../domain/operationsSimulation/shipDeadline.js';
import { HABIT_MODE } from '../domain/operationsSimulation/arrivalHabit.js';
import { REWORK_MODE } from '../domain/operationsSimulation/reworkRate.js';
import { INTERRUPTION_MODE } from '../domain/operationsSimulation/interruptionRate.js';
import { SPEED_MODE } from '../domain/operationsSimulation/workerSpeed.js';
import { SETUP_MODE } from '../domain/operationsSimulation/setupChange.js';
// 📊 実績の表を作る純関数(2026-09-10)。🚨 表を作るのは **ここ(buildRealismTable)ただ1か所**。
//   画面(表示の1行)も Worker(計算)も、ここで作った同じ物を使う。Panel と Worker で2回作らない。
import { buildArrivalHabit, groupByLotFromRequests } from '../domain/operationsSimulation/arrivalHabit.js';
import { splitArrivalLoad, LOAD_KIND } from '../domain/operationsSimulation/splitArrivalLoad.js';
import { buildReworkRate } from '../domain/operationsSimulation/reworkRate.js';
import { buildInterruptionRate } from '../domain/operationsSimulation/interruptionRate.js';
import { buildWorkerSpeed } from '../domain/operationsSimulation/workerSpeed.js';
import { buildSetupChange } from '../domain/operationsSimulation/setupChange.js';
// 👤 個人設定の新3欄(曜日ごとの窓 / その日の予定 / 残業)。読み方は workerAvailability.js ただ1本。
import { normalizeWorkerAvailability, countWorkerAvailability } from '../domain/operationsSimulation/workerAvailability.js';
// 👥 分担の区切り(2026-09-10)。🚨 字も言葉も handoff.js ただ1本から取る(ここで書き直さない)。
import { HANDOFF_MODE, HANDOFF_LABEL, normalizeHandoffMode } from '../domain/operationsSimulation/handoff.js';

export { MAX_LEAD_DAYS };

/** 置き場の鍵。🚨 settings.opsim.realism。ここ以外に写しを作らない。 */
export const REALISM_KEY = 'realism';

/** 🚨 既定。全部 OFF(= いままでと1ミリも同じ計算)。 */
export const REALISM_DEFAULT = Object.freeze({
  arrivalHabit: 'off',   // off | median | p75
  equipment: 'off',      // off | observed | manual
  splitArrival: false,
  shipDeadline: false,
  shipLeadDays: 0,
  rework: 'off',         // off | median | p75
  interruption: 'off',   // off | median | p75
  workerSpeed: false,
  setupChange: false,
});

/** 8つの鍵。⚠ 画面の並び順と同じ。見張りがこの並びで数える。 */
export const REALISM_KEYS = Object.freeze([
  'arrivalHabit', 'equipment', 'splitArrival', 'shipDeadline',
  'rework', 'interruption', 'workerSpeed', 'setupChange',
]);

/** 3択(使わない / 中央値 / 悪い方)を使う物。 */
export const REALISM_3_KEYS = Object.freeze(['arrivalHabit', 'rework', 'interruption']);

// 🚨 3択の字は domain の持ち主(arrivalHabit / reworkRate / interruptionRate)と同じ物。
//   3本とも off/median/p75 で揃っている事を、ここで **確かめてから** 使う
//   (片方だけ名前が変わったら、読み込んだ時点で止まる＝黙って素通りしない)。
const REALISM_3 = Object.freeze([HABIT_MODE.OFF, HABIT_MODE.MEDIAN, HABIT_MODE.P75]);
for (const [who, m] of [['reworkRate', REWORK_MODE], ['interruptionRate', INTERRUPTION_MODE]]) {
  if (m.OFF !== HABIT_MODE.OFF || m.MEDIAN !== HABIT_MODE.MEDIAN || m.P75 !== HABIT_MODE.P75) {
    throw new Error(`realism.js: ${who} の3択の字が arrivalHabit と揃っていません（画面の札が意味を持たなくなります）`);
  }
}
const REALISM_EQUIP_MODES = Object.freeze(['off', 'observed', 'manual']);
const pick3 = (v) => (REALISM_3.includes(String(v)) ? String(v) : HABIT_MODE.OFF);

/**
 * 設定を読む。
 * 🚨 読めない値・知らない字は **必ず既定(OFF)へ倒す**。
 * @param {object|null} settings 設定の doc(config)
 * @returns {typeof REALISM_DEFAULT} 8つとも必ず埋まった形
 */
export const readOpsimRealism = (settings) => {
  const raw = (settings && settings.opsim && settings.opsim[REALISM_KEY]) || null;
  if (!raw || typeof raw !== 'object') return REALISM_DEFAULT;
  const lead = Number(raw.shipLeadDays);
  return {
    arrivalHabit: pick3(raw.arrivalHabit),
    equipment: REALISM_EQUIP_MODES.includes(String(raw.equipment)) ? String(raw.equipment) : 'off',
    splitArrival: raw.splitArrival === true,
    shipDeadline: raw.shipDeadline === true,
    shipLeadDays: (Number.isInteger(lead) && lead >= 0 && lead <= MAX_LEAD_DAYS) ? lead : 0,
    rework: pick3(raw.rework),
    interruption: pick3(raw.interruption),
    workerSpeed: raw.workerSpeed === true,
    setupChange: raw.setupChange === true,
  };
};

/**
 * scenario へ足す合図を作る。
 *
 * 🚨🚨 全部 既定のままなら **null**。呼ぶ側は null の時 scenario へ何も足さない。
 *   ここが「渡されなければ1行も動かない」の要。
 * ⚠ 選ばれた物だけを鍵として出す(off の鍵は出さない)。指紋(stableKey)が
 *   「使わない」の並びで長くなると、選んでいないのに計算し直す形になる。
 *
 * ⚠⚠ 鍵の名前は **scenario の鍵の約束(2026-09-10 まとめ役が決めた。画面が書き、エンジンが読む)** の物だけ:
 *   arrivalHabitMode / splitArrivalOn / shipDeadline:{on,leadDays} / reworkMode / interruptionMode /
 *   workerSpeedMode / setupChangeMode。ここで別の名前を作ると「押しても効かない画面」になる。
 *   🚨 旧い shipDeadlineOn / shipDeadlineLeadDays は **廃止**(ChatGPT が見つけた④: 画面は
 *     shipDeadlineLeadDays を書き、normalizeInput は shipDeadline.leadDays を読んでいて日数が届かなかった)。
 * ⚠ ② 設備の取り合いだけは合図ではなく **定員の表そのもの** を渡す
 *   （区画の定員 scenario.zoneCapacity と同じ型紙。呼ぶ側が sc.equipmentCapacity に入れる）。
 * ⚠ ここが出すのは **合図だけ**。実績の表(入荷のクセ / 便の一覧 / 修正率 …)は
 *   realismScenarioOf が合図の隣に載せる(合図が ON の物だけ)。
 *
 * @param {object|null} cfg readOpsimRealism の戻り
 * @returns {object|null} scenario へ Object.assign する物
 */
export const realismForScenario = (cfg) => {
  const c = cfg || REALISM_DEFAULT;
  const out = {};
  // ① 入荷の遅れのクセ
  if (c.arrivalHabit !== HABIT_MODE.OFF) out.arrivalHabitMode = c.arrivalHabit;
  // ③ 分納を分けて積む
  if (c.splitArrival === true) out.splitArrivalOn = true;
  // ④ 出荷日から逆算した締切。🚨 鍵は shipDeadline:{ on, leadDays } **ただ1つ**
  //   （梱包などの日数も同じ鍵の中。押した数が指紋に入らないと計算し直さない）。
  if (c.shipDeadline === true) {
    out.shipDeadline = { on: true, leadDays: c.shipLeadDays };
  }
  // ⑤ 修正（やり直し）の発生率
  if (c.rework !== REWORK_MODE.OFF) out.reworkMode = c.rework;
  // ⑥ 中断（部品待ち・不良対応）
  if (c.interruption !== INTERRUPTION_MODE.OFF) out.interruptionMode = c.interruption;
  // ⑦ 人ごとの速さ。⚠ ON は「人×工程が在ればそれ、無ければ その人ぜんぶへ落ちる」= WORKER_STEP。
  if (c.workerSpeed === true) out.workerSpeedMode = SPEED_MODE.WORKER_STEP;
  // ⑧ 段取り替え。⚠ ON は「工程ごとの実測。無ければ まとめた値」= BY_STEP。
  if (c.setupChange === true) out.setupChangeMode = SETUP_MODE.BY_STEP;
  return Object.keys(out).length ? out : null;
};

/**
 * ② 設備の取り合いで「過去の実測を上限に使ってよいか」。
 * ⚠ 'observed' の時だけ true。'manual' は人が書いた数だけを使う。
 */
export const wantsObservedEquipment = (cfg) => ((cfg || REALISM_DEFAULT).equipment === 'observed');

// =============================================================================
//  📊 実績の表 — 作るのは **ここ1か所**。画面の1行も Worker の計算も同じ物を使う。
// -----------------------------------------------------------------------------
//  ChatGPT が見つけた②(2026-09-10): 画面は表示の為に buildXxx を呼ぶだけで、scenario には
//  合図(reworkMode 等)しか入れていなかった。simulate.js は scenario.reworkRates(表)が無いと
//  1秒も足さないので、「使う」を押しても答えが1ミリも変わらなかった。
//
//  ■ 表の鍵(scenario の鍵の約束。この名前以外を使わない)
//    arrivalHabit      … { habit: buildArrivalHabit の戻り, groupByLot: {lotId: 班} }
//                        ⚠ ロットには班の欄が無い(本番の写しで確認)ので、連絡(contact_requests)から
//                          作った lotId→班 を隣に置く。無いと applyArrivalHabit が 'noGroup' で素通りする。
//    splitArrival      … { byLot: { [lotId]: arrival_times/{lotId} の中身 } }(2便以上のロットだけ)
//    reworkRates       … buildReworkRate の戻り
//    interruptionRates … buildInterruptionRate の戻り
//    workerSpeed       … buildWorkerSpeed の戻り
//    setupChange       … buildSetupChange の戻り
//  🚨 どれも **生の値だけ**(関数・Map・Set を入れない)。Worker へは構造化複製で渡るので、
//    関数を入れると黙って消える(2026-08-16 と同じ形の事故)。試験が JSON 往復で確かめる。
// =============================================================================

/** 表の鍵(scenario に載る名前)。⚠ 画面の並び順(REALISM_KEYS)と同じ向き。 */
export const REALISM_TABLE_KEYS = Object.freeze([
  'arrivalHabit', 'splitArrival', 'reworkRates', 'interruptionRates', 'workerSpeed', 'setupChange',
]);

/** 表の鍵 → それを効かせる設定の鍵(readOpsimRealism の戻りの鍵)。 */
const TABLE_TO_CFG = Object.freeze({
  arrivalHabit: 'arrivalHabit',
  splitArrival: 'splitArrival',
  reworkRates: 'rework',
  interruptionRates: 'interruption',
  workerSpeed: 'workerSpeed',
  setupChange: 'setupChange',
});

/**
 * その表が計算に **要る** か(設定が ON か)。
 * 🚨 既定(全部 OFF)では6つとも false = 表を1つも作らない・scenario へ1つも載せない。
 * @param {object|null} cfg readOpsimRealism の戻り
 * @param {string} tableKey REALISM_TABLE_KEYS の1つ
 */
export const realismTableWanted = (cfg, tableKey) => {
  const c = cfg || REALISM_DEFAULT;
  const v = c[TABLE_TO_CFG[tableKey]];
  if (v === undefined) return false;
  return typeof v === 'boolean' ? v === true : v !== HABIT_MODE.OFF;
};

/**
 * 表を1つ作る。🚨 数字は全部 domain の純関数の戻り。ここで数え直さない。
 * @param {string} tableKey REALISM_TABLE_KEYS の1つ
 * @param {object} src
 *   lots            … **全ロット**(完了込み。実績は完了ロットから出る)
 *   arrivalActuals  … arrival_actuals の一覧(到着のクセ)。配列でなければ表は作らない(null)
 *   contactRequests … contact_requests の一覧(班の補い)
 *   arrivalByLot    … { [lotId]: arrival_times の中身 }(分納)
 *   lotIdOf         … ロットから id を取る(既定 __id → id)
 * @returns {object|null} 表(材料が無い時は null。null は scenario に載せない = エンジンが warnings に1行出す)
 */
export const buildRealismTable = (tableKey, {
  lots = [], arrivalActuals = null, contactRequests = null, arrivalByLot = null, lotIdOf = null,
} = {}) => {
  const list = Array.isArray(lots) ? lots.filter(Boolean) : [];
  const idOf = typeof lotIdOf === 'function' ? lotIdOf : ((l) => String((l && (l.__id || l.id)) || ''));
  switch (tableKey) {
    case 'arrivalHabit': {
      if (!Array.isArray(arrivalActuals)) return null;
      const requests = Array.isArray(contactRequests) ? contactRequests : [];
      return {
        habit: buildArrivalHabit({ actuals: arrivalActuals, requests }),
        groupByLot: groupByLotFromRequests(requests),
      };
    }
    case 'splitArrival': {
      // 2便以上に分かれているロットだけを載せる(1便の物は載せても何も変わらないし、指紋が無駄に長くなる)。
      const table = (arrivalByLot && typeof arrivalByLot === 'object') ? arrivalByLot : {};
      const byLot = {};
      for (const lot of list) {
        const id = idOf(lot);
        const arrival = id ? (table[id] || null) : null;
        if (!arrival) continue;
        const load = splitArrivalLoad({ lot, arrival });
        if (load.kind === LOAD_KIND.SPLIT) byLot[id] = arrival;
      }
      return { byLot };
    }
    case 'reworkRates': return buildReworkRate({ lots: list });
    case 'interruptionRates': return buildInterruptionRate({ lots: list });
    case 'workerSpeed': return buildWorkerSpeed({ lots: list });
    case 'setupChange': return buildSetupChange({ lots: list });
    default:
      throw new Error(`realism.js: 知らない表の鍵です: ${String(tableKey)}`);
  }
};

/**
 * 画面が scenario へ足す物(合図 + 合図が ON の表)。**useMemo の中身をそのまま純関数にした物**。
 *
 * 🚨🚨 全部 OFF なら **null**(realismForScenario と同じ)。呼ぶ側は null の時1バイトも足さない。
 * 🚨 表は **合図が ON の物だけ** 載せる。OFF の表を載せると指紋が伸びて「選んでいないのに計算し直す」。
 * ⚠ 合図は ON なのに表が無い(null)時は、合図だけ載せる。エンジン(normalizeInput / simulate)が
 *   「記録が渡されていません」を warnings に出す(黙って素通りしない)。
 *
 * @param {object} o
 * @param {object|null} o.cfg    readOpsimRealism の戻り
 * @param {object|null} o.tables { [REALISM_TABLE_KEYS]: 表|null }(buildRealismTable の戻りを鍵ごとに)
 * @returns {object|null}
 */
export const realismScenarioOf = ({ cfg = null, tables = null } = {}) => {
  const signals = realismForScenario(cfg);
  if (!signals) return null;
  const out = { ...signals };
  const t = (tables && typeof tables === 'object') ? tables : {};
  for (const key of REALISM_TABLE_KEYS) {
    if (!realismTableWanted(cfg, key)) continue;
    const table = t[key];
    if (table && typeof table === 'object') out[key] = table;
  }
  return out;
};

/**
 * ① 👤 個人の 曜日ごとの窓／有給・出張・会議 を暦に効かせる合図。
 *
 * 🚨 合図の設定は無い。**登録が合図**(2026-09-10 まとめ役): 曜日ごとの窓(byWeekday)か
 *   その日の予定(days)を登録した人が1人でも居れば { workerAvailabilityOn: true }。
 * 🚨 登録が無ければ **null**(鍵ごと出さない = 今までと1バイトも同じ)。
 * ⚠ 残業(overtime)だけの登録では立てない(窓も休みも動かないので、立てても答えが変わらない)。
 * ⚠ 名簿(rosterNames)に居ない人の登録は数えない(退職・休止の人の設定が残っていても effect なし。
 *   normalizeInput も同じ名簿で切るので、ここだけ立てると「合図は立つが暦は変わらない」になる)。
 *
 * @param {object|null} settings 設定の doc(config)。settings.workerProfiles を読む
 * @param {object} [o]
 * @param {string[]|null} [o.rosterNames] 名簿(作業者マスタの名前)。null なら名簿で切らない
 * @returns {{workerAvailabilityOn: true}|null}
 */
export const workerAvailabilityScenarioOf = (settings, { rosterNames = null } = {}) => {
  const raw = (settings && typeof settings === 'object') ? settings.workerProfiles : null;
  if (!raw || typeof raw !== 'object') return null;
  const { profiles } = normalizeWorkerAvailability(raw, { rosterNames });
  const c = countWorkerAvailability(profiles);
  return (c.weekday > 0 || c.days > 0) ? { workerAvailabilityOn: true } : null;
};

/** 3択・2択の札。⚠ 言葉は短く(1つ1行に収める)。 */
export const REALISM_3_CHOICES = Object.freeze([
  { key: 'off', label: '使わない' },
  { key: 'median', label: '中央値' },
  { key: 'p75', label: '悪い方' },
]);
export const REALISM_ONOFF_CHOICES = Object.freeze([
  { key: 'off', label: '使わない' },
  { key: 'on', label: '使う' },
]);
export const REALISM_EQUIP_CHOICES = Object.freeze([
  { key: 'off', label: '使わない' },
  { key: 'observed', label: '実測から' },
  { key: 'manual', label: '手で入れる' },
]);

/** 定員の入力を正す。空欄は null(= 実測へ戻す)。1以上の整数だけ通す。 */
export const normalizeCapInput = (text) => {
  const t = String(text == null ? '' : text).trim();
  if (t === '') return { cap: null, ok: true };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1) return { cap: null, ok: false };
  return { cap: n, ok: true };
};

/** 梱包などの営業日数を正す。0〜MAX_LEAD_DAYS の整数だけ通す。 */
export const normalizeLeadInput = (text) => {
  const t = String(text == null ? '' : text).trim();
  if (t === '') return { days: 0, ok: true };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_DAYS) return { days: 0, ok: false };
  return { days: n, ok: true };
};

// =============================================================================
//  👥 分担の区切り — 画面の設定(settings.opsim.handoff)と、計算への渡し方
// -----------------------------------------------------------------------------
//  清水さん(2026-09-10 20:30 納期一覧の写真を見て):
//    「分担って書いてあるけど、なんで分担したって書いてないからわかりづらい」
//    「後分担するときはできたら一台毎で区切る感じじゃないとだめだからね、
//      区切りの良いところで分担ならOKね」「こういう設定もいるからね」
//
//  🚨 言葉(札)は domain/operationsSimulation/handoff.js の HANDOFF_LABEL から **そのまま** 取る。
//    ここで書き直すと、設定の札と 分担の理由の札が別の言い方になる。
//  🚨 エンジン(handoff.js)の既定は 'none' のまま＝ **渡されなければ1行も動かない**。
//    'unit' を効かせるのは **画面が渡すから**。エンジンの既定はここでは触らない。
//  🚨 黙って既定を効かせない: まだ誰も選んでいない時は札の横に「既定（清水さんの指定）」を出し、
//    ⚙(条件・根拠)にも handoffBasisLine の1行を出す。
// =============================================================================

/** 置き場の鍵。🚨 settings.opsim.handoff。ここ以外に写しを作らない。 */
export const HANDOFF_KEY = 'handoff';

/**
 * 🚨 **画面の既定**。清水さん(2026-09-10)「一台毎で区切る感じじゃないとだめだからね」。
 * ⚠ エンジンの既定は HANDOFF_MODE.OFF('none') のまま。ここは「画面が渡す既定」。
 */
export const HANDOFF_PANEL_DEFAULT = HANDOFF_MODE.UNIT;

/** まだ誰も選んでいない時に添える札。🚨 黙って既定を効かせない為の物。 */
export const HANDOFF_DEFAULT_NOTE = '既定（清水さんの指定）';

/** 札の並び。⚠ 言葉は handoff.js の HANDOFF_LABEL そのもの(画面で書き直さない)。 */
export const HANDOFF_CHOICES = Object.freeze(
  [HANDOFF_MODE.OFF, HANDOFF_MODE.SOFT, HANDOFF_MODE.UNIT]
    .map((key) => Object.freeze({ key, label: HANDOFF_LABEL[key] })),
);

/**
 * 素の実測の1行。
 * 【本番の写し 2026-09-10_1000 で実測(読むだけ)】
 *   過去の記録(完了した工程の作業者名で数えた) … 台 1092件 / 1台の途中で人が替わった台 18件(1.6%)
 *   いまの計算(5営業日・通常・2026-09-10 08:30 起点) … 台 179件 / 途中で替わった台 37件(20.7%)
 *   数え直す道具: inspection-audit-local/_handoff_measure.mjs [none|soft|unit]
 * 🚨 「この設定で◯%良くなる」ではなく、過去と いまの計算がどうだったかだけを言う。
 */
export const HANDOFF_FACT = '本番の記録では 1台の途中で人が替わった台は 1092台中18台(1.6%)。いまの計算は 179台中37台(20.7%)（2026-09-10 の写しで実測）';

/**
 * 設定を読む。
 * 🚨 読めない字・未登録は **画面の既定**('unit')へ倒す。registered=false で
 *   「まだ誰も選んでいない」を返す(札と根拠に「既定（清水さんの指定）」を出す為)。
 * @param {object|null} settings 設定の doc(config)
 * @returns {{mode:'none'|'soft'|'unit', registered:boolean}}
 */
export const readOpsimHandoff = (settings) => {
  const op = (settings && typeof settings === 'object') ? settings.opsim : null;
  const raw = (op && typeof op === 'object') ? op[HANDOFF_KEY] : undefined;
  const s = (typeof raw === 'string') ? raw.trim() : '';
  const known = (s === HANDOFF_MODE.OFF || s === HANDOFF_MODE.SOFT || s === HANDOFF_MODE.UNIT);
  if (!known) return { mode: HANDOFF_PANEL_DEFAULT, registered: false };
  return { mode: normalizeHandoffMode(s), registered: true };
};

/**
 * scenario へ渡す字。🚨 画面は **必ず** 渡す(未登録なら既定の 'unit')。
 * ⚠ エンジンは渡されなければ 'none'。だから「渡す」のがこちらの仕事。
 * @param {object|null} settings
 * @returns {'none'|'soft'|'unit'}
 */
export const handoffForScenario = (settings) => readOpsimHandoff(settings).mode;

/**
 * ⚙(条件・根拠)へ出す1行。🚨 言葉は HANDOFF_LABEL そのまま。
 * 未登録の時は「既定（清水さんの指定）」を添える(黙って効かせない)。
 * @param {object|null} settings
 * @returns {string}
 */
export const handoffBasisLine = (settings) => {
  const { mode, registered } = readOpsimHandoff(settings);
  const head = `分担の区切り: ${HANDOFF_LABEL[mode]}`;
  return registered ? head : `${head} … ${HANDOFF_DEFAULT_NOTE}`;
};

/**
 * 指紋の1切れ。
 * 🚨 これが runKey(＝土俵 groundKey = inputFingerprint)に入っていないと、
 *   区切りを変える **前** に貯めた「通常との差」の表が、変えた **後** の数字と混ざる。
 * ⚠ settings.opsim は丸ごとは指紋(SETTINGS_KEYS)へ足さない決まり(scenario 経由で二重に数えない)なので、
 *   **割付そのものが変わるこの1つだけ** を名指しで足す。
 * @param {object|null} settings
 * @returns {string}
 */
export const handoffFingerprintOf = (settings) => `handoff=${readOpsimHandoff(settings).mode}`;

// =============================================================================
//  🧵 ロットは持ったら最後まで ／ 🚩 優先度の区分を割付の先頭に
//    — 画面の設定(settings.opsim.lotFocus / settings.opsim.priorityClass)と、計算への渡し方
// -----------------------------------------------------------------------------
//  清水さん(2026-09-10 23:30 人ごとの指示の写真2枚を見て):
//    「なんでこんなぐちゃぐちゃの仕事になるの？これならロット処理して次のロットでいいでしょ」
//    「優先度で通常と特注と緊急にして、優先度は緊急＞特注＞通常みたいな感じにして
//      シュミレーション時のときの優先度に反映するようにして」
//
//  🚨 鍵の名前は scenario の鍵の約束(2026-09-10 まとめ役)の物だけ:
//    scenario.lotFocus = true       … ロットを持ったら最後まで
//    scenario.priorityClass = true  … 優先度の区分を割付の先頭の鍵にする
//    OFF の時は **鍵ごと出さない**(false を書かない)。エンジンは渡されなければ1行も動かない。
//  🚨 画面の既定は2つとも ON(清水さんの指定)。エンジンの既定は「無し」のまま＝渡すのは画面の仕事。
//  🚨 黙って既定を効かせない: まだ誰も選んでいない時は札の横に「既定（清水さんの指定）」を出し、
//    ⚙(条件・根拠)にも1行ずつ出す(handoff と同じ形)。
//  🚨 読めない値(true/false 以外)は **既定(ON)へ倒し registered:false**。
// =============================================================================

/** 置き場の鍵。🚨 settings.opsim.lotFocus / settings.opsim.priorityClass。ここ以外に写しを作らない。 */
export const LOT_FOCUS_KEY = 'lotFocus';
export const PRIORITY_CLASS_KEY = 'priorityClass';

/** 🚨 画面の既定。2つとも ON(清水さんの指定)。エンジンの既定は「無し」のまま。 */
export const LOT_FOCUS_PANEL_DEFAULT = true;
export const PRIORITY_CLASS_PANEL_DEFAULT = true;

/** まだ誰も選んでいない時に添える札。⚠ handoff と同じ言葉(HANDOFF_DEFAULT_NOTE)。 */
export const LOT_FOCUS_DEFAULT_NOTE = HANDOFF_DEFAULT_NOTE;

/** 札(使わない／使う)。⚠ 8つの 🎛 の2択と同じ物。 */
export const LOT_FOCUS_CHOICES = REALISM_ONOFF_CHOICES;

/** ⚙(条件・根拠)と 🎛 の見出しの言葉。🚨 ここ以外で書き直さない。 */
export const LOT_FOCUS_LABEL = '🧵 ロットは持ったら最後まで';
export const PRIORITY_CLASS_LABEL = '🚩 優先度の区分を割付の先頭に（緊急＞特注＞通常）';

/**
 * 素の実測の1行(🧵)。
 * 【本番の写し 2026-09-10_1000 で実測(読むだけ・5営業日・分担の区切り=1台は同じ人)】
 *   ロットの持ち替え(前の仕事と別のロットへ移った回数) … 片山40回 / 尾田42回 / 信濃20回 / 村18回
 *   1日に触った最大ロット数 … 片山14 / 尾田11 / 信濃8 / 村4
 *   写真(2026-09-10 23:30): 片山さん 08:30 RWB-500K を始めて 08:33 に TBS-130 を始め 10:16 に戻る
 *   数え直す道具: inspection-audit-local/_lot_switch_measure.mjs [unit|lot]
 * 🚨 「この設定で◯%良くなる」ではなく、いまの計算がどうだったかだけを言う。
 */
export const LOT_FOCUS_FACT = 'いまの計算(2026-09-10 の写し・5営業日)では 1人が1日にロットを持ち替えた回数は 片山40回・尾田42回・信濃20回・村18回、1日に触った最大ロット数は 片山14・尾田11・信濃8・村4（3分の準備を終えた人に別のロットの一番急ぐ仕事が渡っていた）';

/**
 * 素の実測の1行(🚩)。
 * 【本番の写し 2026-09-10_2310 で実測(読むだけ)】 lots 579件 … priority 'normal' 577件 / 未記入 2件 / 'high' 0件。
 *   計算(simulate / priority)はこれまで lot.priority を1度も読んでいなかった(まとめ役がコードで確認)。
 */
export const PRIORITY_CLASS_FACT = '本番の写し(2026-09-10)では 579件中 通常577件・未記入2件・緊急0件。これまでの計算は優先度を1度も読んでいなかった（納期と工程の順だけ）';

/**
 * true/false だけを「登録した」と読む。それ以外は既定へ倒す。
 * @param {object|null} settings
 * @param {string} key LOT_FOCUS_KEY | PRIORITY_CLASS_KEY
 * @param {boolean} def 既定
 * @returns {{on:boolean, registered:boolean}}
 */
const readOpsimBool = (settings, key, def) => {
  const op = (settings && typeof settings === 'object') ? settings.opsim : null;
  const raw = (op && typeof op === 'object') ? op[key] : undefined;
  if (raw === true || raw === false) return { on: raw, registered: true };
  return { on: def, registered: false };
};

/** 👤 「このテンプレを優先」の強さ。settings.opsim.templatePrefMode。ここ以外に写しを作らない。 */
export const TEMPLATE_PREF_MODE_KEY = 'templatePrefMode';
export const TEMPLATE_PREF_MODE_CHOICES = Object.freeze([
  { key: 'order', label: '順番だけ' },
  { key: 'reserve', label: 'その人を待つ' },
]);
export const TEMPLATE_PREF_MODE_LABEL = '👤 「このテンプレを優先」の強さ';
/**
 * 素の実測の1行。
 * 【本番の写し 2026-09-16 深夜で実測】「順番だけ」は 同じ瞬間に手が空いている人の中での並びなので、優先の人が別のロットを
 *   持っている間は他の人へ渡る＝画面に優先の跡がほぼ出ない。「その人を待つ」は 納期に余裕がある間(いま + 所要×2 ≦ 納期線)だけ
 *   その人の手が空くのを待つ。効いた件数は 手が空く帯の「優先テンプレの仕事 N件中 M件」で数える。
 */
export const TEMPLATE_PREF_MODE_FACT = '「順番だけ」は同じ瞬間に空いている人の中の並びだけ(優先の人が別のロットを持っていると他の人へ渡る)。「その人を待つ」は納期に余裕がある間だけ待つ';
/** 👤 の設定を読む。'reserve' だけを「待つ」と読む。それ以外は 'order'(今まで)・registered:false。 */
export const readOpsimTemplatePrefMode = (settings) => {
  const op = (settings && typeof settings === 'object') ? settings.opsim : null;
  const raw = (op && typeof op === 'object') ? op[TEMPLATE_PREF_MODE_KEY] : undefined;
  if (raw === 'reserve' || raw === 'order') return { mode: raw, registered: true };
  return { mode: 'order', registered: false };
};

/** 🧵 の設定を読む。未登録・読めない値 → 既定(ON)・registered:false。 */
export const readOpsimLotFocus = (settings) => readOpsimBool(settings, LOT_FOCUS_KEY, LOT_FOCUS_PANEL_DEFAULT);

/** 🚩 の設定を読む。未登録・読めない値 → 既定(ON)・registered:false。 */
export const readOpsimPriorityClass = (settings) => readOpsimBool(settings, PRIORITY_CLASS_KEY, PRIORITY_CLASS_PANEL_DEFAULT);

/**
 * scenario へ足す合図。🚨 ON の物だけ鍵を出す(OFF は鍵ごと出さない)。2つとも OFF なら **null**。
 * @param {object|null} settings
 * @returns {{lotFocus?:true, priorityClass?:true}|null}
 */
export const lotFocusScenarioOf = (settings) => {
  const out = {};
  if (readOpsimLotFocus(settings).on) out.lotFocus = true;
  if (readOpsimPriorityClass(settings).on) out.priorityClass = true;
  return Object.keys(out).length ? out : null;
};

const onOffWord = (on) => (on ? REALISM_ONOFF_CHOICES[1].label : REALISM_ONOFF_CHOICES[0].label);

/** ⚙(条件・根拠)の1行(🧵)。未登録なら「既定（清水さんの指定）」を添える。 */
export const lotFocusBasisLine = (settings) => {
  const { on, registered } = readOpsimLotFocus(settings);
  const head = `${LOT_FOCUS_LABEL}: ${onOffWord(on)}`;
  return registered ? head : `${head} … ${LOT_FOCUS_DEFAULT_NOTE}`;
};

/** ⚙(条件・根拠)の1行(🚩)。未登録なら「既定（清水さんの指定）」を添える。 */
export const priorityClassBasisLine = (settings) => {
  const { on, registered } = readOpsimPriorityClass(settings);
  const head = `${PRIORITY_CLASS_LABEL}: ${onOffWord(on)}`;
  return registered ? head : `${head} … ${LOT_FOCUS_DEFAULT_NOTE}`;
};

/**
 * 指紋の1切れ。🚨 割付そのものが変わる2つなので、runKey(＝土俵 groundKey)に名指しで足す
 *   (足さないと「押しても計算し直さない」＋ 変える前に貯めた「通常との差」の表が混ざる)。
 * @param {object|null} settings
 * @returns {string}
 */
export const lotFocusFingerprintOf = (settings) => (
  `lotFocus=${readOpsimLotFocus(settings).on ? 'on' : 'off'}|priorityClass=${readOpsimPriorityClass(settings).on ? 'on' : 'off'}`
);
