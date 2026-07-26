// ============================================================================
// データの置き場所を決める「地図」(保管庫に依存しない・純粋関数だけ)
// ----------------------------------------------------------------------------
// PocketBase移行 Phase M1。
// ⚠ここには firebase も pocketbase も import しない。テストできる状態を保つため。
//
// ⚠⚠ **単一の activeProvider は作らない。**
//   連絡ポータルは相手の携帯が 4G/5G だけで開く。社内PocketBaseへ移すと開けなくなり、
//   PBをインターネットへ公開する必要が出て今より危険になる。
//   だから「検査本体はPB・連絡はFirebase」を同時に成立させられる形にしておく。
//   → 保管庫は **機能領域(area)ごと** に決める。
// ============================================================================

/** 機能領域。ここに無い値は使わない。 */
export const AREAS = Object.freeze([
  'inspection',  // 検査本体(ロット・タスク・設定・作業者・テンプレ…)
  'attachments', // 中身が大きいファイル(写真・資料PDF)
  'analytics',   // 改善カルテ・分析の記録
  'goals',       // 年間目標(アプリ間で共有)
  'contact',     // 連絡(工程連絡・到着時刻・宛先グループ) ← Firebaseに残す予定
  'push',        // プッシュ通知の宛先トークン        ← Firebaseに残す予定
]);

/** 名前空間(Firestore の artifacts/{ここ}/public/data/...)。 */
export const NS = Object.freeze({
  product: 'product-inspection-v1',
  final: 'final-inspection-v1',
  parts: 'parts-inspection-v1',
  overview: 'overview-app-v1',
  goals: 'goal-shared-v1',
  contact: 'contact-shared-v1',
});

/** 検査アプリ自身の名前空間(= APP_DATA_ID になりうる値)。 */
export const APP_NAMESPACES = Object.freeze([NS.product, NS.final, NS.parts, NS.overview]);

/** アプリをまたいで共有している棚。 */
export const GOAL_NS = NS.goals;
export const CONTACT_NS = NS.contact;

/** 実在する名前空間の全部。ここに無い名前空間は書き込ませない(Firestoreルールと同じ一覧)。 */
export const KNOWN_NAMESPACES = Object.freeze(Object.values(NS));

// ----------------------------------------------------------------------------
// コレクション名 → 機能領域
// ⚠この一覧は **手で書き足さない**。src/data/__tests__/routes.test.mjs が
//   「アプリが実際に触っている全コレクションがここに載っているか」を機械的に照合する。
//   載っていないものが出たらテストが落ちる = 移行対象の取りこぼしに気づける。
// ----------------------------------------------------------------------------
export const COLLECTION_AREA = Object.freeze({
  // --- 検査本体 -------------------------------------------------------------
  lots: 'inspection',
  settings: 'inspection',
  workers: 'inspection',
  worker_settings: 'inspection',
  templates: 'inspection',
  target_time_history: 'inspection',
  notes: 'inspection',
  announcements: 'inspection',
  indirectWork: 'inspection',
  field_reports: 'inspection',
  skip_evidence: 'inspection',
  logs: 'inspection',
  strict_mode_history: 'inspection',
  minor_reports: 'inspection',
  controllers: 'inspection',
  motor_ledger: 'inspection',
  order_motors: 'inspection',
  spare_motors: 'inspection',
  accessory_refs: 'inspection',
  accessory_lists: 'inspection',
  rotaryCommands: 'inspection', // ⚠実際のコレクション名はキャメルケース(製品 App.jsx の ROTARY_CMD_COL)
  rotaryEvents: 'inspection',
  rotaryMeasurements: 'inspection', // 部品検査の分割測定結果
  observationPlans: 'inspection', // じっと見る(要素作業)の旧コレクション
  config: 'inspection',           // 司令塔③のマップ設定(overview-app-v1/config/mapConfig)

  // --- 中身が大きいファイル(1MB上限の対策で本体から外へ出したもの) -----------
  lot_images: 'attachments',
  help_images: 'attachments',
  work_standard_files: 'attachments',
  accessory_scan_images: 'attachments',
  video_recipes: 'attachments',

  // --- 分析・改善 -----------------------------------------------------------
  improvements: 'analytics',
  accessory_scan_logs: 'analytics',

  // --- 連絡(Firebaseに残す) ------------------------------------------------
  contact_requests: 'contact',
  arrival_times: 'contact',

  // --- プッシュ通知(Firebaseに残す) ----------------------------------------
  push_tokens: 'push',

  // --- 年間目標の棚の中身(goal-shared-v1 にしか無い) ------------------------
  weekly_briefs: 'goals',
});

