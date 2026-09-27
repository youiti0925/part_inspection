// ============================================================================
// 📥 Excel取込「1行 → 何個のロットになるか」を決める純関数
// ----------------------------------------------------------------------------
// 清水さんの指示(発言18)を、そのまま計算にしたもの。
//   ・Excel には型式だけ書けば、アプリに登録してある型式テンプレ(複数)がそのまま発動する
//   ・型式マスタのテンプレごとに「納期に対して何日ずらすか」を登録できる
//   ・入荷日時も「納期の何日前か」で自動で決まる
//   ・この自動化は Excel取込のときに ON/OFF できる
//
// 🚨 なぜ純関数として切り出したか(直した欠陥):
//   App.jsx の入荷登録Excel取込は `cellTxt(rowArr, C_TEMPLATE) || 'demo'` と書いてあり、
//   テンプレ列が空の行を **捨てもせず・エラーも出さず** templateId='demo' のロットにしていた。
//   'demo' は実在しないテンプレなので DEMO_STEPS(外観確認/自動加工/梱包の3工程)になり、
//   型式マスタは丸ごと無視される。8/11のバックアップに実際に2件出来ていた。
//   → ここでは **中身の無いロットを作らず、必ず skipped に理由を出す**。
//
// ⚠⚠ 「納期のずらし」は **新しい欄 dueDaysBefore(納期基準)** を使う。
//    既存の daysBefore は **進捗管理表のZ列(K33 検査予定日)基準** で、意味も符号も違う
//    (K33: 負=何日前・0=当日・正=何日後 / 納期: 正=納期より前・負=納期より後)。
//    流用すると、進捗管理表用に入れた値が入荷登録Excelの納期を勝手に動かす。両方持たせて別々に扱う。
//
// ⚠ React も firebase も import しない (node --test で回すため)。
// ⚠ 関数の中で Date.now() を呼ばない。同じ入力なら毎回同じ結果になる事(P10)。
// ============================================================================

// 📅 工場の暦(祝日・全社休業・休日出勤)。稼働日の判定はここ1本だけを通す。
import { makeIsWorkday, prevWorkdayYmd } from './factoryCalendar.js';

/** 型式マスタ由来の、テンプレごとの日数の決め方 */
export const OFFSET_BASE = Object.freeze({
  DUE: 'due',    // 納期からのずらし（今回追加・指示18）
  K33: 'k33',    // 進捗管理表のZ列からのずらし（既存の daysBefore。**意味が違う**）
});

/**
 * 行を捨てた理由。画面にそのまま出す文なので、ここ1箇所で持つ。
 * 🚨 「黙って捨てる」も「黙って中身の無いロットを作る」も禁止。必ずどれかが付く。
 */
export const SKIP_REASON = Object.freeze({
  NO_MODEL: '型式が空です',
  NO_MASTER: '型式マスタにこの型式の登録がありません',
  NO_TEMPLATE_ASSIGNED: '型式マスタにテンプレートが割り当てられていません',
  EXPANSION_OFF: 'テンプレートID列が空です（型式テンプレの自動展開はOFF）',
  TEMPLATE_MISSING: 'テンプレートが見つかりません',
});

/** 既定の options。呼び出し側が一部だけ渡しても穴が空かないようにする。 */
export const DEFAULT_IMPORT_OPTIONS = Object.freeze({
  useModelTemplates: true,   // 型式だけ書かれた行を型式マスタで複数テンプレへ展開する
  useDueOffset: true,        // 型式マスタの「納期からのずらし」を効かせる
  useEntryOffset: true,      // 型式マスタの「入荷は納期の何日前」を効かせる
  defaultEntryDaysBefore: 3, // 型式マスタに登録が無い時の既定。🚨 3 を計算の中に直書きしない
  entryHHMM: '08:30',
  // 🚨 2026-08-23 清水さん「1は金曜によせる」。
  //   入荷が土日に落ちたら **前の金曜** へ寄せる。土曜→1日前 / 日曜→2日前。
  //   ⚠ Excel に入荷日が書いてある行は寄せない（人が書いた日付を勝手に動かさない）。
  //   📅 2026-09-01 工場の暦(祝日表)を繋いだ。土日だけでなく **登録した祝日・全社休業も**
  //      前の営業日へ寄せる。それまでは工場が休みの祝日に入荷予定が立っていた。
  //      🚨 calendar を渡さなければ今までと1ミリも同じ(土日だけ寄せる)。
  shiftWeekendToFriday: true,
  calendar: null,            // 工場の暦(settings/config の factoryCalendar)。null=登録なし
});

