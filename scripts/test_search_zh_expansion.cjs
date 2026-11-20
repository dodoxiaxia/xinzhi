'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { appFile, bundleText } = require('./public_bundle.cjs');

const root = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures/search_zh_queries.json');
const fixture = require(fixturePath);
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const extract = (kind, name, pattern) => {
  const match = source.match(new RegExp('^  ' + kind + ' ' + name + pattern, 'm'));
  assert(match, name);
  return match[0];
};
const fn = name => extract('function', name, '\\([^]*?\\n  }');
const constant = name => extract('const', name, ' =[^]*?;');
const fold = [constant('SEARCH_APOSTROPHES'), constant('SEARCH_QUOTES'), fn('foldSearch')].join('\n');
const current = vm.createContext({ state: { search: '' } });
vm.runInContext([fold, constant('ZH_EN'), constant('zhTerms'), fn('queryMatches'),
  'globalThis.newTerms = zhTerms.keys.filter(term => !zhTerms.legacy.has(term))',
  'globalThis.dictionary = ZH_EN'].join('\n'), current);

// The matcher from the baseline commit, with the original table frozen in the fixture.
const baseline = vm.createContext({ ZH_EN: fixture.oldZhEn });
vm.runInContext(fold + `
const zhTerms = Object.keys(ZH_EN).sort((a, b) => b.length - a.length);
function queryMatches(text, q) {
  const plans = queryMatches.plans || (queryMatches.plans = new Map());
  let plan = plans.get(q);
  if (!plan) {
    plan = foldSearch(q).split(/\\s+/).filter(Boolean).map(term => {
      const groups = []; let rest = term;
      while (rest) {
        const zh = zhTerms.find(k => rest.startsWith(k.toLowerCase()));
        if (zh) { groups.push([zh.toLowerCase(), ...ZH_EN[zh].map(x => x.toLowerCase())]); rest = rest.slice(zh.length); }
        else {
          const next = [...rest].findIndex((_, i) => i > 0 && zhTerms.some(k => rest.slice(i).startsWith(k.toLowerCase())));
          const n = next > 0 ? next : rest.length;
          groups.push([rest.slice(0, n)]); rest = rest.slice(n);
        }
      }
      return { term, groups };
    });
    if (plans.size > 50) plans.clear();
    plans.set(q, plan);
  }
  return plan.every(({ term, groups }) => text.includes(term) || groups.every(alts => alts.some(a => text.includes(a))));
}`, baseline);

function assignment(script, name) {
  const match = script.match(new RegExp('^window\\.' + name + '=(.*);$', 'm'));
  assert(match, name);
  return JSON.parse(match[1]);
}

function snapshotTitles(directory) {
  const entry = fs.readFileSync(path.join(directory, appFile(directory)), 'utf8');
  const { parts } = assignment(entry, 'XINZHI_PARTS');
  const file = src => {
    assert(/^assets\/[\w.-]+\.js$/.test(src), src);
    return fs.readFileSync(path.join(directory, src), 'utf8');
  };
  const part = name => {
    const context = { window: { XINZHI_PART(key, value) {
      assert.equal(key, name);
      context.value = value;
    } } };
    vm.runInNewContext(file(parts[name].src), context);
    assert(context.value, name);
    return context.value;
  };
  const library = part('library').papers;
  const inline = assignment(entry, 'FEEDS');
  const deferred = part('feeds');
  const feeds = [];
  inline.order.at.forEach((at, i) => { feeds[at] = inline.items[i]; });
  deferred.at.forEach((at, i) => { feeds[at] = deferred.items[i]; });
  const recent = part('radar').rows;
  const archive = assignment(file(assignment(entry, 'RADAR_SRC')), 'RADAR_ARCHIVE').rows;
  const radar = [...recent, ...archive].map(row => ({ id: 'pmid-' + row[0], title: row[8] }));
  return { rows: [...library, ...feeds, ...radar], inputCounts: {
    library: library.length, feeds: feeds.length, recent: recent.length, archive: archive.length
  } };
}

