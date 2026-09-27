// 「この工程を実際にやった事があるのは誰か」を、いま在る作業記録だけから数える純関数。
// React も Firebase も import しない (node --test で単体で動く)。
//
// 🚨 言葉の約束 (ここを外すと結論が嘘になる)
//   ・1人だけ = 「その人しか**できない**」ではない。「**この工程を実際にやった事があるのは◯◯さんだけ**」
//   ・0人     = 「できない」ではない。「**まだ誰もやっていない**」(記録が0件、という意味しかない)
//   ・誰がやったか分からない記録を黙って捨てない。必ず数えて一緒に返す
//     (実測で completed タスクの 17.9% に作業者名が無い → **人数は少なく出る**)
//   ・登録作業者に無い自由入力の名前を、勝手に誰かへ寄せない (unknown として別に数える)
//   ・ロット1回工程(step.lotOnce)は回数の数え方が違う。**台数を掛けない**
//
// 🚨 スキル設定は**1件も使わない**。
//    実測 (2026-08-11 バックアップ / product-inspection-v1):
//      template.requiredSkills … 28テンプレ中 **0件**
//      settings.workerSkills / settings.skills … **存在しない**
//      knowledge_records / knowledge_courses … **バックアップに0件**
//    つまり「スキルの設定」からは何も出せない。実際の作業記録だけから出す。
//
// 🚨 工程の身元 = `templateId + step.id`。実データを読んで確かめた上で選んだ (推測ではない):
//    ・step.category は lot.steps 3,269件中 **0件**。
//      → App.jsx の `targetTimeStepKey = ${category}_${title}` は `_タイトル` に退化する
//    ・工程タイトルは65種のうち **28種が複数テンプレに重複**して出る
//      → タイトルだけで束ねると、別テンプレの別作業が同じ工程として混ざる
//    ・step.id はテンプレ内でロットをまたいで**安定していた**。
//      テンプレ×タイトル 198組のうち、step.id が2つ以上に割れた組は **0組**
//    ・step.id 195種は**すべて1つのテンプレにしか出ない**(テンプレ跨ぎの衝突は実測0)
//    ・step.id はタイトルの改名を跨いで同じ工程を束ねる (実測3件。例:「片付け」→「後片付け」)。
//      タイトルで束ねると、この3件は別の工程に割れてしまう
//    → よって `templateId + step.id`。タイトルは**表示名としてだけ**使い、改名の履歴も返す。
//    ⚠ この安定性は「今のデータで測ったらそうだった」という事実であって、保証ではない。
//      壊れた時に気付けるよう `titleHistory` と `titleRenamed` を工程ごとに出力へ残す。

// -----------------------------------------------------------------------------
// 0. 小道具
// -----------------------------------------------------------------------------
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** ドキュメントの身元。バックアップは `__id` しか持たない事がある (`id` で引くと必ず null になる)。 */
export const docIdOf = (d) => str(d?.id ?? d?.__id);

/**
 * 工程の身元キー。⚠ タイトルは入れない (改名で別工程に割れるため)。
 * 🚨 区切り文字を1つ決めて挟む方式にしない。テンプレIDや step.id にその字が入らない事を
 *    「たぶん入らない」で済ませると、`a|bc` と `ab|c` が同じキーになる事故が起きる。
 *    先に**長さ**を書くので、どんな文字列でも1つのキーにしかならない (逆も一意)。
 */
export const processKeyOf = (templateId, stepId) => {
  const t = str(templateId);
  return `${t.length}:${t}:${str(stepId)}`;
};
export const parseProcessKey = (key) => {
  const k = str(key);
  const i = k.indexOf(':');
  if (i < 0) return { templateId: '', stepId: '' };
  const n = Number(k.slice(0, i));
  if (!Number.isInteger(n) || n < 0 || i + 1 + n + 1 > k.length) return { templateId: '', stepId: '' };
  return { templateId: k.slice(i + 1, i + 1 + n), stepId: k.slice(i + 1 + n + 1) };
};

// -----------------------------------------------------------------------------
// 1. 区分 (3つに分ける + 「分からない」を0人に混ぜない)
// -----------------------------------------------------------------------------
// 🚨 依頼は「0人 / 1人 / 2人以上」の3つ。ただし
//    「誰かがやったが誰かが分からない」工程を 0人 に入れると
//    **「まだ誰もやっていない」が嘘になる**。だから UNCLEAR を別に立てる。
export const BUCKET = Object.freeze({
  NOBODY_YET: 'NOBODY_YET',
  ONE_PERSON_ONLY: 'ONE_PERSON_ONLY',
  TWO_OR_MORE: 'TWO_OR_MORE',
  UNCLEAR: 'UNCLEAR',
});

export const BUCKET_LABEL = Object.freeze({
  NOBODY_YET: 'まだ誰もやっていない',
  ONE_PERSON_ONLY: '実際にやった事があるのは1人だけ',
  TWO_OR_MORE: '実際にやった事があるのは2人以上',
  UNCLEAR: '誰かがやったが、誰がやったか分からない',
});

/** 🚨「その人しかできない」と書かないための、決まった言い方。 */
export const soloDoerSentence = (name) => {
  const n = trimmed(name);
  if (!n) return 'この工程を実際にやった事がある人は1人だけ（名前が分からない）';
  return `この工程を実際にやった事があるのは${/(さん|様)$/.test(n) ? n : `${n}さん`}だけ`;
};
export const nobodyYetSentence = () => 'まだ誰もやっていない（やった記録が1件も無い。できないという意味ではない）';

