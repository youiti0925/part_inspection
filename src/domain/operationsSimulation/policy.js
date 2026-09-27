// 操業シミュレーター — 時間・予測範囲・教育制約の「単一ポリシー」
// 出典: docs/製品検査_操業シミュレーター_完全是正実装仕様書_2026-08-23.md の 5.1 と 6.2。
// 受入試験: 同 8.1 の T001（通常420分）/ T002（残業540分の頭打ちと警告）。
//
// このファイルが持つ責任はただ1つ:
//   「1日に何分働ける事にするか」「何日先まで見るか」「教育へ回してよい余力はどれだけか」を
//   ここ1箇所だけで決める。他のモジュール（calendar / normalizeInput / simulate / 画面）は
//   数字を直書きせず、必ずここから受け取る。
//
// 🚨 いちばん大事な決め事（仕様書3章・D01/D02。再解釈しない）:
//   通常 1人1日 420分 ／ 残業込みの上限 1人1日 540分。
//   これは **業務上の決定** であって、勤務表から計算した値ではない。
//   - settings.workSchedule（08:30-17:00 から休憩を引いた440分 など）から作り直さない。
//   - settings.indirectFactor（本番 1.3）で **黙って** 割らない。割ると通常が約323分になり、
//     人手不足を過大に表示する。これが直前の実装で起きていた誤りそのもの。
//   ⚠ 2026-09-05 清水さん「今のシミュレーションって直工比率の補正かけてないかも。どこかで計算方法を設定するようにした方がいい」
//     → 管理者が settings.operationPolicy.applyIndirectFactor = true を **明示** した時だけ、係数で割る(下の applyIndirectFactor)。
//       設定の口はこの1つ。全体進捗も操業シミュレーションも policy の分数を読むので、両方に同じく効く。
//   したがって **このファイルは workSchedule を1度も読まない**。読んでいたら誤り。
//
// 🚨 決め事（CONTRACT.md 0章）:
//   - React / Firebase を import しない。純関数だけ。
//   - 関数の中で現在時刻や乱数を取らない。同じ入力なら毎回同じ結果になる事（S23）。
//   - 分からない値・範囲から外れた値を黙って丸めない。既定へ戻し、warnings に日本語で1行残す。

// ── 既定のポリシー（仕様書5.1 の定義そのまま） ───────────────────────────────
/**
 * 既定の操業ポリシー。
 * 🚨 ここの数字を書き換える時は、先に仕様書3章の表を直す事。
 */
export const DEFAULT_OPERATION_POLICY = Object.freeze({
  schemaVersion: 1,
  regularDirectMinutesPerDay: 420,   // 通常 1人1日（7時間）
  overtimeDirectMinutesPerDay: 540,  // 残業込みの上限 1人1日（9時間）
  applyIndirectFactor: false,        // 直工比率の補正(settings.indirectFactor で割る)を掛けるか。既定は掛けない
  uiStepFraction: 0.3,               // 画面の1目盛り。通常126分 / 残業162分（仕様書5.2）
  defaultHorizonDays: 5,
  horizonOptions: Object.freeze([5, 30]),
  workdays: Object.freeze([1, 2, 3, 4, 5]), // 0=日 .. 6=土。月〜金（仕様書3章）
  dueCutoff: 'regular-work-end',     // 日付だけの納期 = その日の通常勤務終了時刻（仕様書5.3）
  provisionalReserveMinutesPerDay: 60, // 教育へ使い切らないための予備。まだ「暫定」（仕様書3章）
  maxOjtPairsPerDay: 1,
});

/**
 * 管理者が保存できる値の範囲（仕様書6.2）。画面が「いくつまで入れられるか」を出す時にも使う。
 * 残業の下限は、解決後の通常分（既定420分）。表の min は形の検算用の下限。
 */
