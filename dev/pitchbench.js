// Usage: node pitchbench.js <path-to-04-player.js>
const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const m=src.match(/const PITCH_WORKLET_SRC = `([\s\S]*?)`;/);
if(!m){ console.error('worklet not found'); process.exit(1); }
global.AudioWorkletProcessor=class{}; global.sampleRate=48000; global.registerProcessor=()=>{};
eval(m[1].replace(/registerProcessor\([^;]*\);/,'')+';global.P=PitchProcessor;');
const sr=48000;

function run(signal, semis, secs){
  const R=Math.pow(2,semis/12), proc=new global.P();
  const block=128, blocks=Math.round(secs*sr/block);
  const out=new Float32Array(blocks*block);
  for(let b=0;b<blocks;b++){
    const inL=new Float32Array(block), inR=new Float32Array(block);
    for(let i=0;i<block;i++){ const t=(b*block+i)/sr; const v=signal(t); inL[i]=v; inR[i]=v; }
    const o=[new Float32Array(block),new Float32Array(block)];
    proc.process([[inL,inR]],[o],{ratio:[R]});
    out.set(o[0], b*block);
  }
  return out;
}
function envelopeRipple(out, skipSec){ // peak envelope per 6ms window; ripple = std/mean
  const W=Math.round(0.006*sr), start=Math.round(skipSec*sr);
  const env=[];
  for(let s=start;s+W<=out.length;s+=W){ let p=0; for(let i=s;i<s+W;i++) p=Math.max(p,Math.abs(out[i])); env.push(p); }
  const mean=env.reduce((a,b)=>a+b,0)/env.length;
  const sd=Math.sqrt(env.reduce((a,b)=>a+(b-mean)**2,0)/env.length);
  return {ripple:sd/mean, mean};
}
function freqOf(out, skipSec){ // zero crossings
  const start=Math.round(skipSec*sr); let cr=0, prev=0;
  for(let i=start;i<out.length;i++){ if(prev<=0&&out[i]>0)cr++; prev=out[i]; }
  return cr/((out.length-start)/sr);
}
const tone=f=>t=>0.5*Math.sin(2*Math.PI*f*t);
const rich=f=>t=>0.35*(Math.sin(2*Math.PI*f*t)+0.6*Math.sin(2*Math.PI*2*f*t)+0.4*Math.sin(2*Math.PI*3*f*t));
const vox=t=>0.28*(Math.sin(2*Math.PI*196*t)+0.8*Math.sin(2*Math.PI*392*t)+0.5*Math.sin(2*Math.PI*588*t)+0.35*Math.sin(2*Math.PI*784*t));
const bass=t=>0.4*(Math.sin(2*Math.PI*55*t)+0.5*Math.sin(2*Math.PI*110*t)+0.25*Math.sin(2*Math.PI*165*t));

console.log('signal        semis  ripple   freq-err');
for(const [name,sig,f0,semis] of [
  ['A4 sine',tone(440),440,3],
  ['A4 sine',tone(440),440,-4],
  ['rich 220',rich(220),220,5],
  ['vocal-ish',vox,196,3],
  ['vocal-ish',vox,196,-3],
  ['bass 55Hz',bass,55,-5],
  ['bass 55Hz',bass,55,4],
]){
  const out=run(sig,semis,3.0);
  const {ripple}=envelopeRipple(out,0.6);
  const fq=freqOf(out,0.6);
  const err=f0?1200*Math.log2(fq/(f0*Math.pow(2,semis/12))):0;
  console.log(`${name.padEnd(12)} ${String(semis).padStart(4)}  ${ripple.toFixed(3).padStart(6)}   ${err.toFixed(0).padStart(5)}c`);
}
// unity ratio passthrough sanity
const u=run(tone(440),0,1.5);
console.log('unity ripple:', envelopeRipple(u,0.4).ripple.toFixed(3));
