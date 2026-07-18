/* ============================================================
   GOOGLE DRIVE SYNC (js/09-sync.js)
   Offline-first library sync. IndexedDB stays the source of truth;
   sync reconciles it with a folder in the user's own Google Drive
   (drive.file scope: the app can only see files it created).

   Remote layout:  StageReady/ manifest.json
                               au_<snippetId>_r<rev>   (audio, immutable per rev)
                               rec_<recordingId>       (practice recordings)

   Merge: additive. Records are ADDED or UPDATED (newest-wins per
   record via updatedAt) — sync NEVER deletes. Drive keeps every file
   as an archive; a snippet removed on one device stays on Drive and on
   the other devices. Local tombstones (never uploaded) only stop the
   device that removed something from getting it back.

   Auth: OAuth2 token via full-page redirect (works in installed
   PWAs where popups don't). Tokens last ~1h.

   THIS FILE MUST STAY DOM-FREE AT TOP LEVEL: sw.js importScripts() it so
   the same engine can run as a background sync. Anything touching
   document/window/localStorage must be guarded or page-only.
   ============================================================ */

/* One-time setup (app owner): create an OAuth Client ID of type
   "Web application" at console.cloud.google.com → Credentials, add your
   site origin (e.g. https://username.github.io) under "Authorized
   JavaScript origins" AND the full app URL under "Authorized redirect
   URIs", enable the "Google Drive API", then paste the Client ID here.
   Full instructions: SYNC_SETUP.md */
const GDRIVE_CLIENT_ID = '824290905313-trfb5eb4ks7sccrli66p3kstdm47tcnp.apps.googleusercontent.com';   // e.g. '1234567890-abc123.apps.googleusercontent.com'

const SYNC={
  running:false, queued:false, status:'idle', detail:'',
  lastError:null, auto:true, clientId:GDRIVE_CLIENT_ID, timer:null,
};
const IS_PAGE = (typeof window!=='undefined' && typeof document!=='undefined');

/* ---------------- self-contained IndexedDB access ----------------
   09-sync runs in the page AND inside the service worker, which cannot
   load 01-core.js (DOM-bound). So it opens the same database itself. */
