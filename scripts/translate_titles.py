#!/usr/bin/env python3
"""Chinese title translation cache (中英对照). Private cache: data/translations.json  {"pmid:123"|"doi:10.x": "中文标题"}.
Only titles are translated here (whole 365-day archive + candidates + library).
New titles and unusable cached titles share the daily batch limit.

Config (same as generate_quicklooks.py): .local/llm.json {endpoint, api_key, model} or env XINZHI_LLM_ENDPOINT/API_KEY/MODEL.
  python3 scripts/translate_titles.py                 # dry run: count missing and invalid cached titles
  python3 scripts/translate_titles.py --run --limit 40   # up to 40 API calls x 30 titles (held first, then oldest missing)
Output is machine translation; the site labels it 机器翻译. Numbers/drug/trial names are kept as in the original.
"""
import argparse, json, os, sys, urllib.request, urllib.parse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from resolve_dois import translation_title_key
from source_title_quality import usable_source_title
from text_hygiene import model_text

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/translations.json'
BATCH = 30
PROMPT = ('你是心血管与医学AI领域的专业译者。把用户给出的英文论文标题逐条译为准确、简洁的中文医学标题。'
          '保留试验名/缩写/药物名/数字（如 DAPA-HF、PCI、GLP-1）原样，不添加解释。'
          '只输出JSON对象：键为输入编号(字符串)，值为中文标题。')


def keyof(p):
    if p.get('pmid'):
        return 'pmid:%s' % p['pmid']
    if p.get('doi'):
        return 'doi:%s' % str(p['doi']).lower()
    return translation_title_key(p.get('title'))  # includes short headlines, e.g. OpenAI News


def rj(path, fb):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return fb


def picked_ids():
    picks = rj(ROOT / 'data/picks.json', {})
    ids = set(x for x in picks.get('weekly') or [] if isinstance(x, str))
    for day in (picks.get('daily') or {}).values():
        ids.update(x for x in day or [] if isinstance(x, str))
    return ids


def collect():
    # Unique papers from candidates, library and the radar archive.
    picked, items = picked_ids(), []
    for p in rj(ROOT / 'data/candidates.json', {'items': []})['items'] + rj(ROOT / 'data/library.json', {'papers': []})['papers']:
        items.append((p.get('id') in picked, p.get('date') or '', keyof(p), p))
    for r in rj(ROOT / 'data/radar-archive.json', {'rows': []})['rows']:
        paper = {'pmid': r['pmid'], 'doi': r.get('doi', ''), 'title': r.get('title', ''), 'date': r.get('date', '')}
        items.append(('pmid-%s' % r['pmid'] in picked, r.get('date') or '', 'pmid:%s' % r['pmid'], paper))
    seen, out = set(), []
    for _, d, k, p in items:
        if k and p.get('title') and k not in seen:
            seen.add(k)
            out.append((k, p.get('title', ''), d, p))
    return out


def call(cfg, titles):
    body = {'model': cfg['model'], 'temperature': 0.1, 'max_tokens': 4000, 'response_format': {'type': 'json_object'},
            'messages': [{'role': 'system', 'content': PROMPT},
                         {'role': 'user', 'content': json.dumps({str(i): t for i, t in enumerate(titles)}, ensure_ascii=False)}]}
    if cfg['model'].startswith('glm-5.3'):
        body['reasoning_effort'] = 'low'
    elif cfg['model'].startswith('glm-'):
        body['thinking'] = {'type': 'disabled'}
    req = urllib.request.Request(cfg['endpoint'], data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg['api_key']})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read(500_000))
    return json.loads(resp['choices'][0]['message']['content'])


def translated_title(value):
    if isinstance(value, str):
        try:
            return model_text(value, single_line=True)
        except ValueError:
            pass  # Regenerate instead of guessing the missing character.
    return ''


def save_cache(have):
    tmp = OUT.with_suffix('.tmp')
    tmp.write_text(json.dumps(have, ensure_ascii=False, separators=(',', ':')),
                   encoding='utf-8', errors='backslashreplace')
    tmp.replace(OUT)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--limit', type=int, default=10)
    a = ap.parse_args()
    have = rj(OUT, {})
    invalid_cached = {key for key, value in have.items() if not translated_title(value)}
    rows = [row for row in collect() if row[0] not in have or row[0] in invalid_cached]
    usable, skipped = [], []
    for key, title, date, paper in rows:
        ok, reason = usable_source_title(paper)
        if ok:
            usable.append((key, title, date, paper))
        else:
            skipped.append({'key': key, 'doi': paper.get('doi') or '', 'reason': reason, 'title': title})
    from title_translation_hold import load_ledger
    held_keys = set((load_ledger(ROOT).get('entries') or {}))
    # Held papers first (they block the public list), then oldest missing so
    # earlier library gaps are not starved by a fast batch of only newest titles.
    def sort_key(row):
        key, title, date, paper = row
        return (0 if key in held_keys else 1, date or '9999', key)
    todo = [(k, t) for k, t, _, _ in sorted(usable, key=sort_key)]
    if skipped:
        print('skipping unusable source titles:', file=sys.stderr)
        for item in skipped:
            print('  %s  %s  %s' % (item['doi'] or item['key'], item['reason'], item['title'][:120]), file=sys.stderr)
    if not a.run:
        print(json.dumps({'cached': len(have) - len(invalid_cached), 'invalid_cached': len(invalid_cached),
                          'missing': len(todo), 'skipped_unusable': len(skipped),
                          'calls_needed': -(-len(todo) // BATCH)}))
        return
    cfg = rj(ROOT / '.local/llm.json', {})
    cfg = {'endpoint': os.environ.get('XINZHI_LLM_ENDPOINT') or cfg.get('endpoint', ''),
           'api_key': os.environ.get('XINZHI_LLM_API_KEY') or cfg.get('api_key', ''),
           'model': os.environ.get('XINZHI_LLM_MODEL') or cfg.get('model', '')}
    u = urllib.parse.urlparse(cfg['endpoint'])
    if not all(cfg.values()) or u.scheme != 'https' or not u.hostname:
        sys.exit('LLM config missing (.local/llm.json or XINZHI_LLM_* env)')
    done = 0
    for i in range(0, min(len(todo), a.limit * BATCH), BATCH):
        chunk = todo[i:i + BATCH]
        try:
            res = call(cfg, [t for _, t in chunk])
        except Exception as e:
            print('batch failed:', type(e).__name__, file=sys.stderr)
            break
        translations = {}
        rejected = []
        for j, (k, title) in enumerate(chunk):
            raw = res.get(str(j))
            z = translated_title(raw)
            if z and any('一' <= c <= '鿿' for c in z):
                translations[k] = z
            else:
                reason = 'translation_rejected_hygiene' if raw and not z else 'translation_rejected_no_han'
                rejected.append((k, title, reason))
        if rejected:
            print('translation rejected, will retry:', file=sys.stderr)
            for key, title, reason in rejected:
                print('  %s  %s  %s' % (key, reason, title[:120]), file=sys.stderr)
        if translations:
            have.update(translations)
            invalid_cached.difference_update(translations)
            save_cache(have)
            done += len(translations)
    print(json.dumps({'translated': done, 'cached': len(have) - len(invalid_cached),
                      'invalid_cached': len(invalid_cached), 'skipped_unusable': len(skipped),
                      'missing': len(todo) - done}))


if __name__ == '__main__':
    main()
