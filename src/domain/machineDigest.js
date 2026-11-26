// 🏯 機械の集計(最上位司令塔へ載せる物): 機械グループの画面の答えから「グループ名×週の%と件数」だけを取り出し、入れてよい欄だけかを検査して1件だけ書く
// 目的: 清水さん 11-26「1」=機械の様子を どの端末の最上位司令塔でも見られる様にする。外(Firebase)へ出すのは グループ名×週の%と件数だけ。
//       指図番号・品目・品名・客先・金額・作業者名・作業テキストは 出さない(設計書 docs/設計_最上位司令塔_全体_1125.md §3.2 #5・§6 ⑥)。
// 入力: cap(capacityGroups の答え=画面と同じ)・handoffs(handoffList の答え)・基準日・作った時刻・登録(sap-sort)・sortSummary(summarizeSort の答え)・basis(画面の設定)
// 出力: buildMachineDigest → 載せる1件(schema 'top-machine/1') / validateMachineDigest → { ok, errors } / publishMachineDigest(管理者だけ・押した時の1件だけ書く)
// 呼ぶ人: TopPublishBar.jsx(機械グループの画面の「最上位司令塔へ載せる」)・試験
// 触る外の物: 窓口経由で overview-app-v1/top_status/machine の1件を書く(publishMachineDigest だけ・読まない)。ほかは純関数(Firebase・時計に触れない)
// 確かめ方: node --test src/domain/__tests__/machineDigest.test.mjs ／ emulator: node scripts/verify-top-machine-emulator.mjs
//
// 🚨 ここで新しい計算をしない。数は 画面の capacityGroups・handoffList・summarizeSort の答えを写すだけ(丸めも画面の pc() と同じ)。
// 🚨 出す欄は下の SPEC に書いた物だけ。知らない欄・指図らしい長い数字列(6桁以上)・長すぎる文字・大きすぎる文書は 書かずに止める。
import { appWcsOf } from './sapSort.js';
import { isSapSortAdmin, SapSortError } from './sapSortStore.js';

export const DIGEST_SCHEMA = 'top-machine/1';
export const TOP_NS = 'overview-app-v1';      // 司令塔③の名前空間(最上位司令塔の置き場)
export const TOP_COL = 'top_status';
export const TOP_DOC = 'machine';
export const MAX_BYTES = 32 * 1024;           // 数十KB の上限(実際は数KB)

export class MachineDigestError extends Error {
    constructor(code, message, detail) { super(message); this.name = 'MachineDigestError'; this.code = code; this.detail = detail || null; }
}

// ---- 形の決まり(これ以外の欄は 全部「知らない欄」として落とす) ----
const int = (min = 0, max = 1e7) => ({ t: 'int', min, max });
const NAME = { t: 'str', max: 24, kind: 'name' };
const SPEC = {
    t: 'obj', keys: {
        schema: { t: 'enum', vals: [DIGEST_SCHEMA] },
        builtAt: int(1, 1e14),
        baseDate: { t: 'str', max: 10, re: /^\d{4}-\d{2}-\d{2}$/ },
        sortRev: int(0, 1e6),
        basis: { t: 'obj', keys: { resource: { t: 'enum', vals: ['machine', 'worker'] }, otHours: { t: 'num', min: 0, max: 12 }, saturday: { t: 'bool' }, perQty: { t: 'bool' } } },
        weeks: { t: 'arr', max: 8, of: { t: 'obj', keys: { name: { t: 'str', max: 8, re: /^(今週|来週|\d{1,2}週後)$/ }, label: { t: 'str', max: 16, re: /^\d{1,2}\/\d{1,2}〜\d{1,2}\/\d{1,2}$/ }, thin: { t: 'bool' } } } },
        groups: { t: 'arr', max: 30, of: { t: 'obj', keys: {
            key: NAME, name: NAME, workCenters: int(0, 999), open: int(0, 1e6),
            pcts: { t: 'arr', max: 8, of: { t: 'int', min: 0, max: 1e6, nullable: true } },
            peakPct: { t: 'int', min: 0, max: 1e6, nullable: true },
            status: { t: 'enum', vals: ['over', 'tight', 'ok'] },
            carryH: int(0, 1e7), carryN: int(0, 1e6),
        } } },
        summary: { t: 'obj', keys: { reds: { t: 'arr', max: 30, of: NAME }, allCarryH: int(0, 1e7), allCarryN: int(0, 1e6), groupCount: int(0, 999) } },
        today: { t: 'obj', keys: { finishToday: int(0, 1e6), doneToday: int(0, 1e6), toParts: int(0, 1e6) } },
        flow: { t: 'arr', max: 60, of: { t: 'obj', keys: { from: NAME, to: NAME, n: int(0, 1e6) } } },
        unsorted: { t: 'obj', keys: { n: int(0, 1e6), wcs: { t: 'arr', max: 30, of: { t: 'obj', keys: { wc: { t: 'str', max: 6, re: /^[0-9A-Za-z-]{1,6}$/ }, n: int(0, 1e6) } } } } },
    },
};
const LONG_DIGITS = /\d{6,}/;     // 指図番号らしい数字の並び(作業区は4桁・日付は4桁と2桁なので当たらない)
const DIGIT_RUN_IN_NAME = /\d{5,}/;