const SDB_NAME='stageReadyDB', SDB_VER=2;
let _sdb=null;
function sdbOpen(){
  return new Promise((res,rej)=>{
    if(_sdb) return res(_sdb);
    const r=indexedDB.open(SDB_NAME,SDB_VER);
    r.onupgradeneeded=e=>{
      const db=e.target.result;
      ['snippets','setlists','tombstones'].forEach(s=>{ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'}); });
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'key'});
    };
    r.onsuccess=()=>{ _sdb=r.result; res(_sdb); };
    r.onerror=()=>rej(r.error);
  });
}
function sdbReq(q){ return new Promise((res,rej)=>{ q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }
const SDB={
  async all(store){ const db=await sdbOpen(); return sdbReq(db.transaction(store).objectStore(store).getAll()); },
  async get(store,key){ const db=await sdbOpen(); return sdbReq(db.transaction(store).objectStore(store).get(key)); },
  async put(store,val){ const db=await sdbOpen(); return sdbReq(db.transaction(store,'readwrite').objectStore(store).put(val)); },
  async metaGet(k,d){ const r=await SDB.get('meta',k); return r&&r.value!==undefined?r.value:d; },
  async metaSet(k,v){ return SDB.put('meta',{key:k,value:v}); },
};

/* ---------------- token handling (redirect flow) ----------------
   Stored in IndexedDB (not localStorage) so the service worker can read it. */
let _tok=null;                                  // {t, exp}
async function syncLoadToken(){
  if(_tok) return _tok;
  _tok=await SDB.metaGet('gd_token',null);
  if(!_tok && IS_PAGE){                          // migrate pre-v14 localStorage token
    try{
      const o=JSON.parse(localStorage.getItem('sr_gd_token')||'null');
      if(o&&o.exp>Date.now()){ _tok=o; await SDB.metaSet('gd_token',o); }
      localStorage.removeItem('sr_gd_token');
    }catch(e){}
  }
  return _tok;
}
function syncToken(){ return (_tok && _tok.exp>Date.now())? _tok.t : null; }
function syncTokenExpiresIn(){ return _tok? _tok.exp-Date.now() : 0; }
async function syncStoreToken(t,exp){ _tok={t,exp}; await SDB.metaSet('gd_token',_tok); }
function syncSignedIn(){ return !!syncToken() || !!globalThis.__mockDriveStore; }
function syncParseRedirect(){
  if(!IS_PAGE || !location.hash || location.hash.indexOf('access_token=')<0) return;
  const p=new URLSearchParams(location.hash.slice(1));
  const tok=p.get('access_token'), exp=+p.get('expires_in')||3600, st=p.get('state')||'';
  history.replaceState(null,'',location.pathname+location.search);
  if(!tok) return;
  const saved=sessionStorage.getItem('sr_oauth_state');
  if(saved && st && saved!==st){ console.warn('OAuth state mismatch'); return; }
  sessionStorage.removeItem('sr_oauth_state');
  _tok={t:tok, exp:Date.now()+(exp-60)*1000};
  SDB.metaSet('gd_token',_tok);
  SYNC._resumeAfterAuth=true;
}
function syncAuthRedirect(){
  if(!IS_PAGE) return;
  if(!SYNC.clientId){ toast('Set up a Google Client ID first (see SYNC_SETUP.md)'); return; }
  const st=uid();
  sessionStorage.setItem('sr_oauth_state',st);
  const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id',SYNC.clientId);
  u.searchParams.set('redirect_uri',location.origin+location.pathname);
  u.searchParams.set('response_type','token');
  u.searchParams.set('scope','https://www.googleapis.com/auth/drive.file');
  u.searchParams.set('include_granted_scopes','true');
  u.searchParams.set('state',st);
  location.assign(u.toString());
}
async function syncSignOut(){
  const t=syncToken();
  _tok=null;
  await SDB.metaSet('gd_token',null);
  await SDB.metaSet('gd_email','');
  if(t){ try{ fetch('https://oauth2.googleapis.com/revoke?token='+encodeURIComponent(t),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}}); }catch(e){} }
  updateSyncUI();
}

/* retry transient failures; auth errors bubble out immediately */
async function syncRetry(fn,tries=3){
  let last;
  for(let i=0;i<tries;i++){
    try{ return await fn(); }
    catch(e){
      last=e;
      if(e.code===401) throw e;                       // only auth is fatal
      // 403 from Drive is normally a rate limit; back off and try again
      if(i<tries-1) await new Promise(r=>setTimeout(r,800*Math.pow(2,i)));
    }
  }
  throw last;
}