const negativeByTerm = {
  心包炎: 'Endocarditis and myocarditis', 心包: 'Peritoneal membrane perfusion',
  主动脉夹层: 'Aortic aneurysm repair', 动脉粥样硬化: 'Multiple sclerosis outcomes',
  心源性休克: 'Septic shock and cardiac output', 房间隔缺损: 'Ventricular septal defect',
  卵圆孔未闭: 'Transcatheter patent ductus arteriosus closure', 晕厥: 'Syncytium development',
  长QT: 'Long QTL intervals', 希氏束起搏: 'Right ventricular bundle pacing',
  左束支起搏: 'Right bundle branch pacing', 传导阻滞: 'Coronary artery blockage',
  心脏再同步: 'Cardiac ablation therapy', 肌钙蛋白: 'Macrotroponins and outcomes',
  利钠肽: 'Natriuresis and peptides', 心脏移植: 'Renal transplantation',
  睡眠呼吸暂停: 'Sleep and daytime apnea', 川崎病: 'Kawasaki motorcycle injuries',
  钙化积分: 'Calcium channels and risk prediction', 斑块: 'Antiplaque formulations',
  肥胖: 'Obesityprevention registry', 肾: 'Adrenal tumors and renalase',
  房早: 'Premature ventricular contractions without atrial flutter',
  室早: 'Premature atrial contractions without ventricular disease',
  心动过速: 'Antitachycardia pacing', 心动过缓: 'Pseudobradycardia',
  冠脉CT: 'Coronary ultrasound', 心肌灌注: 'Myocardial metabolism and renal perfusion',
  胆固醇: 'Microcholesterolchemistry screening', 炎症: 'Inflammationomics responses',
  肿瘤心脏病: 'Radiation oncology', 妊娠: 'Pregnancytest product recall',
  儿童: 'Childbearing age outcomes', 老年: 'Older systems and devices',
  女性: 'Superwoman and human tissue', 男性: 'Women and female patients',
  射血分数保留: 'Heart failure with reduced ejection fraction',
  射血分数降低: 'Heart failure with preserved ejection fraction',
  体外膜肺氧合: 'ECMOLOGY', 钠葡萄糖协同转运蛋白2: 'Sodium-glucose cotransporter 1'
};
const abbreviationExamples = {
  AF: 'atrial fibrillation', HFpEF: 'heart failure with preserved ejection fraction',
  HFrEF: 'heart failure with reduced ejection fraction',
  TAVI: 'transcatheter aortic valve implantation', TAVR: 'transcatheter aortic valve replacement',
  PCI: 'percutaneous coronary intervention', CRT: 'cardiac resynchronization therapy',
  LBBAP: 'left bundle branch area pacing', HBP: 'His bundle pacing',
  SGLT2: 'sodium-glucose cotransporter 2', SGLT2i: 'sodium glucose cotransporter 2',
  ECMO: 'extracorporeal membrane oxygenation', CCTA: 'coronary computed tomography angiography',
  PFO: 'patent foramen ovale', ASD: 'atrial septal defect', AVB: 'atrioventricular block',
  LQTS: 'long QT syndrome', 'NT-proBNP': 'N-terminal pro-B-type natriuretic peptide',
  PVC: 'premature ventricular contraction', PVCs: 'premature ventricular contractions',
  PAC: 'premature atrial contraction', PACs: 'premature atrial contractions'
};

