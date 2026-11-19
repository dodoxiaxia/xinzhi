"""Verify a private intake original without altering bytes or using the network."""
import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path

METHOD = 'dual_parser_all_pages_title_doi'
# A task released through POST /api/machine/hold-review may skip exactly one check, the DOI in the full text. Everything else stays.
RELEASE_METHOD = 'dual_parser_title_manual_release'
RELEASE_SKIPPED = ['doi_in_fulltext']


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


# Strict first-page title match, with no spelling or marker variants. The only comparison a manually released file may use.
def exact_title_matches(text, title, cleaned=None):
    if normalized(title) in normalized(text):
        return True
    # Only the accepted-manuscript layout has this geometric cleanup fallback.
    return 'accepted manuscript' in text.casefold() and cleaned is not None and normalized(title) in normalized(cleaned)


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


def verify(path, doi, title, release_sha256=None):
    """release_sha256: sha256 recorded when a maintainer released this exact file; only then is the DOI-in-full-text check skipped."""
    released = release_sha256 is not None
    result = {'verified': False, 'pages': 0, 'method': RELEASE_METHOD if released else METHOD, 'reason': 'invalid_pdf'}
    try:
        data = Path(path).read_bytes()
        result.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if released and (not re.fullmatch(r'[a-f0-9]{64}', str(release_sha256)) or result['sha256'] != release_sha256):
            result['reason'] = 'identity_mismatch'
            return result
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
        pattern = r'(?<![a-z0-9])' + r'\s*'.join(re.escape(c) for c in doi) + r'(?![a-z0-9])'
        # Each parser independently finds the title on page one and the DOI on some page. A released task skips only the DOI
        # and then needs the strict title (no spelling variants) from both parsers.
        title_check = exact_title_matches if released else title_matches
        doi_ok = released or (any(page_has_doi(text, pattern) for text in pypdf_texts)
                              and any(page_has_doi(text, pattern) for text in fitz_texts))
        if not (title_check(pypdf_texts[0], title, cleaned_pypdf) and title_check(fitz_texts[0], title, cleaned_fitz) and doi_ok):
            result['reason'] = 'identity_mismatch'
            return result
        result.update(verified=True, reason='verified', **({'skipped': list(RELEASE_SKIPPED)} if released else {}))
    except Exception:
        # No extracted text, file paths or parser exceptions leave the verifier.
        pass
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path')
    parser.add_argument('--doi', required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--released-sha256', default=None)
    args = parser.parse_args()
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    except (ImportError, ValueError):
        pass
    print(json.dumps(verify(args.path, args.doi, args.title, args.released_sha256)))


if __name__ == '__main__':
    main()
