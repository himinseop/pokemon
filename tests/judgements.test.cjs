const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function harness(){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 w.localStorage.setItem('pokemon-play-trainer-name','지우');
 let now=0,id=0;const timers=new Map();
 w.fetch=async url=>({ok:true,json:async()=>url.startsWith('/api/rankings')?{mode:new URL(url,'http://localhost').searchParams.get('mode'),entries:[],serverTime:'2026-10-07T00:00:00Z'}:JSON.parse(fs.readFileSync(path.join(root,url),'utf8'))});
 Object.defineProperty(w.performance,'now',{value:()=>now});
 w.setTimeout=(fn,delay)=>{timers.set(++id,{fn,delay});return id;};w.clearTimeout=id=>timers.delete(id);
 w.setInterval=()=>++id;w.clearInterval=()=>{};
 w.Image=function(width,height){const image=w.document.createElement('img');if(width)image.width=width;if(height)image.height=height;
  Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:240});image.decode=async()=>{};return image;};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8')+';window.qa=code=>eval(code);');await flush();
 const $=selector=>w.document.querySelector(selector),game=()=>w.qa('game');
 const start=async(mode='time',difficulty='easy')=>{w.qa(`mode='${mode}';difficulty='${difficulty}';startGame()`);await flush();assert.equal(game().status,'playing');};
 const run=async delay=>{const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,`timer ${delay}`);timers.delete(entry[0]);entry[1].fn();await flush();};
 const correct=()=>game().mode==='time'?$(`[data-answer="${game().question.id}"]`).click():submit(game().question.name);
 const submit=value=>{$('#answer-input').value=value;$('#answer-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 return {w,$,game,start,run,correct,submit,timers,clock:value=>now=value,close:()=>dom.window.close()};
}

test('all five judgement assets are alpha-channel PNGs',()=>{
 for(const word of ['good','great','perfect','awesome','fail']){
  const png=fs.readFileSync(path.join(root,'assets/judgements',word+'.png'));
  assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));assert.equal(png[25],6);
 }
});

test('each correct answer selects its streak tier, and a miss restarts at GOOD without changing scoring',async t=>{
 const h=await harness();t.after(h.close);await h.start();
 for(const [index,word] of ['good','good','great','great','perfect','perfect','awesome','awesome'].entries()){
  h.correct();const effect=h.$('#judgement-effect');assert.equal(effect.dataset.judgement,word);assert.equal(effect.hidden,false);
  assert.equal(effect.querySelector('img').getAttribute('src'),`assets/judgements/${word}.png`);assert.equal(h.game().streak,index+1);
  await h.run(550);assert.equal(h.$('#judgement-effect').hidden,true);
 }
 assert.equal(h.game().score,1080);assert.equal(h.game().maxStreak,8);
 h.$(`[data-answer="${h.game().options.find(p=>p.id!==h.game().question.id).id}"]`).click();
 assert.equal(h.$('#judgement-effect').dataset.judgement,'fail');assert.equal(h.game().streak,0);assert.equal(h.game().score,1080);
 await h.run(1300);h.correct();assert.equal(h.$('#judgement-effect').dataset.judgement,'good');assert.equal(h.game().score,1180);
});

test('typed retries reset the streak, stay on the same question, and replay FAIL; skipping also resets',async t=>{
 const h=await harness();t.after(h.close);await h.start('write');
 for(let i=0;i<3;i++){h.correct();await h.run(550);}
 const question=h.game().question;h.submit('없는포켓몬');const oldImage=h.$('.judgement-image');
 assert.equal(h.game().streak,0);assert.equal(h.game().score,300);assert.equal(h.game().total,3);assert.equal(h.game().locked,false);
 assert.equal(h.game().question,question);assert.equal(h.$('#judgement-effect').dataset.judgement,'fail');
 assert.equal(h.$('#feedback').textContent,'괜찮아! 한 번 더 맞혀봐.');
 h.submit('없는포켓몬');assert.notEqual(h.$('.judgement-image'),oldImage);assert.equal([...h.timers.values()].filter(x=>x.delay===500).length,1);
 h.correct();assert.equal(h.$('#judgement-effect').dataset.judgement,'good');assert.equal(h.game().streak,1);await h.run(550);
 h.$('#skip-question').click();assert.equal(h.$('#judgement-effect').dataset.judgement,'fail');assert.equal(h.game().streak,0);
});

test('keyboard answers work; duplicate submissions are ignored and deadline/quit/restart remove effects',async t=>{
 const h=await harness();t.after(h.close);await h.start('time','hard');
 const choice=h.game().options.findIndex(p=>p.id===h.game().question.id)+1;
 h.w.document.body.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:String(choice),bubbles:true}));
 assert.equal(h.game().streak,1);assert.equal(h.$('#judgement-effect').hidden,false);
 const image=h.$('.judgement-image');h.w.qa('submitAnswer(game.question.id)');
 assert.equal(h.game().total,1);assert.equal(h.$('.judgement-image'),image);
 await h.run(500);assert.equal(h.$('#judgement-effect').hidden,true);await h.run(550);h.correct();
 h.$('#quit-game').click();await flush();assert.equal(h.$('#judgement-effect'),null);assert.equal(h.timers.size,0);
 h.$('#high-score').close();await h.start();assert.equal(h.game().streak,0);assert.equal(h.$('#judgement-effect').hidden,true);
 h.clock(h.game().deadline);h.correct();assert.equal(h.game().total,0);assert.equal(h.game().status,'ended');assert.equal(h.$('#judgement-effect'),null);
});

