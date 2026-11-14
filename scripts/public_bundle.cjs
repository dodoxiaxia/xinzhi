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
function bundleText(directory) {
  const {text, window} = globals(directory);
  window.XINZHI_PART = (name, payload) => {
    if (name === 'feeds') {
      const feed = window.FEEDS, ordered = [];
      feed.order.at.forEach((at, i) => { ordered[at] = feed.items[i]; });
      payload.at.forEach((at, i) => { ordered[at] = payload.items[i]; });
      feed.items = ordered; delete feed.order;
    } else if (name === 'quicklooks' || name === 'pregenerated') Object.assign(window[name.toUpperCase()], payload.items);
    else if (name === 'library' || name === 'health') {
      const target = window[name === 'library' ? 'LIBRARY' : 'SOURCE_HEALTH'];
      delete target.deferred; Object.assign(target, payload);
    } else window[({radar:'RADAR', readings:'DEEP_READINGS', board:'WEEKLY_BOARD'})[name]] = payload;
  };
  for (const row of Object.values(window.XINZHI_PARTS.parts)) vm.runInNewContext(read(directory, row.src), {window});
  return Object.entries(window).filter(([key]) => /^[A-Z_]+$/.test(key)).map(([key, value]) => `window.${key}=${JSON.stringify(value)};`).join('\n;\n') + '\n;\n' + text.split('\n;\n').filter(s => !/^window\.[A-Z_]+=/.test(s)).join('\n;\n');
}
module.exports = {bundleText, bundleFiles, appFile, bundle_text: bundleText, bundle_files: bundleFiles};
