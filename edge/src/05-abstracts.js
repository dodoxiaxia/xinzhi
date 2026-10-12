// ==== edge/src/05-abstracts.js · Public abstract lookup and validation helpers ====
// Only remove actual markup: <4 mm2 ... >315 is scientific text, not a tag.
const stripTags = s => String(s || '').replace(/<\/?(?:sup|sub)\s*>/gi, '').replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/g, ' ')
  // Decode once, after stripping markup, so decoded comparisons are never reparsed as tags.
  .replace(/&(?:lt|gt|amp|quot|apos|nbsp|le|ge|plusmn|ndash|mdash|sup2|sup3);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const names = {lt:'<',gt:'>',amp:'&',quot:'"',apos:"'",nbsp:' ',le:'≤',ge:'≥',plusmn:'±',ndash:'–',mdash:'—',sup2:'²',sup3:'³'};
    if (entity[1] !== '#') return names[entity.slice(1,-1).toLowerCase()] || entity;
    const code = /^&#x/i.test(entity) ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/g, ' ').trim();

const UA = 'XinZhiLearningBot/1.0 (+https://learn.dryz.info; on-demand single-article metadata lookup)';
const metaContent = (html, name) => {
  const a = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*content=["\']([^"\']+)["\']', 'i').exec(html);
  const b = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:name|property)=["\']' + name + '["\']', 'i').exec(html);
  return stripTags((a && a[1]) || (b && b[1]) || '');
};
// Race every transport/body await against abort: upstream implementations may ignore signals.
function awaitAbort(promise, signal, code = 'task_timeout') {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(Error(code)); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(Error(code)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function tryFetch(url, opts) {
  return studyMetaFetch(url, opts);
}

async function publishedAbstract(k) {
  const snapshot = PUBLIC_ABSTRACT_SOURCES;
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.scope !== 'published-public-abstract' || !Array.isArray(snapshot.items) || snapshot.items.length > 96) return null;
  const key = normKey(k.type === 'pmid' ? k.id : '', k.type === 'doi' ? k.id : '');
  const matches = snapshot.items.filter(row => row && (k.type === 'pmid' ? normKey(row.pmid, '') === key : normKey('', row.doi) === key));
  if (matches.length !== 1) return null;
  const row = matches[0];
  const fields = ['paperID','pmid','doi','title','journal','abstract','sourceHash','abstractSource','abstractSourceUrl','date'];
  if (Object.keys(row).some(field => !fields.includes(field)) || typeof row.paperID !== 'string' || !row.paperID || row.paperID.length > 200 ||
    typeof row.title !== 'string' || !row.title.trim() || row.title.length > 1000 || typeof row.abstract !== 'string' || row.abstract.length < 300 || row.abstract.length > 32000 ||
    typeof row.journal !== 'string' || row.journal.length > 2000 || typeof row.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceHash) ||
    typeof row.abstractSource !== 'string' || row.abstractSource.length > 300 || typeof row.abstractSourceUrl !== 'string' || row.abstractSourceUrl.length > 2000 ||
    typeof row.pmid !== 'string' || (row.pmid && !normKey(row.pmid, '')) || typeof row.doi !== 'string' || (row.doi && !normKey('', row.doi))) return null;
  const pmid = row.pmid, doi = row.doi ? parseKey(normKey('', row.doi)).id : '';
  // An alias that points at multiple published records is ambiguous, even for PMID requests.
  if (snapshot.items.some(other => other !== row && other && ((pmid && normKey(other.pmid, '') === normKey(pmid, '')) || (doi && normKey('', other.doi) === normKey('', doi))))) return null;
  if (await pdfDigest('SHA-256', new TextEncoder().encode(row.title + '\n' + row.abstract)) !== row.sourceHash) return null;
  let url;
  try { url = new URL(row.abstractSourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password ||
    !['pubmed.ncbi.nlm.nih.gov','europepmc.org','www.ebi.ac.uk','doi.org','dx.doi.org'].includes(url.hostname)) return null;
  return { title: row.title, journal: row.journal, pmid, doi, abstract: row.abstract,
    source: '已发布公开摘要快照（' + (row.abstractSource || '原公开来源') + '）', url: row.abstractSourceUrl };
}

// 取公开摘要的逐级回退：Europe PMC → PubMed → OpenAlex → Crossref → 期刊落地页元数据（最后手段，仅用户点击时、单篇）
async function resolveMeta(k, hintDoi, hintPmid, options = {}) {
  const published = await publishedAbstract(k);
  if (published) return published;
  // Cross-identifiers must come from a matching authoritative record, never reader hints.
  const m = { title: '', journal: '', pmid: k.type === 'pmid' ? k.id : '', doi: k.type === 'doi' ? k.id.toLowerCase() : '', abstract: '', source: '', url: '' };
  const metaFetch = async (url, opts) => {
    try { return await tryFetch(url, { ...opts, signal: options.signal }); }
    catch (error) { m.metadataError = error.message === 'metadata_timeout' ? 'metadata_timeout' : m.metadataError || 'metadata_error'; return null; }
  };
  const badJson = () => { m.metadataError = m.metadataError || 'metadata_error'; return {}; };
  const q = k.type === 'pmid' ? `EXT_ID:${k.id} AND SRC:MED` : `DOI:"${k.id}"`;
  const r = await metaFetch('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=3&query=' + encodeURIComponent(q), { headers: { accept: 'application/json' } });
  if (r && r.ok) {
    const hits = ((await r.json().catch(badJson)).resultList || {}).result || [];
    const hit = hits.find(h => k.type === 'pmid' ? String(h.pmid) === k.id : String(h.doi || '').toLowerCase() === k.id.toLowerCase());
    if (hit) {
      m.title = stripTags(hit.title); m.journal = hit.journalTitle || ''; m.pmid = hit.pmid || m.pmid; m.doi = String(hit.doi || m.doi).toLowerCase();
      const a = stripTags(hit.abstractText);
      if (a.length >= 300) { m.abstract = a; m.source = 'Europe PMC 公开摘要'; }
    }
  }
  if (m.pmid) m.url = `https://pubmed.ncbi.nlm.nih.gov/${m.pmid}/`;
  if (m.abstract) return m;
  if (m.pmid) {   // PubMed（EPMC 收录滞后时）
    const x = await metaFetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${m.pmid}`, { headers: { 'user-agent': UA } });
    if (x && x.ok) {
      let xml = (await x.text()).slice(0, 300000);
      if (options.strictIdentity) {
        const articles = [...xml.matchAll(/<(PubmedArticle|PubmedBookArticle)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)];
        const matching = articles.filter(a => /<PMID(?:\s[^>]*)?>(\d+)<\/PMID>/.exec(a[2])?.[1] === m.pmid);
        xml = matching.length === 1 ? matching[0][2] : '';
      }
      const parts = [...xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(mm => {
        const lab = /Label="([^"]+)"/.exec(mm[1]); return (lab ? lab[1] + ': ' : '') + stripTags(mm[2]);
      });
      const a = parts.join(' ').trim();
      if (!m.title) { const t = /<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/.exec(xml); if (t) m.title = stripTags(t[1]); }
      if (!m.doi) { const d = /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/.exec(xml); if (d) m.doi = d[1].toLowerCase(); }
      if (a.length >= 300) { m.abstract = a; m.source = 'PubMed'; return m; }
    }
  }
  if (m.doi) {
    const o = await metaFetch(`https://api.openalex.org/works/doi:${encodeURIComponent(m.doi).replace(/%2F/g, '/')}?select=title,abstract_inverted_index${options.strictIdentity ? ',doi' : ''}&mailto=shijunxia1988@gmail.com`, { headers: { accept: 'application/json' } });
    if (o && o.ok) {
      const j = await o.json().catch(badJson);
      const identityMatches = !options.strictIdentity || String(j.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase() === m.doi;
      if (identityMatches && !m.title && j.title) m.title = stripTags(j.title);
      const ii = identityMatches ? j.abstract_inverted_index : null;
      if (ii) {
        const words = []; for (const [w, ps] of Object.entries(ii)) for (const p of ps) words[p] = w;
        const a = stripTags(words.filter(Boolean).join(' '));
        if (a.length >= 300) { m.abstract = a; m.source = 'OpenAlex'; return m; }
      }
    }
    const c = await metaFetch(`https://api.crossref.org/works/${encodeURIComponent(m.doi).replace(/%2F/g, '/')}?mailto=shijunxia1988@gmail.com`, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (c && c.ok) {
      const msg = ((await c.json().catch(badJson)).message) || {};
      const identityMatches = !options.strictIdentity || String(msg.DOI || '').toLowerCase() === m.doi;
      if (identityMatches && !m.title && msg.title && msg.title[0]) m.title = stripTags(msg.title[0]);
      if (identityMatches && !m.journal && msg['container-title'] && msg['container-title'][0]) m.journal = msg['container-title'][0];
      const a = identityMatches ? stripTags(msg.abstract) : '';
      if (a.length >= 300) { m.abstract = a; m.source = 'Crossref'; return m; }
    }
    // 期刊落地页的公开元数据（citation_abstract / dc.description）：仅用户点击时单篇请求，失败即放弃，不重试
    const l = await metaFetch('https://doi.org/' + m.doi, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' } });
    if (l && l.ok && /text\/html/.test(l.headers.get('content-type') || '')) {
      const html = (await l.text()).slice(0, 400000);
      const pageDoi = (metaContent(html, 'citation_doi') || metaContent(html, 'dc.identifier') || metaContent(html, 'DC.Identifier')).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
      const identityMatches = !options.strictIdentity || pageDoi === m.doi;
      const a = identityMatches ? (metaContent(html, 'citation_abstract') || metaContent(html, 'dc.description') || metaContent(html, 'DC.Description')) : '';
      if (identityMatches && !m.title) m.title = metaContent(html, 'citation_title');
      if (a.length >= 300) { m.abstract = a; m.source = '期刊页面公开元数据'; return m; }
    }
  }
  return m;
}
async function fetchAbstract(k, hintDoi, hintPmid, options = {}) {
  const m = await resolveMeta(k, hintDoi, hintPmid, options);
  if (!m.abstract && m.metadataError) throw Error(m.metadataError);
  return m.abstract ? m : null;
}

function numberTokens(value) {
  let text = String(value).normalize('NFKC');
  text = text.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, s => s.replace(/,/g, ''));
  // A translated calendar month is equivalent to its English name; "may benefit" is not a date.
  const months = {january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12};
  text = text.replace(/\b(\d{1,2})\s+(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)\.?\s+(\d{4})\b/gi, (_, day, name, year) => day.replace(/^0+(?=\d)/,'') + ' ' + months[name.toLowerCase()] + ' ' + year);
  text = text.replace(/\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)\.?\s+(\d{1,4})\b/gi, (_, name, date) => String(months[name.toLowerCase()]) + ' ' + (date.length <= 2 ? date.replace(/^0+(?=\d)/,'') : date));
  text = text.replace(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g, (_, year, month, day) => year + ' ' + month.replace(/^0/, '') + (day ? ' ' + day.replace(/^0/, '') : ''));
  // Some journals (AHA: "13 238 patients", "N=137 704") group thousands with a space. Keep the
  // parts and also add the joined number, so a correct "13238" or "137,704" is recognised.
  const grouped = (text.match(/(?<![\d.])\d{1,3}(?: \d{3})+(?![\d.])/g) || []).map(s => s.replace(/ /g, ''));
  return [...(text.match(/\d+(?:\.\d+)?|\.\d+/g) || []), ...grouped].map(token => {
    if (!token.includes('.')) return token; // Preserve identifiers such as NCT02316886.
    const [whole, fraction] = token.split('.');
    const left = (whole || '0').replace(/^0+(?=\d)/, '');
    const right = fraction.replace(/0+$/, '');
    return right ? left + '.' + right : left;
  });
}
const nums = s => new Set(numberTokens(s));
// AHA abstracts start sentences with spelled-out counts ("Thirteen studies"). A digit in the
// output may match such a word in the source; words never become required numbers.
const NUMBER_WORDS = {zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function wordNumberTokens(value) {
  const out = [];
  for (const m of String(value).normalize('NFKC').matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi)) {
    out.push(String(m[1] ? NUMBER_WORDS[m[1].toLowerCase()] + NUMBER_WORDS[m[2].toLowerCase()] : NUMBER_WORDS[m[3].toLowerCase()]));
  }
  return out;
}
const allowedNums = s => new Set([...numberTokens(s), ...wordNumberTokens(s)]);
function validate(o, abstract) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('model_not_object');
  const fields = ['title_zh', 'one_line', 'design', 'limits', 'why_read'];
  for (const f of fields) if (typeof o[f] !== 'string' || !o[f].trim() || o[f].trim().length > (['one_line','design','why_read'].includes(f) ? 60 : 400)) throw new Error('invalid_field_' + f);
  const fs = o.findings;
  if (!Array.isArray(fs) || fs.length < 2 || fs.length > 4) throw new Error('invalid_findings');
  for (const x of fs) {
    if (!x || typeof x.text !== 'string' || typeof x.quote !== 'string' || !x.text.trim() || x.text.length > 400) throw new Error('invalid_finding_shape');
    if (x.quote.length < 12 || !abstract.includes(x.quote)) throw new Error('quote_not_in_abstract');
  }
  const body = [...fields.map(f => o[f]), ...fs.map(x => x.text)].join(' ');
  const have = allowedNums(abstract);
  const bad = [...nums(body)].filter(n => !have.has(n));
  if (bad.length) throw new Error('numbers_not_in_abstract:' + bad.slice(0, 5).join(','));
  const out = {};
  fields.forEach(f => { out[f] = o[f].trim(); });
  out.findings = fs.map(x => ({ text: x.text.trim(), quote: x.quote.trim() }));
  return out;
}

async function callModel(env, art, feedback) {
  const model = env.LLM_MODEL;
  const body = {
    model, temperature: 0.2, max_tokens: feedback === 'output_truncated' ? 2400 : 1200, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({ title: art.title, journal: art.journal, abstract: art.abstract }) },
      ...(feedback ? [{ role: 'user', content: '上一次输出未通过机械校验：' + feedback + '。请重写：quote 必须逐字复制摘要原文；中文要点里出现的所有数字必须与摘要中的数字完全一致，不要自行计算、换算或补充数字。' }] : [])]
  };
  if (/^glm-5\.3/.test(model)) body.reasoning_effort = 'low';
  else if (/^glm-/.test(model)) body.thinking = { type: 'disabled' };
  return requestModel(env, body);
}

