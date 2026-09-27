// =============================================================================
// ⭐ 星取表 (starChart) — 「工程 × 人」を、作業記録と「教えられる」の印だけから毎回導出する純関数
// -----------------------------------------------------------------------------
// なぜ作るか:
//   教育の計画(次に誰へ何を教えるか)の材料として、工程ごとに
//   「やった事がある人は誰か」「教えられる人は誰か」を1枚で見えるようにする。
//   🚨 力量の認定でも人事評価でもない。評価・査定・配置の自動化に使わない。
//
// 語彙は4つだけ (これ以外の段階・呼び名・順位を作らない):
//   ・無印           … やった記録が1件も無い。「まだ分かりません」であり、教育の候補という意味。
//   ・🎓教育中       … その人のその工程の記録が全部 task.trainee === true
//   ・一人でできる   … 完了/ng の記録が1件でも在る。実績1件=できる。件数で足切りしない
//                       (特注に「サンプル数が少ない」を持ち込まない。2026-08-20 の約束)
//   ・教えられる     … 管理者の指名(人の判断)。skill_marks の印。自動では付けない
//   期限失効なし・割当ロックなし・順位なし。
//
// 0秒の記録の扱い (traineeProgress と逆なのは意図):
//   ・traineeProgress は「速さの証拠」を測るので 0秒を捨てる。
//   ・ここは「経験の証拠」を数えるので 0秒でも数える (実績1件=できる)。
//   ・ただし samplingSkipped(抜取スキップ) は実作業をしていないので数えない。
//
// 保存の形 (skill_marks = 追記型コレクション):
//   ・印は buildTeachMarkDoc で組んだ doc を1件ずつ**追記**する。上書きしない。
//   ・取消(retract)も追記で表す。taught(いま教えられるか)は at 昇順の最後の doc で決まるが、
//     **履歴は消えない** (deriveTeachMarks が history として全部返す)。
//   ・単一フィールドの上書きや配列の丸ごと保存は、多端末の後勝ちで人の判断が消える
//     (multi-device-shared-decision 2026-07-17 の実害)。追記型なら構造上その事故が起きない。
//   ・判定(can/trainee)は保存しない。毎回この純関数で導出する (traineeProgress と同じ流儀)。
//
// 疑似名と運用名:
//   ・PSEUDO_WORKER_NAMES は実コード・実データに実在する固定文字列の列挙 (新しい決めではない)。
//     人ではないので行にしない。ただし捨てず、件数を別掲する (黙って消さない)。
//   ・「フリー」「管理者」が人かどうかは運用判断。勝手に決めず OPERATIONAL_NAMES として別掲する。
//
// 人の同定は soloDependency の流儀そのまま (二重実装しない。import で使う):
//   ・trim した名前が鍵
//   ・同姓同名はどちらかへ寄せない (ambiguousNames に印だけ付ける)
//   ・登録に無い自由入力の名前も行にする (isRegistered:false)
//   ・無名の記録は捨てずに unattributedCount で数える
//
// 純度: 中で Date.now / new Date / Math.random を呼ばない。同じ入力 → 同じ出力。
//   id の採番や鮮度の計算に要る「今」は、呼び出し側(画面)が nowMs / rand として渡す。
// =============================================================================

import {
  attributeTask,
  computeSoloDependency,
  docIdOf,
  indexWorkers,
  parseProcessKey,
  processKeyOf,
  resolveTaskProcess,
} from './soloDependency.js';

// 画面(StarChartView)が同じ流儀・同じ言い方を使えるように、土台の道具をここから通しで渡す。
export {
  processKeyOf,
  parseProcessKey,
  indexWorkers,
  resolveWorkerName,
  resolveTaskProcess,
  attributeTask,
  soloDoerSentence,
  nobodyYetSentence,
} from './soloDependency.js';

// -----------------------------------------------------------------------------
// 0. 固定の名簿 (実在する文字列の列挙。ここで新しい決めはしない)
// -----------------------------------------------------------------------------
/**
 * 実コードに実在する疑似名。人ではないので行にしない (件数は別掲する)。
 * ⚠「システム(外観図・該当なし自動)」だけは最終検査(golden)側の生成値
 *   (golden App.firebase.jsx の外観図・該当なし自動スキップ)。この製品側では生成されないが、
 *   将来のアプリ横断の星取表で同じ判定を使うため、ここに置いておく (フィルタとして無害)。
 */
