/* Evidence-backed journal indicators shared by every display surface. */
'use strict';
(function (root) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/[:.\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  const issnKey = value => String(value || '').toUpperCase().replace(/-/g, '');
  const sourceUrl = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
    catch (_) { return ''; }
  };

  function create(registry = {journals: [], sources: {}}) {
    const names = new Map(), issns = new Map(), ids = new Map();
    for (const row of registry.journals || []) {
      ids.set(row.id, row);
      for (const name of [row.name, ...(row.aliases || [])]) names.set(key(name), row);
      for (const issn of row.issns || []) issns.set(issnKey(issn), row);
    }
    function unknown(name, reason = '期刊身份或指标未核实') {
      return {id: null, name, kind: 'unknown', issns: [], identitySources: [],
        jif: {status: 'unverified', value: null, year: null, sources: [], reason},
        jcr: {status: 'unverified', categories: [], categoryCoverage: 'unverified', releaseYear: null, reason}};
    }
    function resolve(input) {
      const paper = typeof input === 'string' ? {journal: input} : (input || {});
      const name = paper.cleanJournal || paper.journal || paper.name || '';
      const named = names.get(key(name));
      const id = ids.get(paper.journalId);
      const supplied = [paper.issn, paper.eissn, ...(Array.isArray(paper.issns) ? paper.issns : [])].filter(Boolean);
      const matched = [...new Set([named, id, ...supplied.map(s => issns.get(issnKey(s)))].filter(Boolean))];
      if (matched.length > 1) return unknown(name, '期刊名与 ISSN 身份冲突，指标未核实');
      return matched[0] || unknown(name);
    }
    function tokens(input) {
      const row = resolve(input), jif = row.jif, jcr = row.jcr;
      if (jif.status === 'not_applicable' && jcr.status === 'not_applicable') return ['IF/JCR 不适用'];
      const impact = jif.status === 'verified' ? `IF ${Number(jif.value).toFixed(1)} (${jif.year})` : 'IF 未核实';
      const quartiles = [...new Set((jcr.categories || []).map(c => c.quartile).filter(q => /^Q[1-4]$/.test(q)))].sort();
      const partial = jcr.status !== 'verified' || jcr.categoryCoverage !== 'complete';
      const quartile = quartiles.length ? `JCR ${quartiles.join('/')}${partial ? '*' : ''} (${jcr.releaseYear})` : `JCR 未核实${jcr.releaseYear ? ` (${jcr.releaseYear})` : ''}`;
      return [impact, quartile];
    }
    function compactText(input) { return tokens(input).join(' · '); }
    function detailText(input) {
      const row = resolve(input), jif = row.jif, jcr = row.jcr;
      const parts = [row.name || '期刊未标注', compactText(input)];
      if (jcr.dataYear) parts.push(`JIF 数据年 ${jcr.dataYear}；JCR 发布版 ${jcr.releaseYear}`);
      for (const c of jcr.categories || []) parts.push(`${c.name}：${c.quartile || '分区未核实'}${c.rank ? `；JIF 排名 ${c.rank}/${c.total}` : ''}`);
      if (jcr.categoryCoverage === 'publisher_reported') parts.push('仅覆盖出版社公开的学科；全部 JCR 学科未核实');
      if (jif.reason) parts.push(jif.reason);
      if (jcr.reason) parts.push(jcr.reason);
      if (jif.verifiedAt) parts.push(`核验 ${jif.verifiedAt}`);
      parts.push(registry.notice || '期刊指标不用于判断单篇研究质量。');
      return parts.join('；');
    }
    function renderBadge(input) {
      const row = resolve(input);
      // Noninteractive: safe inside a filter button or beside a journal link.
      return `<span class="journal-metrics-badge" data-journal-id="${escape(row.id || '')}" title="${escape(detailText(input))}">${tokens(input).map(t => `<span class="journal-metric-token">${escape(t)}</span>`).join('')}</span>`;
    }
    function renderDetails(input) {
      const row = resolve(input), jcr = row.jcr;
      const refs = [...new Set([...(row.identitySources || []), ...(row.jif.sources || []), ...(jcr.editionSources || []), ...(jcr.categories || []).flatMap(c => c.sources || [])])];
      const links = refs.map(ref => registry.sources?.[ref]).filter(Boolean).map(s => {
        const url = sourceUrl(s.url);
        return url ? `<li><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(s.label)}</a><small>核验 ${escape(s.verifiedAt)}</small></li>` : '';
      }).join('');
      return `<details class="journal-metrics-details"><summary>${escape(compactText(input))} · 指标来源</summary><p>${escape(detailText(input))}</p>${row.issns?.length ? `<p>ISSN ${row.issns.map(escape).join(' / ')}</p>` : ''}${links ? `<ul>${links}</ul>` : ''}</details>`;
    }
    return {resolve, compactText, detailText, renderBadge, renderDetails, create};
  }
  const api = create(root.JOURNAL_METRICS);
  root.JournalMetrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