// 数え方の単位。⚠ lotOnce は「台数」ではなく「実施回数」。台数を掛けてはいけない。
//
// 🚨 単位は `step.lotOnce` では決められない。実測 (2026-08-11 バックアップ):
//      lotOnce === true  … ロット工程 752件 / 台帳 31件
//      lotOnce === false … **1件も書かれていない**（0件）
//      書かれていない    … ロット工程 2,517件 / 台帳 190件
//    「書かれていない」を false と読むのは推測。だから**タスクキーの形**で決める。
//      `${step.id}-lot-${連番}` … 実施回数で1件 (回)
//      `${step.id}-${台番号}`   … 台ごとに1件 (台)
//    これは記録そのものなので推測が要らない。
// 🚨 実測で、同じ工程に**両方の形が混ざっている物が5件**あった (途中で lotOnce を変えた跡)。
//    足すと「台」と「回」を足す事になる。だから MIXED を別に立てて、足させない。
export const COUNT_UNIT = Object.freeze({
  UNITS: 'units',           // 台ごとのタスク (`${step.id}-${台番号}`)
  EXECUTIONS: 'executions', // ロット1回工程 (`${step.id}-lot-${連番}`)
  MIXED: 'mixed',           // 🚨 両方が混ざっている。台と回を足してはいけない
  UNKNOWN: 'unknown',       // 記録が無く、lotOnce も書かれていない
});
export const COUNT_UNIT_LABEL = Object.freeze({
  units: '台',
  executions: '回',
  mixed: '🚨台と回が混在（足してはいけない）',
  unknown: '件（台か回か決められない）',
});

// -----------------------------------------------------------------------------
// 2. 作業者の索引
// -----------------------------------------------------------------------------
/**
 * 登録作業者の索引。同姓同名は**自動で解決しない**。
 * @param {Array} workers
 */
export function indexWorkers(workers) {
  const list = asArray(workers)
    .map((w) => ({ id: docIdOf(w), name: trimmed(w?.name) }))
    .filter((w) => w.id);
  const byId = new Map(list.map((w) => [w.id, w]));
  const nameToIds = new Map();
  list.forEach((w) => {
    if (!w.name) return;
    const a = nameToIds.get(w.name) || [];
    a.push(w.id);
    nameToIds.set(w.name, a);
  });
  const ambiguousNames = new Set([...nameToIds.entries()].filter(([, a]) => a.length > 1).map(([n]) => n));
  return { list, byId, nameToIds, ambiguousNames };
}

/**
 * 名前 → 作業者。
 * @returns {{status:'resolved'|'ambiguous'|'unregistered'|'absent', id:string|null}}
 *   ambiguous     … 同姓同名。🚨どちらかへ寄せない
 *   unregistered  … 登録作業者に無い自由入力。🚨誰かへ寄せない
 */
export function resolveWorkerName(name, idx) {
  const n = trimmed(name);
  if (!n) return { status: 'absent', id: null };
  if (idx.ambiguousNames.has(n)) return { status: 'ambiguous', id: null };
  const ids = idx.nameToIds.get(n);
  if (ids && ids.length === 1) return { status: 'resolved', id: ids[0] };
  return { status: 'unregistered', id: null };
}

// -----------------------------------------------------------------------------
// 3. タスクキー → 工程
// -----------------------------------------------------------------------------
/**
 * タスクキーから工程(step.id)を決める。
 * App.jsx の決まり: 通常 `${step.id}-${台番号}` / ロット1回 `${step.id}-lot-${連番}`。
 * ⚠ 古いロットには `${工程の並び番号}-${台番号}` 形も残っている → step.id で当たらない物だけ並び番号で引く。
 * ⚠ どちらでも決まらない物は **unknown**。工程名の文字列で当てに行かない。
 * @param {string} taskKey
 * @param {Array} steps  そのロットの steps (テンプレのではなく、ロットに焼かれた物)
 */
export function resolveTaskProcess(taskKey, steps) {
  const list = asArray(steps);
  const byId = new Map();
  list.forEach((s, i) => {
    const id = str(s?.id);
    if (id && !byId.has(id)) byId.set(id, { step: s, index: i });
  });
  const key = str(taskKey);

  const lotOnceKey = /^(.+)-lot-(\d+)$/.exec(key);
  if (lotOnceKey) {
    const hit = byId.get(lotOnceKey[1]);
    if (hit) return { stepId: str(hit.step?.id), step: hit.step, index: hit.index, resolved: true, via: 'stepId-lot' };
    // ⚠ ここで打ち切らない。step.id そのものが `-lot-数字` で終わる場合、
    //    上の切り出しは頭を削り過ぎている。下の通常形でもう一度だけ引く (完全一致なので誤爆しない)。
  }

  const m = /^(.*)-(\d+)$/.exec(key);
  if (!m) return { stepId: null, step: null, index: null, resolved: false, via: 'unknown' };
  const head = m[1];
  const hit = byId.get(head);
  if (hit) return { stepId: str(hit.step?.id), step: hit.step, index: hit.index, resolved: true, via: 'stepId' };
  if (/^\d+$/.test(head)) {
    const i = Number(head);
    const s = list[i];
    if (s && str(s.id)) return { stepId: str(s.id), step: s, index: i, resolved: true, via: 'legacyIndex' };
  }
  return { stepId: null, step: null, index: null, resolved: false, via: 'unknown' };
}

