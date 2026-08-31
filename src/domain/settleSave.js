// ============================================================================
// 💾 settleSave.js — 「保存してから画面を閉じてよいか」を決める所
// ============================================================================
//
// 【なぜ在るか(2026-08-17 の事故そのもの)】
//   保存を投げっぱなし(await も catch も無い)にしたまま画面を閉じると、
//   拒否された保存は **誰にも届かないまま**、手元の入力ごと消える。
//   2026-08-17 に「作業時間が丸ごと消えた(復旧不可)」のはこの形だった。
//
// 【なぜ「ずっと待つ」ではいけないか(同じ日の もう1つの欠陥)】
//   電波が無いと Firestore の Promise は **返事が来るまで永久に解決しない**。
//   無制限に待つと、✕や保存を押しても画面が閉じず、現場では「固まった」に見える。
//   → **少しだけ待って** 3つに分ける:
//       'ok'      … 届いた
//       'error'   … 拒否された(＝保存できていない)
//       'pending' … まだ送れていない(端末の待ち行列には入っている)
//
// 【'pending' で閉じてよい理由】
//   setDoc を呼んだ時点で書き込みは端末の待ち行列(IndexedDB)に入っている。
//   送れていない事は ①画面の帯 ②タブを閉じる時の警告(beforeunload)
//   ③「新しい版が出ました」の関所(window.__appCanReload) の3つが見張る。
//   ⚠ 'error' は違う。**待ち行列にも入っていない**ので、閉じたら本当に消える。
//
// ⚠ React も Firebase も import しない。ここに import を足した瞬間に
//   node --test で確かめられなくなる(判定が誰にも確かめられなくなる)。
// ============================================================================

/** 保存の結果を待つ既定の長さ(ミリ秒)。⚠2026-08-17 の是正でこの値に決めた。 */
export const SETTLE_MS = 3000;

/**
 * 保存の約束を「少しだけ」待つ。
 *
 * @param {Promise|any} p   保存が返した約束(約束でない物が来たら 'ok' とみなす)
 * @param {number} ms       待つ長さ
 * @returns {Promise<'ok'|'error'|'pending'>}
 *
 * ⚠ 約束でない物を 'ok' にするのは、**呼ぶ側が約束を返し忘れている**場合に
 *   画面が永久に閉じなくなるのを避ける為。返し忘れ自体は
 *   scripts/verify-save-safety.mjs が別に見張る。
 */
export async function settleSaveBriefly(p, ms = SETTLE_MS) {
  if (!p || typeof p.then !== 'function') return 'ok';
  let timer = null;
  const r = await Promise.race([
    p.then(() => 'ok', () => 'error'),
    new Promise((res) => { timer = setTimeout(() => res('pending'), ms); }),
  ]);
  if (timer) clearTimeout(timer);
  return r;
}

/**
 * その結果で、画面を閉じて(または入力を片付けて)よいか。
 * 🚨 閉じてよいのは「届いた」か「待ち行列に入った」時だけ。
 *   拒否された時に閉じると、その記録は**どこにも残らない**。
 *
 * @param {'ok'|'error'|'pending'|any} result
 * @returns {boolean}
 */
export function mayCloseAfterSave(result) {
  return result !== 'error';
}

/** 拒否された時に人へ出す言葉。⚠「失敗しました」だけで終わらせない(次にどうするかを書く)。 */
export const SAVE_REFUSED_MESSAGE =
  '🚨 保存ができませんでした。画面は閉じません。\n\n'
  + '入力した内容はこの画面に残っています。\n'
  + '通信を確かめて、もう一度「保存」を押してください。';
