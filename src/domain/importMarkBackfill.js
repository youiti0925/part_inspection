// ============================================================================
// 🏷📥 「取込の印」を後から付ける — 出どころを **根拠で** 分ける純関数
// ----------------------------------------------------------------------------
// 清水さん(2026-09-10):
//   「入荷登録Excelで作った176件に取込の印を後から付けますか」
//   →「納期が動かないのは変わるから、**印をつけるしかない**ね」
//
// 🚨 何のための印か:
//   src/domain/modelMasterPropagate.js の lotOriginOf は、型式マスタの日数を打ち替えた時に
//     lot.importSource === 'progress-sheet' … 進捗管理表のZ列(K33)の日数の差で納期を動かす
//     lot.importedFromExcel === true       … 入荷登録Excelの納期の日数の差で動かす
//     印が無い(手で登録した)ロット          … **納期は動かさない**
//   と分けている。本番の写し(2026-09-10 05:30)では **603件のロット全部に印が無い**
//   (importedFromExcel も importSource も欄ごと存在しない)。入荷登録Excelの確定が
//   印を書き始めたのが 2026-09-09 だから。だから未完了176件は全部「手で登録した扱い」で、
//   型式マスタを打ち替えても1件も動かない。
//
// 🚨🚨 いちばん大事な事: **176件を丸ごと印付けしてはいけない**。
//   本当に手で登録したロットにも印が付き、その後 型式マスタを打ち替えた時に
//   「動かさないはずの物」が動く。人が画面で直した納期を、機械が黙って上書きする事になる。
//   だからこのファイルの仕事は「印を付ける事」ではなく **根拠で分ける事**。
//
// ----------------------------------------------------------------------------
// 📐 本番の写しで数えてから決めた根拠(2026-09-10 05:30 / 未完了176件 = location arrival 160 + planned 16)
//
//   ◎ 強い根拠 ①「まとめて書かれた塊」の中に居る
//       入荷登録Excelの確定(App.jsx confirmLotImport)は for ループで1件ずつ続けて書き、
//       createdAt に **書いたその瞬間の Date.now()** を入れる。だから数十件が数十秒の中に並ぶ。
//       写しの実測: 30秒以内で切れ目なく続く塊が 4個 → 141件 / 26件 / 6件 / 1件。
//       141件が59秒 = 1件0.42秒。人が型式・テンプレ・台数・機番を打ち込める速さではない。
//       ⚠ 反証: 塊が2〜3件なら「人が続けて登録した」も在り得る。だから既定は5件から。
//
//   ◎ 強い根拠 ②「同じ指図が、同じ時に、別のテンプレでもう1件」
//       型式マスタの割り当てで **Excel 1行が複数テンプレへ展開される**(importPlan.planRowLots)。
//       手で登録する画面はテンプレを1つしか選べないので、この形は取込でしか出来ない。
//       写しの実測: 指図1001528140 が 0.3秒差で tpl 8muie0cso と 8xdfjifys の2件。
//
//   ○ 中くらいの根拠 ③ 入庫が「納期の N 日前 08:30 ちょうど」で再現できる
//       取込は 納期 − N日 → 工場が休みなら前の営業日 → 08:30 で入庫を作る(importPlan)。
//       写しの実測: 176件中 164件が 08:30:00.000 ちょうど。うち 164件全部が
//       N=0〜10 のどれかで再現できた(ずらしだけ / 営業日寄せ込み の両方を試した)。
//       🚨 反証(必ず counter に書く): **手で登録する画面も、日付だけ打って時刻を省くと 08:30 になる**
//         (App.jsx parseFlexibleDateTime の `hh = 8 / mi = 30`)。だから 08:30 だけでは決め手にならない。
//         この根拠は ①② と一緒の時だけ high に上げる。
//
//   ○ 反証(counter)になる根拠 ④ CREATE の記録が在る
//       logs コレクションの type:'CREATE' は **手で登録する道(1件ずつの登録)だけ** が書く。
//       取込の道は1件も書かない(App.jsx で 'CREATE' を書いている場所は1箇所だけ)。
//       写しの実測: 未完了176件のうち CREATE の記録が在るのは 1件だけ
//       (指図 K202508007 / 納期が空 / 入庫 20:38 / 塊に入っていない)= どう見ても手で登録した物。
//       🚨 だから「CREATE の記録が在る」は **印を付けない側の決め手** として使う。
//       ⚠ 反証の反証: 取込には「既に在るロットを上書きする道」も在る。手で登録した後に
//         Excel で上書きされたロットは、記録が在るのに入庫がExcelの形になる。
//         その時は言い切らず unknown(low)にして人に決めてもらう。
//
//   × 弱い根拠 ⑤ 機番が既定のまま(#1, #2, …)
//       写しの実測: 176件中 174件。**手で登録する画面も機番欄を空にすれば #1..#n になる**
//       (App.jsx の `serials.push(... || \`#${i + 1}\`)` は取込も手登録も同じ)。
//       ほぼ全件に付く上に両方の道で出るので、**単独では何の決め手にもならない**。
//       印を上げる材料にはせず、evidence に「弱い根拠」と書いて出すだけにする。
//
//   ・進捗管理表(progress-sheet)から来たロットは本番に **1件も居ない**。
//     あの道は必ず `dueDateProvisional` を書くが、写しの603件にこの欄は1つも無い。
//     それでも見分けは実装してある(欄が在れば progress-sheet)。
//
// ----------------------------------------------------------------------------
// ⚠ React も firebase も import しない(node --test で回すため)。
// ⚠ 関数の中で Date.now() を呼ばない。印を付けた時刻は **引数で貰う**。
// ⚠ 土日・祝日の判定を自分で書かない。工場の暦(factoryCalendar)1本だけを通す。
// ⚠ 既定の日数・時刻を直書きしない。importPlan.js の DEFAULT_IMPORT_OPTIONS ただ1つが持つ。
// 🚨 この関数は **1バイトも書かない**。書く形(patch)を作って返すだけ。
//    実際に書くかどうかは、人が一覧と件数を見て押してから。
// ============================================================================

