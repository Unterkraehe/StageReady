/* ============================================================
   DRAWER / SETLISTS
   ============================================================ */
function renderDrawer(){
  const lib=getLibrary();
  $('#setlistList').innerHTML=`<div class="setlist-row ${state.currentSetlistId===LIBRARY_ID?'active':''}" data-id="${LIBRARY_ID}">
    <svg viewBox="0 0 24 24" style="width:20px;height:20px;color:var(--accent)"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    <span class="nm">Library</span><span class="ct">${lib.snippetIds.filter(id=>state.byId[id]).length}</span></div>`;
  const users=state.setlists.filter(s=>s.id!==LIBRARY_ID).sort((a,b)=>(a.order??1e9)-(b.order??1e9));
  $('#userSetlists').innerHTML = users.length? users.map(sl=>`
    <div class="setlist-row ${state.currentSetlistId===sl.id?'active':''}" data-id="${sl.id}">
      <span class="sl-handle" data-slhandle><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>
      <span class="nm">${escapeHtml(sl.name)}</span>
      <span class="ct">${sl.snippetIds.filter(id=>state.byId[id]).length}</span>
      <button class="icon-btn mini" data-edit="${sl.id}" style="width:30px;height:30px"><svg viewBox="0 0 24 24" style="width:17px;height:17px"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
    </div>`).join('') : `<p class="muted" style="padding:8px 10px;font-size:13px">No setlists yet. Tap + to build one.</p>`;
  enableSort($('#userSetlists'),'.setlist-row','[data-slhandle]',async(orderedIds)=>{
    for(let i=0;i<orderedIds.length;i++){ const sl=getSetlist(orderedIds[i]); if(sl && sl.order!==i){ sl.order=i; await DB.put('setlists',sl); } }
    state.setlists.sort((a,b)=>(a.id===LIBRARY_ID?-1:b.id===LIBRARY_ID?1:(a.order??1e9)-(b.order??1e9)));
  });

  $$('#setlistList .setlist-row, #userSetlists .setlist-row').forEach(row=>{
    row.addEventListener('click',e=>{
      if(e.target.closest('[data-edit]')) return;
      state.currentSetlistId=row.dataset.id; state.shuffleOrder=null; state.activeTags.clear();
      DB.metaSet('currentSetlist',row.dataset.id);
      renderDrawer(); renderLibrary(); closeDrawer();
    });
  });
  $$('[data-edit]').forEach(b=>b.addEventListener('click',()=>editSetlistModal(getSetlist(b.dataset.edit))));
}

function newSetlistModal(){
  openModal(`<div class="modal-head"><h3>New setlist</h3></div>
  <div class="modal-body"><div class="field"><label>Name</label><input type="text" id="slName" placeholder="e.g. Friday Gig" autofocus></div></div>
  <div class="modal-foot"><button class="btn ghost" id="_cancel">Cancel</button><button class="btn accent" id="_ok">Create</button></div>`);
  $('#_cancel').onclick=closeModal;
  $('#_ok').onclick=async()=>{
    const name=$('#slName').value.trim(); if(!name){toast('Enter a name');return;}
    const sl={id:uid(),name,snippetIds:[],order:state.setlists.length}; state.setlists.push(sl); await DB.put('setlists',sl);
    closeModal(); renderDrawer(); editSetlistModal(sl);
  };
}
$('#newSetlistBtn').addEventListener('click',newSetlistModal);

