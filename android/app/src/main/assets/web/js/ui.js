/* ui.js —— 菜单 / 工具条 / 设置面板 / 聊天面板接线 */
(function (global) {
  'use strict';

  const UI = {
    scene: null,
    chat: null,
    _menuEl: null,

    init(scene, chat) {
      this.scene = scene;
      this.chat = chat;
      this._menuEl = U.$('#menu');
      this.bindToolbar();
      this.bindMenu();
      this.bindSettings();
      this.bindChat();
      this.bindPanels();
      this.refreshFromSettings();
      this.applyBackground();
      this.setEnvHint();
    },

    /* ---------- 工具条 ---------- */
    bindToolbar() {
      U.$('#btn-menu').onclick = (e) => this.openMenu(e.clientX, e.clientY);
      U.$('#btn-chat').onclick = () => this.togglePanel('chat');
      U.$('#btn-settings').onclick = () => this.togglePanel('settings');
      if (PetBridge.isNative && PetBridge.platform === 'android' && !(this.scene && this.scene.overlay)) {
        const btn = U.el('button', 'tb-btn', '🪟');
        btn.id = 'btn-overlay';
        btn.title = '悬浮到桌面';
        btn.onclick = () => this.enterOverlay();
        U.$('#toolbar').appendChild(btn);
      }
      U.$('#btn-hide').onclick = () => {
        Settings.set('showToolbar', false);
        this.refreshToolbar();
      };
      U.$('#btn-show').onclick = () => {
        Settings.set('showToolbar', true);
        this.refreshToolbar();
      };
    },

    refreshToolbar() {
      const on = Settings.get('showToolbar');
      U.$('#toolbar').classList.toggle('hidden', !on);
      U.$('#btn-show').classList.toggle('hidden', !!on);
    },

    applyBackground() {
      document.body.classList.toggle('bg-transparent', !!Settings.get('transparentBg'));
    },

    /* ---------- 菜单 ---------- */
    menuItems() {
      const s = this.scene;
      const hasCompanion = s && s.companionCount() > 0;
      const wander = Settings.get('wander');
      const head = [];
      if (PetBridge.isNative && PetBridge.platform === 'android') {
        head.push(s && s.overlay
          ? { ico: '📱', label: '回到应用（完整设置在这里）', act: () => PetBridge.openApp() }
          : { ico: '🪟', label: '悬浮到桌面（小窗跟着我走）', act: () => this.enterOverlay() });
        head.push({ sep: true });
      }
      return head.concat([
        { ico: '🎬', label: '来一段随机动作', act: () => this.randomAction() },
        { ico: '💬', label: 'AI 对话', act: () => this.togglePanel('chat') },
        { ico: '⚙️', label: '设置', act: () => this.togglePanel('settings') },
        { sep: true },
        { ico: '🐳', label: hasCompanion ? '再叫一只小鲸鱼（最多 4 只）' : '叫一只小鲸鱼', act: () => this.spawnCompanion() },
        { ico: '🌀', label: '收回小鲸鱼', act: () => { this.scene.removeCompanions(); PetBridge.toast('小鲸鱼都回家啦'); } },
        { ico: wander ? '⏸' : '▶️', label: wander ? '停下别动' : '继续自己逛', act: () => this.toggleWander() },
        { sep: true },
        { ico: '📌', label: Settings.get('showToolbar') ? '隐藏工具条' : '显示工具条', act: () => { Settings.set('showToolbar', !Settings.get('showToolbar')); this.refreshToolbar(); } },
        { ico: '🔧', label: '测试原生桥（排错用）', act: () => this.probeBridge() },
        { ico: '⏻', label: '退出桌宠', act: () => PetBridge.exit() }
      ]);
    },

    openMenu(x, y) {
      const el = this._menuEl;
      el.textContent = '';
      this.menuItems().forEach((it) => {
        if (it.sep) { el.appendChild(U.el('div', 'menu-sep')); return; }
        const btn = U.el('button', 'menu-item');
        btn.setAttribute('role', 'menuitem');
        btn.appendChild(U.el('span', 'mi-ico', it.ico));
        btn.appendChild(U.el('span', 'mi-label', it.label));
        btn.onclick = () => { this.closeMenu(); it.act(); };
        el.appendChild(btn);
      });
      el.classList.remove('hidden');
      /* 防溢出 */
      const r = el.getBoundingClientRect();
      const w = this.scene.bounds().w;
      const h = this.scene.bounds().h;
      const px = Math.min(x || w / 2, w - r.width - 10);
      const py = Math.min(y || h / 2, h - r.height - 10);
      el.style.left = Math.max(10, px) + 'px';
      el.style.top = Math.max(10, py) + 'px';
    },

    closeMenu() { if (this._menuEl) this._menuEl.classList.add('hidden'); },
    isMenuOpen() { return this._menuEl && !this._menuEl.classList.contains('hidden'); },

    bindMenu() {
      document.addEventListener('pointerdown', (e) => {
        if (!this.isMenuOpen()) return;
        if (e.target.closest && e.target.closest('#menu')) return;
        this.closeMenu();
      }, true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.closeMenu(); this.closeAllPanels(); }
      });
    },

    randomAction() {
      const primary = this.scene.pets.find((p) => !p.companion);
      if (!primary) return;
      primary.playActs();
    },

    toggleWander() {
      const next = !Settings.get('wander');
      Settings.set('wander', next);
      this.scene.pets.forEach((p) => {
        if (next) p.decide();
        else p.stopWalk();
      });
    },

    spawnCompanion() {
      if (this.scene.companionCount() >= 4) { PetBridge.toast('最多 4 只小鲸鱼'); return; }
      const p = this.scene.spawnCompanion();
      if (p) {
        p.decide();
        const main = this.scene.pets.find((x) => !x.companion);
        if (main) this.scene.say(main, '又生了一只小鲸鱼～');
      }
    },

    /* ---------- 排错 ---------- */
    probeBridge() {
      try {
        const scr = PetBridge.getScreen();
        const kv = PetBridge.loadKV ? 'has-loadKV' : 'no-loadKV';
        PetBridge.toast('桥正常 · 平台 ' + PetBridge.platform + ' · 屏幕 ' + scr.w + 'x' + scr.h + ' · ' + kv);
        PetBridge.log('[probe] ' + JSON.stringify(scr));
      } catch (e) {
        PetBridge.toast('桥异常：' + e);
      }
    },

    /* ---------- 悬浮窗 ---------- */
    enterOverlay() {
      if (!PetBridge.canOverlay()) {
        PetBridge.requestOverlayPermission();
        PetBridge.toast('请在弹出的系统页面里允许「显示在其他应用上层」，然后回来再点一次');
        return;
      }
      const r = PetBridge.enterOverlay();
      if (!r || r.ok !== true) {
        PetBridge.toast('悬浮启动失败：' + ((r && r.reason) || '未知'));
      }
    },

    /* ---------- 面板 ---------- */
    togglePanel(id) {
      const el = U.$('#' + id);
      const willShow = el.classList.contains('hidden');
      this.closeAllPanels();
      if (willShow) {
        el.classList.remove('hidden');
        if (id === 'chat') { this.chat.render(); this.chat.scrollBottom(); }
        if (id === 'settings') this.refreshFromSettings();
      }
    },

    closeAllPanels() {
      U.$$('.panel').forEach((p) => p.classList.add('hidden'));
    },

    bindPanels() {
      U.$$('.panel-close').forEach((btn) => {
        btn.onclick = () => U.$('#' + btn.getAttribute('data-close')).classList.add('hidden');
      });
    },

    /* ---------- 设置面板 ---------- */
    _bindings() {
      /* id = 控件 id 后缀（#set-<id>），out = 数值显示 id 后缀（#out-<out||id>） */
      return [
        { id: 'scale', key: 'scale', out: 'size', fmt: (v) => Number(v).toFixed(2) + '×' },
        { id: 'overlaycrisp', key: 'overlayCrisp' },
        { id: 'overlaypunch', key: 'overlayPunch', out: 'punch', fmt: (v) => Math.round(Number(v) * 100) + '%' },
        { id: 'toolbar', key: 'showToolbar' },
        { id: 'transparent', key: 'transparentBg' },
        { id: 'gravity', key: 'gravity' },
        { id: 'wander', key: 'wander' },
        { id: 'random', key: 'randomActions' },
        { id: 'speech', key: 'speech' },
        { id: 'bubble', key: 'bubbleSeconds', fmt: (v) => Number(v).toFixed(1) + ' 秒' },
        { id: 'interval-min', key: 'intervalMin', out: 'interval' },
        { id: 'interval-max', key: 'intervalMax', out: 'interval' },
        { id: 'phrases', key: 'phrases' },
        { id: 'sound', key: 'clickSound' },
        { id: 'volume', key: 'clickVolume', fmt: (v) => Math.round(Number(v) * 100) + '%' },
        { id: 'companions', key: 'companions' },
        { id: 'collision', key: 'collision' },
        { id: 'restitution', key: 'restitution', fmt: (v) => Number(v).toFixed(2) },
        { id: 'ai-base', key: 'aiBase' },
        { id: 'ai-key', key: 'aiKey' },
        { id: 'ai-model', key: 'aiModel' },
        { id: 'ai-temp', key: 'aiTemp', out: 'temp', fmt: (v) => Number(v).toFixed(1) },
        { id: 'aimax', key: 'aiMaxTokens', out: 'maxtok', fmt: (v) => Math.round(Number(v)) + ' tokens' },
        { id: 'ai-prompt', key: 'aiPrompt' },
        { id: 'tts', key: 'tts' },
        { id: 'tts-rate', key: 'ttsRate', out: 'tts', fmt: (v) => Number(v).toFixed(1) + '×' },
        { id: 'history', key: 'historyTurns', fmt: (v) => String(v) + ' 轮' }
      ];
    },

    /* 把某条绑定的当前值写进它对应的 <output> */
    syncOut(b) {
      const outId = b.out || b.id;
      const o = U.$('#out-' + outId);
      if (!o) return;
      if (outId === 'interval') {
        o.textContent = `${Settings.get('intervalMin')}–${Settings.get('intervalMax')} 秒`;
        return;
      }
      const el = U.$('#set-' + b.id);
      if (!el) return;
      const raw = el.type === 'checkbox' ? el.checked : el.value;
      o.textContent = b.fmt ? b.fmt(raw) : String(raw);
    },

    bindSettings() {
      this._map = this._bindings();
      this._map.forEach((b) => {
        const el = U.$('#set-' + b.id);
        if (!el) return;
        const evt = (el.type === 'checkbox' || el.tagName === 'TEXTAREA') ? 'change'
          : (el.type === 'range' ? 'input' : 'change');
        el.addEventListener(evt, () => {
          Settings.set(b.key, el.type === 'checkbox' ? el.checked : el.value);
          this.syncOut(b);
          /* 说话间隔两个滑块共用同一个显示 */
          if (b.out === 'interval') this._map.filter((x) => x.out === 'interval').forEach((x) => this.syncOut(x));
        });
      });

      U.$('#btn-try-sound').onclick = () => this.scene.playClickSound();
      U.$('#btn-reset').onclick = () => {
        Settings.reset();
        this.refreshFromSettings();
        this.applyRuntimeChanges('*');
        PetBridge.toast('已恢复出厂设置');
      };
    },

    refreshFromSettings() {
      if (!this._map) return;
      this._map.forEach((b) => {
        const el = U.$('#set-' + b.id);
        if (!el) return;
        const v = Settings.get(b.key);
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
        this.syncOut(b);
      });
      this.refreshToolbar();
    },

    applyRuntimeChanges(key) {
      if (key === 'scale' || key === '*') this.scene.applyScale();
      if (key === 'transparentBg' || key === '*') this.applyBackground();
      if (key === 'companions' || key === '*') {
        if (Settings.get('companions')) {
          if (this.scene.companionCount() === 0) this.scene.spawnCompanion();
        } else {
          this.scene.removeCompanions();
        }
      }
      if (key === 'showToolbar' || key === '*') this.refreshToolbar();
      if (key === 'speech' && Settings.get('speech') === false) this.scene.hideBubble();
    },

    /* ---------- 聊天面板 ---------- */
    bindChat() {
      const input = U.$('#chat-input');
      const send = () => {
        const text = input.value;
        input.value = '';
        input.style.height = 'auto';
        this.chat.send(text);
      };
      U.$('#chat-send').onclick = send;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      });
      U.$('#chat-clear').onclick = () => this.chat.clear();
    },

    /* ---------- toast ---------- */
    toast(msg, ms) {
      const el = U.$('#toast');
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 1800);
    },

    setEnvHint() {
      const el = U.$('#env-hint');
      if (!el) return;
      const parts = [];
      /* 运行环境按真实平台显示 */
      let platName = '浏览器预览模式';   // 只区分安卓 / 浏览器
      if (PetBridge.isNative) {
        let plat = '';
        try { plat = String((PetBridge.getPlatform && PetBridge.getPlatform()) || '').toLowerCase(); } catch (e) {}
        platName = plat === 'android' ? '安卓' : '';
      }
      parts.push(platName ? '运行环境：' + platName : '运行环境：安卓');
      if (this.scene.manifest) {
        const n = (this.scene.manifest.clips || []).length;
        parts.push(`素材：${n} 段动画，${this.scene.manifest.fps || 24} fps`);
      }
      parts.push('提示：点一下 = 互动，按住拖 = 挪位置，长按 / 右键 = 菜单，双击 = 跳一下');
      el.textContent = parts.join(' · ');
    }
  };

  global.UI = UI;
})(window);
