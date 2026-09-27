// 🖍 焼き込みの計算。⚠ここがズレると「隠したはずの顔が出る」「テロップが画面外」。
// ブラウザが無いので、**呼ばれた命令を記録するニセの ctx** で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapText, rectPx, drawOverlays, drawMosaic, drawSpot, drawTelop, paintFrame,
  TEXT_COLORS, TEXT_SIZES, MOSAIC_CELLS,
} from '../videoOverlay.js';

/** 1文字=10px として測るニセの ctx。命令を全部記録する。 */
const fakeCtx = (w = 800, h = 450) => {
  const log = [];
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
    imageSmoothingEnabled: true, globalAlpha: 1,
    log,
    save: () => log.push(['save']),
    restore: () => log.push(['restore']),
    translate: (x, y) => log.push(['translate', x, y]),
    rotate: (a) => log.push(['rotate', a]),
    scale: (x, y) => log.push(['scale', x, y]),
    beginPath: () => log.push(['beginPath']),
    moveTo: (...a) => log.push(['moveTo', ...a]),
    lineTo: (...a) => log.push(['lineTo', ...a]),
    closePath: () => log.push(['closePath']),
    stroke: () => log.push(['stroke']),
    fill: () => log.push(['fill']),
    ellipse: (...a) => log.push(['ellipse', ...a]),
    fillRect: (...a) => log.push(['fillRect', ...a, ctx.fillStyle]),
    strokeRect: (...a) => log.push(['strokeRect', ...a]),
    fillText: (...a) => log.push(['fillText', ...a]),
    drawImage: (...a) => log.push(['drawImage', ...a]),
    measureText: (s) => ({ width: [...String(s)].length * 10 }),
  };
  return ctx;
};
const calls = (ctx, name) => ctx.log.filter(l => l[0] === name);
const scratch = () => (sw, sh) => ({ width: sw, height: sh, getContext: () => fakeCtx(sw, sh) });

test('V01 日本語の折り返し: 空白が無くても割れる', () => {
  const m = (s) => [...s].length * 10;
  assert.deepEqual(wrapText('あいうえおかきくけこ', 50, m), ['あいうえお', 'かきくけこ']);
  assert.deepEqual(wrapText('', 100, m), []);
  assert.deepEqual(wrapText('あ\nい', 100, m), ['あ', 'い'], '改行はそのまま');
});

test('V02 ⚠1文字が枠より広くても無限ループしない', () => {
  const m = (s) => [...s].length * 100;
  const out = wrapText('あいう', 10, m);
  assert.deepEqual(out, ['あ', 'い', 'う']);
});