import { makeIsWorkday, prevWorkdayYmd } from './factoryCalendar.js';
import { DEFAULT_IMPORT_OPTIONS, resolveEntriesForModel } from './importPlan.js';

/** ロットの出どころ。modelMasterPropagate.js が見る鍵と1ミリも同じ値。 */
export const IMB_ORIGIN = Object.freeze({
  ARRIVAL_EXCEL: 'arrival-excel',   // 入荷登録Excel。印 = importedFromExcel:true + importSource:'arrival-excel'
  PROGRESS_SHEET: 'progress-sheet', // 進捗管理表。印 = importedFromExcel:true + importSource:'progress-sheet'
  MANUAL: 'manual',                 // 手で登録した。**印は付けない**
  UNKNOWN: 'unknown',               // 根拠がぶつかっている / 足りない。**印は付けない**
});

/** どれくらい言い切れるか。high だけが既定で選ばれる。 */
export const IMB_CONFIDENCE = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

/** 印を付けられる出どころ(この2つ以外に印は付けられない)。 */
const MARKABLE = Object.freeze([IMB_ORIGIN.ARRIVAL_EXCEL, IMB_ORIGIN.PROGRESS_SHEET]);

/** 対象から外した理由。画面にそのまま出す文なので、ここ1箇所で持つ。 */
export const IMB_SKIP = Object.freeze({
  COMPLETED: '検査が終わっているロットです（これから納期が動く話ではないので印は付けません）',
  ALREADY_MARKED: 'すでに取込の印が付いています',
  NO_DATA: '型式も納期も入庫も入っていないロットです（何から来たのか読み取れません）',
  MANUAL: '手で登録したロットと読めます（印を付けると、人が直した納期を型式マスタが上書きします）',
  UNKNOWN: '取込から来たと言い切れる根拠がありません（人が1件ずつ見て決めてください）',
});

/** 印として書く欄。🚨 外す時も **この全部を書く**(merge は書かなかった鍵を消さない)。 */
export const IMB_MARK_KEYS = Object.freeze([
  'importedFromExcel',
  'importSource',
  'importMarkBackfilledAt',
  'importMarkEvidence',
]);

/**
 * 根拠の効き方の既定。🚨 画面から変えられるように、計算の中に数字を直書きしない。
 *   burstGapMs      … 「続けて書かれた」と見なす、隣り合う createdAt のすき間の上限
 *   burstMinSize    … 塊が何件から「人には無理な速さ」と見なすか
 *   twinWindowMs    … 同じ指図の別テンプレを「同じ取込」と見なす時間差の上限
 *   entryMaxDaysBefore … 入庫を「納期の N 日前」で再現する時に試す N の上限
 */
export const IMB_DEFAULTS = Object.freeze({
  burstGapMs: 30000,
  burstMinSize: 5,
  twinWindowMs: 30000,
  entryMaxDaysBefore: 8,
  // 作られてからこれ以上あとに書き換えられていたら「人が触った跡」として counter に出す。
  // 🚨 印を下げはしない(場所を動かしただけでも updatedAt は動く)。読む人に見せるだけ。
  touchedAfterMs: 86400000,
});

// ---------------------------------------------------------------------------
// 日付・時刻まわり(その土地の時刻で数える)
// 🚨 importPlan.js / modelMasterPropagate.js と **同じ結果** になるように、同じ形で書く。
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** number / Date / Firestore Timestamp({seconds,nanoseconds}) → epoch ms / 読めなければ null。 */
const msOf = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'object' && Number.isFinite(Number(v.seconds))) {
    return Number(v.seconds) * 1000 + Math.round(Number(v.nanoseconds || 0) / 1e6);
  }
  return null;
};

/** 'YYYY-MM-DD' → Date / 読めなければ null。⚠ new Date(文字列) は帯で1日ズレるので使わない。 */
const parseYMD = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  if (dt.getFullYear() !== +m[1] || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) return null;
  return dt;
};

