'use strict';
const app=document.querySelector('#app');
const difficulties={easy:{label:'쉬움',multiplier:1},normal:{label:'보통',multiplier:2},hard:{label:'어려움',multiplier:3}};
const familiar=[1,2,3,4,5,6,7,8,9,12,16,25,26,35,37,39,52,54,58,63,66,74,79,92,94,95,104,113,129,130,131,132,133,134,135,136,143,144,145,146,149,150,151];
let pokemon=[],pokedexManifest=null,view='play',mode='time',difficulty='easy',game=null,ticker=null,advance=null,judgementTimer=null,recordTab='time-easy',search='',typeFilter='',sort='number',regionFilter='',regionGroups=[];
const judgementAssets={good:'assets/judgements/good.png',great:'assets/judgements/great.png',perfect:'assets/judgements/perfect.png',awesome:'assets/judgements/awesome.png',fail:'assets/judgements/fail.png'};
const judgementPreloads=Object.values(judgementAssets).map(src=>{const image=new Image();image.src=src;return image;});
function judgementFor(correct,streak){return !correct?'fail':streak>=7?'awesome':streak>=5?'perfect':streak>=3?'great':'good';}
function clearJudgement(){clearTimeout(judgementTimer);judgementTimer=null;const effect=document.querySelector('#judgement-effect');if(effect){effect.hidden=true;effect.replaceChildren();}}
function showJudgement(correct){
 clearJudgement();const effect=document.querySelector('#judgement-effect');if(!effect)return;
 const key=judgementFor(correct,game.streak),image=document.createElement('img'),fallback=document.createElement('span');
 effect.dataset.judgement=key;image.className='judgement-image';image.alt='';image.src=judgementAssets[key];image.draggable=false;
 fallback.className='judgement-fallback';fallback.textContent=key.toUpperCase();fallback.hidden=true;
 image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;},{once:true});
 effect.replaceChildren(image,fallback);effect.hidden=false;
 judgementTimer=setTimeout(()=>{effect.hidden=true;effect.replaceChildren();judgementTimer=null;},500);
}
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle=xs=>{const a=[...xs];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const normalize=s=>s.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko');
const RANKING_LIMIT=20;
const recordDate=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
const rankBadge=rank=>rank<=3?`<span class="rank-medal" role="img" aria-label="${rank}등">${['🥇','🥈','🥉'][rank-1]}</span>`:String(rank);
const rankPosition=rank=>rank<=3?rankBadge(rank):rank+'위';
const rankingDate=date=>recordDate.format(new Date(date)).replace(/\s/g,'').replace(/\.$/,'');
const rankingModes=['time-easy','time','time-hard','easy','normal','hard'];
let records=[],lastSavedId=null;
function compareRecords(a,b){return b.score-a.score||b.correct-a.correct||a.date.localeCompare(b.date)||(a.id<b.id?-1:a.id>b.id?1:0);}
function leaderboard(key,items=records){return items.filter(r=>r.mode===key).sort(compareRecords).slice(0,RANKING_LIMIT);}
function rankOf(record,items=records){return leaderboard(record.mode,[...items,record]).indexOf(record)+1;}
function rankingLabel(key){return key==='time'||key.startsWith('time-')?`타임어택 · ${difficulties[key==='time'?'normal':key.slice(5)].label}`:`마스터 · ${difficulties[key].label}`;}
function rankingKey(g){return g.mode==='time'?(g.difficulty==='normal'?'time':`time-${g.difficulty}`):g.difficulty;}
try{lastSavedId=localStorage.getItem('pokemon-play-last-shared-id');}catch{}
const rankingStates=new Map(),rankingRequests=new Map();
const rankingMode=key=>key==='time'||key.startsWith('time-')?'time':'write';
const rankingDifficulty=key=>key==='time'?'normal':key.startsWith('time-')?key.slice(5):key;
const rankingBoard=(kind,level)=>kind==='time'?(level==='normal'?'time':`time-${level}`):level;
function sharedEntries(key,rows){
 if(!Array.isArray(rows)||rows.length>RANKING_LIMIT||!rows.every(r=>r&&typeof r.id==='string'&&typeof r.name==='string'&&r.name.length<=24&&r.mode===key&&Number.isInteger(r.score)&&r.score>0&&Number.isInteger(r.correct)&&r.correct>0&&Number.isInteger(r.total)&&r.total>=r.correct&&typeof r.date==='string'&&Number.isFinite(Date.parse(r.date))))throw Error('랭킹 데이터를 읽지 못했어요. 다시 시도해 주세요.');
 if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('랭킹 데이터를 읽지 못했어요.');
 return rows;
}
async function rankingRequest(url,options={}){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
 try{const result=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});const data=await result.json();if(!result.ok)throw Error(typeof data.error==='string'?data.error:'랭킹 서버에 연결하지 못했어요. 다시 시도해 주세요.');return data;}
 catch(error){if(error.name==='AbortError')throw Error('랭킹 서버의 응답이 늦어지고 있어요. 다시 시도해 주세요.');if(error instanceof TypeError)throw Error('랭킹 서버에 연결하지 못했어요. 다시 시도해 주세요.');throw error;}
 finally{clearTimeout(timeout);}
}
function updateBoard(key,entries,serverTime){
 records=[...records.filter(r=>r.mode!==key),...sharedEntries(key,entries)];
 const state={status:'ready',updated:Date.now(),serverTime};rankingStates.set(key,state);return state;
}
function loadRankings(key,force=false){
 if(rankingRequests.has(key))return rankingRequests.get(key);
 const state=rankingStates.get(key);
 if(!force&&state?.status==='ready'&&Date.now()-state.updated<15000)return Promise.resolve(state);
 rankingStates.set(key,{status:'loading'});
 const request=rankingRequest(`/api/rankings?mode=${encodeURIComponent(key)}`).then(data=>{if(data.mode!==key)throw Error('다른 난이도의 기록을 받았어요. 다시 시도해 주세요.');return updateBoard(key,data.entries,data.serverTime);}).catch(error=>{rankingStates.set(key,{status:'error',message:error.message});throw error;}).finally(()=>{rankingRequests.delete(key);if(view==='records'&&recordTab===key)renderRecords();});
 rankingRequests.set(key,request);return request;
}
async function prepareRanking(g){
 if(game!==g||g.status!=='ended'||!g.completed||g.imageError||g.score<=0||g.rankLoading)return;
 g.rankLoading=true;g.rankingError=false;renderGameBody();
 try{const state=await loadRankings(g.record.mode,true);if(game!==g||g.status!=='ended')return;if(Number.isFinite(Date.parse(state.serverTime)))g.record.date=state.serverTime;g.rank=rankOf(g.record);g.rankLoading=false;renderGameBody();if(g.rank)showRankingEntry();}
 catch{if(game!==g||g.status!=='ended')return;g.rankLoading=false;g.rankingError=true;renderGameBody();}
}
const number=p=>String(p.id).padStart(4,'0');
const typeMeta={"노말":{"icon":"assets/ui/type-normal.png","color":"#999999"},"불꽃":{"icon":"assets/ui/type-fire.png","color":"#ff612c"},"물":{"icon":"assets/ui/type-water.png","color":"#2992ff"},"전기":{"icon":"assets/ui/type-electric.png","color":"#ffdb00"},"풀":{"icon":"assets/ui/type-grass.png","color":"#42bf24"},"얼음":{"icon":"assets/ui/type-ice.png","color":"#42d8ff"},"격투":{"icon":"assets/ui/type-fighting.png","color":"#ffa202"},"독":{"icon":"assets/ui/type-poison.png","color":"#994dcf"},"땅":{"icon":"assets/ui/type-ground.png","color":"#ab7939"},"비행":{"icon":"assets/ui/type-flying.png","color":"#95c9ff"},"에스퍼":{"icon":"assets/ui/type-psychic.png","color":"#ff637f"},"벌레":{"icon":"assets/ui/type-bug.png","color":"#9fa424"},"바위":{"icon":"assets/ui/type-rock.png","color":"#bcb889"},"고스트":{"icon":"assets/ui/type-ghost.png","color":"#6e4570"},"드래곤":{"icon":"assets/ui/type-dragon.png","color":"#5462d6"},"악":{"icon":"assets/ui/type-dark.png","color":"#4f4747"},"강철":{"icon":"assets/ui/type-steel.png","color":"#6aaed3"},"페어리":{"icon":"assets/ui/type-fairy.png","color":"#ffb1ff"}};
const badges=p=>p.types.map(t=>`<span class="type" data-type="${t}" style="--type-color:${typeMeta[t]?.color||'#777'}">${typeMeta[t]?`<img class="type-icon" src="${typeMeta[t].icon}" alt="" width="20" height="20">`:''}${escapeHTML(t)}</span>`).join('');
const genderIcons=p=>(p.genders||[]).map(g=>g==='수컷'||g==='암컷'?`<img class="gender-icon" src="${g==='수컷'?'assets/ui/gender-male.png':'assets/ui/gender-female.png'}" alt="${g}" width="26" height="26">`:escapeHTML(g)).join('');
const activeGame=()=>game&&['loading','playing'].includes(game.status);
let previewPokemon=null,previewChoices=null;

