/* A browser-only, same-origin loader for prebuilt public data. Never executes fetched code. */
(function () {
  'use strict';
  const boot = window.PUBLIC_DATA_BOOT;
  if (!boot) return; // Source/local legacy pages keep their original classic bundles.
  if (boot.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(boot.version)) throw new Error('Invalid public bootstrap');
  for (const [key, value] of Object.entries(boot.data)) window[key] = value;
  const records = new Map(boot.deferred.map(name => [name, { state: 'idle', promise: null, value: null }]));
  let apply = null, refresh = null, fullFallback = null, currentNames = [];
  const namesFor = (state, all = false) => {
    const names = [];
    if (all || state.search || state.mode === 'candidates') names.push('FEEDS');
    if (state.mode === 'candidates' && !all && !state.search && !['30', '90', '365', 'all'].includes(state.range)) names.push('RECENT_RADAR');
    if (all || state.search || (state.mode === 'candidates' && ['30', '90', '365', 'all'].includes(state.range))) names.push('RADAR');
    return names.filter(name => records.has(name));
  };
  function validate(name, value) {
    const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    const strings = x => Array.isArray(x) && x.every(v => typeof v === 'string');
    const sections = x => Array.isArray(x) && x.every(v => object(v) && typeof v.label === 'string' && typeof v.text === 'string');
    if (name === 'FEEDS') {
      if (!object(value) || !Array.isArray(value.items) || value.items.some(p =>
        !object(p) || typeof p.id !== 'string' || typeof p.title !== 'string' ||
        ['summary', 'doi', 'journal', 'date', 'url', 'pmid'].some(k => p[k] != null && typeof p[k] !== 'string') ||
        (p.tags != null && !strings(p.tags)) || (p.abstractSections != null && !sections(p.abstractSections)) ||
        (p.quantitativeMetrics != null && !object(p.quantitativeMetrics)))) throw new Error('Invalid current data');
    } else if (['RADAR', 'RECENT_RADAR'].includes(name)) {
      const dictionaries = ['jn', 'pub', 'tier', 'design', 'tag'];
      if (!object(value) || value.v !== 1 || !Array.isArray(value.rows) || !dictionaries.every(k => strings(value[k])) ||
        value.rows.some(row => !Array.isArray(row) || row.length !== 9 ||
          ![0, 1, 2, 8].every(i => typeof row[i] === 'string') ||
          ![3, 4, 5, 6].every((i, j) => Number.isInteger(row[i]) && row[i] >= 0 && row[i] < value[dictionaries[j]].length) ||
          !Array.isArray(row[7]) || !row[7].every(i => Number.isInteger(i) && i >= 0 && i < value.tag.length)) ||
        (value.abs != null && (!object(value.abs) || Object.values(value.abs).some(ab =>
          !Array.isArray(ab) || ab.some(section => !Array.isArray(section) || section.length !== 2 || !strings(section))))) ||
        ['zh', 'dateBases'].some(k => value[k] != null && (!object(value[k]) || Object.values(value[k]).some(v => typeof v !== 'string')))) throw new Error('Invalid archive data');
    }
    return value;
  }
  async function fallback(name, signal) {
    if (!fullFallback) fullFallback = fetch('/public.js', { signal, credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Public fallback unavailable');
      const source = await response.text();
      if (!source.startsWith('window.PUBLIC_DATA_VERSION="' + boot.version + '";')) throw new Error('data_version_changed');
      return source;
    }).catch(error => { fullFallback = null; throw error; });
    const source = await fullFallback, prefix = 'window.' + name + '=';
    const chunk = source.split('\n;\n').find(part => part.startsWith(prefix));
    if (!chunk || !chunk.endsWith(';')) throw new Error('Public fallback invalid');
    return JSON.parse(chunk.slice(prefix.length, -1));
  }
  async function fetchData(name) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/public-data/' + boot.version + '/' + name + '.json', { signal: controller.signal, credentials: 'same-origin' });
      // Plain local HTTP servers have no Worker. Only their explicit 404 permits
      // the complete classic-file fallback; weak-network failures never fetch 9MB.
      if (response.status === 404) return validate(name, await fallback(name, controller.signal));
      if (response.status === 409) throw new Error('data_version_changed');
      if (!response.ok) throw new Error('Public data unavailable');
      if (response.headers.get('x-public-data-version') !== boot.version) throw new Error('data_version_changed');
      return validate(name, await response.json());
    } finally { clearTimeout(timer); }
  }
  function load(name) {
    const rec = records.get(name);
    if (rec.state === 'ready' || rec.state === 'loading') return rec.promise;
    if (rec.state === 'error') return null; // Explicit retry; no automatic request loop.
    rec.state = 'loading';
    rec.promise = fetchData(name).then(value => {
      // Applying current feeds after archive load must not discard expanded rows.
      const ready = Object.fromEntries([...records].filter(([, r]) => r.state === 'ready').map(([n, r]) => [n, r.value]));
      apply({ ...ready, [name]: value }); rec.value = value; rec.state = 'ready';
    }).catch(error => { rec.value = null; rec.state = 'error'; rec.error = error.message; })
      .finally(() => { if (refresh) refresh(); });
    return rec.promise;
  }
  function status(names) {
    let element = document.getElementById('publicDataStatus');
    const missing = names.filter(name => records.get(name).state !== 'ready');
    if (!missing.length) { if (element) element.hidden = true; return; }
    if (!element) {
      element = document.createElement('section'); element.id = 'publicDataStatus';
      element.className = 'doi-library-notice'; element.setAttribute('role', 'status');
      (document.querySelector('.main-content') || document.getElementById('streamSection')?.parentElement || document.body).prepend(element);
    }
    element.hidden = false; element.replaceChildren();
    const failed = missing.filter(name => records.get(name).state === 'error');
    const changed = failed.some(name => records.get(name).error === 'data_version_changed');
    element.append(document.createTextNode(changed ? '内容版本已更新，请刷新页面。' : failed.length ? '完整栏目暂未加载。已保留精选、周榜与文献库；可返回阅读或重试。' : '正在加载完整栏目内容…精选、周榜与文献库仍可阅读。'));
    if (failed.length) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-sm';
      button.textContent = changed ? '刷新页面' : '重试加载';
      button.onclick = () => {
        if (changed) { location.reload(); return; }
        for (const name of failed) { const rec = records.get(name); rec.state = 'idle'; rec.error = ''; }
        for (const name of currentNames) load(name);
        status(currentNames);
      };
      element.append(button);
    }
  }
  window.PublicData = {
    counts: boot.counts,
    bind(adopt, render) { apply = adopt; refresh = render; },
    ready(state, all = false) {
      currentNames = namesFor(state, all);
      for (const name of currentNames) if (records.get(name).state === 'idle') load(name);
      const ready = currentNames.every(name => records.get(name).state === 'ready');
      status(currentNames); return ready;
    },
    debug() { return Object.fromEntries([...records].map(([name, rec]) => [name, rec.state])); }
  };
})();
