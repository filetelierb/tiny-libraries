import { z } from 'zod';

export const localeSchema=z.enum(['en','es']);
export type Locale=z.infer<typeof localeSchema>;
export const kindSchema=z.enum(['video','audio','pdf','image','markdown','text']);
export type Kind=z.infer<typeof kindSchema>;
export const sourceSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),name:z.string().min(1).max(240),folder:z.string().max(240),kind:kindSchema,mime:z.string(),size:z.number().int().nonnegative(),archived:z.boolean(),reviewed:z.boolean(),createdAt:z.string()});
export type Source=z.infer<typeof sourceSchema>;
export const segmentSchema=z.object({id:z.string().min(1),text:z.string(),page:z.number().int().positive().optional(),start:z.number().nonnegative().optional(),end:z.number().nonnegative().optional()});
export type Segment=z.infer<typeof segmentSchema>;
export const questionSchema=z.object({id:z.string(),prompt:z.string(),choices:z.array(z.string()).min(2).max(5),correctIndex:z.number().int().min(0).max(4),explanation:z.string(),concept:z.string(),segmentIds:z.array(z.string()).min(1)});
export type Question=z.infer<typeof questionSchema>;
export const synthesisSchema=z.object({
  title:z.string(),chapters:z.array(z.object({id:z.string(),title:z.string(),summary:z.string(),segmentIds:z.array(z.string()).min(1),questions:z.array(questionSchema).min(1).max(3)})).min(1).max(12),
  glossary:z.array(z.object({term:z.string(),definition:z.string(),segmentIds:z.array(z.string()).min(1)})).max(40),
});
export type Synthesis=z.infer<typeof synthesisSchema>;
export type PublicQuestion=Omit<Question,'correctIndex'|'explanation'>;
export type PublicSynthesis=Omit<Synthesis,'chapters'>&{chapters:Array<Omit<Synthesis['chapters'][number],'questions'>&{questions:PublicQuestion[]}>};
export type Learning={sourceId:string;sourceVersion:number;model:string;locale:Locale;segments:Segment[];synthesis:Synthesis;createdAt:string};
export type PublicLearning=Omit<Learning,'synthesis'>&{synthesis:PublicSynthesis};
export type Bookmark={id:string;sourceId:string;label:string;seconds?:number;page?:number};
export type Note={id:string;sourceId:string;text:string;createdAt:string};
export const sessionSchema=z.object({id:z.string().uuid(),name:z.string().min(1).max(160),tabs:z.array(z.string()).max(50),active:z.string().nullable(),split:z.string().nullable(),positions:z.record(z.string(),z.number().nonnegative()),notes:z.array(z.object({id:z.string(),sourceId:z.string(),text:z.string().max(20000),createdAt:z.string()})).max(1000),bookmarks:z.array(z.object({id:z.string(),sourceId:z.string(),label:z.string().max(240),seconds:z.number().optional(),page:z.number().optional()})).max(1000),createdAt:z.string()});
export type StudySession=z.infer<typeof sessionSchema>;
export type Attempt={id:string;sourceId:string;sourceVersion:number;questionId:string;concept:string;selected:number;correct:boolean;explanation:string;segmentIds:string[];createdAt:string};
export type Job={id:string;sourceId:string;sourceVersion:number;locale:Locale;status:'queued'|'running'|'partial'|'completed'|'failed'|'cancelled';stage:'normalize'|'transcribe'|'translate'|'synthesize'|'done';completedChunks:number;totalChunks:number;attempts:number;error?:string;createdAt:string};
export type Settings={configured:boolean;locale:Locale;model:string;keySuffix?:string};
export type Catalog={files:Source[];sessions:StudySession[];attempts:Attempt[];settings:Settings};
export const MAX_FILE_BYTES=512*1024*1024;
export function kindFor(name:string):Kind|null {
  const ext=name.split('.').pop()?.toLowerCase();
  if(['mp4','webm','mov','mkv'].includes(ext||''))return 'video';
  if(['wav','mp3','m4a','ogg','flac'].includes(ext||''))return 'audio';
  if(ext==='pdf')return 'pdf';
  if(['png','jpg','jpeg','webp'].includes(ext||''))return 'image';
  if(ext==='md')return 'markdown';
  if(['txt','csv'].includes(ext||''))return 'text';
  return null;
}
export const fold=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();
export function validateSynthesis(value:unknown,segments:Segment[]):Synthesis {
  const parsed=synthesisSchema.parse(value),ids=new Set(segments.map(s=>s.id));
  const seen=new Set<string>();
  for(const chapter of parsed.chapters){
    if(seen.has(chapter.id))throw new Error('Duplicate chapter identity');seen.add(chapter.id);
    for(const id of chapter.segmentIds)if(!ids.has(id))throw new Error('Unresolvable chapter reference');
    for(const q of chapter.questions){
      if(q.correctIndex>=q.choices.length)throw new Error('Invalid question solution');
      for(const id of q.segmentIds)if(!ids.has(id))throw new Error('Unresolvable question reference');
    }
  }
  const questionIds=parsed.chapters.flatMap(c=>c.questions.map(q=>q.id));
  if(new Set(questionIds).size!==questionIds.length)throw new Error('Duplicate question identity');
  for(const term of parsed.glossary)for(const id of term.segmentIds)if(!ids.has(id))throw new Error('Unresolvable glossary reference');
  const terms=new Map<string,Synthesis['glossary'][number]>();
  for(const term of parsed.glossary){const key=fold(term.term);if(!terms.has(key))terms.set(key,term);}
  return {...parsed,glossary:[...terms.values()]};
}
export function publicLearning(value:Learning):PublicLearning {
  return {...value,synthesis:{...value.synthesis,chapters:value.synthesis.chapters.map(c=>({...c,questions:c.questions.map(({correctIndex:_correct,explanation:_explanation,...q})=>q)}))}};
}
export function reviewSummary(attempts:Attempt[]) {
  const count=attempts.length,correct=attempts.filter(a=>a.correct).length;
  return {count,correct,percent:count?Math.round(correct/count*100):null,needsPractice:[...new Set(attempts.filter(a=>!a.correct).map(a=>a.concept))],evidence:count===0?'insufficient':count<3?'limited':'observed'};
}
export function captionTime(seconds:number,srt=false){const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${srt?',':'.'}${String(ms%1000).padStart(3,'0')}`;}
export function captions(segments:Segment[],srt=false){return `${srt?'':'WEBVTT\n\n'}${segments.filter(s=>s.start!=null&&s.end!=null).map((s,i)=>`${srt?i+1:s.id}\n${captionTime(s.start!,srt)} --> ${captionTime(s.end!,srt)}\n${s.text.replace(/-->/g,'→').replace(/\n\s*\n/g,'\n')}\n`).join('\n')}`;}