export const OPERATION_POLICY_LIMITS = Object.freeze({
  regularDirectMinutesPerDay: Object.freeze({ min: 1, max: 720 }),
  overtimeDirectMinutesPerDay: Object.freeze({ min: 1, max: 720 }),
  uiStepFraction: Object.freeze({ min: 0.1, max: 1.0 }),
  horizonDays: Object.freeze({ min: 1, max: 90 }),
  provisionalReserveMinutesPerDay: Object.freeze({ min: 0, max: 480 }),
  maxOjtPairsPerDay: Object.freeze({ min: 0, max: 10 }),
});

/** 管理者が settings.operationPolicy へ保存しても取り込まない項目（仕様書3章で決まっている物）。 */
const FIXED_KEYS = Object.freeze(['schemaVersion', 'workdays', 'dueCutoff']);

/** 管理者が保存できる項目。ここに無い名前は取り込まず、warnings へ出す。 */
const TUNABLE_KEYS = Object.freeze([
  'regularDirectMinutesPerDay',
  'overtimeDirectMinutesPerDay',
  'applyIndirectFactor',
  'uiStepFraction',
  'defaultHorizonDays',
  'horizonOptions',
  'provisionalReserveMinutesPerDay',
  'maxOjtPairsPerDay',
]);

// ── 小道具 ───────────────────────────────────────────────────────────────────

/** 保存されていた値を、警告文へ短く載せる形にする。長い物は途中で切る。 */
const showValue = (value) => {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = null; }
    if (text === undefined || text === null) text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

/**
 * 管理者が「明示的に保存した」と見なすか。
 * null / undefined は「保存していない（既定でよい）」として扱い、警告も出さない。
 */
const isProvided = (block, key) => (
  Object.prototype.hasOwnProperty.call(block, key) && block[key] !== null && block[key] !== undefined
);

/**
 * 整数として受け取る。
 * 🚨 数値以外（'420' のような文字列を含む）は受けない。保存の道が壊れている合図なので、
 *    黙って直さず既定へ戻して警告する。丸めもしない。
 * @returns {number|null} 取り込めた時だけ数値。それ以外は null（＝既定を使う）
 */
const takeInteger = (value, min, max) => (
  (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) ? value : null
);

/** 小数を受け取る（uiStepFraction 用）。 */
const takeFraction = (value, min, max) => (
  (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) ? value : null
);

/** 予測日数の選択肢。1〜90 の整数の配列で、重複を除いて昇順に並べ直した物だけ受ける。 */
const takeHorizonOptions = (value, min, max) => {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const v of value) {
    if (takeInteger(v, min, max) === null) return null;
  }
  const uniq = [...new Set(value)].sort((a, b) => a - b);
  return Object.freeze(uniq);
};

// ── 本体 ─────────────────────────────────────────────────────────────────────

/**
 * 操業ポリシーを決める。
 *
 * 受ける物は **settings.operationPolicy に管理者が明示保存した値だけ**。
 * settings.workSchedule / settings.indirectFactor / settings.workloadEffectiveWorkers からは
 * 1つも作らない（仕様書5.1・D01・D02・D07）。
 *
 * @param {object|null|undefined} settings アプリの設定。無くてもよい（既定で返す）
 * @returns {{
 *   policy: Readonly<typeof DEFAULT_OPERATION_POLICY>,
 *   sources: Readonly<Record<string, 'default'|'admin'>>,
 *   warnings: ReadonlyArray<string>,
 *   legacyIndirectFactor: number|null,
 * }}
 *   policy … 計算と画面が使う値
 *   sources … 項目ごとの出どころ。'default'（既定のまま）か 'admin'（管理者が保存した値）か 'indirect-factor'（係数で割った値）
 *   warnings … 範囲から外れた値を既定へ戻した時などの、日本語1行の知らせ
 *   legacyIndirectFactor … 旧 settings.indirectFactor。**診断の表示だけ** に使う。
 *                          policy の中には入れない＝能力の計算には一切効かない（仕様書5.1）
 */
