const DEFAULT_ALLOWED_ORIGIN = "https://tonest-corp.com";

const TABLE_SCHEDULE = "tonest_schedule";
const TABLE_ROUTE_INFO = "tonest_route_info";
const TABLE_INFO = "tonest_info";
const TABLE_USER_ACCESS = "user_access";
const TABLE_VENDOR_MEMBERS = "vendor_members";
const TABLE_SCHEDULE_WRITE_ACCESS = "maroowell_schedule_write_access";
const DEFAULT_UPDATE_STATUS_TABLE = "tonest_schedule_update_status";
const TABLE_CAMPS = "camps";
const TABLE_META_BACKEND_STATE = "meta_backend_state";
const META_FLY_BASE = "https://fly.coupang.com";
const META_SCHEDULE_PAGE = "https://fly.coupang.com/ui/schedule";
const META_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    env = normalizeTenantEnv(env);
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {
      assertEnv(env);

      if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
        return json({
          ok: true,
          service: "tonest-schedule-api",
          time: new Date().toISOString()
        }, 200, cors);
      }

      const auth = await requireAuth(request, env);

      if (url.pathname === "/me" && request.method === "GET") {
        requireRead(auth);

        return json({
          ok: true,
          user: auth.user,
          access: auth.access
        }, 200, cors);
      }

      if (url.pathname === "/config" && request.method === "GET") {
        requireRead(auth);
        return json({ok:true,...await tenantScheduleConfig(env)},200,cors);
      }

      if (url.pathname === "/schedule/week" && request.method === "GET") {
        requireRead(auth);

        const camp = clean(url.searchParams.get("camp"));
        const wave = normalizeWave(url.searchParams.get("wave"));
        const weekStart = normalizeDate(url.searchParams.get("week_start"));

        if (!camp) throw httpError(400, "camp_required");
        if (!weekStart) throw httpError(400, "week_start_required");

        const weekEnd = addDays(weekStart, 6);

        const [routes, schedules, drivers, updateStatus] = await Promise.all([
          selectRoutes(env, camp, wave),
          selectSchedules(env, {
            camp,
            wave,
            weekStart,
            weekEnd
          }),
          selectDrivers(env),
          getUpdateStatus(env, {
            camp,
            wave
          })
        ]);

        return json({
          ok: true,
          routes,
          schedules,
          drivers,
          update_status: updateStatus
        }, 200, cors);
      }

      if (url.pathname === "/schedule/update-status" && request.method === "GET") {
        requireRead(auth);

        const camp = clean(url.searchParams.get("camp"));
        const wave = normalizeWave(url.searchParams.get("wave"));

        if (!camp) throw httpError(400, "camp_required");

        const updateStatus = await getUpdateStatus(env, {
          camp,
          wave
        });

        return json({
          ok: true,
          update_status: updateStatus
        }, 200, cors);
      }

      if (url.pathname === "/schedule/update-status" && request.method === "POST") {
        requireWrite(auth);

        const body = await readJson(request);
        const camp = clean(body.camp);
        const wave = normalizeWave(body.wave);
        const actualUpdateDate = nullableDate(body.actual_update_date);
        const fakeUpdateDate = nullableDate(body.fake_update_date);

        if (!camp) throw httpError(400, "camp_required");

        const updateStatus = await upsertUpdateStatus(env, {
          camp,
          wave,
          actual_update_date: actualUpdateDate,
          fake_update_date: fakeUpdateDate
        });

        return json({
          ok: true,
          update_status: updateStatus
        }, 200, cors);
      }

      if (url.pathname === "/schedule/save" && request.method === "POST") {
        requireWrite(auth);

        const body = await readJson(request);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const result = await saveScheduleRows(env, rows, auth);

        return json({
          ok: true,
          ...result
        }, 200, cors);
      }

      if (url.pathname === "/schedule/info-accounts" && request.method === "GET") {
        requireRead(auth);

        const rows = await selectInfoAccounts(env);

        return json({
          ok: true,
          rows
        }, 200, cors);
      }

      // Native Android/iOS transfer: never open or render a web schedule page.
      if (url.pathname === "/schedule/meta/native/preview" && request.method === "GET") {
        requireWrite(auth);
        const camp = clean(url.searchParams.get("camp"));
        const wave = normalizeWave(url.searchParams.get("wave"));
        const date = normalizeDate(url.searchParams.get("date"));
        if (!camp || !date) throw httpError(400, "camp_or_date_required");
        const preview = await prepareNativeMetaTransfer(env, { camp, wave, date });
        return json({ ok:true, ...preview }, 200, cors);
      }

      if (url.pathname === "/schedule/meta/native/submit" && request.method === "POST") {
        requireWrite(auth);
        const body = await readJson(request);
        const camp = clean(body.camp);
        const wave = normalizeWave(body.wave);
        const date = normalizeDate(body.date);
        const phase = clean(body.phase);
        if (!camp || !date || !["reset","apply"].includes(phase)) throw httpError(400, "invalid_native_meta_request");
        const preview = await prepareNativeMetaTransfer(env, { camp, wave, date });
        if (clean(body.fingerprint) !== preview.fingerprint) {
          throw httpError(409, "schedule_or_meta_registrations_changed_reload_preview");
        }
        const rows = phase === "reset" ? preview.reset_rows : preview.actual_rows;
        if (!rows.length) return json({ok:true,skipped:true,phase,workflow_id:null},200,cors);
        const bytes = buildNativeMetaXlsx(rows, {camp,wave,phase});
        const metaDate = preview.meta_date;
        const filename = `${camp}_${wave}_${metaDate}_${phase}.xlsx`;
        const blob = new File([bytes], filename, {
          type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        const result = await uploadMetaScheduleExcel(env, {camp,wave,metaDate,phase,file:blob});
        return json({ok:true,skipped:false, ...result},200,cors);
      }

      if (url.pathname === "/schedule/meta/native/verify" && request.method === "POST") {
        requireWrite(auth);
        const body = await readJson(request);
        const camp = clean(body.camp);
        const wave = normalizeWave(body.wave);
        const date = normalizeDate(body.date);
        const phase = clean(body.phase);
        if (!camp || !date || !["reset","apply"].includes(phase)) throw httpError(400, "invalid_native_meta_verify");
        const preview = await prepareNativeMetaTransfer(env, {camp,wave,date});
        const currentIds = new Set(preview.reset_rows.map(r=>nativeMetaKey(r.id)));
        // A reset is verified against a fresh MetaAdmin query. Never mark success just because the upload API accepted the workbook.
        if (phase === "reset") {
          return json({ok:currentIds.size===0,verified:currentIds.size===0,remaining:currentIds.size},200,cors);
        }
        // Off-duty people are uploaded to META but must not appear in active registrations.
        const expected = preview.actual_rows.filter(r=>r.status!=="휴무");
        const present = expected.filter(r=>currentIds.has(nativeMetaKey(r.id)));
        const complete = present.length===expected.length;
        if (complete) {
          const last = await getUpdateStatus(env,{camp,wave});
          if (!last?.actual_update_date || date > clean(last.actual_update_date)) {
            await upsertUpdateStatus(env,{
              camp,wave,actual_update_date:preview.meta_date,
              fake_update_date:last?.fake_update_date||null
            });
          }
        }
        return json({
          ok:complete,verified:complete,
          expected:expected.length,present:present.length,registered:currentIds.size,
          missing:expected.filter(r=>!currentIds.has(nativeMetaKey(r.id))).map(r=>r.name)
        },200,cors);
      }

      if (url.pathname === "/schedule/meta/current" && request.method === "GET") {
        requireWrite(auth);

        const camp = clean(url.searchParams.get("camp"));
        const wave = normalizeWave(url.searchParams.get("wave"));
        const date = normalizeDate(url.searchParams.get("date"));

        if (!camp) throw httpError(400, "camp_required");
        if (!date) throw httpError(400, "date_required");

        const current = await getMetaCurrentSchedule(env, { camp, wave, date });

        return json({
          ok: true,
          ...current
        }, 200, cors);
      }

      if (url.pathname === "/schedule/meta/upload-excel" && request.method === "POST") {
        requireWrite(auth);

        const upload = await readMetaUploadForm(request);
        const camp = clean(upload.camp);
        const wave = normalizeWave(upload.wave);
        const metaDate = normalizeDate(upload.meta_date);
        const phase = clean(upload.phase) || "apply";

        if (!camp) throw httpError(400, "camp_required");
        if (!metaDate) throw httpError(400, "meta_date_required");
        if (!upload.file) throw httpError(400, "file_required");

        const result = await uploadMetaScheduleExcel(env, {
          camp,
          wave,
          metaDate,
          phase,
          file: upload.file
        });

        return json({
          ok: true,
          ...result
        }, 200, cors);
      }

      if (url.pathname === "/schedule/meta/workflow" && request.method === "GET") {
        requireWrite(auth);

        const workflowId = clean(url.searchParams.get("workflow_id"));
        if (!workflowId) throw httpError(400, "workflow_id_required");

        const result = await getMetaWorkflowStatus(env, workflowId);

        return json({
          ok: true,
          ...result
        }, 200, cors);
      }

      if (url.pathname === "/schedule/meta/continue" && request.method === "POST") {
        requireWrite(auth);
        const body = await readJson(request);
        const workflowId = clean(body?.workflow_id || body?.workflowId);
        if (!workflowId) throw httpError(400, "workflow_id_required");

        const result = await continueMetaScheduleUpload(env, workflowId);
        return json({ ok:true, ...result }, 200, cors);
      }

      return json({
        ok: false,
        error: "not_found",
        path: url.pathname
      }, 404, cors);
    } catch (err) {
      console.error(err);

      return json({
        ok: false,
        error: err?.message || "server_error",
        detail: err?.detail || null
      }, err?.status || 500, cors);
    }
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set(["https://tonest-corp.com", "https://www.tonest-corp.com"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : DEFAULT_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400", "Vary": "Origin"
  };
}

function json(payload, status = 200, cors = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function assertEnv(env) {
  const missing = [];

  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!env.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");

  if (missing.length) {
    throw httpError(500, "missing_env", {
      missing
    });
  }
}

function httpError(status, message, detail) {
  const err = new Error(message);
  err.status = status;
  err.detail = detail || null;
  return err;
}

function clean(value) {
  return String(value ?? "").trim();
}

function compact(value) {
  return clean(value).replace(/\s+/g, "");
}

function normalizeWave(value) {
  const raw = compact(value).toUpperCase();

  if (raw === "야간" || raw === "심야" || raw === "새벽" || raw === "NIGHT" || raw === "N" || raw === "W1" || raw === "WAVE1" || raw === "1W") {
    return "WAVE1";
  }

  if (raw === "주간" || raw === "DAY" || raw === "D" || raw === "W2" || raw === "WAVE2" || raw === "2W") {
    return "WAVE2";
  }

  return raw || "WAVE2";
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return "";

  const matched = raw.match(/^(20\d{2})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);

  if (matched) {
    return toIso(new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  }

  const d = new Date(raw);

  if (Number.isNaN(d.getTime())) return "";

  return toIso(d);
}

function nullableDate(value) {
  const normalized = normalizeDate(value);
  return normalized || null;
}

function toIso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(iso, days) {
  const matched = clean(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = matched ? new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])) : new Date();

  d.setDate(d.getDate() + Number(days || 0));

  return toIso(d);
}

async function readJson(request) {
  const text = await request.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

async function requireAuth(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) throw httpError(401, "missing_token");

  const userRes = await fetch(`${trimSlash(env.SUPABASE_URL)}/auth/v1/user`, {
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${token}`
    }
  });

  const userJson = await userRes.json().catch(() => null);

  if (!userRes.ok || !userJson?.id) {
    throw httpError(401, "invalid_token", userJson);
  }

  const access = await getAccess(env, userJson);

  return {
    user: {
      id: userJson.id,
      email: userJson.email || "",
      role: userJson.role || ""
    },
    access
  };
}


function isPositiveScheduleMemo(value) {
  const memo = clean(value).toLowerCase();

  if (!memo || memo === "-" || memo === "null" || memo === "undefined") return false;
  if (memo.includes("off") || memo.includes("해제") || memo.includes("불가") || memo.includes("금지")) return false;

  return memo.includes("schedule") ||
    memo.includes("스케줄") ||
    memo.includes("write") ||
    memo.includes("허용") ||
    memo.includes("on");
}

function uniqRowsByUserIdOrEmail(rows) {
  const seen = new Set();
  const result = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = `${clean(row.user_id || row.id)}|${clean(row.email).toLowerCase()}`;

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(row);
  }

  return result;
}

async function selectRowsByUserOrEmail(env, table, userId, email) {
  const out = [];
  const lowEmail = clean(email).toLowerCase();

  const attempts = [];

  if (userId || lowEmail) {
    attempts.push({
      select: "*",
      or: [
        userId ? `user_id.eq.${escapeFilter(userId)}` : "",
        lowEmail ? `email.eq.${escapeFilter(lowEmail)}` : ""
      ].filter(Boolean).join(","),
      limit: "50"
    });
  }

  if (userId) {
    attempts.push({
      select: "*",
      user_id: `eq.${userId}`,
      limit: "50"
    });
  }

  if (lowEmail) {
    attempts.push({
      select: "*",
      email: `eq.${lowEmail}`,
      limit: "50"
    });
  }

  for (const params of attempts) {
    try {
      out.push(...await supabaseSelect(env, table, params));
    } catch (err) {
      console.warn(`[schedule] access lookup failed table=${table}`, err?.detail || err);
    }
  }

  if (lowEmail || userId) {
    try {
      const all = await supabaseSelect(env, table, {
        select: "*",
        limit: "10000"
      });

      out.push(...all.filter(row => {
        const rowUserId = clean(row.user_id || row.id);
        const rowEmail = clean(row.email).toLowerCase();

        return (userId && rowUserId === userId) || (lowEmail && rowEmail === lowEmail);
      }));
    } catch (err) {
      console.warn(`[schedule] access fallback scan failed table=${table}`, err?.detail || err);
    }
  }

  return uniqRowsByUserIdOrEmail(out);
}


async function getAccess(env, user) {
  const rows = await supabaseSelect(env, "profiles", {
    select: "user_id,display_name,email,role,status",
    user_id: `eq.${user.id}`, limit: "1"
  });
  const profile=rows[0];
  const active=profile?.status==="active";
  const role=active?clean(profile.role):"";
  const canManage=active&&["super_admin","admin","team_leader"].includes(role);
  // Preserve the original schedule API access shape without its email bypass
  // or MAROOWELL-specific membership tables. The role is server-owned.
  return {
    rows: profile?[profile]:[],roles:role?[role]:[],
    is_maroowell:false,is_tonest:active,
    is_super_admin:role==="super_admin",
    is_admin:["super_admin","admin"].includes(role),
    is_team_leader:canManage,
    has_schedule_access:canManage,schedule_write:canManage,
    max_role_level:role==="super_admin"?90:role==="admin"?60:role==="team_leader"?30:0,
    display_name:profile?.display_name||"",
    debug_counts:{profiles:rows.length}
  };
}

function requireRead(auth) {
  const a = auth?.access || {};

  if (
    a.is_super_admin ||
    a.is_admin ||
    a.has_schedule_access ||
    a.schedule_write ||
    Number(a.max_role_level || 0) >= 60
  ) {
    return;
  }

  throw httpError(403, "schedule_read_required", {
    access: {
      is_maroowell: !!a.is_maroowell,
      is_team_leader: !!a.is_team_leader,
      has_schedule_access: !!a.has_schedule_access,
      schedule_write: !!a.schedule_write,
      max_role_level: Number(a.max_role_level || 0),
      debug_counts: a.debug_counts || null
    }
  });
}

function requireWrite(auth) {
  const a = auth?.access || {};

  if (
    a.is_super_admin ||
    a.is_admin ||
    a.has_schedule_access ||
    a.schedule_write ||
    Number(a.max_role_level || 0) >= 60
  ) {
    return;
  }

  throw httpError(403, "schedule_write_required", {
    access: {
      is_maroowell: !!a.is_maroowell,
      is_team_leader: !!a.is_team_leader,
      has_schedule_access: !!a.has_schedule_access,
      schedule_write: !!a.schedule_write,
      max_role_level: Number(a.max_role_level || 0),
      debug_counts: a.debug_counts || null
    }
  });
}

function escapeFilter(value) {
  return String(value).replace(/["(),]/g, "");
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function supabaseBase(env, table) {
  return `${trimSlash(env.SUPABASE_URL)}/rest/v1/${encodeURIComponent(table)}`;
}

function supabaseHeaders(env, prefer) {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  if (prefer) headers["Prefer"] = prefer;

  return headers;
}

function sanitizeSupabaseUrl(url) {
  try {
    const copy = new URL(url.toString());
    return copy.pathname + "?" + copy.searchParams.toString();
  } catch {
    return "";
  }
}

async function supabaseSelect(env, table, params = {}) {
  const url = new URL(supabaseBase(env, table));

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_select_failed", {
      table,
      status: res.status,
      url: sanitizeSupabaseUrl(url),
      data
    });
  }

  return Array.isArray(data) ? data : [];
}

async function supabaseInsert(env, table, rows, prefer = "return=representation") {
  const res = await fetch(supabaseBase(env, table), {
    method: "POST",
    headers: supabaseHeaders(env, prefer),
    body: JSON.stringify(rows)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_insert_failed", {
      table,
      status: res.status,
      data
    });
  }

  return data;
}

async function supabasePatch(env, table, params, patch, prefer = "return=representation") {
  const url = new URL(supabaseBase(env, table));

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: supabaseHeaders(env, prefer),
    body: JSON.stringify(patch)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_patch_failed", {
      table,
      status: res.status,
      url: sanitizeSupabaseUrl(url),
      data
    });
  }

  return data;
}

async function supabaseDelete(env, table, params, prefer = "return=representation,count=exact") {
  const url = new URL(supabaseBase(env, table));

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: supabaseHeaders(env, prefer)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_delete_failed", {
      table,
      status: res.status,
      url: sanitizeSupabaseUrl(url),
      data
    });
  }

  const count = Number(res.headers.get("content-range")?.split("/")?.at(-1) || 0) || 0;

  return {
    data,
    count
  };
}

async function supabaseUpsert(env, table, rows, onConflict, prefer = "resolution=merge-duplicates,return=minimal") {
  const url = new URL(supabaseBase(env, table));

  if (onConflict) url.searchParams.set("on_conflict", onConflict);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: supabaseHeaders(env, prefer),
    body: JSON.stringify(rows)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_upsert_failed", {
      table,
      status: res.status,
      url: sanitizeSupabaseUrl(url),
      data
    });
  }

  return data;
}

function normalizeCampLookup(value) {
  return clean(value).replace(/[_\s]+/g, "").toUpperCase();
}

function uniqStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => clean(value))
    .filter(Boolean)));
}

async function selectMetaCampCodes(env, camp) {
  const all = await tenantCampDirectory(env, camp);
  const campKey = normalizeCampLookup(camp);
  const rows = all.filter(row => normalizeCampLookup(row.camp) === campKey);

  const usable = rows
    .map(row => ({
      code: clean(row.code).toUpperCase(),
      mbCamp: clean(row.mb_camp),
      updatedAt: clean(row.updated_at)
    }))
    .filter(row => row.code);

  if (!usable.length) {
    throw httpError(400, "meta_camp_code_not_found", { camp });
  }

  usable.sort((a, b) => {
    const aMain = metaKey(a.mbCamp) === metaKey("본캠프") ? 1 : 0;
    const bMain = metaKey(b.mbCamp) === metaKey("본캠프") ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;

    const aTime = Date.parse(a.updatedAt) || 0;
    const bTime = Date.parse(b.updatedAt) || 0;
    if (aTime !== bTime) return bTime - aTime;

    return a.code.localeCompare(b.code);
  });

  return uniqStrings(usable.map(row => row.code));
}

function parseCookieBundle(bundle) {
  const map = new Map();
  for (const part of clean(bundle).split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return map;
}

function cookieBundleString(map) {
  return Array.from(map.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function splitSetCookieHeader(raw) {
  if (!raw) return [];
  return String(raw).split(/,(?=[^;,]+=)/g);
}

function absorbMetaSetCookies(cookieMap, response) {
  const lines = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitSetCookieHeader(response.headers.get("set-cookie"));

  for (const line of lines) {
    const first = String(line || "").split(";", 1)[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i);
    const value = first.slice(i + 1);
    const expired = /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line) || value === "";
    if (expired) cookieMap.delete(name);
    else cookieMap.set(name, value);
  }
}

async function getMetaBackendState(env) {
  const rows = await supabaseSelect(env, TABLE_META_BACKEND_STATE, {
    select: "id,cookie_bundle,cookie_jar,session_generation,status,last_error,updated_at",
    id: "eq.1",
    limit: "1"
  });
  const row = rows?.[0] || null;
  if (!row?.cookie_bundle) {
    throw httpError(503, "meta_session_missing", {
      message: "메타어드민 로그인 세션이 없습니다. 메타어드민 연결을 먼저 갱신해주세요."
    });
  }
  return row;
}

async function saveMetaCookieBundle(env, original, cookieMap, response) {
  const next=cookieBundleString(cookieMap);
  if(!next||next===clean(original.cookie_bundle))return;
  const patch={cookie_bundle:next,updated_at:new Date().toISOString()};
  if(Array.isArray(original.cookie_jar))patch.cookie_jar=rotateTenantCookieJar(original.cookie_jar,response);
  const guard={id:"eq.1",cookie_bundle:`eq.${original.cookie_bundle}`};
  if(original.session_generation!=null)guard.session_generation=`eq.${original.session_generation}`;
  // Compare-and-swap prevents this upload request from undoing a collector
  // refresh or a new login. Never change META status, pause state, or cron.
  await supabasePatch(env,TABLE_META_BACKEND_STATE,guard,patch,"return=minimal").catch(err=>{
    console.warn("[schedule meta] guarded cookie save failed",err?.message||String(err));
  });
}

async function metaRequest(env, path, init = {}) {
  const state = await getMetaBackendState(env);
  const cookieMap = parseCookieBundle(state.cookie_bundle);
  const headers = new Headers(init.headers || {});

  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("accept-language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.set("origin", META_FLY_BASE);
  headers.set("referer", META_SCHEDULE_PAGE);
  headers.set("user-agent", META_UA);
  headers.set("x-coupang-accept-language", "ko-KR");
  headers.set("x-requested-with", "XMLHttpRequest");
  headers.set("cookie", cookieBundleString(cookieMap));

  const url = path.startsWith("http") ? path : `${META_FLY_BASE}${path}`;
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual"
  });

  absorbMetaSetCookies(cookieMap, response);
  await saveMetaCookieBundle(env, state, cookieMap, response);

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  const contentType = clean(response.headers.get("content-type")).toLowerCase();
  const looksLogin = typeof body === "string" && /<html|login|로그인/i.test(body.slice(0, 1000));

  if (response.status === 401 || response.status === 403 || looksLogin) {
    throw httpError(503, "meta_session_expired", {
      status: response.status,
      message: "메타어드민 로그인 세션이 만료되었습니다. 세션을 다시 연결해주세요."
    });
  }

  if (!response.ok) {
    throw httpError(response.status, "meta_request_failed", {
      status: response.status,
      path,
      content_type: contentType,
      data: body
    });
  }

  return {
    status: response.status,
    body,
    headers: response.headers
  };
}

function metaKey(value) {
  return clean(value).replace(/[\s_\-]/g, "").toLowerCase();
}

const META_PERSON_NAME_KEYS = new Set([
  "name", "drivername", "workername", "couriername", "flexername", "quickflexername",
  "vendorworkername", "membername", "displayname", "username", "employeeName"
].map(metaKey));

const META_PERSON_ID_KEYS = new Set([
  "coupangid", "coupangloginid", "loginid", "drivercoupangid", "workercoupangid",
  "vendorworkerid", "accountid", "userid", "usernameid"
].map(metaKey));

const META_STATUS_KEYS = new Set([
  "workstatus", "workstatuscode", "workstatusname", "schedulestatus", "schedulestatuscode", "schedulestatusname",
  "attendance", "attendancestatus", "attendancestatuscode", "attendancestatusname", "status", "statuscode", "statusname", "worktype"
].map(metaKey));

const META_ROUTE_KEYS = new Set([
  "route", "routes", "routecode", "routecodes", "routename", "routenames",
  "workroute", "workroutes", "assignedroutes", "triproutes"
].map(metaKey));

function firstMetaValue(obj, keySet) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
  for (const [key, value] of Object.entries(obj)) {    if (!keySet.has(metaKey(key))) continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const joined = value.map(v => typeof v === "object" ? "" : clean(v)).filter(Boolean).join(",");
      if (joined) return joined;
      continue;
    }
    if (typeof value === "object") continue;
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function parseMetaAccountToken(value) {
  const raw = clean(value);
  if (!raw) return { id: "", name: "" };
  const parts = raw.split("/").map(clean).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const second = parts.slice(1).join(" / ");
    const firstLooksId = /^[A-Za-z0-9._-]{3,}$/.test(first);
    return firstLooksId ? { id: first, name: second } : { id: second, name: first };
  }
  return { id: raw, name: "" };
}
function metaStatusLooksOff(status) {
  const v = compact(status).toUpperCase();
  if (!v) return false;
  return v.includes("휴무") || v === "OFF" || v.includes("DAYOFF") || v.includes("HOLIDAY") || v.includes("ABSENT");
}

function metaStatusLooksWorking(status) {
  const v = compact(status).toUpperCase();
  if (!v) return false;
  return v.includes("출근") || v.includes("WORK") || v.includes("ACTIVE") || v.includes("SCHEDULED") || v.includes("ATTEND");
}

function metaObjectHasRoute(obj) {
  const seen = new Set();
  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 4 || seen.has(node)) return false;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      const k = metaKey(key);
      if (META_ROUTE_KEYS.has(k) || k.includes("route")) {
        if (Array.isArray(value) && value.length) return true;
        if (typeof value === "string" && clean(value)) return true;
        if (typeof value === "number") return true;
        if (value && typeof value === "object" && Object.keys(value).length) return true;
      }
      if (value && typeof value === "object" && walk(value, depth + 1)) return true;
    }
    return false;
  }
  return walk(obj);
}

function metaPersonFromObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  let name = firstMetaValue(obj, META_PERSON_NAME_KEYS);
  let id = firstMetaValue(obj, META_PERSON_ID_KEYS);  const status = firstMetaValue(obj, META_STATUS_KEYS);

  if (id && id.includes("/")) {
    const parsed = parseMetaAccountToken(id);
    id = parsed.id;
    if (!name && parsed.name) name = parsed.name;
  }
  if (name && name.includes("/")) {
    const parsed = parseMetaAccountToken(name);
    if (!id && parsed.id) id = parsed.id;
    if (parsed.name) name = parsed.name;
  }

  name = clean(name);
  id = clean(id);
  if (!name || !id) return null;
  if (metaStatusLooksOff(status)) return null;

  const hasRoute = metaObjectHasRoute(obj);
  const working = metaStatusLooksWorking(status) || hasRoute;
  if (!working) return null;

  return { name, id, status: clean(status) || null };
}

function metaAnyPersonFromObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  let name = firstMetaValue(obj, META_PERSON_NAME_KEYS);
  let id = firstMetaValue(obj, META_PERSON_ID_KEYS);
  if (id && id.includes("/")) {
    const parsed = parseMetaAccountToken(id); id = parsed.id; if (!name && parsed.name) name = parsed.name;
  }
  if (name && name.includes("/")) {
    const parsed = parseMetaAccountToken(name); if (!id && parsed.id) id = parsed.id; if (parsed.name) name = parsed.name;
  }
  name=clean(name); id=clean(id);
  return name && id ? {name,id} : null;
}
function extractMetaAllPeople(payload) {
  const out=[]; const seen=new Set(); const visited=new Set();
  function walk(node){
    if(!node || typeof node!=="object" || visited.has(node)) return; visited.add(node);
    if(!Array.isArray(node)){ const p=metaAnyPersonFromObject(node); if(p){ const k=metaKey(p.id)||metaKey(p.name); if(k&&!seen.has(k)){seen.add(k);out.push(p);} } }
    if(Array.isArray(node)){ for(const x of node) walk(x); } else { for(const v of Object.values(node)) if(v&&typeof v==="object") walk(v); }
  }
  walk(payload?.data ?? payload); return out;
}

function extractMetaRegisteredPeople(payload) {
  const out = [];
  const seen = new Set();
  const visited = new Set();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (!Array.isArray(node)) {
      const person = metaPersonFromObject(node);
      if (person) {
        const key = metaKey(person.id) || metaKey(person.name);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(person);
        }
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") walk(value);
      }
    }
  }

  walk(payload?.data ?? payload);
  return out;
}
function metaPayloadHasEntries(payload) {
  const root = payload?.data ?? payload;
  if (root === null || root === undefined) return false;
  if (Array.isArray(root)) return root.length > 0;
  if (typeof root !== "object") return !!clean(root);

  const preferred = ["content", "items", "rows", "schedules", "scheduleList", "list", "data"];
  let preferredSeen = false;
  for (const key of preferred) {
    if (!(key in root)) continue;
    preferredSeen = true;
    const value = root[key];
    if (Array.isArray(value) && value.length > 0) return true;
    if (value && typeof value === "object" && metaPayloadHasEntries(value)) return true;
  }
  if (preferredSeen) return false;

  const ignored = new Set(["code", "message", "status", "success", "resultcode", "resultmessage"]);
  for (const [key, value] of Object.entries(root)) {
    if (ignored.has(metaKey(key))) continue;
    if (Array.isArray(value) && value.length > 0) return true;
    if (value && typeof value === "object" && metaPayloadHasEntries(value)) return true;
  }
  return false;
}

function metaWeekRange(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(date));
  if (!m) throw httpError(400, "invalid_meta_date", { date });

  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw httpError(400, "invalid_meta_date", { date });

  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const iso = value => value.toISOString().slice(0, 10);
  return { dateFrom: iso(start), dateTo: iso(end) };
}

function extractMetaScheduleForDate(payload, { campCode, waveCode, date }) {
  const root = payload?.data ?? payload ?? {};
  const groups = Array.isArray(root?.scheduleGroups) ? root.scheduleGroups : [];
  const targetCamp = clean(campCode).toUpperCase();
  const targetWave = normalizeWave(waveCode);

  const exactGroups = groups.filter(group => {
    const groupCamp = clean(group?.campCode).toUpperCase();
    const groupWave = normalizeWave(group?.waveCode);
    return (!targetCamp || groupCamp === targetCamp)
      && (!targetWave || groupWave === targetWave);
  });

  // /v2/schedules is already filtered by campCodes + waveCode.
  // Prefer exact group metadata, but never discard the response if Coupang omits
  // or changes group-level camp/wave fields for a particular day.
  const matchingGroups = exactGroups.length ? exactGroups : groups;

  const registered = [];
  const registeredSeen = new Set();
  const allPeople = [];
  const allSeen = new Set();
  let scheduleFound = false;

  for (const group of matchingGroups) {
    const userMap = new Map();

    for (const user of Array.isArray(group?.users) ? group.users : []) {
      const id = clean(user?.loginId);
      const name = clean(user?.name);
      if (!id) continue;

      userMap.set(metaKey(id), { id, name: name || id });

      const key = metaKey(id);
      if (key && !allSeen.has(key)) {
        allSeen.add(key);
        allPeople.push({ id, name: name || id });
      }
    }

    for (const schedule of Array.isArray(group?.schedules) ? group.schedules : []) {
      if (clean(schedule?.workDate) !== clean(date)) continue;
      scheduleFound = true;

      for (const assigned of Array.isArray(schedule?.assignedUsers) ? schedule.assignedUsers : []) {
        const attendance = clean(assigned?.attendance).toUpperCase();
        if (attendance !== "PRESENT") continue;

        const id = clean(assigned?.loginId);
        if (!id) continue;

        const base = userMap.get(metaKey(id));
        const name = clean(assigned?.name) || clean(base?.name) || id;
        const key = metaKey(id);
        if (!key || registeredSeen.has(key)) continue;

        registeredSeen.add(key);
        registered.push({
          id,
          name,
          status: attendance,
          trips: Array.isArray(assigned?.trips) ? assigned.trips : [],
          sub_routes: Array.isArray(assigned?.subRoutes) ? assigned.subRoutes : []
        });
      }
    }
  }

  return {
    schedule_found: scheduleFound,
    registered_people: registered,
    all_people: allPeople,
    matching_group_count: matchingGroups.length
  };
}

async function getMetaCurrentSchedule(env, { camp, wave, date }) {
  const codes = await selectMetaCampCodes(env, camp);
  const campCode = codes[0];
  const normalizedWave = normalizeWave(wave);
  const range = metaWeekRange(date);

  // MetaAdmin UI itself queries the whole Sunday-Saturday week, then renders
  // the selected workDate from scheduleGroups[].schedules[].
  const query = new URLSearchParams({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    waveCode: normalizedWave,
    campCodes: campCode
  });

  const result = await metaRequest(env, `/v2/schedules?${query.toString()}`, {
    method: "GET"
  });

  const parsed = extractMetaScheduleForDate(result.body, {
    campCode,
    waveCode: normalizedWave,
    date
  });

  return {
    camp,
    wave: normalizedWave,
    meta_date: date,
    meta_date_from: range.dateFrom,
    meta_date_to: range.dateTo,
    camp_code: campCode,
    camp_codes: codes,
    has_existing: parsed.schedule_found,
    registered_people: parsed.registered_people,
    registered_count: parsed.registered_people.length,
    all_people: parsed.all_people,
    all_people_count: parsed.all_people.length,
    matching_group_count: parsed.matching_group_count,
    meta_response: result.body
  };
}

async function readMetaUploadForm(request) {
  const contentType = clean(request.headers.get("content-type")).toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    throw httpError(400, "multipart_required");
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    throw httpError(400, "invalid_multipart", { message: err?.message || String(err) });
  }

  const file = form.get("file");
  const isFileLike = file && typeof file.arrayBuffer === "function";

  return {
    camp: clean(form.get("camp")),
    wave: clean(form.get("wave")),
    meta_date: clean(form.get("meta_date")),
    phase: clean(form.get("phase")),
    file: isFileLike ? file : null
  };
}

async function uploadMetaScheduleExcel(env, { camp, wave, metaDate, phase, file }) {
  // 캠프 코드를 선검증한다. 실제 업로드 파일 자체에는 캠프명이 들어가지만,
  // 잘못된 캠프 선택을 조기에 막기 위해 조회 API와 같은 매핑을 확인한다.
  const codes = await selectMetaCampCodes(env, camp);

  const form = new FormData();
  const fileName = clean(file?.name) || `${camp}_${wave}_${metaDate}_${phase || "schedule"}.xlsx`;
  form.append("file", file, fileName);

  const result = await metaRequest(env, "/v2/schedules/upload/excel", {
    method: "POST",
    body: form
  });

  const workflowId = clean(result.body?.data);
  if (!workflowId || clean(result.body?.message).toUpperCase() !== "SUCCESS") {
    throw httpError(502, "meta_upload_not_accepted", {
      camp,
      wave,
      meta_date: metaDate,
      phase,
      data: result.body
    });
  }

  return {
    camp,
    wave: normalizeWave(wave),
    meta_date: metaDate,
    phase,
    camp_code: codes[0],
    workflow_id: workflowId,
    accepted: true
  };
}

async function continueMetaScheduleUpload(env, workflowId) {
  const id = clean(workflowId);
  const result = await metaRequest(env, "/v1/schedules/upload-workflow/signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowId:id, status:"CONTINUE" })
  });

  return {
    workflow_id:id,
    continued:true,
    response:result.body
  };
}

async function getMetaWorkflowStatus(env, workflowId) {
  const safeId = encodeURIComponent(clean(workflowId));
  const result = await metaRequest(env, `/v1/workflows/${safeId}/excel-upload-status`, {
    method: "GET"
  });

  const root = result.body || {};
  const envelope = root?.data || {};
  const details = envelope?.data || {};
  const statusRaw = clean(envelope.status || details.status || root.status).toUpperCase();
  const failureMessage = clean(envelope.failureMessage || details.failureMessage || root.failureMessage || envelope.errorMessage || details.errorMessage || root.errorMessage || envelope.message || details.message);
  const violations = [details.violations, envelope.violations, root.violations].find(Array.isArray) || [];

  return {
    workflow_id: clean(envelope.workflowId || details.workflowId || root.workflowId) || clean(workflowId),
    status: statusRaw || "UNKNOWN",
    failure_message: failureMessage || null,
    data: {
      totalRows: Number(details.totalRows ?? envelope.totalRows ?? root.totalRows ?? 0),
      created: Number(details.created ?? envelope.created ?? root.created ?? 0),
      updated: Number(details.updated ?? envelope.updated ?? root.updated ?? 0),
      modified: Number(details.modified ?? envelope.modified ?? root.modified ?? 0),
      duplicated: Number(details.duplicated ?? envelope.duplicated ?? root.duplicated ?? 0),
      violations
    },
    diagnostic: {
      api_message: clean(root.message) || null,
      envelope_message: clean(envelope.message) || null,
      details_message: clean(details.message) || null
    }
  };
}

async function selectRoutes(env, camp, wave) {
  const records=await supabaseSelect(env,TABLE_ROUTE_INFO,{
    select:"id,camp,route_code,wave,route_tip,route_details,is_active",
    camp:`eq.${camp}`,limit:"10000"
  });
  // NULL denotes a legacy unassigned route, visible under both shifts until
  // the operator explicitly classifies it in Route Information.
  return adaptTenantRoutes(records.filter(row=>!row.wave||row.wave===wave));
}

async function selectSchedules(env, { camp, wave, weekStart, weekEnd }) {
  const url = new URL(supabaseBase(env, TABLE_SCHEDULE));

  url.searchParams.set("select", "*");
  url.searchParams.set("camp", `eq.${camp}`);
  url.searchParams.set("wave", `eq.${wave}`);
  url.searchParams.append("schedule_date", `gte.${weekStart}`);
  url.searchParams.append("schedule_date", `lte.${weekEnd}`);
  url.searchParams.set("order", "schedule_date.asc,row_order.asc,route_label.asc");
  url.searchParams.set("limit", "10000");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  const raw = await res.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw httpError(res.status, "supabase_select_failed", {
      table: TABLE_SCHEDULE,
      status: res.status,
      url: sanitizeSupabaseUrl(url),
      data
    });
  }

  return Array.isArray(data) ? data : [];
}

async function selectDrivers(env) {
  return supabaseSelect(env, TABLE_INFO, {
    select: "pk_id,person_name,coupang_id,camp_code,wave,position_title,is_resigned,sub_account_info,hire_date,resignation_scheduled_date",
    limit: "10000"
  });
}

async function selectInfoAccounts(env) {
  return supabaseSelect(env, TABLE_INFO, {
    select: "pk_id,person_name,coupang_id,camp_code,wave,position_title,is_resigned,sub_account_info,hire_date,resignation_scheduled_date",
    limit: "10000"
  });
}

function updateStatusTable(env) {
  return clean(env.TABLE_SCHEDULE_UPDATE_STATUS) || DEFAULT_UPDATE_STATUS_TABLE;
}

async function getUpdateStatus(env, { camp, wave }) {
  const table = updateStatusTable(env);

  const rows = await supabaseSelect(env, table, {
    select: "*",
    camp: `eq.${camp}`,
    wave: `eq.${wave}`,
    order: "updated_at.desc",
    limit: "1"
  }).catch((err) => {
    console.warn("[schedule] update status lookup failed", err?.detail || err);
    return [];
  });

  return rows?.[0] || null;
}

async function upsertUpdateStatus(env, payload) {
  const table = updateStatusTable(env);
  const now = new Date().toISOString();

  const row = {
    camp: payload.camp,
    wave: payload.wave,
    actual_update_date: payload.actual_update_date,
    fake_update_date: payload.fake_update_date,
    updated_at: now
  };

  const result = await supabaseUpsert(env, table, row, "camp,wave", "resolution=merge-duplicates,return=representation");

  return Array.isArray(result) ? result[0] || null : result;
}

function isBlankScheduleSaveRow(row) {
  return row?.is_active === false &&
    !clean(row?.driver_name) &&
    !clean(row?.driver_display_name);
}

function scheduleKeyParams(row) {
  return {
    schedule_date: `eq.${row.schedule_date}`,
    camp: `eq.${row.camp}`,
    wave: `eq.${row.wave}`,
    route_label: `eq.${row.route_label}`
  };
}

function sanitizeScheduleRow(row) {
  return {
    schedule_date: normalizeDate(row.schedule_date),
    iso_year: row.iso_year === null || row.iso_year === undefined || row.iso_year === "" ? null : Number(row.iso_year),
    iso_week: row.iso_week === null || row.iso_week === undefined || row.iso_week === "" ? null : Number(row.iso_week),
    week_label: clean(row.week_label) || null,
    camp: clean(row.camp),
    wave: normalizeWave(row.wave),
    route_label: clean(row.route_label),
    driver_name: clean(row.driver_name) || null,
    driver_display_name: clean(row.driver_display_name) || null,
    driver_owner_name: clean(row.driver_owner_name) || null,
    driver_export_name: clean(row.driver_export_name) || null,
    driver_coupang_id: clean(row.driver_coupang_id) || null,
    driver_account_type: clean(row.driver_account_type) || null,
    memo: clean(row.memo) || null,
    row_order: Number(row.row_order || 0),
    cell_color: clean(row.cell_color) || null,
    is_active: row.is_active !== false && !!(clean(row.driver_display_name) || clean(row.driver_name)),
    updated_at: new Date().toISOString()
  };
}

async function deleteScheduleSaveRow(env, row) {
  const deleted = await supabaseDelete(env, TABLE_SCHEDULE, scheduleKeyParams(row));
  return Number(deleted.count || 0);
}

async function saveScheduleRowsOneByOne(env, rows, firstError) {
  let saved = 0;
  let deleted = 0;
  let skipped = 0;

  if (firstError) {
    console.warn("[schedule] batch upsert failed, fallback row-by-row", firstError?.detail || firstError);
  }

  for (const row of rows) {
    if (isBlankScheduleSaveRow(row)) {
      deleted += await deleteScheduleSaveRow(env, row);
      saved++;
      continue;
    }

    const found = await supabaseSelect(env, TABLE_SCHEDULE, {
      select: "id",
      schedule_date: `eq.${row.schedule_date}`,
      camp: `eq.${row.camp}`,
      wave: `eq.${row.wave}`,
      route_label: `eq.${row.route_label}`,
      limit: "1"
    });

    const existingId = found?.[0]?.id;

    if (existingId) {
      await supabasePatch(env, TABLE_SCHEDULE, {
        id: `eq.${existingId}`
      }, row, "return=minimal");

      saved++;
      continue;
    }

    await supabaseInsert(env, TABLE_SCHEDULE, row, "return=minimal");
    saved++;
  }

  return {
    saved,
    deleted,
    skipped,
    mode: "row_by_row"
  };
}

async function saveScheduleRows(env, rows) {
  const payload = rows
    .map(row => sanitizeScheduleRow(row))
    .filter(row => row.schedule_date && row.camp && row.wave && row.route_label);

  if (!payload.length) {
    return {
      saved: 0,
      deleted: 0,
      skipped: 0,
      mode: "empty"
    };
  }

  const deletePayload = payload.filter(isBlankScheduleSaveRow);
  const upsertPayload = payload.filter(row => !isBlankScheduleSaveRow(row));

  let deleted = 0;

  for (const row of deletePayload) {
    deleted += await deleteScheduleSaveRow(env, row);
  }

  if (!upsertPayload.length) {
    return {
      saved: deletePayload.length,
      deleted,
      skipped: 0,
      mode: "delete_only"
    };
  }

  try {
    await supabaseUpsert(env, TABLE_SCHEDULE, upsertPayload, "schedule_date,camp,wave,route_label");

    return {
      saved: upsertPayload.length + deletePayload.length,
      deleted,
      skipped: 0,
      mode: "upsert_delete"
    };
  } catch (error) {
    const fallback = await saveScheduleRowsOneByOne(env, upsertPayload, error);

    return {
      saved: fallback.saved + deletePayload.length,
      deleted: deleted + (fallback.deleted || 0),
      skipped: fallback.skipped || 0,
      mode: "row_by_row_delete"
    };
  }
}


// Shared Android/iOS source-of-truth for the two-stage native MetaAdmin upload.
// Only server-saved MAROOWELL assignments are exported: never trust an arbitrary client row list.
function nativeMetaKey(value) {
  return clean(value).replace(/\s+/g,"").toLowerCase();
}
function nativeMetaNormalizeRoute(value) {
  return clean(value).replace(/[^0-9a-z가-힣]/gi,"").toUpperCase();
}
function nativeMetaAccountParts(raw,fallback="") {
  const text = clean(raw);
  const m = text.match(/^([^\s()]+)\s*[\[(（]([^)\]）]+)[)\]）]$/);
  return {id:clean(m?m[1]:text).split(/\s+/)[0],name:clean(m?m[2]:fallback)};
}
function nativeMetaAccountIndex(infoRows) {
  const map = new Map();
  const add = (alias,id,name,prefer=false) => {
    const key=nativeMetaKey(alias);
    if (!key || !id || (map.has(key)&&!prefer)) return;
    map.set(key,{id,name:name||alias});
  };
  for(const row of infoRows) {
    const person=clean(row.person_name||row.name);
    const mainId=nativeMetaAccountParts(row.coupang_id,person).id;
    const mainName=clean(row.coupang_admin_name)||person;
    for(const alias of [person,mainName,mainId]) add(alias,mainId,mainName);
    let subs = Array.isArray(row.sub_accounts) ? row.sub_accounts : [];
    if (!subs.length && row.sub_account_info) {
      try {
        const parsed=typeof row.sub_account_info==="string" ? JSON.parse(row.sub_account_info) : row.sub_account_info;
        if(Array.isArray(parsed))subs=parsed;
      }catch{}
    }
    subs.forEach((sub,i)=>{
      if(typeof sub==="string")sub={id:sub};
      if(!sub||typeof sub!=="object")return;
      const raw=clean(sub.id||sub.account_id||sub.coupang_id||sub.login_id);
      const parsed=nativeMetaAccountParts(raw,clean(sub.adminName||sub.name||sub.person_name));
      const id=parsed.id;
      const name=clean(sub.adminName||sub.name||sub.person_name||parsed.name)||person;
      // A numbered alias always wins over the main account; no fallback to main ID for suffix 2+.
      for(const alias of [person&&person+(i+2),name,id])add(alias,id,name,true);
    });
  }
  return map;
}
function nativeMetaScheduleRows(schedules,routes,infoRows,date,metaDate){
  const index=nativeMetaAccountIndex(infoRows);
  const routeMap=new Map();
  for(const r of routes){
    if(r.is_active===false)continue;
    const label=nativeMetaNormalizeRoute(r.route_label||[r.route,r.sub,r.sub_sub].join(""));
    const parent=nativeMetaNormalizeRoute(r.parent_route_label||[r.route,r.sub].join(""));
    if(label)routeMap.set(label,parent||label);
  }
  const relevant=(schedules||[]).filter(r=>
    r.is_active!==false && !!clean(r.driver_display_name||r.driver_name)
  );
  const assignedLabels=new Set(relevant.filter(r=>
    clean(r.schedule_date)===date && nativeMetaNormalizeRoute(r.route_label)!=="휴무자"
  ).map(r=>nativeMetaNormalizeRoute(r.route_label)));
  const roster=new Map(),byDate=new Map(),unresolved=[];
  function resolveIdentity(row,display,allowDirect){
    const direct=nativeMetaAccountParts(allowDirect?row.driver_coupang_id:"",clean(row.driver_export_name||display));
    const account=index.get(nativeMetaKey(display))||(allowDirect?index.get(nativeMetaKey(row.driver_export_name)):null);
    const numbered=/^(.+?)(\d+)$/.exec(display);
    if(numbered&&Number(numbered[2])>=2&&!account&&!direct.id){
      unresolved.push(display);return null;
    }
    const id=clean(account?.id||direct.id);
    const name=clean(account?.name||(allowDirect?row.driver_export_name:"")||direct.name||display);
    if(!id||!name){unresolved.push(display);return null;}
    return {id,name,key:nativeMetaKey(id)};
  }
  for(const row of relevant){
    const label=nativeMetaNormalizeRoute(row.route_label);
    const isOff=label==="휴무자";
    const display=clean(row.driver_display_name||row.driver_name);
    const people=isOff?display.split(/[,\n/、，]+/).map(clean).filter(Boolean):[display];
    for(const person of people){
      // A shared off-duty cell has no single driver ID; resolve each name independently.
      const identity=resolveIdentity(row,person,!isOff||people.length===1);
      if(!identity)continue;
      if(!roster.has(identity.key))roster.set(identity.key,identity);
      if(clean(row.schedule_date)!==date)continue;
      const adminRoute=isOff?"":(routeMap.get(label)||label);
      if(!isOff&&!adminRoute)continue;
      // Preserve the original parent-over-child assignment precedence.
      if(!isOff&&adminRoute!==label&&assignedLabels.has(adminRoute))continue;
      const existing=byDate.get(identity.key);
      const status=isOff?"휴무":"출근";
      if(existing&&existing.status!==status){
        throw httpError(422,"meta_attendance_off_conflict",{name:identity.name,date});
      }
      if(!existing){
        byDate.set(identity.key,{date:metaDate,name:identity.name,id:identity.id,status,routes:isOff?[]:[adminRoute]});
      }else if(!isOff&&!existing.routes.includes(adminRoute)){
        existing.routes.push(adminRoute);
      }
    }
  }
  if(unresolved.length)throw httpError(422,"meta_account_mapping_required",{names:[...new Set(unresolved)]});
  // Week roster appears once per selected business day, including implicit rest days.
  return [...roster].map(([key,person])=>{
    const found=byDate.get(key);
    return found?{...found,routes:found.status==="휴무"?[]:found.routes.sort()}
      :{date:metaDate,name:person.name,id:person.id,status:"휴무",routes:[]};
  }).sort((a,b)=>a.name.localeCompare(b.name,"ko")||a.id.localeCompare(b.id,"en"));
}
async function prepareNativeMetaTransfer(env,{camp,wave,date}){
  const metaDate=date; // Match supplied TO:NEST business date sample.
  const week=metaWeekRange(date);
  const [schedules,routes,accounts,current]=await Promise.all([
    selectSchedules(env,{camp,wave,weekStart:week.dateFrom,weekEnd:week.dateTo}),
    selectRoutes(env,camp,wave),
    selectInfoAccounts(env),
    getMetaCurrentSchedule(env,{camp,wave,date:metaDate})
  ]);
  const actualRows=nativeMetaScheduleRows(schedules,routes,accounts,date,metaDate);
  const resetRows=(current.registered_people||[]).filter(p=>clean(p?.id)).map(p=>({
    date:metaDate,name:clean(p.name)||clean(p.id),id:clean(p.id),routes:[]
  })).sort((a,b)=>a.id.localeCompare(b.id,"en"));
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(
    JSON.stringify({camp,wave,date,actual:actualRows})
  ));
  const fingerprint=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
  return {
    camp,wave,schedule_date:date,meta_date:metaDate,
    reset_count:resetRows.length,apply_count:actualRows.length,
    reset_people:resetRows.map(r=>r.name),apply_people:actualRows.map(r=>r.name),
    reset_rows:resetRows,actual_rows:actualRows,fingerprint
  };
}

// Builds a standards-compliant, uncompressed XLSX ZIP. The MetaAdmin importer
// expects Excel date serials (A), text business number (C), and text elsewhere.
function nativeMetaXml(value) {
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
function nativeMetaZip(files) {
  const enc=new TextEncoder(),local=[],central=[];
  let offset=0;
  const crc32=(bytes)=>{
    let c=0xffffffff;
    for(let i=0;i<bytes.length;i++){
      c^=bytes[i];
      for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);
    }
    return (c^0xffffffff)>>>0;
  };
  const pack=(n)=>new Uint8Array(n);
  const u16=(v,n,x)=>{v[n]=x&255;v[n+1]=(x>>>8)&255};
  const u32=(v,n,x)=>{u16(v,n,x);u16(v,n+2,x>>>16)};
  for(const [name,body] of Object.entries(files)){
    const filename=enc.encode(name),bytes=enc.encode(body),crc=crc32(bytes);
    const lh=pack(30+filename.length);
    u32(lh,0,0x04034b50);u16(lh,4,20);u16(lh,8,0);u32(lh,14,crc);
    u32(lh,18,bytes.length);u32(lh,22,bytes.length);u16(lh,26,filename.length);
    lh.set(filename,30);local.push(lh,bytes);
    const ch=pack(46+filename.length);
    u32(ch,0,0x02014b50);u16(ch,4,20);u16(ch,6,20);u32(ch,16,crc);
    u32(ch,20,bytes.length);u32(ch,24,bytes.length);u16(ch,28,filename.length);
    u32(ch,42,offset);ch.set(filename,46);central.push(ch);
    offset+=lh.length+bytes.length;
  }
  const centralSize=central.reduce((n,x)=>n+x.length,0),end=pack(22);
  u32(end,0,0x06054b50);u16(end,8,Object.keys(files).length);
  u16(end,10,Object.keys(files).length);u32(end,12,centralSize);u32(end,16,offset);
  const all=[...local,...central,end],result=pack(all.reduce((n,x)=>n+x.length,0));
  let pos=0;for(const part of all){result.set(part,pos);pos+=part.length;}
  return result;
}
function buildNativeMetaXlsx(rows,{camp,wave,phase}){
  const headers=["업무일","벤더명","사업자등록번호","캠프명","웨이브","이름","아이디","업무상태","회전","업무라우트"];
  const campName=clean(camp).replace(/^([MV])_?(.+)$/i,(_,a,b)=>a.toUpperCase()+"_"+b);
  const isOff=phase==="reset",status=isOff?"휴무":"출근";
  const rotation=wave==="WAVE1"?"D1,D2,F3":"1회전,2회전";
  const aoa=[headers,...rows.map(r=>[
    r.date,"주식회사 투네스트/TONET","1658803281",campName,wave,r.name,r.id,r.status==="휴무"?"휴무":status,
    (isOff||r.status==="휴무")?"":rotation,(isOff||r.status==="휴무")?"":r.routes.join(",")
  ])];
  const rowXml=aoa.map((row,ridx)=>`<row r="${ridx+1}">`+row.map((v,cidx)=>{
    if(v===""||v==null)return "";
    const col=String.fromCharCode(65+cidx),ref=col+(ridx+1);
    if(ridx>0&&cidx===0){
      const time=Date.parse(String(v)+"T00:00:00Z");
      const serial=Math.round((time-Date.UTC(1899,11,30))/86400000);
      return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
    }
    // Business registration number is text, matching the real template.
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${nativeMetaXml(v)}</t></is></c>`;
  }).join("")+"</row>").join("");
  const ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const files={
    "[Content_Types].xml":'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet0" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml":`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="mm-dd-yy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml":`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><dimension ref="A1:J${aoa.length}"/><sheetData>${rowXml}</sheetData><autoFilter ref="A1:J${aoa.length}"/></worksheet>`
  };
  return nativeMetaZip(files);
}

