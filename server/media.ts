import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kind, Segment } from '../shared/domain';

export const CHUNK_SECONDS=300;
export function command(binary:string,args:string[],timeout=180000):Promise<string>{
  return new Promise((resolve,reject)=>{const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']}),out:Buffer[]=[];let bytes=0;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${binary} exceeded the processing time limit`));},timeout);
    child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes<2*1024*1024)out.push(data);else child.kill('SIGKILL');});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(new Error(`${binary} is unavailable. Install it and retry.`));});
    child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(Buffer.concat(out).toString());else reject(new Error(`${binary} could not process this file`));});
  });
}
export async function normalize(directory:string,kind:Kind,mime:string){
  const input=join(directory,'original');
  if(kind==='video'||kind==='audio'){
    const probe=JSON.parse(await command('ffprobe',['-v','error','-show_entries','format=duration','-of','json',input]));const duration=Number(probe.format?.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>3600)throw new Error('Recordings must have a known duration of 60 minutes or less');
    await command('ffmpeg',['-nostdin','-v','error','-y','-i',input,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-map_metadata','-1','-f','segment','-segment_time',String(CHUNK_SECONDS),'-reset_timestamps','1',join(directory,'chunk-%03d.wav')]);
    const names=(await readdir(directory)).filter(n=>/^chunk-\d+\.wav$/.test(n)).sort();
    const chunks=[];
    for(let index=0;index<names.length;index++){if((await stat(join(directory,names[index]))).size>31*1024*1024)throw new Error('Normalized audio chunk exceeds the ASR limit');chunks.push({index,offset:index*CHUNK_SECONDS,duration:Math.min(CHUNK_SECONDS,duration-index*CHUNK_SECONDS)});}
    return {segments:[] as Segment[],chunks};
  }
  if(kind==='image'){
    if((await stat(input)).size>8*1024*1024)throw new Error('Images for AI preparation must be 8 MB or smaller');
    const buffer=await readFile(input);const contentType=mime.startsWith('image/')?mime:'image/png';
    return {segments:[{id:'image-1',text:'Original image. Interpret the supplied visual source; this label is not extracted text.'}],chunks:[],imageData:`data:${contentType};base64,${buffer.toString('base64')}`};
  }
  if(kind==='pdf'){
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(await readFile(input)),useSystemFonts:true});
    const document=await task.promise;
    try{
      if(document.numPages>100)throw new Error('PDFs must contain 100 pages or fewer');
      const segments:Segment[]=[];
      for(let page=1;page<=document.numPages;page++){
        const text=await (await document.getPage(page)).getTextContent();
        const value=text.items.map(i=>'str'in i?i.str:'').join(' ').trim();
        if(value)segments.push({id:`page-${page}`,text:value,page});
      }
      if(!segments.length)throw new Error('This PDF has no extractable text. Add page images to analyze a scanned document.');
      return {segments,chunks:[]};
    }finally{await task.destroy();}
  }
  if((await stat(input)).size>2*1024*1024)throw new Error('Text documents for preparation must be 2 MB or smaller');
  const value=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(input));
  const segments=value.match(/[\s\S]{1,4000}/g)?.map((text,i)=>({id:`section-${i+1}`,text}))||[];
  if(!value.trim())throw new Error('Document contains no text');return {segments,chunks:[]};
}
