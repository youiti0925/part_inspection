// =============================================================================
// 📋 保存計画を **共有棚** に置く(2026-09-22)。localPlanStore の置き換え。
// -----------------------------------------------------------------------------
// 🚨 なぜ作り直したか
//   元の localPlanStore は IndexedDB = **その端末の中だけ**。
//   承認した計画も、担当の固定も 端末ごとに別物になり、
//   **同じ日に同じ画面を開いても端末によってシミュレーションの答えが変わる**。
//   決まり(2026-07-17): 多端末前提。「人の判断」を端末ローカルに置かない。
//
// 🚨 置き方(2026-09-22 夜に作り直し)
//   前は plan_control/{app} に計画本体を1件だけ置き、merge:false で上書きしていた。
//   ① 2台が同時に保存すると「読む→確かめる→書く」が端末側で分かれているので
//      両方が同じ版を確かめてから書け、**後勝ちで片方が消える**(Codex が隔離試験で再現)。
//   ② 上書きなので **過去版が残らない**。提出した第1版を第2版の後に開けない。
//   → 版ごとに別書類 plan_versions/{app}__v{n}(書いたら二度と変えない)。
//     採用中の版は head = plan_control/{app} が指す({ kind:'head', revision, versionId, ... })。
//     「最新版の確認・新版の作成・head の更新」は窓口の commitVersion で **1つの取引**。
//   ⚠ 古い形(head に計画本体が入っている物)は、次に保存する取引の中で版へ移す。黙って捨てない。
//
// 🚨 Firestore の2つの罠(どちらも過去に踏んでいる)
//   ① **入れ子の配列を保存できない**。`[[s,e], ...]` が1つでも在ると
//      その書類ぜんぶが拒否される(2026-09-19 共有棚が3日間1度も書けていなかった原因)。
//      → 勤務区間は保存の直前に `{s,e}` へ、読んだ直後に `[s,e]` へ戻す。
//   ② **1書類 1MB**。越えると書けない。黙って失敗させず、先に人へ言う。
//
// 🚨 このファイルは純関数だけ。firebase を import しない。
//   読む・書くは呼ぶ側(App)から関数で受け取る(決まり: CONTRACT.md 0章)。
// =============================================================================
import { prepareAdoption } from './planControl.js';
import { validateStored } from './localPlanStore.js';
import { conditionsToStored, conditionsFromStored } from './planConditions.js';
import { reviewDocId, reviewStatusOf, canTransition, makeReviewRecord } from './planReview.js';

/** Firestore の1書類の上限(1MiB)。余白を取って 800KB で止める。 */
export const PLAN_DOC_MAX_BYTES = 800 * 1024;
/** 採用中の版を指す書類(1アプリ1件)。 */
export const PLAN_HEAD_COLLECTION = 'plan_control';
/** 版ごとの本体。書いたら変えない。 */
export const PLAN_VERSION_COLLECTION = 'plan_versions';
/** 版の書類の id。 */
export const versionDocId = (app, revision) => `${app}__v${revision}`;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 保存する形へ。⚠ 勤務区間の `[s,e]` を `{s,e}` にする(入れ子の配列は保存できない)。
 * 元の plan は1バイトも触らない。
 */
export function toStoredPlan(plan) {
  if (!isObj(plan)) throw new Error('保存する計画がありません');
  const ev = isObj(plan.evidence) ? plan.evidence : null;
  const conditions = conditionsToStored(plan.conditions); // scenario は JSON 文字列に(入れ子の配列を Firestore に出さない)
  const { tasks, definitions } = packTables(plan);
  if (!ev) return { ...plan, tasks, definitions, spanShape: 'pair', conditions };
  const spansByTask = {};
  for (const [k, list] of Object.entries(ev.spansByTask || {})) {
    if (!Array.isArray(list)) { spansByTask[k] = null; continue; }
    spansByTask[k] = list
      .map((x) => (Array.isArray(x) ? { s: num(x[0]), e: num(x[1]) } : { s: num(x && x.s), e: num(x && x.e) }))
      .filter((x) => x.s != null && x.e != null);
  }
  const { spanLists, spanRefByTask } = packSpans(spansByTask);
  const { spansByTask: _drop, ...evRest } = ev;
  return { ...plan, tasks, definitions, spanShape: 'pair', conditions, evidence: { ...evRest, spanLists, spanRefByTask } };
}

