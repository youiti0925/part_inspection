// ============================================================================
// 🧪 見張り自身の試験 (scripts/verify-save-safety.mjs)
// ----------------------------------------------------------------------------
// ⚠⚠ **誤検出する見張りは、いずれ全部無視される。**
//   だから毎回この試験を通してから実コードを見る。確かめるのは2つ:
//     ① わざと壊した見本で **落ちる**   … 何も見ていない空っぽの見張りを合格させない
//     ② 正しい見本で **通る**           … 直した後のコードに文句を言わない
//   さらに ③ **負の対照** を並べる。過去に「実コードを食う誤検出」「嘘の合格」を出したため。
//
//   node scripts/selftest-save-safety.mjs
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSources } from './verify-save-safety.mjs';

const ids = (r) => r.findings.map((f) => f.id);
const run = (src, opts = {}) => analyzeSources([{ file: '(見本)', src }], opts);
// ⚠ 見本は短いので、見ている項目とは別の項目(例: hasPendingWrites が0件)にも当たる。
//   「直した後は文句を言わない」を確かめる時は **その項目の中だけ** を数える。
//   ここを全体で数えると、直っている見本を「不合格」と言い続ける見張りになる。
const gIds = (r, group) => r.findings.filter((f) => f.group === group).map((f) => f.id);

// ---------------------------------------------------------------------------
// 見本① 保存の順番 — 2026-08-17 に本番で起きた形そのまま(最終検査 HEAD の写し)
// ---------------------------------------------------------------------------
const ORDER_BAD = `
const saveData = async (col, id, rawData) => {
    let data = withDeletions(rawData);
    if (col === 'lots') {
        try {
            data = await dehydrateLotUpdate(id, data, async (imgId, imgDoc) => {
                await DATA(db).save(APP_DATA_ID, 'lot_images', imgId, { ...imgDoc, updatedAt: DATA_SERVER_NOW }, { merge: false });
            });
        } catch (e) { throw e; }
    }
    await DATA(db).save(APP_DATA_ID, col, id, { ...cleanUndefined(data), updatedAt: DATA_SERVER_NOW });
};
`;
// 入れ物の名前が定数で書いてある形(製品検査 HEAD の写し)。定数を解けないと見逃す。
const ORDER_BAD_CONST = `
const DIAGRAM_COLLECTION = 'step_diagrams';
const saveData = async (col, id, rawData) => {
    let data = rawData;
    if (col === 'lots' && Array.isArray(data.steps)) {
        const steps = await dehydrateSteps(data.steps, async (fid, body) => {
            await DATA(db).save(APP_DATA_ID, DIAGRAM_COLLECTION, fid, { ...body }, { merge: false });
        }, { known: new Set() });
        if (steps !== data.steps) data = { ...data, steps };
    }
    await DATA(db).save(APP_DATA_ID, col, id, { ...data, tasks: data.tasks });
};
`;
const ORDER_GOOD = `
const saveData = async (col, id, rawData, opts = {}) => {
    let data = withDeletions(rawData);
    let photoJobs = [];
    if (col === 'lots') {
        const planned = planLotDehydrate(id, data);
        data = planned.data;
        photoJobs = planned.images;
    }
    await runLotWrite({
        writeRecord: () => DATA(db).save(APP_DATA_ID, col, id, { ...cleanUndefined(data) }),
        writeImage: (imgId, imgDoc) => DATA(db).save(APP_DATA_ID, 'lot_images', imgId, { ...imgDoc }, { merge: false }),
        images: photoJobs,
    });
};
`;
// ⚠負の対照: 「絵を数えるだけ」で通信しない await(受け取った関数は push するだけ)。
//   これを順番の欠陥と言うと、直した後の製品検査が毎回赤くなる = 誰も読まなくなる。
const ORDER_GOOD_PLANONLY = `
const saveData = async (col, id, rawData) => {
    let diagramWrites = [];
    let data = rawData;
    if (col === 'lots' && Array.isArray(data.steps)) {
        const steps = await dehydrateSteps(data.steps, async (fid, body) => {
            diagramWrites.push({ id: fid, body });
        }, { known: new Set() });
        if (steps !== data.steps) data = { ...data, steps };
    }
    await runLotWrite({ writeRecord: () => DATA(db).save(APP_DATA_ID, col, id, data), images: diagramWrites });
};
`;

