/* ============================================================
   LIBRARY + FILTER + SORT
   ============================================================ */
const lastRating=s=> s.ratings&&s.ratings.length? s.ratings[s.ratings.length-1] : null;

function currentSetlistSnippetIds(){
  const sl=getSetlist(state.currentSetlistId)||getLibrary();
  return sl.snippetIds.filter(id=>state.byId[id]);
}
function visibleSnippets(){
  const setIds=currentSetlistSnippetIds();
  let arr=setIds.map(id=>state.byId[id]).filter(Boolean);
  // search
  const q=state.search.trim().toLowerCase();
  if(q) arr=arr.filter(s=> s.name.toLowerCase().includes(q) || (s.tags||[]).some(t=>t.toLowerCase().includes(q)) || (s.notes||'').toLowerCase().includes(q));
  // tags (AND)
  if(state.activeTags.size) arr=arr.filter(s=> [...state.activeTags].every(t=>(s.tags||[]).includes(t)));
  // sort
  if(state.shuffleOrder){
    const rank={}; state.shuffleOrder.forEach((id,i)=>rank[id]=i);
    arr.sort((a,b)=>(rank[a.id]??1e9)-(rank[b.id]??1e9));
  } else if(state.sort==='custom'){
    const rank={}; setIds.forEach((id,i)=>rank[id]=i);
    arr.sort((a,b)=>(rank[a.id]-rank[b.id])*state.sortDir);
  } else if(state.sort==='alpha'){
    arr.sort((a,b)=>a.name.localeCompare(b.name)*state.sortDir);
  } else if(state.sort==='played'){
    arr.sort((a,b)=>((a.lastPlayed||0)-(b.lastPlayed||0))*state.sortDir);
  } else if(state.sort==='rating'){
    const sc=s=>{const r=lastRating(s);return r?r.score:-1;};
    arr.sort((a,b)=>(sc(a)-sc(b))*state.sortDir);
  }
  return arr;
}

