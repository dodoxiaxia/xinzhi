#!/usr/bin/env python3
"""Measure the published topic tags in public/ or a two-column JSON fixture."""
import argparse
import collections
import itertools
import json
import re
import subprocess
from pathlib import Path

from enrich_metadata import TOPIC_VOCAB

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = {'library': '文献库', 'radar': '文献雷达'}
CARDIO_TIERS = {'cardioClinical', 'basicTranslational', 'review'}
UNSAFE_TEXT = re.compile(
    r'(?i)[\w.+-]+@[\w.-]+|(?:https?|file)://|(?:^|\s)(?:[~.]?/|[a-z]:\\)\S+|'
    r'[/\\](?:home|users|tmp|documents|private|\.local)[/\\]|\b[a-f0-9]{32}\b'
)
DOI = re.compile(r'10\.\d{4,9}/[-._;()/<>:A-Z0-9]+', re.I)


def public_data(directory):
    """Read the same published records as the browser, without evaluating data as JS."""
    def js_data(stem, prefix):
        files = list((directory / 'assets').glob(stem + '.*.js'))
        if len(files) != 1:
            raise ValueError(f'应有一个 {stem} 公开构建分片')
        text = files[0].read_text(encoding='utf-8')
        start = text.index(prefix) + len(prefix)
        return json.JSONDecoder().raw_decode(text, start)[0]

    def part(name):
        return js_data(f'data-{name}', f'window.XINZHI_PART("{name}",')

    library = part('library')['papers']
    radar = js_data('app', 'window.FEEDS=')['items'] + part('feeds')['items']
    seen_doi = {str(p.get('doi') or '').lower() for p in radar}
    seen_pmid = set()
    for paper in radar:
        pmid = re.search(r'pubmed\.ncbi\.nlm\.nih\.gov/(\d+)', paper.get('url') or '')
        seen_pmid.add(str(paper.get('pmid') or (pmid[1] if pmid else '')))
    for archive in (part('radar'), js_data('radar', 'window.RADAR_ARCHIVE=')):
        for pmid, doi, _, journal, _, _, _, tags, title in (archive or {}).get('rows', []):
            if (doi and doi.lower() in seen_doi) or str(pmid) in seen_pmid:
                continue
            radar.append({'title': title, 'doi': doi, 'journal': archive['jn'][journal],
                          'tags': [archive['tag'][tag] for tag in tags]})
            if doi:
                seen_doi.add(doi.lower())
            seen_pmid.add(str(pmid))
    return {'library': library, 'radar': radar}


def journal(paper):
    name = str(paper.get('cleanJournal') or paper.get('journal') or '').strip()
    if '追踪' in name or name == '期刊待补' or re.match(r'PubMed\s*:', name, re.I):
        return ''
    return name


def journal_tiers(columns):
    names = sorted({journal(paper) for papers in columns.values() for paper in papers})
    script = """
const fs = require('node:fs');
require(process.argv[1]);
const api = globalThis.XINZHI_JOURNAL_TIERS;
const names = JSON.parse(fs.readFileSync(0, 'utf8'));
const mapping = Object.fromEntries(names.map(name => [name, name ? api.tierOfName(api.canonName(name)) : '']));
console.log(JSON.stringify([api.tiers.map(({id, title}) => [id, title]), mapping]));
"""
    result = subprocess.run(['node', '-e', script, str(ROOT / 'src/app/journal-tiers.js')],
                            input=json.dumps(names), text=True, capture_output=True, check=True)
    tiers, mapping = json.loads(result.stdout)
    return [*tiers, ['', '期刊待补']], mapping


def topic_tags(paper):
    return set(tag.strip() for tag in (paper.get('tags') or [])
               if isinstance(tag, str) and tag.strip().startswith('#'))


def summarize(papers, mapping):
    counts = collections.Counter()
    sizes = collections.Counter()
    by_tier = collections.defaultdict(collections.Counter)
    pairs = collections.Counter()
    combinations = set()
    samples = []
    untagged = []
    for paper in papers:
        tags = topic_tags(paper)
        counts.update(tags)
        sizes[len(tags)] += 1
        tier = mapping[journal(paper)]
        by_tier[tier][len(tags)] += 1
        pairs.update(itertools.combinations(sorted(tags), 2))
        for size in range(2, len(tags) + 1):
            combinations.update(itertools.combinations(sorted(tags), size))
        if not tags:
            title = ' '.join(str(paper.get('title') or '').split())
            doi = str(paper.get('doi') or '').strip()
            if title and not UNSAFE_TEXT.search(title):
                untagged.append(title)
                if tier in CARDIO_TIERS and (not doi or DOI.fullmatch(doi)):
                    samples.append((title, doi))
    return counts, sizes, by_tier, pairs, combinations, samples, untagged


def markdown(value):
    if UNSAFE_TEXT.search(value):
        return '（已省略）'
    value = value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return re.sub(r'([\\`*_|\[\]])', r'\\\1', value)


def fraction(numerator, denominator):
    return f'{numerator / denominator:.1%}' if denominator else '—'


