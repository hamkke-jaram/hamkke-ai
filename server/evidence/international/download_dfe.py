"""Download UK DfE's teacher-authored main guidance text, excluding media, interviews and quotes from outside providers."""
import hashlib
import json
import argparse
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
DFE = 'https://help-for-early-years-providers.education.gov.uk/areas-of-learning/'
PAGES = [
    'mathematics/patterns',
    'mathematics/spatial-reasoning',
    'expressive-arts-and-design/imagination-and-creativity',
    'physical-development/gross-motor-skills',
    'literacy/reading-comprehension',
    'literacy/writing',
    'communication-and-language/interactions',
]
LICENCE = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'

class GuidanceText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tag = None
        self.pieces = []
        self.heading = ''
        self.title = ''
        self.rows = []
        self.in_main = False

    def handle_starttag(self, tag, attrs):
        if tag == 'main':
            self.in_main = True
        if self.in_main and tag in ('h1', 'h2', 'h3', 'p', 'li'):
            self.tag, self.pieces = tag, []

    def handle_endtag(self, tag):
        if tag == 'main':
            self.in_main = False
        if tag != self.tag:
            return
        value = ' '.join(''.join(self.pieces).split())
        if tag == 'h1':
            self.title = value
        elif tag == 'h2':
            self.heading = value
            if self.include_heading():
                self.rows.append('## ' + value)
        elif value and self.include_heading():
            self.rows.append(value)
        self.tag = None
        self.pieces = []

    def include_heading(self):
        return self.heading.lower().startswith('why ') or self.heading.lower() == 'what this means in practice'

    def handle_data(self, data):
        if self.tag:
            self.pieces.append(data)

def download_dfe(cached_dir=None):
    sources = []
    for page in PAGES:
        url = DFE + page
        key = 'dfe-' + page.rsplit('/', 1)[-1]
        if cached_dir:
            content = (cached_dir / ('hamkke-dfe-20261120-' + page.rsplit('/', 1)[-1] + '.html')).read_bytes()
        else:
            with urlopen(url, timeout=30) as response:
                content = response.read()
                assert response.status == 200
        parser = GuidanceText()
        parser.feed(content.decode('utf-8'))
        assert parser.title and len(parser.rows) > 5 and 'Open Government Licence' in content.decode('utf-8')
        body = ('\n\n'.join(parser.rows) + '\n').encode('utf-8')
        filename = key + '.txt'
        (ROOT / filename).write_bytes(body)
        sources.append(dict(sourceKey=key,title=parser.title,publisher='영국 교육부(DfE)',url=url,
                            license='Contains public sector information licensed under the Open Government Licence v3.0. Crown copyright.',
                            licenseUrl=LICENCE,asset=filename,sha256=hashlib.sha256(body).hexdigest(),
                            retrieval='selective HTML extraction: first-party Why… and What this means in practice sections; navigation, media, interviews and guest examples excluded',
                            retrievedAt=date.today().isoformat(), originalSha256=hashlib.sha256(content).hexdigest()))
    return sources

if __name__ == '__main__':
    arg = argparse.ArgumentParser()
    arg.add_argument('--cached-dir', type=Path)
    index = ROOT / 'sources.json'
    other = [s for s in json.loads(index.read_text('utf-8')) if not s['sourceKey'].startswith('dfe-')] if index.exists() else []
    index.write_text(json.dumps(other + download_dfe(arg.parse_args().cached_dir), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
