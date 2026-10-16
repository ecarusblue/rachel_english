// Cloudflare Worker: Claude 예약 작업용 API (수업 추천 + 월말평가서, 읽기 / 쓰기)
// build.mjs 가 __SUPABASE_URL__ / __SUPABASE_KEY__ 를 공개용 값으로 바꿔 build/worker.js 를 만듭니다.
// 비밀 키는 사용하지 않습니다. 실제 권한 검사와 데이터 접근은 DB 함수(api_read_progress / api_submit_recommendations)가
// 토큰 해시를 확인한 뒤에만 수행합니다.
const SUPABASE_URL = "__SUPABASE_URL__";
const SUPABASE_KEY = "__SUPABASE_KEY__";
const MAX_BODY = 100 * 1024;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: HEADERS });
}

function bearer(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S{16,200})$/i);
  return m ? m[1] : null;
}

async function rpc(name, body) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return json({ ok: false, error: "database unreachable" }, 502);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return json({ ok: true, data });
  const msg = (data && (data.message || data.error)) || "";
  if (/unauthorized/i.test(msg) || res.status === 401) return json({ ok: false, error: "unauthorized" }, 401);
  if (res.status >= 500) return json({ ok: false, error: "database error" }, 502);
  return json({ ok: false, error: String(msg).slice(0, 200) || "bad request" }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 연결 확인용 (데이터 없음, 인증 없음)
    if (path === "/api/ping") {
      if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
      return json({ ok: true, service: "rachel-english", time: new Date().toISOString() });
    }

    if (path === "/api/progress") {
      if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      return rpc("api_read_progress", { p_token: token });
    }

    if (path === "/api/recommendations") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: "body too large" }, 413);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      if (!body || !Array.isArray(body.items)) return json({ ok: false, error: "items array required" }, 400);
      const model = typeof body.model === "string" ? body.model.slice(0, 100) : undefined;
      return rpc("api_submit_recommendations", model ? { p_token: token, p_items: body.items, p_model: model } : { p_token: token, p_items: body.items });
    }

    // 월말평가서: 그 달의 수업·시험 자료 읽기 (연·월을 생략하면 한국 시간의 이번 달)
    if (path === "/api/evaluation-source") {
      if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      const num = (k) => {
        const v = url.searchParams.get(k);
        if (v === null || v === "") return null;
        return /^\d{1,4}$/.test(v) ? Number(v) : NaN;
      };
      const y = num("year"), m = num("month");
      if (Number.isNaN(y) || Number.isNaN(m)) return json({ ok: false, error: "invalid year/month" }, 400);
      return rpc("api_read_evaluation_source", { p_token: token, p_year: y, p_month: m });
    }

    // 월말평가서: AI 초안 쓰기 (작성중·AI 초안으로만 저장)
    if (path === "/api/evaluations") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: "body too large" }, 413);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      if (!body || !Array.isArray(body.items)) return json({ ok: false, error: "items array required" }, 400);
      const model = typeof body.model === "string" ? body.model.slice(0, 100) : undefined;
      return rpc("api_submit_evaluations", model ? { p_token: token, p_items: body.items, p_model: model } : { p_token: token, p_items: body.items });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
