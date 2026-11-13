'use strict';
// 全文提交韧性、后台刷新表单快照恢复、补录列表 60s TTL 节流。
// 离线浏览器测试：context.route 假后端 + 合成数据与合成口令，不连任何真实服务。
// 说明：45s 请求超时分支通过 page.addInitScript 在测试开关开启时将 45000ms 定时器缩短为 120ms，并用挂起 route 触发 AbortError。
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://ft-resilience.invalid';
const paperId = doi => 'doi-' + crypto.createHash('sha256').update(doi).digest('hex').slice(0, 16);
const makePaper = (doi, title, fulltextStatus = 'pending') => ({
  id: paperId(doi), doi, title, journal: 'Nature Medicine', date: '2026-09-18', datePrecision: 'day',
  dateBasis: 'Crossref published-online', ingestedAt: '2026-10-07T08:00:00Z',
  metadataStatus: 'external_bibliography_checked', fulltextStatus
});
const LIST_URL = '/?mode=library&lane=all&range=all&maintainer=0';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    // =========================================================================
    // Part 1: 提交「获取全文」断网/超时/502/2xx不可确认 与 明确业务错误
    // =========================================================================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [], consoleLines = [], requests = [], posts = [];
      const hungReleases = [];

      const DOI_NET = '10.1234/resil.netjob';
      const DOI_TIMEOUT = '10.1234/resil.timeout';
      const DOI_BOTHFAIL = '10.1234/resil.bothfail';
      const DOI_BAD2XX = '10.1234/resil.bad2xx';
      const DOI_INVALID = '10.1234/resil.invalid';

      const PASS_1 = 'fake-submit-pass-1';
      const PASS_2 = 'fake-timeout-pass-2';
      const PASS_3 = 'fake-bothfail-pass-3';
      const PASS_4 = 'fake-bad2xx-pass-4';
      const PASS_5 = 'fake-invalid-pass-5';

      const papersMap = new Map([
        [DOI_NET, makePaper(DOI_NET, 'Network drop then job active', 'pending')],
        [DOI_TIMEOUT, makePaper(DOI_TIMEOUT, 'Timeout then confirmed unsubmitted', 'pending')],
        [DOI_BOTHFAIL, makePaper(DOI_BOTHFAIL, 'Both POST and lookup fail then recover', 'pending')],
        [DOI_BAD2XX, makePaper(DOI_BAD2XX, 'Unconfirmable 2xx JSON response', 'pending')],
        [DOI_INVALID, makePaper(DOI_INVALID, 'Explicit passphrase error', 'pending')]
      ]);
      const jobsMap = new Map();

      let postPlan = {}; // doi -> 'abort' | 'timeout' | '502' | 'bad2xx' | 'invalid' | 'ok'
      let lookupPlan = {}; // doi -> 'normal' | 'fail500' | { hold: Promise }
      let doiLookupGets = 0;

      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => consoleLines.push(m.text()));
      await page.addInitScript(() => {
        const origSetTimeout = window.setTimeout.bind(window);
        window.__shortSubmitTimeout = false;
        window.setTimeout = (fn, ms, ...args) => origSetTimeout(fn, (window.__shortSubmitTimeout && ms === 45000) ? 120 : ms, ...args);
      });

      await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        requests.push({ url: req.url(), method: req.method() });
        if (u.origin === 'https://www.ebi.ac.uk') return route.fulfill({ json: { hitCount: 0, resultList: { result: [] } } });
        if (u.origin !== origin) { errors.push('Unexpected origin ' + u.origin); return route.abort(); }

        if (u.pathname === '/api/ai' && u.searchParams.get('task') === 'status') {
          return route.fulfill({ json: { ok: true, canGenerate: false, pdfSignedLink: false } });
        }
        if (u.pathname === '/api/library') {
          if (u.searchParams.has('doi')) {
            doiLookupGets++;
            const doi = u.searchParams.get('doi');
            const plan = lookupPlan[doi];
            if (plan && plan.hold) await plan.hold;
            if (plan === 'fail500' || (plan && plan.mode === 'fail500')) {
              return route.fulfill({ status: 500, contentType: 'text/html', body: '<html>lookup error</html>' });
            }
            const p = papersMap.get(doi);
            const job = jobsMap.get(doi);
            return route.fulfill({ json: { ok: true, found: !!p && p.fulltextStatus === 'available', ...(p && p.fulltextStatus === 'available' ? { paper: p, status: p.fulltextStatus } : {}), ...(job ? { job } : {}) } });
          }
          return route.fulfill({ json: { ok: true, papers: [...papersMap.values()], jobs: [...jobsMap.values()] } });
        }
        if (u.pathname === '/api/acquire' && req.method() === 'POST') {
          const doi = u.searchParams.get('doi');
          posts.push({ doi, body: req.postData() });
          const mode = postPlan[doi] || 'ok';
          if (mode === 'abort') {
            jobsMap.set(doi, { id: '00000000-0000-4000-8000-000000000101', doi, state: 'queued', stage: 'queued' });
            return route.abort();
          }
          if (mode === 'timeout') {
            await new Promise(resolve => hungReleases.push(resolve));
            try { return await route.abort(); } catch (e) { return; }
          }
          if (mode === '502') {
            return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>bad gateway</html>' });
          }
          if (mode === 'bad2xx') {
            return route.fulfill({ status: 200, contentType: 'text/plain', body: 'not-valid-json' });
          }
          if (mode === 'invalid') {
            return route.fulfill({ status: 403, json: { ok: false, error: 'pdf_passphrase_invalid' } });
          }
          const job = { id: '00000000-0000-4000-8000-000000000102', doi, state: 'queued', stage: 'queued' };
          jobsMap.set(doi, job);
          return route.fulfill({ status: 202, json: { ok: true, job } });
        }
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });

        const assets = {
          '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [] }),
          '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [], jn: [], pub: [], tier: [], design: [], tag: [] }),
          '/data/curated.js': 'window.CURATED=[]',
          '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
          '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [] })
        };
        if (assets[u.pathname]) return route.fulfill({ body: assets[u.pathname], contentType: 'application/javascript' });
        const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
        if (['index.html', 'app.js', 'citation-export.js', 'style.css', 'icon.png'].includes(file)) {
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' });
        }
        return route.fulfill({ status: 404, body: '' });
      });

      const statusRes = page.waitForResponse(r => r.url().includes('task=status'));
      await page.goto(origin + LIST_URL);
      await statusRes;
      await page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_NET) + '"]').waitFor();
      await page.waitForTimeout(100);

      // 1a. POST 网络中断 -> GET 状态查询返回「有任务」
      {
        const card = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_NET) + '"]');
        let releaseLookup;
        lookupPlan[DOI_NET] = { hold: new Promise(r => { releaseLookup = r; }) };
        postPlan[DOI_NET] = 'abort';
        await card.locator('[data-ft-action="open-form"]').click();
        await card.locator('form[data-ft-form] input[name="passphrase"]').fill(PASS_1);
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '不确定是否已提交，正在核对状态…' }).waitFor();
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), true, '核对期间提交按钮保持禁用');
        releaseLookup();
        delete lookupPlan[DOI_NET];
        await card.locator('.ft-status.ft-queued').waitFor();
        assert.equal(await card.locator('form[data-ft-form]').count(), 0, '查到任务后不再提供重复提交表单');
        assert.equal(await card.locator('button[type="submit"]').count(), 0);
        assert.equal(posts.filter(p => p.doi === DOI_NET).length, 1, '断网后查到任务只发过一次 POST');
      }

      // 1b. POST 超时 (AbortError) -> GET 确认无任务 -> 允许重试并成功
      {
        const card = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_TIMEOUT) + '"]');
        await page.evaluate(() => { window.__shortSubmitTimeout = true; });
        postPlan[DOI_TIMEOUT] = 'timeout';
        await card.locator('[data-ft-action="open-form"]').click();
        await card.locator('form[data-ft-form] input[name="passphrase"]').fill(PASS_2);
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '核对后确认没有提交上，可以重试' }).waitFor();
        while (hungReleases.length) hungReleases.shift()();
        await page.waitForTimeout(20);
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), false, '确认没提交上后按钮恢复可点');
        assert.equal(await card.locator('form[data-ft-form] input[name="passphrase"]').inputValue(), PASS_2, '口令保留以便重试');
        assert.equal(posts.filter(p => p.doi === DOI_TIMEOUT).length, 1);
        await page.evaluate(() => { window.__shortSubmitTimeout = false; });
        postPlan[DOI_TIMEOUT] = 'ok';
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('.ft-status.ft-queued').waitFor();
        assert.equal(posts.filter(p => p.doi === DOI_TIMEOUT).length, 2, '确认未提交上后重试发出第二次 POST');
      }

      // 1c. POST 502 + GET 状态查询也失败 -> 保持禁用，禁发第二次 POST，可点「刷新状态」恢复
      {
        const card = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_BOTHFAIL) + '"]');
        postPlan[DOI_BOTHFAIL] = '502';
        lookupPlan[DOI_BOTHFAIL] = 'fail500';
        await card.locator('[data-ft-action="open-form"]').click();
        await card.locator('form[data-ft-form] input[name="passphrase"]').fill(PASS_3);
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '仍无法确认是否已提交，请稍后再点“刷新状态”核对，先不要重复提交' }).waitFor();
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), true, '双重失败后提交按钮保持禁用');
        // 即使强行触发 requestSubmit 也不会发第二次 POST
        await page.evaluate(sel => document.querySelector(sel).requestSubmit(), '#articlesStream article[data-paper-id="' + paperId(DOI_BOTHFAIL) + '"] form[data-ft-form]');
        await page.waitForTimeout(80);
        assert.equal(posts.filter(p => p.doi === DOI_BOTHFAIL).length, 1, '无法确认状态时只发过一次 POST');
        const recheckBtn = card.locator('form[data-ft-form] [data-ft-action="refresh"]');
        await recheckBtn.waitFor();
        assert.equal(await recheckBtn.isDisabled(), false, '提供可点的刷新状态按钮');
        // 后端恢复后点「刷新状态」确认未提交上
        delete lookupPlan[DOI_BOTHFAIL];
        await recheckBtn.click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '核对后确认没有提交上，可以重试' }).waitFor();
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), false, '重新核对确认无任务后按钮恢复可点');
        assert.equal(posts.filter(p => p.doi === DOI_BOTHFAIL).length, 1);
      }

      // 1d. 2xx 但 JSON 无法确认 -> 同样走不确定核对分支
      {
        const card = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_BAD2XX) + '"]');
        postPlan[DOI_BAD2XX] = 'bad2xx';
        await card.locator('[data-ft-action="open-form"]').click();
        await card.locator('form[data-ft-form] input[name="passphrase"]').fill(PASS_4);
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '核对后确认没有提交上，可以重试' }).waitFor();
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), false);
      }

      // 1e. 明确业务错误码 (403 pdf_passphrase_invalid) -> 保持现有行为，不额外查状态
      {
        const card = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_INVALID) + '"]');
        postPlan[DOI_INVALID] = 'invalid';
        const lookupsBefore = doiLookupGets;
        await card.locator('[data-ft-action="open-form"]').click();
        await card.locator('form[data-ft-form] input[name="passphrase"]').fill(PASS_5);
        await card.locator('form[data-ft-form] button[type="submit"]').click();
        await card.locator('form[data-ft-form] .ft-error', { hasText: '全文口令不正确，请重新输入。' }).waitFor();
        assert.equal(await card.locator('form[data-ft-form] button[type="submit"]').isDisabled(), false);
        assert.equal(doiLookupGets, lookupsBefore, '明确业务错误码不触发不确定核对查询');
      }

      for (const resolve of hungReleases) resolve();
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, href: location.href }));
      for (const secret of [PASS_1, PASS_2, PASS_3, PASS_4, PASS_5]) {
        assert(!stored.includes(secret), '存储里没有口令');
        assert(!consoleLines.some(l => l.includes(secret)), 'console 里没有口令');
        assert(!requests.some(r => r.url.includes(secret)), 'URL 里没有口令');
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // =========================================================================
    // Part 2 & Part 3: 后台刷新不收起/不丢口令与焦点 + 60 秒 TTL 节流
    // =========================================================================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [], consoleLines = [], requests = [];

      const DOI_A = '10.1234/resil.carda';
      const DOI_B = '10.1234/resil.cardb';
      const DOI_READY1 = '10.1234/resil.ready1';
      const DOI_READY2 = '10.1234/resil.ready2';
      const DOI_PAGE2 = '10.1234/resil.page2';
      const DOI_ADDED_1 = '10.1234/resil.added1';
      const DOI_ADDED_2 = '10.1234/resil.added2';
      const DOI_ADDED_3 = '10.1234/resil.added3';

      const PASS_CARD = 'fake-typed-pass';
      const PASS_DL = 'fake-dl-typed-pass';
      const PASS_DRAWER = 'fake-drawer-typed-pass';

      let page1Papers = [
        makePaper(DOI_A, 'Card A pending form', 'pending'),
        makePaper(DOI_B, 'Card B untouched pending', 'pending'),
        makePaper(DOI_READY1, 'Ready card 1 for dl form', 'available'),
        makePaper(DOI_READY2, 'Ready card 2 untouched', 'available')
      ];
      const page2Papers = [makePaper(DOI_PAGE2, 'Page 2 supplemental paper', 'pending')];
      let listMode = 'paged'; // 'paged' | 'error500'
      let libraryListGets = 0;

      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => consoleLines.push(m.text()));
      await page.addInitScript(() => {
        window.__testOffsetMs = 0;
        const origNow = Date.now.bind(Date);
        Date.now = () => origNow() + window.__testOffsetMs;
      });

      await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        requests.push({ url: req.url(), method: req.method() });
        if (u.origin === 'https://www.ebi.ac.uk') return route.fulfill({ json: { hitCount: 0, resultList: { result: [] } } });
        if (u.origin !== origin) { errors.push('Unexpected origin ' + u.origin); return route.abort(); }

        if (u.pathname === '/api/ai' && u.searchParams.get('task') === 'status') {
          return route.fulfill({ json: { ok: true, canGenerate: false, pdfSignedLink: true } });
        }
        if (u.pathname === '/api/library') {
          if (u.searchParams.has('doi')) {
            const known = [...page1Papers, ...page2Papers].find(p => p.doi === u.searchParams.get('doi'));
            return route.fulfill({ json: known ? { ok: true, found: true, paper: known, status: known.fulltextStatus } : { ok: true, found: false } });
          }
          libraryListGets++;
          if (listMode === 'error500') {
            return route.fulfill({ status: 500, contentType: 'text/html', body: '<html>list unavailable</html>' });
          }
          const cursor = u.searchParams.get('cursor');
          if (!cursor) {
            return route.fulfill({ json: { ok: true, papers: page1Papers, jobs: [], cursor: 'page-2' } });
          }
          if (cursor === 'page-2') {
            return route.fulfill({ json: { ok: true, papers: page2Papers, jobs: [] } });
          }
          return route.fulfill({ json: { ok: true, papers: [], jobs: [] } });
        }
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });

        const assets = {
          '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [] }),
          '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [], jn: [], pub: [], tier: [], design: [], tag: [] }),
          '/data/curated.js': 'window.CURATED=[]',
          '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
          '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [] })
        };
        if (assets[u.pathname]) return route.fulfill({ body: assets[u.pathname], contentType: 'application/javascript' });
        const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
        if (['index.html', 'app.js', 'citation-export.js', 'style.css', 'icon.png'].includes(file)) {
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' });
        }
        return route.fulfill({ status: 404, body: '' });
      });

      const statusRes = page.waitForResponse(r => r.url().includes('task=status'));
      await page.goto(origin + LIST_URL);
      await statusRes;
      await page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_PAGE2) + '"]').waitFor();
      await page.waitForTimeout(100);

      // Part 3a: 首次加载只翻完 2 页（没有翻到 5 页）
      assert.equal(libraryListGets, 2, '首次加载只按游标翻完 2 页');

      // Part 3b: 60 秒内多次 focus / pageshow(persisted) / visibilitychange 不再翻页
      for (const advance of [0, 30000, 29000]) {
        if (advance) await page.evaluate(ms => { window.__testOffsetMs += ms; }, advance);
        await page.evaluate(() => {
          window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(80);
      }
      assert.equal(libraryListGets, 2, '60 秒内切回窗口不再翻页重拉补录列表');

      // Part 2a: 展开卡片 A 的「获取全文」表单、输入口令并聚焦，61 秒后触发后台刷新（带新数据）
      const cardA = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_A) + '"]');
      const cardB = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_B) + '"]');
      await cardA.locator('[data-ft-action="open-form"]').click();
      const inputA = cardA.locator('form[data-ft-form] input[name="passphrase"]');
      await inputA.fill(PASS_CARD);
      await page.evaluate(id => {
        const inp = document.querySelector('#articlesStream article[data-paper-id="' + id + '"] form[data-ft-form] input[name="passphrase"]');
        inp.focus();
        inp.setSelectionRange(4, 9);
      }, paperId(DOI_A));

      page1Papers = [...page1Papers, makePaper(DOI_ADDED_1, 'Added paper 1 after TTL focus', 'pending')];
      await page.evaluate(() => {
        window.__testOffsetMs += 2000; // 累计 61000ms > 60000ms
        window.dispatchEvent(new Event('focus'));
      });
      await page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_ADDED_1) + '"]').waitFor();
      assert.equal(libraryListGets, 4, '超过 60 秒 TTL 后 focus 恰好再拉一轮 2 页');
      assert.equal(await cardA.locator('form[data-ft-form]').isVisible(), true, '后台刷新后 Card A 表单仍展开');
      assert.equal(await inputA.inputValue(), PASS_CARD, '后台刷新后 Card A 已输入口令不丢失');
      const focusStateA = await page.evaluate(id => {
        const inp = document.querySelector('#articlesStream article[data-paper-id="' + id + '"] form[data-ft-form] input[name="passphrase"]');
        return { isActive: document.activeElement === inp, start: inp.selectionStart, end: inp.selectionEnd };
      }, paperId(DOI_A));
      assert.deepEqual(focusStateA, { isActive: true, start: 4, end: 9 }, 'Card A 口令框保持聚焦与光标选区');
      assert.equal(await cardB.locator('form[data-ft-form]').isVisible(), false, '另一篇卡片 B 表单仍保持收起');
      assert.equal(await cardB.locator('form[data-ft-form] input[name="passphrase"]').inputValue(), '', '另一篇卡片 B 不会串值');

      // 刚刷新完 60 秒内再发 focus 不再翻页
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(80);
      assert.equal(libraryListGets, 4);

      // Part 2b: 卡片内 dl 表单 (pdfSignedLink: true) 展开、输入、聚焦，后台刷新后保留且不串值
      const cardR1 = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_READY1) + '"]');
      const cardR2 = page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_READY2) + '"]');
      await cardR1.locator('a[data-ft-download]').click();
      const inputR1 = cardR1.locator('form[data-ft-dl-form] input[name="passphrase"]');
      await inputR1.fill(PASS_DL);
      page1Papers = [...page1Papers, makePaper(DOI_ADDED_2, 'Added paper 2 for dl snapshot', 'pending')];
      await page.evaluate(() => {
        window.__testOffsetMs += 61000;
        window.dispatchEvent(new Event('focus'));
      });
      await page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_ADDED_2) + '"]').waitFor();
      assert.equal(libraryListGets, 6);
      assert.equal(await cardR1.locator('form[data-ft-dl-form]').isVisible(), true, '后台刷新后卡片 dl 表单仍展开');
      assert.equal(await inputR1.inputValue(), PASS_DL, '后台刷新后卡片 dl 口令保留');
      assert.equal(await page.evaluate(id => {
        const inp = document.querySelector('#articlesStream article[data-paper-id="' + id + '"] form[data-ft-dl-form] input[name="passphrase"]');
        return document.activeElement === inp;
      }, paperId(DOI_READY1)), true, '卡片 dl 输入框保持 document.activeElement');
      assert.equal(await cardR2.locator('form[data-ft-dl-form]').isVisible(), false, '另一篇已可下载卡片不串值');
      assert.equal(await cardR2.locator('form[data-ft-dl-form] input[name="passphrase"]').inputValue(), '');

      // Part 2c: 阅读台 #drawerPdfForm 展开、输入、聚焦，后台刷新后保留
      await cardR1.locator('[data-action="open-drawer"]').first().click();
      await page.locator('#drawerPdfLink').waitFor();
      await page.locator('#drawerPdfLink').click();
      await page.locator('#drawerPdfForm').waitFor();
      const drawerInput = page.locator('#drawerPdfForm input[name="passphrase"]');
      await drawerInput.fill(PASS_DRAWER);
      page1Papers = [...page1Papers, makePaper(DOI_ADDED_3, 'Added paper 3 for drawer snapshot', 'pending')];
      await page.evaluate(() => {
        window.__testOffsetMs += 61000;
        window.dispatchEvent(new Event('focus'));
      });
      await page.locator('#articlesStream article[data-paper-id="' + paperId(DOI_ADDED_3) + '"]').waitFor();
      assert.equal(libraryListGets, 8);
      assert.equal(await page.locator('#drawerPdfForm').isVisible(), true, '后台刷新后阅读台 #drawerPdfForm 仍展开');
      assert.equal(await drawerInput.inputValue(), PASS_DRAWER, '后台刷新后阅读台口令保留');
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#drawerPdfForm input[name="passphrase"]')), true, '阅读台输入框保持聚焦');
      await page.locator('#drawerCloseBtn').click();

      // Part 3c: 用户点「刷新补录 / 重试加载 ([data-action="refresh-doi-library"])」不受 60s TTL 限制
      listMode = 'error500';
      await page.evaluate(() => {
        window.__testOffsetMs += 61000;
        window.dispatchEvent(new Event('focus'));
      });
      const retryBtn = page.locator('[data-action="refresh-doi-library"]');
      await retryBtn.waitFor();
      assert.equal(libraryListGets, 9);
      listMode = 'paged';
      // 刚失败更新了 refreshedAt（0ms 前），在 60s TTL 内直接点刷新按钮仍应强制请求
      await retryBtn.click();
      await page.locator('[data-action="refresh-doi-library"]').waitFor({ state: 'detached' });
      assert.equal(libraryListGets, 11, '手动点击刷新补录按钮不受 60s TTL 限制');

      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, href: location.href }));
      for (const secret of [PASS_CARD, PASS_DL, PASS_DRAWER]) {
        assert(!stored.includes(secret), '存储里没有口令');
        assert(!consoleLines.some(l => l.includes(secret)), 'console 里没有口令');
        assert(!requests.some(r => r.url.includes(secret)), 'URL 里没有口令');
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    console.log('Fulltext resilience UI checks passed (uncertain submit reconciliation, open form snapshot restore, 60s library TTL).');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
