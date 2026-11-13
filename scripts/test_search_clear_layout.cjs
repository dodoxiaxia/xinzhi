'use strict';
// Offline regression test for search clear button size, input right padding, and <=480px mobile input sizing.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractRules(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const header = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    if (header.startsWith('@media')) {
      out.push({ media: header, rules: extractRules(body) });
    } else {
      out.push({ media: null, selector: header, body });
    }
    i = j;
  }
  return out;
}

function parseProps(body) {
  const props = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    props[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return props;
}

const topRules = extractRules(css);

// 1. Preserve existing aria-label on .search-clear in index.html.
const clearBtnMatch = html.match(/<button\b[^>]*class="[^"]*\bsearch-clear\b[^"]*"[^>]*>/);
assert(clearBtnMatch, 'index.html must contain .search-clear button');
assert(clearBtnMatch[0].includes('aria-label="清除搜索"'), '.search-clear must retain aria-label="清除搜索"');

// 2. .search-clear is 44x44px.
const searchClearRule = topRules.filter(r => !r.media && r.selector === '.search-clear').pop();
assert(searchClearRule, '.search-clear rule must exist');
const clearProps = parseProps(searchClearRule.body);
assert.equal(clearProps.width, '44px', '.search-clear width must be 44px');
assert.equal(clearProps.height, '44px', '.search-clear height must be 44px');

// 3. Desktop .search-input retains 38px height and 14px font-size, with right padding >= 46px.
const baseInputRule = topRules.filter(r => !r.media && r.selector === '.search-input').pop();
assert(baseInputRule, 'base .search-input rule must exist');
const baseInputProps = parseProps(baseInputRule.body);
assert.equal(baseInputProps.height, '38px', 'desktop .search-input height stays 38px');
assert.equal(baseInputProps['font-size'], '14px', 'desktop .search-input font-size stays 14px');
const basePadMatch = (baseInputProps.padding || '').match(/^0\s+(\d+)px\s+0\s+\d+px$/);
assert(basePadMatch && Number(basePadMatch[1]) >= 46, 'base .search-input padding-right must accommodate 44px .search-clear');

const panelInputRule = topRules.filter(r => !r.media && r.selector === '.search-panel .search-input').pop();
assert(panelInputRule, '.search-panel .search-input rule must exist');
const panelInputProps = parseProps(panelInputRule.body);
const panelPadRight = parseInt(panelInputProps['padding-right'], 10);
assert(panelPadRight >= 46, '.search-panel .search-input padding-right must be >= 46px (got ' + panelInputProps['padding-right'] + ')');

// 4. Final @media (max-width: 480px) rule ensures >= 44px height and 16px font-size on mobile.
const media480 = topRules.filter(r => r.media && /max-width\s*:\s*480px/.test(r.media)).pop();
assert(media480, '@media (max-width: 480px) rule must exist');
assert.equal(topRules[topRules.length - 1], media480, '@media (max-width: 480px) should be the final rule');
const mobileInputRule = media480.rules.find(r => r.selector.includes('.search-input'));
assert(mobileInputRule, '@media (max-width: 480px) must style .search-input');
const mobileProps = parseProps(mobileInputRule.body);
assert(parseInt(mobileProps['min-height'] || mobileProps.height, 10) >= 44, 'mobile .search-input height must be >= 44px');
assert(parseInt(mobileProps.height || mobileProps['min-height'], 10) >= 44, 'mobile .search-input height must be >= 44px');
assert.equal(mobileProps['font-size'], '16px', 'mobile .search-input font-size must be 16px to prevent iOS zoom');

console.log('test_search_clear_layout passed: .search-clear=44x44px, padding-right>=46px, mobile <=480px .search-input >=44px/16px, desktop unchanged.');
