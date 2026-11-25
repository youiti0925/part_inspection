// 🗄 SAP 工程の仕分けの登録の置き場: 読む(開いた時に1回・同じ日は端末の控え)・書く(管理者だけ)・未分類の数え方
// 目的: 登録 sap-sort/1 を Firestore の settings/sap_sort(1文書)に置く。Firestore は「配列の中の配列」を入れられないので、入れる時に形を変えて読む時に戻す。
// 入力: provider(getOne/save を持つ窓口)・名前空間・登録・使う人({ name }) / 仕分ける行 [{ text, code }]
// 出力: 読み込み結果 { reg, usedDefault, errors, source, commanderLabels } / 保存(管理者でなければ SapSortError で拒む)/ 未分類の件数と作業区の一覧
// 触る外の物: 窓口経由の settings/sap_sort の読み書きだけ(呼ぶ側が窓口を渡す)・端末の localStorage(控え・旗)。本番へ書く道はここだけで、管理者の区別を通らないと開かない
// 確かめ方: node --test src/domain/__tests__/sapSortStore.test.mjs ／ emulator: node scripts/verify-sap-sort-emulator.mjs
import { validateSapSort, resolveSapSort, DEFAULT_SAP_SORT, classifyCore, groupsOfWc, overlapMarks, setActiveSapSort } from './sapSort.js';
import { approxBytes, SAFE_BYTES } from './lotCapacity.js';

export const SAP_SORT_COL = 'settings';
export const SAP_SORT_ID = 'sap_sort';
const ADMIN_NAME = '管理者';   // アプリにある既存の管理者の区別(使用者の名前が「管理者」)と同じ
const FLAG_KEY = 'feature:sapSort';
const CACHE_KEY = 'sapSort:cache';

export class SapSortError extends Error {
    constructor(code, message, detail) { super(message); this.name = 'SapSortError'; this.code = code; this.detail = detail || null; }
}

/** 管理者か(アプリの既存の区別: 使用者名が「管理者」)。仕分け・まとまりを足す/直すのはこの人だけ(清水さん 11-25 Q4) */
export const isSapSortAdmin = (userName) => userName === ADMIN_NAME;

/** 旗: localStorage の feature:sapSort が '1' の時だけ ON(既定 OFF)。OFF の間は 登録も辞書も読みに行かない */
export function sapSortFlagOn() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}

const isArr = Array.isArray;

/** 登録 → 保存用の形(配列の中の配列を {a,b} / {kw,to} に開く)。元は変えない */
export function toStored(reg) {
    const o = JSON.parse(JSON.stringify(reg));
    for (const c of o.commanders || []) {
        if (isArr(c.textRules)) c.textRules = c.textRules.map((r) => (isArr(r) ? { kw: r[0], to: r[1] } : r));
        for (const g of c.groups || []) if (isArr(g.wcRanges)) g.wcRanges = g.wcRanges.map((r) => (isArr(r) ? { a: r[0], b: r[1] } : r));
    }
    return o;
}

/** 保存用の形 → 登録(toStored の逆)。もともと配列の形でも読める */
export function fromStored(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const o = JSON.parse(JSON.stringify(doc));
    for (const c of isArr(o.commanders) ? o.commanders : []) {
        if (c && isArr(c.textRules)) c.textRules = c.textRules.map((r) => (r && !isArr(r) && typeof r === 'object' ? [r.kw, r.to] : r));
        for (const g of c && isArr(c.groups) ? c.groups : []) if (g && isArr(g.wcRanges)) g.wcRanges = g.wcRanges.map((r) => (r && !isArr(r) && typeof r === 'object' ? [r.a, r.b] : r));
    }
    return o;
}

/** 保存する文書の大きさ(バイト)と、1文書の上限(1MB)に対する割合 */
export function storedSize(reg) {
    const bytes = approxBytes(toStored(reg));
    return { bytes, limit: 1_048_576, ratio: bytes / 1_048_576 };
}

