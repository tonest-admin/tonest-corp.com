// Complete standalone replacement; no local module imports required.
// Version: 2026-10-10-camp-fairness-v3
/**
 * TO:NEST META realtime collector - FULL
 *
 * 역할
 *  - Coupang META 로그인 + SMS MFA
 *  - META 세션 쿠키를 TO:NEST Supabase meta_backend_state 에 저장
 *  - META camps + driver directory create batches; schedules are optional
 *  - Fair per-camp polling, diagnostics for empty META responses, stable session state
 *  - MAROOWELL 공용 캠프 API에서 META camp code 조회
 *  - META 배송/반품/프레시백/신선배송 상태 1분 수집
 *  - meta_realtime_current / history / final 관리
 *  - tonest_info.pk_id 기준 기사 매칭
 *
 * Cloudflare ENV / Secret
 *  Required:
 *    SUPABASE_URL
 *    SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE / SUPABASE_SECRET_KEY
 *    META_ID
 *    META_PW
 *    CAMP_DIRECTORY service binding OR MAROOWELL_API_KEY
 *  Optional:
 *    MAROOWELL_API_BASE
 */

const FLY_REALTIME = "https://fly.coupang.com/ui/dashboard/realtime";
const META_WORKER_URL = "https://fly.coupang.com/realtime-dashboard/workers/work-status/search";
const META_CAMP_URL = "https://fly.coupang.com/realtime-dashboard/camps/work-status/search";
const MY_VENDOR_URL = "https://fly.coupang.com/v1/my-vendor";
const AUTH_START = "https://fly.coupang.com/oauth2/authorization/keycloak";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const DEFAULT_MAROOWELL_API_BASE = "https://purple-river-0717.brain-0f6.workers.dev";
const ALLOWED_FRAME_ANCESTORS = ["https://tonest-corp.com", "https://www.tonest-corp.com"];

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }
});

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `frame-ancestors ${ALLOWED_FRAME_ANCESTORS.join(" ")}`
    }
  });
}

const text = v => String(v ?? "").trim();
const uniq = xs => [...new Set((xs || []).map(v => text(v)).filter(Boolean))];
const normRoute = v => text(v).toUpperCase().replace(/[^0-9A-Z가-힣]/g, "");
const pct = (a, b) => Number(b || 0) > 0 ? Math.round(Number(a || 0) / Number(b) * 10000) / 100 : 100;
const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function requireConfig(env) {
  const missing=[];
  if(!text(env.SUPABASE_URL))missing.push('SUPABASE_URL');
  if(!serviceKey(env))missing.push('SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE / SUPABASE_SECRET_KEY');
  if(!env.CAMP_DIRECTORY&&!text(env.MAROOWELL_API_KEY))missing.push('CAMP_DIRECTORY binding / MAROOWELL_API_KEY');
  if(missing.length)throw new Error('Missing configuration: '+missing.join(', '));
}

function serviceKey(env){return text(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE);}

function supabaseUrl(env) {
  return text(env.SUPABASE_URL).replace(/\/+$/, "");
}

function maroBase(env) {
  return text(env.MAROOWELL_API_BASE || DEFAULT_MAROOWELL_API_BASE).replace(/\/+$/, "");
}

function kstParts(d = new Date()) {
  const x = new Date(d.getTime() + 9 * 3600000);
  return { date: x.toISOString().slice(0, 10), hour: x.getUTCHours(), minute: x.getUTCMinutes() };
}

function addDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function kstIsoAt(ms) {
  const d = new Date(ms + 9 * 3600000);
  return d.toISOString().slice(0, -1);
}

const nowIso = () => kstIsoAt(Date.now());
const sampleMinute = v => `${String(v || "").slice(0, 16)}:00`;

