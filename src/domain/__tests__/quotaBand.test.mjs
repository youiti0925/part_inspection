// 🚨 2026-10-01 枠切れ(429)の帯の見張り(部品)。
//   あった事: 読み取りの無料枠を使い切った時、帯の「もう一度読む」が window.location.reload() だった。
//     開き直すとまた 429 で同じ帯が出て、開き直すたびに読みも増えた。帯は fixed・z-600 で作業画面のヘッダーまで覆った。
//     保存を押すたびに「消える保存を止めました」の帯と alert(「画面を開き直して」)が出直した。
//   守る事:
//     QB1 枠が戻る時刻より前は押せない・ボタンの字は「16:00 以降に押せます」。過ぎたら押せる(張り直し)。練習はいつでも終われる。
//     QB2 閉じたら until まで畳む(端末に覚える)。過ぎたら開く。覚えられない端末でも投げない。
//     QB3 App: 帯のボタンが reload しない・押せない間は disabled・fixed/z-600 で重ねない・作業画面へ alertBand で流し込む。
//     QB4 App: 「もう一度読む」は購読の張り直し(readRetryToken が購読の依存に入っている)。
//     QB5 App: 保存の門はそのまま(枠切れの間は必ず投げる)。alert と「消える保存」の帯は出さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';
import {
  quotaRetryState, quotaClockHHMM, isQuotaBandFolded, foldQuotaBand, unfoldQuotaBand, QUOTA_BAND_FOLD_KEY,
} from '../quotaBand.js';
import { nextQuotaResetAt } from '../readBudget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));
const hub = codeOf(path.resolve(HERE, '..', '..', 'contact', 'ContactHub.jsx'));

// 2026-10-01 10:00 日本時間(夏時間 → 戻りは 16:00)
const NOW = Date.UTC(2026, 9, 1, 1, 0, 0);
const UNTIL = nextQuotaResetAt(NOW);

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
};

test('QB1 戻る時刻より前は押せない・過ぎたら張り直し・練習はいつでも終われる', () => {
  assert.equal(quotaClockHHMM(UNTIL), '16:00');
  const blk = { at: NOW, until: UNTIL, cols: ['lots'] };
  const before = quotaRetryState(blk, NOW);
  assert.equal(before.canRetry, false);
  assert.equal(before.label, '16:00 以降に押せます');
  assert.equal(quotaRetryState(blk, UNTIL - 1).canRetry, false);
  const after = quotaRetryState(blk, UNTIL);
  assert.equal(after.canRetry, true);
  assert.equal(after.action, 'resubscribe');
  assert.equal(after.label, 'もう一度読む');
  const drill = quotaRetryState({ ...blk, drill: true }, NOW);
  assert.equal(drill.canRetry, true);
  assert.equal(drill.action, 'endDrill');
  // until が壊れている時は押せない側(押すと枠を食う)
  assert.equal(quotaRetryState({ at: NOW, cols: [] }, NOW).canRetry, false);
  assert.equal(quotaRetryState(null, NOW).canRetry, false);
});

test('QB2 閉じたら until まで畳む・過ぎたら開く・覚えられない端末でも投げない', () => {
  const st = memStore();
  assert.equal(isQuotaBandFolded(st, NOW), false);
  assert.equal(foldQuotaBand(st, UNTIL), true);
  assert.equal(st._m.get(QUOTA_BAND_FOLD_KEY), String(UNTIL));
  assert.equal(isQuotaBandFolded(st, NOW), true);
  assert.equal(isQuotaBandFolded(st, UNTIL), false);
  unfoldQuotaBand(st);
  assert.equal(isQuotaBandFolded(st, NOW), false);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.doesNotThrow(() => isQuotaBandFolded(broken, NOW));
  assert.equal(isQuotaBandFolded(broken, NOW), false);
  assert.doesNotThrow(() => foldQuotaBand(broken, UNTIL));
  assert.doesNotThrow(() => unfoldQuotaBand(broken));
  assert.equal(isQuotaBandFolded(null, NOW), false);
});

// renderQuotaBand の中身だけを切り出す
const sliceFn = (name, code) => {
  const at = code.indexOf(`const ${name} = `);
  assert.ok(at > 0, `${name} が無い`);
  const end = code.indexOf('\n   };', at);
  assert.ok(end > at, `${name} の終わりが無い`);
  return code.slice(at, end);
};

