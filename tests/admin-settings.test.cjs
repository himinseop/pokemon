const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist'),defaults=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../infra/ranking/game-settings.json'))),names=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../infra/ranking/pokemon-names.json'))),flush=()=>new Promise(r=>setImmediate(r));
async function harness({url='http://localhost/admin',rejectSave=false}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'admin.html'),'utf8'),{url,runScripts:'outside-only'}),w=dom.window,calls=[];let settings=structuredClone(defaults);w.confirm=()=>true;
 w.fetch=async(url,options={})=>{url=String(url);calls.push({url,options});if(url==='/api/access/config')return {ok:true,json:async()=>({enabled:false,localPreview:true,admin:{clientId:''}})};
  if(url==='/api/admin/game-settings'){
   if(options.method==='PUT'){if(rejectSave)return {ok:false,status:409,json:async()=>({error:'최신 설정을 다시 불러와 주세요.'})};settings={...JSON.parse(options.body),version:settings.version+1};}
   return {ok:true,json:async()=>({settings,pokemonNames:names})};}
  throw Error('Unexpected API '+url);
 };w.eval(fs.readFileSync(path.join(root,'public/admin.js'),'utf8'));for(let i=0;i<5;i++)await flush();return {w,calls,$:s=>w.document.querySelector(s),close:()=>w.close()};
}
test('loopback admin exposes only local settings while a remote hostname still requires real login',async t=>{
 const local=await harness();t.after(local.close);assert.ok(local.$('#game-settings-form'));assert.equal(local.$('#admin-logout').hidden,true);assert.equal(local.$('[data-admin-page="shares"]').disabled,true);assert.ok(local.$('.admin-local-note'));
 const remote=await harness({url:'https://pokemon.pir.kr/admin'});t.after(remote.close);assert.ok(remote.$('#admin-login'));assert.ok(!remote.$('#game-settings-form'));assert.deepEqual(remote.calls.map(c=>c.url),['/api/access/config']);
});
test('rates, searched Pokemon selection and version are sent together, with a local anti-CSRF header',async t=>{
 const h=await harness();t.after(h.close);const rate=h.$('[data-familiar-rate="easy"]');rate.value='70';rate.dispatchEvent(new h.w.Event('input',{bubbles:true}));assert.equal(h.$('[data-rate-output="easy"]').textContent,'친숙 70% · 전체 30%');const search=h.$('#settings-pokemon-search');search.value='복숭악동';search.dispatchEvent(new h.w.Event('input',{bubbles:true}));const checkbox=h.$('[data-familiar-pokemon="1025"]');checkbox.checked=true;checkbox.dispatchEvent(new h.w.Event('change',{bubbles:true}));h.$('#game-settings-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<5;i++)await flush();const request=h.calls.find(c=>c.options.method==='PUT'),payload=JSON.parse(request.options.body);assert.equal(payload.version,0);assert.equal(payload.timeFamiliarPercent.easy,70);assert.ok(payload.familiarIds.includes(1025));assert.equal(request.options.headers['x-local-admin'],'1');assert.ok(h.$('#settings-save-message').textContent.includes('다음 도전부터'));assert.equal(h.$('[type="submit"]').disabled,false);
});
test('conflicting saves report the error and preserve editable form fields for reloading',async t=>{
 const h=await harness({rejectSave:true});t.after(h.close);h.$('#game-settings-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<5;i++)await flush();assert.ok(h.$('#settings-save-message').textContent.includes('최신 설정'));assert.equal(h.$('[data-familiar-rate="easy"]').disabled,false);assert.ok(!h.$('#settings-save-message').textContent.includes('저장했어요'));
});
