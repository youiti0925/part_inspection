// ============================================================================
// 👤 個人の稼働 — ① 曜日ごとの窓 ② その日の予定(有給・半休・出張・会議) ③ 残業の可否
// ----------------------------------------------------------------------------
// 清水さん(2026-09-09):
//   「個人直工比率と実際の稼働時間違ったら設定するのと(時短設定の人)、
//     各テンプレを優先的にするみたいな設定とか 他にも細かい設定できる状態にしておいてほしい」
//
// いま在るのは calendar.js の normalizeWorkerProfiles ただ1つ:
//     settings.workerProfiles[名前] = { dayStart, dayEnd, directRatio, templatePrefs }
//   これは「その人の窓は毎日おなじ」としか言えない。足りないのは次の3つ。
//     ① 曜日ごとの窓 … 週3勤務・水曜だけ時短
//     ② その日の予定 … 有給・半休・出張・会議
//     ③ 残業        … 残業に回してよい人か・1日何分まで
//
// 本番の写し(2026-09-10 01:00 · product-inspection-v1)で実測:
//     settings.workerProfiles … **鍵そのものが無い**(個人の窓の登録は 0人)
//     workers.json            … 4人(尾田・村・片山・信濃)。うち休止中1人(信濃)
//     settings.workerRoster   … 休みの表 31日ぶん・延べ35件(村31 / 信濃3 / 尾田1。other 27・off 8)
//     手が動いていた区間 6,215件(603ロット)の内訳:
//       尾田 4,518件 · 17:00より後に終わった 427件(9.5%) · 土日 1件 · 手が動いた日 63日
//       信濃   781件 · 17:00より後に終わった 133件(17.0%) · 土日 58件 · 手が動いた日 36日
//       片山   712件 · 17:00より後に終わった  59件(8.3%) · 土日 0件 · 手が動いた日 47日
//       村     180件 · 17:00より後に終わった   0件(0.0%) · 土日 0件 · 手が動いた日 7日
//     → 村さんは 6,215件のうち 1件も 17:00 より後に終わっていない(最も遅い終わりが 16:09)。
//       信濃さんは土日に 58件。尾田さんは 22:07 まで。**人によって稼働の形が違う**事は
//       実測で出ている。それを書き留める場所が今まで無かった、というのがこのファイル。
//
// 🚨 いまの登録は 0人。この形を足しても **登録が1件も無ければ答えは1ミリも変わらない**。
//   (下の 試験 W1 / W12 がそれを機械で押さえている)
//
// ⚠⚠ 決めるのは人。ここは「設定に書いてある事」を読むだけで、書いていない事を埋めない。
//   ・読めない値は **黙って丸めない・既定へ寄せない**。捨てて warnings に1行残す。
//     (清水さんが 9:30 と打ったつもりで '930' と保存された時、黙って 08:30 にすると
//      「設定したのに変わらない」画面になり、誰も気づけない)
//   ・3つとも読めなかった人は profiles に入れない = 登録なしと同じ。
//   ・factoryWindow を渡さなければ 窓は null で返る = 呼ぶ側は今までの道を通る。
//
// ⚠ このファイルは calendar.js を1バイトも変えない。読む作法(warnings の文, 'HH:MM' の
//   読み方, 窓の終わりを縮める向き)は calendar.js に揃えてある。配線は次の人がやる。
// ⚠ ここには React も firebase も import しない (node --test で回すため)。
// ⚠ 関数の中で いまの時刻・乱数を取らない。日付は必ず引数で受ける(同じ入力→同じ答え)。
// ============================================================================

/** その日の予定の種類。⚠ ここに無い言葉は捨てて warnings に残す(勝手に読み替えない)。 */
export const DAY_KINDS = Object.freeze({
  OFF: 'off',           // 終日の休み(有給など)
  HALF: 'half',         // 半休。窓の **後ろ半分** だけ働く(= 午前休と同じ)
  HALF_AM: 'half-am',   // 午前休。窓の後ろ半分
  HALF_PM: 'half-pm',   // 午後休。窓の前半分
  TRIP: 'trip',         // 出張
  MEETING: 'meeting',   // 会議
});

const DAY_KIND_SET = Object.freeze(new Set(Object.values(DAY_KINDS)));

