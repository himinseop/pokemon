const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist'),flush=()=>new Promise(r=>setImmediate(r));
function server(){return {boards:new Map(),monthlyBoards:new Map(),personalBests:new Map(),requests:[],submissions:[],loseNextAck:false,deferMode:null,release:null};}
async function harness(shared,{trainer='지우',profiles=null,storageBroken=false}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'game.html'),'utf8'),{url:'https://pokemon.pir.kr/',runScripts:'outside-only'}),w=dom.window;
 if(trainer!==null)w.localStorage.setItem('pokemon-play-trainer-name',trainer);
 if(profiles)w.localStorage.setItem('pokemon-play-trainers-v1',JSON.stringify(profiles));
 w.localStorage.setItem('pokemon-play-records',JSON.stringify([{id:'old-private',name:'개인기록',mode:'time-easy',score:999999,correct:1,total:1,date:'2020-01-01T00:00:00Z'}]));
 if(storageBroken)w.Storage.prototype.setItem=()=>{throw Error('storage unavailable');};
 let id=0;w.setTimeout=()=>++id;w.clearTimeout=()=>{};w.setInterval=()=>++id;w.clearInterval=()=>{};
 w.Image=function(){const img=w.document.createElement('img');Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:240});img.decode=async()=>{};return img;};
 w.confirm=()=>true;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.HTMLElement.prototype.scrollIntoView=function(){};
 const response=(data,ok=true)=>({ok,json:async()=>JSON.parse(JSON.stringify(data))});
 w.fetch=async(url,options={})=>{
  if(url.startsWith('/api/rankings')){
   const params=new URL(url,'https://pokemon.pir.kr').searchParams,mode=params.get('mode'),month=params.get('month');shared.requests.push({mode,month});
   if(mode===shared.deferMode)await new Promise(resolve=>shared.release=resolve);
   return response({mode,month,personalBest:shared.personalBests.get(mode+':'+params.get('trainer'))||null,entries:shared.monthlyBoards.get(month+':'+mode)||shared.boards.get(mode)||[],serverTime:'2026-10-06T16:00:00.000Z'});
  }
  if(url.startsWith('/api/scores')){
   const month=new URL(url,'https://pokemon.pir.kr').searchParams.get('month'),payload=JSON.parse(options.body);shared.submissions.push(payload);assert.ok(!('score' in payload));assert.ok(!('date' in payload));
   if(shared.keepBestOnSave){const best=shared.keepBestOnSave;shared.boards.set(payload.mode,[best]);return response({month,qualified:true,rank:1,record:best,entries:[best],keptBest:true});}
   const list=shared.boards.get(payload.mode)||[];let record=list.find(r=>r.id===payload.id);
   if(!record){let score=0,streak=0;payload.results.forEach((correct,i)=>{if(!correct){streak=0;return;}streak++;score+=payload.mode.startsWith('time')?100+Math.min(streak-1,10)*10:({easy:100,normal:200,hard:300}[payload.mode]/(payload.hints?.[i]?2:1)+(payload.hints?.[i]?0:Math.ceil((20000-(payload.elapsedMs?.[i]??20000))*({easy:50,normal:100,hard:150}[payload.mode])/(20000*10))*10));});record={...('partnerId' in payload?{partnerId:payload.partnerId}:{}),id:payload.id,name:payload.name,mode:payload.mode,score,correct:payload.results.filter(Boolean).length,total:payload.results.length,hintsUsed:(payload.hints||[]).filter(Boolean).length,date:'2026-10-06T16:00:01.000Z'};list.push(record);shared.boards.set(payload.mode,list);}
   if(shared.loseNextAck){shared.loseNextAck=false;return response({error:'응답을 받지 못했어요. 다시 시도해 주세요.'},false);}
   const key=r=>r.name.normalize('NFKC').trim().toLocaleLowerCase('ko'),winner=list.filter(r=>key(r)===key(record)).sort((a,b)=>b.score-a.score||Date.parse(b.date)-Date.parse(a.date))[0];
   const entries=[...list.filter(r=>key(r)!==key(record)),winner].sort((a,b)=>b.score-a.score||Date.parse(b.date)-Date.parse(a.date));shared.boards.set(payload.mode,entries);
   return response({month,qualified:true,rank:entries.indexOf(winner)+1,record:winner,entries,keptBest:winner.id!==payload.id});
  }
  return response(JSON.parse(fs.readFileSync(path.join(root,url),'utf8')));
 };
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8')+';window.qa=code=>eval(code);');await flush();
 const $=selector=>w.document.querySelector(selector),click=selector=>{assert.ok($(selector),selector);$(selector).click();};
 return {w,$,click,close:()=>dom.window.close(),finish:async({openRanking=true}={})=>{click('#start-game');await flush();const question=w.qa('game.question.id');click(`[data-answer="${question}"]`);w.qa('endGame()');await flush();if(openRanking&&$('#enter-ranking'))click('#enter-ranking');},save:async name=>{$('#trainer-name').value=name;$('#save-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();}};
}
test('ranking shows time and memory tabs with three difficulties and hides master',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);h.click('[data-nav="records"]');await flush();
 assert.equal(h.w.document.querySelectorAll('[data-ranking-mode]').length,2);assert.equal(h.w.document.querySelectorAll('[data-ranking-difficulty]').length,3);assert.ok(!h.$('#app').textContent.includes('개인기록'));
 for(const [kind,expected] of [['time',['time-easy','time','time-hard']],['memory',['memory-easy','memory-normal','memory-hard']]]){
  h.click(`[data-ranking-mode="${kind}"]`);
  for(const [i,level] of ['easy','normal','hard'].entries()){h.click(`[data-ranking-difficulty="${level}"]`);await flush();assert.equal(h.w.qa('recordTab'),expected[i]);assert.equal(h.$(`[data-ranking-difficulty="${level}"]`).getAttribute('aria-pressed'),'true');}
 }
});
test('opening an old master board selects time attack without changing its records',async t=>{
 const shared=server(),row={id:'master-best',name:'지우',mode:'hard',score:300,correct:1,total:10,date:'2026-10-07T00:00:00Z'};
 shared.boards.set('hard',[row]);const h=await harness(shared);t.after(h.close);
 h.w.qa("recordTab='hard';view='records';render()");await flush();
 assert.equal(h.w.qa('recordTab'),'time-hard');assert.equal(h.$('[data-ranking-mode="write"]'),null);
 assert.equal(h.$('[data-ranking-mode="time"]').getAttribute('aria-pressed'),'true');
 assert.equal(h.$('[data-ranking-difficulty="hard"]').getAttribute('aria-pressed'),'true');
 assert.ok(!h.$('#app').textContent.includes('마스터'));assert.deepEqual(shared.boards.get('hard'),[row]);
});
test('equal scores show newer friends first even when older friends answered more questions',async t=>{
 const shared=server(),entry=(id,score,correct,date)=>({id,name:id,mode:'time-easy',score,correct,total:10,date});
 shared.boards.set('time-easy',[
  entry('older',500,8,'2026-10-07T00:00:00Z'),
  entry('newer',500,5,'2026-10-07T01:00:00Z'),
  entry('highest',600,6,'2026-10-06T00:00:00Z'),
 ]);
 const h=await harness(shared);t.after(h.close);h.click('[data-nav="records"]');await flush();
 assert.deepEqual([...h.w.document.querySelectorAll('.ranking tbody .trainer-name-text')].map(node=>node.textContent),['highest','newer','older']);
 assert.ok(h.$('#app').textContent.includes('동점은 최근 기록부터'));
 const own=entry('mine',500,4,'2026-10-07T01:30:00Z');
 assert.equal(h.w.qa(`rankOf(${JSON.stringify(own)})`),2);
 // The preview and final name entry use the same tie rule.
 h.click('[data-nav="play"]');await h.finish();h.w.qa('game.record.score=500;game.score=500;game.record.correct=4;game.record.date="2026-10-07T01:30:00Z";game.rank=rankOf(game.record);showRankingEntry()');
 assert.equal(h.$('.my-entry td:first-child .rank-medal').getAttribute('aria-label'),'2등');
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
 assert.ok(h.$('#find-partner'));assert.equal(h.$('#start-game'),null);h.click('#skip-partner');
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
test('a retained master game can finish and replay returns to time attack at the same difficulty',async t=>{
 const h=await harness(server());t.after(h.close);h.w.qa("mode='write';renderPlay()");h.click('[data-difficulty="hard"]');h.click('#start-game');await flush();
 h.$('#answer-input').value=h.w.qa('game.question.name');h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));h.click('#quit-game');await flush();
 assert.equal(h.w.qa('game.status'),'ended');assert.equal(h.w.qa('game.quit'),true);assert.equal(h.$('#high-score').open,false);h.click('#enter-ranking');assert.equal(h.$('#save-message').textContent,'즐거운 도전이었어!');assert.equal(h.$('#trainer-name').value,'지우');
 h.click('#ranking-replay');await flush();assert.equal(h.w.qa('game'),null);assert.equal(h.w.qa('mode'),'time');assert.equal(h.w.qa('difficulty'),'hard');assert.equal(h.$('[data-mode="time"]').classList.contains('active'),true);assert.equal(h.$('[data-mode="write"]'),null);assert.equal(h.$('[data-difficulty="hard"]').getAttribute('aria-pressed'),'true');assert.ok(h.$('#start-game'));
});
test('quitting with no answers keeps the score screen without opening a leaderboard',async t=>{
 const h=await harness(server());t.after(h.close);h.click('#start-game');await flush();h.click('#quit-game');await flush();assert.equal(h.$('#high-score').open,false);assert.equal(h.$('#trainer-name'),null);assert.equal(h.$('.big-score').textContent,'0점');h.click('#result-replay');assert.ok(h.$('#start-game'));
});
test('ranking dates show time today, relative days through day six, then month and day',async t=>{
 const h=await harness(server());t.after(h.close);
 const relative=date=>h.w.qa(`rankingDate('${date}',new Date('2026-10-07T05:00:00Z'))`);
 for(const [date,label] of [['2026-10-07T00:04:00Z','09:04'],['2026-10-06T16:05:00Z','01:05'],['2026-10-06T00:00:00Z','1일전'],['2026-10-01T00:00:00Z','6일전'],['2026-09-30T00:00:00Z','9월30일'],['2026-09-23T00:00:00Z','9월23일'],['2026-09-07T00:00:00Z','9월7일'],['2025-11-07T00:00:00Z','11월7일'],['2025-10-07T00:00:00Z','10월7일'],['2024-10-07T00:00:00Z','10월7일']])assert.equal(relative(date),label,date);
 assert.equal(h.w.qa("rankingDate('2026-01-31T05:00:00Z',new Date('2026-02-28T05:00:00Z'))"),'1월31일');
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
 const shared=server(),h=await harness(shared);t.after(h.close);h.w.qa("mode='write';renderPlay()");h.click('[data-difficulty="hard"]');h.click('#start-game');await flush();h.click('#hint-question');h.$('#answer-input').value=h.w.qa('game.question.name');h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.w.qa('game.score'),150);h.click('#quit-game');await flush();h.click('#enter-ranking');h.click('#ranking-replay');await flush();
 assert.deepEqual(shared.submissions[0].hints,[true]);assert.equal(shared.boards.get('hard')[0].score,150);assert.equal(shared.boards.get('hard')[0].hintsUsed,1);assert.ok(h.$('#start-game'));assert.equal(h.w.qa('game'),null);
});

