'use strict';
// 卡片 / 阅读台内口令下载（服务端开关 pdfSignedLink）。离线浏览器测试：假后端 + 合成数据，不连任何真实服务、不用真实口令。
//   开关关闭 → 点「下载 PDF」照旧新开标签，不展开表单；
//   开关开启 → 原位展开口令框；错口令/限流/异常显示中文错误且口令保留；成功 → 按钮文字变化并由浏览器下载；
//   pdf_link_disabled → 退回新开标签；手机视口 390x844 下控件触控尺寸与不溢出。
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://dl-inline.invalid';
const DOI = '10.1234/inline.dl', ENC = encodeURIComponent(DOI);
const paperId = 'doi-' + crypto.createHash('sha256').update(DOI).digest('hex').slice(0, 16);
const paper = { id: paperId, doi: DOI, title: 'Inline download clinical title', journal: 'Nature Medicine', date: '2026-09-18', datePrecision: 'day',
  dateBasis: 'Crossref published-online', ingestedAt: '2026-10-07T08:00:00Z', metadataStatus: 'external_bibliography_checked', fulltextStatus: 'available' };
const WRONG = 'fake-wrong-pass-1', RIGHT = 'fake-right-pass-2';
const MIN_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const LIST_URL = '/?mode=library&lane=all&range=all&maintainer=0';
const FORM = 'form[data-ft-dl-form]:not([hidden])', ANY_FORM = 'form[data-ft-dl-form]';
const CARD_LINK = '#articlesStream [data-paper-id="' + paperId + '"] a[data-ft-download]';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
  const errors = [], consoleLines = [], requests = [], posts = [];
  let signed = true, postMode = 'ok', hold = null;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => consoleLines.push(m.text()));

  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    requests.push(req.url());
    if (u.origin === 'https://www.ebi.ac.uk') return route.fulfill({ json: { hitCount: 0, resultList: { result: [] } } });
    if (u.origin !== origin) { errors.push('Unexpected origin ' + u.origin); return route.abort(); }
    if (u.pathname === '/api/ai' && u.searchParams.get('task') === 'status') return route.fulfill({ json: { ok: true, canGenerate: false, pdfSignedLink: signed } });
    if (u.pathname === '/api/library') {
      if (u.searchParams.has('doi')) return route.fulfill({ json: { ok: true, found: true, paper, status: 'available' } });
      return route.fulfill({ json: { ok: true, papers: [paper], jobs: [] } });
    }
    if (u.pathname === '/api/fulltext') {
      if (req.method() === 'POST') {
        assert.equal(u.searchParams.get('link'), '1', 'the exchange request carries link=1');
        posts.push({ pathname: u.pathname, doi: u.searchParams.get('doi'), query: u.search, type: req.headers()['content-type'], accept: req.headers().accept, body: req.postData() });
        if (hold) await hold;
        if (postMode === 'abort') return route.abort();
        if (postMode === 'ok') return route.fulfill({ json: { ok: true, url: '/api/fulltext?doi=' + ENC + '&t=tok123', expiresIn: 300 } });
        if (postMode === 'invalid') return route.fulfill({ status: 403, json: { ok: false, error: 'pdf_passphrase_invalid' } });
        if (postMode === 'limited') return route.fulfill({ status: 429, json: { ok: false, error: 'pdf_rate_limited' } });
        if (postMode === 'disabled') return route.fulfill({ status: 404, json: { ok: false, error: 'pdf_link_disabled' } });
        if (postMode === 'garbage') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>bad gateway</html>' });
        if (postMode === 'badurl') return route.fulfill({ json: { ok: true, url: 'https://evil.invalid/x.pdf' } });
        return route.fulfill({ status: 500, json: { ok: false, error: 'something_else' } });
      }
      if (u.searchParams.get('t')) return route.fulfill({ status: 200, body: MIN_PDF, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="paper.pdf"', 'cache-control': 'private, no-store' } });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>server passphrase page</body></html>' });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    const assets = {
      '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [] }),
      '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [], jn: [], pub: [], tier: [], design: [], tag: [] }),
      '/data/curated.js': 'window.CURATED=[]', '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
      '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [] })
    };
    if (assets[u.pathname]) return route.fulfill({ body: assets[u.pathname], contentType: 'application/javascript' });
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (['index.html', 'app.js', 'journal-tiers.js', 'style.css', 'icon.png'].includes(file)) {
      return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  // 打开页面并等 /api/ai?task=status 返回，保证开关已读入再点击。
  async function open(url, ready) {
    const status = page.waitForResponse(r => r.url().includes('task=status'));
    await page.goto(origin + url);
    await status;
    await page.locator(ready || CARD_LINK).first().waitFor();
    await page.waitForTimeout(150);
  }
  const newTab = async trigger => {
    const [tab] = await Promise.all([context.waitForEvent('page'), trigger]);
    await tab.waitForURL(/\/api\/fulltext\?doi=/);
    return tab;
  };
  const formVisible = () => page.locator(ANY_FORM).first().isVisible();
  const submitText = () => page.locator(FORM + ' button[type="submit"]').innerText();
  const errorText = () => page.locator(FORM + ' .ft-error').innerText();
  async function expectError(message) {
    await page.locator(FORM + ' .ft-error', { hasText: message }).waitFor();
    assert.equal((await errorText()).trim(), message);
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').inputValue(), WRONG, '失败后口令保留在输入框');
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').isDisabled(), false);
    assert.equal(await page.locator(FORM + ' button[type="submit"]').isDisabled(), false);
    assert.equal((await submitText()).trim(), '下载');
  }
  async function failureCases() {
    const input = page.locator(FORM + ' input[name="passphrase"]'), submit = page.locator(FORM + ' button[type="submit"]');
    await input.fill(WRONG);
    for (const [mode, message] of [['invalid', '口令不正确，请重新输入。'], ['limited', '口令错误次数过多，请一小时后再试。'],
      ['abort', '网络异常，请稍后重试。'], ['garbage', '网络异常，请稍后重试。'], ['badurl', '暂时无法下载，请稍后重试，或到官网原文获取。'],
      ['other', '暂时无法下载，请稍后重试，或到官网原文获取。']]) {
      postMode = mode; await submit.click(); await expectError(message);
    }
  }

  try {
    // ---------- 1. 开关关闭：行为与原来一致 ----------
    signed = false;
    await open(LIST_URL);
    assert.equal(await page.locator(CARD_LINK).getAttribute('target'), '_blank');
    assert((await page.locator(CARD_LINK).getAttribute('rel')).includes('noopener'));
    assert.equal(await page.locator(CARD_LINK).getAttribute('href'), '/api/fulltext?doi=' + ENC);
    assert.equal(await formVisible(), false, '开关关闭时口令框保持隐藏');
    let tab = await newTab(page.locator(CARD_LINK).click());
    assert(tab.url().includes('/api/fulltext?doi=' + ENC), '新标签打开服务端口令页');
    await tab.close();
    assert.equal(await formVisible(), false, '开关关闭时点击不展开表单');
    assert.equal(posts.length, 0, '开关关闭时不发任何 POST');

    // ---------- 2. 开关开启：卡片内展开、错误、成功 ----------
    signed = true; postMode = 'invalid';
    await open(LIST_URL);
    const pagesBefore = context.pages().length;
    await page.locator(CARD_LINK).click();
    await page.locator(FORM).waitFor();
    assert.equal(context.pages().length, pagesBefore, '开关开启时不新开标签');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('name')), 'passphrase', '展开后聚焦口令输入框');
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').getAttribute('type'), 'password');
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').getAttribute('autocomplete'), 'current-password');
    assert.equal(await page.locator(FORM + ' .ft-error').getAttribute('role'), 'alert');
    await page.locator(CARD_LINK).click();
    await page.locator(ANY_FORM).first().waitFor({ state: 'hidden' });
    await page.locator(CARD_LINK).click();
    await page.locator(FORM).waitFor();
    // 表单在按钮下方换行显示，而不是挤在同一行
    const linkBox = await page.locator(CARD_LINK).boundingBox(), formBox = await page.locator(FORM).boundingBox();
    assert(formBox.y >= linkBox.y + linkBox.height - 1, '口令框在下载按钮下方');
    await failureCases();
    assert.equal(posts.length, 6);
    assert.deepEqual({ pathname: posts[0].pathname, doi: posts[0].doi, query: posts[0].query, body: posts[0].body }, { pathname: '/api/fulltext', doi: DOI, query: '?doi=' + ENC + '&link=1', body: 'passphrase=' + WRONG });
    assert(posts[0].type.includes('application/x-www-form-urlencoded')); assert(posts[0].accept.includes('application/json'));

    // 成功：提交中禁用并改字，防重复提交，换到链接后由浏览器自己下载
    postMode = 'ok';
    let release; hold = new Promise(r => { release = r; });
    const postsBefore = posts.length;
    const downloading = page.waitForEvent('download');
    await page.locator(FORM + ' input[name="passphrase"]').fill(RIGHT);
    await page.locator(FORM + ' button[type="submit"]').click();
    await page.waitForFunction(sel => { const b = document.querySelector(sel); return b && b.disabled && b.textContent === '正在验证口令…'; }, FORM + ' button[type="submit"]');
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').isDisabled(), true);
    await page.evaluate(sel => document.querySelector(sel).requestSubmit(), FORM);
    release(); hold = null;
    await page.waitForFunction(() => [...document.querySelectorAll('form[data-ft-dl-form] button[type="submit"]')].some(b => b.textContent === '正在取回 PDF…'));
    const download = await downloading;
    assert(download.url().includes('/api/fulltext?doi=' + ENC + '&t=tok123'));
    assert.equal(fs.readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-');
    assert.equal(posts.length, postsBefore + 1, '重复触发提交只发一次 POST');
    assert.equal(new URL(page.url()).pathname, '/', '下载不离开当前页');
    await page.getByText('已开始下载').first().waitFor();
    await page.locator(ANY_FORM).first().waitFor({ state: 'hidden' });
    await page.locator(CARD_LINK).click(); await page.locator(FORM).waitFor();
    assert.equal(await page.locator(FORM + ' input[name="passphrase"]').inputValue(), '', '成功后口令已清空');
    assert.equal((await submitText()).trim(), '下载'); assert.equal(await page.locator(FORM + ' button[type="submit"]').isDisabled(), false);
    assert.equal((await errorText()).trim(), '');

    // ---------- 3. pdf_link_disabled：退回新开标签 ----------
    postMode = 'disabled';
    await page.locator(FORM + ' input[name="passphrase"]').fill(WRONG);
    tab = await newTab(page.locator(FORM + ' button[type="submit"]').click());
    assert(tab.url().includes('/api/fulltext?doi=' + ENC) && !tab.url().includes('link=1') && !tab.url().includes(WRONG));
    await tab.close();
    await page.locator(ANY_FORM).first().waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ft-error:visible').count(), 0, '退回旧行为时不报错');
    tab = await newTab(page.locator(CARD_LINK).click());
    assert(tab.url().includes('/api/fulltext?doi=' + ENC), '开关被服务端关掉后，再点链接仍是新标签');
    await tab.close();
    assert.equal(await formVisible(), false);

    // ---------- 4. DOI 搜索视图（完整状态块）也有口令框 ----------
    postMode = 'invalid';
    await open('/?mode=library&lane=all&maintainer=0&q=' + encodeURIComponent(DOI), '.ft-status.ft-ready a[data-ft-download]');
    await page.locator('.ft-status.ft-ready a[data-ft-download]').click();
    await page.locator('.ft-status.ft-ready ' + FORM).waitFor();
    await page.locator(FORM + ' input[name="passphrase"]').fill(WRONG);
    await page.locator(FORM + ' button[type="submit"]').click();
    await expectError('口令不正确，请重新输入。');

    // ---------- 5. 阅读台 ----------
    await open(LIST_URL);
    await page.locator('#articlesStream [data-paper-id="' + paperId + '"] [data-action="open-drawer"]').first().click();
    await page.locator('#drawerPdfLink').waitFor();
    assert.equal(await page.locator('#drawerPdfLink').getAttribute('href'), '/api/fulltext?doi=' + ENC);
    assert.equal(await page.locator('#drawerPdfForm').isVisible(), false);
    await page.locator('#drawerPdfLink').click();
    await page.locator('#drawerPdfForm').waitFor();
    postMode = 'invalid';
    await page.locator('#drawerPdfForm input[name="passphrase"]').fill(WRONG);
    await page.locator('#drawerPdfForm button[type="submit"]').click();
    await page.locator('#drawerPdfForm .ft-error', { hasText: '口令不正确，请重新输入。' }).waitFor();
    postMode = 'ok';
    const drawerDownload = page.waitForEvent('download');
    await page.locator('#drawerPdfForm input[name="passphrase"]').fill(RIGHT);
    await page.locator('#drawerPdfForm button[type="submit"]').click();
    assert(((await drawerDownload).url()).includes('t=tok123'));
    await page.locator('#drawerPdfForm').waitFor({ state: 'hidden' });
    // 关闭再打开：表单收起、口令清空
    await page.locator('#drawerPdfLink').click(); await page.locator('#drawerPdfForm').waitFor();
    await page.locator('#drawerPdfForm input[name="passphrase"]').fill(WRONG);
    await page.locator('#drawerCloseBtn').click();
    await page.locator('#articlesStream [data-paper-id="' + paperId + '"] [data-action="open-drawer"]').first().click();
    await page.locator('#drawerPdfLink').waitFor();
    assert.equal(await page.locator('#drawerPdfForm input[name="passphrase"]').inputValue(), '', '重新打开阅读台不保留口令');
    await page.locator('#drawerCloseBtn').click();

    // ---------- 6. 手机视口 390x844 ----------
    await page.setViewportSize({ width: 390, height: 844 });
    const metrics = scope => page.evaluate(sel => {
      const form = document.querySelector(sel), box = e => e.getBoundingClientRect();
      const input = form.querySelector('input[name="passphrase"]'), button = form.querySelector('button[type="submit"]');
      return { inputH: box(input).height, inputRight: box(input).right, inputFont: parseFloat(getComputedStyle(input).fontSize), btnH: box(button).height, btnRight: box(button).right,
        scrollW: document.documentElement.scrollWidth, vw: window.innerWidth };
    }, scope);
    const fits = m => { assert(m.inputH >= 44, '输入框高度 ' + m.inputH); assert(m.btnH >= 44, '提交按钮高度 ' + m.btnH); assert(m.inputFont >= 16, '输入框字号 ' + m.inputFont);
      assert(m.inputRight <= m.vw + 0.5 && m.btnRight <= m.vw + 0.5, '控件不超出视口'); assert(m.scrollW <= m.vw + 1, '无横向溢出 ' + m.scrollW + '/' + m.vw); };
    await open(LIST_URL);
    assert((await page.locator(CARD_LINK).boundingBox()).height >= 44, '卡片下载按钮触控高度 ≥44');
    await page.locator(CARD_LINK).click(); await page.locator(FORM).waitFor();
    fits(await metrics(FORM));
    postMode = 'invalid';
    await page.locator(FORM + ' input[name="passphrase"]').fill(WRONG); await page.locator(FORM + ' button[type="submit"]').click();
    await expectError('口令不正确，请重新输入。');
    fits(await metrics(FORM));
    await page.locator('#articlesStream [data-paper-id="' + paperId + '"] [data-action="open-drawer"]').first().click();
    await page.locator('#drawerPdfLink').waitFor();
    assert((await page.locator('#drawerPdfLink').boundingBox()).height >= 44, '阅读台下载按钮触控高度 ≥44');
    await page.locator('#drawerPdfLink').click(); await page.locator('#drawerPdfForm').waitFor();
    fits(await metrics('#drawerPdfForm'));
    await page.locator('#drawerPdfForm input[name="passphrase"]').fill(WRONG); await page.locator('#drawerPdfForm button[type="submit"]').click();
    await page.locator('#drawerPdfForm .ft-error', { hasText: '口令不正确，请重新输入。' }).waitFor();
    fits(await metrics('#drawerPdfForm'));

    // ---------- 7. 口令不进 console / 存储 / URL ----------
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, href: location.href }));
    for (const secret of [WRONG, RIGHT]) {
      assert(!stored.includes(secret), '存储里没有口令');
      assert(!consoleLines.some(line => line.includes(secret)), 'console 里没有口令');
      assert(!requests.some(url => url.includes(secret)), 'URL 里没有口令');
    }
    assert.deepEqual(errors, []);
    console.log('Inline download UI checks passed (flag off, flag on, errors, success, link disabled, DOI view, drawer, 390px mobile, no credential leakage).');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
