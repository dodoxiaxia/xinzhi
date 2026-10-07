#!/usr/bin/env python3
"""自动精选:从近 7 天候选文献里选出『每日精选』与『本周精读榜』,写 data/picks.json。
纯规则打分(无模型调用):相关专科 > 研究类型 > 顶刊 > 媒体关注 > 已有摘要/速览。不做任何医学结论判断。
每天最多 DAILY_N 篇;周榜取近 7 天总分最高的 WEEKLY_N 篇。结果只存条目 id,展示端按 id 取内容。"""
import datetime, json
from pathlib import Path
from abstract_quality import normalize_paper, readable_abstract
ROOT = Path(__file__).resolve().parents[1]
DAILY_N, WEEKLY_N, DAYS = 6, 24, 7
CARDIO = {'心血管旗舰顶刊', '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构', '心血管影像与表型', '脑血管与高血压', '心血管综合与其他', '定向专病与团队'}
AIMED = {'AI医疗与数字医学'}
GOOD_DESIGN = {'RCT': 3, 'Meta/系统综述': 3, 'Meta/综述': 3, '指南共识': 3, '队列研究': 2, '方法/模型验证': 2}
TOP = {'New England Journal of Medicine', 'The Lancet', 'JAMA', 'JAMA Cardiology', 'European Heart Journal', 'JACC', 'Circulation', 'Nature Medicine',
       'npj Digital Medicine', 'The Lancet Digital Health', 'BMJ', 'The BMJ', 'Heart', 'JAMA Network Open', 'Nature Reviews Cardiology', 'Circulation Research'}
AI_WORDS = ('artificial intelligence', 'deep learning', 'machine learning', 'large language model', 'llm', 'foundation model', 'neural network', 'ecg-ai', 'ai-ecg')


def has_content(p):
    p = normalize_paper(p)
    if not readable_abstract(p):
        return False
    t = (p.get('summary') or '').strip()
    return (len(t) > 80 and t.lower() != 'no abstract') or bool(p.get('abstractSections'))


def score(p, quicklooks):
    if not has_content(p):
        return 0  # 没有可读摘要的不进精选(无从导读)
    tier = p.get('clinicalTier') or ''
    title = (p.get('title') or '').lower()
    is_ai = any(w in title for w in AI_WORDS)
    s = 0
    if tier in CARDIO:
        s += 4
    elif tier in AIMED:
        s += 3
    elif is_ai:
        s += 1
    else:
        return 0  # 与心血管/AI 医疗无关,不进精选
    if is_ai and tier in CARDIO:
        s += 2  # 心血管 × AI
    s += GOOD_DESIGN.get(p.get('studyDesign') or '', 0)
    if (p.get('cleanJournal') or p.get('journal')) in TOP:
        s += 2
    s += sum(m.get('w', 1) for m in (p.get('media') or [])[:3]) + (2 if p.get('media') else 0)
    return s


def main():
    cand = json.loads((ROOT / 'data/candidates.json').read_text(encoding='utf-8'))['items']
    media = {}
    mp = ROOT / 'data/media.json'
    if mp.exists():
        media = json.loads(mp.read_text(encoding='utf-8')).get('matches', {})
    for p in cand:
        if p['id'] in media:
            p['media'] = media[p['id']]
    ql = {}
    qp = ROOT / 'data/quicklooks.json'
    if qp.exists():
        ql = json.loads(qp.read_text(encoding='utf-8')).get('items', {})
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
    floor = (today - datetime.timedelta(days=DAYS - 1)).isoformat()
    pool = [p for p in cand if floor <= (p.get('date') or '')[:10] <= today.isoformat()]
    scored = sorted(((score(p, ql), p) for p in pool), key=lambda x: (-x[0], x[1].get('date') or ''))
    scored = [(s, p) for s, p in scored if s >= 5]
    daily = {}
    for s, p in scored:
        d = (p.get('date') or '')[:10]
        if len(daily.setdefault(d, [])) < DAILY_N:
            daily[d].append(p['id'])
    from week_precompute import select
    selected, window = select(cand, datetime.datetime.now(datetime.timezone.utc), WEEKLY_N)
    weekly = [p['id'] for p in selected]
    out = {'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'rule': 'v2 真实7日公开摘要与相关性筛选,非医学审查', 'daily': daily, 'weekly': weekly, 'weeklyWindow': window, 'weeklyCategories': {p['id']: p['weeklyCategory'] for p in selected}}
    (ROOT / 'data/picks.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({'days': {k: len(v) for k, v in sorted(daily.items())}, 'weekly': len(weekly)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