/**
 * 読んだ形から画面・帳票が使う形へ。`{s,e}` を `[s,e]` に戻す。
 * ⚠ 古い形(`[s,e]` のまま入っている物)も読めるようにする。
 */
export function fromStoredPlan(stored) {
  if (!isObj(stored)) return null;
  const ev = isObj(stored.evidence) ? stored.evidence : null;
  const conditions = conditionsFromStored(stored.conditions);
  const tasks = unpackTables(stored);
  const { definitions: _d, chunkCount: _c, ...planRest } = stored;
  if (!ev) return { ...planRest, tasks, conditions };
  const spansByTask = {};
  const { spanLists: _sl, spanRefByTask: _sr, ...evRest } = ev;
  for (const [k, list] of Object.entries(unpackSpans(ev))) {
    if (!Array.isArray(list)) { spansByTask[k] = null; continue; }
    spansByTask[k] = list
      .map((x) => (Array.isArray(x) ? [num(x[0]), num(x[1])] : [num(x && x.s), num(x && x.e)]))
      .filter((x) => x[0] != null && x[1] != null);
  }
  return { ...planRest, tasks, conditions, evidence: { ...evRest, spansByTask } };
}

/* ── 大きさ対策(2026-09-22): 写しの本物の7日計画が 1,035KB で 1MB を越えていた ─────────────
   task.definition は工程の説明文ごと(1件 約300B・1064件中114種)。spansByTask も同じ並びが多い。
   → 表にして番号で持つ。読む時に戻す。画面・帳票・比較は1バイトも変わらない。 */
function packTables(plan) {
  const defs = [], defIdx = new Map();
  const tasks = (plan.tasks || []).map((t) => {
    if (typeof t.definition !== 'string') return t;
    let i = defIdx.get(t.definition);
    if (i === undefined) { i = defs.length; defs.push(t.definition); defIdx.set(t.definition, i); }
    const { definition: _def, ...rest } = t;
    return { ...rest, definitionRef: i };
  });
  return { tasks, definitions: defs };
}
function unpackTables(stored) {
  const defs = Array.isArray(stored.definitions) ? stored.definitions : null;
  if (!defs) return stored.tasks;
  return (stored.tasks || []).map((t) => {
    if (!Number.isInteger(t.definitionRef)) return t;
    const { definitionRef, ...rest } = t;
    return { ...rest, definition: defs[definitionRef] };
  });
}
function packSpans(spansByTask) {
  const lists = [], idx = new Map(), ref = {};
  for (const [k, list] of Object.entries(spansByTask || {})) {
    if (!Array.isArray(list)) { ref[k] = -1; continue; }
    const key = JSON.stringify(list);
    let i = idx.get(key);
    if (i === undefined) { i = lists.length; lists.push({ spans: list }); idx.set(key, i); } // ⚠ 配列の中の配列にしない(Firestore が書類ごと拒否する)
    ref[k] = i;
  }
  return { spanLists: lists, spanRefByTask: ref };
}
function unpackSpans(ev) {
  if (!ev || !ev.spanRefByTask) return ev ? (ev.spansByTask || {}) : {};
  const out = {};
  for (const [k, i] of Object.entries(ev.spanRefByTask)) out[k] = i < 0 ? null : ((ev.spanLists[i] && ev.spanLists[i].spans) || []);
  return out;
}

