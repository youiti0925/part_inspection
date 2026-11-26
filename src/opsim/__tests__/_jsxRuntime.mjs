// =============================================================================
//  _jsxRuntime.mjs — .jsx を組み立てる口(react/jsx-runtime の差し替え)
//  🚨 _reactHost.mjs と **同じ** createElement を使う(別の物にすると札が拾えない)。
// =============================================================================
import { createElement, Fragment } from './_reactHost.mjs';

export const jsx = (type, props) => createElement(type, props);
export const jsxs = (type, props) => createElement(type, props);
export const jsxDEV = (type, props) => createElement(type, props);
export { Fragment };
export default { jsx, jsxs, jsxDEV, Fragment };