function editSetlistModal(sl){
  const inSet=new Set(sl.snippetIds);
  openModal(`
    <div class="modal-head"><h3>Edit setlist</h3></div>
    <div class="modal-body">
      <div class="field"><label>Name</label><input type="text" id="slName" value="${escapeHtml(sl.name)}"></div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn sm" id="_exp" style="flex:1"><svg viewBox="0 0 24 24"><path d="M12 21V9m0 0 4 4m-4-4-4 4M5 3h14"/></svg>Export</button>
        <button class="btn sm" id="_prn" style="flex:1"><svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5h-2M8 14h8v7H8z"/></svg>Print</button>
      </div>
      <label class="field" style="margin-bottom:6px"><span style="font-family:var(--font-display);text-transform:uppercase;font-size:12px;letter-spacing:.1em;color:var(--txt-3)">Snippets in setlist (drag to reorder)</span></label>
      <div id="slOrdered"></div>
      <label style="display:block;font-family:var(--font-display);text-transform:uppercase;font-size:12px;letter-spacing:.1em;color:var(--txt-3);margin:14px 0 6px">Add snippets</label>
      <input type="text" id="slSearch" class="field" placeholder="Search…" style="margin-bottom:8px">
      <div class="checklist" id="slChecklist"></div>
    </div>
    <div class="modal-foot">
      <button class="btn danger" id="_del" style="margin-right:auto">Delete</button>
      <button class="btn ghost" id="_cancel">Close</button>
      <button class="btn accent" id="_save">Save</button>
    </div>`);

  function renderOrdered(){
    const box=$('#slOrdered');
    const ids=sl.snippetIds.filter(id=>state.byId[id]);
    box.innerHTML = ids.length? ids.map(id=>`<div class="sl-edit-row" data-id="${id}">
      <span class="grip" data-handle><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg></span>
      <span class="nm">${escapeHtml(state.byId[id].name)}</span>
      <button class="icon-btn" data-rm="${id}" style="width:30px;height:30px"><svg viewBox="0 0 24 24" style="width:17px;height:17px"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>`).join('') : `<p class="muted" style="font-size:13px">None yet — add from below.</p>`;
    $$('[data-rm]',box).forEach(b=>b.onclick=()=>{ sl.snippetIds=sl.snippetIds.filter(x=>x!==b.dataset.rm); inSet.delete(b.dataset.rm); renderOrdered(); renderChecklist(); });
    enableSort(box,'.sl-edit-row','[data-handle]',(ids2)=>{ sl.snippetIds=ids2; });
  }
  function renderChecklist(){
    const q=$('#slSearch').value.trim().toLowerCase();
    const items=state.snippets.filter(s=>!q||s.name.toLowerCase().includes(q));
    $('#slChecklist').innerHTML=items.map(s=>`<div class="check-row ${inSet.has(s.id)?'on':''}" data-id="${s.id}">
      <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
      <span class="nm" style="flex:1;font-family:var(--font-display);font-size:16px">${escapeHtml(s.name)}</span></div>`).join('')
      || `<p class="muted" style="font-size:13px;padding:8px">No snippets.</p>`;
    $$('#slChecklist .check-row').forEach(row=>row.onclick=()=>{
      const id=row.dataset.id;
      if(inSet.has(id)){ inSet.delete(id); sl.snippetIds=sl.snippetIds.filter(x=>x!==id); }
      else{ inSet.add(id); sl.snippetIds.push(id); }
      row.classList.toggle('on'); renderOrdered();
    });
  }
  renderOrdered(); renderChecklist();
  $('#slSearch').oninput=renderChecklist;
  $('#_exp').onclick=async()=>{ sl.name=$('#slName').value.trim()||sl.name; await DB.put('setlists',sl); exportSetlist(sl); };
  $('#_prn').onclick=async()=>{ sl.name=$('#slName').value.trim()||sl.name; await DB.put('setlists',sl); printSetlist(sl); };
  $('#_cancel').onclick=async()=>{ await reloadData(); closeModal(); renderDrawer(); renderLibrary(); };
  $('#_save').onclick=async()=>{ sl.name=$('#slName').value.trim()||sl.name; await DB.put('setlists',sl); closeModal(); renderDrawer(); renderLibrary(); toast('Setlist saved'); };
  $('#_del').onclick=async()=>{
    if(await confirmDialog('Delete setlist?','This removes the setlist. Your snippets stay in the Library.')){
      await DB.del('setlists',sl.id); state.setlists=state.setlists.filter(s=>s.id!==sl.id);
      if(state.currentSetlistId===sl.id) state.currentSetlistId=LIBRARY_ID;
      closeModal(); renderDrawer(); renderLibrary();
    }
  };
}

/* ============================================================
   SNIPPET CREATE / EDIT (name + tags + audio)
   ============================================================ */
