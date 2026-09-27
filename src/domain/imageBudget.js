// ============================================================================
// 📷 画像の「容量の上限」— 撮った瞬間に、決めたルールで自動的に小さくする
// ----------------------------------------------------------------------------
// 清水さん(2026-08-10):
//   「撮った瞬間にある容量より多かったら、この容量に変更しますか？みたいな感じで変更した方がいい。
//     最近のスマホやタブレットは画質綺麗だから容量大きくなりがち。
//     基本的なルールを決めて、毎回変更しますか？って聞くのはやめた方が作業者は楽。
//     まあ変更する場合はこの画像でいいですか？って見せた方がいい。見えない画像見せても意味ないから。」
//
// 設計の芯:
//   ① **毎回聞かない**。上限の中なら黙って通す。
//   ② 上限を超えた時だけ、段を下げて **上限に収まるまで自動で小さくする**。
//   ③ 小さくした時だけ「この画像でいいですか？」と **実物を大きく** 出す。
//
// ⚠⚠ ここが今までの穴だった: resizeImage は px と画質を掛けるだけで、
//   **出来上がりのバイト数を一度も見ていなかった**。だから同じ設定でも
//   端末のカメラが良くなるほど保存される容量が増え続ける。
//   → **実測(出力文字列の長さ)を見て段を降りる**。推定しない。
//
// ⚠⚠ 用途キーは **DEFAULT_IMG_QUALITY と同じキーしか使わない**。
//   別のキーを増やすと resizeImage が `IMG_QUALITY[key] || default` で黙って既定に落ち、
//   決めた上限が一切効かないのに効いているつもりになる(2026-08-10 の設計レビューで指摘)。
//   → 下のテストで「上限のキー ⊆ 画質のキー」を機械的に固定する。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/**
 * 用途ごとの1枚あたり上限(バイト)。
 * ⚠数字の根拠:
 *   ・Firestore の1ドキュメントは 1MB。設定doc(masterItems/テンプレ)に同居する画像は
 *     **何十枚も入る**ので特に小さくする必要がある。
 *   ・不具合・荷姿は別docや別コレクションへ逃がす仕組みがあるので、もう少し許せる。
 *   ・機番AIの切り出しは「文字が読めること」が全て。小さすぎると機能そのものが死ぬ。
 */
export const DEFAULT_IMG_BUDGET = Object.freeze({
  workStandard: 120 * 1024,        // 作業標準の参考画像(テンプレに同居 = 枚数が多い)
  defectPhoto: 300 * 1024,         // 不具合写真(証拠なので少し大きく)
  // ⚠packingPhoto(荷姿写真)は **製品では使っていない**(最終検査アプリ専用)。
  //   設定表には残っているが resizeImage の呼び出しが1件も無いので、上限も置かない。
  //   置くと「上限を決めたのに効いていない」が生まれる(テスト B02 が検出した)。
  diagram: 300 * 1024,             // 測定図(線が読めないと意味が無い)
  default: 200 * 1024,
});

/** 設定(settings.imageBudget)で上書き。⚠壊れていても既定に倒して画面を止めない。 */
export const budgetOf = (settings, use) => {
  const cfg = (settings && settings.imageBudget) || {};
  const raw = cfg[use];
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 20 * 1024) return n; // 20KB 未満は事故(何も見えなくなる)
  return DEFAULT_IMG_BUDGET[use] != null ? DEFAULT_IMG_BUDGET[use] : DEFAULT_IMG_BUDGET.default;
};

/**
 * 段。上から順に試して、**上限に収まった最初の段**を採る。
 * ⚠1段目は「いまの設定(px/画質)」。つまり **上限の中なら今までと1ミリも変わらない**。
 * @param base { maxDim, quality } いまの設定
 */
export const laddersFor = (base) => {
  const b = { maxDim: Number(base?.maxDim) || 800, quality: Number(base?.quality) || 0.5 };
  const steps = [b];
  const cand = [
    { maxDim: Math.round(b.maxDim * 0.85), quality: Math.max(0.4, b.quality - 0.08) },
    { maxDim: Math.round(b.maxDim * 0.7), quality: Math.max(0.35, b.quality - 0.15) },
    { maxDim: Math.round(b.maxDim * 0.55), quality: Math.max(0.3, b.quality - 0.2) },
    { maxDim: Math.round(b.maxDim * 0.42), quality: 0.3 },
  ];
  cand.forEach(c => { if (c.maxDim >= 240) steps.push(c); }); // ⚠240px を下回ると何も判別できない
  return steps;
};

/** data URI の保存バイト数。⚠base64 は ASCII なので **文字数がそのままバイト数**。推定しない。 */
export const dataUrlBytes = (s) => String(s || '').length;

export const fmtKB = (b) => `${Math.round((b || 0) / 1024)}KB`;

/**
 * 段の列から「上限に収まった最初の段」を選ぶ判定。
 * @param sizes 各段の実測バイト数(段と同じ並び)
 * @returns {{index:number, withinBudget:boolean}} 収まる段が無ければ最後の段(index=last)
 */
export const pickStep = (sizes, budget) => {
  const list = sizes || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] <= budget) return { index: i, withinBudget: true };
  }
  return { index: Math.max(0, list.length - 1), withinBudget: false };
};

/**
 * 「この画像でいいですか？」を出すべきか。
 * ⚠**1段目で収まった＝今までと同じ**なら出さない(毎回聞かない)。
 * ⚠ほんの少し縮んだだけでも出さない。見た目が変わらないのに聞かれるのは邪魔なだけ。
 *   → 段が下がった(=見た目が変わった)時だけ聞く。
 */
export const shouldConfirm = (stepIndex) => stepIndex > 0;

/** 画面に出す一言。⚠必ず「元 → 後」の実測を添える(数字には出どころを添える)。 */
export const shrinkNote = ({ before, after, stepIndex, withinBudget, budget }) => {
  if (stepIndex === 0) return '';
  const head = `${fmtKB(before)} → ${fmtKB(after)} に小さくしました`;
  return withinBudget ? `${head}（1枚 ${fmtKB(budget)} までの決まり）`
    : `${head}（それでも決まりの ${fmtKB(budget)} を超えています。撮り直すと良くなることがあります）`;
};
