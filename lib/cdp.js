// cdp.js —— 用 chrome.debugger 给目标标签页"注入活性"。
// 背景：隐藏标签页会被浏览器节流（定时器最慢 1 次/分钟、rAF 暂停），
// 千问页面的上传管线因此冻结。CDP 是 DevTools 用的同一套协议：
//   Emulation.setFocusEmulationEnabled(true) → 页面以为自己被聚焦
//   Page.setWebLifecycleState('active')      → visibilityState 翻成 visible（实测过）
// 关键：附加后必须**验证** visibilityState 真的变成 visible，不达标就重试
//（附加偶发失败，这是"偶尔卡住必须手动点开千问页"的嫌疑根因）。
// 副作用：附加期间窗口顶部有一条"扩展正在调试此浏览器"的提示条，detach 后消失。
//         **不会切换/移动用户的任何标签页**。
const VERSION = '1.3';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function attachOnce(tabId, log) {
  try { await chrome.debugger.detach({ tabId }); log?.('先清除可能的残留调试会话'); } catch {}
  await chrome.debugger.attach({ tabId }, VERSION);
  log?.('attach 成功');
  const send = (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
  await send('Page.enable').catch((e) => log?.(`Page.enable 失败: ${e.message}`));
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    .then(() => log?.('焦点模拟已开启'))
    .catch((e) => log?.(`焦点模拟失败: ${e.message}`));
  await send('Page.setWebLifecycleState', { state: 'active' })
    .then(() => log?.('生命周期已置 active'))
    .catch((e) => log?.(`生命周期失败: ${e.message}`));
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({v:document.visibilityState,f:document.hasFocus()})',
    returnByValue: true,
  });
  const st = JSON.parse(r?.result?.value || '{}');
  log?.(`页面自报状态: ${JSON.stringify(st)}`);
  return { send, state: st, detach: () => chrome.debugger.detach({ tabId }).catch(() => {}) };
}

// 返回 { send, state, attempts, ok, detach }；彻底失败则抛错
export async function cdpEnsureActive(tabId, maxAttempts = 4, log = null) {
  let lastErr = null;
  for (let i = 1; i <= maxAttempts; i++) {
    log?.(`第 ${i}/${maxAttempts} 次尝试附加…`);
    try {
      const r = await attachOnce(tabId, log);
      if (r.state?.v === 'visible') return { ...r, ok: true, attempts: i };
      lastErr = new Error('页面仍处于 ' + (r.state?.v || '未知') + ' 状态');
      log?.(`验证未通过：${lastErr.message}，解除后重试`);
      await r.detach();
      await sleep(800);
    } catch (e) {
      lastErr = e;
      log?.(`附加异常: ${e.message}`);
      await sleep(1200);
    }
  }
  throw new Error(`调试器附加/激活失败（${maxAttempts} 次）：${lastErr?.message ?? lastErr}`);
}