/** 画面と warnings に出す言葉。⚠ 鍵の文字をそのまま人に見せない。 */
export const DAY_KIND_LABELS = Object.freeze({
  off: '休み',
  half: '半休',
  'half-am': '午前休',
  'half-pm': '午後休',
  trip: '出張',
  meeting: '会議',
});

/** 0=日 .. 6=土。warnings の文に使う。 */
export const WEEKDAY_LABELS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

/** 1人ぶんの その日の予定の上限。これを超えた分は捨てて warnings に1行(設定の壊れを黙って飲まない)。 */
const MAX_DAY_ENTRIES = 400;

/** 1日の残業の上限の上限。policy.js の overtimeDirectMinutesPerDay の max と同じ720分。 */
const MAX_OVERTIME_MIN_PER_DAY = 720;

/** note の長さの上限。長すぎる文字は画面を壊すので切る(切った事は warnings に出す)。 */
const MAX_NOTE_LEN = 200;

// ── 小道具 ───────────────────────────────────────────────────────────────────

/**
 * 'HH:MM' を 0時からの分へ。読めなければ null(例外にしない。1人の書き間違いで全員の計算を止めない)。
 * ⚠ calendar.js の中に同じ形の物が在るが、あちらは外へ出していないので写した。
 *   calendar.js を触れる人へ: あちらから export して、こちらを消して構わない。
 */
export const hhmmToMinOrNull = (text) => {
  if (typeof text !== 'string' || !/^\d{1,2}:\d{2}$/.test(text.trim())) return null;
  const [h, m] = text.trim().split(':').map(Number);
  if (!(h >= 0 && h <= 24) || !(m >= 0 && m < 60)) return null;
  return h * 60 + m;
};

/** 'YYYY-MM-DD' として読める文字だけ通す。2026-02-30 のような在り得ない日は null。 */
export const ymdOrNull = (text) => {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  // 🚨 引数付きの new Date。実行の度に値が変わる事は無い。
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return s;
};

/**
 * 'YYYY-MM-DD' の曜日(0=日..6=土)。読めなければ null。
 * ⚠ ローカル時刻で作る。UTC へ寄せると日付が1日ずれる(calendar.js の ymdOf と同じ理由)。
 */
export const weekdayOfYmd = (ymd) => {
  const s = ymdOrNull(ymd);
  if (s == null) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

/** 0..6 の整数だけ通す。'3' のような文字も通す(JSON の鍵は必ず文字になるため)。 */
const weekdayKeyOrNull = (k) => {
  const n = (typeof k === 'number' || (typeof k === 'string' && k.trim() !== '')) ? Number(k) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
};

/** 名前の見せ方を1か所に。warnings と why の文で同じ形にするため。 */
const who = (name) => `${String(name ?? '').trim() || '名前なし'}さん`;

// ── ① 設定の読み取り ─────────────────────────────────────────────────────────

/**
 * settings.workerProfiles に足した3つの欄を読む。
 *
 * 受ける形: { [名前]: {
 *     byWeekday?: { 0..6: { dayStart?:'HH:MM', dayEnd?:'HH:MM', off?:boolean } },
 *     days?: [{ ymd:'YYYY-MM-DD', kind:'off'|'half'|'half-am'|'half-pm'|'trip'|'meeting',
 *               note?:string, hours?:number }],
 *     overtime?: { allowed?:boolean, maxMinPerDay?:number },
 *   } }
 * 返す形:   { profiles: { [名前]: { byWeekday, days, overtime } }, warnings: string[] }
 *
 * 🚨 読めない値は捨てて warnings に1行。黙って既定へ寄せない。
 * ⚠ 3つとも無い(全部読めなかった)人は profiles に入れない = 登録なしと同じ。
 * ⚠ dayStart / dayEnd / directRatio / templatePrefs は **触らない**。あれは
 *   calendar.js の normalizeWorkerProfiles の持ち物。ここは新しい3つだけを見る。
 *
 * @param {object|null} raw settings.workerProfiles
 * @param {object} [o]
 * @param {string[]} [o.rosterNames] 名簿。渡した時は名簿に居ない名前を黙って外す
 *   (退職・休止の人の設定が残っていても警告で埋めない。normalizeWorkerProfiles と同じ作法)
 */
export function normalizeWorkerAvailability(raw, { rosterNames = null } = {}) {
  const profiles = {};
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { profiles, warnings };
  const allow = Array.isArray(rosterNames)
    ? new Set(rosterNames.map((n) => String(n ?? '').trim()).filter(Boolean))
    : null;

  for (const rawName of Object.keys(raw)) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    if (allow && !allow.has(name)) continue;
    const p = raw[rawName];
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;

    const byWeekday = readByWeekday(p.byWeekday, name, warnings);
    const days = readDays(p.days, name, warnings);
    const overtime = readOvertime(p.overtime, name, warnings);

    // ⚠ 3つとも無いなら登録なしと同じ。鍵を作ると「登録が在る」と数えてしまう。
    if (byWeekday == null && days == null && overtime == null) continue;
    profiles[name] = { byWeekday, days, overtime };
  }
  return { profiles, warnings };
}

