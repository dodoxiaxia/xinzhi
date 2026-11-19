"""Verify a private intake original without altering bytes or using the network."""
import argparse
import hashlib
import html
import json
import re
import unicodedata
from pathlib import Path

METHOD = 'dual_parser_all_pages_title_doi'


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if c.isalnum())


def without_margin_numbers(runs, width):
    """Remove an independently detected 1..N line-number series in the left margin."""
    candidates = []
    for index, (text, x, top) in enumerate(runs):
        value = text.strip()
        if re.fullmatch(r'[0-9]{1,3}', value) and 0 <= x < width * .1 and 1 <= int(value) <= 200:
            candidates.append((top, index, int(value), x))
    candidates.sort()
    best = []
    for start, item in enumerate(candidates):
        if item[2] != 1:
            continue
        series, columns = [], []
        for expected, entry in enumerate(candidates[start:], 1):
            columns.append(entry[3])
            if entry[2] != expected or max(columns) - min(columns) > 16:
                break
            series.append(entry[1])
        if len(series) >= 4 and len(series) > len(best):
            best = series
    if not best:
        return None
    removed = set(best)
    return '\n'.join(text for index, (text, _, _) in enumerate(runs) if index not in removed)


MARKS = re.compile('[\u2122\u00ae]')
VERSUS = re.compile(r'(?<![^\W_])(?:versus|vs\.?|v\.)(?![^\W_])', re.IGNORECASE)
PROOF_STAGE = re.compile(r'[A-Z]{2,}[0-9]{2,}_proof(?![A-Za-z])|(?<![A-Za-z0-9])_proof(?![A-Za-z])|\bjournal\s+pre-?proof\b', re.IGNORECASE)
# pypdf prints a trademark glyph it cannot map as its Adobe glyph name ("CAD-RADS/C228 2.0"); only dropped when the title itself carries TM/R.
GLYPH_NAME = re.compile(r'/C[0-9]{2,3}(?![0-9])')
INSERT_MIN_LEN = 40
PROOF_MIN_QUERIES = 3
SECTION_LABEL = re.compile(r'^\s*\[[A-Za-z][A-Za-z ./-]{0,39}\]\s*')
TITLE_MARKUP = re.compile(r'</?(?:i|b|em|strong|sub|sup|sc|scp|u|italic|bold)\b[^<>]{0,80}>', re.I)
PAGE_ACRONYM = re.compile(r'([^\W\d_])[ \t\r\n]*\([A-Z]{2,8}\)')
REPOSITORY_FIELDS = re.compile(
    r'^\s*Title\s+([\s\S]{1,1200}?)\s+Authors?\s+[\s\S]{1,2400}?\s+Published\s+in\s+'
    r'[\s\S]{1,600}?\s+Publication\s+Date\s+[\s\S]{1,120}?\s+Link\s+https?://hdl\.handle\.net/'
    r'[^\s]+[\s\S]{0,240}?\s+Citation\b', re.I)


def variant_normalized(value, drop_glyph_names=False):
    """Same narrow variants as the upload Worker: whole-word versus/vs./v. become vs, TM and R signs are dropped."""
    if drop_glyph_names:
        value = GLYPH_NAME.sub('', value)
    return normalized(VERSUS.sub(' vs ', MARKS.sub('', value)))


def proof_marker_matches(text, title):
    """Elsevier pre-proof: author-query markers (Q1, Q12) printed inside the title, at most two, between words.
    Needs proof-stage evidence on the page and a query list: at least 3 distinct Q-numbers printed, including every inserted marker."""
    if not PROOF_STAGE.search(text):
        return False
    words = [word for word in (variant_normalized(part) for part in title.split()) if word]
    if len(words) < 2 or len(''.join(words)) < INSERT_MIN_LEN:
        return False
    pattern = re.escape(words[0]) + ''.join('(?P<m%d>q[0-9]{1,2})?' % index + re.escape(word) for index, word in enumerate(words[1:]))
    page = variant_normalized(text)
    numbers = set(re.findall(r'(?<![A-Za-z0-9])Q\s*([0-9]{1,2})(?![0-9])', text))
    for match in re.finditer(pattern, page):
        markers = [value for value in match.groupdict().values() if value]
        if not markers or len(markers) > 2:
            continue
        if len(numbers) >= PROOF_MIN_QUERIES and all(marker[1:] in numbers for marker in markers):
            return True
    return False


