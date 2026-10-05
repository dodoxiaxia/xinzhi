#!/usr/bin/env python3
"""Private backend store of full PubMed details for the 365-day radar archive.

data/archive-full.json  {pmid: {a:[{l,t}], au, af, m, k, d, pmc, pt, lg, src, ts}}
  a=abstract sections (label,text) au=authors af=first affiliations m=MeSH k=keywords
  d=doi pmc=PMC id pt=pubtypes lg=language src=where the abstract came from.
This file is NEVER copied into the public bundle (build_public.py only reads a small newest-days slice).

Usage
  python3 scripts/archive_details.py --seed work/xinzhi-radar-details.json   # ingest a browser-fetched dump
  python3 scripts/archive_details.py --fill                                  # daily: efetch PMIDs missing details,
                                                                              # then OpenAlex/Crossref for still-empty abstracts
"""
import argparse, datetime, html, json, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data/archive-full.json'
ARCH = ROOT / 'data/radar-archive.json'
UA = {'User-Agent': 'XinZhiLearningPilot/0.2 (public journal metadata; mailto:shijunxia1988@gmail.com)'}


def get(url, tries=3, raw=False):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                b = r.read(30_000_000)
                return b if raw else json.loads(b)
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(1.5 * (i + 1))


def txt(e):
    return ''.join(e.itertext()).strip() if e is not None else ''


def parse_efetch(xml_bytes):
    out = {}
    root = ET.fromstring(xml_bytes)
    for art in root.iter('PubmedArticle'):
        pmid = txt(art.find('.//MedlineCitation/PMID'))
        secs = [{'l': (a.get('Label') or a.get('NlmCategory') or '').strip(), 't': txt(a)} for a in art.findall('.//Abstract/AbstractText')]
        au = []
        af = []
        for x in art.findall('.//AuthorList/Author'):
            n = (txt(x.find('LastName')) + ' ' + txt(x.find('Initials'))).strip() or txt(x.find('CollectiveName'))
            if n:
                au.append(n)
            if len(af) < 3:
                a1 = txt(x.find('AffiliationInfo/Affiliation'))
                if a1 and a1 not in af:
                    af.append(a1)
        ids = {i.get('IdType'): txt(i) for i in art.findall('.//PubmedData/ArticleIdList/ArticleId')}
        out[pmid] = {'a': [s for s in secs if s['t']], 'au': au, 'af': af,
                     'm': [txt(m) for m in art.findall('.//MeshHeadingList/MeshHeading/DescriptorName')][:15],
                     'k': [txt(k) for k in art.findall('.//KeywordList/Keyword')][:12],
                     'd': ids.get('doi', ''), 'pmc': ids.get('pmc', ''),
                     'pt': [txt(p) for p in art.findall('.//PublicationTypeList/PublicationType')],
                     'lg': txt(art.find('.//Language')), 'src': 'pubmed'}
    return out


def load():
    return json.loads(STORE.read_text()) if STORE.exists() else {}


def save(d):
    STORE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))


def openalex_abs(doi):
    j = get('https://api.openalex.org/works/doi:%s?select=abstract_inverted_index&mailto=shijunxia1988@gmail.com' % urllib.parse.quote(doi, safe='/'))
    ii = (j or {}).get('abstract_inverted_index')
    if not ii:
        return ''
    pos = sorted((p, w) for w, ps in ii.items() for p in ps)
    return ' '.join(w for _, w in pos)


def epmc_abs(doi):
    j = get('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query=' + urllib.parse.quote('DOI:"%s"' % doi))
    r = (((j or {}).get('resultList') or {}).get('result') or [{}])[0]
    t = html.unescape(re.sub(r'<[^>]+>', ' ', r.get('abstractText') or '')).strip()
    return t if len(t) >= 200 else ''


def crossref_abs(doi):
    j = get('https://api.crossref.org/works/%s?mailto=shijunxia1988@gmail.com' % urllib.parse.quote(doi, safe='/'))
    a = ((j or {}).get('message') or {}).get('abstract') or ''
    return html.unescape(re.sub(r'<[^>]+>', ' ', a)).strip()


def fill(limit_alt=300):
    store = load()
    ids = [str(r['pmid']) for r in json.loads(ARCH.read_text())['rows']] if ARCH.exists() else []
    need = [i for i in ids if i not in store]
    for k in range(0, len(need), 200):
        b = get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' + urllib.parse.urlencode(
            {'db': 'pubmed', 'id': ','.join(need[k:k + 200]), 'retmode': 'xml'}), raw=True)
        if b:
            store.update({p: dict(v, ts=datetime.date.today().isoformat()) for p, v in parse_efetch(b).items()})
        time.sleep(0.4)
    # abstracts still empty: try OpenAlex then Crossref (PubMed usually catches up within days; recheck only recent)
    n = 0
    cutoff = (datetime.date.today() - datetime.timedelta(days=45)).isoformat()
    dates = {str(r['pmid']): r['date'] for r in json.loads(ARCH.read_text())['rows']} if ARCH.exists() else {}
    for p, v in store.items():
        if n >= limit_alt:
            break
        if v.get('a') or not v.get('d') or (dates.get(p) or '') < cutoff:
            continue
        n += 1
        t = openalex_abs(v['d']) or crossref_abs(v['d'])
        if t:
            v['a'] = [{'l': '', 't': t}]
            v['src'] = 'openalex/crossref'
        time.sleep(0.2)
    # RSS 候选里“有 DOI 但没有摘要”的条目（很多还没进 PubMed 存档）：按 DOI 依次试 Europe PMC / OpenAlex / Crossref，键为 doi:<doi>
    cand = json.loads((ROOT / 'data/candidates.json').read_text()).get('items', []) if (ROOT / 'data/candidates.json').exists() else []
    known = {str(v.get('d', '')).lower() for v in store.values() if v.get('a')}
    m = 0
    for c in cand:
        if m >= limit_alt:
            break
        d = str(c.get('doi') or '').lower()
        if not d or c.get('summary') or d in known or store.get('doi:' + d, {}).get('a'):
            continue
        last = store.get('doi:' + d, {}).get('ts')
        if last == datetime.date.today().isoformat():
            continue
        m += 1
        t, src = epmc_abs(d), 'europepmc'
        if not t:
            t, src = openalex_abs(d), 'openalex'
        if not t:
            t, src = crossref_abs(d), 'crossref'
        store['doi:' + d] = {'a': [{'l': '', 't': t}] if t else [], 'd': d, 'src': src if t else 'none', 'ts': datetime.date.today().isoformat()}
        time.sleep(0.2)
    save(store)
    print(json.dumps({'store': len(store), 'fetched': len(need), 'alt_tried': n, 'cand_tried': m}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=Path)
    ap.add_argument('--fill', action='store_true')
    a = ap.parse_args()
    if a.seed:
        s = load()
        new = json.loads(a.seed.read_text())
        for p, v in new.items():
            v.setdefault('src', 'pubmed')
            s[p] = {**s.get(p, {}), **v}
        save(s)
        print(json.dumps({'store': len(s), 'withAbstract': sum(1 for v in s.values() if v.get('a'))}))
    if a.fill:
        fill()


if __name__ == '__main__':
    main()
