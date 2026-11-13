'use strict';
// Offline unit test for copyToClipboard() failure handling, toast messaging, and textarea cleanup.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = src.match(/  async function copyToClipboard\([^]*?\n  }/)[0];

function makeEnv({ clipboardWrite, execResult, execThrows }) {
  const toasts = [];
  const children = [];
  let created = 0;
  let selected = 0;
  const document = {
    body: {
      appendChild(el) { el.parentNode = document.body; children.push(el); },
      removeChild(el) {
        const idx = children.indexOf(el);
        if (idx >= 0) children.splice(idx, 1);
        el.parentNode = null;
      }
    },
    createElement(tag) {
      assert.strictEqual(tag, 'textarea');
      created++;
      return { value: '', parentNode: null, select() { selected++; } };
    },
    execCommand(cmd) {
      assert.strictEqual(cmd, 'copy');
      if (execThrows) throw new Error('execCommand boom');
      return execResult;
    }
  };
  const navigator = clipboardWrite === undefined ? {} : { clipboard: { writeText: clipboardWrite } };
  const ctx = vm.createContext({
    document,
    navigator,
    showToast(msg) { toasts.push(msg); }
  });
  vm.runInContext(fn, ctx);
  return { copyToClipboard: ctx.copyToClipboard, toasts, children, stats: () => ({ created, selected }) };
}

async function run() {
  const rejections = [];
  const onUnhandled = err => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  let checks = 0;
  const check = (cond, msg) => { assert(cond, msg); checks++; };

  try {
    // 1. Clipboard API succeeds
    {
      const env = makeEnv({ clipboardWrite: async () => {} });
      const ok = await env.copyToClipboard('hello', '已复制');
      check(ok === true, 'Clipboard API success returns true');
      check(env.toasts.length === 1 && env.toasts[0] === '已复制', 'Clipboard API success shows successMsg');
      check(env.stats().created === 0, 'Clipboard API success does not create textarea');
    }

    // 2. Clipboard API rejects, execCommand returns true
    {
      const env = makeEnv({ clipboardWrite: async () => { throw new Error('denied'); }, execResult: true });
      const ok = await env.copyToClipboard('hello', '已复制');
      check(ok === true, 'execCommand true returns true');
      check(env.toasts.length === 1 && env.toasts[0] === '已复制', 'execCommand true shows successMsg');
      check(env.stats().selected === 1 && env.children.length === 0, 'Textarea selected and cleaned up');
    }

    // 3. Clipboard API rejects, execCommand returns false (called without await to verify no unhandledRejection)
    {
      const env = makeEnv({ clipboardWrite: async () => { throw new Error('denied'); }, execResult: false });
      const p = env.copyToClipboard('hello', '已复制');
      const ok = await p;
      check(ok === false, 'execCommand false returns false');
      check(env.toasts.length === 1 && env.toasts[0] === '复制失败，请手动复制', 'execCommand false shows failure toast');
      check(env.children.length === 0, 'Textarea cleaned up when execCommand returns false');
    }

    // 4. Clipboard API rejects, execCommand throws
    {
      const env = makeEnv({ clipboardWrite: async () => { throw new Error('denied'); }, execThrows: true });
      const ok = await env.copyToClipboard('hello', '已复制');
      check(ok === false, 'execCommand throw returns false');
      check(env.toasts.length === 1 && env.toasts[0] === '复制失败，请手动复制', 'execCommand throw shows failure toast');
      check(env.children.length === 0, 'Textarea cleaned up in finally when execCommand throws');
    }

    // 5. Missing navigator.clipboard, execCommand returns false (fire-and-forget caller)
    {
      const env = makeEnv({ clipboardWrite: undefined, execResult: false });
      env.copyToClipboard('hello', '已复制');
      await new Promise(r => setImmediate(r));
      check(env.toasts.length === 1 && env.toasts[0] === '复制失败，请手动复制', 'Missing clipboard API falls back and reports failure');
      check(env.children.length === 0, 'Textarea cleaned up on missing clipboard API failure');
    }

    await new Promise(r => setImmediate(r));
    check(rejections.length === 0, 'No unhandled Promise rejections');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  console.log('clipboard copy fallback: ' + checks + ' assertions passed');
}

run().catch(err => { console.error(err); process.exit(1); });
