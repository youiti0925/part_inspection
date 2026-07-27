// ============================================================================
// PocketBase 版の保管庫(窓口 provider.js から使う)
// ----------------------------------------------------------------------------
// Firebase 版(createFirebaseBackend)と **同じ形** を提供する。
// 画面のコードは1文字も変えずに保管庫だけ差し替えられる、が目標。
//
// 中でやっていること:
//   ① 読み: 最初に全部読み、あとは購読(SSE)で差分を受けて手元の一覧を直す。
//      ⚠実測(v0.39.9): 購読のフィルタは **受け付けるが効かない**。
//        ns="A" だけを購読しても ns="B" の変更が届く。→ 絞り込みは端末側で行う。
//        接続は全体で1本だけ張る(コレクションごとに張らない)。
//   ② 書き: 送信待ちの箱(outbox)へ入れてから、手元の一覧にも先に反映する。
//      電波が切れていても画面は進む。つながったら自動で送られる。
//   ③ 重ね方(merge)は端末側で計算する(PocketBase は JSON を丸ごと持つため)。
//      Firestore と同じ規則を docMerge.js に1本だけ置いてある。
//   ④ 「読んで→書く」は UNIQUE の門で1台だけに渡す(pbDocStore.js)。
// ============================================================================

import { createDocStore, PbConflictError, PbCommandMismatchError, DOCS_COL } from './pbDocStore.js';
import { createOutbox, createIdbStore, createMemoryStore, STATUS } from './outbox.js';
import { mergeDoc, overwriteDoc, setFieldsDoc } from './docMerge.js';
import { withDeletions } from './sentinels.js';
import { POCKETBASE_CAPABILITIES } from './capabilities.js';

const keyOf = (ns, col) => `${ns}/${col}`;

/**
 * @param client   createPbClient(...) の戻り
 * @param outboxStore  省略時は IndexedDB(使えなければメモリ)
 */
