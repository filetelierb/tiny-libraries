import { useState } from 'react';
import type { T } from './i18n';
import { Badge, Button } from './design/components';
import { Activity, RotateCcw } from 'lucide-react';

export function aliasFrequency(frequency:number,sampling:number){return Math.abs(((frequency+sampling/2)%sampling+sampling)%sampling-sampling/2);}
export function SignalExplorer({t,storageKey}:{t:T;storageKey:string}){
  const [parameters,setParameters]=useState<{frequency:number;sampling:number;amplitude:number}>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'null')||{frequency:8,sampling:12,amplitude:.8};}catch{return {frequency:8,sampling:12,amplitude:.8};}});
  const {frequency,sampling,amplitude}=parameters;
  const change=(key:keyof typeof parameters,value:number)=>{const next={...parameters,[key]:value};setParameters(next);localStorage.setItem(storageKey,JSON.stringify(next));};
  const x=(time:number)=>40+time*540,y=(value:number)=>130-value*85;
  const path=Array.from({length:601},(_,i)=>`${i?'L':'M'}${x(i/600)},${y(amplitude*Math.sin(2*Math.PI*frequency*i/600))}`).join(' ');
  const alias=aliasFrequency(frequency,sampling);
  return <article className="signal-explorer"><div className="section-label"><Activity size={16}/>{t.artifact}</div><h2>{t.example}</h2><p className="muted">{t.artifactBody}</p><svg viewBox="0 0 620 270" role="img" aria-label={`${t.frequency}: ${frequency} Hz; ${t.sampling}: ${sampling} Hz; ${t.alias}: ${alias} Hz`}><defs><pattern id="signal-grid" width="54" height="42.5" patternUnits="userSpaceOnUse"><path d="M54 0H0V42.5" fill="none" stroke="var(--border)" strokeWidth=".5"/></pattern></defs><rect x="40" y="30" width="540" height="200" fill="url(#signal-grid)"/><path d="M40 130H580" stroke="var(--border)"/><path d={path} fill="none" stroke="var(--primary)" strokeWidth="2"/>{Array.from({length:Math.floor(sampling)+1},(_,i)=><circle key={i} cx={x(i/sampling)} cy={y(amplitude*Math.sin(2*Math.PI*frequency*i/sampling))} r="4" fill="var(--folder)" stroke="var(--surface)" strokeWidth="1.5"/>)}<text x="40" y="252" fill="var(--muted-text)" fontSize="12">0 s</text><text x="560" y="252" fill="var(--muted-text)" fontSize="12">1 s</text></svg><div className="signal-controls">{([['frequency',t.frequency,1,24,.5,'Hz'],['sampling',t.sampling,2,60,1,'Hz'],['amplitude',t.amplitude,.1,1,.1,'']] as const).map(([key,label,min,max,step,unit])=><label key={key}>{label}<strong>{parameters[key]} {unit}</strong><input type="range" min={min} max={max} step={step} value={parameters[key]} onChange={e=>change(key,Number(e.target.value))}/></label>)}</div><div className="signal-result"><Badge tone={sampling<2*frequency?'warning':'success'}>{t.alias}: {alias.toFixed(1)} Hz</Badge><span className="muted">{t.persisted}</span><Button variant="ghost" onClick={()=>{const next={frequency:8,sampling:12,amplitude:.8};setParameters(next);localStorage.setItem(storageKey,JSON.stringify(next));}}><RotateCcw size={14}/>{t.reset}</Button></div></article>;
}
