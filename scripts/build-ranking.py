"""Package only the ranking handler and public name choices for Lambda."""
import hashlib
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ('handler.py', 'pokemon-names.json')


def build(target=ROOT / 'exports'):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    archive = target / 'ranking-function.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for name in FILES:
            source = ROOT / 'infra/ranking' / name
            if source.is_symlink():
                raise ValueError('Ranking source cannot be a symlink.')
            compile(source.read_text(), str(source), 'exec') if name.endswith('.py') else json.loads(source.read_text())
            output.writestr(name, source.read_bytes())
    manifest = {'revision': os.environ.get('GITHUB_SHA', 'local'), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    (target / 'ranking-release.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print('Ranking function package verified.')
    return manifest


if __name__ == '__main__': build()