// -----------------------------------------------------------------------------
// 4. 1タスクの「誰がやったか」
// -----------------------------------------------------------------------------
/**
 * 1件のタスクから「やった人」を取り出す。
 * 🚨 引き継ぎ(1タスクを2人で分ける)が実在するので、**1人に決め打ちしない**。
 *
 * 使う所は3つだけ (どれも「その工程をやった」という記録そのもの):
 *   1) task.sessions[].workerId  … IDで証明できる (一番強い)
 *   2) task.sessions[].workerName / task.workerName … 名前だけ (同姓同名だと決められない)
 *   3) どちらも無い → **誰がやったか分からない**
 * 🚨 lot.workerId は使わない。あれは「ロットの担当」であって
 *    「その工程をやった人」の記録ではない (使うと過大に数える)。
 *
 * @returns {{
 *   byId: string[], byName: string[], ambiguousNames: string[], unregisteredNames: string[],
 *   evidence: 'workerId'|'name'|'ambiguousName'|'unregisteredName'|'none'
 * }}
 */
export function attributeTask(task, idx) {
  const byId = new Set();
  const byName = new Set();
  const ambiguous = new Set();
  const unregistered = new Set();
  const rawNames = new Set();

  asArray(task?.sessions).forEach((s) => {
    if (!isObj(s)) return;
    const wid = str(s.workerId);
    if (wid && idx.byId.has(wid)) byId.add(wid);
    else if (trimmed(s.workerName)) rawNames.add(trimmed(s.workerName));
  });
  if (trimmed(task?.workerName)) rawNames.add(trimmed(task.workerName));

  rawNames.forEach((n) => {
    const r = resolveWorkerName(n, idx);
    if (r.status === 'resolved') byName.add(r.id);
    else if (r.status === 'ambiguous') ambiguous.add(n);
    else if (r.status === 'unregistered') unregistered.add(n);
  });

  // タスク1件を1つの区分にだけ入れる (合計が評価タスク数と必ず一致するように)
  let evidence = 'none';
  if (byId.size > 0) evidence = 'workerId';
  else if (byName.size > 0) evidence = 'name';
  else if (ambiguous.size > 0) evidence = 'ambiguousName';
  else if (unregistered.size > 0) evidence = 'unregisteredName';

  return {
    byId: [...byId],
    byName: [...byName].filter((id) => !byId.has(id)),
    ambiguousNames: [...ambiguous],
    unregisteredNames: [...unregistered],
    evidence,
  };
}

// -----------------------------------------------------------------------------
// 5. 工程の一覧 (テンプレ台帳 ∪ ロットに焼かれた工程)
// -----------------------------------------------------------------------------
// 「まだ誰もやっていない工程」を出すには、**台帳側**(templates[].steps)も見ないといけない。
// ロットに一度も流れていない工程は、ロットだけ見ていると存在ごと消える (実測: 台帳221 / ロット195)。
function buildProcessUniverse(lots, templates) {
  const procs = new Map();
  const ensure = (templateId, stepId) => {
    const key = processKeyOf(templateId, stepId);
    let p = procs.get(key);
    if (!p) {
      p = {
        key,
        templateId: str(templateId),
        templateName: null,
        templateMissing: true,
        stepId: str(stepId),
        stepTitle: '',
        titleHistory: [],
        masterOrder: null,
        definedInMaster: false,
        seenInLots: false,
        lotOnce: null,
        lotOnceConflict: false,
        _lotOnceTrue: 0,
        _lotOnceFalse: 0,
        _titleSeen: new Map(), // title -> {count, latestMs}
      };
      procs.set(key, p);
    }
    return p;
  };
  const noteTitle = (p, title, ms) => {
    const t = trimmed(title);
    if (!t) return;
    const cur = p._titleSeen.get(t) || { count: 0, latestMs: null };
    cur.count += 1;
    if (typeof ms === 'number' && isFinite(ms) && (cur.latestMs == null || ms > cur.latestMs)) cur.latestMs = ms;
    p._titleSeen.set(t, cur);
  };
  const noteLotOnce = (p, step) => {
    if (step?.lotOnce === true) p._lotOnceTrue += 1;
    else if (step?.lotOnce === false) p._lotOnceFalse += 1;
  };

  const tplById = new Map();
  asArray(templates).forEach((t) => {
    const id = docIdOf(t);
    if (id) tplById.set(id, t);
  });

  // 台帳 (いま定義されている工程)
  tplById.forEach((t, tid) => {
    asArray(t?.steps).forEach((s, i) => {
      const sid = str(s?.id);
      if (!sid) return;
      const p = ensure(tid, sid);
      p.definedInMaster = true;
      p.templateMissing = false;
      p.templateName = trimmed(t?.name) || null;
      if (p.masterOrder == null) p.masterOrder = i;
      noteTitle(p, s?.title, Number.POSITIVE_INFINITY); // 台帳の題名を「一番新しい」とみなす
      noteLotOnce(p, s);
    });
  });

  // ロットに焼かれた工程 (台帳から消えた工程もここに残る)
  asArray(lots).forEach((lot) => {
    const tid = str(lot?.templateId);
    const ms = lotTimeMs(lot);
    asArray(lot?.steps).forEach((s) => {
      const sid = str(s?.id);
      if (!sid) return;
      const p = ensure(tid, sid);
      p.seenInLots = true;
      if (tplById.has(tid)) {
        p.templateMissing = false;
        if (p.templateName == null) p.templateName = trimmed(tplById.get(tid)?.name) || null;
      }
      noteTitle(p, s?.title, ms);
      noteLotOnce(p, s);
    });
  });

  procs.forEach((p) => {
    // 表示名: 台帳の題名を最優先。無ければ一番新しいロットの題名。時刻が読めなければ最初に見た物。
    const entries = [...p._titleSeen.entries()];
    entries.sort((a, b) => {
      const am = a[1].latestMs == null ? -Infinity : a[1].latestMs;
      const bm = b[1].latestMs == null ? -Infinity : b[1].latestMs;
      if (am !== bm) return bm - am;
      return b[1].count - a[1].count;
    });
    p.stepTitle = entries.length ? entries[0][0] : '';
    p.titleHistory = entries.map(([title, v]) => ({ title, seenCount: v.count }));
    // step.lotOnce は「どこかに true が在れば true」。両方在れば隠さず印を付ける。
    if (p._lotOnceTrue > 0 && p._lotOnceFalse > 0) {
      p.lotOnce = true;
      p.lotOnceConflict = true;
    } else if (p._lotOnceTrue > 0) p.lotOnce = true;
    else if (p._lotOnceFalse > 0) p.lotOnce = false;
    else p.lotOnce = null; // ⚠ 工程名から推測しない
    delete p._titleSeen;
    delete p._lotOnceTrue;
    delete p._lotOnceFalse;
  });

  return { procs, tplById };
}

