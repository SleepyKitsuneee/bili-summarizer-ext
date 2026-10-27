// qwen.js —— 千问接口（后台可静默完成的部分）
// 实测结论：getstsToken 不需要 bx-ua 风控签名；OSS PUT 走返回的预签名 URL。
const BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

// 可选日志回调（由 background 注入）
let _log = () => {};
export function setLog(fn) { if (typeof fn === 'function') _log = fn; }

// 可选「页面代理」：从 chat.qwen.ai 页面内部发请求（同源，自带登录 cookie）。
// 为什么需要：Service Worker 发起的 fetch 算第三方请求，千问的登录 cookie 是
// SameSite=Lax，不会随 credentials:'include' 发出，结果接口返回
// {"success":false,"data":{"code":"Unauthorized"}}。
// 桌面版能用是因为它把浏览器 cookie 显式复制进了 requests session。
let _pageFetch = null;
export function setPageFetch(fn) { _pageFetch = typeof fn === 'function' ? fn : null; }

// 可选「接口普查」回调：读会话失败时把所有候选接口试一遍，一次性定位真因
let _probeApis = null;
export function setProbeApis(fn) { _probeApis = typeof fn === 'function' ? fn : null; }

function h(extra = {}, chatId = '') {
  return {
    'user-agent': UA,
    'accept': 'application/json',
    // 桌面版用的是 page.url（完整会话页 URL）。首页 referer 可能被判成跨会话访问，
    // 这里优先拼会话页地址；没有 chatId 时退回首页。
    'referer': chatId ? `${BASE}/c/${chatId}` : BASE + '/',
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

// 在 chat 对象里找「消息数组」。
// 正常是 chat.messages；但接口改过字段名/层级，所以兜底找一个「元素带 role 的对象数组」。
// 这样即使 messages 被改名，也能自动接上，而不是傻等 25 分钟。
export function findMessageArray(chat) {
  if (!chat || typeof chat !== 'object') return { key: null, list: [] };
  if (Array.isArray(chat.messages)) return { key: 'messages', list: chat.messages };
  for (const [k, v] of Object.entries(chat)) {
    if (!Array.isArray(v) || !v.length) continue;
    const first = v.find(x => x && typeof x === 'object');
    if (first && ('role' in first || 'content_list' in first)) return { key: k, list: v };
  }
  return { key: null, list: [] };
}

// 从响应里挑出「会话对象」。
// 正常路径是 data.chat；如果那里没有消息数组，就试试 data 本身（接口层级变过）。
function pickChat(j) {
  const direct = j?.data?.chat;
  if (direct && typeof direct === 'object' && findMessageArray(direct).key) {
    return { chat: direct, from: 'data.chat' };
  }
  if (j?.data && typeof j.data === 'object' && findMessageArray(j.data).key) {
    return { chat: j.data, from: 'data' };
  }
  if (j?.chat && typeof j.chat === 'object' && findMessageArray(j.chat).key) {
    return { chat: j.chat, from: 'chat' };
  }
  return { chat: (direct && typeof direct === 'object') ? direct : {}, from: 'data.chat(空)' };
}

// 读取接口不受风控：轮询会话直到回答完成。
// 优先走「页面代理」（同源，带登录 cookie）；页面不可用时才回退到 SW 直连。
// diagnose=true 时把所有可能影响结果的信息都记下来：
//   · 实际发出的 URL / referer / 完整请求头
//   · 页面侧现场（location.href、cookie 可见性、登录态）
//   · 响应体结构（顶层/data/chat 字段，code/details/message 的具体值）
export async function fetchChat(chatId, { diagnose = false } = {}) {
  const url = `${BASE}/api/v2/chats/${chatId}`;
  // referer 用完整会话页 URL（桌面版就是 page.url）；首页 referer 可能被判成跨会话访问
  const referer = `${BASE}/c/${chatId}`;
  const headers = h({ referer }, chatId);
  let status, j, channel;

  if (_pageFetch) {
    channel = '页面代理(同源)';
    const res = await _pageFetch(url, { headers, chatId });
    status = res.status;
    // 页面侧现场：代理会把 location/cookie 信息一并回传
    if (diagnose && res.page) {
      const p = res.page;
      _log(`[诊断] 页面现场：location=${trunc(p.href, 160)}`
        + ` · 是否在会话页=${p.onChatPage}`
        + ` · document.cookie 长度=${p.cookieLen}`
        + ` · cookie 名=[${(p.cookieNames || []).join(',')}]`
        + ` · 有登录态标记=${p.hasLoginHint}`);
      if (p.href && !String(p.href).includes(chatId)) {
        _log(`[诊断] ⚠ 页面 URL 里不含该 chatId，可能已跳到别的会话`, 'WARN', 'QWEN');
      }
    }
    if (!res.ok) throw new Error('读会话失败 HTTP ' + res.status);
    j = res.json;
    if (diagnose) _log(`[诊断] 通道=${channel} · 请求 URL=${url} · referer=${referer}`);
  } else {
    channel = 'SW 直连';
    const r = await fetch(url, { credentials: 'include', headers });
    status = r.status;
    if (!r.ok) throw new Error('读会话失败 HTTP ' + r.status);
    j = await r.json();
    if (diagnose) {
      _log(`[诊断] 通道=${channel}（无页面代理，cookie 可能缺失）`);
      _log(`[诊断] 请求 URL=${url} · referer=${referer}`);
    }
  }
  const { chat, from } = pickChat(j);
  const found = findMessageArray(chat);
  // 接口返回了业务错误：success=false 且 data 里只有 code/details，没有 chat。
  // 实测这种响应下 messages 永远是空的，以前只记字段名不记值，导致看不出真因。
  const bizError = (j?.success === false) || (!found.key && !j?.data?.chat);
  if (diagnose) {
    _log(`[诊断] 响应：HTTP ${status}`
      + ` · 顶层=[${Object.keys(j || {}).join(',')}]`
      + ` · data=[${Object.keys(j?.data || {}).join(',')}]`
      + ` · chat=[${Object.keys(chat || {}).join(',')}]`
      + ` · 取自 ${from}`
      + ` · success=${j?.success ?? '-'} · code=${j?.code ?? '-'}`);
    // 关键：把业务错误的具体值记下来（以前只记字段名，等于没记）
    _log(`[诊断] data.code=${JSON.stringify(j?.data?.code) ?? '-'}`
      + ` · data.details=${trunc(j?.data?.details)}`
      + ` · data.message=${trunc(j?.data?.message ?? j?.message)}`);
    if (bizError) {
      _log(`[诊断] 接口返回业务错误，完整响应体：${trunc(j, 800)}`, 'WARN', 'QWEN');
    }
    const roles = found.list.length
      ? [...new Set(found.list.map(m => (m && m.role) || '?'))].join(',')
      : '';
    _log(`[诊断] 消息字段=${found.key || '未找到'} · ${found.list.length} 条`
      + (roles ? ` · roles=[${roles}]` : '')
      + (found.list.length ? ` · 末条字段=[${Object.keys(found.list[found.list.length - 1] || {}).join(',')}]` : ''));
  } else if (from !== 'data.chat' && from !== 'data.chat(空)') {
    // 结构变化只在第一次发现时提示，避免刷屏
    if (!fetchChat._warned) {
      fetchChat._warned = true;
      _log(`[诊断] 会话对象不在 data.chat，自动改用「${from}」——接口结构可能已变`, 'WARN', 'QWEN');
    }
  }
  // 把业务错误挂在返回对象上（用不可枚举属性，不干扰 findMessageArray）
  if (bizError) {
    Object.defineProperty(chat, '__bizError', {
      value: `success=${j?.success} code=${JSON.stringify(j?.data?.code)} details=${trunc(j?.data?.details, 200)}`,
      enumerable: false,
    });
  }
  return chat;
}

// 截断任意值成单行字符串（日志用）
function trunc(v, max = 300) {
  if (v === undefined || v === null) return '-';
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch { s = String(v); }
  s = String(s ?? '-').replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + `…（截断，原长 ${s.length}）` : s;
}

// 一次性探针：任务开始时先确认 chatId 真的能取到会话，避免白等 25 分钟。
// 注意：HTTP 200 不代表成功 —— 接口可能返回 success=false + data.code/details。
export async function probeChat(chatId) {
  try {
    const chat = await fetchChat(chatId, { diagnose: true });
    const found = findMessageArray(chat);
    const assistants = found.list.filter(m => m && m.role === 'assistant');
    // 业务错误 → 如实报失败，不要谎称「有效」
    if (chat.__bizError) {
      return { ok: false, bizError: true, error: chat.__bizError, messageKey: found.key, total: found.list.length };
    }
    if (!found.key) {
      return { ok: false, error: '响应里找不到消息数组（接口结构可能已变）', messageKey: null, total: 0 };
    }
    return {
      ok: true,
      messageKey: found.key,
      total: found.list.length,
      assistants: assistants.length,
      hasDone: assistants.some(m => m && m.done),
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    _log(`[诊断] 探针失败：${msg}`, 'ERROR', 'QWEN');
    // 代理通道本身故障（页面没就绪/消息通道断了）→ 原样抛出，让上层看到真实原因
    if (/代理失败/.test(msg)) throw e;
    return { ok: false, error: msg };
  }
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
  let emptyHits = 0;                      // 连续「连消息都没有」的次数
  let fatal = null;                       // 致命错误：立刻退出，不要被 catch 吞掉
  let msgKey = null;                      // 实际用到的消息字段名

  // 开跑前先探一次：确认 chatId 有效、消息字段在哪、有没有 assistant 消息。
  // 这一步能在 1 秒内暴露「chatId 对不上 / 接口结构变了」，而不是等 25 分钟。
  const probe = await probeChat(chatId);
  if (probe.ok) {
    msgKey = probe.messageKey;
    _log(`[探针] chatId 有效 · 消息字段=${probe.messageKey || '未找到'}`
      + ` · 共 ${probe.total} 条 · assistant ${probe.assistants} 条`
      + (probe.assistants ? '' : '（还没开始生成，正常）'), 'INFO', 'QWEN');
  } else if (probe.bizError) {
    // 接口明确报错（success=false），轮询下去毫无意义，立刻失败
    if (_probeApis) await _probeApis(chatId).catch(() => {});
    throw new Error(`读会话接口返回业务错误：${probe.error}。`
      + `chatId=${chatId}。多半是 chatId 与页面实际会话不一致，或该会话已被清理。`);
  } else {
    _log(`[探针] chatId 校验未通过：${probe.error}（仍继续轮询观察）`, 'WARN', 'QWEN');
    if (_probeApis) await _probeApis(chatId).catch(() => {});
  }

  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 8000));
    ticks++;
    if (fatal) break;                     // 上一轮判定为致命错误，立刻退出
try {
      // 第 1 次和每 20 次带诊断快照，方便对比「结构是否变化」
      const chat = await fetchChat(chatId, { diagnose: ticks === 1 || ticks % 20 === 0 });
      // 中途变成业务错误（会话被清理 / 权限失效）→ 立刻失败，别傻等
      if (chat.__bizError) {
        fatal = `读会话接口返回业务错误：${chat.__bizError}。chatId=${chatId}`;
        _log(`[轮询] 早退：${fatal}`, 'ERROR', 'QWEN');
        break;
      }
      const found = findMessageArray(chat);
      if (found.key && found.key !== msgKey) {
        if (msgKey) _log(`[诊断] 消息字段从「${msgKey}」变为「${found.key}」`, 'WARN', 'QWEN');
        msgKey = found.key;
      }
      const msgs = found.list.filter(m => m && m.role === 'assistant');
      const last = msgs[msgs.length - 1];
      if (!last) {
        emptyHits++;
        // 前 3 次每次都说，之后每 5 次一条，避免刷屏但保留时间线
        if (emptyHits <= 3 || ticks % 5 === 0) {
          _log(`[轮询] 第 ${ticks} 次：会话里还没有 assistant 消息`
            + `（消息字段=${found.key || '未找到'} · 共 ${found.list.length} 条`
            + ` · 已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
        }
        // 连续 30 次（约 4 分钟）都没有任何 assistant 消息 → 判定为异常，早退而不是干等
        if (emptyHits >= 30) {
          fatal = `连续 ${emptyHits} 次（约 ${Math.round(emptyHits * 8 / 60)} 分钟）查不到 assistant 消息。`
            + `chatId=${chatId}，消息字段=${found.key || '未找到'}，会话共 ${found.list.length} 条。`
            + `可能是 chatId 与页面实际会话不一致，或接口结构已变。`;
          _log(`[轮询] 早退：${fatal}`, 'ERROR', 'QWEN');
          break;
        }
        continue;
      }
      emptyHits = 0;
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
  if (fatal) throw new Error(fatal);
  throw new Error(`等待回答超时（${ticks} 次轮询，${fails} 次失败`
    + `，最后 done=${lastDone}，原始正文 ${lastRawLen} 字，phases=[${lastPhases.join(',')}]`
    + `，消息字段=[${lastKeys.join(',')}]`
    + (lastErr ? `，最后一次错误：${lastErr}` : '') + '）');
}
