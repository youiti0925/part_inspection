// ============================================================================
// 🗓⚠ 納期の矛盾・過去納期の扱い
// ----------------------------------------------------------------------------
// 清水さんの決定(2026-08-28 夜)に基づく:
//   ・「間に合う」= 納期(dueDate)そのもの。
//   ・母集団 = 検査リストの全未完了。ただし納期が今日より前(過去納期)のロットは
//     「処理済みかミス登録」なので基本無視する。
//     ⚠無視するだけで消さない。何件無視したかは呼び側が正直に数えて画面に出す事。
//   ・例外: 過去納期でも入荷登録(到着予定)が付いたロットは生きている=これから来る。
//     ただし入荷が納期より後なのは矛盾なので「納期の更新が必要」のアラームで知らせる。
//   ・設備制約は今は見ない(将来モードON/OFFで足す予定)。このファイルは設備を知らない。
//
// 置き場所が operationsSimulation の外にある理由:
//   検査リスト(App.jsx)からも使うため。operationsSimulation/ の中へ置くと
//   検査リストがシミュレーターへ依存する向きになってしまう。
//
// 読み方は既存の物だけを使う(独自パース禁止):
//   ・納期     … dueDefense.dueMsOfLot (App.jsx:653 parseDueParts と同じ規則 + Date.parse 救済。
//                その日の 0:00 の ms が返る)
//   ・到着予定 … arrivalSplits.splitsOf / splitMs (分納の便。早い順に並び、読めない便は最後)
//
// ⚠React も firebase も import しない。Date.now() もここでは呼ばない。
//   「今日」は必ず引数 todayStartMs で受ける(同じ入力 → 同じ結果)。
//   渡し忘れたら黙って今日を推測せず throw する(黙って別の日で判定するのが一番たちが悪い)。
// ============================================================================

import { dueMsOfLot } from './dueDefense.js';
import { splitsOf, splitMs } from './arrivalSplits.js';

const DAY_MS = 86400000;

// 出力文字列は定数で1本化する(画面・試験・通知が同じ文字を使うため)。
// ⚠禁じ語(できない・不可・未経験・初級・上級者・有意・標本・スコア・偏差)を入れない。
export const STALE_REASON = '納期が過ぎており到着予定もありません(処理済みか登録間違いの可能性)';
export const CONFLICT_LABEL = '⚠納期の更新が必要(入荷が納期より後)';

// 数字の出どころ(どのフィールドをどの既存関数で読んだか)。結果に必ず添える。
const sourceOf = () => ({
    due: 'lot.dueDate (dueDefense.dueMsOfLot で読解・その日の0:00)',
    arrival: 'arrival_times の便 (arrivalSplits.splitsOf/splitMs) → 無ければ lot.entryAt',
});

// その ms が属する日の 0:00 (端末ローカル)。dueDefense.js の startOfDay と同じ式。
// 呼び側が「今日の正午の ms」を渡しても正しく日で比べられるように、内部で必ず丸める。
const dayStartOf = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

// todayStartMs は必須。⚠既定値で Date.now() へ逃げない(端末の時計で結果が変わると、
//   多端末で同じロットの判定が食い違う。開発PCの時計が進んでいた実害もある)。
const requireTodayStart = (v, fnName) => {
    if (!Number.isFinite(v)) {
        throw new Error(`${fnName}: todayStartMs(今日の0:00のms)が要ります。ここで Date.now() は呼びません(同じ入力→同じ結果を守るため)`);
    }
};

/**
 * 入荷はいつか。到着予定の**一番早い読める便** → 無ければ lot.entryAt の順で採る。
 *
 * なぜ到着予定を entryAt より先に見るか:
 *   entryAt は Excel 取込が「予定日の3日前 08:30」を機械的に直書きした値が大半
 *   (操業シミュレーターの CONTRACT.md 2章の実測: 636/636件に有り・3日前197件)。
 *   到着予定(arrival_times)は組立の人が登録した生きた情報なので、そちらが正。
 *
 * ⚠splitsOf は早い順に並べ、日時が読めない便を最後に置く。だから先頭から順に
 *   「読める最初の便」を採れば一番早い便になる。
 *
 * @returns {{arrivalMs:number|null, arrivalSource:'splits'|'entryAt'|null, splitCount:number}}
 *   arrivalMs が null の時 = 到着予定も entryAt も読めない(推測で埋めない)。
 */
export const earliestArrivalMs = ({ lot = null, arrival = null } = {}) => {
    const splits = splitsOf(arrival);
    for (const s of splits) {
        const t = splitMs(s);
        if (t != null) return { arrivalMs: t, arrivalSource: 'splits', splitCount: splits.length };
    }
    const e = Number(lot && lot.entryAt);
    if (Number.isFinite(e) && e > 0) return { arrivalMs: e, arrivalSource: 'entryAt', splitCount: splits.length };
    return { arrivalMs: null, arrivalSource: null, splitCount: splits.length };
};

