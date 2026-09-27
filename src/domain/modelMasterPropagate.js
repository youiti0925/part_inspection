// ============================================================================
// 🚗➡📋 型式マスタの日数を変えたら、検査リストのロットをどう直すか を決める純関数
// ----------------------------------------------------------------------------
// 清水さん(2026-09-09):
//   「型式マスタ設定の納期とか入荷とか更新したら関係ある検査リストにあるものは更新するようにね」
//   「この進捗管理からデータが変更された場合は、製品検査なら型式マスタの入荷と納期をもとに
//     更新しないとだめだからね」
//
// 🚨 なぜ純関数として切り出したか:
//   型式マスタの画面で日数を打ち替えると、そのマスタから作られた **既に検査リストに居るロット**
//   の納期・入庫が置いてけぼりになる。今までは「次に Excel を取り込むまで直らない」ので、
//   盤面と現場の日付が食い違ったままになっていた。
//   ここに出せば node --test で回せるし、本番の写し(バックアップ)で「何件動くのか」を
//   押す前に数えられる。
//
// ----------------------------------------------------------------------------
// 📐 型式マスタの1エントリが持つ「3つの日数」。見た目は同じ「◯日」だが **起点が違う**。
//   daysBefore      … 進捗管理表の Z列(K33 検査予定日)からのずらし。負=前 / 0=当日 / 正=後
//   dueDaysBefore   … 入荷登録Excel に書かれた納期からのずらし。正=納期より前 / 負=後
//   entryDaysBefore … 入庫は「そのロットの納期」の何日前か。正=前
//   (呼び名と符号は src/domain/progressSheet.js・src/domain/importPlan.js と1ミリも同じ)
//
// 🚨 納期は **差分だけ動かす**。
//   ロットには「元の基準日(Z列の日付・Excelの納期)」が残っていない。だから
//   「新しいずらしで計算し直す」事はできず、old→new の **差の分だけ** 今の納期をずらす。
//   どちらの欄の差を使うかは **ロットの出どころ** で決める:
//     lot.importSource === 'progress-sheet'  → daysBefore の差
//     lot.importedFromExcel === true         → dueDaysBefore の差(入荷登録Excel)
//     印が無い(人が画面で登録した)ロット      → 納期は動かさない。skipped に理由を出す
//   ⚠ 印を見ずに全部動かすと、人が手で直した納期を型式マスタが勝手に上書きしてしまう。
//
// 🚨 入庫は **出どころに関係なく、今の納期から数え直す**(納期 − entryDaysBefore →
//   工場が休みなら前の営業日 → entryHHMM)。手で登録したロットでも数え直す。
//   ただし **作業記録があるロット・すでに検査へ来ているロットの入庫は動かさない**
//   (入庫はリードタイムの実測の起点。動かすと実績が壊れる)。
//   その時も納期だけは直すので、skipped ではなく updates の中で entryChange:false にする。
//
// 🚨 入庫を数え直すのは「今回の打ち替えで **納期が動いた**」か「**入庫の日数そのものを変えた**」時だけ。
//   なぜこの門が要るか(2026-09-09 本番の写しで実測):
//     Z列の日数(daysBefore)を1日変えただけで、納期は1件も動かないのに **入庫が89件動いた**。
//     今ある entryAt の多くは「入荷登録Excel に人が書いた入庫日時」や別の日数で入っていて、
//     「納期 − 3日 → 前の営業日 08:30」と元から一致していないため。
//     関係のない打ち替えで89件の入荷予定を黙って動かすのは、頼まれていない書き換え。
//   ⚠ 元からのズレをまとめて直したい時は alsoFixEntryMismatch:true を渡す(押す人が選ぶ)。
//
// ⚠ React も firebase も import しない(node --test で回すため)。
// ⚠ 関数の中で Date.now() を呼ばない。同じ入力なら毎回同じ答え。
// ⚠ 土日・祝日の判定を自分で書かない。工場の暦(factoryCalendar)1本だけを通す。
// ============================================================================

import { makeIsWorkday, prevWorkdayYmd, ymdOf } from './factoryCalendar.js';

