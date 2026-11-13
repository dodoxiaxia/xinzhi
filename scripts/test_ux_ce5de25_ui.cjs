'use strict';
// 离线浏览器测试（不访问外网，不调用模型）：ce5de25 上线后体验复核的四项修复。
//  1 摘要拉取中：速览和结构区显示「正在获取摘要…」，确认没有摘要（为空或失败）后才显示「暂无公开摘要」
//  2 近7天榜快捷条有「AI」档，口径与榜内分类条的 AI 医疗 / AI 前沿一致
//  3 390 宽快捷条右侧渐隐（滚到尽头去掉），换栏目时横向滚动位置归零
//  4 摘要只有结论段时显示「摘要可能不完整」，完整摘要不显示
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://ux-ce5de25.invalid';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const hourAgo = new Date(Date.now() - 3600e3).toISOString();
const base = (id, extra) => Object.assign({ id, pmid: String(900000 + Number(String(id).replace(/\D/g, '') || 0)), doi: '10.1001/ux.' + id, title: 'Fixture paper ' + id,
  date: today, datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管综合与其他', tags: ['#心律'], studyDesign: 'RCT', kind: '原始研究' }, extra || {});
const full = [{ label: 'Background', text: 'Background text.' }, { label: 'Methods', text: 'Methods text.' }, { label: 'Results', text: 'Results text.' }, { label: 'Conclusions', text: 'Conclusion text.' }];
const tierJournals = ['The Lancet', 'Circulation', 'Heart Rhythm', 'NEJM AI', 'Some Regional Cardiology Journal'];
const radar = [
  // 摘要拉取：没有 summary / 分段，需要去 Europe PMC 拉
  base('fetch1'), base('fetch2'), base('fetch3'),
  // 摘要完整度
  base('full', { abstractSections: full }),
  base('concl-only', { abstractSections: [{ label: 'CONCLUSIONS', text: 'These findings support the approach.' }] }),
  base('summary-concl', { summary: 'CONCLUSION: Community pharmacies have a critical role in access to screenings.' }),
  base('summary-plain', { summary: 'We enrolled 400 adults and measured blood pressure at 12 weeks; the mean difference was small.' }),
  ...tierJournals.map((j, i) => base('tier' + i, { journal: j, cleanJournal: j, summary: 'A normal long abstract about ' + j + '.' }))
];
const weekly = [
  base('w-cardio', { weeklyPick: 1, weeklyCategory: 'cardio', weeklyAt: hourAgo, journal: 'Circulation', cleanJournal: 'Circulation', summary: 'Cardio weekly.' }),
  base('w-general', { weeklyPick: 2, weeklyCategory: 'general', weeklyAt: hourAgo, journal: 'JAMA', cleanJournal: 'JAMA', summary: 'General weekly.' }),
  base('w-aimed', { weeklyPick: 3, weeklyCategory: 'aimed', weeklyAt: hourAgo, journal: 'JACC: Advances', cleanJournal: 'JACC: Advances', summary: 'AI medical weekly.' }),
  base('w-aitech', { weeklyPick: 4, weeklyCategory: 'aitech', weeklyAt: hourAgo, journal: 'Nature Communications', cleanJournal: 'Nature Communications', summary: 'AI frontier weekly.' }),
  // AI 期刊名单里的刊但被榜单分到心血管：按分类条口径，不在 AI 档里
  base('w-aijournal-cardio', { weeklyPick: 5, weeklyCategory: 'cardio', weeklyAt: hourAgo, journal: 'npj Digital Medicine', cleanJournal: 'npj Digital Medicine', summary: 'Cardio-ranked AI journal.' })
];
const feedItems = radar.concat(weekly);
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: radar, pdfIds: [] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: hourAgo, items: feedItems }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[{name:"Circulation",status:"ok",items:2}]}',
  '/data/curated.js': 'window.CURATED=[]',
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'],
  '/journal-metrics.js': ['journal-metrics.js', 'application/javascript'], '/journal-tiers.js': ['journal-tiers.js', 'application/javascript'],
  '/citation-export.js': ['citation-export.js', 'application/javascript'], '/app.js': ['app.js', 'application/javascript'],
  '/demo-reading.html': ['demo-reading.html', 'text/html'], '/icon.png': ['icon.png', 'image/png'] };

