import scheduleWorker from "../schedule-api/worker.js";

/**
 * TO:NEST route-info Worker v4 - unified PK
 *
 * Core rule:
 * - public.tonest_route_info.id === MAROOWELL public.subsubroutes.id
 * - no UUID/local bridge PK
 * - all TO:NEST route-info rows are night routes
 * - polygon stays only in MAROOWELL subsubroutes.polygon_wgs84
 * - TO:NEST stores business info only; has_polygon is derived at read time
 *
 * ENV / Secrets
 * - SUPABASE_URL
 * - SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY
 * - SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY
 * - MAROOWELL_SUPABASE_URL
 * - MAROOWELL_SUPABASE_SERVICE_ROLE_KEY
 *   (or MAROOWELL_SUPABASE_SERVICE_ROLE / MAROOWELL_SUPABASE_SECRET_KEY)
 * - TONEST_VENDOR_NAME (optional, default: 주식회사 투네스트)
 */

const ALLOWED_ORIGINS = new Set([
  "https://tonest-corp.com",
  "https://www.tonest-corp.com"
]);

const TABLE = "tonest_route_info";
const MW_ROUTE_TABLE = "subsubroutes";
const MW_BASE_TABLE = "maroowell_route";
const MW_RATE_TABLE = "maroowell_route_rates";
const MW_DETAIL_TABLE = "maroowell_route_info";
const MW_LEGACY_TABLE = "maroowell_sub_sub_route";
const MW_VENDOR_TABLE = "vendors";
const TONEST_VENDOR_DEFAULT = "주식회사 투네스트";
const WRITE_ROLES = new Set(["super_admin", "admin", "team_leader"]);
const RATE_PERIODS = {
  "2026": { start_date: "2026-06-01", end_date: "2027-05-31" },
  "2025": { start_date: "2025-01-01", end_date: "2026-05-31" }
};

function clean(v) { return String(v ?? "").trim(); }
function code(v) { return clean(v).replace(/\s+/g, "").toUpperCase(); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o || {}, k); }
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function digits(v) { return clean(v).replace(/\D/g, ""); }

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://tonest-corp.com",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function isAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || ALLOWED_ORIGINS.has(origin);
}
function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
function httpError(status, message, details = null) {
  const e = new Error(message);
  e.status = status;
  e.details = details;
  return e;
}

function supabaseBase(env) { return clean(env.SUPABASE_URL).replace(/\/+$/, ""); }
function serviceKey(env) {
  return clean(env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "");
}
function publicKeys(env) {
  return [...new Set([
    clean(env.SUPABASE_PUBLISHABLE_KEY),
    clean(env.SUPABASE_ANON_KEY),
    serviceKey(env)
  ].filter(Boolean))];
}
function mwBase(env) { return clean(env.MAROOWELL_SUPABASE_URL).replace(/\/+$/, ""); }
function mwKey(env) {
  return clean(env.MAROOWELL_SUPABASE_SERVICE_ROLE_KEY || env.MAROOWELL_SUPABASE_SERVICE_ROLE || env.MAROOWELL_SUPABASE_SECRET_KEY || "");
}
function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}
async function readJson(request) {
  try { return await request.json(); }
  catch { throw httpError(400, "잘못된 JSON 요청입니다."); }
}

async function dbFetch(base, key, path, init = {}) {
  if (!base || !key) throw httpError(500, "Supabase 서버 설정이 누락되었습니다.");
  const headers = new Headers(init.headers || {});
  headers.set("apikey", key);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type") && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(base + path, { ...init, headers });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  if (!response.ok) {
    throw httpError(
      response.status,
      payload?.message || payload?.error || payload?.details || raw || `HTTP ${response.status}`,
      payload
    );
  }
  return payload;
}
async function tnFetch(env, path, init = {}) { return dbFetch(supabaseBase(env), serviceKey(env), path, init); }
async function mwFetch(env, path, init = {}) {
  if (!mwBase(env) || !mwKey(env)) {
    throw httpError(503, "MAROOWELL DB 연동 설정이 없습니다. route-info Worker의 MAROOWELL_SUPABASE_URL과 MAROOWELL_SUPABASE_SERVICE_ROLE_KEY를 확인하세요.");
  }
  return dbFetch(mwBase(env), mwKey(env), path, init);
}

