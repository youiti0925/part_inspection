// =============================================================================
// ✅ 計画の「保存」と「承認」を分ける(2026-09-22)。
// -----------------------------------------------------------------------------
// 🚨 「保存済み」を「承認済み」と呼ばない。保存は試算を棚に置いただけ。
//   状態は 4つ: 保存済み(記録なし) → 提出済み → 承認済み ／ 差戻し(→ また提出)。
//   承認済みの版は変えない。変更は次の版として保存し、前の版は「採用中でない」になる(後継版への切替)。
//
// 置き場: plan_reviews/{app}__v{n}(版1つに1件)。版の本体(plan_versions)は書いたら変えないので、
//   審査の記録は別の書類に **追記**(history に配列で。窓口の appendCapped = 取引で足すので後勝ちで消えない)。
//   誰が・いつ・どの版を・紙で確認したなら誰が、を全部 history の1件に持つ。
//
// 権限: 承認できるのは既存の権限管理の「管理者」(PIN)。画面のボタンの見せ方だけで決めない。
//   canTransition が isApprover を見て断る。呼ぶ側はこれを通してから書く。
//
// 🚨 純関数だけ。firebase も React も import しない。
// =============================================================================

export const REVIEW_STATUS = Object.freeze({
  SAVED: 'saved',           // 記録なし = 保存しただけ
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  RETURNED: 'returned',
});

export const REVIEW_LABELS = Object.freeze({
  saved: '保存済み（未提出）',
  submitted: '提出済み（承認待ち）',
  approved: '承認済み',
  returned: '差戻し',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** 審査の書類の id。 */
export const reviewDocId = (app, revision) => `${app}__v${revision}`;

/** 記録の一覧(古い順)。壊れた物は捨てず、読めない行として残す。 */
export function reviewHistoryOf(doc) {
  const list = isObj(doc) && Array.isArray(doc.history) ? doc.history : [];
  return list.map((h) => (isObj(h) ? h : { status: 'unreadable', by: '', at: null, note: '' }));
}

/** 今の状態 = 最後の記録。記録が無ければ 保存済み。 */
export function reviewStatusOf(doc) {
  const hist = reviewHistoryOf(doc);
  const last = hist.length ? hist[hist.length - 1] : null;
  return last && REVIEW_LABELS[last.status] ? last.status : REVIEW_STATUS.SAVED;
}

/** 最後の承認の記録(誰が・いつ)。無ければ null。 */
export function lastApprovalOf(doc) {
  const hist = reviewHistoryOf(doc);
  for (let i = hist.length - 1; i >= 0; i -= 1) if (hist[i].status === REVIEW_STATUS.APPROVED) return hist[i];
  return null;
}

/**
 * 状態の遷移が許されるか。
 * @param from 今の状態  @param to 次の状態
 * @param who { isApprover:boolean, canEdit:boolean }
 * @returns {{ ok:boolean, reason:string }}
 */
export function canTransition(from, to, { isApprover = false, canEdit = false } = {}) {
  const S = REVIEW_STATUS;
  if (!REVIEW_LABELS[to]) return { ok: false, reason: '知らない状態です' };
  if (to === S.SUBMITTED) {
    if (!canEdit) return { ok: false, reason: '編集できる人だけが提出できます' };
    if (from === S.SAVED || from === S.RETURNED) return { ok: true, reason: '' };
    if (from === S.SUBMITTED) return { ok: false, reason: '既に提出済みです' };
    return { ok: false, reason: '承認済みの版は提出し直せません。変更は次の版として保存してください' };
  }
  if (to === S.APPROVED || to === S.RETURNED) {
    if (!isApprover) return { ok: false, reason: '承認・差戻しは管理者だけができます' };
    if (from !== S.SUBMITTED) return { ok: false, reason: from === S.APPROVED ? '既に承認済みです' : '提出されていない版は承認・差戻しできません' };
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: '保存済みへは戻せません' };
}

/**
 * history に足す1件を作る。
 * @param status 次の状態  @param by 操作した人(currentUserName)  @param atMs 時刻
 * @param note 一言(差戻しの理由・条件)
 * @param paperApprover 紙で承認した時の確認者名(アプリで押した人とは別に残す)
 */
export function makeReviewRecord({ status, by, atMs, note = '', paperApprover = '' }) {
  if (!REVIEW_LABELS[status] || status === REVIEW_STATUS.SAVED) throw new Error('記録できる状態ではありません');
  const who = text(by);
  if (!who) throw new Error('誰が操作したかが分かりません（ログインしてください）');
  if (!Number.isFinite(atMs)) throw new Error('時刻が読めません');
  const rec = { status, by: who, at: atMs, note: text(note) };
  const paper = text(paperApprover);
  if (paper) { rec.onPaper = true; rec.paperApprover = paper; }
  return rec;
}

/**
 * 版の並びと審査の記録から、画面・帳票に出す札を作る。
 * @param revision その版  @param headRevision 採用中の版  @param doc その版の審査の書類
 */
export function reviewBadge({ revision, headRevision, doc }) {
  const status = reviewStatusOf(doc);
  const label = REVIEW_LABELS[status];
  const superseded = Number.isInteger(headRevision) && Number.isInteger(revision) && revision < headRevision;
  const approval = lastApprovalOf(doc);
  const approvedBy = approval ? (approval.onPaper ? `${approval.paperApprover}（紙）・記録 ${approval.by}` : approval.by) : '';
  return {
    status, label: superseded ? `${label}・採用中でない（第${headRevision}版へ切替）` : label,
    superseded, approvedBy, approvedAt: approval ? approval.at : null,
  };
}

/** 帳票へ出す1行。🚨 記録が無い時は「未承認」と書く(「保存済み」を承認にしない)。 */
export function reviewLineForReport(doc, { revision = null, headRevision = null } = {}) {
  const b = reviewBadge({ revision, headRevision, doc });
  if (b.status === REVIEW_STATUS.APPROVED) return `アプリ上の承認記録: 承認済み（${b.approvedBy}）${b.superseded ? '・現在は採用中でない' : ''}`;
  if (b.status === REVIEW_STATUS.SUBMITTED) return 'アプリ上の承認記録: 提出済み・承認待ち';
  if (b.status === REVIEW_STATUS.RETURNED) return 'アプリ上の承認記録: 差戻し';
  return 'アプリ上の承認記録: 未承認（保存のみ）';
}
