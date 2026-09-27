// ============================================================================
// 📐 測定図(工程の下敷きの絵)を「1枚だけ持って、みんなでそれを指す」形にするための純関数。
// ----------------------------------------------------------------------------
// ⚠⚠ なぜ要るか(2026-08-14 本番の現物で実測):
//   本番のロット469件・合計4,460KB のうち、**測定図が68枚 1,861KB**。
//   ところが **中身が違う絵は4枚 109KB しかない**。つまり 94% が同じ絵の焼き増し。
//
//   なぜ増えるか:
//     ・ロットを作るとき、テンプレの工程を **絵ごと丸ごとコピー** している。
//     ・テンプレを保存すると、未着手のロットへ一括で撒くので、コピーがさらに増える。
//   同じ1枚(27KB)が17ロット分ぶら下がっているだけの状態。
//
//   実害は「重い」だけでは済まない。ロット1件は Firestore の1MB上限に縛られていて、
//   いま最大 139KB のうち **109KB が測定図**。図が増えれば、検査の記録そのものが
//   保存できなくなる日が来る。しかもその図は作業者には消せない(下敷きの絵なので)。
//
// やること(資料PDFの別置き fileOffload.js とまったく同じ考え方):
//   保存前: 絵の中身を step_diagrams へ逃がし、工程には 'diagram:<id>' という **札** だけ置く。
//   読取後: 札を中身に戻してから画面へ渡す。→ 図を表示する側のコードは無改修。
//
// ⚠⚠ IDは **中身から決める**(内容アドレス)。ここが今回の肝。
//   同じ絵は必ず同じIDになるので、17ロットが1つのドキュメントを共有し、重複が**自動で**消える。
//   ⚠⚠ 最終検査の lotImgIdFor(lotId, dataUrl) を持ってきてはいけない。
//     あれはIDに **ロットIDを含む** ので、17ロットなら17個のドキュメントができるだけで
//     1バイトも減らない。ここには **ロットIDを入れない**。
//   ⚠時刻も乱数も混ぜない。多端末で同時に動いても同じIDになる(=増えない・孤児が出ない)。
//
// ⚠参照先は不変(絵が変われば別のID)。テンプレの絵を差し替えても、過去のロットは
//   **当時の絵を指したまま**になる。記録としてはむしろ正しい。
//
// ⚠ここには React も firebase も import しない(node --test と試験スクリプトから回すため)。
// ============================================================================

import { hashStr } from './fileOffload.js';

export const DIAGRAM_PREFIX = 'diagram:';
export const DIAGRAM_COLLECTION = 'step_diagrams';

// これ未満の絵は触らない。札(30文字ほど)＋ドキュメント1件の読み取りのほうが高くつく。
// ⚠⚠ **この1つの値を、選ぶ側(巡回)と動かす側(保存)の両方が使うこと。**
//   2026-07-28 の事故: 選ぶ側は「絵ならなんでも」、動かす側は「20,000文字以上だけ」で
//   数えていたため、小さい絵しか無いロットが **書いても対象のまま** になり、
//   90秒ごとに全端末が同じロットを書き直し続けた。
//   → ここでは判定を isOffloadableDiagram() 1本に集約し、両方から必ずそれを呼ぶ。
//   本番の測定図は1枚27KB前後なので、2,000文字はすべての実データを確実に拾える線。
export const DIAGRAM_MIN = 2000;

export const isDiagramRef = (v) => typeof v === 'string' && v.startsWith(DIAGRAM_PREFIX);
export const isOffloadableDiagram = (v) =>
  typeof v === 'string' && v.startsWith('data:image') && v.length >= DIAGRAM_MIN;

/** 中身から決まる短いID。⚠ロットIDも時刻も乱数も入れない。 */
export const diagramIdFor = (dataUrl) => `dg-${hashStr(dataUrl)}${String(dataUrl).length.toString(36)}`;

/** 保管庫から読んだ行 → { id: 絵 } の索引。中身が空の行は無いのと同じ(戻しても表示できない)。 */
export const diagramMapOf = (rows) => {
  const m = {};
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const id = r && (r.id || r.__id);
    if (id && typeof r.data === 'string' && r.data.length > 0) m[id] = r.data;
  }
  return m;
};

