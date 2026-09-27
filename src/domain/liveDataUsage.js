// ============================================================================
// 📊 「10分撮ったら / 20分撮ったら どれくらい使うのか」の表
//
// なぜ作ったか(2026-08-16 清水さん):
//   「今は**作業標準と作業の例として見る**なかで、**あまりカクカクだと使えない**のも事実、
//     それでも**あんまり容量使ったらいつか限界くる**のも事実、
//     その辺を**判断するためにも表が必要**だし」
//
// ⚠⚠ この表の値は **どこから来た数字なのかを必ず言う**。
//   ・measured … このリポジトリで実測した値
//   ・spec     … 設定にそう書いてある値(ビットレート)から算数で出した値
//   ・typical  … 一般に言われている値。**私が実測した物ではない**
//   数字だけ出して「測った物」と思われると、清水さんが判断を誤る。
//   (2026-07-10「元データに無い値を推測で埋めて事実として出すな」の再発防止)
//
// ⚠MBは端末の画面と同じ数え方(1024)で出す。通信会社の言う「GB」とは少し違う。
// ============================================================================

import {
  FRAME_SPEEDS, frameSpeedOf, FRAME_MAX_W, FRAME_QUALITY,
  FS_WRITES_DAY, RELAY_WRITE_BUDGET_DAY, RELAY_HARD_CAP_DAY, RELAY_TARGET_HOURS_DAY,
  VIEW_PING_MS, PREVIEW_FRAMES, writesPerHour, pingWritesPerHour, relayHoursInBudget,
} from './liveSession.js';
import { REC_QUALITIES, recMbPerMin } from './liveRecording.js';
import { quotaDayKey, QUOTA_LIMITS } from './quotaMeter.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * コマ送り1枚の大きさ(KB)。
 *
 * 🚨🚨 2026-08-17 に **26.4 → 53.7 へ直した(表が約2倍 過小だった)**。
 *   26.4KB は **640x360・画質0.5** で測った値。中継はその後 2026-08-16 に
 *   **1280px・画質0.7** へ上がった(FRAME_MAX_W / FRAME_QUALITY)のに、
 *   表の数字だけ古いまま残っていた。
 *   → 清水さんが「10分とったら何MB」を判断する表なので、**少なく言うのが一番困る**。
 *
 * ⚠⚠ 53.7KB は **実測**(2026-08-16)。工場に近い細かい絵(細かい模様＋文字＋影)を
 *   1280px に描いて `toDataURL('image/jpeg', 0.7)` の実バイト数を数えた値。
 *   同じ数字が liveSession.js のコメントと liveSession の試験(L23)にも残っている。
 */
export const FRAME_KB_DETAIL = 53.7;
/** ⚠記録用: 前の設定(640x360・画質0.5)の実測値。**いまの設定ではない。** */
export const FRAME_KB_DETAIL_640_Q50 = 26.4;
/**
 * のっぺりした絵の1枚(KB)。
 * ⚠⚠ **640x360・画質0.5 での実測**。いまの 1280px・画質0.7 では **測っていない**。
 *   表の既定には使わない(使うと、また少なく言う事になる)。
 */
export const FRAME_KB_FLAT = 2.1;

/** 表に出す時間(分)。⚠清水さんの「10分とったら 20分とったら」に合わせる。 */
export const USAGE_MINUTES = [1, 5, 10, 20, 30, 60];

/**
 * 📸 コマ送り(いまの中継)の通信量。
 * @returns {{perMinMb, mb, fps, writes, source}}
 *   writes … Firestore へ書く回数。⚠**使用量(お金)に効くのはここ**。
 */
export const relayUsage = (speedKey, minutes, kbPerFrame = FRAME_KB_DETAIL) => {
  const sp = frameSpeedOf(speedKey);
  const min = Math.max(0, num(minutes, 0));
  const fps = 1000 / Math.max(1, sp.everyMs);
  const perMinMb = (kbPerFrame * fps * 60) / 1024;
  return {
    fps: r1(fps),
    perMinMb: r1(perMinMb),
    // 📶 送る通信
    netMb: r1(perMinMb * min),
    // 💾 後に残る容量。⚠コマ送りは **同じ書類を上書きし続ける** ので、残るのは枚数ぶんだけ。
    //   撮り終わると消す(dropFrames)ので、実質ゼロに近い。
    keepMb: r1((kbPerFrame * sp.slots) / 1024),
    // ⚠見る人がいれば、その人数ぶん **読み取り** も起きる。書く回数だけでは足りない。
    writes: Math.round(fps * 60 * min),
    source: 'measured',   // 1枚の大きさは実測、掛け算は算数
  };
};

