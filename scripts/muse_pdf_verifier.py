"""Verify a private intake original without altering bytes or using the network."""
import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path

METHOD = 'dual_parser_all_pages_title_doi'


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if c.isalnum())


def verify(path, doi, title):
    result = {'verified': False, 'pages': 0, 'method': METHOD, 'reason': 'invalid_pdf'}
    try:
        data = Path(path).read_bytes()
        result.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if not 51200 <= len(data) <= 10 * 1024 * 1024 or not data.startswith(b'%PDF-') or not re.search(rb'%%EOF\s*$', data[-1024:]):
            return result
        if not re.fullmatch(r'10\.\d{4,9}/[^\s<>?#@\\]{1,200}', doi) or doi != doi.lower() or len(normalized(title)) < 5:
            result['reason'] = 'invalid_identity'
            return result
        import fitz
        from pypdf import PdfReader
        reader = PdfReader(path, strict=True)
        with fitz.open(path) as document:
            if document.needs_pass or not 1 <= len(reader.pages) <= 200 or document.page_count != len(reader.pages):
                return result
            first_pypdf = first_fitz = ''
            for number, page in enumerate(reader.pages):
                parsed = page.extract_text() or ''
                rendered_page = document.load_page(number)
                text = rendered_page.get_text('text') or ''
                scale = min(1 / 3, 2000 / max(rendered_page.rect.width, rendered_page.rect.height, 1))
                pixels = rendered_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                if pixels.width < 1 or pixels.height < 1 or not pixels.samples:
                    return result
                if number == 0:
                    first_pypdf, first_fitz = parsed, text
            result['pages'] = len(reader.pages)
        pattern = r'\s*'.join(re.escape(c) for c in doi) + r'(?![a-z0-9])'
        # Each parser must independently find the same first-page DOI and title.
        if not all(re.search(pattern, text.casefold()) and normalized(title) in normalized(text) for text in (first_pypdf, first_fitz)):
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
