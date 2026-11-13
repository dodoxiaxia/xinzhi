'use strict';
// 离线浏览器测试：文献雷达页手机快捷条只能横滑（整页 scrollY 不变），
// 且「心血管+AI · 近 14 天」标签不压住快捷条上的按钮。
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://mobile-chipbar.invalid';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const hourAgo = new Date(Date.now() - 3600e3).toISOString();
const sizes = [[390, 844], [344, 882], [430, 932]];
const journals = [
  ['The Lancet', 'Lancet'],
  ['Circulation', 'AHA'],
  ['Heart Rhythm', 'Elsevier'],
  ['NEJM AI', 'NEJM'],
  ['Some Regional Cardiology Journal', 'Other']
];
const papers = Array.from({ length: 40 }, (_, i) => {
  const [journal, publisher] = journals[i % journals.length];
  return {
    id: 'p' + i, pmid: String(800000 + i), doi: '10.1001/chip.' + i,
    title: 'Probe paper ' + i + ' on heart failure and machine learning',
    date: today, datePrecision: 'day', journal, cleanJournal: journal, publisher,
    clinicalTier: '心血管综合与其他', tags: ['#心律'], studyDesign: 'RCT', kind: '原始研究',
    summary: 'A reasonably long abstract so the card has body text for scrolling. '.repeat(8)
  };
});
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers, pdfIds: [] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: hourAgo, items: papers }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[{name:"Circulation",status:"ok",items:2}]}',
  '/data/curated.js': 'window.CURATED=[]',
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};
const files = {
  '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/journal-metrics.js': ['journal-metrics.js', 'application/javascript'],
  '/journal-tiers.js': ['journal-tiers.js', 'application/javascript'],
  '/citation-export.js': ['citation-export.js', 'application/javascript'],
  '/app.js': ['app.js', 'application/javascript'],
  '/demo-reading.html': ['demo-reading.html', 'text/html'],
  '/icon.png': ['icon.png', 'image/png']
};

async function swipeChipRow(page, startX, startY, dx, jitter) {
  const session = await page.context().newCDPSession(page);
  const point = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 2, radiusY: 2, id: 0, force: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(startX, startY) });
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(startX + dx * (i / steps), startY + jitter[i % jitter.length])
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function openRadar(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    assert.strictEqual(u.origin, origin, 'No external requests: ' + u.href);
    assert(['GET', 'HEAD'].includes(route.request().method()), 'Read-only requests only');
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    if (scripts[u.pathname]) return route.fulfill({ body: scripts[u.pathname], contentType: 'application/javascript' });
    if (files[u.pathname]) return route.fulfill({ body: fs.readFileSync(path.join(root, files[u.pathname][0])), contentType: files[u.pathname][1] });
    throw Error('Unexpected offline request ' + u.href);
  });
  await page.goto(origin + '/?mode=candidates', { waitUntil: 'load' });
  await page.waitForSelector('#qfChipRow .qf-chip');
  await page.waitForSelector('#qfScopeBtn:not([hidden])');
  return { page, errors, context };
}

