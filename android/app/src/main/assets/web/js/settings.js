/* settings.js —— 设置项、默认值、持久化 */
(function (global) {
  'use strict';

  const KEY = 'dsh-pet-harmony/settings/v1';

  /* 内置台词池：桌面版 DEFAULT_SELF_TALK_TEXTS 原文（5 条，一个字没改） */
  const DEFAULT_SELF_TALK = [
    '好女孩……',
    '好模型……',
    '欧鲸鲸……',
    '今天也要认真工作呀。',
    '再陪你一会儿。'
  ];

  /* 内置人格：平板端首发，措辞与桌面人格模板一致的精神 */
  const DEFAULT_PERSONA = [
    '你叫「蓝色大肥鱼」，是一只住在平板上的蓝色小鲸鱼桌宠。',
    '说话口语化、短句、带一点点撒娇，不用敬语，不写 Markdown 标题。',
    '用户点你一下、拖你一下都是想跟你玩，回应要轻快。',
    '不知道的事就直说不知道，不要编。回答控制在 3 句以内。'
  ].join('\n');

  const SCHEMA = {
    __v:          { def: 5, type: 'number' },   // 设置版本（内部用，不显示；与 SCHEMA_VERSION 保持一致）
    /* 外观 */
    scale:        { def: 0,    type: 'number' },   // 0 = 自动：启动时按屏幕短边算
    showToolbar:  { def: true, type: 'bool' },
    transparentBg:{ def: false, type: 'bool' },
    /* 互动 */
    wander:       { def: true, type: 'bool' },
    randomActions:{ def: true, type: 'bool' },
    speech:       { def: true, type: 'bool' },
    bubbleSeconds:{ def: 3.2,  type: 'number' },
    intervalMin:  { def: 20,   type: 'number' },
    intervalMax:  { def: 60,   type: 'number' },
    phrases:      { def: '',   type: 'string' },
    /* 音效 */
    clickSound:   { def: true, type: 'bool' },
    clickVolume:  { def: 0.7,  type: 'number' },
    /* 小鲸鱼与碰撞 */
    companions:   { def: false, type: 'bool' },   // 默认不生小鲸鱼（菜单里可以手动叫）
    collision:    { def: true, type: 'bool' },
    restitution:  { def: 0.82, type: 'number' },
    gravity:      { def: true,  type: 'bool' },
    overlayCrisp: { def: false, type: 'bool' },     // 悬浮颜色优先（拖拽略顿，但不再是 80% 透明）
    overlayPunch: { def: 0.5,   type: 'number' },   // 悬浮层浓淡（0~1）：对抗系统把悬浮窗压成 80% 不透明   // 拖拽时放大取景框（更顺滑，部分机型会闪）
    /* AI 与语音 */
    aiBase:       { def: '',   type: 'string' },
    aiKey:        { def: '',   type: 'string' },
    aiModel:      { def: '',   type: 'string' },
    aiTemp:       { def: 0.9,  type: 'number' },
    aiMaxTokens:  { def: 2048, type: 'number' },   // 回复长度上限（deepseek-reasoner 思考模式下尤其需要）
    aiPrompt:     { def: '',   type: 'string' },
    tts:          { def: true, type: 'bool' },
    ttsRate:      { def: 1.0,  type: 'number' },
    historyTurns: { def: 8,    type: 'number' }
  };

  /* 设置版本：改了默认值就 +1，并在 MIGRATIONS 里写清楚怎么迁。
     （老用户本地已存的旧值不会自动跟新默认值，必须显式迁移） */
  const SCHEMA_VERSION = 5;

  function migrate(base, raw) {
    const stored = Number(raw && raw.__v ? raw.__v : 1);
    if (stored < 2) {
      /* v2：默认不再生成小鲸鱼。老版本默认是开的，用户没主动开过，
         升级后统一关掉，避免一开应用就一只大的两只小的。 */
      base.companions = false;
      try { console.log('[settings] migrated to v2 -> companions=false'); } catch (e) {}
    }
    if (stored < 5) {
      base.dragCamera = true;
    }
    if (stored < 4) {
      base.dragCamera = false;   // v4：改回"窗口跟随"策略，不再切换窗口尺寸
    }
    if (stored < 3) {
      /* v3：拖拽取景框改为无条件启用，本地残留的 dragCamera=false 作废 */
      base.dragCamera = true;
      try { console.log('[settings] migrated to v3 -> dragCamera=true'); } catch (e) {}
    }
    base.__v = SCHEMA_VERSION;
    return base;
  }

  const listeners = [];
  let data = null;

  function defaults() {
    const o = {};
    Object.keys(SCHEMA).forEach((k) => { o[k] = SCHEMA[k].def; });
    return o;
  }

  function coerce(key, value) {
    const s = SCHEMA[key];
    if (!s) return value;
    if (s.type === 'bool') return !!value;
    if (s.type === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : s.def;
    }
    return value == null ? '' : String(value);
  }

  function load() {
    let raw = {};
    try {
      const txt = global.localStorage.getItem(KEY);
      if (txt) raw = JSON.parse(txt) || {};
    } catch (e) { raw = {}; }
    const base = defaults();
    Object.keys(SCHEMA).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(raw, k)) base[k] = coerce(k, raw[k]);
    });
    /* 强制不变量：说话间隔 最短 ≤ 最长 */
    if (base.intervalMin > base.intervalMax) base.intervalMax = base.intervalMin;
    data = migrate(base, raw);
    return data;
  }

  const Settings = {
    DEFAULT_SELF_TALK,
    DEFAULT_PERSONA,
    SCHEMA,

    all() { return data || load(); },
    get(key) { return (data || load())[key]; },

    set(key, value, opts) {
      if (!SCHEMA[key]) return;
      const v = coerce(key, value);
      if ((data || load())[key] === v) return;
      (data || load())[key] = v;
      if (key === 'intervalMin' && data.intervalMin > data.intervalMax) data.intervalMax = data.intervalMin;
      if (key === 'intervalMax' && data.intervalMax < data.intervalMin) data.intervalMin = data.intervalMax;
      Settings.save();
      if (!opts || opts.silent !== true) {
        listeners.forEach((fn) => { try { fn(key, v); } catch (e) { console.warn(e); } });
      }
    },

    save() {
      try { global.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 配额或隐私模式 */ }
      /* 真机（file:// 源）localStorage 不一定可用，再往原生偏好里落一份 */
      try {
        if (global.PetBridge && global.PetBridge.saveKV) {
          global.PetBridge.saveKV('settings', JSON.stringify(data)).catch(() => {});
        }
      } catch (e) { /* noop */ }
    },

    /* 开机时用原生偏好里的备份覆盖一次（原生存储优先） */
    hydrate(jsonText) {
      if (!jsonText) return false;
      let raw = null;
      try { raw = JSON.parse(jsonText); } catch (e) { return false; }
      if (!raw || typeof raw !== 'object') return false;
      const next = defaults();
      Object.keys(SCHEMA).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(raw, k)) next[k] = coerce(k, raw[k]);
      });
      if (next.intervalMin > next.intervalMax) next.intervalMax = next.intervalMin;
      data = migrate(next, raw);
      try { global.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* noop */ }
      return true;
    },

    reset() {
      data = defaults();
      Settings.save();
      listeners.forEach((fn) => { try { fn('*', data); } catch (e) { console.warn(e); } });
      return data;
    },

    onChange(fn) { listeners.push(fn); },

    /* 台词池：用户填了就用用户的，否则内置 5 条 */
    phrasePool() {
      const raw = String((data || load()).phrases || '');
      const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return lines.length ? lines : DEFAULT_SELF_TALK.slice();
    },

    persona() {
      const p = String((data || load()).aiPrompt || '').trim();
      return p || DEFAULT_PERSONA;
    },

    /* 是否已配置 AI（地址 + 模型 必填，key 允许本地服务留空） */
    aiReady() {
      const d = data || load();
      return !!(String(d.aiBase || '').trim() && String(d.aiModel || '').trim());
    }
  };

  load();
  global.Settings = Settings;
})(window);
