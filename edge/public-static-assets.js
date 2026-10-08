// Pass through prebuilt hash-addressed JSON. No data parsing/scanning or private bindings.
async function publicStaticData(request, env) {
  const url = new URL(request.url);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (!/^\/public-data\/(feeds|recent_radar|radar)\.[a-f0-9]{64}\.json$/.test(url.pathname)) return new Response('{"error":"data_not_found"}', {status:404, headers});
  if (!['GET','HEAD'].includes(request.method)) return new Response('{"error":"method_not_allowed"}', {status:405, headers});
  // Browser secrets are unnecessary for public static JSON. Forward only conditional cache headers.
  const forwarded = new Headers();
  for (const name of ['if-none-match','if-modified-since']) if (request.headers.has(name)) forwarded.set(name,request.headers.get(name));
  const asset = await env.ASSETS.fetch(new Request(url, {method:request.method, headers:forwarded, signal:request.signal}));
  if (asset.status !== 304 && (!asset.ok || !/^application\/json\b/i.test(asset.headers.get('content-type')||''))) return new Response('{"error":"data_not_found"}', {status:asset.status>=500?503:404, headers});
  const result = new Headers(asset.headers);
  result.set('cache-control','public, max-age=31536000, immutable');
  result.set('x-content-type-options','nosniff');
  return new Response(asset.body, {status:asset.status, statusText:asset.statusText, headers:result});
}
