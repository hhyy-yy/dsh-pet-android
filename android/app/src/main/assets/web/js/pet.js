/* pet.js —— 单只桌宠：动画状态机 + 物理 + 交互反馈
 *
 * 常量与判定链对齐桌面版 dsh-pet-indesktop v4.3.4（见 docs/BEHAVIOR-PARITY.md）：
 *   掷骰 P_IDLE .30 / P_TURN .40 / P_ACTS .80  →  待机30% / 转向10% / 随机动作40% / 移动20%
 *   移动 MOVE_MIN 60 / MOVE_MAX 240 / MARGIN 20 / stride 缺省 120（均按 scale 折算）
 *   抛掷 GRAVITY 1400 / 碰边 e 0.68 / 地面摩擦 2.5 / 小跳截止 120 / 静止 vx<15
 *   点击 Q 弹 220ms，pulse=sin(πp)，宽 +10%、高 −15%，底中锚定
 */
(function (global) {
  'use strict';

  /* ---- 物理（physics.py） ---- */
  const GRAVITY = 1400;              // px/s²
  const RESTITUTION = 0.68;          // 碰边恢复系数
  const GROUND_FRICTION = 2.5;       // /s
  const GROUND_BOUNCE_STOP_VY = 120; // 落地 |vy| 低于它直接停
  const REST_VX = 15;                // 地面上认为静止
  const SUB_DT_MAX = 0.008;          // 子步上限
  /* ---- 松手初速（physics.py estimate_release_velocity） ---- */
  const TRAIL_KEEP_SEC = 0.15;
  const RELEASE_WINDOW_SEC = 0.12;
  const RELEASE_STALE_SEC = 0.15;
  const MIN_SPAN_SEC = 0.02;
  const SEG_MIN_DT = 0.008;
  const PEAK_WEIGHT = 0.5;
  const ACCEL_REF = 8000;
  const ACCEL_GAIN_MAX = 0.6;
  const DEAD_ZONE_SPEED = 500;
  const THROW_CAP_STANDARD = 4800;   // throw_strength=standard
  /* ---- 移动（catalog.py / movement.py） ---- */
  const P_IDLE = 0.20;      // 桌面版 .30：手机上把"走路"占比提上来，看着才像活的
  const P_TURN = 0.28;      // 桌面版 .40
  const P_ACTS = 0.60;      // 桌面版 .80 → 走路 40%
  const IDLE_ROLL_MS = 3000;  // 待机最多停 3 秒就重新掷骰
  const MOVE_MIN_PX = 60;
  const MOVE_MAX_PX = 240;
  const MOVE_MARGIN = 20;
  const MOVE_STRIDE_DEFAULT_PX = 120;
  const FACING_RATIO = 0.07;
  /* ---- 交互 ---- */
  const SQUASH_MS = 220;
  const SQUASH_W = 0.10;
  const SQUASH_H = 0.15;
  const DRAG_THRESHOLD = 5;

  let uid = 0;

  function softClampSpeed(s, cap) {
    if (cap <= 0) return 0;
    return cap * (1 - Math.exp(-s / cap));
  }

  class Pet {
    constructor(scene, opts) {
      const o = opts || {};
      this.scene = scene;
      this.manifest = o.manifest;
      this.companion = !!o.companion;
      this.id = 'pet' + (++uid);
      this.facing = Math.random() < 0.5 ? 1 : -1;
      this.baseScale = this.companion ? 0.75 : 1;
      this.mass = this.companion ? 0.75 : 1;

      const crop = this.manifest.crop || { x: 0, y: 0, w: 640, h: 360 };
      this.srcW = crop.w;
      this.srcH = crop.h;

      const b = scene.bounds();
      this.x = this.companion ? U.rand(b.w * 0.25, b.w * 0.75) : b.w * 0.55;
      this.y = b.floor;
      this.vx = 0;
      this.vy = 0;

      this.state = 'idle';
      this.plan = null;               // 移动计划 {dir, distance, duration, speed, endedAt}
      this.dragging = false;
      this._trail = [];
      this.squashT = -1;
      this._clipEndsAt = 0;
      this._after = null;
      this.speakTimer = U.rand(3.0, 9.0);
      this._history = [];

      this.el = U.el('img', 'pet' + (this.companion ? ' companion' : ''));
      this.el.alt = '';
      this.el.draggable = false;
      this.el.decoding = 'async';
      this.el.addEventListener('dragstart', (e) => e.preventDefault());
      scene.stage.appendChild(this.el);

      this._clip = null;
      this._srcNonce = 0;

      this.applyScale(true);
      this.playIdle();
    }

    /* ---------- 尺寸 ---------- */
    get scale() {
      const s = Number(Settings.get('scale')) || 1.2;
      return s * this.baseScale;
    }

    get w() { return this.srcW * this.scale; }
    get h() { return this.srcH * this.scale; }

    applyScale() {
      const b = this.scene.bounds();
      this.el.style.width = this.w + 'px';
      this.el.style.height = this.h + 'px';
      /* 改尺寸后按"身体框"重新夹一次位置：否则大尺寸时会被夹到屏幕外一半，
         看起来像被透明边界顶住。 */
      const rb = this.reachBounds(true);
      this.x = U.clamp(this.x, rb.left, rb.right);
      this.y = Math.min(this.y, b.floor);
      this.layout();
    }

    layout() {
      const sxA = this.squashT < 0 ? 1 : 1 + SQUASH_W * Math.sin(Math.PI * this.squashT);
      const syA = this.squashT < 0 ? 1 : 1 - SQUASH_H * Math.sin(Math.PI * this.squashT);
      if (this.scene && this.scene.overlay) {
        /* 悬浮窗是"取景框"，原点不一定在 (0,0)（拖拽时会放大成整屏），
           所以本地坐标 = 屏幕坐标 − 窗口原点。 */
        /* 素材默认朝左（片段名就叫「左转奔跑」），所以朝右时才镜像 */
        const flipA = (this.facing > 0 && !(this._clip && this._clip.no_mirror)) ? -1 : 1;
        /* crisp 模式（窗口只有宠物那么大）：宠物钉在窗口原点，
           窗口位置负责屏幕位置 —— 这样窗口自己的延迟只会表现为"整只略微滞后"，
           绝不会出现坐标错位导致的闪。 */
        let lx, ly;
        if (this.scene.crispWindow) {
          lx = 0;
          ly = 0;
        } else {
          const win = this.scene._lastWin || { x: 0, y: 0 };
          lx = this.x - this.w / 2 - (win.x || 0);
          ly = this.y - this.h - (win.y || 0);
        }
        this._layN = (this._layN || 0) + 1;
        if (this._layN % 40 === 1) {
          try {
            PetBridge.log('[geo] layout pet=(' + Math.round(this.x) + ',' + Math.round(this.y) + ') win=(' +
              Math.round(win.x || 0) + ',' + Math.round(win.y || 0) + ') local=(' + Math.round(lx) + ',' + Math.round(ly) +
              ') vw=' + Math.round(window.innerWidth) + 'x' + Math.round(window.innerHeight));
          } catch (e) {}
        }
        this.el.style.transformOrigin = '50% 100%';
        const tiltA = this.peekTilt();
        this.el.style.transform =
          `translate3d(${lx.toFixed(2)}px, ${ly.toFixed(2)}px, 0) ` +
          (tiltA ? `rotate(${tiltA.toFixed(1)}deg) ` : '') +
          `scale(${(flipA * sxA).toFixed(4)}, ${syA.toFixed(4)})`;
        this.el.style.zIndex = '30';
        return;
      }
      const sx = this.squashT < 0 ? 1 : 1 + SQUASH_W * Math.sin(Math.PI * this.squashT);
      const sy = this.squashT < 0 ? 1 : 1 - SQUASH_H * Math.sin(Math.PI * this.squashT);
        /* 同 overlay 分支：素材默认朝左，朝右才镜像 */
        const flip = (this.facing > 0 && !(this._clip && this._clip.no_mirror)) ? -1 : 1;
      const tx = this.x - this.w / 2;
      this.el.style.transformOrigin = '50% 100%';
      /* 斜探头：身体探出屏幕过半时沿底边中心倾斜 */
      const tiltApp = this.peekTilt();
      this.el.style.transform =
        `translate3d(${tx.toFixed(2)}px, ${(this.y - this.h).toFixed(2)}px, 0) ` +
        (tiltApp ? `rotate(${tiltApp.toFixed(1)}deg) ` : '') +
        `scale(${(flip * sx).toFixed(4)}, ${sy.toFixed(4)})`;
      this.el.style.zIndex = String(this.companion ? 20 : 30);
    }

    /* ---------- 动画 ---------- */
    clipPool(cat) {
      return (this.manifest.clips || []).filter((c) => c.cat === cat);
    }

    /* 桌面版 _pick：只排除"当前正在播的这一条" */
    pickClip(cat, excludeCurrent) {
      let pool = this.clipPool(cat);
      if (!pool.length) return null;
      if (excludeCurrent !== false && this._clip && pool.length > 1) {
        const filtered = pool.filter((c) => c.id !== this._clip.id);
        if (filtered.length) pool = filtered;
      }
      return U.pick(pool);
    }

    clipDuration(clip) {
      return (clip.frames / (clip.fps || 24)) * 1000;
    }

    play(clip, opts) {
      if (!clip) return false;
      const o = opts || {};
      this._clip = clip;
      this._clipEndsAt = U.now() + this.clipDuration(clip);
      this._clipStart = U.now();
      this._after = o.after || null;
      this._history.push(clip.id);
      if (this._history.length > 24) this._history.shift();
      this._mode = clip.framesDir ? 'frames' : 'anim';
      this._frameIdx = -1;
      if (this._mode === 'anim') {
        /* 之前每次播放都换 nonce → 每次都要重新解码 WebP，导致"位移先动、动画后出来"。
           改成每个片段只有两个固定变体：需要重播时在两者间切换，第一次之后就走解码缓存。 */
        this._srcNonce += 1;
        const variant = (this._srcNonce % 2);
        this.el.src = this.scene.assetUrl(clip.file) + '?v=' + variant;
      } else {
        this._applyFrame(0);
      }
      this.layout();
      return true;
    }

    /* 帧序列兜底模式：某些内核不支持动画 WebP 时，可用 manifest 里的 framesDir 逐帧播放 */
    _applyFrame(idx) {
      const clip = this._clip;
      if (!clip || !clip.framesDir) return;
      const dir = String(clip.framesDir).replace(/\/+$/, '') + '/';
      const name = 'f_' + String(idx + 1).padStart(4, '0') + '.webp';
      this._frameIdx = idx;
      this.el.src = this.scene.assetUrl(dir + name);
    }

    _stepFrames() {
      const clip = this._clip;
      if (!clip) return;
      const fps = clip.fps || 24;
      const total = Math.max(1, clip.frames || 1);
      const elapsed = (U.now() - this._clipStart) / 1000;
      let idx = Math.floor(elapsed * fps);
      idx = clip.loop ? (idx % total) : Math.min(idx, total - 1);
      if (idx !== this._frameIdx) this._applyFrame(idx);
    }

    playIdle() {
      this.state = 'idle';
      this.plan = null;
      const clip = this.pickClip('idle', false) || this.pickClip('random', false);
      this.play(clip, { after: () => this.decide() });
      /* 待机动画本身要循环 10 秒，但决策不必等它：最多 3 秒就重新掷骰，
         否则手机上平均一分多钟才走一次，看起来像"不会动"。 */
      const roll = U.now() + IDLE_ROLL_MS;
      this._clipEndsAt = Math.min(this._clipEndsAt, roll);
    }

    playActs() {
      const clip = this.pickClip('random');
      if (!clip) { this.playIdle(); return; }
      this.state = 'acts';
      this.plan = null;
      this.play(clip, { after: () => this.decide() });
    }

    playTurn(thenMove) {
      const clip = this.pickClip('turn');
      if (!clip) {
        if (thenMove) this.startMove(); else this.playIdle();
        return;
      }
      this.state = 'turn';
      this.play(clip, { after: () => {
        try { PetBridge.log('[turn] after thenMove=' + thenMove); } catch (e) {}
        if (thenMove) this.startMove(); else this.decide();
      } });
    }

    /* ---------- 身体可达界（movement.py body_reach） ---------- */
    bodyMetrics() {
      const body = this.manifest.body_box || [212, 60, 428, 330];
      const crop = this.manifest.crop || { x: 0, y: 0 };
      const s = this.scale;
      const bodyW = (body[2] - body[0]) * s;
      /* 身体中心相对精灵中心在屏幕坐标下的偏移 */
      const bodyCxInSprite = (((body[0] + body[2]) / 2) - crop.x) * s;
      const offset = bodyCxInSprite - this.w / 2;
      return { bodyW, offset };
    }

    /* x 允许区间：以"身体框"为准（画布两侧的透明留白不算），
       这样视觉上走到哪儿就能拖到哪儿，不会出现空气墙。 */
    /* allowPeek：只有玩家拖拽/被甩出去时才允许身体探出屏幕；
       自己走动时用 false —— 这样她不会"主动跑到边上探头"。 */
    reachBounds(allowPeek) {
      const b = this.scene.bounds();
      const { bodyW, offset } = this.bodyMetrics();
      const margin = MOVE_MARGIN * this.scale;
      const half = bodyW / 2;
      /* 尺寸大时允许身体探出屏幕边缘（桌面宠物就该这样），
         但至少保留 25% 身体宽度可见，免得拖没了。
         之前的公式在大尺寸下会把可拖范围压到几十像素 → 表现为"只能上下滑"。 */
      const peekSlack = 0;   // 不再允许身体探出屏幕
      const allowOutside = Math.max(0, half - b.w * 0.25) + peekSlack;
      const bodyMin = margin + half - allowOutside;
      const bodyMax = b.w - margin - half + allowOutside;

      if (bodyMax - bodyMin < 8) {
        const mid = b.w / 2 - offset;
        const slack = Math.max(60, b.w * 0.3);
        return { left: mid - slack, right: mid + slack, center: mid };
      }
      return {
        left: bodyMin - offset,
        right: bodyMax - offset,
        center: (bodyMin + bodyMax) / 2 - offset,
      };
    }

    /* 中线滞回带（movement.py inward_facing，ratio 0.07） */
    inwardFacing() {
      const { left, right } = this.reachBounds();
      const center = (left + right) / 2;
      const band = (right - left) * FACING_RATIO;
      if (this.x < center - band) return 1;   // 偏左 → 应朝右
      if (this.x > center + band) return -1;
      return 0;                                // 带内 → 不纠正
    }

    /* ---------- 掷骰链（sprite_behavior.py 1369-1405） ---------- */
    decide() {
      if (this.dragging) return;

      /* 边缘探头中：**只做探头动作**（「东张西望」循环），
         不做随机动作、不走动、不换别的动画；
         只有玩家把她拖离边缘（身体回到屏内）才恢复常态。 */
      const pk = this.peekState();
      if (pk) {
        if (!this._peeking) {
          this._peeking = true;
          this._peekSide = pk;
          const look = this.pickClip('turn', false) || this.pickClip('random', false);
          this.plan = null;
          if (look) {
            this.state = 'turn';
            /* 不给 after：让这一段一直循环，不再进入其它决策 */
            this.play(look, {});
          }
          try {
            const rr = this.bodyRect();
            const bb = this.scene.bounds();
            const oL = Math.max(0, -rr.l) / Math.max(1, rr.w);
            const oR = Math.max(0, rr.r - bb.w) / Math.max(1, rr.w);
            PetBridge.log('[peek] hold ' + pk + ' out=' + Math.max(oL, oR).toFixed(2) +
              ' x=' + Math.round(this.x));
          } catch (e) {}
        }
        /* 只是把"下一次决策"往后推，用于检测是否已被拖离边缘 */
        this._clipEndsAt = Math.max(this._clipEndsAt, U.now() + 1200);
        return;
      }
      if (this._peeking) {
        /* 刚被拖离边缘 → 恢复常态 */
        this._peeking = false;
        this._peekLooked = false;
        try {
          const rr2 = this.bodyRect();
          const bb2 = this.scene.bounds();
          const oL2 = Math.max(0, -rr2.l) / Math.max(1, rr2.w);
          const oR2 = Math.max(0, rr2.r - bb2.w) / Math.max(1, rr2.w);
          PetBridge.log('[peek] release out=' + Math.max(oL2, oR2).toFixed(2) +
            ' x=' + Math.round(this.x));
        } catch (e) {}
        this.playIdle();
        return;
      }
      this._decisions = (this._decisions || 0) + 1;
      const roll = Math.random();
      const hasActs = this.clipPool('random').length > 0;
      const hasTurns = this.clipPool('turn').length > 0;

      if (roll >= P_ACTS) {
        /* 20%：移动。建不出计划就回退 acts，再回退 idle */
        const wanderOn = Settings.get('wander') !== false;
        const built = wanderOn ? this.buildMovePlan() : false;
        try {
          PetBridge.log('[dec] roll=' + roll.toFixed(2) + ' wander=' + wanderOn +
            ' built=' + built + ' facing=' + this.facing +
            (built ? (' want=' + this.plan.dir) : ''));
        } catch (e) {}
        if (built) {
          const want = this.plan.dir;
          if (this.facing !== want && hasTurns) this.playTurn(true);
          else this.startMove();
          return;
        }
        if (hasActs && Settings.get('randomActions') !== false) { this.playActs(); return; }
        this.playIdle();
        return;
      }

      if (roll >= P_TURN) {
        /* 40%：随机小动作 */
        if (hasActs && Settings.get('randomActions') !== false) { this.playActs(); return; }
        this.playIdle();
        return;
      }

      /* 30%：待机 / 转向 —— 朝向绝不由随机数翻转，只由位置决定 */
      const want = this.inwardFacing();
      if (roll >= P_IDLE) {
        /* 掷中转向：朝向本来就对 → 降级待机 */
        if (want !== 0 && want !== this.facing && hasTurns) this.playTurn(false);
        else this.playIdle();
        return;
      }
      /* 掷中待机：朝向不对 → 升级成转向 */
      if (want !== 0 && want !== this.facing && hasTurns) this.playTurn(false);
      else this.playIdle();
    }

    /* ---------- 移动计划（movement.py 103-121） ---------- */
    /* 自检用：跑 200 次移动计划，统计"走到边界"的比例（?selftest=1 触发） */
    __peekTest() {
      const stats = { total: 0, toEdge: 0, maxDist: 0 };
      const { left, right } = this.reachBounds();
      for (let i = 0; i < 200; i += 1) {
        const before = this.x;
        if (!this.buildMovePlan()) continue;
        stats.total += 1;
        const target = before + this.plan.dir * this.plan.distance;
        stats.maxDist = Math.max(stats.maxDist, Math.abs(this.plan.distance));
        if (target <= left + 2 || target >= right - 2) stats.toEdge += 1;
      }
      this.plan = null;
      this.x = 0;
      return stats;
    }

    /* 专用探头：明确的目标 x，走到就停并停留 5 秒。
       （不再借用 buildMovePlan 的距离/时长机制——那套在"走到边界"这种极端行程上不收敛） */
    startPeekWalk() {
      const rb = this.reachBounds();
      const toLeft = Math.random() < 0.5;
      const targetX = toLeft ? rb.left : rb.right;
      if (Math.abs(targetX - this.x) < 10) { try { PetBridge.log('[peekwalk] skip: already at edge'); } catch (e) {} return false; }
      const clip = this.pickClip('move', false);
      if (!clip) { try { PetBridge.log('[peekwalk] skip: no move clip'); } catch (e) {} return false; }
      const durSec = (clip.frames || 241) / (clip.fps || 24);
      const stride = (Number(clip.stride) || MOVE_STRIDE_DEFAULT_PX) * this.scale;
      const boost = (this.scene && this.scene.overlay) ? 1.3 : 1;
      const speed = Math.max(20, (stride / durSec) * boost);
      this.facing = toLeft ? -1 : 1;
      this.plan = {
        dir: this.facing, peek: true, targetX: targetX,
        speed: speed, vy: 0, clip: clip,
        startX: this.x, startY: this.y,
        cycleMs: durSec * 1000,
        cycles: Math.abs(targetX - this.x) / Math.max(1, stride),
        stride: stride,
        endsAt: U.now() + (Math.abs(targetX - this.x) / speed) * 1000 + 400,
      };
      this.state = 'move';
      this.play(clip, { loop: true });
      const pplan = this.plan;
      pplan.startAt = 0;
      const begin2 = () => { if (this.plan === pplan) pplan.startAt = U.now(); };
      let done2 = false;
      const once2 = () => { if (done2) return; done2 = true; begin2(); };
      setTimeout(once2, 120);
      if (this.el && typeof this.el.decode === 'function') this.el.decode().then(once2).catch(once2);
      else once2();
      return true;
    }

    buildMovePlan() {
      const { left, right } = this.reachBounds();
      const minD = MOVE_MIN_PX * this.scale;
      const maxD = MOVE_MAX_PX * this.scale;
      const roomLeft = this.x - left;
      const roomRight = right - this.x;
      /* 离墙留白：太靠近某侧就不再往外走，而是朝场地中间逛，
         否则会被边界夹住、看起来"贴在墙上" */
      const pad = Math.max(minD, (right - left) * 0.25);
      let dir;
      if (this.x < left + pad) dir = 1;                       // 贴左墙 → 往右
      else if (this.x > right - pad) dir = -1;                // 贴右墙 → 往左
      else if (roomLeft >= minD && roomRight >= minD) dir = Math.random() < 0.5 ? -1 : 1;
      else if (roomLeft >= minD) dir = -1;
      else if (roomRight >= minD) dir = 1;
      else return false;

      const room = dir < 0 ? roomLeft : roomRight;
      let far = Math.min(maxD, Math.floor(room));
      if (far < minD) return false;

      /* 自动探头已取消：这里不再有"强制走到底"的分支。
         （它留着的话一半的移动都会一口气走到边界 → 表现为"只会贴墙"） */
      const forcedDistance = 0;

      const clip = this.pickClip('move', false);
      if (!clip) return false;

      const loopDurSec = (clip.frames / (clip.fps || 24));
      const strideSrc = Number(clip.stride) || MOVE_STRIDE_DEFAULT_PX;
      const stride = strideSrc * this.scale;            // 每圈地面位移（屏幕 px）
      let distance = forcedDistance > 0 ? forcedDistance : U.rand(minD, far);

      /* 量化成 stride 整圈：否则平均速度 ≠ 步态速度 → 脚滑 */
      let loops = Math.max(1, Math.round(distance / Math.max(1, stride)));
      while (loops > 1 && loops * stride > room) loops -= 1;
      /* 探头那几档：必须走完剩余距离，不能让步态量化截短（否则永远差小半圈到不了边）。
         代价是这一档末尾会有一点脚滑，肉眼几乎看不出。 */
      const distFinal = forcedDistance > 0
        ? Math.min(room, Math.max(forcedDistance, minD))
        : Math.min(loops * stride, room);

      /* 悬浮模式：再抽一个纵向目标（对齐桌面 wander_target_y：
         单次最多走可用高度的 25%，且 ≥40px），这样看起来是在屏幕上"逛"，
         而不是贴着底边左右平移。 */
      let targetY = null;
      /* 悬浮模式默认就有纵向漫游；重力关掉后应用内也一样（可上下跑） */
      if ((this.scene && this.scene.overlay) || Settings.get('gravity') === false) {
        const b = this.scene.bounds();
        const yLo = this.h;
        const yHi = b.h - 8;
        if (yHi > yLo) {
          const maxDy = Math.max(40, (yHi - yLo) * 0.25);
          targetY = U.clamp(this.y + U.rand(-maxDy, maxDy), yLo, yHi);
        }
      }

      /* 悬浮模式速度 ×1.3（窗口位移是整像素，太慢会一格一格跳） */
      const boost = (this.scene && this.scene.overlay) ? 1.3 : 1;
      const speed = (stride / loopDurSec) * boost;

      /* 距离 / 时长必须自洽：
         · 普通档 = 量化圈数，duration = loops × 单圈时长（脚不打滑）
         · 探头档 = 走满剩余距离，duration = 距离 ÷ 实际速度
           （之前探头档只改距离、不改时长，她会在到边之前就时间到而停下 → 永远探头失败） */
      /* 时长统一按"距离 ÷ 实际速度"算：
         这样位移量恰好等于计划距离，动画与位移共用一个时间轴，
         不会出现"动画播完了还在滑"或"动画没播完就停"。 */
      const durationSec = Math.max(0.3, distFinal / Math.max(1, speed));

      /* 纵向速度：用最终时长算，保证纵向到位 */
      const vyFinal = (targetY === null || durationSec <= 0) ? 0 : (targetY - this.y) / durationSec;

      this.plan = {
        dir,
        peek: forcedDistance > 0,
        distance: distFinal,
        duration: durationSec,
        speed: speed,
        vy: vyFinal,
        vyDelta: 0,
        clip,
        /* 相位驱动：位置 = 起点 + 已播放圈数 × 每圈步幅，
           这样"脚走完最后一步"与"位移停止"必然同一时刻 */
        startX: this.x,
        startY: this.y,
        cycleMs: loopDurSec * 1000,
        /* 圈数**向下取整**：round 会把 2.6 圈进位成 3 圈，多走小半圈就越过屏幕边界。
           向下取整保证 cycles×步幅 ≤ 计划距离 ≤ 可用空间。 */
        cycles: Math.max(1, Math.floor(distFinal / Math.max(1, stride))),
        stride: stride,
        endsAt: U.now() + durationSec * 1000,
      };
      return true;
    }

    startMove() {
      if (!this.plan) { this.playIdle(); return; }
      const p = this.plan;
      this.state = 'move';
      this._frozenX = null;
      try { PetBridge.log('[plan] dir=' + p.dir + ' dist=' + Math.round(p.distance) + ' x=' + Math.round(this.x)); } catch (e) {}      // 起步解除冻结
      this.plan = Object.assign({}, p, { endsAt: Infinity, startAt: 0 });   // 解码完成前不动
      this.play(p.clip, {
        after: () => { this.plan = null; this.decide(); }
      });
      /* 起点必须和动画起点一致：
         · 该片段已解码过 → 设完 src 动画立刻开始，就地锚定（不能等 decode，否则动画早 100ms 左右）；
         · 第一次播放 → 等 decode 再锚定，避免"人先滑、图后到"。 */
      this._readyClips = this._readyClips || {};
      const begin = () => {
        if (this.state !== 'move' || !this.plan) return;
        const t0 = U.now();
        this.plan.startAt = t0;
        this.plan.endsAt = t0 + p.duration * 1000;
        this._clipStart = t0;
        this._clipEndsAt = t0 + p.duration * 1000;   // 动画与位移同一时间轴
      };
      /* decode() 对动画 WebP 可能永远不 resolve → 必须加超时兜底，
         否则起步被挂死（表现为"只转身、不走路"）。 */
      const img = this.el;
      const key = p.clip && (p.clip.id || p.clip.file);
      if (this._readyClips[key]) {
        begin();                                  // 已解码：立即锚定，与动画同时起
      } else {
        let done = false;
        const once = () => {
          if (done) return;
          done = true;
          this._readyClips[key] = true;
          begin();
        };
        setTimeout(once, 120);
        if (img && typeof img.decode === 'function') img.decode().then(once).catch(once);
        else once();
      }
    }

    stopWalk(playIdleNow) {
      if (this.state !== 'move') return;
      this.plan = null;
      if (playIdleNow !== false) this.playIdle();
    }

    turnTo(dir) {
      if (this.facing === dir) return;
      this.facing = dir;
      this.layout();
    }

    /* ---------- 交互 ---------- */
    click() {
      this.squashT = 0;
      this.scene.playClickSound();
      const clip = this.pickClip('click') || this.pickClip('random');
      if (clip) {
        this.state = 'click';
        this.plan = null;
        this.play(clip, { after: () => this.decide() });
      }
      if (!this.companion && Settings.get('speech') && Math.random() < 0.85) {
        this.scene.say(this, U.pick(this.scene.phrasePool()));
      }
      this.speakTimer = U.rand(
        Number(Settings.get('intervalMin')) || 20,
        Math.max(Number(Settings.get('intervalMin')) || 20, Number(Settings.get('intervalMax')) || 60)
      );
    }

    beginDrag() {
      this.dragging = true;
      this.state = 'drag';
      this.plan = null;
      this.vx = 0;
      this.vy = 0;
      this._trail = [];
      this.el.classList.add('dragging');
      const drag = this.pickClip('drag');
      if (drag) this.play(drag);
    }

    dragTo(cx, cy) {
      const b = this.scene.bounds();
      /* 拖拽也用"身体框"边界：之前按整张画布算，画布两侧的透明留白会让人
         觉得"看着能过去、推不动"。 */
      const rb = this.reachBounds(true);   // 人为拖拽允许把身体拖出屏幕（边缘探头）
      this.x = U.clamp(cx, rb.left, rb.right);
      const yMin = Math.min(this.h, b.floor);
      this.y = U.clamp(cy, yMin, b.floor);
      this.layout();
      const now = U.now();
      this._trail.push({ t: now, x: this.x, y: this.y });
      /* 只保留 TRAIL_KEEP_SEC 内的轨迹 */
      while (this._trail.length > 2 && now - this._trail[0].t > TRAIL_KEEP_SEC * 1000) {
        this._trail.shift();
      }
    }

    /* 松手初速估算（physics.py:154-203） */
    estimateReleaseVelocity(now) {
      const trail = this._trail;
      if (!trail.length) return { vx: 0, vy: 0 };
      if (now - trail[trail.length - 1].t > RELEASE_STALE_SEC * 1000) return { vx: 0, vy: 0 };
      const win = trail.filter((p) => now - p.t <= RELEASE_WINDOW_SEC * 1000);
      if (win.length < 2) return { vx: 0, vy: 0 };
      const t0 = win[0].t, t1 = win[win.length - 1].t;
      const span = (t1 - t0) / 1000;
      if (span < MIN_SPAN_SEC) return { vx: 0, vy: 0 };

      const baseVx = (win[win.length - 1].x - win[0].x) / span;
      const baseVy = (win[win.length - 1].y - win[0].y) / span;
      const baseSpeed = Math.hypot(baseVx, baseVy);

      /* 分段速度峰值 */
      let peak = 0;
      let firstSeg = null;
      let lastSeg = null;
      for (let i = 1; i < win.length; i++) {
        const dt = (win[i].t - win[i - 1].t) / 1000;
        if (dt < SEG_MIN_DT) continue;
        const svx = (win[i].x - win[i - 1].x) / dt;
        const svy = (win[i].y - win[i - 1].y) / dt;
        const sp = Math.hypot(svx, svy);
        if (!firstSeg) firstSeg = { sp, t: win[i].t };
        lastSeg = { sp, t: win[i].t };
        if (sp > peak) peak = sp;
      }
      if (!firstSeg || !lastSeg) { firstSeg = { sp: baseSpeed, t: t0 }; lastSeg = { sp: baseSpeed, t: t1 }; }

      const accel = (lastSeg.sp - firstSeg.sp) / Math.max(0.02, (lastSeg.t - firstSeg.t) / 1000);
      let speed = baseSpeed * (1 - PEAK_WEIGHT) + peak * PEAK_WEIGHT;
      const gain = 1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX;
      speed = softClampSpeed(speed * gain, THROW_CAP_STANDARD);
      if (speed < 1e-3) return { vx: 0, vy: 0 };
      const norm = Math.hypot(baseVx, baseVy) || 1;
      return { vx: (baseVx / norm) * speed, vy: (baseVy / norm) * speed };
    }

    /* 只换动画、不动状态机（拖拽收尾/抛掷期间用） */
    playAnimOnly(cat) {
      const clip = this.pickClip(cat, false);
      if (clip) this.play(clip, { after: null });
    }

    endDrag() {
      this._dragEndedAt = U.now();
      const now = U.now();
      const v = this.estimateReleaseVelocity(now);
      this.dragging = false;
      this.el.classList.remove('dragging');
      const speed = Math.hypot(v.vx, v.vy);
      const b = this.scene.bounds();
      this._trail = [];

      if (speed < DEAD_ZONE_SPEED) {
        this.vx = 0;
        this.vy = 0;
        if (this.y < b.floor - 1) {
          /* 半空中零速松手：照样受重力落地 */
          this.playAnimOnly('idle');
          this.state = 'thrown';
        } else {
          this.playIdle();
        }
        return;
      }
      this.vx = v.vx;
      this.vy = v.vy;
      if (Math.abs(this.vx) > 60) this.facing = this.vx > 0 ? 1 : -1;
      this.playAnimOnly('idle');
      this.state = 'thrown';
    }

    /* ---------- 逐帧 ---------- */
    tick(dt) {
      this._ticks = (this._ticks || 0) + 1;
      const b = this.scene.bounds();

      if (this.squashT >= 0) {
        this.squashT += dt / (SQUASH_MS / 1000);
        if (this.squashT >= 1) this.squashT = -1;
        this.layout();
      }
      if (this.dragging) return;

      if (this._mode === 'frames') this._stepFrames();

      /* 硬保证 1：只有 move 状态下 x 才允许变化。任何转身/待机/动作期间
         都把 x 钉在"最后一步结束时"的值，杜绝残余位移。 */
      if (this.state !== 'move' && this._frozenX != null) {
        this.x = this._frozenX;
      }
      /* 硬保证 2：除"正在被拖 / 被甩出去 / 处于探头 / 刚好达到探头条件"之外，
         x 一律夹在屏内安全范围。
         注意必须把 peekState() 也排除掉——否则松手那一帧就被拽回屏内，
         探出比例瞬间变小，探头和倾斜根本来不及触发（这正是"不会倾斜"的原因）。 */
      if (!this.dragging && !this._peeking && this.state !== 'thrown' && !this.peekState()) {
        const rb0 = this.reachBounds();
        this.x = U.clamp(this.x, rb0.left, rb0.right);
      }
      /* 双保险：walk 动画时间轴走完 → 立即收步（相位驱动之外的兜底） */
      if (this.state === 'move' && this.plan && this.plan.startAt && U.now() >= this._clipEndsAt) {
        const pl = this.plan;
        this.x = pl.startX + pl.dir * pl.cycles * pl.stride;   // 精确落在最后一步
        this._frozenX = this.x;
        this.plan = null;
        this.playIdle();
      }
      /* 倾斜缓动：目标角用指数逼近，约 250~300ms 到位 → 自己"丝滑"地探出去 */
      const tiltTarget = this.peekAngleTarget();
      const easeK = Math.min(1, dt * 7);
      const beforeTilt = this._tiltNow || 0;
      this._tiltNow = beforeTilt + (tiltTarget - beforeTilt) * easeK;
      if (Math.abs(this._tiltNow) < 0.05) this._tiltNow = 0;
      /* 关键：待机/做动作时 layout() 不会被调用，必须在这里主动重绘，
         否则倾斜只在内存里变化、画面看不到（正是"有时倾有时不倾"的原因） */
      if (Math.abs(this._tiltNow - beforeTilt) > 0.02) this.layout();

      if (this.state === 'move' && this.peekState()) {
        /* 被拖到边缘 → 立刻收步并进入探头（由 decide 统一接管动画） */
        this.plan = null;
        this._frozenX = this.x;
        this.decide();
      }
      if (this.state === 'thrown') {
        this.stepThrow(dt, b);
      } else if (this.state === 'move') {
        this.stepMove(dt, b);
      }

      /* 调试：记录 tick 内真实看到的状态与时间差 */
      this._trace = this._trace || [];
      if (this._trace.length < 60) {
        this._trace.push(this.state + '@' + (this._afters || 0) + ':' + Math.round(U.now() - this._clipEndsAt));
      }

      /* 非移动态：动画到点 → 走 after 回调 */
      if ((this.state === 'idle' || this.state === 'acts' || this.state === 'turn' || this.state === 'click')
          && U.now() >= this._clipEndsAt) {
        this._afters = (this._afters || 0) + 1;
        const after = this._after;
        this._after = null;
        if (after) after();
      }

      /* 定时自言自语（只有母宠） */
      if (!this.companion && Settings.get('speech') && !this._peeking) {
        this.speakTimer -= dt;
        if (this.speakTimer <= 0) {
          const lo = Number(Settings.get('intervalMin')) || 20;
          const hi = Math.max(lo, Number(Settings.get('intervalMax')) || 60);
          this.speakTimer = U.rand(lo, hi);
          if (this.state === 'idle' || this.state === 'move') {
            this.scene.say(this, U.pick(this.scene.phrasePool()));
          }
        }
      }
    }

    /* 到达屏幕边缘：标记"探头"，并停留 5 秒（肉眼可见） */
    _markPeek(side) {
      this._peekUntil = U.now() + 5000;
      try { PetBridge.log('[peek] edge ' + side + ' x=' + Math.round(this.x)); } catch (e) {}
    }

    stepMove(dt, b) {
      const plan = this.plan;
      if (!plan) { this.playIdle(); return; }
      if (!plan.startAt) return;      // 等图解码完成
      this.facing = plan.dir;
      if (plan.targetX != null) {
        /* 探头行走：朝目标推进，到达即停（不受 endsAt 影响，保证一定走到边） */
        const dx = plan.targetX - this.x;
        const step = plan.speed * dt;
        if (Math.abs(dx) <= step) {
          this.x = plan.targetX;
          this._markPeek(plan.dir < 0 ? 'left' : 'right');
          this.plan = null;
          this.playIdle();
          this.layout();
          return;
        }
        this.x += Math.sign(dx) * step;
        this.layout();
        return;
      }
      if (plan.cycleMs && plan.cycles) {
        /* 用动画相位推位置：脚走完 = 位移结束 */
        const phase = (U.now() - plan.startAt) / plan.cycleMs;
        const done = Math.min(phase, plan.cycles);
        const { left: bl, right: br } = this.reachBounds();
        this.x = U.clamp(plan.startX + plan.dir * done * plan.stride, bl, br);
        if (plan.startY != null && plan.vy) {
          const b2 = this.scene.bounds();
          this.y = U.clamp(plan.startY + plan.vy * done * (plan.cycleMs / 1000), this.h, b2.h - 8);
        }
        if (phase >= plan.cycles) {
          {
            const { left: cl, right: cr } = this.reachBounds();
            this.x = U.clamp(plan.startX + plan.dir * plan.cycles * plan.stride, cl, cr);
          }   // 精确落在最后一步（并保证不出屏）
          this._frozenX = this.x;                                        // 之后不再移动
          this.plan = null;
          this.playIdle();
          this.layout();
          return;
        }
      } else {
        this.x += plan.dir * plan.speed * dt;
        if (plan.vy) {
          const b2 = this.scene.bounds();
          this.y = U.clamp(this.y + plan.vy * dt, this.h, b2.h - 8);
        }
      }
      const { left, right } = this.reachBounds();
      if (this.x <= left + 1) {
        this.x = left;
        this._frozenX = this.x;
        this.plan = null;
        this.playIdle();
      } else if (this.x >= right - 1) {
        this.x = right;
        this._frozenX = this.x;
        this.plan = null;
        this.playIdle();
      }
      else if (U.now() >= plan.endsAt) {
        this._frozenX = this.x;
        /* 探头档走完的时间点就是"到达边界"（距离恰好等于可达范围，
           不会触发上面的 >=right 分支），这里补一次探头标记 */
        this.plan = null;
        this.playIdle();
      }
      this.layout();
    }

    /* throw_step（physics.py:206-233），子步 ≤ 8ms */
    stepThrow(dt, b) {
      const gravityOn = Settings.get('gravity') !== false;
      const { left, right } = this.reachBounds(true);   // 被甩出去可以撞到屏幕边缘外一点
      const top = this.h;
      const bottom = b.floor;
      let hitGround = false;
      let remain = Math.min(dt, 0.1);
      while (remain > 0) {
        const sdt = Math.min(SUB_DT_MAX, remain);
        remain -= sdt;
        if (gravityOn) this.vy += GRAVITY * sdt;
        else {
          /* 无重力：给点空气阻力，让甩出去的宠物自己停下 */
          this.vx *= Math.max(0, 1 - 0.9 * sdt);
          this.vy *= Math.max(0, 1 - 0.9 * sdt);
        }
        this.x += this.vx * sdt;
        this.y += this.vy * sdt;
        if (this.x < left) { this.x = left; this.vx = Math.abs(this.vx) * RESTITUTION; this.squashT = 0; this._wallBounced = true; }
        else if (this.x > right) { this.x = right; this.vx = -Math.abs(this.vx) * RESTITUTION; this.squashT = 0; this._wallBounced = true; }
        if (this.y < top) { this.y = top; this.vy = Math.abs(this.vy) * RESTITUTION; }
        else if (this.y >= bottom) {
          this.y = bottom;
          hitGround = true;
          this.vx *= Math.max(0, 1 - GROUND_FRICTION * sdt);
          if (Math.abs(this.vy) < GROUND_BOUNCE_STOP_VY) {
            this.vy = 0;
          } else {
            this.vy = -Math.abs(this.vy) * RESTITUTION;
            this.squashT = 0;
          }
        }
      }
      this.layout();

      /* 静止判定（physics.py is_at_rest）
       * 关键：两条判据都必须"已贴地"——否则宠物会在弹跳的最高点被判静止、卡在半空。
       * 第二条额外要求"碰过边"（规格里的 bounced 标记），只用于贴地后仍在慢速横滑的情形。 */
      const atGround = this.y >= bottom - 1;
      const restGround = atGround && Math.abs(this.vy) < 1 && Math.abs(this.vx) < REST_VX;
      const restWall = atGround && this._wallBounced === true &&
        Math.hypot(this.vx, this.vy) < 40 && Math.abs(this.vy) < 1;
      /* 无重力模式：不在"地面"也能停住（否则会一直弹） */
      const restFree = (!gravityOn) && Math.hypot(this.vx, this.vy) < 45;
      this._dbg = `y=${this.y.toFixed(1)} vy=${this.vy.toFixed(1)} bottom=${bottom.toFixed(1)} ` +
        `atGround=${atGround} restGround=${restGround} restWall=${restWall} restFree=${restFree}`;
      if (restGround || restWall || restFree) {
        this.vx = 0;
        this.vy = 0;
        this._wallBounced = false;
        this.state = 'idle';
        this.playIdle();
      }
    }

    /* 当前是否处于"边缘探头"状态：身体探出屏幕约 45% 以上 */
    /* 边缘探头功能已移除：一律返回 null，不再进入探头状态 */
    peekState() {
      return null;
    }

    /* 目标倾斜角（不含缓动） */
    /* 边缘探头已移除：不再倾斜 */
    peekAngleTarget() {
      return 0;
    }

    /* 斜探头角度：按"身体探出屏幕的比例"给 -14°~+14°；
       探出约一半以上才开始倾，探得越多角度越大。关掉边缘探头则不倾。 */
    /* 当前实际倾斜角（由 tick 向目标角缓动，实现"丝滑"进入/退出探头） */
    peekTilt() {
      return 0;
    }

    bodyRect() {
      const body = this.manifest.body_box || [212, 60, 428, 330];
      const crop = this.manifest.crop || { x: 0, y: 0 };
      const s = this.scale;
      const originX = this.x - this.w / 2;
      const originY = this.y - this.h;
      const l = originX + (body[0] - crop.x) * s;
      const t = originY + (body[1] - crop.y) * s;
      const r = originX + (body[2] - crop.x) * s;
      const bt = originY + (body[3] - crop.y) * s;
      return { l, t, r, b: bt, cx: (l + r) / 2, cy: (t + bt) / 2, w: r - l, h: bt - t };
    }

    destroy() {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  Pet.CONST = {
    GRAVITY, RESTITUTION, DEAD_ZONE_SPEED, THROW_CAP_STANDARD,
    MOVE_MIN_PX, MOVE_MAX_PX, MOVE_MARGIN, P_IDLE, P_TURN, P_ACTS,
    SQUASH_MS, SQUASH_W, SQUASH_H, DRAG_THRESHOLD
  };
  global.Pet = Pet;
})(window);