/* ---------------- Drive REST adapter ---------------- */
class DriveRemote{
  constructor(token){ this.token=token; this.folderId=null; this.files={}; }
  async _fetch(url,opts={}){
    opts.headers=Object.assign({Authorization:'Bearer '+this.token},opts.headers||{});
    const r=await fetch(url,opts);
    if(r.status===401){ const e=new Error('unauthorized'); e.code=401; throw e; }
    if(!r.ok){ const e=new Error('Drive error '+r.status); e.code=r.status; throw e; }
    return r;
  }
  async _folderUsable(id){
    try{
      const d=await(await this._fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`)).json();
      return !d.trashed;
    }catch(e){ if(e.code===404||e.code===403) return false; throw e; }
  }
  async init(){
    /* The folder id is remembered. Picking it fresh every run is what made
       uploads restart: if two StageReady folders ever exist (two devices'
       first sync racing, or a create whose response was lost), an unordered
       search can return a different one each launch — so half the library
       looks "missing" and gets re-uploaded, forever. */
    let fid=await SDB.metaGet('gd_folder','');
    if(fid && !(await this._folderUsable(fid))) fid='';
    if(!fid){
      const q=encodeURIComponent("name='StageReady' and mimeType='application/vnd.google-apps.folder' and trashed=false");
      const d=await(await this._fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime&fields=files(id,name,createdTime)`)).json();
      if(d.files && d.files.length){
        fid=d.files[0].id;                                    // oldest = canonical
        if(d.files.length>1) console.warn('Multiple StageReady folders found; using the oldest.');
      }else{
        const r=await this._fetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:'StageReady',mimeType:'application/vnd.google-apps.folder'})});
        fid=(await r.json()).id;
      }
      await SDB.metaSet('gd_folder',fid);
    }
    /* A falsy folder id would make the children query match nothing (so every
       file looks missing) AND upload into limbo — i.e. re-upload the whole
       library on every launch, forever. Fail loudly instead. */
    if(!fid) throw new Error('Drive folder unavailable');
    this.folderId=fid;
    await this.refreshList();
  }
  async refreshList(){
    this.files={};
    let pageToken='';
    do{
      const fq=encodeURIComponent(`'${this.folderId}' in parents and trashed=false`);
      const url=`https://www.googleapis.com/drive/v3/files?q=${fq}&pageSize=1000&fields=nextPageToken,files(id,name)`+(pageToken?`&pageToken=${pageToken}`:'');
      const res=await(await this._fetch(url)).json();
      (res.files||[]).forEach(f=>{ if(!(f.name in this.files)) this.files[f.name]=f.id; });
      pageToken=res.nextPageToken||'';
    }while(pageToken);
  }
  has(name){ return !!this.files[name]; }
  list(){ return Object.keys(this.files); }
  async readJSON(name){
    if(!this.has(name)) return null;
    const r=await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.files[name]}?alt=media`);
    return r.json();
  }
  async writeJSON(name,obj){
    return this.uploadBlob(name,new Blob([JSON.stringify(obj)],{type:'application/json'}),'application/json');
  }
  async uploadBlob(name,blob,mime){
    mime=mime||blob.type||'application/octet-stream';
    const id=this.files[name];
    /* Drive's multipart/media endpoints only accept files up to 5 MB — real
       practice audio is routinely bigger, and those uploads simply fail. Send
       anything sizeable through a resumable session instead, which also
       tolerates a flaky mobile connection (each chunk can be retried). */
    if(blob.size>4*1024*1024) return this._resumable(name,blob,mime,id);
    if(id){
      await this._fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
        {method:'PATCH',headers:{'Content-Type':mime},body:blob});
      return;
    }
    const meta={name,parents:[this.folderId]};
    const fd=new FormData();
    fd.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'}));
    fd.append('file',blob);
    const r=await this._fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',body:fd});
    this.files[name]=(await r.json()).id;
  }
  async _resumable(name,blob,mime,existingId){
    const start=existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
    const r=await this._fetch(start,{
      method: existingId?'PATCH':'POST',
      headers:{'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mime,'X-Upload-Content-Length':String(blob.size)},
      body: existingId? '{}' : JSON.stringify({name,parents:[this.folderId]}),
    });
    const session=r.headers.get('Location')||r.headers.get('location');
    if(!session) throw new Error('no upload session (CORS?)');
    const CHUNK=8*1024*1024;
    let off=0;
    while(off<blob.size){
      const end=Math.min(off+CHUNK,blob.size);
      const res=await fetch(session,{method:'PUT',
        headers:{Authorization:'Bearer '+this.token,'Content-Range':`bytes ${off}-${end-1}/${blob.size}`},
        body:blob.slice(off,end)});
      if(res.status===308){                       // chunk stored, Drive wants more
        const rg=res.headers.get('Range');
        off = rg? parseInt(rg.split('-')[1],10)+1 : end;
        continue;
      }
      if(res.status===401){ const e=new Error('unauthorized'); e.code=401; throw e; }
      if(!res.ok){ const e=new Error('Upload failed '+res.status); e.code=res.status; throw e; }
      const j=await res.json().catch(()=>({}));
      this.files[name]= j.id || existingId || this.files[name];
      return;
    }
  }
  async downloadBlob(name){
    if(!this.has(name)) return null;
    const r=await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.files[name]}?alt=media`);
    return r.blob();
  }
  async userEmail(){
    try{
      const r=await this._fetch('https://www.googleapis.com/drive/v3/about?fields=user');
      return (await r.json()).user.emailAddress||'';
    }catch(e){ return ''; }
  }
}