// ---- 読取後: 札 → 中身 ------------------------------------------------------
// ⚠⚠ **まだ届いていない札は、札のまま返す。** '' や null に潰してはいけない。
//   潰したままロットを保存すると、Firestore の札が空で恒久上書きされ、
//   その工程の図は二度と出なくなる(資料PDFで一度やりかけた形)。
// ⚠変わらない時は **同じ配列/同じオブジェクト** を返す(画面の作り直しを増やさないため)。
export const hydrateSteps = (steps, imgMap) => {
  if (!Array.isArray(steps)) return steps;
  let changed = false;
  const out = steps.map((s) => {
    const mc = s && s.measurementConfig;
    if (!mc || !isDiagramRef(mc.diagramImage)) return s;
    const hit = (imgMap || {})[mc.diagramImage.slice(DIAGRAM_PREFIX.length)];
    if (!hit) return s;
    changed = true;
    return { ...s, measurementConfig: { ...mc, diagramImage: hit } };
  });
  return changed ? out : steps;
};

export const hydrateLot = (lot, imgMap) => {
  if (!lot || typeof lot !== 'object') return lot;
  const steps = hydrateSteps(lot.steps, imgMap);
  return steps === lot.steps ? lot : { ...lot, steps };
};

// ---- 保存前: 中身 → 札 ------------------------------------------------------
// writeDiagram(id, {mime, data, bytes}) は呼び元が保管庫へ書く関数。
// ⚠既に札の物は触らない(保存のたびに複製が増えるのを防ぐ)。
// ⚠known に「もう保管庫に在るID」を渡すと、その絵は書き直さない。
//   同じ絵が同じロットの中に何枚あっても、書き込みは1回だけ。
// ⚠変わらない時は **元の配列をそのまま返す**。呼び元はこれで「書く必要が無い」を判定できる。
export const dehydrateSteps = async (steps, writeDiagram, opts = {}) => {
  if (!Array.isArray(steps)) return steps;
  const known = opts.known instanceof Set ? opts.known : new Set();
  // 🚨 2026-09-02(NC3): 1回の保存で外へ出す絵の枚数の上限(opts.max)。
  //   ⚠⚠ 上限に当たった絵は **札に替えない**(絵のまま本体に残す)。
  //     ここで札にすると「札は在るのに図が無い」＝その工程の図が二度と出ない。
  //     絵のまま残せば今までどおり保存できて、90秒ごとの巡回が次の回に片付ける(自然に直る)。
  //   ⚠ もう外に在る絵(known)は書かないので上限を食わない。札に替えるだけ。
  //   既定は上限なし。入れるのは呼ぶ側(saveData)。
  const max = Number.isFinite(opts.max) ? Math.max(0, opts.max) : Infinity;
  let wrote = 0;
  let changed = false;
  const out = [];
  for (const s of steps) {
    const mc = s && s.measurementConfig;
    if (!mc || !isOffloadableDiagram(mc.diagramImage)) { out.push(s); continue; }
    const url = mc.diagramImage;
    const id = diagramIdFor(url);
    if (!known.has(id)) {
      if (wrote >= max) { out.push(s); continue; }   // 🚨上限。**絵のまま**残す(札にしない)
      // ⚠中身は毎回まったく同じにする(時刻を入れない)。2台が同時に書いても結果が同じになる。
      const mime = (/^data:([^;,]+)/.exec(url) || [])[1] || 'image/png';
      await writeDiagram(id, { mime, data: url, bytes: url.length });
      known.add(id);
      wrote += 1;
    }
    out.push({ ...s, measurementConfig: { ...mc, diagramImage: DIAGRAM_PREFIX + id } });
    changed = true;
  }
  return changed ? out : steps;
};

// ---- 数える・選ぶ -----------------------------------------------------------

/** この工程一覧に、まだ外へ出していない絵があるか。⚠選ぶ側と動かす側で同じ判定を使う。 */
export const stepsNeedDiagramOffload = (steps) =>
  (Array.isArray(steps) ? steps : []).some((s) => isOffloadableDiagram(s && s.measurementConfig && s.measurementConfig.diagramImage));

