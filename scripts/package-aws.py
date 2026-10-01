"""Package the static Site for a manual S3 upload; never creates AWS resources."""
import json, pathlib, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
source=ROOT/'dist'
manifest=json.loads((source/'pokedex-manifest.json').read_text())
base=json.loads((source/'pokemon.json').read_text())
extra=json.loads((source/'pokemon-details.json').read_text())
assert len(base)==manifest['speciesCount']
assert len(base)+len(extra)==manifest['entryCount']
for p in base+list(extra.values()):
    assert (source/p['image']).is_file(),p['image']
target=ROOT/'exports/pokemon-play-aws.zip'
target.parent.mkdir(exist_ok=True)
temporary=target.with_suffix('.tmp')
regions=json.loads((source/'pokemon-regions.json').read_text())['groups']
assert set().union(*(set(g['numbers']) for g in regions))==set(range(1,manifest['maxNumber']+1))
with zipfile.ZipFile(temporary,'w',zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
    for path in sorted(source.rglob('*')):
        if path.is_file():archive.write(path,path.relative_to(source))
with zipfile.ZipFile(temporary) as archive:
    assert 'index.html' in archive.namelist()
    assert archive.testzip() is None
temporary.replace(target)
print(f'AWS static archive: {target} ({target.stat().st_size:,} bytes)')
