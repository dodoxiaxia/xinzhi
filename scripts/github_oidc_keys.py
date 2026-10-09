"""Fetch only GitHub's public signing keys for this publisher's offline build."""
import base64
import json
import re
import time
import urllib.request
from pathlib import Path

URL = 'https://token.actions.githubusercontent.com/.well-known/jwks'
FILE = '.local/github-actions-jwks.json'
TTL = 86400000


def clean_keys(keys):
    if not isinstance(keys, list) or not 1 <= len(keys) <= 20:
        raise ValueError('invalid_signing_keys')
    result, seen = [], set()
    for key in keys:
        if not isinstance(key, dict) or key.get('kty') != 'RSA' or key.get('alg') != 'RS256' or key.get('use') != 'sig':
            continue
        kid, modulus, exponent = key.get('kid', ''), key.get('n', ''), key.get('e', '')
        if not isinstance(kid, str) or not re.fullmatch('[A-Za-z0-9-]{1,100}', kid) or kid in seen:
            raise ValueError('invalid_signing_keys')
        if not isinstance(modulus, str) or not re.fullmatch('[A-Za-z0-9_-]{342,1366}', modulus) or exponent != 'AQAB':
            raise ValueError('invalid_signing_keys')
        number = int.from_bytes(base64.urlsafe_b64decode(modulus + '=' * (-len(modulus) % 4)), 'big')
        if not 2048 <= number.bit_length() <= 8192:
            raise ValueError('invalid_signing_keys')
        seen.add(kid)
        result.append({name: key[name] for name in ('kty', 'alg', 'use', 'kid', 'n', 'e')})
    if not result:
        raise ValueError('invalid_signing_keys')
    return result


def checked_snapshot(value, now=None):
    now = int(time.time() * 1000) if now is None else now
    if not isinstance(value, dict) or set(value) != {'version', 'fetchedAt', 'expiresAt', 'keys'} or value['version'] != 1:
        raise ValueError('invalid_signing_snapshot')
    if type(value['fetchedAt']) is not int or type(value['expiresAt']) is not int or value['expiresAt'] - value['fetchedAt'] != TTL or value['fetchedAt'] > now + 30000:
        raise ValueError('invalid_signing_snapshot')
    keys = clean_keys(value['keys'])
    if value['expiresAt'] <= now:
        return {}
    return {'keys': keys, 'fetchedAt': value['fetchedAt'], 'expiresAt': value['expiresAt']}


def build_keys(root):
    # .local is not restored from state; only the trusted main publisher fills it.
    from release_integrity import ordinary_file
    file = ordinary_file(root, FILE)
    if not file.exists():
        return {}
    if file.stat().st_size > 65536:
        raise ValueError('invalid_signing_snapshot')
    return checked_snapshot(json.loads(file.read_text()))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def refresh(root):
    file = Path(root) / FILE
    file.parent.mkdir(parents=True, exist_ok=True)
    # An unsuccessful fetch cannot reuse unauthenticated state-branch key data.
    if file.is_symlink():
        raise ValueError('invalid_signing_snapshot')
    file.unlink(missing_ok=True)
    request = urllib.request.Request(URL, headers={'Accept': 'application/json', 'User-Agent': 'XinZhiSigningKeys/1.0'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if response.status != 200:
            raise ValueError('signing_keys_unavailable')
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('invalid_signing_keys')
    keys = clean_keys(json.loads(raw)['keys'])
    now = int(time.time() * 1000)
    file.write_text(json.dumps({'version': 1, 'fetchedAt': now, 'expiresAt': now + TTL, 'keys': keys}, separators=(',', ':')))
    print(json.dumps({'publicSigningKeys': len(keys), 'validHours': 24}))


if __name__ == '__main__':
    try:
        refresh(Path(__file__).resolve().parents[1])
    except Exception:
        print('public_signing_keys_unavailable')
        raise SystemExit(1)
