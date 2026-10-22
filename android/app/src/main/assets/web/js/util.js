/* util.js —— 小工具 */
(function (global) {
  'use strict';

  const U = {
    clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
    rand(lo, hi) { return lo + Math.random() * (hi - lo); },
    randInt(lo, hi) { return Math.floor(U.rand(lo, hi + 1)); },
    pick(arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; },
    pickWeighted(list, weightFn) {
      if (!list || !list.length) return null;
      let total = 0;
      const ws = list.map((it) => { const w = Math.max(0, weightFn(it)); total += w; return w; });
      if (total <= 0) return U.pick(list);
      let r = Math.random() * total;
      for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
      return list[list.length - 1];
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },
    $ (sel, root) { return (root || document).querySelector(sel); },
    $$ (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
    now() { return performance.now(); },
    fmtTime(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    debounce(fn, ms) {
      let t = 0;
      return function () {
        const args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(() => fn.apply(self, args), ms);
      };
    },
    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
  };

  global.U = U;
})(window);
