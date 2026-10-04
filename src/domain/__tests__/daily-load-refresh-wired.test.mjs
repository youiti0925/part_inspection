// ⏱ 2026-10-03 B3 部品: 共有棚 daily_load/parts の「5分に1回まで」と ③の「最新にする」に応える配線(製品・最終と同じ形)。
//   清水さん(2026-10-03 夜・原文)「その頻度でもいいけど、作業者が最新情報欲しい時は、更新ボタン押してできるようにしてもらえるならいいと思うよ」
//   決まりの振る舞いは daily-load-throttle.test.mjs が本物を走らせて見る。ここは「繋いだか」を見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const APP = codeOf(path.join(ROOT, 'src/App.jsx'));
const PANEL = codeOf(path.join(ROOT, 'src/OperationsSimulationPanel.jsx'));

test('DWP-1 画面の書く係は1つ・5分に1回まで・「今すぐ反映」', () => {
  assert.equal((PANEL.match(/useDailyLoadPublisher\(/g) || []).length, 1, '書く係が1つでない');
  assert.ok(PANEL.includes('useDailyLoadPublisher({ doc: hereDailyLoad, shelfLoaded: capacityShelfLoaded, publish: publishDailyLoad, publishOnly })'), '書く係へ 書類・旗・窓口 を渡していない');
  assert.ok(!PANEL.includes('publishDailyLoad(hereDailyLoad)'), '計算のたびに直に書く所が残っている');
  assert.ok(PANEL.includes('<DailyLoadSendNowButton info={dailyLoadPub.info}'), '「今すぐ反映」が無い');
});

test('DWP-2 ③の印(daily_load_requests/parts)を聞き、取引で1台だけ受け、画面を開いていない端末は裏の役が書く', () => {
  assert.ok(APP.includes("DATA(db).claimOnce(OPSIM_SHELF_NS, DAILY_LOAD_REQUEST_COL, app, { reqId, claimedBy: null }, { claimedBy: by, claimedAt: Date.now() })"), '印を受けるのが取引でない(2台が同時に書く)');
  assert.ok(/DATA\(db\)\.watchDoc\(OPSIM_SHELF_NS, DAILY_LOAD_REQUEST_COL, app, cb, \{ onError: \(e\) => \{ console\.warn\(/.test(APP), '印の購読に失敗の受け口が無い');
  assert.ok(APP.includes("useDailyLoadRefreshHub({ api: dailyLoadReqApi, hereApp: 'parts', screenOpen: opsimScreenOpen, active: capacityShelfLoaded, docsByApp: null })"), '印を聞く係が無い');
  assert.ok(APP.includes('<DailyLoadForceContext.Provider value={dlRefresh.forceValue}>'), '口を配っていない');
  assert.ok(APP.includes('{((bgLoadArmed && wantDailyLoadRefresh) || dlRefresh.bgForce) && ('), '画面を開いていない端末が受けても書く役が出ない');
  assert.ok(/daily_load_requests: 'analytics'/.test(codeOf(path.join(ROOT, 'src/data/routes.js'))), '地図(routes.js)に印の置き場が無い');
});