function check(v, spec, path, errors) {
    const bad = (m) => errors.push(`${path}: ${m}`);
    switch (spec.t) {
        case 'obj': {
            if (!v || typeof v !== 'object' || Array.isArray(v)) { bad('オブジェクトではありません'); return; }
            for (const k of Object.keys(v)) if (!(k in spec.keys)) bad(`知らない欄「${k}」があります(出せるのは決めた欄だけ)`);
            for (const k of Object.keys(spec.keys)) {
                if (!(k in v)) { bad(`欄「${k}」がありません`); continue; }
                check(v[k], spec.keys[k], `${path}.${k}`, errors);
            }
            return;
        }
        case 'arr': {
            if (!Array.isArray(v)) { bad('配列ではありません'); return; }
            if (v.length > spec.max) { bad(`多すぎます(${v.length} > ${spec.max})`); return; }
            v.forEach((x, i) => check(x, spec.of, `${path}[${i}]`, errors));
            return;
        }
        case 'int': {
            if (v === null && spec.nullable) return;
            if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) bad(`整数(${spec.min}〜${spec.max})ではありません: ${String(v)}`);
            return;
        }
        case 'num': { if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) bad(`数(${spec.min}〜${spec.max})ではありません: ${String(v)}`); return; }
        case 'bool': { if (typeof v !== 'boolean') bad('真偽ではありません'); return; }
        case 'enum': { if (!spec.vals.includes(v)) bad(`決めた言葉ではありません: ${String(v).slice(0, 20)}`); return; }
        case 'str': {
            if (typeof v !== 'string' || v.length === 0 || v.length > spec.max) { bad(`文字(1〜${spec.max}字)ではありません`); return; }
            if (spec.re && !spec.re.test(v)) bad(`形が違います: ${v.slice(0, 20)}`);
            if (spec.kind === 'name' && (DIGIT_RUN_IN_NAME.test(v) || [...v].some((c) => c.charCodeAt(0) < 32))) bad(`名前に長い数字・制御文字は入れられません: ${v.slice(0, 20)}`);
            return;
        }
        default: bad('内部エラー');
    }
}

