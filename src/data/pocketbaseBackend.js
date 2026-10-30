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

import { createDocStore, PbConflictError, PbCommandMismatchError, DOCS_COL, assertWritableDocKey, PbBadDocIdError } from './pbDocStore.js';
import { createOutbox, createIdbStore, createMemoryStore, STATUS } from './outbox.js';
import { mergeDoc, overwriteDoc, setFieldsDoc } from './docMerge.js';
import { withDeletions, DATA_SERVER_NOW } from './sentinels.js';
import { POCKETBASE_CAPABILITIES } from './capabilities.js';
import { applyQuery } from './queryLocal.js';
import { pbFilter } from './pbFilter.js';

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

  // ⚠⚠絞り込み・並び替え・件数制限は **端末側で行う**。
  //   PocketBase の購読はフィルタが効かない(実測 v0.39.9)ので、全部手元に持ってから絞る。
  //   規則は Firestore と1件ずつ突き合わせてある(scripts/verify-query-parity.mjs で18件合格)。
  //   ⚠並びは「書類IDの文字列順」ではなく **Firestore の決まり** に従う(applyQuery が面倒を見る)。
  const docsOf = (k, spec) => applyQuery(
    [...viewOf(k).entries()].map(([docId, data]) => shim(docId, data)),
    spec || {},
  );
  const rowsOf = (k, map, spec) => docsOf(k, spec).map((d) => (map || DEFAULT_MAP)(d));

  // ⚠⚠購読の受け手には **第2引数** も渡す。
  //   Firebase 版は cb(rows, snap) / cb(data, snap) と、Firestore の生の snapshot を渡している。
  //   画面はそれを当てにして snap.exists() や snap.docs.forEach(d => d.data()) と書いている箇所がある。
  //   PocketBase 版が第2引数を渡さないと **その購読だけが毎回例外で死ぬ**。しかも受け手の例外は
  //   握られてログに出るだけなので、画面は「エラーも出ないのに、設定が空・写真が出ない」になる。
  //   実測 2026-07-28(実画面の通し試験): 設定の購読が snap.exists() で落ち、設定がずっと空のままだった。
  //   → Firestore の QuerySnapshot / DocumentSnapshot と **同じ呼び方ができる見せかけ** を渡す。
  //   ⚠snapshot の中身は **絞り込んだ後** の書類だけ(Firestore と同じ)。全件を渡すと
  //     snap.docs を使っている画面が、絞り込みを無視した一覧を作ってしまう。
  const querySnapOf = (k, spec) => {
    const docs = docsOf(k, spec);
    return {
      docs,
      size: docs.length,
      empty: docs.length === 0,
      forEach: (fn, thisArg) => docs.forEach((d, i) => fn.call(thisArg, d, i, docs)),
      // 手元のものを見せている=常に「確定」ではない。Firestore と同じ名前で持たせる。
      metadata: { fromCache: !loaded.has(k), hasPendingWrites: (pending.get(k)?.size || 0) > 0 },
    };
  };
  const docSnapOf = (k, docId) => {
    const m = viewOf(k);
    const has = m.has(docId);
    return {
      id: docId,
      exists: () => has,
      data: () => (has ? m.get(docId) : undefined),
      metadata: { fromCache: !loaded.has(k), hasPendingWrites: pending.get(k)?.has(docId) || false },
    };
  };

  /** opts のうち「絞り込みの指定」だけを取り出す。 */
  const specOf = (opts = {}) => ({ where: opts.where, orderBy: opts.orderBy, limit: opts.limit, after: opts.after });

  const emit = (k) => {
    const set = listeners.get(k);
    if (set && set.size) {
      // ⚠受け手ごとに絞り込みが違う(同じ lots を「新しい順500件」と「未完了だけ」で
      //   2本購読している画面がある)。**1つの snapshot を使い回してはいけない。**
      set.forEach((opts, cb) => {
        try { cb(rowsOf(k, opts?.map, specOf(opts)), querySnapOf(k, specOf(opts))); }
        catch (e) { console.error('[pb] 購読の受け手で例外', e); }
      });
    }
    const m = viewOf(k);
    for (const [dk, dset] of docListeners) {
      if (!dk.startsWith(`${k}/`)) continue;
      const docId = dk.slice(k.length + 1);
      const data = m.has(docId) ? m.get(docId) : null;
      const snap = docSnapOf(k, docId);
      dset.forEach((cb) => { try { cb(data, snap); } catch (e) { console.error('[pb] 購読の受け手で例外', e); } });
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
        // 🔒R19: 値は pbFilter で入れる(「\」も直す・以前は「"」だけで、値に「\」があると読めない/別の物を読んだ)
        const recs = await client.listAll(docsCol, { filter: pbFilter('ns={:ns} && col={:col}', { ns, col }), sort: 'docId' });
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
        // R28: 前の版で箱に入った NUL 入りの書類の場所も、送り直さずに人が見るまで残す(何度送っても通らない)
        if (e instanceof PbConflictError || e instanceof PbCommandMismatchError || e instanceof PbBadDocIdError) {
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
  /** 送信待ちを通さずに書いた1件を、手元の一覧(cache)にだけ読み直す。⚠見込みの値(pending)は触らない。
   *  (refreshDoc は見込みの値を下ろすので、送信待ちに同じ書類の保存が残っている時に使うと画面から消える) */
  const reloadDoc = async (ns, col, docId) => {
    const k = keyOf(ns, col);
    if (!cache.has(k)) return;   // まだ読んでいない一覧は、読む時にサーバから揃う
    try {
      const rec = await store.findRecord(ns, col, docId);
      const m = cache.get(k);
      if (!revs.has(k)) revs.set(k, new Map());
      const rv = revs.get(k);
      if (rec) { m.set(docId, rec.data || {}); rv.set(docId, Number(rec.rev) || 0); }
      else { m.delete(docId); rv.delete(docId); }
      emit(k);
    } catch { /* 読めなくても購読の知らせで揃う */ }
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
      const recs = await client.listAll(docsCol, { filter: pbFilter('ns={:ns} && col={:col}', { ns, col }), sort: 'docId' });
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
      if (cache.has(k) || pending.has(k)) queueMicrotask(() => { try { cb(rowsOf(k, opts.map, specOf(opts)), querySnapOf(k, specOf(opts))); } catch (e) { console.error(e); } });
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
      if (cache.has(k) || pending.has(k)) queueMicrotask(() => { const m = viewOf(k); try { cb(m.has(id) ? m.get(id) : null, docSnapOf(k, id)); } catch (e) { console.error(e); } });
      return () => { docListeners.get(dk)?.delete(cb); };
    },

    // ⚠電波が切れていても落とさない。手元にあるもの(サーバの中身⊕見込みの値)を返す。
    //   読めなかった事実は loadErrorOf() で分かるようにしてある。
    getAll: async (ns, col, opts = {}) => {
      await softLoad(ns, col);
      return rowsOf(keyOf(ns, col), opts.map, specOf(opts));
    },

    // --- 絞り込み付きの読み(製品検査・部品検査が使う) ------------------------
    // ⚠Firebase 版はサーバ側で絞る。こちらは全部読んでから端末で絞る。
    //   **返る中身と並びは同じ**であることを scripts/verify-query-parity.mjs で確かめてある。
    //   通信量は増える(全件読む)。PocketBase は社内サーバなので回線は太い、が
    //   「同じつもりで違う」を避けるほうが大事。
    watchQuery: (ns, col, spec = {}, cb, opts = {}) => {
      const k = keyOf(ns, col);
      const merged = { ...opts, ...spec };
      if (!listeners.has(k)) listeners.set(k, new Map());
      listeners.get(k).set(cb, merged);
      startRealtime();
      ensureLoaded(ns, col).catch((e) => {
        if (opts.onError) opts.onError(e); else console.error(`[pb] ${k} を読めませんでした`, e);
      });
      if (cache.has(k) || pending.has(k)) {
        queueMicrotask(() => { try { cb(rowsOf(k, opts.map, spec), querySnapOf(k, spec)); } catch (e) { console.error(e); } });
      }
      return () => { listeners.get(k)?.delete(cb); };
    },

    /**
     * 1ページ分を取る。戻りの cursor を次の spec.after に渡すと続きが取れる。
     * ⚠cursor は保管庫が決める「続きの位置」。中身を画面が解釈してはいけない。
     */
    getPage: async (ns, col, spec = {}, opts = {}) => {
      await softLoad(ns, col);
      const k = keyOf(ns, col);
      const docs = docsOf(k, spec);
      const map = opts.map || DEFAULT_MAP;
      return { rows: docs.map(map), cursor: docs.length ? docs[docs.length - 1] : null };
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
      // 🔒 R28: NUL 入り・空の書類の場所は、手元にも送信待ちの箱にも入れずに断る(箱に残って何度も失敗し続けない)
      assertWritableDocKey(ns, col, id);
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
      assertWritableDocKey(ns, col, id);   // R28
      const patch = withDeletions(fields);
      applyLocally(ns, col, id, (cur) => setFieldsDoc(cur, patch));
      return outbox.enqueue({ op: 'setFields', ns, col, docId: id, patch });
    },

    // --- 割り込まれない書き込み -----------------------------------------------
    // ⚠権利取りは **送信待ちに入れない**。オフラインで「取れた」ことにすると、
    //   復帰後に他の端末と二重に通知を送る。つながっていない時は取れない、が正しい。
    claimOnce: (ns, col, id, expect, patch) => store.claimOnce(ns, col, id, expect, patch),

    appendCapped: async (ns, col, id, field, item, opts = {}) => {
      assertWritableDocKey(ns, col, id);   // R28
      return outbox.enqueue({ op: 'appendCapped', ns, col, docId: id, field, item, opts });
    },

    // ========================================================================
    // 2026-10-29 社内サーバ移行の準備: Firebase 版にあって、こちらに無かった操作。
    //   無いと窓口(provider.js)が「保管庫 pocketbase は … に対応していません」で投げ、
    //   画面のその機能(計画の版の一覧・保存・移動案・到着予定の自動反映・写真の整理など)が止まっていた。
    //   製品・最終・部品の3アプリが同じ日に別々に足した物を1つにまとめた(src/data は4アプリで同じ中身)。
    //   ⚠⚠ 下は **送信待ちの箱に入れない**(権利取りと同じ)。Firebase 版も取引・サーバへの問い合わせなので
    //     電波が無ければ失敗する。オフラインで「できた」ことにしない。
    // ⚠getCachedDocs / refreshDocFromServer(前回の続きだけ読む)は **作らない**。
    //   こちらは最初から全部を手元に持つので要らない。呼べば窓口が「対応していません」で止める
    //   (ロットの差分読みは lots が firebase の時だけ動くよう画面側で守ってある)。
    // ========================================================================

    /**
     * 📉 項目を選んで読む(Firebase 版は REST で重い項目を運ばない)。
     * ⚠PocketBase は手元に全部持ってから絞る作りなので、**項目は選ばない**(全項目の行を返す)。
     *   その事を projected:false と fellBack で必ず言う(黙って「選べた」ことにしない)。
     *   Firebase 版が全件読みへ落ちた時と同じ形。⚠projected:true にすると、呼ぶ側が
     *   「REST で読んだ = Firestore の読み取り」として数えてしまう(最終の写真の整理)。
     * ⚠絞り込み・並び・件数・続き(after = 前のページの最後の書類ID・__name__ の並びの時)は効かせる。
     * ⚠サーバから読めていなければ fromCache:true(呼び元は「読めなかった」として扱う決まり・Firebase 版と同じ)。
     * ⚠getToken は呼ばない(PocketBase のログインは窓口の中で済んでいる)。
     */
    getPageFields: async (ns, col, fields = [], opts = {}) => {
      await softLoad(ns, col);
      const k = keyOf(ns, col);
      const after = opts.after == null ? undefined
        : (typeof opts.after === 'object' ? opts.after : { id: String(opts.after), data: {} });
      const rows = rowsOf(k, null, { where: opts.where, orderBy: opts.orderBy, limit: opts.limit, after });
      const n = Array.isArray(fields) ? fields.length : 0;
      return {
        rows, projected: false,
        fellBack: n ? `PocketBase は手元の一覧から返します(指定の${n}項目に絞らず全項目)` : '取る項目が指定されていません',
        fromCache: !loaded.has(k),
      };
    },

    /**
     * 📉 件数だけ数える。
     * ⚠サーバから読めていない時は **数えない(投げる)**。手元の0件を「0件」と答えると、
     *   呼ぶ側の「控えとサーバの件数が合っている」の判定が嘘になる。
     */
    countQuery: async (ns, col, spec = {}) => {
      await ensureLoaded(ns, col);
      return docsOf(keyOf(ns, col), specOf(spec)).length;
    },

    /**
     * 無い時だけ作る。在れば何も書かず taken。updatedAt はサーバ時刻の印(Firebase 版と同じ)。
     * ⚠docs の UNIQUE(ns,col,docId) への create がそのまま「1台だけ」の門になる(pbDocStore.createOnce)。
     */
    createOnce: async (ns, col, id, doc) => {
      const r = await store.createOnce(ns, col, id, withDeletions({ ...(doc || {}), updatedAt: DATA_SERVER_NOW }));
      if (r.acquired) await reloadDoc(ns, col, id);
      return r;
    },

    /**
     * 「入れた印」がまだなら、本体を直してから印を書く。
     * ⚠⚠ Firebase 版は1つの取引。PocketBase には複数の書類をまとめる取引が無い(batch API は既定で無効)。
     *   ここでは **本体 → 印** の順に書く。途中で落ちても「印だけ残る」は起きない
     *   (印が無ければ次の変化でもう一度試す = 2026-08-31 の決まりと同じ向き)。
     *   2台が同時に来ると両方が同じ値を書くことはある(値は同じなので壊れない。書き込みが1件増えるだけ)。
     * ⚠本体が無い時は Firebase 版(tx.update)と同じく投げる。呼ぶ側が今までの道へ落とす。
     */
    applyWithMark: async (ns, col, id, { done, markPatch, targetCol, targetId, targetPatch } = {}) => {
      const markRec = await store.findRecord(ns, col, id);
      const cur = markRec ? (markRec.data || {}) : null;
      if (typeof done === 'function' && done(cur)) return { applied: false, reason: 'done' };
      if (targetCol && targetId != null && targetPatch) {
        await store.setFields(ns, targetCol, targetId, withDeletions({ ...targetPatch, updatedAt: DATA_SERVER_NOW }));
        await reloadDoc(ns, targetCol, targetId);
      }
      await store.save(ns, col, id, withDeletions({ ...(markPatch || {}), updatedAt: DATA_SERVER_NOW }), { merge: true });
      await reloadDoc(ns, col, id);
      return { applied: true, reason: 'ok' };
    },

    /** 版を足して head を進める(作り方は pbDocStore.commitVersion)。⚠送信待ちに入れない。 */
    commitVersion: async (ns, args) => {
      const r = await store.commitVersion(ns, args);
      if (r && r.ok) {
        await reloadDoc(ns, args.headCol, args.headId);
        await reloadDoc(ns, args.versionCol, args.versionId);
        for (const c of (args.chunks || [])) await reloadDoc(ns, args.versionCol, c.id);
      }
      return r;
    },

    /**
     * 写真・資料を上げて、表示に使う URL を返す(点検 G3)。PocketBase の blobs(ファイル列 file)へ。
     * @param col      置き場の領域を決めるためのコレクション名(窓口の振り分けに使う)
     * @param pathHint Firebase Storage の時の置き場所の名前(template-images など)
     * @param dataUrl  data:...;base64,...
     * ⚠送信待ちに入れない(大きい物を IndexedDB に溜めない)。失敗は投げる(呼び元が今まで通り扱う)。
     */
    uploadFile: async (ns, col, pathHint, dataUrl, opts = {}) => {
      const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
      if (!m) throw new Error('data URL ではありません');
      const mime = m[1] || 'application/octet-stream';
      const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      const ext = String(opts.ext || (mime.split('/')[1] || 'bin')).replace(/[^a-z0-9]/gi, '') || 'bin';
      const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
      const fd = new FormData();
      fd.append('ns', ns);
      fd.append('col', col);
      fd.append('docId', `${pathHint || 'files'}/${fileId}`);
      fd.append('fieldPath', JSON.stringify([pathHint || 'files']));
      fd.append('order', '0');
      fd.append('filename', fileId);
      fd.append('mime', mime);
      fd.append('bytes', String(bytes.length));
      fd.append('sha256', '');
      fd.append('file', new Blob([bytes], { type: mime }), fileId);
      const rec = await client.create(opts.filesCol || 'blobs', fd);
      const name = rec && (Array.isArray(rec.file) ? rec.file[0] : rec.file);
      if (!rec || !rec.id || !name) throw new Error('上げたファイルの名前が返ってきませんでした');
      // 🏢 2026-10-30 記録に残すのは住所を含まない形(画面と PB が同じ口の時)。住所を変えても写真が切れない。
      return (client.storedFileUrl || client.fileUrl)(rec.collectionName || opts.filesCol || 'blobs', rec.id, name);
    },
  };
};

export { STATUS as OUTBOX_STATUS, PbConflictError };
