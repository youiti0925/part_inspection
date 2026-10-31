// ============================================================================
// On-prem service worker shared by product / final / parts (2026-10-30).
// This test file is byte-identical in all three apps (src/<dir>/__tests__/onpremSharedSw.test.mjs).
//   S01 onprem-public/onprem-sw.js has the shared md5 (same constant in all three apps = same file).
//   S02 it loads nothing from outside (no importScripts, no gstatic, no http(s) URL) and is ASCII only.
//   S03 it handles push / notificationclick and has a no-op fetch handler (no caching).
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
const SHARED_ONPREM_SW_MD5 = '9511e5a374fb2dccb54129d9f2dc5325';
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

test('S03 onprem-sw.js shows push notifications itself, focuses/opens on click, never caches', () => {
  const sw = swText(ROOT);
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /event\.data\.json\(\)/);
  assert.match(sw, /p\.notification/);
  assert.match(sw, /p\.data/);
  assert.match(sw, /showNotification\(title, opts\)/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /\.focus\(\)/);
  assert.match(sw, /openWindow\(link\)/);
  assert.match(sw, /addEventListener\('fetch', \(\) => \{\}\)/, 'fetch handler exists (installable) and does nothing');
  assert.ok(!/respondWith|caches\./.test(sw), 'no caching');
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
