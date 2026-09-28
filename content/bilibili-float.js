// B站视频页浮动按钮：点一下 → 打开侧边栏并自动开始总结当前视频
(() => {
  if (window.__biliSumBtn) return;
  window.__biliSumBtn = true;

  const bvid = (location.href.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  if (!bvid) return;

  const style = document.createElement('style');
  style.textContent = `
    #bili-sum-fab{position:fixed;right:24px;bottom:88px;z-index:999999;
      background:#0a84ff;color:#fff;border:none;border-radius:22px;
      padding:11px 20px;font-size:14px;font-weight:600;font-family:"Microsoft YaHei UI",sans-serif;
      cursor:pointer;box-shadow:0 4px 16px rgba(10,132,255,.4);
      transition:transform .15s ease, box-shadow .15s ease;}
    #bili-sum-fab:hover{transform:translateY(-2px);box-shadow:0 6px 22px rgba(10,132,255,.55);}
    #bili-sum-fab:active{transform:translateY(0) scale(.97);}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'bili-sum-fab';
  btn.textContent = '✦ AI 总结此视频';
  btn.title = '下载本视频并生成结构化总结';
  btn.addEventListener('click', () => {
    btn.textContent = '⏳ 已请求…';
    chrome.runtime.sendMessage(
      { type: 'SUMMARIZE_CURRENT', url: location.href, tabId: null },
      () => { btn.textContent = '✓ 已在侧边栏'; setTimeout(() => (btn.textContent = '✦ AI 总结此视频'), 2500); }
    );
  });
  document.documentElement.appendChild(btn);
})();
