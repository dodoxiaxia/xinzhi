"""Select only the requested site's single-category 2024 historical Q references.

No file writes, downloads or promotion to official metrics. Private audit fields,
old JIF numbers and rows with an unmapped multi-category Q never leave this step.
"""
from journal_metrics import HISTORY_STATUS, timestamp, validate_registry

SOURCE_ID = 'user-jcr-2025-reference'


def historical_subset(report, registry):
    validate_registry(registry)
    if report.get('scope') != 'rendered_preview_only' or report.get('sourceType') != 'user_reference' or report.get('conflicts'):
        raise ValueError('Historical subset requires conflict-free bounded reference audit')
    checked_at = report['checkedAt']
    timestamp(checked_at)
    journals = {row['id']: row for row in registry['journals']}
    selected, seen = [], set()
    for row in report['records']:
        jcr, jif = row.get('jcr'), row.get('jif')
        if not jcr or jcr['quartileScope'] != 'single_category_reference_only':
            continue
        if len(jcr['categoriesAsProvided']) != 1:
            raise ValueError('Historical subset cannot map one Q to multiple categories')
        if not jif or (jif['year'], jif['releaseYear']) != (2024, 2025):
            raise ValueError('Reference table must explicitly use 2024 data / 2025 release')
        if jif['status'] != 'user_reference_unverified' or jcr['status'] != 'user_reference_unverified' or row['sourceType'] != 'user_reference' or row['scope'] != 'matched_visible_preview' or row['verifiedAt'] != checked_at:
            raise ValueError('Reference provenance/status is inconsistent')
        journal = journals.get(row['journalId'])
        if not journal or journal['kind'] != 'journal' or row['journalId'] in seen:
            raise ValueError('Historical subset requires unique existing site journals')
        seen.add(row['journalId'])
        selected.append({'journalId': row['journalId'], 'dataYear': 2024, 'releaseYear': 2025,
                         'category': jcr['categoriesAsProvided'][0], 'quartile': jcr['quartileAsProvided'],
                         'sources': [SOURCE_ID], 'checkedAt': checked_at, 'status': HISTORY_STATUS,
                         'categoryCoverage': 'reference_single_category'})
    source = {'label': '用户提供参考表：2025JCRIF-分区（2024 数据年 / 2025 发布版）',
              'url': None, 'kind': 'user_reference', 'checkedAt': checked_at, 'status': HISTORY_STATUS,
              'dataYear': 2024, 'releaseYear': 2025, 'scope': 'matched_site_journals_only'}
    return {'sources': {SOURCE_ID: source}, 'historicalReferences': sorted(selected, key=lambda row: row['journalId'])}