/**
 * 巡回で片付けるロット。重い順に返す。
 * ⚠⚠ **渡すのは「保管庫にある生の姿」**。中身に戻した(hydrate した)ロットを渡すと
 *   全ロットが永久に選ばれ続け、90秒ごとに全端末が書き直す事故になる(2026-07-28)。
 *   呼び元は必ず購読の生データを渡すこと。
 */
export const lotsNeedingDiagramOffload = (lots) =>
  (Array.isArray(lots) ? lots : [])
    .map((l) => {
      const imgs = (Array.isArray(l && l.steps) ? l.steps : [])
        .map((s) => s && s.measurementConfig && s.measurementConfig.diagramImage)
        .filter(isOffloadableDiagram);
      return { id: l && l.id, images: imgs.length, bytes: imgs.reduce((a, x) => a + x.length, 0) };
    })
    .filter((x) => x.id && x.images > 0)
    .sort((a, b) => b.bytes - a.bytes);

/** この工程一覧が指している札のID。 */
export const referencedDiagramIdsInSteps = (steps) => {
  const out = new Set();
  for (const s of (Array.isArray(steps) ? steps : [])) {
    const v = s && s.measurementConfig && s.measurementConfig.diagramImage;
    if (isDiagramRef(v)) out.add(v.slice(DIAGRAM_PREFIX.length));
  }
  return out;
};

/** 渡されたロット全部が指している札のID。 */
export const referencedDiagramIds = (lots) => {
  const out = new Set();
  for (const l of (Array.isArray(lots) ? lots : [])) for (const id of referencedDiagramIdsInSteps(l && l.steps)) out.add(id);
  return out;
};

/**
 * どのロットからも指されていない絵(=消してよい絵)。
 *
 * ⚠⚠ **内容アドレスなので、1枚の絵を何ロットもが共有している。**
 *   1ロットを消しただけでその絵の実体を消すと、**他のロットの図が一斉に消える**。
 *   だから判定には **全ロット** が要る。
 *
 * ⚠画面のロット購読は「新しい順500件＋未完了」しか見ていない。そこから呼ぶと
 *   501件目より古い完了ロットが指している絵を「誰も使っていない」と誤判定する。
 *   → 全件を読んだ呼び元だけが `{ complete: true }` を渡せる。渡さなければ **1件も返さない**。
 *     (迷ったら消さない側に倒す)
 */
export const orphanDiagramIds = (allLots, existingIds, opts = {}) => {
  if (opts.complete !== true) return [];
  const used = referencedDiagramIds(allLots);
  return [...new Set(Array.isArray(existingIds) ? existingIds : [])].filter((id) => id && !used.has(id));
};

/**
 * バックアップに書き出すロット。**書き込みは一切しない純関数**。
 *
 * ⚠画面が持っている lots は測定図を絵に戻してある。そのまま書き出すと、戻した時に絵が
 *   ロット本体へ焼き戻り、せっかくの重複排除が元に戻る(実測 1,861KB ぶん)。
 * ⚠⚠ **実体が在ると確認できた絵だけ** 札に替える。確認できない絵は絵のまま出す。
 *   どちらにしても中身は必ずJSONに入るので、1バイトも失われない。
 *   (「たぶん在るはず」で札に替えるのが、戻せないバックアップの作り方)
 */
export const refLotsForBackup = (lots, knownIds) => {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return (Array.isArray(lots) ? lots : []).map((l) => {
    const steps = Array.isArray(l && l.steps) ? l.steps : null;
    if (!steps) return l;
    let changed = false;
    const out = steps.map((s) => {
      const mc = s && s.measurementConfig;
      if (!mc || !isOffloadableDiagram(mc.diagramImage)) return s;
      const id = diagramIdFor(mc.diagramImage);
      if (!known.has(id)) return s;
      changed = true;
      return { ...s, measurementConfig: { ...mc, diagramImage: DIAGRAM_PREFIX + id } };
    });
    return changed ? { ...l, steps: out } : l;
  });
};

// ⚠「焼き増しが何枚 何KB残っているか」を数える関数は、ここには置かない。
//   画面のどこからも呼ばない物を置くと「関数がある = 使える」と勘違いする(MISTAKES D7)。
//   実測は scripts/verify-diagram-dedup.mjs と scripts/verify-lot-capacity.mjs が
//   本番の現物に対してやる。そちらが唯一の数え役。