// ---------------------------------------------------------------------------
// 見本② 投げっぱなし
// ---------------------------------------------------------------------------
const THROWN_BAD = `
const TimeFixModal = ({ lot, onSave, onClose }) => {
    const [localTasks, setLocalTasks] = useState(() => JSON.parse(JSON.stringify(lot.tasks || {})));
    useEffect(() => { setLocalTasks(lot.tasks || {}); }, [lot.tasks]);
    const handleSave = () => { onSave({ tasks: localTasks }); onClose(); };
    return <button onClick={() => { saveData('lots', lot.id, { status: 'waiting' }); }}>直す</button>;
};
`;
const THROWN_GOOD = `
const TimeFixModal = ({ lot, onSave, onClose }) => {
    const [localTasks, setLocalTasks] = useState(() => JSON.parse(JSON.stringify(lot.tasks || {})));
    useEffect(() => { setLocalTasks(lot.tasks || {}); }, [lot.tasks]);
    const handleSave = async () => { await onSave({ tasks: localTasks }); onClose(); };
    return <button onClick={() => { saveData('lots', lot.id, { status: 'waiting' }).catch(e => alert(e)); }}>直す</button>;
};
`;
// ⚠負の対照A: 包み(中で catch して画面に出す)の中の呼び出しは握り潰しではない。
const THROWN_WRAPPED = `
const InspectionModal = ({ lot, onSave: onSaveRaw }) => {
    const onSave = useCallback((patch) => {
        const p = (async () => { try { return await onSaveRaw(patch); } catch (e) { setSaveErr(e); throw e; } })();
        p.catch(() => {});
        return p;
    }, [onSaveRaw]);
    const [tasks, setTasks] = useState(() => lot.tasks || {});
    useEffect(() => { setTasks(lot.tasks || {}); }, [lot.tasks]);
    const start = () => { onSave({ tasks: { a: 1 } }); };
    return <div>{start}</div>;
};
`;
// ⚠負の対照B: 配線(約束を呼んだ側へ返している)を「投げっぱなし」と言わない。
const THROWN_WIRING = `
const App = () => {
    return <AnalyticsView onSaveFieldReport={(id, data) => saveData('field_reports', id, data)} onSaveLot={(id, d) => saveData('lots', id, d)} />;
};
`;

// ---------------------------------------------------------------------------
// 見本③ 購読の onError
// ---------------------------------------------------------------------------
const WATCH_BAD = `
const un = [
  watch('lots', (rows) => setLots(rows)),
  watch('workers', (rows) => setWorkers(rows)),
];
`;
const WATCH_GOOD = `
const un = [
  watch('lots', (rows, snap) => { setLots(rows); }, { includeMetadataChanges: true, onError: (e) => setLotsReadError(String(e)) }),
  watch('workers', (rows) => setWorkers(rows), { onError: (e) => console.error(e) }),
];
`;
// ⚠負の対照: 画面の大きさを見る同名の watch(el, set) を購読と数えない。
const WATCH_RESIZE = `
const watch = (el, set) => { const ro = new ResizeObserver(() => set(el.offsetHeight)); ro.observe(el); return ro; };
watch(headerElRef.current, setHeaderH);
watch(midTabsElRef.current, setMidTabsH);
`;

// ---------------------------------------------------------------------------
// 見本④ 空マップ
// ---------------------------------------------------------------------------
const EMPTY_BAD = `
const reset = async (id) => {
  await saveData('lots', id, {});
  await DATA(db).save(APP_DATA_ID, 'lots', id, {});
};
const lotData = { orderNo, steps: finalSteps, interruptionsMap: {}, quantity: 1 };
`;
const EMPTY_GOOD = `
const reset = async (id, patch) => {
  if (!Object.keys(patch || {}).length) return;
  await saveData('lots', id, patch);
};
const lotData = { orderNo, steps: finalSteps, quantity: 1 };
`;
// ⚠負の対照: 手元の作業用の変数の {} を「本番が消える」と言わない。
const EMPTY_LOCALVAR = `
let _skip = { plan: {}, interruptionsMap: {}, decisions: [] };
const counters = { measurementResults: {}, lots: {} };
`;

