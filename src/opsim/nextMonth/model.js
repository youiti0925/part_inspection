// =============================================================================
//  opsim/nextMonth/model.js — 「来月の手当て」画面が読む形を作る（並べ替えだけ）
// -----------------------------------------------------------------------------
//  この画面が答える1行（決まり19B）:
//    「来月、人は足りるか。足りないなら どの工程を・誰に・いつまでに 教えれば間に合うか」
//
//  🤝 2026-09-04: Codex の枝 origin/codex/opsim-next-month-20260904 (2dca8e1) の
//     `src/opsim/nextMonth/model.js` から **設計の芯** を接いだ。接いだ物:
//       ・計算はしない。monthly.js / decisionBoard.js が返した値を束ねるだけ。
//       ・「候補の選び方が未確定なのに『一番近そうな人』を画面で推測しない」。
//         引き直した結果が渡らなければ、正直に灰色で「まだ選べません」を返す。
//       ・答えの1行を model 側で作る（画面は置くだけ）。
//     採らなかった物（理由つき）:
//       ・教育の日数（leadDays）・一人前の見込み日・why の文
//         → 決まり5「教育の逆算日は出さない（材料が無い）」。本番に 🎓 0件・卒業0件。
//           代用値を作ると検定の条件を1つ触るだけで中央値が 27→38営業日（1.41倍）動く。
//           **日数はこの画面に1文字も出さない。**
//       ・`monthTone` が verdict==='ok' をそのまま緑にする所
//         → 実データで 10月は 登録2件しか無いのに verdict='ok'（headline も「回ります」）。
//           決まり1「中身の無い月を『回ります』と言わせない」に真正面からぶつかる。
//           だから **登録の薄い月は判定を出さない**（下の thin）。
//       ・「持てる人が分からない工程」を緑（OK）に含める所
//         → 実データの 9月は 時間は足りる（余力34.6人日）が **45工程は持てる人が分からない**。
//           これを緑にすると「余裕がある」と読めてしまう。橙の別の答えにする。
//
//  🚨 ここで足し算・判定をやり直さない。数字の出どころは1つ:
//     props.monthly ＝ Worker(operationsSimulation.worker.js ⑦) が返した物そのまま。
//  🚨 「すでに超過(overdue)」「この先の見込み(short)」「まだ判定していません(unknown)」を
//     1つの数に混ぜない。3つ別々に持って返す。
// =============================================================================

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const str = (v) => (v == null ? '' : String(v).trim());
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;

/** 色の意味は5つに固定。橙が2つの意味を持たないように、きわどいと分けてある。 */
export const NM_TONE = Object.freeze({
  SHORT: 'short',           // 赤 … 持てる人は居るが時間が足りない
  OWNER_UNKNOWN: 'owner',   // 橙 … 時間は足りるが、その工程を持てる人が分からない
  TIGHT: 'tight',           // 黄 … 回るが余裕が無い
  OK: 'ok',                 // 緑 … 時間も足りて、持てる人も分かっている
  UNKNOWN: 'unknown',       // 灰 … まだ判定していません（登録がこれから／材料が無い）
});

/**
 * 🚨 決まり1・2「中身の無い月を『回ります』と言わせない」の**数え方**。
 *   その月の登録が、いま登録が入りきっている月（今月）の 1割 に届かない時は、
 *   「仕事が無い」のではなく「登録がこれから」と見て、判定を出さない。
 *   ⚠ 上限が自明な量なので、文でなく **数え方** を見張る（scripts/verify-opsim-next-month.mjs）。
 *   ⚠ この割合は画面にそのまま出す（隠れた決め打ちにしない）。登録が増えれば自然に判定へ変わる。
 */
export const THIN_MONTH_RATIO = 0.1;

/** 分 → 人日。分母は Worker が返した dayMinutes（policy.js の 420 など）。 */
export function personDays(minutes, dayMinutes) {
  const m = num(minutes);
  const d = num(dayMinutes);
  if (m == null || d == null || !(d > 0)) return null;
  return round1(m / d);
}

/**
 * その月の登録が「これから」かどうか。
 * @returns {{thin:boolean, lotCount:number, baseLotCount:number, needLotCount:number, why:string}}
 */
