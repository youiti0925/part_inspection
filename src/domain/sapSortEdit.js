// ✏ SAP 工程の仕分けの登録を「直す」ための部品(純粋関数・保存はしない)
// 目的: 管理者の登録画面(SapSortAdmin.jsx)が使う、作業区 → グループの付け替え・重ね入れ・テンプレートの結びつけ・辞書の書き換え・保存前の「今 → 変えた後」の比べ。登録は元を変えず新しい物を返す。
// 入力: 登録 sap-sort/1・作業区の番号(文字)・グループの目印 / 仕分ける行 [{ text, code, n }] / 辞書 labels/1
// 出力: 新しい登録・数え直した表(グループごとの件数の 今 → 変えた後・未分類・全体の和が変わらない事)・画面に出す文字列
// 触る外の物: なし(ネットワーク・Firebase・保存に触れない。保存は sapSortStore.js の saveSapSort=管理者だけ)
// 確かめ方: node --test src/domain/__tests__/sapSortEdit.test.mjs
import { validateSapSort, groupsOfWc, withTemplateOps } from './sapSort.js';
import { summarizeSort } from './sapSortStore.js';
import { cleanLabels, LABELS_SCHEMA } from './labels.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const isNum = (w) => /^\d{1,6}$/.test(String(w));

/** 範囲の並びを 小さい順にして、重なる・隣り合う物を1つにまとめる(2390〜2396 と 2397 → 2390〜2397) */
function mergeRanges(rs) {
    const s = rs.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const out = [];
    for (const r of s) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push(r);
    }
    return out;
}

/** 範囲の並びから 番号 n を抜く(真ん中なら2つに割る) */
function cutOut(rs, n) {
    const out = [];
    for (const [a, b] of rs) {
        if (n < a || n > b) { out.push([a, b]); continue; }
        if (a <= n - 1) out.push([a, n - 1]);
        if (n + 1 <= b) out.push([n + 1, b]);
    }
    return out;
}

/** 仕分け先に選べるグループ(工程のまとまり・重ね入れ用は除く): [{ commander, key, name, count }] */
export function sortTargets(reg) {
    const out = [];
    for (const c of (reg && reg.commanders) || []) for (const g of c.groups || []) {
        if (g.type === 'process' && g.shared !== true) out.push({ commander: c.key, key: g.key, name: g.name, count: g.count !== false });
    }
    return out;
}

/** グループの「番号の範囲」を人が読む文字にする: 2313〜2319・2397 */
export function rangeText(g) {
    const rs = (g && g.wcRanges) || [];
    return rs.map(([a, b]) => (a === b ? String(a) : `${a}〜${b}`)).join('・');
}

/** グループに入っている作業区(番号の文字)を全部出す。範囲が大きすぎる時は出さない(画面が固まらない様に) */
export function wcsInGroup(g, limit = 200) {
    const out = [];
    for (const w of (g && g.wc) || []) out.push(String(w));
    for (const [a, b] of (g && g.wcRanges) || []) { if (b - a >= limit) continue; for (let n = a; n <= b; n++) out.push(String(n)); }
    return out;
}

/** 作業区 wc を、グループ groupKey の仕事にする(新しい登録を返す・元は変えない)。
 *  shared=false(基本): 前に入っていたグループからは抜く(1つの工程は1つのグループ=二重に数えない)。
 *  shared=true: 前のグループには残したまま「重ね入れ」だけ足す(見るだけ・数には足さない・「重なっている」の印が出る) */
