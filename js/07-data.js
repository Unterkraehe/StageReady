/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
const AUDIO_EXT=/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm|aiff|aif|wma|mp4)$/i;
function extFromType(t,fallback){
  const map={'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/webm':'webm','audio/mp4':'m4a','audio/aac':'aac','audio/flac':'flac','audio/x-m4a':'m4a','audio/opus':'opus'};
  return map[t]||fallback||'bin';
}
function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },1500);
}

/* ---------- progress overlay ---------- */
const PROG_CIRC=2*Math.PI*44;
function showProgress(title,sub,indeterminate){
  const o=$('#progressOverlay');
  $('.prog-title',o).textContent=title||'Working…';
  $('.prog-sub',o).textContent=sub||'';
  o.classList.toggle('indeterminate',!!indeterminate);
  if(!indeterminate) setProgress(0);
  o.classList.remove('hidden');
}
function setProgress(pct,sub){
  const o=$('#progressOverlay'); o.classList.remove('indeterminate');
  pct=clamp(pct,0,100);
  $('.prog-fg',o).style.strokeDashoffset=PROG_CIRC*(1-pct/100);
  $('.prog-pct',o).textContent=Math.round(pct)+'%';
  if(sub!==undefined) $('.prog-sub',o).textContent=sub;
}
function progSub(text){ $('.prog-sub',$('#progressOverlay')).textContent=text||''; }
function hideProgress(){ $('#progressOverlay').classList.add('hidden'); }
const nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>r()));

async function exportBundle(snips, setlists, stem){
  if(typeof JSZip==='undefined'){ toast('Zip library not loaded'); return; }
  showProgress('Preparing export…', (snips.length+' snippet'+(snips.length!==1?'s':'')), true);
  await nextFrame();
  try{
    const zip=new JSZip();
    const manifest={ app:'StageReady', version:1, exportedAt:Date.now(), snippets:[], setlists:[] };
    for(const s of snips){
      const audioExt=extFromType(s.audioType, (s.audioFile&&s.audioFile.name? (s.audioFile.name.match(/\.([^.]+)$/)||[])[1]:'') );
      const audioPath=`audio/${s.id}.${audioExt}`;
      // STORE: audio/recordings are already compressed — never re-deflate (huge speed/memory win)
      if(s.audioFile) zip.file(audioPath, s.audioFile, {compression:'STORE'});
      const recMeta=[];
      (s.recordings||[]).forEach((r,i)=>{
        const rp=`recordings/${s.id}/${r.id||i}.webm`;
        if(r.blob){ zip.file(rp, r.blob, {compression:'STORE'}); recMeta.push({ id:r.id, timestamp:r.timestamp, dur:r.dur, path:rp }); }
      });
      manifest.snippets.push({
        id:s.id, name:s.name, audioType:s.audioType, audioPath:s.audioFile?audioPath:null,
        tags:s.tags||[], markers:s.markers||[], notes:s.notes||'', pitch:s.pitch||0,
        ratings:s.ratings||[], lastPlayed:s.lastPlayed||null, createdAt:s.createdAt||null,
        recordings:recMeta
      });
    }
    setlists.forEach(sl=>manifest.setlists.push({ id:sl.id, name:sl.name, snippetIds:sl.snippetIds||[], order:sl.order, print:sl.print||null }));
    zip.file('manifest.json', JSON.stringify(manifest,null,2));   // tiny — fine to deflate by default
    showProgress('Packaging…','Writing zip', false);
    await nextFrame();
    const blob=await zip.generateAsync(
      { type:'blob', compression:'STORE', streamFiles:true },
      (meta)=>{ setProgress(meta.percent, meta.currentFile||'Writing zip'); }
    );
    setProgress(100,'Saving…');
    const stamp=new Date().toISOString().slice(0,10);
    downloadBlob(blob,`${stem}-${stamp}.zip`);
    hideProgress();
    toast('Export ready');
  }catch(err){ console.error(err); hideProgress(); toast('Export failed: '+(err&&err.message?err.message:'unknown')); }
}
async function exportData(){
  return exportBundle(state.snippets, state.setlists, 'stage-ready');
}
function slug(s){ return (s||'setlist').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'setlist'; }
async function exportSetlist(sl){
  const ids=sl.snippetIds.filter(id=>state.byId[id]);
  if(!ids.length){ toast('Setlist is empty'); return; }
  const snips=ids.map(id=>state.byId[id]);
  return exportBundle(snips, [{ id:sl.id, name:sl.name, snippetIds:ids }], 'setlist-'+slug(sl.name));
}