function renderTagFilter(){
  const bar=$('#tagFilterBar');
  const tagSet=new Set();
  currentSetlistSnippetIds().forEach(id=>{ (state.byId[id].tags||[]).forEach(t=>tagSet.add(t)); });
  const tags=[...tagSet].sort();
  // prune active tags no longer present
  [...state.activeTags].forEach(t=>{ if(!tagSet.has(t)) state.activeTags.delete(t); });
  bar.innerHTML=tags.map(t=>`<button class="chip ${state.activeTags.has(t)?'on':''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
  $$('.chip',bar).forEach(c=>c.onclick=()=>{ const t=c.dataset.tag; state.activeTags.has(t)?state.activeTags.delete(t):state.activeTags.add(t); state.shuffleOrder=null; renderLibrary(); });
}

function updateToolbarTitle(){
  const t=$('#toolbarTitle'); if(!t) return;
  if(state.currentSetlistId===LIBRARY_ID){ t.innerHTML='STAGE<b>READY</b>'; }
  else { const sl=getSetlist(state.currentSetlistId); t.textContent=(sl?sl.name:'Library'); }
}
function renderLibrary(){
  updateToolbarTitle();
  renderTagFilter();
  const list=$('#snippetList');
  const arr=visibleSnippets();
  state.navList=arr.map(s=>s.id);
  document.body.classList.toggle('show-handles', state.sort==='custom' && !state.shuffleOrder && !state.search && !state.activeTags.size);
  if(!arr.length){
    list.innerHTML=`<div class="empty">
      <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <h3>${state.snippets.length?'No matches':'No snippets yet'}</h3>
      <p>${state.snippets.length?'Try clearing search or tag filters.':'Hit the + button to add your first audio snippet and start practicing.'}</p></div>`;
    return;
  }
  list.innerHTML=arr.map(s=>{
    const r=lastRating(s);
    const tagsHtml=(s.tags||[]).slice(0,3).map(t=>`<span class="snip-tag">${escapeHtml(t)}</span>`).join('');
    const played=s.lastPlayed?('Played '+fmtDate(s.lastPlayed)):'Never played';
    return `<li class="snip-row" data-id="${s.id}">
      <span class="snip-handle" data-handle><svg viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg></span>
      <div class="snip-main">
        <div class="snip-name">${escapeHtml(s.name)}</div>
        <div class="snip-meta">${tagsHtml}<span class="snip-sub">${played}</span></div>
      </div>
      ${r?`<span class="snip-rating"><span class="num">${r.score}</span><svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg></span>`:''}
    </li>`;
  }).join('');
  $$('.snip-row',list).forEach(row=>{
    row.addEventListener('click',e=>{ if(e.target.closest('[data-handle]')) return; openSnippet(row.dataset.id); });
  });
  enableSort(list,'.snip-row','[data-handle]',(orderedIds)=>{
    const sl=getSetlist(state.currentSetlistId)||getLibrary();
    // rebuild snippetIds preserving items not currently visible
    const visibleSet=new Set(orderedIds);
    const others=sl.snippetIds.filter(id=>!visibleSet.has(id));
    sl.snippetIds=[...orderedIds, ...others];
    DB.put('setlists',sl);
    toast('Order saved');
  });
}

/* ---------- Pointer-based drag sort (touch friendly) ---------- */
function enableSort(container, rowSel, handleSel, onDone){
  let dragEl=null, placeholder=null, startY=0, offsetY=0, rows=[], pid=null;
  function onDown(e){
    const handle=e.target.closest(handleSel); if(!handle) return;
    const row=handle.closest(rowSel); if(!row) return;
    e.preventDefault();
    dragEl=row; pid=e.pointerId;
    const rect=row.getBoundingClientRect();
    offsetY=e.clientY-rect.top; startY=e.clientY;
    rows=$$(rowSel,container);
    placeholder=document.createElement(row.tagName);
    placeholder.style.height=rect.height+'px';
    placeholder.style.margin=getComputedStyle(row).margin;
    row.classList.add('dragging');
    row.style.position='fixed'; row.style.zIndex=999; row.style.width=rect.width+'px';
    row.style.left=rect.left+'px'; row.style.top=rect.top+'px'; row.style.pointerEvents='none';
    row.parentNode.insertBefore(placeholder,row.nextSibling);
    window.addEventListener('pointermove',onMove);
    window.addEventListener('pointerup',onUp);
  }
  function onMove(e){
    if(!dragEl) return;
    dragEl.style.top=(e.clientY-offsetY)+'px';
    const others=$$(rowSel,container).filter(r=>r!==dragEl);
    let placed=false;
    for(const r of others){
      const rc=r.getBoundingClientRect();
      if(e.clientY < rc.top+rc.height/2){ container.insertBefore(placeholder,r); placed=true; break; }
    }
    if(!placed) container.appendChild(placeholder);
  }
  function onUp(){
    if(!dragEl) return;
    container.insertBefore(dragEl,placeholder);
    placeholder.remove();
    dragEl.classList.remove('dragging');
    dragEl.style.cssText='';
    window.removeEventListener('pointermove',onMove);
    window.removeEventListener('pointerup',onUp);
    const ids=$$(rowSel,container).map(r=>r.dataset.id);
    dragEl=null;
    onDone(ids);
  }
  // attach once
  if(container._sortBound) container.removeEventListener('pointerdown',container._sortBound);
  container._sortBound=onDown;
  container.addEventListener('pointerdown',onDown);
}

/* ---------- Filter controls ---------- */
$('#searchInput').addEventListener('input',e=>{ state.search=e.target.value; state.shuffleOrder=null; renderLibrary(); });
$('#sortSelect').addEventListener('change',e=>{ state.sort=e.target.value; state.shuffleOrder=null; renderLibrary(); });
$('#sortDirBtn').addEventListener('click',()=>{ state.sortDir*=-1; $('#sortArrow').style.transform=state.sortDir<0?'rotate(180deg)':''; renderLibrary(); });
$('#shuffleBtn').addEventListener('click',()=>{
  const ids=visibleSnippets().map(s=>s.id);
  for(let i=ids.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}
  state.shuffleOrder=ids; renderLibrary(); toast('Shuffled');
});