/** Date → 'YYYY-MM-DD'(その土地の時刻)。 */
const fmtYMD = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;

/** 'YYYY-MM-DD' を days 日 **前** へずらす。⚠ importPlan.js の shiftYMD と同じ向き。 */
const shiftYMDBack = (ymd, days) => {
  const dt = parseYMD(ymd);
  if (!dt) return '';
  dt.setDate(dt.getDate() - (Number.isFinite(days) ? days : 0));
  return fmtYMD(dt);
};

/** 'HH:MM' → {hh,mm}。読めなければ 08:30。⚠ importPlan.js の parseHHMM と同じ。 */
const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return { hh: 8, mm: 30 };
  return { hh: Math.min(23, +m[1]), mm: Math.min(59, +m[2]) };
};

/** 'YYYY-MM-DD' + 'HH:MM' → epoch ms(その土地の時刻)。読めなければ null。 */
const ymdHHMMToMs = (ymd, hhmm) => {
  const dt = parseYMD(ymd);
  if (!dt) return null;
  const { hh, mm } = parseHHMM(hhmm);
  dt.setHours(hh, mm, 0, 0);
  return dt.getTime();
};

/** epoch ms がその土地の時刻で hhmm **ちょうど**(秒もミリ秒も0)か。 */
const isExactHHMM = (ms, hhmm) => {
  if (ms == null) return false;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return false;
  const { hh, mm } = parseHHMM(hhmm);
  return d.getHours() === hh && d.getMinutes() === mm && d.getSeconds() === 0 && d.getMilliseconds() === 0;
};

/** epoch ms → 'YYYY-MM-DD'(その土地の時刻) / 読めなければ ''。 */
const ymdOfMs = (ms) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : fmtYMD(d);
};

/** 型式名の揺れを吸収する。⚠ importPlan.js の normalizeModel と同じ形。 */
const normModel = (s) => String(s || '').toUpperCase().replace(/[\s\-_,.]/g, '');

const txt = (v) => String(v == null ? '' : v).trim();

/** 秒を人が読む形にする(1件0.42秒 のような割り算を画面で出すため)。 */
const secText = (msSpan) => {
  const s = Math.max(0, Number(msSpan) || 0) / 1000;
  return s >= 10 ? `${Math.round(s)}秒` : `${s.toFixed(1)}秒`;
};

// ---------------------------------------------------------------------------
// ロットの読み取り(欄が無い・型が違うロットでも落ちない)
// ---------------------------------------------------------------------------

/** ロットのID。写し(バックアップ)は __id しか持たない事がある。 */
export const lotIdOf = (lot) => txt(lot && (lot.id || lot.__id));

/** すでに取込の印が付いているか。⚠ modelMasterPropagate.lotOriginOf が見る鍵と同じ。 */
export const hasImportMark = (lot) =>
  !!lot && typeof lot === 'object' && (lot.importedFromExcel === true || txt(lot.importSource) !== '');

/** 検査が終わっているロットか(納期を動かす話ではないので対象外)。 */
export const isFinishedLot = (lot) => {
  if (!lot || typeof lot !== 'object') return false;
  if (txt(lot.status) === 'completed') return true;
  if (txt(lot.location) === 'completed') return true;
  return msOf(lot.completedAt) != null;
};

/** 型式も納期も入庫も無い「殻だけ」のロットか(写しに2件居た)。 */
const isEmptyShell = (lot) =>
  txt(lot && lot.model) === '' && txt(lot && lot.dueDate) === '' && msOf(lot && lot.entryAt) == null;

/** 機番が既定のまま(#1, #2, …)か。⚠ 弱い根拠。手で登録しても空欄なら同じ形になる。 */
const hasDefaultSerials = (lot) => {
  const a = lot && Array.isArray(lot.unitSerialNumbers) ? lot.unitSerialNumbers : null;
  if (!a || a.length === 0) return false;
  return a.every((s, i) => txt(s) === `#${i + 1}`);
};

// ---------------------------------------------------------------------------
// 一覧から作る索引(塊 / 同じ指図の別テンプレ)
// 🚨 索引は **渡されたロット全部** で作る。終わったロットも同じ取込の塊に居るため、
//    未完了だけで数えると塊が小さく見えて「人が登録した」と読み違える。
// ---------------------------------------------------------------------------

/**
 * @param {Array} lots 全ロット
 * @param {object} opt IMB_DEFAULTS を埋めた設定
 * @returns {{ burstOf: Map, twinOf: Map, createdCount: number, burstGroups: Array }}
 */