export function resolveOperationPolicy(settings) {
  const warnings = [];
  const sources = {};
  const policy = {};

  // 既定で埋めてから、管理者が保存した値だけを上書きする。
  for (const key of Object.keys(DEFAULT_OPERATION_POLICY)) {
    policy[key] = DEFAULT_OPERATION_POLICY[key];
    sources[key] = 'default';
  }

  const rawBlock = (settings && typeof settings === 'object') ? settings.operationPolicy : undefined;
  let block = null;
  if (rawBlock !== null && rawBlock !== undefined) {
    if (typeof rawBlock === 'object' && !Array.isArray(rawBlock)) {
      block = rawBlock;
    } else {
      warnings.push(
        `settings.operationPolicy は入れ物（オブジェクト）で保存してください。`
        + `すべて既定のまま計算します（保存された値: ${showValue(rawBlock)}）。`,
      );
    }
  }

  // 旧 indirectFactor は「参考の表示」用にだけ持ち出す。policy へは入れない。
  const rawFactor = (settings && typeof settings === 'object') ? settings.indirectFactor : undefined;
  const legacyIndirectFactor = (typeof rawFactor === 'number' && Number.isFinite(rawFactor)) ? rawFactor : null;

  if (!block) {
    return Object.freeze({
      policy: Object.freeze(policy),
      sources: Object.freeze(sources),
      warnings: Object.freeze(warnings),
      legacyIndirectFactor,
    });
  }

  // 版が違う保存値でも捨てない。項目ごとに範囲を確かめて取り込み、版の違いだけ知らせる。
  if (isProvided(block, 'schemaVersion') && block.schemaVersion !== DEFAULT_OPERATION_POLICY.schemaVersion) {
    warnings.push(
      `保存された settings.operationPolicy の版は ${showValue(block.schemaVersion)} です`
      + `（このコードの版は ${DEFAULT_OPERATION_POLICY.schemaVersion}）。項目ごとに範囲を確かめて取り込みました。`,
    );
  }

  // 仕様書3章で決まっている項目は、保存されていても取り込まない。黙って捨てず知らせる。
  for (const key of FIXED_KEYS) {
    if (key === 'schemaVersion') continue;
    if (!isProvided(block, key)) continue;
    warnings.push(
      `${key} は仕様書3章で決まっている値です。保存された値は取り込まず、`
      + `既定のまま計算します（保存された値: ${showValue(block[key])}）。`,
    );
  }

  // 見覚えのない項目。名前の書き間違いが黙って効かないまま残るのを防ぐ。
  const known = new Set([...FIXED_KEYS, ...TUNABLE_KEYS]);
  const strangers = Object.keys(block).filter((k) => !known.has(k));
  if (strangers.length > 0) {
    warnings.push(
      `settings.operationPolicy に見覚えのない項目があります: ${strangers.join('・')}。計算には入れていません。`,
    );
  }

  // ── 通常の直接作業時間（1〜720分） ──
  const regLimit = OPERATION_POLICY_LIMITS.regularDirectMinutesPerDay;
  if (isProvided(block, 'regularDirectMinutesPerDay')) {
    const got = takeInteger(block.regularDirectMinutesPerDay, regLimit.min, regLimit.max);
    if (got === null) {
      warnings.push(
        `通常の直接作業時間は ${regLimit.min}〜${regLimit.max}分 の整数で保存してください。`
        + `既定の ${DEFAULT_OPERATION_POLICY.regularDirectMinutesPerDay}分 へ戻しました`
        + `（保存された値: ${showValue(block.regularDirectMinutesPerDay)}）。`,
      );
    } else {
      policy.regularDirectMinutesPerDay = got;
      sources.regularDirectMinutesPerDay = 'admin';
    }
  }

  // ── 残業込みの上限（通常以上・720分以内） ──
  const otLimit = OPERATION_POLICY_LIMITS.overtimeDirectMinutesPerDay;
  const otMin = Math.max(otLimit.min, policy.regularDirectMinutesPerDay);
  if (isProvided(block, 'overtimeDirectMinutesPerDay')) {
    const got = takeInteger(block.overtimeDirectMinutesPerDay, otMin, otLimit.max);
    if (got === null) {
      warnings.push(
        `残業込みの上限は ${otMin}分以上・${otLimit.max}分以内 の整数で保存してください`
        + `（下限は通常の ${policy.regularDirectMinutesPerDay}分）。`
        + `既定の ${DEFAULT_OPERATION_POLICY.overtimeDirectMinutesPerDay}分 へ戻しました`
        + `（保存された値: ${showValue(block.overtimeDirectMinutesPerDay)}）。`,
      );
    } else {
      policy.overtimeDirectMinutesPerDay = got;
      sources.overtimeDirectMinutesPerDay = 'admin';
    }
  }
  // 既定へ戻した結果、残業が通常を下回る事があり得る（通常だけ大きく保存された場合）。
  // その形のまま返すと「残業にすると1日が短くなる」という誤った計算になるので、通常へ揃える。
  if (policy.overtimeDirectMinutesPerDay < policy.regularDirectMinutesPerDay) {
    warnings.push(
      `残業込みの上限（${policy.overtimeDirectMinutesPerDay}分）が通常（${policy.regularDirectMinutesPerDay}分）`
      + `を下回るため、残業込みの上限を ${policy.regularDirectMinutesPerDay}分 に合わせました。`,
    );
    policy.overtimeDirectMinutesPerDay = policy.regularDirectMinutesPerDay;
    sources.overtimeDirectMinutesPerDay = 'default';
  }

  // ── 直工比率の補正（2026-09-05 清水さん）。既定は掛けない。管理者が true を保存した時だけ、通常/残業の分数を係数で割る ──
  //   🚨 係数は settings.indirectFactor（全体進捗の「間接込み係数」。実測係数を反映できる）。1以下・未設定なら掛けずに知らせる。
  //   🚨 通常の下限(regLimit.min)を割らない。残業込みは通常以上に保つ。
  if (isProvided(block, 'applyIndirectFactor')) {
    if (block.applyIndirectFactor === true) {
      if (legacyIndirectFactor != null && legacyIndirectFactor > 1) {
        policy.applyIndirectFactor = true;
        sources.applyIndirectFactor = 'admin';
        policy.regularDirectMinutesPerDay = Math.max(regLimit.min, Math.round(policy.regularDirectMinutesPerDay / legacyIndirectFactor));
        policy.overtimeDirectMinutesPerDay = Math.max(policy.regularDirectMinutesPerDay, Math.round(policy.overtimeDirectMinutesPerDay / legacyIndirectFactor));
        sources.regularDirectMinutesPerDay = 'indirect-factor';
        sources.overtimeDirectMinutesPerDay = 'indirect-factor';
      } else {
        warnings.push(
          `直工比率の補正を掛ける設定ですが、係数（settings.indirectFactor）が 1 以下か未設定なので掛けていません`
          + `（保存された値: ${showValue(rawFactor)}）。`,
        );
      }
    } else if (block.applyIndirectFactor !== false) {
      warnings.push(`applyIndirectFactor は true / false で保存してください（保存された値: ${showValue(block.applyIndirectFactor)}）。掛けていません。`);
    }
  }

  // ── 画面の1目盛り（0.1〜1.0） ──
  const stepLimit = OPERATION_POLICY_LIMITS.uiStepFraction;
  if (isProvided(block, 'uiStepFraction')) {
    const got = takeFraction(block.uiStepFraction, stepLimit.min, stepLimit.max);
    if (got === null) {
      warnings.push(
        `画面の1目盛りは ${stepLimit.min}〜${stepLimit.max} で保存してください。`
        + `既定の ${DEFAULT_OPERATION_POLICY.uiStepFraction} へ戻しました`
        + `（保存された値: ${showValue(block.uiStepFraction)}）。`,
      );
    } else {
      policy.uiStepFraction = got;
      sources.uiStepFraction = 'admin';
    }
  }

  // ── 予測日数と、その選択肢（1〜90稼働日） ──
  const hzLimit = OPERATION_POLICY_LIMITS.horizonDays;
  if (isProvided(block, 'defaultHorizonDays')) {
    const got = takeInteger(block.defaultHorizonDays, hzLimit.min, hzLimit.max);
    if (got === null) {
      warnings.push(
        `予測日数は ${hzLimit.min}〜${hzLimit.max}稼働日 の整数で保存してください。`
        + `既定の ${DEFAULT_OPERATION_POLICY.defaultHorizonDays}日 へ戻しました`
        + `（保存された値: ${showValue(block.defaultHorizonDays)}）。`,
      );
    } else {
      policy.defaultHorizonDays = got;
      sources.defaultHorizonDays = 'admin';
    }
  }
  if (isProvided(block, 'horizonOptions')) {
    const got = takeHorizonOptions(block.horizonOptions, hzLimit.min, hzLimit.max);
    if (got === null) {
      warnings.push(
        `予測日数の選択肢は ${hzLimit.min}〜${hzLimit.max}稼働日 の整数を並べた形で保存してください。`
        + `既定の [${DEFAULT_OPERATION_POLICY.horizonOptions.join(', ')}] へ戻しました`
        + `（保存された値: ${showValue(block.horizonOptions)}）。`,
      );
    } else {
      policy.horizonOptions = got;
      sources.horizonOptions = 'admin';
    }
  }
  // 既定の予測日数が選択肢に無いと、画面にその日数のボタンが出ない。組合せの誤りとして両方戻す。
  if (!policy.horizonOptions.includes(policy.defaultHorizonDays)) {
    warnings.push(
      `既定の予測日数 ${policy.defaultHorizonDays}日 が選択肢 [${policy.horizonOptions.join(', ')}] に`
      + `含まれていないため、予測日数と選択肢の両方を既定へ戻しました。`,
    );
    policy.defaultHorizonDays = DEFAULT_OPERATION_POLICY.defaultHorizonDays;
    policy.horizonOptions = DEFAULT_OPERATION_POLICY.horizonOptions;
    sources.defaultHorizonDays = 'default';
    sources.horizonOptions = 'default';
  }

  // ── 教育へ使い切らないための予備時間（0〜480分） ──
  const resLimit = OPERATION_POLICY_LIMITS.provisionalReserveMinutesPerDay;
  if (isProvided(block, 'provisionalReserveMinutesPerDay')) {
    const got = takeInteger(block.provisionalReserveMinutesPerDay, resLimit.min, resLimit.max);
    if (got === null) {
      warnings.push(
        `予備時間は ${resLimit.min}〜${resLimit.max}分 の整数で保存してください。`
        + `既定の ${DEFAULT_OPERATION_POLICY.provisionalReserveMinutesPerDay}分 へ戻しました`
        + `（保存された値: ${showValue(block.provisionalReserveMinutesPerDay)}）。`,
      );
    } else {
      policy.provisionalReserveMinutesPerDay = got;
      sources.provisionalReserveMinutesPerDay = 'admin';
    }
  }

  // ── 1日に組めるOJTの組数（0〜10） ──
  const ojtLimit = OPERATION_POLICY_LIMITS.maxOjtPairsPerDay;
  if (isProvided(block, 'maxOjtPairsPerDay')) {
    const got = takeInteger(block.maxOjtPairsPerDay, ojtLimit.min, ojtLimit.max);
    if (got === null) {
      warnings.push(
        `1日に組めるOJTの組数は ${ojtLimit.min}〜${ojtLimit.max} の整数で保存してください。`
        + `既定の ${DEFAULT_OPERATION_POLICY.maxOjtPairsPerDay} へ戻しました`
        + `（保存された値: ${showValue(block.maxOjtPairsPerDay)}）。`,
      );
    } else {
      policy.maxOjtPairsPerDay = got;
      sources.maxOjtPairsPerDay = 'admin';
    }
  }

  return Object.freeze({
    policy: Object.freeze(policy),
    sources: Object.freeze(sources),
    warnings: Object.freeze(warnings),
    legacyIndirectFactor,
  });
}

