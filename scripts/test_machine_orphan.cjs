'use strict';
// Orphan records: a paper written by a registration that was cut off before its task. Rule, repair by repeat registration, hourly report.
// Synthetic tokens and an in-memory KV only.
const assert = require('assert');
const crypto = require('crypto');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {hash} = require('./test_doi_library_worker.cjs');
const {runIndexAudit} = require('./muse_review_runner.cjs');
const base = 'https://learn.dryz.info', reviewUrl = base + '/api/muse/review';
const dsh = 'synthetic_downloader_token_0123456789ab';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh}]);
const INDEX = 'library:machine-index:v1';
async function create() {
  const clock = {now:Date.now()};
  const h = await setup({clock});
  h.clock = clock;
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  await call(h, '/api/machine/claim', {state:'to-download'});   // the index exists, as in production
  return h;
}
const call = (h, route, body) => h.context.worker.fetch(new Request(base + route, {method:'POST',headers:{authorization:'Bearer ' + dsh,'content-type':'application/json'},body:JSON.stringify(body)}), h.env);
const item = doi => ({doi,title:'Synthetic orphan title for ' + doi,source:'rss-synthetic',section:'MAIN'});
const register = (h, dois) => call(h, '/api/machine/register', {items:dois.map(item)});
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
// What a registration writes first (machineRegisterOne), with optional changes.
function putPaper(h, doi, changes = {}, extra = {}) {
  h.values.set('library:paper:' + doi, JSON.stringify({version:1,paper:{id:'doi-' + hash(doi).slice(0, 16),doi,title:'Synthetic orphan title for ' + doi,journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',
    ingestedAt:'2026-11-14T01:28:51.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'manual_needed',...changes},...extra}));
}
const audit = async (h, cursor) => (await h.context.worker.fetch(new Request(reviewUrl, {method:'POST',headers:{authorization:'Bearer ' + await token(h, reviewUrl, 'muse-review.yml'),'content-type':'application/json'},body:JSON.stringify(cursor ? {action:'index-audit',cursor} : {action:'index-audit'})}), h.env)).json();
async function auditAll(h) {
  const total = {orphans:0,papers:0,orphanDois:[],requests:0};
  let cursor = '', report;
  do {
    report = await audit(h, cursor);
    assert.equal(report.ok, true);
    total.orphans += report.orphans; total.papers += report.papers; total.orphanDois.push(...report.orphanDois); total.requests++;
    cursor = report.cursor;
  } while (!report.done && total.requests < 20);
  return total;
}
async function run() {
  // ---- the rule, one case per condition
  let h = await create();
  const legacy = '10.1000/orphan.legacy', withJob = '10.1000/orphan.job';
  putPaper(h, '10.1000/orphan.1');                                                    // the orphan: registered again
  putPaper(h, '10.1000/orphan.meta');                                                 // the register record exists: left alone
  h.values.set('library:machine-register:10.1000/orphan.meta', JSON.stringify({version:1,doi:'10.1000/orphan.meta',title:'x',source:'x',section:'MAIN',registeredBy:'dsh',registeredAt:1,taskId:crypto.randomUUID()}));
  putPaper(h, '10.1000/orphan.journal', {journal:'Heart'});
  putPaper(h, '10.1000/orphan.authors', {authors:['Jane Doe']});
  putPaper(h, '10.1000/orphan.pdf', {}, {pdf:{key:'library:pdf:' + 'a'.repeat(64),sha256:'a'.repeat(64),size:100000,source:'github'}});
  putPaper(h, '10.1000/orphan.pending', {fulltextStatus:'pending'});
  putPaper(h, '10.1000/orphan.date', {date:'2026-01-05',datePrecision:'day'});
  putPaper(h, legacy);
  h.values.set('library:job:' + legacy, JSON.stringify({version:1,doi:legacy,state:'queued'}));
  const dois = ['10.1000/orphan.1','10.1000/orphan.meta','10.1000/orphan.journal','10.1000/orphan.authors','10.1000/orphan.pdf','10.1000/orphan.pending','10.1000/orphan.date',legacy];
  const body = await (await register(h, dois)).json();
  assert.deepEqual(body.results.map(r => r.result + ':' + (r.state || '')), ['registered:to-download','skipped:no-task','skipped:no-task','skipped:no-task','skipped:no-task','skipped:no-task','skipped:no-task','skipped:legacy-task']);
  assert.equal(stored(h, 'library:muse-job:10.1000/orphan.1').state, 'queued');
  assert.equal(stored(h, 'library:machine-register:10.1000/orphan.1').registeredBy, 'dsh');
  for (const doi of dois.slice(1)) assert(!h.values.has('library:muse-job:' + doi), doi + ' got no task');
  const repeat = await (await register(h, dois)).json();
  assert.equal(repeat.results[0].result, 'skipped', 'once the task exists the DOI is an ordinary existing one');
  assert.equal(repeat.results[0].state, 'to-download');

  // ---- the hourly audit lists orphans (exact count, DOI list cut to 20), never creates a task, and the runner warns
  h = await create();
  for (let n = 0; n < 30; n++) putPaper(h, '10.1000/orphan.a' + String(n).padStart(2, '0'));
  putPaper(h, '10.1000/orphan.journal', {journal:'Heart'});
  putPaper(h, '10.1000/orphan.meta');
  h.values.set('library:machine-register:10.1000/orphan.meta', '{}');
  putPaper(h, legacy);
  h.values.set('library:job:' + legacy, JSON.stringify({version:1,doi:legacy,state:'queued'}));
  assert.equal((await register(h, ['10.1000/orphan.job'])).status, 200);          // a normal registered DOI has a job: not an orphan
  const before = {keys:[...h.values.keys()].sort().join('\n'),writes:h.writes.length};
  const total = await auditAll(h);
  assert.equal(total.orphans, 30);
  assert.equal(total.papers, 34, 'every paper record was looked at');
  assert.equal(total.orphanDois.length, 20, 'the list is cut; the count is exact');
  assert(total.orphanDois.every(doi => /^10\.1000\/orphan\.a\d\d$/.test(doi)));
  assert.equal([...h.values.keys()].sort().join('\n'), before.keys, 'the audit creates no task and no other record');
  const env = {GITHUB_EVENT_NAME:'schedule',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'};
  const http = async (url, init) => new URL(url).hostname === 'unit.actions.githubusercontent.com' ? Response.json({value:await token(h, reviewUrl, 'muse-review.yml')}) : h.context.worker.fetch(new Request(url, init), h.env);
  const logs = [];
  const summary = await runIndexAudit(env, http, line => logs.push(line));
  assert.equal(summary.orphans, 30);
  assert.equal(summary.orphanDois.length, 20);
  assert.equal(summary.mismatch, 0, 'orphans are not an index mismatch: the run does not fail');
  const warning = logs.find(line => line.startsWith('::warning::') && line.includes('孤儿'));
  assert(warning && warning.includes('30 条'), 'a yellow warning names the count');
  assert(warning.includes('10.1000/orphan.a00'));
  // repeat registration of the listed DOIs repairs them; the next audit finds none
  assert.equal((await register(h, Array.from({length:30}, (_, n) => '10.1000/orphan.a' + String(n).padStart(2, '0')))).status, 200);
  const after = await auditAll(h);
  assert.equal(after.orphans, 0);
  const quiet = [];
  await runIndexAudit(env, http, line => quiet.push(line));
  assert(!quiet.some(line => line.includes('孤儿')), 'no orphan, no warning');

  // ---- end to end: a registration cut off mid-batch leaves one orphan per in-flight item; the audit sees them, a repeat of the batch repairs them
  h = await create();
  const batch = Array.from({length:12}, (_, n) => '10.1000/cut.' + n);
  const put = h.kv.put.bind(h.kv);
  let jobs = 0;
  h.kv.put = async (key, value, options) => key.startsWith('library:muse-job:') && ++jobs > 8 ? new Promise(() => {}) : put(key, value, options);
  await Promise.race([register(h, batch), new Promise(resolve => setTimeout(resolve, 150))]);
  h.kv.put = put;
  const cut = await auditAll(h);
  assert(cut.orphans >= 1 && cut.orphans <= 5, 'at most one group of five is in flight when the request dies: ' + cut.orphans);
  const fixed = await (await register(h, batch)).json();
  assert.equal(fixed.counts.registered + fixed.counts.skipped, 12);
  assert.equal(fixed.results.filter(r => r.result === 'skipped' && r.state === 'no-task').length, 0, 'no DOI is skipped as a task-less paper');
  assert.equal((await auditAll(h)).orphans, 0);
  assert.equal([...h.values.keys()].filter(key => key.startsWith('library:muse-job:')).length, 12);
  console.log('machine orphan tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
