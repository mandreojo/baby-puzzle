/* =========================================================
   아기 퍼즐  (웹앱 · Capacitor로 안드/iOS 포팅)
   - 3살 아이용: 큰 조각, 관대한 스냅, 실패 없음, 큰 리액션
   - 하루 무료 10회, 초과 시 부모 게이트 결제
   ========================================================= */
(function(){
'use strict';

/* ---------- 설정 ---------- */
// 사진 카테고리는 photos.json에서 로드(build-photos.py가 생성). 로드 실패 시 아래 fallback.
const FALLBACK_CATS = [{ key:'animals', name:'동물', emoji:'🐾',
  photos: Array.from({length:15},(_,i)=>`photos/animals/trip-${String(i+1).padStart(2,'0')}.jpg`) }];
let CATS = FALLBACK_CATS;
const FREE_PER_DAY = 10;
// 난이도: [cols, rows] — 4:3 사진이라 조각이 정사각형에 가깝게. 4~24조각.
// s3/s2 = 별3개/별2개를 받는 완료시간(초) 상한. 난이도(조각수)별로 차등.
// ghost=보드에 그림을 옅게 비쳐 "그림 위에 얹기" 힌트(어린 아이용). notime=타이머/별압박 제거(최하 난이도).
// ⚠️ 나이 커버: 만 2~3세는 '아기'(4조각·그림힌트·타이머없음)가 바닥, 만 5~6세는 '도전'(24조각·빈보드).
//   부모가 난이도만 고르면 힌트/압박이 자동으로 나이에 맞춰짐 — 별도 설정 불필요.
const LEVELS = [
  {key:'4',  cols:2, rows:2, label:'아기',  s3:9999,s2:9999, ghost:true, notime:true},
  {key:'6',  cols:3, rows:2, label:'쉬움',  s3:30,  s2:60,   ghost:true},
  {key:'12', cols:4, rows:3, label:'보통',  s3:75,  s2:150},
  {key:'20', cols:5, rows:4, label:'어려움', s3:150, s2:300},
  {key:'24', cols:6, rows:4, label:'도전',  s3:200, s2:400},
];
function calcStars(level, sec){ return sec<=level.s3 ? 3 : (sec<=level.s2 ? 2 : 1); }
const PLANS = {
  day:   {days:1,   name:'하루권', price:'₩500'},
  month: {days:30,  name:'한달권', price:'₩10,000'},
  year:  {days:365, name:'일년권', price:'₩30,000'},
};
const SNAP_RATIO = 0.42;   // 셀 크기 대비 스냅 허용 거리 (3살용으로 관대하게)

/* ---------- 저장소 ---------- */
const LS = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v===null?d:JSON.parse(v);}catch(e){return d;} },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} },
};
function todayKey(){ const d=new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function playsUsedToday(){ const r=LS.get('bp_plays',{d:'',n:0}); return r.d===todayKey()?r.n:0; }
function playsLeft(){ return Math.max(0, FREE_PER_DAY - playsUsedToday()); }
function usePlay(){ const t=todayKey(); const r=LS.get('bp_plays',{d:'',n:0});
  LS.set('bp_plays', r.d===t?{d:t,n:r.n+1}:{d:t,n:1}); }
function isPremium(){ const u=LS.get('bp_premium_until',0); return u>Date.now(); }
function grantPremium(days){
  const base=Math.max(Date.now(), LS.get('bp_premium_until',0));
  LS.set('bp_premium_until', base + days*86400000);
}
function canPlay(){ return isPremium() || playsLeft()>0; }

/* ---------- 사운드 (파일 없이 WebAudio 생성) ---------- */
const Sound = (function(){
  let ctx=null, on=LS.get('bp_sound',true);
  function ac(){ if(!ctx){ try{ ctx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return ctx; }
  function tone(freq,dur,type,vol,when){
    if(!on) return; const c=ac(); if(!c) return;
    const t=c.currentTime+(when||0);
    const o=c.createOscillator(), g=c.createGain();
    o.type=type||'sine'; o.frequency.value=freq;
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(vol||0.2, t+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+dur+0.02);
  }
  return {
    setOn(v){ on=v; LS.set('bp_sound',v); },
    isOn(){ return on; },
    resume(){ const c=ac(); if(c&&c.state==='suspended') c.resume(); },
    pick(){ tone(520,0.08,'sine',0.15); },              // 조각 집기
    snap(){ tone(660,0.10,'triangle',0.25); tone(990,0.10,'sine',0.15,0.05); }, // 착 붙음
    win(){ [523,659,784,1046].forEach((f,i)=>tone(f,0.35,'triangle',0.28,i*0.13)); }, // 팡파레
    tap(){ tone(700,0.05,'square',0.12); },
  };
})();

/* ---------- DOM ---------- */
const $=s=>document.querySelector(s);
const screens={ home:$('#home'), game:$('#game'), win:$('#win') };
function show(name){
  Object.values(screens).forEach(s=>s.classList.add('hidden'));
  const el=screens[name]; el.classList.remove('hidden');
  el.classList.remove('screen-anim'); void el.offsetWidth; el.classList.add('screen-anim'); // 전환 페이드 재생
}

/* ---------- 상태 ---------- */
let currentLevelIdx = LS.get('bp_level',0);
let currentCatIdx = 0;
let currentSrc = '';   // 현재 퍼즐 사진 경로 (best 기록 키로도 사용)

/* ---------- 타이머 ---------- */
let gameStart=0, timerInt=null;
function startTimer(){
  gameStart=Date.now(); clearInterval(timerInt);
  // '아기' 난이도는 타이머/별 압박 없음 — 두돌 아기에겐 스톱워치·랭킹이 무의미하고 부담만.
  const noTime=LEVELS[currentLevelIdx] && LEVELS[currentLevelIdx].notime;
  const el=$('#game-timer'); if(el) el.style.display=noTime?'none':'';
  if(noTime){ return; }
  timerInt=setInterval(updateTimer,500); updateTimer();
}
function stopTimer(){ clearInterval(timerInt); timerInt=null; }
function elapsedSec(){ return (Date.now()-gameStart)/1000; }
function fmtTime(s){ s=Math.floor(s); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function updateTimer(){ const el=$('#game-timer'); if(el) el.textContent='⏱ '+fmtTime(elapsedSec()); }

/* ---------- 최고기록 ---------- */
function bestKey(pi,lvkey){ return pi+'_'+lvkey; }
function getBest(pi,lvkey){ return (LS.get('bp_best',{}))[bestKey(pi,lvkey)]||null; }
function saveBest(pi,lvkey,stars,sec){
  const all=LS.get('bp_best',{}); const id=bestKey(pi,lvkey); const cur=all[id];
  const isNew = !cur || stars>cur.stars || (stars===cur.stars && sec<cur.sec);
  if(isNew) all[id]={stars, sec:Math.round(sec)};
  LS.set('bp_best',all);
  return isNew;
}

/* =========================================================
   홈 화면
   ========================================================= */
// 이 사진의 전체 난이도 통틀어 최고 별(홈 카드 뱃지용)
function bestAnyLevel(pi){
  const all=LS.get('bp_best',{}); let mx=0;
  LEVELS.forEach(lv=>{ const r=all[bestKey(pi,lv.key)]; if(r&&r.stars>mx) mx=r.stars; });
  return mx;
}

function renderHome(){
  $('#plays-left').textContent = isPremium() ? '∞' : playsLeft();
  // 카테고리 탭 (가로 레일)
  if(currentCatIdx>=CATS.length) currentCatIdx=0;
  const tabs=$('#category-bar'); tabs.innerHTML='';
  CATS.forEach((cat,idx)=>{
    const t=document.createElement('button');
    t.className='cat-tab'+(idx===currentCatIdx?' active':'');
    t.innerHTML=`<span class="cat-emoji">${cat.emoji}</span><span class="cat-name">${cat.name}</span>`;
    t.onclick=()=>{ Sound.tap(); currentCatIdx=idx; LS.set('bp_cat',idx); renderHome();
      requestAnimationFrame(()=>{ const a=tabs.querySelector('.cat-tab.active');
        if(a) a.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'}); }); };
    tabs.appendChild(t);
  });
  // 선택 카테고리 사진 카드 (큰 카드 + 스켈레톤 + 순차 등장)
  const grid=$('#photo-grid'); grid.innerHTML=''; grid.scrollTop=0;
  (CATS[currentCatIdx].photos||[]).forEach((src,i)=>{
    const card=document.createElement('div'); card.className='photo-card';
    card.style.animationDelay=(Math.min(i,14)*0.045)+'s';
    const img=document.createElement('img'); img.alt=''; img.loading='lazy';
    const reveal=()=>card.classList.add('loaded');
    img.onload=reveal; img.onerror=reveal;
    img.src=src;
    if(img.complete && img.naturalWidth) reveal();
    const ov=document.createElement('div'); ov.className='play-ico'; ov.textContent='▶️';
    card.appendChild(img); card.appendChild(ov);
    const stars=bestAnyLevel(src);            // 이 사진 최고 별(난이도 무관)
    if(stars){ const badge=document.createElement('div'); badge.className='best-badge';
      badge.textContent='⭐'.repeat(stars); card.appendChild(badge); }
    card.onclick=()=>startGameRequest(src);
    grid.appendChild(card);
  });
}

/* 가로모드 고정: 모바일에선 전체화면+방향잠금 시도. 안 되면 세로 회전 안내가 fallback.
   (Capacitor 네이티브 앱은 매니페스트/plist로 확실히 고정 — README 참고) */
let lockedOnce=false;
function lockLandscape(){
  try{
    const isMobile=/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const lock=()=>{ if(screen.orientation&&screen.orientation.lock) screen.orientation.lock('landscape').catch(()=>{}); };
    if(isMobile && !lockedOnce && document.documentElement.requestFullscreen){
      lockedOnce=true;
      document.documentElement.requestFullscreen().then(lock).catch(lock);
    } else { lock(); }
  }catch(e){}
}

function startGameRequest(src){
  Sound.resume();
  lockLandscape();
  if(!canPlay()){ openPaywall(); return; }
  currentSrc=src;
  showPreview(src);          // 미리보기에서 난이도 고르고 → 시작
}

/* 난이도 메타(색·표기) — 쉬움→도전 */
const DIFF_META=[
  {word:'아기',   color:'var(--d0)'},
  {word:'쉬움',   color:'var(--d1)'},
  {word:'보통',   color:'var(--d2)'},
  {word:'어려움', color:'var(--d3)'},
  {word:'도전',   color:'var(--d4)'},
];
function renderDiffPicker(){
  const pick=$('#diff-picker'); pick.innerHTML='';
  LEVELS.forEach((lv,idx)=>{
    const meta=DIFF_META[idx]||DIFF_META[0];
    const b=document.createElement('button');
    b.className='diff-btn'+(idx===currentLevelIdx?' active':'');
    b.style.setProperty('--pick-color', meta.color);
    const ico=document.createElement('div'); ico.className='grid-ico';
    ico.style.gridTemplateColumns=`repeat(${lv.cols},1fr)`;
    for(let i=0;i<lv.cols*lv.rows;i++) ico.appendChild(document.createElement('i'));
    const word=document.createElement('div'); word.className='diff-word'; word.textContent=meta.word;
    const sub=document.createElement('div');  sub.className='diff-sub';   sub.textContent=lv.key+'조각';
    b.appendChild(ico); b.appendChild(word); b.appendChild(sub);
    b.onclick=()=>{ Sound.tap(); currentLevelIdx=idx; LS.set('bp_level',idx); renderDiffPicker(); };
    pick.appendChild(b);
  });
}

/* 미리보기: "이 그림으로 놀자" 원본 보여주고 + 난이도 선택 → 시작하면 스크램블.
   플레이 차감은 실제 시작할 때만(뒤로 나가면 차감 안 됨). */
function showPreview(src){
  const ov=$('#preview'), img=$('#preview-img');
  img.src=src;
  renderDiffPicker();
  ov.classList.remove('hidden');
  let done=false;
  function start(){ if(done) return; done=true;
    if(!isPremium()) usePlay();
    ov.classList.add('hidden');
    show('game');
    buildPuzzle(src, LEVELS[currentLevelIdx]);
  }
  function back(){ if(done) return; done=true; ov.classList.add('hidden'); renderHome(); }
  $('#preview-start').onclick=()=>{ Sound.tap(); start(); };
  $('#preview-back').onclick =()=>{ Sound.tap(); back(); };
}

/* =========================================================
   직소 퍼즐 생성
   ========================================================= */
let pieces=[];
let boardRect={};
function buildPuzzle(src, level){
  const area=$('#play-area');
  // 기존 조각 제거
  area.querySelectorAll('.piece').forEach(p=>p.remove());
  pieces=[]; clearHintTimer();
  $('#game-progress').textContent='';

  const img=new Image();
  img.onload=()=>layoutPuzzle(img, level);
  img.onerror=()=>{ $('#game-progress').textContent='사진을 불러오지 못했어요'; };
  img.src=src;
}

function layoutPuzzle(img, level){
  const area=$('#play-area');
  const boardEl=$('#board');
  const cols=level.cols, rows=level.rows;

  const areaW=area.clientWidth, areaH=area.clientHeight;
  // 사진 비율이 제각각(세로/가로)이라 보드를 사진에 맞추면 조각이 길쭉해지고 기기마다 달라짐.
  // → 보드를 항상 4:3으로 고정하고, 사진은 4:3으로 cover-crop(비율유지·중앙크롭)해서 그림.
  //   그리드·미리보기(둘 다 object-fit:cover 4:3)와 프레이밍이 일치하고 조각도 정사각형에 가까움.
  const BOARD_ASPECT=4/3;

  // 보드는 화면 왼쪽에, 오른쪽은 조각 트레이
  const boardMaxW=areaW*0.56, boardMaxH=areaH*0.86;
  let boardW,boardH;
  if(boardMaxW/boardMaxH > BOARD_ASPECT){ boardH=boardMaxH; boardW=boardH*BOARD_ASPECT; }
  else { boardW=boardMaxW; boardH=boardW/BOARD_ASPECT; }
  const boardLeft=Math.max(16, areaW*0.03);
  const boardTop=(areaH-boardH)/2;
  boardRect={left:boardLeft, top:boardTop, w:boardW, h:boardH};

  Object.assign(boardEl.style,{ left:boardLeft+'px', top:boardTop+'px', width:boardW+'px', height:boardH+'px' });

  const cellW=boardW/cols, cellH=boardH/rows;
  // 보드 격자선(어디 놓을지 감만 주는 옅은 선).
  boardEl.style.backgroundColor='#fff6fb';
  boardEl.style.backgroundImage=
    'linear-gradient(to right, rgba(224,143,180,.20) 1px, transparent 1px),'+
    'linear-gradient(to bottom, rgba(224,143,180,.20) 1px, transparent 1px)';
  boardEl.style.backgroundSize=`${cellW}px ${cellH}px`;
  boardEl.style.backgroundPosition='0 0';
  // 그림 힌트(고스트): 쉬운 난이도(만 2~4세)에선 정답 그림을 옅게 비쳐 "그림 위에 얹기"를 돕는다.
  //   어려운 난이도(만 5~6세 도전)는 빈 보드 유지 → 기억·공간추론 훈련. 난이도가 곧 나이별 스캐폴딩.
  let ghost=boardEl.querySelector('.board-ghost');
  if(level.ghost){
    if(!ghost){ ghost=document.createElement('img'); ghost.className='board-ghost'; ghost.alt=''; boardEl.appendChild(ghost); }
    ghost.src=img.src;
  } else if(ghost){ ghost.remove(); }
  const tab=Math.min(cellW,cellH)*0.24;             // knob 크기 = canvas 패딩
  const dpr=Math.min(window.devicePixelRatio||1, 2);

  // 엣지 부호(±1) 생성: 인접 조각과 상보
  const hSign=[], vSign=[];
  for(let r=0;r<rows-1;r++){ hSign[r]=[]; for(let c=0;c<cols;c++) hSign[r][c]=Math.random()<0.5?-1:1; }
  for(let r=0;r<rows;r++){ vSign[r]=[]; for(let c=0;c<cols-1;c++) vSign[r][c]=Math.random()<0.5?-1:1; }

  // 트레이(오른쪽) 흩뿌림 위치 준비
  const trayLeft=boardLeft+boardW+Math.max(20,areaW*0.02);
  const trayW=Math.max(60, areaW-trayLeft-16);
  const pieceCanvasW=cellW+2*tab, pieceCanvasH=cellH+2*tab;
  const scatter=makeScatter(cols*rows, trayLeft, boardTop, trayW, boardH, pieceCanvasW, pieceCanvasH, areaH);

  let sIdx=0;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const edges={
        top:    r===0        ? 0 : -hSign[r-1][c],
        right:  c===cols-1   ? 0 :  vSign[r][c],
        bottom: r===rows-1   ? 0 :  hSign[r][c],
        left:   c===0        ? 0 : -vSign[r][c-1],
      };
      const cv=document.createElement('canvas');
      cv.className='piece';
      cv.width=Math.round(pieceCanvasW*dpr);
      cv.height=Math.round(pieceCanvasH*dpr);
      cv.style.width=pieceCanvasW+'px';
      cv.style.height=pieceCanvasH+'px';
      const g=cv.getContext('2d');
      g.scale(dpr,dpr);
      drawPiece(g, img, boardW, boardH, cellW, cellH, tab, c, r, edges);

      // 정답 위치(보드 기준, 조각 canvas 좌상단 = 셀좌상단 - tab)
      const homeX=boardLeft + c*cellW - tab;
      const homeY=boardTop  + r*cellH - tab;

      const p={el:cv, homeX, homeY, w:pieceCanvasW, h:pieceCanvasH, locked:false};
      pieces.push(p);

      // 시작 위치: 트레이에 흩뿌림
      const pos=scatter[sIdx++];
      cv.style.left=pos.x+'px'; cv.style.top=pos.y+'px';
      cv.style.zIndex=10+sIdx;

      attachDrag(p);
      area.appendChild(cv);
    }
  }
  updateProgress();
  startTimer();
  scheduleHint();   // 한동안 진전 없으면 힌트
}

/* 트레이 흩뿌림 위치 생성 (겹침 최소화하는 지터 그리드) */
function makeScatter(n, x0, y0, w, h, pw, ph, areaH){
  const cols=Math.max(1, Math.floor(w/(pw*0.62)));
  const rows=Math.ceil(n/cols);
  const cellW=w/cols, cellH=Math.min(h/rows, (areaH-y0-10)/rows);
  const list=[];
  for(let i=0;i<n;i++){
    const cx=i%cols, cy=Math.floor(i/cols);
    const jx=(Math.random()-0.5)*Math.max(0,cellW-pw)*0.8;
    const jy=(Math.random()-0.5)*Math.max(0,cellH-ph)*0.6;
    let x=x0+cx*cellW+(cellW-pw)/2+jx;
    let y=y0+cy*cellH+(cellH-ph)/2+jy;
    x=Math.max(x0-pw*0.15, Math.min(x, x0+w-pw*0.85));
    y=Math.max(4, Math.min(y, areaH-ph-4));
    list.push({x,y});
  }
  // 순서 섞기 (조각-트레이 대응이 뻔하지 않게)
  for(let i=list.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
  return list;
}

/* 한 조각을 캔버스에 렌더 (직소 path로 클립 + 전체 이미지 오프셋 그리기 + 외곽선) */
function drawPiece(g, img, boardW, boardH, cellW, cellH, tab, c, r, edges){
  g.clearRect(0,0,boardW+cellW,boardH+cellH);
  g.save();
  tracePiecePath(g, cellW, cellH, tab, edges);
  g.clip();
  // 사진을 보드 비율(=boardW/boardH)로 cover-crop: 비율 유지한 채 중앙 크롭 → 늘어남 없음.
  const targetA=boardW/boardH, iw=img.naturalWidth, ih=img.naturalHeight, ia=iw/ih;
  let sx,sy,sw,sh;
  if(ia>targetA){ sh=ih; sw=ih*targetA; sx=(iw-sw)/2; sy=0; }   // 사진이 더 넓음 → 좌우 크롭
  else         { sw=iw; sh=iw/targetA; sx=0; sy=(ih-sh)/2; }    // 사진이 더 높음 → 상하 크롭
  // 크롭된 소스영역을 보드 전체크기로 그리고, 이 셀이 (tab,tab)에 오도록 오프셋
  g.drawImage(img, sx,sy,sw,sh,
              tab - c*cellW, tab - r*cellH, boardW, boardH);
  g.restore();
  // 외곽선 (조각 구분)
  g.save();
  tracePiecePath(g, cellW, cellH, tab, edges);
  g.lineWidth=2; g.strokeStyle='rgba(255,255,255,.85)'; g.stroke();
  g.lineWidth=1; g.strokeStyle='rgba(120,70,100,.35)'; g.stroke();
  g.restore();
}

/* 직소 조각 외곽선 path.
   조각 로컬 좌표: 셀 좌상단=(tab,tab). 시계방향으로 top→right→bottom→left.
   각 엣지 sign: +1이면 바깥 볼록(수컷), -1이면 안쪽 오목(암컷), 0이면 직선(가장자리). */
function tracePiecePath(g, cellW, cellH, tab, edges){
  const TL={x:tab, y:tab}, TR={x:tab+cellW, y:tab}, BR={x:tab+cellW, y:tab+cellH}, BL={x:tab, y:tab+cellH};
  g.beginPath();
  g.moveTo(TL.x,TL.y);
  edge(g, TL, TR, edges.top,    tab);
  edge(g, TR, BR, edges.right,  tab);
  edge(g, BR, BL, edges.bottom, tab);
  edge(g, BL, TL, edges.left,   tab);
  g.closePath();
}

/* a→b 한 변을 그림. knob는 진행방향 기준 바깥 법선(n=(dy,-dx)) 방향으로 sign만큼 돌출. */
function edge(g, a, b, sign, tab){
  const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;      // 진행 단위벡터
  const nx=uy,     ny=-ux;         // 시계방향 경로에서 바깥을 향하는 법선
  // (t=진행비율 0..1, o=법선방향 오프셋(단위:tab))
  const P=(t,o)=>({ x:a.x+ux*(t*len)+nx*(o*tab*sign), y:a.y+uy*(t*len)+ny*(o*tab*sign) });
  if(sign===0){ g.lineTo(b.x,b.y); return; }
  let p;
  p=P(0.40,0.0); g.lineTo(p.x,p.y);                         // 목까지 직선
  const c1=P(0.34,0.35), c2=P(0.30,1.0), e1=P(0.50,1.0);    // 왼쪽 목→봉우리 (언더컷)
  g.bezierCurveTo(c1.x,c1.y, c2.x,c2.y, e1.x,e1.y);
  const c3=P(0.70,1.0), c4=P(0.66,0.35), e2=P(0.60,0.0);    // 봉우리→오른쪽 목
  g.bezierCurveTo(c3.x,c3.y, c4.x,c4.y, e2.x,e2.y);
  g.lineTo(b.x,b.y);                                        // 끝까지 직선
}

/* =========================================================
   드래그 & 스냅
   ========================================================= */
function attachDrag(p){
  const el=p.el;
  let startX,startY,origX,origY,dragging=false,pid=null;

  el.addEventListener('pointerdown',e=>{
    if(p.locked) return;
    dragging=true; pid=e.pointerId;
    el.setPointerCapture(pid);
    startX=e.clientX; startY=e.clientY;
    origX=parseFloat(el.style.left); origY=parseFloat(el.style.top);
    el.classList.add('dragging');
    el.style.zIndex=1000;
    bringHelp(el);
    scheduleHint();   // 아이가 만지는 중 → 힌트 타이머 리셋
    Sound.pick();
    e.preventDefault();
  });
  el.addEventListener('pointermove',e=>{
    if(!dragging) return;
    el.style.left=(origX+e.clientX-startX)+'px';
    el.style.top =(origY+e.clientY-startY)+'px';
  });
  function end(){
    if(!dragging) return; dragging=false;
    el.classList.remove('dragging');
    try{ el.releasePointerCapture(pid); }catch(e){}
    trySnap(p);
  }
  el.addEventListener('pointerup',end);
  el.addEventListener('pointercancel',end);
}
let helpZ=500;
function bringHelp(el){ el.style.zIndex=++helpZ; }

/* ---------- 안 막힘 넛지 (실패 없음 → 막히지도 않음) ----------
   아이가 한동안 조각을 못 맞추면(진전 없음) 조각 하나를 살짝 흔들고
   그 자리를 반짝여 "여기야" 하고 부드럽게 알려준다. 압박 없이 힌트만. */
let hintTimer=null;
function hintRing(){
  let r=$('#hint-ring');
  if(!r){ r=document.createElement('div'); r.id='hint-ring'; $('#play-area').appendChild(r); }
  return r;
}
function hideHint(){ const r=$('#hint-ring'); if(r) r.classList.remove('show'); }
function clearHintTimer(){ clearTimeout(hintTimer); hintTimer=null; hideHint(); }
function scheduleHint(delay){ clearTimeout(hintTimer); hideHint(); hintTimer=setTimeout(fireHint, delay||9000); }
function fireHint(){
  if(screens.game.classList.contains('hidden')) return;
  const rem=pieces.filter(p=>!p.locked);
  if(!rem.length) return;
  const p=rem[Math.floor(Math.random()*rem.length)];
  // 조각 부드럽게 흔들기
  try{ p.el.animate([
    {transform:'rotate(0)'},{transform:'rotate(-5deg)'},{transform:'rotate(5deg)'},
    {transform:'rotate(-4deg)'},{transform:'rotate(0)'}
  ],{duration:800,easing:'ease-in-out'}); }catch(e){}
  // 그 조각이 갈 자리(정답 셀)를 반짝
  const r=hintRing();
  Object.assign(r.style,{ left:p.homeX+'px', top:p.homeY+'px', width:p.w+'px', height:p.h+'px' });
  r.classList.remove('show'); void r.offsetWidth; r.classList.add('show');
  scheduleHint(13000);   // 계속 막히면 다시(간격 넉넉히)
}

function trySnap(p){
  const el=p.el;
  const x=parseFloat(el.style.left), y=parseFloat(el.style.top);
  const cellMin=Math.min(boardRect.w/ LEVELS[currentLevelIdx].cols, boardRect.h/LEVELS[currentLevelIdx].rows);
  const thresh=cellMin*SNAP_RATIO;
  const dist=Math.hypot(x-p.homeX, y-p.homeY);
  if(dist<=thresh){
    // 착 붙음
    el.style.left=p.homeX+'px'; el.style.top=p.homeY+'px';
    el.classList.add('locked');
    el.style.zIndex=5;                 // 완성된 조각은 아래로
    p.locked=true;
    Sound.snap();
    // 착! 붙는 손맛: 살짝 팝 + 황금빛 글로우 플래시
    el.animate([
      {transform:'scale(1.16)', filter:'drop-shadow(0 0 0 rgba(255,214,92,0))'},
      {transform:'scale(1.04)', filter:'drop-shadow(0 0 16px rgba(255,206,80,.95))', offset:.35},
      {transform:'scale(1)',    filter:'drop-shadow(0 0 0 rgba(255,214,92,0))'}
    ],{duration:440,easing:'ease-out'});
    updateProgress();
    if(pieces.every(q=>q.locked)){ clearHintTimer(); setTimeout(winGame, 350); }
    else scheduleHint();   // 한 조각 맞췄으니 힌트 타이머 리셋
  }
}

function updateProgress(){
  const done=pieces.filter(p=>p.locked).length;
  $('#game-progress').textContent=`${done} / ${pieces.length}`;
}

/* =========================================================
   완성
   ========================================================= */
function winGame(){
  stopTimer();
  const level=LEVELS[currentLevelIdx];
  const sec=elapsedSec();
  const stars=calcStars(level, sec);
  const isNew=saveBest(currentSrc, level.key, stars, sec);
  Sound.win();
  $('#win-photo').src=currentSrc;
  renderStars(stars);
  if(level.notime){
    // '아기' 난이도: 시간·기록 없이 칭찬만. 완주 자체가 성취.
    $('#win-time').textContent='';
    $('#win-record').textContent='🎉 잘했어요!';
  } else {
    $('#win-time').textContent='⏱ '+fmtTime(sec);
    const best=getBest(currentSrc, level.key);
    $('#win-record').textContent = isNew ? '🎉 신기록!' : `최고 ${'⭐'.repeat(best.stars)} · ${fmtTime(best.sec)}`;
  }
  spawnConfetti();
  show('win');
}
function renderStars(n){
  const box=$('#win-stars'); box.innerHTML='';
  for(let i=0;i<3;i++){
    const s=document.createElement('span');
    s.className='wstar'+(i<n?' on':'');
    s.textContent = i<n ? '⭐' : '☆';
    s.style.animationDelay=(0.15+i*0.18)+'s';
    box.appendChild(s);
  }
}
function spawnConfetti(){
  const box=$('#confetti'); box.innerHTML='';
  const colors=['#ff9ec4','#8fe3d0','#ffe08a','#c9b6ff','#ff7aa8'];
  for(let i=0;i<70;i++){
    const s=document.createElement('i');
    s.style.left=Math.random()*100+'%';
    s.style.background=colors[i%colors.length];
    s.style.animationDuration=(1.8+Math.random()*1.8)+'s';
    s.style.animationDelay=(Math.random()*0.6)+'s';
    s.style.width=s.style.height=(8+Math.random()*10)+'px';
    box.appendChild(s);
  }
  setTimeout(()=>{ box.innerHTML=''; }, 4200);
}

/* =========================================================
   결제 (부모 게이트)
   ========================================================= */
let gateSeq=[], gatePos=0;
function openPaywall(){
  const m=$('#paywall');
  $('#gate-step').classList.remove('hidden');
  $('#pay-step').classList.add('hidden');
  setupGate();
  m.classList.remove('hidden');
}
function setupGate(){
  // 랜덤 3자리 순서 입력 (아이 오결제 방지)
  gateSeq=[]; while(gateSeq.length<3){ const n=Math.floor(Math.random()*10);
    if(!gateSeq.includes(n)) gateSeq.push(n); }
  gatePos=0;
  $('#gate-target').textContent=gateSeq.join(' · ');
  $('#gate-progress').textContent='';
  const pad=$('#gate-pad'); pad.innerHTML='';
  for(let n=0;n<10;n++){
    const b=document.createElement('button'); b.textContent=n;
    b.onclick=()=>{
      Sound.tap();
      if(n===gateSeq[gatePos]){
        gatePos++; $('#gate-progress').textContent='●'.repeat(gatePos);
        if(gatePos>=gateSeq.length){ $('#gate-step').classList.add('hidden'); $('#pay-step').classList.remove('hidden'); }
      } else { gatePos=0; $('#gate-progress').textContent='';
        pad.animate([{transform:'translateX(-8px)'},{transform:'translateX(8px)'},{transform:'translateX(0)'}],{duration:200}); }
    };
    pad.appendChild(b);
  }
}
function purchase(planKey){
  const plan=PLANS[planKey]; if(!plan) return;
  // TODO: 실제 결제(Google Play Billing / StoreKit)는 네이티브 플러그인으로 교체.
  // 지금은 목업: 즉시 이용권 지급.
  grantPremium(plan.days);
  LS.set('bp_last_purchase',{plan:planKey, at:Date.now()});
  Sound.win();
  closePaywall();
  renderHome();
  alertToast(`${plan.name} 구매 완료! 이제 마음껏 놀 수 있어요 🎉`);
}
function closePaywall(){ $('#paywall').classList.add('hidden'); }

/* =========================================================
   설정 (부모용)
   ========================================================= */
function openSettings(){
  const st=$('#sound-toggle');
  st.setAttribute('aria-pressed', Sound.isOn());
  st.textContent=Sound.isOn()?'켜짐':'꺼짐';
  $('#premium-status').textContent = isPremium()
    ? '이용권 ('+new Date(LS.get('bp_premium_until',0)).toLocaleDateString()+'까지)'
    : `무료 · 오늘 ${playsLeft()}회 남음`;
  $('#reset-note').textContent = `무료 플레이는 매일 자정에 ${FREE_PER_DAY}회로 초기화됩니다`;
  $('#settings').classList.remove('hidden');
}

/* 간단 토스트 */
function alertToast(msg){
  let t=document.createElement('div');
  t.textContent=msg;
  Object.assign(t.style,{position:'fixed',left:'50%',bottom:'8%',transform:'translateX(-50%)',
    background:'#fff',color:'#5a4a52',fontWeight:'800',padding:'14px 22px',borderRadius:'999px',
    boxShadow:'0 8px 24px rgba(0,0,0,.25)',zIndex:2000,fontSize:'16px',maxWidth:'80%',textAlign:'center'});
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(()=>t.remove(),400); }, 2200);
}

/* =========================================================
   이벤트 바인딩
   ========================================================= */
$('#back-btn').onclick=()=>{ Sound.tap(); stopTimer(); clearHintTimer(); show('home'); renderHome(); };
$('#win-home').onclick=()=>{ Sound.tap(); show('home'); renderHome(); };
$('#win-again').onclick=()=>{ Sound.tap(); startGameRequest(currentSrc); };
$('#win-next').onclick=()=>{ Sound.tap();
  const list=CATS[currentCatIdx].photos||[];
  const i=list.indexOf(currentSrc);
  const n=list[(i+1)%list.length]||currentSrc;
  startGameRequest(n); };
$('#settings-btn').onclick=()=>{ Sound.resume(); openSettings(); };
$('#sound-toggle').onclick=()=>{ const nv=!Sound.isOn(); Sound.setOn(nv);
  const st=$('#sound-toggle'); st.setAttribute('aria-pressed',nv); st.textContent=nv?'켜짐':'꺼짐'; if(nv) Sound.tap(); };
$('#restore-btn').onclick=()=>{ // 목업 복원
  if(isPremium()) alertToast('이미 이용권이 있어요'); else alertToast('복원할 구매내역이 없어요'); };
document.querySelectorAll('[data-close-paywall]').forEach(b=>b.onclick=closePaywall);
document.querySelectorAll('[data-close-settings]').forEach(b=>b.onclick=()=>$('#settings').classList.add('hidden'));
document.querySelectorAll('.plan').forEach(b=>b.onclick=()=>purchase(b.dataset.plan));

// 게임 중 리사이즈/회전 시에만 퍼즐 재배치(재배치=진행중 조각 리셋됨).
// ⚠️ 모바일에서 조각 드래그하면 주소창이 접혔다 펴지며 resize가 터지는데,
//    그때마다 재배치하면 아이가 맞춘 조각이 전부 흩어짐("갑자기 새로고침된 것처럼" 보임).
//    → 주소창 높이변화(너비 그대로 + 높이만 조금)는 무시하고, 진짜 회전/창크기 변화만 반영.
let resizeTimer=null, lastW=window.innerWidth, lastH=window.innerHeight;
window.addEventListener('resize',()=>{
  const w=window.innerWidth, h=window.innerHeight;
  const dw=Math.abs(w-lastW), dh=Math.abs(h-lastH);
  lastW=w; lastH=h;
  if(screens.game.classList.contains('hidden')) return;
  if(dw<=40 && dh<200) return;   // 주소창 접힘/펴짐 등 사소한 변화 → 퍼즐 유지
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(currentSrc && !screens.game.classList.contains('hidden')) buildPuzzle(currentSrc, LEVELS[currentLevelIdx]);
  }, 300);
});

/* Capacitor 네이티브 앱이면 시작 시 가로 고정 */
try{ if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.ScreenOrientation){
  window.Capacitor.Plugins.ScreenOrientation.lock({orientation:'landscape'});
} }catch(e){}

/* 시작: 카테고리 매니페스트 로드 후 홈 렌더 (실패하면 fallback 카테고리 사용) */
async function loadCats(){
  try{
    const res=await fetch('photos.json',{cache:'no-store'});
    if(res.ok){ const j=await res.json(); if(j&&j.categories&&j.categories.length) CATS=j.categories; }
  }catch(e){ /* fallback 유지 */ }
  currentCatIdx=LS.get('bp_cat',0);
  renderHome();
}
loadCats();
show('home');

})();