/** ロットを動かさなかった理由。画面にそのまま出す文なので、ここ1箇所で持つ。 */
export const MMP_REASON = Object.freeze({
  // 🚚 2026-09-11 清水さんの説明で列の意味が変わってから増えた2つ
  DUE_FROM_SHEET: '納期は表に書いてある日そのもの（型式マスタの日数では動きません）',
  ENTRY_FROM_SHEET: '入荷の日は表に書いてあるので動かしません（型式マスタの日数は使いません）',
  MANUAL_LOT: '手で登録したロット（取込の印が無い）なので納期は動かしません',
  NO_DUE: '納期が入っていないので数え直しません',
  NO_CHANGE: '日付は変わりません',
});

/** 入庫を動かさなかった理由(updates の why に入る。ロット自体は納期だけ直す)。 */
export const MMP_ENTRY_FROZEN = Object.freeze({
  HAS_TASKS: '入庫は動かしません（作業記録があるため。リードタイムの実測が変わってしまいます）',
  MOVED_IN: '入庫は動かしません（すでに検査へ来ているため）',
});

// ---------------------------------------------------------------------------
// 日付まわり(その土地の時刻で数える)
// 🚨 progressSheet.js / importPlan.js と **同じ結果** になるように、同じ形で書く。
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' → Date / 読めなければ null。⚠ new Date(文字列) は帯で1日ズレるので使わない。 */
const parseYMD = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  // 2026-02-31 のような実在しない日を弾く(Date が黙って3/3にしてしまうため)
  if (dt.getFullYear() !== +m[1] || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) return null;
  return dt;
};

/** 'YYYY-MM-DD' を暦日で days 日 **後ろ** へずらす。days が負なら前へ。読めなければ ''。 */
const shiftDays = (ymd, days) => {
  const dt = parseYMD(ymd);
  if (!dt) return '';
  dt.setDate(dt.getDate() + (Number.isFinite(days) ? days : 0));
  return ymdOf(dt);
};

/** 'YYYY-MM-DD' + 'HH:MM' → epoch ms(その土地の時刻)。読めなければ null。 */
const ymdHHMMToMs = (ymd, hhmm = '08:30') => {
  const dt = parseYMD(ymd);
  if (!dt) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()) || [null, '8', '30'];
  dt.setHours(Math.min(23, +m[1]), Math.min(59, +m[2]), 0, 0);
  return dt.getTime();
};

/**
 * 空欄・null・読めない値なら fallback。0 と false は **実データ**(0日ずらし は意味を持つ)。
 * ⚠ progressSheet.js の daysBefore / entryDaysBefore の読み方と1ミリも同じ。
 */
