#!/usr/bin/env python3
"""Create ignored data/ inputs for an offline browser build in a scratch checkout."""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(relative_path):
    return json.loads((ROOT / relative_path).read_text(encoding='utf-8'))


def build(output, now):
    output.mkdir(parents=True, exist_ok=False)
    today = (now + dt.timedelta(hours=8)).date()

    def write(name, content):
        (output / name).write_text(json.dumps(content, ensure_ascii=False) + '\n', encoding='utf-8')

    library = read('editorial/public_library_snapshot.json')
    write('library.json', library)
    board = read('editorial/sol-public-abstract-20261007/corrected-board.json')
    board['window'].update(start=(today - dt.timedelta(days=6)).isoformat(), end=today.isoformat())
    board['generatedAt'] = now.isoformat()
    # The checked-in board has no cached studies. Reuse the repository's
    # validated empty-evidence example to exercise the cached study renderer.
    sys.path.insert(0, str(ROOT / 'scripts'))
    from test_week_precompute import structure

    first = board['items'][0]
    key = f"pmid:{first['pmid']}" if first.get('pmid') else f"doi:{first['doi'].lower()}"
    first['study'] = {
        'task': 'study', 'schemaVersion': 1, 'scope': 'public-abstract',
        'generatedAt': now.isoformat(), 'checklist': [], 'generatedBy': 'week-precompute',
        'papers': [{'key': key, 'title': first['title'], 'status': 'available', **structure()}],
    }
    papers = []
    for index, row in enumerate(board['items']):
        row['date'] = (today - dt.timedelta(days=index % 5)).isoformat()
        papers.append({
            **{key: row[key] for key in ('id', 'pmid', 'doi', 'title', 'date')},
            'datePrecision': 'day', 'dateBasis': 'Europe PMC firstPublicationDate',
            'journal': 'Journal of the American Heart Association',
            'url': row['abstractSourceUrl'], 'summary': row['abstract'],
            'authors': [f'BrowserFixtureAuthor{index:03d}'],
            'tags': ['#房颤/电生理'] if index == 0 else [],
            'clinicalTier': '心血管', 'publisher': 'AHA (Circulation)', 'basis': 'RSS',
        })

    journals = [
        ('Circulation', 'Randomized controlled trial'),
        ('The BMJ', 'Cohort study'),
        ('JAMA', 'Systematic review'),
    ]
    for index in range(50):
        journal, design = journals[index % len(journals)]
        doi = f'10.9999/browser-fixture-{index}'
        papers.append({
            'id': f'browser-fixture-{index}', 'doi': doi, 'journal': journal,
            'title': ('AI-ECG' if index % 7 == 1 else 'Cardiology') + f' browser fixture {index}: {design}',
            'date': (today - dt.timedelta(days=index % 6)).isoformat(),
            'datePrecision': 'day', 'dateBasis': 'Crossref published-online',
            'url': 'https://example.invalid/' + doi,
            'summary': 'Fictional abstract for browser interface testing. ' * 12,
            'authors': ['Fixture Author'], 'basis': 'RSS',
        })

    library_dois = {p.get('doi') for p in library['papers']}
    for index, draft in enumerate(read('editorial/source_checked_drafts.json')['articles']):
        if draft['doi'] not in library_dois:
            papers.append({
                'id': f'browser-curated-{index}', 'doi': draft['doi'],
                'title': draft['title_zh'], 'journal': 'Circulation', 'url': draft['source_url'],
                'date': draft['source_date'], 'datePrecision': 'day', 'dateBasis': 'Crossref published-online',
            })

    write('candidates.json', {'updatedAt': now.isoformat(), 'items': papers})
    write('weekly-board.json', board)
    feeds = [feed for feed in library['feeds'] if feed['enabled']]
    write('source-health.json', {'checkedAt': now.isoformat(), 'sources': [
        {**feed, 'status': 'not_feed' if index == 0 else 'ok', 'checkedAt': now.isoformat(), 'items': 2}
        for index, feed in enumerate(feeds)
    ]})

    # Reuse the repository's validated synthetic full-text sample. Mark it as
    # an AI methods example so the public reading projection includes it.
    from daily_fulltext import empty_data
    from test_daily_fulltext import item

    readings = []
    for index in range(3):
        reading = item(900000 + index)
        reading.update(
            title=f'Artificial intelligence for heart disease: offline browser fixture {index}',
            titleZh=f'离线浏览器测试全文精读 {index}',
            publishedOn=(today - dt.timedelta(days=index > 1)).isoformat(),
            generatedAt=now.isoformat(),
        )
        readings.append(reading)
    write('deep-readings.json', {**empty_data(), 'updatedAt': now.isoformat(), 'items': readings})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='A new data directory in the scratch checkout')
    args = parser.parse_args()
    build(args.output, dt.datetime.now(dt.timezone.utc))
