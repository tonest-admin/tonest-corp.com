const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const folder = process.env.TONEST_FIX_DIR || path.join(__dirname,'..');
const workerPath = process.env.TONEST_WORKER_PATH || path.join(folder,'workers','meta-collector','entry.js');
const htmlPath = process.env.TONEST_REALTIME_PATH || path.join(folder,'public','realtime');
const backend=fs.readFileSync(workerPath,'utf8'),front=fs.readFileSync(htmlPath,'utf8');
const extract=(str,start,end) => {
  const a=str.indexOf(start),b=str.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a, 'missing function bounds '+start);
  return str.slice(a,b);
};
const snapshotSource=extract(front,'function latestSuccessfulSnapshotRows(','function dedupeRows(');
const parseKst=v => {
  if(!v)return null;
  const s=String(v).trim().replace(' ','T');
  const d=new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s)?s:s+'+09:00');
  return Number.isFinite(d.getTime())?d:null;
};
const latestSuccessfulSnapshotRows= new Function('parseKst',snapshotSource+'\nreturn latestSuccessfulSnapshotRows;')(parseKst);
const latest={id:'batch1',status:'collecting',last_error:null,last_polled_at:'2026-11-06T14:35:58'};
const old={batch_id:'batch1',last_seen_at:'2026-11-06T09:20:57',work_completed_at:null,actual_routes:['503C01','503C02','503D01','503D02','506D01']};
const now={batch_id:'batch1',last_seen_at:'2026-11-06T14:35:58',work_completed_at:null,actual_routes:['503C01','503C02','503D01','503D02']};
test('UI hides the stale Gunpo1 route-key duplicate after a successful poll',()=>{
  assert.deepEqual(latestSuccessfulSnapshotRows([old,now],[latest]),[now]);
});
test('UI keeps previous snapshot if META poll failed or batch is finalized',()=>{
  assert.equal(latestSuccessfulSnapshotRows([old,now],[{...latest,status:'error'}]).length,2);
  assert.equal(latestSuccessfulSnapshotRows([old,now],[{...latest,status:'finalized'}]).length,2);
  assert.equal(latestSuccessfulSnapshotRows([old,now],[{...latest,last_error:'META failure'}]).length,2);
});
test('UI preserves completed workers for one hour',()=>{
  const kst = new Date(Date.now()+9*3600000).toISOString().slice(0,-1);
  const completed = {...old,work_completed_at:kst};
  assert.deepEqual(latestSuccessfulSnapshotRows([completed,now],[latest]),[completed,now]);
});
test('UI keeps last successful data when batch stops polling',()=>{
  assert.deepEqual(latestSuccessfulSnapshotRows([old],[{...latest,last_polled_at:old.last_seen_at}]),[old]);
});
test('UI inline scripts are syntactically valid',()=>{
  const scripts=[...front.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
     .map(m=>m[1]).filter(x=>x.trim());
  assert.ok(scripts.length>0);
  for(const body of scripts) assert.doesNotThrow(()=>new vm.Script(body));
});
test('backend paginates META workers without truncating a successful response',async()=>{
  const fnSource=extract(backend,'async function fetchMetaByCodeChunks(','function workerPayload(');
  const responses=[];
  const fetcher=new Function('uniq','metaPost','workerPayload','metaContent','metaFailure',fnSource+'\nreturn fetchMetaByCodeChunks;')(
    a=>[...new Set(a)],
    async (_cookies,_url,payload)=>{
      responses.push(payload.page);
      const count=payload.page===0?100:21;
      return {success:true,status:200,body:{data:{content:Array.from({length:count},(_,i)=>({id:payload.page*100+i}))}}};
    },
    (codes,wave,date,pdd)=>({campCodes:codes,waveCode:wave,workDate:date,pddTime:pdd,page:0,size:100}),
    b=>b.data.content,
    (r)=>new Error('META '+r.status)
  );
  const result=await fetcher({},'https://example.test/workers',['SG33'],'WAVE2','2026-11-06');
  assert.equal(result.count,121);
  assert.deepEqual(responses,[0,1]);
});
test('backend fails safely when META pagination does not complete',async()=>{
  const fnSource=extract(backend,'async function fetchMetaByCodeChunks(','function workerPayload(');
  const fetcher=new Function('uniq','metaPost','workerPayload','metaContent','metaFailure',fnSource+'\nreturn fetchMetaByCodeChunks;')(
    a=>[...new Set(a)],
    async()=>({success:true,status:200,body:{data:{content:Array(100).fill({})}}}),
    codes=>({campCodes:codes,page:0,size:100}),
    b=>b.data.content,
    ()=>new Error('META failure')
  );
  await assert.rejects(fetcher({},'https://example.test/workers',['SG33'],'WAVE2','2026-11-06'),/META_PAGINATION_INCOMPLETE/);
});
test('cleanup is gated on successful non-empty rows, keeps history and completion grace',()=>{
  assert.match(backend,/const staleCandidate=rows\.length>0/);
  assert.match(backend,/!byKey\.has\(r\.meta_worker_key\)/);
  assert.match(backend,/work_completed_at\.is\.null,work_completed_at\.lt\./);
  assert.match(backend,/await sbUpsert\(env, "meta_realtime_history", historyRows/);
});