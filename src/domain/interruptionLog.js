// ============================================================================
// 🧾 中断の記録(軽微不良 / 気づき・改善 / 不具合 / 張り付き)を多端末で壊さないための1本
// ----------------------------------------------------------------------------
// なぜ要るか(2026-08-14 点検で確定・両アプリ成立):
//   lot.interruptions は **配列** で、書く側は必ず「開いた瞬間の配列 ＋ 1件」を
//   丸ごと書き戻していた。Firestore の setDoc(merge:true) が再帰マージするのは
//   **入れ子のマップだけ**で、**配列はフィールドごと置換**する。
//   つまり後から書いた端末が、相手の追加・削除・修正をまるごと消す。向きは2つ:
//     ① 台帳(分析タブ/軽微不良台帳)で消した・直した記録が、作業画面が握っている
//        古い配列で **復活・巻き戻る** →「消したのに翌日また出ている」
//     ② 作業画面を開いてから「タッチアップへ移動」「完了確定」を押すまでの間に
//        他端末が足した記録が、その1回で **まとめて消える**。窓は数時間になりうる。
//   どちらも画面には何も出ないので、報告した人だけが黙って損をする。
//
// 直し方: 新しい記録は lot.interruptionsMap = { 鍵: 記録 } へ **1件ずつ** 書く。
//   マップは merge:true で再帰マージされるので、触っていない鍵は相手の書き込みが残る。
//
// ⚠既存の `interruptions` 配列は **消さない・書き換えない**。読むときに合流させる。
//   バックアップ/復元・司令塔③・スクリプトが生の配列を見ている可能性がある。
//   「消えた」を起こすくらいなら二重に持つ方が安い(古い形も読めるようにする)。
//
// ⚠マップ側は必ず **1件まるごと** 書く(部分書き禁止)。merge:true は入れ子マップを
//   再帰マージするので、部分書きすると古い値と混ざる。項目を1つ外す編集は
//   intWritePatch が __deleteMapKeys で「消す印」を出す(2026-07-26 の監査と同じ形)。
//
// ⚠削除は「鍵ごと消す」ではなく **墓標(deleted:true)**。古い記録は配列側にいるので、
//   鍵を消しただけでは配列から復活してしまう。
// ============================================================================

export const INT_MAP_FIELD = 'interruptionsMap';

const SAFE_KEY = /^[A-Za-z0-9_-]{1,120}$/;
const hash32 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h.toString(36); };

/** 記録 → マップの鍵。要件は「同じ記録なら必ず同じ鍵」だけ。
 *  ⚠古い記録は id を持たないことがある(集計側も `i.id || `${l.id}_${i.timestamp}`` で逃がしている)。
 *    その時は中身から決める(端末が違っても同じ鍵になる)。 */
export const intKeyOf = (e) => {
  const raw = String((e && e.id) || '');
  if (SAFE_KEY.test(raw) && !raw.startsWith('__')) return raw;
  return 'k' + hash32(`${e?.timestamp || 0}|${e?.type || ''}|${e?.label || ''}|${e?.workerName || ''}`);
};

export const isIntTombstone = (v) => !!(v && typeof v === 'object' && v.deleted === true);

/** 配列(古い形)とマップ(新しい形)を合流して1本の配列にする。
 *  規則: マップに鍵があればマップ側が **まるごと勝つ**(墓標なら落とす)。無ければ配列のまま。 */
export const mergeInterruptionLog = (arr, map) => {
  const base = Array.isArray(arr) ? arr : [];
  const m = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  const out = []; const used = new Set();
  for (const e of base) {
    if (!e) continue;
    const k = intKeyOf(e); used.add(k);
    const ov = m[k];
    if (ov === undefined) { out.push(e); continue; }
    if (isIntTombstone(ov)) continue;
    // ⚠{...e, ...ov} にしない。編集で外した項目(原因工程・写真)が配列側から復活する。
    out.push(ov);
  }
  for (const [k, v] of Object.entries(m)) {
    if (used.has(k) || !v || isIntTombstone(v)) continue;
    out.push(v);
  }
  return out.sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
};