def title_matches(text, title, cleaned=None):
    if normalized(title) in normalized(text):
        return True
    # Only the accepted-manuscript layout has this geometric cleanup fallback.
    if 'accepted manuscript' in text.casefold() and cleaned is not None and normalized(title) in normalized(cleaned):
        return True
    # Fallbacks: spelling variants, then proof-stage query markers. Both only matter because the DOI is checked separately.
    expected = variant_normalized(title)
    glyphs = bool(MARKS.search(title))
    if len(expected) >= 5 and (expected in variant_normalized(text, glyphs)
                               or (cleaned is not None and 'accepted manuscript' in text.casefold() and expected in variant_normalized(cleaned, glyphs))):
        return True
    return proof_marker_matches(text, title)


def page_has_doi(text, pattern):
    return bool(re.search(pattern, text.casefold()))


def catalog_title_variant(text, title):
    """A registered year is missing, or 2–8 uppercase letters in parentheses follow a printed word."""
    def words(value):
        value = unicodedata.normalize('NFKD', value).lower()
        value = re.sub(r'[\u0300-\u036f]', '', value)
        return ' '.join(''.join(c if unicodedata.category(c)[0] in 'LN' or c == '\ufffd' else ' '
                                for c in value).split())

    def matches(source, expected, year_dropped=False):
        year_guard = r'(?<!\b[0-9]{4} )' if year_dropped else ''
        return bool(expected and re.search(r'(?:^| )' + year_guard + re.escape(expected) + r'(?: |$)', source))

    full = words(title)
    dropped = full[5:] if re.match(r'^\s*[0-9]{4}\s+', title) else ''
    page = words(text)
    if matches(page, dropped, year_dropped=True):
        return True
    cleaned = words(PAGE_ACRONYM.sub(lambda m: m[1] if m[1].isalpha() else m[0], text))
    return ((matches(cleaned, full) and not matches(page, full))
            or matches(cleaned, dropped, year_dropped=True))


def repository_cover_title(text):
    heading = re.search(r'\buniversity\s+repository\b', text[:240], re.I)
    if heading:
        fields = REPOSITORY_FIELDS.match(text[heading.end():heading.end() + 3600])
        if fields:
            return fields[1]
    return None


def metadata_has_doi(reader, pattern):
    # Same Info fields and XMP text as the upload check. The DOI-in-document checks still run for both parsers.
    try:
        info = reader.metadata or {}
        if any(page_has_doi(info[key], pattern) for key in
               ('/Subject', '/Keywords', '/Title', '/Author', '/doi', '/DOI') if isinstance(info.get(key), str)):
            return True
        packet = reader.trailer['/Root'].get('/Metadata')
        if packet is not None:
            xml = packet.get_object().get_data()[:400000].decode('utf-8', errors='replace')
            return page_has_doi(html.unescape(re.sub(r'<[^>]*>', ' ', xml)), pattern)
    except Exception:
        # Optional fallback evidence. Ignore unreadable metadata.
        pass
    return False


