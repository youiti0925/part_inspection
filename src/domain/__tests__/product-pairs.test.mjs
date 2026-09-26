// 🧷 製品検査から **1バイトも変えずに** 写した純関数の「md5の対」(部品検査・2026-09-26)。
// -----------------------------------------------------------------------------
//  決まり: 純関数は製品検査(C:\Users\anrw3\product-inspection-app)から **そのまま** 写す。
//          画面(App.jsx)の側を部品に合わせる。純関数の中身を部品だけで直すと、片方だけ古くなる。
//  ここは、写した物の中身が製品の写した時点と同じか(改行を LF に揃えた md5)を見張る。
//  ⚠ 赤になったら: 部品側で純関数を直した → 製品側でも直して両方を同じにし、この表の md5 を両方で揃える。
//                   製品側が直った → 製品の新しい物を写し直し、この表の md5 を更新する(画面側の呼び方も確かめる)。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

const md5Lf = (p) => crypto.createHash('md5')
  .update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');

// { file: 部品の src/ からの道, product: 製品の写し元, md5: LF に揃えた md5 }
const PAIRS = [
  { file: 'domain/batchLiveTime.js', product: 'product-inspection-app/src/domain/batchLiveTime.js', md5: '2aec8b81656561a403b6ebd8d9cbef94' },
  { file: 'domain/workExecution.js', product: 'product-inspection-app/src/domain/workExecution.js', md5: 'eecf1fc35e7711da656012987b76387e' },
  // juggleGuide.js: 製品 ea16d6a で 2分の決まり(MIN_TRIP_WORK_MIN)を lotPair.js から移し、import 無しにしてから写した
  { file: 'domain/juggleGuide.js', product: 'product-inspection-app/src/domain/juggleGuide.js', md5: '8429300b801f9ed5fd663f18e874fbe8' },
  { file: 'domain/skipKeepingRecord.js', product: 'product-inspection-app/src/domain/skipKeepingRecord.js', md5: 'f80de283e4253445aede8de510a04506' },
  { file: 'domain/seqScreen.js', product: 'product-inspection-app/src/domain/seqScreen.js', md5: '6934e5bdb509b3f41dcd24e395a8ef14' },
  { file: 'domain/lotStartGuard.js', product: 'product-inspection-app/src/domain/lotStartGuard.js', md5: '2b9f3cd0a88768187d443ab3cd6439ee' },
];

for (const p of PAIRS) {
  test(`PAIR ${p.file} は製品(${p.product})と同じ中身`, () => {
    assert.equal(md5Lf(path.join(SRC, p.file)), p.md5,
      `${p.file} の中身が製品の写しから変わった(部品だけで直さない。製品と揃えて md5 を更新する)`);
  });
}

// 製品の checkout が隣にある時だけ、今の製品とも比べる(CI には無いので飛ばす)。
const PRODUCT_ROOT = path.resolve(SRC, '..', '..', 'product-inspection-app');
test('PAIR 隣の製品検査の今の中身とも同じ(製品が手元にある時だけ)', { skip: !fs.existsSync(PRODUCT_ROOT) && '製品検査の checkout が無い' }, () => {
  const drift = PAIRS.filter(p => {
    const pp = path.resolve(SRC, '..', '..', p.product);
    return fs.existsSync(pp) && md5Lf(pp) !== md5Lf(path.join(SRC, p.file));
  }).map(p => p.file);
  assert.deepEqual(drift, [], `製品側が先に直っている: ${drift.join(', ')} (写し直して md5 を更新する)`);
});