/** 1つの書類に収まらない時、tasks・根拠・表を兄弟の書類へ分ける。索引(tasks:[]・chunkCount)と欠片の一覧を返す。 */
export function packStoredPlan(stored, versionId, maxBytes = PLAN_DOC_MAX_BYTES) {
  const whole = new TextEncoder().encode(JSON.stringify(stored)).length;
  if (whole <= maxBytes) return { index: { ...stored, chunkCount: 0 }, chunks: [] };
  const tasks = stored.tasks || [];
  // 📦 2026-09-22 夜: 根拠(evidence.lots・spanRefByTask)も欠片へ。製品の本番(978ロット)では根拠だけで 1.1MB あり、索引に残すと保存できなかった
  const ev = isObj(stored.evidence) ? stored.evidence : null;
  const evLots = ev && Array.isArray(ev.lots) ? ev.lots : [];
  const evRefs = ev && isObj(ev.spanRefByTask) ? Object.entries(ev.spanRefByTask) : [];
  // 📦 2026-09-24: 表(definitions・acknowledgedIssueIds・evidence.spanLists)も欠片へ。最終の本番(9216工程)では
  //   tasks と根拠を出しても索引が 1922KB(definitions 1360KB・acknowledgedIssueIds 320KB・spanLists 241KB)残り、最初の版が1度も保存できなかった。
  //   ⚠ definitions と spanLists は番号(definitionRef・spanRefByTask)で指されるので **並びを変えない**(欠片の順に足すだけ)。
  //   印 tablesChunked が在る版だけ読む時に繋ぎ直す。印の無い古い版はこれまでどおり
  const defs = Array.isArray(stored.definitions) ? stored.definitions : null;
  const acks = Array.isArray(stored.acknowledgedIssueIds) ? stored.acknowledgedIssueIds : null;
  const spanLists = ev && Array.isArray(ev.spanLists) ? ev.spanLists : null;
  const index = { ...stored, tasks: [], chunkCount: 0, tablesChunked: true,
    ...(defs ? { definitions: [] } : {}), ...(acks ? { acknowledgedIssueIds: [] } : {}),
    ...(ev ? { evidence: { ...ev, lots: [], spanRefByTask: {}, ...(spanLists ? { spanLists: [] } : {}), chunked: true } } : {}) };
  const indexBytes = new TextEncoder().encode(JSON.stringify(index)).length;
  if (indexBytes > maxBytes) throw new Error(`計画の根拠だけで大きすぎて保存できません（${Math.round(indexBytes / 1024)}KB / 上限 ${Math.round(maxBytes / 1024)}KB）。期間を短くするか、対象のロットを絞ってください`);
  const chunks = [];
  const empty = () => ({ tasks: [], evidenceLots: [], spanRefByTask: {}, definitions: [], acknowledgedIssueIds: [], spanLists: [] });
  let cur = empty(), curBytes = 64;
  const push = () => { if (cur.tasks.length || cur.evidenceLots.length || Object.keys(cur.spanRefByTask).length || cur.definitions.length || cur.acknowledgedIssueIds.length || cur.spanLists.length) { chunks.push({ id: `${versionId}__c${chunks.length}`, doc: { chunkOf: versionId, part: chunks.length, ...cur } }); cur = empty(); curBytes = 64; } };
  const add = (bytes, put) => { if (curBytes + bytes > maxBytes - 200) push(); put(); curBytes += bytes; };
  const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length + 1;
  for (const t of tasks) add(bytesOf(t), () => cur.tasks.push(t));
  for (const l of evLots) add(bytesOf(l), () => cur.evidenceLots.push(l));
  for (const [k, v] of evRefs) add(bytesOf([k, v]), () => { cur.spanRefByTask[k] = v; });
  for (const d of defs || []) add(bytesOf(d), () => cur.definitions.push(d));
  for (const a of acks || []) add(bytesOf(a), () => cur.acknowledgedIssueIds.push(a));
  for (const s of spanLists || []) add(bytesOf(s), () => cur.spanLists.push(s)); // ⚠ {spans:[...]} のまま(配列の中の配列にしない)
  push();
  index.chunkCount = chunks.length;
  return { index, chunks };
}
/** 索引と欠片から tasks を繋ぎ直す。欠片が欠けていれば黙って短い計画にせず断る。 */
export function unpackStoredPlan(index, chunkDocs) {
  const n = Number(index && index.chunkCount) || 0;
  if (n === 0) return index;
  const tasks = [];
  const evLots = [];
  const evRefs = {};
  const defs = [], acks = [], spanLists = [];
  for (let i = 0; i < n; i += 1) {
    const c = chunkDocs[i];
    if (!c || !Array.isArray(c.tasks)) throw new Error(`保存した計画の一部（${i + 1}/${n}）が棚にありません`);
    tasks.push(...c.tasks);
    if (Array.isArray(c.evidenceLots)) evLots.push(...c.evidenceLots);
    if (isObj(c.spanRefByTask)) Object.assign(evRefs, c.spanRefByTask);
    if (Array.isArray(c.definitions)) defs.push(...c.definitions);
    if (Array.isArray(c.acknowledgedIssueIds)) acks.push(...c.acknowledgedIssueIds);
    if (Array.isArray(c.spanLists)) spanLists.push(...c.spanLists);
  }
  // 📦 2026-09-24: 表も欠片へ分けた版(tablesChunked)は欠片の順に繋ぎ直す。印の無い古い版は索引の表をそのまま
  const tables = index.tablesChunked === true;
  // 根拠を欠片へ分けた版(chunked)は繋ぎ直す。古い版(根拠が索引に丸ごと)はそのまま
  const evidence = isObj(index.evidence) && index.evidence.chunked
    ? (() => { const { chunked: _c, ...rest } = index.evidence; return { ...rest, lots: evLots, spanRefByTask: evRefs, ...(tables && Array.isArray(rest.spanLists) ? { spanLists } : {}) }; })()
    : index.evidence;
  const { tablesChunked: _t, ...indexRest } = index;
  return { ...indexRest, tasks,
    ...(tables && Array.isArray(index.definitions) ? { definitions: defs } : {}),
    ...(tables && Array.isArray(index.acknowledgedIssueIds) ? { acknowledgedIssueIds: acks } : {}),
    ...(evidence !== undefined ? { evidence } : {}) };
}