export const createPocketbaseBackend = (client, {
  outboxStore, docsCol = DOCS_COL, owner = '', onPendingChange, onConflict, autoRealtime = true,
} = {}) => {
  const store = createDocStore(client, { docsCol, owner });

  // --- 手元の一覧(コレクション単位) -----------------------------------------
  // ⚠2つの層に分ける。
  //   cache   = サーバから来た中身
  //   pending = **まだ送れていない保存を重ねた見込みの値**(送信待ちの箱と対応)
  //   画面に出すのは「cache の上に pending を重ねたもの」。
  //   こうしないと、電波が切れている間に保存したものが画面から消える。
  //   ⚠pending を cache に直接書くと、サーバから読み直した時に消えてしまう。
  const cache = new Map();     // "ns/col" -> Map(docId -> data)
  // ⚠⚠「読めた」を cache の有無で判断してはいけない。
  //   読めなかった時も、画面を空にしないために cache へ空の Map を入れる。
  //   そこで「読めた」の印を別に持たないと、**一度失敗しただけで二度と読み直さなくなる**。
  //   実測(2026-07-27): サーバに139件あるのに、起動直後も以後もずっと0件だった。
  const loaded = new Set();    // "ns/col"(サーバから正しく読めたもの)
  // ⚠版番号を手元でも覚える。電波が切れている間はサーバに聞けないので、
  //   これが無いと「オフラインで全部書き換える保存」がぶつかりを見逃して
  //   復帰時に相手の変更を丸ごと消す(実測で踏んだ)。
  const revs = new Map();      // "ns/col" -> Map(docId -> rev)
  const pending = new Map();   // "ns/col" -> Map(docId -> data | REMOVED)
  const REMOVED = Symbol('removed');
  const listeners = new Map(); // "ns/col" -> Map(cb -> opts)  ⚠受け手ごとに読み方(map)が違う
  const loading = new Map();   // "ns/col" -> Promise
  const loadError = new Map(); // "ns/col" -> Error(読めなかった理由)
  const docListeners = new Map(); // "ns/col/docId" -> Set(cb)

  /** cache ⊕ pending。画面から見える中身。 */
  const viewOf = (k) => {
    const out = new Map(cache.get(k) || new Map());
    const p = pending.get(k);
    if (p) for (const [id, v] of p) { if (v === REMOVED) out.delete(id); else out.set(id, v); }
    return out;
  };

  // ⚠1件を行に直す方法は2通りある(ドキュメントID優先 / 本文のid優先)。
  //   Firebase 版は呼び出し側から map で受け取っている。**同じものを受け取れないと、
  //   同じ画面コードが保管庫によって違う行を作る**。Firestore の QueryDocumentSnapshot と
  //   同じ形(= id と data())の見せかけを渡して、既存の map をそのまま使えるようにする。
  const shim = (docId, data) => ({ id: docId, data: () => (data || {}) });
  const DEFAULT_MAP = (d) => ({ ...d.data(), id: d.id });   // ROW_DOCID_WINS と同じ
  const rowsOf = (k, map) => [...viewOf(k).entries()]
    .map(([docId, data]) => (map || DEFAULT_MAP)(shim(docId, data)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // ⚠絞り込みは PocketBase 版にまだ無い。**黙って全件返すと嘘の一覧になる**ので、
  //   その場で名指しで落とす(Firebase 版は対応しているので、片方だけ違う状態を隠さない)。
  const rejectUnsupported = (ns, col, opts = {}) => {
    const bad = ['where', 'orderBy', 'limit'].filter((n) => opts[n] !== undefined);
    if (bad.length) {
      throw new Error(`PocketBase 版は絞り込み(${bad.join('/')})にまだ対応していません (${ns}/${col})。` +
        '端末側で絞るか、pocketbaseBackend.js に実装してください。**黙って全件返すことはしません。**');
    }
  };

  const emit = (k) => {
    const set = listeners.get(k);
    if (set && set.size) {
      set.forEach((opts, cb) => {
        try { cb(rowsOf(k, opts?.map)); } catch (e) { console.error('[pb] 購読の受け手で例外', e); }
      });
    }
    const m = viewOf(k);
    for (const [dk, dset] of docListeners) {
      if (!dk.startsWith(`${k}/`)) continue;
      const docId = dk.slice(k.length + 1);
      const data = m.has(docId) ? m.get(docId) : null;
      dset.forEach((cb) => { try { cb(data); } catch (e) { console.error('[pb] 購読の受け手で例外', e); } });
    }
  };

  /**
   * サーバから読む。
   * ⚠読めなかった時に例外を投げっぱなしにしない。電波が切れているだけのことがあり、
   *   そこで画面が落ちると「オフラインでは何も見えない」になる。
   *   読めなかったことは loadError に残し、呼び出し側が知りたい時に見られるようにする。
   */
  const ensureLoaded = (ns, col) => {
    const k = keyOf(ns, col);
    if (loaded.has(k)) return Promise.resolve();   // ⚠cache ではなく「読めた印」で判断する
    if (loading.has(k)) return loading.get(k);
    const p = (async () => {
      try {
        // ⚠⚠ログインできていない時に読みに行かせない。
        //   PocketBase の listRule は **絞り込みとして効く** ので、未ログインの一覧取得は
        //   403 ではなく **200 + 0件** が返る。そのまま信じると「全部消えた」画面になる。
        // ⚠この確認は **ログインの結果が出てから** 行う。先に見ると、ログイン中というだけで
        //   「入れていない」と判定してしまう(本物のサーバで実際に落ちた)。
        if (typeof client.whenReady === 'function') { try { await client.whenReady(); } catch { /* 下の確認で出る */ } }
        if (typeof client.isAuthed === 'function' && !client.isAuthed()) {
          throw new Error('まだログインできていません(この0件はデータが無い意味ではありません)');
        }
        const recs = await client.listAll(docsCol, { filter: `ns="${String(ns).replace(/"/g, '\\"')}" && col="${String(col).replace(/"/g, '\\"')}"`, sort: 'docId' });
        const m = new Map(); const rv = new Map();
        recs.forEach((r) => { m.set(r.docId, r.data || {}); rv.set(r.docId, Number(r.rev) || 0); });
        cache.set(k, m); revs.set(k, rv);
        loaded.add(k);
        loadError.delete(k);
      } catch (e) {
        loadError.set(k, e);
        if (!cache.has(k)) cache.set(k, new Map()); // 空でも「見えている」状態にする(見込み値は残る)
        // ⚠loaded には入れない。次に呼ばれたらもう一度読みに行く。
        throw e;
      } finally { emit(k); }
    })().finally(() => loading.delete(k));
    loading.set(k, p);
    return p;
  };
  /** 例外にしないで読む(画面用)。 */
  const softLoad = async (ns, col) => { try { await ensureLoaded(ns, col); } catch { /* loadError に残っている */ } };

  // --- 購読(全体で1本) ------------------------------------------------------
  let closeRealtime = null;
  const startRealtime = () => {
    if (closeRealtime) return;
    closeRealtime = client.openRealtime({
      collections: [docsCol],
      onEvent: ({ action, record }) => {
        if (!record || !record.ns || !record.col) return;
        const k = keyOf(record.ns, record.col);
        if (!loaded.has(k)) return; // まだ読めていないコレクションは無視(読み直しの時に揃う)
        const m = cache.get(k);
        if (!revs.has(k)) revs.set(k, new Map());
        const rv = revs.get(k);
        if (action === 'delete') { m.delete(record.docId); rv.delete(record.docId); }
        else { m.set(record.docId, record.data || {}); rv.set(record.docId, Number(record.rev) || 0); }
        emit(k);
      },
      onError: (e) => console.warn('[pb] 購読が切れました(自動で張り直します)', e?.message || e),
    });
  };
  if (autoRealtime) startRealtime();

  // --- 送信待ちの箱 ----------------------------------------------------------
  const idb = outboxStore || (typeof indexedDB !== 'undefined' ? createIdbStore() : createMemoryStore());
  const outbox = createOutbox({
    store: idb,
    owner,
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    onChange: (s) => { onPendingChange && onPendingChange(s); },
    apply: async (cmd) => {
      // ② 1回だけ効かせる。
      // ⚠⚠ここで「命令の権利」を **書く前に** 取って、再送で「取れなかった=成功」と
      //   みなしてはいけない。書く前に取るので、**書けずに終わった命令まで成功扱いになり、
      //   箱から消える**(実測 2026-07-27: 電波が1回切れただけで保存が黙って消えた)。
      //   → 「効いたかどうか」は書類そのものに押した印(lastCmd)で判断する。
      //     印は中身と同じ1回の書き込みで押すので、ずれようがない。
      const id = cmd.commandId;
      try {
        if (cmd.op === 'remove') await store.remove(cmd.ns, cmd.col, cmd.docId);  // 削除は何度やっても同じ
        else if (cmd.op === 'setFields') await store.setFields(cmd.ns, cmd.col, cmd.docId, cmd.patch, { cmdId: id });
        else if (cmd.op === 'appendCapped') await store.appendCapped(cmd.ns, cmd.col, cmd.docId, cmd.field, cmd.item, { ...(cmd.opts || {}), cmdId: id });
        else await store.save(cmd.ns, cmd.col, cmd.docId, cmd.patch, { ...(cmd.opts || {}), cmdId: id });
        // 送れたら「見込みの値」を下ろす。以後はサーバの中身が正。
        await refreshDoc(cmd.ns, cmd.col, cmd.docId);
        return { ok: true };
      } catch (e) {
        // ⚠⚠「同じ命令IDで中身が違う」は **人が見るまで捨てない**。
        //   通信の失敗として送り直すと、いつまでも通らずやがて FAILED になり、
        //   何が食い違ったのか分からなくなる。衝突と同じ扱いで箱に残す。
        if (e instanceof PbConflictError || e instanceof PbCommandMismatchError) {
          onConflict && onConflict({ cmd, error: e });
          return { conflict: true, detail: e.message };
        }
        throw e;
      }
    },
  });
  const detachOutbox = outbox.attachToWindow();

  // ⚠アプリを閉じて開き直した時、送信待ちの内容を **画面にも戻す**。
  //   これをしないと、オフラインで入力した内容が「箱には残っているのに画面には無い」
  //   という一番たちの悪い状態になる(作業者はもう一度入力してしまう)。
  const rebuilt = (async () => {
    try {
      const rows = await idb.all();
      for (const cmd of rows) {
        if (cmd.status === 'conflict') continue; // ぶつかったものは人が決めるまで反映しない
        if (cmd.op === 'remove') applyLocally(cmd.ns, cmd.col, cmd.docId, () => undefined);
        else if (cmd.op === 'setFields') applyLocally(cmd.ns, cmd.col, cmd.docId, (cur) => setFieldsDoc(cur, cmd.patch));
        else if (cmd.op === 'appendCapped') {
          applyLocally(cmd.ns, cmd.col, cmd.docId, (cur) => ({ ...(cur || cmd.opts?.fallback || {}), [cmd.field]: [...((cur || {})[cmd.field] || []), cmd.item] }));
        } else if (cmd.op === 'save') {
          applyLocally(cmd.ns, cmd.col, cmd.docId, (cur) => (cmd.opts?.merge === false ? overwriteDoc(cmd.patch) : mergeDoc(cur, cmd.patch)));
        }
      }
    } catch (e) { console.warn('[pb] 送信待ちの復元に失敗', e?.message || e); }
  })();

  /**
   * 手元の一覧に「見込みの値」として先に反映する(電波が切れていても画面が進むように)。
   * ⚠まだ読んでいないコレクションでも必ず反映する。ここを飛ばすと、
   *   起動直後にオフラインで保存した内容が画面から消える(実測で踏んだ)。
   */
  const applyLocally = (ns, col, docId, fn) => {
    const k = keyOf(ns, col);
    if (!pending.has(k)) pending.set(k, new Map());
    const p = pending.get(k);
    const view = viewOf(k);
    const next = fn(view.has(docId) ? view.get(docId) : null);
    p.set(docId, next === undefined ? REMOVED : next);
    emit(k);
  };
  /** 送り終わった見込みの値を下ろし、その1件だけサーバから読み直す。 */
  const refreshDoc = async (ns, col, docId) => {
    const k = keyOf(ns, col);
    try {
      const rec = await store.findRecord(ns, col, docId);
      if (cache.has(k)) {
        const m = cache.get(k);
        if (!revs.has(k)) revs.set(k, new Map());
        const rv = revs.get(k);
        if (rec) { m.set(docId, rec.data || {}); rv.set(docId, Number(rec.rev) || 0); }
        else { m.delete(docId); rv.delete(docId); }
      }
    } catch { /* 読めなくても見込みを下ろす。購読の知らせで揃う。 */ }
    const p = pending.get(k);
    if (p) { p.delete(docId); if (!p.size) pending.delete(k); }
    emit(k);
  };

  return {
    kind: 'pocketbase',
    raw: client,
    capabilities: POCKETBASE_CAPABILITIES,
    outbox,
    docStore: store,

    close: () => { if (closeRealtime) closeRealtime(); closeRealtime = null; detachOutbox(); outbox.stop(); },

    /**
     * 手元の一覧をサーバの中身で作り直す。
     * ⚠保存の直後は、手元には「先に反映した見込みの値」が入っている(電波が切れていても
     *   画面が進むように)。サーバ側で埋まる値(サーバ時刻)は、購読の知らせが来るまで
     *   印のままなので、確かめたい時はこれを呼ぶ。
     */
    refresh: async (ns, col) => {
      const k = keyOf(ns, col);
      const q = (v) => String(v).replace(/"/g, '\\"');
      const recs = await client.listAll(docsCol, { filter: `ns="${q(ns)}" && col="${q(col)}"`, sort: 'docId' });
      const m = new Map(); const rv = new Map();
      // ⚠版番号も一緒に覚える。ここを忘れると、オフラインでの全上書きが
      //   ぶつかりを検出できず、復帰時に相手の変更を消す(実測で踏んだ)。
      recs.forEach((r) => { m.set(r.docId, r.data || {}); rv.set(r.docId, Number(r.rev) || 0); });
      cache.set(k, m); revs.set(k, rv);
      loaded.add(k);
      loadError.delete(k);
      emit(k);
      return m.size;
    },

    /** 送信待ちの復元が終わるのを待つ(試験用)。 */
    ready: () => rebuilt,

    // --- 読む ---------------------------------------------------------------
    watchCollection: (ns, col, cb, opts = {}) => {
      rejectUnsupported(ns, col, opts);
      const k = keyOf(ns, col);
      if (!listeners.has(k)) listeners.set(k, new Map());
      listeners.get(k).set(cb, opts);
      startRealtime();
      ensureLoaded(ns, col).catch((e) => {
        // ⚠黙って空にしない。読めていないことを呼び出し側へ伝える。
        if (opts.onError) opts.onError(e); else console.error(`[pb] ${k} を読めませんでした`, e);
      });
      // ⚠最初の通知は **必ず非同期** にする。Firestore の onSnapshot と同じにするため。
      //   同期で呼ぶと、呼び出し側の典型的な書き方
      //     const un = watchCollection(..., rows => { un(); ... })
      //   が「un はまだ初期化されていません」で落ちる。実際にこれで落ちた。
      if (cache.has(k) || pending.has(k)) queueMicrotask(() => { try { cb(rowsOf(k, opts.map)); } catch (e) { console.error(e); } });
      return () => { listeners.get(k)?.delete(cb); };
    },

    watchDoc: (ns, col, id, cb, opts = {}) => {
      const k = keyOf(ns, col);
      const dk = `${k}/${id}`;
      if (!docListeners.has(dk)) docListeners.set(dk, new Set());
      docListeners.get(dk).add(cb);
      startRealtime();
      ensureLoaded(ns, col).catch((e) => { if (opts.onError) opts.onError(e); else console.error(`[pb] ${k} を読めませんでした`, e); });
      // ⚠1件購読も最初の通知は非同期(上と同じ理由)。
      if (cache.has(k) || pending.has(k)) queueMicrotask(() => { const m = viewOf(k); try { cb(m.has(id) ? m.get(id) : null); } catch (e) { console.error(e); } });
      return () => { docListeners.get(dk)?.delete(cb); };
    },

    // ⚠電波が切れていても落とさない。手元にあるもの(サーバの中身⊕見込みの値)を返す。
    //   読めなかった事実は loadErrorOf() で分かるようにしてある。
    getAll: async (ns, col, opts = {}) => {
      rejectUnsupported(ns, col, opts);
      await softLoad(ns, col);
      return rowsOf(keyOf(ns, col), opts.map);
    },

    getOne: async (ns, col, id) => {
      await softLoad(ns, col);
      const m = viewOf(keyOf(ns, col));
      return m.has(id) ? m.get(id) : null;
    },

    /** そのコレクションをサーバから読めなかった理由(読めていれば null)。 */
    loadErrorOf: (ns, col) => loadError.get(keyOf(ns, col)) || null,

    // --- 書く ---------------------------------------------------------------
    save: async (ns, col, id, data, opts = {}) => {
      const patch = withDeletions(data);
      const merge = opts.merge !== false;
      // 全上書きは「見ていた版」を覚えておく。復帰時に相手の変更を黙って消さないため。
      // ⚠電波が切れているとサーバに聞けない。手元で覚えている版番号を使う。
      //   一度も見たことがない書類は版番号が分からない = ぶつかりを検出できない。
      //   その場合は undefined のままにして、**検出できたふりをしない**。
      let baseRev;
      if (!merge) {
        const known = revs.get(keyOf(ns, col))?.get(id);
        if (known !== undefined) baseRev = known;
        else { const rec = await store.findRecord(ns, col, id).catch(() => null); baseRev = rec ? (Number(rec.rev) || 0) : undefined; }
      }
      applyLocally(ns, col, id, (cur) => (merge ? mergeDoc(cur, patch) : overwriteDoc(patch)));
      return outbox.enqueue({ op: 'save', ns, col, docId: id, patch, opts: { merge, baseRev } });
    },

    remove: async (ns, col, id) => {
      applyLocally(ns, col, id, () => undefined);
      return outbox.enqueue({ op: 'remove', ns, col, docId: id });
    },

    setFields: async (ns, col, id, fields) => {
      const patch = withDeletions(fields);
      applyLocally(ns, col, id, (cur) => setFieldsDoc(cur, patch));
      return outbox.enqueue({ op: 'setFields', ns, col, docId: id, patch });
    },

    // --- 割り込まれない書き込み -----------------------------------------------
    // ⚠権利取りは **送信待ちに入れない**。オフラインで「取れた」ことにすると、
    //   復帰後に他の端末と二重に通知を送る。つながっていない時は取れない、が正しい。
    claimOnce: (ns, col, id, expect, patch) => store.claimOnce(ns, col, id, expect, patch),

    appendCapped: async (ns, col, id, field, item, opts = {}) =>
      outbox.enqueue({ op: 'appendCapped', ns, col, docId: id, field, item, opts }),
  };
};

export { STATUS as OUTBOX_STATUS, PbConflictError };
