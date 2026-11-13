import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'workers/coupang-camps/entry.js'),'utf8');
const frontend=fs.readFileSync(path.join(root,'public/coupang_camp'),'utf8');
const mock={source:[
 {id:1,camp:'대구3',mb_camp:'본캠프',code:'213',updated_at:'2026-11-13T12:00:00Z'},
 {id:2,camp:'일산2',mb_camp:'본캠프',code:'126',updated_at:'2026-11-13T12:00:00Z'}
],mirror:new Map(),logs:[],blockMirror:false};
const base='https://tenant.example';
const env={SUPABASE_URL:base,SUPABASE_SERVICE_ROLE:'fake-service',
 SUPABASE_PUBLISHABLE_KEY:'fake-public',MAROOWELL_API_KEY:'fake-maro',
 MAROOWELL_API_BASE:'https://source.example'};
function reset(){
 mock.source=[
 {id:1,camp:'대구3',mb_camp:'본캠프',code:'213',updated_at:'2026-11-13T12:00:00Z'},
 {id:2,camp:'일산2',mb_camp:'본캠프',code:'126',updated_at:'2026-11-13T12:00:00Z'}];
 mock.mirror.clear();mock.logs=[];mock.blockMirror=false;
}
const safeJson=(v,status=200)=>Response.json(v,{status});
async function fakeFetch(input,opt={}){
 const url=new URL(typeof input==='string'?input:input.url);
 const method=opt.method||'GET';
 if(url.hostname==='source.example'){
  if(url.pathname==='/api/v1/camps'&&method==='GET')return safeJson({rows:mock.source});
  if(url.pathname==='/api/v1/camps/batch'&&method==='POST'){
   const body=JSON.parse(opt.body),ins=body.inserts||[],updates=body.updates||[],dels=body.deletes||[];
   for(const id of dels)mock.source=mock.source.filter(r=>r.id!==id);
   for(const upd of updates){const r=mock.source.find(x=>x.id===upd.id);if(r)Object.assign(r,upd.payload,{updated_at:'2026-11-13T12:20:00Z'});}
   for(const item of ins)mock.source.push({...item,id:Math.max(0,...mock.source.map(x=>x.id))+1,updated_at:'2026-11-13T12:20:00Z'});
   return safeJson({ok:true,inserted:ins.length,updated:updates.length,deleted:dels.length});
  }
  if(url.pathname==='/api/v1/camps'&&method==='POST'){
   const row={...JSON.parse(opt.body),id:Math.max(0,...mock.source.map(x=>x.id))+1};
   mock.source.push(row);return safeJson({row});
  }
  const m=url.pathname.match(/^\/api\/v1\/camps\/(\d+)$/);
  if(m){const id=Number(m[1]);if(method==='DELETE'){const r=mock.source.find(x=>x.id===id);mock.source=mock.source.filter(x=>x.id!==id);return safeJson({deleted:true,row:r});}
    if(method==='PATCH'){const r=mock.source.find(x=>x.id===id);Object.assign(r,JSON.parse(opt.body));return safeJson({row:r});}}
  throw Error('unexpected source '+url.pathname+' '+method);
 }
 if(url.pathname==='/auth/v1/user')return safeJson({id:'user-1'});
 if(url.pathname==='/rest/v1/profiles')return safeJson([{role:'admin',status:'active'}]);
 const table=url.pathname.replace('/rest/v1/','');
 if(table==='camps_sync_runs'){
  if(method==='POST'){mock.logs.push(JSON.parse(opt.body));return new Response(null,{status:204});}
 }
 if(table==='camps_mirror'){
  if(method==='GET'){
   if(url.searchParams.get('select')==='source_payload')return safeJson([...mock.mirror.values()].map(r=>({source_payload:r.source_payload})));
   return safeJson([...mock.mirror.values()].map(r=>({source_id:r.source_id,row_hash:r.row_hash})));
  }
  if(mock.blockMirror)return safeJson({message:'blocked'},503);
  if(method==='POST'){
   for(const row of JSON.parse(opt.body))mock.mirror.set(row.source_id,row);
   return new Response(null,{status:204});
  }
  if(method==='DELETE'){
   const id=url.searchParams.get('source_id')||'';
   const ids=id.startsWith('eq.')?[Number(id.slice(3))]:[...id.matchAll(/\d+/g)].map(x=>Number(x[0]));
   for(const n of ids)mock.mirror.delete(n);
   return new Response(null,{status:204});
  }
 }
 throw Error('unexpected '+url+' '+method);
}
const sandbox={WorkerEntrypoint:class{},Request,Response,Headers,URL,URLSearchParams,
 TextEncoder,Uint8Array,crypto:webcrypto,console,fetch:fakeFetch};
