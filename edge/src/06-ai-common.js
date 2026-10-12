// ==== edge/src/06-ai-common.js · AI budget, leases and number checks ====
// ---------- 通用：预算/限流 ----------
const AI_LEASES = new WeakMap();
const AI_TASK_MS = 150000;
function parseAILease(raw) {
  try {
    const lease = JSON.parse(raw);
    return lease && lease.version === 1 && typeof lease.owner === 'string' && /^[\da-f-]{36}$/i.test(lease.owner) && Number.isFinite(lease.deadline) ? lease : null;
  } catch { return null; }
}
function sanitizeAITask(value) {
  if (!value || value.version !== 1 || !['waiting','completed','failed'].includes(value.status) || !parseAILease(JSON.stringify(value))) return null;
  const task = { status: value.status, retryAfterSeconds: value.status === 'waiting' ? 3 : 0 };
  if (value.status === 'failed') {
    task.error = ['task_timeout','task_cancelled','metadata_timeout','metadata_error','no_abstract','model_failed','server','need_two_unique'].includes(value.error) ? value.error : 'server';
    if (['request_timeout','transport_error','fetch_dns','fetch_tls','fetch_connection','provider_network_error','model_redirect','endpoint_invalid','endpoint_insecure','context_limit','output_json','output_truncated','output_shape','output_empty','output_incomplete','output_blocked','provider_auth','provider_rate_limit','provider_unavailable','provider_or_output_error','provider_budget','budget_unavailable','unsupported_numbers','missing_numbers','model_not_object','not_object','quote_not_in_abstract'].includes(value.detail)) task.detail = value.detail;
  }
  return task;
}
async function aiTaskStatus(env, kvKey, found = false) {
  if (found) return { taskStatus: 'completed', task: { status: 'completed', retryAfterSeconds: 0 }, retryAfterSeconds: 0 };
  const raw = await env.QL_KV.get('lock:' + kvKey);
  const lease = parseAILease(raw);
  const receipt = await env.QL_KV.get('ai:task:' + kvKey, 'json');
  let task = sanitizeAITask(receipt);
  if (raw) {
    // Unknown legacy locks retain their original TTL. A read never modifies them.
    task = lease && lease.deadline <= Date.now() ? { status: 'failed', error: 'task_timeout', retryAfterSeconds: 0 } : { status: 'waiting', retryAfterSeconds: 3 };
  } else if (task && task.status === 'waiting') {
    task = receipt.deadline <= Date.now() ? { status: 'failed', error: 'task_timeout', retryAfterSeconds: 0 } : { status: 'waiting', retryAfterSeconds: 3 };
  }
  task = task || { status: 'idle', retryAfterSeconds: 0 };
  return { taskStatus: task.status, task, retryAfterSeconds: task.retryAfterSeconds };
}
async function releaseAILease(env, request, kvKey, signal) {
  const lease = AI_LEASES.get(request);
  if (!lease) return;
  if (await env.QL_KV.get('lock:' + kvKey) === JSON.stringify(lease) && !signal?.aborted) await env.QL_KV.delete('lock:' + kvKey);
  AI_LEASES.delete(request);
}
async function aiPut(env, key, value, options) {
  if (env.AI_TASK_SIGNAL && env.AI_TASK_SIGNAL.aborted) throw Error('task_timeout');
  if (env.AI_TASK_LEASE && await env.QL_KV.get('lock:' + env.AI_TASK_KEY) !== JSON.stringify(env.AI_TASK_LEASE)) throw Error('task_cancelled');
  if (env.AI_TASK_SIGNAL && env.AI_TASK_SIGNAL.aborted) throw Error('task_timeout');
  return env.QL_KV.put(key, value, options);
}
// Terminal KV/refund cleanup is best effort and bounded separately from the work deadline.
async function aiHousekeeping(work) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try { return await awaitAbort(work(controller.signal), controller.signal); }
  catch { return null; }
  finally { clearTimeout(timer); controller.abort(); }
}
async function runAITask(request, env, kvKey, work) {
  const lease = AI_LEASES.get(request);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, Math.max(1, (lease?.deadline || Date.now() + AI_TASK_MS) - Date.now()));
  if (request.signal) { if (request.signal.aborted) cancel(); else request.signal.addEventListener('abort', cancel, { once: true }); }
  let response;
  try {
    if (controller.signal.aborted) throw Error('task_cancelled');
    response = await awaitAbort(work({ ...env, AI_TASK_SIGNAL: controller.signal, AI_TASK_LEASE: lease, AI_TASK_KEY: kvKey }), controller.signal);
  } catch (error) {
    await aiHousekeeping(() => refund(env, request));
    const code = controller.signal.aborted ? (request.signal?.aborted ? 'task_cancelled' : 'task_timeout') : ['metadata_error','metadata_timeout','task_cancelled'].includes(error.message) ? error.message : 'server';
    response = json({ ok: false, error: code }, code.endsWith('timeout') ? 504 : code === 'task_cancelled' ? 499 : 502);
  }
  try {
    const payload = await response.clone().json();
    const status = payload.ok && payload.found ? 'completed' : 'failed';
    const receipt = { ...lease, status, error: payload.error, detail: payload.detail };
    // Only the observed owner may publish terminal status. KV is advisory, not CAS.
    await aiHousekeeping(async signal => {
      if (lease && await env.QL_KV.get('lock:' + kvKey) === JSON.stringify(lease) && !signal.aborted) {
        await env.QL_KV.put('ai:task:' + kvKey, JSON.stringify(receipt), { expirationTtl: 3600 });
      }
    });
    const task = sanitizeAITask(receipt) || { status, retryAfterSeconds: 0 };
    response = json({ ...payload, taskStatus: task.status, task, retryAfterSeconds: task.retryAfterSeconds }, response.status);
  } finally {
    clearTimeout(timer); controller.abort();
    if (request.signal) request.signal.removeEventListener('abort', cancel);
    await aiHousekeeping(signal => releaseAILease(env, request, kvKey, signal));
  }
  return response;
}

