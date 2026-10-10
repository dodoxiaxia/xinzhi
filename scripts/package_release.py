#!/usr/bin/env python3
"""Package only allowlisted deliverables; never credentials or the live database."""
from pathlib import Path
import os
import tempfile
import zipfile
from release_integrity import validate_release
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT.parent
PUBLIC={'index.html','style.css','public.js','radar.js','icon.svg','_headers','_worker.js'}
ROOTS={'data','scripts','service','editor','public','editorial','docs'}
FILES={'index.html','style.css','app.js','citation-export.js','icon.svg','README.md','start.command'}

def public_payloads(root=ROOT):
 public=root/'public'
 if public.is_symlink() or not public.is_dir() or public.resolve().parent!=root.resolve():
  raise ValueError('Public directory must be an ordinary project directory')
 if {p.name for p in public.iterdir()}!=PUBLIC:
  raise ValueError('Public directory must contain exactly the six allowlisted files')
 for name in PUBLIC:
  path=public/name
  if path.is_symlink() or not path.is_file() or path.resolve().parent!=public.resolve():
   raise ValueError('Public files must be ordinary files inside the public directory')
 payloads={}
 for name in sorted(PUBLIC):
  fd=os.open(public/name,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
  with os.fdopen(fd,'rb') as stream:payloads[name]=stream.read()
 validate_release(root,payloads)
 return payloads

def main():
 # Preflight and all ZIP writes/closes finish before any existing archive is replaced.
 payloads=public_payloads(ROOT)
 names=('xinzhi-public.zip','心知-公开网站包.zip','心知-本地学习站.zip')
 staged=[]
 try:
  for name in names:
   with tempfile.NamedTemporaryFile(dir=OUT,prefix='.'+name+'-',suffix='.tmp',delete=False) as stream:
    path=Path(stream.name)
   staged.append((path,OUT/name))
   with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
    if name!='心知-本地学习站.zip':
     for filename,content in payloads.items():z.writestr(filename,content)
    else:
     for p in sorted(ROOT.rglob('*')):
      rel=p.relative_to(ROOT)
      if not p.is_file() or p.is_symlink() or any(s.startswith('.') or s=='__pycache__' for s in rel.parts):continue
      if rel.parts[0]=='public':continue
      if rel.parts[0] not in ROOTS and str(rel) not in FILES:continue
      if p.suffix in ('.db','.sqlite','.pyc'):continue
      z.write(p,str(Path('xinzhi')/rel))
     for filename,content in payloads.items():z.writestr(str(Path('xinzhi/public')/filename),content)
     assert not any('.local' in f or 'admin-token' in f for f in z.namelist())
  # Each replacement is atomic on this filesystem; the three are not one transaction.
  for path,target in staged:os.replace(path,target)
 finally:
  for path,_ in staged:path.unlink(missing_ok=True)
 print(f'Public: {len(PUBLIC)} files. Local package: no credentials or live database.')

if __name__=='__main__':main()