function tsMs(v) {
  if (!v) return NaN;
  const s = String(v).replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}+09:00`);
}

function minutesBetween(a, b) {
  const x = tsMs(a), y = tsMs(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, (y - x) / 60000) : 0;
}

function addMinutesIso(v, minutes) {
  const x = tsMs(v);
  if (!Number.isFinite(x)) return null;
  return kstIsoAt(x + Number(minutes || 0) * 60000);
}

function metaContent(x) {
  if (Array.isArray(x?.data?.content)) return x.data.content;
  if (Array.isArray(x?.content)) return x.content;
  if (Array.isArray(x?.data?.data?.content)) return x.data.data.content;
  return [];
}

function workerName(src) {
  const w = src?.workerInfo || {};
  return text(w.workerName || w.name || w.workerDisplayName || w.displayName);
}

function coupangId(src) {
  const w = src?.workerInfo || {};
  for (const k of ["coupangId", "loginId", "coupangLoginId", "workerLoginId"]) {
    const v = w?.[k] ?? src?.[k];
    if (text(v)) return text(v);
  }
  return null;
}

function workerKey(src) {
  const w = src?.workerInfo || {};
  const cid = coupangId(src);
  if (cid) return `coupang:${cid.toLowerCase()}`;
  const name = workerName(src);
  if (name) return `name:${name.toLowerCase()}`;
  for (const k of ["workerSrl", "workerId", "id", "userId", "memberSrl", "memberId"]) {
    const v = w?.[k] ?? src?.[k];
    if (text(v)) return `${k}:${text(v)}`;
  }
  const routes = uniq((w.workSubRoutes || []).map(normRoute)).sort().join(",");
  return `fallback:${routes || "no-route"}`;
}

function canonicalIdentity(cid, name, fallback) {
  const id = text(cid).toLowerCase();
  if (id) return `coupang:${id}`;
  const dn = text(name).toLowerCase();
  if (dn) return `name:${dn}`;
  return text(fallback || "unknown");
}

function rowIdentity(r) {
  // Aggregate mode contains multiple real camps under one batch. Match the
  // previous reading by its camp-scoped key, never by a cross-camp driver PK.
  if (text(r?.meta_worker_key).startsWith('camp:')) return text(r.meta_worker_key);
  return r?.driver_pk != null
    ? `pk:${Number(r.driver_pk)}`
    : canonicalIdentity(r?.coupang_id, r?.driver_name, r?.meta_worker_key);
}

function driverIdentity(driverPk, cid, name, fallback) {
  return driverPk != null
    ? `pk:${Number(driverPk)}`
    : canonicalIdentity(cid, name, fallback);
}

function infoWave(wave) {
  const w = text(wave).toUpperCase();
  if (w === "WAVE1") return "야간";
  if (w === "WAVE2") return "주간";
  return text(wave);
}

// Same nested META payload walk used by the working CHUNWOO collector.
function deepValueByKeys(root, keys, maxDepth=5) {
  const wanted=new Set(keys.map(k=>String(k).toLowerCase()));
  const queue=[{v:root,d:0}],seen=new Set();
  while(queue.length) {
    const {v,d}=queue.shift();
    if(!v||typeof v!=='object'||seen.has(v))continue;
    seen.add(v);
    for(const [k,child] of Object.entries(v)) {
      if(wanted.has(k.toLowerCase())&&child!=null&&typeof child!=='object'&&text(child))return child;
    }
    if(d<maxDepth)for(const child of Object.values(v))if(child&&typeof child==='object')queue.push({v:child,d:d+1});
  }
  return null;
}
function sourceCampCode(src) {
  const value=deepValueByKeys(src,['campCode','sourceCampCode','workCampCode','deliveryCampCode','baseCampCode']);
  return value!=null ? text(value).toUpperCase() : null;
}
function campSummaryName(src) {
  const value=deepValueByKeys(src,['campName','workCampName','sourceCampName','deliveryCampName','baseCampName']);
  return text(value)||null;
}
function resolveSourceCamp(src,index,aggregate) {
  const code=sourceCampCode(src);
  const name=campSummaryName(src);
  const found=(code&&index?.byCode.get(code))||(name&&index?.byName.get(name));
  if(found)return {code:found.code,name:found.name,sourceCode:code||found.code,mapped:true};
  // Never silently assign a worker to the synthetic __ALL__ camp.
  if(aggregate===true)return {code:code||'META_UNMAPPED',name:name||code||'META 캠프 미분류',sourceCode:code,mapped:false};
  return {code:code||'META_UNMAPPED',name:name||code||'META 캠프 미분류',sourceCode:code,mapped:false};
}

function deliveryMetric(s = {}) {
  const assigned = +s.assignedCount || 0;
  const scanned = +s.scannedCount || 0;
  const completed = +s.completedCount || 0;
  const impossible = +s.impossibleCount || 0;
  const pdd = +s.pddMissCount || 0;
  const total = assigned + scanned + completed + impossible + pdd;
  const sourceRate = s.completedRatio==null?NaN:Number(s.completedRatio);
  const rate = Number.isFinite(sourceRate) ? sourceRate : (total > 0 ? pct(completed, total) : 0);
  return { assigned, scanned, completed, impossible, pdd, total, rate };
}

function collectionMetric(s = {}, includeAbsent = false) {
  const pending = +s.assignedCount || 0;
  const collected = +s.collectedCount || 0;
  const rawUn = +s.uncollectedCount || 0;
  const rawAbsent = includeAbsent ? (+s.absentCount || 0) : 0;
  const uncollected = Math.max(rawUn, rawAbsent);
  const total = pending + collected + uncollected;
  const attempted = collected + uncollected;
  return {
    pending, collected, rawUn, rawAbsent, uncollected, total,
    attemptRate: pct(attempted, total),
    collectionRate: pct(collected, total)
  };
}

// ============================================================================
// Supabase REST helpers
// ============================================================================

async function sb(env,path,init={}){
  const key=serviceKey(env);if(!key||!supabaseUrl(env))throw new Error('Supabase configuration is missing');
  const headers=new Headers(init.headers||{});headers.set('apikey',key);headers.set('accept','application/json');
  if(key.startsWith('eyJ'))headers.set('authorization','Bearer '+key);
  if(init.body&&!headers.has('content-type'))headers.set('content-type','application/json');
  const response=await fetch(supabaseUrl(env)+'/rest/v1/'+path,{...init,headers,signal:init.signal||AbortSignal.timeout(15000)});
  const raw=await response.text();let body=null;try{body=raw?JSON.parse(raw):null;}catch{}
  if(!response.ok)throw Object.assign(new Error('Supabase '+response.status+' '+path.split('?')[0]+': '+(body?.message||raw.slice(0,250))),{status:response.status,code:body?.code});
  return body;
}

const sbGet = (env, path) => sb(env, path);
const sbPatch = (env, path, body) => sb(env, path, {
  method: "PATCH",
  headers: { prefer: "return=representation" },
  body: JSON.stringify(body)
});
const sbDelete = (env, path) => sb(env, path, {
  method: "DELETE",
  headers: { prefer: "return=minimal" }
});
const sbPost = (env, path, body, prefer = "return=representation") => sb(env, path, {
  method: "POST",
  headers: { prefer },
  body: JSON.stringify(body)
});
const sbUpsert = (env, path, body, conflict) => sb(env, `${path}?on_conflict=${encodeURIComponent(conflict)}`, {
  method: "POST",
  headers: { prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify(body)
});

// ============================================================================
// MAROOWELL public camp API
// ============================================================================

async function maroFetch(env, path) {
  const key = text(env.MAROOWELL_API_KEY);
  if (!key) throw new Error("MAROOWELL_API_KEY 없음");
  const response = await fetch(`${maroBase(env)}${path}`, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json"
    }
  });
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) throw new Error(`MAROOWELL API ${response.status}: ${raw.slice(0, 500)}`);
  return data ?? {};
}

async function getMaroCampRows(env,camp=''){
  if(env.CAMP_DIRECTORY?.listCamps){const rows=await env.CAMP_DIRECTORY.listCamps(camp);return Array.isArray(rows)?rows:[];}
  const params=new URLSearchParams({limit:'1000'});if(text(camp))params.set('camp',text(camp));
  const payload=await maroFetch(env,'/api/v1/camps?'+params);
  return Array.isArray(payload)?payload:(payload.rows||payload.data||payload.items||[]);
}

function metaCampCandidates(codes) {
  const out = [];
  for (const raw of codes || []) {
    const c = text(raw).toUpperCase();
    if (!c) continue;
    out.push(c);
    if (/^SG\d{2}$/.test(c)) out.push(`S6${c.slice(2)}`);
    if (/^MO\d{2}$/.test(c)) out.push(`M0${c.slice(2)}`);
  }
  return uniq(out);
}

async function loadCampMeta(env, camp) {
  const rows = await getMaroCampRows(env, camp);
  const rawCodes = uniq(rows.map(r => text(r?.code).toUpperCase()).filter(Boolean)).sort();
  const codes = metaCampCandidates(rawCodes);
  const baseRow = rows.find(r => text(r?.mb_camp) === "본캠프" && text(r?.code)) || rows.find(r => text(r?.code));
  const campCode = text(baseRow?.code).toUpperCase() || rawCodes[0] || codes[0] || "";
  return { rows, rawCodes, codes, campCode };
}

async function verificationCampCodes(env){
  const rows=await loadMaster(env);return metaCampCandidates(uniq(rows.map(r=>r.code||r.campCode)));
}

// ============================================================================
// META HTTP / cookie helpers
// ============================================================================

function parseCookieBundle(bundle) {
  const map = new Map();
  for (const part of String(bundle || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return map;
}

function cookieHeader(map, url = META_WORKER_URL) {
  if (typeof map?.header === 'function') return map.header(url);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function cookiesFromState(state) {
  let cookies;
  if (Array.isArray(state?.cookie_jar) && state.cookie_jar.length) {
    cookies = new CookieJar(state.cookie_jar);
  } else {
    const original = parseCookieBundle(state?.cookie_bundle || '');
    cookies = new CookieJar([...original.entries()].map(([name,value]) => ({
      name,value,domain:'fly.coupang.com',path:'/',hostOnly:true,secure:true
    })));
  }
  cookies.originalBundle = state?.cookie_bundle || '';
  cookies.generation = state?.session_generation ?? null;
  return cookies;
}

function splitSetCookie(raw) {
  if (!raw) return [];
  return String(raw).split(/,(?=[^;,]+=)/g);
}

function absorbSetCookies(map, response, requestUrl = META_WORKER_URL) {
  if (typeof map?.absorb === 'function') return map.absorb(response, requestUrl);
  const lines = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get("set-cookie"));
  for (const line of lines) {
    const first = String(line || "").split(";", 1)[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i), value = first.slice(i + 1);
    const expired = /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line) || value === "";
    if (expired) map.delete(name); else map.set(name, value);
  }
}

async function metaPage(cookies,url,payload){
  const response=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{
    accept:'application/json','accept-language':'ko-KR','content-type':'application/json;charset=UTF-8',
    origin:'https://fly.coupang.com',referer:FLY_REALTIME,'user-agent':UA,
    'x-coupang-accept-language':'ko-KR','x-requested-with':'XMLHttpRequest',cookie:cookieHeader(cookies,url)},body:JSON.stringify(payload)});
  absorbSetCookies(cookies,response,url);
  const raw=await response.text();let body=null;try{body=JSON.parse(raw);}catch{}
  const content=Array.isArray(body?.data?.content)||Array.isArray(body?.content)||Array.isArray(body?.data?.data?.content);
  return {status:response.status,raw,body,success:response.status===200&&content};
}
async function metaPost(cookies,url,payload){
  const first=await metaPage(cookies,url,payload);if(!first.success)return first;
  const rows=[...metaContent(first.body)];let response=first;
  for(let page=1;page<=10;page++){
    const info=response.body?.data?.data||response.body?.data||response.body;
    if(info?.last===true||(Number.isFinite(info?.totalPages)&&page>=info.totalPages)||metaContent(response.body).length<payload.size)break;
    if(page===10)throw new Error('META_PAGE_LIMIT: 10 pages per 20 camp-code chunk; refused partial worker update');
    response=await metaPage(cookies,url,{...payload,page});if(!response.success)return response;
    rows.push(...metaContent(response.body));
  }
  return {...first,body:{data:{content:rows}}};
}

async function metaGet(cookies,url) {
  const response=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{
    accept:'application/json','accept-language':'ko-KR',referer:FLY_REALTIME,'user-agent':UA,
    'x-coupang-accept-language':'ko-KR','x-requested-with':'XMLHttpRequest',cookie:cookieHeader(cookies,url)}});
  absorbSetCookies(cookies,response,url);
  const raw=await response.text();let body=null;try{body=JSON.parse(raw);}catch{}
  if([301,302,303,307,308,401,403].includes(response.status)||!/json/i.test(response.headers.get('content-type')||'')&&body==null){
    throw Object.assign(new Error('META_AUTH_EXPIRED or response not JSON /v1/my-vendor HTTP '+response.status),{metaAuthRequired:true,status:response.status});
  }
  if(response.status!==200)throw Object.assign(new Error('META my-vendor '+response.status+': '+raw.slice(0,250)),{status:response.status});
  return body;
}
async function fetchMyVendor(cookies){
  const body=await metaGet(cookies,MY_VENDOR_URL);
  const data=body?.data||{};
  const codes=uniq(Array.isArray(data.contractedCampCodes)?data.contractedCampCodes:[]).map(s=>s.toUpperCase());
  if(!codes.length)throw new Error('META /v1/my-vendor contractedCampCodes EMPTY: check vendor scope');
  return {vendorName:text(data.name),vendorCode:text(data.vendorCode),contractedCampCodes:codes};
}
async function fetchMetaByCodeChunks(cookies,url,codes,wave,workDate,pddTime=null){
  const rows=[];const used=uniq(codes);
  // CHUNWOO's 20-code chunks prevent mixed-vendor and invalid camp aliases.
  for(let i=0;i<used.length;i+=20){
    const response=await metaPost(cookies,url,workerPayload(used.slice(i,i+20),wave,workDate,pddTime));
    if(!response.success)throw metaFailure(response,'META '+url.split('/').at(-1));
    rows.push(...metaContent(response.body));
  }
  return {success:true,status:200,body:{data:{content:rows}},count:rows.length};
}

function workerPayload(campCodes, wave, workDate, pddTime = null) {
  return {
    campCodes,
    page: 0,
    size: 100,
    sortDirection: "ASC",
    sortType: "DELIVERY_COMPLETED_RATIO",
    waveCode: wave,
    workDate,
    ...(pddTime ? { pddTime } : {})
  };
}

async function sessionState(env) {
  const rows = await sbGet(env, "meta_backend_state?id=eq.1&select=*");
  return rows?.[0] || null;
}

async function saveSession(env, cookies, status = "active", http = 200, error = null) {
  const current = new Date().toISOString();
  const patch = {status,last_http_status:http,last_error:error,updated_at:current};
  if (status === 'active' && !error) {
    patch.cookie_bundle = cookieHeader(cookies,META_WORKER_URL);
    if (typeof cookies?.dump === 'function') patch.cookie_jar = cookies.dump();
    patch.last_success_at = current;
    patch.session_renewed_at = current;
  }
  // A background request must never overwrite a cookie rotated by a
  // different Cron execution or a freshly completed user login.
  let query = 'meta_backend_state?id=eq.1';
  if (Object.hasOwn(cookies || {}, 'originalBundle')) {
    query += '&cookie_bundle=eq.' + encodeURIComponent(cookies.originalBundle);
    if (cookies.generation != null) query += '&session_generation=eq.' + encodeURIComponent(cookies.generation);
  }
  const rows = await sbPatch(env,query,patch);
  if (Array.isArray(rows) && rows.length === 0) return false; // stale snapshot
  if (patch.cookie_bundle) cookies.originalBundle = patch.cookie_bundle;
  return true;
}

// ============================================================================
// Schedule / driver mapping
// ============================================================================

async function loadDriverDirectory(env){return await optionalGet(env,'tonest_info?select=pk_id,person_name,coupang_id,camp_code,wave,is_resigned&order=pk_id.asc&limit=1000');}

function resolveDriverPk(directory, cid, name, camp, wave) {
  const id = text(cid).toLowerCase();
  const dn = text(name);
  const campName = text(camp);
  const iw = infoWave(wave);
  const active = r => r?.is_resigned !== true;

  if (id) {
    const byId = (directory || []).filter(r => text(r?.coupang_id).toLowerCase() === id);
    if (byId.length === 1) return Number(byId[0].pk_id);
    const scopedActive = byId.filter(r =>
      (!campName || text(r?.camp_code) === campName) &&
      (!iw || text(r?.wave) === iw) && active(r)
    );
    if (scopedActive.length === 1) return Number(scopedActive[0].pk_id);
    const scoped = byId.filter(r =>
      (!campName || text(r?.camp_code) === campName) &&
      (!iw || text(r?.wave) === iw)
    );
    if (scoped.length === 1) return Number(scoped[0].pk_id);
  }

  if (dn) {
    const scopedActive = (directory || []).filter(r =>
      text(r?.person_name) === dn &&
      (!campName || text(r?.camp_code) === campName) &&
      (!iw || text(r?.wave) === iw) && active(r)
    );
    if (scopedActive.length === 1) return Number(scopedActive[0].pk_id);
    const byName = (directory || []).filter(r => text(r?.person_name) === dn);
    if (byName.length === 1) return Number(byName[0].pk_id);
  }

  return null;
}

async function loadSchedule(env, date, wave, camp=null) {
  // For the __ALL__ batch fetch the entire day's schedule once and match
  // each META worker against schedules of its resolved real camp.
  return await optionalGet(env,
    `tonest_schedule?select=camp,driver_pk,route_label,driver_name,driver_display_name,driver_owner_name,driver_export_name,driver_coupang_id,driver_account_type,row_order`+
    `&schedule_date=eq.${date}&wave=eq.${wave}`+
    (camp?`&camp=eq.${encodeURIComponent(camp)}`:'')+
    `&is_active=eq.true&order=row_order.asc&limit=1000`
  ) || [];
}

function scheduleMatch(rows,cid,name){
  const id=text(cid).toLowerCase(),dn=text(name);
  if(id)return rows.filter(r=>text(r.driver_coupang_id).toLowerCase()===id);
  const hits=rows.filter(r=>dn&&[r.driver_display_name,r.driver_name,r.driver_owner_name,r.driver_export_name].some(x=>text(x)===dn));
  const ids=uniq(hits.map(r=>r.driver_pk!=null?'pk:'+r.driver_pk:text(r.driver_coupang_id)||dn));
  return ids.length===1?hits:[];
}

function scheduledRouteMatches(actual, scheduled) {
  const a = normRoute(actual), b = normRoute(scheduled);
  return !!a && !!b && (a === b || a.startsWith(b));
}

function scheduleMatchByRoutes(rows, actualRoutes) {
  const owned = new Map();
  for (const actual of actualRoutes || []) {
    const candidates = rows
      .filter(r => r.route_label && r.route_label !== "휴무자" && scheduledRouteMatches(actual, r.route_label))
      .sort((a, b) => normRoute(b.route_label).length - normRoute(a.route_label).length);
    const best = candidates[0];
    if (!best) continue;
    const key = text(best.driver_pk ?? best.driver_coupang_id ?? best.driver_display_name ?? best.driver_name ?? best.driver_owner_name);
    if (!key) continue;
    owned.set(key, (owned.get(key) || 0) + 1);
  }
  const ranked = [...owned.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return [];
  const winner = ranked[0][0];
  return rows.filter(r => text(r.driver_pk ?? r.driver_coupang_id ?? r.driver_display_name ?? r.driver_name ?? r.driver_owner_name) === winner);
}

function schedulePersonKey(r) {
  if (r?.driver_pk != null) return `pk:${Number(r.driver_pk)}`;
  const id = text(r?.driver_coupang_id).toLowerCase();
  if (id) return `id:${id}`;
  const name = text(r?.driver_display_name || r?.driver_name || r?.driver_owner_name || r?.driver_export_name);
  return name ? `name:${name}` : "";
}

function scheduledPeople(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || r.route_label === "휴무자") continue;
    const key = schedulePersonKey(r);
    if (!key || map.has(key)) continue;
    map.set(key, {
      key,
      driverPk: r.driver_pk != null ? Number(r.driver_pk) : null,
      id: text(r.driver_coupang_id).toLowerCase(),
      names: uniq([r.driver_display_name, r.driver_name, r.driver_owner_name, r.driver_export_name])
    });
  }
  return [...map.values()];
}

function currentMatchesPerson(r, p) {
  if (p.driverPk != null && r?.driver_pk != null && Number(r.driver_pk) === p.driverPk) return true;
  const id = text(r?.coupang_id).toLowerCase();
  if (p.id && id === p.id) return true;
  const name = text(r?.driver_name);
  return !!name && p.names.includes(name);
}

// ============================================================================
// Batch lifecycle
// ============================================================================



function isActiveBatchDate(batch) {
  const kp = kstParts();
  const wave = text(batch?.wave).toUpperCase();
  const scheduleDate = text(batch?.schedule_date);
  if (wave === "WAVE2") return scheduleDate === kp.date;
  if (wave === "WAVE1") {
    const activeNightDate = kp.hour < 12 ? addDate(kp.date, -1) : kp.date;
    return scheduleDate === activeNightDate;
  }
  return false;
}

async function purgeStaleRealtimeRows(env){return 0;}

// A failed/unpolled batch must NOT occupy the first N slots forever.
// The DB records an attempt timestamp for failed requests. For older records,
// updated_at is the fallback so never-polled camps remain ahead of retries.
function batchLastAttemptMs(batch) {
  const last = tsMs(batch.last_polled_at);
  if (Number.isFinite(last)) return last;
  const changed = tsMs(batch.updated_at || batch.created_at || batch.started_at);
  return Number.isFinite(changed) ? changed : 0;
}
function batchLeaseActive(batch, at = Date.now()) {
  const until = tsMs(batch.collector_lock_until);
  return Number.isFinite(until) && until > at;
}
async function dueBatches(env,force=false){
  const dates=uniq(activeTargets().map(t=>t.date));
  if(!dates.length)return [];
  const filter=force?'':('&or=(next_poll_at.is.null,next_poll_at.lte.'+encodeURIComponent(nowIso())+')');
  const rows=await sbGet(env,'meta_realtime_batch?select=*&camp_code=eq.__ALL__&schedule_date=in.('+dates.join(',')+')&status=in.(collecting,completion_candidate,overdue,error)'+filter+'&order=updated_at.asc&limit=500')||[];
  return rows.filter(isActiveBatchDate).filter(b=>!batchLeaseActive(b))
    .sort((a,b)=>batchLastAttemptMs(a)-batchLastAttemptMs(b)
      ||Number(b.wave==='WAVE1')-Number(a.wave==='WAVE1')
      ||text(a.camp_name).localeCompare(text(b.camp_name),'ko'));
}

function metricsCloseReached(batch){
  if(batch.metrics_close_at)return Date.now()>=tsMs(batch.metrics_close_at);
  return Date.now()>=tsMs((batch.wave==='WAVE1'?addDate(batch.schedule_date,1):batch.schedule_date)+'T'+(batch.wave==='WAVE1'?'11:59:00':'23:59:00'));
}









async function storeFreshRows(env, batch, schedule, directory, freshResponse, collectedAt, campIndexMap) {
  if (batch.wave !== "WAVE2" || !freshResponse?.success) return [];
  const out = [];
  for (const src of metaContent(freshResponse.body)) {
    const resolved=resolveSourceCamp(src,campIndexMap,batch.camp_code==='__ALL__');
    const scopedSchedule=schedule.filter(r=>text(r.camp)===resolved.name||text(r.camp)===resolved.code);
    const w = src?.workerInfo || {};
    const metaCid = coupangId(src);
    const name = workerName(src);
    const actualRoutes = uniq((w.workSubRoutes || []).map(normRoute));
    let matched = scheduleMatch(scopedSchedule, metaCid, name);
    if (!matched.length && !metaCid && !name) matched = scheduleMatchByRoutes(scopedSchedule, actualRoutes);
    const realCid = text(matched[0]?.driver_coupang_id || metaCid) || null;
    const mappedName = text(matched[0]?.driver_display_name || matched[0]?.driver_name || matched[0]?.driver_owner_name || matched[0]?.driver_export_name || name) || null;
    const driverPk = matched[0]?.driver_pk != null
      ? Number(matched[0].driver_pk)
      : resolveDriverPk(directory, realCid, mappedName, resolved.name, batch.wave);
    const key = batch.camp_code==='__ALL__'
      ? 'camp:'+resolved.code+'|'+driverIdentity(driverPk, realCid, mappedName, workerKey(src))
      : driverIdentity(driverPk, realCid, mappedName, workerKey(src));
    const d = deliveryMetric(src?.deliverySummary || {});
    out.push({
      batch_id: batch.id,
      schedule_date: batch.schedule_date,
      meta_work_date: batch.meta_work_date,
      camp_code: resolved.code,
      camp_name: resolved.name,
      wave: batch.wave,
      meta_worker_key: key,
      coupang_id: realCid,
      driver_name: mappedName,
      driver_pk: driverPk,
      delivery_assigned: d.assigned,
      delivery_scanned: d.scanned,
      delivery_completed: d.completed,
      delivery_impossible: d.impossible,
      delivery_pdd_miss: d.pdd,
      delivery_total: d.total,
      delivery_complete_rate: d.rate,
        last_seen_at: collectedAt,
      raw_payload: src,
      updated_at: collectedAt
    });
  }
  const unique=new Map();for(const r of out){const old=unique.get(r.meta_worker_key);if(!old||r.delivery_total>=old.delivery_total)unique.set(r.meta_worker_key,r);}
  const rows=[...unique.values()];
  if(rows.length)await sbUpsert(env,'meta_realtime_fresh_current',rows,'batch_id,meta_worker_key');
  const keep=rows.map(r=>'"'+r.meta_worker_key.replaceAll('"','')+'"').join(',');
  await sbDelete(env,'meta_realtime_fresh_current?batch_id=eq.'+batch.id+(keep?'&meta_worker_key=not.in.('+encodeURIComponent(keep)+')':''));
  return rows;
}

async function processBatch(env, cookies, batch, directory) {
  await assertCollecting(env);
  const aggregate=batch.camp_code==='__ALL__';
  const codes=aggregate?uniq(batch.meta_camp_codes||[]):metaCampCandidates(batch.meta_camp_codes?.length?batch.meta_camp_codes:[batch.camp_code]);
  const mapIndex=campIndex(await loadMaster(env));
  if (!codes.length) throw new Error(`META camp code 없음: ${batch.camp_name}`);

  const main = await fetchMetaByCodeChunks(cookies, META_WORKER_URL, codes, batch.wave, batch.meta_work_date);
  if (!main.success) throw metaFailure(main,'worker collection');
  const metaRows=metaContent(main.body);
  // META often responds HTTP 200 with zero workers for an out-of-scope camp code.
  // Record this separately from a batch that has never been attempted.

  let fresh = null;
  if (batch.wave === "WAVE2") {
    fresh = await fetchMetaByCodeChunks(cookies, META_WORKER_URL, codes, batch.wave, batch.meta_work_date, "20:00");
    if(!fresh.success)throw metaFailure(fresh,"fresh collection");
  }

  const schedule = await loadSchedule(env, batch.schedule_date, batch.wave, aggregate?null:batch.camp_name);
  const prevRows = await sbGet(env, `meta_realtime_current?select=*&batch_id=eq.${batch.id}`) || [];
  const prevMap = new Map(prevRows.map(r => [rowIdentity(r), r]));
  const byKey = new Map();
  const now = nowIso();
  const expRounds = expectedRounds(batch);

  for (const src of metaRows) {
    const resolved=resolveSourceCamp(src,mapIndex,aggregate);
    const scopedSchedule=schedule.filter(r=>text(r.camp)===resolved.name||text(r.camp)===resolved.code);
    const w = src?.workerInfo || {};
    const name = workerName(src);
    const metaCid = coupangId(src);
    const actualRoutes = uniq((w.workSubRoutes || []).map(normRoute));
    let matched = scheduleMatch(scopedSchedule, metaCid, name);
    if (!matched.length && !metaCid && !name) matched = scheduleMatchByRoutes(scopedSchedule, actualRoutes);

    const scheduledRoutes = uniq(matched.map(r => normRoute(r.route_label)).filter(r => r && r !== "휴무자"));
    const realCid = text(matched[0]?.driver_coupang_id || metaCid) || null;
    const mappedName = text(
      matched[0]?.driver_display_name ||
      matched[0]?.driver_name ||
      matched[0]?.driver_owner_name ||
      matched[0]?.driver_export_name ||
      name
    ) || null;
    const driverPk = matched[0]?.driver_pk != null
      ? Number(matched[0].driver_pk)
      : resolveDriverPk(directory, realCid, mappedName, resolved.name, batch.wave);
    const key = aggregate
      ? 'camp:'+resolved.code+'|'+driverIdentity(driverPk, realCid, mappedName, workerKey(src))
      : driverIdentity(driverPk, realCid, mappedName, workerKey(src));
    const prev = prevMap.get(key);
    const accountType = text(matched[0]?.driver_account_type || w.workerAccountType || w.accountType) || null;

    const d = deliveryMetric(src?.deliverySummary || {});
    const fb = collectionMetric(src?.freshbagSummary || {}, false);
    const ret = batch.wave === "WAVE1" ? null : collectionMetric(src?.returnSummary || {}, true);

    const extraRoutes = scopedSchedule.length ? actualRoutes.filter(a => !scheduledRoutes.some(sr => scheduledRouteMatches(a, sr))) : [];
    const routeAlerts = extraRoutes.map(route => {
      const owners = scopedSchedule
        .filter(r => r.route_label && r.route_label !== "휴무자" && scheduledRouteMatches(route, r.route_label))
        .sort((a,b) => normRoute(b.route_label).length - normRoute(a.route_label).length);
      const owner = owners[0];
      if (!owner) return { route, type: "uncontracted" };
      return {
        route,
        type: "borrowed",
        owner: text(owner.driver_display_name || owner.driver_name || owner.driver_owner_name || owner.driver_coupang_id || "원주인")
      };
    });

    const progress=advanceProgress(prev,d,ret,fb,batch,now);
    const {currentRound,rounds,lastProgressAt,lastScanActivityAt,exactCandidate,workCompletedAt,
      completionMethod,completionDetectedAt,deliveryDone,returnDone,freshbagDone,totalRemaining,reopenedByScan}=progress;

    const rec = {
      batch_id: batch.id,
      schedule_date: batch.schedule_date,
      meta_work_date: batch.meta_work_date,
      camp_code: resolved.code,
      camp_name: resolved.name,
      wave: batch.wave,
      meta_worker_key: key,
      source_camp_code: resolved.sourceCode,
      driver_pk: driverPk,
      coupang_id: realCid,
      driver_name: mappedName,
      driver_account_type: accountType,
      scheduled_routes: scheduledRoutes,
      actual_routes: actualRoutes,
      extra_routes: extraRoutes,

      delivery_assigned: d.assigned,
      delivery_scanned: d.scanned,
      delivery_completed: d.completed,
      delivery_impossible: d.impossible,
      delivery_pdd_miss: d.pdd,
      delivery_total: d.total,
      delivery_complete_rate: d.rate,

      fresh_delivery_assigned: prev?.fresh_delivery_assigned || 0,
      fresh_delivery_scanned: prev?.fresh_delivery_scanned || 0,
      fresh_delivery_completed: prev?.fresh_delivery_completed || 0,
      fresh_delivery_impossible: prev?.fresh_delivery_impossible || 0,
      fresh_delivery_pdd_miss: prev?.fresh_delivery_pdd_miss || 0,
      fresh_delivery_total: prev?.fresh_delivery_total || 0,
      fresh_delivery_complete_rate: prev?.fresh_delivery_complete_rate || 0,

      return_pending: ret?.pending ?? null,
      return_collected: ret?.collected ?? null,
      return_uncollected_raw: ret?.rawUn ?? null,
      return_absent_raw: ret?.rawAbsent ?? null,
      return_uncollected: ret?.uncollected ?? null,
      return_total: ret?.total ?? null,
      return_attempt_rate: ret?.attemptRate ?? null,
      return_collection_rate: ret?.collectionRate ?? null,

      freshbag_pending: fb.pending,
      freshbag_collected: fb.collected,
      freshbag_uncollected: fb.uncollected,
      freshbag_total: fb.total,
      freshbag_attempt_rate: fb.attemptRate,
      freshbag_collection_rate: fb.collectionRate,

      current_round: currentRound,
      expected_rounds: expRounds,
      last_progress_at: lastProgressAt,
      last_scan_activity_at: lastScanActivityAt,
      exact_complete_candidate_at: exactCandidate,

      round1_scan_started_at: rounds[1].scan,
      round1_delivery_started_at: rounds[1].delivery,
      round1_completed_at: rounds[1].completed,
      round1_completion_detected_at: rounds[1].detected,
      round1_completion_method: rounds[1].method,
      round2_scan_started_at: rounds[2].scan,
      round2_delivery_started_at: rounds[2].delivery,
      round2_completed_at: rounds[2].completed,
      round2_completion_detected_at: rounds[2].detected,
      round2_completion_method: rounds[2].method,
      round3_scan_started_at: rounds[3].scan,
      round3_delivery_started_at: rounds[3].delivery,
      round3_completed_at: rounds[3].completed,
      round3_completion_detected_at: rounds[3].detected,
      round3_completion_method: rounds[3].method,
      completion_method: completionMethod,
      completion_detected_at: completionDetectedAt,
      work_completed_at: workCompletedAt,

      scan_started_at: prev?.scan_started_at || rounds[1].scan,
      delivery_started_at: prev?.delivery_started_at || rounds[1].delivery,
      delivery_completed_at: reopenedByScan ? null : (prev?.delivery_completed_at || workCompletedAt || null),
      all_completed_at: workCompletedAt,
      first_seen_at: prev?.first_seen_at || now,
      last_seen_at: now,
      delivery_done: deliveryDone,
      return_done: batch.wave === "WAVE1" ? null : returnDone,
      freshbag_done: freshbagDone,
      all_done: !!workCompletedAt,
      share: routeAlerts.length > 0,
      raw_payload: {
        main: src,
        route_alerts: routeAlerts,
        share_candidate: routeAlerts.length > 0,
        collected_at: now,
        total_remaining: totalRemaining
      },
      updated_at: now
    };

    const old = byKey.get(key);
    if (!old || rec.delivery_total > old.delivery_total) byKey.set(key, rec);
    else {
      old.actual_routes = uniq([...(old.actual_routes || []), ...actualRoutes]);
      old.extra_routes = uniq([...(old.extra_routes || []), ...extraRoutes]);
    }
  }

  const rows=[...byKey.values()];
  const unidentified=metaRows.filter(src=>workerKey(src)==='fallback:no-route');
  if(unidentified.length>1) {
    throw new Error('META_UNIDENTIFIED_WORKERS: '+unidentified.length+' raw records without stable worker identifiers; workerInfo keys='+
      Object.keys(unidentified[0]?.workerInfo||{}).slice(0,10).join(','));
  }
  const resolvedCampCount=new Set(rows.filter(r=>r.camp_code!=='META_UNMAPPED').map(r=>r.camp_code)).size;
  const unmappedCount=rows.filter(r=>r.camp_code==='META_UNMAPPED').length;
  const emptyWarning=!metaRows.length
    ? 'META_EMPTY_WORKERS: META returned 0 worker rows; check camp codes ('+codes.slice(0,6).join(',')+') and META workDate '+batch.meta_work_date
    : null;
  await assertCollecting(env);
  const freshRows=await storeFreshRows(env,batch,schedule,directory,fresh,now,mapIndex);
  const freshMap=new Map(freshRows.map(r=>[r.meta_worker_key,r]));
  if(batch.wave==='WAVE2'&&fresh?.success){
    for(const r of rows){const fr=freshMap.get(r.meta_worker_key);for(const field of ['assigned','scanned','completed','impossible','pdd_miss','total','complete_rate'])r['fresh_delivery_'+field]=fr?.['delivery_'+field]??0;}
  }
  if(rows.length)await sbUpsert(env,'meta_realtime_current',rows,'batch_id,meta_worker_key');
  if(rows.length){
    const minute = sampleMinute(now);
    const historyRows = rows.map(r => {
      const fr = freshMap.get(r.meta_worker_key);
      const deliveryRemaining = Math.max(0, Number(r.delivery_scanned || 0));
      const totalRemaining = deliveryRemaining
        + (batch.wave === "WAVE1" ? 0 : Math.max(0, Number(r.return_pending || 0)))
        + Math.max(0, Number(r.freshbag_pending || 0));
      return {
        batch_id: r.batch_id,
        sampled_at: now,
        sample_minute: minute,
        schedule_date: r.schedule_date,
        meta_work_date: r.meta_work_date,
        camp_code: r.camp_code,
        camp_name: r.camp_name,
        wave: r.wave,
        meta_worker_key: r.meta_worker_key,
        driver_pk: r.driver_pk,
        coupang_id: r.coupang_id,
        driver_name: r.driver_name,
        current_round: r.current_round,
        expected_rounds: r.expected_rounds,
        delivery_assigned: r.delivery_assigned,
        delivery_scanned: r.delivery_scanned,
        delivery_completed: r.delivery_completed,
        delivery_impossible: r.delivery_impossible,
        delivery_pdd_miss: r.delivery_pdd_miss,
        delivery_total: r.delivery_total,
        delivery_complete_rate: r.delivery_complete_rate,
        fresh_delivery_assigned: fr?.delivery_assigned ?? 0,
        fresh_delivery_scanned: fr?.delivery_scanned ?? 0,
        fresh_delivery_completed: fr?.delivery_completed ?? 0,
        fresh_delivery_impossible: fr?.delivery_impossible ?? 0,
        fresh_delivery_pdd_miss: fr?.delivery_pdd_miss ?? 0,
        fresh_delivery_total: fr?.delivery_total ?? 0,
        fresh_delivery_complete_rate: fr?.delivery_complete_rate ?? 0,
        return_pending: r.return_pending,
        return_collected: r.return_collected,
        return_uncollected: Math.max(Number(r.return_uncollected_raw || 0), Number(r.return_absent_raw || 0)),
        return_total: r.return_total,
        freshbag_pending: r.freshbag_pending,
        freshbag_collected: r.freshbag_collected,
        freshbag_uncollected: r.freshbag_uncollected,
        freshbag_total: r.freshbag_total,
        delivery_remaining: deliveryRemaining,
        total_remaining: totalRemaining,
        actual_routes: r.actual_routes
      };
    });
    await sbUpsert(env, "meta_realtime_history", historyRows, "batch_id,meta_worker_key,sample_minute");
  }

  const stateRows = await sbGet(env,
    `meta_realtime_current?select=meta_worker_key,driver_pk,coupang_id,driver_name,work_completed_at,completion_method&batch_id=eq.${batch.id}`
  ) || [];
  const expected = aggregate ? [] : scheduledPeople(schedule);
  const matched = expected.length
    ? expected.map(p => stateRows.find(r => currentMatchesPerson(r,p))).filter(Boolean)
    : stateRows;

  const complete = matched.length > 0
    && (expected.length === 0 || matched.length === expected.length)
    && matched.every(r => !!r.work_completed_at);
  const completedCount = expected.length
    ? expected.filter(p => !!stateRows.find(r => currentMatchesPerson(r,p) && r.work_completed_at)).length
    : stateRows.filter(r => !!r.work_completed_at).length;
  const newlyCompletedAt = complete
    ? matched.map(r => r.work_completed_at).filter(Boolean).sort().at(-1)
    : null;
  const campWorkCompletedAt = complete ? (newlyCompletedAt || batch.work_completed_at || null) : null;
  const campComplete = complete && !!campWorkCompletedAt;
  const stable = campComplete ? Number(batch.stable_complete_poll_count || 0) + 1 : 0;
  const inferred = matched.some(r => r.completion_method === "stale_tail_30m");
  const batchMethod = campComplete ? (inferred ? "stale_tail_30m" : (batch.completion_method || "exact_2poll")) : null;
  const shouldFinalize = campComplete && metricsCloseReached(batch);

  await sbPatch(env, `meta_realtime_batch?id=eq.${batch.id}`, {
    meta_camp_codes: codes,
    last_polled_at: now,
    worker_count: stateRows.length,
    completed_worker_count: completedCount,
    stable_complete_poll_count: stable,
    status: campComplete ? "completion_candidate" : "collecting",
    work_completed_at: campWorkCompletedAt,
    metrics_status: "collecting",
    completion_method: campComplete ? (batch.completion_method || batchMethod) : null,
    completion_detected_at: campComplete ? (batch.completion_detected_at || now) : null,
    completion_candidate_at: campComplete ? (batch.completion_candidate_at || now) : null,
    poll_interval_seconds: 60,
    next_poll_at: now,
    last_error: emptyWarning,
    updated_at: now
  });

  if (shouldFinalize) {
    const finalized = await sbPost(env, "rpc/meta_finalize_realtime_batch", { p_batch_id: batch.id });


    return {
      camp: batch.camp_name,
      wave: batch.wave,
      workers: rows.length,
      meta_rows: metaRows.length,
      finalized,
      codes,
      completion_method: batchMethod
    };
  }

  return {
    camp: batch.camp_name,
    wave: batch.wave,
    workers: stateRows.length,
    meta_rows: metaRows.length,
    complete: campComplete,
    stable,
    codes,
    warning: emptyWarning, resolved_camps:resolvedCampCount, unmapped_workers:unmappedCount, contracted_codes:codes.length
  };
}

async function heartbeat(env, cookies) {
  const codes = await verificationCampCodes(env);
  if (!codes.length) return { ok: false, skipped: "no_verification_camp_code" };
  const kp = kstParts();
  const response = await metaPost(cookies, META_CAMP_URL, workerPayload(codes, "WAVE2", kp.date));
  await saveSession(
    env,
    cookies,
    response.success ? "active" : (response.status===401 || response.status===403 ? "expired" : "error"),
    response.status,
    response.success ? null : `heartbeat ${response.status}: ${response.raw.slice(0, 200)}`
  );
  return { ok: response.success, status: response.status };
}



// ============================================================================
// Keycloak + SMS MFA login
// ============================================================================

function decodeHtml(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(s = "") {
  return decodeHtml(s)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attrs(tag) {
  const obj = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(tag))) obj[m[1].toLowerCase()] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? "");
  return obj;
}

function parseForms(markup, baseUrl) {
  const forms = [];
  const fre = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = fre.exec(markup))) {
    const fa = attrs(fm[1]);
    const inputs = [];
    const ire = /<input\b([^>]*)>/gi;
    let im;
    while ((im = ire.exec(fm[2]))) inputs.push(attrs(im[1]));
    let action = fa.action || baseUrl;
    try { action = new URL(action, baseUrl).toString(); } catch {}
    forms.push({ method: (fa.method || "GET").toUpperCase(), action, inputs });
  }
  return forms;
}

function chooseLoginForm(forms) {
  return forms.find(f => f.inputs.some(i => (i.type || "").toLowerCase() === "password")) || null;
}

function chooseMfaTypeForm(forms) {
  return forms.find(f => f.inputs.some(i => (i.name || "").toLowerCase() === "mfatype")) || null;
}

function chooseOtpForm(forms) {
  return forms.find(f => f.inputs.some(i => (i.name || "").toLowerCase() === "code")) || null;
}

function loginFormBody(form, id, pw) {
  const p = new URLSearchParams();
  const inputs = form?.inputs || [];
  const username = inputs.find(i => (i.name || "").toLowerCase() === "username");
  const password = inputs.find(i => (i.name || "").toLowerCase() === "password");
  const credentialId = inputs.find(i => (i.name || "").toLowerCase() === "credentialid");
  p.set(username?.name || "username", id);
  p.set(password?.name || "password", pw);
  p.set(credentialId?.name || "credentialId", credentialId?.value || "");
  return p;
}

function mfaTypeBody(form) {
  const p = new URLSearchParams();
  let selected = null;
  for (const i of form?.inputs || []) {
    if (!i.name) continue;
    const type = (i.type || "text").toLowerCase();
    if ((i.name || "").toLowerCase() === "mfatype") {
      selected = i.value || "";
      p.set(i.name, selected);
    } else if (type === "hidden") {
      p.set(i.name, i.value || "");
    }
  }
  return { body: p, selected };
}

function otpBody(code) {
  const p = new URLSearchParams();
  p.set("code", code);
  p.set("realActionType", "Submit");
  return p;
}

class CookieJar {
  constructor(items = []) {
    this.items = new Map();
    for (const c of items) if (c?.name && c?.domain) this.items.set(this.key(c), { ...c });
  }
  key(c) { return `${c.domain}|${c.path || "/"}|${c.name}`; }
  dump() { return [...this.items.values()].map(c => ({ ...c })); }
  absorb(response, requestUrl) {
    const u = new URL(requestUrl);
    let lines = [];
    if (typeof response.headers.getSetCookie === "function") lines = response.headers.getSetCookie();
    else {
      const raw = response.headers.get("set-cookie");
      if (raw) lines = splitSetCookie(raw);
    }
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split(";").map(x => x.trim());
      const eq = parts[0].indexOf("=");
      if (eq <= 0) continue;
      const c = {
        name: parts[0].slice(0, eq),
        value: parts[0].slice(eq + 1),
        domain: u.hostname.toLowerCase(),
        path: "/",
        hostOnly: true,
        secure: false
      };
      let expired = false;
      for (const part of parts.slice(1)) {
        const j = part.indexOf("=");
        const k = (j >= 0 ? part.slice(0, j) : part).trim().toLowerCase();
        const v = j >= 0 ? part.slice(j + 1).trim() : "";
        if (k === "domain" && v) { c.domain = v.replace(/^\./, "").toLowerCase(); c.hostOnly = false; }
        else if (k === "path" && v) c.path = v;
        else if (k === "secure") c.secure = true;
        else if (k === "max-age" && Number(v) <= 0) expired = true;
        else if (k === "expires") {
          const t = Date.parse(v);
          if (Number.isFinite(t) && t <= Date.now()) expired = true;
        }
      }
      const key = this.key(c);
      if (expired || c.value === "") this.items.delete(key); else this.items.set(key, c);
    }
  }
  header(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname || "/";
    const matched = [];
    for (const c of this.items.values()) {
      const domainOk = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith(`.${c.domain}`));
      const pathOk = path.startsWith(c.path || "/");
      const secureOk = !c.secure || u.protocol === "https:";
      if (domainOk && pathOk && secureOk) matched.push(c);
    }
    matched.sort((a, b) => (b.path || "/").length - (a.path || "/").length);
    return matched.map(c => `${c.name}=${c.value}`).join("; ");
  }
  namesFor(url) {
    const h = this.header(url);
    return h ? h.split(/;\s*/).map(x => x.split("=")[0]).filter(Boolean) : [];
  }
}

async function requestWithJar(jar, url, init = {}) {
  const headers = new Headers(init.headers || {});
  const cookie = jar.header(url);
  if (cookie) headers.set("cookie", cookie);
  headers.set("user-agent", UA);
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.absorb(response, url);
  return response;
}

function browserNavHeaders(fromUrl, toUrl, method = "GET") {
  const h = new Headers();
  h.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  h.set("accept-language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
  h.set("cache-control", "max-age=0");
  h.set("upgrade-insecure-requests", "1");
  h.set("sec-fetch-dest", "document");
  h.set("sec-fetch-mode", "navigate");
  h.set("sec-fetch-user", "?1");
  if (fromUrl) {
    h.set("referer", fromUrl);
    try {
      const a = new URL(fromUrl), b = new URL(toUrl);
      if (a.origin === b.origin) h.set("sec-fetch-site", "same-origin");
      else if (a.hostname.endsWith(".coupang.com") && b.hostname.endsWith(".coupang.com")) h.set("sec-fetch-site", "same-site");
      else h.set("sec-fetch-site", "cross-site");
    } catch { h.set("sec-fetch-site", "none"); }
  } else h.set("sec-fetch-site", "none");
  if (method !== "GET" && method !== "HEAD") {
    try { h.set("origin", new URL(toUrl).origin); } catch {}
  }
  return h;
}

async function followBrowserTrace(jar, url, init = {}, max = 15) {
  let current = url;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  let previous = init.referer || init.headers?.referer || null;
  let extra = new Headers(init.headers || {});
  const hops = [];

  for (let i = 0; i < max; i++) {
    const headers = browserNavHeaders(previous, current, method);
    for (const [k, v] of extra.entries()) headers.set(k, v);
    const response = await requestWithJar(jar, current, { method, body, headers });
    const location = response.headers.get("location");
    hops.push({ status: response.status, url: current, location: location || null });
    if (![301,302,303,307,308].includes(response.status) || !location) {
      return { response, url: current, hops, body: await response.text() };
    }
    const next = new URL(location, current).toString();
    previous = current;
    if ([301,302,303].includes(response.status) && method !== "GET" && method !== "HEAD") {
      method = "GET";
      body = undefined;
      extra = new Headers();
    }
    current = next;
  }
  throw new Error("redirect limit exceeded");
}

async function credentialSubmit(env, jar) {
  if (!text(env.META_ID) || !text(env.META_PW)) throw new Error("META_ID 또는 META_PW 없음");
  const first = await followBrowserTrace(jar, AUTH_START, {});
  const loginForm = chooseLoginForm(parseForms(first.body, first.url));
  if (!loginForm) throw new Error(`META login form 찾기 실패: ${stripHtml(first.body).slice(0,300)}`);
  const form = loginFormBody(loginForm, env.META_ID, env.META_PW);
  return await followBrowserTrace(jar, loginForm.action, {
    method: loginForm.method === "GET" ? "GET" : "POST",
    referer: first.url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: loginForm.method === "GET" ? undefined : form.toString()
  });
}

async function sendMfaCode(env) {
  const jar = new CookieJar();
  const cred = await credentialSubmit(env, jar);
  const mfaForm = chooseMfaTypeForm(parseForms(cred.body, cred.url));
  if (!mfaForm) throw new Error(`MFA 선택 form 찾기 실패: ${stripHtml(cred.body).slice(0,400)}`);
  const choice = mfaTypeBody(mfaForm);
  const next = await followBrowserTrace(jar, mfaForm.action, {
    method: mfaForm.method === "GET" ? "GET" : "POST",
    referer: cred.url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: mfaForm.method === "GET" ? undefined : choice.body.toString()
  });
  const otpForm = chooseOtpForm(parseForms(next.body, next.url));
  if (!otpForm) throw new Error(`OTP form 찾기 실패: ${stripHtml(next.body).slice(0,400)}`);
  return { jar, otpForm, referer: next.url, selected: choice.selected };
}

function bytesToB64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64UrlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function stateCryptoKey(env) {
  const key = serviceKey(env);
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY 없음");
  const seed = new TextEncoder().encode(`tonest-meta-mfa-state-v1:${key}`);
  const digest = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt","decrypt"]);
}

async function sealState(env, obj) {
  const key = await stateCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `${bytesToB64Url(iv)}.${bytesToB64Url(enc)}`;
}

async function openState(env, token) {
  const [a,b] = String(token || "").split(".");
  if (!a || !b) throw new Error("MFA state token 형식 오류");
  const key = await stateCryptoKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64UrlToBytes(a) }, key, b64UrlToBytes(b));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function queryMetaWithJar(env, jar) {
  const codes = await verificationCampCodes(env);
  if (!codes.length) throw new Error("META 로그인 검증용 camp code를 찾지 못했습니다.");
  const kp = kstParts();
  const wave = kp.hour < 12 ? "WAVE1" : "WAVE2";
  const workDate = wave === "WAVE1" && kp.hour < 12 ? kp.date : kp.date;
  const cookies = parseCookieBundle(jar.header(FLY_REALTIME));
  return await metaPost(cookies, META_CAMP_URL, workerPayload(codes, wave, workDate));
}

function otpPage(masked, token) {
  return html(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TO:NEST META 인증</title>
<style>
body{margin:0;padding:26px 16px;background:#f3f8f7;color:#172124;font-family:"Pretendard","Noto Sans KR",Arial,sans-serif}
.card{max-width:520px;margin:auto;background:#fff;border:1px solid #dce7e5;border-radius:18px;padding:24px;box-shadow:0 14px 36px rgba(15,45,47,.10)}
h1{font-size:20px;margin:0 0 10px}.sub{font-size:13px;color:#596d6a;line-height:1.55;margin-bottom:18px}
input{width:100%;box-sizing:border-box;border:1px solid #cbd8d6;border-radius:12px;padding:14px;font-size:25px;text-align:center;letter-spacing:8px}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:12px;background:#16a7a4;color:#fff;font-size:14px;font-weight:800;cursor:pointer}
.note{margin-top:13px;color:#66787a;font-size:11px;line-height:1.55}
</style></head><body><div class="card">
<h1>META 문자 인증</h1>
<div class="sub">${esc(masked || "등록된 휴대폰")}으로 인증번호를 발송했습니다.<br>가장 최근에 받은 6자리 번호를 입력하세요.</div>
<form method="post" action="/login-submit-code" autocomplete="off">
<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000">
<input type="hidden" name="state" value="${esc(token)}">
<button type="submit">인증하고 세션 저장</button>
</form><div class="note">이 화면을 새로고침하면 새 인증 흐름이 필요할 수 있습니다.</div>
</div></body></html>`);
}

