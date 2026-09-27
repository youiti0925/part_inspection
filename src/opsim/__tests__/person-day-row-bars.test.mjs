// 🧑‍🏭 2026-09-18 夕 清水さん「これ見づらいよ、前の方が見やすい、指図毎で開始と終了の棒が順番に並んでるやつ、作業者毎にね」
//   「人ごとの指示」は 1人＝横いっぱいの段、指図ごとの行に その日の時間軸の棒。3列の札(行ごとの棒なし)へ戻さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'PersonDay.jsx'), 'utf8').replace(/\r\n/g, '\n');

test('PR-1 人は縦に積む(3列の札にしない)', () => {
  assert.ok(SRC.includes('data-person-day-layout="rows"'), '人の段が縦積みになっていない');
  assert.ok(!/grid-cols-1 gap-3 p-3 lg:grid-cols-3/.test(SRC), '3列の札に戻っている(1行が狭く、行ごとの棒が置けない)');
});

test('PR-2 仕事の行ごとに その日の時間軸の棒(開始〜終了)。空きの行にも同じ軸の棒', () => {
  assert.ok(/<Axis winStartMs=\{day\.winStartMs\} winEndMs=\{day\.winEndMs\} breaks=\{breaks\} data-person-row-bar=\{it\.lotId\}/.test(SRC), '仕事の行に棒が無い');
  assert.ok(/it\.segs\.map\(\(\[s, ee\], j\) => \(\s*<div key=\{j\} className=\{`opsim-move absolute top-0 bottom-0 rounded-full \$\{TIER_BAR\[it\.tier\]\}`\}/.test(SRC), '棒が 手が付いている区間(segs)・納期との関係の色 で描かれていない');
  assert.ok(SRC.includes('data-person-gap-bar='), '空きの行に棒が無い');
});

test('PR-3 列の幅は固定(どの行の棒も同じ時間軸に揃う)。上の帯の寄せ幅は 列の幅の足し算と一致', () => {
  const cols = SRC.match(/const PD_ROW_COLS = 'lg:grid-cols-\[([0-9.]+)rem_([0-9.]+)rem_1fr_([0-9.]+)rem\]';/);
  assert.ok(cols, '列の幅が固定されていない(auto にすると 納期の字の長さで棒の位置が行ごとにずれる)');
  const inset = SRC.match(/const PD_BAND_INSET = 'lg:pl-\[([0-9.]+)rem\] lg:pr-\[([0-9.]+)rem\]';/);
  assert.ok(inset, '上の帯の寄せ幅が無い');
  const [n, t, d] = [Number(cols[1]), Number(cols[2]), Number(cols[3])];
  assert.equal(Number(inset[1]), 0.75 + n + 0.5 + t + 0.5, '帯の左の寄せが 行の列の幅と合っていない');
  assert.equal(Number(inset[2]), 0.5 + d + 0.75, '帯の右の寄せが 行の列の幅と合っていない');
  assert.ok(!/\d+px/.test(SRC.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'px を直書きしている');
});
