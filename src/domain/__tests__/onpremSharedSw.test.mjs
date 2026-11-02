// ============================================================================
// On-prem service worker shared by product / final / parts (2026-10-30).
// This test file is byte-identical in all three apps (src/<dir>/__tests__/onpremSharedSw.test.mjs).
//   S01 onprem-public/onprem-sw.js has the shared md5 (same constant in all three apps = same file).
//   S02 it loads nothing from outside (no importScripts, no gstatic, no http(s) URL) and is ASCII only.
//   S03 it handles push / notificationclick; S05 its fetch handler is the offline shell (2026-11-02).
//   S04 optional cross-check: ONPREM_SW_SIBLINGS=<app root>;<app root> compares the sibling apps' files directly.
// No network.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, delimiter } from 'node:path';

// md5 of onprem-public/onprem-sw.js with line endings normalized to LF. Change it in all three apps at once.
// 2026-11-02: + the offline shell block (same block as the cloud SWs).
const SHARED_ONPREM_SW_MD5 = '201d633cc0ca404d104ec95279929cfc';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const swText = (root) => readFileSync(join(root, 'onprem-public', 'onprem-sw.js'), 'utf8').replace(/\r\n/g, '\n');
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

test('S01 onprem-sw.js is the shared file (same md5 in product / final / parts)', () => {
  assert.equal(md5(swText(ROOT)), SHARED_ONPREM_SW_MD5);
});

test('S02 onprem-sw.js loads nothing from outside and is ASCII only', () => {
  const sw = swText(ROOT);
  assert.ok(!/importScripts/.test(sw), 'no importScripts');
  assert.ok(!/gstatic/i.test(sw), 'no gstatic');
  assert.ok(!/https?:\/\//i.test(sw), 'no absolute http(s) URL');
  assert.ok(!/\bimport\s*\(|^\s*import\s/m.test(sw), 'no module import');
  assert.ok(/^[\x00-\x7f]*$/.test(sw), 'ASCII only');
});

test('S03 onprem-sw.js shows push notifications itself, focuses/opens on click', () => {
  const sw = swText(ROOT);
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /event\.data\.json\(\)/);
  assert.match(sw, /p\.notification/);
  assert.match(sw, /p\.data/);
  assert.match(sw, /showNotification\(title, opts\)/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /\.focus\(\)/);
  assert.match(sw, /openWindow\(link\)/);
  assert.match(sw, /addEventListener\('fetch'/, 'fetch handler exists (installable)');
});

test('S05 offline shell: network-first page, cache-first assets/, never touches api/ _/ __* / other hosts / non-GET', () => {
  const sw = swText(ROOT);
  assert.match(sw, /const OFF_CACHE = 'offline-shell-v1'/);
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/, 'non-GET untouched');
  assert.match(sw, /if \(rest === null\) return;/, 'other hosts / outside the scope untouched');
  assert.match(sw, /\/\^\(api\\\/\|_\\\/\|__\)\/\.test\(rest\)\) return;/, 'PocketBase api/, admin _/, front __* untouched');
  assert.match(sw, /req\.mode === 'navigate'[\s\S]*offNetworkFirst\(event, offShellKey\(\), offIsHtml\)/, 'page is network first');
  assert.match(sw, /OFF_ASSET_NAME\.test\(rest\)\) \{ event\.respondWith\(offCacheFirst\(event\)\)/, 'assets cache first');
  assert.match(sw, /rest === 'onprem-config\.json'\) \{ event\.respondWith\(offNetworkFirst\(event, offUrl\('\.\/onprem-config\.json'\), offIsJson\)\)/, 'config falls back to the stored copy');
  assert.match(sw, /version\\\.json\|precache\\\.json\|onprem-files\\\.json/, 'version/precache lists never from the cache');
});

test('S04 sibling apps (ONPREM_SW_SIBLINGS) have the byte-identical onprem-sw.js', (t) => {
  const roots = String(process.env.ONPREM_SW_SIBLINGS || '').split(delimiter).map((s) => s.trim()).filter(Boolean);
  if (!roots.length) { t.skip('ONPREM_SW_SIBLINGS not set'); return; }
  const mine = readFileSync(join(ROOT, 'onprem-public', 'onprem-sw.js'));
  for (const r of roots) {
    const p = join(r, 'onprem-public', 'onprem-sw.js');
    assert.ok(existsSync(p), `${p} exists`);
    assert.equal(md5(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')), md5(mine.toString('utf8').replace(/\r\n/g, '\n')), p);
  }
});