/**
 * 🎥 なめらかな中継(WebRTC)の通信量。
 * ⚠⚠ **typical**。私が実測した値ではない。実際に繋いで測るまで「目安」と出す事。
 *   640x360 30コマ/秒 の映像は、一般に 0.5〜0.8Mbps 程度と言われる。
 *   ここでは **多い方(0.8Mbps)** を既定にする(少なめに言わない)。
 * ⚠通り道が違う: 端末どうしの直接なので **Firestore をほぼ使わない**(最初の顔合わせだけ)。
 */
export const SMOOTH_MBPS = 0.8;
export const smoothUsage = (minutes, mbps = SMOOTH_MBPS) => {
  const min = Math.max(0, num(minutes, 0));
  const perMinMb = (num(mbps, SMOOTH_MBPS) * 1_000_000 / 8) * 60 / (1024 * 1024);
  return {
    fps: 30,
    perMinMb: r1(perMinMb),
    netMb: r1(perMinMb * min),
    keepMb: 0,            // ⚠見ている間だけ。**後に何も残らない**
    writes: 0,            // ⚠顔合わせの数回だけ。数え方が別なので0で出す
    source: 'typical',
  };
};

/**
 * 💾 録画そのものが Drive に食う容量。
 * ⚠**spec**。設定のビットレートから算数で出した値(実ファイルを測った物ではない)。
 */
export const recordUsage = (qualityKey, minutes) => {
  const perMin = recMbPerMin(qualityKey);
  const min = Math.max(0, num(minutes, 0));
  const size = r1(perMin * min);
  return {
    perMinMb: perMin,
    netMb: size,     // 📶 Driveへ上げる時の通信(1回)
    keepMb: size,    // 💾 ⚠Driveに **ずっと残る**
    viewMb: size,    // 👀 ⚠**見る人1人につき毎回** これだけ流れる
    source: 'spec',
  };
};

/** 数字の出どころを、画面にそのまま出す言葉に。 */
export const SOURCE_LABEL = {
  measured: '実測',
  spec: '設定から計算',
  typical: '一般的な目安（未実測）',
};

/**
 * 画面に出す表を、まるごと作る。
 *
 * ⚠⚠ **通信量と保存容量は別物**。混ぜて1つの表にすると判断できない(清水さん 2026-08-16)。
 *   ・送る通信 … 撮る側(スマホ)が使う通信量
 *   ・残る容量 … 後に残る物。中継は **何も残らない**(見ている間だけ)。録画は Drive にたまる
 *   ・見る通信 … **見る人1人につき** かかる通信量。⚠録画は **見るたび毎回** かかる
 *
 * ⚠⚠ 「いつか限界が来る」のは主に **残る容量** と **見る通信×人数**。
 *   中継をどれだけ使っても後には残らない。ここを分けないと、締める所を間違える。
 *
 * @returns {{minutes, rows:[{key,label,note,fps,source,kind,cells:[{min,netMb,keepMb,viewMb}]}]}}
 */
