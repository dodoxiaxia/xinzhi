// Isolated verification prototype. No active routes, tokens, secrets or resource creation.
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = ISSUER + '/.well-known/jwks';
const reject = () => { throw new Error('executor_unauthorized'); };
const bytes = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) reject();
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); } catch { reject(); }
};
const parse = value => { try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes(value))); } catch { reject(); } };
export async function verifyExecutorJwt(token, policy, send = fetch, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 20000 || token.split('.').length !== 3) reject();
  const [head,body,signature] = token.split('.'), header = parse(head), claims = parse(body);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 || header.crit || header.jku || header.jwk || header.x5u || !claims) reject();
  const exact = {iss:ISSUER,aud:'https://learn.dryz.info/doi-archive',repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',repository_owner_id:'214921265',ref:'refs/heads/main',event_name:'workflow_dispatch',workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/archive-doi.yml@refs/heads/main'};
  if (Object.entries(exact).some(([key,value]) => claims[key] !== value) || !/^\d+$/.test(claims.run_id || '') || !/^\d+$/.test(claims.run_attempt || '')) reject();
  if (!Array.isArray(policy?.workflowShas) || !policy.workflowShas.some(sha => /^[a-f0-9]{40}$/.test(sha) && sha === claims.workflow_sha)) reject();
  if (![claims.exp,claims.iat,claims.nbf].every(Number.isSafeInteger) || claims.exp <= now || claims.nbf > now + 30 || claims.iat > now + 30 || claims.iat < now - 600 || claims.exp - claims.iat > 600) reject();
  // Only issuer's pinned JWKS URL. Never fetch key URLs from a supplied JWT.
  const response = await send(JWKS,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 128 * 1024) reject();
  const reader = response.body?.getReader(); if (!reader) reject();
  let length = 0; const chunks = [];
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 128 * 1024) { await reader.cancel(); reject(); } chunks.push(part.value); }
  const all = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { all.set(chunk,offset); offset += chunk.length; }
  let keys; try { keys = JSON.parse(new TextDecoder().decode(all)).keys; } catch { reject(); }
  if (!Array.isArray(keys)) reject();
  const matching = keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig' && (!key.alg || key.alg === 'RS256'));
  if (matching.length !== 1) reject();
  try {
    const key = await crypto.subtle.importKey('jwk',matching[0],{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(signature),new TextEncoder().encode(head + '.' + body))) reject();
  } catch { reject(); }
  return {run:claims.run_id + ':' + claims.run_attempt,workflowSha:claims.workflow_sha};
}
