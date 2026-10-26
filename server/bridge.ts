import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_FILE_BYTES, kindSchema } from '../shared/domain';
import { normalize } from './media';
import { museStatus, codeSession } from './muse';
import { z } from 'zod';

export async function startBridge(token:string,root:string,port=9877){
  await mkdir(root,{recursive:true,mode:0o700});
  const server=createServer(async(req,res)=>{
    const send=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try{
      const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){send({error:'Unauthorized'},401);return;}
      const url=new URL(req.url||'/','http://127.0.0.1');
      const match=url.pathname.match(/^\/normalize\/([a-f0-9-]+-v\d+-(?:en|es))$/);
      if(match&&req.method==='POST'){
        const directory=join(root,match[1]);await mkdir(directory,{recursive:true,mode:0o700});
        try{const existing=await readFile(join(directory,'normalized.json'),'utf8');req.resume();send(JSON.parse(existing));return;}catch{}
        const handle=await open(join(directory,'upload.tmp'),'w',0o600);let bytes=0;
        try{for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>MAX_FILE_BYTES)throw new Error('File exceeds 512 MB');await handle.write(chunk);}}finally{await handle.close();}
        await rename(join(directory,'upload.tmp'),join(directory,'original'));
        const kind=kindSchema.parse(url.searchParams.get('kind'));
        const result=await normalize(directory,kind,String(req.headers['content-type']||''));
        await writeFile(join(directory,'normalized.json'),JSON.stringify(result),{mode:0o600});send(result);return;
      }
      const chunkMatch=url.pathname.match(/^\/chunks\/([a-f0-9-]+-v\d+-(?:en|es))\/(\d+)$/);
      if(chunkMatch){const data=await readFile(join(root,chunkMatch[1],`chunk-${chunkMatch[2].padStart(3,'0')}.wav`));res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':data.length});res.end(data);return;}
      if(url.pathname==='/api/code/status'){send(await museStatus());return;}
      if(url.pathname==='/api/code/sessions'&&req.method==='POST'){
        const parts:Buffer[]=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>16000)throw new Error('Prompt is too large');parts.push(Buffer.from(part));}
        const {prompt}=z.object({prompt:z.string().trim().min(1).max(8000)}).parse(JSON.parse(Buffer.concat(parts).toString()));
        send(await codeSession(join(root,'code'),prompt));return;
      }
      send({error:'Not found'},404);
    }catch(error){send({error:error instanceof Error?error.message:'Media operation failed'},422);}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server;
}
