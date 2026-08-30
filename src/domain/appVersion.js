// ============================================================================
// 🆕 appVersion.js — 「新しい版が出ています → 押すと最新になる」の判定だけを置く所
// ============================================================================
//
// 【この物の役割】
//   ・いま動いている版と、サーバに置いてある版が違うかを **決めるだけ**。
//   ・画面も出さない・通信もしない・保存もしない。だから試験で全部確かめられる。
//   ⚠ React も Firebase も import しない。ここに import を足した瞬間に node --test が
//     動かなくなり、この判定は誰にも確かめられなくなる。
//
// 【なぜ Firestore を使わないか(2026-08-18)】
//   版の確認は「開いている全端末 × 1日中」繰り返す。ここに Firestore を使うと
//   読み取り枠を毎分焼く事になる(2026-08-17 に実際に書き込み枠を焼いた前科がある)。
//   → 版の印は **Hosting が配る静的ファイル(/version.json)** に置く。
//     Hosting の配信は Firestore の枠と無関係。読み書き 0 件で済む。
//
// 【なぜ index.html の中身を読み比べる方式から変えたか】
//   前の作りは毎回 /index.html(約20KB。説明文が長い)を丸ごと取って
//   DOMParser で <script> の名前を抜いていた。/version.json なら 100 バイト弱。
//   ⚠ ただし firebase.json の rewrites は「無い物には index.html を返す」書き方が
//     できてしまうので、**HTML が返ってきた時に「新しい版だ」と誤判定しない事**が
//     この模組の一番大事な仕事。parseVersionPayload がそれを見ている。
//
// 【勝手に切り替えない】
//   ここは「知らせてよいか」までしか決めない。読み直すかどうかは人が押した時だけ。
//   さらに canReload() が「まだ送れていない保存」がある間は押させない。
//   (2026-08-17: 送れていない書き込みを抱えた端末が閉じられて作業が消えた)
// ============================================================================

/** 版の印として認める文字の形。長すぎ/変な字は受け取らない(誤って別物を掴まない為)。 */
const BUILD_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * /version.json の中身を読む。
 *
 * @param {string|null|undefined} text  取ってきた本文
 * @param {string} [contentType]        Content-Type ヘッダ(あれば)
 * @returns {{ok:true, build:string} | {ok:false, reason:string}}
 *
 * ⚠ ok:false の時は **必ず「分からない」として扱う**。「違うから新しい版だ」ではない。
 *   rewrites の設定ミスで index.html(HTML) が 200 で返る事が実際に起きているので、
 *   ここで HTML を弾けないと、全端末に永久に「新しい版が出ました」が出続ける。
 */
export function parseVersionPayload(text, contentType = '') {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
  const head = text.trim().slice(0, 200).toLowerCase();
  // HTML が返ってきた = そのファイルは無い(rewrites に食われた)。絶対に版として読まない。
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<')) {
    return { ok: false, reason: 'html' };
  }
  if (contentType && /text\/html/i.test(contentType)) return { ok: false, reason: 'html' };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-object' };
  const build = obj.build;
  if (typeof build !== 'string' || !BUILD_ID_RE.test(build)) return { ok: false, reason: 'no-build' };
  // ⚠ builtAt は「いつ配られたか」を人に見せる為だけの物。**無くても版の判定は成立する**
  //   (古い版の version.json には入っていない)。無ければ空文字を返し、印から時刻を割り出す。
  const builtAt = typeof obj.builtAt === 'string' && obj.builtAt.length <= 40 ? obj.builtAt : '';
  return { ok: true, build, builtAt };
}

/**
 * 自分の版と、サーバの版を比べる。
 *
 * @param {string} mine   いま動いている版の印(index.html の <meta name="app-build">)
 * @param {string} theirs サーバの /version.json の build
 * @returns {{newer:boolean, reason:string}}
 *
 * ⚠ 新旧の大小は比べない(印は時刻順とは限らない)。**「違う」なら知らせる**だけ。
 *   巻き戻し(古い版に戻した)時も知らせたい。今の画面が本番と違う事に変わりはない。
 * ⚠ どちらかが空なら **知らせない**。空を「違う」と数えると、印を入れ忘れたビルドで
 *   全端末に出続ける。分からない時は黙る。
 */
export function compareBuild(mine, theirs) {
  if (typeof mine !== 'string' || !BUILD_ID_RE.test(mine)) return { newer: false, reason: 'mine-unknown' };
  if (typeof theirs !== 'string' || !BUILD_ID_RE.test(theirs)) return { newer: false, reason: 'theirs-unknown' };
  if (mine === theirs) return { newer: false, reason: 'same' };
  return { newer: true, reason: 'differs' };
}