// ---------------------------------------------------------------------------
// 日付まわり。すべて「その土地の時刻」で数える。
// ⚠ 暦日で数える(既存の取込と揃える)。土日を月曜へ寄せるような気の利いた事はしない。
//    寄せるかどうかを決めるのは清水さんなので、こちらは entryOnWeekend で **見えるようにするだけ**。
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' → {y,m,d} / 読めなければ null。⚠ new Date(文字列) はタイムゾーンで1日ズレるので使わない。 */
const parseYMD = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  // 2026-02-31 のような存在しない日を弾く(Dateが黙って3/3にしてしまうため)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, m: mo, d };
};

const fmtYMD = (dt) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/** 'YYYY-MM-DD' を暦日で days 日 **前** へずらす。days が負なら後ろへ。読めなければ ''。 */
const shiftYMD = (ymd, days) => {
  const p = parseYMD(ymd);
  if (!p) return '';
  const dt = new Date(p.y, p.m - 1, p.d);
  dt.setDate(dt.getDate() - (Number.isFinite(days) ? days : 0));
  return fmtYMD(dt);
};

/** 'HH:MM' → {hh,mm}。読めなければ 08:30。 */
const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return { hh: 8, mm: 30 };
  return { hh: Math.min(23, +m[1]), mm: Math.min(59, +m[2]) };
};

/** 'YYYY-MM-DD' + 'HH:MM' → epoch ms(その土地の時刻)。読めなければ null。 */
const ymdHHMMToMs = (ymd, hhmm) => {
  const p = parseYMD(ymd);
  if (!p) return null;
  const t = parseHHMM(hhmm);
  return new Date(p.y, p.m - 1, p.d, t.hh, t.mm, 0, 0).getTime();
};

/**
 * 工場が休みの日なら **前の営業日** へ寄せた YMD を返す。営業日ならそのまま。
 * 🚨 2026-08-23 清水さんの指示「1は金曜によせる」。入荷が土日に来る事は現場では起きない。
 * 📅 2026-09-01 祝日表を繋いだ。祝日・全社休業も同じように前の営業日へ寄せる。
 *   ⚠ 1回ずらすだけでは足りない(祝日の前日が日曜なら更に金曜まで下がる)。
 *   ⚠ 寄せられなければ **元の日付をそのまま返す**(日付を捏造しない)。
 * @param works domain/factoryCalendar.js の makeIsWorkday で畳んだ判定
 */
const toPrevWorkday = (ymd, works) => {
  if (!parseYMD(ymd)) return ymd;
  const moved = prevWorkdayYmd(ymd, works);
  return moved || ymd;
};

/** その日は工場が休みか。読めなければ false。⚠ 土日だけでなく登録した祝日も含む。 */
const isNonWorkdayYMD = (ymd, works) => {
  if (!parseYMD(ymd)) return false;
  return !works(ymd);
};

/**
 * Excelの入荷欄の生テキスト → { ymd, hhmm } / 読めなければ null。
 * ⚠ App.jsx の parseImportDateToYMD_pi と同じ形を受ける(年先頭 / 年末尾 / Excelシリアル / フォールバック)。
 *   ここに置いたのは「純関数の中だけで完結させる」ため。時刻(HH:MM)も一緒に拾う
 *   (旧実装は時刻を読まず常に08:30にしていた)。
 */
