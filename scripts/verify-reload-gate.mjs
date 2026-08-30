#!/usr/bin/env node
/**
 * verify-reload-gate.mjs — 「送れていない保存がある間は読み直させない」関所を **動かして** 確かめる
 * ===========================================================================
 *
 * 【なぜ要るか(2026-08-30)】
 *   2026-08-17: まだサーバへ送れていない保存を抱えた端末で画面が読み直され、
 *   その端末に貯まっていた作業がそのまま消えた(復旧できていない)。
 *   その翌日 2026-08-18 に「🆕 新しい版が出ました → 切り替える」の札を足したが、
 *   **関所を入れ忘れた**。つまり事故と同じ引き金を、対策として配っていた。
 *   関所が在ったのは最終検査(golden)だけだった。
 *
 * 【この見張りが他と違う所】
 *   scripts/verify-version-watch.mjs は「名前が繋がっているか(配線)」を **文字で** 見る。
 *   こちらは index.html の中の素のJavaScript を **実際に走らせて**、
 *   詰まった時に本当に押せないか・送り終わったら本当に押せるようになるかを見る。
 *   ⚠2026-08-19 の教訓: 「試験が緑」と「機能が動く」は別物。文字だけでは足りない。
 *
 * 【どうやって走らせるか】
 *   ・index.html の <script> を node:vm で走らせる。**出荷する物そのもの**を食う。
 *   ・DOM は必要な所だけの作り物(getElementById / innerHTML の id を拾う / style / onclick)。
 *   ・時計も作り物。2秒ごとの塗り直しは、こちらが呼んだ時だけ進む。
 *   ・通信は1つもしない。Firestore にもエミュレータにも繋がない
 *     (関所の判定は window.__appSaveStatus だけで決まるので、詰まりはその札で忠実に作れる。
 *      ⚠devサーバを起こすと本番の Firestore を向く事故が 2026-08-28 に起きている)。
 *
 * 【🚨 この見張り自身も試験する】
 *   最後に、関所を1行だけ外した写しを同じ試験にかけ、**赤になる事**を確かめる。
 *   壊しても緑のままなら、この試験は何も見ていない。
 *
 * 使い方: node scripts/verify-reload-gate.mjs        (終了値 0=合格 / 1=不合格)
 *        APP_ROOT=<path> node scripts/verify-reload-gate.mjs  … 別のアプリを見る
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.APP_ROOT || path.resolve(HERE, '..');

/** index.html から、いちばん長い インライン <script> を取り出す(関所が入っている物)。 */
export function inlineScriptOf(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html)))) out.push(m[1]);
  return out.sort((a, b) => b.length - a.length)[0] || '';
}

