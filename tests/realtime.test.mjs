import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceProgress,expectedRounds,tsMs} from '../workers/meta-collector/rounds.mjs';
import {createRequire} from 'node:module';
const R=createRequire(import.meta.url)('../public/realtime-core.js');
const fb={pending:0,collected:0,uncollected:0};
const batch={wave:'WAVE1'};
function poll(prev,scanned,completed,at,extra={}){
  const d={assigned:0,scanned,completed,impossible:0,pdd:0,total:scanned+completed,...extra};
  const p=advanceProgress(prev,d,null,fb,batch,at);
  const row={...prev,delivery_assigned:d.assigned,delivery_scanned:scanned,delivery_completed:completed,
    delivery_impossible:d.impossible,delivery_pdd_miss:d.pdd,delivery_total:d.total,freshbag_pending:0,freshbag_collected:0,freshbag_uncollected:0,
    current_round:p.currentRound,last_seen_at:at,last_progress_at:p.lastProgressAt,last_scan_activity_at:p.lastScanActivityAt,
    exact_complete_candidate_at:p.exactCandidate,work_completed_at:p.workCompletedAt,completion_method:p.completionMethod,completion_detected_at:p.completionDetectedAt};
  for(let i=1;i<=3;i++)for(const [k,v]of Object.entries(p.rounds[i]))row[`round${i}_${({scan:'scan_started_at',delivery:'delivery_started_at',completed:'completed_at',detected:'completion_detected_at',method:'completion_method'})[k]}`]=v;
  return row;
}
test('night is always three rounds even for old expected_rounds=2',()=>{assert.equal(expectedRounds({wave:'WAVE1',expected_rounds:2}),3);assert.equal(expectedRounds({wave:'WAVE2'}),2)});
test('KST naive and explicit offsets are equivalent',()=>assert.equal(tsMs('2026-10-09T21:00:00'),tsMs('2026-10-09T12:00:00Z')));
test('three night rounds cross midnight and only round three finishes the work',()=>{
  let r=poll(null,10,0,'2026-10-09T20:00:00');
  for(const [i,date,hour,total] of [[1,'2026-10-09','21',10],[2,'2026-10-09','23',20],[3,'2026-10-10','01',30]]){
    if(i>1)r=poll(r,10,total-10,`${date}T${i===2?'22':'00'}:00:00`);
    assert.equal(r.current_round,i);
    r=poll(r,0,total,`${date}T${hour}:00:00`);r=poll(r,0,total,`${date}T${hour}:01:00`);
    assert.ok(r[`round${i}_completed_at`]);assert.equal(!!r.work_completed_at,i===3);
  }
  r=poll(r,2,30,'2026-10-10T01:05:00');assert.equal(r.current_round,3);assert.equal(r.work_completed_at,null);assert.equal(r.round3_completed_at,null);
  r=poll(r,0,32,'2026-10-10T01:06:00');r=poll(r,0,32,'2026-10-10T01:07:00');assert.ok(r.work_completed_at);
});
test('cancellation and pdd are not first deliveries',()=>{
  const r=poll(null,0,0,'2026-10-09T20:00:00',{impossible:2,pdd:1,total:3});assert.equal(r.round1_delivery_started_at,null);assert.equal(r.work_completed_at,null);
});
test('assignment alone does not advance a round',()=>{
  let r=poll(null,1,0,'2026-10-09T20:00:00');r=poll(r,0,1,'2026-10-09T21:00:00');r=poll(r,0,1,'2026-10-09T21:01:00');
  r=poll(r,0,1,'2026-10-09T21:02:00',{assigned:10,total:11});assert.equal(r.current_round,1);
});
test('two calls at the same observed time do not confirm completion',()=>{
  let r=poll(null,10,0,'2026-10-09T20:00:00');r=poll(r,0,10,'2026-10-09T21:00:00');r=poll(r,0,10,'2026-10-09T21:00:00');assert.equal(r.round1_completed_at,null);
});
test('stale two-round final is not shown as night completion',()=>assert.equal(R.doneAt({wave:'WAVE1',current_round:2,work_completed_at:'2026-10-10T02:00:00'}),null));
test('night active dates and UTC display use KST',()=>{
 assert.equal(R.activeDate('WAVE1',Date.parse('2026-10-10T02:59:00Z')),'2026-10-09');
 assert.equal(R.activeDate('WAVE1',Date.parse('2026-10-10T03:00:00Z')),'2026-10-10');
 assert.equal(R.fmtClock('2026-10-09T12:15:00Z'),'21:15');
});
test('absent returns are not counted twice',()=>{
 const r=R.collection({return_pending:1,return_collected:2,return_uncollected_raw:3,return_absent_raw:2},'return',true);assert.equal(r.total,6);assert.equal(r.uncollected,3);
});
test('fresh merge uses stable driver pk before names and keeps zero values',()=>{
 const rows=[{batch_id:'b',driver_pk:1,driver_name:'A',fresh_delivery_total:10}];
 const fresh=[{batch_id:'b',driver_pk:1,driver_name:'B',delivery_total:0}];assert.equal(R.mergeFresh(rows,fresh)[0].fresh_delivery_total,0);
});
test('incomplete driver overrides old batch visibility',()=>{
 const b={wave:'WAVE1',schedule_date:'2026-10-09',visible_until:'2026-10-10T03:00:00'};
 assert.equal(R.visibleUntil(b,[{wave:'WAVE1',delivery_scanned:1,current_round:3}]),null);
});
test('finished night remains visible until +1h capped at next noon',()=>{
 const b={wave:'WAVE1',schedule_date:'2026-10-09',work_completed_at:'2026-10-10T11:30:00'};
 const r={wave:'WAVE1',current_round:3,round3_delivery_started_at:'2026-10-10T06:00:00',delivery_completed:1,work_completed_at:b.work_completed_at};
 assert.equal(R.visibleUntil(b,[r]).getTime(),Date.parse('2026-10-10T12:00:00+09:00'));
});
test('stable driver identity is not double counted after a META key change',()=>{
 const rows=[{batch_id:'b',driver_pk:1,meta_worker_key:'old',delivery_total:100,last_seen_at:'2026-10-09T20:00:00'},
 {batch_id:'b',driver_pk:1,meta_worker_key:'new',delivery_total:98,last_seen_at:'2026-10-09T20:01:00'}];
 assert.equal(R.dedupeRows(rows).length,1);assert.equal(R.dedupeRows(rows)[0].delivery_total,98);
});