async function testSize(browser, width, height) {
  const label = width + 'x' + height;
  const { page, errors, context } = await openRadar(browser, width, height);
  try {
    const css = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#qfChipRow'));
      return { overflowX: cs.overflowX, overflowY: cs.overflowY, touchAction: cs.touchAction, overscrollX: cs.overscrollBehaviorX };
    });
    assert.strictEqual(css.overflowX, 'auto', label + ': overflow-x:auto ' + JSON.stringify(css));
    assert.strictEqual(css.overflowY, 'hidden', label + ': overflow-y:hidden ' + JSON.stringify(css));
    assert.ok(/\bpan-x\b/.test(css.touchAction) && !/\bpan-y\b/.test(css.touchAction), label + ': touch-action:pan-x ' + JSON.stringify(css));
    assert.strictEqual(css.overscrollX, 'contain', label + ': overscroll-behavior-x:contain ' + JSON.stringify(css));

    const layout = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
      const scope = document.querySelector('#qfScopeBtn');
      const row = document.querySelector('#qfChipRow');
      const bar = document.querySelector('#quickBar');
      const chips = [...row.querySelectorAll('button, .qf-split')];
      const sb = box(scope), rb = box(row), bb = box(bar);
      const overlaps = [];
      const intersects = (a, b) => a.x < b.right - 0.5 && a.right > b.x + 0.5 && a.y < b.bottom - 0.5 && a.bottom > b.y + 0.5;
      chips.forEach(ch => {
        const cb = box(ch);
        const samples = [
          [cb.x + 2, cb.y + cb.h / 2],
          [cb.x + cb.w / 4, cb.y + cb.h / 2],
          [cb.x + cb.w / 2, cb.y + cb.h / 2],
          [cb.x + 2, cb.y + 2],
          [cb.x + 2, cb.bottom - 2]
        ];
        const hits = samples.map(([x, y]) => {
          const top = document.elementFromPoint(x, y);
          const onScope = !!(top && (top.id === 'qfScopeBtn' || (top.closest && top.closest('#qfScopeBtn'))));
          return { x, y, onScope, id: top && (top.id || top.className) };
        });
        if (intersects(sb, cb) || hits.some(h => h.onScope)) overlaps.push({ text: (ch.innerText || ch.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), box: cb, hits });
      });
      return {
        scope: sb, row: rb, bar: bb, scopeText: (scope.innerText || '').trim(),
        scopeOverflow: scope.scrollWidth > scope.clientWidth + 1,
        sameRow: Math.abs(sb.y - rb.y) < 8,
        rowFlushLeft: Math.abs(rb.x - bb.x) <= 2,
        overlaps
      };
    });
    assert.ok(layout.scopeText.includes('心血管+AI') && layout.scopeText.includes('近 14 天'), label + ': 标签文案 ' + layout.scopeText);
    assert.deepStrictEqual(layout.overlaps, [], label + ': 标签压住了快捷条按钮 ' + JSON.stringify(layout.overlaps));
    assert.strictEqual(layout.scopeOverflow, false, label + ': 标签文字溢出自己的盒子，可能画到按钮上');
    // 标签进流式布局，快捷条独占一行，左侧按钮不再和标签抢同一行的位置。
    assert.ok(!layout.sameRow || layout.rowFlushLeft, label + ': 标签未给快捷条留出位置 ' + JSON.stringify({ sameRow: layout.sameRow, rowFlushLeft: layout.rowFlushLeft, scope: layout.scope, row: layout.row, bar: layout.bar }));
    assert.ok(layout.rowFlushLeft, label + ': 快捷条应从工具行左缘起排 ' + JSON.stringify(layout));

    const before = await page.evaluate(() => {
      const row = document.querySelector('#qfChipRow');
      const r = row.getBoundingClientRect();
      const maxLeft = row.scrollWidth - row.clientWidth;
      return {
        y: window.scrollY,
        left: row.scrollLeft,
        maxLeft,
        canScroll: maxLeft > 2,
        x: r.left + Math.min(180, r.width - 20),
        cy: r.top + r.height / 2
      };
    });
    assert.ok(before.canScroll, label + ': 快捷条应超出一屏，才能测横滑 ' + JSON.stringify(before));
    await swipeChipRow(page, before.x, before.cy, -180, [0, -10, 8, -12, 6, -14, 10, -8, 12, -10, 0, -6, 8, -12, 6, 0]);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ y: window.scrollY, left: document.querySelector('#qfChipRow').scrollLeft }));
    assert.ok(Math.abs(after.y - before.y) <= 1, label + ': 横滑时整页 scrollY 应变 ' + JSON.stringify({ before, after }));
    const moved = after.left - before.left;
    const expect = Math.min(8, before.maxLeft - 1);
    assert.ok(moved >= expect, label + ': 横滑后快捷条 scrollLeft 应增加 ' + JSON.stringify({ before, after, moved, expect }));
    assert.deepStrictEqual(errors, [], label + ': page errors ' + errors.join('; '));
  } finally {
    await context.close();
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  try {
    for (const [width, height] of sizes) await testSize(browser, width, height);
    console.log('mobile chipbar UI checks passed');
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
