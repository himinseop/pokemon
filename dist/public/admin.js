'use strict';
(()=>{
 const TOKEN_KEY='pokemon-party-admin-session',STATE_KEY='pokemon-party-admin-login';let config=null,tokens=null,tab='devices',cursor=null,back=[];
 const content=document.querySelector('#admin-content'),status=document.querySelector('#admin-status');
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(typeof value==='number'?value*1000:value));
 const showStatus=(message='',error=false)=>{status.textContent=message;status.classList.toggle('error',error);};
 function loginView(message='초대 링크와 접속 기기를 관리하려면 로그인해 주세요.'){
  document.querySelector('#admin-logout').hidden=true;content.innerHTML='<section class="admin-login"><img class="envelope" src="/public/envelope.svg" alt="편지봉투" width="90" height="90"><h2>관리자 로그인</h2><p id="admin-login-note"></p><button class="admin-button primary" id="admin-login">로그인</button></section>';
  document.querySelector('#admin-login-note').textContent=message;document.querySelector('#admin-login').disabled=!config?.admin?.clientId;
 }
 const urlSafe=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 async function login(){
  const verifier=urlSafe(crypto.getRandomValues(new Uint8Array(48))),state=urlSafe(crypto.getRandomValues(new Uint8Array(32))),challenge=urlSafe(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  sessionStorage.setItem(STATE_KEY,JSON.stringify({state,verifier,created:Date.now()}));
  const url=new URL('/oauth2/authorize',config.admin.loginOrigin);url.search=new URLSearchParams({client_id:config.admin.clientId,response_type:'code',scope:'openid email profile',redirect_uri:config.admin.redirectUri,state,code_challenge:challenge,code_challenge_method:'S256'});location.assign(url.href);
 }
 async function tokenRequest(parameters){
  const response=await fetch(new URL('/oauth2/token',config.admin.loginOrigin),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.admin.clientId,...parameters})});const result=await response.json();if(!response.ok||!result.access_token)throw Error('로그인을 확인하지 못했어요. 다시 로그인해 주세요.');
  tokens={access:result.access_token,refresh:result.refresh_token||tokens?.refresh,expires:Date.now()+result.expires_in*1000};sessionStorage.setItem(TOKEN_KEY,JSON.stringify(tokens));
 }
 async function api(path,options={}){
  if(!tokens)throw Error('로그인이 필요합니다.');if(tokens.expires<Date.now()+30000&&tokens.refresh)await tokenRequest({grant_type:'refresh_token',refresh_token:tokens.refresh});
  const response=await fetch(path,{...options,cache:'no-store',headers:{authorization:'Bearer '+tokens.access,...(options.body?{'content-type':'application/json'}:{}),...options.headers}});const data=await response.json();if(!response.ok){if(response.status===401||data.reason==='admin_required'){tokens=null;sessionStorage.removeItem(TOKEN_KEY);loginView();}throw Error(data.error||'요청을 완료하지 못했어요.');}return data;
 }
 function shareRow(row){
  const expired=row.expiresAt*1000<=Date.now(),state=row.status==='revoked'?'revoked':expired?'expired':'active',label=state==='revoked'?'사용 중지':expired?'기간 만료':'사용 가능';
  return `<article class="admin-row"><div class="admin-row-info"><h3>${escape(row.label||'파티 초대 링크')}<span class="admin-badge ${state}">${label}</span></h3><p>만료: ${date(row.expiresAt)} · 발급 기기 ${row.claimCount}대</p><p>생성: ${date(row.createdAt)}</p></div><div class="admin-row-actions"><button class="admin-button" data-copy="${escape(row.url)}" ${state!=='active'?'disabled':''}>링크 복사</button><button class="admin-button danger" data-share-revoke="${row.shareId}" ${state!=='active'?'disabled':''}>사용 중지</button></div></article>`;
 }
 function deviceRow(row){
  const blocked=row.status!=='active';return `<article class="admin-row"><div class="admin-row-info"><h3>${escape(row.trainerName||'이름 입력 전')}<span class="admin-badge ${blocked?'blocked':''}">${blocked?'차단됨':'사용 가능'}</span></h3><p>최근 접속: ${date(row.lastSeenAt)} · ${row.visitCount||0}회</p><p>첫 접속: ${date(row.createdAt)}</p><p>${escape(row.userAgent||'브라우저 정보 없음')}</p></div><div class="admin-row-actions"><button class="admin-button ${blocked?'':'danger'}" data-device-state="${row.deviceId}" data-action="${blocked?'unblock':'block'}">${blocked?'차단 해제':'차단'}</button><button class="admin-button danger" data-device-delete="${row.deviceId}">삭제</button></div></article>`;
 }
 const visitRow=row=>`<article class="admin-row"><div class="admin-row-info"><h3>${escape(row.trainerName||'이름 입력 전')}</h3><p>접속: ${date(row.createdAt)}</p><p>기기 ${escape(row.deviceId.slice(0,8))} · ${escape(row.userAgent||'브라우저 정보 없음')}</p></div></article>`;
 function dashboard(){
  document.querySelector('#admin-logout').hidden=false;content.innerHTML='<section class="admin-card"><h2>파티 초대 링크</h2><p>링크는 만든 뒤 3일 동안 사용할 수 있어요. 발급된 기기 키는 자동 만료 없이 유지됩니다.</p><form id="share-create" class="admin-create"><input id="share-label" aria-label="초대 링크 이름" placeholder="링크 이름 (선택)" maxlength="60"><button class="admin-button primary" type="submit">초대 링크 만들기</button></form><div class="share-output" id="share-output" hidden><p>초대 링크를 복사해서 친구에게 전해 주세요.</p><div class="share-copy"><input id="new-share-url" aria-label="새 초대 링크" readonly><button class="admin-button" id="copy-new-share">복사</button></div></div></section><section class="admin-card"><div class="admin-tabs"><button class="admin-button active" data-admin-tab="devices">접속 기기</button><button class="admin-button" data-admin-tab="visits">접속 기록</button><button class="admin-button" data-admin-tab="shares">초대 링크</button><button class="admin-button" id="admin-refresh">새로고침</button></div><div class="admin-list" id="admin-list"></div><div class="admin-pager"><button class="admin-button" id="admin-prev" hidden>이전</button><button class="admin-button" id="admin-next" hidden>다음</button></div></section>';
  loadList();
 }
 async function loadList(){
  showStatus('기록을 불러오고 있어요.');document.querySelectorAll('[data-admin-tab]').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===tab));
  try{const data=await api('/api/admin/'+tab+(cursor?'?cursor='+encodeURIComponent(cursor):''));const list=document.querySelector('#admin-list');if(!list)return;list.innerHTML=data.items.length?data.items.map(tab==='shares'?shareRow:tab==='devices'?deviceRow:visitRow).join(''):'<p class="admin-empty">아직 기록이 없어요.</p>';document.querySelector('#admin-prev').hidden=!back.length;const next=document.querySelector('#admin-next');next.hidden=!data.nextCursor;next.dataset.cursor=data.nextCursor||'';showStatus();}catch(error){showStatus(error.message,true);}
 }
 async function copy(text){try{await navigator.clipboard.writeText(text);showStatus('초대 링크를 복사했어요.');}catch{showStatus('링크를 선택해서 복사해 주세요.');const field=document.querySelector('#new-share-url');if(field){field.value=text;document.querySelector('#share-output').hidden=false;field.focus();field.select();}}}
 async function mutation(path,method,body){showStatus('변경하고 있어요.');try{await api(path,{method,body:body?JSON.stringify(body):undefined});await loadList();}catch(error){showStatus(error.message,true);}}
 document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;b.blur();
  if(b.id==='admin-login'){login().catch(error=>showStatus(error.message,true));return;}
  if(b.id==='admin-logout'){tokens=null;sessionStorage.removeItem(TOKEN_KEY);const url=new URL('/logout',config.admin.loginOrigin);url.search=new URLSearchParams({client_id:config.admin.clientId,logout_uri:config.admin.redirectUri});location.assign(url.href);return;}
  if(b.dataset.adminTab){tab=b.dataset.adminTab;cursor=null;back=[];loadList();return;}if(b.id==='admin-refresh'){loadList();return;}
  if(b.id==='admin-next'){back.push(cursor);cursor=b.dataset.cursor;loadList();return;}if(b.id==='admin-prev'){cursor=back.pop();loadList();return;}
  if(b.id==='copy-new-share'){copy(document.querySelector('#new-share-url').value);return;}if(b.dataset.copy){copy(b.dataset.copy);return;}
  if(b.dataset.deviceState){mutation('/api/admin/devices/'+b.dataset.deviceState,'PATCH',{action:b.dataset.action});return;}
  if(b.dataset.deviceDelete&&confirm('이 기기의 초대장을 삭제할까요? 다시 접속하려면 초대 링크가 필요합니다.')){mutation('/api/admin/devices/'+b.dataset.deviceDelete,'DELETE');return;}
  if(b.dataset.shareRevoke&&confirm('이 링크의 사용을 중지할까요? 이미 발급된 기기 키는 계속 사용할 수 있습니다.'))mutation('/api/admin/shares/'+b.dataset.shareRevoke,'PATCH',{action:'revoke'});
 });
 document.addEventListener('focusin',event=>{if(event.target.matches('button'))event.target.blur();});
 document.addEventListener('submit',async event=>{if(event.target.id!=='share-create')return;event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;showStatus('초대 링크를 만들고 있어요.');try{const result=await api('/api/admin/shares',{method:'POST',body:JSON.stringify({label:document.querySelector('#share-label').value})});document.querySelector('#share-output').hidden=false;document.querySelector('#new-share-url').value=result.share.url;tab='shares';cursor=null;back=[];await loadList();}catch(error){showStatus(error.message,true);}finally{button.disabled=false;}});
 (async()=>{try{const response=await fetch('/api/access/config',{cache:'no-store'});if(!response.ok)throw Error('관리자 설정을 확인하지 못했어요.');config=await response.json();const params=new URLSearchParams(location.search),code=params.get('code');
   if(code){const pending=JSON.parse(sessionStorage.getItem(STATE_KEY)||'null');sessionStorage.removeItem(STATE_KEY);history.replaceState(null,'','/admin');if(!pending||pending.state!==params.get('state')||Date.now()-pending.created>600000)throw Error('로그인 요청을 확인하지 못했어요. 다시 로그인해 주세요.');await tokenRequest({grant_type:'authorization_code',code,redirect_uri:config.admin.redirectUri,code_verifier:pending.verifier});}
   else{try{tokens=JSON.parse(sessionStorage.getItem(TOKEN_KEY)||'null');}catch{tokens=null;}}
   if(tokens){dashboard();}else{loginView(config.admin.clientId?undefined:'관리자 로그인을 준비하고 있어요.');showStatus();}
  }catch(error){loginView(error.message);showStatus(error.message,true);}})();
})();
