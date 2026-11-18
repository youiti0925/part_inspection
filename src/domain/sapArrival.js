// 🔗 SAP の「部品検査に届く見込み」を 部品検査アプリの操業シミュレーションの「これから届く」(到着の見込み)へ渡す
// 目的: SAP の指図(品目コード・品目テキスト・指図番号)と 部品検査アプリのロット(lot.model=品目コード・lot.modelText=品名・lot.orderNo=指図番号)を当て、
//       当たったロットの到着予定(lot.entryAt)を SAP から見込んだ日時に差し替えた「写し」を作る(元のロットには書かない)。
// 渡す口: 既存の到着の型そのまま = 未入荷置き場(lot.location==='arrival')のロットの lot.entryAt(ms)。
//         normalizeInput がこれを「到着予定(SCHEDULED)」として読み、その時刻から着手できる=検査の山・遅れ・こなせるかに効く。
// 決まり: ・勝手に当てない=当てるのは ①指図番号が同じ ②品目コードが同じで候補が1対1 ③品目テキストが同じで1対1 だけ。
//           複数の候補があるものは「あいまい」・どれにも当たらないものは「対応なし」として返す(適用しない)。
//         ・もう手元にあるロット(location が arrival 以外)・SAP の予定日が過ぎているもの・SAP でも検査を始めているものは 差し替えない(理由つきで返す)。
//         ・元のロットは書き換えない(浅い写し)。Firestore・時計に触れない。
// 入力: sapRows(inspectForecast の rows に startMs を足した物)・lots
// 出力: matchSapToLots / applySapArrivals
// 確かめ方: node --test src/domain/__tests__/sapArrival.test.mjs

const DAY_START = '08:30';
const str = (v) => (v == null ? '' : String(v));

/** 品目コードの比べ方: 全角→半角・大文字・空白と各種ハイフンを揃える */
export function normCode(v) {
    return str(v).normalize('NFKC').toUpperCase().replace(/[\s　]+/g, '').replace(/[‐-―−ー]/g, '-');
}
const SMALL = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ', っ: 'つ', ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ッ: 'ツ' };
/** 品目テキストの比べ方: 半角カナ→全角・小さい仮名を大きく・長音とハイフンを揃える・空白を除く */
export function normText(v) {
    return str(v).normalize('NFKC').replace(/[ぁ-ゖァ-ヶ]/g, (c) => SMALL[c] || c).replace(/[\s　]+/g, '').replace(/[‐-―−ー]/g, '-').toUpperCase();
}

/** 'YYYY-MM-DD' と 'HH:MM'(無ければ始業 08:30)→ ms */
export function msOfIso(iso, time) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number); const [h, mi] = (time || DAY_START).split(':').map(Number);
    return new Date(y, m - 1, d, h, mi).getTime();
}

/** inspectForecast の rows に 到着の ms を足す(検査の開始見込み=その検査に物が届く時刻) */
export function sapRowsWithMs(rows) {
    return (rows || []).filter((r) => r && r.order).map((r) => ({ ...r, startMs: msOfIso(r.startIso, r.startTime) }));
}

const isOpenLot = (l) => l && l.status !== 'completed' && l.location !== 'completed';

/**
 * SAP の行と ロットを当てる。
 * @returns {{ matches: Array<{ lotId, row, by }>, ambiguous: Array<{ row, reason, lotIds }>, unmatched: Array<{ row, reason }> }}
 *   by = 'order'(指図番号が同じ) / 'item'(品目コードが1対1) / 'text'(品目テキストが1対1)
 */
