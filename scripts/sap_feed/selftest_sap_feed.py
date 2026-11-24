#!/usr/bin/env python3
"""段2(読む・検査する・絞る)の試験(家の PC で・合成データだけ)。設計 §E の 6 つ + 規則ごとの「外すと赤」。
目的: ①合成データで往復(分かっている答えと同じ) ②壊れた入力が全部止まって理由が出る ③規則ごとに、外した版を自動で作り試験が赤になる事を見せる
      ④同じ入力なら同じ束・2 回やって増えない ⑤束に客先・仕入先・金額の欄が 0 ⑥見ていない種(作る時=7,8 / 最後に 1 回だけ=404)
入力: なし(一時ファイルを作って消す)。--final を付けた時だけ最後の種(404)を流す(実装が固まるまで流さない)
出力: 標準出力に OK/NG と、壊れた入力の止まり方・外すと赤の一覧。全部 OK で終了コード 0
呼ぶ人: npm run sap-feed:test  /  npm run sap-feed:final(最後の種)
触る外の物: 一時フォルダだけ
履歴: 最後の種 101 は 11-24 に 1 回流して赤 1 件(規則 order_str の試験入力が、全体で一番新しい実績日を消して検査⑦を正しく止めた=試験入力の欠陥・feed.py は正しい)。
      直し: 実績日は消さず未完了の工程を足す形に変更。種 101 は使い切りなので最後の種は 404 に替えた(直した後に 1 回だけ流す)
      11-24 種 202 は緑。その後、実物の説明シートは「作成」が文字列 YYYY/MM/DD HH:MM(基準日は日付)で検査①に止まった=仕様変更(規則 made_text・合成 Excel も実物の形に)。
      202 も使い切りなので最後の種は 303 に替えたが、303 は order_str(D1)の試験入力が種に頼っていて赤 1 件(3 番目の指図が英字始まりになり、数に直しても変わらなかった=試験入力の欠陥)。
      直し: 先頭が 0 で数字だけの指図を試験の中で自分で作る形に変更(種に頼らない)。303 も使い切りなので最後の種は 404(--final)。アプリ別の束(段2 B)も同じ回で足した
"""
import copy
import datetime
import json
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from feed import CHK, FORBIDDEN_KEYS, RULES, Rules, run_feed, write_outputs   # noqa: E402
from make_feed import truth_to_reference   # noqa: E402
from make_synth_xlsx import build, serial   # noqa: E402
from xlsx_min import XDate, write_xlsx   # noqa: E402

BASE = datetime.date(2026, 11, 22)
DONE = ('TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD')
TMP = tempfile.TemporaryDirectory()
FAILS = []
_n = [0]
SEED = [7]     # 作る時の種(最後の種は --final の時だけ)


def check(name, ok, detail=''):
    print('%s  %s%s' % ('OK' if ok else 'NG', name, ('  ' + detail) if detail and not ok else ''))
    if not ok:
        FAILS.append(name)


# ---------- 合成データの扱い ----------
def S(seed, quirks=(), n=40):
    return build(seed, BASE, n, ('2309', '2526', '2509', '2519'), list(quirks))   # (sheets, truth)


def sh(sheets, name):
    return dict(sheets)[name]


APPS = {'product': ['2309'], 'final': ['2526'], 'parts': ['2509', '2519']}     # app_wcs.json と同じ(試験は設定ファイルに頼らない)


def run(sheets, prev=None, reference=None, rules=None, max_bytes=1000000, inject=None, name='x', app_wcs=None):
    _n[0] += 1
    p = os.path.join(TMP.name, '操業データ_%s_%d.xlsx' % (name, _n[0]))
    write_xlsx(p, sheets)
    return run_feed(p, prev_record=prev, reference=reference, rules=rules, max_bytes=max_bytes, inject=inject, app_wcs=app_wcs)


# 生の行の列の位置(headers_spec.json の SAP_作業 / SAP_製造指図 の並び)
WO, WA, WC, WQ, WS, WE, S1, U1, S2, U2, S3, ES, EE = 0, 1, 2, 5, 7, 8, 9, 10, 11, 12, 13, 17, 18
HO, HI, HT, HQ, HB, HST = 0, 1, 2, 4, 6, 8


def included(sheets):
    """束に入るはずの指図と工程(生の行だけから・feed.py とは別に数える)。{指図: 工程の行(活動順)}"""
    head, work = sh(sheets, 'SAP_製造指図')[1:], sh(sheets, 'SAP_作業')[1:]
    done = {r[HO] for r in head if any(t in DONE for t in r[HST].split())}
    by = {}
    for r in work:
        if r[WO] and r[WO] not in done and r[WC] not in (None, ''):
            by.setdefault(r[WO], []).append(r)
    return {o: sorted(rs, key=lambda r: r[WA]) for o, rs in by.items() if any(r[WE] is None for r in rs)}