export function assignWc(reg, wc, groupKey, { shared = false } = {}) {
    const w = String(wc).trim();
    if (!isNum(w)) throw new Error(`作業区の番号が読めません: ${String(wc)}`);
    const n = Number(w);
    const o = clone(reg);
    let target = null, owner = null;
    for (const c of o.commanders) for (const g of c.groups) if (g.key === groupKey && g.type === 'process' && g.shared !== true) { target = g; owner = c; }
    if (!target) throw new Error(`グループ ${groupKey} が登録にありません(工程のまとまりだけ選べます)`);
    if (shared) {
        const key = `${groupKey}__shared`;
        let sg = owner.groups.find((g) => g.key === key);
        if (!sg) {
            sg = { key, name: `${target.name}(重ね)`, type: 'process', kind: target.kind || 'machine', count: false, shared: true, wcRanges: [] };
            owner.groups.push(sg);
        }
        sg.wcRanges = mergeRanges([...(sg.wcRanges || []), [n, n]]);
        return o;
    }
    for (const c of o.commanders) for (const g of c.groups) {
        if (g.shared === true || g === target) continue;
        if (Array.isArray(g.wcRanges)) g.wcRanges = cutOut(g.wcRanges, n);
    }
    target.wcRanges = mergeRanges([...(target.wcRanges || []), [n, n]]);
    return o;
}

/** 重ね入れだけを外す(元のグループは変えない)。空になった重ね入れのグループは消す */
export function removeShared(reg, wc, groupKey) {
    const n = Number(wc);
    const o = clone(reg);
    for (const c of o.commanders) {
        for (const g of c.groups) if (g.shared === true && g.key === `${groupKey}__shared`) g.wcRanges = cutOut(g.wcRanges || [], n);
        c.groups = c.groups.filter((g) => !(g.shared === true && g.key === `${groupKey}__shared` && !(g.wcRanges || []).length));
    }
    return o;
}

/** 作業区ごとの今の行き先(数える先)と重ね入れ: { wc, group, name, shared:[{key,name}] } */
export function placementOf(reg, wc) {
    const gs = groupsOfWc(wc, reg);
    const byKey = new Map();
    for (const c of reg.commanders) for (const g of c.groups) byKey.set(g.key, g);
    const main = gs.find((x) => !x.shared) || null;
    return {
        wc: String(wc),
        group: main ? main.group : null,
        name: main ? (byKey.get(main.group) || {}).name || main.group : null,
        shared: gs.filter((x) => x.shared).map((x) => ({ key: x.group, name: (byKey.get(x.group) || {}).name || x.group })),
    };
}

/** 保存の前の確かめ: 行を 今の登録 before と 変えた後の after で数え直す。
 *  戻り: { total:{before,after,same}, groups:[{ key, name, before, after }](どちらかが0でない・並びは after の登録の順), unclassified:{before,after}, overlaps:[…], valid, errors } */
export function compareSort(rows, before, after) {
    const sb = summarizeSort(rows, before), sa = summarizeSort(rows, after);
    const names = new Map();
    for (const reg of [before, after]) for (const c of reg.commanders) for (const g of c.groups) if (!names.has(g.key)) names.set(g.key, g.name);
    const order = [];
    for (const reg of [after, before]) for (const c of reg.commanders) for (const g of c.groups) if (!order.includes(g.key)) order.push(g.key);
    if (!order.includes('misc')) order.push('misc');
    const groups = [];
    for (const k of order) {
        const b = sb.byGroup[k] || 0, a = sa.byGroup[k] || 0;
        if (b || a) groups.push({ key: k, name: k === 'misc' ? '付帯作業(まだ仕分けていない物を含む)' : names.get(k) || k, before: b, after: a });
    }
    const v = validateSapSort(after);
    return {
        total: { before: sb.total, after: sa.total, same: sb.total === sa.total },
        groups, unclassified: { before: sb.unclassified.n, after: sa.unclassified.n },
        unclassifiedList: sa.unclassified.byWc, overlaps: sa.overlaps, valid: v.ok, errors: v.errors,
    };
}

/** 登録が同じ中身か(変えていないのに「保存」を押せない様に) */
export const sameReg = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 辞書: 司令塔 commanderKey の labels に 目印 key の言い換えを入れる(空文字なら「今のまま」に戻す=その目印の上書きを消す)。長さ・件数の上限は cleanLabels に任せ、通らない時は理由を返す */
export function withLabel(reg, commanderKey, part, key, value) {
    if (part !== 'keys' && part !== 'words') throw new Error('part は keys か words');
    const o = clone(reg);
    const c = o.commanders.find((x) => x.key === commanderKey);
    if (!c) throw new Error(`司令塔 ${commanderKey} が登録にありません`);
    const cur = c.labels && typeof c.labels === 'object' ? c.labels : { schema: LABELS_SCHEMA, words: {}, keys: {} };
    const next = { schema: LABELS_SCHEMA, words: { ...(cur.words || {}) }, keys: { ...(cur.keys || {}) } };
    const v = String(value ?? '').trim();
    if (!v) delete next[part][key]; else next[part][key] = v;
    const { problems } = cleanLabels(next);
    if (problems.length) return { reg: reg, problems };
    if (Object.keys(next.words).length || Object.keys(next.keys).length) c.labels = next; else delete c.labels;
    return { reg: o, problems: [] };
}

