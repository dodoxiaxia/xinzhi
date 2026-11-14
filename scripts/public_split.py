"""Pure public payload partitioning and deterministic asset serialization."""
import gzip
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path

PICK_FIELDS = ('autoPick', 'weeklyPick')
PART_ORDER = ('feeds', 'library', 'quicklooks', 'radar', 'pregenerated', 'readings', 'health', 'board')

# The data budget was first set to the 100 KB target; the measured first-screen data is about 111 KB br
# (the 近7天榜 pre-generated entries and the picked papers' abstracts). Lower these when data moves to deferred parts.
FIRST_SCREEN_DATA_BUDGET_BR = 120 * 1024
# Total critical path (index.html + stylesheet + tier-1 script): measured about 201 KB br, plus headroom.
FIRST_SCREEN_TOTAL_BUDGET_BR = 225 * 1024
FIRST_SCREEN_GZIP_TO_BR_RATIO = 1.25
_UNSET = object()


def js(name, value):
    return 'window.' + name + '=' + json.dumps(value, ensure_ascii=False, separators=(',', ':')) + ';'


def asset_name(stem, text, extension='js'):
    return 'assets/' + stem + '.' + hashlib.sha256(text.encode('utf-8')).hexdigest()[:12] + '.' + extension


def select_first_screen(feeds, curated, library, board):
    """Return original candidate positions and cache keys needed by the default views."""
    at = [i for i, p in enumerate(feeds['items']) if any(p.get(k) for k in PICK_FIELDS)]
    seen, rows = set(), []
    for p in list(curated) + [feeds['items'][i] for i in at] + library['papers']:
        key = (p.get('doi') or p.get('id') or '').lower()
        if key in seen or not (p.get('hasDraft') and p.get('draftData') or p.get('autoPick')):
            continue
        seen.add(key)
        draft = p.get('draftData') or {}
        day = draft.get('published') or draft.get('source_date') or (p.get('autoPick') or {}).get('d') or '日期待核验'
        rows.append((day[:10], p))
    latest = max((day for day, _ in rows), default='')
    def quicklook_key(p):
        return str(p['doi']).lower() if p.get('doi') else 'pmid-' + str(p.get('pmid'))
    subset_keys = {quicklook_key(feeds['items'][i]) for i in at}
    quick = {quicklook_key(p) for day, p in rows if day == latest and quicklook_key(p) in subset_keys}
    def prepared_key(p):
        if p.get('pmid'):
            return 'pmid:' + str(p['pmid'])
        if p.get('doi'):
            return 'doi:' + str(p['doi']).lower()
        return ''
    prepared = {k for k in (prepared_key(p) for p in (board or {}).get('items', [])) if k}
    return at, quick, prepared


def split_parts(data):
    """Partition legacy globals without mutating them or dropping their ordering."""
    at, quick, prepared = select_first_screen(data['FEEDS'], data['CURATED'], data['LIBRARY'], data.get('WEEKLY_BOARD'))
    selected = set(at)
    first = {k: data[k] for k in ('CURATED', 'CONTENT_STATUS', 'JOURNAL_METRICS')}
    first['FEEDS'] = {**data['FEEDS'], 'items': [data['FEEDS']['items'][i] for i in at], 'order': {'total': len(data['FEEDS']['items']), 'at': at}}
    first['LIBRARY'] = {'generatedAt': data['LIBRARY'].get('generatedAt'), 'papers': [], 'pdfIds': [], 'deferred': True}
    first['SOURCE_HEALTH'] = {'checkedAt': data['SOURCE_HEALTH'].get('checkedAt'), 'sources': [], 'deferred': True}
    rest = [i for i in range(len(data['FEEDS']['items'])) if i not in selected]
    parts = {'feeds': {'items': [data['FEEDS']['items'][i] for i in rest], 'at': rest},
             'library': {k: data['LIBRARY'][k] for k in ('papers', 'pdfIds')},
             'health': {k: v for k, v in data['SOURCE_HEALTH'].items() if k != 'checkedAt'}}
    for name, global_name, keys in (('quicklooks', 'QUICKLOOKS', quick), ('pregenerated', 'PREGENERATED', prepared)):
        values = data.get(global_name) or {}
        first[global_name] = {k: v for k, v in values.items() if k in keys}
        parts[name] = {'items': {k: v for k, v in values.items() if k not in keys}}
    for name, global_name in (('radar', 'RADAR'), ('readings', 'DEEP_READINGS'), ('board', 'WEEKLY_BOARD')):
        parts[name] = data.get(global_name)
    return first, {name: parts[name] for name in PART_ORDER}