def head_row(sheets, order):
    return [r for r in sh(sheets, 'SAP_製造指図')[1:] if r[HO] == order][0]


def pick(sheets, minops=1):
    inc = included(sheets)
    return [o for o in sorted(inc) if len(inc[o]) >= minops]


def day(d):
    return XDate(serial(d))


# ---------- 規則ごとのケース(入力の作り方・合格の言い方) ----------
def case_by_name():
    sheets, _ = S(SEED[0])
    base = run(sheets)
    shifted = copy.deepcopy(sheets)
    rows = sh(shifted, 'SAP_作業')
    for i, r in enumerate(rows):
        r.insert(3, '(試験で足した列)' if i == 0 else 'x')    # 列を 1 つ足した合成データ
    return {'sheets': shifted, 'ok': lambda rec, b, d: rec['status'] == 'ok' and b['ops'] == base[1]['ops'] and b['orders'] == base[1]['orders']}


def case_order_str():
    sheets, _ = S(SEED[0], ['D1'])
    z = '0012345678'       # 先頭が 0 で数字だけの指図を試験の中で自分で作る(種に頼らない・数に直すと 12345678 になって落ちる)
    src = pick(sheets)[0]
    h = list(head_row(sheets, src))
    h[HO], h[HST] = z, 'REL'
    sh(sheets, 'SAP_製造指図').append(h)
    op = [list(r) for r in included(sheets)[src] if r[WE] is None][0]       # 未完了の工程を 1 つ写して新しい指図につける(実績日は触らない)
    op[WO], op[WA] = z, '0010'
    sh(sheets, 'SAP_作業').append(op)
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and {o['order'] for o in b['orders']} == set(included(sheets)) and z in {o['order'] for o in b['orders']}}


def case_act_str():
    sheets, _ = S(SEED[0], ['D2'])
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and {(o['order'], o['act']) for o in b['ops']} == {(o, r[WA]) for o, rs in included(sheets).items() for r in rs} and all(re.match(r'^\d{4}$', o['act']) for o in b['ops'])}


def case_done_by_end():
    sheets, truth = S(SEED[0], ['D3'])
    return {'sheets': sheets, 'ref': truth_to_reference(truth), 'ok': lambda rec, b, d: rec['status'] == 'ok'}


def case_date_floor():
    sheets, _ = S(SEED[0])
    for o in pick(sheets)[:6]:
        for r in included(sheets)[o]:
            r[ES] = XDate(float(r[ES]) + 0.375)
            r[EE] = XDate(float(r[EE]) + 0.375)
            if r[WE] is not None:
                r[WE] = XDate(float(r[WE]) + 0.375)
        h = head_row(sheets, o)
        h[HB] = XDate(float(h[HB]) + 0.375)

    def ok(rec, b, d):
        ds = [b['baseDate']] + [x for o in b['orders'] for x in (o['baseStart'], o['baseEnd'])] + [x for o in b['ops'] for x in (o['earlyStart'], o['earlyEnd'], o['actualEnd']) if x]
        return rec['status'] == 'ok' and all(re.match(r'^\d{4}-\d{2}-\d{2}$', x) for x in ds)
    return {'sheets': sheets, 'ok': ok}


def case_std_zero_null():
    sheets, _ = S(SEED[0])
    o = pick(sheets)[0]
    r = included(sheets)[o][0]
    r[S1] = r[S2] = r[S3] = 0.0
    want = sum(1 for rs in included(sheets).values() for x in rs if x[S1] == x[S2] == x[S3] == 0)
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and sum(1 for x in b['ops'] if x['std1'] is None and x['std2'] is None and x['std3'] is None) == want >= 1}


def case_unit_h_only():
    sheets, _ = S(SEED[0])
    o = pick(sheets)[0]
    rs = included(sheets)[o]
    op = [r for r in rs if r[WE] is None][0]
    op[S2] = 2.5
    op[U2] = None        # 単位が空
    op[S1], op[U1] = 1.5, 'MIN'   # 単位が H でない
    key = (o, op[WA])

    def ok(rec, b, d):
        x = [y for y in b['ops'] if (y['order'], y['act']) == key]
        return rec['status'] == 'ok' and x and x[0]['std1'] is None and x[0]['std2'] is None and any('単位が空' in k for k in rec['info']) and any('H でない' in k for k in rec['info'])
    return {'sheets': sheets, 'ok': ok}


def _expected_suspect(sheets):
    n = 0
    for rs in included(sheets).values():
        seen = False
        for r in rs:
            if r[WE] is None:
                seen = True
            elif seen:
                n += 1
    return n


def case_suspect_flag():
    sheets, _ = S(SEED[0])
    o = pick(sheets, 2)[0]
    rs = included(sheets)[o]
    rs[0][WS] = rs[0][WE] = None
    rs[1][WS] = rs[1][WE] = day(BASE - datetime.timedelta(days=2))
    want = _expected_suspect(sheets)
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and sum(x['suspectOrder'] for x in b['ops']) == want >= 1}


