#!/usr/bin/env python3
"""维护 NEJM「AI in Medicine」专栏人工登记清单。

用途：
  NEJM「AI in Medicine」专栏文章发表在《New England Journal of Medicine》主刊，
  题名中往往不含 AI 关键词；构建阶段依据本清单将这些文章的 clinicalTier 标为
  「AI医疗与数字医学」，使其进入前端默认的「心血管+AI」核心视角。

为什么不自动抓取专栏页：
  1. nejm.org/ai-in-medicine 对自动访问返回 Cloudflare 挑战（403，
     cf-mitigated: challenge），且 robots.txt 禁止访问 /rss 与 /action 下的
     订阅路径；我们不绕过 Cloudflare 挑战。
  2. PubMed（efetch XML）与 Crossref（works API）均不提供「专栏/栏目」字段
     （Crossref 的 subject 为空，PubMed 的 PublicationType 仅为 Journal Article），
     无法从公开元数据接口自动识别专栏成员。
  3. 因此采用仓库内人工登记清单（config/nejm_ai_in_medicine.json），由本脚本调用
     Crossref 核实为 NEJM 后原子追加；daily 流水线只读已提交文件，不请求专栏页。
"""
import argparse
import datetime
import html
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / 'config/nejm_ai_in_medicine.json'
AI_TIER = 'AI医疗与数字医学'
USER_AGENT = 'xinzhi-literature-radar/1.0 (+https://learn.dryz.info)'
SHANGHAI_TZ = datetime.timezone(datetime.timedelta(hours=8))