/** 既定の間隔。⚠短くしない。開いている端末数 × 1日ぶん の通信が全部これに比例する。 */
export const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10分
/** 「あとで」を押された時に黙っている時間。 */
export const SNOOZE_MS = 30 * 60 * 1000; // 30分

/**
 * いま取りに行ってよいか。
 *
 * @param {object} s
 *   @param {number}  s.now           今の時刻(ms)
 *   @param {number}  s.lastCheckAt   前回取りに行った時刻(ms。まだなら 0)
 *   @param {boolean} s.notified      もう知らせを出しているか
 *   @param {boolean} s.hidden        画面が裏に回っているか(document.hidden)
 *   @param {boolean} s.online        通信できる状態か(navigator.onLine)
 *   @param {number}  s.snoozeUntil   「あとで」で黙る期限(ms)
 *   @param {boolean} s.hasBuildId    自分の版の印を持っているか
 *   @param {number} [s.intervalMs]
 * @returns {{check:boolean, reason:string}}
 */
export function shouldCheck(s) {
  const now = Number(s && s.now) || 0;
  const intervalMs = Number(s && s.intervalMs) > 0 ? Number(s.intervalMs) : CHECK_INTERVAL_MS;
  if (!s || !s.hasBuildId) return { check: false, reason: 'no-build-id' };
  if (s.notified) return { check: false, reason: 'already-notified' };
  // ⚠裏のタブでは取りに行かない。開きっぱなしのタブが何十枚もある現場で、
  //   見てもいない画面の為に通信するのは無駄でしかない。
  if (s.hidden) return { check: false, reason: 'hidden' };
  if (s.online === false) return { check: false, reason: 'offline' };
  if (Number(s.snoozeUntil) > now) return { check: false, reason: 'snoozed' };
  const last = Number(s.lastCheckAt) || 0;
  // ⚠時計が巻き戻る(端末の時刻合わせ)と now-last が負になり、下の「早すぎ」に
  //   永久に引っ掛かって二度と取りに行かなくなる。**先に**ここで逃がす。
  if (last > now) return { check: true, reason: 'clock-went-back' };
  if (last > 0 && now - last < intervalMs) return { check: false, reason: 'too-soon' };
  return { check: true, reason: 'due' };
}

/** 「あとで」を押された時の、黙る期限。 */
export function nextSnoozeUntil(now, snoozeMs = SNOOZE_MS) {
  return (Number(now) || 0) + (Number(snoozeMs) > 0 ? Number(snoozeMs) : SNOOZE_MS);
}

/**
 * 🚨 いま読み直してよいか。**まだサーバへ送れていない保存がある間は駄目**。
 *
 * @param {null|object} saveStatus  App の saveStatus と同じ形
 *   { unsent:number, fsPending:boolean, lotsPending:boolean }
 * @returns {{allowed:boolean, waiting:boolean, reason:string, label:string}}
 *
 * ⚠3本の合図の **OR**。1本でも「まだ」と言っているうちは読み直させない。
 *   どれか1本を「たぶん誤検知」と外した瞬間に、2026-08-17 と同じ穴になる。
 * ⚠ saveStatus が無い画面(撮影用の ?live= 等)は「分からない」ではなく「送る物が無い」。
 *   あの画面はロットを保存しないので、止めると永久に押せなくなる。
 */
export function canReload(saveStatus) {
  // 🚨🚨 2026-08-20: **画面が落ちた瞬間に関所が開く**穴を塞いだ。
  //   画面(App)は消える時に window.__appSaveStatus を片付ける。その後は null なので、
  //   ここが「保存の札が無い＝押してよい」と答えていた。
  //   つまり **落ちた瞬間＝未送信を抱えている、まさにその時**に押せてしまう。
  //   → 片付ける時は null ではなく { unknown: true } を置き、**分からない時は押させない**。
  //   ⚠null（一度も画面が動いていない＝?live= の撮影画面など）は今までどおり押してよい。
  //     そこを塞ぐと、保存する物が無い画面が永久に更新できなくなる。
  if (saveStatus && typeof saveStatus === 'object' && saveStatus.unknown === true) {
    return {
      allowed: false, waiting: true, reason: 'save-state-unknown',
      label: '保存の状態が分かりません（画面を開き直してから、もう一度お試しください）',
    };
  }
  if (!saveStatus || typeof saveStatus !== 'object') {
    return { allowed: true, waiting: false, reason: 'no-save-state', label: '' };
  }
  const n = Math.max(0, Number(saveStatus.unsent) || 0);
  const waiting = n > 0 || !!saveStatus.fsPending || !!saveStatus.lotsPending;
  if (!waiting) return { allowed: true, waiting: false, reason: 'all-sent', label: '' };
  return {
    allowed: false,
    waiting: true,
    reason: 'pending-writes',
    label: saveStatus.lotsPending
      ? `まだ送れていない検査記録があります${n > 0 ? `（${n}件）` : ''}`
      : `まだ送れていない保存があります${n > 0 ? `（${n}件）` : ''}`,
  };
}