def case_keep_weekend():
    sheets, _ = S(SEED[0])
    o = pick(sheets, 2)[0]
    rs = included(sheets)[o]
    sat = BASE - datetime.timedelta(days=1)       # 11-21 は土曜日
    rs[0][WS] = rs[0][WE] = day(sat)
    rs[-1][WS] = rs[-1][WE] = None
    want = sum(len(v) for v in included(sheets).values())

    def ok(rec, b, d):
        return rec['status'] == 'ok' and len(b['ops']) == want and any(x['actualEnd'] == sat.isoformat() for x in b['ops'])
    return {'sheets': sheets, 'ok': ok}


def case_exclude_done_orders():
    sheets, truth = S(SEED[0], ['D9'])
    return {'sheets': sheets, 'ref': truth_to_reference(truth), 'ok': lambda rec, b, d: rec['status'] == 'ok' and sum(v for k, v in rec['dropped'].items() if '終わった指図' in k) > 0}


def case_drop_wc_empty():
    sheets, _ = S(SEED[0])
    o = pick(sheets, 2)[0]
    included(sheets)[o][0][WC] = None
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and all(x['wc'] != '' for x in b['ops']) and any('作業区が空' in k for k in rec['dropped'])}


def case_item_text_raw():
    sheets, _ = S(SEED[0])
    o = pick(sheets)[0]
    head_row(sheets, o)[HT] = 'ＡＢ,C 1 '
    raw = {r[HO]: (r[HT] or '').strip() or None for r in sh(sheets, 'SAP_製造指図')[1:]}
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and all(x['itemText'] == raw[x['order']] for x in b['orders']) and any(x['itemText'] == 'ＡＢ,C 1' for x in b['orders'])}


def case_gen_separate():
    sheets, _ = S(SEED[0], ['D16'])
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and b['baseDate'] == '2026-11-22' and b['generatedAt'].startswith('2026-11-23T22:35')}


def case_made_text():
    sheets, _ = S(SEED[0])
    return {'sheets': sheets, 'ok': lambda rec, b, d: rec['status'] == 'ok' and b['generatedAt'] == '2026-11-22T22:35:00+09:00'}


def exp_app(sheets, wcs):
    """生の行だけから: そのアプリの束に入るはずの工程の鍵の集合"""
    return {(o, r[WA]) for o, rs in included(sheets).items() for r in rs if r[WC] in wcs}


def app_ok(sheets, rec, bs):
    """アプリ別の束が全部正しいか(工程の集合・指図の集合・作業区が混じらない・重複 0)"""
    if rec['status'] != 'ok' or not isinstance(bs, dict):
        return False
    seen = set()
    for app, wl in APPS.items():
        b = bs[app]
        keys = {(o['order'], o['act']) for o in b['ops']}
        if keys != exp_app(sheets, wl) or len(keys) != len(b['ops']) or keys & seen:
            return False
        seen |= keys
        if {o['order'] for o in b['orders']} != {k[0] for k in keys} or any(o['wc'] not in wl for o in b['ops']) or any(w['wc'] not in wl for w in b['history']['weekly']):
            return False
    return True


def case_app_partition():
    sheets, _ = S(SEED[0])
    return {'sheets': sheets, 'app': True, 'skip': ['A1'], 'ok': lambda rec, b, d: app_ok(sheets, rec, b)}


def case_app_orders_only():
    sheets, _ = S(SEED[0])
    return {'sheets': sheets, 'app': True, 'skip': ['A1'], 'ok': lambda rec, b, d: rec['status'] == 'ok' and all({o['order'] for o in b[a_]['orders']} == {x['order'] for x in b[a_]['ops']} for a_ in APPS)}


def case_app_history():
    sheets, _ = S(SEED[0])
    return {'sheets': sheets, 'app': True, 'skip': ['A1'], 'ok': lambda rec, b, d: rec['status'] == 'ok' and all(w['wc'] in APPS[a_] for a_ in APPS for w in b[a_]['history']['weekly']) and any(b[a_]['history']['weekly'] for a_ in APPS)}


def case_other_counted():
    sheets, _ = S(SEED[0])
    mapped = {w for wl in APPS.values() for w in wl}
    n_all = sum(1 for rs in included(sheets).values() for r in rs if r[WC] not in mapped)
    n_open = sum(1 for rs in included(sheets).values() for r in rs if r[WC] not in mapped and r[WE] is None)
    return {'sheets': sheets, 'app': True, 'skip': ['A1'], 'ok': lambda rec, b, d: rec['status'] == 'ok' and rec['other']['ops'] == n_all > 0 and rec['other']['openOps'] == n_open}


