const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist'),flush=()=>new Promise(r=>setImmediate(r));
function server(){return {boards:new Map(),submissions:[],loseNextAck:false,deferMode:null,release:null};}
async function harness(shared,{trainer='지우'}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://pokemon.pir.kr/',runScripts:'outside-only'}),w=dom.window;
 if(trainer!==null)w.localStorage.setItem('pokemon-play-trainer-name',trainer);
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
   if(!record){let score=0,streak=0;payload.results.forEach((correct,i)=>{if(!correct){streak=0;return;}streak++;score+=payload.mode.startsWith('time')?100+Math.min(streak-1,10)*10:({easy:100,normal:200,hard:300}[payload.mode]/(payload.hints?.[i]?2:1));});record={id:payload.id,name:payload.name,mode:payload.mode,score,correct:payload.results.filter(Boolean).length,total:payload.results.length,hintsUsed:(payload.hints||[]).filter(Boolean).length,date:'2026-10-06T16:00:01.000Z'};list.push(record);shared.boards.set(payload.mode,list);}
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

test('first visit requires a trainer name, then remembers it for the next visit',async t=>{
 const h=await harness(server(),{trainer:null});t.after(h.close);
 assert.ok(h.w.document.body.classList.contains('trainer-entry'));assert.equal(h.$('#start-game'),null);
 h.w.qa('startGame()');assert.equal(h.w.qa('game'),null);
 const input=h.$('#entry-trainer-name');input.value='   ';h.$('#trainer-entry-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.$('#start-game'),null);
 input.value='  지우  ';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));h.$('#trainer-entry-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
 assert.ok(h.$('#start-game'));assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),'지우');assert.equal(h.w.document.body.classList.contains('trainer-entry'),false);
 const again=await harness(server(),{trainer:h.w.localStorage.getItem('pokemon-play-trainer-name')});t.after(again.close);assert.ok(again.$('#start-game'));assert.equal(again.$('#entry-trainer-name'),null);
});
test('ranking prefills the trainer name and permits a separate edited name before saving',async t=>{
 const shared=server(),h=await harness(shared,{trainer:'아빠'});t.after(h.close);await h.finish();assert.equal(h.$('#trainer-name').value,'아빠');
 h.$('#trainer-name').value='꼬부기';h.$('#trainer-name').dispatchEvent(new h.w.Event('input',{bubbles:true}));h.click('#close-ranking');h.click('#enter-ranking');assert.equal(h.$('#trainer-name').value,'꼬부기');
 await h.save('꼬부기');assert.equal(shared.submissions[0].name,'꼬부기');assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),'아빠');
 assert.equal(h.$('.my-entry td:first-child .my-tag'),null);assert.equal(h.$('.my-entry td:nth-child(2) .my-tag').textContent,'나');assert.ok(!h.$('#save-message').textContent.includes('저장했어요'));
 h.click('#ranking-replay');assert.equal(h.w.qa('game'),null);assert.ok(h.$('#start-game'));assert.equal(h.w.qa('mode'),'time');assert.equal(h.w.qa('difficulty'),'easy');
});
test('quitting displays the end ranking and replay returns to the selected master difficulty',async t=>{
 const h=await harness(server());t.after(h.close);h.click('[data-mode="write"]');h.click('[data-difficulty="hard"]');h.click('#start-game');await flush();
 h.$('#answer-input').value=h.w.qa('game.question.name');h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));h.click('#quit-game');await flush();
 assert.equal(h.w.qa('game.status'),'ended');assert.equal(h.w.qa('game.quit'),true);assert.ok(h.$('#high-score').open);assert.equal(h.$('#save-message').textContent,'즐거운 도전이었어!');assert.equal(h.$('#trainer-name').value,'지우');
 h.click('#ranking-replay');await flush();assert.equal(h.w.qa('game'),null);assert.equal(h.w.qa('mode'),'write');assert.equal(h.w.qa('difficulty'),'hard');assert.equal(h.$('[data-mode="write"]').classList.contains('active'),true);assert.equal(h.$('[data-difficulty="hard"]').getAttribute('aria-pressed'),'true');assert.ok(h.$('#start-game'));
});
test('quitting with no answers still opens the leaderboard without offering a zero score save',async t=>{
 const h=await harness(server());t.after(h.close);h.click('#start-game');await flush();h.click('#quit-game');await flush();assert.ok(h.$('#high-score').open);assert.equal(h.$('#trainer-name'),null);assert.equal(h.$('#save-message').textContent,'즐거운 도전이었어!');h.click('#ranking-replay');assert.ok(h.$('#start-game'));
});
test('ranking dates use Korean calendar days and completed weeks, months and years',async t=>{
 const h=await harness(server());t.after(h.close);
 const relative=date=>h.w.qa(`rankingDate('${date}',new Date('2026-10-07T05:00:00Z'))`);
 for(const [date,label] of [['2026-10-07T00:04:00Z','09:04'],['2026-10-06T16:05:00Z','01:05'],['2026-10-06T00:00:00Z','1일전'],['2026-10-01T00:00:00Z','6일전'],['2026-09-30T00:00:00Z','1주전'],['2026-09-23T00:00:00Z','2주전'],['2026-09-07T00:00:00Z','1개월전'],['2025-11-07T00:00:00Z','11개월전'],['2025-10-07T00:00:00Z','1년전'],['2024-10-07T00:00:00Z','2년전']])assert.equal(relative(date),label,date);
 assert.equal(h.w.qa("rankingDate('2026-01-31T05:00:00Z',new Date('2026-02-28T05:00:00Z'))"),'1개월전');
});

