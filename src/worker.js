// Cloudflare Worker: Claude 예약 작업용 API (수업 추천 + 월말평가서, 읽기 / 쓰기)
// build.mjs 가 __SUPABASE_URL__ / __SUPABASE_KEY__ 를 공개용 값으로 바꿔 build/worker.js 를 만듭니다.
// 비밀 키는 사용하지 않습니다. 실제 권한 검사와 데이터 접근은 DB 함수(api_read_progress / api_submit_recommendations)가
// 토큰 해시를 확인한 뒤에만 수행합니다.
const SUPABASE_URL = "__SUPABASE_URL__";
const SUPABASE_KEY = "__SUPABASE_KEY__";
const MAX_BODY = 100 * 1024;
const MAX_CORRECT_BODY = 24 * 1024 * 1024;   // 라이팅 첨삭: 사진·PDF 를 base64 로 받음
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5-5";

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

// ---- 라이팅 첨삭 -------------------------------------------------------------
// 앱에서 로그인한 선생님만 쓸 수 있습니다: 브라우저가 보낸 Supabase 로그인 토큰을 Supabase 에 물어 확인합니다.
async function loggedIn(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/);
  if (!m) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${m[1]}` } });
    return res.ok;
  } catch {
    return false;
  }
}

const CORRECT_TOOL = {
  name: "submit_correction",
  description: "Submit the transcription and correction of the student's English writing.",
  input_schema: {
    type: "object",
    properties: {
      transcript: { type: "string", description: "The student's original text exactly as written, mistakes included. Separate paragraphs with a blank line." },
      unreadable: { type: "array", items: { type: "string" }, description: "Short Korean notes about parts that were hard to read and were guessed. Empty if none." },
      sentences: {
        type: "array",
        description: "Every sentence of the transcript, in order.",
        items: {
          type: "object",
          properties: {
            original: { type: "string" },
            corrected: { type: "string", description: "Same as original if the sentence is already correct." },
            notes: {
              type: "array",
              description: "One entry per mistake or improvement. Empty if the sentence is correct.",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["grammar", "spelling", "vocabulary", "punctuation", "capitalization", "word_order", "expression"] },
                  wrong: { type: "string", description: "The wrong part, copied from original." },
                  right: { type: "string", description: "The fixed part, copied from corrected (so it can be highlighted there)." },
                  explanation: { type: "string", description: "Korean explanation a child can understand, 1-2 short sentences." },
                },
                required: ["type", "wrong", "right", "explanation"],
              },
            },
          },
          required: ["original", "corrected", "notes"],
        },
      },
      scores: {
        type: "object",
        description: "Integers 1-5 (5 is best), judged for the student's grade level.",
        properties: { content: { type: "integer" }, grammar: { type: "integer" }, vocabulary: { type: "integer" }, organization: { type: "integer" } },
        required: ["content", "grammar", "vocabulary", "organization"],
      },
      summary: { type: "string", description: "Korean overall comment (3-5 sentences) addressed to the student's parent in a warm, honest tone." },
      strengths: { type: "array", items: { type: "string" }, description: "1-3 specific strengths, in Korean." },
      improvements: { type: "array", items: { type: "string" }, description: "1-3 specific things to work on next, in Korean." },
    },
    required: ["transcript", "unreadable", "sentences", "scores", "summary", "strengths", "improvements"],
  },
};

const CORRECT_SYSTEM = `You are an experienced English writing teacher at a small Korean hagwon (study room). You correct the English writing of Korean students (elementary to high school) and explain in simple Korean.
Rules:
- Read handwriting carefully. If a word is hard to read, choose the most plausible reading and list it in "unreadable". Never silently invent text that is not on the page.
- "transcript" must keep the student's mistakes exactly (spelling, grammar, capitalization). Do not fix anything there.
- Correct minimally: keep the student's meaning and voice, fix only what is wrong or clearly unnatural. Do not rewrite a correct sentence just to make it fancier.
- Judge difficulty and scores for the student's grade level. Be encouraging but honest; do not inflate scores.
- Explanations are in Korean, short and concrete, for a student. Keep English terms (e.g. "a/an", "-ed") when helpful.
- Do not include any personal information (names, school, phone numbers) in your output; replace such text in the transcript with [이름] or similar.
- If the image has no English writing, return an empty sentences list and say so in "summary".`;

async function handleCorrect(request, env) {
  if (!(await loggedIn(request))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY 가 설정되지 않았어요" }, 503);
  const raw = await request.text();
  if (raw.length > MAX_CORRECT_BODY) return json({ ok: false, error: "파일이 너무 커요" }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const files = Array.isArray(body?.files) ? body.files : [];
  const text = typeof body?.text === "string" ? body.text.slice(0, 20000) : "";
  if (!files.length && !text.trim()) return json({ ok: false, error: "사진이나 글이 필요해요" }, 400);
  if (files.length > 8) return json({ ok: false, error: "파일은 8개까지 올릴 수 있어요" }, 400);

  const content = [];
  for (const f of files) {
    if (!f || typeof f.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) return json({ ok: false, error: "invalid file" }, 400);
    if (f.type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
      content.push({ type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
    } else {
      return json({ ok: false, error: "지원하지 않는 파일 형식이에요" }, 400);
    }
  }
  const one = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const lines = [
    one(body.grade, 20) ? `Student grade: ${one(body.grade, 20)} (Korean school grade).` : "",
    one(body.topic, 100) ? `Writing topic/title: ${one(body.topic, 100)}` : "",
    one(body.note, 300) ? `Teacher's request: ${one(body.note, 300)}` : "",
    files.length ? "The student's handwritten/printed writing is in the attached image(s)/document, in the order given. Transcribe it, then correct it." : "",
    text.trim()
      ? `${files.length ? "More of the same writing, already typed" : "The student's writing, already typed (use it as the transcript as is)"}:\n"""\n${text}\n"""`
      : "",
    "Call submit_correction.",
  ].filter(Boolean);
  content.push({ type: "text", text: lines.join("\n") });

  const model = (env.CORRECT_MODEL || DEFAULT_MODEL).slice(0, 100);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: CORRECT_SYSTEM,
        tools: [CORRECT_TOOL],
        tool_choice: { type: "tool", name: "submit_correction" },
        messages: [{ role: "user", content }],
      }),
    });
  } catch {
    return json({ ok: false, error: "AI 서버에 연결하지 못했어요" }, 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("anthropic error", res.status, JSON.stringify(data)?.slice(0, 500));
    const msg = res.status === 429 || res.status === 529 ? "AI 서버가 바빠요. 잠시 뒤 다시 해 주세요" : res.status === 401 || res.status === 403 ? "AI 키를 확인해 주세요" : "첨삭하지 못했어요";
    return json({ ok: false, error: msg }, 502);
  }
  const tool = (data?.content || []).find((c) => c.type === "tool_use" && c.name === "submit_correction");
  if (!tool || data.stop_reason === "max_tokens") return json({ ok: false, error: "글이 너무 길어서 끝까지 첨삭하지 못했어요. 나눠서 올려 주세요" }, 502);
  return json({ ok: true, data: { model, result: tool.input } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 라이팅 첨삭 (Claude 세션용, 토큰): 학생 찾기 → 원문 저장 → 첨삭 결과 저장
    if (path === "/api/writing/student") {
      if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      return rpc("api_find_student", { p_token: token, p_name: url.searchParams.get("name") || "" });
    }
    if (path === "/api/writing" || path === "/api/writing/correction") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      const token = bearer(request);
      if (!token) return json({ ok: false, error: "unauthorized" }, 401);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: "body too large" }, 413);
      let b;
      try {
        b = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      if (!b || typeof b !== "object") return json({ ok: false, error: "object body required" }, 400);
      const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
      if (path === "/api/writing") {
        return rpc("api_save_writing", {
          p_token: token, p_student_id: str(b.student_id, 40), p_ocr_text: str(b.ocr_text, 20001),
          p_title: str(b.title, 100), p_written_on: /^\d{4}-\d{2}-\d{2}$/.test(b.written_on || "") ? b.written_on : null,
        });
      }
      return rpc("api_save_correction", {
        p_token: token, p_writing_id: str(b.id, 40), p_result: b.result ?? null,
        p_model: str(b.model, 100) || "Claude(세션)", p_ocr_text: str(b.ocr_text, 20001),
      });
    }

    // 라이팅 첨삭: 로그인한 선생님의 브라우저에서만 호출 (Anthropic 키는 Worker 비밀값)
    if (path === "/api/correct") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      return handleCorrect(request, env);
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