// ---------------------------------------------------------------------------
// 見本⑤「済み」の嘘
// ---------------------------------------------------------------------------
const RESYNC_BAD = `
const WorkModal = ({ lot }) => {
    const [tasks, setTasks] = useState(() => migrateTaskKeys(lot.tasks, lot.steps, lot.quantity));
    const [interruptions, setInterruptions] = useState(lot.interruptions || []);
    useEffect(() => { setInterruptions(lot.interruptions || []); }, [lot.interruptions]);
    return <div>{tasks}</div>;
};
`;
const RESYNC_GOOD = `
const WorkModal = ({ lot }) => {
    const [tasks, setTasks] = useState(() => migrateTaskKeys(lot.tasks, lot.steps, lot.quantity));
    useEffect(() => { setTasks(prev => mergeServerTasks(prev, lot.tasks || {}, pendingTasksRef.current)); }, [lot.tasks, lot.steps]);
    const [interruptions, setInterruptions] = useState(lot.interruptions || []);
    useEffect(() => { setInterruptions(lot.interruptions || []); }, [lot.interruptions]);
    return <div>{tasks}</div>;
};
`;
// 🚨🚨 2026-08-30 に実際に起きた **偽の緑**。
//   set の入口を包んだだけ(setXRaw + useCallback)で、合わせ直しの effect は **無い**。
//   前の見張りは「useEffect( の後ろ 4000字以内に setter(」しか見ていなかったので、
//   手前に無関係な useEffect が1つ在るだけで緑になっていた。
//   実測: 作業画面の合わせ直し effect を丸ごと消しても ⑤は 0件 のままだった。
const RESYNC_WRAPPER_ONLY = `
const WorkModal = ({ lot }) => {
    const [outOfSync, setOutOfSync] = useState(null);
    useEffect(() => { setOutOfSync(null); }, [lot.id]);
    const [stepTimes, setStepTimesRaw] = useState(lot.stepTimes || {});
    const stepTimesRef = useRef(lot.stepTimes || {});
    const setStepTimes = useCallback((next) => {
      const v = typeof next === 'function' ? next(stepTimesRef.current) : next;
      stepTimesRef.current = v;
      setStepTimesRaw(v);
    }, []);
    return <div>{stepTimes}</div>;
};
`;
// 負の対照: 上と同じ包みに **本物の合わせ直し** を足した形。これは緑でなければならない。
const RESYNC_WRAPPER_FIXED = RESYNC_WRAPPER_ONLY.replace('return <div>', `
    useEffect(() => {
      const server = lot.stepTimes || {};
      setStepTimesRaw(server);
    }, [lot.id, lot.stepTimes]);
    return <div>`);
// 負の対照: 依存を lint が確かめられるよう **一度変数へ置いてから** 使う形(この画面の実際の書き方)。
//   effect の中に `lot.interruptions` と直接は書いていないが、これは本物の合わせ直し。
const RESYNC_VIA_ALIAS = `
const WorkModal = ({ lot }) => {
    const [interruptions, setInterruptions] = useState(lot.interruptions || []);
    const serverInts = Array.isArray(lot && lot.interruptions) ? lot.interruptions : null;
    useEffect(() => {
      if (!serverInts) return;
      setInterruptions((prev) => mergeById(prev, serverInts));
    }, [serverInts]);
    return <div>{interruptions}</div>;
};
`;

// ---------------------------------------------------------------------------
// 見本⑥ 未送信の見せ方
// ---------------------------------------------------------------------------
const PENDING_NONE = `
const saveData = async (col, id, data) => { await DATA(db).save(NS, 'lots', id, data); };
watch('lots', (rows) => setLots(rows), { onError: (e) => setErr(e) });
`;
const PENDING_STUCK = `
const saveData = async (col, id, data) => { await DATA(db).save(NS, 'lots', id, data); };
watch('lots', (rows, snap) => { setLotsPendingWrites(!!snap.metadata.hasPendingWrites); }, { onError: (e) => setErr(e) });
`;
const PENDING_GOOD = `
const saveData = async (col, id, data) => { await DATA(db).save(NS, 'lots', id, data); };
watch('lots', (rows, snap) => { setLotsPendingWrites(!!snap.metadata.hasPendingWrites); },
  { includeMetadataChanges: true, onError: (e) => setErr(e) });
`;

