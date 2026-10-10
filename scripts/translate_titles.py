#!/usr/bin/env python3
"""Chinese title translation cache (中英对照). Private cache: data/translations.json  {"pmid:123"|"doi:10.x": "中文标题"}.
Only titles are translated here (whole 365-day archive + candidates + library). Run daily; it translates only what is missing.

Config (same as generate_quicklooks.py): .local/llm.json {endpoint, api_key, model} or env XINZHI_LLM_ENDPOINT/API_KEY/MODEL.
  python3 scripts/translate_titles.py                 # dry run: how many are missing
  python3 scripts/translate_titles.py --run --limit 40   # up to 40 API calls x 30 titles (newest first)
Output is machine translation; the site labels it 机器翻译. Numbers/drug/trial names are kept as in the original.
"""
import argparse, json, os, sys, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/translations.json'
BATCH = 30
PROMPT = ('你是心血管与医学AI领域的专业译者。把用户给出的英文论文标题逐条译为准确、简洁的中文医学标题。'
          '保留试验名/缩写/药物名/数字（如 DAPA-HF、PCI、GLP-1）原样，不添加解释。'
          '只输出JSON对象：键为输入编号(字符串)，值为中文标题。')


def keyof(p):
    if p.get('pmid'):
        return 'pmid:%s' % p['pmid']
    return ('doi:%s' % str(p['doi']).lower()) if p.get('doi') else ''


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
    # Daily/weekly picks first (they lead the home page), then newest first.
    picked, items = picked_ids(), []
    for p in rj(ROOT / 'data/candidates.json', {'items': []})['items'] + rj(ROOT / 'data/library.json', {'papers': []})['papers']:
        items.append((p.get('id') in picked, p.get('date') or '', keyof(p), p.get('title', '')))
    for r in rj(ROOT / 'data/radar-archive.json', {'rows': []})['rows']:
        items.append(('pmid-%s' % r['pmid'] in picked, r.get('date') or '', 'pmid:%s' % r['pmid'], r.get('title', '')))
    seen, out = set(), []
    for _, d, k, t in sorted(items, reverse=True):
        if k and t and k not in seen:
            seen.add(k)
            out.append((k, t))
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--limit', type=int, default=10)
    a = ap.parse_args()
    have = rj(OUT, {})
    todo = [(k, t) for k, t in collect() if k not in have]
    if not a.run:
        print(json.dumps({'cached': len(have), 'missing': len(todo), 'calls_needed': -(-len(todo) // BATCH)}))
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
        for j, (k, _) in enumerate(chunk):
            z = str(res.get(str(j), '')).strip()
            if z and any('一' <= c <= '鿿' for c in z):
                have[k] = z
                done += 1
        tmp = OUT.with_suffix('.tmp')
        tmp.write_text(json.dumps(have, ensure_ascii=False, separators=(',', ':')))
        tmp.replace(OUT)
    print(json.dumps({'translated': done, 'cached': len(have), 'missing': len(todo) - done}))


if __name__ == '__main__':
    main()