export function registrationThinness(month, baseMonth) {
  const lotCount = Math.max(0, Math.trunc(num(month && month.lotCount) || 0));
  const baseLotCount = Math.max(0, Math.trunc(num(baseMonth && baseMonth.lotCount) || 0));
  const isBase = month && baseMonth && month.index === baseMonth.index;
  const needLotCount = Math.ceil(baseLotCount * THIN_MONTH_RATIO);
  // 今月（index 0）は「登録がこれから」ではない。基準そのものなので薄いとは言わない。
  const thin = !isBase && lotCount < needLotCount;
  return {
    thin,
    lotCount,
    baseLotCount,
    needLotCount,
    /* 🚨 「仕事が無い」と言い切らない。この画面に載っている登録が少ない、までが言える事。
       （登録がこれからなのか、見ている範囲で切れているのか は、この数だけでは分かれない） */
    why: thin
      ? `この画面に載っている登録 ${lotCount}件は、今月の登録 ${baseLotCount}件 の1割（${needLotCount}件）に届いていません。`
        + 'この月の仕事が無いという意味ではありません'
      : '',
  };
}

/**
 * 登録がこれからの月の言い方。🚨 決まり19B①。**言葉はここ1か所だけ**にする
 * （2か所に同じ文を書くと、片方だけ直して食い違う。見張りも1行を見張れなくなる）。
 */
const registrationAnswer = (label, lotCount) => `${label}：いま登録されているのは ${lotCount}件です（これから増えます）`;

/** 月の色と答え。🚨 Worker の verdict を置き換えるのではなく、薄い月だけを灰へ倒す。 */
function monthAnswer(month, thinness) {
  const label = str(month && month.label) || '';
  const jobCount = Math.max(0, Math.trunc(num(month && month.jobCount) || 0));
  const ownerUnknown = Math.max(0, Math.trunc(num(month && month.unknownOwnerProcessCount) || 0));
  const shortProc = Math.max(0, Math.trunc(num(month && month.shortProcessCount) || 0));
  const verdict = str(month && month.verdict);

  /* 🚨🚨 決まり19B①（2026-09-04）が勝つ:
       「入荷・納期の登録が無い月は『登録 ◯件（これから）』と言い、数字を出さない。
         **『判定していません』は禁止**」
     ⚠ 決まり2（2026-09-01）は逆に「## 10月：まだ判定していません」を文例に挙げていて、
       2つの決まりが割れていた。**後の決まり19B を採る**（親の指示・2026-09-05）。
       理由: 「判定していません」は「こちらが判定する気で見ている」と読める。
       実際は こちらの問題ではなく **その月の登録がこれから** なので、そう言う方が正しい。
     ⚠ 数字は作らない。lotCount は engine の月の行が持っている件数そのまま。 */
  if (thinness.thin) {
    return {
      tone: NM_TONE.UNKNOWN,
      answer: registrationAnswer(label, thinness.lotCount),
      why: thinness.why,
    };
  }
  if (jobCount === 0) {
    return {
      tone: NM_TONE.UNKNOWN,
      answer: registrationAnswer(label, thinness.lotCount),
      why: 'この月に納期が来る仕事が、まだ1件も登録されていません',
    };
  }
  if (verdict === 'unjudgeable') {
    return {
      tone: NM_TONE.UNKNOWN,
      answer: `${label}：まだ判定していません`,
      why: str(month.unjudgeableWhy) || '判定を出すだけの材料がありません',
    };
  }
  if (verdict === 'partial') {
    return {
      tone: NM_TONE.UNKNOWN,
      answer: `${label}：残り営業${num(month.workdays) ?? '—'}日だけ`,
      why: str(month.partialWhy) || '足りる／足りないの判定は出しません',
    };
  }
  if (verdict === 'short') {
    return {
      tone: NM_TONE.SHORT,
      answer: `${label}：${num(month.shortPersonDays) ?? '—'}人日 足りません`,
      why: `1か月フルで張り付く人に直すと ${num(month.peopleForWholeMonth) ?? '—'}人分`
        + `（${label}の営業${num(month.peopleForWholeMonthDenominatorWorkdays) ?? '—'}日で割った値）`
        + (shortProc > 0 ? ` ・ 時間が足りない工程 ${shortProc}` : ''),
    };
  }
  // ── 時間は足りている。だが「持てる人が分からない」工程があるなら、緑にしない ──
  //   🚨 実績が無いのは「分かりません」であって、やれないという意味ではない（2026-08-20）。
  if (ownerUnknown > 0) {
    return {
      tone: NM_TONE.OWNER_UNKNOWN,
      answer: `${label}：時間は足ります。持てる人が分からない工程が ${ownerUnknown}`,
      why: `働ける時間の余り ${num(month.sparePersonDays) ?? '—'}人日 ・ `
        + `この ${ownerUnknown}工程は、記録も設定も無いので誰が持てるか分かりません（やれない、ではありません）`,
    };
  }
  if (verdict === 'tight') {
    return {
      tone: NM_TONE.TIGHT,
      answer: `${label}：きわどい`,
      why: `回りますが余裕がありません（余力 ${num(month.sparePersonDays) ?? '—'}人日）`,
    };
  }
  return {
    tone: NM_TONE.OK,
    answer: `${label}：回ります`,
    why: `余力 ${num(month.sparePersonDays) ?? '—'}人日 ・ どの工程も持てる人が分かっています`,
  };
}