/** ① 曜日ごとの窓。読めた曜日だけを返す。1つも読めなければ null。 */
function readByWeekday(rawByWeekday, name, warnings) {
  if (rawByWeekday == null) return null;
  if (typeof rawByWeekday !== 'object' || Array.isArray(rawByWeekday)) {
    warnings.push(`${who(name)}の曜日ごとの勤務 ${JSON.stringify(rawByWeekday)} が曜日と時刻の組ではないので使っていません`);
    return null;
  }
  const out = {};
  for (const key of Object.keys(rawByWeekday)) {
    const wd = weekdayKeyOrNull(key);
    if (wd == null) {
      warnings.push(`${who(name)}の曜日ごとの勤務の ${JSON.stringify(key)} は 0(日)〜6(土) ではないので使っていません`);
      continue;
    }
    const label = WEEKDAY_LABELS[wd];
    const v = rawByWeekday[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`${who(name)}の${label}曜の勤務 ${JSON.stringify(v)} が時刻の組ではないので使っていません`);
      continue;
    }

    // off は真偽値だけ。'はい' や 1 を休みと読み替えない。
    let off = false;
    if (v.off != null && v.off !== '') {
      if (typeof v.off === 'boolean') off = v.off;
      else warnings.push(`${who(name)}の${label}曜の「休み」 ${JSON.stringify(v.off)} が はい／いいえ ではないので使っていません`);
    }

    let dayStart = null;
    let dayEnd = null;
    if (v.dayStart != null && v.dayStart !== '') {
      const s = hhmmToMinOrNull(v.dayStart);
      if (s == null) warnings.push(`${who(name)}の${label}曜の勤務開始 ${JSON.stringify(v.dayStart)} が HH:MM の形ではないので使っていません`);
      else dayStart = String(v.dayStart).trim();
    }
    if (v.dayEnd != null && v.dayEnd !== '') {
      const e = hhmmToMinOrNull(v.dayEnd);
      if (e == null) warnings.push(`${who(name)}の${label}曜の勤務終了 ${JSON.stringify(v.dayEnd)} が HH:MM の形ではないので使っていません`);
      else dayEnd = String(v.dayEnd).trim();
    }
    // 逆順・長さ0は2つとも捨てる(normalizeWorkerProfiles と同じ扱い)。
    if (dayStart != null && dayEnd != null && !(hhmmToMinOrNull(dayEnd) > hhmmToMinOrNull(dayStart))) {
      warnings.push(`${who(name)}の${label}曜の勤務終了 ${dayEnd} が勤務開始 ${dayStart} より後ではないので、この2つを使っていません`);
      dayStart = null;
      dayEnd = null;
    }
    if (!off && dayStart == null && dayEnd == null) continue;   // その曜日は何も言っていない
    out[wd] = { dayStart, dayEnd, off };
  }
  return Object.keys(out).length ? out : null;
}

