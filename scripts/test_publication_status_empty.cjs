'use strict';
// Offline unit test for empty/whitespace publicationStatus handling in publicationStatusHtml().
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = src.match(/  function publicationStatusHtml\([^]*?\n  }/)[0];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = vm.createContext({ esc });
vm.runInContext(fn, ctx);

let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };

check(ctx.publicationStatusHtml(null) === '', 'Null paper returns empty string');
check(ctx.publicationStatusHtml({}) === '', 'Missing publicationStatus returns empty string');
check(ctx.publicationStatusHtml({ publicationStatus: {} }) === '', 'Empty publicationStatus object returns empty string');
check(ctx.publicationStatusHtml({ publicationStatus: { label: '' } }) === '', 'Empty label without links returns empty string');
check(ctx.publicationStatusHtml({ publicationStatus: { label: '   \t\n  ' } }) === '', 'Whitespace-only label without links returns empty string');
check(ctx.publicationStatusHtml({
  publicationStatus: {
    label: '  ',
    sourceUrl: 'javascript:alert(1)',
    related: [{ pmid: '1', label: 'bad', url: 'https://evil.example/' }]
  }
}) === '', 'Whitespace label with only unsafe URLs returns empty string');

const linkOnly = ctx.publicationStatusHtml({
  publicationStatus: {
    label: '  ',
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/41224473/'
  }
});
check(linkOnly.includes('https://pubmed.ncbi.nlm.nih.gov/41224473/') && !linkOnly.includes('<strong></strong>'), 'Empty label with valid PubMed link keeps link without empty <strong>');

const full = ctx.publicationStatusHtml({
  publicationStatus: {
    label: '已撤稿',
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/41224473/'
  }
});
check(full.includes('<strong>已撤稿</strong>') && full.includes('https://pubmed.ncbi.nlm.nih.gov/41224473/'), 'Non-empty label renders normally');

console.log('publicationStatusHtml empty checks: ' + checks + ' assertions passed');
