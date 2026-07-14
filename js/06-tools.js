/* ============================================================
   TOOL PANELS (tuner / metronome) open-close
   ============================================================ */
function closeTools(keepGuard){ $('#tunerPanel').classList.remove('show'); $('#metroPanel').classList.remove('show'); $('#tunerBtn').classList.remove('active'); $('#metroBtn').classList.remove('active'); stopTuner(); if(!keepGuard) releaseBackGuard(); }
$$('[data-close-tool]').forEach(b=>b.onclick=()=>closeTools());
$('#tunerBtn').onclick=()=>{ const open=$('#tunerPanel').classList.contains('show'); if(open){ closeTools(); return; } closeTools(true); $('#tunerPanel').classList.add('show'); $('#tunerBtn').classList.add('active'); sizeTunerArc(); drawTunerArc(null); ensureBackGuard(); };
$('#metroBtn').onclick=()=>{ const open=$('#metroPanel').classList.contains('show'); if(open){ closeTools(); return; } closeTools(true); $('#metroPanel').classList.add('show'); $('#metroBtn').classList.add('active'); ensureBackGuard(); };

/* ============================================================
   TUNER
   ============================================================ */
const NOTE_NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
let tunerCtx=null, tunerAnalyser=null, tunerStream=null, tunerBuf=null, tunerRAF=null, tunerOn=false, refHz=440;
const tunerArc=$('#tunerArc'), tctx=tunerArc.getContext('2d');
const tuner={ freqEMA:0, cents:0, targetCents:0, needleCents:0, lastVoiced:0, lastDetect:0, jump:0 };
function sizeTunerArc(){ const dpr=window.devicePixelRatio||1; const w=tunerArc.clientWidth,h=tunerArc.clientHeight; tunerArc.width=w*dpr; tunerArc.height=h*dpr; tctx.setTransform(dpr,0,0,dpr,0,0); }
function drawTunerArc(needleCents, realCents){
  const w=tunerArc.clientWidth,h=tunerArc.clientHeight; tctx.clearRect(0,0,w,h);
  const cx=w/2, cy=h*0.95, R=Math.min(w/2,h)*0.92;
  const a0=Math.PI, a1=2*Math.PI;
  const col_bg=cssVar('--line-2'), col_ok=cssVar('--ok'), col_tick=cssVar('--txt-3'), col_acc=cssVar('--accent');
  tctx.lineWidth=10; tctx.lineCap='round';
  tctx.strokeStyle=col_bg; tctx.beginPath(); tctx.arc(cx,cy,R,a0,a1); tctx.stroke();
  // green in-tune band (±5 cents)
  const bandHalf=(5/100)*Math.PI;
  tctx.strokeStyle=col_ok; tctx.beginPath(); tctx.arc(cx,cy,R,1.5*Math.PI-bandHalf,1.5*Math.PI+bandHalf); tctx.stroke();
  // ticks every 10 cents
  for(let c=-50;c<=50;c+=10){ const ang=Math.PI+(c+50)/100*Math.PI, rr1=R-14, rr2=R+2;
    tctx.strokeStyle=col_tick; tctx.lineWidth=c===0?3:1.5; tctx.beginPath();
    tctx.moveTo(cx+Math.cos(ang)*rr1,cy+Math.sin(ang)*rr1); tctx.lineTo(cx+Math.cos(ang)*rr2,cy+Math.sin(ang)*rr2); tctx.stroke(); }
  // needle
  if(needleCents!=null){
    const inTune = realCents!=null && Math.abs(realCents)<5;
    const ang=Math.PI+(clamp(needleCents,-50,50)+50)/100*Math.PI;
    const col=inTune?col_ok:col_acc;
    if(inTune){ tctx.shadowColor=col_ok; tctx.shadowBlur=16; }
    tctx.strokeStyle=col; tctx.lineWidth=4; tctx.lineCap='round';
    tctx.beginPath(); tctx.moveTo(cx,cy); tctx.lineTo(cx+Math.cos(ang)*(R-6),cy+Math.sin(ang)*(R-6)); tctx.stroke();
    tctx.shadowBlur=0;
    tctx.fillStyle=col; tctx.beginPath(); tctx.arc(cx,cy,6,0,7); tctx.fill();
  } else {
    tctx.fillStyle=col_tick; tctx.beginPath(); tctx.arc(cx,cy,5,0,7); tctx.fill();
  }
}
/* YIN pitch detection — robust monophonic pitch, bounded to a musical range. */
function detectPitchYIN(buf, sr){
  const SIZE=buf.length;
  // remove DC offset (phone mics often have one; it corrupts the difference fn)
  let mean=0; for(let i=0;i<SIZE;i++) mean+=buf[i]; mean/=SIZE;
  let rms=0; for(let i=0;i<SIZE;i++){ const v=buf[i]-mean; buf[i]=v; rms+=v*v; }
  rms=Math.sqrt(rms/SIZE);
  if(rms<0.0022) return {freq:-1,conf:0};   // low gate: quiet acoustic signals are valid
  const minF=38, maxF=1500;
  const maxTau=Math.min(Math.floor(sr/minF),(SIZE>>1)-2);
  const minTau=Math.max(2,Math.floor(sr/maxF));
  const W=Math.min(SIZE-maxTau, 2200);   // ~2 periods at 38Hz for stable bass stats
  if(W<256) return {freq:-1,conf:0};
  const yin=new Float32Array(maxTau+1);
  for(let tau=minTau;tau<=maxTau;tau++){
    let sum=0; for(let j=0;j<W;j++){ const d=buf[j]-buf[j+tau]; sum+=d*d; }
    yin[tau]=sum;
  }
  // cumulative mean normalized difference
  let running=0; yin[0]=1;
  for(let tau=minTau;tau<=maxTau;tau++){ running+=yin[tau]; yin[tau]=running>0?yin[tau]*tau/running:1; }
  // absolute threshold → first dip
  const THRESH=0.15; let tau=-1;
  for(let t=minTau;t<=maxTau;t++){
    if(yin[t]<THRESH){ while(t+1<=maxTau && yin[t+1]<yin[t]) t++; tau=t; break; }
  }
  if(tau===-1){
    let best=minTau,bv=yin[minTau];
    for(let t=minTau+1;t<=maxTau;t++) if(yin[t]<bv){bv=yin[t];best=t;}
    tau=best; if(yin[tau]>0.5) return {freq:-1,conf:0};
  }
  // sub-octave check: with a weak fundamental (bass/guitar through a phone
  // mic) the first dip can land at half the true period (octave high). The
  // true period then has a *much deeper* dip at 2·tau. Only re-pick when the
  // current dip is imperfect AND the double lag is clearly deeper — for a
  // correct tau, yin[2·tau] is similar, not deeper.
  const tau2=tau*2;
  if(tau2+1<=maxTau && yin[tau]>0.02){
    let d2=tau2, dv=yin[tau2];
    if(yin[tau2-1]<dv){ d2=tau2-1; dv=yin[d2]; }
    if(yin[tau2+1]<dv){ d2=tau2+1; dv=yin[d2]; }
    if(dv < yin[tau]*0.5 && dv < THRESH) tau=d2;
  }
  // parabolic interpolation
  const x0=tau>minTau?yin[tau-1]:yin[tau], x2=tau+1<=maxTau?yin[tau+1]:yin[tau];
  const a=x0+x2-2*yin[tau], b=(x2-x0)/2;
  const betterTau=a?tau-b/(2*a):tau;
  const freq=sr/betterTau;
  if(freq<minF||freq>maxF) return {freq:-1,conf:0};
  return {freq, conf:1-yin[tau]};
}
function noteFromFreq(freq){
  const noteNum=12*Math.log2(freq/refHz)+69;
  const rounded=Math.round(noteNum);
  return { name:NOTE_NAMES[((rounded%12)+12)%12], octave:Math.floor(rounded/12)-1, cents:(noteNum-rounded)*100 };
}
function updateTunerReadout(){
  const f=tuner.freqEMA; if(f<=0) return;
  const n=noteFromFreq(f);
  tuner.cents=n.cents; tuner.targetCents=clamp(n.cents,-50,50);
  const inTune=Math.abs(n.cents)<5;
  const el=$('#tunerNote');
  el.innerHTML=`${n.name}<small>${n.octave}</small>`;
  el.style.color=inTune?cssVar('--ok'):cssVar('--txt');
  $('#tunerFreq').textContent=f.toFixed(1)+' Hz';
  const c=Math.round(n.cents);
  $('#centsRead').textContent = inTune? 'In tune' : `${c>0?'+':''}${c}¢ ${c>0?'sharp':'flat'}`;
  $('#centsRead').style.color = inTune?cssVar('--ok'):cssVar('--txt-2');
}
async function startTuner(){
  try{ tunerStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}}); }
  catch(e1){
    try{ tunerStream=await navigator.mediaDevices.getUserMedia({audio:true}); }
    catch(e2){ toast('Microphone permission needed'); return; }
  }
  tunerCtx=new (window.AudioContext||window.webkitAudioContext)();
  try{ if(tunerCtx.state==='suspended') await tunerCtx.resume(); }catch(e){}
  const src=tunerCtx.createMediaStreamSource(tunerStream);
  tunerAnalyser=tunerCtx.createAnalyser(); tunerAnalyser.fftSize=4096;
  tunerBuf=new Float32Array(tunerAnalyser.fftSize);
  src.connect(tunerAnalyser);
  tuner.freqEMA=0; tuner.cents=0; tuner.targetCents=0; tuner.needleCents=0; tuner.lastVoiced=0; tuner.lastDetect=0; tuner.jump=0;
  tunerOn=true;
  $('#tunerStartBtn').innerHTML='<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z" fill="currentColor" stroke="none"/></svg>Stop';
  $('#tunerFreq').textContent='Listening…';
  tunerLoop();
}
function stopTuner(){
  tunerOn=false; cancelAnimationFrame(tunerRAF);
  if(tunerStream){ tunerStream.getTracks().forEach(t=>t.stop()); tunerStream=null; }
  if(tunerCtx){ try{tunerCtx.close();}catch(e){} tunerCtx=null; }
  if($('#tunerStartBtn')) $('#tunerStartBtn').innerHTML='<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>Start';
}
function tunerLoop(){
  if(!tunerOn) return;
  const now=performance.now();
  // detection throttled to ~30 Hz (animation still 60fps)
  if(now-tuner.lastDetect>=45){
    tuner.lastDetect=now;
    tunerAnalyser.getFloatTimeDomainData(tunerBuf);
    const r=detectPitchYIN(tunerBuf,tunerCtx.sampleRate);
    if(r.freq>0 && r.conf>0.72){
      if(tuner.freqEMA<=0){ tuner.freqEMA=r.freq; }
      else {
        const ratio=r.freq/tuner.freqEMA;
        if(ratio>1.45||ratio<0.69){           // large jump → require 2 in a row before snapping (octave-error guard)
          if(++tuner.jump>=2){ tuner.freqEMA=r.freq; tuner.jump=0; }
        } else {
          tuner.jump=0;
          const moving=Math.abs(ratio-1)>0.012;
          const alpha=moving?0.4:0.16;          // responsive when moving, steady when settled
          tuner.freqEMA=tuner.freqEMA*(1-alpha)+r.freq*alpha;
        }
      }
      tuner.lastVoiced=now;
      updateTunerReadout();
    }
  }
  const idle = now-tuner.lastVoiced > 450;
  // glide needle toward target every frame
  tuner.needleCents += (tuner.targetCents - tuner.needleCents)*0.28;
  if(idle){
    drawTunerArc(null,null);
    if(now-tuner.lastVoiced>650){
      const el=$('#tunerNote'); el.textContent='—'; el.style.color=cssVar('--txt-3');
      $('#tunerFreq').textContent='Listening…';
      $('#centsRead').textContent='play a note'; $('#centsRead').style.color=cssVar('--txt-3');
      tuner.freqEMA=0;
    }
  } else {
    drawTunerArc(tuner.needleCents, tuner.cents);
  }
  tunerRAF=requestAnimationFrame(tunerLoop);
}
$('#tunerStartBtn').onclick=()=>{ tunerOn?stopTuner():startTuner(); };
$('#refHz').addEventListener('change',e=>{ refHz=clamp(parseInt(e.target.value)||440,400,480); e.target.value=refHz; if(tuner.freqEMA>0) updateTunerReadout(); });
$('#refUp').onclick=()=>{ refHz=clamp(refHz+1,400,480); $('#refHz').value=refHz; if(tuner.freqEMA>0) updateTunerReadout(); };
$('#refDown').onclick=()=>{ refHz=clamp(refHz-1,400,480); $('#refHz').value=refHz; if(tuner.freqEMA>0) updateTunerReadout(); };