test('saving a master time bonus sends the measured duration and keeps the server-calculated score',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);h.w.qa("mode='write';renderPlay()");h.click('[data-difficulty="normal"]');h.click('#start-game');await flush();Object.defineProperty(h.w.performance,'now',{value:()=>10000});h.w.qa('game.questionStartedAt=0');h.$('#answer-input').value=h.w.qa('game.question.name');h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.w.qa('game.score'),250);h.click('#quit-game');await flush();h.click('#enter-ranking');h.click('#ranking-replay');await flush();assert.deepEqual(shared.submissions[0].elapsedMs,[10000]);assert.deepEqual(shared.submissions[0].hints,[false]);assert.equal(shared.boards.get('normal')[0].score,250);assert.ok(h.$('#start-game'));
});

test('siblings select saved trainers with independent partners and a legacy trainer is preserved',async t=>{
 const h=await harness(server(),{trainer:'지우'});t.after(h.close);
 assert.ok(h.$('#start-game'));assert.equal(h.$('#partner-welcome-title'),null);
 h.click('#edit-trainer');assert.equal(h.$('[data-select-trainer="지우"] .partner-avatar').getAttribute('src'),'assets/ui/pokeball.svg');
 h.$('#entry-trainer-name').value='이슬';h.$('#trainer-entry-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.ok(h.$('#find-partner'));assert.equal(h.$('#start-game'),null);
 h.click('#find-partner');assert.ok(h.$('#partner-picker').open);h.$('#partner-search').value='피카츄';h.$('#partner-search').dispatchEvent(new h.w.Event('input',{bubbles:true}));assert.equal(h.w.document.querySelectorAll('.partner-choice').length,1);
 h.click('[data-choose-partner="25"]');assert.equal(h.$('#partner-picker').open,false);assert.ok(h.$('#start-game'));assert.equal(h.$('.trainer-avatar-button').dataset.pokemon,'25');
 const saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.deepEqual(saved.trainers,[{name:'지우',partnerId:null,partnerChosen:true},{name:'이슬',partnerId:25,partnerChosen:true}]);
 h.click('#edit-trainer');assert.equal(h.$('[data-select-trainer="이슬"] img').getAttribute('src'),h.w.qa('pokemonById.get(25).image'));h.click('[data-select-trainer="지우"]');assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),'지우');assert.equal(h.w.qa('currentPartnerId()'),null);
 h.click('#edit-trainer');h.click('[data-select-trainer="이슬"]');assert.equal(h.w.qa('currentPartnerId()'),25);
 const reloaded=await harness(server(),{trainer:'이슬',profiles:JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'))});t.after(reloaded.close);assert.ok(reloaded.$('#start-game'));assert.equal(reloaded.$('.trainer-avatar-button').dataset.pokemon,'25');
});

test('a partner card opens from the profile and its third tool replaces just that trainer partner',async t=>{
 const profiles={version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'이슬',partnerId:7,partnerChosen:true}]},h=await harness(server(),{profiles});t.after(h.close);
 h.click('.trainer-avatar-button');assert.ok(h.$('#detail').open);assert.equal(h.$('#detail-title').textContent,'피카츄');assert.equal(h.$('[data-partner-pokemon]').getAttribute('aria-pressed'),'true');
 assert.equal(h.$('.detail-tools').children.length,3);assert.equal(h.$('.detail-tools').children[2].dataset.partnerPokemon,'25');h.click('#close-detail');
 h.w.qa('showDetail(133)');h.click('[data-partner-pokemon="133"]');assert.equal(h.$('#detail').open,false);assert.equal(h.$('.trainer-avatar-button').dataset.pokemon,'133');
 const saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.equal(saved.trainers[1].partnerId,7);assert.equal(saved.trainers[0].partnerId,133);
});

