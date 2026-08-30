// ============================================================================
// 📦 1MBの関所: 「止めてよい保存」と「絶対に止めてはいけない保存」の線引き。
// ----------------------------------------------------------------------------
// ⚠⚠ これは部品検査だけのファイル(最終検査/製品検査には写真の別置き先 lot_images が在り、
//    形が違う)。共有ファイルではないので md5 を揃える相手はいない。
//
// 🚨 なぜ要るか(2026-08-17 の洗い出しで見つかった形):
//   1MBの見張りが「合体後サイズ > 危険線」だけで止めていた。
//   すると上限に迫った指図では、**写真を1枚も増やさない「作業時間だけの保存」まで止まる**。
//   ・検査員は写真を減らす前に時間取りを保存できない
//   ・画面を閉じた時点で作業時間が消える
//   → 見張りが、守るはずの物(作業時間)を自分で消していた。
//     「写真を減らしてください」と言いながら減らす前の保存を全部止めるのは筋が通らない。
//
// 🚨 線引き(ここが唯一の定義。画面側に条件を直書きしない):
//   止める = 合体後が危険線を超える AND **写真のバイト数が増える**
//   その他は全部 **通す**(危険線を超えていても、記録だけの保存なら通して警告だけ出す)。
//
// ⚠⚠ 「payload に写真が入っているか」で判定してはいけない。
//   部品検査の interruptions は **配列**で、Firestore の merge は配列を丸ごと置き換える。
//   つまり「気づきを1件足す」だけの保存でも、既存の写真を全部載せて送る。
//   入っているかで見ると、これを止めてしまう(実測で外した。試験 C03)。
//   → **増えたか** で見る。写真の量が変わらない保存は、何を含んでいても通す。
// ============================================================================

/** 中に入っている data:image のバイト数を全部足す(深い入れ子も見る)。
 *  ⚠深さを打ち切るのは巨大な指図で固まらせないため。写真は tasks/interruptions/
 *    packagingPhotos の浅い所にしか置かれないので8段で届く。 */
export const imageBytesOf = (v, depth = 0) => {
    if (depth > 8 || v == null) return 0;
    if (typeof v === 'string') return v.startsWith('data:image') ? v.length : 0;
    if (Array.isArray(v)) return v.reduce((a, x) => a + imageBytesOf(x, depth + 1), 0);
    if (typeof v === 'object') return Object.values(v).reduce((a, x) => a + imageBytesOf(x, depth + 1), 0);
    return 0;
};

/**
 * 保存を止めるか / 通して警告するか / 何もしないか を決める。
 * @param {object} current     いまサーバに在る指図(まるごと)
 * @param {object} merged      この保存を合体した後の姿(まるごと)
 * @param {number} mergedBytes 合体後のバイト数(呼ぶ側が測った値をそのまま使う)
 * @param {number} dangerBytes 危険線
 * @returns {{action:'block'|'warn'|'ok', reason:string, imgBefore:number, imgAfter:number}}
 */
export const decideCapacity = (current, merged, mergedBytes, dangerBytes) => {
    const imgBefore = imageBytesOf(current);
    const imgAfter = imageBytesOf(merged);
    if (mergedBytes <= dangerBytes) return { action: 'ok', reason: '', imgBefore, imgAfter };
    // 🚨 写真の量が増える保存だけを止める。記録だけ / 写真が変わらない / 減る保存は絶対に止めない。
    if (imgAfter > imgBefore) return { action: 'block', reason: 'photo-grew-over-limit', imgBefore, imgAfter };
    return { action: 'warn', reason: imgAfter < imgBefore ? 'photo-shrink-over-limit' : 'records-only-over-limit', imgBefore, imgAfter };
};

/** 止めた時に人へ出す文。⚠「記録の保存は止めていない」を必ず書く(現場が判断できるように)。 */
export const capacityBlockMessage = (mergedBytes, limitBytes) =>
    `📦 このロットは保存後 約${Math.round(mergedBytes / 1024)}KB になり、Firestore の上限(${Math.round(limitBytes / 1024)}KB)に迫ります。`
    + `\nこのまま写真を増やすと、このロットは写真も検査記録も一切保存できなくなります。`
    + `\n不具合写真の枚数を減らしてから、写真の追加をやり直してください。`
    + `\n（作業時間の記録だけの保存は止めていません。時間取りはそのまま保存できます）`;