/** 購読で読んだロットに、合流済みの interruptions を載せて返す。
 *  ⚠マップが無いロットは **同じオブジェクトをそのまま返す**。全ロットが毎回別物になると
 *    React.memo が全部剥がれて再描画が増える(hydrateLotImages と同じ作法)。 */
export const withInterruptionLog = (lot) => {
  const map = lot && lot[INT_MAP_FIELD];
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length === 0) return lot;
  return { ...lot, interruptions: mergeInterruptionLog(lot.interruptions, map) };
};

/** 1件を書くための保存パッチ。prev を渡すと「消えた項目」に消す印を付ける。 */
export const intWritePatch = (prev, next) => {
  // ⚠⚠ 鍵は **直す前の記録(prev)** から採る。
  //   古い記録は id を持たないことがあり、その時の鍵は「時刻|種類|文言|担当」から作る。
  //   next から採ると、文言を直しただけで **鍵が変わって別の記録になり、同じ中断が2件に増える**
  //   (2026-08-14 実測: 文言を直しただけで k1649vy → km36178 に変わり、一覧が2行になった)。
  //   prev があればそれを使い、新規追加(prev が無い)時だけ next から採る。
  const key = intKeyOf(prev || next);
  const patch = { [INT_MAP_FIELD]: { [key]: next } };
  const gone = Object.keys(prev || {}).filter((k) => !(k in (next || {})));
  if (gone.length) patch.__deleteMapKeys = gone.map((k) => [INT_MAP_FIELD, key, k]);
  return patch;
};

/** 1件を消すための保存パッチ(墓標)。誰がいつ消したかを残す。 */
export const intDeletePatch = (entry, by = '') => {
  const key = intKeyOf(entry);
  return { [INT_MAP_FIELD]: { [key]: { id: entry?.id || key, deleted: true, deletedAt: Date.now(), deletedBy: by || '' } } };
};

/** 進行中(status==='active')の「いま何秒か」を入れて返す(表示専用)。 */
export const withLiveDuration = (list, now = Date.now()) =>
  (Array.isArray(list) ? list : []).map((i) => {
    if (!i || i.status !== 'active' || i.type === 'break') return i;
    const start = i.startTime || i.timestamp;
    if (!start) return i;
    const d = Math.max(0, Math.floor((now - start) / 1000));
    return i.duration === d ? i : { ...i, duration: d };
  });

/** 計測を止めた1件。⚠秒は **止めた瞬間の実時刻** から出す。
 *  画面のタイマーは裏に回ると間引かれるので、最後の刻みを保存すると短く記録される。 */
export const stopIntEntry = (entry, now = Date.now()) => {
  const start = entry?.startTime || entry?.timestamp || now;
  return { ...entry, status: 'completed', endTime: now, duration: Math.max(0, Math.floor((now - start) / 1000)) };
};

/** 保存した直後、購読が返るまでの「繋ぎ」。共有に現れた物は足さない。 */
export const mergePendingInts = (list, pending, now = Date.now()) => {
  const base = Array.isArray(list) ? list : [];
  const p = (pending && typeof pending === 'object') ? pending : {};
  const keys = Object.keys(p);
  let all = base;
  if (keys.length) {
    const have = new Set(base.map(intKeyOf));
    const add = keys.filter((k) => !have.has(k)).map((k) => p[k]).filter(Boolean);
    if (add.length) all = [...base, ...add].sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
  }
  return withLiveDuration(all, now);
};

/** 共有に現れた繋ぎを外す。⚠変わらない時は同じ物を返す(setState の無限ループ防止)。 */
export const dropSettledPending = (pending, list) => {
  const p = pending || {};
  const have = new Set((Array.isArray(list) ? list : []).map(intKeyOf));
  const hit = Object.keys(p).filter((k) => have.has(k));
  if (!hit.length) return p;
  const out = { ...p }; hit.forEach((k) => delete out[k]); return out;
};