test('replay saves the entered ranking name before returning to the selected lobby',async t=>{
 const shared=server(),h=await harness(shared,{trainer:'지우'});t.after(h.close);await h.finish();h.$('#trainer-name').value='우리집트레이너';h.click('#ranking-replay');
 assert.ok(h.w.qa('game'));assert.equal(h.$('#ranking-replay').disabled,true);await flush();
 assert.equal(h.w.qa('game'),null);assert.ok(h.$('#start-game'));assert.equal(shared.boards.get('time-easy')[0].name,'우리집트레이너');assert.equal(shared.submissions.length,1);assert.equal(h.w.qa('mode'),'time');assert.equal(h.w.qa('difficulty'),'easy');
});
test('replay stays on the name entry when saving fails and retries without duplicate records',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);await h.finish();shared.loseNextAck=true;h.$('#trainer-name').value='꼬부기';h.click('#ranking-replay');await flush();
 assert.equal(h.w.qa('game.status'),'ended');assert.ok(h.$('#high-score').open);assert.equal(h.$('#trainer-name').value,'꼬부기');assert.equal(h.$('#ranking-replay').disabled,false);assert.equal(h.$('#start-game'),null);
 h.click('#ranking-replay');await flush();assert.equal(h.w.qa('game'),null);assert.ok(h.$('#start-game'));assert.equal(shared.boards.get('time-easy').length,1);assert.equal(shared.submissions[0].id,shared.submissions[1].id);
});

test('saving and replaying a hinted master score sends hint history and stores the reduced score',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);h.click('[data-mode="write"]');h.click('[data-difficulty="hard"]');h.click('#start-game');await flush();h.click('#hint-question');h.$('#answer-input').value=h.w.qa('game.question.name');h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.w.qa('game.score'),150);h.click('#quit-game');await flush();h.click('#ranking-replay');await flush();
 assert.deepEqual(shared.submissions[0].hints,[true]);assert.equal(shared.boards.get('hard')[0].score,150);assert.equal(shared.boards.get('hard')[0].hintsUsed,1);assert.ok(h.$('#start-game'));assert.equal(h.w.qa('game'),null);
});
