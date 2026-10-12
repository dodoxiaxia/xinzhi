"""Opt-in adapter for the existing Actions token; construction alone does no I/O.

No scheduler, new credential, permission change, model call, or automatic enable.
The sole integrator must set XINZHI_PRECOMPUTE_STATE_CHECKPOINT=1 after review.
"""
import json
import os
import urllib.error
import urllib.request
from week_precompute_checkpoint import CheckpointError, GitHubStateCheckpoint


class RejectRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):raise CheckpointError('checkpoint_redirect_blocked')


def existing_token_transport(token):
 def transport(method,path,body=None):
  if not path.startswith('/repos/') or '\\' in path or '#' in path:
   raise CheckpointError('checkpoint_invalid_api_path')
  request=urllib.request.Request('https://api.github.com'+path,
   data=json.dumps(body).encode() if body is not None else None,method=method,
   headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json',
            'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'})
  try:
   with urllib.request.build_opener(RejectRedirect).open(request,timeout=30) as response:
    raw=response.read(16*1024*1024+1);status=response.status
   if len(raw)>16*1024*1024:raise CheckpointError('checkpoint_response_too_large')
   return status,json.loads(raw)
  except urllib.error.HTTPError as exc:
   # The status suffices; never return/log a remote error body or request headers.
   return exc.code,{}
  except (OSError,ValueError) as exc:
   raise CheckpointError('checkpoint_transport_failed') from None
 return transport


class CiCheckpoint:
 def __init__(self,backend,root):self.backend,self.root=backend,root
 def record_head(self):
  path=self.root/'.local/week-checkpoint-head';path.parent.mkdir(parents=True,exist_ok=True)
  tmp=path.with_suffix('.tmp');tmp.write_text(self.backend.head_sha+'\n');tmp.replace(path)
 def save(self,ledger,cache):
  result=self.backend.save(ledger,cache)
  try:self.record_head()
  except OSError:raise CheckpointError('checkpoint_local_head_failed') from None
  return result
 def run_reserved(self,ledger,cache,request_id,model_call):
  def dispatch():
   try:self.record_head()
   except OSError:raise CheckpointError('checkpoint_local_head_failed') from None
   return model_call()
  return self.backend.run_reserved(ledger,cache,request_id,dispatch)


# Runtime data may live in a separate private repository (vars.XINZHI_STATE_REPO with a
# token in secrets.XINZHI_STATE_TOKEN); without them it stays on this repository's state branch.
def state_repository():
 return os.environ.get('XINZHI_STATE_REPOSITORY') or os.environ.get('GITHUB_REPOSITORY','')
def state_token():
 return os.environ.get('XINZHI_STATE_TOKEN') or os.environ.get('GITHUB_TOKEN','')

def initialize_checkpoint(root,ledger,cache,transport=None):
 if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('XINZHI_PRECOMPUTE_STATE_CHECKPOINT')!='1':return None
 # Lazy import avoids a cycle with the existing request-level merge helper.
 from restore_week_precompute_snapshot import merge_ledger
 if transport is None:
  token=state_token()
  if not token:raise CheckpointError('checkpoint_existing_token_missing')
  transport=existing_token_transport(token)
 backend=GitHubStateCheckpoint(state_repository(),transport,merge_ledger)
 snapshot=backend.restore(ledger,cache)
 checkpoint=CiCheckpoint(backend,root)
 checkpoint.save(snapshot.ledger,snapshot.cache)
 ledger.clear();ledger.update(snapshot.ledger);cache.clear();cache.update(snapshot.cache)
 return checkpoint
