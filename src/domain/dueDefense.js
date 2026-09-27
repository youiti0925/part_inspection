// ============================================================================
// ⏰ 納期だけを扱う。人を見ない。
// ----------------------------------------------------------------------------
// このファイルの仕事は「残りの時間」と「1日にできる時間」から
// 見込み完了日を出し、納期に間に合うかを言うこと。それだけ。
// 誰ができるかは軸A(dispatchAbility)の仕事で、ここには持ち込まない。
// ただし見立てB(実績のある人しか回せない)を出す時だけ、軸Aの索引を
// **引数で** 受け取る。ここで可否を作り直す事はしない。
//
// 🚨 見立てBを「悲観」と呼んではいけない。
//   Bの方が件数が少なく出るのは、Bが「回せる人がいない仕事を飛ばして先の仕事を進める」
//   ことを許しているからで、Aより悲観なわけではない。両方出して
//   「どちらの見立てでも100件前後が割れる」という向きだけを結論にする。
//
// 【入れていない物】工程の順番・段取り替え・機械の取り合い・外注・人ごとの速さの差。
//   よってこの日付は「うまく回った場合」の値であり、これより早くはならない側ではない。
//   ⚠ 祝日は 2026-09-01 に入れた(工場の暦)。projectDueRisk に calendar を渡すと効く。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

// 📅 工場の暦(祝日・全社休業・休日出勤)。稼働日の判定はここ1本だけを通す。
import { makeIsWorkday } from './factoryCalendar.js';

import { remainingByTasks } from './lotRemaining.js';

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const DAY_MS = 86400000;

