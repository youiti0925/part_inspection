#!/usr/bin/env python3
"""操業データ xlsx → 束 sap-feed/1(JSON)+記録。検査が全部通った時だけ束を書く。
目的: 会社の PC で RPA の続きに動かす入口(設計 F-2 の 2 の答え待ち・今は家で合成データだけ)
入力: --xlsx 操業データ.xlsx  --out-dir 出力フォルダ  [--prev-record 前回の記録.json]  [--truth 合成の .truth.json]
出力: out-dir/sap-feed.json(通った時だけ)と sap-feed-record.json(毎回)。終了コード 0=束を出した/変わらず・1=止まった
触る外の物: 入力の読み取りと out-dir への書き込みだけ(ネットワーク無し・AI 無し)
確かめ方: npm run sap-feed:test
"""
import argparse
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from feed import run_feed, write_outputs   # noqa: E402
from sap_sort import app_wcs_of, load_sap_sort   # noqa: E402


def load_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def truth_to_reference(t):
    by = {k: v for k, v in t['openOpsByWc'].items()}
    return {'openOps': t['openOpsOfOpenOrders'], 'openHours': t['openHours(標準値1+標準値2×数量)'], 'byWc': by}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--xlsx', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--prev-record')
    ap.add_argument('--truth')
    ap.add_argument('--sap-sort', help='SAP 工程の仕分けの登録 sap-sort/1 の JSON(省略 = アプリが同梱している src/domain/sap_sort.default.json・無い/壊れている時は今と同じ分け方で動く)')
    ap.add_argument('--no-machine', action='store_true', help='束 machine を出さない')
    ap.add_argument('--single', action='store_true', help='アプリ別に分けず全部入りの 1 個(大きいので上限を超えやすい・試験用)')
    a = ap.parse_args(argv)
    prev = load_json(a.prev_record) if a.prev_record and os.path.exists(a.prev_record) else None
    ref = truth_to_reference(load_json(a.truth)) if a.truth else None
    reg, used_default, why = load_sap_sort(a.sap_sort)
    if why:
        print('登録の注意: %s(%s)' % ('同梱の既定で動く' if used_default else '読めた', ' / '.join(why)))
    app = None if a.single else app_wcs_of(reg)
    mr = None if (a.single or a.no_machine) else reg
    rec, _bundle, data = run_feed(a.xlsx, prev_record=prev, reference=ref, app_wcs=app, sap_sort=mr)
    write_outputs(a.out_dir, rec, data)
    print('結果: %s' % rec['status'])
    if rec['status'] == 'stopped':
        print('止まった段: %s' % rec['stoppedStage'])
        for r in rec['reasons']:
            print('  - ' + r)
        return 1
    if rec['status'] == 'ok':
        if 'apps' in rec:
            for k, v in rec['apps'].items():
                print('束 %s: 作業区 %d 種類・指図 %d・工程 %d(未完了 %d)・%d バイト%s' % (k, len(v['wcs']), v['orders'], v['ops'], v['openOps'], v['bytes'], ('・%d 冊' % len(v['parts'])) if 'parts' in v else ''))
            o = rec['other']
            print('どのアプリにも属さない(束にしない): 工程 %d(未完了 %d)・作業区 %d 種類' % (o['ops'], o['openOps'], len(o['wcs'])))
        else:
            print('束: 指図 %d・工程 %d・%d バイト' % (rec['orders'], rec['ops'], rec['bundleBytes']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