// ── 👤 人ごとの残業（2026-09-10 清水さん「残業は個人毎でお願い、しない人はしない人でいるからね」） ──
//
// 🚨 決まりの持ち主は **ここ1つのまま**。
//   工場の既定（1日の直接作業分数・残業込みの上限）を持つのは上の resolveOperationPolicy。
//   人ごとの上書きも **同じファイルのこの関数** が解く。calendar.js / normalizeInput.js は
//   この1本を呼ぶだけで、自分で分を足し引きしない。
//   （前の担当者が止めた理由 =「暦へ効かせると持ち主が2つになる」。持ち主を増やさずに解いたのが下。）
//
// 考え方:
//   その人の1日 ＝ 所定内（工場の regular）＋ その人に頼んでよい残業ぶん。
//   工場が足している残業ぶん ＝ この見立ての1日 − 所定内。
//   ・登録なし             … 工場の決まりそのまま（今までと1ミリも同じ）
//   ・allowed === false    … 残業0分。所定内はそのまま（「しない人はしない人」）
//   ・maxMinPerDay が数    … 工場の残業ぶんと **小さい方**（工場より多く働かせない）
//
// 🚨 「誰の何分がどこから来たか」を why に必ず残す。画面がそのまま札に出せる形にする。

/** 名前の見せ方を1か所に（workerAvailability.js の who と同じ形）。 */
const whoName = (name) => `${String(name ?? '').trim() || '名前なし'}さん`;