/** ② 有給・半休・出張・会議。日付順に並べて返す。1つも読めなければ null。 */
function readDays(rawDays, name, warnings) {
  if (rawDays == null) return null;
  if (!Array.isArray(rawDays)) {
    warnings.push(`${who(name)}の休み・出張・会議の一覧が並びの形ではないので使っていません`);
    return null;
  }
  let list = rawDays;
  if (list.length > MAX_DAY_ENTRIES) {
    warnings.push(`${who(name)}の休み・出張・会議が ${list.length}件 あります。多すぎるので先頭の ${MAX_DAY_ENTRIES}件 だけ使っています`);
    list = list.slice(0, MAX_DAY_ENTRIES);
  }

  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      warnings.push(`${who(name)}の休み・出張・会議に ${JSON.stringify(e)} が入っていますが、日付と種類の組ではないので使っていません`);
      continue;
    }
    const ymd = ymdOrNull(e.ymd);
    if (ymd == null) {
      warnings.push(`${who(name)}の休み・出張・会議の日付 ${JSON.stringify(e.ymd)} が YYYY-MM-DD の形ではないので使っていません`);
      continue;
    }
    const kind = String(e.kind ?? '').trim();
    if (!DAY_KIND_SET.has(kind)) {
      warnings.push(`${who(name)}の ${ymd} の種類 ${JSON.stringify(e.kind)} は ${Object.values(DAY_KIND_LABELS).join('・')} のどれでもないので使っていません`);
      continue;
    }
    if (seen.has(ymd)) {
      warnings.push(`${who(name)}の ${ymd} が2つ以上あります。先に書いてある1つだけ使っています`);
      continue;
    }

    // hours(時間)。出張・会議で「その日のうち何時間 取られるか」。
    // ⚠ 0以下・24超・数でない物は捨てる。捨てた時は「丸ごと外す」扱いになるので、それも1行残す。
    let hours = null;
    if (e.hours != null && e.hours !== '') {
      const h = Number(e.hours);
      if (!Number.isFinite(h) || !(h > 0) || !(h <= 24)) {
        warnings.push(`${who(name)}の ${ymd} の時間数 ${JSON.stringify(e.hours)} は 0 より大きく 24 以下の数ではないので使っていません`);
      } else {
        hours = h;
      }
    }
    if ((kind === DAY_KINDS.TRIP || kind === DAY_KINDS.MEETING) && hours == null) {
      // 🚨 分からない物を「0時間」と決めつけない。丸ごと外す方へ倒し、その事を必ず言う。
      warnings.push(`${who(name)}の ${ymd} の${DAY_KIND_LABELS[kind]}に時間数が入っていないので、その日は丸ごと外して数えています`);
    }

    let note = typeof e.note === 'string' ? e.note.trim() : '';
    if (note.length > MAX_NOTE_LEN) {
      warnings.push(`${who(name)}の ${ymd} の覚え書きが ${note.length}文字 あります。先頭の ${MAX_NOTE_LEN}文字 だけ使っています`);
      note = note.slice(0, MAX_NOTE_LEN);
    }

    seen.add(ymd);
    out.push({ ymd, kind, note, hours });
  }
  // 並びを日付で固める(同じ入力なら毎回同じ答えにするため)。
  out.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
  return out.length ? out : null;
}

/** ③ 残業。真偽値と分数だけ。読めなければ null(= 登録なし = 工場の決まりのまま)。 */
function readOvertime(rawOvertime, name, warnings) {
  if (rawOvertime == null) return null;
  if (typeof rawOvertime !== 'object' || Array.isArray(rawOvertime)) {
    warnings.push(`${who(name)}の残業の設定 ${JSON.stringify(rawOvertime)} が はい／いいえ と分数の組ではないので使っていません`);
    return null;
  }
  let allowed = null;
  if (rawOvertime.allowed != null && rawOvertime.allowed !== '') {
    // 🚨 'true' という文字や 1 を「はい」と読み替えない(打ち間違いを設定として飲み込まない)。
    if (typeof rawOvertime.allowed === 'boolean') allowed = rawOvertime.allowed;
    else warnings.push(`${who(name)}の残業の可否 ${JSON.stringify(rawOvertime.allowed)} が はい／いいえ ではないので使っていません`);
  }
  let maxMinPerDay = null;
  if (rawOvertime.maxMinPerDay != null && rawOvertime.maxMinPerDay !== '') {
    const n = Number(rawOvertime.maxMinPerDay);
    if (!Number.isInteger(n) || n < 0 || n > MAX_OVERTIME_MIN_PER_DAY) {
      warnings.push(`${who(name)}の1日の残業の上限 ${JSON.stringify(rawOvertime.maxMinPerDay)} は 0〜${MAX_OVERTIME_MIN_PER_DAY} の整数(分)ではないので使っていません`);
    } else {
      maxMinPerDay = n;
    }
  }
  // 「残業に回さない」と「1日60分まで」が両方書いてある時は、**きつい方**(回さない)を採る。
  if (allowed === false && maxMinPerDay != null && maxMinPerDay > 0) {
    warnings.push(`${who(name)}は残業に回さない設定なので、1日の上限 ${maxMinPerDay}分 は使っていません`);
    maxMinPerDay = 0;
  }
  if (allowed == null && maxMinPerDay == null) return null;
  return { allowed, maxMinPerDay };
}

