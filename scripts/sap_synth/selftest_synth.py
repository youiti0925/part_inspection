#!/usr/bin/env python3
"""合成 Excel の道具と「見本の見出しと差 0 か比べる検査」の試験(家の PC で・合成データだけ)。
目的: ①合成 Excel が見本の見出し・型と差 0(小さい版・大きい版・全部の癖つき) ②同じ種なら同じバイト列 ③癖ごとに「入れた時だけ現れる」
      ④壊した物(見出し 1 つ違い・列 1 つ追加・型違い・シートなし …)では比べる検査が赤になる(=検査が働いている)
入力: なし(一時ファイルを作って消す)
出力: 標準出力に 1 項目ずつ OK/NG・全部 OK で終了コード 0
呼ぶ人: npm run sap-synth:test  /  python -I -X utf8 scripts/sap_synth/selftest_synth.py
触る外の物: 一時フォルダだけ
"""
import copy
import datetime
import hashlib
import os
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare_headers import compare, norm   # noqa: E402
from make_synth_xlsx import QUIRKS, UNSUPPORTED, build, load_spec, main as make_main   # noqa: E402
from xlsx_min import XDate, read_xlsx, write_xlsx   # noqa: E402

BASE = datetime.date(2026, 11, 22)
SPEC = load_spec()
FAILS = []


def check(name, ok, detail=''):
    print('%s  %s%s' % ('OK' if ok else 'NG', name, ('  ' + detail) if detail and not ok else ''))
    if not ok:
        FAILS.append(name)


def to_book(sheets):
    """build() の出力(Python の値)を、読み戻した時と同じ形((種類, 値))にする"""
    book = []
    for nm, rows in sheets:
        out = []
        for r in rows:
            row = []
            for v in r:
                if v is None or v == '':
                    row.append(None)
                elif isinstance(v, XDate):
                    row.append(('date', float(v)))
                elif isinstance(v, (int, float)):
                    row.append(('num', float(v)))
                else:
                    row.append(('str', v))
            out.append(row)
        book.append((nm, out))
    return book


def via_file(sheets, tmp, name='t.xlsx'):
    p = os.path.join(tmp, name)
    write_xlsx(p, sheets)
    return read_xlsx(p)


# ---- 癖の probe: 読み戻した本から「その癖が現れているか」を見る(入れていない本では False であること) ----
def tab(book, nm):
    rows = dict(book)[nm]
    head = [c[1] for c in rows[0]]
    return head, rows[1:]


def col(head, name, nth=0):
    return [i for i, h in enumerate(head) if norm(h) == name][nth]


def val(r, i):
    return r[i][1] if i < len(r) and r[i] else None


def probes(book):
    wh, wr = tab(book, 'SAP_作業')
    hh, hr = tab(book, 'SAP_製造指図')
    ci = {n: col(wh, n) for n in ['指図', '活動', '作業区', '作業 Text', '実績実行開始日', '実績実行終了日', '標準値 1', '標準値 2', '標準値 3']}
    ui = [col(wh, '標準値単位', k) for k in range(4)]
    orders = [val(r, ci['指図']) for r in wr]
    p = {}
    p['D1'] = (any(o[0].isalpha() for o in orders) and any(len(o) == 12 for o in orders) and any(o.startswith('0') for o in orders))
    acts = {val(r, ci['活動']) for r in wr}
    p['D2'] = '0001' in acts and '0120' in acts
    p['D3'] = any(r[ci['実績実行開始日']] is not None and (len(r) <= ci['実績実行終了日'] or r[ci['実績実行終了日']] is None) for r in wr)
    p['D4'] = any(val(r, ci['実績実行終了日']) is not None and val(r, ci['実績実行終了日']) != int(val(r, ci['実績実行終了日'])) for r in wr)
    zero = [r for r in wr if all((val(r, ci[k]) or 0) == 0 for k in ['標準値 1', '標準値 2', '標準値 3'])]
    # 検査の作業区は元から標準値 1・2 が 0 なので 機械の工程だけで割合を見る
    mach = [r for r in wr if val(r, ci['作業区']) not in ('2309', '2526', '2509', '2519')]
    mz = [r for r in mach if all((val(r, ci[k]) or 0) == 0 for k in ['標準値 1', '標準値 2', '標準値 3'])]
    p['D5'] = len(mach) > 0 and len(mz) / len(mach) >= 0.3
    p['D6'] = any(len(r) > ui[1] and r[ui[1]] is None for r in wr) or any(len(r) <= ui[1] for r in wr)
    by = {}
    for r in wr:
        by.setdefault(val(r, ci['指図']), []).append(r)
    st = {val(r, col(hh, '指図')): val(r, col(hh, 'システム Status')) for r in hr}
    done_tok = {'TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD'}

    def open_(r):
        return r[ci['実績実行終了日']] is None if len(r) > ci['実績実行終了日'] else True
    p['D7'] = any(any(open_(rs[j]) and not open_(rs[k]) for j in range(len(rs)) for k in range(j + 1, len(rs))) for rs in by.values())
    p['D8'] = any(val(r, ci['実績実行終了日']) is not None and (EPOCH_DATE + datetime.timedelta(days=int(val(r, ci['実績実行終了日'])))).weekday() >= 5 for r in wr)
    p['D9'] = any(set((st.get(o) or '').split()) & done_tok and any(open_(r) for r in rs) for o, rs in by.items())
    p['D10'] = any(len(r) <= ci['作業区'] or r[ci['作業区']] is None for r in wr) and any(len(r) <= ci['作業 Text'] or r[ci['作業 Text']] is None for r in wr)
    txt = [val(r, col(hh, '品目 Text')) or '' for r in hr]
    p['D15'] = any(',' in t for t in txt) and any(any('Ａ' <= ch <= 'ｚ' for ch in t) for t in txt) and any(' ' in t for t in txt)
    dh = dict((r[0][1], r[1][1]) for r in dict(book)['説明'] if r and r[0] and len(r) > 1 and r[1])
    p['D16'] = int(dh['作成']) - int(dh['今日（計算の基準日）']) == 1
    bs = [val(r, col(hh, '基準開始日付')) for r in hr]
    p['D17'] = max(bs) - dh['今日（計算の基準日）'] <= 35
    return p