// ---------------------------------------------------------------------------
// 見本⑦ 1MBに載る写真
// ---------------------------------------------------------------------------
const PHOTO_BAD = `
const Ledger = ({ onSaveFieldReport }) => {
  const save = async () => {
    await onSaveFieldReport(data.id, { label: editLabel, photos: editPhotos, workerName: editWorkerName });
  };
  return <div>{save}</div>;
};
const App = () => <Ledger onSaveFieldReport={(id, data) => saveData('field_reports', id, data)} />;
`;
const PHOTO_GOOD = `
const Ledger = ({ onSaveFieldReport }) => {
  const save = async () => {
    await onSaveFieldReport(data.id, { label: editLabel, photoRefs: editPhotoRefs, workerName: editWorkerName });
  };
  return <div>{save}</div>;
};
const App = () => <Ledger onSaveFieldReport={(id, data) => saveData('field_reports', id, data)} />;
`;
const PHOTO_UNKNOWN_KEY = `
const finish = async () => {
  await saveData('lots', lot.id, { orderNo, quantity, tasks: newTasks, signaturePhoto: sigImg });
};
`;

// ---------------------------------------------------------------------------
// 見本⑧ 関所
// ---------------------------------------------------------------------------
const CHOKE_BAD = `
const saveData = async (col, id, data) => {
  if (col === 'lots') { assertSafeLotSave(before, data); }
  await DATA(db).save(APP_DATA_ID, col, id, data);
};
const restore = async () => {
  await DATA(db).save(APP_DATA_ID, 'lots', row.id, { tasks: row.tasks, steps: row.steps });
};
`;
const CHOKE_GOOD = `
const saveData = async (col, id, data) => {
  if (col === 'lots') { assertSafeLotSave(before, data); }
  await runLotWrite({ writeRecord: () => DATA(db).save(APP_DATA_ID, col, id, data), images: [] });
};
const restore = async () => { await saveData('lots', row.id, { tasks: row.tasks, steps: row.steps }); };
`;
// ⚠負の対照: 関所の名前は domain/saveOrder.js が決める。製品検査は saveInOrder を使う。
//   runLotWrite だけを探すと、直っているのに毎回赤くなる = 誰も読まなくなる。
const CHOKE_GOOD_SAVEINORDER = `
const saveData = async (col, id, data) => {
  if (col === 'lots') { assertSafeLotSave(before, data); }
  const h = saveInOrder({ record: { id, body: data }, blobs: diagramWrites, write: (w) => DATA(db).save(APP_DATA_ID, col, w.id, w.body) });
  await h.done;
};
`;
// ⚠ 入れ物の名前を変数のまま書く関所(部品検査の形)。'lots' の直書きが無くても関所として見つける。
const CHOKE_GENERIC_COL = `
const saveData = async (col, id, data) => {
  guardLotSave(col, id, data);
  await DATA(db).save(APP_DATA_ID, col, id, { ...cleanUndefined(data), updatedAt: DATA_SERVER_NOW });
};
const finish = () => { saveData('lots', lot.id, { tasks: newTasks }); };
`;
// ⚠ ロットを1件も書かないアプリ(③司令塔)。⑥⑧を「不合格」にしない・黙って合格にもしない。
const NO_LOT_APP = `
const saveMapConfig = async (payload) => {
  await DATA(db).save(OVERVIEW_NS, 'config', 'mapConfig', payload, { merge: false });
};
const un = DATA(db).watchCollection(ns, 'contact_requests', (rows) => setRows(rows), { onError: (e) => setErr(e) });
`;

// ---------------------------------------------------------------------------
// 負の対照(全体): コメントの中の例示コードを実コードとして数えない
// ---------------------------------------------------------------------------
const COMMENTS_ONLY = `
// 例: saveData('lots', id, {})  ← これは説明。実コードではない
// 直す前は data = await dehydrateLotUpdate(id, data, w) して lot_images へ書いていた
/* watch('lots', (rows) => setLots(rows));  ← 昔の書き方 */
/* const handleSave = () => { onSave({ tasks: localTasks }); onClose(); }; */
const nothing = 1;
`;

