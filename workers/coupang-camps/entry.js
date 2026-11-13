import { WorkerEntrypoint } from "cloudflare:workers";
const ALLOWED_ORIGINS = new Set([
  "https://tonest-corp.com",
  "https://www.tonest-corp.com"
]);

const READ_ROLES = new Set([
  "super_admin",
  "admin",
  "team_leader",
  "driver"
]);

const WRITE_ROLES = new Set([
  "super_admin",
  "admin",
  "team_leader"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGINS.has(origin) ? origin : "https://tonest-corp.com",
    "Access-Control-Allow-Methods":
      "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization",
    "Access-Control-Max-Age":"86400",
    "Vary":"Origin"
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{
      ...corsHeaders(request),
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

function text(value) {
  return String(value ?? "").trim();
}

function supabaseUrl(env) {
  return text(env.SUPABASE_URL).replace(/\/+$/,"");
}

function publicKey(env) {
  return text(
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY
  );
}

function serviceKey(env) {
  return text(
    env.SUPABASE_SERVICE_ROLE ||
    env.SUPABASE_SECRET_KEY
  );
}

function maroApiKey(env) {
  return text(env.MAROOWELL_API_KEY);
}

function kakaoRestKey(env) {
  return text(env.KAKAO_REST_API_KEY);
}

function maroBase(env) {
  return text(
    env.MAROOWELL_API_BASE ||
    "https://purple-river-0717.brain-0f6.workers.dev"
  ).replace(/\/+$/,"");
}

function bearer(request) {
  const raw = request.headers.get("Authorization") || "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function supabaseFetch(env, path, options = {}, useService = false) {
  const base = supabaseUrl(env);
  const key = useService ? serviceKey(env) : publicKey(env);

  if (!base || !key) {
    throw new Error("Supabase 환경변수가 누락되었습니다.");
  }

  const headers = new Headers(options.headers || {});
  headers.set("apikey", key);

  if (useService) {
    headers.set("Authorization", "Bearer " + key);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(base + path, {
    ...options,
    headers
  });
}

async function sessionUser(request, env) {
  const token = bearer(request);
  if (!token) {
    throw httpError(401, "로그인이 필요합니다.");
  }

  const response = await supabaseFetch(
    env,
    "/auth/v1/user",
    {
      headers:{
        "Authorization":"Bearer " + token
      }
    },
    false
  );

  if (!response.ok) {
    throw httpError(401, "로그인 세션이 만료되었습니다.");
  }

  const user = await response.json().catch(() => null);
  if (!user?.id) {
    throw httpError(401, "로그인 사용자를 확인할 수 없습니다.");
  }

  return user;
}

async function profileFor(env, userId) {
  const response = await supabaseFetch(
    env,
    "/rest/v1/profiles" +
      "?select=user_id,email,display_name,role,status" +
      "&user_id=eq." + encodeURIComponent(userId) +
      "&limit=1",
    {},
    true
  );

  if (!response.ok) {
    throw new Error("TO:NEST 프로필 조회에 실패했습니다.");
  }

  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function requireAccess(request, env, write = false) {
  const user = await sessionUser(request, env);
  const profile = await profileFor(env, user.id);

  if (!profile || profile.status !== "active") {
    throw httpError(403, "활성화된 TO:NEST 계정이 필요합니다.");
  }

  const allowed = write
    ? WRITE_ROLES.has(profile.role)
    : READ_ROLES.has(profile.role);

  if (!allowed) {
    throw httpError(
      403,
      write
        ? "캠프 수정 권한이 없습니다."
        : "캠프 조회 권한이 없습니다."
    );
  }

  return { user, profile };
}

async function maroFetch(env, path, options = {}) {
  const key = maroApiKey(env);
  if (!key) {
    throw new Error("MAROOWELL_API_KEY가 설정되지 않았습니다.");
  }

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + key);

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(maroBase(env) + path, {
    ...options,
    headers
  });
}


function parseCoordinate(value, min, max, label) {
  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max
  ) {
    throw httpError(
      400,
      `${label} 좌표가 올바르지 않습니다.`
    );
  }

  return n;
}

async function kakaoDirections(
  env,
  originLng,
  originLat,
  destinationLng,
  destinationLat,
  priority
) {
  const key = kakaoRestKey(env);

  if (!key) {
    throw new Error(
      "KAKAO_REST_API_KEY가 설정되지 않았습니다."
    );
  }

  const params =
    new URLSearchParams({
      origin:
        `${originLng},${originLat}`,
      destination:
        `${destinationLng},${destinationLat}`,
      priority,
      summary:"true"
    });

  const response =
    await fetch(
      "https://apis-navi.kakaomobility.com/v1/directions?" +
      params.toString(),
      {
        method:"GET",
        headers:{
          "Authorization":
            "KakaoAK " + key,
          "Content-Type":
            "application/json"
        }
      }
    );

  const payload =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    throw httpError(
      response.status,
      payload?.msg ||
      payload?.message ||
      payload?.error ||
      `카카오 길찾기 HTTP ${response.status}`
    );
  }

  const summary =
    payload?.routes?.[0]?.summary;

  if (!summary) {
    throw httpError(
      502,
      "카카오 길찾기 응답에 경로 요약이 없습니다."
    );
  }

  return {
    distance:
      Number(summary.distance || 0),
    duration:
      Number(summary.duration || 0)
  };
}

async function handleDirections(
  request,
  env,
  url
) {
  await requireAccess(
    request,
    env,
    false
  );

  const originLng =
    parseCoordinate(
      url.searchParams.get(
        "origin_lng"
      ),
      -180,
      180,
      "출발지 경도"
    );

  const originLat =
    parseCoordinate(
      url.searchParams.get(
        "origin_lat"
      ),
      -90,
      90,
      "출발지 위도"
    );

  const destinationLng =
    parseCoordinate(
      url.searchParams.get(
        "destination_lng"
      ),
      -180,
      180,
      "도착지 경도"
    );

  const destinationLat =
    parseCoordinate(
      url.searchParams.get(
        "destination_lat"
      ),
      -90,
      90,
      "도착지 위도"
    );

  const [
    shortestDistance,
    fastestTime
  ] =
    await Promise.all([
      kakaoDirections(
        env,
        originLng,
        originLat,
        destinationLng,
        destinationLat,
        "DISTANCE"
      ),
      kakaoDirections(
        env,
        originLng,
        originLat,
        destinationLng,
        destinationLat,
        "TIME"
      )
    ]);

  return json(
    request,
    {
      ok:true,
      shortestDistance,
      fastestTime,
      queriedAt:
        new Date().toISOString()
    }
  );
}

async function proxyJson(request, env, targetPath, options = {}) {
  const response = await maroFetch(env, targetPath, options);
  const body = await response.text();

  return new Response(body, {
    status:response.status,
    headers:{
      ...corsHeaders(request),
      "Content-Type":
        response.headers.get("Content-Type") ||
        "application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}


async function sourceDirectory(env, path) {
  const res = await maroFetch(env,path);
  if(!res.ok) throw new Error("Marowell source API HTTP " + res.status);
  const raw = await res.json();
  const rows = Array.isArray(raw) ? raw : raw.rows || raw.data || raw.items;
  if(!Array.isArray(rows) || rows.length === 0 || rows.length >= 1000)
    throw new Error("Refusing partial/empty source snapshot " + path);
  return rows;
}
async function mirrorFetch(env,table,options={}) {
  const result = await supabaseFetch(env,"/rest/v1/"+table+(options.query||""),{
    method:options.method||"GET",
    headers:options.headers||{},
    body:options.body
  },true);
  if(!result.ok) throw new Error("TO:NEST "+table+" HTTP "+result.status+" "+(await result.text()).slice(0,120));
  if(options.method==="POST") return null;
  return result.json();
}
async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hashed = await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hashed)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function syncMirrorTable(env,table,endpoint,makeRow) {
  const source = await sourceDirectory(env,endpoint);
  const existing = await mirrorFetch(env,table,{query:"?select=source_id,row_hash&limit=2000"});
  const hashes = new Map(existing.map(r=>[Number(r.source_id),r.row_hash]));
  const changed=[];
  for(const row of source){
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<1) throw new Error("Invalid mirror row ID");
    const hash=await fingerprint(row);
    if(hashes.get(id)!==hash) changed.push(makeRow(row,hash));
  }
  for(let i=0;i<changed.length;i+=75)
    await mirrorFetch(env,table,{
      method:"POST",query:"?on_conflict=source_id",
      headers:{"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify(changed.slice(i,i+75))
    });
  // Missing rows never trigger automatic deletion; source API has no cursor pagination.
  return {total:source.length,changed:changed.length};
}
function asCampRow(r,h) {
  const fields=["mb_camp","code","camp_type","address","region","area",
  "latitude","longitude","parent_camp_id","receiving_sh_id","numbering_url","description"];
  const row={source_id:Number(r.id),camp:String(r.camp||""),source_updated_at:r.updated_at||null,
    source_payload:r,row_hash:h};
  for(const field of fields) row[field]=r[field]??null;
  return row;
}
function asRouteRow(r,h){
  return {source_id:Number(r.id),camp:r.camp??null,code:String(r.code||""),
    full_code:r.full_code??null,delivery_location_name:r.delivery_location_name??null,
    delivery_location_address:r.delivery_location_address??null,
    is_active:r.is_active!==false,source_updated_at:r.updated_at??null,row_hash:h};
}
async function syncTonestCamps(env){
  const start=new Date().toISOString();
  let camp=null, route=null, error="";
  try{
    camp=await syncMirrorTable(env,"camps_mirror","/api/v1/camps?limit=1000",asCampRow);
    try{
      route=await syncMirrorTable(env,"subsubroutes_mirror","/api/v1/subsubroutes?limit=1000",asRouteRow);
    }catch(e){error="Subroutes mirror: "+String(e?.message||e);}
  }catch(e){error="Camps mirror: "+String(e?.message||e);}
  const status=error?"failed":"success";
  try{
    await mirrorFetch(env,"camps_sync_runs",{
      method:"POST",headers:{"Content-Type":"application/json","Prefer":"return=minimal"},
      body:JSON.stringify({started_at:start,finished_at:new Date().toISOString(),
        status,total_rows:camp?.total||0,changed_rows:(camp?.changed||0)+(route?.changed||0),
        deleted_rows:0,error_message:error||null})
    });
  }catch(e){console.error("camp sync audit failed",e);}
  if(!camp) throw new Error(error);
  return {status,camps:camp,subsubroutes:route,warning:error};
}
async function localCamps(request,env,url){
  const records=await mirrorFetch(env,"camps_mirror",{
    query:"?select=source_payload&order=source_updated_at.desc.nullslast,source_id.desc&limit=1000"
  });
  const q=text(url.searchParams.get("q")).toLowerCase();
  const camp=text(url.searchParams.get("camp")).toLowerCase();
  const mb=text(url.searchParams.get("mb_camp")||url.searchParams.get("ormb_camp")||url.searchParams.get("orbm_camp")).toLowerCase();
  const limit=Math.max(1,Math.min(1000,Number(url.searchParams.get("limit"))||500));
  const rows=records.map(r=>r.source_payload).filter(r=>{
    const a=String(r.camp||"").trim().toLowerCase(),b=String(r.mb_camp||"").trim().toLowerCase();
    return (!q||a.includes(q)||b.includes(q))&&(!camp||a===camp)&&(!mb||b===mb);
  }).slice(0,limit);
  return json(request,{rows,source:"tonest-mirror"});
}
async function reconcileAfterWrite(env,request,response){
  if(!response.ok) return response;
  const payload=await response.clone().json().catch(()=>({}));
  const row=payload.row;
  if(row?.id){
    const updated=asCampRow(row,await fingerprint(row));
    await mirrorFetch(env,"camps_mirror",{
      method:"POST",query:"?on_conflict=source_id",
      headers:{"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify([updated])
    });
  } else {
    await syncTonestCamps(env);
  }
  return response;
}

export default {
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(syncTonestCamps(env));
  },
  async fetch(request, env,ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/,"") || "/";

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status:204,
          headers:corsHeaders(request)
        });
      }

      if (path === "/health" && request.method === "GET") {
        return json(request, {
          ok:true,
          service:"tonest-coupang-camps",
          maroApiConfigured:!!maroApiKey(env),
          kakaoDirectionsConfigured:!!kakaoRestKey(env),
          time:new Date().toISOString()
        });
      }

      if (path === "/me" && request.method === "GET") {
        const access = await requireAccess(request, env, false);
        return json(request, {
          ok:true,
          user:{
            id:access.user.id,
            email:access.user.email || ""
          },
          profile:access.profile,
          canEdit:WRITE_ROLES.has(access.profile.role)
        });
      }

      if (
        path === "/directions" &&
        request.method === "GET"
      ) {
        return handleDirections(
          request,
          env,
          url
        );
      }

      if (path === "/sync" && request.method === "POST") {
        const access=await requireAccess(request,env,true);
        if(access.profile.role!=="super_admin") throw httpError(403,"최고관리자만 수동 동기화할 수 있습니다.");
        return json(request,await syncTonestCamps(env));
      }
      if (path === "/camps" && request.method === "GET") {
        await requireAccess(request,env,false);
        return localCamps(request,env,url);
      }

      if (path === "/camps" && request.method === "POST") {
        await requireAccess(request, env, true);
        const body = await request.text();

        const response=await proxyJson(
          request,
          env,
          "/api/v1/camps",
          {
            method:"POST",
            body
          }
        );
        if(response.ok) ctx.waitUntil(reconcileAfterWrite(env,request,response.clone()));
        return response;
      }

      if (path === "/camps/batch" && request.method === "POST") {
        await requireAccess(request, env, true);
        const body = await request.text();

        const response=await proxyJson(
          request,
          env,
          "/api/v1/camps/batch",
          {
            method:"POST",
            body
          }
        );
        if(response.ok) ctx.waitUntil(syncTonestCamps(env));
        return response;
      }

      const match = path.match(/^\/camps\/(\d+)$/);

      if (match && request.method === "PATCH") {
        await requireAccess(request, env, true);
        const body = await request.text();

        const response=await proxyJson(
          request,
          env,
          "/api/v1/camps/" + match[1],
          {
            method:"PATCH",
            body
          }
        );
        if(response.ok) ctx.waitUntil(syncTonestCamps(env));
        return response;
      }

      if (match && request.method === "DELETE") {
        await requireAccess(request, env, true);

        const response=await proxyJson(
          request,
          env,
          "/api/v1/camps/" + match[1],
          { method:"DELETE" }
        );
        if(response.ok) ctx.waitUntil(syncTonestCamps(env));
        return response;
      }

      return json(request, {
        ok:false,
        message:"Not Found"
      }, 404);

    } catch (error) {
      console.error("TO:NEST CAMPS WORKER ERROR", error);

      return json(
        request,
        {
          ok:false,
          message:error?.message || "서버 처리 중 오류가 발생했습니다."
        },
        Number(error?.status || 500)
      );
    }
  }
};

// Accessible only by an explicit Cloudflare service binding, not an HTTP route.
export class RealtimeCampDirectory extends WorkerEntrypoint {
  async listCamps(camp = '') {
    const params = new URLSearchParams({limit:'1000'});
    if (camp) params.set('camp', String(camp).slice(0,120));
    const records=await mirrorFetch(this.env,"camps_mirror",{
      query:"?select=source_payload&order=source_updated_at.desc.nullslast,source_id.desc&limit=1000"
    });
    const rows=records.map(item=>item.source_payload);
    const filter=String(camp||"").trim().toLowerCase();
    return filter?rows.filter(r=>String(r.camp||"").trim().toLowerCase()===filter):rows;
  }
}