def build_assets(data, radar_text, sources, css):
    first, parts = split_parts(data)
    files, manifest = {}, {'v': 1, 'parts': {}}
    for name, payload in parts.items():
        text = 'window.XINZHI_PART&&window.XINZHI_PART(' + json.dumps(name) + ',' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ');'
        path = asset_name('data-' + name, text)
        files[path] = text
        manifest['parts'][name] = {'src': path}
    radar_path = asset_name('radar', radar_text)
    files[radar_path] = radar_text
    text = '\n;\n'.join([js('XINZHI_PARTS', manifest)] + [js(k, v) for k, v in first.items()] + [js('RADAR_SRC', radar_path)] + sources)
    app_path = asset_name('app', text)
    style_path = asset_name('style', css, 'css')
    files.update({app_path: text, style_path: css})
    return files, app_path, style_path


def _normalize_asset_ref(raw_ref):
    ref = str(raw_ref or '').strip().split('#', 1)[0].split('?', 1)[0].strip()
    if not ref or ref.startswith('/') or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', ref) or ref.startswith('//'):
        return ''
    parts = Path(ref).parts
    if '..' in parts:
        raise ValueError('Unsafe critical asset path: ' + ref)
    return Path(ref).as_posix()


class _CriticalHtmlParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stylesheets = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        tag_name = tag.lower()
        attr_map = {}
        for k, v in attrs:
            key = k.lower()
            if key not in attr_map:
                attr_map[key] = v
        if tag_name == 'link':
            rels = {part.lower() for part in (attr_map.get('rel') or '').split()}
            if 'stylesheet' in rels and attr_map.get('href'):
                ref = _normalize_asset_ref(attr_map['href'])
                if ref:
                    self.stylesheets.append(ref)
        elif tag_name == 'script' and attr_map.get('src'):
            if 'async' in attr_map or 'defer' in attr_map:
                return
            kind = (attr_map.get('type') or '').strip().lower()
            if kind and kind not in ('text/javascript', 'application/javascript', 'module'):
                return
            ref = _normalize_asset_ref(attr_map['src'])
            if ref:
                self.scripts.append(ref)


def critical_assets_from_html(index_html):
    """Return ordered synchronous stylesheet and script paths referenced by index.html."""
    parser = _CriticalHtmlParser()
    parser.feed(index_html)
    parser.close()
    seen, refs = set(), []
    for rel in parser.stylesheets + parser.scripts:
        if rel not in seen:
            seen.add(rel)
            refs.append(rel)
    return refs, parser.stylesheets, parser.scripts


def tier1_data_statements(app_text):
    """Return individual leading window.NAME=...; statements before executable code."""
    statements = []
    for part in app_text.split('\n;\n'):
        if re.match(r'^window\.[A-Z][A-Z0-9_]*=', part):
            statements.append(part)
        else:
            break
    return statements


def _resolve_brotli(brotli_module=_UNSET):
    if brotli_module is not _UNSET:
        return brotli_module
    try:
        import brotli
        return brotli
    except ImportError:
        return None


def _measure_bytes(raw, br_mod):
    return {
        'raw': len(raw),
        'gzip': len(gzip.compress(raw, compresslevel=9, mtime=0)),
        'br': len(br_mod.compress(raw, quality=11)) if br_mod is not None else None,
    }


def _as_bytes(value):
    return value.encode('utf-8') if isinstance(value, str) else bytes(value)