async function gate(env, request, kvKey) {
  if (env.AI_ENABLED === 'off' || !env.LLM_API_KEY || !env.LLM_ENDPOINT || !env.LLM_MODEL) return json({ ok: false, error: 'generation_off' }, 503);
  if (await env.QL_KV.get('lock:' + kvKey)) return json({ ok: false, error: 'in_progress', ...await aiTaskStatus(env, kvKey) }, 409);
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const reservation = { dailyKey: `cap:${day}`, ipKey: `ip:${day}:${await sha(ip)}`, dailyReserved: false, ipReserved: false };
  AI_RESERVATIONS.set(request, reservation);
  const capValue = (value, fallback) => { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 && value != null && value !== '' ? n : fallback; };
  try {
    if (!await bump(env.QL_KV, reservation.dailyKey, capValue(env.DAILY_CAP, 150), 172800)) return json({ ok: false, error: 'daily_cap' }, 429);
    reservation.dailyReserved = true;
    if (!await bump(env.QL_KV, reservation.ipKey, capValue(env.IP_CAP, 20), 172800)) {
      await refund(env, request);
      return json({ ok: false, error: 'ip_cap' }, 429);
    }
    reservation.ipReserved = true;
    if (await env.QL_KV.get('lock:' + kvKey)) {
      await refund(env, request);
      return json({ ok: false, error: 'in_progress', ...await aiTaskStatus(env, kvKey) }, 409);
    }
    const lease = { version: 1, owner: crypto.randomUUID(), deadline: Date.now() + AI_TASK_MS };
    await env.QL_KV.put('lock:' + kvKey, JSON.stringify(lease), { expirationTtl: 180 });
    AI_LEASES.set(request, lease);
    await env.QL_KV.put('ai:task:' + kvKey, JSON.stringify({ ...lease, status: 'waiting' }), { expirationTtl: 3600 });
    return null;
  } catch {
    await refund(env, request);
    await releaseAILease(env, request, kvKey).catch(() => {});
    return json({ ok: false, error: 'server' }, 500);
  }
}

