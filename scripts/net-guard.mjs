// =============================================================================
// 🚫🌐 外への通信の見張り(net-guard) — 出荷前の確かめ・CI の中から本番へ繋がせない
// -----------------------------------------------------------------------------
// なぜ要るか(2026-10-03 に確定した事):
//   check-all の第15段が他の verify-*.mjs を子で走らせ、その中の2本が
//   本番 lot_images 全件(約4,450)と本番 lots を、出荷・push の CI・試し走らせのたびに読んでいた。
//   それまでの手当ては「firebase の import の字面」を探すだけで、
//     ・import { db } from '../src/firebase.js' の様に自作モジュールを経由する物
//     ・fetch 以外の REST(https.request / http2 / net 直)
//     ・別の SDK・環境変数で接続先を変える物
//   は字面に出ないので すり抜けられた。
//   → 字面ではなく **通信そのもの** を、通信する前に止める。
//
// 何をするか:
//   127.0.0.1 / ::1 / localhost 以外へ繋ごうとした瞬間に例外(ERR_NET_GUARD_BLOCKED)で止める。
//   見る口: net.Socket#connect(http / https / tls / http2 / fetch / WebSocket も最後はここを通る)
//           tls.connect / http2.connect / globalThis.fetch / globalThis.WebSocket
//           dns(lookup・resolve*・reverse・Resolver) / dgram(UDP の send・connect)
//   子・孫へ継ぐ: process.env.NODE_OPTIONS に `--import=<この file の URL>` を足す。
//           child_process の spawn/exec/fork に env を渡して NODE_OPTIONS を落としても、足し直す。
//           worker_threads の Worker にも、先にこの見張りを読ませる。
//   握り潰しを許さない: 1回でも止めたら、その process は exit 0 で終わらせない(exit 3 に変える)。
//           (試す側が「わざと止めさせる」時だけ、コードで expectBlocks=true を立てる。環境変数の抜け道は作らない)
//
// 使い方:
//   ・check-all.mjs が先頭で import する → check-all と、そこから起きる子・孫の node 全部に掛かる。
//   ・CI の試験・確かめの step は NODE_OPTIONS=--import=file://$GITHUB_WORKSPACE/scripts/net-guard.mjs
//   ・npm ci(依存の取得)と firebase deploy(配備)は **別の段** なので、この見張りを掛けない。
//
// ⚠ 守れない物(正直に書く): node 以外のプログラム(curl・ブラウザ本体・python 等)の通信は見えない。
//   それらは「起こさない」事で守る(check-all の段・CI の step にブラウザや curl を入れない)。
// ⚠ 4アプリ共通の同じファイル。直す時は4つとも直す事。
// ⚠ 名前の先頭に _ を付けない(.gitignore の `_*.mjs` で無視され、CI の checkout に届かない)。
// =============================================================================

import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import wt from 'node:worker_threads';
import path from 'node:path';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEY = Symbol.for('inspection.netGuard');

/** この見張りの file:// URL(空白は %20 になるので NODE_OPTIONS で割れない) */
export const GUARD_URL = import.meta.url;
/** NODE_OPTIONS に足す字 */
export const GUARD_FLAG = `--import=${GUARD_URL}`;

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']);

/** 繋いでよい宛先か(127.0.0.1 / ::1 / localhost だけ。宛先を書かない = node の既定 localhost) */
export function isLocalHost(h) {
  if (h === undefined || h === null || h === '') return true;
  const s = String(h).trim().toLowerCase().replace(/\.$/, '');
  return LOCAL.has(s);
}

/** NODE_OPTIONS に見張りが入っているか(別の場所の同じ見張りも「入っている」と数える) */
export function hasGuardFlag(nodeOptions) {
  return /--import[= ]\S*net-guard\.mjs/.test(String(nodeOptions || ''));
}

/** 今ある NODE_OPTIONS を壊さずに、見張りを後ろへ足す */
export function withGuardFlag(nodeOptions) {
  const cur = String(nodeOptions || '').trim();
  if (hasGuardFlag(cur)) return cur;
  return cur ? `${cur} ${GUARD_FLAG}` : GUARD_FLAG;
}

/** env の写しに見張りを足して返す(元の env は変えない) */
export function guardedEnv(env = process.env) {
  return { ...env, NODE_OPTIONS: withGuardFlag(env.NODE_OPTIONS) };
}

export class NetGuardError extends Error {
  constructor(what, target) {
    super(`🚫 [net-guard] 外への通信を止めました: ${what} → ${target}\n` +
      '   出荷前の確かめ・CI の中では 127.0.0.1 / ::1 / localhost 以外へ繋げません(本番 Firestore を読ませない為)。');
    this.name = 'NetGuardError';
    this.code = 'ERR_NET_GUARD_BLOCKED';
    this.target = target;
  }
}

