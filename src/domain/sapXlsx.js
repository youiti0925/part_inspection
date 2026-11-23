// 📥 SAP 工程表 xlsx を行の配列にする(端末の中だけ・送信なし・新しい依存なし=既存の jszip を使う)。
// 目的: 「合成」シート(インライン文字列)を { A:'…', H:46402, … } の行にする。
// 入力: ArrayBuffer/Uint8Array/Buffer(xlsx)  出力: Promise<{ rows: object[] }>  (1行目は見出しで除く)
// 触る外の物: なし(ネットワーク・Firebase・保存に一切触れない)
import JSZip from 'jszip';

const ent = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => {
    if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'amp') return '&';
    if (g === 'quot') return '"'; if (g === 'apos') return "'";
    return String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
});

/** sheet XML(文字列)→ 行配列。共有文字列があれば sst で解決。 */
export function parseSheetXml(xml, sst = []) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
        const obj = {};
        const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cellRe.exec(rm[1]))) {
            const attrs = cm[1], body = cm[2] || '';
            const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
            if (!ref) continue;
            const type = (/\bt="(\w+)"/.exec(attrs) || [])[1] || 'n';
            let val = null;
            if (type === 'inlineStr') {
                const ts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => ent(m[1]));
                val = ts.length ? ts.join('') : null;
            } else {
                const v = /<v>([\s\S]*?)<\/v>/.exec(body);
                if (v) {
                    if (type === 's') val = sst[Number(v[1])] ?? null;
                    else if (type === 'n') val = Number(v[1]);
                    else val = ent(v[1]);
                }
            }
            if (val !== null && val !== '') obj[ref[1]] = val;
        }
        rows.push(obj);
    }
    return rows;
}

// ── 1 枚目の見出しの検査(説明のシートなどを「指図 19 件」と成功扱いにしない) ──
// 期待する列 = この取込(sapProgress.js の toStage)が実際に読む列だけ。変換スクリプト(scripts/sap_narrow_for_app.py の OUT_HEAD)の
// 見出し・SAP の元の見出し(「作業 Text (短)」「標準値 1」)の両方が通るよう、空白と末尾の(…)を無視して名前の頭で見る。
// 値が数でも文字でも同じ: 見出しの文字だけを見る。
const normHead = (v) => String(v == null ? '' : v).replace(/[\s　]+/g, '').replace(/[(（][^)）]*[)）]$/, '').toLowerCase();
export const SAP_HEAD_SPEC = [
    ['A', '指図', /^指図/], ['B', '活動', /^活動/], ['C', '作業区', /^作業区/], ['D', '作業 Text', /^作業text/], ['F', '作業数量', /^作業数量/],
    ['H', '実績実行開始日', /^実績.*開始/], ['I', '実績実行終了日', /^実績.*終了/],
    ['J', '標準値 1', /^標準値1/], ['L', '標準値 2', /^標準値2/], ['N', '標準値 3', /^標準値3/],
    ['R', '最早実行開始日', /^(最早|計画).*開始/], ['S', '最早実行終了日', /^(最早|計画).*終了/],
    ['U', '品目', /^品目$/], ['V', '品目 Text', /^品目text/],
];
/** 見出しの行({A:'…'}) → { ok, problems:[{col, expect, got}] } */
export function checkSapHeader(head) {
    const h = head || {};
    const problems = [];
    for (const [col, expect, re] of SAP_HEAD_SPEC) if (!re.test(normHead(h[col]))) problems.push({ col, expect, got: h[col] == null ? '' : String(h[col]) });
    return { ok: problems.length === 0, problems };
}
/** 平易な日本語の理由(画面に出す) */
export function sapHeaderMessage(problems) {
    const first = problems.slice(0, 3).map((p) => `${p.col} 列は「${p.expect}」のはずが ${p.got ? `「${p.got.length > 20 ? p.got.slice(0, 20) + '…' : p.got}」` : '空'}`).join('、');
    return `1 枚目のシートの見出しが 期待と違います(${first}${problems.length > 3 ? ` ほか ${problems.length - 3} 列` : ''})。`
        + 'SAP の工程表(1 枚目の A〜V 列が 指図・活動・作業区 …の表)を選んでください。操業データ(13 枚のファイル)は そのままでは読めません: scripts/sap_narrow_for_app.py で 1 枚にした物を選んでください。';
}
const BASE_LABEL = /^基準日/;   // 変換スクリプトが X 列に足す「基準日」(Excel の日付の数)。無ければ今日のまま
const serialIso = (n) => (typeof n === 'number' && isFinite(n) && n >= 1 ? new Date(Date.UTC(1899, 11, 30) + Math.floor(n + 1e-9) * 86400000).toISOString().slice(0, 10) : null);

export async function readSapXlsx(data) {
    const zip = await JSZip.loadAsync(data);
    let sst = [];
    const sstFile = zip.file('xl/sharedStrings.xml');
    if (sstFile) {
        const x = await sstFile.async('string');
        sst = [...x.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
            [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => ent(t[1])).join(''));
    }
    const sheetName = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    if (!sheetName) throw new Error('シートが見つかりません');
    const all = parseSheetXml(await zip.file(sheetName).async('string'), sst);
    const chk = checkSapHeader(all[0]);
    if (!chk.ok) throw new Error(sapHeaderMessage(chk.problems));
    const rows = all.slice(1);
    if (!rows.length) throw new Error('1 枚目のシートに 見出しの下の行が 1 行もありません。');
    // 基準日: 見出しの行に「基準日」の列があり 次の行にその日付(数)がある時だけ
    let baseDate = null;
    const bc = Object.keys(all[0]).find((k) => BASE_LABEL.test(normHead(all[0][k])));
    if (bc) baseDate = serialIso(rows[0][bc]);
    return { rows, baseDate };
}