RULE_CASES = {
    'app_partition': ('アプリ別: どの工程も 1 つのアプリにだけ入る・作業区が混じらない', case_app_partition),
    'app_orders_only': ('アプリ別: orders はそのアプリの作業区の工程を持つ指図だけ', case_app_orders_only),
    'app_history': ('アプリ別: history はそのアプリの作業区だけ', case_app_history),
    'other_counted': ('どのアプリにも属さない工程は件数を記録に出す(黙って捨てない)', case_other_counted),
    'made_text': ('「作成」が文字列 YYYY/MM/DD HH:MM(実物の形)でも読む', case_made_text),
    'by_name': ('見出しを名前で探す(列の記号で読まない)', case_by_name),
    'order_str': ('D1 指図は文字のまま(先頭の 0・英字を落とさない)', case_order_str),
    'act_str': ('D2 活動は 4 桁の文字', case_act_str),
    'done_by_end': ('D3 済=実績終了日がある(作業中を作らない)', case_done_by_end),
    'date_floor': ('D4 日付は日だけの文字', case_date_floor),
    'std_zero_null': ('D5 標準値が全部 0 は「不明」', case_std_zero_null),
    'unit_h_only': ('D6 単位が H でない・空は null にして数から外す', case_unit_h_only),
    'suspect_flag': ('D7 前が未で後ろが済=入力もれらしい印', case_suspect_flag),
    'keep_weekend': ('D8 土日の実績を弾かない', case_keep_weekend),
    'exclude_done_orders': ('D9 終わった指図を外す(件数を出す)', case_exclude_done_orders),
    'drop_wc_empty': ('D10 作業区が空の行は読めない行として数える', case_drop_wc_empty),
    'item_text_raw': ('D15 品目 Text は加工しない(前後の空白だけ)', case_item_text_raw),
    'gen_separate': ('D16 基準日と作成日時を別々に持つ', case_gen_separate),
}


# ---------- 検査ごとのケース(壊した入力が、その検査で止まる) ----------
def broken(name):
    sheets, truth = S(SEED[0])
    base_rec = run(sheets)[0]
    ref = truth_to_reference(truth)
    ctx = {'sheets': copy.deepcopy(sheets), 'prev': None, 'ref': None, 'max_bytes': 1000000, 'inject': None, 'app_wcs': None}
    s = ctx['sheets']
    work = sh(s, 'SAP_作業')
    inc = included(s)
    if name == 'c1':
        work[0][WO] = 'ZZ'
    elif name == 'c2':
        ctx['prev'] = base_rec
        del work[1 + int(0.4 * (len(work) - 1)):]
    elif name == 'c3':
        work.append(list(work[1]))
    elif name == 'c4':
        o = sorted(inc)[0]
        head = sh(s, 'SAP_製造指図')
        head.remove(head_row(s, o))
    elif name == 'c5':
        r = [r for r in work[1:] if r[WE] is not None][0]
        r[WE] = XDate(float(r[WE]) - 3)
    elif name == 'c6':
        r = [r for r in work[1:] if r[WE] is not None][0]
        r[WS] = r[WE] = day(BASE + datetime.timedelta(days=2))
    elif name == 'c7':
        sh(s, '説明')[1][1] = day(BASE + datetime.timedelta(days=30))
    elif name == 'c8':
        ctx['ref'] = dict(ref, openOps=ref['openOps'] + 1)
    elif name == 'c9':
        ctx['ref'] = dict(ref, openHours=ref['openHours'] + 10)
    elif name == 'c10':
        w = sorted(ref['byWc'])[0]
        ctx['ref'] = dict(ref, byWc=dict(ref['byWc'], **{w: ref['byWc'][w] + 1}))
    elif name == 'c11':
        ctx['inject'] = {'客先名': 'x'}
    elif name == 'c12':
        ctx['max_bytes'] = 100
    elif name == 'cP1':
        work[2][ES] = 'abc'
    elif name == 'cA1':
        ctx['app_wcs'] = {'product': ['2309', '2526'], 'final': ['2526'], 'parts': ['2509', '2519']}      # 作業区 2526 が 2 つのアプリにある設定
    if ctx['ref'] is None and name in ('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c11', 'c12', 'cP1', 'cA1'):
        ctx['ref'] = None
    elif ctx['ref'] is None:
        ctx['ref'] = ref
    return ctx


CHECK_CASES = [('c%d' % i, i, CHK[i]) for i in range(1, 13)] + [('cP1', 'P1', 'P1'), ('cA1', 'A1', 'A1')]
DESC = {1: '見出しが 1 つ無い', 2: '行数が前回の 4 割', 3: '指図+活動の重複', 4: '指図ヘッダに無い指図', 5: '開始が終了より後', 6: '実績が基準日より先',
        7: '実績が古い(基準日だけ 30 日先)', 8: '件数が答えと 1 違う', 9: '時間が答えと 10 違う', 10: '作業区ごとの件数が 1 違う', 11: '束に「客先名」の欄', 12: '束が上限 100 バイトを超える', 'P1': '日付が文字', 'A1': '作業区が 2 つのアプリにある設定'}


