#!/usr/bin/env python3
"""SAP 工程の仕分けの登録 sap-sort/1 に集約した前後で、Python 側(feed.py)の結果が 1 つも変わらない事を数字で確かめる試験。
目的: 切り替え前(凍結した classify_work と 旧 machine_rules・app_wcs の表=fixtures/)と、切り替え後(sap_sort.py が登録を読む)に、同じ合成データを通して差 0 を見る。
入力: 合成データ(scripts/sap_synth・本物の SAP データは使わない)・登録 src/domain/sap_sort.default.json
出力: OK/NG の一覧と終了値(0=全部 OK)。見張りが効く証明(登録を 1 か所変えると赤)も入れている
触る外の物: 一時フォルダの書き込みだけ(ネットワーク・Firebase に触れない・AI を使わない)
確かめ方: npm run sap-feed:test(selftest_sap_feed.py の後に流れる)/ python -I -X utf8 scripts/sap_feed/selftest_sap_sort.py
"""
import copy
import datetime
import hashlib
import json
import os
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'sap_synth'))
sys.path.insert(0, os.path.join(HERE, 'fixtures'))
import feed   # noqa: E402
import classify_work_before as old_cw   # noqa: E402
from sap_sort import DEFAULT_PATH, app_wcs_of, classify_op, code_default, load_sap_sort, machine_kinds_of, validate_sap_sort   # noqa: E402
from make_synth_xlsx import build   # noqa: E402
from xlsx_min import write_xlsx   # noqa: E402

FX = os.path.join(HERE, 'fixtures')
OLD_MR = json.load(open(os.path.join(FX, 'machine_rules.before.json'), encoding='utf-8'))
OLD_APPS = json.load(open(os.path.join(FX, 'app_wcs.before.json'), encoding='utf-8'))['apps']
REG = json.load(open(DEFAULT_PATH, encoding='utf-8'))
BASE = datetime.date(2026, 11, 22)
WC = 2     # SAP_作業 の作業区の列(selftest_sap_feed.py の WC と同じ)
TMP = tempfile.TemporaryDirectory()
FAILS = []


def check(name, ok, detail=''):
    print('%s  %s%s' % ('OK' if ok else 'NG', name, ('  ' + detail) if detail and not ok else ''))
    if not ok:
        FAILS.append(name)


TEXTS = ['', '2385:平面研削', '旋盤', 'ﾌﾗｲｽ加工', '仕様変更:旋盤', '仕様変更', '付帯作業', '付帯作業:一時置き', '応援', '現合', '洗浄', '検査前洗浄', '歯切り', '全角：コロン', '  ２３８５：円筒研削 ',
         '横M/C', '門M/C', '立旋盤', '2330:仕様変更', '作業 2381-0010', '三次元検査', '2509:何か', '付帯作業一時置き：三次元検査', '仕様変更:平面研削', '仕様変更:ﾌﾗｲｽ', '旋盤 平面研削', '立旋盤:NC', '付帯作業:洗浄']
CODES = [str(c) for c in range(2300, 2401)] + ['B05', '', 'abc', '2509', '2519', '2330', ' 2381 ', '2381.0', '0', 'NaN', '2309', '2526', None]


def synth(seed, n, quirks):
    sheets, _t = build(seed, BASE, n, ('2309', '2526', '2509', '2519'), quirks)
    return sheets


def feed_bytes(sheets, name, old, reg=None):
    """旧の表(凍結した classify_work)で作った束 か 登録で作った束 のバイト列を返す"""
    os.makedirs(os.path.join(TMP.name, name), exist_ok=True)
    p = os.path.join(TMP.name, name, '操業データ_same.xlsx')   # 束に入るファイル名を同じにする(別の場所に置いた同じ名前のファイル)
    write_xlsx(p, sheets)
    if old:
        save = (feed.classify_work, feed.machine_kinds_of)
        feed.classify_work = lambda t, c, mr, same=True: old_cw.classify_work(t, c, mr, same)
        feed.machine_kinds_of = lambda mr: mr['machine_kinds']
        try:
            return feed.run_feed(p, app_wcs=OLD_APPS, sap_sort=OLD_MR)
        finally:
            feed.classify_work, feed.machine_kinds_of = save
    reg = reg or REG
    return feed.run_feed(p, app_wcs=app_wcs_of(reg), sap_sort=reg)