// ── ② その日の窓 ─────────────────────────────────────────────────────────────

/**
 * calendar.js の normalizeWorkerProfiles の1人分と、このファイルの1人分を1つに合わせる。
 * workerWindowOn は「その人の窓(dayStart/dayEnd)」も見るので、呼ぶ側はここを通してから渡す。
 * ⚠ 元の2つは書き換えない(新しい物を作って返す)。どちらも無ければ null。
 */
export function mergeWorkerProfile(base, avail) {
  const b = (base && typeof base === 'object' && !Array.isArray(base)) ? base : null;
  const a = (avail && typeof avail === 'object' && !Array.isArray(avail)) ? avail : null;
  if (!b && !a) return null;
  return { ...(b || {}), ...(a || {}) };
}

/** { startMin, endMin } か { dayStart:'HH:MM', dayEnd:'HH:MM' } を分の組へ。読めなければ null。 */
const windowOrNull = (w) => {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const s = Number.isFinite(w.startMin) ? Number(w.startMin) : hhmmToMinOrNull(w.dayStart);
  const e = Number.isFinite(w.endMin) ? Number(w.endMin) : hhmmToMinOrNull(w.dayEnd);
  if (s == null || e == null) return null;
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return null;
  return { startMin: s, endMin: e };
};

const NO_WINDOW = Object.freeze({ startMin: null, endMin: null, off: false });

/**
 * その日その人が働ける窓(0時からの分)。
 *
 * 優先順: その日の予定(有給・半休・出張・会議) > 曜日ごとの窓 > その人の窓 > 工場一律。
 *
 * @param {object} o
 * @param {string} [o.name] 名前。why の文に出すだけ
 * @param {string} o.ymd 'YYYY-MM-DD'
 * @param {number} [o.weekday] 0(日)..6(土)。省略すると ymd から出す
 * @param {object|null} [o.profile] mergeWorkerProfile の戻り
 *   ({ dayStart, dayEnd, byWeekday, days, overtime })
 * @param {object|null} [o.factoryWindow] 工場一律の窓 { startMin, endMin } か { dayStart, dayEnd }
 * @returns {{startMin:number|null, endMin:number|null, off:boolean,
 *            source:'day'|'weekday'|'person'|'factory', why:string}}
 *   🚨 off が true の時、startMin と endMin は **null**。
 *      「休みなのに 0分〜0分 の窓が在る」と読み違えない為。
 *   🚨 factoryWindow を渡さず その人の窓も無い時も **null**。
 *      = 何も言っていない。呼ぶ側は今までどおり工場の区間を使う事(1ミリも変わらない)。
 */
