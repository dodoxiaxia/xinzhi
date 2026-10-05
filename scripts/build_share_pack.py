#!/usr/bin/env python3
"""Prepare reviewed study summaries for manual group sharing; never sends messages."""
import csv,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
LIBRARY=Path('/Users/shijun/mac文献')
def main():
 edition=json.loads((ROOT/'editorial/source_checked_drafts.json').read_text())
 with (LIBRARY/'文献索引/文献索引.csv').open(encoding='utf-8-sig') as f: rows=list(csv.DictReader(f))
 downloaded_path=ROOT/'.local/downloaded-fulltexts.json'
 downloaded=json.loads(downloaded_path.read_text()) if downloaded_path.exists() else []
 texts=['# 心知｜'+edition['prepared_on']+' 群分享材料','以下各段可复制到学习群。阅读范围为摘要导读，非全文精读。']
 inventory=[]
 for article in edition['articles']:
  if not article.get('source_checked'):continue
  paths=[]
  for item in downloaded:
   path=Path(item['path'])
   if item['doi'].lower()==article['doi'].lower() and path.is_file():paths.append(str(path))
  for row in rows:
   if row.get('DOI','').strip().lower()!=article['doi'].lower():continue
   path=Path(row.get('当前路径',''))
   if not path.is_absolute():path=LIBRARY/path
   if path.is_file() and path.suffix.lower()=='.pdf':paths.append(str(path))
  inventory.append({'doi':article['doi'],'title':article['title_zh'],'verified_local_pdfs':paths,'status':'本地全文已找到' if paths else '本地索引未找到可用全文','publisher_url':article['source_url']})
  texts.append('\n---\n\n'+article['title_zh']+'\n\n'+article['summary']+'\n\n阅读边界：'+article['limitations']+'\n\n一起思考：'+article['learning_question']+'\n\n原文：'+article['source_url']+'\n\n持续更新：https://learn.dryz.info/\n\nAI 辅助摘要导读，非科室医生终审。')
 (ROOT/'docs/本期群分享材料.md').write_text('\n\n'.join(texts))
 private=ROOT/'.local';private.mkdir(exist_ok=True)
 (private/'fulltext-status.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2))
 print(json.dumps({'share_items':len(inventory),'local_fulltexts_found':sum(bool(p['verified_local_pdfs']) for p in inventory),'messages_sent':0},ensure_ascii=False))
if __name__=='__main__':main()