/**
 * 取ってきた本文から「知らせを出すか」までを1本で決める。
 * 画面側はこれ1つを呼べばよい(判定の枝を画面側に散らさない為)。
 *
 * @returns {{notify:boolean, build:string, reason:string}}
 */
export function decideFromPayload(mine, text, contentType = '') {
  const parsed = parseVersionPayload(text, contentType);
  if (!parsed.ok) return { notify: false, build: '', builtAt: '', reason: parsed.reason };
  const cmp = compareBuild(mine, parsed.build);
  return { notify: cmp.newer, build: parsed.build, builtAt: parsed.builtAt, reason: cmp.reason };
}

// ============================================================================
// 🕒 「いつ配られた版か」を人が読める形にする
// ----------------------------------------------------------------------------
// 清水さん(2026-08-19)「作業者としてはいつ更新されたかわからないから」。
//   → 知らせに **2つの時刻** を出す: ①新しい版が配られた時刻 ②いま開いている画面の版の時刻。
// ⚠ 版の印は vite.config.js の makeBuildId が作る「YYYYMMDD-HHMMSS[-gitの短いハッシュ]」。
//   ここは **その形をそのまま読むだけ**。印の作り方を変えるなら両方直す事(試験 V50 が落ちる)。
// ⚠ 時刻は端末の地方時で出す(現場は日本だけ)。分からない時は **空文字**を返し、
//   画面はその行を出さない。**推測した時刻を出さない**。
// ============================================================================

/** 版の印から「焼いた時刻(ms)」。読めなければ 0。 */
export function parseBuildTime(buildId) {
  if (typeof buildId !== 'string') return 0;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(buildId);
  if (!m) return 0;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  // ⚠ Date は 13月や32日を黙って繰り上げる。**繰り上がった=読めていない**ので 0 を返す。
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d
    || dt.getHours() !== h || dt.getMinutes() !== mi) return 0;
  return dt.getTime();
}

/** 「2026/8/19 23:40」。0 や 読めない値なら空文字。 */
export function formatBuildTime(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 版の印(と、あれば version.json の builtAt)から、人に見せる時刻を作る。
 * ⚠ builtAt が読めればそちらを使う(こちらが本物の時刻)。読めなければ印から割り出す。
 * ⚠ どちらも駄目なら **空文字**。画面はその行を出さない。
 */
export function buildTimeText(buildId, builtAt = '') {
  if (typeof builtAt === 'string' && builtAt) {
    const t = Date.parse(builtAt);
    if (Number.isFinite(t) && t > 0) return formatBuildTime(t);
  }
  return formatBuildTime(parseBuildTime(buildId));
}

// ============================================================================
// 🔇 取りに行って失敗が続く時 — 黙って間隔を伸ばす(騒ぎ続けない)
// ----------------------------------------------------------------------------
// ⚠ 失敗しても画面には何も出さない。出しても現場には直せない上に、
//   「読めない札」が出続けると本物の知らせまで読まれなくなる。
// ⚠ 伸ばし方に **上限**を付ける。上限が無いと、一時的な不通のあと二度と見に行かなくなる。
// ============================================================================
/** 何回続けて失敗したら、そこで伸ばすのをやめるか。10分 × (1+6) = 最長70分に1回。 */
export const MAX_BACKOFF_STEPS = 6;

/** 失敗が n 回続いた時の、次に取りに行くまでの間隔。 */
export function backoffMs(intervalMs, fails) {
  const base = Number(intervalMs) > 0 ? Number(intervalMs) : CHECK_INTERVAL_MS;
  const n = Math.max(0, Math.min(MAX_BACKOFF_STEPS, Math.floor(Number(fails) || 0)));
  return base * (1 + n);
}
