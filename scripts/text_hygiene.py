"""Normalize transport artifacts in decoded, human-readable text."""
import codecs
import html
import re

from build_data import clean


OCTAL = r'\\[0-7]{3}'
HEX = r'\\x[0-9a-fA-F]{2}'
UNICODE = r'\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})'
ESCAPES = re.compile(f'(?:{OCTAL}|{HEX}|{UNICODE})+')
ENTITY_NAME = r'#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+'
ENTITY = re.compile(fr'&(?:{ENTITY_NAME});')
NESTED_ENTITY = re.compile(fr'&(?:amp;|AMP;)+({ENTITY_NAME};)')
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]')
INLINE_CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f]')
BROKEN_UNICODE = re.compile(r'[\ufffd\ud800-\udfff]')
BARE_DASH = re.compile(r'03[57]')
DASHES = '-‐‑‒–—―−'

# UTF-8 continuation bytes displayed as Latin-1 or as Windows-1252.
_CONT = r'[\x80-\xbf€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]'
MOJIBAKE = re.compile(fr'[\xc2-\xdf]{_CONT}|[\xe0-\xef]{_CONT}{{2}}|[\xf0-\xf4]{_CONT}{{3}}')


def entity_value(token):
    # html.unescape alone accepts partial legacy names, e.g. &copycat;.
    if token.startswith('&#') or token[1:] in html.entities.html5:
        try:
            return html.unescape(token)
        except ValueError:
            return token  # Unparseable numeric entity, for example a very large integer.
    return token


def mojibake_value(token):
    try:
        raw = bytes(ord(char) if ord(char) <= 255 else char.encode('cp1252')[0] for char in token)
        return raw.decode('utf-8')
    except UnicodeError:
        return token


def decode_escapes(match):
    token = match[0]
    # Group byte escapes before interpreting their UTF-8. Unicode escapes
    # instead name code points, including possible UTF-16 surrogate pairs.
    pieces = re.findall(fr'(?:{OCTAL}|{HEX})+|(?:{UNICODE})+', token)
    decoded = []
    for piece in pieces:
        try:
            if piece.startswith(('\\u', '\\U')):
                value = codecs.decode(piece.encode('ascii'), 'unicode_escape')
                value = value.encode('utf-16-le', 'surrogatepass').decode('utf-16-le')
            else:
                if re.search(r'\\[4-7][0-7]{2}', piece):
                    decoded.append(piece)
                    continue
                value = codecs.escape_decode(piece.encode('ascii'))[0].decode('utf-8')
            decoded.append(value)
        except UnicodeError:
            decoded.append(piece)
    return ''.join(decoded)


def dash_residue_count(value, reference):
    """Only count bare digits where the same source text has a dash."""
    if not reference or value == reference:
        return 0
    pieces = BARE_DASH.split(value)
    if len(pieces) == 1:
        return 0
    digits = BARE_DASH.findall(value)
    pattern = re.escape(pieces[0]) + ''.join(
        f'({token}|[{re.escape(DASHES)}])' + re.escape(part)
        for token, part in zip(digits, pieces[1:])
    )
    match = re.fullmatch(pattern, reference)
    return sum(char in DASHES for char in match.groups()) if match else 0


def artifact_counts(value, *, single_line=False, reference=None):
    """Count occurrences in one string after its JSON (or XML) container is parsed."""
    entities = sum(m[0].startswith('&#') or entity_value(m[0]) != m[0] for m in ENTITY.finditer(value))
    nested = sum(entity_value('&' + m[1]) != '&' + m[1] for m in NESTED_ENTITY.finditer(value))
    return {
        'octal_escape': len(re.findall(OCTAL, value)),
        'hex_escape': len(re.findall(HEX, value)),
        'unicode_escape': len(re.findall(UNICODE, value)),
        'nested_html_entity': nested,
        'html_entity': entities - nested,
        'control': len((INLINE_CONTROL if single_line else CONTROL).findall(value)),
        'replacement': len(BROKEN_UNICODE.findall(value)),
        'mojibake': sum(mojibake_value(m[0]) != m[0] for m in MOJIBAKE.finditer(value)),
        'bare_dash_residue': dash_residue_count(value, reference),
    }


def normalize_text(value, *, single_line=False):
    """Repair reversible artifacts, retaining undecodable bytes for the audit."""
    while True:
        before = value
        value = ESCAPES.sub(decode_escapes, value)
        value = NESTED_ENTITY.sub(lambda m: '&' + m[1], value)
        value = ENTITY.sub(lambda m: entity_value(m[0]), value)
        value = MOJIBAKE.sub(lambda m: mojibake_value(m[0]), value)
        # These controls have no printable representation. A space keeps the
        # surrounding words distinct without guessing the missing punctuation.
        value = (INLINE_CONTROL if single_line else CONTROL).sub(' ', value)
        if before == value:
            return value.strip() if single_line else value


def clean_markup(value):
    # Strip actual markup first. A decoded comparison or literal tag spelling
    # must never be fed back into the HTML parser.
    return clean_inline(clean(value))


def clean_inline(value):
    return re.sub(r'\s+', ' ', normalize_text(value or '', single_line=True)).strip()


def model_text(value, *, single_line=False):
    """Reject lossy or still-encoded model text so it can be generated again."""
    value = normalize_text(value, single_line=single_line)
    if any(artifact_counts(value, single_line=single_line).values()):
        raise ValueError('unrecoverable_text_artifact')
    return value