/* ── 決まり28（2026-09-05 清水さん「まわりますって言われてもどういう意味？何を根拠で大丈夫とか異常とか」）──
 *   判定の横に **式** を置く。engine の数をそのまま並べるだけ（ここで数え直さない）。
 *   要る／働ける は personDays（同じ分母 dayMinutes）。余り／不足 は engine の sparePersonDays / shortPersonDays。 */
export function formulaOf(month, monthly, tone) {
  const req = personDays(month && month.requiredMinutes, monthly && monthly.dayMinutes);
  const cap = personDays(month && month.workableMinutes, monthly && monthly.dayMinutes);
  if (req == null || cap == null) return null;
  const roster = arr(monthly && monthly.roster).length;
  const wd = num(month.workdays);
  const dm = num(monthly.dayMinutes);
  const capNote = `名簿${roster}人・営業${wd == null ? '—' : wd}日・1日${dm == null ? '—' : dm}分`;
  if (tone === NM_TONE.SHORT) {
    const short = num(month.shortPersonDays);
    return { required: req, workable: cap, short, spare: null, capNote,
      sentence: `要る ${req}人日 ＞ 働ける ${cap}人日（${capNote}） → ${short == null ? '—' : short}人日 足りません` };
  }
  if (tone === NM_TONE.OK || tone === NM_TONE.TIGHT || tone === NM_TONE.OWNER_UNKNOWN) {
    const spare = num(month.sparePersonDays);
    return { required: req, workable: cap, short: null, spare, capNote,
      sentence: `要る ${req}人日 ≦ 働ける ${cap}人日（${capNote}） → 余り ${spare == null ? '—' : spare}人日` };
  }
  return null;
}

/** 決まり28: 工程ごとの「なぜ」を1語で。🚨「実績が無い＝できない」と書かない（記録0件＝分かりません）。 */
export function processWhyOf(p) {
  if (!p) return { key: 'unknown', text: '分かりません' };
  if (p.ownerUnknown === true) return { key: 'norecord', text: '記録0件（誰もやった記録がありません）' };
  if ((num(p.shortMinutes) || 0) > 0) return { key: 'short', text: '持てる人は居るが時間が足りない' };
  const n = Math.max(0, Math.trunc(num(p.workerCount) || 0));
  const w = arr(p.workers).map(str).filter(Boolean);
  if (n === 1) return { key: 'single', text: `1人だけ（${w[0] || '—'}）` };
  if (n === 0) return { key: 'norecord', text: '記録0件（誰もやった記録がありません）' };
  return { key: 'ok', text: `持てる人 ${n}人` };
}

/* 決まり28・29（2026-09-05 清水さん「工程を細かく出して行が増えまくるのは、そのテンプレをしていないと言っているのと同じ。
 *   テンプレ毎の表示にして減らせ」）: 工程の行を **テンプレ毎に束ねる**。工程は開けば出る（消さない）。
 *   要る時間は工程の合計（需要は足せる）。持てる人は和集合。色は一番悪い物。 */