def run_broken(name, rules=None):
    c = broken(name)
    return run(c['sheets'], prev=c['prev'], reference=c['ref'], rules=rules, max_bytes=c['max_bytes'], inject=c['inject'], name=name, app_wcs=c['app_wcs'])


def red_ids(rec):
    return [c['id'] for c in rec['checks'] if not c['ok']]


def all_keys(x, out=None):
    out = [] if out is None else out
    if isinstance(x, dict):
        for k, v in x.items():
            out.append(str(k))
            all_keys(v, out)
    elif isinstance(x, list):
        for v in x:
            all_keys(v, out)
    return out


# ---------- 試験 ----------
def t1_roundtrip(seeds, label):
    print('\n== ① 合成データで往復(分かっている答えと同じ)%s ==' % label)
    for seed in seeds:
        for quirks, n in (([], 40), (['all'], 40), (['all'], 300), ([], 300)):
            qs = [k for k in 'D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D15 D16 D17'.split()] if quirks == ['all'] else []
            sheets, truth = S(seed, qs, n)
            rec, b, data = run(sheets, reference=truth_to_reference(truth), name='rt')
            nm = '種%d・癖%s・指図%d' % (seed, 'all' if qs else 'なし', n)
            if rec['status'] != 'ok':
                check('往復 ' + nm, False, '止まった: ' + ' / '.join(rec['reasons']))
                continue
            inc = included(sheets)
            blank_open = sum(1 for rs in [[r for r in sh(sheets, 'SAP_作業')[1:] if r[WC] in (None, '') and r[WE] is None and r[WO] in {h[HO] for h in sh(sheets, 'SAP_製造指図')[1:] if not any(t in DONE for t in h[HST].split())}]] for r in rs)
            open_b = [x for x in b['ops'] if not x['done']]
            by = {}
            for x in open_b:
                by[x['wc']] = by.get(x['wc'], 0) + 1
            t_by = truth['openOpsByWc']
            diff = {k: t_by.get(k, 0) - by.get(k, 0) for k in set(t_by) | set(by) if t_by.get(k, 0) != by.get(k, 0)}
            ok_cnt = len(open_b) + blank_open == truth['openOpsOfOpenOrders'] and sum(diff.values()) == blank_open and all(v > 0 for v in diff.values())
            ok_ord = {o['order'] for o in b['orders']} == set(inc) and {(x['order'], x['act']) for x in b['ops']} == {(o, r[WA]) for o, rs in inc.items() for r in rs}
            insp = {w: by.get(w, 0) for w in ('2309', '2526', '2509', '2519')}
            check('往復 %s: 未完了の工程 %d(答え %d・作業区が空 %d)・作業区ごと一致・指図と工程の集合が一致・検査の作業区 %s' % (nm, len(open_b), truth['openOpsOfOpenOrders'], blank_open, insp), ok_cnt and ok_ord,
                  'diff=%s' % diff)
            check('往復 %s: 検査 ①〜⑫(+P1)が全部 OK' % nm, all(c['ok'] for c in rec['checks']) and len(rec['checks']) == 13, str(red_ids(rec)))


def t2_broken():
    print('\n== ② 壊れた入力が全部止まって理由が出る(束は出さない・前の束は残る) ==')
    sheets, truth = S(SEED[0])
    good = run(sheets, reference=truth_to_reference(truth))
    outd = os.path.join(TMP.name, 'out_broken')
    write_outputs(outd, good[0], good[2])
    bsha = open(os.path.join(outd, 'sap-feed.json'), 'rb').read()
    cases = []
    cases.append(('見出しが 1 つ無い(SAP_作業の「指図」)', lambda: run_broken('c1')))

    def no_sheet():
        s = [x for x in copy.deepcopy(sheets) if x[0] != 'SAP_製造指図']
        return run(s)
    cases.append(('シートが無い(SAP_製造指図)', no_sheet))

    def header_only():
        s = [(n, rows[:1]) for n, rows in copy.deepcopy(sheets)]
        return run(s)
    cases.append(('空(全シートが見出しだけ)', header_only))

    def zero_byte():
        p = os.path.join(TMP.name, '操業データ_zero.xlsx')
        open(p, 'wb').close()
        return run_feed(p)
    cases.append(('空(0 バイトのファイル)', zero_byte))

    def garbage():
        p = os.path.join(TMP.name, '操業データ_garbage.xlsx')
        open(p, 'wb').write(b'not an xlsx')
        return run_feed(p)
    cases.append(('壊れたファイル(xlsx でない)', garbage))

    def tmpfile():
        p = os.path.join(TMP.name, '~$操業データ_x.xlsx')
        write_xlsx(p, sheets)
        return run_feed(p)
    cases.append(('作業中の一時ファイル(~$)', tmpfile))
    cases.append(('日付が文字(最早実行開始日が「abc」)', lambda: run_broken('cP1')))
    cases.append(('行数が半分以下(前回の 4 割)', lambda: run_broken('c2')))
    for desc, fn in cases:
        rec, b, data = fn()
        write_outputs(outd, rec, data)
        stopped = rec['status'] == 'stopped' and b is None and data is None and rec['reasons']
        kept = open(os.path.join(outd, 'sap-feed.json'), 'rb').read() == bsha
        print('     止まり方: [%s] 段=%s  理由=%s' % (desc, rec.get('stoppedStage'), ' | '.join(rec['reasons'])[:200]))
        check('止まる・理由が出る・前の束はそのまま: ' + desc, bool(stopped) and kept)