test('broken judgement images fall back to readable text, and leaving clears the pending effect',async t=>{
 const h=await harness();t.after(h.close);await h.start();h.correct();
 h.$('.judgement-image').dispatchEvent(new h.w.Event('error'));
 assert.equal(h.$('.judgement-image').hidden,true);assert.equal(h.$('.judgement-fallback').hidden,false);assert.equal(h.$('.judgement-fallback').textContent,'GOOD');
 h.w.qa("navigate('dex')");h.$('#leave-game').click();
 assert.equal(h.game(),null);assert.equal(h.$('#judgement-effect'),null);assert.equal(h.timers.size,0);
});

test('each new question clears the last selection and preserves the timer bar',async t=>{
 const h=await harness();t.after(h.close);await h.start();const progress=h.$('.progress'),deadline=h.game().deadline;
 const chosen=h.$(`[data-answer="${h.game().question.id}"]`);chosen.focus();h.correct();assert.equal(chosen.getAttribute('aria-pressed'),'true');assert.ok(chosen.classList.contains('correct'));
 await h.run(550);assert.equal(h.game().selectedAnswer,null);assert.equal(h.game().deadline,deadline);assert.equal(h.$('.progress'),progress);
 for(const button of h.w.document.querySelectorAll('.choice')){assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(button.classList.contains('correct'),false);assert.equal(button.classList.contains('wrong'),false);assert.equal(button.disabled,false);assert.equal(button.matches(':focus'),false);}
 h.$(`[data-answer="${h.game().options.find(p=>p.id!==h.game().question.id).id}"]`).click();await h.run(1300);assert.equal(h.game().selectedAnswer,null);assert.equal(h.$('.wrong,.correct'),null);
});

test('master questions keep the same focused input across answers and skips',async t=>{
 const h=await harness();t.after(h.close);await h.start('write');const input=h.$('#answer-input'),form=h.$('#answer-form');let blurs=0;input.addEventListener('blur',()=>blurs++);
 h.correct();assert.equal(input.disabled,false);assert.equal(input.readOnly,false);await h.run(550);assert.equal(h.$('#answer-input'),input);assert.equal(h.$('#answer-form'),form);assert.equal(h.w.document.activeElement,input);assert.equal(input.value,'');assert.equal(blurs,0);
 h.$('#skip-question').click();await h.run(1300);assert.equal(h.$('#answer-input'),input);assert.equal(h.w.document.activeElement,input);assert.equal(blurs,0);
});
test('master keyboard follows the visual viewport and restores the input on dismissal',async t=>{
 const h=await harness();t.after(h.close);Object.defineProperty(h.w,'innerWidth',{value:375});Object.defineProperty(h.w,'innerHeight',{value:667});
 const viewport=new h.w.EventTarget();Object.assign(viewport,{height:667,offsetTop:0,scale:1});Object.defineProperty(h.w,'visualViewport',{value:viewport});await h.start('write');
 viewport.height=590;h.w.qa('fitLayersToViewport()');assert.equal(h.w.document.body.classList.contains('master-keyboard'),false);
 viewport.height=333;h.w.qa('fitLayersToViewport()');assert.equal(h.w.document.body.classList.contains('master-keyboard'),true);assert.equal(h.w.document.documentElement.style.getPropertyValue('--master-visible-height'),'333px');assert.ok(h.$('.question-score'));assert.ok(h.$('#skip-question'));
 viewport.height=667;h.w.qa('fitLayersToViewport()');assert.equal(h.w.document.body.classList.contains('master-keyboard'),false);assert.ok(h.$('#answer-input'));
 viewport.height=333;viewport.scale=2;h.w.qa('fitLayersToViewport()');assert.equal(h.w.document.body.classList.contains('master-keyboard'),false);
});

test('master syllable boxes preserve Korean composition and ignore premature submit',async t=>{
 const h=await harness();t.after(h.close);await h.start('write');const input=h.$('#answer-input'),length=Array.from(h.game().question.name.normalize('NFKC').replace(/\s+/g,'')).length;
 assert.equal(h.w.document.querySelectorAll('.answer-slot').length,length);assert.equal([...h.w.document.querySelectorAll('.answer-slot')].map(cell=>cell.textContent).join(''),'');
 input.dispatchEvent(new h.w.CompositionEvent('compositionstart',{bubbles:true}));input.value='ㅍ';input.dispatchEvent(new h.w.InputEvent('input',{bubbles:true,isComposing:true}));h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.game().total,0);assert.equal(input.value,'ㅍ');
 input.value=h.game().question.name;input.dispatchEvent(new h.w.InputEvent('input',{bubbles:true,isComposing:true}));input.dispatchEvent(new h.w.CompositionEvent('compositionend',{bubbles:true}));
 assert.equal([...h.w.document.querySelectorAll('.answer-slot')].map(cell=>cell.textContent).join(''),input.value);h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.game().correct,1);await h.run(550);assert.equal(h.$('#answer-input'),input);assert.equal(h.w.document.activeElement,input);assert.equal([...h.w.document.querySelectorAll('.answer-slot')].map(cell=>cell.textContent).join(''),'');
});
test('syllable boxes accept spaced paste and show deletion without exposing answer letters',async t=>{
 const h=await harness();t.after(h.close);await h.start('write');const input=h.$('#answer-input'),answer=h.game().question.name;
 input.value=Array.from(answer).join(' ');input.dispatchEvent(new h.w.InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));assert.equal([...h.w.document.querySelectorAll('.answer-slot')].map(cell=>cell.textContent).join(''),answer);assert.ok(input.value.includes(' ')||answer.length===1);
 input.value='';input.dispatchEvent(new h.w.InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));assert.equal([...h.w.document.querySelectorAll('.answer-slot')].map(cell=>cell.textContent).join(''),'');
 input.value=answer;input.dispatchEvent(new h.w.InputEvent('input',{bubbles:true}));h.$('#answer-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.game().correct,1);
});
