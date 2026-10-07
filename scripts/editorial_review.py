"""Offline review/release contract. Does not authenticate doctors or deploy content."""
import datetime
import hashlib
import json
import re

SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))
CONTENT_FIELDS = (
    'title_zh', 'summary', 'limitations', 'learning_question', 'study_type',
    'evidence_basis', 'source_url', 'source_date', 'attribution', 'fulltext_status',
    'content_kind', 'target_week', 'body_markdown', 'evidence_table_markdown',
    'source_document_sha256',
)


def article_key(article):
    return str(article.get('doi') or article.get('id') or '').strip().lower()


def content_sha256(draft, key):
    """Hash identity, reader-visible text and evidence scope, never review decisions."""
    payload = {'key': key.lower(), 'content': {k: draft.get(k) for k in CONTENT_FIELDS}}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _time(value, field):
    try:
        result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError()
        return result
    except (AttributeError, TypeError, ValueError):
        raise ValueError('Review contract needs a timezone-aware ' + field) from None


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Publication date must be YYYY-MM-DD')
    return datetime.date.fromisoformat(value)


def publication_date(draft, key, legacy=None, now=None):
    """Return an eligible date; pending/rejected/withdrawn revisions stay private.

    `legacy` is a checked-in snapshot of exactly the already published guides.
    Copying a legacy DOI cannot authorize changed content or a different date.
    Malformed/stale release requests fail the build instead of publishing.
    """
    if draft.get('published') is False or draft.get('source_checked') is not True:
        return None
    review, release = draft.get('review'), draft.get('publication')
    digest = content_sha256(draft, key)
    if review is None and release is None:
        old = (legacy or {}).get(key)
        if not old:
            return None
        if digest != old['content_sha256']:
            raise ValueError('Changed legacy guide requires physician review: ' + key)
        date = old['published_on']
        if draft.get('published') not in (None, date):
            raise ValueError('Legacy publication date cannot be rewritten: ' + key)
        _date(date)
        return date
    if review is not None and not isinstance(review, dict):
        raise ValueError('review must be an object: ' + key)
    if release is not None and not isinstance(release, dict):
        raise ValueError('publication must be an object: ' + key)
    review, release = review or {}, release or {}
    if review.get('state') != 'approved' or release.get('state') != 'release_requested':
        return None
    now = now or datetime.datetime.now(SHANGHAI)
    if review.get('schema_version') != 1 or release.get('schema_version') != 1:
        raise ValueError('Unsupported review contract version: ' + key)
    for record in (review, release):
        if record.get('content_sha256') != digest:
            raise ValueError('Review/release revision hash mismatch: ' + key)
        if not _text(record.get('event_id')):
            raise ValueError('Review/release audit event missing: ' + key)
    if review['event_id'] == release['event_id'] or release.get('review_event_id') != review['event_id']:
        raise ValueError('Release must reference a separate physician review event: ' + key)
    if review.get('reviewer_role') != 'physician' or not _text(review.get('reviewer_id')):
        raise ValueError('Physician identity required: ' + key)
    if not _text(release.get('requested_by')):
        raise ValueError('Release actor required: ' + key)
    for field in ('title_zh', 'summary', 'limitations', 'study_type', 'source_url', 'attribution'):
        if not _text(draft.get(field)):
            raise ValueError('Reviewed content missing ' + field + ': ' + key)
    if draft.get('evidence_basis') not in ('abstract', 'fulltext'):
        raise ValueError('Index evidence is insufficient: ' + key)
    if not re.match(r'^https?://', draft['source_url'], re.I):
        raise ValueError('Source URL must be HTTP(S): ' + key)
    approved = _time(review.get('decided_at'), 'decided_at')
    requested = _time(release.get('requested_at'), 'requested_at')
    date = _date(release.get('published_on'))
    if not approved <= requested <= now:
        raise ValueError('Review/release event order is invalid: ' + key)
    if date != requested.astimezone(SHANGHAI).date() or draft.get('published') != date.isoformat():
        raise ValueError('Publication date must match explicit release request: ' + key)
    if draft.get('content_kind', 'guide') not in ('guide', 'weekly'):
        raise ValueError('Unknown content kind: ' + key)
    if draft.get('content_kind') == 'weekly':
        if draft.get('evidence_basis') != 'fulltext':
            raise ValueError('Weekly reading requires fulltext evidence: ' + key)
        for field in ('body_markdown', 'evidence_table_markdown'):
            if not _text(draft.get(field)):
                raise ValueError('Weekly reading missing ' + field + ': ' + key)
        if not re.fullmatch(r'[a-f0-9]{64}', str(draft.get('source_document_sha256', ''))):
            raise ValueError('Weekly source document hash missing: ' + key)
        week = draft.get('target_week')
        if not isinstance(week, dict):
            raise ValueError('Original target week required: ' + key)
        start, end = _date(week.get('start')), _date(week.get('end'))
        if start.weekday() != 0 or end - start != datetime.timedelta(days=6):
            raise ValueError('Target week must be Monday to Sunday: ' + key)
    return date.isoformat()


def weekly_due_status(target_week, today):
    """A Wednesday is before the Friday deadline; old weeks remain historical."""
    start, end = _date(target_week['start']), _date(target_week['end'])
    if start.weekday() != 0 or end - start != datetime.timedelta(days=6):
        raise ValueError('Target week must be Monday to Sunday')
    if today > end:
        return 'historical_backlog'
    friday = start + datetime.timedelta(days=4)
    if today < friday:
        return 'before_friday'
    return 'due_friday' if today == friday else 'due_unpublished'
