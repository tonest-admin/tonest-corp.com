/* Shared, side-effect-free TO:NEST realtime presentation rules. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TnRealtime=api;})(globalThis,function(){
  const n=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
  const expectedRounds=r=>String(r?.wave||'').toUpperCase()==='WAVE1'?3:2;
  const key=v=>String(v||'').trim().replace(/\s+/g,'').toLowerCase();
  function parseKst(v){if(!v)return null;const s=String(v).trim().replace(' ','T');const d=new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)?s:s+'+09:00');return Number.isFinite(d.getTime())?d:null;}
  function fmtClock(v){const d=parseKst(v);return d?new Date(d.getTime()+9*3600000).toISOString().slice(11,16):'-';}
  function addDate(day,days){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
  function activeDate(wave,ms=Date.now()){const d=new Date(ms+9*3600000),day=d.toISOString().slice(0,10);return wave==='WAVE1'&&d.getUTCHours()<12?addDate(day,-1):day;}
  function isStarted(r){return !!r.scan_started_at||n(r.delivery_scanned)>0||n(r.delivery_completed)>0||n(r.delivery_impossible)>0||n(r.delivery_pdd_miss)>0;}
  function doneAt(r){
    // Old WAVE1 snapshots may contain a premature two-round completion.
    const rounds=n(r.current_round??r.actual_rounds);
    if(r.wave==='WAVE1'&&(rounds<3||!r.round3_delivery_started_at))return null;
    return r.work_completed_at||r.all_completed_at||null;
  }
  function visibleUntil(batch,rows){
    const started=(rows||[]).filter(isStarted);
    // A reopened driver overrides a stale batch completion timestamp.
    if(!started.length||started.some(r=>!doneAt(r)))return null;
    const stored=parseKst(batch.visible_until);if(stored)return stored;
    // Without server camp completion we cannot infer that missing scheduled workers finished.
    const completed=parseKst(batch.work_completed_at);if(!completed)return null;
    const day=batch.schedule_date,plus=completed.getTime()+3600000;
    return batch.wave==='WAVE1'
      ?new Date(Math.min(parseKst(addDate(day,1)+'T12:00:00').getTime(),plus))
      :new Date(Math.min(parseKst(addDate(day,1)+'T00:00:00').getTime(),Math.max(parseKst(day+'T21:00:00').getTime(),plus)));
  }
  function collection(r,p,includeAbsent=false){
    const pending=n(r[p+'_pending']),collected=n(r[p+'_collected']);
    const absent=includeAbsent?n(r[p+'_absent_raw']):0;
    // Absent is a subset/alternative counter, not another disjoint workload.
    const uncollected=Math.max(n(r[p+'_uncollected']),n(r[p+'_uncollected_raw']),absent);
    const total=n(r[p+'_total'])||pending+collected+uncollected;
    return {pending,collected,uncollected,absent,total,attempt:total?(collected+uncollected)*100/total:0,collection:total?collected*100/total:0};
  }
  function mergeFresh(rows,fresh){
    const maps={pk:new Map(),worker:new Map(),cid:new Map(),name:new Map()};
    for(const f of fresh||[]){
      const prefix=f.batch_id+'|';
      if(f.driver_pk!=null)maps.pk.set(prefix+f.driver_pk,f);
      if(f.meta_worker_key)maps.worker.set(prefix+key(f.meta_worker_key),f);
      if(f.coupang_id)maps.cid.set(prefix+key(f.coupang_id),f);
      if(f.driver_name){const k=prefix+key(f.driver_name);maps.name.set(k,maps.name.has(k)?null:f);}
    }
    return (rows||[]).map(r=>{
      const pre=r.batch_id+'|';
      const f=(r.driver_pk!=null&&maps.pk.get(pre+r.driver_pk))||maps.worker.get(pre+key(r.meta_worker_key))
        ||maps.cid.get(pre+key(r.coupang_id))||(!r.coupang_id&&maps.name.get(pre+key(r.driver_name)));
      if(!f)return r;
      const next={...r};for(const field of ['assigned','scanned','completed','impossible','pdd_miss','total','complete_rate'])next['fresh_delivery_'+field]=f['delivery_'+field];
      return next;
    });
  }
  function dedupeRows(rows){
    const map=new Map();for(const row of rows||[]){
      const identity=row.driver_pk!=null?'pk:'+row.driver_pk:row.coupang_id?'id:'+key(row.coupang_id):'key:'+row.meta_worker_key;
      const k=row.batch_id+'|'+identity,prior=map.get(k);
      if(!prior||(parseKst(row.last_seen_at)?.getTime()||0)>=(parseKst(prior.last_seen_at)?.getTime()||0))map.set(k,row);
    }return [...map.values()];
  }
  return {n,key,expectedRounds,parseKst,fmtClock,activeDate,addDate,isStarted,doneAt,visibleUntil,collection,mergeFresh,dedupeRows};
});
