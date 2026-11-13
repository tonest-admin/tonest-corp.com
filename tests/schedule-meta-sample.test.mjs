import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const page=fs.readFileSync(path.join(root,'public','tonest_schedule'),'utf8');
const worker=fs.readFileSync(path.join(root,'workers','schedule-api','worker.js'),'utf8');
const clean=v=>String(v??'').trim();

function functions(source,indent){
  const matches=[...source.matchAll(new RegExp('^'+indent+'(?:async )?function (\\w+)\\(','gm'))];
  return new Map(matches.map((m,i)=>[m[1],source.slice(m.index,matches[i+1]?.index??source.length)]));
}
const front=functions(page,'      ');
const back=functions(worker,'');
function evaluate(map,names,globals={}){
  for(const name of names)assert(map.has(name),'missing function '+name);
  const ctx=vm.createContext({console,Date,Map,Set,TextEncoder,Uint8Array,...globals});
  vm.runInContext(names.map(n=>map.get(n)).join('\n')+'\nglobalThis.functionsUnderTest={'+names.join(',')+'};',ctx);
  return ctx.functionsUnderTest;
}
const data={
  '2026-11-08':[{date:'2026-11-08',name:'Alice',id:'alice',routes:['213A']}],
  '2026-11-09':[{date:'2026-11-09',name:'Bob',id:'bob',routes:['213B']}]
};
function frontState(overrides={}){
  const state={weekDates:['2026-11-08','2026-11-09'],camp:'대구3',wave:'WAVE1'};
  const off={'2026-11-08':'Bob,Carol','2026-11-09':''};
  const ids={Alice:'alice',Bob:'bob',Carol:'carol'};
  const ctx={
    state,OFF_ROUTE_LABEL:'휴무자',clean,
    keyOf:v=>clean(v).toLowerCase(),sortText:(a,b)=>String(a).localeCompare(String(b),'en'),
    normalizeDateInput:clean,splitPersonNames:v=>clean(v).split(/[,\n/、，]+/).map(clean).filter(Boolean),
    collectMetaRows:({scheduleDate})=>data[scheduleDate]||[],
    valueForCell:(date,label)=>label==='휴무자'?off[date]:'',
    rowForCell:()=>({}),
    resolveMetaAdminExportIdentity:(name,source)=>({
      name:source?.driver_coupang_id?source.driver_export_name:name,
      id:source?.driver_coupang_id||ids[name]||''
    }),
    ...overrides
  };
  return {state,off,ids,ctx};
}
test('one row per person and selected business date; work, explicit off, implicit off coexist',()=>{
  const {ctx}=frontState();
  const {collectMetaSampleRows}=evaluate(front,['collectMetaSampleRows'],ctx);
  const rows=collectMetaSampleRows({scheduleDates:['2026-11-08','2026-11-09']});
  assert.equal(rows.length,6);
  const get=(d,id)=>rows.find(r=>r.date===d&&r.id===id);
  assert.equal(get('2026-11-08','alice').status,'출근');
  assert.deepEqual([...get('2026-11-08','alice').routes],['213A']);
  assert.equal(get('2026-11-08','bob').status,'휴무');
  assert.equal(get('2026-11-08','carol').status,'휴무');
  assert.deepEqual([...get('2026-11-08','carol').routes],[]);
  assert.equal(get('2026-11-09','bob').status,'출근');
  assert.equal(get('2026-11-09','alice').status,'휴무');
  assert.equal(get('2026-11-09','carol').status,'휴무');
  assert.equal(rows.filter(r=>r.date==='2026-11-08'&&r.id==='bob').length,1);
});
test('preview can count unresolved ID, but export rejects it before uploading',()=>{
  const {ctx,off}=frontState();
  off['2026-11-08']='Ghost';
  const {collectMetaSampleRows}=evaluate(front,['collectMetaSampleRows'],ctx);
  assert.doesNotThrow(()=>collectMetaSampleRows({scheduleDates:['2026-11-08'],validateIds:false}));
  assert.throws(()=>collectMetaSampleRows({scheduleDates:['2026-11-08']}),/ID 확인 불가/);
});
test('attendance and off duty for the same driver on one date are rejected',()=>{
  const {ctx,off}=frontState();
  off['2026-11-08']='Alice';
  const {collectMetaSampleRows}=evaluate(front,['collectMetaSampleRows'],ctx);
  assert.throws(()=>collectMetaSampleRows({scheduleDates:['2026-11-08']}),/출근·휴무 중복/);
});
test('WAVE1 and WAVE2 META dates match selected work dates',()=>{
  for(const wave of ['WAVE1','WAVE2']){
    const {ctx}=frontState();
    ctx.state.wave=wave;
    const {metaUploadDateForScheduleDate}=evaluate(front,['metaUploadDateForScheduleDate'],ctx);
    assert.equal(metaUploadDateForScheduleDate('2026-11-08'),'2026-11-08');
  }
});
test('upload XLSX Sheet0 has 10 exact columns, text business number and blank off route/rotation',()=>{
  const sheets=[];
  const XLSX={utils:{
    book_new:()=>({sheets}),
    aoa_to_sheet:aoa=>{
      const ws={};
      for(let i=0;i<aoa.length;i++)for(let j=0;j<aoa[i].length;j++){
        ws[String.fromCharCode(65+j)+(i+1)]={t:'s',v:aoa[i][j]};
      }
      return ws;
    },
    book_append_sheet:(book,ws,name)=>book.sheets.push({ws,name})
  }};
  const {buildMetaUploadWorkbook}=evaluate(front,
    ['excelDateSerial','forceMetaAdminCellTypes','buildMetaUploadWorkbook'],{
    XLSX,window:{XLSX},state:{camp:'대구3',wave:'WAVE1'},clean,
    normalizeDateInput:clean,metaCampName:clean,
    metaRotationByWave:()=> 'D1,D2,F3',
    META_VENDOR_NAME:'주식회사 투네스트/TONET',
    META_BUSINESS_NO:'1658803281',META_WORK_STATUS:'출근'
  });
  const wb=buildMetaUploadWorkbook([
    {date:'2026-11-08',name:'Alice',id:'alice',status:'출근',routes:['213A','213B']},
    {date:'2026-11-08',name:'Bob',id:'bob',status:'휴무',routes:[]}
  ],'출근');
  const {ws,name}=wb.sheets[0];
  assert.equal(name,'Sheet0');
  assert.deepEqual(['A','B','C','D','E','F','G','H','I','J'].map(k=>ws[k+'1'].v),
    ['업무일','벤더명','사업자등록번호','캠프명','웨이브','이름','아이디','업무상태','회전','업무라우트']);
  assert.equal(ws.B2.v,'주식회사 투네스트/TONET');
  assert.equal(ws.C2.t,'s');
  assert.equal(ws.C2.v,'1658803281');
  assert.equal(ws.A2.t,'n');
  assert.equal(ws.A2.z,'mm-dd-yy');
  assert.equal(ws.H2.v,'출근');
  assert.equal(ws.I2.v,'D1,D2,F3');
  assert.equal(ws.J2.v,'213A,213B');
  assert.equal(ws.H3.v,'휴무');
  assert.equal(ws.I3.v,'');
  assert.equal(ws.J3.v,'');
});
function nativeFns(){
  return evaluate(back,['nativeMetaKey','nativeMetaNormalizeRoute','nativeMetaAccountParts',
    'nativeMetaAccountIndex','nativeMetaScheduleRows','nativeMetaXml','nativeMetaZip','buildNativeMetaXlsx'],{
    clean,httpError:(status,message)=>Object.assign(new Error(message),{status}),
    Date,TextEncoder,Uint8Array
  });
}
const nativeSchedules=[
  {schedule_date:'2026-11-08',route_label:'213A',driver_display_name:'Alice',driver_coupang_id:'alice'},
  {schedule_date:'2026-11-08',route_label:'휴무자',driver_display_name:'Bob,Carol',
    driver_coupang_id:'bob',driver_export_name:'Bob'},
  {schedule_date:'2026-11-09',route_label:'213B',driver_display_name:'Bob',driver_coupang_id:'bob'}
];
const nativeInfo=['Alice','Bob','Carol'].map(n=>({person_name:n,coupang_id:n.toLowerCase()}));
test('native Android/iOS route grouping includes explicit and implicit off duty without ID alias leakage',()=>{
  const {nativeMetaScheduleRows}=nativeFns();
  const routes=['213A','213B'].map(r=>({route_label:r,parent_route_label:r,is_active:true}));
  const rows=nativeMetaScheduleRows(nativeSchedules,routes,nativeInfo,'2026-11-08','2026-11-08');
  assert.equal(rows.length,3);
  const byId=Object.fromEntries(rows.map(r=>[r.id,r]));
  assert.equal(byId.alice.status,'출근');
  assert.deepEqual([...byId.alice.routes],['213A']);
  assert.equal(byId.bob.status,'휴무');
  assert.equal(byId.carol.status,'휴무');
  assert.notEqual(byId.bob.id,byId.carol.id);
  const next=nativeMetaScheduleRows(nativeSchedules,routes,nativeInfo,'2026-11-09','2026-11-09');
  assert.equal(next.find(r=>r.id==='bob').status,'출근');
  assert.equal(next.find(r=>r.id==='alice').status,'휴무');
  assert.throws(()=>nativeMetaScheduleRows([...nativeSchedules,
    {schedule_date:'2026-11-08',route_label:'휴무자',driver_display_name:'Alice'}],
    routes,nativeInfo,'2026-11-08','2026-11-08'),/meta_attendance_off_conflict/);
});
function entriesOfZip(bytes){
  const b=Buffer.from(bytes),entries=new Map();
  let i=0;
  while(i+30<=b.length&&b.readUInt32LE(i)===0x04034b50){
    const len=b.readUInt32LE(i+18),nameLen=b.readUInt16LE(i+26),extraLen=b.readUInt16LE(i+28);
    const name=b.subarray(i+30,i+30+nameLen).toString('utf8');
    const start=i+30+nameLen+extraLen;
    entries.set(name,b.subarray(start,start+len).toString('utf8'));
    i=start+len;
  }
  return entries;
}
test('native XLSX bytes match sample text/date formatting and off blank fields',()=>{
  const {buildNativeMetaXlsx}=nativeFns();
  const zip=entriesOfZip(buildNativeMetaXlsx([
    {date:'2026-11-08',name:'Alice',id:'alice',status:'출근',routes:['213A']},
    {date:'2026-11-08',name:'Bob',id:'bob',status:'휴무',routes:[]}
  ],{camp:'대구3',wave:'WAVE1',phase:'apply'}));
  const sheet=zip.get('xl/worksheets/sheet1.xml');
  const styles=zip.get('xl/styles.xml');
  assert(sheet.includes('<c r="C2" t="inlineStr">'));
  assert(sheet.includes('주식회사 투네스트/TONET'));
  assert(sheet.includes('1658803281'));
  assert(sheet.includes('<c r="A2" s="1">'));
  assert(sheet.includes('D1,D2,F3'));
  assert(sheet.includes('휴무'));
  assert(!sheet.includes('<c r="I3"'));
  assert(!sheet.includes('<c r="J3"'));
  assert(styles.includes('formatCode="mm-dd-yy"'));
});
test('native apply verification checks working roster, not inactive off-duty rows',()=>{
  assert(worker.includes('preview.actual_rows.filter(r=>r.status!=="휴무")'));
  assert(worker.includes('weekStart:week.dateFrom,weekEnd:week.dateTo'));
});
