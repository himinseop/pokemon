"""Build an offline static release with content-addressed, cache-safe images."""
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('verify_site', ROOT / 'scripts/verify-site.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def asset_name(relative, content):
    path = Path(relative)
    digest = hashlib.sha256(content).hexdigest()[:20]
    return path.with_name(f'{path.stem}-{digest}{path.suffix}').as_posix()


def rewrite(text, replacements):
    # Match full paths, not prefixes (001.png must not alter 1001.png).
    import re
    return re.sub(r'assets/[A-Za-z0-9_./-]+', lambda m: replacements.get(m.group(0), m.group(0)), text)


def build(source=ROOT / 'dist', target=ROOT / 'dist-aws'):
    source, target = Path(source), Path(target)
    verifier.verify(source)
    if target.resolve() in [source.resolve(), ROOT.resolve()] or source.resolve().is_relative_to(target.resolve()):
        raise ValueError('Build output must not contain the source directory.')
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True)
    replacements = {}
    for path in sorted((source / 'assets').rglob('*')):
        if not path.is_file(): continue
        content = path.read_bytes()
        relative = path.relative_to(source).as_posix()
        hashed = asset_name(relative, content)
        replacements[relative] = hashed
        destination = target / hashed
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    for path in source.rglob('*'):
        if not path.is_file() or path.is_relative_to(source / 'assets'): continue
        content = path.read_bytes()
        if path.suffix in ['.html', '.js', '.css', '.json', '.svg', '.txt']:
            content = rewrite(content.decode('utf-8'), replacements).encode('utf-8')
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    for name in ['app.js', 'style.css']:
        path = target / name
        hashed = asset_name(name, path.read_bytes())
        path.rename(target / hashed)
        index = target / 'game.html'
        index.write_text(index.read_text(encoding='utf-8').replace(f'"{name}"', f'"{hashed}"'), encoding='utf-8')
    import re
    for path in target.rglob('*'):
        if path.suffix in ['.html', '.js', '.css', '.json', '.svg']:
            for reference in re.findall(r'assets/[A-Za-z0-9_./-]+', path.read_text(encoding='utf-8')):
                if not (target / reference).is_file():
                    raise ValueError(f'Broken built asset reference: {reference}')
    inventory = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob('*')) if p.is_file()}
    manifest = {'revision': os.environ.get('GITHUB_SHA', 'local'), 'files': inventory}
    (target / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'AWS release ready: {target} ({len(inventory)} files). No AWS resources changed.')
    return manifest


if __name__ == '__main__': build()