export const usageTable = (minutes = USAGE_MINUTES) => {
  const mins = (Array.isArray(minutes) ? minutes : USAGE_MINUTES).map(m => Math.max(0, num(m, 0)));
  const mk = (key, kind, label, note, calc) => {
    const one = calc(1);
    return {
      key, kind, label, note, fps: one.fps ?? null, source: one.source,
      perMinMb: one.netMb,
      cells: mins.map(m => calc(m)),
    };
  };
  const rows = [
    mk('smooth', 'live', '🎥 なめらか（30コマ/秒）', '端末どうし直接。⚠Firebaseをほぼ使わない・後に何も残らない',
      (m) => { const u = smoothUsage(m); return { min: m, netMb: u.netMb, keepMb: 0, viewMb: u.netMb, fps: 30, source: u.source, writes: 0 }; }),
    ...Object.values(FRAME_SPEEDS).map(sp => mk(
      `relay:${sp.key}`, 'live',
      `📸 コマ送り ${sp.label.split('（')[0]}`,
      `1秒に${r1(1000 / sp.everyMs)}コマ。⚠**Firebaseに毎分${Math.round(60000 / sp.everyMs)}回書く**`
      + `（中継に使ってよい${RELAY_WRITE_BUDGET_DAY.toLocaleString()}回で **約${relayHoursInBudget(sp.everyMs)}時間** ぶん）・後に何も残らない`,
      (m) => { const u = relayUsage(sp.key, m); return { min: m, netMb: u.netMb, keepMb: u.keepMb, viewMb: u.netMb, fps: u.fps, source: u.source, writes: u.writes }; })),
    ...Object.keys(REC_QUALITIES).map(k => mk(
      `rec:${k}`, 'record', `💾 録画 ${REC_QUALITIES[k].label}`,
      '⚠Driveに **ずっと残る**。しかも **見る人1人ごとに毎回** 同じだけ通信する',
      (m) => { const u = recordUsage(k, m); return { min: m, netMb: u.netMb, keepMb: u.keepMb, viewMb: u.viewMb, fps: null, source: u.source, writes: 0 }; })),
  ];
  return { minutes: mins, rows };
};

/**
 * 何人が何回見たら、通信がどれだけになるか。
 * ⚠⚠ 録画は **1回上げて終わり** ではない。**見るたびに毎回** 同じだけ流れる。
 *   10分の「ふつう」を20人が見ると 370MB×20 = 7.2GB。ここが見落とされやすい。
 */
export const watchTotalMb = (viewMb, people, timesEach = 1) =>
  r1(Math.max(0, num(viewMb, 0)) * Math.max(0, num(people, 0)) * Math.max(0, num(timesEach, 1)));

/** MB / GB を読める形に。⚠1024で数える(端末の画面と揃える)。 */
export const mbText = (mb) => {
  const v = Math.max(0, num(mb, 0));
  if (v < 1) return `${Math.round(v * 1024)} KB`;
  if (v < 1024) return `${r1(v)} MB`;
  return `${r1(v / 1024)} GB`;
};

/**
 * ⚠使う人に出す注意。**多い方から順に**出す(見落とすと困る順)。
 * @param plan {mode:'smooth'|'relay', speedKey, minutes, metered:boolean}
 */
export const usageWarnings = (plan = {}) => {
  const out = [];
  const min = Math.max(0, num(plan.minutes, 0));
  const u = plan.mode === 'smooth' ? smoothUsage(min) : relayUsage(plan.speedKey, min);
  if (plan.metered && u.netMb >= 100) {
    out.push(`⚠ 使い放題でない回線では ${mbText(u.netMb)} 使います（${min}分ぶん）`);
  }
  // ⚠⚠ お金ではなく **1日の枠** が先に効く。しかも枠は4アプリで分け合っている。
  if (u.writes > 0 && u.writes >= RELAY_WRITE_BUDGET_DAY * 0.2) {
    const pct = Math.round((u.writes / FS_FREE_WRITES_DAY) * 100);
    const rel = Math.round((u.writes / RELAY_WRITE_BUDGET_DAY) * 100);
    out.push(`⚠ Firebaseの1日の枠を ${pct}% 使います（${u.writes.toLocaleString()}回／枠は4アプリで分け合っています）`);
    out.push(`⚠ 中継に使ってよい分（${RELAY_WRITE_BUDGET_DAY.toLocaleString()}回）の ${rel}% です`
      + (u.writes >= RELAY_WRITE_BUDGET_DAY ? '。**これを超えると検査の記録が保存できなくなります**' : ''));
  }
  if (plan.mode === 'relay') {
    const sp = frameSpeedOf(plan.speedKey);
    const fps = 1000 / Math.max(1, sp.everyMs);
    if (fps < 15) out.push(`⚠ 1秒に${r1(fps)}コマです。手の動きを見せるにはカクカクします（なめらかは30コマ）`);
  }
  return out;
};

