import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import scheduleWorker from '../workers/schedule-api/worker.js';
import routeWorker from '../workers/route-info/entry.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const page=fs.readFileSync(path.join(root,'public/tonest_schedule'),'utf8');
const backend=fs.readFileSync(path.join(root,'workers/schedule-api/worker.js'),'utf8');
const parity=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/schedule-source-parity.json'),'utf8'));
const origin='https://tonest-corp.com';
const env={SUPABASE_URL:'https://tenant.example',SUPABASE_PUBLISHABLE_KEY:'mock-public',SUPABASE_SERVICE_ROLE:'mock-server',CAMP_DIRECTORY:{async listCamps(camp){return [{camp:camp||'대구3',code:'CL18',mb_camp:'본캠프',updated_at:'2026-11-01'}];}}};
const sourceFunctions=(s,indent)=>{
  s=s.replace(/\r\n?/g,'\n');
 const matches=[...s.matchAll(new RegExp('^'+indent+'(?:async )?function (\\w+)\\(','gm'))];
 return new Map(matches.map((m,i)=>[m[1],s.slice(m.index,matches[i+1]?.index??s.length).trim()]));
};
const sha=x=>createHash('sha256').update(x).digest('hex');
const functions=sourceFunctions(backend,'');
const internal=names=>new Function('clean','httpError',names.map(n=>functions.get(n)).join('\n')+'\nreturn {'+names.join(',')+'};')(v=>String(v??'').trim(),(status,message)=>Object.assign(new Error(message),{status}));
const request=(p,method='GET',body,token='test-token')=>new Request('https://route-info.tonest-admin.workers.dev'+p,{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});

async function scenario(fn,options={}){
 const previous=globalThis.fetch;
 const calls=[];
 const rows=options.schedules||[];
 const routes=options.routes||[{id:21,camp:'대구3',route_code:'213A',route_details:[{sub_sub:'01'},{sub_sub:'02'}],is_active:true}];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url),method=init.method||'GET';
  calls.push({url,method,headers:new Headers(init.headers||{}),body:init.body});
  if(url.pathname==='/auth/v1/user')return Response.json({id:'test-user',email:options.email||'test@tenant.test'});
  if(url.pathname==='/rest/v1/profiles')return Response.json([{user_id:'test-user',status:options.status||'active',role:options.role||'admin',display_name:'테스트 관리자'}]);
  if(url.pathname==='/rest/v1/tonest_route_info')return Response.json(routes);
  if(url.pathname==='/rest/v1/tonest_info')return Response.json([{pk_id:1,person_name:'기사테스트',coupang_id:'driver-test',camp_code:'대구3',wave:'야간',position_title:'기사',is_resigned:false}]);
  if(url.pathname==='/rest/v1/tonest_schedule_update_status')return Response.json([]);
  if(url.pathname==='/rest/v1/tonest_schedule'){
   if(method==='GET')return Response.json(rows);
   if(method==='DELETE')return new Response('[]',{headers:{'content-range':'*/1','content-type':'application/json'}});
   return new Response(null,{status:204});
  }
  if(url.pathname==='/rest/v1/meta_backend_state'){
   if(method==='GET')return Response.json([{id:1,cookie_bundle:'WEB-GATEWAY-SESSION=old; bm=before',session_generation:9,status:'active',cookie_jar:[{name:'WEB-GATEWAY-SESSION',value:'old',domain:'fly.coupang.com',path:'/',hostOnly:true,secure:true},{name:'bm',value:'before',domain:'coupang.com',path:'/',hostOnly:false,secure:true},{name:'AUTH_SESSION_ID',value:'keep',domain:'xauth.coupang.com',path:'/auth/realms/trans/',hostOnly:true,secure:true}]}]);
   return new Response(null,{status:204});
  }
  if(url.hostname==='fly.coupang.com'){
   if(options.upstreamFailure)return new Response('{"message":"unavailable"}',{status:503});
   if(url.pathname==='/v2/schedules')return Response.json(options.metaPayload||{data:{scheduleGroups:[]}},{headers:options.rotate?{'set-cookie':'WEB-GATEWAY-SESSION=new; Domain=fly.coupang.com; Path=/; Secure'}:{}});
   if(url.pathname==='/v2/schedules/upload/excel')return Response.json({message:'SUCCESS',data:'workflow-test-id'});
   if(url.pathname==='/v1/schedules/upload-workflow/signal')return Response.json({message:'SUCCESS',data:true});
   if(url.pathname==='/v1/workflows/workflow-test-id/excel-upload-status')return Response.json({message:'SUCCESS',data:{workflowId:'workflow-test-id',status:'SUCCESS',data:{created:2,totalRows:2}}});
  }
  throw new Error('Unexpected mock upstream '+method+' '+url);
 };
 try{return await fn(calls);}finally{globalThis.fetch=previous;}
}