def render(columns):
    tiers, mapping = journal_tiers(columns)
    stats = {key: summarize(columns[key], mapping) for key in COLUMNS}
    counts, sizes, pairs = (sum((value[i] for value in stats.values()), collections.Counter())
                            for i in (0, 1, 3))
    combinations = set().union(*(value[4] for value in stats.values()))
    total = sizes.total()
    lines = [
        '# 文章主题标签覆盖率', '',
        '由 `scripts/report_topic_tag_coverage.py` 读取公开构建生成。文献雷达合并近期数据与 365 天存档，'
        '按 DOI/PMID 排除存档重复。跨栏目合计按条目出现次数计，同一论文可出现在两个栏目。'
        '文献库仅统计静态公开构建。', '',
        '## 总览与标签数分布', '', '| 栏目 | 总篇数 | 0 | 1 | 2 | 3 | 4 | 5+ | 无标签占比 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ]
    for name, distribution in [(COLUMNS[k], value[1]) for k, value in stats.items()] + [('合计', sizes)]:
        n = distribution.total()
        buckets = ' | '.join(str(distribution[i]) for i in range(5))
        more = sum(v for i, v in distribution.items() if i >= 5)
        lines.append(f'| {name} | {n} | {buckets} | {more} | {fraction(distribution[0], n)} |')
    lines.extend(['', '## 各标签篇数', '', '| 标签 | 文献库 | 文献雷达 | 合计 |', '| --- | ---: | ---: | ---: |'])
    for tag in [*TOPIC_VOCAB, *sorted(counts.keys() - set(TOPIC_VOCAB))]:
        lines.append(f'| {markdown(tag)} | {stats["library"][0][tag]} | {stats["radar"][0][tag]} | {counts[tag]} |')
    lines.extend(['', '## 按栏目与期刊档拆分', '', '| 栏目 | 期刊档 | 总篇数 | 无标签 | 无标签占比 |',
                  '| --- | --- | ---: | ---: | ---: |'])
    for key, name in COLUMNS.items():
        for tier_id, tier_name in tiers:
            distribution = stats[key][2][tier_id]
            n = distribution.total()
            lines.append(f'| {name} | {tier_name} | {n} | {distribution[0]} | {fraction(distribution[0], n)} |')
    lines.extend(['', '## 共现 Top 20', '',
                  f'两词及以上的非空 AND 组合共有 {len(combinations)} 种。'
                  f'文献库 {len(stats["library"][4])} 种，文献雷达 {len(stats["radar"][4])} 种。'
                  f'表格按标签对的共现次数排序，涵盖 {total} 条栏目记录。', '',
                  '| 标签 A | 标签 B | 文献库 | 文献雷达 | 共现篇数 |', '| --- | --- | ---: | ---: | ---: |'])
    for pair, n in sorted(pairs.items(), key=lambda item: (-item[1], item[0]))[:20]:
        a, b = map(markdown, pair)
        lines.append(f'| {a} | {b} | {stats["library"][3][pair]} | {stats["radar"][3][pair]} | {n} |')
    lines.extend(['', '## 样例', '',
                  '按公开构建顺序取前 20 条，优先文献库，档次限心血管临床、基础与转化、综述。',
                  '', '| 公开题名 | DOI |', '| --- | --- |'])
    samples = list(dict.fromkeys([*stats['library'][5], *stats['radar'][5]]))
    for title, doi in samples[:20]:
        lines.append(f'| {markdown(title)} | {markdown(doi) or "—"} |')
    lines.extend(['', '## 建议', '',
                  '以下题名关键词只用于定位优先人工核对的条目。核对摘要和研究对象后再补标签。', '',
                  '| 无标签题名线索 | 文献库 | 文献雷达 | 建议 |', '| --- | ---: | ---: | --- |'])
    suggestions = [
        (r'\b(?:cardiometabolic|cardiovascular risk|obesity|diabetes)\b', '心代谢、肥胖、糖尿病和风险评估',
         '涉及心血管一级预防或脂质结局时复核「#预防/血脂」。'),
        (r'\b(?:cardiac arrest|resuscitation|ventricular tachycardia|sudden cardiac death)\b', '骤停、复苏、室速和猝死',
         '核对是否属于心律失常管理，可补「#房颤/电生理」。'),
        (r'\b(?:cardiogenic shock|mechanical circulatory support|ventricular assist)\b', '心源性休克与机械循环支持',
         '有明确心肌衰竭或心室支持证据时复核「#心衰/心肌」。'),
        (r'\b(?:pulmonary (?:arterial )?hypertension|pulmonary vascular)\b', '肺动脉高压与肺血管病',
         '先做与「#高血压/血管」的边界抽查。若无标签线索少，暂缓新增词表项。'),
    ]
    for pattern, label, suggestion in suggestions:
        regex = re.compile(pattern, re.I)
        library, radar = (sum(bool(regex.search(t)) for t in value[6]) for value in stats.values())
        lines.append(f'| {label} | {library} | {radar} | {suggestion} |')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', type=Path, default=ROOT / 'public')
    parser.add_argument('--fixture', type=Path, help='JSON with library and radar arrays')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/reports/topic-tag-coverage.md')
    args = parser.parse_args()
    columns = (json.loads(args.fixture.read_text(encoding='utf-8'))
               if args.fixture else public_data(args.public))
    args.output.write_text(render(columns), encoding='utf-8')


if __name__ == '__main__':
    main()
