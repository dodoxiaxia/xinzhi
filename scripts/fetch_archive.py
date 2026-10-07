#!/usr/bin/env python3
"""365-day PubMed title archive for the radar's 30 / 90 / 365-day views.

Titles + journal + date only (no abstracts, no PDFs). Abstracts are fetched on demand in the browser.
Scope = watched cardiology journals (all items) + AI-medicine journals (all items)
        + general journals (only items whose title/abstract mention cardiology or AI terms).
Letters, comments, errata and news are excluded at query time and again on ingest.

Usage
  python3 scripts/fetch_archive.py                 # live: rebuild the full window from PubMed (needs network)
  python3 scripts/fetch_archive.py --incremental   # live: only the last few days, merged into the archive (daily job)
  python3 scripts/fetch_archive.py --seed FILE     # ingest {pmid: esummary-fields} saved by a browser session
Output: data/radar-archive.json (private working file; build_public.py turns it into the compact public form).
"""
import argparse, datetime, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path
from build_data import clean

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/radar-archive.json'
WINDOW_DAYS = 365
KEEP_DAYS = 400

GROUPS = {
    'cardio_a': ['Circulation', 'Circulation Research', 'Circulation Heart Failure', 'Circulation Cardiovascular Imaging',
                 'Circulation Cardiovascular Interventions', 'Circulation Arrhythmia and Electrophysiology',
                 'Circulation Genomic and Precision Medicine', 'Hypertension', 'Journal of the American Heart Association', 'Stroke',
                 'Europace', 'Cardiovascular Research', 'Heart Rhythm', 'Journal of Cardiovascular Electrophysiology', 'Heart',
                 'Cardiovascular Diabetology'],
    'cardio_b': ['JACC', 'JACC: Heart Failure', 'JACC: Cardiovascular Interventions', 'JACC: Clinical Electrophysiology',
                 'JACC: Cardiovascular Imaging', 'JACC: Advances', 'European Heart Journal',
                 'European Heart Journal - Cardiovascular Pharmacotherapy', 'European Heart Journal - Cardiovascular Imaging',
                 'European Journal of Heart Failure', 'JAMA Cardiology'],
    'general': ['N Engl J Med', 'Lancet', 'JAMA', 'JAMA Internal Medicine', 'JAMA Network Open', 'Nature Medicine', 'BMJ'],
    'ai_med': ['NEJM AI', 'Lancet Digital Health', 'npj Digital Medicine', 'European Heart Journal - Digital Health',
               'BMJ Digital Health & AI'],
}
TERMS = ('(cardiac[tiab] OR cardiovascular[tiab] OR heart[tiab] OR atrial[tiab] OR ventricular[tiab] OR coronary[tiab] OR '
         'arrhythmia*[tiab] OR ECG[tiab] OR electrocardiogra*[tiab] OR stroke[tiab] OR myocardial[tiab] OR hypertension[tiab] OR '
         'aortic[tiab] OR cardiomyopathy[tiab] OR atherosclero*[tiab] OR anticoagul*[tiab] OR pacemaker[tiab] OR '
         '"artificial intelligence"[tiab] OR "machine learning"[tiab] OR "deep learning"[tiab] OR "language model*"[tiab] OR '
         '"neural network*"[tiab])')
NOT = (' NOT (Letter[pt] OR "Published Erratum"[pt] OR Comment[pt] OR News[pt] OR "Retraction of Publication"[pt] OR '
       'Interview[pt] OR Biography[pt])')
SKIP_PT = {'Letter', 'Comment', 'Published Erratum', 'News', 'Retraction of Publication', 'Interview', 'Biography', 'Erratum'}
MONTHS = {m: i for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], 1)}


def queries(start, end):
    d = ' AND ("%s"[dp] : "%s"[dp])' % (start, end)
    jt = lambda names: '(' + ' OR '.join('"%s"[Journal]' % j for j in names) + ')'
    return {
        'cardio_a': jt(GROUPS['cardio_a']) + d + NOT,
        'cardio_b': jt(GROUPS['cardio_b']) + d + NOT,
        'general': jt(GROUPS['general']) + ' AND ' + TERMS + d + NOT,
        'ai_med': jt(GROUPS['ai_med']) + d + NOT,
    }


