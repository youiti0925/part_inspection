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
    a = ap.parse_args(argv)
    prev = load_json(a.prev_record) if a.prev_record and os.path.exists(a.prev_record) else None
    ref = truth_to_reference(load_json(a.truth)) if a.truth else None
    rec, _bundle, data = run_feed(a.xlsx, prev_record=prev, reference=ref)
    write_outputs(a.out_dir, rec, data)
    print('結果: %s' % rec['status'])
    if rec['status'] == 'stopped':
        print('止まった段: %s' % rec['stoppedStage'])
        for r in rec['reasons']:
            print('  - ' + r)
        return 1
    if rec['status'] == 'ok':
        print('束: 指図 %d・工程 %d・%d バイト' % (rec['orders'], rec['ops'], rec['bundleBytes']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
