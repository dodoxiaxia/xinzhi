"""Lazy browser bootstrap inside the existing six-file public release.

public.js remains a complete classic bundle for old documents and local fallback.
Pages' existing ASSETS binding serves selected public JSON assignments on demand.
"""
import hashlib
import json
import re
import datetime
from ci_daily import stable_data


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def prepare(data, code, support_code=''):
    data = dict(data)
    radar = data.get('RADAR')
    if radar:
        today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
        dates = [(p.get('date') or '')[:10] for p in data['FEEDS']['items']
                 if re.fullmatch(r'\d{4}-\d{2}-\d{2}', (p.get('date') or '')[:10]) and p['date'][:10] <= today]
        anchor = max(dates, default=today)
        floor = (datetime.date.fromisoformat(anchor) - datetime.timedelta(days=13)).isoformat()
        rows = [row for row in radar['rows'] if row[2][:10] >= floor]
        ids = {str(row[0]) for row in rows}
        data['RECENT_RADAR'] = dict(radar, rows=rows,
                                   abs={k: v for k, v in radar.get('abs', {}).items() if k in ids},
                                   zh={k: v for k, v in radar.get('zh', {}).items() if k in ids})
    stable = json.dumps(stable_data(data), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    version = hashlib.sha256((stable + '\n' + code + '\n' + support_code).encode()).hexdigest()
    bundle = '\n;\n'.join(['window.PUBLIC_DATA_VERSION=' + json_text(version) + ';'] +
                         ['window.' + key + '=' + json_text(value) + ';' for key, value in data.items()] + [code])
    core = dict(data)
    core.pop('RADAR', None)
    core.pop('RECENT_RADAR', None)
    feeds = data['FEEDS']
    core['FEEDS'] = dict(feeds, items=[p for p in feeds['items']
                                    if p.get('autoPick') or p.get('weeklyPick') or p.get('hasDraft')])
    # Preserve enough information for the live 14-day badge, including cached/offline
    # pages opened on a later date. This is metadata, not the full abstract archive.
    count_rows = {}
    minor = re.compile(r'^(author correction|publisher correction|correction to|correction:|erratum|retraction|letter by|response by|reply to|reply by|comment on|regarding)', re.I)
    count_papers = list(feeds['items'])
    seen = {key for p in feeds['items'] for key in
            (str(p.get('doi') or '').lower(), 'pmid:' + str(p.get('pmid'))) if key and key != 'pmid:None'}
    for row in (data.get('RADAR') or {}).get('rows', []):
        if row[1] and row[1] in seen or 'pmid:' + str(row[0]) in seen:
            continue
        count_papers.append({'title': row[8], 'date': row[2], 'datePrecision': 'day'})
    for p in count_papers:
        title = p.get('title') or ''
        prefix = re.match(r'^\[([A-Za-z ]+)\]\s*', title)
        kind = prefix.group(1) if prefix else ''
        if prefix:
            title = title[prefix.end():]
        precision = p.get('datePrecision')
        date_value = p.get('date') or ''
        if not precision:
            precision = 'unknown' if not date_value else 'month' if re.fullmatch(r'\d{4}-\d{2}', date_value) or (date_value[8:10] == '01' and re.search(r'published-print|正式期号', p.get('dateBasis') or '')) else 'day'
        if kind != 'Correspondence' and not minor.search(title) and precision == 'day':
            date = (p.get('date') or '')[:10]
            count_rows[date] = count_rows.get(date, 0) + 1
    boot = {'schemaVersion': 1, 'version': version, 'data': core,
            'counts': {'library': len(data['LIBRARY']['papers']), 'radarDates': count_rows},
            'deferred': [name for name in ('FEEDS', 'RECENT_RADAR', 'RADAR') if name in data]}
    return bundle, boot


def inline_boot(index, boot, loader, code):
    # Public abstracts may contain HTML snippets; never let them close a script tag.
    payload = json_text(boot).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    source = re.sub(r'</script', r'<\\/script', loader + '\n;\n' + code, flags=re.I)
    scripts = '<script data-public-data-boot>window.PUBLIC_DATA_BOOT=' + payload + ';</script>\n<script>' + source + '</script>'
    if index.count('<script src="public.js"></script>') != 1:
        raise ValueError('Lazy bootstrap requires exactly one classic bundle entry')
    return index.replace('<script src="public.js"></script>', scripts)


def stable_index(text):
    """Normalize only the builder-owned bootstrap JSON, never arbitrary HTML/JS."""
    marker = '<script data-public-data-boot>window.PUBLIC_DATA_BOOT='
    start = text.find(marker)
    if start < 0:
        return text
    end = start + len(marker)
    value, length = json.JSONDecoder().raw_decode(text[end:])
    if not text[end + length:].startswith(';</script>'):
        raise ValueError('Malformed public bootstrap assignment')
    normalized = json.dumps(stable_data(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return text[:end] + normalized + text[end + length:]
