import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, BookOpen, Download, Minus, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Source, PublicLearning, Segment } from '../shared/domain';
import { Button, Empty, IconButton } from './design/components';
import type { T } from './i18n';

export function Viewer({source,t,learning,position=0,onPosition,seek}:{source:Source;t:T;learning:PublicLearning|null;position?:number;onPosition:(value:number)=>void;seek:{value:number;nonce:number}|null}){
  const media=useRef<HTMLVideoElement&HTMLAudioElement>(null),[text,setText]=useState(''),[page,setPage]=useState(Math.max(1,Math.round(position)||1)),[zoom,setZoom]=useState(100),[speed,setSpeed]=useState(1),[track,setTrack]=useState('original');
  const url=`/api/files/${source.id}/content`;
  useEffect(()=>{if(source.kind==='text'||source.kind==='markdown'){const controller=new AbortController();fetch(url,{signal:controller.signal}).then(r=>r.text()).then(setText).catch(()=>{});return ()=>controller.abort();}},[source.id]);
  useEffect(()=>{if(!seek)return;if(media.current)media.current.currentTime=seek.value;else{setPage(Math.max(1,Math.round(seek.value)));onPosition(Math.max(1,Math.round(seek.value)));}},[seek?.nonce]);
  if(source.kind==='video'||source.kind==='audio'){
    const Tag=source.kind==='video'?'video':'audio';
    return <div className={`media-stage ${source.kind}`}><Tag key={`${source.id}-${track}`} ref={media} src={url} controls preload="metadata" playsInline aria-label={source.name} onLoadedMetadata={()=>{if(media.current){media.current.currentTime=position;media.current.playbackRate=speed;}}} onPause={()=>{if(media.current)onPosition(media.current.currentTime);}} onSeeked={()=>{if(media.current)onPosition(media.current.currentTime);}}><track key={track} kind="subtitles" label={track==='original'?t.original:t.translated} src={`/api/captions/${source.id}/${track}.vtt`} default/></Tag><div className="media-options"><label>{t.subtitle}<select value={track} onChange={e=>setTrack(e.target.value)}><option value="original">{t.original}</option><option value="translated">{t.translated}</option></select></label><label>{t.view}<select aria-label="Playback speed" value={speed} onChange={e=>{setSpeed(Number(e.target.value));if(media.current)media.current.playbackRate=Number(e.target.value);}}>{[.25,.5,.75,1,1.25,1.5,1.75,2,2.5,3,4].map(s=><option key={s} value={s}>{s}×</option>)}</select></label></div></div>;
  }
  if(source.kind==='pdf')return <div className="pdf-stage"><div className="pdf-controls"><IconButton label={t.back} disabled={page<=1} onClick={()=>{setPage(p=>p-1);onPosition(page-1);}}><ChevronLeft/></IconButton><label>{t.page}<input aria-label={t.page} type="number" min="1" value={page} onChange={e=>{const next=Math.max(1,Number(e.target.value));setPage(next);onPosition(next);}}/></label><IconButton label={t.page} onClick={()=>{setPage(p=>p+1);onPosition(page+1);}}><ChevronRight/></IconButton><IconButton label={t.zoom} onClick={()=>setZoom(z=>Math.max(25,z-25))}><Minus/></IconButton><span>{zoom}%</span><IconButton label={t.zoom} onClick={()=>setZoom(z=>Math.min(300,z+25))}><Plus/></IconButton></div><iframe title={source.name} src={`${url}#page=${page}&zoom=${zoom}`}/></div>;
  if(source.kind==='image')return <div className="image-stage"><img src={url} alt={source.name}/></div>;
  return <article className="document-reader">{source.kind==='markdown'?<Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>:<pre>{text}</pre>}</article>;
}
