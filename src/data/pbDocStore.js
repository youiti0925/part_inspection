// ============================================================================
// PocketBase の中の「1つの書類」を Firestore と同じ規則で読み書きする
// ----------------------------------------------------------------------------
// ⚠⚠ここが移行で一番危ないところ。
//   Firestore は「読んで→書く」をトランザクションで守れるが、PocketBase には無い。
//   守らないと、2台が同じロットを同時に保存したときに
//   **後から書いた側が相手の変更を丸ごと消す**。
//
// 実測(v0.39.9・2026-07-26):
//   ✗ サーバ側フックで rev を見比べる方式 → 2台同時で **100回中98回、両方通った**
//     (両方のフックが同じ rev を読んでから書くため。証拠 evidence-revguard-hook-FAILED.json)
//   ✓ claims コレクションの **UNIQUE インデックスへの create** → 10台×100回で
//     常に勝者ちょうど1台(証拠 evidence-pocketbase.json)
//
//   → 「rev を R から R+1 へ進める権利」を UNIQUE の門で1台だけに渡す。
//     門を通った端末だけが書く。通れなかった端末は読み直してやり直す。
//
// ⚠⚠ **門を取ったあとに書けなかった時の後始末が要る。**(2026-07-27 の点検で判明)
//   電波が1回切れただけで次の2つが同時に起きていた:
//     ・門を取ったまま返さない → 誰もその rev を二度と取れない
//       = **その書類は以後どの端末からも保存できなくなる**(実測で再現)
//     ・送信待ちの箱が「この命令はもう受け付け済み」と判断して箱から消す
//       = **一度も書けていないのに「保存できました」になる**(実測で再現)
//   直し方は3つ:
//     ① 書けなかったら門を返す(自分が取った門だけ)
//     ② 端末ごと落ちて返せなかった門は、**古くなったら誰でも外せる**(既定60秒)
//     ③ 「効いたかどうか」は門ではなく **書類に押した命令の印(lastCmd)** で判断する
//        → 返事が届かなかっただけの時に二度書きしない
//   ⚠①②のために門は claims から **doc_gates** へ分けた。claims(通知の二重送信よけ)は
//     消せてはいけないので、消せる入れ物を混ぜない。
// ============================================================================

import { mergeDoc, overwriteDoc, setFieldsDoc } from './docMerge.js';
import { claimOnce, PbHttpError, PbNetworkError } from './pbClient.js';
import { commandHash } from './payloadHash.js';

export const DOCS_COL = 'docs';
export const CLAIMS_COL = 'claims';
/** rev を進める権利の入れ物。⚠claims と分ける(あちらは消せてはいけない)。 */
export const GATES_COL = 'doc_gates';
/** これより古い門は「端末が落ちて返せなかったもの」とみなして外す。 */
export const STALE_GATE_MS = 60 * 1000;

/** 書類の場所を1つの文字列にする(門の名前に使う)。 */
export const docKey = (ns, col, docId) => `${ns}/${col}/${docId}`;

/**
 * 同じ命令IDなのに中身が違う。**捨てずに止める**ための知らせ。
 * ⚠ここを「もう効いた」と扱うと、中身の違う保存が黙って消える。
 */
export class PbCommandMismatchError extends Error {
  constructor(key, cmdId, want, got) {
    super(`同じ命令ID(${cmdId})で中身が違います: ${key}。取り違えを避けるため保存しませんでした(記録済み=${got} / 今回=${want})`);
    this.name = 'PbCommandMismatchError';
    this.key = key; this.cmdId = cmdId; this.wantHash = want; this.gotHash = got;
  }
}

/**
 * 「もう効いているか」を **命令IDと中身の指紋の両方** で判定する。
 * @returns 'applied'(効いている) | 'fresh'(まだ) — 中身違いは投げる
 */
export const appliedState = (rec, cmdId, hash, key) => {
  if (!cmdId || !rec || rec.lastCmd !== cmdId) return 'fresh';
  // ⚠指紋が記録されていない古い書類は、IDの一致だけで「効いた」とする(移行直後の互換)。
  if (rec.lastCmdHash && hash && rec.lastCmdHash !== hash) {
    throw new PbCommandMismatchError(key, cmdId, hash, rec.lastCmdHash);
  }
  return 'applied';
};