export const PSEUDO_WORKER_NAMES = Object.freeze([
  '規格(該当なし)',
  'システム(外観図・該当なし自動)',
  'AI',
  '不明',
  '-',
  '?',
]);

/** 人かどうかが運用判断の名前。勝手に決めず、行にせず別掲する。 */
export const OPERATIONAL_NAMES = Object.freeze(['フリー', '管理者']);

// -----------------------------------------------------------------------------
// 1. 小道具
// -----------------------------------------------------------------------------
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// 文字列の並べ替え。端末のICUの版で並びが変わる比較APIは使わない
// (同じ入力で環境ごとに結果が割れる。operationsSimulation/education.js と同じ流儀)。
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Firestore Timestamp / 数値 / 日付文字列 をミリ秒へ。⚠ 中で時計を読まない
// (Date.parse は渡された文字列の解釈だけで、今の時刻には触れない)。
const defaultToMs = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (isObj(raw) && typeof raw.seconds === 'number') {
    return raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

// -----------------------------------------------------------------------------
// 2. 「教えられる」の印 (skill_marks の doc)
// -----------------------------------------------------------------------------
const MARK_KINDS = Object.freeze(['teach', 'retract']);

/** 印の doc id。純関数 (今の時刻・乱数は呼び出し側が渡す)。 */
export const teachMarkId = ({ nowMs, rand }) => `sm-${nowMs}-${rand}`;

/**
 * 追記する印の doc を組む。検証して不正は throw (壊れた doc を保存させない)。
 * at / rand は画面側で Date.now / Math.random を使ってよい (この関数は受け取るだけ)。
 * @returns {{id:string, kind:'teach'|'retract', worker:string, processKey:string, by:string, at:number, note:string}}
 */
export function buildTeachMarkDoc({ kind, worker, processKey, by, nowMs, rand, note = '' } = {}) {
  if (!MARK_KINDS.includes(kind)) {
    throw new Error(`buildTeachMarkDoc: kind は 'teach' か 'retract' (受け取った値: ${JSON.stringify(kind)})`);
  }
  const w = trimmed(worker);
  if (!w) throw new Error('buildTeachMarkDoc: worker(名前) が空');
  if (typeof processKey !== 'string' || !processKey) throw new Error('buildTeachMarkDoc: processKey が空');
  // 鍵は必ず processKeyOf の形 (往復して同じ文字列に戻る事で確かめる)。
  // 形の崩れた鍵を保存すると、その印はどの列とも一生一致しない。
  const parsed = parseProcessKey(processKey);
  if (!parsed.stepId || processKeyOf(parsed.templateId, parsed.stepId) !== processKey) {
    throw new Error(`buildTeachMarkDoc: processKey が processKeyOf の形ではない: ${JSON.stringify(processKey)}`);
  }
  const b = trimmed(by);
  if (!b) throw new Error('buildTeachMarkDoc: by(指名した人) が空');
  if (!Number.isFinite(nowMs)) throw new Error('buildTeachMarkDoc: nowMs が数値ではない');
  const randOk = (typeof rand === 'number' && Number.isFinite(rand)) || (typeof rand === 'string' && rand !== '');
  if (!randOk) throw new Error('buildTeachMarkDoc: rand が無い (数値か空でない文字列を渡す)');
  if (typeof note !== 'string') throw new Error('buildTeachMarkDoc: note は文字列で渡す');
  return { id: teachMarkId({ nowMs, rand }), kind, worker: w, processKey, by: b, at: nowMs, note };
}

/**
 * 追記された印の山から「いま教えられるか」を畳む。
 * 同じ鍵 (worker名||processKey) は at 昇順に畳み、最後の doc が勝つ。
 * retract は taught:false にするが **履歴 (history) は消さない** (印は履歴ごと残す)。
 * 読めない doc は黙って捨てず badDocs に数える。
 * @param {Array} markDocs
 * @returns {{byKey: Map<string, {taught:boolean, by:string, atMs:number, history:Array<{kind:string,by:string,atMs:number,note:string}>}>, badDocs:number}}
 */
export function deriveTeachMarks(markDocs) {
  const groups = new Map(); // 'worker名||processKey' → [{kind,by,atMs,note}]
  let badDocs = 0;
  // ⚠ asArray は null を先に落としてしまい badDocs に入らない。読めない物も数えるので生のまま回す。
  (Array.isArray(markDocs) ? markDocs : []).forEach((d) => {
    if (!isObj(d)) { badDocs += 1; return; }
    const worker = trimmed(d.worker);
    const processKey = typeof d.processKey === 'string' ? d.processKey : '';
    const by = trimmed(d.by);
    if (!MARK_KINDS.includes(d.kind) || !worker || !processKey || !by || !Number.isFinite(d.at)) {
      badDocs += 1;
      return;
    }
    const key = `${worker}||${processKey}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push({ kind: d.kind, by, atMs: d.at, note: typeof d.note === 'string' ? d.note : '' });
  });
  const byKey = new Map();
  groups.forEach((g, key) => {
    g.sort((a, b) => a.atMs - b.atMs); // 同時刻は追記順のまま (sort は安定)
    const last = g[g.length - 1];
    byKey.set(key, { taught: last.kind === 'teach', by: last.by, atMs: last.atMs, history: g });
  });
  return { byKey, badDocs };
}

// -----------------------------------------------------------------------------
// 3. 星取表の本体
// -----------------------------------------------------------------------------
/**
 * @param {{lots?:Array, workers?:Array, templates?:Array, markDocs?:Array, toMs?:Function|null}} input
 *   toMs … 時刻をミリ秒へ直す関数 (App.jsx の toMsAny を渡してよい)。無ければ内蔵の変換を使う。
 * @returns {{
 *   rows: Array<{name:string, isTrainee:boolean, isRegistered:boolean, cells:Map, canCount:number, teachCount:number}>,
 *   columns: Array<{processKey:string, templateId:string, stepId:string, templateName:string|null, stepTitle:string, headcount:number, soloName:string|null, nobodyYet:boolean}>,
 *   unattributedCount:number,
 *   pseudoNames: Array<{name:string, count:number}>,
 *   operationalNames: Array<{name:string, count:number}>,
 *   ambiguousNames: string[],
 * }}
 *   cell = { state:'can'|'trainee'|'teach', n, lastMs, lotIds(最大3件・新しい順), evidence:'id'|'name'|null, teach:{by,atMs}|null }
 *   ⚠ evidence は記録が1件も無い印だけのセルでは null (無い証拠をでっち上げない)。
 */
export function buildStarChart({ lots = [], workers = [], templates = [], markDocs = [], toMs = null } = {}) {
  const ms = typeof toMs === 'function' ? toMs : defaultToMs;
  const idx = indexWorkers(workers);
  const pseudoSet = new Set(PSEUDO_WORKER_NAMES);
  const operationalSet = new Set(OPERATIONAL_NAMES);

  // 工程の全体像 (台帳 ∪ ロットに焼かれた工程) は soloDependency に既にある。二重実装しない。
  // ここからは工程の身元 (key / テンプレ名 / 題名) だけを借り、人数はこの関数の数え方で出す
  // (soloDependency の人数は数える status の既定が違うので、混ぜると行と列が食い違う)。
  const solo = computeSoloDependency({ lots, templates, workers });

  const rowAgg = new Map(); // name → Map(processKey → {n, traineeN, viaId, lastMs, lots:Map(lotId→ms)})
  const ensureCellAgg = (name, key) => {
    let cells = rowAgg.get(name);
    if (!cells) { cells = new Map(); rowAgg.set(name, cells); }
    let c = cells.get(key);
    if (!c) { c = { n: 0, traineeN: 0, viaId: false, lastMs: null, lots: new Map() }; cells.set(key, c); }
    return c;
  };
  const pseudoCounts = new Map();
  const operationalCounts = new Map();
  const recordsByKey = new Map(); // processKey → 置けた記録の件数 (nobodyYet の判定用)
  let unattributedCount = 0;

  const nameOfId = (wid) => trimmed(idx.byId.get(wid)?.name);

  asArray(lots).forEach((lot) => {
    const lotId = docIdOf(lot) || null;
    const steps = asArray(lot?.steps);
    const tid = lot?.templateId == null ? '' : String(lot.templateId);
    const tasks = isObj(lot?.tasks) ? lot.tasks : {};

    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!isObj(task)) return;
      // 「やった記録」= 完了/ng。1件でもあれば経験 (件数で足切りしない)。
      if (task.status !== 'completed' && task.status !== 'ng') return;
      // 抜取スキップは実作業をしていないので経験に数えない。0秒 (duration>0 でない) は数える。
      if (task.samplingSkipped) return;

      const att = attributeTask(task, idx);

      // この記録の「やった人」の名前 (行の候補)。ID→登録名 / 名前→登録名 / 未登録・同姓同名→生の名前。
      const names = new Map(); // name → {viaId:boolean}
      att.byId.forEach((wid) => { const n = nameOfId(wid); if (n) names.set(n, { viaId: true }); });
      att.byName.forEach((wid) => { const n = nameOfId(wid); if (n && !names.has(n)) names.set(n, { viaId: false }); });
      att.ambiguousNames.forEach((n) => { if (!names.has(n)) names.set(n, { viaId: false }); });
      att.unregisteredNames.forEach((n) => { if (!names.has(n)) names.set(n, { viaId: false }); });

      // 誰がやったか分からない記録。捨てずに数える (この分だけ星は少なく出る)。
      if (names.size === 0) unattributedCount += 1;

      // 疑似名・運用名は行にしない。別掲で数える (工程が決まらなくても数える)。
      const realNames = [];
      names.forEach((v, n) => {
        if (pseudoSet.has(n)) pseudoCounts.set(n, (pseudoCounts.get(n) || 0) + 1);
        else if (operationalSet.has(n)) operationalCounts.set(n, (operationalCounts.get(n) || 0) + 1);
        else realNames.push([n, v]);
      });

      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) return; // どの工程か決められない記録はセルに置けない (名前の集計には入れた)
      const key = processKeyOf(tid, r.stepId);
      recordsByKey.set(key, (recordsByKey.get(key) || 0) + 1);

      const endMs = ms(task.endTime) ?? ms(task.startTime) ?? ms(task.firstStartTime);
      realNames.forEach(([n, v]) => {
        const c = ensureCellAgg(n, key);
        c.n += 1;
        if (task.trainee === true) c.traineeN += 1;
        if (v.viaId) c.viaId = true;
        if (endMs != null && (c.lastMs == null || endMs > c.lastMs)) c.lastMs = endMs;
        if (lotId) {
          const had = c.lots.has(lotId);
          const prev = c.lots.get(lotId);
          if (!had) c.lots.set(lotId, endMs);
          else if (endMs != null && (prev == null || endMs > prev)) c.lots.set(lotId, endMs);
        }
      });
    });
  });

  // 「教えられる」の印。byKey の鍵文字列は割り戻さない (区切り文字の割り方事故を避けるため、
  // doc から (worker, processKey) の組を集めて引く)。
  const derived = deriveTeachMarks(markDocs);
  const taughtCells = new Map(); // name → Map(processKey → {by, atMs})
  asArray(markDocs).forEach((d) => {
    if (!isObj(d)) return;
    const w = trimmed(d.worker);
    const pk = typeof d.processKey === 'string' ? d.processKey : '';
    if (!w || !pk) return;
    const st = derived.byKey.get(`${w}||${pk}`);
    if (!st || !st.taught) return;
    // 行にしない名前 (疑似名・運用名) には印を出す場所が無い。画面側の判断に委ねる。
    if (pseudoSet.has(w) || operationalSet.has(w)) return;
    let m = taughtCells.get(w);
    if (!m) { m = new Map(); taughtCells.set(w, m); }
    m.set(pk, { by: st.by, atMs: st.atMs });
  });

  // 行になる名前 = 登録作業者 (記録が無くても行に出す = やった記録が無い人も見える)
  //             ∪ 記録に出た名前 (未登録も行にする) ∪ 印の付いた名前 (can が無くても teach は出す)
  const rowNames = new Set();
  idx.list.forEach((w) => {
    if (w.name && !pseudoSet.has(w.name) && !operationalSet.has(w.name)) rowNames.add(w.name);
  });
  rowAgg.forEach((_cells, n) => rowNames.add(n));
  taughtCells.forEach((_m, n) => rowNames.add(n));

  // 🎓の身元。同じ名前の登録が複数あるときは、全員 trainee のときだけ true (勝手にどちらかへ寄せない)。
  const traineeByName = new Map();
  asArray(workers).forEach((w) => {
    const n = trimmed(w?.name);
    if (!n) return;
    const t = w?.trainee === true;
    traineeByName.set(n, traineeByName.has(n) ? (traineeByName.get(n) && t) : t);
  });

  const rows = [...rowNames].sort(cmpStr).map((name) => {
    const cells = new Map();
    const agg = rowAgg.get(name);
    if (agg) {
      agg.forEach((c, key) => {
        // 記録が全部 task.trainee===true → 🎓教育中。1件でも普通の記録が混ざれば「一人でできる」。
        const state = (c.n > 0 && c.traineeN === c.n) ? 'trainee' : 'can';
        const lotIds = [...c.lots.entries()]
          .sort((a, b) => (((b[1] ?? -Infinity) - (a[1] ?? -Infinity)) || cmpStr(a[0], b[0])))
          .slice(0, 3)
          .map(([id]) => id);
        cells.set(key, { state, n: c.n, lastMs: c.lastMs, lotIds, evidence: c.viaId ? 'id' : 'name', teach: null });
      });
    }
    const tm = taughtCells.get(name);
    if (tm) {
      tm.forEach((info, key) => {
        const cur = cells.get(key);
        if (cur) {
          cur.state = 'teach'; // 印は最優先
          cur.teach = { by: info.by, atMs: info.atMs };
        } else {
          // 記録が無くても印は出す。evidence は無い (無い証拠をでっち上げない)。
          cells.set(key, { state: 'teach', n: 0, lastMs: null, lotIds: [], evidence: null, teach: { by: info.by, atMs: info.atMs } });
        }
      });
    }
    let canCount = 0;
    let teachCount = 0;
    cells.forEach((c) => {
      if (c.state === 'can') canCount += 1;
      else if (c.state === 'teach') teachCount += 1;
    });
    return {
      name,
      isTrainee: traineeByName.get(name) === true,
      isRegistered: idx.nameToIds.has(name),
      cells,
      canCount,
      teachCount,
    };
  });

  // 列ごとの「やった事がある人数」。行になった名前だけ (疑似名・運用名・無名は人数に入れない)。
  // 印だけのセル (記録0件) も人数に入れない (やった記録ではないため)。
  const peopleByKey = new Map();
  rows.forEach((row) => {
    row.cells.forEach((c, key) => {
      if (!(c.n > 0)) return;
      let s = peopleByKey.get(key);
      if (!s) { s = new Set(); peopleByKey.set(key, s); }
      s.add(row.name);
    });
  });

  const columnsMap = new Map();
  solo.processes.forEach((p) => {
    columnsMap.set(p.key, {
      processKey: p.key,
      templateId: p.templateId,
      stepId: p.stepId,
      templateName: p.templateName,
      stepTitle: p.stepTitle,
    });
  });
  // 台帳にもロットにも無い工程へ付いた印も、列を作って見えるようにする (印は消さない)。
  taughtCells.forEach((m) => {
    m.forEach((_info, key) => {
      if (columnsMap.has(key)) return;
      const parsed = parseProcessKey(key);
      columnsMap.set(key, { processKey: key, templateId: parsed.templateId, stepId: parsed.stepId, templateName: null, stepTitle: '' });
    });
  });

  const columns = [...columnsMap.values()]
    .map((c) => {
      const people = peopleByKey.get(c.processKey);
      const headcount = people ? people.size : 0;
      return {
        ...c,
        headcount,
        soloName: headcount === 1 ? [...people][0] : null,
        // 「まだ誰もやっていない」= 置けた記録が1件も無い (疑似名・運用名・無名の記録が
        // 1件でもあれば false。記録があるのに「誰もやっていない」と言わない)。
        nobodyYet: !(recordsByKey.get(c.processKey) > 0),
      };
    })
    .sort((a, b) => (
      cmpStr(a.templateName || '', b.templateName || '')
      || cmpStr(a.stepTitle, b.stepTitle)
      || cmpStr(a.processKey, b.processKey)
    ));

  // 別掲 (行にしなかった名前の実績。黙って消さない)。並びは名簿の順で固定。
  const pseudoNames = PSEUDO_WORKER_NAMES
    .filter((n) => pseudoCounts.has(n))
    .map((n) => ({ name: n, count: pseudoCounts.get(n) }));
  const operationalNames = OPERATIONAL_NAMES
    .filter((n) => operationalCounts.has(n))
    .map((n) => ({ name: n, count: operationalCounts.get(n) }));
  const ambiguousNames = [...idx.ambiguousNames].sort(cmpStr);

  return { rows, columns, unattributedCount, pseudoNames, operationalNames, ambiguousNames };
}