/** 画面に添える、いまの中継の作りの説明。⚠数字は上の定数から出す(手で書かない)。 */
export const relayNote = () =>
  `いまの中継は「写真を1枚ずつ送る」作りです（幅${FRAME_MAX_W}px・画質${FRAME_QUALITY}）。`
  + `1枚 約${FRAME_KB_DETAIL}KB（実測）で、**1枚＝Firebaseへの書き込み1回**です。`
  + `回線が速くてもコマ数は増えません（時計仕掛けで送るため）。`
  + `⚠2026-08-17から、**録画していない間・見ている人がいない間・なめらかな中継で映っている間は1枚も送りません**`
  + `（画角合わせのぶん${PREVIEW_FRAMES}枚だけ送ります）。`
  + `🚨さらに硬い上限として、**1日${RELAY_HARD_CAP_DAY.toLocaleString()}回（枠の2割）に達したらその日は送信を止めます**`
  + `（黙っては止まりません。撮影側にも視聴側にも理由が出ます）。`;

// ---------------------------------------------------------------------------
// 💴 使い放題でない回線で使った時の目安 と、枠がいつ切れるか
//
// ⚠⚠ 実測(2026-08-16 各社の公式ページ)。**税込**。
//   ・docomo / au / SoftBank 本体 … **1,100円 / 1GB**（追加データ）
//   ・ahamo / LINEMO           … 550円 / 1GB
//   ・mineo                    … 55円 / 100MB（＝550円/GB）
//   ⚠**超過を常態化させるくらいなら、使い放題に替える方が10分の1以下**。
//     楽天 3,278円/月・SoftBankテイガク無制限 5,148円/月(割引後) など。
//     表に出すのは「これだけ買うと高い」を分からせる為であって、買うのを勧める為ではない。
// ---------------------------------------------------------------------------
export const OVERAGE_YEN_PER_GB = 1100;   // 本体3社(税込)。少なめに言わない
export const OVERAGE_YEN_SUB = 550;       // ahamo / LINEMO / mineo

/** 超過して買い足した時のお金(円)。⚠1GB単位でしか買えないので **切り上げ**。 */
export const overageYen = (mb, yenPerGb = OVERAGE_YEN_PER_GB) =>
  Math.ceil(Math.max(0, num(mb, 0)) / 1024) * Math.max(0, num(yenPerGb, 0));

/**
 * その契約の枠が、何分もつか。
 * @returns {{minutes, hours, days8h, days1h}}
 */
export const planLasts = (perMinMb, planGb) => {
  const per = Math.max(0.0001, num(perMinMb, 0));
  const mb = Math.max(0, num(planGb, 0)) * 1024;
  const minutes = mb / per;
  return {
    minutes: Math.round(minutes),
    hours: r1(minutes / 60),
    days8h: r1(minutes / 480),   // 1日8時間つなぎっぱなし
    days1h: r1(minutes / 60),    // 1日1時間
  };
};

/**
 * ⚠⚠ **速度制限に落ちたら、この中継は動きません。**
 *   実測(2026-08-16): 3.2MB/分 を運ぶには **約427kbps** 要る。
 *   128kbps … 必要量の30%しか運べない（各社の上限超過後はこれが多い）
 *   300kbps … 70%。どちらも足りず「原因不明で止まる」ように見える
 *   → **回線が絞られている事を検知して、軽い方へ落とし、そう画面に出す**必要がある。
 */
export const KBPS_LIMITS = [
  { kbps: 128, label: '上限を超えた後（128kbps）' },
  { kbps: 300, label: '上限を超えた後（300kbps）' },
  { kbps: 1000, label: '1Mbps' },
  { kbps: 5000, label: '5Mbps' },
];
/** その速さで、1分あたり何MB運べるか。 */
export const carryMbPerMin = (kbps) => r1((Math.max(0, num(kbps, 0)) * 1000 / 8) * 60 / (1024 * 1024));
/** その速さで足りるか。 */
export const fitsIn = (perMinMb, kbps) => carryMbPerMin(kbps) >= num(perMinMb, 0);

