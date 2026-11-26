// 🗂 SAP 工程の仕分けの登録を読んで、1つの工程を「どの司令塔のどのグループか」に分ける(純粋関数)
// 目的: 今まで sapProgress.js・sapBoard.js・束を作る係(feed.py)に別々に書いてあった分類表を、登録 sap-sort/1(sap_sort.default.json)1つにまとめる。
// 入力: classifyOp(作業テキスト, 作業区, 登録) / validateSapSort(登録) / resolveSapSort(登録の候補)
// 出力: { name, kind, group, commander }(kind: machine / inspect / wash / misc)・並び順・アプリ別の作業区
// 触る外の物: なし(同梱の JSON を読むだけ・Firebase・ネットワーク・保存に触れない)。今使う登録の差し替え(setActiveSapSort)はメモリの中だけ
// 確かめ方: node --test src/domain/__tests__/sapSort.test.mjs
import bundled from './sap_sort.default.json' with { type: 'json' };

export const SAP_SORT_SCHEMA = 'sap-sort/1';

/** 登録が無い・壊れている時の最後の砦(切り替え前の表そのまま・コード側の既定)。同梱の JSON と同じ答えになる事を試験で守る */
export function buildCodeDefault() {
    const RANGES = [['lathe', '旋盤', 2313, 2319], ['lathe_v', '立旋盤', 2341, 2349], ['milling', 'フライス', 2320, 2329], ['mc_h', '横M/C', 2351, 2359],
        ['mc_g', '門M/C', 2361, 2369], ['grind_flat', '平面研削', 2381, 2389], ['grind_round', '円筒研削', 2371, 2379], ['gear', '歯切り', 2390, 2396], ['change', '仕様変更', 2330, 2336]];
    const g = RANGES.map(([key, name, a, b]) => ({ key, name, type: 'process', kind: 'machine', count: true, wcRanges: [[a, b]] }));
    g.push({ key: 'wash', name: '面取り洗浄', type: 'process', kind: 'wash', count: true, wcRanges: [] });
    return {
        schema: SAP_SORT_SCHEMA, rev: 1,
        commanders: [
            { key: 'inspect', name: '検査', order: 1, groups: [
                { key: 'product', name: '製品', type: 'site', app: 'product', wc: ['2309'] },
                { key: 'final', name: '最終', type: 'site', app: 'final', wc: ['2526'] },
                { key: 'parts', name: '部品', type: 'site', app: 'parts', wc: ['2509', '2519'], wcNames: { 2509: '三次元検査', 2519: '受入検査' } }] },
            { key: 'machine', name: '機械', order: 2, groups: g,
                textRules: [['平面研削', 'grind_flat'], ['円筒研削', 'grind_round'], ['歯切り', 'gear'], ['ﾌﾗｲｽ', 'milling'], ['フライス', 'milling'],
                    ['門M/C', 'mc_g'], ['横M/C', 'mc_h'], ['立旋盤', 'lathe_v'], ['旋盤', 'lathe']],
                special: { wash: { textHas: ['洗浄'], to: 'wash' },
                    misc: { name: '付帯作業', headStarts: ['付帯作業'], textHas: ['一時置き', '応援', '現合'], nameIfTextHas: ['一時置き', '付帯作業(一時置き)'], count: false },
                    change: { headStarts: ['仕様変更'], fallbackTo: 'change' } } }],
        laneOrder: ['旋盤', '立旋盤', 'フライス', '横M/C', '門M/C', '平面研削', '円筒研削', '歯切り', '仕様変更', '面取り洗浄', '受入検査', '三次元検査', '検査'],
    };
}

const isStrList = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');

