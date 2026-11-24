#!/usr/bin/env python3
"""SAP 操業データ(RPA が出す 13 枚の xlsx)と同じシート名・同じ見出し・同じ型の「合成 Excel」を作る道具。中身は全部作り物。
目的: 実データを開発の PC に持ち込まずに、取込(段1〜3)の試験を回す。種の番号が同じなら毎回同じバイト列ができる。
入力: 引数(--seed 種・--base-date 基準日・--orders 指図数・--size small/large・--wcs 作業区・--quirk 癖)
      見出しと型は scripts/sap_synth/headers_spec.json から読む(設計 A-2/A-3 を起こした物)
出力: xlsx 1 個 + 同じ名前の .truth.json(作った時に分かっている答え: 未完了の工程数・時間の合計・作業区ごとの件数)
      客先名・仕入先名・金額は出さない(出す欄もない)。名前は「試作機種…」の様な明らかな作り物だけ。
呼ぶ人: 人・selftest_synth.py(・段2以降の試験)
触る外の物: --out のファイルと .truth.json の書き込みだけ(ネットワーク・Firebase に触れない・AI を使わない)
確かめ方: python -I scripts/sap_synth/selftest_synth.py   /   python -I scripts/sap_synth/make_synth_xlsx.py --out x.xlsx --quirk D3
癖(設計 A-5): D1〜D10・D15〜D17 は入れられる。D11〜D14 は他シートの見出しが設計書に無いので未対応(--list-quirks)
"""
import argparse
import datetime
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xlsx_min import XDate, write_xlsx   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EPOCH = datetime.date(1899, 12, 30)
DONE_TOKENS = ('TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD')   # 終わった指図の記号(RPA と同じ 6 つ)
INSPECT_WC = ('2309', '2526', '2509', '2519')
MACHINE_WC = ('2313', '2351', '2320', '2381', '2101', 'B05', '2630')   # 機械加工の作業区(旋盤・横M/C・フライス・平面研削)+機械でない作業区(2101 付帯・B05 キーワード分類・2630 洗浄)
INSPECT_STD3 = {'2309': 1.0, '2526': 1.04, '2509': 0.45, '2519': 0.2}   # 設計 A-4 の中央値(2519 は作り物)

QUIRKS = {
    'D1': '指図が数字だけとは限らない(英字始まり・12 文字・先頭 0)',
    'D2': '活動は 4 桁の文字(0001〜0120 の広い範囲・先頭 0 あり)',
    'D3': '開始だけ入って終了が空の行(実物は 0 行・規則の負荷試験用の作り物)',
    'D4': '日付に時刻が付く物(実物は日だけ・規則の負荷試験用の作り物)',
    'D5': '標準値 1〜3 が全部 0 の工程が 45%',
    'D6': '標準値の単位が空の行',
    'D7': '前の工程が未なのに後ろが済の指図',
    'D8': '土日の実績',
    'D9': '終わった指図(TECO 等)に未完了の工程が残る',
    'D10': '作業区が空の行・作業 Text が空の行・前後に空白のある作業 Text',
    'D15': '品目 Text に , 入り・全角入り・空白入り',
    'D16': '説明シートの作成日が基準日の翌日(1 日ずれ)',
    'D17': '先の計画が薄い(基準開始日が 35 日先まで)',
}
UNSUPPORTED = {
    'D11': '不足部品は指図+品目で重複(「不足部品」「SAP_組立指図の部品」の見出しが設計書に無い)',
    'D12': '購買発注に 3 種類の行・金額・仕入先名(「SAP_購買発注」の見出しが設計書に無い・金額や仕入先名は作らない方針)',
    'D13': '在庫に品目が空の行・特殊在庫 O/E(「SAP_在庫」の見出しが設計書に無い)',
    'D14': '組立指図は 250 件だけ・出庫日なし(「組立指図」の見出しが設計書に無い)',
}


