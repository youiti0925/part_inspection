// ============================================================================
// 📊 「今日、この端末がどれだけ読んで・どれだけ書いたか」を数える
// ----------------------------------------------------------------------------
// 何のために作ったか(2026-08-18):
//   2026-08-17、書き込みの1日の枠(20,000回)を使い切った。
//   その時に何が起きたかは実測で分かっている:
//     ・setDoc の返り値が **永久に返らない**。失敗にもならない。画面にも何も出ない。
//       (@firebase/firestore/dist/common-091f2944.esm.js:6028-6042 で
//        RESOURCE_EXHAUSTED を「一時エラー」と見なす → :15733-15738 で reject しない
//        → :15020-15023 で最大60秒間隔の無限再送 → :16982-16984 で Promise は
//        サーバの ack/reject まで解決しない)
//     ・つまり **await した保存が黙って消える**。これが作業記録が消えた事故の背骨。
//   → 枠に近づいている事を、**枠が尽きる前に** 出す。それがこのファイル。
//
// ⚠⚠ **数えるのは端末の中だけ。数える為に1回も通信しない。**
//   使用量を知る為に Firestore へ問い合わせたら、その問い合わせがまた枠を食う。
//   ここは純関数の入れ物で、実際に足し込むのは呼ぶ側(保存の関所)。
//
// ⚠⚠ **この端末の分しか数えられない。** 4つのアプリ(製品・最終・部品・司令塔)が
//   1つの Firebase プロジェクトを分け合っているので、本当の残りはここに出る数より
//   必ず少ない。**その事を数字と一緒に必ず言う**(QUOTA_SHARED_NOTE)。
//   少なく見せると、清水さんが「まだ余裕がある」と判断を誤る。
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ============================================================================

// ---------------------------------------------------------------------------
// 枠(無料枠の1日あたり)
// ---------------------------------------------------------------------------
/**
 * ⚠ **spec**(Firebase の無料枠として公表されている値)。私が数えて出した値ではない。
 *   実測したのは「2026-08-17 に書き込みが止まり、16:00 に戻った」という事実の方。
 */
export const QUOTA_LIMITS = {
  reads: 50000,
  writes: 20000,
  deletes: 20000,
};

/** 画面に出す名前。⚠「読み取り」「書き込み」だけだと現場で通じない。 */
export const QUOTA_LABELS = {
  reads: '読み取り（画面に出す為に取ってくる回数）',
  writes: '書き込み（保存した回数）',
  deletes: '削除（消した回数）',
};

/**
 * ⚠⚠ 数字と必ず一緒に出す断り書き。**これを外して数字だけ出さない。**
 */
export const QUOTA_SHARED_NOTE =
  'この数は、この端末が数えた分だけです。4つのアプリ（製品検査・最終検査・部品検査・司令塔）が'
  + '同じ枠を分け合っているので、本当の残りはこれより少ないはずです。';

// ---------------------------------------------------------------------------
// 🕓 いつ0に戻るか
// ---------------------------------------------------------------------------
// 🚨 **実測(2026-08-17)**: 日本時間 16:00 ちょうどに書き込みが通るようになった。
//   無料枠は「米国太平洋時間の 0:00」に戻るので、日本時間では
//     ・米国が夏時間(3月第2日曜〜11月第1日曜) … JST 16:00  ← 2026-08-17 はここ。実測済み
//     ・米国が冬時間(それ以外)               … JST 17:00  ← ⚠**未実測**。上の決まりから計算した推定
//   ⚠ 冬時間の 17:00 を「実測した」と言わない事。11月になったら実際に確かめる。
const JST_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 夏時間の時の戻る時刻(JST)。🚨2026-08-17 に実測。 */
export const QUOTA_RESET_JST_HOUR_DST = 16;
/** 冬時間の時の戻る時刻(JST)。⚠未実測(米国の夏時間の決まりから計算した推定)。 */
export const QUOTA_RESET_JST_HOUR_STD = 17;

/** その年・その月の n 番目の日曜の 0:00(UTC)。 */
const nthSundayUtc = (year, monthIdx0, n) => {
  const first = Date.UTC(year, monthIdx0, 1);
  const dow = new Date(first).getUTCDay();          // 0=日曜
  const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
  return Date.UTC(year, monthIdx0, day);
};

/**
 * 米国太平洋時間が夏時間か。
 * ⚠日にちの精度で足りる(16時か17時かを選ぶだけ)。切り替わる当日の数時間は多少ズレる。
 */
export const usPacificIsDst = (ms) => {
  const y = new Date(ms).getUTCFullYear();
  const start = nthSundayUtc(y, 2, 2) + 10 * HOUR_MS;   // 3月第2日曜 2:00 PST = 10:00 UTC
  const end = nthSundayUtc(y, 10, 1) + 9 * HOUR_MS;     // 11月第1日曜 2:00 PDT = 9:00 UTC
  return ms >= start && ms < end;
};

