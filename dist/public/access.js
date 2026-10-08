'use strict';
(()=>{
 const KEY='pokemon-party-device-key',TRAINER='pokemon-play-trainer-name',CHECK='pokemon-party-last-verification',WINDOW=8*60*60*1000;
 let config=null,currentKey='',valid=false,refreshTimer=null,requestBusy=false,memoryReceipt=null;
 const readKey=()=>{try{return localStorage.getItem(KEY)||'';}catch{return '';}};
 const saveKey=key=>{try{localStorage.setItem(KEY,key);}catch{throw Error('초대장을 저장하지 못했어. 브라우저의 저장 공간을 확인해 줘.');}currentKey=key;};
 const clearCheck=()=>{memoryReceipt=null;try{localStorage.removeItem(CHECK);}catch{}};
 const clearKey=()=>{try{localStorage.removeItem(KEY);}catch{}clearCheck();currentKey='';valid=false;};
 const trainer=()=>{try{return localStorage.getItem(TRAINER)||'';}catch{return '';}};
 function lastCheck(){let receipt=memoryReceipt;try{receipt=JSON.parse(localStorage.getItem(CHECK)||'null')||receipt;}catch{}return receipt?.deviceKey===currentKey&&Number.isFinite(receipt.checkedAt)?receipt.checkedAt:0;}
 function checkedRecently(){const elapsed=Date.now()-lastCheck();return !!currentKey&&lastCheck()>0&&elapsed>=0&&elapsed<WINDOW;}
 function rememberCheck(){valid=true;memoryReceipt={deviceKey:currentKey,checkedAt:Date.now()};try{localStorage.setItem(CHECK,JSON.stringify(memoryReceipt));}catch{}}
 function scheduleRefresh(delay){clearTimeout(refreshTimer);refreshTimer=config?.enabled&&valid?setTimeout(refresh,delay??Math.max(1,lastCheck()+WINDOW-Date.now())):null;}
 function invitation(message='친구에게 받은 초대 링크로 들어와 줘.',retry=false){
  clearTimeout(refreshTimer);refreshTimer=null;window.dispatchEvent(new Event('pokemon-access-revoked'));
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());document.head.querySelectorAll('[data-game-head]').forEach(element=>element.remove());document.title='포켓몬 파티 초대장';
  document.body.className='access-gate';delete document.body.dataset.gameMode;
  document.body.innerHTML='<main class="invitation"><img src="/public/envelope.svg" class="envelope" width="140" height="140" alt="편지봉투"><h1>파티 초대장이 필요합니다</h1><p id="gate-message" role="status"></p><button class="gate-button" id="gate-retry" hidden>다시 확인하기</button></main>';
  document.querySelector('#gate-message').textContent=message;const button=document.querySelector('#gate-retry');button.hidden=!retry;button.onclick=begin;
 }
 async function request(path,data){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:controller.signal});const body=await response.json();if(!response.ok){const error=Error(body.error||'초대장을 확인하지 못했어.');error.invalid=body.reason==='invalid_device';error.invite=body.reason==='invalid_invite';throw error;}return body;}
  catch(error){if(error.name==='AbortError')throw Error('초대장 확인이 조금 늦어지고 있어. 다시 확인해 볼까?');throw error;}
  finally{clearTimeout(timeout);}
 }
 async function validate(recordVisit=false){
  const data=await request('/api/access/validate',{deviceKey:currentKey,trainerName:trainer(),recordVisit});if(data.valid!==true)throw Error('초대장을 다시 확인해 줘.');rememberCheck();return data;
 }
 function recordVisit(){const key=currentKey;if(!key)return;request('/api/access/profile',{deviceKey:key,trainerName:trainer(),recordVisit:true}).catch(error=>{if(error.invalid&&currentKey===key)window.PokemonAccess.revoked();});}
 async function loadGame(){
  const response=await fetch('/game.html',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('포켓몬 친구들을 만나지 못했어. 다시 확인해 볼까?');
  const documentTemplate=new DOMParser().parseFromString(await response.text(),'text/html');
  const script=documentTemplate.querySelector('script[src]'),stylesheet=documentTemplate.querySelector('link[rel="stylesheet"]');if(!script||!stylesheet)throw Error('게임을 준비하지 못했어.');
  document.title=documentTemplate.title;
  documentTemplate.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"],link[rel="manifest"],meta[name="theme-color"]').forEach(element=>{const copy=element.cloneNode(true);copy.dataset.gameHead='true';if(copy.tagName==='LINK'&&copy.rel==='manifest')copy.crossOrigin='use-credentials';document.head.appendChild(copy);});
  const style=document.createElement('link');style.dataset.gameHead='true';style.rel='stylesheet';style.href=stylesheet.getAttribute('href');await new Promise((resolve,reject)=>{style.onload=resolve;style.onerror=()=>reject(Error('게임 화면을 가져오지 못했어.'));document.head.appendChild(style);});
  document.body.className=documentTemplate.body.className;document.body.innerHTML=documentTemplate.body.innerHTML;
  const app=document.createElement('script');app.dataset.gameHead='true';app.src=script.getAttribute('src');await new Promise((resolve,reject)=>{app.onload=resolve;app.onerror=()=>reject(Error('게임을 불러오지 못했어. 다시 확인해 볼까?'));document.head.appendChild(app);});
  scheduleRefresh();
 }
 async function refresh(){if(requestBusy||!config?.enabled||!valid||!currentKey||checkedRecently())return;requestBusy=true;try{await validate(false);scheduleRefresh();}catch(error){if(error.invalid){clearKey();invitation();}else scheduleRefresh(60000);}finally{requestBusy=false;}}
 async function begin(){
  if(requestBusy)return;requestBusy=true;try{
   currentKey=readKey();const share=location.pathname.match(/^\/([A-Za-z0-9_-]{43})\/?$/)?.[1];
   if(checkedRecently()){
    config={enabled:true};valid=true;if(share){location.replace('/');return;}
    const title=document.querySelector('#gate-title');if(title)title.textContent='포켓몬 친구들을 만나고 있어요';
    try{await loadGame();recordVisit();return;}catch{clearCheck();document.head.querySelectorAll('[data-game-head]').forEach(element=>element.remove());}
   }
   config=await request('/api/access/config');
   if(currentKey){try{await validate(!share);}catch(error){if(error.invalid){clearKey();invitation();return;}throw error;}if(share){location.replace('/');return;}await loadGame();return;}
   if(share){const result=await request('/api/access/claim',{shareKey:share,trainerName:trainer()});if(!result.deviceKey||result.valid!==true)throw Error('초대장을 다시 확인해 줘.');saveKey(result.deviceKey);rememberCheck();location.replace('/');return;}
   if(!config.enabled){await loadGame();return;}invitation();
  }catch(error){if(error.invalid)clearKey();invitation(error.message||'초대장을 확인하지 못했어. 다시 해볼까?',!error.invalid&&!error.invite);}
  finally{requestBusy=false;}
 }
 window.PokemonAccess={get required(){return !!config?.enabled;},get valid(){return valid;},headers:()=>currentKey?{'x-device-key':currentKey}:{},revoked(){clearKey();request('/api/access/logout',{}).catch(()=>{});invitation();},async reportTrainer(){if(!currentKey)return;try{await request('/api/access/profile',{deviceKey:currentKey,trainerName:trainer()});}catch(error){if(error.invalid)this.revoked();}}};
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
 document.addEventListener('click',event=>event.target.closest('button')?.blur());
 begin();
})();