// TO:NEST deployment/data adapters. All schedule and META workflow operations
// above are ported from the pinned MAROOWELL source, not a new implementation.
function normalizeTenantEnv(env) {
  return {
    ...env,
    SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_SERVICE_ROLE||env.SUPABASE_SECRET_KEY,
    SUPABASE_ANON_KEY:env.SUPABASE_ANON_KEY||env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_SERVICE_ROLE||env.SUPABASE_SECRET_KEY
  };
}
async function tenantCampDirectory(env,camp="") {
  if(!env.CAMP_DIRECTORY||typeof env.CAMP_DIRECTORY.listCamps!=="function") {
    throw httpError(503,"camp_directory_binding_missing");
  }
  const rows=await env.CAMP_DIRECTORY.listCamps(camp);
  return Array.isArray(rows)?rows:[];
}
function adaptTenantRoutes(records) {
  const out=[];
  for(const r of records||[]) {
    if(r.is_active===false)continue;
    const label=clean(r.route_code).replace(/\s/g,"").toUpperCase();
    if(!label)continue;
    const m=label.match(/^(\d+)([A-Z]+)(\d*)$/);
    const parent=m?m[1]+m[2]:label;
    const common={camp:r.camp,route:m?.[1]||"",sub:m?.[2]||"",description:r.route_tip||"",memo:"",is_active:true,sort_order:out.length};
    out.push({...common,id:r.id,route_label:label,parent_route_label:parent,sub_sub:m?.[3]||""});
    for(const detail of Array.isArray(r.route_details)?r.route_details:[]) {
      const d=typeof detail==="string"?{route_label:detail}:detail||{};
      let child=clean(d.route_label||d.full_code||d.route_code||d.code).toUpperCase();
      if(!child&&d.sub_sub)child=parent+clean(d.sub_sub).padStart(2,"0");
      if(/^\d{1,2}$/.test(child))child=parent+child.padStart(2,"0");
      if(!child||child===parent||!child.startsWith(parent))continue;
      out.push({...common,...d,camp:r.camp,route_label:child,parent_route_label:parent,sub_sub:child.slice(parent.length),is_active:true});
    }
  }
  return out;
}
async function tenantScheduleConfig(env) {
  // Only the route-information catalogue determines which camps appear in
  // the schedule selector. Contractor/driver rows must not create camps.
  const routes=await supabaseSelect(env,TABLE_ROUTE_INFO,{
    select:"camp,wave,is_active",limit:"10000"
  });
  const camps=new Map();
  for(const row of routes){
    if(row.is_active===false)continue;
    const camp=clean(row.camp);
    if(!camp)continue;
    if(!camps.has(camp))camps.set(camp,new Set());
    const waves=camps.get(camp);
    if(row.wave==="WAVE1"||row.wave==="WAVE2")waves.add(row.wave);
    else{waves.add("WAVE1");waves.add("WAVE2");}
  }
  return {
    vendor_name:"주식회사 투네스트",
    business_number:"1658803281",
    camps:[...camps].map(([camp,waves])=>({camp,waves:["WAVE2","WAVE1"].filter(w=>waves.has(w))}))
      .sort((a,b)=>a.camp.localeCompare(b.camp,"ko",{numeric:true})),
    source_commit:"5d127cf124f0149113380393c74b1328c0065d29"
  };
}
function rotateTenantCookieJar(stored,response) {
  let jar=stored.map(c=>({...c}));
  const lines=typeof response?.headers?.getSetCookie==="function"?response.headers.getSetCookie():splitSetCookieHeader(response?.headers?.get("set-cookie"));
  for(const line of lines){
    const parts=String(line).split(";");const pos=parts[0].indexOf("=");if(pos<1)continue;
    const name=parts[0].slice(0,pos).trim(),value=parts[0].slice(pos+1);
    const attrs=new Map(parts.slice(1).map(p=>{const x=p.trim(),i=x.indexOf("=");return i<0?[x.toLowerCase(),""]:[x.slice(0,i).toLowerCase(),x.slice(i+1)];}));
    const domain=(attrs.get("domain")||"fly.coupang.com").replace(/^\./,"").toLowerCase();
    if(domain!=="coupang.com"&&domain!=="fly.coupang.com")continue;
    const path=attrs.get("path")||"/";
    jar=jar.filter(c=>!(c.name===name&&c.domain===domain&&c.path===path));
    const dead=attrs.has("max-age")?Number(attrs.get("max-age"))<=0:attrs.has("expires")&&Date.parse(attrs.get("expires"))<=Date.now();
    if(dead||value==="")continue;
    jar.push({name,value,domain,path,hostOnly:!attrs.has("domain"),secure:attrs.has("secure")});
  }
  return jar;
}