export function matchSapToLots(sapRows, lots) {
    const L = (lots || []).filter(isOpenLot).map((l) => ({ id: str(l.id), order: normCode(l.orderNo), code: normCode(l.model), text: normText(l.modelText) }));
    const matches = [], ambiguous = [], unmatched = [];
    const claimed = new Set();
    const rest = [];
    // ① 指図番号が同じ(一番確か)
    for (const row of sapRows || []) {
        const o = normCode(row.order);
        const hit = o ? L.filter((l) => l.order === o) : [];
        if (hit.length === 1 && !claimed.has(hit[0].id)) { matches.push({ lotId: hit[0].id, row, by: 'order' }); claimed.add(hit[0].id); }
        else if (hit.length > 1) ambiguous.push({ row, reason: `同じ指図番号のロットが ${hit.length}件`, lotIds: hit.map((l) => l.id) });
        else rest.push(row);
    }
    // ② 品目コード ③ 品目テキスト: 当たった物を除いて 1対1 の時だけ
    const pass = (rows, keyOfRow, keyOfLot, by, label) => {
        const left = [];
        const sapCount = new Map(); rows.forEach((r) => { const k = keyOfRow(r); if (k) sapCount.set(k, (sapCount.get(k) || 0) + 1); });
        for (const row of rows) {
            const k = keyOfRow(row);
            const cand = k ? L.filter((l) => !claimed.has(l.id) && keyOfLot(l) === k) : [];
            if (cand.length === 1 && sapCount.get(k) === 1) { matches.push({ lotId: cand[0].id, row, by }); claimed.add(cand[0].id); }
            else if (cand.length > 0) ambiguous.push({ row, reason: `${label}が同じ候補が ロット ${cand.length}件・SAP ${sapCount.get(k)}件で 1対1 に決まらない`, lotIds: cand.map((l) => l.id) });
            else left.push(row);
        }
        return left;
    };
    const left2 = pass(rest, (r) => normCode(r.item), (l) => l.code, 'item', '品目コード');
    const left3 = pass(left2, (r) => normText(r.itemText), (l) => l.text, 'text', '品目テキスト');
    for (const row of left3) unmatched.push({ row, reason: '対応なし(指図番号・品目コード・品目テキストのどれも部品検査のロットに当たらない)' });
    return { matches, ambiguous, unmatched };
}

/**
 * 当たったロットの到着予定を SAP の見込みに差し替えた「写し」を作る。元のロットは書き換えない。
 * 差し替えるのは: 未入荷置き場(location==='arrival')・SAP の見込みが基準時刻以降・SAP でも検査を始めていない物だけ。
 * @param {Array} lots
 * @param {Array} sapRows sapRowsWithMs の結果
 * @param {{ nowMs:number }} opts nowMs = 基準時刻(SAP の基準日の始業)
 * @returns {{ lots, applied, skipped, match, key }}
 */
export function applySapArrivals(lots, sapRows, { nowMs } = {}) {
    const list = Array.isArray(lots) ? lots : [];
    const match = matchSapToLots(sapRows, list);
    const byLot = new Map(match.matches.map((m) => [m.lotId, m]));
    const applied = [], skipped = [];
    const out = list.map((l) => {
        const m = l && byLot.get(str(l.id));
        if (!m) return l;
        const r = m.row;
        const base = { lotId: str(l.id), orderNo: l.orderNo, model: l.model, row: r, by: m.by };
        if (l.location !== 'arrival') { skipped.push({ ...base, why: `もう手元にあるロット(場所=${str(l.location) || '不明'})なので到着は差し替えない` }); return l; }
        if (!Number.isFinite(r.startMs)) { skipped.push({ ...base, why: 'SAP に予定開始日が無い' }); return l; }
        if (r.startBasis === 'actual') { skipped.push({ ...base, why: 'SAP でも検査を始めている(実績)' }); return l; }
        if (Number.isFinite(nowMs) && r.startMs < nowMs) { skipped.push({ ...base, why: `SAP の見込み(${r.startIso})が基準日より前=手前の工程が未完了のまま予定日を過ぎている` }); return l; }
        applied.push({ ...base, atMs: r.startMs, prevEntryAt: Number.isFinite(Number(l.entryAt)) ? Number(l.entryAt) : null });
        return { ...l, entryAt: r.startMs, sapArrival: { order: r.order, by: m.by, startBasis: r.startBasis, startIso: r.startIso, prevEntryAt: l.entryAt ?? null } };
    });
    // 計算の鍵(entryAt は ロットの指紋に入っていないので、差し替えた内容を鍵にして 計算し直させる)
    const key = applied.length ? applied.map((a) => `${a.lotId}@${a.atMs}`).sort().join(',') : '';
    return { lots: applied.length ? out : list, applied, skipped, match, key };
}
