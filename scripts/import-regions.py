"""Collect regional groups from the official Korean Pokédex filters."""
import concurrent.futures, json, re, urllib.parse
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('official', ROOT/'scripts/import-official.py')
official = module_from_spec(spec)
spec.loader.exec_module(official)
REGIONS = ['관동지방','성도지방','호연지방','신오지방','하나지방','칼로스지방',
           '알로라지방','가라르지방','히스이지방','팔데아지방','미확인']

def collect(region):
    numbers = set()
    for page in range(1, 251):
        cached = official.CACHE/f'region-{region}-{page}.txt'
        if cached.exists():
            content = cached.read_text()
        else:
            payload = urllib.parse.urlencode({'mode':'load_more','word':'','characters':'','pn':page,
                'area':region,'snumber':1,'snumber2':1025,'sortselval':'number asc,number_count asc','typestr':''}).encode()
            response = official.fetch(official.BASE+'/ajax/pokedex',payload).decode().split('#|#')
            assert len(response)>1, (region,page)
            content = response[1]
            cached.write_text(content)
        ids = re.findall(r'<h3><p>No\.(\d+)</p>', content)
        if not ids:
            break
        numbers.update(map(int,ids))
    else:
        raise AssertionError('Regional pagination did not finish')
    assert numbers and all(1<=n<=1025 for n in numbers), region
    print(f'{region}: {len(numbers)} species',flush=True)
    return {'name':region,'numbers':sorted(numbers)}

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        groups = list(executor.map(collect,REGIONS))
    assert set().union(*(set(g['numbers']) for g in groups))==set(range(1,1026)), 'Missing regional classification'
    target = ROOT/'dist/pokemon-regions.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps({'source':official.BASE+'/pokedex','collectedAt':'2026-10-01','groups':groups},ensure_ascii=False,indent=2)+'\n')
    temp.replace(target)