export function workerWindowOn({ name = '', ymd = '', weekday = null, profile = null, factoryWindow = null } = {}) {
  const day = ymdOrNull(ymd);
  const wd = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
    ? weekday
    : weekdayOfYmd(day);

  const factory = windowOrNull(factoryWindow);
  const p = (profile && typeof profile === 'object' && !Array.isArray(profile)) ? profile : null;

  // ── 段1: その人の窓(毎日おなじ)。無い方は工場から借りる。
  const personStart = p ? hhmmToMinOrNull(p.dayStart) : null;
  const personEnd = p ? hhmmToMinOrNull(p.dayEnd) : null;
  let startMin = personStart != null ? personStart : (factory ? factory.startMin : null);
  let endMin = personEnd != null ? personEnd : (factory ? factory.endMin : null);
  let source = (personStart != null || personEnd != null) ? 'person' : 'factory';

  // ── 段2: 曜日ごとの窓。
  const wk = (p && p.byWeekday && wd != null) ? p.byWeekday[wd] : null;
  const wdLabel = wd != null ? `${WEEKDAY_LABELS[wd]}曜` : 'この曜日';
  if (wk) {
    if (wk.off) {
      return { ...NO_WINDOW, off: true, source: 'weekday', why: `${who(name)}は${wdLabel}が休みとして登録されています` };
    }
    const s = hhmmToMinOrNull(wk.dayStart);
    const e = hhmmToMinOrNull(wk.dayEnd);
    if (s != null) startMin = s;
    if (e != null) endMin = e;
    if (s != null || e != null) source = 'weekday';
  }

  // 何も分からないなら「何も言わない」。ここで工場の既定をでっち上げない。
  if (startMin == null || endMin == null || !(endMin > startMin)) {
    return {
      ...NO_WINDOW,
      source: 'factory',
      why: `${who(name)}の勤務の窓は登録がありません（工場一律のまま数えます）`,
    };
  }

  // ── 段3: その日の予定。ここが一番強い。
  const entry = (p && Array.isArray(p.days) && day != null)
    ? p.days.find((x) => x && x.ymd === day) || null
    : null;
  if (!entry) {
    const label = source === 'weekday' ? `${wdLabel}の勤務` : (source === 'person' ? '本人の勤務' : '工場一律の勤務');
    return { startMin, endMin, off: false, source, why: `${who(name)}の${day || 'この日'}は ${label} で数えています` };
  }

  const kindLabel = DAY_KIND_LABELS[entry.kind] || entry.kind;
  if (entry.kind === DAY_KINDS.OFF) {
    return { ...NO_WINDOW, off: true, source: 'day', why: `${who(name)}の${day}は${kindLabel}です${entry.note ? `（${entry.note}）` : ''}` };
  }

  // 半休は **その人の窓の半分**。工場の窓の半分ではない(時短の人を工場の尺で切らない)。
  const half = Math.round((endMin - startMin) / 2);
  if (entry.kind === DAY_KINDS.HALF || entry.kind === DAY_KINDS.HALF_AM) {
    return {
      startMin: startMin + half, endMin, off: false, source: 'day',
      why: `${who(name)}の${day}は${kindLabel}なので、本人の窓の後ろ半分だけ数えています`,
    };
  }
  if (entry.kind === DAY_KINDS.HALF_PM) {
    return {
      startMin, endMin: startMin + half, off: false, source: 'day',
      why: `${who(name)}の${day}は${kindLabel}なので、本人の窓の前半分だけ数えています`,
    };
  }

  // 出張・会議。時間数が入っていなければ **丸ごと外す**(0時間と決めつけない)。
  if (entry.hours == null) {
    return {
      ...NO_WINDOW, off: true, source: 'day',
      why: `${who(name)}の${day}は${kindLabel}で、時間数が入っていないので その日を丸ごと外しています`,
    };
  }
  // 取られる分は **窓の終わりを縮める**(始業は動かさない)。
  // calendar.js が直工比率で窓の終わりを縮めるのと同じ向きに揃えてある。
  const takenMin = Math.round(entry.hours * 60);
  const newEnd = endMin - takenMin;
  if (!(newEnd > startMin)) {
    return {
      ...NO_WINDOW, off: true, source: 'day',
      why: `${who(name)}の${day}は${kindLabel}が ${entry.hours}時間 で、その日の勤務の窓に収まらないので丸ごと外しています`,
    };
  }
  return {
    startMin, endMin: newEnd, off: false, source: 'day',
    why: `${who(name)}の${day}は${kindLabel}で ${entry.hours}時間 を外し、勤務の終わりを ${takenMin}分 縮めています`,
  };
}

// ── ③ 残業 ───────────────────────────────────────────────────────────────────

