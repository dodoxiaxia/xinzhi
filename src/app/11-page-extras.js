// ==== src/app/11-page-extras.js · Standalone page helpers outside the main app scope ====

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
