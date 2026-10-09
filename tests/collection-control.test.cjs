const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const code=fs.readFileSync(path.join(root,'workers/meta-collector/entry.js'),'utf8');
function backend(){
 const c={Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,AbortSignal,crypto:require('node:crypto').webcrypto,btoa,atob,console:{log(){},error(){}},fetch:async()=>new Response('[]'),setTimeout,clearTimeout};
 vm.createContext(c);
 vm.runInContext(code.replace('export default {','globalThis.moduleDefault = {')+'\nglobalThis.T={BUILD_VERSION,expectedRounds,advanceProgress,activeTargets,campIndex,resolveSourceCamp,sourceCampCode,fetchMyVendor,fetchMetaByCodeChunks,ensureBatches,processBatch,runCollector,worker,metaPost,loadSchedule,storeFreshRows};',c);
 c.override=(name,value)=>{c.__replacement=value;vm.runInContext(name+'=globalThis.__replacement',c)};
 return c;
}
const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'dummy-key',CAMP_DIRECTORY:{listCamps:async()=>[]}};
const camps=[['광주1','CL04'],['광주2','CL14'],['군포1','SG33'],['대구1','CL01B'],['대구2','CL01A'],['대구3','CL18'],['대구4','CL12'],['대구5','CL25'],['동탄1','SG34']];
const master=camps.map(([camp,code])=>({camp,code,mb_camp:'본캠프'}));
const sample=(camp,code,n)=>({campInfo:{campCode:code,campName:camp},workerInfo:{coupangId:'driver'+n,workerName:'기사'+n,workSubRoutes:['126A01']},deliverySummary:{assignedCount:1,scannedCount:4,completedCount:5,impossibleCount:0,pddMissCount:0},freshbagSummary:{assignedCount:1,collectedCount:0}});
const batch=(wave='WAVE1')=>({id:'b',camp_code:'__ALL__',camp_name:'투네스트 전체',meta_camp_codes:camps.map(x=>x[1]),wave,schedule_date:'2026-10-09',meta_work_date:'2026-10-10',expected_rounds:wave==='WAVE1'?3:2,status:'collecting'});
test('source version and exact Chunwoo aggregate architecture',()=>{const t=backend().T;assert.match(t.BUILD_VERSION,/all-batch-v5/);assert.equal(t.expectedRounds({wave:'WAVE1'}),3);assert.equal(t.expectedRounds({wave:'WAVE2'}),2)});
test('nested source camp aliases resolve to nine camp names',()=>{const c=backend(),i=c.T.campIndex(master);for(const [name,code] of camps){const r=c.T.resolveSourceCamp({workerInfo:{workSubRoutes:['126A01']},campInfo:{campCode:code}},i,true);assert.equal(r.name,name);assert.equal(r.code,code)}});
test('a mobile camp code alias resolves to its parent camp',()=>{const c=backend(),i=c.T.campIndex([{camp:'동탄1',code:'SG34'},{camp:'동탄1',code:'MC12'}]);const x=c.T.resolveSourceCamp({campInfo:{campCode:'MC12'}},i,true);assert.equal(x.name,'동탄1')});
test('absent camp code is visible as unmapped, not invented as __ALL__',()=>{const c=backend();const r=c.T.resolveSourceCamp({workerInfo:{coupangId:'x'}},c.T.campIndex(master),true);assert.equal(r.code,'META_UNMAPPED')});
test('one __ALL__ batch bootstraps nine contracted camps and pauses legacy batches (without deletion)',async()=>{
 const c=backend(),calls=[],legacy=camps.map(([name,code])=>({camp_code:code,camp_name:name,status:'collecting',schedule_date:'2026-10-09',wave:'WAVE1'}));
 c.override('activeTargets',()=>[{date:'2026-10-09',wave:'WAVE1'}]);
 c.override('fetchMyVendor',async()=>({contractedCampCodes:camps.map(x=>x[1])}));
 c.override('sb',async(e,p,init={})=>{calls.push({p,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});if(p.startsWith('meta_realtime_batch?select'))return legacy;return []});
 const res=await c.T.ensureBatches(env,new Map(),[]);
 const inserted=calls.filter(x=>x.method==='POST');assert.equal(inserted.length,1);assert.equal(inserted[0].body.length,1);
 assert.equal(inserted[0].body[0].meta_camp_codes.length,9);assert.equal(inserted[0].body[0].expected_rounds,3);
 const paused=calls.filter(x=>x.method==='PATCH');assert.equal(paused.length,1);assert.match(paused[0].p,/camp_code=neq.__ALL__/);
 assert.equal(res[0].retired[0].count,9);
 assert(!calls.some(x=>x.method==='DELETE'));
});
test('existing aggregate avoids re-reading vendor /v1/my-vendor',async()=>{
 const c=backend(),calls=[];c.override('activeTargets',()=>[{date:'2026-10-09',wave:'WAVE1'}]);
 c.override('fetchMyVendor',async()=>{throw new Error('repeated my-vendor request')});
 c.override('sb',async(e,p,init={})=>{calls.push(p);return [{camp_code:'__ALL__',status:'collecting',schedule_date:'2026-10-09',wave:'WAVE1'}]});
 const res=await c.T.ensureBatches(env,new Map(),[]);assert.equal(res[0].created.length,0);assert.equal(calls.length,1)
});
test('multi-camp night collection saves nine real-camp driver rows in one upsert',async()=>{
 const c=backend(),calls=[];const readings=camps.map(([name,code],i)=>sample(name,code,i));
 c.override('assertCollecting',async()=>{});
 c.override('loadMaster',async()=>master);
 c.override('loadSchedule',async()=>[]);
 c.override('fetchMetaByCodeChunks',async(cookies,url,codes)=>{assert.equal(codes.length,9);return {success:true,body:{data:{content:readings}}}});
 c.override('sb',async(e,p,init={})=>{
   calls.push({p,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});
   if(p.startsWith('meta_realtime_current?select=meta_worker_key'))return readings.map((r,i)=>({meta_worker_key:'camp:'+camps[i][1]+'|coupang:driver'+i,driver_name:'기사'+i,work_completed_at:null}));
   return [];
 });
 const res=await c.T.processBatch(env,new Map(),batch(),[]);
 const write=calls.find(x=>x.p.startsWith('meta_realtime_current?on_conflict')&&x.method==='POST');
 assert(write);assert.equal(write.body.length,9);
 assert.equal(new Set(write.body.map(r=>r.camp_name)).size,9);assert(write.body.every(r=>r.current_round===1&&r.expected_rounds===3));
 assert(write.body.every(r=>r.camp_code!=='__ALL__'));
 assert(write.body.every(r=>r.meta_worker_key.startsWith('camp:')));
 assert(write.body.every(r=>r.extra_routes.length===0));
 assert.equal(res.resolved_camps,9);assert.equal(res.unmapped_workers,0);
 assert.equal(calls.filter(x=>x.p.startsWith('meta_realtime_current?on_conflict')).length,1);
 assert(calls.length<50);
});
test('day fresh status maps across nine camps with bounded requests',async()=>{
 const c=backend(),calls=[];c.override('assertCollecting',async()=>{});c.override('loadMaster',async()=>master);c.override('loadSchedule',async()=>[]);
 const rows=camps.map(([name,code],i)=>sample(name,code,i));
 c.override('fetchMetaByCodeChunks',async()=>({success:true,body:{data:{content:rows}}}));
 c.override('sb',async(e,p,init={})=>{calls.push({p,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});return []});
 const res=await c.T.processBatch(env,new Map(),batch('WAVE2'),[]);
 const fresh=calls.find(x=>x.p.startsWith('meta_realtime_fresh_current?on_conflict'));
 assert(fresh);assert.equal(fresh.body.length,9);assert.equal(new Set(fresh.body.map(r=>r.camp_name)).size,9);
 assert.equal(calls.filter(x=>x.p.startsWith('meta_realtime_fresh_current?batch_id=eq.')&&x.method==='DELETE').length,1);
 assert.equal(res.resolved_camps,9);assert(calls.length<50);
});
test('no admin authentication means collection control is rejected',async()=>{
 const c=backend(),r=await c.T.worker.fetch(new Request('https://w.test/collector/control',{method:'POST',body:'{"paused":true}'}),env,{});assert.equal(r.status,401);
});
test('pause state is respected before META or schema validation',async()=>{
 const c=backend();c.override('sessionState',async()=>({collector_paused:true}));c.override('ensureBatches',async()=>{throw new Error('should not query META while paused')});const x=await c.T.runCollector(env);assert.equal(x.paused,true)
});
test('HTTP META pagination reads all pages without silent truncation',async()=>{
 const c=backend();let calls=0;c.override('metaPage',async()=>{calls++;return {success:true,status:200,body:{data:{content:Array.from({length:calls<3?100:3},()=>({workerInfo:{coupangId:'id'}}))}}}});
 const r=await c.T.metaPost(new Map(),'https://test.test/meta',{campCodes:['CL04'],size:100,page:0});assert.equal(calls,3);assert.equal(r.body.data.content.length,203)
});
test('frontend aggregate current hides paused per-camp duplicates only after a successful poll',()=>{
 const frontend=fs.readFileSync(path.join(root,'public/realtime'),'utf8');
 assert(frontend.includes('aggregatedReady'));
 assert(frontend.includes('b.camp_code===\'__ALL__\''));
});