/**
 * 人ごとの残業の設定を読む。**読める形だけ** 通す。
 * ⚠ 'true' という文字や 1 を「はい」と読み替えない（workerAvailability.js の readOvertime と同じ作法）。
 * @returns {{allowed:boolean|null, maxMinPerDay:number|null}|null} 何も読めなければ null（＝登録なし）
 */
const readPersonOvertime = (profile) => {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const raw = profile.overtime;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = typeof raw.allowed === 'boolean' ? raw.allowed : null;
  const maxMinPerDay = (typeof raw.maxMinPerDay === 'number'
    && Number.isInteger(raw.maxMinPerDay)
    && raw.maxMinPerDay >= 0
    && raw.maxMinPerDay <= OPERATION_POLICY_LIMITS.overtimeDirectMinutesPerDay.max)
    ? raw.maxMinPerDay
    : null;
  if (allowed === null && maxMinPerDay === null) return null;
  return { allowed, maxMinPerDay };
};

/**
 * この見立てでその人が1日に使える直接作業の分数を解く。
 *
 * @param {object} o
 * @param {string} [o.name] 名前。why の文に出すだけ
 * @param {{regularMin:number, dayMin:number}|number} o.base 工場の決まり。
 *   regularMin … 所定内（policy.regularDirectMinutesPerDay）
 *   dayMin     … この見立ての1日（通常なら regular、残業なら overtime、刻み残業ならその値）
 *   数値ひとつで渡した時は「残業ぶん無し」として dayMin = regularMin = その数値。
 * @param {object|null} [o.profile] settings.workerProfiles[名前]（overtime を見る）
 * @returns {{
 *   name:string, regularMin:number, factoryDayMin:number, factoryOvertimeMin:number,
 *   overtimeMin:number, directMin:number,
 *   source:'factory'|'person-off'|'person-cap', changed:boolean, why:string
 * }}
 *   directMin … その人の1日の分数。**呼ぶ側はこれだけを使う**
 *   source    … 'factory'（登録なし・登録が数字を動かさない）/ 'person-off'（残業しない設定）
 *               / 'person-cap'（1日の上限が登録されている）
 *   changed   … 工場の dayMin から動いたか。**動いた時だけ画面が札を出せばよい**
 *   why       … 誰の何分がどこから来たかの1行（画面の根拠の札にそのまま出す）
 * 🚨 渡された base が読めない時は黙って既定へ寄せず、例外にする（配線の書き間違いを飲み込まない）。
 */
