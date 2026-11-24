#!/usr/bin/env python3
"""合成 Excel(または同じ形の xlsx)の シート名・見出し・値の型 が headers_spec.json(見本の見出し一覧)と差 0 か機械で比べる。
目的: 「見本と同じ形」を人の目でなく機械で言えるようにする(段1の完了条件)。値の中身は見ない・型だけ。
入力: xlsx のパス(--spec で headers_spec.json の別の場所も指定できる)
出力: 差の一覧を標準出力へ・差が 0 なら「差 0」と出して終了コード 0・1 つでもあれば 1
検査の中身: ①シートの名前と並びが同じ ②各シートの列数が同じ ③見出しが同じ(末尾の ( … ) と空白は無視・並び順は比べない) ④各列の値の型(文字/整数/数/日付)と空欄の可否
      ⑤説明シートは 19 行 2 列・『今日（計算の基準日）』『作成』の行の値が日付
呼ぶ人: selftest_synth.py・人
触る外の物: 読むだけ(xlsx と spec)
確かめ方: python -I scripts/sap_synth/compare_headers.py 合成.xlsx
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xlsx_min import read_xlsx   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_PER_COL = 3   # 同じ列の型違いは最初の数件だけ書く(件数は出す)


def norm(name):
    return re.sub(r'\s+', ' ', re.sub(r'\s*\(.*\)\s*$', '', str(name))).strip()


def kind_ok(t, cell):
    """型 t に cell(('str'|'num'|'date', 値))が合うか"""
    k, v = cell
    if t == 'any':
        return True
    if t == 'text':
        return k == 'str'
    if t == 'int':
        return k == 'num' and v == int(v)
    if t == 'number':
        return k == 'num'
    if t == 'date':
        return k == 'date'
    return False


def compare(book, spec):
    diffs = []
    names = [n for n, _ in book]
    want = [s['name'] for s in spec['sheets']]
    for n in want:
        if n not in names:
            diffs.append('シートが無い: %s' % n)
    for n in names:
        if n not in want:
            diffs.append('余計なシート: %s' % n)
    common_actual = [n for n in names if n in want]
    common_want = [n for n in want if n in names]
    if common_actual != common_want:
        diffs.append('シートの並びが違う: %s ≠ %s' % (common_actual, common_want))
    data = dict(book)
    for sh in spec['sheets']:
        nm = sh['name']
        if nm not in data:
            continue
        rows = data[nm]
        if sh['kind'] == 'text':
            diffs.extend(check_desc(nm, rows, sh))
            continue
        head = rows[0] if rows else []
        htxt = [(c[1] if c and c[0] == 'str' else None) for c in head]
        if len(htxt) != sh['cols']:
            diffs.append('%s: 列数が違う(%d 列・見本は %d 列)' % (nm, len(htxt), sh['cols']))
        if any(h is None for h in htxt):
            diffs.append('%s: 見出しが文字でない・空の列がある' % nm)
        if sh['kind'] == 'calc' or not sh.get('columns'):
            if sh.get('headers_known') is False:
                want_h = ['(未確認)列%02d' % (i + 1) for i in range(sh['cols'])]
                if sorted(norm(h) for h in htxt if h) != sorted(norm(h) for h in want_h):
                    diffs.append('%s: 見出しが見本(未確認の placeholder)と違う' % nm)
            continue
        wh = [c[0] for c in sh['columns']]
        a, w = sorted(norm(h) for h in htxt if h is not None), sorted(norm(h) for h in wh)
        for h in sorted(set(w)):
            ca, cw = a.count(h), w.count(h)
            if ca < cw:
                diffs.append('%s: 見出しが足りない: 「%s」(見本 %d 個・ここ %d 個)' % (nm, h, cw, ca))
        for h in sorted(set(a)):
            if a.count(h) > w.count(h):
                diffs.append('%s: 余計な見出し: 「%s」(見本 %d 個・ここ %d 個)' % (nm, h, w.count(h), a.count(h)))
        # 値の型(位置ごと: 見出しの名前 → 型。同じ名前が重なる物は同じ型)
        tmap = {}
        for c in sh['columns']:
            tmap.setdefault(norm(c[0]), (c[1], c[2]))
        bad = {}
        for ri, r in enumerate(rows[1:], 2):
            if len(r) > len(htxt):
                diffs.append('%s: %d 行目が見出しより多い列を持つ' % (nm, ri))
                break
            for ci, h in enumerate(htxt):
                if h is None or norm(h) not in tmap:
                    continue
                t, nullable = tmap[norm(h)]
                cell = r[ci] if ci < len(r) else None
                if cell is None:
                    if not nullable:
                        bad.setdefault((ci, h, '空欄は不可'), []).append(ri)
                elif not kind_ok(t, cell):
                    bad.setdefault((ci, h, '型が違う(見本は %s・ここは %s)' % (t, cell[0])), []).append(ri)
        for (ci, h, why), rs in sorted(bad.items()):
            diffs.append('%s: 「%s」(%d 列目) %s %d 行(例: %s 行目)' % (nm, h, ci + 1, why, len(rs), ','.join(str(x) for x in rs[:MAX_PER_COL])))
    return diffs


def check_desc(nm, rows, sh):
    d = []
    if len(rows) != sh['rows']:
        d.append('%s: 行数が違う(%d 行・見本は %d 行)' % (nm, len(rows), sh['rows']))
    if any(len(r) > sh['cols'] for r in rows):
        d.append('%s: 列数が %d を超える行がある' % (nm, sh['cols']))
    for label, typ in sh['required_labels']:
        hit = [r for r in rows if r and r[0] and r[0][0] == 'str' and r[0][1].strip() == label]
        if len(hit) != 1:
            d.append('%s: 項目「%s」の行が %d 個(1 個のはず)' % (nm, label, len(hit)))
        elif len(hit[0]) < 2 or hit[0][1] is None or not kind_ok(typ, hit[0][1]):
            d.append('%s: 項目「%s」の値が %s でない' % (nm, label, typ))
    return d


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('xlsx')
    ap.add_argument('--spec', default=os.path.join(HERE, 'headers_spec.json'))
    a = ap.parse_args(argv)
    with open(a.spec, encoding='utf-8') as f:
        spec = json.load(f)
    diffs = compare(read_xlsx(a.xlsx), spec)
    unconf = sum(1 for s in spec['sheets'] for c in (s.get('columns') or []) if c[0].startswith('(未確認)'))
    unconf += sum(s['cols'] for s in spec['sheets'] if s.get('headers_known') is False and s['kind'] != 'text')
    for d in diffs:
        print('差: ' + d)
    print('見出しが未確認の列(設計書に書かれていない・placeholder): %d 列' % unconf)
    print('差 %d' % len(diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