let gate; // Europe PMC 响应由测试放行
async function newPage(browser, width, epmc) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === 'www.ebi.ac.uk') {
      assert(u.pathname.startsWith('/europepmc/webservices/rest/search'), 'only the abstract search endpoint');
      await gate;
      return epmc(route);
    }
    assert.strictEqual(u.origin, origin, 'No external requests: ' + u.href);
    assert(['GET', 'HEAD'].includes(req.method()), 'Read-only requests only');
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: true } });
    if (scripts[u.pathname]) return route.fulfill({ body: scripts[u.pathname], contentType: 'application/javascript' });
    if (files[u.pathname]) return route.fulfill({ body: fs.readFileSync(path.join(root, files[u.pathname][0])), contentType: files[u.pathname][1] });
    throw Error('Unexpected offline request ' + u.href);
  });
  return { page, errors, context };
}
const NO_ABS = '暂无公开摘要';
async function openPaper(page, id) {
  await page.evaluate(id => { const b = document.querySelector('[data-action="open-drawer"][data-paper-id="' + id + '"]'); if (!b) throw Error('no card for ' + id); b.click(); }, id);
  await page.waitForSelector('#readerDrawer.open');
}
const drawerText = page => page.locator('#drawerBody').innerText();

// ---- 1 摘要拉取中 ----
async function testAbstractFetching(browser) {
  const cases = [
    ['empty', 'fetch1', route => route.fulfill({ json: { resultList: { result: [] } } }), true],
    ['failed', 'fetch2', route => route.fulfill({ status: 500, body: 'x' }), true],
    ['has-abstract', 'fetch3', route => route.fulfill({ json: { resultList: { result: [{ pmid: '1', abstractText: '<h4>Background</h4>Bg.<h4>Conclusions</h4>Concl.' }] } } }), false]
  ];
  for (const [name, id, epmc, expectNone] of cases) {
    let release; gate = new Promise(r => { release = r; });
    const { page, errors, context } = await newPage(browser, 1280, epmc);
    await page.goto(origin + '/?mode=candidates&range=all', { waitUntil: 'load' });
    await page.waitForSelector('[data-action="open-drawer"][data-paper-id="' + id + '"]');
    await openPaper(page, id);
    await page.waitForTimeout(400); // 让 /api/ql、/api/ai 的只读查询先完成：旧版本这时会抢跑写「暂无公开摘要」
    const pending = await drawerText(page);
    assert(pending.includes('正在获取摘要…'), name + ': 拉取期间应显示「正在获取摘要…」\n' + pending);
    assert(!pending.includes(NO_ABS), name + ': 拉取期间不能写「暂无公开摘要」\n' + pending);
    assert(!pending.includes('一键生成 AI 速览') && !pending.includes('提取研究结构与核对清单'), name + ': 拉取期间不出生成按钮');
    assert(await page.locator('#drawerBody .quicklook:has-text("正在获取摘要…")').count() === 1, name + ': 速览区显示拉取中');
    assert(await page.locator('#drawerBody .study-box:has-text("正在获取摘要…")').count() === 1, name + ': 结构区显示拉取中');
    release();
    await page.waitForFunction(() => !document.querySelector('#drawerBody .quicklook')?.textContent.includes('正在获取摘要…'));
    await page.waitForTimeout(200);
    const done = await drawerText(page);
    assert(!done.includes('正在获取摘要…'), name + ': 完成后不再显示拉取中');
    if (expectNone) {
      assert(await page.locator('#drawerBody .quicklook:has-text("暂无公开摘要，无法生成 AI 速览")').count() === 1, name + ': 速览区确认无摘要后才提示\n' + done);
      assert(await page.locator('#drawerBody .study-box:has-text("暂无公开摘要，无法提取研究结构")').count() === 1, name + ': 结构区确认无摘要后才提示');
      assert(!done.includes('一键生成 AI 速览'), name + ': 没有摘要仍不出生成按钮');
    } else {
      assert(!done.includes('暂无公开摘要，无法'), name + ': 摘要到了不再写暂无公开摘要\n' + done);
      assert(done.includes('一键生成 AI 速览'), name + ': 摘要到了后出现生成按钮\n' + done);
    }
    assert.deepStrictEqual(errors, [], name + ' 页面无脚本错误');
    await context.close();
  }
  console.log('PASS 1 摘要拉取中文案（空 / 失败 / 有摘要三种结果）');
}

