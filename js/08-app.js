/* ============================================================
   PWA — service worker + install
   ============================================================ */
if('serviceWorker' in navigator && (location.protocol==='https:'||location.protocol==='http:')){
  window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW registration failed:',e)); });
}
let _deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); _deferredPrompt=e; $('#installBtn').style.display='flex'; });
$('#installBtn').onclick=async()=>{
  if(!_deferredPrompt){ toast('Use your browser menu → Install / Add to Home Screen'); return; }
  _deferredPrompt.prompt();
  try{ await _deferredPrompt.userChoice; }catch(e){}
  _deferredPrompt=null; $('#installBtn').style.display='none';
};
window.addEventListener('appinstalled',()=>{ $('#installBtn').style.display='none'; toast('App installed'); });

/* ============================================================
   SWIPE GESTURES
   - Snippet view: pull down while scrolled to top → minimize
   - Tool panels: swipe up → close
   - Drawer: swipe left → close (follows the finger)
   - Modal sheet: drag header down → close (follows the finger)
   ============================================================ */
function onSwipe(el,opts){
  let sx=0,sy=0,dx=0,dy=0,active=false,engaged=false;
  el.addEventListener('touchstart',e=>{
    if(opts.canStart && !opts.canStart(e)){ active=false; return; }
    const t=e.touches[0]; sx=t.clientX; sy=t.clientY; dx=dy=0; active=true; engaged=false;
  },{passive:true});
  el.addEventListener('touchmove',e=>{
    if(!active) return;
    const t=e.touches[0]; dx=t.clientX-sx; dy=t.clientY-sy;
    if(!engaged){
      if(Math.abs(dx)<12 && Math.abs(dy)<12) return;
      if(!opts.engage(dx,dy,e)){ active=false; return; }   // wrong direction → hand back to browser
      engaged=true;
    }
    if(opts.onMove) opts.onMove(dx,dy);
  },{passive:true});
  const end=()=>{
    if(!active) return; active=false;
    if(engaged) opts.onEnd(dx,dy);
  };
  el.addEventListener('touchend',end,{passive:true});
  el.addEventListener('touchcancel',()=>{ if(active){ active=false; if(engaged&&opts.onCancel) opts.onCancel(); } },{passive:true});
}

/* 1) full snippet view: pull down at top → minimize */
onSwipe($('#snippetView'),{
  canStart:e=>{
    if(snippetView.classList.contains('mini')) return false;
    if(e.target.closest('.wave-stage,.loop-handle,input,textarea,audio,button')) return false;
    const sc=$('.sv-scroll'); return sc.scrollTop<=0;
  },
  engage:(dx,dy)=>dy>0 && dy>Math.abs(dx)*1.4 && $('.sv-scroll').scrollTop<=0,
  onEnd:(dx,dy)=>{ if(dy>90) setMini(true); }
});

/* 2) tool panels: swipe up → close (works from sliders too; a strongly
      vertical motion is required so horizontal slider drags never trigger) */
[['#tunerPanel'],['#metroPanel']].forEach(([sel])=>{
  onSwipe($(sel),{
    canStart:e=>!e.target.closest('button'),
    engage:(dx,dy)=>dy<0 && -dy>Math.abs(dx)*2,
    onEnd:(dx,dy)=>{ if(dy<-60) closeTools(); }
  });
});

/* 3) drawer: swipe left → close, following the finger */
onSwipe(drawer,{
  canStart:e=>drawer.classList.contains('show'),
  engage:(dx,dy)=>dx<0 && -dx>Math.abs(dy)*1.2,
  onMove:(dx)=>{ drawer.style.transition='none'; drawer.style.transform=`translateX(${Math.min(0,dx)}px)`; },
  onEnd:(dx)=>{
    drawer.style.transition=''; drawer.style.transform='';
    if(dx<-70) closeDrawer();
  },
  onCancel:()=>{ drawer.style.transition=''; drawer.style.transform=''; }
});

/* 4) modal sheet: drag the header/handle down → close, following the finger */
onSwipe(modalScrim,{
  canStart:e=>!!e.target.closest('.modal-head')||e.target===modalScrim,
  engage:(dx,dy)=>dy>0 && dy>Math.abs(dx)*1.2,
  onMove:(dx,dy)=>{ const m=$('.modal',modalScrim); if(m){ m.style.transition='none'; m.style.transform=`translateY(${Math.max(0,dy)}px)`; } },
  onEnd:(dx,dy)=>{
    const m=$('.modal',modalScrim);
    if(m){ m.style.transition=''; m.style.transform=''; }
    if(dy>80) closeModal();
  },
  onCancel:()=>{ const m=$('.modal',modalScrim); if(m){ m.style.transition=''; m.style.transform=''; } }
});

/* ============================================================
   INIT / BOOTSTRAP
   ============================================================ */
async function reloadData(){
  state.snippets=await DB.getAll('snippets');
  state.setlists=await DB.getAll('setlists');
  state.setlists.sort((a,b)=>(a.id===LIBRARY_ID?-1:b.id===LIBRARY_ID?1:(a.order??1e9)-(b.order??1e9)));
  // ensure library setlist exists & contains everything
  let lib=getLibrary();
  if(!lib){ lib={ id:LIBRARY_ID, name:'Library', snippetIds:state.snippets.map(s=>s.id) }; state.setlists.push(lib); await DB.put('setlists',lib); }
  else {
    let changed=false;
    state.snippets.forEach(s=>{ if(!lib.snippetIds.includes(s.id)){ lib.snippetIds.push(s.id); changed=true; } });
    lib.snippetIds=lib.snippetIds.filter(id=>state.snippets.some(s=>s.id===id));
    if(changed) await DB.put('setlists',lib);
  }
  reindex();
}

let _inited=false;
async function init(){
  if(_inited) return; _inited=true;
  await openDB();
  await reloadData();
  // theme
  const savedTheme=await DB.metaGet('theme','dark');
  state.autoLoud=await DB.metaGet('autoloud',true);
  await applyTheme(savedTheme);
  // current setlist
  const savedSet=await DB.metaGet('currentSetlist',LIBRARY_ID);
  state.currentSetlistId=getSetlist(savedSet)?savedSet:LIBRARY_ID;
  // initial UI
  $('#speedVal').textContent='1.00x';
  $('#bpmVal').textContent=metro.bpm;
  $('#beatsVal').textContent=metro.beats;
  renderSubdiv();
  renderBeatLights(-1);
  renderDrawer();
  renderLibrary();
}

window.addEventListener('DOMContentLoaded',init);
if(document.readyState!=='loading'){ init(); }
