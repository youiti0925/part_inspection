"""最小の xlsx 書き・読み(標準ライブラリだけ・新しい依存なし)。合成 Excel の道具と比べる検査が使う。
目的: 合成 Excel を毎回同じバイト列で書く / 比べる検査が値の型(文字・数・日付)を読む。
入力: 書く時=シートの一覧[(名前, 行のリスト)]・読む時=xlsx のパス
出力: 書く時=xlsx ファイル / 読む時=[(シート名, 行のリスト)] (セルは None / ('str',s) / ('num',x) / ('date',x))
呼ぶ人: make_synth_xlsx.py・compare_headers.py・selftest_synth.py
触る外の物: 渡されたパスのファイルだけ(ネットワーク無し)
確かめ方: python -I scripts/sap_synth/selftest_synth.py
"""
import re
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


class XDate(float):
    """Excel の日付の数(整数=日だけ・小数=時刻つき)"""


def col_letter(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref, v):
    if v is None or v == '':
        return ''
    if isinstance(v, XDate):
        st = 1 if float(v) == int(v) else 2
        return '<c r="%s" s="%d"><v>%s</v></c>' % (ref, st, repr(int(v)) if st == 1 else repr(float(v)))
    if isinstance(v, bool):
        raise ValueError('bool は使わない')
    if isinstance(v, int):
        return '<c r="%s"><v>%d</v></c>' % (ref, v)
    if isinstance(v, float):
        return '<c r="%s"><v>%s</v></c>' % (ref, repr(int(v)) if v == int(v) else repr(v))
    return '<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, escape(str(v)))


_STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
           '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>'
           '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
           '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
           '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
           '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
           '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
           '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
           '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
           '</styleSheet>')
_HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def write_xlsx(path, sheets):
    ct = [_HDR, '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>',
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
    wb = [_HDR, '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
    rels = [_HDR, '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for i, (name, _) in enumerate(sheets, 1):
        ct.append('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i)
        wb.append('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(name), i, i))
        rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, i))
    n = len(sheets)
    rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' % (n + 1))
    ct.append('</Types>')
    wb.append('</sheets></workbook>')

    def put(z, name, data):
        zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))   # 毎回同じバイト列にする
        zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, data if isinstance(data, bytes) else data.encode('utf-8'))

    with zipfile.ZipFile(path, 'w') as z:
        put(z, '[Content_Types].xml', ''.join(ct))
        put(z, '_rels/.rels', _HDR + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        put(z, 'xl/workbook.xml', ''.join(wb))
        put(z, 'xl/_rels/workbook.xml.rels', ''.join(rels))
        put(z, 'xl/styles.xml', _STYLES)
        for i, (_, rows) in enumerate(sheets, 1):
            parts = [_HDR, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
            for ri, r in enumerate(rows, 1):
                parts.append('<row r="%d">%s</row>' % (ri, ''.join(_cell('%s%d' % (col_letter(ci), ri), v) for ci, v in enumerate(r))))
            parts.append('</sheetData></worksheet>')
            put(z, 'xl/worksheets/sheet%d.xml' % i, ''.join(parts))


def _is_date_fmt(fid, code):
    if fid in (14, 15, 16, 17, 22, 45, 46, 47):
        return True
    if code is None:
        return False
    c = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', '', code).lower()
    return bool(re.search(r'[ymdh]', c)) and 'general' not in c


def read_xlsx(path):
    """[(シート名, 行のリスト)]。セル: None / ('str',文字) / ('num',数) / ('date',数)"""
    z = zipfile.ZipFile(path)
    sst = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS + 'si'):
            sst.append(''.join(t.text or '' for t in si.iter(NS + 't')))
    date_xf = set()
    if 'xl/styles.xml' in z.namelist():
        st = ET.fromstring(z.read('xl/styles.xml'))
        codes = {int(n.get('numFmtId')): n.get('formatCode') for n in st.iter(NS + 'numFmt')}
        cx = st.find(NS + 'cellXfs')
        if cx is not None:
            for i, xf in enumerate(cx.findall(NS + 'xf')):
                fid = int(xf.get('numFmtId', '0'))
                if _is_date_fmt(fid, codes.get(fid)):
                    date_xf.add(i)
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    out = []
    for s in wb.iter(NS + 'sheet'):
        t = rels[s.get(RNS + 'id')]
        p = t.lstrip('/') if t.startswith('/') else 'xl/' + t
        rows = []
        for _, el in ET.iterparse(z.open(p)):
            if el.tag != NS + 'row':
                continue
            row = []
            for c in el.findall(NS + 'c'):
                ci = 0
                for ch in re.match(r'[A-Z]+', c.get('r')).group():
                    ci = ci * 26 + ord(ch) - 64
                ci -= 1
                while len(row) <= ci:
                    row.append(None)
                ty = c.get('t')
                if ty == 'inlineStr':
                    v = ('str', ''.join(x.text or '' for x in c.iter(NS + 't')))
                else:
                    ve = c.find(NS + 'v')
                    if ve is None or ve.text is None:
                        v = None
                    elif ty == 's':
                        v = ('str', sst[int(ve.text)])
                    elif ty == 'str':
                        v = ('str', ve.text)
                    else:
                        v = ('date' if int(c.get('s', '0')) in date_xf else 'num', float(ve.text))
                row[ci] = v
            rows.append(row)
            el.clear()
        out.append((s.get('name'), rows))
    return out
