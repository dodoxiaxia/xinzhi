"""Check a deployed dispatcher URL without reading protected credentials.

This is not run by site publish. The repository source in workers/cron-dispatch
is the 2-hour daily.yml dispatcher and is not deployed by Actions. A URL that
still answers with the previously deployed worker keeps its own version string.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


def check(path):
    urls = re.findall(r'https://xinzhi-cron\.[a-z0-9-]+\.workers\.dev', Path(path).read_text())
    if not urls:
        raise ValueError('dispatcher_url_missing')
    request = urllib.request.Request(urls[-1], headers={
        'User-Agent': 'XinZhiFulltextDispatchCheck/1.0', 'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read(4096))
    except (OSError, ValueError, urllib.error.URLError):
        raise ValueError('dispatcher_not_ready') from None
    if body.get('ok') is not True or body.get('configured') is not True or body.get('version') != 'v14.2':
        raise ValueError('dispatcher_not_configured')
    print('Fulltext dispatcher ready; protected configuration retained.')


if __name__ == '__main__':
    try:
        check(sys.argv[1])
    except (ValueError, IndexError) as error:
        print('::error::' + str(error))
        sys.exit(1)
