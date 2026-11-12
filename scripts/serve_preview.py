#!/usr/bin/env python3
"""Loopback preview; no directory listing or private service data."""
import re
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote,urlsplit
ROOT=Path(__file__).resolve().parents[1]
ALLOWED={'index.html','style.css','app.js','icon.png','demo-reading.html','data/library.js','data/feeds.js','data/candidates.js','data/source-health.js','data/curated.js','data/quicklooks.js','public/index.html','public/style.css','public/public.js','public/icon.png','public/demo-reading.html'}
SHARD=re.compile(r'public/shards/readings-(?:\d{4}-\d{2}|undated)\.[0-9a-f]{12}\.js$')
class Preview(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
 def do_GET(self):
  path=unquote(urlsplit(self.path).path).lstrip('/') or 'index.html'
  if (path not in ALLOWED and not SHARD.fullmatch(path)) or (ROOT/path).is_symlink():self.send_error(404);return
  super().do_GET()
 def do_HEAD(self):
  path=unquote(urlsplit(self.path).path).lstrip('/') or 'index.html'
  if path not in ALLOWED and not SHARD.fullmatch(path):self.send_error(404);return
  super().do_HEAD()
ThreadingHTTPServer(('127.0.0.1',8765),Preview).serve_forever()
