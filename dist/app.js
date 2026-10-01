'use strict';
const app=document.querySelector('#app');
const difficulties={easy:{label:'쉬움',seconds:30,multiplier:1},normal:{label:'보통',seconds:20,multiplier:2},hard:{label:'어려움',seconds:15,multiplier:3}};
const familiar=[1,2,3,4,5,6,7,8,9,12,16,25,26,35,37,39,52,54,58,63,66,74,79,92,94,95,104,113,129,130,131,132,133,134,135,136,143,144,145,146,149,150,151];
let pokemon=[],view='play',mode='time',difficulty='easy',game=null,ticker=null,advance=null,recordTab='time',search='',typeFilter='',sort='number';
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle=xs=>{const a=[...xs];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const normalize=s=>s.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko');
const RANKING_LIMIT=20;
const rankingModes=['time','easy','normal','hard'];
let records=[],lastSavedId=null;
function readRecords(){const stored=JSON.parse(localStorage.getItem('pokemon-play-records')||'[]');return Array.isArray(stored)?stored.filter(r=>r&&typeof r.name==='string'&&Number.isFinite(r.score)&&Number.isFinite(r.correct)&&Number.isFinite(r.total)&&typeof r.date==='string'&&Number.isFinite(Date.parse(r.date))&&rankingModes.includes(r.mode)):[];}
function compareRecords(a,b){return b.score-a.score||b.correct-a.correct||a.date.localeCompare(b.date);}
function leaderboard(key,items=records){return items.filter(r=>r.mode===key).sort(compareRecords).slice(0,RANKING_LIMIT);}
function rankOf(record,items=records){return leaderboard(record.mode,[...items,record]).indexOf(record)+1;}
function rankingLabel(key){return key==='time'?'타임어택':`주관식 · ${difficulties[key].label}`;}
try{records=readRecords();}catch{}
const number=p=>String(p.id).padStart(3,'0');
const badges=p=>p.types.map(t=>`<span class="type" data-type="${t}">${t}</span>`).join('');
const card=p=>`<button class="dex-card" data-pokemon="${p.id}" aria-label="${p.name} 도감 보기"><span class="number">No. ${number(p)}</span><img src="${p.image}" alt="${p.name}" loading="lazy" width="140" height="130"><strong>${p.name}</strong><div>${badges(p)}</div></button>`;
const highest=key=>Math.max(0,...records.filter(r=>r.mode===key).map(r=>r.score));
function cleanup(){clearInterval(ticker);clearTimeout(advance);ticker=null;advance=null;}
let leaveAction=null;
function confirmLeave(action){const dialog=document.querySelector('#detail');leaveAction=action;dialog.innerHTML='<div class="detail-inner"><h2 style="font-size:22px">진행 중인 게임을 끝낼까요?</h2><p>이동하면 이번 게임의 기록은 저장되지 않아요.</p><div class="result-actions"><button class="secondary" id="keep-playing">계속 플레이</button><button class="primary" id="leave-game">게임 끝내고 이동</button></div></div>';dialog.showModal();}
function navigate(next){if(game&&game.status==='playing'){confirmLeave(()=>{cleanup();game=null;view=next;render();});return;}cleanup();game=null;view=next;render();}
function updateNav(){document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.nav===view));}
function render(){updateNav();if(view==='play')renderPlay();else if(view==='dex')renderDex();else renderRecords();}
function renderPlay(){
app.innerHTML=`<section class="intro"><div><h1>이 포켓몬, 누구일까요?</h1></div></section>
<div class="play-grid"><section class="game-card" aria-label="포켓몬 퀴즈"><div class="game-tabs"><button class="game-tab ${mode==='time'?'active':''}" data-mode="time">⚡ 타임어택</button><button class="game-tab ${mode==='write'?'active':''}" data-mode="write">✎ 마스터 도전 <span class="new-tag">주관식</span></button></div><div id="game-body" class="game-body"></div></section></div>
<div class="quick-links"><button class="text-button" data-nav="dex">포켓몬 도감</button><button class="text-button" data-nav="records">랭킹</button></div>`;
renderGameBody();
}
function renderGameBody(){const body=document.querySelector('#game-body');if(!body)return;
if(game?.status==='ended'){renderResult(body);return;}
if(game?.status==='playing'){renderQuestion(body);return;}
body.innerHTML=`<div class="game-heading"><span class="label-icon">${mode==='time'?'⚡':'✎'}</span><div><h2>${mode==='time'?'60초 타임어택':'포켓몬 마스터 도전'}</h2><small>${mode==='time'?'빠르게 맞히고, 최고 기록에 도전하세요!':'이름을 직접 쓰고, 실력을 뽐내 보세요!'}</small></div><span class="mode-pill">${mode==='time'?'4지선다':'10문제'}</span></div>
${mode==='write'?`<div class="difficulty" aria-label="난이도 선택">${Object.entries(difficulties).map(([key,d])=>`<button data-difficulty="${key}" class="${difficulty===key?'active':''}" aria-pressed="${difficulty===key}">${d.label}<small>${d.seconds}초 · ${d.multiplier}배 점수</small></button>`).join('')}</div>`:''}
<div class="pokemon-stage"><span class="stage-tag">READY TO PLAY?</span><span class="stage-star">✦</span><span class="stage-star two">✦</span><img src="${pokemon.find(p=>p.id===modePokemon()).image}" alt="게임을 시작하면 포켓몬 문제가 나타나요" width="190" height="190"><span class="stage-caption">${mode==='time'?'누구인지 알 것 같나요?':'이름을 기억하고 있나요?'}</span></div>
${mode==='time'?`<div class="choices" aria-label="4지선다 예시">${['이브이','피카츄','파이리','꼬부기'].map((name,i)=>`<button class="choice" data-start="${i}"><span>${i+1}</span>${name}</button>`).join('')}</div>`:`<p class="setup-description">${difficulty==='easy'?'친숙한 포켓몬 43마리가 나와요. 한 문제에 30초!':difficulty==='normal'?'관동지방 151마리 중에서 나와요. 한 문제에 20초!':'151마리가 실루엣으로 나와요. 한 문제에 15초!'}</p>`}
<div class="start-line"><button class="primary" id="start-game">${mode==='time'?'타임어택 시작!':'마스터 도전 시작!'}</button><p>${mode==='time'?'60초 · 정답 100점<br>연속 정답 보너스':'10문제 · 난이도별 점수<br>키보드 Enter로 정답 확인'}</p></div>`;
}
function modePokemon(){return mode==='time'?25:133;}
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
function startGame(){cleanup();const pool=mode==='write'&&difficulty==='easy'?pokemon.filter(p=>familiar.includes(p.id)):pokemon;
game={status:'playing',mode,difficulty,pool,deck:shuffle(pool),images:new Map(),question:null,score:0,correct:0,total:0,streak:0,maxStreak:0,history:[],locked:false,saved:false,deadline:mode==='time'?performance.now()+60000:0,imageReady:false,imageFailures:0};
nextQuestion();ticker=setInterval(tick,100);}
function nextQuestion(){if(!game||game.status!=='playing')return;if(game.mode==='write'&&game.total>=10){endGame();return;}if(game.mode==='time'&&performance.now()>=game.deadline){endGame();return;}
if(game.deck.length===0)game.deck=shuffle(game.pool.filter(p=>p.id!==game.question?.id));game.question=game.deck.pop();game.locked=false;game.imageReady=false;
prepareQuestionImages(game);game.options=shuffle([game.question,...shuffle(pokemon.filter(p=>p.id!==game.question.id)).slice(0,3)]);if(game.mode==='write')game.deadline=performance.now()+difficulties[game.difficulty].seconds*1000;renderGameBody();}
function timerState(g){const duration=g.mode==='time'?60000:difficulties[g.difficulty].seconds*1000;const remaining=Math.max(0,g.deadline-performance.now());return {seconds:Math.ceil(remaining/1000),percent:Math.min(100,remaining/duration*100)};}
function renderQuestion(body){const g=game;const timeState=timerState(g);const secs=timeState.seconds;const previousProgress=g.mode==='time'?body.querySelector('.progress'):null;
body.innerHTML=`<div class="game-stats"><span><strong id="score">${g.score.toLocaleString()}</strong> 점</span><span>${g.mode==='time'?`연속 <b id="streak">${g.streak}</b> 정답`:`${g.total+1} / 10 문제`}</span><span class="time">⏱ <strong id="time">${secs}</strong> 초</span></div><div class="progress" role="progressbar" aria-label="남은 시간" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${timeState.percent}"><div id="timer-bar" style="width:${timeState.percent}%"></div></div><div class="game-heading"><div><h2>${g.mode==='time'?'이 포켓몬의 이름은?':'포켓몬 이름을 적어 주세요'}</h2><small>${g.mode==='time'?'네 개의 이름 중 정답을 골라요':difficulties[g.difficulty].label+' · 한글 이름으로 답해요'}</small></div><button class="text-button" id="quit-game">그만하기</button></div>
<div class="pokemon-stage ${g.mode==='write'&&g.difficulty==='hard'?'silhouette':''}"><span class="stage-tag">WHO’S THAT POKÉMON?</span><span id="question-image-slot"></span></div>
${g.mode==='time'?`<div class="choices">${g.options.map((p,i)=>`<button class="choice" data-answer="${p.id}" disabled><span>${i+1}</span>${p.name}</button>`).join('')}</div>`:`<form class="text-form" id="answer-form"><input id="answer-input" autocomplete="off" maxlength="30" placeholder="포켓몬 이름" aria-label="포켓몬 이름" disabled><button class="primary" type="submit" disabled>확인</button></form>`}
<div id="feedback" class="feedback" role="status" aria-live="polite">포켓몬을 불러오는 중…</div><div class="play-actions"><span class="result-note">${g.mode==='time'?'키보드 1–4로도 선택할 수 있어요':'띄어쓰기는 자유롭게 입력해도 괜찮아요'}</span>${g.mode==='write'?'<button class="text-button" id="skip-question">모르겠어요</button>':''}</div>`;
// Keep the time-attack bar itself alive when replacing the question.
if(previousProgress){body.querySelector('.progress').replaceWith(previousProgress);previousProgress.querySelector('#timer-bar').style.width=timeState.percent+'%';previousProgress.setAttribute('aria-valuenow',timeState.percent);}
const current=g.question.id,entry=g.images.get(current),img=entry.image;
img.id='question-image';body.querySelector('#question-image-slot').replaceWith(img);
const active=()=>game===g&&g.status==='playing'&&g.question.id===current&&!g.locked&&body.querySelector('#question-image')===img;
const ready=()=>{if(!active())return;g.imageReady=true;body.querySelectorAll('.choice,.text-form input,.text-form button').forEach(b=>b.disabled=false);body.querySelector('#feedback').textContent='';if(g.mode==='write')body.querySelector('#answer-input').focus({preventScroll:true});};
const failed=()=>{if(!active())return;g.imageFailures++;if(g.imageFailures>=5){g.imageError=true;endGame();}else nextQuestion();};
if(entry.ready)ready();else entry.loaded.then(ok=>ok?ready():failed());}
function tick(){if(!game||game.status!=='playing')return;const state=timerState(game);const time=document.querySelector('#time');if(time)time.textContent=state.seconds;const bar=document.querySelector('#timer-bar');if(bar){bar.style.width=state.percent+'%';bar.parentElement.setAttribute('aria-valuenow',state.percent);}if(state.seconds<=0){if(game.mode==='time')endGame();else if(!game.locked)submitAnswer('',true);}}
function submitAnswer(value,timedOut=false){const g=game;if(!g||g.status!=='playing'||g.locked||(!g.imageReady&&!timedOut))return;if(performance.now()>=g.deadline&&!timedOut){if(g.mode==='time'){endGame();return;}timedOut=true;}
g.locked=true;const correct=!timedOut&&(g.mode==='time'?Number(value)===g.question.id:normalize(value)===normalize(g.question.name));g.total++;if(correct){g.correct++;g.streak++;g.maxStreak=Math.max(g.maxStreak,g.streak);g.score+=g.mode==='time'?100+Math.min(g.streak-1,10)*10:(100+Math.floor(Math.max(0,g.deadline-performance.now())/1000)*2)*difficulties[g.difficulty].multiplier;}else g.streak=0;
g.history.push({pokemon:g.question,correct,answer:String(value),timedOut});const feedback=document.querySelector('#feedback');feedback.className='feedback '+(correct?'good':'bad');feedback.textContent=correct?`정답! ${g.question.name}, 잘 알고 있네요!`:`${timedOut?'시간이 다 됐어요.':'괜찮아요!'} 정답은 ${g.question.name}`;
document.querySelector('.pokemon-stage')?.classList.add('reveal');document.querySelectorAll('[data-answer]').forEach(b=>{b.disabled=true;if(Number(b.dataset.answer)===g.question.id)b.classList.add('correct');else if(Number(b.dataset.answer)===Number(value))b.classList.add('wrong');});document.querySelectorAll('.text-form input,.text-form button,#skip-question').forEach(b=>b.disabled=true);document.querySelector('#score').textContent=g.score.toLocaleString();const streak=document.querySelector('#streak');if(streak)streak.textContent=g.streak;
advance=setTimeout(nextQuestion,correct?550:1300);}
function endGame(reason='complete'){
 if(!game||game.status==='ended')return;
 cleanup();game.status='ended';game.completed=reason==='complete';
 game.record={id:typeof crypto.randomUUID==='function'?crypto.randomUUID():`${Date.now()}-${Math.random()}`,score:game.score,correct:game.correct,total:game.total,mode:game.mode==='time'?'time':game.difficulty,date:new Date().toISOString()};
 try{records=readRecords();}catch{}
 game.rank=game.completed&&!game.imageError&&game.score>0?rankOf(game.record):0;
 // Replace an open details/navigation panel with the end-of-game registration.
 leaveAction=null;document.querySelector('#detail').close();
 renderGameBody();if(game.rank)showRankingEntry();
}
function resultRanking(g){
 if(g.imageError)return '<p class="result-note">인터넷 연결을 확인하고 다시 도전해 주세요.</p>';
 if(!g.completed)return '<p class="result-note">끝까지 플레이하면 랭킹에 도전할 수 있어요.</p>';
 if(g.saved)return `<div class="rank-banner saved"><span>🏆</span><div><strong>랭킹 ${g.savedRank}위에 이름을 남겼어요!</strong><p>${escapeHTML(g.record.name)} · ${rankingLabel(g.record.mode)}</p></div></div>`;
 if(g.rank)return `<div class="rank-banner"><span>🏆</span><div><strong>축하해요! 랭킹 ${g.rank}위!</strong><p>${rankingLabel(g.record.mode)} TOP ${RANKING_LIMIT}에 이름을 남겨 보세요.</p></div><button class="secondary" id="enter-ranking">이름 남기기</button></div>`;
 const cutoff=leaderboard(g.record.mode).at(-1);
 return `<p class="result-note">${g.score===0?'다음에는 정답을 맞히고 랭킹에 도전해 보세요!':`이번에는 TOP ${RANKING_LIMIT}에 조금 못 미쳤어요. ${cutoff?`현재 ${RANKING_LIMIT}위는 ${cutoff.score.toLocaleString()}점이에요.`:''}`}</p>`;
}
function renderResult(body){const g=game;const mistakes=g.history.filter(x=>!x.correct);body.innerHTML=`<div class="result"><div class="result-icon">${g.imageError?'☁️':g.correct>0?'🏆':'🌱'}</div><h2>${g.imageError?'포켓몬을 불러오지 못했어요':g.correct>=8?'멋진 포켓몬 트레이너!':'즐거운 도전이었어요!'}</h2><div class="big-score">${g.score.toLocaleString()}<small>점</small></div><p class="summary">${g.mode==='time'?'60초 타임어택':difficulties[g.difficulty].label+' 마스터 도전'} · ${g.total}문제 중 ${g.correct}개 정답 · 최고 ${g.maxStreak}연속</p>${resultRanking(g)}
${mistakes.length?`<div class="review-list"><strong style="font-size:13px">다음에는 기억할 수 있어요!</strong>${mistakes.map(m=>`<div class="review-row"><img src="${m.pokemon.image}" alt="" width="38" height="38"><strong>${m.pokemon.name}</strong><span>${m.timedOut?'시간 초과':'다시 만나기'}</span><button data-pokemon="${m.pokemon.id}">도감 보기</button></div>`).join('')}</div>`:''}<div class="result-actions"><button class="primary" id="start-game">다시 도전!</button><button class="secondary" data-nav="records">랭킹 보기</button></div></div>`;}
function showRankingEntry(){
 if(!game||game.status!=='ended'||!game.rank)return;
 const g=game,dialog=document.querySelector('#high-score');
 const list=g.saved?leaderboard(g.record.mode):leaderboard(g.record.mode,[...records,g.record]);
 const rank=g.saved?g.savedRank:g.rank;
 dialog.innerHTML=`<div class="arcade-entry leaderboard-entry"><button class="close" id="close-ranking" aria-label="랭킹 닫기">×</button><h2 id="high-score-title">${g.saved?'우리들의 랭킹':'랭킹에 이름을 남겨요!'}</h2><div class="entry-summary"><span>${rankingLabel(g.record.mode)} · TOP ${RANKING_LIMIT}</span><strong>내 순위 ${rank}위 <span>· ${g.score.toLocaleString()}점</span></strong></div><form id="save-form"></form><div class="entry-list"><table class="entry-ranking"><thead><tr><th scope="col">순위</th><th scope="col">트레이너</th><th scope="col">점수</th></tr></thead><tbody>${list.map((r,i)=>{const me=r.id===g.record.id;return `<tr class="${me?'my-entry':''}" ${me?'aria-label="내 기록"':''}><td>${i+1}${me?'<span class="my-tag">나</span>':''}</td><td>${me&&!g.saved?'<div class="entry-input"><input id="trainer-name" form="save-form" aria-label="트레이너 이름" placeholder="트레이너 이름" maxlength="12" autocomplete="off" required><button type="submit" form="save-form" class="save-name" aria-label="트레이너 이름 저장" title="저장">✓</button></div>':escapeHTML(r.name)}</td><td class="entry-points">${r.score.toLocaleString()}</td></tr>`;}).join('')}</tbody></table></div><p id="save-message" class="result-note" role="status">${g.saved?'이름을 저장했어요.':''}</p>${g.saved?'<button class="primary" id="ranking-replay">다시 도전!</button>':''}</div>`;
 if(!dialog.open)dialog.showModal();
 const input=dialog.querySelector('#trainer-name');if(input)input.focus({preventScroll:true});
 const ownRow=dialog.querySelector('.my-entry');if(ownRow)ownRow.scrollIntoView({block:'nearest'});
}
function saveRecord(){
 if(!game||game.status!=='ended'||game.saved||!game.rank)return;
 const input=document.querySelector('#trainer-name');if(!input)return;
 const name=input.value.trim();if(!name){input.setCustomValidity('이름을 적어 주세요.');input.reportValidity();return;}if(name.length>12){input.setCustomValidity('이름은 12자까지 적어 주세요.');input.reportValidity();return;}input.setCustomValidity('');
 const record={...game.record,name};
 try{
  // Recheck the current board, including scores saved in another tab.
  const latest=readRecords();const rank=rankOf(record,latest);
  if(!rank){records=latest;game.rank=0;document.querySelector('#high-score').close();renderGameBody();return;}
  const updated=rankingModes.flatMap(key=>leaderboard(key,[...latest,record]));
  localStorage.setItem('pokemon-play-records',JSON.stringify(updated));records=updated;game.record=record;game.saved=true;game.savedRank=rank;lastSavedId=record.id;recordTab=record.mode;
  renderGameBody();showRankingEntry();
 }catch{document.querySelector('#save-message').textContent='랭킹을 저장하지 못했어요. 브라우저의 저장 설정을 확인한 뒤 다시 눌러 주세요.';}
}
function renderDex(){app.innerHTML=`<button class="text-button back-to-game" data-nav="play">퀴즈로 돌아가기</button><section class="intro"><div><p class="eyebrow">MEET YOUR POKÉMON</p><h1>포켓몬 도감</h1><p>관동지방 151마리의 이름, 타입과 특징을 알아보세요.</p></div><span class="collection">공식 도감 정보</span></section><div class="filters"><input id="search" value="${escapeHTML(search)}" placeholder="포켓몬 이름 또는 도감 번호 검색" aria-label="포켓몬 검색"><select id="type-filter" aria-label="타입 선택"><option value="">모든 타입</option>${[...new Set(pokemon.flatMap(p=>p.types))].map(t=>`<option ${typeFilter===t?'selected':''}>${t}</option>`).join('')}</select><select id="sort" aria-label="정렬"><option value="number" ${sort==='number'?'selected':''}>도감 번호순</option><option value="name" ${sort==='name'?'selected':''}>이름순</option></select></div><div id="dex-results"></div>`;renderDexResults();}
function renderDexResults(){const q=normalize(search);let list=pokemon.filter(p=>(!q||normalize(p.name).includes(q)||String(p.id).padStart(3,'0').includes(q)||String(p.id)===q)&&(!typeFilter||p.types.includes(typeFilter)));if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name,'ko'));document.querySelector('#dex-results').innerHTML=`<div class="result-count">${list.length}마리의 포켓몬</div>${list.length?`<div class="dex-grid">${list.map(card).join('')}</div>`:'<div class="empty">찾는 포켓몬이 없어요. 다른 이름이나 번호로 찾아보세요.</div>'}`;}
function showDetail(id){const p=pokemon.find(p=>p.id===Number(id));if(!p)return;const dialog=document.querySelector('#detail');dialog.innerHTML=`<div class="detail-inner"><button class="close" id="close-detail" aria-label="도감 닫기">×</button><div class="detail-image"><img src="${p.image}" alt="${p.name}" width="240" height="215"></div><p class="eyebrow">KANTO · No. ${number(p)}</p><h2>${p.name}</h2><div>${badges(p)}</div><p>${escapeHTML(p.description)}</p><dl><div><dt>분류</dt><dd>${p.category}</dd></div><div><dt>특성</dt><dd>${p.ability}</dd></div><div><dt>키</dt><dd>${p.height}</dd></div><div><dt>몸무게</dt><dd>${p.weight}</dd></div></dl><a class="source-link" href="${p.source}" target="_blank" rel="noopener">포켓몬 공식 도감에서 자세히 보기</a></div>`;dialog.showModal();}
function renderRecords(){const list=leaderboard(recordTab);app.innerHTML=`<button class="text-button back-to-game" data-nav="play">퀴즈로 돌아가기</button><section class="intro"><div><p class="eyebrow">YOUR TRAINER RECORDS</p><h1>우리들의 랭킹</h1><p>친구와 번갈아 도전하고, 같은 기기에서 기록을 비교해 보세요.</p></div><span class="collection">이 기기의 기록</span></section><div class="records-tabs">${[['time','⚡ 타임어택'],['easy','주관식 · 쉬움'],['normal','주관식 · 보통'],['hard','주관식 · 어려움']].map(([key,label])=>`<button data-record-tab="${key}" class="${recordTab===key?'active':''}">${label}</button>`).join('')}</div>${list.length?`<table class="ranking"><thead><tr><th>순위</th><th>트레이너</th><th>점수</th><th>정답</th><th>날짜</th></tr></thead><tbody>${list.map((r,i)=>`<tr class="${r.id&&r.id===lastSavedId?'new-record':''}"><td>${i<3?['🥇','🥈','🥉'][i]:i+1}</td><td>${escapeHTML(r.name)}</td><td class="score">${r.score.toLocaleString()}</td><td>${r.correct} / ${r.total}</td><td>${new Date(r.date).toLocaleDateString('ko-KR')}</td></tr>`).join('')}</tbody></table><p class="result-note">모드와 난이도별 TOP 20 · 같은 점수는 정답 수, 먼저 세운 기록 순이에요. 브라우저 데이터를 삭제하면 랭킹도 사라져요.</p>`:`<div class="empty"><div style="font-size:38px;margin-bottom:14px">🏆</div>첫 번째 기록의 주인공이 되어 보세요!<div style="margin-top:23px"><button class="primary" data-play-record="${recordTab}">도전 시작하기</button></div></div>`}`;}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.nav){navigate(b.dataset.nav);return;}if(b.dataset.mode){const switchMode=()=>{cleanup();game=null;mode=b.dataset.mode;renderPlay();};if(game?.status==='playing')confirmLeave(switchMode);else switchMode();return;}if(b.dataset.difficulty){difficulty=b.dataset.difficulty;renderPlay();return;}if(b.id==='start-game'||b.hasAttribute('data-start')){startGame();return;}if(b.dataset.answer){submitAnswer(b.dataset.answer);return;}if(b.id==='skip-question'){submitAnswer('');return;}if(b.id==='quit-game'){endGame('quit');return;}if(b.id==='enter-ranking'){showRankingEntry();return;}if(b.id==='close-ranking'){document.querySelector('#high-score').close();return;}if(b.id==='ranking-replay'){document.querySelector('#high-score').close();startGame();return;}if(b.id==='keep-playing'){leaveAction=null;document.querySelector('#detail').close();return;}if(b.id==='leave-game'){const action=leaveAction;leaveAction=null;document.querySelector('#detail').close();if(action)action();return;}if(b.dataset.pokemon){showDetail(b.dataset.pokemon);return;}if(b.id==='close-detail'){document.querySelector('#detail').close();return;}if(b.dataset.recordTab){recordTab=b.dataset.recordTab;renderRecords();return;}if(b.dataset.playRecord){mode=b.dataset.playRecord==='time'?'time':'write';if(mode==='write')difficulty=b.dataset.playRecord;view='play';game=null;render();return;}});
document.addEventListener('submit',e=>{if(e.target.id==='answer-form'){e.preventDefault();const value=document.querySelector('#answer-input').value.trim();if(value)submitAnswer(value);}if(e.target.id==='save-form'){e.preventDefault();saveRecord();}});
document.addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;renderDexResults();}if(e.target.id==='trainer-name')e.target.setCustomValidity('');});
document.addEventListener('change',e=>{if(e.target.id==='type-filter'){typeFilter=e.target.value;renderDexResults();}if(e.target.id==='sort'){sort=e.target.value;renderDexResults();}});
document.addEventListener('keydown',e=>{if(document.querySelector('#detail').open||document.querySelector('#high-score').open||e.target.matches('input,select,textarea')||e.isComposing)return;if(game?.status==='playing'&&game.mode==='time'&&!game.locked&&/^[1-4]$/.test(e.key)){e.preventDefault();submitAnswer(game.options[Number(e.key)-1].id);}});
document.querySelector('#detail').addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close();}});
async function init(){try{const r=await fetch('pokemon.json');if(!r.ok)throw Error('data');pokemon=await r.json();if(pokemon.length!==151)throw Error('incomplete');render();}catch{app.innerHTML='<div class="empty">포켓몬 도감을 불러오지 못했어요.<br><button id="retry-load" class="primary" style="margin-top:20px">다시 불러오기</button></div>';document.querySelector('#retry-load').onclick=init;}}
init();
// WebMCP uses the same game and Pokédex actions as the visible controls.
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();
 const quizState=()=>game?{status:game.status,mode:game.mode,difficulty:game.difficulty,score:game.score,answered:game.total,correct:game.correct,secondsRemaining:game.status==='playing'?Math.max(0,Math.ceil((game.deadline-performance.now())/1000)):0,ready:game.imageReady&&!game.locked,choices:game.mode==='time'&&game.status==='playing'?game.options.map(p=>p.name):[]}: {status:'ready'};
 const registrations=[
  {name:'read_pokemon_quiz_state',title:'퀴즈 상태 보기',description:'Read the current quiz status, visible choices, score and remaining seconds. The correct answer is not returned.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute(input){if(Object.keys(input||{}).length)throw Error('No arguments accepted.');return quizState();}},
  {name:'start_pokemon_quiz',title:'포켓몬 퀴즈 시작',description:'Start a 60-second four-choice quiz or a ten-question typed-name quiz. Cannot replace an active game.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['time','write']},difficulty:{type:'string',enum:['easy','normal','hard']}},required:['mode'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!pokemon.length)throw Error('Pokédex is not ready.');if(!['time','write'].includes(input?.mode)||(input.difficulty&&!difficulties[input.difficulty])||Object.keys(input).some(k=>!['mode','difficulty'].includes(k)))throw Error('Invalid quiz configuration.');if(game?.status==='playing')throw Error('Finish the active game first.');if(document.querySelector('#high-score').open)throw Error('Save or dismiss the high-score entry first.');cleanup();game=null;view='play';mode=input.mode;difficulty=input.difficulty||'easy';render();startGame();return quizState();}},
  {name:'submit_pokemon_answer',title:'포켓몬 퀴즈 답하기',description:'Submit a Korean Pokémon name to the active quiz. For four-choice quizzes, supply one of the visible choice names.',inputSchema:{type:'object',properties:{answer:{type:'string',minLength:1,maxLength:30}},required:['answer'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(typeof input?.answer!=='string'||!input.answer.trim()||input.answer.length>30||Object.keys(input).some(k=>k!=='answer'))throw Error('Invalid answer.');if(!game||game.status!=='playing'||game.locked||!game.imageReady)throw Error('No question ready for an answer.');let answer=input.answer;if(game.mode==='time'){const choice=game.options.find(p=>normalize(p.name)===normalize(answer));if(!choice)throw Error('Choose one of the visible names.');answer=choice.id;}submitAnswer(answer);return {...quizState(),feedback:document.querySelector('#feedback')?.textContent||''};}},
  {name:'search_pokemon_pokedex',title:'포켓몬 도감 검색',description:'Search Kanto Pokémon by Korean name or Pokédex number and show the same results in the visible Pokédex.',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:40}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(typeof input?.query!=='string'||input.query.length>40||Object.keys(input).some(k=>k!=='query'))throw Error('Invalid search query.');if(!pokemon.length)throw Error('Pokédex is not ready.');if(game?.status==='playing')throw Error('Finish the active game first.');if(document.querySelector('#high-score').open)throw Error('Save or dismiss the high-score entry first.');search=input.query;typeFilter='';sort='number';view='dex';render();const q=normalize(search);return {results:pokemon.filter(p=>!q||normalize(p.name).includes(q)||number(p).includes(q)||String(p.id)===q).map(p=>({number:p.id,name:p.name,types:p.types}))};}}
 ];
 registrations.forEach(tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}});
 addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