export function buildBackfillIndex(lots, opt = {}) {
  const o = { ...IMB_DEFAULTS, ...(opt || {}) };
  const list = (Array.isArray(lots) ? lots : []).filter(l => l && typeof l === 'object');

  const dated = list
    .map(l => ({ id: lotIdOf(l), t: msOf(l.createdAt), lot: l }))
    .filter(e => e.id && e.t != null)
    .sort((a, b) => a.t - b.t);

  // --- ① まとめて書かれた塊 -------------------------------------------------
  const burstOf = new Map();
  const burstGroups = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) {
      const info = Object.freeze({
        size: cur.length,
        spanMs: cur[cur.length - 1].t - cur[0].t,
        startMs: cur[0].t,
        endMs: cur[cur.length - 1].t,
      });
      burstGroups.push(info);
      for (const e of cur) burstOf.set(e.id, info);
    }
    cur = [];
  };
  for (const e of dated) {
    if (cur.length === 0 || e.t - cur[cur.length - 1].t <= o.burstGapMs) cur.push(e);
    else { flush(); cur = [e]; }
  }
  flush();

  // --- ② 同じ指図・同じ型式・同じ台数が、同じ時に別のテンプレでもう1件 -------
  const byOrder = new Map();
  for (const e of dated) {
    const k = txt(e.lot.orderNo);
    if (!k) continue;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(e);
  }
  const twinOf = new Map();
  for (const arr of byOrder.values()) {
    if (arr.length < 2) continue;
    for (const a of arr) {
      const mates = arr.filter(b =>
        b !== a
        && txt(b.lot.templateId) !== txt(a.lot.templateId)
        && normModel(b.lot.model) === normModel(a.lot.model)
        && Number(b.lot.quantity) === Number(a.lot.quantity)
        && Math.abs(b.t - a.t) <= o.twinWindowMs);
      if (mates.length) {
        twinOf.set(a.id, Object.freeze({
          count: mates.length,
          gapMs: Math.min(...mates.map(b => Math.abs(b.t - a.t))),
          templateIds: Object.freeze([...new Set(mates.map(b => txt(b.lot.templateId)))]),
        }));
      }
    }
  }

  return { burstOf, twinOf, createdCount: dated.length, burstGroups };
}

// ---------------------------------------------------------------------------
// 入庫が「納期の N 日前 08:30」で再現できるか
// ---------------------------------------------------------------------------

/**
 * @returns {{ days:number, weekendShift:boolean, movedTo:string }|null}
 *   null = 08:30ちょうどでない / 納期が無い / どの N でも作り直せない
 */
export function entryLooksComputed(lot, ctx = {}) {
  const hhmm = txt(ctx.entryHHMM) || DEFAULT_IMPORT_OPTIONS.entryHHMM;
  const t = msOf(lot && lot.entryAt);
  if (t == null || !isExactHHMM(t, hhmm)) return null;
  const due = txt(lot && lot.dueDate);
  if (!parseYMD(due)) return null;
  const works = makeIsWorkday(ctx.calendar || null);
  const max = Number.isFinite(Number(ctx.entryMaxDaysBefore)) ? Number(ctx.entryMaxDaysBefore) : IMB_DEFAULTS.entryMaxDaysBefore;

  const tryDays = (n) => {
    const plain = shiftYMDBack(due, n);
    if (!plain) return null;
    if (ymdHHMMToMs(plain, hhmm) === t) return { days: n, weekendShift: false, movedTo: plain };
    // 🚨 取込は「土日・祝日に落ちたら前の営業日へ寄せる」。寄せた後の日付とも比べる
    //    (この寄せは 2026-08-23 から。それより前に取り込んだロットは寄せていない形で残る)。
    const moved = prevWorkdayYmd(plain, works) || plain;
    if (moved !== plain && ymdHHMMToMs(moved, hhmm) === t) return { days: n, weekendShift: true, movedTo: moved };
    return null;
  };

  // 🚨 まず「本当に使われたはずの日数」で当てる。
  //   ここを飛ばして 0 から順に試すと、営業日へ寄せた分だけ小さい N が先に当たり、
  //   「納期の1日前」のような **実際とは違う根拠の文** を人に見せてしまう。
  const prefer = Number.isFinite(Number(ctx.preferDays)) ? Number(ctx.preferDays)
    : Number.isFinite(Number(ctx.defaultEntryDaysBefore)) ? Number(ctx.defaultEntryDaysBefore)
      : DEFAULT_IMPORT_OPTIONS.defaultEntryDaysBefore;
  if (prefer >= 0 && prefer <= max) {
    const hit = tryDays(prefer);
    if (hit) return hit;
  }
  for (let n = 0; n <= max; n++) {
    const hit = tryDays(n);
    if (hit) return hit;
  }
  return null;
}