// ── 納期の読み取り (App.jsx:627 parseDueParts と同じ規則) ─────────────────────
// 📅 実在する日付か(2/30・4/31・平年の2/29 を弾く)。UTC で作るので端末の帯に依らない。
//   ⚠ factoryCalendar.partsOfYmd と同じ書き方。片方だけ変えない。
const isRealYmd = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
/** 取消の注記(「9/25（取消）」「キャンセル」)。これが付いた日付を有効な予定にしない。 */
export const DUE_CANCEL_RE = /取消|取り消|キャンセル|中止|不要|×/;
export const dueCancelled = (raw) => typeof raw === 'string' && DUE_CANCEL_RE.test(raw);
/** 日付らしい書き方か(数字を / . - 年 で繋いでいる)。parseDueParts が null を返したなら「拒否した」であって「形が読めない」ではない。 */
export const looksLikeDate = (raw) => typeof raw === 'string' && /\d\s*[/.\-年]\s*\d/.test(raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
export const parseDueParts = (raw) => {
  if (raw == null || raw === '') return null;
  if (dueCancelled(raw)) return null;   // 🚨 取消の注記が付いた日付を予定にしない(括弧の中を消す前に見る)
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : { y: raw.getFullYear(), m: raw.getMonth() + 1, d: raw.getDate() };
  if (typeof raw === 'number' && isFinite(raw)) {
    if (raw > 10 && raw < 100000) { const dt = new Date(Math.round((raw - 25569) * DAY_MS)); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
    const dt = new Date(raw); return isNaN(dt.getTime()) ? null : { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (/^\d{5}$/.test(s)) return parseDueParts(Number(s));
  s = s.replace(/[（(].*?[)）]/g, ' ').replace(/[（(].*$/, ' ');
  // ⚠ App.jsx:627 は /[.\-]/ と書いてあるが、文字クラスの末尾の - は元から文字そのもの。
  //   [.-] と書いても振る舞いは1文字も変わらない(出荷ゲートの no-useless-escape を通すため)。
  s = s.replace(/[年月]/g, '/').replace(/日/g, '').replace(/[.-]/g, '/').trim();
  s = s.replace(/\/+/g, '/').replace(/\/$/, '');
  const parts = s.split('/').map((x) => x.trim()).filter((x) => x !== '');
  const nums = parts.map(Number);
  if (!nums.length || nums.some((n) => !isFinite(n))) return null;
  let y, m, d;
  if (nums.length >= 3) {
    if (String(parts[2]).length === 4) { y = nums[2]; m = nums[0]; d = nums[1]; }
    else { y = nums[0] < 100 ? 2000 + nums[0] : nums[0]; m = nums[1]; d = nums[2]; }
  } else if (nums.length === 2) { m = nums[0]; d = nums[1]; y = null; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y == null) {
    const now = new Date(); const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let cand = new Date(now.getFullYear(), m - 1, d);
    if ((today0.getTime() - cand.getTime()) > 90 * DAY_MS) cand = new Date(now.getFullYear() + 1, m - 1, d);
    y = cand.getFullYear();
  }
  if (!isRealYmd(y, m, d)) return null;   // 2026/2/30 → 3/2 のような化けを止める(打ち間違いは「読めない」)
  return { y, m, d };
};

/**
 * ロットの納期(ms)。読めない書式は Date.parse で救う。
 * 🚨 救済が要る理由: 完了ロット25件が `Mon Jun 08 2026 09:00:00 GMT+0900 (日本標準時)` 形式で
 *   保存されている。parseDueParts は括弧を落とすとスラッシュが1つも残らないので null を返し、
 *   その25件が納期の集計から **黙って** 消える(納期遵守率 48.2% → 46.8% のズレ)。
 *   画面に出す文字は元のまま出るので、見ているだけでは気づけない。
 */
export const dueMsOfLot = (lot) => {
  const raw = lot?.dueDate;
  if (raw == null || raw === '') return null;
  const p = parseDueParts(raw);
  if (p) return new Date(p.y, p.m - 1, p.d).getTime();
  // 🚨 2026-09-22 拒否した物を救済で別の日へ戻さない。'2026/2/30' は parseDueParts が **わざと** null を返す。
  //   ここで Date.parse に回すと V8 が 3/2 に化かす(拒否が無かった事になる)。日付らしい形・取消は救済しない。
  if (dueCancelled(raw) || looksLikeDate(raw)) return null;
  const t = Date.parse(String(raw));
  if (isNaN(t)) return null;
  const dt = new Date(t);
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();   // その日の0時に丸める
};

/**
 * 読取不能・空欄・取消・日付 を区別する(取込で元セルと一緒に残す為)。
 * @returns {{ kind:'empty'|'cancelled'|'unreadable'|'date', raw, y?, m?, d?, yearGuessed?:boolean }}
 */
export const classifyDue = (raw) => {
  if (raw == null || String(raw).trim() === '') return { kind: 'empty', raw };
  if (dueCancelled(raw)) return { kind: 'cancelled', raw };
  const p = parseDueParts(raw);
  if (!p) return { kind: 'unreadable', raw };
  const yearWritten = typeof raw !== 'string' || /\d{4}|\b\d{2}[/.\-年]\d{1,2}[/.\-月]\d{1,2}/.test(raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  return { kind: 'date', raw, y: p.y, m: p.m, d: p.d, yearGuessed: !yearWritten };
};

// ── 1日にできる時間 ──────────────────────────────────────────────────────────
// App.jsx:2227 DEFAULT_WORK_SCHEDULE と同じ。settings.workSchedule が無い時はこれになる。
// 実データの settings.breakAlerts(10:00/12:00/15:00/17:00定時/19:15残業2時間)と一致するので、
// 別のフィールドから独立に裏が取れている。
export const DEFAULT_WORK_SCHEDULE = Object.freeze({
  dayStart: '08:30', dayEnd: '17:00', overtimeStart: '17:15', overtimeEnd: '19:15',
  breaks: [
    { start: '10:00', end: '10:10' }, { start: '12:00', end: '12:45' },
    { start: '15:00', end: '15:15' }, { start: '17:00', end: '17:15' },
  ],
  daysPerWeek: 5, daysPerMonth: 20, includeOvertimeInCapacity: false,
});

const timeStrToMinutes = (s) => {
  if (!s || typeof s !== 'string') return 0;
  const [h, m] = s.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
};
const overlapMinutes = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** App.jsx:2311 computeWorkHours と同じ式。定時と残業を分けて返す。 */
export const computeWorkHours = (schedule) => {
  const sch = { ...DEFAULT_WORK_SCHEDULE, ...(schedule || {}) };
  const dayStart = timeStrToMinutes(sch.dayStart);
  const dayEnd = timeStrToMinutes(sch.dayEnd);
  const otStart = timeStrToMinutes(sch.overtimeStart);
  const otEnd = timeStrToMinutes(sch.overtimeEnd);
  const breaks = (sch.breaks || []).map((b) => ({ start: timeStrToMinutes(b.start), end: timeStrToMinutes(b.end) }));
  const regularSpan = Math.max(0, dayEnd - dayStart);
  const regularBreak = breaks.reduce((a, b) => a + overlapMinutes(b.start, b.end, dayStart, dayEnd), 0);
  const regularMinutes = Math.max(0, regularSpan - regularBreak);
  let overtimeMinutes = 0;
  if (otEnd > otStart) {
    const otBreak = breaks.reduce((a, b) => a + overlapMinutes(b.start, b.end, otStart, otEnd), 0);
    overtimeMinutes = Math.max(0, (otEnd - otStart) - otBreak);
  }
  return {
    regularMinutes, overtimeMinutes, totalMinutes: regularMinutes + overtimeMinutes,
    regularHours: regularMinutes / 60, overtimeHours: overtimeMinutes / 60,
    totalHours: (regularMinutes + overtimeMinutes) / 60,
  };
};

/**
 * チーム全体で1日に使える時間(h)。App.jsx:38295 の式と同じ。
 *   人数 × 定時時間 ÷ 間接係数
 * 実データ = 3 × (440÷60) ÷ 1.3 = 16.92 h/日。1人あたりは 5.64 h/人日。
 * 🚨 直書きの数字は1つも無い。全部 settings から計算している。
 */
export const capacityPerDayHours = (settings, workers = null) => {
  const wh = computeWorkHours(settings?.workSchedule);
  const override = Number(settings?.workloadEffectiveWorkers);
  // 🚨 本体 App.jsx:38267-38268 と同じ順で決める:「上書きがあればそれ、無ければ登録人数」。
  //   ここを 0 に倒すと能力0h/日になり、projectDueRisk が全件を『終わらない』に落として
  //   赤帯が「納期に間に合わないのは0件」という**最も危険な嘘**を出す(実測で再現済み)。
  const registered = Array.isArray(workers) ? workers.length : (Number(workers) > 0 ? Number(workers) : 0);
  const n = (isFinite(override) && override > 0) ? override : registered;
  const f = Number(settings?.indirectFactor);
  const factor = (isFinite(f) && f > 0) ? f : 1;
  const perPerson = wh.regularHours / factor;
  // unknown=true は「人数が分からない」。画面は件数を出さず『計算できません』と書く事。
  return { hours: n * perPerson, perPersonHours: perPerson, workers: n, regularHours: wh.regularHours, indirectFactor: factor, unknown: !(n > 0) };
};

const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** 納期の遠さで札を分ける。②①は納期だけで数える(人を見ない)。 */
export const bucketOfDue = (dueMs, nowMs) => {
  if (dueMs == null) return 'noDue';
  const d = Math.floor((startOfDay(dueMs) - startOfDay(nowMs)) / DAY_MS);
  if (d < 0) return 'overdue';
  if (d <= 7) return 'within7';
  if (d <= 30) return 'within30';
  return 'later';
};

// ── 残り時間 ─────────────────────────────────────────────────────────────────
/**
 * そのロットの残り時間(h)。既存の remainingByTasks(src/domain/lotRemaining.js)をそのまま呼ぶ。
 * 工程当ての実装を書き直さない(既存49件の試験が守っている物を動かさないため)。
 */
export const remainingHoursOfLot = (lot, targetSecOf) => {
  // ⚠ targetSecOf は (step, lot) で呼ぶ。目標時間は型式ごとに較正されうるので、
  //   呼ぶ側が型式を知らないと getEffectiveTargetTime を組み立てられない。
  if (typeof targetSecOf !== 'function') return 0;
  const r = remainingByTasks(lot, (step) => targetSecOf(step, lot));
  return Math.max(0, r.remainingSec) / 3600;
};

/** 未完了ロットか。🚨 status だけで数えると1件多い(location==='completed' の物がある)。 */
export const isOpenLot = (lot) => !!lot && lot.status !== 'completed' && lot.location !== 'completed';

/**
 * 納期の計算に渡す行を作る。人は見ない。
 * ⚠ bucket(納期の遠さの札)もここで付ける。教育カードの重み付けが
 *   同じ札を見るようにして、画面と教育の並びが食い違わないようにするため。
 * @returns {Array<{lotId,lot,tid,model,dueMs,remainingH,bucket}>}
 */
export const buildOpenRows = (lots, { targetSecOf, nowMs = Date.now() } = {}) => asArray(lots)
  .filter(isOpenLot)
  .map((lot) => {
    const dueMs = dueMsOfLot(lot);
    return {
      lotId: String(lot.__id || lot.id || ''),
      lot,
      tid: String(lot.templateId || ''),
      model: String(lot.model || ''),
      dueMs,
      remainingH: remainingHoursOfLot(lot, targetSecOf),
      bucket: bucketOfDue(dueMs, nowMs),
    };
  });

// ── 見込み完了日 ─────────────────────────────────────────────────────────────
// 📅 2026-09-01 工場の暦(祝日表)を繋いだ。以前はここに「土日だけ休み」を直に書いていて、
//   祝日を営業日として数えていた(= 納期に間に合う日数を多く見せていた)。
//   🚨 calendar を渡さなければ今までと1ミリも同じ(登録が空 = 月〜金)。
const defaultIsWorkday = makeIsWorkday(null);

/**
 * 納期に間に合うかを出す。
 *
 * @param {Array} openRows buildOpenRows の戻り
 * @param {Object} o
 *   targetSecOf … 使わない(openRows が既に残り時間を持つ)。互換のため受けるだけ。
 *   capacityH   … 1日にチーム全体で使える時間。見立てAで使う。
 *   startMs     … 計算の起点
 *   calendar    … 工場の暦(祝日・全社休業・休日出勤)。渡すと祝日を営業日から外す。
 *   isWorkday   … (ms)=>boolean。calendar より優先(試験が任意の暦を差し込むため)。
 *   abilityIndex/whoCanDo/templates/people/perPersonH
 *               … 与えると見立てB(実績のある人しか回せない)になる。
 * @returns {{rows,lateCount,total,allDoneMs,neverDone}}
 */
export const projectDueRisk = (openRows, {
  capacityH = 0, startMs = Date.now(), calendar = null, isWorkday = null,
  abilityIndex = null, whoCanDo = null, templates = null, people = null, perPersonH = 0,
  maxDays = 4000,
} = {}) => {
  // 🚨 稼働日の判定は1本だけ。渡された isWorkday が最優先、無ければ暦から畳む、暦も無ければ既定(月〜金)。
  const worksOn = isWorkday || (calendar ? makeIsWorkday(calendar) : defaultIsWorkday);
  const rows = asArray(openRows).map((r) => ({ ...r, finishMs: null, lateDays: 0, bucket: bucketOfDue(r.dueMs, startMs), late: false, people: null }));
  // 納期の早い順(EDD)。納期の無い物は最後に回す。
  rows.sort((a, b) => {
    const da = a.dueMs == null ? Infinity : a.dueMs;
    const db = b.dueMs == null ? Infinity : b.dueMs;
    if (da !== db) return da - db;
    return String(a.lotId).localeCompare(String(b.lotId));
  });

  const neverDone = [];
  // 🚨 片方だけ渡されたら**黙って見立てAに落ちない**。落ちると
  //   「実績のある人しか回せない」を頼んだつもりが全員が回せる前提の答えが返り、
  //   エラーも旗も出ないまま別物を見せる事になる。
  if ((abilityIndex && !whoCanDo) || (!abilityIndex && whoCanDo)) {
    throw new Error('projectDueRisk: 見立てB(実績のある人しか回せない)には abilityIndex と whoCanDo の両方が要ります');
  }
  const useAbility = !!(abilityIndex && whoCanDo);
  // 🚨 能力が出せない時は件数を数字で返さない(0件と出させない)。
  if (!(capacityH > 0) && !useAbility) {
    return { rows, lateCount: null, total: rows.length, allDoneMs: null, neverDone: rows.slice(), capacityUnknown: true };
  }
  if (useAbility && !(perPersonH > 0)) {
    return { rows, lateCount: null, total: rows.length, allDoneMs: null, neverDone: rows.slice(), capacityUnknown: true };
  }
  if (useAbility) {
    rows.forEach((r) => { r.people = whoCanDo(abilityIndex, r.lot, templates).people; });
  }

  let day = startOfDay(startMs);
  let guard = 0;
  const advance = () => { do { day += DAY_MS; guard++; } while (!worksOn(day) && guard < maxDays * 7); };
  if (!worksOn(day)) advance();

  const finishAtDay = (d) => d + DAY_MS - 1;   // その日の終わりに終わった、と数える

  if (!useAbility) {
    // ── 見立てA: 能力を1本の列で消費する ──
    let left = capacityH;
    for (const r of rows) {
      let need = r.remainingH;
      if (!(capacityH > 0)) { neverDone.push(r); continue; }
      if (need <= 0) { r.finishMs = finishAtDay(day); continue; }
      let n = 0;
      while (need > 1e-9) {
        if (left <= 1e-9) { advance(); left = capacityH; n++; if (n > maxDays) break; }
        const take = Math.min(need, left);
        need -= take; left -= take;
      }
      if (need > 1e-9) { neverDone.push(r); continue; }
      r.finishMs = finishAtDay(day);
    }
  } else {
    // ── 見立てB: その仕事の実績を持つ人しか進められない ──
    //   回せる人が居ない仕事は **飛ばして** 先の仕事を進める(だから件数はAより少なく出る)。
    // 🚨 名簿を省略したら**データに出てくる名前の和集合**になり、見立てAと人数がズレる(4人 vs 3人)。
    //   同じ土俵で比べられなくなるので、省略を許さない。
    if (!asArray(people).length) {
      throw new Error('projectDueRisk: 見立てBには people(名簿)が要ります。見立てAと同じ人数で比べるためです');
    }
    const roster = asArray(people);
    const pending = rows.filter((r) => {
      if (!(r.people && r.people.length)) { neverDone.push(r); return false; }
      if (r.remainingH <= 0) { r.finishMs = finishAtDay(day); return false; }
      return true;
    });
    let d = 0;
    while (pending.some((r) => r.finishMs == null) && d < maxDays && perPersonH > 0) {
      const cap = new Map(roster.map((n) => [n, perPersonH]));
      for (const r of pending) {
        if (r.finishMs != null) continue;
        let need = r.remainingH - (r._done || 0);
        for (const n of r.people) {
          const c = cap.get(n) || 0;
          if (c <= 1e-9) continue;
          const take = Math.min(need, c);
          cap.set(n, c - take); need -= take;
          r._done = (r._done || 0) + take;
          if (need <= 1e-9) break;
        }
        if (need <= 1e-9) r.finishMs = finishAtDay(day);
      }
      if (pending.some((r) => r.finishMs == null)) { advance(); d++; }
    }
    pending.forEach((r) => { if (r.finishMs == null) neverDone.push(r); });
  }

  let lateCount = 0;
  let allDoneMs = null;
  rows.forEach((r) => {
    delete r._done;
    if (r.finishMs == null) return;
    allDoneMs = allDoneMs == null ? r.finishMs : Math.max(allDoneMs, r.finishMs);
    if (r.dueMs == null) return;
    const limit = r.dueMs + DAY_MS - 1;      // 納期当日いっぱいまでは間に合っている
    if (r.finishMs > limit) {
      r.late = true;
      r.lateDays = Math.round((startOfDay(r.finishMs) - startOfDay(r.dueMs)) / DAY_MS);
      lateCount++;
    }
  });

  return { rows, lateCount, total: rows.length, allDoneMs, neverDone };
};