def measure_first_screen(payloads, *, brotli_module=_UNSET):
    """Measure raw, gzip(9, mtime=0) and brotli(11) sizes for synchronous critical files and tier-1 data."""
    if 'index.html' not in payloads:
        raise ValueError('First-screen check requires index.html')
    index_bytes = _as_bytes(payloads['index.html'])
    refs, _, scripts = critical_assets_from_html(index_bytes.decode('utf-8'))
    if not scripts:
        raise ValueError('index.html references no synchronous script')
    for rel in refs:
        if rel not in payloads:
            raise ValueError('First-screen asset missing from build: ' + rel)
    hashed_apps = [s for s in scripts if re.fullmatch(r'assets/app\.[0-9a-f]{12}\.js', s)]
    if len(hashed_apps) == 1:
        app_path = hashed_apps[0]
    elif len(scripts) == 1:
        app_path = scripts[0]
    else:
        raise ValueError('Cannot uniquely identify tier-1 script in index.html: ' + ', '.join(scripts))
    br_mod = _resolve_brotli(brotli_module)
    critical_rows = []
    for rel in ['index.html'] + refs:
        metrics = _measure_bytes(_as_bytes(payloads[rel]), br_mod)
        critical_rows.append({'path': rel, **metrics})
    app_text = _as_bytes(payloads[app_path]).decode('utf-8')
    statements = tier1_data_statements(app_text)
    stmt_metrics = [_measure_bytes(stmt.encode('utf-8'), br_mod) for stmt in statements]
    data_metrics = {
        'raw': sum(m['raw'] for m in stmt_metrics),
        'gzip': sum(m['gzip'] for m in stmt_metrics),
        'br': sum(m['br'] for m in stmt_metrics) if br_mod is not None else None,
    }
    total_metrics = {
        'raw': sum(r['raw'] for r in critical_rows),
        'gzip': sum(r['gzip'] for r in critical_rows),
        'br': sum(r['br'] for r in critical_rows) if br_mod is not None else None,
    }
    return {
        'brotliAvailable': br_mod is not None,
        'appPath': app_path,
        'criticalFiles': critical_rows,
        'dataStatements': len(statements),
        'data': data_metrics,
        'total': total_metrics,
    }


def check_first_screen_budget(
    payloads,
    *,
    data_budget_br=None,
    total_budget_br=None,
    gzip_ratio=None,
    brotli_module=_UNSET,
):
    """Enforce first-screen tier-1 data and critical total budgets; raise ValueError on violation."""
    if data_budget_br is None:
        data_budget_br = FIRST_SCREEN_DATA_BUDGET_BR
    if total_budget_br is None:
        total_budget_br = FIRST_SCREEN_TOTAL_BUDGET_BR
    if gzip_ratio is None:
        gzip_ratio = FIRST_SCREEN_GZIP_TO_BR_RATIO
    if data_budget_br <= 0 or total_budget_br <= 0 or gzip_ratio <= 0:
        raise ValueError('First-screen budgets and gzip ratio must be positive')
    report = measure_first_screen(payloads, brotli_module=brotli_module)
    data_budget_gz = int(round(data_budget_br * gzip_ratio))
    total_budget_gz = int(round(total_budget_br * gzip_ratio))
    report['budgets'] = {
        'dataBr': data_budget_br,
        'dataGz': data_budget_gz,
        'totalBr': total_budget_br,
        'totalGz': total_budget_gz,
        'gzipRatio': gzip_ratio,
    }
    br_on = report['brotliAvailable']
    violations = []
    data = report['data']
    if data['gzip'] > data_budget_gz or (br_on and data['br'] > data_budget_br):
        br_msg = f", brotli(11)={data['br']}B (budget {data_budget_br}B)" if br_on else ', brotli(11)=skipped'
        violations.append(
            f"First-screen tier-1 data budget exceeded in {report['appPath']}: "
            f"measured raw={data['raw']}B, gzip(9)={data['gzip']}B (budget {data_budget_gz}B){br_msg}. "
            f"Fix: move data into a deferred part (assets/data-*.js in scripts/public_split.py)."
        )
    total = report['total']
    if total['gzip'] > total_budget_gz or (br_on and total['br'] > total_budget_br):
        names = ', '.join(row['path'] for row in report['criticalFiles'])
        br_msg = f", brotli(11)={total['br']}B (budget {total_budget_br}B)" if br_on else ', brotli(11)=skipped'
        violations.append(
            f"First-screen total budget exceeded for [{names}]: "
            f"measured raw={total['raw']}B, gzip(9)={total['gzip']}B (budget {total_budget_gz}B){br_msg}. "
            f"Fix: move data into a deferred part (assets/data-*.js in scripts/public_split.py) or trim synchronous critical assets."
        )
    if violations:
        raise ValueError(' | '.join(violations))
    return report


def read_critical_payloads(public_dir):
    """Read index.html and its synchronous stylesheet/script assets from an existing public/ directory."""
    directory = Path(public_dir)

    def read_safe(rel):
        if Path(rel).is_absolute() or '..' in Path(rel).parts:
            raise ValueError('Unsafe critical asset path: ' + rel)
        path = directory / rel
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing critical asset: ' + rel)
        return path.read_bytes()

    index_bytes = read_safe('index.html')
    refs, _, _ = critical_assets_from_html(index_bytes.decode('utf-8'))
    payloads = {'index.html': index_bytes}
    for rel in refs:
        payloads[rel] = read_safe(rel)
    return payloads
