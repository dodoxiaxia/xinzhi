#!/usr/bin/env python3
"""Public PubMed metadata fallback for watched journals. Never downloads PDFs."""
import argparse, datetime, hashlib, json, time, urllib.request, urllib.parse, xml.etree.ElementTree as ET
from pathlib import Path
from build_data import clean, classify
from source_fallbacks import ADDITIONAL_JOURNALS, journal_query

ROOT = Path(__file__).resolve().parents[1]

JOURNALS = [
    'Circulation', 'Circulation Research', 'Circulation Heart Failure',
    'Circulation Cardiovascular Imaging', 'Circulation Cardiovascular Interventions',
    'Circulation Arrhythmia and Electrophysiology', 'Circulation Genomic and Precision Medicine',
    'Hypertension', 'Journal of the American Heart Association', 'Stroke',
    'JACC', 'JACC: Heart Failure', 'JACC: Cardiovascular Interventions',
    'JACC: Clinical Electrophysiology', 'JACC: Cardiovascular Imaging', 'JACC: Advances',
    'European Heart Journal', 'European Heart Journal - Digital Health',
    'European Heart Journal - Cardiovascular Pharmacotherapy', 'European Heart Journal - Cardiovascular Imaging',
    'Europace', 'Cardiovascular Research', 'European Journal of Heart Failure',
    'Heart Rhythm', 'Journal of Cardiovascular Electrophysiology', 'Heart',
    'N Engl J Med', 'NEJM AI', 'NEJM Evid', 'The Lancet', 'The Lancet Digital Health',
    'JAMA', 'JAMA Cardiology', 'JAMA Internal Medicine', 'JAMA Network Open',
    'Nature Medicine', 'npj Digital Medicine', 'Cardiovascular Diabetology', 'BMJ Digital Health & AI'
]
JOURNALS += list(ADDITIONAL_JOURNALS)

def request(action, params):
    endpoint = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/' + action
    encoded = urllib.parse.urlencode(params)
    headers = {'User-Agent': 'XinZhiLearningPilot/0.1 (public journal metadata)'}
    # E-utilities supports POST for long terms; retain every field without a long URI.
    if len(endpoint) + 1 + len(encoded) > 1800:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        req = urllib.request.Request(endpoint, data=encoded.encode('ascii'), headers=headers, method='POST')
    else:
        req = urllib.request.Request(endpoint + '?' + encoded, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(10_000_000)

def parse(root):
    items = []
    for row in root.findall('.//PubmedArticle'):
        article = row.find('./MedlineCitation/Article')
        pmid = row.findtext('./MedlineCitation/PMID')
        if article is None or not pmid:
            continue
        title = clean(''.join(article.find('ArticleTitle').itertext())) if article.find('ArticleTitle') is not None else ''
        journal = article.findtext('./Journal/Title') or article.findtext('./Journal/ISOAbbreviation') or 'PubMed'
        doi = next((n.text for n in row.findall('./PubmedData/ArticleIdList/ArticleId') if n.get('IdType') == 'doi'), '') or ''
        
        # Authors
        authors = []
        for auth in article.findall('./AuthorList/Author'):
            last = auth.findtext('LastName', '').strip()
            fore = (auth.findtext('ForeName', '') or auth.findtext('Initials', '')).strip()
            if last:
                authors.append(f"{last} {fore}".strip())
            elif auth.findtext('CollectiveName'):
                authors.append(auth.findtext('CollectiveName').strip())

        # Affiliations
        affiliations = []
        for aff in article.findall('.//AffiliationInfo/Affiliation'):
            t = clean(''.join(aff.itertext()))
            if t and t not in affiliations:
                affiliations.append(t)

        # Publication types
        pub_types = [clean(''.join(pt.itertext())) for pt in article.findall('./PublicationTypeList/PublicationType')]

        # MeSH terms
        mesh_terms = [clean(''.join(m.find('DescriptorName').itertext())) for m in row.findall('.//MeshHeadingList/MeshHeading') if m.find('DescriptorName') is not None]

        # Abstract sections
        abstract_sections = []
        for n in article.findall('./Abstract/AbstractText'):
            label = (n.get('Label') or '').strip()
            txt = clean(''.join(n.itertext()))
            if txt:
                abstract_sections.append({'label': label, 'text': txt})

        abstract = '\n\n'.join(((s['label'] + ': ') if s['label'] else '') + s['text'] for s in abstract_sections)

        ad = article.find('ArticleDate')
        date_basis = 'ArticleDate'
        if ad is None:
            ad = article.find('./Journal/JournalIssue/PubDate')
            date_basis = 'JournalIssue PubDate'
        date = ''
        if ad is not None:
            year = ad.findtext('Year', '')
            month = ad.findtext('Month', '')
            day = ad.findtext('Day', '')
            if year and month.isdigit() and day.isdigit():
                date = f'{year}-{int(month):02d}-{int(day):02d}'
            elif year:
                date = year + (('-' + month.zfill(2)) if month.isdigit() else '')
            else:
                date = ad.findtext('MedlineDate', '')

        items.append({
            'id': 'pmid-' + pmid,
            'pmid': pmid,
            'title': title,
            'doi': doi.lower().strip(),
            'url': 'https://doi.org/' + doi if doi else 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
            'pubmed_url': 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
            'journal': journal,
            'journalAbbreviation': article.findtext('./Journal/ISOAbbreviation') or '',
            'date': date,
            'dateBasis': date_basis,
            'category': classify(title, journal),
            'basis': 'PubMed 官方结构化元数据',
            'summary': clean(abstract),
            'summary_truncated': False,
            'authors': authors,
            'leadAuthor': authors[0] if authors else '',
            'lastAuthor': authors[-1] if len(authors) > 1 else '',
            'affiliations': affiliations,
            'pubTypes': pub_types,
            'meshTerms': mesh_terms,
            'abstractSections': abstract_sections,
            'sourceId': 'pubmed-journal-fallback',
            'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
        })
    return items

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=30)
    p.add_argument('--limit', type=int, default=1500)
    a = p.parse_args()
    if not 1 <= a.days <= 90 or not 1 <= a.limit <= 2500:
        p.error('days 1..90; limit 1..2500')
    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=a.days)).strftime('%Y/%m/%d')
    end = now.strftime('%Y/%m/%d')
    term = '(' + ' OR '.join(journal_query(j) for j in JOURNALS) + ') AND ("' + start + '"[Date - Publication] : "' + end + '"[Date - Publication])'
    found = json.loads(request('esearch.fcgi', {'db': 'pubmed', 'term': term, 'retmode': 'json', 'retmax': a.limit, 'sort': 'pub date'}))['esearchresult']
    ids = found['idlist']
    time.sleep(0.4)
    items = []
    for offset in range(0, len(ids), 150):
        time.sleep(0.4)
        items.extend(parse(ET.fromstring(request('efetch.fcgi', {'db': 'pubmed', 'id': ','.join(ids[offset:offset+150]), 'retmode': 'xml'}))))
    data = {
        'updatedAt': now.isoformat(),
        'query': term,
        'totalHits': int(found['count']),
        'fetched': len(items),
        'truncated': int(found['count']) > len(ids),
        'journals': JOURNALS,
        'items': items,
        'note': 'Indexing may lag publisher publication; zero hits does not prove the journal has no new articles. Structured XML parsed.'
    }
    (ROOT / 'data/pubmed.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(json.dumps({k: v for k, v in data.items() if k != 'items'}, ensure_ascii=False))

if __name__ == '__main__':
    main()
