#!/usr/bin/env python3
"""媒体热度信号:抓 TCTMD 等新闻源标题,匹配到候选文献,输出 data/media.json。
匹配依据(任一):新闻里出现该文献 DOI;标题去停用词后共有实词 >= 4 且 Jaccard >= 0.35;试验缩写(全大写词≥4字母)相同且共有实词>=2。
只保存标题/链接/日期,不保存正文。失败不影响主流程。"""
import datetime, json, re, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh_feeds as rf
ROOT = Path(__file__).resolve().parents[1]
STOP = set('the of and in for with a an to on vs versus after among from by at is are as or study trial patients patient new may risk use using based analysis results outcomes effect effects association'.split())

def words(t):
    return {w for w in re.findall(r'[a-z0-9\-]{3,}', (t or '').lower()) if w not in STOP}

def acr(t):
    return {w for w in re.findall(r'\b[A-Z][A-Z0-9\-]{3,}\b', t or '')}

def fetch_media(src):
    req = urllib.request.Request(src['url'], headers={'User-Agent': 'XinZhiLearningPilot/0.1 (headline signals)'})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read(3_000_001)
    try:
        root = rf.ET.fromstring(raw)
    except rf.ET.ParseError:
        root = rf.lenient_root(raw)
    out = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for e in root.iter():
        if e.tag.split('}')[-1] not in ('item', 'entry'):
            continue
        title = rf.clean(rf.text(e, 'title')); link = rf.text(e, 'link')
        if not link:
            for n in e:
                if n.tag.split('}')[-1] == 'link' and n.get('href'):
                    link = n.get('href'); break
        d = rf.dateval(rf.text(e, 'pubDate') or rf.text(e, 'date') or rf.text(e, 'published') or rf.text(e, 'updated'))
        if not (title and link.startswith('http')):
            continue
        if d and (now - datetime.datetime.fromisoformat(d)).days > 21:
            continue
        desc = rf.text(e, 'description') or rf.text(e, 'summary') or rf.text(e, 'encoded')
        out.append({'source': src['name'], 'weight': src.get('weight', 1), 'title': title, 'url': link, 'date': d, 'doi': rf.extract_doi(link, e) or '',
                    'dois': [x.lower() for x in re.findall(r'10\.\d{4,9}/[^\s"<>\)]+', desc or '')]})
    return out

def match(items, news):
    res = {}
    for p in items:
        pid = p['id']; pw = words(p.get('title')); pa = acr(p.get('title')); doi = str(p.get('doi') or '').lower()
        for n in news:
            hit = bool(doi and (doi in n['dois'] or doi == n['doi'].lower()))
            if not hit and pw:
                nw = words(n['title']); com = pw & nw
                if len(com) >= 4 and len(com) / len(pw | nw) >= 0.35:
                    hit = True
                elif pa & acr(n['title']) and len(com) >= 2:
                    hit = True
            if hit:
                res.setdefault(pid, []).append({'s': n['source'], 't': n['title'], 'u': n['url'], 'd': n['date'], 'w': n['weight']})
    return res

def main():
    cfg = json.loads((ROOT / 'data/media_sources.json').read_text(encoding='utf-8'))
    news, reports = [], []
    for s in cfg['sources']:
        if not s.get('enabled'):
            continue
        try:
            got = fetch_media(s); news += got; reports.append({'source': s['name'], 'ok': True, 'items': len(got)})
        except Exception as e:
            reports.append({'source': s['name'], 'ok': False, 'error': str(e)[:160]})
    cand = json.loads((ROOT / 'data/candidates.json').read_text(encoding='utf-8'))['items']
    lib = json.loads((ROOT / 'data/library.json').read_text(encoding='utf-8'))['papers']
    matches = match(cand + [q for q in lib if q.get('date', '') >= (datetime.date.today() - datetime.timedelta(days=21)).isoformat()], news)
    out = {'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reports': reports, 'newsCount': len(news), 'matches': matches}
    (ROOT / 'data/media.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({'reports': reports, 'news': len(news), 'matched': len(matches)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