EPOCH_DATE = datetime.date(1899, 12, 30)


def main():
    t0 = time.time()
    tmp = tempfile.mkdtemp(prefix='sapsynth_')
    # 1. 小さい版・差 0
    s, truth = build(1, BASE, 40, quirks=())
    d = compare(via_file(s, tmp), SPEC)
    check('小さい版(指図 40)が見本の見出し・型と差 0', d == [], str(d[:5]))
    check('小さい版は作業区 2309/2526/2509/2519 を全部含む', all(any(r[2] and r[2][1] == w for r in dict(to_book(s))['SAP_作業'][1:]) for w in ('2309', '2526', '2509', '2519')))
    # 2. 全部の癖つき・差 0
    s2, _ = build(2, BASE, 40, quirks=list(QUIRKS))
    d = compare(via_file(s2, tmp, 'all.xlsx'), SPEC)
    check('全部の癖(D1〜D10・D15〜D17)つきでも差 0', d == [], str(d[:5]))
    # 3. 大きい版
    t1 = time.time()
    s3, truth3 = build(3, BASE, 3000, quirks=list(QUIRKS))
    b3 = via_file(s3, tmp, 'large.xlsx')
    d = compare(b3, SPEC)
    check('大きい版(指図 3000・癖つき)が差 0 (%d 行・%.1f 秒)' % (len(dict(b3)['SAP_作業']) - 1, time.time() - t1), d == [], str(d[:5]))
    # 4. 同じ種=同じバイト列
    ps = []
    for i, seed in enumerate((7, 7, 8)):
        p = os.path.join(tmp, 'd%d.xlsx' % i)
        make_main(['--out', p, '--seed', str(seed), '--quirk', 'D3'])
        ps.append(hashlib.sha256(open(p, 'rb').read()).hexdigest())
    check('同じ種(7)は毎回同じバイト列・別の種(8)は違う', ps[0] == ps[1] and ps[0] != ps[2])
    # 5. 癖ごと: 入れた時だけ現れる
    base_p = probes(via_file(build(4, BASE, 40, quirks=())[0], tmp, 'p0.xlsx'))
    for k in QUIRKS:
        on = probes(via_file(build(4, BASE, 40, quirks=[k])[0], tmp, 'p_%s.xlsx' % k))
        others = [x for x in on if x != k and on[x] and not base_p[x]]
        check('癖 %-3s: 入れると現れる・入れないと現れない・他の癖を巻き込まない' % k, on[k] and not base_p[k] and not others, 'on=%s base=%s others=%s' % (on[k], base_p[k], others))
    # 6. 未対応の癖は黙って通さない
    for k in UNSUPPORTED:
        rc = make_main_rc(['--out', os.path.join(tmp, 'u.xlsx'), '--quirk', k])
        check('未対応の癖 %s は終了コード 2 で止まる(黙って作らない)' % k, rc == 2)
    # 7. 壊した物は赤
    good = via_file(build(5, BASE, 40, quirks=())[0], tmp, 'g.xlsx')
    check('(基準)壊す前は差 0', compare(good, SPEC) == [])
    spec_idx = {n: i for i, (n, _) in enumerate(good)}

    def mut(fn):
        b = copy.deepcopy(good)
        fn(dict(b), b)
        return compare(b, SPEC)

    def set_head(sheet, old, new):
        def f(dd, b):
            h = dd[sheet][0]
            i = [j for j, c in enumerate(h) if norm(c[1]) == old][0]
            h[i] = ('str', new)
        return f

    sab = {
        '見出しを 1 つ変える(作業区→作業場)': set_head('SAP_作業', '作業区', '作業場'),
        '見出しを 1 つ変える(製造指図の 指図タイプ→タイプ)': set_head('SAP_製造指図', '指図タイプ', 'タイプ'),
        '列を先頭に 1 つ足す(列の記号で読む人の対策の試験)': lambda dd, b: [r.insert(0, ('str', 'x')) for r in dd['SAP_作業']],
        '見出しを 1 つ消す(列が 1 つ減る)': lambda dd, b: [r.pop() for r in dd['SAP_作業']],
        '標準値単位を 4 個→3 個にする(重なりの数が違う)': set_head('SAP_作業', '標準値単位', '標準値 5'),
        '指図を数にする(文字→数)': lambda dd, b: [r.__setitem__(0, ('num', 1.0)) for r in dd['SAP_作業'][1:3]],
        '活動を数にする(0010→10・先頭の 0 が落ちる)': lambda dd, b: [r.__setitem__(1, ('num', 10.0)) for r in dd['SAP_作業'][1:3]],
        '日付を文字にする': lambda dd, b: [r.__setitem__(17, ('str', '2026-11-22')) for r in dd['SAP_作業'][1:3]],
        '数量を小数にする': lambda dd, b: [r.__setitem__(5, ('num', 1.5)) for r in dd['SAP_作業'][1:2]],
        '指図の欄を空にする(空欄不可)': lambda dd, b: [r.__setitem__(0, None) for r in dd['SAP_作業'][1:2]],
        'シートを 1 枚消す(SAP_在庫)': lambda dd, b: b.pop(spec_idx['SAP_在庫']),
        'シートの名前を変える(SAP_作業→SAP_工程)': lambda dd, b: b.__setitem__(spec_idx['SAP_作業'], ('SAP_工程', dd['SAP_作業'])),
        '余計なシートを足す': lambda dd, b: b.append(('メモ', [[('str', 'x')]])),
        'シートの並びを入れ替える': lambda dd, b: b.reverse(),
        '説明シートの基準日を文字にする': lambda dd, b: dd['説明'][1].__setitem__(1, ('str', '2026-11-22')),
        '説明シートの「作成」の行を消す': lambda dd, b: dd['説明'].pop(2),
        'SAP_在庫の列数を 22 列にする': lambda dd, b: [r.pop() for r in dd['SAP_在庫']],
    }
    for name, fn in sab.items():
        d = mut(fn)
        check('壊すと赤: ' + name, len(d) > 0, '差 0 のまま(検査が働いていない)')
    # 8. 見出しは末尾の ( … ) を付けても通る(元の見出しの付き方が違っても止まらない)
    def suffix(dd, b):
        h = dd['SAP_作業'][0]
        h[5] = ('str', h[5][1] + ' (MEINH)')
    check('見出しに末尾の (MEINH) が付いていても差 0(元の付き方の違いで止めない)', mut(suffix) == [])

    # 9. 答え(truth)が自分の数え直しと合う
    wh, wr = tab(b3, 'SAP_作業')
    hh, hr = tab(b3, 'SAP_製造指図')
    stat = {val(r, col(hh, '指図')): (val(r, col(hh, 'システム Status')) or '').split() for r in hr}
    cc = {n: col(wh, n) for n in ['指図', '作業数量', '実績実行終了日', '標準値 1', '標準値 2']}
    n_open = 0
    hours = 0.0
    for r in wr:
        if set(stat[val(r, cc['指図'])]) & {'TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD'}:
            continue
        if len(r) <= cc['実績実行終了日'] or r[cc['実績実行終了日']] is None:
            n_open += 1
            hours += (val(r, cc['標準値 1']) or 0) + (val(r, cc['標準値 2']) or 0) * val(r, cc['作業数量'])
    check('truth の未完了の工程数が読み戻しの数え直しと同じ(%d)' % n_open, n_open == truth3['openOpsOfOpenOrders'])
    check('truth の時間の合計が読み戻しの数え直しと同じ(%.1f)' % hours, abs(hours - truth3['openHours(標準値1+標準値2×数量)']) < 0.05)
    # 10. 本物の名前が入っていない: 文字の欄は決めた作り物の形だけ
    bad = []
    for r in dict(b3)['SAP_製造指図'][1:]:
        if not (r[2][1].startswith('試作') and r[1][1].startswith('ITM-')):
            bad.append(r[2][1])
    check('品目・品目 Text は作り物の形(ITM-… / 試作…)だけ', not bad)
    print('---- %s (%.1f 秒)' % ('全部 OK' if not FAILS else 'NG %d 件: %s' % (len(FAILS), FAILS), time.time() - t0))
    return 1 if FAILS else 0


def make_main_rc(argv):
    try:
        return make_main(argv)
    except SystemExit as e:
        return e.code


if __name__ == '__main__':
    sys.exit(main())