def parse_date(raw):
    """'2026 Sep 15' -> ('2026-09-15','day'); '2026 Sep' -> ('2026-09','month'); '2026' -> ('2026','year')."""
    raw = (raw or '').strip()
    m = re.match(r'^(\d{4})\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})\b', raw)
    if m and m.group(2).title() in MONTHS:
        return '%s-%02d-%02d' % (m.group(1), MONTHS[m.group(2).title()], int(m.group(3))), 'day'
    m = re.match(r'^(\d{4})\s+([A-Za-z]{3})', raw)
    if m and m.group(2).title() in MONTHS:
        return '%s-%02d' % (m.group(1), MONTHS[m.group(2).title()]), 'month'
    m = re.match(r'^(\d{4})', raw)
    return (m.group(1), 'year') if m else ('', '')


def clean_title(t):
    t = clean(t)
    return t[:-1] if t.endswith('.') and not t.endswith('..') else t


def ingest(summaries):
    """esummary-style {pmid: {t, pd, ed, so, fj, pt, d}} -> archive rows."""
    rows = []
    for pmid, r in summaries.items():
        pts = set(r.get('pt') or [])
        if pts & SKIP_PT:
            continue
        title = clean_title(r.get('t'))
        if not title or not str(pmid).isdigit():
            continue
        # Prefer the electronic date (day precision) over the print issue date (often month only).
        date, prec = parse_date(r.get('ed') or '')
        basis = 'PubMed 电子发表日期'
        if prec != 'day':
            d2, p2 = parse_date(r.get('pd') or '')
            if p2 == 'day' or not date:
                date, prec, basis = d2, p2, 'PubMed 刊期日期'
            elif prec == 'month' and p2 == 'day':
                date, prec = d2, p2
        rows.append({'pmid': str(pmid), 'doi': (r.get('d') or '').lower().strip(), 'title': title,
                     'journal': (r.get('fj') or r.get('so') or '').strip(), 'date': date, 'datePrecision': prec,
                     'dateBasis': basis, 'pubTypes': sorted(pts)})
    return rows


def request(action, params, tries=4):
    url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/%s?%s' % (action, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={'User-Agent': 'XinZhiLearningPilot/0.2 (public journal metadata)'})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read(20_000_000))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def live(start, end):
    ids = []
    for name, term in queries(start, end).items():
        found = request('esearch.fcgi', {'db': 'pubmed', 'term': term, 'retmode': 'json', 'retmax': 10000, 'sort': 'pub date'})['esearchresult']
        got = found['idlist']
        print(name, 'hits', found['count'], file=sys.stderr)
        ids.extend(x for x in got if x not in ids)
        time.sleep(0.4)
    summaries = {}
    for i in range(0, len(ids), 200):
        j = request('esummary.fcgi', {'db': 'pubmed', 'id': ','.join(ids[i:i + 200]), 'retmode': 'json'})
        for u in j['result']['uids']:
            r = j['result'][u]
            doi = next((a['value'] for a in r.get('articleids', []) if a.get('idtype') == 'doi'), '')
            summaries[u] = {'t': r.get('title'), 'pd': r.get('pubdate'), 'ed': r.get('epubdate'), 'so': r.get('source'),
                            'fj': r.get('fulljournalname'), 'pt': r.get('pubtype'), 'd': doi}
        time.sleep(0.4)
    return summaries


def merge(old_rows, new_rows, today):
    by = {r['pmid']: r for r in old_rows}
    by.update({r['pmid']: r for r in new_rows})
    floor = (today - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    kept = [r for r in by.values() if (r['date'] or '9999') >= floor[:len(r['date'] or floor)]]
    kept.sort(key=lambda r: (r['date'] or '', r['pmid']), reverse=True)
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--incremental', action='store_true')
    ap.add_argument('--seed', type=Path)
    ap.add_argument('--days', type=int, default=WINDOW_DAYS)
    a = ap.parse_args()
    if not 1 <= a.days <= 400:
        ap.error('--days 1..400')
    today = datetime.datetime.now(datetime.timezone.utc).date()
    old = json.loads(OUT.read_text()).get('rows', []) if OUT.exists() else []
    if a.seed:
        new = ingest(json.loads(a.seed.read_text()))
        source = 'seed:' + a.seed.name
    else:
        days = 7 if a.incremental and old else a.days
        summaries = live((today - datetime.timedelta(days=days)).strftime('%Y/%m/%d'), today.strftime('%Y/%m/%d'))
        new = ingest(summaries)
        source = 'pubmed-live'
    rows = merge(old if (a.incremental or a.seed) else [], new, today)
    OUT.write_text(json.dumps({'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'windowDays': a.days,
                               'source': source, 'count': len(rows),
                               'scope': {k: v for k, v in GROUPS.items()}, 'rows': rows}, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps({'source': source, 'ingested': len(new), 'total': len(rows)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