/** 保存できる大きさか。越えるなら人に見せる言葉で断る。 */
export function planDocSizeCheck(stored, maxBytes = PLAN_DOC_MAX_BYTES) {
  const bytes = new TextEncoder().encode(JSON.stringify(stored)).length;
  if (bytes > maxBytes) {
    throw new Error(`計画が大きすぎて保存できません（${Math.round(bytes / 1024)}KB / 上限 ${Math.round(maxBytes / 1024)}KB）。期間を短くするか、対象のロットを絞ってください`);
  }
  return bytes;
}

/**
 * 入れ子の配列が残っていないかを **保存の直前に** 確かめる。
 * 🚨 1つでも在ると書類ぜんぶが拒否される。黙って失敗させない。
 */
export function nestedArrayPath(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (Array.isArray(value[i])) return `${path}[${i}]`;
      const deeper = nestedArrayPath(value[i], `${path}[${i}]`);
      if (deeper) return deeper;
    }
    return null;
  }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      const deeper = nestedArrayPath(v, path ? `${path}.${k}` : k);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** head の書類が「古い形(計画本体そのもの)」か。tasks を持っていれば本体。 */
export const isLegacyHead = (doc) => isObj(doc) && Array.isArray(doc.tasks) && doc.kind !== 'head';

/** 計画本体から head(指し手)の書類を作る。 */
export function headDocOf(app, plan) {
  return {
    kind: 'head', schema: 2, app,
    revision: plan.revision, planId: plan.id, versionId: versionDocId(app, plan.revision),
    committedAt: plan.committedAt, committedBy: plan.committedBy,
  };
}