/** 衝突の知らせ。⚠通信の失敗と混ぜない。 */
export class PbConflictError extends Error {
  constructor(key, currentRev, baseRev) {
    super(`他の端末が先に保存しました: ${key}(今 rev=${currentRev} / こちらの元 rev=${baseRev})`);
    this.name = 'PbConflictError';
    this.key = key; this.currentRev = currentRev; this.baseRev = baseRev;
  }
}

export const createDocStore = (client, {
  docsCol = DOCS_COL, claimsCol = CLAIMS_COL, gatesCol = GATES_COL,
  maxAttempts = 12, owner = '', staleGateMs = STALE_GATE_MS, now = () => Date.now(),
} = {}) => {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  const filterOf = (ns, col, docId) =>
    `ns="${esc(ns)}" && col="${esc(col)}"` + (docId === undefined ? '' : ` && docId="${esc(docId)}"`);

  const findRecord = async (ns, col, docId) => {
    const r = await client.listPage(docsCol, { perPage: 1, filter: filterOf(ns, col, docId) });
    return r.items?.[0] || null;
  };

  const gateScope = (ns, col, docId) => `doc:${docKey(ns, col, docId)}`;

  /**
   * 「rev を R → R+1 へ進める権利」を1台だけに渡す門。
   * @returns {acquired, reason, recordId} reason は 'ok' | 'taken' | 'error'
   */
  const gate = (ns, col, docId, rev) =>
    claimOnce(client, gateScope(ns, col, docId), `rev:${rev}`, { owner, collection: gatesCol });

  /**
   * 取った門を返す。⚠**自分が取った1件だけ**を消す(recordId を指定して消す)。
   * 返せなくても致命ではない(古くなれば下の releaseStaleGate が外す)ので、
   * ここで例外を投げて保存の失敗理由を上書きしない。
   */
  const releaseGate = async (recordId) => {
    if (!recordId) return false;
    try { await client.remove(gatesCol, recordId); return true; }
    catch (e) { console.warn('[pb] 門を返せませんでした(古くなれば自動で外れます)', e?.message || e); return false; }
  };

  /**
   * 端末ごと落ちて返せなかった門を外す。
   * ⚠**新しい門は絶対に外さない。** 書く直前に取った門を外すと、同じ rev をもう一度
   *   取れてしまい、相手の書き込みを消せるようになる。だから古いものだけ。
   * @returns 外したら true(呼び出し側はもう一度やり直す)
   */
  const releaseStaleGate = async (ns, col, docId, rev) => {
    try {
      const r = await client.listPage(gatesCol, {
        perPage: 1, filter: `scope="${esc(gateScope(ns, col, docId))}" && claimId="rev:${rev}"`,
      });
      const g = r.items?.[0];
      if (!g) return false;                       // もう外れている → やり直せば通る
      const age = now() - Date.parse(String(g.created || '').replace(' ', 'T') + (String(g.created || '').endsWith('Z') ? '' : 'Z'));
      if (!Number.isFinite(age) || age < staleGateMs) return false;
      await client.remove(gatesCol, g.id);
      console.warn(`[pb] 返されないまま古くなった門を外しました(${gateScope(ns, col, docId)} rev:${rev} / ${Math.round(age / 1000)}秒前)`);
      return true;
    } catch { return false; }                     // 消せなくても保存の失敗理由を上書きしない
  };

  /**
   * 中身を書く。Firestore の setDoc と同じ意味になるようにする。
   * @param opts.merge     false なら全上書き(既定 true)
   * @param opts.baseRev   これを渡すと「その rev から進める時だけ書く」。
   *                       違っていれば PbConflictError。オフラインから復帰した
   *                       全上書きの保存で、相手の変更を黙って消さないために使う。
   * @param opts.cmdId     送信待ちの箱の命令ID。書類に印として一緒に押す。
   *                       返事が届かずにもう一度送っても、二度は効かない。
   * @returns {rev, rebased, created, alreadyApplied}
   */
  const write = async (ns, col, docId, patch, opts = {}) => {
    const merge = opts.merge !== false;
    const key = docKey(ns, col, docId);
    const cmdId = opts.cmdId || null;
    // ⚠⚠「もう効いたか」は **命令ID + 中身の指紋** の両方で見る。
    //   IDだけだと、IDがかぶった時に中身の違う保存を黙って捨ててしまう。
    const cmdHash = cmdId ? commandHash({ op: 'save', ns, col, docId, patch, opts }) : null;
    // 適用済みの記録は **中身と同じ1回の書き込み** に混ぜる(下の update / create を参照)。
    // 別々に書くと「中身は入ったのに記録が無い」「記録だけある」がいつか起きる。
    const stamp = cmdId ? { lastCmd: cmdId, lastCmdHash: cmdHash, lastCmdAt: new Date(now()).toISOString() } : {};
    let lastSeenRev = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cur = await findRecord(ns, col, docId);
      const rev = cur ? (Number(cur.rev) || 0) : 0;
      lastSeenRev = rev;

      // ⚠この命令は既に効いている(返事が届かなかっただけ)。二度書きしない。
      //   中身が違えば「効いた」とせず、捨てずに止める(PbCommandMismatchError)。
      if (appliedState(cur, cmdId, cmdHash, key) === 'applied') {
        return { rev, rebased: attempt > 0, created: false, alreadyApplied: true };
      }

      // ⚠全上書きで、見ていた版が変わっていたら **書かずに知らせる**。
      //   ここを黙って上書きすると、オフライン復帰のたびに相手の作業が消える。
      if (opts.baseRev !== undefined && opts.baseRev !== null && Number(opts.baseRev) !== rev) {
        if (!merge) throw new PbConflictError(key, rev, Number(opts.baseRev));
        // 重ねる保存は、今の中身の上に重ね直すのが Firestore と同じ意味になる
        // (送ったキーだけが変わり、他は触らない)。これは「黙って上書き」ではない。
      }

      // ⚠⚠ **新規作成に門を付けてはいけない。**
      //   docs には UNIQUE(ns,col,docId) があるので、2台が同時に作れば片方が必ず落ちる
      //   = 作成はそれだけで1台に決まる。ここに rev:0 の門を足すと、
      //   **書類を消して同じIDで作り直したときに、前回の rev:0 の権利が残っていて
      //     二度と作れなくなる**(現場では指図番号の再登録で起きる)。実際にこれで詰まった。
      if (!cur) {
        try {
          const body = merge ? mergeDoc(null, patch) : overwriteDoc(patch);
          await client.create(docsCol, { ns, col, docId, data: body, rev: 1, sourceUpdatedAt: null, ...stamp });
          return { rev: 1, rebased: attempt > 0, created: true };
        } catch (e) {
          if (e instanceof PbHttpError && e.isUnique) continue; // 同じ瞬間に別の端末が作った → 読み直す
          throw e;
        }
      }

      const g = await gate(ns, col, docId, rev);
      if (!g.acquired) {
        // 他の端末が先に進めた → 読み直す。ただし「取ったまま返さずに落ちた門」なら外す。
        if (g.reason === 'taken') { await releaseStaleGate(ns, col, docId, rev); continue; }
        throw g.error || new Error('権利の取得に失敗しました');  // ⚠通信/認証の失敗は握り潰さない
      }

      try {
        const body = merge ? mergeDoc(cur.data, patch) : overwriteDoc(patch);
        await client.update(docsCol, cur.id, { data: body, rev: rev + 1, ...stamp });
        return { rev: rev + 1, rebased: attempt > 0, created: false };
      } catch (e) {
        // ⚠⚠書けなかったら **門を必ず返す**。返さないとこの書類は二度と保存できない。
        //   重ねる保存・全上書きは何度やっても同じ結果なので、返して安全。
        //   (返した後に「実は届いていた」場合は lastCmd の印で二度書きを防ぐ)
        await releaseGate(g.recordId);
        if (e instanceof PbHttpError && e.isUnique) continue;
        throw e;
      }
    }
    throw new Error(`保存が${maxAttempts}回やり直しても通りませんでした(${key} 最後に見た rev=${lastSeenRev})。他の端末が連続して保存している可能性があります。`);
  };

  return {
    findRecord,
    docKey,

    getOne: async (ns, col, docId) => {
      const r = await findRecord(ns, col, docId);
      return r ? r.data : null;
    },

    getAll: async (ns, col) => {
      const rows = await client.listAll(docsCol, { filter: filterOf(ns, col), sort: 'docId' });
      return rows.map((r) => ({ ...(r.data || {}), id: r.docId }));
    },

    save: write,

    /** 指定した項目だけを丸ごと差し替える(Firestore の updateDoc と同じ)。 */
    setFields: async (ns, col, docId, fields, opts = {}) => {
      const key = docKey(ns, col, docId);
      const cmdId = opts.cmdId || null;
      const cmdHash = cmdId ? commandHash({ op: 'setFields', ns, col, docId, patch: fields }) : null;
      const stamp = cmdId ? { lastCmd: cmdId, lastCmdHash: cmdHash, lastCmdAt: new Date(now()).toISOString() } : {};
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cur = await findRecord(ns, col, docId);
        if (!cur) throw new Error(`対象がありません: ${key}`);
        if (appliedState(cur, cmdId, cmdHash, key) === 'applied') return { rev: Number(cur.rev) || 0, alreadyApplied: true };
        const rev = Number(cur.rev) || 0;
        const g = await gate(ns, col, docId, rev);
        if (!g.acquired) {
          if (g.reason === 'taken') { await releaseStaleGate(ns, col, docId, rev); continue; }
          throw g.error || new Error('権利の取得に失敗しました');
        }
        try {
          await client.update(docsCol, cur.id, { data: setFieldsDoc(cur.data, fields), rev: rev + 1, ...stamp });
        } catch (e) { await releaseGate(g.recordId); throw e; }  // ⚠門を返す(項目の差し替えは何度やっても同じ結果)
        return { rev: rev + 1 };
      }
      throw new Error(`項目の差し替えが${maxAttempts}回やり直しても通りませんでした(${key})`);
    },

    remove: async (ns, col, docId) => {
      const cur = await findRecord(ns, col, docId);
      // ⚠書類を消したら、その書類の権利の記録も一緒に片付ける。
      //   残しておくと、同じIDで作り直したときに古い権利が邪魔をする。
      //   (書類が無ければ権利だけ残っている可能性があるので、いずれにせよ片付ける)
      //   ここで消せなくても困らない: **新規作成に門は付いていない**ので、
      //   同じIDで作り直すのは通る。
      const scope = gateScope(ns, col, docId);
      try {
        const rows = await client.listAll(gatesCol, { filter: `scope="${esc(scope)}"`, fields: 'id' });
        for (const r of rows) await client.remove(gatesCol, r.id);
      } catch (e) {
        if (!(e instanceof PbHttpError && (e.status === 403 || e.status === 401))) {
          console.warn('[pb] 門の記録を片付けられませんでした', e?.message || e);
        }
      }
      if (!cur) return { removed: false };
      await client.remove(docsCol, cur.id);
      return { removed: true };
    },

    /**
     * 配列に足して、上限を超えたら古い方から落とす。
     * ⚠「読んで→足して→丸ごと書き戻す」を守らないと、2台が同時に足したとき
     *   後から書いた側が相手の1件を消す。門を通ってから書く。
     */
    appendCapped: async (ns, col, docId, field, item, { maxBytes = 900 * 1024, fallback = {}, cmdId = null } = {}) => {
      const key = docKey(ns, col, docId);
      const cmdHash = cmdId ? commandHash({ op: 'appendCapped', ns, col, docId, field, item }) : null;
      const stamp = cmdId ? { lastCmd: cmdId, lastCmdHash: cmdHash, lastCmdAt: new Date(now()).toISOString() } : {};
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cur = await findRecord(ns, col, docId);
        // ⚠追記は「何度やっても同じ」ではない。命令の印と中身の指紋で二度足しを止める。
        if (appliedState(cur, cmdId, cmdHash, key) === 'applied') {
          return { count: ((cur.data || {})[field] || []).length, dropped: 0, alreadyApplied: true };
        }
        const rev = cur ? (Number(cur.rev) || 0) : 0;
        const g = await gate(ns, col, docId, rev);
        if (!g.acquired) {
          if (g.reason === 'taken') { await releaseStaleGate(ns, col, docId, rev); continue; }
          throw g.error || new Error('権利の取得に失敗しました');
        }

        const base = cur ? (cur.data || {}) : fallback;
        let arr = [...((base && base[field]) || []), item];
        let dropped = 0;
        while (arr.length > 1 && JSON.stringify(arr).length > maxBytes) { arr = arr.slice(1); dropped++; }

        try {
          if (!cur) {
            // ⚠消えていた場合は中身ごと作り直す。field だけ書くと名前なしの幽霊になる。
            await client.create(docsCol, { ns, col, docId, data: { ...fallback, [field]: arr }, rev: 1, ...stamp });
          } else {
            await client.update(docsCol, cur.id, { data: { ...base, [field]: arr }, rev: rev + 1, ...stamp });
          }
          return { count: arr.length, dropped };
        } catch (e) {
          // ⚠追記は二度やると1件増える。**命令の印がある時だけ門を返す**
          //   (印があれば、届いていた場合に上の判定で止まる)。
          //   印が無い呼び方では返さない = 古くなってから自動で外れるのを待つ。
          if (cmdId) await releaseGate(g.recordId);
          if (e instanceof PbHttpError && e.isUnique) continue;
          throw e;
        }
      }
      throw new Error(`追記が${maxAttempts}回やり直しても通りませんでした(${key})`);
    },

    /**
     * 期待した状態のままなら patch を書く(1台だけが権利を取る)。
     * @returns {acquired, reason} reason は 'ok' | 'taken' | 'missing' | 'error'
     * ⚠通信失敗・認証失敗・サーバーエラーを「取られた」と同じ扱いにしない。
     */
    claimOnce: async (ns, col, docId, expect, patch) => {
      try {
        const cur = await findRecord(ns, col, docId);
        if (!cur) return { acquired: false, reason: 'missing' };
        const data = cur.data || {};
        for (const [k, v] of Object.entries(expect || {})) {
          // ⚠数で期待する項目は欠落を0とみなす。0 を null に潰すと永久ロックになる。
          const got = typeof v === 'number' ? (Number(data[k]) || 0) : (data[k] ?? null);
          if (got !== v) return { acquired: false, reason: 'taken' };
        }
        const rev = Number(cur.rev) || 0;
        const g = await gate(ns, col, docId, rev);
        if (!g.acquired) return { acquired: false, reason: g.reason === 'taken' ? 'taken' : 'error', error: g.error };
        try {
          await client.update(docsCol, cur.id, { data: mergeDoc(data, patch), rev: rev + 1 });
        } catch (e) {
          // ⚠門を返す。返さないとこの書類は以後どの端末からも保存できなくなる。
          //   もう一度呼ばれても expect の照合が先に走るので、二重には効かない。
          await releaseGate(g.recordId);
          throw e;
        }
        return { acquired: true, reason: 'ok' };
      } catch (e) {
        if (e instanceof PbNetworkError || e instanceof PbHttpError) return { acquired: false, reason: 'error', error: e };
        return { acquired: false, reason: 'error', error: e };
      }
    },

    /**
     * 使い終わった権利の記録を片付ける。
     * ⚠新しいものを消してはいけない。書く直前に取った門を消すと、
     *   同じ rev をもう一度取れてしまい、相手の書き込みを消せるようになる。
     *   だから **古いものだけ** を消す(既定 1日以上前)。
     */
    pruneClaims: async ({ olderThanMs = 24 * 60 * 60 * 1000, limit = 5000, collection = claimsCol } = {}) => {
      const cutoff = new Date(now() - olderThanMs).toISOString().replace('T', ' ');
      const rows = await client.listAll(collection, { filter: `created < "${cutoff}"`, fields: 'id', sort: 'created' });
      let n = 0;
      for (const r of rows.slice(0, limit)) { await client.remove(collection, r.id); n++; }
      return { removed: n };
    },

    /**
     * 使い終わった門を片付ける。
     * ⚠これは「詰まりの解除」ではない(詰まりは書けなかった時に自分で返す + 60秒で自動解除)。
     *   ここは **溜まった記録が増え続けないようにする掃除**。保存1回につき1件増えるので、
     *   放っておくと年単位で数百万件になる。画面の起動時に一度呼ぶ想定。
     */
    pruneGates: async ({ olderThanMs = 60 * 60 * 1000, limit = 5000 } = {}) => {
      const cutoff = new Date(now() - olderThanMs).toISOString().replace('T', ' ');
      const rows = await client.listAll(gatesCol, { filter: `created < "${cutoff}"`, fields: 'id', sort: 'created' });
      let n = 0;
      for (const r of rows.slice(0, limit)) { await client.remove(gatesCol, r.id); n++; }
      return { removed: n };
    },

    /** 試験・点検用(門を直接見る)。 */
    _gates: { scopeOf: gateScope, release: releaseGate, releaseStale: releaseStaleGate, collection: gatesCol },
  };
};
