// ============================================================================
// 💾 編集の作りかけを覚えておく（閉じても・落ちても続きからやれる）
// ----------------------------------------------------------------------------
// 市場調査(2026-08-13)で「無いと素人臭いと即バレる機能」の **1位** がこれ:
//   現場のタブレットは 着信・スリープ・電池切れ・うっかり閉じる で必ず落ちる。
//   1回でも編集が全部消えたら、その道具は二度と使われない。
//   (Canva / Clipchamp / Loom は全部クラウドで自動保存している)
//
// ⚠⚠ 何を覚えるか / 覚えないか:
//   覚える   … 編集の中身(切った所・印・文字・速さ…)、挟んだ画像の本体、元動画の身元
//   覚えない … **端末から選んだ動画ファイルの本体**
//     理由: 1本100MB超がふつう。編集のたびに丸ごと書くと、書き込みで画面が固まり、
//           端末の空き容量も食い潰す。ここを欲張ると「重くて使えない」に化ける。
//   → Driveの動画は id があるので **自動で取り直せる**(完全復帰)。
//     端末の動画だけ「同じファイルをもう一度選んでください」と出す(名前と大きさで照合)。
//
// ⚠localStorage は使わない(5MBしか入らず、挟んだ画像で即あふれる)。IndexedDB を使う。
//
// ----------------------------------------------------------------------------
// 🚨 2026-08-16 に直した欠陥: **作りかけの枠が1本しか無かった**
//   前は鍵が `'current'` の1本きり。動画Bを触った1.5秒後に、動画Aの作りかけが
//   **黙って上書き**されていた(警告も選択肢も無し)。実測ハーネス
//   scripts/verify-draft-roundtrip.mjs ④ が「枠は1つだけ・前のは戻せない」と記録している。
//   → **元動画ごとの鍵**(draftKeyOf)にした。動画Aと動画Bは別々に残る。
//
//   ⚠⚠ 旧い形(鍵'current')で端末に入っている作りかけは **今までどおり読める**。
//     ・鍵を言わずに読む(loadDraft())    … 全部の中から一番新しい物。'current' も候補に入る
//     ・鍵を言って読む(loadDraft(key))   … その鍵が無くても、**元動画が同じ 'current'** なら返す
//     ・同じ元動画で書き直した時         … 用済みの 'current' を消す(2本に見えないように)
//
//   ⚠何本まで持つか / いつ消すか(IndexedDB が無限に育たないように):
//     ① 2週間で出さない(DRAFT_MAX_AGE_MS)  ② 新しい方から5本まで(DRAFT_MAX_COUNT)
//     ③ 全部で60MBまで(DRAFT_MAX_BYTES)    ⚠一番新しい1本は、大きくても絶対に消さない
//        (いま作っている物を自分で消したら、それこそ「黙って消えた」になる)
// ============================================================================

const DB = 'video-editor-draft';
const STORE = 'draft';
/** 旧い形(2026-08-16まで)の1本きりの枠。⚠読める事を必ず残す。 */
export const LEGACY_KEY = 'current';
/** これより古い作りかけは出さない(2週間)。 */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 何本まで持つか(新しい方から)。 */
export const DRAFT_MAX_COUNT = 5;
/** 全部で何バイトまで持つか。⚠挟んだ画像の本体が入るので、ここで頭を押さえる。 */
export const DRAFT_MAX_BYTES = 60 * 1024 * 1024;

const openDb = () => new Promise((res, rej) => {
  if (typeof indexedDB === 'undefined') { rej(new Error('この端末では作りかけを覚えられません')); return; }
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error || new Error('作りかけの入れ物を開けません'));
});

const tx = async (mode, fn) => {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      let out;
      try { out = fn(st); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out && typeof out.result !== 'undefined' ? out.result : out);
      t.onerror = () => rej(t.error || new Error('作りかけの読み書きに失敗しました'));
      t.onabort = () => rej(t.error || new Error('作りかけの読み書きが中断されました'));
    });
  } finally { try { db.close(); } catch { /* noop */ } }
};

/**
 * 入っている物を全部読む → [{key, rec}]
 * ⚠getAll ではなく **カーソル** で読む(鍵と中身が一緒に取れる／古い端末でも動く)。
 */
const readAll = async () => {
  const box = await tx('readonly', (st) => {
    const b = { list: [] };
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      b.list.push({ key: c.key, rec: c.value });
      c.continue();
    };
    return b;
  });
  return (box && box.list) || [];
};

// ---------------------------------------------------------------------------
// 鍵の決め方・選び方(ここは全部 純関数。試験で固定してある)
// ---------------------------------------------------------------------------

/** 短くて衝突しない鍵にする為の目印(名前が長い動画で鍵が伸び続けないように)。 */
const hash36 = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
};

