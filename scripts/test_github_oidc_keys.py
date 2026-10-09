import base64
import json
import tempfile
import unittest
from pathlib import Path
from github_oidc_keys import clean_keys, checked_snapshot, build_keys, FILE


class PublicSigningKeys(unittest.TestCase):
    def key(self):
        return dict(kty='RSA', alg='RS256', use='sig', kid='synthetic-public-key', e='AQAB',
                    n=base64.urlsafe_b64encode(bytes([255]) * 256).decode().rstrip('='))

    def test_public_material_only_and_expiry(self):
        key = dict(self.key(), x5c=['public_certificate'])
        self.assertNotIn('x5c', clean_keys([key])[0])
        snap = dict(version=1, fetchedAt=1000, expiresAt=86401000, keys=[key])
        self.assertEqual(len(checked_snapshot(snap, now=2000)['keys']), 1)
        self.assertEqual(checked_snapshot(snap, now=86401000), {})
        with self.assertRaises(ValueError):
            checked_snapshot(dict(snap, expiresAt=90000000), now=2000)
        with self.assertRaises(ValueError):
            checked_snapshot(dict(snap, fetchedAt=50000, expiresAt=86450000), now=2000)

    def test_weak_duplicate_or_non_signature_keys_rejected(self):
        for keys in ([dict(self.key(), n='bad')], [self.key(), self.key()], [dict(self.key(), alg='none')], [dict(self.key(), use='enc')]):
            with self.subTest(keys=keys), self.assertRaises(ValueError):
                clean_keys(keys)

    def test_no_state_branch_keys_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'data/github-actions-jwks.json').write_text(json.dumps({'keys': [self.key()]}))
            self.assertEqual(build_keys(root), {})
            (root / '.local').mkdir()
            (root / FILE).symlink_to(root / 'data/github-actions-jwks.json')
            with self.assertRaises(ValueError):
                build_keys(root)


if __name__ == '__main__':
    unittest.main()
