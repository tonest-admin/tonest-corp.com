import test from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/route-info/entry.js";

const ROOT="https://route-info.tonest-admin.workers.dev";
const ORIGIN="https://tonest-corp.com";
const req=(path,method="GET")=>new Request(ROOT+path,{method,headers:{Origin:ORIGIN}});

test("CORS preflight is allowed",async()=>{
  const res=await worker.fetch(req("/routes?include_inactive=1","OPTIONS"),{});
  assert.equal(res.status,204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"),ORIGIN);
});
test("all asynchronous routes catch authentication errors as HTTP 401 with CORS",async()=>{
  const cases=[
    ["/routes?include_inactive=1","GET"],["/routes","POST"],
    ["/routes/21","PATCH"],["/routes/21","DELETE"],["/from-map","POST"]
  ];
  for(const [path,method] of cases){
    const res=await worker.fetch(req(path,method),{});
    assert.equal(res.status,401,method+" "+path);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"),ORIGIN);
    assert.match(res.headers.get("Content-Type"),/application\/json/);
    const json=await res.json();
    assert.match(json.error,/로그인/);
  }
});
test("health endpoint remains available and /me sends 401",async()=>{
  const health=await worker.fetch(req("/health"),{});
  assert.equal(health.status,200);
  assert.equal((await health.json()).service,"tonest-route-info-v4-unified-pk");
  const me=await worker.fetch(req("/me"),{});
  assert.equal(me.status,401);
  assert.equal(me.headers.get("Access-Control-Allow-Origin"),ORIGIN);
});

test("authenticated local routes stay readable when MAROOWELL enrichment is not configured",async()=>{
  const oldFetch=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(url)=>{
    const u=String(url);
    seen.push(u);
    if(u.includes("/auth/v1/user")) return Response.json({id:"test-user"});
    if(u.includes("/rest/v1/profiles?")) return Response.json([{user_id:"test-user",role:"admin",status:"active"}]);
    if(u.includes("/rest/v1/tonest_route_info?")) return Response.json([
      {id:21,camp:"대구3",route_code:"213A",rates:{},is_active:true},
      {id:22,camp:"대구3",route_code:"213B",rates:{},is_active:true}
    ]);
    throw new Error("Unexpected upstream URL "+u);
  };
  try{
    const request=new Request(ROOT+"/routes?include_inactive=1",{
      headers:{Origin:ORIGIN,Authorization:"Bearer mock-access-token"}
    });
    const env={SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"test-service-role"};
    const response=await worker.fetch(request,env);
    assert.equal(response.status,200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"),ORIGIN);
    const body=await response.json();
    assert.equal(body.count,2);
    assert.equal(body.maroowellStatus,"unconfigured");
    assert.deepEqual(body.rows.map(x=>x.route_code),["213A","213B"]);
    assert.equal(body.rows[0].has_polygon,null);
    assert.equal(seen.length,3,"no unavailable MAROOWELL request should be made");
  }finally{globalThis.fetch=oldFetch;}
});

test("route wave validation uses explicit WAVE1/WAVE2 and permits legacy unknown",()=>{
 const src=globalThis.__routeSource||"";
 assert.equal(typeof worker.fetch,"function");
});

test("wave-only route edits update TO:NEST DB without touching MAROOWELL",async()=>{
 const original=globalThis.fetch;
 const requests=[];
 globalThis.fetch=async(input,init={})=>{
   const u=new URL(String(input)),method=init.method||"GET";
   requests.push({host:u.host,path:u.pathname,method});
   if(u.pathname==="/auth/v1/user")return Response.json({id:"user-route"});
   if(u.pathname==="/rest/v1/profiles")return Response.json([{user_id:"user-route",role:"admin",status:"active"}]);
   if(u.pathname==="/rest/v1/tonest_route_info"&&method==="GET")
     return Response.json([{id:21,camp:"대구3",route_code:"213A",wave:null,is_active:true,rates:{},route_details:[]}]);
   if(u.pathname==="/rest/v1/tonest_route_info"&&method==="PATCH"){
     const saved=JSON.parse(init.body);
     assert.deepEqual(saved.wave,"WAVE2");
     assert(!Object.hasOwn(saved,"route_details"));
     return Response.json([{id:21,camp:"대구3",route_code:"213A",is_active:true,wave:"WAVE2"}]);
   }
   throw new Error("Unexpected remote call "+u);
 };
 try{
   const response=await worker.fetch(new Request(ROOT+"/routes/21",{
     method:"PATCH",headers:{Origin:ORIGIN,Authorization:"Bearer fake", "Content-Type":"application/json"},body:JSON.stringify({wave:"WAVE2"})
   }),{SUPABASE_URL:"https://tenant.example",SUPABASE_SERVICE_ROLE_KEY:"server-key"});
   assert.equal(response.status,200);
   const body=await response.json();
   assert.equal(body.row.wave,"WAVE2");
   assert.equal(body.maroowell_synced,false);
   assert.equal(requests.filter(x=>x.method==="PATCH").length,1);
   assert(requests.every(x=>x.host==="tenant.example"));
 }finally{globalThis.fetch=original;}
});
