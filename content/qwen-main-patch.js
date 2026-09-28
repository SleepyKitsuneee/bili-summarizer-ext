// qwen-main-patch.js —— MAIN world，document_start 前注入。
// 1) 拦 #filesUpload.click()：跳过原生文件选择框（我们用 DataTransfer 喂文件）
// 2) 捕获页面请求里的 bx-ua / bx-umidtoken（风控签名），写到 <html> dataset 供隔离世界读取
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
    } catch {}
    return origFetch.apply(this, [input, init]);
  };
})();