/* ---------------- Mock adapter (tests / development) ---------------- */
class MockRemote{
  constructor(store){ this.s=store; this.s.files=this.s.files||{}; }
  async init(){ if(this.s.failAuthOnce){ this.s.failAuthOnce=false; const e=new Error('unauthorized'); e.code=401; throw e; } }
  has(name){ return name in this.s.files; }
  list(){ return Object.keys(this.s.files); }
  async readJSON(name){ return this.has(name)? JSON.parse(this.s.files[name].data) : null; }
  async writeJSON(name,obj){ this.s.files[name]={mime:'application/json',data:JSON.stringify(obj)}; }
  async uploadBlob(name,blob,mime){
    const b64=await new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.readAsDataURL(blob); });
    this.s.files[name]={mime:mime||blob.type||'application/octet-stream',b64};
  }
  async downloadBlob(name){
    const f=this.s.files[name]; if(!f) return null;
    if(f.data!==undefined) return new Blob([f.data],{type:f.mime});
    const bin=atob(f.b64), arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:f.mime});
  }
  async userEmail(){ return 'mock@test'; }
}

/* ---------------- manifest (de)serialization ---------------- */
const audioName=s=>`au_${s.id}_r${s.audioRev||0}`;
function snipToManifest(s){
  return { id:s.id, name:s.name, tags:s.tags||[], markers:s.markers||[], notes:s.notes||'',
    pitch:s.pitch||0, gain:s.gain||0, loudness:(typeof s.loudness==='number'?s.loudness:null),
    ratings:s.ratings||[], lastPlayed:s.lastPlayed||null, updatedAt:s.updatedAt||1,
    audioRev:s.audioRev||0, audioType:s.audioType||'audio/mpeg',
    recordings:(s.recordings||[]).map(r=>({id:r.id,timestamp:r.timestamp,dur:r.dur||null,type:(r.blob&&r.blob.type)||r.type||'audio/webm'})) };
}
function setlistToManifest(sl){
  return { id:sl.id, name:sl.name, snippetIds:sl.snippetIds||[], order:sl.order,
    print:sl.print||null, updatedAt:sl.updatedAt||1 };
}