/**
 * 元動画から **その動画の鍵** を作る。
 * ⚠⚠ 鍵は「同じ動画をもう一度開いたら同じ物になる」事が命。
 *   だから id(開くたびに変わる)は使わず、**Driveのid**、無ければ **名前と大きさ**で決める
 *   (matchSources が突き合わせに使っているのと同じ材料)。
 * ⚠元動画が1本も無い時だけ、旧い形の1本枠に落とす。
 */
export const draftKeyOf = (sources) => {
  const parts = (Array.isArray(sources) ? sources : []).map((s) => {
    const d = s && s.driveId ? String(s.driveId) : '';
    return d ? `d:${d}` : `f:${(s && s.name) || ''}|${Number(s && s.size) || 0}`;
  });
  if (!parts.length) return LEGACY_KEY;
  const raw = parts.join('+');
  return `v1:${raw.length > 120 ? `${raw.slice(0, 110)}#${hash36(raw)}` : raw}`;
};

/** 出していい作りかけか(中身が在る・古すぎない)。 */
export const draftUsable = (rec, now = Date.now()) => {
  if (!rec || !rec.project) return false;
  if (!((rec.project.clips || []).length)) return false;
  return (Number(now) - Number(rec.savedAt || 0)) <= DRAFT_MAX_AGE_MS;
};

/**
 * その作りかけが端末で食う大きさ(だいたい)。
 * ⚠文字は1文字2バイトで数える(IndexedDB は文字を2バイトで持つ)。
 * ⚠挟んだ画像の本体は **実寸(File.size)** をそのまま足す(ここが全体の9割を占める)。
 */
export const draftBytes = (rec) => {
  if (!rec) return 0;
  let n = 0;
  const txt = (v) => { try { return JSON.stringify(v || null).length * 2; } catch { return 0; } };
  n += txt(rec.project) + txt(rec.chapters) + txt(rec.sources) + txt(rec.label);
  for (const f of Object.values(rec.images || {})) n += Number(f && f.size) || 0;
  return n;
};

/** 新しい順。⚠同じ時刻なら鍵の順(並びが毎回変わると測れない)。 */
export const sortDrafts = (list) => [...(Array.isArray(list) ? list : [])]
  .filter(Boolean)
  .sort((a, b) => (Number(b.rec?.savedAt || 0) - Number(a.rec?.savedAt || 0)) || String(a.key).localeCompare(String(b.key)));

/**
 * 読む1件を決める。
 * @param list [{key, rec}]
 * @param key  欲しい鍵。空なら **一番新しい物**
 * ⚠⚠ 旧い形(鍵'current')を必ず拾えるようにしてある:
 *   ・鍵が空        … 'current' も候補の1つ(一番新しければ返る)
 *   ・鍵を言われた  … その鍵が無くても、'current' の元動画が同じなら それを返す
 */
export const pickDraft = (list, key = '', now = Date.now()) => {
  const ok = sortDrafts(list).filter(x => draftUsable(x.rec, now));
  if (!ok.length) return null;
  if (!key) return ok[0];
  const hit = ok.find(x => String(x.key) === String(key));
  if (hit) return hit;
  const legacy = ok.find(x => String(x.key) === LEGACY_KEY && draftKeyOf(x.rec && x.rec.sources) === String(key));
  return legacy || null;
};

/**
 * 消していい鍵の一覧(古い・多すぎる・大きすぎる)。
 * @param keep 絶対に消さない鍵(いま書いたばかりの物)
 * ⚠⚠ 一番新しい1本は、単体で上限を超えていても消さない。
 *   「保存した直後に自分で消す」= 黙って消えた、と同じ事になるから。
 */
export const pruneKeys = (list, now = Date.now(), keep = '') => {
  const del = [];
  const alive = [];
  for (const x of sortDrafts(list)) {
    if (draftUsable(x.rec, now)) alive.push(x);
    else if (String(x.key) !== String(keep)) del.push(x.key);
  }
  let bytes = 0;
  alive.forEach((x, i) => {
    bytes += draftBytes(x.rec);
    const over = (i >= DRAFT_MAX_COUNT) || (i > 0 && bytes > DRAFT_MAX_BYTES);
    if (over && String(x.key) !== String(keep)) del.push(x.key);
  });
  return del;
};

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

/** 用済みの物を片付ける。⚠ここで失敗しても保存そのものは成功にする。 */
const tidy = async (keepKey) => {
  const list = await readAll();
  const del = new Set(pruneKeys(list, Date.now(), keepKey));
  // 旧い形の1本枠は、同じ元動画で新しく書いた時点で役目が終わり(2本に見せない)
  if (String(keepKey) !== LEGACY_KEY) {
    const lg = list.find(x => String(x.key) === LEGACY_KEY);
    if (lg && draftKeyOf(lg.rec && lg.rec.sources) === String(keepKey)) del.add(LEGACY_KEY);
  }
  del.delete(keepKey);
  if (!del.size) return;
  await tx('readwrite', (st) => { for (const k of del) st.delete(k); return null; });
};