const TONE_RANK = { [NM_TONE.SHORT]: 0, [NM_TONE.OWNER_UNKNOWN]: 1, [NM_TONE.UNKNOWN]: 2, [NM_TONE.TIGHT]: 3, [NM_TONE.OK]: 4 };
export function groupByTemplate(processes, dayMinutes) {
  const map = new Map();
  for (const p of arr(processes)) {
    const key = str(p.templateName) || '（テンプレ名が この計算へ渡っていません）';
    let g = map.get(key);
    if (!g) {
      g = { templateName: key, processes: [], models: new Set(), workers: new Set(), requiredMinutes: 0, ownerUnknownCount: 0, singleOwnerCount: 0, shortCount: 0 };
      map.set(key, g);
    }
    g.processes.push(p);
    arr(p.models).forEach((x) => g.models.add(str(x)));
    arr(p.workers).forEach((x) => g.workers.add(str(x)));
    g.requiredMinutes += Math.max(0, num(p.requiredMinutes) || 0);
    if (p.ownerUnknown === true) g.ownerUnknownCount += 1;
    else if (Math.trunc(num(p.workerCount) || 0) === 1) g.singleOwnerCount += 1;
    if ((num(p.shortMinutes) || 0) > 0) g.shortCount += 1;
  }
  return [...map.values()].map((g) => {
    const allUnknown = g.processes.every((p) => p.tone === NM_TONE.UNKNOWN);
    const tone = g.shortCount > 0 ? NM_TONE.SHORT
      : g.ownerUnknownCount > 0 ? NM_TONE.OWNER_UNKNOWN
        : allUnknown ? NM_TONE.UNKNOWN : NM_TONE.OK;
    const allNoRecord = g.processes.length > 0 && g.ownerUnknownCount === g.processes.length;
    const why = g.shortCount > 0 ? `時間が足りない工程 ${g.shortCount}`
      : allNoRecord ? '記録0件（このテンプレは誰もやった記録がありません）'
        : g.ownerUnknownCount > 0 ? `記録0件の工程 ${g.ownerUnknownCount}／${g.processes.length}`
          : g.singleOwnerCount > 0 ? `1人だけの工程 ${g.singleOwnerCount}／${g.processes.length}`
            : (allUnknown ? '登録がこれから' : `持てる人 ${g.workers.size}人`);
    return {
      templateName: g.templateName,
      processes: g.processes,
      processCount: g.processes.length,
      models: [...g.models].filter(Boolean).sort(),
      workers: [...g.workers].filter(Boolean).sort(),
      requiredMinutes: g.requiredMinutes,
      requiredPersonDays: personDays(g.requiredMinutes, dayMinutes),
      ownerUnknownCount: g.ownerUnknownCount,
      singleOwnerCount: g.singleOwnerCount,
      shortCount: g.shortCount,
      allNoRecord,
      tone,
      why,
    };
  }).sort((a, b) => (TONE_RANK[a.tone] - TONE_RANK[b.tone]) || (b.requiredMinutes - a.requiredMinutes) || a.templateName.localeCompare(b.templateName, 'ja'));
}

/** 決まり18 の2種の言葉。Worker(monthly.js)が運んだ whyCounts の鍵をそのまま読む（ここで数えない）。 */
const ARRIVAL_WHY_LABEL = Object.freeze({
  assumedClampedToNow: '納期が来ているのに入荷の登録が無い',
  assumedBeforeDue: '納期の2日前に着くと仮に置いた',
  arrivalScheduled: '入荷予定がこれから先',
});

/**
 * 工程1行の色。🚨 「足りない」と「分かりません」を1つの色に混ぜない。
 * @param {object} p 工程の行
 * @param {boolean} [monthThin] その月の登録がこれからか。
 *   🚨 true の時は「回ります(緑)」「足りません(赤)」を出さない。月を判定していないのに
 *     工程の行だけ緑にすると、上の灰色の答えと食い違って「回る」と読めてしまう。
 *     「持てる人が分からない(橙)」は月の判定ではなく **その工程についての事実** なので残す。
 */
export function processTone(p, monthThin = false) {
  if (!p) return NM_TONE.UNKNOWN;
  if (p.ownerUnknown === true) return NM_TONE.OWNER_UNKNOWN;
  if (monthThin === true) return NM_TONE.UNKNOWN;
  if ((num(p.shortMinutes) || 0) > 0) return NM_TONE.SHORT;
  return NM_TONE.OK;
}

/**
 * 仮付与で引き直した効き目。
 * 🚨 引き直した結果が渡っていない時に「一番近そうな人」を画面で選ばない（Codex の芯）。
 * 🚨 2026-09-07: 引き替えに失う物（新しく遅れる／判定できなくなる／結果から行ごと消える）も
 *   decisionBoard.js から渡って来る。効いた手には数えないが、行は消さずに出す。
 *   ⚠ 数える語は分ける: tradeoff（得も損もある＝交換条件つき）と worse（損だけ）は別。
 *     1つにまとめると、得が1つも無い手まで画面が『交換条件つき』と呼んでしまう。
 */
