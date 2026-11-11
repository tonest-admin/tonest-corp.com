const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.REALTIME_PAGE || path.join(__dirname,'..','public','realtime'),'utf8');
test('all inline scripts parse as JavaScript',()=>{
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
 assert(scripts.length>0);
 scripts.forEach(x=>new vm.Script(x));
});
const a=html.indexOf('function infoLookupKey('),b=html.indexOf('function toModel(',a);
assert(a>=0 && b>a,'identity helpers must exist');
const funcs=new Function(html.slice(a,b)+'\nreturn {resolveInfoForRealtime,scheduleVerification,enrichRealtimeRows};')();
const mk=(id,camp='대구3')=>({schedule_date:'2026-11-11',camp_name:camp,wave:'WAVE2',coupang_id:id,driver_pk:null,actual_routes:['213A01']});
const people=[
 {pk_id:12,person_name:'확인된기사',coupang_id:'driver-12',camp_code:'대구3',wave:'주간',is_resigned:false},
 {pk_id:13,person_name:'다른기사',coupang_id:'driver-13',camp_code:'대구3',wave:'주간',is_resigned:false},
];
const schedule=[{schedule_date:'2026-11-11',camp:'대구3',wave:'WAVE2',route_label:'213A',driver_pk:12,driver_coupang_id:'driver-12',is_active:true}];
test('exact Coupang ID maps to approved info name, then verifies schedule and prefix route',()=>{
 const result=funcs.enrichRealtimeRows([mk(' DRIVER-12 ')],people,schedule)[0];
 assert.equal(result.display_info_name,'확인된기사');
 assert.equal(result.display_identity_status,'info_verified');
 assert.equal(result.display_schedule_status,'schedule_matched');
});
test('META record without ID cannot be guessed from route or schedule',()=>{
 const result=funcs.enrichRealtimeRows([mk(null)],people,schedule)[0];
 assert.equal(result.display_info_name,null);
 assert.equal(result.display_identity_status,'meta_id_missing');
 assert.equal(result.display_schedule_status,'identity_unavailable');
});
test('a unique ID with no schedule is still named but schedule marked unavailable',()=>{
 const x=funcs.enrichRealtimeRows([mk('driver-12')],people,[])[0];
 assert.equal(x.display_info_name,'확인된기사');
 assert.equal(x.display_schedule_status,'schedule_unavailable');
});
test('schedule wrong driver does not override ID-matched name',()=>{
 const x=funcs.enrichRealtimeRows([mk('driver-13')],people,schedule)[0];
 assert.equal(x.display_info_name,'다른기사');
 assert.equal(x.display_schedule_status,'schedule_mismatch');
});
test('schedule route mismatch does not imply a false name mismatch',()=>{
 const x=funcs.enrichRealtimeRows([{...mk('driver-12'),actual_routes:['503D01']}],people,schedule)[0];
 assert.equal(x.display_info_name,'확인된기사');
 assert.equal(x.display_schedule_status,'schedule_route_mismatch');
});
test('duplicate ID across same camp and shift never chooses a name',()=>{
 const dup={...people[0],pk_id:99,person_name:'동일아이디다른기사'};
 const x=funcs.enrichRealtimeRows([mk('driver-12')],[people[0],dup],schedule)[0];
 assert.equal(x.display_identity_status,'info_ambiguous');
 assert.equal(x.display_info_name,null);
});
test('duplicate ID can be disambiguated by exact camp and shift',()=>{
 const dup={...people[0],pk_id:99,person_name:'타캠프기사',camp_code:'대구4'};
 const x=funcs.enrichRealtimeRows([mk('driver-12')],[people[0],dup],schedule)[0];
 assert.equal(x.display_info_name,'확인된기사');
});
test('no META worker collector or cron logic is changed by realtime page',()=>{
 assert(html.includes('optionalDriverDirectory()'));
 assert(html.includes(".order('pk_id',{ascending:true})"));
 assert(!html.includes('meta-direct-poc.tonest-admin.workers.dev/collector/run'), 'no collector mutation');
});