/* ============================================================
   METRONOME
   ============================================================ */
const metro={ ctx:null, running:false, bpm:120, beats:4, sub:1, nextNoteTime:0, tick:0,
  timer:null, startTime:0, ramp:false, rampStart:100, rampEnd:160, rampSecs:60, queue:[] };
const SUBS=[{l:'1/4',v:1},{l:'1/8',v:2},{l:'Trip',v:3},{l:'1/16',v:4}];
function renderSubdiv(){
  $('#subdivRow').innerHTML=SUBS.map(s=>`<button class="chip ${metro.sub===s.v?'on':''}" data-sub="${s.v}">${s.l}</button>`).join('');
  $$('#subdivRow .chip').forEach(c=>c.onclick=()=>{ metro.sub=+c.dataset.sub; renderSubdiv(); });
}
function renderBeatLights(active=-1){
  const box=$('#beatLights'); if(box.children.length!==metro.beats){ box.innerHTML=''; for(let i=0;i<metro.beats;i++){ const d=document.createElement('div'); d.className='beat-dot'+(i===0?' accent':''); box.appendChild(d);} }
  [...box.children].forEach((d,i)=>d.classList.toggle('on',i===active));
}
function currentBpm(){
  if(!metro.ramp||!metro.running) return metro.bpm;
  const el=(metro.ctx.currentTime-metro.startTime);
  const t=clamp(el/metro.rampSecs,0,1);
  return Math.round(metro.rampStart+(metro.rampEnd-metro.rampStart)*t);
}
function scheduleClick(time,accent,onBeat){
  const o=metro.ctx.createOscillator(), g=metro.ctx.createGain();
  o.frequency.value=accent?1568:(onBeat?1175:840);
  g.gain.setValueAtTime(0,time);
  g.gain.linearRampToValueAtTime(accent?0.6:(onBeat?0.4:0.22),time+0.001);
  g.gain.exponentialRampToValueAtTime(0.0001,time+0.05);
  o.connect(g); g.connect(metro.ctx.destination); o.start(time); o.stop(time+0.06);
}
function scheduler(){
  while(metro.nextNoteTime < metro.ctx.currentTime+0.1){
    const totalTicks=metro.beats*metro.sub;
    const beatIndex=Math.floor(metro.tick/metro.sub);
    const onBeat=(metro.tick%metro.sub)===0;
    const accent=metro.tick===0;
    scheduleClick(metro.nextNoteTime,accent,onBeat);
    if(onBeat) metro.queue.push({beat:beatIndex,time:metro.nextNoteTime});
    const bpm=currentBpm(); $('#bpmVal').textContent=bpm; $('#bpmSlider').value=bpm; metro.bpm=metro.ramp?metro.bpm:bpm;
    const spt=60/bpm/metro.sub;
    metro.nextNoteTime+=spt;
    metro.tick=(metro.tick+1)%totalTicks;
  }
  metro.timer=setTimeout(scheduler,25);
}
function metroVisualLoop(){
  if(!metro.running) return;
  const now=metro.ctx.currentTime;
  while(metro.queue.length && metro.queue[0].time<=now){ const it=metro.queue.shift(); renderBeatLights(it.beat); }
  requestAnimationFrame(metroVisualLoop);
}
function startMetro(){
  metro.ctx=metro.ctx||new (window.AudioContext||window.webkitAudioContext)();
  if(metro.ctx.state==='suspended') metro.ctx.resume();
  metro.running=true; metro.tick=0; metro.queue=[];
  metro.startTime=metro.ctx.currentTime; metro.nextNoteTime=metro.ctx.currentTime+0.06;
  if(metro.ramp){ metro.rampStart=+$('#rampStart').value; metro.rampEnd=+$('#rampEnd').value; metro.rampSecs=Math.max(1,+$('#rampSecs').value); metro.bpm=metro.rampStart; }
  $('#metroStartBtn').innerHTML='<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z" fill="currentColor" stroke="none"/></svg>Stop';
  $('#metroStartBtn').classList.add('accent');
  scheduler(); metroVisualLoop();
}
function stopMetro(){
  metro.running=false; clearTimeout(metro.timer); renderBeatLights(-1);
  $('#metroStartBtn').innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/></svg>Start';
}
$('#metroStartBtn').onclick=()=>{ metro.running?stopMetro():startMetro(); };
$('#bpmSlider').addEventListener('input',e=>{ metro.bpm=+e.target.value; metro.ramp=false; $('#rampToggleRow').classList.remove('on'); $('#rampFields').style.display='none'; $('#bpmVal').textContent=metro.bpm; });
$('#beatsSlider').addEventListener('input',e=>{ metro.beats=+e.target.value; $('#beatsVal').textContent=metro.beats; renderBeatLights(-1); });
$('#rampToggleRow').onclick=()=>{ metro.ramp=!metro.ramp; $('#rampToggleRow').classList.toggle('on',metro.ramp); $('#rampFields').style.display=metro.ramp?'flex':'none'; };
let taps=[];
$('#tapTempoBtn').onclick=()=>{
  const now=performance.now(); taps.push(now); taps=taps.filter(t=>now-t<3000);
  if(taps.length>=2){ const intervals=[]; for(let i=1;i<taps.length;i++) intervals.push(taps[i]-taps[i-1]); const avg=intervals.reduce((a,b)=>a+b)/intervals.length; const bpm=clamp(Math.round(60000/avg),30,280); metro.bpm=bpm; metro.ramp=false; $('#rampToggleRow').classList.remove('on'); $('#rampFields').style.display='none'; $('#bpmSlider').value=bpm; $('#bpmVal').textContent=bpm; }
};