// ---- 端末の控え(同じ日は読みに行かない) ----
const lsCache = {
    get() { try { const v = typeof localStorage !== 'undefined' && localStorage.getItem(CACHE_KEY); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* 覚えられなくても動く */ } },
};
const dayOf = (now) => { const d = new Date(now); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** 登録を読む: その日に読んでいれば控えを使う(読み取り0)・無ければ settings/sap_sort を1回だけ読む(1文書=読み取り1)。
 *  文書が無い・読めない・壊れている・知らない版 → 今と同じ分け方(既定)で動き、理由を errors に返す。例外は投げない */
export async function loadSapSort({ provider, ns, now = Date.now(), cache = lsCache } = {}) {
    const day = dayOf(now);
    const fin = (stored, source, extra = []) => {
        const r = resolveSapSort(stored == null ? null : fromStored(stored));
        const cl = {};
        if (!r.usedDefault) for (const c of r.reg.commanders) if (c && c.labels) cl[c.key] = c.labels;
        return { reg: r.reg, usedDefault: r.usedDefault, errors: [...r.errors, ...extra], source, commanderLabels: cl, rev: r.reg.rev };
    };
    const hit = cache.get();
    if (hit && hit.day === day) return fin(hit.doc, 'cache');
    if (!provider || typeof provider.getOne !== 'function') return fin(null, 'none');
    try {
        const doc = await provider.getOne(ns, SAP_SORT_COL, SAP_SORT_ID);
        cache.set({ day, doc: doc || null });
        return fin(doc, doc ? 'server' : 'none');
    } catch (e) {
        // 読めなかった: 古い控えがあればそれ・無ければ既定。画面は落とさない
        return fin(hit ? hit.doc : null, hit ? 'cache' : 'error', [`登録を読めませんでした(${e && e.message ? e.message : e})。前の控えか今と同じ分け方で動きます`]);
    }
}

/** 登録を保存する(管理者だけ)。管理者でなければ読み書きの前に拒む。版(rev)が食い違えば「他の人が先に直しました」で拒む。
 *  成功したら { rev, bytes } を返し、端末の控えも新しくする。baseRev=画面が読んだ時の rev(文書が無い時は既定の rev) */
export async function saveSapSort({ provider, ns, reg, baseRev, user, now = Date.now(), cache = lsCache } = {}) {
    if (!isSapSortAdmin(user && user.name)) throw new SapSortError('not-admin', '仕分けを変えられるのは管理者の人だけです。ヘッダー左上で「管理者」を選んでください。');
    if (!provider || typeof provider.getOne !== 'function' || typeof provider.save !== 'function') throw new SapSortError('no-provider', '保存の窓口がありません');
    const v = validateSapSort(reg);
    if (!v.ok) throw new SapSortError('invalid', `登録に間違いがあるので保存しません: ${v.errors.join(' / ')}`, v.errors);
    const cur = await provider.getOne(ns, SAP_SORT_COL, SAP_SORT_ID);
    const curRev = cur && Number.isFinite(cur.rev) ? cur.rev : null;
    const expect = curRev == null ? DEFAULT_SAP_SORT.rev : curRev;
    if (Number(baseRev) !== expect) throw new SapSortError('stale', `他の人が先に直しました(今の版 ${expect}・この画面は ${baseRev})。開き直してからやり直してください。`);
    const rev = expect + 1;
    const doc = { ...toStored(reg), rev, updatedAt: new Date(now).toISOString(), updatedBy: String(user.name) };
    const size = approxBytes(doc);
    if (size > SAFE_BYTES) throw new SapSortError('too-big', `登録が大きすぎます(${Math.round(size / 1024)}KB)。1文書の上限(1MB)の手前の ${Math.round(SAFE_BYTES / 1024)}KB までです。`);
    await provider.save(ns, SAP_SORT_COL, SAP_SORT_ID, doc, { merge: false });   // 丸ごと置き換える(入れ子の古い項目を残さない)
    cache.set({ day: dayOf(now), doc });
    refreshOnce(reg, rev);   // 画面を開き直した時(applySapSortOnce)に、保存前の古い登録を返さない
    return { rev, bytes: size };
}

// ---- 画面を開いた時に1回だけ(プロセスの中でも1回) ----
let onceP = null;
/** 登録を1回だけ読んで 今使う登録にする。loader(返す物は loadSapSort と同じ形)が無い・失敗しても既定のまま。戻り: { commanderLabels, ...読み込み結果 } */
export function applySapSortOnce({ loader } = {}) {
    if (!onceP) {
        onceP = (async () => {
            try {
                const r = typeof loader === 'function' ? await loader() : null;
                if (r && r.reg && !r.usedDefault) setActiveSapSort(r.reg);
                return r || { reg: DEFAULT_SAP_SORT, usedDefault: true, errors: [], source: 'none', commanderLabels: {} };
            } catch (e) { return { reg: DEFAULT_SAP_SORT, usedDefault: true, errors: [String(e && e.message || e)], source: 'error', commanderLabels: {} }; }
        })();
    }
    return onceP;
}
export const _resetOnceForTest = () => { onceP = null; };
/** 保存した登録を「1回だけ読んだ結果」にも入れる(開いてある画面を閉じて開き直しても 新しい版が出る)。まだ1回も読んでいなければ何もしない */
function refreshOnce(reg, rev) {
    if (!onceP) return;
    const cl = {};
    for (const c of reg.commanders) if (c && c.labels) cl[c.key] = c.labels;
    onceP = Promise.resolve({ reg: { ...reg, rev }, usedDefault: false, errors: [], source: 'saved', commanderLabels: cl, rev });
}

// ---- 未分類・重なりの数え方 ----
/** 仕分ける行 [{ text, code, n? }] を数える。数えるグループは1つだけ(重ね入れの shared は別に数え、足し合わせない)。
 *  未分類 = どの決まりにも当たらず 付帯作業へ落ちた物(本物の付帯作業とは区別する)。既定の登録では 今まで通り付帯作業の中に入ったままで、数え方だけ別に出す */
export function summarizeSort(rows, reg = DEFAULT_SAP_SORT) {
    const byGroup = {}, alsoIn = {}, un = new Map();
    let total = 0, unclassified = 0;
    for (const r of rows || []) {
        const n = Number.isFinite(r && r.n) ? r.n : 1;
        const { out, via } = classifyCore(r && r.text, r && r.code, reg);
        total += n;
        byGroup[out.group] = (byGroup[out.group] || 0) + n;
        for (const g of groupsOfWc(r && r.code, reg)) if (g.shared) alsoIn[g.group] = (alsoIn[g.group] || 0) + n;
        if (via === 'none') {
            unclassified += n;
            const k = String((r && r.code) ?? '').trim() || '(作業区なし)';
            const e = un.get(k) || { wc: k, n: 0, sample: String((r && r.text) || '').slice(0, 40) };
            e.n += n; un.set(k, e);
        }
    }
    return { total, byGroup, alsoIn, unclassified: { n: unclassified, byWc: [...un.values()].sort((a, b) => b.n - a.n || (a.wc < b.wc ? -1 : 1)) }, overlaps: overlapMarks(reg) };
}