sandbox.globalThis=sandbox;
const code=src.replace(/^import .+;\s*$/m,'').replace('export default {','globalThis.campsWorker = {').replace('export class RealtimeCampDirectory','class RealtimeCampDirectory');
vm.runInNewContext(code,sandbox);
const worker=sandbox.campsWorker;
const req=(path,method='GET',body)=>new Request('https://coupang-camps.tonest-admin.workers.dev'+path,{
 method,headers:{Authorization:'Bearer fake-token',Origin:'https://tonest-corp.com',...(body?{'Content-Type':'application/json'}:{})},
 ...(body?{body:JSON.stringify(body)}:{})
});
const send=async(path,body)=>worker.fetch(req(path,'POST',body),env,{waitUntil(){throw Error('write sync must be foreground')}});
test('batch add, edit and remove are verified in app mirror before success',async()=>{
 reset();
 let res=await send('/camps/reconcile');
 assert.equal(res.status,200);
 assert.equal((await res.json()).mirrorSynced,true);
 const changed={inserts:[{camp:'TEST',mb_camp:'본캠프'}],updates:[{id:1,payload:{code:'213Z'}}],deletes:[2]};
 res=await send('/camps/batch',changed);
 const body=await res.json();
 assert.equal(res.status,200);assert.equal(body.mirrorSynced,true);
 assert.equal(mock.mirror.size,2);
 assert.equal(mock.mirror.get(1).code,'213Z');
 assert.equal(mock.mirror.get(2).camp,'TEST');
 assert(![...mock.mirror.values()].some(r=>r.camp==='일산2'));
 assert(mock.logs.at(-1).status==='success');
});
test('mirror failure never produces a save-success response or replays source write',async()=>{
 reset();await send('/camps/reconcile');
 mock.blockMirror=true;
 const res=await send('/camps/batch',{inserts:[{camp:'ANOTHER',mb_camp:'본캠프'}],updates:[],deletes:[]});
 const body=await res.json();
 assert.equal(res.status,502);
 assert.equal(body.sourceSaved,true);
 assert.equal(body.mirrorSynced,false);
 assert.equal(mock.source.length,3);
 assert.equal(mock.mirror.size,2);
 mock.blockMirror=false;
 const retry=await send('/camps/reconcile');
 assert.equal((await retry.json()).mirrorSynced,true);
 assert.equal(mock.source.length,3);
 assert.equal(mock.mirror.size,3);
});
test('single POST PATCH DELETE also synchronize immediately',async()=>{
 reset();await send('/camps/reconcile');
 let r=await send('/camps',{camp:'TEST',mb_camp:'본캠프'});
 assert.equal((await r.json()).mirrorSynced,true);
 assert.equal(mock.mirror.get(3).camp,'TEST');
 r=await worker.fetch(req('/camps/3','PATCH',{code:'NEW'}),env,{waitUntil(){throw Error('background write sync')}});
 assert.equal((await r.json()).mirrorSynced,true);
 assert.equal(mock.mirror.get(3).code,'NEW');
 r=await worker.fetch(req('/camps/3','DELETE'),env,{waitUntil(){throw Error('background write sync')}});
 assert.equal((await r.json()).mirrorSynced,true);
 assert(!mock.mirror.has(3));
});
test('web UI treats partial success differently and exposes sync retry',()=>{
 assert(frontend.includes('id="btnMirrorSync"'));
 assert(frontend.includes('error?.sourceSaved'));
 assert(frontend.includes('"/camps/reconcile"'));
 assert(frontend.includes('result.mirrorSynced!==true'));
 for(const match of frontend.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
  if(match[1].trim())new vm.Script(match[1]);
 }
});
