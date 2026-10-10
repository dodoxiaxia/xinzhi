from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local/manual-work'
ASSETS = ROOT / 'docs/manual-assets'
OUT.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000}, device_scale_factor=1, color_scheme='light', locale='zh-CN')
    context.set_default_timeout(7000)
    errors = []
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    def route(r):
        if '/api/' in r.request.url:
            r.fulfill(status=200, content_type='application/json', body=json.dumps({'ok':True,'found':False,'canGenerate':False}))
        elif not r.request.url.startswith('http://127.0.0.1:8768/'):
            r.abort()
        else:
            r.continue_()
    context.route('**/*', route)
    def shot(page, name):
        page.wait_for_timeout(450)
        page.evaluate("""() => {document.querySelector('#toast')?.classList.remove('show');let x=document.querySelector('#manualPreviewLabel');if(!x){x=document.createElement('div');x.id='manualPreviewLabel';x.textContent='本地预览 · 非实时数据';x.style.cssText='position:fixed;bottom:10px;left:10px;z-index:99999;padding:5px 10px;background:#172c42;color:white;font:12px sans-serif;border-radius:4px;pointer-events:none';document.body.append(x)}}""")
        page.screenshot(path=str(ASSETS / name))
    page.goto('http://127.0.0.1:8768/?style=a&theme=light', wait_until='networkidle')
    page.locator('#articlesStream [data-action="open-drawer"]').first.wait_for()
    shot(page, '01-home.png')
    data = {'preview':'source UI with existing public data', 'api':'GET availability stubbed off; no generated results or model calls', 'curated_count':page.locator('#curatedCountBadge').inner_text()}
    page.locator('#articlesStream [data-action="open-drawer"]').first.click()
    shot(page, '03-reader.png')
    page.keyboard.press('Escape')
    page.locator('[data-mode="candidates"]').first.click()
    shot(page, '02-radar.png')
    data['ranges'] = [x.inner_text() for x in page.locator('#rangeBar [data-range]').all()]
    page.locator('#globalSearch').fill('房颤消融')
    page.wait_for_timeout(300)
    data['search_房颤消融'] = page.locator('#activeFiltersBar').inner_text()
    page.locator('#globalSearch').fill('')
    page.wait_for_timeout(300)
    page.locator('#articlesStream [data-action="toggle-huddle"]').nth(0).click()
    page.locator('#articlesStream [data-action="toggle-huddle"]').nth(1).click()
    page.locator('#openHuddleBtn').click()
    shot(page, '04-huddle.png')
    data['huddle_count'] = page.locator('#huddleCounter').inner_text()
    with page.expect_download() as download_info:
        page.locator('#exportHuddleMdBtn').click()
    download = download_info.value
    download.save_as(str(OUT / 'sample-huddle.md'))
    data['export_filename'] = download.suggested_filename
    page.keyboard.press('Escape')
    page.locator('[data-mode="weekly"]').first.click()
    shot(page, '05-weekly.png')
    page.locator('#sourceStatusBtn').click()
    data['source_cards'] = page.locator('#sourcesHealthGrid .source-item').count()
    mobile = context.new_page()
    mobile.set_viewport_size({'width':390,'height':844})
    mobile.goto('http://127.0.0.1:8768/?mode=candidates&style=a&theme=light', wait_until='networkidle')
    mobile.locator('#filterToggleBtn').click()
    shot(mobile, '06-mobile-filter.png')
    data['errors'] = errors
    (OUT / 'ui-verification.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(json.dumps(data, ensure_ascii=False))
    browser.close()