def verify(path, doi, title):
    result = {'verified': False, 'pages': 0, 'method': METHOD, 'reason': 'invalid_pdf'}
    try:
        data = Path(path).read_bytes()
        result.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if not 51200 <= len(data) <= 20 * 1024 * 1024 or not data.startswith(b'%PDF-') or not re.search(rb'%%EOF\s*$', data[-1024:]):  # must match LIBRARY_MAX_PDF_BYTES
            return result
        if not re.fullmatch(r'10\.\d{4,9}/[^\s<>?#@\\]{1,200}', doi) or doi != doi.lower() or len(normalized(title)) < 5:
            result['reason'] = 'invalid_identity'
            return result
        import fitz
        from pypdf import PdfReader
        recovered = False
        try:
            reader = PdfReader(path, strict=True)
            pypdf_page_count = len(reader.pages)
        except Exception:
            recovered = True
            reader = PdfReader(path, strict=False)
            if reader.is_encrypted:
                return result
            pypdf_page_count = len(reader.pages)
        with fitz.open(path) as document:
            if document.needs_pass or not 1 <= pypdf_page_count <= 200 or document.page_count != pypdf_page_count:
                return result
            pypdf_texts, fitz_texts = [], []
            cleaned_pypdf = cleaned_fitz = None
            for number, page in enumerate(reader.pages):
                parsed = page.extract_text() or ''
                rendered_page = document.load_page(number)
                text = rendered_page.get_text('text') or ''
                pypdf_texts.append(parsed)
                fitz_texts.append(text)
                scale = min(1 / 3, 2000 / max(rendered_page.rect.width, rendered_page.rect.height, 1))
                pixels = rendered_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                if pixels.width < 1 or pixels.height < 1 or not pixels.samples:
                    return result
                if number == 0:
                    if 'accepted manuscript' in parsed.casefold():
                        pypdf_runs = []
                        def visit(run, cm, tm, font, size):
                            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
                            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
                            pypdf_runs.append((run, x, rendered_page.rect.height - y))
                        page.extract_text(visitor_text=visit)
                        cleaned_pypdf = without_margin_numbers(pypdf_runs, rendered_page.rect.width)
                    if 'accepted manuscript' in text.casefold():
                        blocks = rendered_page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']
                        fitz_runs = [(span['text'], span['bbox'][0], span['bbox'][1])
                                     for block in blocks if block['type'] == 0
                                     for line in block['lines'] for span in line['spans']]
                        cleaned_fitz = without_margin_numbers(fitz_runs, rendered_page.rect.width)
            if recovered and not any(value.strip() for value in pypdf_texts):
                return result
            result['pages'] = pypdf_page_count
        wrapped_doi = r'\s*'.join(re.escape(c) for c in doi)
        pattern = r'(?<![a-z0-9])' + wrapped_doi + r'(?![a-z0-9])'
        strict_pattern = (r'''(?:^|(?<=[\s(:'"<\[{])|(?<=\bdoi\.org/))''' + wrapped_doi
                          + r'''(?=$|\s|[.,;:)\]}'">]+(?=\s|$))''')
        first_pages = [(pypdf_texts, cleaned_pypdf), (fitz_texts, cleaned_fitz)]
        covers = [repository_cover_title(texts[0]) for texts, _ in first_pages]
        if any(cover is not None for cover in covers):
            expected = normalized(TITLE_MARKUP.sub('', title))
            title_evidence = all(cover is not None and normalized(cover) == expected
                                 and len(texts) >= 2 and expected in normalized(texts[1])
                                 and page_has_doi(texts[1], strict_pattern)
                                 for (texts, _), cover in zip(first_pages, covers))
        else:
            # Both parsers already read standard-font hex text, regardless of its PDF string syntax.
            unmatched = [texts[0] for texts, clean in first_pages if not title_matches(texts[0], title, clean)]
            title_evidence = not unmatched
            if unmatched:
                plain_title = TITLE_MARKUP.sub('', title)
                candidates = (plain_title, SECTION_LABEL.sub('', plain_title))
                if all(any(catalog_title_variant(text, candidate) for candidate in candidates)
                       for text in unmatched):
                    title_evidence = (
                        all(page_has_doi(text, strict_pattern) for text in unmatched)
                        or (metadata_has_doi(reader, strict_pattern)
                            and all(any(page_has_doi(text, strict_pattern) for text in texts)
                                    for texts, _ in first_pages)))

        # Each parser must independently find the claimed DOI in the extracted document text.
        if not (title_evidence
                and any(page_has_doi(text, pattern) for text in pypdf_texts)
                and any(page_has_doi(text, pattern) for text in fitz_texts)):
            result['reason'] = 'identity_mismatch'
            return result
        result.update(verified=True, reason='verified')
    except Exception:
        # No extracted text, file paths or parser exceptions leave the verifier.
        pass
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path')
    parser.add_argument('--doi', required=True)
    parser.add_argument('--title', required=True)
    args = parser.parse_args()
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    except (ImportError, ValueError):
        pass
    print(json.dumps(verify(args.path, args.doi, args.title)))


if __name__ == '__main__':
    main()
