// 🧱 全画面マップと作業画面の「重なりの順番」を、**実コードを読んで**見張る。
//
// 【なぜ要るか】2026-08-30 に同じ日のうちに2度壊した。
//   ① 全画面マップが z-40 で、上のタブバー(z-50)に切替ボタンが隠れて押せなかった
//      → 清水さん「現場マップで切り替えが一番上のタブで隠れて全く見えない」
//   ② ①を直そうと z-[60] へ上げたら、今度は**作業画面(z-50)を覆った**
//      → 清水さん「時間軸レーンで型式カードを押しても作業用の画面が出てこない。
//        作業エリア拡大から戻ったら出てきた」
//   ⚠私は「作業画面の中に z-[300] が有るから作業画面の方が上」と思い込んでいた。**間違い**。
//     z-50 は積み重ねの入れ物(stacking context)を作るので、その中の z-[300] は
//     「作業画面の中での順番」でしかなく、外から見れば作業画面ごと 50 のまま。
//
// 【守らせる約束】
//   A. 全画面マップの z は、作業画面が開いている時は **作業画面より小さい**
//   B. 作業画面が閉じている時は **開いている時より大きい**(タブバーより上へ出るため)
//   C. 全画面マップを描く所で `execOpen` を渡している(渡し忘れると A が死ぬ)
//
// 🚨 この見張りは **src/App.jsx の現物** を読む。作り物は食わせない。
import fs from 'node:fs';

const SRC = new URL('../src/App.jsx', import.meta.url);
const code = fs.readFileSync(SRC, 'utf8');
const fails = [];
const notes = [];

// tailwind の z-50 / z-[60] の両方の書き方から数を取る
const zNum = (tok) => {
  const m = String(tok).match(/^z-\[(\d+)\]$/) || String(tok).match(/^z-(\d+)$/);
  return m ? Number(m[1]) : null;
};

// className の中身を取る。⚠2つの書き方が現物に在る。片方だけ読むと**空振りして黙って通る**。
//   ① className="fixed inset-0 z-50 …"        (ただの文字列)
//   ② className={`fixed inset-0 ${…} …`}      (テンプレート文字列)
const CLS_OF = (tag) => new RegExp(`data-fs="${tag}"\\s+className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`, 'g');
const clsAll = (src, tag) => [...src.matchAll(CLS_OF(tag))].map((m) => m[1] ?? m[2] ?? '');

// ── 1) 全画面マップ(MapOnlyView)の根っこ
const mapDecl = code.indexOf('const MapOnlyView = (');
if (mapDecl < 0) fails.push('MapOnlyView が見つからない(名前が変わった?)');
const mapRoot = code.slice(mapDecl, mapDecl + 900);
const mapClsList = clsAll(mapRoot, 'dashboard');
const mapCls = mapClsList.length ? [null, mapClsList[0]] : null;
if (!mapCls) fails.push('MapOnlyView の根っこの className が読めない');
let zOpen = null, zClosed = null;
if (mapCls) {
  // 期待する形: ${execOpen ? 'z-40' : 'z-[60]'}
  const cond = mapCls[1].match(/execOpen\s*\?\s*'(z-[^']+)'\s*:\s*'(z-[^']+)'/);
  if (!cond) {
    fails.push(`全画面マップの z が execOpen で変わっていない: 「${mapCls[1].trim().slice(0, 90)}」`);
  } else {
    zOpen = zNum(cond[1]); zClosed = zNum(cond[2]);
    notes.push(`全画面マップ: 作業画面が開いている時=${cond[1]}(${zOpen}) / 閉じている時=${cond[2]}(${zClosed})`);
  }
}

// ── 2) 作業画面(data-fs="execution")の根っこ。複数あるので **一番小さい z** を使う
//    (一番小さい物が覆われたら、その画面は隠れるため)
const execZs = [];
for (const cls of clsAll(code, 'execution')) {
  for (const tok of cls.split(/\s+/)) { const n = zNum(tok); if (n != null) execZs.push(n); }
}
if (!execZs.length) fails.push('data-fs="execution" の根っこの z が1つも読めない');
const execMin = execZs.length ? Math.min(...execZs) : null;
notes.push(`作業画面の z: ${execZs.sort((a, b) => a - b).join(' / ')} → 一番小さいのは ${execMin}`);

// ── 3) 約束A: 作業画面が開いている間、マップは作業画面より下
if (zOpen != null && execMin != null && !(zOpen < execMin)) {
  fails.push(`約束A 違反: 作業画面が開いている時のマップ z=${zOpen} が、作業画面 z=${execMin} より下にない。`
    + '\n    → 型式カードを押しても作業画面がマップの下に隠れる(2026-08-30 の壊れ方そのもの)。');
}
// ── 4) 約束B: 閉じている時は上げる(タブバーより上へ出す)
if (zOpen != null && zClosed != null && !(zClosed > zOpen)) {
  fails.push(`約束B 違反: 作業画面が閉じている時のマップ z=${zClosed} が、開いている時 z=${zOpen} より上にない。`
    + '\n    → 上のタブバーに切替ボタンが隠れて押せなくなる(2026-08-30 の1つ目の壊れ方)。');
}
// ── 5) 約束C: 描く所で execOpen を渡している
if (!/<MapOnlyView[\s\S]{0,2000}?execOpen=\{/.test(code)) {
  fails.push('約束C 違反: <MapOnlyView … /> に execOpen を渡していない(渡し忘れると既定 false のまま上に居座る)');
}

// ── 6) 型式カードに data-lot-id が付いているか
//    (どの台の札かが分からないと、押した時の動きを機械で確かめられない)
const cardMarks = (code.match(/data-lot-id=\{lot\.id\}/g) || []).length;
notes.push(`型式カードの印 data-lot-id: 本体 ${cardMarks}か所`);
if (cardMarks < 3) fails.push(`型式カードの data-lot-id が ${cardMarks}か所しかない(LotCard の見た目の種類ぶん必要)`);
for (const f of ['MapViewLanes', 'MapViewTimeline']) {
  const p = new URL(`../src/mapviews/${f}.jsx`, import.meta.url);
  if (!fs.existsSync(p)) { notes.push(`${f}.jsx は無い(見送り)`); continue; }
  const n = (fs.readFileSync(p, 'utf8').match(/data-lot-id=\{lot\.id\}/g) || []).length;
  notes.push(`型式カードの印 data-lot-id: ${f} ${n}か所`);
  if (n < 1) fails.push(`${f}.jsx の型式カードに data-lot-id が無い`);
}

console.log('🧱 全画面マップと作業画面の重なりの順番');
for (const n of notes) console.log('   ・' + n);
if (fails.length) {
  console.error('\n❌ 不合格 ' + fails.length + '件');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✅ 合格: 作業画面が開いている間はマップが下、閉じている時は上。印も付いている。');