def main():
    print('== 1. 分類: 登録で作った答えと、切り替え前(凍結)の答えが 差 0 ==')
    sets = [(1, 300, []), (2, 300, 'D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D15 D16 D17'.split()), (3, 120, 'D1 D5 D9'.split())]
    pairs = [(t, c) for t in TEXTS for c in CODES]
    ns = 0
    for seed, n, q in sets:
        for r in dict(synth(seed, n, q))['SAP_作業'][1:]:
            pairs.append((r[3], r[WC]))
            ns += 1
    uniq = list(dict.fromkeys((str(t or ''), str(c or '')) for t, c in pairs))
    diff = [p for p in uniq if old_cw.classify_work(p[0], p[1], OLD_MR) != {k: classify_op(p[0], p[1], REG)[k] for k in ('name', 'kind')}]
    check('分類: 切り替え前と切り替え後の name・kind が %d 通り(うち合成データの工程 %d 行)で差 0' % (len(uniq), ns), not diff, str(diff[:3]))
    diff2 = [p for p in uniq if old_cw.classify_work(p[0], p[1], OLD_MR, False) != {k: classify_op(p[0], p[1], REG, False)[k] for k in ('name', 'kind')}]
    check('分類(作業区の範囲を使わない試験用の版)も差 0', not diff2, str(diff2[:3]))
    check('kind が 4 つ(machine・wash・misc・inspect)全部を通っている', {classify_op(t, c, REG)['kind'] for t, c in pairs} == {'machine', 'wash', 'misc', 'inspect'})

    print('\n== 2. 束: 旧の表で作った束と、登録で作った束が 1 バイトも違わない ==')
    for seed, n, q in sets:
        sh = synth(seed, n, q)
        ra, rb = feed_bytes(sh, 'old%d' % seed, True), feed_bytes(sh, 'new%d' % seed, False)
        def sha(x):
            return hashlib.sha256(b''.join(x[k] for k in sorted(x))).hexdigest()[:12] if x else '-'
        nb = lambda x: sum(len(v) for v in x.values()) if x else 0   # noqa: E731
        ok = ra[0]['status'] == rb[0]['status'] == 'ok' and ra[2] is not None and ra[2] == rb[2]
        m = ra[0]['apps']['machine'] if ra[0].get('apps') else {}
        check('指図%d・癖%s: 束(全ファイル %d 個)のバイト列が同じ(sha %s・%s バイト・machine 工程 %s・グループ別 %s)' % (n, 'あり' if q else 'なし', len(rb[2] or {}), sha(rb[2]), nb(rb[2]), m.get('ops'), {k: v['ops'] for k, v in m.get('byName', {}).items()}),
              ok, '%s %s' % (ra[0]['status'], rb[0]['status']))

    print('\n== 3. 表の写し: アプリ別の作業区・束に入れる kind・既定のコード・並び順 ==')
    check('登録から作ったアプリ別の作業区 = 旧 app_wcs.json', app_wcs_of(REG) == OLD_APPS)
    check('登録から作った kind の一覧 = 旧 machine_rules.json の machine_kinds', machine_kinds_of(REG) == OLD_MR['machine_kinds'])
    j = {k: v for k, v in REG.items() if k != '_about'}
    check('コードの既定(code_default)= 同梱の登録', code_default() == j)
    check('同梱の登録は形の検査を通る', validate_sap_sort(REG) == [])

    print('\n== 4. 安全策: 登録が無い・壊れている・知らない版・重なり → 今と同じ分け方 ==')
    ov = copy.deepcopy(REG)
    ov['commanders'][1]['groups'][0]['wcRanges'] = [[2313, 2325]]
    cases = {'ファイルが無い': None, 'JSON が壊れている': '{broken', '知らない版': json.dumps({'schema': 'sap-sort/9'}), '作業区の範囲が重なる': json.dumps(ov), '司令塔が空': json.dumps({'schema': 'sap-sort/1', 'commanders': []})}
    for nm, body in cases.items():
        p = os.path.join(TMP.name, 'bad.json')
        if body is None:
            p = os.path.join(TMP.name, 'nothing.json')
        else:
            open(p, 'w', encoding='utf-8').write(body)
        reg, used_default, why = load_sap_sort(p)
        same = all(classify_op(t, c, reg) == classify_op(t, c, REG) for t, c in pairs[:3000])
        check('%s → 同梱の既定で動き(理由 %d 件)・答えは今と同じ' % (nm, len(why)), used_default and bool(why) and same)
    reg, used_default, why = load_sap_sort(None)
    check('パスを渡さない時は同梱の既定(理由なし)', not used_default and not why and reg == REG)
    check('正しい登録を渡すとそれを使う', load_sap_sort(DEFAULT_PATH)[1] is False)

    print('\n== 5. 見張りが効く: 登録を 1 か所だけ変えると、切り替え前との比べが赤になる ==')
    mut = copy.deepcopy(REG)
    mut['commanders'][1]['groups'][5]['wcRanges'] = [[2381, 2388]]   # 平面研削の範囲を 1 つ短く
    d = [p for p in uniq if old_cw.classify_work(p[0], p[1], OLD_MR) != {k: classify_op(p[0], p[1], mut)[k] for k in ('name', 'kind')}]
    check('わざと 2389 を外すと 差が %d 通り出る(比べが何かを見ている)' % len(d), len(d) > 0)
    mut2 = copy.deepcopy(REG)
    mut2['commanders'][1]['groups'][0]['name'] = '旋盤X'   # 旋盤の名前を変える(合成データに旋盤の工程がある)
    sh = synth(1, 300, [])
    rb = feed_bytes(sh, 'mutbase', True)
    rm = feed_bytes(sh, 'mutnew', False, mut2)
    check('旋盤の名前を 1 つ変えると、束のバイト列が旧と一致しなくなる(束の比べも何かを見ている)', rb[2] is not None and rm[2] is not None and rb[2] != rm[2])

    print('\n%s: NG %d 件%s' % ('全部 OK' if not FAILS else '赤あり', len(FAILS), (' → ' + ' / '.join(FAILS)) if FAILS else ''))
    TMP.cleanup()
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
