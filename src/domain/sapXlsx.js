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

export async function readSapXlsx(data) {
    const zip = await JSZip.loadAsync(data);
    let sst = [];
    const sstFile = zip.file('xl/sharedStrings.xml');
    if (sstFile) {
        const x = await sstFile.async('string');
        sst = [...x.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
            [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => ent(t[1])).join(''));
    }
    const sheetName = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    if (!sheetName) throw new Error('シートが見つかりません');
    const rows = parseSheetXml(await zip.file(sheetName).async('string'), sst);
    return { rows: rows.slice(1) };
}