test('ranking partner snapshots are shared and do not change when the trainer chooses another partner',async t=>{
 const shared=server(),profiles={version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true}]},h=await harness(shared,{profiles});t.after(h.close);
 await h.finish();assert.ok(h.$('.entry-input .ranking-partner'));await h.save('지우');assert.equal(shared.submissions[0].partnerId,25);assert.equal(shared.boards.get('time-easy')[0].partnerId,25);assert.ok(h.$('.trainer-name-label .ranking-partner'));
 h.click('#ranking-replay');h.w.qa('showDetail(133)');h.click('[data-partner-pokemon="133"]');assert.equal(h.w.qa('currentPartnerId()'),133);
 h.click('[data-nav="records"]');await flush();assert.equal(h.$('.ranking-partner').getAttribute('src'),h.w.qa('pokemonById.get(25).image'));assert.equal(shared.boards.get('time-easy')[0].partnerId,25);
 const other=await harness(shared,{trainer:'이슬'});t.after(other.close);other.click('[data-nav="records"]');await flush();assert.equal(other.$('.ranking-partner').getAttribute('src'),other.w.qa('pokemonById.get(25).image'));
});

test('skipping a partner persists the choice and resuming incomplete setup does not show the name entry',async t=>{
 const h=await harness(server(),{trainer:'지우',profiles:{version:1,trainers:[{name:'지우',partnerId:null,partnerChosen:false}]}});t.after(h.close);assert.ok(h.$('#find-partner'));assert.equal(h.$('#entry-trainer-name'),null);h.click('#skip-partner');assert.ok(h.$('#start-game'));assert.equal(h.w.qa('currentTrainer().partnerChosen'),true);assert.equal(h.w.qa('currentPartnerId()'),null);
 const again=await harness(server(),{trainer:'지우',profiles:JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'))});t.after(again.close);assert.ok(again.$('#start-game'));assert.equal(again.$('#partner-welcome-title'),null);
});

test('legacy ranking rows, corrupt local profiles and unavailable storage still allow play',async t=>{
 const shared=server();shared.boards.set('time-easy',[{id:'legacy-record-0001',name:'옛 친구',mode:'time-easy',score:100,correct:1,total:1,date:'2026-10-01T00:00:00Z'}]);
 const h=await harness(shared,{profiles:{version:1,trainers:[null,{name:'bad\u0000',partnerId:25},{name:'지우',partnerId:'javascript:bad'},{name:'지우',partnerId:133}]},storageBroken:true});t.after(h.close);assert.ok(h.$('#start-game'));assert.equal(h.w.qa('currentPartnerId()'),null);
 h.click('#edit-trainer');h.$('#entry-trainer-name').value='새 친구';h.$('#trainer-entry-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));h.click('#find-partner');h.click('[data-choose-partner="7"]');assert.ok(h.$('#start-game'));assert.equal(h.w.qa('currentPartnerId()'),7);
 h.click('[data-nav="records"]');await flush();assert.ok(h.$('.trainer-name-text').textContent.includes('옛 친구'));assert.equal(h.$('.ranking-partner'),null);
});


test('saving a partner from an older tab preserves trainers and partners saved by another tab',async t=>{
 const h=await harness(server(),{profiles:{version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'이슬',partnerId:7,partnerChosen:true}]}});t.after(h.close);
 h.w.localStorage.setItem('pokemon-play-trainers-v1',JSON.stringify({version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'이슬',partnerId:133,partnerChosen:true},{name:'새 친구',partnerId:1,partnerChosen:true}]}));
 h.w.qa('showDetail(4)');h.click('[data-partner-pokemon="4"]');
 const saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.deepEqual(saved.trainers,[{name:'지우',partnerId:4,partnerChosen:true},{name:'이슬',partnerId:133,partnerChosen:true},{name:'새 친구',partnerId:1,partnerChosen:true}]);
});