const card=p=>`<button class="dex-card" data-pokemon="${p.id}" aria-label="${p.name} 도감 보기"><span class="number">No. ${number(p)}</span><img src="${p.image}" alt="${p.name}" loading="lazy" width="140" height="130"><strong>${p.name}</strong><div>${badges(p)}</div></button>`;
const highest=key=>Math.max(0,...records.filter(r=>r.mode===key).map(r=>r.score));
function cleanup(){clearInterval(ticker);clearTimeout(advance);clearJudgement();ticker=null;advance=null;}
let leaveAction=null;
function confirmLeave(action){detailRequest++;const dialog=document.querySelector('#detail');leaveAction=action;dialog.classList.remove('dex-detail');dialog.removeAttribute('aria-labelledby');dialog.innerHTML='<div class="detail-inner"><h2 style="font-size:22px">진행 중인 게임을 끝낼까요?</h2><p>이동하면 이번 게임의 기록은 저장되지 않아요.</p><div class="result-actions"><button class="secondary" id="keep-playing">계속 플레이</button><button class="primary" id="leave-game">게임 끝내고 이동</button></div></div>';dialog.showModal();}
function navigate(next){if(activeGame()){confirmLeave(()=>{cleanup();game=null;view=next;render();});return;}cleanup();game=null;view=next;render();}
function updateNav(){document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.nav===view));}
function render(){updateGameFocus();updateNav();if(view==='play')renderPlay();else if(view==='dex')renderDex();else renderRecords();}
function renderPlay(){
previewChoices={easy:shuffle(pokemon.filter(p=>familiar.includes(p.id)))[0],normal:shuffle(pokemon)[0],hard:shuffle(pokemon)[0]};previewPokemon=previewChoices[difficulty];
app.innerHTML=`<section class="intro"><div><h1>이 포켓몬, 누구일까요?</h1></div></section>
<div class="play-grid"><section class="game-card" aria-label="포켓몬 퀴즈"><div class="game-tabs"><button class="game-tab ${mode==='time'?'active':''}" data-mode="time">⏱️ 타임어택</button><button class="game-tab ${mode==='write'?'active':''}" data-mode="write">🏆 마스터 도전</button></div><div id="game-body" class="game-body"></div></section></div>
<div class="quick-links"><button class="shortcut shortcut-dex" data-nav="dex"><span class="shortcut-icon" aria-hidden="true">📖</span><span>포켓몬 도감</span></button><button class="shortcut shortcut-ranking" data-nav="records"><span class="shortcut-icon" aria-hidden="true">🏆</span><span>랭킹</span></button></div>`;
renderGameBody();
}
function updateGameFocus(){
 const focused=view==='play'&&!!activeGame(),entering=focused&&!document.body.classList.contains('game-focused');
 document.body.classList.toggle('game-focused',focused);
 if(focused)document.body.dataset.gameMode=game.mode;else delete document.body.dataset.gameMode;
 if(entering)app.scrollIntoView({block:'start'});
}
const gameExit=()=>'<button class="game-exit" id="quit-game" aria-label="게임 그만하기" title="그만하기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>';
function renderGameBody(){updateGameFocus();const body=document.querySelector('#game-body');if(!body)return;
if(game?.status==='ended'){renderResult(body);return;}
if(game?.status==='playing'){renderQuestion(body);return;}
if(game?.status==='loading'){body.innerHTML=`<div class="focus-loading">${gameExit()}<div class="quiz-start-loading" role="status" aria-live="polite"><span class="quiz-spinner" aria-hidden="true"></span><p>첫 문제를 불러오는 중이에요…</p></div></div>`;return;}
body.innerHTML=`<div class="game-setup"><h2>${mode==='time'?'60초 타임어택':'포켓몬 마스터 도전'}</h2>
${mode==='write'?`<div class="difficulty difficulty-cards" aria-label="난이도 선택">${Object.entries(difficulties).map(([key,d])=>`<button data-difficulty="${key}" class="difficulty-choice ${difficulty===key?'active':''}" aria-pressed="${difficulty===key}"><span class="difficulty-preview ${key==='hard'?'silhouette':''}"><img src="${previewChoices[key].image}" alt="${key==='hard'?'포켓몬 실루엣':key==='easy'?'친숙한 포켓몬 미리보기':'전체 포켓몬 미리보기'}" width="100" height="100"></span><strong>${d.label}</strong><small>${d.multiplier}배 점수</small></button>`).join('')}</div>`:`<div class="difficulty difficulty-time" aria-label="타임어택 난이도 선택">${Object.entries(difficulties).map(([key,d])=>`<button data-difficulty="${key}" class="difficulty-choice ${difficulty===key?'active':''}" aria-pressed="${difficulty===key}"><strong>${d.label}</strong><small>${key==='easy'?'친숙한 포켓몬':key==='normal'?'전체 포켓몬':'실루엣'}</small></button>`).join('')}</div>`}
${mode==='time'?`<div class="pokemon-stage setup-stage ${difficulty==='hard'?'silhouette':''}"><img src="${previewPokemon.image}" alt="${difficulty==='hard'?'포켓몬 실루엣':'랜덤 포켓몬 미리보기'}" width="230" height="230"></div>`:''}
<button class="primary setup-start" id="start-game">시작</button><p class="setup-note">${mode==='time'?'60초동안 최대한 많이 맞추기 · 정답 100점 · 연속 정답 보너스':'10문제 · 이름을 입력해요'}</p></div>`;
}
function prepareQuestionImages(g){
 // Keep the exact next questions warm, including the next shuffled deck.
 if(!g.deck.length)g.deck=shuffle(g.pool.filter(p=>p.id!==g.question.id));
 const ahead=g.mode==='write'?Math.min(3,10-g.total-1):3;
 const upcoming=[g.question,...g.deck.slice(-ahead).reverse().slice(0,ahead)];
 const keep=new Set(upcoming.map(p=>p.id));
 for(const id of g.images.keys())if(!keep.has(id))g.images.delete(id);
 upcoming.forEach((p,i)=>prepareQuestionImage(g,p,i===0?'high':'low'));
}
function prepareQuestionImage(g,p,priority){
 const existing=g.images.get(p.id);if(existing){existing.image.fetchPriority=priority;return existing;}
 const image=new Image(190,190),entry={image,ready:false,failed:false};
 image.alt='이름을 맞혀야 하는 포켓몬';image.fetchPriority=priority;
 g.images.set(p.id,entry);
 entry.loaded=new Promise(resolve=>{
  let settled=false;
  const finish=ok=>{if(settled)return;settled=true;entry.ready=ok;entry.failed=!ok;resolve(ok);};
  const loaded=()=>{if(typeof image.decode==='function')image.decode().then(()=>finish(true),()=>finish(image.naturalWidth>0));else finish(true);};
  image.onload=loaded;image.onerror=()=>finish(false);image.src=p.image;
  if(image.complete){if(image.naturalWidth)loaded();else finish(false);}
 });
 return entry;
}
function selectQuestion(g){
 if(!g.deck.length)g.deck=shuffle(g.pool.filter(p=>p.id!==g.question?.id));
 g.question=g.deck.pop();g.locked=false;g.imageReady=false;prepareQuestionImages(g);
 g.options=shuffle([g.question,...shuffle(g.pool.filter(p=>p.id!==g.question.id)).slice(0,3)]);
}
function startGame(){cleanup();const pool=difficulty==='easy'?pokemon.filter(p=>familiar.includes(p.id)):pokemon;
 game={status:'loading',mode,difficulty,pool,deck:shuffle(pool),images:new Map(),question:null,score:0,correct:0,total:0,streak:0,maxStreak:0,history:[],locked:false,saved:false,deadline:0,imageReady:false,imageFailures:0};
 prepareFirstQuestion(game);
}
function prepareFirstQuestion(g){
 if(game!==g||g.status!=='loading')return;selectQuestion(g);renderGameBody();
 const entry=g.images.get(g.question.id);
 const begin=()=>{if(game!==g||g.status!=='loading')return;g.status='playing';g.deadline=g.mode==='time'?performance.now()+60000:null;renderGameBody();if(g.mode==='time')ticker=setInterval(tick,100);};
 const failed=()=>{if(game!==g||g.status!=='loading')return;g.imageFailures++;if(g.imageFailures>=5){g.imageError=true;endGame('error');}else prepareFirstQuestion(g);};
 if(entry.ready)begin();else entry.loaded.then(ok=>ok?begin():failed());
}
function nextQuestion(){if(!game||game.status!=='playing')return;if(game.mode==='write'&&game.total>=10){endGame();return;}if(game.mode==='time'&&performance.now()>=game.deadline){endGame();return;}
 selectQuestion(game);renderGameBody();}