let _pendingAudio=null;
function snippetEditorModal(existing){
  const isNew=!existing;
  const s=existing||{name:'',tags:[]};
  let tags=[...(s.tags||[])];
  _pendingAudio=null;
  openModal(`
    <div class="modal-head"><h3>${isNew?'New snippet':'Edit snippet'}</h3></div>
    <div class="modal-body">
      <div class="field"><label>Name</label><input type="text" id="snName" value="${escapeHtml(s.name)}" placeholder="Song / section name"></div>
      ${isNew?`<div class="field"><label>Audio file</label>
        <button class="btn" id="pickAudio" style="width:100%"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span id="audioName">Choose audio…</span></button></div>`:''}
      <div class="field"><label>Tags</label>
        <input type="text" id="tagInput" placeholder="Type a tag, press Enter">
        <div class="tag-edit" id="tagEdit"></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" id="_cancel">Cancel</button><button class="btn accent" id="_ok">${isNew?'Create':'Save'}</button></div>`);
  const renderTags=()=>{ $('#tagEdit').innerHTML=tags.map((t,i)=>`<span class="tag-pill">${escapeHtml(t)}<button data-i="${i}">✕</button></span>`).join('');
    $$('#tagEdit button').forEach(b=>b.onclick=()=>{ tags.splice(+b.dataset.i,1); renderTags(); }); };
  renderTags();
  const commitTagInput=()=>{ const inp=$('#tagInput'); if(!inp) return;
    inp.value.split(',').map(v=>v.trim()).filter(Boolean).forEach(v=>{ if(!tags.includes(v)) tags.push(v); });
    if(inp.value.trim()) renderTags(); inp.value=''; };
  $('#tagInput').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===','){ e.preventDefault(); commitTagInput(); } });
  $('#tagInput').addEventListener('blur',commitTagInput);
  if(isNew){
    $('#pickAudio').onclick=()=>{ const inp=$('#audioFileInput'); inp.value=''; inp.onchange=()=>{ if(inp.files[0]){ _pendingAudio=inp.files[0]; $('#audioName').textContent=inp.files[0].name; if(!$('#snName').value) $('#snName').value=inp.files[0].name.replace(/\.[^.]+$/,''); } }; inp.click(); };
  }
  $('#_cancel').onclick=closeModal;
  $('#_ok').onclick=async()=>{
    commitTagInput();
    const name=$('#snName').value.trim();
    if(!name){toast('Enter a name');return;}
    if(isNew && !_pendingAudio){toast('Choose an audio file');return;}
    if(isNew){
      const snip={ id:uid(), name, audioFile:_pendingAudio, audioType:_pendingAudio.type||'audio/mpeg',
        tags, markers:[], notes:'', recordings:[], ratings:[], pitch:0, lastPlayed:null, createdAt:Date.now() };
      await addSnippet(snip);
      closeModal(); toast('Snippet added'); openSnippet(snip.id);
    } else {
      s.name=name; s.tags=tags; await DB.put('snippets',s);
      closeModal(); reindex(); renderLibrary(); if(state.current===s.id) $('#svName').textContent=name; toast('Saved');
    }
  };
}
async function addSnippet(snip){
  state.snippets.push(snip); reindex();
  const lib=getLibrary(); lib.snippetIds.push(snip.id); await DB.put('setlists',lib);
  if(state.currentSetlistId!==LIBRARY_ID){ const sl=getSetlist(state.currentSetlistId); sl.snippetIds.push(snip.id); await DB.put('setlists',sl); }
  await DB.put('snippets',snip);
  renderDrawer(); renderLibrary();
}
async function deleteSnippet(id){
  await DB.del('snippets',id);
  state.snippets=state.snippets.filter(s=>s.id!==id); reindex();
  state.setlists.forEach(sl=>{ const n=sl.snippetIds.length; sl.snippetIds=sl.snippetIds.filter(x=>x!==id); if(sl.snippetIds.length!==n) DB.put('setlists',sl); });
  renderDrawer(); renderLibrary();
}
$('#fab').addEventListener('click',()=>snippetEditorModal(null));