async function loginSendCode(env) {
  requireConfig(env);
  const mfa = await sendMfaCode(env);
  const token = await sealState(env, {
    v: 1,
    createdAt: Date.now(),
    cookies: mfa.jar.dump(),
    otpForm: mfa.otpForm,
    referer: mfa.referer
  });
  return otpPage(mfa.selected, token);
}

async function loginSubmitCode(request, env) {
  const fd = await request.formData();
  const code = text(fd.get("code"));
  const token = text(fd.get("state"));
  if (!/^\d{6}$/.test(code)) return html("<h2>인증번호는 숫자 6자리입니다.</h2>", 400);

  let state;
  try { state = await openState(env, token); }
  catch (e) { return html(`<h2>MFA 상태 복원 실패</h2><pre>${esc(e.message)}</pre>`, 400); }
  if (!state.createdAt || Date.now() - state.createdAt > 10 * 60 * 1000) {
    return html("<h2>인증 세션이 만료되었습니다.</h2><p><a href='/login-send-code'>새 인증번호 받기</a></p>", 410);
  }

  const jar = new CookieJar(state.cookies || []);
  const form = state.otpForm;
  if (!form?.action) throw new Error("저장된 OTP form 없음");

  const verify = await followBrowserTrace(jar, form.action, {
    method: form.method === "GET" ? "GET" : "POST",
    referer: state.referer || form.action,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.method === "GET" ? undefined : otpBody(code).toString()
  });

  const meta = await queryMetaWithJar(env, jar);
  if (!meta.success) {
    return html(`<!doctype html><html lang="ko"><meta charset="utf-8"><body style="font-family:Arial;padding:28px">
<h2>META 인증은 완료되지 않았습니다.</h2>
<p>최종 인증 URL: <code>${esc(verify.url)}</code></p>
<p>META HTTP: <b>${meta.status}</b></p>
<pre style="white-space:pre-wrap">${esc(meta.raw.slice(0,1000))}</pre>
<p><a href="/login-send-code">새 코드로 다시 시도</a></p>
</body></html>`, 422);
  }

  // Authenticated login owns the fresh cookie jar and replaces stale state.
  await saveSession(env, jar, "active", 200, null);

  return html(`<!doctype html><html lang="ko"><meta charset="utf-8"><body style="font-family:Arial;background:#f3f8f7;padding:28px">
<div style="max-width:600px;margin:auto;background:#fff;padding:24px;border-radius:18px;border:1px solid #dce7e5">
<h1 style="margin-top:0">META 인증 성공</h1>
<p>TO:NEST DB의 <b>meta_backend_state</b>에 새 FLY 세션을 저장했습니다.</p>
<p>저장된 쿠키: ${esc(jar.namesFor(FLY_REALTIME).join(", "))}</p>
<p>이 창을 닫고 실시간 현황을 새로고침하면 됩니다.</p>
</div></body></html>`);
}