/** 載せる前の検査。知らない欄・形の違い・指図らしい数字列・大きすぎ を全部拾う。戻り: { ok, errors } */
export function validateMachineDigest(doc) {
    const errors = [];
    check(doc, SPEC, '集計', errors);
    if (errors.length === 0) {
        // 念のための二重の見張り: どの文字列(キー名も)にも 指図らしい長い数字列が無い
        const scan = (v, p) => {
            if (typeof v === 'string') { if (LONG_DIGITS.test(v)) errors.push(`${p}: 指図番号らしい数字列があります`); }
            else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${p}[${i}]`));
            else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (LONG_DIGITS.test(k)) errors.push(`${p}: 欄の名前に数字列があります`); scan(x, `${p}.${k}`); }
        };
        scan(doc, '集計');
        const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
        if (bytes > MAX_BYTES) errors.push(`集計: 大きすぎます(${bytes} バイト > ${MAX_BYTES})`);
    } else if (doc && typeof doc === 'object') {
        // 形が違う時も大きすぎは言う(原因を1つでも多く)
        try { const bytes = new TextEncoder().encode(JSON.stringify(doc)).length; if (bytes > MAX_BYTES) errors.push(`集計: 大きすぎます(${bytes} バイト > ${MAX_BYTES})`); } catch { /* 数えられなくても止める */ }
    }
    return { ok: errors.length === 0, errors };
}

// ---- 作る ----
const pc = (p) => (Number.isFinite(p) ? Math.round(p * 100) : null);   // MachineGroupView の pc() と同じ丸め

/** SAP の行(readSapXlsx の rows)→ 仕分けの数え方に渡す行 [{ text, code, n }]。未完了(実績終了が空)の行だけを 作業区×作業テキストごとに数える */
export function sortRowsOf(rows) {
    const m = new Map();
    for (const r of rows || []) {
        if (!r || r.I) continue;   // 済(実績終了あり)は数えない
        const text = String(r.D ?? ''), code = String(r.C ?? '');
        const k = `${code}\u0000${text}`;
        const e = m.get(k) || { text, code, n: 0 };
        e.n++; m.set(k, e);
    }
    return [...m.values()];
}

const keyOfGroup = (reg, name) => {
    for (const c of (reg && reg.commanders) || []) for (const g of c.groups || []) if (g && g.name === name && g.key) return String(g.key);
    return name;
};

/**
 * 載せる1件を作る。入れる欄を 1つずつ名指しで取り出す(cap の中の top=指図・品目の一覧などは 触らない)。
 * @param {{ cap:object, handoffs?:Array, todayIso:string, builtAtMs:number, reg?:object, sortSummary?:object|null, basis?:object }} p
 */
export function buildMachineDigest({ cap, handoffs = [], todayIso, builtAtMs, reg = null, sortSummary = null, basis = {} } = {}) {
    if (!cap || !Array.isArray(cap.groups) || !Array.isArray(cap.weeks)) throw new MachineDigestError('no-cap', '機械グループの答えがありません');
    const groups = cap.groups.map((g) => {
        const pcts = g.cells.map((c) => pc(c.pct));
        const first3 = g.cells.slice(0, 3);
        const over = g.verdict && g.verdict.level === 'red';
        // 持ち越しが多い(画面は「持ち越しが 全台で 約n日分」で黄色)グループも ぎりぎり に数える(上が「予定通り」になってしまうのを防ぐ・採点 P10)
        const tight = !over && (first3.some((c) => c.level === 'yellow') || (g.verdict && g.verdict.level === 'yellow'));
        const peaks = first3.map((c) => pc(c.pct)).filter((x) => x != null);
        return {
            key: keyOfGroup(reg, g.name), name: String(g.name),
            workCenters: g.wcs.length, open: g.n,
            pcts, peakPct: peaks.length ? Math.max(...peaks) : null,
            status: over ? 'over' : tight ? 'tight' : 'ok',
            carryH: Math.round(g.carry), carryN: g.carryN,
        };
    });
    // 今日の件数: 画面の「次の工程(作業区)への連絡」(handoffList)のうち、前の工程が機械グループの物だけを 日付=基準日で数える
    const machineNames = new Set(cap.groups.map((g) => g.name));
    const partsWcs = new Set(((reg && appWcsOf(reg)) || {}).parts || []);
    const mine = (Array.isArray(handoffs) ? handoffs : []).filter((h) => h && machineNames.has(h.fromName));
    const expectedToday = mine.filter((h) => h.kind === 'expected' && h.date === todayIso);
    const flowMap = new Map();
    for (const h of expectedToday) { const k = `${h.fromName}\u0000${h.toName}`; flowMap.set(k, (flowMap.get(k) || 0) + 1); }
    const flow = [...flowMap.entries()].map(([k, n]) => { const [from, to] = k.split('\u0000'); return { from, to, n }; })
        .sort((a, b) => b.n - a.n || (a.from + a.to < b.from + b.to ? -1 : 1)).slice(0, 60);
    const un = sortSummary && sortSummary.unclassified ? sortSummary.unclassified : { n: 0, byWc: [] };
    const doc = {
        schema: DIGEST_SCHEMA,
        builtAt: Math.round(Number(builtAtMs)),
        baseDate: String(todayIso),
        sortRev: reg && Number.isFinite(reg.rev) ? reg.rev : 0,
        basis: { resource: basis.resource === 'worker' ? 'worker' : 'machine', otHours: Number.isFinite(basis.otHours) ? basis.otHours : 0, saturday: !!basis.saturday, perQty: basis.perQty !== false },
        weeks: cap.weeks.map((w) => ({ name: w.name, label: w.label, thin: !!w.thin })),
        groups,
        summary: { reds: cap.summary.reds.map(String), allCarryH: Math.round(cap.summary.allCarry), allCarryN: cap.summary.allCarryN, groupCount: groups.length },
        today: {
            finishToday: expectedToday.length,
            doneToday: mine.filter((h) => h.kind === 'passed' && h.date === todayIso).length,
            toParts: expectedToday.filter((h) => partsWcs.has(String(h.toWc))).length,
        },
        flow,
        unsorted: { n: un.n || 0, wcs: (un.byWc || []).slice(0, 30).map((e) => ({ wc: /^[0-9A-Za-z-]{1,6}$/.test(String(e.wc)) ? String(e.wc) : '-', n: e.n })) },
    };
    const v = validateMachineDigest(doc);
    if (!v.ok) throw new MachineDigestError('invalid', `載せる物に間違いがあるので作りません: ${v.errors.slice(0, 5).join(' / ')}`, v.errors);
    return doc;
}

/** 載せられなかった理由を 現場の言葉にする(よく起きる2つ: グループの名前の長さ・数字が5桁以上。ほかは元の文のまま・採点 P12)。names=画面のグループ名の並び */
export function friendlyDigestError(e, names = []) {
    const list = e && Array.isArray(e.detail) ? e.detail : [];
    const m = list.map((x) => /groups\[(\d+)\]\.(name|key): 文字\(1〜24字\)ではありません/.exec(String(x))).find(Boolean);
    if (m) return `グループの名前『${names[Number(m[1])] ?? '?'}』が長すぎるので載せられません(24字まで)。名前を短くしてください。`;
    const d = list.map((x) => /groups\[(\d+)\]\.(name|key): 名前に長い数字/.exec(String(x))).find(Boolean);
    if (d) return `グループの名前『${names[Number(d[1])] ?? '?'}』に 長い数字(5桁以上)が入っているので載せられません。名前から数字を外してください。`;
    return e && e.message ? e.message : String(e);
}

/** 載せる表の基準日が今日でない時(古い表で新しい集計を上書きしない為の確かめ・採点 P13)。todayIso=表の基準日(YYYY-MM-DD)・nowMs=今 */
export function needsStaleConfirm(todayIso, nowMs) {
    const d = new Date(nowMs); const p = (n) => String(n).padStart(2, '0');
    return String(todayIso) !== `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 載せる(管理者だけ・押した時の1件だけ書く・読まない)。形が違う物は書かない。戻り: { bytes } */
export async function publishMachineDigest({ provider, digest, user } = {}) {
    if (!isSapSortAdmin(user && user.name)) throw new SapSortError('not-admin', '最上位司令塔へ載せられるのは管理者の人だけです。ヘッダー左上で「管理者」を選んでください。');
    if (!provider || typeof provider.save !== 'function') throw new MachineDigestError('no-provider', '保存の窓口がありません');
    const v = validateMachineDigest(digest);
    if (!v.ok) throw new MachineDigestError('invalid', `載せる物に間違いがあるので書きません: ${v.errors.slice(0, 5).join(' / ')}`, v.errors);
    await provider.save(TOP_NS, TOP_COL, TOP_DOC, digest, { merge: false });   // 丸ごと置き換える(前の欄を残さない)・書くのはこの1件だけ
    return { bytes: new TextEncoder().encode(JSON.stringify(digest)).length };
}
