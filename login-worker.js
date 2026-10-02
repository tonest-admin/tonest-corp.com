const ALLOWED_ORIGINS = new Set([
  "https://tonest-corp.com",
  "https://www.tonest-corp.com"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";

  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGINS.has(origin)
        ? origin
        : "https://tonest-corp.com",
    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS,HEAD",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization",
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

function publicSupabaseKey(env) {
  return String(
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    ""
  ).trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function mapSignupError(payload, status) {
  const code = String(
    payload?.code ||
    payload?.error_code ||
    ""
  ).toLowerCase();

  const message = String(
    payload?.msg ||
    payload?.message ||
    payload?.error_description ||
    ""
  );

  if (
    code.includes("user_already_exists") ||
    /already registered|already exists/i.test(message)
  ) {
    return "이미 가입된 이메일입니다.";
  }

  if (
    /password/i.test(message) &&
    /weak|short|least/i.test(message)
  ) {
    return "비밀번호 조건을 확인해주세요.";
  }

  if (status === 429) {
    return "가입 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  }

  return message || "회원가입 처리 중 오류가 발생했습니다.";
}

async function handleAuthConfig(request, env) {
  const supabaseUrl = String(env.SUPABASE_URL || "").trim();
  const supabaseKey = publicSupabaseKey(env);

  if (!supabaseUrl || !supabaseKey) {
    return json(
      request,
      {
        ok: false,
        message: "Supabase 공개 설정이 누락되었습니다."
      },
      500
    );
  }

  return json(request, {
    ok: true,
    supabaseUrl,
    supabaseKey
  });
}

async function handleSignup(request, env) {
  if (!isAllowedOrigin(request)) {
    return json(
      request,
      {
        ok: false,
        message: "허용되지 않은 요청입니다."
      },
      403
    );
  }

  const supabaseUrl = String(env.SUPABASE_URL || "").trim();
  const supabaseKey = publicSupabaseKey(env);

  if (!supabaseUrl || !supabaseKey) {
    return json(
      request,
      {
        ok: false,
        message: "Supabase 설정이 누락되었습니다."
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      request,
      {
        ok: false,
        message: "잘못된 요청 형식입니다."
      },
      400
    );
  }

  const displayName = cleanText(body?.display_name, 50);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");

  if (!displayName) {
    return json(
      request,
      {
        ok: false,
        message: "이름을 입력해주세요."
      },
      400
    );
  }

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json(
      request,
      {
        ok: false,
        message: "올바른 이메일 주소를 입력해주세요."
      },
      400
    );
  }

  if (password.length < 8) {
    return json(
      request,
      {
        ok: false,
        message: "비밀번호는 8자 이상 입력해주세요."
      },
      400
    );
  }

  const redirectTo =
    "https://tonest-corp.com/signup?verified=1";

  const signupUrl =
    supabaseUrl.replace(/\/+$/, "") +
    "/auth/v1/signup?redirect_to=" +
    encodeURIComponent(redirectTo);

  const signupResponse = await fetch(signupUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": "Bearer " + supabaseKey
    },
    body: JSON.stringify({
      email,
      password,
      data: {
        display_name: displayName,
        full_name: displayName,
        name: displayName
      }
    })
  });

  const payload =
    await signupResponse
      .json()
      .catch(() => ({}));

  if (!signupResponse.ok) {
    return json(
      request,
      {
        ok: false,
        message: mapSignupError(
          payload,
          signupResponse.status
        )
      },
      signupResponse.status
    );
  }

  const requiresEmailConfirmation =
    !payload?.access_token &&
    !payload?.refresh_token;

  return json(request, {
    ok: true,
    requiresEmailConfirmation,
    message: requiresEmailConfirmation
      ? "가입 요청이 완료되었습니다. 이메일 인증 후 관리자 승인을 기다려주세요."
      : "가입 요청이 완료되었습니다. 관리자 승인을 기다려주세요."
  });
}

async function asHtml(response) {
  const body = await response.text();
  const headers = new Headers(response.headers);

  headers.set(
    "Content-Type",
    "text/html; charset=utf-8"
  );
  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );
  headers.set("Pragma", "no-cache");
  headers.delete("Content-Length");

  return new Response(body, {
    status: response.status,
    headers
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path =
        url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "OPTIONS") {
        if (!isAllowedOrigin(request)) {
          return new Response(null, {
            status: 403
          });
        }

        return new Response(null, {
          status: 204,
          headers: corsHeaders(request)
        });
      }

      if (
        path === "/health" &&
        request.method === "GET"
      ) {
        return json(request, {
          ok: true,
          service: "tonest-login",
          frontend: "cloudflare-assets",
          assetsBinding:
            !!env.ASSETS &&
            typeof env.ASSETS.fetch === "function",
          time: new Date().toISOString()
        });
      }

      if (
        path === "/auth-config" &&
        request.method === "GET"
      ) {
        return handleAuthConfig(
          request,
          env
        );
      }

      if (
        path === "/signup" &&
        request.method === "POST"
      ) {
        return handleSignup(
          request,
          env
        );
      }

      if (
        !env.ASSETS ||
        typeof env.ASSETS.fetch !== "function"
      ) {
        return new Response(
          "ASSETS binding missing",
          {
            status: 500,
            headers: {
              "Content-Type":
                "text/plain; charset=utf-8",
              "Cache-Control": "no-store"
            }
          }
        );
      }

      /*
       * public/ 전체를 Cloudflare Assets로 서비스.
       *
       * public/index.html  -> /
       * public/signup      -> /signup
       * public/home        -> /home
       * public/tonest_info -> /tonest_info
       *
       * 앞으로 확장자 없는 파일을 public/에 추가하면
       * Worker 수정 없이 그대로 /파일명 URL로 사용.
       */

      if (path === "/") {
        url.pathname = "/index.html";
      }

      const assetRequest = new Request(
        url.toString(),
        request
      );

      const response =
        await env.ASSETS.fetch(assetRequest);

      if (!response.ok) {
        return response;
      }

      const fileName =
        path === "/"
          ? "index.html"
          : path
              .split("/")
              .filter(Boolean)
              .pop() || "";

      const isHtml =
        path === "/" ||
        !fileName.includes(".") ||
        fileName
          .toLowerCase()
          .endsWith(".html");

      if (isHtml) {
        return asHtml(response);
      }

      return response;

    } catch (error) {
      console.error(
        "TONEST LOGIN WORKER ERROR",
        error
      );

      return json(
        request,
        {
          ok: false,
          message:
            "서버 처리 중 오류가 발생했습니다."
        },
        500
      );
    }
  }
};
