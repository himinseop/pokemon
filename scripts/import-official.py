"""Refresh Kanto quiz entries and their official Pokédex details/related forms."""
import concurrent.futures, html, json, pathlib, re, tempfile, time, urllib.parse, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='https://pokemonkorea.co.kr'
CACHE=pathlib.Path(tempfile.gettempdir())/'pokemon-official-import-20261001'
CACHE.mkdir(exist_ok=True)
def fetch(url,data=None):
    for attempt in range(3):
        try:
            req=urllib.request.Request(url,data=data,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req,timeout=30) as response:return response.read()
        except Exception:
            if attempt==2:raise
            time.sleep(attempt+1)
def clean(value):
    value=re.sub(r'<br\s*/?>','\n',value,flags=re.I)
    return html.unescape(re.sub('<[^>]+>','',value)).strip()
def page_html(uid):
    path=CACHE/f'{uid}.html'
    if not path.exists():path.write_bytes(fetch(f'{BASE}/pokedex/view/{uid}'))
    return path.read_text()
def image_path(uid,source,base_entries):
    target=base_entries[uid]['image'] if uid in base_entries else f'assets/forms/{uid}.png'
    path=ROOT/'dist'/target
    if not path.exists():
        path.parent.mkdir(parents=True,exist_ok=True)
        content=fetch(source)
        assert content.startswith(b'\x89PNG\r\n\x1a\n'),source
        path.write_bytes(content)
    return target
def related_cards(section,base_entries,evolution=False):
    result=[]
    for row in re.split(r'<div class="row per1-1"[^>]*>',section)[1:]:
        columns=re.split(r'<div class="col-(?:4|6|12)\b[^>]*>',row)[1:]
        for stage,column in enumerate(columns):
            match=re.search(r'<a href="/pokedex/view/(\d+)">(.*?)</a>',column,re.S)
            if not match:continue
            uid,block=match.groups()
            image=re.search(r'<img src="([^"]+)"',block)[1]
            heading=re.search(r'<h4>(.*?)</h4>',block,re.S)[1]
            texts=re.findall(r'<p[^>]*>(.*?)</p>',heading,re.S)
            form=re.search(r'</h4>\s*<p>(.*?)</p>',block,re.S)
            item={'uid':uid,'id':int(re.search(r'\d+',clean(texts[0]))[0]),'name':clean(texts[1]),'form':clean(form[1]) if form else '',
                  'types':[clean(t) for t in re.findall(r'<span class="badge[^>]*>(.*?)</span>',block,re.S)],'imageSource':image,
                  'image':base_entries[uid]['image'] if uid in base_entries else f'assets/forms/{uid}.png'}
            if evolution:item['stage']=stage
            if not any(p['uid']==uid for p in result):result.append(item)
    return result
def parse_entry(uid,base_entries):
    content=page_html(uid)
    main=content.split('<div class="book-ct">',1)[1].split('<div class="book-view',1)[0]
    heading=re.search(r'<h3><p class="font-lato">No\. (\d+)</p>(.*?)<p[^>]*>(.*?)</p></h3>',main,re.S)
    assert heading,uid
    image=re.search(r'<img src="(https://data1.pokemonkorea.co.kr/newdata/pokedex/full/[^"]+)"',main)[1]
    entry={'uid':uid,'id':int(heading[1]),'name':clean(heading[2]),'form':clean(heading[3]),'source':f'{BASE}/pokedex/view/{uid}',
           'imageSource':image,'image':base_entries[uid]['image'] if uid in base_entries else f'assets/forms/{uid}.png'}
    entry['types']=[clean(t) for t in re.findall(r'<span class="img-type">.*?<p>(.*?)</p></span>',main,re.S)]
    for key,label in [('height','키'),('weight','몸무게'),('category','분류')]:
        match=re.search(r'<h4[^>]*>'+label+r'</h4>\s*<p>(.*?)</p>',main,re.S)
        assert match,(uid,label)
        entry[key]=clean(match[1])
    gender=re.search(r'<h4[^>]*>성별</h4>\s*<div[^>]*>(.*?)</div>',main,re.S)[1]
    entry['genders']=[label for icon,label in [('icon-man','수컷'),('icon-woman','암컷')] if icon in gender]
    if not entry['genders']:entry['genders']=[clean(gender) or '불명']
    names=list(dict.fromkeys(re.findall(r"charmodalshow\('([^']+)'",main)))
    entry['abilities']=[{'name':name} for name in names];entry['ability']=' · '.join(names)
    texts=[clean(t) for t in re.findall(r'<p class="para descript"[^>]*>(.*?)</p>',main,re.S)]
    versions={}
    for label in re.findall(r'<label\b[^>]*>(.*?)</label>',main,re.S):
        index=re.search(r'name="series" value="(\d+)"',label);title=re.search(r'<span>(.*?)</span>',label,re.S)
        if index and title:versions[int(index[1])]=clean(title[1])
    entry['descriptions']=[{'version':versions.get(i,''),'text':text} for i,text in enumerate(texts) if text]
    entry['description']=texts[0] if texts else ''
    entry['evolutions'],entry['forms']=[],[]
    for section in re.split(r'<div class="bx-content(?: v2)?">',content.split('<div class="book-view',1)[-1])[1:]:
        title=clean(re.search(r'<h3>(.*?)</h3>',section,re.S)[1])
        if title=='진화':entry['evolutions']=related_cards(section,base_entries,evolution=True)
        elif title=='모습':entry['forms']=related_cards(section,base_entries)
    assert entry['types'] and entry['abilities'],uid
    return entry
def ability_text(name):
    path=CACHE/('ability-'+name+'.txt')
    if not path.exists():
        payload=urllib.parse.urlencode({'mode':'charcont','names':name}).encode()
        response=fetch(BASE+'/ajax/pokedex',payload).decode();parts=response.split('#|#')
        assert len(parts)>1 and clean(parts[1]),(name,response[:80])
        path.write_text(clean(parts[1]))
    return name,path.read_text()
def main():
    base=json.loads((ROOT/'dist/pokemon.json').read_text());assert len(base)==151
    base_entries={p['uid']:p for p in base};entries={};pending=set(base_entries)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        while pending:
            imported=list(pool.map(lambda uid:parse_entry(uid,base_entries),sorted(pending,key=int)))
            entries.update({p['uid']:p for p in imported})
            pending={p['uid'] for entry in imported for p in entry['evolutions']+entry['forms']}-entries.keys()
            assert len(entries)+len(pending)<600,'Unexpectedly broad related-entry graph'
            print(f'Official details: {len(entries)} collected, {len(pending)} related entries remaining.',flush=True)
        names=sorted({a['name'] for p in entries.values() for a in p['abilities']})
        abilities=dict(pool.map(ability_text,names));print(f'Official ability descriptions: {len(abilities)}.',flush=True)
        list(pool.map(lambda p:image_path(p['uid'],p['imageSource'],base_entries),entries.values()))
    for entry in entries.values():
        for ability in entry['abilities']:ability['description']=abilities[ability['name']]
    result=[entries[p['uid']] for p in base];extras={uid:p for uid,p in entries.items() if uid not in base_entries}
    (ROOT/'dist/pokemon.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    (ROOT/'dist/pokemon-details.json').write_text(json.dumps(extras,ensure_ascii=False,indent=2)+'\n')
    print(f'Imported 151 quiz entries and {len(extras)} related Pokédex entries with local images.',flush=True)
if __name__=='__main__':main()
