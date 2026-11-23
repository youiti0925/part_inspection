// SAP 取込の 1 枚目の見出しの検査(説明のシートを「指図 19 件」と成功扱いにしない)・基準日の読み方
// 確かめ方: node --test src/domain/__tests__/sapXlsxHeader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { readSapXlsx, checkSapHeader, SAP_HEAD_SPEC } from '../sapXlsx.js';

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// 変換スクリプト(sap_narrow_for_app.py)の出力の見出しを、スクリプトの文面から取る(写しを持たない)
const script = readFileSync(new URL('../../../scripts/sap_narrow_for_app.py', import.meta.url), 'utf8');
const OUT_HEAD = [...script.slice(script.indexOf('OUT_HEAD = ['), script.indexOf(']', script.indexOf('OUT_HEAD = [')) + 1).matchAll(/'([^']*)'/g)].map((m) => m[1]);
// SAP の元の見出しの書き方(括弧つき・「標準値 1」・標準値単位)
const SAP_RAW = ['指図', '活動', '作業区', '作業 Text (短)', '能力カテゴリ', '作業数量 (MEINH)', '作業単位', '実績実行開始日', '実績実行終了日', '標準値 1', '標準値単位', '標準値 2', '標準値単位', '標準値 3', '標準値単位', '標準値 4', '標準値単位', '最早実行開始日', '最早実行終了日', '', '品目', '品目 Text'];

const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`);
async function xlsx(rows) {
    const z = new JSZip();
    z.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v == null || v === '' ? '' : cell(COLS[j] + (i + 1), v))).join('')}</row>`).join('')}</sheetData></worksheet>`);
    return z.generateAsync({ type: 'uint8array' });
}
const headRow = (names) => Object.fromEntries(names.map((n, i) => [COLS[i], n]).filter(([, n]) => n));
const dataRow = ['1001', '0010', '2509', '検査', null, 1, null, 46300, 46301, 1, null, 2, null, 0, null, 0, null, 46310, 46311, null, 'X1', '部品'];

test('XH1 見出しの期待は 取込が実際に読む列(sapProgress.js の toStage が使う列)と同じ', () => {
    const src = readFileSync(new URL('../sapProgress.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function toStage'), src.indexOf('export function', src.indexOf('export function toStage') + 10));
    const used = new Set([...body.matchAll(/\br\.([A-Z])\b/g)].map((m) => m[1]));
    for (const c of used) assert.ok(SAP_HEAD_SPEC.some(([col]) => col === c), `toStage が読む ${c} 列が 見出しの検査に無い`);
});

test('XH2 変換スクリプトの出力の見出し・SAP の元の見出しの書き方 の両方が通る', () => {
    assert.equal(OUT_HEAD.length, 22);
    assert.deepEqual(checkSapHeader(headRow(OUT_HEAD)), { ok: true, problems: [] });
    assert.equal(checkSapHeader(headRow(SAP_RAW)).ok, true);
});

test('XH3 説明のシート(操業データの 1 枚目)は 取り込まず 平易な理由を出す(指図 19 件と成功扱いにしない・外すと赤)', async () => {
    const buf = await xlsx([['作成', '2026/11/23 22:35'], ['今日（計算の基準日）', 46348], ['このファイル', '組立指図ごとの遅れ'], [], ['組立指図', '1 行＝1 組立指図']]);
    await assert.rejects(() => readSapXlsx(buf), (e) => /見出しが 期待と違います/.test(e.message) && /A 列は「指図」/.test(e.message) && /sap_narrow_for_app/.test(e.message));
});

test('XH4 見出しの 1 列だけ違う(標準値 2 が無い)物も止める・どの列かを言う', async () => {
    const bad = OUT_HEAD.slice(); bad[11] = '機械時間';
    const buf = await xlsx([bad, dataRow]);
    await assert.rejects(() => readSapXlsx(buf), (e) => /L 列は「標準値 2」のはずが 「機械時間」/.test(e.message));
});

test('XH5 見出しだけで行が無い物も止める', async () => {
    await assert.rejects(async () => readSapXlsx(await xlsx([OUT_HEAD])), /1 行もありません/);
});

test('XH6 正しい物は読める・基準日の列があればその日付(無ければ null=今日のまま)', async () => {
    const ok = await readSapXlsx(await xlsx([OUT_HEAD, dataRow]));
    assert.equal(ok.rows.length, 1); assert.equal(ok.baseDate, null);
    const withBase = await readSapXlsx(await xlsx([[...OUT_HEAD, null, '基準日'], [...dataRow, null, 46348]]));
    assert.equal(withBase.rows.length, 1); assert.equal(withBase.baseDate, '2026-11-22');   // 46348 = 2026-11-22(Excel の数)
    const junk = await readSapXlsx(await xlsx([[...OUT_HEAD, null, '基準日'], [...dataRow, null, 'abc']]));
    assert.equal(junk.baseDate, null);
});

test('XH7 SAP の元の見出し(括弧つき)でも読める', async () => {
    const r = await readSapXlsx(await xlsx([SAP_RAW, dataRow]));
    assert.equal(r.rows.length, 1);
});

test('XH8 共有文字列(sharedStrings)で書かれた xlsx も読める(Excel で保存し直した物)・正規表現を壊していない', async () => {
    const z = new JSZip();
    const strs = [...OUT_HEAD, 'X1', '部品'];
    const idx = (s) => strs.indexOf(s);
    z.file('xl/sharedStrings.xml', `<sst>${strs.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`);
    const head = OUT_HEAD.map((h, j) => (h ? `<c r="${COLS[j]}1" t="s"><v>${idx(h)}</v></c>` : '')).join('');
    z.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${head}</row><row r="2"><c r="A2" t="s"><v>${idx('X1')}</v></c><c r="B2"><v>10</v></c><c r="C2"><v>2509</v></c></row></sheetData></worksheet>`);
    const r = await readSapXlsx(await z.generateAsync({ type: 'uint8array' }));
    assert.equal(r.rows.length, 1); assert.equal(r.rows[0].A, 'X1'); assert.equal(r.rows[0].C, 2509);
});