test('deleting saved trainers supports cancel, keeps other profiles and leaves rankings and device keys intact',async t=>{
 const shared=server(),h=await harness(shared,{profiles:{version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'이슬',partnerId:7,partnerChosen:true}]}});t.after(h.close);
 h.w.localStorage.setItem('pokemon-party-device-key','unchanged-device');h.w.localStorage.setItem('pokemon-party-last-verification','unchanged-receipt');
 h.click('#edit-trainer');assert.equal(h.w.document.querySelectorAll('.delete-trainer').length,2);assert.equal(h.$('.delete-trainer').closest('.saved-trainer'),null);
 h.w.confirm=()=>false;h.click('[data-delete-trainer="이슬"]');assert.ok(h.$('[data-select-trainer="이슬"]'));
 h.w.confirm=()=>true;h.click('[data-delete-trainer="이슬"]');assert.equal(h.$('[data-select-trainer="이슬"]'),null);assert.equal(h.w.qa('trainerName'),'지우');assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),'지우');
 assert.equal(h.w.localStorage.getItem('pokemon-party-device-key'),'unchanged-device');assert.equal(h.w.localStorage.getItem('pokemon-party-last-verification'),'unchanged-receipt');assert.equal(shared.submissions.length,0);
 h.click('[data-delete-trainer="지우"]');assert.equal(h.w.qa('trainerName'),'');assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),null);assert.equal(h.$('#entry-trainer-name').value,'');assert.equal(h.w.document.querySelectorAll('.saved-trainer').length,0);
 const saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.deepEqual(saved.trainers,[]);
 const again=await harness(shared,{trainer:null,profiles:saved});t.after(again.close);assert.ok(again.$('#entry-trainer-name'));assert.equal(again.$('#start-game'),null);assert.equal(again.w.document.querySelectorAll('.saved-trainer').length,0);
});

