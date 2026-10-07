"""Narrow, publisher-verified date corrections for public discovery metadata.

Keep original source dates internally; never infer publication from ingestion.
"""

DATE_CORRECTIONS = {
    '10.1001/jamanetworkopen.2026.37533': {
        'date': '2026-10-05',
        'datePrecision': 'day',
        'dateBasis': '期刊官网 published-online（已复核）',
        # Publisher article header and Article Information both say October 5.
        'evidenceUrl': 'https://jamanetwork.com/journals/jamanetworkopen/fullarticle/2854830',
        'checkedOn': '2026-10-07',
    },
}


def canonical_publication_date(record):
    """Return a copy; match only a complete DOI, never a PMID or similar title."""
    result = dict(record)
    doi = record.get('doi')
    correction = DATE_CORRECTIONS.get(doi.strip().lower()) if isinstance(doi, str) else None
    if correction:
        result.setdefault('sourceDate', record.get('date'))
        result.setdefault('sourceDateBasis', record.get('dateBasis'))
        for field in ('date', 'datePrecision', 'dateBasis'):
            result[field] = correction[field]
    return result