def t3_mutants():
    print('\n== ③ 規則ごとの「外すと赤」(規則を外した版を自動で作り、試験が赤になる事を見せる) ==')
    print('     規則                                                    有効(緑のはず) / 外した版(赤のはず)')
    crashed = []
    for rule, (desc, fn) in RULE_CASES.items():
        c = fn()
        results = []
        for off in (False, True):
            try:
                rec, b, d = run(c['sheets'], reference=c.get('ref'), rules=Rules(off=[rule] if off else [], skip_checks=c.get('skip', ()) if off else ()), name='m', app_wcs=APPS if c.get('app') else None)
                results.append(b is not None and bool(c['ok'](rec, b, d)))
            except Exception as e:   # noqa: BLE001 規則を外して落ちた=赤
                results.append(False)
                crashed.append('%s:%s' % (rule, type(e).__name__))
        print('     %-56s %s / %s' % (desc, '緑' if results[0] else '赤', '赤(期待通り)' if not results[1] else '緑(試験が働いていない)'))
        check('規則 %s: 有効なら緑・外すと赤' % rule, results[0] and not results[1])
    for key, cid, label in CHECK_CASES:
        ok_on = ok_off = None
        try:
            rec = run_broken(key)[0]
            ok_on = rec['status'] == 'stopped' and label in red_ids(rec)
        except Exception as e:   # noqa: BLE001
            ok_on = False
        try:
            rec2 = run_broken(key, Rules(skip_checks=[cid]))[0]
            ok_off = rec2['status'] == 'stopped' and label in red_ids(rec2)
        except Exception:   # noqa: BLE001
            ok_off = False
        print('     検査%-3s %-34s 有効(その検査で止まる=緑) %s / 外した版 %s' % (label, DESC[cid], '緑' if ok_on else '赤', '赤(期待通り)' if not ok_off else '緑(試験が働いていない)'))
        check('検査%s: 有効ならその検査で止まる・外すと止まらず赤' % label, ok_on and not ok_off)
    check('外した版が「落ちた」ではなく「結果が違って赤」になっている(落ちた=%s)' % crashed, not crashed)
    covered = set(RULE_CASES)
    check('外せる規則 %d 個すべてに「外すと赤」の例がある' % len(RULES), covered == set(RULES), str(set(RULES) - covered))


def t6_made():
    print('== 説明シートの「作成」(実物は文字列 YYYY/MM/DD HH:MM・基準日は日付のまま厳しく) ==')
    sheets, _ = S(SEED[0])
    desc = lambda sh_: sh(sh_, '説明')[2]   # noqa: E731
    assert desc(sheets)[0] == '作成' and isinstance(desc(sheets)[1], str)

    def with_made(v):
        s2 = copy.deepcopy(sheets)
        desc(s2)[1] = v
        return run(s2)
    for label, v, want in (('文字列 YYYY/MM/DD HH:MM', '2026/11/23 22:35', '2026-11-23T22:35:00+09:00'),
                           ('文字列 秒あり', '2026/11/23 22:35:10', '2026-11-23T22:35:10+09:00'),
                           ('文字列 - 区切り', '2026-11-23 22:35', '2026-11-23T22:35:00+09:00'),
                           ('日付型', XDate(serial(BASE) + 1 + (22 * 60 + 35) / 1440.0), '2026-11-23T22:35:00+09:00')):
        rec, b, _ = with_made(v)
        check('作成=%s で通り generatedAt=%s' % (label, want), rec['status'] == 'ok' and b['generatedAt'] == want, str(rec['reasons']))
    for label, v in (('別形式の文字(11月23日)', '11月23日 22:35'), ('時刻なしの文字', '2026/11/23'), ('空', None), ('存在しない日付', '2026/13/40 25:99')):
        rec, b, _ = with_made(v)
        print('     止まり方: [作成=%s] 段=%s 理由=%s' % (label, rec.get('stoppedStage'), ' | '.join(rec['reasons'])))
        check('作成=%s は止まる(検査①)' % label, rec['status'] == 'stopped' and '①' in red_ids(rec))
    s3 = copy.deepcopy(sheets)
    sh(s3, '説明')[1][1] = '2026/11/22'
    rec, b, _ = run(s3)
    check('基準日は文字だと止まる(日付のまま厳しく)', rec['status'] == 'stopped' and '①' in red_ids(rec))
    rec, b, _ = run(sheets, rules=Rules(off=['made_text']))
    check('直す前の版(作成=日付のみ許す)に戻すと、文字列の作成で赤(止まる)', rec['status'] == 'stopped')