test('an older tab cannot restore a deleted profile but explicitly entering its name can start anew',async t=>{
 const h=await harness(server(),{profiles:{version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'이슬',partnerId:7,partnerChosen:true}]}});t.after(h.close);
 h.w.localStorage.setItem('pokemon-play-trainers-v1',JSON.stringify({version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true},{name:'새 친구',partnerId:133,partnerChosen:true}]}));
 h.w.qa('showDetail(4)');h.click('[data-partner-pokemon="4"]');let saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.deepEqual(saved.trainers.map(t=>t.name),['지우','새 친구']);
 h.click('#edit-trainer');h.click('[data-delete-trainer="지우"]');h.$('#entry-trainer-name').value='지우';h.$('#trainer-entry-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.ok(h.$('#find-partner'));assert.equal(h.w.qa('currentPartnerId()'),null);h.click('#skip-partner');assert.ok(h.$('#start-game'));
 saved=JSON.parse(h.w.localStorage.getItem('pokemon-play-trainers-v1'));assert.deepEqual(saved.trainers.map(t=>t.name),['새 친구','지우']);
});

test('failed local deletion leaves the stored trainer and selection visible',async t=>{
 const h=await harness(server(),{profiles:{version:1,trainers:[{name:'지우',partnerId:25,partnerChosen:true}]}});t.after(h.close);h.click('#edit-trainer');const original=h.w.localStorage.getItem('pokemon-play-trainers-v1');
 h.w.Storage.prototype.setItem=()=>{throw Error('storage blocked');};h.click('[data-delete-trainer="지우"]');assert.ok(h.$('[data-select-trainer="지우"]'));assert.equal(h.w.localStorage.getItem('pokemon-play-trainer-name'),'지우');assert.equal(h.w.localStorage.getItem('pokemon-play-trainers-v1'),original);assert.ok(h.$('#trainer-entry-message').textContent.includes('삭제하지 못했어'));
});


