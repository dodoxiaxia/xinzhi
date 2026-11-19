'use strict';
// Exercise the shipped functions from the generated app bundle without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'editorial/sol-public-abstract-20261007/corrected-board.json'), 'utf8'));
const live = fixture.items.slice(0, 24);
const el = new Map();
const state = { huddle: [], huddleSnap: {}, requests: [] };
const address = 'https://learn.example.invalid/?q=PRIVATE_FILTER&paper=PRIVATE_READER#PRIVATE_FRAGMENT';
let copied;
const ctx = vm.createContext({
  URL, URLSearchParams, atob, btoa, state, STATIC_DOI_PAPERS: live,
  location: { href: address },
  navigator: { clipboard: { writeText() {} } },
  RADAR_LOAD: { state: 'loaded' },
  partsPending: () => false,
  loadRadarArchive: () => assert.fail('completed data should not reload'),
  $: id => {
    if (!el.has(id)) el.set(id, {});
    return el.get(id);
  },
  copyToClipboard: async (href, toast) => {
    assert.equal(toast, '已复制分享链接');
    copied = href;
    return true;
  },
});

const declarations = [...source.matchAll(/^  const SHORTLIST_SHARE_[A-Z_]+ = \d+;/gm)].map(match => match[0]);
const functions = [
  'readShortlistShareParam', 'exactDoi', 'shortlistIdKey', 'encodeShortlistShare', 'decodeShortlistShare',
  'buildShortlistShareUrl', 'publicShortlistPapers', 'shareableHuddleIds', 'copyShortlistShare',
].map(name => {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^]*?\\n  }`, 'm'));
  assert(match, `missing bundle function ${name}`);
  return match[0];
});
vm.runInContext([...declarations, "const shortlistPaperParts = []; let pendingShortlistPrefix = '';", ...functions].join('\n'), ctx);
const { buildShortlistShareUrl, decodeShortlistShare, readShortlistShareParam, publicShortlistPapers } = ctx;
const read = href => decodeShortlistShare(new URL(href).searchParams.get('list'));
const raw = text => 'v1.' + Buffer.from(text, 'utf8').toString('base64url');

(async () => {
  const fixtureIds = live.map(paper => paper.id);
  assert(fixtureIds.length >= 20);
  const edgeIds = ['10.1000/MiXeD/nested%2Fwith%percent', 'rss-cb12f0ab12ab12ab', '12345679'];
  const input = [...fixtureIds, ...edgeIds];
  const normal = buildShortlistShareUrl(address, input);
  assert.equal(normal.count, input.length);
  assert.equal(normal.limited, false);
  assert.deepEqual(Array.from(read(normal.href).ids), input);
  assert.equal(read(normal.href).ignored, false);
  assert.match(new URL(normal.href).searchParams.get('list'), /^v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual([...new URL(normal.href).searchParams.keys()], ['list']);
  assert.equal(new URL(normal.href).hash, '');
  assert.equal(publicShortlistPapers([live[0].doi.toUpperCase(), live[0].pmid])[0].id, live[0].id);
  assert.equal(publicShortlistPapers([live[0].pmid])[0].id, live[0].id);

  const dup = read(buildShortlistShareUrl(address, [...edgeIds, edgeIds[0].toLowerCase(), 'pmid-12345679']).href);
  assert.deepEqual(Array.from(dup.ids), edgeIds);
  const mixed = decodeShortlistShare(raw([edgeIds[0], edgeIds[0].toLowerCase(), '<script>alert(1)</script>', edgeIds[1]].join('\n')));
  assert.deepEqual(Array.from(mixed.ids), edgeIds.slice(0, 2));
  assert.equal(mixed.ignored, true);

  const many = Array.from({ length: 61 }, (_, i) => 'pmid-' + (12345000 + i));
  const countCap = buildShortlistShareUrl(address, many);
  assert.equal(countCap.count, 60);
  assert(countCap.limited && countCap.href.length < 2000);
  assert.deepEqual(Array.from(read(countCap.href).ids), many.slice(0, 60));
  const receivedOverCount = decodeShortlistShare(raw(many.join('\n')));
  assert.deepEqual(Array.from(receivedOverCount.ids), many.slice(0, 60));
  assert.equal(receivedOverCount.ignored, true);

  const long = Array.from({ length: 60 }, (_, i) => '10.1000/' + 'x'.repeat(145) + i);
  const lengthCap = buildShortlistShareUrl(address, long);
  assert(lengthCap.limited && lengthCap.count > 0 && lengthCap.count < 60);
  assert(lengthCap.href.length < 2000);
  assert.deepEqual(Array.from(read(lengthCap.href).ids), long.slice(0, lengthCap.count));
  assert.equal(buildShortlistShareUrl(address, long.slice(0, lengthCap.count)).limited, false);
  assert.equal(buildShortlistShareUrl('https://learn.example.invalid/' + 'x'.repeat(2000), fixtureIds).href, '');

  for (const value of ['', 'v1.', 'v2.YQ', 'v1.a', 'v1.YQ==', 'v1.YQ\n', '%invalid',
    '<script>alert(1)</script>', 'javascript:alert(1)', 'v1.' + 'A'.repeat(2000),
    ...['<script>alert(1)</script>', 'javascript:alert(1)', 'https://example.invalid/id', '10.1000/<bad>',
      '10.1000/a?b', '   ', '\u0000pmid-12345', 'rss-文献', 'a'.repeat(161)].map(raw)]) {
    const result = decodeShortlistShare(value);
    assert.equal(result.ids.length, 0, `accepted invalid value ${value.slice(0, 50)}`);
    assert.equal(result.ignored, true);
  }
  assert.equal(readShortlistShareParam(new URLSearchParams('mode=weekly')), null);
  assert.equal(readShortlistShareParam(new URLSearchParams('mode=weekly&list=v1.YQ&list=v1.Yg')), '');
  assert.equal(readShortlistShareParam(new URLSearchParams('mode=weekly&list=v1.YQ&paper=pmid-12345679')), 'v1.YQ');
  const unknown = decodeShortlistShare(raw('rss-not-in-public-data'));
  assert.deepEqual(Array.from(unknown.ids), ['rss-not-in-public-data']);
  assert.equal(publicShortlistPapers(unknown.ids)[0], undefined);

  // Exercise the same copy entry point the dialog uses, with plausible private IDs and notes.
  state.huddle = [fixtureIds[0], 'rss-only-in-snapshot', 'rss-only-in-ledger', fixtureIds[1]];
  state.huddleSnap = {
    [fixtureIds[0]]: { note: 'PRIVATE_NOTE', title: 'PRIVATE_USER_TITLE', doi: '10.9999/private-snapshot' },
    'rss-only-in-snapshot': { title: 'PRIVATE_SNAPSHOT_TITLE', doi: live[2].doi },
  };
  state.requests = [{ id: 'rss-only-in-ledger', title: 'PRIVATE_REQUEST', doi: live[3].doi }];
  ctx.allPapersMap = new Map([['rss-only-in-ledger', state.requests[0]]]);
  await ctx.copyShortlistShare();
  assert(copied, 'positive control: the copy action produced a URL');
  assert.deepEqual(Array.from(read(copied).ids), fixtureIds.slice(0, 2));
  assert.deepEqual([...new URL(copied).searchParams.keys()], ['list']);
  assert.equal(new URL(copied).hash, '');
  assert.match(el.get('#shortlistShareCopyNotice').textContent, /已略过/);

  live.push(...many.map(id => ({ id })));
  state.huddle = many;
  copied = undefined;
  await ctx.copyShortlistShare();
  assert.equal(copied, undefined, 'an over-limit selection offers a prefix before writing');
  assert.equal(el.get('#copyShortlistShareBtn').textContent, '复制前 60 篇的链接');
  await ctx.copyShortlistShare();
  assert.deepEqual(Array.from(read(copied).ids), many.slice(0, 60));
  console.log(`shortlist share: ${fixtureIds.length} real fixture IDs, DOI edges, rejection, privacy, 60-paper cap and URL < 2000 (length-limited to ${lengthCap.count}) passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