function remedyOf(decisionBoard) {
  const trials = arr(decisionBoard && decisionBoard.trials);
  if (!decisionBoard || trials.length === 0) {
    return {
      state: 'missing',
      trials: [],
      improvedCount: 0,
      tradeoffCount: 0,
      worseCount: 0,
      testedCount: 0,
      note: '仮に持たせて割付を引き直した結果が、この画面へ渡っていません。'
        + '一番近そうな人を画面で選ぶ事はしません（選び方が決まっていないので、決めた事になってしまいます）。',
    };
  }
  const rows = trials.map((t) => {
    // 🚨 件数は「引き直して出た一覧の長さ」。引き算で作らない。
    const newlyLateLotIds = arr(t.newlyLateLotIds).map(str);
    const becameUnjudgeableLotIds = arr(t.becameUnjudgeableLotIds).map(str);
    /* 🚨 引き直した一覧から **行ごと消えた** ロット。decisionBoard.js が数える3つ目の損。
       ⚠ 画面はこれを別の丸札にしない。行が消えたロットは必ず「判定できなくなった」にも入る
         （missingLotIds ⊆ becameUnjudgeableLotIds。2026-09-08 実測: 本物の compareSkillTrial に
          「A の行が消えた」結果を渡すと becameUnjudgeable:['A'] と missing:['A'] の両方が返る）。
         ここで写すのは、verdict の付いていない古い形を4語へ落とす為と、札の説明に内訳を畳む為。 */
    const missingLotIds = arr(t.missingLotIds).map(str);
    const improves = t.improves === true;
    const avoidedLateLotIds = arr(t.avoidedLateLotIds).map(str);
    const resolvedJobIds = arr(t.resolvedJobIds).map(str);
    const newlyAssignedJobIds = arr(t.newlyAssignedJobIds).map(str);
    const skillIdleMinutesReduced = num(t.skillIdleMinutesReduced);
    /* 引き替えに失う物・得る物が在るか。decisionBoard.js が verdict を付けて来た時はそれを使い、
       付いていない古い形は、渡って来た一覧の長さから同じ4語へ落とす（無い物を作らない）。 */
    const given = str(t.verdict);
    const lost = newlyLateLotIds.length > 0 || becameUnjudgeableLotIds.length > 0 || missingLotIds.length > 0;
    const gained = avoidedLateLotIds.length > 0 || resolvedJobIds.length > 0
      || newlyAssignedJobIds.length > 0 || skillIdleMinutesReduced > 0;
    const verdict = ['improves', 'tradeoff', 'worse', 'no-change'].includes(given)
      ? given
      : (improves ? 'improves' : (lost ? (gained ? 'tradeoff' : 'worse') : 'no-change'));
    return {
      worker: str(t.worker),
      processKey: str(t.processKey),
      processTitle: str(t.processTitle) || str(t.processKey),
      model: str(t.model),
      templateId: str(t.templateId),
      improves,
      verdict,
      avoidedLateLotIds,
      newlyLateLotIds,
      becameUnjudgeableLotIds,
      missingLotIds,
      resolvedJobIds,
      newlyAssignedJobIds,
      skillIdleMinutesBefore: num(t.skillIdleMinutesBefore),
      skillIdleMinutesAfter: num(t.skillIdleMinutesAfter),
      skillIdleMinutesReduced,
    };
  });
  const improved = rows.filter((r) => r.improves);
  /* 🚨 遅れを別のロットへ移すだけの手・判定できなくしてしまう手は「効いた手」に数えない。
     だからと言って隠さない。件数を数えて、画面が出せるようにする。
     🚨 交換条件つき（得も損もある）と 損だけ を **1つの数にまとめない**。
        まとめると、得が1つも無い手まで画面が『交換条件つき』＝何かと引き替えに得た手、と言ってしまう
        （3つの数え方を混ぜない・2026-08-22）。 */
  const tradeoff = rows.filter((r) => r.verdict === 'tradeoff');
  const worse = rows.filter((r) => r.verdict === 'worse');
  const traded = tradeoff.length + worse.length;
  const state = improved.length > 0 ? 'improves' : (traded > 0 ? 'tradeoff' : 'no-change');
  let note;
  if (improved.length > 0) {
    note = '実際に「この人がこの工程を持てる」と仮に置いて割付を引き直した結果です。正式な力量へは書きません。';
  } else if (traded > 0) {
    note = `${rows.length}件とも引き直しましたが、効いた手はありませんでした。`
      + '遅れを別のロットへ移すだけの手は、効いた手に数えません。'
      + '納期を判定できなくなる手も同じです。';
  } else {
    note = `${rows.length}件とも引き直しましたが、遅れも・渡せる仕事も・空きも変わりませんでした。`
      + '（登録が0件のままなので、仮に持たせても回り方が変わりません）';
  }
  return {
    state,
    trials: rows,
    improvedCount: improved.length,
    tradeoffCount: tradeoff.length,
    worseCount: worse.length,
    testedCount: rows.length,
    note,
  };
}