function endpointProblem(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { return 'model_endpoint_invalid'; }
  if (endpoint.protocol !== 'https:') return 'model_endpoint_insecure';
  if (endpoint.username || endpoint.password || endpoint.hash) return 'model_endpoint_invalid';
  return '';
}
function transportFailure(error) {
  const cause = String(error?.cause?.code || error?.code || '');
  if (['ENOTFOUND','EAI_AGAIN'].includes(cause)) return 'model_fetch_dns';
  if (/^(?:ERR_TLS_|CERT_|UNABLE_TO_VERIFY_)/.test(cause)) return 'model_fetch_tls';
  if (['ECONNRESET','ECONNREFUSED','EPIPE'].includes(cause)) return 'model_fetch_connection';
  return 'model_fetch_transport';
}
function sanitizeDiagnostic(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const phases = ['configuration','budget','fetch','provider_http','provider_response'];
  const codes = ['response_received','request_timeout','transport_error','fetch_dns','fetch_tls','fetch_connection',
    'provider_network_error','model_redirect','endpoint_invalid','endpoint_insecure','context_limit','output_json',
    'output_truncated','output_shape','output_empty','output_incomplete','output_blocked','provider_auth',
    'provider_rate_limit','provider_unavailable','provider_or_output_error','provider_budget','budget_unavailable'];
  if (!phases.includes(value.phase) || !codes.includes(value.code)) return null;
  if (typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) return null;
  if (typeof value.requestId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.requestId)) return null;
  if (value.httpStatus !== null && !(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)) return null;
  if (!Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86400000 || typeof value.timedOut !== 'boolean') return null;
  return {version:1, at:value.at, requestId:value.requestId, phase:value.phase, code:value.code,
    httpStatus:value.httpStatus, elapsedMs:value.elapsedMs, timedOut:value.timedOut};
}
async function saveModelDiagnostic(env, details) {
  // Fixed metadata only: never include URL, request/response text, headers or raw exceptions.
  const diagnostic = sanitizeDiagnostic({ version:1, at:new Date().toISOString(), requestId:crypto.randomUUID(), ...details });
  if (!diagnostic) return;
  if (diagnostic.code !== 'response_received') console.warn('XINZHI_AI_DIAGNOSTIC', JSON.stringify(diagnostic));
  try { if (env.QL_KV) await env.QL_KV.put('ai:runtime:last-diagnostic:v1', JSON.stringify(diagnostic), {expirationTtl:86400}); } catch { /* diagnostics never hide the original result */ }
}
async function runtimeStatus(env) {
  let lastDiagnostic = null;
  try { if (env.QL_KV) lastDiagnostic = sanitizeDiagnostic(await env.QL_KV.get('ai:runtime:last-diagnostic:v1', 'json')); } catch { /* status remains read only */ }
  const problem = endpointProblem(env.LLM_ENDPOINT);
  return { ok:true, scope:'configuration-and-last-provider-attempt', hasKV:!!env.QL_KV,
    hasEndpoint:!!env.LLM_ENDPOINT, hasModel:!!env.LLM_MODEL, hasApiKey:!!env.LLM_API_KEY,
    endpointValid:!problem, configurationError:problem ? safeModelError(Error(problem)) : null,
    canGenerate:!!(env.QL_KV && env.LLM_API_KEY && env.LLM_MODEL && !problem) && env.AI_ENABLED !== 'off',
    lastDiagnostic, note:'Configuration presence and the last provider attempt do not prove a valid generated answer.' };
}
async function reserveModelAttempt(env) {
  // KV is eventually consistent: this is a soft daily attempt limit, not an atomic billing cap.
  // Count every provider attempt, including failed calls and validation retries. Never refund it.
  if (!env.QL_KV) return; // HTTP generation routes already require KV; fixture calls may omit it.
  const raw = env.MODEL_CALL_CAP;
  const n = Number(raw);
  const cap = raw != null && raw !== '' && Number.isSafeInteger(n) && n >= 0 ? n : 300;
  const key = 'model-attempt:' + new Date().toISOString().slice(0, 10);
  let accepted;
  try { accepted = await bump(env.QL_KV, key, cap, 172800); }
  catch { throw Error('model_attempt_accounting'); }
  if (!accepted) throw Error('model_attempt_cap');
}
async function requestModel(env, body) {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const outerSignal = env.AI_TASK_SIGNAL;
  if (outerSignal) { if (outerSignal.aborted) abort(); else outerSignal.addEventListener('abort', abort, { once: true }); }
  const timer = setTimeout(abort, 45000);
  let phase = 'configuration', httpStatus = null;
  try {
    const problem = endpointProblem(env.LLM_ENDPOINT);
    if (problem) throw Error(problem);
    phase = 'budget';
    if (controller.signal.aborted) throw Error('model_timeout');
    await reserveModelAttempt(env);
    if (controller.signal.aborted) throw Error('model_timeout');
    phase = 'fetch';
    let response;
    try {
      response = await awaitAbort(fetch(env.LLM_ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LLM_API_KEY }, body: JSON.stringify(body) }), controller.signal, 'model_timeout');
    } catch (error) {
      throw new Error(controller.signal.aborted ? 'model_timeout' : transportFailure(error));
    }
    phase = 'provider_http'; httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) throw Error('model_redirect');
    if (!response.ok) throw new Error('model_http_' + response.status);
    phase = 'provider_response';
    let payload;
    try { payload = await awaitAbort(response.json(), controller.signal, 'model_timeout'); } catch { throw new Error(controller.signal.aborted ? 'model_timeout' : 'model_response_json'); }
    const choice = payload?.choices?.[0];
    if (!choice || !choice.message) throw new Error('model_output_shape');
    if (choice.finish_reason === 'length') throw new Error('model_output_truncated');
    if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'sensitive') throw new Error('model_output_blocked');
    if (choice.finish_reason === 'model_context_window_exceeded') throw new Error('model_context_limit');
    if (choice.finish_reason === 'network_error') throw new Error('model_provider_network');
    if (choice.finish_reason !== undefined && choice.finish_reason !== 'stop') throw new Error('model_output_incomplete');
    const content = choice.message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('model_output_empty');
    let output;
    try { output = JSON.parse(content); } catch { throw new Error('model_output_json'); }
    await saveModelDiagnostic(env, {phase, code:'response_received', httpStatus, elapsedMs:Date.now()-started, timedOut:false});
    return output;
  } catch (error) {
    await saveModelDiagnostic(env, {phase, code:safeModelError(error), httpStatus, elapsedMs:Date.now()-started, timedOut:controller.signal.aborted});
    throw error;
  } finally { clearTimeout(timer); if (outerSignal) outerSignal.removeEventListener('abort', abort); }
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function bump(kv, key, cap, ttl) {
  const n = parseInt(await kv.get(key) || '0', 10);
  if (n >= cap) return false;
  await kv.put(key, String(n + 1), { expirationTtl: ttl });
  return true;
}