// ---------------------------------------------------------------------------
// 🔥 Firebaseの1日の枠 — ⚠⚠ **お金より、こちらが先に効く**
//
// 実測(2026-08-16 公式ページ):
//   ・書き込み **20,000回/日** まで無料。読み取り 50,000回/日。
//   ・⚠⚠ この枠は **プロジェクト全体で1つ**。うちは **4アプリで1つのFirebaseを共有**している。
//     = コマ送りが枠を食い切ると、**製品・最終・部品・司令塔の全部が書き込めなくなる**。
//   ・料金そのものは安い(東京 2回/秒・1日1時間・月22日で **年580円ほど**)。
//     つまり **止まるかどうかが問題で、お金は問題ではない**。
//
// ⚠「1つの書類は毎秒1回まで」は **今のFirestoreの決まりではない**(古いDatastoreの制限)。
//   いまの公式見解は「負荷次第。試して測れ」。slots で散らすのは無駄ではないが、
//   **1日の枠の方が先に効く**事を忘れない。
// ---------------------------------------------------------------------------
/** ⚠数字の持ち主は liveSession.js。**ここで書き直さない**(2か所で違う数字が出る)。 */
export const FS_FREE_WRITES_DAY = FS_WRITES_DAY;
/** ⚠数字の持ち主は quotaMeter.js。**ここで書き直さない**(2か所で違う数字が出る)。
 *  2026-08-18 まで 50000 を直書きしていた(この行だけ持ち主の決まりを守れていなかった)。 */
export const FS_FREE_READS_DAY = QUOTA_LIMITS.reads;
// ⚠中継の予算も liveSession.js が持ち主。ここからは素通しするだけ(表と画面が同じ数字を見る)。
export { RELAY_WRITE_BUDGET_DAY, RELAY_HARD_CAP_DAY, RELAY_TARGET_HOURS_DAY };

// ---------------------------------------------------------------------------
// 🚨 中継が枠をどれだけ使うか — **「1日どれだけ使えるか」から逆算する**
//
// ⚠⚠ 2026-08-17 まで、既定は「なんとなく1秒ごと」だった。
//   1秒ごと = 3,600回/時 → 20,000回の枠を **5.6時間** で焼き切る。
//   しかも録画していなくても、誰も見ていなくても送っていた。
//
// いまの決め方(全部この下の式から出す。画面で掛け算しない):
//   ① 中継に使ってよい枠 … 10,000回/日 (RELAY_WRITE_BUDGET_DAY)
//      ⚠残りは検査の作業(実測 1,100〜4,700回/日)と、テンプレ/連絡/司令塔に要る
//   ② 1日に送る時間の目標 … 4時間 (RELAY_TARGET_HOURS_DAY)
//   ③ ①÷② = 1コマ1.44秒より速くできない → **既定は2秒ごと**
// ---------------------------------------------------------------------------
/** その速さで送り続けた時の 1時間あたりの書き込み回数(コマ送りだけ)。 */
export const relayWritesPerHour = (speedKey) => writesPerHour(frameSpeedOf(speedKey).everyMs);
/**
 * 👀「見ています」の印が1時間に増やす回数と、それで止まる回数の **釣り合い**。
 * ⚠⚠ 「印を書くと書き込みが増えるのでは？」に、数字で答えられるようにしておく。
 * @returns {{pingPerHour, framePerHour, ratio, netPerHour}}
 */
export const viewPingBalance = (speedKey) => {
  const ping = pingWritesPerHour();
  const frame = relayWritesPerHour(speedKey);
  return {
    pingPerHour: ping,
    framePerHour: frame,
    // 印1回ぶんの元が取れる倍率(何倍おトクか)
    ratio: Math.round((frame / Math.max(1, ping)) * 10) / 10,
    // 誰も見ていない1時間で、差し引き何回減るか
    netPerHour: frame - ping,
  };
};
/**
 * 🚨 中継の枠が、その速さで **何時間もつか**。
 * @param viewers 同時に送っているスマホの台数(⚠2台なら半分の時間で尽きる)
 * @returns {{hours, budgetHours, writesPerHour}}
 */
