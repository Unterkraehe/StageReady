/* ============================================================
   SNIPPET VIEW — AUDIO ENGINE
   ============================================================ */
const snippetView=$('#snippetView');
const audioEl=new Audio();
audioEl.preservesPitch=true; audioEl.mozPreservesPitch=true; audioEl.webkitPreservesPitch=true;
const player={ snip:null, url:null, ctx:null, peaks:null, duration:0,
  loopIn:null, loopOut:null, loopOn:false, raf:null, seeking:false, playedMarked:false };

const waveStage=$('#waveStage'), waveCanvas=$('#waveCanvas'), ctx2d=waveCanvas.getContext('2d');
const playhead=$('#playhead'), loopRegion=$('#loopRegion'), markerLayer=$('#markerLayer');
const loopHIn=$('#loopHandleIn'), loopHOut=$('#loopHandleOut');

function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

async function openSnippet(id, keepMini){
  const snip=state.byId[id]; if(!snip) return;
  player.snip=snip; state.current=id;
  if(!state.navList.includes(id)) state.navList=visibleSnippets().map(s=>s.id);
  $('#svName').textContent=snip.name;
  player.playedMarked=false;
  // audio source
  if(player.url) URL.revokeObjectURL(player.url);
  player.url=URL.createObjectURL(snip.audioFile);
  audioEl.src=player.url; audioEl.playbackRate=parseFloat($('#speedSlider').value);
  audioEl.preservesPitch=true; audioEl.mozPreservesPitch=true; audioEl.webkitPreservesPitch=true;
  // reset loop
  player.loopIn=null; player.loopOut=null; player.loopOn=false; player._lastT=null; setLoopRamp(0); updateLoopUI();
  player.peaks=null;
  snippetView.classList.add('show');
  ensureBackGuard();
  setMini(!!keepMini);
  renderNotes(); renderRecordings(); renderRatings(); renderStarInput(0);
  setPitch(snip.pitch||0,false);
  ensureAudioGraph();
  setVol(snip.gain||0,false);
  applyVolume();
  msMetadata(snip);
  updateNavButtons();
  drawWaveform(0); // placeholder
  loadWaveform(snip.audioFile);
}

async function loadWaveform(blob){
  try{
    if(!player.ctx) player.ctx=newPlaybackCtx();
    const ab=await blob.arrayBuffer();
    const audioBuf=await player.ctx.decodeAudioData(ab.slice(0));
    player.peaks=computePeaks(audioBuf, 900);
    if(player.snip && typeof player.snip.loudness!=='number'){
      const l=measureLoudness(audioBuf);
      if(l!==null){ player.snip.loudness=l; DB.put('snippets',player.snip); applyVolume(); }
    }
    if(state.current===player.snip.id) drawWaveform(progressFrac());
  }catch(err){ player.peaks=null; drawWaveform(progressFrac()); }
}
function computePeaks(buf, n){
  const ch=buf.numberOfChannels, len=buf.length, block=Math.floor(len/n)||1;
  const peaks=new Float32Array(n);
  const data=[]; for(let c=0;c<ch;c++) data.push(buf.getChannelData(c));
  for(let i=0;i<n;i++){
    let max=0; const start=i*block, end=Math.min(start+block,len);
    for(let j=start;j<end;j+=1){ let v=0; for(let c=0;c<ch;c++) v+=Math.abs(data[c][j]); v/=ch; if(v>max)max=v; }
    peaks[i]=max;
  }
  // normalize
  let mx=0; for(const p of peaks) if(p>mx)mx=p; if(mx>0) for(let i=0;i<n;i++) peaks[i]/=mx;
  return peaks;
}
function sizeCanvas(){
  const dpr=window.devicePixelRatio||1;
  const w=waveStage.clientWidth, h=waveStage.clientHeight;
  waveCanvas.width=w*dpr; waveCanvas.height=h*dpr;
  ctx2d.setTransform(dpr,0,0,dpr,0,0);
  return {w,h};
}
function drawWaveform(progress=0){
  const {w,h}=sizeCanvas();
  ctx2d.clearRect(0,0,w,h);
  const base=cssVar('--wave-base'), acc=cssVar('--accent'), acc2=cssVar('--accent-2');
  const mid=h/2;
  if(!player.peaks){
    // flat placeholder line
    ctx2d.strokeStyle=base; ctx2d.lineWidth=2; ctx2d.beginPath(); ctx2d.moveTo(0,mid); ctx2d.lineTo(w,mid); ctx2d.stroke();
    return;
  }
  const n=player.peaks.length, barW=Math.max(1,(w/n)*0.72), gap=w/n;
  const px=progress*w;
  for(let i=0;i<n;i++){
    const x=i*gap+gap/2;
    const amp=Math.max(2, player.peaks[i]*(h*0.46));
    ctx2d.fillStyle = x<=px? acc : base;
    if(x<=px && x>px-gap){ ctx2d.fillStyle=acc2; }
    ctx2d.fillRect(x-barW/2, mid-amp, barW, amp*2);
  }
}
function progressFrac(){ return player.duration? clamp(audioEl.currentTime/player.duration,0,1):0; }

