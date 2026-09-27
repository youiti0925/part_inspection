// =============================================================================
// 🚚 別エリアへ「仕事を移す」案を **共有棚** に置く(2026-09-22)。routeStore(IndexedDB=端末内)の置き換え。
// -----------------------------------------------------------------------------
// 🚨 端末内に置くと、隣の端末は「移動案があった事」を知らない(決まり 2026-07-17: 人の判断を端末に置かない)。
// 置き場: capacity-shared-v1/route_drafts/{ownerArea}__{taskKey の短い指紋}。
//   版(revision)を持ち、書く時は「期待した版のままなら」の取引(claimOnce)。後勝ちで消えない。
//
// 🚨 移動先の「担当者・技能・勤務・設備・既存の仕事」は、共有棚に **在る物だけ** を使う。
//   今 在る物: 各エリアの採用中の計画(plan_versions)= 既存の仕事(誰が・いつ)。
//   無い物: 各エリアの計算の入力(sim_input は書く側が繋がっていない)・設備台帳・工程の対応表・部品検査の操業シミュ。
//   → 無い物は「未接続」と名指しで言う。推測で「計算済み」にしない(docs/エリア移動_データ契約.md)。
//
// 🚨 純関数だけ。firebase を import しない。
// =============================================================================
import { AREAS, validateDraft } from './workRouting.js';
import { shortHash } from '../planControl/planConditions.js';
import { assignmentsFromPlan } from '../planControl/fieldOrders.js';
import { routeInputsFacts, routeInputsLines } from './routeInputs.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 棚の書類 id。taskKey は JSON の文字列で長いので指紋にする(id に / や [ を入れない)。 */
export const routeDocId = (ownerArea, taskKey) => `${ownerArea}__${shortHash(String(taskKey))}`;

/**
 * 棚の移動案の窓口。
 * @param io.readDoc(id)                    … 1件(無ければ null)。🚨 控えを見ないサーバ読み
 * @param io.writeDoc(id, doc, expectRevision) … 期待した版のままなら書く。{ ok:boolean, reason:'taken'|'missing'|'error'|'' }
 */
export function makeRouteShelfStore({ readDoc, writeDoc } = {}) {
  if (typeof readDoc !== 'function' || typeof writeDoc !== 'function') throw new Error('移動案の棚の口が渡されていません');
  return {
    async read(id) {
      const raw = await readDoc(id);
      if (!raw) return null;
      const { revision, ...draft } = raw;
      return { ...validateDraft(draft), revision: Number(revision) || 0 };
    },
    /** 保存。expectRevision が今の版と違えば ok:false(別の端末が先に書いた)。 */
    async save(draft, expectRevision = 0) {
      const d = validateDraft(draft);
      const id = routeDocId(d.ownerArea, d.taskKey);
      const r = await writeDoc(id, { ...d, revision: (Number(expectRevision) || 0) + 1 }, Number(expectRevision) || 0);
      if (!r || !r.ok) return { ok: false, reason: r && r.reason === 'taken' ? '別の端末が先に移動案を書き替えました。読み直してください' : (r && r.reason) || '保存できませんでした' };
      return { ok: true, saved: { ...d, revision: (Number(expectRevision) || 0) + 1 } };
    },
  };
}

/**
 * 移動先の判断に使える「事実」を棚から組み立てる。無い物は missing に名前で。
 * @param adoptedPlans { product?: plan|null, final?: plan|null, parts?: plan|null } 各エリアの採用中の版(無ければ null)
 * @returns { reservations, coveredAreas, missing:[{area, what, why}], complete:false }
 */
export function routeFactsFromShelf({ adoptedPlans = {}, routeInputs = {}, whenMs = null } = {}) {
  const reservations = [];
  const covered = [];
  const missing = [];
  const inputs = {};   // area -> routeInputsFacts(ある日の働ける人・休み・技能の共有の有無)
  for (const area of Object.keys(AREAS)) {
    const plan = adoptedPlans[area];
    if (isObj(plan) && Array.isArray(plan.tasks)) {
      covered.push(area);
      for (const a of assignmentsFromPlan(plan)) {
        reservations.push({ ownerArea: area, taskKey: a.planKey, workerId: a.worker, partnerId: a.partner || null, equipmentId: null, startMs: a.startMs, endMs: a.endMs });
      }
    } else {
      missing.push({ area, what: '既存の仕事', why: area === 'parts' ? '部品検査には操業シミュレーション(採用中の計画)がありません' : `${AREAS[area]}の採用中の計画が共有棚にありません(保存されていない)` });
    }
    // 🚚 2026-09-22 相手の daily_load.routeInputs(勤務時間・休み・技能の記録)。在れば事実、無ければ名指し
    const rf = routeInputsFacts({ inputs: routeInputs[area], whenMs });
    if (rf) inputs[area] = rf;
    else missing.push({ area, what: '作業者の勤務時間・技能', why: area === 'parts' ? '部品検査には操業シミュレーションが無く、勤務時間・技能の共有がありません' : `${AREAS[area]}の計算がまだ共有棚(daily_load.routeInputs)に載っていません(向こうの工場が計算を回すと載ります)` });
    if (rf && !rf.eligibleShared) missing.push({ area, what: '技能の記録', why: `${AREAS[area]}の技能の記録(工程 → 名前)がまだ共有されていません` });
    missing.push({ area, what: '設備', why: '設備台帳(台の id・置き場・使える工程・稼働時間)がありません' });
  }
  missing.push({ area: '全体', what: '工程の対応表', why: '製品(step.id)・最終(カテゴリ__項目名)・部品 の工程の身元を結ぶ表がありません。技能の対応を推測しません' });
  return { reservations, coveredAreas: covered, missing, inputs, complete: false };
}

/** 移動先のある日の事実の行(routeInputs から。推測しない)。 */
export function routeInputsLinesOf(facts, area) {
  const rf = facts && facts.inputs && facts.inputs[area];
  return rf ? routeInputsLines(rf, AREAS[area] || area) : [];
}

/** 画面に出す「なぜ計算できないか」の行(重複を除いて短く)。 */
export function routeFactsLines(facts) {
  const seen = new Set();
  const out = [];
  for (const m of (facts && facts.missing) || []) {
    const key = `${m.what}|${m.why}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${m.what}: ${m.why}`);
  }
  return out;
}

/** 移動先で同じ人が同じ時間に既に仕事を持っているか(採用中の版の事実だけ)。 */
export function workerBusyAt(facts, workerName, startMs, endMs) {
  return ((facts && facts.reservations) || []).filter((r) => (r.workerId === workerName || r.partnerId === workerName) && r.startMs < endMs && startMs < r.endMs);
}
