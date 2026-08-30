// ============================================================================
// 🚨 部品検査 ロット保存の線引き(どこまで通し、どこから止めるか)
// ----------------------------------------------------------------------------
// 判定そのものは 4アプリ共通の src/domain/workTimeGuard.js が行う。
// このファイルは **部品検査のどの操作を通すか** だけを決める。
// ⚠共通の見張りを部品検査の都合で書き換えない(md5が揃わなくなり、次に配った時に静かに巻き戻る)。
//
// なぜ線引きが要るか:
//   見張りは「時間を持つ記録が1件も残らない保存」を wipe(最重量)として止める。
//   これは 2026-08-17 に最終検査で起きた形そのものなので、絶対に止めなければならない。
//   ところが **記録が1件だけのロットで「最初から作業」を押した時** も同じ形になる。
//   そこまで止めると現場が使えず、見張りごと外される(それが一番危ない)。
//
// 見分け方(実測で確定 2026-08-17):
//   個々の損失が全部「控えの印(redoReset 等)つき」なら lostKeys が **0件** になる。
//     ・記録1件・印あり     → level=wipe / lostKeys 0 / 残り1件 → 人のやり直し。確認の上で通す
//     ・記録1件・印なし     → level=wipe / lostKeys 2 / 残り1件 → 止める
//     ・tasks:{} (8/12の形) → level=wipe / lostKeys 1 / 残り0件 → 止める
//   ⚠残りが0件(tasks そのものが消える形)は、印が有ろうと **絶対に通さない**。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/**
 * 見張りの判定結果から「どう扱うか」を決める。
 * @param res wouldLoseWorkTime(before, patch) の戻り
 * @returns { action: 'pass'|'confirm'|'block', allow: 'erase'|'wipe', why: string }
 *   pass    … そのまま通す(allow='erase' で erase/shrink は通る)
 *   confirm … 人に確認してから通す(allow='wipe')。断られたら保存しない
 *   block   … 確認も出さずに止める
 */
export const decideLotSave = (res) => {
  const pass = { action: 'pass', allow: 'erase', why: '' };
  if (!res || !res.lost) return pass;
  const counts = res.counts || {};
  const lostKeys = Array.isArray(res.lostKeys) ? res.lostKeys : [];
  if (res.level !== 'wipe' && res.level !== 'blank') {
    // erase / shrink は allow='erase' で通る。通した事は呼び元が画面に出す。
    return { action: 'pass', allow: 'erase', why: res.reason || '' };
  }
  // 🚨 tasks そのものが消える形は問答無用で止める(2026-08-17 の形)。
  if (res.level === 'blank' || !(Number(counts.afterTasks) > 0)) {
    return { action: 'block', allow: 'erase', why: res.reason || '' };
  }
  // 記録は残るが「時間を持つ物」が0件になる形。
  //   個々の損失が全部 控えの印つき(=lostKeys 0件) なら人のやり直し → 確認して通す。
  if (lostKeys.length === 0) {
    return { action: 'confirm', allow: 'wipe', why: res.reason || '' };
  }
  return { action: 'block', allow: 'erase', why: res.reason || '' };
};

/** 確認ダイアログに出す文。⚠「止めました」だけでは判断できないので件数を必ず入れる。 */
export const wipeConfirmMessage = (res) => {
  const c = (res && res.counts) || {};
  return `⚠ このロットで時間の記録が残っているのは ${Number(c.beforeWithTime) || 0}件 だけです。\n`
    + `この操作でその記録が 0件 になります。\n\n`
    + `「最初から作業」「該当なし解除」「取り消し」を押した場合はこれで正しいです（元の秒数は控えてあります）。\n`
    + `身に覚えが無い場合は「キャンセル」を押してください。\n\n続けますか？`;
};
