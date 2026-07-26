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
// ============================================================================

import { mergeDoc, overwriteDoc, setFieldsDoc } from './docMerge.js';
import { claimOnce, PbHttpError, PbNetworkError } from './pbClient.js';

export const DOCS_COL = 'docs';
export const CLAIMS_COL = 'claims';

/** 書類の場所を1つの文字列にする(門の名前に使う)。 */
export const docKey = (ns, col, docId) => `${ns}/${col}/${docId}`;

/** 衝突の知らせ。⚠通信の失敗と混ぜない。 */
export class PbConflictError extends Error {
  constructor(key, currentRev, baseRev) {
    super(`他の端末が先に保存しました: ${key}(今 rev=${currentRev} / こちらの元 rev=${baseRev})`);
    this.name = 'PbConflictError';
    this.key = key; this.currentRev = currentRev; this.baseRev = baseRev;
  }
}

export const createDocStore = (client, { docsCol = DOCS_COL, claimsCol = CLAIMS_COL, maxAttempts = 12, owner = '' } = {}) => {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  const filterOf = (ns, col, docId) =>
    `ns="${esc(ns)}" && col="${esc(col)}"` + (docId === undefined ? '' : ` && docId="${esc(docId)}"`);

  const findRecord = async (ns, col, docId) => {
    const r = await client.listPage(docsCol, { perPage: 1, filter: filterOf(ns, col, docId) });
    return r.items?.[0] || null;
  };

  /**
   * 「rev を R → R+1 へ進める権利」を1台だけに渡す門。
   * @returns {acquired, reason} reason は 'ok' | 'taken' | 'error'
   */
  const gate = (ns, col, docId, rev) =>
    claimOnce(client, `doc:${docKey(ns, col, docId)}`, `rev:${rev}`, { owner, collection: claimsCol });

  /**
   * 中身を書く。Firestore の setDoc と同じ意味になるようにする。
   * @param opts.merge     false なら全上書き(既定 true)
   * @param opts.baseRev   これを渡すと「その rev から進める時だけ書く」。
   *                       違っていれば PbConflictError。オフラインから復帰した
   *                       全上書きの保存で、相手の変更を黙って消さないために使う。
   * @returns {rev, rebased, created}
   */
  const write = async (ns, col, docId, patch, opts = {}) => {
    const merge = opts.merge !== false;
    const key = docKey(ns, col, docId);
    let lastSeenRev = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cur = await findRecord(ns, col, docId);
      const rev = cur ? (Number(cur.rev) || 0) : 0;
      lastSeenRev = rev;

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
          await client.create(docsCol, { ns, col, docId, data: body, rev: 1, sourceUpdatedAt: null });
          return { rev: 1, rebased: attempt > 0, created: true };
        } catch (e) {
          if (e instanceof PbHttpError && e.isUnique) continue; // 同じ瞬間に別の端末が作った → 読み直す
          throw e;
        }
      }

      const g = await gate(ns, col, docId, rev);
      if (!g.acquired) {
        if (g.reason === 'taken') continue;            // 他の端末が先に進めた → 読み直す
        throw g.error || new Error('権利の取得に失敗しました');  // ⚠通信/認証の失敗は握り潰さない
      }

      try {
        const body = merge ? mergeDoc(cur.data, patch) : overwriteDoc(patch);
        await client.update(docsCol, cur.id, { data: body, rev: rev + 1 });
        return { rev: rev + 1, rebased: attempt > 0, created: false };
      } catch (e) {
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
    setFields: async (ns, col, docId, fields) => {
      const key = docKey(ns, col, docId);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cur = await findRecord(ns, col, docId);
        if (!cur) throw new Error(`対象がありません: ${key}`);
        const rev = Number(cur.rev) || 0;
        const g = await gate(ns, col, docId, rev);
        if (!g.acquired) { if (g.reason === 'taken') continue; throw g.error || new Error('権利の取得に失敗しました'); }
        await client.update(docsCol, cur.id, { data: setFieldsDoc(cur.data, fields), rev: rev + 1 });
        return { rev: rev + 1 };
      }
      throw new Error(`項目の差し替えが${maxAttempts}回やり直しても通りませんでした(${key})`);
    },

    remove: async (ns, col, docId) => {
      const cur = await findRecord(ns, col, docId);
      // ⚠書類を消したら、その書類の権利の記録も一緒に片付ける。
      //   残しておくと、同じIDで作り直したときに古い権利が邪魔をする。
      //   (書類が無ければ権利だけ残っている可能性があるので、いずれにせよ片付ける)
      // ⚠端末用アカウントは権利の記録を消せない(ルールでそうしてある。消せると
      //   二重送信を止められなくなる)。403 は想定内なので騒がない。
      //   ここで消せなくても困らない: **新規作成に門は付いていない**ので、
      //   同じIDで作り直すのは通る。溜まった記録は管理者の pruneClaims が片付ける。
      const scope = `doc:${docKey(ns, col, docId)}`;
      try {
        const rows = await client.listAll(claimsCol, { filter: `scope="${esc(scope)}"`, fields: 'id' });
        for (const r of rows) await client.remove(claimsCol, r.id);
      } catch (e) {
        if (!(e instanceof PbHttpError && (e.status === 403 || e.status === 401))) {
          console.warn('[pb] 権利の記録を片付けられませんでした', e?.message || e);
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
    appendCapped: async (ns, col, docId, field, item, { maxBytes = 900 * 1024, fallback = {} } = {}) => {
      const key = docKey(ns, col, docId);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cur = await findRecord(ns, col, docId);
        const rev = cur ? (Number(cur.rev) || 0) : 0;
        const g = await gate(ns, col, docId, rev);
        if (!g.acquired) { if (g.reason === 'taken') continue; throw g.error || new Error('権利の取得に失敗しました'); }

        const base = cur ? (cur.data || {}) : fallback;
        let arr = [...((base && base[field]) || []), item];
        let dropped = 0;
        while (arr.length > 1 && JSON.stringify(arr).length > maxBytes) { arr = arr.slice(1); dropped++; }

        try {
          if (!cur) {
            // ⚠消えていた場合は中身ごと作り直す。field だけ書くと名前なしの幽霊になる。
            await client.create(docsCol, { ns, col, docId, data: { ...fallback, [field]: arr }, rev: 1 });
          } else {
            await client.update(docsCol, cur.id, { data: { ...base, [field]: arr }, rev: rev + 1 });
          }
          return { count: arr.length, dropped };
        } catch (e) {
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
        await client.update(docsCol, cur.id, { data: mergeDoc(data, patch), rev: rev + 1 });
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
    pruneClaims: async ({ olderThanMs = 24 * 60 * 60 * 1000, limit = 5000 } = {}) => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString().replace('T', ' ');
      const rows = await client.listAll(claimsCol, { filter: `created < "${cutoff}"`, fields: 'id', sort: 'created' });
      let n = 0;
      for (const r of rows.slice(0, limit)) { await client.remove(claimsCol, r.id); n++; }
      return { removed: n };
    },
  };
};
