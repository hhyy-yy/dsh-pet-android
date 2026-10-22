/* chat.js —— AI 对话（OpenAI Chat Completions 兼容） */
(function (global) {
  'use strict';

  const KEY = 'dsh-pet-harmony/chat/v1';
  const MAX_STORE = 200;

  function normalizeEndpoint(base) {
    let u = String(base || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  }

  class Chat {
    constructor(scene) {
      this.scene = scene;
      this.messages = [];
      this.busy = false;
      this.logEl = U.$('#chat-log');
      this.inputEl = U.$('#chat-input');
      this.statusEl = U.$('#chat-status');
      this._load();
      this.render();
    }

    _load() {
      try {
        const raw = global.localStorage.getItem(KEY);
        const arr = raw ? JSON.parse(raw) : [];
        this.messages = Array.isArray(arr) ? arr : [];
      } catch (e) { this.messages = []; }
    }

    _save() {
      try {
        const trimmed = this.messages.slice(-MAX_STORE);
        global.localStorage.setItem(KEY, JSON.stringify(trimmed));
      } catch (e) { /* 配额 */ }
    }

    clear() {
      this.messages = [];
      this._save();
      this.render();
      this.setStatus('');
    }

    setStatus(text, busy) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text || '';
      this.statusEl.classList.toggle('busy', !!busy);
    }

    render() {
      if (!this.logEl) return;
      this.logEl.textContent = '';
      if (!this.messages.length) {
        const tip = U.el('div', 'msg ai');
        const b = U.el('div', 'msg-bubble',
          '我是蓝色大肥鱼。先在「设置 → AI 对话」里填上接口地址和模型名，然后就能聊天啦。');
        tip.appendChild(b);
        this.logEl.appendChild(tip);
        return;
      }
      this.messages.forEach((m) => this.appendBubble(m.role, m.content, m.ts, m.error));
      this.scrollBottom();
    }

    appendBubble(role, content, ts, isErr) {
      const wrap = U.el('div', 'msg ' + (role === 'user' ? 'me' : 'ai') + (isErr ? ' err' : ''));
      const b = U.el('div', 'msg-bubble');
      b.textContent = content;
      const meta = U.el('div', 'msg-meta', U.fmtTime(ts || Date.now()));
      wrap.appendChild(b);
      wrap.appendChild(meta);
      this.logEl.appendChild(wrap);
      return wrap;
    }

    scrollBottom() {
      if (!this.logEl) return;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    historySlice() {
      const turns = Number(Settings.get('historyTurns'));
      const n = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : 8;
      const usable = this.messages.filter((m) => !m.error);
      return n === 0 ? [] : usable.slice(-n * 2);
    }

    /* 时间格式化：和电脑版 prompt.py 一致（2026-10-22 周三 04:30） */
    _fmtTime(ts) {
      const d = new Date(ts || Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' 周' + '日一二三四五六'[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    _fmtElapsed(sec) {
      const m = Math.floor(sec / 60);
      const days = Math.floor(m / 1440);
      const rest = m % 1440;
      const hours = Math.floor(rest / 60);
      const mins = rest % 60;
      if (days) return days + ' 天' + (hours ? ' ' + hours + ' 小时' : '');
      if (hours) return hours + ' 小时' + (mins ? ' ' + mins + ' 分钟' : '');
      return mins + ' 分钟';
    }

    /* 时间感知（移植自电脑版 pet/chat/prompt.py）：
       ① 系统提示词末尾附"当前时间 + 距上次对话多久"；
       ② 历史里的用户消息前面加 [日期 时间] 时间戳，让她能感知时间流逝；
       ③ 明确要求不要复述这些时间标记。 */
    _timeContext() {
      const now = Date.now();
      let last = null;
      for (let i = this.messages.length - 1; i >= 0; i -= 1) {
        if (this.messages[i] && this.messages[i].ts) { last = this.messages[i].ts; break; }
      }
      let elapsed = '';
      if (last && (now - last) / 1000 >= 600) {
        elapsed = '距离上一条消息（' + this._fmtTime(last) + '）已经过去约 ' +
          this._fmtElapsed((now - last) / 1000) + '。';
      }
      return '【时间信息】当前时间：' + this._fmtTime(now) + '。' + elapsed +
        '对话记录中用户消息开头的「[日期 时间]」是系统自动附加的发送时间，' +
        '用来帮助你感知时间流逝（隔了多久没聊、现在是白天还是深夜、日期是否变了），' +
        '回复时自然体现即可；不要在回复中复述或模仿这种时间标记。';
    }

    buildBody(userText) {
      const sys = Settings.persona() + '\n\n' + this._timeContext();
      const msgs = [{ role: 'system', content: sys }];
      this.historySlice().forEach((m) => {
        const isUser = m.role === 'user';
        const content = (isUser && m.ts) ? ('[' + this._fmtTime(m.ts) + '] ' + m.content) : m.content;
        msgs.push({ role: isUser ? 'user' : 'assistant', content: content });
      });
      msgs.push({ role: 'user', content: userText });

      const model = String(Settings.get('aiModel') || '').trim();
      /* 思考类模型（deepseek-reasoner 等）不支持采样参数；传了不报错但无效果，
         因此干脆不发，避免混淆。 */
      const thinking = /reasoner|-r1|thinking|v4-pro/i.test(model);
      const body = {
        model: model,
        messages: msgs,
        stream: false,
        max_tokens: Math.max(256, Number(Settings.get('aiMaxTokens')) || 2048)
      };
      if (!thinking) body.temperature = Number(Settings.get('aiTemp'));
      return body;
    }

    async send(text) {
      const content = String(text || '').trim();
      if (!content || this.busy) return;
      if (!Settings.aiReady()) {
        this.setStatus('还没配置接口地址 / 模型名');
        PetBridge.toast('先在设置里填 AI 接口地址与模型名');
        return;
      }

      this.messages.push({ role: 'user', content, ts: Date.now() });
      this._save();
      this.render();

      const url = normalizeEndpoint(Settings.get('aiBase'));
      const key = String(Settings.get('aiKey') || '').trim();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;

      this.busy = true;
      this.setStatus('正在想…', true);
      /* deepseek-reasoner 这类思考模型首字可能几十秒，换一句更贴切的提示 */
      if (this._thinkTimer) clearTimeout(this._thinkTimer);
      this._thinkTimer = setTimeout(() => {
        if (this.busy) this.setStatus('她还在认真想…（思考模型首字会比较慢）');
      }, 8000);
      const placeholder = this.appendBubble('assistant', '…', Date.now());
      this.scrollBottom();

      try {
        const res = await PetBridge.httpPost(url, headers, this.buildBody(content));
        let payload = null;
        try { payload = JSON.parse(res.body); } catch (e) { payload = null; }

        if (res.status >= 200 && res.status < 300 && payload) {
          const choice = (payload.choices && payload.choices[0]) || null;
          const msg = choice && (choice.message || choice.delta) || null;
          let reply = msg && msg.content;
          if (Array.isArray(reply)) {
            reply = reply.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
          }
          reply = String(reply || '').trim();
          if (!reply) throw new Error('接口返回里没有 content 字段');
          this.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
          this._save();
          this.render();
          this.setStatus('');

          /* 宠物气泡里说一句短的，并按需朗读 */
          const short = reply.replace(/\s+/g, ' ').slice(0, 42) + (reply.length > 42 ? '…' : '');
          const primary = this.scene.pets.find((p) => !p.companion);
          if (primary) this.scene.say(primary, short);
          if (Settings.get('tts')) {
            PetBridge.speak(reply, Number(Settings.get('ttsRate')) || 1);
          }
        } else {
          const detail = payload && payload.error
            ? (payload.error.message || JSON.stringify(payload.error))
            : String(res.body || '').slice(0, 300);
          throw new Error(`HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
        }
      } catch (err) {
        if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        const msg = '调用失败：' + (err && err.message ? err.message : String(err));
        this.messages.push({ role: 'assistant', content: msg, ts: Date.now(), error: true });
        this._save();
        this.render();
        this.setStatus('请求失败');
      } finally {
        if (this._thinkTimer) { clearTimeout(this._thinkTimer); this._thinkTimer = 0; }
        this.busy = false;
      }
    }
  }

  Chat.normalizeEndpoint = normalizeEndpoint;
  global.Chat = Chat;
})(window);