const numOr = (v, fallback) =>
  (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : fallback;

/**
 * 型式名の揺れ(大文字小文字・空白・ハイフン・下線・カンマ・ドット)を吸収する。
 * ⚠ importPlan.js の normalizeModel と同じ形。ここだけ緩いと、同じ型式なのに引き当たらない。
 */
const normModel = (s) => String(s || '').toUpperCase().replace(/[\s\-_,.]/g, '');

/**
 * 日数の言い方。
 * @param frontPositive true = 正の数が「前」(納期基準・入庫) / false = 負の数が「前」(Z列基準)
 */
const daysLabel = (n, frontPositive) => {
  const v = Number(n) || 0;
  if (v === 0) return '0日';
  const front = frontPositive ? v > 0 : v < 0;
  return `${Math.abs(v)}日${front ? '前' : '後'}`;
};

/** ロットの出どころ。'progress' = 進捗管理表 / 'excel' = 入荷登録Excel / 'manual' = 手で登録 */
export const lotOriginOf = (lot) => {
  if (!lot || typeof lot !== 'object') return 'manual';
  if (String(lot.importSource || '').trim() === 'progress-sheet') return 'progress';
  if (lot.importedFromExcel === true) return 'excel';
  return 'manual';
};

/** 入庫を動かしてよいロットか。⚠ 実測の起点なので、記録が付いた後は動かさない。 */
const entryMovableOf = (lot) => {
  const hasTasks = !!(lot && lot.tasks && Object.keys(lot.tasks).length > 0);
  if (hasTasks) return { ok: false, why: MMP_ENTRY_FROZEN.HAS_TASKS };
  const loc = String((lot && lot.location) || '').trim();
  if (loc && loc !== 'arrival' && loc !== 'planned') return { ok: false, why: MMP_ENTRY_FROZEN.MOVED_IN };
  return { ok: true, why: '' };
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 型式マスタの 1エントリ(型式 × テンプレ)の日数を変えた時、
 * 検査リストに在る(未完了の)ロットをどう直すかを決める。
 *
 * @param {object} arg
 *   model                型式名(型式マスタの鍵)
 *   templateId           そのエントリのテンプレID。空なら **その型式の全テンプレ**が対象
 *   before               変える前のエントリ { daysBefore, dueDaysBefore, entryDaysBefore }
 *   after                変えた後のエントリ(同じ形)
 *   lots                 アプリのロット(全部。完了も含めて渡してよい)
 *   calendar             工場の暦(settings/config の factoryCalendar)。null = 登録なし(月〜金)
 *   defaultEntryDaysBefore 入庫の登録が空の時の既定(既定 3)。🚨 計算の中に直書きしない
 *   entryHHMM            入庫の時刻(既定 '08:30')
 *   alsoFixEntryMismatch 今回の打ち替えと関係なく、元から入庫がズレているロットも直すか(既定 false)
 * @returns {{
 *   updates: Array<{lotId,orderNo,model,templateId,origin,
 *                   oldDueDate,newDueDate,oldEntryAt,newEntryAt,oldEntryYMD,newEntryYMD,
 *                   why:string[], dueChange:boolean, entryChange:boolean, entryMovable:boolean}>,
 *   skipped: Array<{lotId,orderNo,model,templateId,origin,reason}>,
 *   counts: {updates,dueChange,entryChange,skipped,completedIgnored,considered},
 *   deltas: {progressDelta,excelDelta,entryBefore,entryAfter,changed}
 * }}
 *
 * 🚨 1つのロットは updates か skipped の **どちらか片方にしか出ない**。
 *   両方に出ると「N件を直します」の N が二重に数えられる。
 * 🚨 変わらないロットは updates に入れない(N が嘘にならないように)。
 */
export function planMasterChangeUpdates({
  model,
  templateId = '',
  before = null,
  after = null,
  lots = [],
  calendar = null,
  defaultEntryDaysBefore = 3,
  // 🚚 出荷日の何日前までに検査を終えるか。型式マスタに入っていない時の既定(progressSheet の割付と同じ値を渡す)
  defaultShipDaysBefore = 1,
  entryHHMM = '08:30',
  alsoFixEntryMismatch = false,
} = {}) {
  const worksOn = makeIsWorkday(calendar);
  const toPrevWorkday = (ymd) => (parseYMD(ymd) ? (prevWorkdayYmd(ymd, worksOn) || ymd) : ymd);

  const b = (before && typeof before === 'object') ? before : {};
  const a = (after && typeof after === 'object') ? after : {};

  const k33Before = numOr(b.daysBefore, 0);
  const k33After = numOr(a.daysBefore, 0);
  const dueBefore = numOr(b.dueDaysBefore, 0);
  const dueAfter = numOr(a.dueDaysBefore, 0);
  const entryBefore = numOr(b.entryDaysBefore, defaultEntryDaysBefore);
  const entryAfter = numOr(a.entryDaysBefore, defaultEntryDaysBefore);
  // 🚚 2026-09-11 清水さん「出荷日…その日に検査をしていたら出荷ができないから、
  //   型式マスタにその列の日に対して少し前に納期を設定する機能」
  //   納期 = 出荷日 − shipDaysBefore なので、日数を増やすと納期は **前へ** 動く(符号は反転)。
  const shipBefore = numOr(b.shipDaysBefore, defaultShipDaysBefore);
  const shipAfter = numOr(a.shipDaysBefore, defaultShipDaysBefore);
  const shipDelta = -(shipAfter - shipBefore);

  // 納期を動かす日数。
  //   進捗管理表(Z列基準): 納期 = 基準日 + daysBefore なので、差をそのまま足す。
  //   入荷登録Excel(納期基準): 納期 = Excelの納期 − dueDaysBefore なので、差の **符号を反転** して足す。
  const progressDelta = k33After - k33Before;
  const excelDelta = -(dueAfter - dueBefore);

  const out = {
    updates: [],
    skipped: [],
    counts: { updates: 0, dueChange: 0, entryChange: 0, skipped: 0, completedIgnored: 0, considered: 0 },
    deltas: {
      progressDelta, excelDelta, shipDelta, entryBefore, entryAfter, shipBefore, shipAfter,
      changed: progressDelta !== 0 || excelDelta !== 0 || shipDelta !== 0 || entryBefore !== entryAfter,
    },
  };

  // 🚨 型式が空なら1件も対象にしない。空を「全部に当たる」と読むと、
  //   1回の打ち間違いで検査リスト全部の納期が動く。
  const wantModel = normModel(model);
  if (!wantModel) return out;
  const wantTpl = String(templateId == null ? '' : templateId).trim();

  const push = (lot, origin, reason) => {
    out.skipped.push({
      lotId: lot.id || lot.__id || '',
      orderNo: String(lot.orderNo || ''),
      model: String(lot.model || ''),
      templateId: String(lot.templateId || ''),
      origin,
      reason,
    });
  };

  for (const lot of (Array.isArray(lots) ? lots : [])) {
    if (!lot || typeof lot !== 'object') continue;
    if (normModel(lot.model) !== wantModel) continue;
    if (wantTpl && String(lot.templateId || '').trim() !== wantTpl) continue;
    // 完了したロットは一切触らない(納期も入庫も、実績そのもの)
    if (lot.status === 'completed' || lot.location === 'completed') { out.counts.completedIgnored++; continue; }
    out.counts.considered++;

    const origin = lotOriginOf(lot);
    const oldDueDate = String(lot.dueDate || '').trim();
    if (!parseYMD(oldDueDate)) { push(lot, origin, MMP_REASON.NO_DUE); continue; }

    const why = [];

    // --- 納期 ---------------------------------------------------------------
    let newDueDate = oldDueDate;
    // 🔑 2026-09-11: 取込が残した印(dueBasis)が在れば、それが決める。
    //   印の無い古いロットは今までどおり 出どころ(progress / excel)で決める(答えを変えない)。
    const dueBasis = String(lot.dueBasis || '').trim();
    if (origin === 'progress' && dueBasis) {
      if (dueBasis === 'ship') {
        if (shipDelta !== 0) {
          newDueDate = shiftDays(oldDueDate, shipDelta) || oldDueDate;
          why.push(`出荷日の ${daysLabel(shipBefore, true)}→${daysLabel(shipAfter, true)}（出荷日が基準）`);
        }
      } else if (dueBasis === 'arrival') {
        if (progressDelta !== 0) {
          newDueDate = shiftDays(oldDueDate, progressDelta) || oldDueDate;
          why.push(`納期のずらし ${daysLabel(k33Before, false)}→${daysLabel(k33After, false)}（入荷の日が基準）`);
        }
      } else {
        // 納期の列・組立の完了予定から決めた納期は、型式マスタの日数では動かない
        why.push(MMP_REASON.DUE_FROM_SHEET);
      }
    } else if (origin === 'progress') {
      if (progressDelta !== 0) {
        newDueDate = shiftDays(oldDueDate, progressDelta) || oldDueDate;
        why.push(`納期のずらし ${daysLabel(k33Before, false)}→${daysLabel(k33After, false)}（進捗管理表のZ列が基準）`);
      }
    } else if (origin === 'excel') {
      if (excelDelta !== 0) {
        newDueDate = shiftDays(oldDueDate, excelDelta) || oldDueDate;
        why.push(`納期のずらし ${daysLabel(dueBefore, true)}→${daysLabel(dueAfter, true)}（入荷登録Excelの納期が基準）`);
      }
    } else {
      // 手で登録したロット。納期は動かさない(人が入れた日付を型式マスタで上書きしない)
      why.push(MMP_REASON.MANUAL_LOT);
    }
    const dueChange = newDueDate !== oldDueDate;
    if (dueChange) why.push(`納期 ${oldDueDate} → ${newDueDate}`);

    // --- 入庫(出どころに関係なく、今の納期から数え直す) ----------------------
    // 🚨 数え直すのは「納期が動いた」か「入庫の日数を変えた」時だけ。
    //   関係のない打ち替えで、元からズレていた入荷予定まで黙って動かさない。
    const entryDaysChanged = entryBefore !== entryAfter;
    // 🚚 2026-09-11 清水さん「まずZ列は入荷時間ね」
    //   表に **本物の入荷日** が書いてあるロットの入庫は、型式マスタの日数では動かさない。
    //   (動かすと「表に書いてある入荷日」と「アプリの入庫」が食い違う)
    const entryFromSheet = String(lot.entryBasis || '').trim() === 'arrivalCol';
    const recomputeEntry = !entryFromSheet && (dueChange || entryDaysChanged || alsoFixEntryMismatch);
    const movable = entryFromSheet ? { ok: false, why: MMP_REASON.ENTRY_FROM_SHEET } : entryMovableOf(lot);
    // 🚨 2026-09-11: 取込と **同じ元の日** から数える。
    //   取込は entryBasis='fromDueCol' の行を「表の納期の列(AB)」から数えている。
    //   ここで「決まった納期」から数えると、納期が出荷日(AD)から来ている行では別の日になり、
    //   入荷の日数を1日変えただけで何十日も飛ぶ(2026-09-11 実測 83件が3日超え・最大371日)。
    //   ロットに残した entryBase(元にした日)が在ればそれを使う。無い古いロットは今までどおり納期から。
    const entryFrom = parseYMD(String(lot.entryBase || '').trim()) ? String(lot.entryBase).trim() : newDueDate;
    const newEntryYMD = toPrevWorkday(shiftDays(entryFrom, -entryAfter));
    const newEntryAt = ymdHHMMToMs(newEntryYMD, entryHHMM);
    const oldEntryAt = Number(lot.entryAt) || 0;
    const oldEntryYMD = oldEntryAt ? (ymdOf(oldEntryAt) || '') : '';
    // ⚠ 1分未満の差は「変わっていない」とみなす(progressSheet の更新判定と同じ物差し)
    const entryChange = !!(recomputeEntry && movable.ok && newEntryAt && Math.abs(oldEntryAt - newEntryAt) >= 60000);

    if (entryChange) {
      if (entryDaysChanged) {
        why.push(`入庫 ${daysLabel(entryBefore, true)}→${daysLabel(entryAfter, true)}（納期が基準）`);
      }
      why.push(`入庫 ${oldEntryYMD || '（未設定）'} → ${newEntryYMD}`);
    } else if (entryFromSheet && (dueChange || entryDaysChanged)) {
      // 🚚 表に書いてある入荷日なので動かさない。黙って素通りさせず、理由を残す。
      why.push(MMP_REASON.ENTRY_FROM_SHEET);
    } else if (recomputeEntry && !movable.ok) {
      // 数え直す所だった物だけ、動かさない理由を出す(関係ない打ち替えで札を出さない)
      why.push(movable.why);
    }

    if (!dueChange && !entryChange) {
      push(lot, origin, origin === 'manual' ? MMP_REASON.MANUAL_LOT : MMP_REASON.NO_CHANGE);
      continue;
    }

    out.updates.push({
      lotId: lot.id || lot.__id || '',
      orderNo: String(lot.orderNo || ''),
      model: String(lot.model || ''),
      templateId: String(lot.templateId || ''),
      origin,
      oldDueDate,
      newDueDate,
      oldEntryAt,
      newEntryAt: entryChange ? newEntryAt : oldEntryAt,
      oldEntryYMD,
      newEntryYMD: entryChange ? newEntryYMD : oldEntryYMD,
      why,
      dueChange,
      entryChange,
      entryMovable: movable.ok,
    });
  }

  out.counts.updates = out.updates.length;
  out.counts.dueChange = out.updates.filter((u) => u.dueChange).length;
  out.counts.entryChange = out.updates.filter((u) => u.entryChange).length;
  out.counts.skipped = out.skipped.length;
  return out;
}