/**
 * その人に頼んでよい残業の分数。
 *
 * @param {object} o
 * @param {object|null} [o.profile] mergeWorkerProfile の戻り(overtime を見る)
 * @param {number} [o.needMin] 欲しい残業の分数
 * @returns {number} 0 以上の整数(分)
 *   ・登録なし        … needMin をそのまま返す(今までと1ミリも変わらない)
 *   ・allowed が false … **0**(この人は残業に回さない)
 *   ・maxMinPerDay 有り … needMin と上限の小さい方
 * ⚠ o には name を一緒に渡してよい(workerWindowOn と同じ形で呼べるように)。ここでは使わない。
 */
export function overtimeMinutesFor({ profile = null, needMin = 0 } = {}) {
  const want = Number(needMin);
  if (!Number.isFinite(want) || !(want > 0)) return 0;
  const asked = Math.round(want);
  const ot = (profile && typeof profile === 'object' && profile.overtime) ? profile.overtime : null;
  if (!ot) return asked;                                   // 登録なし = 工場の決まりのまま
  if (ot.allowed === false) return 0;                      // この人は残業に回さない
  if (ot.maxMinPerDay != null) return Math.min(asked, ot.maxMinPerDay);
  return asked;
}

/**
 * なぜその分数になったかの1行。画面の「根拠の札」に出す。
 * ⚠ 数字はここで作らない(overtimeMinutesFor の答えをそのまま並べるだけ)。
 */
export function describeOvertime({ name = '', profile = null, needMin = 0 } = {}) {
  const got = overtimeMinutesFor({ profile, needMin });
  const ot = (profile && typeof profile === 'object' && profile.overtime) ? profile.overtime : null;
  if (!ot) return `${who(name)}の残業は登録がありません（工場の決まりのまま ${got}分）`;
  if (ot.allowed === false) return `${who(name)}は残業に回さない設定なので 0分 です`;
  if (ot.maxMinPerDay != null) return `${who(name)}の残業は1日 ${ot.maxMinPerDay}分 までなので ${got}分 です`;
  return `${who(name)}は残業に回してよい設定です（${got}分）`;
}

// ── 画面の1行 ────────────────────────────────────────────────────────────────

/**
 * 画面の1行(「村 水曜は休み ／ 尾田 残業は1日60分まで」)。
 * normalizeWorkerAvailability の戻りの profiles を受ける。登録が無ければ ''。
 * ⚠ 数字はここで作らない(設定の写しをそのまま並べるだけ)。
 */
export function describeWorkerAvailability(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return '';
  const parts = [];
  for (const name of Object.keys(profiles)) {
    const p = profiles[name];
    if (!p) continue;
    const bits = [];
    if (p.byWeekday) {
      const offDays = [];
      const shorts = [];
      for (const k of Object.keys(p.byWeekday).sort((a, b) => Number(a) - Number(b))) {
        const v = p.byWeekday[k];
        const label = WEEKDAY_LABELS[Number(k)];
        if (v.off) offDays.push(label);
        else if (v.dayStart || v.dayEnd) shorts.push(`${label}曜 ${v.dayStart || '始業'}〜${v.dayEnd || '定時'}`);
      }
      if (offDays.length) bits.push(`${offDays.join('・')}曜は休み`);
      shorts.forEach((s) => bits.push(s));
    }
    if (p.days && p.days.length) bits.push(`休み・出張・会議 ${p.days.length}日`);
    if (p.overtime) {
      if (p.overtime.allowed === false) bits.push('残業に回さない');
      else if (p.overtime.maxMinPerDay != null) bits.push(`残業は1日 ${p.overtime.maxMinPerDay}分 まで`);
      else if (p.overtime.allowed === true) bits.push('残業に回してよい');
    }
    if (bits.length) parts.push(`${name} ${bits.join(' ')}`);
  }
  return parts.join(' ／ ');
}

/**
 * 登録の数え上げ。画面の札と、試験の「登録が0なら今までと同じ」の確かめに使う。
 * @returns {{people:number, weekday:number, days:number, overtime:number}}
 */
export function countWorkerAvailability(profiles) {
  const out = { people: 0, weekday: 0, days: 0, overtime: 0 };
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return out;
  for (const name of Object.keys(profiles)) {
    const p = profiles[name];
    if (!p) continue;
    out.people += 1;
    if (p.byWeekday) out.weekday += Object.keys(p.byWeekday).length;
    if (p.days) out.days += p.days.length;
    if (p.overtime) out.overtime += 1;
  }
  return out;
}