test('QB3 帯は reload しない・押せない間は disabled・上に重ねない・作業画面へ流し込む', () => {
  const band = sliceFn('renderQuotaBand', app);
  assert.ok(!band.includes('location.reload'), '帯の中に reload が残っている');
  assert.ok(!/fixed/.test(band), '帯が fixed(上に重ねる)に戻っている');
  assert.ok(!/z-\[6/.test(band), '帯の z が 600 台に戻っている');
  assert.ok(band.includes('disabled={!st.canRetry}'), '押せない間に disabled になっていない');
  assert.ok(band.includes('quotaRetryState(quotaBlock'), '押せるかを quotaRetryState に聞いていない');
  assert.ok(band.includes('foldQuotaBandNow'), '閉じる(畳む)が無い');
  const btn = sliceFn('onQuotaBandButton', app);
  assert.ok(!btn.includes('location.reload'), 'ボタンの中に reload が残っている');
  assert.ok(btn.includes('if (!st.canRetry) return;'), '押せない間に何かしている');
  // 古い fixed の帯が残っていない
  assert.ok(!app.includes('fixed top-0 left-0 right-0 z-[600] bg-rose-700'), '古い z-600 の帯が残っている');
  // 一覧の画面と作業画面の両方に出る
  assert.ok(app.includes("{renderQuotaBand('main')}"), '一覧の画面に帯が無い');
  assert.ok(app.includes("alertBand={renderQuotaBand('work')}"), '作業画面へ帯を渡していない');
  assert.match(app, /const WorkExecutionModal = \(\{ lot: _lotProp,[^\n]*alertBand = null \}\) => \{/, '作業画面が alertBand を受け取らない');
  // 作業画面の2つの形(カスタム・順番)の両方で、ヘッダーの直前に流し込む
  const shells = app.split('{alertBand}').length - 1;
  assert.equal(shells, 2, `作業画面の中の {alertBand} が ${shells} 箇所(2箇所のはず)`);
  assert.match(app, /\{alertBand\}\s*<div className="bg-slate-800 text-white px-3 py-1\.5 flex justify-between/);
  assert.match(app, /\{alertBand\}\s*<div data-exec-head="seq"/);
});

test('QB4 「もう一度読む」は購読の張り直し(readRetryToken が依存に入っている)', () => {
  const retry = sliceFn('retryReadsAfterQuota', app);
  assert.ok(retry.includes('setReadRetryToken(n => n + 1)'));
  assert.ok(retry.includes('quotaBlockRef.current = null'));
  // 常に張る購読(本体・差分の係・窓・過去・未完了・後で読む物)がすべて合図で張り直る
  const deps = [
    '}, [user, db, countReads, noteReadError, readRetryToken]);',
    '}, [user, db, lotSubPlan.live, lotsSrc, countReads, noteReadError, readRetryToken]);',
    '}, [lotSubPlan.history, user, db, countReads, noteReadError, readRetryToken]);',
    '}, [lotSubPlan.open, lotsSrc, user, db, countReads, noteReadError, readRetryToken]);',
    '}, [everWanted, colName, user, db, readRetryToken]);',
  ];
  for (const d of deps) assert.ok(app.includes(d), `依存に readRetryToken が無い: ${d}`);
  assert.equal(app.split('}, [user, db, countReads, noteReadError, readRetryToken]);').length - 1, 2, '本体と差分の係の2つ');
  assert.ok(app.includes('onReadError: noteReadError, readRetryToken }'), '後で読む物へ合図を渡していない');
  assert.ok(hub.includes('[user, db, contactFeatureOn, readRetryToken]'), '工程連絡の購読が張り直らない');
});

test('QB5 保存の門はそのまま・alert と「消える保存」の帯は枠切れでは出さない', () => {
  const gate = app.indexOf('if (quotaBlockRef.current) {\n         const until = quotaBlockRef.current.until;');
  assert.ok(gate > 0, '枠切れの門が無い');
  const body = app.slice(gate, app.indexOf('assertLotsLoaded(lotsLoadedRef.current', gate));
  assert.ok(body.includes("e.name = 'ReadQuotaBlocked';") && body.includes('throw e;'), '枠切れの間に投げていない(門が緩んだ)');
  assert.ok(!body.includes('note('), '枠切れのたびに「消える保存」の帯を出している');
  assert.match(app, /if \(e && e\.name === 'ReadQuotaBlocked'\) \{[^}]*throw e; \}/, '枠切れの時に alert の前で投げていない');
});
