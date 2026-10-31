// ============================================================================
// 部品(社内版)の通知の切替の配線(2026-10-31)。中身の試験は src/data/__tests__/webPushClient.test.mjs と onpremSwSignal.test.mjs。
//   P01 onprem-config.json の pushMode: 既定 relay・"signal" だけ signal(設定の読み方)・起動の所が onpremPush.js へ渡す
//   P02 ContactKit.jsx / App.jsx の通知の呼ぶ所は全部 `IS_ONPREM_BUILD ? 社内版の関数 : 今の関数` — else 側は今の呼び方のまま
//   P03 onpremPush.js: 既定 relay は今の道(中継 sendPushViaWorker・Firebase 'onprem-push')・名前空間・SW は registerOnpremSw
//   P04 relay の時に今の関数がそのまま呼ばれる(切替の口を通しても形が変わらない)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeOnpremConfig } from '../../onprem.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8').replace(/\r\n/g, '\n');

test('P01 pushMode: default relay, only "signal" switches; boot hands it to onpremPush.js', () => {
  const m = (raw) => normalizeOnpremConfig(raw, {}, 'https://kensa.local').pushMode;
  assert.equal(m({}), 'relay');
  assert.equal(m(null), 'relay');
  assert.equal(m({ pushMode: 'relay' }), 'relay');
  assert.equal(m({ pushMode: 'bogus' }), 'relay');
  assert.equal(m({ pushMode: 'signal' }), 'signal');
  assert.equal(m({ pushMode: ' Signal ' }), 'signal');
  assert.match(read('src/App.jsx'), /setOnpremPush\(cfg\.pushFirebase\);\n\s+setOnpremPushMode\(cfg\.pushMode\);/);
});

test('P02 every push call site switches on IS_ONPREM_BUILD, and the else side is today\'s call', () => {
  const kit = read('src/contact/ContactKit.jsx');
  const app = read('src/App.jsx');
  assert.equal((kit.match(/\(IS_ONPREM_BUILD \? onpremSendPush : sendPushViaWorker\)\(cfg\.workerUrl, \{/g) || []).length, 3, 'main / cc / test');
  assert.equal((kit.match(/\bsendPushViaWorker\b/g) || []).length, 4, 'import + 3 switched uses only');
  assert.match(kit, /if \(!IS_ONPREM_BUILD && \(!cfg\.vapidKey \|\| !cfg\.workerUrl\)\) return;/);
  assert.match(kit, /if \(IS_ONPREM_BUILD \|\| targets\.length\)/);
  assert.match(kit, /const ready = IS_ONPREM_BUILD \? onpremPushReady\(cfg\) : !!\(cfg\.vapidKey && cfg\.workerUrl\);/);
  assert.match(kit, /if \(!mine \|\| \(IS_ONPREM_BUILD \? !onpremPushReady\(cfg\) : !cfg\.workerUrl\)\) return;/);
  assert.match(app, /await \(IS_ONPREM_BUILD \? onpremSendPush : sendPushViaWorker\)\(cfg\.workerUrl, \{/);
  assert.equal((app.match(/\bsendPushViaWorker\b/g) || []).length, 2, 'import + the weekly brief (switched)');
});

test('P03 onpremPush.js: relay = today\'s functions, parts namespace, the same SW', () => {
  const g = read('src/onpremPush.js');
  assert.match(g, /import \{ createOnpremPush, pushModeOf \} from '\.\/data\/webPushClient\.js';/);
  for (const [k, v] of [['relaySend', 'sendPushViaWorker'], ['relayEnable', 'relayEnablePush'], ['relayDisable', 'relayDisablePush'], ['relayListen', 'relayListenForegroundPush'], ['relayProblem', 'relayPushSupportProblem']]) {
    assert.match(g, new RegExp(`${k}: ${v},`), k);
  }
  assert.match(g, /ONPREM_PUSH_NS = 'parts-inspection-v1'/);
  assert.match(g, /registerSw: registerOnpremSw,/);
  assert.match(g, /let _mode = 'relay';/);
  assert.match(g, /getToken\(getMessaging\(messagingApp\(\)\), \{ vapidKey: k, serviceWorkerRegistration: reg \}\)/, 'relay の登録(Firebase の getToken)は残す');
});

test('P04 default relay: the switch hands the call to today\'s functions unchanged', async () => {
  const p = await import('../../onpremPush.js');
  assert.equal(p.onpremPushMode(), 'relay');
  assert.equal(p.setOnpremPushMode(undefined), 'relay');
  assert.equal(p.pushReady({ vapidKey: 'v', workerUrl: 'w' }), true);
  assert.equal(p.pushReady({ vapidKey: 'v' }), false);
  assert.equal(p.setOnpremPushMode('signal'), 'signal');
  assert.equal(p.pushReady({}), true);
  assert.equal(p.setOnpremPushMode('relay'), 'relay');
});
