// 서비스 워커: 앱 화면(정적 파일)만 저장해 두고, 항상 네트워크를 먼저 시도합니다.
// - 새 배포가 바로 반영되도록 "네트워크 우선", 연결이 없을 때만 저장본을 사용합니다.
// - 학생 데이터(Supabase)와 /api/ 는 가로채지 않으므로 어디에도 저장되지 않습니다.
const CACHE = "rachel-shell-v33";
const SHELL = ["./", "index.html", "app.js", "style.css", "config.js", "fonts/pretendard.css", "manifest.webmanifest", "icons/icon-192.png", "icons/logo-dark.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
