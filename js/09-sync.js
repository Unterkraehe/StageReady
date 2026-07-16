/* ============================================================
   GOOGLE DRIVE SYNC (js/09-sync.js)
   Offline-first library sync. IndexedDB stays the source of truth;
   sync reconciles it with a folder in the user's own Google Drive
   (drive.file scope: the app can only see files it created).

   Remote layout:  StageReady/ manifest.json
                               au_<snippetId>_r<rev>   (audio, immutable per rev)
                               rec_<recordingId>       (practice recordings)
   Merge: newest-wins per record via updatedAt; deletions carry
   tombstones so they propagate instead of resurrecting.
   Auth: OAuth2 token via full-page redirect (works in installed
   PWAs where popups don't). Tokens last ~1h; re-auth is a quick
   bounce when the user is already signed in to Google.
   ============================================================ */

/* One-time setup (app owner): create an OAuth Client ID of type
   "Web application" at console.cloud.google.com → Credentials, add your
   site origin (e.g. https://username.github.io) under "Authorized
   JavaScript origins" AND the full app URL under "Authorized redirect
   URIs", enable the "Google Drive API", then paste the Client ID here: */
const GDRIVE_CLIENT_ID = '824290905313-trfb5eb4ks7sccrli66p3kstdm47tcnp.apps.googleusercontent.com';   // e.g. '1234567890-abc123.apps.googleusercontent.com'

const SYNC={
  remote:null, running:false, queued:false, status:'idle', detail:'',
  lastError:null, auto:true, clientId:GDRIVE_CLIENT_ID, timer:null,
};

