import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const html=fs.readFileSync(path.join(root,"public","route_info"),"utf8");
function part(begin,end){
 const a=html.indexOf(begin);
 assert(a>=0,"Missing start marker "+begin);
 const b=html.indexOf(end,a+begin.length);
 assert(b>a,"Missing end marker "+end);
 return html.slice(a,b);
}
function context(values={}){
 const ctx={console,Headers,AbortController,setTimeout,clearTimeout, ...values};
 vm.createContext(ctx);
 return ctx;
}
function run(ctx,text,exports){
 vm.runInContext(text+"\n"+"globalThis.__test={"+exports.join(",")+"};",ctx);
 return ctx.__test;
}

test("HTML inline JavaScript still parses after changing network timeout and focus behavior",()=>{
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
 assert(scripts.length);
 scripts.forEach(x=>new vm.Script(x));
 assert(!html.includes('window.addEventListener("focus"'),"No automatic focus reloading");
 assert(html.includes('window.addEventListener("beforeunload"'));
});

test("a stalled GET aborts instead of keeping loading forever; spinner resets even on error",async()=>{
 const busy=[],statuses=[];
 const ctx=context({
  API:"https://route-info.test",
  state:{session:{access_token:"fake"},sb:{auth:{}}},
  currentToken:()=>"fake",
  fetch(_url,opts){return new Promise((_resolve,reject)=>{
   opts.signal.addEventListener("abort",()=>reject(new Error("AbortError")));
  })},
  dirtyCount:()=>0,confirm:()=>true,
  setBusy(v){ctx.state.busy=v;busy.push(v)},
  setStatus(t,tone){statuses.push({t,tone})},
  normalize:x=>x,
  applyFilters:()=>{},
 });
 const apiCode=part("const API_READ_TIMEOUT_MS=","async function initAuth()")
  .replace("const API_READ_TIMEOUT_MS=12000;","const API_READ_TIMEOUT_MS=40;")
  .replace("const API_WRITE_TIMEOUT_MS=20000;","const API_WRITE_TIMEOUT_MS=45;");
 const loadCode=part("async function load(force=false){","function addRow(){");
 const {load}=run(ctx,apiCode+"\n"+loadCode,["load"]);
 await load();
 assert.deepEqual(busy,[true,false]);
 assert.equal(ctx.state.busy,false);
 assert(statuses.some(s=>s.t.includes("불러오기 실패")&&s.t.includes("요청을 중단")));
});

test("successful save finishes immediately without fetching entire list again",async()=>{
 const statuses=[],calls=[],state={rows:[{_new:true,_dirty:true,camp:"대구1",route_code:"114B",wave:"WAVE2"}],busy:false};
 const ctx=context({
  state,
  text:v=>String(v??"").trim(),
  payloadFor:r=>({camp:r.camp,route_code:r.route_code,wave:r.wave}),
  api:async(path,options)=>{calls.push([path,options?.method]);return {row:{id:-3,camp:"대구1",route_code:"114B",wave:"WAVE2"}}},
  applyFilters:()=>{},
  setBusy:v=>{state.busy=v},
  setStatus:(t,tone)=>statuses.push({t,tone}),
 });
 const {saveAll}=run(ctx,part("async function saveOne(row){","async function syncOne(row){"),["saveAll"]);
 await saveAll();
 assert.equal(state.busy,false);
 assert.equal(state.rows[0]._dirty,false);
 assert.equal(state.rows[0]._new,false);
 assert.equal(state.rows[0].id,-3);
 assert.deepEqual(calls.map(c=>c[0]),["/routes"],"No GET load after a successful save");
 assert(statuses.some(s=>s.t.includes("저장 완료: 1건")&&s.tone==="ok"));
});

test("lost POST response is reconciled by camp+exact route without repeating INSERT",async()=>{
 const calls=[],state={rows:[{_new:true,_dirty:true,camp:"대구1",route_code:"114C",wave:"WAVE2"}],busy:false};
 const ctx=context({
  state,
  text:v=>String(v??"").trim(),
  payloadFor:r=>({camp:r.camp,route_code:r.route_code,wave:r.wave}),
  api:async(path,options)=>{
    calls.push(path);
    if(options?.method==="POST"){
      const e=new Error("response timed out after commit");e.code="ROUTE_API_TIMEOUT";throw e;
    }
    return {rows:[{id:-7,camp:"대구1",route_code:"114C",wave:"WAVE2"}]};
  },
  applyFilters:()=>{},
  setBusy:v=>{state.busy=v},
  setStatus:()=>{},
 });
 const {saveAll}=run(ctx,part("async function saveOne(row){","async function syncOne(row){"),["saveAll"]);
 await saveAll();
 assert.equal(state.busy,false);
 assert.equal(state.rows[0].id,-7);
 assert.equal(state.rows[0]._dirty,false);
 assert.equal(calls.length,2);
 assert.equal(calls.filter(x=>x==="/routes").length,1);
 assert(calls[1].includes("camp=")&&calls[1].includes("code="));
});

test("loading a local list without MAROOWELL is READY, not an endless WAIT badge",async()=>{
 const statuses=[],state={busy:false,rows:[]};
 const ctx=context({
  state,
  dirtyCount:()=>0,confirm:()=>true,
  setBusy:v=>{state.busy=v},
  setStatus:(t,tone)=>statuses.push({t,tone}),
  api:async()=>({rows:[{id:-2,camp:"대구1",route_code:"114A"}],maroowellStatus:"unconfigured"}),
  normalize:r=>r,applyFilters:()=>{},
 });
 const {load}=run(ctx,part("async function load(force=false){","function addRow(){"),["load"]);
 await load();
 assert.equal(state.busy,false);
 assert.equal(state.rows.length,1);
 assert.equal(statuses.at(-1).tone,"ok");
 assert(statuses.at(-1).t.includes("로드 완료: 1건"));
});
