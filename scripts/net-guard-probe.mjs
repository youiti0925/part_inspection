// =============================================================================
// 🧪 net-guard の「わざと外へ繋ぐ」探り役(selftest-net-guard.mjs から子・孫として起こされる)
// -----------------------------------------------------------------------------
// ⚠ このファイルは **見張りを自分では読み込まない**(読み込むと「外したら赤」を確かめられない)。
//   見張りは親が NODE_OPTIONS で渡した物だけ。
// ⚠ 宛先は届かない事が決まっている所だけを使う:
//     192.0.2.1(RFC 5737 の TEST-NET-1 = インターネットに経路が無い)・*.invalid(RFC 6761 = 必ず無い名前)。
//   本物の Firebase(firestore.googleapis.com 等)へは、見張りが壊れていても繋がない。
//   8.8.8.8:443 は「同じ process で 192.0.2.1 が止まった時だけ」試す(壊れた見張りでは試さない)。
//
// 使い方(人が打つ物ではない):
//   node net-guard-probe.mjs all       … この process で全部の口を試し、結果を1行の JSON で出す
//   node net-guard-probe.mjs chain     … 自分で all を試し、更に孫を4通り(env そのまま / env から
//                                         NODE_OPTIONS を落とす spawnSync / 同じく落とす fork / 同じく落とす util.promisify(execFile))起こして集める
//   node net-guard-probe.mjs swallow   … 止められた例外を握り潰して exit 0 しようとする(見張りが exit 3 に変えるか)
// =============================================================================

import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { spawnSync, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const KEY = Symbol.for('inspection.netGuard');
const SELF = fileURLToPath(import.meta.url);
const NOWHERE_IP = '192.0.2.1';
const NOWHERE_HOST = 'net-guard-probe.firestore.invalid';
const mode = process.argv[2] || 'all';

const guard = globalThis[KEY];
// 探り役は「わざと止めさせる」ので、見張りの握り潰し検出(exit 3)をこの process だけ外す。swallow は外さない。
if (guard && mode !== 'swallow') guard.expectBlocks = true;

function blockedLabel(e) {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) {
    if (x.code === 'ERR_NET_GUARD_BLOCKED') {
      const m = /止めました: (\S+)/.exec(x.message);
      return m ? m[1] : 'unknown';
    }
  }
  return null;
}

function syncTry(fn) {
  try {
    const r = fn();
    return { r };
  } catch (e) {
    const b = blockedLabel(e);
    return { out: b ? `blocked:${b}` : `error:${e.code || e.message}` };
  }
}

const quiet = (o) => { try { o?.on?.('error', () => {}); } catch { /* */ } return o; };