async function testDb(env) {
  const state = await sessionState(env);
  if (!state?.cookie_bundle) return json({ ok:false, stage:"db-cookie", error:"DB cookie_bundle 비어 있음" }, 422);
  const cookies = parseCookieBundle(state.cookie_bundle);
  const codes = await verificationCampCodes(env);
  if (!codes.length) return json({ ok:false, error:"검증용 camp code 없음" }, 422);
  const kp = kstParts();
  const response = await metaPost(cookies, META_CAMP_URL, workerPayload(codes, "WAVE2", kp.date));
  await saveSession(
    env,
    cookies,
    response.success ? "active" : ([401,403,302,303,307,308].includes(response.status) ? "expired" : "error"),
    response.status,
    response.success ? null : `DB cookie META ${response.status}: ${response.raw.slice(0,250)}`
  );
  return json({
    ok: response.success,
    stage: "db-cookie-meta-query",
    dbStatus: state.status,
    metaHttpStatus: response.status,
    metaMessage: response.body?.message || null,
    campCodeCount: codes.length,
    preview: response.success ? null : response.raw.slice(0,500)
  }, response.success ? 200 : 422);
}

// ============================================================================
// Worker entry
// ============================================================================

// TO:NEST night work has three rounds. Offset-free database times are KST.
const expectedRounds = b => String(b?.wave || '').toUpperCase() === 'WAVE1' ? 3 : 2;
const progressNumber = v => Math.max(0, Number(v) || 0);
function progressRoundFields(prev, round) {
  return {scan:prev?.[`round${round}_scan_started_at`] || (round===1?prev?.scan_started_at:null) || null,
    delivery:prev?.[`round${round}_delivery_started_at`] || (round===1?prev?.delivery_started_at:null) || null,
    completed:prev?.[`round${round}_completed_at`] || null,
    detected:prev?.[`round${round}_completion_detected_at`] || null,
    method:prev?.[`round${round}_completion_method`] || null};
}
function advanceProgress(prev, d, ret, fb, batch, now) {
  const n=progressNumber, expRounds=expectedRounds(batch), night=batch.wave==='WAVE1';
  const pairs=[[prev?.delivery_assigned,d.assigned],[prev?.delivery_scanned,d.scanned],
    [prev?.delivery_completed,d.completed],[prev?.delivery_impossible,d.impossible],
    [prev?.delivery_pdd_miss,d.pdd],[prev?.delivery_total,d.total],[prev?.freshbag_pending,fb.pending],
    [prev?.freshbag_collected,fb.collected],[prev?.freshbag_uncollected,fb.uncollected]];
  if(!night)pairs.push([prev?.return_pending,ret?.pending],[prev?.return_collected,ret?.collected],
    [prev?.return_uncollected_raw,ret?.rawUn],[prev?.return_absent_raw,ret?.rawAbsent]);
  const changed=!prev||pairs.some(([a,b])=>n(a)!==n(b));
  // Assignments, cancellations and PDD misses do not establish actual scans/deliveries.
  const scanMoved=prev?n(d.scanned)>n(prev.delivery_scanned)
    ||(n(d.total)>n(prev.delivery_total)&&n(d.scanned)>0):n(d.scanned)>0||n(d.completed)>0;
  const deliveryMoved=n(d.completed)>n(prev?.delivery_completed);
  let currentRound=Math.max(1,Math.min(expRounds,n(prev?.current_round)||1));
  const rounds={1:progressRoundFields(prev,1),2:progressRoundFields(prev,2),3:progressRoundFields(prev,3)};
  let lastProgressAt=changed?now:(prev?.last_progress_at||now);
  let lastScanActivityAt=scanMoved?now:(prev?.last_scan_activity_at||null);
  if(!rounds[1].scan&&(n(d.scanned)>0||n(d.completed)>0))rounds[1].scan=now;
  let advanced=false;
  if(rounds[currentRound].completed&&scanMoved&&currentRound<expRounds){
    currentRound++;advanced=true;rounds[currentRound].scan||=now;lastProgressAt=now;lastScanActivityAt=now;
  }
  if(deliveryMoved)rounds[currentRound].delivery||=now;
  const deliveryDone=n(d.total)>0&&n(d.scanned)===0;
  const returnDone=night||n(ret?.pending)===0, freshbagDone=n(fb.pending)===0;
  const deliveryRemaining=n(d.scanned),returnRemaining=night?0:n(ret?.pending),freshbagRemaining=n(fb.pending);
  const totalRemaining=deliveryRemaining+returnRemaining+freshbagRemaining;
  const idleMinutes=Math.max(0,(tsMs(now)-tsMs(lastProgressAt))/60000)||0;
  const invalidOldCompletion=!!prev?.work_completed_at&&(currentRound<expRounds||!rounds[currentRound].delivery);
  const pendingIncreased=n(d.scanned)>n(prev?.delivery_scanned)||n(fb.pending)>n(prev?.freshbag_pending)
    ||(!night&&n(ret?.pending)>n(prev?.return_pending));
  const reopened=!!prev?.work_completed_at&&(scanMoved||pendingIncreased||invalidOldCompletion);
  if(rounds[currentRound].completed&&(scanMoved||pendingIncreased)&&!advanced){
    rounds[currentRound].completed=null;rounds[currentRound].detected=null;rounds[currentRound].method=null;
  }
  const roundHasDelivery=!!rounds[currentRound].delivery;
  const candidate=deliveryDone&&returnDone&&freshbagDone&&roundHasDelivery&&!advanced&&!scanMoved&&!pendingIncreased;
  const exactCandidate=candidate?(prev?.exact_complete_candidate_at||now):null;
  const previousPollMs=tsMs(prev?.last_seen_at);
  const exactConfirmed=candidate&&!!prev?.exact_complete_candidate_at
    &&tsMs(prev.exact_complete_candidate_at)>=tsMs(rounds[currentRound].delivery)
    &&Number.isFinite(previousPollMs)&&tsMs(now)>previousPollMs;
  if(currentRound<expRounds&&roundHasDelivery&&!rounds[currentRound].completed&&(exactConfirmed||idleMinutes>=30)){
    rounds[currentRound].completed=exactConfirmed?prev.exact_complete_candidate_at:kstIsoAt(tsMs(lastProgressAt)+60000);
    rounds[currentRound].detected=now;rounds[currentRound].method=exactConfirmed?'round_exact_2poll':'idle_30m';
  }
  const finalRoundReady=currentRound>=expRounds&&roundHasDelivery;
  const staleTailConfirmed=finalRoundReady&&deliveryRemaining<=2&&returnRemaining<=2&&freshbagRemaining<=2&&idleMinutes>=30;
  let workCompletedAt=reopened?null:(prev?.work_completed_at||null);
  let completionMethod=reopened?null:(prev?.completion_method||null);
  let completionDetectedAt=reopened?null:(prev?.completion_detected_at||null);
  if(!reopened&&!workCompletedAt&&finalRoundReady&&(exactConfirmed||staleTailConfirmed)){
    workCompletedAt=exactConfirmed?prev.exact_complete_candidate_at:kstIsoAt(tsMs(lastProgressAt)+60000);
    completionMethod=exactConfirmed?'exact_2poll':'stale_tail_30m';completionDetectedAt=now;
  }
  if(workCompletedAt){rounds[currentRound].completed||=workCompletedAt;rounds[currentRound].detected||=completionDetectedAt;rounds[currentRound].method||=completionMethod;}
  return {expRounds,currentRound,rounds,lastProgressAt,lastScanActivityAt,exactCandidate,workCompletedAt,
    completionMethod,completionDetectedAt,deliveryDone,returnDone,freshbagDone,totalRemaining,reopenedByScan:reopened};
}

