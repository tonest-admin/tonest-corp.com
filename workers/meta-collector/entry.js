import { advanceProgress, expectedRounds } from "./rounds.mjs";
/**
 * TO:NEST META realtime collector - FULL
 *
 * 역할
 *  - Coupang META 로그인 + SMS MFA
 *  - META 세션 쿠키를 TO:NEST Supabase meta_backend_state 에 저장
 *  - tonest_schedule 기준으로 현재 운행 캠프/주야간 배치 자동 생성
 *  - MAROOWELL 공용 캠프 API에서 META camp code 조회
 *  - META 배송/반품/프레시백/신선배송 상태 1분 수집
 *  - meta_realtime_current / history / final 관리
 *  - tonest_info.pk_id 기준 기사 매칭
 *
 * Cloudflare ENV / Secret
 *  Required:
 *    SUPABASE_URL
 *    SUPABASE_SERVICE_ROLE_KEY   (or SUPABASE_SECRET_KEY)
 *    META_ID
 *    META_PW
 *    MAROOWELL_API_KEY
 *  Optional:
 *    MAROOWELL_API_BASE
 */

const FLY_REALTIME = "https://fly.coupang.com/ui/dashboard/realtime";
const META_WORKER_URL = "https://fly.coupang.com/realtime-dashboard/workers/work-status/search";
const META_CAMP_URL = "https://fly.coupang.com/realtime-dashboard/camps/work-status/search";
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
  const missing = [];
  if (!text(env.SUPABASE_URL)) missing.push("SUPABASE_URL");
  if (!serviceKey(env)) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  // Camp credentials are checked only when resolving the camp directory.
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

function serviceKey(env) {
  return text(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SECRET_KEY);
}

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

function sourceCampCode(src) {
  const w = src?.workerInfo || {};
  for (const k of ["campCode", "sourceCampCode", "workCampCode"]) {
    const v = src?.[k] ?? w?.[k];
    if (text(v)) return text(v).toUpperCase();
  }
  return null;
}