/** 登録の形の検査 → { ok, errors: [日本語の理由] }(知らない版・空・重なり・つなぎの切れを赤にする) */
export function validateSapSort(reg) {
    const errors = [];
    if (!reg || typeof reg !== 'object') return { ok: false, errors: ['登録が空です'] };
    if (reg.schema !== SAP_SORT_SCHEMA) return { ok: false, errors: [`知らない版の登録です(${String(reg.schema)})`] };
    if (!Array.isArray(reg.commanders) || !reg.commanders.length) return { ok: false, errors: ['司令塔が1つもありません'] };
    const keys = new Set(), wcSeen = new Map(), ranges = [];
    for (const c of reg.commanders) {
        if (!c || typeof c.key !== 'string' || !Array.isArray(c.groups)) { errors.push('司令塔の形が違います'); continue; }
        for (const g of c.groups) {
            if (!g || typeof g.key !== 'string' || typeof g.name !== 'string') { errors.push(`${c.key}: グループの形が違います`); continue; }
            if (keys.has(g.key)) errors.push(`グループの目印が重なっています: ${g.key}`);
            keys.add(g.key);
            // shared:true のグループ(見るだけの重ね入れ)は他と重なってよい。数には足さない(classifyOp は shared を見ない)。重なりの印は overlapMarks が出す
            // templateOps: 検査テンプレートごとの SAP の作業区の結びつけ { テンプレID または 品目コード__テンプレID: [作業区…] }。作業区はこのグループの wc の中だけ(知らない作業区は赤)
            if (g.templateOps != null) {
                if (typeof g.templateOps !== 'object' || Array.isArray(g.templateOps)) errors.push(`${g.key}: テンプレートの結びつけの形が違います`);
                else for (const [tid, list] of Object.entries(g.templateOps)) {
                    if (!tid) errors.push(`${g.key}: テンプレートの目印が空です`);
                    else if (!isStrList(list)) errors.push(`${g.key}: テンプレート ${tid} の作業区の一覧の形が違います`);
                    else for (const w of list) if (!(g.wc || []).includes(w)) errors.push(`${g.key}: テンプレート ${tid} の作業区 ${w} はこのグループにありません(知らない作業区)`);
                }
            }
            const sh = g.shared === true;
            if (g.wc != null) {
                if (!isStrList(g.wc)) errors.push(`${g.key}: 作業区の一覧の形が違います`);
                else if (!sh) for (const w of g.wc) { if (wcSeen.has(w)) errors.push(`作業区 ${w} が ${wcSeen.get(w)} と ${g.key} の両方に入っています`); wcSeen.set(w, g.key); }
            }
            for (const r of g.wcRanges || []) {
                if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] > r[1]) { errors.push(`${g.key}: 作業区の範囲の形が違います`); continue; }
                if (sh) continue;
                for (const o of ranges) if (r[0] <= o.b && o.a <= r[1]) errors.push(`作業区の範囲が重なっています: ${g.key}(${r[0]}〜${r[1]}) と ${o.key}`);
                ranges.push({ a: r[0], b: r[1], key: g.key });
            }
        }
        for (const [kw, gk] of c.textRules || []) {
            if (typeof kw !== 'string' || !kw) errors.push(`${c.key}: 言葉の決まりが空です`);
            else if (!c.groups.some((g) => g.key === gk)) errors.push(`${c.key}: 言葉「${kw}」の行き先 ${String(gk)} が見つかりません`);
        }
        const sp = c.special || {};
        if (sp.wash && (!isStrList(sp.wash.textHas) || !c.groups.some((g) => g.key === sp.wash.to))) errors.push(`${c.key}: 洗浄の決まりが壊れています`);
        if (sp.misc && (typeof sp.misc.name !== 'string' || !isStrList(sp.misc.headStarts) || !isStrList(sp.misc.textHas))) errors.push(`${c.key}: 付帯作業の決まりが壊れています`);
        // 付帯作業へ回す作業区の範囲(登録画面の「付帯作業(数えない)」・採点 P6): 形の検査と、他のグループの範囲との重なりの検査
        if (sp.misc && sp.misc.wcRanges != null) {
            if (!Array.isArray(sp.misc.wcRanges)) errors.push(`${c.key}: 付帯作業の作業区の範囲の形が違います`);
            else for (const r of sp.misc.wcRanges) {
                if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] > r[1]) { errors.push(`${c.key}: 付帯作業の作業区の範囲の形が違います`); continue; }
                for (const o of ranges) if (r[0] <= o.b && o.a <= r[1]) errors.push(`作業区の範囲が重なっています: 付帯作業(${r[0]}〜${r[1]}) と ${o.key}`);
                ranges.push({ a: r[0], b: r[1], key: 'misc' });
            }
        }
        if (sp.change && (!isStrList(sp.change.headStarts) || !c.groups.some((g) => g.key === sp.change.fallbackTo))) errors.push(`${c.key}: 仕様変更の決まりが壊れています`);
    }
    // 検査の作業区(site)が 工程の範囲に入っている登録は 何も変わらず登録だけ汚れる(仕分けは検査が先)ので赤にする(採点 P8④)
    for (const c of reg.commanders) for (const g of c && Array.isArray(c.groups) ? c.groups : []) {
        if (!g || g.type !== 'site' || !isStrList(g.wc)) continue;
        for (const w of g.wc) { const n = Number(w); const hit = ranges.find((o) => Number.isFinite(n) && n >= o.a && n <= o.b); if (hit) errors.push(`作業区 ${w} は検査の作業区ですが、${hit.key} の範囲に入っています`); }
    }
    const mc = reg.commanders.find((c) => c && c.special && c.special.misc);
    if (!mc) errors.push('付帯作業の決まりがありません(どれにも当たらない工程の行き先が決まりません)');
    if (!isStrList(reg.laneOrder)) errors.push('並び順 laneOrder がありません');
    return { ok: errors.length === 0, errors };
}

