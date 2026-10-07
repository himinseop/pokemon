const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist'),flush=()=>new Promise(r=>setImmediate(r));
function server(){return {boards:new Map(),submissions:[],loseNextAck:false,deferMode:null,release:null};}
async function harness(shared){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://pokemon.pir.kr/',runScripts:'outside-only'}),w=dom.window;
 w.localStorage.setItem('pokemon-play-records',JSON.stringify([{id:'old-private',name:'개인기록',mode:'time-easy',score:999999,correct:1,total:1,date:'2020-01-01T00:00:00Z'}]));
 let id=0;w.setTimeout=()=>++id;w.clearTimeout=()=>{};w.setInterval=()=>++id;w.clearInterval=()=>{};
 w.Image=function(){const img=w.document.createElement('img');Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:240});img.decode=async()=>{};return img;};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.HTMLElement.prototype.scrollIntoView=function(){};
 const response=(data,ok=true)=>({ok,json:async()=>JSON.parse(JSON.stringify(data))});
 w.fetch=async(url,options={})=>{
  if(url.startsWith('/api/rankings')){
   const mode=new URL(url,'https://pokemon.pir.kr').searchParams.get('mode');
   if(mode===shared.deferMode)await new Promise(resolve=>shared.release=resolve);
   return response({mode,entries:shared.boards.get(mode)||[],serverTime:'2026-10-06T16:00:00.000Z'});
  }
  if(url==='/api/scores'){
   const payload=JSON.parse(options.body);shared.submissions.push(payload);assert.ok(!('score' in payload));assert.ok(!('date' in payload));
   const list=shared.boards.get(payload.mode)||[];let record=list.find(r=>r.id===payload.id);
   if(!record){record={id:payload.id,name:payload.name,mode:payload.mode,score:100,correct:1,total:1,date:'2026-10-06T16:00:01.000Z'};list.push(record);shared.boards.set(payload.mode,list);}
   if(shared.loseNextAck){shared.loseNextAck=false;return response({error:'응답을 받지 못했어요. 다시 시도해 주세요.'},false);}
   return response({qualified:true,rank:list.indexOf(record)+1,record,entries:list});
  }
  return response(JSON.parse(fs.readFileSync(path.join(root,url),'utf8')));
 };
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8')+';window.qa=code=>eval(code);');await flush();
 const $=selector=>w.document.querySelector(selector),click=selector=>{assert.ok($(selector),selector);$(selector).click();};
 return {w,$,click,close:()=>dom.window.close(),finish:async()=>{click('#start-game');await flush();const question=w.qa('game.question.id');click(`[data-answer="${question}"]`);w.qa('endGame()');await flush();},save:async name=>{$('#trainer-name').value=name;$('#save-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();}};
}
test('ranking uses two mode tabs and three difficulties without showing old device records',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);h.click('[data-nav="records"]');await flush();
 assert.equal(h.w.document.querySelectorAll('[data-ranking-mode]').length,2);assert.equal(h.w.document.querySelectorAll('[data-ranking-difficulty]').length,3);assert.ok(!h.$('#app').textContent.includes('개인기록'));
 for(const [kind,expected] of [['time',['time-easy','time','time-hard']],['write',['easy','normal','hard']]]){
  h.click(`[data-ranking-mode="${kind}"]`);
  for(const [i,level] of ['easy','normal','hard'].entries()){h.click(`[data-ranking-difficulty="${level}"]`);await flush();assert.equal(h.w.qa('recordTab'),expected[i]);assert.equal(h.$(`[data-ranking-difficulty="${level}"]`).getAttribute('aria-pressed'),'true');}
 }
});
test('a score saved in one browser appears in another and markup in a name is escaped',async t=>{
 const shared=server(),first=await harness(shared),second=await harness(shared);t.after(first.close);t.after(second.close);
 await first.finish();assert.ok(first.$('#high-score').open);await first.save('<탐험가>');assert.equal(first.w.qa('game.saved'),true);
 assert.ok(first.$('.my-entry').textContent.includes('<탐험가>'));assert.equal(first.$('.my-entry').querySelector('탐험가'),null);
 second.click('[data-nav="records"]');await flush();assert.ok(second.$('.ranking').textContent.includes('<탐험가>'));assert.equal(second.$('.ranking').querySelector('탐험가'),null);
 assert.ok(JSON.parse(first.w.localStorage.getItem('pokemon-play-records'))[0].name==='개인기록');assert.equal(shared.boards.get('time-easy').length,1);
});
test('a lost save acknowledgement keeps the name, enables retry and reuses the same record ID',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);await h.finish();shared.loseNextAck=true;
 await h.save('피카츄');assert.equal(h.w.qa('game.saved'),false);assert.equal(h.$('#trainer-name').value,'피카츄');assert.equal(h.$('.save-name').disabled,false);assert.ok(h.$('#save-message').textContent.includes('다시'));
 await h.save('피카츄');assert.equal(h.w.qa('game.saved'),true);assert.equal(shared.submissions[0].id,shared.submissions[1].id);assert.equal(shared.boards.get('time-easy').length,1);
});
test('a delayed board request cannot replace the game lobby after navigation',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);shared.deferMode='time-easy';h.click('[data-nav="records"]');assert.ok(h.$('.ranking-status'));
 h.click('[data-nav="play"]');assert.ok(h.$('#start-game'));shared.release();await flush();assert.ok(h.$('#start-game'));assert.equal(h.$('.ranking-controls'),null);
});
