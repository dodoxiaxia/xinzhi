// Execute the actual source diagnostics and renderer with fixed data and time.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(require('path').join(__dirname, '../app.js'), 'utf8');
const fn = n => {
  const match = src.match(new RegExp('  function ' + n + '\\([^]*?\\n  }'));
  if (!match) throw Error(n);
  return match[0];
};
class Clock extends Date { static now() { return Date.parse('2026-10-07T08:00:00Z'); } }
const nodes = {sourcesHealthGrid: {}, sourcesHealthMeta: {classList:{toggle(){}}}, sourcesHealthSummary:{}};
const c = vm.createContext({Date: Clock, URL, HEALTH: {checkedAt: '2026-10-07T07:22:33Z', sources: []},
  $: selector => nodes[selector.slice(1)],
  esc: text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]))});
vm.runInContext(['contentDate', 'olderThan', 'safeSourceUrl', 'sourceHealthDetails', 'renderSourcesHealth'].map(fn).join('\n'), c);
const details = s => c.sourceHealthDetails(s);
assert(details({status:'filtered_empty'}).includes('不代表期刊没有新文章'));
const excluded = details({excludedItems: {undated:2, olderThan14Days:28, future:1, unclassifiedOrInvalid:3}});
for (const value of ['日期缺失 2 条', '超出14天 28 条', '未来日期 1 条', '主题或链接未入选 3 条']) assert(excluded.includes(value));
assert(details({failureReason:'publisher_cookie_requirement'}).includes('Cookie'));
assert(details({blockedReason:'publisher_access_challenge'}).includes('停止'));
const backup = {status:'records_observed', configured:true, observedItems:43, eligibleItems:17,
  checkedAt:'2026-10-07T07:22:34Z', queryTruncated:true, stale:false};
const text = details({pubmedFallback:backup});
assert(text.includes('43 条，近14天 17 条'));
assert(text.includes('备用检查：10/7 15:22（北京时间）'));
assert(text.includes('不能据此判断完整覆盖'));
assert(!text.includes('已过期'));
assert(details({pubmedFallback:{...backup, checkedAt:'2026-10-07T01:59:59Z'}}).includes('已过期'));
assert(details({pubmedFallback:{...backup, stale:true}}).includes('已过期'));
assert(details({pubmedFallback:{status:'not_configured', configured:false}}).includes('尚未覆盖'));
assert(details({pubmedFallback:{status:'no_records_observed', configured:true}}).includes('尚无匹配记录'));
assert(details({pubmedFallback:{...backup, queryScope:'cardiovascular_or_ai'}}).includes('限心血管或 AI'));
c.HEALTH.sources = [
  {name:'Unavailable <source>', url:'https://example.org/rss', status:'not_feed', pubmedFallback:backup},
  {name:'Older issue', url:'https://example.org/issue', status:'filtered_empty', rawItems:28, eligibleItems:0},
  {name:'Paused', url:'https://example.org/other', status:'not_checked_host_blocked', blockedReason:'publisher_access_challenge'}
];
c.renderSourcesHealth();
const html = nodes.sourcesHealthGrid.innerHTML;
assert(html.includes('Unavailable &lt;source&gt;'));
assert(html.includes('返回非订阅内容'));
assert(html.includes('获取成功 · 暂无入选'));
assert(html.includes('同主机暂停检查'));
assert.equal((html.match(/source-status-ok/g)||[]).length, 1); // A backup never makes failed RSS successful.
assert(nodes.sourcesHealthSummary.innerHTML.includes('<strong>3</strong>'));
assert(nodes.sourcesHealthSummary.innerHTML.includes('<strong>1</strong>'));
assert(nodes.sourcesHealthSummary.innerHTML.includes('<strong>2</strong>'));
assert(nodes.sourcesHealthMeta.textContent.includes('检查时间：'));
c.HEALTH.sources=[{name:'Unknown counts',status:'ok'},{name:'Zero counts',status:'ok',rawItems:0,eligibleItems:0,itemsWithAbstracts:0}];
c.renderSourcesHealth();
const countCards=nodes.sourcesHealthGrid.innerHTML.split('<article').slice(1);
assert(countCards[0].includes('<dt>原始条目</dt><dd>未统计</dd>'));
assert(countCards[0].includes('<dt>含摘要</dt><dd>未统计</dd>'));
assert(countCards[1].includes('<dt>原始条目</dt><dd>0</dd>'));
assert(countCards[1].includes('<dt>含摘要</dt><dd>0</dd>'));
console.log('29 source health UI assertions passed');