/**
 * 作りかけを書く。
 * @param draft.project  編集の中身
 * @param draft.sources  [{id, name, size, durationSec, driveId}]  ⚠File本体は入れない
 * @param draft.images   { imageId: File }  挟んだ画像は小さいので本体ごと覚える
 * @param draft.chapters [{name, atOut}]
 * @param draft.label    画面に出す名前(元動画の名前など)
 * @param draft.key      鍵(ふつうは渡さない。元動画から自動で決まる)
 * @returns savedAt(いつ書いたか)
 */
export const saveDraft = async (draft) => {
  const sources = (draft?.sources || []).map(s => ({
    id: s.id, name: s.name || '', size: Number(s.size) || 0,
    durationSec: Number(s.durationSec) || 0, driveId: s.driveId || '',
  }));
  const key = String(draft?.key || draftKeyOf(sources));
  const rec = {
    key,
    savedAt: Date.now(),
    project: draft?.project || null,
    sources,
    images: draft?.images || {},
    chapters: draft?.chapters || [],
    label: draft?.label || '',
  };
  await tx('readwrite', (st) => st.put(rec, key));
  try { await tidy(key); } catch { /* 片付けに失敗しても、書けている事の方が大事 */ }
  return rec.savedAt;
};

/**
 * 作りかけを読む。古すぎる物・空の物は null。
 * @param key 空なら **一番新しい1本**(今までの呼び方はこのまま動く)
 */
export const loadDraft = async (key = '') => {
  let list = [];
  try { list = await readAll(); } catch { return null; }
  const hit = pickDraft(list, key ? String(key) : '');
  if (!hit) return null;
  return { ...hit.rec, key: hit.key };
};

/**
 * 端末に残っている作りかけを新しい順に並べて返す(選ばせる画面用)。
 * ⚠中身(project/images)は返さない。一覧を出すだけで何十MBも読むと固まる。
 */
export const listDrafts = async (now = Date.now()) => {
  let list = [];
  try { list = await readAll(); } catch { return []; }
  return sortDrafts(list).filter(x => draftUsable(x.rec, now)).map(x => ({
    key: x.key,
    label: (x.rec && x.rec.label) || '',
    savedAt: Number(x.rec && x.rec.savedAt) || 0,
    clips: ((x.rec && x.rec.project && x.rec.project.clips) || []).length,
    images: Object.keys((x.rec && x.rec.images) || {}).length,
    sources: (x.rec && x.rec.sources) || [],
    bytes: draftBytes(x.rec),
  }));
};

/**
 * 作りかけを捨てる。
 * @param key 空なら **loadDraft() が返す物**(=画面の帯に出ている その1件)だけを消す。
 * ⚠⚠ 「捨てる」を押した人が見ているのは帯に出ている1件。他の動画の作りかけまで
 *   道連れにしない。出せる物が1つも無い時だけ、旧い形の残骸を片付ける。
 */
export const clearDraft = async (key = '') => {
  try {
    if (key) { await tx('readwrite', (st) => st.delete(String(key))); return; }
    const list = await readAll();
    const hit = pickDraft(list, '');
    await tx('readwrite', (st) => st.delete(hit ? hit.key : LEGACY_KEY));
  } catch { /* noop */ }
};

/**
 * 覚えていた元動画と、いま手元にある物を突き合わせる。
 * @param saved   覚えていた [{id, name, size, driveId}]
 * @param picked  いま選び直した File の配列
 * @returns {ready:[{id,file}], missing:[{id,name,size}]}
 *
 * ⚠名前だけで合わせない(同じ名前の別動画をつないでしまう)。**名前と大きさの両方**で見る。
 */
export const matchSources = (saved, picked) => {
  const rest = [...(picked || [])];
  const ready = [], missing = [];
  for (const s of (saved || [])) {
    const i = rest.findIndex(f => f && f.name === s.name && (!s.size || f.size === s.size));
    if (i >= 0) { ready.push({ id: s.id, file: rest[i] }); rest.splice(i, 1); }
    else missing.push({ id: s.id, name: s.name, size: s.size });
  }
  return { ready, missing };
};

/** 「〜前に保存」の言い方。⚠時計を跨いだ日付計算をしない(ズレる)。 */
export const savedAgo = (savedAt, now = Date.now()) => {
  const ms = Math.max(0, Number(now) - Number(savedAt || 0));
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
};