def work_text(wc, act):
    """作業 Text(作り物)。機械グループの分類(sapProgress.js readWorkName)の試験用に、作業区コードの範囲・キーワード・洗浄・付帯作業の 4 通りが出る"""
    if wc == 'B05':
        return '横M/C:加工%s' % act            # コードの範囲の外・キーワードで機械に分類される
    if wc == '2630':
        return '面取り洗浄%s' % act            # 洗浄 → wash
    if wc == '2101':
        return '付帯作業:応援%s' % act          # 付帯作業 → misc(機械グループに入れない)
    if wc in INSPECT_WC:
        return '作業%s-%s' % (wc, act)
    return ('%s:機械%s' % (wc, act)) if int(act) % 20 == 0 else ''    # 範囲の中のコード: 空の時は作業区コードで名前を引く

def serial(d):
    return (d - EPOCH).days


def norm(name):
    return re.sub(r'\s+', ' ', re.sub(r'\s*\(.*\)\s*$', '', name)).strip()


def load_spec():
    with open(os.path.join(HERE, 'headers_spec.json'), encoding='utf-8') as f:
        return json.load(f)


def sheet_header(sh):
    if sh.get('columns'):
        return [c[0] for c in sh['columns']]
    if sh.get('headers_known') is False and sh['kind'] != 'text':
        return ['(未確認)列%02d' % (i + 1) for i in range(sh['cols'])]
    return None


class Cols:
    """見出しの名前(正規化)→ 列の位置。同名が重なる物(標準値単位)は出てくる順"""
    def __init__(self, header):
        self.pos = {}
        for i, h in enumerate(header):
            self.pos.setdefault(norm(h), []).append(i)
        self.n = len(header)

    def at(self, name, nth=0):
        return self.pos[norm(name)][nth]

    def row(self):
        return [None] * self.n

    def put(self, r, name, v, nth=0):
        r[self.pos[norm(name)][nth]] = v


def weekday_back(d):
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return d