test('legacy repeated names show only their highest recent record on the full ranking page',async t=>{
 const shared=server(),row={id:'legacy-best-record1',name:'지우',mode:'time-easy',score:1000,correct:8,total:10,date:'2026-10-12T00:00:00Z'};shared.boards.set('time-easy',[row,{...row,id:'legacy-low-record01',score:500},{...row,id:'legacy-new-record01',date:'2026-10-12T01:00:00Z'},{...row,id:'legacy-sibling-0001',name:'이슬',score:200}]);
 const h=await harness(shared);t.after(h.close);h.click('[data-nav="records"]');await flush();assert.equal(h.w.document.querySelectorAll('.ranking tbody tr').length,2);assert.deepEqual([...h.w.document.querySelectorAll('.ranking .trainer-name-text')].map(e=>e.textContent),['지우','이슬']);assert.equal(shared.boards.get('time-easy').length,4);
});

test('a lower attempt shows the previous best, keeps actual game points, and replay returns home',async t=>{
 const shared=server(),best={id:'my-previous-best01',name:'지우',mode:'time-easy',score:1500,correct:10,total:10,date:'2026-10-12T00:00:00Z',partnerId:25};shared.boards.set('time-easy',[best]);const h=await harness(shared);t.after(h.close);await h.finish();
 assert.equal(h.w.qa('game.score'),100);assert.equal(h.w.qa('game.keptBest'),true);assert.equal(h.w.qa('game.record.id'),best.id);assert.equal(h.$('#trainer-name'),null);assert.equal(h.$('#high-score').open,false);assert.ok(h.$('.result'));assert.equal(shared.submissions.length,0);h.click('#result-replay');assert.ok(h.$('#start-game'));assert.equal(shared.boards.get('time-easy')[0].score,1500);
});