test('V03 四角の px 変換: 絵の外へはみ出さない・つぶれない', () => {
  assert.deepEqual(rectPx({ x: 0, y: 0, w: 1, h: 1 }, 800, 450), { x: 0, y: 0, w: 800, h: 450 });
  const r = rectPx({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 800, 450);
  assert.ok(r.x + r.w <= 800 && r.y + r.h <= 450, `はみ出し ${JSON.stringify(r)}`);
  const tiny = rectPx({ x: 0.5, y: 0.5, w: 0, h: 0 }, 800, 450);
  assert.ok(tiny.w >= 2 && tiny.h >= 2, '0にしない');
  assert.deepEqual(rectPx(null, 800, 450), { x: 0, y: 0, w: 2, h: 2 });
});

test('V04 テロップ: 帯を描いて文字を書く。⚠帯も文字も絵の中に収まる', () => {
  const ctx = fakeCtx(800, 450);
  assert.equal(drawTelop(ctx, 800, 450, { text: 'ここをよく見る', pos: 'bottom' }), true);
  const rects = calls(ctx, 'fillRect');
  assert.equal(rects.length, 1, '帯は1枚');
  const [, bx, by, bw, bh] = rects[0];
  assert.ok(bx >= 0 && bx + bw <= 800, `横がはみ出し ${bx}+${bw}`);
  assert.ok(by >= 0 && by + bh <= 450, `縦がはみ出し ${by}+${bh}`);
  const texts = calls(ctx, 'fillText');
  assert.equal(texts.length, 1);
  assert.ok(texts[0][3] >= by && texts[0][3] <= by + bh + 5, `文字が帯の中 y=${texts[0][3]} 帯=${by}..${by + bh}`);
});

test('V05 ⚠長い文でも画面からはみ出さない(折り返して最大4行)', () => {
  const ctx = fakeCtx(800, 450);
  drawTelop(ctx, 800, 450, { text: 'あ'.repeat(300), pos: 'bottom' });
  const texts = calls(ctx, 'fillText');
  assert.ok(texts.length <= 4, `行数 ${texts.length}`);
  const [, bx, by, bw, bh] = calls(ctx, 'fillRect')[0];
  assert.ok(bx >= 0 && bx + bw <= 800 && by >= 0 && by + bh <= 450);
  for (const t of texts) assert.ok(t[2] >= 0, `左にはみ出さない x=${t[2]}`);
});

test('V06 テロップの場所(上・中・下)で位置が変わる', () => {
  const y = (pos) => {
    const ctx = fakeCtx(800, 450);
    drawTelop(ctx, 800, 450, { text: 'あい', pos });
    return calls(ctx, 'fillRect')[0][2];
  };
  assert.ok(y('top') < y('center'));
  assert.ok(y('center') < y('bottom'));
});

test('V07 テロップ: 空文字は何も描かない', () => {
  const ctx = fakeCtx();
  assert.equal(drawTelop(ctx, 800, 450, { text: '   ' }), false);
  assert.equal(ctx.log.filter(l => l[0] === 'fillRect').length, 0);
  assert.equal(drawTelop(ctx, 800, 450, {}), false);
});

test('V08 テロップの色は選べる。知らない色は白に落ちる', () => {
  const ctx = fakeCtx();
  drawTelop(ctx, 800, 450, { text: 'あ', color: 'red' });
  assert.equal(calls(ctx, 'fillRect')[0][5], TEXT_COLORS.red.bg);
  const c2 = fakeCtx();
  drawTelop(c2, 800, 450, { text: 'あ', color: 'ばななジュース' });
  assert.equal(calls(c2, 'fillRect')[0][5], TEXT_COLORS.white.bg);
});

test('V09 テロップの大きさが段で変わる(小さい画面でも読める)', () => {
  const size = (s) => {
    const ctx = fakeCtx(800, 450);
    drawTelop(ctx, 800, 450, { text: 'あ', size: s });
    return Number((ctx.font.match(/(\d+)px/) || [])[1]);
  };
  assert.ok(size('s') < size('m'));
  assert.ok(size('m') < size('l'));
  assert.ok(size('m') >= Math.round(450 * TEXT_SIZES.m) - 1);
});

test('V10 🔦スポットライト: 周り4枚を暗くして、枠を描く', () => {
  const ctx = fakeCtx(800, 450);
  drawSpot(ctx, 800, 450, { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, dim: 0.6 });
  const rects = calls(ctx, 'fillRect');
  assert.equal(rects.length, 4, '上下左右');
  // 中の穴は塗られていない。⚠決め打ちの数字で判定しない(丸めで偽の不合格が出る)
  const hole = rectPx({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 800, 450);
  for (const [, x, y, w, h] of rects) {
    const overlapsHole = x < hole.x + hole.w && x + w > hole.x && y < hole.y + hole.h && y + h > hole.y;
    assert.equal(overlapsHole, false, `穴を塗っている ${x},${y},${w},${h} / 穴=${JSON.stringify(hole)}`);
  }
  assert.equal(calls(ctx, 'strokeRect').length, 1);
});

test('V11 ⚠スポットの暗さは効きすぎない(真っ暗で何も見えない事故)', () => {
  const ctx = fakeCtx();
  drawSpot(ctx, 800, 450, { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, dim: 5 });
  const s = calls(ctx, 'fillRect')[0][5];
  const a = Number(s.match(/,([\d.]+)\)$/)[1]);
  assert.ok(a <= 0.92 && a >= 0.15, `暗さ ${a}`);
});

test('V12 ▩モザイク: 小さく写して引き伸ばす。なめらかを切って戻す', () => {
  const ctx = fakeCtx(800, 450);
  assert.equal(drawMosaic(ctx, 800, 450, { rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, cell: 'm' }, { scratch: scratch() }), true);
  const d = calls(ctx, 'drawImage');
  assert.equal(d.length, 1, '引き伸ばして戻すのが1回');
  assert.equal(ctx.imageSmoothingEnabled, true, '⚠切りっぱなしにしない(次の絵がガタガタになる)');
});

test('V13 ⚠モザイクの下書きが用意できない環境では、何もしない(絵を壊さない)', () => {
  const ctx = fakeCtx();
  assert.equal(drawMosaic(ctx, 800, 450, { rect: { x: 0, y: 0, w: 1, h: 1 } }, {}), false);
  assert.equal(ctx.log.length, 0);
  assert.equal(drawMosaic(ctx, 800, 450, { rect: {} }, { scratch: () => null }), false);
});

test('V14 モザイクの目の粗さが段で変わる', () => {
  const cells = (c) => {
    const ctx = fakeCtx(800, 450);
    let got = null;
    drawMosaic(ctx, 800, 450, { rect: { x: 0, y: 0, w: 1, h: 1 }, cell: c }, { scratch: (sw, sh) => { got = [sw, sh]; return { getContext: () => fakeCtx() }; } });
    return got[0];
  };
  assert.ok(cells('s') > cells('m'), '細かい目のほうが分割数が多い');
  assert.ok(cells('m') > cells('l'));
  assert.ok(MOSAIC_CELLS.s < MOSAIC_CELLS.l);
});

test('V15 ⚠描く順: モザイク → スポット → 〇 → テロップ', () => {
  const ctx = fakeCtx(800, 450);
  const order = [];
  const ov = [
    { kind: 'text', text: 'あ' },
    { kind: 'mark', mark: { x: 0.5, y: 0.5, rx: 0.1, ry: 0.1 } },
    { kind: 'spot', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { kind: 'mosaic', rect: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } },
  ];
  drawOverlays(ctx, 800, 450, ov, {
    scratch: (sw, sh) => { order.push('mosaic'); return { getContext: () => fakeCtx(sw, sh) }; },
  });
  // 記録から順番を復元: drawImage(モザイク) → strokeRect(スポット) → ellipse(印) → fillText(テロップ)
  const idx = (name) => ctx.log.findIndex(l => l[0] === name);
  assert.ok(idx('drawImage') >= 0 && idx('strokeRect') > idx('drawImage'), 'モザイクの後にスポット');
  assert.ok(idx('ellipse') > idx('strokeRect'), 'スポットの後に印');
  assert.ok(idx('fillText') > idx('ellipse'), '印の後にテロップ');
  assert.equal(order.length, 1);
});

test('V16 知らない種類の重ねは黙って飛ばす(落とさない)', () => {
  const ctx = fakeCtx();
  drawOverlays(ctx, 800, 450, [{ kind: 'ばなな' }, null, { kind: 'text', text: 'あ' }], {});
  assert.equal(calls(ctx, 'fillText').length, 1);
});

test('V17 paintFrame: 素のまま = 絵が枠いっぱい(黒帯なし)', () => {
  const ctx = fakeCtx(800, 450);
  const box = paintFrame(ctx, 800, 450, {}, 1600, 900, {});
  assert.deepEqual([box.dx, box.dy, box.dw, box.dh], [0, 0, 800, 450]);
  const d = calls(ctx, 'drawImage')[0];
  assert.deepEqual(d.slice(2, 6), [0, 0, 1600, 900], '元の全面を使う');
});

test('V18 ⚠4:3の絵を16:9の枠に入れると左右に黒帯(印の座標はこの範囲に合わせる)', () => {
  const ctx = fakeCtx(800, 450);
  const box = paintFrame(ctx, 800, 450, {}, 640, 480, {});
  assert.equal(box.dh, 450);
  assert.ok(Math.abs(box.dw - 600) <= 1, `幅 ${box.dw}`);
  assert.ok(Math.abs(box.dx - 100) <= 1, `左 ${box.dx}`);
});

test('V19 回転90°で縦横が入れ替わる', () => {
  const ctx = fakeCtx(450, 800);
  const box = paintFrame(ctx, 450, 800, {}, 1600, 900, { rotate: 90 });
  assert.ok(calls(ctx, 'rotate').length === 1);
  assert.ok(box.dh > box.dw, `縦長になるはず ${box.dw}x${box.dh}`);
});

test('V20 切り抜き: 元の一部だけを使う', () => {
  const ctx = fakeCtx(800, 450);
  paintFrame(ctx, 800, 450, {}, 1600, 900, { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const d = calls(ctx, 'drawImage')[0];
  assert.deepEqual(d.slice(2, 6), [400, 225, 800, 450], '元の真ん中半分');
});

test('V21 ズーム: 寄るほど使う範囲が狭くなる。1未満は寄らない', () => {
  const at = (scale) => {
    const ctx = fakeCtx(800, 450);
    paintFrame(ctx, 800, 450, {}, 1600, 900, { zoom: { scale, cx: 0.5, cy: 0.5 } });
    return calls(ctx, 'drawImage')[0][4];
  };
  assert.equal(at(1), 1600);
  assert.equal(at(2), 800);
  assert.equal(at(0.5), 1600, '1未満でも縮めない(黒帯が出る)');
});

test('V22 ⚠絵がまだ来ていない(drawImageが失敗する)瞬間でも落ちない', () => {
  const ctx = fakeCtx(800, 450);
  ctx.drawImage = () => { throw new Error('not ready'); };
  assert.doesNotThrow(() => paintFrame(ctx, 800, 450, {}, 1600, 900, {}));
});

test('V23 ⚠元の大きさが0でも0除算しない', () => {
  const ctx = fakeCtx(800, 450);
  const box = paintFrame(ctx, 800, 450, {}, 0, 0, {});
  assert.ok(Number.isFinite(box.dw) && box.dw > 0);
});

// ---------------------------------------------------------------------------
// 🔄 回転と切り抜きの組み合わせ (2026-08-15)
// ⚠⚠ ここが崩れると「回して切り抜いた作業標準の写真が、まったく違う場所を切る」。
//   しかも回転を使わない限り出ないので、誰も気づかないまま出回る。
// ---------------------------------------------------------------------------

// 出来上がりの座標(u,v) → 元の座標(x,y) の写し戻し。
//   90°(時計回り)は u=1-y, v=x なので、逆は x=v, y=1-u。
//   ⚠転置(x=v, y=u)だけでは **鏡写しの補正が抜ける**。90°と270°が同じ範囲を返してしまう。
test('V20b ⚠⚠回して切り抜いた時、元の絵の「正しい場所」を切っている', () => {
  const at = (rot) => {
    const ctx = fakeCtx(1000, 500);
    paintFrame(ctx, 1000, 500, {}, 1000, 500, { rotate: rot, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    return calls(ctx, 'drawImage')[0].slice(2, 6);
  };
  // 「出来上がりの左上1/4」を指定した時、元のどこを切るべきか
  assert.deepEqual(at(0), [0, 0, 500, 250], '回さない → 元の左上');
  assert.deepEqual(at(90), [0, 250, 500, 250], '90°→ 元の**左下**(左上は右上へ回るので)');
  assert.deepEqual(at(180), [500, 250, 500, 250], '180°→ 元の右下');
  assert.deepEqual(at(270), [500, 0, 500, 250], '270°→ 元の右上');
});

test('V20c ⚠90°と270°は必ず反対側を切る（同じ範囲を返したら間違い）', () => {
  const at = (rot) => {
    const ctx = fakeCtx(1000, 500);
    paintFrame(ctx, 1000, 500, {}, 1000, 500, { rotate: rot, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    return calls(ctx, 'drawImage')[0].slice(2, 6).join(',');
  };
  assert.notEqual(at(90), at(270), '90°と270°が同じ場所を切っている');
  assert.notEqual(at(180), at(0), '180°が「回さない」と同じ場所を切っている');
});

test('V20d 切り抜き無しなら、どの角度でも全部を使う（回転だけで場所は動かない）', () => {
  for (const rot of [0, 90, 180, 270]) {
    const ctx = fakeCtx(1000, 500);
    paintFrame(ctx, 1000, 500, {}, 1000, 500, { rotate: rot });
    assert.deepEqual(calls(ctx, 'drawImage')[0].slice(2, 6), [0, 0, 1000, 500], `${rot}°`);
  }
});

// translate → rotate の順に当てはめた時、元の4隅がどこへ写るか。
// ⚠「縦長になったか」だけの検査では **90°と270°を入れ替えても通ってしまう**。
const cornerOf = (ctx, box, x01, y01) => {
  const t = calls(ctx, 'translate')[0];
  const r = calls(ctx, 'rotate')[0];
  const rad = r ? r[1] : 0;
  const rot = Math.round((rad * 180 / Math.PI + 360) % 360);
  const dw = (rot === 90 || rot === 270) ? box.dh : box.dw;
  const dh = (rot === 90 || rot === 270) ? box.dw : box.dh;
  const lx = (x01 - 0.5) * dw, ly = (y01 - 0.5) * dh;   // 描く座標(中心が原点)
  return {
    x: t[1] + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: t[2] + lx * Math.sin(rad) + ly * Math.cos(rad),
  };
};

test('V19d ⚠⚠元の左上が、枠のどこへ回るか（90°と270°を入れ替えたら落ちる）', () => {
  const run = (rot, W, H) => {
    const ctx = fakeCtx(W, H);
    const box = paintFrame(ctx, W, H, {}, 1000, 500, { rotate: rot });
    return { p: cornerOf(ctx, box, 0, 0), box, W, H };
  };
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  // 回さない → 左上は枠の左上寄り
  {
    const { p, box } = run(0, 1000, 500);
    assert.ok(near(p.x, box.dx) && near(p.y, box.dy), `0°の左上 ${JSON.stringify(p)}`);
  }
  // 90°(時計回り) → 元の左上は **右上** へ
  {
    const { p, box } = run(90, 500, 1000);
    assert.ok(near(p.x, box.dx + box.dw) && near(p.y, box.dy), `90°で右上に来ていない ${JSON.stringify(p)}`);
  }
  // 180° → 右下
  {
    const { p, box } = run(180, 1000, 500);
    assert.ok(near(p.x, box.dx + box.dw) && near(p.y, box.dy + box.dh), `180°で右下に来ていない ${JSON.stringify(p)}`);
  }
  // 270° → 左下
  {
    const { p, box } = run(270, 500, 1000);
    assert.ok(near(p.x, box.dx) && near(p.y, box.dy + box.dh), `270°で左下に来ていない ${JSON.stringify(p)}`);
  }
});
