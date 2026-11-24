// 試験用: 標準入力の JSON([[作業テキスト, 作業区], ...])を、アプリ本体の readWorkName(src/domain/sapProgress.js)で分類して JSON で返す。
// 呼ぶ人: scripts/sap_feed/selftest_sap_feed.py(Python の classify_work が全工程で同じ答えを返すかの試験)
// 触る外の物: なし(標準入出力だけ・src は読むだけ)
import { readWorkName } from '../../src/domain/sapProgress.js';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
    const pairs = JSON.parse(buf);
    process.stdout.write(JSON.stringify(pairs.map(([t, c]) => readWorkName(t, c))));
});