export const relayLastsHours = (speedKey, devices = 1, budget = RELAY_WRITE_BUDGET_DAY) => {
  const n = Math.max(1, Math.round(num(devices, 1)));
  const per = (relayWritesPerHour(speedKey) + pingWritesPerHour()) * n;
  return {
    writesPerHour: per,
    // 中継に使ってよい分でもつ時間
    budgetHours: r1(Math.max(0, num(budget, 0)) / Math.max(1, per)),
    // 枠を全部使い切ってよい場合(⚠検査の記録が保存できなくなるので、あくまで参考)
    hours: r1(FS_FREE_WRITES_DAY / Math.max(1, per)),
  };
};

// ---------------------------------------------------------------------------
// 📊🚨 **使った分を、その端末の中だけで数えて人に見せる**
//
// ⚠⚠ 数えるのに書き込みを1回も増やさない事。増やしたら本末転倒。
//   → 端末の中(localStorage)だけで数える。**保管庫には1文字も書かない。**
// ⚠日付は **枠が0に戻る区切り(日本時間16:00)** で数える。端末の暦の0時ではない。
// ---------------------------------------------------------------------------
// 🚨🚨 2026-08-18 修正: 中継の回数も **枠と同じ区切り(日本時間16:00)** で数える。
//   それまでは端末の暦の0時で数え直していた。枠が0に戻るのは米国西部の0時=日本時間16:00なので、
//   **夕方に食った分が夜0時に画面から消えていた** → 下の「あと約◯時間使えます」が
//   その分だけ甘くなる(=枠が尽きる時刻を実際より遅く言う)。
// ⚠日付の式の持ち主は quotaMeter.js。ここで書き直さない。
export const relayDayKey = quotaDayKey;
/** 端末の控えを読む。⚠日付が変わっていたら0から数え直す。 */
export const readDayCount = (store, key, nowMs) => {
  try {
    const raw = store && store.getItem ? store.getItem(key) : null;
    const o = raw ? JSON.parse(raw) : null;
    if (o && o.day === relayDayKey(nowMs)) return Math.max(0, Math.round(num(o.n, 0)));
  } catch { /* 壊れていたら0から */ }
  return 0;
};
/** 端末の控えに足す。⚠**戻り値が今日の合計**(画面はこれを出す)。 */
export const addDayCount = (store, key, nowMs, add = 1) => {
  const n = readDayCount(store, key, nowMs) + Math.max(0, Math.round(num(add, 1)));
  try { if (store && store.setItem) store.setItem(key, JSON.stringify({ day: relayDayKey(nowMs), n })); } catch { /* 控えられなくても数え続ける */ }
  return n;
};
/** 端末の控えの鍵。⚠役目ごとに分ける(撮る側のコマ / 見る側の印)。 */
export const RELAY_COUNT_KEY = 'live.relayWrites';
export const VIEWPING_COUNT_KEY = 'live.viewPings';

/**
 * 🚨 「今日この端末が中継で何回書いたか / 上限の何% / あと何時間使えるか」。
 * ⚠⚠ **あと何時間** まで出す。回数だけ出しても、現場は判断できない。
 * 🚨 2026-08-31: 分母を **硬い上限(RELAY_HARD_CAP_DAY=4,000回)** にした。
 *   ここに達すると frameSendPlan が実際に送信を止めるので、
 *   画面の分母と「本当に止まる線」が同じ数字になる(10,000で出すと 40% で止まって嘘になる)。
 * @returns {{writes, budget, pct, left, leftHours, over, text}}
 */
export const relayBudgetView = (writes, speedKey, budget = RELAY_HARD_CAP_DAY) => {
  const w = Math.max(0, Math.round(num(writes, 0)));
  const b = Math.max(1, Math.round(num(budget, RELAY_HARD_CAP_DAY)));
  const per = relayWritesPerHour(speedKey) + pingWritesPerHour();
  const left = Math.max(0, b - w);
  const leftHours = r1(left / Math.max(1, per));
  const over = w >= b;
  return {
    writes: w,
    budget: b,
    pct: Math.round((w / b) * 100),
    left,
    leftHours,
    over,
    // ⚠数字だけでなく、言葉でも1行にしておく(表に出せない所でも同じ言い方をする為)
    // ⚠上限に達した時は「あと何時間」ではなく **止めている事** を言う(黙って止まらない)。
    text: over
      ? `今日 ${w.toLocaleString()}回 / ${b.toLocaleString()}回（${Math.round((w / b) * 100)}%）・上限に達したので送信を止めています（検査の記録を守るため）`
      : `今日 ${w.toLocaleString()}回 / ${b.toLocaleString()}回（${Math.round((w / b) * 100)}%）・このまま録画を続けるとあと約${leftHours}時間`,
  };
};

