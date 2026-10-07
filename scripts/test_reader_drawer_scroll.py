"""Standalone offline Chromium regression: pass built/saved public directory and --fixed.

All external/API requests intercepted; no shared writes/model POST.
"""
if __name__ == "__main__":
    import functools,json,sys,threading
    from pathlib import Path
    from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
    from playwright.sync_api import sync_playwright,expect
    root=Path(sys.argv[1]);public=root/'public' if (root/'public').exists() else root
    fixed='--fixed' in sys.argv;out=root.parent/('qa-'+root.name+'-scroll');out.mkdir(exist_ok=True)
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(public)))
    threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/';records=[];posts=[];errors=[]
    def route(r):
        if '/api/' in r.request.url:
            if r.request.method=='POST':posts.append(r.request.url);return r.abort()
            return r.fulfill(json={'ok':True,'found':False,'canGenerate':False,'papers':[]})
        if not r.request.url.startswith(base):return r.abort()
        return r.continue_()
    try:
     with sync_playwright() as p:
      browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
      for width in [320,390,768,1440]:
       c=browser.new_context(viewport={'width':width,'height':950},is_mobile=width<500,has_touch=width<500);c.route('**/*',route)
       page=c.new_page();page.set_default_timeout(20000);page.on('pageerror',lambda e:errors.append(str(e)))
       page.goto(base+'?mode=weekly&view=compact',wait_until='networkidle')
       ids=page.evaluate("['10.1093/ehjcvp/pvag089','10.1016/j.hrthm.2026.09.051'].map(d=>FEEDS.items.find(p=>p.doi===d).id)")
       trigger=page.locator(f'[data-action="open-drawer"][data-paper-id="{ids[0]}"]:visible').first
       trigger.click(no_wait_after=True);expect(page.locator('.reader-drawer.open')).to_be_visible()
       jump=page.locator('[data-action="abstract-jump"][data-column="translation"]')
       if jump.is_visible():jump.click(no_wait_after=True)
       # At desktop the columns align; also test explicit reading position.
       page.locator('#drawerBody').evaluate('(e)=>{e.scrollTop=Math.min(900,e.scrollHeight-e.clientHeight)}')
       old=page.locator('#drawerBody').evaluate('(e)=>e.scrollTop');assert old>100
       list_position=page.evaluate('scrollY')
       page.locator('#drawerHuddleToggleBtn').click(no_wait_after=True)
       same=page.locator('#drawerBody').evaluate('(e)=>e.scrollTop')
       assert abs(same-old)<=1,(width,old,same)
       page.locator('#drawerCloseBtn').click(no_wait_after=True)
       assert abs(page.evaluate('scrollY')-list_position)<=1
       focus_restored=page.evaluate('(id)=>document.activeElement.dataset.paperId===id',ids[0])
       if fixed:assert focus_restored
       page.locator(f'[data-action="open-drawer"][data-paper-id="{ids[1]}"]:visible').first.click(no_wait_after=True)
       new=page.locator('#drawerBody').evaluate('(e)=>e.scrollTop')
       if fixed:assert new<=1,(width,new);assert page.evaluate('document.activeElement.id==="drawerCloseBtn"')
       else:assert new>100,(width,new)
       assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
       records.append({'width':width,'previousArticleScroll':old,'sameArticleScroll':same,'newArticleScroll':new,'listPositionRestored':True,'openerFocusRestored':focus_restored,'noOverflow':True});c.close()
      browser.close()
     assert not posts and not errors,(posts,errors)
     report={'fixedExpected':fixed,'scope':'Offline Chromium using exact public files; external requests intercepted','records':records,'posts':posts,'pageErrors':errors};(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
    finally:server.shutdown()
