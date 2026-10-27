// qwen.js —— 千问接口（后台可静默完成的部分）
// 实测结论：getstsToken 不需要 bx-ua 风控签名；OSS PUT 走返回的预签名 URL。
const BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

// 可选日志回调（由 background 注入）
let _log = () => {};
export function setLog(fn) { if (typeof fn === 'function') _log = fn; }

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

// 从 assistant 消息里取「正文」。
// 关键：接口把思考过程和正文分开放在 content_list 里，靠 phase 区分：
//   phase='think'  → 思考过程（可能是英文、很长）
//   phase='answer' → 真正的回答
// content 字段常常为空，所以不能直接用它；更不能把 content_list 全部拼起来，
// 否则会把思考过程当成总结。
//
// 三层退化（复刻桌面版 extract_answer）：只认 answer 段不够健壮 ——
// 实测出现过模型把整段 JSON 写进非 think 段、或 phase 值不是字符串的情况，
// 只认 'answer' 会让 pollAnswer 永远拿不到正文，一直轮询到超时（表现为
// 「千问页面已经把 JSON 输出完了，插件却卡在 AI 生成」）。
export function extractAnswer(msg) {
  if (!msg || msg.role !== 'assistant') return '';
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
  const cl = (msg.content_list || []).filter(x => x && typeof x === 'object');
  if (!cl.length) return '';
  const pick = (fn) => cl.filter(fn).map(x => String(x.content || '')).filter(t => t.trim());
  // 注意用 String(x.phase) 比较：phase 可能是 null / 数字，严格相等会全部漏掉
  let parts = pick(x => String(x.phase) === 'answer');
  if (!parts.length) parts = pick(x => String(x.phase) !== 'think');   // 退化 1：非思考段全要
  if (!parts.length) parts = pick(() => true);                         // 退化 2：全要
  return parts.join('\n\n').trim();
}

export async function pollAnswer(chatId, { maxMs = 25 * 60_000, onTick } = {}) {
  const t0 = Date.now();
  let lastLen = -1;
  let ticks = 0, fails = 0, lastErr = '';
  let doneHits = 0;                       // 连续 done 但拿不到正文的次数
  let lastDone = false, lastPhases = [], lastKeys = [], lastRawLen = 0;
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 8000));
    ticks++;
    try {
      const chat = await fetchChat(chatId);
      const msgs = (chat.messages || []).filter(m => m.role === 'assistant');
      const last = msgs[msgs.length - 1];
      if (!last) {
        if (ticks % 5 === 0) _log(`[轮询] 第 ${ticks} 次：会话里还没有 assistant 消息（已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
        continue;
      }
      // 诊断快照：超时时靠这些定位「为什么取不到正文」
      lastDone = !!last.done;
      lastKeys = Object.keys(last);
      lastPhases = [...new Set((last.content_list || [])
        .filter(x => x && typeof x === 'object')
        .map(x => String(x.phase)))];
      lastRawLen = (last.content_list || [])
        .reduce((n, x) => n + String((x && x.content) || '').length, 0);

      const text = extractAnswer(last);
      if (text && text.length > lastLen) {
        lastLen = text.length;
        onTick?.(text.length, last.model);
      }
      if (last.done && text) {
        _log(`[轮询] 完成：${ticks} 次轮询 / ${fails} 次失败 · 最终 ${text.length} 字 · 模型=${last.model || '?'}`);
        return { text, model: last.model || '' };
      }
      // 保底：生成已结束（连续 2 次 done）却始终取不到 answer 段
      // （模型只输出思考过程 / 拒答 / phase 值异常）。退化取全部文本，避免白等满 25 分钟。
      doneHits = last.done ? doneHits + 1 : 0;
      if (doneHits >= 2) {
        const all = (last.content_list || [])
          .filter(x => x && typeof x === 'object')
          .map(x => String(x.content || ''))
          .filter(t => t.trim());
        const fallback = all.join('\n\n').trim();
        _log(`[轮询] 生成已结束但无 answer 段，退化取全部文本（${fallback.length} 字，phases=[${lastPhases.join(',')}]）`, 'WARN', 'QWEN');
        if (fallback) return { text: fallback, model: last.model || '' };
      }
      if (ticks % 10 === 0) {
        _log(`[轮询] 第 ${ticks} 次：正文 ${text.length} 字 · 原始 ${lastRawLen} 字 · done=${last.done}`
          + ` · phases=[${lastPhases.join(',')}] · 已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    } catch (e) {
      fails++;
      lastErr = String(e?.message ?? e);
      if (fails <= 3 || fails % 10 === 0) _log(`[轮询] 第 ${ticks} 次失败（累计 ${fails}）：${lastErr}`);
    }
  }
  throw new Error(`等待回答超时（${ticks} 次轮询，${fails} 次失败`
    + `，最后 done=${lastDone}，原始正文 ${lastRawLen} 字，phases=[${lastPhases.join(',')}]`
    + `，消息字段=[${lastKeys.join(',')}]`
    + (lastErr ? `，最后一次错误：${lastErr}` : '') + '）');
}