async function getLoggedInUser(request, env) {
  const token = bearer(request);
  if (!token) throw httpError(401, "로그인이 필요합니다.");
  const base = supabaseBase(env);
  let last = null;
  for (const key of publicKeys(env)) {
    const res = await fetch(base + "/auth/v1/user", {
      headers: { apikey: key, Authorization: "Bearer " + token, Accept: "application/json" },
      cache: "no-store"
    });
    const p = await res.json().catch(() => ({}));
    if (res.ok) {
      const user = p?.user || p;
      if (user?.id) return user;
    }
    last = p;
  }
  throw httpError(401, last?.message || last?.error || "로그인 세션이 만료되었습니다.");
}
async function getProfile(env, userId) {
  const p = new URLSearchParams();
  p.set("select", "user_id,email,display_name,role,status");
  p.set("user_id", "eq." + userId);
  p.set("limit", "1");
  const rows = await tnFetch(env, "/rest/v1/profiles?" + p.toString(), { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function requireUser(request, env, write = false) {
  const user = await getLoggedInUser(request, env);
  const profile = await getProfile(env, user.id);
  if (!profile) throw httpError(403, "계정 권한 정보가 없습니다.");
  if (profile.status !== "active") throw httpError(403, "활성 계정만 사용할 수 있습니다.");
  const canEdit = WRITE_ROLES.has(profile.role);
  if (write && !canEdit) throw httpError(403, "수정 권한이 없습니다.");
  return { user, userId: user.id, profile, canEdit };
}

function defaultRates(input = null) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const year of ["2026", "2025"]) {
    const row = src[year] && typeof src[year] === "object" ? src[year] : {};
    out[year] = {
      start_date: RATE_PERIODS[year].start_date,
      end_date: RATE_PERIODS[year].end_date,
      origin_price: num(row.origin_price),
      fixed_price: num(row.fixed_price),
      backup_price: num(row.backup_price)
    };
  }
  return out;
}
function localPayload(body, current = null) {
  return {
    camp: hasOwn(body, "camp") ? clean(body.camp) : clean(current?.camp),
    route_code: hasOwn(body, "route_code") ? code(body.route_code) : code(current?.route_code),
    contract_date: hasOwn(body, "contract_date") ? (clean(body.contract_date) || null) : (current?.contract_date ?? null),
    address: hasOwn(body, "address") ? (clean(body.address) || null) : (current?.address ?? null),
    delivery_location_name: hasOwn(body, "delivery_location_name") ? (clean(body.delivery_location_name) || null) : (current?.delivery_location_name ?? null),
    delivery_location_address: hasOwn(body, "delivery_location_address") ? (clean(body.delivery_location_address) || null) : (current?.delivery_location_address ?? null),
    rates: hasOwn(body, "rates") ? defaultRates(body.rates) : defaultRates(current?.rates),
    route_tip: hasOwn(body, "route_tip") ? (clean(body.route_tip) || null) : (current?.route_tip ?? null),
    route_details: hasOwn(body, "route_details") && Array.isArray(body.route_details) ? body.route_details : (Array.isArray(current?.route_details) ? current.route_details : []),
    tonest_memo: hasOwn(body, "tonest_memo") ? (clean(body.tonest_memo) || null) : (current?.tonest_memo ?? null),
    is_active: hasOwn(body, "is_active") ? body.is_active !== false : (current?.is_active !== false)
  };
}

async function findLocal(env, id) {
  const rows = await tnFetch(env, `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function findLocalByRoute(env, camp, routeCode) {
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("camp", "eq." + camp);
  p.set("route_code", "eq." + routeCode);
  p.set("limit", "1");
  const rows = await tnFetch(env, "/rest/v1/" + TABLE + "?" + p.toString(), { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function insertLocal(env, id, record) {
  const rows = await tnFetch(env, `/rest/v1/${TABLE}?select=*`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ id, ...record, updated_at: new Date().toISOString() })
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}
async function patchLocal(env, id, patch) {
  const rows = await tnFetch(env, `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function mwRouteById(env, id) {
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("id", "eq." + id);
  p.set("limit", "1");
  const rows = await mwFetch(env, "/rest/v1/" + MW_ROUTE_TABLE + "?" + p.toString(), { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function mwRouteByCode(env, camp, routeCode) {
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("camp", "eq." + camp);
  p.set("full_code", "eq." + routeCode);
  p.set("limit", "1");
  const rows = await mwFetch(env, "/rest/v1/" + MW_ROUTE_TABLE + "?" + p.toString(), { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function mwTonestVendor(env) {
  const wanted = clean(env.TONEST_VENDOR_NAME) || TONEST_VENDOR_DEFAULT;
  let p = new URLSearchParams();
  p.set("select", "id,name,business_number");
  p.set("name", "eq." + wanted);
  p.set("limit", "2");
  let rows = await mwFetch(env, "/rest/v1/" + MW_VENDOR_TABLE + "?" + p.toString(), { method: "GET" });
  let list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    p = new URLSearchParams();
    p.set("select", "id,name,business_number");
    p.set("name", "ilike.*투네스트*");
    p.set("limit", "10");
    rows = await mwFetch(env, "/rest/v1/" + MW_VENDOR_TABLE + "?" + p.toString(), { method: "GET" });
    list = Array.isArray(rows) ? rows : [];
  }
  const exact = list.find(v => clean(v.name) === wanted) || list[0] || null;
  if (!exact?.business_number) throw httpError(500, `MAROOWELL vendors에서 '${wanted}' 사업자번호를 찾을 수 없습니다.`);
  return exact;
}
async function mwVendorNameByBusinessNumber(env, businessNumber) {
  const bn = digits(businessNumber);
  if (!bn) return null;
  const p = new URLSearchParams();
  p.set("select", "name,business_number");
  p.set("limit", "1000");
  const rows = await mwFetch(env, "/rest/v1/" + MW_VENDOR_TABLE + "?" + p.toString(), { method: "GET" });
  const found = (Array.isArray(rows) ? rows : []).find(v => digits(v.business_number) === bn);
  return found?.name || null;
}
async function mwEnsureRoute(env, record) {
  let route = await mwRouteByCode(env, record.camp, record.route_code);
  const vendor = await mwTonestVendor(env);
  const patch = {
    camp: record.camp,
    code: record.route_code,
    full_code: record.route_code,
    delivery_location_name: record.delivery_location_name || null,
    delivery_location_address: record.delivery_location_address || null,
    vendor_business_number_1w: vendor.business_number,
    is_active: true
  };
  if (route?.id != null) {
    const rows = await mwFetch(env, `/rest/v1/${MW_ROUTE_TABLE}?id=eq.${route.id}&select=*`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch)
    });
    return Array.isArray(rows) ? rows[0] || route : rows || route;
  }
  const rows = await mwFetch(env, `/rest/v1/${MW_ROUTE_TABLE}?select=*`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  route = Array.isArray(rows) ? rows[0] || null : rows;
  if (!route?.id) throw httpError(500, "MAROOWELL 라우트 PK 생성에 실패했습니다.");
  return route;
}

async function mwMasterUpdate(env, id, record) {
  const payload = {
    p_id: Number(id),
    p_new_camp: record.camp,
    p_new_code: record.route_code,
    p_actor_user_id: null,
    p_delivery_location_name: record.delivery_location_name || null,
    p_delivery_location_address: record.delivery_location_address || null
  };
  await mwFetch(env, "/rest/v1/rpc/mw_route_master_update", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const vendor = await mwTonestVendor(env);
  await mwFetch(env, `/rest/v1/${MW_ROUTE_TABLE}?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ vendor_business_number_1w: vendor.business_number, is_active: true })
  });
}

async function mwBaseRow(env, subId, camp, routeCode) {
  let p = new URLSearchParams();
  p.set("select", "*");
  p.set("subsubroute_id", "eq." + subId);
  p.set("limit", "1");
  let rows = await mwFetch(env, "/rest/v1/" + MW_BASE_TABLE + "?" + p.toString(), { method: "GET" });
  if (Array.isArray(rows) && rows[0]) return rows[0];
  p = new URLSearchParams();
  p.set("select", "*");
  p.set("camp", "eq." + camp);
  p.set("route", "eq." + routeCode);
  p.set("limit", "1");
  rows = await mwFetch(env, "/rest/v1/" + MW_BASE_TABLE + "?" + p.toString(), { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function mwUpsertBaseAndRates(env, id, record) {
  const rates = defaultRates(record.rates);
  const r26 = rates["2026"];
  const r25 = rates["2025"];
  let base = await mwBaseRow(env, id, record.camp, record.route_code);
  const payload = {
    camp: record.camp,
    route: record.route_code,
    wave: "야간",
    contract_date: record.contract_date || null,
    address: record.address || null,
    "25y_orgin_price": r25.origin_price,
    "26y_orgin_price": r26.origin_price,
    fixed_price: r26.fixed_price,
    backup_price: r26.backup_price,
    route_tip: record.route_tip || null,
    subsubroute_id: Number(id)
  };
  if (base?.seq != null) {
    const rows = await mwFetch(env, `/rest/v1/${MW_BASE_TABLE}?seq=eq.${base.seq}&select=*`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });
    base = Array.isArray(rows) ? rows[0] || base : rows || base;
  } else {
    const rows = await mwFetch(env, `/rest/v1/${MW_BASE_TABLE}?select=*`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });
    base = Array.isArray(rows) ? rows[0] || null : rows;
  }
  if (!base?.seq) throw httpError(500, "MAROOWELL maroowell_route 저장에 실패했습니다.");

  for (const year of ["2026", "2025"]) {
    const rr = rates[year];
    await mwFetch(env, `/rest/v1/${MW_RATE_TABLE}?route_seq=eq.${base.seq}&period_code=eq.${year}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
    await mwFetch(env, `/rest/v1/${MW_RATE_TABLE}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        route_seq: base.seq,
        period_code: year,
        origin_price: rr.origin_price,
        fixed_price: rr.fixed_price,
        backup_price: rr.backup_price
      })
    });
  }
  return base;
}

async function mwReplaceDetails(env, id, record) {
  if (!Array.isArray(record.route_details)) return;
  await mwFetch(env, `/rest/v1/${MW_DETAIL_TABLE}?subsubroute_id=eq.${id}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
  if (!record.route_details.length) return;
  const rows = record.route_details.map((d, i) => ({
    camp: record.camp,
    route: record.route_code,
    sub: d?.sub ?? null,
    sub_sub: d?.sub_sub ?? null,
    sub_package: d?.sub_package ?? null,
    description: d?.description ?? null,
    memo: d?.memo ?? null,
    coordinate: d?.coordinate ?? null,
    sort_order: Number.isFinite(Number(d?.sort_order)) ? Number(d.sort_order) : i,
    is_active: d?.is_active !== false,
    route_code: d?.route_code || record.route_code,
    route_norm: d?.route_norm || record.route_code,
    subsubroute_id: Number(id)
  }));
  await mwFetch(env, `/rest/v1/${MW_DETAIL_TABLE}`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows)
  });
}
async function mwEnsureLegacy(env, id, record) {
  const p = new URLSearchParams();
  p.set("select", "id");
  p.set("subsubroute_id", "eq." + id);
  p.set("limit", "1");
  const rows = await mwFetch(env, "/rest/v1/" + MW_LEGACY_TABLE + "?" + p.toString(), { method: "GET" });
  const current = Array.isArray(rows) ? rows[0] || null : null;
  const payload = {
    camp: record.camp,
    route_code: record.route_code,
    route_norm: record.route_code,
    is_active: true,
    subsubroute_id: Number(id)
  };
  if (current?.id != null) {
    await mwFetch(env, `/rest/v1/${MW_LEGACY_TABLE}?id=eq.${current.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
  } else {
    await mwFetch(env, `/rest/v1/${MW_LEGACY_TABLE}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
  }
}
async function pushAllToMaroowell(env, id, record, rename = true) {
  if (rename) await mwMasterUpdate(env, id, record);
  await mwUpsertBaseAndRates(env, id, record);
  await mwReplaceDetails(env, id, record);
  await mwEnsureLegacy(env, id, record);
}

async function mwReadBusinessInfo(env, id) {
  const route = await mwRouteById(env, id);
  if (!route) return null;
  const camp = clean(route.camp);
  const routeCode = code(route.full_code || route.code);
  const base = await mwBaseRow(env, id, camp, routeCode);
  const rates = defaultRates();
  if (base?.seq != null) {
    const p = new URLSearchParams();
    p.set("select", "period_code,origin_price,fixed_price,backup_price");
    p.set("route_seq", "eq." + base.seq);
    const rr = await mwFetch(env, "/rest/v1/" + MW_RATE_TABLE + "?" + p.toString(), { method: "GET" });
    for (const row of Array.isArray(rr) ? rr : []) {
      const y = clean(row.period_code);
      if (rates[y]) {
        rates[y].origin_price = row.origin_price ?? null;
        rates[y].fixed_price = row.fixed_price ?? null;
        rates[y].backup_price = row.backup_price ?? null;
      }
    }
  }
  const d = new URLSearchParams();
  d.set("select", "sub,sub_sub,sub_package,description,memo,coordinate,sort_order,is_active,route_code,route_norm");
  d.set("subsubroute_id", "eq." + id);
  d.set("order", "sort_order.asc,created_at.asc");
  const detailsRaw = await mwFetch(env, "/rest/v1/" + MW_DETAIL_TABLE + "?" + d.toString(), { method: "GET" });
  return {
    id: Number(id),
    camp,
    route_code: routeCode,
    contract_date: base?.contract_date ?? null,
    address: base?.address ?? null,
    delivery_location_name: route.delivery_location_name ?? null,
    delivery_location_address: route.delivery_location_address ?? null,
    rates,
    route_tip: base?.route_tip ?? null,
    route_details: Array.isArray(detailsRaw) ? detailsRaw : [],
    is_active: route.is_active !== false,
    has_polygon: route.polygon_wgs84 != null,
    night_vendor_name: await mwVendorNameByBusinessNumber(env, route.vendor_business_number_1w)
  };
}

async function enrichHasPolygon(env, rows) {
  const ids = [...new Set((rows || []).map(r => Number(r.id)).filter(Number.isFinite))];
  if (!ids.length) return rows || [];
  const p = new URLSearchParams();
  p.set("select", "id,polygon_wgs84,camp,full_code,code,delivery_location_name,delivery_location_address,is_active");
  p.set("id", `in.(${ids.join(",")})`);
  const mwRows = await mwFetch(env, "/rest/v1/" + MW_ROUTE_TABLE + "?" + p.toString(), { method: "GET" });
  const byId = new Map((Array.isArray(mwRows) ? mwRows : []).map(r => [Number(r.id), r]));
  for (const row of rows || []) {
    const mw = byId.get(Number(row.id));
    row.has_polygon = Boolean(mw?.polygon_wgs84);
    row.maroowell_exists = Boolean(mw);
  }
  return rows || [];
}

async function listRoutes(request, env, url) {
  await requireUser(request, env, false);
  const includeInactive = clean(url.searchParams.get("include_inactive")) === "1";
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("order", "camp.asc,route_code.asc,id.asc");
  if (!includeInactive) p.set("is_active", "eq.true");
  let rows = await tnFetch(env, "/rest/v1/" + TABLE + "?" + p.toString(), { method: "GET" });
  rows = Array.isArray(rows) ? rows : [];
  // Local TO:NEST data must remain readable if optional MAROOWELL polygon
  // enrichment is unavailable or credentials have not been configured.
  let maroowellStatus = mwBase(env) && mwKey(env) ? "connected" : "unconfigured";
  if (maroowellStatus === "connected") {
    try {
      await enrichHasPolygon(env, rows);
    } catch (error) {
      maroowellStatus = "unavailable";
      console.warn("TO:NEST polygon enrichment unavailable:", error?.message || String(error));
    }
  }
  if (maroowellStatus !== "connected") {
    for (const row of rows) {
      row.has_polygon = null;
      row.maroowell_exists = null;
    }
  }

  const camp = clean(url.searchParams.get("camp"));
  const routeCode = code(url.searchParams.get("code"));
  const q = clean(url.searchParams.get("q")).toLowerCase();
  if (camp) rows = rows.filter(r => clean(r.camp) === camp);
  if (routeCode) rows = rows.filter(r => code(r.route_code).startsWith(routeCode));
  if (q) rows = rows.filter(r => [r.camp,r.route_code,r.address,r.delivery_location_name,r.delivery_location_address,r.route_tip,r.tonest_memo]
    .map(v => clean(v).toLowerCase()).join(" ").includes(q));
  return json(request, { rows, count: rows.length, maroowellStatus });
}

async function createRoute(request, env) {
  await requireUser(request, env, true);
  const body = await readJson(request);
  const record = localPayload(body, null);
  if (!record.camp || !record.route_code) throw httpError(400, "캠프와 라우트는 필수입니다.");

  const mwRoute = await mwEnsureRoute(env, record);
  const id = Number(mwRoute.id);
  let current = await findLocal(env, id);
  if (!current) current = await findLocalByRoute(env, record.camp, record.route_code);

  const saved = current ? await patchLocal(env, current.id, record) : await insertLocal(env, id, record);
  await pushAllToMaroowell(env, id, record, false);
  const out = { ...(saved || {}), id, has_polygon: Boolean(mwRoute.polygon_wgs84), maroowell_exists: true };
  return json(request, { row: out, reused: Boolean(current) }, current ? 200 : 201);
}

async function updateRoute(request, env, id) {
  await requireUser(request, env, true);
  const current = await findLocal(env, id);
  if (!current) throw httpError(404, "라우트 정보를 찾을 수 없습니다.");
  const body = await readJson(request);
  const record = localPayload(body, current);
  if (!record.camp || !record.route_code) throw httpError(400, "캠프와 라우트는 필수입니다.");

  await pushAllToMaroowell(env, id, record, true);
  const saved = await patchLocal(env, id, record);
  const mw = await mwRouteById(env, id);
  return json(request, { row: { ...(saved || {}), has_polygon: Boolean(mw?.polygon_wgs84), maroowell_exists: Boolean(mw) }, maroowell_synced: true });
}

async function softDeleteRoute(request, env, id) {
  await requireUser(request, env, true);
  const current = await findLocal(env, id);
  if (!current) throw httpError(404, "라우트 정보를 찾을 수 없습니다.");
  const saved = await patchLocal(env, id, { is_active: false });
  return json(request, { row: saved });
}

function isTonestNightVendor(name) {
  const n = clean(name).replace(/\s+/g, "").toLowerCase();
  const target = TONEST_VENDOR_DEFAULT.replace(/\s+/g, "").toLowerCase();
  return n === target || n.includes("투네스트");
}
async function fromMap(request, env) {
  await requireUser(request, env, true);
  const body = await readJson(request);
  const source = body?.source || body?.row || body;
  const id = Number(source?.id ?? source?.maroowell_subsubroute_id ?? body?.route_info_id);
  if (!Number.isFinite(id)) throw httpError(400, "MAROOWELL route id가 필요합니다.");

  const mwInfo = await mwReadBusinessInfo(env, id);
  if (!mwInfo) throw httpError(404, "MAROOWELL 라우트를 찾을 수 없습니다.");
  let existing = await findLocal(env, id);

  // 지도에서 먼저 만든 경우: 야간 벤더가 TO:NEST일 때만 자동 등록.
  if (!existing && !isTonestNightVendor(mwInfo.night_vendor_name)) {
    return json(request, {
      ok: true,
      skipped: true,
      reason: "night_vendor_not_tonest",
      night_vendor_name: mwInfo.night_vendor_name || null
    });
  }

  const baseRecord = localPayload(mwInfo, existing);
  const saved = existing ? await patchLocal(env, id, baseRecord) : await insertLocal(env, id, baseRecord);
  return json(request, { ok: true, created: !existing, row: { ...(saved || {}), has_polygon: mwInfo.has_polygon, maroowell_exists: true } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if(path === "/schedule-api" || path.startsWith("/schedule-api/")) {
        url.pathname=path.slice("/schedule-api".length)||"/";
        return await scheduleWorker.fetch(new Request(url.toString(),request),env);
      }

      if (request.method === "OPTIONS") {
        if (!isAllowedOrigin(request)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (!isAllowedOrigin(request)) return json(request, { error: "허용되지 않은 Origin입니다." }, 403);

      if (path === "/health" && request.method === "GET") {
        return json(request, {
          ok: true,
          service: "tonest-route-info-v4-unified-pk",
          unifiedPk: true,
          tonestSupabase: Boolean(supabaseBase(env) && serviceKey(env)),
          maroowellSupabase: Boolean(mwBase(env) && mwKey(env)),
          time: new Date().toISOString()
        });
      }
      if (path === "/me" && request.method === "GET") {
        const auth = await requireUser(request, env, false);
        return json(request, { profile: auth.profile, canEdit: auth.canEdit });
      }
      if (path === "/routes") {
        if (request.method === "GET") return await listRoutes(request, env, url);
        if (request.method === "POST") return await createRoute(request, env);
        return json(request, { error: "Method Not Allowed" }, 405);
      }
      const match = path.match(/^\/routes\/(\d+)$/);
      if (match) {
        if (request.method === "PATCH") return await updateRoute(request, env, Number(match[1]));
        if (request.method === "DELETE") return await softDeleteRoute(request, env, Number(match[1]));
        return json(request, { error: "Method Not Allowed" }, 405);
      }
      if (path === "/from-map" && request.method === "POST") return await fromMap(request, env);
      if ((path === "/sync" || path === "/sync-one") && request.method === "POST") {
        await requireUser(request, env, true);
        return json(request, { ok: true, disabled: true, message: "동기화 버튼은 사용하지 않습니다. 저장 시 자동 연동됩니다." });
      }
      return json(request, { error: "Not Found" }, 404);
    } catch (error) {
      console.error("TO:NEST ROUTE-INFO V4 ERROR", error);
      return json(request, { error: error?.message || String(error), details: error?.details || null }, Number(error?.status) || 500);
    }
  }
};