/**
 * 教育の材料（決まり5）。🚨 日数は1文字も出さない。出すのは「材料が有るか」だけ。
 * @param {object|null} materials monthly.materials
 * @param {object|null} educationLeadTime 配線されていれば、材料の不足だけを読む（日数は読まない）
 */
function educationOf(materials, educationLeadTime, baseNow) {
  const m = materials || {};
  const teachProvided = m.teachMarksProvided === true;
  const traineeTaskCount = Math.max(0, Math.trunc(num(m.traineeTaskCount) || 0));
  const firstRecordMs = num(m.firstRecordMs);
  const completedLotCount = Math.max(0, Math.trunc(num(m.completedLotCount) || 0));
  const now = num(baseNow);
  let recordMonths = null;
  if (firstRecordMs != null && now != null && now >= firstRecordMs) {
    const a = new Date(firstRecordMs);
    const b = new Date(now);
    recordMonths = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }
  // 配線されていれば「足りない材料」の札だけ拾う（leadDays / readyByMs / why は読まない）。
  const rows = arr(educationLeadTime && educationLeadTime.rows);
  const missingLabels = [];
  for (const r of rows) {
    for (const mm of arr(r && r.missing)) {
      const label = str(mm && (mm.label || mm.key));
      if (label && !missingLabels.includes(label)) missingLabels.push(label);
    }
  }
  const cards = [
    {
      key: 'teach',
      label: '🎓の印・「教えられる」の指名',
      value: teachProvided ? String(Math.max(0, Math.trunc(num(m.teachMarkCount) || 0))) : null,
      note: teachProvided ? '' : 'この計算には渡っていません',
      ok: teachProvided && (num(m.teachMarkCount) || 0) > 0,
    },
    {
      key: 'trainee',
      label: '教育中として付いた作業の記録',
      value: String(traineeTaskCount),
      note: traineeTaskCount === 0 ? '1件もありません' : '',
      ok: traineeTaskCount > 0,
    },
    {
      key: 'span',
      label: '記録の長さ',
      value: recordMonths == null ? null : `${recordMonths}か月`,
      note: firstRecordMs == null
        ? '完了の記録がありません'
        : `完了 ${completedLotCount}件（いちばん古い完了から）`,
      ok: recordMonths != null && recordMonths > 0,
    },
  ];
  const okCount = cards.filter((c) => c.ok).length;
  return {
    state: okCount === cards.length ? 'ready' : (okCount === 0 ? 'missing' : 'partial'),
    cards,
    okCount,
    missingLabels,
    // 🚨 日数は出さない。理由をそのまま画面に置く。
    why: '教えるのに何日かかるかは出しません。'
      + '上の3つが無いまま日数を出すと、検定の設定を1つ触っただけで数字が動きます（作り物になります）。',
  };
}

/**
 * @param {object} args
 * @param {object|null} args.monthly Worker が返した result.monthly（そのまま）
 * @param {number} [args.monthIndex] どの月を主役にするか（0=今月 / 1=来月 / 2=再来月）。既定は来月
 * @param {boolean} [args.countPile] 到着待ち・記録0件の山を数えるか（既定は数える）
 * @param {object|null} [args.decisionBoard] Worker から来る仮付与の引き直し結果 {trials:[...]}
 * @param {object|null} [args.educationLeadTime] educationLeadTime.js の戻り値（材料の不足だけ読む）
 * @param {boolean} [args.autoPick] 頼まれた月の登録がこれからの時、**登録が入っている月へ寄せる**か。
 *   🚨 2026-09-05: この画面の題は「来月の手当て」なのに、大きい答えが別の月を名乗っていた
 *     （見出しの言葉と中身の月が合っていない）。10月に納期が登録されているのは実データで
 *     2件（この写しでは0件）しか無く、10月を主役にすると **手当てを何も決められない画面** になる。
 *   → 頼まれた月が「登録がこれから」なら、登録が入っている一番近い月を主役にし、
 *     **寄せた事を返り値に残す**（画面が小さく断る）。黙って別の月を出さない。
 *   ⚠ 人が月を押したら autoPick=false（人の選びを勝手に上書きしない）。
 */
