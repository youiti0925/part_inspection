#!/usr/bin/env python3
"""SAP 操業データ(xlsx)を「読む → 検査 → 絞る → 束 sap-feed/1 を作る」純関数(設計 F-1 段2)。標準ライブラリだけ・AI を使わない・推測で埋めない。
目的: 12.7MB 級の Excel を端末に読ませず、要る列だけの小さい JSON(束)にする。検査が 1 つでも赤なら束を出さず、止まった段と理由を記録に書く。
入力: run_feed(xlsx のパス, prev_record=前回の記録, reference=別の数え方の答え, rules=外す規則(試験用), max_bytes=束の上限)
出力: (記録 dict, 束 dict または None, 束のバイト列または None)。束は検査が全部通った時だけ。同じ入力なら同じバイト列
呼ぶ人: scripts/sap_feed/make_feed.py(コマンド)・selftest_sap_feed.py(試験)
触る外の物: 入力 xlsx の読み取りだけ(書くのは make_feed.py の write_outputs だけ・ネットワーク無し)
確かめ方: npm run sap-feed:test
見出しは名前で探す(列の記号では読まない)。見出しが分からない列・シート(組立指図・在庫など)は読まない・束に入れない
⑧⑨⑩: RPA の計算シート「工程_未完了」は見出しが不明(合成では空)なので、reference(.truth.json の答え)+別の数え方で代用する。検査の note に明記する
"""
import datetime
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'sap_synth'))
from xlsx_min import read_xlsx   # noqa: E402
from make_synth_xlsx import norm, load_spec   # noqa: E402

SCHEMA = 'sap-feed/1'
DONE_TOKENS = ('TECO', 'CMPL', 'DLV', 'CLSD', 'DLT', 'LKD')   # 終わった・消された指図の記号(RPA と同じ 6 つ)
EPOCH = datetime.date(1899, 12, 30)
MAX_BYTES = 1000000   # ⑫ 束の上限(見本で約 850KB・設計 C-3。数字は案=要確認)
FORBIDDEN_KEYS = ('客先', '仕入先', '金額', '単価', '購買', 'MRP', '製造責任者', '確認', 'customer', 'vendor', 'supplier', 'price', 'amount')
ISO = re.compile(r'^\d{4}-\d{2}-\d{2}$')

# 外せる規則の名前(試験用・既定は全部有効)。外した版は試験が赤になる事で、試験が働いている事を示す
RULES = ('app_partition', 'app_orders_only', 'app_history', 'other_counted', 'made_text', 'by_name', 'order_str', 'act_str', 'done_by_end', 'date_floor', 'std_zero_null', 'unit_h_only', 'suspect_flag',
         'keep_weekend', 'exclude_done_orders', 'drop_wc_empty', 'item_text_raw', 'gen_separate')
CHK = {i: c for i, c in enumerate('①②③④⑤⑥⑦⑧⑨⑩⑪⑫', 1)}
CHK['P1'] = 'P1'
CHK['A1'] = 'A1'   # アプリ別の分け方の検査(段2 に足した物・app_wcs がある時だけ)   # 型の検査(日付が文字・数値セルの指図 など)。設計の①〜⑫に足した物

REQ_WORK = ['指図', '活動', '作業区', '作業数量', '実績実行開始日', '実績実行終了日', '標準値 1', '標準値 2', '標準値 3', '最早実行開始日', '最早実行終了日']
REQ_HEAD = ['指図', '品目', '品目 Text', '指図タイプ', '指図数量', '基準開始日付', '基準終了日付', 'システム Status']
LABEL_BASE = '今日（計算の基準日）'
LABEL_MADE = '作成'
# 列ごとの型: text=文字 / textopt=文字か空 / int=整数 / num=数か空 / date=日付 / dateopt=日付か空
TYPES = {
    'SAP_作業': {'指図': 'text', '活動': 'text', '作業区': 'textopt', '作業数量': 'int', '実績実行開始日': 'dateopt', '実績実行終了日': 'dateopt',
               '標準値 1': 'num', '標準値 2': 'num', '標準値 3': 'num', '最早実行開始日': 'date', '最早実行終了日': 'date'},
    'SAP_製造指図': {'指図': 'text', '品目': 'textopt', '品目 Text': 'textopt', '指図タイプ': 'text', '指図数量': 'int',
                 '基準開始日付': 'date', '基準終了日付': 'date', 'システム Status': 'text'},
}


class Rules:
    def __init__(self, off=(), skip_checks=()):
        self.off = set(off)
        self.skip = set(skip_checks)
        for r in self.off:
            if r not in RULES:
                raise ValueError('知らない規則: ' + r)

    def on(self, name):
        return name not in self.off


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def val(c):
    return None if c is None else c[1]


def kind(c):
    return None if c is None else c[0]


def g(row, p):
    """行の p 番目のセル(無い・位置が分からない時は None)"""
    if p is None or p >= len(row):
        return None
    return row[p]


