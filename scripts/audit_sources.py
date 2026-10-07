#!/usr/bin/env python3
"""Standalone bounded audit; daily refresh generates health without a second fetch."""
from collections import Counter
import json

from refresh_feeds import (ROOT, build_results, collect, fetch_group, load_previous,
                           select_sources, utcnow, write_json_js)


def audit_host(sources):
    """Compatibility API using the same strict parser and host-stop policy."""
    _, health = build_results(sources, fetch_group(sources), now=utcnow())
    return health['sources']


def main():
    library = json.loads((ROOT / 'data/library.json').read_text())
    sources = select_sources(library, all_sources=True)
    _, health = build_results(sources, collect(sources),
                              previous_feeds=load_previous(ROOT / 'data/feeds.json'),
                              previous_health=load_previous(ROOT / 'data/source-health.json'))
    health['generatedBy'] = 'audit_sources'
    write_json_js(ROOT / 'data/source-health.json', 'SOURCE_HEALTH', health)
    print(json.dumps({'sources': len(health['sources']), 'summary': dict(Counter(row['status'] for row in health['sources']))}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