export function buildNextMonthView({
  monthly = null,
  monthIndex = 1,
  countPile = true,
  decisionBoard = null,
  educationLeadTime = null,
  autoPick = true,
} = {}) {
  const empty = {
    ready: false,
    error: '',
    answer: '来月の手当ては、計算が終わると出ます',
    why: '',
    tone: NM_TONE.UNKNOWN,
    months: [],
    selected: null,
    selectedIndex: monthIndex,
    processes: [],
    processScaleMinutes: 1,
    counts: { total: 0, short: 0, ownerUnknown: 0, ok: 0 },
    remedy: remedyOf(null),
    education: educationOf(null, null, null),
    workdaysUntilStart: null,
    roster: [],
    dayMinutes: null,
    holdingWord: '到着待ち',
    pileLotCount: null,
    baseNow: null,
    countPile,
    autoPicked: null,
  };
  if (!monthly) return empty;
  if (monthly.ok === false) return { ...empty, error: str(monthly.error) || '理由が取れませんでした' };

  const outlook = countPile ? monthly.withPile : monthly.withoutPile;
  const raw = arr(outlook && outlook.months);
  if (raw.length === 0) return empty;

  // 基準（登録が入りきっている月）＝ index 0（今月）。配列の位置ではなく index で選ぶ。
  const baseMonth = raw.find((m) => num(m.index) === 0) || raw[0];
  const months = raw.map((m) => {
    const thinness = registrationThinness(m, baseMonth);
    const a = monthAnswer(m, thinness);
    return {
      ...m,
      tone: a.tone,
      answer: a.answer,
      why: a.why,
      thin: thinness.thin,
      thinWhy: thinness.why,
      needLotCount: thinness.needLotCount,
      baseLotCount: thinness.baseLotCount,
      requiredPersonDays: personDays(m.requiredMinutes, monthly.dayMinutes),
      workablePersonDays: personDays(m.workableMinutes, monthly.dayMinutes),
      /* 決まり28: 判定の横に置く式（engine の数を並べるだけ）。判定を出さない月は null */
      formula: formulaOf(m, monthly, a.tone),
    };
  });

  const wanted = Math.max(0, Math.min(months.length - 1, Math.trunc(num(monthIndex) || 0)));
  const asked = months.find((m) => num(m.index) === wanted) || months[wanted] || months[0];

  /* 🚨 頼まれた月の登録がこれからなら、登録が入っている一番近い月へ寄せる（2026-09-05）。
     ・寄せた事は autoPicked に残す。画面はここを読んで小さく断る（黙って別の月を出さない）。
     ・見出しの言葉は **主役になった月の名前** を使う（見出しと大きい答えの月を必ず揃える）。
     ・人が月を押した後は autoPick=false で呼ばれるので、この寄せは働かない。 */
  let selected = asked;
  let autoPicked = null;
  if (autoPick === true && asked && asked.thin === true) {
    const alt = months
      .filter((m) => m.thin !== true && (num(m.jobCount) || 0) > 0)
      .sort((a, b) => Math.abs(num(a.index) - wanted) - Math.abs(num(b.index) - wanted))[0];
    if (alt && num(alt.index) !== num(asked.index)) {
      selected = alt;
      autoPicked = {
        askedIndex: num(asked.index),
        askedLabel: str(asked.label),
        askedLotCount: Math.max(0, Math.trunc(num(asked.lotCount) || 0)),
        toIndex: num(alt.index),
        toLabel: str(alt.label),
        toLotCount: Math.max(0, Math.trunc(num(alt.lotCount) || 0)),
      };
    }
  }

  // 「いつまでに」＝ 選んだ月が始まるまでの営業日。
  // 🚨 新しい暦の計算はしない。Worker が月ごとに返した営業日数（workdays）を足すだけ。
  //    今月は残り営業日、来月以降は月まるごとの営業日が入っている。
  let workdaysUntilStart = 0;
  for (const m of months) {
    if (num(m.index) >= num(selected.index)) break;
    workdaysUntilStart += Math.max(0, Math.trunc(num(m.workdays) || 0));
  }

  const processes = arr(selected.processes).map((p) => ({
    ...p,
    tone: processTone(p, selected.thin === true),
    why: processWhyOf(p),
    title: str(p.title) || str(p.processKey) || '工程名なし',
    templateName: str(p.templateName),
    models: arr(p.models).map(str).filter(Boolean),
    modelCount: Math.max(0, Math.trunc(num(p.modelCount) || 0)),
    workers: arr(p.workers).map(str).filter(Boolean),
    requiredPersonDays: personDays(p.requiredMinutes, monthly.dayMinutes),
    workablePersonDays: personDays(p.workableMinutes, monthly.dayMinutes),
    shortPersonDays: num(p.shortPersonDays),
  }));
  // 並びは Worker が決めた重い順のまま。ただし「持てる人が分からない」を先に見せる
  // （時間は足りている月でも、手当てが要るのはこちらだから）。同じ組の中の順は変えない。
  const rank = (t) => (t === NM_TONE.SHORT ? 0 : t === NM_TONE.OWNER_UNKNOWN ? 1 : 2);
  const ordered = processes
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (rank(a.p.tone) - rank(b.p.tone)) || (a.i - b.i))
    .map((x) => x.p);

  const counts = {
    total: ordered.length,
    /* 🚨 登録がこれからの月は「足りません／回ります」を数えない（月を判定していないから）。
       数えるのは「持てる人が分からない」だけ。残りは灰（まだ判定していません）。 */
    short: selected.thin ? 0 : Math.max(0, Math.trunc(num(selected.shortProcessCount) || 0)),
    ownerUnknown: Math.max(0, Math.trunc(num(selected.unknownOwnerProcessCount) || 0)),
    ok: ordered.filter((p) => p.tone === NM_TONE.OK).length,
    unknown: ordered.filter((p) => p.tone === NM_TONE.UNKNOWN).length,
  };
  /* 帯の物差し。🚨 「要る時間」の一番大きい物で決める。
     ⚠ 「働ける時間」を物差しに入れてはいけない。工程を持てる人が多いと、その工程の
       「働ける時間」は月まるごとの人数ぶん（例 72人日）になり、物差しがそれで決まってしまう。
       すると 0.1人日 の工程は帯が1ピクセルも出ず、**色も長さも読めない画面**になる（実画面で確認）。 */
  const processScaleMinutes = Math.max(1, ...ordered.map((p) => num(p.requiredMinutes) || 0)) * 1.08;

  const remedy = remedyOf(decisionBoard);
  const education = educationOf(monthly.materials, educationLeadTime, monthly.baseNow);

  /* 決まり28・29: テンプレ毎に束ねた行（主役）。工程は各行の中に残す（消さない）。 */
  const templates = groupByTemplate(ordered, monthly.dayMinutes);
  const templateScaleMinutes = Math.max(1, ...templates.map((t) => num(t.requiredMinutes) || 0)) * 1.08;
  /* 決まり28: 「異常ならここがおかしい」を名指し。数は Worker が運んだ物だけ（ここで数えない）。 */
  const whyCounts = (selected.pileArrivalUnknown && isObj(selected.pileArrivalUnknown.whyCounts)) ? selected.pileArrivalUnknown.whyCounts : {};
  const alerts = [];
  const clamped = Math.max(0, Math.trunc(num(whyCounts.assumedClampedToNow) || 0));
  if (clamped > 0) alerts.push({ key: 'arrival-missing', tone: 'red', text: `${ARRIVAL_WHY_LABEL.assumedClampedToNow}ロット ${clamped}件（基準時刻に置いて数えています。入荷を登録すると消えます）` });
  const noRecordTemplates = templates.filter((t) => t.allNoRecord).length;
  if (noRecordTemplates > 0) alerts.push({ key: 'template-norecord', tone: 'amber', text: `誰もやった記録が無いテンプレ ${noRecordTemplates}個（記録が無い＝分かりません。やれない、ではありません）` });
  const unexplained = selected.pileUnexplained && num(selected.pileUnexplained.lotCount);
  if (unexplained != null && unexplained > 0) alerts.push({ key: 'pile-unexplained', tone: 'slate', text: `${str(monthly.holdingWord) || '到着待ち'}のまま記録0件で、入荷日でも説明が付かないロット ${unexplained}件` });

  return {
    ready: true,
    error: '',
    answer: selected.answer,
    why: selected.why,
    tone: selected.tone,
    months,
    selected,
    selectedIndex: num(selected.index),
    /* 🚨 見出しはここを読む。大きい答え（selected.answer）と必ず同じ月の名前になる。 */
    headingMonthLabel: str(selected.label),
    headingMonthYm: str(selected.ym),
    autoPicked,
    processes: ordered,
    processScaleMinutes,
    templates,
    templateScaleMinutes,
    alerts,
    formula: selected.formula || null,
    counts,
    remedy,
    education,
    workdaysUntilStart,
    roster: arr(monthly.roster).map(str).filter(Boolean),
    dayMinutes: num(monthly.dayMinutes),
    holdingWord: str(monthly.holdingWord) || '到着待ち',
    pileLotCount: num(monthly.pileLotCount),
    latestArrivalMs: num(monthly.latestArrivalMs),
    baseNow: num(monthly.baseNow),
    overdue: outlook.overdue || null,
    outside: outlook.outside || null,
    countPile,
  };
}

export default buildNextMonthView;
