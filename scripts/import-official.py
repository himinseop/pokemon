"""Refresh the complete official Korean Pokédex, quiz entries and related forms."""
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
    assert entry['types'],uid
    return entry
def ability_text(name):
    path=CACHE/('ability-'+name+'.txt')
    if not path.exists():
        payload=urllib.parse.urlencode({'mode':'charcont','names':name}).encode()
        response=fetch(BASE+'/ajax/pokedex',payload).decode();parts=response.split('#|#')
        assert len(parts)>1 and clean(parts[1]),(name,response[:80])
        path.write_text(clean(parts[1]))
    return name,path.read_text()
def official_listing():
    index=fetch(BASE+'/pokedex').decode()
    maximum=int(re.search(r'name="snumber2"[^>]*value="(\d+)"',index)[1])
    result=[]
    for page in range(1,251):
        cached=CACHE/f'listing-{maximum}-{page}.txt'
        if cached.exists():content=cached.read_text()
        else:
            payload=urllib.parse.urlencode({'mode':'load_more','word':'','characters':'','pn':page,'area':'',
                'snumber':1,'snumber2':maximum,'sortselval':'number asc,number_count asc','typestr':''}).encode()
            response=fetch(BASE+'/ajax/pokedex',payload).decode()
            parts=response.split('#|#');assert len(parts)>1,('listing',page)
            content=parts[1];cached.write_text(content)
        rows=re.findall(r'<li\b[^>]*>(.*?)</li>',content,re.S)
        if not rows:break
        for row in rows:
            uid=re.search(r"pokedex_detail\('[^']+',\s*'(\d+)'",row)[1]
            heading=re.search(r'<h3><p>No\.(\d+)</p>(.*?)</h3>',row,re.S)
            assert heading,uid
            result.append({'uid':uid,'id':int(heading[1]),'name':clean(heading[2])})
        if page%10==0:print(f'Official list: {len(result)} entries.',flush=True)
    else:raise AssertionError('Official listing did not end')
    assert len({p['uid'] for p in result})==len(result),'Duplicate official list entry'
    primary={}
    for p in result:primary.setdefault(p['id'],p)
    assert sorted(primary)==list(range(1,maximum+1)),('Missing national numbers',set(range(1,maximum+1))-primary.keys())
    print(f'Official list complete: {len(primary)} species, {len(result)} entries including forms.',flush=True)
    return list(primary.values()),result,maximum

def main():
    base,listing,maximum=official_listing()
    previous=json.loads((ROOT/'dist/pokemon.json').read_text())
    previous+=list(json.loads((ROOT/'dist/pokemon-details.json').read_text()).values())
    existing={p['uid']:p for p in previous}
    base_entries={p['uid']:{**p,'image':existing[p['uid']]['image'] if p['uid'] in existing else f"assets/national/{p['id']:04d}.png"} for p in base}
    entries={};pending={p['uid'] for p in listing}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        while pending:
            imported=[]
            for i,p in enumerate(pool.map(lambda uid:parse_entry(uid,base_entries),sorted(pending,key=int)),1):
                imported.append(p)
                if i%50==0:print(f'Official details: {len(entries)+i} collected.',flush=True)
            entries.update({p['uid']:p for p in imported})
            pending={p['uid'] for entry in imported for p in entry['evolutions']+entry['forms']}-entries.keys()
            assert len(entries)+len(pending)<3000,'Unexpectedly broad related-entry graph'
            print(f'Official details: {len(entries)} collected, {len(pending)} related entries remaining.',flush=True)
        names=sorted({a['name'] for p in entries.values() for a in p['abilities']})
        abilities=dict(pool.map(ability_text,names));print(f'Official ability descriptions: {len(abilities)}.',flush=True)
        for i,_ in enumerate(pool.map(lambda p:image_path(p['uid'],p['imageSource'],base_entries),entries.values()),1):
            if i%100==0:print(f'Official artwork: {i} / {len(entries)} ready.',flush=True)
    for entry in entries.values():
        for ability in entry['abilities']:ability['description']=abilities[ability['name']]
    result=[entries[p['uid']] for p in base];extras={uid:p for uid,p in entries.items() if uid not in base_entries}
    assert [p['id'] for p in result]==list(range(1,maximum+1))
    manifest={'source':BASE+'/pokedex','collectedAt':'2026-10-01','speciesCount':len(result),'relatedFormCount':len(extras),
        'entryCount':len(entries),'maxNumber':maximum,'officialListingCount':len(listing)}
    for filename,data in [('pokemon.json',result),('pokemon-details.json',extras),('pokedex-manifest.json',manifest)]:
        target=ROOT/'dist'/filename
        temp=target.with_suffix('.json.tmp');temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');temp.replace(target)
    print(f'Imported {len(result)} quiz entries and {len(extras)} related Pokédex entries with local images.',flush=True)
if __name__=='__main__':main()