export const parseEntryRaw = (raw, fallbackHHMM = '08:30') => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 時刻は文字列のどこにあってもよい。日付側の "2026-09-01" と食い合わないよう、
  // 日付の区切り(/ - .)に挟まれていない H:MM を拾う。
  const tm = /(?:^|[^\d:\-/.])(\d{1,2}):(\d{2})(?!\d)/.exec(s);
  const hhmm = tm
    ? `${String(Math.min(23, parseInt(tm[1], 10))).padStart(2, '0')}:${tm[2]}`
    : fallbackHHMM;
  const dateStr = s.replace(/(\d{1,2}):(\d{2})(:\d{2})?/, ' ').trim();

  let m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(dateStr); // 年先頭
  if (m) return { ymd: `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`, hhmm };
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(dateStr);     // 年末尾(M/D/YYYY優先。月>12なら入替)
  if (m) {
    let mo = +m[1], da = +m[2];
    if (mo > 12 && da <= 12) { const t = mo; mo = da; da = t; }
    return { ymd: `${m[3]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`, hhmm };
  }
  if (/^\d+(\.\d+)?$/.test(dateStr)) {                              // Excelシリアル値
    const n = parseFloat(dateStr);
    if (n > 59 && n < 80000) {
      const dt = new Date(Math.round((n - 25569) * 86400000));
      if (!isNaN(dt.getTime())) {
        // シリアルは UTC 起点。日付部分だけを取り、時刻は上で拾った物を使う。
        return { ymd: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`, hhmm };
      }
    }
  }
  const t = new Date(dateStr).getTime();                            // フォールバック
  if (isNaN(t)) return null;
  return { ymd: fmtYMD(new Date(t)), hhmm };
};

// ---------------------------------------------------------------------------
// 型式マスタの引き当て
// ---------------------------------------------------------------------------

/** 型式名の揺れ(大文字小文字・空白・ハイフン・アンダースコア・カンマ・ドット)を吸収する。 */
const normalizeModel = (s) => String(s || '').toUpperCase().replace(/[\s\-_,.]/g, '');

/** 直接一致 → 正規化一致 の順に引く。戻り値 {key, value} / null。 */
const lookupByModel = (map, model) => {
  if (!map || typeof map !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(map, model)) return { key: model, value: map[model] };
  const norm = normalizeModel(model);
  for (const [k, v] of Object.entries(map)) {
    if (normalizeModel(k) === norm) return { key: k, value: v };
  }
  return null;
};

/**
 * 旧・品質規格マスタ(qs.templates / 旧1件形式)の entry 配列を取り出す。
 * ⚠ App.jsx の getQsTemplateEntries と同じ形。ここでは「どのテンプレで作るか」しか使わない。
 */
const qsEntries = (qs) => {
  if (!qs || typeof qs !== 'object') return [];
  if (Array.isArray(qs.templates) && qs.templates.length > 0) return qs.templates.filter(e => e && typeof e === 'object');
  if (qs.templateId) return [{ templateId: qs.templateId }];
  return [];
};

/**
 * 型式 → テンプレ entry 配列。型式マスタ優先、無ければ旧・品質規格マスタ。
 * @returns { entries, source: 'modelMaster'|'qualityStandard', matchedModel } | null
 */
export const resolveEntriesForModel = ({ modelMasters, qualityStandards, modelStandardMap }, model) => {
  const m = String(model || '').trim();
  if (!m) return null;
  const hit = lookupByModel(modelMasters, m);
  if (hit && hit.value && Array.isArray(hit.value.templates) && hit.value.templates.length > 0) {
    return {
      entries: hit.value.templates.filter(e => e && typeof e === 'object'),
      source: 'modelMaster',
      matchedModel: hit.value.model || hit.key,
    };
  }
  // 旧・品質規格マスタ (互換)
  const mapped = lookupByModel(modelStandardMap, m);
  if (!mapped || !mapped.value) return null;
  const qs = qualityStandards && qualityStandards[mapped.value];
  const entries = qsEntries(qs);
  if (entries.length === 0) return null;
  return { entries, source: 'qualityStandard', matchedModel: mapped.key };
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * Excel 1行 → 作るべきロットの一覧。
 *
 * @param {object} row
 *   model              型式(Excelの型式列)
 *   orderNo            指図番号
 *   qty                台数
 *   dueYMD             納期 'YYYY-MM-DD'(呼び出し側で正規化済み)。空でもよい
 *   entryRaw           入庫日時の生テキスト。書いてあれば **最優先**
 *   templateIdFromExcel テンプレートID列。書いてあれば **最優先**(今までの動きを変えない)
 * @param {object} ctx
 *   modelMasters, qualityStandards, modelStandardMap, templates, options
 *   templates … [{id,name}]。配列で渡された時だけ実在チェックをする
 *               (まだ購読前で undefined の呼び出しでは照合しない)
 * @returns {{
 *   lots: Array, skipped: Array, usedModelMaster: boolean,
 *   masterSource: 'modelMaster'|'qualityStandard'|null, matchedModel: string,
 *   entryOnWeekendCount: number
 * }}
 */
export function planRowLots(
  { model, orderNo, qty, dueYMD, entryRaw, templateIdFromExcel } = {},
  { modelMasters, qualityStandards, modelStandardMap, templates, options } = {}
) {
  const opt = { ...DEFAULT_IMPORT_OPTIONS, ...(options || {}) };
  // 🚨 稼働日の判定はここ1本。ループの外で1回だけ暦を読む(行ごとに読み直すと取込が重くなる)。
  const worksOn = makeIsWorkday(opt.calendar);
  const out = {
    lots: [],
    skipped: [],
    usedModelMaster: false,
    masterSource: null,
    matchedModel: '',
    entryOnWeekendCount: 0,
  };

  const modelTxt = String(model || '').trim();
  const excelTplId = String(templateIdFromExcel || '').trim();
  const srcDueYMD = String(dueYMD || '').trim();
  const orderNoTxt = String(orderNo || '').trim();
  const qtyNum = Number.isFinite(qty) ? qty : (parseInt(qty, 10) || 1);

  if (!modelTxt) {
    out.skipped.push({ reason: SKIP_REASON.NO_MODEL, detail: `指図 ${orderNoTxt || '(空)'}` });
    return out;
  }

  // テンプレの実在チェック。templates を渡された時だけ働く。
  const tplList = Array.isArray(templates) ? templates : null;
  const findTpl = (id) => (tplList ? tplList.find(t => t && t.id === id) || null : null);

  // --- 1. どのテンプレで作るかを決める -------------------------------------
  // 🚨 Excel にテンプレIDが書いてあれば、それを最優先(今までの動きを変えない)。
  //    このとき型式マスタは見ない = 納期ずらしも入荷ずらしも掛からない。
  let plan = null;   // [{ templateId, entry, source }]
  if (excelTplId) {
    plan = [{ templateId: excelTplId, entry: null, source: 'excel' }];
  } else if (!opt.useModelTemplates) {
    // ON/OFF が OFF。**黙って 'demo' を作らない**。理由を出して捨てる。
    out.skipped.push({ reason: SKIP_REASON.EXPANSION_OFF, detail: `${modelTxt} / 指図 ${orderNoTxt}` });
    return out;
  } else {
    const resolved = resolveEntriesForModel({ modelMasters, qualityStandards, modelStandardMap }, modelTxt);
    if (!resolved) {
      out.skipped.push({ reason: SKIP_REASON.NO_MASTER, detail: `${modelTxt} / 指図 ${orderNoTxt}` });
      return out;
    }
    out.matchedModel = resolved.matchedModel;
    // templateId が空のエントリ(全テンプレ共通の設定)からはロットを作れない。
    const usable = resolved.entries.filter(e => e.templateId);
    if (usable.length === 0) {
      out.skipped.push({ reason: SKIP_REASON.NO_TEMPLATE_ASSIGNED, detail: `${modelTxt} / 指図 ${orderNoTxt}` });
      return out;
    }
    out.usedModelMaster = resolved.source === 'modelMaster';
    out.masterSource = resolved.source;
    plan = usable.map(e => ({ templateId: e.templateId, entry: e, source: resolved.source }));
  }

  // --- 2. Excel に入荷が書いてあるか(全ロット共通・最優先) ------------------
  const excelEntry = parseEntryRaw(entryRaw, opt.entryHHMM);

  // --- 3. テンプレごとにロットを組む ---------------------------------------
  for (const p of plan) {
    const tpl = findTpl(p.templateId);
    if (tplList && !tpl) {
      // 🚨 実在しないテンプレのロットは「中身の無いロット」になる。作らずに理由を出す。
      out.skipped.push({ reason: SKIP_REASON.TEMPLATE_MISSING, detail: `${modelTxt} / テンプレID ${p.templateId}` });
      continue;
    }
    const e = p.entry;

    // 納期のずらし: **新しい欄 dueDaysBefore(納期基準)**。正=納期より前、負=後。
    // 🚨 e.daysBefore(K33基準) は絶対に使わない。意味が違う。
    const rawDue = e && Number.isFinite(Number(e.dueDaysBefore)) && e.dueDaysBefore !== null && e.dueDaysBefore !== ''
      ? Number(e.dueDaysBefore) : 0;
    const offsetDays = opt.useDueOffset ? rawDue : 0;
    const lotDueYMD = offsetDays && srcDueYMD ? shiftYMD(srcDueYMD, offsetDays) : srcDueYMD;

    // 入荷。Excel の記載 > 型式マスタの entryDaysBefore > options.defaultEntryDaysBefore。
    // 🚨 2026-08-23 清水さん「2はB」= 起点は **ずらした後の検査納期(lotDueYMD)**。
    //   例: Excel納期9/10・納期ずらし2日・入荷5日前 → 検査納期9/8、入荷は 9/8の5日前 = 9/3。
    //   (以前は元の9/10から数えて9/5にしていた。P06b を書き換えてある)
    let entryDaysBefore = null;
    let entrySource = 'excel';
    let entryYMD = '';
    let entryAt = null;
    let entryBaseYMD = '';
    if (excelEntry) {
      entryYMD = excelEntry.ymd;
      entryAt = ymdHHMMToMs(excelEntry.ymd, excelEntry.hhmm);
    } else {
      const registered = e && e.entryDaysBefore !== null && e.entryDaysBefore !== undefined && e.entryDaysBefore !== ''
        && Number.isFinite(Number(e.entryDaysBefore)) ? Number(e.entryDaysBefore) : null;
      const useRegistered = opt.useEntryOffset && registered !== null;
      entryDaysBefore = useRegistered ? registered : opt.defaultEntryDaysBefore;
      entrySource = useRegistered ? p.source : 'default';
      entryBaseYMD = lotDueYMD;
      // 🚨 納期が無ければ日付を捏造しない。null のまま返して呼び出し側に決めさせる。
      entryYMD = lotDueYMD ? shiftYMD(lotDueYMD, entryDaysBefore) : '';
      // 土日に落ちたら前の金曜へ（清水さんの指示・Excel記載の行はここへ来ない）
      if (entryYMD && opt.shiftWeekendToFriday) entryYMD = toPrevWorkday(entryYMD, worksOn);
      entryAt = entryYMD ? ymdHHMMToMs(entryYMD, opt.entryHHMM) : null;
    }
    const entryOnWeekend = entryYMD ? isNonWorkdayYMD(entryYMD, worksOn) : false;
    if (entryOnWeekend) out.entryOnWeekendCount++;

    out.lots.push({
      model: modelTxt,
      orderNo: orderNoTxt,
      qty: qtyNum,
      templateId: p.templateId,
      templateName: tpl ? (tpl.name || '') : '',
      dueYMD: lotDueYMD,
      srcDueYMD,                       // 元の納期(ずらす前)。画面で「9/10 → 9/8」と出せる
      offsetDays,                      // 納期を何日前へずらしたか(正=前)
      offsetBase: OFFSET_BASE.DUE,     // 何を起点にずらしたか。K33 と混ぜない印
      k33DaysBefore: e && e.daysBefore !== undefined ? e.daysBefore : null, // 見せるだけ。使わない
      entryAt,                         // epoch ms / 決められなければ null
      entryYMD,
      entryDaysBefore,                 // 納期の何日前にしたか。Excel記載時は null
      entryBaseYMD,                    // 入荷を数えた起点(= Excelの納期)
      entrySource,                     // 'excel' | 'modelMaster' | 'qualityStandard' | 'default'
      entryOnWeekend,                  // 🚨 休みの日でも勝手に動かさない。件数を画面に出すための印
      source: p.source,                // このロットの出どころ
    });
  }

  return out;
}