function unitChecks() {
  assert.deepEqual([...current.newTerms].sort(), Object.keys(negativeByTerm).sort());
  const matches = (title, q) => current.queryMatches(current.foldSearch(title), q);
  for (const [q, negative] of Object.entries(negativeByTerm)) {
    for (const form of current.dictionary[q]) assert(matches(form, q), q + ' → ' + form);
    assert(matches('研究' + q + '综述', q), 'literal ' + q);
    assert(!matches(negative, q), q + ' must reject ' + negative);
  }
  for (const [short, long] of Object.entries(abbreviationExamples)) {
    assert(matches(long, short.toUpperCase()), short + ' → ' + long);
    assert(matches('Outcomes (' + short.toLowerCase() + ')-related', long.toUpperCase()), long + ' → ' + short);
    const embedded = 'x' + short + 'x';
    assert(!matches(embedded, short), short + ' in ' + embedded);
    assert(!matches(embedded, long), long + ' must not match ' + embedded);
    assert.equal(current.queryMatches('', embedded, true).length, 0, 'embedded query ' + embedded);
  }
  for (const [title, q] of [['AFFECT and safety', 'AF'], ['SPCI and EAPCI', 'PCI'], ['transcatheter mitral valve replacement', 'TAVR'],
    ['adrenal and renalase', '肾'], ['Ventricular fibrillation ablation', '房颤消融'],
    ['atrial fibrillation screening', 'atrial fibrillation ablation'], ['HFpEF without any arrhythmia', 'HFpEF AF']]) {
    assert(!matches(title, q), title + ' / ' + q);
  }
  assert(matches('TAVI', 'TAVR') && matches('TAVR', 'TaVi'), 'cross-alias valve retrieval');
  assert(matches('AF — catheter ablation', '房颤消融'));
  assert(matches('AF — catheter ablation', '房颤 消融'));
  assert(matches('Heart failure with SGLT2 inhibition', '心衰SGLT2'));
  assert(matches('Coronary interventions after myocardial infarction', '冠脉CT'), 'retain old coronary + ct substring match');
  assert(matches('Aortic changes · 夹层', '主动脉夹层'), 'retain old mixed-language match');
  const paperSearchText = vm.runInNewContext([
    fold, constant('PAPER_DERIVED'), fn('paperDerived'), fn('paperSearchText'), 'paperSearchText'
  ].join('\n'), { quicklookOf: () => null });
  const valvePaper = { title: 'Transcatheter aortic valve-in-valve outcomes', titleZh: '术后随访' };
  const valveText = paperSearchText(valvePaper);
  assert(baseline.queryMatches(valveText, 'TAVR术后'), 'the original table found this paper');
  for (const q of ['TAVR术后', '术后tavr']) {
    assert(current.queryMatches(valveText, q), 'match TAVR and Chinese text across paper fields: ' + q);
    assert.equal(current.queryMatches('', q, true)[0][0], 'TAVR');
    assert(!matches(valvePaper.title, q), 'require the Chinese part: ' + q);
  }
  const pciPaper = { title: 'Percutaneous coronary intervention outcomes', summary: '术后随访' };
  assert(current.queryMatches(paperSearchText(pciPaper), 'PCI术后'));
  assert(!matches('SPCI 术后随访', 'PCI术后'), 'require a whole abbreviation in paper text');
  assert(!current.queryMatches(paperSearchText(pciPaper), 'SPCI术后'), 'embedded query abbreviation stays literal');
  assert.equal(current.queryMatches('', 'SPCI术后', true).length, 0);
  assert(matches('N-terminal pro-B-type natriuretic peptide 术后', '术后NT-proBNP'));
  assert(matches('fibrillation in the left atrial region', 'atrial fibrillation'), 'retain old English AND match');
  assert(matches('What the Robot Still Can’t Do', "Can't"), 'apostrophe folding');
  assert(!matches('What the Robot Still Can’t Do', 'Cant'), 'apostrophe not deleted');
  assert.equal(current.queryMatches('', 'electrophysiology', true).length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(current.queryMatches('', '房颤消融', true))),
    [['房颤', ['atrial fibrillation', 'AF']], ['消融', ['ablation']]]);
}

function matchesBaselineWithBoundaries(text, q) {
  // Compute the strict subset independently: allow a loss only when an old
  // ASCII substring would masquerade as a standalone abbreviation.
  const boundedWords = new Set(Object.keys(abbreviationExamples).map(word => word.toLowerCase()));
  return q.toLowerCase().split(/\s+/).every(term => {
    if (!boundedWords.has(term)) return baseline.queryMatches(text, term);
    if (term === 'tavr' && text.includes('transcatheter aortic')) return true;
    return new RegExp('\\b' + term + '\\b').test(text);
  });
}