/** 辞書を全部「既定(今の文字)」に戻す */
export function clearLabels(reg, commanderKey) {
    const o = clone(reg);
    const c = o.commanders.find((x) => x.key === commanderKey);
    if (c) delete c.labels;
    return o;
}

/** 司令塔の辞書の今の上書き { words, keys }(無ければ空) */
export function labelsOf(reg, commanderKey) {
    const c = ((reg && reg.commanders) || []).find((x) => x.key === commanderKey);
    return cleanLabels(c && c.labels).labels;
}

/** テンプレートの選び肢: 品目コード専用テンプレ(model_templates)と共通テンプレから { id, label, model } を作る。id は wcsOfTemplate の引き方と同じ(専用=品目コード__テンプレID・共通=テンプレID) */
export function templateChoices({ templates = [], modelTemplates = [] } = {}) {
    const out = [];
    for (const t of templates || []) if (t && t.id) out.push({ id: String(t.id), label: String(t.name || t.id), model: '' });
    for (const m of modelTemplates || []) {
        if (!m || !m.model || !m.templateId) continue;
        out.push({ id: `${m.model}__${m.templateId}`, label: String(m.baseName || m.templateId), model: String(m.model) });
    }
    return out;
}

/** 結びつけに使える作業区(検査の現場のグループの wc): [{ wc, label, group }]。例 2509 三次元検査 */
export function siteWcChoices(reg) {
    const out = [];
    for (const c of (reg && reg.commanders) || []) for (const g of c.groups || []) {
        if (g.type !== 'site') continue;
        for (const w of g.wc || []) out.push({ wc: String(w), label: (g.wcNames && g.wcNames[w]) || g.name, group: g.key });
    }
    return out;
}

/** テンプレート id に結びついている作業区を全グループから集める(無ければ []) */
export function linkedWcs(reg, templateId) {
    const out = [];
    for (const c of (reg && reg.commanders) || []) for (const g of c.groups || []) {
        const ops = g.templateOps;
        if (ops && typeof ops === 'object' && Array.isArray(ops[templateId])) out.push(...ops[templateId].map(String));
    }
    return out;
}

/** テンプレート id を SAP の作業区 wc に結びつける(元の結びつけは外してから入れる・wc が空なら外すだけ)。
 *  作業区は検査の現場のグループに入っている物だけ。知らない作業区なら例外(画面の選び肢からしか入れない) */
export function setTemplateWc(reg, templateId, wc) {
    let o = clone(reg);
    for (const c of o.commanders) for (const g of c.groups) {
        if (g.templateOps && Array.isArray(g.templateOps[templateId])) o = withTemplateOps(o, g.key, templateId, []);
    }
    const w = String(wc || '').trim();
    if (!w) return o;
    for (const c of o.commanders) for (const g of c.groups) if (g.type === 'site' && (g.wc || []).includes(w)) return withTemplateOps(o, g.key, templateId, [w]);
    throw new Error(`作業区 ${w} は検査の現場のグループにありません`);
}

// ---- SAP の表から数えた行を、登録の画面へ渡す小さな置き場(メモリの中だけ・保存しない・指図番号は持たない) ----
let sharedRows = [];
const rowSubs = new Set();
export const getSharedSortRows = () => sharedRows;
export function setSharedSortRows(rows) { sharedRows = Array.isArray(rows) ? rows : []; rowSubs.forEach((f) => { try { f(sharedRows); } catch { /* 1つの失敗で他を止めない */ } }); }
export function subscribeSharedSortRows(f) { rowSubs.add(f); return () => rowSubs.delete(f); }