function state() { return globalThis[KEY]; }

function block(what, target) {
  const err = new NetGuardError(what, target);
  const st = state();
  if (st) st.blocked.push(`${what} → ${target}`);
  try { process.stderr.write(`${err.message}\n`); } catch { /* 書けなくても止める */ }
  throw err;
}

// net.connect / Socket#connect の引数から宛先を読む(内部の「整えた引数」[options, cb] の形も読む)
function targetOf(args) {
  let a = args;
  if (Array.isArray(a[0])) a = a[0];
  const f = a[0];
  if (f && typeof f === 'object') {
    if (f.path != null && f.port == null) return { local: true, label: `pipe:${f.path}` };
    const h = f.host ?? f.hostname;
    return { local: isLocalHost(h), label: `${h ?? 'localhost'}:${f.port}` };
  }
  if (typeof f === 'number' || (typeof f === 'string' && /^\d+$/.test(f))) {
    const h = typeof a[1] === 'string' ? a[1] : undefined;
    return { local: isLocalHost(h), label: `${h ?? 'localhost'}:${f}` };
  }
  if (typeof f === 'string') return { local: true, label: `pipe:${f}` };
  // 読めない宛先は止める(fail-closed)
  return { local: false, label: '(宛先が読めない)' };
}

function urlHost(input) {
  let s;
  if (typeof input === 'string') s = input;
  else if (input instanceof URL) s = input.href;
  else if (input && typeof input === 'object' && typeof input.url === 'string') s = input.url;
  else s = String(input);
  let u;
  try { u = new URL(s); } catch { return { local: false, label: s }; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return { local: true, label: u.protocol };
  return { local: isLocalHost(u.hostname), label: u.origin };
}

// child_process: env を渡されて NODE_OPTIONS が落ちていたら、足し直す
function fixOptions(args, optIndexFrom) {
  const out = args.slice();
  for (let i = optIndexFrom; i < out.length; i++) {
    const o = out[i];
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      if (o.env && typeof o.env === 'object' && !hasGuardFlag(o.env.NODE_OPTIONS)) {
        out[i] = { ...o, env: { ...o.env, NODE_OPTIONS: withGuardFlag(o.env.NODE_OPTIONS) } };
      }
      return out;
    }
    if (typeof o === 'function') return out;
  }
  return out;
}

// 差し替えた関数に、元の関数の印(symbol の持ち物)を移す。
//   例: dns.lookup は node 内部の印で util.promisify の形({ address, family })を決めている。落とすと形が変わる。
function carrySymbols(orig, wrapped) {
  for (const sym of Object.getOwnPropertySymbols(orig)) {
    if (sym === promisify.custom) continue; // これは下で見張り付きに作り直す
    try { Object.defineProperty(wrapped, sym, Object.getOwnPropertyDescriptor(orig, sym)); } catch { /* */ }
  }
  return wrapped;
}

