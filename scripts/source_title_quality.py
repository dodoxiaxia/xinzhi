"""Detect unusable source titles and, when possible, replace them with the official Crossref title.

This does not relax hygiene or number checks on machine translations. A title that
equals the journal name, or is only a section heading, is not sent to the translator.
"""
import re
import unicodedata

SECTION_HEADINGS = {
    'invitedcommentarylessismore',
    'invitedcommentary',
    'editorials',
    'lessismore',
}


def normalised(value):
    text = re.sub(r'<[^>]+>', '', str(value or ''))
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', text).lower())


def usable_source_title(paper):
    title = (paper.get('title') or '').strip()
    if not title:
        return False, 'unusable_empty_title'
    compact = normalised(title)
    for field in ('journal', 'cleanJournal', 'containerTitle'):
        journal = (paper.get(field) or '').strip()
        if journal and compact and compact == normalised(journal):
            return False, 'unusable_title_equals_journal'
    if compact in SECTION_HEADINGS:
        return False, 'unusable_section_heading'
    return True, ''


def official_work_title(work):
    titles = (work or {}).get('title') or []
    if titles and isinstance(titles[0], str) and titles[0].strip():
        return titles[0].strip()
    return ''


def repair_title_from_work(paper, work):
    """Return a corrected English title/DOI when Crossref has a usable official title."""
    official = official_work_title(work)
    if not official:
        return None
    doi = str((work or {}).get('DOI') or paper.get('doi') or '').strip().lower()
    candidate = dict(paper, title=official, doi=doi)
    ok, _ = usable_source_title(candidate)
    if not ok:
        return None
    current = (paper.get('title') or '').strip()
    if normalised(official) == normalised(current) and (not doi or doi == str(paper.get('doi') or '').strip().lower()):
        return None
    return {'title': official, 'doi': doi, 'source': 'crossref'}
