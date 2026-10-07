/* Local bibliography export only. No metadata lookup, uploads or model calls. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CITATION_EXPORT = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const line = value => typeof value === 'string' ? value.replace(/[\r\n\u2028\u2029\x00-\x1f\x7f]+/g, ' ').trim() : '';
  function doiOf(p) {
    const doi = line(p.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : '';
  }
  function metadata(p) {
    const rawJournal = line(p.cleanJournal) || line(p.journal);
    let url = '';
    try { const parsed = new URL(line(p.url)); if (['https:', 'http:'].includes(parsed.protocol)) url = parsed.href; } catch (_) { /* missing or unsupported source */ }
    const date = line(p.date), year = /^(\d{4})(?:$|-)/.exec(date)?.[1] || '';
    return { title: line(p.title), authors: Array.isArray(p.authors) ? p.authors.map(line).filter(Boolean) : [],
      journal: /^PubMed:/i.test(rawJournal) ? '' : rawJournal, year, doi: doiOf(p), url };
  }
  function missingFields(p) {
    const m = metadata(p), missing = [];
    if (!m.title) missing.push('题名');
    if (!m.authors.length) missing.push('作者');
    if (!m.journal) missing.push('期刊');
    if (!m.year) missing.push('年份');
    if (!m.doi && !m.url) missing.push('DOI/原文链接');
    // The public bibliography has no verified volume, issue or page fields.
    missing.push('卷期/页码');
    return missing;
  }
  function plan(papers, selectedIds) {
    const selected = selectedIds === undefined ? null : new Set(selectedIds);
    const ids = new Set(), dois = new Set(), items = [], notices = [];
    papers.forEach((p, index) => {
      if (selected && !selected.has(p.id)) return;
      const label = `${index + 1}. ${line(p.title) || '题名未提供'}`;
      const doi = doiOf(p).toLowerCase();
      if (ids.has(p.id) || (doi && dois.has(doi))) { notices.push(`${label}：重复条目，已保留清单中首条所选题录。`); return; }
      ids.add(p.id); if (doi) dois.add(doi);
      items.push(p);
      notices.push(`${label}：缺少${missingFields(p).join('、')}；仅导出已有题录，使用前请对照原文补全。`);
    });
    if (selected) for (const id of selected) if (!papers.some(p => p.id === id)) notices.push(`条目 ${line(String(id))}：已不在当前清单，未导出。`);
    return { items, notices };
  }
  function risRecord(p) {
    const m = metadata(p), lines = ['TY  - JOUR'];
    const add = (tag, value) => { if (value) lines.push(`${tag}  - ${value}`); };
    add('TI', m.title);
    m.authors.forEach(author => add('AU', author));
    add('JO', m.journal); add('PY', m.year); add('DO', m.doi); add('UR', m.url);
    add('N1', `题录草稿；缺少${missingFields(p).join('、')}；请对照原文补全。`);
    lines.push('ER  - ');
    return lines.join('\r\n');
  }
  function exportRis(papers, selectedIds) {
    const result = plan(papers, selectedIds);
    return { ...result, text: result.items.map(risRecord).join('\r\n\r\n') + (result.items.length ? '\r\n' : '') };
  }
  function batchCopy(papers, selectedIds, format, formatter) {
    if (!['gb', 'ama', 'bibtex'].includes(format)) throw new Error('Unsupported citation format');
    const result = plan(papers, selectedIds);
    // Reuse the exact single-paper formatter, including its existing limitations.
    const citations = result.items.map(p => formatter(p)[format]);
    const notes = ['题录核对提示（逐条）', ...result.notices].map(note => format === 'bibtex' ? '% ' + note : note);
    return { ...result, text: citations.join('\n\n') + (result.notices.length ? '\n\n' + notes.join('\n') : '') };
  }
  function downloadRis(text, filename, env = window) {
    const blob = new env.Blob([text], { type: 'application/x-research-info-systems;charset=utf-8' });
    const url = env.URL.createObjectURL(blob), a = env.document.createElement('a');
    a.href = url; a.download = filename;
    env.document.body.appendChild(a);
    try { a.click(); } finally { a.remove(); env.setTimeout(() => env.URL.revokeObjectURL(url), 1000); }
  }
  const selections = new Map();
  function mount(container, papers, options) {
    if (!papers.length) return; // Empty-list controls are owned by the separate task.
    container.querySelector('[data-citation-export]')?.remove();
    const panel = container.ownerDocument.createElement('details');
    panel.dataset.citationExport = '';
    const make = (tag, text) => { const el = container.ownerDocument.createElement(tag); if (text) el.textContent = text; return el; };
    panel.appendChild(make('summary', '引用导出 · 默认全部，可选择子集'));
    panel.appendChild(make('p', '按精选清单顺序导出；同 DOI 保留首条所选题录。文件在浏览器本地生成。'));
    const checks = papers.map((p, index) => {
      if (!selections.has(p.id)) selections.set(p.id, true);
      const label = make('label'), check = make('input');
      check.type = 'checkbox'; check.checked = selections.get(p.id); check.dataset.citationId = p.id;
      check.addEventListener('change', () => { selections.set(p.id, check.checked); refresh(); });
      label.append(check, container.ownerDocument.createTextNode(` ${index + 1}. ${line(p.title) || '题名未提供'}`));
      const row = make('div'); row.appendChild(label); panel.appendChild(row);
      return check;
    });
    const format = make('select'); format.setAttribute('aria-label', '批量引用格式');
    for (const [value, name] of [['gb', 'GB/T 引用草稿'], ['ama', 'AMA 引用草稿'], ['bibtex', 'BibTeX 题录']]) {
      const option = make('option', name); option.value = value; format.appendChild(option);
    }
    const copy = make('button', '批量复制引用草稿'), download = make('button', '导出所选 RIS');
    for (const button of [copy, download]) { button.type = 'button'; button.className = 'btn-sm'; }
    copy.dataset.citationCopy = ''; download.dataset.citationRis = '';
    const status = make('p'); status.setAttribute('role', 'status');
    const warnings = make('ul'); warnings.setAttribute('aria-label', '逐条题录核对提示');
    const selectedIds = () => checks.filter(c => c.checked).map(c => c.dataset.citationId);
    function refresh() {
      const result = plan(papers, selectedIds());
      copy.disabled = download.disabled = !result.items.length;
      status.textContent = `已选 ${selectedIds().length} 条，去重后导出 ${result.items.length} 条。引用草稿含缺项，请核对下列逐条提示。`;
      warnings.replaceChildren(...result.notices.map(note => make('li', note)));
    }
    copy.addEventListener('click', () => {
      const result = batchCopy(papers, selectedIds(), format.value, options.formatter);
      if (result.items.length) options.copy(result.text, `已复制 ${result.items.length} 条引用草稿（含逐条缺项提示）`);
    });
    download.addEventListener('click', () => {
      const result = exportRis(papers, selectedIds());
      if (!result.items.length) return;
      downloadRis(result.text, `精选文献引用-${options.today()}.ris`);
      status.textContent = `已导出 ${result.items.length} 条 RIS 题录；下列缺项提示也写入各条 RIS 的 N1 字段。`;
    });
    panel.append(format, copy, download, status, warnings);
    container.prepend(panel); refresh();
  }
  return { metadata, missingFields, plan, risRecord, exportRis, batchCopy, downloadRis, mount };
});
