// Cloudflare Pages 빌드 스크립트 (Node 내장 모듈만 사용)
// 환경변수 SUPABASE_URL, SUPABASE_KEY 로 dist/config.js 를 생성해 키를 저장소에 올리지 않게 합니다.
//
// 사용: SUPABASE_URL="https://xxxx.supabase.co" SUPABASE_KEY="공개용키" node build.mjs
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

function die(msg) {
  console.error("빌드 실패: " + msg);
  process.exit(1);
}

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_KEY || "").trim();

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
  die("SUPABASE_URL 형식이 올바르지 않습니다. 예: https://abcdefgh.supabase.co");
}
if (!key) die("SUPABASE_KEY 가 비어 있습니다.");
if (key.startsWith("sb_secret_")) {
  die("secret 키는 사용할 수 없습니다. 공개용(publishable / anon) 키를 넣으세요.");
}

// 예전 방식(JWT) 키라면 role 을 확인해서 service_role 키를 막습니다.
const parts = key.split(".");
if (parts.length === 3) {
  let role = null;
  try {
    role = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role;
  } catch {
    role = null;
  }
  if (role === "service_role") {
    die("service_role 키는 브라우저에 노출되므로 사용할 수 없습니다. anon(공개용) 키를 넣으세요.");
  }
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["index.html", "app.js", "style.css", "_headers"]) copyFileSync(f, `dist/${f}`);
writeFileSync(
  "dist/config.js",
  `window.APP_CONFIG = ${JSON.stringify({ SUPABASE_URL: url, SUPABASE_KEY: key }, null, 2)};\n`
);
console.log("dist/ 생성 완료 (index.html, app.js, style.css, config.js, _headers)");