/* ---------- printing (isolated iframe — immune to app CSS / PWA quirks) ---------- */
/* ---------- printing v2: per-setlist config, gap notes, tag colors, auto-fit ---------- */
const PRINT_PALETTE=['#e8401f','#1f6fe8','#0f9d58','#8e24aa','#f4a900','#00838f','#c2185b','#5d4037'];
function safeColor(c){ return /^#[0-9a-fA-F]{6}$/.test(c||'')? c : '#e8401f'; }
function getPrintCfg(sl){
  const cfg = sl.print = sl.print || {};
  if(cfg.heading===undefined) cfg.heading=true;
  if(cfg.notes===undefined) cfg.notes=true;
  if(cfg.numbers===undefined) cfg.numbers=true;
  if(!cfg.mode) cfg.mode='auto';
  cfg.tags=cfg.tags||{}; cfg.gaps=cfg.gaps||[]; cfg.breaks=cfg.breaks||[];
  // ensure every tag used in this setlist has an entry
  const used=new Set();
  sl.snippetIds.forEach(id=>{ const s=state.byId[id]; if(s)(s.tags||[]).forEach(t=>used.add(t)); });
  let pi=Object.keys(cfg.tags).length;
  used.forEach(t=>{ if(!cfg.tags[t]) cfg.tags[t]={on:true,color:PRINT_PALETTE[pi++%PRINT_PALETTE.length]}; });
  const n=sl.snippetIds.filter(id=>state.byId[id]).length;
  cfg.gaps=cfg.gaps.filter(g=>g.pos>=0&&g.pos<=n);
  cfg.breaks=cfg.breaks.filter(p=>p>=1&&p<n);
  return cfg;
}
let _printCfgSave=null;
function savePrintCfg(sl){ clearTimeout(_printCfgSave); _printCfgSave=setTimeout(()=>DB.put('setlists',sl),250); }

function printSetlist(sl){
  const ids=sl.snippetIds.filter(id=>state.byId[id]);
  if(!ids.length){ toast('Setlist is empty'); return; }
  const cfg=getPrintCfg(sl);
  const tagRows=Object.keys(cfg.tags).sort().map(t=>`
    <div class="prt-tag" data-tag="${escapeHtml(t)}">
      <span class="check-box ${cfg.tags[t].on?'':'off'}" data-tagtoggle>${cfg.tags[t].on?'<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>':''}</span>
      <span class="nm">${escapeHtml(t)}</span>
      <input type="color" value="${safeColor(cfg.tags[t].color)}" data-tagcolor>
    </div>`).join('');
  const songList=()=>{
    let html='';
    const slot=(pos)=>{
      const notes=cfg.gaps.filter(g=>g.pos===pos).map(g=>`
        <div class="prt-gap" data-gid="${g.id}">
          <input type="color" value="${safeColor(g.color)}" data-gapcolor>
          <input type="text" value="${escapeHtml(g.text)}" placeholder="e.g. BREAK / Encore / Announcement" data-gaptext>
          <button class="icon-btn mini" data-gapdel><svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>`).join('');
      const brk = pos>0&&pos<ids.length ? `<button class="prt-slot-btn ${cfg.breaks.includes(pos)?'on':''}" data-break="${pos}">⤓ page break</button>` : '';
      return `<div class="prt-slot">${notes}<div class="prt-slot-acts"><button class="prt-slot-btn" data-addnote="${pos}">+ note</button>${brk}</div></div>`;
    };
    ids.forEach((id,i)=>{
      html+=slot(i);
      html+=`<div class="prt-song"><span class="num">${i+1}.</span> ${escapeHtml(state.byId[id].name)}</div>`;
    });
    html+=slot(ids.length);
    return html;
  };
  openModal(`<div class="modal-head"><h3>Print “${escapeHtml(sl.name)}”</h3></div>
    <div class="modal-body">
      <label class="check-row ${cfg.heading?'on':''}" id="_pHead" style="cursor:pointer">
        <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
        <span style="flex:1;font-family:var(--font-display);font-size:15px">Print heading</span></label>
      <label class="check-row ${cfg.notes?'on':''}" id="_pNotes" style="cursor:pointer">
        <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
        <span style="flex:1;font-family:var(--font-display);font-size:15px">Include snippet notes</span></label>
      <label class="check-row ${cfg.numbers?'on':''}" id="_pNums" style="cursor:pointer">
        <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
        <span style="flex:1;font-family:var(--font-display);font-size:15px">Number songs</span></label>

      <div class="set-sec-label" style="margin-top:14px">Size</div>
      <div class="prt-modes" id="_pModes">
        <button class="btn sm ${cfg.mode==='auto'?'accent':'ghost'}" data-mode="auto">Auto-fit pages</button>
        <button class="btn sm ${cfg.mode==='normal'?'accent':'ghost'}" data-mode="normal">Normal</button>
        <button class="btn sm ${cfg.mode==='large'?'accent':'ghost'}" data-mode="large">Large</button>
        <button class="btn sm ${cfg.mode==='huge'?'accent':'ghost'}" data-mode="huge">Huge</button>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 2px 0" id="_pModeHint"></p>

      <div class="set-sec-label" style="margin-top:14px">Tags</div>
      <div id="_pTags">${tagRows||'<p class="muted" style="font-size:13px">No tags in this setlist.</p>'}</div>

      <div class="set-sec-label" style="margin-top:14px">Songs, notes &amp; page breaks</div>
      <div id="_pSongs">${songList()}</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" id="_cancel">Close</button><button class="btn accent" id="_pGo"><svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5h-2M8 14h8v7H8z"/></svg>Print</button></div>`);
  const hint=()=>{ $('#_pModeHint').textContent = cfg.mode==='auto'
    ? 'Each page (as split by your page breaks) is scaled to fill the sheet.'
    : 'Fixed text size; page breaks are still honored.'; };
  hint();
  $('#_cancel').onclick=closeModal;
  $('#_pHead').onclick=()=>{ cfg.heading=!cfg.heading; $('#_pHead').classList.toggle('on',cfg.heading); savePrintCfg(sl); };
  $('#_pNotes').onclick=()=>{ cfg.notes=!cfg.notes; $('#_pNotes').classList.toggle('on',cfg.notes); savePrintCfg(sl); };
  $('#_pNums').onclick=()=>{ cfg.numbers=!cfg.numbers; $('#_pNums').classList.toggle('on',cfg.numbers); savePrintCfg(sl); };
  $('#_pModes').onclick=e=>{ const b=e.target.closest('[data-mode]'); if(!b) return;
    cfg.mode=b.dataset.mode; $$('#_pModes .btn').forEach(x=>{ x.classList.toggle('accent',x===b); x.classList.toggle('ghost',x!==b); }); hint(); savePrintCfg(sl); };
  $('#_pTags').addEventListener('click',e=>{
    const row=e.target.closest('.prt-tag'); if(!row) return;
    if(e.target.closest('[data-tagtoggle]')){
      const t=row.dataset.tag; cfg.tags[t].on=!cfg.tags[t].on;
      const box=row.querySelector('[data-tagtoggle]');
      box.classList.toggle('off',!cfg.tags[t].on);
      box.innerHTML=cfg.tags[t].on?'<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>':'';
      savePrintCfg(sl);
    }
  });
  $('#_pTags').addEventListener('input',e=>{
    const row=e.target.closest('.prt-tag'); if(!row||!e.target.matches('[data-tagcolor]')) return;
    cfg.tags[row.dataset.tag].color=e.target.value; savePrintCfg(sl);
  });
  const rerenderSongs=()=>{ $('#_pSongs').innerHTML=songList(); };
  $('#_pSongs').addEventListener('click',e=>{
    const add=e.target.closest('[data-addnote]');
    if(add){ cfg.gaps.push({id:uid(),pos:+add.dataset.addnote,text:'',color:'#f4a900'}); savePrintCfg(sl); rerenderSongs();
      const last=$$('#_pSongs [data-gaptext]').pop(); if(last) last.focus(); return; }
    const brk=e.target.closest('[data-break]');
    if(brk){ const p=+brk.dataset.break; const i=cfg.breaks.indexOf(p);
      if(i>=0) cfg.breaks.splice(i,1); else cfg.breaks.push(p);
      brk.classList.toggle('on',i<0); savePrintCfg(sl); return; }
    const del=e.target.closest('[data-gapdel]');
    if(del){ const gid=del.closest('.prt-gap').dataset.gid; cfg.gaps=cfg.gaps.filter(g=>g.id!==gid); savePrintCfg(sl); rerenderSongs(); }
  });
  $('#_pSongs').addEventListener('input',e=>{
    const row=e.target.closest('.prt-gap'); if(!row) return;
    const g=cfg.gaps.find(x=>x.id===row.dataset.gid); if(!g) return;
    if(e.target.matches('[data-gaptext]')) g.text=e.target.value;
    if(e.target.matches('[data-gapcolor]')) g.color=e.target.value;
    savePrintCfg(sl);
  });
  $('#_pGo').onclick=async()=>{
    cfg.gaps=cfg.gaps.filter(g=>g.text.trim());
    await DB.put('setlists',sl);
    closeModal();
    printViaFrame(buildPrintHTML(sl,cfg), cfg.mode==='auto');
  };
}

function buildPrintHTML(sl,cfg){
  const ids=sl.snippetIds.filter(id=>state.byId[id]);
  const factor={normal:1,large:1.4,huge:1.85}[cfg.mode]||1;
  const gapsAt=p=>cfg.gaps.filter(g=>g.pos===p);
  const gapHTML=g=>`<div class="gap" style="--gc:${safeColor(g.color)}">${escapeHtml(g.text)}</div>`;
  const songHTML=(id,i)=>{
    const s=state.byId[id];
    const tags=(s.tags||[]).filter(t=>cfg.tags[t]&&cfg.tags[t].on)
      .map(t=>`<span class="tag" style="--tc:${safeColor(cfg.tags[t].color)}">${escapeHtml(t)}</span>`).join('');
    const meta=s.pitch? `<span class="pit">${s.pitch>0?'+':''}${s.pitch} st</span>`:'';
    const note=cfg.notes&&s.notes? `<span class="note">${escapeHtml(s.notes)}</span>`:'';
    const num=cfg.numbers? `<span class="num">${i+1}.</span>`:'';
    return `<div class="song">${num}<span class="body"><span class="nm">${escapeHtml(s.name)}${meta}${tags}</span>${note}</span></div>`;
  };
  // split into pages on breaks
  const breaks=[...cfg.breaks].sort((a,b)=>a-b);
  const pages=[]; let cur=[], pi=0;
  ids.forEach((id,i)=>{
    if(breaks.includes(i)&&cur.length){ pages.push(cur); cur=[]; }
    gapsAt(i).forEach(g=>cur.push(gapHTML(g)));
    cur.push(songHTML(id,i));
  });
  gapsAt(ids.length).forEach(g=>cur.push(gapHTML(g)));
  pages.push(cur);
  const head=cfg.heading? `<div class="pr-head"><h1 class="pr-title">${escapeHtml(sl.name)}</h1>
    <p class="pr-sub">${ids.length} song${ids.length!==1?'s':''} · Stage Ready</p></div>` : '';
  const auto=cfg.mode==='auto';
  const pageDivs=pages.map((rows,k)=>
    `<div class="page${k<pages.length-1?' brk':''}" style="--s:${factor}"><div class="inner">${k===0?head:''}${rows.join('')}</div></div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(sl.name)}</title>
<style>
@page{size:A4;margin:14mm}
html,body{margin:0;padding:0;background:#fff;color:#000;width:182mm}
body{font-family:'Oswald','Arial Narrow',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{--s:1}
.page.brk{page-break-after:always}
${auto?'.page{height:269mm;overflow:hidden}.page .inner{display:flex;flex-direction:column;justify-content:flex-start}':''}
.pr-head{border-bottom:calc(4px*var(--s)) solid #000;padding-bottom:calc(8px*var(--s));margin-bottom:calc(12px*var(--s))}
.pr-title{font-weight:700;text-transform:uppercase;letter-spacing:.04em;line-height:1.02;margin:0;font-size:calc(30pt*var(--s))}
.pr-sub{font-weight:500;text-transform:uppercase;letter-spacing:.12em;color:#333;margin:calc(4px*var(--s)) 0 0;font-size:calc(10pt*var(--s))}
.song{display:flex;gap:.5em;align-items:baseline;padding:calc(.34em*var(--s)) 0;break-inside:avoid;page-break-inside:avoid}
.song .num{font-weight:700;min-width:1.6em;text-align:right;font-size:calc(20pt*var(--s))}
.song .body{flex:1;min-width:0}
.song .nm{font-weight:700;line-height:1.05;display:block;font-size:calc(20pt*var(--s))}
.song .pit{font-weight:600;margin-left:.55em;font-size:calc(13pt*var(--s));white-space:nowrap}
.tag{display:inline-block;margin-left:.45em;padding:calc(1px*var(--s)) calc(7px*var(--s));border:calc(2px*var(--s)) solid var(--tc);color:var(--tc);border-radius:999px;font-weight:600;font-size:calc(11pt*var(--s));letter-spacing:.05em;text-transform:uppercase;vertical-align:middle}
.song .note{font-family:Arial,Helvetica,sans-serif;font-weight:400;color:#111;display:block;margin-top:.1em;font-size:calc(12pt*var(--s))}
.gap{border-left:calc(9px*var(--s)) solid var(--gc);color:var(--gc);font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:calc(.22em*var(--s)) 0 calc(.22em*var(--s)) calc(10px*var(--s));margin:calc(.18em*var(--s)) 0;font-size:calc(15pt*var(--s));break-inside:avoid;page-break-inside:avoid}
</style></head><body>${pageDivs}</body></html>`;
}
let _printFrame=null;
function printViaFrame(html, autoFit){
  if(_printFrame){ try{document.body.removeChild(_printFrame);}catch(e){} _printFrame=null; }
  const f=document.createElement('iframe');
  // A4 content width at CSS 96dpi so on-screen layout == print layout
  f.style.cssText='position:fixed;right:0;bottom:0;width:182mm;height:269mm;border:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(f); _printFrame=f;
  const doc=f.contentDocument||f.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  const fire=()=>{
    try{
      if(autoFit){
        doc.querySelectorAll('.page').forEach(pg=>{
          const inner=pg.querySelector('.inner');
          pg.style.setProperty('--s','1');
          const avail=pg.clientHeight;
          for(let pass=0;pass<3;pass++){
            const nat=inner.scrollHeight;
            if(!nat) break;
            let s=parseFloat(pg.style.getPropertyValue('--s'))*avail/nat;
            s=Math.max(0.4,Math.min(3,s));
            pg.style.setProperty('--s',String(Math.floor(s*100)/100));
            if(inner.scrollHeight<=avail&&Math.abs(inner.scrollHeight-avail)/avail<0.12) break;
          }
          // final safety: never overflow
          while(inner.scrollHeight>avail && parseFloat(pg.style.getPropertyValue('--s'))>0.4){
            pg.style.setProperty('--s',String(Math.floor((parseFloat(pg.style.getPropertyValue('--s'))-0.03)*100)/100));
          }
        });
      }
      f.contentWindow.focus(); f.contentWindow.print();
    }catch(e){ toast('Print failed'); }
  };
  if(doc.readyState==='complete') setTimeout(fire,300);
  else f.onload=()=>setTimeout(fire,300);
  setTimeout(()=>{ if(_printFrame===f){ try{document.body.removeChild(f);}catch(e){} _printFrame=null; } },60000);
}

async function importZip(file){
  if(typeof JSZip==='undefined'){ toast('Zip library not loaded'); return; }
  showProgress('Reading archive…','', true);
  await nextFrame();
  try{
    const zip=await JSZip.loadAsync(file);
    const mf=zip.file('manifest.json');
    if(!mf){ hideProgress(); toast('No manifest in zip'); return; }
    const manifest=JSON.parse(await mf.async('string'));
    const snipList=manifest.snippets||[];
    const total=snipList.length||1;
    let added=0, i=0;
    showProgress('Importing…', total+' snippet'+(total!==1?'s':''));
    for(const sm of snipList){
      i++; setProgress((i-1)/total*100, sm.name||('Snippet '+i));
      let audioFile=null;
      if(sm.audioPath && zip.file(sm.audioPath)) audioFile=await zip.file(sm.audioPath).async('blob');
      const recordings=[];
      for(const rm of (sm.recordings||[])){
        if(rm.path && zip.file(rm.path)){ const b=await zip.file(rm.path).async('blob'); recordings.push({ id:rm.id||uid(), blob:b, timestamp:rm.timestamp||Date.now(), dur:rm.dur||0 }); }
      }
      // fresh id if collision
      let id=sm.id; if(state.byId[id]) id=uid();
      const snip={ id, name:sm.name||'Untitled', audioFile, audioType:sm.audioType||'audio/mpeg',
        tags:sm.tags||[], markers:(sm.markers||[]).map(m=>({id:m.id||uid(),time:m.time,note:m.note||''})),
        notes:sm.notes||'', recordings, ratings:sm.ratings||[], pitch:sm.pitch||0, lastPlayed:sm.lastPlayed||null, createdAt:sm.createdAt||Date.now(),
        _origId:sm.id };
      await DB.put('snippets',snip); state.snippets.push(snip); reindex(); added++;
      setProgress(i/total*100, sm.name||('Snippet '+i));
    }
    // merge setlists (map original ids -> imported ids)
    const idMap={}; state.snippets.forEach(s=>{ if(s._origId) idMap[s._origId]=s.id; });
    for(const slm of (manifest.setlists||[])){
      const mappedIds=(slm.snippetIds||[]).map(x=>idMap[x]||x).filter(x=>state.byId[x]);
      if(slm.id===LIBRARY_ID){
        const lib=getLibrary();
        mappedIds.forEach(x=>{ if(!lib.snippetIds.includes(x)) lib.snippetIds.push(x); });
        await DB.put('setlists',lib);
      } else {
        let id=slm.id; if(getSetlist(id)) id=uid();
        const sl={ id, name:slm.name||'Setlist', snippetIds:mappedIds, order:(typeof slm.order==='number'?slm.order:state.setlists.length), print:slm.print||undefined };
        state.setlists.push(sl); await DB.put('setlists',sl);
      }
    }
    // ensure every snippet is in library
    const lib=getLibrary();
    state.snippets.forEach(s=>{ if(!lib.snippetIds.includes(s.id)) lib.snippetIds.push(s.id); });
    await DB.put('setlists',lib);
    state.snippets.forEach(s=>delete s._origId);
    reindex(); renderDrawer(); renderLibrary();
    hideProgress();
    toast(added?`Imported ${added} snippet${added>1?'s':''}`:'Nothing to import');
  }catch(err){ console.error(err); hideProgress(); toast('Import failed — invalid zip'); }
}

function snipSig(name,size){ return (name||'').trim().toLowerCase()+'::'+(size||0); }
async function importDirectory(fileList){
  const all=[...fileList].filter(f=>AUDIO_EXT.test(f.name));
  if(!all.length){ toast('No audio files found'); return; }
  // dedup: skip files already present (match on name-without-ext + byte size)
  const existing=new Set(state.snippets.map(s=>snipSig(
    (s.audioFile&&s.audioFile.name? s.audioFile.name.replace(/\.[^.]+$/,'') : s.name),
    s.audioFile&&s.audioFile.size )));
  const seen=new Set();
  const files=[];
  let skipped=0;
  for(const f of all){
    const sig=snipSig(f.name.replace(/\.[^.]+$/,''), f.size);
    if(existing.has(sig)||seen.has(sig)){ skipped++; continue; }
    seen.add(sig); files.push(f);
  }
  if(!files.length){ toast(skipped?`All ${skipped} file${skipped>1?'s':''} already in library`:'Nothing to add'); return; }
  showProgress('Adding folder…', files.length+' new file'+(files.length!==1?'s':''));
  await nextFrame();
  const lib=getLibrary();
  const total=files.length; let added=0, i=0;
  for(const f of files){
    i++; setProgress((i-1)/total*100, f.name);
    const name=f.name.replace(/\.[^.]+$/,'');
    const snip={ id:uid(), name, audioFile:f, audioType:f.type||'audio/mpeg',
      tags:[], markers:[], notes:'', recordings:[], ratings:[], pitch:0, lastPlayed:null, createdAt:Date.now() };
    state.snippets.push(snip); lib.snippetIds.push(snip.id);
    await DB.put('snippets',snip); added++;
    setProgress(i/total*100, f.name);
  }
  await DB.put('setlists',lib); reindex(); renderDrawer(); renderLibrary();
  hideProgress();
  toast(`Added ${added}${skipped?', skipped '+skipped+' duplicate'+(skipped>1?'s':''):''}`);
}

/* Import chooser modal */
/* Import chooser */
function openImportChooser(){
  openModal(`<div class="modal-head"><h3>Import</h3></div>
    <div class="modal-body">
      <p class="muted" style="margin:0 0 14px">Restore a previous export, or build snippets from a folder of audio files.</p>
      <button class="btn" id="_impZip" style="width:100%;margin-bottom:10px"><svg viewBox="0 0 24 24"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/></svg>Import export (.zip)</button>
      <button class="btn" id="_impDir" style="width:100%"><svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v11H3z"/></svg>Import folder of audio</button>
    </div>
    <div class="modal-foot"><button class="btn ghost" id="_back">Back</button></div>`);
  $('#_back').onclick=openSettings;
  $('#_impZip').onclick=()=>{ const inp=$('#zipInput'); inp.value=''; inp.onchange=()=>{ if(inp.files[0]){ closeModal(); importZip(inp.files[0]); } }; inp.click(); };
  $('#_impDir').onclick=()=>{ const inp=$('#dirInput'); inp.value=''; inp.onchange=()=>{ if(inp.files&&inp.files.length){ closeModal(); importDirectory(inp.files); } }; inp.click(); };
}

/* ---------- Settings ---------- */
function openSettings(){
  const al=state.autoLoud!==false;
  openModal(`<div class="modal-head"><h3>Settings</h3></div>
    <div class="modal-body">
      <div class="set-sec-label">Playback</div>
      <label class="check-row ${al?'on':''}" id="_autoLoudRow" style="cursor:pointer">
        <span class="check-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>
        <span style="flex:1"><span style="font-family:var(--font-display);font-size:15px;display:block">Match loudness between snippets</span>
        <span class="muted" style="font-size:12px">Evens out perceived volume automatically. Per-snippet Vol trim still applies.</span></span>
      </label>

      <div class="set-sec-label" style="margin-top:20px">Data</div>
      <button class="btn" id="_setImport" style="width:100%;justify-content:flex-start;margin-bottom:8px"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>Import…</button>
      <button class="btn" id="_setExport" style="width:100%;justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="M12 21V9m0 0 4 4m-4-4-4 4M5 3h14"/></svg>Export everything</button>

      <div class="set-sec-label danger" style="margin-top:20px">Danger zone</div>
      <button class="btn danger" id="_setReset" style="width:100%;justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>Reset app…</button>
      <p class="muted" style="font-size:12px;margin:8px 2px 0">Permanently erases every snippet, setlist, recording, rating and setting stored on this device. Export first if you want a backup.</p>
    </div>
    <div class="modal-foot"><button class="btn ghost" id="_cancel">Close</button></div>`);
  $('#_cancel').onclick=closeModal;
  $('#_autoLoudRow').onclick=()=>{
    state.autoLoud=!(state.autoLoud!==false);
    $('#_autoLoudRow').classList.toggle('on',state.autoLoud);
    DB.metaSet('autoloud',state.autoLoud);
    applyVolume();
  };
  $('#_setImport').onclick=openImportChooser;
  $('#_setExport').onclick=()=>{ closeModal(); exportData(); };
  $('#_setReset').onclick=resetAppFlow;
}
$('#settingsBtn').onclick=openSettings;

/* ---------- Reset app (double confirmation) ---------- */
async function resetAppFlow(){
  const c1=await confirmDialog('Reset app?',
    'This permanently deletes ALL snippets, setlists, recordings, ratings and settings on this device. This cannot be undone.',
    'Continue', true);
  if(!c1) return;
  const c2=await confirmDialog('Are you absolutely sure?',
    'There is no undo. Everything will be erased and the app returns to a clean state.',
    'Erase everything', true);
  if(!c2) return;
  await resetApp();
}
async function resetApp(){
  try{ audioEl.pause(); }catch(e){}
  try{ if(state.current) closeSnippet(); }catch(e){}
  try{ closeTools(); }catch(e){}
  try{ if(typeof stopMetro==='function') stopMetro(); }catch(e){}
  try{ closeDrawer(); }catch(e){}
  showProgress('Resetting…','', true);
  try{
    await DB.clear('snippets');
    await DB.clear('setlists');
    await DB.clear('meta');
    // wipe in-memory state
    state.snippets=[]; state.setlists=[]; state.byId={};
    state.search=''; state.activeTags=new Set(); state.sort='custom'; state.sortDir=1;
    state.shuffleOrder=null; state.navList=[]; state.current=null; state.currentSetlistId=LIBRARY_ID;
    await reloadData();                 // recreates an empty Library
    await applyTheme('dark');           // back to default theme
    // reset filter UI
    const si=$('#searchInput'); if(si) si.value='';
    const ss=$('#sortSelect'); if(ss) ss.value='custom';
    renderTagFilter(); renderDrawer(); renderLibrary();
    hideProgress();
    toast('App reset to a clean state');
  }catch(err){ console.error(err); hideProgress(); toast('Reset failed'); }
}