test('a higher concurrent submission during name entry keeps the best acknowledgement and permits replay',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);await h.finish();shared.keepBestOnSave={id:'racing-high-score01',name:'지우',mode:'time-easy',score:2000,correct:15,total:15,date:'2026-10-12T01:00:00Z',partnerId:133};await h.save('지우');
 assert.equal(h.w.qa('game.saved'),true);assert.equal(h.w.qa('game.keptBest'),true);assert.equal(h.w.qa('game.score'),100);assert.equal(h.w.qa('game.record.id'),'racing-high-score01');assert.equal(h.w.document.querySelectorAll('.entry-ranking tbody tr').length,1);h.click('#ranking-replay');assert.ok(h.$('#start-game'));
});


test('monthly ranking starts this month, browses the previous month, and preserves mode and difficulty',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);
 const month=h.w.qa('currentRankingMonth()'),past=h.w.qa(`shiftedRankingMonth('${month}',-1)`);
 shared.monthlyBoards.set(month+':memory-hard',[{id:'this-month-memory',name:'이번달친구',mode:'memory-hard',score:0,correct:15,total:15,pairs:15,moves:15,durationMs:3000,date:month+'-02T00:00:00Z'}]);
 shared.monthlyBoards.set(past+':memory-hard',[{id:'past-month-memory',name:'지난달친구',mode:'memory-hard',score:0,correct:15,total:15,pairs:15,moves:15,durationMs:1000,date:past+'-02T00:00:00Z'}]);
 h.click('[data-nav="records"]');await flush();assert.equal(h.$('.ranking-current-month strong').textContent,'이번달 랭킹');
 assert.equal(h.$('.month-next').disabled,true);h.click('[data-ranking-mode="memory"]');h.click('[data-ranking-difficulty="hard"]');await flush();
 assert.ok(h.$('.ranking').textContent.includes('이번달친구'));
 h.click(`[data-ranking-month="${past}"]`);await flush();assert.ok(h.$('.ranking').textContent.includes('지난달친구'));assert.ok(!h.$('.ranking').textContent.includes('이번달친구'));
 assert.equal(h.w.qa('recordTab'),'memory-hard');assert.equal(h.$('[data-ranking-difficulty="hard"]').getAttribute('aria-pressed'),'true');
 h.click('[data-ranking-month="current"]');await flush();assert.ok(h.$('.ranking').textContent.includes('이번달친구'));assert.equal(h.w.qa('selectedRankingMonth'),null);
});
test('a late response for the previous month cannot replace the selected current-month board',async t=>{
 const shared=server(),h=await harness(shared);t.after(h.close);h.click('[data-nav="records"]');await flush();
 const current=h.w.qa('currentRankingMonth()'),past=h.w.qa(`shiftedRankingMonth('${current}',-1)`);shared.deferMode='time-easy';
 h.click(`[data-ranking-month="${past}"]`);assert.ok(h.$('.ranking-status'));h.click('[data-ranking-month="current"]');assert.equal(h.w.qa('selectedRankingMonth'),null);
 shared.release();await flush();assert.equal(h.$('.ranking-current-month strong').textContent,'이번달 랭킹');assert.equal(h.$('.ranking-status'),null);
});
test('Korean month and displayed dates cross midnight and year boundaries correctly',async t=>{
 const h=await harness(server());t.after(h.close);
 assert.equal(h.w.qa("currentRankingMonth('2026-09-30T14:59:59Z')"),'2026-09');assert.equal(h.w.qa("currentRankingMonth('2026-09-30T15:00:00Z')"),'2026-10');
 assert.equal(h.w.qa("shiftedRankingMonth('2026-01',-1)"),'2025-12');assert.equal(h.w.qa("shiftedRankingMonth('2025-12',1)"),'2026-01');
 assert.equal(h.w.qa("rankingDate('2026-10-29T01:00:00Z',new Date('2026-11-05T01:00:00Z'))"),'10월29일');
 assert.equal(h.w.qa("rankingDate('2026-10-29T01:00:00Z',new Date('2026-11-04T01:00:00Z'))"),'6일전');
});


