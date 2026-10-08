"""Validate the collected site offline before packaging or publishing."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def local_asset(source, name):
    if not isinstance(name, str) or not name.startswith('assets/'):
        raise ValueError(f'Local asset required: {name!r}')
    path = source / name
    if '..' in Path(name).parts or path.is_symlink() or not path.is_file():
        raise ValueError(f'Missing or unsafe asset: {name}')
    return path


def verify(source=ROOT / 'dist'):
    source = Path(source)
    for name in ['index.html', 'game.html', 'admin.html', 'public/access.js', 'public/admin.js', 'public/access.css', 'public/envelope.svg', 'app.js', 'style.css', 'pokemon.json', 'pokemon-details.json', 'pokedex-manifest.json', 'pokemon-regions.json', 'ui-assets.json']:
        if not (source / name).is_file():
            raise ValueError(f'Missing site file: {name}')
    checked = set()
    def check_asset(name):
        if name not in checked:
            local_asset(source, name)
            checked.add(name)
    documents = {p.name: json.loads(p.read_text(encoding='utf-8')) for p in source.glob('*.json')}
    base, extra, manifest = documents['pokemon.json'], documents['pokemon-details.json'], documents['pokedex-manifest.json']
    if len(base) != 1025 or len(base) != manifest['speciesCount'] or set(p['id'] for p in base) != set(range(1, 1026)):
        raise ValueError('The full 1,025-species Pokédex is required.')
    entries = base + list(extra.values())
    if len(entries) != manifest['entryCount'] or len(extra) != manifest['relatedFormCount'] or len({p['uid'] for p in entries}) != len(entries):
        raise ValueError('Form counts or unique IDs do not match the manifest.')
    for p in entries:
        check_asset(p['image'])
        if not p['name'] or not p['types']:
            raise ValueError('Every Pokémon needs a name and type.')
    def walk(value):
        if isinstance(value, dict):
            for item in value.values(): walk(item)
        elif isinstance(value, list):
            for item in value: walk(item)
        elif isinstance(value, str) and value.startswith('assets/'):
            check_asset(value)
    for document in documents.values(): walk(document)
    groups = documents['pokemon-regions.json']['groups']
    if set().union(*(set(g['numbers']) for g in groups)) != set(range(1, 1026)):
        raise ValueError('Regional groups must cover all species without out-of-range numbers.')
    html = (source / 'game.html').read_text(encoding='utf-8')
    if 'app.js' not in html or 'style.css' not in html:
        raise ValueError('The HTML must reference the app and stylesheet.')
    for path in source.rglob('*'):
        if path.is_symlink() or any(part.startswith('.') for part in path.relative_to(source).parts):
            raise ValueError(f'Private files or symlinks cannot be published: {path}')
    return {'species': len(base), 'forms': len(extra), 'assets': len(list((source / 'assets').rglob('*.*')))}


if __name__ == '__main__':
    print('Verified site:', verify())