/** ロットの時刻(表示名を選ぶためだけに使う)。読めなければ null。 */
function lotTimeMs(lot) {
  const cands = [lot?.updatedAt, lot?.createdAt, lot?.entryAt, lot?.workStartTime];
  for (const c of cands) {
    if (isObj(c) && typeof c.seconds === 'number') return c.seconds * 1000;
    if (typeof c === 'number' && isFinite(c)) return c;
    if (typeof c === 'string') {
      const t = Date.parse(c);
      if (!isNaN(t)) return t;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// 6. 本体
// -----------------------------------------------------------------------------
/**
 * @param {{lots:Array, templates:Array, workers:Array}} input
 * @param {{acceptStatuses?:string[]}} [options]
 *   acceptStatuses … 「やった」と数えるタスクの status。既定 ['completed']。
 *                    skipped(飛ばした) と ng は既定で数えない。除外は隠さず数えて返す。
 */
export function computeSoloDependency(input, options = {}) {
  const lots = asArray(input?.lots);
  const templates = asArray(input?.templates);
  const idx = indexWorkers(input?.workers);
  const acceptStatuses = new Set(asArray(options.acceptStatuses).length ? options.acceptStatuses : ['completed']);

  const { procs } = buildProcessUniverse(lots, templates);

  // 集計器
  const agg = new Map(); // processKey -> 集計
  const ensureAgg = (key) => {
    let a = agg.get(key);
    if (!a) {
      a = {
        people: new Map(),           // workerId -> {taskCount, lotIds:Set, byIdTaskCount, byNameTaskCount}
        unregistered: new Map(),     // 生の名前 -> {taskCount, lotIds:Set}
        ambiguous: new Map(),        // 生の名前 -> {taskCount}
        tasksEvaluated: 0,
        byWorkerId: 0,
        byNameOnly: 0,
        ambiguousName: 0,
        unregisteredName: 0,
        unattributed: 0,
        unattributedLotOwner: new Map(), // 仮定の検算用: 名無しタスクが在るロットの担当者
        lotIds: new Set(),
        lotOnceKeyTasks: 0, // `-lot-連番` 形のタスク = 実施回数
        unitKeyTasks: 0,    // `-台番号` 形のタスク   = 台数
      };
      agg.set(key, a);
    }
    return a;
  };

  const totals = {
    lots: lots.length,
    lotsWithSteps: 0,
    tasksTotal: 0,
    tasksEvaluated: 0,
    excludedByStatus: {},
    processUnresolvedTasks: 0,
    byWorkerId: 0,
    byNameOnly: 0,
    ambiguousName: 0,
    unregisteredName: 0,
    unattributed: 0,
  };
  const unknownNameTotals = new Map();     // 自由入力の名前 -> {taskCount, processKeys:Set}
  const ambiguousNameTotals = new Map();   // 同姓同名 -> {taskCount}

  lots.forEach((lot) => {
    const lotId = docIdOf(lot) || null;
    const steps = asArray(lot?.steps);
    if (steps.length) totals.lotsWithSteps += 1;
    const tid = str(lot?.templateId);
    const lotOwnerId = str(lot?.workerId) && idx.byId.has(str(lot.workerId)) ? str(lot.workerId) : null;
    const tasks = isObj(lot?.tasks) ? lot.tasks : {};

    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!isObj(task)) return;
      totals.tasksTotal += 1;

      const st = str(task.status) || '(status無し)';
      if (!acceptStatuses.has(st)) {
        totals.excludedByStatus[st] = (totals.excludedByStatus[st] || 0) + 1;
        return;
      }

      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) {
        // 🚨 工程名の文字列で当てに行かない。分からない物は分からないと数える。
        totals.processUnresolvedTasks += 1;
        return;
      }

      const key = processKeyOf(tid, r.stepId);
      const a = ensureAgg(key);
      a.tasksEvaluated += 1;
      totals.tasksEvaluated += 1;
      if (lotId) a.lotIds.add(lotId);
      // 数え方の単位は、記録(タスクキーの形)から決める。step.lotOnce は false が書かれないので当てにしない。
      if (r.via === 'stepId-lot') a.lotOnceKeyTasks += 1; else a.unitKeyTasks += 1;

      const att = attributeTask(task, idx);
      const addPerson = (wid, viaId) => {
        let p = a.people.get(wid);
        if (!p) {
          p = { taskCount: 0, lotIds: new Set(), byIdTaskCount: 0, byNameTaskCount: 0 };
          a.people.set(wid, p);
        }
        p.taskCount += 1;
        if (lotId) p.lotIds.add(lotId);
        if (viaId) p.byIdTaskCount += 1;
        else p.byNameTaskCount += 1;
      };
      att.byId.forEach((wid) => addPerson(wid, true));
      att.byName.forEach((wid) => addPerson(wid, false));
      att.unregisteredNames.forEach((n) => {
        const u = a.unregistered.get(n) || { taskCount: 0, lotIds: new Set() };
        u.taskCount += 1;
        if (lotId) u.lotIds.add(lotId);
        a.unregistered.set(n, u);
        const g = unknownNameTotals.get(n) || { taskCount: 0, processKeys: new Set() };
        g.taskCount += 1;
        g.processKeys.add(key);
        unknownNameTotals.set(n, g);
      });
      att.ambiguousNames.forEach((n) => {
        const u = a.ambiguous.get(n) || { taskCount: 0 };
        u.taskCount += 1;
        a.ambiguous.set(n, u);
        const g = ambiguousNameTotals.get(n) || { taskCount: 0 };
        g.taskCount += 1;
        ambiguousNameTotals.set(n, g);
      });

      if (att.evidence === 'workerId') { a.byWorkerId += 1; totals.byWorkerId += 1; }
      else if (att.evidence === 'name') { a.byNameOnly += 1; totals.byNameOnly += 1; }
      else if (att.evidence === 'ambiguousName') { a.ambiguousName += 1; totals.ambiguousName += 1; }
      else if (att.evidence === 'unregisteredName') { a.unregisteredName += 1; totals.unregisteredName += 1; }
      else {
        a.unattributed += 1;
        totals.unattributed += 1;
        // 「もしロットの担当者だったら」を後で試算するためだけに控える (事実としては使わない)
        const k = lotOwnerId || '';
        a.unattributedLotOwner.set(k, (a.unattributedLotOwner.get(k) || 0) + 1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 工程ごとの行を組み立てる
  // ---------------------------------------------------------------------------
  const nameOf = (wid) => idx.byId.get(wid)?.name || '';
  const processes = [];
  procs.forEach((p, key) => {
    const a = agg.get(key) || null;
    const people = a
      ? [...a.people.entries()]
        .map(([wid, v]) => ({
          workerId: wid,
          workerName: nameOf(wid),
          taskCount: v.taskCount,
          lotCount: v.lotIds.size,
          byWorkerIdTaskCount: v.byIdTaskCount,
          byNameOnlyTaskCount: v.byNameTaskCount,
          // 一番強い証拠。IDで1件でも証明できていれば 'workerId'。
          evidence: v.byIdTaskCount > 0 ? 'workerId' : 'name',
        }))
        .sort((x, y) => (y.taskCount - x.taskCount) || x.workerName.localeCompare(y.workerName) || x.workerId.localeCompare(y.workerId))
      : [];

    const unregisteredNames = a
      ? [...a.unregistered.entries()]
        .map(([name, v]) => ({ name, taskCount: v.taskCount, lotCount: v.lotIds.size }))
        .sort((x, y) => (y.taskCount - x.taskCount) || x.name.localeCompare(y.name))
      : [];
    const ambiguousNames = a
      ? [...a.ambiguous.entries()]
        .map(([name, v]) => ({ name, taskCount: v.taskCount }))
        .sort((x, y) => (y.taskCount - x.taskCount) || x.name.localeCompare(y.name))
      : [];

    const counts = {
      tasksEvaluated: a ? a.tasksEvaluated : 0,
      lotCount: a ? a.lotIds.size : 0,
      byWorkerId: a ? a.byWorkerId : 0,
      byNameOnly: a ? a.byNameOnly : 0,
      ambiguousName: a ? a.ambiguousName : 0,
      unregisteredName: a ? a.unregisteredName : 0,
      unattributed: a ? a.unattributed : 0,
    };

    const doneByCount = people.length;
    const unknownRecords = counts.unattributed + counts.ambiguousName + counts.unregisteredName;

    let bucket;
    if (doneByCount >= 2) bucket = BUCKET.TWO_OR_MORE;
    else if (doneByCount === 1) bucket = BUCKET.ONE_PERSON_ONLY;
    else if (unknownRecords > 0) bucket = BUCKET.UNCLEAR; // 🚨 0人に混ぜない
    else bucket = BUCKET.NOBODY_YET;

    // 🚨 人数は少なく出る。名無し・同姓同名・自由入力が在れば必ず印を付ける。
    const mayBeMorePeople = unknownRecords > 0;

    // 数え方の単位: まず記録(タスクキーの形)。記録が無い時だけ step.lotOnce を見る。
    const lotOnceKeyTasks = a ? a.lotOnceKeyTasks : 0;
    const unitKeyTasks = a ? a.unitKeyTasks : 0;
    let countUnit;
    if (lotOnceKeyTasks > 0 && unitKeyTasks > 0) countUnit = COUNT_UNIT.MIXED;
    else if (lotOnceKeyTasks > 0) countUnit = COUNT_UNIT.EXECUTIONS;
    else if (unitKeyTasks > 0) countUnit = COUNT_UNIT.UNITS;
    else if (p.lotOnce === true) countUnit = COUNT_UNIT.EXECUTIONS;
    else if (p.lotOnce === false) countUnit = COUNT_UNIT.UNITS;
    else countUnit = COUNT_UNIT.UNKNOWN;

    let note;
    if (bucket === BUCKET.NOBODY_YET) note = nobodyYetSentence();
    else if (bucket === BUCKET.UNCLEAR) note = `誰かがやったが、誰がやったか分からない（判別できない記録 ${unknownRecords}件）`;
    else if (bucket === BUCKET.ONE_PERSON_ONLY) note = soloDoerSentence(people[0].workerName);
    else note = `実際にやった事があるのは${doneByCount}人`;
    if (bucket !== BUCKET.NOBODY_YET && mayBeMorePeople) {
      note += `（ただし誰がやったか分からない記録が${unknownRecords}件。実際はもっと多い可能性がある）`;
    }

    processes.push({
      key,
      templateId: p.templateId,
      templateName: p.templateName,
      templateMissing: p.templateMissing,
      stepId: p.stepId,
      stepTitle: p.stepTitle,
      masterOrder: p.masterOrder,
      titleHistory: p.titleHistory,
      // 題名が途中で変わった工程。タイトルで束ねると割れる = step.id で束ねた理由の証拠
      titleRenamed: p.titleHistory.length > 1,
      definedInMaster: p.definedInMaster,
      seenInLots: p.seenInLots,
      lotOnce: p.lotOnce,
      lotOnceConflict: p.lotOnceConflict,
      countUnit,
      countUnitLabel: COUNT_UNIT_LABEL[countUnit],
      // 🚨 MIXED の時はこの2つを別々に見せる。足さない。
      executionTaskCount: lotOnceKeyTasks,
      unitTaskCount: unitKeyTasks,
      people,
      doneByCount,
      bucket,
      bucketLabel: BUCKET_LABEL[bucket],
      unregisteredNames,
      ambiguousNames,
      counts,
      mayBeMorePeople,
      note,
    });
  });

  processes.sort((a, b) => (
    a.templateId.localeCompare(b.templateId)
    || ((a.masterOrder ?? 1e9) - (b.masterOrder ?? 1e9))
    || a.stepId.localeCompare(b.stepId)
  ));

  const byKey = new Map(processes.map((p) => [p.key, p]));

  // ---------------------------------------------------------------------------
  // 3つに分ける (+ 分からない)
  // ---------------------------------------------------------------------------
  const buckets = {
    nobodyYet: processes.filter((p) => p.bucket === BUCKET.NOBODY_YET).map((p) => p.key),
    onePersonOnly: processes.filter((p) => p.bucket === BUCKET.ONE_PERSON_ONLY).map((p) => p.key),
    twoOrMore: processes.filter((p) => p.bucket === BUCKET.TWO_OR_MORE).map((p) => p.key),
    unclear: processes.filter((p) => p.bucket === BUCKET.UNCLEAR).map((p) => p.key),
  };
  const bucketCounts = {
    nobodyYet: buckets.nobodyYet.length,
    onePersonOnly: buckets.onePersonOnly.length,
    twoOrMore: buckets.twoOrMore.length,
    unclear: buckets.unclear.length,
    total: processes.length,
  };

  // ---------------------------------------------------------------------------
  // 人ごと / その人を外した時
  // ---------------------------------------------------------------------------
  const byWorker = idx.list.map((w) => {
    const did = processes.filter((p) => p.people.some((x) => x.workerId === w.id));
    const solo = did.filter((p) => p.doneByCount === 1);
    return {
      workerId: w.id,
      workerName: w.name,
      processCount: did.length,
      processKeys: did.map((p) => p.key),
      soloProcessKeys: solo.map((p) => p.key),
      soloProcessCount: solo.length,
      taskCount: did.reduce((s, p) => s + (p.people.find((x) => x.workerId === w.id)?.taskCount || 0), 0),
    };
  }).sort((a, b) => (b.soloProcessCount - a.soloProcessCount) || (b.processCount - a.processCount) || a.workerName.localeCompare(b.workerName));

  // 🚨 「欠員時に止まる仕事」ではなく「**その人を外すと、実際にやった事のある人が居なくなる工程**」。
  //    やった事が無い＝できない ではないので、止まると断定はしない。
  const ifAbsent = byWorker.map((w) => {
    const becomesNobodyYet = [];
    const becomesUnclear = [];
    w.soloProcessKeys.forEach((k) => {
      const p = byKey.get(k);
      if (!p) return;
      const unknownRecords = p.counts.unattributed + p.counts.ambiguousName + p.counts.unregisteredName;
      if (unknownRecords > 0) becomesUnclear.push(k);
      else becomesNobodyYet.push(k);
    });
    return {
      workerId: w.workerId,
      workerName: w.workerName,
      becomesNobodyYet,
      becomesUnclear,
      processCount: becomesNobodyYet.length + becomesUnclear.length,
      sentence: `${w.workerName}さんを外すと、実際にやった事のある人が居なくなる工程は ${becomesNobodyYet.length + becomesUnclear.length}件（できる人が居ないという意味ではない）`,
    };
  }).sort((a, b) => (b.processCount - a.processCount) || a.workerName.localeCompare(b.workerName));

  // ---------------------------------------------------------------------------
  // 確かさ (🚨必ず一緒に返す)
  // ---------------------------------------------------------------------------
  const denom = totals.tasksEvaluated || 0;
  const ratio = (n) => (denom > 0 ? Math.round((n / denom) * 1000) / 1000 : null);
  const confidence = {
    // 数え方: タスク1件はこの5区分のちょうど1つに入る (合計 === tasksEvaluated)
    tasksTotal: totals.tasksTotal,
    tasksEvaluated: totals.tasksEvaluated,
    provenByWorkerId: totals.byWorkerId,          // IDで証明できた件数
    byNameOnly: totals.byNameOnly,                // 名前だけの件数 (同姓同名が出たら崩れる)
    ambiguousNameTasks: totals.ambiguousName,     // 同姓同名で決められない件数
    unregisteredNameTasks: totals.unregisteredName, // 登録に無い自由入力の名前の件数
    unattributedTasks: totals.unattributed,       // 🚨 誰がやったか分からない件数
    provenByWorkerIdRatio: ratio(totals.byWorkerId),
    byNameOnlyRatio: ratio(totals.byNameOnly),
    unattributedRatio: ratio(totals.unattributed),
    excludedByStatus: totals.excludedByStatus,    // skipped / ng など (数えていない物)
    processUnresolvedTasks: totals.processUnresolvedTasks, // 工程が決められなかったタスク
    workersRegistered: idx.list.length,
    duplicateWorkerNames: [...idx.ambiguousNames],
    unknownDoers: [...unknownNameTotals.entries()]
      .map(([name, v]) => ({ name, taskCount: v.taskCount, processCount: v.processKeys.size }))
      .sort((a, b) => (b.taskCount - a.taskCount) || a.name.localeCompare(b.name)),
    duplicateNameDoers: [...ambiguousNameTotals.entries()]
      .map(([name, v]) => ({ name, taskCount: v.taskCount }))
      .sort((a, b) => (b.taskCount - a.taskCount) || a.name.localeCompare(b.name)),
    // 合計が合うかの自己検算 (ここが false なら数え方が壊れている)
    sumMatchesEvaluated:
      totals.byWorkerId + totals.byNameOnly + totals.ambiguousName + totals.unregisteredName + totals.unattributed
      === totals.tasksEvaluated,
  };

  // ---------------------------------------------------------------------------
  // 名無しが結論をどう変えうるか (🚨仮定。事実として出さない)
  // ---------------------------------------------------------------------------
  const processesWithUnattributed = processes.filter((p) => p.counts.unattributed > 0).length;
  let hypoOnePersonToTwoOrMore = 0;
  let hypoUnclearToIdentified = 0;
  let hypoApplicableTasks = 0;
  let hypoNotApplicableTasks = 0;
  processes.forEach((p) => {
    const a = agg.get(p.key);
    if (!a || a.unattributed === 0) return;
    const owners = new Set();
    a.unattributedLotOwner.forEach((n, wid) => {
      if (wid) { owners.add(wid); hypoApplicableTasks += n; } else hypoNotApplicableTasks += n;
    });
    if (owners.size === 0) return;
    const known = new Set(p.people.map((x) => x.workerId));
    const added = [...owners].filter((w) => !known.has(w));
    if (p.bucket === BUCKET.ONE_PERSON_ONLY && added.length > 0) hypoOnePersonToTwoOrMore += 1;
    if (p.bucket === BUCKET.UNCLEAR && owners.size > 0) hypoUnclearToIdentified += 1;
  });

  const sensitivity = {
    unattributedTasks: totals.unattributed,
    processesWithUnattributed,
    direction: '🚨 名前が無い記録は数えられないので、「やった事がある人数」は**必ず少なく出る**。'
      + '「1人だけ」と出た工程が、本当は2人以上である可能性は消えない。',
    hypothesis: {
      method: 'lot.workerId（ロットの担当者）を、そのロットの名無しタスクに仮に当てはめる',
      applicableTasks: hypoApplicableTasks,
      notApplicableTasks: hypoNotApplicableTasks,
      onePersonOnlyCouldBecomeTwoOrMore: hypoOnePersonToTwoOrMore,
      unclearCouldBecomeIdentified: hypoUnclearToIdentified,
      warning: '🚨 これは仮定であって記録ではない。lot.workerId は「ロットの担当」で、'
        + '「その工程をやった人」の記録ではない。この数字を事実として画面に出さない事。',
    },
  };

  // ---------------------------------------------------------------------------
  // 測れなかった事 (飛ばして読ませない)
  // ---------------------------------------------------------------------------
  const limitations = [
    '🚨 これは力量認定ではない。「やった記録が在るか」を数えただけ。配置・人事評価に使えない。',
    '🚨「実際にやった事があるのは1人だけ」は「その人しかできない」ではない。',
    '🚨「まだ誰もやっていない」は「できない」ではない。記録が0件という意味しかない。',
    'スキル設定 (template.requiredSkills / settings.workerSkills) は1件も使っていない。実測で0件だったため。',
    `工程の身元は templateId + step.id。step.category は使えない（実データに0件）。`
      + `工程名だけでも束ねられない（同じ題名が複数テンプレに出る）。`,
  ];
  if (totals.unattributed > 0) {
    limitations.push(
      `誰がやったか分からないタスクが ${totals.unattributed}件`
      + (denom ? `（数えた ${denom}件の ${(100 * totals.unattributed / denom).toFixed(1)}%）` : '')
      + '。捨てずに数えているが、この分だけ「やった事がある人数」は少なく出る。',
    );
  }
  if (totals.unregisteredName > 0) {
    const names = confidence.unknownDoers.map((u) => `${u.name}(${u.taskCount}件)`).join('・');
    limitations.push(`登録作業者に無い自由入力の名前が ${confidence.unknownDoers.length}種 ${totals.unregisteredName}件: ${names}。🚨誰にも寄せていない（unknown として別に数えた）。`);
  }
  if (idx.ambiguousNames.size > 0) {
    limitations.push(`同姓同名の登録が ${idx.ambiguousNames.size}件ある。名前だけの記録はどちらか決められないので unknown にした。`);
  }
  if (totals.processUnresolvedTasks > 0) {
    limitations.push(`どの工程か決められなかったタスクが ${totals.processUnresolvedTasks}件。工程名の文字列で当てに行っていない。`);
  }
  const unitUnknown = processes.filter((p) => p.countUnit === COUNT_UNIT.UNKNOWN).length;
  if (unitUnknown > 0) {
    limitations.push(`数え方が「台」か「回」か決められない工程が ${unitUnknown}件（記録が0件で、step.lotOnce も書かれていない）。工程名から推測していない。`);
  }
  const unitMixed = processes.filter((p) => p.countUnit === COUNT_UNIT.MIXED);
  if (unitMixed.length > 0) {
    limitations.push(
      `🚨 同じ工程に「台ごとの記録」と「ロット1回の記録」が混ざっている工程が ${unitMixed.length}件`
      + '（途中で step.lotOnce を変えた跡）。**この工程の件数を1つの数に足さない事**。'
      + 'executionTaskCount(回) と unitTaskCount(台) を別々に見る。',
    );
  }
  const lotOnceConflicts = processes.filter((p) => p.lotOnceConflict).length;
  if (lotOnceConflicts > 0) {
    limitations.push(`step.lotOnce が true と false の両方で記録されている工程が ${lotOnceConflicts}件（途中で設定が変わった疑い）。true として数えた上で印を付けた。`);
  }
  const renamed = processes.filter((p) => p.titleRenamed).length;
  if (renamed > 0) {
    limitations.push(`途中で題名が変わった工程が ${renamed}件。step.id で束ねているので1つの工程として繋がっている（題名で束ねると別工程に割れる）。`);
  }
  if (!confidence.sumMatchesEvaluated) {
    limitations.push('🚨 内訳の合計が評価タスク数と一致しない。数え方が壊れている。この結果を使ってはいけない。');
  }

  return {
    processKeyBasis: 'templateId + step.id',
    processKeyReason:
      'step.category は実データに0件で使えない。工程名は65種のうち28種が複数テンプレに重複するので単独では使えない。'
      + 'step.id はテンプレ内でロットをまたいで安定していた（テンプレ×題名198組のうち id が割れた組は0）。'
      + 'さらに step.id は題名の改名を跨いで同じ工程を束ねる（実測3件）。',
    processes,
    byKey,
    buckets,
    bucketCounts,
    byWorker,
    ifAbsent,
    confidence,
    sensitivity,
    limitations,
  };
}

/**
 * 画面や報告にそのまま出せる短い文。🚨言い換えを1箇所に閉じ込めるためのもの。
 * ここを通さずに「その人しかできない」と書かない事。
 */
export function summarySentences(result) {
  const b = result?.bucketCounts || {};
  const c = result?.confidence || {};
  const out = [
    `工程 ${b.total ?? 0}件のうち、実際にやった事がある人が 2人以上 ${b.twoOrMore ?? 0}件 / 1人だけ ${b.onePersonOnly ?? 0}件 / まだ誰もやっていない ${b.nobodyYet ?? 0}件 / 誰がやったか分からない ${b.unclear ?? 0}件`,
    `確かさ: IDで証明できた ${c.provenByWorkerId ?? 0}件 / 名前だけ ${c.byNameOnly ?? 0}件 / 誰がやったか分からない ${c.unattributedTasks ?? 0}件（数えたタスク ${c.tasksEvaluated ?? 0}件）`,
  ];
  if ((c.unattributedTasks ?? 0) > 0) {
    out.push('🚨 誰がやったか分からない記録がある分、「やった事がある人数」は少なく出ている。');
  }
  return out;
}