// ---------------------------------------------------------------------------
export const selftest = ({ quiet = false } = {}) => {
  let bad = 0;
  const out = [];
  const say = (ok, what, detail = '') => {
    out.push(`  ${ok ? '✅' : '❌'} ${what}${detail ? `  … ${detail}` : ''}`);
    if (!ok) bad++;
  };
  out.push('🧪 見張り自身の試験 (verify-save-safety.mjs)');

  // ① 保存の順番
  out.push(' ① 保存の順番');
  const o1 = ids(run(ORDER_BAD));
  say(o1.includes('SS-101'), '直す前(写真を待ってから本体)を捕まえる', o1.join(',') || 'なし');
  const o2 = ids(run(ORDER_BAD_CONST));
  say(o2.includes('SS-101'), '入れ物の名前が定数(DIAGRAM_COLLECTION)でも捕まえる', o2.join(',') || 'なし');
  const o3 = run(ORDER_GOOD);
  say(!ids(o3).includes('SS-101'), '直した後(runLotWrite で記録が先)は文句を言わない', ids(o3).join(',') || '0件');
  const o4 = run(ORDER_GOOD_PLANONLY);
  say(!ids(o4).includes('SS-101'), '負の対照: 通信しない await(数えるだけ)を欠陥と言わない', ids(o4).join(',') || '0件');

  // ② 投げっぱなし
  out.push(' ② 投げっぱなし');
  const t1 = run(THROWN_BAD);
  say(t1.findings.some((f) => f.id === 'SS-201'), '記録を含む投げっぱなし(直後に画面を閉じる)を捕まえる', ids(t1).join(',') || 'なし');
  say(t1.findings.some((f) => f.id === 'SS-201' && /saveData/.test(f.why)), 'DOMの受け口(onClick)の中の投げっぱなしも捕まえる', ids(t1).join(','));
  const t2 = run(THROWN_GOOD);
  say(!ids(t2).includes('SS-201') && !ids(t2).includes('SS-202'), '直した後(await / .catch)は文句を言わない', ids(t2).join(',') || '0件');
  const t3 = run(THROWN_WRAPPED);
  say(!ids(t3).includes('SS-201'), '負の対照: 包み(中で catch)の中の呼び出しを握り潰しと言わない', ids(t3).join(',') || '0件');
  say(t3.stats.wrappedCalls >= 1, '包みの中の呼び出しは件数として数える(黙って捨てない)', `${t3.stats.wrappedCalls}件`);
  const t4 = run(THROWN_WIRING);
  say(!ids(t4).includes('SS-201') && !ids(t4).includes('SS-202'), '負の対照: 配線(約束を返す矢印)を投げっぱなしと言わない', ids(t4).join(',') || '0件');

  // ③ 購読の onError
  out.push(' ③ 購読の onError');
  const w1 = run(WATCH_BAD);
  say(ids(w1).includes('SS-301'), 'lots の購読に onError が無い事を捕まえる', ids(w1).join(','));
  say(ids(w1).includes('SS-302'), 'その他の購読も名指しする', ids(w1).join(','));
  const w2 = run(WATCH_GOOD);
  say(!ids(w2).includes('SS-301') && !ids(w2).includes('SS-302'), 'onError 付きなら文句を言わない', ids(w2).join(',') || '0件');
  // 🚨🚨 受け皿の「字だけ」を見ていた頃(2026-09-01 まで)は、ここが**全部 緑**だった。
  //   壊す係 K1: `onError: onLotsError('active')` → `onError: undefined` で 0(緑)・指摘も動かず。
  //   だから「わざと壊した見本で落ちる」をこの形ごとに1件ずつ並べる。
  const DEAD_HANDLERS = [
    ['onError: undefined', `const un = [ watch('lots', (rows) => setLots(rows), { onError: undefined }) ];`],
    ['onError: null', `const un = [ watch('lots', (rows) => setLots(rows), { onError: null }) ];`],
    ['onError: () => {}', `const un = [ watch('lots', (rows) => setLots(rows), { onError: () => {} }) ];`],
    ['onError: async () => {}', `const un = [ watch('lots', (rows) => setLots(rows), { onError: async () => {} }) ];`],
    ['onError: (e) => { }', `const un = [ watch('lots', (rows) => setLots(rows), { includeMetadataChanges: true, onError: (e) => { } }) ];`],
    ['onError: function (e) {}', `const un = [ watch('lots', (rows) => setLots(rows), { onError: function (e) {} }) ];`],
    ['onError: () => undefined', `const un = [ watch('lots', (rows) => setLots(rows), { onError: () => undefined }) ];`],
    ['onError: (e) => { return; }', `const un = [ watch('lots', (rows) => setLots(rows), { onError: (e) => { return; } }) ];`],
    ['中身の無い catch', `const un = [ watch('lots', (rows) => { try { setLots(rows); } catch (e) {} }) ];`],
    ['中身の無い .catch(() => {})', `const un = [ watch('lots', (rows) => { save(rows).catch(() => {}); }) ];`],
  ];
  for (const [what, src] of DEAD_HANDLERS) {
    const r = run(src);
    say(ids(r).includes('SS-301'), `受け皿の字だけ(${what})を「付いている」と数えない`, ids(r).join(',') || '0件');
    say(r.stats.subsWithError === 0, `　同上 — onError付きの件数に足さない(${what})`, `${r.stats.subsWithError}件`);
  }
  // ⚠ 正しい形は緑のまま。ここが赤くなる直しは「うるさいだけの見張り」になる。
  const LIVE_HANDLERS = [
    ["名前付きを渡す(readFailed('lots'))", `const un = [ watch('lots', (rows) => setLots(rows), { onError: readFailed('lots') }) ];`],
    ["窓口を通して渡す(onLotsError('active'))", `const un = [ watch('lots', (rows) => setLots(rows), { onError: onLotsError('active') }) ];`],
    ['その場で札を出す', `const un = [ watch('lots', (rows) => setLots(rows), { onError: (e) => setLotsReadError(String(e)) }) ];`],
    ['中身のある関数', `const un = [ watch('lots', (rows) => setLots(rows), { onError: (e) => { setLotsReadError(String(e)); setLotsLoaded(false); } }) ];`],
    ['async で中身がある', `const un = [ watch('lots', (rows) => setLots(rows), { onError: async (e) => { await note(e); } }) ];`],
    ['位置で渡す onSnapshot(ref, next, onErr)', `const un = [ onSnapshot(ref, (snap) => setLots(snap), onLotsErr) ];`],
    ['中身のある catch', `const un = [ watch('lots', (rows) => { try { setLots(rows); } catch (e) { setLotsReadError(String(e)); } }) ];`],
  ];
  for (const [what, src] of LIVE_HANDLERS) {
    const r = run(src);
    say(!gIds(r, 3).includes('SS-301') && !gIds(r, 3).includes('SS-302'), `正しい形(${what})は緑のまま`, gIds(r, 3).join(',') || '0件');
    say(r.stats.subsWithError === 1, `　同上 — 働く受け皿として1件数える(${what})`, `${r.stats.subsWithError}件`);
  }
  const w3 = run(WATCH_RESIZE);
  say(w3.stats.subscriptions === 0, '負の対照: 画面の大きさを見る watch(el,set) を購読と数えない', `${w3.stats.subscriptions}件`);
  // ⚠負の対照: 窓口(src/data/*)は「呼んだ側の onError をそのまま渡すだけ」。ここを欠陥と言わない。
  const w4 = analyzeSources([{
    file: 'src/data/provider.js',
    src: `const watchCollection = (ns, col, next, opts = {}) => {
  const onErr = opts.onError;
  return onErr ? fs.onSnapshot(ref, next, onErr) : fs.onSnapshot(ref, next);
};`,
  }], {});
  say(!ids(w4).includes('SS-302') && !ids(w4).includes('SS-301'), '負の対照: 窓口(src/data/*)の受け渡しを欠陥と言わない', ids(w4).join(',') || '0件');
  const w5 = ids(run(`const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);\nwatch('workers', (rows) => setWorkers(rows));`));
  say(w5.includes('SS-303'), '画面が自分で作った購読の窓口に onError の口が無い事を名指しする', w5.join(','));

  // ④ 空マップ
  out.push(' ④ 空マップ');
  const e1 = ids(run(EMPTY_BAD));
  say(e1.includes('SS-401'), 'saveData(col, id, {}) を捕まえる', e1.join(','));
  say(e1.includes('SS-402'), '保管庫へ直接 {} を書く形を捕まえる', e1.join(','));
  say(e1.includes('SS-403'), 'ロットの payload の interruptionsMap:{} を捕まえる', e1.join(','));
  const e2 = gIds(run(EMPTY_GOOD), 4);
  say(!e2.length, '直した後は文句を言わない', e2.join(',') || '0件');
  const e3 = gIds(run(EMPTY_LOCALVAR), 4);
  say(!e3.length, '負の対照: 手元の作業用の変数の {} を誤検出しない', e3.join(',') || '0件');

  // ⑤「済み」の嘘
  out.push(' ⑤「済み」の嘘');
  const r1 = run(RESYNC_BAD);
  say(r1.findings.some((f) => f.id === 'SS-501' && /tasks/.test(f.why)), 'tasks が合わせ直されない事を名指しする', ids(r1).join(','));
  say(!r1.findings.some((f) => f.id === 'SS-501' && /lot\.interruptions/.test(f.why)),
    '負の対照: 合わせ直しが在る interruptions を名指ししない', r1.findings.filter((f) => f.id === 'SS-501').map((f) => f.why.slice(0, 24)).join(' / '));
  const r2 = ids(run(RESYNC_GOOD));
  say(!r2.includes('SS-501'), '直した後(合わせ直しの effect あり)は文句を言わない', r2.join(',') || '0件');
  const r3 = run(RESYNC_WRAPPER_ONLY).findings.filter((f) => f.id === 'SS-501');
  say(r3.length === 1 && /stepTimes/.test(r3[0].why),
    '🚨 set の入口を包んだだけ(合わせ直しは無い)を「直っている」と言わない', r3.map((f) => f.why.slice(0, 20)).join(' / ') || '0件');
  const r4 = run(RESYNC_WRAPPER_FIXED).findings.filter((f) => f.id === 'SS-501');
  say(r4.length === 0, '負の対照: 同じ包みでも本物の合わせ直しが在れば文句を言わない', r4.map((f) => f.why.slice(0, 20)).join(' / ') || '0件');
  const r5 = run(RESYNC_VIA_ALIAS).findings.filter((f) => f.id === 'SS-501');
  say(r5.length === 0, '負の対照: 材料を一度変数へ置く形(deps を lint が読める書き方)も合わせ直しと分かる', r5.map((f) => f.why.slice(0, 20)).join(' / ') || '0件');

  // ⑥ 未送信の見せ方
  out.push(' ⑥ 未送信の見せ方');
  const p1 = ids(run(PENDING_NONE));
  say(p1.includes('SS-601'), 'hasPendingWrites が0件である事を捕まえる', p1.join(','));
  const p2 = ids(run(PENDING_STUCK));
  say(p2.includes('SS-602'), 'includeMetadataChanges が無い(⏳が貼り付く)事を捕まえる', p2.join(','));
  const p3 = ids(run(PENDING_GOOD));
  say(!p3.includes('SS-601') && !p3.includes('SS-602') && !p3.includes('SS-603'), '直した後は文句を言わない', p3.join(',') || '0件');

  // ⑦ 1MBに載る写真
  out.push(' ⑦ 1MBに載る写真');
  const f1 = gIds(run(PHOTO_BAD), 7);
  say(f1.includes('SS-701'), '別置きを通らない棚へ写真を入れている事を捕まえる', f1.join(','));
  const f2 = gIds(run(PHOTO_GOOD), 7);
  say(!f2.includes('SS-701'), '写真そのものを入れていないなら文句を言わない', f2.join(',') || '0件');
  const cover = new Set(['packagingPhotos', 'tasks', 'interruptions', 'interruptionsMap', 'photos', 'imageUrl']);
  const f3 = gIds(run(PHOTO_UNKNOWN_KEY, { photoCoverKeys: cover }), 7);
  say(f3.includes('SS-702'), '別置きの一覧が知らない写真の鍵(ロットに生えた新顔)を捕まえる', f3.join(','));
  const f4 = gIds(run(`await saveData('lots', id, { orderNo, quantity, tasks: t, packagingPhotos: pkg });`, { photoCoverKeys: cover }), 7);
  say(!f4.includes('SS-702'), '負の対照: 一覧が知っている鍵(packagingPhotos)は言わない', f4.join(',') || '0件');
  const f5 = gIds(run(`await saveData('lots', id, { orderNo, quantity, tasks: t, photoCount: 3, imageWidth: 640 });`, { photoCoverKeys: cover }), 7);
  say(!f5.includes('SS-702'), '負の対照: 写真そのものでない鍵(photoCount/imageWidth)を写真と言わない', f5.join(',') || '0件');

  // ⑧ 関所
  out.push(' ⑧ 関所');
  const c1 = run(CHOKE_BAD);
  say(ids(c1).includes('SS-802'), '関所が順番の関所(runLotWrite)を通っていない事を捕まえる', ids(c1).join(','));
  say(ids(c1).includes('SS-803'), '関所を迂回して記録を直接書いている所を捕まえる', ids(c1).join(','));
  say(c1.stats.chokes.length === 1 && c1.stats.chokes[0].guarded === false, '関所の一覧を出す', JSON.stringify(c1.stats.chokes));
  const c2 = run(CHOKE_GOOD);
  say(!ids(c2).includes('SS-802') && !ids(c2).includes('SS-803'), '直した後は文句を言わない', ids(c2).join(',') || '0件');
  const c3 = ids(run(CHOKE_GOOD, { hasSaveOrderModule: false }));
  say(c3.includes('SS-804'), 'domain/saveOrder.js(試験のある関所)が無い事を捕まえる', c3.join(','));
  const c4 = run(CHOKE_GOOD_SAVEINORDER, { orderGateNames: ['runLotWrite', 'saveInOrder', 'orderWrites'] });
  say(!gIds(c4, 8).includes('SS-802'), '負の対照: 関所の名前が saveInOrder でも「通っている」と分かる', gIds(c4, 8).join(',') || '0件');
  const c5 = run(CHOKE_GENERIC_COL);
  say(c5.stats.chokes.length === 1, "入れ物の名前が変数(col)のままの関所も見つける", JSON.stringify(c5.stats.chokes));
  say(!gIds(c5, 8).includes('SS-801'), '関所が在るのに「見つからない」と言わない', gIds(c5, 8).join(',') || '0件');
  const c6 = run(NO_LOT_APP);
  say(c6.stats.writesLotRecords === false, 'ロットを書かないアプリを「書いている」と誤認しない', String(c6.stats.writesLotRecords));
  say(!gIds(c6, 6).length && !gIds(c6, 8).length, '負の対照: ロットを書かないアプリに ⑥⑧ で文句を言わない',
    [...gIds(c6, 6), ...gIds(c6, 8)].join(',') || '0件');

  // 全体の負の対照
  out.push(' ⑨ 全体の負の対照');
  // ⚠ いま配られていないファイル(main.jsx から辿れない休眠版)は **名指しするが出荷は止めない**。
  const deadRun = analyzeSources([{ file: 'src/App.old.jsx', src: THROWN_BAD }], { liveFiles: new Set(['src/App.jsx']) });
  say(deadRun.findings.some((f) => f.id === 'SS-201'), '休眠ファイルの欠陥も見つけて名指しする', ids(deadRun).join(','));
  say(deadRun.findings.every((f) => f.level !== 'error'), '休眠ファイルでゲートを赤にしない',
    deadRun.findings.map((f) => f.level).join(','));
  const liveRun = analyzeSources([{ file: 'src/App.jsx', src: THROWN_BAD }], { liveFiles: new Set(['src/App.jsx']) });
  say(liveRun.findings.some((f) => f.id === 'SS-201' && f.level === 'error'), '現用ファイルはちゃんと赤にする',
    liveRun.findings.filter((f) => f.id === 'SS-201').map((f) => f.level).join(','));
  // ⚠ 写真の置き場そのもの(lot_images)へ写真を書くのは **正しい別置き**。欠陥と言わない。
  const shelf = analyzeSources([{
    file: 'src/App.jsx',
    src: `const App = () => <PhotoManager saveImageDoc={(imgId, patch) => saveData('lot_images', imgId, patch)} />;
const Panel = ({ saveImageDoc }) => { const go = async () => { await saveImageDoc(id, { dataUrl: out }); }; return go; };`,
  }], {});
  say(!ids(shelf).includes('SS-701'), '負の対照: 別置きの行き先(lot_images)への写真を欠陥と言わない', ids(shelf).join(',') || '0件');
  const cm = ids(run(COMMENTS_ONLY));
  say(!cm.length, 'コメントの中の例示コードを実コードとして数えない', cm.join(',') || '0件');
  const empty = run('const a = 1;\n');
  say(!empty.findings.length, '何も無いファイルで指摘を作らない', ids(empty).join(',') || '0件');
  // ⚠「直す前より直した後の方が指摘が少ない」= 見張りが実際に効いている事の担保
  say(run(ORDER_BAD).findings.length > run(ORDER_GOOD).findings.length, '直す前 > 直した後(見張りが空っぽでない)',
    `${run(ORDER_BAD).findings.length} > ${run(ORDER_GOOD).findings.length}`);

  out.push(bad === 0 ? '🧪 見張り自身の試験: 合格' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗`);
  if (!quiet || bad) console.log(out.join('\n'));
  return bad === 0;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(selftest() ? 0 : 1);