// ---- 2 近7天榜 AI 档 ----
async function testWeeklyAiChip(browser, width) {
  gate = Promise.resolve();
  const { page, errors, context } = await newPage(browser, width, r => r.fulfill({ json: { resultList: { result: [] } } }));
  await page.goto(origin + '/?mode=weekly', { waitUntil: 'load' });
  await page.waitForSelector('.weekly-category-nav');
  const catCount = async () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-weekly-cat]')].map(b => [b.dataset.weeklyCat || 'all', +b.querySelector('span').textContent])));
  assert.deepStrictEqual(await catCount(), { all: 5, cardio: 2, general: 1, aimed: 1, aitech: 1 }, width + ': 起始分类数');
  const ai = page.locator('#qfChipRow [data-qf-jtier="ai"]');
  assert.strictEqual(await ai.count(), 1, width + ': 近7天榜快捷条有 AI 档');
  assert.strictEqual((await ai.innerText()).trim(), 'AI');
  assert(/AI 医疗 \/ AI 前沿/.test(await ai.getAttribute('aria-label')), width + ': AI 档的名称对应分类条');
  assert.strictEqual(await page.locator('#qfChipRow [data-qf-jtier-menu="ai"]').count(), 0, width + ': 榜内 AI 档不带期刊名单');
  await ai.click();
  await page.waitForFunction(() => document.querySelector('#qfChipRow [data-qf-jtier="ai"]')?.getAttribute('aria-pressed') === 'true');
  assert.deepStrictEqual(await catCount(), { all: 2, cardio: 0, general: 0, aimed: 1, aitech: 1 }, width + ': AI 档只留下 AI 医疗 + AI 前沿（与分类条口径一致，不按期刊名单）');
  assert((await page.locator('#qfSummary').innerText()).includes('AI 医疗 / AI 前沿'), width + ': 已选条件的名称');
  await ai.click();
  await page.waitForFunction(() => document.querySelector('#qfChipRow [data-qf-jtier="ai"]')?.getAttribute('aria-pressed') === 'false');
  assert.strictEqual((await catCount()).all, 5, width + ': 再点一次取消筛选');
  // 其他栏目仍按 AI 期刊名单，且保留 ▾ 清单
  await page.locator('.nav-tab-btn[data-mode="candidates"]').click();
  await page.waitForSelector('#qfChipRow [data-qf-jtier-menu="ai"]');
  assert.strictEqual(await page.locator('#qfChipRow [data-qf-jtier-menu="ai"]').count(), 1, width + ': 雷达里 AI 档仍是期刊名单');
  assert.deepStrictEqual(errors, [], width + ' 页面无脚本错误');
  await context.close();
  console.log('PASS 2 近7天榜 AI 档 @' + width);
}