function deliveryMetric(s = {}) {
  const assigned = +s.assignedCount || 0;
  const scanned = +s.scannedCount || 0;
  const completed = +s.completedCount || 0;
  const impossible = +s.impossibleCount || 0;
  const pdd = +s.pddMissCount || 0;
  const total = assigned + scanned + completed + impossible + pdd;
  const sourceRate = Number(s.completedRatio);
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

async function sb(env, path, init = {}) {
  requireConfig(env);
  const key = serviceKey(env);
  const headers = new Headers(init.headers || {});
  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(`${supabaseUrl(env)}/rest/v1/${path}`, { ...init, headers });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status} ${path}: ${bodyText.slice(0, 800)}`);
  if (!bodyText) return null;
  try { return JSON.parse(bodyText); } catch { return bodyText; }
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

async function getMaroCampRows(env, camp = "") {
  if (env.CAMP_DIRECTORY) return await env.CAMP_DIRECTORY.listCamps(camp);
  const p = new URLSearchParams();
  if (text(camp)) p.set("camp", text(camp));
  p.set("limit", "1000");
  const payload = await maroFetch(env, `/api/v1/camps?${p.toString()}`);
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
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

async function verificationCampCodes(env) {
  const kp = kstParts();
  const wave = kp.hour < 12 ? "WAVE1" : "WAVE2";
  const date = wave === "WAVE1" && kp.hour < 12 ? addDate(kp.date, -1) : kp.date;
  const schedules = await sbGet(env,
    `tonest_schedule?select=camp&schedule_date=eq.${date}&wave=eq.${wave}&is_active=eq.true&limit=50`
  ).catch(() => []);
  const camps = uniq((schedules || []).map(r => r.camp));
  const codes = [];
  for (const camp of camps.slice(0, 5)) {
    const m = await loadCampMeta(env, camp).catch(() => ({ codes: [] }));
    codes.push(...(m.codes || []));
  }
  if (codes.length) return uniq(codes).slice(0, 30);
  const rows = await getMaroCampRows(env, "").catch(() => []);
  return metaCampCandidates(uniq(rows.map(r => r?.code))).slice(0, 30);
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

function cookieHeader(map) {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function splitSetCookie(raw) {
  if (!raw) return [];
  return String(raw).split(/,(?=[^;,]+=)/g);
}

function absorbSetCookies(map, response) {
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

async function metaPage(cookies, url, payload) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: {
      accept: "application/json",
      "accept-language": "ko-KR",
      "content-type": "application/json;charset=UTF-8",
      origin: "https://fly.coupang.com",
      referer: FLY_REALTIME,
      "user-agent": UA,
      "x-coupang-accept-language": "ko-KR",
      "x-requested-with": "XMLHttpRequest",
      cookie: cookieHeader(cookies)
    },
    body: JSON.stringify(payload)
  });
  absorbSetCookies(cookies, response);
  const raw = await response.text();
  let body = null;
  try { body = JSON.parse(raw); } catch {}
  const success = response.status === 200 && (
    body?.message === "SUCCESS" ||
    Array.isArray(body?.data?.content) ||
    Array.isArray(body?.content) ||
    Array.isArray(body?.data?.data?.content)
  );
  return { status: response.status, raw, body, success };
}

async function metaPost(cookies,url,payload) {
  const first = await metaPage(cookies,url,payload);
  if (!first.success || url !== META_WORKER_URL) return first;
  const hasRows = Array.isArray(first.body?.data?.content) || Array.isArray(first.body?.content) || Array.isArray(first.body?.data?.data?.content);
  if (!hasRows) throw new Error('META 502: unexpected worker response shape');
  const rows = [...metaContent(first.body)];
  let response = first;
  for (let page=1;page<=50;page++) {
    const info=response.body?.data?.data || response.body?.data || response.body;
    if (info?.last===true || (Number.isFinite(info?.totalPages) && page>=info.totalPages) || metaContent(response.body).length<payload.size) break;
    if(page===50) throw new Error('META pagination safety limit exceeded; no partial snapshot saved');
    response=await metaPage(cookies,url,{...payload,page});
    if(!response.success) return response;
    const content=metaContent(response.body);
    if(!Array.isArray(response.body?.data?.content)&&!Array.isArray(response.body?.content)&&!Array.isArray(response.body?.data?.data?.content))throw new Error('META 502: invalid paginated response');
    rows.push(...content);
  }
  return {...first,body:{data:{content:rows}}};
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
  const patch = {
    cookie_bundle: cookieHeader(cookies),
    status,
    last_http_status: http,
    last_error: error,
    updated_at: new Date().toISOString()
  };
  if (!error) patch.last_success_at = new Date().toISOString();
  await sbPatch(env, "meta_backend_state?id=eq.1", patch);
}

// ============================================================================
// Schedule / driver mapping
// ============================================================================

async function loadDriverDirectory(env) {
  return await sbGet(env,
    "tonest_info?select=pk_id,person_name,coupang_id,camp_code,wave,is_resigned"
  ) || [];
}

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

async function loadSchedule(env, date, wave, camp) {
  return await sbGet(env,
    `tonest_schedule?select=driver_pk,route_label,driver_name,driver_display_name,driver_owner_name,driver_export_name,driver_coupang_id,driver_account_type,row_order&schedule_date=eq.${date}&wave=eq.${wave}&camp=eq.${encodeURIComponent(camp)}&is_active=eq.true&order=row_order.asc`
  ) || [];
}

function scheduleMatch(rows, cid, name) {
  const id = text(cid).toLowerCase();
  const dn = text(name);
  let hit = rows.filter(r => id && text(r.driver_coupang_id).toLowerCase() === id);
  if (!hit.length && dn) {
    hit = rows.filter(r => [r.driver_display_name, r.driver_name, r.driver_owner_name, r.driver_export_name]
      .some(x => text(x) === dn));
  }
  return hit;
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

async function ensureBatches(env) {
  const kp = kstParts();
  const targets = [];
  if (kp.hour >= 7) targets.push({ date: kp.date, wave: "WAVE2" });
  if (kp.hour >= 20) targets.push({ date: kp.date, wave: "WAVE1" });
  else if (kp.hour < 12) targets.push({ date: addDate(kp.date, -1), wave: "WAVE1" });

  const result = [];
  for (const target of targets) {
    const schedules = await sbGet(env,
      `tonest_schedule?select=camp&schedule_date=eq.${target.date}&wave=eq.${target.wave}&is_active=eq.true`
    ) || [];

    for (const camp of uniq(schedules.map(r => r.camp))) {
      const meta = await loadCampMeta(env, camp);
      if (!meta.codes.length || !meta.campCode) {
        result.push({ camp, wave: target.wave, skipped: "no_maroowell_camp_code" });
        continue;
      }

      const existing = await sbGet(env,
        `meta_realtime_batch?select=id,camp_code,meta_camp_codes,status&schedule_date=eq.${target.date}&camp_name=eq.${encodeURIComponent(camp)}&wave=eq.${target.wave}&order=started_at.asc&limit=1`
      );

      if (existing?.length) {
        await sbPatch(env, `meta_realtime_batch?id=eq.${existing[0].id}`, {
          camp_code: meta.campCode,
          camp_name: camp,
          meta_camp_codes: meta.codes,
          ...(existing[0].status !== "finalized" ? {expected_rounds:expectedRounds(target)} : {}),
          updated_at: nowIso()
        });
        result.push({ camp, wave: target.wave, existing: true });
        continue;
      }

      await sbPost(env, "meta_realtime_batch", {
        schedule_date: target.date,
        meta_work_date: target.wave === "WAVE1" ? addDate(target.date, 1) : target.date,
        camp_code: meta.campCode,
        camp_name: camp,
        wave: target.wave,
        meta_camp_codes: meta.codes,
        status: "collecting",
        expected_rounds: expectedRounds(target),
        poll_interval_seconds: 60,
        next_poll_at: nowIso(),
        updated_at: nowIso()
      });
      result.push({ camp, wave: target.wave, created: true });
    }
  }
  return result;
}

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

async function purgeStaleRealtimeRows(env) {
  // Active-date filtering hides old shifts; only the transactional finalizer deletes current rows.
  return 0;
}

async function dueBatches(env, force = false) {
  const states = force
    ? "status=in.(collecting,completion_candidate,overdue,error)"
    : `status=in.(collecting,completion_candidate,overdue,error)&or=(next_poll_at.is.null,next_poll_at.lte.${encodeURIComponent(nowIso())})`;
  const rows = await sbGet(env,
    `meta_realtime_batch?select=*&${states}&order=schedule_date.asc,started_at.asc`
  ) || [];
  return rows.filter(isActiveBatchDate).sort((a,b)=>Number(b.wave === "WAVE1")-Number(a.wave === "WAVE1") || String(a.next_poll_at||"").localeCompare(String(b.next_poll_at||"")));
}

function metricsCloseReached(batch) {
  const raw = text(batch?.metrics_close_at).replace(" ", "T");
  const close = raw ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}+09:00`) : NaN;
  if (Number.isFinite(close)) return Date.now() >= close;
  const day = text(batch.schedule_date);
  if (!day) return false;
  const closeDay = batch.wave === 'WAVE1' ? addDate(day,1) : day;
  const closeTime = batch.wave === 'WAVE1' ? '11:59' : '23:59';
  return Date.now() >= Date.parse(`${closeDay}T${closeTime}:00+09:00`);
}