/* ---------------- the sync engine ---------------- */
function syncSetStatus(st,detail){ SYNC.status=st; SYNC.detail=detail||''; updateSyncUI(); }
async function runSync(manual){
  if(SYNC.running){ SYNC.queued=true; return; }
  if(typeof navigator!=='undefined' && navigator.onLine===false && !globalThis.__mockDriveStore){
    if(manual && typeof toast==='function') toast('You are offline');
    return;
  }
  await syncLoadToken();
  let remote;
  if(globalThis.__mockDriveStore) remote=new MockRemote(globalThis.__mockDriveStore);
  else{
    const tok=syncToken();
    if(!tok){ if(manual) syncAuthRedirect(); return; }
    remote=new DriveRemote(tok);
  }
  SYNC.running=true; SYNC.lastError=null;
  syncSetStatus('sync','Connecting…');
  try{
    await remote.init();
    syncSetStatus('sync','Reading remote…');
    const man=(await remote.readJSON('manifest.json'))||{v:1,snippets:[],setlists:[]};

    const locSnips=await SDB.all('snippets');
    const locSets=await SDB.all('setlists');
    const locTombs=await SDB.all('tombstones');

    /* ---- ADDITIVE MERGE: sync only ever ADDS or UPDATES ----
       Nothing is removed from Drive, and nothing is removed from any other
       device. Tombstones are LOCAL ONLY (never uploaded): they just stop a
       record the user removed on THIS device from being restored here. */
    const removedHere={}; locTombs.forEach(t=>removedHere[t.id]=t);

    const plan={ dlSnips:[], dlSets:[] };
    const finalSnips={}, finalSets={};
    (man.snippets||[]).forEach(r=>finalSnips[r.id]=r);
    (man.setlists||[]).forEach(r=>finalSets[r.id]=r);

    for(const s of locSnips){
      const r=finalSnips[s.id];
      if(r && (r.updatedAt||1)>(s.updatedAt||1)) plan.dlSnips.push(r);   // remote newer → pull
      else finalSnips[s.id]=s;                                            // local newer/new → push
    }
    for(const id in finalSnips){
      if(locSnips.some(s=>s.id===id)) continue;
      if(removedHere[id]) continue;              // removed here → keep on Drive, don't restore
      plan.dlSnips.push(finalSnips[id]);         // added on another device → add here
    }
    for(const sl of locSets){
      const r=finalSets[sl.id];
      if(r && (r.updatedAt||1)>(sl.updatedAt||1)) plan.dlSets.push(r);
      else finalSets[sl.id]=sl;
    }
    for(const id in finalSets){
      if(locSets.some(s=>s.id===id)) continue;
      if(removedHere[id]) continue;
      plan.dlSets.push(finalSets[id]);
    }

    const writeManifest=()=>remote.writeJSON('manifest.json',{
      v:1, updatedAt:Date.now(),
      snippets:Object.values(finalSnips).map(snipToManifest),
      setlists:Object.values(finalSets).map(setlistToManifest),
    });

    // ---- download remote-won snippets (records + blobs) ----
    let step=0, steps=plan.dlSnips.length;
    for(const r of plan.dlSnips){
      step++; syncSetStatus('sync',`Downloading ${step}/${steps}: ${r.name}`);
      const local=locSnips.find(s=>s.id===r.id);
      let audioFile=local&&local.audioFile, haveRev=local?(local.audioRev||0):-1;
      if(haveRev!==(r.audioRev||0) || !audioFile){
        const b=await syncRetry(()=>remote.downloadBlob(audioName(r)));
        if(!b) continue;                    // blob not on Drive yet: skip, retry next sync
        audioFile=b;
      }
      const recs=[];
      for(const rm of (r.recordings||[])){
        const have=local&&(local.recordings||[]).find(x=>x.id===rm.id);
        if(have&&have.blob) recs.push(have);
        else{
          const rb=await syncRetry(()=>remote.downloadBlob('rec_'+rm.id));
          if(rb) recs.push({id:rm.id,timestamp:rm.timestamp,dur:rm.dur,blob:rb});
        }
      }
      const rec=Object.assign({},r,{audioFile,recordings:recs});
      await SDB.put('snippets',rec);
      finalSnips[rec.id]=rec;
    }
    for(const r of plan.dlSets){ await SDB.put('setlists',r); finalSets[r.id]=r; }

    // ---- upload blobs Drive is missing ----
    const ups=[];
    for(const id in finalSnips){
      const s=finalSnips[id];
      if(!remote.has(audioName(s)) && s.audioFile) ups.push(['audio',s]);
      for(const rc of (s.recordings||[])){
        if(!remote.has('rec_'+rc.id) && rc.blob) ups.push(['rec',rc]);
      }
    }
    step=0; steps=ups.length;
    let done=0, failed=0, paused=false, lastFail='';
    for(const [kind,o] of ups){
      // a token dying mid-upload would 401 every remaining file; stop while
      // the progress so far is safely recorded instead
      if(!globalThis.__mockDriveStore && syncTokenExpiresIn()<60000){ paused=true; break; }
      step++;
      const label=kind==='audio'? o.name : 'recording';
      syncSetStatus('sync',`Uploading ${step}/${steps}: ${label}`);
      try{
        if(kind==='audio') await syncRetry(()=>remote.uploadBlob(audioName(o),o.audioFile,o.audioType));
        else await syncRetry(()=>remote.uploadBlob('rec_'+o.id,o.blob));
        done++;
        // checkpoint: makes partial progress durable, so an interrupted first
        // sync of a big library never starts over
        if(done%25===0) await writeManifest();
      }catch(e){
        if(e.code===401) throw e;
        failed++; lastFail=e.message||'error';  // skip this file, keep going
        console.warn('Sync: upload failed for',label,e);
      }
    }

    // ---- write merged manifest (union — no entry is ever dropped) ----
    syncSetStatus('sync','Finalizing…');
    await syncRetry(writeManifest);
    // Nothing on Drive is ever deleted: old audio revisions and files whose
    // snippet was removed on a device stay as an archive.

    // ---- refresh app (page only) ----
    if((plan.dlSnips.length||plan.dlSets.length) && typeof reloadData==='function'){
      await reloadData();
      if(typeof renderDrawer==='function') renderDrawer();
      if(typeof renderLibrary==='function') renderLibrary();
    }
    await SDB.metaSet('lastSync',Date.now());
    if(!globalThis.__mockDriveStore){
      const em=await SDB.metaGet('gd_email','');
      if(!em){ const e2=await remote.userEmail(); if(e2) await SDB.metaSet('gd_email',e2); }
    }
    if(paused) syncSetStatus('error','Sign-in expired — reconnect to finish');
    else if(failed) syncSetStatus('error',failed+' of '+steps+' uploads failed ('+lastFail+') — will retry');
    else syncSetStatus('ok','');
    syncNotifyClients();
  }catch(err){
    console.warn('sync failed:',err);
    SYNC.lastError=err;
    if(err.code===401){
      _tok=null; await SDB.metaSet('gd_token',null);
      syncSetStatus('error','Signed out — reconnect to sync');
      if(manual) syncAuthRedirect();
    } else syncSetStatus('error', err.message||'Sync failed');
    syncRegisterBG();                          // let the SW retry in the background
  }finally{
    SYNC.running=false;
    if(SYNC.queued){ SYNC.queued=false; setTimeout(()=>runSync(false),1500); }
  }
}