const AI_RESERVATIONS = new WeakMap();
async function refund(env, request) {   // 退回本请求预留的读者额度；实际模型调用预算独立计数，不退款。
  try {
    const reservation = AI_RESERVATIONS.get(request);
    if (!reservation) return;
    for (const field of ['daily', 'ip']) {
      if (!reservation[field + 'Reserved']) continue;
      reservation[field + 'Reserved'] = false;
      const key = reservation[field + 'Key'];
      const n = parseInt(await env.QL_KV.get(key) || '0', 10);
      if (n > 0) await env.QL_KV.put(key, String(n - 1), { expirationTtl: 172800 });
    }
  } catch { /* best effort */ }
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (!env.QL_KV) return json({ ok: false, error: 'not_configured' }, 503);
  if (request.method === 'GET') {
    const k = parseKey(url.searchParams.get('k'));
    if (!k) return json({ ok: false, error: 'bad_key' }, 400);
    const hit = await env.QL_KV.get(`ql:${k.type}:${k.id.toLowerCase()}`, 'json');
    return json({ ...await aiTaskStatus(env, `ql:${k.type}:${k.id.toLowerCase()}`, !!hit), ok: true, found: !!hit, ql: hit || null, canGenerate: !!(env.LLM_API_KEY && env.LLM_ENDPOINT && env.LLM_MODEL) && env.AI_ENABLED !== 'off' });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if ((request.headers.get('content-type') || '').indexOf('application/json') < 0) return json({ ok: false, error: 'content_type' }, 415);
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== url.host) return json({ ok: false, error: 'origin' }, 403);
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const key = normKey(input.pmid, input.doi);
  if (!key) return json({ ok: false, error: 'bad_key' }, 400);
  const k = parseKey(key);
  const kvKey = `ql:${k.type}:${k.id.toLowerCase()}`;
  const cached = await env.QL_KV.get(kvKey, 'json');
  if (cached) return json({ ok: true, found: true, ql: cached, cached: true });
  const blocked = await gate(env, request, kvKey);
  if (blocked) return blocked;
  return runAITask(request, env, kvKey, async env => {
    const art = await fetchAbstract(k, input.doi, input.pmid, { signal: env.AI_TASK_SIGNAL, strictIdentity: true });
    if (!art) { await refund(env, request); return json({ ok: false, error: 'no_abstract' }, 422); }
    let result;
    try { result = validate(await callModel(env, art), art.abstract); }
    catch (e1) {
      if (!retryableModelError(e1)) { await refund(env, request); return json({ ok: false, error: 'model_failed', detail: safeModelError(e1) }, 502); }
      try { result = validate(await callModel(env, art, safeModelError(e1)), art.abstract); }
      catch (e) { await refund(env, request); return json({ ok: false, error: 'model_failed', detail: safeModelError(e) }, 502); }
    }
    const ql = {
      ...result, pmid: art.pmid, generatedAt: new Date().toISOString(), model: env.LLM_MODEL,
      abstract_source: art.source || 'Europe PMC 公开摘要', source_url: art.url, generatedBy: 'reader-click'
    };
    await aiPut(env, kvKey, JSON.stringify(ql));
    return json({ ok: true, found: true, ql, cached: false });
  });
}