// ---- 3 390 宽快捷条渐隐和滚动归零 ----
async function testChipRowFade(browser) {
  gate = Promise.resolve();
  const { page, errors, context } = await newPage(browser, 390, r => r.fulfill({ json: { resultList: { result: [] } } }));
  await page.goto(origin + '/?mode=candidates&range=all', { waitUntil: 'load' });
  await page.waitForSelector('#qfChipRow .qf-chip');
  const m = () => page.evaluate(() => { const r = document.querySelector('#qfChipRow'); const cs = getComputedStyle(r);
    return { sw: r.scrollWidth, cw: r.clientWidth, left: r.scrollLeft, fade: r.classList.contains('qf-fade'), mask: cs.maskImage || cs.webkitMaskImage || '' }; });
  let s = await m();
  assert(s.sw > s.cw + 2, '390 宽时快捷条应超出一屏 ' + JSON.stringify(s));
  assert(s.fade && /linear-gradient/.test(s.mask), '没滚到尽头时右侧有渐隐 ' + JSON.stringify(s));
  await page.evaluate(() => { const r = document.querySelector('#qfChipRow'); r.scrollLeft = r.scrollWidth; });
  await page.waitForFunction(() => !document.querySelector('#qfChipRow').classList.contains('qf-fade'));
  s = await m();
  assert(!s.fade && (s.mask === 'none' || s.mask === ''), '滚到尽头后去掉渐隐 ' + JSON.stringify(s));
  const more = await page.evaluate(() => { const r = document.querySelector('#qfChipRow').getBoundingClientRect(), b = document.querySelector('#qfChipRow [data-qf="more"]').getBoundingClientRect(); return b.right <= r.right + 1 && b.left >= r.left; });
  assert(more, '滚到尽头后 ⋯ 完整可见');
  assert(s.left > 0, '已向右滚动');
  await page.locator('.nav-tab-btn[data-mode="library"]').click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('mode') === 'library');
  s = await m();
  assert.strictEqual(s.left, 0, '换栏目后快捷条滚动位置归零 ' + JSON.stringify(s));
  assert(s.fade || s.sw <= s.cw + 2, '换栏目后重新按位置判断渐隐 ' + JSON.stringify(s));
  // 窄屏下近7天榜：条目不多，不超出就不渐隐
  await page.locator('.nav-tab-btn[data-mode="weekly"]').click();
  await page.waitForSelector('.weekly-category-nav');
  s = await m();
  assert.strictEqual(s.left, 0, '切到近7天榜滚动位置为 0');
  assert.strictEqual(s.fade, s.sw > s.cw + 2, '近7天榜：只有超出时才渐隐 ' + JSON.stringify(s));
  assert.deepStrictEqual(errors, [], '页面无脚本错误');
  await context.close();
  console.log('PASS 3 快捷条右侧渐隐与滚动归零 @390');
}

// ---- 4 摘要可能不完整 ----
async function testIncompleteNote(browser) {
  gate = Promise.resolve();
  const { page, errors, context } = await newPage(browser, 1280, r => r.fulfill({ json: { resultList: { result: [] } } }));
  await page.goto(origin + '/?mode=candidates&range=all', { waitUntil: 'load' });
  await page.waitForSelector('[data-action="open-drawer"][data-paper-id="full"]');
  const expect = { full: false, 'concl-only': true, 'summary-concl': true, 'summary-plain': false, tier0: false };
  for (const [id, flagged] of Object.entries(expect)) {
    await openPaper(page, id);
    const n = await page.locator('#drawerBody .abs-incomplete-note').count();
    assert.strictEqual(n, flagged ? 1 : 0, id + ': 「摘要可能不完整」' + (flagged ? '应出现' : '不应出现'));
    if (flagged) assert.strictEqual((await page.locator('#drawerBody .abs-incomplete-note').innerText()).trim(), '摘要可能不完整');
    await page.evaluate(() => document.querySelector('#drawerCloseBtn').click());
    await page.waitForFunction(() => !document.querySelector('#readerDrawer.open'));
  }
  assert.deepStrictEqual(errors, [], '页面无脚本错误');
  await context.close();
  console.log('PASS 4 摘要可能不完整小字');
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    await testAbstractFetching(browser);
    for (const w of [390, 884, 1280]) await testWeeklyAiChip(browser, w);
    await testChipRowFade(browser);
    await testIncompleteNote(browser);
    console.log('ux ce5de25 browser tests passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
