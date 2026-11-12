#!/usr/bin/env python3
"""Public PubMed metadata fallback for watched journals. Never downloads PDFs.

An error or partial E-utilities payload (HTTP 5xx, timeout, ERROR field, or an
esearch result without idlist) is retried a bounded number of times. The previous
data/pubmed.json is replaced only after a complete search and fetch succeed.
"""
import argparse, datetime, hashlib, http.client, json, os, time, urllib.request, urllib.parse, urllib.error, xml.etree.ElementTree as ET
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
TRANSIENT_HTTP = {429, 500, 502, 503, 504}
REQUEST_ATTEMPTS = 3
REQUEST_TIMEOUT = 30

class PubmedError(RuntimeError):
    """A complete public metadata response was not obtained. The previous file stays."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)

def request(action, params, attempts=REQUEST_ATTEMPTS):
    endpoint = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/' + action
    encoded = urllib.parse.urlencode(params)
    headers = {'User-Agent': 'XinZhiLearningPilot/0.1 (public journal metadata)'}
    # E-utilities supports POST for long terms; retain every field without a long URI.
    if len(endpoint) + 1 + len(encoded) > 1800:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        req = urllib.request.Request(endpoint, data=encoded.encode('ascii'), headers=headers, method='POST')
    else:
        req = urllib.request.Request(endpoint + '?' + encoded, headers=headers)
    last = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                return r.read(10_000_000)
        except urllib.error.HTTPError as exc:
            # CI retains only the tail of stderr. Keep the failed public action
            # identifiable there, without logging query/IDs/headers. A client
            # error is not retried. 429 and 5xx are bounded and then re-raised.
            detail = ''
            try:
                body = exc.read(4096).decode('utf-8', 'replace')
                try:
                    message = json.loads(body).get('error', '')
                except (ValueError, AttributeError):
                    xml = ET.fromstring(body)
                    match = xml if xml.tag == 'ERROR' else xml.find('.//ERROR')
                    message = ''.join(match.itertext()) if match is not None else ''
                if isinstance(message, str):
                    detail = ' '.join(message.split())[:200]
            except (OSError, AttributeError, ET.ParseError):
                pass
            exc.add_note(json.dumps({'publicPubmedRequest': action,
                                     'method': req.get_method(),
                                     'httpStatus': exc.code,
                                     'upstreamError': detail}, ensure_ascii=False))
            last = exc
            if exc.code not in TRANSIENT_HTTP or attempt == attempts - 1:
                raise
        except (http.client.IncompleteRead, TimeoutError, urllib.error.URLError, OSError) as exc:
            # Discard partial bytes and retry the same public metadata request.
            last = exc
            if attempt == attempts - 1:
                raise
        time.sleep(0.5 * (attempt + 1))
    raise last

def _error_text(value):
    if isinstance(value, str) and value.strip():
        return True
    return isinstance(value, list) and any(isinstance(item, str) and item.strip() for item in value)

def parse_esearch(payload):
    """Return the esearch result only when it has a real id list.

    NCBI sometimes answers HTTP 200 with an ERROR field and no idlist. That is
    not an empty search. An empty idlist with a count is a complete zero-hit result.
    """
    if not isinstance(payload, dict):
        raise PubmedError('pubmed_response_invalid')
    if _error_text(payload.get('ERROR')) or _error_text(payload.get('error')):
        raise PubmedError('pubmed_upstream_error')
    found = payload.get('esearchresult')
    if not isinstance(found, dict):
        raise PubmedError('pubmed_esearchresult_missing')
    if _error_text(found.get('ERROR')) or _error_text(found.get('error')):
        raise PubmedError('pubmed_upstream_error')
    if 'idlist' not in found or not isinstance(found.get('idlist'), list):
        raise PubmedError('pubmed_idlist_missing')
    if any(type(item) is not str or not item.isdigit() for item in found['idlist']):
        raise PubmedError('pubmed_idlist_invalid')
    if not isinstance(found.get('count'), str) or not found['count'].isdigit():
        raise PubmedError('pubmed_count_missing')
    return found

def load_esearch(params, attempts=REQUEST_ATTEMPTS):
    """Search once per attempt. Transport and error payloads share one retry budget."""
    last = None
    for attempt in range(attempts):
        try:
            return parse_esearch(json.loads(request('esearch.fcgi', params, attempts=1)))
        except PubmedError as exc:
            last = exc
        except (json.JSONDecodeError, UnicodeError):
            last = PubmedError('pubmed_response_invalid')
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in TRANSIENT_HTTP:
                raise
        except (http.client.IncompleteRead, TimeoutError, urllib.error.URLError, OSError) as exc:
            last = exc
        if attempt == attempts - 1:
            raise last
        time.sleep(0.5 * (attempt + 1))
    raise last

def parse_fetch(raw):
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise PubmedError('pubmed_efetch_invalid') from exc
    if root.tag == 'ERROR' or root.find('.//ERROR') is not None:
        raise PubmedError('pubmed_efetch_error')
    return parse(root)

def commit_output(path, data):
    """Replace path only after the full JSON text exists. A failure leaves the previous file."""
    text = json.dumps(data, ensure_ascii=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.tmp')
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

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
        from publication_status import pubmed_relations

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
            'pubmedRelations': pubmed_relations(row),
            'meshTerms': mesh_terms,
            'abstractSections': abstract_sections,
            'sourceId': 'pubmed-journal-fallback',
            'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
        })
    return items

def refresh(path, days, limit, now=None):
    """Fetch a complete PubMed snapshot. On any incomplete response, path is left unchanged."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=days)).strftime('%Y/%m/%d')
    end = now.strftime('%Y/%m/%d')
    term = '(' + ' OR '.join(journal_query(j) for j in JOURNALS) + ') AND ("' + start + '"[Date - Publication] : "' + end + '"[Date - Publication])'
    found = load_esearch({'db': 'pubmed', 'term': term, 'retmode': 'json', 'retmax': limit, 'sort': 'pub date'})
    ids = found['idlist']
    time.sleep(0.4)
    items = []
    for offset in range(0, len(ids), 150):
        time.sleep(0.4)
        items.extend(parse_fetch(request('efetch.fcgi', {'db': 'pubmed', 'id': ','.join(ids[offset:offset+150]), 'retmode': 'xml'})))
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
    commit_output(path, data)
    return data

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=30)
    p.add_argument('--limit', type=int, default=1500)
    a = p.parse_args()
    if not 1 <= a.days <= 90 or not 1 <= a.limit <= 2500:
        p.error('days 1..90; limit 1..2500')
    data = refresh(ROOT / 'data/pubmed.json', a.days, a.limit)
    print(json.dumps({k: v for k, v in data.items() if k != 'items'}, ensure_ascii=False))

if __name__ == '__main__':
    main()
