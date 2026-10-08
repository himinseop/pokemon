"""Package ranking and invitation handlers with portable RSA signing dependencies."""
import hashlib
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ('handler.py', 'access.py', 'pokemon-names.json')


def build(target=ROOT / 'exports'):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    archive = target / 'ranking-function.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        files = [*FILES, *[p.relative_to(ROOT / 'infra/ranking').as_posix() for p in sorted((ROOT / 'infra/ranking/vendor').rglob('*')) if p.is_file() and '__pycache__' not in p.parts]]
        for name in files:
            source = ROOT / 'infra/ranking' / name
            if source.is_symlink():
                raise ValueError('Ranking source cannot be a symlink.')
            compile(source.read_text(), str(source), 'exec') if name.endswith('.py') else json.loads(source.read_text()) if name.endswith('.json') else None
            output.writestr(name, source.read_bytes())
    manifest = {'revision': os.environ.get('GITHUB_SHA', 'local'), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    (target / 'ranking-release.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print('Ranking function package verified.')
    return manifest


if __name__ == '__main__': build()
