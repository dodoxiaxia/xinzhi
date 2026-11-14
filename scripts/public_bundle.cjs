// Resolve the built entry point and reconstitute deferred data for offline tools.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function read(directory, name) {
  if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe public asset name');
  return fs.readFileSync(path.join(directory, name), 'utf8');
}
function appFile(directory) {
  const match = read(directory, 'index.html').match(/<script\s+src=["'](assets\/app\.[a-f0-9]{12}\.js)["']/);
  if (!match) throw new Error('Built app reference missing');
  return match[1];
}
function globals(directory) {
  const text = read(directory, appFile(directory));
  const window = {};
  // Data assignments precede the unchanged executable application sources.
  const prefix = text.split('\n;\n').filter(s => /^window\.[A-Z_]+=/.test(s));
  for (const statement of prefix) vm.runInNewContext(statement, {window});
  return {text, window};
}
function bundleFiles(directory) {
  const {window} = globals(directory);
  return [appFile(directory), ...Object.values(window.XINZHI_PARTS.parts).map(p => p.src), window.RADAR_SRC].map(p => path.join(directory, p));
}
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const out = {...target};
  for (const [k, v] of Object.entries(source)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}
function reorderKeys(obj, order) {
  if (!Array.isArray(order) || !isPlainObject(obj)) return obj;
  const out = {};
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  }
  return out;
}
function bundleText(directory) {
  const {text, window} = globals(directory);
  window.XINZHI_PART = (name, payload) => {
    if (name === 'feeds') {
      const feed = window.FEEDS, ordered = [];
      feed.order.at.forEach((at, i) => { ordered[at] = feed.items[i]; });
      payload.at.forEach((at, i) => { ordered[at] = payload.items[i]; });
      feed.items = ordered; delete feed.order;
    } else if (name === 'quicklooks') Object.assign(window.QUICKLOOKS, payload.items);
    else if (name === 'pregenerated') {
      const store = window.PREGENERATED;
      const fieldOrder = payload.fieldOrder || {};
      for (const [k, v] of Object.entries(payload.items || {})) {
        const merged = isPlainObject(store[k]) && isPlainObject(v) ? deepMerge(store[k], v) : v;
        store[k] = fieldOrder[k] ? reorderKeys(merged, fieldOrder[k]) : merged;
      }
      if (payload.keys) window.PREGENERATED = reorderKeys(store, payload.keys);
    } else if (name === 'library' || name === 'health') {
      const target = window[name === 'library' ? 'LIBRARY' : 'SOURCE_HEALTH'];
      delete target.deferred; Object.assign(target, payload);
    } else window[({radar:'RADAR', readings:'DEEP_READINGS', board:'WEEKLY_BOARD'})[name]] = payload;
  };
  for (const row of Object.values(window.XINZHI_PARTS.parts)) vm.runInNewContext(read(directory, row.src), {window});
  return Object.entries(window).filter(([key]) => /^[A-Z_]+$/.test(key)).map(([key, value]) => `window.${key}=${JSON.stringify(value)};`).join('\n;\n') + '\n;\n' + text.split('\n;\n').filter(s => !/^window\.[A-Z_]+=/.test(s)).join('\n;\n');
}
module.exports = {bundleText, bundleFiles, appFile, bundle_text: bundleText, bundle_files: bundleFiles};