def t7_apps():
    print('\n== アプリ別の束(product=2309・final=2526・parts=2509,2519・どれにも無い作業区は束にしない) ==')
    for n, quirks in ((40, []), (300, 'D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D15 D16 D17'.split())):
        sheets, truth = S(SEED[0], quirks, n)
        ref = truth_to_reference(truth)
        one = run(sheets, reference=ref, name='one')
        rec, bs, ds = run(sheets, reference=ref, name='app', app_wcs=APPS)
        nm = '指図%d・癖%s' % (n, 'all' if quirks else 'なし')
        check('アプリ別 %s: 検査が全部 OK・束は 3 個(product・final・parts)' % nm, rec['status'] == 'ok' and sorted(bs) == sorted(APPS), str(rec.get('reasons')))
        if rec['status'] != 'ok':
            continue
        check('アプリ別 %s: 工程の集合が生の行から作った答えと一致・重複 0・他アプリの作業区が混じらない・orders はそのアプリの工程を持つ指図だけ' % nm, app_ok(sheets, rec, bs))
        tot = len(one[1]['ops'])
        oth = rec['other']
        check('アプリ別 %s: 工程の和が全体と一致(アプリ %s + どれにも属さない %d = 全体 %d)' % (nm, '+'.join(str(len(b['ops'])) for b in bs.values()), oth['ops'], tot), sum(len(b['ops']) for b in bs.values()) + oth['ops'] == tot)

        def hours(ops):
            return sum((o['std1'] or 0) + (o['std2'] or 0) * o['qty'] for o in ops if not o['done'])
        oh = hours(one[1]['ops'])
        mapped = {w for wl in APPS.values() for w in wl}
        other_h = hours([o for o in one[1]['ops'] if o['wc'] not in mapped])
        check('アプリ別 %s: 未完了の時間の和が全体と一致(%.2f)・未完了の工程数の和も一致' % (nm, oh), abs(sum(hours(b['ops']) for b in bs.values()) + other_h - oh) < 0.02
              and sum(1 for b in bs.values() for o in b['ops'] if not o['done']) + oth['openOps'] == sum(1 for o in one[1]['ops'] if not o['done']))
        check('アプリ別 %s: どのアプリにも属さない件数が記録に出る(工程 %d・未完了 %d・作業区 %s)' % (nm, oth['ops'], oth['openOps'], ','.join(oth['wcs'])), oth['ops'] > 0 and not (set(oth['wcs']) & mapped))
        ks = [k for b in bs.values() for k in _all_keys_t(b)]
        check('アプリ別 %s: 3 つの束の欄名に客先・仕入先・金額などが 0' % nm, not [k for k in ks if any(f.lower() in k.lower() for f in FORBIDDEN_KEYS)])
    # 大きい版(指図 3000)で各束が上限以内
    sheets, truth = S(SEED[0], [], 3000)
    rec, bs, ds = run(sheets, reference=truth_to_reference(truth), name='big', app_wcs=APPS)
    sizes = {k: len(v) for k, v in (ds or {}).items()}
    print('     指図 3000 の束の大きさ(バイト): %s・どれにも属さない工程 %s' % (sizes, rec.get('other', {}).get('ops')))
    check('アプリ別 指図 3000: 各束が上限 1,000,000 バイト以内で検査が全部 OK', rec['status'] == 'ok' and all(v <= 1000000 for v in sizes.values()), str(rec.get('reasons')))
    # ⑫ は各束ごと
    sheets, truth = S(SEED[0], [], 300)
    ref = truth_to_reference(truth)
    rec, bs, ds = run(sheets, reference=ref, name='lim', app_wcs=APPS)
    sz = sorted(len(v) for v in ds.values())
    r2 = run(sheets, reference=ref, max_bytes=sz[-1] - 1, name='lim2', app_wcs=APPS)[0]
    r3 = run(sheets, reference=ref, max_bytes=sz[-1] + 100, name='lim3', app_wcs=APPS)[0]
    print('     束の大きさ %s・上限を最大の束の 1 バイト下にすると: %s' % (sz, ' | '.join(r2['reasons'])[:160]))
    check('検査⑫は各束ごと: 最大の束が上限を超えれば止まり、収まれば通る', r2['status'] == 'stopped' and '⑫' in red_ids(r2) and r3['status'] == 'ok')
    # 書き出し
    outd = os.path.join(TMP.name, 'out_app')
    write_outputs(outd, rec, ds)
    names = sorted(os.listdir(outd))
    shas = {n: open(os.path.join(outd, n), 'rb').read() for n in names}
    write_outputs(outd, rec, ds)
    check('書き出し: sap-feed-product/final/parts.json と記録の 4 ファイル・2 回書いても同じ・増えない', names == ['sap-feed-final.json', 'sap-feed-parts.json', 'sap-feed-product.json', 'sap-feed-record.json'] and sorted(os.listdir(outd)) == names
          and all(open(os.path.join(outd, n), 'rb').read() == v for n, v in shas.items()))


