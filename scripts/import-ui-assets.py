"""Collect official type/gender icons and the Pokédex repeating pattern."""
import concurrent.futures, json, pathlib, re, urllib.request, urllib.parse, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='https://pokemonkorea.co.kr'
CACHE=pathlib.Path(tempfile.gettempdir())/'pokemon-official-import-20261001'
SLUGS={'노말':'normal','불꽃':'fire','물':'water','전기':'electric','풀':'grass','얼음':'ice','격투':'fighting','독':'poison','땅':'ground','비행':'flying','에스퍼':'psychic','벌레':'bug','바위':'rock','고스트':'ghost','드래곤':'dragon','악':'dark','강철':'steel','페어리':'fairy'}
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=30) as r:return r.read()
icons={};colors={}
def collect(s):
    for source,name in re.findall(r'<span class="img-type"><span><img src="([^"]+)"[^>]*></span>\s*<p>(.*?)</p>',s,re.S):icons[name.strip()]=source
    for color,name in re.findall(r'<span class="badge[^>]*style="background:(#[0-9a-fA-F]+);[^>]*>(.*?)</span>',s,re.S):colors[name.strip()]=color
for path in CACHE.glob('*.html'):collect(path.read_text())
if not (set(SLUGS)<=icons.keys() and set(SLUGS)<=colors.keys()):
    base=json.loads((ROOT/'dist/pokemon.json').read_text())
    extras=json.loads((ROOT/'dist/pokemon-details.json').read_text())
    for entry in base+list(extras.values()):
        collect(fetch(entry['source']).decode())
        if set(SLUGS)<=icons.keys() and set(SLUGS)<=colors.keys():break
assert set(SLUGS)<=icons.keys() and set(SLUGS)<=colors.keys(), (set(SLUGS)-icons.keys(),set(SLUGS)-colors.keys())
css_url=BASE+'/css/common.css';css=fetch(css_url).decode()
def css_asset(selector):
    m=re.search(re.escape(selector)+r'\{[^}]*background:url\(([^)]+)\)',css)
    assert m,selector
    return urllib.parse.urljoin(css_url,m[1])
pattern=urllib.parse.urljoin(css_url,re.search(r'url\(([^)]*bg_pattern2.jpg)\)',css)[1])
assets={};types={}
for name,slug in SLUGS.items():
    target=f'assets/ui/type-{slug}.png';types[name]={'icon':target,'color':colors[name]};assets[target]=icons[name]
assets['assets/ui/gender-male.png']=css_asset('.icon-man')
assets['assets/ui/gender-female.png']=css_asset('.icon-woman')
assets['assets/ui/bg_pattern2.jpg']=pattern
folder=ROOT/'dist/assets/ui';folder.mkdir(exist_ok=True)
def save(pair):
    target,source=pair;content=fetch(source)
    assert len(content)>100,source
    (ROOT/'dist'/target).write_bytes(content)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(save,assets.items()))
manifest={'types':types,'genders':{'수컷':'assets/ui/gender-male.png','암컷':'assets/ui/gender-female.png'},'pattern':'assets/ui/bg_pattern2.jpg','sources':assets}
(ROOT/'dist/ui-assets.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('Collected 18 official type icons, 2 gender icons and the repeating pattern.')
print(json.dumps(types,ensure_ascii=False))