/* ---------- transport ---------- */
function setPlayIcon(playing){
  $('#playIcon').innerHTML = playing? '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $('#playIcon').setAttribute('fill', playing?'currentColor':'currentColor');
  $('#miniPlayIcon').innerHTML = playing? '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>' : '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>';
}
$('#playIcon').setAttribute('fill','currentColor');
async function togglePlay(){
  if(!player.snip) return;
  if(player.ctx && player.ctx.state==='suspended') player.ctx.resume();
  if(audioEl.paused){
    // armed loop + starting outside the region → snap into the loop
    if(player.loopOn && player.loopIn!=null && player.loopOut!=null){
      const t=audioEl.currentTime;
      if(t<player.loopIn-0.01 || t>=player.loopOut-0.01){ audioEl.currentTime=player.loopIn; player._lastT=player.loopIn; }
    }
    try{ await audioEl.play(); }catch(e){ toast('Tap again to play'); }
  }
  else audioEl.pause();
}
audioEl.addEventListener('play',()=>{ setPlayIcon(true); markPlayed(); loop(); msPlayback('playing'); });
audioEl.addEventListener('pause',()=>{ setPlayIcon(false); msPlayback('paused'); });
audioEl.addEventListener('ended',()=>{ setPlayIcon(false); msPlayback('paused'); });
audioEl.addEventListener('loadedmetadata',()=>{ player.duration=audioEl.duration; $('#durTime').textContent=fmtTime(player.duration); $('#curTime').textContent='0:00'; updatePlayhead(); renderMarkers(); updateLoopUI(); msPosition(); });
audioEl.addEventListener('timeupdate',()=>{ checkLoopWrap(); if(!player.raf){ $('#curTime').textContent=fmtTime(audioEl.currentTime); updatePlayhead(); updateMiniInfo(); } });
audioEl.addEventListener('ratechange',msPosition);
audioEl.addEventListener('seeked',()=>{ player._lastT=audioEl.currentTime; msPosition(); });

/* ---------- Media Session: playback notification + hardware buttons ----------
   Lets Android's media notification / lockscreen / BT headset buttons control
   playback: play, pause, previous/next snippet, ±10s, and notification seek. */