def _all_keys_t(x):
    return all_keys(x)


def t4_determinism():
    print('\n== ④ 同じ入力なら同じ束・2 回やって増えない ==')
    sheets, truth = S(SEED[0], ['D1', 'D5', 'D9'])
    ref = truth_to_reference(truth)
    pa, pb = os.path.join(TMP.name, 'dirA'), os.path.join(TMP.name, 'dirB')
    os.makedirs(pa)
    os.makedirs(pb)
    for d in (pa, pb):
        write_xlsx(os.path.join(d, '操業データ_same.xlsx'), sheets)     # 別の場所に置いた同じ内容・同じ名前のファイル
    r1 = run_feed(os.path.join(pa, '操業データ_same.xlsx'), reference=ref)
    r2 = run_feed(os.path.join(pb, '操業データ_same.xlsx'), reference=ref)
    check('同じ内容の入力なら束のバイト列が同じ', r1[2] is not None and r1[2] == r2[2])
    p = os.path.join(TMP.name, '操業データ_same.xlsx')
    write_xlsx(p, sheets)
    outd = os.path.join(TMP.name, 'out_det')
    a = run_feed(p, reference=ref)
    write_outputs(outd, a[0], a[2])
    files1 = sorted(os.listdir(outd))
    sha1 = open(os.path.join(outd, 'sap-feed.json'), 'rb').read()
    b = run_feed(p, reference=ref)
    write_outputs(outd, b[0], b[2])
    check('もう 1 回流しても束が同じバイト列・ファイルが増えない', open(os.path.join(outd, 'sap-feed.json'), 'rb').read() == sha1 and sorted(os.listdir(outd)) == files1 and b[2] == a[2], str(os.listdir(outd)))
    c = run_feed(p, prev_record=a[0], reference=ref)
    write_outputs(outd, c[0], c[2])
    check('前回の記録を渡すと「変わらず」で束に触らない', c[0]['status'] == 'unchanged' and c[2] is None and open(os.path.join(outd, 'sap-feed.json'), 'rb').read() == sha1)
    bun = a[1]
    check('束の指図・工程は決まった順(指図→活動)に並ぶ', [o['order'] for o in bun['orders']] == sorted(o['order'] for o in bun['orders']) and [(o['order'], o['act']) for o in bun['ops']] == sorted((o['order'], o['act']) for o in bun['ops']))


def t5_forbidden():
    print('\n== ⑤ 束に客先・仕入先・金額の欄が 0 ==')
    n = 0
    bad = []
    for seed in ((404,) if SEED[0] == 404 else (7, 8)):
        sheets, truth = S(seed, 'D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D15 D16 D17'.split(), 300)
        rec, b, data = run(sheets, reference=truth_to_reference(truth))
        if b is None:
            bad.append('止まった')
            continue
        ks = all_keys(b)
        n += len(ks)
        bad += [k for k in ks if any(f.lower() in k.lower() for f in FORBIDDEN_KEYS)]
        txt = data.decode('utf-8')
        bad += [f for f in ('客先', '仕入先', '金額', '単価', '購買発注') if '"%s' % f in txt]
    check('束のすべての欄名(%d 個)に 客先・仕入先・金額・単価・購買・MRP・製造責任者・確認 が 0' % n, not bad, str(bad))
    check('入れない物(確認番号・MRP 管理者・製造責任者)の欄が束に無い(ops/orders の欄名を確かめた)', set(sorted(b['orders'][0])) == {'order', 'item', 'itemText', 'type', 'qty', 'baseStart', 'baseEnd', 'statusTokens', 'issueDate'}
          and set(b['ops'][0]) == {'order', 'act', 'wc', 'qty', 'std1', 'std2', 'std3', 'done', 'actualEnd', 'earlyStart', 'earlyEnd', 'suspectOrder'})


def main():
    final = '--final' in sys.argv
    if final:
        SEED[0] = 404
        print('######## 最後の種(404)を 1 回だけ流す(直さずにそのまま報告する) ########')
    t1_roundtrip([404] if final else [7, 8], '【最後の種 404】' if final else '【作る時の種 7,8】')
    t2_broken()
    t3_mutants()
    t4_determinism()
    t5_forbidden()
    t6_made()
    t7_apps()
    if not final:
        print('== ⑥ 見ていない種: 作る時=7,8 / 最後に 1 回だけ=404(npm run sap-feed:final・実装が固まるまで流さない) ==')
    return finish()


def finish():
    print('\n%s: NG %d 件%s' % ('全部 OK' if not FAILS else '赤あり', len(FAILS), (' → ' + ' / '.join(FAILS)) if FAILS else ''))
    TMP.cleanup()
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