/**
 * (名前空間, コレクション) から機能領域を決める。
 * ⚠コレクション名だけでは決まらない。`settings` は3つの名前空間にあり、
 *   それぞれ「検査の設定」「年間目標」「宛先グループ」で別物。
 */
export const areaOf = (ns, col) => {
  if (ns === GOAL_NS) return 'goals';
  if (ns === CONTACT_NS) return 'contact';
  return COLLECTION_AREA[col] || 'inspection';
};

/** 一覧に載っているコレクションか(移行前検査で使う)。 */
export const isKnownCollection = (ns, col) =>
  ns === GOAL_NS || ns === CONTACT_NS ||
  Object.prototype.hasOwnProperty.call(COLLECTION_AREA, col);

// ----------------------------------------------------------------------------
// 置き場所(パス)の組み立て
// ----------------------------------------------------------------------------
// Firestore が実際に受け付けない形だけを弾く。
// ⚠空白は正当なドキュメントID(型式名や作業者名がIDになる場所がある)。弾いてはいけない。
const badSegment = (v) =>
  typeof v !== 'string' ||
  v.length === 0 ||
  v.includes('/') ||
  v === '.' || v === '..' ||
  /^__.*__$/.test(v);

/**
 * artifacts/{ns}/public/data/{col}[/{id}] を配列で返す。
 * ⚠パスは配列で扱う。ドット区切りやスラッシュ結合にすると、型式名や指図番号に
 *   記号が入ったときに黙って別の場所へ書く(過去に実際にやっている)。
 */
export const dataPath = (ns, col, id) => {
  if (badSegment(ns)) throw new Error(`dataPath: 名前空間が不正です: ${JSON.stringify(ns)}`);
  if (badSegment(col)) throw new Error(`dataPath: コレクション名が不正です: ${JSON.stringify(col)}`);
  if (id === undefined || id === null) return ['artifacts', ns, 'public', 'data', col];
  const sid = typeof id === 'number' ? String(id) : id;
  if (badSegment(sid)) throw new Error(`dataPath: ドキュメントIDが不正です: ${JSON.stringify(id)}`);
  return ['artifacts', ns, 'public', 'data', col, sid];
};

// ----------------------------------------------------------------------------
// どの領域をどの保管庫で動かすか
// ----------------------------------------------------------------------------
/** Phase M1 の既定。全部 Firebase = 今と1バイトも変わらない。 */
export const DEFAULT_PROVIDERS = Object.freeze({
  inspection: 'firebase',
  attachments: 'firebase',
  analytics: 'firebase',
  goals: 'firebase',
  contact: 'firebase',
  push: 'firebase',
});

/** 移行後の想定(まだ使わない。形が破綻していないことをテストで見るためだけに置く)。 */
export const PLANNED_PROVIDERS = Object.freeze({
  inspection: 'pocketbase',
  attachments: 'pocketbase',
  analytics: 'pocketbase',
  goals: 'pocketbase',
  contact: 'firebase',
  push: 'firebase',
});

export const backendFor = (ns, col, providers = DEFAULT_PROVIDERS) => {
  const area = areaOf(ns, col);
  const b = providers[area];
  if (!b) throw new Error(`保管庫が決まっていません: area=${area} (${ns}/${col})`);
  return b;
};