/* ---------------- token handling (redirect flow) ---------------- */
function syncParseRedirect(){
  if(!location.hash || location.hash.indexOf('access_token=')<0) return;
  const p=new URLSearchParams(location.hash.slice(1));
  const tok=p.get('access_token'), exp=+p.get('expires_in')||3600, st=p.get('state')||'';
  history.replaceState(null,'',location.pathname+location.search);
  if(!tok) return;
  const saved=sessionStorage.getItem('sr_oauth_state');
  if(saved && st && saved!==st){ console.warn('OAuth state mismatch'); return; }
  sessionStorage.removeItem('sr_oauth_state');
  localStorage.setItem('sr_gd_token', JSON.stringify({t:tok, exp:Date.now()+(exp-60)*1000}));
  SYNC._resumeAfterAuth=true;
}
function syncToken(){
  try{
    const o=JSON.parse(localStorage.getItem('sr_gd_token')||'null');
    if(o && o.exp>Date.now()) return o.t;
  }catch(e){}
  return null;
}
function syncSignedIn(){ return !!syncToken() || !!window.__mockDriveStore; }
function syncAuthRedirect(){
  if(!SYNC.clientId){ toast('Set up a Google Client ID first (see Settings)'); return; }
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
function syncSignOut(){
  const t=syncToken();
  localStorage.removeItem('sr_gd_token');
  DB.metaSet('gd_email','');
  if(t){ try{ fetch('https://oauth2.googleapis.com/revoke?token='+encodeURIComponent(t),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}}); }catch(e){} }
  updateSyncUI();
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
  async init(){
    // find or create the app folder, then index its files (name → id)
    const q=encodeURIComponent("name='StageReady' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    let r=await this._fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    let d=await r.json();
    if(d.files && d.files.length) this.folderId=d.files[0].id;
    else{
      r=await this._fetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:'StageReady',mimeType:'application/vnd.google-apps.folder'})});
      this.folderId=(await r.json()).id;
    }
    this.files={};
    let pageToken='';
    do{
      const fq=encodeURIComponent(`'${this.folderId}' in parents and trashed=false`);
      const url=`https://www.googleapis.com/drive/v3/files?q=${fq}&pageSize=1000&fields=nextPageToken,files(id,name,size)`+(pageToken?`&pageToken=${pageToken}`:'');
      const res=await(await this._fetch(url)).json();
      (res.files||[]).forEach(f=>this.files[f.name]=f.id);
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
    if(this.has(name)){
      await this._fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.files[name]}?uploadType=media`,
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
  async downloadBlob(name){
    if(!this.has(name)) return null;
    const r=await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.files[name]}?alt=media`);
    return r.blob();
  }
  async deleteBlob(name){
    if(!this.has(name)) return;
    await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.files[name]}`,{method:'DELETE'});
    delete this.files[name];
  }
  async userEmail(){
    try{
      const r=await this._fetch('https://www.googleapis.com/drive/v3/about?fields=user');
      return (await r.json()).user.emailAddress||'';
    }catch(e){ return ''; }
  }
}

/* ---------------- Mock adapter (tests / development) ----------------
   Activated when window.__mockDriveStore exists. Same interface; blobs
   held as base64 strings so a test can carry the store across pages. */
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
  async deleteBlob(name){ delete this.s.files[name]; }
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
function syncSetStatus(st,detail){
  SYNC.status=st; SYNC.detail=detail||'';
  updateSyncUI();
}
async function runSync(manual){
  if(SYNC.running){ SYNC.queued=true; return; }
  if(!navigator.onLine && !window.__mockDriveStore){ if(manual) toast('You are offline'); return; }
  let remote;
  if(window.__mockDriveStore) remote=new MockRemote(window.__mockDriveStore);
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
    const man=(await remote.readJSON('manifest.json'))||{v:1,snippets:[],setlists:[],tombstones:[]};

    const locSnips=await DB.getAll('snippets');
    const locSets=await DB.getAll('setlists');
    const locTombs=await DB.getAll('tombstones');

    // ---- merge tombstones (max deletedAt per id) ----
    const tomb={};
    [...locTombs, ...(man.tombstones||[])].forEach(t=>{
      if(!tomb[t.id] || t.deletedAt>tomb[t.id].deletedAt) tomb[t.id]=t;
    });
    const dead=(rec)=>tomb[rec.id] && tomb[rec.id].deletedAt>(rec.updatedAt||1);

    // ---- merge records (newest wins) ----
    const plan={ dlSnips:[], upBlobs:[], dlSets:[], killLocal:[] };
    const finalSnips={}, finalSets={};
    const remSnips={}; (man.snippets||[]).forEach(s=>remSnips[s.id]=s);
    const remSets={};  (man.setlists||[]).forEach(s=>remSets[s.id]=s);

    for(const s of locSnips){
      if(dead(s)){ plan.killLocal.push(['snippets',s.id]); continue; }
      const r=remSnips[s.id];
      if(r && (r.updatedAt||1)>(s.updatedAt||1) && !dead(r)) plan.dlSnips.push(r);
      else finalSnips[s.id]=s;
    }
    for(const id in remSnips){
      const r=remSnips[id];
      if(dead(r)) continue;
      if(!locSnips.some(s=>s.id===id)) plan.dlSnips.push(r);
    }
    for(const sl of locSets){
      if(dead(sl)){ plan.killLocal.push(['setlists',sl.id]); continue; }
      const r=remSets[sl.id];
      if(r && (r.updatedAt||1)>(sl.updatedAt||1) && !dead(r)) plan.dlSets.push(r);
      else finalSets[sl.id]=sl;
    }
    for(const id in remSets){
      const r=remSets[id];
      if(dead(r)) continue;
      if(!locSets.some(s=>s.id===id)) plan.dlSets.push(r);
    }

    // ---- apply local deletions from tombstones ----
    for(const [store,id] of plan.killLocal){
      await DB.del(store,id);
      if(store==='snippets' && state.current===id){ try{ closeSnippet(); }catch(e){} }
    }

    // ---- download remote-won snippets (records + blobs) ----
    let step=0, steps=plan.dlSnips.length;
    for(const r of plan.dlSnips){
      step++; syncSetStatus('sync',`Downloading ${step}/${steps}: ${r.name}`);
      const local=locSnips.find(s=>s.id===r.id);
      let audioFile=local&&local.audioFile, haveRev=local?(local.audioRev||0):-1;
      if(haveRev!==(r.audioRev||0) || !audioFile){
        const b=await remote.downloadBlob(audioName(r));
        if(!b) continue;                    // blob missing remotely: skip record
        audioFile=b;
      }
      const recs=[];
      for(const rm of (r.recordings||[])){
        const have=local&&(local.recordings||[]).find(x=>x.id===rm.id);
        if(have&&have.blob) recs.push(have);
        else{
          const rb=await remote.downloadBlob('rec_'+rm.id);
          if(rb) recs.push({id:rm.id,timestamp:rm.timestamp,dur:rm.dur,blob:rb});
        }
      }
      const rec=Object.assign({},r,{audioFile,recordings:recs});
      delete rec.audioName;
      await DB.putRaw('snippets',rec);
      finalSnips[rec.id]=rec;
    }
    for(const r of plan.dlSets){ await DB.putRaw('setlists',r); finalSets[r.id]=r; }

    // ---- upload blobs for every final snippet that Drive is missing ----
    const wanted=new Set(['manifest.json']);
    const ups=[];
    for(const id in finalSnips){
      const s=finalSnips[id];
      wanted.add(audioName(s));
      if(!remote.has(audioName(s)) && s.audioFile) ups.push(['audio',s]);
      for(const rc of (s.recordings||[])){
        wanted.add('rec_'+rc.id);
        if(!remote.has('rec_'+rc.id) && rc.blob) ups.push(['rec',rc]);
      }
    }
    step=0; steps=ups.length;
    for(const [kind,o] of ups){
      step++;
      if(kind==='audio'){ syncSetStatus('sync',`Uploading ${step}/${steps}: ${o.name}`); await remote.uploadBlob(audioName(o),o.audioFile,o.audioType); }
      else { syncSetStatus('sync',`Uploading ${step}/${steps}: recording`); await remote.uploadBlob('rec_'+o.id,o.blob); }
    }

    // ---- write merged manifest ----
    syncSetStatus('sync','Finalizing…');
    const tombs=Object.values(tomb).filter(t=>Date.now()-t.deletedAt<1000*3600*24*90); // keep 90 days
    await remote.writeJSON('manifest.json',{
      v:1, updatedAt:Date.now(),
      snippets:Object.values(finalSnips).map(snipToManifest),
      setlists:Object.values(finalSets).map(setlistToManifest),
      tombstones:tombs,
    });
    for(const t of tombs) await DB.putRaw('tombstones',t);

    // ---- prune remote orphans (deleted snippets' blobs, old audio revs) ----
    for(const name of remote.list()){
      if(!wanted.has(name)){ try{ await remote.deleteBlob(name); }catch(e){} }
    }

    // ---- refresh app ----
    if(plan.dlSnips.length||plan.dlSets.length||plan.killLocal.length){
      await reloadData();
      renderDrawer(); renderLibrary();
    }
    await DB.metaSet('lastSync',Date.now());
    if(!window.__mockDriveStore){
      const em=await DB.metaGet('gd_email','');
      if(!em){ const e2=await remote.userEmail(); if(e2) DB.metaSet('gd_email',e2); }
    }
    syncSetStatus('ok','');
  }catch(err){
    console.warn('sync failed:',err);
    SYNC.lastError=err;
    if(err.code===401){
      localStorage.removeItem('sr_gd_token');
      syncSetStatus('error','Signed out — reconnect to sync');
      if(manual) syncAuthRedirect();
    } else syncSetStatus('error', err.message||'Sync failed');
  }finally{
    SYNC.running=false;
    if(SYNC.queued){ SYNC.queued=false; setTimeout(()=>runSync(false),1500); }
  }
}

/* ---------------- triggers ---------------- */
function syncQueue(store){
  if(store==='meta') return;
  if(!SYNC.auto || !syncSignedIn()) return;
  clearTimeout(SYNC.timer);
  SYNC.timer=setTimeout(()=>runSync(false),8000);
}
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState!=='visible' || !SYNC.auto || !syncSignedIn()) return;
  const last=await DB.metaGet('lastSync',0);
  if(Date.now()-last>5*60*1000) runSync(false);
});

/* ---------------- UI ---------------- */
function syncStatusText(){
  if(SYNC.status==='sync') return SYNC.detail||'Syncing…';
  if(SYNC.status==='error') return SYNC.detail||'Sync failed';
  return '';
}
async function renderSyncSection(container){
  const signed=syncSignedIn();
  const email=signed? (window.__mockDriveStore?'mock@test':await DB.metaGet('gd_email','')) : '';
  const last=await DB.metaGet('lastSync',0);
  const needsSetup=!SYNC.clientId && !window.__mockDriveStore;
  container.innerHTML=`
    <div class="set-sec-label" style="margin-top:20px">Sync — Google Drive</div>
    ${needsSetup? `<p class="muted" style="font-size:12.5px;margin:4px 2px 10px">Not configured. The app owner must create a (free) Google OAuth Client ID and paste it into <b>js/09-sync.js</b>. Instructions are at the top of that file.</p>`:''}
    <div id="_syncStatus" class="muted" style="font-size:13px;margin:2px 2px 10px">
      ${signed? `Connected${email?' as <b>'+escapeHtml(email)+'</b>':''}${last?' · last sync '+new Date(last).toLocaleTimeString():''}` : 'Not connected. Your library stays on this device.'}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${signed? `<button class="btn accent" id="_syncNow" style="flex:1"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>Sync now</button>
                 <button class="btn ghost" id="_syncOut">Disconnect</button>`
              : `<button class="btn accent" id="_syncIn" style="flex:1" ${needsSetup?'disabled style="flex:1;opacity:.45"':''}><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>Connect Google Drive</button>`}
    </div>
    ${signed? `<label class="check-row ${SYNC.auto?'on':''}" id="_syncAuto" style="cursor:pointer;margin-top:10px">
      <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
      <span style="flex:1;font-family:var(--font-display);font-size:15px">Sync automatically</span></label>`:''}`;
  const now=$('#_syncNow'); if(now) now.onclick=()=>runSync(true);
  const sin=$('#_syncIn'); if(sin&&!needsSetup) sin.onclick=()=>syncAuthRedirect();
  const out=$('#_syncOut'); if(out) out.onclick=()=>{ syncSignOut(); renderSyncSection(container); };
  const au=$('#_syncAuto'); if(au) au.onclick=()=>{ SYNC.auto=!SYNC.auto; au.classList.toggle('on',SYNC.auto); DB.metaSet('autosync',SYNC.auto); };
}
function updateSyncUI(){
  const el=$('#_syncStatus');
  if(el && SYNC.status==='sync') el.innerHTML='⟳ '+escapeHtml(syncStatusText());
  else if(el && SYNC.status==='error') el.innerHTML='<span style="color:var(--accent)">'+escapeHtml(syncStatusText())+'</span>';
  else if(el && SYNC.status==='ok'){ DB.metaGet('lastSync',0).then(l=>{ el.innerHTML='Synced · '+new Date(l).toLocaleTimeString(); }); }
  const dot=$('#syncDot');
  if(dot){ dot.className='sync-dot '+SYNC.status; dot.style.display=syncSignedIn()?'block':'none'; }
}

/* ---------------- boot ---------------- */
syncParseRedirect();
(async()=>{
  SYNC.auto=await DB.metaGet('autosync',true);
  if(syncSignedIn()){
    setTimeout(()=>runSync(false), SYNC._resumeAfterAuth?600:2500);
  }
  updateSyncUI();
})();
