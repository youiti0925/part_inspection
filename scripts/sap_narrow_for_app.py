#!/usr/bin/env python3
"""SAP 操業データ(RPA が出す 13 枚の xlsx)→ 部品検査アプリの SAP 取込(sapXlsx.js)が読める 1 枚の xlsx に絞る。最小版。

目的: アプリの取込は「1 枚目のシート・列 A〜V」を読む(sapXlsx.js)。操業データは 1 枚目が「説明」・工程は 10 枚目の
      「SAP_作業」・U 品目/V 品目テキストの列が無い。ここで 1 枚目に置き直し、U/V を SAP_製造指図 から指図で引いて足す。
入力: 操業データ_*.xlsx(標準ライブラリだけで読む・新しい依存なし)
出力: 1 枚だけの xlsx(列 A〜V・日付は Excel の数のまま・文字は inlineStr)
      絞り込み(既定 --mode open): 終わっていない指図は全部(検査が未完了でなくてもよい)。外すのは終わった指図と全工程済の指図だけ。
        🚨 orders は「いつ来るか(到着予想)」用 / 機械グループには open を使う。orders は検査が未完了の指図だけなので、機械グループの負荷が過小になる(見本で 356 指図 / open は 3159 指図)。
        --mode orders       : 未完了の検査工程(作業区 2509)を持つ指図の全工程だけ残す(到着予想用・小さい)。終わった指図(TECO 等)は外す
        --mode inspect-only : 未完了の検査工程の行だけ(前の工程が無いので「いつ来るか」は出せない・比べる用)
        --mode all          : 全指図(重さの比べ用)
      基準日: 元の 説明 シートの「今日（計算の基準日）」が読めた時は、出力の X 列(X1=基準日・X2=Excel の日付の数)に入れる。アプリの基準日の既定がそれに合う。読めなければ X 列は付けない(アプリは今日のまま)
      出力に含めない: 客先・仕入先・金額・購買発注・在庫・組立指図の部品(= 元の 13 枚のうち SAP_作業 と SAP_製造指図の 4 列だけ使う)
触る外の物: 入力の読み取りと出力ファイルの書き込みだけ(ネットワーク・Firebase に触れない)
確かめ方: python -I scripts/sap_narrow_for_app.py 入力.xlsx 出力.xlsx  → 件数が標準出力に出る
"""
import argparse
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
DONE_TOKENS = {'TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD'}   # RPA keshikomi_shortage.py と同じ(終わった・消された指図)
OUT_HEAD = ['指図', '活動', '作業区', '作業 Text', '能力カテゴリ', '作業数量', '作業単位', '実績実行開始日', '実績実行終了日',
            '標準値1', '単位', '標準値2', '単位', '標準値3', '単位', '標準値4', '単位', '最早実行開始日', '最早実行終了日', '', '品目', '品目 Text']
COLS = [chr(65 + i) for i in range(24)]   # A..X(W は空・X=基準日)


def sheet_path_by_name(z, name):
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rid = None
    for s in wb.iter(NS + 'sheet'):
        if s.get('name') == name:
            rid = s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
    if rid is None:
        raise SystemExit('シートが見つかりません: ' + name)
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    for r in rels:
        if r.get('Id') == rid:
            t = r.get('Target')
            return t.lstrip('/') if t.startswith('/') else 'xl/' + t
    raise SystemExit('シートの場所が分かりません: ' + name)


def read_sst(z):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    out = []
    for _, el in ET.iterparse(z.open('xl/sharedStrings.xml')):
        if el.tag == NS + 'si':
            out.append(''.join(t.text or '' for t in el.iter(NS + 't')))
            el.clear()
    return out


def iter_rows(z, path, sst):
    """行ごとに { 列の字: 値 } を出す(文字は str・数は float・空は入れない)"""
    with z.open(path) as f:
        for _, el in ET.iterparse(f):
            if el.tag != NS + 'row':
                continue
            row = {}
            for c in el.findall(NS + 'c'):
                col = re.match(r'[A-Z]+', c.get('r')).group()
                t = c.get('t')
                if t == 'inlineStr':
                    v = ''.join(x.text or '' for x in c.iter(NS + 't'))
                else:
                    ve = c.find(NS + 'v')
                    v = ve.text if ve is not None else None
                    if v is not None:
                        if t == 's':
                            v = sst[int(v)]
                        elif t in (None, 'n'):
                            v = float(v)
                if v is not None and v != '':
                    row[col] = v
            yield row
            el.clear()


def cell_xml(ref, v):
    if isinstance(v, float):
        return '<c r="%s"><v>%s</v></c>' % (ref, repr(int(v)) if v == int(v) else repr(v))
    return '<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, escape(str(v)))