/** 型式マスタに登録された「入庫は納期の何日前か」。登録が無ければ null。 */
export function registeredEntryDaysBefore(lot, ctx = {}) {
  const resolved = resolveEntriesForModel(
    { modelMasters: ctx.modelMasters, qualityStandards: ctx.qualityStandards, modelStandardMap: ctx.modelStandardMap },
    txt(lot && lot.model));
  if (!resolved || !Array.isArray(resolved.entries)) return null;
  const tpl = txt(lot && lot.templateId);
  const e = resolved.entries.find(x => txt(x && x.templateId) === tpl && tpl !== '');
  if (!e) return null;
  const v = e.entryDaysBefore;
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

// ---------------------------------------------------------------------------
// 1件を根拠で分ける
// ---------------------------------------------------------------------------

/**
 * ロット1件の出どころを **根拠で** 決める。
 *
 * @param {object} lot ロット
 * @param {object} ctx
 *   lots            全ロット(塊・別テンプレの相方を数えるのに要る)。索引を渡すなら不要
 *   index           buildBackfillIndex の戻り(何度も呼ぶなら1回だけ作って渡す)
 *   createLogBatchIds  logs の type:'CREATE' に載っている batchId の集まり(Set か配列)。
 *                   🚨 渡さないと「手で登録した印」を確かめられないので **high を出さない**
 *   modelMasters / qualityStandards / modelStandardMap  型式マスタ
 *   calendar        工場の暦
 *   entryHHMM / entryMaxDaysBefore / burstGapMs / burstMinSize / twinWindowMs
 * @returns {{ origin:string, confidence:string, evidence:string[], counter:string[] }}
 */
export function classifyImportOrigin(lot, ctx = {}) {
  const evidence = [];
  const counter = [];
  const l = lot && typeof lot === 'object' ? lot : {};
  const o = { ...IMB_DEFAULTS, ...(ctx || {}) };

  // すでに印が在るなら、推測せずその印をそのまま返す(推測で上書きしない)。
  if (hasImportMark(l)) {
    const src = txt(l.importSource);
    const origin = src === IMB_ORIGIN.PROGRESS_SHEET ? IMB_ORIGIN.PROGRESS_SHEET
      : (src === IMB_ORIGIN.ARRIVAL_EXCEL || l.importedFromExcel === true) ? IMB_ORIGIN.ARRIVAL_EXCEL
        : IMB_ORIGIN.UNKNOWN;
    evidence.push(`すでに取込の印が付いています（importSource=${src || '(空)'} / importedFromExcel=${l.importedFromExcel === true}）`);
    return { origin, confidence: IMB_CONFIDENCE.HIGH, evidence, counter };
  }

  const index = ctx.index || buildBackfillIndex(ctx.lots || [], o);
  const id = lotIdOf(l);

  // --- 根拠を集める ---------------------------------------------------------
  // ① まとめて書かれた塊
  const burst = id ? index.burstOf.get(id) || null : null;
  const bigBurst = !!burst && burst.size >= o.burstMinSize;
  if (bigBurst) {
    const per = burst.size > 1 ? (burst.spanMs / (burst.size - 1) / 1000).toFixed(2) : '0';
    evidence.push(`同じ時にまとめて書かれた ${burst.size}件の塊の中に居ます（${secText(burst.spanMs)}で${burst.size}件＝1件あたり${per}秒。人が1件ずつ登録できる速さではありません）`);
  } else if (burst) {
    counter.push(`同じ時に書かれたのは ${burst.size}件だけです（${o.burstMinSize}件に届かないので「まとめて取り込んだ」とは言えません。人が続けて登録した形にも見えます）`);
  } else if (msOf(l.createdAt) == null) {
    counter.push('作った時刻(createdAt)が入っていないので、まとめて書かれた塊かどうか確かめられません');
  } else {
    counter.push('作った時刻の前後に、続けて書かれた他のロットがありません（1件だけで登録された形です）');
  }

  // ② 同じ指図が、同じ時に、別のテンプレでもう1件
  const twin = id ? index.twinOf.get(id) || null : null;
  if (twin) {
    evidence.push(`同じ指図・同じ型式・同じ台数が、${secText(twin.gapMs)}差で別のテンプレでも ${twin.count}件 作られています（型式マスタの割り当てで1行が複数テンプレへ展開された形。手で登録する画面ではテンプレを1つしか選べません）`);
  }

  // ③ 入庫が「納期の N 日前 08:30」で再現できる
  const hhmm = txt(o.entryHHMM) || DEFAULT_IMPORT_OPTIONS.entryHHMM;
  const reg = registeredEntryDaysBefore(l, o);
  const def = Number.isFinite(Number(o.defaultEntryDaysBefore)) ? Number(o.defaultEntryDaysBefore) : DEFAULT_IMPORT_OPTIONS.defaultEntryDaysBefore;
  // 🚨 型式マスタに登録が在るならその日数を先に試す(根拠の文を実際と合わせるため)
  const comp = entryLooksComputed(l, { ...o, preferDays: reg === null ? def : reg });
  const entryMs = msOf(l.entryAt);
  if (comp) {
    const matchReg = reg !== null && reg === comp.days;
    const matchDef = reg === null && comp.days === def;
    evidence.push(`入庫が「納期の${comp.days}日前 ${hhmm} ちょうど」で作り直せます${comp.weekendShift ? '（工場が休みの日に落ちたので前の営業日へ寄せた形）' : ''}`
      + (matchReg ? `。型式マスタの登録（納期の${reg}日前）とも一致します`
        : matchDef ? `。型式マスタに登録が無い時の既定（納期の${def}日前）と一致します`
          : reg !== null ? `。ただし型式マスタの登録は納期の${reg}日前です（打ち替えた後かもしれません）` : ''));
    counter.push(`⚠ ${hhmm} は決め手になりません。手で登録する画面も、日付だけ打って時刻を省くと ${hhmm} になります`);
  } else if (entryMs != null && isExactHHMM(entryMs, hhmm) && txt(l.dueDate) === '') {
    counter.push(`入庫は ${hhmm} ちょうどですが、納期が空なので「納期の何日前」で作り直せません`);
  } else if (entryMs != null) {
    const d = new Date(entryMs);
    counter.push(`入庫が ${ymdOfMs(entryMs)} ${pad2(d.getHours())}:${pad2(d.getMinutes())} で、「納期の N 日前 ${hhmm}」では作り直せません（人が打った時刻に見えます）`);
    const dueYmd = txt(l.dueDate);
    if (dueYmd && ymdOfMs(entryMs) > dueYmd) counter.push(`入庫（${ymdOfMs(entryMs)}）が納期（${dueYmd}）より後です`);
  } else {
    counter.push('入庫が入っていないので、納期から作り直せるか確かめられません');
  }

  // ④ CREATE の記録(手で登録した道だけが書く)
  const logSet = ctx.createLogBatchIds instanceof Set ? ctx.createLogBatchIds
    : Array.isArray(ctx.createLogBatchIds) ? new Set(ctx.createLogBatchIds.map(txt))
      : null;
  const logChecked = logSet !== null;
  const hasCreateLog = logChecked && txt(l.batchId) !== '' && logSet.has(txt(l.batchId));
  if (hasCreateLog) {
    counter.push(`CREATE の記録（logs）が残っています。この記録は **手で1件ずつ登録する道だけ** が書きます（取込の道は1件も書きません）`);
  } else if (!logChecked) {
    counter.push('CREATE の記録（logs）を渡されていないので、手で登録した物かどうか確かめられていません');
  }

  // ⑤ 弱い根拠(印を上げる材料には使わない。読む人に見せるだけ)
  if (hasDefaultSerials(l)) {
    evidence.push('（弱い根拠）機番が既定のまま #1, #2, … です。⚠ 手で登録する時に機番欄を空にしても同じ形になるので、これだけでは決められません');
  }

  // ⑤の2 作られた後で誰かが書き換えた跡(本番の写しでは176件中32件)
  const createdMs = msOf(l.createdAt);
  const updatedMs = msOf(l.updatedAt);
  const touchedAfter = Number.isFinite(Number(o.touchedAfterMs)) ? Number(o.touchedAfterMs) : IMB_DEFAULTS.touchedAfterMs;
  if (createdMs != null && updatedMs != null && updatedMs - createdMs > touchedAfter) {
    counter.push(`作られてから ${Math.floor((updatedMs - createdMs) / 86400000)}日あとに、誰かがこのロットを書き換えています（納期を人が直したのかもしれません。印を付けると、型式マスタを打ち替えた時にその納期も一緒に動きます）`);
  }

  // ⑥ 進捗管理表から来た印(あの道だけが必ず書く欄)
  const fromProgress = Object.prototype.hasOwnProperty.call(l, 'dueDateProvisional');
  if (fromProgress) {
    evidence.push('進捗管理表の取込だけが書く欄（dueDateProvisional）が入っています');
  }

  // --- 決める ---------------------------------------------------------------
  // 🚨 CREATE の記録が在る = 手で登録した印。取込の根拠より優先する。
  if (hasCreateLog) {
    if (bigBurst || twin) {
      counter.push('取込の根拠（まとめ書き／別テンプレへの展開）ともぶつかっています。後から取込で上書きされたロットかもしれません');
      return { origin: IMB_ORIGIN.UNKNOWN, confidence: IMB_CONFIDENCE.LOW, evidence, counter };
    }
    return { origin: IMB_ORIGIN.MANUAL, confidence: IMB_CONFIDENCE.HIGH, evidence, counter };
  }

  const strong = (bigBurst ? 1 : 0) + (twin ? 1 : 0);
  const originGuess = fromProgress ? IMB_ORIGIN.PROGRESS_SHEET : IMB_ORIGIN.ARRIVAL_EXCEL;

  // 🚨 CREATE の記録を渡されていない時は high を出さない。
  //    「見ていない物を緑と報告する」道具にしないための門(2026-09-08)。
  const cap = (level) => (logChecked ? level : (level === IMB_CONFIDENCE.HIGH ? IMB_CONFIDENCE.MEDIUM : level));

  if (fromProgress) {
    return { origin: originGuess, confidence: cap(strong >= 1 ? IMB_CONFIDENCE.HIGH : IMB_CONFIDENCE.MEDIUM), evidence, counter };
  }
  if (strong >= 2) return { origin: originGuess, confidence: cap(IMB_CONFIDENCE.HIGH), evidence, counter };
  if (bigBurst && comp) return { origin: originGuess, confidence: cap(IMB_CONFIDENCE.HIGH), evidence, counter };
  if (bigBurst) return { origin: originGuess, confidence: IMB_CONFIDENCE.MEDIUM, evidence, counter };
  if (twin && comp) return { origin: originGuess, confidence: IMB_CONFIDENCE.MEDIUM, evidence, counter };
  if (twin) return { origin: originGuess, confidence: IMB_CONFIDENCE.LOW, evidence, counter };
  if (comp) return { origin: originGuess, confidence: IMB_CONFIDENCE.LOW, evidence, counter };
  // 取込の根拠が1つも無い。入庫が人の打った形なら「手で登録した」、それも無ければ「分かりません」。
  if (entryMs != null) return { origin: IMB_ORIGIN.MANUAL, confidence: IMB_CONFIDENCE.MEDIUM, evidence, counter };
  return { origin: IMB_ORIGIN.UNKNOWN, confidence: IMB_CONFIDENCE.LOW, evidence, counter };
}

// ---------------------------------------------------------------------------
// 一覧を作る
// ---------------------------------------------------------------------------

/**
 * 「印を後から付ける」候補の一覧。**1バイトも書かない**。
 *
 * @param {Array} lots 全ロット(終わった物も渡す。塊を正しく数えるため)
 * @param {object} ctx classifyImportOrigin と同じ + createLogBatchIds
 * @returns {{
 *   candidates: Array, byConfidence: {high:Array, medium:Array, low:Array},
 *   skipped: Array, counts: object, defaultSelectedIds: string[], burstGroups: Array
 * }}
 */
export function planImportMarkBackfill(lots, ctx = {}) {
  const o = {
    ...IMB_DEFAULTS,
    entryHHMM: DEFAULT_IMPORT_OPTIONS.entryHHMM,
    defaultEntryDaysBefore: DEFAULT_IMPORT_OPTIONS.defaultEntryDaysBefore,
    ...(ctx || {}),
  };
  const list = (Array.isArray(lots) ? lots : []).filter(l => l && typeof l === 'object');
  const index = ctx.index || buildBackfillIndex(list, o);
  const inner = { ...o, index };
  const logChecked = ctx.createLogBatchIds instanceof Set || Array.isArray(ctx.createLogBatchIds);

  const candidates = [];
  const skipped = [];
  const counts = {
    lots: list.length,
    finished: 0,
    alreadyMarked: 0,
    noData: 0,
    open: 0,
    candidates: 0,
    high: 0, medium: 0, low: 0,
    manual: 0, unknown: 0,
    arrivalExcel: 0, progressSheet: 0,
    defaultSelected: 0,
    createLogChecked: logChecked,
  };

  const rowOf = (lot, res) => ({
    lotId: lotIdOf(lot),
    orderNo: txt(lot.orderNo),
    model: txt(lot.model),
    templateId: txt(lot.templateId),
    dueDate: txt(lot.dueDate),
    entryAt: lot.entryAt == null ? null : lot.entryAt,
    entryMs: msOf(lot.entryAt),
    createdAt: msOf(lot.createdAt),
    origin: res.origin,
    confidence: res.confidence,
    evidence: res.evidence,
    counter: res.counter,
  });

  for (const lot of list) {
    if (isFinishedLot(lot)) {
      counts.finished++;
      skipped.push({ lotId: lotIdOf(lot), orderNo: txt(lot.orderNo), model: txt(lot.model), reason: IMB_SKIP.COMPLETED, origin: null, confidence: null, evidence: [], counter: [] });
      continue;
    }
    counts.open++;
    if (hasImportMark(lot)) {
      counts.alreadyMarked++;
      skipped.push({ lotId: lotIdOf(lot), orderNo: txt(lot.orderNo), model: txt(lot.model), reason: IMB_SKIP.ALREADY_MARKED, origin: txt(lot.importSource) || IMB_ORIGIN.ARRIVAL_EXCEL, confidence: IMB_CONFIDENCE.HIGH, evidence: [], counter: [] });
      continue;
    }
    if (isEmptyShell(lot)) {
      counts.noData++;
      skipped.push({ lotId: lotIdOf(lot), orderNo: txt(lot.orderNo), model: txt(lot.model), reason: IMB_SKIP.NO_DATA, origin: IMB_ORIGIN.UNKNOWN, confidence: IMB_CONFIDENCE.LOW, evidence: [], counter: ['型式も納期も入庫も入っていません'] });
      continue;
    }

    const res = classifyImportOrigin(lot, inner);
    const row = rowOf(lot, res);

    if (MARKABLE.includes(res.origin)) {
      row.selectedByDefault = res.confidence === IMB_CONFIDENCE.HIGH;
      candidates.push(row);
      counts.candidates++;
      counts[res.confidence]++;
      if (res.origin === IMB_ORIGIN.ARRIVAL_EXCEL) counts.arrivalExcel++;
      if (res.origin === IMB_ORIGIN.PROGRESS_SHEET) counts.progressSheet++;
      if (row.selectedByDefault) counts.defaultSelected++;
    } else {
      if (res.origin === IMB_ORIGIN.MANUAL) counts.manual++; else counts.unknown++;
      skipped.push({ ...row, reason: res.origin === IMB_ORIGIN.MANUAL ? IMB_SKIP.MANUAL : IMB_SKIP.UNKNOWN });
    }
  }

  const byConfidence = {
    high: candidates.filter(c => c.confidence === IMB_CONFIDENCE.HIGH),
    medium: candidates.filter(c => c.confidence === IMB_CONFIDENCE.MEDIUM),
    low: candidates.filter(c => c.confidence === IMB_CONFIDENCE.LOW),
  };

  return {
    candidates,
    byConfidence,
    skipped,
    counts,
    // 🚨 既定で選ばれるのは high だけ。medium / low は人が選んで初めて入る。
    defaultSelectedIds: byConfidence.high.map(c => c.lotId),
    burstGroups: index.burstGroups || [],
  };
}

// ---------------------------------------------------------------------------
// 書く形(patch)を作る。🚨 ここでも1バイトも書かない。
// ---------------------------------------------------------------------------

/**
 * 印を付ける patch。
 * 🚨 「今」は関数の中で作らない。at(epoch ms)を **必ず** 渡す。
 * 🚨 manual / unknown には印を付けられない(投げる)。黙って付けたら、この関数の意味が無い。
 *
 * @param {object} lot ロット(いまの印を確かめるためだけに読む)
 * @param {string} origin 'arrival-excel' | 'progress-sheet'
 * @param {{at:number, evidence?:string[]}} opts
 */
export function markPatchOf(lot, origin, opts = {}) {
  const o = txt(origin);
  if (!MARKABLE.includes(o)) {
    throw new Error(`印を付けられる出どころは 入荷登録Excel（${IMB_ORIGIN.ARRIVAL_EXCEL}）と 進捗管理表（${IMB_ORIGIN.PROGRESS_SHEET}）だけです。渡されたのは「${o || '(空)'}」です`);
  }
  const at = Number(opts && opts.at);
  if (!Number.isFinite(at)) {
    throw new Error('印を付けた時刻 at（epoch ms）を渡してください。この関数の中では「今」を作りません（同じ入力なら毎回同じ答えにするため）');
  }
  // すでに **別の** 出どころの印が付いているロットを、黙って書き換えない。
  const already = txt(lot && lot.importSource);
  if (already && already !== o) {
    throw new Error(`このロットにはすでに「${already}」の印が付いています。「${o}」で上書きはしません（人が見て決めてください）`);
  }
  const evidence = Array.isArray(opts && opts.evidence) ? opts.evidence.map(s => String(s)) : [];
  return {
    importedFromExcel: true,
    importSource: o,
    importMarkBackfilledAt: at,
    importMarkEvidence: evidence,
  };
}

/**
 * 印だけを外す patch(取り消し)。他の欄は1つも触らない。
 * 🚨 書かなかった鍵は merge で消えない(2026-09-09 の穴)。だから外す時も
 *    IMB_MARK_KEYS の **全部** を、空・false・null で **書く**。
 * 🚨 取込の時に付いた印(importMarkBackfilledAt が無い印)は、うっかり外せないようにする。
 *    本当に外す時だけ { force: true }。
 */
export function unmarkPatchOf(lot, opts = {}) {
  const l = lot && typeof lot === 'object' ? lot : {};
  if (!hasImportMark(l)) {
    throw new Error('このロットには取込の印がありません（外す物がありません）');
  }
  const force = !!(opts && opts.force);
  if (!force && msOf(l.importMarkBackfilledAt) == null) {
    throw new Error('この印は後から付けた物ではありません（取り込んだ時に付いた印です）。それでも外す時は { force: true } を渡してください');
  }
  return {
    importedFromExcel: false,
    importSource: '',
    importMarkBackfilledAt: null,
    importMarkEvidence: null,
  };
}

/**
 * 選ばれた候補 → 書く形の一覧。押す前に画面へ出すためのもの。
 * 🚨 選ばれていない候補は1件も入らない(既定は high だけ)。
 *
 * @param {Array} candidates planImportMarkBackfill の candidates
 * @param {string[]|Set} selectedIds 人が選んだ lotId
 * @param {{at:number}} opts
 * @returns {Array<{lotId:string, patch:object, origin:string, confidence:string}>}
 */
export function buildMarkWrites(candidates, selectedIds, opts = {}) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set((Array.isArray(selectedIds) ? selectedIds : []).map(txt));
  const list = (Array.isArray(candidates) ? candidates : []).filter(c => c && sel.has(txt(c.lotId)));
  return list.map(c => ({
    lotId: c.lotId,
    origin: c.origin,
    confidence: c.confidence,
    patch: markPatchOf(c, c.origin, { at: opts && opts.at, evidence: c.evidence }),
  }));
}
