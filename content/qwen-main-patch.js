// qwen-main-patch.js —— MAIN world，document_start 前注入。
// 1) 拦 #filesUpload.click()：跳过原生文件选择框（我们用 DataTransfer 喂文件）
// 2) 捕获页面请求里的 bx-ua / bx-umidtoken（风控签名），写到 <html> dataset 供隔离世界读取
// 3) 捕获「创建会话」接口返回的 chat_id —— 页面 URL 可能停在 /c/new-chat，
//    真实会话 ID 只在响应体里，这是拿不到 chatId 的根因。
(() => {
  if (window.__qwenPatch) {
    document.documentElement.dataset.qwenPatch = '1';
    return;
  }
  window.__qwenPatch = true;
  document.documentElement.dataset.qwenPatch = '1';   // 供隔离世界 driver 检测补丁就绪

  const origInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this && this.id === 'filesUpload') return;      // 不弹原生选择框
    return origInputClick.call(this);
  };

  const cap = {};
  const publish = (() => {
    let n = 0;
    return () => {
      if (++n % 1 !== 0) return;
      try { document.documentElement.dataset.qwenCapture = JSON.stringify(cap); } catch {}
    };
  })();

  // 从任意响应 JSON 里挖出 chat_id（字段名可能是 chat_id / chatId / id）
  const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function digChatId(obj, depth = 0) {
    if (!obj || depth > 4) return null;
    if (Array.isArray(obj)) {
      for (const x of obj) { const r = digChatId(x, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof obj !== 'object') return null;
    for (const k of ['chat_id', 'chatId', 'conversation_id', 'conversationId', 'session_id']) {
      const v = obj[k];
      if (typeof v === 'string' && CHAT_ID_RE.test(v)) return v;
    }
    for (const v of Object.values(obj)) {
      const r = digChatId(v, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // 记录「创建会话」相关请求的响应，抓真实 chatId
  const chatIds = (cap.__chatIds = []);
  function noteChatId(src, url, json) {
    try {
      const id = digChatId(json);
      if (!id) return;
      if (chatIds.some(x => x.id === id)) return;
      chatIds.push({ id, src, u: String(url || '').slice(0, 120), t: Date.now() });
      cap.__lastChatId = id;
      cap.__lastChatIdAt = Date.now();
      publish();
    } catch {}
  }
  const isChatCreateUrl = (u) =>
    /\/api\/.*(chat|conversation|session)/i.test(String(u || '')) && !/getstsToken|files\//.test(String(u || ''));

  // 网络证据：页面发出 getstsToken / OSS 上传请求 = 附件已被页面处理
  const net = (cap.__net = []);
  const noteNet = (method, url) => {
    try {
      const u = String(url || '');
      if (/getstsToken|files\/|aliyuncs\.com|oss/.test(u) && net.length < 20) {
        net.push({ m: method, u: u.slice(0, 120), t: Date.now() });
        publish();
      }
    } catch {}
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__qwenUrl = String(url || '');
    this.__qwenMethod = String(method || '');
    noteNet(this.__qwenMethod, this.__qwenUrl);
    // XHR 响应里也抓 chatId（有些请求走 XHR）
    if (isChatCreateUrl(this.__qwenUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            noteChatId('xhr', this.__qwenUrl, JSON.parse(this.responseText));
          } else if (this.responseType === 'json') {
            noteChatId('xhr', this.__qwenUrl, this.response);
          }
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      const lk = String(k).toLowerCase();
      if (this.__qwenUrl && this.__qwenUrl.includes('/api/') &&
          (lk === 'bx-ua' || lk === 'bx-umidtoken')) {
        cap[lk] = String(v);
        publish();
      }
    } catch {}
    return origSet.call(this, k, v);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      noteNet(method, url);
      const hs = (init && init.headers) || (input && input.headers);
      if (url.includes('/api/') && hs) {
        const get = (k) => {
          if (hs.get) return hs.get(k);
          if (Array.isArray(hs)) { const x = hs.find(([n]) => String(n).toLowerCase() === k); return x && x[1]; }
          return hs[k];
        };
        for (const k of ['bx-ua', 'bx-umidtoken']) {
          const v = get(k);
          if (v) { cap[k] = String(v); publish(); }
        }
      }
      // 创建会话的响应里抓 chatId
      const p = origFetch.apply(this, [input, init]);
      if (isChatCreateUrl(url)) {
        p.then((r) => {
          try {
            const clone = r.clone();
            clone.json().then((j) => noteChatId('fetch', url, j)).catch(() => {});
          } catch {}
        }).catch(() => {});
      }
      return p;
    } catch {}
    return origFetch.apply(this, [input, init]);
  };
})();