export function resolveWorkerDayMinutes({ name = '', base = null, profile = null } = {}) {
  const rawDay = (typeof base === 'number') ? base : Number(base && base.dayMin);
  const dayMin = Math.round(rawDay);
  if (!Number.isFinite(rawDay) || !(dayMin > 0)) {
    throw new Error('policy: resolveWorkerDayMinutes には base.dayMin（この見立ての1日の直接作業分数）を正の数で渡してください');
  }
  const rawRegular = (typeof base === 'number') ? rawDay : Number(base && base.regularMin);
  // 所定内が渡されない・大きすぎる時は「残業ぶん無し」に倒す（工場より多く働かせない）。
  const regularMin = (Number.isFinite(rawRegular) && rawRegular > 0 && Math.round(rawRegular) <= dayMin)
    ? Math.round(rawRegular)
    : dayMin;
  const factoryOvertimeMin = Math.max(0, dayMin - regularMin);

  const ot = readPersonOvertime(profile);
  const asFactory = (why) => Object.freeze({
    name: String(name ?? ''),
    regularMin,
    factoryDayMin: dayMin,
    factoryOvertimeMin,
    overtimeMin: factoryOvertimeMin,
    directMin: dayMin,
    source: 'factory',
    changed: false,
    why,
  });

  if (!ot) {
    return asFactory(`${whoName(name)}の残業は登録がありません（工場の決まりのまま 1日 ${dayMin}分）`);
  }

  if (ot.allowed === false) {
    const directMin = regularMin;
    return Object.freeze({
      name: String(name ?? ''),
      regularMin,
      factoryDayMin: dayMin,
      factoryOvertimeMin,
      overtimeMin: 0,
      directMin,
      source: 'person-off',
      changed: directMin !== dayMin,
      why: factoryOvertimeMin > 0
        ? `${whoName(name)}は残業をしない設定なので、この見立ての残業 ${factoryOvertimeMin}分 を外して 1日 ${directMin}分 で数えています`
        : `${whoName(name)}は残業をしない設定です（この見立ては残業を使っていないので 1日 ${directMin}分 のまま）`,
    });
  }

  if (ot.maxMinPerDay != null) {
    // 🚨 工場と本人の **小さい方**。本人の上限が大きくても、工場より多く働かせない。
    const overtimeMin = Math.min(factoryOvertimeMin, ot.maxMinPerDay);
    const directMin = regularMin + overtimeMin;
    return Object.freeze({
      name: String(name ?? ''),
      regularMin,
      factoryDayMin: dayMin,
      factoryOvertimeMin,
      overtimeMin,
      directMin,
      source: 'person-cap',
      changed: directMin !== dayMin,
      why: overtimeMin < factoryOvertimeMin
        ? `${whoName(name)}の残業は1日 ${ot.maxMinPerDay}分 までなので、この見立ての残業 ${factoryOvertimeMin}分 を ${overtimeMin}分 に縮めて 1日 ${directMin}分 で数えています`
        : `${whoName(name)}の残業は1日 ${ot.maxMinPerDay}分 までで、この見立ての残業は ${factoryOvertimeMin}分 なので そのまま 1日 ${directMin}分 です`,
    });
  }

  // allowed === true で上限の登録が無い人。工場の決まりのまま。
  return asFactory(`${whoName(name)}は残業に回してよい設定です（工場の決まりのまま 1日 ${dayMin}分）`);
}

/**
 * 画面の1行。resolveWorkerDayMinutes の答えを並べるだけ（数字はここで作らない）。
 * @param {ReturnType<typeof resolveWorkerDayMinutes>} resolved
 */
export function describeWorkerDayMinutes(resolved) {
  if (!resolved || typeof resolved !== 'object') return '';
  return String(resolved.why || '');
}