test('finishing keeps the score screen visible until the player explicitly opens name registration',async t=>{
 const h=await harness(server());t.after(h.close);await h.finish({openRanking:false});
 assert.equal(h.$('#high-score').open,false);assert.equal(h.$('.big-score').textContent,'100점');assert.ok(h.$('.personal-result'));assert.equal(h.$('.ranking-controls'),null);
 h.w.qa('renderGameBody()');assert.equal(h.$('#high-score').open,false);h.click('#enter-ranking');assert.equal(h.$('#high-score').open,true);
});
for(const [score,outcome,label] of [[50,'improved','이전 최고기록'],[1500,'below','나의 최고기록'],[100,'equal','나의 최고기록']]){
 test(`score feedback compares the personal best independently of monthly rank: ${outcome}`,async t=>{
  const shared=server();shared.personalBests.set('time-easy:지우',{id:'lifetime-best-score1',name:'지우',mode:'time-easy',score,correct:1,total:1,date:'2026-09-01T00:00:00Z'});
  const h=await harness(shared);t.after(h.close);await h.finish({openRanking:false});
  assert.equal(h.w.qa('game.personalOutcome'),outcome);assert.equal(h.$('.big-score').textContent,'100점');assert.ok(h.$('.personal-result p').textContent.includes(label));assert.ok(h.$('.personal-result b').textContent.includes(score.toLocaleString()));
  if(outcome==='improved')assert.equal(h.$('.personal-result>strong').textContent,'축하해. 너의 최고기록을 경신했어.');
  assert.equal(h.$('#high-score').open,false);
 });
}
test('encouragement rotates between attempts and stays stable while the result rerenders',async t=>{
 const shared=server();shared.personalBests.set('time-easy:지우',{id:'lifetime-best-score1',name:'지우',mode:'time-easy',score:1500,correct:5,total:5,date:'2026-09-01T00:00:00Z'});
 const h=await harness(shared);t.after(h.close);const messages=[];
 for(let i=0;i<4;i++){await h.finish({openRanking:false});const message=h.$('.personal-result>strong').textContent;messages.push(message);h.w.qa('renderGameBody()');assert.equal(h.$('.personal-result>strong').textContent,message);h.click('#result-replay');}
 assert.equal(new Set(messages.slice(0,3)).size,3);assert.equal(messages[0],messages[3]);
});
test('first-record feedback and personal scores survive local storage failure without blocking replay',async t=>{
 const h=await harness(server(),{storageBroken:true});t.after(h.close);await h.finish({openRanking:false});assert.equal(h.w.qa('game.personalOutcome'),'first');assert.ok(h.$('.personal-result'));h.click('#result-replay');assert.ok(h.$('#start-game'));
});
test('month navigation sits above the list and a difficulty change returns to this month',async t=>{
 const h=await harness(server());t.after(h.close);h.click('[data-nav="records"]');await flush();
 assert.equal(h.$('.ranking-months').previousElementSibling.className,'ranking-controls');assert.equal(h.$('.ranking-months').nextElementSibling.className,'shared-ranking-board');assert.equal(h.$('.ranking-current-month>span'),null);
 const past=h.w.qa("shiftedRankingMonth(currentRankingMonth(),-1)");h.click(`[data-ranking-month="${past}"]`);await flush();h.click('[data-ranking-difficulty="hard"]');await flush();assert.equal(h.w.qa('selectedRankingMonth'),null);assert.equal(h.$('.ranking-current-month strong').textContent,'이번달 랭킹');assert.equal(h.w.qa('recordTab'),'time-hard');
});
