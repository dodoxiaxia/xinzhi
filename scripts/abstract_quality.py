"""Public abstract structure and two identity/hash-bound source-field corrections.

No lookup, model, inference or medical review. Original non-abstract metadata stays
available separately; unrecognized source text is never rewritten by word lists.
"""
import hashlib
import json
import re
import unicodedata
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'editorial/public_abstract_evidence.json'


def plain(value):
    return re.sub(r'\s+', ' ', value).strip()


class AbstractMarkup(HTMLParser):
    HEADINGS = {'title', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
    BLOCKS = {'p', 'div', 'br', 'sec', 'section', 'abstract'}
    METADATA = {'funding-group', 'award-group', 'contrib-group', 'permissions'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.heading, self.sections, self.metadata = [], None, [], []
        self.label, self.skipped = '', []
        self.metadata_parts, self.metadata_kind = [], ''

    def flush(self):
        text = plain(''.join(self.parts))
        if text:
            if self.sections and self.sections[-1]['label'] == self.label:
                self.sections[-1]['text'] += '\n\n' + text
            else:
                self.sections.append({'label': self.label, 'text': text})
        self.parts = []

    def handle_starttag(self, tag, attrs):
        tag = tag.rsplit(':', 1)[-1]
        if self.skipped:
            self.skipped.append(tag)
        elif tag in self.METADATA:
            self.flush()
            self.skipped = [tag]
            self.metadata_kind, self.metadata_parts = tag, []
        elif tag in self.HEADINGS:
            self.flush()
            self.heading = []
        elif tag in self.BLOCKS:
            self.flush()

    def handle_endtag(self, tag):
        tag = tag.rsplit(':', 1)[-1]
        if self.skipped:
            if tag in self.skipped:
                self.skipped = self.skipped[:len(self.skipped) - self.skipped[::-1].index(tag) - 1]
            if not self.skipped:
                text = plain(''.join(self.metadata_parts))
                if text:
                    self.metadata.append({'kind': self.metadata_kind, 'text': text})
        elif tag in self.HEADINGS and self.heading is not None:
            self.label = plain(''.join(self.heading))
            self.heading = None
        elif tag in self.BLOCKS:
            self.flush()

    def handle_data(self, value):
        if self.skipped:
            self.metadata_parts.append(value)
        elif self.heading is not None:
            self.heading.append(value)
        else:
            self.parts.append(value)


def abstract_fields(value):
    parser = AbstractMarkup()
    try:
        parser.feed(value or '')
        parser.close()
        if parser.skipped or parser.heading is not None:
            return {'summary': value or '', 'abstractStatus': 'unverified'}
        parser.flush()
    except (AssertionError, ValueError):
        # Do not guess at incomplete metadata markup or manufacture an abstract.
        return {'summary': value or '', 'abstractStatus': 'unverified'}
    sections = parser.sections
    summary = '\n\n'.join((s['label'] + ': ' if s['label'] else '') + s['text'] for s in sections)
    result = {'summary': summary, 'abstractStatus': 'structured' if any(s['label'] for s in sections) else 'available' if summary else 'missing'}
    if any(s['label'] for s in sections):
        result['abstractSections'] = sections
    if parser.metadata:
        result['nonAbstractMetadata'] = parser.metadata
        if not summary:
            result['abstractStatus'] = 'non_abstract_metadata'
    return result


def normalize_paper(p, evidence=None):
    """Apply a recorded correction only to the exact observed source text."""
    out = dict(p)
    summary = out.get('summary') or ''
    if not isinstance(summary, str):
        return out
    if evidence is None:
        evidence = json.loads(EVIDENCE.read_text()).get('entries', {}) if EVIDENCE.is_file() else {}
    row = evidence.get(str(out.get('doi') or '').lower())
    def title_key(value):
        return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', value or '').casefold())
    if row and title_key(out.get('title')) == title_key(row['title']) and hashlib.sha256(summary.encode()).hexdigest() in row['matchingSummaryHashes']:
        if row['status'] == 'structured':
            sections = [dict(s) for s in row['abstractSections']]
            out.update(abstractSections=sections, summary='\n\n'.join(s['label'] + ': ' + s['text'] for s in sections),
                       abstractStatus='structured', publicAbstractVerified=True,
                       abstractSource=row['source'], abstractSourceUrl=row['sourceUrl'])
        else:
            out.update(summary='', abstractSections=[], abstractStatus='non_abstract_metadata',
                       publicAbstractVerified=False,
                       nonAbstractMetadata=[{'kind': 'funding', 'text': summary}],
                       abstractSource=row['source'], abstractSourceUrl=row['sourceUrl'])
        return out
    # Never infer missing text boundaries from a concatenated legacy paragraph.
    if re.search(r'<(?:[a-z-]+:)?(?:p|div|sec|section|abstract|title|h[1-6]|funding-group|award-group|contrib-group|permissions)(?=\s|>)', summary, re.I):
        fields = abstract_fields(summary)
        # A successful parse replaces the whole abstract representation. Keeping
        # old sections would make the reader show text absent from this source.
        if fields['abstractStatus'] != 'unverified':
            fields['abstractSections'] = fields.get('abstractSections', [])
        out.update(fields)
    return out


def readable_abstract(p):
    out = normalize_paper(p)
    if out.get('abstractStatus') in {'missing', 'non_abstract_metadata', 'unverified'}:
        return False
    return bool((out.get('summary') or '').strip() or any(
        isinstance(s, dict) and isinstance(s.get('text'), str) and s['text'].strip() for s in out.get('abstractSections') or []))
