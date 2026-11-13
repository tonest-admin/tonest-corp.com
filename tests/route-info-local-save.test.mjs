import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import vm from "node:vm";
import worker from "../workers/route-info/entry.js";

const BASE="https://route-info.tonest-admin.workers.dev";
const ORIGIN="https://tonest-corp.com";
const ENV={SUPABASE_URL:"https://db.example.test",SUPABASE_SERVICE_ROLE_KEY:"fake-service-role"};
const req=(pathname,method="GET",body)=>new Request(BASE+pathname,{
 method,headers:{"Origin":ORIGIN,"Authorization":"Bearer tester",
 ...(body?{"Content-Type":"application/json"}:{})},
 ...(body?{body:JSON.stringify(body)}:{})
});

test("new row is saved locally without MAROOWELL credentials or external PK",async()=>{
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url)),method=init.method||"GET";
  calls.push({url:u.href,method,data:init.body&&JSON.parse(init.body)});
  if(u.pathname==="/auth/v1/user")return Response.json({id:"test-user"});
  if(u.pathname==="/rest/v1/profiles")return Response.json([{user_id:"test-user",role:"admin",status:"active"}]);
  if(u.pathname==="/rest/v1/tonest_route_info"&&method==="GET")return Response.json([]);
  if(u.pathname==="/rest/v1/tonest_route_info"&&method==="POST"){
   const record=JSON.parse(init.body);
   assert.equal(Object.hasOwn(record,"id"),false,"DB default must generate local ID");
   assert.equal(record.camp,"대구1");
   assert.equal(record.route_code,"114A");
   assert.equal(record.maroowell_sync_status,"pending");
   return Response.json([{...record,id:-1}]);
  }
  throw Error("UNEXPECTED "+method+" "+u);
 };
 try{
  const res=await worker.fetch(req("/routes","POST",{camp:"대구1",route_code:"114A",wave:"WAVE2"}),ENV);
  const json=await res.json();
  assert.equal(res.status,201,JSON.stringify(json));
  assert.equal(json.row.id,-1);
  assert.equal(json.row.maroowell_sync_status,"pending");
  assert.equal(json.local_saved,true);
  assert.equal(json.maroowell_synced,false);
  assert(calls.every(x=>new URL(x.url).hostname==="db.example.test"),"No MAROOWELL calls");
 }finally{globalThis.fetch=old;}
});

test("existing local negative-ID can be edited while external sync is unavailable",async()=>{
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url)),method=init.method||"GET";calls.push({u,method,body:init.body});
  if(u.pathname==="/auth/v1/user")return Response.json({id:"test-user"});
  if(u.pathname==="/rest/v1/profiles")return Response.json([{user_id:"test-user",role:"admin",status:"active"}]);
  if(u.pathname==="/rest/v1/tonest_route_info"&&method==="GET")
   return Response.json([{id:-1,camp:"대구1",route_code:"114A",wave:"WAVE2",is_active:true,rates:{},route_details:[],maroowell_sync_status:"pending"}]);
  if(u.pathname==="/rest/v1/tonest_route_info"&&method==="PATCH"){
   const patch=JSON.parse(init.body);
   assert.equal(patch.wave,"WAVE1");
   assert.equal(Object.hasOwn(patch,"route_details"),false);
   return Response.json([{id:-1,camp:"대구1",route_code:"114A",wave:"WAVE1",maroowell_sync_status:"pending"}]);
  }
  throw Error("UNEXPECTED "+method+" "+u);
 };
 try{
  const res=await worker.fetch(req("/routes/-1","PATCH",{wave:"WAVE1"}),ENV);
  const json=await res.json();
  assert.equal(res.status,200,JSON.stringify(json));
  assert.equal(json.row.wave,"WAVE1");
  assert.equal(calls.filter(x=>x.method==="PATCH").length,1);
  assert(calls.every(x=>x.u.hostname==="db.example.test"));
 }finally{globalThis.fetch=old;}
});

test("sync without MAROOWELL credentials reports 503 rather than dropping local row",async()=>{
 const old=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url));
  if(u.pathname==="/auth/v1/user")return Response.json({id:"test-user"});
  if(u.pathname==="/rest/v1/profiles")return Response.json([{user_id:"test-user",role:"admin",status:"active"}]);
  if(u.pathname==="/rest/v1/tonest_route_info")return Response.json([{id:-1,camp:"대구1",route_code:"114A"}]);
  throw Error("UNEXPECTED "+u);
 };
 try{
  const res=await worker.fetch(req("/routes/-1/sync","POST"),ENV);
  const json=await res.json();
  assert.equal(res.status,503);
  assert.match(json.error,/저장되었/);
 }finally{globalThis.fetch=old;}
});

test("route information page does not discard unsaved rows on focus",()=>{
 const dir=path.dirname(fileURLToPath(import.meta.url));
 const html=readFileSync(path.join(dir,"../public/route_info"),"utf8");
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
 for(const js of scripts)new vm.Script(js);
 assert.match(html,/if\(row\._new\)return true/);
 assert.match(html,/if\(dirtyCount\(\)\)/);
 assert.doesNotMatch(html,/window\.addEventListener\("focus"/);
 assert.match(html,/await saveOne\(row\)/);
 assert.match(html,/마닷 동기화/);
 assert.match(html,/data-sync/);
 assert.doesNotMatch(html,/전체 저장 완료 · MAROOWELL에도 반영되었습니다/);
});