def write_xlsx(path, rows):
    """rows: 行(最大 24 個の値のリスト・None は空)。先頭は見出し"""
    def sheet_iter():
        yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        for i, r in enumerate(rows, 1):
            yield '<row r="%d">%s</row>' % (i, ''.join(cell_xml('%s%d' % (COLS[j], i), v) for j, v in enumerate(r) if v is not None and v != ''))
        yield '</sheetData></worksheet>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="SAP_作業" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', ''.join(sheet_iter()).encode('utf-8'))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--mode', choices=['orders', 'open', 'inspect-only', 'all'], default='open', help='既定 open=機械グループ用(終わっていない指図は全部)。orders=いつ来るか(到着予想)用・機械グループは過小')
    ap.add_argument('--inspect-wc', default='2509', help='検査の作業区(カンマ区切り・既定 2509=アプリの「検査」)')
    a = ap.parse_args(argv)
    inspect_wc = set(a.inspect_wc.split(','))

    z = zipfile.ZipFile(a.src)
    sst = read_sst(z)

    # ① SAP_製造指図: 指図 → (品目, 品目Text, 終わりの記号があるか)
    head = {}
    it = iter_rows(z, sheet_path_by_name(z, 'SAP_製造指図'), sst)
    h = next(it)
    col = {v: k for k, v in h.items()}
    need = ['指図', '品目', 'システム Status', '品目 Text']
    miss = [n for n in need if n not in col]
    if miss:
        raise SystemExit('SAP_製造指図 に見出しが無い: ' + ','.join(miss))
    for r in it:
        o = str(r.get(col['指図'], '')).strip()
        if not o:
            continue
        st = set(str(r.get(col['システム Status'], '')).split())
        head[o] = (str(r.get(col['品目'], '')), str(r.get(col['品目 Text'], '')), bool(st & DONE_TOKENS))

    # ①' 基準日(説明 シートの「今日（計算の基準日）」・読めなければ None)
    base_serial = None
    try:
        for r in iter_rows(z, sheet_path_by_name(z, '説明'), sst):
            if '基準日' in str(r.get('A', '')) and isinstance(r.get('B'), float):
                base_serial = r['B']
                break
    except SystemExit:
        pass

    # ② SAP_作業: 列 A〜S の位置は 見出しの名前で引く(位置に頼らない)
    it = iter_rows(z, sheet_path_by_name(z, 'SAP_作業'), sst)
    h = next(it)
    byname = {}
    for k, v in h.items():
        byname.setdefault(re.sub(r'\s*\(.*\)$', '', v).strip(), []).append(k)   # '作業数量 (MEINH)' → '作業数量'
    want = ['指図', '活動', '作業区', '作業 Text (短)', '能力カテゴリ', '作業数量', '作業単位', '実績実行開始日', '実績実行終了日',
            '標準値 1', '標準値単位', '標準値 2', '標準値単位', '標準値 3', '標準値単位', '標準値 4', '標準値単位', '最早実行開始日', '最早実行終了日']
    # 見出しの名前 → 列。「標準値単位」は 4 回出るので 出てくる順に割り当てる
    seq = {}
    src_cols = []
    for w in want:
        base = re.sub(r'\s*\(.*\)$', '', w).strip()
        cand = byname.get(base) or byname.get(w) or []
        n = seq.get(base, 0)
        seq[base] = n + 1
        if n >= len(cand):
            raise SystemExit('SAP_作業 に見出しが無い: ' + w)
        src_cols.append(cand[n])
    rows_by_order = {}
    total_rows = 0
    for r in it:
        total_rows += 1
        o = str(r.get(src_cols[0], '')).strip()
        if not o:
            continue
        vals = [r.get(c) for c in src_cols]
        vals[0] = o
        if vals[1] is not None:
            vals[1] = str(vals[1]).strip()
        if vals[2] is not None:
            vals[2] = str(vals[2]).strip()
        rows_by_order.setdefault(o, []).append(vals)

    # ③ 絞る
    stats = {'作業の行(元)': total_rows, '指図(元)': len(rows_by_order), '終わった指図で外した': 0, '検査未完了なしで外した': 0, '製造指図に無い指図': 0}
    out = [OUT_HEAD]
    kept_orders = 0
    for o, rs in rows_by_order.items():
        info = head.get(o)
        if info is None:
            stats['製造指図に無い指図'] += 1
        item, text, done = info if info else ('', '', False)
        if a.mode != 'all':
            if done:
                stats['終わった指図で外した'] += 1
                continue
            open_insp = [r for r in rs if r[2] in inspect_wc and r[8] is None]   # 実績終了日が無い = 未完了
            if a.mode == 'open':
                if all(r[8] is not None for r in rs):
                    stats['全工程済で外した'] = stats.get('全工程済で外した', 0) + 1
                    continue
            elif not open_insp:
                stats['検査未完了なしで外した'] += 1
                continue
            if a.mode == 'inspect-only':
                rs = open_insp
        kept_orders += 1
        for r in sorted(rs, key=lambda x: x[1] or ''):
            out.append(r + [None, item or None, text or None])   # r は A..S(19) → T は空・U=品目・V=品目 Text
    if base_serial is not None:
        out[0] = out[0] + [None, '基準日']          # W は空・X1=基準日
        for i in range(1, len(out)):
            out[i] = out[i] + [None, base_serial if i == 1 else None]   # X2=Excel の日付の数
    write_xlsx(a.dst, out)
    stats['出力の指図'] = kept_orders
    stats['出力の行'] = len(out) - 1
    stats['基準日(Excelの数・無ければ0)'] = int(base_serial or 0)
    for k, v in stats.items():
        print('%s: %d' % (k, v))
    return 0


if __name__ == '__main__':
    sys.exit(main())