const CODE_DEFAULT = buildCodeDefault();
const BUNDLED_OK = validateSapSort(bundled).ok;
/** 既定の登録 = 同梱の JSON(壊れていたらコードの既定) */
export const DEFAULT_SAP_SORT = BUNDLED_OK ? bundled : CODE_DEFAULT;

/** 登録の候補 → { reg, usedDefault, errors }。無い・壊れている・知らない版なら今と同じ分け方(既定)で動き、理由を errors に返す */
export function resolveSapSort(candidate) {
    if (candidate == null) return { reg: DEFAULT_SAP_SORT, usedDefault: true, errors: [] };
    const v = validateSapSort(candidate);
    if (v.ok) return { reg: candidate, usedDefault: false, errors: [] };
    return { reg: DEFAULT_SAP_SORT, usedDefault: true, errors: v.errors };
}

// 今使う登録(既定=同梱の物)。登録を読み込めた時だけ setActiveSapSort で差し替える(旗 ON の時だけ・画面の並びなどの購読者へ知らせる)
let activeReg = DEFAULT_SAP_SORT;
const activeSubs = new Set();
export const getActiveSapSort = () => activeReg;
export function setActiveSapSort(reg) { activeReg = reg && validateSapSort(reg).ok ? reg : DEFAULT_SAP_SORT; activeSubs.forEach((f) => { try { f(activeReg); } catch { /* 1つの購読者の失敗で他を止めない */ } }); }
export function subscribeActiveSapSort(f) { activeSubs.add(f); return () => activeSubs.delete(f); }