/* tell open pages to refresh after a background (service-worker) sync */
function syncNotifyClients(){
  if(IS_PAGE || typeof clients==='undefined') return;
  clients.matchAll({includeUncontrolled:true}).then(cs=>cs.forEach(c=>c.postMessage({sr:'synced'})));
}

/* ---------------- triggers ---------------- */
async function syncRegisterBG(){
  if(!IS_PAGE || !('serviceWorker' in navigator)) return;
  try{
    const reg=await navigator.serviceWorker.ready;
    if(reg.sync) await reg.sync.register('sr-sync');
  }catch(e){}
}
async function syncRegisterPeriodic(){
  if(!IS_PAGE || !('serviceWorker' in navigator)) return;
  try{
    const reg=await navigator.serviceWorker.ready;
    if(!reg.periodicSync) return;
    const st=await navigator.permissions.query({name:'periodic-background-sync'});
    if(st.state!=='granted') return;
    await reg.periodicSync.register('sr-periodic',{minInterval:12*60*60*1000});
  }catch(e){}
}
function syncQueue(store){
  if(store==='meta') return;
  if(!SYNC.auto || !syncSignedIn()) return;
  clearTimeout(SYNC.timer);
  SYNC.timer=setTimeout(()=>{ runSync(false); syncRegisterBG(); },8000);
}
if(IS_PAGE){
  document.addEventListener('visibilitychange',async()=>{
    if(document.visibilityState!=='visible' || !SYNC.auto || !syncSignedIn()) return;
    const last=await SDB.metaGet('lastSync',0);
    if(Date.now()-last>5*60*1000) runSync(false);
  });
}