const BUILD_VERSION='2026-10-13-cookie-jar-cas-v8';
const schemaResults=new Map();
const masterResults=new Map();
const singleFlights=new Map();
const discoveryResults=new Map();
const recentDiscoveries=new Set();
const optionalWarnings=new Map();
// Minimal data contract, not a replacement for an administrator's SQL/RLS audit.
const REQUIRED_COLUMNS={"meta_backend_state": ["id", "cookie_bundle", "status", "updated_at", "last_success_at", "last_http_status", "last_error", "collector_paused", "collector_paused_at", "collector_paused_by"], "meta_realtime_batch": ["id", "schedule_date", "meta_work_date", "camp_code", "camp_name", "wave", "status", "collect_from", "collect_until", "started_at", "last_polled_at", "completion_candidate_at", "finalized_at", "worker_count", "completed_worker_count", "stable_complete_poll_count", "poll_interval_seconds", "next_poll_at", "last_error", "created_at", "updated_at", "meta_camp_codes", "fresh_miss", "dawn_miss", "expected_rounds", "completion_method", "completion_detected_at", "collector_lock_token", "collector_lock_until", "work_completed_at", "metrics_status", "metrics_closed_at", "visible_until", "metrics_close_at"], "meta_realtime_current": ["id", "batch_id", "schedule_date", "meta_work_date", "camp_code", "camp_name", "wave", "coupang_id", "driver_name", "driver_account_type", "scheduled_routes", "actual_routes", "extra_routes", "delivery_assigned", "delivery_scanned", "delivery_completed", "delivery_impossible", "delivery_pdd_miss", "delivery_total", "delivery_complete_rate", "return_pending", "return_collected", "return_uncollected_raw", "return_absent_raw", "return_uncollected", "return_total", "return_attempt_rate", "return_collection_rate", "freshbag_pending", "freshbag_collected", "freshbag_uncollected", "freshbag_total", "freshbag_attempt_rate", "freshbag_collection_rate", "scan_started_at", "delivery_started_at", "delivery_completed_at", "all_completed_at", "first_seen_at", "last_seen_at", "delivery_done", "return_done", "freshbag_done", "raw_payload", "created_at", "updated_at", "fresh_delivery_assigned", "fresh_delivery_scanned", "fresh_delivery_completed", "fresh_delivery_impossible", "fresh_delivery_pdd_miss", "fresh_delivery_total", "fresh_delivery_complete_rate", "meta_worker_key", "source_camp_code", "all_done", "share", "fresh_miss", "dawn_miss", "driver_pk", "current_round", "expected_rounds", "last_progress_at", "last_scan_activity_at", "exact_complete_candidate_at", "round1_scan_started_at", "round1_delivery_started_at", "round1_completed_at", "round1_completion_detected_at", "round1_completion_method", "round2_scan_started_at", "round2_delivery_started_at", "round2_completed_at", "round2_completion_detected_at", "round2_completion_method", "round3_scan_started_at", "round3_delivery_started_at", "round3_completed_at", "round3_completion_detected_at", "round3_completion_method", "completion_method", "completion_detected_at", "work_completed_at"], "meta_realtime_fresh_current": ["id", "batch_id", "schedule_date", "meta_work_date", "camp_code", "camp_name", "wave", "meta_worker_key", "coupang_id", "driver_name", "delivery_assigned", "delivery_scanned", "delivery_completed", "delivery_impossible", "delivery_pdd_miss", "delivery_total", "delivery_complete_rate", "first_seen_at", "last_seen_at", "raw_payload", "created_at", "updated_at", "fresh_miss", "driver_pk"], "meta_realtime_history": ["id", "batch_id", "sampled_at", "sample_minute", "schedule_date", "meta_work_date", "camp_code", "camp_name", "wave", "meta_worker_key", "driver_pk", "coupang_id", "driver_name", "current_round", "expected_rounds", "delivery_assigned", "delivery_scanned", "delivery_completed", "delivery_impossible", "delivery_pdd_miss", "delivery_total", "delivery_complete_rate", "fresh_delivery_assigned", "fresh_delivery_scanned", "fresh_delivery_completed", "fresh_delivery_impossible", "fresh_delivery_pdd_miss", "fresh_delivery_total", "fresh_delivery_complete_rate", "return_pending", "return_collected", "return_uncollected", "return_total", "freshbag_pending", "freshbag_collected", "freshbag_uncollected", "freshbag_total", "delivery_remaining", "total_remaining", "actual_routes", "created_at"], "meta_realtime_final": ["id", "batch_id", "schedule_date", "meta_work_date", "camp_code", "camp_name", "wave", "coupang_id", "driver_name", "driver_account_type", "scheduled_routes", "actual_routes", "extra_routes", "delivery_assigned", "delivery_scanned", "delivery_completed", "delivery_impossible", "delivery_pdd_miss", "delivery_total", "delivery_complete_rate", "return_pending", "return_collected", "return_uncollected_raw", "return_absent_raw", "return_uncollected", "return_total", "return_attempt_rate", "return_collection_rate", "freshbag_pending", "freshbag_collected", "freshbag_uncollected", "freshbag_total", "freshbag_attempt_rate", "freshbag_collection_rate", "scan_started_at", "delivery_started_at", "delivery_completed_at", "all_completed_at", "first_seen_at", "last_seen_at", "delivery_done", "return_done", "freshbag_done", "raw_payload", "finalized_at", "created_at", "updated_at", "fresh_delivery_assigned", "fresh_delivery_scanned", "fresh_delivery_completed", "fresh_delivery_impossible", "fresh_delivery_pdd_miss", "fresh_delivery_total", "fresh_delivery_complete_rate", "meta_worker_key", "source_camp_code", "all_done", "share", "fresh_miss", "dawn_miss", "driver_pk", "actual_rounds", "expected_rounds", "round1_scan_started_at", "round1_delivery_started_at", "round1_completed_at", "round1_completion_detected_at", "round1_completion_method", "round2_scan_started_at", "round2_delivery_started_at", "round2_completed_at", "round2_completion_detected_at", "round2_completion_method", "round3_scan_started_at", "round3_delivery_started_at", "round3_completed_at", "round3_completion_detected_at", "round3_completion_method", "completion_method", "completion_detected_at", "work_completed_at"]};
function schemaIssue(error,table){return {table,code:error.code||'',status:error.status||500,message:String(error.message||error).slice(0,500)};}
async function inspectSchema(env,force=false){
  const key=supabaseUrl(env),cached=schemaResults.get(key);
  if(!force&&cached&&Date.now()<cached.expires)return cached.value;
  const issues=[];
  for(const [table,columns] of Object.entries(REQUIRED_COLUMNS)){
    try{await sbGet(env,table+'?select='+columns.join(',')+'&limit=0');}
    catch(e){issues.push(schemaIssue(e,table));}
  }
  const value={ready:issues.length===0,check:'required_columns_readable',checked_at:new Date().toISOString(),issues};
  schemaResults.set(key,{value,expires:Date.now()+(value.ready?120000:10000)});
  return value;
}
function optionalSchemaError(e){return ['42P01','42703','PGRST204','PGRST205'].includes(e?.code);}
async function optionalGet(env,path){
  const table=path.split('?')[0];
  try{const result=await sbGet(env,path);optionalWarnings.delete(table);return result||[];}
  catch(e){if(!optionalSchemaError(e))throw e;optionalWarnings.set(table,schemaIssue(e,table));return [];}
}
async function loadMaster(env){
  const key=supabaseUrl(env),cached=masterResults.get(key);
  if(cached&&Date.now()<cached.expires)return cached.rows;
  const rows=await getMaroCampRows(env,'');
  if(!Array.isArray(rows)||!rows.length)throw new Error('CAMP_DIRECTORY_EMPTY: check CAMP_DIRECTORY binding / MAROOWELL_API_KEY');
  masterResults.set(key,{rows,expires:Date.now()+300000});return rows;
}
function activeTargets(now=new Date()){
  const kp=kstParts(now),out=[];
  if(kp.hour>=20)out.push({date:kp.date,wave:'WAVE1'});
  else if(kp.hour<12)out.push({date:addDate(kp.date,-1),wave:'WAVE1'});
  if(kp.hour>=7)out.push({date:kp.date,wave:'WAVE2'});
  return out;
}
function campIdentity(row){
  const info=row?.campInfo||row?.campSummary||{};
  const campObj=typeof row?.camp==='object'?row.camp:{};
  const code=text(row?.campCode||info.campCode||campObj.code||campObj.campCode||row?.code||row?.sourceCampCode).toUpperCase();
  const name=text(row?.campName||info.campName||campObj.name||campObj.campName||(typeof row?.camp==='string'?row.camp:''));
  return {code,name};
}
function campIndex(rows){
  const byCode=new Map(),byName=new Map();
  for(const row of rows){
    const name=text(row.camp||row.camp_name||row.campName),code=text(row.code||row.campCode).toUpperCase();
    if(!code)continue;
    const key=name||code;
    if(!byName.has(key))byName.set(key,{name:key,code:null,codes:[]});
    const group=byName.get(key);group.codes=uniq([...group.codes,...metaCampCandidates([code])]);
    if(!group.code||text(row.mb_camp)==='\ubcf8\ucea0\ud504')group.code=code;
    for(const alias of metaCampCandidates([code]))byCode.set(alias,group);
  }
  return {byCode,byName};
}
function campShowsWork(row){
  const counts=[];
  for(const b of [row?.deliverySummary,row?.returnSummary,row?.freshbagSummary]){
    if(!b||typeof b!=='object')continue;
    for(const [k,v] of Object.entries(b))if(/Count$/.test(k)&&Number.isFinite(Number(v)))counts.push(Number(v));
  }
  for(const k of ['workerCount','totalWorkerCount','activeWorkerCount'])if(row?.[k]!=null&&Number.isFinite(Number(row[k])))counts.push(Number(row[k]));
  return !counts.length||counts.some(n=>n>0);
}
function uniqueCandidateGroups(summaries,seedNames,index){
  const map=new Map(),unresolved=[];
  const add=g=>{if(g?.code&&!map.has(g.code))map.set(g.code,{...g,codes:[...g.codes]});};
  for(const name of seedNames){const g=index.byName.get(text(name))||index.byCode.get(text(name).toUpperCase());if(g)add(g);}
  for(const item of summaries){
    if(!campShowsWork(item))continue;
    const {code,name}=campIdentity(item);
    const group=index.byCode.get(code)||index.byName.get(name);
    if(group)add(group);
    else if(code)add({code,name:name||code,codes:[code]});
    else unresolved.push(Object.keys(item||{}).slice(0,12));
  }
  return {groups:[...map.values()],unresolved};
}
async function ensureBatches(env,cookies,directory){
  const targets=activeTargets();
  const dates=uniq(targets.map(t=>t.date));
  if(!dates.length)return [];
  const existing=await sbGet(env,'meta_realtime_batch?select=id,schedule_date,wave,camp_code,camp_name,status,meta_camp_codes,last_polled_at' +
    '&schedule_date=in.('+dates.join(',')+')&limit=250')||[];
  const missing=targets.filter(t=>!existing.some(b=>b.schedule_date===t.date&&b.wave===t.wave&&b.camp_code==='__ALL__'));
  let vendor=null;
  if(missing.length){
    vendor=await fetchMyVendor(cookies);  // one authenticated META request, only at bootstrap
    const rows=missing.map(target=>({
      schedule_date:target.date,
      meta_work_date:target.wave==='WAVE1'?addDate(target.date,1):target.date,
      camp_code:'__ALL__',camp_name:'투네스트 전체',wave:target.wave,
      meta_camp_codes:vendor.contractedCampCodes,status:'collecting',expected_rounds:expectedRounds(target),
      poll_interval_seconds:60,next_poll_at:nowIso(),updated_at:nowIso()
    }));
    await sb(env,'meta_realtime_batch?on_conflict=schedule_date,camp_code,wave',{
      method:'POST',headers:{prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)
    });
  }
  // Retire, not delete, old per-camp batches so no historical records are lost.
  // Only do the PATCH if old active rows really exist (no per-camp request loop).
  const retired=[];
  for(const target of targets){
    if(!missing.some(t=>t.date===target.date&&t.wave===target.wave)&&!existing.some(b=>b.schedule_date===target.date&&b.wave===target.wave&&b.camp_code!=='__ALL__'&&['collecting','completion_candidate','overdue','error'].includes(b.status)))continue;
    const legacy=existing.filter(b=>b.schedule_date===target.date&&b.wave===target.wave&&b.camp_code!=='__ALL__'&&['collecting','completion_candidate','overdue','error'].includes(b.status));
    if(!legacy.length)continue;
    await sbPatch(env, 'meta_realtime_batch?camp_code=neq.__ALL__&schedule_date=eq.'+target.date+
      '&wave=eq.'+target.wave+'&status=in.(collecting,completion_candidate,overdue,error)',{
       status:'paused',next_poll_at:null,last_error:'REPLACED_BY_CHUNWOO_AGGREGATE_BATCH',updated_at:nowIso()
      });
    retired.push({wave:target.wave,count:legacy.length});
  }
  return [{mode:'CHUNWOO_ALL',created:missing.map(t=>t.wave),retired,contractedCampCount:vendor?.contractedCampCodes.length||null}];
}