const cache = new WeakMap();
function compile(reg) {
    const hit = cache.get(reg);
    if (hit) return hit;
    const inspect = new Map(), ranges = [], text = [];
    let wash = null, misc = null, change = null, cmd = null;
    for (const c of reg.commanders) {
        const byKey = new Map(c.groups.map((g) => [g.key, g]));
        for (const g of c.groups) {
            if (g.shared === true) continue;   // 見るだけの重ね入れは仕分けに使わない(二重に数えない)
            for (const [w, nm] of Object.entries(g.wcNames || {})) inspect.set(Number(w), { name: nm, kind: 'inspect', group: g.key, commander: c.key });
            for (const [a, b] of g.wcRanges || []) ranges.push({ a, b, name: g.name, kind: g.kind || 'machine', group: g.key, commander: c.key });
        }
        for (const [kw, gk] of c.textRules || []) { const g = byKey.get(gk); text.push({ kw, name: g.name, kind: g.kind || 'machine', group: g.key, commander: c.key }); }
        const sp = c.special || {};
        if (sp.wash && !wash) { const g = byKey.get(sp.wash.to); wash = { ...sp.wash, name: g.name, kind: g.kind || 'wash', group: g.key, commander: c.key }; }
        if (sp.misc && !misc) { misc = sp.misc; cmd = c.key; }
        if (sp.change && !change) { const g = byKey.get(sp.change.fallbackTo); change = { ...sp.change, name: g.name, kind: g.kind || 'machine', group: g.key, commander: c.key }; }
    }
    const out = { inspect, ranges, text, wash, misc, change, miscCommander: cmd };
    cache.set(reg, out);
    return out;
}

const startsAny = (s, list) => list.some((p) => s.startsWith(p));
const hasAny = (s, list) => list.some((p) => s.includes(p));

/** 作業テキスト・作業区 → { name, kind, group, commander }。kind: machine / inspect / wash / misc。
 *  当てる順(先に当たった物で決まる・切り替え前の readWorkName と同じ): 検査の作業区 → 洗浄 → 付帯作業 → 作業区の範囲 → 仕様変更の言葉 → 工程名の言葉 → 付帯作業 */
export function classifyOp(text, code, reg = activeReg) { return classifyCore(text, code, reg).out; }

/** classifyOp と同じ答え + どの決まりで決まったか via(inspect/wash/misc/range/change/text/none)。none=どの決まりにも当たらず付帯作業へ落ちた物=「まだ仕分けていない物」 */
export function classifyCore(text, code, reg = activeReg) {
    const k = compile(reg);
    const raw = String(text || '').replace(/：/g, ':').replace(/\s+/g, ' ').trim();
    const t = raw.replace(/^\d{4}[:\s]+/, '');   // 先頭の「2385:」を外す
    const c = Number(code);
    const ins = k.inspect.get(c);
    if (ins) return { out: { ...ins }, via: 'inspect' };
    if (k.wash && hasAny(t, k.wash.textHas)) return { out: { name: k.wash.name, kind: k.wash.kind, group: k.wash.group, commander: k.wash.commander }, via: 'wash' };
    const head = t.split(':')[0];
    const isChange = !!k.change && startsAny(head, k.change.headStarts);
    const m = k.misc;
    const miscOut = (name, via = 'misc') => ({ out: { name, kind: 'misc', group: 'misc', commander: k.miscCommander }, via });
    if (!isChange && (startsAny(head, m.headStarts) || hasAny(t, m.textHas))) {
        const nt = m.nameIfTextHas;
        return miscOut(nt && t.includes(nt[0]) ? nt[1] : m.name);
    }
    if (m.wcRanges && m.wcRanges.some(([a, b]) => c >= a && c <= b)) return miscOut(m.name, 'misc');   // 登録画面で「付帯作業(数えない)」へ回した作業区
    const r = k.ranges.find((x) => c >= x.a && c <= x.b);
    if (r) return { out: { name: r.name, kind: r.kind, group: r.group, commander: r.commander }, via: 'range' };
    if (isChange) {
        const h = k.text.find((x) => t.includes(x.kw));
        return { out: h ? { name: h.name, kind: h.kind, group: h.group, commander: h.commander } : { name: k.change.name, kind: k.change.kind, group: k.change.group, commander: k.change.commander }, via: 'change' };
    }
    const h = k.text.find((x) => head.includes(x.kw) || t.includes(x.kw));
    if (h) return { out: { name: h.name, kind: h.kind, group: h.group, commander: h.commander }, via: 'text' };
    return miscOut(m.name, 'none');
}

/** 画面の並び順(旧 sapBoard.js の LANE_ORDER) */
export const laneOrderOf = (reg = activeReg) => reg.laneOrder.slice();