test('source parity: original schedule UI functions preserved after branding',()=>{
 const actual=sourceFunctions(page,'      ');
 assert.equal(parity.source_commit,'5d127cf124f0149113380393c74b1328c0065d29');
 assert(parity.front_functions_same_after_branding>=180);
 const intentionallyAdapted=new Set(['syncWaveFromCamp','metaDisplayNamesOnBoard','forceMetaAdminCellTypes','collectMetaRows','openExcelDatePicker','countMetaRowsForScheduleDate','writeMetaExcelFileForDates','exportMetaExcelForDates','metaUploadDateForScheduleDate','buildMetaUploadWorkbook','uploadMetaScheduleForDate','uploadMetaSchedulesForDates']);
 for(const [name,hash] of Object.entries(parity.front_unchanged_functions))if(!intentionallyAdapted.has(name))assert.equal(sha(actual.get(name)),hash,name);
});
test('source parity: original save/export/two-phase META workflow retained',()=>{
 assert(parity.worker_functions_same_after_branding>=65);
 const intentionallyAdapted=new Set(['nativeMetaScheduleRows','json']);
 for(const [name,hash] of Object.entries(parity.worker_unchanged_functions))if(!intentionallyAdapted.has(name))assert.equal(sha(functions.get(name)),hash,name);
 for(const name of ['getMetaCurrentSchedule','uploadMetaScheduleExcel','continueMetaScheduleUpload','getMetaWorkflowStatus','saveScheduleRows','nativeMetaScheduleRows'])assert(functions.has(name),name);
 for(const name of ['uploadMetaScheduleForDate','uploadMetaSchedulesForDates','verifyMetaScheduleState','buildMetaUploadWorkbook','collapseUniformChildSchedulesForDisplay'])assert(parity.front_unchanged_functions[name],name);
});
test('all frontend inline JavaScript parses; no legacy vendor export or endpoint',()=>{
 for(const m of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
 assert(!page.includes('2591501828'));
 assert(!page.includes('https://schedule.maroowell.com'));
 assert(!page.includes('src="/config.js"'));
 assert(page.includes('1658803281'));
 assert(page.includes('id="tnBoardMenuToggle"'));
 assert(page.includes('id="btnMetaUpload"'));
});
test('CORS and route-info prefix dispatch reach the schedule API',async()=>{
 const health=await routeWorker.fetch(request('/schedule-api/health'),env);
 assert.equal(health.status,200);
 assert.equal((await health.json()).service,'tonest-schedule-api');
 const cors=await routeWorker.fetch(request('/schedule-api/schedule/save','OPTIONS'),env);
 assert.equal(cors.status,204);assert.equal(cors.headers.get('Access-Control-Allow-Origin'),origin);
});
test('anonymous, ordinary driver, rejected admin and old email bypass are denied',async()=>{
 const anonymous=await scheduleWorker.fetch(request('/me','GET',undefined,''),env);
 assert.equal(anonymous.status,401);
 for(const opt of [{role:'driver'},{role:'admin',status:'rejected'},{role:'driver',email:'brain@maroowell.com'}])await scenario(async()=>{
  const response=await scheduleWorker.fetch(request('/schedule/save','POST',{rows:[]}),env);
  assert.equal(response.status,403);
 },opt);
});
test('active admin/team leader can load a week and camp-specific route children',async()=>{
 for(const role of ['admin','team_leader','super_admin'])await scenario(async(calls)=>{
  const res=await scheduleWorker.fetch(request('/schedule/week?camp='+encodeURIComponent('대구3')+'&wave=WAVE1&week_start=2026-11-08'),env);
  assert.equal(res.status,200);
  const body=await res.json();assert.deepEqual(body.routes.map(r=>r.route_label),['213A','213A01','213A02']);
  assert.equal(body.drivers[0].coupang_id,'driver-test');
  const people=calls.find(c=>c.url.pathname==='/rest/v1/tonest_info');
  assert(!people.url.searchParams.get('select').includes('resident_registration_number'));
  assert(!calls.some(c=>/user_access|vendor_members|maroowell_/.test(c.url.pathname)));
 },{role});
});
test('config contains TO:NEST business number and dynamically available camps',async()=>scenario(async()=>{
 const r=await scheduleWorker.fetch(request('/config'),env);assert.equal(r.status,200);
 const b=await r.json();assert.equal(b.business_number,'1658803281');assert.equal(b.vendor_name,'주식회사 투네스트');assert.equal(b.camps[0].camp,'대구3');
}));
test('save and clear use the existing schedule key, not realtime mutations',async()=>scenario(async(calls)=>{
 const rows=[{schedule_date:'2026-11-11',camp:'대구3',wave:'WAVE1',route_label:'213A',driver_name:'기사테스트',driver_display_name:'기사테스트',driver_coupang_id:'driver-test'},{schedule_date:'2026-11-11',camp:'대구3',wave:'WAVE1',route_label:'213B',driver_name:'',is_active:false}];
 const r=await scheduleWorker.fetch(request('/schedule/save','POST',{rows}),env);assert.equal(r.status,200);
 assert(calls.some(c=>c.method==='DELETE'&&c.url.pathname.endsWith('/tonest_schedule')));
 const write=calls.find(c=>c.method==='POST'&&c.url.pathname.endsWith('/tonest_schedule'));
 assert.equal(write.url.searchParams.get('on_conflict'),'schedule_date,camp,wave,route_label');
 assert.equal(JSON.parse(write.body)[0].driver_coupang_id,'driver-test');
 assert(!calls.some(c=>/meta_realtime|meta_backend_state/.test(c.url.pathname)));
}));
test('META schedule query keeps Sunday-Saturday range and wave/camp scoping',async()=>scenario(async(calls)=>{
 const r=await scheduleWorker.fetch(request('/schedule/meta/current?camp='+encodeURIComponent('대구3')+'&wave=WAVE1&date=2026-11-12'),env);
 assert.equal(r.status,200);
 const meta=calls.find(c=>c.url.hostname==='fly.coupang.com');
 assert.equal(meta.url.pathname,'/v2/schedules');assert.equal(meta.url.searchParams.get('waveCode'),'WAVE1');
 assert.equal(meta.url.searchParams.get('dateFrom'),'2026-11-08');assert.equal(meta.url.searchParams.get('dateTo'),'2026-11-14');assert.equal(meta.url.searchParams.get('campCodes'),'CL18');
}));
test('cookie rotation is guarded and does not reset collector status or pause state',async()=>scenario(async(calls)=>{
 await scheduleWorker.fetch(request('/schedule/meta/current?camp='+encodeURIComponent('대구3')+'&wave=WAVE2&date=2026-11-11'),env);
 const patch=calls.find(c=>c.method==='PATCH'&&c.url.pathname.endsWith('/meta_backend_state'));
 assert(patch);assert.equal(patch.url.searchParams.get('session_generation'),'eq.9');assert(patch.url.searchParams.has('cookie_bundle'));
 const b=JSON.parse(patch.body);assert(!Object.hasOwn(b,'collector_paused'));assert(!Object.hasOwn(b,'status'));assert.equal(b.cookie_jar.find(c=>c.name==='AUTH_SESSION_ID').value,'keep');assert.equal(b.cookie_jar.find(c=>c.name==='WEB-GATEWAY-SESSION').value,'new');
},{rotate:true}));
test('cookie scopes and logout expiry are respected while preserving OAuth cookies',()=>{
 const {rotateTenantCookieJar}=internal(['splitSetCookieHeader','rotateTenantCookieJar']);
 const jar=[{name:'AUTH',value:'oauth',domain:'xauth.coupang.com',path:'/auth/'},{name:'bm',value:'old',domain:'coupang.com',path:'/'}];
 const resp=new Response('',{headers:{'set-cookie':'bm=gone; Domain=.coupang.com; Path=/; Max-Age=0'}});
 const out=rotateTenantCookieJar(jar,resp);assert.equal(out.length,1);assert.equal(out[0].name,'AUTH');
});
test('multipart upload and workflow continuation use the original endpoints (mock only)',async()=>scenario(async(calls)=>{
 const form=new FormData();form.append('camp','대구3');form.append('wave','WAVE1');form.append('meta_date','2026-11-12');form.append('phase','apply');form.append('file',new File([new Uint8Array([80,75,3,4])],'test.xlsx'));
 const upload=new Request('https://test/schedule/meta/upload-excel',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test-token'},body:form});
 const res=await scheduleWorker.fetch(upload,env);assert.equal(res.status,200);assert.equal((await res.json()).workflow_id,'workflow-test-id');
 const sent=calls.find(c=>c.url.pathname==='/v2/schedules/upload/excel');assert(sent);assert(sent.body instanceof FormData);
 const next=await scheduleWorker.fetch(request('/schedule/meta/continue','POST',{workflow_id:'workflow-test-id'}),env);assert.equal(next.status,200);
 const cont=calls.find(c=>c.url.pathname==='/v1/schedules/upload-workflow/signal');assert.deepEqual(JSON.parse(cont.body),{workflowId:'workflow-test-id',status:'CONTINUE'});
 const status=await scheduleWorker.fetch(request('/schedule/meta/workflow?workflow_id=workflow-test-id'),env);const b=await status.json();assert.equal(b.status,'SUCCESS');assert.equal(b.data.created,2);
}));
test('native submission requires a fresh fingerprint and fails before writing META',async()=>scenario(async(calls)=>{
 const body={camp:'대구3',wave:'WAVE1',date:'2026-11-11',phase:'apply',fingerprint:'old'};
 const r=await scheduleWorker.fetch(request('/schedule/meta/native/submit','POST',body),env);
 assert.equal(r.status,409);
 assert(!calls.some(c=>c.url.hostname==='fly.coupang.com'&&c.method==='POST'));
}));
test('upstream failure returns JSON+CORS rather than unhandled exception',async()=>scenario(async()=>{
 const r=await scheduleWorker.fetch(request('/schedule/meta/current?camp='+encodeURIComponent('대구3')+'&wave=WAVE2&date=2026-11-11'),env);
 assert.equal(r.status,503);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.equal((await r.json()).error,'meta_request_failed');
},{upstreamFailure:true}));

test('camp options come exclusively from active route information, not driver info',async()=>scenario(async(calls)=>{
 const response=await scheduleWorker.fetch(request('/config'),env);
 assert.equal(response.status,200);
 const data=await response.json();
 assert.deepEqual(data.camps.map(x=>x.camp),['광주','군포1','대구3']);
 assert.deepEqual(data.camps.find(x=>x.camp==='대구3').waves,['WAVE2','WAVE1']);
 assert(!data.camps.some(x=>x.camp==='인천9'));
 assert(!calls.some(x=>x.url.pathname==='/rest/v1/tonest_info'),
   '/config must not query driver information');
 assert(calls.some(x=>x.url.pathname==='/rest/v1/tonest_route_info'),
   '/config must read the route information table');
}, {routes:[
 {id:1,camp:'대구3',route_code:'213A',is_active:true},
 {id:2,camp:'군포1',route_code:'503C',is_active:true},
 {id:3,camp:'대구3',route_code:'213B',is_active:true},
 {id:4,camp:'인천9',route_code:'908A',is_active:false},
 {id:5,camp:'광주',route_code:'111A',is_active:true}
]}));

test('empty route information yields an empty camp list without driver fallback',async()=>scenario(async(calls)=>{
 const response=await scheduleWorker.fetch(request('/config'),env);
 assert.equal(response.status,200);
 const data=await response.json();
 assert.deepEqual(data.camps,[]);
 assert(!calls.some(x=>x.url.pathname==='/rest/v1/tonest_info'));
},{routes:[]}));

test('schedule selects only requested shift plus legacy unassigned routes',async()=>scenario(async()=>{
 const night=await scheduleWorker.fetch(request('/schedule/week?camp='+encodeURIComponent('대구3')+'&wave=WAVE1&week_start=2026-11-08'),env);
 assert.equal(night.status,200);assert.deepEqual((await night.json()).routes.map(x=>x.route_label),['213A','213C']);
 const day=await scheduleWorker.fetch(request('/schedule/week?camp='+encodeURIComponent('대구3')+'&wave=WAVE2&week_start=2026-11-08'),env);
 assert.equal(day.status,200);assert.deepEqual((await day.json()).routes.map(x=>x.route_label),['213B','213C']);
 const config=await scheduleWorker.fetch(request('/config'),env);
 assert.deepEqual((await config.json()).camps,[{camp:'대구3',waves:['WAVE2','WAVE1']}]);
},{routes:[
 {id:21,camp:'대구3',route_code:'213A',wave:'WAVE1',is_active:true},
 {id:22,camp:'대구3',route_code:'213B',wave:'WAVE2',is_active:true},
 {id:23,camp:'대구3',route_code:'213C',wave:null,is_active:true}
]}));
test('route information UI includes wave dropdown and keeps wave-only PATCH',()=>{
 const front=fs.readFileSync(path.join(root,'public/route_info'),'utf8');
 assert(front.includes('editable(row,"wave","wave")'));
 assert(front.includes('미지정'));
 assert(front.includes('WAVE1'));
 assert(front.includes('WAVE2'));
 assert(front.includes('const patch=localOnly?{wave:body.wave,tonest_memo:body.tonest_memo}:body'));
 for(const match of front.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
  if(match[1].trim())new vm.Script(match[1]);
 }
});
