"""Import Kanto entries and images from Pokémon Korea's official public Pokédex."""
import concurrent.futures, json, re, urllib.request, urllib.parse, pathlib, html
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='https://pokemonkorea.co.kr'
def fetch(url,data=None):
    req=urllib.request.Request(url,data=data,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=30) as r:return r.read()
def clean(s):return html.unescape(re.sub('<[^>]+>','',s)).strip()
def page(n):
    if n==1:return fetch(BASE+'/pokedex?snumber=1&snumber2=151').decode()
    d=urllib.parse.urlencode({'mode':'load_more','pn':n,'snumber':'1','snumber2':'151','sortselval':'number asc,number_count asc'}).encode()
    return fetch(BASE+'/ajax/pokedex',d).decode()
entries={}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for content in pool.map(page,range(1,15)):
        for block in re.findall(r'<li class="col-lg-2 col-6".*?</li>',content,re.S):
            match=re.search(r'/mid/(\d{4})(\d{2}).png',block)
            if not match:continue
            num=int(match[1])
            if match[2] != ('03' if num==131 else '01'):continue
            uid=re.search(r'pokedex_(\d+)',block)[1]
            name=clean(re.search(r'<h3><p>.*?</p>(.*?)</h3>',block,re.S)[1])
            types=[clean(t) for t in re.findall(r'<span class="badge.*?>(.*?)</span>',block,re.S)]
            entries[num]={'id':num,'uid':uid,'name':name,'types':types,'source':BASE+'/pokedex/view/'+uid}
assert len(entries)==151, f'Expected 151 entries, got {len(entries)}; missing {[i for i in range(1,152) if i not in entries]}'
def enrich(p):
    s=fetch(p['source']).decode()
    for key,label in [('height','키'),('weight','몸무게'),('category','분류')]:
        m=re.search(r'<h4[^>]*>'+label+r'</h4>\s*<p>(.*?)</p>',s,re.S)
        p[key]=clean(m[1]) if m else '—'
    m=re.search(r"charmodalshow\('([^']+)'",s)
    p['ability']=m[1] if m else '—'
    # Short factual excerpt; the full source stays linked in every detail view.
    m=re.search(r'<p class="para descript">(.*?)</p>',s,re.S)
    p['description']=clean(m[1])[:140] if m else ''
    m=re.search(r'<img src="(https://data1.pokemonkorea.co.kr/newdata/pokedex/full/[^\"]+)"',s)
    assert m, p['name']
    p['imageSource']=m[1];p['image']=f"assets/{p['id']:03}.png"
    path=ROOT/'dist'/p['image']
    path.write_bytes(fetch(m[1]))
    assert path.stat().st_size>1000
    return p
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    result=list(pool.map(enrich,sorted(entries.values(),key=lambda p:p['id'])))
(ROOT/'dist/pokemon.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(f'Imported {len(result)} official entries and images.')