_DOI_PREFIX_RE = re.compile(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', re.I)
_NEJM_DOI_EXACT_RE = re.compile(r'^10\.1056/nejm[a-z]+\d+$')
_NEJM_DOI_IN_TEXT_RE = re.compile(r'10\.1056/nejm[a-z]+\d+', re.I)
_HTML_TAG_RE = re.compile(r'<[^>]+>')

_REGISTRY_CACHE = {}


def clear_cache():
    """清空登记清单内存缓存。"""
    _REGISTRY_CACHE.clear()


def normalize_doi(value):
    """规范化 NEJM DOI（去前缀与空白、转小写）；非 NEJM DOI 返回空串。"""
    if not isinstance(value, str):
        return ''
    text = _DOI_PREFIX_RE.sub('', value.strip()).strip().lower()
    if not _NEJM_DOI_EXACT_RE.fullmatch(text):
        return ''
    return text


def _resolve_path(path=None):
    return Path(path) if path is not None else REGISTRY_PATH


def _load_with_problems(path=None):
    target = _resolve_path(path)
    cache_key = str(target.resolve())
    cached = _REGISTRY_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        raw_text = target.read_text(encoding='utf-8')
    except OSError as exc:
        print(f'警告：无法读取 NEJM AI 专栏登记文件 {target}: {exc}', file=sys.stderr)
        result = ({}, [f'无法读取登记文件: {exc}'])
        _REGISTRY_CACHE[cache_key] = result
        return result

    try:
        data = json.loads(raw_text)
    except (ValueError, TypeError) as exc:
        print(f'警告：NEJM AI 专栏登记文件不是合法 JSON ({target}): {exc}', file=sys.stderr)
        result = ({}, [f'JSON 解析失败: {exc}'])
        _REGISTRY_CACHE[cache_key] = result
        return result

    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        print(f'警告：NEJM AI 专栏登记文件结构无效，需要包含 items 列表 ({target})', file=sys.stderr)
        result = ({}, ['顶层结构无效：需要包含 items 列表的 JSON 对象'])
        _REGISTRY_CACHE[cache_key] = result
        return result

    entries = {}
    problems = []
    for idx, row in enumerate(data['items'], 1):
        if not isinstance(row, dict):
            problems.append(f'第 {idx} 行不是对象，已跳过')
            continue
        raw_doi = row.get('doi')
        doi = normalize_doi(raw_doi) if isinstance(raw_doi, str) else ''
        if not doi:
            problems.append(f'第 {idx} 行 DOI 无效 ({raw_doi!r})，已跳过')
            continue
        if doi in entries:
            problems.append(f'第 {idx} 行 DOI 重复 ({doi})，已跳过')
            continue
        entries[doi] = row

    result = (entries, problems)
    _REGISTRY_CACHE[cache_key] = result
    return result


def load_registry(path=None):
    """读取登记清单并返回 {规范化 DOI: 行对象}；异常时告警并返回空字典。"""
    entries, _ = _load_with_problems(path)
    return dict(entries)


def registry_problems(path=None):
    """返回登记清单加载时被跳过的行或结构问题说明列表。"""
    _, problems = _load_with_problems(path)
    return list(problems)


def is_ai_column(doi, path=None):
    """判断给定 DOI 是否已登记在 NEJM AI in Medicine 清单中。"""
    norm = normalize_doi(doi)
    if not norm:
        return False
    entries, _ = _load_with_problems(path)
    return norm in entries


def crossref_fetch(doi):
    """从 Crossref works API 获取单篇文献的 message 字典。"""
    norm = normalize_doi(doi)
    target_doi = norm or str(doi or '').strip()
    encoded = urllib.parse.quote(target_doi, safe='')
    url = f'https://api.crossref.org/works/{encoded}'
    req = urllib.request.Request(
        url,
        headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    message = payload.get('message') if isinstance(payload, dict) else None
    if not isinstance(message, dict):
        raise ValueError('Crossref 响应缺少 message 对象')
    return message


def _clean_crossref_title(raw_title):
    if isinstance(raw_title, list):
        candidates = [item for item in raw_title if isinstance(item, str) and item.strip()]
        text = candidates[0] if candidates else ''
    elif isinstance(raw_title, str):
        text = raw_title
    else:
        text = ''
    stripped = _HTML_TAG_RE.sub('', text)
    unescaped = html.unescape(stripped)
    return re.sub(r'\s+', ' ', unescaped).strip()


def _default_registry_payload():
    return {
        'schemaVersion': 1,
        'column': 'NEJM AI in Medicine',
        'columnUrl': 'https://www.nejm.org/ai-in-medicine',
        'note': '人工登记清单；nejm.org 对自动访问返回 Cloudflare 挑战，PubMed 与 Crossref 均无专栏/栏目字段；新增请运行 scripts/ai_column.py add。',
        'items': [],
    }


def _atomic_write_json(target, payload):
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    fd, tmp_name = tempfile.mkstemp(prefix='.tmp-ai-column-', suffix='.json', dir=str(target.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def add_dois(dois, path=None, fetch=crossref_fetch, sleep=time.sleep, interval=1.0):
    """核实并追加新的 NEJM DOI，返回 (added, skipped, failed)。"""
    target = _resolve_path(path)
    doi_list = list(dois)

    if target.exists():
        try:
            data = json.loads(target.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError) as exc:
            failed = [{'doi': str(d or ''), 'reason': f'现有登记文件读取失败，未做修改: {exc}'} for d in doi_list]
            return [], [], failed
        if not isinstance(data, dict) or not isinstance(data.get('items'), list):
            failed = [{'doi': str(d or ''), 'reason': '现有登记文件结构无效，未做修改'} for d in doi_list]
            return [], [], failed
    else:
        data = _default_registry_payload()

    existing_dois = {
        normalize_doi(row.get('doi'))
        for row in data['items']
        if isinstance(row, dict) and normalize_doi(row.get('doi'))
    }

    added = []
    skipped = []
    failed = []
    added_dois = set()
    fetch_calls = 0
    today_bj = datetime.datetime.now(SHANGHAI_TZ).date().isoformat()

    for raw_doi in doi_list:
        doi = normalize_doi(raw_doi)
        if not doi:
            failed.append({'doi': str(raw_doi or ''), 'reason': '不符合 NEJM DOI 格式'})
            continue
        if doi in existing_dois or doi in added_dois:
            skipped.append(doi)
            continue

        if fetch_calls > 0 and interval > 0:
            sleep(interval)
        fetch_calls += 1

        try:
            message = fetch(doi)
        except Exception as exc:
            failed.append({'doi': doi, 'reason': f'Crossref 获取失败: {exc}'})
            continue

        if not isinstance(message, dict):
            failed.append({'doi': doi, 'reason': 'Crossref 返回格式无效'})
            continue

        msg_doi = _DOI_PREFIX_RE.sub('', str(message.get('DOI') or '').strip()).strip().lower()
        if msg_doi != doi:
            failed.append({'doi': doi, 'reason': f'Crossref 返回 DOI 不一致: {message.get("DOI")!r}'})
            continue

        containers = message.get('container-title')
        if isinstance(containers, str):
            containers = [containers]
        elif not isinstance(containers, list):
            containers = []
        if not any(isinstance(name, str) and 'new england journal of medicine' in name.casefold() for name in containers):
            failed.append({'doi': doi, 'reason': f'container-title 非 New England Journal of Medicine: {containers!r}'})
            continue

        title = _clean_crossref_title(message.get('title'))
        if not title:
            failed.append({'doi': doi, 'reason': 'Crossref 响应缺少有效题名'})
            continue

        row = {
            'doi': doi,
            'title': title,
            'addedOn': today_bj,
            'evidence': 'Crossref 核实为 NEJM；DOI 来自维护者提供的专栏页清单',
        }
        added.append(row)
        added_dois.add(doi)

    if added:
        new_data = dict(data)
        new_data['items'] = list(data['items']) + added
        _atomic_write_json(target, new_data)
        _REGISTRY_CACHE.pop(str(target.resolve()), None)

    return added, skipped, failed


def dois_from_html(text):
    """从保存的专栏页 HTML 或文本中提取去重且保序的 NEJM DOI。"""
    seen = set()
    result = []
    for match in _NEJM_DOI_IN_TEXT_RE.finditer(text or ''):
        doi = match.group(0).lower()
        if doi not in seen:
            seen.add(doi)
            result.append(doi)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='NEJM AI in Medicine 专栏登记维护工具')
    subparsers = parser.add_subparsers(dest='command', required=True)

    add_parser = subparsers.add_parser('add', help='校验并追加 NEJM AI in Medicine 文章 DOI')
    add_parser.add_argument('dois', nargs='*', help='一个或多个 NEJM DOI')
    add_parser.add_argument('--from-html', dest='from_html', help='从本地保存的专栏页 HTML/文本提取 DOI')
    add_parser.add_argument('--registry', help='覆盖登记文件路径（默认 config/nejm_ai_in_medicine.json）')

    args = parser.parse_args(argv)
    if args.command == 'add':
        if not args.dois and not args.from_html:
            add_parser.error('请至少提供一个 DOI 或 --from-html FILE')
        inputs = list(args.dois)
        if args.from_html:
            try:
                html_text = Path(args.from_html).read_text(encoding='utf-8', errors='replace')
            except OSError as exc:
                print(f'错误：无法读取文件 {args.from_html}: {exc}', file=sys.stderr)
                return 1
            inputs.extend(dois_from_html(html_text))

        added, skipped, failed = add_dois(inputs, path=args.registry)
        for row in added:
            print(f'新增: {row["doi"]} | {row["title"]}')
        for doi in skipped:
            print(f'跳过(已在册): {doi}')
        for item in failed:
            print(f'失败: {item["doi"]} | {item["reason"]}', file=sys.stderr)
        print(f'汇总: added={len(added)}, skipped={len(skipped)}, failed={len(failed)}')
        return 1 if failed else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
