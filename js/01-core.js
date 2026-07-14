/* ============================================================
   STAGE READY — single-file practice tool
   ============================================================ */
'use strict';
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const uid = ()=> Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fmtTime=(s)=>{ if(!isFinite(s)||s<0)s=0; const m=Math.floor(s/60),sec=Math.floor(s%60); return m+':'+String(sec).padStart(2,'0'); };
const fmtDate=(t)=>{ const d=new Date(t); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); };
const escapeHtml=(s='')=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- IndexedDB ---------- */
const DB_NAME='stageReadyDB', DB_VER=1;
let _db=null;
function openDB(){
  return new Promise((res,rej)=>{
    if(_db) return res(_db);
    const r=indexedDB.open(DB_NAME,DB_VER);
    r.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('snippets')) db.createObjectStore('snippets',{keyPath:'id'});
      if(!db.objectStoreNames.contains('setlists')) db.createObjectStore('setlists',{keyPath:'id'});
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'key'});
    };
    r.onsuccess=()=>{ _db=r.result; res(_db); };
    r.onerror=()=>rej(r.error);
  });
}
function tx(store,mode='readonly'){ return openDB().then(db=>db.transaction(store,mode).objectStore(store)); }
function idbReq(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); }); }
const DB={
  async getAll(store){ return idbReq((await tx(store)).getAll()); },
  async get(store,key){ return idbReq((await tx(store)).get(key)); },
  async put(store,val){ return idbReq((await tx(store,'readwrite')).put(val)); },
  async del(store,key){ return idbReq((await tx(store,'readwrite')).delete(key)); },
  async clear(store){ return idbReq((await tx(store,'readwrite')).clear()); },
  async metaGet(key,def){ const r=await this.get('meta',key); return r?r.value:def; },
  async metaSet(key,value){ return this.put('meta',{key,value}); },
};

/* ---------- App state ---------- */
const state={
  snippets:[],         // array of snippet objects
  setlists:[],         // array of setlist objects (includes library)
  byId:{},             // snippet id -> snippet
  currentSetlistId:'library',
  search:'',
  activeTags:new Set(),
  sort:'custom',
  sortDir:1,           // 1 asc, -1 desc
  shuffleOrder:null,   // array of ids when shuffled
  navList:[],          // ordered ids = current prev/next context
  current:null,        // open snippet id
  theme:'dark',
};
const LIBRARY_ID='library';
const reindex=()=>{ state.byId={}; state.snippets.forEach(s=>state.byId[s.id]=s); };
const getLibrary=()=>state.setlists.find(s=>s.id===LIBRARY_ID);
const getSetlist=(id)=>state.setlists.find(s=>s.id===id);

/* ---------- Toast ---------- */
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2600); }

/* ---------- Modal ---------- */
const modalScrim=$('#modalScrim'), modalEl=$('#modal');
function openModal(html){ modalEl.innerHTML=html; modalScrim.classList.add('show'); ensureBackGuard(); }
function closeModal(){ modalScrim.classList.remove('show'); modalEl.innerHTML=''; releaseBackGuard(); }
modalScrim.addEventListener('click',e=>{ if(e.target===modalScrim) closeModal(); });
function confirmDialog(title,msg,okLabel='Delete',danger=true){
  return new Promise(res=>{
    openModal(`<div class="modal-head"><h3>${escapeHtml(title)}</h3></div>
    <div class="modal-body"><p class="muted">${escapeHtml(msg)}</p></div>
    <div class="modal-foot"><button class="btn ghost" id="_cancel">Cancel</button>
    <button class="btn ${danger?'danger':'accent'}" id="_ok">${escapeHtml(okLabel)}</button></div>`);
    $('#_cancel').onclick=()=>{closeModal();res(false);};
    $('#_ok').onclick=()=>{closeModal();res(true);};
  });
}

/* ---------- Theme ---------- */
async function applyTheme(t){
  state.theme=t;
  document.documentElement.setAttribute('data-theme',t);
  $('#iconMoon').classList.toggle('hidden',t==='light');
  $('#iconSun').classList.toggle('hidden',t==='dark');
  $('meta[name=theme-color]').setAttribute('content', t==='dark'?'#0f0e0d':'#efebe3');
  await DB.metaSet('theme',t);
  if(state.current) drawWaveform();
}
$('#themeBtn').addEventListener('click',()=>applyTheme(state.theme==='dark'?'light':'dark'));

/* ---------- Drawer ---------- */
const drawer=$('#drawer'), scrim=$('#scrim');
function openDrawer(){ drawer.classList.add('show'); scrim.classList.add('show'); ensureBackGuard(); }
function closeDrawer(){ drawer.classList.remove('show'); scrim.classList.remove('show'); releaseBackGuard(); }
$('#hamburgerBtn').addEventListener('click',openDrawer);
scrim.addEventListener('click',closeDrawer);

/* ---------- Android back button: close top UI layer instead of exiting ----------
   One history entry is kept PER open layer (modal / tool panel / drawer /
   snippet view). Each Back press consumes one entry and closes the topmost
   layer — so even several rapid presses stay inside the app until every
   layer is closed. syncBackGuard() is idempotent: it pushes or (one at a
   time, since traversals land asynchronously) pops entries until the
   history depth matches the number of open layers. */
let _pushedDepth=0, _pendingRelease=false;
const _modalOpen=()=>modalScrim.classList.contains('show');
const _toolOpen=()=>$('#tunerPanel').classList.contains('show')||$('#metroPanel').classList.contains('show');
const _drawerOpen=()=>drawer.classList.contains('show');
const _snipOpen=()=>{ const sv=$('#snippetView'); return sv.classList.contains('show') && !sv.classList.contains('mini'); };
const _layerDepth=()=>(_modalOpen()?1:0)+(_toolOpen()?1:0)+(_drawerOpen()?1:0)+(_snipOpen()?1:0);
function syncBackGuard(){
  if(_pendingRelease) return;                    // a back() is in flight — resync when it lands
  const want=_layerDepth();
  while(_pushedDepth<want){ _pushedDepth++; try{ history.pushState({sr:1},''); }catch(e){} }
  if(_pushedDepth>want){
    _pushedDepth--; _pendingRelease=true;
    try{ history.back(); }catch(e){ _pendingRelease=false; }
  }
}
const ensureBackGuard=syncBackGuard, releaseBackGuard=syncBackGuard;
window.addEventListener('popstate',()=>{
  if(_pendingRelease){ _pendingRelease=false; syncBackGuard(); return; }  // our own silent release landed
  if(_pushedDepth<=0) return;                    // at root: let the browser handle it
  _pushedDepth--;
  if(_modalOpen()) closeModal();
  else if(_toolOpen()) closeTools();
  else if(_drawerOpen()) closeDrawer();
  else if(_snipOpen()) setMini(true);
  // the close call runs syncBackGuard(); depth is already balanced → no-op
});

