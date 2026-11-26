// =============================================================================
//  _reactHost.mjs — 画面(.jsx)を **本物のまま** 動かして振る舞いを見る為の小さな土台
// -----------------------------------------------------------------------------
//  なぜ要るか:
//    react-dom/server の renderToStaticMarkup は 1回描くだけで、useEffect も
//    「押した後の続き」も動かない。この帯の直しは
//      ・土俵(groundKey)が変わったら 前の結果を消す(= useEffect)
//      ・引き直しの途中で土俵が変わったら その回の結果を置かない(= 押した後の続き)
//    の2つなので、文字が在るかだけの見張りでは 1行も守れない。
//
//  やり方:
//    vite の ssrLoadModule で本物の .jsx を読み、その時だけ 'react' をこのファイルに
//    差し替える(resolve.alias)。hooks はここに在る小さな物が受ける。
//    🚨 作り物を食わせるのは **React だけ**。画面のコードも純関数も本物をそのまま動かす。
//
//  出来る事: useState / useEffect / useRef / useMemo / useCallback / createElement。
//  出来ない事: 親子の付け替え・優先度・並行描画。1つの部品を動かす所までに絞ってある。
// =============================================================================

/** いま描いている最中の入れ物。描いていない間は null。 */
let cur = null;

const slotAt = (make) => {
  if (!cur) throw new Error('hooks を描画の外で呼びました');
  const { inst } = cur;
  const i = cur.i;
  cur.i += 1;
  if (inst.hooks.length <= i) inst.hooks.push(make());
  return inst.hooks[i];
};

const sameDeps = (a, b) => (
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
);

export function useState(initial) {
  const { inst } = cur;
  const slot = slotAt(() => ({ value: typeof initial === 'function' ? initial() : initial, set: null }));
  if (!slot.set) {
    slot.set = (next) => {
      const v = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(v, slot.value)) return;
      slot.value = v;
      inst.dirty = true;
    };
  }
  return [slot.value, slot.set];
}

export function useRef(initial) {
  return slotAt(() => ({ current: initial }));
}

export function useMemo(fn, deps) {
  const slot = slotAt(() => ({ deps: null, value: undefined, first: true }));
  if (slot.first || !sameDeps(slot.deps, deps)) {
    slot.value = fn();
    slot.deps = deps;
    slot.first = false;
  }
  return slot.value;
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

export function useEffect(fn, deps) {
  const slot = slotAt(() => ({ deps: null, cleanup: null, first: true }));
  if (slot.first || !sameDeps(slot.deps, deps)) {
    slot.deps = deps;
    slot.first = false;
    cur.pending.push({ slot, fn });
  }
}

export const Fragment = Symbol.for('_reactHost.Fragment');

export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { __el: true, type, props: p };
}

const React = { useState, useRef, useMemo, useCallback, useEffect, createElement, Fragment };
export default React;

// ── 土台(試験から使う) ───────────────────────────────────────────────────────

/**
 * 画面の部品を1つ動かす。返り値の render(props) で描き直す。
 * @returns {{render:Function, tree:object, props:object, unmount:Function}}
 */
export function mount(Comp, props) {
  const inst = { hooks: [], dirty: false, props, tree: null };
  inst.render = (next) => {
    if (next !== undefined) inst.props = next;
    let guard = 0;
    do {
      inst.dirty = false;
      const pending = [];
      cur = { inst, i: 0, pending };
      try {
        inst.tree = Comp(inst.props);
      } finally {
        cur = null;
      }
      for (const e of pending) {
        if (typeof e.slot.cleanup === 'function') { e.slot.cleanup(); e.slot.cleanup = null; }
        const c = e.fn();
        e.slot.cleanup = typeof c === 'function' ? c : null;
      }
      guard += 1;
      if (guard > 30) throw new Error('描き直しが止まりません(setState の輪)');
    } while (inst.dirty);
    return inst.tree;
  };
  inst.unmount = () => {
    for (const h of inst.hooks) {
      if (h && typeof h.cleanup === 'function') { h.cleanup(); h.cleanup = null; }
    }
  };
  inst.render(props);
  return inst;
}

/** 描いた物の中から、条件に当たる札を全部拾う。 */
export function findAll(node, pred, acc = []) {
  if (node == null || node === false || node === true) return acc;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, acc);
    return acc;
  }
  if (typeof node !== 'object' || !node.__el) return acc;
  if (pred(node)) acc.push(node);
  if (node.props && node.props.children !== undefined) findAll(node.props.children, pred, acc);
  return acc;
}

/** data-* が付いた札を1つ拾う(無ければ null)。 */
export const findByAttr = (tree, attr) => (
  findAll(tree, (el) => el.props && Object.prototype.hasOwnProperty.call(el.props, attr))[0] || null
);

/** 描いた物の中の文字を全部つなげる(画面に出ている言葉を見る用)。 */
export function textOf(node, out = []) {
  if (node == null || node === false || node === true) return out.join('');
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out.join(''); }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out.join(''); }
  if (typeof node === 'object' && node.__el && node.props && node.props.children !== undefined) textOf(node.props.children, out);
  return out.join('');
}

/** マイクロタスクを空にする(await した続きを進める)。 */
export const flushMicrotasks = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
