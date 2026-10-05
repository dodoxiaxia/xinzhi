
DROP_ITEM = {'citations','clinicalAppraisal','localAvailable','copies','dateBasis','dateConfidence','metadataVerifiedInIndex','summary_truncated','sourceId','fetchedAt','category'}

def slim_js(text, var, list_key=None, drop_top=()):
    """Parse `window.VAR={...};`, drop fields the public UI never reads, re-emit compact JS."""
    m = re.match(r'\s*window\.' + var + r'\s*=\s*', text)
    body = text[m.end():].strip().rstrip(';')
    data = json.loads(body)
    for k in drop_top:
        data.pop(k, None)
    if list_key:
        for it in data.get(list_key, []):
            for k in DROP_ITEM:
                it.pop(k, None)
    return 'window.' + var + '=' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';'