/** 逆算の道すじを、そのまま画面に出せる形で返す。⚠数字を画面で作らない。 */
export const relayBudgetPlan = () => ({
  freeWrites: FS_FREE_WRITES_DAY,
  budget: RELAY_WRITE_BUDGET_DAY,
  // 🚨 硬い上限(安全弁)。ここに達すると frameSendPlan が実際に送信を止める。
  hardCap: RELAY_HARD_CAP_DAY,
  targetHours: RELAY_TARGET_HOURS_DAY,
  minEveryMs: Math.ceil((RELAY_TARGET_HOURS_DAY * 3600 * 1000) / RELAY_WRITE_BUDGET_DAY),
  pingEveryMs: VIEW_PING_MS,
  previewFrames: PREVIEW_FRAMES,
  hoursAt: Object.values(FRAME_SPEEDS).map((sp) => ({
    key: sp.key, everyMs: sp.everyMs, label: sp.label,
    perHour: writesPerHour(sp.everyMs),
    hours: relayHoursInBudget(sp.everyMs),
  })),
});

/**
 * コマ送りを続けたら、1日の書き込み枠が **何分でなくなるか**。
 * @param viewers 見ている人数(読み取りの枠にも効く)
 * @returns {{writeMin, readMin, firstOut, note}}
 */
export const freeQuotaLasts = (speedKey, viewers = 1) => {
  const sp = frameSpeedOf(speedKey);
  const perSec = 1000 / Math.max(1, sp.everyMs);
  const wMin = FS_FREE_WRITES_DAY / perSec / 60;
  const rMin = FS_FREE_READS_DAY / (perSec * Math.max(1, num(viewers, 1))) / 60;
  const firstOut = wMin <= rMin ? '書き込み' : '読み取り';
  return {
    writeMin: Math.round(wMin), readMin: Math.round(rMin),
    firstOut,
    note: `⚠1つのFirebaseを4アプリで分け合っているので、実際はもっと早く尽きます`,
  };
};

/** 「◯時間◯分」の形。 */
export const minText = (min) => {
  const m = Math.max(0, Math.round(num(min, 0)));
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
};

// ---------------------------------------------------------------------------
// 📶 「1GBで何時間つなげるか」
//
// ⚠Netflix が公式にこの言い方をしている(実測 2026-08-16):
//   「データ1GBあたり約4時間の視聴が可能」(自動) / 「約6時間」(節約) /
//   「20分で1GB以上」(最大)。**MB/分より、現場が判断しやすい。**
// ---------------------------------------------------------------------------
export const hoursPerGb = (perMinMb) => {
  const per = Math.max(0.0001, num(perMinMb, 0));
  return r1((1024 / per) / 60);
};

/** 「1GBで約◯時間」。1時間未満なら分で言う(「0.3時間」では判断できない)。 */
export const hoursPerGbText = (perMinMb) => {
  const h = hoursPerGb(perMinMb);
  return h >= 1 ? `1GBで約${h}時間` : `1GBで約${Math.round(h * 60)}分`;
};

/**
 * 📱 端末が「通信を節約したい」と言っているか。
 *
 * ⚠⚠ AndroidのデータセーバーとiOSの低データモードは、**ブラウザに伝わる**。
 *   `navigator.connection.saveData === true` がその合図(既定は false)。
 *   ⚠これが立っている人に、いきなり重い設定で始めない。
 *   ⚠ただし対応していないブラウザも多い(未対応なら false と同じ扱い＝勝手に軽くしない)。
 * ⚠**勝手に決めない。**「節約したいと出ているので、軽い方にしました」と画面に出して、
 *   その場で戻せるようにする事(黙って画質を落とすのが一番嫌われる)。
 */
export const wantsDataSaving = () => {
  try {
    const c = typeof navigator !== 'undefined' && navigator.connection;
    return !!(c && c.saveData === true);
  } catch { return false; }
};