/* ---------------- UI (page only) ---------------- */
function syncStatusText(){
  if(SYNC.status==='sync') return SYNC.detail||'Syncing…';
  if(SYNC.status==='error') return SYNC.detail||'Sync failed';
  return '';
}
async function renderSyncSection(container){
  await syncLoadToken();
  const signed=syncSignedIn();
  const email=signed? (globalThis.__mockDriveStore?'mock@test':await SDB.metaGet('gd_email','')) : '';
  const last=await SDB.metaGet('lastSync',0);
  const needsSetup=!SYNC.clientId && !globalThis.__mockDriveStore;
  container.innerHTML=`
    <div class="set-sec-label" style="margin-top:20px">Sync — Google Drive</div>
    ${needsSetup? `<p class="muted" style="font-size:12.5px;margin:4px 2px 10px">Not configured. The app owner must create a (free) Google OAuth Client ID and paste it into <b>js/09-sync.js</b> — see SYNC_SETUP.md.</p>`:''}
    <div id="_syncStatus" class="muted" style="font-size:13px;margin:2px 2px 10px">
      ${signed? `Connected${email?' as <b>'+escapeHtml(email)+'</b>':''}${last?' · last sync '+new Date(last).toLocaleTimeString():''}` : 'Not connected. Your library stays on this device.'}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${signed? `<button class="btn accent" id="_syncNow" style="flex:1"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>Sync now</button>
                 <button class="btn ghost" id="_syncOut">Disconnect</button>`
              : `<button class="btn accent" id="_syncIn" style="flex:1${needsSetup?';opacity:.45':''}" ${needsSetup?'disabled':''}><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>Connect Google Drive</button>`}
    </div>
    ${signed? `<label class="check-row ${SYNC.auto?'on':''}" id="_syncAuto" style="cursor:pointer;margin-top:10px">
      <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
      <span style="flex:1"><span style="font-family:var(--font-display);font-size:15px;display:block">Sync automatically</span>
      <span class="muted" style="font-size:12px">On launch, after changes, and in the background where the browser allows it.</span></span></label>`:''}`;
  const now=$('#_syncNow'); if(now) now.onclick=()=>runSync(true);
  const sin=$('#_syncIn'); if(sin&&!needsSetup) sin.onclick=()=>syncAuthRedirect();
  const out=$('#_syncOut'); if(out) out.onclick=async()=>{ await syncSignOut(); renderSyncSection(container); };
  const au=$('#_syncAuto'); if(au) au.onclick=()=>{ SYNC.auto=!SYNC.auto; au.classList.toggle('on',SYNC.auto); SDB.metaSet('autosync',SYNC.auto); if(SYNC.auto) syncRegisterPeriodic(); };
}
function updateSyncUI(){
  if(!IS_PAGE) return;
  const el=$('#_syncStatus');
  if(el && SYNC.status==='sync') el.innerHTML='⟳ '+escapeHtml(syncStatusText());
  else if(el && SYNC.status==='error') el.innerHTML='<span style="color:var(--accent)">'+escapeHtml(syncStatusText())+'</span>';
  else if(el && SYNC.status==='ok'){ SDB.metaGet('lastSync',0).then(l=>{ el.innerHTML='Synced · '+new Date(l).toLocaleTimeString(); }); }
  const dot=$('#syncDot');
  if(dot){ dot.className='sync-dot '+SYNC.status; dot.style.display=syncSignedIn()?'block':'none'; }
}

/* ---------------- boot (page only) ---------------- */
if(IS_PAGE){
  syncParseRedirect();
  (async()=>{
    SYNC.auto=await SDB.metaGet('autosync',true);
    await syncLoadToken();
    if(syncSignedIn() && (SYNC.auto || SYNC._resumeAfterAuth)){
      setTimeout(()=>runSync(false), SYNC._resumeAfterAuth?600:2500);
      syncRegisterPeriodic();
    }
    updateSyncUI();
  })();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.addEventListener('message',async e=>{
      if(e.data && e.data.sr==='synced' && typeof reloadData==='function'){
        await reloadData();
        if(typeof renderDrawer==='function') renderDrawer();
        if(typeof renderLibrary==='function') renderLibrary();
        updateSyncUI();
      }
    });
  }
}
