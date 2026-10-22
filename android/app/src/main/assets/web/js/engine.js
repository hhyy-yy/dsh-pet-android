/* engine.js —— 场景：加载素材、驱动逐帧、碰撞、输入、气泡、音效 */
(function (global) {
  'use strict';

  const MAX_COMPANIONS = 4;

  /* 宿主确认"窗口新几何已生效"的回调（拖拽前后切换坐标系用，避免闪烁） */
  if (typeof window !== 'undefined') {
    window.__winApplied = function (x, y, w, h) {
      const s = window.__scene;
      if (!s) return;
      /* 兜底：宿主万一又把物理像素发过来（w 明显大于屏幕 CSS 宽），按比例纠正一次 */
      const swCss = (s.screen && s.screen.w) || window.innerWidth || 1;
      if (w > swCss * 1.5) {
        const k = w / swCss;
        try { PetBridge.log('[geo] ack looks like physical px, divide by ' + k.toFixed(2)); } catch (e) {}
        x = x / k; y = y / k; w = w / k; h = h / k;
      }
      try { PetBridge.log('[geo] ack x=' + Math.round(x) + ' y=' + Math.round(y) + ' w=' + Math.round(w) + ' h=' + Math.round(h)); } catch (e) {}
      s._winW = w;
      s._winH = h;
      s._lastWin = { x: x, y: y };
      s._winPending = false;

      /* 取景框要求整屏，但系统可能给不到那么高：这时把窗口贴到屏幕下沿，
         这样宠物仍能走到屏幕最底部（否则就是"底部空气墙"）。 */
      const scr = s.screen || {};
      if (s._dragWin && scr.h && h < scr.h - 4) {
        const bottomY = scr.h - h;
        try { PetBridge.log('[geo] cam window shorter than screen, align to bottom y=' + Math.round(bottomY)); } catch (e) {}
        s._lastWin = { x: 0, y: bottomY };
        PetBridge.moveWindow(0, bottomY);
      }

      s.pets.forEach((p) => p.layout());
      /* 原生窗口的提交要比这次回调晚一帧，等两帧再亮，
         否则会先按新坐标画在旧窗口位置上（表现为"从屏幕顶部闪下来"）。 */
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => s._geoHide(false)));
      } else {
        setTimeout(() => s._geoHide(false), 34);
      }
    };
  }


  /* 双窗口模式：隐形触摸窗收到的手指，由原生转发到这里（屏幕 CSS 坐标） */
  if (typeof window !== 'undefined') {
    let lastType = '';
    window.__petTouch = function (type, x, y) {
      const s = window.__scene;
      if (!s || !s.stage) return;
      const mk = (name) => {
        try {
          return new PointerEvent(name, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, pointerType: 'touch', isPrimary: true,
            clientX: x, clientY: y, x: x, y: y,
          });
        } catch (e) {
          return null;
        }
      };
      if (type === 'down') {
        const ev = mk('pointerdown');
        /* 必须派发到宠物元素上：事件处理器靠 e.target.closest('.pet') 判断点到了谁，
           派给 stage 会被当成"点空白"（不触发拖拽）。 */
        let target = null;
        try { target = document.elementFromPoint(x, y); } catch (e) {}
        if (!target || !target.closest || !target.closest('.pet')) {
          target = (s.pets[0] && s.pets[0].el) || s.stage;
        }
        if (ev) target.dispatchEvent(ev);
      } else if (type === 'move') {
        const ev = mk('pointermove');
        if (ev) window.dispatchEvent(ev);
      } else if (type === 'up' || type === 'cancel') {
        const ev = mk('pointerup');
        if (ev) window.dispatchEvent(ev);
      }
      lastType = type;
    };
  }

  /* 原生侧通知"方向变了"：重读屏幕几何并整体重排 */
  if (typeof window !== 'undefined') {
    window.__orientationChanged = function () {
      const s = window.__scene;
      if (!s) return;
      try {
        if (s.overlay && global.PetBridge && PetBridge.getScreen) s.screen = PetBridge.getScreen();
      } catch (e) {}
      s.onResize();
      s.pets.forEach((p) => { p.applyScale(); p.layout(); });
      try { PetBridge.log('[geo] orientation -> screen=' + s.screen.w + 'x' + s.screen.h); } catch (e) {}
    };
  }

  class Scene {
    constructor() {
      this.stage = U.$('#stage');
      this.bubbleEl = U.$('#bubble');
      this.bubbleText = U.$('.bubble-text', this.bubbleEl);

      /* 素材目录：默认 assets/，可用 ?assets=dir 指定（便于灰度/替换素材包） */
      const q = new URLSearchParams(location.search || '');
      this.assetBase = (q.get('assets') || 'assets').replace(/\/+$/, '') + '/';

      /* 宿主模式：app = 应用内全屏；overlay = 安卓悬浮小窗（窗口跟随宠物移动） */
      this.mode = q.get('mode') || ((global.PetBridge && PetBridge.getMode) ? PetBridge.getMode() : 'app');
      /* 悬浮模式下网页跑在整屏渲染窗里（窗口永不动）：宠物坐标就是屏幕坐标，
         所有窗口几何操作都跳过——那些才是闪烁的根源。 */
      this.overlay = (this.mode === 'overlay');
      let staticRender = false;
      try { staticRender = !!(global.PetBridge && PetBridge.isStaticRender && PetBridge.isStaticRender()); } catch (e) {}
      this.staticRender = staticRender && this.overlay;   // 必须在 overlay 之后求值
      let crisp = false;
      try { crisp = !!(global.PetBridge && PetBridge.isCrispWindow && PetBridge.isCrispWindow()); } catch (e) {}
      this.crispWindow = crisp && this.overlay;   // 窗口就只有宠物那么大，宠物钉在窗口内
      this.screen = this.overlay ? PetBridge.getScreen() : { w: 1280, h: 800, density: 1 };
      /* 悬浮渲染窗是整屏的 → viewport 就是真实可画区域；若两者差异过大，
         以 viewport 为准（避免"按竖屏尺寸画在横屏上"导致宠物跑到屏外）。 */
      if (this.overlay) {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        if (vw > 0 && vh > 0 &&
            (Math.abs(vw - this.screen.w) > this.screen.w * 0.2 ||
             Math.abs(vh - this.screen.h) > this.screen.h * 0.2)) {
          this.screen = { w: vw, h: vh, density: this.screen.density || 1 };
        }
      }
      this._winW = 0;
      this._winH = 0;
      this._winTick = 0;
      this._lastWin = (this.overlay && !this.crispWindow) ? { x: 0, y: 0 } : { x: -9999, y: -9999 };
      if (this.overlay) {
        document.body.classList.add('overlay');
        if (!this.crispWindow) this._lastWin = { x: 0, y: 0 };
      }

      this.manifest = null;
      this.pets = [];
      this.paused = false;
      this._lastT = 0;
      this._raf = 0;
      this._bubbleTimer = 0;
      this._bubbleOwner = null;
      this._audio = {};
      this._input = null;
      this._menuOpen = false;
    }

    /* ---------- 素材 ---------- */
    async load() {
      /* 某些源（file://）下 fetch 相对路径不一定可用，优先用构建期生成的内联清单 */
      if (global.PET_MANIFEST && this.assetBase === 'assets/') {
        this.manifest = global.PET_MANIFEST;
        this._preloadSounds();
        return this.manifest;
      }
      const res = await fetch(this.assetBase + 'manifest.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('manifest.json 读取失败: ' + res.status);
      this.manifest = await res.json();
      this._preloadSounds();
      return this.manifest;
    }

    assetUrl(file) { return this.assetBase + String(file).replace(/^\/+/, ''); }

    _preloadSounds() {
      const sounds = this.manifest.sounds || {};
      Object.keys(sounds).forEach((k) => {
        const a = new Audio(this.assetUrl(sounds[k]));
        a.preload = 'auto';
        this._audio[k] = a;
      });
    }

    playSound(key, volume) {
      if (Settings.get('clickSound') === false) return;
      const base = this._audio[key] || this._audio.click;
      if (!base) return;
      const vol = volume == null ? (Number(Settings.get('clickVolume')) || 0.7) : volume;
      try {
        const a = base.cloneNode(true);
        a.volume = U.clamp(vol, 0, 1);
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* 静默失败：某些 WebView 需要用户手势后才允许播放 */ }
    }

    playClickSound() {
      const vol = Number(Settings.get('clickVolume'));
      /* 桌面版是"按下 Ya1 + 松开 Ya2"两声（duck/*），缺资源时退到 click.wav */
      this.playSound(this._audio.duck_ya1 ? 'duck_ya1' : 'click', vol * 0.95);
      setTimeout(() => {
        this.playSound(this._audio.duck_ya2 ? 'duck_ya2' : 'click', vol * 0.85);
      }, 80);
    }

    phrasePool() { return Settings.phrasePool(); }

    /* ---------- 边界 ---------- */
    bounds() {
      if (this.overlay) {
        /* 悬浮模式：整块屏幕都是活动范围（上下左右都能走），
           窗口只是一个跟着宠物移动的"取景框" */
        const sw = Math.max(1, this.screen.w || window.innerWidth);
        const sh = Math.max(1, this.screen.h || window.innerHeight);
        return { w: sw, h: sh, floor: sh - 2 };
      }
      const w = this.stage.clientWidth || window.innerWidth;
      const h = this.stage.clientHeight || window.innerHeight;
      const floorPad = Math.max(6, Math.round(h * 0.012));
      return { w, h, floor: h - floorPad };
    }

    /* ---------- 宠物管理 ---------- */
    spawnPrimary() {
      const p = new Pet(this, { manifest: this.manifest, companion: false });
      this.pets.push(p);
      return p;
    }

    spawnCompanion() {
      const companions = this.pets.filter((p) => p.companion);
      if (companions.length >= MAX_COMPANIONS) return null;
      const p = new Pet(this, { manifest: this.manifest, companion: true });
      const base = this.pets.find((x) => !x.companion);
      const b = this.bounds();
      if (base) {
        /* 找一个离所有已存在的宠物都不太近的落点 */
        let bestX = base.x + (companions.length % 2 === 0 ? 1 : -1) * p.w * 0.9;
        for (let i = 0; i < 12; i++) {
          const cand = U.clamp(base.x + U.rand(-1, 1) * b.w * 0.32, p.w, b.w - p.w);
          const far = this.pets.every((q) => Math.abs(q.x - cand) > p.w * 0.72);
          if (far) { bestX = cand; break; }
          bestX = cand;
        }
        p.x = U.clamp(bestX, p.w / 2, b.w - p.w / 2);
        p.y = base.y;
      }
      this.pets.push(p);
      return p;
    }

    removeCompanions() {
      const keep = [];
      this.pets.forEach((p) => { if (p.companion) p.destroy(); else keep.push(p); });
      this.pets = keep;
    }

    companionCount() { return this.pets.filter((p) => p.companion).length; }

    applyScale() {
      this.pets.forEach((p) => p.applyScale());
      this.layoutAll();
    }

    layoutAll() {
      const b = this.bounds();
      this.pets.forEach((p) => {
        p.x = U.clamp(p.x, p.w / 2, Math.max(p.w / 2, b.w - p.w / 2));
        p.y = Math.min(p.y, b.floor);
        p.layout();
      });
    }

    /* ---------- 气泡 ---------- */
    say(pet, text) {
      if (!text || Settings.get('speech') === false) return;
      if (this.overlay) { PetBridge.toast(text); return; }
      const b = this.bounds();
      const head = pet.manifest.head_box || [185, 60, 436, 195];
      const crop = pet.manifest.crop || { x: 0, y: 0 };
      const headTop = (head[1] - crop.y) * pet.scale;
      const headCx = ((head[0] + head[2]) / 2 - crop.x) * pet.scale;
      const originX = pet.x - pet.w / 2;
      const originY = pet.y - pet.h;
      let left = originX + headCx;
      let top = originY + headTop - 12;

      this.bubbleText.textContent = text;
      this.bubbleEl.classList.remove('hidden');
      /* 先显示再量尺寸，保证不越界 */
      const bw = this.bubbleEl.offsetWidth;
      left = U.clamp(left, bw / 2 + 8, b.w - bw / 2 - 8);
      top = Math.max(top, this.bubbleEl.offsetHeight + 8);
      this.bubbleEl.style.left = left.toFixed(1) + 'px';
      this.bubbleEl.style.top = top.toFixed(1) + 'px';

      this._bubbleOwner = pet;
      this._bubbleTimer = (Number(Settings.get('bubbleSeconds')) || 3.2) * 1000;
    }

    hideBubble() {
      this.bubbleEl.classList.add('hidden');
      this._bubbleOwner = null;
      this._bubbleTimer = 0;
    }

    /* ---------- 主循环 ---------- */
    start() {
      if (this._raf) return;
      this._lastT = U.now();
      const loop = (t) => {
        this._raf = requestAnimationFrame(loop);
        let dt = (t - this._lastT) / 1000;
        this._lastT = t;
        if (dt > 0.1) dt = 0.1;            // 切前台/掉帧保护
        if (dt <= 0) return;
        this.update(dt);
      };
      this._raf = requestAnimationFrame(loop);
    }

    update(dt) {
      this._frames = (this._frames || 0) + 1;
      if (this.paused) return;

      this.pets.forEach((p) => p.tick(dt));

      if (Settings.get('collision') !== false && this.pets.length > 1) {
        this.resolveCollisions(dt);
      }

      if (this._winPending && U.now() - (this._winTimer || 0) > 150) {
        /* 宿主没回调就当它已生效，采纳请求值——否则 _winW/_lastWin 永远停在旧值，
           宠物会一直被画到窗口外（表现为"能按到但看不见"）。 */
        this._winPending = false;
        if (this._reqWin) {
          this._winW = this._reqWin.w;
          this._winH = this._reqWin.h;
          this._lastWin = { x: this._reqWin.x, y: this._reqWin.y };
          this._reqWin = null;
          this.pets.forEach((pt) => pt.layout());
        }
      }
      if (this._geoHiddenAt && U.now() - this._geoHiddenAt > 400) {
        this._geoHide(false);   // 兜底：确认迟迟不来也要把画面亮回来
      }
      if (this.overlay) this.syncWindow();

      if (this._bubbleTimer > 0) {
        this._bubbleTimer -= dt * 1000;
        if (this._bubbleTimer <= 0) this.hideBubble();
        else if (this._bubbleOwner && !this._bubbleOwner.dragging) {
          /* 气泡跟随 */
          const pet = this._bubbleOwner;
          const head = pet.manifest.head_box || [185, 60, 436, 195];
          const crop = pet.manifest.crop || { x: 0, y: 0 };
          const originX = pet.x - pet.w / 2;
          const originY = pet.y - pet.h;
          const headTop = (head[1] - crop.y) * pet.scale;
          const headCx = ((head[0] + head[2]) / 2 - crop.x) * pet.scale;
          const b = this.bounds();
          const bw = this.bubbleEl.offsetWidth;
          const left = U.clamp(originX + headCx, bw / 2 + 8, b.w - bw / 2 - 8);
          this.bubbleEl.style.left = left.toFixed(1) + 'px';
          this.bubbleEl.style.top = Math.max(originY + headTop - 12, this.bubbleEl.offsetHeight + 8).toFixed(1) + 'px';
        }
      }
    }

    /* 悬浮模式：窗口尺寸/位置跟着宠物走（窗口即"摄像机"） */
    syncWindow(force) {
      /* 静态渲染（双窗口）模式：宠物自己由 CSS 摆位，这里只把"隐形触摸窗"
         挪到宠物身上——它是看不见的，怎么动都不会闪。 */
      if (this.staticRender) {
        const pet0 = this.pets[0];
        if (!pet0) return;
        const hw = Math.round(pet0.w);
        const hh = Math.round(pet0.h);
        if (hw !== this._winW || hh !== this._winH) {
          this._winW = hw;
          this._winH = hh;
          PetBridge.setWindowSize(hw, hh);
        }
        const nowS = U.now();
        if (!force && nowS - this._winTick < 12) return;
        this._winTick = nowS;
        const hx = pet0.x - hw / 2;
        const hy = pet0.y - hh;
        this._lastWin = { x: 0, y: 0 };   // 渲染坐标系永远是屏幕坐标
        PetBridge.moveWindow(hx, hy);
        return;
      }

      const pet = this.pets[0];
      if (!pet) return;

      /* 正在等待宿主确认窗口几何：这段时间继续用旧坐标系画，
         等 __winApplied 回来再切换——这样拖拽/松手时不会闪。 */
      if (this._winPending) return;

      const sw = Math.max(1, this.screen.w || window.innerWidth);
      const sh = Math.max(1, this.screen.h || window.innerHeight);
      const petW = Math.round(pet.w);
      const petH = Math.round(pet.h);

      if (this._dragWin) {
        try { PetBridge.log('[geo] dragWin request size=' + Math.round(sw) + 'x' + Math.round(sh)); } catch (e) {}
        /* 拖拽期间：窗口固定为整屏、原点 (0,0)，宠物在窗口内用 CSS 平移（绝对跟手，
           系统和窗口一次都不动）。等宿主确认后再把坐标系切到 (0,0)。 */
        const needSize = (this._winW !== Math.round(sw) || this._winH !== Math.round(sh));
        this._camN = (this._camN || 0) + 1;
        if (this._camN % 20 === 1) {
          try {
            PetBridge.log('[geo] cam tick win=(' + Math.round(this._lastWin.x) + ',' + Math.round(this._lastWin.y) +
              ') size=' + (this._winW|0) + 'x' + (this._winH|0) + ' needSize=' + needSize);
          } catch (e) {}
        }
        if (needSize) {
          /* 需要改尺寸 → 走握手，等宿主确认后再切坐标系（否则闪） */
          if (this._geoPendingHide) { this._geoHide(true); this._geoPendingHide = false; }
          this._winPending = true;
          this._winTimer = U.now();
          this._reqWin = { x: 0, y: 0, w: Math.round(sw), h: Math.round(sh) };
          PetBridge.setWindowSize(Math.round(sw), Math.round(sh));
          PetBridge.moveWindow(0, 0);
          return;
        }
        if (this._lastWin.x !== 0 || this._lastWin.y !== 0) {
          /* 尺寸已经等于整屏时窗口原点必然是 (0,0)，直接切，不用等 */
          this._lastWin = { x: 0, y: 0 };
        }
        pet.layout();
        return;
      }

      /* 非拖拽：窗口 = min(宠物, 屏幕)，跟随宠物 */
      const wantW = Math.min(sw, petW);
      const wantH = Math.min(sh, petH);
      /* 窗口必须始终对准宠物，不能 clamp 到屏幕内：
         宠物 352 宽、屏 384 时窗口只能横向挪 32px，再多就被窗口裁掉 → 看起来一闪一闪
         （撞墙弹的时候最明显）。允许窗口探出屏幕，可见部分才永远完整。 */
      const wx = pet.x - wantW / 2;
      const wy = pet.y - wantH;

      if (wantW !== this._winW || wantH !== this._winH) {
        if (this._geoPendingHide) { this._geoHide(true); this._geoPendingHide = false; }
        this._winPending = true;
        this._winTimer = U.now();
        this._reqWin = { x: wx, y: wy, w: wantW, h: wantH };   // 记下目标，超时自己采纳
        PetBridge.setWindowSize(wantW, wantH);
        PetBridge.moveWindow(wx, wy);
        return;
      }

      const now = U.now();
      if (this._input && this.overlay) {
        this._mvN = (this._mvN || 0) + 1;
        if (this._mvN % 3 === 1) {
          try {
            PetBridge.log('[geo] dragMove want=(' + Math.round(wx) + ',' + Math.round(wy) + ') last=(' +
              Math.round(this._lastWin.x) + ',' + Math.round(this._lastWin.y) + ') vw=' +
              Math.round(window.innerWidth) + 'x' + Math.round(window.innerHeight));
          } catch (e) {}
        }
      }
      if (!force && now - this._winTick < 12) return;
      if (Math.abs(wx - this._lastWin.x) < 0.02 && Math.abs(wy - this._lastWin.y) < 0.02) return;
      this._winTick = now;
      this._lastWin = { x: wx, y: wy };
      PetBridge.moveWindow(wx, wy);
    }

    /* 三圆链内切圆（collision.py:163-173）：r = min(w,h)/2，沿长轴排三个等半径圆 */
    _circles(pet) {
      const r = pet.bodyRect();
      const w = Math.max(1, r.w);
      const h = Math.max(1, r.h);
      const rad = Math.min(w, h) / 2;
      const cx = r.l + w / 2;
      const cy = r.t + h / 2;
      if (w >= h) {
        return [
          { x: r.l + rad, y: cy, r: rad },
          { x: cx, y: cy, r: rad },
          { x: r.l + w - rad, y: cy, r: rad }
        ];
      }
      return [
        { x: cx, y: r.t + rad, r: rad },
        { x: cx, y: cy, r: rad },
        { x: cx, y: r.t + h - rad, r: rad }
      ];
    }

    resolveCollisions() {
      const rest = Number(Settings.get('restitution'));
      const eBase = Number.isFinite(rest) ? U.clamp(rest, 0, 1) : 0.82;
      const FRICTION = 0.08;       // collision_friction 默认
      const IMPULSE_CAP = 9000;    // collision_impulse_cap 默认（等效每质量 px/s）
      const SLOP = 0.5;
      const list = this.pets;
      const b = this.bounds();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j];
          if (A.dragging || B.dragging) continue;
          const ca = this._circles(A);
          const cb = this._circles(B);
          let best = null;
          for (let m = 0; m < ca.length; m++) {
            for (let n = 0; n < cb.length; n++) {
              const a = ca[m], c = cb[n];
              const dx = c.x - a.x, dy = c.y - a.y;
              const d = Math.hypot(dx, dy) || 0.001;
              const overlap = (a.r + c.r) - d;
              if (overlap > 0 && (!best || overlap > best.overlap)) {
                best = { overlap, nx: dx / d, ny: dy / d };
              }
            }
          }
          if (!best) continue;

          const invA = A.mass > 0 ? 1 / A.mass : 0;
          const invB = B.mass > 0 ? 1 / B.mass : 0;
          const sumInv = invA + invB;
          if (sumInv <= 0) continue;

          /* 位置分离：slop 0.5px，0.6 系数，单次 1~12px，按逆质量分摊 */
          const eff = Math.max(0, best.overlap - SLOP);
          const sep = U.clamp(eff * 0.6, 1.0, 12.0);
          A.x -= best.nx * sep * (invA / sumInv);
          A.y -= best.ny * sep * (invA / sumInv);
          B.x += best.nx * sep * (invB / sumInv);
          B.y += best.ny * sep * (invB / sumInv);

          /* 法向冲量 + 切向库仑摩擦 */
          const rvx = B.vx - A.vx;
          const rvy = B.vy - A.vy;
          const vn = rvx * best.nx + rvy * best.ny;
          if (vn < 0) {
            const e = (vn >= -1.0) ? 0 : eBase;      // 低速接触改非弹性
            let jn = -(1 + e) * vn / sumInv;
            const maxJ = IMPULSE_CAP / Math.max(invA, invB);
            jn = Math.min(jn, maxJ);

            const tx = -best.ny, ty = best.nx;
            const vt = rvx * tx + rvy * ty;
            const jtIdeal = -vt / sumInv;
            const muMax = FRICTION * Math.abs(jn);
            const jt = U.clamp(jtIdeal, -muMax, muMax);

            const Jx = jn * best.nx + jt * tx;
            const Jy = jn * best.ny + jt * ty;
            A.vx -= Jx * invA;
            A.vy -= Jy * invA;
            B.vx += Jx * invB;
            B.vy += Jy * invB;

            if (Math.abs(jn) > 60) { A.squashT = 0; B.squashT = 0; }
            if (A.state === 'idle' && Math.hypot(A.vx, A.vy) > 30) A.state = 'thrown';
            if (B.state === 'idle' && Math.hypot(B.vx, B.vy) > 30) B.state = 'thrown';
          }

          A.x = U.clamp(A.x, A.w / 2, Math.max(A.w / 2, b.w - A.w / 2));
          B.x = U.clamp(B.x, B.w / 2, Math.max(B.w / 2, b.w - B.w / 2));
          A.layout(); B.layout();
        }
      }
    }

    /* 悬浮窗里触摸坐标是"窗口本地"的，而宠物位置是"屏幕"的。
       窗口本身还在跟着宠物移动，所以必须换算，否则 grab 偏移会漂 → 拖拽一格一格跳。 */
    /* 几何切换（宠物小窗 ↔ 整屏取景框）期间藏一两帧：
       WebView 视口先变、坐标系晚一帧才变，中间那一帧会把宠物画错位置（就是"闪"）。
       藏起来比闪一下舒服，代价约 30ms。 */
    _geoHide(on) {
      /* 显示/隐藏改由原生侧负责（OverlayService.setWindowSize 里做），
         这里保留空实现，避免两套机制互相打架。 */
      this._geoHiddenAt = 0;
    }

    _toScreen(pt) {
      if (!this.overlay) return pt;
      return { x: (this._lastWin.x || 0) + pt.x, y: (this._lastWin.y || 0) + pt.y };
    }

    /* ---------- 输入 ----------
     * handlers: { onPetLongPress(pet, ev), onBackgroundTap(ev), onBackgroundLongPress(ev) }
     */
    bindInput(handlers) {
      const h = (typeof handlers === 'function')
        ? { onPetLongPress: handlers }
        : (handlers || {});
      const longPressMs = 550;
      let lpTimer = 0;
      let bgTimer = 0;

      const posOf = (e) => {
        const rect = this.stage.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };
      const clearBG = () => { if (bgTimer) { clearTimeout(bgTimer); bgTimer = 0; } };

      this.stage.addEventListener('pointerdown', (e) => {
        const el = e.target.closest && e.target.closest('.pet');
        if (!el) {
          /* 空白处：先关面板；按住 450ms 才算"叫菜单" */
          if (h.onBackgroundTap) h.onBackgroundTap(e);
          clearBG();
          const bx = e.clientX, by = e.clientY;
          bgTimer = setTimeout(() => {
            bgTimer = 0;
            if (h.onBackgroundLongPress) h.onBackgroundLongPress({ clientX: bx, clientY: by });
          }, 450);
          const cancel = () => { clearBG(); window.removeEventListener('pointerup', cancel); };
          window.addEventListener('pointerup', cancel);
          return;
        }
        const pet = this.pets.find((p) => p.el === el);
        if (!pet) return;
        e.preventDefault();
        const pLocal = posOf(e);
        const p = this._toScreen(pLocal);
        const grab = { dx: pet.x - p.x, dy: pet.y - p.y };
        const start = U.now();
        let moved = 0;
        let longPressed = false;

        pet.beginDrag();
        if (this.overlay) {
          /* 拖拽期间窗口固定成整屏、宠物在窗口内纯 CSS 平移：
             根本不存在"窗口还没到位、坐标已乐观更新"的错位（那正是拖拽成片闪的原因）。
             切换窗口尺寸的那一瞬由原生 alpha 隐藏兜住。 */
          this._dragWin = true;
          this._geoHide(true);   // 先藏（并让它真的绘制出来），下一帧再改窗口几何
          this._hiddenFirst = true;
          try {
            PetBridge.log('[geo] dragStart cam=' + this._dragWin + ' win=(' + Math.round(this._lastWin.x) + ',' +
              Math.round(this._lastWin.y) + ') size=' + (this._winW|0) + 'x' + (this._winH|0) +
              ' pet=(' + Math.round(pet.x) + ',' + Math.round(pet.y) + ') pw=' + Math.round(pet.w) + ' ph=' + Math.round(pet.h) +
              ' vw=' + Math.round(window.innerWidth) + 'x' + Math.round(window.innerHeight));
          } catch (e) {}
          /* 先让"隐藏"真正绘制出来（一帧），再改窗口几何，避免中间那一帧画错 */
          requestAnimationFrame(() => this.syncWindow(true));
        }
        this._input = { pet, pointerId: e.pointerId, start, grab };

        clearLP();
        lpTimer = setTimeout(() => {
          longPressed = true;
          pet.endDrag();
          if (this.overlay) {
            this._dragWin = false;
            this._geoHide(true);
            try { PetBridge.log('[geo] dragEnd pet=(' + Math.round(pet.x) + ',' + Math.round(pet.y) + ')'); } catch (e) {}
            requestAnimationFrame(() => this.syncWindow(true));
          }
          this._input = null;
          if (h.onPetLongPress) h.onPetLongPress(pet, e);
        }, longPressMs);

        const dragSlop = Math.max(6, (Pet.CONST ? Pet.CONST.DRAG_THRESHOLD : 5) * pet.scale);
        const onMove = (ev) => {
          if (!this._input || ev.pointerId !== this._input.pointerId) return;
          const q = this._toScreen(posOf(ev));
          moved = Math.max(moved, Math.hypot(q.x - p.x, q.y - p.y));
          if (moved > dragSlop) clearLP();
          pet.dragTo(q.x + grab.dx, q.y + grab.dy);
          /* 悬浮窗里：拖拽要立刻跟手，不能等下一帧 rAF（否则就是"一格一格") */
          if (this.overlay) this.syncWindow(true);
        };

        const onUp = (ev) => {
          if (!this._input || ev.pointerId !== this._input.pointerId) return;
          clearLP();
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          this._input = null;
          if (this.overlay) {
            this._dragWin = false;
            this._geoHide(true);          // 松手同样：先藏，再改几何，最后亮
            try { PetBridge.log('[geo] dragEnd pet=(' + Math.round(pet.x) + ',' + Math.round(pet.y) + ')'); } catch (e) {}
            requestAnimationFrame(() => this.syncWindow(true));
          }
          if (longPressed) return;
          const dur = U.now() - start;
          if (moved < dragSlop && dur < 520) {
            pet.endDrag();
            pet.click();
            return;
          }
          /* 松手初速由 Pet 内部按桌面公式（physics.py）估算 */
          pet.endDrag();
        };

        window.addEventListener('pointermove', onMove, { passive: true });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }, { passive: false });

      /* 右键菜单（桌面鼠标 / 平板外接鼠标） */
      this.stage.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const el = e.target.closest && e.target.closest('.pet');
        const pet = el ? this.pets.find((p) => p.el === el) : null;
        if (h.onPetLongPress) h.onPetLongPress(pet, e);
      });

      /* 双击 = 让她跳一下 */
      this.stage.addEventListener('dblclick', (e) => {
        const el = e.target.closest && e.target.closest('.pet');
        const pet = el ? this.pets.find((p) => p.el === el) : null;
        if (pet) {
          pet.vy = -1400;
          pet.playAnimOnly('idle');
          pet.state = 'thrown';
        }
      });
    }

    onResize() {
      this.layoutAll();
      if (this._bubbleOwner) this.hideBubble();
    }
  }

  global.Scene = Scene;
})(window);
