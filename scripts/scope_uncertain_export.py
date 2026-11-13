#!/usr/bin/env python3
"""Build-time export of uncertain-scope papers awaiting manual review/dispatch."""
import datetime
import json
from pathlib import Path
import re

from scope_filter import normalize_scope_doi, scope_decision

TOPIC_HIDES_PATH = Path(__file__).resolve().parents[1] / 'config/public_library_topic_hides.json'
_SAFE_URL_RE = re.compile(r'^https?://', re.I)


def _safe_url(value):
    return value.strip() if isinstance(value, str) and _SAFE_URL_RE.match(value.strip()) else ''


def _clean_str(value):
    return value.strip() if isinstance(value, str) else ''


def _parse_ingested_at(value):
    if not isinstance(value, str):
        return None, None
    text = value.strip()
    if not text or 'T' not in text:
        return None, None
    iso = text[:-1] + '+00:00' if text.endswith(('Z', 'z')) else text
    try:
        parsed = datetime.datetime.fromisoformat(iso)
    except ValueError:
        return None, None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None, None
    return text, parsed.astimezone(datetime.timezone.utc)


def load_topic_hide_filters(path=TOPIC_HIDES_PATH):
    """Read topic hide IDs and normalized DOIs without enforcing a fixed record count."""
    target = Path(path)
    try:
        data = json.loads(target.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return frozenset(), frozenset()
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'Failed to load topic hides config {target}: {exc}') from exc
    if not isinstance(data, dict) or not isinstance(data.get('records'), list):
        raise ValueError(f'Malformed topic hides config {target}: expected object with records list')
    ids = set()
    dois = set()
    for index, record in enumerate(data['records']):
        if not isinstance(record, dict):
            raise ValueError(f'Malformed topic hide record at index {index}: expected object')
        identifier = record.get('id')
        doi = record.get('doi')
        if identifier is not None:
            if not isinstance(identifier, str):
                raise ValueError(f'Malformed topic hide record at index {index}: invalid id')
            if identifier.strip():
                ids.add(identifier.strip())
        if doi is not None:
            if not isinstance(doi, str):
                raise ValueError(f'Malformed topic hide record at index {index}: invalid doi')
            norm_doi = normalize_scope_doi(doi)
            if norm_doi:
                dois.add(norm_doi)
    return frozenset(ids), frozenset(dois)


def build_scope_uncertain_list(
    papers,
    *,
    pdf_ids=None,
    hidden_ids=None,
    hidden_dois=None,
    generated_at=None,
    keep_dois=None,
    keeps_path=None,
):
    """Project deduplicated uncertain-scope papers that lack fulltext and are not hidden."""
    pdf_id_set = {str(x) for x in (pdf_ids or ()) if isinstance(x, str) and x}
    if hidden_ids is None and hidden_dois is None:
        hidden_id_set, hidden_doi_set = load_topic_hide_filters()
    else:
        hidden_id_set = {str(x).strip() for x in (hidden_ids or ()) if isinstance(x, str) and x.strip()}
        hidden_doi_set = {
            d for d in (normalize_scope_doi(x) for x in (hidden_dois or ())) if d
        }

    seen_ids = set()
    seen_dois = set()
    with_ts = []
    without_ts = []

    for paper in papers or ():
        if not isinstance(paper, dict):
            continue
        paper_id = _clean_str(paper.get('id'))
        norm_doi = normalize_scope_doi(paper.get('doi'))
        # Deduplicate before status/scope checks so library records always shadow candidate duplicates.
        if (paper_id and paper_id in seen_ids) or (norm_doi and norm_doi in seen_dois):
            continue
        if paper_id:
            seen_ids.add(paper_id)
        if norm_doi:
            seen_dois.add(norm_doi)

        if (paper_id and paper_id in hidden_id_set) or (norm_doi and norm_doi in hidden_doi_set):
            continue
        if (
            paper.get('fulltextStatus') == 'available'
            or paper.get('localAvailable') is True
            or (paper_id and paper_id in pdf_id_set)
        ):
            continue

        decision = scope_decision(paper, keep_dois=keep_dois, keeps_path=keeps_path)
        if decision.get('action') != 'uncertain':
            continue

        ingested_at, ingested_dt = _parse_ingested_at(paper.get('ingestedAt'))
        item = {
            'id': paper_id,
            'doi': norm_doi,
            'title': _clean_str(paper.get('title')),
            'journal': _clean_str(paper.get('cleanJournal')) or _clean_str(paper.get('journal')),
            'url': _safe_url(paper.get('url')),
            'date': _clean_str(paper.get('date')),
            'ingestedAt': ingested_at,
            'reason': _clean_str(decision.get('reason')) or 'uncertain_scope',
            'detail': _clean_str(decision.get('detail')),
        }
        if ingested_dt is not None:
            with_ts.append((ingested_dt, item))
        else:
            without_ts.append(item)

    with_ts.sort(key=lambda entry: (entry[1]['title'].lower(), entry[1]['title'], entry[1]['id']))
    with_ts.sort(key=lambda entry: entry[0], reverse=True)
    without_ts.sort(key=lambda item: (item['title'].lower(), item['title'], item['id']))
    items = [entry[1] for entry in with_ts] + without_ts

    ts = generated_at if isinstance(generated_at, str) and generated_at.strip() else (
        datetime.datetime.now(datetime.timezone.utc).isoformat()
    )
    return {
        'generatedAt': ts,
        'count': len(items),
        'items': items,
    }


def worker_scope_uncertain_payload(doc):
    """Return a public Worker copy of build_scope_uncertain_list output without internal paper IDs."""
    source = doc if isinstance(doc, dict) else {}
    raw_items = source.get('items')
    items = [
        {k: v for k, v in item.items() if k != 'id'}
        for item in (raw_items if isinstance(raw_items, (list, tuple)) else ())
        if isinstance(item, dict)
    ]
    return {
        'generatedAt': source.get('generatedAt'),
        'count': source.get('count', len(items)),
        'items': items,
    }
