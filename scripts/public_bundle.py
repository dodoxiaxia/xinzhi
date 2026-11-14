"""Read published bundles through the HTML entry point and deferred manifest."""
import json
import re
from pathlib import Path
from public_split import js


def _merge_dict(target, source):
    out = dict(target)
    for k, v in source.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _merge_dict(out[k], v)
        else:
            out[k] = v
    return out


def _reorder_dict(mapping, order):
    if not order:
        return mapping
    out = {k: mapping[k] for k in order if k in mapping}
    for k, v in mapping.items():
        if k not in out:
            out[k] = v
    return out


def _read(directory, name):
    path = directory / name
    if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink():
        raise ValueError('Unsafe public asset name')
    return path.read_text(encoding='utf-8')


def app_file(public_dir):
    directory = Path(public_dir)
    html = _read(directory, 'index.html')
    match = re.search(r'<script\s+src=["\'](assets/app\.[0-9a-f]{12}\.js)["\']', html)
    if not match:
        raise ValueError('Built app reference missing')
    return match[1]


def _global(text, name):
    return json.JSONDecoder().raw_decode(text.split('window.' + name + '=', 1)[1])[0]


def bundle_files(public_dir):
    directory = Path(public_dir)
    app = app_file(directory)
    text = _read(directory, app)
    manifest = _global(text, 'XINZHI_PARTS')
    return [directory / app] + [directory / row['src'] for row in manifest['parts'].values()] + [directory / _global(text, 'RADAR_SRC')]


def bundle_text(public_dir):
    directory = Path(public_dir)
    text = _read(directory, app_file(directory))
    if 'window.XINZHI_PARTS=' not in text:
        return text
    manifest = _global(text, 'XINZHI_PARTS')
    data = {name: _global(text, name) for name in ('FEEDS', 'LIBRARY', 'SOURCE_HEALTH', 'QUICKLOOKS', 'PREGENERATED')}
    for name, row in manifest['parts'].items():
        raw = _read(directory, row['src'])
        payload = json.JSONDecoder().raw_decode(raw.split('window.XINZHI_PART(', 1)[1].split(',', 1)[1])[0]
        if name == 'feeds':
            feed = data['FEEDS']
            ordered = dict(zip(feed['order']['at'], feed['items']))
            ordered.update(zip(payload['at'], payload['items']))
            feed['items'] = [ordered[i] for i in range(feed['order']['total'])]
            del feed['order']
        elif name == 'quicklooks':
            data['QUICKLOOKS'].update(payload['items'])
        elif name == 'pregenerated':
            store = data['PREGENERATED']
            field_orders = payload.get('fieldOrder') or {}
            for k, v in (payload.get('items') or {}).items():
                if k in store and isinstance(store[k], dict) and isinstance(v, dict):
                    store[k] = _reorder_dict(_merge_dict(store[k], v), field_orders.get(k))
                else:
                    store[k] = v
            data['PREGENERATED'] = _reorder_dict(store, payload.get('keys'))
        elif name in ('library', 'health'):
            target = data['LIBRARY' if name == 'library' else 'SOURCE_HEALTH']
            target.pop('deferred', None)
            target.update(payload)
        else:
            data[{'radar': 'RADAR', 'readings': 'DEEP_READINGS', 'board': 'WEEKLY_BOARD'}[name]] = payload
    # Replace tier-one assignments, so legacy parsers encounter complete values first.
    for name, value in data.items():
        marker = 'window.' + name + '='
        if marker in text:
            start = text.index(marker)
            _, end = json.JSONDecoder().raw_decode(text[start + len(marker):])
            text = text[:start] + js(name, value) + text[start + len(marker) + end + 1:]
        else:
            text = js(name, value) + '\n;\n' + text
    return text


def radar_text(public_dir):
    directory = Path(public_dir)
    return _read(directory, _global(_read(directory, app_file(directory)), 'RADAR_SRC'))
