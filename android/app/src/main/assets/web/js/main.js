/* main.js —— 启动入口 */
(function (global) {
  'use strict';

  let BOOT_ID = 0;

  async function boot() {
    /* 幂等锁：同一页面只允许启动一次。安卓上偶发重复触发（视图重建/重载）会导致
       一只变两只——加锁后天然免疫。 */
    if (global.__booted) {
      try { PetBridge.log('[boot] duplicate boot ignored'); } catch (e) {}
      return;
    }
    global.__booted = true;
    const bootId = ++BOOT_ID;

    /* 原生偏好优先：file:// 源下 localStorage 不保证可用 */
    try {
      const kv = await PetBridge.loadKV('settings');
      if (kv) Settings.hydrate(kv);
    } catch (e) { /* noop */ }

    const scene = new Scene();
    global.__scene = scene;

    try {
      await scene.load();
    } catch (err) {
    document.body.classList.remove('boot');
      const tip = document.createElement('div');
      tip.className = 'toast';
      tip.style.position = 'fixed';
      tip.style.left = '50%';
      tip.style.top = '40%';
      tip.style.transform = 'translate(-50%,-50%)';
      tip.textContent = '素材加载失败：' + (err && err.message ? err.message : err);
      document.body.appendChild(tip);
      console.error(err);
      return;
    }

    /* 首次启动：按屏幕短边自动定大小。
       手机 CSS 视口往往只有 ~380px 宽，固定 1.2 会让宠物比屏幕还宽，
       连带"可走范围"变成 0（只能上下动、悬浮窗钉死）。 */
    const scaleParam = Number(new URLSearchParams(location.search || '').get('scale'));
    if (scaleParam > 0) Settings.set('scale', Math.min(2.5, Math.max(0.2, scaleParam)), { silent: true });

    if (!(Number(Settings.get('scale')) > 0)) {
      const body = (scene.manifest && scene.manifest.body_box) || [212, 60, 428, 330];
      const bodyW = Math.max(1, body[2] - body[0]);
      const shortSide = Math.min(window.innerWidth || 384, window.innerHeight || 800);
      const target = shortSide * 0.24;                 // 身体宽 ≈ 短边 24%
      const auto = Math.max(0.25, Math.min(1.6, target / bodyW));
      Settings.set('scale', Number(auto.toFixed(2)), { silent: true });
      Settings.save();
      PetBridge.log('[scale] auto = ' + auto.toFixed(2) + ' (short=' + Math.round(shortSide) + ', bodyW=' + bodyW + ')');
    }

    const primary = scene.spawnPrimary();
    if (!scene.overlay && Settings.get('companions')) {
      scene.spawnCompanion();
      scene.spawnCompanion();
    }

    const chat = new Chat(scene);

    UI.init(scene, chat);
    scene.bindInput({
      onPetLongPress: (pet, ev) => {
        if (scene.overlay) { PetBridge.openApp(); return; }
        const x = ev && ev.clientX ? ev.clientX : scene.bounds().w / 2;
        const y = ev && ev.clientY ? ev.clientY : scene.bounds().h / 2;
        UI.openMenu(x, y);
      },
      onBackgroundTap: () => {
        if (UI.isMenuOpen()) UI.closeMenu();
        UI.closeAllPanels();
      },
      onBackgroundLongPress: (ev) => {
        UI.openMenu(ev.clientX, ev.clientY);
      }
    });

    /* 悬浮层浓淡：用 CSS 变量驱动 body.overlay 的滤镜强度 */
    const applyPunch = () => {
      const v = Math.max(0, Math.min(1, Number(Settings.get('overlayPunch')) || 0));
      document.documentElement.style.setProperty('--ov-punch', String(v));
    };
    applyPunch();

    /* 设置变化 → 运行时生效 */
    Settings.onChange((key) => {
      if (key === 'overlayPunch' || key === '*') applyPunch();
      UI.applyRuntimeChanges(key);
      const primaryPet = scene.pets.find((p) => !p.companion);
      if (key === 'companions' && Settings.get('companions') && scene.companionCount() === 0) {
        scene.spawnCompanion();
      }
      if (key === '*' && primaryPet) {
        scene.pets.forEach((p) => p.playIdle());
        if (Settings.get('companions') && scene.companionCount() === 0) scene.spawnCompanion();
      }
    });

    window.addEventListener('resize', U.debounce(() => scene.onResize(), 120));
    window.addEventListener('orientationchange', () => setTimeout(() => scene.onResize(), 260));

    /* 失焦时降低开销，回到前台继续 */
    document.addEventListener('visibilitychange', () => {
      scene.paused = document.hidden;
      if (!document.hidden) scene._lastT = U.now();
    });

    /* ?selftest=1：跑边缘探头的统计，结果打到 logcat */
    if (new URLSearchParams(location.search || '').get('selftest') && scene.pets[0]) {
      setTimeout(() => {
        try {
          const st = scene.pets[0].__peekTest();
          PetBridge.log('[selftest] peek-to-edge ' + st.toEdge + '/' + st.total +
            '  maxDist=' + st.maxDist.toFixed(0));
        } catch (e) { PetBridge.log('[selftest] err ' + e); }
      }, 1200);
    }

    /* 心跳：每 8 秒报告一次状态、位置、是否暂停（悬浮排错用） */
    setInterval(() => {
      const pt = scene.pets[0];
      if (!pt) return;
      try {
        const rb = pt.reachBounds();
        PetBridge.log('[hb] st=' + pt.state + ' x=' + Math.round(pt.x) + ' y=' + Math.round(pt.y) +
          ' reach=' + Math.round(rb.left) + '..' + Math.round(rb.right) +
          ' paused=' + scene.paused + ' hidden=' + document.hidden +
          ' peekUntil=' + (pt._peekUntil ? Math.max(0, Math.round(pt._peekUntil - U.now())) : 0));
      } catch (e) {}
    }, 8000);

    if (new URLSearchParams(location.search || '').get('tiltcheck') && scene.pets[0]) {
      setTimeout(() => {
        const pt = scene.pets[0];
        const rb = pt.reachBounds();
        const out = [];
        for (const x of [rb.left, (rb.left + rb.right) / 2, rb.right]) {
          pt.x = x;
          pt._tiltNow = pt.peekAngleTarget();   // 直接取目标角（无头环境不跑帧，缓动值恒为 0）
          pt.layout();
          out.push('x=' + Math.round(x) + ' target=' + pt.peekAngleTarget().toFixed(1) +
                   ' peek=' + pt.peekState());
        }
        PetBridge.log('[tiltcheck] ' + out.join(' | '));
      }, 1200);
    }

    if (new URLSearchParams(location.search || '').get('movesim') && scene.pets[0]) {
      setTimeout(() => {
        const pt = scene.pets[0];
        if (!pt.buildMovePlan()) { PetBridge.log('[movesim] no plan'); return; }
        pt.startMove();
        const t0 = U.now();
        const iv = setInterval(() => {
          const st = { t: Math.round(U.now() - t0), st: pt.state, x: Math.round(pt.x),
                      plan: pt.plan ? Math.round((U.now() - pt.plan.startAt) / pt.plan.cycleMs * 100) / 100 : -1 };
          PetBridge.log('[movesim] t=' + st.t + ' state=' + st.st +
            ' x=' + st.x + ' phase=' + (st.plan < 0 ? 'done' : st.plan));
          if (st.st !== 'move') { clearInterval(iv); }
        }, 500);
        setTimeout(() => clearInterval(iv), 30000);
      }, 1500);
    }

    PetBridge.keepAwake(true).catch(() => {});

    scene.start();

    /* 开场：让她先说一句 */
    setTimeout(() => {
      if (Settings.get('speech') && primary) {
        scene.say(primary, '我来啦～戳我一下试试。');
      }
    }, 900);

    /* 首次启动的新手提示（只出现一次；悬浮小窗里不弹） */
    if (!scene.overlay) (async () => {
      try {
        const seen = await PetBridge.loadKV('onboarded');
        if (!seen) {
          setTimeout(() => {
            UI.toast('点我互动 · 按住拖我 · 长按叫菜单', 4200);
            PetBridge.saveKV('onboarded', String(Date.now())).catch(() => {});
          }, 2600);
        }
      } catch (e) { /* noop */ }
    })();

    /* 调试面板：URL 加 ?dbg=1 时在左上角显示布局与宠物关键数值（排错用，正式使用看不见） */
    if (new URLSearchParams(location.search || '').get('dbg')) {
      window.__errs = window.__errs || [];
      window.addEventListener('error', (e) => { window.__errs.push(String(e.message || e)); });
      window.addEventListener('unhandledrejection', (e) => { window.__errs.push('promise:' + String(e.reason)); });
      const paint = () => {
        let el = document.getElementById('__dbg');
        if (!el) {
          el = document.createElement('div');
          el.id = '__dbg';
          el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:rgba(0,0,0,.82);color:#7CFC9A;' +
            'font:11px/1.5 monospace;padding:4px 6px;white-space:pre;pointer-events:none';
          document.body.appendChild(el);
        }
        const pet = scene.pets[0];
        const rb = pet ? pet.reachBounds() : null;
        el.textContent = [
          'vw=' + innerWidth + ' vh=' + innerHeight + ' dpr=' + (devicePixelRatio || 1),
          'bodyScrollW=' + document.body.scrollWidth + ' docW=' + document.documentElement.scrollWidth,
          pet ? ('pet=' + pet.w.toFixed(0) + 'x' + pet.h.toFixed(0) + ' scale=' + pet.scale.toFixed(2)) : 'no pet',
          pet ? ('x=' + pet.x.toFixed(0) + ' y=' + pet.y.toFixed(0) + ' st=' + pet.state + ' facing=' + pet.facing) : '',
          rb ? ('reach=' + rb.left.toFixed(0) + '..' + rb.right.toFixed(0)) : '',
          'frames=' + (scene._frames||0) + ' mode=' + scene.mode + ' paused=' + scene.paused + ' winW=' + (scene._winW|0) + ' winH=' + (scene._winH|0),
          pet ? ('rawEnd=' + pet._clipEndsAt + ' now=' + Math.round(U.now()) + ' drag=' + pet.dragging + ' after=' + (typeof pet._after)) : '',
          'trace=' + ((pet._trace || []).slice(-5).join(' ')),
          pet ? ('ticks=' + (pet._ticks||0) + ' afters=' + (pet._afters||0) + ' decisions=' + (pet._decisions||0) + ' clipEnds=' + Math.max(0, Math.round((pet._clipEndsAt - U.now())/1000)) + 's plan=' + (pet.plan ? pet.plan.dir : 'none')) : ''
        ].join('\n');
      };
      setInterval(paint, 500);
      paint();
    }

    document.body.classList.remove('boot');
    PetBridge.log('pet ready #' + bootId + ': ' + (scene.manifest.clips || []).length + ' clips, pets=' + scene.pets.length + ', auxPets=' + document.querySelectorAll('.pet').length);

    /* 调试入口：?demo=menu|settings|chat 直接打开对应界面（验收截图用） */
    const demo = new URLSearchParams(location.search || '').get('demo');
    if (demo) {
      setTimeout(() => {
        const b = scene.bounds();
        if (demo === 'menu') UI.openMenu(b.w * 0.42, b.h * 0.45);
        else if (demo === 'settings') UI.togglePanel('settings');
        else if (demo === 'chat') {
          UI.togglePanel('chat');
          if (!chat.messages.length) {
            chat.messages = [
              { role: 'user', content: '你今天怎么这么精神？', ts: Date.now() - 60000 },
              { role: 'assistant', content: '因为你在呀～刚睡醒就看到屏幕亮起来了。要不要我陪你写会儿代码？', ts: Date.now() - 55000 }
            ];
            chat.render();
          }
        }
      }, 600);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
