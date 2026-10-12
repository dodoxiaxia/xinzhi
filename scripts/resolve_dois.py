#!/usr/bin/env python3
"""Find DOIs for RSS items whose feed gives none.

Lancet, JACC/ScienceDirect, IJC and BMJ feeds publish no DOI. Without one an item
cannot get a cached Chinese title (keyed by PMID/DOI) and is not recognised as the
PubMed record of the same paper, so it shows up twice and untranslated.

Lookups use Crossref and accept a DOI only when Crossref's title equals the feed
title (normalised): Elsevier links carry a PII, matched exactly through Crossref's
alternative-id filter; other links fall back to a bibliographic title query.
Results, including misses, are cached in data/doi-resolve.json (kept on the state
branch); a miss is retried after RETRY_DAYS. Each run is bounded in calls and time
waits out rate limits a few times before leaving the rest for the next run, so a slow
Crossref never holds up the refresh.
Set XINZHI_DOI_LOOKUP=0 to skip network lookups (cached DOIs still apply).
"""
import datetime
import hashlib
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = 'data/doi-resolve.json'
API = 'https://api.crossref.org/works'
HEADERS = {'User-Agent': 'XinZhiLearningPilot/0.1 (https://learn.dryz.info; public journal metadata)'}
# Crossref's anonymous pool allows 1 request/second, one at a time (x-rate-limit headers).
MAX_LOOKUPS, DEADLINE_SECONDS, PAUSE_SECONDS, TIMEOUT_SECONDS, RETRY_DAYS = 200, 330, 1.5, 12, 3
MAX_RATE_LIMITS, RATE_LIMIT_WAIT = 5, 5
DOI_RE = re.compile(r'^10\.\d{4,9}/\S+$')
# Lancet: .../PIIS0140-6736(26)01535-7/fulltext ; ScienceDirect: .../pii/S0735109726012345
PII_RE = re.compile(r'(?:/PII|/pii/)(S?\d{4}-?\d{3}[\dXx]\(?\d{2}\)?\d{5}-?[\dXx])', re.I)


def title_key(title):
    """Feed-agnostic title identity: drop a leading [Section] tag, accents, case and punctuation."""
    text = re.sub(r'<[^>]+>', '', str(title or ''))
    text = re.sub(r'^\s*\[[A-Za-z ]+\]\s*', '', text)
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', text).lower())


def pii_of(url):
    match = PII_RE.search(urllib.parse.unquote(str(url or '')))
    if not match:
        return ''
    pii = re.sub(r'[-()]', '', match.group(1)).upper()
    return pii if re.fullmatch(r'S\d{15}[\dX]', pii) else ''


def title_cache_key(title):
    """Stable key for a paper known only by its title (no DOI/PMID), e.g. 'title:3f2a…'."""
    key = title_key(title)
    return 'title:' + hashlib.sha1(key.encode()).hexdigest()[:20] if len(key) >= 20 else ''


def cache_key(item):
    pii = pii_of(item.get('url'))
    if pii:
        return 'pii:' + pii
    return title_cache_key(item.get('title'))


def crossref(params):
    url = API + '?' + urllib.parse.urlencode({'rows': 5, 'select': 'DOI,title', **params})
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read(2_000_000))['message']['items']


def lookup(item, fetch=crossref):
    """Return the DOI whose Crossref title equals the item's title, else ''."""
    want = title_key(item.get('title'))
    pii = pii_of(item.get('url'))
    rows = fetch({'filter': 'alternative-id:' + pii} if pii else {'query.bibliographic': str(item.get('title'))[:300]})
    hits = {str(r.get('DOI', '')).lower() for r in rows
            if any(title_key(t) == want for t in r.get('title') or []) and DOI_RE.match(str(r.get('DOI', '')))}
    return hits.pop() if len(hits) == 1 else ''


def fill(items, root=ROOT, fetch=crossref, now=None, network=None, sleep=time.sleep):
    """Add `doi` to items that lack DOI and PMID. Returns counts; never raises on network trouble."""
    path = Path(root) / CACHE
    try:
        cache = json.loads(path.read_text())
        cache = cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        cache = {}
    now = now or datetime.datetime.now(datetime.timezone.utc)
    network = (os.environ.get('XINZHI_DOI_LOOKUP', '1') != '0') if network is None else network
    stats = {'missing': 0, 'cached': 0, 'resolved': 0, 'unresolved': 0, 'looked_up': 0, 'rate_limited': 0, 'stopped': ''}
    started, changed = time.monotonic(), False
    for item in items:
        if item.get('doi') or item.get('pmid'):
            continue
        key = cache_key(item)
        if not key:
            continue
        stats['missing'] += 1
        entry = cache.get(key) if isinstance(cache.get(key), dict) else None
        if entry and entry.get('doi'):
            item['doi'], item['doiSource'] = entry['doi'], 'crossref'
            stats['cached'] += 1
            continue
        try:
            retry = entry and now - datetime.datetime.fromisoformat(entry['at']) < datetime.timedelta(days=RETRY_DAYS)
        except (KeyError, TypeError, ValueError):
            retry = False
        if retry or not network or stats['stopped']:
            continue
        if stats['looked_up'] >= MAX_LOOKUPS or time.monotonic() - started > DEADLINE_SECONDS:
            stats['stopped'] = 'budget'
            continue
        if stats['looked_up']:
            sleep(PAUSE_SECONDS)
        stats['looked_up'] += 1
        doi = None
        while doi is None:
            try:
                doi = lookup(item, fetch)
            except urllib.error.HTTPError as error:
                if error.code == 429 and stats['rate_limited'] < MAX_RATE_LIMITS:
                    stats['rate_limited'] += 1
                    try:
                        wait = float(error.headers.get('retry-after') or 0)
                    except (TypeError, ValueError, AttributeError):
                        wait = 0
                    sleep(min(max(wait, RATE_LIMIT_WAIT), 30))
                    continue
                stats['stopped'] = 'http_%s' % error.code  # repeated 429 or 5xx: rest waits for the next run
                break
            except Exception as error:  # timeout, DNS, bad JSON: same
                stats['stopped'] = type(error).__name__
                break
        if doi is None:
            continue
        cache[key] = {'doi': doi, 'at': now.isoformat(timespec='seconds')}
        changed = True
        if doi:
            item['doi'], item['doiSource'] = doi, 'crossref'
            stats['resolved'] += 1
        else:
            stats['unresolved'] += 1
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(',', ':'), sort_keys=True))
        tmp.replace(path)
    return stats


if __name__ == '__main__':
    feeds = json.loads((ROOT / 'data/feeds.json').read_text())
    print(json.dumps(fill(feeds['items'] if isinstance(feeds, dict) else feeds)))