/**
 * 過去納期で、到着予定も付いていないロットか(=「処理済みかミス登録」なので基本無視する対象)。
 *
 * 判定の決まり(清水さん 2026-08-28):
 *   stale = 納期(dueDate)が今日より前 かつ 入荷登録(到着予定)が無い
 *
 * ⚠「今日ちょうど」は過去納期ではない(今日いっぱいは生きている)。
 * ⚠到着予定は arrival_times の便が1つでもあれば「付いている」と数える。
 *   日時が読めない登録でも「人が登録した」事実は残っているので、安全側=生きている側に倒す
 *   (黙って棚から外すと戻す道が無い。読めない分は dueConflict が理由付きで返すので画面に出せる)。
 * ⚠entryAt は「到着予定の登録」に数えない。Excel 取込が全ロットへ機械的に入れる値なので、
 *   これを数えると過去納期のロットが1件も stale にならず、決定が骨抜きになる。
 * ⚠納期が読めないロットは stale にしない(読めない事を理由にして黙って無視しない)。null+理由で返す。
 *
 * @param {Object} o
 *   lot          … 検査リストのロット(dueDate / entryAt を読む)
 *   arrival      … そのロットの到着予定(arrival_times の1件。buildArrivalByLot の値)。無ければ省略可
 *   todayStartMs … 今日の 0:00 の ms。必須(Date.now() へ逃げない)
 * @returns {{stale:boolean, pastDue:boolean, arrivalRegistered:boolean,
 *            dueMs:number|null, todayStartMs:number, reason:string|null, source:Object}}
 */
export const staleOverdue = ({ lot = null, arrival = null, todayStartMs } = {}) => {
    requireTodayStart(todayStartMs, 'staleOverdue');
    const day0 = dayStartOf(todayStartMs);
    const dueMs = dueMsOfLot(lot);
    const arrivalRegistered = splitsOf(arrival).length > 0;
    if (dueMs == null) {
        // 出せない時は null + 理由(推測で埋めない)。stale=false なので棚からは外れない。
        return {
            stale: false, pastDue: false, arrivalRegistered,
            dueMs: null, todayStartMs: day0,
            reason: '納期が読み取れないため、過去納期かどうかは出せません(dueDateが空か読めない形式)',
            source: sourceOf(),
        };
    }
    const pastDue = dueMs < day0;                       // dueMs はその日の0:00 → 「今日ちょうど」は含まない
    const stale = pastDue && !arrivalRegistered;
    return {
        stale, pastDue, arrivalRegistered,
        dueMs, todayStartMs: day0,
        reason: stale ? STALE_REASON : null,
        source: sourceOf(),
    };
};

/**
 * 入荷(到着予定の一番早い便 or entryAt)が納期より後 = 矛盾。「納期の更新が必要」のアラーム。
 *
 * なぜアラームか(清水さん 2026-08-28):
 *   過去納期でも到着予定が付いたロットは生きている=これから来る。だが入荷が納期より後なら
 *   その納期はもう守れない日付のまま残っている(SAP側の納期がずれたのに更新されていない等)。
 *   ロットを消したり無視したりせず、「納期の更新が必要」と人に知らせて直してもらう。
 *
 * 「納期より後」の線 = 納期当日いっぱい(23:59:59.999)まではセーフ。
 *   dueDefense.projectDueRisk の「納期当日いっぱいまでは間に合っている」(dueMs + DAY_MS - 1)と
 *   同じ規約に合わせる。ここだけ 0:00 で切ると、同じロットが画面の遅れ判定とアラームで
 *   食い違う(納期当日の朝に入荷する正常なロットが矛盾扱いになる)。
 *
 * @param {Object} o
 *   lot          … 検査リストのロット
 *   arrival      … そのロットの到着予定(無ければ省略可。その時は entryAt で判定)
 *   todayStartMs … 今日の 0:00 の ms。必須。判定そのものは日付同士の比較だが、
 *                  pastDue(過去納期の印)を同じ土俵で添えるために受ける
 * @returns {{conflict:boolean, label:string|null, dueMs:number|null, dueLimitMs:number|null,
 *            arrivalMs:number|null, arrivalSource:'splits'|'entryAt'|null, splitCount:number,
 *            pastDue:boolean, reason:string|null, source:Object}}
 */
export const dueConflict = ({ lot = null, arrival = null, todayStartMs } = {}) => {
    requireTodayStart(todayStartMs, 'dueConflict');
    const day0 = dayStartOf(todayStartMs);
    const dueMs = dueMsOfLot(lot);
    const { arrivalMs, arrivalSource, splitCount } = earliestArrivalMs({ lot, arrival });
    if (dueMs == null) {
        return {
            conflict: false, label: null,
            dueMs: null, dueLimitMs: null, arrivalMs, arrivalSource, splitCount,
            pastDue: false,
            reason: '納期が読み取れないため、入荷との前後は出せません(dueDateが空か読めない形式)',
            source: sourceOf(),
        };
    }
    const dueLimitMs = dueMs + DAY_MS - 1;              // 納期当日いっぱい
    const pastDue = dueMs < day0;
    if (arrivalMs == null) {
        return {
            conflict: false, label: null,
            dueMs, dueLimitMs, arrivalMs: null, arrivalSource: null, splitCount,
            pastDue,
            reason: '入荷の時刻が読み取れないため、納期との前後は出せません(到着予定の便に日時が無く、entryAtも無し)',
            source: sourceOf(),
        };
    }
    const conflict = arrivalMs > dueLimitMs;
    return {
        conflict, label: conflict ? CONFLICT_LABEL : null,
        dueMs, dueLimitMs, arrivalMs, arrivalSource, splitCount,
        pastDue,
        reason: null,
        source: sourceOf(),
    };
};