function timerState(g){const duration=60000;const remaining=Math.max(0,g.deadline-performance.now());return {seconds:Math.ceil(remaining/1000),percent:Math.min(100,remaining/duration*100)};}
function renderQuestion(body){clearJudgement();const g=game;const timeState=g.mode==='time'?timerState(g):null;const previousProgress=g.mode==='time'?body.querySelector('.progress'):null;
body.innerHTML=`<div class="pokemon-stage ${g.difficulty==='hard'?'silhouette':''}">${gameExit()}<span id="question-image-slot"></span><span id="judgement-effect" class="judgement-effect" aria-hidden="true" hidden></span></div>
<div class="question-score"><div class="game-stats"><span><strong id="score">${g.score.toLocaleString()}</strong> 점</span><span>${g.mode==='time'?`연속 <b id="streak">${g.streak}</b> 정답`:`${g.total+1} / 10 문제`}</span>${timeState?`<span class="time">⏱ <strong id="time">${timeState.seconds}</strong> 초</span>`:''}</div>${timeState?`<div class="progress" role="progressbar" aria-label="남은 시간" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${timeState.percent}"><div id="timer-bar" style="width:${timeState.percent}%"></div></div>`:''}</div>
${g.mode==='time'?`<div class="choices">${g.options.map((p,i)=>`<button class="choice" data-answer="${p.id}" disabled><span>${i+1}</span>${p.name}</button>`).join('')}</div>`:`<form class="text-form" id="answer-form"><input id="answer-input" autocomplete="off" maxlength="30" placeholder="포켓몬 이름" aria-label="포켓몬 이름" disabled><button class="primary" type="submit" disabled>확인</button></form>`}
<div id="feedback" class="feedback" role="status" aria-live="polite">포켓몬을 불러오는 중…</div>${g.mode==='write'?'<div class="play-actions"><button class="game-control skip-control" id="skip-question"><span aria-hidden="true">?</span>모르겠어요</button></div>':''}`;
// Keep the time-attack bar itself alive when replacing the question.
if(previousProgress){body.querySelector('.progress').replaceWith(previousProgress);previousProgress.querySelector('#timer-bar').style.width=timeState.percent+'%';previousProgress.setAttribute('aria-valuenow',timeState.percent);}
const current=g.question.id,entry=g.images.get(current),img=entry.image;
img.id='question-image';body.querySelector('#question-image-slot').replaceWith(img);
const active=()=>game===g&&g.status==='playing'&&g.question.id===current&&!g.locked&&body.querySelector('#question-image')===img;
const ready=()=>{if(!active())return;g.imageReady=true;body.querySelectorAll('.choice,.text-form input,.text-form button').forEach(b=>b.disabled=false);body.querySelector('#feedback').textContent='';if(g.mode==='write')body.querySelector('#answer-input').focus({preventScroll:true});};
const failed=()=>{if(!active())return;g.imageFailures++;if(g.imageFailures>=5){g.imageError=true;endGame();}else nextQuestion();};
if(entry.ready)ready();else entry.loaded.then(ok=>ok?ready():failed());}
function tick(){if(!game||game.status!=='playing'||game.mode!=='time')return;const state=timerState(game);const time=document.querySelector('#time');if(time)time.textContent=state.seconds;const bar=document.querySelector('#timer-bar');if(bar){bar.style.width=state.percent+'%';bar.parentElement.setAttribute('aria-valuenow',state.percent);}if(state.seconds<=0)endGame();}
function submitAnswer(value,skipped=false){const g=game;if(!g||g.status!=='playing'||g.locked||!g.imageReady)return;if(g.mode==='time'&&performance.now()>=g.deadline){endGame();return;}
const correct=!skipped&&(g.mode==='time'?Number(value)===g.question.id:normalize(value)===normalize(g.question.name));const feedback=document.querySelector('#feedback');
// A wrong typed guess leaves the same question open for another try.
if(g.mode==='write'&&!correct&&!skipped){g.streak=0;showJudgement(false);feedback.className='feedback bad';feedback.textContent='다시 도전해 보세요!';const input=document.querySelector('#answer-input');input.focus({preventScroll:true});input.select();return;}
g.locked=true;g.total++;if(correct){g.correct++;g.streak++;g.maxStreak=Math.max(g.maxStreak,g.streak);g.score+=g.mode==='time'?100+Math.min(g.streak-1,10)*10:100*difficulties[g.difficulty].multiplier;}else g.streak=0;
showJudgement(correct);
const answerRevealed=g.mode==='time'||correct||skipped;g.history.push({pokemon:g.question,correct,answer:String(value),answerRevealed});feedback.className='feedback '+(correct?'good':'bad');feedback.textContent=g.mode==='write'?(correct?'정답이에요! 잘 알고 있네요!':`정답은 ${g.question.name}! 다음 문제에 도전해 보세요!`):(correct?`정답! ${g.question.name}, 잘 알고 있네요!`:`괜찮아요! 정답은 ${g.question.name}`);
if(answerRevealed)document.querySelector('.pokemon-stage')?.classList.add('reveal');document.querySelectorAll('[data-answer]').forEach(b=>{b.disabled=true;if(Number(b.dataset.answer)===g.question.id)b.classList.add('correct');else if(Number(b.dataset.answer)===Number(value))b.classList.add('wrong');});document.querySelectorAll('.text-form input,.text-form button,#skip-question').forEach(b=>b.disabled=true);document.querySelector('#score').textContent=g.score.toLocaleString();const streak=document.querySelector('#streak');if(streak)streak.textContent=g.streak;
advance=setTimeout(nextQuestion,correct?550:1300);}
function endGame(reason='complete'){
 if(!game||game.status==='ended')return;
 cleanup();game.status='ended';game.completed=reason==='complete';
 game.record={id:typeof crypto.randomUUID==='function'?crypto.randomUUID():`${Date.now()}-${Math.random()}`,score:game.score,correct:game.correct,total:game.total,mode:rankingKey(game),date:new Date().toISOString()};
 game.rank=0;
 // Replace an open details/navigation panel with the end-of-game registration.
 leaveAction=null;document.querySelector('#detail').close();
 renderGameBody();if(game.completed&&!game.imageError&&game.score>0)prepareRanking(game);
}
function resultRanking(g){
 if(g.rankLoading)return '<p class="result-note" role="status">공유 랭킹을 확인하고 있어요…</p>';
 if(g.rankingError)return '<p class="result-note" role="status">랭킹을 불러오지 못했어요.</p><button class="secondary" id="retry-ranking">다시 확인하기</button>';
 if(g.imageError)return '<p class="result-note">인터넷 연결을 확인하고 다시 도전해 주세요.</p>';
 if(!g.completed)return '<p class="result-note">끝까지 플레이하면 랭킹에 도전할 수 있어요.</p>';
 if(g.saved)return `<div class="rank-banner saved"><span>🏆</span><div><strong>랭킹 ${rankPosition(g.savedRank)}에 이름을 남겼어요!</strong><p>${escapeHTML(g.record.name)} · ${rankingLabel(g.record.mode)}</p></div></div>`;
 if(g.rank)return `<div class="rank-banner"><span>🏆</span><div><strong>축하해요! 랭킹 ${rankPosition(g.rank)}!</strong><p>${rankingLabel(g.record.mode)} TOP ${RANKING_LIMIT}에 이름을 남겨 보세요.</p></div><button class="secondary" id="enter-ranking">이름 남기기</button></div>`;
 const cutoff=leaderboard(g.record.mode).at(-1);
 return `<p class="result-note">${g.score===0?'다음에는 정답을 맞히고 랭킹에 도전해 보세요!':`이번에는 TOP ${RANKING_LIMIT}에 조금 못 미쳤어요. ${cutoff?`현재 ${RANKING_LIMIT}위는 ${cutoff.score.toLocaleString()}점이에요.`:''}`}</p>`;
}
function renderResult(body){const g=game;const mistakes=g.history.filter(x=>!x.correct&&(g.mode==='time'||x.answerRevealed));body.innerHTML=`<div class="result"><div class="result-icon">${g.imageError?'☁️':g.correct>0?'🏆':'🌱'}</div><h2>${g.imageError?'포켓몬을 불러오지 못했어요':g.correct>=8?'멋진 포켓몬 트레이너!':'즐거운 도전이었어요!'}</h2><div class="big-score">${g.score.toLocaleString()}<small>점</small></div><p class="summary">${g.mode==='time'?'60초 타임어택 · '+difficulties[g.difficulty].label:difficulties[g.difficulty].label+' 마스터 도전'} · ${g.total}문제 중 ${g.correct}개 정답 · 최고 ${g.maxStreak}연속</p>${resultRanking(g)}
${mistakes.length?`<div class="review-list"><strong style="font-size:13px">다음에는 기억할 수 있어요!</strong>${mistakes.map(m=>`<div class="review-row"><img src="${m.pokemon.image}" alt="" width="38" height="38"><strong>${m.pokemon.name}</strong><span>다시 만나기</span><button data-pokemon="${m.pokemon.id}">도감 보기</button></div>`).join('')}</div>`:''}<div class="result-actions"><button class="primary" id="start-game">다시 도전!</button><button class="secondary" data-nav="records">랭킹 보기</button></div></div>`;}
function showRankingEntry(){
 if(!game||game.status!=='ended'||!game.rank)return;
 const g=game,dialog=document.querySelector('#high-score');
 const list=g.saved?leaderboard(g.record.mode):leaderboard(g.record.mode,[...records,g.record]);
 const rank=g.saved?g.savedRank:g.rank;
 dialog.innerHTML=`<div class="arcade-entry leaderboard-entry"><button class="close" id="close-ranking" aria-label="랭킹 닫기">×</button><h2 id="high-score-title">${g.saved?'우리들의 랭킹':'랭킹에 이름을 남겨요!'}</h2><div class="entry-summary"><span>${rankingLabel(g.record.mode)} · TOP ${RANKING_LIMIT}</span><strong>내 순위 ${rankPosition(rank)} <span>· ${g.score.toLocaleString()}점</span></strong></div><form id="save-form"></form><div class="entry-list"><table class="entry-ranking"><thead><tr><th scope="col">순위</th><th scope="col">트레이너</th><th scope="col">점수</th><th scope="col">날짜</th></tr></thead><tbody>${list.map((r,i)=>{const me=r.id===g.record.id;return `<tr class="${me?'my-entry':''}" ${me?'aria-label="내 기록"':''}><td>${rankBadge(i+1)}${me?'<span class="my-tag">나</span>':''}</td><td>${me&&!g.saved?'<div class="entry-input"><input id="trainer-name" form="save-form" aria-label="트레이너 이름" placeholder="트레이너 이름" maxlength="12" autocomplete="off"><button type="submit" form="save-form" class="save-name" aria-label="트레이너 이름 저장" title="저장">✓</button></div>':escapeHTML(r.name)}</td><td class="entry-points">${r.score.toLocaleString()}</td><td class="entry-date"><time datetime="${escapeHTML(r.date)}">${rankingDate(r.date)}</time></td></tr>`;}).join('')}</tbody></table></div><p id="save-message" class="result-note" role="status">${g.saved?'이름을 저장했어요.':''}</p>${g.saved?'<button class="primary" id="ranking-replay">다시 도전!</button>':''}</div>`;
 if(!dialog.open)dialog.showModal();
 const input=dialog.querySelector('#trainer-name');if(input)input.focus({preventScroll:true});
 const ownRow=dialog.querySelector('.my-entry');if(ownRow)ownRow.scrollIntoView({block:'nearest'});
}
async function saveRecord(){
 if(!game||game.status!=='ended'||game.saved||!game.rank||game.saving)return;
 const g=game,input=document.querySelector('#trainer-name'),message=document.querySelector('#save-message'),button=document.querySelector('.save-name');if(!input)return;
 const name=input.value.trim()||pokemon[Math.floor(Math.random()*pokemon.length)].name;if(name.length>12){input.setCustomValidity('이름은 12자까지 적어 주세요.');input.reportValidity();return;}input.setCustomValidity('');input.value=name;
 g.saving=true;input.disabled=true;button.disabled=true;message.textContent='이름을 저장하고 있어요…';
 try{
  const data=await rankingRequest('/api/scores',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:g.record.id,name,mode:g.record.mode,results:g.history.map(answer=>answer.correct)})});
  if(typeof data.qualified!=='boolean')throw Error('저장 결과를 확인하지 못했어요. 다시 눌러 주세요.');
  const entries=sharedEntries(g.record.mode,data.entries);updateBoard(g.record.mode,entries);
  if(game!==g||g.status!=='ended')return;
  if(!data.qualified){g.rank=0;document.querySelector('#high-score').close();renderGameBody();return;}
  const saved=entries.find(row=>row.id===g.record.id);if(!saved||!Number.isInteger(data.rank)||data.rank<1||data.rank>RANKING_LIMIT||entries[data.rank-1]?.id!==saved.id)throw Error('저장된 순위를 확인하지 못했어요. 다시 눌러 주세요.');
  g.record=saved;g.score=saved.score;g.saved=true;g.savedRank=data.rank;lastSavedId=saved.id;recordTab=saved.mode;
  try{localStorage.setItem('pokemon-play-last-shared-id',saved.id);}catch{}
  renderGameBody();showRankingEntry();
 }catch(error){if(game===g&&document.querySelector('#high-score').open)message.textContent=error.message||'랭킹을 저장하지 못했어요. 다시 눌러 주세요.';}
 finally{g.saving=false;input.disabled=false;button.disabled=false;}
}

let coloringRequest=0;
function showColoring(p){
 const dialog=document.querySelector('#coloring');
 dialog.setAttribute('aria-label',`${p.name}${p.form?' '+p.form:''} 색칠 도안`);
 dialog.innerHTML=`<div class="coloring-stage" aria-busy="true"><section class="coloring-sheet"><canvas id="coloring-canvas" width="800" height="800" role="img" aria-label="${escapeHTML(p.name+' '+(p.form||'')+' 색칠 도안')}" hidden></canvas></section><div id="coloring-status" role="status" aria-live="polite"><span class="quiz-spinner" aria-hidden="true"></span><p>도안을 불러오는 중이에요…</p></div></div><div class="coloring-actions"><button class="primary" id="print-coloring" disabled>출력하기</button></div>`;
 if(!dialog.open)dialog.showModal();
 prepareColoring(p);
}
function outlinePixels(rgba,width,height,threshold){
 // Composite transparency onto white, then keep color boundaries rather than filled areas.
 const gray=new Float32Array(width*height),edges=new Uint8Array(width*height),out=new Uint8ClampedArray(rgba.length);
 for(let i=0;i<gray.length;i++){const j=i*4,a=rgba[j+3]/255;gray[i]=(rgba[j]*.299+rgba[j+1]*.587+rgba[j+2]*.114)*a+255*(1-a);}
 for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
  const i=y*width+x,a=gray[i-width-1],b=gray[i-width],c=gray[i-width+1],d=gray[i-1],f=gray[i+1],g=gray[i+width-1],h=gray[i+width],k=gray[i+width+1];
  const gx=-a+c-2*d+2*f-g+k,gy=-a-2*b-c+g+2*h+k;
  if(gx*gx+gy*gy>threshold*threshold)edges[i]=1;
 }
 // Slightly widen outlines so they stay legible on an A4 sheet.
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let black=false;for(let dy=-1;dy<=1&&!black;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&edges[(y+dy)*width+x+dx]){black=true;break;}
  const i=(y*width+x)*4;out[i]=out[i+1]=out[i+2]=black?0:255;out[i+3]=255;
 }
 return out;
}
async function prepareColoring(p){
 const request=++coloringRequest,dialog=document.querySelector('#coloring'),canvas=dialog.querySelector('#coloring-canvas'),button=dialog.querySelector('#print-coloring'),status=dialog.querySelector('#coloring-status'),stage=dialog.querySelector('.coloring-stage');
 try{
  const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=p.image;});if(image.decode)await image.decode();
  if(request!==coloringRequest||!dialog.open)return;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),size=800;
  const scale=720/Math.max(image.naturalWidth,image.naturalHeight),width=image.naturalWidth*scale,height=image.naturalHeight*scale;
  ctx.drawImage(image,(size-width)/2,(size-height)/2,width,height);const pixels=ctx.getImageData(0,0,size,size);pixels.data.set(outlinePixels(pixels.data,size,size,140));ctx.putImageData(pixels,0,0);
  canvas.hidden=false;status.hidden=true;stage.setAttribute('aria-busy','false');button.disabled=false;button.focus({preventScroll:true});
 }catch{if(request!==coloringRequest||!dialog.open)return;stage.setAttribute('aria-busy','false');status.textContent='도안을 불러오지 못했어요. 바깥을 눌러 닫은 뒤 다시 시도해 주세요.';}
}

function regionSelect(){return `<select id="region-filter" aria-label="지방 선택"><option value="">모든 지방</option>${regionGroups.map(g=>`<option value="${escapeHTML(g.name)}" ${regionFilter===g.name?'selected':''}>${escapeHTML(g.name)}</option>`).join('')}</select>`;}
function inRegion(p){return !regionFilter||regionGroups.find(g=>g.name===regionFilter)?.numbers.includes(p.id);}
function renderDex(){app.innerHTML=`<button class="text-button back-to-game" data-nav="play"><span aria-hidden="true">&lt;</span> 퀴즈도전</button><section class="intro"><div><p class="eyebrow">MEET YOUR POKÉMON</p><h1>포켓몬 도감</h1><p>${pokemon.length.toLocaleString()}마리의 이름, 타입과 특징을 알아보세요.</p></div></section><div class="filters"><input id="search" value="${escapeHTML(search)}" placeholder="포켓몬 이름 또는 도감 번호 검색" aria-label="포켓몬 검색">${regionSelect()}<select id="type-filter" aria-label="타입 선택"><option value="">모든 타입</option>${[...new Set(pokemon.flatMap(p=>p.types))].map(t=>`<option ${typeFilter===t?'selected':''}>${t}</option>`).join('')}</select><select id="sort" aria-label="정렬"><option value="number" ${sort==='number'?'selected':''}>도감 번호순</option><option value="name" ${sort==='name'?'selected':''}>이름순</option></select></div><div id="dex-results"></div>`;renderDexResults();}
function renderDexResults(){const q=normalize(search);let list=pokemon.filter(p=>(!q||normalize(p.name).includes(q)||number(p).includes(q)||String(p.id)===q)&&(!typeFilter||p.types.includes(typeFilter))&&inRegion(p));if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name,'ko'));document.querySelector('#dex-results').innerHTML=`<div class="result-count">${list.length}마리의 포켓몬</div>${list.length?`<div class="dex-grid">${list.map(card).join('')}</div>`:'<div class="empty">찾는 포켓몬이 없어요. 다른 이름이나 번호로 찾아보세요.</div>'}`;}
let extraDetails=null,extraDetailsPromise=null,detailRequest=0;
function relatedCard(p,current){return `<button class="related-card ${p.uid===current?'current-form':''}" data-dex-uid="${p.uid}" ${p.uid===current?'aria-current="true"':''} aria-label="${escapeHTML(p.name+' '+(p.form||''))} 도감 보기"><span class="number">No. ${String(p.id).padStart(4,'0')}</span><img src="${p.image}" alt="" width="110" height="100" loading="lazy"><strong>${escapeHTML(p.name)}</strong>${p.form?`<small>${escapeHTML(p.form)}</small>`:''}<div>${badges(p)}</div></button>`;}
function evolutionSection(p){if(!p.evolutions?.length)return '';const stages=[...new Set(p.evolutions.map(e=>e.stage))].sort((a,b)=>a-b);return `<section class="related-section"><h3>진화</h3><div class="evolution-stages ${stages.length===2&&p.evolutions.filter(e=>e.stage===stages[1]).length>3?'branched-evolution':''}" style="--stages:${stages.length}">${stages.map((stage,i)=>`<div class="evolution-stage"><h4>${i===0?'기본':i+'단계 진화'}</h4>${p.evolutions.filter(e=>e.stage===stage).map(e=>relatedCard(e,p.uid)).join('')}</div>`).join('')}</div></section>`;}
function detailTools(p){return `<div class="detail-tools"><button class="detail-tool" id="close-detail" aria-label="도감 닫기" title="닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>${p?`<button class="detail-tool coloring-tool" data-color-pokemon="${p.id}" data-color-uid="${p.uid}" aria-label="색칠하기" title="색칠하기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 1.9-4.1 1.6 1.6 0 0 1 1.2-2.6H18a3 3 0 0 0 3-3c0-5-4-8.3-9-8.3Z"/><circle cx="7.5" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="6.8" r="1" fill="currentColor"/><circle cx="14.2" cy="6.8" r="1" fill="currentColor"/><circle cx="17" cy="10" r="1" fill="currentColor"/></svg></button>`:''}</div>`;}
function detailShell(content,p){return `${detailTools(p)}<div class="detail-scroll"><div class="detail-inner pokemon-detail-card">${content}</div></div>`;}
function renderDexDetail(p){
 const dialog=document.querySelector('#detail');dialog.classList.add('dex-detail');dialog.setAttribute('aria-labelledby','detail-title');dialog.style.setProperty('--card-type',typeMeta[p.types[0]]?.color||'#999999');dialog.dataset.type=p.types[0];
 const descriptions=p.descriptions?.length?p.descriptions:[{version:'',text:p.description}];
 dialog.innerHTML=detailShell(`<div class="pokemon-card-heading"><div><p class="eyebrow">No. ${String(p.id).padStart(4,'0')}</p><h2 id="detail-title">${escapeHTML(p.name)}</h2>${p.form?`<p class="form-label">${escapeHTML(p.form)}</p>`:''}</div><div class="card-type-icons">${p.types.map(t=>`<img src="${typeMeta[t].icon}" alt="${t} 타입" width="32" height="32">`).join('')}</div></div><div class="detail-image"><img class="original-pokemon" src="${p.image}" alt="${escapeHTML(p.name)}"></div><section class="description-section" aria-label="도감 설명"><div class="description-versions">${descriptions.map((d,i)=>d.version?`<button data-description="${i}" class="${i===0?'active':''}" aria-pressed="${i===0}">${escapeHTML(d.version)}</button>`:'').join('')}</div>${descriptions.map((d,i)=>`<p class="dex-description" data-description-text="${i}" ${i?'hidden':''}>${escapeHTML(d.text)}</p>`).join('')}</section><dl class="dex-facts"><div><dt>타입</dt><dd>${badges(p)}</dd></div><div><dt>분류</dt><dd>${escapeHTML(p.category)}</dd></div><div><dt>키</dt><dd>${escapeHTML(p.height)}</dd></div><div><dt>몸무게</dt><dd>${escapeHTML(p.weight)}</dd></div><div><dt>성별</dt><dd>${genderIcons(p)}</dd></div><div><dt>특성</dt><dd>${(p.abilities?.length?p.abilities:[{name:p.ability||'공식 도감 정보 없음'}]).map(a=>a.description?`<div class="ability-detail"><strong>${escapeHTML(a.name)}</strong><p>${escapeHTML(a.description)}</p></div>`:escapeHTML(a.name)).join('')}</dd></div></dl>${evolutionSection(p)}${p.forms?.length>1?`<section class="related-section"><h3>다른 모습</h3><div class="forms-grid">${p.forms.map(f=>relatedCard(f,p.uid)).join('')}</div></section>`:''}`,p);
 if(!dialog.open)dialog.showModal();dialog.querySelector('.detail-scroll').scrollTop=0;dialog.querySelector('#close-detail').focus({preventScroll:true});
}
function showDetail(id){const p=pokemon.find(p=>p.id===Number(id));if(!p)return;detailRequest++;renderDexDetail(p);}
async function showRelatedDetail(uid){
 const existing=pokemon.find(p=>p.uid===uid)||extraDetails?.[uid];if(existing){detailRequest++;renderDexDetail(existing);return;}
 const request=++detailRequest,dialog=document.querySelector('#detail');dialog.classList.add('dex-detail');dialog.removeAttribute('aria-labelledby');
 dialog.innerHTML=detailShell('<p class="loading" role="status">포켓몬 정보를 불러오는 중…</p>');if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
 try{
  if(!extraDetailsPromise)extraDetailsPromise=fetch('pokemon-details.json').then(r=>{if(!r.ok)throw Error('details');return r.json();}).then(data=>extraDetails=data).catch(error=>{extraDetailsPromise=null;throw error;});
  const details=await extraDetailsPromise;if(request!==detailRequest||!dialog.open)return;
  if(!details[uid])throw Error('entry');renderDexDetail(details[uid]);
 }catch{if(request!==detailRequest||!dialog.open)return;dialog.innerHTML=detailShell(`<p>포켓몬 정보를 불러오지 못했어요.</p><button class="secondary" data-dex-uid="${uid}">다시 불러오기</button>`);}
}
function renderRecords(){
 const key=recordTab,list=leaderboard(key),state=rankingStates.get(key)||{status:'idle'},kind=rankingMode(key),level=rankingDifficulty(key);
 const content=state.status==='idle'||state.status==='loading'?'<div class="ranking-status" role="status"><span class="quiz-spinner" aria-hidden="true"></span><p>트레이너들의 기록을 불러오는 중이에요…</p></div>':state.status==='error'?`<div class="ranking-status" role="status"><p>${escapeHTML(state.message)}</p><button class="secondary" id="retry-rankings">다시 불러오기</button></div>`:list.length?`<table class="ranking"><thead><tr><th>순위</th><th>트레이너</th><th>점수</th><th>정답</th><th>날짜</th></tr></thead><tbody>${list.map((r,i)=>`<tr class="${r.id===lastSavedId?'new-record':''}"><td>${rankBadge(i+1)}</td><td>${escapeHTML(r.name)}</td><td class="score">${r.score.toLocaleString()}</td><td>${r.correct} / ${r.total}</td><td class="record-date"><time datetime="${escapeHTML(r.date)}">${rankingDate(r.date)}</time></td></tr>`).join('')}</tbody></table><p class="result-note">${rankingLabel(key)} TOP 20 · 같은 점수는 정답 수, 먼저 세운 기록 순이에요.</p>`:`<div class="empty"><div style="font-size:38px;margin-bottom:14px">🏆</div>첫 번째 기록의 주인공이 되어 보세요!<div style="margin-top:23px"><button class="primary" data-play-record="${key}">도전 시작하기</button></div></div>`;
 app.innerHTML=`<button class="text-button back-to-game" data-nav="play"><span aria-hidden="true">&lt;</span> 퀴즈도전</button><section class="intro ranking-intro"><div><h1>우리들의 랭킹</h1><p>다른 트레이너들과 함께 최고 기록에 도전해 보세요.</p></div><button class="ranking-refresh" id="refresh-rankings" aria-label="랭킹 새로고침" title="새로고침" ${state.status==='loading'?'disabled':''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 19.7 10M4.3 14A8 8 0 0 0 17.9 17.9"/></svg></button></section><section class="ranking-controls" aria-label="랭킹 모드와 난이도"><div class="game-tabs ranking-mode-tabs" role="group" aria-label="게임 모드">${[['time','⏱️ 타임어택'],['write','🏆 마스터']].map(([value,label])=>`<button class="game-tab ${kind===value?'active':''}" data-ranking-mode="${value}" aria-pressed="${kind===value}">${label}</button>`).join('')}</div><div class="ranking-difficulties" role="group" aria-label="난이도">${Object.entries(difficulties).map(([value,d])=>`<button data-ranking-difficulty="${value}" class="${level===value?'active':''}" aria-pressed="${level===value}">${d.label}</button>`).join('')}</div></section><div class="shared-ranking-board" aria-live="polite">${content}</div>`;
 if(state.status==='idle')loadRankings(key).catch(()=>{});
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='print-coloring'){if(!b.disabled)window.print();return;}if(b.dataset.nav){navigate(b.dataset.nav);return;}if(b.dataset.mode){const switchMode=()=>{cleanup();game=null;mode=b.dataset.mode;renderPlay();};if(activeGame())confirmLeave(switchMode);else switchMode();return;}if(b.dataset.difficulty){difficulty=b.dataset.difficulty;renderPlay();return;}if(b.id==='start-game'||b.hasAttribute('data-start')){startGame();return;}if(b.dataset.answer){submitAnswer(b.dataset.answer);return;}if(b.id==='skip-question'){submitAnswer('',true);return;}if(b.id==='quit-game'){endGame('quit');return;}if(b.id==='retry-ranking'){prepareRanking(game);return;}if(b.id==='refresh-rankings'||b.id==='retry-rankings'){if(!rankingRequests.has(recordTab)){rankingStates.delete(recordTab);renderRecords();}return;}if(b.dataset.rankingMode){recordTab=rankingBoard(b.dataset.rankingMode,rankingDifficulty(recordTab));renderRecords();return;}if(b.dataset.rankingDifficulty){recordTab=rankingBoard(rankingMode(recordTab),b.dataset.rankingDifficulty);renderRecords();return;}if(b.id==='enter-ranking'){showRankingEntry();return;}if(b.id==='close-ranking'){document.querySelector('#high-score').close();return;}if(b.id==='ranking-replay'){document.querySelector('#high-score').close();startGame();return;}if(b.id==='keep-playing'){leaveAction=null;document.querySelector('#detail').close();return;}if(b.id==='leave-game'){const action=leaveAction;leaveAction=null;document.querySelector('#detail').close();if(action)action();return;}if(b.dataset.dexUid){showRelatedDetail(b.dataset.dexUid);return;}if(b.hasAttribute('data-description')){const dialog=document.querySelector('#detail');dialog.querySelectorAll('[data-description]').forEach(button=>{const selected=button===b;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',selected);});dialog.querySelectorAll('[data-description-text]').forEach(text=>text.hidden=text.dataset.descriptionText!==b.dataset.description);return;}if(b.dataset.colorPokemon){const p=pokemon.find(p=>p.uid===b.dataset.colorUid)||extraDetails?.[b.dataset.colorUid];if(p)showColoring(p);return;}if(b.dataset.pokemon){showDetail(b.dataset.pokemon);return;}if(b.id==='close-detail'){document.querySelector('#detail').close();return;}if(b.dataset.recordTab){recordTab=b.dataset.recordTab;renderRecords();return;}if(b.dataset.playRecord){const key=b.dataset.playRecord;mode=key==='time'||key.startsWith('time-')?'time':'write';difficulty=mode==='time'?(key==='time'?'normal':key.slice(5)):key;view='play';game=null;render();return;}});
document.addEventListener('submit',e=>{if(e.target.id==='answer-form'){e.preventDefault();const value=document.querySelector('#answer-input').value.trim();if(value)submitAnswer(value);}if(e.target.id==='save-form'){e.preventDefault();saveRecord();}});
document.addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;renderDexResults();}if(e.target.id==='trainer-name')e.target.setCustomValidity('');});
document.addEventListener('change',e=>{if(e.target.id==='region-filter'){regionFilter=e.target.value;renderDexResults();}if(e.target.id==='type-filter'){typeFilter=e.target.value;renderDexResults();}if(e.target.id==='sort'){sort=e.target.value;renderDexResults();}});
document.addEventListener('keydown',e=>{if(document.querySelector('#detail').open||document.querySelector('#coloring').open||document.querySelector('#high-score').open||e.target.matches('input,select,textarea')||e.isComposing)return;if(game?.status==='playing'&&game.mode==='time'&&!game.locked&&/^[1-4]$/.test(e.key)){e.preventDefault();submitAnswer(game.options[Number(e.key)-1].id);}});
for(const id of ['detail','coloring'])document.querySelector('#'+id).addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close();}});
document.querySelector('#coloring').addEventListener('close',()=>{if(!document.querySelector('#coloring').open)coloringRequest++;});
async function init(){try{const [dataResponse,manifestResponse,regionResponse]=await Promise.all([fetch('pokemon.json'),fetch('pokedex-manifest.json'),fetch('pokemon-regions.json')]);if(!dataResponse.ok||!manifestResponse.ok||!regionResponse.ok)throw Error('data');const [data,manifest,regionalData]=await Promise.all([dataResponse.json(),manifestResponse.json(),regionResponse.json()]);if(!Array.isArray(data)||data.length!==manifest.speciesCount||manifest.speciesCount!==manifest.maxNumber||!data.every((p,i)=>p.id===i+1&&p.name&&p.image&&p.types?.length))throw Error('incomplete');if(!Array.isArray(regionalData.groups)||!regionalData.groups.length||regionalData.groups.some(g=>!g.name||!Array.isArray(g.numbers)||g.numbers.some(n=>!Number.isInteger(n)||n<1||n>manifest.maxNumber)))throw Error('regions');pokemon=data;pokedexManifest=manifest;regionGroups=regionalData.groups;render();}catch{app.innerHTML='<div class="empty">포켓몬 도감을 불러오지 못했어요.<br><button id="retry-load" class="primary" style="margin-top:20px">다시 불러오기</button></div>';document.querySelector('#retry-load').onclick=init;}}
init();
// WebMCP uses the same game and Pokédex actions as the visible controls.
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();
 const quizState=()=>game?{status:game.status,mode:game.mode,difficulty:game.difficulty,score:game.score,answered:game.total,correct:game.correct,secondsRemaining:game.mode==='write'?null:game.status==='playing'?Math.max(0,Math.ceil((game.deadline-performance.now())/1000)):0,ready:game.imageReady&&!game.locked,choices:game.mode==='time'&&game.status==='playing'?game.options.map(p=>p.name):[]}: {status:'ready'};
 const registrations=[
  {name:'read_pokemon_quiz_state',title:'퀴즈 상태 보기',description:'Read the current quiz status, visible choices, score and remaining seconds. The correct answer is not returned.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute(input){if(Object.keys(input||{}).length)throw Error('No arguments accepted.');return quizState();}},
  {name:'start_pokemon_quiz',title:'포켓몬 퀴즈 시작',description:'Start a 60-second four-choice quiz or a ten-question typed-name quiz. Cannot replace an active game.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['time','write']},difficulty:{type:'string',enum:['easy','normal','hard']}},required:['mode'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!pokemon.length)throw Error('Pokédex is not ready.');if(!['time','write'].includes(input?.mode)||(input.difficulty&&!difficulties[input.difficulty])||Object.keys(input).some(k=>!['mode','difficulty'].includes(k)))throw Error('Invalid quiz configuration.');if(activeGame())throw Error('Finish the active game first.');if(document.querySelector('#high-score').open)throw Error('Save or dismiss the high-score entry first.');cleanup();game=null;view='play';mode=input.mode;difficulty=input.difficulty||'easy';render();startGame();return quizState();}},
  {name:'submit_pokemon_answer',title:'포켓몬 퀴즈 답하기',description:'Submit a Korean Pokémon name to the active quiz. For four-choice quizzes, supply one of the visible choice names.',inputSchema:{type:'object',properties:{answer:{type:'string',minLength:1,maxLength:30}},required:['answer'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(typeof input?.answer!=='string'||!input.answer.trim()||input.answer.length>30||Object.keys(input).some(k=>k!=='answer'))throw Error('Invalid answer.');if(!game||game.status!=='playing'||game.locked||!game.imageReady)throw Error('No question ready for an answer.');let answer=input.answer;if(game.mode==='time'){const choice=game.options.find(p=>normalize(p.name)===normalize(answer));if(!choice)throw Error('Choose one of the visible names.');answer=choice.id;}submitAnswer(answer);return {...quizState(),feedback:document.querySelector('#feedback')?.textContent||''};}},
  {name:'search_pokemon_pokedex',title:'포켓몬 도감 검색',description:'Search the full national Pokédex by Korean name or Pokédex number and show the same results in the visible Pokédex.',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:40}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(typeof input?.query!=='string'||input.query.length>40||Object.keys(input).some(k=>k!=='query'))throw Error('Invalid search query.');if(!pokemon.length)throw Error('Pokédex is not ready.');if(activeGame())throw Error('Finish the active game first.');if(document.querySelector('#high-score').open)throw Error('Save or dismiss the high-score entry first.');search=input.query;typeFilter='';regionFilter='';sort='number';view='dex';render();const q=normalize(search);return {results:pokemon.filter(p=>!q||normalize(p.name).includes(q)||number(p).includes(q)||String(p.id)===q).map(p=>({number:p.id,name:p.name,types:p.types}))};}}
 ];
 registrations.forEach(tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}});
 addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