async function probeAll() {
  const res = { pid: process.pid, guard: guard?.active ? 'yes' : 'no' };

  // ① net(根っこ。http/https/tls/fetch も最後はここ)
  {
    const t = syncTry(() => quiet(net.connect({ host: NOWHERE_IP, port: 443 })));
    if (t.out) res.net = t.out; else { t.r.destroy(); res.net = 'open'; }
    // 8.8.8.8:443 は「止まると分かっている時だけ」
    if (res.net === 'blocked:net.Socket.connect') {
      const t8 = syncTry(() => quiet(net.connect(443, '8.8.8.8')));
      if (t8.out) res.net8888 = t8.out; else { t8.r.destroy(); res.net8888 = 'open'; }
    } else res.net8888 = 'skipped';
  }
  // ② tls
  {
    const t = syncTry(() => quiet(tls.connect({ host: NOWHERE_IP, port: 443, servername: 'x.invalid' })));
    if (t.out) res.tls = t.out; else { t.r.destroy(); res.tls = 'open'; }
  }
  // ③ http2
  {
    const t = syncTry(() => quiet(http2.connect(`https://${NOWHERE_IP}`)));
    if (t.out) res.http2 = t.out; else { t.r.destroy(); res.http2 = 'open'; }
  }
  // ④ https(REST を fetch 以外で書く形)
  {
    const t = syncTry(() => quiet(https.get(`https://${NOWHERE_HOST}/v1/projects/x/databases/(default)/documents`)));
    if (t.out) res.https = t.out; else { t.r.destroy(); res.https = 'open'; }
  }
  // ⑤ fetch
  {
    const t = syncTry(() => fetch(`https://${NOWHERE_HOST}/v1/projects/x`, { signal: AbortSignal.timeout(3000) }));
    if (t.out) res.fetch = t.out;
    else {
      try { await t.r; res.fetch = 'open'; } catch (e) {
        const b = blockedLabel(e);
        res.fetch = b ? `blocked-late:${b}` : `open:${e.cause?.code || e.code || e.name}`;
      }
    }
  }
  // ⑥ WebSocket(node 22 以降の組み込み)
  if (typeof globalThis.WebSocket === 'function') {
    const t = syncTry(() => new globalThis.WebSocket(`wss://${NOWHERE_IP}/`));
    if (t.out) res.ws = t.out; else { try { t.r.onerror = () => {}; t.r.close(); } catch { /* */ } res.ws = 'open'; }
  } else res.ws = 'n/a';
  // ⑦ dns(名前を引く事自体が外への通信)
  {
    const t = syncTry(() => dns.lookup(NOWHERE_HOST, () => {}));
    res.dns = t.out || 'open';
  }
  // ⑧ UDP
  {
    const s = dgram.createSocket('udp4');
    s.on('error', () => {});
    const t = syncTry(() => s.send(Buffer.from('x'), 53, NOWHERE_IP));
    res.udp = t.out || 'open';
    try { s.close(); } catch { /* */ }
  }
  // ⑨ worker_threads(NODE_OPTIONS の --import は worker に効かない。見張りが先に読ませているか)
  res.worker = await new Promise((resolve) => {
    const code = `
      const { parentPort } = require('node:worker_threads');
      const net = require('node:net');
      try { const s = net.connect({ host: ${JSON.stringify(NOWHERE_IP)}, port: 443 }); s.on('error', () => {}); s.destroy(); parentPort.postMessage('open'); }
      catch (e) { const g = globalThis[Symbol.for('inspection.netGuard')]; if (g) g.expectBlocks = true;
        parentPort.postMessage(e.code === 'ERR_NET_GUARD_BLOCKED' ? 'blocked:' + (/止めました: (\\S+)/.exec(e.message) || [])[1] : 'error:' + e.code); }`;
    let w;
    try { w = new Worker(code, { eval: true }); } catch (e) { resolve(`error:${e.code || e.message}`); return; }
    const timer = setTimeout(() => { w.terminate(); resolve('timeout'); }, 10000);
    w.on('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.on('error', (e) => { clearTimeout(timer); resolve(`error:${e.code || e.message}`); });
  });
  // ⑩' 見張りが差し替えた関数でも、util.promisify の形が変わらない事(2026-10-03: 形が変わって既存の見張りが赤になった)
  try { res.shapeLookup = Object.keys(await promisify(dns.lookup)('localhost')).sort().join(','); } catch (e) { res.shapeLookup = `error:${e.code}`; }
  try { res.shapeExecFile = Object.keys(await promisify(execFile)(process.execPath, ['-e', '0'])).sort().join(','); } catch (e) { res.shapeExecFile = `error:${e.code}`; }
  // ⑩ 手元(127.0.0.1 / localhost)へは繋げる事(見張りが強すぎて試験を壊さない事)
  res.local = await new Promise((resolve) => {
    const srv = net.createServer((c) => { c.end('pong'); });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      let got = '';
      const t = syncTry(() => net.connect({ host: 'localhost', port }));
      if (t.out) { srv.close(); resolve(t.out); return; }
      t.r.on('data', (d) => { got += d; });
      t.r.on('error', (e) => { srv.close(); resolve(`error:${e.code}`); });
      t.r.on('end', () => { srv.close(); resolve(got === 'pong' ? 'ok' : `bad:${got}`); });
    });
  });
  return res;
}

function runGrand(how) {
  const strippedEnv = { ...process.env };
  delete strippedEnv.NODE_OPTIONS;
  if (how === 'fork') {
    return new Promise((resolve) => {
      let out = '';
      const c = fork(SELF, ['all'], { env: strippedEnv, silent: true });
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', () => {});
      c.on('exit', (code) => resolve(parseOut(out, code)));
    });
  }
  if (how === 'promisified') {
    // util.promisify(execFile) の形({ stdout, stderr })が保たれ、そこでも見張りが足し直される事
    return promisify(execFile)(process.execPath, [SELF, 'all'], { env: strippedEnv })
      .then(({ stdout }) => parseOut(stdout, 0), (e) => ({ exit: e.code, error: String(e.message).slice(0, 120) }));
  }
  const env = how === 'inherit' ? undefined : strippedEnv;
  const r = spawnSync(process.execPath, [SELF, 'all'], { env, encoding: 'utf8' });
  return Promise.resolve(parseOut(r.stdout || '', r.status));
}

function parseOut(out, code) {
  const line = String(out).split(/\r?\n/).reverse().find((l) => l.startsWith('NETGUARD_PROBE '));
  if (!line) return { exit: code, error: 'no-output' };
  return { ...JSON.parse(line.slice('NETGUARD_PROBE '.length)), exit: code };
}

if (mode === 'swallow') {
  try { quiet(net.connect({ host: NOWHERE_IP, port: 443 })).destroy(); } catch { /* わざと握り潰す */ }
  process.stdout.write('NETGUARD_PROBE {"swallowed":true}\n');
  process.exit(0);
} else if (mode === 'chain') {
  const self = await probeAll();
  const grand = {
    inherit: await runGrand('inherit'),
    strippedSpawnSync: await runGrand('stripped'),
    strippedFork: await runGrand('fork'),
    strippedPromisifiedExecFile: await runGrand('promisified'),
  };
  process.stdout.write(`NETGUARD_PROBE ${JSON.stringify({ self, grand })}\n`);
  process.exit(0);
} else {
  const r = await probeAll();
  process.stdout.write(`NETGUARD_PROBE ${JSON.stringify(r)}\n`);
  process.exit(0);
}
