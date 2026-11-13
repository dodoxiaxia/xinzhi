'use strict';
// Offline WCAG contrast verification for style.css theme tokens and overrides.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function parseBlockVars(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g');
  const vars = {};
  let match;
  while ((match = re.exec(css)) !== null) {
    for (const part of match[1].split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const key = part.slice(0, colon).trim();
      const val = part.slice(colon + 1).trim();
      if (key.startsWith('--')) vars[key] = val;
    }
  }
  return vars;
}

function relativeLuminance(hex) {
  const clean = hex.replace('#', '');
  assert.equal(clean.length, 6, 'Expected 6-digit hex color, got: ' + hex);
  const channels = [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(label, fg, bg, minRatio = 4.5) {
  const ratio = contrastRatio(fg, bg);
  assert(ratio >= minRatio, `${label}: ${fg} on ${bg} has contrast ${ratio.toFixed(2)}:1 (< ${minRatio}:1)`);
}

const baseLight = parseBlockVars(':root');
const baseDark = { ...baseLight, ...parseBlockVars('[data-theme="dark"]') };
const styleALight = { ...baseLight, ...parseBlockVars('html[data-style="a"]') };
const styleADark = { ...baseDark, ...styleALight, ...parseBlockVars('html[data-style="a"][data-theme="dark"]') };

const themes = [
  [':root (light)', baseLight],
  ['[data-theme="dark"]', baseDark],
  ['html[data-style="a"] (light)', styleALight],
  ['html[data-style="a"][data-theme="dark"]', styleADark],
];

for (const [name, tokens] of themes) {
  assert(tokens['--on-accent'], `${name}: --on-accent must be defined`);
  assertContrast(`${name} --on-accent on --accent`, tokens['--on-accent'], tokens['--accent']);
  assertContrast(`${name} --on-accent on --accent-hover`, tokens['--on-accent'], tokens['--accent-hover']);
  assertContrast(`${name} --text-muted on --bg-primary`, tokens['--text-muted'], tokens['--bg-primary']);
  assertContrast(`${name} --text-muted on --bg-card`, tokens['--text-muted'], tokens['--bg-card']);
  assertContrast(`${name} --text-muted on --bg-secondary`, tokens['--text-muted'], tokens['--bg-secondary']);
  assertContrast(`${name} --rose on --bg-primary`, tokens['--rose'], tokens['--bg-primary']);
  assertContrast(`${name} --rose on --bg-card`, tokens['--rose'], tokens['--bg-card']);
}

// Verify hardcoded low-contrast rules were replaced with theme tokens.
assert(!css.includes('#a0665c'), 'Low-contrast hardcoded #a0665c must be removed');
const ftFailedRule = css.match(/\.ft-failed\s+\.fulltext-state,\s*\.ft-review\s+\.fulltext-state\s*\{([^}]*)\}/);
assert(ftFailedRule && ftFailedRule[1].includes('var(--rose)'), '.ft-failed/.ft-review .fulltext-state must use var(--rose)');

const cardPrimaryRule = [...css.matchAll(/html\[data-style\]\s+\.article-card\s+\.btn-sm\.btn-primary\s*\{([^}]*)\}/g)].pop();
assert(cardPrimaryRule && cardPrimaryRule[1].includes('var(--on-accent)'), 'Final card primary button rule must use var(--on-accent)');
assert(!cardPrimaryRule[1].includes('#fff'), 'Final card primary button rule must not hardcode #fff');

console.log('test_color_contrast passed: all light/dark theme contrast pairs >= 4.5:1.');