function metaFailure(response,stage='query'){
  const error=new Error(`META ${response.status}: ${stage} failed`);
  error.status=response.status;error.metaAuthRequired=[401,403,302,303].includes(response.status);return error;
}
class CollectorPaused extends Error {constructor(){super('COLLECTOR_PAUSED');this.code='COLLECTOR_PAUSED';}}
async function assertCollecting(env){
  const rows=await sbGet(env,'meta_backend_state?id=eq.1&select=collector_paused');
  if(rows?.[0]?.collector_paused===true)throw new CollectorPaused();
}
async function runCollector(env,force=false){
  const key=supabaseUrl(env);
  if(singleFlights.has(key))return {ok:true,skipped:'COLLECTOR_ALREADY_RUNNING'};
  const promise=runCollectorOnce(env,force);singleFlights.set(key,promise);
  try{return await promise;}finally{if(singleFlights.get(key)===promise)singleFlights.delete(key);}
}
async function runCollectorOnce(env,force){
  requireConfig(env);
  const state=await sessionState(env);
  if(state?.collector_paused)return {ok:true,paused:true,at:nowIso(),results:[]};
  if(!state?.cookie_bundle)return {ok:false,error:'META_SESSION_MISSING',at:nowIso(),results:[]};
  // Database contract is exposed on /collector/check. Do not spend six extra
  // Supabase subrequests validating every minute inside the free-plan collector.
  const cookies=cookiesFromState(state),results=[];
  let ensured=[],successes=0;
  try{
    ensured=await ensureBatches(env,cookies,[]);
    const due=await dueBatches(env,force);
    // A single __ALL__ wave can represent nine camps. Never run two waves in
    // the same free-plan invocation: WAVE1 and WAVE2 alternate while overlapping.
    for(const batch of due.slice(0,1)){
      const lockToken=crypto.randomUUID();let claimed=false;
      try{
        claimed=await sbPost(env,'rpc/meta_claim_realtime_batch',{p_batch_id:batch.id,p_token:lockToken,p_lease_seconds:240});
        if(!claimed){results.push({wave:batch.wave,skipped:'collector_locked'});continue;}
        const directory=await loadDriverDirectory(env);
        const value=await processBatch(env,cookies,batch,directory);
        results.push(value);successes++;
      }catch(e){
        if(e.code==='COLLECTOR_PAUSED')return {ok:true,paused:true,at:nowIso(),results};
        if(claimed){await sbPatch(env,'meta_realtime_batch?id=eq.'+batch.id,{
          status:'error',last_error:text(e.message).slice(0,500),last_polled_at:nowIso(),
          next_poll_at:kstIsoAt(Date.now()+120000),updated_at:nowIso()
        }).catch(()=>{});}
        if(e.metaAuthRequired)await saveSession(env,cookies,'expired',e.status||401,text(e.message).slice(0,250)).catch(()=>{});
        results.push({wave:batch.wave,error:text(e.message)});
      }finally{if(claimed)await sbPost(env,'rpc/meta_release_realtime_batch',{p_batch_id:batch.id,p_token:lockToken}).catch(()=>{});}
    }
    if(successes>0)await saveSession(env,cookies,'active',200,null);
    const bad=results.find(r=>r.error);
    return {ok:!bad,at:nowIso(),successful:successes,due:due.length,deferred:Math.max(0,due.length-1),
      mode:'CHUNWOO_ALL',ensure:ensured,results,error:bad?.error||undefined};
  }catch(e){
    if(e.metaAuthRequired)await saveSession(env,cookies,'expired',e.status||401,text(e.message).slice(0,250)).catch(()=>{});
    return {ok:false,error:text(e.message),at:nowIso(),successful:successes,ensure:ensured,results};
  }
}

