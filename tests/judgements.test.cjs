const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../dist');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function harness(){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 let now=0,id=0;const timers=new Map();
 w.fetch=async url=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,url),'utf8'))});
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
 assert.equal(h.$('#feedback').textContent,'다시 도전해 보세요!');
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
 h.$('#quit-game').click();assert.equal(h.$('#judgement-effect'),null);assert.equal(h.timers.size,0);
 await h.start();assert.equal(h.game().streak,0);assert.equal(h.$('#judgement-effect').hidden,true);
 h.clock(h.game().deadline);h.correct();assert.equal(h.game().total,0);assert.equal(h.game().status,'ended');assert.equal(h.$('#judgement-effect'),null);
});

test('broken judgement images fall back to readable text, and leaving clears the pending effect',async t=>{
 const h=await harness();t.after(h.close);await h.start();h.correct();
 h.$('.judgement-image').dispatchEvent(new h.w.Event('error'));
 assert.equal(h.$('.judgement-image').hidden,true);assert.equal(h.$('.judgement-fallback').hidden,false);assert.equal(h.$('.judgement-fallback').textContent,'GOOD');
 h.w.qa("navigate('dex')");h.$('#leave-game').click();
 assert.equal(h.game(),null);assert.equal(h.$('#judgement-effect'),null);assert.equal(h.timers.size,0);
});