async function chat(env, system, user, feedback) {
  const model = env.LLM_MODEL;
  const body = { model, temperature: 0.2, max_tokens: feedback === 'output_truncated' ? 6000 : 3000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user },
      ...(feedback ? [{ role: 'user', content: '上一次输出未通过校验：' + feedback + '。请重写完整 JSON，不增加或换算数字；完整翻译不得遗漏或重复原文数字，保留标识符的前导零。英文月份可译为对应月份，小数可作无损格式规范化。若上次截断，请缩短推理并完整输出结果。' }] : [])] };
  if (/^glm-5\.3/.test(model)) body.reasoning_effort = 'low';
  else if (/^glm-/.test(model)) body.thinking = { type: 'disabled' };
  return requestModel(env, body);
}
async function withRetry(env, system, user, check) {
  try { return check(await chat(env, system, user)); }
  catch (e1) { if (!retryableModelError(e1)) throw e1; return check(await chat(env, system, user, safeModelError(e1))); }
}
function safeModelError(error) {
  const message = String(error?.message || '');
  if (message === 'model_attempt_cap') return 'provider_budget';
  if (message === 'model_attempt_accounting') return 'budget_unavailable';
  if (/^model_http_(?:401|403)$/.test(message)) return 'provider_auth';
  if (message === 'model_http_429') return 'provider_rate_limit';
  if (/^model_http_\d{3}$/.test(message)) return 'provider_unavailable';
  const codes = { model_timeout:'request_timeout', model_transport:'transport_error', model_fetch_transport:'transport_error', model_fetch_dns:'fetch_dns', model_fetch_tls:'fetch_tls', model_fetch_connection:'fetch_connection', model_provider_network:'provider_network_error', model_redirect:'model_redirect', model_endpoint_invalid:'endpoint_invalid', model_endpoint_insecure:'endpoint_insecure', model_context_limit:'context_limit', model_response_json:'output_json', model_output_json:'output_json', model_output_truncated:'output_truncated', model_output_shape:'output_shape', model_output_empty:'output_empty', model_output_incomplete:'output_incomplete', model_output_blocked:'output_blocked', numbers_missing_from_translation:'missing_numbers' };
  if (codes[message]) return codes[message];
  return /^(?:model_not_object|invalid_[a-z_]+|not_object|quote_not_in_abstract)$/.test(message) ? message :
    (/^numbers_not_in_(?:abstract|source):/.test(message) ? 'unsupported_numbers' : 'provider_or_output_error');
}
function retryableModelError(error) {
  return error instanceof SyntaxError || /^(?:model_(?:not_object|output_(?:json|truncated|shape|empty))|numbers_missing_from_translation|invalid_[a-z_]+|not_object|quote_not_in_abstract|numbers_not_in_(?:abstract|source):)/.test(String(error?.message || ''));
}
const hasCJK = s => /[一-鿿]/.test(s);
function numbersOk(text, source) {
  const have = allowedNums(source);
  const bad = [...nums(text)].filter(n => !have.has(n));
  if (bad.length) throw new Error('numbers_not_in_source:' + bad.slice(0, 5).join(','));
}
function translationNumbersOk(text, source) {
  numbersOk(text, source);
  const remaining = new Map();
  for (const token of numberTokens(text)) remaining.set(token, (remaining.get(token) || 0) + 1);
  for (const token of numberTokens(source)) {
    if (!remaining.get(token)) throw new Error('numbers_missing_from_translation');
    remaining.set(token, remaining.get(token) - 1);
  }
  // A spelled-out source count may appear as digits once in the translation.
  for (const token of wordNumberTokens(source)) if (remaining.get(token) > 0) remaining.set(token, remaining.get(token) - 1);
  if ([...remaining.values()].some(n => n > 0)) throw new Error('numbers_not_in_source:repeated_number');
}