/** アプリごとの作業区の表(旧 app_wcs.json の apps): { product:['2309'], final:['2526'], parts:['2509','2519'] } */
export function appWcsOf(reg = activeReg) {
    const out = {};
    for (const c of reg.commanders) for (const g of c.groups) if (g.type === 'site' && g.app) out[g.app] = g.wc.slice();
    return out;
}

/** 束 machine に入れる工程の kind(旧 machine_rules.json の machine_kinds): 負荷に数えるグループの kind */
export function machineKindsOf(reg = activeReg) {
    const s = new Set();
    for (const c of reg.commanders) for (const g of c.groups) if (g.type === 'process' && g.count) s.add(g.kind || 'machine');
    return ['machine', 'wash'].filter((x) => s.has(x));
}

/** 作業区(番号)が入っているグループを全部返す(1つ目=数えるグループ・shared の重ね入れは後ろ)。戻り: [{ commander, group, shared }] */
export function groupsOfWc(code, reg = activeReg) {
    const c = Number(code), s = String(code == null ? '' : code).trim(), out = [];
    for (const cm of reg.commanders) for (const g of cm.groups) {
        const hit = (g.wc || []).includes(s) || (g.wcRanges || []).some(([a, b]) => Number.isFinite(c) && c >= a && c <= b);
        if (hit) out.push({ commander: cm.key, group: g.key, shared: g.shared === true });
    }
    return out.sort((x, y) => Number(x.shared) - Number(y.shared));
}

/** 「重なっている」の印: 2つ以上のグループに入っている作業区の一覧 [{ wc, groups:[key…] }](数える先は1つだけ・重ね入れは数に足さない) */
export function overlapMarks(reg = activeReg) {
    const wcs = new Set();
    for (const cm of reg.commanders) for (const g of cm.groups) {
        for (const w of g.wc || []) wcs.add(w);
        for (const [a, b] of g.wcRanges || []) if (b - a <= 1000) for (let n = a; n <= b; n++) wcs.add(String(n));
    }
    const out = [];
    for (const w of [...wcs].sort()) { const gs = groupsOfWc(w, reg); if (gs.length > 1) out.push({ wc: w, groups: gs.map((x) => x.group) }); }
    return out;
}

/** テンプレート → SAP の作業区。結びつけが無い・壊れている・知らない作業区だけ なら [](=今と同じ・品目と作業区だけで見る)。
 *  引き方: 「品目コード__テンプレID」(専用)があればそれ・無ければ「テンプレID」。戻り: 作業区(文字)の配列 */
export function wcsOfTemplate(templateId, model = '', reg = activeReg) {
    try {
        for (const cm of reg.commanders) for (const g of cm.groups) {
            const ops = g.templateOps;
            if (!ops || typeof ops !== 'object' || Array.isArray(ops)) continue;
            const own = (g.wc || []);
            for (const k of [model ? `${model}__${templateId}` : null, String(templateId)]) {
                if (k && Array.isArray(ops[k])) return ops[k].filter((w) => typeof w === 'string' && own.includes(w));
            }
        }
    } catch { /* 壊れていても 今と同じ([])で動く */ }
    return [];
}

/** 結びつけを1つ直した新しい登録を返す(元は変えない・検査の司令塔の groupKey のグループに入れる)。wcs が空なら そのテンプレの結びつけを外す。書くのは saveSapSort(管理者だけ) */
export function withTemplateOps(reg, groupKey, templateId, wcs) {
    const o = JSON.parse(JSON.stringify(reg));
    for (const cm of o.commanders) for (const g of cm.groups) if (g.key === groupKey) {
        const ops = { ...(g.templateOps && typeof g.templateOps === 'object' && !Array.isArray(g.templateOps) ? g.templateOps : {}) };
        if (wcs && wcs.length) ops[templateId] = wcs.map(String); else delete ops[templateId];
        if (Object.keys(ops).length) g.templateOps = ops; else delete g.templateOps;
        return o;
    }
    throw new Error(`グループ ${groupKey} が登録にありません`);
}