async function storeFreshRows(env, batch, schedule, directory, freshResponse, collectedAt) {
  if (batch.wave !== "WAVE2" || !freshResponse?.success) return [];
  const byKey = new Map();
  for (const src of metaContent(freshResponse.body)) {
    const w = src?.workerInfo || {};
    const metaCid = coupangId(src);
    const name = workerName(src);
    const actualRoutes = uniq((w.workSubRoutes || []).map(normRoute));
    let matched = scheduleMatch(schedule, metaCid, name);
    if (!matched.length) matched = scheduleMatchByRoutes(schedule, actualRoutes);
    const realCid = text(matched[0]?.driver_coupang_id || metaCid) || null;
    const mappedName = text(matched[0]?.driver_display_name || matched[0]?.driver_name || matched[0]?.driver_owner_name || matched[0]?.driver_export_name || name) || null;
    const driverPk = matched[0]?.driver_pk != null
      ? Number(matched[0].driver_pk)
      : resolveDriverPk(directory, realCid, mappedName, batch.camp_name, batch.wave);
    const key = driverIdentity(driverPk, realCid, mappedName, workerKey(src));
    const d = deliveryMetric(src?.deliverySummary || {});
    const record = {
      batch_id: batch.id,
      schedule_date: batch.schedule_date,
      meta_work_date: batch.meta_work_date,
      camp_code: batch.camp_code,
      camp_name: batch.camp_name,
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
    };
    const prior = byKey.get(key);
    if (!prior || record.delivery_total > prior.delivery_total) byKey.set(key, record);
  }
  const out = [...byKey.values()];
  if (out.length) await sbUpsert(env, "meta_realtime_fresh_current", out, "batch_id,meta_worker_key");
  // Only prune obsolete keys after an entire successful response was saved.
  const old = await sbGet(env, `meta_realtime_fresh_current?select=meta_worker_key&batch_id=eq.${batch.id}`) || [];
  const stale = old.filter(r=>!byKey.has(r.meta_worker_key)).map(r=>r.meta_worker_key);
  if (stale.length) {
    const keys = stale.map(k=>`"${String(k).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(',');
    await sbDelete(env, `meta_realtime_fresh_current?batch_id=eq.${batch.id}&meta_worker_key=in.(${encodeURIComponent(keys)})`);
  }
  return out;
}

async function processBatch(env, cookies, batch) {
  const codes = metaCampCandidates(batch.meta_camp_codes?.length ? batch.meta_camp_codes : [batch.camp_code]);
  if (!codes.length) throw new Error(`META camp code 없음: ${batch.camp_name}`);

  const main = await metaPost(cookies, META_WORKER_URL, workerPayload(codes, batch.wave, batch.meta_work_date));
  if (!main.success) throw new Error(`META ${main.status}: ${main.raw.slice(0, 300)}`);

  let fresh = null;
  if (batch.wave === "WAVE2") {
    fresh = await metaPost(cookies, META_WORKER_URL, workerPayload(codes, batch.wave, batch.meta_work_date, "20:00"));
  }

  const schedule = await loadSchedule(env, batch.schedule_date, batch.wave, batch.camp_name);
  const directory = await loadDriverDirectory(env);
  const prevRows = await sbGet(env, `meta_realtime_current?select=*&batch_id=eq.${batch.id}`) || [];
  const prevMap = new Map(prevRows.map(r => [rowIdentity(r), r]));
  const byKey = new Map();
  const now = nowIso();
  const expRounds = expectedRounds(batch);

  for (const src of metaContent(main.body)) {
    const w = src?.workerInfo || {};
    const name = workerName(src);
    const metaCid = coupangId(src);
    const actualRoutes = uniq((w.workSubRoutes || []).map(normRoute));
    let matched = scheduleMatch(schedule, metaCid, name);
    if (!matched.length) matched = scheduleMatchByRoutes(schedule, actualRoutes);

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
      : resolveDriverPk(directory, realCid, mappedName, batch.camp_name, batch.wave);
    const key = driverIdentity(driverPk, realCid, mappedName, workerKey(src));
    const prev = prevMap.get(key);
    const accountType = text(matched[0]?.driver_account_type || w.workerAccountType || w.accountType) || null;

    const d = deliveryMetric(src?.deliverySummary || {});
    const fb = collectionMetric(src?.freshbagSummary || {}, false);
    const ret = batch.wave === "WAVE1" ? null : collectionMetric(src?.returnSummary || {}, true);

    const extraRoutes = actualRoutes.filter(a => !scheduledRoutes.some(sr => scheduledRouteMatches(a, sr)));
    const routeAlerts = extraRoutes.map(route => {
      const owners = schedule
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

    const { currentRound, rounds, lastProgressAt, lastScanActivityAt, exactCandidate,
      workCompletedAt, completionMethod, completionDetectedAt, deliveryDone, returnDone,
      freshbagDone, totalRemaining, reopenedByScan } = advanceProgress(prev,d,ret,fb,batch,now);

    const rec = {
      batch_id: batch.id,
      schedule_date: batch.schedule_date,
      meta_work_date: batch.meta_work_date,
      camp_code: batch.camp_code,
      camp_name: batch.camp_name,
      wave: batch.wave,
      meta_worker_key: key,
      source_camp_code: sourceCampCode(src),
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

  const rows = [...byKey.values()];
  const freshRows = await storeFreshRows(env, batch, schedule, directory, fresh, now);
  const freshMap = new Map((freshRows || []).map(r => [r.meta_worker_key, r]));
  const freshComplete = fresh?.success === true;
  for (const row of rows) {
    const fr = freshMap.get(row.meta_worker_key);
    if (!freshComplete) continue; // Never replace good data with zeros after an API failure.
    for (const field of ['assigned','scanned','completed','impossible','pdd_miss','total','complete_rate']) {
      row['fresh_delivery_'+field] = fr?.['delivery_'+field] ?? 0;
    }
  }
  // Preserve workers omitted by an individual META response, as in MAROOWELL.
  if (rows.length) await sbUpsert(env, "meta_realtime_current", rows, "batch_id,meta_worker_key");

  if (rows.length) {
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
        fresh_delivery_assigned: r.fresh_delivery_assigned ?? 0,
        fresh_delivery_scanned: r.fresh_delivery_scanned ?? 0,
        fresh_delivery_completed: r.fresh_delivery_completed ?? 0,
        fresh_delivery_impossible: r.fresh_delivery_impossible ?? 0,
        fresh_delivery_pdd_miss: r.fresh_delivery_pdd_miss ?? 0,
        fresh_delivery_total: r.fresh_delivery_total ?? 0,
        fresh_delivery_complete_rate: r.fresh_delivery_complete_rate ?? 0,
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
  const expected = scheduledPeople(schedule);
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
    last_error: null,
    updated_at: now
  });

  if (shouldFinalize) {
    const freshFinal = await sbGet(env, `meta_realtime_fresh_current?select=*&batch_id=eq.${batch.id}`) || [];
    const finalized = await sbPost(env, "rpc/meta_finalize_realtime_batch", { p_batch_id: batch.id });
    for (const fr of freshFinal) {
      await sbPatch(env,
        `meta_realtime_final?batch_id=eq.${batch.id}&meta_worker_key=eq.${encodeURIComponent(fr.meta_worker_key)}`,
        {
          fresh_delivery_assigned: fr.delivery_assigned,
          fresh_delivery_scanned: fr.delivery_scanned,
          fresh_delivery_completed: fr.delivery_completed,
          fresh_delivery_impossible: fr.delivery_impossible,
          fresh_delivery_pdd_miss: fr.delivery_pdd_miss,
          fresh_delivery_total: fr.delivery_total,
          fresh_delivery_complete_rate: fr.delivery_complete_rate
        }
      );
    }
    return {
      camp: batch.camp_name,
      wave: batch.wave,
      workers: rows.length,
      finalized,
      codes,
      completion_method: batchMethod
    };
  }

  return {
    camp: batch.camp_name,
    wave: batch.wave,
    workers: stateRows.length,
    complete: campComplete,
    stable,
    codes
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
    response.success ? "active" : "expired",
    response.status,
    response.success ? null : `heartbeat ${response.status}: ${response.raw.slice(0, 200)}`
  );
  return { ok: response.success, status: response.status };
}

async function runCollector(env, force = false) {
  requireConfig(env);
  if (String(env.REALTIME_SCHEMA_READY || '') !== '2026-10-09-night3') {
    return {ok:false, error:'REALTIME_SCHEMA_UPGRADE_REQUIRED', results:[]};
  }
  const state = await sessionState(env);
  if (state?.collector_paused) return { ok: true, paused: true, at: nowIso(), results: [] };
  if (!state?.cookie_bundle) return { ok: false, error: "META DB session 없음", at: nowIso() };

  const cookies = parseCookieBundle(state.cookie_bundle);
  const purged = await purgeStaleRealtimeRows(env);
  const ensured = await ensureBatches(env);
  const due = await dueBatches(env, force);
  const results = [];
  let successes = 0, failure = null;

  for (const batch of due) {
    const lockToken = crypto.randomUUID();
    let claimed = false;
    try {
      claimed = await sbPost(env, "rpc/meta_claim_realtime_batch", {
        p_batch_id: batch.id,
        p_token: lockToken,
        p_lease_seconds: 120
      });
      if (!claimed) {
        results.push({ camp: batch.camp_name, wave: batch.wave, skipped: "collector_locked" });
        continue;
      }
      results.push(await processBatch(env, cookies, batch));
      successes += 1;
    } catch (e) {
      const msg = String(e?.message || e);
      failure = e;
      results.push({ camp: batch.camp_name, wave: batch.wave, error: msg });
      if (claimed) {
        await sbPatch(env, `meta_realtime_batch?id=eq.${batch.id}`, {
          status: "error",
          last_error: msg.slice(0, 500),
          next_poll_at: kstIsoAt(Date.now() + 300000),
          updated_at: nowIso()
        }).catch(() => {});
      }
      if (/META (401|403|302)/.test(msg)) {
        const status = Number(msg.match(/META (\d+)/)?.[1] || 401);
        await saveSession(env, cookies, "expired", status, msg.slice(0, 250)).catch(() => {});
        break;
      }
    } finally {
      if (claimed) {
        await sbPost(env, "rpc/meta_release_realtime_batch", {
          p_batch_id: batch.id,
          p_token: lockToken
        }).catch(() => {});
      }
    }
  }

  const kp = kstParts();
  if (!due.length && (force || kp.minute % 5 === 0)) {
    const health=await heartbeat(env,cookies); results.push({heartbeat:health});
    if(!health.ok)failure=new Error('META heartbeat failed');
  } else if (failure) {
    const msg = String(failure.message || failure);
    const expired = /META (401|403|302)/.test(msg);
    await saveSession(env, cookies, expired ? 'expired' : 'error', expired ? Number(msg.match(/META (\d+)/)?.[1]||401) : 500, msg.slice(0,250));
  } else if (successes > 0) {
    await saveSession(env, cookies, "active", 200, null);
  }

  return {
    ok: !failure,
    at: nowIso(),
    successful: successes,
    purged_stale_batches: purged,
    ensure: ensured,
    due: due.length,
    results
  };
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
<form method="post" action="https://meta-direct-poc.tonest-admin.workers.dev/login-submit-code" autocomplete="off">
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

  const flyBundle = jar.header(FLY_REALTIME);
  const cookies = parseCookieBundle(flyBundle);
  await saveSession(env, cookies, "active", 200, null);

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
    response.success ? "active" : "expired",
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

async function requireAccess(request,env,adminOnly=false) {
  const bearer=request.headers.get('authorization') || '';
  if(!/^Bearer \S+$/i.test(bearer))throw Object.assign(new Error('Authentication required'),{status:401});
  const key=text(env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_ANON_KEY||serviceKey(env));
  const result=await fetch(supabaseUrl(env)+'/auth/v1/user',{headers:{apikey:key,authorization:bearer},signal:AbortSignal.timeout(10000)});
  if(!result.ok)throw Object.assign(new Error('Authentication expired'),{status:401});
  const user=await result.json();
  if(!user?.id)throw Object.assign(new Error('Invalid authenticated user'),{status:401});
  const profiles=await sbGet(env,'profiles?select=role,status&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
  const profile=profiles?.[0];
  const roles=adminOnly?['super_admin','admin']:['super_admin','admin','team_leader'];
  if(profile?.status!=='active'||!roles.includes(profile.role))throw Object.assign(new Error('Active TO:NEST manager required'),{status:403});
  return user.id;
}
function corsResponse(response,request) {
  const origin=request.headers.get('origin');
  const headers=new Headers(response.headers);
  if(ALLOWED_FRAME_ANCESTORS.includes(origin))headers.set('access-control-allow-origin',origin);
  headers.set('vary','Origin');headers.set('access-control-allow-headers','Authorization, Content-Type');
  headers.set('access-control-allow-methods','GET, POST, OPTIONS');
  return new Response(response.body,{status:response.status,headers});
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === 'OPTIONS') return new Response(null,{status:204});
      if (['/login-send-code','/test-db','/collector/status','/collector/run'].includes(path)) {
        await requireAccess(request,env,path==='/collector/run');
        if(path!=='/collector/status' && request.method!=='POST')return json({ok:false,error:'POST required'},405);
      }
      if (path === "/health") {
        const state = await sessionState(env).catch(() => null);
        return json({
          ok: true,
          service: "tonest-meta-collector",
          version: "2026-10-09-night3",
          schemaReady: env.REALTIME_SCHEMA_READY === '2026-10-09-night3',
          supabaseConfigured: !!text(env.SUPABASE_URL) && !!serviceKey(env),
          maroowellApiConfigured: !!text(env.MAROOWELL_API_KEY) || !!env.CAMP_DIRECTORY,
          metaCredentialsConfigured: !!text(env.META_ID) && !!text(env.META_PW),
          metaSessionStatus: state?.status || "unknown",
          collectorPaused: state?.collector_paused === true,
          time: new Date().toISOString()
        });
      }

      if (path === "/collector/run") return json(await runCollector(env, true));

      if (path === "/collector/status") {
        const state = await sessionState(env);
        const batches = await sbGet(env,
          "meta_realtime_batch?select=*&order=schedule_date.desc,started_at.desc&limit=100"
        );
        return json({ ok:true, state: state ? {
          status: state.status,
          last_success_at: state.last_success_at,
          last_http_status: state.last_http_status,
          last_error: state.last_error,
          collector_paused: state.collector_paused,
          updated_at: state.updated_at
        } : null, batches });
      }

      if (path === "/login-send-code" && request.method === "POST") return await loginSendCode(env);
      if (path === "/login-submit-code" && request.method === "POST") {
        const response=await loginSubmitCode(request,env);
        if(response.ok&&ctx?.waitUntil)ctx.waitUntil(runCollector(env,true).catch(e=>console.error('Post-login collection failed',e.message)));
        return response;
      }
      if (path === "/test-db") return await testDb(env);

      return json({
        ok: true,
        message: "TO:NEST META realtime collector",
        endpoints: [
          "/health",
          "/collector/run",
          "/collector/status",
          "/login-send-code",
          "/login-submit-code",
          "/test-db"
        ]
      });
    } catch (e) {
      const message = String(e?.message || e);
      console.error("TONEST META WORKER ERROR", message, e?.stack || "");
      return json({ ok:false, error:message }, Number(e?.status||500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCollector(env).catch(async e => {
        const message = String(e?.message || e);
        console.error("TONEST META CRON ERROR", message);
        try {
          await sbPatch(env, "meta_backend_state?id=eq.1", {
            status: "error",
            last_error: `collector cron: ${message.slice(0,300)}`,
            updated_at: new Date().toISOString()
          });
        } catch {}
      })
    );
  }
};

export default {
  async fetch(request,env,ctx){return corsResponse(await worker.fetch(request,env,ctx),request);},
  scheduled:worker.scheduled
};