def iso_date(x):
    return None if x is None else (EPOCH + datetime.timedelta(days=int(x // 1))).isoformat()


def toint(c):
    try:
        return int(val(c))
    except (TypeError, ValueError):
        return None


def blank(c):
    return c is None or (kind(c) == 'str' and val(c).strip() == '')


def mk(i, ok, count, note):
    return {'id': CHK[i], 'ok': bool(ok), 'count': count, 'note': note}


def spec_positions(sheet):
    """by_name を外した時(試験用)の読み方: 見出しの名前でなく、見本の並び順(headers_spec.json)の位置で読む"""
    for s in load_spec()['sheets']:
        if s['name'] == sheet:
            pos = {}
            for i, c in enumerate(s['columns']):
                pos.setdefault(norm(c[0]), i)
            return pos
    return {}


def find_cols(sheet, rows, required, rules):
    """(位置の辞書, 見つからない見出しの一覧)。標準値の単位は『標準値 n の右隣の 標準値単位』"""
    header = [norm(str(val(c))) if c is not None else '' for c in rows[0]]
    pos, missing = {}, []
    sp = None if rules.on('by_name') else spec_positions(sheet)
    for name in required:
        n = norm(name)
        if sp is not None:
            pos[name] = sp.get(n)
        elif n in header:
            pos[name] = header.index(n)
        else:
            pos[name] = None
            missing.append(name)
    if sheet == 'SAP_作業':
        for k in (1, 2, 3):
            p = pos.get('標準値 %d' % k)
            u = None
            if p is not None and (sp is not None or (p + 1 < len(header) and header[p + 1] == '標準値単位')):
                u = p + 1
            elif sp is None:
                missing.append('標準値 %d の右隣の「標準値単位」' % k)
            pos['unit%d' % k] = u
    return pos, missing


def type_problems(sheet, rows, pos, rules):
    """型の違う所の件数(名前だけ返す・値は写さない)。{(列, 理由): [件数, 例の行番号]}"""
    probs = {}
    for ri, row in enumerate(rows[1:], 2):
        for name, t in TYPES[sheet].items():
            c = g(row, pos.get(name))
            k = kind(c)
            reason = None
            if t == 'text' and (c is None or k != 'str'):
                if c is not None:
                    reason = '文字でない(数値・日付のセル)'
                elif name not in ('指図', '活動'):
                    reason = '空'          # 指図・活動の空は「捨てた行」として数える(止めない)
            elif t == 'textopt' and c is not None and k != 'str':
                reason = '文字でない(数値・日付のセル)'
            elif t == 'int' and (k != 'num' or val(c) != int(val(c))):
                reason = '整数でない・空'
            elif t == 'num' and c is not None and k != 'num':
                reason = '数でない'
            elif t == 'date' and k != 'date':
                reason = '日付でない(文字・数・空)'
            elif t == 'dateopt' and c is not None and k != 'date':
                reason = '日付でない(文字・数)'
            if reason:
                e = probs.setdefault((name, reason), [0, ri])
                e[0] += 1
    return probs


def parse_work(rows, pos, rules, dropped, info):
    out = []
    for ri, row in enumerate(rows[1:], 2):
        o, a = g(row, pos['指図']), g(row, pos['活動'])
        if blank(o):
            dropped['作業の行: 指図が空'] = dropped.get('作業の行: 指図が空', 0) + 1
            continue
        if blank(a):
            dropped['作業の行: 活動が空'] = dropped.get('作業の行: 活動が空', 0) + 1
            continue
        order = val(o).strip()
        if not rules.on('order_str') and order.isdigit():
            order = str(int(order))          # 規則を外した版: 指図を数に直す(先頭の 0 が落ちる)
        act = val(a).strip()
        if rules.on('act_str'):
            act = act.zfill(4) if act.isdigit() else act
        elif act.isdigit():
            act = str(int(act))              # 規則を外した版: 活動を数に直す
        wc = g(row, pos['作業区'])
        wc = '' if blank(wc) else val(wc).strip()
        r = {'order': order, 'act': act, 'wc': wc, 'qty': toint(g(row, pos['作業数量'])) or 0, 'row': ri}
        for nm, key in (('実績実行開始日', 'aS'), ('実績実行終了日', 'aE'), ('最早実行開始日', 'eS'), ('最早実行終了日', 'eE')):
            c = g(row, pos[nm])
            if c is not None and kind(c) == 'date':
                x = float(val(c))
                if x != int(x):
                    info['時刻つきの日付(日だけにした)'] = info.get('時刻つきの日付(日だけにした)', 0) + 1
                r[key] = x if not rules.on('date_floor') else float(int(x // 1))
            else:
                r[key] = None
        r['std'] = []
        for k in (1, 2, 3):
            c = g(row, pos['標準値 %d' % k])
            u = g(row, pos['unit%d' % k])
            r['std'].append((None if c is None else float(val(c)), None if blank(u) else val(u).strip()))
        out.append(r)
    return out


def parse_head(rows, pos, dropped, rules):
    out = []
    for ri, row in enumerate(rows[1:], 2):
        o = g(row, pos['指図'])
        if blank(o):
            dropped['指図ヘッダの行: 指図が空'] = dropped.get('指図ヘッダの行: 指図が空', 0) + 1
            continue
        order = val(o).strip()
        if not rules.on('order_str') and order.isdigit():
            order = str(int(order))

        def txt(nm):
            c = g(row, pos[nm])
            if blank(c):
                return None
            s = val(c)
            if rules.on('item_text_raw'):
                return s.strip()
            return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s).replace(',', ''))   # 規則を外した版: 品目 Text を勝手に整える
        def f(nm):
            c = g(row, pos[nm])
            return float(val(c)) if kind(c) == 'date' else None
        st = g(row, pos['システム Status'])
        ty = g(row, pos['指図タイプ'])
        out.append({'order': order, 'item': txt('品目'), 'itemText': txt('品目 Text'), 'type': val(ty).strip() if kind(ty) == 'str' else '',
                    'qty': toint(g(row, pos['指図数量'])) or 0, 'bS': f('基準開始日付'), 'bE': f('基準終了日付'),
                    'tokens': val(st).split() if kind(st) == 'str' else []})
    return out


MADE_TEXT = re.compile(r'^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$')


def parse_made(c, rules):
    """「作成」: 日付型、または文字列 YYYY/MM/DD HH:MM(秒あり/なし・区切りは / か -)。それ以外は None(=止める)。実物(11-24)は文字列の形"""
    if kind(c) == 'date':
        d = datetime.datetime(1899, 12, 30) + datetime.timedelta(days=float(val(c)))
        return (d + datetime.timedelta(seconds=30)).replace(second=0, microsecond=0)
    if kind(c) == 'str' and rules.on('made_text'):
        m = MADE_TEXT.match(val(c).strip())
        if m:
            try:
                return datetime.datetime(*[int(x) for x in m.groups() if x is not None])
            except ValueError:
                return None
    return None


def read_desc(rows, rules):
    """説明シートから基準日と作成日時(名前=A 列の文言で探す)。(基準日の数, 作成の日時, 問題の一覧)。基準日は日付型だけ(厳しく)"""
    got, probs = {}, []
    for row in rows:
        a = g(row, 0)
        if a is not None and kind(a) == 'str':
            lab = re.sub(r'\s+', '', val(a))
            for L in (LABEL_BASE, LABEL_MADE):
                if lab == re.sub(r'\s+', '', L):
                    got[L] = g(row, 1)
    made = None
    for L in (LABEL_BASE, LABEL_MADE):
        if L not in got:
            probs.append('説明シートに「%s」の行が無い' % L)
        elif L == LABEL_BASE and kind(got[L]) != 'date':
            probs.append('説明シートの「%s」が日付でない' % L)
        elif L == LABEL_MADE:
            made = parse_made(got[L], rules)
            if made is None:
                probs.append('説明シートの「%s」が日付でも「YYYY/MM/DD HH:MM」の文字列でもない' % L)
    return (None if probs else float(val(got[LABEL_BASE]))), (None if probs else made), probs


def alt_reference(work_rows, head_rows, wpos, hpos):
    """⑧⑨⑩ の『別の数え方』: 生のセルだけから、辞書と Counter で数える(絞りの関数とは別の経路)。
    返す物: 未完了の工程数・時間(標準値1+標準値2×数量・単位を見ない)・作業区ごとの件数(作業区が空の行は '' に数える)"""
    done_orders = set()
    for r in head_rows[1:]:
        o, st = g(r, hpos['指図']), g(r, hpos['システム Status'])
        if o is not None and st is not None and any(t in val(st).split() for t in DONE_TOKENS):
            done_orders.add(val(o).strip())
    n, hours, by = 0, 0.0, {}
    for r in work_rows[1:]:
        o = g(r, wpos['指図'])
        if o is None or val(o).strip() in done_orders or val(o).strip() == '':
            continue
        if g(r, wpos['実績実行終了日']) is not None:
            continue
        n += 1
        s1, s2 = g(r, wpos['標準値 1']), g(r, wpos['標準値 2'])
        hours += (float(val(s1)) if s1 is not None else 0.0) + (float(val(s2)) if s2 is not None else 0.0) * float(val(g(r, wpos['作業数量'])))
        wc = g(r, wpos['作業区'])
        k = '' if wc is None else val(wc).strip()
        by[k] = by.get(k, 0) + 1
    return {'openOps': n, 'openHours': round(hours, 2), 'byWc': by}


def stop_record(base, stage, checks, reason_lines, extra=None):
    rec = dict(base)
    rec.update({'status': 'stopped', 'stoppedStage': stage, 'reasons': reason_lines, 'checks': checks,
                'bundleWritten': False, 'note': '束は出していない。置き場にある前の束はそのまま残る(段3は検査が全部通った後だけ)'})
    if extra:
        rec.update(extra)
    return rec


def run_feed(path, prev_record=None, reference=None, rules=None, max_bytes=MAX_BYTES, inject=None, app_wcs=None):
    rules = rules or Rules()
    base = {'schema': SCHEMA, 'fileName': os.path.basename(path)}
    checks = []

    # ---- 段0 受け取る ----
    if os.path.basename(path).startswith('~$'):
        return stop_record(base, '0 受け取る', checks, ['作業中の一時ファイル(~$ で始まる)なので読まない']), None, None
    try:
        sha = sha256_file(path)
    except OSError as e:
        return stop_record(base, '0 受け取る', checks, ['ファイルを開けない: %s' % type(e).__name__]), None, None
    base['sourceSha256'] = sha
    if prev_record and prev_record.get('sourceSha256') == sha and prev_record.get('status') in ('ok', 'unchanged'):
        rec = dict(prev_record)
        rec['status'] = 'unchanged'
        rec['note'] = '前回と同じファイルなので何もしない(変わらず)'
        return rec, None, None
    try:
        with open(path, 'rb') as fh:
            book = read_xlsx(io.BytesIO(fh.read()))      # ファイルを掴みっぱなしにしない(Windows で消せなくなる)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError, Exception) as e:   # noqa: B014 壊れた xlsx は全部「開けない」として止める
        return stop_record(base, '0 受け取る', checks, ['xlsx として開けない(空・壊れている): %s' % type(e).__name__]), None, None
    sheets = dict(book)
    base['rowCounts'] = {nm: max(0, len(sheets[nm]) - 1) for nm in ('SAP_作業', 'SAP_製造指図') if nm in sheets}

    # ---- 段1 読む・検査 ----
    reds = []
    missing_lines = []
    for nm in ('説明', 'SAP_作業', 'SAP_製造指図'):
        if nm not in sheets:
            missing_lines.append('シート「%s」が無い' % nm)
        elif not sheets[nm]:
            missing_lines.append('シート「%s」が空' % nm)
        elif nm != '説明' and len(sheets[nm]) < 2:
            missing_lines.append('シート「%s」に見出ししか無い(データの行が 0)' % nm)
    wpos = hpos = None
    base_x = made_dt = None
    if not missing_lines:
        wpos, m1 = find_cols('SAP_作業', sheets['SAP_作業'], REQ_WORK, rules)
        hpos, m2 = find_cols('SAP_製造指図', sheets['SAP_製造指図'], REQ_HEAD, rules)
        base_x, made_dt, m3 = read_desc(sheets['説明'], rules)
        missing_lines += ['「SAP_作業」に見出し「%s」が無い' % x for x in m1] + ['「SAP_製造指図」に見出し「%s」が無い' % x for x in m2] + m3
    c1 = mk(1, not missing_lines or 1 in rules.skip, len(missing_lines), '要る見出し・シートを名前で探した: ' + ('全部ある' if not missing_lines else '足りない物がある'))
    checks.append(c1)
    if not c1['ok']:
        return stop_record(base, '1 読む', checks, ['検査①: ' + x for x in missing_lines]), None, None
    probs = {}
    for sh, rows, pos in (('SAP_作業', sheets['SAP_作業'], wpos), ('SAP_製造指図', sheets['SAP_製造指図'], hpos)):
        for (nm, reason), (cnt, row1) in type_problems(sh, rows, pos, rules).items():
            probs[(sh, nm, reason)] = (cnt, row1)
    p1_ok = not probs or 'P1' in rules.skip
    checks.append(mk('P1', p1_ok, sum(v[0] for v in probs.values()), '列の型(日付が日付か・指図が文字か): ' + ('全部合っている' if not probs else '合わない所がある')))
    if not p1_ok:
        lines = ['検査P1: 「%s」の「%s」が%s(%d 件・例は %d 行目)' % (sh, nm, reason, c, r) for (sh, nm, reason), (c, r) in sorted(probs.items())]
        return stop_record(base, '1 読む', checks, lines), None, None

    dropped, info = {}, {}
    work = parse_work(sheets['SAP_作業'], wpos, rules, dropped, info)
    head = parse_head(sheets['SAP_製造指図'], hpos, dropped, rules)
    base_x = 0.0 if base_x is None else base_x      # ① を外した版(試験用)でも落ちない様に
    made_dt = datetime.datetime(1899, 12, 30) if made_dt is None else made_dt
    base_date = iso_date(base_x)
    generated_at = made_dt.isoformat() + '+09:00'
    if not rules.on('gen_separate'):
        generated_at = base_date + 'T00:00:00+09:00'     # 規則を外した版: 作成日時を基準日で代用してしまう

    # ② 行数(前回の 0.5〜2 倍)
    rc = base['rowCounts']
    if prev_record and prev_record.get('rowCounts'):
        bad = []
        for nm, n in rc.items():
            p = prev_record['rowCounts'].get(nm)
            if p and not (0.5 * p <= n <= 2 * p):
                bad.append('%s: 前回 %d → 今回 %d' % (nm, p, n))
        c2 = mk(2, not bad or 2 in rules.skip, len(bad), '行数が前回の 0.5〜2 倍か' + ('' if not bad else ': ' + ' / '.join(bad)))
    else:
        c2 = mk(2, True, 0, '前回の記録が無いので行数の比べは省略(初回)')
    # ③ 鍵の重複
    seen, dup = set(), 0
    for r in work:
        k = (r['order'], r['act'])
        dup += k in seen
        seen.add(k)
    hs, hdup = set(), 0
    for r in head:
        hdup += r['order'] in hs
        hs.add(r['order'])
    c3 = mk(3, (dup + hdup == 0) or 3 in rules.skip, dup + hdup, '指図+活動の重複 %d・指図ヘッダの指図の重複 %d' % (dup, hdup))
    # ④ 工程の指図がヘッダに全部ある
    miss = len({r['order'] for r in work if r['order'] not in hs})
    c4 = mk(4, miss == 0 or 4 in rules.skip, miss, '工程にあって指図ヘッダに無い指図: %d 種類' % miss)
    # ⑤ 開始>終了
    rev = sum(1 for r in work if (r['aS'] is not None and r['aE'] is not None and r['aS'] > r['aE']) or (r['eS'] is not None and r['eE'] is not None and r['eS'] > r['eE']))
    c5 = mk(5, rev == 0 or 5 in rules.skip, rev, '開始が終了より後の行: %d' % rev)
    # ⑥ 実績が基準日より先
    fut = sum(1 for r in work if any(r[k] is not None and int(r[k]) > int(base_x) for k in ('aS', 'aE')))
    c6 = mk(6, fut == 0 or 6 in rules.skip, fut, '実績が基準日より先の行: %d' % fut)
    # ⑦ 実績の一番新しい日が基準日の 7 日以内
    acts_x = [int(r[k]) for r in work for k in ('aS', 'aE') if r[k] is not None]
    latest = max(acts_x) if acts_x else None
    if latest is None:
        c7 = mk(7, 7 in rules.skip, 0, '実績が 1 件も無い(古い・空のデータの恐れ)')
    else:
        gap = int(base_x) - latest
        c7 = mk(7, gap <= 7 or 7 in rules.skip, gap, '実績の一番新しい日は基準日の %d 日前(7 日以内が合格)' % gap)
    for c in (c2, c3, c4, c5, c6, c7):
        checks.append(c)
    red1 = [c for c in checks if not c['ok']]
    if red1:
        return stop_record(base, '1 読む', checks, ['検査%s: %s' % (c['id'], c['note']) for c in red1]), None, None

    # ---- 段2 絞る ----
    head_by = {r['order']: r for r in head}
    done_orders = {r['order'] for r in head if any(t in DONE_TOKENS for t in r['tokens'])} if rules.on('exclude_done_orders') else set()
    by_order = {}
    for r in work:
        by_order.setdefault(r['order'], []).append(r)

    def is_done(r):
        return (r['aE'] is not None) if rules.on('done_by_end') else (r['aE'] is not None or r['aS'] is not None)

    kept_orders, kept_ops = [], []
    wc_empty_open = 0
    for o in sorted(by_order):
        rs = by_order[o]
        if o in done_orders:
            dropped['指図ごと外した: 終わった指図(TECO・CMPL・DLV・CLSD・DLT・LKD)'] = dropped.get('指図ごと外した: 終わった指図(TECO・CMPL・DLV・CLSD・DLT・LKD)', 0) + 1
            dropped['工程の行: 終わった指図の行'] = dropped.get('工程の行: 終わった指図の行', 0) + len(rs)
            continue
        use = [r for r in rs if r['wc'] != '' or not rules.on('drop_wc_empty')]
        nwc = len(rs) - len(use)
        if nwc:
            dropped['工程の行: 作業区が空(読めない行)'] = dropped.get('工程の行: 作業区が空(読めない行)', 0) + nwc
            wc_empty_open += sum(1 for r in rs if r['wc'] == '' and not is_done(r))
        if not any(not is_done(r) for r in use):
            dropped['指図ごと外した: 未完了の工程が 1 つも無い'] = dropped.get('指図ごと外した: 未完了の工程が 1 つも無い', 0) + 1
            dropped['工程の行: 未完了の工程が無い指図の行'] = dropped.get('工程の行: 未完了の工程が無い指図の行', 0) + len(use)
            continue
        kept_orders.append(o)
        use.sort(key=lambda r: r['act'])
        seen_open = False
        for r in use:
            suspect = False
            if is_done(r):
                suspect = seen_open and rules.on('suspect_flag')
            else:
                seen_open = True
            kept_ops.append((r, suspect))
    for o in head_by:
        if o not in by_order:
            dropped['指図ごと外した: 工程が 1 つも無い'] = dropped.get('指図ごと外した: 工程が 1 つも無い', 0) + 1

    fmt = iso_date if rules.on('date_floor') else _raw_date     # 外した版は時刻つきのまま文字にする
    counts = {'std_all_zero': 0, 'unit_blank': 0, 'unit_other': 0}
    excluded_hours = 0.0
    ops_out = []
    for r, suspect in kept_ops:
        s = [x[0] for x in r['std']]
        allzero = all(v is None or v == 0 for v in s)
        done = is_done(r)
        if not rules.on('keep_weekend') and done and r['aE'] is not None and datetime.date.fromordinal(EPOCH.toordinal() + int(r['aE'])).weekday() >= 5:
            continue                                            # 規則を外した版: 土日の実績を弾く
        vals = []
        for k, (v, u) in enumerate(r['std']):
            if v is None:
                vals.append(None)
            elif allzero and rules.on('std_zero_null'):
                vals.append(None)
            elif rules.on('unit_h_only') and u != 'H':
                vals.append(None)
                counts['unit_blank' if u is None else 'unit_other'] += 1
                if not done and k < 2:
                    excluded_hours += v * (r['qty'] if k == 1 else 1)
            else:
                vals.append(v)
        if allzero and rules.on('std_zero_null') and any(x is not None for x in s):
            counts['std_all_zero'] += 1
        ops_out.append({'order': r['order'], 'act': r['act'], 'wc': r['wc'], 'qty': r['qty'], 'std1': vals[0], 'std2': vals[1], 'std3': vals[2],
                        'done': done, 'actualEnd': fmt(r['aE']),
                        'earlyStart': fmt(r['eS']), 'earlyEnd': fmt(r['eE']),
                        'suspectOrder': bool(suspect)})
    if counts['std_all_zero']:
        info['標準値が全部 0(時間は不明として null にした)'] = counts['std_all_zero']
    if counts['unit_blank']:
        info['標準値の単位が空(null にして数から外した)'] = counts['unit_blank']
    if counts['unit_other']:
        info['標準値の単位が H でない(null にして数から外した)'] = counts['unit_other']

    orders_out = []
    for o in kept_orders:
        h = head_by[o]
        orders_out.append({'order': o, 'item': h['item'], 'itemText': h['itemText'], 'type': h['type'], 'qty': h['qty'],
                           'baseStart': fmt(h['bS']), 'baseEnd': fmt(h['bE']), 'statusTokens': h['tokens'], 'issueDate': None})
    # history.weekly: 過去 12 週に終わった工程(作業区×週の月曜)
    wk = {}
    lo = int(base_x) - 84
    for r in work:
        if r['aE'] is not None and lo <= int(r['aE']) <= int(base_x) and r['order'] not in done_orders and r['wc'] != '':
            d = datetime.date.fromordinal(EPOCH.toordinal() + int(r['aE']))
            mon = (d - datetime.timedelta(days=d.weekday())).isoformat()
            s1, s2 = r['std'][0], r['std'][1]
            h = (s1[0] or 0.0 if s1[1] == 'H' else 0.0) + (s2[0] or 0.0 if s2[1] == 'H' else 0.0) * r['qty']
            e = wk.setdefault((r['wc'], mon), [0.0, 0])
            e[0] += h
            e[1] += 1
    weekly = [{'wc': k[0], 'week': k[1], 'hours': round(v[0], 2), 'count': v[1]} for k, v in sorted(wk.items())]

    # 段2 の検査
    open_ops = [o for o in ops_out if not o['done']]
    hours = round(sum((o['std1'] or 0.0) + (o['std2'] or 0.0) * o['qty'] for o in open_ops), 2)
    by_wc = {}
    for o in open_ops:
        by_wc[o['wc']] = by_wc.get(o['wc'], 0) + 1
    alt = alt_reference(sheets['SAP_作業'], sheets['SAP_製造指図'], wpos, hpos)
    refs = [('別の数え方', alt)]
    if reference:
        refs.append(('truth.json', {'openOps': reference['openOps'], 'openHours': reference['openHours'], 'byWc': reference['byWc']}))
    sheet_rows = None
    if '工程_未完了' in sheets and len(sheets['工程_未完了']) > 1:
        sheet_rows = len(sheets['工程_未完了']) - 1
    subst = ('RPA の計算シート(工程_未完了)は' + ('あるので行数も比べた' if sheet_rows else '空のため、') + ('' if sheet_rows else (' truth.json の答え+' if reference else '') + '別の数え方で代用'))
    p8 = [(nm, r['openOps']) for nm, r in refs] + ([('工程_未完了シートの行数', sheet_rows)] if sheet_rows else [])
    mine8 = len(open_ops) + wc_empty_open
    c8 = mk(8, all(v == mine8 for _, v in p8) or 8 in rules.skip, len(open_ops),
            '未完了の工程数 %d(+作業区が空で外した %d)を %s と比べた。%s' % (len(open_ops), wc_empty_open, ' / '.join('%s=%d' % x for x in p8), subst))
    ref_empty = _empty_wc_open_hours(work, done_orders, rules, is_done)      # 作業区が空で外した行の時間(参照側には入っている)
    mine9 = hours + round(excluded_hours, 2) + ref_empty
    bad9 = [nm for nm, r in refs if abs(r['openHours'] - mine9) > 0.011 * max(1, len(open_ops))]
    c9 = mk(9, not bad9 or 9 in rules.skip, len(bad9), '未完了の工程の時間(標準値1+標準値2×数量)の合計 %.2f(単位が H でなく外した %.2f・作業区が空で外した %.2f を足すと %.2f)を %s と比べた。%s'
            % (hours, excluded_hours, ref_empty, mine9, ' / '.join('%s=%.2f' % (nm, r['openHours']) for nm, r in refs), subst))
    ok10, wc_diff = True, set()
    for nm, r in refs:
        d = {wc: r['byWc'].get(wc, 0) - by_wc.get(wc, 0) for wc in set(r['byWc']) | set(by_wc) if wc != ''}
        d = {k: v for k, v in d.items() if v}
        wc_diff |= set(d)
        if nm == '別の数え方':
            ok10 = ok10 and not d                     # 別の数え方は作業区が空の行も '' として数えるので差 0
        else:                                           # truth は外した行の元の作業区に 1 ずつ多く入っている
            ok10 = ok10 and all(v > 0 for v in d.values()) and sum(d.values()) == wc_empty_open
    c10 = mk(10, ok10 or 10 in rules.skip, len(wc_diff), '作業区ごとの件数の差のある作業区: %d(作業区が空で外した %d 行の分は truth 側だけ許す)。%s' % (len(wc_diff), wc_empty_open, subst))

    info_all = dict(info)
    for c in (c8, c9, c10):
        checks.append(c)
    bundle_checks = {'items': None, 'dropped': dict(sorted(dropped.items())), 'info': dict(sorted(info_all.items())),
                     'notes': ['⑧⑨⑩は ' + subst, '出庫日(issueDate)は全部 null(「組立指図」シートの見出しが不明なので読んでいない)', 'wcMap・history.usualDays は空(元のシートの見出しが不明)']}

    # ---- 束に分ける(app_wcs が無ければ全部入りの 1 個・ある時はアプリごと) ----
    def mkbundle(app, wcs, orders, ops, wk_):
        b = {'schema': SCHEMA, 'baseDate': base_date, 'generatedAt': generated_at,
             'source': {'fileName': os.path.basename(path), 'sheetRows': {nm: rc[nm] for nm in ('SAP_作業', 'SAP_製造指図')}},
             'checks': bundle_checks, 'wcMap': {}, 'orders': orders, 'ops': ops, 'history': {'weekly': wk_, 'usualDays': {}}}
        if app:
            b['app'] = app
            b['wcs'] = list(wcs)
        if inject:
            b.update(inject)
        return b

    def hrs(ops):
        return sum((o['std1'] or 0.0) + (o['std2'] or 0.0) * o['qty'] for o in ops if not o['done'])
    parts, other_ops, a1_probs, other_info = {}, [], [], None
    if app_wcs is None:
        parts['all'] = ((), orders_out, ops_out, weekly)
    else:
        owner = {}
        for app, wl in app_wcs.items():
            for w in wl:
                if w in owner:
                    a1_probs.append('作業区 %s が %s と %s の両方にある(設定の重なり)' % (w, owner[w], app))
                else:
                    owner[w] = app
        for app, wl in app_wcs.items():
            if rules.on('app_partition'):
                a_ops = [o for o in ops_out if owner.get(o['wc']) == app]
            else:
                a_ops = [o for o in ops_out if o['wc'] in owner]          # 規則を外した版: どのアプリの作業区の工程も全アプリに入れる
            if rules.on('app_orders_only'):
                have = {o['order'] for o in a_ops}
                a_ord = [o for o in orders_out if o['order'] in have]
            else:
                a_ord = list(orders_out)                                    # 規則を外した版: 工程の無い指図も入れる
            a_wk = [w for w in weekly if w['wc'] in wl] if rules.on('app_history') else list(weekly)
            parts[app] = (tuple(wl), a_ord, a_ops, a_wk)
        other_ops = [o for o in ops_out if o['wc'] not in owner]
        if not rules.on('other_counted'):
            other_ops = []                                                  # 規則を外した版: 属さない工程を黙って捨てる(件数を出さない)
        n_app = sum(len(v[2]) for v in parts.values())
        if n_app + len(other_ops) != len(ops_out):
            a1_probs.append('工程の数が合わない: アプリ分の合計 %d + どれにも属さない %d ≠ 全体 %d' % (n_app, len(other_ops), len(ops_out)))
        seen_k = {}
        for app, (wl, ords, a_ops, a_wk) in parts.items():
            for o in a_ops:
                k = (o['order'], o['act'])
                if k in seen_k and seen_k[k] != app:
                    a1_probs.append('工程が 2 つのアプリに入っている(%s と %s)' % (seen_k[k], app))
                    break
                seen_k[k] = app
            if any(o['wc'] not in wl for o in a_ops):
                a1_probs.append('%s の束に他のアプリの作業区の工程が混じっている' % app)
            if any(w['wc'] not in wl for w in a_wk):
                a1_probs.append('%s の束の history に他のアプリの作業区が混じっている' % app)
            have = {o['order'] for o in a_ops}
            if any(o['order'] not in have for o in ords):
                a1_probs.append('%s の束に、そのアプリの工程が 1 つも無い指図が入っている' % app)
        if sum(sum(1 for o in v[2] if not o['done']) for v in parts.values()) + sum(1 for o in other_ops if not o['done']) != len(open_ops):
            a1_probs.append('未完了の工程の数が、アプリ分+どれにも属さない分と全体で合わない')
        h_parts = sum(hrs(v[2]) for v in parts.values()) + hrs(other_ops)
        if abs(h_parts - hours) > 0.011 * max(1, len(open_ops)):
            a1_probs.append('時間の合計が、アプリ分+どれにも属さない分と全体で合わない(%.2f と %.2f)' % (h_parts, hours))
        a1_probs = sorted(set(a1_probs))
        checks.append(mk('A1', not a1_probs or 'A1' in rules.skip, len(a1_probs),
                         'アプリ別の分け方(重複 0・漏れは「どれにも属さない」に件数で出る・他アプリの作業区が混じらない・和が全体と一致): ' + ('全部合っている' if not a1_probs else ' / '.join(a1_probs))))
        other_info = {'ops': len(other_ops), 'openOps': sum(1 for o in other_ops if not o['done']), 'wcs': sorted({o['wc'] for o in other_ops}),
                      'orders': len({o['order'] for o in other_ops}),
                      'note': 'どのアプリの作業区にも無い工程。束にしない(件数だけ)。理由: 全体の大部分で 1 個が上限を超える・設計 C-3 のアプリ別の大きさは検査の作業区だけの前提'}
    bundles = {k: mkbundle(k if app_wcs is not None else None, v[0], v[1], v[2], v[3]) for k, v in parts.items()}
    bad_keys = sorted({k for b in bundles.values() for k in _all_keys(b) if any(f.lower() in k.lower() for f in FORBIDDEN_KEYS)})
    checks.append(mk(11, not bad_keys or 11 in rules.skip, len(bad_keys), '束の中に客先・仕入先・金額などの欄名が 0 か' + ('(0 だった)' if not bad_keys else ': 見つかった ' + ','.join(bad_keys))))
    bundle_checks['items'] = checks
    def size_of(bs_):
        return {k: len(json.dumps(b, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 40 for k, b in bs_.items()}
    c12 = mk(12, True, 0, '')
    checks.append(c12)                       # 検査の欄自身の大きさも束に入るので、先に入れてから測る
    for _ in range(2):
        sizes = size_of(bundles)
        over = [k for k, v in sizes.items() if v > max_bytes]
        c12.update(mk(12, not over or 12 in rules.skip, max(sizes.values()), '束の大きさ(各束が上限 %d バイト以内か): ' % max_bytes + ' / '.join('%s=%d' % x for x in sizes.items())))
    red2 = [c for c in checks if not c['ok']]
    base['dropped'] = bundle_checks['dropped']
    base['info'] = bundle_checks['info']
    if red2:
        return stop_record(base, '2 絞る', checks, ['検査%s: %s' % (c['id'], c['note']) for c in red2]), None, None
    datas = {k: json.dumps(b, ensure_ascii=False, separators=(',', ':')).encode('utf-8') for k, b in bundles.items()}
    rec = dict(base)
    rec.update({'status': 'ok', 'stoppedStage': None, 'reasons': [], 'checks': checks, 'bundleWritten': True,
                'orders': len(orders_out), 'ops': len(ops_out),
                'note': '検査①〜⑫が全部通った。⑧⑨⑩は ' + subst})
    if app_wcs is None:
        rec.update({'bundleSha256': hashlib.sha256(datas['all']).hexdigest(), 'bundleBytes': len(datas['all'])})
        return rec, bundles['all'], datas['all']
    rec['apps'] = {k: {'wcs': list(parts[k][0]), 'orders': len(parts[k][1]), 'ops': len(parts[k][2]), 'openOps': sum(1 for o in parts[k][2] if not o['done']),
                       'bytes': len(datas[k]), 'sha256': hashlib.sha256(datas[k]).hexdigest()} for k in parts}
    rec['other'] = other_info
    rec['note'] += '。アプリ別に分けた(束の大きさの検査は各束ごと)'
    return rec, bundles, datas


def _raw_date(x):
    """date_floor を外した版(試験用): 時刻が付いていれば付けたまま文字にする"""
    if x is None:
        return None
    d = iso_date(x)
    return d if x == int(x) else d + 'T%02d:%02d' % divmod(int(round((x - int(x)) * 1440)), 60)


def _empty_wc_open_hours(work, done_orders, rules, is_done):
    """作業区が空で束から外した未完了の行の時間(参照側には入っているので足して比べる)"""
    t = 0.0
    if not rules.on('drop_wc_empty'):
        return t
    for r in work:
        if r['wc'] == '' and r['order'] not in done_orders and not is_done(r):
            t += (r['std'][0][0] or 0.0) + (r['std'][1][0] or 0.0) * r['qty']
    return round(t, 2)


def _all_keys(x, out=None):
    out = [] if out is None else out
    if isinstance(x, dict):
        for k, v in x.items():
            out.append(str(k))
            _all_keys(v, out)
    elif isinstance(x, list):
        for v in x:
            _all_keys(v, out)
    return out


def write_outputs(out_dir, record, bundle_bytes, bundle_name='sap-feed.json', record_name='sap-feed-record.json'):
    """束は検査が全部通った時だけ書く(止まった時は前の束に触らない)。記録は毎回書く。同じ内容なら同じファイル(上書き・増えない)。
    bundle_bytes が dict(アプリ名 → バイト列)なら sap-feed-<アプリ名>.json を 1 つずつ書く"""
    os.makedirs(out_dir, exist_ok=True)
    items = {}
    if isinstance(bundle_bytes, dict):
        items = {'sap-feed-%s.json' % k: v for k, v in bundle_bytes.items()}
    elif bundle_bytes is not None:
        items = {bundle_name: bundle_bytes}
    for nm, data in items.items():
        tmp = os.path.join(out_dir, nm + '.tmp')
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, os.path.join(out_dir, nm))
    with open(os.path.join(out_dir, record_name), 'w', encoding='utf-8') as f:
        json.dump(record, f, ensure_ascii=False, indent=1, sort_keys=True)
