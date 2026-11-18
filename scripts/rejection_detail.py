"""Small, bounded excerpts for private validation diagnostics."""
import json

RAW_LIMIT = 2500


def raw_excerpt(value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return {'raw': text[:RAW_LIMIT], 'rawChars': len(text), 'rawTruncated': len(text) > RAW_LIMIT}