/** その時点で、枠が0に戻るのは日本時間の何時か。 */
export const quotaResetJstHour = (ms) =>
  (usPacificIsDst(ms) ? QUOTA_RESET_JST_HOUR_DST : QUOTA_RESET_JST_HOUR_STD);

/** 日本時間の年月日時分。⚠端末の時計の設定に左右されないよう UTC から自分で足す。 */
const jstParts = (ms) => {
  const d = new Date(ms + JST_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
};

const pad2 = (n) => String(n).padStart(2, '0');

/** いま入っている「枠の1日」が始まった時刻(ミリ秒)。 */
export const quotaDayStart = (nowMs = Date.now()) => {
  const now = Number(nowMs) || 0;
  const h = quotaResetJstHour(now);
  const dayIdx = Math.floor((now + JST_MS) / DAY_MS);
  let start = dayIdx * DAY_MS + h * HOUR_MS - JST_MS;
  // ⚠今日のその時刻がまだ来ていないなら、いま居るのは **前の日の枠**
  if (start > now) start -= DAY_MS;
  return start;
};

/** 次に0に戻る時刻(ミリ秒)。⚠夏時間の切り替え日は23時間/25時間になるので計算し直す。 */
export const quotaNextReset = (nowMs = Date.now()) => {
  const guess = quotaDayStart(nowMs) + DAY_MS;
  const h = quotaResetJstHour(guess);
  const dayIdx = Math.floor((guess + JST_MS) / DAY_MS);
  return dayIdx * DAY_MS + h * HOUR_MS - JST_MS;
};

/** 枠の1日の名前。⚠**暦の日付ではない**(16:00 で切り替わる)ので、始まった日で名前を付ける。 */
export const quotaDayKey = (nowMs = Date.now()) => {
  const p = jstParts(quotaDayStart(nowMs));
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
};

/** 「あと何時間で戻るか」。 */
export const hoursUntilReset = (nowMs = Date.now()) =>
  Math.max(0, (quotaNextReset(nowMs) - (Number(nowMs) || 0)) / HOUR_MS);

/** 人に出す「いつ戻るか」の言葉。 */
export const resetText = (nowMs = Date.now()) => {
  const h = quotaResetJstHour(nowMs);
  const left = hoursUntilReset(nowMs);
  const leftText = left >= 1
    ? `あと約${Math.round(left)}時間`
    : `あと約${Math.max(1, Math.round(left * 60))}分`;
  return `日本時間 ${h}:00 に0に戻ります（${leftText}）`;
};

// ---------------------------------------------------------------------------
// 数える入れ物
// ---------------------------------------------------------------------------
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const nonNeg = (v) => Math.max(0, Math.round(num(v, 0)));

/** まっさらな数え札。 */
export const emptyMeter = (nowMs = Date.now()) => ({
  dayKey: quotaDayKey(nowMs),
  startedAt: quotaDayStart(nowMs),
  firstAt: 0,      // 最初に1回でも数えた時刻(ペースの分母はここから)
  lastAt: 0,
  reads: 0,
  writes: 0,
  deletes: 0,
});

/**
 * 使った回数を足す。
 * ⚠⚠ **日付が変わっていたら0に戻す**(16:00 の境目)。呼ぶ側が気にしなくてよいよう、ここでやる。
 * @param meter いまの数え札
 * @param delta {reads?,writes?,deletes?} 足す回数
 */
export const countUse = (meter, delta = {}, nowMs = Date.now()) => {
  const key = quotaDayKey(nowMs);
  const base = (meter && meter.dayKey === key) ? meter : emptyMeter(nowMs);
  const add = {
    reads: nonNeg(delta.reads),
    writes: nonNeg(delta.writes),
    deletes: nonNeg(delta.deletes),
  };
  const any = add.reads + add.writes + add.deletes;
  return {
    dayKey: key,
    startedAt: base.startedAt || quotaDayStart(nowMs),
    firstAt: base.firstAt || (any ? Number(nowMs) || 0 : 0),
    lastAt: any ? (Number(nowMs) || 0) : (base.lastAt || 0),
    reads: nonNeg(base.reads) + add.reads,
    writes: nonNeg(base.writes) + add.writes,
    deletes: nonNeg(base.deletes) + add.deletes,
  };
};

/**
 * 日付だけ見て、変わっていたら0に戻す(足さない)。
 * ⚠画面を開きっぱなしのまま 16:00 をまたいだ時に使う。
 */
export const rollMeter = (meter, nowMs = Date.now()) =>
  ((meter && meter.dayKey === quotaDayKey(nowMs)) ? meter : emptyMeter(nowMs));

// ---------------------------------------------------------------------------
// しまう / 取り出す (⚠localStorage そのものはここでは触らない。純関数のままにする)
// ---------------------------------------------------------------------------
export const METER_STORAGE_KEY = 'quotaMeter.v1';

// 🚨 2026-08-18 修正: しまう時の時刻を **引数で受ける**。
//   前は中で Date.now() を呼んでいた = 「今」を外から差し替えられず、
//   試験(Q11)が壁の時計に引きずられて **本番と関係なく落ちる/通る** 状態だった。
//   ⚠純関数の中で Date.now() を直に呼ばない(一時停止中の録画で同じ失敗をした 2026-08-14)。
export const serializeMeter = (meter, nowMs = Date.now()) => JSON.stringify(rollMeter(meter, nowMs));

/** 文字列から戻す。壊れていたら まっさら。⚠日付が変わっていたら0に戻す。 */
export const parseMeter = (raw, nowMs = Date.now()) => {
  try {
    const o = JSON.parse(String(raw || ''));
    if (!o || typeof o !== 'object') return emptyMeter(nowMs);
    const m = {
      dayKey: String(o.dayKey || ''),
      startedAt: num(o.startedAt, 0),
      firstAt: num(o.firstAt, 0),
      lastAt: num(o.lastAt, 0),
      reads: nonNeg(o.reads),
      writes: nonNeg(o.writes),
      deletes: nonNeg(o.deletes),
    };
    return rollMeter(m, nowMs);
  } catch {
    return emptyMeter(nowMs);
  }
};

// ---------------------------------------------------------------------------
// 画面に出す形にする
// ---------------------------------------------------------------------------
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * ペースが当てになるまでの最短時間。
 * ⚠開いて10秒で「あと0.3時間で尽きます」と出すと、ただの脅しになる。
 *   起動直後は購読の初回読み取りがまとめて来るので、そこだけ見ると異常に速く見える。
 */
export const PACE_MIN_MINUTES = 5;

/** 何%からどう言うか。 */
export const LEVEL_ORDER = ['ok', 'watch', 'warn', 'danger'];
const worstLevel = (a, b) => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

/**
 * 1種類ぶんの見立て。
 * @returns {{key,label,used,limit,pct,perHour,hoursLeft,runsOutBeforeReset,level,text}}
 */
export const meterRow = (meter, key, nowMs = Date.now()) => {
  const m = rollMeter(meter, nowMs);
  const limit = QUOTA_LIMITS[key] || 0;
  const used = nonNeg(m[key]);
  const pct = limit ? r1((used / limit) * 100) : 0;
  const elapsedMs = (m.firstAt && nowMs > m.firstAt) ? (nowMs - m.firstAt) : 0;
  const enough = elapsedMs >= PACE_MIN_MINUTES * 60 * 1000;
  const perHour = enough ? Math.round(used / (elapsedMs / HOUR_MS)) : null;
  const left = Math.max(0, limit - used);
  // このペースであと何時間持つか。⚠ペースが当てにならない間は **数字を出さない**(null)。
  const hoursLeft = (perHour && perHour > 0) ? r1(left / perHour) : null;
  const toReset = hoursUntilReset(nowMs);
  const runsOutBeforeReset = hoursLeft != null && hoursLeft < toReset;

  let level = 'ok';
  if (pct >= 100) level = 'danger';
  else if (pct >= 80) level = 'warn';
  else if (pct >= 50) level = 'watch';
  if (runsOutBeforeReset) level = worstLevel(level, 'warn');

  const paceText = perHour == null
    ? `ペースはまだ測れません（${PACE_MIN_MINUTES}分以上使うと出ます）`
    : (hoursLeft == null
      ? `1時間あたり ${perHour}回`
      : `1時間あたり ${perHour}回 → このペースだと あと約${hoursLeft}時間で使い切ります`);

  return {
    key,
    label: QUOTA_LABELS[key] || key,
    used, limit, pct, perHour, hoursLeft,
    runsOutBeforeReset,
    level,
    text: `${QUOTA_LABELS[key] || key}: ${used} / ${limit}回（${pct}%）。${paceText}`,
  };
};

/**
 * 画面に出す一式。
 * @returns {{dayKey,level,rows,hoursToReset,resetText,headline,lines,note}}
 */
export const meterReport = (meter, nowMs = Date.now()) => {
  const m = rollMeter(meter, nowMs);
  const rows = ['reads', 'writes', 'deletes'].map((k) => meterRow(m, k, nowMs));
  const level = rows.reduce((acc, r) => worstLevel(acc, r.level), 'ok');
  const w = rows.find((r) => r.key === 'writes');

  let headline = '';
  if (level === 'danger') {
    headline = '🚨 1日の枠を使い切りました。保存が通らなくなります（黙って止まります）';
  } else if (level === 'warn') {
    headline = w && w.runsOutBeforeReset && w.pct < 80
      ? '⚠ このペースだと、枠が戻る前に使い切ります'
      : '⚠ 1日の枠の8割まで来ました';
  } else if (level === 'watch') {
    headline = '1日の枠の半分まで来ました';
  }

  return {
    dayKey: m.dayKey,
    level,
    rows,
    hoursToReset: r1(hoursUntilReset(nowMs)),
    resetText: resetText(nowMs),
    headline,
    lines: rows.map((r) => r.text),
    // ⚠⚠ 数字を出す時は必ずこれも一緒に出す
    note: QUOTA_SHARED_NOTE,
  };
};