async function requireAccess(request,env,superOnly=false){
  const origin=request.headers.get('origin');
  if(origin&&!ALLOWED_FRAME_ANCESTORS.includes(origin))throw Object.assign(new Error('Origin not allowed'),{status:403});
  const bearer=request.headers.get('authorization')||'';
  if(!/^Bearer \S+$/i.test(bearer))throw Object.assign(new Error('Authentication required'),{status:401});
  const key=text(env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_ANON_KEY||serviceKey(env));
  const response=await fetch(supabaseUrl(env)+'/auth/v1/user',{headers:{apikey:key,authorization:bearer},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(new Error('Authentication expired'),{status:401});
  const user=await response.json();if(!user?.id)throw Object.assign(new Error('Invalid user'),{status:401});
  const rows=await sbGet(env,'profiles?select=role,status&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
  const profile=rows?.[0],roles=superOnly?['super_admin']:['super_admin','admin','team_leader'];
  if(profile?.status!=='active'||!roles.includes(profile.role))throw Object.assign(new Error('Active TO:NEST manager required'),{status:403});
  return {user,profile,bearer};
}
function publicState(state){
  return state?{status:state.status,paused:state.collector_paused===true,last_success_at:state.last_success_at,
    last_http_status:state.last_http_status,last_error:state.last_error,updated_at:state.updated_at}:null;
}
async function setPaused(request,env,ctx){
  const access=await requireAccess(request,env,true);
  const body=await request.json().catch(()=>null);
  if(typeof body?.paused!=='boolean')return json({ok:false,error:'paused must be a boolean'},400);
  // Stopping remains possible with an expired META session or incompatible data tables.
  if(!body.paused){
    const schema=await inspectSchema(env,true);
    if(!schema.ready)return json({ok:false,error:'SCHEMA_VALIDATION_FAILED',schema},409);
  }
  const key=text(env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_ANON_KEY||serviceKey(env));
  // Delegate to the existing RPC with the USER JWT; do not bypass its super_admin check.
  const response=await fetch(supabaseUrl(env)+'/rest/v1/rpc/tn_set_meta_collector_paused',{
    method:'POST',headers:{apikey:key,authorization:access.bearer,'content-type':'application/json'},
    body:JSON.stringify({p_paused:body.paused}),signal:AbortSignal.timeout(10000)});
  if(!response.ok){const payload=await response.json().catch(()=>({}));return json({ok:false,error:payload.message||'Collector control failed',code:payload.code},response.status);}
  // Consume the response before querying state, also on 204 responses.
  await response.text();
  const state=await sessionState(env);
  const enabled=state?.collector_paused===false;
  if(body.paused&&!state?.collector_paused)return json({ok:false,error:'Pause state was not saved'},409);
  if(!body.paused&&!enabled)return json({ok:false,error:'Resume state was not saved'},409);
  if(!body.paused&&state?.cookie_bundle){
    const pending=runCollector(env,true).catch(e=>console.error('Resume failed',e.message));
    if(ctx?.waitUntil)ctx.waitUntil(pending);else await pending;
  }
  return json({ok:true,paused:!!state?.collector_paused,queued:!body.paused&&!!state?.cookie_bundle,
    requiresMetaLogin:!state?.cookie_bundle,state:publicState(state)},body.paused?200:202);
}
function corsResponse(response,request){
  const origin=request.headers.get('origin'),headers=new Headers(response.headers);
  if(ALLOWED_FRAME_ANCESTORS.includes(origin))headers.set('access-control-allow-origin',origin);
  headers.set('vary','Origin');headers.set('access-control-allow-headers','Authorization, Content-Type');
  headers.set('access-control-allow-methods','GET, POST, OPTIONS');headers.set('cache-control','no-store');
  return new Response(response.body,{status:response.status,headers});
}
const worker={
  async fetch(request,env,ctx){
    const url=new URL(request.url),path=url.pathname.replace(/\/+$/,'')||'/';
    try{
      if(request.method==='OPTIONS')return new Response(null,{status:ALLOWED_FRAME_ANCESTORS.includes(request.headers.get('origin'))?204:403});
      if(path==='/health'){
        const schema=await inspectSchema(env).catch(e=>({ready:false,issues:[schemaIssue(e,'configuration')]}));
        const state=await sessionState(env).catch(()=>null);
        return json({ok:true,service:'tonest-meta-collector',version:BUILD_VERSION,schemaReady:schema.ready,
          schemaCheck:schema.check||'failed',schemaIssueCount:schema.issues.length,
          supabaseConfigured:!!text(env.SUPABASE_URL)&&!!serviceKey(env),
          maroowellApiConfigured:!!env.CAMP_DIRECTORY||!!text(env.MAROOWELL_API_KEY),
          metaCredentialsConfigured:!!text(env.META_ID)&&!!text(env.META_PW),
          metaSessionStatus:state?.status||'unknown',collectorPaused:state?.collector_paused===true,time:new Date().toISOString()});
      }
      if(path==='/collector/control'){
        if(request.method!=='POST')return json({ok:false,error:'POST required'},405);
        return await setPaused(request,env,ctx);
      }
      const protectedPaths=['/collector/status','/collector/check','/collector/run','/login-send-code','/test-db'];
      if(protectedPaths.includes(path)){
        await requireAccess(request,env);
        if(path!=='/collector/status'&&request.method!=='POST')return json({ok:false,error:'POST required'},405);
      }
      if(path==='/collector/check')return json({ok:true,schema:await inspectSchema(env,true)});
      if(path==='/collector/status'){
        const schema=await inspectSchema(env),state=await sessionState(env);
        const batches=schema.ready?await sbGet(env,'meta_realtime_batch?select=id,schedule_date,wave,camp_code,camp_name,status,worker_count,last_polled_at,last_error,expected_rounds&order=last_polled_at.desc.nullslast&limit=100'):[];
        return json({ok:true,version:BUILD_VERSION,state:publicState(state),schema,batches,
          batch_summary:{total:batches.length,polled:batches.filter(b=>b.last_polled_at).length,
            empty:batches.filter(b=>b.last_error?.startsWith('META_EMPTY_WORKERS')).length,
            errors:batches.filter(b=>b.status==='error').length},
          warnings:[...optionalWarnings.values()]});
      }
      if(path==='/collector/run'){
        const result=await runCollector(env,true);
        return json(result,result.ok?200:(result.error==='SCHEMA_VALIDATION_FAILED'?409:502));
      }
      if(path==='/login-send-code'){
        const response=await loginSendCode(env);
        // srcdoc has the parent page's base URL; make the form submit to this Worker.
        return html((await response.text()).replace('action="/login-submit-code"','action="'+esc(url.origin)+'/login-submit-code"'),response.status);
      }
      if(path==='/login-submit-code'&&request.method==='POST'){
        const response=await loginSubmitCode(request,env);
        if(response.ok&&ctx?.waitUntil)ctx.waitUntil(runCollector(env,true).catch(e=>console.error('Post-login collection failed',e.message)));
        return response;
      }
      if(path==='/test-db')return await testDb(env);
      if(path==='/')return json({ok:true,service:'tonest-meta-collector',version:BUILD_VERSION});
      return json({ok:false,error:'Not found'},404);
    }catch(e){console.error('TONEST META',e.message);return json({ok:false,error:String(e.message||e).slice(0,700),code:e.code||null},Number(e.status)>=400&&Number(e.status)<600?Number(e.status):500);}
  },
  async scheduled(event,env,ctx){
    const isKeepalive=String(event?.cron||'')==='*/5 * * * *';
    if(isKeepalive){
      ctx.waitUntil((async()=>{
        const state=await sessionState(env);
        if(!state?.cookie_bundle)return;
        const cookies=cookiesFromState(state);
        await heartbeat(env,cookies);
      })().catch(e=>console.error('TONEST SESSION HEARTBEAT',e.message)));
    }else{
      ctx.waitUntil(runCollector(env).catch(e=>console.error('TONEST META CRON',e.message)));
    }
  }
};
export default {
  async fetch(request,env,ctx){return corsResponse(await worker.fetch(request,env,ctx),request);},
  scheduled:worker.scheduled
};
