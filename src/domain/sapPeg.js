// 🔗 部品の指図 → 組立の指図 の当たり(ピッキング)と リミット
// 目的: 部品の指図(SAP)のリミット = 当てられた組立の指図の「出庫完了日(進捗管理表の U 列)」の 2 稼働日前。
//       部品と組立の指図を結ぶ表は無いので、実際の当て方(清水さん 11-18)をそのまま写す:
//         進捗管理表の順番どおりの(組立の)指図でピッキングリストを出す → そこで使う品目コードに在庫があれば それを使う
//         → 無い時は 手配されている(SAP の部品の)指図のうち その品目コードで 一番早い物が当てられる。
// 入力:
//   demands  = 組立の需要(進捗管理表の行の順): [{ order: 組立の指図, u: 出庫完了日 'YYYY-MM-DD'|null, items: [{ code: 品目コード, qty }] }]
//   stock    = 品目コードごとの在庫数: { [code]: 数 }
//   parts    = SAP の部品の指図: [{ order, item: 品目コード, qty, arriveIso: 検査に着く見込み|null, sapIso: SAP の予定|null }]
// 出力: { parts: [{ order, item, qty, status: 'peg'|'surplus', allocs:[{ asm, qty, u, limit }], asm, u, limit, ok }], unmet: [{ asm, code, short, u }], stockUsed }
//   ・ok = 部品が検査に着く見込み(無ければ SAP の予定)が リミット以内か(日付が無ければ null)
//   ・1 つの部品の指図が複数の需要にまたがる時は 一番早いリミットを その部品の limit にする(allocs に全部残す)
//   ・当てられなかった部品の指図は status='surplus'(需要なし=余り)・足りない需要は unmet
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapPeg.test.mjs
import { LIMIT_DAYS_BEFORE_SHIP } from './sapArrivalForecast.js';

export { LIMIT_DAYS_BEFORE_SHIP };
const DAY = 86400000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const norm = (c) => String(c == null ? '' : c).normalize('NFKC').trim().toUpperCase();
const dayNo = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
/** k 稼働日(月〜金)まえ。土日は数えない */
export function addWorkdays(iso, k) {
    let n = dayNo(iso); const step = k < 0 ? -1 : 1;
    for (let i = 0; i < Math.abs(k);) { n += step; const w = new Date(n * DAY).getUTCDay(); if (w !== 0 && w !== 6) i++; }
    return isoOf(n);
}

export function pegPartsToAssembly({ demands = [], stock = {}, parts = [], limitDays = LIMIT_DAYS_BEFORE_SHIP } = {}) {
    // 需要を 品目コードごとに 進捗管理表の順で並べる
    const byCode = new Map();
    demands.forEach((d, di) => (d.items || []).forEach((it) => {
        const code = norm(it.code), qty = num(it.qty);
        if (!code || !qty) return;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push({ asm: String(d.order), u: d.u || null, need: qty, di });
    }));
    const stockLeft = {}; for (const k of Object.keys(stock || {})) stockLeft[norm(k)] = num(stock[k]);
    const stockUsed = {};
    // 部品を 品目コードごとに「早い物」順(検査に着く見込みの早い順・日付が無い物は後ろ・同じなら SAP 予定・指図番号)
    const key = (p) => (p.arriveIso || p.sapIso ? 0 : 1);
    const when = (p) => p.arriveIso || p.sapIso || '9999-12-31';
    const partsBy = new Map();
    parts.forEach((p) => { const c = norm(p.item); if (!partsBy.has(c)) partsBy.set(c, []); partsBy.get(c).push({ ...p, left: num(p.qty), allocs: [] }); });
    const unmet = [];
    for (const [code, list] of byCode) {
        // ① 在庫で埋める(進捗管理表の順に)
        for (const d of list) { const use = Math.min(d.need, stockLeft[code] || 0); if (use > 0) { d.need -= use; stockLeft[code] -= use; stockUsed[code] = (stockUsed[code] || 0) + use; } }
        // ② 足りない分に 部品の指図を 早い順に(数量で分ける・1 指図が複数の需要にまたがる)
        const pool = (partsBy.get(code) || []).slice().sort((a, b) => key(a) - key(b) || (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0) || (a.sapIso || '9') .localeCompare(b.sapIso || '9') || String(a.order).localeCompare(String(b.order)));
        for (const d of list) {
            for (const p of pool) {
                if (d.need <= 0) break;
                if (p.left <= 0) continue;
                const q = Math.min(d.need, p.left);
                p.left -= q; d.need -= q;
                p.allocs.push({ asm: d.asm, qty: q, u: d.u, limit: d.u ? addWorkdays(d.u, -limitDays) : null });
            }
            if (d.need > 0) unmet.push({ asm: d.asm, code, short: d.need, u: d.u });
        }
    }
    const out = parts.map((p0) => {
        const c = norm(p0.item);
        const p = (partsBy.get(c) || []).find((x) => x.order === p0.order) || { allocs: [] };
        const allocs = p.allocs;
        const first = allocs.filter((a) => a.limit).sort((a, b) => (a.limit < b.limit ? -1 : 1))[0] || allocs[0] || null;
        const arrive = p0.arriveIso || p0.sapIso || null;
        const limit = first ? first.limit : null;
        return { order: p0.order, item: p0.item, qty: p0.qty, status: allocs.length ? 'peg' : 'surplus', allocs, asm: first ? first.asm : null, u: first ? first.u : null, limit, arrive,
            ok: limit && arrive ? arrive <= limit : null };
    });
    return { parts: out, unmet, stockUsed };
}

/** 部品の指図 → 出庫日(= 当てられた組立の指図の U)。arrivalForecast の shipByOrder にそのまま渡せる。余り(需要なし)は入れない */
export function shipByPartOrder(peg) {
    const m = {};
    for (const p of peg.parts) if (p.status === 'peg' && p.u) m[p.order] = p.u;
    return m;
}