// ---------------------------------------------------------------------------
// 作り物の画面。必要な所だけ。⚠ここを本物っぽくしすぎない(嘘の合格の温床になる)。
// ---------------------------------------------------------------------------
function makeStubDom() {
  const byId = new Map();
  const listeners = new Map();
  const timers = { interval: [], timeout: [] };
  const nav = [];

  const mkEl = (id) => {
    const el = {
      id,
      style: {},
      textContent: '',
      disabled: false,
      onclick: null,
      childElementCount: 0,
      parentNode: null,
      children: [],
      setAttribute() {},
      getAttribute() { return ''; },
      appendChild(c) { this.children.push(c); c.parentNode = this; this.childElementCount = this.children.length; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; this.childElementCount = this.children.length; return c; },
      querySelector() { return null; },
      get innerHTML() { return this._html || ''; },
      // innerHTML に入った文字から id="…" を拾って、その場に部品を用意する。
      set innerHTML(v) {
        this._html = String(v);
        for (const mm of this._html.matchAll(/id="([^"]+)"/g)) {
          if (!byId.has(mm[1])) byId.set(mm[1], mkEl(mm[1]));
        }
      },
    };
    if (id) byId.set(id, el);
    return el;
  };

  const root = mkEl('root');
  root.childElementCount = 1;      // アプリが描けている状態(= isRunning() が true)
  const body = mkEl('__body');

  const document = {
    body,
    hidden: false,
    getElementById: (id) => byId.get(id) || null,
    createElement: () => mkEl(''),
    querySelector: () => null,
    addEventListener: (t, fn) => { listeners.set(t, [...(listeners.get(t) || []), fn]); },
    removeEventListener: () => {},
  };

  const location = {
    pathname: '/', search: '', hash: '',
    replace: (url) => nav.push({ how: 'replace', url }),
    reload: () => nav.push({ how: 'reload', url: '' }),
  };

  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };

  const ctx = {
    document,
    location,
    navigator: { onLine: true },
    localStorage: store(),
    sessionStorage: store(),
    console: { log() {}, warn() {}, error() {} },
    Date,
    Event: class { constructor(type) { this.type = type; } },
    DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
    fetch: () => Promise.reject(new Error('この試験では通信しません')),
    setInterval: (fn, ms) => { timers.interval.push({ fn, ms }); return timers.interval.length; },
    clearInterval: (id) => { if (timers.interval[id - 1]) timers.interval[id - 1].dead = true; },
    setTimeout: (fn, ms) => { timers.timeout.push({ fn, ms }); return timers.timeout.length; },
    clearTimeout: (id) => { if (timers.timeout[id - 1]) timers.timeout[id - 1].dead = true; },
    addEventListener: (t, fn) => { listeners.set(t, [...(listeners.get(t) || []), fn]); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  ctx.window = ctx;

  return {
    ctx,
    byId,
    nav,
    /** 登録された合図を飛ばす(本物と同じ道で札を出す為) */
    fire(type, ev = {}) { for (const fn of listeners.get(type) || []) fn(ev); },
    /** 2秒ごとの塗り直しを1回だけ進める */
    tickIntervals(msAtMost = 3000) {
      for (const t of timers.interval) if (!t.dead && t.ms <= msAtMost) t.fn();
    },
  };
}

/**
 * index.html の中の素のJavaScript を走らせて、札を出した所まで持っていく。
 * 札は **本物と同じ道**(あとから読む部品の取得に失敗した = 8/17 に端末で起きた事)で出す。
 */
export function bootNotice(scriptSrc) {
  const dom = makeStubDom();
  vm.createContext(dom.ctx);
  vm.runInContext(scriptSrc, dom.ctx, { timeout: 5000 });
  return dom;
}

// ---------------------------------------------------------------------------
// 試験の本体。scriptSrc を差し替えれば「壊した物」にも同じ試験をかけられる。
// ---------------------------------------------------------------------------
export function runGateChecks(scriptSrc) {
  const R = [];
  const say = (label, ok, extra = '') => R.push({ label, ok: !!ok, extra: String(extra) });

  /** 保存の札を置いてから、部品の取得失敗で「新しい版が出ました」を出す。 */
  const open = (saveStatus) => {
    const dom = bootNotice(scriptSrc);
    dom.ctx.window.__appSaveStatus = saveStatus;
    // 関所は本来 src/reloadGate.js が置く。ここでは同じ形の物を置いて、index.html 側だけを見る。
    dom.ctx.window.__appCanReload = () => {
      const s = dom.ctx.window.__appSaveStatus;
      if (s && s.unknown === true) {
        return { allowed: false, waiting: true, reason: 'save-state-unknown', label: '保存の状態が分かりません（画面を開き直してから、もう一度お試しください）' };
      }
      if (!s || typeof s !== 'object') return { allowed: true, waiting: false, reason: 'no-save-state', label: '' };
      const n = Math.max(0, Number(s.unsent) || 0);
      const waiting = n > 0 || !!s.fsPending || !!s.lotsPending;
      if (!waiting) return { allowed: true, waiting: false, reason: 'all-sent', label: '' };
      return { allowed: false, waiting: true, reason: 'pending-writes', label: `まだ送れていない保存があります（${n}件）` };
    };
    dom.fire('vite:preloadError', {});     // ← 8/17 に端末で起きた事そのもの
    return dom;
  };

  // ── R1 送れていない物が3件ある間は、押しても読み直さない ────────────────
  {
    const dom = open({ unsent: 3, fsPending: true, lotsPending: false });
    const go = dom.byId.get('__update_go');
    const warnText = dom.byId.get('__update_warn_text');
    const warn = dom.byId.get('__update_warn');
    say('R1 札が出る', !!go, '「切り替える」が見つからない');
    say('R1 送信待ちの間は押せない見た目', !!go && go.disabled === true, go && `disabled=${go.disabled}`);
    say('R1 何件待っているかを名指しで出す',
      !!warnText && /まだ送れていない保存があります（3件）/.test(warnText.textContent), warnText && warnText.textContent);
    say('R1 待っている事が見えている', !!warn && warn.style.display === 'block');
    if (go && go.onclick) go.onclick();
    say('🚨R1 押しても読み直さない', dom.nav.length === 0, JSON.stringify(dom.nav));
  }

  // ── R2 送り終わったら、人が何もしなくても押せるようになる ────────────────
  {
    const dom = open({ unsent: 2, fsPending: true, lotsPending: false });
    const go = dom.byId.get('__update_go');
    say('R2 はじめは押せない', !!go && go.disabled === true);
    dom.ctx.window.__appSaveStatus = { unsent: 0, fsPending: false, lotsPending: false }; // 送り終わった
    dom.tickIntervals();                                                                  // 2秒後
    say('R2 送り終われば自動で押せるようになる(人を待たせっぱなしにしない)',
      !!go && go.disabled === false, go && `disabled=${go.disabled}`);
    say('R2 文言も戻る', !!go && go.textContent === '切り替える', go && go.textContent);
    if (go && go.onclick) go.onclick();
    say('R2 その状態で押せば読み直す', dom.nav.length === 1 && /__r=/.test(dom.nav[0].url), JSON.stringify(dom.nav));
  }

  // ── R3 逃げ道。詰まったままでも、人が選べば読み直せる(⚠一発では実行しない) ──
  {
    const dom = open({ unsent: 5, fsPending: true, lotsPending: false });
    const force = dom.byId.get('__update_force');
    const confirm = dom.byId.get('__update_force_confirm');
    const no = dom.byId.get('__update_force_no');
    const yes = dom.byId.get('__update_force_yes');
    say('R3 逃げ道の入口が在る', !!force);
    if (force && force.onclick) force.onclick();
    say('🚨R3 1回押しただけでは読み直さない(確かめが出るだけ)', dom.nav.length === 0, JSON.stringify(dom.nav));
    say('R3 確かめが出る', !!confirm && confirm.style.display === 'block');
    if (no && no.onclick) no.onclick();
    say('R3 「やめる」で元に戻る(取り返しがつく)',
      dom.nav.length === 0 && !!confirm && confirm.style.display === 'none');
    if (force && force.onclick) force.onclick();
    if (yes && yes.onclick) yes.onclick();
    say('R3 2回目にはっきり選んだ時だけ読み直す', dom.nav.length === 1, JSON.stringify(dom.nav));
  }

  // ── R4 画面が落ちた瞬間(分からない)は押させない ──────────────────────────
  {
    const dom = open({ unknown: true });
    const go = dom.byId.get('__update_go');
    const warnText = dom.byId.get('__update_warn_text');
    say('R4 分からない時は押せない', !!go && go.disabled === true);
    say('R4 理由を人の言葉で出す', !!warnText && /分かりません/.test(warnText.textContent), warnText && warnText.textContent);
    if (go && go.onclick) go.onclick();
    say('🚨R4 押しても読み直さない', dom.nav.length === 0, JSON.stringify(dom.nav));
  }

  // ── R5 本体のJSが読めていない時は押させる(出口を塞がない) ────────────────
  {
    const dom = bootNotice(scriptSrc);
    dom.fire('vite:preloadError', {});       // 関所そのものが置かれていない状態
    const go = dom.byId.get('__update_go');
    say('R5 関所が無い時は押せる(読み直す以外に出口が無い)', !!go && go.disabled === false, go && `disabled=${go.disabled}`);
    if (go && go.onclick) go.onclick();
    say('R5 その時は読み直せる', dom.nav.length === 1, JSON.stringify(dom.nav));
  }

  // ── R6 送る物が何も無い普通の時は、今までどおり押せる ────────────────────
  {
    const dom = open({ unsent: 0, fsPending: false, lotsPending: false });
    const go = dom.byId.get('__update_go');
    say('R6 送信待ちが無ければ押せる', !!go && go.disabled === false);
    if (go && go.onclick) go.onclick();
    say('R6 押せば読み直す', dom.nav.length === 1);
  }

  return R;
}

// ---------------------------------------------------------------------------
// 🚨 この見張り自身の試験 — 関所を1行だけ外した写しで、本当に赤になるか
// ---------------------------------------------------------------------------
const MUTANTS = [
  {
    id: 'M1 関所を見ない(2026-08-18〜30 に3アプリが配っていた形そのもの)',
    from: "if (typeof window.__appCanReload === 'function') return window.__appCanReload();",
    to: 'return { allowed: true, waiting: false, label: \'\' };',
    mustFail: '🚨R1 押しても読み直さない',
  },
  {
    id: 'M2 押せない見た目にしない',
    from: 'go.disabled = true;',
    to: 'go.disabled = false;',
    mustFail: 'R1 送信待ちの間は押せない見た目',
  },
  {
    id: 'M3 押す直前の見直しを外す',
    from: '            if (!g.allowed) { paintGate(); return; }',
    to: '            if (false) { paintGate(); return; }',
    mustFail: '🚨R1 押しても読み直さない',
  },
  {
    // ⚠壊す文字は **1行だけ**にする事。index.html は CRLF なので、
    //   複数行をまたぐ文字は永久に一致せず「壊す場所が見つかりません」で赤になる(実測)。
    id: 'M4 逃げ道を一発で実行してしまう',
    from: '            forceAsked = true;',
    to: '            close(); hardReload();',
    mustFail: '🚨R3 1回押しただけでは読み直さない(確かめが出るだけ)',
  },
  {
    id: 'M5 送り終わっても押せるようにならない',
    from: '          gateTimer = setInterval(paintGate, 2000);',
    to: '          gateTimer = setInterval(function () {}, 2000);',
    mustFail: 'R2 送り終われば自動で押せるようになる(人を待たせっぱなしにしない)',
  },
];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const htmlPath = path.join(REPO_ROOT, 'index.html');
  let bad = 0;
  const line = '─'.repeat(70);
  console.log('🚪 読み直しの関所を **動かして** 確かめる');
  console.log(`   見る相手: ${htmlPath}`);
  console.log(line);

  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const src = inlineScriptOf(html);
  if (!src) {
    console.log('❌ index.html の中に走らせる <script> が見つかりません。**何も見ていません**。');
    process.exit(1);
  }

  for (const r of runGateChecks(src)) {
    if (!r.ok) bad += 1;
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.extra && !r.ok ? ` … ${r.extra}` : ''}`);
  }

  console.log('');
  console.log('🚨 見張り自身の試験(1行だけ壊して、赤になるか)');
  for (const m of MUTANTS) {
    if (!src.includes(m.from)) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 壊す場所が見つかりません: ${JSON.stringify(m.from.slice(0, 48))}`);
      console.log('     🚨 index.html が書き変わって、この試験が**何も壊せていない**という事です。');
      continue;
    }
    const got = runGateChecks(src.replace(m.from, m.to));
    const target = got.find((r) => r.label === m.mustFail);
    if (!target) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 見るはずの判定「${m.mustFail}」が一覧に有りません(試験の書き間違い)`);
    } else if (target.ok) {
      bad += 1;
      console.log(`  ❌ ${m.id} … 壊したのに **緑のまま**。この判定は見ていないのと同じです。`);
    } else {
      console.log(`  ✅ ${m.id} … 壊したら赤になった(「${m.mustFail}」)`);
    }
  }

  console.log(line);
  if (bad === 0) {
    console.log('✅ 関所: 合格(送れていない間は読み直さない / 送り終われば自動で押せる / 逃げ道は2段階)');
    process.exit(0);
  }
  console.log(`🚨 関所: 不合格 ${bad}件`);
  console.log('   ⚠ここが赤のまま出すと、2026-08-17 と同じ形で作業が消えます。');
  console.log('   🚨 見張りを緩めて緑にしないでください。落ちる理由の方を直してください。');
  process.exit(1);
}
