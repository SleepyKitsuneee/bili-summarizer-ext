// qwen.js —— 千问接口（后台可静默完成的部分）
// 实测结论：getstsToken 不需要 bx-ua 风控签名；OSS PUT 走返回的预签名 URL。
const BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

function h(extra = {}) {
  return {
    'user-agent': UA,
    'accept': 'application/json',
    'referer': BASE + '/',
    'origin': BASE,
    'source': 'web',
    'version': '0.2.91',
    ...extra,
  };
}

export async function getstsToken(fileType, fileSize, fileName) {
  const r = await fetch(BASE + '/api/v2/files/getstsToken', {
    method: 'POST',
    credentials: 'include',
    headers: h({ 'content-type': 'application/json' }),
    body: JSON.stringify({ file_type: fileType, file_size: fileSize, file_name: fileName }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error('取上传凭证失败 HTTP ' + r.status);
  return j.data; // { file_url: 预签名 PUT 地址, ... }
}

export async function ossPut(fileUrl, buf, contentType) {
  const r = await fetch(fileUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: buf,
  });
  if (!(r.status === 200 || r.status === 201 || r.status === 204)) {
    throw new Error('OSS 上传失败 HTTP ' + r.status);
  }
}

// 读取接口不受风控：轮询会话直到回答完成
export async function fetchChat(chatId) {
  const r = await fetch(`${BASE}/api/v2/chats/${chatId}`, {
    credentials: 'include',
    headers: h(),
  });
  if (!r.ok) throw new Error('读会话失败 HTTP ' + r.status);
  const j = await r.json();
  return (j?.data?.chat) || {};
}

export function extractAnswer(msg) {
  if (!msg || msg.role !== 'assistant') return '';
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  const parts = (msg.content_list || [])
    .filter(x => x && x.phase === 'answer')
    .map(x => String(x.content || ''));
  return parts.join('\n\n');
}

export async function pollAnswer(chatId, { maxMs = 25 * 60_000, onTick } = {}) {
  const t0 = Date.now();
  let lastLen = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const chat = await fetchChat(chatId);
      const msgs = (chat.messages || []).filter(m => m.role === 'assistant');
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      const text = extractAnswer(last);
      if (text && text.length > lastLen) {
        lastLen = text.length;
        onTick?.(text.length, last.model);
      }
      if (last.done && text) return { text, model: last.model || '' };
    } catch (e) { /* 轮询失败继续重试 */ }
  }
  throw new Error('等待回答超时');
}