function benchmark(rows, q) {
  function sample(match) {
    const start = performance.now();
    let hits = 0;
    for (let round = 0; round < 5; round++) {
      for (const row of rows) hits += Number(match(row.text, q));
    }
    assert(hits > 0, 'benchmark query must reach the full plan');
    return (performance.now() - start) / 5;
  }
  sample(baseline.queryMatches);
  sample(current.queryMatches);
  const times = { before: [], after: [] };
  for (let round = 0; round < 9; round++) {
    const pair = round % 2 ? ['after', 'before'] : ['before', 'after'];
    for (const name of pair) times[name].push(sample(name === 'before' ? baseline.queryMatches : current.queryMatches));
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const beforeMs = median(times.before);
  const afterMs = median(times.after);
  const ratio = afterMs / beforeMs;
  assert(ratio <= 2, `cached search benchmark ${q}: ${afterMs.toFixed(3)} / ${beforeMs.toFixed(3)} ms = ${ratio.toFixed(2)}×`);
  return { q, beforeMs, afterMs, ratio };
}

function run(input) {
  assert(fs.statSync(fixturePath).size <= 100_000, 'fixture exceeds 100 KB');
  assert(Object.keys(fixture.queries).length >= 60);
  unitChecks();
  const byId = new Map();
  for (const { id, title } of input.rows) {
    if (id && title && !byId.has(id)) byId.set(id, { id, title, text: current.foldSearch(title) });
  }
  const rows = [...byId.values()];
  const results = Object.entries(fixture.queries).map(([q, ids]) => {
    assert(ids.length && ids.every(id => Object.hasOwn(fixture.records, id)), q + ' has no frozen expected titles');
    const before = rows.filter(row => baseline.queryMatches(row.text, q));
    const after = rows.filter(row => current.queryMatches(row.text, q));
    const found = new Set(after.map(row => row.id));
    for (const id of ids) assert(found.has(id), q + ' lost must-find ' + id);
    const lost = before.filter(row => !found.has(row.id));
    for (const row of lost) assert(!matchesBaselineWithBoundaries(row.text, q), q + ' lost legacy match ' + row.id);
    return { q, before: before.length, after: after.length, excludedByBoundary: lost.length, firstFive: after.slice(0, 5).map(({ title }) => title) };
  });
  const terms = [...current.newTerms, ...Object.keys(abbreviationExamples)];
  const breadth = terms.map(term => {
    const hits = rows.filter(row => current.queryMatches(row.text, term)).length;
    assert(hits / rows.length <= 0.3, term + ' matches over 30% of titles');
    return { term, hits, fraction: hits / rows.length };
  });
  const longest = Object.keys(fixture.queries).reduce((a, b) => a.length >= b.length ? a : b);
  return { corpus: rows.length, inputCounts: input.inputCounts, results, breadth, benchmark: benchmark(rows, longest) };
}

function uiCounts(directory) {
  const script = bundleText(directory);
  current.window = Object.fromEntries(['FEEDS', 'LIBRARY', 'CURATED', 'RADAR', 'QUICKLOOKS', 'PREGENERATED']
    .map(key => [key, assignment(script, key)]));
  vm.runInContext([
    constant('KIND_MAP'), constant('MINOR_RE'), fn('normalizePaper'), fn('expandRadar'), constant('PAPER_DERIVED'), constant('trKeyOf'),
    ...['paperDerived', 'paperSearchText', 'matchesQuery', 'getCuratedList', 'preGeneratedOf', 'quicklookOf'].map(fn),
    extract('function', 'qlKey', '[^\\n]+'),
    'const LIVE_QL = {}; const FEEDS = window.FEEDS; const LIBRARY = window.LIBRARY; const CURATED = window.CURATED;'
  ].join('\n'), current);
  const catalogues = vm.runInContext(`
    expandRadar(window.RADAR);
    [...FEEDS.items, ...LIBRARY.papers, ...CURATED].forEach(normalizePaper);
    ({ library: LIBRARY.papers, candidates: FEEDS.items, curated: getCuratedList() });
  `, current);
  const queries = ['房颤消融', 'AF', 'AF xinzhi-search-no-match-4bfg4', 'electrophysiology'];
  const entries = Object.entries(catalogues).map(([mode, papers]) => [mode, Object.fromEntries(queries.map(q => {
    current.state.search = q;
    return [q, papers.filter(current.matchesQuery).length];
  }))]);
  console.log(JSON.stringify(Object.fromEntries(entries)));
}

if (process.argv[2] === '--ui-counts') {
  uiCounts(process.argv[3]);
} else {
  const directory = process.env.SEARCH_ZH_PUBLIC_CORPUS;
  const library = require('../editorial/public_library_snapshot.json').papers;
  const frozen = Object.entries(fixture.records).map(([id, title]) => ({ id, title }));
  const report = run(directory ? snapshotTitles(directory) : { rows: [...frozen, ...library] });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify({ corpus: report.corpus, queries: report.results.length, terms: report.breadth.length,
    excludedByBoundary: report.results.reduce((sum, row) => sum + row.excludedByBoundary, 0), benchmark: report.benchmark }));
}