function install() {
  if (state()) return state();
  const st = { active: true, url: GUARD_URL, blocked: [], expectBlocks: false };
  globalThis[KEY] = st;

  // 子・孫へ継ぐ(今ある NODE_OPTIONS は壊さない)
  process.env.NODE_OPTIONS = withGuardFlag(process.env.NODE_OPTIONS);

  /*<M:net>*/
  {
    const orig = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(...args) {
      const t = targetOf(args);
      if (!t.local) block('net.Socket.connect', t.label);
      return orig.apply(this, args);
    };
  }
  /*</M:net>*/

  /*<M:tls>*/
  {
    const origTls = tls.connect;
    tls.connect = function guardedTlsConnect(...args) {
      const t = targetOf(args);
      if (!t.local && !(args[0] && typeof args[0] === 'object' && args[0].socket)) block('tls.connect', t.label);
      return origTls.apply(this, args);
    };
    const origH2 = http2.connect;
    http2.connect = function guardedHttp2Connect(authority, ...rest) {
      const t = urlHost(authority);
      if (!t.local) block('http2.connect', t.label);
      return origH2.call(this, authority, ...rest);
    };
  }
  /*</M:tls>*/

  /*<M:fetch>*/
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      const t = urlHost(input);
      if (!t.local) block('fetch', t.label);
      return origFetch.call(this, input, init);
    };
  }
  if (typeof globalThis.WebSocket === 'function') {
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = class GuardedWebSocket extends OrigWS {
      constructor(url, ...rest) {
        const t = urlHost(url);
        if (!t.local) block('WebSocket', t.label);
        super(url, ...rest);
      }
    };
  }
  /*</M:fetch>*/

  /*<M:dns>*/
  {
    const wrapName = (obj, name, label) => {
      const orig = obj?.[name];
      if (typeof orig !== 'function') return;
      obj[name] = carrySymbols(orig, function guardedDns(host, ...rest) {
        if (!isLocalHost(host)) block(label, String(host));
        return orig.call(this, host, ...rest);
      });
      // util.promisify(dns.lookup) の専用の形({ address, family })を落とさない(child_process と同じ理由)
      const custom = orig[promisify.custom];
      if (typeof custom === 'function') {
        Object.defineProperty(obj[name], promisify.custom, {
          value: function guardedDnsPromise(host, ...rest) {
            if (!isLocalHost(host)) block(label, String(host));
            return custom.call(this, host, ...rest);
          },
          configurable: true, writable: true, enumerable: false,
        });
      }
    };
    const NAMES = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
      'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'resolveTlsa', 'reverse'];
    for (const n of NAMES) {
      wrapName(dns, n, `dns.${n}`);
      wrapName(dns.promises, n, `dns.promises.${n}`);
      wrapName(dns.Resolver?.prototype, n, `dns.Resolver.${n}`);
      wrapName(dns.promises?.Resolver?.prototype, n, `dns.promises.Resolver.${n}`);
    }
    const origLs = dns.lookupService;
    dns.lookupService = function guardedLookupService(address, ...rest) {
      if (!isLocalHost(address)) block('dns.lookupService', String(address));
      return origLs.call(this, address, ...rest);
    };
  }
  /*</M:dns>*/

  /*<M:udp>*/
  {
    const origSend = dgram.Socket.prototype.send;
    dgram.Socket.prototype.send = function guardedSend(...args) {
      const addr = args.slice(1).find((v) => typeof v === 'string');
      if (addr !== undefined && !isLocalHost(addr)) block('dgram.send', addr);
      return origSend.apply(this, args);
    };
    const origUc = dgram.Socket.prototype.connect;
    dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, ...rest) {
      const addr = typeof address === 'string' ? address : undefined;
      if (addr !== undefined && !isLocalHost(addr)) block('dgram.connect', `${addr}:${port}`);
      return origUc.call(this, port, address, ...rest);
    };
  }
  /*</M:udp>*/

  /*<M:child>*/
  {
    const wrap = (name, optFrom) => {
      const orig = cp[name];
      if (typeof orig !== 'function') return;
      cp[name] = carrySymbols(orig, function guardedChild(...args) { return orig.apply(this, fixOptions(args, optFrom)); });
      // util.promisify(exec / execFile) は専用の形({ stdout, stderr })を返す。それを落とさず、そこにも足し直しを掛ける
      //   (2026-10-03 実測: 落とすと verify-promises の測り直しが "undefined" を JSON として読んで赤になった)
      const custom = orig[promisify.custom];
      if (typeof custom === 'function') {
        Object.defineProperty(cp[name], promisify.custom, {
          value: function guardedChildPromise(...args) { return custom.apply(this, fixOptions(args, optFrom)); },
          configurable: true, writable: true, enumerable: false,
        });
      }
    };
    wrap('spawn', 1); wrap('spawnSync', 1); wrap('execFile', 1); wrap('execFileSync', 1);
    wrap('exec', 1); wrap('execSync', 1); wrap('fork', 1);
  }
  /*</M:child>*/

  /*<M:worker>*/
  {
    // worker_threads は NODE_OPTIONS の --import を読まない(node 24 で実測)。先に見張りを読ませてから本体を動かす。
    const OrigWorker = wt.Worker;
    const guardPath = fileURLToPath(GUARD_URL);
    wt.Worker = class GuardedWorker extends OrigWorker {
      constructor(filename, options = {}) {
        let code;
        if (options && options.eval) {
          code = `require(${JSON.stringify(guardPath)});\n${String(filename)}`;
        } else {
          const s = filename instanceof URL ? filename.href : String(filename);
          const href = /^(file|data):/.test(s) ? s : pathToFileURL(path.resolve(s)).href;
          code = `require(${JSON.stringify(guardPath)});\nimport(${JSON.stringify(href)}).catch((e) => { process.nextTick(() => { throw e; }); });`;
        }
        super(code, { ...options, eval: true });
      }
    };
  }
  /*</M:worker>*/

  // ESM の名前付き import(import { spawnSync } from 'node:child_process' 等)にも、差し替えを届ける
  syncBuiltinESMExports();

  /*<M:exit>*/
  // 握り潰し(try/catch で黙って続け、exit 0 で「合格」)を許さない
  process.on('exit', (code) => {
    if (st.blocked.length && !st.expectBlocks && (code === 0 || code === undefined)) {
      try {
        process.stderr.write(`🚫 [net-guard] この process は外へ ${st.blocked.length} 回繋ごうとして止められました。` +
          '合格(exit 0)にはしません → exit 3\n');
      } catch { /* */ }
      process.exitCode = 3;
    }
  });
  /*</M:exit>*/

  return st;
}

install();
