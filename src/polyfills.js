// === iOS 11 / Safari 11 向け 最小ランタイムポリフィル ===
// 古い Safari に欠けているメソッドを補完する。新しいブラウザでは if 判定でスキップ (無影響)。
// 構文は ES2015 範囲 (build.target=es2015 と併用)。main.jsx で最初に import すること。
(function () {
  try { if (typeof globalThis === 'undefined') { window.globalThis = window; } } catch (e) {}

  if (!Array.prototype.flat) {
    Array.prototype.flat = function (depth) {
      var d = depth === undefined ? 1 : Number(depth);
      return this.reduce(function (acc, val) {
        return acc.concat((Array.isArray(val) && d > 0) ? val.flat(d - 1) : [val]);
      }, []);
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, thisArg) { return this.map(fn, thisArg).flat(); };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (iterable) {
      var obj = {};
      var arr = Array.from(iterable);
      for (var i = 0; i < arr.length; i++) { obj[arr[i][0]] = arr[i][1]; }
      return obj;
    };
  }
  if (!Promise.allSettled) {
    Promise.allSettled = function (promises) {
      return Promise.all(Array.from(promises).map(function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      }));
    };
  }
  if (!String.prototype.matchAll) {
    String.prototype.matchAll = function (regexp) {
      var re = (regexp instanceof RegExp) ? regexp : new RegExp(regexp, 'g');
      var flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
      var r = new RegExp(re.source, flags);
      var str = String(this);
      var out = [];
      var m;
      while ((m = r.exec(str)) !== null) { out.push(m); if (m.index === r.lastIndex) { r.lastIndex++; } }
      return out;
    };
  }
})();