function msPlayback(st){ if('mediaSession' in navigator){ try{ navigator.mediaSession.playbackState=st; }catch(e){} msPosition(); } }
function msPosition(){
  if(!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  try{
    if(isFinite(audioEl.duration) && audioEl.duration>0){
      navigator.mediaSession.setPositionState({ duration:audioEl.duration, playbackRate:audioEl.playbackRate||1, position:Math.min(audioEl.currentTime,audioEl.duration) });
    }
  }catch(e){}
}
function msMetadata(snip){
  if(!('mediaSession' in navigator) || !window.MediaMetadata) return;
  try{
    navigator.mediaSession.metadata=new MediaMetadata({
      title:snip.name,
      artist:(snip.tags&&snip.tags.length)? snip.tags.join(' · ') : 'Stage Ready',
      album:(getSetlist(state.currentSetlistId)||{}).name||'Library',
      artwork:[ {src:'icon-192.png',sizes:'192x192',type:'image/png'},
                {src:'icon-512.png',sizes:'512x512',type:'image/png'} ]
    });
  }catch(e){}
}
if('mediaSession' in navigator){
  const set=(a,fn)=>{ try{ navigator.mediaSession.setActionHandler(a,fn); }catch(e){} };
  set('play',()=>{ if(audioEl.paused) togglePlay(); });
  set('pause',()=>{ if(!audioEl.paused) audioEl.pause(); });
  set('previoustrack',()=>navSnippet(-1));
  set('nexttrack',()=>navSnippet(1));
  set('seekbackward',(d)=>skip(-(d&&d.seekOffset||10)));
  set('seekforward',(d)=>skip(d&&d.seekOffset||10));
  set('seekto',(d)=>{ if(d && typeof d.seekTime==='number'){ audioEl.currentTime=clamp(d.seekTime,0,player.duration||0); updatePlayhead(); msPosition(); } });
  set('stop',()=>{ audioEl.pause(); });
}

function checkLoopWrap(){
  const t=audioEl.currentTime;
  const prev=(player._lastT==null)? t : player._lastT;
  player._lastT=t;
  if(!player.loopOn || player.loopOut==null || audioEl.paused || audioEl.seeking) return;
  // wrap only when playback NATURALLY crosses the out point from inside the
  // region — a seek that lands beyond it must never yank the cursor back
  if(prev<player.loopOut && t>=player.loopOut && (t-prev)<=1.2){
    audioEl.currentTime=player.loopIn||0;
    player._lastT=audioEl.currentTime;
    if(player.loopRamp>0){
      const v=clamp(Math.round((audioEl.playbackRate+player.loopRamp)*100)/100,0.3,2.0);
      $('#speedSlider').value=v; audioEl.playbackRate=v; $('#speedVal').textContent=v.toFixed(2)+'x';
    }
  }
}
function loop(){
  cancelAnimationFrame(player.raf);
  const step=()=>{
    checkLoopWrap();
    $('#curTime').textContent=fmtTime(audioEl.currentTime);
    updatePlayhead();
    updateMiniInfo();
    if(!audioEl.paused){ player.raf=requestAnimationFrame(step); } else { player.raf=null; updatePlayhead(); }
  };
  player.raf=requestAnimationFrame(step);
}
function updatePlayhead(){ const f=progressFrac(); playhead.style.left=(f*100)+'%'; if(player.peaks) drawWaveform(f); }

async function markPlayed(){
  if(player.playedMarked||!player.snip) return; player.playedMarked=true;
  player.snip.lastPlayed=Date.now(); await DB.put('snippets',player.snip); renderLibrary();
}
function skip(sec){ audioEl.currentTime=clamp(audioEl.currentTime+sec,0,player.duration||0); updatePlayhead(); $('#curTime').textContent=fmtTime(audioEl.currentTime); }
function navSnippet(dir){
  const idx=state.navList.indexOf(state.current); if(idx<0) return;
  const ni=idx+dir; if(ni<0||ni>=state.navList.length){ toast(dir>0?'End of list':'Start of list'); return; }
  const wasPlaying=!audioEl.paused;
  const keepMini=snippetView.classList.contains('mini');
  openSnippet(state.navList[ni], keepMini).then(()=>{ if(wasPlaying) setTimeout(togglePlay,150); });
}
function updateNavButtons(){
  const idx=state.navList.indexOf(state.current);
  const dis=(b,v)=>{ b.disabled=v; b.style.opacity=v?.3:1; };
  dis($('#prevBtn'),idx<=0); dis($('#nextBtn'),idx<0||idx>=state.navList.length-1);
  dis($('#miniPrev'),idx<=0); dis($('#miniNext'),idx<0||idx>=state.navList.length-1);
}
$('#playBtn').onclick=togglePlay; $('#miniPlay').onclick=togglePlay;
$('#back10Btn').onclick=()=>skip(-10); $('#fwd10Btn').onclick=()=>skip(10);
$('#prevBtn').onclick=()=>navSnippet(-1); $('#nextBtn').onclick=()=>navSnippet(1);
$('#miniPrev').onclick=()=>navSnippet(-1); $('#miniNext').onclick=()=>navSnippet(1);

/* ---------- speed ---------- */
$('#speedSlider').addEventListener('input',e=>{
  const v=parseFloat(e.target.value); audioEl.playbackRate=v;
  audioEl.preservesPitch=true; audioEl.mozPreservesPitch=true; audioEl.webkitPreservesPitch=true;
  $('#speedVal').textContent=v.toFixed(2)+'x';
});

/* ---------- pitch shift (semitones, independent of tempo) ----------
   Granular dual-grain shifter inserted on a MediaElementSource. The
   <audio> element keeps tempo/seek/loop; this only re-pitches the stream
   (read pointer advances at ratio = 2^(semitones/12), output rate fixed,
   so tempo is unchanged). Two grains at 50% offset with an EQUAL-POWER
   crossfade hide the grain resets. Processing runs in an AudioWorklet
   (audio-render thread) so UI work never starves it → no stutter; an
   older-browser ScriptProcessor fallback uses the same maths.  */
const PITCH_WORKLET_SRC = `
/* Dual-tap delay-line pitch shifter with WSOLA-style correlation alignment.
   Each tap reads the ring at rate=ratio with a sin() equal-power envelope.
   When a tap's envelope reaches zero it is re-seated — not at a fixed delay,
   but at the position (searched by cross-correlation against the live tap's
   waveform) that best matches its phase. Coherent handoffs remove the
   comb/"fan" flutter on voices and keep low end defined. */
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [{name:'ratio',defaultValue:1,minValue:0.25,maxValue:4,automationRate:'k-rate'}]; }
  constructor(){
    super();
    const sr=sampleRate, s=sr/48000;
    this.L=1<<Math.ceil(Math.log2(16384*s));      // ring length (pow2)
    this.MASK=this.L-1;
    this.g=Math.round(0.09*sr);                    // grain period (samples)
    this.W=Math.round(1280*s);                     // correlation window (≥ one period at 40Hz)
    this.K=Math.round(1250*s);                     // max search lag ± (covers 40Hz phase)
    this.Dc=this.g+this.K+64;                      // reseat target delay
    this.r0=new Float32Array(this.L);
    this.r1=new Float32Array(this.L);
    this.w=0; this.primed=0;
    this.pos=[0,0]; this.ph=[0,0.5];
    this.seed=[false,false];
  }
  smp(buf,p){ const i0=Math.floor(p), f=p-i0; const a=buf[i0&this.MASK], b=buf[(i0+1)&this.MASK]; return a+(b-a)*f; }
  reseat(t){
    const other=1-t, r0=this.r0, MASK=this.MASK, W=this.W, K=this.K;
    const ideal=this.w-this.Dc;
    if(this.primed<this.Dc+K+W){ this.pos[t]=ideal; return; }   // not enough history yet
    const ref=Math.floor(this.pos[other]);
    let bestK=0, best=-1e30;
    for(let pass=0;pass<2;pass++){
      const step=pass?1:6;
      const lo=pass? Math.max(-K,bestK-6) : -K;
      const hi=pass? Math.min(K,bestK+6) : K;
      for(let k=lo;k<=hi;k+=step){
        let num=0, e1=0, e2=0;
        const a0=ideal+k;
        for(let j=0;j<W;j+=2){                     // stride 2: half cost, ample data
          const x=r0[(a0+j)&MASK], y=r0[(ref+j)&MASK];
          num+=x*y; e1+=x*x; e2+=y*y;
        }
        const sc=num/Math.sqrt(e1*e2+1e-9);
        if(sc>best){ best=sc; bestK=k; }
      }
    }
    this.pos[t]=ideal+bestK;
  }
  process(inputs,outputs,parameters){
    const inp=inputs[0], out=outputs[0];
    const outL=out[0], outR=out[1]||out[0];
    const N=outL.length;
    const hasIn=inp&&inp.length>0&&inp[0]&&inp[0].length>0;
    const inL=hasIn?inp[0]:null, inR=hasIn?(inp[1]||inp[0]):null;
    const R=parameters.ratio.length>0?parameters.ratio[0]:1;
    const r0=this.r0, r1=this.r1, MASK=this.MASK, g=this.g, PI=Math.PI, OUT=0.95;
    for(let i=0;i<N;i++){
      const sL=inL?inL[i]:0, sR=inR?inR[i]:sL;
      r0[this.w&MASK]=sL; r1[this.w&MASK]=sR;
      this.w++; this.primed++;
      let oL=0, oR=0;
      for(let t=0;t<2;t++){
        this.ph[t]+=1/g;
        if(this.ph[t]>=1){ this.ph[t]-=1; this.reseat(t); this.seed[t]=true; }
        else if(!this.seed[t]){ this.pos[t]=this.w-this.Dc-(t?0:g*0.5); this.seed[t]=this.ph[t]<1; }
        const e=0.5-0.5*Math.cos(2*PI*this.ph[t]);   // Hann @50% offset: exact COLA for aligned taps
        // clamp read into valid past
        let p=this.pos[t];
        const minP=this.w-this.L+8, maxP=this.w-2;
        if(p<minP){ p=minP; this.pos[t]=p; }
        if(p>maxP){ p=maxP; this.pos[t]=p; }
        oL+=this.smp(r0,p)*e; oR+=this.smp(r1,p)*e;
        this.pos[t]+=R;
      }
      outL[i]=oL*OUT; outR[i]=oR*OUT;
    }
    return true;
  }
}
registerProcessor('pitch-processor', PitchProcessor);
`;

const pitch={ src:null, node:null, kind:null, on:false, ratio:1, semis:0,
  built:false, building:false,
  ring:null, ringL:0, g:0, wIdx:0, n:0, _save:null };

/* Playback AudioContext: latencyHint 'playback' = large render buffers.
   Critical for Bluetooth output on Android — BT sinks add big, jittery
   latency that starves small 'interactive' buffers and causes stutter.
   Extra latency is irrelevant for song playback. */
function newPlaybackCtx(){
  const AC=window.AudioContext||window.webkitAudioContext;
  try{ return new AC({latencyHint:'playback'}); }catch(e){ return new AC(); }
}
/* ---------- audio graph: src → gain → [pitch] → limiter → out ----------
   The gain stage applies automatic loudness matching (per-snippet measured
   RMS vs a common target) plus the user's per-snippet volume trim. The
   limiter safely absorbs boosted peaks. */
const graph={ src:null, gain:null, limiter:null, built:false };
const LOUD_TARGET=-16;                 // dBFS gated-RMS target
const dB2lin=db=>Math.pow(10,db/20);
function ensureAudioGraph(){
  if(graph.built) return true;
  try{
    if(!player.ctx) player.ctx=newPlaybackCtx();
    graph.src=player.ctx.createMediaElementSource(audioEl);
    graph.gain=player.ctx.createGain();
    const lim=player.ctx.createDynamicsCompressor();
    lim.threshold.value=-3; lim.knee.value=1; lim.ratio.value=16;
    lim.attack.value=0.002; lim.release.value=0.12;
    graph.limiter=lim;
    graph.built=true;
    routeGraph();
  }catch(e){ console.warn('Audio graph unavailable:',e); graph.built=false; }
  return graph.built;
}
function routeGraph(){
  if(!graph.built) return;
  [graph.src,graph.gain,pitch.node,graph.limiter].forEach(n=>{ try{ if(n) n.disconnect(); }catch(e){} });
  graph.src.connect(graph.gain);
  if(pitch.on && pitch.node){ graph.gain.connect(pitch.node); pitch.node.connect(graph.limiter); }
  else graph.gain.connect(graph.limiter);
  graph.limiter.connect(player.ctx.destination);
}
function applyVolume(){
  if(!graph.built || !player.snip) return;
  let db=player.snip.gain||0;                                    // manual trim
  if(state.autoLoud!==false && typeof player.snip.loudness==='number'){
    db+=clamp(LOUD_TARGET-player.snip.loudness,-12,12);          // auto match
  }
  const v=dB2lin(clamp(db,-24,18));
  try{ graph.gain.gain.setTargetAtTime(v,player.ctx.currentTime,0.03); }catch(e){ graph.gain.gain.value=v; }
}
function measureLoudness(buf){
  // gated RMS: 400ms windows, ignore near-silence, average in power domain
  const ch=buf.numberOfChannels, sr=buf.sampleRate, W=Math.round(0.4*sr);
  const d=[]; for(let c=0;c<ch;c++) d.push(buf.getChannelData(c));
  const pows=[];
  for(let s=0;s+W<=buf.length;s+=W){
    let p=0;
    for(let c=0;c<ch;c++){ const a=d[c]; for(let i=s;i<s+W;i++) p+=a[i]*a[i]; }
    pows.push(p/(W*ch));
  }
  if(!pows.length) return null;
  const gate=Math.pow(10,-40/10);
  const used=pows.filter(p=>p>gate);
  const mean=(used.length?used:pows).reduce((a,b)=>a+b,0)/(used.length?used.length:pows.length);
  return Math.round(10*Math.log10(mean+1e-12)*10)/10;   // dBFS RMS, 0.1 precision
}

async function ensurePitchGraph(){
  if(pitch.built) return true;
  if(pitch.building) return false;
  pitch.building=true;
  try{
    ensureAudioGraph();
    if(player.ctx.audioWorklet && typeof AudioWorkletNode!=='undefined'){
      const url=URL.createObjectURL(new Blob([PITCH_WORKLET_SRC],{type:'application/javascript'}));
      await player.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      pitch.node=new AudioWorkletNode(player.ctx,'pitch-processor',
        {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'});
      pitch.kind='worklet';
    } else {
      const sr=player.ctx.sampleRate;
      pitch.g=Math.round(0.092*sr); pitch.ringL=pitch.g*2+Math.round(0.18*sr);
      pitch.ring=[new Float32Array(pitch.ringL),new Float32Array(pitch.ringL)];
      pitch.wIdx=0; pitch.n=0;
      pitch.node=player.ctx.createScriptProcessor(2048,2,2);
      pitch.node.onaudioprocess=processPitchSP;
      pitch.kind='sp';
    }
    pitch.built=true;
  }catch(e){ console.warn('Pitch engine unavailable:',e); pitch.built=false; }
  pitch.building=false;
  applyRatio(); routeGraph();
  return pitch.built;
}
function routePitch(){ routeGraph(); }
function applyRatio(){
  if(!pitch.node) return;
  if(pitch.kind==='worklet'){
    const p=pitch.node.parameters.get('ratio');
    if(p){ try{ p.setTargetAtTime(pitch.ratio, player.ctx.currentTime, 0.03); }catch(e){ p.value=pitch.ratio; } }
  }
  // SP fallback reads pitch.ratio directly in processPitchSP
}
function sampleRing(buf,pos,L){
  let x=pos; while(x<0)x+=L; while(x>=L)x-=L;
  const i0=Math.floor(x), frac=x-i0; let i1=i0+1; if(i1>=L)i1-=L;
  return buf[i0]*(1-frac)+buf[i1]*frac;
}
function processPitchSP(e){
  const ib=e.inputBuffer, ob=e.outputBuffer;
  const inL=ib.getChannelData(0);
  const inR=ib.numberOfChannels>1?ib.getChannelData(1):inL;
  const outL=ob.getChannelData(0), outR=ob.getChannelData(1);
  const r0=pitch.ring[0], r1=pitch.ring[1], L=pitch.ringL, g=pitch.g;
  const R=pitch.ratio, up=R>1, depth=Math.abs(1-R)*g, PI=Math.PI, OUT=0.9;
  const N=inL.length;
  let w=pitch.wIdx, n=pitch.n;
  for(let i=0;i<N;i++){
    r0[w]=inL[i]; r1[w]=inR[i];
    const p=n/g; let pB=p+0.5; if(pB>=1)pB-=1;
    const dA=up?depth*(1-p):depth*p;
    const dB=up?depth*(1-pB):depth*pB;
    const eA=Math.sin(PI*p), eB=Math.sin(PI*pB);   // equal power
    outL[i]=(sampleRing(r0,w-dA,L)*eA+sampleRing(r0,w-dB,L)*eB)*OUT;
    outR[i]=(sampleRing(r1,w-dA,L)*eA+sampleRing(r1,w-dB,L)*eB)*OUT;
    w++; if(w>=L)w=0;
    n++; if(n>=g)n=0;
  }
  pitch.wIdx=w; pitch.n=n;
}
function setPitch(semis,persist){
  semis=clamp(Math.round(semis),-12,12);
  pitch.semis=semis; pitch.ratio=Math.pow(2,semis/12);
  $('#pitchSlider').value=semis;
  $('#pitchVal').textContent = semis>0?('+'+semis+' st'):(semis<0?(semis+' st'):'0');
  const want=semis!==0;
  if(player.ctx && player.ctx.state==='suspended') player.ctx.resume();
  if(want && !pitch.built){
    ensurePitchGraph().then(ok=>{
      if(!ok){ toast('Pitch shift not supported here'); return; }
      pitch.on = pitch.semis!==0;
      applyRatio(); routePitch();
      if(player.ctx.state==='suspended') player.ctx.resume();
    });
  } else {
    pitch.on = want && pitch.built;
    applyRatio(); routePitch();
  }
  if(persist && player.snip){ player.snip.pitch=semis; clearTimeout(pitch._save); pitch._save=setTimeout(()=>DB.put('snippets',player.snip),300); }
}
$('#pitchSlider').addEventListener('input',e=>setPitch(+e.target.value,true));
$('#pitchUp').onclick=()=>setPitch(pitch.semis+1,true);
$('#pitchDown').onclick=()=>setPitch(pitch.semis-1,true);

/* per-snippet volume trim (dB) on top of automatic loudness matching */
let _volSave=null;
function setVol(db,persist){
  db=clamp(Math.round(db),-12,12);
  $('#volSlider').value=db;
  $('#volVal').textContent = db>0?('+'+db+' dB'):(db<0?(db+' dB'):'0');
  if(player.snip){
    player.snip.gain=db;
    ensureAudioGraph(); applyVolume();
    if(persist){ clearTimeout(_volSave); _volSave=setTimeout(()=>DB.put('snippets',player.snip),300); }
  }
}
$('#volSlider').addEventListener('input',e=>setVol(+e.target.value,true));
$('#volUp').onclick=()=>setVol((player.snip&&player.snip.gain||0)+1,true);
$('#volDown').onclick=()=>setVol((player.snip&&player.snip.gain||0)-1,true);

/* loop ramp: raise playback speed by a fixed step on every loop wrap */
function setLoopRamp(v){
  player.loopRamp=clamp(Math.round(v*100)/100,0,0.2);
  $('#loopRampVal').textContent=player.loopRamp>0? ('+'+player.loopRamp.toFixed(2)+'x') : 'off';
}
$('#loopRampUp').onclick=()=>setLoopRamp((player.loopRamp||0)+0.01);
$('#loopRampDown').onclick=()=>setLoopRamp((player.loopRamp||0)-0.01);

/* ---------- waveform seek / scrub ---------- */
function fracFromX(clientX){ const r=waveStage.getBoundingClientRect(); return clamp((clientX-r.left)/r.width,0,1); }
let scrubbing=false;
waveStage.addEventListener('pointerdown',e=>{
  if(e.target.classList.contains('loop-handle')) return;
  if(e.target.closest('.marker-pin')) return;
  scrubbing=true; waveStage.setPointerCapture(e.pointerId);
  const f=fracFromX(e.clientX); audioEl.currentTime=f*(player.duration||0); updatePlayhead(); $('#curTime').textContent=fmtTime(audioEl.currentTime);
});
waveStage.addEventListener('pointermove',e=>{ if(!scrubbing) return; const f=fracFromX(e.clientX); audioEl.currentTime=f*(player.duration||0); updatePlayhead(); $('#curTime').textContent=fmtTime(audioEl.currentTime); });
waveStage.addEventListener('pointerup',e=>{ scrubbing=false; });
waveStage.addEventListener('pointercancel',()=>{ scrubbing=false; });

/* ---------- loop ---------- */
function updateLoopUI(){
  const d=player.duration||1;
  const hasRegion=player.loopIn!=null && player.loopOut!=null && player.loopOut>player.loopIn;
  if(hasRegion){
    loopRegion.classList.add('on');
    const a=player.loopIn/d*100, b=player.loopOut/d*100;
    loopRegion.style.left=a+'%'; loopRegion.style.width=(b-a)+'%';
    loopHIn.style.left='calc('+a+'% - 8px)'; loopHOut.style.left='calc('+b+'% - 8px)';
    loopHIn.style.display=loopHOut.style.display='block';
  } else if(player.loopIn!=null || player.loopOut!=null){
    // single point set: show just that handle as a preview
    loopRegion.classList.remove('on');
    const p=(player.loopIn!=null?player.loopIn:player.loopOut)/d*100;
    if(player.loopIn!=null){ loopHIn.style.left='calc('+p+'% - 8px)'; loopHIn.style.display='block'; loopHOut.style.display='none'; }
    else { loopHOut.style.left='calc('+p+'% - 8px)'; loopHOut.style.display='block'; loopHIn.style.display='none'; }
  } else {
    loopRegion.classList.remove('on'); loopHIn.style.display=loopHOut.style.display='none';
  }
  const tb=$('#loopToggleBtn');
  tb.textContent='Loop: '+(player.loopOn?'On':'Off');
  tb.classList.toggle('accent',player.loopOn);
  tb.classList.toggle('ghost',!player.loopOn);
  $('#loopRampRow').style.display=hasRegion?'flex':'none';
}
function setLoopPoint(which){
  const t=audioEl.currentTime;
  if(which==='in') player.loopIn=t; else player.loopOut=t;
  // both set but reversed → swap so In is always the earlier point
  if(player.loopIn!=null && player.loopOut!=null && player.loopOut<=player.loopIn){
    const a=Math.min(player.loopIn,player.loopOut), b=Math.max(player.loopIn,player.loopOut);
    if(b-a<0.05){ toast('In and out are the same spot'); if(which==='in') player.loopIn=null; else player.loopOut=null; }
    else { player.loopIn=a; player.loopOut=b; }
  }
  // arm automatically once a valid region exists
  player.loopOn = player.loopIn!=null && player.loopOut!=null && player.loopOut>player.loopIn;
  updateLoopUI();
}
$('#setInBtn').onclick=()=>setLoopPoint('in');
$('#setOutBtn').onclick=()=>setLoopPoint('out');
$('#loopToggleBtn').onclick=()=>{ if(player.loopIn==null||player.loopOut==null){ toast('Set loop in & out first'); return; } player.loopOn=!player.loopOn; updateLoopUI(); };
$('#clearLoopBtn').onclick=()=>{ player.loopIn=player.loopOut=null; player.loopOn=false; setLoopRamp(0); updateLoopUI(); };
function dragLoopHandle(handle,which){
  handle.addEventListener('pointerdown',e=>{
    e.stopPropagation(); handle.setPointerCapture(e.pointerId);
    const move=ev=>{ const t=fracFromX(ev.clientX)*(player.duration||0);
      if(which==='in') player.loopIn=clamp(t,0,(player.loopOut??player.duration)-0.05);
      else player.loopOut=clamp(t,(player.loopIn??0)+0.05,player.duration);
      updateLoopUI(); };
    const up=ev=>{ handle.releasePointerCapture(e.pointerId); handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',up); };
    handle.addEventListener('pointermove',move); handle.addEventListener('pointerup',up);
  });
}
dragLoopHandle(loopHIn,'in'); dragLoopHandle(loopHOut,'out');

/* ---------- markers ---------- */
function renderMarkers(){
  const snip=player.snip; if(!snip) return;
  markerLayer.innerHTML='';
  (snip.markers||[]).sort((a,b)=>a.time-b.time).forEach(m=>{
    const d=player.duration||1; const pct=clamp(m.time/d,0,1)*100;
    const pin=document.createElement('div'); pin.className='marker-pin'; pin.style.left=pct+'%';
    pin.innerHTML=`<div class="stem"></div><div class="dot"></div><div class="marker-tip">${escapeHtml(m.note||fmtTime(m.time))}</div>`;
    const tip=pin.querySelector('.marker-tip');
    pin.addEventListener('click',e=>{ e.stopPropagation();
      audioEl.currentTime=m.time; updatePlayhead(); $('#curTime').textContent=fmtTime(m.time);
      // toggle tooltip
      $$('.marker-tip').forEach(t=>{if(t!==tip)t.style.display='none';});
      tip.style.display=tip.style.display==='block'?'none':'block';
    });
    pin.addEventListener('dblclick',()=>editMarker(m));
    // long press to edit
    let lp; pin.addEventListener('pointerdown',()=>{ lp=setTimeout(()=>editMarker(m),550); });
    pin.addEventListener('pointerup',()=>clearTimeout(lp));
    pin.addEventListener('pointerleave',()=>clearTimeout(lp));
    markerLayer.appendChild(pin);
  });
  renderMarkerList();
}
function seekTo(t){ audioEl.currentTime=t; updatePlayhead(); $('#curTime').textContent=fmtTime(t); }
function renderMarkerList(){
  const box=$('#markerList'); if(!box) return;
  const snip=player.snip;
  const list=((snip&&snip.markers)||[]).slice().sort((a,b)=>a.time-b.time);
  box.innerHTML=list.map(m=>`<div class="mk-row" data-id="${m.id}">
    <span class="mk-dot"></span>
    <span class="mk-time">${fmtTime(m.time)}</span>
    <span class="mk-note">${escapeHtml(m.note||'Marker')}</span>
    <span class="mk-edit"><svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
  </div>`).join('');
  $$('.mk-row',box).forEach(row=>{
    const m=list.find(x=>x.id===row.dataset.id);
    row.querySelector('.mk-edit').addEventListener('click',ev=>{ ev.stopPropagation(); editMarker(m); });
    row.addEventListener('click',()=>seekTo(m.time));
  });
}
$('#addMarkerBtn').onclick=()=>{
  if(!player.snip) return;
  const t=audioEl.currentTime;
  openModal(`<div class="modal-head"><h3>Marker @ ${fmtTime(t)}</h3></div>
  <div class="modal-body"><div class="field"><label>Note</label><input type="text" id="mkNote" placeholder="e.g. tricky bend here" autofocus></div></div>
  <div class="modal-foot"><button class="btn ghost" id="_cancel">Cancel</button><button class="btn accent" id="_ok">Add marker</button></div>`);
  $('#_cancel').onclick=closeModal;
  $('#_ok').onclick=async()=>{ player.snip.markers.push({id:uid(),time:t,note:$('#mkNote').value.trim()}); await DB.put('snippets',player.snip); closeModal(); renderMarkers(); toast('Marker added'); };
};
function parseTimeStr(s){
  s=(s||'').trim(); if(!s) return NaN;
  if(s.includes(':')){ const p=s.split(':').map(x=>parseFloat(x)); if(p.some(isNaN)) return NaN; return p.reduce((a,v)=>a*60+v,0); }
  return parseFloat(s);
}
function editMarker(m){
  openModal(`<div class="modal-head"><h3>Edit marker</h3></div>
  <div class="modal-body">
    <div class="field"><label>Time (m:ss or seconds)</label><input type="text" id="mkTime" value="${fmtTime(m.time)}" inputmode="numeric"></div>
    <div class="field"><label>Note</label><input type="text" id="mkNote" value="${escapeHtml(m.note||'')}"></div>
  </div>
  <div class="modal-foot"><button class="btn danger" id="_del" style="margin-right:auto">Delete</button>
  <button class="btn ghost" id="_cancel">Cancel</button><button class="btn accent" id="_ok">Save</button></div>`);
  $('#_cancel').onclick=closeModal;
  $('#_ok').onclick=async()=>{
    const t=parseTimeStr($('#mkTime').value);
    if(isNaN(t)){ toast('Invalid time — use m:ss or seconds'); return; }
    m.time=clamp(t,0,player.duration||t);
    m.note=$('#mkNote').value.trim();
    player.snip.markers.sort((a,b)=>a.time-b.time);
    await DB.put('snippets',player.snip); closeModal(); renderMarkers();
  };
  $('#_del').onclick=async()=>{ player.snip.markers=player.snip.markers.filter(x=>x.id!==m.id); await DB.put('snippets',player.snip); closeModal(); renderMarkers(); };
}

/* ---------- collapse / mini-bar ---------- */
function updateMiniInfo(){
  if(!snippetView.classList.contains('mini')) return;
  const d=player.duration||audioEl.duration||0;
  let html=fmtTime(audioEl.currentTime)+' / '+fmtTime(d);
  const sp=parseFloat($('#speedSlider').value);
  if(Math.abs(sp-1)>0.001) html+='<span class="mtag">'+sp.toFixed(2).replace(/0$/,'')+'x</span>';
  if(pitch.semis) html+='<span class="mtag">'+(pitch.semis>0?'+':'')+pitch.semis+' st</span>';
  if(player.loopOn && player.loopIn!=null) html+='<span class="mtag">loop</span>';
  $('#miniSub').innerHTML=html;
  const f=d? clamp(audioEl.currentTime/d,0,1):0;
  $('#miniProgressFill').style.width=(f*100)+'%';
}
function setMini(on){
  snippetView.classList.toggle('mini',on);
  const fab=$('#fab');
  if(on){ fab.classList.remove('hidden'); fab.classList.add('lifted'); updateMiniInfo(); }
  else { fab.classList.add('hidden'); fab.classList.remove('lifted'); }
  syncBackGuard();
}
$('#svCollapseBtn').onclick=()=>setMini(true);
$('#svExpandBtn').onclick=()=>setMini(false);
$('#svTitleWrap').onclick=()=>{ if(snippetView.classList.contains('mini')) setMini(false); };
$('#miniClose').onclick=(e)=>{ e.stopPropagation(); closeSnippet(); };
$('#svName').addEventListener('click',()=>{ if(snippetView.classList.contains('mini')) setMini(false); });

/* ---------- snippet menu ---------- */
$('#svMenuBtn').onclick=()=>{
  const s=player.snip; if(!s) return;
  openModal(`<div class="modal-head"><h3>${escapeHtml(s.name)}</h3></div>
  <div class="modal-body" style="display:flex;flex-direction:column;gap:8px">
    <button class="btn" id="_edit" style="justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Edit name & tags</button>
    <button class="btn" id="_replace" style="justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>Replace audio file</button>
    <button class="btn" id="_close" style="justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>Close snippet</button>
    <button class="btn danger" id="_del" style="justify-content:flex-start"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>Delete snippet</button>
  </div>`);
  $('#_edit').onclick=()=>{ closeModal(); snippetEditorModal(s); };
  $('#_replace').onclick=()=>{ const inp=$('#audioFileInput'); inp.value=''; inp.onchange=async()=>{ if(inp.files[0]){ s.audioFile=inp.files[0]; s.audioType=inp.files[0].type; await DB.put('snippets',s); closeModal(); openSnippet(s.id); toast('Audio replaced'); } }; inp.click(); };
  $('#_close').onclick=()=>{ closeModal(); closeSnippet(); };
  $('#_del').onclick=async()=>{ if(await confirmDialog('Delete snippet?','This permanently deletes "'+s.name+'" and its audio, recordings and notes.')){ closeModal(); await deleteSnippet(s.id); closeSnippet(); } };
};
function closeSnippet(){ audioEl.pause(); snippetView.classList.remove('show','mini'); state.current=null; $('#fab').classList.remove('hidden','lifted'); releaseBackGuard(); }

window.addEventListener('resize',()=>{ if(state.current){ drawWaveform(progressFrac()); updateLoopUI(); renderMarkers(); } });
new ResizeObserver(()=>{ if(state.current) drawWaveform(progressFrac()); }).observe(waveStage);