/** 版一覧の1行(一覧に本体を載せない。本体は開く時に読む)。 */
export function versionRowOf(plan) {
  return { revision: plan.revision, id: plan.id, committedAt: plan.committedAt, committedBy: plan.committedBy, parentId: plan.parentId ?? null,
    hasEvidence: !!plan.evidence };
}

/**
 * 共有棚の保存計画の窓口。
 * @param {object} io
 *   readHead()            … head(plan_control/{app})。無ければ null。🚨 控えを見ない読み(サーバ)
 *   readVersion(id)       … 版の本体(plan_versions/{id})。無ければ null
 *   listVersions()        … このアプリの版の本体を全部(一覧用)。無くても動く(head だけの一覧になる)
 *   commitVersion(args)   … 窓口の取引。{ expectRevision, versionId, versionDoc, headDoc, preserveOld } → { ok, reason, headRevision }
 *   appId … 'product' | 'final'
 */
export function makeSharedPlanStore({ readHead, readVersion, commitVersion, listVersions = null, readReview = null, appendReview = null, appId } = {}) {
  if (typeof readHead !== 'function' || typeof readVersion !== 'function' || typeof commitVersion !== 'function') {
    throw new Error('共有棚の読み書きの口が渡されていません');
  }
  const checkApp = (app) => { if (appId && app && app !== appId) throw new Error('アプリが一致しません'); };
  const readWhole = async (raw, id) => {
    const n = Number(raw && raw.chunkCount) || 0;
    if (n === 0) return raw;
    const parts = [];
    for (let i = 0; i < n; i += 1) parts.push(await readVersion(`${id}__c${i}`));
    return unpackStoredPlan(raw, parts);
  };
  const toPlan = (raw) => (raw ? validateStored(fromStoredPlan(raw)) : null);
  /** 採用中の計画(head が指す版)。古い形なら head そのものが本体。 */
  const readCurrent = async () => {
    const head = await readHead();
    if (!head) return null;
    if (isLegacyHead(head)) return toPlan(head);
    if (!head.versionId) throw new Error('採用中の版の指し手が壊れています（versionId がありません）');
    const raw = await readVersion(head.versionId);
    if (!raw) throw new Error(`採用中の第${head.revision}版の本体が棚にありません（${head.versionId}）`);
    return toPlan(await readWhole(raw, head.versionId));
  };
  return {
    /** @returns {Promise<object|null>} 採用中の計画(無ければ null) */
    async read(app) { checkApp(app); return readCurrent(); },

    /** 指定した版を開く(過去版の再出力用)。無ければ null。 */
    async readRevision(app, revision) {
      checkApp(app);
      const n = Number(revision);
      if (!Number.isInteger(n) || n < 1) throw new Error('版の番号が正しくありません');
      const raw = await readVersion(versionDocId(app, n));
      if (raw) return toPlan(await readWhole(raw, versionDocId(app, n)));
      // まだ版へ移していない古い形の head かもしれない
      const head = await readHead();
      if (isLegacyHead(head) && head.revision === n) return toPlan(head);
      return null;
    },

    /** 審査の書類(無ければ null)。口が無い画面では null。 */
    async readReview(app, revision) {
      checkApp(app);
      if (typeof readReview !== 'function') return null;
      return readReview(reviewDocId(app, revision));
    },
    /**
     * 審査の記録を1件足す(提出・承認・差戻し)。🚨 遷移の可否は純関数 canTransition で決める(ボタンの見せ方に頼らない)。
     * @returns {{ ok:boolean, reason:string, status:string }}
     */
    async recordReview(app, revision, { status, by, atMs, note = '', paperApprover = '', isApprover = false, canEdit = false } = {}) {
      checkApp(app);
      if (typeof readReview !== 'function' || typeof appendReview !== 'function') return { ok: false, reason: '審査の記録の口が無い画面です', status: null };
      const id = reviewDocId(app, revision);
      // 🚨 2026-09-22 「今の状態を見て決めた」を追記の取引の中で確かめる(expectLength = 見た時の履歴の件数)。
      //   履歴が動いていたら(別端末が先に承認/差戻し)読み直して判定し直す。承認と差戻しが両方通る事は無い。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const cur = await readReview(id);
        const from = reviewStatusOf(cur);
        const gate = canTransition(from, status, { isApprover, canEdit });
        if (!gate.ok) return { ok: false, reason: gate.reason, status: from };
        const rec = makeReviewRecord({ status, by, atMs, note, paperApprover });
        const r = await appendReview(id, rec, { app, revision }, { expectLength: ((cur && cur.history) || []).length });
        if (!(r && r.stale)) return { ok: true, reason: '', status };
      }
      return { ok: false, reason: '別の端末が先に記録しました。読み直してから、もう一度押してください', status: reviewStatusOf(await readReview(id)) };
    },

    /** 版の一覧(新しい順)。本体は載せない。 */
    async history(app) {
      checkApp(app);
      const rows = new Map();
      if (typeof listVersions === 'function') {
        for (const raw of (await listVersions()) || []) {
          if (!isObj(raw) || raw.chunkOf || (raw.app && appId && raw.app !== appId)) continue;
          const n = Number(raw.revision);
          if (Number.isInteger(n) && n >= 1) rows.set(n, versionRowOf(raw));
        }
      }
      const head = await readHead();
      if (isLegacyHead(head) && Number.isInteger(head.revision) && !rows.has(head.revision)) rows.set(head.revision, versionRowOf(head));
      const currentRevision = head ? (Number(head.revision) || 0) : 0;
      return { currentRevision, versions: [...rows.values()].sort((a, b) => b.revision - a.revision) };
    },

    /**
     * 採用(保存)。🚨 版の確認と書き込みは窓口の取引(commitVersion)の中で一体に行う。
     *   端末側の再読込は使わない(2台同時で両方通る形だった)。
     *   取引が stale / exists を返したら **何も書かれていない**。'stale-revision' で画面へ返す。
     */
    async adopt(app, getOptions) {
      checkApp(app);
      const baseline = await readCurrent();
      const options = getOptions();
      if (options.proposal.context.app !== app) throw new Error('アプリが一致しません');
      const expectRevision = baseline?.revision || 0;
      const result = prepareAdoption({ ...options, baseline, headRevision: expectRevision });
      if (!result.ok) return result;
      const stored = { ...toStoredPlan(result.snapshot), app };
      const bad = nestedArrayPath(stored);
      if (bad) throw new Error(`計画の中に入れ子の配列があり保存できません（${bad}）`);
      const versionId = versionDocId(app, result.snapshot.revision);
      const { index, chunks } = packStoredPlan(stored, versionId);
      planDocSizeCheck(index);
      for (const c of chunks) planDocSizeCheck(c.doc);
      const r = await commitVersion({
        expectRevision,
        versionId,
        versionDoc: index,
        chunks,
        headDoc: headDocOf(app, result.snapshot),
        // 古い形(head に本体)なら、同じ取引で版へ移す。黙って捨てない。
        preserveOld: (cur) => (isLegacyHead(cur) && Number.isInteger(cur.revision) && cur.revision >= 1
          ? { col: PLAN_VERSION_COLLECTION, id: versionDocId(app, cur.revision), doc: { ...cur, app, migratedFrom: PLAN_HEAD_COLLECTION } }
          : null),
      });
      if (!r || !r.ok) return { ok: false, errors: ['stale-revision'], snapshot: null, headRevision: r ? r.headRevision : null };
      return result;
    },
  };
}

export default makeSharedPlanStore;
