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
