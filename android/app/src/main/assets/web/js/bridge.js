/* bridge.js —— 宿主桥接层
 * 三种环境：
 *   1) 安卓（本工程 App）：window.petHost 由 Java 注入，HTTP 走原生栈（httpPostAsync 回调式）
 *   2) 平板 HAP：window.petHost 由原生侧注入，HTTP 直接返回 Promise
 *   3) 纯浏览器：fetch / localStorage / speechSynthesis 降级
 */
(function (global) {
  'use strict';

  const host = global.petHost || null;
  const pendingHttp = {};
  let httpSeq = 0;

  /* 关键：取出来的方法必须 bind 回宿主对象。
     直接 var fn = host[name]; fn(...) 会让 this 丢失，
     Chromium 的注入桥会抛 "Java bridge method can't be invoked on a non-injected object"。 */
  function callHost(name, fallback) {
    if (!host || typeof host[name] !== 'function') return fallback;
    try { return host[name].bind(host); } catch (e) { return fallback; }
  }

  function detectPlatform() {
    if (!host) return 'web';
    try {
      const p = (typeof host.getPlatform === 'function') ? String(host.getPlatform()) : '';
      if (p === 'android' || p === 'harmony') return p;
      if (typeof host.isNative === 'function' && host.isNative()) return 'harmony';
      return 'web';
    } catch (e) {
      return 'web';
    }
  }

  const platform = detectPlatform();
  const native = platform !== 'web';

  /* 安卓原生 HTTP 的回调入口 */
  global.__petHttp = function (id, payload) {
    const cb = pendingHttp[id];
    if (!cb) return;
    delete pendingHttp[id];
    let obj;
    try { obj = JSON.parse(payload); } catch (e) { obj = { status: -1, body: String(payload) }; }
    cb(obj);
  };

  const Browser = {
    isNative: false,
    platform: 'web',
    async speak(text, rate) {
      const synth = global.speechSynthesis;
      if (!synth) return { ok: false, reason: 'no-tts' };
      return new Promise((resolve) => {
        try {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(String(text || ''));
          u.lang = 'zh-CN';
          u.rate = Number(rate) || 1;
          u.onend = () => resolve({ ok: true });
          u.onerror = () => resolve({ ok: false, reason: 'tts-error' });
          synth.speak(u);
          setTimeout(() => resolve({ ok: true }), 300);
        } catch (e) { resolve({ ok: false, reason: String(e) }); }
      });
    },
    stopSpeak() { try { global.speechSynthesis && global.speechSynthesis.cancel(); } catch (e) {} },
    async httpPost(url, headers, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: headers || {},
        body: typeof body === 'string' ? body : JSON.stringify(body || {})
      });
      return { status: r.status, body: await r.text() };
    },
    toast(msg) { console.log('[toast]', msg); },
    async exit() { },
    async keepAwake() { return false; },
    async loadKV(key) { try { return global.localStorage.getItem('kv/' + key) || ''; } catch (e) { return ''; } },
    async saveKV(key, value) { try { global.localStorage.setItem('kv/' + key, String(value)); return true; } catch (e) { return false; } },
    log(msg) { console.log('[pet]', msg); },
    getMode() { return 'app'; },
    isStaticRender() { return false; },
    isCrispWindow() { return false; },
    getScreen() { return { w: global.innerWidth, h: global.innerHeight, density: global.devicePixelRatio || 1 }; },
    setWindowSize() { },
    moveWindow() { },
    canOverlay() { return false; },
    requestOverlayPermission() { },
    enterOverlay() { return { ok: false, reason: 'web' }; },
    exitOverlay() { },
    openApp() { }
  };

  const Native = {
    isNative: true,
    platform: platform,

    async speak(text, rate) {
      try {
        const fn = callHost('speak', null);
        if (!fn) return { ok: false, reason: 'no-bridge' };
        const raw = await fn(String(text || ''), Number(rate) || 1);
        return typeof raw === 'string' ? JSON.parse(raw) : (raw || { ok: false });
      } catch (e) { return { ok: false, reason: String(e) }; }
    },
    stopSpeak() { try { const fn = callHost('stopSpeak', null); if (fn) fn(); } catch (e) {} },

    httpPost(url, headers, body) {
      const payload = (typeof body === 'string') ? body : JSON.stringify(body || {});
      const hdr = JSON.stringify(headers || {});
      if (platform === 'android') {
        /* 安卓：@JavascriptInterface 不能返回 Promise，改回调 */
        return new Promise((resolve) => {
          const id = 'r' + (++httpSeq);
          pendingHttp[id] = resolve;
          let attempt = 0;
          const invoke = () => {
            attempt += 1;
            const fn = callHost('httpPostAsync', null);
            if (!fn) { delete pendingHttp[id]; resolve({ status: -1, body: '桥未就绪（no-bridge）' }); return; }
            try {
              fn(id, String(url), hdr, payload);
            } catch (e) {
              /* 桥对象偶发失效（GC/未注入）时重试，两次都不行才报错 */
              if (attempt < 3) { setTimeout(invoke, 200); return; }
              delete pendingHttp[id];
              resolve({ status: -1, body: '桥调用失败：' + String(e) });
            }
          };
          invoke();
          setTimeout(() => {
            if (pendingHttp[id]) { delete pendingHttp[id]; resolve({ status: -1, body: '请求超时' }); }
          }, 200000);
        });
      }
      /* 原生侧直接返回 Promise */
      const fn = callHost('httpPost', null);
      if (!fn) return Promise.resolve({ status: -1, body: 'no-bridge' });
      return fn(String(url), hdr, payload)
        .then((raw) => {
          try {
            const obj = JSON.parse(raw || '{}');
            return { status: obj.status || 0, body: obj.body || '' };
          } catch (e) { return { status: -1, body: String(raw) }; }
        })
        .catch((e) => ({ status: -1, body: String(e) }));
    },

    toast(msg) { try { const fn = callHost('toast', null); if (fn) fn(String(msg)); } catch (e) {} },
    async exit() { try { const fn = callHost('exitApp', null); if (fn) fn(); } catch (e) {} },
    async keepAwake(on) { try { const fn = callHost('keepAwake', null); return fn ? !!fn(!!on) : true; } catch (e) { return false; } },
    async loadKV(key) { try { const fn = callHost('loadKV', null); return fn ? String(fn(String(key)) || '') : ''; } catch (e) { return ''; } },
    async saveKV(key, value) { try { const fn = callHost('saveKV', null); return fn ? !!fn(String(key), String(value)) : false; } catch (e) { return false; } },
    log(msg) { try { const fn = callHost('log', null); if (fn) fn(String(msg)); } catch (e) {} },

    getMode() { try { const fn = callHost('getMode', null); return fn ? String(fn() || 'app') : 'app'; } catch (e) { return 'app'; } },
    /* 悬浮模式下网页跑在整屏渲染窗里：宠物坐标=屏幕坐标，不做任何窗口几何运算 */
    isStaticRender() {
      try { const fn = callHost('isStaticRender', null); return fn ? !!fn() : false; } catch (e) { return false; }
    },
    isCrispWindow() {
      try { const fn = callHost('isCrispWindow', null); return fn ? !!fn() : false; } catch (e) { return false; }
    },
    getScreen() {
      try {
        const fn = callHost('getScreen', null);
        const raw = fn ? fn() : null;
        if (typeof raw === 'string') return JSON.parse(raw);
        if (raw && raw.w) return raw;
      } catch (e) {}
      return { w: global.innerWidth, h: global.innerHeight, density: global.devicePixelRatio || 1 };
    },
    setWindowSize(w, h) { try { const fn = callHost('setWindowSize', null); if (fn) fn(Math.round(w), Math.round(h)); } catch (e) {} },
    moveWindow(x, y) { try { const fn = callHost('moveWindow', null); if (fn) fn(x, y); } catch (e) {} },   // 传小数，交给宿主按物理像素取整
    canOverlay() { try { const fn = callHost('canOverlay', null); return fn ? !!fn() : false; } catch (e) { return false; } },
    requestOverlayPermission() { try { const fn = callHost('requestOverlayPermission', null); if (fn) fn(); } catch (e) {} },
    enterOverlay() {
      try {
        const fn = callHost('enterOverlay', null);
        if (!fn) return { ok: false, reason: 'no-bridge' };
        const raw = fn();
        return typeof raw === 'string' ? JSON.parse(raw) : (raw || { ok: false });
      } catch (e) { return { ok: false, reason: String(e) }; }
    },
    exitOverlay() { try { const fn = callHost('exitOverlay', null); if (fn) fn(); } catch (e) {} },
    openApp() { try { const fn = callHost('openApp', null); if (fn) fn(); } catch (e) {} }
  };

  global.PetBridge = native ? Native : Browser;
})(window);
