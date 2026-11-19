'use strict';
// Offline end-to-end Playwright verification for:
// 1) Goal 1: Article topic multi-select OR, cross-axis AND, uncategorized exclusion, all 4 modes, URL/popstate/reload, unknown tags.
// 2) Goal 2: This-browser-only confirmed request ledger, >100 KV pagination honesty, non-core recovery, gated drawer/PDF links, corrupt storage safety.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const shaId = doi => 'doi-' + crypto.createHash('sha256').update(doi).digest('hex').slice(0, 16);
const bjToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

const apiPaper = (doi, title, fulltextStatus = 'available', extra = {}) => ({
  id: shaId(doi),
  doi,
  title,
  journal: extra.journal || 'Nature Medicine',
  date: extra.date || bjToday(),
  datePrecision: 'day',
  dateBasis: 'Crossref published-online',
  ingestedAt: new Date().toISOString(),
  metadataStatus: 'external_bibliography_checked',
  fulltextStatus,
  ...extra
});

async function main() {
  const today = bjToday();
  const origin = 'https://topics-requests.invalid';

  const curatedFixture = [
    {
      id: 'cur-af-1', doi: '10.1000/c-af', title: 'AF Ablation Randomized Trial',
      journal: 'New England Journal of Medicine', cleanJournal: 'New England Journal of Medicine',
      publisher: 'MMS (NEJM)', clinicalTier: '顶级综合与科学', studyDesign: 'RCT',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#房颤/电生理'],
      summary: 'Public abstract AF', draftData: { published: today, title_zh: '房颤消融随机对照试验', summary: '已核对摘要要点' }, hasDraft: true
    },
    {
      id: 'cur-hf-1', doi: '10.1000/c-hf', title: 'Heart Failure Biomarker Study',
      journal: 'Circulation', cleanJournal: 'Circulation',
      publisher: 'AHA (Circulation)', clinicalTier: '心血管旗舰顶刊', studyDesign: 'RCT',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#心衰/心肌'],
      summary: 'Public abstract HF', draftData: { published: today, title_zh: '心衰生物标志物研究', summary: '已核对摘要要点' }, hasDraft: true
    },
    {
      id: 'cur-aiecg-1', doi: '10.1000/c-aiecg', title: 'AI-ECG Foundation Model Evaluation',
      journal: 'npj Digital Medicine', cleanJournal: 'npj Digital Medicine',
      publisher: 'Nature Portfolio', clinicalTier: 'AI医疗与数字医学', studyDesign: '方法/模型验证',
      date: today, datePrecision: 'day', lane: 'aimed', crossAI: true, tags: ['#AI-ECG', '#大模型/NLP'],
      summary: 'Public abstract AI-ECG', draftData: { published: today, title_zh: 'AI 心电基础模型评估', summary: '已核对摘要要点' }, hasDraft: true
    },
    {
      id: 'cur-none-1', doi: '10.1000/c-none', title: 'Lipid Cohort Without Topic Tag',
      journal: 'JAMA', cleanJournal: 'JAMA',
      publisher: 'JAMA Network', clinicalTier: '顶级综合与科学', studyDesign: '队列研究',
      date: today, datePrecision: 'day', lane: 'cardio', tags: [],
      summary: 'Public abstract untagged', draftData: { published: today, title_zh: '无主题标签血脂队列研究', summary: '已核对摘要要点' }, hasDraft: true
    }
  ];

  const feedsFixture = [
    {
      id: 'feed-af-1', doi: '10.1000/f-af', title: 'Radar AF Monitoring Cohort',
      journal: 'New England Journal of Medicine', cleanJournal: 'New England Journal of Medicine',
      publisher: 'MMS (NEJM)', clinicalTier: '心血管综合与其他', studyDesign: '队列研究',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#房颤/电生理'],
      weeklyPick: 1, weeklyAt: today + 'T03:00:00Z', weeklyCategory: 'cardio', summary: 'Radar AF abstract'
    },
    {
      id: 'feed-hf-1', doi: '10.1000/f-hf', title: 'Radar HF Therapy Trial',
      journal: 'Circulation', cleanJournal: 'Circulation',
      publisher: 'AHA (Circulation)', clinicalTier: '心血管旗舰顶刊', studyDesign: 'RCT',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#心衰/心肌'],
      weeklyPick: 2, weeklyAt: today + 'T03:00:00Z', weeklyCategory: 'cardio', summary: 'Radar HF abstract'
    },
    {
      id: 'feed-ai-1', doi: '10.1000/f-ai', title: 'Radar AI-ECG Validation',
      journal: 'New England Journal of Medicine', cleanJournal: 'New England Journal of Medicine',
      publisher: 'MMS (NEJM)', clinicalTier: 'AI医疗与数字医学', studyDesign: '方法/模型验证',
      date: today, datePrecision: 'day', lane: 'aimed', crossAI: true, tags: ['#AI-ECG'],
      weeklyPick: 3, weeklyAt: today + 'T03:00:00Z', weeklyCategory: 'aimed', summary: 'Radar AI-ECG abstract'
    },
    {
      id: 'feed-unk-1', doi: '10.1000/f-unk', title: 'Radar Custom Tag Robustness Case',
      journal: 'JAMA', cleanJournal: 'JAMA',
      publisher: 'JAMA Network', clinicalTier: '心血管综合与其他', studyDesign: '队列研究',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#未知主题'],
      weeklyPick: 4, weeklyAt: today + 'T03:00:00Z', weeklyCategory: 'cardio', summary: 'Radar unknown tag abstract'
    },
    {
      id: 'feed-none-1', doi: '10.1000/f-none', title: 'Radar Untagged Cardiology Paper',
      journal: 'Circulation', cleanJournal: 'Circulation',
      publisher: 'AHA (Circulation)', clinicalTier: '心血管旗舰顶刊', studyDesign: '队列研究',
      date: today, datePrecision: 'day', lane: 'cardio', tags: [],
      weeklyPick: 5, weeklyAt: today + 'T03:00:00Z', weeklyCategory: 'cardio', summary: 'Radar untagged abstract'
    }
  ];

  const staticLibraryFixture = [
    {
      id: 'lib-af-1', doi: '10.1000/lib-af', title: 'Library AF Anticoagulation Study',
      journal: 'New England Journal of Medicine', cleanJournal: 'New England Journal of Medicine',
      publisher: 'MMS (NEJM)', clinicalTier: '顶级综合与科学', studyDesign: 'RCT',
      date: today, datePrecision: 'day', lane: 'cardio', tags: ['#房颤/电生理'], summary: 'Lib AF abstract'
    },
    {
      id: 'lib-req-fail', doi: '10.1000/req-fail-then-ok', title: 'Requested Library Trial',
      journal: 'The Lancet', cleanJournal: 'The Lancet',
      publisher: 'The Lancet Group', clinicalTier: '顶级综合与科学', studyDesign: 'RCT',
      date: today, datePrecision: 'day', lane: 'cardio', tags: [], summary: 'Static target for submit/retry test'
    }
  ];

  // Construct 105 dynamic KV papers so 5 pages * 20 = 100 loaded and paper #105 sits past cursor cap.
  const totalDynamicCount = 105;
  const pageSize = 20;
  const pagedDynamicList = Array.from({ length: totalDynamicCount - 1 }, (_, i) => {
    const num = String(i + 1).padStart(3, '0');
    return apiPaper(`10.1000/dyn-${num}`, `Dynamic Supplemental Paper ${num}`, 'available', {
      journal: 'Circulation',
      tags: i % 2 === 0 ? ['#心衰/心肌'] : []
    });
  });
  const overLimitNonCoreDoi = '10.1000/over-limit-noncore';
  const overLimitNonCoreRecord = apiPaper(overLimitNonCoreDoi, 'Non-Core Over-Limit Dynamic Paper', 'pending', {
    journal: 'Physics Review Letters Sample',
    tags: ['#影像']
  });

  const kvPapers = new Map(pagedDynamicList.map(p => [p.doi, p]));
  kvPapers.set(overLimitNonCoreDoi, overLimitNonCoreRecord);
  const kvJobs = new Map();

  let acquireMode = 'ok';
  const acquirePosts = [];
  const libraryDoiLookups = [];
  const pageErrors = [];

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === 'https://www.ebi.ac.uk') {
      return route.fulfill({ json: { hitCount: 0, resultList: { result: [] } } });
    }
    assert.equal(u.origin, origin, 'No external host calls allowed: ' + u.href);

    if (req.method() === 'POST') {
      assert(['/api/acquire', '/api/muse/retry'].includes(u.pathname), 'Unexpected POST ' + u.pathname);
      const doi = String(u.searchParams.get('doi') || '').toLowerCase();
      acquirePosts.push({ pathname: u.pathname, doi, mode: acquireMode });
      if (acquireMode === 'forbidden') {
        return route.fulfill({ status: 403, json: { ok: false, error: 'invalid_passphrase' } });
      }
      if (acquireMode === 'uncertain502') {
        return route.fulfill({ status: 502, json: { error: 'upstream_timeout' } });
      }
      const job = { id: '00000000-0000-4000-8000-000000000101', doi, state: 'queued', stage: 'queued' };
      kvJobs.set(doi, job);
      return route.fulfill({ status: 202, json: { ok: true, job } });
    }

    if (u.pathname === '/api/library') {
      if (u.searchParams.has('doi')) {
        const doi = String(u.searchParams.get('doi') || '').toLowerCase();
        libraryDoiLookups.push(doi);
        const paper = kvPapers.get(doi);
        const job = kvJobs.get(doi);
        return route.fulfill({
          json: {
            ok: true,
            found: !!paper,
            ...(paper ? { paper, status: paper.fulltextStatus } : {}),
            ...(job ? { job } : {})
          }
        });
      }
      const start = Number(u.searchParams.get('cursor') || '0');
      const slice = pagedDynamicList.slice(start, start + pageSize);
      const nextOffset = start + slice.length;
      const hasMore = nextOffset < pagedDynamicList.length;
      return route.fulfill({
        json: {
          ok: true,
          papers: slice,
          jobs: [],
          ...(hasMore ? { cursor: String(nextOffset) } : {})
        }
      });
    }

    if (u.pathname === '/api/ai' && u.searchParams.get('task') === 'status') {
      return route.fulfill({ json: { ok: true, canGenerate: false, pdfSignedLink: true } });
    }

    if (u.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    }

    const dataAssets = {
      '/data/curated.js': 'window.CURATED=' + JSON.stringify(curatedFixture),
      '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: today + 'T03:00:00Z', items: feedsFixture }),
      '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: staticLibraryFixture, pdfIds: [] }),
      '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
      '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [{ id: 's1', name: 'Fixture Source', status: 'ok', items: feedsFixture.length }] })
    };
    if (dataAssets[u.pathname]) {
      return route.fulfill({ body: dataAssets[u.pathname], contentType: 'application/javascript' });
    }

    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (['index.html', 'app.js', 'journal-tiers.js', 'citation-export.js', 'style.css', 'icon.png'].includes(file)) {
      return route.fulfill({
        body: fs.readFileSync(path.join(root, file)),
        contentType: file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.css') ? 'text/css'
          : file.endsWith('.png') ? 'image/png' : 'text/html'
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  try {
    // ==== GOAL 1: Article topics across all 4 modes + OR/AND/uncategorized + URL/popstate ====
    await page.goto(origin + '/?mode=curated');
    await page.locator('[data-qf="topic"]').waitFor();
    const topicChipText = await page.locator('[data-qf="topic"]').innerText();
    assert(topicChipText.includes('文章主题'), 'QuickBar topic chip must be labeled 文章主题');
    assert(!topicChipText.includes('亚专科'), 'QuickBar topic label must not call whole group 心血管亚专科');

    // Open topic popover and verify OR / mutual-exclusion hint & multi-select OR in curated mode
    await page.locator('[data-qf="topic"]').click();
    const popHint = await page.locator('#qfPop .qf-hint').innerText();
    assert(popHint.includes('任一') && popHint.includes('未分类'), 'Topic popover must explain OR and uncategorized mutual exclusion');
    assert(!popHint.includes('心血管亚专科'), 'Topic popover hint must not call all tags 心血管亚专科');

    await page.locator('[data-qf-topic="#房颤/电生理"]').click();
    await page.locator('[data-qf-topic="#心衰/心肌"]').click();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 2, 'Curated multi-topic OR returns both AF and HF papers');
    assert(await page.locator('[data-qf="more"].is-on').count() === 1, 'qfMoreActive turns on when topic filter is active');
    assert((await page.locator('#qfSummary').innerText()).includes('#房颤/电生理'), 'Summary shows selected topic chips');

    // Cross-axis AND with jtier=generalMedicine -> keeps only NEJM AF paper
    await page.locator('[data-qf-jtier="generalMedicine"]').click();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1, 'Topic OR intersects with jtier via AND');
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').first().getAttribute('data-paper-id'), 'cur-af-1');

    // Clear jtier, test 未分类 mutex with specific tags
    await page.locator('[data-qf-jtier="generalMedicine"]').click();
    await page.locator('[data-qf="topic"]').click();
    await page.locator('[data-qf-topic-unclassified]').click();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1, 'Uncategorized matches only untagged paper');
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').first().getAttribute('data-paper-id'), 'cur-none-1');
    assert(new URL(page.url()).searchParams.get('tags') === 'uncategorized', 'URL serializes uncategorized state');
    assert((await page.locator('#qfPop [data-qf-topic="#房颤/电生理"].is-on').count()) === 0, 'Uncategorized clears specific tags');

    // Selecting specific tag clears uncategorized, and 全部 clears topic condition
    await page.locator('[data-qf-topic="#房颤/电生理"]').click();
    assert((await page.locator('#qfPop [data-qf-topic-unclassified].is-on').count()) === 0, 'Specific tag clears uncategorized');
    await page.locator('[data-qf-topic-all]').click();
    assert(!new URL(page.url()).searchParams.has('tag') && !new URL(page.url()).searchParams.has('tags'), '全部 clears topic URL params');
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), curatedFixture.length, '全部 restores full curated count');

    // Verify topic chip & filtering work in weekly, candidates, and library modes
    await page.locator('[data-mode="weekly"]').click();
    await page.locator('#weeklyAuto .weekly-auto-item').first().waitFor();
    assert.equal(await page.locator('[data-qf="topic"]').isVisible(), true, 'Weekly mode shows 文章主题 chip');
    await page.locator('[data-qf="topic"]').click();
    await page.locator('[data-qf-topic="#房颤/电生理"]').click();
    await page.locator('[data-qf-topic="#AI-ECG"]').click();
    assert.equal(await page.locator('#weeklyAuto .weekly-auto-item').count(), 2, 'Weekly mode filters board entries by multi-topic OR');
    const weeklyTotalText = await page.locator('#weeklyAuto .weekly-total').innerText();
    assert(weeklyTotalText.includes('2 / ' + feedsFixture.length), 'Weekly header shows filtered ratio against weekly fixture total');
    await page.locator('[data-qf-topic-all]').click();

    await page.locator('[data-mode="candidates"]').click();
    await page.locator('[data-qf="topic"]').click();
    await page.locator('[data-qf-topic="#房颤/电生理"]').click();
    assert.equal(await page.locator('#articlesStream article[data-paper-id="feed-af-1"]').count(), 1, 'Candidates mode filters by topic');
    await page.locator('[data-qf-topic-all]').click();

    // URL serialization, legacy ?tag=, reload, unknown tag, and browser back/forward popstate
    await page.goto(origin + '/?mode=candidates&tags=' + encodeURIComponent('#房颤/电生理,#AI-ECG') + '&jtier=generalMedicine');
    await page.locator('#articlesStream article[data-paper-id]').first().waitFor();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 2, 'Multi-tag + jtier URL filters candidates on load');
    await page.reload();
    await page.locator('#articlesStream article[data-paper-id]').first().waitFor();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 2, 'Reload retains multi-tag + jtier filters');

    await page.goto(origin + '/?mode=candidates&tag=' + encodeURIComponent('#未知主题'));
    await page.locator('#articlesStream article[data-paper-id="feed-unk-1"]').waitFor();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1, 'Legacy ?tag= with unknown tag renders safely without crashing');

    await page.locator('[data-mode="library"]').click();
    await page.locator('.doi-library-notice').waitFor();
    assert.equal(await page.locator('[data-qf="topic"]').isVisible(), true, 'Library mode shows 文章主题 chip');
    await page.locator('[data-qf="topic"]').click();
    await page.locator('[data-qf-topic="#房颤/电生理"]').click();
    assert(await page.locator('#articlesStream article[data-paper-id="lib-af-1"]').count() === 1, 'Library mode filters by topic');
    await page.goBack();
    await page.locator('#articlesStream article[data-paper-id="feed-unk-1"]').waitFor();
    assert(new URL(page.url()).searchParams.get('mode') === 'candidates', 'Back navigation restores previous mode and filters');

    // Radar panels stay above the list in normal flow, including after a journal pick.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(origin + '/?mode=candidates');
      const total = page.locator('#listTotal');
      const firstPaper = page.locator('#articlesStream article[data-paper-id]').first();
      const pop = page.locator('#qfPop');
      await firstPaper.waitFor();
      const assertExposed = async locator => {
        const box = await locator.boundingBox();
        const panel = await pop.boundingBox();
        assert(box && panel && box.y >= panel.y + panel.height, 'radar results must be below the open panel at ' + width);
        assert(box.y >= 0 && box.y + Math.min(box.height, 40) <= 800, 'top of radar results stays onscreen at ' + width);
        assert(await locator.evaluate(el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)));
        }), 'radar results must not be covered at ' + width);
      };
      for (const trigger of ['#qfScopeBtn', '[data-qf="topic"]', '[data-qf="more"]', '[data-qf-jtier-menu="generalMedicine"]']) {
        await page.locator(trigger).click();
        await pop.waitFor();
        assert.equal(await page.locator('#qfBackdrop').isVisible(), false, 'radar must not dim the list');
        await assertExposed(total);
        await assertExposed(firstPaper);
        if (trigger.includes('jtier')) {
          await pop.locator('[data-qf-pick-journal="New England Journal of Medicine"]').click();
          assert.equal(await total.innerText(), '共 2 篇');
          await assertExposed(firstPaper);
        }
        await page.keyboard.press('Escape');
        await pop.waitFor({ state: 'hidden' });
        assert.equal(await page.locator(trigger).evaluate(el => el === document.activeElement), true, 'Escape restores focus to the trigger');
      }
    }
    await page.goto(origin + '/?mode=library');
    await page.locator('#qfScopeBtn').click();
    assert.equal(await page.locator('#qfPop').evaluate(el => getComputedStyle(el).position), 'fixed', 'library layout is unchanged');
    await page.setViewportSize({ width: 1280, height: 720 });

    // ==== GOAL 2: Pagination disclosure + browser-local request ledger ====
    await page.goto(origin + '/?mode=library');
    await page.locator('.doi-library-notice').waitFor();
    const noticeText = await page.locator('.doi-library-notice').innerText();
    assert(noticeText.includes('100'), 'Truncated library notice reports actual 100 loaded dynamic records');
    assert(noticeText.includes('截断'), 'Truncated library notice discloses truncation');
    assert(!noticeText.includes('全部库'), 'Truncated library notice never says 全部库');

    // Empty modal check & local-only disclosure
    await page.locator('#openRequestsBtn').click();
    await page.locator('#requestsModalBackdrop.open').waitFor();
    const disclosureText = await page.locator('#requestsModalBody .req-disclosure').innerText();
    assert(disclosureText.includes('localStorage') && disclosureText.includes('不是服务器持久账本'), 'Request modal discloses browser-only localStorage persistence');
    assert((await page.locator('#requestsModalBody').innerText()).includes('还没有已确认的全文申请记录'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#requestsModalBackdrop.open'));

    // Failed submit (403) MUST NOT record
    acquireMode = 'forbidden';
    await page.goto(origin + '/?mode=library&q=' + encodeURIComponent('10.1000/req-fail-then-ok'));
    await page.locator('[data-ft-action="open-form"]').first().waitFor();
    await page.locator('[data-ft-action="open-form"]').first().click();
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) input[name="passphrase"]').first().fill('fake-pass');
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) button[type="submit"]').first().click();
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) .ft-error').first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('xz_browser_requests_v1')), null, '403 failure must not write browser request record');

    // Uncertain 502 + lookup found:false + no job -> does NOT record and does NOT auto-requeue
    acquireMode = 'uncertain502';
    const postsBeforeUncertain = acquirePosts.length;
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) input[name="passphrase"]').first().fill('fake-pass');
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) button[type="submit"]').first().click();
    await page.waitForFunction(() => (document.querySelector('#articlesStream form[data-ft-form]:not([hidden]) .ft-error')?.textContent || '').includes('没有提交上'));
    assert.equal(acquirePosts.length, postsBeforeUncertain + 1, 'Uncertain submit checks read-only lookup instead of auto-requeuing');
    assert.equal(await page.evaluate(() => localStorage.getItem('xz_browser_requests_v1')), null, 'Unconfirmed uncertain submit does not save record');

    // Successful submit on non-core paper past 100-item list limit -> records & dedups
    await page.goto(origin + '/?mode=library&q=' + encodeURIComponent(overLimitNonCoreDoi));
    await page.locator('[data-ft-action="open-form"]').first().waitFor();
    await page.locator('[data-ft-action="open-form"]').first().click();
    acquireMode = 'ok';
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) input[name="passphrase"]').first().fill('fake-pass');
    await page.locator('#articlesStream form[data-ft-form]:not([hidden]) button[type="submit"]').first().click();
    await page.waitForFunction(() => Number(document.querySelector('#requestsCounter')?.textContent || '0') === 1);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xz_browser_requests_v1') || '[]'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].doi, overLimitNonCoreDoi);
    // Ensure passphrase never hits localStorage
    assert(!JSON.stringify(saved).includes('fake-pass'), 'Passphrase must never persist in localStorage');

    // Simulate server finishing fulltext later; reload under default lane=core where >100 list omits it
    kvJobs.delete(overLimitNonCoreDoi);
    kvPapers.set(overLimitNonCoreDoi, { ...overLimitNonCoreRecord, fulltextStatus: 'available' });
    await page.goto(origin + '/?mode=library');
    await page.locator('.doi-library-notice').waitFor();
    // Normal list stays on default lane=core and paginated 100 items, not containing overLimitNonCoreDoi
    assert.equal(await page.locator(`#articlesStream article[data-paper-id="${overLimitNonCoreRecord.id}"]`).count(), 0, 'Default lane=core and 100-item list stays unchanged');

    // Open requests modal -> point lookup GET /api/library?doi=... finds it and marks 可下载
    await page.locator('#openRequestsBtn').click();
    await page.locator('#requestsModalBackdrop.open').waitFor();
    const reqItem = page.locator(`#requestsModalBody .req-item[data-req-doi="${overLimitNonCoreDoi}"]`);
    await reqItem.waitFor();
    await page.waitForFunction(doi => (document.querySelector(`#requestsModalBody .req-item[data-req-doi="${doi}"]`)?.textContent || '').includes('可下载'), overLimitNonCoreDoi);
    const dlHref = await reqItem.locator('a[data-ft-download]').getAttribute('href');
    assert.equal(dlHref, '/api/fulltext?doi=' + encodeURIComponent(overLimitNonCoreDoi), 'Available record links to gated /api/fulltext?doi=... download');
    // Clicking download link reveals gated passphrase form rather than bypassing passphrase
    await reqItem.locator('a[data-ft-download]').click();
    assert.equal(await reqItem.locator('form[data-ft-dl-form] input[name="passphrase"]').isVisible(), true, 'Gated download uses existing passphrase form');

    // Opening 阅读详情 connects to existing reader drawer and gated drawer download link
    await reqItem.locator('[data-action="open-request-paper"]').click();
    await page.locator('#readerDrawer.open').waitFor();
    assert.equal(await page.locator('#drawerPdfLink').getAttribute('href'), '/api/fulltext?doi=' + encodeURIComponent(overLimitNonCoreDoi));

    // "刷新全部状态" must cover every saved record, not a fixed prefix that then jumps to the front
    const manyDois = Array.from({ length: 30 }, (_, i) => '10.1000/refresh-' + String(i + 1).padStart(2, '0'));
    const seedRecords = manyDois.map((doi, i) => ({
      doi,
      title: 'Refresh Coverage Paper ' + (i + 1),
      journal: 'Circulation',
      status: 'pending',
      stage: '',
      requestedAt: '2026-01-01T00:00:00.000Z',
      lastCheckedAt: '',
      paperId: '',
      note: '',
      sourceMode: ''
    }));
    await page.evaluate(records => localStorage.setItem('xz_browser_requests_v1', JSON.stringify(records)), seedRecords);
    await page.goto(origin + '/?mode=library');
    await page.locator('#openRequestsBtn').click();
    await page.locator('#requestsModalBackdrop.open').waitFor();
    await page.waitForFunction(() => !document.querySelector('#refreshRequestsBtn')?.disabled);
    const waitForAllRefreshLookups = async (label) => {
      const deadline = Date.now() + 20000;
      let unique = [];
      while (Date.now() < deadline) {
        unique = [...new Set(libraryDoiLookups.filter(d => manyDois.includes(d)))].sort();
        const busy = await page.evaluate(() => !!document.querySelector('#refreshRequestsBtn')?.disabled);
        if (unique.length === manyDois.length && !busy) return libraryDoiLookups.slice();
        await page.waitForTimeout(50);
      }
      console.error(label, 'n=' + libraryDoiLookups.length, 'unique=' + unique.length, 'missing', manyDois.filter(d => !unique.includes(d)), 'extra', [...new Set(libraryDoiLookups)].filter(d => !manyDois.includes(d)));
      return libraryDoiLookups.slice();
    };
    libraryDoiLookups.length = 0;
    await page.locator('#refreshRequestsBtn').click();
    const firstPass = await waitForAllRefreshLookups('firstPass');
    assert.deepEqual([...new Set(firstPass.filter(d => manyDois.includes(d)))].sort(), [...manyDois].sort(), 'First 刷新全部状态 must look up every saved DOI, including those past 25');
    libraryDoiLookups.length = 0;
    await page.locator('#refreshRequestsBtn').click();
    const secondPass = await waitForAllRefreshLookups('secondPass');
    assert.deepEqual([...new Set(secondPass.filter(d => manyDois.includes(d)))].sort(), [...manyDois].sort(), 'Second 刷新全部状态 must still cover every DOI, not only the previously pinned prefix');

    // Corrupt localStorage does not break boot
    await page.evaluate(() => localStorage.setItem('xz_browser_requests_v1', '{broken-json'));
    await page.goto(origin + '/?mode=curated');
    await page.locator('#openRequestsBtn').waitFor();
    assert.equal(await page.locator('#requestsCounter').innerText(), '0', 'Corrupt request storage falls back safely to 0');

    assert.deepEqual(pageErrors, [], 'Zero uncaught page errors');
    console.log('Topics & browser requests UI checks passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
