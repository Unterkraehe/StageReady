/* ============================================================
   NOTES
   ============================================================ */
function linkify(text){
  const esc=escapeHtml(text);
  return esc.replace(/((https?:\/\/|www\.)[^\s<]+)/g,(m)=>{ const href=m.startsWith('http')?m:'https://'+m; return `<a href="${href}" target="_blank" rel="noopener">${m}</a>`; });
}
function renderNotes(){
  const s=player.snip, body=$('#notesBody');
  const hasNotes=(s.notes||'').trim().length>0;
  body.innerHTML = `<div class="notes-render" id="notesRender">${hasNotes?linkify(s.notes):'<span class="muted">No notes yet. Add cues, lyrics, links…</span>'}</div>
    <div class="notes-edit-toggle"><button class="btn sm ghost" id="editNotesBtn"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Edit notes</button></div>`;
  $('#editNotesBtn').onclick=editNotes;
}
function editNotes(){
  const s=player.snip, body=$('#notesBody');
  body.innerHTML=`<textarea class="notes-area" id="notesArea" placeholder="Add cues, lyrics, links…">${escapeHtml(s.notes||'')}</textarea>
    <div class="notes-edit-toggle"><button class="btn sm ghost" id="cancelNotes">Cancel</button><button class="btn sm accent" id="saveNotes">Save</button></div>`;
  const ta=$('#notesArea');
  const autoH=()=>{ ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px'; };
  ta.addEventListener('input',autoH); autoH(); ta.focus();
  $('#cancelNotes').onclick=renderNotes;
  $('#saveNotes').onclick=async()=>{ s.notes=ta.value; await DB.put('snippets',s); renderNotes(); toast('Notes saved'); };
}

/* ============================================================
   RECORDINGS
   ============================================================ */
let mediaRec=null, recChunks=[], recStream=null, recStart=0, recTimerInt=null;
const recObjectUrls=[];
$('#recBtn').onclick=async()=>{
  if(mediaRec && mediaRec.state==='recording'){ mediaRec.stop(); return; }
  try{
    recStream=await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){ toast('Microphone permission needed'); return; }
  recChunks=[];
  let opts={}; if(MediaRecorder.isTypeSupported('audio/webm')) opts={mimeType:'audio/webm'};
  mediaRec=new MediaRecorder(recStream,opts);
  mediaRec.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
  mediaRec.onstop=async()=>{
    const blob=new Blob(recChunks,{type:mediaRec.mimeType||'audio/webm'});
    const dur=(Date.now()-recStart)/1000;
    player.snip.recordings.push({id:uid(),blob,timestamp:Date.now(),dur});
    await DB.put('snippets',player.snip);
    recStream.getTracks().forEach(t=>t.stop());
    $('#recBtn').classList.remove('recording'); clearInterval(recTimerInt); $('#recTimer').textContent='0:00'; $('#recHint').textContent='Tap to record practice take';
    renderRecordings(); toast('Take saved');
  };
  mediaRec.start(); recStart=Date.now();
  $('#recBtn').classList.add('recording'); $('#recHint').textContent='Recording… tap to stop';
  recTimerInt=setInterval(()=>{ $('#recTimer').textContent=fmtTime((Date.now()-recStart)/1000); },200);
};
function renderRecordings(){
  const s=player.snip, list=$('#recList');
  recObjectUrls.forEach(u=>URL.revokeObjectURL(u)); recObjectUrls.length=0;
  const recs=(s.recordings||[]).slice().sort((a,b)=>b.timestamp-a.timestamp);
  $('#recCount').textContent=recs.length;
  list.innerHTML=recs.length? '' : '<p class="muted" style="font-size:13px">No takes recorded.</p>';
  recs.forEach(r=>{
    const url=URL.createObjectURL(r.blob); recObjectUrls.push(url);
    const row=document.createElement('div'); row.className='media-row';
    row.innerHTML=`<span class="ts">${fmtDate(r.timestamp)}</span><audio controls src="${url}"></audio>
      <button class="icon-btn" style="width:34px;height:34px"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>`;
    row.querySelector('button').onclick=async()=>{ if(await confirmDialog('Delete take?','Remove this recording.')){ s.recordings=s.recordings.filter(x=>x.id!==r.id); await DB.put('snippets',s); renderRecordings(); } };
    list.appendChild(row);
  });
}

/* ============================================================
   RATINGS
   ============================================================ */
let pendingScore=0;
function renderStarInput(score){
  pendingScore=score;
  const box=$('#starInput'); box.innerHTML='';
  for(let i=1;i<=5;i++){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.innerHTML='<path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/>';
    if(i<=score) svg.classList.add('on');
    svg.onclick=()=>renderStarInput(i);
    box.appendChild(svg);
  }
}
function renderRatings(){
  const s=player.snip;
  const ratings=(s.ratings||[]).slice().sort((a,b)=>b.timestamp-a.timestamp);
  $('#rateCount').textContent=ratings.length;
  $('#rateHist').innerHTML=ratings.length? ratings.map(r=>`<div class="rate-hist">
    <div class="score">${r.score}</div>
    <div><div class="rn">${r.note?escapeHtml(r.note):'<span class="muted">No note</span>'}</div><div class="rt">${fmtDate(r.timestamp)}</div></div>
  </div>`).join('') : '<p class="muted" style="font-size:13px">No takes logged yet.</p>';
}
$('#submitRateBtn').onclick=async()=>{
  if(!player.snip) return;
  if(pendingScore<1){ toast('Pick a star rating'); return; }
  const note=$('#rateNote').value.trim();
  player.snip.ratings.push({id:uid(),score:pendingScore,note,timestamp:Date.now()});
  player.snip.lastPlayed=Date.now();
  await DB.put('snippets',player.snip);
  $('#rateNote').value=''; renderStarInput(0); renderRatings(); renderLibrary(); toast('Take logged');
};

/* ---------- card collapse ---------- */
$$('.card-head[data-toggle]').forEach(h=>h.addEventListener('click',()=>h.closest('.card').classList.toggle('collapsed')));
$('#recCard').classList.add('collapsed'); $('#rateCard').classList.add('collapsed');

