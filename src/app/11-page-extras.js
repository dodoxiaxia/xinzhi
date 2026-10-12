// ==== src/app/11-page-extras.js · Standalone page helpers outside the main app scope ====

;(function () { /* 界面风格选择器:页眉按钮 + 菜单,记住读者的选择 */
  const STYLES = [
    ['a', '临床期刊', '白底蓝灰，盒状卡片，稳重专业', '#1b4f9c'],
    ['b', '资讯榜单', '编号列表，信息密度高，扫读最快', '#d13a1f'],
    ['c', '卡片杂志', '浅灰底大圆角卡片，轻松友好', '#0b8f7e'],
    ['d', '纸感', '米色纸张质感，安静耐读', '#9b2335']
  ];
  const BAR = { // 浏览器地址栏/状态栏颜色，跟随页眉，避免顶部出现突兀的色块
    light: { a: '#ffffff', b: '#d13a1f', c: '#ffffff', d: '#f5f2ea' },
    dark:  { a: '#141d2b', b: '#b8321a', c: '#1c2024', d: '#14120f' }
  };
  const root = document.documentElement;
  const get = () => { try { return localStorage.getItem('xz-style'); } catch (e) { return null; } };
  const put = v => { try { localStorage.setItem('xz-style', v); } catch (e) {} };
  const valid = v => STYLES.some(x => x[0] === v);
  function syncBar() {
    const m = document.querySelector('meta[name="theme-color"]'); if (!m) return;
    const t = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    if (window.XINZHI_BOOT) window.XINZHI_BOOT.apply(t, root.dataset.style);
    else m.setAttribute('content', BAR[t][root.dataset.style] || '#ffffff');
  }
  let st = window.XINZHI_BOOT ? window.XINZHI_BOOT.style : new URLSearchParams(location.search).get('style');
  if (!valid(st)) st = get();
  if (!valid(st)) st = 'a';
  root.dataset.style = st; put(st);
  new MutationObserver(syncBar).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  syncBar();

  const btn = document.getElementById('styleBtn'), menu = document.getElementById('styleMenu'), label = document.getElementById('styleBtnLabel');
  if (!btn || !menu) return;
  const name = k => (STYLES.find(x => x[0] === k) || [])[1] || '风格';
  function paint() {
    label.textContent = name(root.dataset.style);
    menu.innerHTML = '<div class="style-menu-head">选择你喜欢的界面风格</div>' + STYLES.map(([k, n, d, c]) =>
      `<button type="button" role="menuitemradio" class="style-opt" data-s="${k}" aria-checked="${k === root.dataset.style}">` +
      `<span class="style-swatch" style="background:${c}">${k.toUpperCase()}</span>` +
      `<span class="style-opt-text"><b>${n}</b><small>${d}</small></span>` +
      `<span class="style-opt-check">${k === root.dataset.style ? '✓' : ''}</span></button>`).join('');
  }
  function setOpen(o) {
    menu.hidden = !o; btn.setAttribute('aria-expanded', String(o));
    if (o) { paint(); (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.style-opt'))?.focus(); }
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(menu.hidden); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.style-opt'); if (!b) return;
    root.dataset.style = b.dataset.s; put(b.dataset.s); paint(); label.textContent = name(b.dataset.s);
    setOpen(false); btn.focus();
  });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#stylePicker')) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); } });
  label.textContent = name(root.dataset.style);
})();

;(function () {
  const button = document.getElementById('backToTopBtn');
  if (!button) return;
  const update = () => { button.hidden = window.scrollY < 600; };
  window.addEventListener('scroll', update, { passive: true });
  button.addEventListener('click', () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('brandLogo')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
  });
  update();
})();

;(function () { /* 页面开着时发现新版本就提示刷新；后台计划每 2 小时查新 */
  let tag = null, shown = false;
  async function probe() {
    if (shown || document.hidden) return;
    try {
      const r = await fetch('/?_=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      const t = r.headers.get('etag') || r.headers.get('last-modified'); if (!t) return;
      if (tag === null) { tag = t; return; }
      if (t !== tag) notify();
    } catch (e) {}
  }
  function notify() {
    shown = true;
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '内容已更新，点击刷新';
    b.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:400;padding:10px 18px;border:0;border-radius:999px;background:var(--ink,#222);color:var(--on-ink,#fff);font:inherit;font-size:14px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)');
    b.addEventListener('click', () => location.reload());
    document.body.appendChild(b);
  }
  probe();
  setInterval(probe, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) probe(); });
})();