def build(seed=1, base_date=datetime.date(2026, 11, 22), n_orders=40, wcs=INSPECT_WC, quirks=()):
    """(シート一覧, 答え) を返す。xlsx に書く前の形(selftest が壊して試せる)"""
    q = set(quirks)
    rng = random.Random(seed)
    spec = load_spec()
    sheets_spec = {s['name']: s for s in spec['sheets']}
    wcs = tuple(wcs)
    machine = [w for w in MACHINE_WC]
    base = base_date
    horizon = 35 if 'D17' in q else 84

    # ---- 指図番号 ----
    nums = []
    cur = 100000000 + rng.randint(0, 5000000)
    for _ in range(n_orders):
        cur += rng.randint(1, 9)
        nums.append(str(cur))
    if 'D1' in q:
        for i in range(n_orders):
            r = rng.random()
            if r < 0.11:
                nums[i] = rng.choice('ABCDEFGH') + nums[i][1:]          # 英字始まり 9 文字
        if n_orders >= 3:   # 小さい版でも必ず 3 種類が入る
            nums[0] = 'A' + nums[0][1:]                                  # 英字始まり
            nums[1] = 'B' + nums[1] + '00'                               # 12 文字・英字始まり
            nums[2] = '0' + nums[2]                                      # 先頭 0(数にすると落ちる)
    nums = list(dict.fromkeys(nums))
    n_orders = len(nums)

    # ---- 活動の候補 ----
    if 'D2' in q:
        act_pool = sorted(set(['0001', '0010', '0015', '0020', '0030', '0040', '0050', '0060', '0070', '0080', '0090', '0100', '0110', '0120']))
    else:
        act_pool = ['0010', '0020', '0030', '0040', '0050', '0060']

    # ---- 指図ごとの工程の形 ----
    orders = []   # dict
    for i, no in enumerate(nums):
        route = []   # wc の並び
        if '2519' in wcs and rng.random() < 0.12:
            route.append('2519')
        for _ in range(rng.choice([1, 1, 2, 2, 3])):
            route.append(rng.choice(machine))
        if '2309' in wcs and rng.random() < 0.5:
            route.append('2309')
            if rng.random() < 0.03:
                route.append('2309')
        if '2509' in wcs and rng.random() < 0.5:
            route.append('2509')
        if '2526' in wcs and rng.random() < 0.6:
            route.append('2526')
        route = route[:len(act_pool)]
        r = rng.random()
        if r < 0.15:
            status_kind = 'done'
        elif r < 0.25:
            status_kind = 'allcnf'     # 全工程済だが指図はまだ開いている
        else:
            status_kind = 'open'
        orders.append({'no': no, 'route': route, 'kind': status_kind, 'qty': rng.randint(1, 300)})

    # 癖が小さい版でも必ず現れる様に、指図を指定する
    def pick(pred, k):
        c = [o for o in orders if pred(o)]
        return c[:k]
    if 'D7' in q:
        for o in pick(lambda o: o['kind'] == 'open' and len(o['route']) >= 3, 3):
            o['d7'] = True
    if 'D9' in q:
        for o in pick(lambda o: o['kind'] == 'done', 2):
            o['d9'] = True

    # ---- 工程の行 ----
    wk = sheets_spec['SAP_作業']
    cw = Cols([c[0] for c in wk['columns']])
    ops_rows = []
    truth_ops = []   # 未完了の数え直し用
    n_weekend = 0

    def done_date(prev):
        d = prev + datetime.timedelta(days=rng.randint(0, 3))
        if d > base:
            d = base
        if 'D8' not in q:
            d = weekday_back(d)
        return d

    for oi, o in enumerate(orders):
        n = len(o['route'])
        if o['kind'] == 'done':
            k = n
        elif o['kind'] == 'allcnf':
            k = n
        else:
            k = rng.randint(0, n - 1)    # 先頭から k 個が済・残りが未
        done_flags = [i < k for i in range(n)]
        if o.get('d9'):
            done_flags[-1] = False
        if o.get('d7'):
            done_flags[0] = False
            done_flags[-1] = True
        o['all_done'] = all(done_flags)
        acts = sorted(rng.sample(act_pool, n)) if 'D2' in q else act_pool[:n]
        d = base - datetime.timedelta(days=rng.randint(5, 50))
        qty = o['qty']
        o['ops'] = []
        for j, (wc, act) in enumerate(zip(o['route'], acts)):
            r = cw.row()
            cw.put(r, '指図', o['no'])
            cw.put(r, '活動', act)
            cw.put(r, '作業区', wc)
            cw.put(r, '作業 Text (短)', work_text(wc, act) or None)
            cw.put(r, '作業数量', qty)
            cw.put(r, '作業単位', 'PC')
            is_done = done_flags[j]
            if is_done:
                d = done_date(d)
                adate = d
                if 'D8' in q and (rng.random() < 0.1 or n_weekend < 3):
                    while adate.weekday() < 5:      # 直前の日曜まで戻す(基準日を越えない)
                        adate -= datetime.timedelta(days=1)
                    n_weekend += 1
                cw.put(r, '実績実行開始日', XDate(serial(adate)))
                cw.put(r, '実績実行終了日', XDate(serial(adate)))
                es = adate - datetime.timedelta(days=rng.randint(0, 2))
                ee = adate
            else:
                es = base + datetime.timedelta(days=rng.randint(0, horizon))
                ee = es + datetime.timedelta(days=rng.randint(0, 3))
                if 'D17' in q:
                    lim = base + datetime.timedelta(days=35)
                    es = min(es, lim)
                    ee = min(max(ee, es), lim)
            cw.put(r, '最早実行開始日', XDate(serial(es)))
            cw.put(r, '最早実行終了日', XDate(serial(ee)))
            # 標準値
            if wc in INSPECT_STD3:
                s1, s2, s3 = 0.0, 0.0, INSPECT_STD3[wc]
            else:
                s1 = round(rng.uniform(0.1, 3.0), 2)
                s2 = round(rng.uniform(0.05, 8.0), 2)
                s3 = round(rng.uniform(0.0, 2.0), 2) if rng.random() < 0.4 else 0.0
                if s1 + s2 + s3 == 0:
                    s1 = 0.5
            if 'D5' in q and rng.random() < 0.45:
                s1 = s2 = s3 = 0.0
            for nth, v in enumerate((s1, s2, s3, 0.0)):
                cw.put(r, '標準値 %d' % (nth + 1), float(v))
                cw.put(r, '標準値単位', 'H', nth)
            cw.put(r, '確認', '%07d' % (5000001 + len(ops_rows)))
            o['ops'].append((r, is_done, wc, act, s1, s2, qty))
            ops_rows.append(r)
        # 癖: 個別に上書き
    flat = [x for o in orders for x in o['ops']]
    if 'D3' in q:
        # 開いた指図の「最後に済んだ工程」の終了だけを消す(後ろは全部未なので D7 にならず・済の指図に触れないので D9 にならない)
        c = []
        for o in orders:
            if o['kind'] == 'open' and not o.get('d7'):
                dn = [x for x in o['ops'] if x[1]]
                if dn:
                    c.append(dn[-1])
        for x in c[:3]:
            x[0][cw.at('実績実行終了日')] = None
        if len(c) < 3:   # 足りない時は未の工程に開始だけ足す(終了は空のまま)
            for x in [y for y in flat if not y[1]][:3 - len(c)]:
                x[0][cw.at('実績実行開始日')] = XDate(serial(base - datetime.timedelta(days=1)))
    if 'D4' in q:
        c = [x for x in flat if x[1]][:3]
        for r, *_ in c:
            for nm in ('実績実行開始日', '実績実行終了日'):
                p = cw.at(nm)
                if r[p] is not None:
                    r[p] = XDate(float(r[p]) + 0.375)
    if 'D6' in q:
        for r, *_ in flat[:3]:
            r[cw.at('標準値単位', 1)] = None
            r[cw.at('標準値単位', 2)] = None
    if 'D10' in q:
        if flat:
            flat[0][0][cw.at('作業区', 0)] = None
        for i, (r, *_) in enumerate(flat):
            rr = rng.random()
            if i == 1 or rr < 0.085:
                r[cw.at('作業 Text (短)', 0)] = None
            elif i == 2 or rr < 0.1:
                r[cw.at('作業 Text (短)', 0)] = '  ' + str(r[cw.at('作業 Text (短)', 0)]) + ' '

    # ---- 製造指図 ----
    hs = sheets_spec['SAP_製造指図']
    hc = Cols([c[0] for c in hs['columns']])
    head_rows = []
    for i, o in enumerate(orders):
        r = hc.row()
        hc.put(r, '指図', o['no'])
        hc.put(r, '品目', 'ITM-%06d' % rng.randint(0, 999999))
        t = '試作機種%s-%d' % (chr(65 + i % 26), 100 + i)
        if 'D15' in q and i % 4 == 0:
            t = ['試作機種,%s-%d', '試作機種Ａ%s-%d', '試作 機種 %s-%d', '試作機種,%s-%d'][(i // 4) % 4] % (chr(65 + i % 26), 100 + i)
        hc.put(r, '品目 Text', t)
        hc.put(r, '指図タイプ', 'ZHK1' if rng.random() < 0.83 else rng.choice(['ZHK6', 'ZHK8', 'ZZ07']))
        hc.put(r, '指図数量', o['qty'])
        hc.put(r, '(未確認)指図数量の単位', 'PC')
        off = rng.randint(-100, horizon)
        if i == 1 and 'D17' not in q:
            off = 70            # 先の計画が薄くない事(35 日先より先がある事)を必ず作る
        if 'D17' in q:
            off = min(off, 35)
        bs = base + datetime.timedelta(days=off)
        hc.put(r, '基準開始日付', XDate(serial(bs)))
        hc.put(r, '基準終了日付', XDate(serial(bs + datetime.timedelta(days=rng.randint(2, 20)))))
        if o['kind'] == 'done':
            st = rng.choice(['TECO', 'CMPL', 'DLV', 'TECO CMPL', 'REL CNF DLV'])
        elif o['kind'] == 'allcnf':
            st = 'REL CNF PCNF'
        else:
            st = rng.choice(['REL', 'REL PCNF', 'CRTD', 'REL CNF PCNF'])
        o['status'] = st
        hc.put(r, 'システム Status', st)
        if rng.random() < 0.8:
            hc.put(r, 'MRP 管理者', 'M%02d' % rng.randint(1, 5))
            hc.put(r, '製造責任者', 'S%02d' % rng.randint(1, 25))
        head_rows.append(r)

    # ---- 説明 ----
    created = datetime.datetime.combine(base + datetime.timedelta(days=1 if 'D16' in q else 0), datetime.time(22, 35))
    desc = [['操業データ(合成・作り物)', None]]
    desc.append(['今日（計算の基準日）', XDate(serial(base))])
    desc.append(['作成', created.strftime('%Y/%m/%d %H:%M')])    # 実物(11-24)は文字列 YYYY/MM/DD HH:MM
    for i in range(len(desc), 19):
        desc.append(['説明行%02d(作り物)' % (i + 1), '作り物の説明文'])

    out = []
    for sh in spec['sheets']:
        nm = sh['name']
        if nm == '説明':
            out.append((nm, desc))
        elif nm == 'SAP_作業':
            out.append((nm, [[c[0] for c in wk['columns']]] + ops_rows))
        elif nm == 'SAP_製造指図':
            out.append((nm, [[c[0] for c in hs['columns']]] + head_rows))
        else:
            out.append((nm, [sheet_header(sh)]))

    # ---- 答え(作った時に分かっている物) ----
    open_ops = 0
    hours = 0.0
    by_wc = {}
    for o in orders:
        if any(t in o['status'].split() for t in DONE_TOKENS):
            continue
        for r, is_done, wc, act, s1, s2, qty in o['ops']:
            if r[cw.at('実績実行終了日', 0)] is None:     # 実績終了日が無い = 未完了(RPA と同じ見方)
                open_ops += 1
                hours += s1 + s2 * qty
                by_wc[wc] = by_wc.get(wc, 0) + 1
    truth = {
        'seed': seed, 'baseDate': base.isoformat(), 'quirks': sorted(q), 'orders': len(orders),
        'workRows': len(ops_rows), 'openOpsOfOpenOrders': open_ops,
        'openHours(標準値1+標準値2×数量)': round(hours, 2), 'openOpsByWc': dict(sorted(by_wc.items())),
        'note': '工程の未完了=実績終了日が空・終わりの記号(TECO CMPL DLV CLSD DLT LKD)のある指図は外す。段2の検査 ⑧⑨⑩ の答え合わせ用(「工程_未完了」シートは見出しが不明なので空)',
    }
    return out, truth


def parse_quirks(vals):
    out = []
    for v in vals or []:
        for x in v.split(','):
            x = x.strip().upper()
            if x == 'ALL':
                out.extend(QUIRKS.keys())
            elif x:
                out.append(x)
    return list(dict.fromkeys(out))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', help='出力 xlsx(.truth.json も同じ名前で出る)')
    ap.add_argument('--seed', type=int, default=1, help='種の番号(同じなら同じ物)')
    ap.add_argument('--base-date', default='2026-11-22', help='基準日 YYYY-MM-DD')
    ap.add_argument('--size', choices=['small', 'large'], default='small', help='small=指図 40 件・large=約 3 千指図(見本並み)')
    ap.add_argument('--orders', type=int, help='指図数(--size より優先)')
    ap.add_argument('--wcs', default=','.join(INSPECT_WC), help='検査の作業区(既定 2309,2526,2509,2519)')
    ap.add_argument('--quirk', action='append', help='癖 D1〜D17(複数回・カンマ区切り・all 可)')
    ap.add_argument('--list-quirks', action='store_true')
    a = ap.parse_args(argv)
    if a.list_quirks:
        for k, v in QUIRKS.items():
            print('%-4s 対応  %s' % (k, v))
        for k, v in UNSUPPORTED.items():
            print('%-4s 未対応 %s' % (k, v))
        return 0
    if not a.out:
        ap.error('--out が要ります')
    qs = parse_quirks(a.quirk)
    for k in qs:
        if k in UNSUPPORTED:
            print('癖 %s は未対応: %s' % (k, UNSUPPORTED[k]), file=sys.stderr)
            return 2
        if k not in QUIRKS:
            print('知らない癖: %s(--list-quirks で一覧)' % k, file=sys.stderr)
            return 2
    n = a.orders if a.orders else (3000 if a.size == 'large' else 40)
    base = datetime.date.fromisoformat(a.base_date)
    sheets, truth = build(a.seed, base, n, a.wcs.split(','), qs)
    write_xlsx(a.out, sheets)
    with open(os.path.splitext(a.out)[0] + '.truth.json', 'w', encoding='utf-8') as f:
        json.dump(truth, f, ensure_ascii=False, indent=1)
    print('作った: %s  指図 %d・作業の行 %d・癖 %s' % (a.out, truth['orders'], truth['workRows'], ','.join(qs) or 'なし'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
